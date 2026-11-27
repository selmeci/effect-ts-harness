import { Cause, Effect, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { isPureInterruptCause, WORKFLOW_TIMEOUT_BUDGETS } from "@harness/contract"
import { decideGuardCommand, routeStepWithStatus } from "@harness/decision/hook-fastpath"
import {
  classifyCommand,
  classifyFileWrite,
  isSkipNxCacheOverrideCommand,
} from "@harness/gates/hook-fastpath"
import {
  type CliEnv,
  type CliResult,
  ensureLocalOllamaReady,
  makeReadStdinEffect,
  recordFriction,
  resolveDecisionModelLayer,
} from "./daemon-and-omnigraph.service.js"
import {
  detectAntigravityHookPayload,
  hasAntigravityFormat,
  makeGuardDenyResult,
} from "./hook-format.js"
import {
  evaluateCandidatePaths,
  extractGuardStdinPayload,
  formatAllowResult,
  formatCommandDenyReason,
  type GuardVerdictDecision,
  parseGuardCliArgs,
  pickStrictestDecision,
  resolveUnitWorkerMode,
  toGuardCliResult,
} from "./hook-guard-payload.js"

export { classifyCommand, classifyFileWrite }

interface EvaluatedCommandDecision {
  readonly decision: GuardVerdictDecision
  readonly source: "static" | "escalated" | "path"
}

const formatGuardTelemetryDetail = (
  decision: GuardVerdictDecision,
  source: "static" | "escalated" | "path",
): string | undefined =>
  match(decision)
    .with({ verdict: "allow" }, () =>
      match(source)
        .with("escalated", () => "escalated;verdict=allow")
        .with("static", "path", () => undefined)
        .exhaustive(),
    )
    .with({ verdict: "deny" }, { verdict: "ask" }, ({ verdict, reason }) => {
      const compactReason = reason.replace(/\s+/g, " ").trim()
      const full = `${source};verdict=${verdict};reason=${compactReason}`
      return full.length <= 160 ? full : `${full.slice(0, 157)}...`
    })
    .exhaustive()

const makeGuardDenyWithDetail = (
  isAntigravity: boolean,
  reason: string,
  detail: string,
): CliResult => ({
  ...makeGuardDenyResult(isAntigravity, reason),
  telemetryDetail: detail,
})

const evaluateCommandDecision = (
  command: string,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
  unitWorkerMode: boolean,
): Effect.Effect<EvaluatedCommandDecision> =>
  Effect.gen(function* () {
    const policyOptions = unitWorkerMode ? { unitWorkerMode: true } : undefined
    const classification = classifyCommand(command, policyOptions)
    if (classification !== "escalate") {
      const staticDecision = match<typeof classification, GuardVerdictDecision>(classification)
        .with("deny", () => ({
          verdict: "deny",
          reason: formatCommandDenyReason(command, policyOptions),
        }))
        .with("allow", () => ({ verdict: "allow" }))
        .with("ask", () => {
          if (isSkipNxCacheOverrideCommand(command)) {
            recordFriction(options, {
              kind: "guard_escalation",
              summary: command,
              detail: "ruleId=skip-nx-cache-override; verdict=ask",
            })
            process.stderr.write(
              "[harness:guard] Audit: HARNESS_ALLOW_SKIP_NX_CACHE=1 override requested human confirmation.\n",
            )
          }
          return {
            verdict: "ask",
            reason: `Command requires human confirmation: ${command}`,
          }
        })
        .exhaustive()
      return { decision: staticDecision, source: "static" as const }
    }

    if (options?.decisionLayer === undefined && options?.skipBackgroundDaemons !== true) {
      const ollamaProbe = yield* ensureLocalOllamaReady({
        probeBudgetMs: WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs,
      }).pipe(Effect.timeoutOption(`${WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs} millis`))
      const isOllamaReady = match(ollamaProbe)
        .with({ _tag: "None" }, () => {
          process.stderr.write(
            `[harness:guard] Ollama readiness probe timed out after ${WORKFLOW_TIMEOUT_BUDGETS.decisionModelTimeoutMs}ms.\n`,
          )
          return false
        })
        .with({ _tag: "Some" }, ({ value: ready }) => {
          if (!ready) {
            process.stderr.write(
              "[harness:guard] Ollama server is not ready; escalating without DecisionModel.\n",
            )
          }
          return ready
        })
        .exhaustive()
      if (!isOllamaReady) {
        const reason = "DecisionModel unavailable (Ollama readiness probe failed)"
        recordFriction(options, {
          kind: "guard_escalation",
          summary: command,
          detail: `verdict=ask; reason=${reason}`,
        })
        return {
          decision: { verdict: "ask" as const, reason },
          source: "escalated" as const,
        }
      }
    }
    const decision = yield* decideGuardCommand({ command, unitWorkerMode }).pipe(
      Effect.provide(decisionLayer),
    )
    recordFriction(options, {
      kind: "guard_escalation",
      summary: command,
      detail: `verdict=${decision.verdict}; reason=${decision.reason}`,
    })

    const escalatedDecision = match<typeof decision.verdict, GuardVerdictDecision>(decision.verdict)
      .with("deny", () => ({
        verdict: "deny",
        reason: formatCommandDenyReason(command, policyOptions),
      }))
      .with("allow", () => ({ verdict: "allow" }))
      .with("ask", () => ({ verdict: "ask", reason: decision.reason }))
      .exhaustive()
    return { decision: escalatedDecision, source: "escalated" as const }
  })

export const handleGuard = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> => {
  const isAntigravityFlag = hasAntigravityFormat(argv)
  let isAntigravity =
    isAntigravityFlag ||
    (options?.stdin !== undefined && detectAntigravityHookPayload(options.stdin))

  return Effect.gen(function* () {
    const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
    const parsedArgs = parseGuardCliArgs(argv.slice(1))
    const argFailure = match(parsedArgs)
      .with({ _tag: "Help" }, () =>
        makeGuardDenyWithDetail(
          isAntigravity,
          "guard: CLI parse failure (--help is not allowed in hook mode)",
          "static;verdict=deny;reason=help-flag",
        ),
      )
      .with({ _tag: "UnknownFlag" }, ({ flag }) =>
        makeGuardDenyWithDetail(
          isAntigravity,
          `guard: CLI parse failure (Unrecognized flag: ${flag})`,
          `static;verdict=deny;reason=unknown-flag:${flag}`,
        ),
      )
      .with({ _tag: "MissingFlagValue" }, ({ flag }) =>
        makeGuardDenyWithDetail(
          isAntigravity,
          `guard: CLI parse failure (Missing value for ${flag})`,
          `static;verdict=deny;reason=missing-flag-value:${flag}`,
        ),
      )
      .with({ _tag: "Ok" }, () => undefined)
      .exhaustive()
    if (argFailure !== undefined) {
      return argFailure
    }
    const { positionalArgs, fileFlag: cliFilePath } = match(parsedArgs)
      .with({ _tag: "Ok" }, (ok) => ok)
      .with({ _tag: "Help" }, { _tag: "UnknownFlag" }, { _tag: "MissingFlagValue" }, () => ({
        positionalArgs: [] as ReadonlyArray<string>,
        fileFlag: undefined as string | undefined,
      }))
      .exhaustive()

    const invokedAsHook =
      isAntigravityFlag ||
      (positionalArgs.length === 0 &&
        !cliFilePath &&
        options?.stdin === undefined &&
        process.stdin.isTTY !== true)

    let rawStdin = options?.stdin
    if (
      positionalArgs.length === 0 &&
      !cliFilePath &&
      rawStdin === undefined &&
      process.stdin.isTTY !== true
    ) {
      const stdinRes = yield* Effect.result(
        makeReadStdinEffect({
          timeoutMs: options?.stdinTimeoutMs,
          maxBytes: options?.stdinMaxBytes,
        }),
      )
      const readFailed = match(stdinRes)
        .with({ _tag: "Success" }, ({ success }) => {
          rawStdin = success
          if (detectAntigravityHookPayload(success)) {
            isAntigravity = true
            options?.hookStdinTracker?.markAntigravityDetected()
          }
          return undefined
        })
        .with({ _tag: "Failure" }, ({ failure }) =>
          makeGuardDenyWithDetail(
            isAntigravity,
            `guard: failed or timed out reading hook stdin payload (${failure.reason})`,
            `static;verdict=deny;reason=stdin-read:${failure.reason}`,
          ),
        )
        .exhaustive()
      if (readFailed !== undefined) {
        return readFailed
      }
    }

    if (
      positionalArgs.length === 0 &&
      !cliFilePath &&
      invokedAsHook &&
      (rawStdin === undefined || rawStdin.trim().length === 0)
    ) {
      return makeGuardDenyWithDetail(
        isAntigravity,
        "guard: empty hook stdin payload",
        "static;verdict=deny;reason=empty-stdin",
      )
    }

    const unitWorkerMode = resolveUnitWorkerMode(options?.env)
    const policyOptions = unitWorkerMode ? { unitWorkerMode: true } : undefined
    const candidateCmds: Array<string> = []
    const candidateWritePaths: Array<string> = []
    const candidateReadPaths: Array<string> = []
    if (cliFilePath !== undefined && cliFilePath.trim().length > 0) {
      candidateWritePaths.push(cliFilePath.trim())
    }
    if (positionalArgs.length > 0) {
      candidateCmds.push(positionalArgs.join(" "))
    }

    let stdinDecodeFailureReason: string | undefined
    let isReadOnlyToolCall = false

    if (
      rawStdin !== undefined &&
      rawStdin.trim().length > 0 &&
      positionalArgs.length === 0 &&
      !cliFilePath
    ) {
      const stdinText = rawStdin
      const extracted = extractGuardStdinPayload(stdinText, isAntigravityFlag)
      match(extracted)
        .with({ _tag: "ReadOnly" }, (ro) => {
          isAntigravity = isAntigravity || ro.isAntigravity
          if (ro.isAntigravity) {
            options?.hookStdinTracker?.markAntigravityDetected()
          }
          isReadOnlyToolCall = true
        })
        .with({ _tag: "Action" }, (action) => {
          isAntigravity = isAntigravity || action.isAntigravity
          if (action.isAntigravity) {
            options?.hookStdinTracker?.markAntigravityDetected()
          }
          candidateCmds.push(...action.candidateCmds)
          if (action.isReadOnlyTool) {
            candidateReadPaths.push(...action.candidatePaths)
          } else {
            candidateWritePaths.push(...action.candidatePaths)
          }
        })
        .with({ _tag: "Error" }, (err) => {
          if (
            !isAntigravityFlag &&
            options?.stdin !== undefined &&
            !stdinText.trim().startsWith("{")
          ) {
            candidateCmds.push(stdinText)
          } else {
            isAntigravity = isAntigravity || err.isAntigravity
            stdinDecodeFailureReason = err.reason
          }
        })
        .exhaustive()
    }

    if (stdinDecodeFailureReason !== undefined) {
      return makeGuardDenyWithDetail(
        isAntigravity,
        stdinDecodeFailureReason,
        `static;verdict=deny;reason=${stdinDecodeFailureReason}`,
      )
    }

    let combinedDecision: GuardVerdictDecision | undefined = evaluateCandidatePaths(
      candidateWritePaths,
      false,
      policyOptions,
    )
    let combinedSource: "static" | "escalated" | "path" = "path"
    const readDecision = evaluateCandidatePaths(candidateReadPaths, true, policyOptions)
    if (readDecision !== undefined) {
      combinedDecision =
        combinedDecision === undefined
          ? readDecision
          : pickStrictestDecision(combinedDecision, readDecision)
    }
    for (const cmd of candidateCmds) {
      const { decision: d, source } = yield* evaluateCommandDecision(
        cmd,
        options,
        decisionLayer,
        unitWorkerMode,
      )
      if (combinedDecision === undefined) {
        combinedDecision = d
        combinedSource = source
      } else {
        const nextStrictest = pickStrictestDecision(combinedDecision, d)
        const prefersEscalated =
          nextStrictest.verdict === d.verdict &&
          match(source)
            .with("escalated", () => true)
            .with("static", "path", () => false)
            .exhaustive()
        if ((nextStrictest === d && nextStrictest !== combinedDecision) || prefersEscalated) {
          combinedSource = source
        }
        combinedDecision = nextStrictest
      }
    }

    if (combinedDecision !== undefined) {
      const cliRes = toGuardCliResult(combinedDecision, isAntigravity)
      const telemetryDetail = formatGuardTelemetryDetail(combinedDecision, combinedSource)
      return telemetryDetail !== undefined ? { ...cliRes, telemetryDetail } : cliRes
    }

    if (isReadOnlyToolCall || !invokedAsHook) {
      return formatAllowResult(isAntigravity)
    }
    return makeGuardDenyWithDetail(
      isAntigravity,
      "guard: empty hook command payload",
      "static;verdict=deny;reason=empty-command-payload",
    )
  }).pipe(
    Effect.catchCause((cause) => {
      if (isPureInterruptCause(cause)) {
        return Effect.failCause(cause)
      }
      const pretty = Cause.pretty(cause)
      process.stderr.write(`[harness:guard] uncaught cause: ${pretty}\n`)
      return Effect.succeed(
        makeGuardDenyWithDetail(
          isAntigravity,
          `guard: uncaught error or defect (${pretty})`,
          `static;verdict=deny;reason=uncaught-cause`,
        ),
      )
    }),
  )
}

export const handleRoute = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const decisionLayer = yield* resolveDecisionModelLayer(options?.decisionLayer)
    const step = argv.slice(1).join(" ")
    const { block, source } = yield* routeStepWithStatus(step).pipe(Effect.provide(decisionLayer))
    if (block === "review") {
      recordFriction(options, {
        kind: "route_miss",
        summary: step,
        detail:
          "IdiomRouterV1 returned review (no matching agent-patterns/*.md with >= 0.7 confidence)",
      })
    }
    match(source)
      .with("degraded-fallback", () => {
        process.stderr.write(
          `[harness:route] DecisionModel unavailable (source=degraded-fallback); returning '${block}'.\n`,
        )
      })
      .with("deterministic", "hybrid-retrieval", "model", () => undefined)
      .exhaustive()
    const stdout = block === "review" || block === "effect" ? block : `agent-patterns/${block}.md`
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      telemetryDetail: `block=${block};source=${source}`,
    }
  })
