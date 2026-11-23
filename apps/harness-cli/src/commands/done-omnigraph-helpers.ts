import { join } from "node:path"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import {
  isPureInterruptCause,
  NonNegativeCount,
  OmnigraphBranchName,
  type OmnigraphDiffChangeSummary,
  OmnigraphEntityId,
  type OmnigraphMergeConflictDetail,
  OmnigraphTypeName,
} from "@harness/contract"
import { decideOmnigraphBranchVerify } from "@harness/gates"
import {
  diffOmnigraphBranches,
  dryRunMergeOmnigraphBranches,
  type HarnessGraph,
  loadGraphSnapshotEffect,
  makeOmnigraphSyncLayer,
  mergeOmnigraphBranch,
  resolveGitHeadState,
  resolveOmnigraphTaskBranches,
  syncToOmnigraphAndSnapshot,
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
import {
  computeSyncEmbeddingsForGraph,
  toSyncEmbeddingOptions,
} from "./omnigraph-embedding-sync-helper.js"
import { runOmnigraphMaintenance, runVerifyOmnigraphLintCheck } from "./omnigraph-lint-gate.js"
import {
  countImplEffectFns,
  formatDiffErrorMessage,
  isBranchNotFoundError,
  loadPlanEffectFnQualnames,
  readEffectFnStubAfterFromImage,
  readExistingSpanTraceBlobIfSpansMissing,
  readIsStubFromImage,
  readSpanNameFromImages,
  uploadAndVerifySpanTraceBlob,
} from "./omnigraph-safety-helpers.js"

export { isBranchNotFoundError, runOmnigraphMaintenance, runVerifyOmnigraphLintCheck }

export const runPreMergeOmnigraphBranchVerify = (
  repoRoot: string,
  taskBranches: {
    readonly planBranch: string
    readonly implBranch: string
    readonly mainBranch: "main"
  },
  isAntigravity: boolean,
  blockDecision: string,
  options?: CliEnv,
  startedAtMs: number = Date.now(),
  implGraph?: HarnessGraph,
): Effect.Effect<CliResult | undefined> =>
  Effect.gen(function* () {
    const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
    const syncLayer = makeOmnigraphSyncLayer(nodeSyncHostIo)
    const surface = isAntigravity ? "hook" : "cli"
    const failExitCode = isAntigravity ? 0 : 1
    const hasPlanSnapshot = nodeSyncHostIo.existsSync(
      join(repoRoot, ".harness", "plan-graph-snapshot.json"),
    )

    type BranchDiffOutcome =
      | {
          readonly _tag: "Ok"
          readonly diff: Effect.Success<ReturnType<typeof diffOmnigraphBranches>>
          readonly effectivePlanBranch: string
        }
      | { readonly _tag: "MissingMergeBase" }
      | { readonly _tag: "DiffFailed"; readonly message: string }

    const branchDiffOpt: BranchDiffOutcome = yield* diffOmnigraphBranches({
      repoRoot: clusterRepoRoot,
      source: taskBranches.implBranch,
      target: taskBranches.planBranch,
    }).pipe(
      Effect.provide(syncLayer),
      Effect.map((diff): BranchDiffOutcome => ({
        _tag: "Ok",
        diff,
        effectivePlanBranch: taskBranches.planBranch,
      })),
      Effect.catch((err): Effect.Effect<BranchDiffOutcome> => {
        if (!isBranchNotFoundError(err)) {
          const message = formatDiffErrorMessage(err)
          return Effect.sync(() => {
            process.stderr.write(`[harness:done] Omnigraph branch diff failed: ${message}\n`)
            return { _tag: "DiffFailed", message }
          })
        }
        if (!hasPlanSnapshot && taskBranches.planBranch !== taskBranches.mainBranch) {
          return diffOmnigraphBranches({
            repoRoot: clusterRepoRoot,
            source: taskBranches.implBranch,
            target: taskBranches.mainBranch,
          }).pipe(
            Effect.provide(syncLayer),
            Effect.map((diff): BranchDiffOutcome => {
              process.stderr.write(
                `[harness:done] Info: Omnigraph plan branch '${taskBranches.planBranch}' not found; comparing '${taskBranches.implBranch}' against '${taskBranches.mainBranch}' instead\n`,
              )
              return { _tag: "Ok", diff, effectivePlanBranch: taskBranches.mainBranch }
            }),
            Effect.catch((fallbackErr): Effect.Effect<BranchDiffOutcome> =>
              Effect.sync(() => {
                const message = formatDiffErrorMessage(fallbackErr)
                process.stderr.write(
                  `[harness:done] Omnigraph branch diff fallback failed: ${message}\n`,
                )
                return isBranchNotFoundError(fallbackErr)
                  ? { _tag: "MissingMergeBase" }
                  : { _tag: "DiffFailed", message }
              }),
            ),
          )
        }
        return Effect.sync(() => {
          process.stderr.write(
            `[harness:done] Omnigraph branch diff missing merge base: ${formatDiffErrorMessage(err)}\n`,
          )
          return { _tag: "MissingMergeBase" }
        })
      }),
    )

    const diffFailureResult: CliResult | undefined = match(branchDiffOpt)
      .with({ _tag: "DiffFailed" }, ({ message }) => {
        recordTelemetry(options, {
          surface,
          category: "graph_query",
          toolName: "omnigraph:merge-main",
          outcome: "fail",
          durationMs: Math.max(0, Date.now() - startedAtMs),
          engineSource: "omnigraph",
          detail: message,
        })
        return {
          exitCode: failExitCode,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: `Omnigraph branch diff failed: ${message}`,
          }),
          stderr: `[GATE FAILURE] done:omnigraph-branch-diff\n${message}`,
        }
      })
      .with({ _tag: "MissingMergeBase" }, { _tag: "Ok" }, () => undefined)
      .exhaustive()
    if (diffFailureResult !== undefined) {
      return diffFailureResult
    }

    const effectivePlanBranch = match(branchDiffOpt)
      .with({ _tag: "Ok" }, (ok) => ok.effectivePlanBranch)
      .with({ _tag: "DiffFailed" }, { _tag: "MissingMergeBase" }, () => taskBranches.planBranch)
      .exhaustive()

    const shouldLoadPlanSnapshot = match(branchDiffOpt)
      .with(
        { _tag: "Ok" },
        ({ diff }) =>
          hasPlanSnapshot &&
          effectivePlanBranch === taskBranches.planBranch &&
          diff.changes.some((c) => c.type.name === "EffectFn" && c.op === "delete"),
      )
      .with({ _tag: "DiffFailed" }, { _tag: "MissingMergeBase" }, () => false)
      .exhaustive()

    const planEffectFnQualnames = shouldLoadPlanSnapshot
      ? yield* loadPlanEffectFnQualnames(
          join(repoRoot, ".harness", "plan-graph-snapshot.json"),
          nodeSyncHostIo,
        )
      : undefined

    const diffState = match(branchDiffOpt)
      .with({ _tag: "DiffFailed" }, { _tag: "MissingMergeBase" }, () => ({
        _tag: "MissingMergeBase" as const,
      }))
      .with({ _tag: "Ok" }, ({ diff }) => {
        const changes: Array<OmnigraphDiffChangeSummary> = diff.changes.map((c) => {
          const spanName = readSpanNameFromImages(c.before, c.after) ?? null
          const entityId = OmnigraphEntityId.make(c.id)
          if (c.type.name === "EffectFn") {
            return match(c.op)
              .with("insert", () => ({
                _tag: "EffectFnInserted" as const,
                entityId,
                stubAfter: readEffectFnStubAfterFromImage(c.after),
                spanName,
              }))
              .with("update", () => ({
                _tag: "EffectFnUpdated" as const,
                entityId,
                wasStubBefore: readIsStubFromImage(c.before),
                stubAfter: readEffectFnStubAfterFromImage(c.after),
                spanName,
              }))
              .with("delete", () =>
                planEffectFnQualnames !== undefined && !planEffectFnQualnames.has(c.id)
                  ? {
                      _tag: "EntityDiffChange" as const,
                      entityKind: c.kind,
                      typeName: OmnigraphTypeName.make(c.type.name),
                      entityId,
                      op: c.op,
                    }
                  : {
                      _tag: "EffectFnDeleted" as const,
                      entityId,
                      wasStubBefore: readIsStubFromImage(c.before),
                      spanName,
                    },
              )
              .exhaustive()
          }
          return {
            _tag: "EntityDiffChange" as const,
            entityKind: c.kind,
            typeName: OmnigraphTypeName.make(c.type.name),
            entityId,
            op: c.op,
          }
        })
        const diffStubCount = changes.filter((ch) =>
          match(ch)
            .with({ _tag: "EffectFnInserted" }, { _tag: "EffectFnUpdated" }, (c) => c.stubAfter)
            .with({ _tag: "EffectFnDeleted" }, { _tag: "EntityDiffChange" }, () => false)
            .exhaustive(),
        ).length
        const counts = implGraph !== undefined ? countImplEffectFns(implGraph) : undefined
        const observedImplEffectFnCount =
          counts !== undefined ? NonNegativeCount.make(counts.implEffectFnCount) : null
        const unchangedStubCount =
          counts !== undefined
            ? NonNegativeCount.make(Math.max(0, counts.remainingStubCount - diffStubCount))
            : NonNegativeCount.make(0)
        return {
          _tag: "ResolvedDiff" as const,
          changes,
          observedImplEffectFnCount,
          unchangedStubCount,
        }
      })
      .exhaustive()

    const dryRunOutcome = yield* dryRunMergeOmnigraphBranches({
      repoRoot: clusterRepoRoot,
      source: OmnigraphBranchName.make(taskBranches.implBranch),
      target: OmnigraphBranchName.make(taskBranches.mainBranch),
    }).pipe(
      Effect.provide(syncLayer),
      Effect.map(() => ({
        _tag: "Ok" as const,
        conflicts: [] as ReadonlyArray<OmnigraphMergeConflictDetail>,
      })),
      Effect.catchTags({
        OmnigraphMergeConflictError: (err) =>
          Effect.succeed({ _tag: "Conflicts" as const, conflicts: err.conflicts }),
        OmnigraphLoadError: (err) =>
          Effect.succeed({
            _tag: "LoadErr" as const,
            message: err.cause instanceof Error ? err.cause.message : String(err.cause),
          }),
      }),
    )

    return yield* match(dryRunOutcome)
      .with({ _tag: "LoadErr" }, ({ message }) => {
        recordTelemetry(options, {
          surface,
          category: "graph_query",
          toolName: "omnigraph:merge-main",
          outcome: "fail",
          durationMs: Math.max(0, Date.now() - startedAtMs),
          engineSource: "omnigraph",
          detail: message,
        })
        return Effect.succeed<CliResult | undefined>({
          exitCode: failExitCode,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: `Omnigraph dry-run merge failed: ${message}`,
          }),
          stderr: `[GATE FAILURE] done:omnigraph-dry-run-merge\n${message}`,
        })
      })
      .with({ _tag: "Ok" }, { _tag: "Conflicts" }, ({ conflicts }) =>
        Effect.gen(function* () {
          const verifyReport = yield* decideOmnigraphBranchVerify({
            planBranch: OmnigraphBranchName.make(effectivePlanBranch),
            implBranch: OmnigraphBranchName.make(taskBranches.implBranch),
            mainBranch: OmnigraphBranchName.make(taskBranches.mainBranch),
            diffState,
            dryRunConflicts: conflicts,
          })

          return match(verifyReport)
            .with({ verdict: "clean" }, () => undefined)
            .with({ verdict: "violated" }, ({ violations }) => {
              const reason = violations.map((v) => `[${v._tag}] ${v.message}`).join("; ")
              recordTelemetry(options, {
                surface,
                category: "graph_query",
                toolName: "omnigraph:merge-main",
                outcome: "fail",
                durationMs: Math.max(0, Date.now() - startedAtMs),
                engineSource: "omnigraph",
                detail: reason,
              })
              return {
                exitCode: failExitCode,
                stdout: JSON.stringify({
                  decision: blockDecision,
                  reason: `Omnigraph branch verification failed: ${reason}`,
                }),
                stderr: `[GATE FAILURE] done:omnigraph-branch-verify\n${reason}`,
              } satisfies CliResult
            })
            .exhaustive()
        }),
      )
      .exhaustive()
  })

