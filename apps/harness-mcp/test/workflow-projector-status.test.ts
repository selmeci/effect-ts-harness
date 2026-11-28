import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
  SynchronizedRef,
} from "effect"
import { WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  CANONICAL_MCP_TOOL_NAMES,
  type CompiledPlan,
  FrictionLogState,
  GateDurationMs,
  GitCommitSha,
  LeaseEpoch,
  McpToolName,
  NonNegativeCount,
  OmnigraphBranchName,
  PlanSha256,
  ReviewDepth,
  ReviewRoutingReason,
  ReviewRoutingSource,
  ShipAttempt,
  ShipAttemptKey,
  ShipStagePassed,
  type ShipStreamProgressEvent,
  type TaskRunReceipt,
  WorkUnitId,
  WorkflowExecutionId,
  WorkflowProjectionOutcome,
  WorkflowProjectAllOutcome,
  WorkflowProjectionStatus,
  WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowShipAttemptRecord,
  WorkflowTimestampMs,
  WorkspaceTreeHash,
} from "@harness/contract"
import { HarnessTaskWorkflowLayer, ShipWorkflowLayer } from "@harness/gates"
import { HARNESS_GQ_QUERY_NAMES } from "@harness/graph"
import {
  UnitAgentDispatcherLive,
  createShipActiveGateController,
  getWorkflowStatusViaDaemon,
  nodeSyncHostIo,
  startWorkflowViaDaemon,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import {
  ShipAttemptStore,
  ShipGateRunner,
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowProjectionWriter,
  WorkflowProjector,
  WorkflowReadModelQuery,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import { startHarnessDaemonServer } from "../src/daemon/unix-socket-daemon.js"
import { type WorkflowDaemonRuntime } from "../src/daemon/workflow-engine-daemon-helper.js"
import { buildWorkflowPortsLayer } from "../src/daemon/workflow-ports-daemon-helper.js"
import { handleDaemonWorkflowStartRequest } from "../src/daemon/workflow-rpc-daemon-helper.js"
import {
  buildStatusSummaryForRuntime,
  handleDaemonWorkflowStatusRpcRequest,
} from "../src/daemon/workflow-rpc-status-helper.js"
import { computeProjectionStatus } from "../src/daemon/workflow-rpc-shared.js"
import { GqQueryInputSchema } from "../src/tools/ontology-and-gq.tools.js"
import { executeWorkflowPlanTool } from "../src/tools/workflow-plan.tools.js"
import {
  initTestGitRepo,
  makeCompletedVerifierLayer,
  makeNoopWorktreeLayer,
  makeSingleUnitManualPlan,
  reviewStubLayer,
  startWorkflowDaemonServerHarness,
} from "./helpers/workflow-daemon-fixture.js"

const ZERO_COUNTS = {
  runsUpserted: NonNegativeCount.make(0),
  unitsUpserted: NonNegativeCount.make(0),
  attemptsUpserted: NonNegativeCount.make(0),
  edgesUpserted: NonNegativeCount.make(0),
} as const

const makeControlledProjectorLayer = (
  statusRef: Ref.Ref<Option.Option<WorkflowProjectionStatus>>,
): Layer.Layer<WorkflowProjector> =>
  Layer.succeed(WorkflowProjector, {
    project: (input) =>
      Effect.succeed(
        WorkflowProjectionOutcome.cases.Projected.make({
          runId: input.runId,
          branch: OmnigraphBranchName.make("impl/test"),
          projectionStatus: "fresh",
          commitId: null,
          counts: ZERO_COUNTS,
        }),
      ),
    projectAll: () =>
      Effect.succeed(
        WorkflowProjectAllOutcome.cases.Projected.make({
          branch: OmnigraphBranchName.make("impl/test"),
          projectionStatus: "fresh",
          outcomes: [],
        }),
      ),
    getProjectionStatus: () => Ref.get(statusRef),
  })

const makeShipAttemptRecord = (
  runId: WorkflowRunId,
  attempt: ShipAttempt,
  status: WorkflowShipAttemptRecord["status"],
): WorkflowShipAttemptRecord => ({
  shipKey: ShipAttemptKey.make(`${runId}#${attempt}`),
  runId,
  attempt,
  treeHash: WorkspaceTreeHash.make("a".repeat(64)),
  status,
  updatedMs: WorkflowTimestampMs.make(1),
})

const extractProjectionStatusFromSummary = (
  summary: Effect.Success<ReturnType<typeof buildStatusSummaryForRuntime>>,
): WorkflowProjectionStatus | undefined =>
  match(summary)
    .with({ _tag: "Ready" }, { _tag: "StorePaused" }, { _tag: "DaemonOffline" }, ({ outcome }) =>
      match(outcome)
        .with(
          { _tag: "Active" },
          { _tag: "Completed" },
          { _tag: "Failed" },
          (o) => o.projectionStatus,
        )
        .with({ _tag: "NotFound" }, () => undefined)
        .exhaustive(),
    )
    .exhaustive()

describe("WF-6 WorkflowProjector status propagation & MCP GQ schema validation", () => {
  const daemonHarness = startWorkflowDaemonServerHarness("wf6-mcp-projector-")
  const tempDirs: Array<string> = []

  beforeAll(() => daemonHarness.start(), 30_000)
  afterAll(async () => {
    await daemonHarness.stop()
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("buildStatusSummaryForRuntime and workflow.status RPC surface stale when WorkflowProjector reports stale even if WfRun read-model is fresh", async () => {
    const workBase = mkdtempSync(join(tmpdir(), "wf6-status-summary-"))
    tempDirs.push(workBase)
    const { canonicalDir, baseSha } = initTestGitRepo(workBase, "status-repo")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const allowedScope = {
      _tag: "Allowed" as const,
      resolvedRoot: validatedCanonical.worktreeRoot,
      validatedWorktree: validatedCanonical,
      daemonWorktree: validatedCanonical,
    }
    const runId = WorkflowRunId.make("run-wf6-projection-status-1")
    const plan = makeSingleUnitManualPlan(runId, baseSha)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const storedRuns = new Map<WorkflowRunId, WorkflowRunRecord>()
          const readableStatusRef = yield* Ref.make<Option.Option<WorkflowProjectionStatus>>(
            Option.none(),
          )

          const projectionWriterLayer = Layer.succeed(WorkflowProjectionWriter, {
            upsertRun: (run) =>
              Effect.sync(() => {
                storedRuns.set(run.runId, run)
              }),
            upsertUnit: () => Effect.void,
            upsertAttempt: () => Effect.void,
          })
          const readModelLayer = Layer.succeed(WorkflowReadModelQuery, {
            getRun: (id) => {
              const found = storedRuns.get(id)
              return found !== undefined ? Effect.succeedSome(found) : Effect.succeedNone
            },
            listRuns: Effect.sync(() => [...storedRuns.values()]),
            listUnits: () => Effect.succeed([]),
            listAttempts: () => Effect.succeed([]),
            probeAvailability: Effect.succeed("ready" as const),
          })
          const shipGateRunnerLayer = Layer.succeed(ShipGateRunner, {
            computeTreeHash: () => Effect.succeed(WorkspaceTreeHash.make("a".repeat(64))),
            recoverMutationBackup: () => Effect.void,
            executeStageCommand: (input) =>
              Effect.succeed(
                ShipStagePassed.make({
                  stage: input.stage,
                  durationMs: GateDurationMs.make(1),
                }),
              ),
            reportStageProgress: () => Effect.void,
          })
          const shipAttemptStoreLayer = Layer.succeed(ShipAttemptStore, {
            allocateAttempt: ({ runId: id }) =>
              Effect.succeed(makeShipAttemptRecord(id, ShipAttempt.make(1), "running")),
            updateStatus: ({ runId: id, attempt, status }) =>
              Effect.succeed(makeShipAttemptRecord(id, attempt, status)),
            listAttemptsForRun: () => Effect.succeed([]),
          })
          const portsLayer = Layer.mergeAll(
            makeCompletedVerifierLayer(),
            makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
            UnitAgentDispatcherLive,
            reviewStubLayer,
            projectionWriterLayer,
            readModelLayer,
            makeControlledProjectorLayer(readableStatusRef),
            shipGateRunnerLayer,
            shipAttemptStoreLayer,
          )
          const fullLayer = Layer.merge(HarnessTaskWorkflowLayer, ShipWorkflowLayer).pipe(
            Layer.provideMerge(Layer.merge(WorkflowEngine.layerMemory, portsLayer)),
          )
          const workflowContext = yield* Layer.buildWithScope(fullLayer, scope)
          const runtime: WorkflowDaemonRuntime = {
            workflowContext,
            shipWorkflowContext: workflowContext,
            engine: Context.get(workflowContext, WorkflowEngine.WorkflowEngine),
            projectionWriter: Context.get(workflowContext, WorkflowProjectionWriter),
            workflowProjector: Context.get(workflowContext, WorkflowProjector),
            readModelQuery: Context.get(workflowContext, WorkflowReadModelQuery),
            unitVerifier: Context.get(workflowContext, UnitVerifier),
            unitAgentDispatcher: Context.get(workflowContext, UnitAgentDispatcher),
            worktreePort: Context.get(workflowContext, WorkflowWorktreePort),
            reviewRouter: Context.get(workflowContext, WorkflowReviewRouter),
            shipGateRunner: Context.get(workflowContext, ShipGateRunner),
            shipAttemptStore: Context.get(workflowContext, ShipAttemptStore),
            shipProgressListeners: new Map(),
            shipGateController: createShipActiveGateController(),
            leaseFence: { commonGitDir: validatedCanonical.commonGitDir },
            plansRef: yield* SynchronizedRef.make<ReadonlyMap<WorkflowRunId, CompiledPlan>>(
              new Map(),
            ),
            runMutexesRef: yield* SynchronizedRef.make<
              ReadonlyMap<WorkflowRunId, Semaphore.Semaphore>
            >(new Map()),
            shipWorktreeMutexesRef: yield* SynchronizedRef.make<
              ReadonlyMap<AbsoluteRepoRoot, Semaphore.Semaphore>
            >(new Map()),
            rebuildMutex: Semaphore.makeUnsafe(1),
            rebuildRpcGateSemaphore: Semaphore.makeUnsafe(16),
            rebuildProjectionGateSemaphore: Semaphore.makeUnsafe(16),
            journalWriteMutex: Semaphore.makeUnsafe(1),
            canonicalRepoRoot: validatedCanonical.worktreeRoot,
            commonGitDir: validatedCanonical.commonGitDir,
            hostIo: nodeSyncHostIo,
          }

          const startEnv = yield* handleDaemonWorkflowStartRequest({
            requestId: "req-start-wf6-status",
            rawPayload: { repoRoot: validatedCanonical.worktreeRoot, plan },
            scope: allowedScope,
            runtime,
          })
          expect(startEnv.ok).toBe(true)

          // 1. Baseline: readableStatus is None -> WfRun read-model is fresh
          const baselineSummary = yield* buildStatusSummaryForRuntime(
            runtime,
            LeaseEpoch.make(1),
            runId,
          ).pipe(Effect.provideService(WorkflowReadModelQuery, runtime.readModelQuery))
          expect(extractProjectionStatusFromSummary(baselineSummary)).toBe("fresh")

          // 2. Projector reports stale -> summary and workflow.status RPC both surface "stale"
          yield* Ref.set(readableStatusRef, Option.some(WorkflowProjectionStatus.make("stale")))
          const staleSummary = yield* buildStatusSummaryForRuntime(
            runtime,
            LeaseEpoch.make(1),
            runId,
          ).pipe(Effect.provideService(WorkflowReadModelQuery, runtime.readModelQuery))
          expect(extractProjectionStatusFromSummary(staleSummary)).toBe("stale")

          const staleRpc = yield* handleDaemonWorkflowStatusRpcRequest({
            requestId: "req-status-stale",
            rawPayload: { repoRoot: validatedCanonical.worktreeRoot, runId },
            scope: allowedScope,
            writerLeaseEpoch: LeaseEpoch.make(1),
            runtime,
          })
          expect(staleRpc).toMatchObject({
            ok: true,
            command: "workflow.status",
            result: {
              _tag: "Ready",
              outcome: {
                _tag: "Active",
                projectionStatus: "stale",
              },
            },
          })

          // 3. Projector reports fresh -> summary and workflow.status RPC both surface "fresh"
          yield* Ref.set(readableStatusRef, Option.some(WorkflowProjectionStatus.make("fresh")))
          const freshSummary = yield* buildStatusSummaryForRuntime(
            runtime,
            LeaseEpoch.make(1),
            runId,
          ).pipe(Effect.provideService(WorkflowReadModelQuery, runtime.readModelQuery))
          expect(extractProjectionStatusFromSummary(freshSummary)).toBe("fresh")

          const freshRpc = yield* handleDaemonWorkflowStatusRpcRequest({
            requestId: "req-status-fresh",
            rawPayload: { repoRoot: validatedCanonical.worktreeRoot, runId },
            scope: allowedScope,
            writerLeaseEpoch: LeaseEpoch.make(1),
            runtime,
          })
          expect(freshRpc).toMatchObject({
            ok: true,
            command: "workflow.status",
            result: {
              _tag: "Ready",
              outcome: {
                _tag: "Active",
                projectionStatus: "fresh",
              },
            },
          })
        }),
      ),
    )
  })

  it("daemon workflow.status and harness_workflow_plan surface stale/fresh from workflowProjectorLayer override", async () => {
    const { canonicalDir, baseSha } = daemonHarness.createWorkRepo("wf6-mcp-plan")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const plan = makeSingleUnitManualPlan("run-wf6-daemon-plan-1", baseSha)
    const readableStatusRef = await Effect.runPromise(
      Ref.make<Option.Option<WorkflowProjectionStatus>>(
        Option.some(WorkflowProjectionStatus.make("stale")),
      ),
    )

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: daemonHarness.createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        workflowProjectorLayer: makeControlledProjectorLayer(readableStatusRef),
      },
    })

    try {
      const startRes = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan }),
      )
      expect(startRes.outcome).toBe("started")

      const staleDaemonStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      expect(extractProjectionStatusFromSummary(staleDaemonStatus)).toBe("stale")

      const staleToolRes = await Effect.runPromise(
        executeWorkflowPlanTool(
          { repoRoot: canonicalDir, runId: plan.runId },
          { repoRoot: canonicalDir },
        ),
      )
      expect(extractProjectionStatusFromSummary(staleToolRes.status)).toBe("stale")

      await Effect.runPromise(
        Ref.set(readableStatusRef, Option.some(WorkflowProjectionStatus.make("fresh"))),
      )

      const freshDaemonStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      expect(extractProjectionStatusFromSummary(freshDaemonStatus)).toBe("fresh")

      const freshToolRes = await Effect.runPromise(
        executeWorkflowPlanTool(
          { repoRoot: canonicalDir, runId: plan.runId },
          { repoRoot: canonicalDir },
        ),
      )
      expect(extractProjectionStatusFromSummary(freshToolRes.status)).toBe("fresh")
    } finally {
      await daemon.close()
    }
  }, 45_000)

  it("supports buildWorkflowPortsLayer default wiring and workflowProjectorLayer override on workflowPortsLayer", async () => {
    const workBase = mkdtempSync(join(tmpdir(), "wf6-ports-override-"))
    tempDirs.push(workBase)
    const { canonicalDir } = initTestGitRepo(workBase, "ports-repo")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const shipProgressListeners = new Map<string, (event: ShipStreamProgressEvent) => void>()

    const basePortsLayer = buildWorkflowPortsLayer(
      validatedCanonical.worktreeRoot,
      {
        mode: "required",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
      },
      { commonGitDir: validatedCanonical.commonGitDir },
      (_runId, eff) => eff,
      (eff) => eff,
      shipProgressListeners,
    )

    const overrideRef = await Effect.runPromise(
      Ref.make<Option.Option<WorkflowProjectionStatus>>(
        Option.some(WorkflowProjectionStatus.make("stale")),
      ),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const defaultCtx = yield* Layer.buildWithScope(basePortsLayer, scope)
          const defaultProjector = Context.get(defaultCtx, WorkflowProjector)
          const defaultStatus = yield* defaultProjector.getProjectionStatus(
            WorkflowRunId.make("run-missing"),
          )
          expect(defaultStatus).toEqual(Option.none())

          const overriddenLayer = buildWorkflowPortsLayer(
            validatedCanonical.worktreeRoot,
            {
              mode: "required",
              workflowPortsLayer: basePortsLayer,
              workflowProjectorLayer: makeControlledProjectorLayer(overrideRef),
            },
            { commonGitDir: validatedCanonical.commonGitDir },
            (_runId, eff) => eff,
            (eff) => eff,
            shipProgressListeners,
          )
          const overriddenCtx = yield* Layer.buildWithScope(overriddenLayer, scope)
          const overriddenProjector = Context.get(overriddenCtx, WorkflowProjector)
          const overriddenStatus = yield* overriddenProjector.getProjectionStatus(
            WorkflowRunId.make("run-missing"),
          )
          expect(overriddenStatus).toEqual(Option.some(WorkflowProjectionStatus.make("stale")))
        }),
      ),
    )
  })

  it("computeProjectionStatus handles every WorkflowRunRecord state and Completed/Failed outcomes preserve stale projectionStatus", async () => {
    const sampleReceipt: TaskRunReceipt = {
      runId: WorkflowRunId.make("run-compute-1"),
      planSha: PlanSha256.make("b".repeat(64)),
      review: {
        _tag: "SkipReviewPlan",
        depth: ReviewDepth.make("skip"),
        source: ReviewRoutingSource.make("deterministic"),
        reason: ReviewRoutingReason.make("small diff"),
        selections: [],
      },
      completedUnits: [WorkUnitId.make("unit-1")],
      llmPhase: {
        workspaceHash: WorkspaceTreeHash.make("a".repeat(64)),
        frictionLogCleared: FrictionLogState.make("cleared"),
      },
    }
    const baseRun: WorkflowRunRecord = {
      runId: WorkflowRunId.make("run-compute-1"),
      executionId: WorkflowExecutionId.make("exec-compute-1"),
      level: "slice",
      planSha: PlanSha256.make("b".repeat(64)),
      baseSha: GitCommitSha.make("a".repeat(40)),
      state: "running",
      updatedMs: WorkflowTimestampMs.make(1),
    }
    const completeOk = Option.some({ _tag: "Complete" as const, exit: Exit.succeed(sampleReceipt) })
    const completeFail = Option.some({
      _tag: "Complete" as const,
      exit: Exit.fail("boom"),
    })
    const suspended = Option.some({ _tag: "Suspended" as const })

    expect(computeProjectionStatus(undefined, Option.none())).toBe("not-projected")
    expect(computeProjectionStatus(baseRun, Option.none())).toBe("fresh")
    expect(computeProjectionStatus(baseRun, suspended)).toBe("fresh")
    expect(computeProjectionStatus({ ...baseRun, state: "completed" }, suspended)).toBe("stale")
    expect(computeProjectionStatus({ ...baseRun, state: "completed" }, completeOk)).toBe("fresh")
    expect(computeProjectionStatus(baseRun, completeOk)).toBe("stale")
    expect(computeProjectionStatus({ ...baseRun, state: "aborted" }, completeFail)).toBe("fresh")
    expect(computeProjectionStatus({ ...baseRun, state: "completed" }, completeFail)).toBe("stale")
  })

  it("keeps CANONICAL_MCP_TOOL_NAMES unchanged (no new projection tool) and validates workflow_pending_units & ears_without_completed_unit via harness_gq_query", () => {
    expect(CANONICAL_MCP_TOOL_NAMES).toHaveLength(20)
    expect(CANONICAL_MCP_TOOL_NAMES).toContain(McpToolName.make("harness_gq_query"))
    expect(CANONICAL_MCP_TOOL_NAMES).toContain(McpToolName.make("harness_workflow_plan"))
    expect(HARNESS_GQ_QUERY_NAMES).toHaveLength(22)
    expect(HARNESS_GQ_QUERY_NAMES).toContain("workflow_pending_units")
    expect(HARNESS_GQ_QUERY_NAMES).toContain("ears_without_completed_unit")

    const decodeGqInput = Schema.decodeUnknownSync(GqQueryInputSchema)
    const pendingInput = decodeGqInput({
      queryName: "workflow_pending_units",
      params: { runId: "run-wf6-1" },
      branch: "impl/wf6",
    })
    expect(pendingInput.queryName).toBe("workflow_pending_units")

    const earsInput = decodeGqInput({
      queryName: "ears_without_completed_unit",
      params: { runId: "run-wf6-1" },
      branch: "impl/wf6",
    })
    expect(earsInput.queryName).toBe("ears_without_completed_unit")
  })
})
