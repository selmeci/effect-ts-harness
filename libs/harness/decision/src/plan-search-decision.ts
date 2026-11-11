import {
  PlanSearchCandidateId,
  PlanSearchCount,
  PlanSearchScoreMillis,
  PlanSearchSummary,
} from "@harness/gates"
import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match, P } from "ts-pattern"
import { type DeterministicFallbackReason, PriorSource } from "./hole-prior-decision.js"
import { assertDecisionLimits } from "./idiom-router.js"

export const PLAN_SEARCH_COHESION_LEVELS = [
  "fragmented",
  "adequate",
  "modular",
  "minimal_complete",
] as const
export type PlanSearchCohesionLevel = (typeof PLAN_SEARCH_COHESION_LEVELS)[number]

export const PLAN_SEARCH_COHESION_MILLIS: Readonly<
  Record<PlanSearchCohesionLevel, PlanSearchScoreMillis>
> = {
  fragmented: PlanSearchScoreMillis.make(200),
  adequate: PlanSearchScoreMillis.make(550),
  modular: PlanSearchScoreMillis.make(800),
  minimal_complete: PlanSearchScoreMillis.make(950),
}

export const PlanSearchScorerV1 = Decision.make({
  input: Schema.Struct({
    candidateId: Schema.String,
    candidateSkeletonSummary: Schema.String,
    earsRequirementsSummary: Schema.String,
    violationCount: Schema.Int,
    cyclomaticComplexity: Schema.Int,
  }),
  decisions: {
    decompositionCohesion: Decision.rate({
      instructions:
        "Rate the modularity, Effect-TS idiomatic alignment, and structural simplicity of this candidate plan skeleton.",
      criteria: PLAN_SEARCH_COHESION_LEVELS,
    }),
  },
})

assertDecisionLimits(PlanSearchScorerV1)

export const PlanSearchScoreInput = Schema.Struct({
  candidateId: PlanSearchCandidateId,
  candidateSkeletonSummary: PlanSearchSummary,
  earsRequirementsSummary: PlanSearchSummary,
  violationCount: PlanSearchCount,
  cyclomaticComplexity: PlanSearchCount,
})
export type PlanSearchScoreInput = typeof PlanSearchScoreInput.Type

export const PlanSearchScoreResult = Schema.Struct({
  candidateId: PlanSearchCandidateId,
  cohesionLabel: Schema.Literals(PLAN_SEARCH_COHESION_LEVELS),
  cohesionPriorMillis: PlanSearchScoreMillis,
  source: PriorSource,
})
export type PlanSearchScoreResult = typeof PlanSearchScoreResult.Type

const parsePlanSearchCohesion = (raw: unknown): Option.Option<PlanSearchCohesionLevel> =>
  match(raw)
    .with("fragmented", () => Option.some("fragmented" as const))
    .with("adequate", () => Option.some("adequate" as const))
    .with("modular", () => Option.some("modular" as const))
    .with("minimal_complete", () => Option.some("minimal_complete" as const))
    .otherwise(() => Option.none())

const computeDeterministicPlanSearchFallback = (
  input: PlanSearchScoreInput,
  reason: DeterministicFallbackReason = "timeout-or-unavailable",
): PlanSearchScoreResult => {
  const cohesionLabel: PlanSearchCohesionLevel = match(input)
    .with(
      P.when((i) => i.violationCount > 0),
      () => "fragmented" as const,
    )
    .with(
      P.when((i) => i.cyclomaticComplexity <= 4),
      () => "minimal_complete" as const,
    )
    .with(
      P.when((i) => i.cyclomaticComplexity <= 8),
      () => "modular" as const,
    )
    .otherwise(() => "adequate" as const)

  return {
    candidateId: input.candidateId,
    cohesionLabel,
    cohesionPriorMillis: PLAN_SEARCH_COHESION_MILLIS[cohesionLabel],
    source: { _tag: "DeterministicFallback", reason },
  }
}

export const evaluatePlanSearchCandidate = Effect.fn("PlanSearchScorer.evaluate")(function* (
  input: PlanSearchScoreInput,
): Effect.fn.Return<PlanSearchScoreResult, never, DecisionModel.DecisionModel> {
  const outcome = yield* DecisionModel.decide(PlanSearchScorerV1, { input }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catch((error) =>
      Effect.annotateCurrentSpan({
        "decision.fallback_error": String(error),
      }).pipe(Effect.as(Option.none())),
    ),
  )

  return yield* match(outcome)
    .with({ _tag: "None" }, () =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ "decision.usedFallback": true })
        return computeDeterministicPlanSearchFallback(input, "timeout-or-unavailable")
      }),
    )
    .with({ _tag: "Some" }, ({ value }) =>
      Effect.gen(function* () {
        const parsedCohesion = parsePlanSearchCohesion(value.answers.decompositionCohesion?.label)
        return yield* match(parsedCohesion)
          .with({ _tag: "Some" }, ({ value: cohesionLabel }) =>
            Effect.gen(function* () {
              const cohesionPriorMillis = PLAN_SEARCH_COHESION_MILLIS[cohesionLabel]
              yield* Effect.annotateCurrentSpan({
                "decision.definition": "PlanSearchScorerV1",
                "decision.candidateId": input.candidateId,
                "decision.cohesionLabel": cohesionLabel,
                "decision.cohesionPriorMillis": cohesionPriorMillis,
                "decision.usedFallback": false,
              })
              return {
                candidateId: input.candidateId,
                cohesionLabel,
                cohesionPriorMillis,
                source: { _tag: "DecisionModel" },
              } satisfies PlanSearchScoreResult
            }),
          )
          .with({ _tag: "None" }, () =>
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({ "decision.usedFallback": true })
              return computeDeterministicPlanSearchFallback(input, "invalid-output")
            }),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})
