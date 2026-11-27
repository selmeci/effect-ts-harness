import { Schema } from "effect"
import { WorkspaceFilePath } from "./ast-and-gate-primitives.js"
import { WorkflowTimeoutMs } from "./workflow-timeouts.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

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
