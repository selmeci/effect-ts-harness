import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  inferAstGatePackageTagFromPath,
  MaxPluginFileLines,
} from "@harness/contract"
import { ts } from "@harness/graph"
import { decideSelfDogfooding, SelfDogfooding } from "../src/plugins/self-dogfooding-plugin.js"
import { AstGateCache, visitSourceFileSinglePass } from "../src/ast-cache.js"

describe("Self-Dogfooding Governance Plugins, oxlint parity & Workflow Fences", () => {
  it.effect("REQ-5.3: SelfDogfooding.decide enforces no-layer-build-in-layer-effect", () =>
    Effect.gen(function* () {
      const filePath = AstSourceFilePath.make("libs/harness/gates/src/layer-build.ts")
      const content = AstSourceContent.make(
        'import {Context,Effect} from "effect"\n' +
          'const Tag = Context.Service<{ value: number }>("Tag")\n' +
          "export const badLayer = Layer.effect(Tag, Effect.gen(function* () {\n" +
          "  const scope = yield* Effect.scope\n" +
          "  return yield* Layer.build(Layer.empty)\n" +
          "}))\n" +
          "export const okProgram = Effect.scoped(Layer.build(Layer.empty))\n",
      )
      const report = yield* decideSelfDogfooding({
        files: [{ filePath, content }],
      })
      expect(
        report.violations.filter((v) => v.rule === "no-layer-build-in-layer-effect"),
      ).toHaveLength(1)
    }),
  )

  it.effect("REQ-5.4: SelfDogfooding.decide enforces no-double-wrapped-effect-fn", () =>
    Effect.gen(function* () {
      const filePath = AstSourceFilePath.make("libs/harness/gates/src/double-wrap.ts")
      const content = AstSourceContent.make(
        'import {Effect} from "effect"\n' +
          'export const badArrow = Effect.fn("badArrow")(() => Effect.gen(function* () { return 1 }))\n' +
          'export const badBlock = Effect.fn("badBlock")((x: number) => { return Effect.gen(function* () { return x }) })\n' +
          "export const badUntraced = Effect.fnUntraced(() => Effect.gen(function* () { return 2 }))\n" +
          'export const okFn = Effect.fn("okFn")(function* () { return 3 })\n' +
          "export const okUntraced = Effect.fnUntraced(function* () { return 4 })\n",
      )
      const report = yield* decideSelfDogfooding({
        files: [{ filePath, content }],
      })
      expect(
        report.violations.filter((v) => v.rule === "no-double-wrapped-effect-fn"),
      ).toHaveLength(3)
    }),
  )

  it.effect(
    "REQ-5.5: AstGateCache.decide reports IfStatement discriminant-branching and unscoped-effect-run on libs/harness/gates/src/dummy-test.ts",
    () =>
      Effect.gen(function* () {
        const filePath = AstSourceFilePath.make("libs/harness/gates/src/dummy-test.ts")
        const content = AstSourceContent.make(
          'import {Effect} from "effect"\n' +
            'type State = { readonly _tag: "A" } | { readonly _tag: "B" }\n' +
            "export const inspect = (s: State) => {\n" +
            '  if (s._tag === "A") {\n' +
            "    return 1\n" +
            "  }\n" +
            "  return 2\n" +
            "}\n" +
            "export const runIt = () => Effect.runSync(Effect.succeed(1))\n",
        )
        const report = yield* AstGateCache.decide({
          files: [{ filePath, content, packageTag: AstGatePackageTag.make("domain") }],
        })
        expect(report.violations.filter((v) => v.rule === "discriminant-branching")).toHaveLength(1)
        expect(report.violations.filter((v) => v.rule === "unscoped-effect-run")).toHaveLength(1)
      }),
  )

  it.effect(
    "F-8.3b: SelfDogfooding.decide catches process.env.VITEST (test-env-branch-in-src) and dynamic import('node:fs') (no-node-builtins-outside-infra)",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/bad-env-and-dyn.ts"),
              content: AstSourceContent.make(
                'export const isTest = process.env.VITEST === "true" || process.env["VITEST"] === "1"\n' +
                  'export const loadFs = () => import("node:fs")\n',
              ),
            },
          ],
          failOnViolation: false,
        })
        expect(report.verdict).toBe("violated")
        expect(report.violations.filter((v) => v.rule === "test-env-branch-in-src")).toHaveLength(2)
        expect(
          report.violations.filter((v) => v.rule === "no-node-builtins-outside-infra"),
        ).toHaveLength(1)
      }),
  )

  it.effect(
    "flags silent-gate-fs-fallback for safeFs and Result.getOrElse(Result.try(...readTextSync...), () => '') in libs/harness/gates/src/**",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/plugins/gc/bad.ts"),
              content: AstSourceContent.make(
                [
                  'import {Result} from "effect"',
                  'export const a = safeFs(() => "x", "")',
                  'export const b = Result.getOrElse(Result.try(() => hostIo.readTextSync("x")), () => "")',
                ].join("\n"),
              ),
            },
          ],
          failOnViolation: false,
        })
        expect(report.verdict).toBe("violated")
        expect(report.violations.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(
          2,
        )
      }),
  )

  it.effect(
    "F-12.1 / F-6.1 / S-5.4: enforces bare-cause-has-interrupts, process-env-outside-infra-or-app, and module-scope object property mutation",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/decision/src/bad-checks.ts"),
              content: AstSourceContent.make(
                [
                  "",
                  "const mutableState = { flag: false }",
                  "export const setFlag = () => { mutableState.flag = true }",
                  "export const badCause = (c: Cause.Cause<unknown>) => Cause.hasInterrupts(c)",
                  "export const goodCause = (c: Cause.Cause<unknown>) => Cause.hasInterrupts(c) && !Cause.hasFails(c) && !Cause.hasDies(c)",
                  'export const badEnv = () => process.env["MY_VAR"]',
                ].join("\n"),
              ),
            },
            {
              filePath: AstSourceFilePath.make(
                "libs/harness/contract/src/workspace-and-process.ts",
              ),
              content: AstSourceContent.make(
                "\nexport const isPureInterruptCause = (c: Cause.Cause<unknown>) => Cause.hasInterrupts(c)\n",
              ),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/ok-env.ts"),
              content: AstSourceContent.make('export const okEnv = () => process.env["MY_VAR"]\n'),
            },
          ],
          failOnViolation: false,
        })

        expect(report.verdict).toBe("violated")
        expect(
          report.violations.filter((v) => v.rule === "bare-cause-has-interrupts"),
        ).toHaveLength(1)
        expect(
          report.violations.filter((v) => v.rule === "process-env-outside-infra-or-app"),
        ).toHaveLength(1)
        expect(report.violations.filter((v) => v.rule === "no-global-mutable-cache")).toHaveLength(
          1,
        )
      }),
  )

  it.effect(
    "closes AST false negatives for satisfies/nested/++ mutable caches, computed/destructured process.env, dynamic-harness-import, and point-free/mismatched Cause.hasInterrupts",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/evasion-checks.ts"),
              content: AstSourceContent.make(
                [
                  'import {Effect} from "effect"',
                  "type Cache = { count: number; nested: { hits: number } }",
                  "const cache = { count: 0, nested: { hits: 0 } } satisfies Cache",
                  "export const bump = () => {",
                  "  cache.count++",
                  "  cache.nested.hits = 1",
                  "  Object.assign(cache, { count: 2 })",
                  "}",
                  'export const envBracket = () => process["env"]["FOO"]',
                  "export const envDestructure = () => { const { env } = process; return env }",
                  'export const dynImport = () => import("@harness/contract")',
                  'export const dynRequire = () => require("@harness/contract")',
                  "export const pointFreeCause = (eff: Effect.Effect<void>) => eff.pipe(Effect.catchCauseIf(Cause.hasInterrupts, () => Effect.void))",
                  "export const spoofedCause = (c: Cause.Cause<unknown>, other: Cause.Cause<unknown>) => Cause.hasInterrupts(c) && !Cause.hasFails(other) && !Cause.hasDies(c)",
                ].join("\n"),
              ),
            },
          ],
          failOnViolation: false,
        })

        expect(report.verdict).toBe("violated")
        expect(report.violations.filter((v) => v.rule === "no-global-mutable-cache")).toHaveLength(
          3,
        )
        expect(
          report.violations.filter((v) => v.rule === "process-env-outside-infra-or-app"),
        ).toHaveLength(2)
        expect(report.violations.filter((v) => v.rule === "dynamic-harness-import")).toHaveLength(2)
        expect(
          report.violations.filter((v) => v.rule === "bare-cause-has-interrupts"),
        ).toHaveLength(2)
      }),
  )

  it.effect(
    "I-4a: enforces bare-cause-has-interrupts on Cause.hasInterruptsOnly in src/ outside Effect.catchCause while exempting workspace-and-process.ts",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/interrupt-checks.ts"),
              content: AstSourceContent.make(
                [
                  'import {Effect,Exit} from "effect"',
                  "",
                  "export const standaloneHelper = (cause: Cause.Cause<unknown>) => Cause.hasInterruptsOnly(cause)",
                  "export const inspectExit = (exit: Exit.Exit<unknown, unknown>) =>",
                  "  match(exit)",
                  '    .with({ _tag: "Failure" }, ({ cause }) => Cause.hasInterruptsOnly(cause))',
                  '    .with({ _tag: "Success" }, () => false)',
                  "    .exhaustive()",
                  "export const pointFreeOnly = (eff: Effect.Effect<void>) => eff.pipe(Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void))",
                ].join("\n"),
              ),
            },
            {
              filePath: AstSourceFilePath.make(
                "libs/harness/contract/src/workspace-and-process.ts",
              ),
              content: AstSourceContent.make(
                "\nexport const isPureInterruptCause = (c: Cause.Cause<unknown>) => Cause.hasInterruptsOnly(c)\n",
              ),
            },
          ],
          failOnViolation: false,
        })

        expect(report.verdict).toBe("violated")
        const interruptViolations = report.violations.filter(
          (v) => v.rule === "bare-cause-has-interrupts",
        )
        expect(interruptViolations).toHaveLength(3)
        expect(
          interruptViolations.every((v) => v.file === "libs/harness/infra/src/interrupt-checks.ts"),
        ).toBe(true)
        expect(interruptViolations.every((v) => v.message.includes("isPureInterruptCause"))).toBe(
          true,
        )
      }),
  )

  it("H-1..H-4: enforces silent-gate-fs-fallback scope, all-optional-contract-struct, test bailouts/vacuous length, and discarded-persistence-result", () => {
    const runAst = (relPath: string, code: string) => {
      const sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, true)
      return visitSourceFileSinglePass(
        sf,
        AstSourceFilePath.make(relPath),
        inferAstGatePackageTagFromPath(AstSourceFilePath.make(relPath)),
      )
    }

    // H-1: silent-gate-fs-fallback across graph/cli/mcp, exempting compiler-session.ts and /proc/ probes
    const graphFallback = runAst(
      "libs/harness/graph/src/bad-io.ts",
      'import {Result} from "effect"\nexport const f = () => Result.getOrElse(Result.try(() => readTextSync("x")), () => "")\n',
    )
    expect(graphFallback.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(1)

    const procProbe = runAst(
      "apps/harness-mcp/src/proc-probe.ts",
      'import {Result} from "effect"\nexport const p = (procCmdlinePath: string) => Result.getOrElse(Result.try(() => readTextSync(procCmdlinePath)), () => "")\nexport const p2 = () => Result.getOrElse(Result.try(() => readTextSync("/proc/1/cmdline")), () => "")\nexport const p3 = (pid: number) => Result.getOrElse(Result.try(() => readTextSync(`/proc/${pid}/cmdline`)), () => "")\n',
    )
    expect(procProbe.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(0)

    const procDecoy = runAst(
      "apps/harness-mcp/src/proc-decoy.ts",
      'import {Result} from "effect"\nexport const decoy = () => Result.getOrElse(Result.try(() => { const hint = "/proc/"; return readTextSync("secret.txt") }), () => "")\n',
    )
    expect(procDecoy.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(1)

    const compilerSession = runAst(
      "libs/harness/graph/src/extractor/compiler-session.ts",
      'import {Result} from "effect"\nexport const c = () => Result.getOrElse(Result.try(() => readTextSync("x")), () => "")\n',
    )
    expect(compilerSession.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(0)

    // H-2: all-optional-contract-struct
    const allOptional = runAst(
      "libs/sample/contract/src/bad-struct.ts",
      [
        'import {Schema} from "effect"',
        "export const BadMeta = Schema.Struct({ pid: Schema.optional(Schema.Int), port: Schema.optional(Schema.Int) })",
        "export const GoodMeta = Schema.Struct({ pid: Schema.Int, port: Schema.optional(Schema.Int) })",
      ].join("\n"),
    )
    expect(allOptional.filter((v) => v.rule === "all-optional-contract-struct")).toHaveLength(1)

    // H-3: conditional-port-bind-bailout & vacuous-length-nonnegative-assertion
    const badTest = runAst(
      "libs/sample/domain/test/bad.test.ts",
      [
        "export const t = (bound: boolean, items: ReadonlyArray<string>) => {",
        "  if (!bound) return",
        "  expect(items.length).toBeGreaterThanOrEqual(0)",
        "  expect(items.length).toBeGreaterThanOrEqual(1)",
        "}",
      ].join("\n"),
    )
    expect(badTest.filter((v) => v.rule === "conditional-port-bind-bailout")).toHaveLength(1)
    expect(badTest.filter((v) => v.rule === "vacuous-length-nonnegative-assertion")).toHaveLength(1)

    // H-4: discarded-persistence-result (including void and sequence expression evasion)
    const badPersist = runAst(
      "libs/harness/graph/src/persist.ts",
      [
        "export const p = () => {",
        "  writeGraphHeadMeta()",
        "  updateGraphHeadCursor()",
        "  writeServerMetaAtomic()",
        "  void writeGraphHeadMeta()",
        "  ;(0, writeGraphHeadMeta())",
        "  const ok = writeGraphHeadMeta()",
        "  return ok",
        "}",
      ].join("\n"),
    )
    expect(badPersist.filter((v) => v.rule === "discarded-persistence-result")).toHaveLength(5)
  })

  it("oxlint syntax-bans catches .pipe() all-optional-contract-struct and void/sequence discarded-persistence-result", async () => {
    const pluginMod = (await import(
      new URL("../../../../tools/oxlint/syntax-bans.js", import.meta.url).href
    )) as {
      default: {
        rules: {
          "syntax-bans": {
            create: (
              ctx: unknown,
            ) => Record<string, ((node: Record<string, unknown>) => void) | undefined>
          }
        }
      }
    }
    const syntaxBans = pluginMod.default.rules["syntax-bans"]

    const structReports: Array<{ message: string }> = []
    const contractVisitor = syntaxBans.create({
      filename: "/repo/libs/sample/contract/src/bad-pipe-struct.ts",
      report: (r: { message: string }) => {
        structReports.push(r)
      },
    })
    contractVisitor.ExportNamedDeclaration?.({
      type: "ExportNamedDeclaration",
      declaration: {
        type: "VariableDeclaration",
        declarations: [
          {
            type: "VariableDeclarator",
            id: { type: "Identifier", name: "BadPipeStruct" },
            init: {
              type: "CallExpression",
              callee: {
                type: "MemberExpression",
                computed: false,
                object: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: { type: "Identifier", name: "Schema" },
                    property: { type: "Identifier", name: "Struct" },
                  },
                  arguments: [
                    {
                      type: "ObjectExpression",
                      properties: [
                        {
                          type: "Property",
                          key: { type: "Identifier", name: "a" },
                          value: {
                            type: "CallExpression",
                            callee: {
                              type: "MemberExpression",
                              computed: false,
                              object: { type: "Identifier", name: "Schema" },
                              property: { type: "Identifier", name: "optional" },
                            },
                            arguments: [
                              {
                                type: "MemberExpression",
                                computed: false,
                                object: { type: "Identifier", name: "Schema" },
                                property: { type: "Identifier", name: "Int" },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
                property: { type: "Identifier", name: "pipe" },
              },
              arguments: [{ type: "Identifier", name: "someAnnotation" }],
            },
          },
        ],
      },
    })
    expect(structReports.some((r) => r.message.includes("all-optional-contract-struct"))).toBe(true)

    const persistReports: Array<{ message: string }> = []
    const graphVisitor = syntaxBans.create({
      filename: "/repo/libs/harness/graph/src/persist.ts",
      report: (r: { message: string }) => {
        persistReports.push(r)
      },
    })
    graphVisitor.ExpressionStatement?.({
      type: "ExpressionStatement",
      expression: {
        type: "UnaryExpression",
        operator: "void",
        argument: {
          type: "CallExpression",
          callee: { type: "Identifier", name: "writeGraphHeadMeta" },
          arguments: [],
        },
      },
    })
    graphVisitor.ExpressionStatement?.({
      type: "ExpressionStatement",
      expression: {
        type: "SequenceExpression",
        expressions: [
          { type: "Literal", value: 0 },
          {
            type: "CallExpression",
            callee: { type: "Identifier", name: "updateGraphHeadCursor" },
            arguments: [],
          },
        ],
      },
    })
    expect(
      persistReports.filter((r) => r.message.includes("discarded-persistence-result")),
    ).toHaveLength(2)
  })

  it.effect(
    "REQ-1.3: flags process-exit-outside-app and locale-dependent-sort (including evasion forms) in SelfDogfooding.decide",
    () =>
      Effect.gen(function* () {
        const err = yield* Effect.flip(
          SelfDogfooding.decide({
            files: [
              {
                filePath: AstSourceFilePath.make("libs/sample/core/src/bad-exit.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/harness/gates/src/bad-exit.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/harness/decision/src/bad-exit.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/core/src/evade-exit.ts"),
                content: AstSourceContent.make(
                  [
                    'export const e1 = () => process["exit"](1)',
                    "export const e2 = () => globalThis.process.exit(1)",
                    "export const e3 = () => { const { exit } = process; return exit(1) }",
                    "export const e4 = () => { const p = process; return p.exit(1) }",
                    "export const e5 = () => process.reallyExit(1)",
                    "export const e6 = () => Reflect.apply(process.exit, process, [1])",
                  ].join("\n") + "\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/sample/src/ok-exit.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/core/test/ok-exit.test.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/contract/src/bad-sort.ts"),
                content: AstSourceContent.make(
                  "export const sortIds = (xs: string[]) => [...xs].sort((a, b) => a.localeCompare(b))\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/bad-sort.ts"),
                content: AstSourceContent.make(
                  "export const cmp = (a: string, b: string) => a.localeCompare(b)\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/evade-sort.ts"),
                content: AstSourceContent.make(
                  [
                    'export const s1 = (a: string, b: string) => a["localeCompare"](b)',
                    "export const s2 = (a: string, b: string) => String.prototype.localeCompare.call(a, b)",
                    "export const s3 = (a: string, b: string) => new Intl.Collator().compare(a, b)",
                  ].join("\n") + "\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make(
                  "libs/harness/gates/src/plan-workflow-compiler.ts",
                ),
                content: AstSourceContent.make(
                  "export const cmp = (a: string, b: string) => a.localeCompare(b)\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/ok-sort.ts"),
                content: AstSourceContent.make(
                  "export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/harness-cli/src/bad-promise.ts"),
                content: AstSourceContent.make(
                  'export const bad = Effect.promise(() => import("./mod.js"))\nexport const badBracket = Effect["promise"](() => import("./mod.js"))\n',
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/harness-cli/src/evade-promise.ts"),
                content: AstSourceContent.make(
                  [
                    'import { Effect as Fx } from "effect"',
                    'import * as Eff from "effect"',
                    'import { promise as effPromise } from "effect/Effect"',
                    "const { promise } = Fx",
                    "export const e1 = Fx.promise(() => Promise.resolve(1))",
                    "export const e2 = Eff.Effect.promise(() => Promise.resolve(2))",
                    "export const e3 = effPromise(() => Promise.resolve(3))",
                    "export const e4 = promise(() => Promise.resolve(4))",
                    "export const e5 = Reflect.apply(Fx.promise, Fx, [() => Promise.resolve(5)])",
                  ].join("\n") + "\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/harness-cli/src/good-trypromise.ts"),
                content: AstSourceContent.make(
                  'export const good = Effect.tryPromise({ try: () => import("./mod.js"), catch: (e) => e })\n',
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/harness-cli/test/ok-promise.test.ts"),
                content: AstSourceContent.make(
                  "export const okTest = Effect.promise(() => Promise.resolve(1))\n",
                ),
              },
            ],
            maxPluginFileLines: MaxPluginFileLines.make(800),
            failOnViolation: true,
          }),
        )

        const exitViolations = err.violations.filter((v) => v.rule === "process-exit-outside-app")
        expect(
          exitViolations.map((v) => v.file).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        ).toEqual([
          "libs/harness/decision/src/bad-exit.ts",
          "libs/harness/gates/src/bad-exit.ts",
          "libs/sample/core/src/bad-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
        ])

        const sortViolations = err.violations.filter((v) => v.rule === "locale-dependent-sort")
        expect(
          sortViolations.map((v) => v.file).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        ).toEqual([
          "libs/harness/gates/src/plan-workflow-compiler.ts",
          "libs/sample/contract/src/bad-sort.ts",
          "libs/sample/domain/src/bad-sort.ts",
          "libs/sample/domain/src/evade-sort.ts",
          "libs/sample/domain/src/evade-sort.ts",
          "libs/sample/domain/src/evade-sort.ts",
        ])

        const promiseViolations = err.violations.filter(
          (v) => v.rule === "unhandled-effect-promise",
        )
        expect(
          promiseViolations.map((v) => v.file).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        ).toEqual([
          "apps/harness-cli/src/bad-promise.ts",
          "apps/harness-cli/src/bad-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
        ])
      }),
  )

  it.effect(
    "SPEC-0027 REQ-3.1: flags unfenced expectMutation: true calls and permits fenced or exempt lease calls",
    () =>
      Effect.gen(function* () {
        const cleanReport = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/fenced-calls.ts"),
              content: AstSourceContent.make(
                [
                  "declare function invokeWorkflowStoreQuery(input: unknown): unknown",
                  "declare function invokeWorkflowStoreQueryWithMeta(input: unknown): unknown",
                  "declare function invokeWorkflowStoreQueryOnce(input: unknown): unknown",
                  "declare const WorkflowStore: { invoke: (i: unknown) => unknown; invokeWithMeta: (i: unknown) => unknown }",
                  "declare const otherClient: { invoke: (i: unknown) => unknown }",
                  "declare const expectedLeaseEpoch: number",
                  "declare const otherEpoch: number",
                  "declare const fenceConfig: object",
                  "declare const target: object",
                  "declare const storeTarget: object",
                  "declare const cond: boolean",
                  'export const okRead = invokeWorkflowStoreQuery({ queryName: "wf_get_run", expectMutation: false })',
                  'export const okNoFlag = invokeWorkflowStoreQuery({ queryName: "wf_get_run" })',
                  "export const okZeroArg = invokeWorkflowStoreQuery()",
                  'export const okExplicit = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true, expectedLeaseEpoch: expectedLeaseEpoch })',
                  'export const okTemplateProp = invokeWorkflowStoreQuery({ [`queryName`]: "wf_insert_run", ["expectMutation"]: true, [`expectedLeaseEpoch`]: expectedLeaseEpoch })',
                  'export const okShorthand = invokeWorkflowStoreQueryWithMeta({ queryName: "wf_insert_run", expectMutation: true, expectedLeaseEpoch })',
                  'export const okFenceSpread = invokeWorkflowStoreQueryOnce({ queryName: "wf_insert_run", expectMutation: true, ...fenceConfig })',
                  'export const okTargetSpread = WorkflowStore.invoke({ queryName: "wf_insert_run", expectMutation: true, ...target })',
                  'export const okStoreTarget = WorkflowStore.invokeWithMeta({ queryName: "wf_insert_run", expectMutation: true, ...storeTarget })',
                  'export const okCondBoth = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true, ...(cond ? { expectedLeaseEpoch } : { expectedLeaseEpoch: otherEpoch }) })',
                  'export const okObjSpread = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true, ...({ expectedLeaseEpoch }) })',
                  'export const okLease1 = invokeWorkflowStoreQuery({ queryName: "wf_insert_writer_lease", expectMutation: true })',
                  "export const okLease2 = invokeWorkflowStoreQuery({ queryName: `wf_cas_writer_lease`, expectMutation: true })",
                  'export const okLease3 = invokeWorkflowStoreQuery({ queryName: "wf_refresh_writer_lease", expectMutation: true })',
                  'export const okOtherInvoke = otherClient.invoke({ queryName: "wf_insert_run", expectMutation: true })',
                ].join("\n") + "\n",
              ),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/offline-maint.ts"),
              content: AstSourceContent.make(
                [
                  "declare function verifyOfflineClusterAccess(): void",
                  "declare function invokeWorkflowStoreQuery(input: unknown): unknown",
                  "export const runOffline = () => {",
                  "  verifyOfflineClusterAccess()",
                  '  return invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true })',
                  "}",
                ].join("\n") + "\n",
              ),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
        })
        expect(
          cleanReport.violations.filter((v) => v.rule === "omnigraph-fenced-mutation"),
        ).toEqual([])

        const violatedReport = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/unfenced-calls.ts"),
              content: AstSourceContent.make(
                [
                  "declare function invokeWorkflowStoreQuery(input: unknown): unknown",
                  "declare function invokeWorkflowStoreQueryWithMeta(input: unknown): unknown",
                  "declare function invokeWorkflowStoreQueryOnce(input: unknown): unknown",
                  "declare function verifyOfflineClusterAccess(): void",
                  "declare function buildConfig(): object",
                  "declare const WorkflowStore: { invoke: (i: unknown) => unknown; invokeWithMeta: (i: unknown) => unknown }",
                  "declare const wf_cas_writer_lease: string",
                  "declare const expectedLeaseEpoch: number",
                  "declare const storeConfig: object",
                  "declare const cond: boolean",
                  'export const bad1 = (invokeWorkflowStoreQuery)({ queryName: "wf_insert_run", expectMutation: true })',
                  'export const bad2 = invokeWorkflowStoreQueryWithMeta({ queryName: "wf_insert_run", expectMutation: true, expectedLeaseEpoch: undefined })',
                  'export const bad3 = invokeWorkflowStoreQueryOnce({ queryName: "wf_insert_run", expectMutation: true, expectedLeaseEpoch: null })',
                  'export const bad4 = WorkflowStore.invoke({ queryName: "wf_insert_run", expectMutation: true, ...storeConfig })',
                  'export const bad5 = WorkflowStore.invokeWithMeta({ queryName: "wf_insert_run", expectMutation: true, ...(cond ? {} : {}), ...buildConfig() })',
                  "export const bad6 = invokeWorkflowStoreQuery({ queryName: wf_cas_writer_lease, expectMutation: true })",
                  'export const badCondTrue = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true, ...(cond ? { expectedLeaseEpoch } : {}) })',
                  'export const badCondFalse = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true, ...(cond ? {} : { expectedLeaseEpoch }) })',
                  "const siblingVerify = () => { verifyOfflineClusterAccess() }",
                  "export const badSiblingOffline = () => invokeWorkflowStoreQuery({ queryName: 'wf_insert_run', expectMutation: true })",
                  "export const badTrailingOffline = () => { const res = invokeWorkflowStoreQuery({ queryName: 'wf_insert_run', expectMutation: true }); verifyOfflineClusterAccess(); return res }",
                  'const badLocalReq = { queryName: "wf_insert_run", expectMutation: true }',
                  "export const badLocalCall = invokeWorkflowStoreQuery(badLocalReq)",
                  "const expectMutation = true",
                  'export const badShorthand = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation })',
                ].join("\n") + "\n",
              ),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
        })
        const fenceViolations = violatedReport.violations.filter(
          (v) => v.rule === "omnigraph-fenced-mutation",
        )
        expect(fenceViolations).toHaveLength(12)
      }),
  )

  it.effect(
    "SPEC-0030 2nd-pass: flags dynamic expectMutation, spread bad local payload, and scopes verifyOfflineClusterAccess per function",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/fence-recheck.ts"),
              content: AstSourceContent.make(
                [
                  "declare function invokeWorkflowStoreQuery(input: unknown): unknown",
                  "declare function verifyOfflineClusterAccess(): void",
                  "const mutFlag = true",
                  'const badLocalReq = { queryName: "wf_insert_run", expectMutation: true }',
                  'export const badDynamicFlag = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: mutFlag })',
                  "export const badSpreadLocal = invokeWorkflowStoreQuery({ ...badLocalReq })",
                  "export const badOuterOffline = () => {",
                  "  verifyOfflineClusterAccess()",
                  "  return () =>",
                  '    invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true })',
                  "}",
                ].join("\n") + "\n",
              ),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
        })
        const fenceViolations = report.violations.filter(
          (v) => v.rule === "omnigraph-fenced-mutation",
        )
        expect(fenceViolations).toHaveLength(3)
      }),
  )

  it.effect(
    "F-5.3 (SPEC-0027 REQ-3.1): fails closed on dynamic/unresolved WorkflowStore payloads while exempting internal omnigraph-workflow-store pass-through wrappers",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make(
                "libs/harness/infra/src/omnigraph-workflow-store.ts",
              ),
              content: AstSourceContent.make(
                [
                  "declare function invokeWorkflowStoreQueryOnce(input: unknown): unknown",
                  "declare function retryWorkflowStoreAttempt(opts: { runAttempt: () => unknown }): unknown",
                  "export const invokeWorkflowStoreQueryWithMeta = Effect.fn('WorkflowStore.invokeWithMeta')(function* (input: unknown) {",
                  "  return yield* retryWorkflowStoreAttempt({ runAttempt: () => invokeWorkflowStoreQueryOnce(input) })",
                  "})",
                  "export const invokeWorkflowStoreQuery = Effect.fn('WorkflowStore.invoke')(function* (input: unknown) {",
                  "  const res = yield* retryWorkflowStoreAttempt({ runAttempt: () => invokeWorkflowStoreQueryOnce(input) })",
                  "  return res",
                  "})",
                  "export const otherFnInStore = (input: unknown) => invokeWorkflowStoreQueryOnce(input)",
                ].join("\n") + "\n",
              ),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/dynamic-fence.ts"),
              content: AstSourceContent.make(
                [
                  "declare function invokeWorkflowStoreQuery(input: unknown): unknown",
                  "declare function invokeWorkflowStoreQueryOnce(input: unknown): unknown",
                  "declare function verifyOfflineClusterAccess(): void",
                  "declare function buildParams(): object",
                  "declare const fenceConfig: object",
                  "export const badVar = invokeWorkflowStoreQuery(fenceConfig)",
                  "export const badHelper = invokeWorkflowStoreQuery(buildParams())",
                  "export const badSpread = (req: object) => invokeWorkflowStoreQuery({ ...req })",
                  "export const badHelperSpread = () => invokeWorkflowStoreQuery({ ...buildParams() })",
                  "export const badDynMut = (mut: boolean) => invokeWorkflowStoreQuery({ queryName: 'wf_insert_run', expectMutation: mut })",
                  "export const okReadSpread = (storeConfig: object) => invokeWorkflowStoreQuery({ ...storeConfig, queryName: 'wf_get_run', expectMutation: false })",
                  "export const badDirectOnce = (input: unknown) => invokeWorkflowStoreQueryOnce(input)",
                  "export const okOfflineDynamic = () => {",
                  "  verifyOfflineClusterAccess()",
                  "  return invokeWorkflowStoreQuery(buildParams())",
                  "}",
                ].join("\n") + "\n",
              ),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
        })
        const violations = report.violations.filter((v) => v.rule === "omnigraph-fenced-mutation")
        expect(violations.map((v) => `${v.file}:${v.line}`)).toEqual([
          "libs/harness/infra/src/omnigraph-workflow-store.ts:10",
          "libs/harness/infra/src/dynamic-fence.ts:6",
          "libs/harness/infra/src/dynamic-fence.ts:7",
          "libs/harness/infra/src/dynamic-fence.ts:8",
          "libs/harness/infra/src/dynamic-fence.ts:9",
          "libs/harness/infra/src/dynamic-fence.ts:10",
          "libs/harness/infra/src/dynamic-fence.ts:12",
        ])
      }),
  )

  it.effect.prop(
    "SPEC-0027 REQ-3.1 determinism: SelfDogfooding.decide emits deterministic omnigraph-fenced-mutation verdicts",
    {
      spec: Schema.Struct({
        queryName: Schema.Literals(["wf_insert_run", "wf_cas_writer_lease", "wf_update_unit"]),
        fencingMode: Schema.Literals(["explicit", "fenceSpread", "missing"]),
        expectMutation: Schema.Boolean,
      }),
    },
    ({ spec }) =>
      Effect.gen(function* () {
        const fenceField = match(spec.fencingMode)
          .with("explicit", () => ", expectedLeaseEpoch: epoch")
          .with("fenceSpread", () => ", ...fenceConfig")
          .with("missing", () => "")
          .exhaustive()
        const src = AstSourceContent.make(
          `declare function invokeWorkflowStoreQuery(input: unknown): unknown\n` +
            `declare const epoch: number\n` +
            `declare const fenceConfig: object\n` +
            `export const call = invokeWorkflowStoreQuery({ queryName: "${spec.queryName}", expectMutation: ${String(spec.expectMutation)}${fenceField} })\n`,
        )
        const input = {
          files: [
            { filePath: AstSourceFilePath.make("libs/harness/infra/src/prop.ts"), content: src },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
        }
        const first = yield* SelfDogfooding.decide(input)
        const second = yield* SelfDogfooding.decide(input)
        expect(first).toEqual(second)
        const shouldViolate =
          spec.expectMutation &&
          spec.queryName !== "wf_cas_writer_lease" &&
          spec.fencingMode === "missing"
        expect(first.violations.some((v) => v.rule === "omnigraph-fenced-mutation")).toBe(
          shouldViolate,
        )
      }),
  )

  it.effect(
    "F-5.3 flags trailing spreads, non-exempt spread overrides, and dynamic/shorthand queryName overrides after exempt values",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/spread-order.ts"),
              content: AstSourceContent.make(
                [
                  "declare function invokeWorkflowStoreQuery(input: unknown): unknown",
                  "declare const dynamicPayload: Record<string, unknown>",
                  "declare const dynamicQuery: string",
                  "const nonExempt = { queryName: 'wf_insert_run' } as const",
                  "const queryName = dynamicQuery",
                  "export const bad1 = invokeWorkflowStoreQuery({ expectMutation: false, ...dynamicPayload })",
                  "export const bad2 = invokeWorkflowStoreQuery({ queryName: 'wf_cas_writer_lease', ...dynamicPayload })",
                  "export const bad3 = invokeWorkflowStoreQuery({ queryName: 'wf_cas_writer_lease', queryName: dynamicQuery, expectMutation: true })",
                  "export const bad4 = invokeWorkflowStoreQuery({ queryName: 'wf_cas_writer_lease', ...nonExempt, expectMutation: true })",
                  "export const bad5 = invokeWorkflowStoreQuery({ queryName: 'wf_cas_writer_lease', queryName, expectMutation: true })",
                  "export const ok1 = invokeWorkflowStoreQuery({ ...dynamicPayload, expectMutation: false })",
                  "export const ok2 = invokeWorkflowStoreQuery({ ...dynamicPayload, queryName: 'wf_cas_writer_lease' })",
                ].join("\n") + "\n",
              ),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
        })
        const violations = report.violations.filter((v) => v.rule === "omnigraph-fenced-mutation")
        expect(violations.map((v) => v.line)).toEqual([6, 7, 8, 9, 10])
      }),
  )
})
