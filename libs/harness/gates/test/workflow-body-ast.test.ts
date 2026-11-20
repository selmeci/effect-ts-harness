import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AstSourceContent, AstSourceFilePath } from "@harness/contract"
import { ts } from "@harness/graph"
import {
  collectWorkflowBodyViolations,
  decideSyntaxBansGate,
  extractGateRuleIdsFromSources,
} from "../src/index.js"

const SRC_PATH = "libs/sample/core/src/sample-workflow.ts"

const parseTs = (content: string, filePath = SRC_PATH): ts.SourceFile =>
  ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

interface SyntaxBansPlugin {
  readonly rules: {
    readonly "syntax-bans": {
      readonly create: (
        context: unknown,
      ) => Record<string, ((node: Record<string, unknown>) => void) | undefined>
    }
  }
}

const loadSyntaxBansPlugin = async (): Promise<SyntaxBansPlugin> => {
  const pluginPath = resolve(import.meta.dirname, "../../../../tools/oxlint/syntax-bans.js")
  const mod: { readonly default: SyntaxBansPlugin } = await import(pathToFileURL(pluginPath).href)
  return mod.default
}

describe("nondeterministic-workflow-body AST & oxlint gates", () => {
  it("flags Date.now, new Date, Math.random, crypto.randomUUID, process.env, fs, child_process, git, Omnigraph, and network calls outside Activity.make", () => {
    const content = [
      'import { Effect, Schema } from "effect"',
      'import { Activity, Workflow } from "effect/workflow"',
      'import { readFileSync } from "node:fs"',
      'import { execFileSync, spawnSync } from "node:child_process"',
      'import { randomUUID } from "node:crypto"',
      'import * as http from "node:http"',
      'import { OmnigraphClient } from "@harness/graph"',
      "",
      'const BadWf = Workflow.make("BadWf", {',
      "  payload: { id: Schema.String },",
      "  idempotencyKey: ({ id }) => id,",
      "})",
      "",
      "const badLocalHelper = () => {",
      "  const tsNow = Date.now()",
      "  const d = new Date()",
      "  const r = Math.random()",
      "  return `${tsNow}-${d.getTime()}-${r}`",
      "}",
      "",
      "export const BadWfLayer = BadWf.toLayer(() =>",
      "  Effect.gen(function* () {",
      "    const h = badLocalHelper()",
      "    const u = randomUUID()",
      "    const envVal = process.env.NODE_ENV",
      '    const txt = readFileSync("/tmp/x", "utf8")',
      '    const g = execFileSync("git", ["status"])',
      '    const sp = spawnSync("ls", [])',
      '    const og = new OmnigraphClient("http://localhost:1234")',
      '    const res = yield* Effect.sync(() => fetch("https://example.com"))',
      '    const req = http.get("http://example.com")',
      "    return { h, u, envVal, txt, g, sp, og, res, req }",
      "  }),",
      ")",
    ].join("\n")

    const violations = collectWorkflowBodyViolations(parseTs(content), SRC_PATH)
    const messages = violations.map((v) => v.message).join("\n")
    expect(violations.length).toBeGreaterThanOrEqual(10)
    expect(messages).toContain("Date.now")
    expect(messages).toContain("new Date()")
    expect(messages).toContain("Math.random")
    expect(messages).toContain("randomUUID")
    expect(messages).toContain("process.env")
    expect(messages).toContain("readFileSync")
    expect(messages).toContain("execFileSync")
    expect(messages).toContain("spawnSync")
    expect(messages).toContain("OmnigraphClient")
    expect(messages).toContain("fetch()")
    expect(messages).toContain("http.get")
  })

  it("permits wall-clock, randomness, env, fs, git, Omnigraph, and network calls inside Activity.make execute and compensation callbacks", () => {
    const content = [
      'import { Effect, Schema } from "effect"',
      'import { Activity, Workflow } from "effect/workflow"',
      'import { readFileSync } from "node:fs"',
      'import { execFileSync } from "node:child_process"',
      'import { randomUUID } from "node:crypto"',
      'import { OmnigraphClient } from "@harness/graph"',
      "",
      'const GoodWf = Workflow.make("GoodWf", {',
      "  payload: { id: Schema.String },",
      "  idempotencyKey: ({ id }) => id,",
      "})",
      "",
      "const activityOnlyHelper = () => ({",
      "  now: Date.now(),",
      "  date: new Date(),",
      "  rand: Math.random(),",
      "  uuid: randomUUID(),",
      "  env: process.env.PATH,",
      "})",
      "",
      "export const GoodWfLayer = GoodWf.toLayer(() =>",
      "  Effect.gen(function* () {",
      "    const step = yield* GoodWf.withCompensation(",
      "      Activity.make({",
      '        name: "ImpureInsideActivity",',
      "        execute: Effect.sync(() => {",
      "          const info = activityOnlyHelper()",
      '          const raw = readFileSync("/tmp/a", "utf8")',
      '          const gitOut = execFileSync("git", ["status"])',
      '          const og = new OmnigraphClient("http://localhost:1234")',
      '          const net = fetch("https://example.com")',
      "          return { info, raw, gitOut, og, net }",
      "        }),",
      "      }),",
      "      () =>",
      "        Effect.sync(() => {",
      '          execFileSync("git", ["worktree", "remove", "/tmp/wt"])',
      "        }),",
      "    )",
      "    return step",
      "  }),",
      ")",
    ].join("\n")

    const violations = collectWorkflowBodyViolations(parseTs(content), SRC_PATH)
    expect(violations).toEqual([])
  })

  it.effect(
    "produces zero violations on real libs/harness/gates/src/harness-task-workflow.ts via AST & syntax-bans gates",
    () =>
      Effect.gen(function* () {
        const realPath = resolve(import.meta.dirname, "../src/harness-task-workflow.ts")
        const realContent = readFileSync(realPath, "utf8")
        const normPath = "libs/harness/gates/src/harness-task-workflow.ts"

        const astViolations = collectWorkflowBodyViolations(
          parseTs(realContent, normPath),
          normPath,
        )
        expect(astViolations).toEqual([])

        const report = yield* decideSyntaxBansGate({
          files: [
            {
              filePath: AstSourceFilePath.make(normPath),
              content: AstSourceContent.make(realContent),
            },
          ],
        })
        expect(report.verdict).toBe("clean")
        expect(report.violations).toEqual([])
      }),
  )

  it("mirrors [nondeterministic-workflow-body] in tools/oxlint/syntax-bans.js and exposes rule ID to GraphGc", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]
    const reports: Array<{ readonly message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/sample/core/src/wf.ts",
      sourceCode: { text: "" },
      report: (r: { readonly message: string }) => {
        reports.push(r)
      },
    })

    visitor.Program?.({
      type: "Program",
      body: [
        {
          type: "ImportDeclaration",
          importKind: "value",
          source: { type: "Literal", value: "effect/workflow" },
          specifiers: [
            {
              type: "ImportSpecifier",
              importKind: "value",
              imported: { type: "Identifier", name: "Workflow" },
              local: { type: "Identifier", name: "Workflow" },
            },
          ],
        },
        {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "Wf" },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Workflow" },
                  property: { type: "Identifier", name: "make" },
                },
                arguments: [
                  { type: "Literal", value: "Wf" },
                  { type: "ObjectExpression", properties: [] },
                ],
              },
            },
          ],
        },
        {
          type: "ExpressionStatement",
          expression: {
            type: "CallExpression",
            callee: {
              type: "MemberExpression",
              computed: false,
              object: { type: "Identifier", name: "Wf" },
              property: { type: "Identifier", name: "toLayer" },
            },
            arguments: [
              {
                type: "ArrowFunctionExpression",
                params: [],
                body: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: { type: "Identifier", name: "Date" },
                    property: { type: "Identifier", name: "now" },
                  },
                  arguments: [],
                },
              },
            ],
          },
        },
      ],
    })

    expect(reports.some((r) => r.message.includes("[nondeterministic-workflow-body]"))).toBe(true)

    const syntaxBansSource = readFileSync(
      resolve(import.meta.dirname, "../../../../tools/oxlint/syntax-bans.js"),
      "utf8",
    )
    const extracted = extractGateRuleIdsFromSources("", "", "", syntaxBansSource, "")
    expect(extracted).toContain("nondeterministic-workflow-body")
  })

  it("catches point-free toLayer(runWorkflow), Effect.sync(helper), globalThis.crypto.*, bare Date(), Reflect.get/construct in TS AST", () => {
    const content = [
      'import { Effect, Schema } from "effect"',
      'import { Workflow } from "effect/workflow"',
      "",
      'const Wf = Workflow.make("HardenedWf", {',
      "  payload: { id: Schema.String },",
      "  idempotencyKey: ({ id }) => id,",
      "})",
      "",
      "const helper = () => {",
      "  const a = Date()",
      "  const b = Reflect.construct(Date, [])",
      '  const c = Reflect.get(process, "env")',
      "  const d = globalThis.crypto.randomUUID()",
      "  const e = globalThis.crypto.getRandomValues(new Uint8Array(4))",
      "  return { a, b, c, d, e }",
      "}",
      "",
      "const runWorkflow = () => Effect.sync(helper)",
      "",
      "export const Layer = Wf.toLayer(runWorkflow)",
    ].join("\n")

    const violations = collectWorkflowBodyViolations(parseTs(content), SRC_PATH)
    const messages = violations.map((v) => v.message).join("\n")
    expect(violations.length).toBeGreaterThanOrEqual(5)
    expect(messages).toContain("Date()")
    expect(messages).toContain("Date (Reflect.construct)")
    expect(messages).toContain('Reflect.get(process, "env")')
    expect(messages).toContain("crypto.randomUUID")
    expect(messages).toContain("crypto.getRandomValues")
  })

  it("avoids false positives on http.status, net.total, unimported fs, non-workflow Other.toLayer, and Activity.make-only helpers without .toLayer", () => {
    const content = [
      'import { Effect, Schema } from "effect"',
      'import { Activity, Workflow } from "effect/workflow"',
      "",
      'const CleanWf = Workflow.make("CleanWf", {',
      "  payload: { id: Schema.String },",
      "  idempotencyKey: ({ id }) => id,",
      "})",
      "",
      "const activityOnlyClock = () => new Date()",
      "const Other = { toLayer: (fn: () => number) => fn }",
      "export const OtherLayer = Other.toLayer(() => Date.now())",
      "",
      "export const readMetrics = (http: { readonly status: number }, net: { readonly total: number }, fs: { readonly tag: string }) =>",
      "  `${http.status}-${net.total}-${fs.tag}`",
      "",
      "export const MyActivity = Activity.make({",
      '  name: "ClockAct",',
      "  execute: Effect.sync(activityOnlyClock),",
      "})",
      "",
      "export { CleanWf }",
    ].join("\n")

    const violations = collectWorkflowBodyViolations(parseTs(content), SRC_PATH)
    expect(violations).toEqual([])
  })

  it("mirrors point-free, Reflect, globalThis.crypto, bare Date(), and negative false-positive guards in tools/oxlint/syntax-bans.js", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]

    const runEstree = (body: ReadonlyArray<Record<string, unknown>>) => {
      const reports: Array<{ readonly message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/core/src/wf.ts",
        sourceCode: { text: "// synthetic-estree-fixture" },
        report: (r: { readonly message: string }) => {
          reports.push(r)
        },
      })
      visitor.Program?.({ type: "Program", body })
      return reports
    }

    const wfImport = {
      type: "ImportDeclaration",
      importKind: "value",
      source: { type: "Literal", value: "effect/workflow" },
      specifiers: [
        {
          type: "ImportSpecifier",
          importKind: "value",
          imported: { type: "Identifier", name: "Workflow" },
          local: { type: "Identifier", name: "Workflow" },
        },
        {
          type: "ImportSpecifier",
          importKind: "value",
          imported: { type: "Identifier", name: "Activity" },
          local: { type: "Identifier", name: "Activity" },
        },
      ],
    }
    const wfDecl = {
      type: "VariableDeclaration",
      declarations: [
        {
          type: "VariableDeclarator",
          id: { type: "Identifier", name: "Wf" },
          init: {
            type: "CallExpression",
            callee: {
              type: "MemberExpression",
              computed: false,
              object: { type: "Identifier", name: "Workflow" },
              property: { type: "Identifier", name: "make" },
            },
            arguments: [
              { type: "Literal", value: "Wf" },
              { type: "ObjectExpression", properties: [] },
            ],
          },
        },
      ],
    }

    const posReports = runEstree([
      wfImport,
      wfDecl,
      {
        type: "FunctionDeclaration",
        id: { type: "Identifier", name: "helper" },
        body: {
          type: "BlockStatement",
          body: [
            {
              type: "ExpressionStatement",
              expression: {
                type: "CallExpression",
                callee: { type: "Identifier", name: "Date" },
                arguments: [],
              },
            },
            {
              type: "ExpressionStatement",
              expression: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Reflect" },
                  property: { type: "Identifier", name: "get" },
                },
                arguments: [
                  { type: "Identifier", name: "process" },
                  { type: "Literal", value: "env" },
                ],
              },
            },
            {
              type: "ExpressionStatement",
              expression: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Reflect" },
                  property: { type: "Identifier", name: "construct" },
                },
                arguments: [
                  { type: "Identifier", name: "Date" },
                  { type: "ArrayExpression", elements: [] },
                ],
              },
            },
            {
              type: "ExpressionStatement",
              expression: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "MemberExpression",
                    computed: false,
                    object: { type: "Identifier", name: "globalThis" },
                    property: { type: "Identifier", name: "crypto" },
                  },
                  property: { type: "Identifier", name: "randomUUID" },
                },
                arguments: [],
              },
            },
          ],
        },
      },
      {
        type: "FunctionDeclaration",
        id: { type: "Identifier", name: "runWorkflow" },
        body: {
          type: "BlockStatement",
          body: [
            {
              type: "ExpressionStatement",
              expression: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Effect" },
                  property: { type: "Identifier", name: "sync" },
                },
                arguments: [{ type: "Identifier", name: "helper" }],
              },
            },
          ],
        },
      },
      {
        type: "ExpressionStatement",
        expression: {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "Wf" },
            property: { type: "Identifier", name: "toLayer" },
          },
          arguments: [{ type: "Identifier", name: "runWorkflow" }],
        },
      },
    ])
    const posMsg = posReports.map((r) => r.message).join("\n")
    expect(posMsg).toContain("Date()")
    expect(posMsg).toContain('Reflect.get(process, "env")')
    expect(posMsg).toContain("Date (Reflect.construct)")
    expect(posMsg).toContain("crypto.randomUUID")

    const negReports = runEstree([
      wfImport,
      wfDecl,
      {
        type: "FunctionDeclaration",
        id: { type: "Identifier", name: "actClock" },
        body: {
          type: "BlockStatement",
          body: [
            {
              type: "ReturnStatement",
              argument: {
                type: "NewExpression",
                callee: { type: "Identifier", name: "Date" },
                arguments: [],
              },
            },
          ],
        },
      },
      {
        type: "ExpressionStatement",
        expression: {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "Activity" },
            property: { type: "Identifier", name: "make" },
          },
          arguments: [
            {
              type: "ObjectExpression",
              properties: [
                {
                  type: "Property",
                  computed: false,
                  key: { type: "Identifier", name: "name" },
                  value: { type: "Literal", value: "Clock" },
                },
                {
                  type: "Property",
                  computed: false,
                  key: { type: "Identifier", name: "execute" },
                  value: {
                    type: "CallExpression",
                    callee: {
                      type: "MemberExpression",
                      computed: false,
                      object: { type: "Identifier", name: "Effect" },
                      property: { type: "Identifier", name: "sync" },
                    },
                    arguments: [{ type: "Identifier", name: "actClock" }],
                  },
                },
              ],
            },
          ],
        },
      },
      {
        type: "ExpressionStatement",
        expression: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "http" },
          property: { type: "Identifier", name: "status" },
        },
      },
      {
        type: "ExpressionStatement",
        expression: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "net" },
          property: { type: "Identifier", name: "total" },
        },
      },
      {
        type: "ExpressionStatement",
        expression: {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "Other" },
            property: { type: "Identifier", name: "toLayer" },
          },
          arguments: [
            {
              type: "ArrowFunctionExpression",
              params: [],
              body: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Date" },
                  property: { type: "Identifier", name: "now" },
                },
                arguments: [],
              },
            },
          ],
        },
      },
    ])
    expect(negReports).toEqual([])
  })
})
