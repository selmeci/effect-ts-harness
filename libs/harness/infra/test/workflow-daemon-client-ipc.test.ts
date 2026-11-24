import { realpathSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  CompiledPlan,
  EscalationDecision,
  FrictionLogState,
  GitCommonDirPath,
  LeaseEpoch,
  PlanSha256,
  WorkUnitId,
  WorkflowDoctorMode,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkspaceFilePath,
  WorkspaceTreeHash,
} from "@harness/contract"
import {
  UnixSocketDaemonLive,
  abortWorkflowViaDaemon,
  completeWorkflowViaDaemon,
  doctorWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  resumeWorkflowViaDaemon,
  startScopedUnixSocketDaemon,
  startWorkflowViaDaemon,
} from "../src/index.js"
import { resolveWorkflowRuntimePaths } from "../src/worktree-repo-root.js"
import {
  withTempDir,
  initGitRepo,
  makePackageUnit,
  decodeJsonLine,
} from "./helpers/workflow-verifier-fixture.js"

describe("DaemonClient WF-3 IPC", () => {
  it.live("performs handshake capability checks and decodes typed RPC responses", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot, baseSha } = initGitRepo(dir)
        const commonGitDir = GitCommonDirPath.make(realpathSync.native(join(repoRoot, ".git")))
        const { socketPath } = resolveWorkflowRuntimePaths(commonGitDir)

        const samplePlan: CompiledPlan = {
          runId: WorkflowRunId.make("run-ipc-0001"),
          level: "slice",
          planSha: PlanSha256.make("c".repeat(64)),
          baseSha,
          mode: { _tag: "Manual" },
          units: [makePackageUnit({ unitId: "u-alpha" })],
          sharedStepPaths: [],
        }

        const runId = WorkflowRunId.make("run-ipc-0001")
        const executionId = WorkflowExecutionId.make("run-ipc-0001")

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
              lineHandler: (line: string) => {
                const parsed = decodeJsonLine(line)
                const id = parsed.id ?? ""
                const command = parsed.command ?? ""
                const response = match(command)
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
                      repoRoot,
                      commonGitDir,
                      writerLeaseEpoch: 1,
                    },
                  }))
                  .with("workflow.start", () => ({
                    id,
                    ok: true,
                    result: { runId, executionId, outcome: "started" },
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
                      _tag: "LlmPhaseCompleted",
                      runId,
                      executionId,
                      receipt: {
                        workspaceHash: WorkspaceTreeHash.make("d".repeat(64)),
                        frictionLogCleared: FrictionLogState.make("cleared"),
                      },
                    },
                  }))
                  .with("workflow.resume", () => ({
                    id,
                    ok: true,
                    result: {
                      _tag: "EscalationResolved",
                      runId,
                      executionId,
                      unitId: WorkUnitId.make("u-alpha"),
                      decision: EscalationDecision.make("retry"),
                    },
                  }))
                  .with("workflow.abort", () => ({
                    id,
                    ok: true,
                    result: { runId, executionId, state: "aborted" },
                  }))
                  .with("workflow.doctor", () => ({
                    id,
                    ok: true,
                    result: {
                      repoRoot,
                      commonGitDir,
                      writerLeaseEpoch: 1,
                      rebuiltRunCount: 2,
                      checks: [],
                    },
                  }))
                  .otherwise(() => ({ id, ok: false, error: `Unknown command ${command}` }))
                return Effect.succeed(JSON.stringify(response))
              },
            })

            const startRes = yield* startWorkflowViaDaemon(
              { repoRoot, plan: samplePlan },
              { socketPath },
            )
            expect(startRes).toEqual({ runId, executionId, outcome: "started" })

            const statusRes = yield* getWorkflowStatusViaDaemon({ repoRoot, runId }, { socketPath })
            expect(statusRes._tag).toBe("Ready")
            match(statusRes)
              .with({ _tag: "Ready" }, (ready) => {
                expect(ready.writerLeaseEpoch).toBe(LeaseEpoch.make(1))
                expect(ready.outcome._tag).toBe("NotFound")
              })
              .with({ _tag: "DaemonOffline" }, { _tag: "StorePaused" }, () => {
                expect.unreachable("Expected Ready status")
              })
              .exhaustive()

            const completeRes = yield* completeWorkflowViaDaemon(
              { _tag: "CompleteLlmPhase", repoRoot, runId },
              { socketPath },
            )
            expect(completeRes._tag).toBe("LlmPhaseCompleted")

            const resumeRes = yield* resumeWorkflowViaDaemon(
              {
                _tag: "ResolveEscalation",
                repoRoot,
                runId,
                unitId: WorkUnitId.make("u-alpha"),
                decision: EscalationDecision.make("retry"),
              },
              { socketPath },
            )
            expect(resumeRes._tag).toBe("EscalationResolved")

            const abortRes = yield* abortWorkflowViaDaemon({ repoRoot, runId }, { socketPath })
            expect(abortRes.state).toBe("aborted")

            const doctorRes = yield* doctorWorkflowViaDaemon(
              { repoRoot, mode: WorkflowDoctorMode.make("rebuild") },
              { socketPath },
            )
            expect(doctorRes.rebuiltRunCount).toBe(2)
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive))
      }),
    ),
  )
})
