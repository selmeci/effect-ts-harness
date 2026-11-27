import { join } from "node:path"
import { Cause, Effect, Option } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
import { IdiomRouterV1 } from "@harness/decision"
import {
  buildSessionHandoff,
  buildSessionReport,
  checkLoopThrashing,
  checkVerifyStamp,
  diffPlanAndImplGraphs,
  scopeSessionReportInput,
  summarizeFrictionEvents,
} from "@harness/gates"
import {
  decideOmnigraphReconcile,
  extractWorkspaceTypeAwareGraph,
  type GraphSnapshotError,
  loadGraphSnapshotEffect,
  makeOmnigraphSyncLayer,
  readGraphHeadMeta,
  resolveGitHeadState,
  resolveOmnigraphTaskBranches,
  saveGraphSnapshot,
  syncToOmnigraphAndSnapshot,
  writeGraphHeadMeta,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import { hasAntigravityFormat } from "./hook-format.js"
import { HarnessHookRuntime } from "./hook-runtime-loader.js"
import {
  handleLearn,
  handleReport,
  readFrictionEventsSafe,
  readTelemetryEventsSafe,
} from "./learn-and-report.command.js"
import { ensureLocalOllamaReadyDetailed } from "./ollama-readiness.js"
import {
  ensureHarnessDirSafe,
  resolveHarnessStateDirSafe,
  resolveHarnessTsgoPkgJsonPath,
  shouldRequireLiveOllama,
  tryCachePreInvocationResult,
} from "./session-fastpath.js"
import { buildWorkspaceFnIndex, findActiveWorkspaceStubs } from "@harness/ingest"
import { tryFastPathIngest } from "./ingest-fastpath.js"
import {
  type CliEnv,
  type CliResult,
  ensureLocalOmnigraphReady,
  findWorkspaceRoot,
  isIsolatedExternalWorkspace,
  resolveClusterRepoRoot,
  resolveDecisionModelLayer,
  shouldSuppressLiveRepoTestSideEffects,
} from "./daemon-and-omnigraph.service.js"

export { handleLearn, handleReport }

export const handleDoctorOrSession = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const isAntigravity = hasAntigravityFormat(argv)
    const nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10)
    const nodeOk = nodeMajor >= 24

    const suppressLiveWrites = shouldSuppressLiveRepoTestSideEffects(repoRoot)
    const harnessDirOpt = resolveHarnessStateDirSafe(repoRoot)
    const harnessDir = Option.getOrUndefined(harnessDirOpt)
    const snapshotDirOk =
      harnessDir !== undefined &&
      (suppressLiveWrites || ensureHarnessDirSafe(harnessDirOpt, nodeSyncHostIo))

    const isolatedExternal = isIsolatedExternalWorkspace(repoRoot)
    const skipOmnigraphReady = isolatedExternal || options?.skipBackgroundDaemons === true
    let omnigraphInitialized = skipOmnigraphReady
      ? true
      : yield* ensureLocalOmnigraphReady(repoRoot)
    let reconcileError: string | undefined

    const requireLiveOllama = shouldRequireLiveOllama(options, nodeSyncHostIo)
    const ollamaResult = requireLiveOllama
      ? yield* ensureLocalOllamaReadyDetailed({ includeEmbeddings: true })
      : ({ ready: true } as const)
    const ollamaReady = ollamaResult.ready
    const ollamaFailure = match(ollamaResult)
      .with({ ready: true }, () => undefined)
      .with({ ready: false }, ({ stage, reason }) => ({ stage, reason }))
      .exhaustive()
    const ollamaProbed = requireLiveOllama

    const planPath =
      harnessDir !== undefined ? join(harnessDir, "plan-graph-snapshot.json") : undefined
    const implPath = harnessDir !== undefined ? join(harnessDir, "graph-snapshot.json") : undefined

    const headState = resolveGitHeadState(repoRoot, nodeSyncHostIo)
    const recordedMeta = readGraphHeadMeta(repoRoot, nodeSyncHostIo)
    if (
      harnessDir !== undefined &&
      implPath !== undefined &&
      (!isolatedExternal || recordedMeta !== null) &&
      !suppressLiveWrites
    ) {
      const reconcileDecision = yield* decideOmnigraphReconcile({
        snapshotExists: nodeSyncHostIo.existsSync(implPath),
        recordedHeadSha: recordedMeta?.headSha ?? null,
        currentHeadSha: headState.headSha,
        recordedGitBranch: recordedMeta?.gitBranch ?? null,
        currentGitBranch: headState.gitBranch,
      })
      if (reconcileDecision.needsReconcile) {
        const reconciledGraph = yield* extractWorkspaceTypeAwareGraph(repoRoot, nodeSyncHostIo)
        if (isolatedExternal) {
          saveGraphSnapshot(reconciledGraph, implPath, nodeSyncHostIo)
          const savedMeta = writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
          if ((headState.headSha !== null || headState.gitBranch !== null) && savedMeta === null) {
            process.stderr.write(
              "[harness:session] Warning: failed to persist .harness/graph-head.json\n",
            )
          }
        } else {
          const reconcileSyncRes = yield* syncToOmnigraphAndSnapshot(reconciledGraph, {
            repoRoot: resolveClusterRepoRoot(repoRoot),
            branch: reconcileDecision.targetOmnigraphBranch,
            from: "main",
            snapshotPath: implPath,
          }).pipe(
            Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)),
            Effect.catchCause((cause) => {
              if (isPureInterruptCause(cause)) return Effect.interrupt
              return Effect.succeed({
                syncedToOmnigraph: false,
                snapshotPath: implPath,
                error: Cause.pretty(cause),
              })
            }),
          )
          if (reconcileSyncRes.syncedToOmnigraph) {
            const savedMeta = writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
            if (
              (headState.headSha !== null || headState.gitBranch !== null) &&
              savedMeta === null
            ) {
              process.stderr.write(
                "[harness:session] Warning: failed to persist .harness/graph-head.json\n",
              )
            }
          } else {
            omnigraphInitialized = false
            reconcileError = reconcileSyncRes.error ?? "unknown Omnigraph reconcile error"
          }
        }
      }
    }

    const workspaceRoot = findWorkspaceRoot()
    const tsconfigBasePath = nodeSyncHostIo.existsSync(join(repoRoot, "tsconfig.base.json"))
      ? join(repoRoot, "tsconfig.base.json")
      : join(workspaceRoot, "tsconfig.base.json")
    const tsgoPkgPath = resolveHarnessTsgoPkgJsonPath(repoRoot, nodeSyncHostIo)
    const effectLspOk = yield* Effect.try({
      try: () =>
        nodeSyncHostIo.existsSync(tsconfigBasePath) &&
        nodeSyncHostIo.existsSync(tsgoPkgPath) &&
        nodeSyncHostIo.readTextSync(tsconfigBasePath).includes("@effect/language-service"),
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false))

    const idiomaticDecisionOpt =
      isAntigravity || !ollamaReady
        ? Option.none()
        : yield* DecisionModel.decide(IdiomRouterV1, {
            input: { planStep: "Initialize session" },
          }).pipe(
            Effect.provide(decisionLayer),
            Effect.timeoutOption("10 seconds"),
            Effect.catchCause((cause) => {
              if (isPureInterruptCause(cause)) return Effect.interrupt
              return Effect.sync(() => {
                process.stderr.write(
                  `[harness learn] decision model fallback: ${Cause.pretty(cause)}\n`,
                )
              }).pipe(Effect.as(Option.none()))
            }),
          )
    const modelWarm = isAntigravity
      ? ollamaReady
      : ollamaReady &&
        match(idiomaticDecisionOpt)
          .with({ _tag: "Some" }, () => true)
          .with({ _tag: "None" }, () => false)
          .exhaustive()

    const activeStubs = isAntigravity
      ? yield* findActiveWorkspaceStubs(repoRoot, nodeSyncHostIo)
      : Array.from((yield* buildWorkspaceFnIndex(repoRoot, nodeSyncHostIo)).bySpanName.values())
          .filter((fn) => fn.isStub)
          .map((fn) => fn.spanName)

    let missingPlannedFns: ReadonlyArray<string> = []
    let snapshotOk = true
    const planExists =
      harnessDir !== undefined && planPath !== undefined && nodeSyncHostIo.existsSync(planPath)
    const implExists =
      harnessDir !== undefined && implPath !== undefined && nodeSyncHostIo.existsSync(implPath)
    if (planExists || implExists) {
      const loadSnap = (path: string, label: string) =>
        loadGraphSnapshotEffect(path, nodeSyncHostIo).pipe(
          Effect.map((graph) => ({ _tag: "Ok" as const, graph })),
          Effect.catchTag("GraphSnapshotError", (err: GraphSnapshotError) =>
            Effect.logError(
              `Failed to load ${label} graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`,
            ).pipe(Effect.as({ _tag: "Err" as const, err })),
          ),
        )
      const planLoad =
        planExists && planPath !== undefined
          ? yield* loadSnap(planPath, "plan")
          : ({ _tag: "Absent" as const } as const)
      const implLoad =
        implExists && implPath !== undefined
          ? yield* loadSnap(implPath, "implementation")
          : ({ _tag: "Absent" as const } as const)

      const snapshotErrors: Array<string> = []
      match(planLoad)
        .with({ _tag: "Err" }, ({ err }) => {
          snapshotOk = false
          snapshotErrors.push(
            `Corrupt plan graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`,
          )
        })
        .with({ _tag: "Ok" }, { _tag: "Absent" }, () => {})
        .exhaustive()

      match(implLoad)
        .with({ _tag: "Err" }, ({ err }) => {
          snapshotOk = false
          snapshotErrors.push(
            `Corrupt implementation graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`,
          )
        })
        .with({ _tag: "Ok" }, { _tag: "Absent" }, () => {})
        .exhaustive()

      missingPlannedFns =
        snapshotErrors.length > 0
          ? snapshotErrors
          : match({ planLoad, implLoad })
              .with(
                { planLoad: { _tag: "Ok" }, implLoad: { _tag: "Ok" } },
                ({ planLoad, implLoad }) => {
                  const diff = diffPlanAndImplGraphs(planLoad.graph, implLoad.graph)
                  return diff.ok ? [] : diff.reasons
                },
              )
              .otherwise(() => [])
    }

    const stampCheck =
      harnessDir !== undefined
        ? checkVerifyStamp(repoRoot, nodeSyncHostIo)
        : { valid: false as const, reason: "Invalid or unavailable HARNESS_STATE_DIR." }
    const hasPlanOrStamp =
      harnessDir !== undefined &&
      planPath !== undefined &&
      (nodeSyncHostIo.existsSync(planPath) ||
        nodeSyncHostIo.existsSync(join(harnessDir, "verify-stamp.json")))
    const effectiveStampValid = hasPlanOrStamp ? stampCheck.valid : true
    const stampReason = !stampCheck.valid ? stampCheck.reason : undefined
    const rawFrictionEvents = readFrictionEventsSafe(repoRoot, nodeSyncHostIo)
    const telemetryEvents =
      isAntigravity && rawFrictionEvents.length === 0
        ? []
        : readTelemetryEventsSafe(repoRoot, nodeSyncHostIo)
    const scoped = scopeSessionReportInput({
      events: telemetryEvents,
      frictionEvents: rawFrictionEvents,
    })
    const frictionClusters = summarizeFrictionEvents(scoped.frictionEvents)
    const loopThrashing = checkLoopThrashing(scoped.frictionEvents)

    const handoff = buildSessionHandoff({
      stampValid: effectiveStampValid,
      stampReason,
      activeStubs,
      missingPlannedFns,
      frictionClusters,
      loopThrashing,
    })

    const ok =
      nodeOk && snapshotDirOk && snapshotOk && effectLspOk && omnigraphInitialized && ollamaReady

    if (isAntigravity) {
      const injected: Array<string> = []
      const stderrWarnings: Array<string> = []
      if (!nodeOk) {
        const msg = `[harness:session] Warning: Node.js >= 24 is required (detected ${process.versions.node}).`
        injected.push(msg)
        stderrWarnings.push(msg)
      }
      if (!snapshotDirOk) {
        const msg =
          "[harness:session] Warning: Harness state/snapshot directory is unavailable or invalid (check HARNESS_STATE_DIR)."
        injected.push(msg)
        stderrWarnings.push(msg)
      }
      if (!effectLspOk) {
        const msg =
          "[harness:session] Warning: Effect language service (@effect/language-service / @effect/tsgo) is not configured or unavailable."
        injected.push(msg)
        stderrWarnings.push(msg)
      }
      if (!omnigraphInitialized && reconcileError === undefined) {
        const msg = "[harness:session] Warning: Omnigraph server is not ready or uninitialized."
        injected.push(msg)
        stderrWarnings.push(msg)
      }
      if (!ollamaReady) {
        const detail =
          ollamaFailure !== undefined
            ? ` (stage=${ollamaFailure.stage}: ${ollamaFailure.reason})`
            : ""
        const msg = `[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is offline and could not be started automatically. Stop all implementation immediately and inform the user.${detail}`
        injected.push(msg)
        stderrWarnings.push(msg)
      }
      if (!snapshotOk) {
        injected.push(...missingPlannedFns)
        stderrWarnings.push(...missingPlannedFns)
      }
      if (reconcileError !== undefined) {
        const msg = `[harness:session] Warning: Omnigraph reconcile sync failed: ${reconcileError}`
        injected.push(msg)
        stderrWarnings.push(msg)
      }
      if (handoff.handoffMessage !== null) injected.push(handoff.handoffMessage)
      const antigravityStderr = stderrWarnings.join("\n")
      if (
        !suppressLiveWrites &&
        harnessDir !== undefined &&
        snapshotOk &&
        (ok || ollamaReady) &&
        reconcileError === undefined &&
        options?.governanceDocs === undefined &&
        options?.planGraph === undefined &&
        options?.implGraph === undefined
      ) {
        tryCachePreInvocationResult(
          repoRoot,
          harnessDir,
          ollamaReady,
          ollamaProbed,
          injected,
          antigravityStderr,
          options,
          nodeSyncHostIo,
          !ok,
        )
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          injectSteps: injected,
          ...(reconcileError !== undefined ? { reconcileError } : {}),
        }),
        stderr: antigravityStderr,
        telemetryDetail: "cache=miss",
      }
    }

    const hookRuntime = match(yield* HarnessHookRuntime.load(repoRoot))
      .with({ _tag: "Snapshot" }, ({ snapshotDir, entryPath, packageMap }) => ({
        mode: "Snapshot" as const,
        snapshotDir,
        entryPath,
        packageCount: Object.keys(packageMap).length,
      }))
      .with({ _tag: "SourceFallback" }, ({ reason }) => ({
        mode: "SourceFallback" as const,
        reason,
      }))
      .exhaustive()

    const telemetryReport = buildSessionReport({
      events: telemetryEvents,
      frictionEvents: rawFrictionEvents,
      stampValid: effectiveStampValid,
    })

    return {
      exitCode: ok ? 0 : 1,
      stdout: JSON.stringify({
        nodeVersion: process.versions.node,
        nodeOk,
        snapshotDirOk,
        snapshotOk,
        effectLspOk,
        omnigraphInitialized,
        ollamaReady,
        modelWarm,
        hookRuntime,
        handoff,
        ...(ollamaFailure !== undefined ? { ollamaError: ollamaFailure } : {}),
        ...(reconcileError !== undefined ? { reconcileError } : {}),
        telemetry: {
          totalEvents: telemetryReport.totalEvents,
          healthScore: telemetryReport.healthScore,
          grade: telemetryReport.grade,
        },
      }),
      stderr: ok
        ? ""
        : `Doctor check failed: nodeOk=${nodeOk}, snapshotDirOk=${snapshotDirOk}, snapshotOk=${snapshotOk}, effectLspOk=${effectLspOk}, omnigraphInitialized=${omnigraphInitialized}, ollamaReady=${ollamaReady}${ollamaFailure !== undefined ? `, ollamaStage=${ollamaFailure.stage}, ollamaReason=${ollamaFailure.reason}` : ""}${reconcileError !== undefined ? `, reconcileError=${reconcileError}` : ""}`,
    }
  })

