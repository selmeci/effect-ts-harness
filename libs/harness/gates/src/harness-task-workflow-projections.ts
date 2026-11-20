import { Clock, Effect, Schema } from "effect"
import { Activity, type WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  AgentFailureReason,
  type AttemptNumber,
  CompiledPlan,
  type CompiledWorkUnit,
  type EscalationOrdinal,
  NxProjectName,
  type OwnedRelPath,
  PackageVerifyCommand,
  PlanJsonPayload,
  RejectionJsonPayload,
  type RunnerId,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  UnitMode,
  type UnitOutcome,
  UnitRejection,
  WaveIndex,
  type WorkUnitId,
  WorkflowAttemptKey,
  type WorkflowExecutionId,
  type WorkflowLevel,
  type WorkflowRunId,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  WorkflowUnitKey,
  type WorkflowUnitKind,
  type WorkflowUnitStatus,
  type WorktreeProvisionReceipt,
  type WorkspaceFsError,
  wavesOf,
} from "@harness/contract"
import { type UnitVerifier, WorkflowProjectionWriter } from "@harness/service"

const SHARED_STEP_SLICE_BRANCH: SliceBranchName = SliceBranchName.make("slice/shared-step")
const SHARED_STEP_PROJECT_NAME: NxProjectName = NxProjectName.make("shared-step")
const SHARED_STEP_VERIFY_COMMAND: PackageVerifyCommand =
  PackageVerifyCommand.make("nx affected -t verify")

const encodePlanJson = Schema.encodeSync(Schema.fromJsonString(CompiledPlan))
const encodeUnitRejectionJson = Schema.encodeSync(Schema.fromJsonString(UnitRejection))

const currentTimestampMs = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis
  return WorkflowTimestampMs.make(Math.max(0, Math.floor(millis)))
})

export const cycleSuffixFor = (escalationOrdinal: EscalationOrdinal): string =>
  escalationOrdinal === 1 ? "" : `/r${escalationOrdinal}`

const makeUnitKey = (runId: WorkflowRunId, unitId: WorkUnitId): WorkflowUnitKey =>
  WorkflowUnitKey.make(`${runId}/${unitId}`)

const makeAttemptKey = (
  runId: WorkflowRunId,
  unitId: WorkUnitId,
  attempt: AttemptNumber,
  escalationOrdinal: EscalationOrdinal,
): WorkflowAttemptKey =>
  WorkflowAttemptKey.make(`${runId}/${unitId}#${attempt}${cycleSuffixFor(escalationOrdinal)}`)

export const unitKindOf = (unit: CompiledWorkUnit): WorkflowUnitKind =>
  match(unit)
    .with({ _tag: "SliceUnit" }, () => "slice" as const)
    .with({ _tag: "PackageUnit" }, () => "package" as const)
    .exhaustive()

export const unitKindForLevel = (level: WorkflowLevel): WorkflowUnitKind =>
  match(level)
    .with("epic", () => "slice" as const)
    .with("slice", () => "package" as const)
    .exhaustive()

const runnerOfMode = (mode: UnitMode): RunnerId | undefined =>
  match(mode)
    .with({ _tag: "Automatic" }, (automatic) => automatic.runner)
    .with({ _tag: "Manual" }, () => undefined)
    .exhaustive()

export const makeSharedStepSyntheticUnit = (
  plan: CompiledPlan,
  waveIndex: WaveIndex,
  sharedStepPaths: ReadonlyArray<OwnedRelPath>,
): CompiledWorkUnit =>
  match(plan.level)
    .with("epic", (): CompiledWorkUnit => ({
      _tag: "SliceUnit",
      unitId: SHARED_STEP_UNIT_ID,
      branch: SHARED_STEP_SLICE_BRANCH,
      waveIndex,
      dependsOn: [],
      ownedRelPaths: sharedStepPaths,
      earsKeys: [],
    }))
    .with("slice", (): CompiledWorkUnit => ({
      _tag: "PackageUnit",
      unitId: SHARED_STEP_UNIT_ID,
      projectName: SHARED_STEP_PROJECT_NAME,
      waveIndex,
      dependsOn: [],
      ownedRelPaths: sharedStepPaths,
      stubKeys: [],
      earsKeys: [],
      packageVerifyCommand: SHARED_STEP_VERIFY_COMMAND,
    }))
    .exhaustive()

export const siblingOwnedPathsForUnit = (
  plan: CompiledPlan,
  unit: CompiledWorkUnit,
): ReadonlyArray<OwnedRelPath> =>
  match(plan.level)
    .with("epic", (): ReadonlyArray<OwnedRelPath> => [])
    .with("slice", () =>
      plan.units
        .filter((other) => other.waveIndex <= unit.waveIndex && other.unitId !== unit.unitId)
        .flatMap((other) => other.ownedRelPaths),
    )
    .exhaustive()

export const resolveUnitCwd = (
  worktrees: WorktreeProvisionReceipt,
  unitId: WorkUnitId,
): AbsoluteRepoRoot =>
  worktrees.entries.find((entry) => entry.unitId === unitId)?.cwd ?? worktrees.canonicalRepoRoot

