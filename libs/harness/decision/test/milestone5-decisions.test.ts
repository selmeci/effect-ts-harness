import { describe, expect, it } from "@effect/vitest"
import {
  DstHazardRiskLevel,
  DstMethodName,
  DstServiceTag,
  EarsClauseId,
  EarsGuardPairRelation,
  EarsGuardText,
  EarsVariantTag,
  PlanSearchCandidateId,
  PlanSearchCount,
  PlanSearchSummary,
  SynthesizedRuleId,
} from "@harness/gates"
import { Effect, Layer } from "effect"
import { makeCachedDecisionModelLayer } from "../src/cached-decision-model.js"
import { evaluateDstHazardPrior } from "../src/dst-hazard-decision.js"
import { evaluateEarsClauseSemantics } from "../src/ears-semantics-decision.js"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "../src/mock-layer.js"
import { evaluateMutantEquivalence } from "../src/mutant-equivalence-decision.js"
import { evaluatePlanSearchCandidate } from "../src/plan-search-decision.js"
import { evaluateSynthesizedRuleQuality } from "../src/rule-quality-decision.js"

describe("Milestone 5 System One Decision Evaluators", () => {
  it.effect("evaluates EarsClauseSemantics.evaluate via DecisionModel and deterministic fallback", () =>
    Effect.gen(function* () {
      const input = {
        firstClauseId: EarsClauseId.make("SPEC-1.1"),
        secondClauseId: EarsClauseId.make("SPEC-1.2"),
        firstClauseText: EarsGuardText.make("WHILE Open IF ValidCart"),
        secondClauseText: EarsGuardText.make("WHILE Open IF ValidCart and VIP"),
        stateVariants: [EarsVariantTag.make("Open"), EarsVariantTag.make("Closed")],
        guardVariants: [EarsVariantTag.make("ValidCart"), EarsVariantTag.make("EmptyCart")],
      }

      const fromModel = yield* evaluateEarsClauseSemantics(input).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            earsStateVariantLabel: "Open",
            earsGuardVariantLabel: "ValidCart",
            earsGuardRelationLabel: EarsGuardPairRelation.make("first_subsumes_second"),
          }),
        ),
      )
      expect(fromModel.source._tag).toBe("DecisionModel")
      expect(fromModel.activeStateVariant).toBe("Open")
      expect(fromModel.guardPairRelation).toBe("first_subsumes_second")

      const fromFallback = yield* evaluateEarsClauseSemantics(input).pipe(
        Effect.provide(makeFailingDecisionModelLayer()),
      )
      expect(fromFallback.source._tag).toBe("DeterministicFallback")
      expect(fromFallback.activeStateVariant).toBe("Open")
      expect(fromFallback.guardPairRelation).toBe("first_subsumes_second")
    }),
  )

  it.effect("evaluates DstHazardPrior.evaluate via DecisionModel and deterministic fallback", () =>
    Effect.gen(function* () {
      const input = {
        serviceTag: DstServiceTag.make("OrderSaga"),
        methodName: DstMethodName.make("compensateOrder"),
        signatureSummary: "Effect<void, OrderError, OrderRepo>",
        earsClauseContext: "IF payment fails THEN compensate reservation",
      }

      const fromModel = yield* evaluateDstHazardPrior(input).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            dstHazardRiskLabel: DstHazardRiskLevel.make("distributed_saga_step"),
          }),
        ),
      )
      expect(fromModel.source._tag).toBe("DecisionModel")
      expect(fromModel.riskLevel).toBe("distributed_saga_step")
      expect(fromModel.hazardProbMillis).toBe(900)

      const fromFallback = yield* evaluateDstHazardPrior(input).pipe(
        Effect.provide(makeFailingDecisionModelLayer()),
      )
      expect(fromFallback.source._tag).toBe("DeterministicFallback")
      expect(fromFallback.riskLevel).toBe("distributed_saga_step")
      expect(fromFallback.hazardProbMillis).toBe(900)
    }),
  )

  it.effect(
    "evaluates MutantEquivalence.evaluate with CachedDecisionModel memoization and conservative fallback",
    () =>
      Effect.gen(function* () {
        const input = {
          mutantId: "mut-1",
          filePath: "libs/sample/domain/src/cart.ts",
          spanName: "Cart.decide",
          originalSnippet: "qty >= 1",
          mutatedSnippet: "qty > 0",
          enclosingFunctionAstSummary: "Nat branded integer check",
        }

        const combinedLayer = makeCachedDecisionModelLayer().pipe(
          Layer.provideMerge(
            makeMockDecisionModelLayer({
              mutantEquivalentProb: 0.92,
            }),
          ),
        )

        const res = yield* evaluateMutantEquivalence(input).pipe(Effect.provide(combinedLayer))
        expect(res.source._tag).toBe("DecisionModel")
        expect(res.equivalenceProbMillis).toBe(920)
        expect(res.isEquivalent).toBe(true)

        const fallbackRes = yield* evaluateMutantEquivalence(input).pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )
        expect(fallbackRes.source._tag).toBe("DeterministicFallback")
        expect(fallbackRes.equivalenceProbMillis).toBe(0)
        expect(fallbackRes.isEquivalent).toBe(false)
      }),
  )

  it.effect("evaluates SynthesizedRuleQuality.evaluate via DecisionModel and deterministic fallback", () =>
    Effect.gen(function* () {
      const input = {
        ruleId: SynthesizedRuleId.make("SYNTH-001"),
        lhsSummary: "?Scope.checkout",
        rhsSummary: "?Scope.checkout -> CartError",
        nacSummary: "?Scope.CartError",
        frictionContext: "Repeated verify failure on missing error tag",
      }

      const fromModel = yield* evaluateSynthesizedRuleQuality(input).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            ruleGeneralityLabel: "universal_effect_law",
            ruleNonTautologicalProb: 0.95,
          }),
        ),
      )
      expect(fromModel.source._tag).toBe("DecisionModel")
      expect(fromModel.generalityLabel).toBe("universal_effect_law")
      expect(fromModel.qualityScoreMillis).toBeGreaterThanOrEqual(900)

      const fromFallback = yield* evaluateSynthesizedRuleQuality(input).pipe(
        Effect.provide(makeFailingDecisionModelLayer()),
      )
      expect(fromFallback.source._tag).toBe("DeterministicFallback")
      expect(fromFallback.generalityLabel).toBe("reusable_idiom")
    }),
  )

  it.effect("evaluates PlanSearchScorer.evaluate via DecisionModel and deterministic fallback", () =>
    Effect.gen(function* () {
      const input = {
        candidateId: PlanSearchCandidateId.make("cand-1"),
        candidateSkeletonSummary: PlanSearchSummary.make("Pure decide + service port"),
        earsRequirementsSummary: PlanSearchSummary.make("WHEN Checkout THEN OrderPlaced"),
        violationCount: PlanSearchCount.make(0),
        cyclomaticComplexity: PlanSearchCount.make(3),
      }

      const fromModel = yield* evaluatePlanSearchCandidate(input).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            planSearchCohesionLabel: "minimal_complete",
          }),
        ),
      )
      expect(fromModel.source._tag).toBe("DecisionModel")
      expect(fromModel.cohesionLabel).toBe("minimal_complete")
      expect(fromModel.cohesionPriorMillis).toBe(950)

      const fromFallback = yield* evaluatePlanSearchCandidate(input).pipe(
        Effect.provide(makeFailingDecisionModelLayer()),
      )
      expect(fromFallback.source._tag).toBe("DeterministicFallback")
      expect(fromFallback.cohesionLabel).toBe("minimal_complete")
      expect(fromFallback.cohesionPriorMillis).toBe(950)
    }),
  )
})
