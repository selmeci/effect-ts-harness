import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"
import { NonNegativeCount } from "@harness/graph"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import { checkSpanBudgets, type SpanSample } from "../src/span-budget.js"
import {
  ActiveMutantId,
  MaxPluginFileLines,
  PluginFileLineCount,
  PluginId,
  type SelfDogfoodingInput,
  SelfDogfoodingMessage,
  SelfDogfoodingRuleId,
  type SelfDogfoodingViolation,
  SubprocessArg,
  SubprocessCommand,
  SubprocessExitCode,
  SubprocessMaxBufferBytes,
  SubprocessOutput,
  WorkspaceFileContent,
  WorkspaceFilePath,
  WorkspaceFsOperation,
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
  WorkspaceFs,
  WorkspaceFsLive,
} from "../src/services/workspace-fs.js"
import {
  execCheckedSubprocess,
  HarnessSubprocessRunner,
  HarnessSubprocessRunnerLive,
  makeHarnessSubprocessRunnerTestLayer,
} from "../src/services/subprocess-runner.js"
import {
  ActiveMutantContext,
  ActiveMutantContextLive,
  withActiveMutantEffect,
} from "../src/services/active-mutant-context.js"
import { getActiveMutantId } from "../src/mutation-check.js"
import {
  AstGateCache,
  AstSourceContent,
  AstSourceFilePath,
  EnclosingSymbolName,
  GateRuleVersion,
  GateVerdict,
  HARNESS_GATE_RULE_VERSION,
  SourceLineNumber,
} from "../src/ast-cache.js"
import { decideEarsSpecLint } from "../src/ears-lint.js"

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
          'import { Effect } from "effect"\nexport const cleanOp = Effect.fn("Clean.op")(function* (x: number) { return yield* Effect.succeed(x + 1) })\n',
          'import { Effect, Layer } from "effect"\nexport const cleanLayer = Layer.effect(Svc, Effect.gen(function* () { return { ok: true } }))\n',
          'import { match } from "ts-pattern"\nexport const cleanMatch = (tag: "A" | "B") => match(tag).with("A", () => 1).with("B", () => 2).exhaustive()\n',
          "export const add = (a: number, b: number): number => a + b\n",
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

        const testId = `SelfDogfooding.decide::prop::${moduleKind}-${fileIndex}`
        const { result: report, spans } = yield* runWithTestTracer(
          testId,
          decideSelfDogfooding(input),
          emptyFnIndex,
        )
        expect(report.verdict).toBe("clean")
        expect(report.violations).toHaveLength(0)
        expect(report.inspectedFileCount).toBe(1)

        const budgetViolations = checkSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(budgetViolations).toHaveLength(0)
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
              ? "export const g = Effect.gen(function* () { Effect.runPromise(Effect.succeed(42)) })\n"
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
              filePath: AstSourceFilePath.make("libs/harness/gates/src/plugins/clean-module.ts"),
              content: AstSourceContent.make("export const cleanValue = 1\n"),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/plugins/bad-module.ts"),
              content: AstSourceContent.make(content),
            },
          ],
          maxPluginFileLines: maxLines,
          failOnViolation: true,
        }

        const err = yield* Effect.flip(SelfDogfooding.decide(input))
        expect(err._tag).toBe("SelfDogfoodingViolationError")
        expect(err.violations.length).toBeGreaterThan(0)
        const rules = err.violations.map((v) => v.rule)
        expect(rules).toContain(violationType)
      }),
  )

  it.effect(
    "REQ-1.1/REQ-1.2 boundary: maxPluginFileLines on SelfDogfooding.decide (limit - 1, limit, limit + 1)",
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
    "WorkspaceFs: building two layers from the same makeWorkspaceFsMemoryLayer does not share mutations",
    () =>
      Effect.gen(function* () {
        const memoryLayer = makeWorkspaceFsMemoryLayer({
          "file.txt": "initial",
        })

        const fs1 = yield* Effect.provide(WorkspaceFs, memoryLayer)
        yield* fs1.writeTextFileAtomic(
          WorkspaceFilePath.make("file.txt"),
          WorkspaceFileContent.make("mutated-in-fs1"),
        )
        const read1 = yield* fs1.readTextFile(WorkspaceFilePath.make("file.txt"))
        expect(read1).toBe("mutated-in-fs1")

        const fs2 = yield* Effect.provide(WorkspaceFs, memoryLayer)
        const read2 = yield* fs2.readTextFile(WorkspaceFilePath.make("file.txt"))
        expect(read2).toBe("initial")
      }),
  )

  it.effect(
    "WorkspaceFsLive: real I/O operations (atomic write, read, exists, missing-file error)",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-ws-fs-"))
        try {
          const testFile = WorkspaceFilePath.make(join(tmpDir, "sub", "test.txt"))
          const fs = yield* WorkspaceFs

          expect(yield* fs.exists(testFile)).toBe(false)

          yield* fs.writeTextFileAtomic(testFile, WorkspaceFileContent.make("hello atomic world"))
          expect(yield* fs.exists(testFile)).toBe(true)

          const content = yield* fs.readTextFile(testFile)
          expect(content).toBe("hello atomic world")

          const missingFile = WorkspaceFilePath.make(join(tmpDir, "non-existent.txt"))
          const missingExit = yield* Effect.exit(fs.readTextFile(missingFile))
          expect(Exit.isFailure(missingExit)).toBe(true)
          if (Exit.isFailure(missingExit)) {
            const errOpt = Cause.findErrorOption(missingExit.cause)
            expect(Option.isSome(errOpt)).toBe(true)
            if (Option.isSome(errOpt)) {
              expect(errOpt.value._tag).toBe("WorkspaceFsError")
              expect(errOpt.value.operation).toBe("read")
            }
          }
        } finally {
          rmSync(tmpDir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(WorkspaceFsLive)),
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
    "REQ-2.4: HarnessSubprocess.execChecked fails with HarnessSubprocessError on non-zero exit or null bytes",
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

        // SubprocessCommand Schema rejection for empty and whitespace-only
        expect(Schema.is(SubprocessCommand)("   ")).toBe(false)
        expect(Schema.is(SubprocessCommand)("")).toBe(false)

        // execCheckedSubprocess null-byte in command rejection
        const { result: exitNullCmd, spans: spansNullCmd } = yield* runWithTestTracer(
          "HarnessSubprocess.execChecked::null-byte-command",
          Effect.exit(
            execCheckedSubprocess({
              command: SubprocessCommand.make("echo\0null"),
              args: [],
            }).pipe(Effect.provide(testLayer)),
          ),
          emptyFnIndex,
        )
        expect(Exit.isFailure(exitNullCmd)).toBe(true)
        if (Exit.isFailure(exitNullCmd)) {
          const errOpt = Cause.findErrorOption(exitNullCmd.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("HarnessSubprocessError")
            expect(errOpt.value.reason).toBe("Subprocess command contains null bytes")
          }
        }
        expect(
          checkSpanBudgets({ spans: toSpanSamples(spansNullCmd), maxRepeatedChildCalls: 3 }),
        ).toHaveLength(0)

        // execCheckedSubprocess null-byte in args rejection
        const { result: exitNullArg, spans: spansNullArg } = yield* runWithTestTracer(
          "HarnessSubprocess.execChecked::null-byte-arg",
          Effect.exit(
            execCheckedSubprocess({
              command: SubprocessCommand.make("echo"),
              args: [SubprocessArg.make("hello\0world")],
            }).pipe(Effect.provide(testLayer)),
          ),
          emptyFnIndex,
        )
        expect(Exit.isFailure(exitNullArg)).toBe(true)
        if (Exit.isFailure(exitNullArg)) {
          const errOpt = Cause.findErrorOption(exitNullArg.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("HarnessSubprocessError")
            expect(errOpt.value.reason).toBe("Subprocess arguments contain null bytes")
          }
        }
        expect(
          checkSpanBudgets({ spans: toSpanSamples(spansNullArg), maxRepeatedChildCalls: 3 }),
        ).toHaveLength(0)
      }),
  )

  it.effect(
    "HarnessSubprocessRunnerLive: real process execution (stdout, non-zero exit, ENOENT, null-byte rejection)",
    () =>
      Effect.gen(function* () {
        const runner = yield* HarnessSubprocessRunner

        // Happy path
        const success = yield* runner.exec({
          command: SubprocessCommand.make(process.execPath),
          args: [SubprocessArg.make("-e"), SubprocessArg.make("process.stdout.write('ok')")],
        })
        expect(success.exitCode).toBe(0)
        expect(success.stdout).toBe("ok")

        // Also call execCheckedSubprocess provided with HarnessSubprocessRunnerLive via runWithTestTracer
        const { result: checkedLive, spans: checkedSpans } = yield* runWithTestTracer(
          "HarnessSubprocess.execChecked::live-runner",
          execCheckedSubprocess({
            command: SubprocessCommand.make(process.execPath),
            args: [
              SubprocessArg.make("-e"),
              SubprocessArg.make("process.stdout.write('checked-live-ok')"),
            ],
          }),
          emptyFnIndex,
        )
        expect(checkedLive.exitCode).toBe(0)
        expect(checkedLive.stdout).toBe("checked-live-ok")
        const checkedViolations = checkSpanBudgets({
          spans: toSpanSamples(checkedSpans),
          maxRepeatedChildCalls: 3,
        })
        expect(checkedViolations).toHaveLength(0)

        // Non-zero exit code
        const nonZero = yield* runner.exec({
          command: SubprocessCommand.make(process.execPath),
          args: [
            SubprocessArg.make("-e"),
            SubprocessArg.make("process.stderr.write('bad'); process.exit(3)"),
          ],
        })
        expect(nonZero.exitCode).toBe(3)
        expect(nonZero.stderr).toBe("bad")

        // Missing binary (spawn ENOENT)
        const enoentExit = yield* Effect.exit(
          runner.exec({
            command: SubprocessCommand.make("non-existent-binary-xyz-123"),
            args: [],
          }),
        )
        expect(Exit.isFailure(enoentExit)).toBe(true)
        if (Exit.isFailure(enoentExit)) {
          const errOpt = Cause.findErrorOption(enoentExit.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("HarnessSubprocessError")
            expect(errOpt.value.reason).toContain("failed to spawn")
          }
        }

        // Null-byte rejection in command
        const nullCmdExit = yield* Effect.exit(
          runner.exec({
            command: SubprocessCommand.make("echo\0null"),
            args: [],
          }),
        )
        expect(Exit.isFailure(nullCmdExit)).toBe(true)
        if (Exit.isFailure(nullCmdExit)) {
          const errOpt = Cause.findErrorOption(nullCmdExit.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("HarnessSubprocessError")
            expect(errOpt.value.reason).toBe("Subprocess command contains null bytes")
          }
        }
      }).pipe(Effect.provide(HarnessSubprocessRunnerLive)),
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

        let observedInsideFailure: string | null = null
        const { result: failExit, spans: failSpans } = yield* runWithTestTracer(
          "MutationCheck.withActiveMutant::callback-defect",
          Effect.exit(
            withActiveMutantEffect(ActiveMutantId.make("mutant-fail-99"), () => {
              observedInsideFailure = getActiveMutantId() ?? null
              throw new Error("boom")
            }).pipe(Effect.provide(ActiveMutantContextLive)),
          ),
          emptyFnIndex,
        )
        expect(Exit.isFailure(failExit)).toBe(true)
        expect(observedInsideFailure).toBe("mutant-fail-99")
        if (Exit.isFailure(failExit)) {
          expect(Cause.hasDies(failExit.cause)).toBe(true)
          expect(Cause.pretty(failExit.cause)).toContain("boom")
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
    "ActiveMutantContext: nested runWithMutant calls do not deadlock and restore outer mutant ID",
    () =>
      Effect.gen(function* () {
        const ctx = yield* ActiveMutantContext
        const outerId = ActiveMutantId.make("mutant-outer")
        const innerId = ActiveMutantId.make("mutant-inner")

        let observedOuterBefore: string | null = null
        let observedInner: string | null = null
        let observedOuterAfter: string | null = null

        yield* ctx.runWithMutant(
          outerId,
          Effect.gen(function* () {
            observedOuterBefore = getActiveMutantId() ?? null
            yield* ctx.runWithMutant(
              innerId,
              Effect.sync(() => {
                observedInner = getActiveMutantId() ?? null
              }),
            )
            observedOuterAfter = getActiveMutantId() ?? null
          }),
        )

        expect(observedOuterBefore).toBe("mutant-outer")
        expect(observedInner).toBe("mutant-inner")
        expect(observedOuterAfter).toBe("mutant-outer")
        expect(getActiveMutantId()).toBeUndefined()
      }).pipe(Effect.provide(ActiveMutantContextLive)),
  )

  it.effect(
    "ActiveMutantContext: fiber interruption restores state and global active mutant",
    () =>
      Effect.gen(function* () {
        const ctx = yield* ActiveMutantContext
        const mutantId = ActiveMutantId.make("mutant-interrupted")
        const started = yield* Deferred.make<void>()

        const fiber = yield* ctx
          .runWithMutant(
            mutantId,
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(started)
        expect(getActiveMutantId()).toBe("mutant-interrupted")
        yield* Fiber.interrupt(fiber)

        const current = yield* ctx.getCurrentMutant
        expect(current).toEqual(Option.none())
        expect(getActiveMutantId()).toBeUndefined()
      }).pipe(Effect.provide(ActiveMutantContextLive)),
  )

  it.effect(
    "REQ-2.5 concurrency: Effect.all concurrent runWithMutant calls serialize without interleaving",
    () =>
      Effect.gen(function* () {
        const ctx = yield* ActiveMutantContext
        const m1 = ActiveMutantId.make("mutant-concurrent-1")
        const m2 = ActiveMutantId.make("mutant-concurrent-2")

        const executionLog: Array<string> = []

        const task1 = ctx.runWithMutant(
          m1,
          Effect.gen(function* () {
            executionLog.push("start-1")
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            expect(getActiveMutantId()).toBe("mutant-concurrent-1")
            executionLog.push("end-1")
          }),
        )

        const task2 = ctx.runWithMutant(
          m2,
          Effect.gen(function* () {
            executionLog.push("start-2")
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            expect(getActiveMutantId()).toBe("mutant-concurrent-2")
            executionLog.push("end-2")
          }),
        )

        yield* Effect.all([task1, task2], { concurrency: 2 })

        const isOneThenTwo =
          executionLog[0] === "start-1" &&
          executionLog[1] === "end-1" &&
          executionLog[2] === "start-2" &&
          executionLog[3] === "end-2"
        const isTwoThenOne =
          executionLog[0] === "start-2" &&
          executionLog[1] === "end-2" &&
          executionLog[2] === "start-1" &&
          executionLog[3] === "end-1"

        expect(isOneThenTwo || isTwoThenOne).toBe(true)
        expect(getActiveMutantId()).toBeUndefined()
      }).pipe(Effect.provide(ActiveMutantContextLive)),
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

  it("GatePluginRegistry: duplicate plugin ID rejection in makeGatePluginRegistryLayer", () => {
    const dupPlugin1: GatePluginDescriptor = {
      pluginId: PluginId.make("dup-id"),
      description: "Plugin 1",
      evaluate: () =>
        Effect.succeed({
          verdict: GateVerdict.make("clean"),
          violations: [],
          inspectedFileCount: NonNegativeCount.make(0),
        }),
    }
    const dupPlugin2: GatePluginDescriptor = {
      pluginId: PluginId.make("dup-id"),
      description: "Plugin 2",
      evaluate: () =>
        Effect.succeed({
          verdict: GateVerdict.make("clean"),
          violations: [],
          inspectedFileCount: NonNegativeCount.make(0),
        }),
    }

    expect(() => makeGatePluginRegistryLayer([dupPlugin1, dupPlugin2])).toThrow(
      "Duplicate gate plugin ID registered: dup-id",
    )
  })

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

        const failErr = yield* Effect.flip(
          evaluateAllGatePlugins({
            filePaths: [
              WorkspaceFilePath.make("src/plugins/plugin-void.ts"),
              WorkspaceFilePath.make("src/plugins/plugin-bar.ts"),
            ],
            failOnViolation: true,
          }).pipe(Effect.provide(customAppLayer)),
        )
        expect(failErr._tag).toBe("SelfDogfoodingViolationError")
        if (failErr._tag === "SelfDogfoodingViolationError") {
          expect(failErr.violations).toHaveLength(2)
        }

        const budgetViolations = checkSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(budgetViolations).toHaveLength(0)
      }),
  )

  // ---------------------------------------------------------------------------
  // 3 · AST Cache Rule Verification & EARS Lint
  // ---------------------------------------------------------------------------

  it.effect(
    "REQ-1.3: AstGateCache.decide reports effect-fn-dummy-void, discriminant-branching, and non-exhaustive-union-match without isHarnessInternal exemption",
    () =>
      Effect.gen(function* () {
        expect(HARNESS_GATE_RULE_VERSION).toBe("ast-gates-v2")

        const testId = "AstGateCache.decide::REQ-1.3"
        const { result: report, spans } = yield* runWithTestTracer(
          testId,
          AstGateCache.decide({
            files: [
              {
                filePath: AstSourceFilePath.make("libs/harness/gates/src/dummy-test.ts"),
                content: AstSourceContent.make(
                  "export const f = Effect.fn('f')(function* () { yield* Effect.void })\n" +
                    "export const g = (x: number): number => { switch (x) { case 1: return 1; default: return 0; } }\n" +
                    "export const h = (x: number): number => match(x).with(1, () => 1).run()\n",
                ),
              },
            ],
          }),
          emptyFnIndex,
        )

        expect(report.verdict).toBe("violated")
        const rules = report.violations.map((v) => v.rule)
        expect(rules).toContain("effect-fn-dummy-void")
        expect(rules).toContain("discriminant-branching")
        expect(rules).toContain("non-exhaustive-union-match")

        const budgetViolations = checkSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(budgetViolations).toHaveLength(0)
      }),
  )

  it.effect("AstGateCache: ruleVersion cache invalidation on disk", () =>
    Effect.sync(() => {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-ast-cache-"))
      try {
        const cachePath = AstSourceFilePath.make(join(tmpDir, "cache.json"))
        const filePath = AstSourceFilePath.make("libs/harness/gates/src/test-file.ts")
        const content = AstSourceContent.make("export const x = 1\n")

        const v1Report = AstGateCache.evaluateFiles({
          files: [{ filePath, content }],
          ruleVersion: GateRuleVersion.make("rule-v1"),
          cacheFilePath: cachePath,
        })
        expect(v1Report.parsedFileCount).toBe(1)
        expect(v1Report.cacheHitCount).toBe(0)

        const v1HitReport = AstGateCache.evaluateFiles({
          files: [{ filePath, content }],
          ruleVersion: GateRuleVersion.make("rule-v1"),
          cacheFilePath: cachePath,
        })
        expect(v1HitReport.cacheHitCount).toBe(1)

        const v2Report = AstGateCache.evaluateFiles({
          files: [{ filePath, content }],
          ruleVersion: GateRuleVersion.make("rule-v2"),
          cacheFilePath: cachePath,
        })
        expect(v2Report.cacheHitCount).toBe(0)
      } finally {
        AstGateCache.clear()
        rmSync(tmpDir, { recursive: true, force: true })
      }
    }),
  )

  it.effect(
    "EARS Lint: supports Complex pattern keyword validation and includes Complex in unknown pattern error",
    () =>
      Effect.gen(function* () {
        const validComplexDoc = [
          "| ID | Pattern | Requirement | Verification |",
          "|:---|:---|:---|:---|",
          "| SPEC-01 | Complex | When event occurs and while state is active the system shall respond. | Test |",
        ].join("\n")

        const validReport = yield* decideEarsSpecLint({
          docPath: "docs/spec.md",
          markdown: validComplexDoc,
        })
        const complexFindings = validReport.findings.filter(
          (f) => f.kind === "pattern-keyword-mismatch",
        )
        expect(complexFindings).toHaveLength(0)

        const invalidComplexDoc = [
          "| ID | Pattern | Requirement | Verification |",
          "|:---|:---|:---|:---|",
          "| SPEC-02 | Complex | The system shall respond unconditionally. | Test |",
        ].join("\n")

        const invalidReport = yield* decideEarsSpecLint({
          docPath: "docs/spec.md",
          markdown: invalidComplexDoc,
        })
        expect(
          invalidReport.findings.some(
            (f) =>
              f.kind === "pattern-keyword-mismatch" &&
              f.message.includes("declared as Complex but does not contain conditional keyword"),
          ),
        ).toBe(true)

        const unknownPatternDoc = [
          "| ID | Pattern | Requirement | Verification |",
          "|:---|:---|:---|:---|",
          "| SPEC-03 | CustomPattern | The system shall do something. | Test |",
        ].join("\n")

        const unknownReport = yield* decideEarsSpecLint({
          docPath: "docs/spec.md",
          markdown: unknownPatternDoc,
        })
        const unknownFinding = unknownReport.findings.find(
          (f) => f.kind === "pattern-keyword-mismatch",
        )
        expect(unknownFinding).toMatchObject({
          kind: "pattern-keyword-mismatch",
        })
        expect(unknownFinding!.message).toContain(
          "Allowed: Ubiquitous, Event-driven, State-driven, Unwanted behaviour, Optional feature, Complex.",
        )

        // Contract schema negative decode matrix & test file skip & parenthesized double cast
        expect(Schema.is(MaxPluginFileLines)(0)).toBe(false)
        expect(Schema.is(MaxPluginFileLines)(-1)).toBe(false)
        expect(Schema.is(MaxPluginFileLines)(10.5)).toBe(false)
        expect(Schema.is(MaxPluginFileLines)("10")).toBe(false)
        expect(Schema.is(PluginFileLineCount)(-1)).toBe(false)
        expect(Schema.is(PluginFileLineCount)(1.5)).toBe(false)
        expect(Schema.is(SubprocessMaxBufferBytes)(1023)).toBe(false)
        expect(Schema.is(WorkspaceFsOperation)("delete")).toBe(false)
        expect(Schema.is(PluginId)("")).toBe(false)
        expect(Schema.is(PluginId)("   ")).toBe(false)
        expect(Schema.is(ActiveMutantId)("")).toBe(false)
        expect(Schema.is(WorkspaceFilePath)("")).toBe(false)

        const skippedTestReport = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/test/foo.test.ts"),
              content: AstSourceContent.make(
                "export const f = Effect.fn('f')(function* () { yield* Effect.void })\n",
              ),
            },
          ],
          failOnViolation: true,
        })
        expect(skippedTestReport.verdict).toBe("clean")
        expect(skippedTestReport.inspectedFileCount).toBe(0)

        const parenDoubleCastReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/src/double-cast.ts"),
              content: AstSourceContent.make("export const x = ((1 as unknown) as string)\n"),
            },
          ],
        })
        expect(parenDoubleCastReport.violations.map((v) => v.rule)).toContain("unsafe-type-cast")
      }),
  )

  it.effect(
    "RFC-0007 Step 2: every source file in libs/harness/gates/src/**/*.ts is <= 800 lines and passes SelfDogfooding.decide",
    () =>
      Effect.gen(function* () {
        const testDir = dirname(fileURLToPath(import.meta.url))
        const repoRoot = resolve(testDir, "../../../..")
        const gatesSrcRoot = join(repoRoot, "libs", "harness", "gates", "src")

        const collectTsFiles = (dir: string): Array<string> => {
          const results: Array<string> = []
          for (const entry of readdirSync(dir)) {
            const fullPath = join(dir, entry)
            const st = statSync(fullPath)
            if (st.isDirectory()) {
              results.push(...collectTsFiles(fullPath))
            } else if (
              entry.endsWith(".ts") &&
              !entry.endsWith(".test.ts") &&
              !entry.endsWith(".spec.ts")
            ) {
              results.push(fullPath)
            }
          }
          return results
        }

        const sourceFiles = collectTsFiles(gatesSrcRoot)
        expect(sourceFiles.length).toBeGreaterThanOrEqual(30)

        const fileInputs = sourceFiles.map((absPath) => {
          const relPath = relative(repoRoot, absPath).replace(/\\/g, "/")
          const content = readFileSync(absPath, "utf-8")
          const lineCount = content.split(/\r?\n/).length
          expect(
            lineCount,
            `${relPath} has ${lineCount} lines, exceeding 800-line ceiling`,
          ).toBeLessThanOrEqual(800)

          if (relPath === "libs/harness/gates/src/gc-check.ts") {
            expect(lineCount).toBeLessThan(200)
          }
          if (relPath.startsWith("libs/harness/gates/src/plugins/gc/")) {
            expect(lineCount).toBeLessThanOrEqual(450)
          }
          if (relPath === "libs/harness/gates/src/mutation/mutant-ast-generator.ts") {
            expect(lineCount).toBeLessThanOrEqual(500)
          }
          if (relPath === "libs/harness/gates/src/mutation-check.ts") {
            expect(lineCount).toBeLessThanOrEqual(550)
          }
          if (
            relPath === "libs/harness/gates/src/plugins/ast-gate-visitors.ts" ||
            relPath === "libs/harness/gates/src/ast-cache.ts"
          ) {
            expect(lineCount).toBeLessThanOrEqual(450)
          }

          return {
            filePath: AstSourceFilePath.make(relPath),
            content: AstSourceContent.make(content),
          }
        })

        const report = yield* decideSelfDogfooding({
          files: fileInputs,
          maxPluginFileLines: MaxPluginFileLines.make(800),
          failOnViolation: true,
        })

        expect(report.verdict).toBe("clean")
        expect(report.violations).toHaveLength(0)
        expect(report.inspectedFileCount).toBe(sourceFiles.length)
      }),
  )
})
