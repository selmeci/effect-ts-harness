import { Cause, Effect, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { isPureInterruptCause } from "@harness/contract"
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
  evaluateFileWriteDecision,
  extractGuardStdinPayload,
  formatAllowResult,
  formatCommandDenyReason,
  type GuardVerdictDecision,
  pickStrictestDecision,
  toGuardCliResult,
} from "./hook-guard-payload.js"

export { classifyCommand, classifyFileWrite }

const evaluateCommandDecision = (
  command: string,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<GuardVerdictDecision> =>
  Effect.gen(function* () {
    const classification = classifyCommand(command)
    if (classification !== "escalate") {
      return match<typeof classification, GuardVerdictDecision>(classification)
        .with("deny", () => ({ verdict: "deny", reason: formatCommandDenyReason(command) }))
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
    }

    if (options?.decisionLayer === undefined && options?.skipBackgroundDaemons !== true) {
      const ollamaProbe = yield* ensureLocalOllamaReady().pipe(Effect.timeoutOption("2500 millis"))
      match(ollamaProbe)
        .with({ _tag: "None" }, () => {
          process.stderr.write("[harness:guard] Ollama readiness probe timed out after 2500ms.\n")
        })
        .with({ _tag: "Some" }, ({ value: ready }) => {
          if (!ready) {
            process.stderr.write(
              "[harness:guard] Ollama server is not ready; continuing with DecisionModel.\n",
            )
          }
        })
        .exhaustive()
    }
    const decision = yield* decideGuardCommand(command).pipe(Effect.provide(decisionLayer))
    recordFriction(options, {
      kind: "guard_escalation",
      summary: command,
      detail: `verdict=${decision.verdict}; reason=${decision.reason}`,
    })

    return match<typeof decision.verdict, GuardVerdictDecision>(decision.verdict)
      .with("deny", () => ({
        verdict: "deny",
        reason: formatCommandDenyReason(command),
      }))
      .with("allow", () => ({ verdict: "allow" }))
      .with("ask", () => ({ verdict: "ask", reason: decision.reason }))
      .exhaustive()
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
    const fileFlag = argv.find((arg) => arg.startsWith("--file="))
    const cliFilePath = fileFlag ? fileFlag.slice("--file=".length) : undefined
    const positionalArgs = argv
      .slice(1)
      .filter((arg) => !arg.startsWith("--format=") && !arg.startsWith("--file="))

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
          makeGuardDenyResult(
            isAntigravity,
            `guard: failed or timed out reading hook stdin payload (${failure.reason})`,
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
      return makeGuardDenyResult(isAntigravity, "guard: empty hook stdin payload")
    }

    const candidateCmds: Array<string> = []
    const candidatePaths: Array<string> = []
    if (cliFilePath !== undefined && cliFilePath.trim().length > 0) {
      candidatePaths.push(cliFilePath.trim())
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
        .with({ _tag: "Ok" }, (ok) => {
          isAntigravity = isAntigravity || ok.isAntigravity
          if (ok.isAntigravity) {
            options?.hookStdinTracker?.markAntigravityDetected()
          }
          candidateCmds.push(...ok.candidateCmds)
          candidatePaths.push(...ok.candidatePaths)
          isReadOnlyToolCall = ok.isReadOnlyToolCall
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
      return makeGuardDenyResult(isAntigravity, stdinDecodeFailureReason)
    }

    let combinedDecision: GuardVerdictDecision | undefined
    for (const filePath of candidatePaths) {
      const d = evaluateFileWriteDecision(filePath)
      combinedDecision =
        combinedDecision === undefined ? d : pickStrictestDecision(combinedDecision, d)
    }
    for (const cmd of candidateCmds) {
      const d = yield* evaluateCommandDecision(cmd, options, decisionLayer)
      combinedDecision =
        combinedDecision === undefined ? d : pickStrictestDecision(combinedDecision, d)
    }

    if (combinedDecision !== undefined) {
      return toGuardCliResult(combinedDecision, isAntigravity)
    }

    if (isReadOnlyToolCall || !invokedAsHook) {
      return formatAllowResult(isAntigravity)
    }
    return makeGuardDenyResult(isAntigravity, "guard: empty hook command payload")
  }).pipe(
    Effect.catchCause((cause) => {
      if (isPureInterruptCause(cause)) {
        return Effect.failCause(cause)
      }
      const pretty = Cause.pretty(cause)
      process.stderr.write(`[harness:guard] uncaught cause: ${pretty}\n`)
      return Effect.succeed(
        makeGuardDenyResult(isAntigravity, `guard: uncaught error or defect (${pretty})`),
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
    if (source === "degraded-fallback") {
      process.stderr.write(
        `[harness:route] DecisionModel unavailable (source=degraded-fallback); returning '${block}'.\n`,
      )
    }
    const stdout = block === "review" || block === "effect" ? block : `agent-patterns/${block}.md`
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      telemetryDetail: `block=${block};source=${source}`,
    }
  })
