import { join } from "node:path"
import { Cause, Effect, Result } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  type CompileInput,
  EarsRequirementKey,
  HARNESS_GATE_RULE_VERSION,
  OwnedRelPath,
  SliceBranchName,
  type UnitDependency,
  WorkUnitId,
  type WorkUnitDraft,
} from "@harness/contract"
import {
  AstGateCache,
  BenchStageName,
  buildSessionReport,
  buildStageLatencyMeasurement,
  compileWorkflowWaves,
  decideHarnessBench,
  DEFAULT_STAGE_LATENCY_BUDGETS,
  LatencyMillis,
  LatencySloViolationError,
  MutantCount,
  MutateStampPassed,
  readFrictionEvents,
  readTelemetryEvents,
  removeMutateStamp,
  runDomainMutationSuite,
  StampRelFilePath,
  writeMutateStamp,
  writeSessionReportFiles,
} from "@harness/gates"
import {
  createTypeScriptProgramSession,
  DatalogFilePath,
  DatalogSession,
  decideGraphRewrite,
  extractTypeGraph,
  type GraphSnapshotError,
  type HarnessGraph,
  loadGraphSnapshotEffect,
  stepDatalogFileDelta,
} from "@harness/graph"
import { HarnessInfraLive, nodeSyncHostIo } from "@harness/infra"

export { HarnessInfraLive }

export const writeDoneSessionReport = (repoRoot: string): void => {
  const finalEvents = readTelemetryEvents(repoRoot, nodeSyncHostIo)
  const finalFriction = readFrictionEvents(repoRoot, nodeSyncHostIo)
  const finalReport = buildSessionReport({
    events: finalEvents,
    frictionEvents: finalFriction,
    stampValid: true,
  })
  writeSessionReportFiles(repoRoot, finalReport, nodeSyncHostIo)
}
import { type CliEnv, type CliResult, findWorkspaceRoot } from "./daemon-and-omnigraph.service.js"
import { makeDoneBlockResult } from "./hook-format.js"
import {
  collectModifiedMutableFiles,
  type CollectModifiedMutableFilesResult,
  evaluateVerifyMutateStampGate,
  hasModifiedMutableFiles,
  isVerifyMutateStampGateEnforced,
  resolveVerifyStampMutateMeta,
} from "./mutate-stamp-gate.js"
import { extractRequiredFlagValue } from "./repo-path.js"

export {
  collectModifiedMutableFiles,
  type CollectModifiedMutableFilesResult,
  evaluateVerifyMutateStampGate,
  hasModifiedMutableFiles,
  isVerifyMutateStampGateEnforced,
  resolveVerifyStampMutateMeta,
}

