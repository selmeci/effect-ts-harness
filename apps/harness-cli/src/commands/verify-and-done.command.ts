import { join } from "node:path"
import { Cause, Duration, Effect } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
import { checkPlanStepCoverage, triageFailure } from "@harness/decision"
import {
  checkVerifyStamp,
  decideOntologyInvariants,
  diffPlanAndImplGraphs,
  loadGovernanceDocsChecked,
} from "@harness/gates"
import {
  checkEffectGraph,
  extractGraphViaCompilerOverlay,
  extractTypeGraph,
  findTestsReaching,
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
  findWorkspaceRoot,
  formatSubprocessError,
  isIsolatedExternalWorkspace,
  isRootConfigOrSharedCoreChange,
  makeReadStdinEffect,
  recordTelemetry,
  resolveDecisionModelLayer,
  resolveModifiedFilesSinceStampOrHead,
  resolveNxAffectedArgs,
  tryQueryWarmDaemonSocket,
} from "./daemon-and-omnigraph.service.js"
import { ensureLocalOllamaReadyDetailed } from "./ollama-readiness.js"
import {
  appendTranscriptNote,
  executeDoneGraphAndStepChecks,
  hasDoneCliFlag,
  normalizeDoneResultForCli,
  withTranscriptStderr,
} from "./done-cli-helper.js"
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
  evaluateVerifyMutateStampGate,
  finalizeDoneSuccess,
  isAlreadyDoneForVerifiedTree,
  loadSnapshotPair,
  parseDoneDeadlineMs,
} from "./mutate-and-bench.command.js"
import { runDeltaAstAndPluginGates } from "./verify-delta-gates.js"
import { resolveVerifyParallelCap, resolveVitestMaxWorkers } from "./repo-path.js"
import { tryRunDocOnlyVerifyFastPath, verifyFailureWithThrashing } from "./verify-doc-fastpath.js"
import { finalizeVerifyPostChecks, runVerifyFormatPreFlight } from "./verify-preflight.js"

