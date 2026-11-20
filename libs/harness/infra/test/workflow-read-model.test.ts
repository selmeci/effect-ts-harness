import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect, Layer, Option, Schema, Tracer } from "effect"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
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
  RejectionJsonPayload,
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
  WorkflowAttemptKey,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkflowStoreOperation,
  WorkflowTimestampMs,
  WorkflowUnitKey,
  encodeSeqKey,
} from "@harness/contract"
import { type SpanSample, decideSpanBudgets } from "@harness/gates"
import { makeWorkflowOmnigraphClient } from "@harness/graph"
import { WorkflowProjectionWriter, WorkflowReadModelQuery } from "@harness/service"
import {
  invokeWorkflowStoreQuery,
  makeWorkflowProjectionWriterLayer,
  makeWorkflowReadModelQueryLayer,
  rebuildWorkflowReadModelViews,
} from "../src/index.js"

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

describe("WF-3 WorkflowProjectionWriterLive, WorkflowReadModelQueryLive & rebuildWorkflowReadModelViews", () => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  let repoRoot: AbsoluteRepoRoot
  const cliToken = "wf3-readmodel-cli-token"

  const createClient = () =>
    makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken })

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

  it("executes all 14 workflows.gq read-model queries via WorkflowProjectionWriterLive & WorkflowReadModelQueryLive (upsert, get, list, wf_probe_runs)", async () => {
    const client = createClient()
    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot, client }),
      makeWorkflowReadModelQueryLayer({ repoRoot, client }),
    )
    const op = WorkflowStoreOperation.make("WorkflowReadModelTest.cleanup")

    const runId = WorkflowRunId.make("run-rm-crud-1")
    const otherRunId = WorkflowRunId.make("run-rm-crud-2")
    const executionId = WorkflowExecutionId.make("run-rm-crud-1")
    const planSha = PlanSha256.make("a".repeat(64))
    const baseSha = GitCommitSha.make("b".repeat(40))
    const unitId = WorkUnitId.make("unit-alpha")
    const unitKey = WorkflowUnitKey.make(`${runId}/${unitId}`)
    const attemptKey = WorkflowAttemptKey.make(`${runId}/${unitId}#1`)
    const stampHash = PackageStampHash.make("c".repeat(64))

    await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* WorkflowProjectionWriter
        const query = yield* WorkflowReadModelQuery

        const readyState = yield* query.probeAvailability
        expect(readyState).toBe("ready")

        // Missing lookup -> Option.none
        const missing = yield* query.getRun(runId)
        expect(missing._tag).toBe("None")

        // Insert & update run
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

        // wf_probe_runs succeeds cleanly on non-empty table too
        expect(yield* query.probeAvailability).toBe("ready")

        const fetched = yield* query.getRun(runId)
        match(fetched)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.state).toBe("completed")
            expect(value.updatedMs).toBe(2000)
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected inserted run to be found")
          })
          .exhaustive()

        const runs = yield* query.listRuns
        expect(runs.map((r) => r.runId)).toEqual([runId, otherRunId])

        // Insert & update unit
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
        expect(units.length).toBe(1)
        expect(units[0]?.status).toBe("completed")
        expect(units[0]?.ownedRelPaths).toEqual([OwnedRelPath.make("libs/alpha")])

        // Insert & update attempt
        yield* writer.upsertAttempt({
          attemptKey,
          runId,
          unitId,
          attempt: AttemptNumber.make(1),
          verdict: "dispatched",
          runner: RunnerId.make("claude-code"),
          updatedMs: WorkflowTimestampMs.make(1100),
        })
        yield* writer.upsertAttempt({
          attemptKey,
          runId,
          unitId,
          attempt: AttemptNumber.make(1),
          verdict: "completed",
          runner: RunnerId.make("claude-code"),
          rejection: RejectionJsonPayload.make('{"_tag":"AgentFailed"}'),
          packageStampHash: stampHash,
          updatedMs: WorkflowTimestampMs.make(2100),
        })
        const attempts = yield* query.listAttempts(runId)
        expect(attempts.length).toBe(1)
        expect(attempts[0]?.verdict).toBe("completed")
        expect(attempts[0]?.packageStampHash).toBe(stampHash)

        // Delete run views via wf_delete_run_views -> clears runId without touching otherRunId
        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_delete_run_views",
          params: { runId },
          expectMutation: true,
        })
        expect((yield* query.getRun(runId))._tag).toBe("None")
        expect(yield* query.listUnits(runId)).toEqual([])
        expect(yield* query.listAttempts(runId)).toEqual([])
        expect((yield* query.listRuns).map((r) => r.runId)).toEqual([otherRunId])

        // Cleanup otherRunId
        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_delete_run_views",
          params: { runId: otherRunId },
          expectMutation: true,
        })
      }).pipe(Effect.provide(layer)),
    )

    // Probe unreachable Omnigraph -> "inactive" (never fails)
    const unreachableClient = makeWorkflowOmnigraphClient({
      baseUrl: "http://127.0.0.1:1",
      token: cliToken,
    })
    const inactiveLayer = makeWorkflowReadModelQueryLayer({
      repoRoot,
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

  it("rebuildWorkflowReadModelViews clears stale views and reconstructs WfRun, WfUnit, and WfAttempt rows from WfMessage/WfReply journal", async () => {
    const client = createClient()
    const layer = Layer.merge(
      makeWorkflowProjectionWriterLayer({ repoRoot, client }),
      makeWorkflowReadModelQueryLayer({ repoRoot, client }),
    )
    const op = WorkflowStoreOperation.make("WorkflowReadModelTest.seed")

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

        // Insert stale view row that is NOT backed by the journal
        yield* writer.upsertRun({
          runId: staleRunId,
          executionId: WorkflowExecutionId.make("exec-stale"),
          level: "slice",
          planSha: PlanSha256.make("9".repeat(64)),
          baseSha,
          state: "running",
          updatedMs: WorkflowTimestampMs.make(100),
        })

        // Seed journal messages + replies for completedRunId
        const msgRun1 = MessageKey.make("300000000000000001")
        const msgDef1 = MessageKey.make("300000000000000002")
        const msgDef2 = MessageKey.make("300000000000000003")
        const msgRun2 = MessageKey.make("300000000000000004")

        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_insert_request_message",
          expectMutation: true,
          params: {
            messageKey: msgRun1,
            seqKey: unwrapSeqKey(300000000000000001n),
            primaryKeyHash: null,
            shardId: "default:0",
            entityType: "Workflow/HarnessTaskWorkflow",
            entityId: completedRunId,
            tag: "run",
            payload: JSON.stringify({ plan: completedPlan }),
            headers: "{}",
            traceId: null,
            spanId: null,
            sampled: null,
            requestId: msgRun1,
            deliverAtMs: null,
          },
        })

        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_save_reply_exit",
          expectMutation: true,
          params: {
            replyKey: ReplyKey.make("400000000000000001"),
            seqKey: unwrapSeqKey(400000000000000001n),
            requestId: msgRun1,
            payload: JSON.stringify({
              _tag: "Success",
              value: { _tag: "Complete", exit: { _tag: "Success", value: {} } },
            }),
          },
        })

        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_insert_request_message",
          expectMutation: true,
          params: {
            messageKey: msgDef1,
            seqKey: unwrapSeqKey(300000000000000002n),
            primaryKeyHash: null,
            shardId: "default:0",
            entityType: "Workflow/HarnessTaskWorkflow",
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
            headers: "{}",
            traceId: null,
            spanId: null,
            sampled: null,
            requestId: msgDef1,
            deliverAtMs: null,
          },
        })

        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_insert_request_message",
          expectMutation: true,
          params: {
            messageKey: msgDef2,
            seqKey: unwrapSeqKey(300000000000000003n),
            primaryKeyHash: null,
            shardId: "default:0",
            entityType: "Workflow/HarnessTaskWorkflow",
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
            headers: "{}",
            traceId: null,
            spanId: null,
            sampled: null,
            requestId: msgDef2,
            deliverAtMs: null,
          },
        })

        // Seed suspended run
        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_insert_request_message",
          expectMutation: true,
          params: {
            messageKey: msgRun2,
            seqKey: unwrapSeqKey(300000000000000004n),
            primaryKeyHash: null,
            shardId: "default:1",
            entityType: "Workflow/HarnessTaskWorkflow",
            entityId: waitingRunId,
            tag: "run",
            payload: JSON.stringify({ plan: waitingPlan }),
            headers: "{}",
            traceId: null,
            spanId: null,
            sampled: null,
            requestId: msgRun2,
            deliverAtMs: null,
          },
        })

        yield* invokeWorkflowStoreQuery({
          repoRoot,
          client,
          operation: op,
          queryName: "wf_save_reply_exit",
          expectMutation: true,
          params: {
            replyKey: ReplyKey.make("400000000000000002"),
            seqKey: unwrapSeqKey(400000000000000002n),
            requestId: msgRun2,
            payload: JSON.stringify({
              _tag: "Success",
              value: { _tag: "Suspended" },
            }),
          },
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

        // Stale run was removed
        expect((yield* query.getRun(staleRunId))._tag).toBe("None")

        // Rebuilt runs present with accurate states
        const runs = yield* query.listRuns
        expect(runs.length).toBe(2)
        const rebuiltCompleted = yield* query.getRun(completedRunId)
        match(rebuiltCompleted)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.state).toBe("completed")
            expect(value.updatedMs).toBe(555_000)
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected completedRunId to be rebuilt")
          })
          .exhaustive()

        const rebuiltWaiting = yield* query.getRun(waitingRunId)
        match(rebuiltWaiting)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.state).toBe("waiting")
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected waitingRunId to be rebuilt")
          })
          .exhaustive()

        const units1 = yield* query.listUnits(completedRunId)
        expect(units1.length).toBe(1)
        expect(units1[0]?.status).toBe("completed")

        const attempts1 = yield* query.listAttempts(completedRunId)
        expect(attempts1.length).toBe(2)
        expect(attempts1[0]?.verdict).toBe("rejected")
        expect(attempts1[1]?.verdict).toBe("completed")
        expect(attempts1[1]?.packageStampHash).toBe(stampHash)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("rebuildWorkflowReadModelViews reconstructs sharedStepPaths, Automatic /r2 cycles, ProjectUnitEscalated, MergeSliceWave conflicts, InterruptSignal, and Failure exits", async () => {
    const client = createClient()
    const layer = makeWorkflowReadModelQueryLayer({ repoRoot, client })
    const op = WorkflowStoreOperation.make("WorkflowReadModelTest.seedAdvanced")

    const autoRunId = WorkflowRunId.make("run-adv-auto-1")
    const mergeRunId = WorkflowRunId.make("run-adv-merge-2")
    const escFailRunId = WorkflowRunId.make("run-adv-esc-3")
    const baseSha = GitCommitSha.make("e".repeat(40))
    const stampHash = PackageStampHash.make("a".repeat(64))

    const unit1 = WorkUnitId.make("u-1")
    const unit10 = WorkUnitId.make("u-10")
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

    const sliceUnit = WorkUnitId.make("u-slice-conflict")
    const sliceBranch = SliceBranchName.make("slice/u-conflict")
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

    const escUnit = WorkUnitId.make("u-esc")
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

    let nextMsgNum = 500000000000000001n
    let nextReplyNum = 600000000000000001n

    const insertMessage = (params: {
      readonly shardId: string
      readonly entityId: string
      readonly tag: string
      readonly payload: string
    }) => {
      const id = nextMsgNum
      nextMsgNum += 1n
      const key = MessageKey.make(id.toString())
      return invokeWorkflowStoreQuery({
        repoRoot,
        client,
        operation: op,
        queryName: "wf_insert_request_message",
        expectMutation: true,
        params: {
          messageKey: key,
          seqKey: unwrapSeqKey(id),
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

    const insertReplyExit = (requestId: MessageKey, payload: unknown) => {
      const id = nextReplyNum
      nextReplyNum += 1n
      return invokeWorkflowStoreQuery({
        repoRoot,
        client,
        operation: op,
        queryName: "wf_save_reply_exit",
        expectMutation: true,
        params: {
          replyKey: ReplyKey.make(id.toString()),
          seqKey: unwrapSeqKey(id),
          requestId,
          payload: JSON.stringify(payload),
        },
      })
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* WorkflowReadModelQuery

        // 1. Automatic run with u-1 vs u-10 substring test, /r2 cycle, VerifySharedStep, InterruptSignal
        const autoRunMsg = yield* insertMessage({
          shardId: "default:0",
          entityId: autoRunId,
          tag: "run",
          payload: JSON.stringify({ plan: autoPlan }),
        })
        yield* insertReplyExit(autoRunMsg, { _tag: "Success", value: { _tag: "Suspended" } })

        // Dispatch u-10 ONLY -> u-1 must remain "pending"
        yield* insertMessage({
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `DispatchUnitAgent/${unit10}/1` }),
        })
        // First VerifyUnit/u-10/1 rejected
        const v1Msg = yield* insertMessage({
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `VerifyUnit/${unit10}/1`, attempt: 1 }),
        })
        yield* insertReplyExit(v1Msg, {
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
        // Escalation + retry
        yield* insertMessage({
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `ProjectUnitEscalated/${unit10}/1` }),
        })
        yield* insertMessage({
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `ProjectUnitEscalationRetried/${unit10}/1` }),
        })
        // Cycle 2 VerifyUnit/u-10/1/r2 completed (must NOT collapse with #1!)
        const v2Msg = yield* insertMessage({
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `VerifyUnit/${unit10}/1/r2`, attempt: 1 }),
        })
        yield* insertReplyExit(v2Msg, {
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
        // Shared step VerifySharedStep/1 completed
        const sharedMsg = yield* insertMessage({
          shardId: "default:0",
          entityId: autoRunId,
          tag: "activity",
          payload: JSON.stringify({ name: "VerifySharedStep/1", attempt: 1 }),
        })
        yield* insertReplyExit(sharedMsg, {
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
        // Interrupt signal marks non-completed run aborted
        yield* insertMessage({
          shardId: "default:0",
          entityId: autoRunId,
          tag: "deferred",
          payload: JSON.stringify({
            name: "Workflow/InterruptSignal",
            exit: { _tag: "Success", value: null },
          }),
        })

        // 2. MergeSliceWave/0 conflict marks slice unit "escalated" & run "waiting"
        const mergeRunMsg = yield* insertMessage({
          shardId: "default:1",
          entityId: mergeRunId,
          tag: "run",
          payload: JSON.stringify({ plan: mergePlan }),
        })
        yield* insertReplyExit(mergeRunMsg, { _tag: "Success", value: { _tag: "Suspended" } })
        const mergeWaveMsg = yield* insertMessage({
          shardId: "default:1",
          entityId: mergeRunId,
          tag: "activity",
          payload: JSON.stringify({ name: "MergeSliceWave/0" }),
        })
        yield* insertReplyExit(mergeWaveMsg, {
          _tag: "Success",
          value: {
            _tag: "Complete",
            exit: {
              _tag: "Success",
              value: MergeSliceWaveOutcome.cases.Conflict.make({ branch: sliceBranch }),
            },
          },
        })

        // 3. ProjectUnitEscalated + terminal Failure exit preserves "escalated" unit and "aborted" run
        const escRunMsg = yield* insertMessage({
          shardId: "default:2",
          entityId: escFailRunId,
          tag: "run",
          payload: JSON.stringify({ plan: escPlan }),
        })
        yield* insertReplyExit(escRunMsg, { _tag: "Failure" })
        yield* insertMessage({
          shardId: "default:2",
          entityId: escFailRunId,
          tag: "activity",
          payload: JSON.stringify({ name: `ProjectUnitEscalated/${escUnit}/1` }),
        })

        const rebuiltTotal = yield* rebuildWorkflowReadModelViews(repoRoot, {
          client,
          nowMs: () => 777_000,
        })
        expect(rebuiltTotal).toBe(5)

        // Check Run 1: aborted via InterruptSignal, u-1 still pending, u-10 completed with BOTH #1 and #1/r2 attempts, shared-step completed!
        match(yield* query.getRun(autoRunId))
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.state).toBe("aborted")
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected autoRunId")
          })
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

        // Check Run 2: MergeSliceWave conflict -> sliceUnit "escalated", run "waiting"
        match(yield* query.getRun(mergeRunId))
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.state).toBe("waiting")
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected mergeRunId")
          })
          .exhaustive()
        const mergeUnits = yield* query.listUnits(mergeRunId)
        expect(mergeUnits.find((u) => u.unitId === sliceUnit)?.status).toBe("escalated")

        // Check Run 3: Failure exit + ProjectUnitEscalated -> u-esc "escalated", run "aborted"
        match(yield* query.getRun(escFailRunId))
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value.state).toBe("aborted")
          })
          .with({ _tag: "None" }, () => {
            expect.unreachable("Expected escFailRunId")
          })
          .exhaustive()
        const escUnits = yield* query.listUnits(escFailRunId)
        expect(escUnits.find((u) => u.unitId === escUnit)?.status).toBe("escalated")
      }).pipe(Effect.provide(layer)),
    )
  })
})
