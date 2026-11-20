import { Context, type Effect, type Option } from "effect"
import type {
  BackupDirPath,
  CompiledPlan,
  CompleteSharedStepInput,
  CompleteUnitInput,
  MergeSliceWaveInput,
  MergeSliceWaveOutcome,
  ReviewRoutingPlan,
  UnitAgentDispatchResult,
  UnitAgentRequest,
  UnitOutcome,
  WorkflowAttemptRecord,
  WorkflowBackupSummary,
  WorkflowRestoreRequest,
  WorkflowRestoreSummary,
  WorkflowRouteReviewInput,
  WorkflowRunId,
  WorkflowRunRecord,
  WorkflowStoreAvailabilityState,
  WorkflowStoreUnavailableError,
  WorkflowUnitRecord,
  WorktreeProvisionReceipt,
  WorkspaceFsError,
} from "@harness/contract"

export interface WorkflowGraphBackupShape {
  readonly exportBackup: (
    backupDir: BackupDirPath,
  ) => Effect.Effect<WorkflowBackupSummary, WorkflowStoreUnavailableError | WorkspaceFsError>
  readonly restoreBackup: (
    request: WorkflowRestoreRequest,
  ) => Effect.Effect<WorkflowRestoreSummary, WorkflowStoreUnavailableError | WorkspaceFsError>
}

export class WorkflowGraphBackup extends Context.Service<
  WorkflowGraphBackup,
  WorkflowGraphBackupShape
>()("@harness/service/WorkflowGraphBackup") {}

/** Verifies unit write-set ownership and verification stamps/commands for manual & automatic modes. */
export interface UnitVerifierShape {
  readonly completeUnit: (input: CompleteUnitInput) => Effect.Effect<UnitOutcome, WorkspaceFsError>
  readonly completeSharedStep: (
    input: CompleteSharedStepInput,
  ) => Effect.Effect<UnitOutcome, WorkspaceFsError>
}

export class UnitVerifier extends Context.Service<UnitVerifier, UnitVerifierShape>()(
  "@harness/service/UnitVerifier",
) {}

/** Dispatches an automatic work unit against a pluggable agent runner boundary (live runners land in WF-5). */
export interface UnitAgentDispatcherShape {
  readonly dispatchUnit: (
    request: UnitAgentRequest,
  ) => Effect.Effect<UnitAgentDispatchResult, WorkspaceFsError>
}

export class UnitAgentDispatcher extends Context.Service<
  UnitAgentDispatcher,
  UnitAgentDispatcherShape
>()("@harness/service/UnitAgentDispatcher") {}

/** Provisions and tears down isolated slice worktrees and executes wave merges for L1 runs. */
export interface WorkflowWorktreePortShape {
  readonly provisionWorktrees: (
    plan: CompiledPlan,
  ) => Effect.Effect<WorktreeProvisionReceipt, WorkspaceFsError>
  readonly removeWorktreeCheckouts: (
    receipt: WorktreeProvisionReceipt,
  ) => Effect.Effect<void, never>
  readonly mergeSliceWave: (
    input: MergeSliceWaveInput,
  ) => Effect.Effect<MergeSliceWaveOutcome, WorkspaceFsError>
}

export class WorkflowWorktreePort extends Context.Service<
  WorkflowWorktreePort,
  WorkflowWorktreePortShape
>()("@harness/service/WorkflowWorktreePort") {}

/** Routes final review diffs over touched paths at the end of a workflow run. */
export interface WorkflowReviewRouterShape {
  readonly routeReview: (
    input: WorkflowRouteReviewInput,
  ) => Effect.Effect<ReviewRoutingPlan, WorkspaceFsError>
}

export class WorkflowReviewRouter extends Context.Service<
  WorkflowReviewRouter,
  WorkflowReviewRouterShape
>()("@harness/service/WorkflowReviewRouter") {}

/** Write-only Omnigraph read-model projection port used by `HarnessTaskWorkflow` activities (`REQ-3.1`). */
export interface WorkflowProjectionWriterShape {
  readonly upsertRun: (run: WorkflowRunRecord) => Effect.Effect<void, WorkflowStoreUnavailableError>
  readonly upsertUnit: (
    unit: WorkflowUnitRecord,
  ) => Effect.Effect<void, WorkflowStoreUnavailableError>
  readonly upsertAttempt: (
    attempt: WorkflowAttemptRecord,
  ) => Effect.Effect<void, WorkflowStoreUnavailableError>
}

export class WorkflowProjectionWriter extends Context.Service<
  WorkflowProjectionWriter,
  WorkflowProjectionWriterShape
>()("@harness/service/WorkflowProjectionWriter") {}

/** Read-only Omnigraph query port for `workflow status`, `harness_workflow_plan`, and `workflow doctor` (`REQ-3.1`). */
export interface WorkflowReadModelQueryShape {
  readonly getRun: (
    runId: WorkflowRunId,
  ) => Effect.Effect<Option.Option<WorkflowRunRecord>, WorkflowStoreUnavailableError>
  readonly listRuns: Effect.Effect<ReadonlyArray<WorkflowRunRecord>, WorkflowStoreUnavailableError>
  readonly listUnits: (
    runId: WorkflowRunId,
  ) => Effect.Effect<ReadonlyArray<WorkflowUnitRecord>, WorkflowStoreUnavailableError>
  readonly listAttempts: (
    runId: WorkflowRunId,
  ) => Effect.Effect<ReadonlyArray<WorkflowAttemptRecord>, WorkflowStoreUnavailableError>
  readonly probeAvailability: Effect.Effect<WorkflowStoreAvailabilityState, never>
}

export class WorkflowReadModelQuery extends Context.Service<
  WorkflowReadModelQuery,
  WorkflowReadModelQueryShape
>()("@harness/service/WorkflowReadModelQuery") {}
