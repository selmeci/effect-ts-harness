import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { deterministicLearnFallback, IdiomRouterV1, proposeLearningAction } from "@harness/decision"
import {
  buildSessionHandoff,
  buildSessionReport,
  checkLoopThrashing,
  checkVerifyStamp,
  clearFrictionEvents,
  clearTelemetryEvents,
  decideOmnigraphReconcile,
  decidePlanSearch,
  decideRuleSynthesizer,
  diffPlanAndImplGraphs,
  PlanSearchInput,
  readFrictionEvents,
  readGraphHeadMeta,
  readTelemetryEvents,
  renderSessionReportMarkdown,
  resolveGitHeadState,
  resolveHarnessStateDir,
  resolveOmnigraphTaskBranches,
  RuleSynthesizerInput,
  scopeSessionReportInput,
  summarizeFrictionEvents,
  writeGraphHeadMeta,
  writeSessionReportFiles,
} from "@harness/gates"
import {
  extractWorkspaceTypeAwareGraph,
  type GraphSnapshotError,
  loadGraphSnapshotEffect,
  OmnigraphSync,
  saveGraphSnapshot,
  syncToOmnigraphAndSnapshot,
} from "@harness/graph"
import { buildWorkspaceFnIndex } from "@harness/ingest"
import {
  type CliEnv,
  type CliResult,
  ensureLocalOllamaReady,
  ensureLocalOmnigraphReady,
  findWorkspaceRoot,
  isIsolatedExternalWorkspace,
  resolveClusterRepoRoot,
} from "./daemon-and-omnigraph.service.js"

export const handleDoctorOrSession = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const isAntigravity = argv.includes("--format=antigravity")
    const nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10)
    const nodeOk = nodeMajor >= 24

    const harnessDir = resolveHarnessStateDir(repoRoot)
    const snapshotDirOk = yield* Effect.try({
      try: () => {
        if (!existsSync(harnessDir)) {
          mkdirSync(harnessDir, { recursive: true })
        }
        return true
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false))

    const isolatedExternal = isIsolatedExternalWorkspace(repoRoot)
    const omnigraphInitialized = isolatedExternal
      ? true
      : yield* ensureLocalOmnigraphReady(repoRoot)

    const requireLiveOllama =
      process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
      (!isolatedExternal &&
        options?.decisionLayer === undefined &&
        process.env.VITEST === undefined)
    const ollamaReady = requireLiveOllama ? yield* ensureLocalOllamaReady() : true

    const planPath = join(harnessDir, "plan-graph-snapshot.json")
    const implPath = join(harnessDir, "graph-snapshot.json")

    const headState = resolveGitHeadState(repoRoot)
    const recordedMeta = readGraphHeadMeta(repoRoot)
    if (!isolatedExternal || recordedMeta !== null) {
      const reconcileDecision = yield* decideOmnigraphReconcile({
        snapshotExists: existsSync(implPath),
        recordedHeadSha: recordedMeta?.headSha ?? null,
        currentHeadSha: headState.headSha,
        recordedGitBranch: recordedMeta?.gitBranch ?? null,
        currentGitBranch: headState.gitBranch,
      })
      if (reconcileDecision.needsReconcile) {
        const reconciledGraph = yield* extractWorkspaceTypeAwareGraph(repoRoot)
        if (isolatedExternal) {
          saveGraphSnapshot(reconciledGraph, implPath)
          writeGraphHeadMeta(repoRoot, headState)
        } else {
          yield* syncToOmnigraphAndSnapshot(reconciledGraph, {
            repoRoot: resolveClusterRepoRoot(repoRoot),
            branch: reconcileDecision.targetOmnigraphBranch,
            from: "main",
            snapshotPath: implPath,
          }).pipe(
            Effect.provide(OmnigraphSync.Live),
            Effect.orElseSucceed(() => ({
              syncedToOmnigraph: false,
              snapshotPath: implPath,
              error: undefined,
            })),
          )
          writeGraphHeadMeta(repoRoot, headState)
        }
      }
    }

    const workspaceRoot = findWorkspaceRoot()
    const tsconfigBasePath = existsSync(join(repoRoot, "tsconfig.base.json"))
      ? join(repoRoot, "tsconfig.base.json")
      : join(workspaceRoot, "tsconfig.base.json")
    const tsgoPkgPath = existsSync(
      join(repoRoot, "node_modules", "@effect", "tsgo", "package.json"),
    )
      ? join(repoRoot, "node_modules", "@effect", "tsgo", "package.json")
      : join(workspaceRoot, "node_modules", "@effect", "tsgo", "package.json")
    const effectLspOk = yield* Effect.try({
      try: () => {
        if (!existsSync(tsconfigBasePath) || !existsSync(tsgoPkgPath)) {
          return false
        }
        return readFileSync(tsconfigBasePath, "utf-8").includes("@effect/language-service")
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
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeedNone,
            ),
            Effect.provide(decisionLayer),
          ),
        )

    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)
    const activeStubs = Array.from(fnIndex.bySpanName.values())
      .filter((fn) => fn.isStub)
      .map((fn) => fn.spanName)

    let missingPlannedFns: ReadonlyArray<string> = []
    let snapshotOk = true
    if (existsSync(planPath) && existsSync(implPath)) {
      const loadSnap = (path: string, label: string) =>
        loadGraphSnapshotEffect(path).pipe(
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

    const stampCheck = checkVerifyStamp(repoRoot)
    const hasPlanOrStamp =
      existsSync(planPath) || existsSync(join(harnessDir, "verify-stamp.json"))
    const effectiveStampValid = hasPlanOrStamp ? stampCheck.valid : true
    const stampReason = !stampCheck.valid ? stampCheck.reason : undefined
    const rawFrictionEvents = readFrictionEvents(repoRoot)
    const telemetryEvents = readTelemetryEvents(repoRoot)
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
      if (handoff.handoffMessage !== null) injected.push(handoff.handoffMessage)
      return {
        exitCode: 0,
        stdout: JSON.stringify({ injectSteps: injected }),
        stderr: "",
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
        telemetry: {
          totalEvents: telemetryReport.totalEvents,
          healthScore: telemetryReport.healthScore,
          grade: telemetryReport.grade,
        },
      }),
      stderr: ok
        ? ""
        : `Doctor check failed: nodeOk=${nodeOk}, snapshotDirOk=${snapshotDirOk}, snapshotOk=${snapshotOk}, effectLspOk=${effectLspOk}, omnigraphInitialized=${omnigraphInitialized}, ollamaReady=${ollamaReady}`,
    }
  })