export const handleMutate = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.sync(() => {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const isStrict = argv.includes("--strict")
    const isAll = argv.includes("--all")
    const disableMutantCache = argv.includes("--no-cache")

    const cleanupStamp = (): string | undefined =>
      match(removeMutateStamp(repoRoot, nodeSyncHostIo))
        .with({ _tag: "Success" }, () => undefined)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .exhaustive()

    const failClosed = (msg: string): CliResult => {
      const cleanupErr = cleanupStamp()
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          passed: false,
          totalMutants: 0,
          killedCount: 0,
          survivedCount: 0,
          equivalentCount: 0,
          mutationScore: 0,
          survivedMutants: [],
          diagnostic: msg,
        }),
        stderr: cleanupErr !== undefined ? `${msg}\n${cleanupErr}` : msg,
      }
    }

    const scopeFlag = extractRequiredFlagValue(argv, "--scope")
    const fileFlag = extractRequiredFlagValue(argv, "--file")
    const baseFlag = extractRequiredFlagValue(argv, "--base")

    const flagError = match({ scopeFlag, fileFlag, baseFlag })
      .with(
        { scopeFlag: { _tag: "MissingValue" } },
        () => "Flag --scope requires a non-empty value.",
      )
      .with({ fileFlag: { _tag: "MissingValue" } }, () => "Flag --file requires a non-empty value.")
      .with({ baseFlag: { _tag: "MissingValue" } }, () => "Flag --base requires a non-empty value.")
      .otherwise(() => undefined)
    if (flagError !== undefined) {
      return failClosed(flagError)
    }

    const scope = match(scopeFlag)
      .with({ _tag: "Value" }, ({ value }) => value)
      .with({ _tag: "Absent" }, { _tag: "MissingValue" }, () => undefined)
      .exhaustive()
    const fileCsv = match(fileFlag)
      .with({ _tag: "Value" }, ({ value }) => value)
      .with({ _tag: "Absent" }, { _tag: "MissingValue" }, () => undefined)
      .exhaustive()
    const baseRef = match(baseFlag)
      .with({ _tag: "Value" }, ({ value }) => value)
      .with({ _tag: "Absent" }, { _tag: "MissingValue" }, () => undefined)
      .exhaustive()

    if (baseRef !== undefined && baseRef.startsWith("-")) {
      return failClosed(`Invalid --base ref '${baseRef}': must not start with '-'.`)
    }

    const targetFiles =
      fileCsv !== undefined
        ? fileCsv
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined

    if (targetFiles !== undefined && targetFiles.length === 0) {
      return failClosed("Empty --file target list; refusing to run mutation suite.")
    }

    const report = runDomainMutationSuite(repoRoot, nodeSyncHostIo, {
      scope,
      includeAllLines: isAll,
      enforcementMode: isStrict ? "strict" : "advisory",
      targetFiles,
      baseRef,
      explicitBaseRef: baseRef !== undefined,
      disableMutantCache,
    })

    const cleanupErr = !report.passed ? cleanupStamp() : undefined
    let stampWriteErr: string | undefined = undefined
    if (
      report.passed &&
      isStrict &&
      scope === undefined &&
      targetFiles === undefined &&
      baseRef === undefined
    ) {
      const writeRes = Result.try(() =>
        writeMutateStamp(repoRoot, nodeSyncHostIo, {
          enforcementMode: "strict",
          diffMode: report.diffMode,
          scannedCandidateFiles: MutantCount.make(report.scannedCandidateFiles),
          scannedFiles: report.scannedFiles.map((f) => StampRelFilePath.make(f)),
          diffMatchedFiles: report.diffMatchedFiles.map((f) => StampRelFilePath.make(f)),
          evaluatedFiles: report.evaluatedFiles.map((f) => StampRelFilePath.make(f)),
          totalMutants: MutantCount.make(report.totalMutants),
          killedCount: MutantCount.make(report.killedCount),
          survivedCount: MutantCount.make(report.survivedCount),
          equivalentCount: MutantCount.make(report.equivalentCount),
          passed: MutateStampPassed.make(true),
        }),
      )
      stampWriteErr = match(writeRes)
        .with({ _tag: "Success" }, () => undefined)
        .with({ _tag: "Failure" }, ({ failure }) => {
          const rollbackErr = cleanupStamp()
          const msg = `Failed to write mutate-stamp.json: ${failure instanceof Error ? failure.message : String(failure)}`
          return rollbackErr !== undefined ? `${msg}\n${rollbackErr}` : msg
        })
        .exhaustive()
    }

    const stderrParts = [
      ...(report.diagnostic !== undefined && report.diagnostic.length > 0
        ? [report.diagnostic]
        : []),
      ...(cleanupErr !== undefined ? [cleanupErr] : []),
      ...(stampWriteErr !== undefined ? [stampWriteErr] : []),
    ]

    return {
      exitCode: !report.passed || stampWriteErr !== undefined ? 1 : 0,
      stdout: JSON.stringify(report),
      stderr: stderrParts.join("\n"),
    }
  })

