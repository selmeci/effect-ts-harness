import { mkdirSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Workflow, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  GateDurationMs,
  GateExitCode,
  GateStderrSummary,
  MutationRestoreError,
  SHIP_STAGES,
  ShipAttempt,
  ShipAttemptKey,
  ShipFailureMessage,
  ShipGateFailedError,
  ShipStagePassed,
  type ShipStreamProgressEvent,
  WorkflowRunId,
  type WorkflowShipAttemptRecord,
  WorkflowTimeoutMs,
  WorkflowTimestampMs,
  WorkspaceTreeHash,
  type ValidatedWorktreeRoot,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WorkflowDaemonCapability,
  isPureInterruptCause,
} from "@harness/contract"
import { ShipWorkflow, computeWorkspaceTreeHashChecked, shipExecutionIdOf } from "@harness/gates"
import {
  type ShipGateRunnerOptions,
  UnixSocketDaemonLive,
  completeWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  handshakeWorkflowDaemon,
  nodeSyncHostIo,
  resolveWorkflowRuntimePaths,
  shipWorkflowViaDaemon,
  startWorkflowViaDaemon,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import {
  ShipAttemptStore,
  ShipGateRunner,
  UnixSocketDaemonPort,
  WorkflowProjectionWriter,
  WorkflowReadModelQuery,
} from "@harness/service"
import { startHarnessDaemonServer } from "../src/daemon/unix-socket-daemon.js"
import {
  acquireWorkflowEngineInScope,
  type WorkflowDaemonRuntime,
} from "../src/daemon/workflow-engine-daemon-helper.js"
import {
  buildWorkflowPortsLayer,
  resolveDaemonKnownEntityTypes,
} from "../src/daemon/workflow-ports-daemon-helper.js"
import {
  handleDaemonWorkflowShipRequest,
  resolveShipRunTarget,
} from "../src/daemon/workflow-rpc-ship-helper.js"
import {
  makeCompletedVerifierLayer,
  makeNoopWorktreeLayer,
  makeSingleUnitManualPlan,
  reviewStubLayer,
  startWorkflowDaemonServerHarness,
} from "./helpers/workflow-daemon-fixture.js"

const makePassingShipRunCommand =
  (executedArgs: Array<ReadonlyArray<string>> = []) =>
  (_cmd: string, args: ReadonlyArray<string>) =>
    Effect.sync(() => {
      executedArgs.push(args)
      return {
        _tag: "Exited" as const,
        exitCode: 0,
        stdout: args.includes("done") ? JSON.stringify({ decision: "stop" }) : "",
        stderr: "",
        durationMs: 2,
      }
    })

type ShipFailureInjectionMode = "gate-tripped" | "tree-mismatch" | "mutation-restore" | "tree-drift"

const makeFailingShipGateRunnerLayer = (
  fallbackRoot: AbsoluteRepoRoot,
  getMode: () => ShipFailureInjectionMode,
): Layer.Layer<ShipGateRunner> => {
  let doneComputeCalls = 0
  const computeRealHash = (
    repoRoot: AbsoluteRepoRoot,
  ): Effect.Effect<WorkspaceTreeHash, ShipGateFailedError> =>
    match(computeWorkspaceTreeHashChecked(repoRoot, nodeSyncHostIo))
      .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(
          new ShipGateFailedError({
            stage: "format-check",
            exitCode: GateExitCode.make(1),
            stderrSummary: GateStderrSummary.make(failure.slice(0, 200)),
            circuitBreakerStatus: "clear",
          }),
        ),
      )
      .exhaustive()

  return Layer.succeed(ShipGateRunner, {
    computeTreeHash: (input) =>
      Effect.gen(function* () {
        const mode = getMode()
        if (mode === "tree-mismatch" && input.stage === "gc-strict") {
          return WorkspaceTreeHash.make("0".repeat(64))
        }
        if (mode === "tree-drift" && input.stage === "done") {
          doneComputeCalls += 1
          if (doneComputeCalls % 2 === 0) {
            return WorkspaceTreeHash.make("1".repeat(64))
          }
        }
        return yield* computeRealHash(input.repoRoot ?? fallbackRoot)
      }),
    recoverMutationBackup: (input) =>
      getMode() === "mutation-restore"
        ? Effect.fail(
            new MutationRestoreError({
              expected: input.expectedTreeHash,
              actual: WorkspaceTreeHash.make("2".repeat(64)),
              detail: ShipFailureMessage.make("Injected mutation backup restore failure"),
            }),
          )
        : Effect.void,
    executeStageCommand: (input) =>
      getMode() === "gate-tripped" && input.stage === "verify"
        ? Effect.fail(
            new ShipGateFailedError({
              stage: "verify",
              exitCode: GateExitCode.make(2),
              stderrSummary: GateStderrSummary.make("Injected verify gate failure x3"),
              circuitBreakerStatus: "tripped",
              escalationMessage: ShipFailureMessage.make("Loop circuit breaker tripped"),
            }),
          )
        : Effect.succeed(
            ShipStagePassed.make({
              stage: input.stage,
              durationMs: GateDurationMs.make(3),
            }),
          ),
    reportStageProgress: () => Effect.void,
  })
}

const completeSingleUnitManualRun = async (
  worktreeRoot: AbsoluteRepoRoot,
  runId: string,
  baseSha: ReturnType<typeof makeSingleUnitManualPlan>["baseSha"],
) => {
  const plan = makeSingleUnitManualPlan(runId, baseSha)
  await Effect.runPromise(startWorkflowViaDaemon({ repoRoot: worktreeRoot, plan }))
  await Effect.runPromise(
    completeWorkflowViaDaemon({
      _tag: "CompleteUnit",
      repoRoot: worktreeRoot,
      unitId: plan.units[0]!.unitId,
      runId: plan.runId,
    }),
  )
  await Effect.runPromise(
    completeWorkflowViaDaemon({
      _tag: "CompleteLlmPhase",
      repoRoot: worktreeRoot,
      runId: plan.runId,
    }),
  )
  return plan
}

