import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { AbsoluteRepoRoot } from "./repo-identity.js"
import {
  GateExitCode,
  PlanSha256,
  ShipAttempt,
  ShipReceipt,
  ShipStage,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkflowTimestampMs,
  WorkspaceTreeHash,
} from "./workflow.js"
import { ErrorReasonMessage, formatBoundedErrorMessage } from "./workspace-and-process.js"

const SHIP_ATTEMPT_KEY_RE = /^[a-z0-9][a-z0-9-]{7,63}#[1-9]\d*$/

/** Typed components extracted from a canonical `ShipAttemptKey` (`<runId>#<attempt>`). */
export const ShipAttemptKeyParts = Schema.Struct({
  runId: WorkflowRunId,
  attempt: ShipAttempt,
})
export type ShipAttemptKeyParts = typeof ShipAttemptKeyParts.Type

const decodeWorkflowRunIdOption = Schema.decodeUnknownOption(WorkflowRunId)
const decodeShipAttemptOption = Schema.decodeUnknownOption(ShipAttempt)

/** Decodes a persisted `WfShipAttempt.shipKey` (`<runId>#<attempt>`) strictly into its typed components. */
export const decodeShipAttemptKey = (
  raw: string,
): Result.Result<ShipAttemptKeyParts, ErrorReasonMessage> => {
  const hashIdx = raw.indexOf("#")
  if (hashIdx <= 0 || raw.indexOf("#", hashIdx + 1) !== -1) {
    return Result.fail(
      ErrorReasonMessage.make(`Invalid ShipAttemptKey '${raw}': expected '<runId>#<attempt>'`),
    )
  }
  const runPart = raw.slice(0, hashIdx)
  const attemptPart = raw.slice(hashIdx + 1)
  if (!/^[1-9]\d*$/.test(attemptPart)) {
    return Result.fail(
      ErrorReasonMessage.make(
        `Invalid ShipAttemptKey '${raw}': attempt must be a positive integer`,
      ),
    )
  }
  const parsedAttempt = Number(attemptPart)
  if (!Number.isSafeInteger(parsedAttempt)) {
    return Result.fail(
      ErrorReasonMessage.make(
        `Invalid ShipAttemptKey '${raw}': attempt exceeds safe integer range`,
      ),
    )
  }
  const runOpt = decodeWorkflowRunIdOption(runPart)
  const attemptOpt = decodeShipAttemptOption(parsedAttempt)
  return match([runOpt, attemptOpt] as const)
    .with([{ _tag: "Some" }, { _tag: "Some" }], ([{ value: runId }, { value: attempt }]) =>
      Result.succeed(ShipAttemptKeyParts.make({ runId, attempt })),
    )
    .with(
      [{ _tag: "None" }, { _tag: "Some" }],
      [{ _tag: "Some" }, { _tag: "None" }],
      [{ _tag: "None" }, { _tag: "None" }],
      () =>
        Result.fail(
          ErrorReasonMessage.make(`Invalid ShipAttemptKey '${raw}': malformed runId or attempt`),
        ),
    )
    .exhaustive()
}

/** Composite key `<runId>#<attempt>` identifying a `WfShipAttempt` node in `harness-workflows`. */
export const ShipAttemptKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.check(Schema.isPattern(SHIP_ATTEMPT_KEY_RE)),
  Schema.check(
    Schema.makeFilter((raw) => Result.isSuccess(decodeShipAttemptKey(raw)), {
      message:
        "ShipAttemptKey must be '<runId>#<attempt>' with a valid WorkflowRunId and bounded I32 ShipAttempt (1..2147483647)",
    }),
  ),
  Schema.brand("ShipAttemptKey"),
)
export type ShipAttemptKey = typeof ShipAttemptKey.Type

/** Canonical constructor for `ShipAttemptKey` (`<runId>#<attempt>`). */
export const encodeShipAttemptKey = (runId: WorkflowRunId, attempt: ShipAttempt): ShipAttemptKey =>
  ShipAttemptKey.make(`${runId}#${attempt}`)

/** Persistence status literals recorded on `WfShipAttempt.status`. */
export const ShipAttemptStatus = Schema.Literals(["running", "passed", "failed"])
export type ShipAttemptStatus = typeof ShipAttemptStatus.Type

/** `LoopCircuitBreaker.decide` status surfaced with a `ShipGateFailedError`. */
export const CircuitBreakerStatus = Schema.Literals(["clear", "tripped"])
export type CircuitBreakerStatus = typeof CircuitBreakerStatus.Type

