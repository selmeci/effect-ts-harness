import * as Graph from "effect/Graph"
import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  ConflictPairLimit,
  EarsClauseText,
  EarsEffectSymbol,
  EmbeddingComponent,
  EmbeddingNodeKey,
  ErrorReasonMessage,
  GovernanceDocIdentifier,
  type RequirementEmbeddingItem,
  RequirementId,
  type SemanticConflictCandidate,
  type SemanticConflictPairerInput,
  type SemanticConflictPairerResult,
  SimilarityScore,
  type WorkspaceFilePath,
} from "@harness/contract"
import { decideEmbeddingSyncPlan, type GovernanceDocReference } from "@harness/gates"
import { type EarsRequirementNode, type HarnessGraph, syncGraphEmbeddings } from "@harness/graph"
import type { EmbeddingCachePort, EmbeddingClient } from "@harness/service"
import type { OntologyConflictInput } from "./ontology-conflict-decision.js"

const DEFAULT_SEMANTIC_MIN_SIMILARITY = 0.84
const DEFAULT_SEMANTIC_MAX_PAIRS = 4

export interface CollectSemanticConflictCandidatesInput {
  readonly repoRoot: WorkspaceFilePath
  readonly graph: HarnessGraph
  readonly docs: ReadonlyArray<GovernanceDocReference>
  readonly existingPairs: ReadonlyArray<OntologyConflictInput>
  readonly minSimilarity?: number | undefined
  readonly maxPairs?: number | undefined
}

export interface CollectSemanticConflictCandidatesResult {
  readonly pairs: ReadonlyArray<OntologyConflictInput>
  readonly degraded: boolean
  readonly degradedReason: ErrorReasonMessage | null
}

const clampUnitInterval = (value: number): number => Math.max(-1, Math.min(1, value))

const cosineSimilarity = (
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): number | undefined => {
  if (a.length === 0 || a.length !== b.length) return undefined
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!
    const vb = b[i]!
    if (!Number.isFinite(va) || !Number.isFinite(vb)) return undefined
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }
  if (normA === 0 || normB === 0) return undefined
  return clampUnitInterval(dot / (Math.sqrt(normA) * Math.sqrt(normB)))
}

export const decideSemanticConflictPairs = Effect.fn("SemanticConflictPairer.decide")(function* (
  input: SemanticConflictPairerInput,
): Effect.fn.Return<SemanticConflictPairerResult, never, never> {
  const candidates: Array<SemanticConflictCandidate> = []
  const items = [...input.items].sort((a, b) => compareCodeUnits(a.nodeKey, b.nodeKey))

  for (let i = 0; i < items.length; i++) {
    const left = items[i]!
    for (let j = i + 1; j < items.length; j++) {
      const right = items[j]!
      if (left.nodeKey === right.nodeKey) continue
      if (left.specId === right.specId) continue

      const leftSym = left.effectSymbol.trim()
      const rightSym = right.effectSymbol.trim()
      if (leftSym.length > 0 && leftSym === rightSym) continue

      const sim = cosineSimilarity(left.vector.components, right.vector.components)
      if (sim === undefined || sim < input.minSimilarity) continue

      const canonicalFirst = left
      const canonicalSecond = right

      candidates.push({
        sourceNodeKey: canonicalFirst.nodeKey,
        targetNodeKey: canonicalSecond.nodeKey,
        sourceId: canonicalFirst.specId,
        sourceRequirementId: canonicalFirst.requirementId,
        sourceText: canonicalFirst.clauseText,
        targetId: canonicalSecond.specId,
        targetRequirementId: canonicalSecond.requirementId,
        targetText: canonicalSecond.clauseText,
        similarity: SimilarityScore.make(clampUnitInterval(Number(sim.toFixed(6)))),
      })
    }
  }

  candidates.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      compareCodeUnits(a.sourceNodeKey, b.sourceNodeKey) ||
      compareCodeUnits(a.targetNodeKey, b.targetNodeKey),
  )

  return yield* Effect.succeed({
    candidates: candidates.slice(0, input.maxPairs),
  })
})

