import {
  AgentAuthRequiredError,
  AgentCostUsd,
  AgentDurationMillis,
  AgentExitCode,
  AgentExitError,
  AgentOutputParseError,
  AgentResultText,
  type AgentRunResult,
  type AgentRunnerError,
  AgentSessionId,
  AgentTokenCount,
  AgentToolDeniedError,
  AgentTurnCount,
  type AgentUsage,
  type AttemptNumber,
  type RunnerId,
  UnitAgentDispatchResult,
  UnitOutcome,
  type WorkUnitId,
  toAgentDiagnosticDetail,
  toAgentFailureReason,
  toDenialNotice,
} from "@harness/contract"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"

const MAX_RESULT_TEXT_CHARS = 262_144
const MAX_SESSION_ID_CHARS = 256

const AUTH_PROMPT_RE =
  /\b(?:not logged in|please (?:run \/login|log in|login|authenticate)|invalid api key|authentication (?:failed|required|error)|auth(?:entication)? expired|oauth token.*expired|unauthenticated|unauthorized)\b|\/login\b/i

const SOFT_DENIAL_RE =
  /\b(?:permission denied|tool(?: call)? (?:was )?denied|soft[- ]denial|denied by (?:policy|hook|user)|tool permission denied|blocked by (?:guard|policy|hook))\b/i

const ClaudeUsageEnvelope = Schema.Struct({
  input_tokens: Schema.optional(Schema.Finite),
  output_tokens: Schema.optional(Schema.Finite),
  cache_read_input_tokens: Schema.optional(Schema.Finite),
  cache_creation_input_tokens: Schema.optional(Schema.Finite),
})

const ClaudeOutputEnvelope = Schema.Struct({
  result: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  num_turns: Schema.optional(Schema.Finite),
  total_cost_usd: Schema.optional(Schema.Finite),
  duration_ms: Schema.optional(Schema.Finite),
  usage: Schema.optional(ClaudeUsageEnvelope),
  permission_denials: Schema.optional(Schema.Array(Schema.Unknown)),
  session_id: Schema.optional(Schema.String),
})

const AntigravityUsageEnvelope = Schema.Struct({
  input_tokens: Schema.optional(Schema.Finite),
  output_tokens: Schema.optional(Schema.Finite),
  thinking_tokens: Schema.optional(Schema.Finite),
  total_tokens: Schema.optional(Schema.Finite),
})

const AntigravityOutputEnvelope = Schema.Struct({
  conversation_id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  response: Schema.optional(Schema.String),
  duration_seconds: Schema.optional(Schema.Finite),
  num_turns: Schema.optional(Schema.Finite),
  usage: Schema.optional(AntigravityUsageEnvelope),
})

const decodeClaudeEnvelope = Schema.decodeUnknownResult(Schema.fromJsonString(ClaudeOutputEnvelope))
const decodeAntigravityEnvelope = Schema.decodeUnknownResult(
  Schema.fromJsonString(AntigravityOutputEnvelope),
)

const toClampedExitCode = (exitCode: number): AgentExitCode =>
  AgentExitCode.make(Math.min(255, Math.max(1, Math.trunc(exitCode))))

const toBoundedResultText = (raw: string): AgentResultText =>
  AgentResultText.make(
    raw.length > MAX_RESULT_TEXT_CHARS ? raw.slice(0, MAX_RESULT_TEXT_CHARS) : raw,
  )

const toOptionalTokenCount = (value: number | undefined): AgentTokenCount | undefined =>
  value !== undefined ? AgentTokenCount.make(Math.max(0, Math.trunc(value))) : undefined

const toOptionalTurnCount = (value: number | undefined): AgentTurnCount | undefined =>
  value !== undefined ? AgentTurnCount.make(Math.max(0, Math.trunc(value))) : undefined

const toOptionalDurationMillis = (value: number | undefined): AgentDurationMillis | undefined =>
  value !== undefined && Number.isFinite(value)
    ? AgentDurationMillis.make(Math.max(0, Math.round(value)))
    : undefined

