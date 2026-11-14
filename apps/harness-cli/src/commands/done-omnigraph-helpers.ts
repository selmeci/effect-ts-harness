import { Effect, Option } from "effect"
import {
  diffOmnigraphBranches,
  makeOmnigraphSyncLayer,
  mergeOmnigraphBranch,
  resolveOmnigraphTaskBranches,
  writeGraphHeadMeta,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import {
  type CliEnv,
  type CliResult,
  ensureLocalOmnigraphReady,
  isIsolatedExternalWorkspace,
  recordTelemetry,
  resolveClusterRepoRoot,
} from "./daemon-and-omnigraph.service.js"

export const syncOmnigraphOnDone = (
  repoRoot: string,
  options: CliEnv | undefined,
  isAntigravity: boolean,
  blockDecision: string,
): Effect.Effect<CliResult | undefined> =>
  Effect.gen(function* () {
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
      return undefined
    }

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
    if (merged) {
      writeGraphHeadMeta(repoRoot, nodeSyncHostIo)
    }
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
    return undefined
  })
