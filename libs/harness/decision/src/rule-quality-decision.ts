import { RuleQualityScoreMillis, SynthesizedRuleId } from "@harness/gates"
import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { type DeterministicFallbackReason, PriorSource } from "./hole-prior-decision.js"
import { assertDecisionLimits } from "./idiom-router.js"

export const RULE_GENERALITY_LEVELS = [
  "overfitted_to_single_file",
  "domain_specific",
  "reusable_idiom",
  "universal_effect_law",
] as const
export type RuleGeneralityLevel = (typeof RULE_GENERALITY_LEVELS)[number]

export const RULE_GENERALITY_SCORE_MILLIS: Readonly<
  Record<RuleGeneralityLevel, RuleQualityScoreMillis>
> = {
  overfitted_to_single_file: RuleQualityScoreMillis.make(150),
  domain_specific: RuleQualityScoreMillis.make(500),
  reusable_idiom: RuleQualityScoreMillis.make(800),
  universal_effect_law: RuleQualityScoreMillis.make(950),
}

export const SynthesizedRuleQualityV1 = Decision.make({
  input: Schema.Struct({
    ruleId: Schema.String,
    lhsSummary: Schema.String,
    rhsSummary: Schema.String,
    nacSummary: Schema.String,
    frictionContext: Schema.String,
  }),
  decisions: {
    ruleGenerality: Decision.rate({
      instructions:
        "How general, reusable, and architecturally sound is this synthesized DPO rewrite rule across Effect-TS packages?",
      criteria: RULE_GENERALITY_LEVELS,
    }),
    isNonTautological: Decision.probability({
      instructions:
        "Does this DPO rule enforce a genuine Effect-TS invariant rather than an overfitted or tautological AST artifact?",
    }),
  },
})

assertDecisionLimits(SynthesizedRuleQualityV1)

export const SynthesizedRuleQualityInput = Schema.Struct({
  ruleId: SynthesizedRuleId,
  lhsSummary: Schema.String,
  rhsSummary: Schema.String,
  nacSummary: Schema.String,
  frictionContext: Schema.String,
})
export type SynthesizedRuleQualityInput = typeof SynthesizedRuleQualityInput.Type

export const SynthesizedRuleQualityResult = Schema.Struct({
  ruleId: SynthesizedRuleId,
  generalityLabel: Schema.Literals(RULE_GENERALITY_LEVELS),
  nonTautologicalProbMillis: RuleQualityScoreMillis,
  qualityScoreMillis: RuleQualityScoreMillis,
  source: PriorSource,
})
export type SynthesizedRuleQualityResult = typeof SynthesizedRuleQualityResult.Type

const parseRuleGenerality = (raw: unknown): Option.Option<RuleGeneralityLevel> =>
  match(raw)
    .with("overfitted_to_single_file", () => Option.some("overfitted_to_single_file" as const))
    .with("domain_specific", () => Option.some("domain_specific" as const))
    .with("reusable_idiom", () => Option.some("reusable_idiom" as const))
    .with("universal_effect_law", () => Option.some("universal_effect_law" as const))
    .otherwise(() => Option.none())

const computeCompositeRuleScore = (
  generalityLabel: RuleGeneralityLevel,
  nonTautologicalProbMillis: number,
): RuleQualityScoreMillis => {
  const baseGenerality = RULE_GENERALITY_SCORE_MILLIS[generalityLabel]
  const weighted = Math.round(baseGenerality * 0.6 + nonTautologicalProbMillis * 0.4)
  return RuleQualityScoreMillis.make(Math.min(1000, Math.max(0, weighted)))
}

const computeDeterministicRuleQualityFallback = (
  input: SynthesizedRuleQualityInput,
  reason: DeterministicFallbackReason = "timeout-or-unavailable",
): SynthesizedRuleQualityResult => {
  const hasScopeVariable = input.lhsSummary.includes("?Scope")
  const hasDistinctRhs =
    input.rhsSummary.trim().length > 0 && input.rhsSummary.trim() !== input.lhsSummary.trim()
  const generalityLabel: RuleGeneralityLevel =
    hasScopeVariable && hasDistinctRhs ? "reusable_idiom" : "overfitted_to_single_file"
  const nonTautologicalProbMillis = RuleQualityScoreMillis.make(hasDistinctRhs ? 800 : 100)
  const qualityScoreMillis = computeCompositeRuleScore(generalityLabel, nonTautologicalProbMillis)
  return {
    ruleId: input.ruleId,
    generalityLabel,
    nonTautologicalProbMillis,
    qualityScoreMillis,
    source: { _tag: "DeterministicFallback", reason },
  }
}

export const evaluateSynthesizedRuleQuality = Effect.fn("SynthesizedRuleQuality.evaluate")(
  function* (
    input: SynthesizedRuleQualityInput,
  ): Effect.fn.Return<SynthesizedRuleQualityResult, never, DecisionModel.DecisionModel> {
    const outcome = yield* DecisionModel.decide(SynthesizedRuleQualityV1, { input }).pipe(
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
          return computeDeterministicRuleQualityFallback(input, "timeout-or-unavailable")
        }),
      )
      .with({ _tag: "Some" }, ({ value }) =>
        Effect.gen(function* () {
          const parsedGen = parseRuleGenerality(value.answers.ruleGenerality?.label)
          const rawProb = value.answers.isNonTautological?.probability
          const probValid = typeof rawProb === "number" && !Number.isNaN(rawProb)
          return yield* match([parsedGen, probValid] as const)
            .with([{ _tag: "Some" }, true], ([{ value: generalityLabel }]) =>
              Effect.gen(function* () {
                const nonTautMillis = Math.min(1000, Math.max(0, Math.round((rawProb ?? 0) * 1000)))
                const nonTautologicalProbMillis = RuleQualityScoreMillis.make(nonTautMillis)
                const qualityScoreMillis = computeCompositeRuleScore(
                  generalityLabel,
                  nonTautologicalProbMillis,
                )
                yield* Effect.annotateCurrentSpan({
                  "decision.definition": "SynthesizedRuleQualityV1",
                  "decision.ruleId": input.ruleId,
                  "decision.generalityLabel": generalityLabel,
                  "decision.nonTautologicalProbMillis": nonTautologicalProbMillis,
                  "decision.qualityScoreMillis": qualityScoreMillis,
                  "decision.usedFallback": false,
                })
                return {
                  ruleId: input.ruleId,
                  generalityLabel,
                  nonTautologicalProbMillis,
                  qualityScoreMillis,
                  source: { _tag: "DecisionModel" },
                } satisfies SynthesizedRuleQualityResult
              }),
            )
            .otherwise(() =>
              Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({ "decision.usedFallback": true })
                return computeDeterministicRuleQualityFallback(input, "invalid-output")
              }),
            )
        }),
      )
      .exhaustive()
  },
)
