import { Effect, Layer, Result } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type AgentRunRequest,
  type AntigravityRunRequest,
  type ClaudeCodeRunRequest,
  type CompiledWorkUnit,
  UnitAgentDispatchResult,
  type UnitAgentRequest,
  type WorkspaceFsError,
  toAgentFailureReason,
} from "@harness/contract"
import type { TypedHoleContextBundle } from "@harness/graph"
import {
  AgentRunnerPort,
  UnitAgentDispatcher,
  type UnitAgentDispatcherShape,
} from "@harness/service"
import { toUnitAgentDispatchResult } from "./agent-runner-outcome.js"
import { type AgentRunnerPortOptions, makeAgentRunnerPortLayer } from "./agent-runners-live.js"
import { buildUnitBrief } from "./unit-brief-builder.js"

/** Options for customizing `UnitAgentDispatcher` brief hole-context injection. */
export interface UnitAgentDispatcherOptions {
  readonly loadHoleBundles?:
    | ((
        unit: CompiledWorkUnit,
        cwd: AbsoluteRepoRoot,
      ) => Effect.Effect<ReadonlyArray<TypedHoleContextBundle>>)
    | undefined
}

/** Dispatches an automatic unit via `AgentRunnerPort` (`SPEC-0036 REQ-4.1`). */
export const dispatchUnitImpl = Effect.fn("UnitAgentDispatcher.dispatchUnit")(function* (
  request: UnitAgentRequest,
  options?: UnitAgentDispatcherOptions,
): Effect.fn.Return<UnitAgentDispatchResult, WorkspaceFsError, AgentRunnerPort> {
  const port = yield* AgentRunnerPort
  const holeBundles =
    options?.loadHoleBundles !== undefined
      ? yield* options.loadHoleBundles(request.unit, request.cwd)
      : undefined

  const briefRes = Result.try({
    try: () =>
      buildUnitBrief({
        unit: request.unit,
        attempt: request.attempt,
        cwd: request.cwd,
        ...(request.priorRejection !== undefined ? { priorRejection: request.priorRejection } : {}),
        ...(holeBundles !== undefined ? { holeBundles } : {}),
        ...(request.mcpConfigPath !== undefined ? { mcpConfigPath: request.mcpConfigPath } : {}),
      }),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })

  return yield* match(briefRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.succeed(
        UnitAgentDispatchResult.cases.Failed.make({
          reason: toAgentFailureReason("UnitBriefError", failure),
        }),
      ),
    )
    .with({ _tag: "Success" }, ({ success: brief }) =>
      Effect.gen(function* () {
        const runRequest: AgentRunRequest = match(request.runner)
          .with("claude-code", (): ClaudeCodeRunRequest => ({
            runId: request.runId,
            runner: "claude-code",
            brief,
            cwd: request.cwd,
          }))
          .with("antigravity", (): AntigravityRunRequest => ({
            runId: request.runId,
            runner: "antigravity",
            brief,
            cwd: request.cwd,
            ...(request.mcpIsolation !== undefined ? { mcpIsolation: request.mcpIsolation } : {}),
            ...(request.hardMcpFallback !== undefined
              ? { hardMcpFallback: request.hardMcpFallback }
              : {}),
          }))
          .exhaustive()

        const runResult = yield* port.run(runRequest).pipe(Effect.result)

        return yield* match(runResult)
          .with({ _tag: "Success" }, ({ success: runOutcome }) =>
            Effect.gen(function* () {
              const usageAttrs = match(runOutcome.usage)
                .with({ _tag: "Unavailable" }, () => ({}))
                .with({ _tag: "Reported" }, (u) => ({
                  ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
                  ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
                  ...(u.thinkingTokens !== undefined ? { thinkingTokens: u.thinkingTokens } : {}),
                  ...(u.totalTokens !== undefined ? { totalTokens: u.totalTokens } : {}),
                  ...(u.numTurns !== undefined ? { numTurns: u.numTurns } : {}),
                  ...(u.totalCostUsd !== undefined ? { totalCostUsd: u.totalCostUsd } : {}),
                  ...(u.durationMillis !== undefined ? { durationMillis: u.durationMillis } : {}),
                }))
                .exhaustive()
              yield* Effect.annotateCurrentSpan({
                runner: runOutcome.runner,
                resultLength: runOutcome.resultText.length,
                "usage._tag": runOutcome.usage._tag,
                ...usageAttrs,
              })
              return UnitAgentDispatchResult.cases.Completed.make({})
            }),
          )
          .with({ _tag: "Failure" }, ({ failure }) =>
            Effect.succeed(toUnitAgentDispatchResult(failure)),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})

/** Builds a `UnitAgentDispatcher` layer delegating to the contextual `AgentRunnerPort`. */
const makeUnitAgentDispatcherLayerFromPort = (
  options?: UnitAgentDispatcherOptions,
): Layer.Layer<UnitAgentDispatcher, never, AgentRunnerPort> =>
  Layer.effect(
    UnitAgentDispatcher,
    Effect.gen(function* () {
      const runner = yield* AgentRunnerPort
      return {
        runnerKind: "live" as const,
        dispatchUnit: (request) =>
          dispatchUnitImpl(request, options).pipe(Effect.provideService(AgentRunnerPort, runner)),
      } satisfies UnitAgentDispatcherShape
    }),
  )

/** Builds a self-contained `UnitAgentDispatcher` layer backed by `makeAgentRunnerPortLayer`. */
const makeUnitAgentDispatcherLayer = (
  options?: UnitAgentDispatcherOptions & AgentRunnerPortOptions,
): Layer.Layer<UnitAgentDispatcher> =>
  makeUnitAgentDispatcherLayerFromPort(options).pipe(
    Layer.provide(makeAgentRunnerPortLayer(options)),
  )

/** Live `UnitAgentDispatcher` layer delegating to the contextual `AgentRunnerPort`. */
export const UnitAgentDispatcherLiveFromPort: Layer.Layer<
  UnitAgentDispatcher,
  never,
  AgentRunnerPort
> = makeUnitAgentDispatcherLayerFromPort()

/** Live `UnitAgentDispatcher` layer backed by `AgentRunnerPortLive`. */
export const UnitAgentDispatcherLive: Layer.Layer<UnitAgentDispatcher> =
  makeUnitAgentDispatcherLayer()

export { makeUnitAgentDispatcherLayer, makeUnitAgentDispatcherLayerFromPort }
