import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  DaemonProtocolMismatchError,
  DaemonSocketPath,
  GitCommonDirPath,
  LeaseEpoch,
  toErrorReasonMessage,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WorkflowDaemonCapability,
  WorkflowProtocolVersion,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
} from "@harness/contract"
import {
  handshakeWorkflowDaemon,
  queryUnixSocketLineDetailed,
  queryWorkflowDaemonCommand,
  resolveWorkflowRuntimePaths,
  UnixSocketDaemonLive,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import { startHarnessDaemonServer } from "../src/daemon/unix-socket-daemon.js"
import {
  handleWorkflowDaemonHandshake,
  WORKFLOW_DAEMON_CAPABILITIES,
} from "../src/daemon/workflow-daemon-helper.js"

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "harness-mcp-wf-daemon-"))),
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
  readonly outsideSiblingDir: string
  readonly nestedSubdir: string
  readonly otherGitRepoDir: string
} => {
  const canonicalDir = join(baseDir, "repo")
  const linkedDir = join(baseDir, "wt-linked")
  const outsideSiblingDir = join(baseDir, "outside-sibling")
  const nestedSubdir = join(canonicalDir, "libs", "nested")
  const otherGitRepoDir = join(baseDir, "other-repo")

  mkdirSync(canonicalDir, { recursive: true })
  mkdirSync(outsideSiblingDir, { recursive: true })
  mkdirSync(nestedSubdir, { recursive: true })
  mkdirSync(otherGitRepoDir, { recursive: true })

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

  const linkedSrcDir = join(linkedDir, "libs", "sample", "domain", "src")
  mkdirSync(linkedSrcDir, { recursive: true })
  writeFileSync(join(linkedSrcDir, "index.ts"), "export const linkedValue = 1\n", "utf8")

  execFileSync("git", ["init"], { cwd: otherGitRepoDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "other@example.com"], {
    cwd: otherGitRepoDir,
    stdio: "ignore",
  })
  execFileSync("git", ["config", "user.name", "Other Repo"], {
    cwd: otherGitRepoDir,
    stdio: "ignore",
  })
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: otherGitRepoDir,
    stdio: "ignore",
  })

  return { canonicalDir, linkedDir, outsideSiblingDir, nestedSubdir, otherGitRepoDir }
}

class DaemonTestError extends Schema.TaggedError<DaemonTestError>()("DaemonTestError", {
  reason: Schema.String,
}) {}

const withStartedDaemon = <A, E, R>(
  repoRoot: string,
  writerLeaseEpoch: LeaseEpoch,
  use: (socketPath: DaemonSocketPath) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DaemonTestError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => startHarnessDaemonServer(repoRoot, { writerLeaseEpoch }),
      catch: (err) => new DaemonTestError({ reason: toErrorReasonMessage(err) }),
    }),
    (handle) => use(DaemonSocketPath.make(handle.socketPath)),
    (handle) =>
      Effect.tryPromise({
        try: () => handle.close(),
        catch: (err) => new DaemonTestError({ reason: toErrorReasonMessage(err) }),
      }).pipe(Effect.ignore),
  )

