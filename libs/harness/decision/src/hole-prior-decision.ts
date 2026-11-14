import { ConfidenceMillis, NodeKey, PageRankScoreMillis, RoleName } from "@harness/graph"
import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"

export { ConfidenceMillis, NodeKey, PageRankScoreMillis, RoleName }

export const CandidateSymbolKey = NodeKey
export type CandidateSymbolKey = NodeKey

export const ProposedRoleName = RoleName
export type ProposedRoleName = RoleName

export const DecisionModelSource = Schema.TaggedStruct("DecisionModel", {})
export type DecisionModelSource = typeof DecisionModelSource.Type

export const DeterministicFallbackReason = Schema.Literals([
  "timeout-or-unavailable",
  "model-error",
  "timeout",
  "invalid-output",
])
export type DeterministicFallbackReason = typeof DeterministicFallbackReason.Type

export const DeterministicFallbackSource = Schema.TaggedStruct("DeterministicFallback", {
  reason: Schema.optional(DeterministicFallbackReason),
})
export type DeterministicFallbackSource = typeof DeterministicFallbackSource.Type

export const PriorSource = Schema.Union([DecisionModelSource, DeterministicFallbackSource])
export type PriorSource = typeof PriorSource.Type

export const HOLE_RELEVANCE_LEVELS = ["irrelevant", "tangential", "helpful", "essential"] as const
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

const parseRelevanceLabel = (
  rawLabel: unknown,
): Option.Option<{
  readonly relevanceLabel: HoleRelevanceLevel
  readonly teleportationWeightMillis: ConfidenceMillis
}> =>
  match(rawLabel)
    .with("irrelevant", () =>
      Option.some({
        relevanceLabel: "irrelevant" as const,
        teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.irrelevant,
      }),
    )
    .with("tangential", () =>
      Option.some({
        relevanceLabel: "tangential" as const,
        teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.tangential,
      }),
    )
    .with("helpful", () =>
      Option.some({
        relevanceLabel: "helpful" as const,
        teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.helpful,
      }),
    )
    .with("essential", () =>
      Option.some({
        relevanceLabel: "essential" as const,
        teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.essential,
      }),
    )
    .otherwise(() => Option.none())

const makeFallbackHolePriorResult = (
  input: HoleCandidatePriorInput,
  reason: DeterministicFallbackReason,
): HoleCandidatePriorResult => ({
  candidateSymbolKey: input.candidateSymbolKey,
  proposedRole: input.proposedRole,
  edgeConfidenceMillis: ConfidenceMillis.make(500),
  teleportationWeightMillis: RELEVANCE_WEIGHT_MILLIS.tangential,
  relevanceLabel: "tangential",
  source: { _tag: "DeterministicFallback", reason },
})

