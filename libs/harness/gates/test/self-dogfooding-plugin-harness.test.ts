import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"
import { buildHarnessGraph, NonNegativeCount, ts } from "@harness/graph"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import { decideSpanBudgets, type SpanSample } from "../src/span-budget.js"
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
import {
  decideSelfDogfooding,
  isGraphOrchestratorFacadePath,
  isModularPluginPath,
  resolvePathSpecificMaxLines,
  SelfDogfooding,
} from "../src/plugins/self-dogfooding-plugin.js"
import {
  DEFAULT_GATE_PLUGINS,
  evaluateAllGatePlugins,
  type GatePluginDescriptor,
  GatePluginRegistryLive,
  makeGatePluginRegistryLayer,
} from "../src/plugins/gate-plugin-registry.js"
import {
  makeWorkspaceFsHostIoLayer,
  makeWorkspaceFsMemoryLayer,
  readAndVerifyWorkspaceFile,
  WorkspaceFs,
} from "../src/services/workspace-fs.js"
import {
  execCheckedSubprocess,
  HarnessSubprocessRunner,
  makeHarnessSubprocessRunnerHostIoLayer,
  makeHarnessSubprocessRunnerTestLayer,
} from "../src/services/subprocess-runner.js"
import { testHostIo } from "./helpers/test-host-io.js"
import {
  ActiveMutantContext,
  ActiveMutantContextLive,
  withActiveMutantEffect,
} from "../src/services/active-mutant-context.js"
import {
  decideMutationCheck,
  discoverDomainMutants,
  evaluateMutantSchemaInProcess,
  getActiveMutantId,
} from "../src/mutation-check.js"
import { MUTATION_PATTERNS } from "../src/mutation/mutant-ast-generator.js"
import {
  AstGateCache,
  type AstGateCacheEntry,
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  EnclosingSymbolName,
  GateRuleVersion,
  GateVerdict,
  HARNESS_GATE_RULE_VERSION,
  isRepoWideAstRule,
  MAX_GATE_CACHE_SIZE,
  SourceLineNumber,
  visitSourceFileSinglePass,
} from "../src/ast-cache.js"
import { decideEarsSpecLint } from "../src/ears-lint.js"
import {
  collectModularPluginFiles,
  decideGraphEntropy,
  extractBalancedBraces,
  extractBalancedParens,
  extractTopLevelObjectAnalysis,
  findClosestMatch,
  GcFinding,
  GcFindingKind,
  levenshteinDistance,
} from "../src/gc-check.js"

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

        const budgetViolations = yield* decideSpanBudgets({
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
        "facade-star-reexport",
        "file-line-budget-exceeded",
      ]),
      variation: Schema.Boolean,
    },
    ({ violationType, variation }) =>
      Effect.gen(function* () {
        const { content, maxLines, targetFile } = match(violationType)
          .with("effect-fn-dummy-void", () => ({
            content: variation
              ? "export const f = Effect.fn('test')(function* () { yield* (Effect.void) })\n"
              : "export const f = Effect.fn('test')(function* () { yield* Effect.void })\n",
            maxLines: MaxPluginFileLines.make(800),
            targetFile: "libs/harness/gates/src/plugins/bad-module.ts",
          }))
          .with("nested-effect-run-sync", () => ({
            content: variation
              ? "export const g = Effect.gen(function* () { Effect.runPromise(Effect.succeed(42)) })\n"
              : "export const g = Effect.sync(() => { Effect.runSync(Effect.succeed(42)) })\n",
            maxLines: MaxPluginFileLines.make(800),
            targetFile: "libs/harness/gates/src/plugins/bad-module.ts",
          }))
          .with("harness-switch-statement", () => ({
            content:
              "export const h = (x: number): number => { switch (x) { case 1: return 1; default: return 0; } }\n",
            maxLines: MaxPluginFileLines.make(800),
            targetFile: "libs/harness/gates/src/plugins/bad-module.ts",
          }))
          .with("match-run-statement", () => ({
            content: variation
              ? "export const m = (x: number): number => (match(x).with(1, () => 1).run())\n"
              : "export const m = (x: number): number => match(x).with(1, () => 1).run()\n",
            maxLines: MaxPluginFileLines.make(800),
            targetFile: "libs/harness/gates/src/plugins/bad-module.ts",
          }))
          .with("facade-star-reexport", () => ({
            content: variation
              ? 'export * from "./extractor/compiler-session.js"\n'
              : 'export * from "./datalog/fact-store.js"\n',
            maxLines: MaxPluginFileLines.make(800),
            targetFile: "libs/harness/graph/src/type-extractor.ts",
          }))
          .with("file-line-budget-exceeded", () => ({
            content: "// line\n".repeat(20),
            maxLines: MaxPluginFileLines.make(10),
            targetFile: "libs/harness/gates/src/plugins/bad-module.ts",
          }))
          .exhaustive()

        const input: SelfDogfoodingInput = {
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/plugins/clean-module.ts"),
              content: AstSourceContent.make("export const cleanValue = 1\n"),
            },
            {
              filePath: AstSourceFilePath.make(targetFile),
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

  it.effect(
    "REQ-1.2: enforces decomposed line budget across libs/harness/graph/src/**/*.ts modules",
    () =>
      Effect.gen(function* () {
        const atLimitContent = Array.from({ length: 750 }, (_, i) => `export const g${i} = ${i}`).join("\n")
        const overLimitContent = Array.from({ length: 801 }, (_, i) => `export const g${i} = ${i}`).join("\n")
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/datalog/within-limit.ts"),
              content: AstSourceContent.make(atLimitContent),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/extractor/over-limit.ts"),
              content: AstSourceContent.make(overLimitContent),
              isModularPluginFile: false,
            },
          ],
          failOnViolation: false,
        })
        expect(report.verdict).toBe("violated")
        expect(report.violations).toHaveLength(1)
        expect(report.violations[0]?.rule).toBe("file-line-budget-exceeded")
        expect(report.violations[0]?.file).toBe("libs/harness/graph/src/extractor/over-limit.ts")
      }),
  )

  it.effect(
    "REQ-1.2: passing isModularPluginFile: false for isModularPluginPath targets across libs/ and apps/ still emits file-line-budget-exceeded",
    () =>
      Effect.gen(function* () {
        const over250Content = Array.from({ length: 251 }, (_, i) => `export const e${i} = ${i}`).join("\n")
        const over650Content = Array.from({ length: 651 }, (_, i) => `export const p${i} = ${i}`).join("\n")
        const over800Content = Array.from({ length: 801 }, (_, i) => `export const g${i} = ${i}`).join("\n")
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/type-extractor.ts"),
              content: AstSourceContent.make(over250Content),
              isModularPluginFile: false,
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/extractor/compiler-session.ts"),
              content: AstSourceContent.make(over800Content),
              isModularPluginFile: false,
            },
            {
              filePath: AstSourceFilePath.make("apps/harness-cli/src/index.ts"),
              content: AstSourceContent.make(over250Content),
              isModularPluginFile: false,
            },
            {
              filePath: AstSourceFilePath.make("libs/es/infra/src/projector.ts"),
              content: AstSourceContent.make(over650Content),
              isModularPluginFile: false,
            },
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/src/oversized-domain.ts"),
              content: AstSourceContent.make(over800Content),
              isModularPluginFile: false,
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
          failOnViolation: false,
        })
        expect(report.verdict).toBe("violated")
        expect(report.violations).toHaveLength(5)
        expect(report.violations.every((v) => v.rule === "file-line-budget-exceeded")).toBe(true)
        expect(report.violations.map((v) => v.file)).toEqual([
          "libs/harness/graph/src/type-extractor.ts",
          "libs/harness/graph/src/extractor/compiler-session.ts",
          "apps/harness-cli/src/index.ts",
          "libs/es/infra/src/projector.ts",
          "libs/sample/domain/src/oversized-domain.ts",
        ])
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

        const budgetViolations = yield* decideSpanBudgets({
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

        const budgetViolations = yield* decideSpanBudgets({
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
      }).pipe(Effect.provide(makeWorkspaceFsHostIoLayer(testHostIo))),
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

        const budgetViolations = yield* decideSpanBudgets({
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
          yield* decideSpanBudgets({ spans: toSpanSamples(spansNonZero), maxRepeatedChildCalls: 3 }),
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
          yield* decideSpanBudgets({ spans: toSpanSamples(spansNullCmd), maxRepeatedChildCalls: 3 }),
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
          yield* decideSpanBudgets({ spans: toSpanSamples(spansNullArg), maxRepeatedChildCalls: 3 }),
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
        const checkedViolations = yield* decideSpanBudgets({
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
      }).pipe(Effect.provide(makeHarnessSubprocessRunnerHostIoLayer(testHostIo))),
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

        const budgetViolations = yield* decideSpanBudgets({
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

        const failBudgetViolations = yield* decideSpanBudgets({
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

        const budgetViolations = yield* decideSpanBudgets({
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

        const missingBudgetViolations = yield* decideSpanBudgets({
          spans: toSpanSamples(missingSpans),
          maxRepeatedChildCalls: 3,
        })
        expect(missingBudgetViolations).toHaveLength(0)
      }),
  )

  it.effect("GatePluginRegistry: duplicate plugin ID rejection in makeGatePluginRegistryLayer", () =>
    Effect.gen(function* () {
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

      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(makeGatePluginRegistryLayer([dupPlugin1, dupPlugin2]))),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
      }
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

        const budgetViolations = yield* decideSpanBudgets({
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
        expect(HARNESS_GATE_RULE_VERSION).toBe("ast-gates-v4")

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

        const budgetViolations = yield* decideSpanBudgets({
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
        const cacheStore = new Map()

        const v1Report = AstGateCache.evaluateFiles(
          {
            files: [{ filePath, content }],
            ruleVersion: GateRuleVersion.make("rule-v1"),
            cacheFilePath: cachePath,
          },
          undefined,
          cacheStore,
        )
        expect(v1Report.parsedFileCount).toBe(1)
        expect(v1Report.cacheHitCount).toBe(0)

        const v1HitReport = AstGateCache.evaluateFiles(
          {
            files: [{ filePath, content }],
            ruleVersion: GateRuleVersion.make("rule-v1"),
            cacheFilePath: cachePath,
          },
          undefined,
          cacheStore,
        )
        expect(v1HitReport.cacheHitCount).toBe(1)

        const v2Report = AstGateCache.evaluateFiles(
          {
            files: [{ filePath, content }],
            ruleVersion: GateRuleVersion.make("rule-v2"),
            cacheFilePath: cachePath,
          },
          undefined,
          cacheStore,
        )
        expect(v2Report.cacheHitCount).toBe(0)
      } finally {
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
    "RFC-0007 Step 2: every source file in libs/harness/gates/src/**/*.ts is <= 800 lines, has zero circular imports, and passes SelfDogfooding.decide",
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

        const adj = new Map<string, Array<string>>()

        const fileInputs = sourceFiles.map((absPath) => {
          const relPath = relative(repoRoot, absPath).replace(/\\/g, "/")
          const content = readFileSync(absPath, "utf-8")
          const lineCount = content.split(/\r?\n/).length
          expect(
            lineCount,
            `${relPath} has ${lineCount} lines, exceeding 800-line SPEC-0011 ceiling`,
          ).toBeLessThanOrEqual(800)

          if (relPath === "libs/harness/gates/src/gc-check.ts") {
            expect(lineCount).toBeLessThan(200)
          }

          // Extract relative imports to enforce zero circular dependencies within @harness/gates
          const imports: Array<string> = []
          const importRe = /(?:import|export)\s+(?:type\s+)?(?:[^"']*from\s+)?["'](\.[^"']+)["']/g
          for (const m of content.matchAll(importRe)) {
            const spec = m[1]
            if (spec !== undefined) {
              const resolvedAbs = resolve(dirname(absPath), spec.replace(/\.js$/, ".ts"))
              const resolvedRel = relative(repoRoot, resolvedAbs).replace(/\\/g, "/")
              if (resolvedRel.startsWith("libs/harness/gates/src/")) {
                imports.push(resolvedRel)
              }
            }
          }
          adj.set(relPath, imports)

          return {
            filePath: AstSourceFilePath.make(relPath),
            content: AstSourceContent.make(content),
          }
        })

        // Detect any cycle in adj using DFS coloring (0 = unvisited, 1 = visiting, 2 = visited)
        const state = new Map<string, number>()
        const cycles: Array<string> = []
        const visit = (node: string, stack: Array<string>): void => {
          state.set(node, 1)
          for (const next of adj.get(node) ?? []) {
            const nextState = state.get(next) ?? 0
            if (nextState === 1) {
              const idx = stack.indexOf(next)
              cycles.push([...stack.slice(idx), next].join(" -> "))
            } else if (nextState === 0) {
              visit(next, [...stack, next])
            }
          }
          state.set(node, 2)
        }
        for (const node of adj.keys()) {
          if ((state.get(node) ?? 0) === 0) {
            visit(node, [node])
          }
        }
        expect(cycles, `Circular imports found in @harness/gates: ${cycles.join("; ")}`).toEqual([])

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

  it.effect(
    "RFC-0007 Step 3: every source file in libs/harness/graph/src/**/*.ts respects decomposed LOC budgets, has zero circular imports, and passes SelfDogfooding.decide",
    () =>
      Effect.gen(function* () {
        const testDir = dirname(fileURLToPath(import.meta.url))
        const repoRoot = resolve(testDir, "../../../..")
        const graphSrcRoot = join(repoRoot, "libs", "harness", "graph", "src")

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

        const sourceFiles = collectTsFiles(graphSrcRoot)
        expect(sourceFiles.length).toBeGreaterThanOrEqual(35)

        const orchestrators = new Set([
          "libs/harness/graph/src/type-extractor.ts",
          "libs/harness/graph/src/datalog-engine.ts",
          "libs/harness/graph/src/graph-rewrite.ts",
          "libs/harness/graph/src/graph-engine.ts",
          "libs/harness/graph/src/graph-projector.ts",
        ])

        const adj = new Map<string, Array<string>>()
        const fileInputs = sourceFiles.map((absPath) => {
          const relPath = relative(repoRoot, absPath).replace(/\\/g, "/")
          const content = readFileSync(absPath, "utf-8")
          const lineCount = content.split(/\r?\n/).length
          expect(
            lineCount,
            `${relPath} has ${lineCount} lines, exceeding 800-line ceiling`,
          ).toBeLessThanOrEqual(800)
          expect(
            lineCount,
            `${relPath} has ${lineCount} lines, exceeding 750-line RFC-0007 Step 3 budget`,
          ).toBeLessThanOrEqual(750)

          if (orchestrators.has(relPath)) {
            expect(lineCount, `${relPath} orchestrator exceeded 250 lines`).toBeLessThanOrEqual(250)
          } else if (relPath === "libs/harness/graph/src/extractor/compiler-session.ts") {
            expect(lineCount).toBeLessThanOrEqual(700)
          } else if (relPath.startsWith("libs/harness/graph/src/engine/")) {
            expect(lineCount, `${relPath} engine module exceeded 700 lines`).toBeLessThanOrEqual(700)
          } else if (relPath.startsWith("libs/harness/graph/src/extractor/")) {
            expect(lineCount, `${relPath} sub-extractor must be < 500 lines`).toBeLessThan(500)
          }

          const imports: Array<string> = []
          const importRe = /(?:import|export)\s+(?:type\s+)?(?:[^"']*from\s+)?["'](\.[^"']+)["']/g
          for (const m of content.matchAll(importRe)) {
            const spec = m[1]
            if (spec !== undefined) {
              const resolvedAbs = resolve(dirname(absPath), spec.replace(/\.js$/, ".ts"))
              const resolvedRel = relative(repoRoot, resolvedAbs).replace(/\\/g, "/")
              if (resolvedRel.startsWith("libs/harness/graph/src/")) {
                imports.push(resolvedRel)
              }
            }
          }
          adj.set(relPath, imports)

          return {
            filePath: AstSourceFilePath.make(relPath),
            content: AstSourceContent.make(content),
          }
        })

        const state = new Map<string, number>()
        const cycles: Array<string> = []
        const visit = (node: string, stack: Array<string>): void => {
          state.set(node, 1)
          for (const next of adj.get(node) ?? []) {
            const nextState = state.get(next) ?? 0
            if (nextState === 1) {
              const idx = stack.indexOf(next)
              cycles.push([...stack.slice(idx), next].join(" -> "))
            } else if (nextState === 0) {
              visit(next, [...stack, next])
            }
          }
          state.set(node, 2)
        }
        for (const node of adj.keys()) {
          if ((state.get(node) ?? 0) === 0) {
            visit(node, [node])
          }
        }
        expect(cycles, `Circular imports found in @harness/graph: ${cycles.join("; ")}`).toEqual([])

        // Verify all live @harness/graph source files pass SelfDogfooding.decide without violations (isModularPluginFile: false bypass protection is covered earlier via REQ-1.2)
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

  it.effect(
    "AstGateCache.decide table-driven rules: impure-domain-import, domain-effect-ignore, ast-grep-tsx-grammar, unscoped-effect-run, fallback-json-equality, and cache eviction",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<{
          readonly name: string
          readonly filePath: string
          readonly packageTag?: "app" | "contract" | "domain" | "infra" | "service" | "test"
          readonly content: string
          readonly expectedRule: string
        }> = [
          {
            name: "impure-domain-import in type:domain",
            filePath: "libs/sample/domain/src/impure.ts",
            packageTag: "domain",
            content: 'import { readFileSync } from "node:fs"\nexport const x = readFileSync("a")\n',
            expectedRule: "impure-domain-import",
          },
          {
            name: "domain-effect-ignore in type:domain",
            filePath: "libs/sample/domain/src/ignore.ts",
            packageTag: "domain",
            content: "export const f = () => Effect.ignore(Effect.succeed(1))\n",
            expectedRule: "domain-effect-ignore",
          },
          {
            name: "ast-grep-tsx-grammar for .tsx with parse(Lang.TypeScript, ...)",
            filePath: "libs/harness/gates/src/sample-tsx-check.ts",
            content:
              'export const p = (filePath: string, src: string) => filePath.endsWith(".tsx") ? parse(Lang.TypeScript, src) : null\n',
            expectedRule: "ast-grep-tsx-grammar",
          },
          {
            name: "unscoped-effect-run inside Effect.fn",
            filePath: "libs/sample/infra/src/nested-run.ts",
            packageTag: "infra",
            content:
              'export const bad = Effect.fn("bad")(function* () { return Effect.runSync(Effect.succeed(1)) })\n',
            expectedRule: "unscoped-effect-run",
          },
          {
            name: "fallback-json-equality via JSON.stringify comparison in test file",
            filePath: "libs/sample/domain/test/json-eq.test.ts",
            packageTag: "test",
            content:
              "export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)\n",
            expectedRule: "fallback-json-equality",
          },
        ]

        for (const tc of cases) {
          const report = yield* AstGateCache.decide({
            files: [
              {
                filePath: AstSourceFilePath.make(tc.filePath),
                content: AstSourceContent.make(tc.content),
                ...(tc.packageTag !== undefined
                  ? { packageTag: AstGatePackageTag.make(tc.packageTag) }
                  : {}),
              },
            ],
          })
          expect(
            report.violations.map((v) => v.rule),
            `Expected ${tc.expectedRule} for case '${tc.name}'`,
          ).toContain(tc.expectedRule)
        }

        // Verify local cacheStore & MAX_GATE_CACHE_SIZE export
        const cacheStore = new Map<string, AstGateCacheEntry>()
        expect(cacheStore.size).toBe(0)
        expect(MAX_GATE_CACHE_SIZE).toBe(1000)
        yield* AstGateCache.decide(
          {
            files: [
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/clean.ts"),
                content: AstSourceContent.make("export const cleanVal = 42\n"),
              },
            ],
          },
          cacheStore,
        )
        expect(cacheStore.size).toBe(1)
        cacheStore.clear()
        expect(cacheStore.size).toBe(0)
      }),
  )

  it.effect(
    "decideGraphEntropy: covers node-sqlite-in-infra filter, unparseable governance doc frontmatter, architecture-policy-violation, orphan-effect-fn schema, and gc-helpers parsers",
    () =>
      Effect.gen(function* () {
        // 1. Branching violations: only node-sqlite-in-infra is emitted by evaluateBranchingSqliteViolations
        const baseGraph = buildHarnessGraph({})
        const report = yield* decideGraphEntropy({
          graph: {
            ...baseGraph,
            branchingViolations: [
              {
                rule: "node-sqlite-in-infra",
                file: "libs/sample/infra/src/sqlite-bad.ts",
                line: 3,
                enclosingSymbol: "badImport",
                message: "Importing node:sqlite is banned in type:infra.",
              },
              {
                rule: "discriminant-branching",
                file: "libs/sample/domain/src/switch-bad.ts",
                line: 10,
                enclosingSymbol: "badSwitch",
                message: "Switch statement is banned.",
              },
            ],
          },
          governanceDocs: [
            {
              id: "harness:SPEC-BROKEN",
              docPath: "libs/harness/docs/specs/broken.md",
              status: "accepted",
              enforcedByFiles: [],
              referencedSpans: [],
              referencedServices: [],
              referencedErrors: [],
              markdown: "# Broken doc without YAML frontmatter\n",
            },
          ],
        })

        expect(report.clean).toBe(false)
        const kinds = report.findings.map((f) => f.kind)
        expect(kinds).toContain("node-sqlite-in-infra")
        expect(kinds).toContain("stale-doc-reference")
        expect(kinds).not.toContain("architecture-policy-violation")

        // 2. orphan-effect-fn is a valid GcFindingKind and decodes through GcFinding
        expect(Schema.is(GcFindingKind)("orphan-effect-fn")).toBe(true)
        expect(
          Schema.is(GcFinding)({
            kind: "orphan-effect-fn",
            nodeId: "fn:Sample.orphan",
            message: "Orphan Effect.fn span",
            action: "Wire or remove orphan span",
          }),
        ).toBe(true)

        // 3. Direct tests for gc-helpers parsers
        expect(levenshteinDistance("kitten", "sitting")).toBe(3)
        expect(findClosestMatch("UserServic", ["UserService", "OrderService"])).toBe("UserService")
        expect(extractBalancedBraces("const x = { a: { b: 1 } };", 10)).toEqual({
          body: " a: { b: 1 } ",
          endIndex: 24,
        })
        expect(extractBalancedParens("fn(a, (b + c))", 2)).toEqual({
          body: "a, (b + c)",
          endIndex: 13,
        })
        expect(extractTopLevelObjectAnalysis("a: 1, b: { nested: 2 }, ...rest")).toEqual({
          keys: ["a", "b"],
          spreads: ["rest"],
        })

        // 4. architecture-policy-violation emitted when workspaceRoot has modular plugin or circular-import violations
        const tmpWs = mkdtempSync(join(tmpdir(), "harness-gc-arch-"))
        const gatesSrc = join(tmpWs, "libs", "harness", "gates", "src")
        mkdirSync(gatesSrc, { recursive: true })
        writeFileSync(
          join(gatesSrc, "a.ts"),
          'import { b } from "./b.js"\nexport const a = Effect.fn("a")(function* () { yield* Effect.void; return b })\n',
        )
        writeFileSync(
          join(gatesSrc, "b.ts"),
          'import { a } from "./a.js"\nexport const b = 1\nexport const ref = a\n',
        )
        const wsReport = yield* decideGraphEntropy({
          graph: baseGraph,
          workspaceRoot: tmpWs,
          hostIo: testHostIo,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              rmSync(tmpWs, { recursive: true, force: true })
            }),
          ),
        )
        expect(wsReport.clean).toBe(false)
        const archFindings = wsReport.findings.filter((f) => f.kind === "architecture-policy-violation")
        expect(archFindings.some((f) => f.nodeId.includes("effect-fn-dummy-void"))).toBe(true)
        expect(archFindings.some((f) => f.nodeId.includes("circular-import"))).toBe(true)
      }),
  )

  it.effect(
    "evaluateMutantSchemaInProcess: kills mutant on AssertionError or false, and does not kill on non-assertion runtime defect",
    () =>
      Effect.sync(() => {
        const mutants = discoverDomainMutants(
          "libs/sample/domain/src/calc.ts",
          "export const isPositive = (n: number): boolean => n >= 0\n",
        )
        expect(mutants.length).toBeGreaterThan(0)
        expect(MUTATION_PATTERNS.length).toBeGreaterThanOrEqual(8)
        expect(typeof decideMutationCheck).toBe("function")

        // 1. Assertion failure (expect(1).toBe(2)) kills the mutant cleanly
        const killedByAssertion = evaluateMutantSchemaInProcess(mutants, [
          () => {
            expect(1).toBe(2)
          },
        ])
        expect(killedByAssertion.every((o) => o.status === "killed")).toBe(true)

        // 2. Returning false kills the mutant cleanly
        const killedByFalse = evaluateMutantSchemaInProcess(mutants, [() => false])
        expect(killedByFalse.every((o) => o.status === "killed")).toBe(true)

        // 3. Non-assertion runtime defect (SyntaxError from JSON.parse) does not count as killed
        const nonAssertionOutcomes = evaluateMutantSchemaInProcess(mutants, [
          () => {
            JSON.parse("{broken-json")
          },
        ])
        expect(nonAssertionOutcomes.every((o) => o.status === "survived")).toBe(true)
      }),
  )

  it.effect(
    "RFC-0007 Step 4: resolvePathSpecificMaxLines & isModularPluginPath enforce repo-wide tiered LOC budgets across libs/ and apps/",
    () =>
      Effect.sync(() => {
        expect(isGraphOrchestratorFacadePath("libs/harness/graph/src/type-extractor.ts")).toBe(true)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/type-extractor.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/datalog-engine.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/graph-rewrite.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/graph-engine.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/graph-projector.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("apps/harness-cli/src/index.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("apps/harness-mcp/src/server.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("apps/harness-cli/src/index.ts", 800)).toBe(250)
        expect(resolvePathSpecificMaxLines("apps/harness-mcp/src/server.ts", 800)).toBe(250)

        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/extractor/effect-fn-extractor.ts")).toBe(499)

        expect(resolvePathSpecificMaxLines("apps/harness-cli/src/commands/verify.ts")).toBe(650)
        expect(resolvePathSpecificMaxLines("apps/harness-mcp/src/tools/graph.ts")).toBe(650)
        expect(resolvePathSpecificMaxLines("apps/harness-mcp/src/daemon/worker.ts")).toBe(650)
        expect(resolvePathSpecificMaxLines("libs/es/infra/src/projector.ts")).toBe(650)
        expect(resolvePathSpecificMaxLines("libs/es/infra/src/memory.ts", 800)).toBe(650)

        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/extractor/compiler-session.ts")).toBe(700)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/engine/snapshot-codec.ts")).toBe(700)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/datalog/datalog-session.ts")).toBe(750)

        expect(resolvePathSpecificMaxLines("libs/harness/gates/src/plugins/sample.ts")).toBe(800)
        expect(resolvePathSpecificMaxLines("libs/sample/domain/src/index.ts")).toBe(800)
        expect(resolvePathSpecificMaxLines("apps/sample/alchemy.run.ts")).toBe(800)
        expect(resolvePathSpecificMaxLines("apps/sample-web/src/client.ts")).toBe(800)

        // Stricter explicit maxPluginFileLines still tightens tiered budgets
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/type-extractor.ts", 100)).toBe(100)
        expect(resolvePathSpecificMaxLines("apps/harness-cli/src/index.ts", 100)).toBe(100)

        // isModularPluginPath matches all production .ts/.tsx files under libs/ and apps/ and excludes test/d.ts/config/build dirs
        expect(isModularPluginPath("libs/sample/domain/src/index.ts")).toBe(true)
        expect(isModularPluginPath("libs/es/infra/src/projector.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-cli/src/index.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-cli/src/commands/verify.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-mcp/src/server.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-mcp/src/tools/graph.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-mcp/src/daemon/worker.ts")).toBe(true)
        expect(isModularPluginPath("apps/sample/alchemy.run.ts")).toBe(true)
        expect(isModularPluginPath("apps/sample-web/src/client.tsx")).toBe(true)

        expect(isModularPluginPath("libs/sample/domain/test/index.test.ts")).toBe(false)
        expect(isModularPluginPath("libs/harness/decision/src/cached-decision-model.spec.ts")).toBe(false)
        expect(isModularPluginPath("libs/sample/infra/src/global.d.ts")).toBe(false)
        expect(isModularPluginPath("libs/sample/infra/drizzle.config.ts")).toBe(false)
        expect(isModularPluginPath("apps/harness-cli/vitest.config.ts")).toBe(false)
        expect(isModularPluginPath("libs/es/core/test/fixtures/cart.ts")).toBe(false)
        expect(isModularPluginPath("libs/harness/gates/dist/index.ts")).toBe(false)
        expect(isModularPluginPath("libs/harness/gates/node_modules/pkg/index.ts")).toBe(false)
        expect(isModularPluginPath("libs/harness/gates/repos/effect/index.ts")).toBe(false)
        expect(isModularPluginPath("tools/oxlint/syntax-bans.js")).toBe(false)
      }),
  )

  it.effect(
    "Unit 1: facade-star-reexport flags export * from orchestrator facades while allowing named exports and index.ts export *",
    () =>
      Effect.gen(function* () {
        // 1. Violating: export * from in orchestrator facade
        const violatingReport = yield* decideSelfDogfooding({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/type-extractor.ts"),
              content: AstSourceContent.make('export * from "./extractor/compiler-session.js"\n'),
            },
          ],
        })
        expect(violatingReport.verdict).toBe("violated")
        expect(violatingReport.violations.some((v) => v.rule === "facade-star-reexport")).toBe(true)

        // 2. Allowed: export * from in index.ts
        const allowedIndexReport = yield* decideSelfDogfooding({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/index.ts"),
              content: AstSourceContent.make('export * from "./model.js"\n'),
            },
          ],
        })
        expect(allowedIndexReport.violations.filter((v) => v.rule === "facade-star-reexport")).toHaveLength(0)

        // 3. Allowed: explicit named export in orchestrator facade
        const allowedNamedReport = yield* decideSelfDogfooding({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/type-extractor.ts"),
              content: AstSourceContent.make(
                'export { createCompilerSession } from "./extractor/compiler-session.js"\n',
              ),
            },
          ],
        })
        expect(allowedNamedReport.violations.filter((v) => v.rule === "facade-star-reexport")).toHaveLength(0)
      }),
  )

  it.effect(
    "Unit 1: AstGateCache.decide flags catch-cause-interrupts-only (effect-laws) and unisolated-dot-harness-test-write (test-integrity)",
    () =>
      Effect.gen(function* () {
        // 1. catch-cause-interrupts-only in non-test file
        const catchCauseReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/infra/src/catch-cause.ts"),
              packageTag: AstGatePackageTag.make("infra"),
              content: AstSourceContent.make(
                'import { Cause, Effect } from "effect"\n' +
                  "export const op = Effect.catchCause(Effect.succeed(1), (cause) =>\n" +
                  "  Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.fail(cause),\n" +
                  ")\n",
              ),
            },
          ],
        })
        expect(catchCauseReport.verdict).toBe("violated")
        const catchCauseViolations = catchCauseReport.violations.filter(
          (v) => v.rule === "catch-cause-interrupts-only",
        )
        expect(catchCauseViolations).toHaveLength(1)
        expect(catchCauseViolations[0]?.category).toBe("effect-laws")

        // 1b. Cause.hasInterrupts(cause) inside catchCause is allowed
        const cleanCatchCauseReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/infra/src/catch-cause-clean.ts"),
              packageTag: AstGatePackageTag.make("infra"),
              content: AstSourceContent.make(
                'import { Cause, Effect } from "effect"\n' +
                  "export const op = Effect.catchCause(Effect.succeed(1), (cause) =>\n" +
                  "  Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(cause),\n" +
                  ")\n",
              ),
            },
          ],
        })
        expect(
          cleanCatchCauseReport.violations.filter((v) => v.rule === "catch-cause-interrupts-only"),
        ).toHaveLength(0)

        // 2. unisolated-dot-harness-test-write in test file
        const testWriteReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/test/leak.test.ts"),
              packageTag: AstGatePackageTag.make("test"),
              content: AstSourceContent.make(
                'import { saveGraphSnapshot } from "@harness/graph"\n' +
                  'export const t = () => saveGraphSnapshot({}, ".harness/graph-snapshot.json")\n',
              ),
            },
          ],
        })
        expect(testWriteReport.verdict).toBe("violated")
        const testWriteViolations = testWriteReport.violations.filter(
          (v) => v.rule === "unisolated-dot-harness-test-write",
        )
        expect(testWriteViolations).toHaveLength(1)
        expect(testWriteViolations[0]?.category).toBe("test-integrity")

        // 2b. writeFileSync directly to .harness/ in test file is flagged
        const fsWriteReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/test/fs-leak.test.ts"),
              packageTag: AstGatePackageTag.make("test"),
              content: AstSourceContent.make(
                'import fs from "node:fs"\n' +
                  'export const t = () => fs.writeFileSync(".harness/leak.json", "{}")\n',
              ),
            },
          ],
        })
        expect(
          fsWriteReport.violations.filter((v) => v.rule === "unisolated-dot-harness-test-write"),
        ).toHaveLength(1)

        // 2c. Writing to tmp directory in test file is allowed
        const cleanTestWriteReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/test/clean.test.ts"),
              packageTag: AstGatePackageTag.make("test"),
              content: AstSourceContent.make(
                'import { saveGraphSnapshot } from "@harness/graph"\n' +
                  "export const t = (tmpPath: string) => saveGraphSnapshot({}, tmpPath)\n",
              ),
            },
          ],
        })
        expect(
          cleanTestWriteReport.violations.filter((v) => v.rule === "unisolated-dot-harness-test-write"),
        ).toHaveLength(0)
      }),
  )

  it.effect(
    "RFC-0007 Step 4: every production .ts file in libs/ and apps/ respects tiered LOC budgets and passes SelfDogfooding.decide, harness-mcp has no zod, and syntax-bans has no isInternalHarnessFile",
    () =>
      Effect.gen(function* () {
        const testDir = dirname(fileURLToPath(import.meta.url))
        const repoRoot = resolve(testDir, "../../../..")

        const collectedAbsFiles = collectModularPluginFiles(repoRoot, testHostIo)
        const relFiles = collectedAbsFiles.map((abs) => relative(repoRoot, abs).replace(/\\/g, "/"))

        expect(relFiles.length).toBeGreaterThanOrEqual(100)
        expect(relFiles.some((f) => f.startsWith("libs/"))).toBe(true)
        expect(relFiles.some((f) => f.startsWith("apps/"))).toBe(true)
        expect(
          relFiles.some(
            (f) =>
              f.endsWith(".test.ts") ||
              f.endsWith(".spec.ts") ||
              f.endsWith(".d.ts") ||
              f.endsWith(".config.ts") ||
              f.includes("/test/") ||
              f.includes("/dist/") ||
              f.includes("/node_modules/") ||
              f.includes("/repos/"),
          ),
        ).toBe(false)

        const fileInputs = collectedAbsFiles.map((absPath, idx) => ({
          filePath: AstSourceFilePath.make(relFiles[idx]!),
          content: AstSourceContent.make(readFileSync(absPath, "utf8")),
        }))

        const report = yield* SelfDogfooding.decide({
          files: fileInputs,
          maxPluginFileLines: MaxPluginFileLines.make(800),
          failOnViolation: false,
        })

        expect(report.inspectedFileCount).toBe(fileInputs.length)
        expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([])
        expect(report.verdict).toBe("clean")

        const mcpPkgSchema = Schema.fromJsonString(
          Schema.Struct({
            dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
            devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          }),
        )
        const mcpPkg = yield* Schema.decodeEffect(mcpPkgSchema)(
          readFileSync(join(repoRoot, "apps", "harness-mcp", "package.json"), "utf8"),
        )
        expect(mcpPkg.dependencies?.zod).toBeUndefined()
        expect(mcpPkg.devDependencies?.zod).toBeUndefined()

        const syntaxBansSrc = readFileSync(join(repoRoot, "tools", "oxlint", "syntax-bans.js"), "utf8")
        expect(syntaxBansSrc).not.toMatch(/\bisInternalHarnessFile\b/)
      }),
  )

  it.effect(
    "RFC-0007 Step 4 edge cases: enforces tiered limits across .tsx & nested subdirs and fails on facade-star-reexport when failOnViolation is true",
    () =>
      Effect.gen(function* () {
        const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `export const x${i} = ${i}`).join("\n")
        const tieredReport = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("apps/harness-cli/src/commands/sub/ui.tsx"),
              content: AstSourceContent.make(makeLines(651)),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/extractor/nested/helper.ts"),
              content: AstSourceContent.make(makeLines(500)),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/engine/nested/solver.ts"),
              content: AstSourceContent.make(makeLines(701)),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
          failOnViolation: false,
        })
        expect(tieredReport.verdict).toBe("violated")
        expect(tieredReport.violations.map((v) => v.file)).toEqual([
          "apps/harness-cli/src/commands/sub/ui.tsx",
          "libs/harness/graph/src/extractor/nested/helper.ts",
          "libs/harness/graph/src/engine/nested/solver.ts",
        ])

        const starErr = yield* Effect.flip(
          SelfDogfooding.decide({
            files: [
              {
                filePath: AstSourceFilePath.make("libs/harness/graph/src/type-extractor.ts"),
                content: AstSourceContent.make('export * from "./extractor/compiler-session.js"\n'),
              },
            ],
            failOnViolation: true,
          }),
        )
        expect(starErr._tag).toBe("SelfDogfoodingViolationError")
        expect(starErr.violations.some((v) => v.rule === "facade-star-reexport")).toBe(true)
      }),
  )

  it.effect(
    "F-10: decideSelfDogfooding enforces exact tiered LOC boundaries (250/251, 499/500, 650/651, 800/801)",
    () =>
      Effect.gen(function* () {
        const makeLines = (n: number) =>
          Array.from({ length: n }, (_, i) => `export const b${i} = ${i}`).join("\n")

        const boundaryCases: ReadonlyArray<{
          readonly filePath: string
          readonly limit: number
        }> = [
          { filePath: "apps/harness-cli/src/index.ts", limit: 250 },
          { filePath: "libs/harness/graph/src/extractor/foo.ts", limit: 499 },
          { filePath: "apps/harness-cli/src/commands/foo.ts", limit: 650 },
          { filePath: "libs/sample/domain/src/foo.ts", limit: 800 },
        ]

        for (const { filePath, limit } of boundaryCases) {
          const atLimitReport = yield* decideSelfDogfooding({
            files: [
              {
                filePath: AstSourceFilePath.make(filePath),
                content: AstSourceContent.make(makeLines(limit)),
              },
            ],
            maxPluginFileLines: MaxPluginFileLines.make(800),
            failOnViolation: false,
          })
          expect(atLimitReport.verdict, `${filePath} at ${limit} lines`).toBe("clean")
          expect(atLimitReport.violations).toHaveLength(0)

          const overLimitReport = yield* decideSelfDogfooding({
            files: [
              {
                filePath: AstSourceFilePath.make(filePath),
                content: AstSourceContent.make(makeLines(limit + 1)),
              },
            ],
            maxPluginFileLines: MaxPluginFileLines.make(800),
            failOnViolation: false,
          })
          expect(overLimitReport.verdict, `${filePath} at ${limit + 1} lines`).toBe("violated")
          expect(overLimitReport.violations).toHaveLength(1)
          expect(overLimitReport.violations[0]?.rule).toBe("file-line-budget-exceeded")
          expect(overLimitReport.violations[0]?.file).toBe(filePath)
        }
      }),
  )

  it.effect(
    "F-10: visitSourceFileSinglePass flags unscoped-effect-run in sample infra testing.ts/memory.ts while exempting libs/es/infra/src/memory.ts",
    () =>
      Effect.sync(() => {
        const sourceText =
          'import { Effect } from "effect"\nexport const runIt = () => Effect.runPromise(Effect.succeed(1))\n'
        const infraTag = AstGatePackageTag.make("infra")

        const sampleTestingPath = "libs/sample/infra/src/testing.ts"
        const sampleTestingViolations = visitSourceFileSinglePass(
          ts.createSourceFile(sampleTestingPath, sourceText, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(sampleTestingPath),
          infraTag,
        )
        expect(sampleTestingViolations.some((v) => v.rule === "unscoped-effect-run")).toBe(true)

        const sampleMemoryPath = "libs/sample/infra/src/memory.ts"
        const sampleMemoryViolations = visitSourceFileSinglePass(
          ts.createSourceFile(sampleMemoryPath, sourceText, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(sampleMemoryPath),
          infraTag,
        )
        expect(sampleMemoryViolations.some((v) => v.rule === "unscoped-effect-run")).toBe(true)

        const esMemoryPath = "libs/es/infra/src/memory.ts"
        const esMemoryViolations = visitSourceFileSinglePass(
          ts.createSourceFile(esMemoryPath, sourceText, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(esMemoryPath),
          infraTag,
        )
        expect(esMemoryViolations.some((v) => v.rule === "unscoped-effect-run")).toBe(false)
      }),
  )

  it.effect(
    "REQ-1.3: visitSourceFileSinglePass flags catch-cause-interrupts-only, unisolated-dot-harness-test-write, and node-sqlite-in-infra on libs/harness/ paths without exemption",
    () =>
      Effect.sync(() => {
        const infraTag = AstGatePackageTag.make("infra")
        const domainTag = AstGatePackageTag.make("domain")
        const testTag = AstGatePackageTag.make("test")

        const interruptPath = "libs/harness/gates/src/sample-interrupt.ts"
        const interruptSrc =
          'import { Cause, Effect } from "effect"\nexport const bad = Effect.succeed(1).pipe(Effect.catchCause((c) => Cause.hasInterruptsOnly(c) ? Effect.fail("int") : Effect.fail("err")))\n'
        const interruptViolations = visitSourceFileSinglePass(
          ts.createSourceFile(interruptPath, interruptSrc, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(interruptPath),
          domainTag,
        )
        expect(interruptViolations.some((v) => v.rule === "catch-cause-interrupts-only")).toBe(true)

        const dotHarnessTestPath = "libs/harness/gates/test/unsafe-write.test.ts"
        const dotHarnessSrc =
          'import { writeFileSync } from "node:fs"\nexport const w = () => writeFileSync(".harness/verify-stamp.json", "{}")\n'
        const dotHarnessViolations = visitSourceFileSinglePass(
          ts.createSourceFile(dotHarnessTestPath, dotHarnessSrc, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(dotHarnessTestPath),
          testTag,
        )
        expect(
          dotHarnessViolations.some((v) => v.rule === "unisolated-dot-harness-test-write"),
        ).toBe(true)

        const nodeSqlitePath = "libs/harness/infra/src/bad-sqlite.ts"
        const nodeSqliteSrc = 'import { DatabaseSync } from "node:sqlite"\nexport const d = DatabaseSync\n'
        const nodeSqliteViolations = visitSourceFileSinglePass(
          ts.createSourceFile(nodeSqlitePath, nodeSqliteSrc, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(nodeSqlitePath),
          infraTag,
        )
        expect(nodeSqliteViolations.some((v) => v.rule === "node-sqlite-in-infra")).toBe(true)
      }),
  )

  it.effect(
    "AST hardening: silent-catch-defect, ignored-chmod-permission, expanded catch-cause-interrupts-only, and isRepoWideAstRule",
    () =>
      Effect.gen(function* () {
        // 1. silent-catch-defect flags silent handler, allows reporting handlers
        const silentDefectPath = AstSourceFilePath.make("libs/harness/gates/src/silent-defect.ts")
        const silentDefectSrc = AstSourceContent.make(
          'import { Effect } from "effect"\n' +
            "export const bad = Effect.succeed(1).pipe(Effect.catchDefect(() => Effect.void))\n" +
            'export const okStderr = Effect.succeed(1).pipe(Effect.catchDefect((d) => { process.stderr.write(String(d)); return Effect.void }))\n' +
            'export const okLog = Effect.succeed(1).pipe(Effect.catchDefect((d) => Effect.logWarning(String(d))))\n' +
            "export const okReport = Effect.succeed(1).pipe(Effect.catchDefect((d) => Effect.succeed(makeLspExceptionReport(d))))\n",
        )
        const silentAstReport = yield* AstGateCache.decide({
          files: [{ filePath: silentDefectPath, content: silentDefectSrc }],
        })
        const silentViolations = silentAstReport.violations.filter(
          (v) => v.rule === "silent-catch-defect",
        )
        expect(silentViolations).toHaveLength(1)
        expect(silentViolations[0]?.line).toBe(2)

        const silentDogfoodReport = yield* decideSelfDogfooding({
          files: [{ filePath: silentDefectPath, content: silentDefectSrc }],
        })
        expect(
          silentDogfoodReport.violations.filter((v) => v.rule === "silent-catch-defect"),
        ).toHaveLength(1)

        // 2. ignored-chmod-permission flags Effect.ignore / Effect.orElseSucceed on chmodSync/fchmodSync, allows fail-closed
        const chmodPath = AstSourceFilePath.make("libs/harness/gates/src/chmod-hardening.ts")
        const chmodSrc = AstSourceContent.make(
          'import { chmodSync, fchmodSync } from "node:fs"\n' +
            'import { Effect } from "effect"\n' +
            'export const badIgnore = Effect.sync(() => chmodSync("/tmp/x", 0o600)).pipe(Effect.ignore)\n' +
            'export const badOrElse = Effect.sync(() => fchmodSync(3, 0o600)).pipe(Effect.orElseSucceed(() => undefined))\n' +
            'export const okFailClosed = Effect.try({ try: () => chmodSync("/tmp/x", 0o600), catch: (e) => e })\n',
        )
        const chmodAstReport = yield* AstGateCache.decide({
          files: [{ filePath: chmodPath, content: chmodSrc }],
        })
        expect(
          chmodAstReport.violations.filter((v) => v.rule === "ignored-chmod-permission"),
        ).toHaveLength(2)

        const chmodDogfoodReport = yield* decideSelfDogfooding({
          files: [{ filePath: chmodPath, content: chmodSrc }],
        })
        expect(
          chmodDogfoodReport.violations.filter((v) => v.rule === "ignored-chmod-permission"),
        ).toHaveLength(2)

        // 3. Expanded catch-cause-interrupts-only flags Effect.runPromiseExit(...).then(...) and Effect.runSyncExit(...)
        const exitInspectPath = AstSourceFilePath.make("libs/harness/gates/src/exit-inspect.ts")
        const exitInspectSrc = AstSourceContent.make(
          'import { Cause, Effect, Exit } from "effect"\n' +
            "export const badPromiseExit = Effect.runPromiseExit(Effect.succeed(1)).then((exit) =>\n" +
            "  Exit.isFailure(exit) ? Cause.hasInterruptsOnly(exit.cause) : false,\n" +
            ")\n" +
            "export const badSyncExit = () => {\n" +
            "  const exit = Effect.runSyncExit(Effect.succeed(1))\n" +
            "  return Exit.isFailure(exit) ? Cause.hasInterruptsOnly(exit.cause) : false\n" +
            "}\n" +
            "export const okPureHelper = (cause: Cause.Cause<unknown>) => Cause.hasInterruptsOnly(cause)\n",
        )
        const exitAstReport = yield* AstGateCache.decide({
          files: [{ filePath: exitInspectPath, content: exitInspectSrc }],
        })
        const exitViolations = exitAstReport.violations.filter(
          (v) => v.rule === "catch-cause-interrupts-only",
        )
        expect(exitViolations).toHaveLength(2)

        const exitDogfoodReport = yield* decideSelfDogfooding({
          files: [{ filePath: exitInspectPath, content: exitInspectSrc }],
        })
        expect(
          exitDogfoodReport.violations.filter((v) => v.rule === "catch-cause-interrupts-only"),
        ).toHaveLength(2)

        // 4. isRepoWideAstRule covers all repo-wide rules including the new ones
        const expectedRepoWideRules = [
          "effect-fn-dummy-void",
          "switch-statement",
          "match-run-statement",
          "non-exhaustive-union-match",
          "catch-cause-interrupts-only",
          "unisolated-dot-harness-test-write",
          "unsafe-type-cast",
          "ast-grep-tsx-grammar",
          "node-sqlite-in-infra",
          "silent-catch-defect",
          "ignored-chmod-permission",
        ]
        for (const rule of expectedRepoWideRules) {
          expect(isRepoWideAstRule(rule, "msg")).toBe(true)
        }
        expect(isRepoWideAstRule("discriminant-branching", "Switch statement in 'a.ts' is banned")).toBe(true)
        expect(isRepoWideAstRule("discriminant-branching", "If statement in 'a.ts' inspects union")).toBe(false)
        expect(isRepoWideAstRule("unscoped-effect-run", "Unscoped Effect.runSync")).toBe(false)
      }),
  )
})
