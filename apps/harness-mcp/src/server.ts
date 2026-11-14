import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Logger, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type HarnessDaemonServerHandle,
  startHarnessDaemonServer,
} from "./daemon/unix-socket-daemon.js"
import { executeManagedMcpTool, makeMcpManagedRuntime } from "./managed-runtime.js"
import {
  recordMcpToolTelemetry,
  type ServerOptions,
  toMcpToolInputJsonSchema,
} from "./tools/mcp-helpers.js"
import {
  buildLiveMcpToolDescriptors,
  dispatchMcpTool,
  makeLiveMcpToolRegistryLayer,
  type McpToolExecutionError,
  type McpToolPluginDescriptor,
} from "./tools/tool-registry.js"

export {
  decideOmnigraphReconcile,
  deriveRepoOmnigraphPort,
  readGraphHeadMeta,
  resolveCanonicalRepoRoot,
  resolveGitHeadState,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
  writeGraphHeadMeta,
} from "@harness/graph"
export { type HarnessDaemonServerHandle, resolveDaemonSocketPath, startHarnessDaemonServer } from "./daemon/unix-socket-daemon.js"
export { executeManagedMcpTool, makeMcpMainLayer, makeMcpManagedRuntime } from "./managed-runtime.js"
export { type LspDiagnosticsReport, runDefaultLspDiagnostics } from "./tools/lsp-and-telemetry.tools.js"
export {
  isPathInsideRoot,
  normalizeProjectPath,
  ProjectPathEscapeError,
  recordMcpToolTelemetry,
  resolveDefaultRepoRoot,
  type ServerOptions,
} from "./tools/mcp-helpers.js"
export {
  buildLiveMcpToolDescriptors,
  CANONICAL_MCP_TOOL_NAMES,
  type DispatchMcpToolInput,
  dispatchMcpTool,
  makeLiveMcpToolRegistryLayer,
  makeMcpToolRegistryLayer,
  type McpToolHandler,
  McpToolInputName,
  type McpToolInputSchema,
  McpToolName,
  type McpToolPluginDescriptor,
  McpToolRegistry,
  McpToolRegistryLive,
  type McpToolRegistryShape,
  UnknownToolError,
} from "./tools/tool-registry.js"

export const executeToolEffect = Effect.fn("HarnessMcp.executeTool")(function* (
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  options?: ServerOptions,
): Effect.fn.Return<unknown, McpToolExecutionError> {
  const startTime = performance.now()
  const liveToolRegistryLayer = makeLiveMcpToolRegistryLayer(options)
  const result: unknown = yield* dispatchMcpTool({
    toolName,
    args,
  }).pipe(Effect.provide(liveToolRegistryLayer), Effect.provideService(Logger.LogToStderr, true))

  const durationMs = Math.max(0, Math.round(performance.now() - startTime))
  recordMcpToolTelemetry(toolName, args, result, durationMs, options)
  return result
})

export const createServer = (options?: ServerOptions): McpServer => {
  const server = new McpServer({ name: "harness-mcp", version: "0.0.0" })
  const runtime = makeMcpManagedRuntime(options)
  const descriptors = buildLiveMcpToolDescriptors(options)
  const descriptorsByName: ReadonlyMap<string, McpToolPluginDescriptor> = new Map(
    descriptors.map((descriptor) => [descriptor.name, descriptor]),
  )

  server.server.registerCapabilities({ tools: { listChanged: true } })

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: descriptors.map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: toMcpToolInputJsonSchema(descriptor.inputSchema),
    })),
  }))

  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const toolName = request.params.name
    const descriptor = descriptorsByName.get(toolName)
    if (descriptor === undefined) {
      return Promise.reject(
        new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' not found`),
      )
    }
    const rawArgs = request.params.arguments ?? {}
    return runtime
      .runPromiseExit(
        Schema.decodeUnknownEffect(Schema.toCodecJson(descriptor.inputSchema))(rawArgs).pipe(
          Effect.flatMap((decodedArgs) =>
            executeManagedMcpTool({ toolName, args: decodedArgs }, options),
          ),
        ),
      )
      .then((exit) =>
        match(exit)
          .with({ _tag: "Success" }, ({ value }) => ({
            content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }],
          }))
          .with({ _tag: "Failure" }, ({ cause }) => {
            if (Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)) {
              return Promise.reject(
                new McpError(ErrorCode.InternalError, `Tool '${toolName}' execution was interrupted`),
              )
            }
            const squashed = Cause.squash(cause)
            if (Schema.isSchemaError(squashed)) {
              return Promise.reject(
                new McpError(
                  ErrorCode.InvalidParams,
                  `Invalid arguments for tool '${toolName}': ${squashed.message}`,
                ),
              )
            }
            const message = squashed instanceof Error ? squashed.message : String(squashed)
            return {
              content: [{ type: "text" as const, text: message }],
              isError: true,
            }
          })
          .exhaustive(),
      )
  })

  const originalClose = server.close.bind(server)
  let runtimeDisposed = false
  const disposeRuntime = (): Promise<void> => {
    if (runtimeDisposed) return Promise.resolve()
    runtimeDisposed = true
    return runtime.dispose()
  }
  server.close = (): Promise<void> =>
    Effect.runPromise(
      Effect.promise(() => originalClose()).pipe(
        Effect.ensuring(Effect.promise(disposeRuntime)),
      ),
    )
  const previousOnClose = server.server.onclose
  server.server.onclose = () => {
    previousOnClose?.()
    void disposeRuntime()
  }

  return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = createServer()
  const transport = new StdioServerTransport()
  let daemonHandle: HarnessDaemonServerHandle | undefined = undefined
  let shuttingDown = false
  const daemonStartupPromise: Promise<HarnessDaemonServerHandle | undefined> =
    process.env.HARNESS_DAEMON_SOCK !== "0"
      ? startHarnessDaemonServer(process.cwd())
          .then((handle) => {
            daemonHandle = handle
            return handle
          })
          .catch((err: unknown) => {
            process.stderr.write(
              `[harness-mcp] Daemon server warning: ${err instanceof Error ? err.message : String(err)}\n`,
            )
            return undefined
          })
      : Promise.resolve(undefined)
  const shutdown = (initialExitCode = 0) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    let exitCode = initialExitCode
    void daemonStartupPromise
      .then((startedHandle) => {
        const handleToClose = daemonHandle ?? startedHandle
        if (handleToClose === undefined) {
          return Promise.resolve()
        }
        return handleToClose.close().catch((err: unknown) => {
          exitCode = 1
          process.stderr.write(
            `[harness-mcp] Daemon close error: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        })
      })
      .then(() =>
        server.close().catch((err: unknown) => {
          exitCode = 1
          process.stderr.write(
            `[harness-mcp] Server close error: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }),
      )
      .finally(() => process.exit(exitCode))
  }
  process.once("SIGINT", () => shutdown(0))
  process.once("SIGTERM", () => shutdown(0))
  process.stdin.once("end", () => shutdown(0))
  process.stdin.once("close", () => shutdown(0))
  void Effect.runPromise(Effect.tryPromise(() => server.connect(transport)))
    .then(() => {
      const previousTransportOnClose = transport.onclose
      transport.onclose = () => {
        previousTransportOnClose?.()
        shutdown(0)
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[harness-mcp] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      shutdown(1)
    })
}
