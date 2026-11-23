import * as nodeFs from "node:fs"
import * as net from "node:net"
import * as nodePath from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, FileSystem, Layer, Option, Path, Queue, Schema, type Scope } from "effect"
import { match } from "ts-pattern"
import {
  DaemonServerError,
  type DaemonServerErrorKind,
  type DaemonServerInfo,
  DaemonSocketPath,
  ErrorReasonMessage,
  isPureInterruptCause,
  toErrorReasonMessage,
  type WorkspaceFilePath,
} from "@harness/contract"
import { resolveGitCommonDir } from "@harness/graph/cluster-resolver"
import { UnixSocketDaemonPort, type UnixSocketDaemonPortShape } from "@harness/service"
import { nodeSyncHostIo } from "./node-host-io.js"

const MAX_DAEMON_BUFFER_BYTES = 1_048_576
export const DAEMON_SOCKET_TIMEOUT_MS = 5000
export const DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS = 35_000
export const WORKFLOW_DAEMON_SERVER_SOCKET_TIMEOUT_MS = 160_000
const PROBE_SOCKET_TIMEOUT_MS = 1500
const MAX_DAEMON_LINE_CONCURRENCY = 4
const MAX_DAEMON_LINE_QUEUE_CAPACITY = 256

type SocketProbeResult =
  | "missing"
  | "alive"
  | "stale-socket"
  | "not-a-socket"
  | "stat-error"
  | "timeout"
  | "probe-error"

export type UnixSocketQueryReason =
  | "missing-or-refused"
  | "timeout"
  | "overflow"
  | "closed"
  | "socket-error"

export interface UnixSocketQueryReply {
  readonly _tag: "Reply"
  readonly line: string
}

export interface UnixSocketQueryUnavailable {
  readonly _tag: "Unavailable"
  readonly reason: UnixSocketQueryReason
  readonly detail?: string | undefined
}

export type UnixSocketQueryResult = UnixSocketQueryReply | UnixSocketQueryUnavailable

const DaemonLineRequestSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  command: Schema.Literals(["plan-check", "gc", "verify", "bench"]),
})

const decodeDaemonLineRequest = Schema.decodeOption(Schema.fromJsonString(DaemonLineRequestSchema))

/**
 * Resolves the canonical harness daemon Unix socket path.
 * In git repositories (including linked worktrees), resolves to `<git-common-dir>/harness/daemon.sock`
 * so all worktrees share one canonical daemon within Linux's 107-byte `UNIX_PATH_MAX`.
 * Falls back to `<repoRoot>/.harness/daemon.sock` for non-git directories.
 */
const resolveHarnessDaemonSocketPath = (repoRoot: string): DaemonSocketPath => {
  const commonGitDir = resolveGitCommonDir(repoRoot, nodeSyncHostIo)
  if (commonGitDir !== null) {
    return DaemonSocketPath.make(nodePath.join(commonGitDir, "harness", "daemon.sock"))
  }
  return DaemonSocketPath.make(nodePath.join(repoRoot, ".harness", "daemon.sock"))
}

export { resolveHarnessDaemonSocketPath }

const toDaemonServerError = (
  socketPath: DaemonSocketPath,
  err: unknown,
  reasonKind: DaemonServerErrorKind = "bind-failed",
): DaemonServerError =>
  new DaemonServerError({
    socketPath,
    reasonKind,
    reason: toErrorReasonMessage(err, "Unix socket daemon failure"),
  })

export interface UnixSocketQueryOptions {
  readonly timeoutMs?: number | undefined
}

export interface UnixSocketDaemonLayerOptions {
  readonly socketPathOverride?: DaemonSocketPath
  readonly lineHandler?: (line: string) => Effect.Effect<string>
  readonly socketTimeoutMs?: number | undefined
}

