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

export const PageRankScoreMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  Schema.brand("PageRankScoreMillis"),
)
export type PageRankScoreMillis = typeof PageRankScoreMillis.Type

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

export const MAX_BATCHED_HOLE_CANDIDATES = 32

export const buildBatchedHolePriorDecision = (candidateCount: number) => {
  const boundedCount = Math.min(MAX_BATCHED_HOLE_CANDIDATES, Math.max(1, candidateCount))
  const decisions: Record<
    string,
    | (typeof HoleRelevanceAndEdgePriorV1.decisions)["edgeConfidence"]
    | (typeof HoleRelevanceAndEdgePriorV1.decisions)["candidateRelevance"]
  > = {}
  for (let i = 0; i < boundedCount; i++) {
    decisions[`edgeConfidence_${i}`] = Decision.probability({
      instructions: `Does candidate #${i} genuinely fulfill the proposed hyperedge role for its hole and EARS clause?`,
    })
    decisions[`candidateRelevance_${i}`] = Decision.rate({
      instructions: `How relevant is candidate #${i} as an inhabitant or collaborator when filling the stub<A, E, R>() hole?`,
      criteria: HOLE_RELEVANCE_LEVELS,
    })
  }
  const definition = Decision.make({
    input: Schema.Struct({
      candidatesBatchJson: Schema.String,
    }),
    decisions,
  })
  assertDecisionLimits(definition)
  return definition
}

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

export const SemanticEdgePriorsBatchResult = Schema.Struct({
  edgeConfidenceOverrides: Schema.Record(Schema.String, ConfidenceMillis),
  holeTeleportationWeights: Schema.Record(NodeKey, PageRankScoreMillis),
  results: Schema.Array(HoleCandidatePriorResult),
  source: PriorSource,
})
export type SemanticEdgePriorsBatchResult = typeof SemanticEdgePriorsBatchResult.Type

const mapRelevanceLabel = (
  rawLabel: string,
): {
  readonly relevanceLabel: HoleRelevanceLevel
  readonly teleportationWeightMillis: ConfidenceMillis
} =>
  match(rawLabel)
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
          const { relevanceLabel, teleportationWeightMillis } = mapRelevanceLabel(rawLabel)

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

/**
 * Evaluates up to 32 hole/edge candidates per chunk (up to 64 `Decision.probability` + `Decision.rate`
 * questions in a single `clef-flash` forward pass, validated via `assertDecisionLimits`, `RFC-0002 §4.4 & §4.6`),
 * computing `SemanticEdgePriors` (`edgeConfidenceOverrides` and `holeTeleportationWeights`) for `GraphInfer.decide`.
 */
