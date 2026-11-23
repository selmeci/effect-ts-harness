import { Effect } from "effect"
import {
  compareCodeUnits,
  type SemanticConflictCandidate,
  type SemanticConflictPairerInput,
  type SemanticConflictPairerResult,
  SimilarityScore,
} from "@harness/contract"

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
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
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
        similarity: SimilarityScore.make(Number(sim.toFixed(6))),
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
