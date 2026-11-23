import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { DurableDeferred, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AgentFailureReason,
  AttemptNumber,
  type CompiledPlan,
  type CompiledWorkUnit,
  EarsRequirementKey,
  EscalationOrdinal,
  FrictionLogState,
  GateExitCode,
  GitCommitSha,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  LlmPhaseReceipt,
  MaxConcurrency,
  type MergeSliceWaveInput,
  MergeSliceWaveOutcome,
  NxProjectName,
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
  TaskRunAbortedError,
  type UnitAgentRequest,
  type UnitOutcome,
  WaveIndex,
  WorkUnitId,
  type WorkflowAttemptRecord,
  WorkflowExecutionId,
  type WorkflowRunId,
  WorkflowRunId as WorkflowRunIdSchema,
  type WorkflowRunRecord,
  WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  type WorkflowUnitRecord,
  type WorktreeProvisionReceipt,
  WorkspaceFsError,
  WorkspaceTreeHash,
  WriterLeaseHeldError,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
} from "@harness/contract"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import {
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowProjectionWriter,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import { executionIdOf } from "../src/harness-task-workflow.js"
import { projectUnitOutcome, resolveUnitCwd } from "../src/harness-task-workflow-projections.js"
import {
  HarnessTaskWorkflow,
  HarnessTaskWorkflowLayer,
  LlmPhaseDone,
  type SpanSample,
  decideSpanBudgets,
  driveSharedStep,
  driveWorkUnit,
  makeUnitCompletionDeferred,
  makeUnitEscalationDeferred,
} from "../src/index.js"

const emptyFnIndex: ReadonlyMap<string, IndexedEffectFn> = new Map()

const CANONICAL_ROOT = AbsoluteRepoRoot.make("/tmp/harness-wf3-test-repo")
const BASE_SHA = GitCommitSha.make("1".repeat(40))
const PLAN_SHA = PlanSha256.make("2".repeat(64))
const TREE_HASH = WorkspaceTreeHash.make("3".repeat(64))
const STAMP_HASH = PackageStampHash.make("4".repeat(64))

const makeSliceUnit = (
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

const makePackageUnit = (
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

const makeReviewPlan = (): ReviewRoutingPlan => ({
  _tag: "SkipReviewPlan",
  depth: ReviewDepth.make("skip"),
  source: ReviewRoutingSource.make("deterministic"),
  reason: ReviewRoutingReason.make("Workflow unit test"),
  selections: [],
})

const makeLlmReceipt = (): LlmPhaseReceipt => ({
  workspaceHash: TREE_HASH,
  frictionLogCleared: "cleared" satisfies FrictionLogState,
})

const makeCompletedOutcome = (
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

interface SpyState {
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

const makeSpyState = (): SpyState => ({
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
  runs: new Map(),
  units: new Map(),
  attempts: new Map(),
  activeLinkedWorktrees: new Set(),
  preservedSliceBranches: new Set(),
})

interface FakeHandlers {
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
}

const makeWorkflowTestLayer = (spy: SpyState, handlers: FakeHandlers = {}) => {
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
          .with("waiting", () =>
            onWaitLlm !== undefined &&
            spy.units.size > 0 &&
            [...spy.units.values()].every((u) => u.status === "completed")
              ? Deferred.succeed(onWaitLlm, void 0)
              : Effect.void,
          )
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

  const portsLayer = Layer.mergeAll(
    worktreeLayer,
    dispatcherLayer,
    verifierLayer,
    reviewLayer,
    projectionWriterLayer,
  )

  return HarnessTaskWorkflowLayer.pipe(
    Layer.provide(portsLayer),
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.merge(portsLayer),
  )
}

describe("HarnessTaskWorkflow", () => {
  it.live(
    "SPEC-0023 REQ-1.2 / RFC-0013 REQ-3.1 replay determinism: memoises provision/unit/review/projection activities across DurableDeferred suspensions",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const u1Id = WorkUnitId.make("unit-alpha")
        const unitDispatched = yield* Deferred.make<void>()
        const waitingLlm = yield* Deferred.make<void>()
        spy.onUnitDispatched = new Map([[u1Id, unitDispatched]])
        spy.onWaitLlm = waitingLlm

        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-replay-001"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makePackageUnit("unit-alpha", "@harness/alpha", ["libs/alpha/src/a.ts"], 0)],
          sharedStepPaths: [],
        }

        const layer = makeWorkflowTestLayer(spy)
        yield* Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })
          yield* Deferred.await(unitDispatched)

          expect(spy.provisionCalls).toBe(1)
          expect(spy.routeReviewCalls).toBe(0)

          const attempt1 = AttemptNumber.make(1)
          const unitDef = makeUnitCompletionDeferred(u1Id, attempt1, EscalationOrdinal.make(1))
          yield* DurableDeferred.succeed(unitDef, {
            token: DurableDeferred.tokenFromExecutionId(unitDef, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeCompletedOutcome(u1Id, attempt1, ["libs/alpha/src/a.ts"]),
          })

          yield* Deferred.await(waitingLlm)
          expect(spy.provisionCalls).toBe(1)
          expect(spy.runs.get(plan.runId)?.state).toBe("waiting")

          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })

          const receipt = yield* HarnessTaskWorkflow.execute({ plan })
          expect(receipt.runId).toBe(plan.runId)
          expect(receipt.completedUnits).toEqual([u1Id])
          expect(spy.provisionCalls).toBe(1)
          expect(spy.routeReviewCalls).toBe(1)
          expect(spy.runs.get(plan.runId)?.state).toBe("completed")

          const projectionSnapshot = {
            upsertRunCalls: spy.upsertRunCalls,
            upsertUnitCalls: spy.upsertUnitCalls,
            upsertAttemptCalls: spy.upsertAttemptCalls,
          }
          expect(projectionSnapshot.upsertRunCalls).toBeGreaterThan(0)
          expect(projectionSnapshot.upsertUnitCalls).toBeGreaterThan(0)
          expect(projectionSnapshot.upsertAttemptCalls).toBeGreaterThan(0)

          const replayedReceipt = yield* HarnessTaskWorkflow.execute({ plan })
          expect(replayedReceipt).toEqual(receipt)
          expect(spy.provisionCalls).toBe(1)
          expect(spy.routeReviewCalls).toBe(1)
          expect({
            upsertRunCalls: spy.upsertRunCalls,
            upsertUnitCalls: spy.upsertUnitCalls,
            upsertAttemptCalls: spy.upsertAttemptCalls,
          }).toEqual(projectionSnapshot)
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "enforces bounded 3-attempt rejection -> RetryBudgetExhausted escalation -> retry with /r2 deferred completion",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const u1Id = WorkUnitId.make("unit-retry")
        const escalatedSignal = yield* Deferred.make<void>()
        spy.onUnitEscalated = new Map([[u1Id, escalatedSignal]])

        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-retry-002"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makePackageUnit("unit-retry", "@harness/retry", ["libs/retry/src/a.ts"], 0)],
          sharedStepPaths: [],
        }

        const layer = makeWorkflowTestLayer(spy)
        yield* Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })

          const ord1 = EscalationOrdinal.make(1)
          const reject1 = makeUnitCompletionDeferred(u1Id, AttemptNumber.make(1), ord1)
          yield* DurableDeferred.succeed(reject1, {
            token: DurableDeferred.tokenFromExecutionId(reject1, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: {
              _tag: "Rejected",
              unitId: u1Id,
              attempt: AttemptNumber.make(1),
              rejection: {
                _tag: "WriteSetViolation",
                offendingPaths: [OwnedRelPath.make("libs/other/bad.ts")],
              },
            },
          })

          const reject2 = makeUnitCompletionDeferred(u1Id, AttemptNumber.make(2), ord1)
          yield* DurableDeferred.succeed(reject2, {
            token: DurableDeferred.tokenFromExecutionId(reject2, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: {
              _tag: "Rejected",
              unitId: u1Id,
              attempt: AttemptNumber.make(2),
              rejection: {
                _tag: "PackageVerifyFailed",
                exitCode: GateExitCode.make(1),
                failureKind: "non-zero-exit",
              },
            },
          })

          const reject3 = makeUnitCompletionDeferred(u1Id, AttemptNumber.make(3), ord1)
          yield* DurableDeferred.succeed(reject3, {
            token: DurableDeferred.tokenFromExecutionId(reject3, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: {
              _tag: "Rejected",
              unitId: u1Id,
              attempt: AttemptNumber.make(3),
              rejection: { _tag: "StampMissing" },
            },
          })

          yield* Deferred.await(escalatedSignal)
          expect(spy.units.get(`${plan.runId}/${u1Id}`)?.status).toBe("escalated")
          expect(spy.runs.get(plan.runId)?.state).toBe("waiting")

          const escDef = makeUnitEscalationDeferred(u1Id, ord1)
          yield* DurableDeferred.succeed(escDef, {
            token: DurableDeferred.tokenFromExecutionId(escDef, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: { decision: "retry" },
          })

          const ord2 = EscalationOrdinal.make(2)
          const cycle2Def = makeUnitCompletionDeferred(u1Id, AttemptNumber.make(1), ord2)
          expect(cycle2Def.name).toBe("unit/unit-retry/1/r2")
          yield* DurableDeferred.succeed(cycle2Def, {
            token: DurableDeferred.tokenFromExecutionId(cycle2Def, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeCompletedOutcome(u1Id, AttemptNumber.make(1), ["libs/retry/src/a.ts"]),
          })

          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })

          const receipt = yield* HarnessTaskWorkflow.execute({ plan })
          expect(receipt.completedUnits).toEqual([u1Id])
          expect(spy.attempts.get(`${plan.runId}/${u1Id}#1`)?.verdict).toBe("rejected")
          expect(spy.attempts.get(`${plan.runId}/${u1Id}#2`)?.verdict).toBe("rejected")
          expect(spy.attempts.get(`${plan.runId}/${u1Id}#3`)?.verdict).toBe("rejected")
          expect(spy.attempts.get(`${plan.runId}/${u1Id}#1/r2`)?.verdict).toBe("completed")
          expect(spy.removeCalls.length).toBe(0)
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "abort escalation fails with TaskRunAbortedError and compensates linked worktrees while preserving slice/* branches",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const u1Id = WorkUnitId.make("slice-abort")
        const escalatedSignal = yield* Deferred.make<void>()
        spy.onUnitEscalated = new Map([[u1Id, escalatedSignal]])

        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-abort-003"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(2),
          },
          units: [makeSliceUnit("slice-abort", "slice/epic-abort", ["libs/abort/src/a.ts"], 0)],
          sharedStepPaths: [],
        }

        const layer = makeWorkflowTestLayer(spy, {
          completeUnit: ({ unitId, attempt }) => ({
            _tag: "Rejected",
            unitId,
            attempt,
            rejection: { _tag: "StampMissing" },
          }),
        })

        yield* Effect.gen(function* () {
          const fiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(
            Effect.exit,
            Effect.forkChild({ startImmediately: true }),
          )
          const executionId = yield* HarnessTaskWorkflow.executionId({ plan })

          yield* Deferred.await(escalatedSignal)
          expect(spy.activeLinkedWorktrees.size).toBe(1)
          expect(spy.preservedSliceBranches.has("slice/epic-abort")).toBe(true)

          const escDef = makeUnitEscalationDeferred(u1Id, EscalationOrdinal.make(1))
          yield* DurableDeferred.succeed(escDef, {
            token: DurableDeferred.tokenFromExecutionId(escDef, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: { decision: "abort" },
          })

          const exit = yield* Fiber.join(fiber)
          match(exit)
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected TaskRunAbortedError failure exit")
            })
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasDies(cause)).toBe(false)
              expect(Cause.hasFails(cause)).toBe(true)
              match(Cause.findErrorOption(cause))
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected typed TaskRunAbortedError in failure cause")
                })
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value).toBeInstanceOf(TaskRunAbortedError)
                  if (value instanceof TaskRunAbortedError) {
                    expect(value.runId).toBe(plan.runId)
                    expect(value.escalation).toEqual({
                      _tag: "RetryBudgetExhausted",
                      lastRejection: { _tag: "StampMissing" },
                    })
                  }
                })
                .exhaustive()
            })
            .exhaustive()

          // effect@4.0.0 layerMemory reuses state.instance.scope across Suspended replays,
          // so idempotent compensation may invoke once per replay.
          expect(spy.removeCalls.length).toBeGreaterThanOrEqual(1)
          expect(spy.activeLinkedWorktrees.size).toBe(0)
          expect(spy.preservedSliceBranches.has("slice/epic-abort")).toBe(true)
          expect(spy.runs.get(plan.runId)?.state).toBe("aborted")
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "handles L1 epic wave merges, MergeConflict escalation retry/abort, sharedStepPaths, and Automatic AuthRequired/Failed modes",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const u1 = makeSliceUnit("slice-one", "slice/epic-one", ["libs/one/src/index.ts"], 0)
        const u2 = makeSliceUnit("slice-two", "slice/epic-two", ["libs/two/src/index.ts"], 0)
        const u3 = makeSliceUnit(
          "slice-three",
          "slice/epic-three",
          ["libs/three/src/index.ts"],
          1,
          ["slice-one"],
        )

        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-epic-004"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "antigravity",
            maxConcurrency: MaxConcurrency.make(2),
          },
          units: [u1, u2, u3],
          sharedStepPaths: [OwnedRelPath.make("pnpm-lock.yaml")],
        }

        let authReturnedForOne = false
        let failedReturnedForTwo = false
        let conflictReturnedForWave0 = false
        const escalatedOne = yield* Deferred.make<void>()
        const mergeEscalated = yield* Deferred.make<void>()
        const waitLlm = yield* Deferred.make<void>()
        spy.onUnitEscalated = new Map([[u1.unitId, escalatedOne]])
        spy.onMergeConflictEscalated = mergeEscalated
        spy.onWaitLlm = waitLlm

        const layer = makeWorkflowTestLayer(spy, {
          dispatchUnit: (request) => {
            if (request.unit.unitId === u1.unitId && !authReturnedForOne) {
              authReturnedForOne = true
              return { _tag: "AuthRequired", runner: "antigravity" }
            }
            if (request.unit.unitId === u2.unitId && !failedReturnedForTwo) {
              failedReturnedForTwo = true
              return {
                _tag: "Failed",
                reason: AgentFailureReason.make("Transient runner exit 1"),
              }
            }
            return { _tag: "Completed" }
          },
          mergeWave: (input) => {
            if (input.waveIndex === 0 && !conflictReturnedForWave0) {
              conflictReturnedForWave0 = true
              return { _tag: "Conflict", branch: SliceBranchName.make("slice/epic-one") }
            }
            return { _tag: "Merged", mergedBranches: input.branches }
          },
        })

        yield* Effect.gen(function* () {
          const fiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(
            Effect.forkChild({ startImmediately: true }),
          )
          const executionId = yield* HarnessTaskWorkflow.executionId({ plan })

          // 1. AuthRequired on slice-one triggers immediate escalation without attempts 2..3
          yield* Deferred.await(escalatedOne)
          const authEsc = makeUnitEscalationDeferred(u1.unitId, EscalationOrdinal.make(1))
          yield* DurableDeferred.succeed(authEsc, {
            token: DurableDeferred.tokenFromExecutionId(authEsc, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: { decision: "retry" },
          })

          // 2. Wait for wave 0 MergeConflict escalation on slice-one (uses ordinal 2)
          yield* Deferred.await(mergeEscalated)

          const mergeEsc = makeUnitEscalationDeferred(u1.unitId, EscalationOrdinal.make(2))
          expect(mergeEsc.name).toBe("escalation/slice-one/2")
          yield* DurableDeferred.succeed(mergeEsc, {
            token: DurableDeferred.tokenFromExecutionId(mergeEsc, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: { decision: "retry" },
          })

          yield* Deferred.await(waitLlm)
          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })

          const receipt = yield* Fiber.join(fiber)
          expect(receipt.completedUnits).toEqual([u1.unitId, u2.unitId, u3.unitId])
          expect(spy.completeSharedCalls.length).toBe(1)
          expect(spy.completeSharedCalls[0]?.cwd).toBe(CANONICAL_ROOT)
          expect(spy.mergeCalls.length).toBe(3)
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "passes siblingInFlightOwnedPaths for L2 slice parallel waves",
    () =>
      Effect.gen(function* () {
        const l2Spy = makeSpyState()
        const pkgA = makePackageUnit("pkg-a", "@harness/a", ["libs/a/src/index.ts"], 0)
        const pkgB = makePackageUnit("pkg-b", "@harness/b", ["libs/b/src/index.ts"], 0)
        const l2Plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-l2-sib-005"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(2),
          },
          units: [pkgA, pkgB],
          sharedStepPaths: [],
        }

        const l2WaitLlm = yield* Deferred.make<void>()
        l2Spy.onWaitLlm = l2WaitLlm
        const l2Layer = makeWorkflowTestLayer(l2Spy)
        yield* Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute(
            { plan: l2Plan },
            { discard: true },
          )
          yield* Deferred.await(l2WaitLlm)
          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })
          const receipt = yield* HarnessTaskWorkflow.execute({ plan: l2Plan })
          expect([...receipt.completedUnits].sort()).toEqual(["pkg-a", "pkg-b"])
          const callA = l2Spy.completeUnitCalls.find((c) => c.unitId === "pkg-a")
          const callB = l2Spy.completeUnitCalls.find((c) => c.unitId === "pkg-b")
          expect(callA?.siblingInFlightOwnedPaths).toEqual([
            OwnedRelPath.make("libs/b/src/index.ts"),
          ])
          expect(callB?.siblingInFlightOwnedPaths).toEqual([
            OwnedRelPath.make("libs/a/src/index.ts"),
          ])
          expect(l2Spy.mergeCalls.length).toBe(0)
        }).pipe(Effect.provide(l2Layer))
      }),
    20_000,
  )

  it.live(
    "aborts cleanly on L1 MergeConflict and compensates linked worktrees",
    () =>
      Effect.gen(function* () {
        const l1Spy = makeSpyState()
        const l1MergeEsc = yield* Deferred.make<void>()
        l1Spy.onMergeConflictEscalated = l1MergeEsc
        const s1 = makeSliceUnit("slice-m1", "slice/epic-m1", ["libs/m1/src/index.ts"], 0)
        const l1Plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-l1-mc-006"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [s1],
          sharedStepPaths: [],
        }
        const l1Layer = makeWorkflowTestLayer(l1Spy, {
          mergeWave: () => ({
            _tag: "Conflict",
            branch: SliceBranchName.make("slice/epic-m1"),
          }),
        })
        yield* Effect.gen(function* () {
          const fiber = yield* HarnessTaskWorkflow.execute({ plan: l1Plan }).pipe(
            Effect.exit,
            Effect.forkChild({ startImmediately: true }),
          )
          const executionId = yield* HarnessTaskWorkflow.executionId({ plan: l1Plan })
          yield* Deferred.await(l1MergeEsc)
          const escDef = makeUnitEscalationDeferred(s1.unitId, EscalationOrdinal.make(1))
          yield* DurableDeferred.succeed(escDef, {
            token: DurableDeferred.tokenFromExecutionId(escDef, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: { decision: "abort" },
          })
          const exit = yield* Fiber.join(fiber)
          match(exit)
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected TaskRunAbortedError failure exit")
            })
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasDies(cause)).toBe(false)
              expect(Cause.hasFails(cause)).toBe(true)
              match(Cause.findErrorOption(cause))
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected typed TaskRunAbortedError in failure cause")
                })
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value).toBeInstanceOf(TaskRunAbortedError)
                  if (value instanceof TaskRunAbortedError) {
                    expect(value.escalation._tag).toBe("MergeConflict")
                  }
                })
                .exhaustive()
            })
            .exhaustive()
          // effect@4.0.0 layerMemory reuses state.instance.scope across Suspended replays.
          expect(l1Spy.removeCalls.length).toBeGreaterThanOrEqual(1)
          expect(l1Spy.activeLinkedWorktrees.size).toBe(0)
          expect(l1Spy.preservedSliceBranches.has("slice/epic-m1")).toBe(true)
          expect(l1Spy.runs.get(l1Plan.runId)?.state).toBe("aborted")
        }).pipe(Effect.provide(l1Layer))
      }),
    20_000,
  )

  it.live(
    "compensates linked worktrees on external HarnessTaskWorkflow.interrupt and drives manual sharedStepPaths via unit/shared-step/1",
    () =>
      Effect.gen(function* () {
        // 1. External interrupt while suspended at LlmPhaseDone compensates linked worktrees
        const intSpy = makeSpyState()
        const intWaitLlm = yield* Deferred.make<void>()
        intSpy.onWaitLlm = intWaitLlm
        const intPlan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-interrupt-007"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [makeSliceUnit("slice-int", "slice/epic-int", ["libs/int/src/index.ts"], 0)],
          sharedStepPaths: [],
        }

        const intLayer = makeWorkflowTestLayer(intSpy)
        yield* Effect.gen(function* () {
          const fiber = yield* HarnessTaskWorkflow.execute({ plan: intPlan }).pipe(
            Effect.exit,
            Effect.forkChild({ startImmediately: true }),
          )
          const executionId = yield* HarnessTaskWorkflow.executionId({ plan: intPlan })
          yield* Deferred.await(intWaitLlm)
          expect(intSpy.activeLinkedWorktrees.size).toBe(1)

          yield* HarnessTaskWorkflow.interrupt(executionId)
          yield* Fiber.join(fiber)
          // effect@4.0.0 layerMemory reuses state.instance.scope across Suspended replays.
          expect(intSpy.removeCalls.length).toBeGreaterThanOrEqual(1)
          expect(intSpy.activeLinkedWorktrees.size).toBe(0)
          expect(intSpy.preservedSliceBranches.has("slice/epic-int")).toBe(true)
        }).pipe(Effect.provide(intLayer))

        // 2. Manual mode drives sharedStepPaths sequentially via unit/shared-step/1 after waves
        const manSpy = makeSpyState()
        const sharedDispatched = yield* Deferred.make<void>()
        const manWaitLlm = yield* Deferred.make<void>()
        manSpy.onUnitDispatched = new Map([[SHARED_STEP_UNIT_ID, sharedDispatched]])
        manSpy.onWaitLlm = manWaitLlm

        const manUnitId = WorkUnitId.make("pkg-man")
        const manPlan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-manual-ss-008"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makePackageUnit("pkg-man", "@harness/man", ["libs/man/src/index.ts"], 0)],
          sharedStepPaths: [OwnedRelPath.make("tsconfig.base.json")],
        }
        const manLayer = makeWorkflowTestLayer(manSpy)
        yield* Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute(
            { plan: manPlan },
            { discard: true },
          )
          const ord1 = EscalationOrdinal.make(1)
          const att1 = AttemptNumber.make(1)

          const unitDef = makeUnitCompletionDeferred(manUnitId, att1, ord1)
          yield* DurableDeferred.succeed(unitDef, {
            token: DurableDeferred.tokenFromExecutionId(unitDef, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeCompletedOutcome(manUnitId, att1, ["libs/man/src/index.ts"]),
          })

          yield* Deferred.await(sharedDispatched)
          const sharedDef = makeUnitCompletionDeferred(SHARED_STEP_UNIT_ID, att1, ord1)
          expect(sharedDef.name).toBe("unit/shared-step/1")
          yield* DurableDeferred.succeed(sharedDef, {
            token: DurableDeferred.tokenFromExecutionId(sharedDef, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeCompletedOutcome(SHARED_STEP_UNIT_ID, att1, ["tsconfig.base.json"]),
          })

          yield* Deferred.await(manWaitLlm)
          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })

          const receipt = yield* HarnessTaskWorkflow.execute({ plan: manPlan })
          expect(receipt.completedUnits).toEqual([manUnitId])
          expect(manSpy.units.get(`${manPlan.runId}/${SHARED_STEP_UNIT_ID}`)?.status).toBe(
            "completed",
          )
        }).pipe(Effect.provide(manLayer))
      }),
    20_000,
  )

  it.live(
    "L1 Automatic epic replays deterministically across LlmPhaseDone suspension without re-running completed activities or projections",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const waitLlm = yield* Deferred.make<void>()
        spy.onWaitLlm = waitLlm

        const s1 = makeSliceUnit("slice-replay-1", "slice/epic-r1", ["libs/r1/src/index.ts"], 0)
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-epic-replay-009"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(2),
          },
          units: [s1],
          sharedStepPaths: [],
        }

        const layer = makeWorkflowTestLayer(spy)
        yield* Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })
          yield* Deferred.await(waitLlm)

          expect(spy.provisionCalls).toBe(1)
          expect(spy.dispatchCalls.length).toBe(1)
          expect(spy.completeUnitCalls.length).toBe(1)
          expect(spy.mergeCalls.length).toBe(1)
          expect(spy.routeReviewCalls).toBe(0)
          expect(spy.runs.get(plan.runId)?.state).toBe("waiting")

          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })

          const receipt = yield* HarnessTaskWorkflow.execute({ plan })
          expect(receipt.completedUnits).toEqual([s1.unitId])
          expect(spy.provisionCalls).toBe(1)
          expect(spy.dispatchCalls.length).toBe(1)
          expect(spy.completeUnitCalls.length).toBe(1)
          expect(spy.mergeCalls.length).toBe(1)
          expect(spy.routeReviewCalls).toBe(1)

          const projectionSnapshot = {
            upsertRunCalls: spy.upsertRunCalls,
            upsertUnitCalls: spy.upsertUnitCalls,
            upsertAttemptCalls: spy.upsertAttemptCalls,
          }
          const replayed = yield* HarnessTaskWorkflow.execute({ plan })
          expect(replayed).toEqual(receipt)
          expect(spy.provisionCalls).toBe(1)
          expect(spy.dispatchCalls.length).toBe(1)
          expect(spy.completeUnitCalls.length).toBe(1)
          expect(spy.mergeCalls.length).toBe(1)
          expect(spy.routeReviewCalls).toBe(1)
          expect({
            upsertRunCalls: spy.upsertRunCalls,
            upsertUnitCalls: spy.upsertUnitCalls,
            upsertAttemptCalls: spy.upsertAttemptCalls,
          }).toEqual(projectionSnapshot)
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "L2 multi-wave slice includes prior-or-same-wave sibling owned paths per wave and passes priorUnitOwnedPaths to completeSharedStep",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const waitLlm = yield* Deferred.make<void>()
        spy.onWaitLlm = waitLlm

        const pkgA = makePackageUnit("pkg-a", "@harness/a", ["libs/a/src/index.ts"], 0)
        const pkgC = makePackageUnit("pkg-c", "@harness/c", ["libs/c/src/index.ts"], 0)
        const pkgB = makePackageUnit("pkg-b", "@harness/b", ["libs/b/src/index.ts"], 1, ["pkg-a"])
        const sharedPaths = [OwnedRelPath.make("tsconfig.base.json")]

        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-slice-multiwave-010"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(2),
          },
          units: [pkgA, pkgC, pkgB],
          sharedStepPaths: sharedPaths,
        }

        const layer = makeWorkflowTestLayer(spy)
        yield* Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })
          yield* Deferred.await(waitLlm)
          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })

          const receipt = yield* HarnessTaskWorkflow.execute({ plan })
          expect(receipt.completedUnits).toEqual([pkgA.unitId, pkgC.unitId, pkgB.unitId])

          const callA = spy.completeUnitCalls.find((c) => c.unitId === pkgA.unitId)
          const callB = spy.completeUnitCalls.find((c) => c.unitId === pkgB.unitId)
          expect(callA?.siblingInFlightOwnedPaths).toEqual([
            OwnedRelPath.make("libs/c/src/index.ts"),
          ])
          expect(callB?.siblingInFlightOwnedPaths).toEqual([
            OwnedRelPath.make("libs/a/src/index.ts"),
            OwnedRelPath.make("libs/c/src/index.ts"),
          ])
          expect(spy.completeSharedCalls.length).toBe(1)
          expect(spy.completeSharedCalls[0]?.priorUnitOwnedPaths).toEqual([
            OwnedRelPath.make("libs/a/src/index.ts"),
            OwnedRelPath.make("libs/c/src/index.ts"),
            OwnedRelPath.make("libs/b/src/index.ts"),
          ])
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "emits Harness.executeTaskWorkflow, Harness.driveWorkUnit, and Harness.driveSharedStep spans within SpanBudget",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const waitLlm = yield* Deferred.make<void>()
        spy.onWaitLlm = waitLlm
        const pkg = makePackageUnit("pkg-span", "@harness/span", ["libs/span/src/index.ts"], 0)
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-spans-011"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [pkg],
          sharedStepPaths: [OwnedRelPath.make("package.json")],
        }
        const directPlan: CompiledPlan = {
          ...plan,
          runId: WorkflowRunIdSchema.make("run-spans-direct-012"),
        }

        const layer = makeWorkflowTestLayer(spy)
        const tracedEffect = Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })
          yield* Deferred.await(waitLlm)
          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })
          const receipt = yield* HarnessTaskWorkflow.execute({ plan })

          const directUnit = yield* driveWorkUnit(directPlan, pkg, CANONICAL_ROOT).pipe(
            Effect.provideService(
              WorkflowEngine.WorkflowInstance,
              WorkflowEngine.WorkflowInstance.initial(HarnessTaskWorkflow, "direct-unit-exec-012"),
            ),
          )
          yield* driveSharedStep(directPlan, CANONICAL_ROOT).pipe(
            Effect.provideService(
              WorkflowEngine.WorkflowInstance,
              WorkflowEngine.WorkflowInstance.initial(
                HarnessTaskWorkflow,
                "direct-shared-exec-012",
              ),
            ),
          )
          return { receipt, directUnit }
        }).pipe(Effect.provide(layer))

        const { result, spans } = yield* runWithTestTracer(
          "HarnessTaskWorkflow.spans",
          tracedEffect,
          emptyFnIndex,
        )
        expect(result.receipt.completedUnits).toEqual([pkg.unitId])
        expect(result.directUnit).toBe(pkg.unitId)

        const spanSamples: ReadonlyArray<SpanSample> = spans.map((s) => ({
          spanId: s.spanId,
          name: s.name,
          parentSpanId: s.parentSpanId,
          durationMs: s.durationMs,
          startTimeMs: s.startTimeMs,
          endTimeMs: s.endTimeMs,
          exitTag: match(s.exitTag)
            .with("Success", () => "Success" as const)
            .with("Failure", () => "Failure" as const)
            .with("Defect", () => "Defect" as const)
            .with("Interrupt", () => "Failure" as const)
            .with(undefined, () => undefined)
            .exhaustive(),
          errorTag: s.errorTag,
        }))
        const budgetViolations = yield* decideSpanBudgets({ spans: spanSamples })
        expect(budgetViolations).toEqual([])
        expect(spans.some((s) => s.name === "Harness.executeTaskWorkflow")).toBe(true)
        expect(spans.some((s) => s.name === "Harness.driveWorkUnit")).toBe(true)
        expect(spans.some((s) => s.name === "Harness.driveSharedStep")).toBe(true)
      }),
    20_000,
  )

  it.live(
    "increments MergeConflict escalation ordinals across repeated conflicts on the same unit",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const u1 = makeSliceUnit(
          "slice-repeat",
          "slice/epic-repeat",
          ["libs/repeat/src/index.ts"],
          0,
        )
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-epic-repeat-conflict"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "antigravity",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [u1],
          sharedStepPaths: [],
        }

        let conflictCount = 0
        const esc1 = yield* Deferred.make<void>()
        const esc2 = yield* Deferred.make<void>()
        const waitLlm = yield* Deferred.make<void>()
        spy.onMergeConflictEscalated = esc1
        spy.onWaitLlm = waitLlm

        const layer = makeWorkflowTestLayer(spy, {
          mergeWave: (input) => {
            conflictCount += 1
            if (conflictCount <= 2) {
              return { _tag: "Conflict", branch: SliceBranchName.make("slice/epic-repeat") }
            }
            return { _tag: "Merged", mergedBranches: input.branches }
          },
        })

        yield* Effect.gen(function* () {
          const fiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(
            Effect.forkChild({ startImmediately: true }),
          )
          const executionId = yield* HarnessTaskWorkflow.executionId({ plan })

          yield* Deferred.await(esc1)
          spy.onMergeConflictEscalated = esc2
          const firstEsc = makeUnitEscalationDeferred(u1.unitId, EscalationOrdinal.make(1))
          expect(firstEsc.name).toBe("escalation/slice-repeat/1")
          yield* DurableDeferred.succeed(firstEsc, {
            token: DurableDeferred.tokenFromExecutionId(firstEsc, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: { decision: "retry" },
          })

          const secondSignal = yield* Deferred.await(esc2).pipe(
            Effect.as("escalated" as const),
            Effect.raceFirst(Fiber.await(fiber).pipe(Effect.as("exited" as const))),
          )
          expect(secondSignal).toBe("escalated")

          const secondEsc = makeUnitEscalationDeferred(u1.unitId, EscalationOrdinal.make(2))
          expect(secondEsc.name).toBe("escalation/slice-repeat/2")
          yield* DurableDeferred.succeed(secondEsc, {
            token: DurableDeferred.tokenFromExecutionId(secondEsc, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: { decision: "retry" },
          })

          yield* Deferred.await(waitLlm)
          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })

          const receipt = yield* Fiber.join(fiber)
          expect(receipt.completedUnits).toEqual([u1.unitId])
          expect(spy.mergeCalls.length).toBe(3)
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "F-9.1 / F-8.1: retries transient WorkflowStoreUnavailableError up to 3 times inside projection activities without triggering worktree compensation",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const waitLlm = yield* Deferred.make<void>()
        spy.onWaitLlm = waitLlm

        const u1 = makeSliceUnit(
          "slice-proj-retry",
          "slice/epic-proj-retry",
          ["libs/proj-retry/src/index.ts"],
          0,
        )
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-proj-retry-013"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [u1],
          sharedStepPaths: [],
        }

        let initialRunAttempts = 0
        const layer = makeWorkflowTestLayer(spy, {
          upsertRun: (_run, callIndex) => {
            if (callIndex <= 3) {
              initialRunAttempts += 1
              return Effect.fail(
                new WorkflowStoreUnavailableError({
                  operation: WorkflowStoreOperation.make("read-model-write"),
                  reason: WorkflowStoreFailureReason.make(`transient store outage #${callIndex}`),
                }),
              )
            }
            if (callIndex === 4) {
              initialRunAttempts += 1
            }
            return Effect.void
          },
        })

        yield* Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })
          yield* Deferred.await(waitLlm)
          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })
          const receipt = yield* HarnessTaskWorkflow.execute({ plan })
          expect(receipt.completedUnits).toEqual([u1.unitId])
          expect(initialRunAttempts).toBe(4)
          expect(spy.removeCalls).toEqual([])
          expect(spy.activeLinkedWorktrees.size).toBe(1)
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "F-9.1 / F-8.1: fails fast without retry on permanent WriterLeaseHeldError and surfaces WriterLeaseHeldError from HarnessTaskWorkflow",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const u1 = makeSliceUnit(
          "slice-lease-held",
          "slice/epic-lease-held",
          ["libs/lease-held/src/index.ts"],
          0,
        )
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-lease-held-014"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [u1],
          sharedStepPaths: [],
        }

        const layer = makeWorkflowTestLayer(spy, {
          upsertRun: () =>
            Effect.fail(
              new WriterLeaseHeldError({
                holderId: LeaseHolderId.make("daemon-other"),
                leaseEpoch: LeaseEpoch.make(7),
                lockFilePath: LeaseFilePath.make("/tmp/harness-daemon.lock"),
              }),
            ),
        })

        yield* Effect.gen(function* () {
          const exit = yield* HarnessTaskWorkflow.execute({ plan }).pipe(Effect.exit)
          match(exit)
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WriterLeaseHeldError failure exit")
            })
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasDies(cause)).toBe(false)
              match(Cause.findErrorOption(cause))
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected WriterLeaseHeldError in failure cause")
                })
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value).toBeInstanceOf(WriterLeaseHeldError)
                  if (value instanceof WriterLeaseHeldError) {
                    expect(value.holderId).toBe("daemon-other")
                    expect(value.leaseEpoch).toBe(7)
                  }
                })
                .exhaustive()
            })
            .exhaustive()
          expect(spy.upsertRunCalls).toBe(1)
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "F-10.1: resolveUnitCwd fails closed with WorkspaceFsError when a unit has no provisioned worktree entry",
    () =>
      Effect.gen(function* () {
        const missingUnitId = WorkUnitId.make("slice-missing-wt")
        const incompleteReceipt: WorktreeProvisionReceipt = {
          runId: WorkflowRunIdSchema.make("run-missing-wt-015"),
          canonicalRepoRoot: CANONICAL_ROOT,
          entries: [],
        }

        const directExit = yield* resolveUnitCwd(incompleteReceipt, missingUnitId).pipe(Effect.exit)
        match(directExit)
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected WorkspaceFsError for missing unit worktree entry")
          })
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
            match(Cause.findErrorOption(cause))
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected WorkspaceFsError in failure cause")
              })
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(WorkspaceFsError)
                if (value instanceof WorkspaceFsError) {
                  expect(value.operation).toBe("stat")
                  expect(value.filePath).toBe(CANONICAL_ROOT)
                  expect(value.reason).toContain("slice-missing-wt")
                }
              })
              .exhaustive()
          })
          .exhaustive()

        const spy = makeSpyState()
        const u1 = makeSliceUnit(
          "slice-missing-wt",
          "slice/epic-missing-wt",
          ["libs/missing-wt/src/index.ts"],
          0,
        )
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-missing-wt-015"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [u1],
          sharedStepPaths: [],
        }

        const layer = makeWorkflowTestLayer(spy, {
          provisionWorktrees: () => Effect.succeed(incompleteReceipt),
        })

        yield* Effect.gen(function* () {
          const exit = yield* HarnessTaskWorkflow.execute({ plan }).pipe(Effect.exit)
          match(exit)
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError failure exit")
            })
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasDies(cause)).toBe(false)
              match(Cause.findErrorOption(cause))
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected WorkspaceFsError in failure cause")
                })
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value).toBeInstanceOf(WorkspaceFsError)
                })
                .exhaustive()
            })
            .exhaustive()
          expect(spy.dispatchCalls).toEqual([])
          expect(spy.completeUnitCalls).toEqual([])
          expect(spy.removeCalls.length).toBeGreaterThanOrEqual(1)
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "F-18.2 / S-4.1 / F-21.1: uses canonical keys, typed WorkflowAttemptRecord rejections, executionIdOf, and real lastRejection without fabricated AgentFailed",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const u1 = makePackageUnit("pkg-typed", "@harness/typed", ["libs/typed/src/index.ts"], 0)
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-typed-016"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [u1],
          sharedStepPaths: [],
        }

        const waitLlm = yield* Deferred.make<void>()
        spy.onWaitLlm = waitLlm

        const layer = makeWorkflowTestLayer(spy, {
          completeUnit: ({ unitId, attempt }) =>
            attempt === 1
              ? {
                  _tag: "Rejected",
                  unitId,
                  attempt,
                  rejection: {
                    _tag: "WriteSetViolation",
                    offendingPaths: [OwnedRelPath.make("libs/other/sneaky.ts")],
                  },
                }
              : makeCompletedOutcome(unitId, attempt, u1.ownedRelPaths),
        })

        yield* Effect.gen(function* () {
          const helperExecId = yield* executionIdOf(plan)
          const rawExecId = yield* HarnessTaskWorkflow.executionId({ plan })
          expect(helperExecId).toBe(WorkflowExecutionId.make(rawExecId))

          const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })
          expect(helperExecId).toBe(WorkflowExecutionId.make(executionId))

          yield* Deferred.await(waitLlm)
          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })

          const receipt = yield* HarnessTaskWorkflow.execute({ plan })
          expect(receipt.completedUnits).toEqual([u1.unitId])
          expect(spy.runs.get(plan.runId)?.executionId).toBe(helperExecId)

          const unitRecord = spy.units.get(makeWorkflowUnitKey(plan.runId, u1.unitId))
          expect(unitRecord?.status).toBe("completed")

          const ord1 = EscalationOrdinal.make(1)
          const rejectedAttempt = spy.attempts.get(
            makeWorkflowAttemptKey(plan.runId, u1.unitId, AttemptNumber.make(1), ord1),
          )
          expect(rejectedAttempt).toBeDefined()
          if (rejectedAttempt !== undefined) {
            match(rejectedAttempt)
              .with({ verdict: "rejected" }, (attemptRecord) => {
                expect(attemptRecord.rejection).toEqual({
                  _tag: "WriteSetViolation",
                  offendingPaths: [OwnedRelPath.make("libs/other/sneaky.ts")],
                })
              })
              .with({ verdict: "dispatched" }, { verdict: "completed" }, () => {
                expect.unreachable("Expected rejected attempt record")
              })
              .exhaustive()
          }

          const completedAttempt = spy.attempts.get(
            makeWorkflowAttemptKey(plan.runId, u1.unitId, AttemptNumber.make(2), ord1),
          )
          expect(completedAttempt?.verdict).toBe("completed")
          expect(completedAttempt?.packageStampHash).toBe(STAMP_HASH)

          yield* projectUnitOutcome(
            plan,
            {
              unitId: u1.unitId,
              kind: "package",
              waveIndex: u1.waveIndex,
              ownedRelPaths: u1.ownedRelPaths,
              unitForDispatch: u1,
              verifyAttempt: () =>
                Effect.succeed(makeCompletedOutcome(u1.unitId, AttemptNumber.make(3))),
            },
            AttemptNumber.make(3),
            ord1,
            {
              _tag: "Escalated",
              unitId: u1.unitId,
              escalation: {
                _tag: "RetryBudgetExhausted",
                lastRejection: {
                  _tag: "PackageVerifyFailed",
                  exitCode: GateExitCode.make(2),
                  failureKind: "non-zero-exit",
                },
              },
            },
          ).pipe(
            Effect.provideService(
              WorkflowEngine.WorkflowInstance,
              WorkflowEngine.WorkflowInstance.initial(HarnessTaskWorkflow, helperExecId),
            ),
          )

          const escalatedAttempt = spy.attempts.get(
            makeWorkflowAttemptKey(plan.runId, u1.unitId, AttemptNumber.make(3), ord1),
          )
          expect(escalatedAttempt).toBeDefined()
          if (escalatedAttempt !== undefined) {
            match(escalatedAttempt)
              .with({ verdict: "rejected" }, (attemptRecord) => {
                expect(attemptRecord.rejection).toEqual({
                  _tag: "PackageVerifyFailed",
                  exitCode: GateExitCode.make(2),
                  failureKind: "non-zero-exit",
                })
              })
              .with({ verdict: "dispatched" }, { verdict: "completed" }, () => {
                expect.unreachable("Expected rejected attempt record for Escalated outcome")
              })
              .exhaustive()
          }
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )
})
