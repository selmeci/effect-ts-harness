import { Cause, Clock, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { DurableDeferred } from "effect/workflow"
import { match } from "ts-pattern"
import { describe, expect, it } from "@effect/vitest"
import {
  AttemptNumber,
  CompiledPlan as CompiledPlanSchema,
  type CompiledPlan,
  EscalationDecision,
  EscalationOrdinal,
  EscalationResolution,
  GateExitCode,
  MergeSliceWaveOutcome,
  MessageKey,
  OwnedRelPath,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  UnitOutcome,
  UnitRejection,
  WorkUnitId,
  type WorkflowAttemptKey,
  type WorkflowAttemptRecord,
  WorkflowExecutionId,
  WorkflowRunId as WorkflowRunIdSchema,
  type WorkflowRunState,
  WorkflowStoreOperation,
  type WorkflowUnitStatus,
  encodeSeqKey,
} from "@harness/contract"
import {
  HarnessTaskWorkflow,
  executionIdOf,
  makeUnitCompletionDeferred,
  makeUnitEscalationDeferred,
} from "@harness/gates"
import { UnitVerifier, WorkflowReadModelQuery, WorkflowWorktreePort } from "@harness/service"
import {
  reconstructJournalViews,
  replayActivityMessage,
} from "../src/workflow/read-model-rebuild-journal.js"
import { WorkflowTimestampMs } from "@harness/contract"
import {
  CANONICAL_ROOT,
  BASE_SHA,
  PLAN_SHA,
  TREE_HASH,
  STAMP_A,
  STAMP_B,
  makeInMemoryWorkflowOmnigraphClient,
  makePackageUnit,
  makeSliceUnit,
  snapshotAndCompareViews,
  makeDiffStack,
  completeLlmPhase,
  waitForWaitingRun,
} from "./helpers/workflow-replay-fixture.js"

describe("SPEC-0026 REQ-3.1: Differential live HarnessTaskWorkflow projections vs rebuildWorkflowReadModelViews", () => {
  it.live(
    "matches exactly across multi-wave + sharedStep completion and paused LlmPhaseDone waiting state",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-diff-multiwave"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [
            makePackageUnit("u-w0", "@harness/alpha", ["libs/alpha/src"], 0),
            makePackageUnit("u-w1", "@harness/beta", ["libs/beta/src"], 1, ["u-w0"]),
          ],
          sharedStepPaths: [OwnedRelPath.make("libs/shared/src")],
        }
        const executionId = yield* executionIdOf(plan)

        const stack = makeDiffStack(client, {
          worktreeLayer: Layer.succeed(WorkflowWorktreePort, {
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
          verifierLayer: Layer.succeed(UnitVerifier, {
            completeUnit: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: input.unit.unitId,
                  attempt: input.attempt,
                  changedPaths: [...input.unit.ownedRelPaths],
                  packageStampHash: STAMP_A,
                }),
              ),
            completeSharedStep: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: SHARED_STEP_UNIT_ID,
                  attempt: input.attempt,
                  changedPaths: [...input.sharedStepPaths],
                  packageStampHash: STAMP_B,
                }),
              ),
          }),
        })

        yield* Effect.gen(function* () {
          const runFiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(Effect.forkChild)

          for (const uid of [
            WorkUnitId.make("u-w0"),
            WorkUnitId.make("u-w1"),
            SHARED_STEP_UNIT_ID,
          ]) {
            const def = makeUnitCompletionDeferred(
              uid,
              AttemptNumber.make(1),
              EscalationOrdinal.make(1),
            )
            const tok = DurableDeferred.tokenFromExecutionId(def, {
              workflow: HarnessTaskWorkflow,
              executionId,
            })
            yield* DurableDeferred.succeed(def, {
              token: tok,
              value: UnitOutcome.cases.Completed.make({
                unitId: uid,
                attempt: AttemptNumber.make(1),
                changedPaths: [OwnedRelPath.make("libs/demo/src")],
                packageStampHash: STAMP_A,
              }),
            })
          }

          // Trace 3: Pause while waiting on LlmPhaseDone -> compare live waiting state vs rebuilt waiting state
          yield* waitForWaitingRun(plan.runId)
          const waitingLive = yield* snapshotAndCompareViews(client, plan.runId)
          expect(waitingLive.state).toBe("waiting")

          // Complete LlmPhaseDone -> finish run -> compare final completed live views vs rebuilt views (Trace 1)
          yield* completeLlmPhase(executionId)
          const receipt = yield* Fiber.join(runFiber)
          expect(receipt.runId).toBe(plan.runId)

          const completedLive = yield* snapshotAndCompareViews(client, plan.runId)
          expect(completedLive.state).toBe("completed")
        }).pipe(Effect.provide(stack))
      }),
    // 20_000ms: executes multi-wave Effect Cluster Sharding workflow run, LlmPhaseDone pause, and journal replay comparison.
    20_000,
  )

  it.live(
    "matches exactly across L1 MergeSliceWave conflict -> escalation retry -> clean merge completion",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const unitId = WorkUnitId.make("slice-conflict")
        const branch = SliceBranchName.make("slice/diff-conflict")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-diff-merge-conflict"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makeSliceUnit(unitId, branch, ["libs/conflict/src"], 0)],
          sharedStepPaths: [],
        }
        const executionId = yield* executionIdOf(plan)
        let mergeCall = 0
        const mergeEscalated = Deferred.makeUnsafe<void>()

        const stack = makeDiffStack(client, {
          worktreeLayer: Layer.succeed(WorkflowWorktreePort, {
            provisionWorktrees: (p) =>
              Effect.succeed({
                runId: p.runId,
                canonicalRepoRoot: CANONICAL_ROOT,
                entries: p.units.map((u) => ({
                  unitId: u.unitId,
                  cwd: CANONICAL_ROOT,
                  worktreeKind: "linked" as const,
                  branch,
                })),
              }),
            removeWorktreeCheckouts: () => Effect.void,
            mergeSliceWave: (input) =>
              Effect.sync(() => {
                mergeCall += 1
                if (mergeCall === 1) {
                  return MergeSliceWaveOutcome.cases.Conflict.make({
                    branch,
                  })
                }
                return MergeSliceWaveOutcome.cases.Merged.make({ mergedBranches: input.branches })
              }),
          }),
          verifierLayer: Layer.succeed(UnitVerifier, {
            completeUnit: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: input.unit.unitId,
                  attempt: input.attempt,
                  changedPaths: [...input.unit.ownedRelPaths],
                  packageStampHash: STAMP_A,
                }),
              ),
            completeSharedStep: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: SHARED_STEP_UNIT_ID,
                  attempt: input.attempt,
                  changedPaths: [...input.sharedStepPaths],
                  packageStampHash: STAMP_B,
                }),
              ),
          }),
        })

        yield* Effect.gen(function* () {
          const query = yield* WorkflowReadModelQuery
          const runFiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(Effect.forkChild)

          const compDef = makeUnitCompletionDeferred(
            unitId,
            AttemptNumber.make(1),
            EscalationOrdinal.make(1),
          )
          const compTok = DurableDeferred.tokenFromExecutionId(compDef, {
            workflow: HarnessTaskWorkflow,
            executionId,
          })
          yield* DurableDeferred.succeed(compDef, {
            token: compTok,
            value: UnitOutcome.cases.Completed.make({
              unitId,
              attempt: AttemptNumber.make(1),
              changedPaths: [OwnedRelPath.make("libs/conflict/src")],
              packageStampHash: STAMP_A,
            }),
          })

          // Wait until MergeSliceWave conflict sets unit status to 'escalated' & run state to 'waiting'
          for (let i = 0; i < 150; i += 1) {
            const units = yield* query.listUnits(plan.runId)
            const runOpt = yield* query.getRun(plan.runId)
            const ready =
              units.some((u) => u.unitId === unitId && u.status === "escalated") &&
              match(runOpt)
                .with({ _tag: "Some" }, ({ value }) => value.state === "waiting")
                .with({ _tag: "None" }, () => false)
                .exhaustive()
            if (ready) {
              yield* Deferred.succeed(mergeEscalated, void 0)
              break
            }
            yield* Effect.sleep("25 millis")
          }
          yield* Deferred.await(mergeEscalated)

          // Snapshot live waiting conflict state vs rebuilt
          yield* snapshotAndCompareViews(client, plan.runId)

          // Resolve merge escalation with 'retry'
          const escDef = makeUnitEscalationDeferred(unitId, EscalationOrdinal.make(1))
          const escTok = DurableDeferred.tokenFromExecutionId(escDef, {
            workflow: HarnessTaskWorkflow,
            executionId,
          })
          yield* DurableDeferred.succeed(escDef, {
            token: escTok,
            value: EscalationResolution.make({ decision: EscalationDecision.make("retry") }),
          })

          yield* waitForWaitingRun(plan.runId)
          yield* completeLlmPhase(executionId)
          yield* Fiber.join(runFiber)

          const finalRun = yield* snapshotAndCompareViews(client, plan.runId)
          expect(finalRun.state).toBe("completed")
        }).pipe(Effect.provide(stack))
      }),
    // 20_000ms: drives L1 merge-conflict escalation, retry resolution, and Effect Cluster journal replay comparison.
    20_000,
  )

  it.live(
    "matches exactly on operator abort after 3 rejections (TaskRunAbortedError)",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const unitId = WorkUnitId.make("u-abort")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-diff-abort"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makePackageUnit(unitId, "@harness/abort", ["libs/abort/src"], 0)],
          sharedStepPaths: [],
        }
        const executionId = yield* executionIdOf(plan)

        const stack = makeDiffStack(client, {
          worktreeLayer: Layer.succeed(WorkflowWorktreePort, {
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
          verifierLayer: Layer.succeed(UnitVerifier, {
            completeUnit: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Rejected.make({
                  unitId: input.unit.unitId,
                  attempt: input.attempt,
                  rejection: UnitRejection.cases.PackageVerifyFailed.make({
                    exitCode: GateExitCode.make(1),
                    failureKind: "non-zero-exit",
                  }),
                }),
              ),
            completeSharedStep: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: SHARED_STEP_UNIT_ID,
                  attempt: input.attempt,
                  changedPaths: [...input.sharedStepPaths],
                  packageStampHash: STAMP_B,
                }),
              ),
          }),
        })

        yield* Effect.gen(function* () {
          const runFiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(Effect.forkChild)

          for (const attemptNum of [1, 2, 3] as const) {
            const def = makeUnitCompletionDeferred(
              unitId,
              AttemptNumber.make(attemptNum),
              EscalationOrdinal.make(1),
            )
            const tok = DurableDeferred.tokenFromExecutionId(def, {
              workflow: HarnessTaskWorkflow,
              executionId,
            })
            yield* DurableDeferred.succeed(def, {
              token: tok,
              value: UnitOutcome.cases.Rejected.make({
                unitId,
                attempt: AttemptNumber.make(attemptNum),
                rejection: UnitRejection.cases.PackageVerifyFailed.make({
                  exitCode: GateExitCode.make(1),
                  failureKind: "non-zero-exit",
                }),
              }),
            })
          }

          yield* waitForWaitingRun(plan.runId)
          const escDef = makeUnitEscalationDeferred(unitId, EscalationOrdinal.make(1))
          const escTok = DurableDeferred.tokenFromExecutionId(escDef, {
            workflow: HarnessTaskWorkflow,
            executionId,
          })
          yield* DurableDeferred.succeed(escDef, {
            token: escTok,
            value: EscalationResolution.make({ decision: EscalationDecision.make("abort") }),
          })

          const exit = yield* Fiber.await(runFiber)
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              match(Cause.findErrorOption(cause))
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value._tag).toBe("TaskRunAbortedError")
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("Expected TaskRunAbortedError in failure cause"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () =>
              expect.unreachable("Expected aborted workflow failure"),
            )
            .exhaustive()

          const abortedRun = yield* snapshotAndCompareViews(client, plan.runId)
          expect(abortedRun.state).toBe("aborted")
        }).pipe(Effect.provide(stack))
      }),
    // 20_000ms: runs 3 verification rejection attempts, escalation abort, and full journal replay comparison.
    20_000,
  )

  it.effect(
    "directly exercises replayActivityMessage across dispatch, escalation, retry, and completion transitions",
    () =>
      Effect.gen(function* () {
        const unitId = WorkUnitId.make("u-direct")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-replay-direct"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makePackageUnit(unitId, "@harness/direct", ["libs/direct/src"], 0)],
          sharedStepPaths: [],
        }
        const now = yield* Clock.currentTimeMillis
        const unitStatusMap = new Map<WorkUnitId, WorkflowUnitStatus>([[unitId, "pending"]])
        const attemptsMap = new Map<WorkflowAttemptKey, WorkflowAttemptRecord>()
        const mergeConflictUnits = new Set<WorkUnitId>()
        let runState: WorkflowRunState = "running"

        const step = (activityName: string, actReplyStr?: string) =>
          replayActivityMessage({
            operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
            plan,
            activityName,
            actReplyStr,
            hasTerminalRunReply: false,
            nowValue: WorkflowTimestampMs.make(Math.floor(now)),
            unitStatusMap,
            attemptsMap,
            mergeConflictUnits,
            getRunState: () => runState,
            setRunState: (next) => {
              runState = next
            },
          })

        yield* step(`ProjectUnitDispatched/${unitId}/1`)
        expect(unitStatusMap.get(unitId)).toBe("dispatched")

        yield* step("ProjectRunCompleted")
        expect(runState).toBe("completed")

        // Retry transition from escalated -> dispatched and waiting -> running
        unitStatusMap.set(unitId, "escalated")
        runState = "waiting"
        yield* step(`ProjectUnitEscalationRetried/${unitId}/1`)
        expect(unitStatusMap.get(unitId)).toBe("dispatched")
        expect(runState).toBe("running")

        // Non-waiting activity leaves runState='running', while ProjectRunWaitingLlmPhase moves running -> waiting
        yield* step("RouteReview")
        expect(runState).toBe("running")

        yield* step("ProjectRunWaitingLlmPhase")
        expect(runState).toBe("waiting")

        // VerifyUnit promotes pending -> dispatched without clobbering escalated
        unitStatusMap.set(unitId, "pending")
        yield* step(`VerifyUnit/${unitId}/1`)
        expect(unitStatusMap.get(unitId)).toBe("dispatched")

        unitStatusMap.set(unitId, "escalated")
        yield* step(`VerifyUnit/${unitId}/2`)
        expect(unitStatusMap.get(unitId)).toBe("escalated")

        // Non-undefined Failure actReply transitions runState to aborted
        runState = "running"
        yield* step("RouteReview", JSON.stringify({ _tag: "Failure" }))
        expect(runState).toBe("aborted")
      }),
  )

  it.effect(
    "replayActivityMessage MergeSliceWave Merged resolves only escalated slices while preserving pending slices",
    () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        // MergeSliceWave Merged resolves only escalated slices while preserving pending slices
        const sliceAlpha = WorkUnitId.make("slice-alpha")
        const sliceBeta = WorkUnitId.make("slice-beta")
        const slicePlan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-replay-merge-direct"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [
            makeSliceUnit(sliceAlpha, "slice/direct-alpha", ["libs/alpha/src"], 0),
            makeSliceUnit(sliceBeta, "slice/direct-beta", ["libs/beta/src"], 0),
          ],
          sharedStepPaths: [],
        }
        const sliceStatusMap = new Map<WorkUnitId, WorkflowUnitStatus>([
          [sliceAlpha, "escalated"],
          [sliceBeta, "pending"],
        ])
        let sliceRunState: WorkflowRunState = "waiting"
        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan: slicePlan,
          activityName: "MergeSliceWave/0/r2",
          actReplyStr: JSON.stringify({
            _tag: "Success",
            value: {
              _tag: "Complete",
              exit: {
                _tag: "Success",
                value: {
                  _tag: "Merged",
                  mergedBranches: [
                    "slice/direct-alpha",
                    "slice/direct-beta",
                    "slice/unknown-branch",
                  ],
                },
              },
            },
          }),
          hasTerminalRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap: sliceStatusMap,
          attemptsMap: new Map<WorkflowAttemptKey, WorkflowAttemptRecord>(),
          mergeConflictUnits: new Set<WorkUnitId>(),
          getRunState: () => sliceRunState,
          setRunState: (next) => {
            sliceRunState = next
          },
        })
        expect(sliceStatusMap.get(sliceAlpha)).toBe("completed")
        expect(sliceStatusMap.get(sliceBeta)).toBe("pending")
      }),
  )

  it.effect(
    "reconstructJournalViews transitions waiting -> running on llm-phase-done, escalation retry, and MergeRetried without a run exit reply",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const encodeRunPayload = Schema.encodeEffect(
          Schema.fromJsonString(Schema.Struct({ plan: CompiledPlanSchema })),
        )
        let rawId = 500000000000000001n
        const insertJournalMsg = (
          executionId: WorkflowExecutionId,
          tag: "run" | "activity" | "deferred",
          payload: string,
        ) =>
          Effect.promise(async () => {
            const idNum = rawId
            rawId += 1n
            const messageKey = MessageKey.make(idNum.toString())
            const seqRes = encodeSeqKey(messageKey)
            const seqKey = match(seqRes)
              .with({ _tag: "Success" }, ({ success }) => success)
              .with({ _tag: "Failure" }, ({ failure }) => expect.unreachable(failure))
              .exhaustive()
            await client.queries.invoke("wf_insert_request_message", {
              branch: "main",
              expectMutation: true,
              params: {
                messageKey,
                seqKey,
                primaryKeyHash: null,
                shardId: "default:0",
                entityType: "Workflow/HarnessTaskWorkflow",
                entityId: executionId,
                tag,
                payload,
                headers: "{}",
                traceId: null,
                spanId: null,
                sampled: null,
                requestId: messageKey,
                deliverAtMs: null,
              },
            })
          })

        const unitId = WorkUnitId.make("slice-jrnl")
        const makeEpicPlan = (runIdStr: string): CompiledPlan => ({
          runId: WorkflowRunIdSchema.make(runIdStr),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makeSliceUnit(unitId, "slice/jrnl-branch", ["libs/jrnl/src"], 0)],
          sharedStepPaths: [],
        })

        // Run A: ProjectRunWaitingLlmPhase -> llm-phase-done deferred (no run reply) -> running
        const planLlm = makeEpicPlan("run-jrnl-llm-resume")
        const execLlm = yield* executionIdOf(planLlm)
        yield* insertJournalMsg(execLlm, "run", yield* encodeRunPayload({ plan: planLlm }))
        yield* insertJournalMsg(
          execLlm,
          "activity",
          JSON.stringify({ name: "ProjectRunWaitingLlmPhase" }),
        )
        yield* insertJournalMsg(
          execLlm,
          "deferred",
          JSON.stringify({
            name: "llm-phase-done",
            exit: {
              _tag: "Success",
              value: { frictionLogCleared: "cleared", workspaceHash: TREE_HASH },
            },
          }),
        )

        // Run B: ProjectUnitEscalated -> escalation retry deferred (no run reply) -> running
        const planEsc = makeEpicPlan("run-jrnl-esc-resume")
        const execEsc = yield* executionIdOf(planEsc)
        yield* insertJournalMsg(execEsc, "run", yield* encodeRunPayload({ plan: planEsc }))
        yield* insertJournalMsg(
          execEsc,
          "activity",
          JSON.stringify({ name: `ProjectUnitEscalated/${unitId}/1` }),
        )
        yield* insertJournalMsg(
          execEsc,
          "deferred",
          JSON.stringify({
            name: `escalation/${unitId}/1`,
            exit: { _tag: "Success", value: { decision: "retry" } },
          }),
        )

        // Run C: ProjectWaveMergeEscalated -> ProjectWaveMergeRetried (no run reply) -> running
        const planMerge = makeEpicPlan("run-jrnl-merge-resume")
        const execMerge = yield* executionIdOf(planMerge)
        yield* insertJournalMsg(execMerge, "run", yield* encodeRunPayload({ plan: planMerge }))
        yield* insertJournalMsg(
          execMerge,
          "activity",
          JSON.stringify({ name: "ProjectWaveMergeEscalated/0/1" }),
        )
        yield* insertJournalMsg(
          execMerge,
          "activity",
          JSON.stringify({ name: "ProjectWaveMergeRetried/0/1" }),
        )

        const now = yield* Clock.currentTimeMillis
        const bundles = yield* reconstructJournalViews(
          CANONICAL_ROOT,
          WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          WorkflowTimestampMs.make(Math.floor(now)),
          { client },
        )

        const byRun = new Map(bundles.map((b) => [b.run.runId, b] as const))
        expect(byRun.get(planLlm.runId)?.run.state).toBe("running")
        expect(byRun.get(planEsc.runId)?.run.state).toBe("running")
        expect(byRun.get(planEsc.runId)?.units[0]?.status).toBe("dispatched")
        expect(byRun.get(planMerge.runId)?.run.state).toBe("running")
      }),
  )
})
