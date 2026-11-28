import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { DurableDeferred, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  AgentFailureReason,
  AttemptNumber,
  type CompiledPlan,
  type CompleteUnitInput,
  EscalationOrdinal,
  GateExitCode,
  MaxConcurrency,
  NonNegativeCount,
  OmnigraphBranchName,
  OwnedRelPath,
  PackageVerifyFailureDetail,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  TaskRunAbortedError,
  type UnitAgentRequest,
  UnitOutcome,
  WaveIndex,
  WorkUnitId,
  WorkflowProjectionOutcome,
  WorkflowProjectionTargetBranch,
  WorkflowRunId as WorkflowRunIdSchema,
  WorkflowStoreFailureReason,
  isPureInterruptCause,
} from "@harness/contract"
import {
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowProjectionWriter,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import { runWithTestTracer } from "@harness/ingest"
import { decideSpanBudgets, type SpanSample } from "../src/span-budget.js"
import {
  HarnessTaskWorkflow,
  HarnessTaskWorkflowLayer,
  LlmPhaseDone,
  makeUnitCompletionDeferred,
  makeUnitEscalationDeferred,
} from "../src/index.js"
import { projectWaveToHarnessActivity } from "../src/harness-task-workflow-projections.js"
import {
  CANONICAL_ROOT,
  BASE_SHA,
  PLAN_SHA,
  defaultWorkflowProjectorLayer,
  emptyFnIndex,
  makeSliceUnit,
  makePackageUnit,
  makeLlmReceipt,
  makeReviewPlan,
  makeCompletedOutcome,
  makeSpyState,
  makeWorkflowProjectorTestLayer,
  makeWorkflowTestLayer,
} from "./helpers/harness-task-workflow-fixture.js"

describe("HarnessTaskWorkflow execution, waves & merges", () => {
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
    "passes priorRejection into subsequent Automatic UnitAgentRequest attempts and forwards runner into UnitVerifier.completeUnit",
    () =>
      Effect.gen(function* () {
        const waitLlm = yield* Deferred.make<void>()

        const unitId = WorkUnitId.make("auto-retry-unit")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-auto-prior-rejection-009"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [makePackageUnit(unitId, "@harness/auto", ["libs/auto/src/index.ts"], 0)],
          sharedStepPaths: [],
        }

        const attempt2Reason = AgentFailureReason.make("Runner exited 1 on attempt 2")
        const dispatchCalls: Array<UnitAgentRequest> = []
        const recordedCompleteInputs: Array<CompleteUnitInput> = []
        const portsLayer = Layer.mergeAll(
          Layer.succeed(WorkflowWorktreePort, {
            provisionWorktrees: (p) =>
              Effect.succeed({
                runId: p.runId,
                canonicalRepoRoot: CANONICAL_ROOT,
                entries: p.units.map((u) => ({
                  unitId: u.unitId,
                  cwd: CANONICAL_ROOT,
                  worktreeKind: "canonical" as const,
                })),
              }),
            removeWorktreeCheckouts: () => Effect.void,
            mergeSliceWave: (input) =>
              Effect.succeed({ _tag: "Merged" as const, mergedBranches: input.branches }),
          }),
          Layer.succeed(UnitAgentDispatcher, {
            runnerKind: "live" as const,
            dispatchUnit: (request) =>
              Effect.sync(() => {
                dispatchCalls.push(request)
                if (request.attempt === 2) {
                  return { _tag: "Failed" as const, reason: attempt2Reason }
                }
                return { _tag: "Completed" as const }
              }),
          }),
          Layer.succeed(UnitVerifier, {
            completeUnit: (input) =>
              Effect.sync(() => {
                recordedCompleteInputs.push(input)
                if (input.attempt === 1) {
                  return UnitOutcome.cases.Rejected.make({
                    unitId: input.unit.unitId,
                    attempt: input.attempt,
                    rejection: {
                      _tag: "PackageVerifyFailed",
                      exitCode: GateExitCode.make(1),
                      failureKind: "non-zero-exit",
                      detail: PackageVerifyFailureDetail.make("attempt 1 verify failed"),
                    },
                  })
                }
                return makeCompletedOutcome(
                  input.unit.unitId,
                  input.attempt,
                  input.unit.ownedRelPaths,
                )
              }),
            completeSharedStep: (input) =>
              Effect.succeed(
                makeCompletedOutcome(SHARED_STEP_UNIT_ID, input.attempt, input.sharedStepPaths),
              ),
          }),
          Layer.succeed(WorkflowReviewRouter, {
            routeReview: () => Effect.succeed(makeReviewPlan()),
          }),
          Layer.succeed(WorkflowProjectionWriter, {
            upsertRun: (run) =>
              match(run.state)
                .with("waiting", () => Deferred.succeed(waitLlm, void 0).pipe(Effect.asVoid))
                .with("running", "completed", "aborted", () => Effect.void)
                .exhaustive(),
            upsertUnit: () => Effect.void,
            upsertAttempt: () => Effect.void,
          }),
          defaultWorkflowProjectorLayer,
        )
        const layer = HarnessTaskWorkflowLayer.pipe(
          Layer.provide(portsLayer),
          Layer.provideMerge(WorkflowEngine.layerMemory),
        )

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
          expect(receipt.completedUnits).toEqual([unitId])
          expect(dispatchCalls).toHaveLength(3)
          expect(dispatchCalls[0]?.attempt).toBe(1)
          expect(dispatchCalls[0]?.priorRejection).toBeUndefined()
          expect(dispatchCalls[1]?.attempt).toBe(2)
          expect(dispatchCalls[1]?.priorRejection).toEqual({
            _tag: "PackageVerifyFailed",
            exitCode: GateExitCode.make(1),
            failureKind: "non-zero-exit",
            detail: PackageVerifyFailureDetail.make("attempt 1 verify failed"),
          })
          expect(dispatchCalls[2]?.attempt).toBe(3)
          expect(dispatchCalls[2]?.priorRejection).toEqual({
            _tag: "AgentFailed",
            reason: attempt2Reason,
          })
          expect(recordedCompleteInputs).toHaveLength(2)
          expect(recordedCompleteInputs[0]?.attempt).toBe(1)
          expect(recordedCompleteInputs[0]?.runner).toBe("claude-code")
          expect(recordedCompleteInputs[1]?.attempt).toBe(3)
          expect(recordedCompleteInputs[1]?.runner).toBe("claude-code")
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "forwards Automatic mcpIsolation/hardMcpFallback and escalates immediately on FatalFailed without burning retry attempts",
    () =>
      Effect.gen(function* () {
        const unitId = WorkUnitId.make("auto-fatal-unit")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-auto-fatal-010"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "antigravity",
            maxConcurrency: MaxConcurrency.make(1),
            mcpIsolation: "hard",
            hardMcpFallback: "reject",
          },
          units: [makePackageUnit(unitId, "@harness/auto", ["libs/auto/src/index.ts"], 0)],
          sharedStepPaths: [],
        }

        const fatalReason = AgentFailureReason.make("Failed to spawn 'agy': ENOENT")
        const dispatchCalls: Array<UnitAgentRequest> = []
        const escalatedDeferred = yield* Deferred.make<void>()

        const portsLayer = Layer.mergeAll(
          Layer.succeed(WorkflowWorktreePort, {
            provisionWorktrees: (p) =>
              Effect.succeed({
                runId: p.runId,
                canonicalRepoRoot: CANONICAL_ROOT,
                entries: p.units.map((u) => ({
                  unitId: u.unitId,
                  cwd: CANONICAL_ROOT,
                  worktreeKind: "canonical" as const,
                })),
              }),
            removeWorktreeCheckouts: () => Effect.void,
            mergeSliceWave: (input) =>
              Effect.succeed({ _tag: "Merged" as const, mergedBranches: input.branches }),
          }),
          Layer.succeed(UnitAgentDispatcher, {
            runnerKind: "live" as const,
            dispatchUnit: (request) =>
              Effect.sync(() => {
                dispatchCalls.push(request)
                return { _tag: "FatalFailed" as const, reason: fatalReason }
              }),
          }),
          Layer.succeed(UnitVerifier, {
            completeUnit: (input) =>
              Effect.succeed(
                makeCompletedOutcome(input.unit.unitId, input.attempt, input.unit.ownedRelPaths),
              ),
            completeSharedStep: (input) =>
              Effect.succeed(
                makeCompletedOutcome(SHARED_STEP_UNIT_ID, input.attempt, input.sharedStepPaths),
              ),
          }),
          Layer.succeed(WorkflowReviewRouter, {
            routeReview: () => Effect.succeed(makeReviewPlan()),
          }),
          Layer.succeed(WorkflowProjectionWriter, {
            upsertRun: () => Effect.void,
            upsertUnit: (u) =>
              match(u.status)
                .with("escalated", () =>
                  Deferred.succeed(escalatedDeferred, void 0).pipe(Effect.asVoid),
                )
                .with("pending", "dispatched", "completed", () => Effect.void)
                .exhaustive(),
            upsertAttempt: () => Effect.void,
          }),
          defaultWorkflowProjectorLayer,
        )
        const layer = HarnessTaskWorkflowLayer.pipe(
          Layer.provide(portsLayer),
          Layer.provideMerge(WorkflowEngine.layerMemory),
        )

        yield* Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })
          yield* Deferred.await(escalatedDeferred)
          expect(dispatchCalls).toHaveLength(1)
          expect(dispatchCalls[0]?.mcpIsolation).toBe("hard")
          expect(dispatchCalls[0]?.hardMcpFallback).toBe("reject")

          const escDef = makeUnitEscalationDeferred(unitId, EscalationOrdinal.make(1))
          yield* DurableDeferred.succeed(escDef, {
            token: DurableDeferred.tokenFromExecutionId(escDef, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: { decision: "abort" },
          })

          const abortedErr = yield* Effect.flip(HarnessTaskWorkflow.execute({ plan }))
          match(abortedErr)
            .with({ _tag: "TaskRunAbortedError" }, (e) => {
              expect(e.escalation).toEqual({
                _tag: "RetryBudgetExhausted",
                lastRejection: { _tag: "AgentFailed", reason: fatalReason },
              })
            })
            .with(
              { _tag: "WorkspaceFsError" },
              { _tag: "WorkflowStoreUnavailableError" },
              { _tag: "WriterLeaseHeldError" },
              (e) => expect.unreachable(`Expected TaskRunAbortedError, got ${e._tag}`),
            )
            .exhaustive()
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "RFC-0013 REQ-4.5: projectWaveToHarnessActivity runs once per wave after units and L1 merge with trigger='wave' and ActiveTaskImplBranch, and memoises on replay",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const waitLlm = yield* Deferred.make<void>()
        spy.onWaitLlm = waitLlm

        const w0 = makeSliceUnit("slice-w0", "slice/epic-w0", ["libs/w0/src/index.ts"], 0)
        const w1 = makeSliceUnit("slice-w1", "slice/epic-w1", ["libs/w1/src/index.ts"], 1, [
          "slice-w0",
        ])
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-wave-proj-011"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(2),
          },
          units: [w0, w1],
          sharedStepPaths: [],
        }

        const orderedEvents: Array<string> = []
        const layer = makeWorkflowTestLayer(spy, {
          completeUnit: ({ unitId, attempt }) => {
            orderedEvents.push(`unit:${unitId}`)
            return makeCompletedOutcome(unitId, attempt)
          },
          mergeWave: (input) => {
            orderedEvents.push(`merge:${input.waveIndex}`)
            return { _tag: "Merged", mergedBranches: input.branches }
          },
          projectWorkflowRun: (input, callIndex) => {
            orderedEvents.push(`projectWave:${callIndex - 1}`)
            return Effect.succeed(
              WorkflowProjectionOutcome.cases.Projected.make({
                runId: input.runId,
                branch: OmnigraphBranchName.make("impl/wave-proj-011"),
                projectionStatus: "fresh",
                commitId: null,
                counts: {
                  runsUpserted: NonNegativeCount.make(1),
                  unitsUpserted: NonNegativeCount.make(2),
                  attemptsUpserted: NonNegativeCount.make(2),
                  edgesUpserted: NonNegativeCount.make(2),
                },
              }),
            )
          },
        })

        yield* Effect.gen(function* () {
          const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })
          yield* Deferred.await(waitLlm)

          expect(orderedEvents).toEqual([
            "unit:slice-w0",
            "merge:0",
            "projectWave:0",
            "unit:slice-w1",
            "merge:1",
            "projectWave:1",
          ])
          expect(spy.waveProjectCalls).toEqual([
            {
              runId: plan.runId,
              targetBranch: WorkflowProjectionTargetBranch.cases.ActiveTaskImplBranch.make({}),
              trigger: "wave",
              repoRoot: CANONICAL_ROOT,
            },
            {
              runId: plan.runId,
              targetBranch: WorkflowProjectionTargetBranch.cases.ActiveTaskImplBranch.make({}),
              trigger: "wave",
              repoRoot: CANONICAL_ROOT,
            },
          ])

          yield* DurableDeferred.succeed(LlmPhaseDone, {
            token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
              workflow: HarnessTaskWorkflow,
              executionId,
            }),
            value: makeLlmReceipt(),
          })

          const receipt = yield* HarnessTaskWorkflow.execute({ plan })
          expect(receipt.completedUnits).toEqual([w0.unitId, w1.unitId])
          expect(spy.waveProjectCalls).toHaveLength(2)

          const replayed = yield* HarnessTaskWorkflow.execute({ plan })
          expect(replayed).toEqual(receipt)
          expect(spy.waveProjectCalls).toHaveLength(2)
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "RFC-0013 REQ-4.5: HarnessTaskWorkflow completes cleanly when WorkflowProjector.project returns Stale or defects",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const waitLlm = yield* Deferred.make<void>()
        spy.onWaitLlm = waitLlm

        const p0 = makePackageUnit("pkg-w0", "@harness/w0", ["libs/w0/src/index.ts"], 0)
        const p1 = makePackageUnit("pkg-w1", "@harness/w1", ["libs/w1/src/index.ts"], 1, ["pkg-w0"])
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-wave-nonfatal-012"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [p0, p1],
          sharedStepPaths: [],
        }

        const layer = makeWorkflowTestLayer(spy, {
          projectWorkflowRun: (input, callIndex) =>
            callIndex === 1
              ? Effect.succeed(
                  WorkflowProjectionOutcome.cases.Stale.make({
                    runId: input.runId,
                    branch: OmnigraphBranchName.make("impl/stale"),
                    projectionStatus: "stale",
                    reason: WorkflowStoreFailureReason.make("omnigraph busy"),
                  }),
                )
              : Effect.die(new Error("omnigraph connection refused")),
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
          expect(receipt.completedUnits).toEqual([p0.unitId, p1.unitId])
          expect(spy.waveProjectCalls).toHaveLength(2)
          expect(spy.removeCalls).toHaveLength(0)
          expect(spy.runs.get(plan.runId)?.state).toBe("completed")
        }).pipe(Effect.provide(layer))
      }),
    20_000,
  )

  it.live(
    "RFC-0013 REQ-4.5: pure fiber interrupt inside WorkflowProjector.project propagates instead of being swallowed",
    () =>
      Effect.gen(function* () {
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-wave-interrupt-013"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [makePackageUnit("pkg-int", "@harness/int", ["libs/int/src/index.ts"], 0)],
          sharedStepPaths: [],
        }

        const activity = projectWaveToHarnessActivity(plan, WaveIndex.make(0), CANONICAL_ROOT)
        const instance = WorkflowEngine.WorkflowInstance.initial(
          HarnessTaskWorkflow,
          "exec-wave-interrupt-013",
        )
        // Mark suspended so Activity.make's retryOnInterrupt surfaces the interrupt immediately
        // instead of sleeping through 10 backoff retries, proving our catchCause did not swallow it.
        instance.suspended = true

        let calls = 0
        const projectorLayer = makeWorkflowProjectorTestLayer(() => {
          calls += 1
          return Effect.interrupt
        })

        const exit = yield* activity.execute.pipe(
          Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
          Effect.provide(Layer.merge(projectorLayer, WorkflowEngine.layerMemory)),
          Effect.exit,
        )

        expect(calls).toBe(1)
        match(exit)
          .with({ _tag: "Success" }, () => {
            expect.unreachable(
              "Expected pure interrupt from WorkflowProjector.project to propagate",
            )
          })
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(isPureInterruptCause(cause)).toBe(true)
          })
          .exhaustive()

        // Composite Fail/Die + Interrupt cause is NOT pure interrupt, so it degrades to Stale.
        const compositeLayer = makeWorkflowProjectorTestLayer(() =>
          Effect.failCause(Cause.combine(Cause.die(new Error("boom")), Cause.interrupt(0))),
        )

        const compositeOutcome = yield* activity.execute.pipe(
          Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
          Effect.provide(Layer.merge(compositeLayer, WorkflowEngine.layerMemory)),
        )
        expect(compositeOutcome._tag).toBe("Stale")
      }),
    20_000,
  )

  it.live(
    "SPEC-0038 REQ-4.1 TraceTest: Harness.executeTaskWorkflow emits budgeted Harness.executeTaskWorkflow and WorkflowProjector.project spans",
    () =>
      Effect.gen(function* () {
        const spy = makeSpyState()
        const waitLlm = yield* Deferred.make<void>()
        spy.onWaitLlm = waitLlm

        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-wf6-trace-budget-014"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner: "claude-code",
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [makePackageUnit("pkg-trace", "@harness/trace", ["libs/trace/src/index.ts"], 0)],
          sharedStepPaths: [],
        }

        const layer = makeWorkflowTestLayer(spy, {
          completeUnit: ({ unitId, attempt }) => makeCompletedOutcome(unitId, attempt),
          projectWorkflowRun: (input) =>
            Effect.succeed(
              WorkflowProjectionOutcome.cases.Projected.make({
                runId: input.runId,
                branch: OmnigraphBranchName.make("impl/trace-014"),
                projectionStatus: "fresh",
                commitId: null,
                counts: {
                  runsUpserted: NonNegativeCount.make(1),
                  unitsUpserted: NonNegativeCount.make(1),
                  attemptsUpserted: NonNegativeCount.make(1),
                  edgesUpserted: NonNegativeCount.make(1),
                },
              }),
            ).pipe(Effect.withSpan("WorkflowProjector.project")),
        })

        const { result: receipt, spans } = yield* runWithTestTracer(
          "HarnessTaskWorkflow.SPEC-0038.REQ-4.1",
          Effect.gen(function* () {
            const executionId = yield* HarnessTaskWorkflow.execute({ plan }, { discard: true })
            yield* Deferred.await(waitLlm)
            yield* DurableDeferred.succeed(LlmPhaseDone, {
              token: DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
                workflow: HarnessTaskWorkflow,
                executionId,
              }),
              value: makeLlmReceipt(),
            })
            return yield* HarnessTaskWorkflow.execute({ plan })
          }).pipe(Effect.provide(layer)),
          emptyFnIndex,
        )

        expect(receipt.completedUnits).toEqual([WorkUnitId.make("pkg-trace")])
        const spanNames = spans.map((s) => s.name)
        expect(spanNames).toContain("Harness.executeTaskWorkflow")
        expect(spanNames).toContain("WorkflowProjector.project")

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
        const violations = yield* decideSpanBudgets({ spans: spanSamples })
        expect(violations).toEqual([])
      }),
    20_000,
  )
})
