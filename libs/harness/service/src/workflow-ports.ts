import { Context, type Effect, type Option } from "effect"
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunnerError,
  AllocateShipAttemptInput,
  BackupDirPath,
  CompiledPlan,
  CompleteSharedStepInput,
  CompleteUnitInput,
  MergeSliceWaveInput,
  MergeSliceWaveOutcome,
  MutationRestoreError,
  ReviewRoutingPlan,
  ShipGateFailedError,
  ShipRecoverBackupInput,
  ShipStageCommandInput,
  ShipStagePassed,
  ShipStreamProgressEvent,
  ShipTreeHashInput,
  UnitAgentDispatchResult,
  UnitAgentRequest,
  UnitOutcome,
  UpdateShipAttemptStatusInput,
  WorkflowAttemptRecord,
  WorkflowBackupSummary,
  WorkflowProjectAllInput,
  WorkflowProjectAllOutcome,
  WorkflowProjectionOutcome,
  WorkflowProjectionStatus,
  WorkflowProjectorInput,
  WorkflowRestoreRequest,
  WorkflowRestoreSummary,
  WorkflowRouteReviewInput,
  WorkflowRunId,
  WorkflowRunRecord,
  WorkflowShipAttemptRecord,
  WorkflowStoreAvailabilityState,
  WorkflowStoreUnavailableError,
  WorkflowUnitRecord,
  WorkspaceFsError,
  WorkspaceTreeHash,
  WorktreeProvisionReceipt,
  WriterLeaseHeldError,
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

/** Executes an automatic work unit through an isolated CLI agent runner (`claude-code` | `antigravity`). */
export interface AgentRunnerPortShape {
  readonly run: (request: AgentRunRequest) => Effect.Effect<AgentRunResult, AgentRunnerError>
}

export class AgentRunnerPort extends Context.Service<AgentRunnerPort, AgentRunnerPortShape>()(
  "@harness/service/AgentRunnerPort",
) {}

/** Dispatches an automatic work unit against a pluggable agent runner boundary (`UnitAgentDispatcherLive` uses `AgentRunnerPort`). */
export interface UnitAgentDispatcherShape {
  readonly runnerKind: "live" | "placeholder"
  readonly dispatchUnit: (
    request: UnitAgentRequest,
  ) => Effect.Effect<UnitAgentDispatchResult, WorkspaceFsError>
}

export class UnitAgentDispatcher extends Context.Service<
  UnitAgentDispatcher,
  UnitAgentDispatcherShape
>()("@harness/service/UnitAgentDispatcher") {}

/**
 * Provisions and tears down L1 linked slice worktrees (and resolves L2 canonical mappings)
 * and executes wave merges for L1 slice runs.
 */
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

/**
 * Write-only projection port used by `HarnessTaskWorkflow` activities (`REQ-3.1`)
 * to maintain `harness-workflows` read-model entities; only live daemon holders with a valid lease may write.
 */
export interface WorkflowProjectionWriterShape {
  readonly upsertRun: (
    run: WorkflowRunRecord,
  ) => Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError>
  readonly upsertUnit: (
    unit: WorkflowUnitRecord,
  ) => Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError>
  readonly upsertAttempt: (
    attempt: WorkflowAttemptRecord,
  ) => Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError>
}

export class WorkflowProjectionWriter extends Context.Service<
  WorkflowProjectionWriter,
  WorkflowProjectionWriterShape
>()("@harness/service/WorkflowProjectionWriter") {}

/**
 * Read-only `harness-workflows` query port for `workflow status`, `harness_workflow_plan`,
 * and `workflow doctor` (`REQ-3.1`); never queried from `HarnessTaskWorkflow` orchestration or pure `.decide` functions.
 */
