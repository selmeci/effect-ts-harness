import { join } from "node:path"
import { Cause, Duration, Effect } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
import { checkPlanStepCoverage, triageFailure } from "@harness/decision"
import {
  buildSessionReport,
  checkLoopThrashing,
  checkVerifyStamp,
  decideOntologyInvariants,
  decideSpanBudgets,
  diffPlanAndImplGraphs,
  DstExecutionTier,
  DstStepCount,
  loadGovernanceDocsChecked,
  parseDstSeedEnv,
  readFrictionEvents,
  readTelemetryEvents,
  runDstSeedSuite,
  writeSessionReportFiles,
  writeVerifyStamp,
} from "@harness/gates"
import {
  checkEffectGraph,
  extractGraphViaCompilerOverlay,
  extractTypeGraph,
  findTestsReaching,
  type GraphSnapshotError,
  type HarnessGraph,
  loadGraphSnapshotEffect,
  makeTsCompilerOverlayLayer,
  resolveGitHeadState,
  resolveOmnigraphTaskBranches,
  saveGraphSnapshot,
  writeGraphHeadMeta,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { buildWorkspaceFnIndex } from "@harness/ingest"
import {
  type CliEnv,
  type CliResult,
  ensureLocalOllamaReady,
  findWorkspaceRoot,
  formatSubprocessError,
  isIsolatedExternalWorkspace,
  isRootConfigOrSharedCoreChange,
  makeReadStdinEffect,
  recordFriction,
  recordTelemetry,
  resolveDecisionModelLayer,
  resolveModifiedFilesSinceStampOrHead,
  resolveNxAffectedArgs,
  tryQueryWarmDaemonSocket,
} from "./daemon-and-omnigraph.service.js"
import {
  runOmnigraphMaintenance,
  syncOmnigraphOnDone,
  syncVerifyImplToOmnigraph,
} from "./done-omnigraph-helpers.js"
import {
  detectAntigravityHookPayload,
  hasAntigravityFormat,
  makeDoneBlockResult,
} from "./hook-format.js"
import {
  decodeStopHookStdin,
  inspectTranscriptSessionReadOnly,
  isSubagentStopContext,
  type StopHookStdin,
} from "./stop-hook-and-transcript.js"
import {
  buildDstTargetsFromGraph,
  readRecordedSpans,
  runDeltaAstAndPluginGates,
} from "./verify-delta-gates.js"

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

export const handleVerify = (
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    if (process.env.HARNESS_USE_DAEMON === "1") {
      yield* tryQueryWarmDaemonSocket(repoRoot, "ping")
    }
    const requireOllama =
      process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
      (!isIsolatedExternalWorkspace(repoRoot) &&
        options?.decisionLayer === undefined &&
        options?.skipBackgroundDaemons !== true)
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

    const modifiedResult = resolveModifiedFilesSinceStampOrHead(repoRoot)
    const deltaFilesOutcome = match(modifiedResult)
      .with({ _tag: "GitFailed" }, ({ reason }) => ({
        _tag: "GitFailed" as const,
        reason,
      }))
      .with({ _tag: "Resolved" }, ({ files }) => ({
        _tag: "Resolved" as const,
        files: files.filter(
          (f) =>
            (f.endsWith(".ts") || f.endsWith(".tsx")) &&
            nodeSyncHostIo.existsSync(join(repoRoot, f)),
        ),
      }))
      .exhaustive()
    const astGateFail = yield* runDeltaAstAndPluginGates(repoRoot, deltaFilesOutcome)
    const astGateResult = match(astGateFail)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (astGateResult !== undefined) return astGateResult
    const deltaFiles = match(deltaFilesOutcome)
      .with({ _tag: "Resolved" }, ({ files }) => files)
      .with({ _tag: "GitFailed" }, () => [] as ReadonlyArray<string>)
      .exhaustive()

    const graph = yield* extractGraphViaCompilerOverlay({ repoRoot }).pipe(
      Effect.provide(makeTsCompilerOverlayLayer(nodeSyncHostIo)),
      Effect.catchTag("TsCompilerOverlayError", (err) =>
        Effect.gen(function* () {
          process.stderr.write(
            `[harness:verify] Warning: TsCompilerOverlayService failed (${err.reason}); falling back to extractTypeGraph.\n`,
          )
          return yield* extractTypeGraph({ repoRoot, hostIo: nodeSyncHostIo })
        }),
      ),
    )
    const graphStubs: Array<string> = []
    for (const [, node] of Graph.nodes(graph.graph)) {
      match(node)
        .with({ _tag: "EffectFn" }, (n) => {
          if (n.isStub) graphStubs.push(n.spanName)
        })
        .with(
          { _tag: "ServiceTag" },
          { _tag: "ServiceLayer" },
          { _tag: "TaggedError" },
          { _tag: "SchemaDef" },
          { _tag: "VitestCase" },
          { _tag: "PatternDoc" },
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          () => undefined,
        )
        .exhaustive()
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

    const checkedDocs =
      options?.governanceDocs !== undefined
        ? { docs: options.governanceDocs, findings: [] }
        : loadGovernanceDocsChecked(repoRoot, nodeSyncHostIo)
    if (checkedDocs.findings.length > 0) {
      const msg = checkedDocs.findings
        .map((f) => `[${f.kind}] ${f.location ?? f.nodeId}: ${f.message}`)
        .join("\n")
      return verifyFailureWithThrashing(
        options,
        repoRoot,
        checkedDocs.findings[0]?.kind ?? "governance-doc-read-failed",
        msg,
        `Verification failed: unreadable governance docs\n${msg}`,
      )
    }
    const governanceDocs = checkedDocs.docs
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
    const syncStartedAtMs = Date.now()
    if (isIsolatedExternalWorkspace(repoRoot)) {
      saveGraphSnapshot(graph, snapshotPath, nodeSyncHostIo)
      const headState = resolveGitHeadState(repoRoot, nodeSyncHostIo)
      const savedMeta = writeGraphHeadMeta(repoRoot, nodeSyncHostIo, headState)
      if ((headState.headSha !== null || headState.gitBranch !== null) && savedMeta === null) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Verification failed: could not persist graph head metadata (.harness/graph-head.json)",
        }
      }
      recordTelemetry(options, {
        surface: "cli",
        category: "graph_query",
        toolName: "graph:snapshot-local",
        outcome: "ok",
        durationMs: Math.max(0, Date.now() - syncStartedAtMs),
        engineSource: "local",
        detail: "skipped-isolated-workspace",
      })
    } else {
      const verifySyncFail = yield* syncVerifyImplToOmnigraph(
        repoRoot,
        graph,
        snapshotPath,
        taskBranches,
        options,
      )
      if (verifySyncFail !== undefined) return verifySyncFail
    }

    if (!options?.skipSubprocessVerify && nodeSyncHostIo.existsSync(join(repoRoot, "package.json"))) {
      const leafFastPathEligible =
        deltaFiles.length > 0 && !isRootConfigOrSharedCoreChange(deltaFiles)
      const scopedFiles = leafFastPathEligible ? deltaFiles : undefined
      if (leafFastPathEligible) {
        for (const df of deltaFiles) findTestsReaching(graph, df)
      }
      const nxArgs = resolveNxAffectedArgs(repoRoot, ["verify"], scopedFiles)
      const subprocessErr = yield* Effect.try({
        try: () => {
          const res = nodeSyncHostIo.execFileSync("pnpm", nxArgs, {
            cwd: repoRoot,
            env: { ...process.env, CI: "true" },
          })
          return match(res)
            .with({ _tag: "Exited" }, (exited) =>
              exited.exitCode === 0 ? null : formatSubprocessError(exited),
            )
            .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, (err) =>
              formatSubprocessError(err),
            )
            .exhaustive()
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
          result: makeDoneBlockResult(isAntigravity, reason, "[GATE FAILURE] done:plan-graph-snapshot\n"),
        }
      })
      .with({ implLoad: { _tag: "Err" } }, ({ implLoad: { err } }) => {
        const reason = `Corrupt implementation graph snapshot at '${err.path}' [${err.reason}]: ${err.message}`
        return {
          _tag: "Done" as const,
          result: makeDoneBlockResult(isAntigravity, reason, "[GATE FAILURE] done:impl-graph-snapshot\n"),
        }
      })
      .with({ planLoad: { _tag: "Ok" }, implLoad: { _tag: "Ok" } }, ({ planLoad, implLoad }) => ({
        _tag: "Graphs" as const,
        planGraph: planLoad.graph,
        implGraph: implLoad.graph,
      }))
      .exhaustive()
  })

