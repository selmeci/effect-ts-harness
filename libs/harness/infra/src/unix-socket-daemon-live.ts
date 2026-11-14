import * as net from "node:net"
import * as nodePath from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path, Schema, type Scope } from "effect"
import { match } from "ts-pattern"
import {
  DaemonServerError,
  type DaemonServerInfo,
  DaemonSocketPath,
  ErrorReasonMessage,
  type WorkspaceFilePath,
} from "@harness/contract"
import { UnixSocketDaemonPort, type UnixSocketDaemonPortShape } from "@harness/service"

const MAX_DAEMON_BUFFER_BYTES = 1_048_576
const DAEMON_SOCKET_TIMEOUT_MS = 5000

const DaemonLineRequestSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  command: Schema.Literals(["ping", "diagnostics", "ast-gates", "extract-graph"]),
})

const decodeDaemonLineRequest = Schema.decodeOption(
  Schema.fromJsonString(DaemonLineRequestSchema),
)

const resolveHarnessDaemonSocketPath = (repoRoot: string): DaemonSocketPath =>
  DaemonSocketPath.make(nodePath.join(repoRoot, ".harness", "daemon.sock"))

export { resolveHarnessDaemonSocketPath }

const toDaemonServerError = (socketPath: DaemonSocketPath, err: unknown): DaemonServerError => {
  const message =
    err instanceof Error && err.message.trim().length > 0
      ? err.message.trim()
      : "Unix socket daemon failure"
  return new DaemonServerError({
    socketPath,
    reason: ErrorReasonMessage.make(message),
  })
}

const probeSocketAlive = (
  fs: FileSystem.FileSystem,
  socketPath: DaemonSocketPath,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(socketPath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return false
    }
    return yield* Effect.callback<boolean>((resume) => {
      const socket = net.createConnection(socketPath)
      let settled = false
      const finish = (alive: boolean) => {
        if (settled) {
          return
        }
        settled = true
        socket.destroy()
        resume(Effect.succeed(alive))
      }
      socket.setTimeout(200, () => finish(false))
      socket.on("error", () => finish(false))
      socket.on("connect", () => {
        socket.write("ping\n")
      })
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8")
        finish(text.includes('"ok":true'))
      })
    })
  })

const closeNetServer = (
  fs: FileSystem.FileSystem,
  server: net.Server,
  socketPath: DaemonSocketPath,
  openSockets: Set<net.Socket>,
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
    Effect.andThen(fs.remove(socketPath, { force: true }).pipe(Effect.ignore)),
    Effect.ignore,
  )

const createDaemonNetServer = (openSockets: Set<net.Socket>): net.Server =>
  net.createServer((socket) => {
    openSockets.add(socket)
    socket.once("close", () => {
      openSockets.delete(socket)
    })
    socket.setTimeout(DAEMON_SOCKET_TIMEOUT_MS, () => {
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
            socket.end(`${JSON.stringify({ ok: false, error: "Invalid daemon request payload" })}\n`)
          }
        })
        .with({ _tag: "Some" }, ({ value: req }) => {
          const response = match(req.command)
            .with("ping", () => ({
              ...(req.id !== undefined ? { id: req.id } : {}),
              ok: true,
              status: "warm",
            }))
            .with("diagnostics", "ast-gates", "extract-graph", () => ({
              ...(req.id !== undefined ? { id: req.id } : {}),
              ok: false,
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

const makeUnixSocketDaemonLayer = (options?: {
  readonly socketPathOverride?: DaemonSocketPath
}): Layer.Layer<UnixSocketDaemonPort> =>
  Layer.effect(
    UnixSocketDaemonPort,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const startServer = (
        repoRoot: WorkspaceFilePath,
      ): Effect.Effect<DaemonServerInfo, DaemonServerError, Scope.Scope> =>
        Effect.gen(function* () {
          const socketPath =
            options?.socketPathOverride ?? resolveHarnessDaemonSocketPath(repoRoot)
          const dirPath = path.dirname(socketPath)

          yield* fs
            .makeDirectory(dirPath, { recursive: true, mode: 0o700 })
            .pipe(Effect.mapError((err) => toDaemonServerError(socketPath, err)))

          const alreadyAlive = yield* probeSocketAlive(fs, socketPath)
          if (alreadyAlive) {
            return {
              socketPath,
              repoRoot,
            } satisfies DaemonServerInfo
          }

          yield* fs.remove(socketPath, { force: true }).pipe(Effect.ignore)

          interface AcquiredServer {
            readonly server: net.Server
            readonly openSockets: Set<net.Socket>
          }

          yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const openSockets = new Set<net.Socket>()
              const server = createDaemonNetServer(openSockets)

              yield* Effect.callback<void, DaemonServerError>((resume) => {
                const onError = (err: Error) => {
                  resume(Effect.fail(toDaemonServerError(socketPath, err)))
                }
                server.once("error", onError)
                server.listen(socketPath, () => {
                  server.removeListener("error", onError)
                  resume(Effect.void)
                })
              }).pipe(
                Effect.tapError(() => closeNetServer(fs, server, socketPath, openSockets)),
              )

              if (process.platform !== "win32") {
                yield* fs.chmod(socketPath, 0o600).pipe(
                  Effect.mapError((err) => toDaemonServerError(socketPath, err)),
                  Effect.tapError(() => closeNetServer(fs, server, socketPath, openSockets)),
                )
              }

              return { server, openSockets } satisfies AcquiredServer
            }),
            ({ server, openSockets }) => closeNetServer(fs, server, socketPath, openSockets),
          )

          return {
            socketPath,
            repoRoot,
          } satisfies DaemonServerInfo
        })

      const isSocketAlive = (socketPath: DaemonSocketPath): Effect.Effect<boolean> =>
        probeSocketAlive(fs, socketPath)

      const impl: UnixSocketDaemonPortShape = {
        startServer,
        isSocketAlive,
      }

      return impl
    }),
  ).pipe(Layer.provide(NodeServices.layer))

export { makeUnixSocketDaemonLayer }

export const UnixSocketDaemonLive: Layer.Layer<UnixSocketDaemonPort> = makeUnixSocketDaemonLayer()

export const startScopedUnixSocketDaemon = Effect.fn("UnixSocketDaemon.startScoped")(function* (
  repoRoot: WorkspaceFilePath,
): Effect.fn.Return<DaemonServerInfo, DaemonServerError, UnixSocketDaemonPort | Scope.Scope> {
  const port = yield* UnixSocketDaemonPort
  return yield* port.startServer(repoRoot)
})
