import { Schema } from "effect"
import { AbsoluteRepoRoot } from "./repo-identity.js"
import {
  AgentFailureReason,
  AttemptNumber,
  MCP_FALLBACK_POLICIES,
  MCP_ISOLATION_LEVELS,
  MaxConcurrency,
  McpFallbackPolicy,
  McpIsolationLevel,
  OwnedRelPath,
  RunnerConfigFilePath,
  RunnerId,
  WorkUnitId,
  WorkflowRunId,
} from "./workflow.js"
import { PackageVerifyCommand } from "./workflow-verify-command.js"
import { formatBoundedErrorMessage } from "./workspace-and-process.js"

const MAX_DENIAL_NOTICE_CHARS = 1024
const MAX_DIAGNOSTIC_DETAIL_CHARS = 1024
const MAX_AGENT_FAILURE_REASON_CHARS = 2048
const MAX_SETTLE_TIMEOUT_MS = 2_147_483_647

export {
  MCP_FALLBACK_POLICIES,
  MCP_ISOLATION_LEVELS,
  McpFallbackPolicy,
  McpIsolationLevel,
  RunnerConfigFilePath,
}

/** Closed CLI binary executable names allowed for WF-5 workflow agent runners. */
export const EXECUTABLE_NAMES = ["claude", "agy"] as const

/** Branded executable binary name (`"claude" | "agy"`). */
export const ExecutableName = Schema.Literals(EXECUTABLE_NAMES).pipe(Schema.brand("ExecutableName"))
export type ExecutableName = typeof ExecutableName.Type

/** Branded CLI permission/tool rule; forbids `--dangerously-skip-permissions` at schema level (`RFC-0013 REQ-4.1`). */
export const PermissionRule = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.check(
    Schema.makeFilter((rule) => !rule.includes("--dangerously-skip-permissions"), {
      message: "PermissionRule must never contain --dangerously-skip-permissions",
    }),
  ),
  Schema.brand("PermissionRule"),
)
export type PermissionRule = typeof PermissionRule.Type

/** Branded trimmed model identifier passed to `claude --model` or `agy --model`. */
export const ModelName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)),
  Schema.brand("ModelName"),
)
export type ModelName = typeof ModelName.Type

/** Positive 32-bit signed integer runner timeout budget in milliseconds (`1..2_147_483_647`). */
export const TimeoutMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_SETTLE_TIMEOUT_MS })),
  Schema.brand("TimeoutMillis"),
)
export type TimeoutMillis = typeof TimeoutMillis.Type

/** Bounded non-empty tool-denial notice surfaced by runner envelopes or stderr. */
export const DenialNotice = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(MAX_DENIAL_NOTICE_CHARS)),
  Schema.brand("DenialNotice"),
)
export type DenialNotice = typeof DenialNotice.Type

/** Branded zero POSIX exit code (`0`) returned on successful agent runner completion. */
export const AgentSuccessExitCode = Schema.Literal(0).pipe(Schema.brand("AgentSuccessExitCode"))
export type AgentSuccessExitCode = typeof AgentSuccessExitCode.Type

/** Branded non-zero POSIX exit code (`1..255`) reported in `AgentExitError`. */
export const AgentNonZeroExitCode = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 255 })),
  Schema.brand("AgentNonZeroExitCode"),
)
export type AgentNonZeroExitCode = typeof AgentNonZeroExitCode.Type

/** Subprocess termination category recorded on `AgentExitError`. */
export const AGENT_EXIT_FAILURE_KINDS = ["exit", "signal", "spawn-failed"] as const
export const AgentExitFailureKind = Schema.Literals(AGENT_EXIT_FAILURE_KINDS)
export type AgentExitFailureKind = typeof AgentExitFailureKind.Type

/** Bounded textual output extracted from a runner JSON envelope. */
export const AgentResultText = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(262_144)),
  Schema.brand("AgentResultText"),
)
export type AgentResultText = typeof AgentResultText.Type

/** Bounded non-empty deterministic unit prompt passed via `-p` (rejects leading `-` to prevent CLI option injection). */
export const BriefPrompt = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(65_536)),
  Schema.check(
    Schema.makeFilter((prompt) => !prompt.startsWith("-"), {
      message: "BriefPrompt must not start with '-' to prevent CLI option injection",
    }),
  ),
  Schema.brand("BriefPrompt"),
)
export type BriefPrompt = typeof BriefPrompt.Type

