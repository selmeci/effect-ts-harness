import { mkdirSync, realpathSync } from "node:fs"
import * as net from "node:net"
import { dirname, join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { match } from "ts-pattern"
import {
  DaemonProtocolMismatchError,
  GateDurationMs,
  GitCommonDirPath,
  PlanSha256,
  ShipAttempt,
  ShipFailureMessage,
  ShipReceipt,
  ShipStageFailed,
  ShipStagePassed,
  ShipStreamProgressEvent,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowExecutionId,
  WorkflowRunId,
  WorkflowShipResponse,
  WorkflowStoreUnavailableError,
  WorkspaceFilePath,
  WorkspaceTreeHash,
} from "@harness/contract"
import {
  SHIP_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
  UnixSocketDaemonLive,
  queryUnixSocketLineDetailed,
  startScopedUnixSocketDaemon,
} from "../src/unix-socket-daemon-live.js"
import { shipWorkflowViaDaemon } from "../src/workflow/ship-daemon-client.js"
import { resolveWorkflowRuntimePaths } from "../src/worktree-repo-root.js"
import { decodeJsonLine, initGitRepo, withTempDir } from "./helpers/workflow-verifier-fixture.js"

describe("DaemonClient shipWorkflowViaDaemon", () => {
  it.live(
    "streams NDJSON ShipStreamProgressEvent frames before returning WorkflowShipResponse",
    () =>
      withTempRepoAndSocket(({ repoRoot, commonGitDir, socketPath }) =>
        Effect.gen(function* () {
          const runId = WorkflowRunId.make("run-ship-ipc-01")
          const attempt = ShipAttempt.make(1)
          const executionId = WorkflowExecutionId.make(`${runId}:${"b".repeat(64)}:${attempt}`)
          const treeHash = WorkspaceTreeHash.make("b".repeat(64))
          const expectedResponse: WorkflowShipResponse = {
            runId,
            attempt,
            executionId,
            treeHash,
            runOrigin: "compiled",
            outcome: {
              _tag: "Passed",
              receipt: ShipReceipt.make({
                runId,
                planSha: PlanSha256.make("c".repeat(64)),
                attempt,
                verifiedTreeHash: treeHash,
              }),
              stages: [
                ShipStagePassed.make({
                  stage: "format-check",
                  durationMs: GateDurationMs.make(15),
                }),
              ],
            },
          }

          const streamedEvents: Array<ShipStreamProgressEvent> = []
          let observedTimeoutApplied = false

          expect(SHIP_DAEMON_SERVER_SOCKET_TIMEOUT_MS).toBe(
            WORKFLOW_TIMEOUT_BUDGETS.shipServerSocketMs,
          )

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
                socketPathOverride: socketPath,
                lineHandler: (line, controls) => {
                  const parsed = decodeJsonLine(line)
                  const id = parsed.id ?? ""
                  const command = parsed.command ?? ""
                  return match(command)
                    .with("workflow.handshake", () =>
                      Effect.succeed(
                        JSON.stringify({
                          id,
                          ok: true,
                          command,
                          handshake: {
                            protocolVersion: "1",
                            capabilities: ["workflow.handshake", "workflow.ship"],
                            repoRoot,
                            commonGitDir,
                            writerLeaseEpoch: 2,
                          },
                        }),
                      ),
                    )
                    .with("workflow.ship", () =>
                      Effect.sync(() => {
                        controls?.setSocketTimeoutMs(SHIP_DAEMON_SERVER_SOCKET_TIMEOUT_MS)
                        observedTimeoutApplied = controls !== undefined
                        controls?.emitLine(
                          JSON.stringify({
                            id,
                            kind: "progress",
                            event: ShipStreamProgressEvent.cases.StageStarted.make({
                              runId,
                              attempt,
                              stage: "format-check",
                            }),
                          }),
                        )
                        controls?.emitLine(
                          JSON.stringify({
                            id,
                            kind: "progress",
                            event: ShipStreamProgressEvent.cases.StageFinished.make({
                              runId,
                              attempt,
                              progress: ShipStagePassed.make({
                                stage: "format-check",
                                durationMs: GateDurationMs.make(15),
                              }),
                            }),
                          }),
                        )
                        return JSON.stringify({
                          id,
                          ok: true,
                          command: "workflow.ship",
                          result: expectedResponse,
                        })
                      }),
                    )
                    .otherwise(() =>
                      Effect.succeed(
                        JSON.stringify({ id, ok: false, error: `Unknown ${command}` }),
                      ),
                    )
                },
              })

              const response = yield* shipWorkflowViaDaemon(
                { repoRoot, runId },
                {
                  socketPath,
                  commonGitDir,
                  onProgress: (ev) => {
                    streamedEvents.push(ev)
                  },
                },
              )

              expect(observedTimeoutApplied).toBe(true)
              expect(streamedEvents).toHaveLength(2)
              expect(streamedEvents[0]?._tag).toBe("StageStarted")
              expect(streamedEvents[1]?._tag).toBe("StageFinished")
              expect(response).toEqual(expectedResponse)
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.live(
    "rejects missing workflow.ship capability, correlation id mismatch, and daemon error envelopes",
    () =>
      withTempRepoAndSocket(({ repoRoot, commonGitDir, socketPath }) =>
        Effect.gen(function* () {
          let mode: "missing-cap" | "bad-id" | "daemon-error" = "missing-cap"

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
                socketPathOverride: socketPath,
                lineHandler: (line) => {
                  const parsed = decodeJsonLine(line)
                  const id = parsed.id ?? ""
                  const command = parsed.command ?? ""
                  if (command === "workflow.handshake") {
                    return Effect.succeed(
                      JSON.stringify({
                        id,
                        ok: true,
                        command,
                        handshake: {
                          protocolVersion: "1",
                          capabilities:
                            mode === "missing-cap"
                              ? ["workflow.handshake", "workflow.start"]
                              : ["workflow.handshake", "workflow.ship"],
                          repoRoot,
                          commonGitDir,
                          writerLeaseEpoch: 1,
                        },
                      }),
                    )
                  }
                  if (command === "workflow.ship") {
                    if (mode === "bad-id") {
                      return Effect.succeed(
                        JSON.stringify({ id: "mismatched-correlation-id", ok: true, result: {} }),
                      )
                    }
                    return Effect.succeed(
                      JSON.stringify({
                        id,
                        ok: false,
                        error: "Ship execution rejected",
                        detail: "Writer lease expired mid-request",
                      }),
                    )
                  }
                  return Effect.succeed(JSON.stringify({ id, ok: false, error: "Unsupported" }))
                },
              })

              const missingCapRes = yield* Effect.result(
                shipWorkflowViaDaemon({ repoRoot }, { socketPath, commonGitDir }),
              )
              expect(
                match(missingCapRes)
                  .with({ _tag: "Failure" }, ({ failure }) => failure)
                  .with({ _tag: "Success" }, () => undefined)
                  .exhaustive(),
              ).toBeInstanceOf(DaemonProtocolMismatchError)

              mode = "bad-id"
              const badIdRes = yield* Effect.result(
                shipWorkflowViaDaemon({ repoRoot }, { socketPath, commonGitDir }),
              )
              expect(
                match(badIdRes)
                  .with({ _tag: "Failure" }, ({ failure }) => failure)
                  .with({ _tag: "Success" }, () => undefined)
                  .exhaustive(),
              ).toBeInstanceOf(DaemonProtocolMismatchError)

              mode = "daemon-error"
              const daemonErrRes = yield* Effect.result(
                shipWorkflowViaDaemon({ repoRoot }, { socketPath, commonGitDir }),
              )
              const daemonFailure = match(daemonErrRes)
                .with({ _tag: "Failure" }, ({ failure }) => failure)
                .with({ _tag: "Success" }, () => undefined)
                .exhaustive()
              expect(daemonFailure).toBeInstanceOf(WorkflowStoreUnavailableError)
              expect(daemonFailure?.message).toContain("Writer lease expired mid-request")
            }),
          ).pipe(Effect.provide(UnixSocketDaemonLive))
        }),
      ),
  )

  it.live(
    "validates repoRoot via validateWorktreeRepoRoot when socketPath is omitted and maps missing socket",
    () =>
      withTempRepoAndSocket(({ repoRoot }) =>
        Effect.gen(function* () {
          const missingSocketErr = yield* Effect.flip(shipWorkflowViaDaemon({ repoRoot }))
          expect(missingSocketErr).toBeInstanceOf(WorkflowStoreUnavailableError)
          expect(missingSocketErr.message).toContain("Daemon socket unavailable")
        }),
      ),
  )

  it.live("enforces wall-clock deadline despite continuous progress frames", () =>
    withTempRepoAndSocket(({ repoRoot, commonGitDir, socketPath }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
            socketPathOverride: socketPath,
            lineHandler: (line, controls) => {
              const parsed = decodeJsonLine(line)
              const id = parsed.id ?? ""
              const command = parsed.command ?? ""
              if (command === "workflow.handshake") {
                return Effect.succeed(
                  JSON.stringify({
                    id,
                    ok: true,
                    command,
                    handshake: {
                      protocolVersion: "1",
                      capabilities: ["workflow.handshake", "workflow.ship"],
                      repoRoot,
                      commonGitDir,
                      writerLeaseEpoch: 1,
                    },
                  }),
                )
              }
              return Effect.gen(function* () {
                const runId = WorkflowRunId.make("run-ship-deadline-1")
                const attempt = ShipAttempt.make(1)
                for (let i = 0; i < 15; i += 1) {
                  controls?.emitLine(
                    JSON.stringify({
                      id,
                      kind: "progress",
                      event: ShipStreamProgressEvent.cases.StageStarted.make({
                        runId,
                        attempt,
                        stage: "format-check",
                      }),
                    }),
                  )
                  yield* Effect.sleep("20 millis")
                }
                return JSON.stringify({ id, ok: true, command: "workflow.ship", result: {} })
              })
            },
          })

          const err = yield* Effect.flip(
            shipWorkflowViaDaemon(
              { repoRoot, runId: WorkflowRunId.make("run-ship-deadline-1") },
              { socketPath, commonGitDir, timeoutMs: 80 },
            ),
          )
          expect(err).toBeInstanceOf(WorkflowStoreUnavailableError)
          expect(err.message).toContain("timed out")
        }),
      ).pipe(Effect.provide(UnixSocketDaemonLive)),
    ),
  )

  it.live(
    "rejects missing/mismatched progress id, missing terminal id, malformed progress event, and ok/command mismatch",
    () =>
      withTempRepoAndSocket(({ repoRoot, commonGitDir, socketPath }) =>
        Effect.scoped(
          Effect.gen(function* () {
            type Mode =
              | "progress-missing-id"
              | "progress-bad-id"
              | "progress-malformed"
              | "reply-missing-id"
              | "reply-not-ok"
              | "reply-wrong-command"
            let mode: Mode = "progress-missing-id"

            yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
              socketPathOverride: socketPath,
              lineHandler: (line, controls) => {
                const parsed = decodeJsonLine(line)
                const id = parsed.id ?? ""
                const command = parsed.command ?? ""
                if (command === "workflow.handshake") {
                  return Effect.succeed(
                    JSON.stringify({
                      id,
                      ok: true,
                      command,
                      handshake: {
                        protocolVersion: "1",
                        capabilities: ["workflow.handshake", "workflow.ship"],
                        repoRoot,
                        commonGitDir,
                        writerLeaseEpoch: 1,
                      },
                    }),
                  )
                }
                const runId = WorkflowRunId.make("run-ship-strict-1")
                const attempt = ShipAttempt.make(1)
                const validProgress = ShipStreamProgressEvent.cases.StageStarted.make({
                  runId,
                  attempt,
                  stage: "format-check",
                })
                return match(mode)
                  .with("progress-missing-id", () => {
                    controls?.emitLine(JSON.stringify({ kind: "progress", event: validProgress }))
                    return Effect.succeed(
                      JSON.stringify({ id, ok: true, command: "workflow.ship", result: {} }),
                    )
                  })
                  .with("progress-bad-id", () => {
                    controls?.emitLine(
                      JSON.stringify({
                        id: "wrong-progress-id",
                        kind: "progress",
                        event: validProgress,
                      }),
                    )
                    return Effect.succeed(
                      JSON.stringify({ id, ok: true, command: "workflow.ship", result: {} }),
                    )
                  })
                  .with("progress-malformed", () => {
                    controls?.emitLine(
                      JSON.stringify({ id, kind: "progress", event: { _tag: "BogusEvent" } }),
                    )
                    return Effect.succeed(
                      JSON.stringify({ id, ok: true, command: "workflow.ship", result: {} }),
                    )
                  })
                  .with("reply-missing-id", () =>
                    Effect.succeed(
                      JSON.stringify({ ok: true, command: "workflow.ship", result: {} }),
                    ),
                  )
                  .with("reply-not-ok", () =>
                    Effect.succeed(
                      JSON.stringify({ id, ok: "yes", command: "workflow.ship", result: {} }),
                    ),
                  )
                  .with("reply-wrong-command", () =>
                    Effect.succeed(
                      JSON.stringify({ id, ok: true, command: "workflow.start", result: {} }),
                    ),
                  )
                  .exhaustive()
              },
            })

            const modes: ReadonlyArray<Mode> = [
              "progress-missing-id",
              "progress-bad-id",
              "progress-malformed",
              "reply-missing-id",
              "reply-not-ok",
              "reply-wrong-command",
            ]
            for (const nextMode of modes) {
              mode = nextMode
              const err = yield* Effect.flip(
                shipWorkflowViaDaemon({ repoRoot }, { socketPath, commonGitDir }),
              )
              expect(err).toBeInstanceOf(DaemonProtocolMismatchError)
            }
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive)),
      ),
  )

  it.live(
    "decodes split multi-byte UTF-8 and multi-frame data chunks without U+FFFD corruption",
    () =>
      withTempRepoAndSocket(({ repoRoot, commonGitDir, socketPath }) =>
        Effect.acquireUseRelease(
          Effect.callback<net.Server>((resume) => {
            const runId = WorkflowRunId.make("run-ship-utf8-01")
            const attempt = ShipAttempt.make(1)
            const treeHash = WorkspaceTreeHash.make("b".repeat(64))
            const executionId = WorkflowExecutionId.make(`${runId}:${treeHash}:${attempt}`)
            const utf8Detail = ShipFailureMessage.make("Emoji 🚀 and CJK 日本語 preserved")
            const server = net.createServer((socket) => {
              let buf = ""
              socket.on("data", (chunk) => {
                buf += chunk.toString("utf8")
                const idx = buf.indexOf("\n")
                if (idx === -1) return
                const line = buf.slice(0, idx)
                buf = buf.slice(idx + 1)
                const parsed = decodeJsonLine(line)
                const id = parsed.id ?? ""
                const command = parsed.command ?? ""
                if (command === "workflow.handshake") {
                  socket.end(
                    `${JSON.stringify({
                      id,
                      ok: true,
                      command,
                      handshake: {
                        protocolVersion: "1",
                        capabilities: ["workflow.handshake", "workflow.ship"],
                        repoRoot,
                        commonGitDir,
                        writerLeaseEpoch: 1,
                      },
                    })}\n`,
                  )
                  return
                }
                const progressFrame = JSON.stringify({
                  id,
                  kind: "progress",
                  event: ShipStreamProgressEvent.cases.StageFinished.make({
                    runId,
                    attempt,
                    progress: ShipStageFailed.make({
                      stage: "format-check",
                      durationMs: GateDurationMs.make(5),
                      errorTag: "ShipGateFailedError",
                      detail: utf8Detail,
                    }),
                  }),
                })
                const replyFrame = JSON.stringify({
                  id,
                  ok: true,
                  command: "workflow.ship",
                  result: {
                    runId,
                    attempt,
                    executionId,
                    treeHash,
                    runOrigin: "ephemeral",
                    outcome: {
                      _tag: "Passed",
                      receipt: ShipReceipt.make({
                        runId,
                        planSha: PlanSha256.make("c".repeat(64)),
                        attempt,
                        verifiedTreeHash: treeHash,
                      }),
                      stages: [],
                    },
                  } satisfies WorkflowShipResponse,
                })
                const combined = Buffer.from(`${progressFrame}\n${replyFrame}\n`, "utf8")
                const emojiOffset = combined.indexOf(Buffer.from("🚀", "utf8"))
                // Split directly inside the 4-byte UTF-8 sequence for 🚀 and deliver remaining + second frame together
                socket.write(combined.subarray(0, emojiOffset + 2))
                setTimeout(() => {
                  socket.end(combined.subarray(emojiOffset + 2))
                }, 10)
              })
            })
            mkdirSync(dirname(socketPath), { recursive: true })
            server.listen(socketPath, () => resume(Effect.succeed(server)))
          }),
          () =>
            Effect.gen(function* () {
              const events: Array<ShipStreamProgressEvent> = []
              const res = yield* shipWorkflowViaDaemon(
                { repoRoot, runId: WorkflowRunId.make("run-ship-utf8-01") },
                {
                  socketPath,
                  commonGitDir,
                  onProgress: (ev) => events.push(ev),
                },
              )
              expect(res.runOrigin).toBe("ephemeral")
              expect(events).toHaveLength(1)
              const ev0 = events[0]
              expect(ev0?._tag).toBe("StageFinished")
              if (ev0 !== undefined) {
                match(ev0)
                  .with({ _tag: "StageFinished" }, ({ progress }) =>
                    match(progress)
                      .with({ _tag: "Failed" }, (f) => {
                        expect(f.detail).toBe("Emoji 🚀 and CJK 日本語 preserved")
                        expect(f.detail).not.toContain("\ufffd")
                      })
                      .with({ _tag: "Passed" }, () => expect.unreachable())
                      .exhaustive(),
                  )
                  .with({ _tag: "StageStarted" }, () => expect.unreachable())
                  .exhaustive()
              }
            }),
          (server) =>
            Effect.sync(() => {
              server.close()
            }),
        ),
      ),
  )

  it.live(
    "dedicated shipQueue prevents slow workflow.ship handlers from starving control RPCs",
    () =>
      withTempRepoAndSocket(({ repoRoot, socketPath }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const shipsStarted = yield* Deferred.make<void>()
            const releaseShips = yield* Deferred.make<void>()
            let activeShips = 0

            yield* startScopedUnixSocketDaemon(WorkspaceFilePath.make(repoRoot), {
              socketPathOverride: socketPath,
              lineHandler: (line) => {
                const parsed = decodeJsonLine(line)
                const id = parsed.id ?? ""
                const command = parsed.command ?? ""
                if (command === "workflow.ship") {
                  return Effect.gen(function* () {
                    activeShips += 1
                    if (activeShips === 2) {
                      Deferred.doneUnsafe(shipsStarted, Effect.void)
                    }
                    yield* Deferred.await(releaseShips)
                    return JSON.stringify({ id, ok: true, command, result: {} })
                  })
                }
                return Effect.succeed(JSON.stringify({ id, ok: true, status: "fast" }))
              },
            })

            // Saturate MAX_DAEMON_SHIP_CONCURRENCY (2) with blocked workflow.ship requests
            const ship1 = yield* queryUnixSocketLineDetailed(
              socketPath,
              JSON.stringify({ id: "s1", command: "workflow.ship" }),
              { timeoutMs: 2000 },
            ).pipe(Effect.forkChild)
            const ship2 = yield* queryUnixSocketLineDetailed(
              socketPath,
              JSON.stringify({ id: "s2", command: "workflow.ship" }),
              { timeoutMs: 2000 },
            ).pipe(Effect.forkChild)

            yield* Deferred.await(shipsStarted)
            const controlRes = yield* queryUnixSocketLineDetailed(socketPath, "ping", {
              timeoutMs: 500,
            })
            expect(controlRes._tag).toBe("Reply")
            yield* Deferred.succeed(releaseShips, undefined)
            yield* Effect.all([Fiber.await(ship1), Fiber.await(ship2)])
          }),
        ).pipe(Effect.provide(UnixSocketDaemonLive)),
      ),
  )
})

const withTempRepoAndSocket = <A, E, R>(
  use: (ctx: {
    readonly repoRoot: ReturnType<typeof initGitRepo>["repoRoot"]
    readonly commonGitDir: GitCommonDirPath
    readonly socketPath: ReturnType<typeof resolveWorkflowRuntimePaths>["socketPath"]
  }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const { repoRoot } = initGitRepo(dir)
      const commonGitDir = GitCommonDirPath.make(realpathSync.native(join(repoRoot, ".git")))
      const { socketPath } = resolveWorkflowRuntimePaths(commonGitDir)
      return yield* use({ repoRoot, commonGitDir, socketPath })
    }),
  )
