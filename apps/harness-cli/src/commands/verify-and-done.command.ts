import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import * as Graph from "effect/Graph"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { checkPlanStepCoverage, triageFailure } from "@harness/decision"
import {
  buildSessionReport,
  checkLoopThrashing,
  checkVerifyStamp,
  decideOntologyInvariants,
  decideSpanBudgets,
  diffPlanAndImplGraphs,
  DstErrorTag,
  DstExecutionTier,
  DstMethodName,
  DstServiceTag,
  DstStepCount,
  type DstTargetServiceMethod as DstTargetMethodSpec,
  loadGovernanceDocsFromDisk,
  parseDstSeedEnv,
  readFrictionEvents,
  readTelemetryEvents,
  resolveOmnigraphTaskBranches,
  runDstSeedSuite,
  writeGraphHeadMeta,
  writeSessionReportFiles,
  writeVerifyStamp,
} from "@harness/gates"
import {
  checkEffectGraph,
  diffOmnigraphBranches,
  extractGraphViaCompilerOverlay,
  extractTypeGraph,
  findTestsReaching,
  type GraphSnapshotError,
  type HarnessGraph,
  loadGraphSnapshotEffect,
  makeOmnigraphSyncLayer,
  makeTsCompilerOverlayLayer,
  mergeOmnigraphBranch,
  saveGraphSnapshot,
  syncToOmnigraphAndSnapshot,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { buildWorkspaceFnIndex } from "@harness/ingest"
import {
  type CliEnv,
  type CliResult,
  ensureLocalOllamaReady,
  ensureLocalOmnigraphReady,
  findWorkspaceRoot,
  formatSubprocessError,
  isIsolatedExternalWorkspace,
  isRootConfigOrSharedCoreChange,
  recordFriction,
  recordTelemetry,
  resolveClusterRepoRoot,
  resolveModifiedFilesSinceStampOrHead,
  resolveNxAffectedArgs,
  tryQueryWarmDaemonSocket,
} from "./daemon-and-omnigraph.service.js"
import {
  decodeStopHookStdin,
  hasVerifiedSinceLastMutation,
  isReadOnlyStopTurn,
  isSubagentStopContext,
  type StopHookStdin,
} from "./stop-hook-and-transcript.js"
import { readRecordedSpans, runDeltaAstAndPluginGates } from "./verify-delta-gates.js"

const verifyFailureWithThrashing = (
  options: CliEnv | undefined,
  repoRoot: string,
  summary: string,
  detail: string,
  stderrMsg: string,
): CliResult => {
  recordFriction(options, { kind: "verify_failure", summary, detail })
  const thrashing = checkLoopThrashing(readFrictionEvents(repoRoot, nodeSyncHostIo))
  if (thrashing.stuck && thrashing.escalationMessage !== null) {
    return { exitCode: 2, stdout: "", stderr: `${thrashing.escalationMessage}\n${stderrMsg}` }
  }
  return { exitCode: 1, stdout: "", stderr: stderrMsg }
}

const buildDstTargetsFromGraph = (graph: HarnessGraph): ReadonlyArray<DstTargetMethodSpec> => {
  const dstTargets: Array<DstTargetMethodSpec> = []
  for (const [, node] of Graph.nodes(graph.graph)) {
    if (node._tag === "ServiceTag") {
      dstTargets.push({
        serviceTag: DstServiceTag.make(node.name || node.tagId),
        methodName: DstMethodName.make("execute"),
        declaredErrors: [DstErrorTag.make(`${node.name || node.tagId}Error`)],
      })
    }
  }
  if (dstTargets.length === 0) {
    dstTargets.push({
      serviceTag: DstServiceTag.make("HarnessVerificationService"),
      methodName: DstMethodName.make("verify"),
      declaredErrors: [DstErrorTag.make("HarnessVerificationError")],
    })
  }
  return dstTargets
}

export const handleVerify = (
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    if (process.env.HARNESS_USE_DAEMON === "1") {
      yield* tryQueryWarmDaemonSocket(repoRoot, "ping")
    }
    const requireOllama =
      process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
      (!isIsolatedExternalWorkspace(repoRoot) &&
        options?.decisionLayer === undefined &&
        process.env.VITEST === undefined)
    if (requireOllama && !(yield* ensureLocalOllamaReady())) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is not running and could not be started automatically. Halting execution.",
      }
    }

    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot, nodeSyncHostIo)
    const stubs = Array.from(fnIndex.bySpanName.values()).filter((fn) => fn.isStub)
    if (stubs.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Verification failed: active stub() found in ${stubs.map((s) => s.spanName).join(", ")}`,
      }
    }

    const deltaFiles = resolveModifiedFilesSinceStampOrHead(repoRoot).filter(
      (f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && existsSync(join(repoRoot, f)),
    )
    const astGateFail = yield* runDeltaAstAndPluginGates(repoRoot, deltaFiles)
    if (Option.isSome(astGateFail)) return astGateFail.value

    const graph = yield* extractGraphViaCompilerOverlay({ repoRoot }).pipe(
      Effect.provide(makeTsCompilerOverlayLayer(nodeSyncHostIo)),
      Effect.catchTag("TsCompilerOverlayError", () =>
        extractTypeGraph({ repoRoot, hostIo: nodeSyncHostIo }),
      ),
    )
    const graphStubs: Array<string> = []
    for (const [, node] of Graph.nodes(graph.graph)) {
      if (node._tag === "EffectFn" && node.isStub) graphStubs.push(node.spanName)
    }
    if (graphStubs.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Verification failed: active stub() found in ${Array.from(new Set(graphStubs)).join(", ")}`,
      }
    }

    const checkResult = checkEffectGraph(graph)
    if (!checkResult.ok) {
      const msg = checkResult.violations
        .map((v) => `[${v.rule}] ${v.message} (${v.path.join(" -> ")})`)
        .join("\n")
      return verifyFailureWithThrashing(
        options,
        repoRoot,
        checkResult.violations[0]?.rule ?? "graph-violation",
        msg,
        msg,
      )
    }

    const governanceDocs =
      options?.governanceDocs ?? loadGovernanceDocsFromDisk(repoRoot, nodeSyncHostIo)
    const ontologyInvariants = yield* decideOntologyInvariants({ graph, governanceDocs })
    if (!ontologyInvariants.clean) {
      const msg = ontologyInvariants.findings
        .map((f) => `[${f.kind}] ${f.nodeId}: ${f.message}`)
        .join("\n")
      return verifyFailureWithThrashing(
        options,
        repoRoot,
        ontologyInvariants.findings[0]?.kind ?? "ontology-invariants-failed",
        msg,
        `Verification failed: ontology invariants broken\n${msg}`,
      )
    }

    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
    const snapshotPath = join(repoRoot, ".harness", "graph-snapshot.json")
    if (isIsolatedExternalWorkspace(repoRoot)) {
      saveGraphSnapshot(graph, snapshotPath, nodeSyncHostIo)
      writeGraphHeadMeta(repoRoot, nodeSyncHostIo)
      recordTelemetry(options, {
        surface: "cli",
        category: "graph_query",
        toolName: "omnigraph:sync-impl",
        outcome: "ok",
        durationMs: 1,
        engineSource: "local",
      })
    } else {
      yield* ensureLocalOmnigraphReady(repoRoot)
      const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
        repoRoot: resolveClusterRepoRoot(repoRoot),
        branch: taskBranches.implBranch,
        from: taskBranches.mainBranch,
        snapshotPath,
      }).pipe(
        Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)),
        Effect.orElseSucceed(() => ({ syncedToOmnigraph: false, snapshotPath, error: undefined })),
      )
      writeGraphHeadMeta(repoRoot, nodeSyncHostIo)
      recordTelemetry(options, {
        surface: "cli",
        category: "graph_query",
        toolName: "omnigraph:sync-impl",
        outcome: syncRes.syncedToOmnigraph ? "ok" : "fail",
        durationMs: 1,
        engineSource: syncRes.syncedToOmnigraph ? "omnigraph" : "memory-fallback",
      })
      if (!syncRes.syncedToOmnigraph) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Verification failed: could not sync implementation graph to Omnigraph${syncRes.error ? ` (${syncRes.error})` : ""}`,
        }
      }
    }

    if (!options?.skipSubprocessVerify && existsSync(join(repoRoot, "package.json"))) {
      const leafFastPathEligible =
        deltaFiles.length > 0 && !isRootConfigOrSharedCoreChange(deltaFiles)
      const scopedFiles = leafFastPathEligible ? deltaFiles : undefined
      if (leafFastPathEligible) {
        for (const df of deltaFiles) findTestsReaching(graph, df)
      }
      const nxArgs = resolveNxAffectedArgs(repoRoot, ["verify"], scopedFiles)
      const subprocessErr = yield* Effect.try({
        try: () => {
          execFileSync("pnpm", nxArgs, {
            cwd: repoRoot,
            stdio: "pipe",
            env: { ...process.env, CI: "true" },
          })
          return null
        },
        catch: (cause) => formatSubprocessError(cause),
      }).pipe(Effect.catch((msg) => Effect.succeed(msg || "Verification subprocess failed")))

      if (subprocessErr !== null) {
        const triage = yield* triageFailure(subprocessErr).pipe(Effect.provide(decisionLayer))
        const formattedErr = `[GATE FAILURE] [triage:${triage.kind}] ${triage.hint}\n\nFAILED OUTPUT:\n${subprocessErr}`
        return verifyFailureWithThrashing(
          options,
          repoRoot,
          `verify:${triage.kind}`,
          formattedErr,
          formattedErr,
        )
      }
    }

    const dstSuiteResult = yield* runDstSeedSuite({
      tier: DstExecutionTier.make(process.env.CI === "true" ? "ci_full" : "fast_local"),
      pinnedSeed: parseDstSeedEnv(process.env["DST_SEED"]),
      stepCount: DstStepCount.make(8),
      targets: buildDstTargetsFromGraph(graph),
    }).pipe(
      Effect.map((suite) => ({ _tag: "Ok" as const, suite })),
      Effect.catchTag("DstScheduleError", (err) => Effect.succeed({ _tag: "Err" as const, err })),
    )

    return yield* match(dstSuiteResult)
      .with({ _tag: "Err" }, ({ err }) =>
        Effect.succeed<CliResult>({
          exitCode: 1,
          stdout: "",
          stderr: `[GATE FAILURE] verify:dst-schedule\n${err.reason ?? err.message}`,
        }),
      )
      .with({ _tag: "Ok" }, ({ suite }) =>
        Effect.gen(function* () {
          const spanReadResult = yield* readRecordedSpans(repoRoot).pipe(
            Effect.map((spans) => ({ _tag: "Ok" as const, spans })),
            Effect.catchTag("SpanTraceReadError", (err) =>
              Effect.succeed({ _tag: "SpanReadErr" as const, err }),
            ),
          )

          return yield* match(spanReadResult)
            .with({ _tag: "SpanReadErr" }, ({ err }) =>
              Effect.succeed<CliResult>({
                exitCode: 1,
                stdout: "",
                stderr: `[GATE FAILURE] verify:span-budget\n${err.message}`,
              }),
            )
            .with({ _tag: "Ok" }, ({ spans: recordedSpans }) =>
              Effect.gen(function* () {
                const spanBudgetsResult = yield* decideSpanBudgets({
                  spans: recordedSpans,
                  causalityRules: [],
                  failOnViolation: true,
                }).pipe(
                  Effect.map(() => ({ _tag: "Ok" as const })),
                  Effect.catchTag("SpanCausalityError", (err) =>
                    Effect.succeed({ _tag: "Err" as const, err }),
                  ),
                )

                return match(spanBudgetsResult)
                  .with({ _tag: "Err" }, ({ err }) => ({
                    exitCode: 1,
                    stdout: "",
                    stderr: `[GATE FAILURE] verify:span-budget\n${err.message}`,
                  }))
                  .with({ _tag: "Ok" }, () => {
                    const stamp = writeVerifyStamp(repoRoot, nodeSyncHostIo, taskBranches.implBranch, {
                      dstSeed: suite.initialSeed,
                      dstSeedsRun: suite.seedsRun,
                    })
                    return { exitCode: 0, stdout: JSON.stringify(stamp), stderr: "" }
                  })
                  .exhaustive()
              }),
            )
            .exhaustive()
        }),
      )
      .exhaustive()
  })

const loadSnapshotPair = (
  repoRoot: string,
  initialPlan: HarnessGraph | undefined,
  initialImpl: HarnessGraph | undefined,
  isAntigravity: boolean,
  blockDecision: string,
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
      (initialPlan === undefined && !existsSync(planPath)) ||
      (initialImpl === undefined && !existsSync(implPath))
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
          result: {
            exitCode: isAntigravity ? 0 : 1,
            stdout: JSON.stringify({ decision: blockDecision, reason }),
            stderr: `[GATE FAILURE] done:plan-graph-snapshot\n${reason}`,
          },
        }
      })
      .with({ implLoad: { _tag: "Err" } }, ({ implLoad: { err } }) => {
        const reason = `Corrupt implementation graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`
        return {
          _tag: "Done" as const,
          result: {
            exitCode: isAntigravity ? 0 : 1,
            stdout: JSON.stringify({ decision: blockDecision, reason }),
            stderr: `[GATE FAILURE] done:impl-graph-snapshot\n${reason}`,
          },
        }
      })
      .with({ planLoad: { _tag: "Ok" }, implLoad: { _tag: "Ok" } }, ({ planLoad, implLoad }) => ({
        _tag: "Graphs" as const,
        planGraph: planLoad.graph,
        implGraph: implLoad.graph,
      }))
      .exhaustive()
  })

export const handleDone = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const isAntigravity = argv.includes("--format=antigravity")
    const blockDecision = isAntigravity ? "continue" : "block"

    let rawStdin = options?.stdin
    if (rawStdin === undefined && !process.stdin.isTTY) {
      rawStdin = yield* Effect.try({
        try: () => readFileSync(0, "utf8"),
        catch: () => "",
      }).pipe(Effect.orElseSucceed(() => ""))
    }
    let decodedStdin: StopHookStdin | undefined
    if (rawStdin) {
      const decoded = decodeStopHookStdin(rawStdin)
      if (Option.isSome(decoded)) {
        decodedStdin = decoded.value
        if (decoded.value.fullyIdle === false) {
          return { exitCode: 0, stdout: "", stderr: "", telemetryDetail: "fullyIdle=false" }
        }
      }
    }

    // 1. Subagent bypass
    if (isSubagentStopContext(repoRoot, decodedStdin)) {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
        stderr: "",
        telemetryDetail: "subagent=true",
      }
    }

    // 2. Read-only turn bypass
    if (isReadOnlyStopTurn(decodedStdin)) {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
        stderr: "",
        telemetryDetail: "readOnly=true",
      }
    }

    // 3. Verify stamp check
    const stampCheck = checkVerifyStamp(repoRoot, nodeSyncHostIo)
    if (!stampCheck.valid) {
      if (hasVerifiedSinceLastMutation(decodedStdin)) {
        return {
          exitCode: 0,
          stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
          stderr: "",
          telemetryDetail: "completed",
        }
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: blockDecision, reason: stampCheck.reason }),
        stderr: "",
      }
    }

    const snapshotOutcome = yield* loadSnapshotPair(
      repoRoot,
      options?.planGraph,
      options?.implGraph,
      isAntigravity,
      blockDecision,
    )

    return yield* match(snapshotOutcome)
      .with({ _tag: "Done" }, ({ result }) => Effect.succeed(result))
      .with({ _tag: "Graphs" }, ({ planGraph, implGraph }) =>
        Effect.gen(function* () {
          // 4. Plan vs implementation graph diff
          if (planGraph && implGraph) {
            const diff = diffPlanAndImplGraphs(planGraph, implGraph)
            if (!diff.ok) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ decision: blockDecision, reason: diff.reasons.join("; ") }),
                stderr: "",
              }
            }
          }

          // 5. Plan step coverage
          if (options?.planSteps && options.planSteps.length > 0) {
            for (const step of options.planSteps) {
              const stepRes = yield* checkPlanStepCoverage(step).pipe(Effect.provide(decisionLayer))
              if (!stepRes.covered) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ decision: blockDecision, reason: stepRes.reason }),
                  stderr: "",
                }
              }
            }
          }

          // 6. Omnigraph sync & branch merge
          if (isIsolatedExternalWorkspace(repoRoot)) {
            writeGraphHeadMeta(repoRoot, nodeSyncHostIo)
            recordTelemetry(options, {
              surface: isAntigravity ? "hook" : "cli",
              category: "graph_query",
              toolName: "omnigraph:merge-main",
              outcome: "ok",
              durationMs: 1,
              engineSource: "local",
            })
          } else {
            yield* ensureLocalOmnigraphReady(repoRoot)
            const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
            const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
            yield* diffOmnigraphBranches({
              repoRoot: clusterRepoRoot,
              source: taskBranches.implBranch,
              target: taskBranches.planBranch,
            }).pipe(
              Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)),
              Effect.orElseSucceed(() => Option.none()),
            )

            const merged = yield* mergeOmnigraphBranch({
              repoRoot: clusterRepoRoot,
              source: taskBranches.implBranch,
              target: taskBranches.mainBranch,
              cleanupBranches: [taskBranches.implBranch, taskBranches.planBranch],
            }).pipe(
              Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)),
              Effect.orElseSucceed(() => false),
            )
            writeGraphHeadMeta(repoRoot, nodeSyncHostIo)
            recordTelemetry(options, {
              surface: isAntigravity ? "hook" : "cli",
              category: "graph_query",
              toolName: "omnigraph:merge-main",
              outcome: merged ? "ok" : "fail",
              durationMs: 1,
              engineSource: merged ? "omnigraph" : "memory-fallback",
            })
            if (!merged) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  decision: blockDecision,
                  reason: `Omnigraph branch merge (${taskBranches.implBranch} -> ${taskBranches.mainBranch}) failed`,
                }),
                stderr: "",
              }
            }
          }

          if (options?.repoRoot !== undefined || process.env.VITEST === undefined) {
            const report = buildSessionReport({
              events: readTelemetryEvents(repoRoot, nodeSyncHostIo),
              frictionEvents: readFrictionEvents(repoRoot, nodeSyncHostIo),
              stampValid: true,
            })
            writeSessionReportFiles(repoRoot, report, nodeSyncHostIo)
          }

          return {
            exitCode: 0,
            stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
            stderr: "",
            telemetryDetail: "completed",
          }
        }),
      )
      .exhaustive()
  })
