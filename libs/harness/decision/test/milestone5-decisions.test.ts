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
import * as DecisionModel from "effect/ai/DecisionModel"
import { makeCachedDecisionModelLayer, wrapDecisionModelLayer } from "../src/cached-decision-model.js"
import { evaluateDstHazardPrior } from "../src/dst-hazard-decision.js"
import { evaluateEarsClauseSemantics } from "../src/ears-semantics-decision.js"
import {
  makeFailingDecisionModel,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
} from "../src/mock-layer.js"
import {
  evaluateMutantEquivalence,
  MutantAstSummary,
  MutantCodeSnippet,
  MutantDecisionFilePath,
  MutantDecisionId,
  MutantDecisionSpanName,
} from "../src/mutant-equivalence-decision.js"
import { evaluatePlanSearchCandidate } from "../src/plan-search-decision.js"
import { evaluateSynthesizedRuleQuality } from "../src/rule-quality-decision.js"

describe("Milestone 5 System One Decision Evaluators", () => {
  it.effect("evaluates EarsClauseSemantics.evaluate via DecisionModel and deterministic fallbacks", () =>
    Effect.gen(function* () {
      const subsumptionInput = {
        firstClauseId: EarsClauseId.make("SPEC-1.1"),
        secondClauseId: EarsClauseId.make("SPEC-1.2"),
        firstClauseText: EarsGuardText.make("WHILE Open IF ValidCart"),
        secondClauseText: EarsGuardText.make("WHILE Open IF ValidCart and VIP"),
        stateVariants: [EarsVariantTag.make("Open"), EarsVariantTag.make("Closed")],
        guardVariants: [EarsVariantTag.make("ValidCart"), EarsVariantTag.make("EmptyCart")],
      }

      const fromModel = yield* evaluateEarsClauseSemantics(subsumptionInput).pipe(
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

      // Fallback with makeFailingDecisionModelLayer: subsumption detected
      const fromFallback = yield* evaluateEarsClauseSemantics(subsumptionInput).pipe(
        Effect.provide(makeFailingDecisionModelLayer()),
      )
      expect(fromFallback.source._tag).toBe("DeterministicFallback")
      expect(fromFallback.activeStateVariant).toBe("Open")
      expect(fromFallback.guardPairRelation).toBe("first_subsumes_second")

      // Fallback with Layer.succeed(DecisionModel.DecisionModel, ...): unrelated guards -> independent_overlapping (F-6)
      const failingModel = yield* makeFailingDecisionModel("DecisionModelError")
      const failingLayer = Layer.succeed(DecisionModel.DecisionModel, failingModel)

      const unrelatedInput = {
        firstClauseId: EarsClauseId.make("SPEC-1.1"),
        secondClauseId: EarsClauseId.make("SPEC-1.3"),
        firstClauseText: EarsGuardText.make("WHILE Open IF ValidCart"),
        secondClauseText: EarsGuardText.make("WHILE Open IF HasDiscount"),
        stateVariants: [EarsVariantTag.make("Open"), EarsVariantTag.make("Closed")],
        guardVariants: [EarsVariantTag.make("ValidCart"), EarsVariantTag.make("HasDiscount")],
      }
      const unrelatedFallback = yield* evaluateEarsClauseSemantics(unrelatedInput).pipe(
        Effect.provide(failingLayer),
      )
      expect(unrelatedFallback.source._tag).toBe("DeterministicFallback")
      expect(unrelatedFallback.guardPairRelation).toBe("independent_overlapping")

      // Fallback: negated guards -> mutually_exclusive (F-6)
      const negatedInput = {
        firstClauseId: EarsClauseId.make("SPEC-1.1"),
        secondClauseId: EarsClauseId.make("SPEC-1.4"),
        firstClauseText: EarsGuardText.make("WHILE Open IF ValidCart"),
        secondClauseText: EarsGuardText.make("WHILE Open IF NOT ValidCart"),
        stateVariants: [EarsVariantTag.make("Open"), EarsVariantTag.make("Closed")],
        guardVariants: [EarsVariantTag.make("ValidCart")],
      }
      const negatedFallback = yield* evaluateEarsClauseSemantics(negatedInput).pipe(
        Effect.provide(failingLayer),
      )
      expect(negatedFallback.source._tag).toBe("DeterministicFallback")
      expect(negatedFallback.guardPairRelation).toBe("mutually_exclusive")
    }),
  )

  it.effect("evaluates DstHazardPrior.evaluate via DecisionModel and deterministic fallbacks", () =>
    Effect.gen(function* () {
      const sagaInput = {
        serviceTag: DstServiceTag.make("OrderSaga"),
        methodName: DstMethodName.make("compensateOrder"),
        signatureSummary: "Effect<void, OrderError, OrderRepo>",
        earsClauseContext: "IF payment fails THEN compensate reservation",
      }

      const fromModel = yield* evaluateDstHazardPrior(sagaInput).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            dstHazardRiskLabel: DstHazardRiskLevel.make("distributed_saga_step"),
          }),
        ),
      )
      expect(fromModel.source._tag).toBe("DecisionModel")
      expect(fromModel.riskLevel).toBe("distributed_saga_step")
      expect(fromModel.hazardProbMillis).toBe(900)

      const fromFallback = yield* evaluateDstHazardPrior(sagaInput).pipe(
        Effect.provide(makeFailingDecisionModelLayer()),
      )
      expect(fromFallback.source._tag).toBe("DeterministicFallback")
      expect(fromFallback.riskLevel).toBe("distributed_saga_step")
      expect(fromFallback.hazardProbMillis).toBe(900)

      const failingModel = yield* makeFailingDecisionModel("DecisionModelError")
      const failingLayer = Layer.succeed(DecisionModel.DecisionModel, failingModel)

      // Fallback for pure lookup prefix: findOrderById -> pure_lookup (100 ms)
      const lookupInput = {
        serviceTag: DstServiceTag.make("OrderCatalog"),
        methodName: DstMethodName.make("findOrderById"),
        signatureSummary: "Effect<Option<Order>, OrderError, OrderRepo>",
        earsClauseContext: "WHEN user requests order details",
      }
      const lookupFallback = yield* evaluateDstHazardPrior(lookupInput).pipe(
        Effect.provide(failingLayer),
      )
      expect(lookupFallback.source._tag).toBe("DeterministicFallback")
      expect(lookupFallback.riskLevel).toBe("pure_lookup")
      expect(lookupFallback.hazardProbMillis).toBe(100)

      // Fallback for another lookup prefix: getUser -> pure_lookup (100 ms)
      const getUserInput = {
        serviceTag: DstServiceTag.make("UserDirectory"),
        methodName: DstMethodName.make("getUser"),
        signatureSummary: "Effect<Option<User>, UserError, UserRepo>",
        earsClauseContext: "WHEN user profile loaded",
      }
      const getUserFallback = yield* evaluateDstHazardPrior(getUserInput).pipe(
        Effect.provide(failingLayer),
      )
      expect(getUserFallback.source._tag).toBe("DeterministicFallback")
      expect(getUserFallback.riskLevel).toBe("pure_lookup")
      expect(getUserFallback.hazardProbMillis).toBe(100)

      // Fallback for unknown method name: doCustomAction -> stateful_mutation (650 ms) (F-10)
      const unknownMethodInput = {
        serviceTag: DstServiceTag.make("CustomService"),
        methodName: DstMethodName.make("doCustomAction"),
        signatureSummary: "Effect<void, CustomError, CustomContext>",
        earsClauseContext: "WHEN custom action triggered",
      }
      const unknownFallback = yield* evaluateDstHazardPrior(unknownMethodInput).pipe(
        Effect.provide(failingLayer),
      )
      expect(unknownFallback.source._tag).toBe("DeterministicFallback")
      expect(unknownFallback.riskLevel).toBe("stateful_mutation")
      expect(unknownFallback.hazardProbMillis).toBe(650)
    }),
  )

  it.effect(
    "evaluates MutantEquivalence.evaluate with CachedDecisionModel memoization and conservative fallback",
    () =>
      Effect.gen(function* () {
        const input = {
          mutantId: MutantDecisionId.make("mut-1"),
          filePath: MutantDecisionFilePath.make("libs/sample/domain/src/cart.ts"),
          spanName: MutantDecisionSpanName.make("Cart.decide"),
          originalSnippet: MutantCodeSnippet.make("qty >= 1"),
          mutatedSnippet: MutantCodeSnippet.make("qty > 0"),
          enclosingFunctionAstSummary: MutantAstSummary.make("Nat branded integer check"),
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

        // Fallback via makeFailingDecisionModelLayer
        const fallbackRes = yield* evaluateMutantEquivalence(input).pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )
        expect(fallbackRes.source._tag).toBe("DeterministicFallback")
        expect(fallbackRes.equivalenceProbMillis).toBe(0)
        expect(fallbackRes.isEquivalent).toBe(false)

        // Fallback via Layer.succeed(DecisionModel.DecisionModel, failingModel)
        const failingModel = yield* makeFailingDecisionModel("DecisionModelError")
        const failingLayer = Layer.succeed(DecisionModel.DecisionModel, failingModel)
        const failingSucceedRes = yield* evaluateMutantEquivalence(input).pipe(
          Effect.provide(failingLayer),
        )
        expect(failingSucceedRes.source._tag).toBe("DeterministicFallback")
        expect(failingSucceedRes.equivalenceProbMillis).toBe(0)
        expect(failingSucceedRes.isEquivalent).toBe(false)
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

  it.effect("evaluates MutantEquivalence threshold boundary: 849 is false, 850 is true", () =>
    Effect.gen(function* () {
      const input = {
        mutantId: MutantDecisionId.make("mut-boundary"),
        filePath: MutantDecisionFilePath.make("libs/sample/domain/src/cart.ts"),
        spanName: MutantDecisionSpanName.make("Cart.decide"),
        originalSnippet: MutantCodeSnippet.make("qty >= 1"),
        mutatedSnippet: MutantCodeSnippet.make("qty > 0"),
        enclosingFunctionAstSummary: MutantAstSummary.make("Nat boundary test"),
      }

      const layer849 = makeMockDecisionModelLayer({ mutantEquivalentProb: 0.849 })
      const res849 = yield* evaluateMutantEquivalence(input).pipe(Effect.provide(layer849))
      expect(res849.equivalenceProbMillis).toBe(849)
      expect(res849.isEquivalent).toBe(false)

      const layer850 = makeMockDecisionModelLayer({ mutantEquivalentProb: 0.85 })
      const res850 = yield* evaluateMutantEquivalence(input).pipe(Effect.provide(layer850))
      expect(res850.equivalenceProbMillis).toBe(850)
      expect(res850.isEquivalent).toBe(true)
    }),
  )

  it.effect("hits CachedDecisionModel on repeated evaluations with wrapDecisionModelLayer", () =>
    Effect.gen(function* () {
      let callCount = 0
      const countingMockLayer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: (_options) =>
            Effect.sync(() => {
              callCount++
              return {
                answers: {
                  isEquivalent: {
                    _tag: "Probability" as const,
                    probability: 0.9,
                  },
                },
                usage: {
                  inputTokens: 10,
                  outputTokens: 2,
                },
              }
            }),
        }),
      )
      const wrappedLayer = wrapDecisionModelLayer(countingMockLayer)

      const input = {
        mutantId: MutantDecisionId.make("mut-cache-test"),
        filePath: MutantDecisionFilePath.make("libs/sample/domain/src/cart.ts"),
        spanName: MutantDecisionSpanName.make("Cart.decide"),
        originalSnippet: MutantCodeSnippet.make("qty >= 1"),
        mutatedSnippet: MutantCodeSnippet.make("qty > 0"),
        enclosingFunctionAstSummary: MutantAstSummary.make("Cache hit test"),
      }

      yield* Effect.gen(function* () {
        const first = yield* evaluateMutantEquivalence(input)
        expect(first.isEquivalent).toBe(true)
        expect(callCount).toBe(1)

        const second = yield* evaluateMutantEquivalence(input)
        expect(second.isEquivalent).toBe(true)
        expect(callCount).toBe(1)
      }).pipe(Effect.provide(wrappedLayer))
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

