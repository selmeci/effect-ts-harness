import { Match, Schema } from "effect"
import { AbsoluteRepoRoot } from "./repo-identity.js"
import {
  AgentFailureReason,
  AttemptNumber,
  MaxConcurrency,
  OwnedRelPath,
  RunnerId,
  WorkUnitId,
  WorkflowRunId,
} from "./workflow.js"
import { PackageVerifyCommand } from "./workflow-verify-command.js"
import { formatBoundedErrorMessage } from "./workspace-and-process.js"

const hasNoControlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

const MAX_DENIAL_NOTICE_CHARS = 1024
const MAX_DIAGNOSTIC_DETAIL_CHARS = 1024
const MAX_AGENT_FAILURE_REASON_CHARS = 2048

/** Closed CLI binary executable names allowed for WF-5 workflow agent runners. */
export const EXECUTABLE_NAMES = ["claude", "agy"] as const

/** Branded executable binary name (`"claude" | "agy"`). */
export const ExecutableName = Schema.Literals(EXECUTABLE_NAMES).pipe(Schema.brand("ExecutableName"))
export type ExecutableName = typeof ExecutableName.Type

/** Branded CLI permission/tool rule; forbids `--dangerously-skip-permissions` at schema level (`REQ-4.1`). */
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

/** Positive integer runner timeout budget in milliseconds. */
export const TimeoutMillis = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
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

/** Bounded POSIX exit code (`0..255`) reported by an agent runner subprocess. */
export const AgentExitCode = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
  Schema.brand("AgentExitCode"),
)
export type AgentExitCode = typeof AgentExitCode.Type

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

/** Validated POSIX absolute path to a generated or scoped runner configuration file. */
export const RunnerConfigFilePath = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(1024)),
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^(?:\/(?!\.\.?(?:\/|$))[^\\/]+)+$/)),
  Schema.check(
    Schema.makeFilter(hasNoControlChars, {
      message: "RunnerConfigFilePath must not contain ASCII control characters",
    }),
  ),
  Schema.brand("RunnerConfigFilePath"),
)
export type RunnerConfigFilePath = typeof RunnerConfigFilePath.Type

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

/** Supported Antigravity `--mode` values (`agy 1.5.10`). */
export const ANTIGRAVITY_MODES = ["accept-edits", "auto", "plan"] as const
export const AntigravityMode = Schema.Literals(ANTIGRAVITY_MODES)
export type AntigravityMode = typeof AntigravityMode.Type

/** MCP isolation strength requested for an agent run (`"standard" | "hard"`). */
export const MCP_ISOLATION_LEVELS = ["standard", "hard"] as const
export const McpIsolationLevel = Schema.Literals(MCP_ISOLATION_LEVELS)
export type McpIsolationLevel = typeof McpIsolationLevel.Type

/** Policy applied when `antigravity` receives a request requiring `"hard"` MCP isolation. */
export const MCP_FALLBACK_POLICIES = ["reject", "fallback-claude"] as const
export const McpFallbackPolicy = Schema.Literals(MCP_FALLBACK_POLICIES)
export type McpFallbackPolicy = typeof McpFallbackPolicy.Type

/** Closed indicator of whether CLI usage telemetry was present in the runner envelope. */
export const AGENT_USAGE_STATUSES = ["reported", "unavailable"] as const
export const AgentUsageStatus = Schema.Literals(AGENT_USAGE_STATUSES)
export type AgentUsageStatus = typeof AgentUsageStatus.Type

/** Normalized token/turn/cost usage telemetry extracted from a runner JSON envelope. */
export const AgentUsage = Schema.Struct({
  status: AgentUsageStatus,
  inputTokens: Schema.optional(AgentTokenCount),
  outputTokens: Schema.optional(AgentTokenCount),
  thinkingTokens: Schema.optional(AgentTokenCount),
  totalTokens: Schema.optional(AgentTokenCount),
  numTurns: Schema.optional(AgentTurnCount),
  totalCostUsd: Schema.optional(AgentCostUsd),
  durationMillis: Schema.optional(AgentDurationMillis),
  sessionId: Schema.optional(AgentSessionId),
})
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

const matchesRunnerBinary = (runner: RunnerId, binary: ExecutableName): boolean =>
  Match.value(runner).pipe(
    Match.when("claude-code", () => binary === "claude"),
    Match.when("antigravity", () => binary === "agy"),
    Match.exhaustive,
  )

/** Typed constant runner capability profile (`libs/harness/infra/src/workflow/runner-profiles.ts`). */
export const RunnerProfile = Schema.Struct({
  runner: RunnerId,
  binary: ExecutableName,
  permissionRules: Schema.Array(PermissionRule),
  disallowedTools: Schema.Array(PermissionRule),
  maxConcurrency: MaxConcurrency,
  timeoutMillis: TimeoutMillis,
  maxTurns: Schema.optional(AgentMaxTurns),
  model: Schema.optional(ModelName),
  antigravityMode: Schema.optional(AntigravityMode),
}).pipe(
  Schema.check(
    Schema.makeFilter((profile) => matchesRunnerBinary(profile.runner, profile.binary), {
      message:
        "RunnerProfile binary must match runner ('claude-code' -> 'claude', 'antigravity' -> 'agy')",
    }),
  ),
)
export type RunnerProfile = typeof RunnerProfile.Type

/** Execution request dispatched to `AgentRunnerPort.run`. */
export const AgentRunRequest = Schema.Struct({
  runId: Schema.optional(WorkflowRunId),
  runner: RunnerId,
  brief: UnitBrief,
  cwd: AbsoluteRepoRoot,
  mcpIsolation: Schema.optional(McpIsolationLevel),
  hardMcpFallback: Schema.optional(McpFallbackPolicy),
})
export type AgentRunRequest = typeof AgentRunRequest.Type

/** Normalized success outcome returned by `AgentRunnerPort.run`. */
export const AgentRunResult = Schema.Struct({
  runner: RunnerId,
  exit: AgentExitCode,
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
  exit: AgentExitCode,
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
