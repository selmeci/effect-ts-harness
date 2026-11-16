import { join } from "node:path"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  isPureInterruptCause,
  NonNegativeCount,
  OmnigraphBranchName,
  type OmnigraphDiffChangeSummary,
  OmnigraphEntityId,
  type OmnigraphMergeConflictDetail,
  OmnigraphSpanName,
  OmnigraphTypeName,
} from "@harness/contract"
import { decideOmnigraphBranchVerify } from "@harness/gates"
import {
  diffOmnigraphBranches,
  dryRunMergeOmnigraphBranches,
  type HarnessGraph,
  makeOmnigraphSyncLayer,
  mergeOmnigraphBranch,
  resolveOmnigraphClusterDir,
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
  runOfflineOmnigraphLintGate,
  runOmnigraphOptimizeAndCleanup,
} from "./omnigraph-auth-and-drift.js"

const readIsStubFromImage = (
  image: { readonly properties: unknown } | null | undefined,
): boolean => {
  if (image === null || image === undefined) return false
  const props = image.properties
  if (typeof props !== "object" || props === null) return false
  return "isStub" in props && (props as { readonly isStub?: unknown }).isStub === true
}

const readSpanNameFromImages = (
  before: { readonly properties: unknown } | null | undefined,
  after: { readonly properties: unknown } | null | undefined,
): OmnigraphSpanName | undefined => {
  for (const image of [after, before]) {
    if (image === null || image === undefined) continue
    const props = image.properties
    if (typeof props !== "object" || props === null) continue
    if ("spanName" in props) {
      const candidate = (props as { readonly spanName?: unknown }).spanName
      const decoded = Schema.decodeUnknownOption(OmnigraphSpanName)(candidate)
      const matched = match(decoded)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      if (matched !== undefined) {
        return matched
      }
    }
  }
  return undefined
}

