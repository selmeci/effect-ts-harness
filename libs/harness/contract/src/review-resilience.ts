import { Schema } from "effect"
import { WorkspaceFilePath } from "./ast-and-gate-primitives.js"
import { WorkflowTimeoutMs } from "./workflow-timeouts.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

/** Bounded retry attempts for interrupt-protected single-flight / warmup waiters. */
export const DEFAULT_MAX_INTERRUPT_RETRIES = 4 as const

/** Branded shell command text passed to `PolicyFastPath.decide` and `GuardDecision.decide`. */
export const ShellCommandText = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(32_768)),
  Schema.brand("ShellCommandText"),
)
export type ShellCommandText = typeof ShellCommandText.Type

/** Branded trimmed non-empty explanation returned alongside guard verdicts (`1..1024` chars). */
export const GuardReasonText = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.brand("GuardReasonText"),
)
export type GuardReasonText = typeof GuardReasonText.Type

/** Branded trimmed non-empty error summary for `GuardModelOutcome.ModelError` (`1..256` chars). */
export const GuardModelErrorDetail = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("GuardModelErrorDetail"),
)
export type GuardModelErrorDetail = typeof GuardModelErrorDetail.Type

/** Branded probability score in `[0, 1]` produced by `GuardV1`. */
export const GuardRiskProbability = Schema.Number.pipe(
  Schema.check(Schema.isFinite()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  Schema.brand("GuardRiskProbability"),
)
export type GuardRiskProbability = typeof GuardRiskProbability.Type

/** Final three-way guard enforcement verdict. */
export const GuardVerdictAction = Schema.Literals(["allow", "deny", "ask"])
export type GuardVerdictAction = typeof GuardVerdictAction.Type

/** Deterministic fast-path pre-classification verdict before optional `DecisionModel` escalation. */
export const GuardFastPathVerdict = Schema.Literals(["allow", "deny", "ask", "escalate"])
export type GuardFastPathVerdict = typeof GuardFastPathVerdict.Type

/** Structured verdict and diagnostic reason returned by `GuardDecision.decide`. */
export const GuardDecisionResult = Schema.Struct({
  verdict: GuardVerdictAction,
  reason: GuardReasonText,
})
export type GuardDecisionResult = typeof GuardDecisionResult.Type

/** Closed union capturing the outcome of evaluating `GuardV1` via `DecisionModel`. */
export const GuardModelOutcome = Schema.TaggedUnion({
  NotEvaluated: {},
  TimedOut: {},
  ModelError: {
    detail: GuardModelErrorDetail,
  },
  Scored: {
    destructive: GuardRiskProbability,
    secretAccess: GuardRiskProbability,
    exfiltration: GuardRiskProbability,
  },
})
export type GuardModelOutcome = typeof GuardModelOutcome.Type

/** Branded input contract for `GuardDecision.decide`. */
export const GuardDecisionInput = Schema.Struct({
  command: ShellCommandText,
  fastPath: GuardFastPathVerdict,
  unitWorkerMode: Schema.optional(Schema.Boolean),
  modelOutcome: GuardModelOutcome,
})
export type GuardDecisionInput = typeof GuardDecisionInput.Type

/** Branded input contract for `PolicyFastPath.decide`. */
export const PolicyFastPathInput = Schema.Struct({
  command: ShellCommandText,
  unitWorkerMode: Schema.optional(Schema.Boolean),
})
export type PolicyFastPathInput = typeof PolicyFastPathInput.Type

/** Branded trimmed non-empty LSP executable or subcommand name (`1..128` chars). */
export const LspCommandName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.brand("LspCommandName"),
)
export type LspCommandName = typeof LspCommandName.Type

/** Branded trimmed non-empty LSP cycle or diagnostic hint (`1..512` chars). */
export const LspDiagnosticHint = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(512)),
  Schema.brand("LspDiagnosticHint"),
)
export type LspDiagnosticHint = typeof LspDiagnosticHint.Type

/** Branded trimmed non-empty local Ollama model identifier (`1..128` chars). */
export const OllamaModelName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.brand("OllamaModelName"),
)
export type OllamaModelName = typeof OllamaModelName.Type

/** Branded trimmed non-empty Ollama loopback endpoint URL (`1..512` chars). */
export const OllamaEndpointUrl = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(512)),
  Schema.brand("OllamaEndpointUrl"),
)
export type OllamaEndpointUrl = typeof OllamaEndpointUrl.Type

/** Branded lifecycle stage at which local Ollama warm-up failed. */
export const OllamaWarmupStage = Schema.Literals([
  "server-start",
  "systemone-probe",
  "embeddings-probe",
]).pipe(Schema.brand("OllamaWarmupStage"))
export type OllamaWarmupStage = typeof OllamaWarmupStage.Type

/**
 * Typed failure returned when `LspDiagnostics.run` terminates a hung `effect-tsgo` or
 * `tsgolint` process group after exceeding its watchdog timeout (`SPEC-0037 REQ-1.2`).
 */
export class LspDiagnosticsTimeoutError extends Schema.TaggedError<LspDiagnosticsTimeoutError>()(
  "LspDiagnosticsTimeoutError",
  {
    command: LspCommandName,
    timeoutMs: WorkflowTimeoutMs,
    targetPath: Schema.optional(WorkspaceFilePath),
    cycleHint: Schema.optional(LspDiagnosticHint),
    reason: ErrorReasonMessage,
  },
) {}

/**
 * Typed diagnostic error emitted when local Ollama fails to become warm within the
 * configured warm-up probe budget (`SPEC-0037 REQ-2.3`).
 */
export class OllamaWarmupError extends Schema.TaggedError<OllamaWarmupError>()(
  "OllamaWarmupError",
  {
    stage: OllamaWarmupStage,
    model: OllamaModelName,
    endpoint: OllamaEndpointUrl,
    timeoutMs: WorkflowTimeoutMs,
    reason: ErrorReasonMessage,
  },
) {}
