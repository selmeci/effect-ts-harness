import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Schema, Scope, Semaphore, SynchronizedRef } from "effect"
import { DurableDeferred, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  type CompiledPlan,
  DaemonSocketPath,
  EscalationOrdinal,
  GateDurationMs,
  LeaseEpoch,
  OwnedRelPath,
  ShipAttempt,
  ShipAttemptKey,
  ShipStagePassed,
  type ShipStreamProgressEvent,
  WaveIndex,
  WorkUnitId,
  WorkflowDoctorMode,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkflowRunOutcome,
  type WorkflowShipAttemptRecord,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  WorkspaceTreeHash,
  makeWorkflowUnitKey,
  toBoundedReason,
  toErrorReasonMessage,
} from "@harness/contract"
import { HarnessTaskWorkflow, makeUnitEscalationDeferred } from "@harness/gates"
import { OmnigraphClient } from "@harness/graph"
import {
  UnitAgentDispatcherLive,
  UnixSocketDaemonLive,
  WORKFLOW_COMPLETE_IPC_TIMEOUT_MS,
  WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
  WRITER_LEASE_HEARTBEAT_TTL_MS,
  completeWorkflowViaDaemon,
  createShipActiveGateController,
  doctorWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  nodeSyncHostIo,
  queryUnixSocketLineDetailed,
  queryWorkflowDaemonCommand,
  resolveWorkflowRuntimePaths,
  startWorkflowViaDaemon,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import {
  ShipAttemptStore,
  ShipGateRunner,
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowProjectionWriter,
  WorkflowReadModelQuery,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import { HarnessTaskWorkflowLayer, ShipWorkflowLayer } from "@harness/gates"
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
import {
  initTestGitRepo,
  makeCompletedVerifierLayer,
  makeMockLeaseStoreClient,
  makeNoopWorktreeLayer,
  reviewStubLayer,
  makeSingleUnitManualPlan,
  startWorkflowDaemonServerHarness,
} from "./helpers/workflow-daemon-fixture.js"

describe("WF-3 Unix-socket daemon doctor, lease fencing, offline & pause lifecycle", () => {
  const harness = startWorkflowDaemonServerHarness("wf3-daemon-life-")
  const tempDirs = harness.tempDirs
  const createClient = () => harness.createClient()
  const createWorkRepo = (name: string) => harness.createWorkRepo(name)
  beforeAll(() => harness.start(), 30_000)
  afterAll(() => harness.stop())

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
        reviewRouterLayer: reviewStubLayer,
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
        reviewRouterLayer: reviewStubLayer,
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
        reviewRouterLayer: reviewStubLayer,
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
      executeWorkflowPlanTool({ repoRoot: canonicalDir }, { repoRoot: canonicalDir }),
    )
    expect(offlinePlanOut.resolvedRepoRoot).toBe(validatedCanonical.worktreeRoot)
    expect(offlinePlanOut.commonGitDir).toBe(validatedCanonical.commonGitDir)
    expect(offlinePlanOut.status._tag).toBe("DaemonOffline")
    expect("writerLeaseEpoch" in offlinePlanOut.status).toBe(false)

    const invalidErr = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: outsideDir }, { repoRoot: outsideDir }).pipe(Effect.flip),
    )
    expect(toErrorReasonMessage(invalidErr)).toContain("git")

    const unconfiguredEscapeErr = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: otherGitRepo }).pipe(Effect.flip),
    )
    expect(unconfiguredEscapeErr._tag).toBe("ProjectPathEscapeError")

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
        reviewRouterLayer: reviewStubLayer,
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
          const shipAttemptStoreLayer = Layer.succeed(ShipAttemptStore, {
            allocateAttempt: ({ runId }) =>
              Effect.succeed(makeShipAttemptRecord(runId, ShipAttempt.make(1), "running")),
            updateStatus: ({ runId, attempt, status }) =>
              Effect.succeed(makeShipAttemptRecord(runId, attempt, status)),
            listAttemptsForRun: () => Effect.succeed([]),
          })
          const portsLayer = Layer.mergeAll(
            makeCompletedVerifierLayer(),
            makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
            UnitAgentDispatcherLive,
            reviewStubLayer,
            projectionWriterLayer,
            readModelLayer,
            shipGateRunnerLayer,
            shipAttemptStoreLayer,
          )
          const fullLayer = Layer.merge(HarnessTaskWorkflowLayer, ShipWorkflowLayer).pipe(
            Layer.provideMerge(Layer.merge(WorkflowEngine.layerMemory, portsLayer)),
          )
          const workflowContext = yield* Layer.buildWithScope(fullLayer, scope)
          const plansRef = yield* SynchronizedRef.make<ReadonlyMap<WorkflowRunId, CompiledPlan>>(
            new Map(),
          )
          const runMutexesRef = yield* SynchronizedRef.make<
            ReadonlyMap<WorkflowRunId, Semaphore.Semaphore>
          >(new Map())
          const shipWorktreeMutexesRef = yield* SynchronizedRef.make<
            ReadonlyMap<AbsoluteRepoRoot, Semaphore.Semaphore>
          >(new Map())
          const shipProgressListeners = new Map<string, (event: ShipStreamProgressEvent) => void>()
          const shipGateController = createShipActiveGateController()
          const runtime: WorkflowDaemonRuntime = {
            workflowContext,
            shipWorkflowContext: workflowContext,
            engine: Context.get(workflowContext, WorkflowEngine.WorkflowEngine),
            projectionWriter: Context.get(workflowContext, WorkflowProjectionWriter),
            readModelQuery: Context.get(workflowContext, WorkflowReadModelQuery),
            unitVerifier: Context.get(workflowContext, UnitVerifier),
            unitAgentDispatcher: Context.get(workflowContext, UnitAgentDispatcher),
            worktreePort: Context.get(workflowContext, WorkflowWorktreePort),
            reviewRouter: Context.get(workflowContext, WorkflowReviewRouter),
            shipGateRunner: Context.get(workflowContext, ShipGateRunner),
            shipAttemptStore: Context.get(workflowContext, ShipAttemptStore),
            shipProgressListeners,
            shipGateController,
            leaseFence: { commonGitDir: validatedCanonical.commonGitDir },
            plansRef,
            runMutexesRef,
            shipWorktreeMutexesRef,
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
