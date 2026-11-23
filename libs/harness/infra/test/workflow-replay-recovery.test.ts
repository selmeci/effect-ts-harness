import { Clock, Effect, Fiber, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "@effect/vitest"
import {
  AgentFailureReason,
  AttemptNumber,
  CompiledPlan as CompiledPlanSchema,
  type CompiledPlan,
  EscalationOrdinal,
  MaxConcurrency,
  MessageKey,
  RunnerId,
  SHARED_STEP_UNIT_ID,
  UnitAgentDispatchResult,
  UnitOutcome,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkUnitId,
  type WorkflowAttemptKey,
  type WorkflowAttemptRecord,
  WorkflowExecutionId,
  WorkflowRunId as WorkflowRunIdSchema,
  type WorkflowRunState,
  WorkflowStoreOperation,
  type WorkflowUnitStatus,
  encodeSeqKey,
  makeWorkflowAttemptKey,
} from "@harness/contract"
import { HarnessTaskWorkflow, executionIdOf } from "@harness/gates"
import {
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowReadModelQuery,
  WorkflowWorktreePort,
} from "@harness/service"
import { makeHarnessWorkflowEngineLayer } from "../src/workflow-engine-live.js"
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
  snapshotAndCompareViews,
  makeDiffStack,
  completeLlmPhase,
  waitForWaitingRun,
} from "./helpers/workflow-replay-fixture.js"

