import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"
import { NonNegativeCount } from "@harness/graph"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import { checkSpanBudgets, type SpanSample } from "../src/span-budget.js"
import {
  ActiveMutantId,
  MaxPluginFileLines,
  PluginId,
  type SelfDogfoodingInput,
  SelfDogfoodingMessage,
  SelfDogfoodingRuleId,
  type SelfDogfoodingViolation,
  SubprocessArg,
  SubprocessCommand,
  SubprocessExitCode,
  SubprocessOutput,
  WorkspaceFilePath,
} from "../src/plugins/self-dogfooding-contract.js"
import { decideSelfDogfooding, SelfDogfooding } from "../src/plugins/self-dogfooding-plugin.js"
import {
  DEFAULT_GATE_PLUGINS,
  evaluateAllGatePlugins,
  type GatePluginDescriptor,
  GatePluginRegistryLive,
  makeGatePluginRegistryLayer,
} from "../src/plugins/gate-plugin-registry.js"
import {
  makeWorkspaceFsMemoryLayer,
  readAndVerifyWorkspaceFile,
} from "../src/services/workspace-fs.js"
import {
  execCheckedSubprocess,
  makeHarnessSubprocessRunnerTestLayer,
} from "../src/services/subprocess-runner.js"
import {
  ActiveMutantContextLive,
  withActiveMutantEffect,
} from "../src/services/active-mutant-context.js"
import { getActiveMutantId } from "../src/mutation-check.js"
import {
  AstGateCache,
  AstSourceContent,
  AstSourceFilePath,
  EnclosingSymbolName,
  GateVerdict,
  HARNESS_GATE_RULE_VERSION,
  SourceLineNumber,
} from "../src/ast-cache.js"

const toSpanSamples = (
  spans: ReadonlyArray<{
    readonly spanId: string
    readonly name: string
    readonly parentSpanId: string | null
    readonly durationMs?: number | undefined
    readonly startTimeMs?: number | undefined
    readonly endTimeMs?: number | undefined
    readonly exitTag?: string | undefined
    readonly errorTag?: string | null | undefined
  }>,
): ReadonlyArray<SpanSample> =>
  spans.map((s) => ({
    spanId: s.spanId,
    name: s.name,
    parentSpanId: s.parentSpanId,
    durationMs: s.durationMs,
    startTimeMs: s.startTimeMs,
    endTimeMs: s.endTimeMs,
    exitTag:
      s.exitTag === "Success" || s.exitTag === "Failure" || s.exitTag === "Defect"
        ? s.exitTag
        : undefined,
    errorTag: s.errorTag,
  }))

const emptyFnIndex: ReadonlyMap<string, IndexedEffectFn> = new Map()

