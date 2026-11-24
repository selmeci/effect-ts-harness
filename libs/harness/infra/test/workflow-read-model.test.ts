import { Effect, Layer } from "effect"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AgentFailureReason,
  AttemptNumber,
  CompiledPlan,
  EarsRequirementKey,
  GitCommitSha,
  MaxConcurrency,
  MergeSliceWaveOutcome,
  MessageKey,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanJsonPayload,
  PlanSha256,
  RunnerId,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  StubSymbolKey,
  UnitOutcome,
  UnitRejection,
  WaveIndex,
  WorkUnitId,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
} from "@harness/contract"
import { decideSpanBudgets } from "@harness/gates"
import { makeWorkflowOmnigraphClient } from "@harness/graph"
import { WorkflowProjectionWriter, WorkflowReadModelQuery } from "@harness/service"
import {
  makeWorkflowProjectionWriterLayer,
  makeWorkflowReadModelQueryLayer,
  rebuildWorkflowReadModelViews,
} from "../src/index.js"
import { JOURNAL_PAGE_LIMIT, MAX_JOURNAL_SCAN_PAGES } from "../src/workflow/read-model-rebuild.js"
import {
  runWithTestTracer,
  fakeReadResult,
  wrapQueriesInvoke,
  unwrapSeqKey,
  startWorkflowReadModelServerHarness,
  type Omnigraph,
} from "./helpers/workflow-read-model-fixture.js"

