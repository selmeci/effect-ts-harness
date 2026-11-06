import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  HoleRelevanceAndEdgePriorV1,
  evaluateHoleCandidatePrior,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
} from "../src/index.js"

describe("HoleRelevanceAndEdgePriorV1 (System One Calibrated Edge & PPR Prior Sensor)", () => {
  it.effect(
    "evaluates edgeConfidenceMillis and teleportationWeightMillis via DecisionModel",
    () =>
      Effect.gen(function* () {
        expect(Object.keys(HoleRelevanceAndEdgePriorV1.decisions)).toEqual([
          "edgeConfidence",
          "candidateRelevance",
        ])

        const res = yield* evaluateHoleCandidatePrior({
          holeSpanName: "Cart.addItem",
          holeSignatureSummary: "Effect<CartUpdated, CartLimitExceededError, CartRepo>",
          candidateSymbolKey: "EffectFn:libs/sample/domain/src/cart.ts#decide",
          candidateSignatureSummary: "Effect.fn('Cart.decide') (R = never)",
          proposedRole: "callee",
          earsClauseContext: "While evaluating cart state, Cart.addItem shall delegate to Cart.decide",
        }).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              edgeConfidenceProb: 0.94,
              candidateRelevanceLabel: "essential",
            }),
          ),
        )

        expect(res.source).toBe("decision-model")
        expect(res.edgeConfidenceMillis).toBe(940)
        expect(res.teleportationWeightMillis).toBe(1000)
        expect(res.relevanceLabel).toBe("essential")
      }),
  )

  it.effect(
    "falls back deterministically when DecisionModel is unavailable or times out",
    () =>
      Effect.gen(function* () {
        const res = yield* evaluateHoleCandidatePrior({
          holeSpanName: "Cart.addItem",
          holeSignatureSummary: "Effect<CartUpdated, CartLimitExceededError, CartRepo>",
          candidateSymbolKey: "ServiceTag:CartRepo",
          candidateSignatureSummary: "Context.Service<CartRepo>",
          proposedRole: "requires-service",
          earsClauseContext: "Where CartRepo is configured",
        }).pipe(Effect.provide(makeFailingDecisionModelLayer()))

        expect(res.source).toBe("deterministic-fallback")
        expect(res.edgeConfidenceMillis).toBe(850)
        expect(res.teleportationWeightMillis).toBe(750)
        expect(res.relevanceLabel).toBe("helpful")
      }),
  )
})
