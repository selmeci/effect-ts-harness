import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  ErrorReasonMessage,
  GateExitCode,
  MutationRestoreError,
  SHIP_STAGES,
  ShipAttempt,
  ShipGateFailedError,
  ShipStagePassed,
  ShipStreamProgressEvent,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowRunId,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
  WorkspaceTreeHash,
} from "@harness/contract"
import { appendFrictionEvent, readFrictionEvents } from "@harness/gates"
import { ShipGateRunner } from "@harness/service"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../src/node-host-io.js"
import {
  computeTreeHashImpl,
  executeStageCommandImpl,
  extractDoneStdoutBlockReason,
  makeShipGateRunnerLayer,
  recoverMutationBackupImpl,
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
              if (args[0] === "rev-parse")
                return { _tag: "Exited", exitCode: 0, stdout: "abc\n", stderr: "" }
              if (args[0] === "merge-base")
                return { _tag: "Exited", exitCode: 0, stdout: "def\n", stderr: "" }
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

        const events: Array<ShipStreamProgressEvent> = []
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
              onProgress: (ev) => events.push(ev),
            },
          ),
        )
        expect(stageErr).toBeInstanceOf(ShipGateFailedError)
        expect(stageErr.stderrSummary).toContain("ENOBUFS")
        expect(events).toHaveLength(2)
        expect(events[1]?._tag).toBe("StageFinished")
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

          // 0 changed files -> format-check passes without spawning
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
          // 6 StageStarted + 6 StageFinished events
          expect(events).toHaveLength(12)
          expect(events[0]?._tag).toBe("StageStarted")
          expect(events[1]?._tag).toBe("StageFinished")
        }),
      ),
  )

  it.live(
    "executeStageCommandImpl detects done JSON block, avoids verify friction double-count, and trips circuit breaker after 3 failures",
    () =>
      withTempRepo((repoRoot) =>
        Effect.gen(function* () {
          initRepoWithMain(repoRoot)

          // 1. done exitCode 0 with {"decision":"block"} fails
          const doneEvents: Array<ShipStreamProgressEvent> = []
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
                onProgress: (ev) => doneEvents.push(ev),
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
          expect(doneEvents).toHaveLength(2)
          const lastDoneEvent = doneEvents[1]
          expect(lastDoneEvent?._tag).toBe("StageFinished")
          if (lastDoneEvent !== undefined) {
            const progressTag = match(lastDoneEvent)
              .with({ _tag: "StageFinished" }, ({ progress }) => progress._tag)
              .with({ _tag: "StageStarted" }, () => "StageStarted" as const)
              .exhaustive()
            expect(progressTag).toBe("Failed")
          }

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
                    nodeSyncHostIo,
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
          const eventsAfterVerify = readFrictionEvents(repoRoot, nodeSyncHostIo)
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
    "strips HARNESS_WORKTREE_ID/HARNESS_STATE_DIR in computeTreeHashImpl and uses sentinel hash on recoverMutationBackupImpl hash failure",
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

          // Corrupt backup + post-recovery tree hash failure -> sentinel != expectedTreeHash
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
          expect(err1.actual).toBe(WorkspaceTreeHash.make("0".repeat(64)))
          expect(err1.actual).not.toBe(err1.expected)
          expect(err1.detail).toContain("Post-recovery tree hash failed")

          // When expectedTreeHash happens to be all zeros, fallback switches to "f".repeat(64)
          const zeroHash = WorkspaceTreeHash.make("0".repeat(64))
          const err2 = yield* Effect.flip(
            recoverMutationBackupImpl(
              { runId: makeRunId(), attempt: makeAttempt(), expectedTreeHash: zeroHash, repoRoot },
              { hostIo: failingHashHostIo },
            ),
          )
          expect(err2.actual).toBe(WorkspaceTreeHash.make("f".repeat(64)))
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
                    nodeSyncHostIo,
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
          expect(readFrictionEvents(repoRoot, nodeSyncHostIo)).toHaveLength(2)

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
          expect(readFrictionEvents(repoRoot, nodeSyncHostIo)).toHaveLength(3)

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
                    nodeSyncHostIo,
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
          const events = readFrictionEvents(repoRoot, nodeSyncHostIo)
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

          // 1. Over-length 4097-char stderr, exitCode > 255 -> 255, negative duration -> 0, StageFinished.detail <= 2048
          const events1: Array<ShipStreamProgressEvent> = []
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
                onProgress: (ev) => events1.push(ev),
                runCommand: () =>
                  Effect.succeed({ _tag: "Exited", exitCode: 999, stdout: "", stderr: hugeErr }),
              },
            ),
          )
          expect(errBig.exitCode).toBe(GateExitCode.make(255))
          expect(errBig.stderrSummary.length).toBe(4096)
          expect(errBig.stderrSummary.startsWith("EAD")).toBe(true)
          const finished1 = events1[1]
          expect(finished1?._tag).toBe("StageFinished")
          if (finished1 !== undefined) {
            match(finished1)
              .with({ _tag: "StageFinished" }, ({ progress }) => {
                expect(progress.durationMs).toBe(0)
                match(progress)
                  .with({ _tag: "Failed" }, (failed) => {
                    expect(failed.detail.length).toBe(2048)
                  })
                  .with({ _tag: "Passed" }, () => expect.unreachable())
                  .exhaustive()
              })
              .with({ _tag: "StageStarted" }, () => expect.unreachable())
              .exhaustive()
          }

          // Boundary: 2049-char stderr fits within stderrSummary (4096) while StageFinished.detail truncates to 2048
          const events2049: Array<ShipStreamProgressEvent> = []
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
                onProgress: (ev) => events2049.push(ev),
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
          const fin2049 = events2049[1]
          if (fin2049 !== undefined) {
            match(fin2049)
              .with({ _tag: "StageFinished" }, ({ progress }) =>
                match(progress)
                  .with({ _tag: "Failed" }, (failed) => expect(failed.detail.length).toBe(2048))
                  .with({ _tag: "Passed" }, () => expect.unreachable())
                  .exhaustive(),
              )
              .with({ _tag: "StageStarted" }, () => expect.unreachable())
              .exhaustive()
          }

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
})
