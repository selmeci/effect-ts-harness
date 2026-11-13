import { Context, Effect, Layer, Option } from "effect"
import { match } from "ts-pattern"
import { buildDatalogAndDpoToolDescriptors } from "./datalog-and-dpo.tools.js"
import { buildGraphNavigationToolDescriptors } from "./graph-navigation.tools.js"
import { buildLspAndTelemetryToolDescriptors } from "./lsp-and-telemetry.tools.js"
import {
  type McpToolExecutionError,
  McpToolInputName,
  McpToolName,
  type McpToolPluginDescriptor,
  type McpToolInputSchema,
  type ServerOptions,
  UnknownToolError,
} from "./mcp-helpers.js"
import { buildOntologyAndGqToolDescriptors } from "./ontology-and-gq.tools.js"

export {
  type McpToolExecutionError,
  McpToolInputName,
  McpToolName,
  UnknownToolError,
  type McpToolInputSchema,
  type McpToolPluginDescriptor,
}

export interface McpToolRegistryShape {
  readonly listTools: Effect.Effect<ReadonlyArray<McpToolPluginDescriptor>>
  readonly resolveTool: (name: string) => Effect.Effect<Option.Option<McpToolPluginDescriptor>>
}

export class McpToolRegistry extends Context.Service<McpToolRegistry, McpToolRegistryShape>()(
  "harness-mcp/McpToolRegistry",
) {}

export const makeMcpToolRegistryLayer = (
  tools: ReadonlyArray<McpToolPluginDescriptor>,
): Layer.Layer<McpToolRegistry> => {
  const byName = new Map<string, McpToolPluginDescriptor>()
  for (const t of tools) {
    if (byName.has(t.name)) {
      Effect.runSync(Effect.die(new Error(`Duplicate MCP tool registered: ${t.name}`)))
    }
    byName.set(t.name, t)
  }
  const readonlyByName: ReadonlyMap<string, McpToolPluginDescriptor> = byName
  return Layer.succeed(McpToolRegistry, {
    listTools: Effect.succeed(tools),
    resolveTool: (name) => Effect.succeed(Option.fromUndefinedOr(readonlyByName.get(name))),
  })
}

export type McpToolHandler = (
  args: Readonly<Record<string, unknown>>,
) => Effect.Effect<unknown, McpToolExecutionError>

export const buildLiveMcpToolDescriptors = (
  options?: ServerOptions,
): ReadonlyArray<McpToolPluginDescriptor> => [
  ...buildGraphNavigationToolDescriptors(options),
  ...buildOntologyAndGqToolDescriptors(options),
  ...buildLspAndTelemetryToolDescriptors(options),
  ...buildDatalogAndDpoToolDescriptors(options),
]

const STATIC_LIVE_TOOL_DESCRIPTORS: ReadonlyArray<McpToolPluginDescriptor> =
  buildLiveMcpToolDescriptors()

const STATIC_LIVE_TOOL_MAP: ReadonlyMap<string, McpToolPluginDescriptor> = new Map(
  STATIC_LIVE_TOOL_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor]),
)

export const CANONICAL_MCP_TOOL_NAMES: ReadonlyArray<McpToolName> =
  STATIC_LIVE_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)

export const McpToolRegistryLive: Layer.Layer<McpToolRegistry> = Layer.succeed(McpToolRegistry, {
  listTools: Effect.succeed(STATIC_LIVE_TOOL_DESCRIPTORS),
  resolveTool: (name) => Effect.succeed(Option.fromUndefinedOr(STATIC_LIVE_TOOL_MAP.get(name))),
})

export const makeLiveMcpToolRegistryLayer = (
  options?: ServerOptions,
): Layer.Layer<McpToolRegistry> =>
  options === undefined
    ? McpToolRegistryLive
    : makeMcpToolRegistryLayer(buildLiveMcpToolDescriptors(options))

export interface DispatchMcpToolInput {
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
}

export const dispatchMcpTool = Effect.fn("HarnessMcp.dispatchTool")(function* (
  input: DispatchMcpToolInput,
): Effect.fn.Return<unknown, McpToolExecutionError, McpToolRegistry> {
  const registry = yield* McpToolRegistry
  const resolved = yield* registry.resolveTool(input.toolName)
  return yield* match(resolved)
    .with({ _tag: "Some" }, ({ value }) => value.execute(input.args))
    .with({ _tag: "None" }, () => new UnknownToolError({ toolName: McpToolInputName.make(input.toolName) }))
    .exhaustive()
})