export const handleDoctor = handleDoctorOrSession
export const handleSession = handleDoctorOrSession

export const handleIngest = Effect.fn("Harness.ingestWorkspace")(function* (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.fn.Return<CliResult> {
  const fastHit = tryFastPathIngest(argv, options)
  return yield* match(fastHit)
    .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
    .with({ _tag: "None" }, () =>
      Effect.gen(function* () {
        const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
        const isAntigravity = hasAntigravityFormat(argv)
        const fnIndex = yield* buildWorkspaceFnIndex(repoRoot, nodeSyncHostIo)
        const harnessDir = Option.getOrUndefined(resolveHarnessStateDirSafe(repoRoot))
        if (harnessDir === undefined)
          return {
            exitCode: 1,
            stdout: JSON.stringify({ error: "Invalid HARNESS_STATE_DIR" }),
            stderr: "Invalid HARNESS_STATE_DIR\n",
          }
        const snapshotPath = join(harnessDir, "graph-snapshot.json")
        const headState = resolveGitHeadState(repoRoot, nodeSyncHostIo)
        const recordedMeta = readGraphHeadMeta(repoRoot, nodeSyncHostIo)
        const reconcileDecision = yield* decideOmnigraphReconcile({
          snapshotExists: nodeSyncHostIo.existsSync(snapshotPath),
          recordedHeadSha: recordedMeta?.headSha ?? null,
          currentHeadSha: headState.headSha,
          recordedGitBranch: recordedMeta?.gitBranch ?? null,
          currentGitBranch: headState.gitBranch,
        })

        if (!isAntigravity || reconcileDecision.needsReconcile) {
          const graph = yield* extractWorkspaceTypeAwareGraph(repoRoot, nodeSyncHostIo)
          const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
          const targetBranch =
            headState.gitBranch === null ||
            headState.gitBranch === "main" ||
            headState.gitBranch === "master"
              ? taskBranches.mainBranch
              : taskBranches.implBranch

          if (isIsolatedExternalWorkspace(repoRoot)) {
            saveGraphSnapshot(graph, snapshotPath, nodeSyncHostIo)
            const savedMeta = writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
            if (
              (headState.headSha !== null || headState.gitBranch !== null) &&
              savedMeta === null
            ) {
              process.stderr.write(
                "[harness:ingest] Warning: failed to persist .harness/graph-head.json\n",
              )
            }
            return {
              exitCode: 0,
              stdout: isAntigravity
                ? JSON.stringify({})
                : JSON.stringify({
                    indexedFns: fnIndex.bySpanName.size,
                    syncedToOmnigraph: false,
                    branch: targetBranch,
                    headSha: headState.headSha,
                    reconcileReason: reconcileDecision.reason,
                  }),
              stderr: "",
            }
          }

          const omnigraphReady = yield* ensureLocalOmnigraphReady(repoRoot)
          if (!omnigraphReady) {
            const msg = "Omnigraph server is not ready"
            return {
              exitCode: !isAntigravity ? 1 : 0,
              stdout: isAntigravity
                ? JSON.stringify({ error: msg })
                : JSON.stringify({
                    indexedFns: fnIndex.bySpanName.size,
                    syncedToOmnigraph: false,
                    branch: targetBranch,
                    headSha: headState.headSha,
                    error: msg,
                  }),
              stderr: `[harness:ingest] Omnigraph sync failed: ${msg}`,
            }
          }
          const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
            repoRoot: resolveClusterRepoRoot(repoRoot),
            branch: targetBranch,
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
            const savedMeta = writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
            if (
              (headState.headSha !== null || headState.gitBranch !== null) &&
              savedMeta === null
            ) {
              process.stderr.write(
                "[harness:ingest] Warning: failed to persist .harness/graph-head.json\n",
              )
            }
          }
          const syncError = syncRes.syncedToOmnigraph
            ? undefined
            : (syncRes.error ?? "unknown Omnigraph sync error")
          const stderr =
            syncError !== undefined ? `[harness:ingest] Omnigraph sync failed: ${syncError}` : ""
          return {
            exitCode: syncError !== undefined && !isAntigravity ? 1 : 0,
            stdout: isAntigravity
              ? JSON.stringify(syncError !== undefined ? { error: syncError } : {})
              : JSON.stringify({
                  indexedFns: fnIndex.bySpanName.size,
                  syncedToOmnigraph: syncRes.syncedToOmnigraph,
                  branch: targetBranch,
                  headSha: headState.headSha,
                  reconcileReason: reconcileDecision.reason,
                  ...(syncError !== undefined ? { error: syncError } : {}),
                }),
            stderr,
          }
        }

        return {
          exitCode: 0,
          stdout: isAntigravity
            ? JSON.stringify({})
            : JSON.stringify({
                indexedFns: fnIndex.bySpanName.size,
                syncedToOmnigraph: true,
                branch: reconcileDecision.targetOmnigraphBranch,
                headSha: headState.headSha,
                reconcileReason: reconcileDecision.reason,
              }),
          stderr: "",
        }
      }),
    )
    .exhaustive()
})