/** Origin of the `runId` evaluated during a `workflow ship` execution. */
export const ShipRunOrigin = Schema.Literals(["compiled", "ephemeral"])
export type ShipRunOrigin = typeof ShipRunOrigin.Type

/** Error tag union identifying which terminal `ShipWorkflowError` aborted a stage. */
export const ShipErrorTag = Schema.Literals([
  "ShipGateFailedError",
  "ShipTreeMismatchError",
  "MutationRestoreError",
  "ShipTreeDriftError",
])
export type ShipErrorTag = typeof ShipErrorTag.Type

/** Bounded stderr/diagnostic snippet captured when a `ShipStage` subprocess or gate fails. */
export const GateStderrSummary = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(4096)),
  Schema.brand("GateStderrSummary"),
)
export type GateStderrSummary = typeof GateStderrSummary.Type

/** Non-negative wall-clock execution duration in milliseconds for one `ShipStage` run. */
export const GateDurationMs = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("GateDurationMs"),
)
export type GateDurationMs = typeof GateDurationMs.Type

/** Bounded human-readable diagnostic summary for `ShipWorkflow` failures and escalations. */
export const ShipFailureMessage = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(2048)),
  Schema.brand("ShipFailureMessage"),
)
export type ShipFailureMessage = typeof ShipFailureMessage.Type

/** Failure of one of the 6 canonical `ShipStage` gates inside `ShipWorkflow`. */
export class ShipGateFailedError extends Schema.TaggedError<ShipGateFailedError>()(
  "ShipGateFailedError",
  {
    stage: ShipStage,
    exitCode: GateExitCode,
    stderrSummary: GateStderrSummary,
    circuitBreakerStatus: CircuitBreakerStatus,
    escalationMessage: Schema.optional(ShipFailureMessage),
    durationMs: Schema.optional(GateDurationMs),
  },
) {
  override get message(): string {
    const breakerNote = match(this.circuitBreakerStatus)
      .with("tripped", () => " [circuit breaker tripped]")
      .with("clear", () => "")
      .exhaustive()
    const esc = this.escalationMessage !== undefined ? ` — ${this.escalationMessage}` : ""
    const stderr = this.stderrSummary.length > 0 ? `: ${this.stderrSummary}` : ""
    return `Ship gate '${this.stage}' failed with exit code ${this.exitCode}${breakerNote}${stderr}${esc}`
  }
}

/** Pre-gate workspace tree hash mismatch (`computeWorkspaceTreeHash !== expected`, zero gate execution). */
export class ShipTreeMismatchError extends Schema.TaggedError<ShipTreeMismatchError>()(
  "ShipTreeMismatchError",
  {
    stage: ShipStage,
    expected: WorkspaceTreeHash,
    actual: WorkspaceTreeHash,
  },
) {
  override get message(): string {
    return `Workspace tree hash mismatch before '${this.stage}': expected ${this.expected}, got ${this.actual}`
  }
}

/** Backup restoration or post-gate tree verification failure around `mutate --strict`. */
export class MutationRestoreError extends Schema.TaggedError<MutationRestoreError>()(
  "MutationRestoreError",
  {
    expected: WorkspaceTreeHash,
    actual: Schema.optional(WorkspaceTreeHash),
    detail: Schema.optional(ShipFailureMessage),
  },
) {
  override get message(): string {
    const actualPart = this.actual !== undefined ? `got ${this.actual}` : "actual hash unavailable"
    const detailPart = this.detail !== undefined ? ` (${this.detail})` : ""
    return `Mutation backup restore or tree check failed: expected ${this.expected}, ${actualPart}${detailPart}`
  }
}

/** Workspace tree hash drift detected immediately after `done --cli` completed. */
export class ShipTreeDriftError extends Schema.TaggedError<ShipTreeDriftError>()(
  "ShipTreeDriftError",
  {
    stage: ShipStage,
    expected: WorkspaceTreeHash,
    actual: WorkspaceTreeHash,
  },
) {
  override get message(): string {
    return `Workspace tree hash drifted after '${this.stage}': expected ${this.expected}, got ${this.actual}`
  }
}

/** Closed union of typed failures returned by `ShipWorkflow`. */
export const ShipWorkflowError = Schema.Union([
  ShipGateFailedError,
  ShipTreeMismatchError,
  MutationRestoreError,
  ShipTreeDriftError,
])
export type ShipWorkflowError = typeof ShipWorkflowError.Type

