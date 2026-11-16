import { join } from "node:path"
import { Cause, Effect, Option, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
import { deterministicLearnFallback, IdiomRouterV1, proposeLearningAction } from "@harness/decision"
import {
  buildSessionHandoff,
  buildSessionReport,
  checkLoopThrashing,
  checkVerifyStamp,
  clearFrictionEvents,
  clearTelemetryEvents,
  decidePlanSearch,
  decideRuleSynthesizer,
  diffPlanAndImplGraphs,
  PlanSearchInput,
  readFrictionEvents,
  readTelemetryEvents,
  renderSessionReportMarkdown,
  resolveHarnessStateDir,
  RuleSynthesizerInput,
  scopeSessionReportInput,
  summarizeFrictionEvents,
  writeSessionReportFiles,
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
import { nodeSyncHostIo } from "@harness/infra"
import { hasAntigravityFormat } from "./hook-format.js"
import { buildWorkspaceFnIndex } from "@harness/ingest"
import {
  type CliEnv,
  type CliResult,
  ensureLocalOllamaReady,
  ensureLocalOmnigraphReady,
  findWorkspaceRoot,
  isIsolatedExternalWorkspace,
  resolveClusterRepoRoot,
  resolveDecisionModelLayer,
} from "./daemon-and-omnigraph.service.js"

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

    const harnessDir = resolveHarnessStateDir(repoRoot)
    const snapshotDirOk = yield* Effect.try({
      try: () => {
        if (!nodeSyncHostIo.existsSync(harnessDir)) {
          nodeSyncHostIo.mkdirRecursiveSync(harnessDir)
        }
        return true
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false))

    const isolatedExternal = isIsolatedExternalWorkspace(repoRoot)
    let omnigraphInitialized = isolatedExternal
      ? true
      : yield* ensureLocalOmnigraphReady(repoRoot)
    let reconcileError: string | undefined

    const requireLiveOllama =
      process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
      (!isolatedExternal &&
        options?.decisionLayer === undefined &&
        options?.skipBackgroundDaemons !== true)
    const ollamaReady = requireLiveOllama ? yield* ensureLocalOllamaReady() : true

    const planPath = join(harnessDir, "plan-graph-snapshot.json")
    const implPath = join(harnessDir, "graph-snapshot.json")

    const headState = resolveGitHeadState(repoRoot, nodeSyncHostIo)
    const recordedMeta = readGraphHeadMeta(repoRoot, nodeSyncHostIo)
    if (!isolatedExternal || recordedMeta !== null) {
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
          writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
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
            writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
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
    const tsgoPkgPath = nodeSyncHostIo.existsSync(
      join(repoRoot, "node_modules", "@effect", "tsgo", "package.json"),
    )
      ? join(repoRoot, "node_modules", "@effect", "tsgo", "package.json")
      : join(workspaceRoot, "node_modules", "@effect", "tsgo", "package.json")
    const effectLspOk = yield* Effect.try({
      try: () => {
        if (!nodeSyncHostIo.existsSync(tsconfigBasePath) || !nodeSyncHostIo.existsSync(tsgoPkgPath)) {
          return false
        }
        return nodeSyncHostIo.readTextSync(tsconfigBasePath).includes("@effect/language-service")
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false))

    const modelWarm = isAntigravity
      ? ollamaReady
      : ollamaReady &&
        Option.isSome(
          yield* DecisionModel.decide(IdiomRouterV1, {
            input: { planStep: "Initialize session" },
          }).pipe(
            Effect.timeoutOption("10 seconds"),
            Effect.catchCause((cause) => {
              if (isPureInterruptCause(cause)) return Effect.interrupt
              return Effect.sync(() => {
                process.stderr.write(`[harness learn] decision model fallback: ${Cause.pretty(cause)}\n`)
              }).pipe(Effect.as(Option.none()))
            }),
            Effect.provide(decisionLayer),
          ),
        )

    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot, nodeSyncHostIo)
    const activeStubs = Array.from(fnIndex.bySpanName.values())
      .filter((fn) => fn.isStub)
      .map((fn) => fn.spanName)

    let missingPlannedFns: ReadonlyArray<string> = []
    let snapshotOk = true
    if (nodeSyncHostIo.existsSync(planPath) && nodeSyncHostIo.existsSync(implPath)) {
      const loadSnap = (path: string, label: string) =>
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
      const planLoad = yield* loadSnap(planPath, "plan")
      const implLoad = yield* loadSnap(implPath, "implementation")

      missingPlannedFns = match({ planLoad, implLoad })
        .with({ planLoad: { _tag: "Err" } }, ({ planLoad: { err } }) => {
          snapshotOk = false
          return [`Corrupt plan graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`]
        })
        .with({ implLoad: { _tag: "Err" } }, ({ implLoad: { err } }) => {
          snapshotOk = false
          return [
            `Corrupt implementation graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`,
          ]
        })
        .with({ planLoad: { _tag: "Ok" }, implLoad: { _tag: "Ok" } }, ({ planLoad, implLoad }) => {
          const diff = diffPlanAndImplGraphs(planLoad.graph, implLoad.graph)
          return diff.ok ? [] : diff.reasons
        })
        .exhaustive()
    }

    const stampCheck = checkVerifyStamp(repoRoot, nodeSyncHostIo)
    const hasPlanOrStamp =
      nodeSyncHostIo.existsSync(planPath) ||
      nodeSyncHostIo.existsSync(join(harnessDir, "verify-stamp.json"))
    const effectiveStampValid = hasPlanOrStamp ? stampCheck.valid : true
    const stampReason = !stampCheck.valid ? stampCheck.reason : undefined
    const rawFrictionEvents = readFrictionEvents(repoRoot, nodeSyncHostIo)
    const telemetryEvents = readTelemetryEvents(repoRoot, nodeSyncHostIo)
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

    const telemetryReport = buildSessionReport({
      events: telemetryEvents,
      frictionEvents: rawFrictionEvents,
      stampValid: effectiveStampValid,
    })

    const ok =
      nodeOk && snapshotDirOk && snapshotOk && effectLspOk && omnigraphInitialized && ollamaReady

    if (isAntigravity) {
      const injected: Array<string> = []
      if (!ollamaReady) {
        injected.push(
          "[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is offline and could not be started automatically. Stop all implementation immediately and inform the user.",
        )
      }
      if (!snapshotOk) injected.push(...missingPlannedFns)
      if (reconcileError !== undefined) {
        injected.push(`[harness:session] Warning: Omnigraph reconcile sync failed: ${reconcileError}`)
      }
      if (handoff.handoffMessage !== null) injected.push(handoff.handoffMessage)
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          injectSteps: injected,
          ...(reconcileError !== undefined ? { reconcileError } : {}),
        }),
        stderr:
          reconcileError !== undefined
            ? `[harness:session] Warning: Omnigraph reconcile sync failed: ${reconcileError}`
            : "",
      }
    }

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
        handoff,
        ...(reconcileError !== undefined ? { reconcileError } : {}),
        telemetry: {
          totalEvents: telemetryReport.totalEvents,
          healthScore: telemetryReport.healthScore,
          grade: telemetryReport.grade,
        },
      }),
      stderr: ok
        ? ""
        : `Doctor check failed: nodeOk=${nodeOk}, snapshotDirOk=${snapshotDirOk}, snapshotOk=${snapshotOk}, effectLspOk=${effectLspOk}, omnigraphInitialized=${omnigraphInitialized}, ollamaReady=${ollamaReady}${reconcileError !== undefined ? `, reconcileError=${reconcileError}` : ""}`,
    }
  })