export const findConflictUnitId = (
  units: readonly [CompiledWorkUnit, ...Array<CompiledWorkUnit>],
  branch: SliceBranchName,
): WorkUnitId => {
  for (const unit of units) {
    const matched = match(unit)
      .with({ _tag: "SliceUnit" }, (sliceUnit) =>
        sliceUnit.branch === branch ? sliceUnit.unitId : undefined,
      )
      .with({ _tag: "PackageUnit" }, () => undefined)
      .exhaustive()
    if (matched !== undefined) {
      return matched
    }
  }
  return units[0].unitId
}

export interface UnitCycleDescriptor {
  readonly unitId: WorkUnitId
  readonly kind: WorkflowUnitKind
  readonly waveIndex: WaveIndex
  readonly ownedRelPaths: ReadonlyArray<OwnedRelPath>
  readonly unitForDispatch: CompiledWorkUnit
  readonly verifyAttempt: (
    attempt: AttemptNumber,
    escalationOrdinal: EscalationOrdinal,
  ) => Effect.Effect<
    UnitOutcome,
    WorkspaceFsError,
    WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance | UnitVerifier
  >
}

export const projectRunStateActivity = (
  activityName: string,
  plan: CompiledPlan,
  executionId: WorkflowExecutionId,
  state: "running" | "waiting" | "completed" | "aborted",
  includePlanJson: boolean,
) =>
  Activity.make({
    name: activityName,
    error: WorkflowStoreUnavailableError,
    execute: Effect.gen(function* () {
      const readModel = yield* WorkflowProjectionWriter
      const updatedMs = yield* currentTimestampMs
      yield* readModel.upsertRun({
        runId: plan.runId,
        executionId,
        level: plan.level,
        planSha: plan.planSha,
        baseSha: plan.baseSha,
        state,
        ...(includePlanJson ? { planJson: PlanJsonPayload.make(encodePlanJson(plan)) } : {}),
        updatedMs,
      })
    }),
  })

export const projectInitialViewsActivity = (plan: CompiledPlan, executionId: WorkflowExecutionId) =>
  Activity.make({
    name: "ProjectRunStarted",
    error: WorkflowStoreUnavailableError,
    execute: Effect.gen(function* () {
      const readModel = yield* WorkflowProjectionWriter
      const updatedMs = yield* currentTimestampMs
      yield* readModel.upsertRun({
        runId: plan.runId,
        executionId,
        level: plan.level,
        planSha: plan.planSha,
        baseSha: plan.baseSha,
        state: "running",
        planJson: PlanJsonPayload.make(encodePlanJson(plan)),
        updatedMs,
      })
      for (const unit of plan.units) {
        yield* readModel.upsertUnit({
          unitKey: makeUnitKey(plan.runId, unit.unitId),
          runId: plan.runId,
          unitId: unit.unitId,
          kind: unitKindOf(unit),
          waveIndex: unit.waveIndex,
          status: "pending",
          ownedRelPaths: unit.ownedRelPaths,
          updatedMs,
        })
      }
      if (plan.sharedStepPaths.length > 0) {
        const sharedWaveIndex = WaveIndex.make(wavesOf(plan).length)
        yield* readModel.upsertUnit({
          unitKey: makeUnitKey(plan.runId, SHARED_STEP_UNIT_ID),
          runId: plan.runId,
          unitId: SHARED_STEP_UNIT_ID,
          kind: unitKindForLevel(plan.level),
          waveIndex: sharedWaveIndex,
          status: "pending",
          ownedRelPaths: plan.sharedStepPaths,
          updatedMs,
        })
      }
    }),
  })

export const projectUnitAttemptDispatched = (
  plan: CompiledPlan,
  descriptor: UnitCycleDescriptor,
  attempt: AttemptNumber,
  escalationOrdinal: EscalationOrdinal,
) =>
  Activity.make({
    name: `ProjectUnitDispatched/${descriptor.unitId}/${attempt}${cycleSuffixFor(escalationOrdinal)}`,
    error: WorkflowStoreUnavailableError,
    execute: Effect.gen(function* () {
      const readModel = yield* WorkflowProjectionWriter
      const updatedMs = yield* currentTimestampMs
      const runner = runnerOfMode(plan.mode)
      yield* readModel.upsertUnit({
        unitKey: makeUnitKey(plan.runId, descriptor.unitId),
        runId: plan.runId,
        unitId: descriptor.unitId,
        kind: descriptor.kind,
        waveIndex: descriptor.waveIndex,
        status: "dispatched",
        ownedRelPaths: descriptor.ownedRelPaths,
        updatedMs,
      })
      yield* readModel.upsertAttempt({
        attemptKey: makeAttemptKey(plan.runId, descriptor.unitId, attempt, escalationOrdinal),
        runId: plan.runId,
        unitId: descriptor.unitId,
        attempt,
        verdict: "dispatched",
        ...(runner !== undefined ? { runner } : {}),
        updatedMs,
      })
    }),
  })