/** Bounded diagnostic detail attached to runner failure errors. */
export const AgentDiagnosticDetail = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(MAX_DIAGNOSTIC_DETAIL_CHARS)),
  Schema.brand("AgentDiagnosticDetail"),
)
export type AgentDiagnosticDetail = typeof AgentDiagnosticDetail.Type

/** Non-negative integer token count reported by CLI usage telemetry. */
export const AgentTokenCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("AgentTokenCount"),
)
export type AgentTokenCount = typeof AgentTokenCount.Type

/** Non-negative integer agent turn count reported by CLI usage telemetry. */
export const AgentTurnCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("AgentTurnCount"),
)
export type AgentTurnCount = typeof AgentTurnCount.Type

/** Positive bounded max-turns budget (`1..200`) passed to `claude --max-turns`. */
export const AgentMaxTurns = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  Schema.brand("AgentMaxTurns"),
)
export type AgentMaxTurns = typeof AgentMaxTurns.Type

/** Non-negative USD cost reported by `claude --output-format json`. */
export const AgentCostUsd = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("AgentCostUsd"),
)
export type AgentCostUsd = typeof AgentCostUsd.Type

/** Non-negative wall-clock execution duration in milliseconds reported by a runner. */
export const AgentDurationMillis = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("AgentDurationMillis"),
)
export type AgentDurationMillis = typeof AgentDurationMillis.Type

/** Bounded runner session/conversation identifier reported by `claude` or `agy`. */
export const AgentSessionId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("AgentSessionId"),
)
export type AgentSessionId = typeof AgentSessionId.Type

/** Supported Antigravity `--mode` values. */
export const ANTIGRAVITY_MODES = ["accept-edits", "auto", "plan"] as const
export const AntigravityMode = Schema.Literals(ANTIGRAVITY_MODES)
export type AntigravityMode = typeof AntigravityMode.Type

const hasReportedTelemetry = (usage: {
  readonly inputTokens?: AgentTokenCount | undefined
  readonly outputTokens?: AgentTokenCount | undefined
  readonly thinkingTokens?: AgentTokenCount | undefined
  readonly totalTokens?: AgentTokenCount | undefined
  readonly numTurns?: AgentTurnCount | undefined
  readonly totalCostUsd?: AgentCostUsd | undefined
  readonly durationMillis?: AgentDurationMillis | undefined
  readonly sessionId?: AgentSessionId | undefined
}): boolean =>
  usage.inputTokens !== undefined ||
  usage.outputTokens !== undefined ||
  usage.thinkingTokens !== undefined ||
  usage.totalTokens !== undefined ||
  usage.numTurns !== undefined ||
  usage.totalCostUsd !== undefined ||
  usage.durationMillis !== undefined ||
  usage.sessionId !== undefined

/** Reported CLI usage telemetry containing at least one metric field. */
export const ReportedAgentUsage = Schema.TaggedStruct("Reported", {
  inputTokens: Schema.optional(AgentTokenCount),
  outputTokens: Schema.optional(AgentTokenCount),
  thinkingTokens: Schema.optional(AgentTokenCount),
  totalTokens: Schema.optional(AgentTokenCount),
  numTurns: Schema.optional(AgentTurnCount),
  totalCostUsd: Schema.optional(AgentCostUsd),
  durationMillis: Schema.optional(AgentDurationMillis),
  sessionId: Schema.optional(AgentSessionId),
}).pipe(
  Schema.check(
    Schema.makeFilter(hasReportedTelemetry, {
      message: "Reported AgentUsage must contain at least one telemetry field",
    }),
  ),
)
export type ReportedAgentUsage = typeof ReportedAgentUsage.Type

/** Telemetry marker indicating the CLI envelope omitted usage/session metrics. */
export const UnavailableAgentUsage = Schema.TaggedStruct("Unavailable", {})
export type UnavailableAgentUsage = typeof UnavailableAgentUsage.Type

/** Closed tagged union representing normalized runner usage telemetry. */
export const AgentUsage = Schema.Union([ReportedAgentUsage, UnavailableAgentUsage])
export type AgentUsage = typeof AgentUsage.Type