export const handleDoctor = handleDoctorOrSession
export const handleSession = handleDoctorOrSession

export const handleIngest = Effect.fn("Harness.ingestWorkspace")(function* (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.fn.Return<CliResult> {
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const isAntigravity = argv.includes("--format=antigravity")
  const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const snapshotPath = join(harnessDir, "graph-snapshot.json")
  const headState = resolveGitHeadState(repoRoot)
  const recordedMeta = readGraphHeadMeta(repoRoot)
  const reconcileDecision = yield* decideOmnigraphReconcile({
    snapshotExists: existsSync(snapshotPath),
    recordedHeadSha: recordedMeta?.headSha ?? null,
    currentHeadSha: headState.headSha,
    recordedGitBranch: recordedMeta?.gitBranch ?? null,
    currentGitBranch: headState.gitBranch,
  })

  if (!isAntigravity || reconcileDecision.needsReconcile) {
    const graph = yield* extractWorkspaceTypeAwareGraph(repoRoot)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot)
    const targetBranch =
      headState.gitBranch === null ||
      headState.gitBranch === "main" ||
      headState.gitBranch === "master"
        ? taskBranches.mainBranch
        : taskBranches.implBranch

    if (isIsolatedExternalWorkspace(repoRoot)) {
      saveGraphSnapshot(graph, snapshotPath)
      writeGraphHeadMeta(repoRoot, headState)
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

    yield* ensureLocalOmnigraphReady(repoRoot)
    const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
      repoRoot: resolveClusterRepoRoot(repoRoot),
      branch: targetBranch,
      from: taskBranches.mainBranch,
      snapshotPath,
    }).pipe(
      Effect.provide(OmnigraphSync.Live),
      Effect.orElseSucceed(() => ({
        syncedToOmnigraph: false,
        snapshotPath,
        error: undefined,
      })),
    )
    writeGraphHeadMeta(repoRoot, headState)
    return {
      exitCode: 0,
      stdout: isAntigravity
        ? JSON.stringify({})
        : JSON.stringify({
            indexedFns: fnIndex.bySpanName.size,
            syncedToOmnigraph: syncRes.syncedToOmnigraph,
            branch: targetBranch,
            headSha: headState.headSha,
            reconcileReason: reconcileDecision.reason,
          }),
      stderr: "",
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
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const shouldClear = argv.includes("--clear")
    const events = readFrictionEvents(repoRoot)
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

    let synthesizedRules: ReadonlyArray<unknown> = []
    const rejectedRules: Array<{ ruleId: string; stage: string; reason: string }> = []
    let planSearchResults: unknown = undefined
    const learnedSlicesPath = join(repoRoot, ".harness", "learned-slices.json")
    if (existsSync(learnedSlicesPath)) {
      const rawSlices = yield* Effect.try({
        try: () => readFileSync(learnedSlicesPath, "utf-8"),
        catch: () => undefined,
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
                for (const s of parsed["slices"]) {
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
                    .with({ _tag: "None" }, () => Effect.void)
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
                    decidePlanSearch(input).pipe(Effect.orElseSucceed(() => undefined)),
                  )
                  .with({ _tag: "None" }, () => Effect.void)
                  .exhaustive()
              }
            }),
          )
          .with({ _tag: "None" }, () => Effect.void)
          .exhaustive()
      }
    }

    if (shouldClear) {
      clearFrictionEvents(repoRoot)
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
      stderr: "",
    }
  })

export const handleReport = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.sync(() => {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    if (argv.includes("--reset") || argv.includes("--clear")) {
      clearTelemetryEvents(repoRoot)
    }
    const events = readTelemetryEvents(repoRoot)
    const frictionEvents = readFrictionEvents(repoRoot)
    const stampCheck = checkVerifyStamp(repoRoot)
    const report = buildSessionReport({
      events,
      frictionEvents,
      stampValid: stampCheck.valid,
      cumulative: argv.includes("--all"),
    })
    if (options?.repoRoot !== undefined || process.env.VITEST === undefined) {
      writeSessionReportFiles(repoRoot, report)
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