describe("Self-Dogfooding Plugin & Capability Harness (SPEC-0011)", () => {
  // ---------------------------------------------------------------------------
  // 1 · Pure Self-Dogfooding Gate Decider (SelfDogfooding.decide)
  // ---------------------------------------------------------------------------

  it.effect.prop(
    "REQ-1.1: clean inputs return clean: true and zero violations with R = never",
    {
      moduleKind: Schema.Literals(["plugins", "services", "commands", "tools"]),
      fileIndex: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
      snippetIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    },
    ({ moduleKind, fileIndex, snippetIndex }) =>
      Effect.gen(function* () {
        const cleanSnippets = [
          "export const add = (a: number, b: number): number => a + b\n",
          "export const multiply = (x: number, y: number): number => x * y\n",
          "export const greet = (name: string): string => `Hello, ${name}`\n",
          "export const isPositive = (n: number): boolean => n > 0\n",
        ]
        const snippet = cleanSnippets[snippetIndex] ?? cleanSnippets[0]!
        const filePath = AstSourceFilePath.make(
          `libs/harness/gates/src/${moduleKind}/module-${fileIndex}.ts`,
        )
        const input: SelfDogfoodingInput = {
          files: [
            {
              filePath,
              content: AstSourceContent.make(snippet),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
          failOnViolation: true,
        }

        const report = yield* SelfDogfooding.decide(input)
        expect(report.verdict).toBe("clean")
        expect(report.violations).toHaveLength(0)
        expect(report.inspectedFileCount).toBe(1)
      }),
  )

  it.effect.prop(
    "REQ-1.2: inputs containing violations fail with SelfDogfoodingViolationError when failOnViolation is true",
    {
      violationType: Schema.Literals([
        "effect-fn-dummy-void",
        "nested-effect-run-sync",
        "harness-switch-statement",
        "match-run-statement",
        "file-line-budget-exceeded",
      ]),
      variation: Schema.Boolean,
    },
    ({ violationType, variation }) =>
      Effect.gen(function* () {
        const { content, maxLines } = match(violationType)
          .with("effect-fn-dummy-void", () => ({
            content: variation
              ? "export const f = Effect.fn('test')(function* () { yield* (Effect.void) })\n"
              : "export const f = Effect.fn('test')(function* () { yield* Effect.void })\n",
            maxLines: MaxPluginFileLines.make(800),
          }))
          .with("nested-effect-run-sync", () => ({
            content: variation
              ? "export const g = Effect.suspend(() => { Effect.runSync(Effect.succeed(42)) })\n"
              : "export const g = Effect.sync(() => { Effect.runSync(Effect.succeed(42)) })\n",
            maxLines: MaxPluginFileLines.make(800),
          }))
          .with("harness-switch-statement", () => ({
            content:
              "export const h = (x: number): number => { switch (x) { case 1: return 1; default: return 0; } }\n",
            maxLines: MaxPluginFileLines.make(800),
          }))
          .with("match-run-statement", () => ({
            content: variation
              ? "export const m = (x: number): number => (match(x).with(1, () => 1).run())\n"
              : "export const m = (x: number): number => match(x).with(1, () => 1).run()\n",
            maxLines: MaxPluginFileLines.make(800),
          }))
          .with("file-line-budget-exceeded", () => ({
            content: "// line\n".repeat(20),
            maxLines: MaxPluginFileLines.make(10),
          }))
          .exhaustive()

        const input: SelfDogfoodingInput = {
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/plugins/bad-module.ts"),
              content: AstSourceContent.make(content),
            },
          ],
          maxPluginFileLines: maxLines,
          failOnViolation: true,
        }

        const exit = yield* Effect.exit(SelfDogfooding.decide(input))
        expect(Exit.isFailure(exit)).toBe(true)

        if (Exit.isFailure(exit)) {
          const errOpt = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("SelfDogfoodingViolationError")
            expect(errOpt.value.violations.length).toBeGreaterThan(0)
            const rules = errOpt.value.violations.map((v) => v.rule)
            expect(rules).toContain(violationType)
          }
        }
      }),
  )

  it.effect(
    "REQ-1.3: boundary test for maxPluginFileLines on SelfDogfooding.decide (limit - 1, limit, limit + 1)",
    () =>
      Effect.gen(function* () {
        const limit = MaxPluginFileLines.make(10)

        // limit - 1 (9 lines) -> clean
        const content9 = Array.from({ length: 9 }, (_, i) => `export const v${i} = ${i}`).join("\n")
        const report9 = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/boundary-9.ts"),
              content: AstSourceContent.make(content9),
            },
          ],
          maxPluginFileLines: limit,
          failOnViolation: false,
        })
        expect(report9.verdict).toBe("clean")
        expect(report9.violations).toHaveLength(0)

        // limit (10 lines) -> clean
        const content10 = Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}`).join("\n")
        const report10 = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/boundary-10.ts"),
              content: AstSourceContent.make(content10),
            },
          ],
          maxPluginFileLines: limit,
          failOnViolation: false,
        })
        expect(report10.verdict).toBe("clean")
        expect(report10.violations).toHaveLength(0)

        // limit + 1 (11 lines) -> violated
        const content11 = Array.from({ length: 11 }, (_, i) => `export const v${i} = ${i}`).join("\n")
        const report11 = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/boundary-11.ts"),
              content: AstSourceContent.make(content11),
            },
          ],
          maxPluginFileLines: limit,
          failOnViolation: false,
        })
        expect(report11.verdict).toBe("violated")
        expect(report11.violations).toHaveLength(1)
        expect(report11.violations[0]?.rule).toBe("file-line-budget-exceeded")
      }),
  )

  it.effect(
    "REQ-1.2: non-failing mode returns violated verdict without raising error",
    () =>
      Effect.gen(function* () {
        const input: SelfDogfoodingInput = {
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/plugins/sample.ts"),
              content: AstSourceContent.make(
                "export const fn = Effect.fn('fn')(function* () { yield* Effect.void })\n",
              ),
            },
          ],
          failOnViolation: false,
        }

        const report = yield* decideSelfDogfooding(input)
        expect(report.verdict).toBe("violated")
        expect(report.violations.length).toBeGreaterThan(0)
        expect(report.violations[0]?.rule).toBe("effect-fn-dummy-void")
      }),
  )

  // ---------------------------------------------------------------------------
  // 2 · Capability Services for Filesystem, Subprocess & Mutant Context
  // ---------------------------------------------------------------------------

  it.effect(
    "REQ-2.1: WorkspaceFs.readAndVerifyFile yields WorkspaceFs and returns content & line count",
    () =>
      Effect.gen(function* () {
        const testId = "WorkspaceFs.readAndVerifyFile::happy-path"
        const memoryLayer = makeWorkspaceFsMemoryLayer({
          "src/plugins/sample.ts": "export const a = 1\nexport const b = 2\n",
        })
        const { result, spans } = yield* runWithTestTracer(
          testId,
          readAndVerifyWorkspaceFile(WorkspaceFilePath.make("src/plugins/sample.ts")).pipe(
            Effect.provide(memoryLayer),
          ),
          emptyFnIndex,
        )
        expect(result.filePath).toBe("src/plugins/sample.ts")
        expect(result.content).toBe("export const a = 1\nexport const b = 2\n")
        expect(result.lineCount).toBe(3)

        const budgetViolations = checkSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(budgetViolations).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-2.2: WorkspaceFs.readAndVerifyFile fails with WorkspaceFsError when file does not exist",
    () =>
      Effect.gen(function* () {
        const testId = "WorkspaceFs.readAndVerifyFile::missing-file"
        const memoryLayer = makeWorkspaceFsMemoryLayer({})
        const { result: exit, spans } = yield* runWithTestTracer(
          testId,
          Effect.exit(
            readAndVerifyWorkspaceFile(WorkspaceFilePath.make("src/plugins/missing.ts")).pipe(
              Effect.provide(memoryLayer),
            ),
          ),
          emptyFnIndex,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const errOpt = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("WorkspaceFsError")
            expect(errOpt.value.operation).toBe("read")
            expect(errOpt.value.filePath).toBe("src/plugins/missing.ts")
          }
        }

        const budgetViolations = checkSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(budgetViolations).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-2.3: HarnessSubprocess.execChecked yields runner and returns exitCode 0 result",
    () =>
      Effect.gen(function* () {
        const testId = "HarnessSubprocess.execChecked::happy-path"
        const testLayer = makeHarnessSubprocessRunnerTestLayer((input) =>
          Effect.succeed({
            command: input.command,
            exitCode: SubprocessExitCode.make(0),
            stdout: SubprocessOutput.make("execution success"),
            stderr: SubprocessOutput.make(""),
          }),
        )
        const { result, spans } = yield* runWithTestTracer(
          testId,
          execCheckedSubprocess({
            command: SubprocessCommand.make("echo"),
            args: [SubprocessArg.make("hello")],
          }).pipe(Effect.provide(testLayer)),
          emptyFnIndex,
        )
        expect(result.command).toBe("echo")
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("execution success")

        const budgetViolations = checkSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(budgetViolations).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-2.4: HarnessSubprocess.execChecked fails with HarnessSubprocessError on non-zero exit or empty command",
    () =>
      Effect.gen(function* () {
        const testLayer = makeHarnessSubprocessRunnerTestLayer((input) =>
          Effect.succeed({
            command: input.command,
            exitCode: SubprocessExitCode.make(127),
            stdout: SubprocessOutput.make(""),
            stderr: SubprocessOutput.make("command not found"),
          }),
        )
        const { result: exitNonZero, spans: spansNonZero } = yield* runWithTestTracer(
          "HarnessSubprocess.execChecked::non-zero-exit",
          Effect.exit(
            execCheckedSubprocess({
              command: SubprocessCommand.make("unknown-cmd"),
              args: [],
            }).pipe(Effect.provide(testLayer)),
          ),
          emptyFnIndex,
        )
        expect(Exit.isFailure(exitNonZero)).toBe(true)
        if (Exit.isFailure(exitNonZero)) {
          const errOpt = Cause.findErrorOption(exitNonZero.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("HarnessSubprocessError")
            expect(errOpt.value.exitCode).toBe(127)
            expect(errOpt.value.stderr).toBe("command not found")
          }
        }
        expect(
          checkSpanBudgets({ spans: toSpanSamples(spansNonZero), maxRepeatedChildCalls: 3 }),
        ).toHaveLength(0)

        const { result: exitEmpty, spans: spansEmpty } = yield* runWithTestTracer(
          "HarnessSubprocess.execChecked::empty-command",
          Effect.exit(
            execCheckedSubprocess({
              command: SubprocessCommand.make("   "),
              args: [],
            }).pipe(Effect.provide(testLayer)),
          ),
          emptyFnIndex,
        )
        expect(Exit.isFailure(exitEmpty)).toBe(true)
        if (Exit.isFailure(exitEmpty)) {
          const errOpt = Cause.findErrorOption(exitEmpty.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("HarnessSubprocessError")
            expect(errOpt.value.reason).toBe("Subprocess command must not be empty")
          }
        }
        expect(
          checkSpanBudgets({ spans: toSpanSamples(spansEmpty), maxRepeatedChildCalls: 3 }),
        ).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-2.5: MutationCheck.withActiveMutant activates mutant and guarantees restoration",
    () =>
      Effect.gen(function* () {
        const testId = "MutationCheck.withActiveMutant::scoped-activation"
        const mutantId = ActiveMutantId.make("mutant-core-decider-01")

        expect(getActiveMutantId()).toBeUndefined()

        let observedInside: string | null = null
        const { result, spans } = yield* runWithTestTracer(
          testId,
          withActiveMutantEffect(mutantId, () => {
            observedInside = getActiveMutantId() ?? null
            return true
          }).pipe(Effect.provide(ActiveMutantContextLive)),
          emptyFnIndex,
        )

        expect(result).toBe(true)
        expect(observedInside).toBe("mutant-core-decider-01")
        expect(getActiveMutantId()).toBeUndefined()

        const budgetViolations = checkSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(budgetViolations).toHaveLength(0)

        const { result: failExit, spans: failSpans } = yield* runWithTestTracer(
          "MutationCheck.withActiveMutant::callback-defect",
          Effect.exit(
            withActiveMutantEffect(ActiveMutantId.make("mutant-fail-02"), () => {
              expect(getActiveMutantId()).toBe("mutant-fail-02")
              throw new Error("simulated mutant callback failure")
            }).pipe(Effect.provide(ActiveMutantContextLive)),
          ),
          emptyFnIndex,
        )
        expect(Exit.isFailure(failExit)).toBe(true)
        if (Exit.isFailure(failExit)) {
          expect(Cause.hasDies(failExit.cause)).toBe(true)
        }
        expect(getActiveMutantId()).toBeUndefined()

        const failBudgetViolations = checkSpanBudgets({
          spans: toSpanSamples(failSpans),
          maxRepeatedChildCalls: 3,
        })
        expect(failBudgetViolations).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-2.6: GatePluginRunner.evaluateAll reads files and returns SelfDogfoodingReport",
    () =>
      Effect.gen(function* () {
        const testId = "GatePluginRunner.evaluateAll::happy-path"
        const memoryFsLayer = makeWorkspaceFsMemoryLayer({
          "src/plugins/plugin-a.ts": "export const a = 1\n",
          "src/services/service-b.ts": "export const b = 2\n",
        })
        const appLayer = Layer.mergeAll(GatePluginRegistryLive, memoryFsLayer)

        const { result, spans } = yield* runWithTestTracer(
          testId,
          evaluateAllGatePlugins({
            filePaths: [
              WorkspaceFilePath.make("src/plugins/plugin-a.ts"),
              WorkspaceFilePath.make("src/services/service-b.ts"),
            ],
            failOnViolation: true,
          }).pipe(Effect.provide(appLayer)),
          emptyFnIndex,
        )

        expect(result.verdict).toBe("clean")
        expect(result.violations).toHaveLength(0)
        expect(result.inspectedFileCount).toBe(2)

        const budgetViolations = checkSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(budgetViolations).toHaveLength(0)

        const { result: missingExit, spans: missingSpans } = yield* runWithTestTracer(
          "GatePluginRunner.evaluateAll::missing-file",
          Effect.exit(
            evaluateAllGatePlugins({
              filePaths: [WorkspaceFilePath.make("src/missing.ts")],
              failOnViolation: true,
            }).pipe(Effect.provide(appLayer)),
          ),
          emptyFnIndex,
        )
        expect(Exit.isFailure(missingExit)).toBe(true)
        if (Exit.isFailure(missingExit)) {
          const errOpt = Cause.findErrorOption(missingExit.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("WorkspaceFsError")
          }
        }

        const missingBudgetViolations = checkSpanBudgets({
          spans: toSpanSamples(missingSpans),
          maxRepeatedChildCalls: 3,
        })
        expect(missingBudgetViolations).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-2.7: GatePluginRunner.evaluateAll executes custom registered plugins and aggregates violations",
    () =>
      Effect.gen(function* () {
        const testId = "GatePluginRunner.evaluateAll::custom-plugin"
        const customPlugin: GatePluginDescriptor = {
          pluginId: PluginId.make("custom-ban-bar"),
          description: "Bans identifier 'bar' in source files",
          evaluate: (files) =>
            Effect.sync(() => {
              const violations: Array<SelfDogfoodingViolation> = []
              for (const file of files) {
                if (file.content.includes("bar")) {
                  violations.push({
                    rule: SelfDogfoodingRuleId.make("effect-fn-dummy-void"),
                    message: SelfDogfoodingMessage.make("Custom plugin detected 'bar'"),
                    file: file.filePath,
                    line: SourceLineNumber.make(1),
                    enclosingSymbol: EnclosingSymbolName.make(file.filePath),
                  })
                }
              }
              return {
                verdict: GateVerdict.make(violations.length === 0 ? "clean" : "violated"),
                violations,
                inspectedFileCount: NonNegativeCount.make(files.length),
              }
            }),
        }

        const customRegistryLayer = makeGatePluginRegistryLayer([
          ...DEFAULT_GATE_PLUGINS,
          customPlugin,
        ])
        const memoryFsLayer = makeWorkspaceFsMemoryLayer({
          "src/plugins/plugin-void.ts":
            "export const f = Effect.fn('f')(function* () { yield* Effect.void })\n",
          "src/plugins/plugin-bar.ts": "export const bar = 123\n",
        })
        const customAppLayer = Layer.mergeAll(customRegistryLayer, memoryFsLayer)

        const { result: report, spans } = yield* runWithTestTracer(
          testId,
          evaluateAllGatePlugins({
            filePaths: [
              WorkspaceFilePath.make("src/plugins/plugin-void.ts"),
              WorkspaceFilePath.make("src/plugins/plugin-bar.ts"),
            ],
            failOnViolation: false,
          }).pipe(Effect.provide(customAppLayer)),
          emptyFnIndex,
        )

        expect(report.verdict).toBe("violated")
        expect(report.violations).toHaveLength(2)
        const messages = report.violations.map((v) => v.message)
        expect(messages.some((m) => m.includes("Dummy 'yield* Effect.void'"))).toBe(true)
        expect(messages.some((m) => m.includes("Custom plugin detected 'bar'"))).toBe(true)

        const budgetViolations = checkSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(budgetViolations).toHaveLength(0)
      }),
  )

  // ---------------------------------------------------------------------------
  // 3 · AST Cache Rule Verification
  // ---------------------------------------------------------------------------

  it.effect(
    "AstGateCache: HARNESS_GATE_RULE_VERSION is ast-gates-v2 and bans dummy void and switch in harness files",
    () =>
      Effect.sync(() => {
        expect(HARNESS_GATE_RULE_VERSION).toBe("ast-gates-v2")

        const report = AstGateCache.evaluateFiles({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/dummy-test.ts"),
              content: AstSourceContent.make(
                "export const f = Effect.fn('f')(function* () { yield* Effect.void })\n" +
                  "export const g = (x: number): number => { switch (x) { case 1: return 1; default: return 0; } }\n",
              ),
            },
          ],
        })

        expect(report.verdict).toBe("violated")
        const rules = report.violations.map((v) => v.rule)
        expect(rules).toContain("effect-fn-dummy-void")
        expect(rules).toContain("discriminant-branching")
      }),
  )
})