describe("SPEC-0026 REQ-3.1: Differential replay recovery, suspended & error edges", () => {
  it.effect(
    "SPEC-0027 REQ-1.3: replayActivityMessage and reconstructJournalViews fail closed on unrecognized activity and deferred names",
    () =>
      Effect.gen(function* () {
        const unitId = WorkUnitId.make("u-fail-proto")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-fail-proto-1"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makePackageUnit(unitId, "@harness/fail-proto", ["libs/fp/src"], 0)],
          sharedStepPaths: [],
        }
        const now = yield* Clock.currentTimeMillis
        const unitStatusMap = new Map<WorkUnitId, WorkflowUnitStatus>([[unitId, "pending"]])
        const attemptsMap = new Map<WorkflowAttemptKey, WorkflowAttemptRecord>()
        const mergeConflictUnits = new Set<WorkUnitId>()
        let runState: WorkflowRunState = "running"

        const badActErr = yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan,
          activityName: "UnrecognizedActivity/u-fail-proto/1",
          actReplyStr: undefined,
          hasTerminalRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap,
          attemptsMap,
          mergeConflictUnits,
          getRunState: () => runState,
          setRunState: (next) => {
            runState = next
          },
        }).pipe(Effect.flip)
        expect(badActErr._tag).toBe("WorkflowStoreUnavailableError")

        const client = makeInMemoryWorkflowOmnigraphClient()
        const encodeRunPayload = Schema.encodeEffect(
          Schema.fromJsonString(Schema.Struct({ plan: CompiledPlanSchema })),
        )
        const execId = yield* executionIdOf(plan)
        let rawId = 600000000000000001n
        const pushMsg = (tag: "run" | "deferred", payload: string) =>
          Effect.promise(async () => {
            const messageKey = MessageKey.make(rawId.toString())
            rawId += 1n
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
                entityId: execId,
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

        yield* pushMsg("run", yield* encodeRunPayload({ plan }))
        yield* pushMsg(
          "deferred",
          JSON.stringify({
            name: "unit/u-fail-proto/1/r1",
            exit: { _tag: "Success", value: {} },
          }),
        )

        const badDefErr = yield* reconstructJournalViews(
          CANONICAL_ROOT,
          WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          WorkflowTimestampMs.make(Math.floor(now)),
          { client },
        ).pipe(Effect.flip)
        expect(badDefErr._tag).toBe("WorkflowStoreUnavailableError")
      }),
  )

  it.live(
    "F-24: matches live vs rebuilt views across Automatic mode DispatchUnitAgent failure -> completion and runner propagation",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const unitId = WorkUnitId.make("u-auto-agent-fail")
        const runner = RunnerId.make("claude-code")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-diff-auto-dispatch-fail"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner,
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [makePackageUnit(unitId, "@harness/auto", ["libs/auto/src"], 0)],
          sharedStepPaths: [],
        }
        const executionId = yield* executionIdOf(plan)
        let dispatchAttempt = 0

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
          dispatcherLayer: Layer.succeed(UnitAgentDispatcher, {
            runnerKind: "live" as const,
            dispatchUnit: () =>
              Effect.sync(() => {
                dispatchAttempt += 1
                if (dispatchAttempt === 1) {
                  return UnitAgentDispatchResult.cases.Failed.make({
                    reason: AgentFailureReason.make("agent crashed on attempt 1"),
                  })
                }
                return UnitAgentDispatchResult.cases.Completed.make({})
              }),
          }),
        })

        yield* Effect.gen(function* () {
          const query = yield* WorkflowReadModelQuery
          const runFiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(Effect.forkChild)
          yield* waitForWaitingRun(plan.runId)
          yield* completeLlmPhase(executionId)
          const receipt = yield* Fiber.join(runFiber)
          expect(receipt.runId).toBe(plan.runId)

          const liveRun = yield* snapshotAndCompareViews(client, plan.runId)
          expect(liveRun.state).toBe("completed")

          const rebuiltAttempts = yield* query.listAttempts(plan.runId)
          expect(rebuiltAttempts).toHaveLength(2)
          expect(rebuiltAttempts[0]?.verdict).toBe("rejected")
          expect(rebuiltAttempts[0]?.runner).toBe(runner)
          expect(rebuiltAttempts[1]?.verdict).toBe("completed")
          expect(rebuiltAttempts[1]?.runner).toBe(runner)
        }).pipe(Effect.provide(stack))
      }),
    // 20_000ms: executes Automatic-mode agent failure, retry completion, and Effect Cluster journal replay comparison.
    20_000,
  )

  it.effect(
    "F-24: reconstructJournalViews transitions waiting -> running on Suspended run reply, records ProjectUnitDispatched & DispatchUnitAgent attempts with runner",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const encodeRunPayload = Schema.encodeEffect(
          Schema.fromJsonString(Schema.Struct({ plan: CompiledPlanSchema })),
        )
        let rawId = 700000000000000001n
        let rawReplyId = 800000000000000001n
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
            return messageKey
          })
        const insertWithExit = (requestId: MessageKey, payload: unknown) =>
          Effect.promise(async () => {
            const idNum = rawReplyId
            rawReplyId += 1n
            const replyKey = String(idNum)
            const seqRes = encodeSeqKey(idNum)
            const seqKey = match(seqRes)
              .with({ _tag: "Success" }, ({ success }) => success)
              .with({ _tag: "Failure" }, ({ failure }) => expect.unreachable(failure))
              .exhaustive()
            await client.queries.invoke("wf_save_reply_exit", {
              branch: "main",
              expectMutation: true,
              params: {
                replyKey,
                seqKey,
                requestId,
                payload: JSON.stringify(payload),
              },
            })
          })

        const unitId = WorkUnitId.make("u-susp")
        const runner = RunnerId.make("antigravity")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-susp-resume-1"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner,
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [makePackageUnit(unitId, "@harness/susp", ["libs/susp/src"], 0)],
          sharedStepPaths: [],
        }
        const execId = yield* executionIdOf(plan)
        const runMsgId = yield* insertJournalMsg(execId, "run", yield* encodeRunPayload({ plan }))
        yield* insertWithExit(runMsgId, { _tag: "Success", value: { _tag: "Suspended" } })
        yield* insertJournalMsg(
          execId,
          "activity",
          JSON.stringify({ name: `ProjectUnitDispatched/${unitId}/1` }),
        )
        const dispatchFailMsgId = yield* insertJournalMsg(
          execId,
          "activity",
          JSON.stringify({ name: `DispatchUnitAgent/${unitId}/1` }),
        )
        yield* insertWithExit(dispatchFailMsgId, {
          _tag: "Success",
          value: {
            _tag: "Complete",
            exit: {
              _tag: "Success",
              value: { _tag: "Failed", reason: "agent exit 1" },
            },
          },
        })
        yield* insertJournalMsg(
          execId,
          "activity",
          JSON.stringify({ name: `ProjectUnitDispatched/${unitId}/2` }),
        )
        yield* insertJournalMsg(
          execId,
          "activity",
          JSON.stringify({ name: "ProjectRunWaitingLlmPhase" }),
        )
        yield* insertJournalMsg(
          execId,
          "deferred",
          JSON.stringify({
            name: "llm-phase-done",
            exit: {
              _tag: "Success",
              value: { frictionLogCleared: "cleared", workspaceHash: TREE_HASH },
            },
          }),
        )

        const now = yield* Clock.currentTimeMillis
        const bundles = yield* reconstructJournalViews(
          CANONICAL_ROOT,
          WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          WorkflowTimestampMs.make(Math.floor(now)),
          { client },
        )
        expect(bundles).toHaveLength(1)
        const bundle = bundles[0]!
        // Suspended run reply is non-terminal -> llm-phase-done transitions waiting -> running
        expect(bundle.run.state).toBe("running")
        expect(bundle.units[0]?.status).toBe("dispatched")
        const attemptByKey = new Map(bundle.attempts.map((a) => [a.attemptKey, a] as const))
        const a1 = attemptByKey.get(
          makeWorkflowAttemptKey(
            plan.runId,
            unitId,
            AttemptNumber.make(1),
            EscalationOrdinal.make(1),
          ),
        )
        const a2 = attemptByKey.get(
          makeWorkflowAttemptKey(
            plan.runId,
            unitId,
            AttemptNumber.make(2),
            EscalationOrdinal.make(1),
          ),
        )
        expect(a1?.verdict).toBe("rejected")
        expect(a1?.runner).toBe(runner)
        expect(a2?.verdict).toBe("dispatched")
        expect(a2?.runner).toBe(runner)
      }),
  )

  it.effect(
    "F-24: replayActivityMessage records ProjectUnitDispatched and DispatchUnitAgent Failed/AuthRequired with runner",
    () =>
      Effect.gen(function* () {
        const unitId = WorkUnitId.make("u-agent-direct")
        const runner = RunnerId.make("claude-code")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-agent-direct"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: {
            _tag: "Automatic",
            runner,
            maxConcurrency: MaxConcurrency.make(1),
          },
          units: [makePackageUnit(unitId, "@harness/agent-direct", ["libs/ad/src"], 0)],
          sharedStepPaths: [],
        }
        const now = yield* Clock.currentTimeMillis
        const unitStatusMap = new Map<WorkUnitId, WorkflowUnitStatus>([[unitId, "pending"]])
        const attemptsMap = new Map<WorkflowAttemptKey, WorkflowAttemptRecord>()
        const mergeConflictUnits = new Set<WorkUnitId>()
        let runState: WorkflowRunState = "running"

        const runStep = (activityName: string, actReplyStr?: string) =>
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

        yield* runStep(`ProjectUnitDispatched/${unitId}/1`)
        const k1 = makeWorkflowAttemptKey(
          plan.runId,
          unitId,
          AttemptNumber.make(1),
          EscalationOrdinal.make(1),
        )
        expect(attemptsMap.get(k1)?.verdict).toBe("dispatched")
        expect(attemptsMap.get(k1)?.runner).toBe(runner)

        yield* runStep(
          `DispatchUnitAgent/${unitId}/1`,
          JSON.stringify({
            _tag: "Success",
            value: {
              _tag: "Complete",
              exit: {
                _tag: "Success",
                value: { _tag: "Failed", reason: "dispatch crash" },
              },
            },
          }),
        )
        expect(attemptsMap.get(k1)?.verdict).toBe("rejected")
        expect(attemptsMap.get(k1)?.runner).toBe(runner)

        yield* runStep(
          `DispatchUnitAgent/${unitId}/2`,
          JSON.stringify({
            _tag: "Success",
            value: {
              _tag: "Complete",
              exit: {
                _tag: "Success",
                value: { _tag: "AuthRequired", runner },
              },
            },
          }),
        )
        const k2 = makeWorkflowAttemptKey(
          plan.runId,
          unitId,
          AttemptNumber.make(2),
          EscalationOrdinal.make(1),
        )
        expect(attemptsMap.get(k2)?.verdict).toBe("rejected")
        expect(attemptsMap.get(k2)?.runner).toBe(runner)
      }),
  )

  it.effect(
    "F-13.1 / SPEC-0027 REQ-2.2: makeHarnessWorkflowEngineLayer fails with WorkflowStoreUnavailableError on non-monotonic timeoutBudgets at initialization",
    () =>
      Effect.gen(function* () {
        const invalidBudgets = {
          ...WORKFLOW_TIMEOUT_BUDGETS,
          workflowServerSocketMs: WORKFLOW_TIMEOUT_BUDGETS.workflowCompleteIpcMs,
        }
        const err = yield* Effect.scoped(
          Layer.build(
            makeHarnessWorkflowEngineLayer(CANONICAL_ROOT, {
              timeoutBudgets: invalidBudgets,
            }),
          ),
        ).pipe(Effect.flip)
        match(err)
          .with({ _tag: "WorkflowStoreUnavailableError" }, (storeErr) => {
            expect(storeErr.reason).toContain("workflowServerSocketMs")
          })
          .with({ _tag: "WriterLeaseHeldError" }, () => {
            expect.unreachable("Expected WorkflowStoreUnavailableError on inverted timeout budgets")
          })
          .exhaustive()
      }),
  )
})