const resolveQueryTimeoutMs = (timeoutOrOptions?: number | UnixSocketQueryOptions): number => {
  if (typeof timeoutOrOptions === "number") {
    return timeoutOrOptions
  }
  return timeoutOrOptions?.timeoutMs ?? PROBE_SOCKET_TIMEOUT_MS
}

export const queryUnixSocketLineDetailed = Effect.fn("UnixSocketDaemon.queryLineDetailed")(
  function* (
    socketPath: string,
    linePayload: string,
    timeoutOrOptions?: number | UnixSocketQueryOptions,
  ): Effect.fn.Return<UnixSocketQueryResult> {
    const timeoutMs = resolveQueryTimeoutMs(timeoutOrOptions)
    return yield* Effect.callback<UnixSocketQueryResult>((resume) => {
      const socket = net.createConnection(socketPath)
      let settled = false
      let buffer = ""
      const finish = (result: UnixSocketQueryResult) => {
        if (settled) {
          return
        }
        settled = true
        socket.destroy()
        resume(Effect.succeed(result))
      }
      socket.setTimeout(timeoutMs, () => finish({ _tag: "Unavailable", reason: "timeout" }))
      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
          finish({ _tag: "Unavailable", reason: "missing-or-refused", detail: err.message })
          return
        }
        finish({ _tag: "Unavailable", reason: "socket-error", detail: err.message })
      })
      socket.on("connect", () => {
        const payload = linePayload.endsWith("\n") ? linePayload : `${linePayload}\n`
        socket.write(payload)
      })
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        if (Buffer.byteLength(buffer, "utf8") > MAX_DAEMON_BUFFER_BYTES) {
          finish({ _tag: "Unavailable", reason: "overflow" })
          return
        }
        const newlineIdx = buffer.indexOf("\n")
        if (newlineIdx !== -1) {
          finish({ _tag: "Reply", line: buffer.slice(0, newlineIdx).trim() })
        }
      })
      socket.on("end", () => {
        const trimmed = buffer.trim()
        finish(
          trimmed.length > 0
            ? { _tag: "Reply", line: trimmed }
            : { _tag: "Unavailable", reason: "closed" },
        )
      })
      socket.on("close", () => finish({ _tag: "Unavailable", reason: "closed" }))
      return Effect.sync(() => {
        settled = true
        socket.removeAllListeners()
        socket.destroy()
      })
    })
  },
)

export const queryUnixSocketLine = Effect.fn("UnixSocketDaemon.queryLine")(function* (
  socketPath: string,
  linePayload: string,
  timeoutOrOptions?: number | UnixSocketQueryOptions,
): Effect.fn.Return<Option.Option<string>> {
  const result = yield* queryUnixSocketLineDetailed(socketPath, linePayload, timeoutOrOptions)
  return match(result)
    .with({ _tag: "Reply" }, ({ line }) => Option.some(line))
    .with({ _tag: "Unavailable" }, () => Option.none<string>())
    .exhaustive()
})

const probeSocketState = (socketPath: DaemonSocketPath): Effect.Effect<SocketProbeResult> =>
  Effect.gen(function* () {
    const statResult = yield* Effect.try({
      try: () => nodeFs.lstatSync(socketPath),
      catch: (err): SocketProbeResult => {
        const code =
          err instanceof Error && "code" in err && typeof err.code === "string"
            ? err.code
            : undefined
        return code === "ENOENT" ? "missing" : "stat-error"
      },
    }).pipe(
      Effect.map((stat): SocketProbeResult | nodeFs.Stats => stat),
      Effect.catch((probeErr) => Effect.succeed<SocketProbeResult>(probeErr)),
    )

    if (typeof statResult === "string") {
      return statResult
    }

    if (!statResult.isSocket()) {
      return "not-a-socket"
    }

    return yield* Effect.callback<SocketProbeResult>((resume) => {
      const socket = net.createConnection(socketPath)
      let settled = false
      const finish = (result: SocketProbeResult) => {
        if (settled) {
          return
        }
        settled = true
        socket.destroy()
        resume(Effect.succeed(result))
      }
      socket.setTimeout(PROBE_SOCKET_TIMEOUT_MS, () => finish("timeout"))
      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
          finish("stale-socket")
          return
        }
        finish("probe-error")
      })
      socket.on("connect", () => {
        finish("alive")
      })
      return Effect.sync(() => {
        settled = true
        socket.removeAllListeners()
        socket.destroy()
      })
    })
  })

