import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect, Layer, Option, Schema, Tracer } from "effect"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  AbsoluteRepoRoot,
  AgentFailureReason,
  AttemptNumber,
  CompiledPlan,
  EarsRequirementKey,
  GitCommitSha,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  MaxConcurrency,
  MergeSliceWaveOutcome,
  MessageKey,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanJsonPayload,
  PlanSha256,
  ReplyKey,
  RunnerId,
  SHARED_STEP_UNIT_ID,
  type SeqKey,
  SliceBranchName,
  StubSymbolKey,
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
  encodeSeqKey,
  makeWorkflowAttemptKey,
  makeWorkflowUnitKey,
} from "@harness/contract"
import { type SpanSample, decideSpanBudgets } from "@harness/gates"
import { makeWorkflowOmnigraphClient, type OmnigraphClient } from "@harness/graph"
import { WorkflowProjectionWriter, WorkflowReadModelQuery } from "@harness/service"
import {
  invokeWorkflowStoreQuery,
  makeWorkflowProjectionWriterLayer,
  makeWorkflowReadModelQueryLayer,
  rebuildWorkflowReadModelViews,
} from "../src/index.js"
import { JOURNAL_PAGE_LIMIT, MAX_JOURNAL_SCAN_PAGES } from "../src/workflow/read-model-rebuild.js"

const runWithTestTracer = <A, E, R>(
  testId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly result: A; readonly spans: ReadonlyArray<SpanSample> }, E, R> =>
  Effect.gen(function* () {
    const recorded = new Map<string, SpanSample>()
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        const parentSpanId = Option.match(options.parent, {
          onNone: () => null,
          onSome: (p) => p.spanId,
        })
        const startTimeMs =
          typeof span.status.startTime === "bigint"
            ? Number(span.status.startTime) / 1_000_000
            : undefined
        recorded.set(span.spanId, {
          spanId: span.spanId,
          name: span.name,
          parentSpanId,
          ...(startTimeMs !== undefined ? { startTimeMs } : {}),
        })
        const origEnd = span.end.bind(span)
        span.end = (endTime, exit) => {
          const durationMs =
            typeof endTime === "bigint" && typeof span.status.startTime === "bigint"
              ? Number(endTime - span.status.startTime) / 1_000_000
              : undefined
          const endTimeMs = typeof endTime === "bigint" ? Number(endTime) / 1_000_000 : undefined
          const exitMeta = match(exit)
            .with({ _tag: "Success" }, () => ({ exitTag: "Success" as const, errorTag: null }))
            .with({ _tag: "Failure" }, ({ cause }) =>
              Option.match(Cause.findErrorOption(cause), {
                onSome: (err) => ({
                  exitTag: "Failure" as const,
                  errorTag: err instanceof Error ? err.name : null,
                }),
                onNone: () => ({ exitTag: "Defect" as const, errorTag: null }),
              }),
            )
            .exhaustive()
          recorded.set(span.spanId, {
            spanId: span.spanId,
            name: span.name,
            parentSpanId,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(startTimeMs !== undefined ? { startTimeMs } : {}),
            ...(endTimeMs !== undefined ? { endTimeMs } : {}),
            exitTag: exitMeta.exitTag,
            errorTag: exitMeta.errorTag,
          })
          origEnd(endTime, exit)
        }
        return span
      },
    })
    const result = yield* effect.pipe(
      Effect.withSpan(`Test:${testId}`),
      Effect.provideService(Tracer.Tracer, tracer),
    )
    return { result, spans: Array.from(recorded.values()) }
  })

const graphConfigDir = resolve(import.meta.dirname, "../../graph")
const omnigraphBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")
const omnigraphServerBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph-server")

const allocateLoopbackPort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.unref()
    server.on("error", rejectPort)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr === null || typeof addr === "string") {
        server.close(() => rejectPort(new Error("failed to allocate ephemeral port")))
        return
      }
      const { port } = addr
      server.close((err) => {
        if (err) {
          rejectPort(err)
          return
        }
        resolvePort(port)
      })
    })
  })

