import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Result } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  ErrorReasonMessage,
  GateDurationMs,
  GateExitCode,
  MutationRestoreError,
  SHIP_STAGES,
  ShipAttempt,
  ShipErrorTag,
  ShipFailureMessage,
  ShipGateFailedError,
  ShipStageFailed,
  ShipStagePassed,
  ShipStreamProgressEvent,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowRunId,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
  WorkspaceTreeHash,
  toShipFailureMessage,
} from "@harness/contract"
import { appendFrictionEvent, readFrictionEvents } from "@harness/gates"
import { ShipGateRunner } from "@harness/service"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../src/node-host-io.js"
import {
  computeTreeHashImpl,
  createShipActiveGateController,
  executeStageCommandImpl,
  extractDoneStdoutBlockReason,
  makeShipGateRunnerLayer,
  recoverMutationBackupImpl,
  reportStageProgressImpl,
  resolveShipFormatCheckFiles,
  resolveShipGateCommand,
} from "../src/workflow/ship-gate-runner-live.js"

const withTempRepo = <A, E, R>(
  use: (repoRoot: AbsoluteRepoRoot) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const rawDir = mkdtempSync(join(tmpdir(), "wf4-ship-gate-"))
      const repoDir = join(rawDir, "repo")
      mkdirSync(repoDir, { recursive: true })
      return { rawDir, repoRoot: AbsoluteRepoRoot.make(realpathSync.native(repoDir)) }
    }),
    ({ repoRoot }) => use(repoRoot),
    ({ rawDir }) =>
      Effect.sync(() => {
        rmSync(rawDir, { recursive: true, force: true })
      }),
  )

const initRepoWithMain = (repoRoot: string): void => {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "wf4@example.com"], {
    cwd: repoRoot,
    stdio: "ignore",
  })
  execFileSync("git", ["config", "user.name", "WF4 Tester"], {
    cwd: repoRoot,
    stdio: "ignore",
  })
  mkdirSync(join(repoRoot, "libs", "demo", "src"), { recursive: true })
  writeFileSync(join(repoRoot, "libs", "demo", "src", "base.ts"), "export const base = 1\n")
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" })
}

const makeRunId = () => WorkflowRunId.make("run-ship-gate-01")
const makeAttempt = () => ShipAttempt.make(1)
const makeSampleHash = () => WorkspaceTreeHash.make("a".repeat(64))

const cleanFrictionHostIo: SyncHostIo = {
  ...nodeSyncHostIo,
  getEnv: () => {
    const nextEnv: Record<string, string | undefined> = { ...nodeSyncHostIo.getEnv() }
    Reflect.deleteProperty(nextEnv, "HARNESS_STATE_DIR")
    Reflect.deleteProperty(nextEnv, "HARNESS_WORKTREE_ID")
    return nextEnv
  },
}

