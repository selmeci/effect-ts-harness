import { Context, Effect, Layer, Option } from "effect"
import { match } from "ts-pattern"
import { buildDatalogAndDpoToolDescriptors } from "./datalog-and-dpo.tools.js"
import { buildGitDiffToolDescriptors } from "./git-diff.tools.js"
import { buildGraphNavigationToolDescriptors } from "./graph-navigation.tools.js"
import { buildLspAndTelemetryToolDescriptors } from "./lsp-and-telemetry.tools.js"
import { createLspSessionCache, type LspSessionCache } from "./lsp-session-cache.js"
import {
  CANONICAL_MCP_TOOL_NAMES,
  type McpToolExecutionError,
  McpToolInputName,
  McpToolName,
  type McpToolPluginDescriptor,
  type McpToolInputSchema,
  type ServerOptions,
  toMcpToolInputName,
  UnknownToolError,
} from "./mcp-helpers.js"
import { buildOntologyAndGqToolDescriptors } from "./ontology-and-gq.tools.js"
import { buildRetrievalToolDescriptors } from "./retrieval.tools.js"
import { buildWorkflowPlanToolDescriptors } from "./workflow-plan.tools.js"

export {
  CANONICAL_MCP_TOOL_NAMES,
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

const buildRegistryService = (
  tools: ReadonlyArray<McpToolPluginDescriptor>,
): Effect.Effect<McpToolRegistryShape> =>
  Effect.gen(function* () {
    const byName = new Map<string, McpToolPluginDescriptor>()
    for (const t of tools) {
      if (byName.has(t.name)) {
        return yield* Effect.die(new Error(`Duplicate MCP tool registered: ${t.name}`))
      }
      byName.set(t.name, t)
    }
    const readonlyByName: ReadonlyMap<string, McpToolPluginDescriptor> = byName
    return McpToolRegistry.of({
      listTools: Effect.succeed(tools),
      resolveTool: (name) => Effect.succeed(Option.fromUndefinedOr(readonlyByName.get(name))),
    })
  })

export const makeMcpToolRegistryLayer = (
  tools: ReadonlyArray<McpToolPluginDescriptor>,
): Layer.Layer<McpToolRegistry> => Layer.effect(McpToolRegistry, buildRegistryService(tools))

export type McpToolHandler = (
  args: Readonly<Record<string, unknown>>,
) => Effect.Effect<unknown, McpToolExecutionError>

export const buildLiveMcpToolDescriptors = (
  options?: ServerOptions,
  lspSessionCache?: LspSessionCache,
): ReadonlyArray<McpToolPluginDescriptor> => [
  ...buildGraphNavigationToolDescriptors(options),
  ...buildOntologyAndGqToolDescriptors(options),
  ...buildLspAndTelemetryToolDescriptors(options, lspSessionCache),
  ...buildDatalogAndDpoToolDescriptors(options),
  ...buildGitDiffToolDescriptors(options),
  ...buildWorkflowPlanToolDescriptors(options),
  ...buildRetrievalToolDescriptors(options),
]

export const makeLiveMcpToolRegistryLayer = (
  options?: ServerOptions,
): Layer.Layer<McpToolRegistry> =>
  Layer.effect(
    McpToolRegistry,
    Effect.gen(function* () {
      const lspSessionCache = yield* Effect.acquireRelease(
        Effect.sync(
          () => options?.lspSessionCache ?? createLspSessionCache(options?.lspSessionCacheOptions),
        ),
        (cache) =>
          Effect.sync(() => {
            if (options?.lspSessionCache === undefined) {
              cache.clear()
            }
          }),
      )
      return yield* buildRegistryService(buildLiveMcpToolDescriptors(options, lspSessionCache))
    }),
  )

export const McpToolRegistryLive: Layer.Layer<McpToolRegistry> = makeLiveMcpToolRegistryLayer()

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
    .with(
      { _tag: "None" },
      () => new UnknownToolError({ toolName: toMcpToolInputName(input.toolName) }),
    )
    .exhaustive()
})
