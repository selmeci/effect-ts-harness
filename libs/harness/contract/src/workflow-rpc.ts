import { Schema } from "effect"
import { OmnigraphBranchName } from "./omnigraph.js"
import { AbsoluteRepoRoot, GitCommitSha } from "./repo-identity.js"
import { ReviewRoutingPlan } from "./review-routing.js"
import {
  AttemptNumber,
  CompiledPlan,
  EscalationDecision,
  LlmPhaseReceipt,
  OwnedRelPath,
  PackageStampHash,
  PlanSha256,
  RunnerId,
  SliceBranchName,
  TaskRunReceipt,
  UnitEscalation,
  UnitOutcome,
  UnitRejection,
  WaveIndex,
  WorkUnitId,
  WorkflowExecutionId,
  WorkflowLevel,
  WorkflowRunId,
} from "./workflow.js"
import {
  GitCommonDirPath,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  PlanJsonPayload,
  RejectionJsonPayload,
  WorkflowAttemptKey,
  WorkflowAttemptVerdict,
  WorkflowDaemonCapability,
  WorkflowRunState,
  WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowTimestampMs,
  WorkflowUnitKey,
  WorkflowUnitKind,
  WorkflowUnitStatus,
  WorktreePathKind,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
} from "./workflow-storage.js"
import { WorkflowShipAttemptRecord, WorkflowShipResponse } from "./workflow-ship.js"
import { WorkspaceFsOperation } from "./workspace-and-process.js"

export {
  PlanJsonPayload,
  RejectionJsonPayload,
  WorkflowAttemptKey,
  WorkflowAttemptVerdict,
  WorkflowRunState,
  WorkflowTimestampMs,
  WorkflowUnitKey,
  WorkflowUnitKind,
  WorkflowUnitStatus,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
}

/** Non-negative count of workflow runs reconstructed by `workflow doctor --rebuild-views`. */
export const WorkflowRebuiltRunCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("WorkflowRebuiltRunCount"),
)
export type WorkflowRebuiltRunCount = typeof WorkflowRebuiltRunCount.Type

/** Durable deferred name awaiting external completion (e.g. `unit/<id>/<attempt>`, `llm-phase-done`). */
export const PendingDeferredName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("PendingDeferredName"),
)
export type PendingDeferredName = typeof PendingDeferredName.Type

/** Identifier for a single `workflow doctor` diagnostic check row. */
export const WorkflowDoctorCheckName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.brand("WorkflowDoctorCheckName"),
)
export type WorkflowDoctorCheckName = typeof WorkflowDoctorCheckName.Type

/** Workflow store connectivity state surfaced by `workflow status` / `harness_workflow_plan`. */
export const WorkflowStoreAvailabilityState = Schema.Literals(["ready", "paused", "inactive"])
export type WorkflowStoreAvailabilityState = typeof WorkflowStoreAvailabilityState.Type

/** Projection freshness indicator surfaced by `workflow status` / `harness_workflow_plan`. */
export const WorkflowProjectionStatus = Schema.Literals(["not-projected", "fresh", "stale"])
export type WorkflowProjectionStatus = typeof WorkflowProjectionStatus.Type

/** Health verdict for one `workflow doctor` diagnostic check. */
export const WorkflowDoctorCheckStatus = Schema.Literals(["ok", "warn", "fail"])
export type WorkflowDoctorCheckStatus = typeof WorkflowDoctorCheckStatus.Type

/** Start disposition returned by `workflow.start`. */
export const WorkflowStartOutcome = Schema.Literals(["started", "existing"])
export type WorkflowStartOutcome = typeof WorkflowStartOutcome.Type

/** Doctor rebuild behavior flag passed to `workflow.doctor`. */
export const WorkflowDoctorMode = Schema.Literals(["check-only", "rebuild"])
export type WorkflowDoctorMode = typeof WorkflowDoctorMode.Type

/** Worktree assignment for one compiled work unit returned by `provisionWorktrees`. */
export const WorktreeUnitMapping = Schema.Struct({
  unitId: WorkUnitId,
  cwd: AbsoluteRepoRoot,
  worktreeKind: WorktreePathKind,
  branch: Schema.optional(SliceBranchName),
})
export type WorktreeUnitMapping = typeof WorktreeUnitMapping.Type

/** Receipt returned by `WorkflowWorktreePort.provisionWorktrees` and passed to compensation. */
export const WorktreeProvisionReceipt = Schema.Struct({
  runId: WorkflowRunId,
  canonicalRepoRoot: AbsoluteRepoRoot,
  implBranch: Schema.optional(OmnigraphBranchName),
  entries: Schema.Array(WorktreeUnitMapping),
})
export type WorktreeProvisionReceipt = typeof WorktreeProvisionReceipt.Type

