import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Result, Schema, Tracer } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  AttemptNumber,
  DaemonSocketPath,
  GitCommonDirPath,
  LeaseEpoch,
  PackageStampHash,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkUnitId,
  WorkflowCompleteRequest,
  WorkflowCompleteResponse,
  WorkflowDaemonCapability,
  WorkflowDoctorMode,
  WorkflowExecutionId,
  WorkflowPollAttempts,
  WorkflowPollBudget,
  WorkflowProtocolVersion,
  WorkflowRunId,
  WorkflowTimeoutBudgets,
  WorkflowTimeoutMs,
  WorkspaceFilePath,
  OwnedRelPath,
  UnitOutcome,
  validateWorkflowTimeoutBudgets,
} from "@harness/contract"
import { UnitAgentDispatcher } from "@harness/service"
import {
  DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
  WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
  queryUnixSocketLine,
  queryUnixSocketLineDetailed,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
} from "../src/unix-socket-daemon-live.js"
import { UnitAgentDispatcherLive } from "../src/workflow/agent-dispatcher-live.js"
import {
  WORKFLOW_COMPLETE_IPC_TIMEOUT_MS,
  WORKFLOW_DAEMON_IPC_TIMEOUT_MS,
  completeWorkflowViaDaemon,
  doctorWorkflowViaDaemon,
  handshakeWorkflowDaemon,
  queryWorkflowDaemonCommand,
} from "../src/workflow/daemon-client.js"
import { resolveWorkflowRuntimePaths, validateWorktreeRepoRoot } from "../src/worktree-repo-root.js"

const decodeJsonRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

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
          const relSocket = relative(canonicalValidated.commonGitDir, canonicalSocket)
          expect(relSocket).toBe("harness/daemon.sock")
          expect(Buffer.byteLength(relSocket, "utf8")).toBeLessThanOrEqual(70)

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
    "handshakeWorkflowDaemon fails with WorkflowStoreUnavailableError on missing socket and succeeds with canonical envelope",
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

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = decodeJsonRecord(line)
                    if (parsed.command === "workflow.handshake") {
                      return JSON.stringify({
                        id: parsed.id,
                        ok: true,
                        handshake: {
                          protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                          capabilities: [capHandshake, capStatus],
                          repoRoot: validatedCanonical.worktreeRoot,
                          commonGitDir: validatedCanonical.commonGitDir,
                          writerLeaseEpoch: LeaseEpoch.make(7),
                        },
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

              const missingCapErr = yield* handshakeWorkflowDaemon({
                socketPath,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                },
                requiredCapabilities: [capHandshake, capExecute],
              }).pipe(Effect.flip)
              expect(missingCapErr._tag).toBe("DaemonProtocolMismatchError")

              const cmdReply = yield* queryWorkflowDaemonCommand({
                socketPath,
                command: "workflow.status",
                payload: { runId: "run-12345678" },
              })
              expect(cmdReply.ok).toBe(true)
              expect(cmdReply.echoed).toBe(true)
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.live(
    "F-19.1: handshakeWorkflowDaemon rejects omitted writerLeaseEpoch by default (allows with requireActiveLease: false) and always rejects epoch 0",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir } = initGitRepoWithWorktree(dir)
          const validatedCanonical = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const capHandshake = WorkflowDaemonCapability.make("workflow.handshake")

          const omittedEpochSock = DaemonSocketPath.make(join(dir, "omitted-epoch.sock"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: omittedEpochSock,
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = decodeJsonRecord(line)
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      handshake: {
                        protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                        capabilities: [capHandshake],
                        repoRoot: validatedCanonical.worktreeRoot,
                        commonGitDir: validatedCanonical.commonGitDir,
                      },
                    })
                  }),
              })

              const defaultErr = yield* handshakeWorkflowDaemon({
                socketPath: omittedEpochSock,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                },
                requiredCapabilities: [capHandshake],
              }).pipe(Effect.flip)
              expect(defaultErr._tag).toBe("DaemonProtocolMismatchError")

              const allowedOmitted = yield* handshakeWorkflowDaemon({
                socketPath: omittedEpochSock,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                },
                requiredCapabilities: [capHandshake],
                requireActiveLease: false,
              })
              expect(allowedOmitted.writerLeaseEpoch).toBeUndefined()
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))

          const zeroEpochSock = DaemonSocketPath.make(join(dir, "zero-epoch.sock"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: zeroEpochSock,
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = decodeJsonRecord(line)
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      handshake: {
                        protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                        capabilities: [capHandshake],
                        repoRoot: validatedCanonical.worktreeRoot,
                        commonGitDir: validatedCanonical.commonGitDir,
                        writerLeaseEpoch: 0,
                      },
                    })
                  }),
              })

              const zeroRejected = yield* handshakeWorkflowDaemon({
                socketPath: zeroEpochSock,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                },
                requiredCapabilities: [capHandshake],
                requireActiveLease: false,
              }).pipe(Effect.flip)
              expect(zeroRejected._tag).toBe("DaemonProtocolMismatchError")
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.live(
    "handshakeWorkflowDaemon fails closed on protocolVersion, commonGitDir, repoRoot mismatches, and malformed envelopes",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir } = initGitRepoWithWorktree(dir)
          const validatedCanonical = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const capHandshake = WorkflowDaemonCapability.make("workflow.handshake")
          const capStatus = WorkflowDaemonCapability.make("workflow.status")

          const overrideSock = DaemonSocketPath.make(join(dir, "mismatch.sock"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: overrideSock,
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = decodeJsonRecord(line)
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      handshake: {
                        protocolVersion: WorkflowProtocolVersion.make("2"),
                        capabilities: [capHandshake, capStatus],
                        repoRoot: validatedCanonical.worktreeRoot,
                        commonGitDir: validatedCanonical.commonGitDir,
                        writerLeaseEpoch: LeaseEpoch.make(1),
                      },
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

          const malformedPayloads: ReadonlyArray<(requestId: string | undefined) => string> = [
            (id) =>
              JSON.stringify({
                id,
                ok: true,
                protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                capabilities: [capHandshake],
                repoRoot: validatedCanonical.worktreeRoot,
                commonGitDir: validatedCanonical.commonGitDir,
                writerLeaseEpoch: LeaseEpoch.make(1),
              }),
            (id) =>
              JSON.stringify({
                id,
                ok: true,
                result: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  capabilities: [capHandshake],
                  repoRoot: validatedCanonical.worktreeRoot,
                  commonGitDir: validatedCanonical.commonGitDir,
                  writerLeaseEpoch: LeaseEpoch.make(1),
                },
              }),
            () =>
              JSON.stringify({
                id: "wrong-request-id",
                ok: true,
                handshake: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  capabilities: [capHandshake],
                  repoRoot: validatedCanonical.worktreeRoot,
                  commonGitDir: validatedCanonical.commonGitDir,
                  writerLeaseEpoch: LeaseEpoch.make(1),
                },
              }),
            () => "{not-json",
            () => JSON.stringify({ ok: false, error: "Invalid daemon request payload" }),
            (id) =>
              JSON.stringify({
                id,
                ok: true,
                handshake: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  capabilities: [capHandshake],
                  repoRoot: validatedCanonical.worktreeRoot,
                  commonGitDir: validatedCanonical.commonGitDir,
                  writerLeaseEpoch: -1,
                },
              }),
          ]

          for (let i = 0; i < malformedPayloads.length; i += 1) {
            const makeReply = malformedPayloads[i]!
            const badSock = DaemonSocketPath.make(join(dir, `malformed-${i}.sock`))
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                  socketPathOverride: badSock,
                  lineHandler: (line) =>
                    Effect.sync(() => {
                      const parsed = decodeJsonRecord(line)
                      return makeReply(typeof parsed.id === "string" ? parsed.id : undefined)
                    }),
                })
                const err = yield* handshakeWorkflowDaemon({
                  socketPath: badSock,
                  request: {
                    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                    repoRoot: validatedCanonical.worktreeRoot,
                  },
                  requiredCapabilities: [capHandshake],
                }).pipe(Effect.flip)
                expect(err._tag).toBe("DaemonProtocolMismatchError")
              }),
            ).pipe(Effect.provide(UnixSocketDaemonLive))
          }

          const mismatchGitDirSock = DaemonSocketPath.make(join(dir, "wrong-gitdir.sock"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: mismatchGitDirSock,
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = decodeJsonRecord(line)
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      handshake: {
                        protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                        capabilities: [capHandshake],
                        repoRoot: validatedCanonical.worktreeRoot,
                        commonGitDir: GitCommonDirPath.make("/other/repo/.git"),
                        writerLeaseEpoch: LeaseEpoch.make(2),
                      },
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

          const mismatchRepoRootSock = DaemonSocketPath.make(join(dir, "wrong-reporoot.sock"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: mismatchRepoRootSock,
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = decodeJsonRecord(line)
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      handshake: {
                        protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                        capabilities: [capHandshake],
                        repoRoot: AbsoluteRepoRoot.make("/other/repo"),
                        commonGitDir: validatedCanonical.commonGitDir,
                        writerLeaseEpoch: LeaseEpoch.make(2),
                      },
                    })
                  }),
              })

              const repoRootErr = yield* handshakeWorkflowDaemon({
                socketPath: mismatchRepoRootSock,
                request: {
                  protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                  repoRoot: validatedCanonical.worktreeRoot,
                  commonGitDir: validatedCanonical.commonGitDir,
                },
                requiredCapabilities: [capHandshake],
              }).pipe(Effect.flip)
              expect(repoRootErr._tag).toBe("DaemonProtocolMismatchError")
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
          expect(DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS).toBeGreaterThan(5_000)

          const { canonicalDir } = initGitRepoWithWorktree(dir)
          const validatedCanonical = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const capHandshake = WorkflowDaemonCapability.make("workflow.handshake")
          const slowSock = DaemonSocketPath.make(join(dir, "slow-daemon.sock"))

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: slowSock,
                lineHandler: (line) =>
                  Effect.gen(function* () {
                    const parsed = decodeJsonRecord(line)
                    if (parsed.command === "workflow.handshake") {
                      yield* Effect.sleep("5200 millis")
                      return JSON.stringify({
                        id: parsed.id,
                        ok: true,
                        handshake: {
                          protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                          capabilities: [capHandshake],
                          repoRoot: validatedCanonical.worktreeRoot,
                          commonGitDir: validatedCanonical.commonGitDir,
                          writerLeaseEpoch: LeaseEpoch.make(4),
                        },
                      })
                    }
                    yield* Effect.sleep("400 millis")
                    return JSON.stringify({ id: parsed.id, ok: true })
                  }),
              })

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

              const spanNames: Array<string> = []
              const testTracer = Tracer.make({
                span: (options) => {
                  spanNames.push(options.name)
                  return new Tracer.NativeSpan(options)
                },
              })
              const queryReply = yield* queryWorkflowDaemonCommand({
                socketPath: slowSock,
                command: "ping",
              }).pipe(Effect.provideService(Tracer.Tracer, testTracer))
              expect(queryReply).toMatchObject({ ok: true })
              expect(spanNames).toContain("HarnessDaemonClient.queryCommand")
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
    15_000,
  )

  it.live(
    "F-7.1: exports WORKFLOW_COMPLETE_IPC_TIMEOUT_MS (150s) and WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS (160s) and completes workflow.complete RPCs with extended socket timeout",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          expect(WORKFLOW_COMPLETE_IPC_TIMEOUT_MS).toBe(150_000)
          expect(WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS).toBe(160_000)
          expect(WORKFLOW_COMPLETE_IPC_TIMEOUT_MS).toBeGreaterThan(120_000)
          expect(WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS).toBeGreaterThan(
            WORKFLOW_COMPLETE_IPC_TIMEOUT_MS,
          )

          const { canonicalDir } = initGitRepoWithWorktree(dir)
          const validatedCanonical = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const capComplete = WorkflowDaemonCapability.make("workflow.complete")
          const completeSock = DaemonSocketPath.make(join(dir, "complete-daemon.sock"))
          const runId = WorkflowRunId.make("run-complete-1")
          const executionId = WorkflowExecutionId.make("run-complete-1")
          const unitId = WorkUnitId.make("unit-alpha")
          const stampHash = PackageStampHash.make("a".repeat(64))
          const encodedCompleteResult = yield* Schema.encodeEffect(WorkflowCompleteResponse)(
            WorkflowCompleteResponse.cases.UnitCompleted.make({
              runId,
              executionId,
              outcome: UnitOutcome.cases.Completed.make({
                unitId,
                attempt: AttemptNumber.make(1),
                changedPaths: [OwnedRelPath.make("libs/alpha/src/index.ts")],
                packageStampHash: stampHash,
              }),
            }),
          )

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: completeSock,
                socketTimeoutMs: WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = decodeJsonRecord(line)
                    if (parsed.command === "workflow.handshake") {
                      return JSON.stringify({
                        id: parsed.id,
                        ok: true,
                        handshake: {
                          protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                          capabilities: [capComplete],
                          repoRoot: validatedCanonical.worktreeRoot,
                          commonGitDir: validatedCanonical.commonGitDir,
                          writerLeaseEpoch: LeaseEpoch.make(2),
                        },
                      })
                    }
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      command: "workflow.complete",
                      result: encodedCompleteResult,
                    })
                  }),
              })

              const res = yield* completeWorkflowViaDaemon(
                {
                  _tag: "CompleteUnit",
                  repoRoot: validatedCanonical.worktreeRoot,
                  unitId,
                  runId,
                } satisfies WorkflowCompleteRequest,
                {
                  socketPath: completeSock,
                  commonGitDir: validatedCanonical.commonGitDir,
                },
              )
              expect(res._tag).toBe("UnitCompleted")
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.effect("F-17.1: UnitAgentDispatcherLive exposes runnerKind === 'live'", () =>
    Effect.gen(function* () {
      const dispatcher = yield* UnitAgentDispatcher
      expect(dispatcher.runnerKind).toBe("live")
    }).pipe(Effect.provide(UnitAgentDispatcherLive)),
  )

  it("SPEC-0027 REQ-2.1/REQ-2.2: WORKFLOW_TIMEOUT_BUDGETS satisfies monotonicity and matches daemon/client constants", () => {
    const validated = validateWorkflowTimeoutBudgets(WORKFLOW_TIMEOUT_BUDGETS)
    expect(Result.isSuccess(validated)).toBe(true)
    const parsedBudgets: WorkflowTimeoutBudgets =
      Schema.decodeSync(WorkflowTimeoutBudgets)(WORKFLOW_TIMEOUT_BUDGETS)
    const pollBudget: WorkflowPollBudget = Schema.decodeSync(WorkflowPollBudget)({
      maxAttempts: WorkflowPollAttempts.make(parsedBudgets.pollSettleMaxAttempts),
      intervalMs: WorkflowTimeoutMs.make(parsedBudgets.pollSettleIntervalMs),
    })
    expect(pollBudget.maxAttempts * pollBudget.intervalMs).toBe(2_000)
    expect(WORKFLOW_COMPLETE_IPC_TIMEOUT_MS).toBe(parsedBudgets.workflowCompleteIpcMs)
    expect(DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS).toBe(parsedBudgets.defaultServerSocketMs)
    expect(WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS).toBe(parsedBudgets.workflowServerSocketMs)
    expect(parsedBudgets.agentRunClaudeMs).toBeGreaterThan(parsedBudgets.agentKillGraceMs)
    expect(parsedBudgets.agentRunAntigravityMs).toBeGreaterThan(
      parsedBudgets.agentStartupRetryMaxAttempts * parsedBudgets.agentStartupRetryBackoffMs,
    )
    expect(parsedBudgets.claimTimeoutMs).toBeGreaterThan(
      parsedBudgets.agentRunClaudeMs + parsedBudgets.agentKillGraceMs,
    )
  })

  it.live(
    "F-27: doctorWorkflowViaDaemon enforces active lease and WORKFLOW_COMPLETE_IPC_TIMEOUT_MS for mode='rebuild' while keeping check-only read-only",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir } = initGitRepoWithWorktree(dir)
          const validatedCanonical = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const capDoctor = WorkflowDaemonCapability.make("workflow.doctor")
          const doctorSock = DaemonSocketPath.make(join(dir, "doctor-daemon.sock"))
          let includeLeaseEpoch = false
          const recordedTimeouts: Array<number> = []
          let timeoutSpy: { readonly mockRestore: () => void } | undefined = undefined
          const spySetTimeout = function (
            this: net.Socket,
            msecs: number,
            cb?: () => void,
          ): net.Socket {
            if (msecs !== WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS) {
              recordedTimeouts.push(msecs)
            }
            timeoutSpy?.mockRestore()
            const socketResult = this.setTimeout(msecs, cb)
            timeoutSpy = vi
              .spyOn(net.Socket.prototype, "setTimeout")
              .mockImplementation(spySetTimeout)
            return socketResult
          }
          timeoutSpy = vi
            .spyOn(net.Socket.prototype, "setTimeout")
            .mockImplementation(spySetTimeout)

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(canonicalDir), {
                socketPathOverride: doctorSock,
                socketTimeoutMs: WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
                lineHandler: (line) =>
                  Effect.sync(() => {
                    const parsed = decodeJsonRecord(line)
                    if (parsed.command === "workflow.handshake") {
                      return JSON.stringify({
                        id: parsed.id,
                        ok: true,
                        handshake: {
                          protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                          capabilities: [capDoctor],
                          repoRoot: validatedCanonical.worktreeRoot,
                          commonGitDir: validatedCanonical.commonGitDir,
                          ...(includeLeaseEpoch ? { writerLeaseEpoch: LeaseEpoch.make(3) } : {}),
                        },
                      })
                    }
                    return JSON.stringify({
                      id: parsed.id,
                      ok: true,
                      command: "workflow.doctor",
                      result: {
                        repoRoot: validatedCanonical.worktreeRoot,
                        commonGitDir: validatedCanonical.commonGitDir,
                        ...(includeLeaseEpoch ? { writerLeaseEpoch: 3 } : {}),
                        rebuiltRunCount: 1,
                        checks: [],
                      },
                    })
                  }),
              })

              // 1. check-only succeeds without active writer lease and uses default IPC timeout
              recordedTimeouts.length = 0
              const checkRes = yield* doctorWorkflowViaDaemon(
                {
                  repoRoot: validatedCanonical.worktreeRoot,
                  mode: WorkflowDoctorMode.make("check-only"),
                },
                {
                  socketPath: doctorSock,
                  commonGitDir: validatedCanonical.commonGitDir,
                },
              )
              expect(checkRes.rebuiltRunCount).toBe(1)
              expect(recordedTimeouts).toEqual([
                WORKFLOW_DAEMON_IPC_TIMEOUT_MS,
                WORKFLOW_DAEMON_IPC_TIMEOUT_MS,
              ])

              // 2. rebuild rejects when writerLeaseEpoch is omitted (defaultRequireActiveLease: true)
              const missingLeaseErr = yield* doctorWorkflowViaDaemon(
                {
                  repoRoot: validatedCanonical.worktreeRoot,
                  mode: WorkflowDoctorMode.make("rebuild"),
                },
                {
                  socketPath: doctorSock,
                  commonGitDir: validatedCanonical.commonGitDir,
                },
              ).pipe(Effect.flip)
              expect(missingLeaseErr._tag).toBe("DaemonProtocolMismatchError")

              // 3. rebuild succeeds with active lease and uses WORKFLOW_COMPLETE_IPC_TIMEOUT_MS
              includeLeaseEpoch = true
              recordedTimeouts.length = 0
              const rebuildRes = yield* doctorWorkflowViaDaemon(
                {
                  repoRoot: validatedCanonical.worktreeRoot,
                  mode: WorkflowDoctorMode.make("rebuild"),
                },
                {
                  socketPath: doctorSock,
                  commonGitDir: validatedCanonical.commonGitDir,
                },
              )
              expect(rebuildRes.rebuiltRunCount).toBe(1)
              expect(recordedTimeouts).toEqual([
                WORKFLOW_DAEMON_IPC_TIMEOUT_MS,
                WORKFLOW_COMPLETE_IPC_TIMEOUT_MS,
              ])

              // 4. explicit timeoutMs overrides default on rebuild
              recordedTimeouts.length = 0
              yield* doctorWorkflowViaDaemon(
                {
                  repoRoot: validatedCanonical.worktreeRoot,
                  mode: WorkflowDoctorMode.make("rebuild"),
                },
                {
                  socketPath: doctorSock,
                  commonGitDir: validatedCanonical.commonGitDir,
                  timeoutMs: 42_000,
                },
              )
              expect(recordedTimeouts).toEqual([WORKFLOW_DAEMON_IPC_TIMEOUT_MS, 42_000])
            }),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                timeoutSpy?.mockRestore()
              }),
            ),
            Effect.provide(UnixSocketDaemonLive),
          )
        }),
      ),
  )
})
