import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import * as AiError from "effect/ai/AiError"
import type * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { TestClock } from "effect/testing"
import {
  CandidateSymbolKey,
  HoleRelevanceAndEdgePriorV1,
  ProposedRoleName,
  buildBatchedHolePriorDecision,
  evaluateHoleCandidatePrior,
  evaluateHoleCandidatePriorsBatch,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
} from "../src/index.js"

describe("HoleRelevanceAndEdgePriorV1 (System One Calibrated Edge & PPR Prior Sensor)", () => {
  const defaultInput = {
    holeSpanName: "Cart.addItem" as const,
    holeSignatureSummary: "Effect<CartUpdated, CartLimitExceededError, CartRepo>",
    candidateSymbolKey: CandidateSymbolKey.make("EffectFn:libs/sample/domain/src/cart.ts#decide"),
    candidateSignatureSummary: "Effect.fn('Cart.decide') (R = never)",
    proposedRole: ProposedRoleName.make("callee"),
    earsClauseContext: "While evaluating cart state, Cart.addItem shall delegate to Cart.decide",
  }

  it.effect("evaluates edgeConfidenceMillis and teleportationWeightMillis via DecisionModel", () =>
    Effect.gen(function* () {
      expect(Object.keys(HoleRelevanceAndEdgePriorV1.decisions)).toEqual([
        "edgeConfidence",
        "candidateRelevance",
      ])

      const res = yield* evaluateHoleCandidatePrior(defaultInput).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            edgeConfidenceProb: 0.94,
            candidateRelevanceLabel: "essential",
          }),
        ),
      )

      expect(res.source).toEqual({ _tag: "DecisionModel" })
      expect(res.edgeConfidenceMillis).toBe(940)
      expect(res.teleportationWeightMillis).toBe(1000)
      expect(res.relevanceLabel).toBe("essential")
    }),
  )

  it.effect("falls back deterministically when DecisionModel is unavailable or fails", () =>
    Effect.gen(function* () {
      const res = yield* evaluateHoleCandidatePrior({
        holeSpanName: "Cart.addItem",
        holeSignatureSummary: "Effect<CartUpdated, CartLimitExceededError, CartRepo>",
        candidateSymbolKey: CandidateSymbolKey.make("ServiceTag:CartRepo"),
        candidateSignatureSummary: "Context.Service<CartRepo>",
        proposedRole: ProposedRoleName.make("requires-service"),
        earsClauseContext: "Where CartRepo is configured",
      }).pipe(Effect.provide(makeFailingDecisionModelLayer()))

      expect(res.source).toEqual({
        _tag: "DeterministicFallback",
        reason: "timeout-or-unavailable",
      })
      expect(res.edgeConfidenceMillis).toBe(500)
      expect(res.teleportationWeightMillis).toBe(333)
      expect(res.relevanceLabel).toBe("tangential")
    }),
  )

  it.effect("maps all 4 relevance labels to their exact millisecond weights", () =>
    Effect.gen(function* () {
      const irrelevantRes = yield* evaluateHoleCandidatePrior(defaultInput).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            edgeConfidenceProb: 0.5,
            candidateRelevanceLabel: "irrelevant",
          }),
        ),
      )
      expect(irrelevantRes.relevanceLabel).toBe("irrelevant")
      expect(irrelevantRes.teleportationWeightMillis).toBe(0)

      const tangentialRes = yield* evaluateHoleCandidatePrior(defaultInput).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            edgeConfidenceProb: 0.5,
            candidateRelevanceLabel: "tangential",
          }),
        ),
      )
      expect(tangentialRes.relevanceLabel).toBe("tangential")
      expect(tangentialRes.teleportationWeightMillis).toBe(333)

      const helpfulRes = yield* evaluateHoleCandidatePrior(defaultInput).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            edgeConfidenceProb: 0.5,
            candidateRelevanceLabel: "helpful",
          }),
        ),
      )
      expect(helpfulRes.relevanceLabel).toBe("helpful")
      expect(helpfulRes.teleportationWeightMillis).toBe(667)

      const essentialRes = yield* evaluateHoleCandidatePrior(defaultInput).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            edgeConfidenceProb: 0.5,
            candidateRelevanceLabel: "essential",
          }),
        ),
      )
      expect(essentialRes.relevanceLabel).toBe("essential")
      expect(essentialRes.teleportationWeightMillis).toBe(1000)
    }),
  )

  it.effect(
    "returns DeterministicFallback (invalid-output) on unknown relevance label or NaN probability instead of fabricating DecisionModel output",
    () =>
      Effect.gen(function* () {
        const unknownLabelLayer = Layer.succeed(DecisionModel.DecisionModel, {
          [DecisionModel.TypeId]: DecisionModel.TypeId,
          decide: <Input extends Schema.Constraint, Decisions extends Record<string, Decision.Any>>(
            _definition: Decision.Definition<Input, Decisions>,
            _options: DecisionModel.DecideOptions<Input>,
          ): Effect.Effect<DecisionModel.DecideResponse<Decisions>, AiError.AiError, never> => {
            const answers = {
              edgeConfidence: { probability: 0.8 },
              candidateRelevance: { rating: 0, label: "unknown-label" },
            } as Decision.Answers<Decisions>
            return Effect.succeed({
              answers,
              usage: new DecisionModel.DecisionUsage({}),
            })
          },
        })

        const res = yield* evaluateHoleCandidatePrior(defaultInput).pipe(
          Effect.provide(unknownLabelLayer),
        )
        expect(res.source).toEqual({
          _tag: "DeterministicFallback",
          reason: "invalid-output",
        })
        expect(res.edgeConfidenceMillis).toBe(500)
        expect(res.relevanceLabel).toBe("tangential")
        expect(res.teleportationWeightMillis).toBe(333)

        const nanProbLayer = Layer.succeed(DecisionModel.DecisionModel, {
          [DecisionModel.TypeId]: DecisionModel.TypeId,
          decide: <Input extends Schema.Constraint, Decisions extends Record<string, Decision.Any>>(
            _definition: Decision.Definition<Input, Decisions>,
            _options: DecisionModel.DecideOptions<Input>,
          ): Effect.Effect<DecisionModel.DecideResponse<Decisions>, AiError.AiError, never> => {
            const answers = {
              edgeConfidence: { probability: Number.NaN },
              candidateRelevance: { rating: 3, label: "essential" },
            } as Decision.Answers<Decisions>
            return Effect.succeed({
              answers,
              usage: new DecisionModel.DecisionUsage({}),
            })
          },
        })

        const nanRes = yield* evaluateHoleCandidatePrior(defaultInput).pipe(
          Effect.provide(nanProbLayer),
        )
        expect(nanRes.source).toEqual({
          _tag: "DeterministicFallback",
          reason: "invalid-output",
        })
        expect(nanRes.edgeConfidenceMillis).toBe(500)
        expect(nanRes.relevanceLabel).toBe("tangential")
        expect(nanRes.teleportationWeightMillis).toBe(333)
      }),
  )

  it.effect("clamps edge confidence probability to [0, 1000]", () =>
    Effect.gen(function* () {
      const makeProbabilityLayer = (probability: number) =>
        Layer.succeed(DecisionModel.DecisionModel, {
          [DecisionModel.TypeId]: DecisionModel.TypeId,
          decide: <Input extends Schema.Constraint, Decisions extends Record<string, Decision.Any>>(
            _definition: Decision.Definition<Input, Decisions>,
            _options: DecisionModel.DecideOptions<Input>,
          ): Effect.Effect<DecisionModel.DecideResponse<Decisions>, AiError.AiError, never> => {
            const answers = {
              edgeConfidence: { probability },
              candidateRelevance: { rating: 3, label: "essential" },
            } as Decision.Answers<Decisions>
            return Effect.succeed({
              answers,
              usage: new DecisionModel.DecisionUsage({}),
            })
          },
        })

      const overRes = yield* evaluateHoleCandidatePrior(defaultInput).pipe(
        Effect.provide(makeProbabilityLayer(1.5)),
      )
      expect(overRes.edgeConfidenceMillis).toBe(1000)

      const underRes = yield* evaluateHoleCandidatePrior(defaultInput).pipe(
        Effect.provide(makeProbabilityLayer(-0.2)),
      )
      expect(underRes.edgeConfidenceMillis).toBe(0)
    }),
  )

  it.effect("falls back deterministically when DecisionModel times out after 1500ms", () =>
    Effect.gen(function* () {
      const timeoutLayer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () =>
            Effect.sleep("5 seconds").pipe(
              Effect.as({
                answers: {},
                usage: { inputTokens: 0, outputTokens: 0 },
              }),
            ),
        }),
      )

      const fiber = yield* Effect.forkChild(
        evaluateHoleCandidatePrior(defaultInput).pipe(Effect.provide(timeoutLayer)),
      )
      yield* TestClock.adjust("2000 millis")
      const res = yield* Fiber.join(fiber)

      expect(res.source).toEqual({
        _tag: "DeterministicFallback",
        reason: "timeout-or-unavailable",
      })
      expect(res.edgeConfidenceMillis).toBe(500)
      expect(res.teleportationWeightMillis).toBe(333)
      expect(res.relevanceLabel).toBe("tangential")
    }),
  )

  it("propagates defect without swallowing it in catchCauseIf", async () => {
    const dieLayer = Layer.succeed(DecisionModel.DecisionModel, {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: () => Effect.die(new Error("boom")),
    })

    const exit = await Effect.runPromiseExit(
      evaluateHoleCandidatePrior(defaultInput).pipe(Effect.provide(dieLayer)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
    }
  })

  it.effect(
    "REQ-3.1: evaluates batched HoleRelevanceAndEdgePriorV1 (up to 32 candidates = 64 questions per forward pass) and produces SemanticEdgePriors across multi-chunk batches",
    () =>
      Effect.gen(function* () {
        const batchedDef = buildBatchedHolePriorDecision(32)
        expect(Object.keys(batchedDef.decisions)).toHaveLength(64)

        const emptyBatch = yield* evaluateHoleCandidatePriorsBatch([]).pipe(
          Effect.provide(makeMockDecisionModelLayer()),
        )
        expect(emptyBatch.results).toHaveLength(0)

        const batchInputs = [
          defaultInput,
          {
            holeSpanName: "Cart.addItem" as const,
            holeSignatureSummary: "Effect<CartUpdated, CartLimitExceededError, CartRepo>",
            candidateSymbolKey: CandidateSymbolKey.make("ServiceTag:CartRepo"),
            candidateSignatureSummary: "Context.Service<CartRepo>",
            proposedRole: ProposedRoleName.make("requires-service"),
            earsClauseContext: "Where CartRepo is configured",
          },
        ]

        const batchRes = yield* evaluateHoleCandidatePriorsBatch(batchInputs).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              edgeConfidenceProb: 0.91,
              candidateRelevanceLabel: "essential",
            }),
          ),
        )

        expect(batchRes.source).toEqual({ _tag: "DecisionModel" })
        expect(batchRes.results).toHaveLength(2)
        expect(
          batchRes.edgeConfidenceOverrides["EffectFn:libs/sample/domain/src/cart.ts#decide:callee"],
        ).toBe(910)
        expect(batchRes.edgeConfidenceOverrides["ServiceTag:CartRepo:requires-service"]).toBe(910)
        expect(
          batchRes.holeTeleportationWeights[
            CandidateSymbolKey.make("EffectFn:libs/sample/domain/src/cart.ts#decide")
          ],
        ).toBe(1000)

        // Multi-chunk batch (35 candidates => chunk of 32 + chunk of 3)
        const multiChunkInputs = Array.from({ length: 35 }, (_, idx) => ({
          ...defaultInput,
          candidateSymbolKey: CandidateSymbolKey.make(`ServiceTag:Svc${idx}`),
          proposedRole: ProposedRoleName.make("requires-service"),
        }))
        const multiChunkRes = yield* evaluateHoleCandidatePriorsBatch(multiChunkInputs).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              edgeConfidenceProb: 0.88,
              candidateRelevanceLabel: "helpful",
            }),
          ),
        )
        expect(multiChunkRes.results).toHaveLength(35)
        expect(multiChunkRes.edgeConfidenceOverrides["ServiceTag:Svc34:requires-service"]).toBe(880)

        // Fallback on failing model
        const fallbackBatch = yield* evaluateHoleCandidatePriorsBatch(batchInputs).pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )
        expect(fallbackBatch.source).toEqual({
          _tag: "DeterministicFallback",
          reason: "timeout-or-unavailable",
        })
        expect(fallbackBatch.results).toHaveLength(2)
        expect(fallbackBatch.edgeConfidenceOverrides["ServiceTag:CartRepo:requires-service"]).toBe(
          500,
        )
      }),
  )
})