/** Read-model summary of a `WfRun` node in `harness-workflows`. */
export const WorkflowRunRecord = Schema.Struct({
  runId: WorkflowRunId,
  executionId: WorkflowExecutionId,
  level: WorkflowLevel,
  planSha: PlanSha256,
  baseSha: GitCommitSha,
  state: WorkflowRunState,
  planJson: Schema.optional(PlanJsonPayload),
  updatedMs: WorkflowTimestampMs,
})
export type WorkflowRunRecord = typeof WorkflowRunRecord.Type

/** Read-model summary of a `WfUnit` node in `harness-workflows`. */
export const WorkflowUnitRecord = Schema.Struct({
  unitKey: WorkflowUnitKey,
  runId: WorkflowRunId,
  unitId: WorkUnitId,
  kind: WorkflowUnitKind,
  waveIndex: WaveIndex,
  status: WorkflowUnitStatus,
  ownedRelPaths: Schema.Array(OwnedRelPath),
  updatedMs: WorkflowTimestampMs,
})
export type WorkflowUnitRecord = typeof WorkflowUnitRecord.Type

const WorkflowAttemptRecordBase = {
  attemptKey: WorkflowAttemptKey,
  runId: WorkflowRunId,
  unitId: WorkUnitId,
  attempt: AttemptNumber,
  runner: Schema.optional(RunnerId),
  packageStampHash: Schema.optional(PackageStampHash),
  updatedMs: WorkflowTimestampMs,
} as const

export const DispatchedWorkflowAttemptRecord = Schema.Struct({
  ...WorkflowAttemptRecordBase,
  verdict: Schema.Literal("dispatched"),
})
export type DispatchedWorkflowAttemptRecord = typeof DispatchedWorkflowAttemptRecord.Type

export const CompletedWorkflowAttemptRecord = Schema.Struct({
  ...WorkflowAttemptRecordBase,
  verdict: Schema.Literal("completed"),
})
export type CompletedWorkflowAttemptRecord = typeof CompletedWorkflowAttemptRecord.Type

export const RejectedWorkflowAttemptRecord = Schema.Struct({
  ...WorkflowAttemptRecordBase,
  verdict: Schema.Literal("rejected"),
  rejection: UnitRejection,
})
export type RejectedWorkflowAttemptRecord = typeof RejectedWorkflowAttemptRecord.Type

/** Read-model summary of a `WfAttempt` node in `harness-workflows` (`rejected` requires typed `rejection`). */
export const WorkflowAttemptRecord = Schema.Union([
  DispatchedWorkflowAttemptRecord,
  CompletedWorkflowAttemptRecord,
  RejectedWorkflowAttemptRecord,
])
export type WorkflowAttemptRecord = typeof WorkflowAttemptRecord.Type

/** Active `DurableDeferred` entry reported in `WorkflowStatusSummary`. */
export const WorkflowPendingDeferred = Schema.TaggedUnion({
  UnitCompletion: {
    unitId: WorkUnitId,
    attempt: AttemptNumber,
    deferredName: PendingDeferredName,
  },
  Escalation: {
    unitId: WorkUnitId,
    deferredName: PendingDeferredName,
    escalation: UnitEscalation,
  },
  LlmPhase: {
    deferredName: PendingDeferredName,
  },
})
export type WorkflowPendingDeferred = typeof WorkflowPendingDeferred.Type

/** Typed terminal error classification surfaced in `WorkflowRunOutcome.Failed`. */
export const WorkflowTerminalError = Schema.TaggedUnion({
  Aborted: { runId: WorkflowRunId, escalation: UnitEscalation },
  OperatorAborted: { runId: WorkflowRunId, reason: WorkflowStoreFailureReason },
  WorkspaceFs: { operation: WorkspaceFsOperation, reason: WorkflowStoreFailureReason },
  StoreUnavailable: { operation: WorkflowStoreOperation, reason: WorkflowStoreFailureReason },
  LeaseHeld: {
    holderId: LeaseHolderId,
    leaseEpoch: Schema.optional(LeaseEpoch),
    lockFilePath: LeaseFilePath,
  },
  Interrupted: { reason: WorkflowStoreFailureReason },
  Defect: { reason: WorkflowStoreFailureReason },
})
export type WorkflowTerminalError = typeof WorkflowTerminalError.Type

