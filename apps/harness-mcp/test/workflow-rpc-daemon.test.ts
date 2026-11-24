import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  type CompiledPlan,
  type CompleteSharedStepInput,
  type CompleteUnitInput,
  EarsRequirementKey,
  EscalationDecision,
  GateExitCode,
  MaxConcurrency,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PackageVerifyFailureDetail,
  PlanSha256,
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
  WorkflowRunId,
} from "@harness/contract"
import {
  appendFrictionEvent,
  clearFrictionEvents,
  executionIdOf,
  resolveHarnessStateDir,
} from "@harness/gates"
import {
  UnitAgentDispatcherLive,
  abortWorkflowViaDaemon,
  completeWorkflowViaDaemon,
  doctorWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  makeWorkflowWorktreePortLayer,
  nodeSyncHostIo,
  resolveWorkflowWorktreeDir,
  resumeWorkflowViaDaemon,
  startWorkflowViaDaemon,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import { UnitAgentDispatcher, UnitVerifier } from "@harness/service"
import { startHarnessDaemonServer } from "../src/daemon/unix-socket-daemon.js"
import { executeWorkflowPlanTool } from "../src/tools/workflow-plan.tools.js"
import {
  makeCompletedVerifierLayer,
  makeMockLeaseStoreClient,
  makeNoopWorktreeLayer,
  reviewStubLayer,
  makeSingleUnitManualPlan,
  startWorkflowDaemonServerHarness,
} from "./helpers/workflow-daemon-fixture.js"

describe("WF-3 Unix-socket daemon workflow RPCs (start, retry, epic & slice isolation)", () => {
  const harness = startWorkflowDaemonServerHarness("wf3-daemon-og-")
  const createClient = () => harness.createClient()
  const createWorkRepo = (name: string) => harness.createWorkRepo(name)
  beforeAll(() => harness.start(), 30_000)
  afterAll(() => harness.stop())

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
        reviewRouterLayer: reviewStubLayer,
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
        executeWorkflowPlanTool(
          { repoRoot: linkedDir, runId: plan.runId },
          { repoRoot: canonicalDir },
        ),
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
        reviewRouterLayer: reviewStubLayer,
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
        reviewRouterLayer: reviewStubLayer,
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
        reviewRouterLayer: reviewStubLayer,
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
        executeWorkflowPlanTool(
          { repoRoot: canonicalDir, runId: l2RunId },
          { repoRoot: canonicalDir },
        ),
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
        reviewRouterLayer: reviewStubLayer,
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
        reviewRouterLayer: reviewStubLayer,
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
        reviewRouterLayer: reviewStubLayer,
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
        reviewRouterLayer: reviewStubLayer,
      },
    })
    try {
      const execId2 = await Effect.runPromise(executionIdOf(plan2))
      await Effect.runPromise(startWorkflowViaDaemon({ repoRoot: val2.worktreeRoot, plan: plan2 }))
      await daemon2.close()

      // Restart fresh daemon (empty plansRef) with a client that hides WfRun from getRun -> F-6.1 must reject!
      const hideRunClient = createClient()
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
          reviewRouterLayer: reviewStubLayer,
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
})
