import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"
import { Effect, Logger, Schema } from "effect"
import { executeManagedMcpTool, makeMcpManagedRuntime } from "./managed-runtime.js"
import { runMcpStdioMain } from "./stdio-entrypoint.js"
import {
  attachServerCloseRuntimeDisposal,
  formatMcpToolExit,
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
export {
  type HarnessDaemonServerHandle,
  resolveDaemonSocketPath,
  startHarnessDaemonServer,
  type StartHarnessDaemonServerOptions,
  type WorkflowEngineDaemonMode,
  type WorkflowEngineDaemonOptions,
} from "./daemon/unix-socket-daemon.js"
export {
  executeManagedMcpTool,
  makeMcpMainLayer,
  makeMcpManagedRuntime,
} from "./managed-runtime.js"
export {
  extractTs2484CycleHint,
  LspDiagnostics,
  type LspDiagnosticsExecutionOptions,
  type LspDiagnosticsReport,
  resolveLspWatchdogTimeoutMs,
  runDefaultLspDiagnostics,
  runLspDiagnosticsWithWatchdog,
} from "./tools/lsp-and-telemetry.tools.js"
export {
  createMcpSingleFlightController,
  McpSingleFlight,
  type McpSingleFlightController,
  type McpSingleFlightControllerOptions,
  runMcpSingleFlight,
} from "./tools/mcp-single-flight.js"
export { hasValidWorkspaceRootMarker, resolveDaemonStartupRepoRoot } from "./tools/mcp-repo-root.js"
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

  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const toolName = request.params.name
    const descriptor = descriptorsByName.get(toolName)
    if (descriptor === undefined) {
      return Promise.reject(new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' not found`))
    }
    const rawArgs = request.params.arguments ?? {}
    return runtime
      .runPromiseExit(
        Schema.decodeUnknownEffect(Schema.toCodecJson(descriptor.inputSchema))(rawArgs).pipe(
          Effect.flatMap((decodedArgs) =>
            executeManagedMcpTool({ toolName, args: decodedArgs }, options),
          ),
        ),
        { signal: extra.signal },
      )
      .then((exit) => formatMcpToolExit(toolName, exit))
  })

  attachServerCloseRuntimeDisposal(server, runtime)

  return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMcpStdioMain(createServer())
}