describe("ShipGateRunnerLive & pure helpers", () => {
  it("resolveShipGateCommand maps all 6 ShipStage variants and skips empty format-check", () => {
    expect(resolveShipGateCommand("format-check", [])).toBeUndefined()
    expect(resolveShipGateCommand("format-check", ["a.ts", "b.md"])).toEqual({
      cmd: "pnpm",
      args: ["exec", "oxfmt", "--check", "--", "a.ts", "b.md"],
    })
    expect(resolveShipGateCommand("gc-strict", [])).toEqual({
      cmd: "pnpm",
      args: ["harness", "gc", "--strict"],
    })
    expect(resolveShipGateCommand("ontology-check-strict", [])).toEqual({
      cmd: "pnpm",
      args: ["harness", "ontology", "check", "--strict"],
    })
    expect(resolveShipGateCommand("mutate-strict", [])).toEqual({
      cmd: "pnpm",
      args: ["harness", "mutate", "--strict"],
    })
    expect(resolveShipGateCommand("verify", [])).toEqual({
      cmd: "pnpm",
      args: ["harness", "verify"],
    })
    expect(resolveShipGateCommand("done", [])).toEqual({
      cmd: "pnpm",
      args: ["harness", "done", "--cli"],
    })
  })

  it("extractDoneStdoutBlockReason handles empty, non-JSON, stop, block, continue, and multiline JSON", () => {
    expect(extractDoneStdoutBlockReason("")).toBeUndefined()
    expect(extractDoneStdoutBlockReason("   \n  ")).toBeUndefined()
    expect(extractDoneStdoutBlockReason("not json output")).toBeUndefined()
    expect(extractDoneStdoutBlockReason(JSON.stringify({ decision: "stop" }))).toBeUndefined()
    expect(
      extractDoneStdoutBlockReason(
        JSON.stringify({ decision: "block", reason: "  verify stale  " }),
      ),
    ).toBe("verify stale")
    expect(
      extractDoneStdoutBlockReason(
        JSON.stringify({ decision: "continue", reason: "  more work needed " }),
      ),
    ).toBe("more work needed")
    expect(extractDoneStdoutBlockReason(JSON.stringify({ decision: "block" }))).toBe(
      "harness done reported decision 'block'",
    )
    expect(extractDoneStdoutBlockReason(JSON.stringify({ decision: "block", reason: "   " }))).toBe(
      "harness done reported decision 'block'",
    )
    expect(
      extractDoneStdoutBlockReason(
        `[info] running checks\n${JSON.stringify({ decision: "block", reason: "plan drift" })}\n`,
      ),
    ).toBe("plan drift")
  })

  it.live(
    "resolveShipFormatCheckFiles collects committed, staged, unstaged, untracked and filters ignored/non-formattable/symlinks",
    () =>
      withTempRepo((repoRoot) =>
        Effect.sync(() => {
          initRepoWithMain(repoRoot)
          execFileSync("git", ["checkout", "-b", "feat/ship"], { cwd: repoRoot, stdio: "ignore" })

          writeFileSync(
            join(repoRoot, "libs", "demo", "src", "committed.ts"),
            "export const c = 1\n",
          )
          writeFileSync(join(repoRoot, "libs", "demo", "src", "deleted.ts"), "export const d = 1\n")
          execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["commit", "-m", "feat commit"], { cwd: repoRoot, stdio: "ignore" })
          // Delete tracked file -> skipped via isFileSync
          rmSync(join(repoRoot, "libs", "demo", "src", "deleted.ts"))

          // Unstaged + staged modification (cross-bucket dedup)
          writeFileSync(join(repoRoot, "libs", "demo", "src", "base.ts"), "export const base = 2\n")
          execFileSync("git", ["add", "libs/demo/src/base.ts"], { cwd: repoRoot, stdio: "ignore" })
          writeFileSync(join(repoRoot, "libs", "demo", "src", "base.ts"), "export const base = 3\n")

          // Staged file (.mts) + uppercase extensions (.MD, .TS) + .mdx
          writeFileSync(join(repoRoot, "libs", "demo", "src", "staged.mts"), "export const s = 1\n")
          execFileSync("git", ["add", "libs/demo/src/staged.mts"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          writeFileSync(join(repoRoot, "README.MD"), "# Ship\n")
          writeFileSync(join(repoRoot, "GUIDE.mdx"), "# Guide\n")
          writeFileSync(join(repoRoot, "libs", "demo", "src", "UPPER.TS"), "export const u = 1\n")
          writeFileSync(join(repoRoot, "libs", "demo", "src", "notes.txt"), "skip me\n")

          // Ignored dirs: .harness, root repos/, root dist/, node_modules, .nx
          mkdirSync(join(repoRoot, ".harness"), { recursive: true })
          writeFileSync(join(repoRoot, ".harness", "ignored.json"), "{}\n")
          mkdirSync(join(repoRoot, "repos", "effect"), { recursive: true })
          writeFileSync(join(repoRoot, "repos", "effect", "ro.ts"), "export const ro = 1\n")
          mkdirSync(join(repoRoot, "dist"), { recursive: true })
          writeFileSync(join(repoRoot, "dist", "bundle.js"), "export {}\n")
          mkdirSync(join(repoRoot, "libs", "demo", "node_modules", "pkg"), { recursive: true })
          writeFileSync(join(repoRoot, "libs", "demo", "node_modules", "pkg", "dep.js"), "{}\n")
          mkdirSync(join(repoRoot, ".nx"), { recursive: true })
          writeFileSync(join(repoRoot, ".nx", "cache.json"), "{}\n")

          // Non-root repos/ and src/dist/ MUST be kept
          mkdirSync(join(repoRoot, "libs", "demo", "repos"), { recursive: true })
          writeFileSync(join(repoRoot, "libs", "demo", "repos", "kept.yml"), "key: val\n")
          mkdirSync(join(repoRoot, "libs", "demo", "src", "dist"), { recursive: true })
          writeFileSync(join(repoRoot, "libs", "demo", "src", "dist", "kept.js"), "export {}\n")

          // Symlink leaf + symlinked parent directory skipped
          symlinkSync(join(repoRoot, "README.MD"), join(repoRoot, "libs", "demo", "src", "link.ts"))
          mkdirSync(join(repoRoot, "real-dir"), { recursive: true })
          writeFileSync(join(repoRoot, "real-dir", "target.ts"), "export const t = 1\n")
          symlinkSync(join(repoRoot, "real-dir"), join(repoRoot, "libs", "demo", "sym-parent"))

          const filesRes = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(
            match(filesRes)
              .with({ _tag: "Success" }, ({ success }) => success)
              .with({ _tag: "Failure" }, ({ failure }) => failure.message)
              .exhaustive(),
          ).toEqual([
            "GUIDE.mdx",
            "README.MD",
            "libs/demo/repos/kept.yml",
            "libs/demo/src/UPPER.TS",
            "libs/demo/src/base.ts",
            "libs/demo/src/committed.ts",
            "libs/demo/src/dist/kept.js",
            "libs/demo/src/staged.mts",
            "real-dir/target.ts",
          ])
        }),
      ),
  )

  it.live(
    "resolveShipFormatCheckFiles handles unborn HEAD, origin/main, HEAD on main ahead/synced vs origin/main, HEAD~1 fallback, root commit, and ./ backslash normalization",
    () =>
      withTempRepo((repoRoot) =>
        Effect.sync(() => {
          // 1. Unborn HEAD (git init with 0 commits) inspects --cached + untracked
          execFileSync("git", ["init", "-b", "trunk"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["config", "user.email", "wf4@example.com"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          execFileSync("git", ["config", "user.name", "WF4 Tester"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          mkdirSync(join(repoRoot, "src"), { recursive: true })
          writeFileSync(join(repoRoot, "src", "staged.ts"), "export const s = 1\n")
          writeFileSync(join(repoRoot, "src", "untracked.ts"), "export const u = 1\n")
          execFileSync("git", ["add", "src/staged.ts"], { cwd: repoRoot, stdio: "ignore" })
          const unbornRes = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(unbornRes).toEqual(Result.succeed(["src/staged.ts", "src/untracked.ts"]))

          // 2. Root commit (no main, no origin/main, no HEAD~1) -> empty committed diff, untracked still inspected
          execFileSync("git", ["commit", "-m", "root"], { cwd: repoRoot, stdio: "ignore" })
          const rootRes = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(rootRes).toEqual(Result.succeed(["src/untracked.ts"]))

          // 3. Second commit (no main, no origin/main) -> falls back to HEAD~1..HEAD
          writeFileSync(join(repoRoot, "src", "second.ts"), "export const two = 2\n")
          execFileSync("git", ["add", "src/second.ts"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["commit", "-m", "second"], { cwd: repoRoot, stdio: "ignore" })
          const headMinus1Res = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(headMinus1Res).toEqual(Result.succeed(["src/second.ts", "src/untracked.ts"]))

          // 4. origin/main fallback + ./ & backslash normalization via mock git stdout
          execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD~1"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          const originMainRes = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(originMainRes).toEqual(Result.succeed(["src/second.ts", "src/untracked.ts"]))

          // 5. HEAD === main ahead of origin/main still checks committed files in origin/main..HEAD
          execFileSync("git", ["checkout", "-B", "main", "HEAD"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          const mainAheadRes = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(mainAheadRes).toEqual(Result.succeed(["src/second.ts", "src/untracked.ts"]))

          // 6. HEAD === main synced with origin/main returns only dirty/untracked files (no HEAD~1..HEAD fallback)
          execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          const mainSyncedRes = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(mainSyncedRes).toEqual(Result.succeed(["src/untracked.ts"]))

          const normHostIo: SyncHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (_cmd, args) => {
              if (args[0] === "symbolic-ref" || args[0] === "config") {
                return { _tag: "Exited", exitCode: 1, stdout: "", stderr: "" }
              }
              if (args[0] === "rev-parse") {
                return { _tag: "Exited", exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" }
              }
              if (args[0] === "merge-base") {
                return { _tag: "Exited", exitCode: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" }
              }
              if (args.includes("ls-files")) {
                return { _tag: "Exited", exitCode: 0, stdout: ".\\./src\\staged.ts\0", stderr: "" }
              }
              return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
            },
          }
          expect(resolveShipFormatCheckFiles(repoRoot, normHostIo, {})).toEqual(
            Result.succeed(["src/staged.ts"]),
          )
        }),
      ),
  )

  it.live("resolveShipFormatCheckFiles and format-check fail closed on git errors", () =>
    withTempRepo((repoRoot) =>
      Effect.gen(function* () {
        const failures: ReadonlyArray<SyncHostExecResult> = [
          { _tag: "TimedOut", stdout: "", stderr: "timed out" },
          { _tag: "Signaled", signal: "SIGTERM", stdout: "", stderr: "" },
          { _tag: "SpawnFailed", spawnError: "ENOBUFS", stdout: "", stderr: "" },
          { _tag: "Exited", exitCode: 128, stdout: "", stderr: "not a git repo" },
        ]
        for (const failureRes of failures) {
          const mockHostIo: SyncHostIo = {
            ...nodeSyncHostIo,
            execFileSync: () => failureRes,
          }
          const res = resolveShipFormatCheckFiles(repoRoot, mockHostIo, {})
          const failed = match(res)
            .with({ _tag: "Failure" }, ({ failure }) => failure)
            .with({ _tag: "Success" }, () => undefined)
            .exhaustive()
          expect(failed).toBeInstanceOf(ShipGateFailedError)
          expect(failed?.stage).toBe("format-check")
        }

        const stageErr = yield* Effect.flip(
          executeStageCommandImpl(
            {
              runId: makeRunId(),
              attempt: makeAttempt(),
              stage: "format-check",
              treeHash: makeSampleHash(),
              repoRoot,
            },
            {
              hostIo: {
                ...nodeSyncHostIo,
                execFileSync: () => ({
                  _tag: "SpawnFailed",
                  spawnError: "ENOBUFS",
                  stdout: "",
                  stderr: "",
                }),
              },
            },
          ),
        )
        expect(stageErr).toBeInstanceOf(ShipGateFailedError)
        expect(stageErr.stderrSummary).toContain("ENOBUFS")
        expect(stageErr.durationMs).toBeDefined()
      }),
    ),
  )

  it.live(
    "computeTreeHashImpl computes SHA-256 hash and maps failures to ShipGateFailedError",
    () =>
      withTempRepo((repoRoot) =>
        Effect.gen(function* () {
          initRepoWithMain(repoRoot)
          const hash = yield* computeTreeHashImpl({
            runId: makeRunId(),
            attempt: makeAttempt(),
            stage: "verify",
            repoRoot,
          })
          expect(hash).toMatch(/^[a-f0-9]{64}$/)

          const symlinkHostIo: typeof nodeSyncHostIo = {
            ...nodeSyncHostIo,
            isSymbolicLinkSync: (p) => (p === repoRoot ? true : false),
          }
          const err = yield* Effect.flip(
            computeTreeHashImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "mutate-strict",
                repoRoot,
              },
              { hostIo: symlinkHostIo },
            ),
          )
          expect(err).toBeInstanceOf(ShipGateFailedError)
          expect(err.stage).toBe("mutate-strict")
          expect(err.exitCode).toBe(GateExitCode.make(1))
        }),
      ),
  )

  it.live(
    "recoverMutationBackupImpl restores valid backup and fails closed with MutationRestoreError on corrupt backup",
    () =>
      withTempRepo((repoRoot) =>
        Effect.gen(function* () {
          initRepoWithMain(repoRoot)
          const targetFile = join(repoRoot, "libs", "demo", "src", "base.ts")
          const expectedHash = yield* computeTreeHashImpl({
            runId: makeRunId(),
            attempt: makeAttempt(),
            stage: "mutate-strict",
            repoRoot,
          })

          // No backup present -> succeeds
          yield* recoverMutationBackupImpl({
            runId: makeRunId(),
            attempt: makeAttempt(),
            expectedTreeHash: expectedHash,
            repoRoot,
          })

          // Dangling valid backup -> restores original content and removes backup
          mkdirSync(join(repoRoot, ".harness"), { recursive: true })
          const mutatedContent = "export const base = 999 // mutated\n"
          const mutatedSha256 = createHash("sha256").update(mutatedContent).digest("hex")
          writeFileSync(targetFile, mutatedContent)
          writeFileSync(
            join(repoRoot, ".harness", "mutation-backup.json"),
            JSON.stringify({
              filePath: "libs/demo/src/base.ts",
              content: "export const base = 1\n",
              mutatedSha256,
            }),
          )
          yield* recoverMutationBackupImpl({
            runId: makeRunId(),
            attempt: makeAttempt(),
            expectedTreeHash: expectedHash,
            repoRoot,
          })
          const afterRestoreHash = yield* computeTreeHashImpl({
            runId: makeRunId(),
            attempt: makeAttempt(),
            stage: "mutate-strict",
            repoRoot,
          })
          expect(afterRestoreHash).toBe(expectedHash)

          // Corrupt backup -> fails closed with MutationRestoreError
          writeFileSync(join(repoRoot, ".harness", "mutation-backup.json"), "{not-valid-json")
          const restoreErr = yield* Effect.flip(
            recoverMutationBackupImpl({
              runId: makeRunId(),
              attempt: makeAttempt(),
              expectedTreeHash: expectedHash,
              repoRoot,
            }),
          )
          expect(restoreErr).toBeInstanceOf(MutationRestoreError)
          expect(restoreErr.expected).toBe(expectedHash)
          expect(restoreErr.detail).toBeDefined()
        }),
      ),
  )

  it.live(
    "executeStageCommandImpl runs all 6 stages, streams progress, skips empty format-check, and strips worktree env",
    () =>
      withTempRepo((repoRoot) =>
        Effect.gen(function* () {
          initRepoWithMain(repoRoot)
          const events: Array<ShipStreamProgressEvent> = []
          const seenCommands: Array<{
            readonly cmd: string
            readonly args: ReadonlyArray<string>
            readonly env: Readonly<Record<string, string | undefined>>
            readonly timeoutMs: number
          }> = []
          let clockMs = 1000

          const layer = makeShipGateRunnerLayer({
            repoRoot,
            env: {
              PATH: process.env.PATH,
              HARNESS_WORKTREE_ID: "unit-1",
              HARNESS_STATE_DIR: "/tmp/wrong",
            },
            nowMs: () => {
              clockMs += 25
              return clockMs
            },
            onProgress: (ev) => {
              events.push(ev)
            },
            runCommand: (cmd, args, opts) => {
              seenCommands.push({ cmd, args, env: opts.env, timeoutMs: opts.timeoutMs })
              return Effect.succeed({
                _tag: "Exited",
                exitCode: 0,
                stdout: JSON.stringify({ decision: "stop" }),
                stderr: "",
              })
            },
          })

          // 0 changed files -> format-check passes without spawning; reportStageProgress streams to onProgress
          const startedEvent = ShipStreamProgressEvent.cases.StageStarted.make({
            runId: makeRunId(),
            attempt: makeAttempt(),
            stage: "format-check",
          })
          const finishedEvent = ShipStreamProgressEvent.cases.StageFinished.make({
            runId: makeRunId(),
            attempt: makeAttempt(),
            progress: ShipStagePassed.make({
              stage: "format-check",
              durationMs: GateDurationMs.make(25),
            }),
          })
          yield* Effect.gen(function* () {
            const runner = yield* ShipGateRunner
            for (const stage of SHIP_STAGES) {
              const res = yield* runner.executeStageCommand({
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage,
                treeHash: makeSampleHash(),
              })
              expect(res).toEqual(ShipStagePassed.make({ stage, durationMs: res.durationMs }))
            }
            yield* runner.reportStageProgress(startedEvent)
            yield* runner.reportStageProgress(finishedEvent)
          }).pipe(Effect.provide(layer))

          // format-check skipped -> 5 commands spawned
          expect(seenCommands.map((c) => c.args)).toEqual([
            ["harness", "gc", "--strict"],
            ["harness", "ontology", "check", "--strict"],
            ["harness", "mutate", "--strict"],
            ["harness", "verify"],
            ["harness", "done", "--cli"],
          ])
          for (const call of seenCommands) {
            expect(call.env.CI).toBe("true")
            expect(call.env.HARNESS_WORKTREE_ID).toBeUndefined()
            expect(call.env.HARNESS_STATE_DIR).toBeUndefined()
            expect(call.timeoutMs).toBe(WORKFLOW_TIMEOUT_BUDGETS.shipGateCommandMs)
          }
          expect(events).toEqual([startedEvent, finishedEvent])
        }),
      ),
  )

  it.live(
    "executeStageCommandImpl detects done JSON block, avoids verify friction double-count, and trips circuit breaker after 3 failures",
    () =>
      withTempRepo((repoRoot) =>
        Effect.gen(function* () {
          initRepoWithMain(repoRoot)

          // 1. done exitCode 0 with {"decision":"block"} fails with durationMs populated
          const doneFail = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "done",
                treeHash: makeSampleHash(),
                repoRoot,
              },
              {
                nowMs: (() => {
                  let t = 100
                  return () => {
                    t += 35
                    return t
                  }
                })(),
                runCommand: () =>
                  Effect.succeed({
                    _tag: "Exited",
                    exitCode: 0,
                    stdout: JSON.stringify({ decision: "block", reason: "Verify stamp missing" }),
                    stderr: "",
                  }),
              },
            ),
          )
          expect(doneFail.stage).toBe("done")
          expect(doneFail.exitCode).toBe(GateExitCode.make(1))
          expect(doneFail.stderrSummary).toBe("Verify stamp missing")
          expect(doneFail.circuitBreakerStatus).toBe("clear")
          expect(doneFail.durationMs).toBe(GateDurationMs.make(35))

          // 2. verify stage that already wrote verify_failure to friction-log.jsonl is NOT double-counted
          const verifyFail = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "verify",
                treeHash: makeSampleHash(),
                repoRoot,
              },
              {
                runCommand: () => {
                  appendFrictionEvent(
                    repoRoot,
                    {
                      kind: "verify_failure",
                      summary: "nx affected verify",
                      detail: "unit test failed",
                      timestamp: "2026-11-24T10:00:00.000Z",
                    },
                    cleanFrictionHostIo,
                  )
                  return Effect.succeed({
                    _tag: "Exited",
                    exitCode: 2,
                    stdout: "",
                    stderr: "unit test failed",
                  })
                },
              },
            ),
          )
          expect(verifyFail.exitCode).toBe(GateExitCode.make(2))
          const eventsAfterVerify = readFrictionEvents(repoRoot, cleanFrictionHostIo)
          expect(eventsAfterVerify).toHaveLength(2) // 1 from done + 1 from verify (not 2 from verify!)

          // 3. Repeated gc-strict failures trip LoopCircuitBreaker.decide on the 3rd failure
          const runGcFailure = (res: SyncHostExecResult) =>
            Effect.flip(
              executeStageCommandImpl(
                {
                  runId: makeRunId(),
                  attempt: makeAttempt(),
                  stage: "gc-strict",
                  treeHash: makeSampleHash(),
                  repoRoot,
                },
                { runCommand: () => Effect.succeed(res) },
              ),
            )

          const err1 = yield* runGcFailure({ _tag: "TimedOut", stdout: "", stderr: "gc timed out" })
          expect(err1.circuitBreakerStatus).toBe("clear")
          const err2 = yield* runGcFailure({
            _tag: "Signaled",
            signal: "SIGTERM",
            stdout: "",
            stderr: "killed",
          })
          expect(err2.circuitBreakerStatus).toBe("clear")
          expect(err2.exitCode).toBe(GateExitCode.make(143))
          const err3 = yield* runGcFailure({
            _tag: "SpawnFailed",
            spawnError: "ENOENT pnpm",
            stdout: "",
            stderr: "",
          })
          expect(err3.circuitBreakerStatus).toBe("tripped")
          expect(err3.escalationMessage).toContain("ESCALATE: STUCK LOOP DETECTED")

          // 4. Effect failure from runCommand maps cleanly to ShipGateFailedError
          const effectErr = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "ontology-check-strict",
                treeHash: makeSampleHash(),
                repoRoot,
              },
              {
                runCommand: () =>
                  Effect.fail(
                    new WorkspaceFsError({
                      filePath: WorkspaceFilePath.make(repoRoot),
                      operation: WorkspaceFsOperation.make("read"),
                      reason: ErrorReasonMessage.make("spawn crashed"),
                    }),
                  ),
              },
            ),
          )
          expect(effectErr.stage).toBe("ontology-check-strict")
          expect(effectErr.stderrSummary).toContain("spawn crashed")
          expect(
            match(effectErr)
              .with({ _tag: "ShipGateFailedError" }, (e) => e.message)
              .exhaustive(),
          ).toContain("ontology-check-strict")
        }),
      ),
  )

  it.live(
    "strips HARNESS_WORKTREE_ID/HARNESS_STATE_DIR in computeTreeHashImpl and omits actual hash when recoverMutationBackupImpl hash fails",
    () =>
      withTempRepo((repoRoot) =>
        Effect.gen(function* () {
          initRepoWithMain(repoRoot)
          const cleanHash = yield* computeTreeHashImpl({
            runId: makeRunId(),
            attempt: makeAttempt(),
            stage: "verify",
            repoRoot,
          })
          // HARNESS_STATE_DIR pointing at `libs` would alter the tree hash if NOT stripped by withoutWorktreeEnv
          const envHash = yield* computeTreeHashImpl(
            { runId: makeRunId(), attempt: makeAttempt(), stage: "verify", repoRoot },
            {
              env: {
                ...process.env,
                HARNESS_WORKTREE_ID: "unit-9",
                HARNESS_STATE_DIR: join(repoRoot, "libs"),
              },
            },
          )
          expect(envHash).toBe(cleanHash)

          // Corrupt backup + post-recovery tree hash failure -> actual is omitted (undefined)
          mkdirSync(join(repoRoot, ".harness"), { recursive: true })
          writeFileSync(join(repoRoot, ".harness", "mutation-backup.json"), "{corrupt")
          const failingHashHostIo: typeof nodeSyncHostIo = {
            ...nodeSyncHostIo,
            isSymbolicLinkSync: (p) => (p === repoRoot ? true : false),
          }
          const err1 = yield* Effect.flip(
            recoverMutationBackupImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                expectedTreeHash: cleanHash,
                repoRoot,
              },
              { hostIo: failingHashHostIo },
            ),
          )
          expect(err1).toBeInstanceOf(MutationRestoreError)
          expect(err1.actual).toBeUndefined()
          expect(err1.message).toContain("actual hash unavailable")
          expect(err1.detail).toContain("Post-recovery tree hash failed")
        }),
      ),
  )

  it.live(
    "executeStageCommandImpl runs non-empty format-check with '--' separator and covers alreadyRecordedVerify negative paths",
    () =>
      withTempRepo((repoRoot) =>
        Effect.gen(function* () {
          initRepoWithMain(repoRoot)
          writeFileSync(join(repoRoot, "libs", "demo", "src", "dirty.ts"), "export const x=1\n")
          const spawned: Array<{ readonly cmd: string; readonly args: ReadonlyArray<string> }> = []

          const passed = yield* executeStageCommandImpl(
            {
              runId: makeRunId(),
              attempt: makeAttempt(),
              stage: "format-check",
              treeHash: makeSampleHash(),
              repoRoot,
            },
            {
              runCommand: (cmd, args) => {
                spawned.push({ cmd, args })
                return Effect.succeed({ _tag: "Exited", exitCode: 0, stdout: "", stderr: "" })
              },
            },
          )
          expect(passed.stage).toBe("format-check")
          expect(spawned).toEqual([
            { cmd: "pnpm", args: ["exec", "oxfmt", "--check", "--", "libs/demo/src/dirty.ts"] },
          ])

          // Neg 1: stage !== "verify" even when a verify_failure event was appended during command
          yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "gc-strict",
                repoRoot,
                treeHash: makeSampleHash(),
              },
              {
                runCommand: () => {
                  appendFrictionEvent(
                    repoRoot,
                    {
                      kind: "verify_failure",
                      summary: "s1",
                      detail: "d1",
                      timestamp: "2026-11-24T10:00:00.000Z",
                    },
                    cleanFrictionHostIo,
                  )
                  return Effect.succeed({
                    _tag: "Exited",
                    exitCode: 1,
                    stdout: "",
                    stderr: "gc fail",
                  })
                },
              },
            ),
          )
          expect(readFrictionEvents(repoRoot, cleanFrictionHostIo)).toHaveLength(2)

          // Neg 2: stage === "verify" when afterFriction.length === beforeFriction.length
          yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "verify",
                repoRoot,
                treeHash: makeSampleHash(),
              },
              {
                runCommand: () =>
                  Effect.succeed({ _tag: "Exited", exitCode: 1, stdout: "", stderr: "v fail" }),
              },
            ),
          )
          expect(readFrictionEvents(repoRoot, cleanFrictionHostIo)).toHaveLength(3)

          // Neg 3: stage === "verify" when afterFriction grew but last event kind !== "verify_failure"
          yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "verify",
                repoRoot,
                treeHash: makeSampleHash(),
              },
              {
                runCommand: () => {
                  appendFrictionEvent(
                    repoRoot,
                    {
                      kind: "route_miss",
                      summary: "tool",
                      detail: "d",
                      timestamp: "2026-11-24T10:01:00.000Z",
                    },
                    cleanFrictionHostIo,
                  )
                  return Effect.succeed({
                    _tag: "Exited",
                    exitCode: 1,
                    stdout: "",
                    stderr: "v fail 2",
                  })
                },
              },
            ),
          )
          const events = readFrictionEvents(repoRoot, cleanFrictionHostIo)
          expect(events).toHaveLength(5)
          expect(events[4]?.kind).toBe("verify_failure")
        }),
      ),
  )

  it.live(
    "clamps exitCode/duration/unknown-signal, enforces 4096/2048 char boundaries, and uses stdout-only diagnostics",
    () =>
      withTempRepo((repoRoot) =>
        Effect.gen(function* () {
          initRepoWithMain(repoRoot)
          let call = 0
          const times = [1000, 500, 1000, 1000, 1000, 1000, 1000, 1000]
          const nowMs = () => {
            const val = times[call] ?? 1000
            call += 1
            return val
          }

          // 1. Over-length 4097-char stderr, exitCode > 255 -> 255, negative duration -> 0, toShipFailureMessage <= 2048
          const hugeErr = `HEAD${"x".repeat(4093)}`
          expect(hugeErr.length).toBe(4097)
          const errBig = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "gc-strict",
                repoRoot,
                treeHash: makeSampleHash(),
              },
              {
                nowMs,
                runCommand: () =>
                  Effect.succeed({ _tag: "Exited", exitCode: 999, stdout: "", stderr: hugeErr }),
              },
            ),
          )
          expect(errBig.exitCode).toBe(GateExitCode.make(255))
          expect(errBig.durationMs).toBe(GateDurationMs.make(0))
          expect(errBig.stderrSummary.length).toBe(4096)
          expect(errBig.stderrSummary.startsWith("EAD")).toBe(true)
          expect(toShipFailureMessage(errBig).length).toBe(2048)

          // Boundary: 2049-char stderr fits within stderrSummary (4096) while toShipFailureMessage truncates to 2048
          const err2049 = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "gc-strict",
                repoRoot,
                treeHash: makeSampleHash(),
              },
              {
                runCommand: () =>
                  Effect.succeed({
                    _tag: "Exited",
                    exitCode: 1,
                    stdout: "",
                    stderr: "y".repeat(2049),
                  }),
              },
            ),
          )
          expect(err2049.stderrSummary.length).toBe(2049)
          expect(toShipFailureMessage(err2049).length).toBe(2048)

          // 2. exitCode < 1 (-5) -> clamped to 1, empty stderr + stdout -> fallback message
          const errNegCode = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "mutate-strict",
                repoRoot,
                treeHash: makeSampleHash(),
              },
              {
                runCommand: () =>
                  Effect.succeed({ _tag: "Exited", exitCode: -5, stdout: "   ", stderr: "  " }),
              },
            ),
          )
          expect(errNegCode.exitCode).toBe(GateExitCode.make(1))
          expect(errNegCode.stderrSummary).toContain("exited with code -5")

          // 3. Unknown signal -> clamped to exitCode 1, stdout-only diagnostic
          const errUnknownSig = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "done",
                repoRoot,
                treeHash: makeSampleHash(),
              },
              {
                runCommand: () =>
                  Effect.succeed({
                    _tag: "Signaled",
                    signal: "SIGUNKNOWN",
                    stdout: "stdout only sig",
                    stderr: "  ",
                  }),
              },
            ),
          )
          expect(errUnknownSig.exitCode).toBe(GateExitCode.make(1))
          expect(errUnknownSig.stderrSummary).toBe("stdout only sig")

          // 4. TimedOut with stdout-only diagnostic + Exited with stdout-only diagnostic
          const errStdoutTimeout = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "verify",
                repoRoot,
                treeHash: makeSampleHash(),
              },
              {
                runCommand: () =>
                  Effect.succeed({ _tag: "TimedOut", stdout: "stdout timeout", stderr: "" }),
              },
            ),
          )
          expect(errStdoutTimeout.stderrSummary).toBe("stdout timeout")

          const errStdoutExit = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId: makeRunId(),
                attempt: makeAttempt(),
                stage: "ontology-check-strict",
                repoRoot,
                treeHash: makeSampleHash(),
              },
              {
                runCommand: () =>
                  Effect.succeed({
                    _tag: "Exited",
                    exitCode: 3,
                    stdout: "stdout exit",
                    stderr: "",
                  }),
              },
            ),
          )
          expect(errStdoutExit.stderrSummary).toBe("stdout exit")
        }),
      ),
  )

  it.live(
    "resolveShipFormatCheckFiles excludes pnpm-lock.yaml, coverage/**, .worktrees/**, .idea/**, and custom .oxfmtrc.json patterns while keeping nested repos/ and src/dist/",
    () =>
      withTempRepo((repoRoot) =>
        Effect.sync(() => {
          initRepoWithMain(repoRoot)
          execFileSync("git", ["checkout", "-b", "feat/ignore-patterns"], {
            cwd: repoRoot,
            stdio: "ignore",
          })

          writeFileSync(
            join(repoRoot, ".oxfmtrc.json"),
            `${JSON.stringify({ ignorePatterns: ["generated/**"] }, null, 2)}\n`,
          )
          writeFileSync(join(repoRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
          mkdirSync(join(repoRoot, "coverage"), { recursive: true })
          writeFileSync(join(repoRoot, "coverage", "x.js"), "export {}\n")
          mkdirSync(join(repoRoot, ".worktrees", "u1"), { recursive: true })
          writeFileSync(join(repoRoot, ".worktrees", "u1", "x.ts"), "export const w = 1\n")
          mkdirSync(join(repoRoot, ".idea"), { recursive: true })
          writeFileSync(join(repoRoot, ".idea", "x.json"), "{}\n")
          mkdirSync(join(repoRoot, "generated", "sub"), { recursive: true })
          writeFileSync(join(repoRoot, "generated", "sub", "x.ts"), "export const g = 1\n")
          mkdirSync(join(repoRoot, "libs", "demo", "repos"), { recursive: true })
          writeFileSync(join(repoRoot, "libs", "demo", "repos", "kept.yml"), "key: val\n")
          mkdirSync(join(repoRoot, "libs", "demo", "src", "dist"), { recursive: true })
          writeFileSync(join(repoRoot, "libs", "demo", "src", "dist", "kept.js"), "export {}\n")

          const res = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(res).toEqual(
            Result.succeed([
              ".oxfmtrc.json",
              "libs/demo/repos/kept.yml",
              "libs/demo/src/dist/kept.js",
            ]),
          )
        }),
      ),
  )

  it.live(
    "resolveShipFormatCheckFiles resolves dynamic default branch via refs/remotes/origin/HEAD across multi-commit trunk branch",
    () =>
      withTempRepo((repoRoot) =>
        Effect.sync(() => {
          execFileSync("git", ["init", "-b", "trunk"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["config", "user.email", "wf4@example.com"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          execFileSync("git", ["config", "user.name", "WF4 Tester"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          mkdirSync(join(repoRoot, "src"), { recursive: true })
          writeFileSync(join(repoRoot, "src", "root.ts"), "export const root = 1\n")
          execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["commit", "-m", "trunk root"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["update-ref", "refs/remotes/origin/trunk", "HEAD"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          execFileSync(
            "git",
            ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"],
            { cwd: repoRoot, stdio: "ignore" },
          )

          execFileSync("git", ["checkout", "-b", "feat/multi"], { cwd: repoRoot, stdio: "ignore" })
          writeFileSync(join(repoRoot, "src", "commit1.ts"), "export const c1 = 1\n")
          execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["commit", "-m", "commit 1"], { cwd: repoRoot, stdio: "ignore" })
          writeFileSync(join(repoRoot, "src", "commit2.ts"), "export const c2 = 2\n")
          execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["commit", "-m", "commit 2"], { cwd: repoRoot, stdio: "ignore" })

          const res = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(res).toEqual(Result.succeed(["src/commit1.ts", "src/commit2.ts"]))
        }),
      ),
  )

  it.live(
    "ShipActiveGateController cancelAndAwait aborts an in-flight slow command and waits for it to settle",
    () =>
      withTempRepo((repoRoot) =>
        Effect.gen(function* () {
          initRepoWithMain(repoRoot)
          const controller = createShipActiveGateController()
          const commandStarted = yield* Deferred.make<void>()
          const commandReaped = yield* Deferred.make<void>()
          let settledBeforeCancelReturned = false

          const layer = makeShipGateRunnerLayer({
            repoRoot,
            activeGateController: controller,
            runCommand: () =>
              Effect.sync(() => {
                Deferred.doneUnsafe(commandStarted, Effect.void)
              }).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sleep("25 millis").pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        settledBeforeCancelReturned = true
                        Deferred.doneUnsafe(commandReaped, Effect.void)
                      }),
                    ),
                  ),
                ),
              ),
          })

          const runId = makeRunId()
          const attempt = makeAttempt()
          const key = `${runId}:${attempt}`

          const execFiber = yield* Effect.gen(function* () {
            const runner = yield* ShipGateRunner
            return yield* Effect.exit(
              runner.executeStageCommand({
                runId,
                attempt,
                stage: "verify",
                treeHash: makeSampleHash(),
              }),
            )
          }).pipe(Effect.provide(layer), Effect.forkChild)

          yield* Deferred.await(commandStarted)
          yield* controller.cancelAndAwait(key)
          expect(settledBeforeCancelReturned).toBe(true)
          yield* Deferred.await(commandReaped)

          const exit = yield* Fiber.await(execFiber)
          const failCause = match(exit)
            .with({ _tag: "Success" }, ({ value }) =>
              match(value)
                .with({ _tag: "Failure" }, ({ cause }) => cause)
                .with({ _tag: "Success" }, () =>
                  expect.unreachable("Expected inner executeStageCommand Failure"),
                )
                .exhaustive(),
            )
            .with({ _tag: "Failure" }, ({ cause }) =>
              expect.unreachable(
                `Expected outer fiber Success wrapping Exit, got ${Cause.pretty(cause)}`,
              ),
            )
            .exhaustive()
          expect(Cause.hasDies(failCause)).toBe(false)
          expect(Cause.hasFails(failCause)).toBe(true)
          match(Cause.findErrorOption(failCause))
            .with({ _tag: "None" }, () => expect.unreachable("Expected typed ShipGateFailedError"))
            .with({ _tag: "Some" }, ({ value: gateErr }) => {
              expect(gateErr).toBeInstanceOf(ShipGateFailedError)
              expect(gateErr.stage).toBe("verify")
              expect(gateErr.exitCode).toBe(GateExitCode.make(1))
              expect(gateErr.stderrSummary).toContain("cancelled")
            })
            .exhaustive()

          // Pre-cancelled key before starting fails immediately without spawning
          const preCancelErr = yield* Effect.flip(
            executeStageCommandImpl(
              {
                runId,
                attempt,
                stage: "gc-strict",
                treeHash: makeSampleHash(),
                repoRoot,
              },
              {
                activeGateController: controller,
                runCommand: () => Effect.die(new Error("Should not spawn when pre-cancelled")),
              },
            ),
          )
          expect(preCancelErr.stderrSummary).toContain("cancelled before starting")
          controller.clear(key)

          // reportStageProgress delivers Failed progress events directly
          const reported: Array<ShipStreamProgressEvent> = []
          const progressLayer = makeShipGateRunnerLayer({
            repoRoot,
            onProgress: (ev) => reported.push(ev),
          })
          const failProgressEvent = ShipStreamProgressEvent.cases.StageFinished.make({
            runId,
            attempt,
            progress: ShipStageFailed.make({
              stage: "verify",
              durationMs: GateDurationMs.make(42),
              errorTag: ShipErrorTag.make("ShipGateFailedError"),
              detail: ShipFailureMessage.make("verify failed"),
            }),
          })
          yield* Effect.gen(function* () {
            const runner = yield* ShipGateRunner
            yield* runner.reportStageProgress(failProgressEvent)
          }).pipe(Effect.provide(progressLayer))
          const directEvent = ShipStreamProgressEvent.cases.StageStarted.make({
            runId,
            attempt,
            stage: "gc-strict",
          })
          yield* reportStageProgressImpl(directEvent, { onProgress: (ev) => reported.push(ev) })
          yield* reportStageProgressImpl(directEvent)
          expect(reported).toEqual([failProgressEvent, directEvent])
        }),
      ),
  )

  it.live(
    "ship-format-files covers wildcards, non-trailing **, ReDoS protection, slashless boundary, and corrupt/symlink .oxfmtrc.json",
    () =>
      withTempRepo((repoRoot) =>
        Effect.sync(() => {
          initRepoWithMain(repoRoot)
          execFileSync("git", ["checkout", "-b", "feat/glob-branches"], {
            cwd: repoRoot,
            stdio: "ignore",
          })

          writeFileSync(
            join(repoRoot, ".oxfmtrc.json"),
            JSON.stringify({
              ignorePatterns: [
                "./leading-dot/",
                "/leading-slash/**",
                "!kept/not-ignored.ts",
                "a/**/**/b/**/gen/*.ts",
                "foo*bar.ts",
                "v?.js",
                "a*b*c.ts",
                "*.min.js",
                "**/x/**/x/**/x/**/x/**/x/**/x/**/x/**/x/**/x/**/x/**/x/**/needle.ts",
              ],
            }),
          )
          for (const rel of [
            "leading-dot/skip.ts",
            "leading-slash/skip.ts",
            "kept/not-ignored.ts",
            "a/b/gen/zero-seg.ts",
            "a/mid1/b/mid2/gen/deep.ts",
            "foo-mid-bar.ts",
            "foo/nested-bar.ts",
            "v1.js",
            "v12.js",
            "aaXXbbYYc.ts",
            "app.min.js",
            "x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/other.ts",
          ]) {
            const full = join(repoRoot, rel)
            mkdirSync(join(full, ".."), { recursive: true })
            writeFileSync(full, "// x\n")
          }

          const started = performance.now()
          const res = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(performance.now() - started).toBeLessThan(1000)
          expect(res).toEqual(
            Result.succeed([
              ".oxfmtrc.json",
              "foo/nested-bar.ts",
              "kept/not-ignored.ts",
              "v12.js",
              "x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/x/other.ts",
            ]),
          )

          // Corrupt .oxfmtrc.json falls back cleanly to DEFAULT_OXFMT_IGNORE_PATTERNS
          writeFileSync(join(repoRoot, ".oxfmtrc.json"), "{not-valid-json")
          writeFileSync(join(repoRoot, "pnpm-lock.yaml"), "lock\n")
          const corruptRes = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(Result.isSuccess(corruptRes)).toBe(true)
          expect(Result.getOrElse(corruptRes, () => [])).not.toContain("pnpm-lock.yaml")

          // Symlinked .oxfmtrc.json is rejected safely and falls back to defaults
          writeFileSync(
            join(repoRoot, "real-cfg.json"),
            JSON.stringify({ ignorePatterns: ["foo/*"] }),
          )
          rmSync(join(repoRoot, ".oxfmtrc.json"))
          symlinkSync(join(repoRoot, "real-cfg.json"), join(repoRoot, ".oxfmtrc.json"))
          const symRes = resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)
          expect(Result.getOrElse(symRes, () => [])).toContain("foo/nested-bar.ts")
        }),
      ),
  )

  it.live(
    "ship-format-files covers init.defaultBranch, non-origin symref, unsafe ref rejection, invalid SHA, and 128/129 fail-closed exits",
    () =>
      withTempRepo((repoRoot) =>
        Effect.sync(() => {
          execFileSync("git", ["init", "-b", "develop"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["config", "user.email", "wf4@example.com"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          execFileSync("git", ["config", "user.name", "WF4 Tester"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          execFileSync("git", ["config", "init.defaultBranch", "develop"], {
            cwd: repoRoot,
            stdio: "ignore",
          })
          mkdirSync(join(repoRoot, "src"), { recursive: true })
          writeFileSync(join(repoRoot, "src", "root.ts"), "export const r = 1\n")
          execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["commit", "-m", "root"], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["checkout", "-b", "feat/dev"], { cwd: repoRoot, stdio: "ignore" })
          writeFileSync(join(repoRoot, "src", "d1.ts"), "export const d1 = 1\n")
          execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["commit", "-m", "c1"], { cwd: repoRoot, stdio: "ignore" })
          writeFileSync(join(repoRoot, "src", "d2.ts"), "export const d2 = 2\n")
          execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" })
          execFileSync("git", ["commit", "-m", "c2"], { cwd: repoRoot, stdio: "ignore" })

          expect(resolveShipFormatCheckFiles(repoRoot, nodeSyncHostIo, process.env)).toEqual(
            Result.succeed(["src/d1.ts", "src/d2.ts"]),
          )

          // Fake IO checks: non-origin/ symref + unsafe candidate rejected, 128/129 fail closed, invalid mbSha fail closed
          const shaA = "a".repeat(40)
          const shaB = "b".repeat(40)
          const seenRefs: Array<ReadonlyArray<string>> = []
          const symAndUnsafeHostIo: SyncHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (_cmd, args) => {
              if (args[0] === "symbolic-ref") {
                return { _tag: "Exited", exitCode: 0, stdout: "upstream/trunk\n", stderr: "" }
              }
              if (args[0] === "config") {
                return { _tag: "Exited", exitCode: 0, stdout: "--default=HEAD\n", stderr: "" }
              }
              if (args[0] === "rev-parse") {
                seenRefs.push(args)
                return {
                  _tag: "Exited",
                  exitCode: args[args.length - 1] === "HEAD" ? 0 : 1,
                  stdout: `${shaA}\n`,
                  stderr: "",
                }
              }
              return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
            },
          }
          expect(
            Result.isSuccess(resolveShipFormatCheckFiles(repoRoot, symAndUnsafeHostIo, {})),
          ).toBe(true)
          expect(seenRefs.some((a) => a.includes("--default=HEAD"))).toBe(false)
          expect(seenRefs.some((a) => a.includes("upstream/trunk"))).toBe(true)

          for (const exitCode of [128, 129]) {
            const symFailIo: SyncHostIo = {
              ...nodeSyncHostIo,
              execFileSync: (_cmd, args) =>
                args[0] === "symbolic-ref"
                  ? { _tag: "Exited", exitCode, stdout: "", stderr: `symref ${exitCode}` }
                  : { _tag: "Exited", exitCode: 0, stdout: `${shaA}\n`, stderr: "" },
            }
            expect(Result.isFailure(resolveShipFormatCheckFiles(repoRoot, symFailIo, {}))).toBe(
              true,
            )

            const cfgFailIo: SyncHostIo = {
              ...nodeSyncHostIo,
              execFileSync: (_cmd, args) =>
                args[0] === "config"
                  ? { _tag: "Exited", exitCode, stdout: "", stderr: `config ${exitCode}` }
                  : args[0] === "symbolic-ref"
                    ? { _tag: "Exited", exitCode: 1, stdout: "", stderr: "" }
                    : { _tag: "Exited", exitCode: 0, stdout: `${shaA}\n`, stderr: "" },
            }
            expect(Result.isFailure(resolveShipFormatCheckFiles(repoRoot, cfgFailIo, {}))).toBe(
              true,
            )
          }

          const badMbShaIo: SyncHostIo = {
            ...nodeSyncHostIo,
            execFileSync: (_cmd, args) => {
              if (args[0] === "symbolic-ref" || args[0] === "config") {
                return { _tag: "Exited", exitCode: 1, stdout: "", stderr: "" }
              }
              if (args[0] === "merge-base") {
                return { _tag: "Exited", exitCode: 0, stdout: "--not-a-sha\n", stderr: "" }
              }
              return { _tag: "Exited", exitCode: 0, stdout: `${shaA}\n`, stderr: "" }
            },
          }
          const badMbRes = resolveShipFormatCheckFiles(repoRoot, badMbShaIo, {})
          expect(Result.isFailure(badMbRes)).toBe(true)

          const badHeadShaIo: SyncHostIo = {
            ...nodeSyncHostIo,
            execFileSync: () => ({
              _tag: "Exited",
              exitCode: 0,
              stdout: `${shaB.slice(0, 5)}\n`,
              stderr: "",
            }),
          }
          expect(Result.isFailure(resolveShipFormatCheckFiles(repoRoot, badHeadShaIo, {}))).toBe(
            true,
          )
        }),
      ),
  )
})