const closeNetServer = (
  fs: FileSystem.FileSystem,
  server: net.Server,
  socketPath: DaemonSocketPath,
  openSockets: Set<net.Socket>,
  shouldUnlinkSocket: () => boolean,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    for (const socket of openSockets) {
      socket.destroy()
    }
    openSockets.clear()
    server.close(() => {
      resume(Effect.void)
    })
  }).pipe(
    Effect.andThen(
      shouldUnlinkSocket()
        ? fs.remove(socketPath, { force: true }).pipe(Effect.ignore)
        : Effect.void,
    ),
    Effect.ignore,
  )

const createDaemonNetServer = (
  openSockets: Set<net.Socket>,
  runLineHandler?: (line: string, socket: net.Socket) => void,
  socketTimeoutMs: number = DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
): net.Server =>
  net.createServer((socket) => {
    openSockets.add(socket)
    socket.once("close", () => {
      openSockets.delete(socket)
    })
    socket.setTimeout(socketTimeoutMs, () => {
      socket.destroy()
    })
    socket.on("error", () => {
      socket.destroy()
    })
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      if (Buffer.byteLength(buffer, "utf8") > MAX_DAEMON_BUFFER_BYTES) {
        buffer = ""
        if (!socket.destroyed && socket.writable) {
          socket.end(
            `${JSON.stringify({ ok: false, error: "Request payload exceeds 1MB limit" })}\n`,
            () => {
              socket.destroy()
            },
          )
        } else {
          socket.destroy()
        }
        return
      }
      const newlineIdx = buffer.indexOf("\n")
      if (newlineIdx === -1) {
        return
      }
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)

      if (runLineHandler !== undefined) {
        runLineHandler(line, socket)
        return
      }

      if (line === "ping") {
        if (!socket.destroyed && socket.writable) {
          socket.end(`${JSON.stringify({ ok: true, status: "warm" })}\n`)
        }
        return
      }

      const reqOpt = decodeDaemonLineRequest(line)
      match(reqOpt)
        .with({ _tag: "None" }, () => {
          if (!socket.destroyed && socket.writable) {
            socket.end(
              `${JSON.stringify({ ok: false, error: "Invalid daemon request payload" })}\n`,
            )
          }
        })
        .with({ _tag: "Some" }, ({ value: req }) => {
          const response = match(req.command)
            .with("bench", "plan-check", "gc", "verify", (command) => ({
              ...(req.id !== undefined ? { id: req.id } : {}),
              ok: false,
              command,
              fallbackToInProcess: true,
            }))
            .exhaustive()

          if (!socket.destroyed && socket.writable) {
            socket.end(`${JSON.stringify(response)}\n`)
          }
        })
        .exhaustive()
    })
  })

