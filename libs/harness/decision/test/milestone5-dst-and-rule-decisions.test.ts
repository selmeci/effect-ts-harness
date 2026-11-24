import { describe, expect, it } from "@effect/vitest"
import {
  PlanSearchCandidateId,
  PlanSearchCount,
  PlanSearchSummary,
  SynthesizedRuleId,
} from "@harness/gates"
import { Effect, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  makeFailingDecisionModel,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
} from "../src/mock-layer.js"
import { evaluatePlanSearchCandidate } from "../src/plan-search-decision.js"
import { evaluateSynthesizedRuleQuality } from "../src/rule-quality-decision.js"

describe("Milestone 5 RuleQuality & PlanSearch Decisions", () => {
  it.effect(
    "evaluates SynthesizedRuleQuality.evaluate via DecisionModel and deterministic fallback",
    () =>
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
        expect(fromModel.qualityScoreMillis).toBeGreaterThan(899)

        // Fallback via makeFailingDecisionModelLayer
        const fromFallback = yield* evaluateSynthesizedRuleQuality(input).pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )
        expect(fromFallback.source._tag).toBe("DeterministicFallback")
        expect(fromFallback.generalityLabel).toBe("reusable_idiom")

        // Fallback via Layer.succeed(DecisionModel.DecisionModel, failingModel)
        const failingModel = yield* makeFailingDecisionModel("DecisionModelError")
        const failingLayer = Layer.succeed(DecisionModel.DecisionModel, failingModel)
        const fromFailingSucceed = yield* evaluateSynthesizedRuleQuality(input).pipe(
          Effect.provide(failingLayer),
        )
        expect(fromFailingSucceed.source._tag).toBe("DeterministicFallback")
        expect(fromFailingSucceed.generalityLabel).toBe("reusable_idiom")
      }),
  )

  it.effect(
    "evaluates PlanSearchScorer.evaluate via DecisionModel and deterministic fallback",
    () =>
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

        // Fallback via makeFailingDecisionModelLayer
        const fromFallback = yield* evaluatePlanSearchCandidate(input).pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )
        expect(fromFallback.source._tag).toBe("DeterministicFallback")
        expect(fromFallback.cohesionLabel).toBe("minimal_complete")
        expect(fromFallback.cohesionPriorMillis).toBe(950)

        // Fallback via Layer.succeed(DecisionModel.DecisionModel, failingModel)
        const failingModel = yield* makeFailingDecisionModel("DecisionModelError")
        const failingLayer = Layer.succeed(DecisionModel.DecisionModel, failingModel)
        const fromFailingSucceed = yield* evaluatePlanSearchCandidate(input).pipe(
          Effect.provide(failingLayer),
        )
        expect(fromFailingSucceed.source._tag).toBe("DeterministicFallback")
        expect(fromFailingSucceed.cohesionLabel).toBe("minimal_complete")
        expect(fromFailingSucceed.cohesionPriorMillis).toBe(950)
      }),
  )

  it.effect("evaluates all deterministic fallback branches of evaluateSynthesizedRuleQuality", () =>
    Effect.gen(function* () {
      const failingLayer = makeFailingDecisionModelLayer()

      // Branch 1: hasScopeVariable && hasDistinctRhs -> reusable_idiom
      const branch1 = yield* evaluateSynthesizedRuleQuality({
        ruleId: SynthesizedRuleId.make("SYNTH-B1"),
        lhsSummary: "?Scope.checkout",
        rhsSummary: "?Scope.checkout -> CartError",
        nacSummary: "?Scope.CartError",
        frictionContext: "friction",
      }).pipe(Effect.provide(failingLayer))
      expect(branch1.source._tag).toBe("DeterministicFallback")
      expect(branch1.generalityLabel).toBe("reusable_idiom")
      expect(branch1.nonTautologicalProbMillis).toBe(800)
      expect(branch1.qualityScoreMillis).toBe(800)

      // Branch 2: !hasScopeVariable && hasDistinctRhs -> overfitted_to_single_file with distinct rhs
      const branch2 = yield* evaluateSynthesizedRuleQuality({
        ruleId: SynthesizedRuleId.make("SYNTH-B2"),
        lhsSummary: "cart.checkout",
        rhsSummary: "cart.checkout -> CartError",
        nacSummary: "",
        frictionContext: "friction",
      }).pipe(Effect.provide(failingLayer))
      expect(branch2.source._tag).toBe("DeterministicFallback")
      expect(branch2.generalityLabel).toBe("overfitted_to_single_file")
      expect(branch2.nonTautologicalProbMillis).toBe(800)
      expect(branch2.qualityScoreMillis).toBe(410)

      // Branch 3: !hasScopeVariable && !hasDistinctRhs -> overfitted_to_single_file with non-distinct rhs
      const branch3 = yield* evaluateSynthesizedRuleQuality({
        ruleId: SynthesizedRuleId.make("SYNTH-B3"),
        lhsSummary: "cart.checkout",
        rhsSummary: "cart.checkout",
        nacSummary: "",
        frictionContext: "friction",
      }).pipe(Effect.provide(failingLayer))
      expect(branch3.source._tag).toBe("DeterministicFallback")
      expect(branch3.generalityLabel).toBe("overfitted_to_single_file")
      expect(branch3.nonTautologicalProbMillis).toBe(100)
      expect(branch3.qualityScoreMillis).toBe(130)
    }),
  )

  it.effect("evaluates all deterministic fallback branches of evaluatePlanSearchCandidate", () =>
    Effect.gen(function* () {
      const failingLayer = makeFailingDecisionModelLayer()

      // Branch 1: violationCount > 0 -> fragmented (200)
      const branch1 = yield* evaluatePlanSearchCandidate({
        candidateId: PlanSearchCandidateId.make("cand-f1"),
        candidateSkeletonSummary: PlanSearchSummary.make("skeleton"),
        earsRequirementsSummary: PlanSearchSummary.make("reqs"),
        violationCount: PlanSearchCount.make(1),
        cyclomaticComplexity: PlanSearchCount.make(2),
      }).pipe(Effect.provide(failingLayer))
      expect(branch1.source._tag).toBe("DeterministicFallback")
      expect(branch1.cohesionLabel).toBe("fragmented")
      expect(branch1.cohesionPriorMillis).toBe(200)

      // Branch 2: cyclomaticComplexity <= 4 -> minimal_complete (950)
      const branch2 = yield* evaluatePlanSearchCandidate({
        candidateId: PlanSearchCandidateId.make("cand-f2"),
        candidateSkeletonSummary: PlanSearchSummary.make("skeleton"),
        earsRequirementsSummary: PlanSearchSummary.make("reqs"),
        violationCount: PlanSearchCount.make(0),
        cyclomaticComplexity: PlanSearchCount.make(3),
      }).pipe(Effect.provide(failingLayer))
      expect(branch2.source._tag).toBe("DeterministicFallback")
      expect(branch2.cohesionLabel).toBe("minimal_complete")
      expect(branch2.cohesionPriorMillis).toBe(950)

      // Branch 3: cyclomaticComplexity <= 8 -> modular (800)
      const branch3 = yield* evaluatePlanSearchCandidate({
        candidateId: PlanSearchCandidateId.make("cand-f3"),
        candidateSkeletonSummary: PlanSearchSummary.make("skeleton"),
        earsRequirementsSummary: PlanSearchSummary.make("reqs"),
        violationCount: PlanSearchCount.make(0),
        cyclomaticComplexity: PlanSearchCount.make(6),
      }).pipe(Effect.provide(failingLayer))
      expect(branch3.source._tag).toBe("DeterministicFallback")
      expect(branch3.cohesionLabel).toBe("modular")
      expect(branch3.cohesionPriorMillis).toBe(800)

      // Branch 4: cyclomaticComplexity > 8 -> adequate (550)
      const branch4 = yield* evaluatePlanSearchCandidate({
        candidateId: PlanSearchCandidateId.make("cand-f4"),
        candidateSkeletonSummary: PlanSearchSummary.make("skeleton"),
        earsRequirementsSummary: PlanSearchSummary.make("reqs"),
        violationCount: PlanSearchCount.make(0),
        cyclomaticComplexity: PlanSearchCount.make(10),
      }).pipe(Effect.provide(failingLayer))
      expect(branch4.source._tag).toBe("DeterministicFallback")
      expect(branch4.cohesionLabel).toBe("adequate")
      expect(branch4.cohesionPriorMillis).toBe(550)
    }),
  )
})
