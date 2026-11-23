import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Option } from "effect"
import { match } from "ts-pattern"
import {
  CompiledPlan,
  GitCommitSha,
  PlanSha256,
  SliceBranchName,
  WaveIndex,
  WorkUnitId,
  WorkflowRunId,
  isPureInterruptCause,
} from "@harness/contract"
import { decideSpanBudgets } from "@harness/gates"
import { WorkflowWorktreePort } from "@harness/service"
import type { ExtendedHostIo } from "@harness/service/host-io"
import {
  makeWorkflowWorktreePortLayer,
  mergeSliceWaveImpl,
  nodeSyncHostIo,
  provisionWorkflowWorktreesImpl,
  removeWorktreeCheckoutsImpl,
} from "../src/index.js"
import { resolveWorkflowWorktreeDir } from "../src/worktree-repo-root.js"
import {
  runWithTestTracer,
  withTempDir,
  initGitRepo,
  makeSliceUnit,
  makePackageUnit,
  makeEpicPlan,
  expectWorkspaceFsErrorExit,
} from "./helpers/workflow-verifier-fixture.js"

describe("WorkflowWorktreePort", () => {
  it.live("provisions L2 canonical mappings", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { repoRoot, baseSha } = initGitRepo(dir)
        const l2Plan: CompiledPlan = {
          runId: WorkflowRunId.make("run-l2-wt-1"),
          level: "slice",
          planSha: PlanSha256.make("a".repeat(64)),
          baseSha,
          mode: { _tag: "Manual" },
          units: [makePackageUnit({ unitId: "u-alpha" })],
          sharedStepPaths: [],
        }
        const receipt = yield* provisionWorkflowWorktreesImpl(l2Plan, { repoRoot })
        expect(receipt.entries).toEqual([
          { unitId: WorkUnitId.make("u-alpha"), cwd: repoRoot, worktreeKind: "canonical" },
        ])
      }),
    ),
  )

  it.live(
    "provisions L1 linked worktrees at .harness/workflow-worktrees/<runId>/<unitId> and cleans stale dirs (F-1.1)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const l1Plan = makeEpicPlan(baseSha)
          const expectedAlphaDir = resolveWorkflowWorktreeDir(
            repoRoot,
            l1Plan.runId,
            WorkUnitId.make("s-alpha"),
          )
          mkdirSync(expectedAlphaDir, { recursive: true })
          writeFileSync(join(expectedAlphaDir, "stale.txt"), "leftover\n", "utf8")

          const receipt = yield* Effect.gen(function* () {
            const wt = yield* WorkflowWorktreePort
            return yield* wt.provisionWorktrees(l1Plan)
          }).pipe(Effect.provide(makeWorkflowWorktreePortLayer({ repoRoot })))

          expect(existsSync(join(expectedAlphaDir, "stale.txt"))).toBe(false)
          expect(existsSync(join(repoRoot, ".git", "harness", "worktrees"))).toBe(false)
          expect(receipt.entries.length).toBe(2)
          expect(receipt.entries[0]?.cwd).toBe(realpathSync.native(expectedAlphaDir))
          expect(receipt.entries[0]?.worktreeKind).toBe("linked")
          expect(existsSync(receipt.entries[0]!.cwd)).toBe(true)
          expect(existsSync(receipt.entries[1]!.cwd)).toBe(true)
        }),
      ),
  )

  it.live(
    "re-provisioning existing slice/* branch attaches non-destructively preserving commits when baseSha is ancestor (F-5.1 / F-23.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const plan = makeEpicPlan(baseSha, "run-reattach-1", [
            makeSliceUnit("s-alpha", "slice/reattach-alpha", ["libs/alpha"]),
          ])
          const receipt1 = yield* provisionWorkflowWorktreesImpl(plan, { repoRoot })
          const alphaCwd = receipt1.entries[0]!.cwd
          writeFileSync(
            join(alphaCwd, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 77\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: alphaCwd })
          execFileSync("git", ["commit", "-m", "slice commit preserved"], {
            cwd: alphaCwd,
            stdio: "ignore",
          })
          const sliceSha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: alphaCwd,
            encoding: "utf8",
          }).trim()

          yield* removeWorktreeCheckoutsImpl(receipt1)
          const receipt2 = yield* provisionWorkflowWorktreesImpl(plan, { repoRoot })
          const reattachedSha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: receipt2.entries[0]!.cwd,
            encoding: "utf8",
          }).trim()
          expect(reattachedSha).toBe(sliceSha)
          expect(
            readFileSync(
              join(receipt2.entries[0]!.cwd, "libs", "alpha", "src", "index.ts"),
              "utf8",
            ),
          ).toBe("export const alpha = 77\n")
        }),
      ),
  )

  it.live(
    "re-provisioning diverged slice/* branch fails closed with WorkspaceFsError without resetting it (F-5.1 / F-23.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          execFileSync("git", ["checkout", "-b", "slice/diverged-alpha"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 101\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "diverged slice commit"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          const divergedSliceSha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
          }).trim()

          execFileSync("git", ["checkout", "-"], { cwd: repoRoot, stdio: "ignore" })
          writeFileSync(
            join(repoRoot, "libs", "beta", "src", "index.ts"),
            "export const beta = 202\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "advance main past slice"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          const advancedBaseSha = GitCommitSha.make(
            execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
          )

          const plan = makeEpicPlan(advancedBaseSha, "run-diverged-1", [
            makeSliceUnit("s-alpha", "slice/diverged-alpha", ["libs/alpha"]),
          ])
          const exit = yield* Effect.exit(provisionWorkflowWorktreesImpl(plan, { repoRoot }))
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for diverged slice branch")
            })
            .exhaustive()

          const preservedSha = execFileSync(
            "git",
            ["rev-parse", "refs/heads/slice/diverged-alpha"],
            {
              cwd: repoRoot,
              encoding: "utf8",
            },
          ).trim()
          expect(preservedSha).toBe(divergedSliceSha)
        }),
      ),
  )

  it.live(
    "rolls back earlier worktrees cleanly when Nth worktree add fails (F-11.1 / F-23.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot } = initGitRepo(dir)
          execFileSync("git", ["checkout", "-b", "slice/diverged-beta"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          writeFileSync(
            join(repoRoot, "libs", "beta", "src", "index.ts"),
            "export const beta = 50\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "beta diverged"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["checkout", "-"], { cwd: repoRoot, stdio: "ignore" })
          writeFileSync(
            join(repoRoot, "libs", "shared", "barrel.ts"),
            "export const shared = 50\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "advance base"], { cwd: repoRoot, stdio: "ignore" })
          const advancedBaseSha = GitCommitSha.make(
            execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
          )

          const plan = makeEpicPlan(advancedBaseSha, "run-rollback-1", [
            makeSliceUnit("s-alpha", "slice/ok-alpha", ["libs/alpha"]),
            makeSliceUnit("s-beta", "slice/diverged-beta", ["libs/beta"]),
          ])
          const alphaWtDir = resolveWorkflowWorktreeDir(
            repoRoot,
            plan.runId,
            WorkUnitId.make("s-alpha"),
          )

          const exit = yield* Effect.exit(provisionWorkflowWorktreesImpl(plan, { repoRoot }))
          expectWorkspaceFsErrorExit(exit, "Expected WorkspaceFsError on Nth worktree add failure")
          expect(existsSync(alphaWtDir)).toBe(false)
          const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], {
            cwd: repoRoot,
            encoding: "utf8",
          })
          expect(wtList).not.toContain("s-alpha")
        }),
      ),
  )

  it.live(
    "fiber interruption during Nth worktree creation triggers Effect.onExit rollback and preserves pure interrupt (F-11.1 / F-23.3)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const plan = makeEpicPlan(baseSha, "run-interrupt-1")
          const alphaWtDir = resolveWorkflowWorktreeDir(
            repoRoot,
            plan.runId,
            WorkUnitId.make("s-alpha"),
          )
          const betaWtDir = resolveWorkflowWorktreeDir(
            repoRoot,
            plan.runId,
            WorkUnitId.make("s-beta"),
          )
          const firstProvisioned = yield* Deferred.make<void>()

          const spyHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            realpathSync: (filePath: string) => {
              const resolved = nodeSyncHostIo.realpathSync(filePath)
              if (filePath === alphaWtDir) {
                Deferred.doneUnsafe(firstProvisioned, Effect.void)
              }
              return resolved
            },
          }

          const fiber = yield* provisionWorkflowWorktreesImpl(plan, {
            repoRoot,
            hostIo: spyHostIo,
          }).pipe(Effect.forkChild)

          yield* Deferred.await(firstProvisioned)
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(isPureInterruptCause(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected pure interrupt failure")
            })
            .exhaustive()

          expect(existsSync(alphaWtDir)).toBe(false)
          expect(existsSync(betaWtDir)).toBe(false)
        }),
      ),
  )

  it.live(
    "removeWorktreeCheckoutsImpl detaches linked checkouts while preserving slice/* branches and is idempotent",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const l1Plan = makeEpicPlan(baseSha)
          const receipt = yield* provisionWorkflowWorktreesImpl(l1Plan, { repoRoot })
          const alphaWt = receipt.entries[0]!
          const betaWt = receipt.entries[1]!

          writeFileSync(
            join(alphaWt.cwd, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 10\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: alphaWt.cwd })
          execFileSync("git", ["commit", "-m", "alpha work"], { cwd: alphaWt.cwd, stdio: "ignore" })

          writeFileSync(
            join(betaWt.cwd, "libs", "beta", "src", "index.ts"),
            "export const beta = 20\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: betaWt.cwd })
          execFileSync("git", ["commit", "-m", "beta work"], { cwd: betaWt.cwd, stdio: "ignore" })

          const { spans } = yield* runWithTestTracer(
            "removeWorktreeCheckouts",
            removeWorktreeCheckoutsImpl(receipt),
          )
          expect(spans.some((s) => s.name === "Harness.removeWorktreeCheckouts")).toBe(true)
          expect(yield* decideSpanBudgets({ spans })).toEqual([])
          expect(existsSync(alphaWt.cwd)).toBe(false)
          expect(existsSync(betaWt.cwd)).toBe(false)

          const branches = execFileSync("git", ["branch", "--list", "slice/*"], {
            cwd: repoRoot,
            encoding: "utf8",
          })
          expect(branches).toContain("slice/wf3-alpha")
          expect(branches).toContain("slice/wf3-beta")

          yield* removeWorktreeCheckoutsImpl(receipt)
        }),
      ),
  )

  it.live(
    "mergeSliceWaveImpl merges idempotently, rejects missing branch and dirty collision, and aborts conflicts strictly",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const l1Plan = makeEpicPlan(baseSha)
          const receipt = yield* provisionWorkflowWorktreesImpl(l1Plan, { repoRoot })
          const alphaWt = receipt.entries[0]!
          const betaWt = receipt.entries[1]!

          writeFileSync(
            join(alphaWt.cwd, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 10\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: alphaWt.cwd })
          execFileSync("git", ["commit", "-m", "alpha work"], { cwd: alphaWt.cwd, stdio: "ignore" })

          writeFileSync(
            join(betaWt.cwd, "libs", "beta", "src", "index.ts"),
            "export const beta = 20\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: betaWt.cwd })
          execFileSync("git", ["commit", "-m", "beta work"], { cwd: betaWt.cwd, stdio: "ignore" })

          yield* removeWorktreeCheckoutsImpl(receipt)

          const merge1 = yield* mergeSliceWaveImpl({
            runId: l1Plan.runId,
            waveIndex: WaveIndex.make(0),
            baseSha,
            canonicalRepoRoot: repoRoot,
            branches: [
              SliceBranchName.make("slice/wf3-alpha"),
              SliceBranchName.make("slice/wf3-beta"),
            ],
          })
          expect(merge1).toEqual({
            _tag: "Merged",
            mergedBranches: [
              SliceBranchName.make("slice/wf3-alpha"),
              SliceBranchName.make("slice/wf3-beta"),
            ],
          })

          const merge2 = yield* mergeSliceWaveImpl({
            runId: l1Plan.runId,
            waveIndex: WaveIndex.make(0),
            baseSha,
            canonicalRepoRoot: repoRoot,
            branches: [
              SliceBranchName.make("slice/wf3-alpha"),
              SliceBranchName.make("slice/wf3-beta"),
            ],
          })
          expect(merge2).toEqual(merge1)

          const missingExit = yield* Effect.exit(
            mergeSliceWaveImpl({
              runId: l1Plan.runId,
              waveIndex: WaveIndex.make(1),
              baseSha,
              canonicalRepoRoot: repoRoot,
              branches: [SliceBranchName.make("slice/does-not-exist")],
            }),
          )
          expectWorkspaceFsErrorExit(missingExit, "Expected WorkspaceFsError for missing branch")

          execFileSync("git", ["checkout", "-b", "slice/wf3-conflict", baseSha], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 999\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "conflict work"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["checkout", "-"], { cwd: repoRoot, stdio: "ignore" })

          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 777\n",
            "utf8",
          )
          const dirtyExit = yield* Effect.exit(
            mergeSliceWaveImpl({
              runId: l1Plan.runId,
              waveIndex: WaveIndex.make(1),
              baseSha,
              canonicalRepoRoot: repoRoot,
              branches: [SliceBranchName.make("slice/wf3-conflict")],
            }),
          )
          expectWorkspaceFsErrorExit(dirtyExit, "Expected WorkspaceFsError for dirty merge")
          execFileSync("git", ["checkout", "--", "libs/alpha/src/index.ts"], { cwd: repoRoot })

          const conflictMerge = yield* mergeSliceWaveImpl({
            runId: l1Plan.runId,
            waveIndex: WaveIndex.make(1),
            baseSha,
            canonicalRepoRoot: repoRoot,
            branches: [SliceBranchName.make("slice/wf3-conflict")],
          })
          expect(conflictMerge).toEqual({
            _tag: "Conflict",
            branch: SliceBranchName.make("slice/wf3-conflict"),
          })
          expect(existsSync(join(repoRoot, ".git", "MERGE_HEAD"))).toBe(false)
        }),
      ),
  )

  it.live(
    "mergeSliceWaveImpl fails closed with WorkspaceFsError when abortMergeStrict fails or unmerged paths exist without MERGE_HEAD (F-11.2)",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { repoRoot, baseSha } = initGitRepo(dir)
          const unmergedWithoutHeadHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (cmd, args, opts) => {
              if (cmd === "git" && args[0] === "diff" && args.includes("--diff-filter=U")) {
                return {
                  _tag: "Exited",
                  exitCode: 0,
                  stdout: "libs/alpha/src/index.ts\n",
                  stderr: "",
                }
              }
              return nodeSyncHostIo.execFileSync(cmd, args, opts)
            },
          }
          const unmergedExit = yield* Effect.exit(
            mergeSliceWaveImpl(
              {
                runId: WorkflowRunId.make("run-unmerged-1"),
                waveIndex: WaveIndex.make(0),
                baseSha,
                canonicalRepoRoot: repoRoot,
                branches: [],
              },
              { hostIo: unmergedWithoutHeadHostIo },
            ),
          )
          match(unmergedExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => undefined,
                  onSome: (e) => e._tag,
                }),
              ).toBe("WorkspaceFsError")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError for unmerged paths without MERGE_HEAD")
            })
            .exhaustive()

          execFileSync("git", ["checkout", "-b", "slice/abort-fail", baseSha], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          writeFileSync(
            join(repoRoot, "libs", "alpha", "src", "index.ts"),
            "export const alpha = 5\n",
            "utf8",
          )
          execFileSync("git", ["add", "."], { cwd: repoRoot })
          execFileSync("git", ["commit", "-m", "branch edit"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["checkout", "-"], { cwd: repoRoot, stdio: "ignore" })

          const abortFailHostIo: ExtendedHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (cmd, args, opts) => {
              if (cmd === "git" && args[0] === "merge" && args[1] === "--no-ff") {
                return { _tag: "TimedOut", stdout: "", stderr: "merge timed out" }
              }
              if (cmd === "git" && args[0] === "rev-parse" && args[2] === "MERGE_HEAD") {
                return { _tag: "Exited", exitCode: 0, stdout: ".git/HEAD\n", stderr: "" }
              }
              if (cmd === "git" && args[0] === "merge" && args[1] === "--abort") {
                return { _tag: "Exited", exitCode: 128, stdout: "", stderr: "abort refused" }
              }
              return nodeSyncHostIo.execFileSync(cmd, args, opts)
            },
          }

          const abortFailExit = yield* Effect.exit(
            mergeSliceWaveImpl(
              {
                runId: WorkflowRunId.make("run-abort-fail"),
                waveIndex: WaveIndex.make(0),
                baseSha,
                canonicalRepoRoot: repoRoot,
                branches: [SliceBranchName.make("slice/abort-fail")],
              },
              { hostIo: abortFailHostIo },
            ),
          )
          match(abortFailExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              const err = Option.getOrUndefined(Cause.findErrorOption(cause))
              expect(err?._tag).toBe("WorkspaceFsError")
              expect(err?.reason).toContain("abort refused")
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected WorkspaceFsError when abortMergeStrict fails")
            })
            .exhaustive()
        }),
      ),
  )
})