export const runVerifyOmnigraphLintCheck = (
  repoRoot: string,
): Effect.Effect<CliResult | undefined> =>
  Effect.gen(function* () {
    if (isIsolatedExternalWorkspace(repoRoot)) {
      return undefined
    }
    const lintRes = yield* runOfflineOmnigraphLintGate(resolveClusterRepoRoot(repoRoot))
    if (!lintRes.ok) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:omnigraph-lint\n${lintRes.message}`,
      }
    }
    return undefined
  })

export const runPostDoneOmnigraphCompact = (repoRoot: string): void => {
  if (isIsolatedExternalWorkspace(repoRoot)) return
  const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
  const clusterDir = resolveOmnigraphClusterDir(clusterRepoRoot, nodeSyncHostIo)
  if (nodeSyncHostIo.existsSync(clusterDir)) {
    runOmnigraphOptimizeAndCleanup(clusterDir)
  }
}

const isBranchNotFoundError = (err: unknown): boolean => {
  const inner =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { readonly cause?: unknown }).cause
      : err
  for (const candidate of [inner, err]) {
    if (typeof candidate === "object" && candidate !== null) {
      const httpStatus = Reflect.get(candidate, "status")
      const httpStatusCode = Reflect.get(candidate, "statusCode")
      const errName = Reflect.get(candidate, "name")
      const errCode = Reflect.get(candidate, "code")
      const errMessage = Reflect.get(candidate, "message")
      if (httpStatus === 404 || httpStatusCode === 404 || errName === "NotFoundError") {
        return true
      }
      if (
        typeof errCode === "string" &&
        /not[\s_-]*found|unknown[\s_-]*branch/i.test(errCode)
      ) {
        return true
      }
      if (
        typeof errMessage === "string" &&
        /404|not[\s_-]*found|unknown branch|does not exist/i.test(errMessage)
      ) {
        return true
      }
    }
  }
  return /404|not[\s_-]*found|unknown branch|does not exist/i.test(String(err))
}

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
): Effect.Effect<CliResult | undefined> =>
  Effect.gen(function* () {
    const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
    const syncLayer = makeOmnigraphSyncLayer(nodeSyncHostIo)
    const surface = isAntigravity ? "hook" : "cli"
    const failExitCode = isAntigravity ? 0 : 1
    const hasPlanSnapshot = nodeSyncHostIo.existsSync(
      join(repoRoot, ".harness", "plan-graph-snapshot.json"),
    )

    const branchDiffOpt = yield* diffOmnigraphBranches({
      repoRoot: clusterRepoRoot,
      source: taskBranches.implBranch,
      target: taskBranches.planBranch,
    }).pipe(
      Effect.provide(syncLayer),
      Effect.map((diff) => ({ _tag: "Ok" as const, diff })),
      Effect.catch((err) => {
        if (
          !hasPlanSnapshot &&
          taskBranches.planBranch !== taskBranches.mainBranch &&
          isBranchNotFoundError(err)
        ) {
          return diffOmnigraphBranches({
            repoRoot: clusterRepoRoot,
            source: taskBranches.implBranch,
            target: taskBranches.mainBranch,
          }).pipe(
            Effect.provide(syncLayer),
            Effect.map((diff) => ({ _tag: "Ok" as const, diff })),
            Effect.catch((fallbackErr) =>
              Effect.sync(() => {
                process.stderr.write(
                  `[harness:done] Omnigraph branch diff fallback failed: ${String(fallbackErr)}\n`,
                )
                return { _tag: "Err" as const }
              }),
            ),
          )
        }
        return Effect.sync(() => {
          process.stderr.write(`[harness:done] Omnigraph branch diff failed: ${String(err)}\n`)
          return { _tag: "Err" as const }
        })
      }),
    )

    const missingMergeBase = match(branchDiffOpt)
      .with({ _tag: "Err" }, () => true)
      .with({ _tag: "Ok" }, () => false)
      .exhaustive()

    const diffChanges: Array<OmnigraphDiffChangeSummary> = match(branchDiffOpt)
      .with({ _tag: "Err" }, () => [])
      .with({ _tag: "Ok" }, ({ diff }) =>
        diff.changes.map((c) => {
          const spanName = readSpanNameFromImages(c.before, c.after)
          return {
            entityKind: c.kind,
            typeName: OmnigraphTypeName.make(c.type.name),
            entityId: OmnigraphEntityId.make(c.id),
            op: c.op,
            wasStubBefore: readIsStubFromImage(c.before),
            stubAfter: readIsStubFromImage(c.after),
            ...(spanName !== undefined ? { spanName } : {}),
          }
        }),
      )
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
          const implEffectFnCount = diffChanges.filter(
            (c) => c.typeName === "EffectFn" && c.op !== "delete",
          ).length
          const remainingStubCount = diffChanges.filter(
            (c) => c.op !== "delete" && c.stubAfter,
          ).length

          const verifyReport = yield* decideOmnigraphBranchVerify({
            planBranch: OmnigraphBranchName.make(taskBranches.planBranch),
            implBranch: OmnigraphBranchName.make(taskBranches.implBranch),
            mainBranch: OmnigraphBranchName.make(taskBranches.mainBranch),
            diffChanges,
            dryRunConflicts: conflicts,
            implEffectFnCount: NonNegativeCount.make(implEffectFnCount),
            remainingStubCount: NonNegativeCount.make(remainingStubCount),
            ...(missingMergeBase ? { missingMergeBase: true } : {}),
          })

          return match(verifyReport)
            .with({ verdict: "clean" }, () => undefined)
            .with({ verdict: "violated" }, ({ violations }) => {
              const reason = violations.map((v) => `[${v.ruleId}] ${v.message}`).join("; ")
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
                exitCode: 1,
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
    const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
      repoRoot: resolveClusterRepoRoot(repoRoot),
      branch: taskBranches.implBranch,
      from: taskBranches.mainBranch,
      snapshotPath,
    }).pipe(
      Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)),
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
      writeGraphHeadMeta(
        repoRoot,
        nodeSyncHostIo,
        undefined,
        process.env,
        commitId !== undefined ? { omnigraphCommitId: commitId } : undefined,
      )
    }
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
    return yield* runPreMergeOmnigraphBranchVerify(repoRoot, taskBranches, false, "block", options)
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

    const verifyFailure = yield* runPreMergeOmnigraphBranchVerify(
      repoRoot,
      taskBranches,
      isAntigravity,
      blockDecision,
      options,
      startedAtMs,
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