const toOptionalSessionId = (value: string | undefined): AgentSessionId | undefined => {
  if (value === undefined) {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  return AgentSessionId.make(
    trimmed.length > MAX_SESSION_ID_CHARS ? trimmed.slice(0, MAX_SESSION_ID_CHARS) : trimmed,
  )
}

const finalizeAgentUsage = (fields: {
  readonly inputTokens?: AgentTokenCount | undefined
  readonly outputTokens?: AgentTokenCount | undefined
  readonly thinkingTokens?: AgentTokenCount | undefined
  readonly totalTokens?: AgentTokenCount | undefined
  readonly numTurns?: AgentTurnCount | undefined
  readonly totalCostUsd?: AgentCostUsd | undefined
  readonly durationMillis?: AgentDurationMillis | undefined
  readonly sessionId?: AgentSessionId | undefined
}): AgentUsage => {
  const hasTelemetry =
    fields.inputTokens !== undefined ||
    fields.outputTokens !== undefined ||
    fields.thinkingTokens !== undefined ||
    fields.totalTokens !== undefined ||
    fields.numTurns !== undefined ||
    fields.totalCostUsd !== undefined ||
    fields.durationMillis !== undefined ||
    fields.sessionId !== undefined

  if (!hasTelemetry) {
    return { status: "unavailable" }
  }

  return {
    status: "reported",
    ...(fields.inputTokens !== undefined ? { inputTokens: fields.inputTokens } : {}),
    ...(fields.outputTokens !== undefined ? { outputTokens: fields.outputTokens } : {}),
    ...(fields.thinkingTokens !== undefined ? { thinkingTokens: fields.thinkingTokens } : {}),
    ...(fields.totalTokens !== undefined ? { totalTokens: fields.totalTokens } : {}),
    ...(fields.numTurns !== undefined ? { numTurns: fields.numTurns } : {}),
    ...(fields.totalCostUsd !== undefined ? { totalCostUsd: fields.totalCostUsd } : {}),
    ...(fields.durationMillis !== undefined ? { durationMillis: fields.durationMillis } : {}),
    ...(fields.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
  }
}

const firstNonEmpty = (...candidates: ReadonlyArray<string | undefined>): string | undefined => {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0) {
      return candidate
    }
  }
  return undefined
}

const classifyRawFailure = (
  runner: RunnerId,
  exitCode: number,
  stdout: string,
  stderr: string,
  parseErrorDetail: string,
): AgentRunnerError => {
  const authText = firstNonEmpty(
    AUTH_PROMPT_RE.test(stderr) ? stderr : undefined,
    AUTH_PROMPT_RE.test(stdout) ? stdout : undefined,
  )
  if (authText !== undefined) {
    return new AgentAuthRequiredError({
      runner,
      detail: toAgentDiagnosticDetail(authText),
    })
  }
  if (exitCode !== 0) {
    const detailText = firstNonEmpty(stderr, stdout)
    return new AgentExitError({
      runner,
      exit: toClampedExitCode(exitCode),
      ...(detailText !== undefined ? { detail: toAgentDiagnosticDetail(detailText) } : {}),
    })
  }
  const parseText = firstNonEmpty(stderr, parseErrorDetail) ?? parseErrorDetail
  return new AgentOutputParseError({
    runner,
    detail: toAgentDiagnosticDetail(parseText),
  })
}

const formatPermissionDenialEntry = (entry: unknown): string => {
  if (typeof entry === "string") {
    return entry
  }
  if (typeof entry === "object" && entry !== null) {
    const toolName = Reflect.get(entry, "tool_name")
    const message = Reflect.get(entry, "message")
    if (typeof toolName === "string" && typeof message === "string") {
      return `${toolName}: ${message}`
    }
    if (typeof toolName === "string") {
      return toolName
    }
    if (typeof message === "string") {
      return message
    }
  }
  return JSON.stringify(entry) ?? "permission denied"
}