export const evaluateHoleCandidatePrior = Effect.fn("HoleRelevanceAndEdgePrior.evaluate")(
  function* (
    input: HoleCandidatePriorInput,
  ): Effect.fn.Return<HoleCandidatePriorResult, never, DecisionModel.DecisionModel> {
    const outcome = yield* DecisionModel.decide(HoleRelevanceAndEdgePriorV1, { input }).pipe(
      Effect.timeoutOption("1500 millis"),
      Effect.catch((error) =>
        Effect.annotateCurrentSpan({
          "decision.fallback_error": String(error),
        }).pipe(Effect.as(Option.none())),
      ),
    )

    return yield* match(outcome)
      .with({ _tag: "None" }, () =>
        Effect.succeed(makeFallbackHolePriorResult(input, "timeout-or-unavailable")),
      )
      .with({ _tag: "Some" }, ({ value }) =>
        Effect.gen(function* () {
          const { answers } = value
          const rawProb = answers.edgeConfidence?.probability
          const parsedRelevance = parseRelevanceLabel(answers.candidateRelevance?.label)
          if (typeof rawProb !== "number" || !Number.isFinite(rawProb)) {
            return makeFallbackHolePriorResult(input, "invalid-output")
          }
          return yield* match(parsedRelevance)
            .with({ _tag: "None" }, () =>
              Effect.succeed(makeFallbackHolePriorResult(input, "invalid-output")),
            )
            .with({ _tag: "Some" }, ({ value: { relevanceLabel, teleportationWeightMillis } }) =>
              Effect.gen(function* () {
                const clampedEdgeConfidence = Math.min(
                  1000,
                  Math.max(0, Math.round(rawProb * 1000)),
                )
                const edgeConfidenceMillis = ConfidenceMillis.make(clampedEdgeConfidence)

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
  const modelBackedEdgeKeys = new Set<string>()
  const modelBackedTeleportKeys = new Set<NodeKey>()
  const results: Array<HoleCandidatePriorResult> = []
  let usedFallback = false
  let fallbackReason: DeterministicFallbackReason | undefined

  const mergeConfidence = (key: string, score: ConfidenceMillis, isModelBacked: boolean): void => {
    if (isModelBacked) {
      if (!modelBackedEdgeKeys.has(key)) {
        modelBackedEdgeKeys.add(key)
        edgeConfidenceOverrides[key] = score
        return
      }
      const existing = edgeConfidenceOverrides[key]
      edgeConfidenceOverrides[key] = existing !== undefined && existing > score ? existing : score
      return
    }
    if (modelBackedEdgeKeys.has(key)) {
      return
    }
    const existing = edgeConfidenceOverrides[key]
    edgeConfidenceOverrides[key] = existing !== undefined && existing > score ? existing : score
  }

  const mergeTeleportationWeight = (
    key: NodeKey,
    score: PageRankScoreMillis,
    isModelBacked: boolean,
  ): void => {
    if (isModelBacked) {
      if (!modelBackedTeleportKeys.has(key)) {
        modelBackedTeleportKeys.add(key)
        holeTeleportationWeights[key] = score
        return
      }
      const existing = holeTeleportationWeights[key]
      holeTeleportationWeights[key] = existing !== undefined && existing > score ? existing : score
      return
    }
    if (modelBackedTeleportKeys.has(key)) {
      return
    }
    const existing = holeTeleportationWeights[key]
    holeTeleportationWeights[key] = existing !== undefined && existing > score ? existing : score
  }

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
      Effect.catch((error) =>
        Effect.annotateCurrentSpan({
          "decision.fallback_error": String(error),
        }).pipe(Effect.as(Option.none())),
      ),
    )

    yield* match(outcome)
      .with({ _tag: "None" }, () =>
        Effect.sync(() => {
          usedFallback = true
          fallbackReason = fallbackReason ?? "timeout-or-unavailable"
          for (const item of chunk) {
            const fb = makeFallbackHolePriorResult(item, "timeout-or-unavailable")
            const roleKey = `${item.candidateSymbolKey}:${item.proposedRole}`
            mergeConfidence(roleKey, fb.edgeConfidenceMillis, false)
            mergeConfidence(item.candidateSymbolKey, fb.edgeConfidenceMillis, false)
            mergeTeleportationWeight(
              item.candidateSymbolKey,
              PageRankScoreMillis.make(fb.teleportationWeightMillis),
              false,
            )
            results.push(fb)
          }
        }),
      )
      .with({ _tag: "Some" }, ({ value }) =>
        Effect.sync(() => {
          const answersRecord = value.answers as Record<
            string,
            { readonly probability?: number; readonly label?: string } | undefined
          >
          for (let i = 0; i < chunk.length; i++) {
            const item = chunk[i]!
            const probAns = answersRecord[`edgeConfidence_${i}`]
            const rateAns = answersRecord[`candidateRelevance_${i}`]
            const rawProb = probAns?.probability
            const parsedRelevance = parseRelevanceLabel(rateAns?.label)

            if (typeof rawProb !== "number" || !Number.isFinite(rawProb)) {
              usedFallback = true
              fallbackReason = fallbackReason ?? "invalid-output"
              const fb = makeFallbackHolePriorResult(item, "invalid-output")
              const roleKey = `${item.candidateSymbolKey}:${item.proposedRole}`
              mergeConfidence(roleKey, fb.edgeConfidenceMillis, false)
              mergeConfidence(item.candidateSymbolKey, fb.edgeConfidenceMillis, false)
              mergeTeleportationWeight(
                item.candidateSymbolKey,
                PageRankScoreMillis.make(fb.teleportationWeightMillis),
                false,
              )
              results.push(fb)
              continue
            }

            match(parsedRelevance)
              .with({ _tag: "None" }, () => {
                usedFallback = true
                fallbackReason = fallbackReason ?? "invalid-output"
                const fb = makeFallbackHolePriorResult(item, "invalid-output")
                const roleKey = `${item.candidateSymbolKey}:${item.proposedRole}`
                mergeConfidence(roleKey, fb.edgeConfidenceMillis, false)
                mergeConfidence(item.candidateSymbolKey, fb.edgeConfidenceMillis, false)
                mergeTeleportationWeight(
                  item.candidateSymbolKey,
                  PageRankScoreMillis.make(fb.teleportationWeightMillis),
                  false,
                )
                results.push(fb)
              })
              .with(
                { _tag: "Some" },
                ({ value: { relevanceLabel, teleportationWeightMillis } }) => {
                  const clampedConf = Math.min(1000, Math.max(0, Math.round(rawProb * 1000)))
                  const edgeConfidenceMillis = ConfidenceMillis.make(clampedConf)
                  const roleKey = `${item.candidateSymbolKey}:${item.proposedRole}`
                  mergeConfidence(roleKey, edgeConfidenceMillis, true)
                  mergeConfidence(item.candidateSymbolKey, edgeConfidenceMillis, true)
                  mergeTeleportationWeight(
                    item.candidateSymbolKey,
                    PageRankScoreMillis.make(teleportationWeightMillis),
                    true,
                  )
                  results.push({
                    candidateSymbolKey: item.candidateSymbolKey,
                    proposedRole: item.proposedRole,
                    edgeConfidenceMillis,
                    teleportationWeightMillis,
                    relevanceLabel,
                    source: { _tag: "DecisionModel" },
                  })
                },
              )
              .exhaustive()
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
      ? {
          _tag: "DeterministicFallback",
          reason: fallbackReason ?? "timeout-or-unavailable",
        }
      : { _tag: "DecisionModel" },
  }
})