/** Closed discriminated union of workflow run projection outcomes surfaced by `workflow status`. */
export const WorkflowRunOutcome = Schema.TaggedUnion({
  NotFound: {},
  Active: {
    run: WorkflowRunRecord,
    units: Schema.Array(WorkflowUnitRecord),
    attempts: Schema.Array(WorkflowAttemptRecord),
    pendingDeferreds: Schema.Array(WorkflowPendingDeferred),
    shipAttempts: Schema.optional(Schema.Array(WorkflowShipAttemptRecord)),
    projectionStatus: WorkflowProjectionStatus,
  },
  Completed: {
    run: WorkflowRunRecord,
    units: Schema.Array(WorkflowUnitRecord),
    attempts: Schema.Array(WorkflowAttemptRecord),
    pendingDeferreds: Schema.Array(WorkflowPendingDeferred),
    review: ReviewRoutingPlan,
    terminalReceipt: TaskRunReceipt,
    shipAttempts: Schema.optional(Schema.Array(WorkflowShipAttemptRecord)),
    projectionStatus: WorkflowProjectionStatus,
  },
  Failed: {
    run: WorkflowRunRecord,
    units: Schema.Array(WorkflowUnitRecord),
    attempts: Schema.Array(WorkflowAttemptRecord),
    pendingDeferreds: Schema.Array(WorkflowPendingDeferred),
    terminalError: WorkflowTerminalError,
    shipAttempts: Schema.optional(Schema.Array(WorkflowShipAttemptRecord)),
    projectionStatus: WorkflowProjectionStatus,
  },
})
export type WorkflowRunOutcome = typeof WorkflowRunOutcome.Type

/** Closed status snapshot union returned by `workflow status`, `workflow.status`, and `harness_workflow_plan`. */
export const WorkflowStatusSummary = Schema.TaggedUnion({
  DaemonOffline: {
    outcome: WorkflowRunOutcome,
  },
  StorePaused: {
    writerLeaseEpoch: LeaseEpoch,
    outcome: WorkflowRunOutcome,
  },
  Ready: {
    writerLeaseEpoch: LeaseEpoch,
    outcome: WorkflowRunOutcome,
  },
})
export type WorkflowStatusSummary = typeof WorkflowStatusSummary.Type

/** Daemon RPC request for `workflow.start`. */
export const WorkflowStartRequest = Schema.Struct({
  repoRoot: AbsoluteRepoRoot,
  plan: CompiledPlan,
})
export type WorkflowStartRequest = typeof WorkflowStartRequest.Type

/** Daemon RPC response for `workflow.start`. */
export const WorkflowStartResponse = Schema.Struct({
  runId: WorkflowRunId,
  executionId: WorkflowExecutionId,
  outcome: WorkflowStartOutcome,
})
export type WorkflowStartResponse = typeof WorkflowStartResponse.Type

/** Daemon RPC request for `workflow.status`. */
export const WorkflowStatusRequest = Schema.Struct({
  repoRoot: AbsoluteRepoRoot,
  runId: Schema.optional(WorkflowRunId),
})
export type WorkflowStatusRequest = typeof WorkflowStatusRequest.Type

/** Unit completion payload inside `WorkflowCompleteRequest`. */
export const WorkflowCompleteUnitRequest = Schema.TaggedStruct("CompleteUnit", {
  repoRoot: AbsoluteRepoRoot,
  unitId: WorkUnitId,
  runId: Schema.optional(WorkflowRunId),
})
export type WorkflowCompleteUnitRequest = typeof WorkflowCompleteUnitRequest.Type

/** LLM-phase completion payload inside `WorkflowCompleteRequest`. */
export const WorkflowCompleteLlmPhaseRequest = Schema.TaggedStruct("CompleteLlmPhase", {
  repoRoot: AbsoluteRepoRoot,
  runId: Schema.optional(WorkflowRunId),
})
export type WorkflowCompleteLlmPhaseRequest = typeof WorkflowCompleteLlmPhaseRequest.Type

/** Daemon RPC request union for `workflow.complete`. */
export const WorkflowCompleteRequest = Schema.Union([
  WorkflowCompleteUnitRequest,
  WorkflowCompleteLlmPhaseRequest,
])
export type WorkflowCompleteRequest = typeof WorkflowCompleteRequest.Type

/** Daemon RPC response union for `workflow.complete`. */
export const WorkflowCompleteResponse = Schema.TaggedUnion({
  UnitCompleted: {
    runId: WorkflowRunId,
    executionId: WorkflowExecutionId,
    outcome: UnitOutcome,
  },
  LlmPhaseCompleted: {
    runId: WorkflowRunId,
    executionId: WorkflowExecutionId,
    receipt: LlmPhaseReceipt,
  },
})
export type WorkflowCompleteResponse = typeof WorkflowCompleteResponse.Type

/** Daemon RPC request union for `workflow.resume` (`ResumeRun` vs `ResolveEscalation`). */
export const WorkflowResumeRequest = Schema.TaggedUnion({
  ResumeRun: {
    repoRoot: AbsoluteRepoRoot,
    runId: WorkflowRunId,
  },
  ResolveEscalation: {
    repoRoot: AbsoluteRepoRoot,
    runId: WorkflowRunId,
    unitId: WorkUnitId,
    decision: EscalationDecision,
  },
})
export type WorkflowResumeRequest = typeof WorkflowResumeRequest.Type