const buildClaudeUsage = (envelope: typeof ClaudeOutputEnvelope.Type): AgentUsage => {
  const usage = envelope.usage
  const inputTokens = toOptionalTokenCount(usage?.input_tokens)
  const outputTokens = toOptionalTokenCount(usage?.output_tokens)
  const hasAnyClaudeTokens =
    usage !== undefined &&
    (usage.input_tokens !== undefined ||
      usage.output_tokens !== undefined ||
      usage.cache_read_input_tokens !== undefined ||
      usage.cache_creation_input_tokens !== undefined)
  const totalTokens = hasAnyClaudeTokens
    ? toOptionalTokenCount(
        (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
      )
    : undefined

  return finalizeAgentUsage({
    inputTokens,
    outputTokens,
    totalTokens,
    numTurns: toOptionalTurnCount(envelope.num_turns),
    totalCostUsd:
      envelope.total_cost_usd !== undefined
        ? AgentCostUsd.make(Math.max(0, envelope.total_cost_usd))
        : undefined,
    durationMillis: toOptionalDurationMillis(envelope.duration_ms),
    sessionId: toOptionalSessionId(envelope.session_id),
  })
}

const buildAntigravityUsage = (envelope: typeof AntigravityOutputEnvelope.Type): AgentUsage => {
  const usage = envelope.usage
  return finalizeAgentUsage({
    inputTokens: toOptionalTokenCount(usage?.input_tokens),
    outputTokens: toOptionalTokenCount(usage?.output_tokens),
    thinkingTokens: toOptionalTokenCount(usage?.thinking_tokens),
    totalTokens: toOptionalTokenCount(usage?.total_tokens),
    numTurns: toOptionalTurnCount(envelope.num_turns),
    durationMillis: toOptionalDurationMillis(
      envelope.duration_seconds !== undefined ? envelope.duration_seconds * 1000 : undefined,
    ),
    sessionId: toOptionalSessionId(envelope.conversation_id),
  })
}

/** Pure mapper from `AgentRunnerError` to `UnitOutcome` (`Rejected{AgentFailed}` or immediate `Escalated{AuthRequired}`). */
const toOutcome = (
  unitId: WorkUnitId,
  attempt: AttemptNumber,
  error: AgentRunnerError,
): UnitOutcome =>
  match(error)
    .with({ _tag: "AgentAuthRequiredError" }, (e) =>
      UnitOutcome.cases.Escalated.make({
        unitId,
        escalation: { _tag: "AuthRequired", runner: e.runner },
      }),
    )
    .with(
      { _tag: "AgentTimeoutError" },
      { _tag: "AgentToolDeniedError" },
      { _tag: "AgentExitError" },
      { _tag: "AgentOutputParseError" },
      { _tag: "AgentNoChangeError" },
      (e) =>
        UnitOutcome.cases.Rejected.make({
          unitId,
          attempt,
          rejection: {
            _tag: "AgentFailed",
            reason: toAgentFailureReason(e._tag, e.message),
          },
        }),
    )
    .exhaustive()

/** Pure mapper from `AgentRunnerError` to `UnitAgentDispatchResult` for `UnitAgentDispatcher.dispatchUnit`. */
const toUnitAgentDispatchResult = (error: AgentRunnerError): UnitAgentDispatchResult =>
  match(error)
    .with({ _tag: "AgentAuthRequiredError" }, (e) =>
      UnitAgentDispatchResult.cases.AuthRequired.make({ runner: e.runner }),
    )
    .with(
      { _tag: "AgentTimeoutError" },
      { _tag: "AgentToolDeniedError" },
      { _tag: "AgentExitError" },
      { _tag: "AgentOutputParseError" },
      { _tag: "AgentNoChangeError" },
      (e) =>
        UnitAgentDispatchResult.cases.Failed.make({
          reason: toAgentFailureReason(e._tag, e.message),
        }),
    )
    .exhaustive()

/** Pure parser decoding `claude -p --output-format json` stdout/stderr into `AgentRunResult` or `AgentRunnerError`. */
const parseClaudeCodeOutput = (
  exitCode: number,
  stdout: string,
  stderr: string,
): Result.Result<AgentRunResult, AgentRunnerError> => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return Result.fail(
      classifyRawFailure("claude-code", exitCode, stdout, stderr, "Empty JSON output from claude"),
    )
  }

  return match(decodeClaudeEnvelope(trimmed))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(classifyRawFailure("claude-code", exitCode, stdout, stderr, String(failure))),
    )
    .with({ _tag: "Success" }, ({ success: envelope }) => {
      const resultText = envelope.result ?? ""
      const isFailure = envelope.is_error === true || exitCode !== 0
      if (AUTH_PROMPT_RE.test(stderr) || (isFailure && AUTH_PROMPT_RE.test(resultText))) {
        const authDetail = AUTH_PROMPT_RE.test(stderr) ? stderr : resultText
        return Result.fail(
          new AgentAuthRequiredError({
            runner: "claude-code",
            detail: toAgentDiagnosticDetail(authDetail),
          }),
        )
      }

      if (envelope.permission_denials !== undefined && envelope.permission_denials.length > 0) {
        const denialSummary = envelope.permission_denials
          .map(formatPermissionDenialEntry)
          .join(", ")
        return Result.fail(
          new AgentToolDeniedError({
            runner: "claude-code",
            notice: toDenialNotice(denialSummary),
          }),
        )
      }

      if (isFailure) {
        const detailText = firstNonEmpty(resultText, stderr)
        return Result.fail(
          new AgentExitError({
            runner: "claude-code",
            exit: toClampedExitCode(exitCode === 0 ? 1 : exitCode),
            ...(detailText !== undefined ? { detail: toAgentDiagnosticDetail(detailText) } : {}),
          }),
        )
      }

      return Result.succeed({
        runner: "claude-code" as const,
        exit: AgentExitCode.make(0),
        resultText: toBoundedResultText(resultText),
        usage: buildClaudeUsage(envelope),
      })
    })
    .exhaustive()
}