export const handleDoctor = handleDoctorOrSession
export const handleSession = handleDoctorOrSession

export const handleIngest = Effect.fn("Harness.ingestWorkspace")(function* (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.fn.Return<CliResult> {
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const isAntigravity = hasAntigravityFormat(argv)
  const fnIndex = yield* buildWorkspaceFnIndex(repoRoot, nodeSyncHostIo)
  const harnessDir = resolveHarnessStateDir(repoRoot)
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
      writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
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
      writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
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
})

export const handleLearn = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const shouldClear = argv.includes("--clear")
    const events = readFrictionEvents(repoRoot, nodeSyncHostIo)
    const clusters = summarizeFrictionEvents(events)
    const proposals = []
    let useFastFallback =
      (shouldClear && options?.decisionLayer === undefined) || argv.includes("--deterministic")

    for (const cluster of clusters) {
      const input = {
        kind: cluster.kind,
        summary: cluster.summary,
        detail: cluster.detail,
        occurrences: cluster.occurrences,
      }
      const proposal = useFastFallback
        ? deterministicLearnFallback(input)
        : yield* proposeLearningAction(input).pipe(Effect.provide(decisionLayer))
      if (proposal.source === "deterministic-fallback") {
        useFastFallback = true
      }
      proposals.push({
        key: cluster.key,
        kind: cluster.kind,
        summary: cluster.summary,
        occurrences: cluster.occurrences,
        lastSeen: cluster.lastSeen,
        ...proposal,
      })
    }

    const warnings: Array<string> = []
    const warnLearn = (msg: string): void => {
      warnings.push(msg)
      process.stderr.write(`[harness:learn] Warning: ${msg}\n`)
    }
    let synthesizedRules: ReadonlyArray<unknown> = []
    const rejectedRules: Array<{ ruleId: string; stage: string; reason: string }> = []
    let planSearchResults: unknown = undefined
    const learnedSlicesPath = join(repoRoot, ".harness", "learned-slices.json")
    if (nodeSyncHostIo.existsSync(learnedSlicesPath)) {
      const rawSlices = yield* Effect.try({
        try: () => nodeSyncHostIo.readTextSync(learnedSlicesPath),
        catch: (err) => {
          warnLearn(
            `failed to read ${learnedSlicesPath}: ${err instanceof Error ? err.message : String(err)}`,
          )
          return undefined
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (rawSlices !== undefined) {
        const decodeJson = Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )
        const parsedOpt = decodeJson(rawSlices)
        yield* match(parsedOpt)
          .with({ _tag: "Some" }, ({ value: parsed }) =>
            Effect.gen(function* () {
              if (Array.isArray(parsed["slices"])) {
                const rules: Array<unknown> = []
                for (let idx = 0; idx < parsed["slices"].length; idx++) {
                  const s = parsed["slices"][idx]
                  const decodedSlice = Schema.decodeUnknownOption(RuleSynthesizerInput)(s)
                  yield* match(decodedSlice)
                    .with({ _tag: "Some" }, ({ value: slice }) =>
                      Effect.gen(function* () {
                        const synthRes = yield* decideRuleSynthesizer(slice).pipe(
                          Effect.map((report) => ({ _tag: "Ok" as const, report })),
                          Effect.catchTag("RuleSynthesisError", (err) =>
                            Effect.succeed({ _tag: "Err" as const, err }),
                          ),
                        )
                        match(synthRes)
                          .with({ _tag: "Ok" }, ({ report }) => {
                            rules.push(report)
                          })
                          .with({ _tag: "Err" }, ({ err }) => {
                            rejectedRules.push({
                              ruleId: String(slice.taskId),
                              stage: err.stage ?? "unknown",
                              reason: err.reason ?? err.message,
                            })
                          })
                          .exhaustive()
                      }),
                    )
                    .with({ _tag: "None" }, () =>
                      Effect.sync(() => {
                        warnLearn(
                          `invalid RuleSynthesizerInput at slices[${idx}] in ${learnedSlicesPath}`,
                        )
                      }),
                    )
                    .exhaustive()
                }
                synthesizedRules = rules
              }
              if (Array.isArray(parsed["candidates"])) {
                const rawPlanInput: unknown = {
                  candidates: parsed["candidates"],
                  requireZeroViolations: false,
                }
                const decodedPlanSearch = Schema.decodeUnknownOption(PlanSearchInput)(rawPlanInput)
                planSearchResults = yield* match(decodedPlanSearch)
                  .with({ _tag: "Some" }, ({ value: input }) =>
                    decidePlanSearch(input).pipe(
                      Effect.catch((err) =>
                        Effect.sync(() => {
                          warnLearn(`decidePlanSearch failed: ${String(err)}`)
                          return undefined
                        }),
                      ),
                    ),
                  )
                  .with({ _tag: "None" }, () =>
                    Effect.sync(() => {
                      warnLearn(`invalid PlanSearchInput candidates in ${learnedSlicesPath}`)
                      return undefined
                    }),
                  )
                  .exhaustive()
              }
            }),
          )
          .with({ _tag: "None" }, () =>
            Effect.sync(() => {
              warnLearn(`failed to decode ${learnedSlicesPath} as JSON object`)
            }),
          )
          .exhaustive()
      }
    }

    if (shouldClear) {
      clearFrictionEvents(repoRoot, nodeSyncHostIo)
    }

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        totalEvents: events.length,
        proposals,
        cleared: shouldClear,
        ...(synthesizedRules.length > 0 ? { synthesizedRules } : {}),
        ...(rejectedRules.length > 0 ? { rejectedRules } : {}),
        ...(planSearchResults !== undefined ? { planSearchResults } : {}),
      }),
      stderr: warnings.join("\n"),
    }
  })

export const handleReport = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.sync(() => {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    if (argv.includes("--reset") || argv.includes("--clear")) {
      clearTelemetryEvents(repoRoot, nodeSyncHostIo)
    }
    const events = readTelemetryEvents(repoRoot, nodeSyncHostIo)
    const frictionEvents = readFrictionEvents(repoRoot, nodeSyncHostIo)
    const stampCheck = checkVerifyStamp(repoRoot, nodeSyncHostIo)
    const report = buildSessionReport({
      events,
      frictionEvents,
      stampValid: stampCheck.valid,
      cumulative: argv.includes("--all"),
    })
    if (options?.repoRoot !== undefined || options?.skipAutoSessionReport !== true) {
      writeSessionReportFiles(repoRoot, report, nodeSyncHostIo)
    }
    if (argv.includes("--format=markdown")) {
      return {
        exitCode: 0,
        stdout: renderSessionReportMarkdown(report),
        stderr: "",
      }
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(report),
      stderr: "",
    }
  })
