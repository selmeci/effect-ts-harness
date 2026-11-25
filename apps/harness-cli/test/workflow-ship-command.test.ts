import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  GateDurationMs,
  GateExitCode,
  GateStderrSummary,
  GitCommitSha,
  LeaseEpoch,
  MutationRestoreError,
  PlanSha256,
  ShipAttempt,
  ShipFailureMessage,
  ShipGateFailedError,
  ShipStage,
  ShipStageFailed,
  ShipStagePassed,
  ShipStreamProgressEvent,
  ShipTreeDriftError,
  ShipTreeMismatchError,
  WorkflowExecutionId,
  WorkflowProjectionStatus,
  WorkflowRunId,
  WorkflowRunOutcome,
  WorkflowRunState,
  WorkflowShipAttemptRecord,
  type WorkflowShipRequest,
  WorkflowShipResponse,
  WorkflowStatusSummary,
  WorkflowTimestampMs,
  WorkspaceTreeHash,
  encodeShipAttemptKey,
} from "@harness/contract"
import { runDeclarativeCli } from "../src/commands/declarative-cli.js"
import {
  formatWorkflowShipOutcome,
  formatWorkflowShipProgressLine,
  parseWorkflowCliArgs,
  resolveOptionalRunId,
} from "../src/commands/workflow-command-helpers.js"
import { handleWorkflow, type WorkflowCliDeps } from "../src/commands/workflow.command.js"

const tempDirs: Array<string> = []

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

const createTempGitRepo = (
  prefix: string,
): { readonly dir: string; readonly headSha: GitCommitSha } => {
  const rawDir = mkdtempSync(join(tmpdir(), prefix))
  const dir = realpathSync.native(rawDir)
  tempDirs.push(dir)
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, encoding: "utf8" })
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  mkdirSync(join(dir, "libs", "alpha", "src"), { recursive: true })
  writeFileSync(
    join(dir, "libs", "alpha", "package.json"),
    JSON.stringify({ name: "@harness/alpha", version: "0.0.0" }),
    "utf8",
  )
  writeFileSync(join(dir, "libs", "alpha", "src", "index.ts"), "export const x = 1\n", "utf8")
  execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8" })
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
  return { dir, headSha: GitCommitSha.make(sha) }
}

const RUN_ID = WorkflowRunId.make("wf-ship-cli-01")
const EXEC_ID = WorkflowExecutionId.make("wf-ship-cli-01")
const TREE_HASH = WorkspaceTreeHash.make("a".repeat(64))
const OTHER_HASH = WorkspaceTreeHash.make("b".repeat(64))
const ATTEMPT_1 = ShipAttempt.make(1)

const makePassedResponse = (): WorkflowShipResponse => ({
  runId: RUN_ID,
  attempt: ATTEMPT_1,
  executionId: EXEC_ID,
  treeHash: TREE_HASH,
  runOrigin: "compiled",
  outcome: {
    _tag: "Passed",
    receipt: {
      runId: RUN_ID,
      planSha: PlanSha256.make("c".repeat(64)),
      attempt: ATTEMPT_1,
      verifiedTreeHash: TREE_HASH,
    },
    stages: [
      ShipStagePassed.make({
        stage: ShipStage.make("format-check"),
        durationMs: GateDurationMs.make(12),
      }),
    ],
  },
})