/** Daemon RPC response for `workflow.resume`. */
export const WorkflowResumeResponse = Schema.TaggedUnion({
  WorkflowResumed: {
    runId: WorkflowRunId,
    executionId: WorkflowExecutionId,
  },
  EscalationResolved: {
    runId: WorkflowRunId,
    executionId: WorkflowExecutionId,
    unitId: WorkUnitId,
    decision: EscalationDecision,
  },
})
export type WorkflowResumeResponse = typeof WorkflowResumeResponse.Type

/** Daemon RPC request for `workflow.abort`. */
export const WorkflowAbortRequest = Schema.Struct({
  repoRoot: AbsoluteRepoRoot,
  runId: WorkflowRunId,
})
export type WorkflowAbortRequest = typeof WorkflowAbortRequest.Type

/** Daemon RPC response for `workflow.abort`. */
export const WorkflowAbortResponse = Schema.Struct({
  runId: WorkflowRunId,
  executionId: WorkflowExecutionId,
  state: WorkflowRunState,
})
export type WorkflowAbortResponse = typeof WorkflowAbortResponse.Type

/** Daemon RPC request for `workflow.doctor`. */
export const WorkflowDoctorRequest = Schema.Struct({
  repoRoot: AbsoluteRepoRoot,
  mode: WorkflowDoctorMode,
})
export type WorkflowDoctorRequest = typeof WorkflowDoctorRequest.Type

/** One diagnostic row returned by `workflow doctor` / `workflow.doctor`. */
export const WorkflowDoctorCheckItem = Schema.Struct({
  name: WorkflowDoctorCheckName,
  status: WorkflowDoctorCheckStatus,
  detail: WorkflowStoreFailureReason,
})
export type WorkflowDoctorCheckItem = typeof WorkflowDoctorCheckItem.Type

/** Daemon RPC response for `workflow.doctor`. */
export const WorkflowDoctorResponse = Schema.Struct({
  repoRoot: AbsoluteRepoRoot,
  commonGitDir: GitCommonDirPath,
  writerLeaseEpoch: Schema.optional(LeaseEpoch),
  rebuiltRunCount: WorkflowRebuiltRunCount,
  checks: Schema.Array(WorkflowDoctorCheckItem),
})
export type WorkflowDoctorResponse = typeof WorkflowDoctorResponse.Type

/** Read-only output payload returned by `harness_workflow_plan` MCP tool. */
export const WorkflowPlanToolOutput = Schema.Struct({
  resolvedRepoRoot: AbsoluteRepoRoot,
  commonGitDir: GitCommonDirPath,
  status: WorkflowStatusSummary,
})
export type WorkflowPlanToolOutput = typeof WorkflowPlanToolOutput.Type

/** Request correlation identifier carried on Unix-socket daemon RPC envelopes. */
export const WorkflowRpcRequestId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("WorkflowRpcRequestId"),
)
export type WorkflowRpcRequestId = typeof WorkflowRpcRequestId.Type

/** Union of typed result payloads returned by workflow daemon RPC handlers. */
export const WorkflowRpcResult = Schema.Union([
  WorkflowStartResponse,
  WorkflowStatusSummary,
  WorkflowCompleteResponse,
  WorkflowResumeResponse,
  WorkflowAbortResponse,
  WorkflowDoctorResponse,
  WorkflowShipResponse,
])
export type WorkflowRpcResult = typeof WorkflowRpcResult.Type

/** Typed success envelope returned over `<git-common-dir>/harness/daemon.sock`. */
export const WorkflowRpcSuccessEnvelope = Schema.Struct({
  id: WorkflowRpcRequestId,
  ok: Schema.Literal(true),
  command: WorkflowDaemonCapability,
  result: WorkflowRpcResult,
})
export type WorkflowRpcSuccessEnvelope = typeof WorkflowRpcSuccessEnvelope.Type

/** Typed error envelope returned over `<git-common-dir>/harness/daemon.sock`. */
export const WorkflowRpcErrorEnvelope = Schema.Struct({
  id: WorkflowRpcRequestId,
  ok: Schema.Literal(false),
  command: WorkflowDaemonCapability,
  error: WorkflowStoreFailureReason,
  detail: WorkflowStoreFailureReason,
})
export type WorkflowRpcErrorEnvelope = typeof WorkflowRpcErrorEnvelope.Type

/** Closed RPC response envelope union exchanged over the Unix socket daemon. */
export const WorkflowRpcEnvelope = Schema.Union([
  WorkflowRpcSuccessEnvelope,
  WorkflowRpcErrorEnvelope,
])
export type WorkflowRpcEnvelope = typeof WorkflowRpcEnvelope.Type
