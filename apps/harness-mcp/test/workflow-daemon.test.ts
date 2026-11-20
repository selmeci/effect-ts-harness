import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
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
import { AST_GATE_RULE_SOURCE_FILES } from "@harness/gates"
import {
  handshakeWorkflowDaemon,
  queryUnixSocketLineDetailed,
  queryWorkflowDaemonCommand,
  resolveWorkflowRuntimePaths,
  UnixSocketDaemonLive,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import {
  type StartHarnessDaemonServerOptions,
  startHarnessDaemonServer,
} from "../src/daemon/unix-socket-daemon.js"
import {
  handleDaemonWorkflowHandshakeRequest,
  handleDaemonWorkflowStatusRequest,
  handleWorkflowDaemonHandshake,
  makeDaemonWorktreeScopeCache,
  resolveDaemonRequestScope,
  resolveOptionalWorktree,
  WORKFLOW_DAEMON_CAPABILITIES,
} from "../src/daemon/workflow-daemon-helper.js"

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "hmcp-wf-"))),
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
  const linkedDir = join(baseDir, "wt")
  const outsideSiblingDir = join(baseDir, "outside")
  const nestedSubdir = join(canonicalDir, "libs", "nested")
  const otherGitRepoDir = join(baseDir, "other")

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
  options: StartHarnessDaemonServerOptions,
  use: (socketPath: DaemonSocketPath) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DaemonTestError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => startHarnessDaemonServer(repoRoot, options),
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
    "binds at <git-common-dir>/harness/daemon.sock, caches worktree validation (F-8.1), enforces canonical handshake envelope (F-16.1/F-17.5), and reports status accurately (F-1.2)",
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

          let validateCallCount = 0
          const countingValidator = (absRoot: AbsoluteRepoRoot) => {
            validateCallCount += 1
            return validateWorktreeRepoRoot(absRoot)
          }

          yield* withStartedDaemon(
            canonicalDir,
            { writerLeaseEpoch: leaseEpoch, validateWorktree: countingValidator },
            (socketPath) =>
              Effect.gen(function* () {
                expect(realpathSync.native(socketPath)).toBe(
                  realpathSync.native(expectedRuntimePaths.socketPath),
                )
                expect(existsSync(socketPath)).toBe(true)
                // Only 1 startup validation call before any requests arrive
                expect(validateCallCount).toBe(1)

                // 1. Canonical ping requests hit startup cache with 0 extra git worktree spawns (F-8.1)
                for (let idx = 0; idx < 3; idx += 1) {
                  const canonicalPing = yield* queryWorkflowDaemonCommand({
                    socketPath,
                    command: "ping",
                    payload: idx === 0 ? undefined : { repoRoot: canonicalDir },
                  })
                  expect(canonicalPing).toMatchObject({
                    ok: true,
                    status: "warm",
                    cacheHit: true,
                  })
                }
                expect(validateCallCount).toBe(1)

                // 2. First ping from linked worktree validates once, then subsequent calls hit LRU cache (F-8.1)
                const linkedPing1 = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "ping",
                  payload: { repoRoot: linkedDir },
                })
                expect(linkedPing1).toMatchObject({ ok: true, status: "warm", cacheHit: false })
                expect(validateCallCount).toBe(2)

                const linkedPing2Result = yield* queryUnixSocketLineDetailed(
                  socketPath,
                  JSON.stringify({ id: "ping-linked", command: "ping", repoRoot: linkedDir }),
                  { timeoutMs: 5000 },
                )
                const linkedPing2Line = match(linkedPing2Result)
                  .with({ _tag: "Reply" }, ({ line }) => line)
                  .with({ _tag: "Unavailable" }, ({ reason }) => {
                    expect.unreachable(`Expected ping reply, got ${reason}`)
                    return ""
                  })
                  .exhaustive()
                expect(JSON.parse(linkedPing2Line)).toMatchObject({
                  id: "ping-linked",
                  ok: true,
                  status: "warm",
                  cacheHit: true,
                })
                expect(validateCallCount).toBe(2)

                // 3. AST gates from linked worktree succeeds
                const astReply = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "ast-gates",
                  payload: {
                    repoRoot: linkedDir,
                    files: ["libs/sample/domain/src/index.ts"],
                  },
                })
                expect(astReply.ok).toBe(true)

                // 4. Raw workflow.handshake returns canonical { id, ok: true, command, handshake } envelope (F-16.1)
                const rawHandshake = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "workflow.handshake",
                  payload: {
                    repoRoot: validatedLinked.worktreeRoot,
                    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                    commonGitDir: validatedLinked.commonGitDir,
                  },
                })
                expect(rawHandshake).toMatchObject({
                  ok: true,
                  command: "workflow.handshake",
                  handshake: {
                    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                    capabilities: [...WORKFLOW_DAEMON_CAPABILITIES],
                    repoRoot: validatedLinked.worktreeRoot,
                    commonGitDir: validatedCanonical.commonGitDir,
                    writerLeaseEpoch: 7,
                  },
                })
                expect(rawHandshake.protocolVersion).toBeUndefined()

                // 5. workflow.handshake from linked worktree succeeds via handshakeWorkflowDaemon
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

                // 6. workflow.status from linked worktree succeeds with status: "ready" (epoch >= 1)
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
                // Subsequent linked worktree calls still triggered 0 extra git worktree spawns
                expect(validateCallCount).toBe(2)

                // 7. Unregistered sibling directory, nested subdir, unrelated git repo, and empty repoRoot fail closed
                for (const rejectedRoot of [outsideSiblingDir, nestedSubdir, otherGitRepoDir, ""]) {
                  const rejectedReply = yield* queryWorkflowDaemonCommand({
                    socketPath,
                    command: "ping",
                    payload: { repoRoot: rejectedRoot },
                  })
                  expect(rejectedReply.ok).toBe(false)
                  expect(String(rejectedReply.error)).toContain("escapes daemon root")
                }

                // 8. handshakeWorkflowDaemon fails with DaemonProtocolMismatchError on protocolVersion "2"
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

                // 9. handshakeWorkflowDaemon fails with DaemonProtocolMismatchError on missing required capability
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

                // 10. handshakeWorkflowDaemon fails with DaemonProtocolMismatchError on commonGitDir mismatch
                const { result: wrongGitDirErr, spans: wrongGitDirSpans } =
                  yield* runWithTestTracer(
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

  it.live(
    "F-1.2 & F-1.3: workflow.status reports 'inactive' when writerLeaseEpoch === 0 or non-git, and handshakeWorkflowDaemon rejects epoch 0 unless requireActiveLease: false",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir } = initGitRepoWithWorktree(dir)
          const validatedCanonical = yield* validateWorktreeRepoRoot(
            AbsoluteRepoRoot.make(canonicalDir),
          )
          const nonGitDir = join(dir, "non-git")
          mkdirSync(nonGitDir, { recursive: true })

          // Non-git unit check even if epoch > 0 -> inactive
          const nonGitEpochOneStatus = handleDaemonWorkflowStatusRequest({
            requestId: "s-nongit",
            scope: {
              _tag: "Allowed",
              resolvedRoot: nonGitDir,
              validatedWorktree: undefined,
              daemonWorktree: undefined,
            },
            writerLeaseEpoch: LeaseEpoch.make(1),
          })
          expect(nonGitEpochOneStatus.status).toBe("inactive")

          yield* withStartedDaemon(
            canonicalDir,
            { writerLeaseEpoch: LeaseEpoch.make(0) },
            (socketPath) =>
              Effect.gen(function* () {
                const statusReply = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "workflow.status",
                  payload: { repoRoot: canonicalDir },
                })
                expect(statusReply).toMatchObject({
                  ok: true,
                  command: "workflow.status",
                  status: "inactive",
                  writerLeaseEpoch: 0,
                })

                const activeReqErr = yield* handshakeWorkflowDaemon({
                  socketPath,
                  request: {
                    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                    repoRoot: validatedCanonical.worktreeRoot,
                    commonGitDir: validatedCanonical.commonGitDir,
                  },
                  requiredCapabilities: [WorkflowDaemonCapability.make("workflow.handshake")],
                }).pipe(Effect.flip)
                expect(activeReqErr._tag).toBe("DaemonProtocolMismatchError")

                const passiveRes = yield* handshakeWorkflowDaemon({
                  socketPath,
                  request: {
                    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                    repoRoot: validatedCanonical.worktreeRoot,
                    commonGitDir: validatedCanonical.commonGitDir,
                  },
                  requiredCapabilities: [WorkflowDaemonCapability.make("workflow.handshake")],
                  requireActiveLease: false,
                })
                expect(passiveRes.writerLeaseEpoch).toBe(0)
              }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.live(
    "F-8.1: bounded LRU cache evicts oldest linked worktree after maxEntries without re-validating canonical root",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir } = initGitRepoWithWorktree(dir)
          const wt2 = join(dir, "wt2")
          const wt3 = join(dir, "wt3")
          execFileSync("git", ["worktree", "add", "-b", "slice/wt2", wt2, "HEAD"], {
            cwd: canonicalDir,
            stdio: "ignore",
          })
          execFileSync("git", ["worktree", "add", "-b", "slice/wt3", wt3, "HEAD"], {
            cwd: canonicalDir,
            stdio: "ignore",
          })
          const wt1 = join(dir, "wt")

          let calls = 0
          const cache = yield* makeDaemonWorktreeScopeCache(canonicalDir, {
            maxEntries: 2,
            validateWorktree: (absRoot) => {
              calls += 1
              return validateWorktreeRepoRoot(absRoot)
            },
          })
          expect(calls).toBe(1)

          // Canonical hit -> 0 spawns
          const cHit = yield* cache.resolveRequestScope(canonicalDir)
          expect(cHit).toMatchObject({ _tag: "Allowed", cacheHit: true })
          expect(calls).toBe(1)

          // Miss wt1, miss wt2, hit wt1 (moves wt1 to MRU), miss wt3 (evicts wt2)
          yield* cache.resolveRequestScope(wt1)
          yield* cache.resolveRequestScope(wt2)
          const hitWt1 = yield* cache.resolveRequestScope(wt1)
          expect(hitWt1).toMatchObject({ _tag: "Allowed", cacheHit: true })
          yield* cache.resolveRequestScope(wt3)
          expect(calls).toBe(4)

          // wt1 still cached, wt2 was evicted -> miss
          const hitWt1Again = yield* cache.resolveRequestScope(wt1)
          expect(hitWt1Again).toMatchObject({ _tag: "Allowed", cacheHit: true })
          expect(calls).toBe(4)

          const missWt2 = yield* cache.resolveRequestScope(wt2)
          expect(missWt2).toMatchObject({ _tag: "Allowed", cacheHit: false })
          expect(calls).toBe(5)
          expect(cache.getStats().cachedLinkedCount).toBe(2)
        }),
      ),
  )

  it.live(
    "F-9.1: ast-gates and extract-graph reject linked worktree with drifted ruleVersion via fallbackToInProcess: true without breaking canonical cache",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir, linkedDir } = initGitRepoWithWorktree(dir)

          const seedWorktree = (root: string, ruleTag: string): void => {
            const sampleDir = join(root, "libs", "sample", "domain", "src")
            mkdirSync(sampleDir, { recursive: true })
            writeFileSync(join(sampleDir, "index.ts"), "export const sampleValue = 1\n", "utf8")
            writeFileSync(join(root, "tsconfig.base.json"), '{"compilerOptions":{}}\n', "utf8")
            writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
            for (const rel of AST_GATE_RULE_SOURCE_FILES) {
              const abs = join(root, rel)
              mkdirSync(join(abs, ".."), { recursive: true })
              writeFileSync(abs, `// ${ruleTag} ${rel}\n`, "utf8")
            }
          }

          seedWorktree(canonicalDir, "shared-v1")
          seedWorktree(linkedDir, "shared-v1")

          yield* withStartedDaemon(
            canonicalDir,
            { writerLeaseEpoch: LeaseEpoch.make(1) },
            (socketPath) =>
              Effect.gen(function* () {
                // Matching rules in linked worktree succeed
                const linkedOkAst = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "ast-gates",
                  payload: {
                    repoRoot: linkedDir,
                    files: ["libs/sample/domain/src/index.ts"],
                  },
                })
                expect(linkedOkAst.ok).toBe(true)

                // Mutate rule file inside linked worktree only
                const driftedRulePath = join(linkedDir, AST_GATE_RULE_SOURCE_FILES[0])
                writeFileSync(driftedRulePath, "// drifted-in-linked-worktree\n", "utf8")

                const linkedDriftedAst = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "ast-gates",
                  payload: {
                    repoRoot: linkedDir,
                    files: ["libs/sample/domain/src/index.ts"],
                  },
                })
                expect(linkedDriftedAst).toMatchObject({
                  ok: false,
                  fallbackToInProcess: true,
                })
                expect(String(linkedDriftedAst.error)).toContain("Linked worktree")

                const linkedDriftedGraph = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "extract-graph",
                  payload: { repoRoot: linkedDir },
                })
                expect(linkedDriftedGraph).toMatchObject({
                  ok: false,
                  fallbackToInProcess: true,
                })
                expect(String(linkedDriftedGraph.error)).toContain("Linked worktree")

                // Canonical worktree continues serving cleanly
                const canonicalAst = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "ast-gates",
                  payload: {
                    repoRoot: canonicalDir,
                    files: ["libs/sample/domain/src/index.ts"],
                  },
                })
                expect(canonicalAst.ok).toBe(true)
              }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.live(
    "F-10.1: resolveOptionalWorktree and resolveDaemonRequestScope fail closed when .git exists with invalid worktree state",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const nonGitDir = join(dir, "non-git")
          const corruptGitFileDir = join(dir, "corrupt-git-file")
          const corruptGitDir = join(dir, "corrupt-git-dir")
          mkdirSync(nonGitDir, { recursive: true })
          mkdirSync(corruptGitFileDir, { recursive: true })
          mkdirSync(join(corruptGitDir, ".git"), { recursive: true })
          writeFileSync(
            join(corruptGitFileDir, ".git"),
            "gitdir: /nonexistent/worktree/path\n",
            "utf8",
          )

          // Genuine non-git directory -> Option.none()
          const nonGitOpt = yield* resolveOptionalWorktree(nonGitDir)
          expect(nonGitOpt._tag).toBe("None")

          // .git file or dir with invalid worktree -> fails with WorkflowStoreUnavailableError (never Option.none())
          const corruptFileErr = yield* resolveOptionalWorktree(corruptGitFileDir).pipe(Effect.flip)
          expect(corruptFileErr).toBeInstanceOf(WorkflowStoreUnavailableError)

          const corruptDirErr = yield* resolveOptionalWorktree(corruptGitDir).pipe(Effect.flip)
          expect(corruptDirErr).toBeInstanceOf(WorkflowStoreUnavailableError)

          // resolveDaemonRequestScope rejects fail-closed instead of downgrading to non-git path matching
          const scopeRejectedFile = yield* resolveDaemonRequestScope(corruptGitFileDir)
          expect(scopeRejectedFile._tag).toBe("Rejected")

          const scopeRejectedDir = yield* resolveDaemonRequestScope(corruptGitDir)
          expect(scopeRejectedDir._tag).toBe("Rejected")

          // Live daemon bound to corruptGitDir rejects requests instead of running as non-git
          yield* withStartedDaemon(
            corruptGitDir,
            { writerLeaseEpoch: LeaseEpoch.make(0) },
            (socketPath) =>
              Effect.gen(function* () {
                const pingRes = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "ping",
                })
                expect(pingRes.ok).toBe(false)
                expect(String(pingRes.error)).toContain("failed git worktree validation")
              }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.live(
    "security hardening: evicts cached linked worktree on symlink repointing, fails extract-graph & poll-changes when graph extractor drifts, and records WorkflowDaemonHelper spans",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const { canonicalDir, linkedDir, otherGitRepoDir } = initGitRepoWithWorktree(dir)
          const seedGraphSrc = (root: string, tag: string): void => {
            const sampleDir = join(root, "libs", "sample", "domain", "src")
            mkdirSync(sampleDir, { recursive: true })
            writeFileSync(join(sampleDir, "index.ts"), "export const x = 1\n", "utf8")
            writeFileSync(join(root, "tsconfig.base.json"), '{"compilerOptions":{}}\n', "utf8")
            writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
            for (const rel of AST_GATE_RULE_SOURCE_FILES) {
              const abs = join(root, rel)
              mkdirSync(join(abs, ".."), { recursive: true })
              writeFileSync(abs, "// shared rule\n", "utf8")
            }
            const graphSrcDir = join(root, "libs", "harness", "graph", "src")
            mkdirSync(graphSrcDir, { recursive: true })
            writeFileSync(join(graphSrcDir, "index.ts"), `export const extractor = "${tag}"\n`)
          }
          seedGraphSrc(canonicalDir, "v1")
          seedGraphSrc(linkedDir, "v1")

          // 1. Cross-worktree graph extractor drift fails both extract-graph and poll-changes cleanly
          yield* withStartedDaemon(
            canonicalDir,
            { writerLeaseEpoch: LeaseEpoch.make(1) },
            (socketPath) =>
              Effect.gen(function* () {
                writeFileSync(
                  join(linkedDir, "libs", "harness", "graph", "src", "index.ts"),
                  'export const extractor = "v2-drifted"\n',
                  "utf8",
                )
                const driftedGraph = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "extract-graph",
                  payload: { repoRoot: linkedDir },
                })
                expect(driftedGraph).toMatchObject({
                  ok: false,
                  fallbackToInProcess: true,
                })
                expect(String(driftedGraph.error)).toContain("graph extractor")

                const driftedPoll = yield* queryWorkflowDaemonCommand({
                  socketPath,
                  command: "poll-changes",
                  payload: { repoRoot: linkedDir, branch: "main" },
                })
                expect(driftedPoll).toMatchObject({
                  ok: false,
                  fallbackToInProcess: true,
                })
                expect(String(driftedPoll.error)).toContain("graph extractor")
              }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))

          // 2. Stale LRU entry is invalidated when linked worktree path is repointed via symlink,
          //    and runWithTestTracer records makeScopeCache, resolveRequestScope, and handleHandshakeRequest
          const emptyFnIndex = new Map<string, IndexedEffectFn>()
          const { result: scopeCache, spans: makeCacheSpans } = yield* runWithTestTracer(
            "WorkflowDaemonHelper.makeScopeCache::span",
            makeDaemonWorktreeScopeCache(canonicalDir),
            emptyFnIndex,
          )
          expect(makeCacheSpans.some((s) => s.name === "WorkflowDaemonHelper.makeScopeCache")).toBe(
            true,
          )

          const { result: initialLinkedScope, spans: resolveSpans } = yield* runWithTestTracer(
            "WorkflowDaemonHelper.resolveRequestScope::span",
            resolveDaemonRequestScope(canonicalDir, linkedDir, { scopeCache }),
            emptyFnIndex,
          )
          expect(initialLinkedScope._tag).toBe("Allowed")
          expect(
            resolveSpans.some((s) => s.name === "WorkflowDaemonHelper.resolveRequestScope"),
          ).toBe(true)

          // Repoint linkedDir -> otherGitRepoDir (unrelated repo); next cached hit must re-validate & reject
          rmSync(linkedDir, { recursive: true, force: true })
          symlinkSync(otherGitRepoDir, linkedDir)
          const repointedScope = yield* resolveDaemonRequestScope(canonicalDir, linkedDir, {
            scopeCache,
          })
          expect(repointedScope._tag).toBe("Rejected")

          // Verify handleDaemonWorkflowHandshakeRequest span + requestedRepoRoot validation
          const canonicalScope = yield* resolveDaemonRequestScope(canonicalDir, canonicalDir, {
            scopeCache,
          })
          yield* match(canonicalScope)
            .with({ _tag: "Allowed" }, (allowed) =>
              Effect.gen(function* () {
                expect(allowed.validatedWorktree).not.toBeUndefined()
                const { result: hsPayload, spans: hsReqSpans } = yield* runWithTestTracer(
                  "WorkflowDaemonHelper.handleHandshakeRequest::span",
                  handleDaemonWorkflowHandshakeRequest({
                    requestId: "hs-span-1",
                    scope: allowed,
                    writerLeaseEpoch: LeaseEpoch.make(2),
                    protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
                    requestedRepoRoot: otherGitRepoDir,
                  }),
                  emptyFnIndex,
                )
                expect(hsPayload.ok).toBe(false)
                expect(String(hsPayload.detail)).toContain("Worktree repoRoot mismatch")
                expect(
                  hsReqSpans.some((s) => s.name === "WorkflowDaemonHelper.handleHandshakeRequest"),
                ).toBe(true)
              }),
            )
            .with({ _tag: "Rejected" }, ({ error }) =>
              Effect.sync(() => {
                expect.unreachable(`Expected Allowed canonical scope, got ${error}`)
              }),
            )
            .exhaustive()
        }),
      ),
  )
})