describe("WF-4 Unix-socket daemon workflow.ship RPC", () => {
  const harness = startWorkflowDaemonServerHarness("wf4-ship-daemon-")
  const createClient = () => harness.createClient()
  const createWorkRepo = (name: string) => harness.createWorkRepo(name)
  beforeAll(() => harness.start(), 30_000)
  afterAll(() => harness.stop())

  it("rejects direct handleDaemonWorkflowShipRequest calls when runtime is inactive", async () => {
    const { canonicalDir } = createWorkRepo("inactive-ship")
    const validated = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const inactiveEnvelope = await Effect.runPromise(
      handleDaemonWorkflowShipRequest({
        requestId: "req-inactive-ship-1",
        rawPayload: { repoRoot: validated.worktreeRoot },
        scope: {
          _tag: "Allowed",
          resolvedRoot: validated.worktreeRoot,
          validatedWorktree: validated,
          daemonWorktree: validated,
        },
      }),
    )
    expect(inactiveEnvelope).toMatchObject({
      id: "req-inactive-ship-1",
      ok: false,
      command: "workflow.ship",
    })
    if (inactiveEnvelope.ok) {
      expect.unreachable("Expected inactive runtime envelope to fail")
    }
    expect(inactiveEnvelope.error).toContain("Workflow engine runtime is inactive")
  })

  it("advertises workflow.ship in workflow.handshake and injects Workflow/ShipWorkflow only alongside HarnessTaskWorkflow", async () => {
    expect(resolveDaemonKnownEntityTypes(undefined)).toBeUndefined()
    expect(resolveDaemonKnownEntityTypes(["Workflow/Known"])).toEqual(["Workflow/Known"])
    expect(resolveDaemonKnownEntityTypes(["Workflow/HarnessTaskWorkflow"])).toEqual([
      "Workflow/HarnessTaskWorkflow",
      "Workflow/ShipWorkflow",
    ])
    expect(
      resolveDaemonKnownEntityTypes(["Workflow/HarnessTaskWorkflow", "Workflow/ShipWorkflow"]),
    ).toEqual(["Workflow/HarnessTaskWorkflow", "Workflow/ShipWorkflow"])

    const { canonicalDir } = createWorkRepo("handshake")
    const validated = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validated.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
      },
    })
    try {
      const socketPath = resolveWorkflowRuntimePaths(validated.commonGitDir).socketPath
      const handshake = await Effect.runPromise(
        handshakeWorkflowDaemon({
          socketPath,
          request: {
            protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
            repoRoot: validated.worktreeRoot,
            commonGitDir: validated.commonGitDir,
          },
          requiredCapabilities: [WorkflowDaemonCapability.make("workflow.ship")],
        }),
      )
      expect(handshake.capabilities).toContain("workflow.ship")
    } finally {
      await daemon.close()
    }
  }, 45_000)

  it("executes ephemeral workflow.ship from canonical and linked worktrees with all 6 streamed StageStarted + StageFinished events", async () => {
    const { canonicalDir, linkedDir } = createWorkRepo("ephemeral-ship")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const validatedLinked = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(linkedDir)),
    )
    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunCommand: makePassingShipRunCommand(),
      },
    })

    try {
      const canonicalEvents: Array<ShipStreamProgressEvent> = []
      const canonicalRes = await Effect.runPromise(
        shipWorkflowViaDaemon(
          { repoRoot: validatedCanonical.worktreeRoot },
          { onProgress: (event) => canonicalEvents.push(event) },
        ),
      )
      expect(canonicalRes.runOrigin).toBe("ephemeral")
      expect(canonicalRes.attempt).toBe(1)
      expect(canonicalRes.outcome._tag).toBe("Passed")
      expect(canonicalEvents).toHaveLength(12)
      expect(canonicalEvents.filter((e) => e._tag === "StageStarted").map((e) => e.stage)).toEqual([
        ...SHIP_STAGES,
      ])
      expect(
        canonicalEvents.filter((e) => e._tag === "StageFinished").map((e) => e.progress.stage),
      ).toEqual([...SHIP_STAGES])

      const linkedEvents: Array<ShipStreamProgressEvent> = []
      const linkedRes = await Effect.runPromise(
        shipWorkflowViaDaemon(
          { repoRoot: validatedLinked.worktreeRoot },
          { onProgress: (event) => linkedEvents.push(event) },
        ),
      )
      expect(linkedRes.runOrigin).toBe("ephemeral")
      expect(linkedRes.outcome._tag).toBe("Passed")
      expect(linkedEvents).toHaveLength(12)
      expect(
        linkedEvents
          .filter((e) => e._tag === "StageFinished")
          .every((e) => e.progress._tag === "Passed"),
      ).toBe(true)
    } finally {
      await daemon.close()
    }
  }, 45_000)

  it("ships a completed compiled HarnessTaskWorkflow run with planSha and surfaces shipAttempts in workflow.status", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("compiled-ship")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunCommand: makePassingShipRunCommand(),
      },
    })

    try {
      const plan = await completeSingleUnitManualRun(
        validatedCanonical.worktreeRoot,
        "run-ship-compiled-01",
        baseSha,
      )
      const shipRes = await Effect.runPromise(
        shipWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      expect(shipRes.runOrigin).toBe("compiled")
      expect(shipRes.attempt).toBe(1)
      match(shipRes.outcome)
        .with({ _tag: "Passed" }, ({ receipt, stages }) => {
          expect(receipt.planSha).toBe(plan.planSha)
          expect(stages.map((s) => s.stage)).toEqual([...SHIP_STAGES])
        })
        .with({ _tag: "Failed" }, () => {
          expect.unreachable("Expected Passed ship outcome")
        })
        .exhaustive()

      const status = await Effect.runPromise(
        getWorkflowStatusViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      expect(status).toMatchObject({
        _tag: "Ready",
        outcome: {
          _tag: "Completed",
          shipAttempts: [
            {
              runId: plan.runId,
              attempt: 1,
              treeHash: shipRes.treeHash,
              status: "passed",
            },
          ],
        },
      })
    } finally {
      await daemon.close()
    }
  }, 45_000)

  it("allocates distinct monotonic attempts 1 and 2 under OCC for concurrent workflow.ship calls", async () => {
    const { canonicalDir } = createWorkRepo("concurrent-ship")
    writeFileSync(join(canonicalDir, "concurrent-marker.txt"), "concurrent-ship\n", "utf8")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunCommand: makePassingShipRunCommand(),
      },
    })

    try {
      const [first, second] = await Promise.all([
        Effect.runPromise(shipWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot })),
        Effect.runPromise(shipWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot })),
      ])
      expect(first.runId).toBe(second.runId)
      expect([first.attempt, second.attempt].sort((a, b) => a - b)).toEqual([1, 2])
      expect(first.executionId).not.toBe(second.executionId)
    } finally {
      await daemon.close()
    }
  }, 45_000)

  it("fails closed with WorkflowStoreUnavailableError on missing or incomplete runId without running gates", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("missing-incomplete")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const executedArgs: Array<ReadonlyArray<string>> = []
    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunCommand: makePassingShipRunCommand(executedArgs),
      },
    })

    try {
      const missingErr = await Effect.runPromise(
        shipWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: WorkflowRunId.make("run-does-not-exist-01"),
        }).pipe(Effect.flip),
      )
      expect(missingErr._tag).toBe("WorkflowStoreUnavailableError")
      expect(missingErr.message).toContain("not found")

      const activePlan = makeSingleUnitManualPlan("run-incomplete-ship-01", baseSha)
      await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan: activePlan }),
      )
      const incompleteErr = await Effect.runPromise(
        shipWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: activePlan.runId,
        }).pipe(Effect.flip),
      )
      expect(incompleteErr._tag).toBe("WorkflowStoreUnavailableError")
      expect(incompleteErr.message).toContain("expected 'completed'")
      expect(executedArgs).toHaveLength(0)
    } finally {
      await daemon.close()
    }
  }, 45_000)

  it("surfaces all 4 typed ShipWorkflowError variants and records WfShipAttempt status as failed", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("ship-errors")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    let mode: ShipFailureInjectionMode = "gate-tripped"
    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunnerLayer: makeFailingShipGateRunnerLayer(
          validatedCanonical.worktreeRoot,
          () => mode,
        ),
      },
    })

    try {
      const plan = await completeSingleUnitManualRun(
        validatedCanonical.worktreeRoot,
        "run-ship-failures-01",
        baseSha,
      )
      const cases: ReadonlyArray<{
        readonly mode: ShipFailureInjectionMode
        readonly expectedTag:
          | "ShipGateFailedError"
          | "ShipTreeMismatchError"
          | "MutationRestoreError"
          | "ShipTreeDriftError"
      }> = [
        { mode: "gate-tripped", expectedTag: "ShipGateFailedError" },
        { mode: "tree-mismatch", expectedTag: "ShipTreeMismatchError" },
        { mode: "mutation-restore", expectedTag: "MutationRestoreError" },
        { mode: "tree-drift", expectedTag: "ShipTreeDriftError" },
      ]

      for (const [idx, testCase] of cases.entries()) {
        mode = testCase.mode
        const res = await Effect.runPromise(
          shipWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId: plan.runId }),
        )
        expect(res.attempt).toBe(idx + 1)
        match(res.outcome)
          .with({ _tag: "Failed" }, ({ error }) => {
            expect(error._tag).toBe(testCase.expectedTag)
            if (error instanceof ShipGateFailedError) {
              expect(error.circuitBreakerStatus).toBe("tripped")
            }
          })
          .with({ _tag: "Passed" }, () => {
            expect.unreachable(`Expected Failed outcome for ${testCase.mode}`)
          })
          .exhaustive()
      }

      const status = await Effect.runPromise(
        getWorkflowStatusViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      match(status)
        .with({ _tag: "Ready" }, ({ outcome }) => {
          match(outcome)
            .with({ _tag: "Completed" }, ({ shipAttempts }) => {
              expect(shipAttempts?.map((a) => [a.attempt, a.status])).toEqual([
                [1, "failed"],
                [2, "failed"],
                [3, "failed"],
                [4, "failed"],
              ])
            })
            .with({ _tag: "NotFound" }, { _tag: "Active" }, { _tag: "Failed" }, () => {
              expect.unreachable("Expected Completed run outcome")
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
  }, 45_000)

  it("serializes concurrent workflow.ship RPCs with distinct runIds on the same worktreeRoot and allocates attempt 1 each", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("worktree-lock-serialize")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    let activeCommands = 0
    let maxConcurrentCommands = 0
    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunCommand: (_cmd, args) =>
          Effect.gen(function* () {
            activeCommands += 1
            maxConcurrentCommands = Math.max(maxConcurrentCommands, activeCommands)
            if (args.includes("format-check")) {
              yield* Effect.sleep("40 millis")
            }
            activeCommands -= 1
            return {
              _tag: "Exited" as const,
              exitCode: 0,
              stdout: args.includes("done") ? JSON.stringify({ decision: "stop" }) : "",
              stderr: "",
              durationMs: 5,
            }
          }),
      },
    })

    try {
      const plan1 = await completeSingleUnitManualRun(
        validatedCanonical.worktreeRoot,
        "run-wt-serialize-01",
        baseSha,
      )
      const plan2 = await completeSingleUnitManualRun(
        validatedCanonical.worktreeRoot,
        "run-wt-serialize-02",
        baseSha,
      )

      const run1Intervals: Array<number> = []
      const run2Intervals: Array<number> = []
      const [res1, res2] = await Promise.all([
        Effect.runPromise(
          shipWorkflowViaDaemon(
            { repoRoot: validatedCanonical.worktreeRoot, runId: plan1.runId },
            { onProgress: () => run1Intervals.push(Date.now()) },
          ),
        ),
        Effect.runPromise(
          shipWorkflowViaDaemon(
            { repoRoot: validatedCanonical.worktreeRoot, runId: plan2.runId },
            { onProgress: () => run2Intervals.push(Date.now()) },
          ),
        ),
      ])

      expect(maxConcurrentCommands).toBe(1)
      expect(res1.attempt).toBe(1)
      expect(res2.attempt).toBe(1)
      expect(res1.outcome._tag).toBe("Passed")
      expect(res2.outcome._tag).toBe("Passed")

      const run1Start = Math.min(...run1Intervals)
      const run1End = Math.max(...run1Intervals)
      const run2Start = Math.min(...run2Intervals)
      const run2End = Math.max(...run2Intervals)
      expect(run1End <= run2Start || run2End <= run1Start).toBe(true)
    } finally {
      await daemon.close()
    }
  }, 45_000)

  it("fails closed on corrupt startup mutation-backup.json inside withWorktreeShipLock before running gates", async () => {
    const { canonicalDir } = createWorkRepo("startup-backup-fail-closed")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const executedArgs: Array<ReadonlyArray<string>> = []
    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunCommand: makePassingShipRunCommand(executedArgs),
      },
    })

    try {
      mkdirSync(join(canonicalDir, ".harness"), { recursive: true })
      writeFileSync(join(canonicalDir, ".harness", "mutation-backup.json"), "{invalid-json", "utf8")
      const backupErr = await Effect.runPromise(
        shipWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot }).pipe(Effect.flip),
      )
      expect(backupErr._tag).toBe("WorkflowStoreUnavailableError")
      expect(backupErr.message).toContain("Backup JSON failed schema decoding")
      expect(executedArgs).toHaveLength(0)
    } finally {
      await daemon.close()
    }
  }, 45_000)

  it("streams real makeShipGateRunnerLayer StageStarted + StageFinished(Failed) frames and accumulates partial stages", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("real-runner-fail-stream")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunCommand: (_cmd, args) =>
          Effect.succeed(
            args.includes("verify")
              ? {
                  _tag: "Exited" as const,
                  exitCode: 2,
                  stdout: "",
                  stderr: "real-runner verify failure",
                  durationMs: 4,
                }
              : {
                  _tag: "Exited" as const,
                  exitCode: 0,
                  stdout: args.includes("done") ? JSON.stringify({ decision: "stop" }) : "",
                  stderr: "",
                  durationMs: 2,
                },
          ),
      },
    })

    try {
      const plan = await completeSingleUnitManualRun(
        validatedCanonical.worktreeRoot,
        "run-real-runner-fail-01",
        baseSha,
      )
      const events: Array<ShipStreamProgressEvent> = []
      const res = await Effect.runPromise(
        shipWorkflowViaDaemon(
          { repoRoot: validatedCanonical.worktreeRoot, runId: plan.runId },
          { onProgress: (event) => events.push(event) },
        ),
      )

      const startedStages = events.filter((e) => e._tag === "StageStarted").map((e) => e.stage)
      const finishedEvents = events.filter((e) => e._tag === "StageFinished")
      expect(startedStages).toEqual([
        "format-check",
        "gc-strict",
        "ontology-check-strict",
        "mutate-strict",
        "verify",
      ])
      expect(finishedEvents.map((e) => [e.progress.stage, e.progress._tag])).toEqual([
        ["format-check", "Passed"],
        ["gc-strict", "Passed"],
        ["ontology-check-strict", "Passed"],
        ["mutate-strict", "Passed"],
        ["verify", "Failed"],
      ])

      match(res.outcome)
        .with({ _tag: "Failed" }, ({ error, stages }) => {
          expect(error._tag).toBe("ShipGateFailedError")
          if (error instanceof ShipGateFailedError) {
            expect(error.stage).toBe("verify")
            expect(error.exitCode).toBe(2)
          }
          expect(stages.map((s) => [s.stage, s._tag])).toEqual([
            ["format-check", "Passed"],
            ["gc-strict", "Passed"],
            ["ontology-check-strict", "Passed"],
            ["mutate-strict", "Passed"],
            ["verify", "Failed"],
          ])
        })
        .with({ _tag: "Passed" }, () => {
          expect.unreachable("Expected Failed ship outcome")
        })
        .exhaustive()
    } finally {
      await daemon.close()
    }
  }, 45_000)

  const withActiveShipRuntime = async <E>(
    repoName: string,
    fn: (ctx: {
      readonly scope: Scope.Scope
      readonly worktreeRoot: AbsoluteRepoRoot
      readonly runtime: WorkflowDaemonRuntime
      readonly allowedScope: {
        readonly _tag: "Allowed"
        readonly resolvedRoot: AbsoluteRepoRoot
        readonly validatedWorktree: ValidatedWorktreeRoot
        readonly daemonWorktree: ValidatedWorktreeRoot
      }
      readonly ephemeralRunId: WorkflowRunId
    }) => Effect.Effect<void, E>,
    shipGateRunCommand: ShipGateRunnerOptions["runCommand"] = makePassingShipRunCommand(),
  ) => {
    const { canonicalDir } = createWorkRepo(repoName)
    writeFileSync(join(canonicalDir, `${repoName}-marker.txt`), `${repoName}\n`, "utf8")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const treeHash = match(
      computeWorkspaceTreeHashChecked(validatedCanonical.worktreeRoot, nodeSyncHostIo),
    )
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect.unreachable(`Expected tree hash computation to succeed: ${failure}`),
      )
      .exhaustive()
    const ephemeralRunId = WorkflowRunId.make(`ship-${treeHash.slice(0, 12)}`)
    const allowedScope = {
      _tag: "Allowed" as const,
      resolvedRoot: validatedCanonical.worktreeRoot,
      validatedWorktree: validatedCanonical,
      daemonWorktree: validatedCanonical,
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const unixSocketDaemon = yield* UnixSocketDaemonPort
          const state = yield* acquireWorkflowEngineInScope({
            daemonScope: scope,
            startupState: { _tag: "Valid", worktree: validatedCanonical },
            unixSocketDaemon,
            workflowEngineOptions: {
              mode: "required",
              client: createClient(),
              entityReplyPollInterval: "50 millis",
              unitVerifierLayer: makeCompletedVerifierLayer(),
              worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
              reviewRouterLayer: reviewStubLayer,
              shipGateRunCommand,
            },
          })
          const runtime = match(state)
            .with({ _tag: "Active" }, (active) => active.runtime)
            .with({ _tag: "Inactive" }, { _tag: "AttachedAlreadyAlive" }, (other) =>
              expect.unreachable(`Expected Active engine state, got ${other._tag}`),
            )
            .exhaustive()
          yield* fn({
            scope,
            worktreeRoot: validatedCanonical.worktreeRoot,
            runtime,
            allowedScope,
            ephemeralRunId,
          })
        }),
      ).pipe(Effect.provide(UnixSocketDaemonLive)),
    )
  }

  it("normalizes padded workflow.ship progress requestId", async () => {
    await withActiveShipRuntime("ship-guards-and-id", ({ worktreeRoot, runtime, allowedScope }) =>
      Effect.gen(function* () {
        const paddedLines: Array<string> = []
        const paddedEnvelope = yield* handleDaemonWorkflowShipRequest({
          requestId: "  req-padded-pass  ",
          rawPayload: { repoRoot: worktreeRoot },
          scope: allowedScope,
          runtime,
          emitLine: (line) => paddedLines.push(line),
        })
        expect(paddedEnvelope).toMatchObject({
          id: "req-padded-pass",
          ok: true,
          command: "workflow.ship",
        })
        expect(paddedLines).toHaveLength(12)
        for (const line of paddedLines) {
          const parsed = JSON.parse(line) as { readonly id: string; readonly kind: string }
          expect(parsed.id).toBe("req-padded-pass")
          expect(parsed.kind).toBe("progress")
        }
      }),
    )
  }, 45_000)

  it("triggers ShipWorkflow.interrupt on timeout and settles attempts on external Fiber.interrupt", async () => {
    let currentGate:
      | {
          readonly started?: Deferred.Deferred<void> | undefined
          readonly release: Deferred.Deferred<void>
        }
      | undefined
    const gatedRunCommand: ShipGateRunnerOptions["runCommand"] = (_cmd, args) =>
      Effect.gen(function* () {
        if (args.includes("gc") && currentGate !== undefined) {
          if (currentGate.started !== undefined) {
            yield* Deferred.succeed(currentGate.started, undefined)
          }
          yield* Deferred.await(currentGate.release)
        }
        return {
          _tag: "Exited" as const,
          exitCode: 0,
          stdout: args.includes("done") ? JSON.stringify({ decision: "stop" }) : "",
          stderr: "",
          durationMs: 1,
        }
      })

    await withActiveShipRuntime(
      "ship-timeout-and-interrupt",
      ({ worktreeRoot, runtime, allowedScope, ephemeralRunId }) =>
        Effect.gen(function* () {
          const shipContext = runtime.shipWorkflowContext
          const origEngine = Context.get(shipContext, WorkflowEngine.WorkflowEngine)
          const interruptedExecutions: Array<string> = []
          const releaseTimeoutGate = yield* Deferred.make<void>()
          currentGate = { release: releaseTimeoutGate }
          yield* Effect.sleep("300 millis").pipe(
            Effect.andThen(Deferred.succeed(releaseTimeoutGate, undefined)),
            Effect.forkChild,
          )

          const spiedTimeoutContext = Context.add(shipContext, WorkflowEngine.WorkflowEngine, {
            ...origEngine,
            interrupt: (workflow, executionId) => {
              interruptedExecutions.push(executionId)
              return origEngine.interrupt(workflow, executionId)
            },
          })

          const timeoutEnvelope = yield* handleDaemonWorkflowShipRequest({
            requestId: "   ",
            rawPayload: { repoRoot: worktreeRoot },
            scope: allowedScope,
            runtime: { ...runtime, shipWorkflowContext: spiedTimeoutContext },
            settleTimeoutMs: WorkflowTimeoutMs.make(100),
          })

          expect(timeoutEnvelope).toMatchObject({
            id: "unknown-request",
            ok: false,
            command: "workflow.ship",
          })
          if (timeoutEnvelope.ok) {
            expect.unreachable("Expected timeout envelope to fail")
          }
          expect(timeoutEnvelope.error).toContain("timed out after 100ms")
          expect(interruptedExecutions).toHaveLength(1)
          expect(runtime.shipProgressListeners.size).toBe(0)

          const gateStarted2 = yield* Deferred.make<void>()
          const releaseGate2 = yield* Deferred.make<void>()
          currentGate = { started: gateStarted2, release: releaseGate2 }

          const interruptFiber = yield* handleDaemonWorkflowShipRequest({
            requestId: "req-external-interrupt",
            rawPayload: { repoRoot: worktreeRoot },
            scope: allowedScope,
            runtime,
          }).pipe(Effect.forkChild)

          yield* Deferred.await(gateStarted2)
          expect(runtime.shipProgressListeners.size).toBe(1)
          yield* Fiber.interrupt(interruptFiber)
          const interruptExit = yield* Fiber.await(interruptFiber)
          match(interruptExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(isPureInterruptCause(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected external Fiber.interrupt failure exit")
            })
            .exhaustive()
          yield* Deferred.succeed(releaseGate2, undefined)
          expect(runtime.shipProgressListeners.size).toBe(0)

          const attempts = yield* runtime.shipAttemptStore.listAttemptsForRun(ephemeralRunId)
          expect(attempts.map((a) => [a.attempt, a.status])).toEqual([
            [1, "failed"],
            [2, "failed"],
          ])
        }),
      gatedRunCommand,
    )
  }, 45_000)

  it("holds withWorktreeShipLock across timeout until an uninterruptible gate exits and ShipWorkflow.poll completes before running a concurrent ship", async () => {
    const slowGateStarted = await Effect.runPromise(Deferred.make<void>())
    const releaseSlowGate = await Effect.runPromise(Deferred.make<void>())
    const interruptInvoked = await Effect.runPromise(Deferred.make<void>())
    let slowGateCompleted = false
    let secondCallStartedWhileSlowGateActive = false
    let callPhase: "slow-first" | "fast-second" = "slow-first"

    const slowUninterruptibleCommand: ShipGateRunnerOptions["runCommand"] = (_cmd, args) =>
      Effect.gen(function* () {
        if (callPhase === "slow-first" && args.includes("gc")) {
          yield* Deferred.succeed(slowGateStarted, undefined)
          yield* Effect.uninterruptible(
            Deferred.await(releaseSlowGate).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  slowGateCompleted = true
                }),
              ),
            ),
          )
        } else if (callPhase === "fast-second" && !slowGateCompleted) {
          secondCallStartedWhileSlowGateActive = true
        }
        return {
          _tag: "Exited" as const,
          exitCode: 0,
          stdout: args.includes("done") ? JSON.stringify({ decision: "stop" }) : "",
          stderr: "",
          durationMs: 2,
        }
      })

    await withActiveShipRuntime(
      "ship-uninterruptible-lock-hold",
      ({ worktreeRoot, runtime, allowedScope, ephemeralRunId }) =>
        Effect.gen(function* () {
          const origEngine = Context.get(runtime.shipWorkflowContext, WorkflowEngine.WorkflowEngine)
          const spiedContext = Context.add(
            runtime.shipWorkflowContext,
            WorkflowEngine.WorkflowEngine,
            {
              ...origEngine,
              interrupt: (workflow, executionId) =>
                Deferred.succeed(interruptInvoked, undefined).pipe(
                  Effect.andThen(origEngine.interrupt(workflow, executionId)),
                ),
            },
          )
          const spiedRuntime: WorkflowDaemonRuntime = {
            ...runtime,
            shipWorkflowContext: spiedContext,
          }

          const treeHash = match(computeWorkspaceTreeHashChecked(worktreeRoot, nodeSyncHostIo))
            .with({ _tag: "Success" }, ({ success }) => success)
            .with({ _tag: "Failure" }, ({ failure }) =>
              expect.unreachable(`Expected tree hash computation to succeed: ${failure}`),
            )
            .exhaustive()
          const executionId1 = yield* shipExecutionIdOf({
            runId: ephemeralRunId,
            treeHash,
            attempt: ShipAttempt.make(1),
            repoRoot: worktreeRoot,
          })

          const firstFiber = yield* handleDaemonWorkflowShipRequest({
            requestId: "req-slow-timeout-1",
            rawPayload: { repoRoot: worktreeRoot },
            scope: allowedScope,
            runtime: spiedRuntime,
            settleTimeoutMs: WorkflowTimeoutMs.make(1500),
          }).pipe(Effect.forkChild)

          yield* Deferred.await(slowGateStarted)

          callPhase = "fast-second"
          const secondFiber = yield* handleDaemonWorkflowShipRequest({
            requestId: "req-concurrent-after-timeout-2",
            rawPayload: { repoRoot: worktreeRoot },
            scope: allowedScope,
            runtime: spiedRuntime,
          }).pipe(Effect.forkChild)

          // Wait until settleTimeoutMs fires and interruptAndSettleShipAttempt begins,
          // then hold the uninterruptible gate open 150ms longer to verify lock retention.
          yield* Deferred.await(interruptInvoked)
          yield* Effect.sleep("150 millis")
          expect(slowGateCompleted).toBe(false)
          expect(secondCallStartedWhileSlowGateActive).toBe(false)

          yield* Deferred.succeed(releaseSlowGate, undefined)

          const firstEnvelope = yield* Fiber.join(firstFiber)
          const secondEnvelope = yield* Fiber.join(secondFiber)

          expect(firstEnvelope).toMatchObject({
            id: "req-slow-timeout-1",
            ok: false,
            command: "workflow.ship",
          })
          if (firstEnvelope.ok) {
            expect.unreachable("Expected first timed-out ship to fail")
          }
          expect(firstEnvelope.error).toContain("timed out after 1500ms")

          expect(secondEnvelope).toMatchObject({
            id: "req-concurrent-after-timeout-2",
            ok: true,
            command: "workflow.ship",
            result: {
              attempt: 2,
              outcome: { _tag: "Passed" },
            },
          })

          expect(slowGateCompleted).toBe(true)
          expect(secondCallStartedWhileSlowGateActive).toBe(false)
          expect(runtime.shipProgressListeners.size).toBe(0)

          const polledFirst = yield* ShipWorkflow.poll(executionId1).pipe(
            Effect.provideContext(runtime.shipWorkflowContext),
          )
          match(polledFirst)
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value._tag).toBe("Complete")
            })
            .with({ _tag: "None" }, () => {
              expect.unreachable("Expected timed-out ShipWorkflow execution to reach Complete")
            })
            .exhaustive()

          const attempts = yield* runtime.shipAttemptStore.listAttemptsForRun(ephemeralRunId)
          expect(attempts.map((a) => [a.attempt, a.status])).toEqual([
            [1, "failed"],
            [2, "passed"],
          ])
        }),
      slowUninterruptibleCommand,
    )
  }, 45_000)

  it("cancels active gate and marks WfShipAttempt failed when client destroys raw Unix socket mid-flight", async () => {
    const { canonicalDir, baseSha } = createWorkRepo("socket-disconnect-cancel")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const gateStarted = await Effect.runPromise(Deferred.make<void>())
    const gateInterrupted = await Effect.runPromise(Deferred.make<void>())
    let holdGateOpen = true

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunCommand: (_cmd, args) =>
          Effect.gen(function* () {
            if (holdGateOpen && args.includes("gc")) {
              yield* Deferred.succeed(gateStarted, undefined)
              return yield* Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Deferred.succeed(gateInterrupted, undefined).pipe(Effect.ignore),
                ),
              )
            }
            return {
              _tag: "Exited" as const,
              exitCode: 0,
              stdout: args.includes("done") ? JSON.stringify({ decision: "stop" }) : "",
              stderr: "",
              durationMs: 2,
            }
          }),
      },
    })

    try {
      const plan = await completeSingleUnitManualRun(
        validatedCanonical.worktreeRoot,
        "run-socket-disconnect-01",
        baseSha,
      )
      const socketPath = resolveWorkflowRuntimePaths(validatedCanonical.commonGitDir).socketPath

      await new Promise<void>((resolveDisconnect, rejectDisconnect) => {
        const socket = createConnection(socketPath)
        let buffer = ""
        let stageStartedSeen = false
        socket.on("error", rejectDisconnect)
        socket.on("connect", () => {
          socket.write(
            `${JSON.stringify({
              id: "req-socket-disconnect-1",
              command: "workflow.ship",
              repoRoot: validatedCanonical.worktreeRoot,
              runId: plan.runId,
            })}\n`,
          )
        })
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8")
          if (!stageStartedSeen && buffer.includes('"gc-strict"')) {
            stageStartedSeen = true
            void Effect.runPromise(Deferred.await(gateStarted)).then(() => {
              socket.destroy()
              resolveDisconnect()
            }, rejectDisconnect)
          }
        })
      })

      await Effect.runPromise(Deferred.await(gateInterrupted))

      holdGateOpen = false
      const followUpRes = await Effect.runPromise(
        shipWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      expect(followUpRes.attempt).toBe(2)
      expect(followUpRes.outcome._tag).toBe("Passed")

      const status = await Effect.runPromise(
        getWorkflowStatusViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: plan.runId,
        }),
      )
      match(status)
        .with({ _tag: "Ready" }, ({ outcome }) => {
          match(outcome)
            .with({ _tag: "Completed" }, ({ shipAttempts }) => {
              expect(shipAttempts?.map((a) => [a.attempt, a.status])).toEqual([
                [1, "failed"],
                [2, "passed"],
              ])
            })
            .with({ _tag: "NotFound" }, { _tag: "Active" }, { _tag: "Failed" }, () => {
              expect.unreachable("Expected Completed run outcome")
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
  }, 45_000)

  it("supports buildWorkflowPortsLayer layer overrides and safely ignores progress events without a registered listener", async () => {
    const { canonicalDir } = createWorkRepo("ports-layer-overrides")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const shipProgressListeners = new Map<string, (event: ShipStreamProgressEvent) => void>()

    const customProjectionWriter = Layer.succeed(WorkflowProjectionWriter, {
      upsertRun: () => Effect.void,
      upsertUnit: () => Effect.void,
      upsertAttempt: () => Effect.void,
    })
    const customReadModelQuery = Layer.succeed(WorkflowReadModelQuery, {
      getRun: () => Effect.succeedNone,
      listRuns: Effect.succeed([]),
      listUnits: () => Effect.succeed([]),
      listAttempts: () => Effect.succeed([]),
      probeAvailability: Effect.succeed("ready" as const),
    })
    const makeAttemptRecord = (
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
    const customAttemptStore = Layer.succeed(ShipAttemptStore, {
      allocateAttempt: ({ runId }) =>
        Effect.succeed(makeAttemptRecord(runId, ShipAttempt.make(1), "running")),
      updateStatus: ({ runId, attempt, status }) =>
        Effect.succeed(makeAttemptRecord(runId, attempt, status)),
      listAttemptsForRun: () => Effect.succeed([]),
    })

    const basePortsLayer = buildWorkflowPortsLayer(
      validatedCanonical.worktreeRoot,
      {
        mode: "required",
        unitVerifierLayer: makeCompletedVerifierLayer(),
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: reviewStubLayer,
        shipGateRunCommand: makePassingShipRunCommand(),
      },
      { commonGitDir: validatedCanonical.commonGitDir },
      (_runId, eff) => eff,
      (eff) => eff,
      shipProgressListeners,
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const overriddenLayer = buildWorkflowPortsLayer(
            validatedCanonical.worktreeRoot,
            {
              mode: "required",
              workflowPortsLayer: basePortsLayer,
              projectionWriterLayer: customProjectionWriter,
              readModelQueryLayer: customReadModelQuery,
              shipAttemptStoreLayer: customAttemptStore,
            },
            { commonGitDir: validatedCanonical.commonGitDir },
            (_runId, eff) => eff,
            (eff) => eff,
            shipProgressListeners,
          )
          const ctx = yield* Layer.buildWithScope(overriddenLayer, scope)
          const query = Context.get(ctx, WorkflowReadModelQuery)
          const attempts = Context.get(ctx, ShipAttemptStore)
          const runner = Context.get(ctx, ShipGateRunner)

          expect(yield* query.listRuns).toEqual([])
          expect(yield* attempts.listAttemptsForRun(WorkflowRunId.make("run-override-1"))).toEqual(
            [],
          )

          // Emit a progress event with no listener registered for this key (exercises cb?.(event) no-op)
          const treeHash = match(
            computeWorkspaceTreeHashChecked(validatedCanonical.worktreeRoot, nodeSyncHostIo),
          )
            .with({ _tag: "Success" }, ({ success }) => success)
            .with({ _tag: "Failure" }, ({ failure }) =>
              expect.unreachable(`Expected tree hash computation to succeed: ${failure}`),
            )
            .exhaustive()
          yield* runner.reportStageProgress({
            _tag: "StageStarted",
            runId: WorkflowRunId.make("run-unregistered-listener"),
            attempt: ShipAttempt.make(1),
            stage: "format-check",
          })
          const stageRes = yield* runner.executeStageCommand({
            runId: WorkflowRunId.make("run-unregistered-listener"),
            attempt: ShipAttempt.make(1),
            stage: "format-check",
            treeHash,
            repoRoot: validatedCanonical.worktreeRoot,
          })
          expect(stageRes._tag).toBe("Passed")

          const ephemeralTarget = yield* resolveShipRunTarget(undefined, treeHash, query)
          expect(ephemeralTarget).toEqual({
            runId: `ship-${treeHash.slice(0, 12)}`,
            runOrigin: "ephemeral",
          })
          const missingTargetReason = yield* Effect.flip(
            resolveShipRunTarget(WorkflowRunId.make("run-missing-target"), treeHash, query),
          )
          expect(missingTargetReason).toContain("not found")
        }),
      ),
    )
  })

  it("settles composite interrupt causes without swallowing failures and cleans listeners via Effect.ensuring on defects", async () => {
    await withActiveShipRuntime(
      "ship-composite-interrupt-ensuring",
      ({ worktreeRoot, runtime, allowedScope, ephemeralRunId }) =>
        Effect.gen(function* () {
          const origEngine = Context.get(runtime.shipWorkflowContext, WorkflowEngine.WorkflowEngine)
          const interruptedExecutions: Array<string> = []
          const compositeCause = Cause.combine(
            Cause.fail(
              new ShipGateFailedError({
                stage: "gc-strict",
                exitCode: GateExitCode.make(1),
                stderrSummary: GateStderrSummary.make("composite gate failure"),
                circuitBreakerStatus: "clear",
              }),
            ),
            Cause.interrupt(1),
          )

          const compositeEngineContext = Context.add(
            runtime.shipWorkflowContext,
            WorkflowEngine.WorkflowEngine,
            {
              ...origEngine,
              execute: () => Effect.failCause(compositeCause),
              interrupt: (workflow, executionId) => {
                interruptedExecutions.push(executionId)
                return origEngine.interrupt(workflow, executionId)
              },
              poll: () =>
                Effect.succeedSome(
                  new Workflow.Complete({
                    exit: Exit.failCause(Cause.interrupt(1)),
                  }),
                ),
            },
          )

          const compositeFailExit = yield* Effect.exit(
            handleDaemonWorkflowShipRequest({
              requestId: "req-composite-fail-interrupt",
              rawPayload: { repoRoot: worktreeRoot },
              scope: allowedScope,
              runtime: { ...runtime, shipWorkflowContext: compositeEngineContext },
            }),
          )
          match(compositeFailExit)
            .with({ _tag: "Success" }, ({ value: envelope }) => {
              expect(envelope.ok).toBe(false)
              if (!envelope.ok) {
                expect(envelope.error).toContain("composite gate failure")
              }
            })
            .with({ _tag: "Failure" }, () => {
              expect.unreachable("Expected Effect.result to surface Fail+Interrupt as rpcError")
            })
            .exhaustive()

          const compositeDieContext = Context.add(
            runtime.shipWorkflowContext,
            WorkflowEngine.WorkflowEngine,
            {
              ...origEngine,
              execute: () =>
                Effect.failCause(
                  Cause.combine(Cause.die(new Error("composite die")), Cause.interrupt(1)),
                ),
              interrupt: (workflow, executionId) => {
                interruptedExecutions.push(executionId)
                return origEngine.interrupt(workflow, executionId)
              },
              poll: () =>
                Effect.succeedSome(
                  new Workflow.Complete({
                    exit: Exit.failCause(Cause.interrupt(1)),
                  }),
                ),
            },
          )
          const compositeDieExit = yield* Effect.exit(
            handleDaemonWorkflowShipRequest({
              requestId: "req-composite-die-interrupt",
              rawPayload: { repoRoot: worktreeRoot },
              scope: allowedScope,
              runtime: { ...runtime, shipWorkflowContext: compositeDieContext },
            }),
          )
          match(compositeDieExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasInterrupts(cause)).toBe(true)
              expect(Cause.hasDies(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected Die+Interrupt failure exit")
            })
            .exhaustive()

          expect(interruptedExecutions).toHaveLength(2)
          expect(runtime.shipProgressListeners.size).toBe(0)
          const attemptsAfterComposite =
            yield* runtime.shipAttemptStore.listAttemptsForRun(ephemeralRunId)
          expect(attemptsAfterComposite.map((a) => [a.attempt, a.status])).toEqual([
            [1, "failed"],
            [2, "failed"],
          ])

          const gateStarted = yield* Deferred.make<void>()
          const releaseGate = yield* Deferred.make<void>()
          const defectEngineContext = Context.add(
            runtime.shipWorkflowContext,
            WorkflowEngine.WorkflowEngine,
            {
              ...origEngine,
              execute: () =>
                Deferred.succeed(gateStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseGate)),
                  Effect.andThen(Effect.never),
                ),
            },
          )
          const defectAttemptStore: typeof runtime.shipAttemptStore = {
            ...runtime.shipAttemptStore,
            updateStatus: () => Effect.die(new Error("updateStatus defect during settle")),
          }
          const defectExit = yield* Effect.exit(
            handleDaemonWorkflowShipRequest({
              requestId: "req-settle-defect-cleanup",
              rawPayload: { repoRoot: worktreeRoot },
              scope: allowedScope,
              runtime: {
                ...runtime,
                shipWorkflowContext: defectEngineContext,
                shipAttemptStore: defectAttemptStore,
              },
              settleTimeoutMs: WorkflowTimeoutMs.make(50),
            }),
          )
          match(defectExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasDies(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected defect failure exit")
            })
            .exhaustive()
          yield* Deferred.succeed(releaseGate, undefined)
          expect(runtime.shipProgressListeners.size).toBe(0)
        }),
    )
  }, 45_000)
})