const makeUnixSocketDaemonLayer = (
  options?: UnixSocketDaemonLayerOptions,
): Layer.Layer<UnixSocketDaemonPort, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    UnixSocketDaemonPort,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const lineHandler = options?.lineHandler
      const socketTimeoutMs = options?.socketTimeoutMs ?? DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS

      const startServer = (
        repoRoot: WorkspaceFilePath,
      ): Effect.Effect<DaemonServerInfo, DaemonServerError, Scope.Scope> =>
        Effect.gen(function* () {
          const socketPath = options?.socketPathOverride ?? resolveHarnessDaemonSocketPath(repoRoot)
          const dirPath = path.dirname(socketPath)

          if (nodeFs.lstatSync(dirPath, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
            return yield* toDaemonServerError(
              socketPath,
              new Error(`Refusing symlink daemon socket directory: ${dirPath}`),
            )
          }

          const dirExistedBefore = yield* fs
            .exists(dirPath)
            .pipe(Effect.mapError((err) => toDaemonServerError(socketPath, err)))

          // Architectural rationale ("why"): `0o700` parent directory (for owned `.harness`
          // directories or newly created custom directories, never pre-existing shared parents
          // like `/tmp`) and `0o600` socket permissions prevent cross-UID local IPC hijacking or
          // unauthorized command injection on multi-user hosts.
          yield* fs
            .makeDirectory(dirPath, { recursive: true, mode: 0o700 })
            .pipe(Effect.mapError((err) => toDaemonServerError(socketPath, err)))
          if (
            process.platform !== "win32" &&
            (options?.socketPathOverride === undefined || !dirExistedBefore)
          ) {
            yield* Effect.try({
              try: () => {
                nodeFs.chmodSync(dirPath, 0o700)
              },
              catch: (err) => toDaemonServerError(socketPath, err, "chmod-failed"),
            })
          }

          let runLineHandler: ((line: string, socket: net.Socket) => void) | undefined
          if (lineHandler !== undefined) {
            const lineQueue = yield* Queue.bounded<{
              readonly socket: net.Socket
              readonly line: string
            }>(MAX_DAEMON_LINE_QUEUE_CAPACITY)
            yield* Effect.forEach(
              Array.from({ length: MAX_DAEMON_LINE_CONCURRENCY }, (_, index) => index),
              () =>
                Effect.forever(
                  Effect.gen(function* () {
                    const { socket, line } = yield* Queue.take(lineQueue)
                    const exit = yield* Effect.exit(Effect.suspend(() => lineHandler(line)))
                    yield* match(exit)
                      .with({ _tag: "Success" }, ({ value: responseLine }) =>
                        Effect.sync(() => {
                          if (!socket.destroyed && socket.writable) {
                            socket.end(`${responseLine}\n`)
                          }
                        }),
                      )
                      .with({ _tag: "Failure" }, ({ cause }) => {
                        if (isPureInterruptCause(cause)) {
                          return Effect.interrupt
                        }
                        return Effect.sync(() => {
                          const causeText = Cause.pretty(cause)
                          process.stderr.write(
                            `[harness-daemon] lineHandler failed: ${causeText}\n`,
                          )
                          if (!socket.destroyed && socket.writable) {
                            socket.end(
                              `${JSON.stringify({ ok: false, error: "Daemon line handler failed", cause: causeText })}\n`,
                            )
                          }
                        })
                      })
                      .exhaustive()
                  }),
                ).pipe(Effect.forkScoped),
            )
            yield* Effect.addFinalizer(() => Queue.shutdown(lineQueue).pipe(Effect.ignore))
            runLineHandler = (line: string, socket: net.Socket): void => {
              if (!Queue.offerUnsafe(lineQueue, { socket, line })) {
                if (!socket.destroyed && socket.writable) {
                  socket.end(
                    `${JSON.stringify({ ok: false, error: "Daemon request queue full" })}\n`,
                  )
                } else {
                  socket.destroy()
                }
              }
            }
          }

          const probeResult = yield* probeSocketState(socketPath)
          yield* match(probeResult)
            .with("missing", () => Effect.void)
            .with("stale-socket", () =>
              Effect.try({
                try: () => {
                  nodeFs.unlinkSync(socketPath)
                },
                catch: (err) => toDaemonServerError(socketPath, err, "probe-failed"),
              }),
            )
            .with("alive", () =>
              Effect.fail(
                new DaemonServerError({
                  socketPath,
                  reasonKind: "already-alive",
                  reason: ErrorReasonMessage.make(`Daemon socket '${socketPath}' is already alive`),
                }),
              ),
            )
            .with("not-a-socket", () =>
              Effect.fail(
                new DaemonServerError({
                  socketPath,
                  reasonKind: "not-a-socket",
                  reason: ErrorReasonMessage.make(
                    `Refusing to unlink non-socket path '${socketPath}'`,
                  ),
                }),
              ),
            )
            .with("stat-error", "timeout", "probe-error", (kind) =>
              Effect.fail(
                new DaemonServerError({
                  socketPath,
                  reasonKind: "probe-failed",
                  reason: ErrorReasonMessage.make(
                    `Failed to probe daemon socket '${socketPath}' (${kind})`,
                  ),
                }),
              ),
            )
            .exhaustive()

          interface AcquiredServer {
            readonly server: net.Server
            readonly openSockets: Set<net.Socket>
          }

          let serverListening = false
          const shouldUnlinkSocket = () => serverListening

          yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const openSockets = new Set<net.Socket>()
              const server = createDaemonNetServer(openSockets, runLineHandler, socketTimeoutMs)

              const onServerRuntimeError = (err: Error) => {
                process.stderr.write(
                  `[harness/infra] Unix socket daemon server error (${socketPath}): ${toErrorReasonMessage(err, "unknown error")}\n`,
                )
              }

              yield* Effect.callback<void, DaemonServerError>((resume) => {
                let settled = false
                const onError = (err: Error) => {
                  if (settled) {
                    return
                  }
                  settled = true
                  resume(Effect.fail(toDaemonServerError(socketPath, err)))
                }
                server.once("error", onError)
                server.listen(socketPath, () => {
                  if (settled) {
                    return
                  }
                  settled = true
                  server.removeListener("error", onError)
                  server.on("error", onServerRuntimeError)
                  serverListening = true
                  resume(Effect.void)
                })
                return Effect.sync(() => {
                  settled = true
                  server.removeListener("error", onError)
                  server.close()
                })
              }).pipe(
                Effect.tapError(() =>
                  closeNetServer(fs, server, socketPath, openSockets, shouldUnlinkSocket),
                ),
              )

              if (process.platform !== "win32") {
                yield* Effect.try({
                  try: () => {
                    nodeFs.chmodSync(socketPath, 0o600)
                  },
                  catch: (err) => toDaemonServerError(socketPath, err, "chmod-failed"),
                }).pipe(
                  Effect.tapError(() =>
                    closeNetServer(fs, server, socketPath, openSockets, shouldUnlinkSocket),
                  ),
                )
              }

              return { server, openSockets } satisfies AcquiredServer
            }),
            ({ server, openSockets }) =>
              closeNetServer(fs, server, socketPath, openSockets, shouldUnlinkSocket),
          )

          return {
            socketPath,
            repoRoot,
          } satisfies DaemonServerInfo
        })

      const isSocketAlive = (socketPath: DaemonSocketPath): Effect.Effect<boolean> =>
        probeSocketState(socketPath).pipe(Effect.map((state) => state === "alive"))

      const impl: UnixSocketDaemonPortShape = {
        startServer,
        isSocketAlive,
      }

      return impl
    }),
  )

export { makeUnixSocketDaemonLayer }

export const UnixSocketDaemonLive: Layer.Layer<UnixSocketDaemonPort> =
  makeUnixSocketDaemonLayer().pipe(Layer.provide(NodeServices.layer))

export const startScopedUnixSocketDaemon = Effect.fn("UnixSocketDaemon.startScoped")(function* (
  repoRoot: WorkspaceFilePath,
  options?: UnixSocketDaemonLayerOptions,
): Effect.fn.Return<DaemonServerInfo, DaemonServerError, UnixSocketDaemonPort | Scope.Scope> {
  if (options !== undefined) {
    return yield* Effect.gen(function* () {
      const port = yield* UnixSocketDaemonPort
      return yield* port.startServer(repoRoot)
    }).pipe(
      Effect.provide(makeUnixSocketDaemonLayer(options).pipe(Layer.provide(NodeServices.layer))),
    )
  }
  const port = yield* UnixSocketDaemonPort
  return yield* port.startServer(repoRoot)
})
