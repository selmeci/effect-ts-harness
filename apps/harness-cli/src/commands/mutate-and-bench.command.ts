import { join } from "node:path"
import { Cause, Effect, Result } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  type CompileInput,
  EarsRequirementKey,
  type MutationCacheAuth,
  MutationEpochMillis,
  OwnedRelPath,
  SliceBranchName,
  type UnitDependency,
  WorkUnitId,
  type WorkUnitDraft,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  AstGateCache,
  BenchStageName,
  buildSessionReport,
  buildStageLatencyMeasurement,
  compileWorkflowWaves,
  decideHarnessBench,
  DEFAULT_STAGE_LATENCY_BUDGETS,
  formatSurvivorLine,
  LatencyMillis,
  LatencySloViolationError,
  MutantCount,
  MutateStampPassed,
  MutationCheck,
  removeMutateStamp,
  StampBranchName,
  StampRelFilePath,
  writeMutateStamp,
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
import {
  HarnessInfraLive,
  nodeSyncHostIo,
  resolveOrCreateMutationCacheHmacSecret,
} from "@harness/infra"
import {
  readFrictionEventsSafe,
  readTelemetryEventsSafe,
  writeSessionReportFilesSafe,
} from "./learn-and-report.command.js"
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
import { parseMutateCliFlags } from "./mutate-flags.js"
import { shouldSuppressLiveRepoTestSideEffects } from "./repo-path.js"
import {
  isAlreadyDoneForVerifiedTree,
  readLastDoneMarker,
  writeLastDoneMarker,
} from "./session-fastpath.js"

export {
  collectModifiedMutableFiles,
  type CollectModifiedMutableFilesResult,
  evaluateVerifyMutateStampGate,
  HarnessInfraLive,
  hasModifiedMutableFiles,
  isAlreadyDoneForVerifiedTree,
  isVerifyMutateStampGateEnforced,
  resolveVerifyStampMutateMeta,
}

const persistDoneSessionReport = (repoRoot: string): void => {
  const finalEvents = readTelemetryEventsSafe(repoRoot, nodeSyncHostIo)
  const finalFriction = readFrictionEventsSafe(repoRoot, nodeSyncHostIo)
  const finalReport = buildSessionReport({
    events: finalEvents,
    frictionEvents: finalFriction,
    stampValid: true,
  })
  writeSessionReportFilesSafe(repoRoot, finalReport, nodeSyncHostIo)
}

export const writeDoneSessionReport = (repoRoot: string, treeHash?: string): void => {
  if (shouldSuppressLiveRepoTestSideEffects(repoRoot)) return
  const effectiveTreeHash = treeHash ?? readLastDoneMarker(repoRoot, nodeSyncHostIo)?.treeHash
  writeLastDoneMarker(repoRoot, nodeSyncHostIo, effectiveTreeHash)
  persistDoneSessionReport(repoRoot)
}

export const finalizeDoneSuccess = (
  repoRoot: string,
  treeHash: string,
  options: CliEnv | undefined,
): void => {
  writeLastDoneMarker(repoRoot, nodeSyncHostIo, treeHash)
  if (
    (options?.repoRoot !== undefined || options?.skipAutoSessionReport !== true) &&
    !shouldSuppressLiveRepoTestSideEffects(repoRoot)
  ) {
    persistDoneSessionReport(repoRoot)
  }
}

export const cleanupMutateStamp = (repoRoot?: string): string | undefined =>
  match(removeMutateStamp(repoRoot ?? findWorkspaceRoot(), nodeSyncHostIo))
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()

