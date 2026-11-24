import { describe, expect, it, vi } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import {
  AbsoluteRepoRoot,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  ShipAttempt,
  type ShipAttemptStatus,
  WorkflowRunId,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  WorkspaceTreeHash,
  WriterLeaseHeldError,
  encodeShipAttemptKey,
} from "@harness/contract"
import { makeWorkflowOmnigraphClient, type OmnigraphClient } from "@harness/graph"
import { ShipAttemptStore } from "@harness/service"
import {
  allocateShipAttemptImpl,
  listShipAttemptsForRunImpl,
  makeShipAttemptStoreLayer,
  updateShipAttemptStatusImpl,
} from "../src/workflow/ship-attempt-store-live.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

interface StoredShipAttemptRow {
  readonly shipKey: string
  readonly runId: string
  readonly attempt: number
  readonly treeHash: string
  readonly status: ShipAttemptStatus
  readonly updatedMs: number
}

interface MockOmnigraphState {
  graphCommitSeq: number
  currentCommitId: string
  readonly attempts: Map<string, StoredShipAttemptRow>
  lease: { readonly owner: string; readonly leaseEpoch: number } | undefined
  inject412Count: number
  inject429Count: number
  staleCommit412Hits?: number
  forceQueryError?: Error | undefined
  readonly onReadAttemptsForRun?: ((callIndex: number) => Promise<void>) | undefined
  readonly onBeforeInsertAttempt?: ((callIndex: number) => Promise<void>) | undefined
  readonly onInsertAttemptCommitted?: ((callIndex: number) => void) | undefined
}

const makeConflictError = (status: 409 | 412 | 429, message: string): Error =>
  Object.assign(new Error(message), { status })

type InvokeQueryResult = Awaited<ReturnType<Omnigraph["queries"]["invoke"]>>

const fakeReadResult = (
  queryName: string,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  graphCommitId: string | null = null,
): InvokeQueryResult => ({
  queryName,
  rowCount: rows.length,
  rows: [...rows],
  graphCommitId,
  target: { branch: "main" },
})

const fakeMutationResult = (queryName: string, affectedNodes: number): InvokeQueryResult => ({
  queryName,
  affectedNodes,
  affectedEdges: 0,
  branch: "main",
  commit: null,
})

const readStringParam = (rawParams: unknown, key: string): string => {
  if (typeof rawParams !== "object" || rawParams === null) {
    return ""
  }
  const value = Reflect.get(rawParams, key)
  return typeof value === "string" ? value : ""
}

const readNumberParam = (rawParams: unknown, key: string): number => {
  if (typeof rawParams !== "object" || rawParams === null) {
    return 0
  }
  const value = Reflect.get(rawParams, key)
  return typeof value === "number" ? value : 0
}

