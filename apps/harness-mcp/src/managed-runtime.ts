import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Logger, ManagedRuntime } from "effect"
import { isPureInterruptCause } from "@harness/contract"
import { HarnessInfraLive, OllamaEmbeddingClientLive, OllamaReadiness } from "@harness/infra"
import {
  recordMcpToolTelemetry,
  type ServerOptions,
  shouldSuppressLiveMcpTestSideEffects,
} from "./tools/mcp-helpers.js"
import {
  type DispatchMcpToolInput,
  dispatchMcpTool,
  makeLiveMcpToolRegistryLayer,
  type McpToolExecutionError,
  type McpToolRegistry,
} from "./tools/tool-registry.js"

export const makeMcpMainLayer = (options?: ServerOptions) => {
  const base = Layer.mergeAll(
    HarnessInfraLive,
    NodeServices.layer,
    makeLiveMcpToolRegistryLayer(options),
    Layer.succeed(Logger.LogToStderr, true),
  )
  return options?.extraLayer !== undefined ? Layer.mergeAll(base, options.extraLayer) : base
}

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

/**
 * Launches non-blocking background Ollama (`clef-flash` + embeddings) warm-up during MCP startup (`SPEC-0037 REQ-2.1..2.3`).
 */
export const launchBackgroundOllamaWarmup = <A, E>(
  runtime: ManagedRuntime.ManagedRuntime<A, E>,
  startupRepoRoot: string,
): void => {
  if (
    process.env["HARNESS_SKIP_OLLAMA_WARMUP"] === "1" ||
    shouldSuppressLiveMcpTestSideEffects(startupRepoRoot)
  ) {
    return
  }
  void runtime
    .runPromiseExit(
      OllamaReadiness.ensureWarm().pipe(
        Effect.provide(OllamaEmbeddingClientLive),
        Effect.catchTag("OllamaWarmupError", (err) =>
          Effect.sync(() => {
            process.stderr.write(
              `[harness-mcp] Ollama warm-up warning [${err.stage}] (${err.model} @ ${err.endpoint}): ${err.reason}\n`,
            )
          }),
        ),
      ),
    )
    .then((exit) =>
      Exit.match(exit, {
        onFailure: (cause) => {
          if (isPureInterruptCause(cause)) return
          const squashed = Cause.squash(cause)
          process.stderr.write(
            `[harness-mcp] Ollama warm-up warning: ${squashed instanceof Error ? squashed.message : String(squashed)}\n`,
          )
        },
        onSuccess: () => undefined,
      }),
    )
}