/** Pure parser decoding `agy -p --output-format json` stdout/stderr into `AgentRunResult` or `AgentRunnerError`. */
const parseAntigravityOutput = (
  exitCode: number,
  stdout: string,
  stderr: string,
): Result.Result<AgentRunResult, AgentRunnerError> => {
  if (AUTH_PROMPT_RE.test(stderr)) {
    return Result.fail(
      new AgentAuthRequiredError({
        runner: "antigravity",
        detail: toAgentDiagnosticDetail(stderr),
      }),
    )
  }

  if (SOFT_DENIAL_RE.test(stderr)) {
    return Result.fail(
      new AgentToolDeniedError({
        runner: "antigravity",
        notice: toDenialNotice(stderr),
      }),
    )
  }

  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return Result.fail(
      classifyRawFailure("antigravity", exitCode, stdout, stderr, "Empty JSON output from agy"),
    )
  }

  return match(decodeAntigravityEnvelope(trimmed))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(classifyRawFailure("antigravity", exitCode, stdout, stderr, String(failure))),
    )
    .with({ _tag: "Success" }, ({ success: envelope }) => {
      const responseText = envelope.response ?? ""
      const failedStatus = envelope.status !== undefined && envelope.status !== "SUCCESS"
      if ((exitCode !== 0 || failedStatus) && AUTH_PROMPT_RE.test(responseText)) {
        return Result.fail(
          new AgentAuthRequiredError({
            runner: "antigravity",
            detail: toAgentDiagnosticDetail(responseText),
          }),
        )
      }

      if (exitCode !== 0 || failedStatus) {
        const statusFallback =
          envelope.status !== undefined ? `Antigravity status: ${envelope.status}` : undefined
        const detailText = firstNonEmpty(responseText, stderr, statusFallback)
        return Result.fail(
          new AgentExitError({
            runner: "antigravity",
            exit: toClampedExitCode(exitCode === 0 ? 1 : exitCode),
            ...(detailText !== undefined ? { detail: toAgentDiagnosticDetail(detailText) } : {}),
          }),
        )
      }

      return Result.succeed({
        runner: "antigravity" as const,
        exit: AgentExitCode.make(0),
        resultText: toBoundedResultText(responseText),
        usage: buildAntigravityUsage(envelope),
      })
    })
    .exhaustive()
}

/** Detects transient `agy` pre-output startup failure (`exit 3` with empty stdout, excluding deterministic auth/denial). */
const isRetryableAntigravityStartupFailure = (
  exitCode: number,
  stdout: string,
  stderr: string,
  _runner?: RunnerId,
): boolean =>
  exitCode === 3 &&
  stdout.trim().length === 0 &&
  !AUTH_PROMPT_RE.test(stderr) &&
  !SOFT_DENIAL_RE.test(stderr)

export {
  isRetryableAntigravityStartupFailure,
  parseAntigravityOutput,
  parseClaudeCodeOutput,
  toOutcome,
  toUnitAgentDispatchResult,
}
