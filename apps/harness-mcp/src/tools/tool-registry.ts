import { Context, Effect, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"

export const McpToolName = Schema.NonEmptyString.pipe(Schema.brand("McpToolName"))
export type McpToolName = typeof McpToolName.Type

export const McpToolInputName = Schema.String.pipe(Schema.brand("McpToolInputName"))
export type McpToolInputName = typeof McpToolInputName.Type

export class UnknownToolError extends Schema.TaggedError<UnknownToolError>()("UnknownToolError", {
  toolName: McpToolInputName,
}) {}

export interface McpToolPluginDescriptor {
  readonly name: McpToolName
  readonly description: string
  readonly execute: (
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, UnknownToolError>
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
    byName.set(t.name, t)
  }
  return Layer.succeed(McpToolRegistry, {
    listTools: Effect.succeed(tools),
    resolveTool: (name) => Effect.succeed(Option.fromUndefinedOr(byName.get(name))),
  })
}

export const CANONICAL_MCP_TOOL_NAMES: ReadonlyArray<McpToolName> = [
  McpToolName.make("harness_resolve"),
  McpToolName.make("harness_callers"),
  McpToolName.make("harness_callees"),
  McpToolName.make("harness_tests_reaching"),
  McpToolName.make("harness_structural_search"),
  McpToolName.make("harness_route"),
  McpToolName.make("harness_ontology_why"),
  McpToolName.make("harness_ontology_impact"),
  McpToolName.make("harness_ontology_check"),
  McpToolName.make("harness_gq_query"),
  McpToolName.make("harness_graph_infer"),
  McpToolName.make("harness_graph_complete"),
  McpToolName.make("harness_graph_rewrite"),
  McpToolName.make("harness_lsp_diagnostics"),
  McpToolName.make("harness_telemetry_report"),
]

export const McpToolRegistryLive: Layer.Layer<McpToolRegistry> = makeMcpToolRegistryLayer(
  CANONICAL_MCP_TOOL_NAMES.map((name) => ({
    name,
    description: `Registered handler for ${name}`,
    execute: (args) => Effect.succeed({ tool: name, args }),
  })),
)

export interface DispatchMcpToolInput {
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
}

export const dispatchMcpTool = Effect.fn("HarnessMcp.dispatchTool")(function* (
  input: DispatchMcpToolInput,
): Effect.fn.Return<unknown, UnknownToolError, McpToolRegistry> {
  const registry = yield* McpToolRegistry
  const resolved = yield* registry.resolveTool(input.toolName)
  return yield* match(resolved)
    .with({ _tag: "Some" }, ({ value }) => value.execute(input.args))
    .with({ _tag: "None" }, () => new UnknownToolError({ toolName: McpToolInputName.make(input.toolName) }))
    .exhaustive()
})
