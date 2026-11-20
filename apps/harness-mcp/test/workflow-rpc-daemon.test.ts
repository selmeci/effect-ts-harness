import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"
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
  GitCommitSha,
  LeaseEpoch,
  MaxConcurrency,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
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
  WorkflowRunId,
  toErrorReasonMessage,
} from "@harness/contract"
import { appendFrictionEvent, clearFrictionEvents, resolveHarnessStateDir } from "@harness/gates"
import { makeWorkflowOmnigraphClient } from "@harness/graph"
import {
  UnitAgentDispatcherLive,
  abortWorkflowViaDaemon,
  completeWorkflowViaDaemon,
  doctorWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  makeWorkflowWorktreePortLayer,
  nodeSyncHostIo,
  resumeWorkflowViaDaemon,
  startWorkflowViaDaemon,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import {
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import { startHarnessDaemonServer } from "../src/daemon/unix-socket-daemon.js"
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

describe("WF-3 Unix-socket daemon workflow RPCs & harness_workflow_plan", () => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  const cliToken = "wf3-rpc-daemon-token"

  const createClient = () =>
    makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken })

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
  }, 30_000)

  afterAll(async () => {
    await stopChildProcess(serverProc)
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("drives full Manual lifecycle over Unix socket IPC: start (idempotent + planSha mismatch), premature guards, 3x reject -> escalation -> resume retry -> shared-step -> dirty/corrupt friction rejection -> llm-phase -> doctor rebuild preserving shared-step -> harness_workflow_plan", async () => {
    const workBase = mkdtempSync(join(tmpdir(), "wf3-rpc-flow-"))
    tempDirs.push(workBase)
    const { canonicalDir, linkedDir, baseSha } = initTestGitRepo(workBase, "repo")
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )
    const validatedLinked = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(linkedDir)),
    )

    let completeCalls = 0
    const recordedSharedInputs: Array<CompleteSharedStepInput> = []
    const verifierLayer = Layer.succeed(UnitVerifier, {
      completeUnit: (input) =>
        Effect.sync(() => {
          completeCalls += 1
          if (completeCalls <= 3) {
            return UnitOutcome.cases.Rejected.make({
              unitId: input.unit.unitId,
              attempt: input.attempt,
              rejection: UnitRejection.cases.PackageVerifyFailed.make({
                exitCode: GateExitCode.make(1),
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

    const runId = WorkflowRunId.make("run-rpc-flow-01")
    const unitId = WorkUnitId.make("unit-alpha")
    const plan: CompiledPlan = {
      runId,
      level: "slice",
      planSha: PlanSha256.make("c".repeat(64)),
      baseSha,
      mode: { _tag: "Manual" },
      units: [
        {
          _tag: "PackageUnit",
          unitId,
          projectName: NxProjectName.make("@harness/alpha"),
          waveIndex: WaveIndex.make(0),
          dependsOn: [],
          ownedRelPaths: [OwnedRelPath.make("libs/alpha/src")],
          stubKeys: [StubSymbolKey.make("Alpha.run")],
          earsKeys: [EarsRequirementKey.make("REQ-1.1")],
          packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
        },
      ],
      sharedStepPaths: [OwnedRelPath.make("README.md")],
    }

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: verifierLayer,
        worktreePortLayer: makeNoopWorktreeLayer(validatedCanonical.worktreeRoot),
        reviewRouterLayer: makeReviewStubLayer(),
        agentDispatcherLayer: UnitAgentDispatcherLive,
      },
    })

    try {
      expect(daemon.writerLeaseEpoch).toBeGreaterThanOrEqual(1)

      const start1 = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan }),
      )
      expect(start1.runId).toBe(runId)
      expect(start1.outcome).toBe("started")

      const start2 = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedLinked.worktreeRoot, plan }),
      )
      expect(start2.executionId).toBe(start1.executionId)
      expect(start2.outcome).toBe("existing")

      // Duplicate runId with different planSha fails closed
      const conflictingPlan: CompiledPlan = {
        ...plan,
        planSha: PlanSha256.make("1".repeat(64)),
      }
      const planShaErr = await Effect.runPromise(
        startWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          plan: conflictingPlan,
        }).pipe(Effect.flip),
      )
      expect(planShaErr.message).toContain("planSha")

      const initialStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedLinked.worktreeRoot, runId }),
      )
      expect(initialStatus.storeStatus).toBe("ready")
      expect(initialStatus.writerLeaseEpoch).toBe(daemon.writerLeaseEpoch)
      expect(initialStatus.run?.state).toBe("running")
      expect(initialStatus.pendingDeferreds).toEqual([
        {
          _tag: "UnitCompletion",
          unitId,
          attempt: 1,
          deferredName: "unit/unit-alpha/1",
        },
      ])

      // Premature CompleteLlmPhase while unit-alpha is dispatched is rejected
      const prematureLlmErr = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteLlmPhase",
          repoRoot: validatedCanonical.worktreeRoot,
          runId,
        }).pipe(Effect.flip),
      )
      expect(prematureLlmErr.message).toContain("waiting")

      // Resume on non-escalated unit is rejected
      const prematureResumeErr = await Effect.runPromise(
        resumeWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId,
          unitId,
          decision: EscalationDecision.make("retry"),
        }).pipe(Effect.flip),
      )
      expect(prematureResumeErr.message).toContain("escalated")

      const mcpStatusFromLinked = await Effect.runPromise(
        executeWorkflowPlanTool({ repoRoot: linkedDir, runId }),
      )
      expect(mcpStatusFromLinked.resolvedRepoRoot).toBe(validatedLinked.worktreeRoot)
      expect(mcpStatusFromLinked.commonGitDir).toBe(validatedCanonical.commonGitDir)
      expect(mcpStatusFromLinked.status.pendingDeferreds).toHaveLength(1)

      // Attempts 1, 2, 3 reject -> escalates to escalation/unit-alpha/1
      for (const expectedAttempt of [1, 2, 3] as const) {
        const compRes = await Effect.runPromise(
          completeWorkflowViaDaemon({
            _tag: "CompleteUnit",
            repoRoot: validatedCanonical.worktreeRoot,
            unitId,
            runId,
          }),
        )
        match(compRes)
          .with({ _tag: "UnitCompleted" }, ({ outcome }) => {
            match(outcome)
              .with({ _tag: "Rejected" }, (rej) => {
                expect(rej.attempt).toBe(expectedAttempt)
              })
              .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => {
                expect.fail("Expected Rejected outcome")
              })
              .exhaustive()
          })
          .with({ _tag: "LlmPhaseCompleted" }, () => {
            expect.fail("Expected UnitCompleted response")
          })
          .exhaustive()
      }

      const escalatedStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId }),
      )
      expect(escalatedStatus.units.find((u) => u.unitId === unitId)?.status).toBe("escalated")
      expect(escalatedStatus.pendingDeferreds).toEqual([
        {
          _tag: "Escalation",
          unitId,
          deferredName: "escalation/unit-alpha/1",
          escalation: {
            _tag: "RetryBudgetExhausted",
            lastRejection: {
              _tag: "PackageVerifyFailed",
              exitCode: 1,
            },
          },
        },
      ])

      // Resolve escalation with retry -> moves to cycle r2
      const resumed = await Effect.runPromise(
        resumeWorkflowViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId,
          unitId,
          decision: "retry",
        }),
      )
      expect(resumed).toEqual({
        _tag: "EscalationResolved",
        runId,
        executionId: start1.executionId,
        unitId,
        decision: "retry",
      })

      const retryStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId }),
      )
      expect(retryStatus.pendingDeferreds).toEqual([
        {
          _tag: "UnitCompletion",
          unitId,
          attempt: 1,
          deferredName: "unit/unit-alpha/1/r2",
        },
      ])

      // Complete unit-alpha in cycle r2
      const unitDone = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedCanonical.worktreeRoot,
          unitId,
          runId,
        }),
      )
      match(unitDone)
        .with({ _tag: "UnitCompleted" }, ({ outcome }) => {
          expect(outcome._tag).toBe("Completed")
        })
        .with({ _tag: "LlmPhaseCompleted" }, () => {
          expect.fail("Expected UnitCompleted response")
        })
        .exhaustive()

      // Now shared-step is active
      const sharedPendingStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId }),
      )
      expect(sharedPendingStatus.pendingDeferreds).toEqual([
        {
          _tag: "UnitCompletion",
          unitId: SHARED_STEP_UNIT_ID,
          attempt: 1,
          deferredName: "unit/shared-step/1",
        },
      ])

      // Complete shared-step and verify priorUnitOwnedPaths propagation
      const sharedDone = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedCanonical.worktreeRoot,
          unitId: SHARED_STEP_UNIT_ID,
          runId,
        }),
      )
      match(sharedDone)
        .with({ _tag: "UnitCompleted" }, ({ outcome }) => {
          expect(outcome._tag).toBe("Completed")
        })
        .with({ _tag: "LlmPhaseCompleted" }, () => {
          expect.fail("Expected UnitCompleted response")
        })
        .exhaustive()
      expect(recordedSharedInputs).toHaveLength(1)
      expect(recordedSharedInputs[0]?.priorUnitOwnedPaths).toEqual(["libs/alpha/src"])

      // Now llm-phase-done is pending
      const llmPendingStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId }),
      )
      expect(llmPendingStatus.pendingDeferreds).toEqual([
        {
          _tag: "LlmPhase",
          deferredName: "llm-phase-done",
        },
      ])

      // Corrupt/unparseable line in default friction log blocks CompleteLlmPhase
      const defaultStateDir = resolveHarnessStateDir(validatedCanonical.worktreeRoot, {})
      mkdirSync(defaultStateDir, { recursive: true })
      const defaultFrictionPath = join(defaultStateDir, "friction-log.jsonl")
      writeFileSync(defaultFrictionPath, "corrupt-unparseable-friction-line\n", "utf8")
      const corruptFrictionErr = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteLlmPhase",
          repoRoot: validatedCanonical.worktreeRoot,
          runId,
        }).pipe(Effect.flip),
      )
      expect(corruptFrictionErr.message).toContain("friction log")
      writeFileSync(defaultFrictionPath, "", "utf8")

      // Dirty valid friction event also blocks CompleteLlmPhase
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
          runId,
        }).pipe(Effect.flip),
      )
      expect(dirtyFrictionErr.message).toContain("friction log")

      // Clear friction log -> CompleteLlmPhase succeeds
      clearFrictionEvents(validatedCanonical.worktreeRoot, nodeSyncHostIo)
      const llmDone = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteLlmPhase",
          repoRoot: validatedCanonical.worktreeRoot,
          runId,
        }),
      )
      match(llmDone)
        .with({ _tag: "LlmPhaseCompleted" }, ({ receipt }) => {
          expect(receipt.frictionLogCleared).toBe("cleared")
          expect(receipt.workspaceHash).toMatch(/^[0-9a-f]{64}$/)
        })
        .with({ _tag: "UnitCompleted" }, () => {
          expect.fail("Expected LlmPhaseCompleted response")
        })
        .exhaustive()

      const completedStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId }),
      )
      expect(completedStatus.run?.state).toBe("completed")
      expect(completedStatus.pendingDeferreds).toEqual([])
      expect(completedStatus.terminalReceipt?.runId).toBe(runId)
      expect(completedStatus.review?._tag).toBe("SkipReviewPlan")

      // Doctor check-only + rebuild preserves BOTH unitId and SHARED_STEP_UNIT_ID completed
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

      const afterRebuildStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId }),
      )
      expect(afterRebuildStatus.run?.state).toBe("completed")
      expect(afterRebuildStatus.units.find((u) => u.unitId === unitId)?.status).toBe("completed")
      expect(afterRebuildStatus.units.find((u) => u.unitId === SHARED_STEP_UNIT_ID)?.status).toBe(
        "completed",
      )
    } finally {
      await daemon.close()
    }
  }, 45_000)

  it("handles L1 complete cwd binding & abort compensation, L2 siblingInFlightOwnedPaths, Automatic pending LlmPhaseDone, and cross-repo/offline harness_workflow_plan", async () => {
    const workBase = mkdtempSync(join(tmpdir(), "wf3-rpc-abort-"))
    tempDirs.push(workBase)
    const { canonicalDir, baseSha } = initTestGitRepo(workBase, "l1repo")
    const { canonicalDir: otherGitRepo } = initTestGitRepo(workBase, "otherrepo")
    const outsideDir = join(workBase, "outside-nongit")
    mkdirSync(outsideDir, { recursive: true })
    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(canonicalDir)),
    )

    const recordedVerifierInputs: Array<CompleteUnitInput> = []
    const recordingVerifierLayer = Layer.succeed(UnitVerifier, {
      completeUnit: (input) =>
        Effect.sync(() => {
          recordedVerifierInputs.push(input)
          return UnitOutcome.cases.Completed.make({
            unitId: input.unit.unitId,
            attempt: input.attempt,
            changedPaths: [...input.unit.ownedRelPaths],
            packageStampHash: PackageStampHash.make("d".repeat(64)),
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

    const autoDispatcherLayer = Layer.succeed(UnitAgentDispatcher, {
      dispatchUnit: () => Effect.succeed(UnitAgentDispatchResult.cases.Completed.make({})),
    })

    const l1RunId = WorkflowRunId.make("run-l1-abort-01")
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

    const l2RunId = WorkflowRunId.make("run-l2-sib-01")
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

    const autoRunId = WorkflowRunId.make("run-auto-llm-01")
    const autoUnitId = WorkUnitId.make("auto-unit")
    const autoPlan: CompiledPlan = {
      runId: autoRunId,
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
          unitId: autoUnitId,
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

    const daemon = await startHarnessDaemonServer(canonicalDir, {
      workflowEngine: {
        mode: "required",
        client: createClient(),
        entityReplyPollInterval: "50 millis",
        unitVerifierLayer: recordingVerifierLayer,
        worktreePortLayer: makeWorkflowWorktreePortLayer({
          repoRoot: validatedCanonical.worktreeRoot,
        }),
        reviewRouterLayer: makeReviewStubLayer(),
        agentDispatcherLayer: autoDispatcherLayer,
      },
    })

    try {
      // 1. Start L1 epic plan -> creates linked worktrees under <commonGitDir>/harness/worktrees/<runId>/<unitId>
      const l1Start = await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan: l1Plan }),
      )
      expect(l1Start.outcome).toBe("started")
      const wtOnePath = join(
        validatedCanonical.commonGitDir,
        "harness",
        "worktrees",
        l1RunId,
        l1UnitOne,
      )
      const wtTwoPath = join(
        validatedCanonical.commonGitDir,
        "harness",
        "worktrees",
        l1RunId,
        l1UnitTwo,
      )
      expect(existsSync(wtOnePath)).toBe(true)
      expect(existsSync(wtTwoPath)).toBe(true)

      // L1 complete rejects canonicalDir (must be unit's provisioned linked worktree!)
      const spoofCwdErr = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedCanonical.worktreeRoot,
          unitId: l1UnitOne,
          runId: l1RunId,
        }).pipe(Effect.flip),
      )
      expect(spoofCwdErr.message).toContain("provisioned worktree")

      // L1 complete succeeds when passed the unit's provisioned linked worktree
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

      // Abort L1 run -> compensation removes linked worktrees while preserving slice/* branches
      const abortRes = await Effect.runPromise(
        abortWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, runId: l1RunId }),
      )
      expect(abortRes.state).toBe("aborted")
      expect(existsSync(wtOnePath)).toBe(false)
      expect(existsSync(wtTwoPath)).toBe(false)
      const branches = execFileSync("git", ["branch", "--list", "slice/wf3-abort-*"], {
        cwd: canonicalDir,
        encoding: "utf8",
      })
      expect(branches).toContain(l1BranchOne)
      expect(branches).toContain(l1BranchTwo)

      // 2. Start L2 slice plan -> complete unit-a -> verify unit-b's ownedRelPaths passed as siblingInFlightOwnedPaths
      await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan: l2Plan }),
      )
      const compA = await Effect.runPromise(
        completeWorkflowViaDaemon({
          _tag: "CompleteUnit",
          repoRoot: validatedCanonical.worktreeRoot,
          unitId: unitA,
          runId: l2RunId,
        }),
      )
      expect(compA._tag).toBe("UnitCompleted")
      const compAInput = recordedVerifierInputs.find((i) => i.unit.unitId === unitA)
      expect(compAInput?.siblingInFlightOwnedPaths).toEqual(["libs/pkg-b/src"])

      // 3. Automatic mode workflow completes unit via dispatcher + verifier and surfaces LlmPhaseDone
      await Effect.runPromise(
        startWorkflowViaDaemon({ repoRoot: validatedCanonical.worktreeRoot, plan: autoPlan }),
      )
      const autoStatus = await Effect.runPromise(
        getWorkflowStatusViaDaemon({
          repoRoot: validatedCanonical.worktreeRoot,
          runId: autoRunId,
        }),
      )
      expect(autoStatus.run?.state).toBe("waiting")
      expect(autoStatus.units.find((u) => u.unitId === autoUnitId)?.status).toBe("completed")
      expect(autoStatus.pendingDeferreds).toEqual([
        {
          _tag: "LlmPhase",
          deferredName: "llm-phase-done",
        },
      ])
    } finally {
      await daemon.close()
    }

    // Offline fallback when daemon is stopped (read-only, no mutation)
    const offlinePlanOut = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: canonicalDir }),
    )
    expect(offlinePlanOut.resolvedRepoRoot).toBe(validatedCanonical.worktreeRoot)
    expect(offlinePlanOut.commonGitDir).toBe(validatedCanonical.commonGitDir)
    expect(offlinePlanOut.status.storeStatus).toBe("inactive")
    expect(offlinePlanOut.status.writerLeaseEpoch).toBe(LeaseEpoch.make(0))

    // Invalid / non-git repoRoot fails closed
    const invalidErr = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: outsideDir }).pipe(Effect.flip),
    )
    expect(toErrorReasonMessage(invalidErr)).toContain("git")

    // Relative escape against configured ServerOptions.repoRoot fails with ProjectPathEscapeError
    const escapeErr = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: "../outside-nongit" }, { repoRoot: canonicalDir }).pipe(
        Effect.flip,
      ),
    )
    expect(escapeErr._tag).toBe("ProjectPathEscapeError")

    // Cross-repo commonGitDir mismatch fails with ProjectPathEscapeError
    const crossRepoErr = await Effect.runPromise(
      executeWorkflowPlanTool({ repoRoot: otherGitRepo }, { repoRoot: canonicalDir }).pipe(
        Effect.flip,
      ),
    )
    expect(crossRepoErr._tag).toBe("ProjectPathEscapeError")
  }, 45_000)
})
