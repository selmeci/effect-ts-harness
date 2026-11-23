import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AbsoluteRepoRoot, WorkUnitId, WorkflowRunId } from "@harness/contract"
import { classifyFileRead, classifyFileWrite } from "@harness/gates"
import {
  resolveWorkflowRuntimePaths,
  resolveWorkflowWorktreeDir,
  validateWorktreeRepoRoot,
} from "../src/worktree-repo-root.js"

const WORKER_POLICY_OPTS = { unitWorkerMode: true } as const
const RunSlugSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{7,20}$/))
const UnitSlugSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_.:-]{0,18}$/))

const initGitRepo = (baseDir: string): string => {
  const canonicalDir = join(baseDir, "repo")
  mkdirSync(canonicalDir, { recursive: true })
  execFileSync("git", ["init"], { cwd: canonicalDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "seam@example.com"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  execFileSync("git", ["config", "user.name", "Seam Test"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  return canonicalDir
}

describe("SPEC-0026 REQ-3.2: WorktreeRepoRoot.validate x policy worker isolation seam invariants", () => {
  it.effect(
    "allows source writes inside validated resolveWorkflowWorktreeDir while denying .harness state, .env, daemon.sock, and auth-tokens.json",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "wf3-wt-policy-seam-"))),
        (baseDir) =>
          Effect.gen(function* () {
            const canonicalDir = initGitRepo(baseDir)
            const canonicalRoot = AbsoluteRepoRoot.make(realpathSync.native(canonicalDir))
            const runId = WorkflowRunId.make("run-seam-01")
            const unitId = WorkUnitId.make("slice-alpha")

            const expectedWtDir = resolveWorkflowWorktreeDir(canonicalRoot, runId, unitId)
            execFileSync(
              "git",
              ["worktree", "add", "-b", "slice/seam-alpha", expectedWtDir, "HEAD"],
              { cwd: canonicalRoot, stdio: "ignore" },
            )

            const validated = yield* validateWorktreeRepoRoot(expectedWtDir)
            expect(validated.kind).toBe("linked")
            expect(validated.worktreeRoot).toBe(realpathSync.native(expectedWtDir))

            const runtimePaths = resolveWorkflowRuntimePaths(validated.commonGitDir)

            const allowedSrc = join(validated.worktreeRoot, "libs/sample/src/index.ts")
            expect(classifyFileWrite(allowedSrc, WORKER_POLICY_OPTS).verdict).toBe("allow")
            expect(classifyFileRead(allowedSrc, WORKER_POLICY_OPTS).verdict).toBe("allow")

            const writeDeniedTargets = [
              join(validated.worktreeRoot, ".harness/verify-stamp.json"),
              join(validated.worktreeRoot, ".harness/mutate-stamp.json"),
              join(validated.worktreeRoot, ".harness/last-done.json"),
              join(validated.worktreeRoot, ".harness/graph-snapshot.json"),
              join(validated.worktreeRoot, "repos/effect/LLMS.md"),
            ]
            for (const target of writeDeniedTargets) {
              expect(classifyFileWrite(target, WORKER_POLICY_OPTS).verdict, target).toBe("deny")
            }

            const readAndWriteDeniedTargets = [
              join(validated.worktreeRoot, ".env"),
              runtimePaths.socketPath,
              join(validated.commonGitDir, "harness/auth-tokens.json"),
              join(validated.commonGitDir, "harness/daemon.lock"),
              join(validated.commonGitDir, "harness/workflow-backups/backup.ndjson"),
            ]
            for (const target of readAndWriteDeniedTargets) {
              expect(classifyFileWrite(target, WORKER_POLICY_OPTS).verdict, target).toBe("deny")
              expect(classifyFileRead(target, WORKER_POLICY_OPTS).verdict, target).toBe("deny")
            }
          }),
        (baseDir) =>
          Effect.sync(() => {
            rmSync(baseDir, { recursive: true, force: true })
          }),
      ),
  )

  it.prop(
    "SPEC-0026 REQ-3.2 property: resolveWorkflowWorktreeDir preserves allow-source / deny-harness-and-secrets seam across arbitrary valid runId and unitId slugs",
    {
      runSlug: RunSlugSchema,
      unitSlug: UnitSlugSchema,
    },
    ({ runSlug, unitSlug }) => {
      const canonicalRoot = AbsoluteRepoRoot.make("/tmp/harness-seam-canonical")
      const wtDir = resolveWorkflowWorktreeDir(
        canonicalRoot,
        WorkflowRunId.make(runSlug),
        WorkUnitId.make(unitSlug),
      )

      const allowedSource = join(wtDir, "libs/sample/src/file.ts")
      expect(classifyFileWrite(allowedSource, WORKER_POLICY_OPTS).verdict).toBe("allow")
      expect(classifyFileRead(allowedSource, WORKER_POLICY_OPTS).verdict).toBe("allow")

      const writeOnlyDeniedFiles = [
        join(wtDir, ".harness/verify-stamp.json"),
        join(wtDir, ".harness/mutate-stamp.json"),
        join(wtDir, "repos/effect/LLMS.md"),
      ]
      for (const denied of writeOnlyDeniedFiles) {
        expect(classifyFileWrite(denied, WORKER_POLICY_OPTS).verdict).toBe("deny")
      }

      const readAndWriteDeniedFiles = [
        join(wtDir, ".env"),
        join(canonicalRoot, ".git/harness/daemon.sock"),
        join(canonicalRoot, ".git/harness/auth-tokens.json"),
        join(canonicalRoot, ".git/harness/daemon.lock"),
      ]
      for (const denied of readAndWriteDeniedFiles) {
        expect(classifyFileWrite(denied, WORKER_POLICY_OPTS).verdict).toBe("deny")
        expect(classifyFileRead(denied, WORKER_POLICY_OPTS).verdict).toBe("deny")
      }
    },
  )
})