const parseDoneDeadlineMs = (): number => {
  const raw = process.env.HARNESS_DONE_DEADLINE_MS
  if (raw === undefined || raw.trim().length === 0) {
    return 23_000
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 23_000
}

export const handleDone = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> => {
  const entryStartedAtMs = Date.now()
  const totalDeadlineMs = parseDoneDeadlineMs()
  let isAntigravity =
    hasAntigravityFormat(argv) ||
    (options?.stdin !== undefined && detectAntigravityHookPayload(options.stdin))
  return Effect.gen(function* () {
    const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()

    let rawStdin = options?.stdin
    if (rawStdin === undefined && process.stdin.isTTY !== true) {
      const stdinTimeoutMs = Math.min(options?.stdinTimeoutMs ?? 4_000, Math.max(20, totalDeadlineMs))
      const stdinRes = yield* Effect.result(
        makeReadStdinEffect({
          timeoutMs: stdinTimeoutMs,
          maxBytes: options?.stdinMaxBytes,
        }),
      )
      const stdinErrResult = match(stdinRes)
        .with({ _tag: "Success" }, ({ success }) => {
          rawStdin = success
          if (detectAntigravityHookPayload(success)) {
            isAntigravity = true
            options?.hookStdinTracker?.markAntigravityDetected()
          }
          return undefined
        })
        .with({ _tag: "Failure" }, ({ failure }) => {
          const reason = `done: failed or timed out reading Stop hook stdin (${failure.reason})`
          return makeDoneBlockResult(isAntigravity, reason)
        })
        .exhaustive()
      if (stdinErrResult !== undefined) {
        return stdinErrResult
      }
    }
    if (rawStdin !== undefined && rawStdin.trim().length === 0) {
      return makeDoneBlockResult(isAntigravity, "done: empty Stop hook stdin payload")
    }
    let decodedStdin: StopHookStdin | undefined
    if (rawStdin !== undefined && rawStdin.trim().length > 0) {
      isAntigravity = isAntigravity || detectAntigravityHookPayload(rawStdin)
      const decoded = decodeStopHookStdin(rawStdin)
      const earlyResult = match(decoded)
        .with({ _tag: "Some" }, ({ value }) => {
          decodedStdin = value
          return value.fullyIdle === false
            ? ({ exitCode: 0, stdout: "", stderr: "", telemetryDetail: "fullyIdle=false" } satisfies CliResult)
            : undefined
        })
        .with({ _tag: "None" }, () =>
          makeDoneBlockResult(isAntigravity, "done: malformed Stop hook stdin JSON payload"),
        )
        .exhaustive()
      if (earlyResult !== undefined) {
        return earlyResult
      }
    }

    const blockDecision = isAntigravity ? "continue" : "block"
    const verificationEffect = Effect.gen(function* () {
      // 1. Subagent bypass
      if (isSubagentStopContext(repoRoot, decodedStdin)) {
        return { exitCode: 0, stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "", stderr: "", telemetryDetail: "subagent=true" }
      }
      // 2. Read-only turn bypass
      const readOnlyInspection = inspectTranscriptSessionReadOnly(decodedStdin)
      const corruptTranscriptNote = match(readOnlyInspection)
        .with({ _tag: "ReadOnly" }, () => "readOnly" as const)
        .with({ _tag: "Mutating" }, { _tag: "Unavailable" }, () => undefined)
        .with({ _tag: "Corrupt" }, ({ reason }) => {
          process.stderr.write(`[harness:done] ${reason}\n`)
          return reason
        })
        .exhaustive()
      if (corruptTranscriptNote === "readOnly") {
        return { exitCode: 0, stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "", stderr: "", telemetryDetail: "readOnly=true" }
      }
      const appendTranscriptNote = (reason: string): string =>
        corruptTranscriptNote !== undefined ? `${reason} (${corruptTranscriptNote})` : reason
      const transcriptStderr = corruptTranscriptNote !== undefined ? `[harness:done] ${corruptTranscriptNote}` : ""
      // 3. Verify stamp check
      const stampCheck = checkVerifyStamp(repoRoot, nodeSyncHostIo)
      if (!stampCheck.valid) {
        return { exitCode: 0, stdout: JSON.stringify({ decision: blockDecision, reason: appendTranscriptNote(stampCheck.reason) }), stderr: transcriptStderr }
      }

      const withTranscriptStderr = (res: CliResult): CliResult =>
        transcriptStderr.length === 0
          ? res
          : {
              ...res,
              stderr: res.stderr.length > 0 ? `${res.stderr}\n${transcriptStderr}` : transcriptStderr,
            }
      const snapshotOutcome = yield* loadSnapshotPair(repoRoot, options?.planGraph, options?.implGraph, isAntigravity)

      return yield* match(snapshotOutcome)
        .with({ _tag: "Done" }, ({ result }) => Effect.succeed(withTranscriptStderr(result)))
        .with({ _tag: "Graphs" }, ({ planGraph, implGraph }) =>
          Effect.gen(function* () {
            if (planGraph && implGraph) {
              const diff = diffPlanAndImplGraphs(planGraph, implGraph)
              if (!diff.ok) {
                return { exitCode: 0, stdout: JSON.stringify({ decision: blockDecision, reason: appendTranscriptNote(diff.reasons.join("; ")) }), stderr: transcriptStderr }
              }
            }
            if (options?.planSteps && options.planSteps.length > 0) {
              for (const step of options.planSteps) {
                const stepRes = yield* checkPlanStepCoverage(step).pipe(Effect.provide(decisionLayer))
                if (!stepRes.covered) {
                  return { exitCode: 0, stdout: JSON.stringify({ decision: blockDecision, reason: appendTranscriptNote(stepRes.reason) }), stderr: transcriptStderr }
                }
              }
            }
            const omnigraphFailure = yield* syncOmnigraphOnDone(repoRoot, options, isAntigravity, blockDecision)
            if (omnigraphFailure !== undefined) return withTranscriptStderr(omnigraphFailure)

            if (options?.repoRoot !== undefined || options?.skipAutoSessionReport !== true) {
              const report = buildSessionReport({
                events: readTelemetryEvents(repoRoot, nodeSyncHostIo),
                frictionEvents: readFrictionEvents(repoRoot, nodeSyncHostIo),
                stampValid: true,
              })
              writeSessionReportFiles(repoRoot, report, nodeSyncHostIo)
            }
            runOmnigraphMaintenance(repoRoot, { includeCleanup: true })
            return { exitCode: 0, stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "", stderr: transcriptStderr, telemetryDetail: "completed" }
          }),
        )
        .exhaustive()
    })

    const remainingDeadlineMs = Math.max(20, totalDeadlineMs - (Date.now() - entryStartedAtMs))
    const timedResult = yield* verificationEffect.pipe(Effect.timeoutOption(Duration.millis(remainingDeadlineMs)))
    return match(timedResult)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () =>
        makeDoneBlockResult(isAntigravity, `Stop hook verification exceeded internal deadline (${totalDeadlineMs}ms) — blocking premature termination.`),
      )
      .exhaustive()
  }).pipe(
    Effect.catchCause((cause) => {
      if (isPureInterruptCause(cause)) {
        return Effect.failCause(cause)
      }
      const pretty = Cause.pretty(cause)
      process.stderr.write(`[harness:done] uncaught cause: ${pretty}\n`)
      const reason = `done: uncaught error or defect (${pretty})`
      return Effect.succeed(makeDoneBlockResult(isAntigravity, reason, `${pretty}\n`))
    }),
  )
}
