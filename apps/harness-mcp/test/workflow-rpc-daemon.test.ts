import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Context, Effect, Exit, Layer, Schema, Scope, Semaphore, SynchronizedRef } from "effect"
import { DurableDeferred, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  type CompiledPlan,
  type CompleteSharedStepInput,
  type CompleteUnitInput,
  DaemonSocketPath,
  EarsRequirementKey,
  EscalationDecision,
  EscalationOrdinal,
  GateExitCode,
  GitCommitSha,
  LeaseEpoch,
  MaxConcurrency,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PackageVerifyFailureDetail,
  PlanSha256,
  ReviewDepth,
  ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewRoutingSource,
  RunnerId,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  StubSymbolKey,
  UnitAgentDispatchResult,
  UnitOutcome,
  UnitRejection,
  WaveIndex,
  WorkUnitId,
  WorkflowDoctorMode,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkflowRunOutcome,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  makeWorkflowUnitKey,
  toBoundedReason,
  toErrorReasonMessage,
} from "@harness/contract"
import {
  HarnessTaskWorkflow,
  appendFrictionEvent,
  clearFrictionEvents,
  executionIdOf,
  makeUnitEscalationDeferred,
  resolveHarnessStateDir,
} from "@harness/gates"
import { OmnigraphClient, makeWorkflowOmnigraphClient } from "@harness/graph"
import {
  UnitAgentDispatcherLive,
  UnixSocketDaemonLive,
  WORKFLOW_COMPLETE_IPC_TIMEOUT_MS,
  WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
  WRITER_LEASE_HEARTBEAT_TTL_MS,
  abortWorkflowViaDaemon,
  completeWorkflowViaDaemon,
  doctorWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  makeWorkflowWorktreePortLayer,
  nodeSyncHostIo,
  queryUnixSocketLineDetailed,
  queryWorkflowDaemonCommand,
  resolveWorkflowRuntimePaths,
  resolveWorkflowWorktreeDir,
  resumeWorkflowViaDaemon,
  startWorkflowViaDaemon,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import {
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowProjectionWriter,
  WorkflowReadModelQuery,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import { HarnessTaskWorkflowLayer } from "@harness/gates"
import { startHarnessDaemonServer } from "../src/daemon/unix-socket-daemon.js"
import { handleDaemonWorkflowCompleteRequest } from "../src/daemon/workflow-rpc-complete-helper.js"
import {
  handleDaemonWorkflowAbortRequest,
  handleDaemonWorkflowResumeRequest,
  handleDaemonWorkflowStartRequest,
} from "../src/daemon/workflow-rpc-daemon-helper.js"
import { handleDaemonWorkflowDoctorRequest } from "../src/daemon/workflow-rpc-doctor-helper.js"
import { type WorkflowDaemonRuntime } from "../src/daemon/workflow-engine-daemon-helper.js"
import {
  extractLastRejection,
  inspectActiveUnitCycle,
  resolveRunTarget,
  validateRpcRepoRoot,
} from "../src/daemon/workflow-rpc-shared.js"
import {
  buildStatusSummaryForRuntime,
  handleDaemonWorkflowStatusRpcRequest,
} from "../src/daemon/workflow-rpc-status-helper.js"
import { executeWorkflowPlanTool } from "../src/tools/workflow-plan.tools.js"

const graphConfigDir = resolve(import.meta.dirname, "../../../libs/harness/graph")
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

const initTestGitRepo = (
  baseDir: string,
  name: string,
): {
  readonly canonicalDir: string
  readonly linkedDir: string
  readonly baseSha: GitCommitSha
} => {
  const canonicalDir = join(baseDir, name)
  const linkedDir = join(baseDir, `${name}-wt`)
  mkdirSync(canonicalDir, { recursive: true })
  execFileSync("git", ["init"], { cwd: canonicalDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "wf3@example.com"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  execFileSync("git", ["config", "user.name", "WF3 Test"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  writeFileSync(join(canonicalDir, "README.md"), "# WF3\n", "utf8")
  execFileSync("git", ["add", "README.md"], { cwd: canonicalDir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: canonicalDir, stdio: "ignore" })
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: canonicalDir,
    encoding: "utf8",
  }).trim()
  execFileSync("git", ["worktree", "add", "-b", `slice/${name}-wt`, linkedDir, "HEAD"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  return {
    canonicalDir,
    linkedDir,
    baseSha: GitCommitSha.make(headSha),
  }
}

const makeReviewStubLayer = (): Layer.Layer<WorkflowReviewRouter> =>
  Layer.succeed(WorkflowReviewRouter, {
    routeReview: () =>
      Effect.succeed<ReviewRoutingPlan>({
        _tag: "SkipReviewPlan",
        depth: ReviewDepth.make("skip"),
        source: ReviewRoutingSource.make("deterministic"),
        reason: ReviewRoutingReason.make("WF3 daemon integration test"),
        selections: [],
      }),
  })

const makeNoopWorktreeLayer = (
  canonicalRoot: AbsoluteRepoRoot,
): Layer.Layer<WorkflowWorktreePort> =>
  Layer.succeed(WorkflowWorktreePort, {
    provisionWorktrees: (plan) =>
      Effect.succeed({
        runId: plan.runId,
        canonicalRepoRoot: canonicalRoot,
        entries: plan.units.map((u) => ({
          unitId: u.unitId,
          cwd: canonicalRoot,
          worktreeKind: "canonical" as const,
        })),
      }),
    removeWorktreeCheckouts: () => Effect.void,
    mergeSliceWave: (input) =>
      Effect.succeed({
        _tag: "Merged" as const,
        mergedBranches: input.branches,
      }),
  })

const makeCompletedVerifierLayer = (
  onCompleteUnit?: (input: CompleteUnitInput) => void,
  onCompleteShared?: (input: CompleteSharedStepInput) => void,
): Layer.Layer<UnitVerifier> =>
  Layer.succeed(UnitVerifier, {
    completeUnit: (input) =>
      Effect.sync(() => {
        onCompleteUnit?.(input)
        return UnitOutcome.cases.Completed.make({
          unitId: input.unit.unitId,
          attempt: input.attempt,
          changedPaths: [...input.unit.ownedRelPaths],
          packageStampHash: PackageStampHash.make("a".repeat(64)),
        })
      }),
    completeSharedStep: (input) =>
      Effect.sync(() => {
        onCompleteShared?.(input)
        return UnitOutcome.cases.Completed.make({
          unitId: SHARED_STEP_UNIT_ID,
          attempt: input.attempt,
          changedPaths: [...input.sharedStepPaths],
          packageStampHash: PackageStampHash.make("b".repeat(64)),
        })
      }),
  })

const makeSingleUnitManualPlan = (
  runId: string,
  baseSha: GitCommitSha,
  options?: {
    readonly unitId?: string | undefined
    readonly planSha?: string | undefined
    readonly sharedStepPaths?: ReadonlyArray<string> | undefined
  },
): CompiledPlan => ({
  runId: WorkflowRunId.make(runId),
  level: "slice",
  planSha: PlanSha256.make(options?.planSha ?? "c".repeat(64)),
  baseSha,
  mode: { _tag: "Manual" },
  units: [
    {
      _tag: "PackageUnit",
      unitId: WorkUnitId.make(options?.unitId ?? "unit-alpha"),
      projectName: NxProjectName.make("@harness/alpha"),
      waveIndex: WaveIndex.make(0),
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
      stubKeys: [StubSymbolKey.make("Alpha.run")],
      earsKeys: [EarsRequirementKey.make("REQ-1.1")],
      packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
    },
  ],
  sharedStepPaths: (options?.sharedStepPaths ?? []).map((p) => OwnedRelPath.make(p)),
})

const makeMockLeaseStoreClient = (overrides?: {
  readonly getLeaseRow?: () => Record<string, unknown> | null
  readonly onRunRow?: (runId: string) => Record<string, unknown> | null
  readonly forceCorruptJournal?: boolean
}) => {
  let leaseRow: Record<string, unknown> | null = null
  let commitSeq = 1
  const baseClient = new OmnigraphClient({
    baseUrl: "http://127.0.0.1:1",
    graphId: "harness-workflows",
  })

  const invokeMock = (
    queryName: string,
    input?: { readonly params?: Readonly<Record<string, unknown>> | undefined },
  ): Promise<unknown> => {
    const params = input?.params ?? {}
    return Promise.resolve(
      match(queryName)
        .with("wf_get_writer_lease", () => {
          const effectiveRow =
            overrides?.getLeaseRow !== undefined ? overrides.getLeaseRow() : leaseRow
          return {
            queryName,
            rowCount: effectiveRow === null ? 0 : 1,
            rows: effectiveRow === null ? [] : [{ ...effectiveRow }],
            graphCommitId: `commit-${commitSeq}`,
            target: { branch: "main" },
          }
        })
        .with("wf_insert_writer_lease", () => {
          commitSeq += 1
          leaseRow = {
            name: typeof params.name === "string" ? params.name : "engine",
            owner: typeof params.owner === "string" ? params.owner : "",
            leaseEpoch: Number(params.leaseEpoch ?? 1),
            heartbeatMs: Number(params.heartbeatMs ?? Date.now()),
          }
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: `commit-${commitSeq}` },
          }
        })
        .with("wf_cas_writer_lease", () => {
          commitSeq += 1
          leaseRow = {
            name: "engine",
            owner: typeof params.owner === "string" ? params.owner : "",
            leaseEpoch: Number(params.nextEpoch ?? 2),
            heartbeatMs: Number(params.heartbeatMs ?? Date.now()),
          }
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: `commit-${commitSeq}` },
          }
        })
        .with("wf_refresh_writer_lease", () => {
          commitSeq += 1
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: `commit-${commitSeq}` },
          }
        })
        .with("wf_get_run", () => {
          const runIdStr = typeof params.runId === "string" ? params.runId : ""
          const row = overrides?.onRunRow !== undefined ? overrides.onRunRow(runIdStr) : null
          return {
            queryName,
            rowCount: row === null ? 0 : 1,
            rows: row === null ? [] : [row],
            graphCommitId: `commit-${commitSeq}`,
            target: { branch: "main" },
          }
        })
        .with("wf_all_entities", () => ({
          queryName,
          rowCount: overrides?.forceCorruptJournal ? 1 : 0,
          rows: overrides?.forceCorruptJournal
            ? [
                {
                  messageKey: "1",
                  seqKey: "0".repeat(20),
                  entityType: "Workflow/HarnessTaskWorkflow",
                },
              ]
            : [],
          graphCommitId: `commit-${commitSeq}`,
          target: { branch: "main" },
        }))
        .with(
          "wf_all_replies",
          "wf_dangling_processed_requests",
          "wf_unprocessed_candidate_messages",
          "wf_unprocessed_candidate_messages_for_addresses",
          "wf_orphan_entity_messages",
          "wf_probe_runs",
          "wf_list_runs",
          "wf_units_for_run",
          "wf_attempts_for_run",
          () => ({
            queryName,
            rowCount: 0,
            rows: [],
            graphCommitId: `commit-${commitSeq}`,
            target: { branch: "main" },
          }),
        )
        .otherwise(() => ({
          queryName,
          rowCount: 0,
          rows: [],
          affectedNodes: 0,
          affectedEdges: 0,
          branch: "main",
          commit: null,
          graphCommitId: `commit-${commitSeq}`,
          target: { branch: "main" },
        })),
    )
  }

  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      if (prop === "queries") {
        return new Proxy(target.queries, {
          get(qTarget, qProp, qReceiver) {
            if (qProp === "invoke") {
              return invokeMock
            }
            return Reflect.get(qTarget, qProp, qReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

describe("WF-3 Unix-socket daemon workflow RPCs & harness_workflow_plan", () => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  const cliToken = "wf3-rpc-daemon-token"

  const createClient = () =>
    makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken })

  const createWorkRepo = (name: string) => {
    const workBase = mkdtempSync(join(tmpdir(), `wf3-${name}-`))
    tempDirs.push(workBase)
    return initTestGitRepo(workBase, name)
  }

  beforeAll(async () => {
    expect(existsSync(omnigraphBin)).toBe(true)
    expect(existsSync(omnigraphServerBin)).toBe(true)

    const tempRoot = mkdtempSync(join(tmpdir(), "wf3-daemon-og-"))
    tempDirs.push(tempRoot)
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
            "agent-mcp": "wf3-rpc-mcp-token",
          }),
        },
      },
    )
    serverProc.stdout?.resume()
    serverProc.stderr?.resume()
    await waitForServerReady(serverBaseUrl, serverProc)
  }, 30_000) // spawns live omnigraph-server subprocess and polls /readyz over loopback HTTP

  afterAll(async () => {
    await stopChildProcess(serverProc)
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("manual start is idempotent, rejects planSha mismatch and premature CompleteLlmPhase/resume, and serves harness_workflow_plan from linked worktree", async () => {
    const { canonicalDir, linkedDir, baseSha } = createWorkRepo("happy")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const validatedLinked = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(linkedDir)),
    )
    const plan = makeSingleUnitManualPlan("run-rpc-happy-01", baseSha, {
      sharedStepPaths: ["README.md"],
    })
    const unitId = plan.units[0]!.unitId

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
      },
    })

    try {
      expect(daemon.writerLeaseEpoch).toBeGreaterThanOrEqual(1)
      const start1 = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan }),
      )
      expect(start1.outcome).toBe("started")

      const start2 = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedLinked.worktreeRoot, plan }),
      )
      expect(start2.executionId).toBe(start1.executionId)
      expect(start2.outcome).toBe("existing")

      const conflictingPlan: CompiledPlan = { ...plan, planSha: PlanSha256.make("1".repeat(64)) }
      const planShaErr = await Effect.runPromise(
        startWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          plan: conflictingPlan,
        }).pipe(Effect.flip),
      )
      expect(planShaErr.message).toContain("planSha")

      const initialStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedLinked.worktreeRoot, runId: plan.runId }),
      )
      expect(initialStatus).toMatchObject({
        _tag: "Ready",
        writerLeaseEpoch: daemon.writerLeaseEpoch,
        outcome: {
          _tag: "Active",
          run: { state: "running" },
          pendingDeferreds: [
            { _tag: "UnitCompletion", unitId, attempt: 1, deferredName: `unit/${unitId}/1` },
          ],
        },
      })

      const prematureLlmErr = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteLlmPhase",
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }).pipe(Effect.flip),
      )
      expect(prematureLlmErr.message).toContain("waiting")

      const prematureResumeErr = await Effect.runPromise(
        resumeWorkflowViaDaemon({
          _tag: "ResolveEscalation",
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
          unitId,
          decision: EscalationDecision.make("retry"),
        }).pipe(Effect.flip),
      )
      expect(prematureResumeErr.message).toContain("escalated")

      const mcpStatus = await Effect.runPromise(
        executeWorkflowPlanTool({ repoRoot: linkedDir, runId: plan.runId }),
      )
      expect(mcpStatus.resolvedRepoRoot).toBe(validatedLinked.worktreeRoot)
      expect(mcpStatus.commonGitDir).toBe(validatedCanonical.commonGitDir)
      expect(mcpStatus.status._tag).toBe("Ready")
    } finally {
      await daemon.close()
    }
  }, 45_000) // exercises multi-step unix-socket workflow daemon IPC, git repo setup, and live omnigraph-server queries

  const makeRetryAfterEscalationVerifierLayer = (
    recordedSharedInputs: Array<CompleteSharedStepInput>,
  ) => {
    let completeCalls = 0
    return Layer.succeed(UnitVerifier, {
      completeUnit: (input) =>
        Effect.sync(() => {
          completeCalls += 1
          if (completeCalls <= 3) {
            return UnitOutcome.cases.Rejected.make({
              unitId: input.unit.unitId,
              attempt: input.attempt,
              rejection: UnitRejection.cases.PackageVerifyFailed.make({
                exitCode: GateExitCode.make(1),
                failureKind: "non-zero-exit",
                detail: PackageVerifyFailureDetail.make(`attempt ${completeCalls} failed`),
              }),
            })
          }
          return UnitOutcome.cases.Completed.make({
            unitId: input.unit.unitId,
            attempt: input.attempt,
            changedPaths: [...input.unit.ownedRelPaths],
            packageStampHash: PackageStampHash.make("a".repeat(64)),
          })
        }),
      completeSharedStep: (input) =>
        Effect.sync(() => {
          recordedSharedInputs.push(input)
          return UnitOutcome.cases.Completed.make({
            unitId: SHARED_STEP_UNIT_ID,
            attempt: input.attempt,
            changedPaths: [...input.sharedStepPaths],
            packageStampHash: PackageStampHash.make("b".repeat(64)),
          })
        }),
    })
  }

  const assertEscalatedRetryBudgetStatus = (
    escalatedStatus: Effect.Success<ReturnType<typeof getWorkflowStatusViaDaemon>>,
    unitId: WorkUnitId,
  ) => {
    expect(escalatedStatus).toMatchObject({
      _tag: "Ready",
      outcome: {
        _tag: "Active",
        pendingDeferreds: [
          {
            _tag: "Escalation",
            unitId,
            deferredName: `escalation/${unitId}/1`,
            escalation: {
              _tag: "RetryBudgetExhausted",
              lastRejection: {
                _tag: "PackageVerifyFailed",
                exitCode: 1,
                failureKind: "non-zero-exit",
                detail: "attempt 3 failed",
              },
            },
          },
        ],
      },
    })
    match(escalatedStatus)
      .with({ _tag: "Ready" }, ({ outcome }) => {
        match(outcome)
          .with({ _tag: "Active" }, ({ units }) => {
            expect(units.find((u) => u.unitId === unitId)?.status).toBe("escalated")
          })
          .with({ _tag: "NotFound" }, { _tag: "Completed" }, { _tag: "Failed" }, () => {
            expect.unreachable("Expected Active outcome")
          })
          .exhaustive()
      })
      .with({ _tag: "DaemonOffline" }, { _tag: "StorePaused" }, () => {
        expect.unreachable("Expected Ready status")
      })
      .exhaustive()
  }

  it("handles 3x PackageVerifyFailed -> Escalation -> resume retry -> shared-step -> friction gate -> CompleteLlmPhase -> doctor rebuild", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("esc-flow")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const recordedSharedInputs: Array<CompleteSharedStepInput> = []
    const verifierLayer = makeRetryAfterEscalationVerifierLayer(recordedSharedInputs)

    const plan = makeSingleUnitManualPlan("run-rpc-esc-02", baseSha, {
      sharedStepPaths: ["README.md"],
    })
    const unitId = plan.units[0]!.unitId

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: verifierLayer,
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
      },
    })

    try {
      const startRes = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan }),
      )

      for (const expectedAttempt of [1, 2, 3] as const) {
        const compRes = await Effect.runPromise(
          completeWorkflowViaDaemon({
            _tag: "CompleteUnit",
            repoRoot: validatedCanonical.worktreeRoot,
            unitId,
            runId: plan.runId,
          }),
        )
        expect(compRes).toMatchObject({
          _tag: "UnitCompleted",
          outcome: {
            _tag: "Rejected",
            attempt: expectedAttempt,
          },
        })
      }

      const escalatedStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      assertEscalatedRetryBudgetStatus(escalatedStatus, unitId)

      const resumed = await Effect.runPromise(
        resumeWorkflowViaDaemon({
          _tag: "ResolveEscalation",
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
          unitId,
          decision: "retry",
        }),
      )
      expect(resumed).toEqual({
        _tag: "EscalationResolved",
        runId: plan.runId,
        executionId: startRes.executionId,
        unitId,
        decision: "retry",
      })

      const unitDone = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedCanonical.worktreeRoot,
          unitId,
          runId: plan.runId,
        }),
      )
      expect(unitDone._tag === "UnitCompleted" && unitDone.outcome._tag).toBe("Completed")

      const sharedDone = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedCanonical.worktreeRoot,
          unitId: SHARED_STEP_UNIT_ID,
          runId: plan.runId,
        }),
      )
      expect(sharedDone._tag === "UnitCompleted" && sharedDone.outcome._tag).toBe("Completed")
      expect(recordedSharedInputs[0]?.priorUnitOwnedPaths).toEqual(["libs/alpha/src"])

      // Corrupt & dirty friction log block CompleteLlmPhase
      const defaultStateDir = resolveHarnessStateDir(validatedCanonical.worktreeRoot, {})
      mkdirSync(defaultStateDir, { recursive: true })
      const defaultFrictionPath = join(defaultStateDir, "friction-log.jsonl")
      writeFileSync(defaultFrictionPath, "corrupt-unparseable-friction-line\n", "utf8")
      const corruptFrictionErr = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteLlmPhase",
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }).pipe(Effect.flip),
      )
      expect(corruptFrictionErr.message).toContain("friction log")
      writeFileSync(defaultFrictionPath, "", "utf8")

      appendFrictionEvent(
        validatedCanonical.worktreeRoot,
        {
          kind: "verify_failure",
          summary: "Unresolved friction entry",
          detail: "Must clear before LLM phase completes",
        },
        nodeSyncHostIo,
      )
      const dirtyFrictionErr = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteLlmPhase",
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }).pipe(Effect.flip),
      )
      expect(dirtyFrictionErr.message).toContain("friction log")

      clearFrictionEvents(validatedCanonical.worktreeRoot, nodeSyncHostIo)
      const llmDone = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteLlmPhase",
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      expect(llmDone._tag).toBe("LlmPhaseCompleted")

      const docCheck = await Effect.runPromise(
        doctorWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          mode: WorkflowDoctorMode.make("check-only"),
        }),
      )
      expect(docCheck.rebuiltRunCount).toBe(0)
      expect(docCheck.checks.every((c) => c.status === "ok")).toBe(true)

      const docRebuild = await Effect.runPromise(
        doctorWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          mode: WorkflowDoctorMode.make("rebuild"),
        }),
      )
      expect(docRebuild.rebuiltRunCount).toBeGreaterThanOrEqual(1)
      expect(
        docRebuild.checks.some((c) => c.name === "read-model-rebuild" && c.status === "ok"),
      ).toBe(true)

      const afterRebuild = await Effect.runPromise(
        getWorkflowStatusViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      match(afterRebuild)
        .with({ _tag: "Ready" }, ({ outcome }) => {
          match(outcome)
            .with({ _tag: "Completed" }, ({ run, units }) => {
              expect(run.state).toBe("completed")
              expect(units.find((u) => u.unitId === unitId)?.status).toBe("completed")
              expect(units.find((u) => u.unitId === SHARED_STEP_UNIT_ID)?.status).toBe("completed")
            })
            .with({ _tag: "NotFound" }, { _tag: "Active" }, { _tag: "Failed" }, () => {
              expect.unreachable("Expected Completed outcome")
            })
            .exhaustive()
        })
        .with({ _tag: "DaemonOffline" }, { _tag: "StorePaused" }, () => {
          expect.unreachable("Expected Ready status")
        })
        .exhaustive()
    } finally {
      await daemon.close()
    }
  }, 45_000) // exercises 3x verification failure -> escalation -> retry -> shared-step -> friction gate against live daemon & omnigraph-server

  it("enforces F-1.1 epic worktree cwd (<canonicalRepoRoot>/.harness/workflow-worktrees/<runId>/<unitId>), abort compensation, and F-15.1 Interrupted status", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("epic-abort")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const l1RunId = WorkflowRunId.make("run-l1-abort-03")
    const l1UnitOne = WorkUnitId.make("slice-one")
    const l1UnitTwo = WorkUnitId.make("slice-two")
    const l1BranchOne = SliceBranchName.make("slice/wf3-abort-one")
    const l1BranchTwo = SliceBranchName.make("slice/wf3-abort-two")
    const l1Plan: CompiledPlan = {
      runId: l1RunId,
      level: "epic",
      planSha: PlanSha256.make("f".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "SliceUnit",
          unitId: l1UnitOne,
          branch: l1BranchOne,
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/one/src")],
          earsKeys: [EarsRequirementKey.make("REQ-2.1")],
        },
        {
          _tag: "SliceUnit",
          unitId: l1UnitTwo,
          branch: l1BranchTwo,
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/two/src")],
          earsKeys: [EarsRequirementKey.make("REQ-2.1")],
        },
      ],
      sharedStepPaths: [],
    }

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeWorkflowWorktreePortLayer({
          repoRoot: validatedCanonical.worktreeRoot,
        }),
        reviewRouterLayer: makeReviewStubLayer(),
      },
    })

    try {
      await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan: l1Plan }),
      )
      const wtOnePath = resolveWorkflowWorktreeDir(
        validatedCanonical.worktreeRoot,
        l1RunId,
        l1UnitOne,
      )
      const wtTwoPath = resolveWorkflowWorktreeDir(
        validatedCanonical.worktreeRoot,
        l1RunId,
        l1UnitTwo,
      )
      expect(wtOnePath).toBe(
        join(validatedCanonical.worktreeRoot, ".harness", "workflow-worktrees", l1RunId, l1UnitOne),
      )
      expect(existsSync(wtOnePath)).toBe(true)
      expect(existsSync(wtTwoPath)).toBe(true)

      const spoofCwdErr = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedCanonical.worktreeRoot,
          unitId: l1UnitOne,
          runId: l1RunId,
        }).pipe(Effect.flip),
      )
      expect(spoofCwdErr.message).toContain("provisioned worktree")

      const validatedWtOne = await Effect.runPromise(
        validateWorktreeRepoRoot(AbsoluteRepoRoot.make(wtOnePath)),
      )
      const l1CompOne = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedWtOne.worktreeRoot,
          unitId: l1UnitOne,
          runId: l1RunId,
        }),
      )
      expect(l1CompOne._tag).toBe("UnitCompleted")

      const abortRes = await Effect.runPromise(
        abortWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId: l1RunId }),
      )
      expect(abortRes.state).toBe("aborted")
      expect(existsSync(wtOnePath)).toBe(false)
      expect(existsSync(wtTwoPath)).toBe(false)

      const abortedStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId: l1RunId }),
      )
      expect(abortedStatus).toMatchObject({
        _tag: "Ready",
        outcome: {
          _tag: "Failed",
          terminalError: { _tag: "Interrupted" },
        },
      })
    } finally {
      await daemon.close()
    }
  }, 45_000) // spawns git worktrees + daemon IPC + omnigraph-server writes for F-1.1/F-15.1 abort compensation

  it("propagates slice siblingInFlightOwnedPaths and classifies TaskRunAbortedError into WorkflowTerminalError.Aborted (F-15.1)", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("slice-aborted")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const recordedInputs: Array<CompleteUnitInput> = []
    const verifierLayer = Layer.succeed(UnitVerifier, {
      completeUnit: (input) =>
        Effect.sync(() => {
          recordedInputs.push(input)
          if (input.unit.unitId === "unit-a") {
            return UnitOutcome.cases.Completed.make({
              unitId: input.unit.unitId,
              attempt: input.attempt,
              changedPaths: [...input.unit.ownedRelPaths],
              packageStampHash: PackageStampHash.make("d".repeat(64)),
            })
          }
          return UnitOutcome.cases.Escalated.make({
            unitId: input.unit.unitId,
            escalation: { _tag: "AuthRequired", runner: RunnerId.make("claude-code") },
          })
        }),
      completeSharedStep: (input) =>
        Effect.succeed(
          UnitOutcome.cases.Completed.make({
            unitId: SHARED_STEP_UNIT_ID,
            attempt: input.attempt,
            changedPaths: [...input.sharedStepPaths],
            packageStampHash: PackageStampHash.make("e".repeat(64)),
          }),
        ),
    })

    const l2RunId = WorkflowRunId.make("run-l2-sib-04")
    const unitA = WorkUnitId.make("unit-a")
    const unitB = WorkUnitId.make("unit-b")
    const l2Plan: CompiledPlan = {
      runId: l2RunId,
      level: "slice",
      planSha: PlanSha256.make("9".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId: unitA,
          projectName: NxProjectName.make("@harness/pkg-a"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/pkg-a/src")],
          stubKeys: [StubSymbolKey.make("PkgA.fn")],
          earsKeys: [EarsRequirementKey.make("REQ-2.2")],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/pkg-a:verify"),
        },
        {
          _tag: "PackageUnit",
          unitId: unitB,
          projectName: NxProjectName.make("@harness/pkg-b"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/pkg-b/src")],
          stubKeys: [StubSymbolKey.make("PkgB.fn")],
          earsKeys: [EarsRequirementKey.make("REQ-2.3")],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/pkg-b:verify"),
        },
      ],
      sharedStepPaths: [],
    }

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: verifierLayer,
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
      },
    })

    try {
      await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan: l2Plan }),
      )
      await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedCanonical.worktreeRoot,
          unitId: unitA,
          runId: l2RunId,
        }),
      )
      expect(
        recordedInputs.find((i) => i.unit.unitId === unitA)?.siblingInFlightOwnedPaths,
      ).toEqual(["libs/pkg-b/src"])

      await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedCanonical.worktreeRoot,
          unitId: unitB,
          runId: l2RunId,
        }),
      )
      await Effect.runPromise(
        resumeWorkflowViaDaemon({
          _tag: "ResolveEscalation",
          repoRoot: validatedCanonical.worktreeRoot,
          runId: l2RunId,
          unitId: unitB,
          decision: "abort",
        }),
      )

      const failedStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId: l2RunId }),
      )
      expect(failedStatus).toMatchObject({
        _tag: "Ready",
        outcome: {
          _tag: "Failed",
          terminalError: { _tag: "Aborted" },
        },
      })

      const mcpToolOut = await Effect.runPromise(
        executeWorkflowPlanTool({ repoRoot: canonicalDir, runId: l2RunId }),
      )
      expect(
        mcpToolOut.status._tag === "Ready" &&
          mcpToolOut.status.outcome._tag === "Failed" &&
          mcpToolOut.status.outcome.terminalError._tag,
      ).toBe("Aborted")
    } finally {
      await daemon.close()
    }
  }, 45_000) // exercises slice siblingInFlightOwnedPaths propagation & TaskRunAbortedError over live daemon IPC

  it("F-17.1: rejects Automatic mode when placeholder dispatcher is active, and runs Automatic mode when runnerKind: 'live'", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("auto-gate")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const autoPlan: CompiledPlan = {
      runId: WorkflowRunId.make("run-auto-gate-05"),
      level: "slice",
      planSha: PlanSha256.make("7".repeat(64)),
      baseSha,
      mode: {
        _tag: "Automatic",
        runner: RunnerId.make("claude-code"),
        maxConcurrency: MaxConcurrency.make(2),
      },
      units: [
        {
          _tag: "PackageUnit",
          unitId: WorkUnitId.make("auto-unit"),
          projectName: NxProjectName.make("@harness/auto"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/auto/src")],
          stubKeys: [StubSymbolKey.make("Auto.fn")],
          earsKeys: [EarsRequirementKey.make("REQ-2.4")],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/auto:verify"),
        },
      ],
      sharedStepPaths: [],
    }

    const placeholderDaemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
        agentDispatcherLayer: UnitAgentDispatcherLive,
      },
    })
    try {
      const placeholderErr = await Effect.runPromise(
        startWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          plan: autoPlan,
        }).pipe(Effect.flip),
      )
      expect(placeholderErr.message).toContain("WF-5")
    } finally {
      await placeholderDaemon.close()
    }

    const liveDispatcherLayer = Layer.succeed(UnitAgentDispatcher, {
      runnerKind: "live" as const,
      dispatchUnit: () => Effect.succeed(UnitAgentDispatchResult.cases.Completed.make({})),
    })
    const liveDaemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
        agentDispatcherLayer: liveDispatcherLayer,
      },
    })
    try {
      await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan: autoPlan }),
      )
      const autoStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: autoPlan.runId,
        }),
      )
      expect(autoStatus).toMatchObject({
        _tag: "Ready",
        outcome: {
          _tag: "Active",
          run: { state: "waiting" },
          pendingDeferreds: [{ _tag: "LlmPhase", deferredName: "llm-phase-done" }],
        },
      })
    } finally {
      await liveDaemon.close()
    }
  }, 45_000) // boots placeholder & live workflow daemon dispatchers over Unix socket and awaits live omnigraph-server persistence

  it("F-6.1 & F-6.2: workflow.start fails closed on missing/corrupt WfRun.planJson and on engine execution without stored plan", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("start-plan-verify")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const plan = makeSingleUnitManualPlan("run-f6-missing-plan-06", baseSha)
    const execId = await Effect.runPromise(executionIdOf(plan))

    let runRowMode: "missing-planJson" | "corrupt-planJson" = "missing-planJson"
    const client = makeMockLeaseStoreClient({
      onRunRow: () => ({
        runId: plan.runId,
        executionId: execId,
        level: plan.level,
        planSha: plan.planSha,
        baseSha: plan.baseSha,
        state: "running",
        updatedMs: 100,
        ...(runRowMode === "corrupt-planJson" ? { planJson: "{not-valid-compiled-plan" } : {}),
      }),
    })

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client,
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
      },
    })

    try {
      const missingErr = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan }).pipe(
          Effect.flip,
        ),
      )
      expect(missingErr.message).toContain("missing stored planJson")

      runRowMode = "corrupt-planJson"
      const corruptErr = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan }).pipe(
          Effect.flip,
        ),
      )
      expect(corruptErr.message).toContain("corrupt stored planJson")
    } finally {
      await daemon.close()
    }

    // F-6.1: verify WorkflowEngine poll returns Some(Suspended) while getRun returns None -> fails closed!
    const { canonicalDir: dir2, baseSha: sha2 } = createWorkRepo("f61-polled")
    const val2 = await Effect.runPromise(validateWorktreeRepoRoot(AbsoluteRepoRoot.make(dir2)))
    const plan2 = makeSingleUnitManualPlan("run-f61-engine-only-07", sha2)
    const daemon2 = await startHarnessDaemonServer(dir2, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(val2.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
      },
    })
    try {
      const execId2 = await Effect.runPromise(executionIdOf(plan2))
      await Effect.runPromise(startWorkflowViaDaemon({ repoRoot: val2.worktreeRoot, plan: plan2 }))
      await daemon2.close()

      // Restart fresh daemon (empty plansRef) with a client that hides WfRun from getRun -> F-6.1 must reject!
      const hideRunClient = makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken })
      const origInvoke = hideRunClient.queries.invoke.bind(hideRunClient.queries)
      const proxiedHideRun = new Proxy(hideRunClient, {
        get(target, prop, receiver) {
          if (prop === "queries") {
            return new Proxy(target.queries, {
              get(qt, qp, qr) {
                if (qp === "invoke") {
                  return (...args: Parameters<typeof origInvoke>) => {
                    if (args[0] === "wf_get_run") {
                      return Promise.resolve({
                        queryName: args[0],
                        rowCount: 0,
                        rows: [],
                        graphCommitId: null,
                        target: { branch: "main" },
                      })
                    }
                    return origInvoke(...args)
                  }
                }
                return Reflect.get(qt, qp, qr)
              },
            })
          }
          return Reflect.get(target, prop, receiver)
        },
      })

      const daemon3 = await startHarnessDaemonServer(dir2, {
        workflowEngine: {
          mode: "required",
          client: proxiedHideRun,
          entityReplyPollInterval: "50 millis",
          unitVerifierLayer: makeCompletedVerifierLayer(),
          worktreePortLayer: makeNoopWorktreeLayer(val2.worktreeRoot),
          reviewRouterLayer: makeReviewStubLayer(),
        },
      })
      try {
        const f61Err = await Effect.runPromise(
          startWorkflowViaDaemon({ repoRoot: val2.worktreeRoot, plan: plan2 }).pipe(Effect.flip),
        )
        expect(f61Err.message).toContain(execId2)
        expect(f61Err.message).toContain("without a verifiable stored plan")
      } finally {
        await daemon3.close()
      }
    } finally {
      await daemon2.close()
    }
  }, 45_000) // restarts daemon across corrupt/missing planJson cases and validates fail-closed Unix-socket RPC responses

  it("F-23.2: covers daemon runtime inactive, malformed RPC payload, unknown RPC method, and concurrent same-run calls", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("edge-cases")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const plan = makeSingleUnitManualPlan("run-edge-conc-08", baseSha)

    // 1. Inactive runtime returns explicit "runtime is inactive" error on workflow.start
    const inactiveDaemon = await startHarnessDaemonServer(canonicalDir, {
      writerLeaseEpoch: LeaseEpoch.make(1),
      workflowEngine: { mode: "disabled" },
    })
    try {
      const inactiveErr = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan }).pipe(
          Effect.flip,
        ),
      )
      expect(inactiveErr.message).toContain("runtime is inactive")

      // 2. Malformed JSON payload -> "Invalid daemon request payload"
      const malformedRes = await Effect.runPromise(
        queryUnixSocketLineDetailed(
          DaemonSocketPath.make(inactiveDaemon.socketPath),
          "{not-valid-json",
          { timeoutMs: 5000 },
        ).pipe(Effect.provide(UnixSocketDaemonLive)),
      )
      match(malformedRes)
        .with({ _tag: "Reply" }, ({ line }) => {
          expect(JSON.parse(line)).toMatchObject({
            ok: false,
            error: "Invalid daemon request payload",
          })
        })
        .with({ _tag: "Unavailable" }, ({ reason }) => {
          expect.unreachable(`Expected Reply, got Unavailable(${reason})`)
        })
        .exhaustive()

      // 3. Unknown RPC method preserves id/command and returns explicit unknown command error
      const unknownCmd = await Effect.runPromise(
        queryWorkflowDaemonCommand({
          socketPath: DaemonSocketPath.make(inactiveDaemon.socketPath),
          command: "workflow.unknownMethod",
          payload: { repoRoot: canonicalDir },
        }).pipe(Effect.provide(UnixSocketDaemonLive)),
      )
      expect(unknownCmd).toMatchObject({
        ok: false,
        command: "workflow.unknownMethod",
      })
      expect(String(unknownCmd.error)).toContain("Unknown daemon command")
    } finally {
      await inactiveDaemon.close()
    }

    // 4. Concurrent same-run workflow.start calls serialize cleanly via withRunLock
    const liveDaemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
      },
    })
    try {
      const [r1, r2] = await Effect.runPromise(
        Effect.all(
          [
            startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan }),
            startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan }),
          ],
          { concurrency: 2 },
        ),
      )
      expect(r1.executionId).toBe(r2.executionId)
      expect([r1.outcome, r2.outcome].sort()).toEqual(["existing", "started"])
    } finally {
      await liveDaemon.close()
    }
  }, 45_000) // tests concurrent Unix-socket RPC calls, malformed payloads, and inactive daemon runtime handling

  const withStatefulLeaseDoctorDaemon = async (
    name: string,
    fn: (ctx: {
      readonly worktreeRoot: AbsoluteRepoRoot
      readonly lockFilePath: string
      readonly getStoredLease: () => Record<string, unknown> | null
      readonly setOverriddenLease: (row: Record<string, unknown> | null | undefined) => void
      readonly setForceCorruptJournal: (flag: boolean) => void
    }) => Promise<void>,
  ): Promise<void> => {
    const { canonicalDir } = createWorkRepo(name)
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const runtimePaths = resolveWorkflowRuntimePaths(validatedCanonical.commonGitDir)
    let overriddenLease: Record<string, unknown> | null | undefined = undefined
    let forceCorruptJournal = false

    const client = makeMockLeaseStoreClient({
      getLeaseRow: () => overriddenLease ?? null,
      forceCorruptJournal,
    })

    const leaseBox: { row: Record<string, unknown> | null } = { row: null }
    const baseClient = new OmnigraphClient({
      baseUrl: "http://127.0.0.1:1",
      graphId: "harness-workflows",
    })
    const statefulClient = new Proxy(baseClient, {
      get(target, prop, receiver) {
        if (prop === "queries") {
          return new Proxy(target.queries, {
            get(qt, qp, qr) {
              if (qp === "invoke") {
                return (
                  queryName: string,
                  input?: { readonly params?: Record<string, unknown> },
                ) => {
                  const params = input?.params ?? {}
                  if (queryName === "wf_get_writer_lease") {
                    const row = overriddenLease !== undefined ? overriddenLease : leaseBox.row
                    return Promise.resolve({
                      queryName,
                      rowCount: row === null ? 0 : 1,
                      rows: row === null ? [] : [{ ...row }],
                      graphCommitId: "commit-1",
                      target: { branch: "main" },
                    })
                  }
                  if (queryName === "wf_insert_writer_lease") {
                    leaseBox.row = {
                      name: "engine",
                      owner: typeof params.owner === "string" ? params.owner : "",
                      leaseEpoch: Number(params.leaseEpoch ?? 1),
                      heartbeatMs: Number(params.heartbeatMs ?? Date.now()),
                    }
                    return Promise.resolve({
                      queryName,
                      affectedNodes: 1,
                      affectedEdges: 0,
                      branch: "main",
                      commit: { graphCommitId: "commit-2" },
                    })
                  }
                  if (queryName === "wf_all_entities" && forceCorruptJournal) {
                    return Promise.resolve({
                      queryName,
                      rowCount: 1,
                      rows: [
                        {
                          messageKey: "1",
                          seqKey: "0".repeat(20),
                          entityType: "Workflow/HarnessTaskWorkflow",
                        },
                      ],
                      graphCommitId: "commit-2",
                      target: { branch: "main" },
                    })
                  }
                  return client.queries.invoke(queryName, input)
                }
              }
              return Reflect.get(qt, qp, qr)
            },
          })
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: statefulClient,
        heartbeatIntervalMs: 30_000,
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
      },
    })
    try {
      await fn({
        worktreeRoot: validatedCanonical.worktreeRoot,
        lockFilePath: runtimePaths.lockFilePath,
        getStoredLease: () => leaseBox.row,
        setOverriddenLease: (row) => {
          overriddenLease = row
        },
        setForceCorruptJournal: (flag) => {
          forceCorruptJournal = flag
        },
      })
    } finally {
      await daemon.close()
    }
  }

  it("F-8.2, F-12.1: verifies canonical timeout constants and writer-lease doctor statuses (ok, stale-TTL warn, missing meta warn)", async () => {
    expect(WORKFLOW_COMPLETE_IPC_TIMEOUT_MS).toBe(150_000)
    expect(WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS).toBe(160_000)
    await withStatefulLeaseDoctorDaemon(
      "lease-doc-health",
      async ({ worktreeRoot, lockFilePath, getStoredLease, setOverriddenLease }) => {
        // 1. Healthy lease check passes
        const healthyDoc = await Effect.runPromise(
          doctorWorkflowViaDaemon({
            repoRoot: worktreeRoot,
            mode: WorkflowDoctorMode.make("check-only"),
          }),
        )
        expect(healthyDoc.checks.find((c) => c.name === "writer-lease")?.status).toBe("ok")

        // 2. Stale heartbeat TTL -> warn (F-8.2)
        const currentStoredLease = getStoredLease()
        if (currentStoredLease === null) {
          expect.unreachable("Expected storedLease to be populated")
          return
        }
        setOverriddenLease({
          ...currentStoredLease,
          heartbeatMs: Date.now() - WRITER_LEASE_HEARTBEAT_TTL_MS - 1_000,
        })
        const staleDoc = await Effect.runPromise(
          doctorWorkflowViaDaemon({
            repoRoot: worktreeRoot,
            mode: WorkflowDoctorMode.make("check-only"),
          }),
        )
        expect(staleDoc.checks.find((c) => c.name === "writer-lease")?.status).toBe("warn")

        // 3. Missing meta.json -> warn (F-8.2)
        setOverriddenLease(undefined)
        const metaPath = `${lockFilePath}.meta.json`
        const savedMeta = readFileSync(metaPath, "utf8")
        unlinkSync(metaPath)
        const missingMetaDoc = await Effect.runPromise(
          doctorWorkflowViaDaemon({
            repoRoot: worktreeRoot,
            mode: WorkflowDoctorMode.make("check-only"),
          }),
        )
        expect(missingMetaDoc.checks.find((c) => c.name === "writer-lease")?.status).toBe("warn")
        writeFileSync(metaPath, savedMeta, "utf8")
      },
    )
  }, 45_000) // boots live Unix socket daemon with mock Omnigraph store and runs sequential doctor RPC checks

  it("F-2.5: corrupt journal fails doctor rebuild closed instead of swallowing/skipping", async () => {
    await withStatefulLeaseDoctorDaemon(
      "lease-doc-corrupt",
      async ({ worktreeRoot, setForceCorruptJournal }) => {
        setForceCorruptJournal(true)
        const corruptRebuildErr = await Effect.runPromise(
          doctorWorkflowViaDaemon({
            repoRoot: worktreeRoot,
            mode: WorkflowDoctorMode.make("rebuild"),
          }).pipe(Effect.flip),
        )
        expect(corruptRebuildErr.message).toContain("Corrupt")
      },
    )
  }, 45_000) // boots live Unix socket daemon with mock Omnigraph store and executes doctor rebuild RPC

  it("F-7.1, F-8.1, F-8.2, F-23.2: lease epoch change mid-request reports doctor fail and fails closed on status RPC", async () => {
    await withStatefulLeaseDoctorDaemon(
      "lease-doc-fence",
      async ({ worktreeRoot, setOverriddenLease }) => {
        setOverriddenLease({
          name: "engine",
          owner: "rival-daemon#999",
          leaseEpoch: 99,
          heartbeatMs: Date.now(),
        })
        const mismatchedDoc = await Effect.runPromise(
          doctorWorkflowViaDaemon({
            repoRoot: worktreeRoot,
            mode: WorkflowDoctorMode.make("check-only"),
          }),
        )
        expect(mismatchedDoc.checks.find((c) => c.name === "writer-lease")?.status).toBe("fail")

        const fencedStatusErr = await Effect.runPromise(
          getWorkflowStatusViaDaemon({
            repoRoot: worktreeRoot,
            runId: WorkflowRunId.make("run-fenced-01"),
          }).pipe(Effect.flip),
        )
        expect(fencedStatusErr.message).toContain("rival-daemon")
      },
    )
  }, 45_000) // boots live Unix socket daemon with mock Omnigraph store and executes fenced doctor/status RPCs

  it("F-12.1: workflow.complete polling fails immediately on WorkflowStoreUnavailableError", async () => {
    // 6. F-12.1: polling loop in workflow.complete fails immediately on WorkflowStoreUnavailableError
    const { canonicalDir: pollDir, baseSha: pollSha } = createWorkRepo("f12-poll")
    const valPoll = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(pollDir)),
    )
    const pollPlan = makeSingleUnitManualPlan("run-f12-poll-09", pollSha)
    const pollUnitId = pollPlan.units[0]!.unitId
    let listUnitsCalls = 0
    let failPollOnSecondList = false

    const pollDaemon = await startHarnessDaemonServer(pollDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(valPoll.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
        readModelQueryLayer: Layer.succeed(WorkflowReadModelQuery, {
          getRun: () => Effect.succeedNone,
          listRuns: Effect.succeed([]),
          listUnits: () => {
            listUnitsCalls += 1
            if (failPollOnSecondList && listUnitsCalls >= 2) {
              return Effect.fail(
                new WorkflowStoreUnavailableError({
                  operation: WorkflowStoreOperation.make("Test.listUnits"),
                  reason: toBoundedReason("Injected outage during poll"),
                }),
              )
            }
            return Effect.succeed([
              {
                unitKey: makeWorkflowUnitKey(pollPlan.runId, pollUnitId),
                runId: pollPlan.runId,
                unitId: pollUnitId,
                kind: "package" as const,
                waveIndex: WaveIndex.make(0),
                status: "dispatched" as const,
                ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
                updatedMs: WorkflowTimestampMs.make(1),
              },
            ])
          },
          listAttempts: () => Effect.succeed([]),
          probeAvailability: Effect.succeed("ready" as const),
        }),
      },
    })
    try {
      await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: valPoll.worktreeRoot, plan: pollPlan }),
      )
      failPollOnSecondList = true
      const pollErr = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: valPoll.worktreeRoot,
          unitId: pollUnitId,
          runId: pollPlan.runId,
        }).pipe(Effect.flip),
      )
      expect(pollErr.message).toContain("Injected outage during poll")
    } finally {
      await pollDaemon.close()
    }
  }, 45_000) // boots daemon with failing WorkflowStore mock and polls Unix socket until WorkflowStoreUnavailableError surfaces

  it("F-21.1 & F-21.3: fails closed on missing rejection or corrupt EscalationResolution deferred payload", async () => {
    const unitId = WorkUnitId.make("unit-corrupt")
    const missingRejErr = await Effect.runPromise(
      extractLastRejection([], [], unitId).pipe(Effect.flip),
    )
    expect(missingRejErr).toContain("No recorded UnitRejection found")

    const escDef = makeUnitEscalationDeferred(unitId, EscalationOrdinal.make(1))
    const corruptDef = DurableDeferred.make(escDef.name, {
      success: Schema.Struct({ invalid: Schema.String }),
    })
    const executionId = WorkflowExecutionId.make("run-corrupt-esc")

    const corruptCycleErr = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* engine.deferredDone(corruptDef, {
          workflowName: HarnessTaskWorkflow._tag,
          executionId,
          deferredName: escDef.name,
          exit: Exit.succeed({ invalid: "payload" }),
        })
        return yield* inspectActiveUnitCycle(engine, executionId, unitId)
      }).pipe(Effect.provide(WorkflowEngine.layerMemory), Effect.flip),
    )
    expect(corruptCycleErr).toContain("Missing key")
  })

  it("offline harness_workflow_plan returns DaemonOffline+NotFound, and non-git/escape/cross-repo roots fail closed", async () => {
    const workBase = mkdtempSync(join(tmpdir(), "wf3-offline-"))
    tempDirs.push(workBase)
    const { canonicalDir } = initTestGitRepo(workBase, "offline-repo")
    const { canonicalDir: otherGitRepo } = initTestGitRepo(workBase, "other-repo")
    const outsideDir = join(workBase, "outside-nongit")
    mkdirSync(outsideDir, { recursive: true })
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )

    const offlinePlanOut = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: canonicalDir }),
    )
    expect(offlinePlanOut.resolvedRepoRoot).toBe(validatedCanonical.worktreeRoot)
    expect(offlinePlanOut.commonGitDir).toBe(validatedCanonical.commonGitDir)
    expect(offlinePlanOut.status._tag).toBe("DaemonOffline")
    expect("writerLeaseEpoch" in offlinePlanOut.status).toBe(false)

    const invalidErr = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: outsideDir }).pipe(Effect.flip),
    )
    expect(toErrorReasonMessage(invalidErr)).toContain("git")

    const escapeErr = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: "../outside-nongit" }, { repoRoot: canonicalDir }).pipe(
        Effect.flip,
      ),
    )
    expect(escapeErr._tag).toBe("ProjectPathEscapeError")

    const crossRepoErr = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: otherGitRepo }, { repoRoot: canonicalDir }).pipe(
        Effect.flip,
      ),
    )
    expect(crossRepoErr._tag).toBe("ProjectPathEscapeError")
  })

  it("handles StorePaused, OperatorAborted, and doctor rebuild fail-closed on failed writer lease", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("status-edge-cases")
    const val = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const runId = WorkflowRunId.make("run-paused-abort-01")
    const pausedPlan = makeSingleUnitManualPlan(runId, baseSha)
    const client = createClient()
    let simulateAbortedRun = false

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client,
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(val.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
        readModelQueryLayer: Layer.succeed(WorkflowReadModelQuery, {
          getRun: (id) =>
            simulateAbortedRun
              ? Effect.succeedSome({
                  runId: id,
                  executionId: WorkflowExecutionId.make(id),
                  level: "slice" as const,
                  planSha: pausedPlan.planSha,
                  baseSha,
                  state: "aborted" as const,
                  updatedMs: WorkflowTimestampMs.make(123),
                })
              : Effect.succeedNone,
          listRuns: simulateAbortedRun
            ? Effect.succeed([
                {
                  runId,
                  executionId: WorkflowExecutionId.make(runId),
                  level: "slice" as const,
                  planSha: pausedPlan.planSha,
                  baseSha,
                  state: "aborted" as const,
                  updatedMs: WorkflowTimestampMs.make(123),
                },
              ])
            : Effect.succeed([]),
          listUnits: () => Effect.succeed([]),
          listAttempts: () => Effect.succeed([]),
          probeAvailability: Effect.succeed("paused" as const),
        }),
      },
    })
    try {
      const pausedStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: val.worktreeRoot }),
      )
      match(pausedStatus)
        .with({ _tag: "StorePaused" }, ({ outcome }) => {
          expect(outcome._tag).toBe("NotFound")
        })
        .with({ _tag: "Ready" }, { _tag: "DaemonOffline" }, () => {
          expect.unreachable("Expected StorePaused")
        })
        .exhaustive()

      simulateAbortedRun = true
      const abortedStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: val.worktreeRoot, runId }),
      )
      match(abortedStatus)
        .with({ _tag: "StorePaused" }, ({ outcome }) => {
          match(outcome)
            .with({ _tag: "Failed" }, ({ terminalError }) => {
              expect(terminalError._tag).toBe("OperatorAborted")
            })
            .with({ _tag: "Active" }, { _tag: "Completed" }, { _tag: "NotFound" }, () => {
              expect.unreachable("Expected Failed(OperatorAborted)")
            })
            .exhaustive()
        })
        .with({ _tag: "Ready" }, { _tag: "DaemonOffline" }, () => {
          expect.unreachable("Expected StorePaused")
        })
        .exhaustive()

      // Remove OS lockFilePath so checkWriterLeaseDoctorHealth reports fail -> doctor rebuild must refuse fail-closed
      const runtimePaths = resolveWorkflowRuntimePaths(val.commonGitDir)
      unlinkSync(runtimePaths.lockFilePath)
      const doctorRebuildErr = await Effect.runPromise(
        doctorWorkflowViaDaemon({
          repoRoot: val.worktreeRoot,
          mode: WorkflowDoctorMode.make("rebuild"),
        }).pipe(Effect.flip),
      )
      expect(doctorRebuildErr.message).toContain("Refusing read-model rebuild while writer-lease")
    } finally {
      await daemon.close()
    }
  }, 45_000) // boots live daemon & omnigraph-server to assert doctor --rebuild-views writer-lease conflict refusal

  it("directly exercises all WorkflowRpcDaemon EffectFns fail-closed and in-memory", async () => {
    const workBase = mkdtempSync(join(tmpdir(), "wf3-direct-rpc-"))
    tempDirs.push(workBase)
    const { canonicalDir } = initTestGitRepo(workBase, "direct-repo")
    const { canonicalDir: otherDir } = initTestGitRepo(workBase, "other-repo")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )

    const allowedScope = {
      _tag: "Allowed" as const,
      resolvedRoot: validatedCanonical.worktreeRoot,
      validatedWorktree: validatedCanonical,
      daemonWorktree: validatedCanonical,
    }

    const offlineStart = await Effect.runPromise(
      handleDaemonWorkflowStartRequest({
        requestId: "direct-start-1",
        rawPayload: {},
        scope: allowedScope,
      }),
    )
    expect(offlineStart.ok).toBe(false)

    const offlineComplete = await Effect.runPromise(
      handleDaemonWorkflowCompleteRequest({
        requestId: "direct-complete-1",
        rawPayload: {},
        scope: allowedScope,
      }),
    )
    expect(offlineComplete.ok).toBe(false)

    const offlineResume = await Effect.runPromise(
      handleDaemonWorkflowResumeRequest({
        requestId: "direct-resume-1",
        rawPayload: {},
        scope: allowedScope,
      }),
    )
    expect(offlineResume.ok).toBe(false)

    const offlineAbort = await Effect.runPromise(
      handleDaemonWorkflowAbortRequest({
        requestId: "direct-abort-1",
        rawPayload: {},
        scope: allowedScope,
      }),
    )
    expect(offlineAbort.ok).toBe(false)

    const offlineDoctor = await Effect.runPromise(
      handleDaemonWorkflowDoctorRequest({
        requestId: "direct-doctor-1",
        rawPayload: {},
        scope: allowedScope,
      }),
    )
    expect(offlineDoctor.ok).toBe(false)

    const offlineStatus = await Effect.runPromise(
      handleDaemonWorkflowStatusRpcRequest({
        requestId: "direct-status-1",
        rawPayload: {},
        scope: allowedScope,
      }),
    )
    expect(offlineStatus).toMatchObject({ ok: true, result: { _tag: "DaemonOffline" } })

    const validatedViaHelper = await Effect.runPromise(
      validateRpcRepoRoot(validatedCanonical.worktreeRoot, allowedScope),
    )
    expect(validatedViaHelper.commonGitDir).toBe(validatedCanonical.commonGitDir)

    const crossRepoErr = await Effect.runPromise(
      validateRpcRepoRoot(AbsoluteRepoRoot.make(otherDir), allowedScope).pipe(Effect.flip),
    )
    expect(crossRepoErr).toContain("commonGitDir")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const projectionWriterLayer = Layer.succeed(WorkflowProjectionWriter, {
            upsertRun: () => Effect.void,
            upsertUnit: () => Effect.void,
            upsertAttempt: () => Effect.void,
          })
          const readModelLayer = Layer.succeed(WorkflowReadModelQuery, {
            getRun: () => Effect.succeedNone,
            listRuns: Effect.succeed([]),
            listUnits: () => Effect.succeed([]),
            listAttempts: () => Effect.succeed([]),
            probeAvailability: Effect.succeed("ready" as const),
          })
          const portsLayer = Layer.mergeAll(
            makeCompletedVerifierLayer(),
            makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
            UnitAgentDispatcherLive,
            makeReviewStubLayer(),
            projectionWriterLayer,
            readModelLayer,
          )
          const fullLayer = HarnessTaskWorkflowLayer.pipe(
            Layer.provideMerge(Layer.merge(WorkflowEngine.layerMemory, portsLayer)),
          )
          const workflowContext = yield* Layer.buildWithScope(fullLayer, scope)
          const plansRef = yield* SynchronizedRef.make<ReadonlyMap<WorkflowRunId, CompiledPlan>>(
            new Map(),
          )
          const runMutexesRef = yield* SynchronizedRef.make<
            ReadonlyMap<WorkflowRunId, Semaphore.Semaphore>
          >(new Map())
          const runtime: WorkflowDaemonRuntime = {
            workflowContext,
            engine: Context.get(workflowContext, WorkflowEngine.WorkflowEngine),
            projectionWriter: Context.get(workflowContext, WorkflowProjectionWriter),
            readModelQuery: Context.get(workflowContext, WorkflowReadModelQuery),
            unitVerifier: Context.get(workflowContext, UnitVerifier),
            unitAgentDispatcher: Context.get(workflowContext, UnitAgentDispatcher),
            worktreePort: Context.get(workflowContext, WorkflowWorktreePort),
            reviewRouter: Context.get(workflowContext, WorkflowReviewRouter),
            leaseFence: { commonGitDir: validatedCanonical.commonGitDir },
            plansRef,
            runMutexesRef,
            rebuildMutex: Semaphore.makeUnsafe(1),
            rebuildRpcGateSemaphore: Semaphore.makeUnsafe(16),
            rebuildProjectionGateSemaphore: Semaphore.makeUnsafe(16),
            journalWriteMutex: Semaphore.makeUnsafe(1),
            canonicalRepoRoot: validatedCanonical.worktreeRoot,
            commonGitDir: validatedCanonical.commonGitDir,
            hostIo: nodeSyncHostIo,
          }

          const missingRunErr = yield* resolveRunTarget(runtime).pipe(Effect.flip)
          expect(missingRunErr).toBe("No workflow run found")

          const summary = yield* buildStatusSummaryForRuntime(runtime, LeaseEpoch.make(1)).pipe(
            Effect.provideService(WorkflowReadModelQuery, runtime.readModelQuery),
          )
          expect(summary).toEqual({
            _tag: "Ready",
            writerLeaseEpoch: LeaseEpoch.make(1),
            outcome: WorkflowRunOutcome.cases.NotFound.make({}),
          })
        }),
      ),
    )
  })
})
