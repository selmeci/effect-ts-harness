import { Schema } from "effect"
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
  WaveIndex,
  WorkUnitId,
  WorkflowExecutionId,
  WorkflowLevel,
  WorkflowRunId,
} from "./workflow.js"
import {
  GitCommonDirPath,
  LeaseEpoch,
  WorkflowStoreFailureReason,
  WorktreePathKind,
} from "./workflow-storage.js"

/** Non-negative count of workflow runs reconstructed by `workflow doctor --rebuild-views`. */
export const WorkflowRebuiltRunCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("WorkflowRebuiltRunCount"),
)
export type WorkflowRebuiltRunCount = typeof WorkflowRebuiltRunCount.Type

/** Non-negative epoch millisecond timestamp recorded in workflow read-model records. */
export const WorkflowTimestampMs = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("WorkflowTimestampMs"),
)
export type WorkflowTimestampMs = typeof WorkflowTimestampMs.Type

/** Composite key `<runId>/<unitId>` identifying a `WfUnit` read-model node. */
export const WorkflowUnitKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("WorkflowUnitKey"),
)
export type WorkflowUnitKey = typeof WorkflowUnitKey.Type

/** Composite key `<runId>/<unitId>#...` identifying a `WfAttempt` read-model node. */
export const WorkflowAttemptKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("WorkflowAttemptKey"),
)
export type WorkflowAttemptKey = typeof WorkflowAttemptKey.Type

/** Serialized `CompiledPlan` JSON stored on `WfRun.planJson`. */
export const PlanJsonPayload = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("PlanJsonPayload"),
)
export type PlanJsonPayload = typeof PlanJsonPayload.Type

/** Serialized `UnitRejection` / escalation JSON stored on `WfAttempt.rejection`. */
export const RejectionJsonPayload = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("RejectionJsonPayload"),
)
export type RejectionJsonPayload = typeof RejectionJsonPayload.Type

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

/** Lifecycle states persisted in `WfRun.state`. */
export const WorkflowRunState = Schema.Literals(["running", "waiting", "completed", "aborted"])
export type WorkflowRunState = typeof WorkflowRunState.Type

/** Unit kinds persisted in `WfUnit.kind`. */
export const WorkflowUnitKind = Schema.Literals(["slice", "package"])
export type WorkflowUnitKind = typeof WorkflowUnitKind.Type

/** Unit status values persisted in `WfUnit.status`. */
export const WorkflowUnitStatus = Schema.Literals([
  "pending",
  "dispatched",
  "completed",
  "escalated",
])
export type WorkflowUnitStatus = typeof WorkflowUnitStatus.Type

/** Attempt verdicts persisted in `WfAttempt.verdict`. */
export const WorkflowAttemptVerdict = Schema.Literals(["dispatched", "completed", "rejected"])
export type WorkflowAttemptVerdict = typeof WorkflowAttemptVerdict.Type

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

/** Read-model summary of a `WfAttempt` node in `harness-workflows`. */
export const WorkflowAttemptRecord = Schema.Struct({
  attemptKey: WorkflowAttemptKey,
  runId: WorkflowRunId,
  unitId: WorkUnitId,
  attempt: AttemptNumber,
  verdict: WorkflowAttemptVerdict,
  runner: Schema.optional(RunnerId),
  rejection: Schema.optional(RejectionJsonPayload),
  packageStampHash: Schema.optional(PackageStampHash),
  updatedMs: WorkflowTimestampMs,
})
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

/** Complete status snapshot returned by `workflow status`, `workflow.status`, and `harness_workflow_plan`. */
export const WorkflowStatusSummary = Schema.Struct({
  run: Schema.optional(WorkflowRunRecord),
  units: Schema.Array(WorkflowUnitRecord),
  attempts: Schema.Array(WorkflowAttemptRecord),
  pendingDeferreds: Schema.Array(WorkflowPendingDeferred),
  review: Schema.optional(ReviewRoutingPlan),
  terminalReceipt: Schema.optional(TaskRunReceipt),
  terminalError: Schema.optional(WorkflowStoreFailureReason),
  storeStatus: WorkflowStoreAvailabilityState,
  projectionStatus: WorkflowProjectionStatus,
  writerLeaseEpoch: LeaseEpoch,
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

/** Daemon RPC request for `workflow.resume`. */
export const WorkflowResumeRequest = Schema.Struct({
  repoRoot: AbsoluteRepoRoot,
  runId: WorkflowRunId,
  unitId: Schema.optional(WorkUnitId),
  decision: Schema.optional(EscalationDecision),
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
  writerLeaseEpoch: LeaseEpoch,
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
