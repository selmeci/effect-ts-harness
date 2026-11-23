import { Effect, Layer } from "effect"
import {
  AgentFailureReason,
  UnitAgentDispatchResult,
  type UnitAgentRequest,
} from "@harness/contract"
import { UnitAgentDispatcher, type UnitAgentDispatcherShape } from "@harness/service"

/** WF-3 placeholder dispatcher layer (live `claude-code` / `antigravity` runners land in WF-5). */
export const UnitAgentDispatcherLive: Layer.Layer<UnitAgentDispatcher> = Layer.succeed(
  UnitAgentDispatcher,
  {
    runnerKind: "placeholder" as const,
    dispatchUnit: (_request: UnitAgentRequest) =>
      Effect.succeed(
        UnitAgentDispatchResult.cases.Failed.make({
          reason: AgentFailureReason.make(
            "Automatic agent runner dispatch lands in WF-5; supply a test UnitAgentDispatcher layer or run in manual mode",
          ),
        }),
      ),
  } satisfies UnitAgentDispatcherShape,
)
