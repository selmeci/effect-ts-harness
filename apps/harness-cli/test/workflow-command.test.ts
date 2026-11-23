import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  AttemptNumber,
  CompiledPlan,
  EscalationDecision,
  FrictionLogState,
  GateExitCode,
  GitCommitSha,
  GitCommonDirPath,
  LeaseEpoch,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PackageVerifyFailureDetail,
  PlanSha256,
  UnitAgentDispatchResult,
  UnitOutcome,
  UnitRejection,
  WaveIndex,
  WorkUnitId,
  WorkflowDoctorMode,
  WorkflowExecutionId,
  WorkflowProjectionStatus,
  WorkflowRebuiltRunCount,
  WorkflowRunId,
  WorkflowRunOutcome,
  WorkflowRunState,
  WorkflowStatusSummary,
  WorkflowStoreFailureReason,
  WorkflowTerminalError,
  WorkflowTimestampMs,
  WorkspaceFilePath,
  WorkspaceTreeHash,
  type WorkflowCompleteRequest,
  type WorkflowDoctorRequest,
  type WorkflowResumeRequest,
} from "@harness/contract"
import {
  UnixSocketDaemonLive,
  resolveWorkflowRuntimePaths,
  startScopedUnixSocketDaemon,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import { UnitAgentDispatcher } from "@harness/service"
import { runDeclarativeCli } from "../src/commands/declarative-cli.js"
import { handleWorkflow, type WorkflowCliDeps } from "../src/commands/workflow.command.js"

const tempDirs: Array<string> = []

afterEach(() => {
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
  writeFileSync(
    join(dir, "libs", "alpha", "src", "index.ts"),
    [
      'import { Effect } from "effect"',
      'import { stub } from "@harness/contract"',
      'export const runAlpha = Effect.fn("Alpha.run")(function* () {',
      '  return yield* stub<number>("harness:SPEC-0001", "REQ-1.1")',
      "})",
      "",
    ].join("\n"),
    "utf8",
  )
  execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8" })
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
  return { dir, headSha: GitCommitSha.make(sha) }
}

const makeSamplePlan = (baseSha: GitCommitSha): CompiledPlan => ({
  runId: WorkflowRunId.make("wf-cli-test-01"),
  level: "slice",
  planSha: PlanSha256.make("a".repeat(64)),
  baseSha,
  mode: { _tag: "Manual" },
  units: [
    {
      _tag: "PackageUnit",
      unitId: WorkUnitId.make("u-alpha"),
      projectName: NxProjectName.make("@harness/alpha"),
      waveIndex: WaveIndex.make(0),
      dependsOn: [],
      ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
      stubKeys: [],
      earsKeys: [],
      packageVerifyCommand: PackageVerifyCommand.make("pnpm nx run @harness/alpha:verify"),
    },
  ],
  sharedStepPaths: [],
})

const JsonRecordSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecord = Schema.decodeUnknownOption(JsonRecordSchema)

describe("harness workflow CLI subcommand (SPEC-0023 REQ-3.2)", () => {
  it("fails closed on missing or unknown subcommand action and unknown flags", async () => {
    const missing = await Effect.runPromise(handleWorkflow(["workflow"]))
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain("usage: harness workflow")

    const unknownAction = await Effect.runPromise(handleWorkflow(["workflow", "bogus", "--json"]))
    expect(unknownAction.exitCode).toBe(1)
    expect(JSON.parse(unknownAction.stdout)).toMatchObject({ ok: false })
    expect(unknownAction.stderr).toContain("Unknown workflow subcommand")

    const unknownFlag = await Effect.runPromise(
      handleWorkflow(["workflow", "status", "--bogus-flag"]),
    )
    expect(unknownFlag.exitCode).toBe(1)
    expect(unknownFlag.stderr).toContain("Unrecognized workflow flag")

    const declMissing = await Effect.runPromise(runDeclarativeCli(["workflow"]))
    expect(declMissing.exitCode).toBe(1)
    expect(declMissing.stderr).toContain("Missing workflow subcommand")
  })

  it("compile extracts workspace stubs or --input JSON and rejects invalid mode/concurrency combinations", async () => {
    const { dir, headSha } = createTempGitRepo("harness-wf-compile-")

    const stubCompile = await Effect.runPromise(
      runDeclarativeCli(["workflow", "compile", "--level", "slice", "--mode", "manual", "--json"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(stubCompile.exitCode).toBe(0)
    const decodedPlan = Schema.decodeSync(Schema.fromJsonString(CompiledPlan))(stubCompile.stdout)
    expect(decodedPlan.level).toBe("slice")
    expect(decodedPlan.baseSha).toBe(headSha)
    expect(decodedPlan.mode).toEqual({ _tag: "Manual" })
    expect(decodedPlan.units).toHaveLength(1)
    expect(decodedPlan.units[0]?.unitId).toBe(WorkUnitId.make("harness-alpha"))

    const inputPath = join(dir, "plan-input.json")
    writeFileSync(
      inputPath,
      JSON.stringify({
        runId: "wf-epic-test-01",
        units: [
          {
            _tag: "SliceUnit",
            unitId: "slice-a",
            branch: "slice/alpha-unit",
            ownedRelPaths: ["libs/alpha"],
            earsKeys: [],
          },
        ],
      }),
      "utf8",
    )

    const autoPlaceholderCompile = await Effect.runPromise(
      runDeclarativeCli(
        [
          "workflow",
          "compile",
          "--level",
          "epic",
          "--mode",
          "automatic",
          "--runner",
          "claude-code",
          "--max-concurrency",
          "2",
          "--input",
          inputPath,
        ],
        { repoRoot: dir, skipBackgroundDaemons: true },
      ),
    )
    expect(autoPlaceholderCompile.exitCode).toBe(1)
    expect(autoPlaceholderCompile.stderr).toContain("WF-5")

    const liveDispatcher = {
      runnerKind: "live" as const,
      dispatchUnit: () => Effect.succeed(UnitAgentDispatchResult.cases.Completed.make({})),
    }

    const autoEpicCompile = await Effect.runPromise(
      handleWorkflow(
        [
          "workflow",
          "compile",
          "--level",
          "epic",
          "--mode",
          "automatic",
          "--runner",
          "claude-code",
          "--max-concurrency",
          "2",
          "--input",
          inputPath,
        ],
        { repoRoot: dir },
      ).pipe(Effect.provideService(UnitAgentDispatcher, liveDispatcher)),
    )
    expect(autoEpicCompile.exitCode).toBe(0)
    const epicPlan = Schema.decodeSync(Schema.fromJsonString(CompiledPlan))(autoEpicCompile.stdout)
    expect(epicPlan.runId).toBe(WorkflowRunId.make("wf-epic-test-01"))
    expect(epicPlan.level).toBe("epic")
    expect(epicPlan.mode).toEqual({
      _tag: "Automatic",
      runner: "claude-code",
      maxConcurrency: 2,
    })

    // F-14.3: omitted CLI --level and --mode honor --input JSON; explicit CLI flags override JSON
    const inputWithLevelAndMode = join(dir, "plan-input-defaults.json")
    writeFileSync(
      inputWithLevelAndMode,
      JSON.stringify({
        runId: "wf-input-defaults-01",
        level: "epic",
        mode: { _tag: "Automatic", runner: "claude-code", maxConcurrency: 3 },
        units: [
          {
            _tag: "SliceUnit",
            unitId: "slice-a",
            branch: "slice/alpha-unit",
            ownedRelPaths: ["libs/alpha"],
            earsKeys: [],
          },
        ],
      }),
      "utf8",
    )
    const fromInputJson = await Effect.runPromise(
      handleWorkflow(["workflow", "compile", "--input", inputWithLevelAndMode], {
        repoRoot: dir,
      }).pipe(Effect.provideService(UnitAgentDispatcher, liveDispatcher)),
    )
    expect(fromInputJson.exitCode).toBe(0)
    const inputDefaultsPlan = Schema.decodeSync(Schema.fromJsonString(CompiledPlan))(
      fromInputJson.stdout,
    )
    expect(inputDefaultsPlan.level).toBe("epic")
    expect(inputDefaultsPlan.mode).toEqual({
      _tag: "Automatic",
      runner: "claude-code",
      maxConcurrency: 3,
    })

    const fromInputPlaceholderErr = await Effect.runPromise(
      handleWorkflow(["workflow", "compile", "--input", inputWithLevelAndMode], {
        repoRoot: dir,
      }),
    )
    expect(fromInputPlaceholderErr.exitCode).toBe(1)
    expect(fromInputPlaceholderErr.stderr).toContain("WF-5")

    const cliOverrideJson = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "compile", "--mode", "manual", "--input", inputWithLevelAndMode],
        { repoRoot: dir },
      ),
    )
    expect(cliOverrideJson.exitCode).toBe(0)
    const overriddenPlan = Schema.decodeSync(Schema.fromJsonString(CompiledPlan))(
      cliOverrideJson.stdout,
    )
    expect(overriddenPlan.level).toBe("epic")
    expect(overriddenPlan.mode).toEqual({ _tag: "Manual" })

    // F-17.1: workflow start rejects Automatic plan fail-closed when placeholder dispatcher is active
    const autoPlanJson = JSON.stringify(Schema.encodeSync(CompiledPlan)(epicPlan))
    const autoStartPlaceholder = await Effect.runPromise(
      handleWorkflow(["workflow", "start"], { repoRoot: dir, stdin: autoPlanJson }),
    )
    expect(autoStartPlaceholder.exitCode).toBe(1)
    expect(autoStartPlaceholder.stderr).toContain("WF-5")

    const manualWithRunner = await Effect.runPromise(
      handleWorkflow(["workflow", "compile", "--mode", "manual", "--runner", "claude-code"], {
        repoRoot: dir,
      }),
    )
    expect(manualWithRunner.exitCode).toBe(1)
    expect(manualWithRunner.stderr).toContain("--mode automatic")

    const autoMissingRunner = await Effect.runPromise(
      handleWorkflow(["workflow", "compile", "--mode", "automatic"], { repoRoot: dir }),
    )
    expect(autoMissingRunner.exitCode).toBe(1)
    expect(autoMissingRunner.stderr).toContain("requires --runner")

    const badConcurrency = await Effect.runPromise(
      handleWorkflow(
        [
          "workflow",
          "compile",
          "--mode",
          "automatic",
          "--runner",
          "antigravity",
          "--max-concurrency",
          "9",
        ],
        { repoRoot: dir },
      ),
    )
    expect(badConcurrency.exitCode).toBe(1)
    expect(badConcurrency.stderr).toContain("--max-concurrency")
  })

  it("complete enforces explicit absolute --repo-root, unambiguous --unit/--phase, rejection exit codes, and cleared friction log", async () => {
    const { dir, headSha } = createTempGitRepo("harness-wf-complete-")
    const runId = WorkflowRunId.make("wf-complete-01")
    const executionId = WorkflowExecutionId.make("wf-complete-01")
    const completeRequests: Array<WorkflowCompleteRequest> = []

    const makeDeps = (outcome: UnitOutcome): WorkflowCliDeps => ({
      completeWorkflow: (req) => {
        completeRequests.push(req)
        return Effect.succeed(
          match(req)
            .with({ _tag: "CompleteUnit" }, () => ({
              _tag: "UnitCompleted" as const,
              runId,
              executionId,
              outcome,
            }))
            .with({ _tag: "CompleteLlmPhase" }, () => ({
              _tag: "LlmPhaseCompleted" as const,
              runId,
              executionId,
              receipt: {
                workspaceHash: WorkspaceTreeHash.make("b".repeat(64)),
                frictionLogCleared: FrictionLogState.make("cleared"),
              },
            }))
            .exhaustive(),
        )
      },
    })

    const okOutcome = UnitOutcome.cases.Completed.make({
      unitId: WorkUnitId.make("u-alpha"),
      attempt: AttemptNumber.make(1),
      changedPaths: [OwnedRelPath.make("libs/alpha/src/index.ts")],
      packageStampHash: PackageStampHash.make("c".repeat(64)),
    })

    // Missing --repo-root fails closed even when options.repoRoot is set
    const missingRoot = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "complete", "--unit", "u-alpha"],
        { repoRoot: dir },
        makeDeps(okOutcome),
      ),
    )
    expect(missingRoot.exitCode).toBe(1)
    expect(missingRoot.stderr).toContain("explicit absolute --repo-root")
    expect(completeRequests).toHaveLength(0)

    // Relative --repo-root fails closed
    const relativeRoot = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "complete", "--unit", "u-alpha", "--repo-root", "./relative/path"],
        { repoRoot: dir },
        makeDeps(okOutcome),
      ),
    )
    expect(relativeRoot.exitCode).toBe(1)
    expect(relativeRoot.stderr).toContain("explicit absolute path")
    expect(completeRequests).toHaveLength(0)

    // Both --unit and --phase fails closed
    const bothFlags = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "complete", "--unit", "u-alpha", "--phase", "llm", "--repo-root", dir],
        undefined,
        makeDeps(okOutcome),
      ),
    )
    expect(bothFlags.exitCode).toBe(1)
    expect(bothFlags.stderr).toContain("not both")

    // Neither --unit nor --phase fails closed
    const neitherFlag = await Effect.runPromise(
      handleWorkflow(["workflow", "complete", "--repo-root", dir], undefined, makeDeps(okOutcome)),
    )
    expect(neitherFlag.exitCode).toBe(1)
    expect(neitherFlag.stderr).toContain("either --unit <id> or --phase llm")

    // Invalid --phase fails closed
    const badPhase = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "complete", "--phase", "invalid", "--repo-root", dir],
        undefined,
        makeDeps(okOutcome),
      ),
    )
    expect(badPhase.exitCode).toBe(1)
    expect(badPhase.stderr).toContain("Invalid --phase")

    // Unit Rejected propagates exit code 1 with structured JSON
    const rejectedOutcome = UnitOutcome.cases.Rejected.make({
      unitId: WorkUnitId.make("u-alpha"),
      attempt: AttemptNumber.make(1),
      rejection: UnitRejection.cases.WriteSetViolation.make({
        offendingPaths: [OwnedRelPath.make("libs/beta/src/bad.ts")],
      }),
    })
    const rejectedRes = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "complete", "--unit", "u-alpha", "--repo-root", dir, "--json"],
        undefined,
        makeDeps(rejectedOutcome),
      ),
    )
    expect(rejectedRes.exitCode).toBe(1)
    expect(rejectedRes.stderr).toContain("WriteSetViolation")
    expect(JSON.parse(rejectedRes.stdout)).toMatchObject({
      _tag: "UnitCompleted",
      outcome: { _tag: "Rejected" },
    })

    // F-18.2: PackageVerifyFailed summary includes failureKind and bounded detail
    const verifyFailedOutcome = UnitOutcome.cases.Rejected.make({
      unitId: WorkUnitId.make("u-alpha"),
      attempt: AttemptNumber.make(2),
      rejection: UnitRejection.cases.PackageVerifyFailed.make({
        exitCode: GateExitCode.make(124),
        failureKind: "timed-out",
        detail: PackageVerifyFailureDetail.make("Timed out running nx verify"),
      }),
    })
    const verifyFailedRes = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "complete", "--unit", "u-alpha", "--repo-root", dir, "--json"],
        undefined,
        makeDeps(verifyFailedOutcome),
      ),
    )
    expect(verifyFailedRes.exitCode).toBe(1)
    expect(verifyFailedRes.stderr).toContain("failureKind=timed-out")
    expect(verifyFailedRes.stderr).toContain("Timed out running nx verify")

    // shared-step completion passes WorkUnitId("shared-step")
    const sharedRes = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "complete", "--unit", "shared-step", "--repo-root", dir],
        undefined,
        makeDeps(okOutcome),
      ),
    )
    expect(sharedRes.exitCode).toBe(0)
    expect(completeRequests[completeRequests.length - 1]).toEqual({
      _tag: "CompleteUnit",
      repoRoot: dir,
      unitId: "shared-step",
    })

    // Dirty friction log blocks complete --phase llm
    mkdirSync(join(dir, ".harness"), { recursive: true })
    writeFileSync(
      join(dir, ".harness", "friction-log.jsonl"),
      JSON.stringify({
        kind: "verify_failure",
        timestamp: new Date().toISOString(),
        summary: "nx failed",
        detail: "exit 1",
      }) + "\n",
      "utf8",
    )
    const dirtyCountBefore = completeRequests.length
    const dirtyLlmRes = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "complete", "--phase", "llm", "--repo-root", dir],
        undefined,
        makeDeps(okOutcome),
      ),
    )
    expect(dirtyLlmRes.exitCode).toBe(1)
    expect(dirtyLlmRes.stderr).toContain("Friction log is not cleared")
    expect(JSON.parse(dirtyLlmRes.stdout)).toMatchObject({
      ok: false,
      code: "DIRTY_FRICTION_LOG",
      frictionCount: 1,
    })
    expect(completeRequests).toHaveLength(dirtyCountBefore)

    // Cleared friction log allows complete --phase llm
    writeFileSync(join(dir, ".harness", "friction-log.jsonl"), "", "utf8")
    const cleanLlmRes = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "complete", "--phase", "llm", "--repo-root", dir, "--run-id", runId],
        undefined,
        makeDeps(okOutcome),
      ),
    )
    expect(cleanLlmRes.exitCode).toBe(0)
    expect(JSON.parse(cleanLlmRes.stdout)).toMatchObject({
      _tag: "LlmPhaseCompleted",
      runId,
      receipt: { frictionLogCleared: "cleared" },
    })
    expect(headSha.length).toBe(40)
  })

  it("resume and doctor validate flags cleanly (partial escalation flags rejected, retry/abort/rebuild-views forwarded)", async () => {
    const { dir } = createTempGitRepo("harness-wf-resume-doctor-")
    const runId = WorkflowRunId.make("wf-resume-01")
    const executionId = WorkflowExecutionId.make("wf-resume-01")
    const resumeRequests: Array<WorkflowResumeRequest> = []
    const doctorRequests: Array<WorkflowDoctorRequest> = []

    const deps: WorkflowCliDeps = {
      resumeWorkflow: (req) => {
        resumeRequests.push(req)
        return Effect.succeed(
          match(req)
            .with({ _tag: "ResolveEscalation" }, (r) => ({
              _tag: "EscalationResolved" as const,
              runId: r.runId,
              executionId,
              unitId: r.unitId,
              decision: r.decision,
            }))
            .with({ _tag: "ResumeRun" }, (r) => ({
              _tag: "WorkflowResumed" as const,
              runId: r.runId,
              executionId,
            }))
            .exhaustive(),
        )
      },
      doctorWorkflow: (req) => {
        doctorRequests.push(req)
        return Effect.succeed({
          repoRoot: req.repoRoot,
          commonGitDir: GitCommonDirPath.make(join(dir, ".git")),
          writerLeaseEpoch: LeaseEpoch.make(1),
          rebuiltRunCount: WorkflowRebuiltRunCount.make(req.mode === "rebuild" ? 3 : 0),
          checks: [],
        })
      },
    }

    const partialUnitOnly = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "resume", "--run-id", runId, "--unit", "u-alpha"],
        { repoRoot: dir },
        deps,
      ),
    )
    expect(partialUnitOnly.exitCode).toBe(1)
    expect(partialUnitOnly.stderr).toContain("both --unit <id> and --decision")

    const partialDecisionOnly = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "resume", "--run-id", runId, "--decision", "retry"],
        { repoRoot: dir },
        deps,
      ),
    )
    expect(partialDecisionOnly.exitCode).toBe(1)
    expect(partialDecisionOnly.stderr).toContain("both --unit <id> and --decision")

    const badDecision = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "resume", "--run-id", runId, "--unit", "u-alpha", "--decision", "skip"],
        { repoRoot: dir },
        deps,
      ),
    )
    expect(badDecision.exitCode).toBe(1)
    expect(badDecision.stderr).toContain("Invalid --decision")

    const plainResume = await Effect.runPromise(
      handleWorkflow(["workflow", "resume", "--run-id", runId], { repoRoot: dir }, deps),
    )
    expect(plainResume.exitCode).toBe(0)
    expect(JSON.parse(plainResume.stdout)).toMatchObject({ _tag: "WorkflowResumed", runId })

    const retryRes = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "resume", "--run-id", runId, "--unit", "u-alpha", "--decision", "retry"],
        { repoRoot: dir },
        deps,
      ),
    )
    expect(retryRes.exitCode).toBe(0)
    expect(JSON.parse(retryRes.stdout)).toMatchObject({
      _tag: "EscalationResolved",
      unitId: "u-alpha",
      decision: "retry",
    })

    const abortEscRes = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "resume", "--run-id", runId, "--unit", "u-alpha", "--decision", "abort"],
        { repoRoot: dir },
        deps,
      ),
    )
    expect(abortEscRes.exitCode).toBe(0)
    expect(JSON.parse(abortEscRes.stdout)).toMatchObject({
      _tag: "EscalationResolved",
      decision: "abort",
    })

    const doctorCheck = await Effect.runPromise(
      handleWorkflow(["workflow", "doctor"], { repoRoot: dir }, deps),
    )
    expect(doctorCheck.exitCode).toBe(0)
    expect(doctorRequests[0]?.mode).toBe(WorkflowDoctorMode.make("check-only"))

    const doctorRebuild = await Effect.runPromise(
      handleWorkflow(["workflow", "doctor", "--rebuild-views"], { repoRoot: dir }, deps),
    )
    expect(doctorRebuild.exitCode).toBe(0)
    expect(doctorRequests[1]?.mode).toBe(WorkflowDoctorMode.make("rebuild"))
    expect(JSON.parse(doctorRebuild.stdout)).toMatchObject({ rebuiltRunCount: 3 })

    const doctorModeRebuild = await Effect.runPromise(
      runDeclarativeCli(["workflow", "doctor", "--mode=rebuild"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
        workflowDeps: deps,
      }),
    )
    expect(doctorModeRebuild.exitCode).toBe(0)
    expect(doctorRequests[2]?.mode).toBe(WorkflowDoctorMode.make("rebuild"))

    const doctorBadMode = await Effect.runPromise(
      handleWorkflow(["workflow", "doctor", "--mode", "bogus"], { repoRoot: dir }, deps),
    )
    expect(doctorBadMode.exitCode).toBe(1)
    expect(doctorBadMode.stderr).toContain("Invalid --mode")

    const missingRunIdResume = await Effect.runPromise(
      handleWorkflow(["workflow", "resume"], { repoRoot: dir }, deps),
    )
    expect(missingRunIdResume.exitCode).toBe(1)
    expect(missingRunIdResume.stderr).toContain("requires --run-id")

    const missingRunIdAbort = await Effect.runPromise(
      handleWorkflow(["workflow", "abort"], { repoRoot: dir }, deps),
    )
    expect(missingRunIdAbort.exitCode).toBe(1)
    expect(missingRunIdAbort.stderr).toContain("requires --run-id")

    const emptyStdinStart = await Effect.runPromise(
      handleWorkflow(["workflow", "start"], { repoRoot: dir, stdin: "   " }, deps),
    )
    expect(emptyStdinStart.exitCode).toBe(1)
    expect(emptyStdinStart.stderr).toContain("requires --plan")

    const missingPlanFileStart = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "start", "--plan", join(dir, "does-not-exist.json")],
        { repoRoot: dir },
        deps,
      ),
    )
    expect(missingPlanFileStart.exitCode).toBe(1)
    expect(missingPlanFileStart.stderr).toContain("Failed to read plan file")
  })

  const makeWorkflowIpcLineHandler =
    (
      plan: ReturnType<typeof makeSamplePlan>,
      dir: string,
      commonGitDir: string,
      receivedCommands: Array<{ readonly command: string; readonly repoRoot: unknown }>,
    ) =>
    (line: string) => {
      const parsedOpt = decodeJsonRecord(line)
      const rec = match(parsedOpt)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => ({}) as Readonly<Record<string, unknown>>)
        .exhaustive()
      const id = typeof rec["id"] === "string" ? rec["id"] : ""
      const command = typeof rec["command"] === "string" ? rec["command"] : ""
      if (command !== "workflow.handshake") {
        receivedCommands.push({ command, repoRoot: rec["repoRoot"] })
      }
      const executionId = WorkflowExecutionId.make(plan.runId)
      const reply = match(command)
        .with("workflow.handshake", () => ({
          id,
          ok: true,
          command,
          handshake: {
            protocolVersion: "1",
            capabilities: [
              "workflow.handshake",
              "workflow.start",
              "workflow.status",
              "workflow.complete",
              "workflow.resume",
              "workflow.abort",
              "workflow.doctor",
            ],
            repoRoot: rec["repoRoot"] ?? dir,
            commonGitDir,
            writerLeaseEpoch: 1,
          },
        }))
        .with("workflow.start", () => ({
          id,
          ok: true,
          result: { runId: plan.runId, executionId, outcome: "started" },
        }))
        .with("workflow.status", () => ({
          id,
          ok: true,
          result: {
            _tag: "Ready",
            writerLeaseEpoch: 1,
            outcome: { _tag: "NotFound" },
          },
        }))
        .with("workflow.complete", () => ({
          id,
          ok: true,
          result: {
            _tag: "UnitCompleted",
            runId: plan.runId,
            executionId,
            outcome: {
              _tag: "Completed",
              unitId: "u-alpha",
              attempt: 1,
              changedPaths: ["libs/alpha/src/index.ts"],
              packageStampHash: "e".repeat(64),
            },
          },
        }))
        .with("workflow.resume", () => ({
          id,
          ok: true,
          result: {
            _tag: "EscalationResolved",
            runId: plan.runId,
            executionId,
            unitId: "u-alpha",
            decision: EscalationDecision.make("retry"),
          },
        }))
        .with("workflow.doctor", () => ({
          id,
          ok: true,
          result: {
            repoRoot: dir,
            commonGitDir,
            writerLeaseEpoch: 1,
            rebuiltRunCount: 1,
            checks: [],
          },
        }))
        .with("workflow.abort", () => ({
          id,
          ok: true,
          result: { runId: plan.runId, executionId, state: "aborted" },
        }))
        .otherwise(() => ({ id, ok: false, error: `Unexpected command ${command}` }))
      return Effect.succeed(JSON.stringify(reply))
    }

  it("routes start, status, complete (linked worktree), resume, doctor, and abort end-to-end over real daemon Unix socket IPC", async () => {
    const { dir, headSha } = createTempGitRepo("harness-wf-ipc-")
    const worktreeDirRaw = join(
      mkdtempSync(join(tmpdir(), "harness-wf-linked-wt-")),
      "linked-alpha",
    )
    tempDirs.push(worktreeDirRaw.slice(0, worktreeDirRaw.lastIndexOf("/")))
    execFileSync("git", ["worktree", "add", "-b", "slice/alpha-unit", worktreeDirRaw], {
      cwd: dir,
      encoding: "utf8",
    })
    const linkedWorktreeDir = realpathSync.native(worktreeDirRaw)

    const plan = makeSamplePlan(headSha)
    const encodedPlanJson = JSON.stringify(Schema.encodeSync(CompiledPlan)(plan))
    const planPath = join(dir, "compiled-plan.json")
    writeFileSync(planPath, encodedPlanJson, "utf8")

    const validatedCanonical = await Effect.runPromise(
      validateWorktreeRepoRoot(AbsoluteRepoRoot.make(dir)),
    )
    const { socketPath } = resolveWorkflowRuntimePaths(validatedCanonical.commonGitDir)
    const receivedCommands: Array<{ readonly command: string; readonly repoRoot: unknown }> = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(dir), {
            lineHandler: makeWorkflowIpcLineHandler(
              plan,
              dir,
              validatedCanonical.commonGitDir,
              receivedCommands,
            ),
          })

          const startStdinRes = yield* runDeclarativeCli(["workflow", "start", "--json"], {
            repoRoot: dir,
            stdin: encodedPlanJson,
            skipBackgroundDaemons: true,
          })
          expect(startStdinRes.exitCode).toBe(0)
          expect(JSON.parse(startStdinRes.stdout)).toMatchObject({
            runId: plan.runId,
            outcome: "started",
          })

          const startRes = yield* runDeclarativeCli(
            ["workflow", "start", "--plan", planPath, "--json"],
            { repoRoot: dir, skipBackgroundDaemons: true },
          )
          expect(startRes.exitCode).toBe(0)
          expect(JSON.parse(startRes.stdout)).toMatchObject({
            runId: plan.runId,
            outcome: "started",
          })

          const statusRes = yield* runDeclarativeCli(
            ["workflow", "status", "--run-id", plan.runId, "--repo-root", dir, "--json"],
            { repoRoot: dir, skipBackgroundDaemons: true },
          )
          expect(statusRes.exitCode).toBe(0)
          expect(JSON.parse(statusRes.stdout)).toMatchObject({
            _tag: "Ready",
            writerLeaseEpoch: 1,
            outcome: { _tag: "NotFound" },
          })

          const completeLinkedRes = yield* runDeclarativeCli(
            [
              "workflow",
              "complete",
              "--unit",
              "u-alpha",
              "--repo-root",
              linkedWorktreeDir,
              "--json",
            ],
            { skipBackgroundDaemons: true },
          )
          expect(completeLinkedRes.exitCode).toBe(0)
          expect(JSON.parse(completeLinkedRes.stdout)).toMatchObject({
            _tag: "UnitCompleted",
            outcome: { _tag: "Completed", unitId: "u-alpha" },
          })

          const resumeRes = yield* runDeclarativeCli(
            [
              "workflow",
              "resume",
              "--run-id",
              plan.runId,
              "--unit",
              "u-alpha",
              "--decision",
              "retry",
              "--json",
            ],
            { repoRoot: dir, skipBackgroundDaemons: true },
          )
          expect(resumeRes.exitCode).toBe(0)
          expect(JSON.parse(resumeRes.stdout)).toMatchObject({
            _tag: "EscalationResolved",
            decision: "retry",
          })

          const doctorRes = yield* runDeclarativeCli(
            ["workflow", "doctor", "--rebuild-views", "--json"],
            { repoRoot: dir, skipBackgroundDaemons: true },
          )
          expect(doctorRes.exitCode).toBe(0)
          expect(JSON.parse(doctorRes.stdout)).toMatchObject({ rebuiltRunCount: 1 })

          const abortRes = yield* runDeclarativeCli(
            ["workflow", "abort", "--run-id", plan.runId, "--json"],
            { repoRoot: dir, skipBackgroundDaemons: true },
          )
          expect(abortRes.exitCode).toBe(0)
          expect(JSON.parse(abortRes.stdout)).toMatchObject({ state: "aborted" })
        }),
      ).pipe(Effect.provide(UnixSocketDaemonLive)),
    )

    expect(socketPath.endsWith("/harness/daemon.sock")).toBe(true)
    expect(receivedCommands).toEqual([
      { command: "workflow.start", repoRoot: dir },
      { command: "workflow.start", repoRoot: dir },
      { command: "workflow.status", repoRoot: dir },
      { command: "workflow.complete", repoRoot: linkedWorktreeDir },
      { command: "workflow.resume", repoRoot: dir },
      { command: "workflow.doctor", repoRoot: dir },
      { command: "workflow.abort", repoRoot: dir },
    ])
  })

  it("status preserves typed WorkflowTerminalError._tag (F-15.1)", async () => {
    const { dir, headSha } = createTempGitRepo("harness-wf-status-tag-")
    const runId = WorkflowRunId.make("wf-status-err-01")
    const executionId = WorkflowExecutionId.make("wf-status-err-01")

    const summary = WorkflowStatusSummary.cases.Ready.make({
      writerLeaseEpoch: LeaseEpoch.make(2),
      outcome: WorkflowRunOutcome.cases.Failed.make({
        run: {
          runId,
          executionId,
          level: "slice",
          planSha: PlanSha256.make("a".repeat(64)),
          baseSha: headSha,
          state: WorkflowRunState.make("aborted"),
          updatedMs: WorkflowTimestampMs.make(100),
        },
        units: [],
        attempts: [],
        pendingDeferreds: [],
        terminalError: WorkflowTerminalError.cases.Interrupted.make({
          reason: WorkflowStoreFailureReason.make("Operator interrupted execution"),
        }),
        projectionStatus: WorkflowProjectionStatus.make("fresh"),
      }),
    })

    const res = await Effect.runPromise(
      handleWorkflow(
        ["workflow", "status", "--run-id", runId, "--json"],
        { repoRoot: dir },
        {
          getWorkflowStatus: () => Effect.succeed(summary),
        },
      ),
    )
    expect(res.exitCode).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({
      _tag: "Ready",
      writerLeaseEpoch: 2,
      outcome: {
        _tag: "Failed",
        terminalError: {
          _tag: "Interrupted",
          reason: "Operator interrupted execution",
        },
      },
    })
  })
})
