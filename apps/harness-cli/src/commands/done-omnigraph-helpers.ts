import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
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
    const startedAtMs = Date.now()
    const surface = isAntigravity ? "hook" : "cli"
    if (isIsolatedExternalWorkspace(repoRoot)) {
      writeGraphHeadMeta(repoRoot, nodeSyncHostIo)
      recordTelemetry(options, {
        surface,
        category: "graph_query",
        toolName: "omnigraph:merge-main",
        outcome: "ok",
        durationMs: Math.max(0, Date.now() - startedAtMs),
        engineSource: "local",
      })
      return undefined
    }

    const isReady = yield* ensureLocalOmnigraphReady(repoRoot)
    if (!isReady) {
      recordTelemetry(options, {
        surface,
        category: "graph_query",
        toolName: "omnigraph:merge-main",
        outcome: "fail",
        durationMs: Math.max(0, Date.now() - startedAtMs),
        engineSource: "omnigraph",
        detail: "omnigraph-server-not-ready",
      })
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: blockDecision,
          reason: "Omnigraph server is not ready",
        }),
        stderr: "",
      }
    }

    const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
    yield* diffOmnigraphBranches({
      repoRoot: clusterRepoRoot,
      source: taskBranches.implBranch,
      target: taskBranches.planBranch,
    }).pipe(
      Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)),
      Effect.catch((err) =>
        Effect.sync(() => {
          process.stderr.write(`[harness:done] Omnigraph branch diff warning: ${String(err)}\n`)
        }),
      ),
    )

    const mergeExit = yield* Effect.exit(
      mergeOmnigraphBranch({
        repoRoot: clusterRepoRoot,
        source: taskBranches.implBranch,
        target: taskBranches.mainBranch,
        cleanupBranches: [taskBranches.implBranch, taskBranches.planBranch],
      }).pipe(Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo))),
    )
    const mergeOutcome = match(mergeExit)
      .with({ _tag: "Success" }, () => ({
        ok: true,
        detail: undefined,
      }))
      .with({ _tag: "Failure" }, ({ cause }) => {
        const pretty = Cause.pretty(cause)
        process.stderr.write(`[harness:done] Omnigraph branch merge failed: ${pretty}\n`)
        return { ok: false, detail: pretty }
      })
      .exhaustive()

    if (mergeOutcome.ok) {
      writeGraphHeadMeta(repoRoot, nodeSyncHostIo)
    }
    recordTelemetry(options, {
      surface,
      category: "graph_query",
      toolName: "omnigraph:merge-main",
      outcome: mergeOutcome.ok ? "ok" : "fail",
      durationMs: Math.max(0, Date.now() - startedAtMs),
      engineSource: "omnigraph",
      ...(mergeOutcome.detail !== undefined ? { detail: mergeOutcome.detail } : {}),
    })
    if (!mergeOutcome.ok) {
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
