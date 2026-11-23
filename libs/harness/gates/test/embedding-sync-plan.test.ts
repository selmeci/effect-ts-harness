import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  EmbeddingBatchTimestamp,
  EmbeddingComponent,
  EmbeddingContentHash,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingNodeKey,
  EmbeddingSourceText,
  type EmbeddingCacheSnapshot,
  type EmbeddingSyncCandidateItem,
} from "@harness/contract"
import { decideEmbeddingSyncPlan } from "../src/index.js"

const sha256 = (value: string): EmbeddingContentHash =>
  EmbeddingContentHash.make(createHash("sha256").update(value, "utf8").digest("hex"))

const makeCandidate = (id: string, version: string): EmbeddingSyncCandidateItem => {
  const key = EmbeddingNodeKey.make(`EarsRequirement:harness:SPEC-${id}::REQ-1.1`)
  return {
    nodeKey: key,
    nodeKind: "EarsRequirement",
    contentHash: sha256(`clause-${id}-${version}`),
    sourceText: EmbeddingSourceText.make(`Clause ${id} ${version}`),
  }
}

const CandidateGeneSchema = Schema.Struct({
  id: Schema.Literals(["0001", "0002", "0003", "0004", "0005", "0006"]),
  inCurrent: Schema.Boolean,
  inCache: Schema.Boolean,
  dirtyHash: Schema.Boolean,
})

const EmbeddingSyncPlanScenario = Schema.Struct({
  modelId: Schema.Literals(["qwen3-embedding:8b", "bge-m3"]),
  dimensions: Schema.Literals([1024, 4096]),
  sameModel: Schema.Boolean,
  sameDimensions: Schema.Boolean,
  genes: Schema.Array(CandidateGeneSchema).pipe(Schema.check(Schema.isBetweenLength(1, 6))),
})

describe("EmbeddingSyncPlan.decide (ADR-0025 / SPEC-0031)", () => {
  it.effect(
    "returns ModelMismatchRebuild with sorted embedKeys when no cache snapshot exists",
    () =>
      Effect.gen(function* () {
        const c2 = makeCandidate("0002", "v1")
        const c1 = makeCandidate("0001", "v1")
        const decision = yield* decideEmbeddingSyncPlan({
          currentModel: EmbeddingModelId.make("qwen3-embedding:8b"),
          currentDimensions: EmbeddingDimensionCount.make(4096),
          items: [c2, c1],
          cachedSnapshot: null,
        })

        match(decision)
          .with({ _tag: "ModelMismatchRebuild" }, (d) => {
            expect(d.embedKeys).toEqual([c1.nodeKey, c2.nodeKey])
            expect(d.evictedKeys).toEqual([])
          })
          .with({ _tag: "CacheHitAll" }, { _tag: "EmbedDelta" }, () => {
            expect.unreachable("Expected ModelMismatchRebuild when cache is null")
          })
          .exhaustive()
      }),
  )

  it.effect.prop(
    "partitions hits, dirty deltas, evictions, and rebuilds deterministically across composite arrays",
    { scenario: EmbeddingSyncPlanScenario },
    ({ scenario }) =>
      Effect.gen(function* () {
        const dedupedGenes = new Map<string, typeof CandidateGeneSchema.Type>()
        for (const g of scenario.genes) {
          dedupedGenes.set(g.id, g)
        }
        const genes = [...dedupedGenes.values()]
        const currentItems = genes.filter((g) => g.inCurrent).map((g) => makeCandidate(g.id, "v1"))

        const currentModel = EmbeddingModelId.make(scenario.modelId)
        const currentDimensions = EmbeddingDimensionCount.make(scenario.dimensions)
        const cachedModel = EmbeddingModelId.make(
          scenario.sameModel
            ? scenario.modelId
            : scenario.modelId === "bge-m3"
              ? "qwen3-embedding:8b"
              : "bge-m3",
        )
        const cachedDimensions = EmbeddingDimensionCount.make(
          scenario.sameDimensions
            ? scenario.dimensions
            : scenario.dimensions === 4096
              ? 1024
              : 4096,
        )

        const cachedEntries = genes
          .filter((g) => g.inCache)
          .map((g) => {
            const base = makeCandidate(g.id, "v1")
            return {
              nodeKey: base.nodeKey,
              nodeKind: base.nodeKind,
              contentHash: g.dirtyHash ? sha256(`dirty-${g.id}`) : base.contentHash,
              dimensions: cachedDimensions,
              vector: { components: [EmbeddingComponent.make(1)] },
            }
          })

        const cachedSnapshot: EmbeddingCacheSnapshot = {
          schemaVersion: 1,
          model: cachedModel,
          dimensions: cachedDimensions,
          updatedAt: EmbeddingBatchTimestamp.make("2026-11-22T00:00:00.000Z"),
          entries: cachedEntries,
        }

        const forward = yield* decideEmbeddingSyncPlan({
          currentModel,
          currentDimensions,
          items: currentItems,
          cachedSnapshot,
        })
        const reversed = yield* decideEmbeddingSyncPlan({
          currentModel,
          currentDimensions,
          items: [...currentItems].reverse(),
          cachedSnapshot: {
            ...cachedSnapshot,
            entries: [...cachedSnapshot.entries].reverse(),
          },
        })

        expect(forward).toEqual(reversed)
        const expectedCurrentKeys = currentItems.map((i) => i.nodeKey).sort(compareCodeUnits)

        match(forward)
          .with({ _tag: "ModelMismatchRebuild" }, (d) => {
            expect(!scenario.sameModel || !scenario.sameDimensions).toBe(true)
            expect(d.embedKeys).toEqual(expectedCurrentKeys)
          })
          .with({ _tag: "CacheHitAll" }, (d) => {
            expect(scenario.sameModel && scenario.sameDimensions).toBe(true)
            expect(d.reusedKeys).toEqual(expectedCurrentKeys)
          })
          .with({ _tag: "EmbedDelta" }, (d) => {
            expect(scenario.sameModel && scenario.sameDimensions).toBe(true)
            const reusedSet = new Set(d.reusedKeys)
            const embedSet = new Set(d.embedKeys)
            const evictedSet = new Set(d.evictedKeys)
            for (const k of reusedSet) {
              expect(embedSet.has(k)).toBe(false)
              expect(evictedSet.has(k)).toBe(false)
            }
            const combined = [...d.reusedKeys, ...d.embedKeys].sort(compareCodeUnits)
            expect(combined).toEqual(expectedCurrentKeys)
          })
          .exhaustive()
      }),
  )
})