const unlockClusterIfLocked = (clusterDir: string, applyStdout: string): void => {
  const lockIds = new Set<string>()
  for (const m of applyStdout.matchAll(/Admission lock:\s*([A-Z0-9._-]+)/gi)) {
    if (m[1]) lockIds.add(m[1])
  }
  const lockJsonPath = join(clusterDir, "__cluster", "lock.json")
  if (existsSync(lockJsonPath)) {
    const parsed = Schema.decodeSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(readFileSync(lockJsonPath, "utf8"))
    for (const key of ["lock_id", "id", "lockId"]) {
      const val = parsed[key]
      if (typeof val === "string" && val.length > 0) lockIds.add(val)
    }
  }
  for (const lockId of lockIds) {
    execFileSync(
      omnigraphBin,
      ["cluster", "force-unlock", lockId, "--target", `file://${clusterDir}`],
      { encoding: "utf8" },
    )
  }
}

const waitForServerReady = async (baseUrl: string, proc: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`omnigraph-server exited early with code ${proc.exitCode}`)
    }
    try {
      const res = await fetch(`${baseUrl}/readyz`)
      if (res.ok) {
        const body = (await res.json()) as { readonly ready?: boolean }
        if (body.ready === true) return
      }
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for omnigraph-server readiness at ${baseUrl}`)
}

const stopChildProcess = async (proc: ChildProcess | undefined): Promise<void> => {
  if (!proc || proc.exitCode !== null) return
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL")
    }, 3_000)
    proc.once("exit", () => {
      clearTimeout(timer)
      resolveStop()
    })
    proc.kill("SIGTERM")
  })
}

const unwrapSeqKey = (value: bigint): SeqKey =>
  match(encodeSeqKey(value))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      throw new Error(failure)
    })
    .exhaustive()

type Omnigraph = InstanceType<typeof OmnigraphClient>
type InvokeQueryResult = Awaited<ReturnType<Omnigraph["queries"]["invoke"]>>

const fakeReadResult = (
  queryName: string,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  graphCommitId: string | null = "cmt-mock-1",
): InvokeQueryResult => ({
  queryName,
  rowCount: rows.length,
  rows: [...rows],
  graphCommitId,
  target: { branch: "main" },
})

const wrapQueriesInvoke = (
  client: Omnigraph,
  onInvoke: (
    name: string,
    orig: typeof client.queries.invoke,
    input?: Parameters<typeof client.queries.invoke>[1],
    opts?: Parameters<typeof client.queries.invoke>[2],
  ) => ReturnType<typeof client.queries.invoke>,
): Omnigraph =>
  new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "queries") {
        return new Proxy(target.queries, {
          get(qTarget, qProp, qReceiver) {
            if (qProp === "invoke") {
              return (
                name: string,
                input?: Parameters<typeof target.queries.invoke>[1],
                opts?: Parameters<typeof target.queries.invoke>[2],
              ) => onInvoke(name, qTarget.invoke.bind(qTarget), input, opts)
            }
            return Reflect.get(qTarget, qProp, qReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })

describe("WF-3 WorkflowProjectionWriterLive, WorkflowReadModelQueryLive & rebuildWorkflowReadModelViews", () => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  let repoRoot: AbsoluteRepoRoot
  const cliToken = "wf3-readmodel-cli-token"
  let nextMsgId = 300000000000000001n
  let nextReplyId = 400000000000000001n

  const createClient = () =>
    makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken })

  const nextMsgKey = () => {
    const id = nextMsgId
    nextMsgId += 1n
    return { key: MessageKey.make(id.toString()), seqKey: unwrapSeqKey(id) }
  }

  const nextReplyKey = () => {
    const id = nextReplyId
    nextReplyId += 1n
    return { key: ReplyKey.make(id.toString()), seqKey: unwrapSeqKey(id) }
  }

  const insertJournalMessage = (
    client: Omnigraph,
    params: {
      readonly shardId: string
      readonly entityId: string
      readonly tag: string
      readonly payload: string
    },
  ) => {
    const op = WorkflowStoreOperation.make("WorkflowReadModelTest.insertMsg")
    const { key, seqKey } = nextMsgKey()
    return invokeWorkflowStoreQuery({
      repoRoot,
      client,
      operation: op,
      queryName: "wf_insert_request_message",
      expectMutation: true,
      params: {
        messageKey: key,
        seqKey,
        primaryKeyHash: null,
        shardId: params.shardId,
        entityType: "Workflow/HarnessTaskWorkflow",
        entityId: params.entityId,
        tag: params.tag,
        payload: params.payload,
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: key,
        deliverAtMs: null,
      },
    }).pipe(Effect.as(key))
  }

  const insertJournalReplyExit = (client: Omnigraph, requestId: MessageKey, payload: unknown) => {
    const op = WorkflowStoreOperation.make("WorkflowReadModelTest.insertReply")
    const { key, seqKey } = nextReplyKey()
    return invokeWorkflowStoreQuery({
      repoRoot,
      client,
      operation: op,
      queryName: "wf_save_reply_exit",
      expectMutation: true,
      params: {
        replyKey: key,
        seqKey,
        requestId,
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    })
  }

  const cleanupRunsAndJournal = (
    client: Omnigraph,
    runIds: ReadonlyArray<WorkflowRunId>,
    extraEntityIds: ReadonlyArray<string> = [],
  ) =>
    Effect.gen(function* () {
      const op = WorkflowStoreOperation.make("WorkflowReadModelTest.cleanup")
      for (const runId of runIds) {
        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_delete_run_views",
          params: { runId },
          expectMutation: true,
        })
      }
      for (const entityId of [...runIds, ...extraEntityIds]) {
        const rows = yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_message_keys_for_address",
          params: { entityType: "Workflow/HarnessTaskWorkflow", entityId },
          expectMutation: false,
        })
        const reqIds = Array.from(
          new Set(
            rows.flatMap((r) => {
              const parsed = Schema.decodeUnknownOption(MessageKey)(r.requestId)
              return match(parsed)
                .with({ _tag: "Some" }, ({ value }) => [value])
                .with({ _tag: "None" }, () => [])
                .exhaustive()
            }),
          ),
        )
        if (rows.length > 0) {
          yield* invokeWorkflowStoreQuery({
            repoRoot,
            client,
            operation: op,
            queryName: "wf_clear_address",
            params: {
              requestIds: reqIds,
              entityType: "Workflow/HarnessTaskWorkflow",
              entityId,
            },
            expectMutation: true,
          })
        }
      }
    })

  beforeAll(async () => {
    expect(existsSync(omnigraphBin)).toBe(true)
    expect(existsSync(omnigraphServerBin)).toBe(true)

    const tempRoot = mkdtempSync(join(tmpdir(), "wf3-read-model-"))
    tempDirs.push(tempRoot)
    repoRoot = AbsoluteRepoRoot.make(tempRoot)
    const clusterDir = join(tempRoot, "cluster")
    mkdirSync(clusterDir, { recursive: true })

    const applyOut = execFileSync(
      omnigraphBin,
      [
        "cluster",
        "apply",
        "--target",
        `file://${clusterDir}`,
        "--config",
        graphConfigDir,
        "--as",
        "harness-cli",
        "--json",
      ],
      { encoding: "utf8" },
    )
    unlockClusterIfLocked(clusterDir, applyOut)

    const port = await allocateLoopbackPort()
    serverBaseUrl = `http://127.0.0.1:${port}`
    serverProc = spawn(
      omnigraphServerBin,
      ["--cluster", `file://${clusterDir}`, "--bind", `127.0.0.1:${port}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          OMNIGRAPH_EMBEDDINGS_MOCK: "1",
          OMNIGRAPH_EMBEDDING_API_KEY: "mock",
          OMNIGRAPH_SERVER_BEARER_TOKENS_JSON: JSON.stringify({
            "harness-cli": cliToken,
            "agent-mcp": "wf3-readmodel-mcp-token",
          }),
        },
      },
    )
    serverProc.stdout?.resume()
    serverProc.stderr?.resume()
    await waitForServerReady(serverBaseUrl, serverProc)
  }, 30_000)

  afterAll(async () => {
    await stopChildProcess(serverProc)
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("probeAvailability reports 'ready' on live store and 'inactive' when Omnigraph is unreachable", async () => {
    const client = createClient()
    const readyLayer = makeWorkflowReadModelQueryLayer({ repoRoot, client })
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
    const inactiveLayer = makeWorkflowReadModelQueryLayer({ repoRoot, client: unreachableClient })
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
      makeWorkflowProjectionWriterLayer({ repoRoot, client }),
      makeWorkflowReadModelQueryLayer({ repoRoot, client }),
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
        if (attempts[0]?.verdict === "rejected") {
          expect(attempts[0].rejection._tag).toBe("AgentFailed")
        }
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
      makeWorkflowProjectionWriterLayer({ repoRoot, client }),
      makeWorkflowReadModelQueryLayer({ repoRoot, client }),
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
          rebuildWorkflowReadModelViews(repoRoot, {
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

  it("rebuildWorkflowReadModelViews reconstructs sharedStepPaths, /r2 cycles, MergeSliceWave conflicts, InterruptSignal, and Failure exits", async () => {
    const client = createClient()
    const layer = makeWorkflowReadModelQueryLayer({ repoRoot, client })
    const autoRunId = WorkflowRunId.make("run-adv-auto-1")
    const mergeRunId = WorkflowRunId.make("run-adv-merge-2")
    const escFailRunId = WorkflowRunId.make("run-adv-esc-3")
    const baseSha = GitCommitSha.make("e".repeat(40))
    const stampHash = PackageStampHash.make("a".repeat(64))
    const unit1 = WorkUnitId.make("u-1")
    const unit10 = WorkUnitId.make("u-10")
    const sliceUnit = WorkUnitId.make("u-slice-conflict")
    const sliceBranch = SliceBranchName.make("slice/u-conflict")
    const escUnit = WorkUnitId.make("u-esc")

    const autoPlan: CompiledPlan = {
      runId: autoRunId,
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
          unitId: unit1,
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
          unitId: unit10,
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
      runId: mergeRunId,
      level: "epic",
      planSha: PlanSha256.make("4".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "SliceUnit",
          unitId: sliceUnit,
          branch: sliceBranch,
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/beta")],
          earsKeys: [],
        },
      ],
      sharedStepPaths: [],
    }
    const escPlan: CompiledPlan = {
      runId: escFailRunId,
      level: "slice",
      planSha: PlanSha256.make("5".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId: escUnit,
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery

        const autoRunMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: autoRunId,
          tag: "run",
          payload: JSON.stringify({ plan: autoPlan }),
        })
        yield* insertJournalReplyExit(client, autoRunMsg, {
          _tag: "Success",
          value: { _tag: "Suspended" },
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `DispatchUnitAgent/${unit10}/1` }),
        })
        const v1Msg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `VerifyUnit/${unit10}/1`, attempt: 1 }),
        })
        yield* insertJournalReplyExit(client, v1Msg, {
          _tag: "Success",
          value: {
            _tag: "Complete",
            exit: {
              _tag: "Success",
              value: UnitOutcome.cases.Rejected.make({
                unitId: unit10,
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
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `ProjectUnitEscalated/${unit10}/1` }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `ProjectUnitEscalationRetried/${unit10}/1` }),
        })
        const v2Msg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `VerifyUnit/${unit10}/1/r2`, attempt: 1 }),
        })
        yield* insertJournalReplyExit(client, v2Msg, {
          _tag: "Success",
          value: {
            _tag: "Complete",
            exit: {
              _tag: "Success",
              value: UnitOutcome.cases.Completed.make({
                unitId: unit10,
                attempt: AttemptNumber.make(1),
                changedPaths: [OwnedRelPath.make("libs/u10/a.ts")],
                packageStampHash: stampHash,
              }),
            },
          },
        })
        const sharedMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: autoRunId,
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
          entityId: autoRunId,
          tag: "deferred",
          payload: JSON.stringify({
            name: "Workflow/InterruptSignal",
            exit: { _tag: "Success", value: null },
          }),
        })

        const mergeRunMsg = yield* insertJournalMessage(client, {
          shardId: "default:1",
          entityId: mergeRunId,
          tag: "run",
          payload: JSON.stringify({ plan: mergePlan }),
        })
        yield* insertJournalReplyExit(client, mergeRunMsg, {
          _tag: "Success",
          value: { _tag: "Suspended" },
        })
        const mergeWaveMsg = yield* insertJournalMessage(client, {
          shardId: "default:1",
          entityId: mergeRunId,
          tag: "activity",
          payload: JSON.stringify({ name: "MergeSliceWave/0" }),
        })
        yield* insertJournalReplyExit(client, mergeWaveMsg, {
          _tag: "Success",
          value: {
            _tag: "Complete",
            exit: {
              _tag: "Success",
              value: MergeSliceWaveOutcome.cases.Conflict.make({ branch: sliceBranch }),
            },
          },
        })

        const escRunMsg = yield* insertJournalMessage(client, {
          shardId: "default:2",
          entityId: escFailRunId,
          tag: "run",
          payload: JSON.stringify({ plan: escPlan }),
        })
        yield* insertJournalReplyExit(client, escRunMsg, { _tag: "Failure" })
        yield* insertJournalMessage(client, {
          shardId: "default:2",
          entityId: escFailRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `ProjectUnitEscalated/${escUnit}/1` }),
        })

        const rebuiltTotal = yield* rebuildWorkflowReadModelViews(repoRoot, {
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
    const layer = makeWorkflowReadModelQueryLayer({ repoRoot, client })
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

        const rebuilt = yield* rebuildWorkflowReadModelViews(repoRoot, {
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
      rebuildWorkflowReadModelViews(repoRoot, { client: truncatedClient }).pipe(Effect.flip),
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
      rebuildWorkflowReadModelViews(repoRoot, { client: stalledClient }).pipe(Effect.flip),
    )
    expect(stalledErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    if (stalledErr instanceof WorkflowStoreUnavailableError) {
      expect(stalledErr.reason).toContain("stalled at cursor seqKey")
    }
  })

  it("F-23.1/F-2.1/F-2.3/F-2.5: corrupt run, deferred, activity, or with_exit reply rows fail closed and preserve existing WfRun rows", async () => {
    const client = createClient()
    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot, client }),
      makeWorkflowReadModelQueryLayer({ repoRoot, client }),
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
        const corruptRunErr = yield* rebuildWorkflowReadModelViews(repoRoot, { client }).pipe(
          Effect.flip,
        )
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
        const corruptDefErr = yield* rebuildWorkflowReadModelViews(repoRoot, { client }).pipe(
          Effect.flip,
        )
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
        const corruptActErr = yield* rebuildWorkflowReadModelViews(repoRoot, { client }).pipe(
          Effect.flip,
        )
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
        const corruptReplyErr = yield* rebuildWorkflowReadModelViews(repoRoot, { client }).pipe(
          Effect.flip,
        )
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
        repoRoot,
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
      repoRoot,
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

        const rebuildErr = yield* rebuildWorkflowReadModelViews(repoRoot, staleOptions).pipe(
          Effect.flip,
        )
        expect(rebuildErr).toBeInstanceOf(WriterLeaseHeldError)
      }).pipe(Effect.provide(staleLayer)),
    )

    // Matching epoch 2 succeeds and passes ifGraphCommit on upsertReadModelEntity mutations
    const activeOptions = {
      repoRoot,
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
      makeWorkflowProjectionWriterLayer({ repoRoot, client: casClient }),
      makeWorkflowReadModelQueryLayer({ repoRoot, client: baseClient }),
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
        Effect.provide(makeWorkflowReadModelQueryLayer({ repoRoot, client: badUnitClient })),
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
        Effect.provide(makeWorkflowReadModelQueryLayer({ repoRoot, client: emptyPathsClient })),
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
        Effect.provide(makeWorkflowReadModelQueryLayer({ repoRoot, client: badAttemptClient })),
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
          makeWorkflowReadModelQueryLayer({ repoRoot, client: missingRejectionClient }),
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
      rebuildWorkflowReadModelViews(repoRoot, { client: invalidRunIdClient }).pipe(Effect.flip),
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
      rebuildWorkflowReadModelViews(repoRoot, { client: stalledDeleteClient }).pipe(Effect.flip),
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
      rebuildWorkflowReadModelViews(repoRoot, { client: overflowClearClient }).pipe(Effect.flip),
    )
    expect(overflowErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    if (overflowErr instanceof WorkflowStoreUnavailableError) {
      expect(overflowErr.reason).toContain("exceeded")
    }
  })

  it("rebuildWorkflowReadModelViews replays interrupt/ack_chunk rows, retried MergeSliceWave conflict units, and ProjectRunWaitingLlmPhase/ProjectRunCompleted", async () => {
    const client = createClient()
    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot, client }),
      makeWorkflowReadModelQueryLayer({ repoRoot, client }),
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

        // 1. Epic run: MergeSliceWave Conflict -> Escalation(retry) -> MergeSliceWave Merged + ack_chunk (tag: null) + non-run interrupt (tag: null)
        const epicRunMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: epicRunId,
          tag: "run",
          payload: JSON.stringify({ plan: epicPlan }),
        })
        const completedSliceOutcome = UnitOutcome.cases.Completed.make({
          unitId: sliceUnitId,
          attempt: AttemptNumber.make(1),
          changedPaths: [OwnedRelPath.make("libs/alpha/src/index.ts")],
          packageStampHash: PackageStampHash.make("e".repeat(64)),
        })
        const unitDoneMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: epicRunId,
          tag: "deferred",
          payload: JSON.stringify({
            name: `unit/${sliceUnitId}/1`,
            exit: {
              _tag: "Success",
              value: completedSliceOutcome,
            },
          }),
        })
        const ackKey = nextMsgKey()
        yield* invokeWorkflowStoreQuery({
          repoRoot,
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
            entityId: epicRunId,
            requestId: unitDoneMsg,
            replyId: ReplyKey.make("999001"),
            deliverAtMs: null,
          },
        })
        const conflictMergeMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: epicRunId,
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
                branch: sliceBranch,
              }),
            },
          },
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: epicRunId,
          tag: "deferred",
          payload: JSON.stringify({
            name: `escalation/${sliceUnitId}/1`,
            exit: { _tag: "Success", value: { decision: "retry" } },
          }),
        })
        const retriedMergeMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: epicRunId,
          tag: "activity",
          payload: JSON.stringify({ name: "MergeSliceWave/0/r2" }),
        })
        yield* insertJournalReplyExit(client, retriedMergeMsg, {
          _tag: "Success",
          value: {
            _tag: "Complete",
            exit: {
              _tag: "Success",
              value: MergeSliceWaveOutcome.cases.Merged.make({ mergedBranches: [sliceBranch] }),
            },
          },
        })
        const waitLlmMsg = yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: epicRunId,
          tag: "activity",
          payload: JSON.stringify({ name: "ProjectRunWaitingLlmPhase" }),
        })
        const nonRunInterrupt = nextMsgKey()
        yield* invokeWorkflowStoreQuery({
          repoRoot,
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
            entityId: epicRunId,
            requestId: waitLlmMsg,
            deliverAtMs: null,
          },
        })
        void epicRunMsg

        // 2. Second run: WaitingLlmPhase -> llm-phase-done -> ProjectRunCompleted (without final run reply yet)
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: llmRunId,
          tag: "run",
          payload: JSON.stringify({ plan: llmPlan }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: llmRunId,
          tag: "deferred",
          payload: JSON.stringify({
            name: `unit/${sliceUnitId}/1`,
            exit: {
              _tag: "Success",
              value: completedSliceOutcome,
            },
          }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: llmRunId,
          tag: "activity",
          payload: JSON.stringify({ name: "ProjectRunWaitingLlmPhase" }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: llmRunId,
          tag: "deferred",
          payload: JSON.stringify({
            name: "llm-phase-done",
            exit: { _tag: "Success", value: { workspaceHash: "h", frictionLogCleared: "cleared" } },
          }),
        })
        yield* insertJournalMessage(client, {
          shardId: "default:0",
          entityId: llmRunId,
          tag: "activity",
          payload: JSON.stringify({ name: "ProjectRunCompleted" }),
        })

        const rebuilt = yield* rebuildWorkflowReadModelViews(repoRoot, {
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
})