describe("WF-3 WorkflowProjectionWriterLive, WorkflowReadModelQueryLive & pagination", () => {
  const harness = startWorkflowReadModelServerHarness("wf3-read-model-")
  const cliToken = harness.cliToken
  const createClient = () => harness.createClient()
  const nextMsgKey = () => harness.nextMsgKey()
  const insertJournalMessage = (
    client: Omnigraph,
    params: Parameters<typeof harness.insertJournalMessage>[1],
  ) => harness.insertJournalMessage(client, params)
  const insertJournalReplyExit = (client: Omnigraph, requestId: MessageKey, payload: unknown) =>
    harness.insertJournalReplyExit(client, requestId, payload)
  const cleanupRunsAndJournal = (
    client: Omnigraph,
    runIds: ReadonlyArray<WorkflowRunId>,
    extraEntityIds: ReadonlyArray<string> = [],
  ) => harness.cleanupRunsAndJournal(client, runIds, extraEntityIds)
  beforeAll(() => harness.start(), 30_000)
  afterAll(() => harness.stop())

  it("probeAvailability reports 'ready' on live store and 'inactive' when Omnigraph is unreachable", async () => {
    const client = createClient()
    const readyLayer = makeWorkflowReadModelQueryLayer({ repoRoot: harness.getRepoRoot(), client })
    const readyState = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        return yield* query.probeAvailability
      }).pipe(Effect.provide(readyLayer)),
    )
    expect(readyState).toBe("ready")

    const unreachableClient = makeWorkflowOmnigraphClient({
      baseUrl: "http://127.0.0.1:1",
      token: cliToken,
    })
    const inactiveLayer = makeWorkflowReadModelQueryLayer({
      repoRoot: harness.getRepoRoot(),
      client: unreachableClient,
    })
    const inactiveState = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        return yield* query.probeAvailability
      }).pipe(Effect.provide(inactiveLayer)),
    )
    expect(inactiveState).toBe("inactive")
  })

  it("upserts, lists, and deletes WfRun, WfUnit, and typed WfAttempt (F-18.2) rows", async () => {
    const client = createClient()
    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot: harness.getRepoRoot(), client }),
      makeWorkflowReadModelQueryLayer({ repoRoot: harness.getRepoRoot(), client }),
    )
    const runId = WorkflowRunId.make("run-rm-crud-1")
    const otherRunId = WorkflowRunId.make("run-rm-crud-2")
    const executionId = WorkflowExecutionId.make("run-rm-crud-1")
    const planSha = PlanSha256.make("a".repeat(64))
    const baseSha = GitCommitSha.make("b".repeat(40))
    const unitId = WorkUnitId.make("unit-alpha")
    const unitKey = makeWorkflowUnitKey(runId, unitId)
    const attemptKey1 = makeWorkflowAttemptKey(runId, unitId, AttemptNumber.make(1))
    const attemptKey2 = makeWorkflowAttemptKey(runId, unitId, AttemptNumber.make(2))
    const stampHash = PackageStampHash.make("c".repeat(64))

    await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const query = yield* WorkflowReadModelQuery

        expect((yield* query.getRun(runId))._tag).toBe("None")

        yield* writer.upsertRun({
          runId,
          executionId,
          level: "slice",
          planSha,
          baseSha,
          state: "running",
          planJson: PlanJsonPayload.make('{"runId":"run-rm-crud-1"}'),
          updatedMs: WorkflowTimestampMs.make(1000),
        })
        yield* writer.upsertRun({
          runId,
          executionId,
          level: "slice",
          planSha,
          baseSha,
          state: "completed",
          updatedMs: WorkflowTimestampMs.make(2000),
        })
        yield* writer.upsertRun({
          runId: otherRunId,
          executionId: WorkflowExecutionId.make("run-rm-crud-2"),
          level: "epic",
          planSha,
          baseSha,
          state: "waiting",
          updatedMs: WorkflowTimestampMs.make(1500),
        })

        expect(yield* query.probeAvailability).toBe("ready")
        match(yield* query.getRun(runId))
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.state).toBe("completed")
            expect(value.updatedMs).toBe(2000)
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected inserted run to be found")
          })
          .exhaustive()

        expect((yield* query.listRuns).map((r) => r.runId)).toEqual([runId, otherRunId])

        yield* writer.upsertUnit({
          unitKey,
          runId,
          unitId,
          kind: "package",
          waveIndex: WaveIndex.make(0),
          status: "pending",
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          updatedMs: WorkflowTimestampMs.make(1000),
        })
        yield* writer.upsertUnit({
          unitKey,
          runId,
          unitId,
          kind: "package",
          waveIndex: WaveIndex.make(0),
          status: "completed",
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          updatedMs: WorkflowTimestampMs.make(2000),
        })
        const units = yield* query.listUnits(runId)
        expect(units).toHaveLength(1)
        expect(units[0]?.status).toBe("completed")
        expect(units[0]?.ownedRelPaths).toEqual([OwnedRelPath.make("libs/alpha")])

        yield* writer.upsertAttempt({
          attemptKey: attemptKey1,
          runId,
          unitId,
          attempt: AttemptNumber.make(1),
          verdict: "dispatched",
          runner: RunnerId.make("claude-code"),
          updatedMs: WorkflowTimestampMs.make(1100),
        })
        yield* writer.upsertAttempt({
          attemptKey: attemptKey1,
          runId,
          unitId,
          attempt: AttemptNumber.make(1),
          verdict: "rejected",
          runner: RunnerId.make("claude-code"),
          rejection: UnitRejection.cases.AgentFailed.make({
            reason: AgentFailureReason.make("unit failed"),
          }),
          updatedMs: WorkflowTimestampMs.make(1200),
        })
        yield* writer.upsertAttempt({
          attemptKey: attemptKey2,
          runId,
          unitId,
          attempt: AttemptNumber.make(2),
          verdict: "completed",
          runner: RunnerId.make("claude-code"),
          packageStampHash: stampHash,
          updatedMs: WorkflowTimestampMs.make(2100),
        })
        const attempts = yield* query.listAttempts(runId)
        expect(attempts).toHaveLength(2)
        expect(attempts[0]?.verdict).toBe("rejected")
        match(attempts[0])
          .with({ verdict: "rejected" }, (rejectedAttempt) => {
            expect(rejectedAttempt.rejection._tag).toBe("AgentFailed")
          })
          .with(undefined, { verdict: "dispatched" }, { verdict: "completed" }, () => {
            expect.unreachable("Expected rejected attempt record")
          })
          .exhaustive()
        expect(attempts[1]?.verdict).toBe("completed")
        expect(attempts[1]?.packageStampHash).toBe(stampHash)

        yield* cleanupRunsAndJournal(client, [runId])
        expect((yield* query.getRun(runId))._tag).toBe("None")
        expect(yield* query.listUnits(runId)).toEqual([])
        expect(yield* query.listAttempts(runId)).toEqual([])
        expect((yield* query.listRuns).map((r) => r.runId)).toEqual([otherRunId])

        yield* cleanupRunsAndJournal(client, [otherRunId])
      }).pipe(Effect.provide(layer)),
    )
  })

  it("rebuildWorkflowReadModelViews clears stale views and reconstructs completed and waiting runs within SpanBudget", async () => {
    const client = createClient()
    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot: harness.getRepoRoot(), client }),
      makeWorkflowReadModelQueryLayer({ repoRoot: harness.getRepoRoot(), client }),
    )
    const staleRunId = WorkflowRunId.make("run-stale-0001")
    const completedRunId = WorkflowRunId.make("run-rebuilt-01")
    const waitingRunId = WorkflowRunId.make("run-rebuilt-02")
    const baseSha = GitCommitSha.make("e".repeat(40))
    const unitId = WorkUnitId.make("u-alpha")
    const stampHash = PackageStampHash.make("f".repeat(64))

    const completedPlan: CompiledPlan = {
      runId: completedRunId,
      level: "slice",
      planSha: PlanSha256.make("1".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId,
          projectName: NxProjectName.make("@harness/alpha"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          stubKeys: [StubSymbolKey.make("Alpha.run")],
          earsKeys: [EarsRequirementKey.make("REQ-3.1")],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
        },
      ],
      sharedStepPaths: [],
    }
    const waitingPlan: CompiledPlan = {
      runId: waitingRunId,
      level: "epic",
      planSha: PlanSha256.make("2".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "SliceUnit",
          unitId: WorkUnitId.make("u-slice"),
          branch: SliceBranchName.make("slice/u-slice"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/beta")],
          earsKeys: [EarsRequirementKey.make("REQ-3.1")],
        },
      ],
      sharedStepPaths: [],
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const query = yield* WorkflowReadModelQuery

        yield* writer.upsertRun({
          runId: staleRunId,
          executionId: WorkflowExecutionId.make("exec-stale"),
          level: "slice",
          planSha: PlanSha256.make("9".repeat(64)),
          baseSha,
          state: "running",
          updatedMs: WorkflowTimestampMs.make(100),
        })

        const msgRun1 = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: completedRunId,
          tag: "run",
          payload: JSON.stringify({ plan: completedPlan }),
        })
        yield* insertJournalReplyExit(client, msgRun1, {
          _tag: "Success",
          value: { _tag: "Complete", exit: { _tag: "Success", value: {} } },
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: completedRunId,
          tag: "deferred",
          payload: JSON.stringify({
            name: `unit/${unitId}/1`,
            exit: {
              _tag: "Success",
              value: UnitOutcome.cases.Rejected.make({
                unitId,
                attempt: AttemptNumber.make(1),
                rejection: UnitRejection.cases.AgentFailed.make({
                  reason: AgentFailureReason.make("initial failure"),
                }),
              }),
            },
          }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: completedRunId,
          tag: "deferred",
          payload: JSON.stringify({
            name: `unit/${unitId}/2`,
            exit: {
              _tag: "Success",
              value: UnitOutcome.cases.Completed.make({
                unitId,
                attempt: AttemptNumber.make(2),
                changedPaths: [OwnedRelPath.make("libs/alpha/src/index.ts")],
                packageStampHash: stampHash,
              }),
            },
          }),
        })
        const msgRun2 = yield* insertJournalMessage(client, {
          shardId: "default:1",
          entityId: waitingRunId,
          tag: "run",
          payload: JSON.stringify({ plan: waitingPlan }),
        })
        yield* insertJournalReplyExit(client, msgRun2, {
          _tag: "Success",
          value: { _tag: "Suspended" },
        })

        const { result: rebuiltCount, spans } = yield* runWithTestTracer(
          "rebuildWorkflowReadModelViews",
          rebuildWorkflowReadModelViews(harness.getRepoRoot(), {
            client,
            nowMs: () => 555_000,
          }),
        )
        expect(spans.some((s) => s.name === "Harness.rebuildWorkflowReadModelViews")).toBe(true)
        expect(yield* decideSpanBudgets({ spans })).toEqual([])
        expect(rebuiltCount).toBe(2)
        expect((yield* query.getRun(staleRunId))._tag).toBe("None")
        expect((yield* query.listRuns).length).toBe(2)

        match(yield* query.getRun(completedRunId))
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.state).toBe("completed")
            expect(value.updatedMs).toBe(555_000)
          })
          .with({ _tag: "None" }, () => expect.unreachable("Expected completedRunId"))
          .exhaustive()

        match(yield* query.getRun(waitingRunId))
          .with({ _tag: "Some" }, ({ value }) => expect(value.state).toBe("waiting"))
          .with({ _tag: "None" }, () => expect.unreachable("Expected waitingRunId"))
          .exhaustive()

        const attempts1 = yield* query.listAttempts(completedRunId)
        expect(attempts1).toHaveLength(2)
        expect(attempts1[0]?.verdict).toBe("rejected")
        expect(attempts1[1]?.verdict).toBe("completed")
        expect(attempts1[1]?.packageStampHash).toBe(stampHash)

        yield* cleanupRunsAndJournal(client, [completedRunId, waitingRunId])
      }).pipe(Effect.provide(layer)),
    )
  })

  const makeAdvancedReadModelPlans = (params: {
    readonly autoRunId: WorkflowRunId
    readonly mergeRunId: WorkflowRunId
    readonly escFailRunId: WorkflowRunId
    readonly unit1: WorkUnitId
    readonly unit10: WorkUnitId
    readonly sliceUnit: WorkUnitId
    readonly sliceBranch: SliceBranchName
    readonly escUnit: WorkUnitId
  }) => {
    const baseSha = GitCommitSha.make("e".repeat(40))
    const autoPlan: CompiledPlan = {
      runId: params.autoRunId,
      level: "slice",
      planSha: PlanSha256.make("3".repeat(64)),
      baseSha,
      mode: {
        _tag: "Automatic",
        runner: RunnerId.make("claude-code"),
        maxConcurrency: MaxConcurrency.make(2),
      },
      units: [
        {
          _tag: "PackageUnit",
          unitId: params.unit1,
          projectName: NxProjectName.make("@harness/u1"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/u1")],
          stubKeys: [],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/u1:verify"),
        },
        {
          _tag: "PackageUnit",
          unitId: params.unit10,
          projectName: NxProjectName.make("@harness/u10"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/u10")],
          stubKeys: [],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/u10:verify"),
        },
      ],
      sharedStepPaths: [OwnedRelPath.make("libs/shared")],
    }
    const mergePlan: CompiledPlan = {
      runId: params.mergeRunId,
      level: "epic",
      planSha: PlanSha256.make("4".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "SliceUnit",
          unitId: params.sliceUnit,
          branch: params.sliceBranch,
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/beta")],
          earsKeys: [],
        },
      ],
      sharedStepPaths: [],
    }
    const escPlan: CompiledPlan = {
      runId: params.escFailRunId,
      level: "slice",
      planSha: PlanSha256.make("5".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId: params.escUnit,
          projectName: NxProjectName.make("@harness/esc"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/esc")],
          stubKeys: [],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/esc:verify"),
        },
      ],
      sharedStepPaths: [],
    }
    return { autoPlan, mergePlan, escPlan }
  }

  const seedAdvancedReadModelJournal = (
    client: ReturnType<typeof createClient>,
    params: {
      readonly autoRunId: WorkflowRunId
      readonly mergeRunId: WorkflowRunId
      readonly escFailRunId: WorkflowRunId
      readonly unit10: WorkUnitId
      readonly sliceBranch: SliceBranchName
      readonly escUnit: WorkUnitId
      readonly autoPlan: CompiledPlan
      readonly mergePlan: CompiledPlan
      readonly escPlan: CompiledPlan
    },
  ) =>
    Effect.gen(function* () {
      const stampHash = PackageStampHash.make("a".repeat(64))
      const autoRunMsg = yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.autoRunId,
        tag: "run",
        payload: JSON.stringify({ plan: params.autoPlan }),
      })
      yield* insertJournalReplyExit(client, autoRunMsg, {
        _tag: "Success",
        value: { _tag: "Suspended" },
      })
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.autoRunId,
        tag: "activity",
        payload: JSON.stringify({ name: `DispatchUnitAgent/${params.unit10}/1` }),
      })
      const v1Msg = yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.autoRunId,
        tag: "activity",
        payload: JSON.stringify({ name: `VerifyUnit/${params.unit10}/1`, attempt: 1 }),
      })
      yield* insertJournalReplyExit(client, v1Msg, {
        _tag: "Success",
        value: {
          _tag: "Complete",
          exit: {
            _tag: "Success",
            value: UnitOutcome.cases.Rejected.make({
              unitId: params.unit10,
              attempt: AttemptNumber.make(1),
              rejection: UnitRejection.cases.AgentFailed.make({
                reason: AgentFailureReason.make("cycle 1 rejected"),
              }),
            }),
          },
        },
      })
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.autoRunId,
        tag: "activity",
        payload: JSON.stringify({ name: `ProjectUnitEscalated/${params.unit10}/1` }),
      })
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.autoRunId,
        tag: "activity",
        payload: JSON.stringify({ name: `ProjectUnitEscalationRetried/${params.unit10}/1` }),
      })
      const v2Msg = yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.autoRunId,
        tag: "activity",
        payload: JSON.stringify({ name: `VerifyUnit/${params.unit10}/1/r2`, attempt: 1 }),
      })
      yield* insertJournalReplyExit(client, v2Msg, {
        _tag: "Success",
        value: {
          _tag: "Complete",
          exit: {
            _tag: "Success",
            value: UnitOutcome.cases.Completed.make({
              unitId: params.unit10,
              attempt: AttemptNumber.make(1),
              changedPaths: [OwnedRelPath.make("libs/u10/a.ts")],
              packageStampHash: stampHash,
            }),
          },
        },
      })
      const sharedMsg = yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.autoRunId,
        tag: "activity",
        payload: JSON.stringify({ name: "VerifySharedStep/1", attempt: 1 }),
      })
      yield* insertJournalReplyExit(client, sharedMsg, {
        _tag: "Success",
        value: {
          _tag: "Complete",
          exit: {
            _tag: "Success",
            value: UnitOutcome.cases.Completed.make({
              unitId: SHARED_STEP_UNIT_ID,
              attempt: AttemptNumber.make(1),
              changedPaths: [OwnedRelPath.make("libs/shared/index.ts")],
              packageStampHash: stampHash,
            }),
          },
        },
      })
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.autoRunId,
        tag: "deferred",
        payload: JSON.stringify({
          name: "Workflow/InterruptSignal",
          exit: { _tag: "Success", value: null },
        }),
      })

      const mergeRunMsg = yield* insertJournalMessage(client, {
        shardId: "default:1",
        entityId: params.mergeRunId,
        tag: "run",
        payload: JSON.stringify({ plan: params.mergePlan }),
      })
      yield* insertJournalReplyExit(client, mergeRunMsg, {
        _tag: "Success",
        value: { _tag: "Suspended" },
      })
      const mergeWaveMsg = yield* insertJournalMessage(client, {
        shardId: "default:1",
        entityId: params.mergeRunId,
        tag: "activity",
        payload: JSON.stringify({ name: "MergeSliceWave/0" }),
      })
      yield* insertJournalReplyExit(client, mergeWaveMsg, {
        _tag: "Success",
        value: {
          _tag: "Complete",
          exit: {
            _tag: "Success",
            value: MergeSliceWaveOutcome.cases.Conflict.make({ branch: params.sliceBranch }),
          },
        },
      })

      const escRunMsg = yield* insertJournalMessage(client, {
        shardId: "default:2",
        entityId: params.escFailRunId,
        tag: "run",
        payload: JSON.stringify({ plan: params.escPlan }),
      })
      yield* insertJournalReplyExit(client, escRunMsg, { _tag: "Failure" })
      yield* insertJournalMessage(client, {
        shardId: "default:2",
        entityId: params.escFailRunId,
        tag: "activity",
        payload: JSON.stringify({ name: `ProjectUnitEscalated/${params.escUnit}/1` }),
      })
    })

  it("rebuildWorkflowReadModelViews reconstructs sharedStepPaths, /r2 cycles, MergeSliceWave conflicts, InterruptSignal, and Failure exits", async () => {
    const client = createClient()
    const layer = makeWorkflowReadModelQueryLayer({ repoRoot: harness.getRepoRoot(), client })
    const autoRunId = WorkflowRunId.make("run-adv-auto-1")
    const mergeRunId = WorkflowRunId.make("run-adv-merge-2")
    const escFailRunId = WorkflowRunId.make("run-adv-esc-3")
    const unit1 = WorkUnitId.make("u-1")
    const unit10 = WorkUnitId.make("u-10")
    const sliceUnit = WorkUnitId.make("u-slice-conflict")
    const sliceBranch = SliceBranchName.make("slice/u-conflict")
    const escUnit = WorkUnitId.make("u-esc")
    const plans = makeAdvancedReadModelPlans({
      autoRunId,
      mergeRunId,
      escFailRunId,
      unit1,
      unit10,
      sliceUnit,
      sliceBranch,
      escUnit,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        yield* seedAdvancedReadModelJournal(client, {
          autoRunId,
          mergeRunId,
          escFailRunId,
          unit10,
          sliceBranch,
          escUnit,
          ...plans,
        })

        const rebuiltTotal = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), {
          client,
          nowMs: () => 777_000,
        })
        expect(rebuiltTotal).toBe(3)

        match(yield* query.getRun(autoRunId))
          .with({ _tag: "Some" }, ({ value }) => expect(value.state).toBe("aborted"))
          .with({ _tag: "None" }, () => expect.unreachable("Expected autoRunId"))
          .exhaustive()
        const autoUnits = yield* query.listUnits(autoRunId)
        expect(autoUnits.find((u) => u.unitId === unit1)?.status).toBe("pending")
        expect(autoUnits.find((u) => u.unitId === unit10)?.status).toBe("completed")
        expect(autoUnits.find((u) => u.unitId === SHARED_STEP_UNIT_ID)?.status).toBe("completed")
        expect(autoUnits.find((u) => u.unitId === SHARED_STEP_UNIT_ID)?.waveIndex).toBe(1)

        const autoAttempts = yield* query.listAttempts(autoRunId)
        expect(autoAttempts.map((a) => a.attemptKey)).toEqual([
          `${autoRunId}/${SHARED_STEP_UNIT_ID}#1`,
          `${autoRunId}/${unit10}#1`,
          `${autoRunId}/${unit10}#1/r2`,
        ])

        match(yield* query.getRun(mergeRunId))
          .with({ _tag: "Some" }, ({ value }) => expect(value.state).toBe("waiting"))
          .with({ _tag: "None" }, () => expect.unreachable("Expected mergeRunId"))
          .exhaustive()
        expect(
          (yield* query.listUnits(mergeRunId)).find((u) => u.unitId === sliceUnit)?.status,
        ).toBe("escalated")

        match(yield* query.getRun(escFailRunId))
          .with({ _tag: "Some" }, ({ value }) => expect(value.state).toBe("aborted"))
          .with({ _tag: "None" }, () => expect.unreachable("Expected escFailRunId"))
          .exhaustive()
        expect(
          (yield* query.listUnits(escFailRunId)).find((u) => u.unitId === escUnit)?.status,
        ).toBe("escalated")

        yield* cleanupRunsAndJournal(client, [autoRunId, mergeRunId, escFailRunId])
      }).pipe(Effect.provide(layer)),
    )
  })

  it("F-23.1/F-2.2: rebuildWorkflowReadModelViews paginates >1024 journal rows across multiple pages against live Omnigraph", async () => {
    const client = createClient()
    const layer = makeWorkflowReadModelQueryLayer({ repoRoot: harness.getRepoRoot(), client })
    const runId = WorkflowRunId.make("run-page-over-1024")
    const baseSha = GitCommitSha.make("d".repeat(40))
    const unitId = WorkUnitId.make("u-page")
    const plan: CompiledPlan = {
      runId,
      level: "slice",
      planSha: PlanSha256.make("6".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId,
          projectName: NxProjectName.make("@harness/page"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/page")],
          stubKeys: [],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/page:verify"),
        },
      ],
      sharedStepPaths: [],
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        const runMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: runId,
          tag: "run",
          payload: JSON.stringify({ plan }),
        })
        yield* insertJournalReplyExit(client, runMsg, {
          _tag: "Success",
          value: { _tag: "Complete", exit: { _tag: "Success", value: {} } },
        })

        // Bulk-load 1,030 activity messages (> JOURNAL_PAGE_LIMIT = 1024) so scanAllJournalRows crosses page 1 -> page 2
        const ndjsonLines = Array.from({ length: 1030 }, (_, idx) => {
          const { key, seqKey } = nextMsgKey()
          return JSON.stringify({
            type: "WfMessage",
            id: key,
            data: {
              messageKey: key,
              seqKey,
              shardId: "default:0",
              entityType: "Workflow/HarnessTaskWorkflow",
              entityId: runId,
              kind: "request",
              tag: "activity",
              payload: JSON.stringify({
                name: idx === 1029 ? `DispatchUnitAgent/${unitId}/1` : "ProvisionWorktrees",
              }),
              headers: "{}",
              requestId: key,
              processed: false,
            },
          })
        }).join("\n")
        yield* Effect.tryPromise(() =>
          client.load({
            branch: "main",
            mode: "merge",
            data: ndjsonLines,
          }),
        )

        const rebuilt = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), {
          client,
          nowMs: () => 888_000,
        })
        expect(rebuilt).toBe(1)

        const units = yield* query.listUnits(runId)
        expect(units[0]?.status).toBe("dispatched")
      }).pipe(
        Effect.ensuring(cleanupRunsAndJournal(client, [runId]).pipe(Effect.ignore)),
        Effect.provide(layer),
      ),
    )
  })

  it("F-23.1/F-2.2: rebuildWorkflowReadModelViews fails closed when pagination reaches MAX_JOURNAL_SCAN_PAGES or cursor stalls", async () => {
    const baseClient = createClient()
    const mkFakePage = (seqStart: bigint) =>
      Array.from({ length: JOURNAL_PAGE_LIMIT }, (_, idx) => {
        const seq = unwrapSeqKey(seqStart + BigInt(idx))
        return {
          messageKey: String(seqStart + BigInt(idx)),
          seqKey: seq,
          entityType: "Other",
          entityId: "other-1",
          tag: "noop",
          payload: "{}",
          requestId: String(seqStart + BigInt(idx)),
        }
      })

    let pageCounter = 0n
    const truncatedClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_all_entities") {
        pageCounter += 1n
        return fakeReadResult(name, mkFakePage(pageCounter * 10_000n))
      }
      return orig(name, input, opts)
    })

    const truncErr = await Effect.runPromise(
      rebuildWorkflowReadModelViews(harness.getRepoRoot(), { client: truncatedClient }).pipe(
        Effect.flip,
      ),
    )
    expect(truncErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    if (truncErr instanceof WorkflowStoreUnavailableError) {
      expect(truncErr.reason).toContain(`MAX_JOURNAL_SCAN_PAGES (${MAX_JOURNAL_SCAN_PAGES})`)
    }

    const stalledSeq = unwrapSeqKey(900000000000000001n)
    const stalledClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_all_entities") {
        const rows = mkFakePage(800000000000000001n)
        rows[rows.length - 1] = {
          ...rows[rows.length - 1]!,
          seqKey: stalledSeq,
        }
        return fakeReadResult(name, rows)
      }
      return orig(name, input, opts)
    })

    const stalledErr = await Effect.runPromise(
      rebuildWorkflowReadModelViews(harness.getRepoRoot(), { client: stalledClient }).pipe(
        Effect.flip,
      ),
    )
    expect(stalledErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    if (stalledErr instanceof WorkflowStoreUnavailableError) {
      expect(stalledErr.reason).toContain("stalled at cursor seqKey")
    }
  })

  it("F-23.1/F-2.1/F-2.3/F-2.5: corrupt run, deferred, activity, or with_exit reply rows fail closed and preserve existing WfRun rows", async () => {
    const client = createClient()
    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot: harness.getRepoRoot(), client }),
      makeWorkflowReadModelQueryLayer({ repoRoot: harness.getRepoRoot(), client }),
    )
    const preservedRunId = WorkflowRunId.make("run-preserve-1")
    const corruptRunId = WorkflowRunId.make("run-corrupt-1")
    const baseSha = GitCommitSha.make("e".repeat(40))
    const unitId = WorkUnitId.make("u-corrupt")
    const validPlan: CompiledPlan = {
      runId: corruptRunId,
      level: "slice",
      planSha: PlanSha256.make("7".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId,
          projectName: NxProjectName.make("@harness/corrupt"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/corrupt")],
          stubKeys: [],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/corrupt:verify"),
        },
      ],
      sharedStepPaths: [],
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const query = yield* WorkflowReadModelQuery

        yield* writer.upsertRun({
          runId: preservedRunId,
          executionId: WorkflowExecutionId.make("exec-preserve-1"),
          level: "slice",
          planSha: PlanSha256.make("8".repeat(64)),
          baseSha,
          state: "completed",
          updatedMs: WorkflowTimestampMs.make(1_000),
        })

        // 1. Corrupt 'run' payload -> WorkflowStoreUnavailableError & preservedRunId intact
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: corruptRunId,
          tag: "run",
          payload: "{not-valid-plan",
        })
        const corruptRunErr = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), {
          client,
        }).pipe(Effect.flip)
        expect(corruptRunErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect((yield* query.getRun(preservedRunId))._tag).toBe("Some")
        yield* cleanupRunsAndJournal(client, [], [corruptRunId])

        // 2. Corrupt 'deferred' payload -> WorkflowStoreUnavailableError & preservedRunId intact
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: corruptRunId,
          tag: "run",
          payload: JSON.stringify({ plan: validPlan }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: corruptRunId,
          tag: "deferred",
          payload: "{broken-deferred",
        })
        const corruptDefErr = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), {
          client,
        }).pipe(Effect.flip)
        expect(corruptDefErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect((yield* query.getRun(preservedRunId))._tag).toBe("Some")
        yield* cleanupRunsAndJournal(client, [], [corruptRunId])

        // 3. Corrupt 'activity' payload -> WorkflowStoreUnavailableError & preservedRunId intact
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: corruptRunId,
          tag: "run",
          payload: JSON.stringify({ plan: validPlan }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: corruptRunId,
          tag: "activity",
          payload: "{broken-activity",
        })
        const corruptActErr = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), {
          client,
        }).pipe(Effect.flip)
        expect(corruptActErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect((yield* query.getRun(preservedRunId))._tag).toBe("Some")
        yield* cleanupRunsAndJournal(client, [], [corruptRunId])

        // 4. F-2.3: Undecodable with_exit reply -> WorkflowStoreUnavailableError (never "running") & preservedRunId intact
        const runMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: corruptRunId,
          tag: "run",
          payload: JSON.stringify({ plan: validPlan }),
        })
        yield* insertJournalReplyExit(client, runMsg, "{corrupt-exit-reply")
        const corruptReplyErr = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), {
          client,
        }).pipe(Effect.flip)
        expect(corruptReplyErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect((yield* query.getRun(preservedRunId))._tag).toBe("Some")
      }).pipe(
        Effect.ensuring(
          cleanupRunsAndJournal(client, [preservedRunId], [corruptRunId]).pipe(Effect.ignore),
        ),
        Effect.provide(layer),
      ),
    )
  })
})
