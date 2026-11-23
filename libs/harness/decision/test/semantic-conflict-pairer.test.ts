import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  ConflictPairLimit,
  EarsClauseText,
  EarsEffectSymbol,
  EmbeddingComponent,
  EmbeddingNodeKey,
  GovernanceDocIdentifier,
  type RequirementEmbeddingItem,
  RequirementId,
  SimilarityScore,
} from "@harness/contract"
import { decideSemanticConflictPairs } from "../src/semantic-conflict-pairer.js"

const toUnit = (x: number, y: number, z: number) => [
  EmbeddingComponent.make(x),
  EmbeddingComponent.make(y),
  EmbeddingComponent.make(z),
]

const makeReqItem = (input: {
  readonly specId: string
  readonly reqId: string
  readonly clauseText: string
  readonly effectSymbol: string
  readonly components: ReadonlyArray<EmbeddingComponent>
}): RequirementEmbeddingItem => ({
  nodeKey: EmbeddingNodeKey.make(`EarsRequirement:${input.specId}::${input.reqId}`),
  specId: GovernanceDocIdentifier.make(input.specId),
  requirementId: RequirementId.make(input.reqId),
  clauseText: EarsClauseText.make(input.clauseText),
  effectSymbol: EarsEffectSymbol.make(input.effectSymbol),
  vector: { components: input.components },
})

const UnitVectorPreset = Schema.Literals(["high-1", "high-2", "medium", "orthogonal"])

const RequirementGeneSchema = Schema.Struct({
  specId: Schema.Literals(["harness:SPEC-0001", "harness:SPEC-0002", "harness:SPEC-0003"]),
  reqSuffix: Schema.Literals(["1", "2", "3", "4"]),
  symbol: Schema.Literals(["Harness.shared", "Harness.alpha", "Harness.beta", ""]),
  vecPreset: UnitVectorPreset,
})

const ConflictScenario = Schema.Struct({
  maxPairs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
  minSimilarity: Schema.Literals([0.5, 0.84, 0.99]),
  genes: Schema.Array(RequirementGeneSchema).pipe(Schema.check(Schema.isBetweenLength(2, 6))),
})

const presetToComponents = (preset: typeof UnitVectorPreset.Type) => {
  if (preset === "high-1") return toUnit(1, 0, 0)
  if (preset === "high-2") return toUnit(0.995, 0.0998, 0)
  if (preset === "medium") return toUnit(0.7, 0.7141, 0)
  return toUnit(0, 0, 1)
}

const dotCosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number =>
  a.reduce((acc, v, i) => acc + v * (b[i] ?? 0), 0)

describe("SemanticConflictPairer.decide (SPEC-0031 §REQ-3.4)", () => {
  it.effect("ignores zero-norm and mismatched-dimension vectors safely and ranks descending", () =>
    Effect.gen(function* () {
      const a = makeReqItem({
        specId: "harness:SPEC-0010",
        reqId: "REQ-1.1",
        clauseText: "When A occurs, system rejects request.",
        effectSymbol: "Harness.alpha",
        components: toUnit(1, 0, 0),
      })
      const b = makeReqItem({
        specId: "harness:SPEC-0020",
        reqId: "REQ-2.1",
        clauseText: "When A occurs, system approves request immediately.",
        effectSymbol: "Harness.beta",
        components: toUnit(0.95, 0.31225, 0),
      })
      const cZero = makeReqItem({
        specId: "harness:SPEC-0030",
        reqId: "REQ-3.1",
        clauseText: "Invalid zero vector entry.",
        effectSymbol: "Harness.gamma",
        components: toUnit(0, 0, 0),
      })
      const dDimMismatch = makeReqItem({
        specId: "harness:SPEC-0040",
        reqId: "REQ-4.1",
        clauseText: "Mismatched dimension entry.",
        effectSymbol: "Harness.delta",
        components: [EmbeddingComponent.make(1), EmbeddingComponent.make(0)],
      })

      const result = yield* decideSemanticConflictPairs({
        items: [b, dDimMismatch, cZero, a],
        minSimilarity: SimilarityScore.make(0.84),
        maxPairs: ConflictPairLimit.make(4),
      })

      expect(result.candidates).toHaveLength(1)
      const hit = result.candidates[0]!
      expect(hit.sourceNodeKey).toBe(a.nodeKey)
      expect(hit.targetNodeKey).toBe(b.nodeKey)
      expect(hit.similarity).toBeGreaterThanOrEqual(0.94)

      const zeroNeg = yield* decideSemanticConflictPairs({
        items: [cZero, a],
        minSimilarity: SimilarityScore.make(-0.5),
        maxPairs: ConflictPairLimit.make(4),
      })
      expect(zeroNeg.candidates).toEqual([])
    }),
  )

  it.effect.prop(
    "excludes self/same-spec/shared-symbol pairs and guarantees positive inclusion of qualifying cross-spec pairs",
    { scenario: ConflictScenario },
    ({ scenario }) =>
      Effect.gen(function* () {
        const uniqueItemsByKey = new Map<string, RequirementEmbeddingItem>()
        for (const g of scenario.genes) {
          const item = makeReqItem({
            specId: g.specId,
            reqId: `REQ-1.${g.reqSuffix}`,
            clauseText: `Clause for ${g.specId}#REQ-1.${g.reqSuffix}`,
            effectSymbol: g.symbol,
            components: presetToComponents(g.vecPreset),
          })
          uniqueItemsByKey.set(item.nodeKey, item)
        }
        const items = [...uniqueItemsByKey.values()]

        const forward = yield* decideSemanticConflictPairs({
          items,
          minSimilarity: SimilarityScore.make(scenario.minSimilarity),
          maxPairs: ConflictPairLimit.make(scenario.maxPairs),
        })
        const reversed = yield* decideSemanticConflictPairs({
          items: [...items].reverse(),
          minSimilarity: SimilarityScore.make(scenario.minSimilarity),
          maxPairs: ConflictPairLimit.make(scenario.maxPairs),
        })

        expect(forward).toEqual(reversed)
        expect(forward.candidates.length).toBeLessThanOrEqual(scenario.maxPairs)

        const byKey = new Map(items.map((item) => [item.nodeKey, item]))
        for (const pair of forward.candidates) {
          expect(pair.sourceNodeKey).not.toBe(pair.targetNodeKey)
          expect(pair.sourceId).not.toBe(pair.targetId)
          expect(pair.similarity).toBeGreaterThanOrEqual(scenario.minSimilarity)
          const src = byKey.get(pair.sourceNodeKey)!
          const dst = byKey.get(pair.targetNodeKey)!
          if (src.effectSymbol.trim().length > 0 && dst.effectSymbol.trim().length > 0) {
            expect(src.effectSymbol.trim()).not.toBe(dst.effectSymbol.trim())
          }
        }

        let expectedQualifyingCount = 0
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            const left = items[i]!
            const right = items[j]!
            if (left.specId === right.specId) continue
            const lSym = left.effectSymbol.trim()
            const rSym = right.effectSymbol.trim()
            if (lSym.length > 0 && lSym === rSym) continue
            const sim = dotCosine(left.vector.components, right.vector.components)
            if (sim >= scenario.minSimilarity) {
              expectedQualifyingCount++
            }
          }
        }
        expect(forward.candidates).toHaveLength(
          Math.min(expectedQualifyingCount, scenario.maxPairs),
        )
      }),
  )
})
