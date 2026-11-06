import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { assertDecisionLimits } from "./idiom-router.js"

export const HOLE_RELEVANCE_LEVELS = [
  "irrelevant",
  "tangential",
  "helpful",
  "essential",
] as const
export type HoleRelevanceLevel = (typeof HOLE_RELEVANCE_LEVELS)[number]

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

export interface HoleCandidatePriorInput {
  readonly holeSpanName: string
  readonly holeSignatureSummary: string
  readonly candidateSymbolKey: string
  readonly candidateSignatureSummary: string
  readonly proposedRole: string
  readonly earsClauseContext: string
}

export interface HoleCandidatePriorResult {
  readonly candidateSymbolKey: string
  readonly proposedRole: string
  readonly edgeConfidenceMillis: number
  readonly teleportationWeightMillis: number
  readonly relevanceLabel: HoleRelevanceLevel
  readonly source: "decision-model" | "deterministic-fallback"
}

export const evaluateHoleCandidatePrior = Effect.fn("Harness.evaluateHoleCandidatePrior")(
  function* (input: HoleCandidatePriorInput) {
    const outcome = yield* DecisionModel.decide(HoleRelevanceAndEdgePriorV1, { input }).pipe(
      Effect.timeoutOption("1500 millis"),
      Effect.catchCause(() => Effect.succeedNone),
    )

    if (Option.isNone(outcome)) {
      return {
        candidateSymbolKey: input.candidateSymbolKey,
        proposedRole: input.proposedRole,
        edgeConfidenceMillis: 850,
        teleportationWeightMillis: 750,
        relevanceLabel: "helpful" as const,
        source: "deterministic-fallback" as const,
      } satisfies HoleCandidatePriorResult
    }

    const { answers } = outcome.value
    const edgeConfidenceMillis = Math.min(
      1000,
      Math.max(0, Math.round(answers.edgeConfidence.probability * 1000)),
    )
    const teleportationWeightMillis = Math.min(
      1000,
      Math.max(0, Math.round((answers.candidateRelevance.rating / 3) * 1000)),
    )
    const rawLabel = answers.candidateRelevance.label
    const relevanceLabel: HoleRelevanceLevel = (
      HOLE_RELEVANCE_LEVELS as ReadonlyArray<string>
    ).includes(rawLabel)
      ? (rawLabel as HoleRelevanceLevel)
      : "helpful"

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
      source: "decision-model" as const,
    } satisfies HoleCandidatePriorResult
  },
)