export const handleMutate = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const cleanupStamp = (): string | undefined => cleanupMutateStamp(repoRoot)

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

    const parsedFlagsResult = parseMutateCliFlags(argv)
    return yield* match(parsedFlagsResult)
      .with({ _tag: "Invalid" }, ({ reason }) => Effect.succeed(failClosed(reason)))
      .with({ _tag: "Ok" }, ({ parsed }) =>
        Effect.gen(function* () {
          const cacheAuth: MutationCacheAuth = match(
            resolveOrCreateMutationCacheHmacSecret(WorkspaceFilePath.make(repoRoot), {
              hostIo: nodeSyncHostIo,
            }),
          )
            .with({ _tag: "Resolved" }, ({ secret }) => ({
              _tag: "Enabled" as const,
              hmacSecret: secret,
            }))
            .with({ _tag: "Unavailable" }, ({ reason }) => ({
              _tag: "Disabled" as const,
              reason,
            }))
            .exhaustive()

          const report = yield* MutationCheck.run(repoRoot, nodeSyncHostIo, {
            scope: parsed.scope,
            includeAllLines: parsed.isAll,
            enforcementMode: parsed.isStrict ? "strict" : "advisory",
            targetFiles: parsed.targetFiles,
            baseRef: parsed.baseRef,
            explicitBaseRef: parsed.baseRef !== undefined,
            diffOnly: parsed.isDiff,
            disableMutantCache: parsed.disableMutantCache,
            failFast: parsed.failFast,
            maxSurvivors: parsed.maxSurvivors,
            stageAOnly: parsed.stageAOnly,
            survivorsOnly: parsed.survivorsOnly,
            suppressSurvivorStderr: true,
            cacheAuth,
            nowMs: MutationEpochMillis.make(Date.now()),
          })

          const cleanupErr =
            !report.passed || report.earlyTerminated === true ? cleanupStamp() : undefined
          let stampWriteErr: string | undefined = undefined
          const baseAuthorized = parsed.baseRef === undefined || report.stackedBaseVerified === true
          const stampSkipReasons: Array<string> = []
          if (parsed.stageAOnly) stampSkipReasons.push("--stage-a-only")
          if (parsed.survivorsOnly) stampSkipReasons.push("--survivors-only")
          if (report.earlyTerminated === true) stampSkipReasons.push("early termination")
          if (parsed.scope !== undefined) stampSkipReasons.push("--scope")
          if (parsed.targetFiles !== undefined) {
            const usesFilesAlias = argv.some((a) => a === "--files" || a.startsWith("--files="))
            stampSkipReasons.push(usesFilesAlias ? "--files" : "--file")
          }
          if (!baseAuthorized && parsed.baseRef !== undefined) {
            stampSkipReasons.push(`unverified --base '${parsed.baseRef}'`)
          }
          if (parsed.isDiff) stampSkipReasons.push("--diff")

          if (
            report.passed &&
            parsed.isStrict &&
            report.survivedCount === 0 &&
            stampSkipReasons.length === 0
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
                ...(report.stackedBaseRef !== undefined
                  ? { stackedBaseRef: StampBranchName.make(report.stackedBaseRef) }
                  : {}),
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
          const stampSkipNotice =
            report.passed && parsed.isStrict && stampSkipReasons.length > 0
              ? `[mutation-check] Notice: .harness/mutate-stamp.json was not written (${stampSkipReasons.join(", ")}).`
              : undefined

          const survivorLines =
            report.earlyTerminated === true ||
            (!report.passed && (parsed.failFast || parsed.maxSurvivors !== undefined))
              ? report.survivedMutants.map((m) => formatSurvivorLine(m))
              : []
          const stderrParts = [
            ...survivorLines,
            ...(report.diagnostic !== undefined && report.diagnostic.length > 0
              ? [report.diagnostic]
              : []),
            ...(cleanupErr !== undefined ? [cleanupErr] : []),
            ...(stampWriteErr !== undefined ? [stampWriteErr] : []),
            ...(stampSkipNotice !== undefined ? [stampSkipNotice] : []),
          ]

          return {
            exitCode: !report.passed || stampWriteErr !== undefined ? 1 : 0,
            stdout: JSON.stringify(report),
            stderr: stderrParts.join("\n"),
          }
        }),
      )
      .exhaustive()
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
      return yield* Effect.tryPromise({
        try: () => import("./repo-checks.command.js"),
        catch: (err): { readonly _tag: "BenchmarkImportFailure"; readonly message: string } => ({
          _tag: "BenchmarkImportFailure",
          message: err instanceof Error ? err.message : String(err),
        }),
      }).pipe(
        Effect.flatMap(({ runBenchmarkCompare }) => runBenchmarkCompare(argv, options)),
        Effect.catch((err) => {
          const msg = `Failed to load benchmark compare: ${err.message}`
          return Effect.succeed({
            exitCode: 1,
            stdout: JSON.stringify({ error: msg }),
            stderr: `${msg}\n`,
          })
        }),
      )
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