/** Deterministic unit prompt & execution constraints passed to `AgentRunnerPort.run`. */
export const UnitBrief = Schema.Struct({
  unitId: WorkUnitId,
  attempt: AttemptNumber,
  promptText: BriefPrompt,
  ownedRelPaths: Schema.Array(OwnedRelPath),
  packageVerifyCommand: Schema.optional(PackageVerifyCommand),
  mcpConfigPath: Schema.optional(RunnerConfigFilePath),
})
export type UnitBrief = typeof UnitBrief.Type

/** Typed capability profile for the Claude Code runner (`claude`). */
export const ClaudeCodeRunnerProfile = Schema.Struct({
  runner: Schema.Literal("claude-code"),
  binary: Schema.Literal("claude"),
  permissionRules: Schema.Array(PermissionRule),
  disallowedTools: Schema.Array(PermissionRule),
  maxConcurrency: MaxConcurrency,
  timeoutMillis: TimeoutMillis,
  maxTurns: Schema.optional(AgentMaxTurns),
  model: Schema.optional(ModelName),
})
export type ClaudeCodeRunnerProfile = typeof ClaudeCodeRunnerProfile.Type

/** Typed capability profile for the Antigravity runner (`agy`). */
export const AntigravityRunnerProfile = Schema.Struct({
  runner: Schema.Literal("antigravity"),
  binary: Schema.Literal("agy"),
  permissionRules: Schema.Array(PermissionRule),
  maxConcurrency: MaxConcurrency,
  timeoutMillis: TimeoutMillis,
  model: Schema.optional(ModelName),
  antigravityMode: Schema.optional(AntigravityMode),
})
export type AntigravityRunnerProfile = typeof AntigravityRunnerProfile.Type

/** Closed union of runner capability profiles (`libs/harness/infra/src/workflow/runner-profiles.ts`). */
export const RunnerProfile = Schema.Union([ClaudeCodeRunnerProfile, AntigravityRunnerProfile])
export type RunnerProfile = typeof RunnerProfile.Type

/** Execution request dispatched to `ClaudeCodeRunner.run`. */
export const ClaudeCodeRunRequest = Schema.Struct({
  runId: WorkflowRunId,
  runner: Schema.Literal("claude-code"),
  brief: UnitBrief,
  cwd: AbsoluteRepoRoot,
})
export type ClaudeCodeRunRequest = typeof ClaudeCodeRunRequest.Type

/** Execution request dispatched to `AntigravityRunner.run` (carries optional MCP isolation policy). */
export const AntigravityRunRequest = Schema.Struct({
  runId: WorkflowRunId,
  runner: Schema.Literal("antigravity"),
  brief: UnitBrief,
  cwd: AbsoluteRepoRoot,
  mcpIsolation: Schema.optional(McpIsolationLevel),
  hardMcpFallback: Schema.optional(McpFallbackPolicy),
})
export type AntigravityRunRequest = typeof AntigravityRunRequest.Type

/** Closed execution request dispatched to `AgentRunnerPort.run`. */
export const AgentRunRequest = Schema.Union([ClaudeCodeRunRequest, AntigravityRunRequest])
export type AgentRunRequest = typeof AgentRunRequest.Type

/** Normalized success outcome returned by `AgentRunnerPort.run` (always zero exit code). */
export const AgentRunResult = Schema.Struct({
  runner: RunnerId,
  exit: AgentSuccessExitCode,
  resultText: AgentResultText,
  usage: AgentUsage,
})
export type AgentRunResult = typeof AgentRunResult.Type

const DEFAULT_DENIAL_NOTICE_FALLBACK = "Agent tool permission denied"
const DEFAULT_DIAGNOSTIC_DETAIL_FALLBACK = "Agent runner execution failed"

/** Formats a bounded `DenialNotice` (`<= 1024` chars) via `formatBoundedErrorMessage`. */
export const toDenialNotice = (
  raw: string,
  fallback = DEFAULT_DENIAL_NOTICE_FALLBACK,
): DenialNotice =>
  DenialNotice.make(
    formatBoundedErrorMessage({
      prefix: "",
      detail: raw,
      maxChars: MAX_DENIAL_NOTICE_CHARS,
      fallback: fallback.trim().length > 0 ? fallback : DEFAULT_DENIAL_NOTICE_FALLBACK,
    }),
  )

