import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber } from "effect"
import { DurableDeferred, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  AttemptNumber,
  type CompiledPlan,
  EscalationOrdinal,
  GateExitCode,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  MaxConcurrency,
  OwnedRelPath,
  SliceBranchName,
  WorkUnitId,
  WorkflowExecutionId,
  WorkflowRunId as WorkflowRunIdSchema,
  WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  type WorktreeProvisionReceipt,
  WorkspaceFsError,
  WriterLeaseHeldError,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
} from "@harness/contract"
import { runWithTestTracer } from "@harness/ingest"
import { executionIdOf } from "../src/harness-task-workflow.js"
import { projectUnitOutcome, resolveUnitCwd } from "../src/harness-task-workflow-projections.js"
import {
  HarnessTaskWorkflow,
  LlmPhaseDone,
  type SpanSample,
  decideSpanBudgets,
  driveSharedStep,
  driveWorkUnit,
  makeUnitEscalationDeferred,
} from "../src/index.js"
import {
  emptyFnIndex,
  CANONICAL_ROOT,
  BASE_SHA,
  PLAN_SHA,
  STAMP_HASH,
  makeSliceUnit,
  makePackageUnit,
  makeLlmReceipt,
  makeCompletedOutcome,
  makeSpyState,
  makeWorkflowTestLayer,
} from "./helpers/harness-task-workflow-fixture.js"

describe("HarnessTaskWorkflow recovery, retries & canonical keys", () => {
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