export const syncVerifyImplToOmnigraph = (
  repoRoot: string,
  graph: HarnessGraph,
  snapshotPath: string,
  taskBranches: {
    readonly planBranch: string
    readonly implBranch: string
    readonly mainBranch: "main"
  },
  options: CliEnv | undefined,
): Effect.Effect<CliResult | undefined> =>
  Effect.gen(function* () {
    const startedAtMs = Date.now()
    const lintFail = yield* runVerifyOmnigraphLintCheck(repoRoot)
    if (lintFail !== undefined) return lintFail
    const omnigraphReady = yield* ensureLocalOmnigraphReady(repoRoot)
    if (!omnigraphReady) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Verification failed: Omnigraph server is not ready",
      }
    }
    const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
    const syncLayer = makeOmnigraphSyncLayer(nodeSyncHostIo)
    const embeddingResult = yield* computeSyncEmbeddingsForGraph(repoRoot, graph, options)
    const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
      repoRoot: clusterRepoRoot,
      branch: taskBranches.implBranch,
      from: taskBranches.mainBranch,
      snapshotPath,
      ...toSyncEmbeddingOptions(embeddingResult),
    }).pipe(
      Effect.provide(syncLayer),
      Effect.catchCause((cause) => {
        if (isPureInterruptCause(cause)) return Effect.interrupt
        return Effect.succeed({
          syncedToOmnigraph: false,
          snapshotPath,
          error: Cause.pretty(cause),
        })
      }),
    )
    if (syncRes.syncedToOmnigraph) {
      const commitId = "commitId" in syncRes ? syncRes.commitId : undefined
      const headState = resolveGitHeadState(repoRoot, nodeSyncHostIo)
      const savedMeta = writeGraphHeadMeta(
        repoRoot,
        nodeSyncHostIo,
        headState,
        process.env,
        commitId !== undefined ? { omnigraphCommitId: commitId } : undefined,
      )
      if (
        (headState.headSha !== null || headState.gitBranch !== null || commitId !== undefined) &&
        savedMeta === null
      ) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "Verification failed: could not persist graph head metadata (.harness/graph-head.json)",
        }
      }
      const blobFail = yield* uploadAndVerifySpanTraceBlob(
        repoRoot,
        clusterRepoRoot,
        taskBranches.implBranch,
        graph,
        syncLayer,
        "verify",
        1,
      )
      if (blobFail !== undefined) return blobFail
    }
    recordTelemetry(options, {
      surface: "cli",
      category: "graph_query",
      toolName: "omnigraph:sync-impl",
      outcome: syncRes.syncedToOmnigraph ? "ok" : "fail",
      durationMs: Math.max(0, Date.now() - startedAtMs),
      engineSource: syncRes.syncedToOmnigraph ? "omnigraph" : "omnigraph-failed",
    })
    if (!syncRes.syncedToOmnigraph) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Verification failed: could not sync implementation graph to Omnigraph${syncRes.error ? ` (${syncRes.error})` : ""}`,
      }
    }
    return yield* runPreMergeOmnigraphBranchVerify(
      repoRoot,
      taskBranches,
      false,
      "block",
      options,
      startedAtMs,
      graph,
    )
  })

export const syncOmnigraphOnDone = (
  repoRoot: string,
  options: CliEnv | undefined,
  isAntigravity: boolean,
  blockDecision: string,
): Effect.Effect<CliResult | undefined> =>
  Effect.gen(function* () {
    const startedAtMs = Date.now()
    const surface = isAntigravity ? "hook" : "cli"
    const failExitCode = isAntigravity ? 0 : 1
    if (isIsolatedExternalWorkspace(repoRoot)) {
      const headState = resolveGitHeadState(repoRoot, nodeSyncHostIo)
      const savedMeta = writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
      if ((headState.headSha !== null || headState.gitBranch !== null) && savedMeta === null) {
        return {
          exitCode: failExitCode,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: "Failed to persist graph head metadata (.harness/graph-head.json)",
          }),
          stderr: "[GATE FAILURE] done:graph-head-meta\nFailed to persist .harness/graph-head.json",
        }
      }
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
        exitCode: failExitCode,
        stdout: JSON.stringify({
          decision: blockDecision,
          reason: "Omnigraph server is not ready",
        }),
        stderr: "",
      }
    }

    const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
    const syncLayer = makeOmnigraphSyncLayer(nodeSyncHostIo)

    let implGraph: HarnessGraph | undefined
    const snapshotPath = join(repoRoot, ".harness", "graph-snapshot.json")
    if (nodeSyncHostIo.existsSync(snapshotPath)) {
      const loadExit = yield* Effect.exit(loadGraphSnapshotEffect(snapshotPath, nodeSyncHostIo))
      const loaded = match(loadExit)
        .with({ _tag: "Success" }, ({ value }) => ({ ok: true as const, graph: value }))
        .with({ _tag: "Failure" }, ({ cause }) => ({
          ok: false as const,
          message: Cause.pretty(cause),
        }))
        .exhaustive()
      if (!loaded.ok) {
        recordTelemetry(options, {
          surface,
          category: "graph_query",
          toolName: "omnigraph:merge-main",
          outcome: "fail",
          durationMs: Math.max(0, Date.now() - startedAtMs),
          engineSource: "omnigraph",
          detail: loaded.message,
        })
        return {
          exitCode: failExitCode,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: `Failed to load .harness/graph-snapshot.json: ${loaded.message}`,
          }),
          stderr: `[GATE FAILURE] done:omnigraph-snapshot-load\n${loaded.message}`,
        }
      }
      implGraph = loaded.graph
      const preservedBlob = yield* readExistingSpanTraceBlobIfSpansMissing(
        repoRoot,
        clusterRepoRoot,
        taskBranches.implBranch,
        implGraph,
        syncLayer,
      )
      const doneEmbeddingRes = yield* computeSyncEmbeddingsForGraph(repoRoot, implGraph, options)
      const reloadRes = yield* syncToOmnigraphAndSnapshot(implGraph, {
        repoRoot: clusterRepoRoot,
        branch: taskBranches.implBranch,
        from: taskBranches.mainBranch,
        mode: "overwrite",
        snapshotPath,
        ...toSyncEmbeddingOptions(doneEmbeddingRes),
      }).pipe(
        Effect.provide(syncLayer),
        Effect.catchCause((cause) => {
          if (isPureInterruptCause(cause)) return Effect.interrupt
          return Effect.succeed({
            syncedToOmnigraph: false,
            snapshotPath,
            error: Cause.pretty(cause),
          })
        }),
      )
      if (!reloadRes.syncedToOmnigraph) {
        const errMsg = reloadRes.error ?? "unknown sync error"
        recordTelemetry(options, {
          surface,
          category: "graph_query",
          toolName: "omnigraph:merge-main",
          outcome: "fail",
          durationMs: Math.max(0, Date.now() - startedAtMs),
          engineSource: "omnigraph",
          detail: errMsg,
        })
        return {
          exitCode: failExitCode,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: `Failed to reload .harness/graph-snapshot.json to Omnigraph branch '${taskBranches.implBranch}': ${errMsg}`,
          }),
          stderr: `[GATE FAILURE] done:omnigraph-snapshot-sync\n${errMsg}`,
        }
      }
      const doneBlobFail = yield* uploadAndVerifySpanTraceBlob(
        repoRoot,
        clusterRepoRoot,
        taskBranches.implBranch,
        implGraph,
        syncLayer,
        "done",
        failExitCode,
        blockDecision,
        preservedBlob,
      )
      if (doneBlobFail !== undefined) return doneBlobFail
    }

    const verifyFailure = yield* runPreMergeOmnigraphBranchVerify(
      repoRoot,
      taskBranches,
      isAntigravity,
      blockDecision,
      options,
      startedAtMs,
      implGraph,
    )
    if (verifyFailure !== undefined) {
      return verifyFailure
    }

    const mergeExit = yield* Effect.exit(
      mergeOmnigraphBranch({
        repoRoot: clusterRepoRoot,
        source: taskBranches.implBranch,
        target: taskBranches.mainBranch,
        cleanupBranches: [taskBranches.implBranch, taskBranches.planBranch],
      }).pipe(Effect.provide(syncLayer)),
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
      const headState = resolveGitHeadState(repoRoot, nodeSyncHostIo)
      const savedMeta = writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
      if ((headState.headSha !== null || headState.gitBranch !== null) && savedMeta === null) {
        return {
          exitCode: failExitCode,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: "Failed to persist graph head metadata (.harness/graph-head.json) after merge",
          }),
          stderr: "[GATE FAILURE] done:graph-head-meta\nFailed to persist .harness/graph-head.json",
        }
      }
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
        exitCode: failExitCode,
        stdout: JSON.stringify({
          decision: blockDecision,
          reason: `Omnigraph branch merge (${taskBranches.implBranch} -> ${taskBranches.mainBranch}) failed`,
        }),
        stderr: "",
      }
    }
    return undefined
  })