/** Formats a bounded `AgentDiagnosticDetail` (`<= 1024` chars) via `formatBoundedErrorMessage`. */
export const toAgentDiagnosticDetail = (
  raw: string,
  fallback = DEFAULT_DIAGNOSTIC_DETAIL_FALLBACK,
): AgentDiagnosticDetail =>
  AgentDiagnosticDetail.make(
    formatBoundedErrorMessage({
      prefix: "",
      detail: raw,
      maxChars: MAX_DIAGNOSTIC_DETAIL_CHARS,
      fallback: fallback.trim().length > 0 ? fallback : DEFAULT_DIAGNOSTIC_DETAIL_FALLBACK,
    }),
  )

/** Formats a bounded `AgentFailureReason` (`<= 2048` chars) via `formatBoundedErrorMessage`. */
export const toAgentFailureReason = (prefix: string, detail?: string): AgentFailureReason =>
  AgentFailureReason.make(
    formatBoundedErrorMessage({
      prefix,
      detail,
      separator: detail !== undefined && detail.trim().length > 0 ? ": " : "",
      maxChars: MAX_AGENT_FAILURE_REASON_CHARS,
      fallback: "Agent runner failed",
    }),
  )

/** Failure raised when a spawned runner exceeds its execution timeout budget. */
export class AgentTimeoutError extends Schema.TaggedError<AgentTimeoutError>()(
  "AgentTimeoutError",
  {
    runner: RunnerId,
    afterMillis: TimeoutMillis,
  },
) {
  override get message(): string {
    return `Runner '${this.runner}' timed out after ${this.afterMillis}ms`
  }
}

/** Failure raised when a runner denies a tool call or rejects unsupported MCP isolation. */
export class AgentToolDeniedError extends Schema.TaggedError<AgentToolDeniedError>()(
  "AgentToolDeniedError",
  {
    runner: RunnerId,
    notice: DenialNotice,
  },
) {
  override get message(): string {
    return `Runner '${this.runner}' tool denied: ${this.notice}`
  }
}

/** Failure raised when a runner requires operator re-authentication (triggers immediate escalation). */
export class AgentAuthRequiredError extends Schema.TaggedError<AgentAuthRequiredError>()(
  "AgentAuthRequiredError",
  {
    runner: RunnerId,
    detail: Schema.optional(AgentDiagnosticDetail),
  },
) {
  override get message(): string {
    const suffix = this.detail !== undefined ? `: ${this.detail}` : ""
    return `Runner '${this.runner}' requires authentication${suffix}`
  }
}

/** Failure raised when a runner exits non-zero, terminates by signal, or fails to spawn. */
export class AgentExitError extends Schema.TaggedError<AgentExitError>()("AgentExitError", {
  runner: RunnerId,
  exit: AgentNonZeroExitCode,
  kind: Schema.optional(AgentExitFailureKind),
  detail: Schema.optional(AgentDiagnosticDetail),
}) {
  override get message(): string {
    const suffix = this.detail !== undefined ? `: ${this.detail}` : ""
    return `Runner '${this.runner}' exited with code ${this.exit}${suffix}`
  }
}

/** Failure raised when runner `--output-format json` stdout fails `Schema` decode. */
export class AgentOutputParseError extends Schema.TaggedError<AgentOutputParseError>()(
  "AgentOutputParseError",
  {
    runner: RunnerId,
    detail: Schema.optional(AgentDiagnosticDetail),
  },
) {
  override get message(): string {
    const suffix = this.detail !== undefined ? `: ${this.detail}` : ""
    return `Runner '${this.runner}' produced invalid JSON output${suffix}`
  }
}

/** Failure raised when an automatic runner completes without modifying any owned files. */
export class AgentNoChangeError extends Schema.TaggedError<AgentNoChangeError>()(
  "AgentNoChangeError",
  {
    runner: RunnerId,
  },
) {
  override get message(): string {
    return `Runner '${this.runner}' produced no file changes in unit worktree`
  }
}

/** Closed union of typed failures produced by `AgentRunnerPort` and mapped by `toOutcome`. */
export const AgentRunnerError = Schema.Union([
  AgentTimeoutError,
  AgentToolDeniedError,
  AgentAuthRequiredError,
  AgentExitError,
  AgentOutputParseError,
  AgentNoChangeError,
])
export type AgentRunnerError = typeof AgentRunnerError.Type