describe("harness workflow ship CLI command", () => {
  it("parses --run, rejects conflicting --run & --run-id, and formats progress/outcomes", async () => {
    const parsed = parseWorkflowCliArgs(["workflow", "ship", "--run", RUN_ID, "--json"])
    expect(parsed._tag).toBe("Success")

    const matchBoth = await Effect.runPromise(
      resolveOptionalRunId({ run: ` ${RUN_ID} `, "run-id": RUN_ID }),
    )
    expect(matchBoth).toBe(RUN_ID)

    const onlyRunId = await Effect.runPromise(resolveOptionalRunId({ "run-id": RUN_ID }))
    expect(onlyRunId).toBe(RUN_ID)

    const omitted = await Effect.runPromise(resolveOptionalRunId({}))
    expect(omitted).toBeUndefined()

    const conflictErr = await Effect.runPromise(
      Effect.flip(resolveOptionalRunId({ run: RUN_ID, "run-id": "wf-other-99" })),
    )
    expect(conflictErr._tag).toBe("WorkflowCliValidationError")
    expect(conflictErr.message).toContain("Conflicting --run")

    for (const [field, badValue, expectedFlag] of [
      ["run", "bad", "--run"],
      ["run-id", "Invalid_Run!", "--run-id"],
      ["run", "   ", "--run"],
      ["run-id", "   ", "--run-id"],
    ] as const) {
      const invalidErr = await Effect.runPromise(
        Effect.flip(resolveOptionalRunId({ [field]: badValue })),
      )
      expect(invalidErr._tag).toBe("WorkflowCliValidationError")
      expect(invalidErr.message).toContain(`Invalid ${expectedFlag}`)
    }

    const startedEv: ShipStreamProgressEvent = ShipStreamProgressEvent.cases.StageStarted.make({
      runId: RUN_ID,
      attempt: ATTEMPT_1,
      stage: ShipStage.make("gc-strict"),
    })
    expect(formatWorkflowShipProgressLine(startedEv)).toBe(
      `[workflow:ship] ${RUN_ID} attempt=1 stage=gc-strict started`,
    )

    const passedEv: ShipStreamProgressEvent = ShipStreamProgressEvent.cases.StageFinished.make({
      runId: RUN_ID,
      attempt: ATTEMPT_1,
      progress: ShipStagePassed.make({
        stage: ShipStage.make("gc-strict"),
        durationMs: GateDurationMs.make(42),
      }),
    })
    expect(formatWorkflowShipProgressLine(passedEv)).toBe(
      `[workflow:ship] ${RUN_ID} attempt=1 stage=gc-strict passed (42ms)`,
    )

    const failedEv: ShipStreamProgressEvent = ShipStreamProgressEvent.cases.StageFinished.make({
      runId: RUN_ID,
      attempt: ATTEMPT_1,
      progress: ShipStageFailed.make({
        stage: ShipStage.make("mutate-strict"),
        durationMs: GateDurationMs.make(99),
        errorTag: "ShipGateFailedError",
        detail: ShipFailureMessage.make("mutant survived"),
      }),
    })
    expect(formatWorkflowShipProgressLine(failedEv)).toBe(
      `[workflow:ship] ${RUN_ID} attempt=1 stage=mutate-strict failed (99ms, ShipGateFailedError): mutant survived`,
    )
  })

  it("supports ephemeral ship (no --run), --run, --run-id, and rejects conflicting --run & --run-id via CLI", async () => {
    const { dir } = createTempGitRepo("harness-wf-ship-flags-")
    const receivedRequests: Array<WorkflowShipRequest> = []
    const deps: WorkflowCliDeps = {
      shipWorkflow: (req) => {
        receivedRequests.push(req)
        return Effect.succeed(makePassedResponse())
      },
    }

    const ephemeralRes = await Effect.runPromise(
      runDeclarativeCli(["workflow", "ship"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
        workflowDeps: deps,
      }),
    )
    expect(ephemeralRes.exitCode).toBe(0)
    expect(receivedRequests[0]).toEqual({ repoRoot: dir })
    const decoded = Schema.decodeSync(Schema.fromJsonString(WorkflowShipResponse))(
      ephemeralRes.stdout,
    )
    expect(decoded.outcome._tag).toBe("Passed")

    const withRunRes = await Effect.runPromise(
      runDeclarativeCli(["workflow", "ship", "--run", RUN_ID, "--repo-root", dir, "--json"], {
        skipBackgroundDaemons: true,
        workflowDeps: deps,
      }),
    )
    expect(withRunRes.exitCode).toBe(0)
    expect(receivedRequests[1]).toEqual({ repoRoot: dir, runId: RUN_ID })

    const withRunIdRes = await Effect.runPromise(
      handleWorkflow(["workflow", "ship", "--run-id", RUN_ID], { repoRoot: dir }, deps),
    )
    expect(withRunIdRes.exitCode).toBe(0)
    expect(receivedRequests[2]).toEqual({ repoRoot: dir, runId: RUN_ID })

    const conflictRes = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "ship", "--run", RUN_ID, "--run-id", "wf-different-02"],
        { repoRoot: dir },
        deps,
      ),
    )
    expect(conflictRes.exitCode).toBe(1)
    expect(conflictRes.stderr).toContain("Conflicting --run")
    expect(receivedRequests).toHaveLength(3)
  })

  it("streams progress to stderr when --json is false and suppresses stderr progress when --json is true", async () => {
    const { dir } = createTempGitRepo("harness-wf-ship-progress-")
    const events: ReadonlyArray<ShipStreamProgressEvent> = [
      ShipStreamProgressEvent.cases.StageStarted.make({
        runId: RUN_ID,
        attempt: ATTEMPT_1,
        stage: ShipStage.make("format-check"),
      }),
      ShipStreamProgressEvent.cases.StageFinished.make({
        runId: RUN_ID,
        attempt: ATTEMPT_1,
        progress: ShipStagePassed.make({
          stage: ShipStage.make("format-check"),
          durationMs: GateDurationMs.make(15),
        }),
      }),
    ]
    const deps: WorkflowCliDeps = {
      shipWorkflow: (_req, rpcOpts) => {
        for (const ev of events) {
          rpcOpts?.onProgress?.(ev)
        }
        return Effect.succeed(makePassedResponse())
      },
    }

    const stderrChunks: Array<string> = []
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
        return true
      })

    const humanRes = await Effect.runPromise(
      handleWorkflow(["workflow", "ship"], { repoRoot: dir }, deps),
    )
    expect(humanRes.exitCode).toBe(0)
    const humanStderr = stderrChunks.join("")
    expect(humanStderr).toContain(
      "[workflow:ship] wf-ship-cli-01 attempt=1 stage=format-check started\n",
    )
    expect(humanStderr).toContain(
      "[workflow:ship] wf-ship-cli-01 attempt=1 stage=format-check passed (15ms)\n",
    )

    stderrChunks.length = 0
    const jsonRes = await Effect.runPromise(
      handleWorkflow(["workflow", "ship", "--json"], { repoRoot: dir }, deps),
    )
    expect(jsonRes.exitCode).toBe(0)
    expect(stderrChunks).toHaveLength(0)
    writeSpy.mockRestore()
  })

  it("maps ShipWorkflow outcomes to exitCode 0 (Passed), 1 (Failed/clear/tree/restore/drift), and 2 (circuitBreaker tripped)", async () => {
    const { dir } = createTempGitRepo("harness-wf-ship-exitcodes-")

    const makeFailedResponse = (
      error:
        | ShipGateFailedError
        | ShipTreeMismatchError
        | MutationRestoreError
        | ShipTreeDriftError,
    ): WorkflowShipResponse => ({
      runId: RUN_ID,
      attempt: ATTEMPT_1,
      executionId: EXEC_ID,
      treeHash: TREE_HASH,
      runOrigin: "ephemeral",
      outcome: {
        _tag: "Failed",
        runId: RUN_ID,
        attempt: ATTEMPT_1,
        treeHash: TREE_HASH,
        stages: [],
        error,
      },
    })

    const clearErr = new ShipGateFailedError({
      stage: ShipStage.make("verify"),
      exitCode: GateExitCode.make(1),
      stderrSummary: GateStderrSummary.make("typecheck failed"),
      circuitBreakerStatus: "clear",
    })
    const mismatchErr = new ShipTreeMismatchError({
      stage: ShipStage.make("gc-strict"),
      expected: TREE_HASH,
      actual: OTHER_HASH,
    })
    const restoreErr = new MutationRestoreError({
      expected: TREE_HASH,
      actual: OTHER_HASH,
      detail: ShipFailureMessage.make("backup corrupt"),
    })
    const driftErr = new ShipTreeDriftError({
      stage: ShipStage.make("done"),
      expected: TREE_HASH,
      actual: OTHER_HASH,
    })
    const trippedErr = new ShipGateFailedError({
      stage: ShipStage.make("mutate-strict"),
      exitCode: GateExitCode.make(1),
      stderrSummary: GateStderrSummary.make("repeated failure"),
      circuitBreakerStatus: "tripped",
      escalationMessage: ShipFailureMessage.make(
        "Loop circuit breaker tripped — escalate to human",
      ),
    })
    const trippedNoMsgErr = new ShipGateFailedError({
      stage: ShipStage.make("mutate-strict"),
      exitCode: GateExitCode.make(1),
      stderrSummary: GateStderrSummary.make("repeated failure"),
      circuitBreakerStatus: "tripped",
    })

    for (const err of [clearErr, mismatchErr, restoreErr, driftErr]) {
      const res = await Effect.runPromise(
        handleWorkflow(
          ["workflow", "ship", "--json"],
          { repoRoot: dir },
          {
            shipWorkflow: () => Effect.succeed(makeFailedResponse(err)),
          },
        ),
      )
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain(err.message)
      expect(JSON.parse(res.stdout)).toMatchObject({
        outcome: { _tag: "Failed", error: { _tag: err._tag } },
      })
    }

    const trippedRes = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "ship"],
        { repoRoot: dir },
        {
          shipWorkflow: () => Effect.succeed(makeFailedResponse(trippedErr)),
        },
      ),
    )
    expect(trippedRes.exitCode).toBe(2)
    expect(trippedRes.stderr).toBe("Loop circuit breaker tripped — escalate to human\n")
    expect(JSON.parse(trippedRes.stdout)).toMatchObject({
      outcome: {
        _tag: "Failed",
        error: { _tag: "ShipGateFailedError", circuitBreakerStatus: "tripped" },
      },
    })

    const trippedFallback = formatWorkflowShipOutcome(makeFailedResponse(trippedNoMsgErr), true)
    expect(trippedFallback.exitCode).toBe(2)
    expect(trippedFallback.stderr).toBe(`${trippedNoMsgErr.message}\n`)
  })

  it("workflow status accepts --run and surfaces shipAttempts from daemon", async () => {
    const { dir, headSha } = createTempGitRepo("harness-wf-ship-status-")
    const shipAttempt = WorkflowShipAttemptRecord.make({
      shipKey: encodeShipAttemptKey(RUN_ID, ATTEMPT_1),
      runId: RUN_ID,
      attempt: ATTEMPT_1,
      treeHash: TREE_HASH,
      status: "passed",
      updatedMs: WorkflowTimestampMs.make(12345),
    })

    const summary = WorkflowStatusSummary.cases.Ready.make({
      writerLeaseEpoch: LeaseEpoch.make(1),
      outcome: WorkflowRunOutcome.cases.Active.make({
        run: {
          runId: RUN_ID,
          executionId: EXEC_ID,
          level: "slice",
          planSha: PlanSha256.make("a".repeat(64)),
          baseSha: headSha,
          state: WorkflowRunState.make("running"),
          updatedMs: WorkflowTimestampMs.make(12345),
        },
        units: [],
        attempts: [],
        pendingDeferreds: [],
        shipAttempts: [shipAttempt],
        projectionStatus: WorkflowProjectionStatus.make("fresh"),
      }),
    })

    let seenRunId: WorkflowRunId | undefined
    const res = await Effect.runPromise(
      runDeclarativeCli(["workflow", "status", "--run", RUN_ID, "--repo-root", dir, "--json"], {
        skipBackgroundDaemons: true,
        workflowDeps: {
          getWorkflowStatus: (req) => {
            seenRunId = req.runId
            return Effect.succeed(summary)
          },
        },
      }),
    )
    expect(res.exitCode).toBe(0)
    expect(seenRunId).toBe(RUN_ID)
    expect(JSON.parse(res.stdout)).toMatchObject({
      _tag: "Ready",
      outcome: {
        _tag: "Active",
        shipAttempts: [
          {
            shipKey: `${RUN_ID}#1`,
            runId: RUN_ID,
            attempt: 1,
            treeHash: TREE_HASH,
            status: "passed",
            updatedMs: 12345,
          },
        ],
      },
    })
  })

  it("formats compact vs pretty output and accepts explicit encodedPayload in formatWorkflowShipOutcome", () => {
    const response = makePassedResponse()
    const compact = formatWorkflowShipOutcome(response, true)
    expect(compact.exitCode).toBe(0)
    expect(compact.stdout.includes("\n")).toBe(false)
    expect(JSON.parse(compact.stdout)).toMatchObject({ runId: RUN_ID, outcome: { _tag: "Passed" } })

    const pretty = formatWorkflowShipOutcome(response, false)
    expect(pretty.exitCode).toBe(0)
    expect(pretty.stdout.includes("\n")).toBe(true)
    expect(pretty.stdout).toBe(
      JSON.stringify(Schema.encodeSync(WorkflowShipResponse)(response), null, 2),
    )

    const explicitEncoded: typeof WorkflowShipResponse.Encoded = {
      ...Schema.encodeSync(WorkflowShipResponse)(response),
      attempt: 99,
    }
    const withExplicit = formatWorkflowShipOutcome(response, true, explicitEncoded)
    expect(withExplicit.exitCode).toBe(0)
    expect(withExplicit.stdout.includes("\n")).toBe(false)
    expect(JSON.parse(withExplicit.stdout)).toMatchObject({ attempt: 99 })
  })

  it("parseWorkflowCliArgs handles --flag=val, omitted 'workflow' prefix, and rejects --flag --other and short -x", () => {
    const eqNoPrefix = parseWorkflowCliArgs(["ship", `--run=${RUN_ID}`, "--json"])
    match(eqNoPrefix)
      .with({ _tag: "Success" }, ({ success }) => {
        expect(success.action).toBe("ship")
        expect(success.flags).toEqual({
          values: { run: RUN_ID },
          rebuildViews: false,
          json: true,
        })
      })
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect.unreachable(`Expected Success, got Failure: ${failure.message}`)
      })
      .exhaustive()

    const flagAsValue = parseWorkflowCliArgs(["workflow", "ship", "--run", "--json"])
    match(flagAsValue)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure.message).toContain("Missing or empty value for '--run'")
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected Failure for --run --json")
      })
      .exhaustive()

    const shortFlag = parseWorkflowCliArgs(["workflow", "ship", "-x"])
    match(shortFlag)
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure.message).toContain("Unrecognized workflow flag '-x'")
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected Failure for -x")
      })
      .exhaustive()
  })
})
