import { Effect, Layer, Option } from "effect"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  AttemptNumber,
  CompiledPlan,
  GitCommitSha,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  MergeSliceWaveOutcome,
  MessageKey,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanSha256,
  ReplyKey,
  SliceBranchName,
  UnitEscalation,
  UnitOutcome,
  UnitRejection,
  WaveIndex,
  WorkUnitId,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  WriterLeaseHeldError,
  makeWorkflowUnitKey,
} from "@harness/contract"
import { WorkflowProjectionWriter, WorkflowReadModelQuery } from "@harness/service"
import {
  invokeWorkflowStoreQuery,
  makeWorkflowProjectionWriterLayer,
  makeWorkflowReadModelQueryLayer,
  rebuildWorkflowReadModelViews,
} from "../src/index.js"
import {
  fakeReadResult,
  wrapQueriesInvoke,
  startWorkflowReadModelServerHarness,
  type Omnigraph,
} from "./helpers/workflow-read-model-fixture.js"

describe("WF-3 WorkflowReadModel rebuild lease fencing, CAS & replay hardening", () => {
  const harness = startWorkflowReadModelServerHarness("wf3-read-rebuild-")
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

  it("F-2.4/F-8.1/F-23.1: writer, query, and rebuild reject stale expectedLeaseEpoch with WriterLeaseHeldError and pass ifGraphCommit", async () => {
    const baseClient = createClient()
    const lockFilePath = LeaseFilePath.make("/tmp/wf3-lease-test.lock")
    const holderId = LeaseHolderId.make("daemon-active")
    const runId = WorkflowRunId.make("run-fenced-01")
    const unitId = WorkUnitId.make("u-fenced")
    const baseSha = GitCommitSha.make("e".repeat(40))
    const observedIfGraphCommits: Array<string | undefined> = []

    await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot: harness.getRepoRoot(),
        client: baseClient,
        operation: WorkflowStoreOperation.make("test.seedLease"),
        queryName: "wf_insert_writer_lease",
        params: {
          name: "engine",
          owner: `${holderId}#1001`,
          leaseEpoch: LeaseEpoch.make(2),
          heartbeatMs: Date.now(),
        },
        expectMutation: true,
      }),
    )

    const trackedClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_insert_run" || name === "wf_update_run") {
        observedIfGraphCommits.push(opts?.ifGraphCommit)
      }
      return orig(name, input, opts)
    })

    // Stale epoch 1 fails fast with WriterLeaseHeldError across writer, query, and rebuild
    const staleOptions = {
      repoRoot: harness.getRepoRoot(),
      client: trackedClient,
      expectedLeaseEpoch: LeaseEpoch.make(1),
      ownerId: holderId,
      lockFilePath,
    }
    const staleLayer = Layer.merge(
      makeWorkflowProjectionWriterLayer(staleOptions),
      makeWorkflowReadModelQueryLayer(staleOptions),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const query = yield* WorkflowReadModelQuery

        const writeErr = yield* writer
          .upsertRun({
            runId,
            executionId: WorkflowExecutionId.make("exec-fenced-01"),
            level: "slice",
            planSha: PlanSha256.make("a".repeat(64)),
            baseSha,
            state: "running",
            updatedMs: WorkflowTimestampMs.make(1_000),
          })
          .pipe(Effect.flip)
        expect(writeErr).toBeInstanceOf(WriterLeaseHeldError)

        const queryErr = yield* query.getRun(runId).pipe(Effect.flip)
        expect(queryErr).toBeInstanceOf(WriterLeaseHeldError)

        const rebuildErr = yield* rebuildWorkflowReadModelViews(
          harness.getRepoRoot(),
          staleOptions,
        ).pipe(Effect.flip)
        expect(rebuildErr).toBeInstanceOf(WriterLeaseHeldError)
      }).pipe(Effect.provide(staleLayer)),
    )

    // Matching epoch 2 succeeds and passes ifGraphCommit on upsertReadModelEntity mutations
    const activeOptions = {
      repoRoot: harness.getRepoRoot(),
      client: trackedClient,
      expectedLeaseEpoch: LeaseEpoch.make(2),
      ownerId: holderId,
      lockFilePath,
    }
    const activeLayer = Layer.merge(
      makeWorkflowProjectionWriterLayer(activeOptions),
      makeWorkflowReadModelQueryLayer(activeOptions),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const query = yield* WorkflowReadModelQuery

        yield* writer.upsertRun({
          runId,
          executionId: WorkflowExecutionId.make("exec-fenced-01"),
          level: "slice",
          planSha: PlanSha256.make("a".repeat(64)),
          baseSha,
          state: "running",
          updatedMs: WorkflowTimestampMs.make(1_000),
        })
        yield* writer.upsertUnit({
          unitKey: makeWorkflowUnitKey(runId, unitId),
          runId,
          unitId,
          kind: "package",
          waveIndex: WaveIndex.make(0),
          status: "pending",
          ownedRelPaths: [OwnedRelPath.make("libs/fenced")],
          updatedMs: WorkflowTimestampMs.make(1_000),
        })
        yield* writer.upsertRun({
          runId,
          executionId: WorkflowExecutionId.make("exec-fenced-01"),
          level: "slice",
          planSha: PlanSha256.make("a".repeat(64)),
          baseSha,
          state: "completed",
          updatedMs: WorkflowTimestampMs.make(2_000),
        })

        expect(observedIfGraphCommits.length).toBeGreaterThanOrEqual(2)
        expect(observedIfGraphCommits.every((c) => typeof c === "string" && c.length > 0)).toBe(
          true,
        )
        expect((yield* query.getRun(runId))._tag).toBe("Some")

        yield* cleanupRunsAndJournal(baseClient, [runId])
      }).pipe(Effect.provide(activeLayer)),
    )
  })

  const ensureTestWriterLease = (
    client: Omnigraph,
    owner: string,
    targetEpoch: LeaseEpoch,
  ): Effect.Effect<void, WorkflowStoreUnavailableError> =>
    Effect.gen(function* () {
      const existing = yield* invokeWorkflowStoreQuery({
        repoRoot: harness.getRepoRoot(),
        client,
        operation: WorkflowStoreOperation.make("test.getLease"),
        queryName: "wf_get_writer_lease",
        params: { name: "engine" },
        expectMutation: false,
      })
      const row = existing[0]
      if (row === undefined) {
        yield* invokeWorkflowStoreQuery({
          repoRoot: harness.getRepoRoot(),
          client,
          operation: WorkflowStoreOperation.make("test.insertLease"),
          queryName: "wf_insert_writer_lease",
          params: {
            name: "engine",
            owner,
            leaseEpoch: targetEpoch,
            heartbeatMs: Date.now(),
          },
          expectMutation: true,
        })
        return
      }
      const currentEpoch = LeaseEpoch.make(Number(row.leaseEpoch))
      yield* invokeWorkflowStoreQuery({
        repoRoot: harness.getRepoRoot(),
        client,
        operation: WorkflowStoreOperation.make("test.casLease"),
        queryName: "wf_cas_writer_lease",
        params: {
          name: "engine",
          expectedEpoch: currentEpoch,
          owner,
          nextEpoch: targetEpoch,
          heartbeatMs: Date.now(),
        },
        expectMutation: true,
      })
    })

  it("F-24: writer, query, and rebuild reject ownerId or expectedLeaseOwner mismatch with WriterLeaseHeldError", async () => {
    const baseClient = createClient()
    const lockFilePath = LeaseFilePath.make("/tmp/wf3-owner-mismatch-test.lock")
    const activeHolder = LeaseHolderId.make("daemon-owner-ok")
    const activeOwner = `${activeHolder}#2001`
    const wrongHolder = LeaseHolderId.make("daemon-owner-wrong")
    const wrongPidOwner = `${activeHolder}#9999`
    const runId = WorkflowRunId.make("run-owner-mismatch-1")
    const baseSha = GitCommitSha.make("e".repeat(40))
    const epoch = LeaseEpoch.make(10)

    await Effect.runPromise(ensureTestWriterLease(baseClient, activeOwner, epoch))

    const checkRejected = (opts: {
      readonly ownerId: LeaseHolderId
      readonly expectedLeaseOwner?: string
    }) => {
      const fencedOpts = {
        repoRoot: harness.getRepoRoot(),
        client: baseClient,
        expectedLeaseEpoch: epoch,
        ownerId: opts.ownerId,
        ...(opts.expectedLeaseOwner !== undefined
          ? { expectedLeaseOwner: opts.expectedLeaseOwner }
          : {}),
        lockFilePath,
      }
      const layer = Layer.merge(
        makeWorkflowProjectionWriterLayer(fencedOpts),
        makeWorkflowReadModelQueryLayer(fencedOpts),
      )
      return Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const query = yield* WorkflowReadModelQuery

        const writeErr = yield* writer
          .upsertRun({
            runId,
            executionId: WorkflowExecutionId.make("exec-owner-mismatch-1"),
            level: "slice",
            planSha: PlanSha256.make("a".repeat(64)),
            baseSha,
            state: "running",
            updatedMs: WorkflowTimestampMs.make(1_000),
          })
          .pipe(Effect.flip)
        expect(writeErr).toBeInstanceOf(WriterLeaseHeldError)

        const queryErr = yield* query.getRun(runId).pipe(Effect.flip)
        expect(queryErr).toBeInstanceOf(WriterLeaseHeldError)

        const rebuildErr = yield* rebuildWorkflowReadModelViews(
          harness.getRepoRoot(),
          fencedOpts,
        ).pipe(Effect.flip)
        expect(rebuildErr).toBeInstanceOf(WriterLeaseHeldError)
      }).pipe(Effect.provide(layer))
    }

    // 1. ownerId mismatch with matching epoch rejects all three surfaces
    await Effect.runPromise(checkRejected({ ownerId: wrongHolder }))
    // 2. expectedLeaseOwner mismatch (same holderId, different PID) with matching epoch rejects all three surfaces
    await Effect.runPromise(
      checkRejected({ ownerId: activeHolder, expectedLeaseOwner: wrongPidOwner }),
    )
  })

  it("F-23: rebuildWorkflowReadModelViews retries cleanly when background heartbeat advances graphCommitId under same lease epoch", async () => {
    const baseClient = createClient()
    const lockFilePath = LeaseFilePath.make("/tmp/wf3-heartbeat-retry-test.lock")
    const holderId = LeaseHolderId.make("daemon-hb")
    const activeOwner = `${holderId}#3001`
    const epoch = LeaseEpoch.make(20)
    const runId = WorkflowRunId.make("run-hb-rebuild-1")
    const staleRunId = WorkflowRunId.make("run-hb-stale-1")
    const unitId = WorkUnitId.make("u-hb-1")
    const baseSha = GitCommitSha.make("f".repeat(40))
    const planSha = PlanSha256.make("7".repeat(64))
    const stampHash = PackageStampHash.make("b".repeat(64))
    const plan: CompiledPlan = {
      runId,
      level: "slice",
      planSha,
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId,
          projectName: NxProjectName.make("@harness/hb"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/hb")],
          stubKeys: [],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/hb:verify"),
        },
      ],
      sharedStepPaths: [],
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* ensureTestWriterLease(baseClient, activeOwner, epoch)
        const writer = yield* WorkflowProjectionWriter
        yield* writer.upsertRun({
          runId: staleRunId,
          executionId: WorkflowExecutionId.make("exec-hb-stale-1"),
          level: "slice",
          planSha,
          baseSha,
          state: "running",
          updatedMs: WorkflowTimestampMs.make(1_000),
        })
        const runMsg = yield* insertJournalMessage(baseClient, {
          shardId: "default:0",
          entityId: runId,
          tag: "run",
          payload: JSON.stringify({ plan }),
        })
        yield* insertJournalReplyExit(baseClient, runMsg, {
          _tag: "Success",
          value: { _tag: "Complete", exit: { _tag: "Success", value: {} } },
        })
        const verifyMsg = yield* insertJournalMessage(baseClient, {
          shardId: "default:0",
          entityId: runId,
          tag: "activity",
          payload: JSON.stringify({ name: `VerifyUnit/${unitId}/1`, attempt: 1 }),
        })
        yield* insertJournalReplyExit(baseClient, verifyMsg, {
          _tag: "Success",
          value: {
            _tag: "Complete",
            exit: {
              _tag: "Success",
              value: UnitOutcome.cases.Completed.make({
                unitId,
                attempt: AttemptNumber.make(1),
                changedPaths: [OwnedRelPath.make("libs/hb/index.ts")],
                packageStampHash: stampHash,
              }),
            },
          },
        })
      }).pipe(
        Effect.provide(
          makeWorkflowProjectionWriterLayer({
            repoRoot: harness.getRepoRoot(),
            client: baseClient,
          }),
        ),
      ),
    )

    let phase2HeartbeatInjected = false
    let phase3HeartbeatInjected = false
    let injectedCount = 0
    const hbClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_delete_run_views" && !phase2HeartbeatInjected) {
        phase2HeartbeatInjected = true
        injectedCount += 1
        await orig("wf_refresh_writer_lease", {
          branch: "main",
          expectMutation: true,
          params: {
            name: "engine",
            owner: activeOwner,
            expectedEpoch: epoch,
            heartbeatMs: Date.now(),
          },
        })
      }
      if (name === "wf_insert_unit" && !phase3HeartbeatInjected) {
        phase3HeartbeatInjected = true
        injectedCount += 1
        await orig("wf_refresh_writer_lease", {
          branch: "main",
          expectMutation: true,
          params: {
            name: "engine",
            owner: activeOwner,
            expectedEpoch: epoch,
            heartbeatMs: Date.now(),
          },
        })
      }
      return orig(name, input, opts)
    })

    const fencedOpts = {
      repoRoot: harness.getRepoRoot(),
      client: hbClient,
      expectedLeaseEpoch: epoch,
      expectedLeaseOwner: activeOwner,
      ownerId: holderId,
      lockFilePath,
      nowMs: () => 444_000,
    }
    const queryLayer = makeWorkflowReadModelQueryLayer({
      repoRoot: harness.getRepoRoot(),
      client: baseClient,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        const rebuilt = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), fencedOpts)
        expect(injectedCount).toBe(2)
        expect(rebuilt).toBe(1)
        expect((yield* query.getRun(staleRunId))._tag).toBe("None")
        expect((yield* query.getRun(runId))._tag).toBe("Some")
        expect(yield* query.listUnits(runId)).toHaveLength(1)
        expect(yield* query.listAttempts(runId)).toHaveLength(1)
      }).pipe(
        Effect.ensuring(cleanupRunsAndJournal(baseClient, [runId, staleRunId]).pipe(Effect.ignore)),
        Effect.provide(queryLayer),
      ),
    )
  })

  it("F-23: rebuildWorkflowReadModelViews fails immediately with WriterLeaseHeldError when external writer advances lease epoch mid-Phase-2/3", async () => {
    const baseClient = createClient()
    const lockFilePath = LeaseFilePath.make("/tmp/wf3-takeover-fail-test.lock")
    const holderId = LeaseHolderId.make("daemon-old")
    const oldOwner = `${holderId}#4001`
    const oldEpoch = LeaseEpoch.make(30)
    const newEpoch = LeaseEpoch.make(31)
    const runId = WorkflowRunId.make("run-takeover-fail-1")
    const unitId = WorkUnitId.make("u-takeover-1")
    const baseSha = GitCommitSha.make("e".repeat(40))
    const plan: CompiledPlan = {
      runId,
      level: "slice",
      planSha: PlanSha256.make("8".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId,
          projectName: NxProjectName.make("@harness/takeover"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/takeover")],
          stubKeys: [],
          earsKeys: [],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/takeover:verify"),
        },
      ],
      sharedStepPaths: [],
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* ensureTestWriterLease(baseClient, oldOwner, oldEpoch)
        const runMsg = yield* insertJournalMessage(baseClient, {
          shardId: "default:0",
          entityId: runId,
          tag: "run",
          payload: JSON.stringify({ plan }),
        })
        yield* insertJournalReplyExit(baseClient, runMsg, {
          _tag: "Success",
          value: { _tag: "Suspended" },
        })
      }),
    )

    let takeoverTriggered = false
    const takeoverClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_insert_unit" && !takeoverTriggered) {
        takeoverTriggered = true
        await orig("wf_cas_writer_lease", {
          branch: "main",
          expectMutation: true,
          params: {
            name: "engine",
            owner: "external-daemon#9999",
            expectedEpoch: oldEpoch,
            nextEpoch: newEpoch,
            heartbeatMs: Date.now(),
          },
        })
      }
      return orig(name, input, opts)
    })

    const err = await Effect.runPromise(
      rebuildWorkflowReadModelViews(harness.getRepoRoot(), {
        repoRoot: harness.getRepoRoot(),
        client: takeoverClient,
        expectedLeaseEpoch: oldEpoch,
        expectedLeaseOwner: oldOwner,
        ownerId: holderId,
        lockFilePath,
      }).pipe(
        Effect.flip,
        Effect.ensuring(cleanupRunsAndJournal(baseClient, [runId]).pipe(Effect.ignore)),
      ),
    )
    expect(takeoverTriggered).toBe(true)
    expect(err).toBeInstanceOf(WriterLeaseHeldError)
  })

  it("F-2.4: upsertReadModelEntity serializes per-run writes and retries 412 ifGraphCommit CAS conflict by re-reading", async () => {
    const baseClient = createClient()
    const runId = WorkflowRunId.make("run-cas-retry-1")
    const baseSha = GitCommitSha.make("e".repeat(40))
    let conflictInjected = false
    let updateCalled = false

    const casClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_insert_run" && !conflictInjected) {
        conflictInjected = true
        // Simulate concurrent writer inserting the row before our insert commits
        await orig("wf_insert_run", {
          branch: "main",
          expectMutation: true,
          params: {
            runId,
            executionId: "exec-cas-retry-1",
            level: "slice",
            planSha: PlanSha256.make("a".repeat(64)),
            baseSha,
            state: "running",
            planJson: null,
            updatedMs: 500,
          },
        })
      }
      if (name === "wf_update_run") {
        updateCalled = true
      }
      return orig(name, input, opts)
    })

    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot: harness.getRepoRoot(), client: casClient }),
      makeWorkflowReadModelQueryLayer({ repoRoot: harness.getRepoRoot(), client: baseClient }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const query = yield* WorkflowReadModelQuery

        yield* writer.upsertRun({
          runId,
          executionId: WorkflowExecutionId.make("exec-cas-retry-1"),
          level: "slice",
          planSha: PlanSha256.make("a".repeat(64)),
          baseSha,
          state: "completed",
          updatedMs: WorkflowTimestampMs.make(1_500),
        })

        expect(conflictInjected).toBe(true)
        expect(updateCalled).toBe(true)
        match(yield* query.getRun(runId))
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.state).toBe("completed")
            expect(value.updatedMs).toBe(1_500)
          })
          .with({ _tag: "None" }, () => expect.unreachable("Expected CAS-retried run to exist"))
          .exhaustive()
      }).pipe(
        Effect.ensuring(cleanupRunsAndJournal(baseClient, [runId]).pipe(Effect.ignore)),
        Effect.provide(layer),
      ),
    )
  })

  it("F-21.2/F-18.2/F-23.1: decodeUnitRow rejects corrupt/empty ownedRelPaths and decodeAttemptRow rejects missing/corrupt rejection JSON", async () => {
    const baseClient = createClient()
    const runId = WorkflowRunId.make("run-bad-rows-1")
    const unitId = WorkUnitId.make("u-bad")

    const badUnitClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_units_for_run") {
        return fakeReadResult(name, [
          {
            unitKey: `${runId}/${unitId}`,
            runId,
            unitId,
            kind: "package",
            waveIndex: 0,
            status: "pending",
            ownedRelPaths: "libs/not-an-array",
            updatedMs: 1000,
          },
        ])
      }
      return orig(name, input, opts)
    })
    const badUnitErr = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        return yield* query.listUnits(runId)
      }).pipe(
        Effect.provide(
          makeWorkflowReadModelQueryLayer({
            repoRoot: harness.getRepoRoot(),
            client: badUnitClient,
          }),
        ),
        Effect.flip,
      ),
    )
    expect(badUnitErr).toBeInstanceOf(WorkflowStoreUnavailableError)

    const emptyPathsClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_units_for_run") {
        return fakeReadResult(name, [
          {
            unitKey: `${runId}/${unitId}`,
            runId,
            unitId,
            kind: "package",
            waveIndex: 0,
            status: "pending",
            ownedRelPaths: [],
            updatedMs: 1000,
          },
        ])
      }
      return orig(name, input, opts)
    })
    const emptyPathsErr = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        return yield* query.listUnits(runId)
      }).pipe(
        Effect.provide(
          makeWorkflowReadModelQueryLayer({
            repoRoot: harness.getRepoRoot(),
            client: emptyPathsClient,
          }),
        ),
        Effect.flip,
      ),
    )
    expect(emptyPathsErr).toBeInstanceOf(WorkflowStoreUnavailableError)

    const badAttemptClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_attempts_for_run") {
        return fakeReadResult(name, [
          {
            attemptKey: `${runId}/${unitId}#1`,
            runId,
            unitId,
            attempt: 1,
            verdict: "rejected",
            rejection: "{corrupt-rejection-json",
            updatedMs: 1000,
          },
        ])
      }
      return orig(name, input, opts)
    })
    const badAttemptErr = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        return yield* query.listAttempts(runId)
      }).pipe(
        Effect.provide(
          makeWorkflowReadModelQueryLayer({
            repoRoot: harness.getRepoRoot(),
            client: badAttemptClient,
          }),
        ),
        Effect.flip,
      ),
    )
    expect(badAttemptErr).toBeInstanceOf(WorkflowStoreUnavailableError)

    const missingRejectionClient = wrapQueriesInvoke(
      baseClient,
      async (name, orig, input, opts) => {
        if (name === "wf_attempts_for_run") {
          return fakeReadResult(name, [
            {
              attemptKey: `${runId}/${unitId}#2`,
              runId,
              unitId,
              attempt: 2,
              verdict: "rejected",
              rejection: null,
              updatedMs: 1001,
            },
          ])
        }
        return orig(name, input, opts)
      },
    )
    const missingRejErr = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        return yield* query.listAttempts(runId)
      }).pipe(
        Effect.provide(
          makeWorkflowReadModelQueryLayer({
            repoRoot: harness.getRepoRoot(),
            client: missingRejectionClient,
          }),
        ),
        Effect.flip,
      ),
    )
    expect(missingRejErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    if (missingRejErr instanceof WorkflowStoreUnavailableError) {
      expect(missingRejErr.reason).toContain("without rejection payload")
    }
  })

  it("clearExistingReadModelViews fails closed on invalid runId, stalled delete loop, and MAX_STALE_RUN_CLEAR_PAGES overflow", async () => {
    const baseClient = createClient()
    const invalidRunIdClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_all_entities" || name === "wf_all_replies") {
        return fakeReadResult(name, [])
      }
      if (name === "wf_list_runs") {
        return fakeReadResult(name, [{ runId: "not valid run id with spaces" }])
      }
      return orig(name, input, opts)
    })
    const invalidIdErr = await Effect.runPromise(
      rebuildWorkflowReadModelViews(harness.getRepoRoot(), { client: invalidRunIdClient }).pipe(
        Effect.flip,
      ),
    )
    expect(invalidIdErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    if (invalidIdErr instanceof WorkflowStoreUnavailableError) {
      expect(invalidIdErr.reason).toContain("invalid runId")
    }

    const makeFullRunBatch = (prefix: string) =>
      Array.from({ length: 256 }, (_, idx) => ({ runId: `${prefix}-${idx}` }))

    const stalledDeleteClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_all_entities" || name === "wf_all_replies") {
        return fakeReadResult(name, [])
      }
      if (name === "wf_list_runs") {
        return fakeReadResult(name, makeFullRunBatch("run-stuck-clear"))
      }
      if (name === "wf_delete_run_views") {
        return fakeReadResult(name, [])
      }
      return orig(name, input, opts)
    })
    const stalledClearErr = await Effect.runPromise(
      rebuildWorkflowReadModelViews(harness.getRepoRoot(), { client: stalledDeleteClient }).pipe(
        Effect.flip,
      ),
    )
    expect(stalledClearErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    if (stalledClearErr instanceof WorkflowStoreUnavailableError) {
      expect(stalledClearErr.reason).toContain("remained in wf_list_runs after deletion")
    }

    let clearPage = 0
    const overflowClearClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_all_entities" || name === "wf_all_replies") {
        return fakeReadResult(name, [])
      }
      if (name === "wf_list_runs") {
        clearPage += 1
        return fakeReadResult(name, makeFullRunBatch(`run-overflow-${clearPage}`))
      }
      if (name === "wf_delete_run_views") {
        return fakeReadResult(name, [])
      }
      return orig(name, input, opts)
    })
    const overflowErr = await Effect.runPromise(
      rebuildWorkflowReadModelViews(harness.getRepoRoot(), { client: overflowClearClient }).pipe(
        Effect.flip,
      ),
    )
    expect(overflowErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    if (overflowErr instanceof WorkflowStoreUnavailableError) {
      expect(overflowErr.reason).toContain("exceeded")
    }
  })

  const seedEpicAndLlmRebuildJournal = (
    client: ReturnType<typeof createClient>,
    params: {
      readonly epicRunId: WorkflowRunId
      readonly llmRunId: WorkflowRunId
      readonly sliceUnitId: WorkUnitId
      readonly sliceBranch: SliceBranchName
      readonly epicPlan: CompiledPlan
      readonly llmPlan: CompiledPlan
    },
  ) =>
    Effect.gen(function* () {
      // 1. Epic run: MergeSliceWave Conflict -> Escalation(retry) -> MergeSliceWave Merged + ack_chunk (tag: null) + non-run interrupt (tag: null)
      const epicRunMsg = yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.epicRunId,
        tag: "run",
        payload: JSON.stringify({ plan: params.epicPlan }),
      })
      const completedSliceOutcome = UnitOutcome.cases.Completed.make({
        unitId: params.sliceUnitId,
        attempt: AttemptNumber.make(1),
        changedPaths: [OwnedRelPath.make("libs/alpha/src/index.ts")],
        packageStampHash: PackageStampHash.make("e".repeat(64)),
      })
      const unitDoneMsg = yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.epicRunId,
        tag: "deferred",
        payload: JSON.stringify({
          name: `unit/${params.sliceUnitId}/1`,
          exit: {
            _tag: "Success",
            value: completedSliceOutcome,
          },
        }),
      })
      const ackKey = nextMsgKey()
      yield* invokeWorkflowStoreQuery({
        repoRoot: harness.getRepoRoot(),
        client,
        operation: WorkflowStoreOperation.make("Test.insertAck"),
        queryName: "wf_insert_ack_chunk",
        expectMutation: true,
        params: {
          messageKey: ackKey.key,
          seqKey: ackKey.seqKey,
          primaryKeyHash: null,
          shardId: "default:0",
          entityType: "Workflow/HarnessTaskWorkflow",
          entityId: params.epicRunId,
          requestId: unitDoneMsg,
          replyId: ReplyKey.make("999001"),
          deliverAtMs: null,
        },
      })
      const conflictMergeMsg = yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.epicRunId,
        tag: "activity",
        payload: JSON.stringify({ name: "MergeSliceWave/0" }),
      })
      yield* insertJournalReplyExit(client, conflictMergeMsg, {
        _tag: "Success",
        value: {
          _tag: "Complete",
          exit: {
            _tag: "Success",
            value: MergeSliceWaveOutcome.cases.Conflict.make({
              branch: params.sliceBranch,
            }),
          },
        },
      })
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.epicRunId,
        tag: "deferred",
        payload: JSON.stringify({
          name: `escalation/${params.sliceUnitId}/1`,
          exit: { _tag: "Success", value: { decision: "retry" } },
        }),
      })
      const retriedMergeMsg = yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.epicRunId,
        tag: "activity",
        payload: JSON.stringify({ name: "MergeSliceWave/0/r2" }),
      })
      yield* insertJournalReplyExit(client, retriedMergeMsg, {
        _tag: "Success",
        value: {
          _tag: "Complete",
          exit: {
            _tag: "Success",
            value: MergeSliceWaveOutcome.cases.Merged.make({
              mergedBranches: [params.sliceBranch],
            }),
          },
        },
      })
      const waitLlmMsg = yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.epicRunId,
        tag: "activity",
        payload: JSON.stringify({ name: "ProjectRunWaitingLlmPhase" }),
      })
      const nonRunInterrupt = nextMsgKey()
      yield* invokeWorkflowStoreQuery({
        repoRoot: harness.getRepoRoot(),
        client,
        operation: WorkflowStoreOperation.make("Test.insertActivityInterrupt"),
        queryName: "wf_insert_interrupt",
        expectMutation: true,
        params: {
          messageKey: nonRunInterrupt.key,
          seqKey: nonRunInterrupt.seqKey,
          primaryKeyHash: null,
          shardId: "default:0",
          entityType: "Workflow/HarnessTaskWorkflow",
          entityId: params.epicRunId,
          requestId: waitLlmMsg,
          deliverAtMs: null,
        },
      })
      void epicRunMsg

      // 2. Second run: WaitingLlmPhase -> llm-phase-done -> ProjectRunCompleted (without final run reply yet)
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.llmRunId,
        tag: "run",
        payload: JSON.stringify({ plan: params.llmPlan }),
      })
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.llmRunId,
        tag: "deferred",
        payload: JSON.stringify({
          name: `unit/${params.sliceUnitId}/1`,
          exit: {
            _tag: "Success",
            value: completedSliceOutcome,
          },
        }),
      })
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.llmRunId,
        tag: "activity",
        payload: JSON.stringify({ name: "ProjectRunWaitingLlmPhase" }),
      })
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.llmRunId,
        tag: "deferred",
        payload: JSON.stringify({
          name: "llm-phase-done",
          exit: { _tag: "Success", value: { workspaceHash: "h", frictionLogCleared: "cleared" } },
        }),
      })
      yield* insertJournalMessage(client, {
        shardId: "default:0",
        entityId: params.llmRunId,
        tag: "activity",
        payload: JSON.stringify({ name: "ProjectRunCompleted" }),
      })
    })

  it("rebuildWorkflowReadModelViews replays interrupt/ack_chunk rows, retried MergeSliceWave conflict units, and ProjectRunWaitingLlmPhase/ProjectRunCompleted", async () => {
    const client = createClient()
    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot: harness.getRepoRoot(), client }),
      makeWorkflowReadModelQueryLayer({ repoRoot: harness.getRepoRoot(), client }),
    )
    const epicRunId = WorkflowRunId.make("run-rebuild-epic-merge-1")
    const sliceUnitId = WorkUnitId.make("slice-merge-1")
    const sliceBranch = SliceBranchName.make("slice/merge-1")
    const planSha = PlanSha256.make("c".repeat(64))
    const baseSha = GitCommitSha.make("d".repeat(40))
    const epicPlan: CompiledPlan = {
      runId: epicRunId,
      level: "epic",
      mode: { _tag: "Manual" },
      baseSha,
      planSha,
      units: [
        {
          _tag: "SliceUnit",
          unitId: sliceUnitId,
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          earsKeys: [],
          branch: sliceBranch,
        },
      ],
      sharedStepPaths: [],
    }
    const llmRunId = WorkflowRunId.make("run-rebuild-llm-states-1")
    const llmPlan: CompiledPlan = {
      ...epicPlan,
      runId: llmRunId,
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        yield* seedEpicAndLlmRebuildJournal(client, {
          epicRunId,
          llmRunId,
          sliceUnitId,
          sliceBranch,
          epicPlan,
          llmPlan,
        })

        const rebuilt = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), {
          client,
          nowMs: () => 999_000,
        })
        expect(rebuilt).toBe(2)

        const epicRun = yield* query.getRun(epicRunId)
        expect(Option.getOrUndefined(epicRun)?.state).toBe("waiting")
        const epicUnits = yield* query.listUnits(epicRunId)
        expect(epicUnits[0]?.status).toBe("completed")

        const llmRun = yield* query.getRun(llmRunId)
        expect(Option.getOrUndefined(llmRun)?.state).toBe("completed")
      }).pipe(
        Effect.ensuring(cleanupRunsAndJournal(client, [epicRunId, llmRunId]).pipe(Effect.ignore)),
        Effect.provide(layer),
      ),
    )
  })

  it("F-21.4: projection writer and query fail closed when repoRoot is omitted and process.cwd() is invalid (never falls back to /tmp)", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/")
    try {
      const layer = Layer.merge(
        makeWorkflowProjectionWriterLayer(),
        makeWorkflowReadModelQueryLayer(),
      )
      const [writeErr, queryErr, probeState] = await Effect.runPromise(
        Effect.gen(function* () {
          const writer = yield* WorkflowProjectionWriter
          const query = yield* WorkflowReadModelQuery
          const wErr = yield* writer
            .upsertRun({
              runId: WorkflowRunId.make("run-invalid-cwd-1"),
              executionId: WorkflowExecutionId.make("exec-invalid-cwd-1"),
              level: "slice",
              planSha: PlanSha256.make("a".repeat(64)),
              baseSha: GitCommitSha.make("b".repeat(40)),
              state: "running",
              updatedMs: WorkflowTimestampMs.make(1_000),
            })
            .pipe(Effect.flip)
          const qErr = yield* query
            .getRun(WorkflowRunId.make("run-invalid-cwd-1"))
            .pipe(Effect.flip)
          const pState = yield* query.probeAvailability
          return [wErr, qErr, pState] as const
        }).pipe(Effect.provide(layer)),
      )
      expect(writeErr).toBeInstanceOf(WorkflowStoreUnavailableError)
      expect(queryErr).toBeInstanceOf(WorkflowStoreUnavailableError)
      expect(probeState).toBe("inactive")
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it("SPEC-0030 2nd-pass: rebuildWorkflowReadModelViews records rejected attempt on UnitOutcome.Escalated and fails closed on empty Complete.Success payload or unknown DispatchUnitAgent unitId", async () => {
    const client = createClient()
    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot: harness.getRepoRoot(), client }),
      makeWorkflowReadModelQueryLayer({ repoRoot: harness.getRepoRoot(), client }),
    )
    const escRunId = WorkflowRunId.make("run-2ndpass-esc-1")
    const emptyReplyRunId = WorkflowRunId.make("run-2ndpass-empty-reply-1")
    const unknownUnitRunId = WorkflowRunId.make("run-2ndpass-unknown-unit-1")
    const sliceUnitId = WorkUnitId.make("slice-1")
    const basePlan = {
      level: "epic" as const,
      mode: { _tag: "Manual" as const },
      baseSha: GitCommitSha.make("e".repeat(40)),
      planSha: PlanSha256.make("f".repeat(64)),
      units: [
        {
          _tag: "SliceUnit" as const,
          unitId: sliceUnitId,
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
          earsKeys: [],
          branch: SliceBranchName.make("slice/esc-1"),
        },
      ],
      sharedStepPaths: [],
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: escRunId,
          tag: "run",
          payload: JSON.stringify({ plan: { ...basePlan, runId: escRunId } }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: escRunId,
          tag: "deferred",
          payload: JSON.stringify({
            name: `unit/${sliceUnitId}/1`,
            exit: {
              _tag: "Success",
              value: UnitOutcome.cases.Escalated.make({
                unitId: sliceUnitId,
                escalation: UnitEscalation.cases.RetryBudgetExhausted.make({
                  lastRejection: UnitRejection.cases.StampMissing.make({}),
                }),
              }),
            },
          }),
        })
        yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), { client, nowMs: () => 50_000 })
        const attempts = yield* query.listAttempts(escRunId)
        expect(attempts).toHaveLength(1)
        expect(attempts[0]?.verdict).toBe("rejected")
      }).pipe(
        Effect.ensuring(cleanupRunsAndJournal(client, [escRunId]).pipe(Effect.ignore)),
        Effect.provide(layer),
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: emptyReplyRunId,
          tag: "run",
          payload: JSON.stringify({ plan: { ...basePlan, runId: emptyReplyRunId } }),
        })
        const verifyMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: emptyReplyRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `VerifyUnit/${sliceUnitId}/1` }),
        })
        yield* insertJournalReplyExit(client, verifyMsg, {
          _tag: "Success",
          value: { _tag: "Complete", exit: { _tag: "Success" } },
        })
        const err = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), { client }).pipe(
          Effect.flip,
        )
        match(err)
          .with({ _tag: "WorkflowStoreUnavailableError" }, (e) => {
            expect(e.reason).toContain("Complete.Success without payload")
          })
          .with({ _tag: "WorkspaceFsError" }, { _tag: "WriterLeaseHeldError" }, (other) =>
            expect.unreachable(`expected WorkflowStoreUnavailableError, got ${other._tag}`),
          )
          .exhaustive()
      }).pipe(
        Effect.ensuring(cleanupRunsAndJournal(client, [emptyReplyRunId]).pipe(Effect.ignore)),
        Effect.provide(layer),
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: unknownUnitRunId,
          tag: "run",
          payload: JSON.stringify({ plan: { ...basePlan, runId: unknownUnitRunId } }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: unknownUnitRunId,
          tag: "activity",
          payload: JSON.stringify({ name: "DispatchUnitAgent/unknown-unit/1" }),
        })
        const err = yield* rebuildWorkflowReadModelViews(harness.getRepoRoot(), { client }).pipe(
          Effect.flip,
        )
        match(err)
          .with({ _tag: "WorkflowStoreUnavailableError" }, (e) => {
            expect(e.reason).toContain("targets unknown unit")
          })
          .with({ _tag: "WorkspaceFsError" }, { _tag: "WriterLeaseHeldError" }, (other) =>
            expect.unreachable(`expected WorkflowStoreUnavailableError, got ${other._tag}`),
          )
          .exhaustive()
      }).pipe(
        Effect.ensuring(cleanupRunsAndJournal(client, [unknownUnitRunId]).pipe(Effect.ignore)),
        Effect.provide(layer),
      ),
    )
  })
})