export const loadSnapshotPair = (
  repoRoot: string,
  initialPlan: HarnessGraph | undefined,
  initialImpl: HarnessGraph | undefined,
  isAntigravity: boolean,
): Effect.Effect<
  | { readonly _tag: "Done"; readonly result: CliResult }
  | {
      readonly _tag: "Graphs"
      readonly planGraph?: HarnessGraph | undefined
      readonly implGraph?: HarnessGraph | undefined
    }
> =>
  Effect.gen(function* () {
    if (initialPlan !== undefined && initialImpl !== undefined) {
      return { _tag: "Graphs" as const, planGraph: initialPlan, implGraph: initialImpl }
    }
    const planPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
    const implPath = join(repoRoot, ".harness", "graph-snapshot.json")
    if (
      (initialPlan === undefined && !nodeSyncHostIo.existsSync(planPath)) ||
      (initialImpl === undefined && !nodeSyncHostIo.existsSync(implPath))
    ) {
      return { _tag: "Graphs" as const, planGraph: initialPlan, implGraph: initialImpl }
    }

    const loadOne = (path: string, label: string) =>
      loadGraphSnapshotEffect(path, nodeSyncHostIo).pipe(
        Effect.map((graph) => ({ _tag: "Ok" as const, graph })),
        Effect.catchTag("GraphSnapshotError", (err: GraphSnapshotError) =>
          Effect.gen(function* () {
            yield* Effect.logError(
              `Failed to load ${label} graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`,
            )
            return { _tag: "Err" as const, err }
          }),
        ),
      )

    const planLoad =
      initialPlan !== undefined
        ? { _tag: "Ok" as const, graph: initialPlan }
        : yield* loadOne(planPath, "plan")
    const implLoad =
      initialImpl !== undefined
        ? { _tag: "Ok" as const, graph: initialImpl }
        : yield* loadOne(implPath, "implementation")

    return match({ planLoad, implLoad })
      .with({ planLoad: { _tag: "Err" } }, ({ planLoad: { err } }) => {
        const reason = `Corrupt plan graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`
        return {
          _tag: "Done" as const,
          result: makeDoneBlockResult(
            isAntigravity,
            reason,
            "[GATE FAILURE] done:plan-graph-snapshot\n",
          ),
        }
      })
      .with({ implLoad: { _tag: "Err" } }, ({ implLoad: { err } }) => {
        const reason = `Corrupt implementation graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`
        return {
          _tag: "Done" as const,
          result: makeDoneBlockResult(
            isAntigravity,
            reason,
            "[GATE FAILURE] done:impl-graph-snapshot\n",
          ),
        }
      })
      .with({ planLoad: { _tag: "Ok" }, implLoad: { _tag: "Ok" } }, ({ planLoad, implLoad }) => ({
        _tag: "Graphs" as const,
        planGraph: planLoad.graph,
        implGraph: implLoad.graph,
      }))
      .exhaustive()
  })

