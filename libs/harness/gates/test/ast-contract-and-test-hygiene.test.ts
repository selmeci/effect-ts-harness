import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AstSourceContent, AstSourceFilePath } from "@harness/contract"
import {
  decideAstGateCache,
  decideSyntaxBansGate,
  decideTestIntegrityGate,
  MAX_TEST_CASE_LINES,
} from "../src/index.js"

interface OxlintPluginMod {
  readonly default: {
    readonly rules: {
      readonly "syntax-bans": {
        readonly create: (ctx: unknown) => { readonly Program?: (n: unknown) => void }
      }
      readonly "test-integrity": {
        readonly create: (ctx: unknown) => { readonly Program?: (n: unknown) => void }
      }
    }
  }
}

const loadOxlintPlugin = (): Effect.Effect<OxlintPluginMod["default"]> =>
  Effect.promise(
    () =>
      import(
        pathToFileURL(resolve(import.meta.dirname, "../../../../tools/oxlint/syntax-bans.js")).href
      ) as Promise<OxlintPluginMod>,
  ).pipe(Effect.map((m) => m.default))

const buildSizedTestFile = (callee: string, totalLines: number, useFnExpr = false): string => {
  const paddingCount = Math.max(0, totalLines - 2)
  const padLines = Array.from({ length: paddingCount }, (_, idx) => `  const line_${idx} = ${idx}`)
  const fnOpen = useFnExpr ? "function () {" : "() => {"
  const callOpen = callee.endsWith("prop")
    ? `${callee}("case", { n: Schema.Int }, ${fnOpen}`
    : `${callee}("case", ${fnOpen}`
  return [callOpen, ...padLines, `})`].join("\n")
}

const CaseKindArb = Schema.Literals([
  "clean-contract",
  "unbounded-brand",
  "unknown-record",
  "wf-name-access",
  "oversized-test",
])