const makeMockOmnigraphClient = (state: MockOmnigraphState): Omnigraph => {
  const baseClient = makeWorkflowOmnigraphClient({
    baseUrl: "http://127.0.0.1:1",
    token: "test-token",
  })

  let readCalls = 0
  let insertCalls = 0
  const invokeHandler: typeof baseClient.queries.invoke = async (name, input, opts) => {
    const rawParams = input?.params
    if (state.forceQueryError !== undefined) {
      throw state.forceQueryError
    }
    if (name === "wf_get_writer_lease") {
      return fakeReadResult(
        name,
        state.lease !== undefined
          ? [
              {
                name: "engine",
                owner: state.lease.owner,
                leaseEpoch: state.lease.leaseEpoch,
                heartbeatMs: Date.now(),
              },
            ]
          : [],
        state.currentCommitId,
      )
    }

    if (name === "wf_ship_attempts_for_run") {
      readCalls += 1
      const callIdx = readCalls
      const runId = readStringParam(rawParams, "runId")
      const rows = Array.from(state.attempts.values())
        .filter((r) => r.runId === runId)
        .sort((a, b) => a.attempt - b.attempt)
        .map((r) => ({ ...r }))
      const commitIdSnapshot = state.currentCommitId
      if (state.onReadAttemptsForRun !== undefined) {
        await state.onReadAttemptsForRun(callIdx)
      }
      return fakeReadResult(name, rows, commitIdSnapshot)
    }

    if (name === "wf_get_ship_attempt") {
      const shipKey = readStringParam(rawParams, "shipKey")
      const found = state.attempts.get(shipKey)
      return fakeReadResult(name, found !== undefined ? [{ ...found }] : [], state.currentCommitId)
    }

    if (name === "wf_insert_ship_attempt") {
      insertCalls += 1
      const callIdx = insertCalls
      if (state.onBeforeInsertAttempt !== undefined) {
        await state.onBeforeInsertAttempt(callIdx)
      }
      if (state.inject429Count > 0) {
        state.inject429Count -= 1
        throw makeConflictError(429, "Too Many Requests")
      }
      if (state.inject412Count > 0) {
        state.inject412Count -= 1
        throw makeConflictError(412, "Simulated OCC conflict")
      }
      if (opts?.ifGraphCommit !== undefined && opts.ifGraphCommit !== state.currentCommitId) {
        state.staleCommit412Hits = (state.staleCommit412Hits ?? 0) + 1
        throw makeConflictError(
          412,
          `Stale ifGraphCommit '${opts.ifGraphCommit}' != '${state.currentCommitId}'`,
        )
      }
      const shipKey = readStringParam(rawParams, "shipKey")
      if (state.attempts.has(shipKey)) {
        throw makeConflictError(409, `Duplicate shipKey '${shipKey}'`)
      }
      const statusStr = readStringParam(rawParams, "status")
      const row: StoredShipAttemptRow = {
        shipKey,
        runId: readStringParam(rawParams, "runId"),
        attempt: readNumberParam(rawParams, "attempt"),
        treeHash: readStringParam(rawParams, "treeHash"),
        status: (statusStr === "passed" || statusStr === "failed"
          ? statusStr
          : "running") satisfies ShipAttemptStatus,
        updatedMs: readNumberParam(rawParams, "updatedMs"),
      }
      state.attempts.set(shipKey, row)
      state.graphCommitSeq += 1
      state.currentCommitId = `commit-${state.graphCommitSeq}`
      state.onInsertAttemptCommitted?.(callIdx)
      return fakeMutationResult(name, 1)
    }

    if (name === "wf_update_ship_attempt") {
      if (state.inject412Count > 0) {
        state.inject412Count -= 1
        throw makeConflictError(412, "Simulated update OCC conflict")
      }
      if (opts?.ifGraphCommit !== undefined && opts.ifGraphCommit !== state.currentCommitId) {
        throw makeConflictError(
          412,
          `Stale update ifGraphCommit '${opts.ifGraphCommit}' != '${state.currentCommitId}'`,
        )
      }
      const shipKey = readStringParam(rawParams, "shipKey")
      const existing = state.attempts.get(shipKey)
      if (existing === undefined) {
        throw new Error(`Missing shipKey '${shipKey}'`)
      }
      const statusStr = readStringParam(rawParams, "status")
      const nextStatus: ShipAttemptStatus =
        statusStr === "passed" || statusStr === "failed" ? statusStr : "running"
      state.attempts.set(shipKey, {
        ...existing,
        status: nextStatus,
        updatedMs: readNumberParam(rawParams, "updatedMs") || existing.updatedMs,
      })
      state.graphCommitSeq += 1
      state.currentCommitId = `commit-${state.graphCommitSeq}`
      return fakeMutationResult(name, 1)
    }

    throw new Error(`Unexpected query '${name}'`)
  }

  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      if (prop === "queries") {
        return new Proxy(target.queries, {
          get(qTarget, qProp, qReceiver) {
            if (qProp === "invoke") {
              return invokeHandler
            }
            return Reflect.get(qTarget, qProp, qReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

const makeRunId = (suffix = "01") => WorkflowRunId.make(`run-ship-store-${suffix}`)
const makeHash = (ch = "a") => WorkspaceTreeHash.make(ch.repeat(64))
const repoRoot = AbsoluteRepoRoot.make("/tmp/wf4-ship-attempt-store")
const lockFilePath = LeaseFilePath.make("/tmp/wf4-ship-attempt-store/.git/harness/daemon.lock")

describe("ShipAttemptStoreLive", () => {
  it.live(
    "allocates monotonic attempts, updates status running -> passed | failed, and lists sorted attempts",
    () =>
      Effect.gen(function* () {
        const state: MockOmnigraphState = {
          graphCommitSeq: 1,
          currentCommitId: "commit-1",
          attempts: new Map(),
          lease: { owner: "daemon-1#100", leaseEpoch: 3 },
          inject412Count: 0,
          inject429Count: 0,
        }
        const client = makeMockOmnigraphClient(state)
        let clock = 5000
        const layer = makeShipAttemptStoreLayer({
          repoRoot,
          client,
          expectedLeaseEpoch: LeaseEpoch.make(3),
          expectedLeaseOwner: "daemon-1#100",
          lockFilePath,
          nowMs: () => {
            clock += 10
            return clock
          },
        })

        const runId = makeRunId("mono")
        const { a1, a2, updated1, updated2, listed } = yield* Effect.gen(function* () {
          const store = yield* ShipAttemptStore
          const first = yield* store.allocateAttempt({ runId, treeHash: makeHash("a") })
          const second = yield* store.allocateAttempt({ runId, treeHash: makeHash("b") })
          const up1 = yield* store.updateStatus({
            runId,
            attempt: first.attempt,
            status: "failed",
          })
          const up2 = yield* store.updateStatus({
            runId,
            attempt: second.attempt,
            status: "passed",
          })
          const all = yield* store.listAttemptsForRun(runId)
          return { a1: first, a2: second, updated1: up1, updated2: up2, listed: all }
        }).pipe(Effect.provide(layer))

        expect(a1.attempt).toBe(ShipAttempt.make(1))
        expect(a1.shipKey).toBe(encodeShipAttemptKey(runId, ShipAttempt.make(1)))
        expect(a1.status).toBe("running")
        expect(a2.attempt).toBe(ShipAttempt.make(2))
        expect(updated1.status).toBe("failed")
        expect(updated2.status).toBe("passed")
        expect(listed).toEqual([
          {
            shipKey: encodeShipAttemptKey(runId, ShipAttempt.make(1)),
            runId,
            attempt: ShipAttempt.make(1),
            treeHash: makeHash("a"),
            status: "failed",
            updatedMs: WorkflowTimestampMs.make(5030),
          },
          {
            shipKey: encodeShipAttemptKey(runId, ShipAttempt.make(2)),
            runId,
            attempt: ShipAttempt.make(2),
            treeHash: makeHash("b"),
            status: "passed",
            updatedMs: WorkflowTimestampMs.make(5040),
          },
        ])
      }),
  )

  it.live(
    "retries 412 OCC contention and 429 rate-limit under concurrent callers without attempt collision",
    () =>
      Effect.gen(function* () {
        const state: MockOmnigraphState = {
          graphCommitSeq: 1,
          currentCommitId: "commit-1",
          attempts: new Map(),
          lease: { owner: "daemon-1#100", leaseEpoch: 1 },
          inject412Count: 1,
          inject429Count: 1,
        }
        const client = makeMockOmnigraphClient(state)
        const runId = makeRunId("occ")
        const opts = {
          repoRoot,
          client,
          expectedLeaseEpoch: LeaseEpoch.make(1),
          lockFilePath,
          nowMs: () => 9000,
        }

        const [first, second] = yield* Effect.all(
          [
            allocateShipAttemptImpl({ runId, treeHash: makeHash("c") }, opts),
            allocateShipAttemptImpl({ runId, treeHash: makeHash("d") }, opts),
          ],
          { concurrency: "unbounded" },
        )

        const attempts = [first.attempt, second.attempt].sort((x, y) => x - y)
        expect(attempts).toEqual([ShipAttempt.make(1), ShipAttempt.make(2)])
        expect(state.inject412Count).toBe(0)
        expect(state.inject429Count).toBe(0)
      }),
  )

  it.live("fails on missing attempt updateStatus and enforces writer lease epoch fencing", () =>
    Effect.gen(function* () {
      const state: MockOmnigraphState = {
        graphCommitSeq: 1,
        currentCommitId: "commit-1",
        attempts: new Map(),
        lease: { owner: "daemon-2#200", leaseEpoch: 5 },
        inject412Count: 0,
        inject429Count: 0,
      }
      const client = makeMockOmnigraphClient(state)
      const runId = makeRunId("fence")

      // Missing attempt -> WorkflowStoreUnavailableError
      const missingErr = yield* Effect.flip(
        updateShipAttemptStatusImpl(
          { runId, attempt: ShipAttempt.make(9), status: "passed" },
          {
            repoRoot,
            client,
            expectedLeaseEpoch: LeaseEpoch.make(5),
            lockFilePath,
          },
        ),
      )
      expect(missingErr).toBeInstanceOf(WorkflowStoreUnavailableError)

      // Stale lease epoch -> WriterLeaseHeldError
      const staleLeaseErr = yield* Effect.flip(
        allocateShipAttemptImpl(
          { runId, treeHash: makeHash("e") },
          {
            repoRoot,
            client,
            expectedLeaseEpoch: LeaseEpoch.make(4),
            lockFilePath,
          },
        ),
      )
      expect(staleLeaseErr).toBeInstanceOf(WriterLeaseHeldError)

      // Absent lease with fence required -> WriterLeaseHeldError
      state.lease = undefined
      const absentLeaseErr = yield* Effect.flip(
        listShipAttemptsForRunImpl(runId, {
          repoRoot,
          client,
          expectedLeaseEpoch: LeaseEpoch.make(5),
          lockFilePath,
        }),
      )
      expect(absentLeaseErr).toBeInstanceOf(WriterLeaseHeldError)
    }),
  )

  it.live(
    "handles real concurrent read-overlap ifGraphCommit 412 collision via Deferred barrier",
    () =>
      Effect.gen(function* () {
        const makePromiseGate = () => {
          let resolve: () => void = () => undefined
          const promise = new Promise<void>((r) => {
            resolve = r
          })
          return { promise, resolve }
        }
        const bothRead = yield* Deferred.make<void>()
        const firstCommitted = yield* Deferred.make<void>()
        const bothReadGate = makePromiseGate()
        const firstCommittedGate = makePromiseGate()
        const state: MockOmnigraphState = {
          graphCommitSeq: 1,
          currentCommitId: "commit-1",
          attempts: new Map(),
          lease: { owner: "daemon-1#100", leaseEpoch: 1 },
          inject412Count: 0,
          inject429Count: 0,
          staleCommit412Hits: 0,
          onReadAttemptsForRun: async (callIndex) => {
            if (callIndex === 1) {
              await bothReadGate.promise
            } else if (callIndex === 2) {
              Deferred.doneUnsafe(bothRead, Effect.void)
              bothReadGate.resolve()
            }
          },
          onBeforeInsertAttempt: async (callIndex) => {
            if (callIndex === 2) {
              await firstCommittedGate.promise
            }
          },
          onInsertAttemptCommitted: (callIndex) => {
            if (callIndex === 1) {
              Deferred.doneUnsafe(firstCommitted, Effect.void)
              firstCommittedGate.resolve()
            }
          },
        }
        const client = makeMockOmnigraphClient(state)
        const runId = makeRunId("overlap")
        const opts = {
          repoRoot,
          client,
          expectedLeaseEpoch: LeaseEpoch.make(1),
          lockFilePath,
          nowMs: () => 9500,
        }

        const [first, second] = yield* Effect.all(
          [
            allocateShipAttemptImpl({ runId, treeHash: makeHash("a") }, opts),
            allocateShipAttemptImpl({ runId, treeHash: makeHash("b") }, opts),
          ],
          { concurrency: "unbounded" },
        )

        yield* Deferred.await(bothRead)
        yield* Deferred.await(firstCommitted)
        expect([first.attempt, second.attempt].sort((x, y) => x - y)).toEqual([
          ShipAttempt.make(1),
          ShipAttempt.make(2),
        ])
        expect(state.staleCommit412Hits).toBe(1)
      }),
  )

  it.live(
    "retries updateStatus on 412 OCC conflict and fails after MAX_ALLOCATE_CAS_RETRIES exhaustion",
    () =>
      Effect.gen(function* () {
        const state: MockOmnigraphState = {
          graphCommitSeq: 1,
          currentCommitId: "commit-1",
          attempts: new Map(),
          lease: { owner: "daemon-1#100", leaseEpoch: 1 },
          inject412Count: 0,
          inject429Count: 0,
        }
        const client = makeMockOmnigraphClient(state)
        const runId = makeRunId("cas-up")
        const opts = {
          repoRoot,
          client,
          expectedLeaseEpoch: LeaseEpoch.make(1),
          lockFilePath,
          nowMs: () => 7000,
        }
        const allocated = yield* allocateShipAttemptImpl({ runId, treeHash: makeHash("f") }, opts)

        // updateStatus retries through 2 consecutive 412 conflicts and succeeds
        state.inject412Count = 2
        const updated = yield* updateShipAttemptStatusImpl(
          { runId, attempt: allocated.attempt, status: "passed" },
          opts,
        )
        expect(updated.status).toBe("passed")
        expect(state.inject412Count).toBe(0)

        // Exhaustion (> MAX_ALLOCATE_CAS_RETRIES = 16) fails with WorkflowStoreUnavailableError
        state.inject412Count = 30
        const exhaustedErr = yield* Effect.flip(
          allocateShipAttemptImpl({ runId, treeHash: makeHash("c") }, opts),
        )
        expect(exhaustedErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        // Initial attempt (0) + 16 retries = 17 412s consumed
        expect(state.inject412Count).toBe(13)
      }),
  )

  it.live(
    "converts WriterLeaseHeldError to WorkflowStoreUnavailableError when expectedLeaseEpoch is omitted",
    () =>
      Effect.gen(function* () {
        const state: MockOmnigraphState = {
          graphCommitSeq: 1,
          currentCommitId: "commit-1",
          attempts: new Map(),
          lease: undefined,
          inject412Count: 0,
          inject429Count: 0,
          forceQueryError: new WriterLeaseHeldError({
            holderId: LeaseHolderId.make("daemon-other-99"),
            lockFilePath,
          }),
        }
        const client = makeMockOmnigraphClient(state)
        const err = yield* Effect.flip(
          allocateShipAttemptImpl(
            { runId: makeRunId("nolse"), treeHash: makeHash("d") },
            { repoRoot, client, lockFilePath },
          ),
        )
        expect(err).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect(err.message).toContain("daemon-other-99")
      }),
  )

  it.live("resolves repoRoot from process.cwd() fallback and fails closed on invalid cwd", () =>
    Effect.gen(function* () {
      const state: MockOmnigraphState = {
        graphCommitSeq: 1,
        currentCommitId: "commit-1",
        attempts: new Map(),
        lease: undefined,
        inject412Count: 0,
        inject429Count: 0,
      }
      const client = makeMockOmnigraphClient(state)
      const runId = makeRunId("cwd-ok")

      // Valid process.cwd() fallback succeeds without options.repoRoot
      const rows = yield* listShipAttemptsForRunImpl(runId, { client })
      expect(rows).toEqual([])

      // Invalid process.cwd() fails closed with WorkflowStoreUnavailableError
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/")
      const cwdErr = yield* Effect.flip(listShipAttemptsForRunImpl(runId, { client })).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            cwdSpy.mockRestore()
          }),
        ),
      )
      expect(cwdErr).toBeInstanceOf(WorkflowStoreUnavailableError)
      expect(cwdErr.message).toContain("AbsoluteRepoRoot")
    }),
  )

  it.live(
    "rejects rows with mismatched shipKey and routes listShipAttemptsForRunImpl through readGate",
    () =>
      Effect.gen(function* () {
        const runId = makeRunId("decode")
        const otherRunId = makeRunId("other1")
        const state: MockOmnigraphState = {
          graphCommitSeq: 1,
          currentCommitId: "commit-1",
          attempts: new Map(),
          lease: undefined,
          inject412Count: 0,
          inject429Count: 0,
        }
        const mismatchedKey = encodeShipAttemptKey(otherRunId, ShipAttempt.make(1))
        state.attempts.set(mismatchedKey, {
          shipKey: mismatchedKey,
          runId,
          attempt: 1,
          treeHash: makeHash("a"),
          status: "running",
          updatedMs: 1000,
        })

        let readGateCalls = 0
        const client = makeMockOmnigraphClient(state)
        const mismatchErr = yield* Effect.flip(
          listShipAttemptsForRunImpl(runId, {
            repoRoot,
            client,
            readGate: (eff) => {
              readGateCalls += 1
              return eff
            },
          }),
        )
        expect(readGateCalls).toBe(1)
        expect(mismatchErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect(mismatchErr.message).toContain("does not match")

        // Also verify attempt mismatch in shipKey is rejected
        state.attempts.clear()
        const wrongAttemptKey = encodeShipAttemptKey(runId, ShipAttempt.make(2))
        state.attempts.set(wrongAttemptKey, {
          shipKey: wrongAttemptKey,
          runId,
          attempt: 1,
          treeHash: makeHash("b"),
          status: "passed",
          updatedMs: 2000,
        })
        const attemptMismatchErr = yield* Effect.flip(
          listShipAttemptsForRunImpl(runId, { repoRoot, client }),
        )
        expect(attemptMismatchErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect(attemptMismatchErr.message).toContain("does not match")
      }),
  )

  it.live(
    "rejects invalid state transitions (passed -> failed, failed -> passed, running -> running) with WorkflowStoreUnavailableError",
    () =>
      Effect.gen(function* () {
        const state: MockOmnigraphState = {
          graphCommitSeq: 1,
          currentCommitId: "commit-1",
          attempts: new Map(),
          lease: { owner: "daemon-1#100", leaseEpoch: 2 },
          inject412Count: 0,
          inject429Count: 0,
        }
        const client = makeMockOmnigraphClient(state)
        const runId = makeRunId("transitions")
        const opts = {
          repoRoot,
          client,
          expectedLeaseEpoch: LeaseEpoch.make(2),
          lockFilePath,
          nowMs: () => 8000,
        }

        const runningAttempt = yield* allocateShipAttemptImpl(
          { runId, treeHash: makeHash("a") },
          opts,
        )
        const runningToRunningErr = yield* Effect.flip(
          updateShipAttemptStatusImpl(
            { runId, attempt: runningAttempt.attempt, status: "running" },
            opts,
          ),
        )
        expect(runningToRunningErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect(runningToRunningErr.message).toContain("Invalid transition 'running' -> 'running'")

        yield* updateShipAttemptStatusImpl(
          { runId, attempt: runningAttempt.attempt, status: "passed" },
          opts,
        )
        const passedToFailedErr = yield* Effect.flip(
          updateShipAttemptStatusImpl(
            { runId, attempt: runningAttempt.attempt, status: "failed" },
            opts,
          ),
        )
        expect(passedToFailedErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect(passedToFailedErr.message).toContain("Cannot transition terminal WfShipAttempt")
        expect(passedToFailedErr.message).toContain("from 'passed' to 'failed'")

        const failedAttempt = yield* allocateShipAttemptImpl(
          { runId, treeHash: makeHash("b") },
          opts,
        )
        yield* updateShipAttemptStatusImpl(
          { runId, attempt: failedAttempt.attempt, status: "failed" },
          opts,
        )
        const failedToPassedErr = yield* Effect.flip(
          updateShipAttemptStatusImpl(
            { runId, attempt: failedAttempt.attempt, status: "passed" },
            opts,
          ),
        )
        expect(failedToPassedErr).toBeInstanceOf(WorkflowStoreUnavailableError)
        expect(failedToPassedErr.message).toContain("Cannot transition terminal WfShipAttempt")
        expect(failedToPassedErr.message).toContain("from 'failed' to 'passed'")
      }),
  )
})
