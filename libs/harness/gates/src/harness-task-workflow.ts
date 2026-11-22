import { Effect, Schema, type Scope } from "effect"
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  AttemptNumber,
  CompiledPlan,
  type CompiledWorkUnit,
  EscalationOrdinal,
  EscalationResolution,
  LlmPhaseReceipt,
  MergeSliceWaveOutcome,
  type OwnedRelPath,
  PendingDeferredName,
  ReviewRoutingPlan,
  type RunnerId,
  SHARED_STEP_UNIT_ID,
  type SliceBranchName,
  TaskRunAbortedError,
  TaskRunReceipt,
  UnitAgentDispatchResult,
  type UnitEscalation,
  UnitOutcome,
  type UnitRejection,
  WaveIndex,
  type WorkUnitId,
  WorkflowActivityTag,
  WorkflowDeferredTag,
  WorkflowExecutionId,
  WorkflowRunAbortTarget,
  WorkflowStoreUnavailableError,
  WorktreeProvisionReceipt,
  WorkspaceFsError,
  WriterLeaseHeldError,
  encodeWorkflowActivityName,
  encodeWorkflowDeferredName,
  wavesOf,
} from "@harness/contract"
import {
  UnitAgentDispatcher,
  UnitVerifier,
  type WorkflowProjectionWriter,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import {
  type UnitCycleDescriptor,
  findConflictUnitId,
  makeSharedStepSyntheticUnit,
  projectInitialViewsActivity,
  projectRunStateActivity,
  projectUnitAttemptDispatched,
  projectUnitEscalated,
  projectUnitOutcome,
  resolveUnitCwd,
  siblingOwnedPathsForUnit,
  unitKindForLevel,
  unitKindOf,
} from "./harness-task-workflow-projections.js"

/** Input payload for `HarnessTaskWorkflow`, serialized inside the Effect Workflow journal. */
export const HarnessTaskWorkflowPayload = Schema.Struct({
  plan: CompiledPlan,
})
export type HarnessTaskWorkflowPayload = typeof HarnessTaskWorkflowPayload.Type

/** Typed failure union for `HarnessTaskWorkflow`. */
export const HarnessTaskWorkflowError = Schema.Union([
  TaskRunAbortedError,
  WorkspaceFsError,
  WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
])
export type HarnessTaskWorkflowError = typeof HarnessTaskWorkflowError.Type

/** Durable workflow definition keyed solely by `plan.runId` (never by plan content hash). */
export const HarnessTaskWorkflow = Workflow.make("HarnessTaskWorkflow", {
  payload: HarnessTaskWorkflowPayload,
  success: TaskRunReceipt,
  error: HarnessTaskWorkflowError,
  idempotencyKey: ({ plan }) => plan.runId,
})

/** Computes the deterministic `WorkflowExecutionId` for a `CompiledPlan` via `HarnessTaskWorkflow.executionId`. */
export const executionIdOf = (plan: CompiledPlan): Effect.Effect<WorkflowExecutionId> =>
  Effect.map(HarnessTaskWorkflow.executionId({ plan }), (id) => WorkflowExecutionId.make(id))

/** Durable deferred marking operator completion of the post-unit LLM verification phase. */
export const LlmPhaseDone = DurableDeferred.make(
  encodeWorkflowDeferredName(WorkflowDeferredTag.cases.LlmPhaseDone.make({})),
  {
    success: LlmPhaseReceipt,
  },
)

/** Computes the deterministic deferred name for a manual unit attempt within an escalation cycle. */
export const unitCompletionDeferredName = (
  unitId: WorkUnitId,
  attempt: AttemptNumber,
  escalationOrdinal: EscalationOrdinal,
): PendingDeferredName =>
  encodeWorkflowDeferredName(
    WorkflowDeferredTag.cases.UnitCompletion.make({
      unitId,
      attempt,
      escalationOrdinal,
    }),
  )

/** Constructs the typed `DurableDeferred` for a manual unit completion attempt. */
export const makeUnitCompletionDeferred = (
  unitId: WorkUnitId,
  attempt: AttemptNumber,
  escalationOrdinal: EscalationOrdinal,
): DurableDeferred.DurableDeferred<typeof UnitOutcome, Schema.Never> =>
  DurableDeferred.make(unitCompletionDeferredName(unitId, attempt, escalationOrdinal), {
    success: UnitOutcome,
  })

/** Computes the deterministic deferred name for a unit escalation resolution (`escalation/<unitId>/<n>`). */
export const unitEscalationDeferredName = (
  unitId: WorkUnitId,
  escalationOrdinal: EscalationOrdinal,
): PendingDeferredName =>
  encodeWorkflowDeferredName(
    WorkflowDeferredTag.cases.UnitEscalation.make({
      unitId,
      escalationOrdinal,
    }),
  )

/** Constructs the typed `DurableDeferred` for an operator escalation decision (`retry | abort`). */
export const makeUnitEscalationDeferred = (
  unitId: WorkUnitId,
  escalationOrdinal: EscalationOrdinal,
): DurableDeferred.DurableDeferred<typeof EscalationResolution, Schema.Never> =>
  DurableDeferred.make(unitEscalationDeferredName(unitId, escalationOrdinal), {
    success: EscalationResolution,
  })

const ATTEMPT_NUMBERS: readonly [AttemptNumber, AttemptNumber, AttemptNumber] = [
  AttemptNumber.make(1),
  AttemptNumber.make(2),
  AttemptNumber.make(3),
]

const dispatchAutomaticUnit = Effect.fnUntraced(function* (
  plan: CompiledPlan,
  descriptor: UnitCycleDescriptor,
  cwd: AbsoluteRepoRoot,
  attempt: AttemptNumber,
  runner: RunnerId,
  escalationOrdinal: EscalationOrdinal,
): Effect.fn.Return<
  UnitOutcome,
  WorkspaceFsError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | UnitVerifier
  | UnitAgentDispatcher
> {
  const dispatchResult = yield* Activity.make({
    name: encodeWorkflowActivityName(
      WorkflowActivityTag.cases.DispatchUnitAgent.make({
        unitId: descriptor.unitId,
        attempt,
        escalationOrdinal,
      }),
    ),
    success: UnitAgentDispatchResult,
    error: WorkspaceFsError,
    execute: Effect.gen(function* () {
      const dispatcher = yield* UnitAgentDispatcher
      return yield* dispatcher.dispatchUnit({
        runId: plan.runId,
        unit: descriptor.unitForDispatch,
        attempt,
        runner,
        cwd,
      })
    }),
  })
  return yield* match(dispatchResult)
    .with({ _tag: "Completed" }, () => descriptor.verifyAttempt(attempt, escalationOrdinal))
    .with({ _tag: "Failed" }, (failed): Effect.Effect<UnitOutcome> =>
      Effect.succeed({
        _tag: "Rejected",
        unitId: descriptor.unitId,
        attempt,
        rejection: { _tag: "AgentFailed", reason: failed.reason },
      }),
    )
    .with({ _tag: "AuthRequired" }, (auth): Effect.Effect<UnitOutcome> =>
      Effect.succeed({
        _tag: "Escalated",
        unitId: descriptor.unitId,
        escalation: { _tag: "AuthRequired", runner: auth.runner },
      }),
    )
    .exhaustive()
})

type UnitCycleOutcome =
  | { readonly _tag: "Completed"; readonly unitId: WorkUnitId }
  | { readonly _tag: "NeedsEscalation"; readonly escalation: UnitEscalation }

const runAttemptCycle = Effect.fnUntraced(function* (
  plan: CompiledPlan,
  descriptor: UnitCycleDescriptor,
  cwd: AbsoluteRepoRoot,
  escalationOrdinal: EscalationOrdinal,
): Effect.fn.Return<
  UnitCycleOutcome,
  HarnessTaskWorkflowError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | UnitVerifier
  | UnitAgentDispatcher
  | WorkflowProjectionWriter
> {
  let lastRejection: UnitRejection | undefined = undefined

  for (const attempt of ATTEMPT_NUMBERS) {
    yield* projectUnitAttemptDispatched(plan, descriptor, attempt, escalationOrdinal)

    const outcome: UnitOutcome = yield* match(plan.mode)
      .with({ _tag: "Manual" }, () =>
        DurableDeferred.await(
          makeUnitCompletionDeferred(descriptor.unitId, attempt, escalationOrdinal),
        ),
      )
      .with({ _tag: "Automatic" }, (automatic) =>
        dispatchAutomaticUnit(plan, descriptor, cwd, attempt, automatic.runner, escalationOrdinal),
      )
      .exhaustive()

    yield* projectUnitOutcome(plan, descriptor, attempt, escalationOrdinal, outcome)

    const stepResult: UnitCycleOutcome | undefined = match(outcome)
      .with({ _tag: "Completed" }, (completed): UnitCycleOutcome => ({
        _tag: "Completed",
        unitId: completed.unitId,
      }))
      .with({ _tag: "Rejected" }, (rejected): UnitCycleOutcome | undefined => {
        lastRejection = rejected.rejection
        return attempt >= 3
          ? {
              _tag: "NeedsEscalation",
              escalation: {
                _tag: "RetryBudgetExhausted",
                lastRejection: rejected.rejection,
              },
            }
          : undefined
      })
      .with({ _tag: "Escalated" }, (escalated): UnitCycleOutcome => ({
        _tag: "NeedsEscalation",
        escalation: escalated.escalation,
      }))
      .exhaustive()

    if (stepResult !== undefined) {
      return stepResult
    }
  }

  if (lastRejection !== undefined) {
    return {
      _tag: "NeedsEscalation",
      escalation: {
        _tag: "RetryBudgetExhausted",
        lastRejection,
      },
    }
  }

  return yield* Effect.die(
    new Error(
      `Invariant violation: attempt loop for unit '${descriptor.unitId}' exited without outcome or rejection`,
    ),
  )
})

const driveUnitLoop = Effect.fnUntraced(function* (
  plan: CompiledPlan,
  descriptor: UnitCycleDescriptor,
  cwd: AbsoluteRepoRoot,
): Effect.fn.Return<
  { readonly unitId: WorkUnitId; readonly nextEscalationOrdinal: EscalationOrdinal },
  HarnessTaskWorkflowError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | UnitVerifier
  | UnitAgentDispatcher
  | WorkflowProjectionWriter
> {
  const instance = yield* WorkflowEngine.WorkflowInstance
  const executionId = WorkflowExecutionId.make(instance.executionId)
  let escalationOrdinal = EscalationOrdinal.make(1)

  while (true) {
    const resolvedCycle = yield* runAttemptCycle(plan, descriptor, cwd, escalationOrdinal)

    const completedUnitId = yield* match(resolvedCycle)
      .with({ _tag: "Completed" }, (done) => Effect.succeed(done.unitId))
      .with({ _tag: "NeedsEscalation" }, (esc) =>
        Effect.gen(function* () {
          yield* projectUnitEscalated(
            plan,
            executionId,
            descriptor.unitId,
            descriptor.kind,
            descriptor.waveIndex,
            descriptor.ownedRelPaths,
            "escalated",
            "waiting",
            WorkflowActivityTag.cases.ProjectUnitEscalated.make({
              unitId: descriptor.unitId,
              escalationOrdinal,
            }),
          )

          const resolution = yield* DurableDeferred.await(
            makeUnitEscalationDeferred(descriptor.unitId, escalationOrdinal),
          )

          return yield* match(resolution.decision)
            .with("retry", () =>
              Effect.gen(function* () {
                yield* projectUnitEscalated(
                  plan,
                  executionId,
                  descriptor.unitId,
                  descriptor.kind,
                  descriptor.waveIndex,
                  descriptor.ownedRelPaths,
                  "dispatched",
                  "running",
                  WorkflowActivityTag.cases.ProjectUnitEscalationRetried.make({
                    unitId: descriptor.unitId,
                    escalationOrdinal,
                  }),
                )
                return undefined
              }),
            )
            .with("abort", () =>
              Effect.gen(function* () {
                yield* projectRunStateActivity(
                  WorkflowActivityTag.cases.ProjectRunAborted.make({
                    target: WorkflowRunAbortTarget.cases.Unit.make({
                      unitId: descriptor.unitId,
                      escalationOrdinal,
                    }),
                  }),
                  plan,
                  executionId,
                  "aborted",
                  false,
                )
                return yield* new TaskRunAbortedError({
                  runId: plan.runId,
                  escalation: esc.escalation,
                })
              }),
            )
            .exhaustive()
        }),
      )
      .exhaustive()

    if (completedUnitId !== undefined) {
      return { unitId: completedUnitId, nextEscalationOrdinal: escalationOrdinal }
    }

    escalationOrdinal = EscalationOrdinal.make(escalationOrdinal + 1)
  }
})

const makeUnitCycleDescriptor = (
  plan: CompiledPlan,
  unit: CompiledWorkUnit,
  cwd: AbsoluteRepoRoot,
): UnitCycleDescriptor => {
  const siblingPaths = siblingOwnedPathsForUnit(plan, unit)
  return {
    unitId: unit.unitId,
    kind: unitKindOf(unit),
    waveIndex: unit.waveIndex,
    ownedRelPaths: unit.ownedRelPaths,
    unitForDispatch: unit,
    verifyAttempt: (attempt, escalationOrdinal) =>
      Activity.make({
        name: encodeWorkflowActivityName(
          WorkflowActivityTag.cases.VerifyUnit.make({
            unitId: unit.unitId,
            attempt,
            escalationOrdinal,
          }),
        ),
        success: UnitOutcome,
        error: WorkspaceFsError,
        execute: Effect.gen(function* () {
          const verifier = yield* UnitVerifier
          return yield* verifier.completeUnit({
            runId: plan.runId,
            level: plan.level,
            baseSha: plan.baseSha,
            unit,
            attempt,
            cwd,
            siblingInFlightOwnedPaths: siblingPaths,
          })
        }),
      }),
  }
}

/** Executes one compiled work unit with bounded 3-attempt verification and escalation recovery. */
export const driveWorkUnit = Effect.fn("Harness.driveWorkUnit")(function* (
  plan: CompiledPlan,
  unit: CompiledWorkUnit,
  cwd: AbsoluteRepoRoot,
): Effect.fn.Return<
  WorkUnitId,
  HarnessTaskWorkflowError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | UnitVerifier
  | UnitAgentDispatcher
  | WorkflowProjectionWriter
> {
  const result = yield* driveUnitLoop(plan, makeUnitCycleDescriptor(plan, unit, cwd), cwd)
  return result.unitId
})

/** Executes the sequential shared step (`REQ-1.4`) when `plan.sharedStepPaths.length > 0`. */
export const driveSharedStep = Effect.fn("Harness.driveSharedStep")(function* (
  plan: CompiledPlan,
  cwd: AbsoluteRepoRoot,
): Effect.fn.Return<
  void,
  HarnessTaskWorkflowError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | UnitVerifier
  | UnitAgentDispatcher
  | WorkflowProjectionWriter
> {
  const [firstPath, ...restPaths] = plan.sharedStepPaths
  if (firstPath === undefined) {
    return
  }
  const sharedStepPaths: readonly [OwnedRelPath, ...Array<OwnedRelPath>] = [firstPath, ...restPaths]
  const sharedWaveIndex = WaveIndex.make(wavesOf(plan).length)
  const syntheticUnit = makeSharedStepSyntheticUnit(plan, sharedWaveIndex, sharedStepPaths)
  const priorUnitOwnedPaths = plan.units.flatMap((u) => u.ownedRelPaths)
  const descriptor: UnitCycleDescriptor = {
    unitId: SHARED_STEP_UNIT_ID,
    kind: unitKindForLevel(plan.level),
    waveIndex: sharedWaveIndex,
    ownedRelPaths: sharedStepPaths,
    unitForDispatch: syntheticUnit,
    verifyAttempt: (attempt, escalationOrdinal) =>
      Activity.make({
        name: encodeWorkflowActivityName(
          WorkflowActivityTag.cases.VerifySharedStep.make({
            attempt,
            escalationOrdinal,
          }),
        ),
        success: UnitOutcome,
        error: WorkspaceFsError,
        execute: Effect.gen(function* () {
          const verifier = yield* UnitVerifier
          return yield* verifier.completeSharedStep({
            runId: plan.runId,
            baseSha: plan.baseSha,
            sharedStepPaths,
            priorUnitOwnedPaths,
            attempt,
            cwd,
          })
        }),
      }),
  }

  yield* driveUnitLoop(plan, descriptor, cwd)
})

const mergeEpicWaveWithEscalation = Effect.fnUntraced(function* (
  plan: CompiledPlan,
  executionId: WorkflowExecutionId,
  waveUnits: readonly [CompiledWorkUnit, ...Array<CompiledWorkUnit>],
  waveIndex: WaveIndex,
  canonicalRepoRoot: AbsoluteRepoRoot,
  nextEscalationByUnit: ReadonlyMap<WorkUnitId, EscalationOrdinal>,
): Effect.fn.Return<
  void,
  HarnessTaskWorkflowError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | WorkflowWorktreePort
  | WorkflowProjectionWriter
> {
  const branches: Array<SliceBranchName> = []
  for (const unit of waveUnits) {
    match(unit)
      .with({ _tag: "SliceUnit" }, (sliceUnit) => {
        branches.push(sliceUnit.branch)
      })
      .with({ _tag: "PackageUnit" }, () => {})
      .exhaustive()
  }
  if (branches.length === 0) {
    return
  }

  let mergeCycleOrdinal = EscalationOrdinal.make(1)
  const usedPerUnit = new Map<WorkUnitId, number>()
  while (true) {
    const mergeOutcome = yield* Activity.make({
      name: encodeWorkflowActivityName(
        WorkflowActivityTag.cases.MergeSliceWave.make({
          waveIndex,
          escalationOrdinal: mergeCycleOrdinal,
        }),
      ),
      success: MergeSliceWaveOutcome,
      error: WorkspaceFsError,
      execute: Effect.gen(function* () {
        const worktreePort = yield* WorkflowWorktreePort
        return yield* worktreePort.mergeSliceWave({
          runId: plan.runId,
          waveIndex,
          baseSha: plan.baseSha,
          canonicalRepoRoot,
          branches,
        })
      }),
    })

    const resolved = yield* match(mergeOutcome)
      .with({ _tag: "Merged" }, () => Effect.succeed(true))
      .with({ _tag: "Conflict" }, (conflict) =>
        Effect.gen(function* () {
          const conflictUnitId = findConflictUnitId(waveUnits, conflict.branch)
          const conflictUnit = waveUnits.find((u) => u.unitId === conflictUnitId) ?? waveUnits[0]
          const baseOrd = nextEscalationByUnit.get(conflictUnitId) ?? 1
          const offset = usedPerUnit.get(conflictUnitId) ?? 0
          const deferredOrdinal = EscalationOrdinal.make(baseOrd + offset)
          usedPerUnit.set(conflictUnitId, offset + 1)
          const escalation: UnitEscalation = {
            _tag: "MergeConflict",
            branch: conflict.branch,
          }

          yield* projectUnitEscalated(
            plan,
            executionId,
            conflictUnitId,
            unitKindOf(conflictUnit),
            waveIndex,
            conflictUnit.ownedRelPaths,
            "escalated",
            "waiting",
            WorkflowActivityTag.cases.ProjectWaveMergeEscalated.make({
              waveIndex,
              escalationOrdinal: mergeCycleOrdinal,
            }),
          )

          const resolution = yield* DurableDeferred.await(
            makeUnitEscalationDeferred(conflictUnitId, deferredOrdinal),
          )

          return yield* match(resolution.decision)
            .with("retry", () =>
              Effect.gen(function* () {
                yield* projectUnitEscalated(
                  plan,
                  executionId,
                  conflictUnitId,
                  unitKindOf(conflictUnit),
                  waveIndex,
                  conflictUnit.ownedRelPaths,
                  "completed",
                  "running",
                  WorkflowActivityTag.cases.ProjectWaveMergeRetried.make({
                    waveIndex,
                    escalationOrdinal: mergeCycleOrdinal,
                  }),
                )
                return false
              }),
            )
            .with("abort", () =>
              Effect.gen(function* () {
                yield* projectRunStateActivity(
                  WorkflowActivityTag.cases.ProjectRunAborted.make({
                    target: WorkflowRunAbortTarget.cases.Merge.make({
                      waveIndex,
                      escalationOrdinal: mergeCycleOrdinal,
                    }),
                  }),
                  plan,
                  executionId,
                  "aborted",
                  false,
                )
                return yield* new TaskRunAbortedError({
                  runId: plan.runId,
                  escalation,
                })
              }),
            )
            .exhaustive()
        }),
      )
      .exhaustive()

    if (resolved) {
      return
    }
    mergeCycleOrdinal = EscalationOrdinal.make(mergeCycleOrdinal + 1)
  }
})

/** Top-level `HarnessTaskWorkflow` orchestration entrypoint with worktree compensation. */
export const executeTaskWorkflow = Effect.fn("Harness.executeTaskWorkflow")(function* (
  plan: CompiledPlan,
): Effect.fn.Return<
  TaskRunReceipt,
  HarnessTaskWorkflowError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | Workflow.Execution<"HarnessTaskWorkflow">
  | Scope.Scope
  | UnitVerifier
  | UnitAgentDispatcher
  | WorkflowWorktreePort
  | WorkflowReviewRouter
  | WorkflowProjectionWriter
> {
  const instance = yield* WorkflowEngine.WorkflowInstance
  const executionId = WorkflowExecutionId.make(instance.executionId)

  const worktrees = yield* HarnessTaskWorkflow.withCompensation(
    Activity.make({
      name: encodeWorkflowActivityName(WorkflowActivityTag.cases.ProvisionWorktrees.make({})),
      success: WorktreeProvisionReceipt,
      error: WorkspaceFsError,
      execute: Effect.gen(function* () {
        const worktreePort = yield* WorkflowWorktreePort
        return yield* worktreePort.provisionWorktrees(plan)
      }),
    }),
    (receipt) =>
      Effect.gen(function* () {
        const worktreePort = yield* WorkflowWorktreePort
        yield* worktreePort.removeWorktreeCheckouts(receipt)
      }),
  )

  yield* projectInitialViewsActivity(plan, executionId)

  const waveConcurrency = match(plan.mode)
    .with({ _tag: "Manual" }, () => "unbounded" as const)
    .with({ _tag: "Automatic" }, (automatic) => automatic.maxConcurrency)
    .exhaustive()

  const completedUnits: Array<WorkUnitId> = []
  for (const wave of wavesOf(plan)) {
    const waveResults = yield* Effect.forEach(
      wave.units,
      (unit) =>
        Effect.gen(function* () {
          const unitCwd = yield* resolveUnitCwd(worktrees, unit.unitId)
          return yield* driveUnitLoop(plan, makeUnitCycleDescriptor(plan, unit, unitCwd), unitCwd)
        }),
      { concurrency: waveConcurrency },
    )
    const nextEscalationByUnit = new Map<WorkUnitId, EscalationOrdinal>()
    for (const res of waveResults) {
      completedUnits.push(res.unitId)
      nextEscalationByUnit.set(res.unitId, res.nextEscalationOrdinal)
    }

    yield* match(plan.level)
      .with("epic", () =>
        mergeEpicWaveWithEscalation(
          plan,
          executionId,
          wave.units,
          wave.waveIndex,
          worktrees.canonicalRepoRoot,
          nextEscalationByUnit,
        ),
      )
      .with("slice", () => Effect.void)
      .exhaustive()
  }

  if (plan.sharedStepPaths.length > 0) {
    yield* driveSharedStep(plan, worktrees.canonicalRepoRoot)
  }

  yield* projectRunStateActivity(
    WorkflowActivityTag.cases.ProjectRunWaitingLlmPhase.make({}),
    plan,
    executionId,
    "waiting",
    false,
  )
  const llmPhase = yield* DurableDeferred.await(LlmPhaseDone)

  const review = yield* Activity.make({
    name: encodeWorkflowActivityName(WorkflowActivityTag.cases.RouteReview.make({})),
    success: ReviewRoutingPlan,
    error: WorkspaceFsError,
    execute: Effect.gen(function* () {
      const reviewRouter = yield* WorkflowReviewRouter
      return yield* reviewRouter.routeReview({
        runId: plan.runId,
        baseSha: plan.baseSha,
        canonicalRepoRoot: worktrees.canonicalRepoRoot,
      })
    }),
  })

  yield* projectRunStateActivity(
    WorkflowActivityTag.cases.ProjectRunCompleted.make({}),
    plan,
    executionId,
    "completed",
    false,
  )

  return {
    runId: plan.runId,
    planSha: plan.planSha,
    review,
    completedUnits,
    llmPhase,
  }
})

/** Workflow registration layer binding `HarnessTaskWorkflow` to `executeTaskWorkflow`. */
export const HarnessTaskWorkflowLayer = HarnessTaskWorkflow.toLayer(({ plan }) =>
  executeTaskWorkflow(plan),
)
