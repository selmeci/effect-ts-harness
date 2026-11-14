import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Logger } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { routeStep } from "../src/index.js"

describe("Decision catchCauseIf interrupt propagation & defect warning (F-6.3)", () => {
  it.effect("propagates fiber interruption through catchCauseIf without returning fallback", () =>
    Effect.gen(function* () {
      const interruptLayer = Layer.succeed(DecisionModel.DecisionModel, {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: () => Effect.interrupt,
      })

      const exit = yield* routeStep("Add Schema validation for user input").pipe(
        Effect.provide(interruptLayer),
        Effect.exit,
      )
      match(exit)
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasInterrupts(cause)).toBe(true)
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected fiber interruption to propagate")
        })
        .exhaustive()
    }),
  )

  it.effect("logs a warning diagnostic on model Effect.die defect before falling back", () =>
    Effect.gen(function* () {
      const warnings: Array<string> = []
      const captureLogger = Logger.make((options) => {
        if (options.logLevel === "Warn") {
          warnings.push(String(options.message))
        }
      })

      const dieLayer = Layer.succeed(DecisionModel.DecisionModel, {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: () => Effect.die(new Error("simulated model defect")),
      })

      const result = yield* routeStep("Add Schema validation for user input").pipe(
        Effect.provide(Layer.mergeAll(dieLayer, Logger.layer([captureLogger]))),
      )

      expect(typeof result).toBe("string")
      expect(warnings.some((w) => w.includes("Decision model fallback:"))).toBe(true)
    }),
  )
})
