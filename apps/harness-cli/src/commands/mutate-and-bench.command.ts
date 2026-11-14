import { join } from "node:path"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import {
  AstGateCache,
  AstSourceContent,
  AstSourceFilePath,
  BenchStageName,
  buildStageLatencyMeasurement,
  decideHarnessBench,
  DEFAULT_STAGE_LATENCY_BUDGETS,
  HARNESS_GATE_RULE_VERSION,
  LatencyMillis,
  LatencySloViolationError,
  runDomainMutationSuite,
} from "@harness/gates"
import {
  createTypeScriptProgramSession,
  DatalogFilePath,
  DatalogSession,
  decideGraphRewrite,
  extractTypeGraph,
  stepDatalogFileDelta,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { type CliEnv, type CliResult, findWorkspaceRoot } from "./daemon-and-omnigraph.service.js"
import { runBenchmarkCompare } from "./repo-checks.command.js"

export const handleMutate = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.sync(() => {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const scopeArg = argv.find((arg) => arg.startsWith("--scope="))
    const scope = scopeArg ? scopeArg.slice("--scope=".length) : undefined

    const report = runDomainMutationSuite(repoRoot, nodeSyncHostIo, { scope })
    return {
      exitCode: !report.passed ? 1 : 0,
      stdout: JSON.stringify(report),
      stderr: "",
    }
  })

export const handleBench = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    if (argv.includes("--compare")) {
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

    const cacheFilePath = AstGateCache.resolveCachePath(repoRoot)
    yield* AstGateCache.decide({
      files: [
        {
          filePath: AstSourceFilePath.make(benchRelFile),
          content: AstSourceContent.make(sampleContent),
        },
      ],
      ruleVersion: HARNESS_GATE_RULE_VERSION,
      cacheFilePath,
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
        cacheFilePath,
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

    const measurements = [
      buildStageLatencyMeasurement(
        BenchStageName.make("extractTypeGraph.warm"),
        warmExtractSamples,
      ),
      buildStageLatencyMeasurement(BenchStageName.make("DatalogSession.stepDelta"), datalogSamples),
      buildStageLatencyMeasurement(BenchStageName.make("AstGateCache.warm"), warmAstSamples),
      buildStageLatencyMeasurement(BenchStageName.make("GraphRewrite.decide"), rewriteSamples),
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
