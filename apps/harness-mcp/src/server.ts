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
  resolveDaemonSocketPath,
  startHarnessDaemonServer,
} from "./daemon/unix-socket-daemon.js"
import {
  type LspDiagnosticsReport,
  runDefaultLspDiagnostics,
} from "./tools/lsp-and-telemetry.tools.js"
import {
  isPathInsideRoot,
  normalizeProjectPath,
  recordMcpToolTelemetry,
  type ServerOptions,
  toMcpToolInputJsonSchema,
} from "./tools/mcp-helpers.js"
import type {
  McpToolExecutionError,
  McpToolHandler,
  McpToolInputSchema,
  McpToolPluginDescriptor,
  McpToolRegistryShape,
} from "./tools/tool-registry.js"
import {
  buildLiveMcpToolDescriptors,
  CANONICAL_MCP_TOOL_NAMES,
  type DispatchMcpToolInput,
  dispatchMcpTool,
  makeLiveMcpToolRegistryLayer,
  makeMcpToolRegistryLayer,
  McpToolInputName,
  McpToolName,
  McpToolRegistry,
  McpToolRegistryLive,
  UnknownToolError,
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
} from "@harness/gates"

export {
  buildLiveMcpToolDescriptors,
  CANONICAL_MCP_TOOL_NAMES,
  type DispatchMcpToolInput,
  dispatchMcpTool,
  type HarnessDaemonServerHandle,
  isPathInsideRoot,
  type LspDiagnosticsReport,
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
  normalizeProjectPath,
  resolveDaemonSocketPath,
  runDefaultLspDiagnostics,
  type ServerOptions,
  startHarnessDaemonServer,
  UnknownToolError,
}

if (!("iterations" in globalThis)) {
  Object.assign(globalThis, { iterations: 0 })
}

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

export const executeTool = (
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  options?: ServerOptions,
): Promise<unknown> => Effect.runPromise(executeToolEffect(toolName, args, options))

export const createServer = (options?: ServerOptions): McpServer => {
  const server = new McpServer({ name: "harness-mcp", version: "0.0.0" })
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
    return Effect.runPromiseExit(
      Schema.decodeUnknownEffect(Schema.toCodecJson(descriptor.inputSchema))(rawArgs).pipe(
        Effect.flatMap((decodedArgs) => executeToolEffect(toolName, decodedArgs, options)),
      ),
    ).then((exit) =>
      match(exit)
        .with({ _tag: "Success" }, ({ value }) => ({
          content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }],
        }))
        .with({ _tag: "Failure" }, ({ cause }) => {
          if (Cause.hasInterruptsOnly(cause)) {
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

  return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = createServer()
  const transport = new StdioServerTransport()
  let daemonHandle: HarnessDaemonServerHandle | undefined = undefined
  const shutdown = () => {
    void (daemonHandle ? daemonHandle.close() : Promise.resolve())
      .then(() => server.close())
      .finally(() => process.exit(0))
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  void Effect.runPromise(Effect.tryPromise(() => server.connect(transport))).catch(
    (err: unknown) => {
      process.stderr.write(
        `[harness-mcp] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    },
  )
  if (process.env.HARNESS_DAEMON_SOCK !== "0") {
    void startHarnessDaemonServer(process.cwd())
      .then((handle) => {
        daemonHandle = handle
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `[harness-mcp] Daemon server warning: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      })
  }
}