/** Input payload for `ShipWorkflow` (`idempotencyKey = "${runId}:${treeHash}:${attempt}"`). */
export const ShipWorkflowPayload = Schema.Struct({
  runId: WorkflowRunId,
  treeHash: WorkspaceTreeHash,
  attempt: ShipAttempt,
  repoRoot: Schema.optional(AbsoluteRepoRoot),
  planSha: Schema.optional(PlanSha256),
})
export type ShipWorkflowPayload = typeof ShipWorkflowPayload.Type

/** Port input for `ShipGateRunner.computeTreeHash`. */
export const ShipTreeHashInput = Schema.Struct({
  runId: WorkflowRunId,
  attempt: ShipAttempt,
  stage: ShipStage,
  repoRoot: Schema.optional(AbsoluteRepoRoot),
})
export type ShipTreeHashInput = typeof ShipTreeHashInput.Type

/** Port input for `ShipGateRunner.recoverMutationBackup`. */
export const ShipRecoverBackupInput = Schema.Struct({
  runId: WorkflowRunId,
  attempt: ShipAttempt,
  expectedTreeHash: WorkspaceTreeHash,
  repoRoot: Schema.optional(AbsoluteRepoRoot),
})
export type ShipRecoverBackupInput = typeof ShipRecoverBackupInput.Type

/** Port input for `ShipGateRunner.executeStageCommand`. */
export const ShipStageCommandInput = Schema.Struct({
  runId: WorkflowRunId,
  attempt: ShipAttempt,
  stage: ShipStage,
  treeHash: WorkspaceTreeHash,
  repoRoot: Schema.optional(AbsoluteRepoRoot),
})
export type ShipStageCommandInput = typeof ShipStageCommandInput.Type

/** Passed result recorded for an executed `ShipStage`. */
export const ShipStagePassed = Schema.TaggedStruct("Passed", {
  stage: ShipStage,
  durationMs: GateDurationMs,
})
export type ShipStagePassed = typeof ShipStagePassed.Type

/** Failed result recorded for a blocked or erroring `ShipStage`. */
export const ShipStageFailed = Schema.TaggedStruct("Failed", {
  stage: ShipStage,
  durationMs: GateDurationMs,
  errorTag: ShipErrorTag,
  detail: ShipFailureMessage,
})
export type ShipStageFailed = typeof ShipStageFailed.Type

/** Closed discriminated per-stage outcome reported in `WorkflowShipOutcome` and progress streams. */
export const ShipStageProgress = Schema.Union([ShipStagePassed, ShipStageFailed])
export type ShipStageProgress = typeof ShipStageProgress.Type

/** NDJSON progress event streamed over Unix-socket IPC while `workflow.ship` executes. */
export const ShipStreamProgressEvent = Schema.TaggedUnion({
  StageStarted: {
    runId: WorkflowRunId,
    attempt: ShipAttempt,
    stage: ShipStage,
  },
  StageFinished: {
    runId: WorkflowRunId,
    attempt: ShipAttempt,
    progress: ShipStageProgress,
  },
})
export type ShipStreamProgressEvent = typeof ShipStreamProgressEvent.Type

/** Read-model summary of a `WfShipAttempt` node in `harness-workflows`. */
export const WorkflowShipAttemptRecord = Schema.Struct({
  shipKey: ShipAttemptKey,
  runId: WorkflowRunId,
  attempt: ShipAttempt,
  treeHash: WorkspaceTreeHash,
  status: ShipAttemptStatus,
  updatedMs: WorkflowTimestampMs,
})
export type WorkflowShipAttemptRecord = typeof WorkflowShipAttemptRecord.Type

/** Port input for `ShipAttemptStore.allocateAttempt` under Omnigraph OCC. */
export const AllocateShipAttemptInput = Schema.Struct({
  runId: WorkflowRunId,
  treeHash: WorkspaceTreeHash,
})
export type AllocateShipAttemptInput = typeof AllocateShipAttemptInput.Type

/** Port input for `ShipAttemptStore.updateStatus`. */
export const UpdateShipAttemptStatusInput = Schema.Struct({
  runId: WorkflowRunId,
  attempt: ShipAttempt,
  status: ShipAttemptStatus,
})
export type UpdateShipAttemptStatusInput = typeof UpdateShipAttemptStatusInput.Type

/** Daemon RPC request for `workflow.ship`. */
export const WorkflowShipRequest = Schema.Struct({
  repoRoot: AbsoluteRepoRoot,
  runId: Schema.optional(WorkflowRunId),
})
export type WorkflowShipRequest = typeof WorkflowShipRequest.Type

