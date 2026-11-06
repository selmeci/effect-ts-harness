import { Cause, Effect, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { assertDecisionLimits } from "./idiom-router.js"

export const ConfidenceMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  Schema.brand("ConfidenceMillis"),
)
export type ConfidenceMillis = typeof ConfidenceMillis.Type

export const NodeKey = Schema.NonEmptyString.pipe(Schema.brand("NodeKey"))
export type NodeKey = typeof NodeKey.Type

export const RoleName = Schema.NonEmptyString.pipe(Schema.brand("RoleName"))
export type RoleName = typeof RoleName.Type

export const CandidateSymbolKey = NodeKey
export type CandidateSymbolKey = NodeKey

export const ProposedRoleName = RoleName
export type ProposedRoleName = RoleName

export const DecisionModelSource = Schema.TaggedStruct("DecisionModel", {})
export type DecisionModelSource = typeof DecisionModelSource.Type

export const DeterministicFallbackSource = Schema.TaggedStruct("DeterministicFallback", {
  reason: Schema.optional(
    Schema.Literals(["timeout-or-unavailable", "model-error", "timeout", "invalid-output"]),
  ),
})
export type DeterministicFallbackSource = typeof DeterministicFallbackSource.Type

export const PriorSource = Schema.Union([DecisionModelSource, DeterministicFallbackSource])
export type PriorSource = typeof PriorSource.Type

export const HOLE_RELEVANCE_LEVELS = [
  "irrelevant",
  "tangential",
  "helpful",
  "essential",
] as const
export type HoleRelevanceLevel = (typeof HOLE_RELEVANCE_LEVELS)[number]

export const RELEVANCE_WEIGHT_MILLIS: Readonly<Record<HoleRelevanceLevel, ConfidenceMillis>> = {
  irrelevant: ConfidenceMillis.make(0),
  tangential: ConfidenceMillis.make(333),
  helpful: ConfidenceMillis.make(667),
  essential: ConfidenceMillis.make(1000),
}

/**
 * System One calibrated sensor for Flix lattice edge-completion priors and
 * Personalized PageRank teleportation weights around `stub<A, E, R>()` holes (`RFC-0002 §5.2`).
 */
export const HoleRelevanceAndEdgePriorV1 = Decision.make({
  input: Schema.Struct({
    holeSpanName: Schema.String,
    holeSignatureSummary: Schema.String,
    candidateSymbolKey: Schema.String,
    candidateSignatureSummary: Schema.String,
    proposedRole: Schema.String,
    earsClauseContext: Schema.String,
  }),
  decisions: {
    edgeConfidence: Decision.probability({
      instructions:
        "Does the EARS requirement or hole signature genuinely require this candidate symbol in the proposed hyperedge role?",
    }),
    candidateRelevance: Decision.rate({
      instructions:
        "How relevant is this candidate symbol as an inhabitant or collaborator when filling the stub<A, E, R>() hole?",
      criteria: HOLE_RELEVANCE_LEVELS,
    }),
  },
})

assertDecisionLimits(HoleRelevanceAndEdgePriorV1)

export const HoleCandidatePriorInput = Schema.Struct({
  holeSpanName: Schema.NonEmptyString,
  holeSignatureSummary: Schema.String,
  candidateSymbolKey: CandidateSymbolKey,
  candidateSignatureSummary: Schema.String,
  proposedRole: ProposedRoleName,
  earsClauseContext: Schema.String,
})
export type HoleCandidatePriorInput = typeof HoleCandidatePriorInput.Type

export const HoleCandidatePriorResult = Schema.Struct({
  candidateSymbolKey: CandidateSymbolKey,
  proposedRole: ProposedRoleName,
  edgeConfidenceMillis: ConfidenceMillis,
  teleportationWeightMillis: ConfidenceMillis,
  relevanceLabel: Schema.Literals(HOLE_RELEVANCE_LEVELS),
  source: PriorSource,
})
export type HoleCandidatePriorResult = typeof HoleCandidatePriorResult.Type

export const evaluateHoleCandidatePrior = Effect.fn("HoleRelevanceAndEdgePrior.evaluate")(
  function* (input: HoleCandidatePriorInput) {
    const outcome = yield* DecisionModel.decide(HoleRelevanceAndEdgePriorV1, { input }).pipe(
      Effect.timeoutOption("1500 millis"),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause) && !Cause.hasDies(cause),
        () => Effect.succeedNone,
      ),
    )

    return yield* match(outcome)
      .with({ _tag: "None" }, () =>
        Effect.succeed({
          candidateSymbolKey: input.candidateSymbolKey,
          proposedRole: input.proposedRole,
          edgeConfidenceMillis: ConfidenceMillis.make(500),
          teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.tangential,
          relevanceLabel: "tangential" as const,
          source: { _tag: "DeterministicFallback" },
        } satisfies HoleCandidatePriorResult),
      )
      .with({ _tag: "Some" }, ({ value }) =>
        Effect.gen(function* () {
          const { answers } = value
          const clampedEdgeConfidence = Math.min(
            1000,
            Math.max(0, Math.round(answers.edgeConfidence.probability * 1000)),
          )
          const edgeConfidenceMillis = ConfidenceMillis.make(clampedEdgeConfidence)

          const rawLabel = answers.candidateRelevance.label as string

          const { relevanceLabel, teleportationWeightMillis } = match(rawLabel)
            .with("irrelevant", () => ({
              relevanceLabel: "irrelevant" as const,
              teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.irrelevant,
            }))
            .with("tangential", () => ({
              relevanceLabel: "tangential" as const,
              teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.tangential,
            }))
            .with("helpful", () => ({
              relevanceLabel: "helpful" as const,
              teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.helpful,
            }))
            .with("essential", () => ({
              relevanceLabel: "essential" as const,
              teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.essential,
            }))
            .otherwise(() => ({
              relevanceLabel: "irrelevant" as const,
              teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.irrelevant,
            }))

          yield* Effect.annotateCurrentSpan({
            "decision.definition": "HoleRelevanceAndEdgePriorV1",
            "decision.edgeConfidenceMillis": edgeConfidenceMillis,
            "decision.teleportationWeightMillis": teleportationWeightMillis,
            "decision.relevanceLabel": relevanceLabel,
          })

          return {
            candidateSymbolKey: input.candidateSymbolKey,
            proposedRole: input.proposedRole,
            edgeConfidenceMillis,
            teleportationWeightMillis,
            relevanceLabel,
            source: { _tag: "DecisionModel" },
          } satisfies HoleCandidatePriorResult
        }),
      )
      .exhaustive()
  },
)