describe("SPEC-0028 AST Contract Shape, Workflow Name, and Test Hygiene Gates", () => {
  it.effect(
    "REQ-1.1 flags unbounded branded strings and Schema.Record(String, Unknown) outside wire adapters",
    () =>
      Effect.gen(function* () {
        const badContract = [
          'import { Schema, pipe } from "effect"',
          'export const A = Schema.String.pipe(Schema.brand("A"))',
          'export const B = Schema.NonEmptyString.pipe(Schema.brand("B")).annotate({ title: "B" })',
          'export const C = pipe(Schema.String, Schema.brand("C"))',
          "export const Bag = Schema.Record(Schema.String, Schema.Unknown)",
          "export const ObjBag = Schema.Record({ key: Schema.String, value: Schema.Unknown })",
        ].join("\n")
        const report = yield* decideSyntaxBansGate({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/demo/contract/src/bad.ts"),
              content: AstSourceContent.make(badContract),
            },
          ],
        })
        const rules = report.violations.map((v) => v.rule)
        expect(rules).toHaveLength(5)
        expect(rules.every((r) => r === "contract-shape-hardening")).toBe(true)
      }),
  )

  it.effect(
    "REQ-1.1 allows bounded branded strings, non-string brands, non-contract files, and wire-adapter bags",
    () =>
      Effect.gen(function* () {
        const goodContract = [
          'import { Schema, pipe } from "effect"',
          'export const Base = Schema.String.pipe(Schema.check(Schema.isTrimmed()), Schema.brand("Base"))',
          'export const Pat = Schema.NonEmptyString.pipe(Schema.isPattern(/^[a-z]+$/), Schema.brand("Pat"))',
          'export const Max = Schema.String.pipe(Schema.check(Schema.isMaxLength(32)), Schema.brand("Max"))',
          'export const Piped = pipe(Schema.String, Schema.isMaxLength(16), Schema.brand("Piped"))',
          'export const Built = Schema.Trimmed.pipe(Schema.brand("Built"))',
          'export const Num = Schema.Int.pipe(Schema.brand("Num"))',
          'export const Derived = Base.pipe(Schema.brand("Derived"))',
          "export const TypedBag = Schema.Record(Base, Schema.Unknown)",
        ].join("\n")
        const wireAdapter = [
          'import { Schema } from "effect"',
          "export const WireEnvelope = Schema.Record(Schema.String, Schema.Unknown)",
        ].join("\n")
        const nonContract = [
          'import { Schema } from "effect"',
          'export const LocalId = Schema.String.pipe(Schema.brand("LocalId"))',
          "export const LocalBag = Schema.Record(Schema.String, Schema.Unknown)",
        ].join("\n")
        const report = yield* decideSyntaxBansGate({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/demo/contract/src/good.ts"),
              content: AstSourceContent.make(goodContract),
            },
            {
              filePath: AstSourceFilePath.make("libs/demo/contract/src/wire-adapter.ts"),
              content: AstSourceContent.make(wireAdapter),
            },
            {
              filePath: AstSourceFilePath.make("libs/demo/domain/src/helper.ts"),
              content: AstSourceContent.make(nonContract),
            },
          ],
        })
        expect(report.violations).toEqual([])
      }),
  )

  it.effect(
    "REQ-1.2 detects .name and ['name'] reads on Workflow.make definitions and imported *Workflow symbols",
    () =>
      Effect.gen(function* () {
        const badCode = [
          'import { Workflow } from "effect/workflow"',
          'import * as WfMod from "effect/workflow"',
          'import { HarnessTaskWorkflow } from "@harness/gates"',
          'import { AlphaWorkflow as RenamedWf } from "./alpha.js"',
          'import * as GatesNs from "@harness/gates"',
          'const LocalWf = Workflow.make("LocalWf", {})',
          "const AliasWf = LocalWf",
          "export const a = LocalWf.name",
          'export const b = AliasWf["name"]',
          'export const c = Workflow.make("InlineWf", {}).name',
          'export const d = WfMod.Workflow.make("NsWf", {}).name',
          "export const e = HarnessTaskWorkflow.name",
          "export const f = RenamedWf.name",
          "export const g = GatesNs.HarnessTaskWorkflow.name",
        ].join("\n")
        const cleanCode = [
          'import { Workflow } from "effect/workflow"',
          'import type { HarnessTaskWorkflow } from "@harness/gates"',
          'const LocalWf = Workflow.make("LocalWf", {})',
          "export const okTag = LocalWf._tag",
          "export const okMeta = { name: 'literal' }.name",
          "export type WfType = typeof Workflow.name",
        ].join("\n")

        const badReport = yield* decideAstGateCache({
          files: [
            {
              filePath: AstSourceFilePath.make("apps/demo/src/bad.ts"),
              content: AstSourceContent.make(badCode),
            },
            {
              filePath: AstSourceFilePath.make("apps/demo/test/bad.test.ts"),
              content: AstSourceContent.make(badCode),
            },
          ],
        })
        const hits = badReport.violations.filter((v) => v.rule === "workflow-name-instead-of-tag")
        expect(hits).toHaveLength(14)

        const cleanReport = yield* decideAstGateCache({
          files: [
            {
              filePath: AstSourceFilePath.make("apps/demo/src/clean.ts"),
              content: AstSourceContent.make(cleanCode),
            },
          ],
        })
        expect(
          cleanReport.violations.filter((v) => v.rule === "workflow-name-instead-of-tag"),
        ).toEqual([])
      }),
  )

  it.effect(
    "REQ-3.1 enforces MAX_TEST_CASE_LINES boundary (200 passes, 201 fails) across Vitest forms",
    () =>
      Effect.gen(function* () {
        expect(MAX_TEST_CASE_LINES).toBe(200)
        const boundaryFiles = [
          {
            filePath: AstSourceFilePath.make("libs/demo/domain/test/exact-200.test.ts"),
            content: AstSourceContent.make(buildSizedTestFile("it.effect", 200)),
          },
          {
            filePath: AstSourceFilePath.make("libs/demo/domain/test/non-vitest.test.ts"),
            content: AstSourceContent.make(buildSizedTestFile("helperWrap", 215)),
          },
          {
            filePath: AstSourceFilePath.make("libs/demo/domain/src/helper.ts"),
            content: AstSourceContent.make(buildSizedTestFile("it", 215)),
          },
        ]
        const cleanReport = yield* decideTestIntegrityGate({ files: boundaryFiles })
        expect(cleanReport.violations.filter((v) => v.rule === "max-test-case-lines")).toEqual([])

        const oversizedForms = [
          buildSizedTestFile("it", 201),
          buildSizedTestFile("it.effect", 201, true),
          buildSizedTestFile("it.live", 202),
          buildSizedTestFile("it.effect.prop", 201),
          buildSizedTestFile("test", 201),
          buildSizedTestFile("it.each([1])", 201),
        ]
        const badReport = yield* decideTestIntegrityGate({
          files: oversizedForms.map((content, idx) => ({
            filePath: AstSourceFilePath.make(`libs/demo/domain/test/big-${idx}.test.ts`),
            content: AstSourceContent.make(content),
          })),
        })
        const hits = badReport.violations.filter((v) => v.rule === "max-test-case-lines")
        expect(hits).toHaveLength(oversizedForms.length)
      }),
  )

  it.effect(
    "mirrors [contract-shape-hardening], [workflow-name-instead-of-tag], and [max-test-case-lines] in tools/oxlint/syntax-bans.js",
    () =>
      Effect.gen(function* () {
        const plugin = yield* loadOxlintPlugin()
        const syntaxMsgs: Array<string> = []
        const syntaxVisitor = plugin.rules["syntax-bans"].create({
          filename: "/repo/libs/demo/contract/src/mod.ts",
          sourceCode: { text: "" },
          report: (r: { readonly message: string }) => syntaxMsgs.push(r.message),
        })
        syntaxVisitor.Program?.({
          type: "Program",
          body: [
            {
              type: "VariableDeclaration",
              declarations: [
                {
                  type: "VariableDeclarator",
                  id: { type: "Identifier", name: "Id" },
                  init: {
                    type: "CallExpression",
                    callee: {
                      type: "MemberExpression",
                      computed: false,
                      object: {
                        type: "MemberExpression",
                        computed: false,
                        object: { type: "Identifier", name: "Schema" },
                        property: { type: "Identifier", name: "String" },
                      },
                      property: { type: "Identifier", name: "pipe" },
                    },
                    arguments: [
                      {
                        type: "CallExpression",
                        callee: {
                          type: "MemberExpression",
                          computed: false,
                          object: { type: "Identifier", name: "Schema" },
                          property: { type: "Identifier", name: "brand" },
                        },
                        arguments: [{ type: "Literal", value: "Id" }],
                      },
                    ],
                  },
                },
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
                type: "MemberExpression",
                computed: false,
                object: { type: "Identifier", name: "Wf" },
                property: { type: "Identifier", name: "name" },
              },
            },
          ],
        })
        expect(syntaxMsgs.some((m) => m.includes("[contract-shape-hardening]"))).toBe(true)
        expect(syntaxMsgs.some((m) => m.includes("[workflow-name-instead-of-tag]"))).toBe(true)

        const testMsgs: Array<string> = []
        const testVisitor = plugin.rules["test-integrity"].create({
          filename: "/repo/libs/demo/domain/test/big.test.ts",
          sourceCode: { text: "" },
          report: (r: { readonly message: string }) => testMsgs.push(r.message),
        })
        testVisitor.Program?.({
          type: "Program",
          body: [
            {
              type: "ExpressionStatement",
              expression: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "it" },
                  property: { type: "Identifier", name: "effect" },
                },
                arguments: [
                  { type: "Literal", value: "too long" },
                  {
                    type: "ArrowFunctionExpression",
                    loc: { start: { line: 1 }, end: { line: 201 } },
                    body: { type: "BlockStatement", body: [] },
                  },
                ],
              },
            },
          ],
        })
        expect(testMsgs.some((m) => m.includes("[max-test-case-lines]"))).toBe(true)
      }),
  )

  it.effect.prop(
    "deterministically classifies identical violation counts for generated contract, workflow, and test batches",
    { kinds: Schema.Array(CaseKindArb).pipe(Schema.check(Schema.isMaxLength(5))) },
    ({ kinds }) =>
      Effect.gen(function* () {
        const files = kinds.map((k, idx) => {
          if (k === "unbounded-brand") {
            return {
              filePath: AstSourceFilePath.make(`libs/demo/contract/src/f-${idx}.ts`),
              content: AstSourceContent.make(
                `export const K${idx} = Schema.String.pipe(Schema.brand("K${idx}"))`,
              ),
            }
          }
          if (k === "unknown-record") {
            return {
              filePath: AstSourceFilePath.make(`libs/demo/contract/src/r-${idx}.ts`),
              content: AstSourceContent.make(
                `export const R${idx} = Schema.Record(Schema.String, Schema.Unknown)`,
              ),
            }
          }
          if (k === "wf-name-access") {
            return {
              filePath: AstSourceFilePath.make(`libs/demo/core/src/w-${idx}.ts`),
              content: AstSourceContent.make(
                `const W = Workflow.make("W", {}); export const n = W.name`,
              ),
            }
          }
          if (k === "oversized-test") {
            return {
              filePath: AstSourceFilePath.make(`libs/demo/core/test/t-${idx}.test.ts`),
              content: AstSourceContent.make(buildSizedTestFile("it", 201)),
            }
          }
          return {
            filePath: AstSourceFilePath.make(`libs/demo/contract/src/c-${idx}.ts`),
            content: AstSourceContent.make(
              `export const Ok${idx} = Schema.String.pipe(Schema.isTrimmed(), Schema.brand("Ok${idx}"))`,
            ),
          }
        })
        const first = yield* decideAstGateCache({ files })
        const second = yield* decideAstGateCache({ files })
        expect(first.violations.length).toBe(second.violations.length)
        expect(first.violations.filter((v) => v.rule === "contract-shape-hardening")).toHaveLength(
          kinds.filter((k) => k === "unbounded-brand" || k === "unknown-record").length,
        )
        expect(
          first.violations.filter((v) => v.rule === "workflow-name-instead-of-tag"),
        ).toHaveLength(kinds.filter((k) => k === "wf-name-access").length)
        expect(first.violations.filter((v) => v.rule === "max-test-case-lines")).toHaveLength(
          kinds.filter((k) => k === "oversized-test").length,
        )
      }),
  )
})