export interface WorkflowReadModelQueryShape {
  readonly getRun: (
    runId: WorkflowRunId,
  ) => Effect.Effect<
    Option.Option<WorkflowRunRecord>,
    WorkflowStoreUnavailableError | WriterLeaseHeldError
  >
  readonly listRuns: Effect.Effect<
    ReadonlyArray<WorkflowRunRecord>,
    WorkflowStoreUnavailableError | WriterLeaseHeldError
  >
  readonly listUnits: (
    runId: WorkflowRunId,
  ) => Effect.Effect<
    ReadonlyArray<WorkflowUnitRecord>,
    WorkflowStoreUnavailableError | WriterLeaseHeldError
  >
  readonly listAttempts: (
    runId: WorkflowRunId,
  ) => Effect.Effect<
    ReadonlyArray<WorkflowAttemptRecord>,
    WorkflowStoreUnavailableError | WriterLeaseHeldError
  >
  readonly probeAvailability: Effect.Effect<WorkflowStoreAvailabilityState, never>
}

export class WorkflowReadModelQuery extends Context.Service<
  WorkflowReadModelQuery,
  WorkflowReadModelQueryShape
>()("@harness/service/WorkflowReadModelQuery") {}

/** Executes deterministic tree-hash checks, mutation backup recovery, and `ShipStage` commands for `ShipWorkflow`. */
export interface ShipGateRunnerShape {
  readonly computeTreeHash: (
    input: ShipTreeHashInput,
  ) => Effect.Effect<WorkspaceTreeHash, ShipGateFailedError>
  readonly recoverMutationBackup: (
    input: ShipRecoverBackupInput,
  ) => Effect.Effect<void, MutationRestoreError>
  readonly executeStageCommand: (
    input: ShipStageCommandInput,
  ) => Effect.Effect<ShipStagePassed, ShipGateFailedError>
  readonly reportStageProgress: (event: ShipStreamProgressEvent) => Effect.Effect<void>
}

export class ShipGateRunner extends Context.Service<ShipGateRunner, ShipGateRunnerShape>()(
  "@harness/service/ShipGateRunner",
) {}

/** Allocates monotonic OCC `WfShipAttempt` rows and tracks `running | passed | failed` ship states. */
export interface ShipAttemptStoreShape {
  readonly allocateAttempt: (
    input: AllocateShipAttemptInput,
  ) => Effect.Effect<
    WorkflowShipAttemptRecord,
    WorkflowStoreUnavailableError | WriterLeaseHeldError
  >
  readonly updateStatus: (
    input: UpdateShipAttemptStatusInput,
  ) => Effect.Effect<
    WorkflowShipAttemptRecord,
    WorkflowStoreUnavailableError | WriterLeaseHeldError
  >
  readonly listAttemptsForRun: (
    runId: WorkflowRunId,
  ) => Effect.Effect<
    ReadonlyArray<WorkflowShipAttemptRecord>,
    WorkflowStoreUnavailableError | WriterLeaseHeldError
  >
}

export class ShipAttemptStore extends Context.Service<ShipAttemptStore, ShipAttemptStoreShape>()(
  "@harness/service/ShipAttemptStore",
) {}

/**
 * Projects durable workflow runs, units, and attempts into the analytical `harness` graph
 * (`impl/<task>`, `main`, or another explicit target branch) as a non-fatal readable
 * convenience (`SPEC-0038`, `RFC-0013 REQ-4.5`).
 */
export interface WorkflowProjectorShape {
  readonly project: (input: WorkflowProjectorInput) => Effect.Effect<WorkflowProjectionOutcome>
  readonly projectAll: (input: WorkflowProjectAllInput) => Effect.Effect<WorkflowProjectAllOutcome>
  readonly getProjectionStatus: (
    runId: WorkflowRunId,
  ) => Effect.Effect<Option.Option<WorkflowProjectionStatus>>
}

export class WorkflowProjector extends Context.Service<WorkflowProjector, WorkflowProjectorShape>()(
  "@harness/service/WorkflowProjector",
) {}
