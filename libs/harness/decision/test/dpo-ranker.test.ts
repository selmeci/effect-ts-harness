import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  DpoCandidateRankerV1,
  NodeKey,
  RewriteRuleId,
  buildBatchedDpoRankerDecision,
  evaluateDpoCandidatePriorsBatch,
  evaluateDpoCandidateRank,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
} from "../src/index.js"

describe("DpoCandidateRankerV1 (System One Semantic Tie-Breaker for DPO Graph Rewrites — RFC-0003)", () => {
  const rep04aInput = {
    primaryNodeKey: NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#caller"),
    ruleId: RewriteRuleId.make("REP-04a"),
    violationKind: "COMP-01",
    callerSummary: "Order.caller (domain use case)",
    candidatePatchSummary:
      "REP-04a: Propagate PaymentGatewayError in Order.caller E channel via PlaysRole(fails-with)",
    earsClauseContext:
      "IF PaymentGatewayError occurs THEN Order.caller shall fail with PaymentGatewayError",
  }

  const rep04bInput = {
    primaryNodeKey: NodeKey.make("EffectFn:libs/sample/domain/src/order.ts#caller"),
    ruleId: RewriteRuleId.make("REP-04b"),
    violationKind: "COMP-01",
    callerSummary: "Order.caller (boundary handler)",
    candidatePatchSummary:
      "REP-04b: Catch and handle PaymentGatewayError locally in Order.caller via Effect.catchTag",
    earsClauseContext: "WHEN PaymentGatewayError occurs at boundary, Order.caller shall recover",
  }

  it.effect(
    "REQ-3.2: evaluates DpoCandidateRankerV1 via DecisionModel and scores aligned vs misaligned repair strategies",
    () =>
      Effect.gen(function* () {
        expect(Object.keys(DpoCandidateRankerV1.decisions)).toEqual([
          "repairStrategy",
          "architecturalCohesion",
        ])

        // Aligned with REP-04b (catch_and_translate_at_boundary + idiomatic => min(1000, 950 + 50) = 1000)
        const alignedRes = yield* evaluateDpoCandidateRank(rep04bInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              dpoStrategyLabel: "catch_and_translate_at_boundary",
              dpoCohesionLabel: "idiomatic",
            }),
          ),
        )
        expect(alignedRes.source).toEqual({ _tag: "DecisionModel" })
        expect(alignedRes.priorKey).toBe(
          "EffectFn:libs/sample/domain/src/order.ts#caller::REP-04b",
        )
        expect(alignedRes.strategyLabel).toBe("catch_and_translate_at_boundary")
        expect(alignedRes.cohesionLabel).toBe("idiomatic")
        expect(alignedRes.scoreMillis).toBe(1000)

        // Misaligned with REP-04a when model classifies strategy as catch_and_translate_at_boundary (950 - 250 = 700)
        const misalignedRes = yield* evaluateDpoCandidateRank(rep04aInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              dpoStrategyLabel: "catch_and_translate_at_boundary",
              dpoCohesionLabel: "idiomatic",
            }),
          ),
        )
        expect(misalignedRes.scoreMillis).toBe(700)
        expect(alignedRes.scoreMillis).toBeGreaterThan(misalignedRes.scoreMillis)
      }),
  )

  it.effect(
    "evaluates batched DpoCandidateRankerV1 (evaluateDpoCandidatePriorsBatch) and returns DpoCandidatePriors map",
    () =>
      Effect.gen(function* () {
        const batchedDef = buildBatchedDpoRankerDecision(16)
        expect(Object.keys(batchedDef.decisions)).toHaveLength(32)

        const emptyBatch = yield* evaluateDpoCandidatePriorsBatch([]).pipe(
          Effect.provide(makeMockDecisionModelLayer()),
        )
        expect(emptyBatch.results).toHaveLength(0)

        const batchRes = yield* evaluateDpoCandidatePriorsBatch([rep04aInput, rep04bInput]).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              dpoStrategyLabel: "catch_and_translate_at_boundary",
              dpoCohesionLabel: "good",
            }),
          ),
        )

        expect(batchRes.source).toEqual({ _tag: "DecisionModel" })
        expect(batchRes.results).toHaveLength(2)
        const score04a =
          batchRes.candidatePriors["EffectFn:libs/sample/domain/src/order.ts#caller::REP-04a"]
        const score04b =
          batchRes.candidatePriors["EffectFn:libs/sample/domain/src/order.ts#caller::REP-04b"]
        expect(score04a).toBe(550)
        expect(score04b).toBe(850)
      }),
  )

  it.effect(
    "falls back deterministically when DecisionModel fails",
    () =>
      Effect.gen(function* () {
        const singleFallback = yield* evaluateDpoCandidateRank(rep04aInput).pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )
        expect(singleFallback.source).toEqual({
          _tag: "DeterministicFallback",
          reason: "timeout-or-unavailable",
        })
        expect(singleFallback.scoreMillis).toBe(750)

        const batchFallback = yield* evaluateDpoCandidatePriorsBatch([
          rep04aInput,
          rep04bInput,
        ]).pipe(Effect.provide(makeFailingDecisionModelLayer()))
        expect(batchFallback.source).toEqual({
          _tag: "DeterministicFallback",
          reason: "timeout-or-unavailable",
        })
        expect(
          batchFallback.candidatePriors[
            "EffectFn:libs/sample/domain/src/order.ts#caller::REP-04a"
          ],
        ).toBe(750)
        expect(
          batchFallback.candidatePriors[
            "EffectFn:libs/sample/domain/src/order.ts#caller::REP-04b"
          ],
        ).toBe(750)
      }),
  )

  it.live(
    "falls back deterministically when DecisionModel times out after 1500ms",
    () =>
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

        const res = yield* evaluateDpoCandidateRank(rep04aInput).pipe(
          Effect.provide(timeoutLayer),
        )
        expect(res.source).toEqual({
          _tag: "DeterministicFallback",
          reason: "timeout-or-unavailable",
        })
        expect(res.scoreMillis).toBe(750)
      }),
  )

  it("propagates defects without swallowing them in catchCauseIf", async () => {
    const dieLayer = Layer.succeed(DecisionModel.DecisionModel, {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: () => Effect.die(new Error("fatal defect")),
    })

    const exit = await Effect.runPromiseExit(
      evaluateDpoCandidateRank(rep04aInput).pipe(Effect.provide(dieLayer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
    }
  })
})