export const collectSemanticConflictCandidates = Effect.fn(
  "OntologyConflict.collectSemanticCandidates",
)(function* (
  input: CollectSemanticConflictCandidatesInput,
): Effect.fn.Return<
  CollectSemanticConflictCandidatesResult,
  never,
  EmbeddingClient | EmbeddingCachePort
> {
  const activeDocIds = new Set(
    input.docs
      .filter((d) =>
        match(d.status)
          .with("accepted", "proposed", () => true)
          .with("deprecated", "superseded", () => false)
          .exhaustive(),
      )
      .map((d) => d.id),
  )

  const activeRequirements: Array<EarsRequirementNode> = []
  const distinctActiveSpecs = new Set<string>()
  for (const [, node] of Graph.nodes(input.graph.graph)) {
    match(node)
      .with({ _tag: "EarsRequirement" }, (req) => {
        if (!activeDocIds.has(req.specId)) return
        activeRequirements.push(req)
        distinctActiveSpecs.add(req.specId)
      })
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }

  if (distinctActiveSpecs.size < 2 || activeRequirements.length < 2) {
    return { pairs: [], degraded: false, degradedReason: null }
  }

  const syncOutcome = yield* syncGraphEmbeddings({
    graph: input.graph,
    repoRoot: input.repoRoot,
    decidePlan: decideEmbeddingSyncPlan,
  })

  return yield* match(syncOutcome)
    .with({ mode: "bm25-only" }, ({ degradedReason }) =>
      Effect.succeed<CollectSemanticConflictCandidatesResult>({
        pairs: [],
        degraded: true,
        degradedReason,
      }),
    )
    .with({ mode: "hybrid-rrf" }, ({ vectorsByNodeKey }) =>
      Effect.gen(function* () {
        const items: Array<RequirementEmbeddingItem> = []
        for (const req of activeRequirements) {
          const nodeKey = EmbeddingNodeKey.make(`EarsRequirement:${req.id}`)
          const vec = vectorsByNodeKey.get(nodeKey)
          if (vec === undefined || vec.components.length === 0) {
            return {
              pairs: [],
              degraded: true,
              degradedReason: ErrorReasonMessage.make(
                `Missing embedding vector for active requirement ${nodeKey}; semantic conflict check degraded`,
              ),
            } satisfies CollectSemanticConflictCandidatesResult
          }
          items.push({
            nodeKey,
            specId: GovernanceDocIdentifier.make(req.specId),
            requirementId: RequirementId.make(req.requirementId),
            clauseText: EarsClauseText.make(req.clauseText),
            effectSymbol: EarsEffectSymbol.make(req.effectSymbol),
            vector: { components: vec.components.map((c) => EmbeddingComponent.make(c)) },
          })
        }

        const pairResult = yield* decideSemanticConflictPairs({
          items,
          minSimilarity: SimilarityScore.make(
            clampUnitInterval(input.minSimilarity ?? DEFAULT_SEMANTIC_MIN_SIMILARITY),
          ),
          maxPairs: ConflictPairLimit.make(input.maxPairs ?? DEFAULT_SEMANTIC_MAX_PAIRS),
        })

        const seenKeys = new Set<string>()
        for (const p of input.existingPairs) {
          seenKeys.add(`${p.sourceId}<->${p.targetId}`)
          seenKeys.add(`${p.targetId}<->${p.sourceId}`)
        }

        const extraPairs: Array<OntologyConflictInput> = []
        for (const candidate of pairResult.candidates) {
          const sourceId = `${candidate.sourceId}#${candidate.sourceRequirementId}`
          const targetId = `${candidate.targetId}#${candidate.targetRequirementId}`
          if (seenKeys.has(`${sourceId}<->${targetId}`)) continue
          seenKeys.add(`${sourceId}<->${targetId}`)
          seenKeys.add(`${targetId}<->${sourceId}`)
          extraPairs.push({
            sourceId,
            sourceText: candidate.sourceText,
            targetId,
            targetText: candidate.targetText,
            sharedSymbol: `semantic-similarity:${candidate.similarity.toFixed(2)}`,
          })
        }

        return {
          pairs: extraPairs,
          degraded: false,
          degradedReason: null,
        } satisfies CollectSemanticConflictCandidatesResult
      }),
    )
    .exhaustive()
})