/** Terminal outcome union returned inside `WorkflowShipResponse`. */
export const WorkflowShipOutcome = Schema.TaggedUnion({
  Passed: {
    receipt: ShipReceipt,
    stages: Schema.Array(ShipStageProgress),
  },
  Failed: {
    runId: WorkflowRunId,
    attempt: ShipAttempt,
    treeHash: WorkspaceTreeHash,
    stages: Schema.Array(ShipStageProgress),
    error: ShipWorkflowError,
  },
})
export type WorkflowShipOutcome = typeof WorkflowShipOutcome.Type

/** Daemon RPC response for `workflow.ship`. */
export const WorkflowShipResponse = Schema.Struct({
  runId: WorkflowRunId,
  attempt: ShipAttempt,
  executionId: WorkflowExecutionId,
  treeHash: WorkspaceTreeHash,
  runOrigin: ShipRunOrigin,
  outcome: WorkflowShipOutcome,
})
export type WorkflowShipResponse = typeof WorkflowShipResponse.Type

const MAX_FAILURE_MESSAGE_CHARS = 2048

const formatBoundedShipGateFailure = (error: ShipGateFailedError): string => {
  const breakerNote = match(error.circuitBreakerStatus)
    .with("tripped", () => " [circuit breaker tripped]")
    .with("clear", () => "")
    .exhaustive()
  const prefix = `Ship gate '${error.stage}' failed with exit code ${error.exitCode}${breakerNote}`
  const escSuffix = error.escalationMessage !== undefined ? ` — ${error.escalationMessage}` : ""
  if (escSuffix.length > 0 && prefix.trim().length + escSuffix.length > MAX_FAILURE_MESSAGE_CHARS) {
    return formatBoundedErrorMessage({
      prefix,
      detail: error.escalationMessage,
      separator: " — ",
      maxChars: MAX_FAILURE_MESSAGE_CHARS,
      fallback: "Ship workflow failed",
    })
  }
  return formatBoundedErrorMessage({
    prefix,
    detail: error.stderrSummary,
    trailingSuffix: escSuffix,
    separator: ": ",
    maxChars: MAX_FAILURE_MESSAGE_CHARS,
    fallback: "Ship workflow failed",
  })
}

const formatBoundedMutationRestore = (error: MutationRestoreError): string => {
  const actualPart = error.actual !== undefined ? `got ${error.actual}` : "actual hash unavailable"
  const base = `Mutation backup restore or tree check failed: expected ${error.expected}, ${actualPart}`
  const trimmedDetail = error.detail?.trim() ?? ""
  if (trimmedDetail.length === 0) {
    return formatBoundedErrorMessage({
      prefix: base,
      maxChars: MAX_FAILURE_MESSAGE_CHARS,
      fallback: "Ship workflow failed",
    })
  }
  const trimmedBase = base.trim()
  const detailBudget = MAX_FAILURE_MESSAGE_CHARS - trimmedBase.length - 3
  const slicedDetail =
    detailBudget > 0
      ? formatBoundedErrorMessage({
          prefix: "",
          detail: trimmedDetail,
          maxChars: detailBudget,
        })
      : ""
  if (slicedDetail.length > 0) {
    return formatBoundedErrorMessage({
      prefix: base,
      detail: error.detail,
      trailingSuffix: ")",
      separator: " (",
      maxChars: MAX_FAILURE_MESSAGE_CHARS,
      fallback: "Ship workflow failed",
    })
  }
  return formatBoundedErrorMessage({
    prefix: base,
    maxChars: MAX_FAILURE_MESSAGE_CHARS,
    fallback: "Ship workflow failed",
  })
}

/** Extracts a typed `ShipWorkflowError` message safely as a bounded `ShipFailureMessage`. */
export const toShipFailureMessage = (error: ShipWorkflowError): ShipFailureMessage => {
  const bounded = match(error)
    .with({ _tag: "ShipGateFailedError" }, formatBoundedShipGateFailure)
    .with({ _tag: "MutationRestoreError" }, formatBoundedMutationRestore)
    .with({ _tag: "ShipTreeMismatchError" }, { _tag: "ShipTreeDriftError" }, (e) =>
      formatBoundedErrorMessage({
        prefix: e.message.trim(),
        maxChars: MAX_FAILURE_MESSAGE_CHARS,
        fallback: "Ship workflow failed",
      }),
    )
    .exhaustive()
  return ShipFailureMessage.make(bounded.length > 0 ? bounded : "Ship workflow failed")
}
