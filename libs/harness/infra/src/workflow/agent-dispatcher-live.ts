import { Effect, Layer } from "effect"
import { match } from "ts-pattern"
import {
  UnitAgentDispatchResult,
  type UnitAgentRequest,
  type WorkspaceFsError,
} from "@harness/contract"
import {
  AgentRunnerPort,
  UnitAgentDispatcher,
  type UnitAgentDispatcherShape,
} from "@harness/service"
import { toUnitAgentDispatchResult } from "./agent-runner-outcome.js"
import { AgentRunnerPortLive } from "./agent-runners-live.js"
import { buildUnitBrief } from "./unit-brief-builder.js"

/** Dispatches an automatic unit via `AgentRunnerPort` (`SPEC-0036` / `REQ-4.4`). */
export const dispatchUnitImpl = Effect.fn("UnitAgentDispatcher.dispatchUnit")(function* (
  request: UnitAgentRequest,
): Effect.fn.Return<UnitAgentDispatchResult, WorkspaceFsError, AgentRunnerPort> {
  const port = yield* AgentRunnerPort
  const brief = buildUnitBrief({
    unit: request.unit,
    attempt: request.attempt,
    cwd: request.cwd,
    ...(request.priorRejection !== undefined ? { priorRejection: request.priorRejection } : {}),
  })
  const runResult = yield* port
    .run({
      runId: request.runId,
      runner: request.runner,
      brief,
      cwd: request.cwd,
    })
    .pipe(Effect.result)

  return match(runResult)
    .with({ _tag: "Success" }, () => UnitAgentDispatchResult.cases.Completed.make({}))
    .with({ _tag: "Failure" }, ({ failure }) => toUnitAgentDispatchResult(failure))
    .exhaustive()
})

/** Live `UnitAgentDispatcher` layer delegating to the contextual `AgentRunnerPort`. */
export const UnitAgentDispatcherLiveFromPort: Layer.Layer<
  UnitAgentDispatcher,
  never,
  AgentRunnerPort
> = Layer.effect(
  UnitAgentDispatcher,
  Effect.gen(function* () {
    const runner = yield* AgentRunnerPort
    return {
      runnerKind: "live" as const,
      dispatchUnit: (request) =>
        dispatchUnitImpl(request).pipe(Effect.provideService(AgentRunnerPort, runner)),
    } satisfies UnitAgentDispatcherShape
  }),
)

/** Live `UnitAgentDispatcher` layer backed by `AgentRunnerPortLive`. */
export const UnitAgentDispatcherLive: Layer.Layer<UnitAgentDispatcher> =
  UnitAgentDispatcherLiveFromPort.pipe(Layer.provide(AgentRunnerPortLive))