export const projectUnitOutcome = (
  plan: CompiledPlan,
  descriptor: UnitCycleDescriptor,
  attempt: AttemptNumber,
  escalationOrdinal: EscalationOrdinal,
  outcome: UnitOutcome,
) => {
  const cycleSuffix = cycleSuffixFor(escalationOrdinal)
  const runner = runnerOfMode(plan.mode)
  return match(outcome)
    .with({ _tag: "Completed" }, (completed) =>
      Activity.make({
        name: `ProjectUnitCompleted/${descriptor.unitId}/${attempt}${cycleSuffix}`,
        error: WorkflowStoreUnavailableError,
        execute: Effect.gen(function* () {
          const readModel = yield* WorkflowProjectionWriter
          const updatedMs = yield* currentTimestampMs
          yield* readModel.upsertAttempt({
            attemptKey: makeAttemptKey(plan.runId, descriptor.unitId, attempt, escalationOrdinal),
            runId: plan.runId,
            unitId: descriptor.unitId,
            attempt,
            verdict: "completed",
            ...(runner !== undefined ? { runner } : {}),
            packageStampHash: completed.packageStampHash,
            updatedMs,
          })
          yield* readModel.upsertUnit({
            unitKey: makeUnitKey(plan.runId, descriptor.unitId),
            runId: plan.runId,
            unitId: descriptor.unitId,
            kind: descriptor.kind,
            waveIndex: descriptor.waveIndex,
            status: "completed",
            ownedRelPaths: descriptor.ownedRelPaths,
            updatedMs,
          })
        }),
      }),
    )
    .with({ _tag: "Rejected" }, (rejected) =>
      Activity.make({
        name: `ProjectUnitRejected/${descriptor.unitId}/${attempt}${cycleSuffix}`,
        error: WorkflowStoreUnavailableError,
        execute: Effect.gen(function* () {
          const readModel = yield* WorkflowProjectionWriter
          const updatedMs = yield* currentTimestampMs
          yield* readModel.upsertAttempt({
            attemptKey: makeAttemptKey(plan.runId, descriptor.unitId, attempt, escalationOrdinal),
            runId: plan.runId,
            unitId: descriptor.unitId,
            attempt,
            verdict: "rejected",
            ...(runner !== undefined ? { runner } : {}),
            rejection: RejectionJsonPayload.make(encodeUnitRejectionJson(rejected.rejection)),
            updatedMs,
          })
        }),
      }),
    )
    .with({ _tag: "Escalated" }, (escalated) =>
      Activity.make({
        name: `ProjectUnitAttemptEscalated/${descriptor.unitId}/${attempt}${cycleSuffix}`,
        error: WorkflowStoreUnavailableError,
        execute: Effect.gen(function* () {
          const readModel = yield* WorkflowProjectionWriter
          const updatedMs = yield* currentTimestampMs
          const reason = match(escalated.escalation)
            .with({ _tag: "AuthRequired" }, (e) =>
              AgentFailureReason.make(`Authentication required for runner '${e.runner}'`),
            )
            .with({ _tag: "RetryBudgetExhausted" }, () =>
              AgentFailureReason.make("Unit retry budget exhausted"),
            )
            .with({ _tag: "MergeConflict" }, (e) =>
              AgentFailureReason.make(`Merge conflict on branch '${e.branch}'`),
            )
            .exhaustive()
          yield* readModel.upsertAttempt({
            attemptKey: makeAttemptKey(plan.runId, descriptor.unitId, attempt, escalationOrdinal),
            runId: plan.runId,
            unitId: descriptor.unitId,
            attempt,
            verdict: "rejected",
            ...(runner !== undefined ? { runner } : {}),
            rejection: RejectionJsonPayload.make(
              encodeUnitRejectionJson({ _tag: "AgentFailed", reason }),
            ),
            updatedMs,
          })
        }),
      }),
    )
    .exhaustive()
}

export const projectUnitEscalated = (
  plan: CompiledPlan,
  executionId: WorkflowExecutionId,
  unitId: WorkUnitId,
  kind: WorkflowUnitKind,
  waveIndex: WaveIndex,
  ownedRelPaths: ReadonlyArray<OwnedRelPath>,
  status: WorkflowUnitStatus,
  runState: "waiting" | "running",
  activityName: string,
) =>
  Activity.make({
    name: activityName,
    error: WorkflowStoreUnavailableError,
    execute: Effect.gen(function* () {
      const readModel = yield* WorkflowProjectionWriter
      const updatedMs = yield* currentTimestampMs
      yield* readModel.upsertRun({
        runId: plan.runId,
        executionId,
        level: plan.level,
        planSha: plan.planSha,
        baseSha: plan.baseSha,
        state: runState,
        updatedMs,
      })
      yield* readModel.upsertUnit({
        unitKey: makeUnitKey(plan.runId, unitId),
        runId: plan.runId,
        unitId,
        kind,
        waveIndex,
        status,
        ownedRelPaths,
        updatedMs,
      })
    }),
  })
