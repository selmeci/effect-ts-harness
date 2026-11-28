import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Option } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  CompiledPlan,
  GitCommitSha,
  OmnigraphBranchName,
  OwnedRelPath,
  SliceBranchName,
  WaveIndex,
  WorkUnitId,
  WorkflowProjectionStatus,
  WorkflowRunId,
} from "@harness/contract"
import {
  nodeSyncHostIo,
  provisionWorkflowWorktreesImpl,
  readWorkflowProjectionStatuses,
  resolveWorkflowProjectionStatusPath,
  resolveWorkflowRuntimePaths,
  validateWorktreeRepoRoot,
  writeWorkflowProjectionStatus,
} from "../src/index.js"
import { PLAN_SHA, makeAlphaPlan } from "./helpers/workflow-projector-test-helpers.js"

describe("WF-6 Worktree implBranch & WorkflowProjectionStatusStore", () => {
  it.effect(
    "F-1.1: provisionWorkflowWorktreesImpl populates implBranch for both slice and epic plans",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => realpathSync.native(mkdtempSync(join(tmpdir(), "wf6-wt-impl-")))),
        (tmpRoot) =>
          Effect.gen(function* () {
            const repoDir = join(tmpRoot, "repo")
            mkdirSync(join(repoDir, "libs", "alpha", "src"), { recursive: true })
            execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
            execFileSync("git", ["config", "user.email", "wf6@example.com"], {
              cwd: repoDir,
              stdio: "ignore",
            })
            execFileSync("git", ["config", "user.name", "WF6 Test"], {
              cwd: repoDir,
              stdio: "ignore",
            })
            writeFileSync(join(repoDir, "libs", "alpha", "src", "index.ts"), "export const a = 1\n")
            execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
            execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" })
            execFileSync("git", ["checkout", "-b", "feat/wf6-impl"], {
              cwd: repoDir,
              stdio: "ignore",
            })
            const baseSha = GitCommitSha.make(
              execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim(),
            )
            const repoRoot = AbsoluteRepoRoot.make(realpathSync.native(repoDir))
            const envHostIo = { ...nodeSyncHostIo, getEnv: () => ({}) }

            const sliceDerivedPlan: CompiledPlan = {
              runId: WorkflowRunId.make("run-wt-slice-derived"),
              level: "slice",
              planSha: PLAN_SHA,
              baseSha,
              mode: { _tag: "Manual" },
              units: [
                makeAlphaPlan(WorkflowRunId.make("run-wt-slice-derived"), WorkUnitId.make("u-a"))
                  .units[0]!,
              ],
              sharedStepPaths: [],
            }
            const sliceDerivedReceipt = yield* provisionWorkflowWorktreesImpl(sliceDerivedPlan, {
              repoRoot,
              hostIo: envHostIo,
              env: {},
            })
            expect(sliceDerivedReceipt.implBranch).toBe("impl/branch-feat_wf6-impl")

            const explicitBranch = OmnigraphBranchName.make("impl/explicit-plan-branch")
            const sliceExplicitReceipt = yield* provisionWorkflowWorktreesImpl(
              { ...sliceDerivedPlan, implBranch: explicitBranch },
              { repoRoot, hostIo: envHostIo, env: {} },
            )
            expect(sliceExplicitReceipt.implBranch).toBe(explicitBranch)

            const epicPlan: CompiledPlan = {
              runId: WorkflowRunId.make("run-wt-epic-derived"),
              level: "epic",
              planSha: PLAN_SHA,
              baseSha,
              mode: { _tag: "Manual" },
              units: [
                {
                  _tag: "SliceUnit",
                  unitId: WorkUnitId.make("s-alpha"),
                  branch: SliceBranchName.make("slice/epic-alpha"),
                  waveIndex: WaveIndex.make(0),
                  dependsOn: [],
                  ownedRelPaths: [OwnedRelPath.make("libs/alpha")],
                  earsKeys: [],
                },
              ],
              sharedStepPaths: [],
            }
            const epicReceipt = yield* provisionWorkflowWorktreesImpl(epicPlan, {
              repoRoot,
              hostIo: envHostIo,
              env: {},
            })
            expect(epicReceipt.implBranch).toBe("impl/branch-feat_wf6-impl")
          }),
        (tmpRoot) => Effect.sync(() => rmSync(tmpRoot, { recursive: true, force: true })),
      ),
  )

  it.effect(
    "F-3.1: WorkflowProjectionStatusStore resolves git-common-dir & .harness paths, enforces 0o600, and rejects symlinks & corrupt JSON",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => realpathSync.native(mkdtempSync(join(tmpdir(), "wf6-store-sec-")))),
        (tmpRoot) =>
          Effect.gen(function* () {
            // 1. Git repo uses <git-common-dir>/harness/workflow-projection-status.json
            const gitDir = join(tmpRoot, "git-repo")
            mkdirSync(gitDir, { recursive: true })
            execFileSync("git", ["init"], { cwd: gitDir, stdio: "ignore" })
            execFileSync("git", ["config", "user.email", "wf6@example.com"], {
              cwd: gitDir,
              stdio: "ignore",
            })
            execFileSync("git", ["config", "user.name", "WF6 Test"], {
              cwd: gitDir,
              stdio: "ignore",
            })
            execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
              cwd: gitDir,
              stdio: "ignore",
            })
            const gitRoot = AbsoluteRepoRoot.make(realpathSync.native(gitDir))
            const validated = yield* validateWorktreeRepoRoot(gitRoot)
            const runtimePaths = resolveWorkflowRuntimePaths(validated.commonGitDir)
            const resolvedGit = resolveWorkflowProjectionStatusPath(gitRoot)
            expect(resolvedGit.statusFilePath).toBe(runtimePaths.projectionStatusPath)

            const runA = WorkflowRunId.make("run-store-sec-a")
            const runB = WorkflowRunId.make("run-store-sec-b")
            yield* writeWorkflowProjectionStatus(
              gitRoot,
              runA,
              WorkflowProjectionStatus.make("fresh"),
            )
            yield* writeWorkflowProjectionStatus(
              gitRoot,
              runB,
              WorkflowProjectionStatus.make("stale"),
            )
            expect(existsSync(resolvedGit.statusFilePath)).toBe(true)
            expect(statSync(resolvedGit.statusFilePath).mode & 0o777).toBe(0o600)

            const readBack = yield* readWorkflowProjectionStatuses(gitRoot)
            expect(readBack.get(runA)).toBe("fresh")
            expect(readBack.get(runB)).toBe("stale")

            // 2. Non-git directory uses <repoRoot>/.harness/workflow-projection-status.json
            const nonGitDir = join(tmpRoot, "non-git")
            mkdirSync(nonGitDir, { recursive: true })
            const nonGitRoot = AbsoluteRepoRoot.make(nonGitDir)
            const resolvedNonGit = resolveWorkflowProjectionStatusPath(nonGitRoot)
            expect(resolvedNonGit.statusFilePath).toBe(
              join(nonGitDir, ".harness", "workflow-projection-status.json"),
            )
            yield* writeWorkflowProjectionStatus(
              nonGitRoot,
              runA,
              WorkflowProjectionStatus.make("not-projected"),
            )
            const nonGitRead = yield* readWorkflowProjectionStatuses(nonGitRoot)
            expect(nonGitRead.get(runA)).toBe("not-projected")

            // 3. Rejects symlinked status file and corrupt JSON
            const symDir = join(tmpRoot, "sym-repo")
            mkdirSync(join(symDir, ".harness"), { recursive: true })
            const outside = join(tmpRoot, "outside.json")
            writeFileSync(outside, '{"version":1,"statuses":{}}', "utf8")
            symlinkSync(outside, join(symDir, ".harness", "workflow-projection-status.json"))
            const symExit = yield* readWorkflowProjectionStatuses(
              AbsoluteRepoRoot.make(symDir),
            ).pipe(Effect.exit)
            match(symExit)
              .with({ _tag: "Failure" }, ({ cause }) => {
                expect(Cause.hasFails(cause)).toBe(true)
                expect(Cause.hasDies(cause)).toBe(false)
              })
              .with({ _tag: "Success" }, () => expect.unreachable("expected symlink Failure"))
              .exhaustive()

            const corruptDir = join(tmpRoot, "corrupt-repo")
            mkdirSync(join(corruptDir, ".harness"), { recursive: true })
            writeFileSync(
              join(corruptDir, ".harness", "workflow-projection-status.json"),
              "{bad-json",
              "utf8",
            )
            const corruptExit = yield* readWorkflowProjectionStatuses(
              AbsoluteRepoRoot.make(corruptDir),
            ).pipe(Effect.exit)
            match(corruptExit)
              .with({ _tag: "Failure" }, ({ cause }) => {
                expect(Cause.hasFails(cause)).toBe(true)
                expect(Option.isSome(Cause.findErrorOption(cause))).toBe(true)
              })
              .with({ _tag: "Success" }, () => expect.unreachable("expected corrupt Failure"))
              .exhaustive()
          }),
        (tmpRoot) => Effect.sync(() => rmSync(tmpRoot, { recursive: true, force: true })),
      ),
  )
})
