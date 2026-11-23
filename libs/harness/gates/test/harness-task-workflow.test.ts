import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber } from "effect"
import { DurableDeferred } from "effect/workflow"
import { match } from "ts-pattern"
import {
  AgentFailureReason,
  AttemptNumber,
  type CompiledPlan,
  EscalationOrdinal,
  GateExitCode,
  MaxConcurrency,
  OwnedRelPath,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  TaskRunAbortedError,
  WorkUnitId,
  WorkflowRunId as WorkflowRunIdSchema,
} from "@harness/contract"
import {
  HarnessTaskWorkflow,
  LlmPhaseDone,
  makeUnitCompletionDeferred,
  makeUnitEscalationDeferred,
} from "../src/index.js"
import {
  CANONICAL_ROOT,
  BASE_SHA,
  PLAN_SHA,
  makeSliceUnit,
  makePackageUnit,
  makeLlmReceipt,
  makeCompletedOutcome,
  makeSpyState,
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
})
