import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  DaemonSocketPath,
  GitCommonDirPath,
  LeaseEpoch,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WorkflowDaemonCapability,
  WorkflowProtocolVersion,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  DAEMON_SOCKET_TIMEOUT_MS,
  DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
  queryUnixSocketLine,
  queryUnixSocketLineDetailed,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
} from "../src/unix-socket-daemon-live.js"
import {
  handshakeWorkflowDaemon,
  queryWorkflowDaemonCommand,
  WORKFLOW_DAEMON_IPC_TIMEOUT_MS,
} from "../src/workflow/daemon-client.js"
import { resolveWorkflowRuntimePaths, validateWorktreeRepoRoot } from "../src/worktree-repo-root.js"

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "wf2-wt-"))),
    use,
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true })
      }),
  )

const initGitRepoWithWorktree = (
  baseDir: string,
): {
  readonly canonicalDir: string
  readonly linkedDir: string
  readonly unregisteredDir: string
  readonly nestedSubdir: string
} => {
  const canonicalDir = join(baseDir, "repo")
  const linkedDir = join(baseDir, "wt-linked")
  const unregisteredDir = join(baseDir, "outside")
  const nestedSubdir = join(canonicalDir, "packages", "sub")

  mkdirSync(canonicalDir, { recursive: true })
  mkdirSync(unregisteredDir, { recursive: true })
  mkdirSync(nestedSubdir, { recursive: true })

  execFileSync("git", ["init"], { cwd: canonicalDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "wf2@example.com"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  execFileSync("git", ["config", "user.name", "WF2 Test"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })
  execFileSync("git", ["worktree", "add", "-b", "slice/wf2-linked", linkedDir, "HEAD"], {
    cwd: canonicalDir,
    stdio: "ignore",
  })

  return { canonicalDir, linkedDir, unregisteredDir, nestedSubdir }
}

describe("WF-2 Worktree Validation & Daemon Protocol", () => {
  it.live(
    "validates canonical and linked worktrees, rejects unregistered/nested paths, and resolves shared <git-common-dir>/harness/daemon.sock",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir, linkedDir, unregisteredDir, nestedSubdir } =
            initGitRepoWithWorktree(dir)

          const canonicalValidated = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const linkedValidated = yield* validateWorktreeRepoRoot(AbsoluteRepoRoot.make(linkedDir))

          expect(canonicalValidated.kind).toBe("canonical")
          expect(canonicalValidated.worktreeRoot).toBe(realpathSync.native(canonicalDir))
          expect(canonicalValidated.commonGitDir).toBe(
            realpathSync.native(join(canonicalDir, ".git")),
          )

          expect(linkedValidated.kind).toBe("linked")
          expect(linkedValidated.worktreeRoot).toBe(realpathSync.native(linkedDir))
          expect(linkedValidated.commonGitDir).toBe(canonicalValidated.commonGitDir)

          const runtimePaths = resolveWorkflowRuntimePaths(canonicalValidated.commonGitDir)
          const canonicalSocket = resolveHarnessDaemonSocketPath(canonicalDir)
          const linkedSocket = resolveHarnessDaemonSocketPath(linkedDir)

          expect(canonicalSocket).toBe(runtimePaths.socketPath)
          expect(linkedSocket).toBe(runtimePaths.socketPath)
          expect(Buffer.byteLength(canonicalSocket, "utf8")).toBeLessThanOrEqual(107)

          const outsideErr = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(unregisteredDir),
          ).pipe(Effect.flip)
          expect(outsideErr._tag).toBe("WorkflowStoreUnavailableError")

          const nestedErr = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(nestedSubdir),
          ).pipe(Effect.flip)
          expect(nestedErr._tag).toBe("WorkflowStoreUnavailableError")

          const missingErr = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(join(dir, "does-not-exist")),
          ).pipe(Effect.flip)
          expect(missingErr._tag).toBe("WorkflowStoreUnavailableError")

          const prunableDir = join(dir, "wt-prunable")
          execFileSync(
            "git",
            ["worktree", "add", "-b", "slice/wf2-prunable", prunableDir, "HEAD"],
            {
              cwd: canonicalDir,
              stdio: "ignore",
            },
          )
          rmSync(prunableDir, { recursive: true, force: true })

          const prunableErr = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(prunableDir),
          ).pipe(Effect.flip)
          expect(prunableErr._tag).toBe("WorkflowStoreUnavailableError")
        }),
      ),
  )

  it.live(
    "startScopedUnixSocketDaemon creates <git-common-dir>/harness recursively and shares socket across canonical and linked worktrees",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir, linkedDir } = initGitRepoWithWorktree(dir)
          const expectedHarnessDir = join(canonicalDir, ".git", "harness")
          expect(existsSync(expectedHarnessDir)).toBe(false)

          const socketPathAfterExit = yield* Effect.scoped(
            Effect.gen(function* () {
              const info = yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(linkedDir))
              expect(info.socketPath).toBe(resolveHarnessDaemonSocketPath(canonicalDir))
              expect(existsSync(expectedHarnessDir)).toBe(true)
              expect(statSync(expectedHarnessDir).mode & 0o777).toBe(0o700)
              expect(statSync(info.socketPath).mode & 0o777).toBe(0o600)

              const pingFromCanonical = yield* queryUnixSocketLine(
                resolveHarnessDaemonSocketPath(canonicalDir),
                "ping",
                1000,
              )
              expect(pingFromCanonical._tag).toBe("Some")
              return info.socketPath
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))

          expect(existsSync(socketPathAfterExit)).toBe(false)
        }),
      ),
  )

  it.live(
    "handshakeWorkflowDaemon verifies protocolVersion, capabilities, and leaseEpoch, and fails closed on mismatch, stale daemon, or dead socket",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir, linkedDir } = initGitRepoWithWorktree(dir)
          const validatedCanonical = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const capHandshake = WorkflowDaemonCapability.make("workflow.handshake")
          const capStatus = WorkflowDaemonCapability.make("workflow.status")
          const capExecute = WorkflowDaemonCapability.make("workflow.execute")
          const socketPath = resolveHarnessDaemonSocketPath(linkedDir)

          // Dead socket -> WorkflowStoreUnavailableError
          const deadErr = yield* handshakeWorkflowDaemon({
            socketPath,
            request: {
              protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
              repoRoot: validatedCanonical.worktreeRoot,
              commonGitDir: validatedCanonical.commonGitDir,
            },
            requiredCapabilities: [capHandshake, capStatus],
          }).pipe(Effect.flip)
          expect(deadErr._tag).toBe("WorkflowStoreUnavailableError")

          // Valid handshake + queryWorkflowDaemonCommand
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = JSON.parse(line) as {
                      readonly id?: string
                      readonly command?: string
                    }
                    if (parsed.command === "workflow.handshake") {
                      return JSON.stringify({
                        id: parsed.id,
                        ok: true,
                        protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                        capabilities: [capHandshake, capStatus],
                        repoRoot: validatedCanonical.worktreeRoot,
                        commonGitDir: validatedCanonical.commonGitDir,
                        writerLeaseEpoch: LeaseEpoch.make(7),
                      })
                    }
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      command: parsed.command,
                      echoed: true,
                    })
                  }),
              })

              const handshake = yield* handshakeWorkflowDaemon({
                socketPath,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                  commonGitDir: validatedCanonical.commonGitDir,
                },
                requiredCapabilities: [capHandshake, capStatus],
              })
              expect(handshake.protocolVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
              expect(handshake.writerLeaseEpoch).toBe(7)
              expect(handshake.commonGitDir).toBe(validatedCanonical.commonGitDir)
              expect(handshake.capabilities).toEqual([capHandshake, capStatus])

              // Missing required capability -> DaemonProtocolMismatchError
              const missingCapErr = yield* handshakeWorkflowDaemon({
                socketPath,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                },
                requiredCapabilities: [capHandshake, capExecute],
              }).pipe(Effect.flip)
              expect(missingCapErr._tag).toBe("DaemonProtocolMismatchError")

              // Helper command query
              const cmdReply = yield* queryWorkflowDaemonCommand({
                socketPath,
                command: "workflow.status",
                payload: { runId: "run-12345678" },
              })
              expect(cmdReply.ok).toBe(true)
              expect(cmdReply.echoed).toBe(true)
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))

          // Mismatched protocolVersion ("2" vs "1") -> DaemonProtocolMismatchError
          const overrideSock = DaemonSocketPath.make(join(dir, "mismatch.sock"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: overrideSock,
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = JSON.parse(line) as { readonly id?: string }
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      protocolVersion: WorkflowProtocolVersion.make("2"),
                      capabilities: [capHandshake, capStatus],
                      repoRoot: validatedCanonical.worktreeRoot,
                      commonGitDir: validatedCanonical.commonGitDir,
                      writerLeaseEpoch: LeaseEpoch.make(1),
                    })
                  }),
              })

              const versionErr = yield* handshakeWorkflowDaemon({
                socketPath: overrideSock,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                },
                requiredCapabilities: [capHandshake],
              }).pipe(Effect.flip)
              match(versionErr)
                .with({ _tag: "DaemonProtocolMismatchError" }, (mismatchErr) => {
                  expect(mismatchErr.expectedVersion).toBe(WorkflowProtocolVersion.make("1"))
                  expect(mismatchErr.actualVersion).toBe(WorkflowProtocolVersion.make("2"))
                })
                .with({ _tag: "WorkflowStoreUnavailableError" }, () => {
                  expect.unreachable("Expected DaemonProtocolMismatchError")
                })
                .exhaustive()
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))

          // Stale daemon ("unknown command" / legacy payload missing protocolVersion)
          const staleSock = DaemonSocketPath.make(join(dir, "stale.sock"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: staleSock,
                lineHandler: () =>
                  Effect.succeed(
                    JSON.stringify({ ok: false, error: "Invalid daemon request payload" }),
                  ),
              })

              const staleErr = yield* handshakeWorkflowDaemon({
                socketPath: staleSock,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                },
                requiredCapabilities: [capHandshake],
              }).pipe(Effect.flip)
              expect(staleErr._tag).toBe("DaemonProtocolMismatchError")
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))

          const legacySock = DaemonSocketPath.make(join(dir, "legacy.sock"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: legacySock,
                lineHandler: () => Effect.succeed(JSON.stringify({ ok: true, status: "warm" })),
              })

              const legacyErr = yield* handshakeWorkflowDaemon({
                socketPath: legacySock,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                },
                requiredCapabilities: [capHandshake],
              }).pipe(Effect.flip)
              expect(legacyErr._tag).toBe("DaemonProtocolMismatchError")
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))

          // CommonGitDir mismatch -> DaemonProtocolMismatchError
          const mismatchGitDirSock = DaemonSocketPath.make(join(dir, "wrong-gitdir.sock"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: mismatchGitDirSock,
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = JSON.parse(line) as { readonly id?: string }
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                      capabilities: [capHandshake],
                      repoRoot: validatedCanonical.worktreeRoot,
                      commonGitDir: GitCommonDirPath.make("/other/repo/.git"),
                      writerLeaseEpoch: LeaseEpoch.make(2),
                    })
                  }),
              })

              const gitDirErr = yield* handshakeWorkflowDaemon({
                socketPath: mismatchGitDirSock,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                  commonGitDir: validatedCanonical.commonGitDir,
                },
                requiredCapabilities: [capHandshake],
              }).pipe(Effect.flip)
              expect(gitDirErr._tag).toBe("DaemonProtocolMismatchError")
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.live(
    "decouples workflow IPC timeout from the 5s LSP query socket timeout and supports >5s daemon responses",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          expect(DAEMON_SOCKET_TIMEOUT_MS).toBe(5000)
          expect(WORKFLOW_DAEMON_IPC_TIMEOUT_MS).toBe(30_000)
          expect(DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)

          const { canonicalDir } = initGitRepoWithWorktree(dir)
          const validatedCanonical = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const capHandshake = WorkflowDaemonCapability.make("workflow.handshake")
          const slowSock = DaemonSocketPath.make(join(dir, "slow-daemon.sock"))

          yield* Effect.scoped(
            Effect.gen(function* () {
              // Uses default server socket timeout (>= 30_000ms), NOT the 5000ms LSP timeout
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: slowSock,
                lineHandler: (line) =>
                  Effect.gen(function* () {
                    const parsed = JSON.parse(line) as {
                      readonly id?: string
                      readonly command?: string
                    }
                    if (parsed.command === "workflow.handshake") {
                      yield* Effect.sleep("5200 millis")
                      return JSON.stringify({
                        id: parsed.id,
                        ok: true,
                        protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                        capabilities: [capHandshake],
                        repoRoot: validatedCanonical.worktreeRoot,
                        commonGitDir: validatedCanonical.commonGitDir,
                        writerLeaseEpoch: LeaseEpoch.make(4),
                      })
                    }
                    yield* Effect.sleep("400 millis")
                    return JSON.stringify({ id: parsed.id, ok: true })
                  }),
              })

              // Fast query with explicit short { timeoutMs: 100 } times out cleanly
              const fastTimeoutRes = yield* queryUnixSocketLineDetailed(
                slowSock,
                JSON.stringify({ id: "fast", command: "ping" }),
                { timeoutMs: 100 },
              )
              match(fastTimeoutRes)
                .with({ _tag: "Unavailable" }, (unavail) => {
                  expect(unavail.reason).toBe("timeout")
                })
                .with({ _tag: "Reply" }, () => {
                  expect.unreachable("Expected timeout for fast 100ms query")
                })
                .exhaustive()

              // Workflow handshake exceeding 5000ms completes cleanly without server or client disconnect
              const slowHandshake = yield* handshakeWorkflowDaemon({
                socketPath: slowSock,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                  commonGitDir: validatedCanonical.commonGitDir,
                },
                requiredCapabilities: [capHandshake],
              })
              expect(slowHandshake.writerLeaseEpoch).toBe(4)
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
    15_000,
  )
})