export const handleVerify = Effect.fn("HarnessVerify.run")(function* (
  options: CliEnv | undefined,
): Effect.fn.Return<CliResult> {
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
  if (requireOllama) {
    const ollamaStatus = yield* ensureLocalOllamaReadyDetailed({ includeEmbeddings: false })
    const ollamaBlocker = match(ollamaStatus)
      .with({ ready: true }, () => undefined)
      .with({ ready: false }, ({ stage, reason }) => ({
        exitCode: 1,
        stdout: "",
        stderr: `[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is not running and could not be started automatically. Halting execution. (stage=${stage}: ${reason})`,
      }))
      .exhaustive()
    if (ollamaBlocker !== undefined) return ollamaBlocker
  }

  // 1. Active stub absence
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
  const allDeltaFiles = match(modifiedResult)
    .with({ _tag: "GitFailed" }, () => [] as ReadonlyArray<string>)
    .with({ _tag: "Resolved" }, ({ files }) =>
      files.filter((f) => nodeSyncHostIo.existsSync(join(repoRoot, f))),
    )
    .exhaustive()

  // 2. Format verification across all modified delta files
  const formatGateFail = runVerifyFormatPreFlight(repoRoot, allDeltaFiles, options)
  const formatGateResult = match(formatGateFail)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
  if (formatGateResult !== undefined) return formatGateResult

  // 3. AST & SelfDogfooding gates (includes file line-count ceilings)
  const deltaFilesOutcome = match(modifiedResult)
    .with({ _tag: "GitFailed" }, ({ reason }) => ({
      _tag: "GitFailed" as const,
      reason,
    }))
    .with({ _tag: "Resolved" }, ({ files }) => ({
      _tag: "Resolved" as const,
      files: files.filter(
        (f) =>
          (f.endsWith(".ts") || f.endsWith(".tsx")) && nodeSyncHostIo.existsSync(join(repoRoot, f)),
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

  // 4. Mutation stamp gate BEFORE graph extraction & nx affected -t verify
  const mutateReason = evaluateVerifyMutateStampGate(repoRoot, options)
  if (mutateReason !== undefined) {
    return verifyFailureWithThrashing(
      options,
      repoRoot,
      "verify:mutate-stamp",
      mutateReason,
      `[GATE FAILURE] verify:mutate-stamp\n${mutateReason}`,
    )
  }

  // 5. Governance docs, graph extraction, graph stub check, checkEffectGraph, and ontology invariants
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
        { _tag: "EarsRequirement" },
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
        stderr:
          "Verification failed: could not persist graph head metadata (.harness/graph-head.json)",
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

  // 6. Doc-only fast path or nx affected -t verify
  const docOnlyOutcome = yield* tryRunDocOnlyVerifyFastPath({
    repoRoot,
    graph,
    governanceDocs,
    implBranch: taskBranches.implBranch,
    options,
  })
  const docOnlyResult = match(docOnlyOutcome)
    .with({ _tag: "Executed" }, ({ result }) => result)
    .with({ _tag: "Skipped" }, () => undefined)
    .exhaustive()
  if (docOnlyResult !== undefined) return docOnlyResult

  if (!options?.skipSubprocessVerify && nodeSyncHostIo.existsSync(join(repoRoot, "package.json"))) {
    const leafFastPathEligible =
      deltaFiles.length > 0 && !isRootConfigOrSharedCoreChange(deltaFiles)
    const scopedFiles = leafFastPathEligible ? deltaFiles : undefined
    if (leafFastPathEligible) {
      for (const df of deltaFiles) findTestsReaching(graph, df)
    }
    const nxArgs = resolveNxAffectedArgs(repoRoot, ["verify"], scopedFiles)
    const verifyCap = resolveVerifyParallelCap()
    const subprocessErr = yield* Effect.try({
      try: () => {
        const { HARNESS_STATE_DIR: _dropStateDir, ...cleanEnv } = process.env
        const vitestMaxWorkers = resolveVitestMaxWorkers(cleanEnv, verifyCap)
        const res = nodeSyncHostIo.execFileSync("pnpm", nxArgs, {
          cwd: repoRoot,
          env: { ...cleanEnv, CI: "true", VITEST_MAX_WORKERS: vitestMaxWorkers },
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
      const isTimeoutContention =
        triage.hint.includes("timeout-contention") ||
        /Test timed out in \d+\s*ms/i.test(subprocessErr)
      return verifyFailureWithThrashing(
        options,
        repoRoot,
        `verify:${triage.kind}`,
        formattedErr,
        formattedErr,
        isTimeoutContention
          ? "[triage:mechanical] timeout-contention — Test timed out under parallel Nx load"
          : undefined,
      )
    }
  }

  return yield* finalizeVerifyPostChecks({
    repoRoot,
    graph,
    implBranch: taskBranches.implBranch,
    options,
  })
})

export const handleDone = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> => {
  const entryStartedAtMs = Date.now()
  const totalDeadlineMs = parseDoneDeadlineMs()
  const isCliMode = hasDoneCliFlag(argv)
  let isAntigravity =
    hasAntigravityFormat(argv) ||
    (!isCliMode && options?.stdin !== undefined && detectAntigravityHookPayload(options.stdin))
  return Effect.gen(function* () {
    const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()

    let rawStdin = options?.stdin
    if (!isCliMode && rawStdin === undefined && process.stdin.isTTY !== true) {
      const stdinTimeoutMs = Math.min(
        options?.stdinTimeoutMs ?? 4_000,
        Math.max(20, totalDeadlineMs),
      )
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
      if (stdinErrResult !== undefined) return stdinErrResult
    }
    if (!isCliMode && rawStdin !== undefined && rawStdin.trim().length === 0) {
      return makeDoneBlockResult(isAntigravity, "done: empty Stop hook stdin payload")
    }
    let decodedStdin: StopHookStdin | undefined
    if (!isCliMode && rawStdin !== undefined && rawStdin.trim().length > 0) {
      isAntigravity = isAntigravity || detectAntigravityHookPayload(rawStdin)
      const decoded = decodeStopHookStdin(rawStdin)
      const earlyResult = match(decoded)
        .with({ _tag: "Some" }, ({ value }) => {
          decodedStdin = value
          return value.fullyIdle === false
            ? ({
                exitCode: 0,
                stdout: "",
                stderr: "",
                telemetryDetail: "fullyIdle=false",
              } satisfies CliResult)
            : undefined
        })
        .with({ _tag: "None" }, () =>
          makeDoneBlockResult(isAntigravity, "done: malformed Stop hook stdin JSON payload"),
        )
        .exhaustive()
      if (earlyResult !== undefined) return earlyResult
    }

    const blockDecision = isAntigravity ? "continue" : "block"
    const verificationEffect = Effect.gen(function* () {
      // 1. Subagent bypass
      if (
        !isCliMode &&
        (isAntigravity || rawStdin !== undefined) &&
        isSubagentStopContext(repoRoot, decodedStdin)
      ) {
        return {
          exitCode: 0,
          stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
          stderr: "",
          telemetryDetail: "subagent=true",
        }
      }
      // 2. Read-only turn bypass
      const readOnlyInspection = isCliMode
        ? ({ _tag: "Unavailable" } as const)
        : inspectTranscriptSessionReadOnly(decodedStdin)
      const corruptTranscriptNote = match(readOnlyInspection)
        .with({ _tag: "ReadOnly" }, () => "readOnly" as const)
        .with({ _tag: "Mutating" }, { _tag: "Unavailable" }, () => undefined)
        .with({ _tag: "Corrupt" }, ({ reason }) => {
          process.stderr.write(`[harness:done] ${reason}\n`)
          return reason
        })
        .exhaustive()
      if (corruptTranscriptNote === "readOnly") {
        return {
          exitCode: 0,
          stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
          stderr: "",
          telemetryDetail: "readOnly=true",
        }
      }
      const transcriptStderr =
        corruptTranscriptNote !== undefined ? `[harness:done] ${corruptTranscriptNote}` : ""
      // 3. Verify stamp check
      const stampCheck = checkVerifyStamp(repoRoot, nodeSyncHostIo)
      if (!stampCheck.valid) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: appendTranscriptNote(stampCheck.reason, corruptTranscriptNote),
          }),
          stderr: transcriptStderr,
        }
      }
      if (isAlreadyDoneForVerifiedTree(repoRoot, stampCheck.stamp, options, nodeSyncHostIo)) {
        return withTranscriptStderr(
          {
            exitCode: 0,
            stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
            stderr: "",
            telemetryDetail: "alreadyDone=true",
          },
          transcriptStderr,
        )
      }
      return yield* executeDoneGraphAndStepChecks({
        repoRoot,
        treeHash: stampCheck.stamp.treeHash,
        isAntigravity,
        blockDecision,
        corruptTranscriptNote,
        transcriptStderr,
        options,
        decisionLayer,
        deps: {
          loadSnapshotPair,
          diffPlanAndImplGraphs,
          checkPlanStepCoverage,
          syncOmnigraphOnDone,
          finalizeDoneSuccess,
          runOmnigraphMaintenance,
        },
      })
    })

    if (isCliMode) {
      return normalizeDoneResultForCli(yield* verificationEffect, true)
    }
    const remainingDeadlineMs = Math.max(20, totalDeadlineMs - (Date.now() - entryStartedAtMs))
    const timedResult = yield* verificationEffect.pipe(
      Effect.timeoutOption(Duration.millis(remainingDeadlineMs)),
    )
    return normalizeDoneResultForCli(
      match(timedResult)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () =>
          makeDoneBlockResult(
            isAntigravity,
            `Stop hook verification exceeded internal deadline (${totalDeadlineMs}ms) — blocking premature termination.`,
          ),
        )
        .exhaustive(),
      isCliMode,
    )
  }).pipe(
    Effect.catchCause((cause) => {
      if (isPureInterruptCause(cause)) return Effect.failCause(cause)
      const pretty = Cause.pretty(cause)
      process.stderr.write(`[harness:done] uncaught cause: ${pretty}\n`)
      const errRes = makeDoneBlockResult(
        isAntigravity,
        `done: uncaught error or defect (${pretty})`,
        `${pretty}\n`,
      )
      return Effect.succeed(normalizeDoneResultForCli(errRes, isCliMode))
    }),
  )
}
