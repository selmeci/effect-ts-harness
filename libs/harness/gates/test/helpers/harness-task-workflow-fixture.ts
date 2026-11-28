import { Deferred, Effect, Layer } from "effect"
import { WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AgentFailureReason,
  AttemptNumber,
  type CompiledPlan,
  type CompiledWorkUnit,
  EarsRequirementKey,
  FrictionLogState,
  GitCommitSha,
  LlmPhaseReceipt,
  type MergeSliceWaveInput,
  MergeSliceWaveOutcome,
  NonNegativeCount,
  NxProjectName,
  OmnigraphBranchName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanSha256,
  ReviewDepth,
  ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewRoutingSource,
  RunnerId,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  StubSymbolKey,
  type UnitAgentRequest,
  type UnitOutcome,
  WaveIndex,
  WorkUnitId,
  type WorkflowAttemptRecord,
  WorkflowProjectAllOutcome,
  WorkflowProjectionOutcome,
  type WorkflowProjectorInput,
  type WorkflowRunId,
  type WorkflowRunRecord,
  WorkflowStoreUnavailableError,
  type WorkflowUnitRecord,
  type WorktreeProvisionReceipt,
  WorkspaceFsError,
  WorkspaceTreeHash,
  WriterLeaseHeldError,
} from "@harness/contract"
import { type IndexedEffectFn } from "@harness/ingest"
import {
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowProjectionWriter,
  WorkflowProjector,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import { HarnessTaskWorkflowLayer } from "../../src/index.js"

export const emptyFnIndex: ReadonlyMap<string, IndexedEffectFn> = new Map()

export const CANONICAL_ROOT = AbsoluteRepoRoot.make("/tmp/harness-wf3-test-repo")
export const BASE_SHA = GitCommitSha.make("1".repeat(40))
export const PLAN_SHA = PlanSha256.make("2".repeat(64))
export const TREE_HASH = WorkspaceTreeHash.make("3".repeat(64))
export const STAMP_HASH = PackageStampHash.make("4".repeat(64))

export const makeSliceUnit = (
  id: string,
  branch: string,
  ownedRelPaths: ReadonlyArray<string>,
  waveIndex: number,
  dependsOn: ReadonlyArray<string> = [],
): CompiledWorkUnit => ({
  _tag: "SliceUnit",
  unitId: WorkUnitId.make(id),
  branch: SliceBranchName.make(branch),
  waveIndex: WaveIndex.make(waveIndex),
  dependsOn: dependsOn.map((d) => WorkUnitId.make(d)),
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  earsKeys: [EarsRequirementKey.make("REQ-1.1")],
})

export const makePackageUnit = (
  id: string,
  projectName: string,
  ownedRelPaths: ReadonlyArray<string>,
  waveIndex: number,
  dependsOn: ReadonlyArray<string> = [],
): CompiledWorkUnit => ({
  _tag: "PackageUnit",
  unitId: WorkUnitId.make(id),
  projectName: NxProjectName.make(projectName),
  waveIndex: WaveIndex.make(waveIndex),
  dependsOn: dependsOn.map((d) => WorkUnitId.make(d)),
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  stubKeys: [StubSymbolKey.make("Harness.driveWorkUnit")],
  earsKeys: [EarsRequirementKey.make("REQ-1.2")],
  packageVerifyCommand: PackageVerifyCommand.make(`pnpm nx run ${projectName}:verify`),
})

export const makeReviewPlan = (): ReviewRoutingPlan => ({
  _tag: "SkipReviewPlan",
  depth: ReviewDepth.make("skip"),
  source: ReviewRoutingSource.make("deterministic"),
  reason: ReviewRoutingReason.make("Workflow unit test"),
  selections: [],
})

export const makeLlmReceipt = (): LlmPhaseReceipt => ({
  workspaceHash: TREE_HASH,
  frictionLogCleared: "cleared" satisfies FrictionLogState,
})

export const makeCompletedOutcome = (
  unitId: WorkUnitId,
  attempt: AttemptNumber,
  paths: ReadonlyArray<string> = ["libs/a/src/index.ts"],
): UnitOutcome => ({
  _tag: "Completed",
  unitId,
  attempt,
  changedPaths: paths.map((p) => OwnedRelPath.make(p)),
  packageStampHash: STAMP_HASH,
})

export interface SpyState {
  provisionCalls: number
  removeCalls: Array<WorktreeProvisionReceipt>
  mergeCalls: Array<MergeSliceWaveInput>
  dispatchCalls: Array<UnitAgentRequest>
  completeUnitCalls: Array<{
    readonly unitId: WorkUnitId
    readonly attempt: AttemptNumber
    readonly cwd: AbsoluteRepoRoot
    readonly siblingInFlightOwnedPaths: ReadonlyArray<OwnedRelPath>
  }>
  completeSharedCalls: Array<{
    readonly attempt: AttemptNumber
    readonly sharedStepPaths: ReadonlyArray<OwnedRelPath>
    readonly priorUnitOwnedPaths: ReadonlyArray<OwnedRelPath>
    readonly cwd: AbsoluteRepoRoot
  }>
  routeReviewCalls: number
  upsertRunCalls: number
  upsertUnitCalls: number
  upsertAttemptCalls: number
  waveProjectCalls: Array<WorkflowProjectorInput>
  runs: Map<WorkflowRunId, WorkflowRunRecord>
  units: Map<string, WorkflowUnitRecord>
  attempts: Map<string, WorkflowAttemptRecord>
  activeLinkedWorktrees: Set<string>
  preservedSliceBranches: Set<string>
  onWaitLlm?: Deferred.Deferred<void> | undefined
  onUnitDispatched?: Map<string, Deferred.Deferred<void>> | undefined
  onUnitEscalated?: Map<string, Deferred.Deferred<void>> | undefined
  onMergeConflictEscalated?: Deferred.Deferred<void> | undefined
}

export const makeSpyState = (): SpyState => ({
  provisionCalls: 0,
  removeCalls: [],
  mergeCalls: [],
  dispatchCalls: [],
  completeUnitCalls: [],
  completeSharedCalls: [],
  routeReviewCalls: 0,
  upsertRunCalls: 0,
  upsertUnitCalls: 0,
  upsertAttemptCalls: 0,
  waveProjectCalls: [],
  runs: new Map(),
  units: new Map(),
  attempts: new Map(),
  activeLinkedWorktrees: new Set(),
  preservedSliceBranches: new Set(),
})

export interface FakeHandlers {
  readonly provisionWorktrees?: (
    plan: CompiledPlan,
  ) => Effect.Effect<WorktreeProvisionReceipt, WorkspaceFsError>
  readonly upsertRun?: (
    run: WorkflowRunRecord,
    callIndex: number,
  ) => Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError>
  readonly upsertUnit?: (
    unit: WorkflowUnitRecord,
    callIndex: number,
  ) => Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError>
  readonly upsertAttempt?: (
    attempt: WorkflowAttemptRecord,
    callIndex: number,
  ) => Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError>
  readonly mergeWave?: (input: MergeSliceWaveInput) => MergeSliceWaveOutcome
  readonly dispatchUnit?: (
    request: UnitAgentRequest,
  ) =>
    | { readonly _tag: "Completed" }
    | { readonly _tag: "Failed"; readonly reason: AgentFailureReason }
    | { readonly _tag: "AuthRequired"; readonly runner: RunnerId }
  readonly completeUnit?: (input: {
    readonly unitId: WorkUnitId
    readonly attempt: AttemptNumber
  }) => UnitOutcome
  readonly completeSharedStep?: (attempt: AttemptNumber) => UnitOutcome
  readonly projectWorkflowRun?: (
    input: WorkflowProjectorInput,
    callIndex: number,
  ) => Effect.Effect<WorkflowProjectionOutcome>
}

const defaultProjectedOutcome = (runId: WorkflowRunId): WorkflowProjectionOutcome =>
  WorkflowProjectionOutcome.cases.Projected.make({
    runId,
    branch: OmnigraphBranchName.make("impl/test-task"),
    projectionStatus: "fresh",
    commitId: null,
    counts: {
      runsUpserted: NonNegativeCount.make(1),
      unitsUpserted: NonNegativeCount.make(1),
      attemptsUpserted: NonNegativeCount.make(1),
      edgesUpserted: NonNegativeCount.make(0),
    },
  })

export const makeWorkflowProjectorTestLayer = (
  onProject: (input: WorkflowProjectorInput) => Effect.Effect<WorkflowProjectionOutcome>,
) =>
  Layer.succeed(WorkflowProjector, {
    project: onProject,
    projectAll: () =>
      Effect.succeed(
        WorkflowProjectAllOutcome.cases.Projected.make({
          branch: OmnigraphBranchName.make("impl/test-task"),
          projectionStatus: "fresh",
          outcomes: [],
        }),
      ),
    getProjectionStatus: () => Effect.succeedNone,
  })

export const defaultWorkflowProjectorLayer = makeWorkflowProjectorTestLayer((input) =>
  Effect.succeed(defaultProjectedOutcome(input.runId)),
)

export const makeWorkflowTestLayer = (spy: SpyState, handlers: FakeHandlers = {}) => {
  const worktreeLayer = Layer.succeed(WorkflowWorktreePort, {
    provisionWorktrees: (plan) =>
      handlers.provisionWorktrees !== undefined
        ? Effect.gen(function* () {
            spy.provisionCalls += 1
            const receipt = yield* handlers.provisionWorktrees!(plan)
            for (const entry of receipt.entries) {
              if (entry.worktreeKind === "linked") {
                spy.activeLinkedWorktrees.add(entry.cwd)
                if (entry.branch !== undefined) {
                  spy.preservedSliceBranches.add(entry.branch)
                }
              }
            }
            return receipt
          })
        : Effect.sync(() => {
            spy.provisionCalls += 1
            const entries = plan.units.map((u) =>
              match({ level: plan.level, unit: u })
                .with({ level: "epic", unit: { _tag: "SliceUnit" } }, ({ unit: sliceUnit }) => {
                  const wtDir = AbsoluteRepoRoot.make(`/tmp/wt/${plan.runId}/${sliceUnit.unitId}`)
                  spy.activeLinkedWorktrees.add(wtDir)
                  spy.preservedSliceBranches.add(sliceUnit.branch)
                  return {
                    unitId: sliceUnit.unitId,
                    cwd: wtDir,
                    worktreeKind: "linked" as const,
                    branch: sliceUnit.branch,
                  }
                })
                .otherwise(() => ({
                  unitId: u.unitId,
                  cwd: CANONICAL_ROOT,
                  worktreeKind: "canonical" as const,
                })),
            )
            return {
              runId: plan.runId,
              canonicalRepoRoot: CANONICAL_ROOT,
              entries,
            }
          }),
    removeWorktreeCheckouts: (receipt) =>
      Effect.sync(() => {
        spy.removeCalls.push(receipt)
        for (const entry of receipt.entries) {
          if (entry.worktreeKind === "linked") {
            spy.activeLinkedWorktrees.delete(entry.cwd)
          }
        }
      }),
    mergeSliceWave: (input) =>
      Effect.sync(() => {
        spy.mergeCalls.push(input)
        return handlers.mergeWave !== undefined
          ? handlers.mergeWave(input)
          : { _tag: "Merged", mergedBranches: input.branches }
      }),
  })

  const dispatcherLayer = Layer.succeed(UnitAgentDispatcher, {
    runnerKind: "live",
    dispatchUnit: (request) =>
      Effect.sync(() => {
        spy.dispatchCalls.push(request)
        return handlers.dispatchUnit !== undefined
          ? handlers.dispatchUnit(request)
          : { _tag: "Completed" }
      }),
  })

  const verifierLayer = Layer.succeed(UnitVerifier, {
    completeUnit: (input) =>
      Effect.sync(() => {
        spy.completeUnitCalls.push({
          unitId: input.unit.unitId,
          attempt: input.attempt,
          cwd: input.cwd,
          siblingInFlightOwnedPaths: input.siblingInFlightOwnedPaths,
        })
        return handlers.completeUnit !== undefined
          ? handlers.completeUnit({ unitId: input.unit.unitId, attempt: input.attempt })
          : makeCompletedOutcome(input.unit.unitId, input.attempt, input.unit.ownedRelPaths)
      }),
    completeSharedStep: (input) =>
      Effect.sync(() => {
        spy.completeSharedCalls.push({
          attempt: input.attempt,
          sharedStepPaths: input.sharedStepPaths,
          priorUnitOwnedPaths: input.priorUnitOwnedPaths,
          cwd: input.cwd,
        })
        return handlers.completeSharedStep !== undefined
          ? handlers.completeSharedStep(input.attempt)
          : makeCompletedOutcome(SHARED_STEP_UNIT_ID, input.attempt, input.sharedStepPaths)
      }),
  })

  const reviewLayer = Layer.succeed(WorkflowReviewRouter, {
    routeReview: () =>
      Effect.sync(() => {
        spy.routeReviewCalls += 1
        return makeReviewPlan()
      }),
  })

  const projectionWriterLayer = Layer.succeed(WorkflowProjectionWriter, {
    upsertRun: (run) =>
      Effect.gen(function* () {
        spy.upsertRunCalls += 1
        if (handlers.upsertRun !== undefined) {
          yield* handlers.upsertRun(run, spy.upsertRunCalls)
        }
        const existing = spy.runs.get(run.runId)
        spy.runs.set(run.runId, {
          ...run,
          ...(run.planJson !== undefined
            ? { planJson: run.planJson }
            : existing?.planJson !== undefined
              ? { planJson: existing.planJson }
              : {}),
        })
        const onWaitLlm = spy.onWaitLlm
        yield* match(run.state)
          .with("waiting", () => {
            if (onWaitLlm === undefined || spy.units.size === 0) return Effect.void
            const allCompleted = [...spy.units.values()].every((u) =>
              match(u.status)
                .with("completed", () => true)
                .with("pending", "dispatched", "escalated", () => false)
                .exhaustive(),
            )
            return allCompleted ? Deferred.succeed(onWaitLlm, void 0) : Effect.void
          })
          .with("running", "completed", "aborted", () => Effect.void)
          .exhaustive()
      }),
    upsertUnit: (unit) =>
      Effect.gen(function* () {
        spy.upsertUnitCalls += 1
        if (handlers.upsertUnit !== undefined) {
          yield* handlers.upsertUnit(unit, spy.upsertUnitCalls)
        }
        spy.units.set(unit.unitKey, unit)
        yield* match(unit.status)
          .with("dispatched", () => {
            const signal = spy.onUnitDispatched?.get(unit.unitId)
            return signal !== undefined ? Deferred.succeed(signal, void 0) : Effect.void
          })
          .with("escalated", () =>
            Effect.gen(function* () {
              const signal = spy.onUnitEscalated?.get(unit.unitId)
              if (signal !== undefined) yield* Deferred.succeed(signal, void 0)
              if (spy.mergeCalls.length > 0 && spy.onMergeConflictEscalated !== undefined) {
                yield* Deferred.succeed(spy.onMergeConflictEscalated, void 0)
              }
            }),
          )
          .with("pending", "completed", () => Effect.void)
          .exhaustive()
      }),
    upsertAttempt: (attempt) =>
      Effect.gen(function* () {
        spy.upsertAttemptCalls += 1
        if (handlers.upsertAttempt !== undefined) {
          yield* handlers.upsertAttempt(attempt, spy.upsertAttemptCalls)
        }
        spy.attempts.set(attempt.attemptKey, attempt)
      }),
  })

  const workflowProjectorLayer = makeWorkflowProjectorTestLayer((input) =>
    Effect.gen(function* () {
      spy.waveProjectCalls.push(input)
      if (handlers.projectWorkflowRun !== undefined) {
        return yield* handlers.projectWorkflowRun(input, spy.waveProjectCalls.length)
      }
      return defaultProjectedOutcome(input.runId)
    }),
  )

  const portsLayer = Layer.mergeAll(
    worktreeLayer,
    dispatcherLayer,
    verifierLayer,
    reviewLayer,
    projectionWriterLayer,
    workflowProjectorLayer,
  )

  return HarnessTaskWorkflowLayer.pipe(
    Layer.provide(portsLayer),
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.merge(portsLayer),
  )
}
