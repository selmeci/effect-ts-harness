import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { Effect, Schema } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { extractWorkspaceTypeAwareGraph } from "@harness/graph"
import {
  AstGateCache,
  AstSourceContent,
  AstSourceFilePath,
  HARNESS_GATE_RULE_VERSION,
} from "@harness/gates"
import { isPathInsideRoot } from "../tools/mcp-helpers.js"

export interface HarnessDaemonServerHandle {
  readonly socketPath: string
  readonly close: () => Promise<void>
}

const DaemonRequestSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.Literals([
    "ping",
    "extract-graph",
    "ast-gates",
    "plan-check",
    "gc",
    "verify",
    "bench",
  ]),
  argv: Schema.optional(Schema.Array(Schema.String)),
  repoRoot: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(Schema.String)),
})

const decodeDaemonRequest = Schema.decodeOption(Schema.fromJsonString(DaemonRequestSchema))

export const resolveDaemonSocketPath = (repoRoot: string): string =>
  path.join(repoRoot, ".harness", "daemon.sock")

const safeUnlinkSocket = (socketPath: string): void => {
  if (!fs.existsSync(socketPath)) {
    return
  }
  Effect.runSync(
    Effect.try({
      try: () => {
        fs.unlinkSync(socketPath)
      },
      catch: () => undefined,
    }).pipe(Effect.ignore),
  )
}

const MAX_DAEMON_BUFFER_BYTES = 1_048_576
const DAEMON_SOCKET_TIMEOUT_MS = 5000

const isDaemonSocketAlive = (socketPath: string): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    if (!fs.existsSync(socketPath)) {
      resume(Effect.succeed(false))
      return
    }
    const probe = net.createConnection(socketPath)
    let settled = false
    const finish = (alive: boolean) => {
      if (settled) return
      settled = true
      probe.destroy()
      resume(Effect.succeed(alive))
    }
    probe.setTimeout(150, () => finish(false))
    probe.on("connect", () => finish(true))
    probe.on("error", () => finish(false))
  })

const createDaemonNetServer = (
  repoRoot: string,
  openSockets: Set<net.Socket>,
): net.Server =>
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
        if (!socket.destroyed && socket.writable) {
          socket.end(
            JSON.stringify({ ok: false, error: "Request payload exceeds 1MB limit" }) + "\n",
          )
        } else {
          socket.destroy()
        }
        return
      }
      const newlineIdx = buffer.indexOf("\n")
      if (newlineIdx === -1) return
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      const reqOpt = decodeDaemonRequest(line)
      match(reqOpt)
        .with({ _tag: "None" }, () => {
          if (!socket.destroyed && socket.writable) {
            socket.end(
              JSON.stringify({ ok: false, error: "Invalid daemon request payload" }) + "\n",
            )
          }
        })
        .with({ _tag: "Some" }, ({ value: req }) => {
          const baseRoot = path.resolve(repoRoot)
          const targetRoot = req.repoRoot ?? baseRoot
          const resolvedRoot = path.resolve(targetRoot)
          if (req.repoRoot !== undefined && !isPathInsideRoot(baseRoot, resolvedRoot)) {
            if (!socket.destroyed && socket.writable) {
              socket.end(
                JSON.stringify({
                  id: req.id,
                  ok: false,
                  error: `Requested repoRoot '${req.repoRoot}' escapes daemon root`,
                }) + "\n",
              )
            }
            return
          }
          void Effect.runPromise(
            match<typeof req.command, Effect.Effect<Record<string, unknown>>>(req.command)
              .with("ping", () => Effect.succeed({ id: req.id, ok: true, status: "warm" }))
              .with("extract-graph", () =>
                Effect.gen(function* () {
                  const graph = yield* extractWorkspaceTypeAwareGraph(resolvedRoot)
                  return {
                    id: req.id,
                    ok: true,
                    nodeCount: Graph.nodeCount(graph.graph),
                    edgeCount: Graph.edgeCount(graph.graph),
                    violationCount: (graph.branchingViolations ?? []).length,
                  }
                }),
              )
              .with("ast-gates", () =>
                Effect.gen(function* () {
                  const cachePath = AstGateCache.resolveCachePath(resolvedRoot)
                  const requestedRelPaths = req.files ?? []
                  for (const rel of requestedRelPaths) {
                    const resolvedAbs = path.resolve(resolvedRoot, rel)
                    if (!isPathInsideRoot(resolvedRoot, resolvedAbs)) {
                      return {
                        id: req.id,
                        ok: false,
                        error: `Path traversal outside workspace root is forbidden: ${rel}`,
                      }
                    }
                  }
                  const loadedFiles = requestedRelPaths.flatMap((rel) => {
                    const abs = path.resolve(resolvedRoot, rel)
                    if (!fs.existsSync(abs)) return []
                    return [
                      {
                        filePath: AstSourceFilePath.make(rel),
                        content: AstSourceContent.make(fs.readFileSync(abs, "utf8")),
                      },
                    ]
                  })
                  const report = yield* AstGateCache.decide({
                    files: loadedFiles,
                    ruleVersion: HARNESS_GATE_RULE_VERSION,
                    cacheFilePath: cachePath,
                  })
                  return { id: req.id, ok: true, report }
                }),
              )
              .with("plan-check", "gc", "verify", "bench", () =>
                Effect.succeed({ id: req.id, ok: false, fallbackToInProcess: true }),
              )
              .exhaustive(),
          )
            .then((res) => {
              if (!socket.destroyed && socket.writable) {
                socket.write(JSON.stringify(res) + "\n")
                socket.end()
              }
            })
            .catch((err: unknown) => {
              if (!socket.destroyed && socket.writable) {
                socket.write(
                  JSON.stringify({
                    id: req.id,
                    ok: false,
                    error: err instanceof Error ? err.message : "Daemon execution error",
                  }) + "\n",
                )
                socket.end()
              }
            })
        })
        .exhaustive()
    })
  })

const closeDaemonNetServer = (
  server: net.Server,
  socketPath: string,
  openSockets: Set<net.Socket>,
): Promise<void> =>
  Effect.runPromise(
    Effect.callback<void>((resume) => {
      server.close(() => {
        safeUnlinkSocket(socketPath)
        resume(Effect.void)
      })
      for (const socket of openSockets) {
        socket.destroy()
      }
      openSockets.clear()
    }),
  )

export const startHarnessDaemonServer = (
  repoRoot: string = process.cwd(),
): Promise<HarnessDaemonServerHandle> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const socketPath = resolveDaemonSocketPath(repoRoot)
      const dir = path.dirname(socketPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      }
      const alreadyAlive = yield* isDaemonSocketAlive(socketPath)
      if (!alreadyAlive) {
        safeUnlinkSocket(socketPath)
      }

      const openSockets = new Set<net.Socket>()
      const server = createDaemonNetServer(repoRoot, openSockets)

      yield* Effect.callback<void, Error>((resume) => {
        const onError = (err: Error) => {
          resume(Effect.fail(err))
        }
        server.once("error", onError)
        server.listen(socketPath, () => {
          server.removeListener("error", onError)
          resume(Effect.void)
        })
      })

      yield* Effect.try({
        try: () => {
          fs.chmodSync(socketPath, 0o600)
        },
        catch: () => undefined,
      }).pipe(Effect.ignore)

      return {
        socketPath,
        close: () => closeDaemonNetServer(server, socketPath, openSockets),
      }
    }),
  )
