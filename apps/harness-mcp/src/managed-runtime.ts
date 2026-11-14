import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Logger, ManagedRuntime } from "effect"
import { HarnessInfraLive } from "@harness/infra"
import { recordMcpToolTelemetry, type ServerOptions } from "./tools/mcp-helpers.js"
import {
  type DispatchMcpToolInput,
  dispatchMcpTool,
  makeLiveMcpToolRegistryLayer,
  type McpToolExecutionError,
  type McpToolRegistry,
} from "./tools/tool-registry.js"

export const makeMcpMainLayer = (options?: ServerOptions) =>
  Layer.mergeAll(
    HarnessInfraLive,
    NodeServices.layer,
    makeLiveMcpToolRegistryLayer(options),
    Layer.succeed(Logger.LogToStderr, true),
  )

export const makeMcpManagedRuntime = (options?: ServerOptions) =>
  ManagedRuntime.make(makeMcpMainLayer(options))

export const executeManagedMcpTool = Effect.fn("HarnessMcp.executeManagedTool")(function* (
  input: DispatchMcpToolInput,
  options?: ServerOptions,
): Effect.fn.Return<unknown, McpToolExecutionError, McpToolRegistry> {
  const startTime = performance.now()
  const result: unknown = yield* dispatchMcpTool(input)
  const durationMs = Math.max(0, Math.round(performance.now() - startTime))
  recordMcpToolTelemetry(input.toolName, input.args, result, durationMs, options)
  return result
})