export const evaluateHoleCandidatePriorsBatch = Effect.fn(
  "HoleRelevanceAndEdgePrior.evaluateBatch",
)(function* (
  inputs: ReadonlyArray<HoleCandidatePriorInput>,
): Effect.fn.Return<SemanticEdgePriorsBatchResult, never, DecisionModel.DecisionModel> {
  if (inputs.length === 0) {
    return {
      edgeConfidenceOverrides: {},
      holeTeleportationWeights: {},
      results: [],
      source: { _tag: "DecisionModel" },
    } satisfies SemanticEdgePriorsBatchResult
  }

  const edgeConfidenceOverrides: Record<string, ConfidenceMillis> = {}
  const holeTeleportationWeights: Record<NodeKey, PageRankScoreMillis> = {}
  const results: Array<HoleCandidatePriorResult> = []
  let usedFallback = false

  for (let offset = 0; offset < inputs.length; offset += MAX_BATCHED_HOLE_CANDIDATES) {
    const chunk = inputs.slice(offset, offset + MAX_BATCHED_HOLE_CANDIDATES)
    const batchedDef = buildBatchedHolePriorDecision(chunk.length)
    const candidatesBatchJson = JSON.stringify(
      chunk.map((item, idx) => ({
        index: idx,
        holeSpanName: item.holeSpanName,
        holeSignatureSummary: item.holeSignatureSummary,
        candidateSymbolKey: item.candidateSymbolKey,
        candidateSignatureSummary: item.candidateSignatureSummary,
        proposedRole: item.proposedRole,
        earsClauseContext: item.earsClauseContext,
      })),
    )

    const outcome = yield* DecisionModel.decide(batchedDef, {
      input: { candidatesBatchJson },
    }).pipe(
      Effect.timeoutOption("1500 millis"),
      Effect.catch(() => Effect.succeedNone),
    )

    yield* match(outcome)
      .with({ _tag: "None" }, () =>
        Effect.sync(() => {
          usedFallback = true
          for (const item of chunk) {
            const fallbackConf = ConfidenceMillis.make(500)
            const fallbackWeight = RELEVANCE_WEIGHT_MILLIS.tangential
            edgeConfidenceOverrides[`${item.candidateSymbolKey}:${item.proposedRole}`] =
              fallbackConf
            edgeConfidenceOverrides[item.candidateSymbolKey] = fallbackConf
            holeTeleportationWeights[item.candidateSymbolKey] = PageRankScoreMillis.make(
              fallbackWeight,
            )
            results.push({
              candidateSymbolKey: item.candidateSymbolKey,
              proposedRole: item.proposedRole,
              edgeConfidenceMillis: fallbackConf,
              teleportationWeightMillis: fallbackWeight,
              relevanceLabel: "tangential",
              source: { _tag: "DeterministicFallback", reason: "timeout-or-unavailable" },
            })
          }
        }),
      )
      .with({ _tag: "Some" }, ({ value }) =>
        Effect.sync(() => {
          const answersRecord = value.answers as Record<
            string,
            | { readonly probability?: number; readonly label?: string }
            | undefined
          >
          for (let i = 0; i < chunk.length; i++) {
            const item = chunk[i]!
            const probAns = answersRecord[`edgeConfidence_${i}`]
            const rateAns = answersRecord[`candidateRelevance_${i}`]
            const rawProb = typeof probAns?.probability === "number" ? probAns.probability : 0.5
            const clampedConf = Math.min(1000, Math.max(0, Math.round(rawProb * 1000)))
            const edgeConfidenceMillis = ConfidenceMillis.make(clampedConf)
            const rawLabel = typeof rateAns?.label === "string" ? rateAns.label : "tangential"
            const { relevanceLabel, teleportationWeightMillis } = mapRelevanceLabel(rawLabel)

            const roleKey = `${item.candidateSymbolKey}:${item.proposedRole}`
            const existingConf = edgeConfidenceOverrides[roleKey]
            edgeConfidenceOverrides[roleKey] =
              existingConf !== undefined && existingConf > edgeConfidenceMillis
                ? existingConf
                : edgeConfidenceMillis
            const existingSymConf = edgeConfidenceOverrides[item.candidateSymbolKey]
            edgeConfidenceOverrides[item.candidateSymbolKey] =
              existingSymConf !== undefined && existingSymConf > edgeConfidenceMillis
                ? existingSymConf
                : edgeConfidenceMillis

            const nextPpr = PageRankScoreMillis.make(teleportationWeightMillis)
            const existingPpr = holeTeleportationWeights[item.candidateSymbolKey]
            holeTeleportationWeights[item.candidateSymbolKey] =
              existingPpr !== undefined && existingPpr > nextPpr ? existingPpr : nextPpr

            results.push({
              candidateSymbolKey: item.candidateSymbolKey,
              proposedRole: item.proposedRole,
              edgeConfidenceMillis,
              teleportationWeightMillis,
              relevanceLabel,
              source: { _tag: "DecisionModel" },
            })
          }
        }),
      )
      .exhaustive()
  }

  yield* Effect.annotateCurrentSpan({
    "decision.definition": "HoleRelevanceAndEdgePriorV1.batch",
    "decision.batchSize": inputs.length,
    "decision.usedFallback": usedFallback,
  })

  return {
    edgeConfidenceOverrides,
    holeTeleportationWeights,
    results,
    source: usedFallback
      ? { _tag: "DeterministicFallback", reason: "timeout-or-unavailable" }
      : { _tag: "DecisionModel" },
  }
})