export const parseDoneDeadlineMs = (): number => {
  const raw = process.env.HARNESS_DONE_DEADLINE_MS
  if (raw === undefined || raw.trim().length === 0) {
    return 23_000
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 23_000
}

const buildBenchmarkCompileInput = (): CompileInput => {
  const units: Array<WorkUnitDraft> = []
  const dependencies: Array<UnitDependency> = []
  for (let layer = 0; layer < 5; layer++) {
    for (let idx = 0; idx < 10; idx++) {
      const unitId = WorkUnitId.make(`u-${layer}-${idx}`)
      units.push({
        _tag: "SliceUnit",
        unitId,
        branch: SliceBranchName.make(`slice/layer${layer}-unit${idx}`),
        ownedRelPaths: [OwnedRelPath.make(`libs/bench/layer-${layer}/unit-${idx}.ts`)],
        earsKeys: [EarsRequirementKey.make(`REQ-${layer + 1}.${idx + 1}`)],
      })
      if (layer > 0) {
        for (let d = 0; d < 5; d++) {
          dependencies.push({
            from: WorkUnitId.make(`u-${layer - 1}-${(idx + d) % 10}`),
            to: unitId,
          })
        }
      }
    }
  }
  return { units, dependencies }
}

export const handleBench = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    if (argv.includes("--compare")) {
      const { runBenchmarkCompare } = yield* Effect.promise(
        () => import("./repo-checks.command.js"),
      )
      return yield* runBenchmarkCompare(argv, options)
    }
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const iterationsArg = argv.find((a) => a.startsWith("--iterations="))
    const parsedIter = iterationsArg ? Number(iterationsArg.slice("--iterations=".length)) : 3
    const iterations = Number.isFinite(parsedIter) && parsedIter >= 1 ? Math.floor(parsedIter) : 3

    const budgetArg = argv.find((a) => a.startsWith("--budget-ms="))
    const parsedBudget = budgetArg ? Number(budgetArg.slice("--budget-ms=".length)) : undefined
    const customBudgetMs =
      parsedBudget !== undefined && Number.isFinite(parsedBudget) && parsedBudget >= 0
        ? LatencyMillis.make(parsedBudget)
        : undefined

    const benchRelFile = nodeSyncHostIo.existsSync(
      join(repoRoot, "libs", "harness", "gates", "src", "bench-check.ts"),
    )
      ? "libs/harness/gates/src/bench-check.ts"
      : "libs/sample/domain/src/index.ts"
    const sampleFilePath = join(repoRoot, benchRelFile)
    const sampleContent = nodeSyncHostIo.existsSync(sampleFilePath)
      ? nodeSyncHostIo.readTextSync(sampleFilePath)
      : "export const x = 1\n"

    const session = createTypeScriptProgramSession(repoRoot, nodeSyncHostIo)
    const coldExtractStart = performance.now()
    const initialGraph = yield* extractTypeGraph({ repoRoot, session, hostIo: nodeSyncHostIo })
    const coldExtractMs = Math.max(0, performance.now() - coldExtractStart)

    yield* extractTypeGraph({
      repoRoot,
      session,
      hostIo: nodeSyncHostIo,
      overlays: {
        [benchRelFile]: `${sampleContent}\n// warm-prime\n`,
      },
    })

    const warmExtractSamples: Array<number> = []
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      yield* extractTypeGraph({
        repoRoot,
        session,
        hostIo: nodeSyncHostIo,
        overlays: {
          [benchRelFile]: `${sampleContent}\n// warm-bench-${i}\n`,
        },
      })
      warmExtractSamples.push(Math.max(0, performance.now() - t0))
    }

    let stageError: string | undefined = undefined

    const datalogSamples: Array<number> = []
    const datalogLayer = DatalogSession.layer(initialGraph)
    yield* Effect.gen(function* () {
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now()
        yield* stepDatalogFileDelta({
          filePath: DatalogFilePath.make(benchRelFile),
          nextGraph: initialGraph,
        })
        datalogSamples.push(Math.max(0, performance.now() - t0))
      }
    }).pipe(
      Effect.provide(datalogLayer),
      Effect.catch((err) =>
        Effect.sync(() => {
          stageError = `DatalogSession.stepDelta failed: ${String(err)}`
        }),
      ),
    )

    if (stageError !== undefined) {
      return {
        exitCode: 1,
        stdout: JSON.stringify({ overallStatus: "failed", error: stageError }),
        stderr: stageError,
      }
    }

    yield* AstGateCache.decide({
      files: [
        {
          filePath: AstSourceFilePath.make(benchRelFile),
          content: AstSourceContent.make(sampleContent),
        },
      ],
      ruleVersion: HARNESS_GATE_RULE_VERSION,
    })

    const warmAstSamples: Array<number> = []
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      yield* AstGateCache.decide({
        files: [
          {
            filePath: AstSourceFilePath.make(benchRelFile),
            content: AstSourceContent.make(sampleContent),
          },
        ],
        ruleVersion: HARNESS_GATE_RULE_VERSION,
      })
      warmAstSamples.push(Math.max(0, performance.now() - t0))
    }

    const rewriteSamples: Array<number> = []
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      yield* decideGraphRewrite(initialGraph, "cleanup", undefined, { maxPhaseSteps: 2 }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            stageError = `GraphRewrite.decide failed: ${String(err)}`
          }),
        ),
      )
      if (stageError !== undefined) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({ overallStatus: "failed", error: stageError }),
          stderr: stageError,
        }
      }
      rewriteSamples.push(Math.max(0, performance.now() - t0))
    }

    const benchInput = buildBenchmarkCompileInput()
    const failBenchStage = (msg: string): CliResult => ({
      exitCode: 1,
      stdout: JSON.stringify({ overallStatus: "failed", error: msg }),
      stderr: msg,
    })
    yield* compileWorkflowWaves(benchInput).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          stageError = `PlanWorkflowCompiler.decide warmup failed: ${String(err)}`
        }),
      ),
    )
    if (stageError !== undefined) return failBenchStage(stageError)

    const workflowCompilerSamples: Array<number> = []
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      yield* compileWorkflowWaves(benchInput).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            stageError = `PlanWorkflowCompiler.decide failed: ${String(err)}`
          }),
        ),
      )
      if (stageError !== undefined) return failBenchStage(stageError)
      workflowCompilerSamples.push(Math.max(0, performance.now() - t0))
    }

    const measurements = [
      buildStageLatencyMeasurement(
        BenchStageName.make("extractTypeGraph.warm"),
        warmExtractSamples,
      ),
      buildStageLatencyMeasurement(BenchStageName.make("DatalogSession.stepDelta"), datalogSamples),
      buildStageLatencyMeasurement(BenchStageName.make("AstGateCache.warm"), warmAstSamples),
      buildStageLatencyMeasurement(BenchStageName.make("GraphRewrite.decide"), rewriteSamples),
      buildStageLatencyMeasurement(
        BenchStageName.make("PlanWorkflowCompiler.decide"),
        workflowCompilerSamples,
      ),
    ]

    const effectiveBudgets =
      customBudgetMs !== undefined
        ? DEFAULT_STAGE_LATENCY_BUDGETS.map((b) => ({
            stage: b.stage,
            p50BudgetMs: customBudgetMs,
            p95BudgetMs: customBudgetMs,
          }))
        : DEFAULT_STAGE_LATENCY_BUDGETS

    const benchExit = yield* Effect.exit(
      decideHarnessBench({
        measurements,
        budgets: effectiveBudgets,
      }),
    )

    return match(benchExit)
      .with({ _tag: "Failure" }, (failure) => {
        const errOpt = Cause.findErrorOption(failure.cause)
        const { violations, stderrMsg } = match(errOpt)
          .with({ _tag: "Some" }, ({ value }) =>
            value instanceof LatencySloViolationError
              ? {
                  violations: value.violations,
                  stderrMsg: `[LatencySloViolationError] ${value.violations.length} stage(s) exceeded latency budget`,
                }
              : {
                  violations: [],
                  stderrMsg: "Benchmark SLO evaluation failed",
                },
          )
          .with({ _tag: "None" }, () => ({
            violations: [],
            stderrMsg: "Benchmark SLO evaluation failed",
          }))
          .exhaustive()
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            overallStatus: "failed",
            coldExtractMs: LatencyMillis.make(Math.round(coldExtractMs * 100) / 100),
            measurements,
            violations,
          }),
          stderr: stderrMsg,
        }
      })
      .with({ _tag: "Success" }, (success) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          overallStatus: "passed",
          ...success.value,
          coldExtractMs: LatencyMillis.make(Math.round(coldExtractMs * 100) / 100),
          measurements,
        }),
        stderr: "",
      }))
      .exhaustive()
  })