describe("harness-mcp workflow daemon & linked worktrees", () => {
  it.live("handleWorkflowDaemonHandshake validates protocolVersion and commonGitDir", () =>
    Effect.gen(function* () {
      const repoRoot = AbsoluteRepoRoot.make("/tmp/wf-handshake-repo")
      const commonGitDir = GitCommonDirPath.make("/tmp/wf-handshake-repo/.git")
      const expectedSocketPath = resolveWorkflowRuntimePaths(commonGitDir).socketPath
      const validatedWorktree = {
        worktreeRoot: repoRoot,
        commonGitDir,
        kind: "canonical" as const,
      }
      const writerLeaseEpoch = LeaseEpoch.make(5)
      const emptyFnIndex = new Map<string, IndexedEffectFn>()

      const { result: okRes, spans: okSpans } = yield* runWithTestTracer(
        "WorkflowDaemonHelper.handshake::ok",
        handleWorkflowDaemonHandshake({
          repoRoot,
          commonGitDir,
          validatedWorktree,
          writerLeaseEpoch,
          request: {
            protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
            repoRoot,
            commonGitDir,
          },
        }),
        emptyFnIndex,
      )
      expect(okRes.protocolVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
      expect(okRes.capabilities).toEqual(WORKFLOW_DAEMON_CAPABILITIES)
      expect(okRes.repoRoot).toBe(repoRoot)
      expect(okRes.commonGitDir).toBe(commonGitDir)
      expect(okRes.writerLeaseEpoch).toBe(5)
      const okSpan = okSpans.find((s) => s.name === "WorkflowDaemonHelper.handshake")
      expect(okSpan?.name).toBe("WorkflowDaemonHelper.handshake")
      expect(okSpan?.exitTag).toBe("Success")

      const { result: versionErr, spans: versionSpans } = yield* runWithTestTracer(
        "WorkflowDaemonHelper.handshake::version-mismatch",
        handleWorkflowDaemonHandshake({
          repoRoot,
          commonGitDir,
          validatedWorktree,
          writerLeaseEpoch,
          request: {
            protocolVersion: WorkflowProtocolVersion.make("2"),
            repoRoot,
          },
        }).pipe(Effect.flip),
        emptyFnIndex,
      )
      expect(versionErr).toBeInstanceOf(DaemonProtocolMismatchError)
      expect(versionErr._tag).toBe("DaemonProtocolMismatchError")
      expect(versionErr.expectedVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
      expect(versionErr.actualVersion).toBe(WorkflowProtocolVersion.make("2"))
      expect(versionErr.socketPath).toBe(expectedSocketPath)
      expect(versionErr.detail).toContain("Unsupported daemon protocol version")
      const versionSpan = versionSpans.find((s) => s.name === "WorkflowDaemonHelper.handshake")
      expect(versionSpan?.name).toBe("WorkflowDaemonHelper.handshake")
      expect(versionSpan?.exitTag).toBe("Failure")

      const { result: commonDirErr, spans: commonDirSpans } = yield* runWithTestTracer(
        "WorkflowDaemonHelper.handshake::common-dir-mismatch",
        handleWorkflowDaemonHandshake({
          repoRoot,
          commonGitDir,
          validatedWorktree,
          writerLeaseEpoch,
          request: {
            protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
            repoRoot,
            commonGitDir: GitCommonDirPath.make("/tmp/other-repo/.git"),
          },
        }).pipe(Effect.flip),
        emptyFnIndex,
      )
      expect(commonDirErr).toBeInstanceOf(DaemonProtocolMismatchError)
      expect(commonDirErr._tag).toBe("DaemonProtocolMismatchError")
      expect(commonDirErr.expectedVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
      expect(commonDirErr.actualVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
      expect(commonDirErr.socketPath).toBe(expectedSocketPath)
      expect(commonDirErr.detail).toContain("commonGitDir mismatch")
      const commonDirSpan = commonDirSpans.find((s) => s.name === "WorkflowDaemonHelper.handshake")
      expect(commonDirSpan?.name).toBe("WorkflowDaemonHelper.handshake")
      expect(commonDirSpan?.exitTag).toBe("Failure")
    }),
  )

  it.live(
    "binds at <git-common-dir>/harness/daemon.sock, accepts linked worktree requests, rejects outside dirs, and enforces handshake protocol/capabilities",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir, linkedDir, outsideSiblingDir, nestedSubdir, otherGitRepoDir } =
            initGitRepoWithWorktree(dir)

          const validatedCanonical = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const validatedLinked = yield* validateWorktreeRepoRoot(AbsoluteRepoRoot.make(linkedDir))
          const expectedRuntimePaths = resolveWorkflowRuntimePaths(validatedCanonical.commonGitDir)
          const leaseEpoch = LeaseEpoch.make(7)
          const emptyFnIndex = new Map<string, IndexedEffectFn>()

          // 0. Dead socket before daemon starts -> WorkflowStoreUnavailableError
          const { result: deadSocketErr, spans: deadSpans } = yield* runWithTestTracer(
            "HarnessDaemonClient.handshake::dead-socket",
            handshakeWorkflowDaemon({
              socketPath: expectedRuntimePaths.socketPath,
              request: {
                protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                repoRoot: validatedLinked.worktreeRoot,
                commonGitDir: validatedLinked.commonGitDir,
              },
              requiredCapabilities: [WorkflowDaemonCapability.make("workflow.handshake")],
            }).pipe(Effect.flip),
            emptyFnIndex,
          )
          match(deadSocketErr)
            .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
              expect(err).toBeInstanceOf(WorkflowStoreUnavailableError)
              expect(err.operation).toBe(
                WorkflowStoreOperation.make("HarnessDaemonClient.handshake"),
              )
              expect(err.reason).toContain(expectedRuntimePaths.socketPath)
            })
            .with({ _tag: "DaemonProtocolMismatchError" }, (err) => {
              expect.unreachable(`Expected WorkflowStoreUnavailableError, got ${err.message}`)
            })
            .exhaustive()
          const deadSpan = deadSpans.find((s) => s.name === "HarnessDaemonClient.handshake")
          expect(deadSpan?.name).toBe("HarnessDaemonClient.handshake")
          expect(deadSpan?.exitTag).toBe("Failure")

          yield* withStartedDaemon(canonicalDir, leaseEpoch, (socketPath) =>
            Effect.gen(function* () {
              expect(realpathSync.native(socketPath)).toBe(
                realpathSync.native(expectedRuntimePaths.socketPath),
              )
              expect(existsSync(socketPath)).toBe(true)

              // 1. Ping from linked worktree succeeds
              const pingResult = yield* queryUnixSocketLineDetailed(
                socketPath,
                JSON.stringify({ id: "ping-linked", command: "ping", repoRoot: linkedDir }),
                { timeoutMs: 5000 },
              )
              const pingLine = match(pingResult)
                .with({ _tag: "Reply" }, ({ line }) => line)
                .with({ _tag: "Unavailable" }, ({ reason }) => {
                  expect.unreachable(`Expected ping reply, got ${reason}`)
                  return ""
                })
                .exhaustive()
              expect(JSON.parse(pingLine)).toMatchObject({
                id: "ping-linked",
                ok: true,
                status: "warm",
              })

              // 2. AST gates from linked worktree succeeds
              const astReply = yield* queryWorkflowDaemonCommand({
                socketPath,
                command: "ast-gates",
                payload: {
                  repoRoot: linkedDir,
                  files: ["libs/sample/domain/src/index.ts"],
                },
              })
              expect(astReply.ok).toBe(true)

              // 3. workflow.handshake from linked worktree succeeds via handshakeWorkflowDaemon
              const { result: handshake, spans: okClientSpans } = yield* runWithTestTracer(
                "HarnessDaemonClient.handshake::linked-ok",
                handshakeWorkflowDaemon({
                  socketPath,
                  request: {
                    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                    repoRoot: validatedLinked.worktreeRoot,
                    commonGitDir: validatedLinked.commonGitDir,
                  },
                  requiredCapabilities: [
                    WorkflowDaemonCapability.make("workflow.handshake"),
                    WorkflowDaemonCapability.make("workflow.status"),
                  ],
                }),
                emptyFnIndex,
              )
              expect(handshake.protocolVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
              expect(handshake.capabilities).toEqual(WORKFLOW_DAEMON_CAPABILITIES)
              expect(handshake.repoRoot).toBe(validatedLinked.worktreeRoot)
              expect(handshake.commonGitDir).toBe(validatedCanonical.commonGitDir)
              expect(handshake.writerLeaseEpoch).toBe(7)
              const okClientSpan = okClientSpans.find(
                (s) => s.name === "HarnessDaemonClient.handshake",
              )
              expect(okClientSpan?.name).toBe("HarnessDaemonClient.handshake")
              expect(okClientSpan?.exitTag).toBe("Success")

              // 4. workflow.status from linked worktree succeeds
              const statusReply = yield* queryWorkflowDaemonCommand({
                socketPath,
                command: "workflow.status",
                payload: { repoRoot: linkedDir },
              })
              expect(statusReply).toMatchObject({
                ok: true,
                command: "workflow.status",
                status: "ready",
                protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                repoRoot: validatedLinked.worktreeRoot,
                commonGitDir: validatedCanonical.commonGitDir,
                worktreeKind: "linked",
                writerLeaseEpoch: 7,
              })

              // 5. Unregistered sibling directory, nested subdir, unrelated git repo, and empty repoRoot fail closed
              for (const rejectedRoot of [outsideSiblingDir, nestedSubdir, otherGitRepoDir, ""]) {
                const rejectedReply = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "ping",
                  payload: { repoRoot: rejectedRoot },
                })
                expect(rejectedReply.ok).toBe(false)
                expect(String(rejectedReply.error)).toContain("escapes daemon root")
              }

              // 6. handshakeWorkflowDaemon fails with DaemonProtocolMismatchError on protocolVersion "2"
              const { result: mismatchErr, spans: mismatchSpans } = yield* runWithTestTracer(
                "HarnessDaemonClient.handshake::version-mismatch",
                handshakeWorkflowDaemon({
                  socketPath,
                  request: {
                    protocolVersion: WorkflowProtocolVersion.make("2"),
                    repoRoot: validatedLinked.worktreeRoot,
                    commonGitDir: validatedLinked.commonGitDir,
                  },
                  requiredCapabilities: [WorkflowDaemonCapability.make("workflow.handshake")],
                }).pipe(Effect.flip),
                emptyFnIndex,
              )
              match(mismatchErr)
                .with({ _tag: "DaemonProtocolMismatchError" }, (err) => {
                  expect(err).toBeInstanceOf(DaemonProtocolMismatchError)
                  expect(err.expectedVersion).toBe(WorkflowProtocolVersion.make("2"))
                  expect(err.actualVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
                  expect(err.socketPath).toBe(socketPath)
                  expect(err.detail).toContain("Unsupported daemon protocol version")
                })
                .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
                  expect.unreachable(`Expected DaemonProtocolMismatchError, got ${err.message}`)
                })
                .exhaustive()
              const mismatchSpan = mismatchSpans.find(
                (s) => s.name === "HarnessDaemonClient.handshake",
              )
              expect(mismatchSpan?.name).toBe("HarnessDaemonClient.handshake")
              expect(mismatchSpan?.exitTag).toBe("Failure")

              // 7. handshakeWorkflowDaemon fails with DaemonProtocolMismatchError on missing required capability
              const { result: missingCapErr, spans: missingCapSpans } = yield* runWithTestTracer(
                "HarnessDaemonClient.handshake::missing-capability",
                handshakeWorkflowDaemon({
                  socketPath,
                  request: {
                    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                    repoRoot: validatedLinked.worktreeRoot,
                    commonGitDir: validatedLinked.commonGitDir,
                  },
                  requiredCapabilities: [
                    WorkflowDaemonCapability.make("workflow.handshake"),
                    WorkflowDaemonCapability.make("workflow.execute"),
                  ],
                }).pipe(Effect.flip),
                emptyFnIndex,
              )
              match(missingCapErr)
                .with({ _tag: "DaemonProtocolMismatchError" }, (err) => {
                  expect(err).toBeInstanceOf(DaemonProtocolMismatchError)
                  expect(err.expectedVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
                  expect(err.actualVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
                  expect(err.socketPath).toBe(socketPath)
                  expect(err.detail).toContain("workflow.execute")
                })
                .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
                  expect.unreachable(`Expected DaemonProtocolMismatchError, got ${err.message}`)
                })
                .exhaustive()
              const missingCapSpan = missingCapSpans.find(
                (s) => s.name === "HarnessDaemonClient.handshake",
              )
              expect(missingCapSpan?.name).toBe("HarnessDaemonClient.handshake")
              expect(missingCapSpan?.exitTag).toBe("Failure")

              // 8. handshakeWorkflowDaemon fails with DaemonProtocolMismatchError on commonGitDir mismatch
              const { result: wrongGitDirErr, spans: wrongGitDirSpans } = yield* runWithTestTracer(
                "HarnessDaemonClient.handshake::common-dir-mismatch",
                handshakeWorkflowDaemon({
                  socketPath,
                  request: {
                    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                    repoRoot: validatedLinked.worktreeRoot,
                    commonGitDir: GitCommonDirPath.make("/other/repo/.git"),
                  },
                  requiredCapabilities: [WorkflowDaemonCapability.make("workflow.handshake")],
                }).pipe(Effect.flip),
                emptyFnIndex,
              )
              match(wrongGitDirErr)
                .with({ _tag: "DaemonProtocolMismatchError" }, (err) => {
                  expect(err).toBeInstanceOf(DaemonProtocolMismatchError)
                  expect(err.expectedVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
                  expect(err.actualVersion).toBe(WORKFLOW_DAEMON_PROTOCOL_VERSION)
                  expect(err.socketPath).toBe(socketPath)
                  expect(err.detail).toContain("commonGitDir mismatch")
                })
                .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
                  expect.unreachable(`Expected DaemonProtocolMismatchError, got ${err.message}`)
                })
                .exhaustive()
              const wrongGitDirSpan = wrongGitDirSpans.find(
                (s) => s.name === "HarnessDaemonClient.handshake",
              )
              expect(wrongGitDirSpan?.name).toBe("HarnessDaemonClient.handshake")
              expect(wrongGitDirSpan?.exitTag).toBe("Failure")
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))

          expect(existsSync(expectedRuntimePaths.socketPath)).toBe(false)
        }),
      ),
  )
})
