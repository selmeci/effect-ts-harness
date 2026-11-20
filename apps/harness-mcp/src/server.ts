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
import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, Logger, ManagedRuntime, Schema } from "effect"
import { isPureInterruptCause } from "@harness/contract"
import {
  type HarnessDaemonServerHandle,
  startHarnessDaemonServer,
} from "./daemon/unix-socket-daemon.js"
import { executeManagedMcpTool, makeMcpManagedRuntime } from "./managed-runtime.js"
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
  type LspDiagnosticsReport,
  runDefaultLspDiagnostics,
} from "./tools/lsp-and-telemetry.tools.js"
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
      )
      .then((exit) => formatMcpToolExit(toolName, exit))
  })

  attachServerCloseRuntimeDisposal(server, runtime)

  return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = createServer()
  const transport = new StdioServerTransport()
  const cliRuntime = ManagedRuntime.make(NodeServices.layer)
  let daemonHandle: HarnessDaemonServerHandle | undefined = undefined
  let shuttingDown = false
  const daemonStartupPromise: Promise<HarnessDaemonServerHandle | undefined> =
    process.env.HARNESS_DAEMON_SOCK !== "0"
      ? startHarnessDaemonServer(process.cwd(), { workflowEngine: { mode: "auto" } })
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
      .then(() =>
        cliRuntime.dispose().catch((err: unknown) => {
          exitCode = 1
          process.stderr.write(
            `[harness-mcp] CLI runtime dispose error: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }),
      )
      .finally(() => process.exit(exitCode))
  }
  process.once("SIGINT", () => shutdown(0))
  process.once("SIGTERM", () => shutdown(0))
  process.stdin.once("end", () => shutdown(0))
  process.stdin.once("close", () => shutdown(0))
  void cliRuntime.runPromiseExit(Effect.tryPromise(() => server.connect(transport))).then((exit) =>
    Exit.match(exit, {
      onFailure: (cause) => {
        if (isPureInterruptCause(cause)) return
        const squashed = Cause.squash(cause)
        process.stderr.write(
          `[harness-mcp] Fatal error: ${squashed instanceof Error ? squashed.message : String(squashed)}\n`,
        )
        shutdown(1)
      },
      onSuccess: () => {
        const previousTransportOnClose = transport.onclose
        transport.onclose = () => {
          previousTransportOnClose?.()
          shutdown(0)
        }
      },
    }),
  )
}
