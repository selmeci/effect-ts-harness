import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  EmbeddingBatchTimestamp,
  EmbeddingComponent,
  EmbeddingContentHash,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingNodeKey,
  EmbeddingProviderBaseUrl,
  EmbeddingSourceText,
  type EmbeddingCacheSnapshot,
  type EmbeddingSyncCandidateItem,
  ErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
import { buildHarnessGraph, syncGraphEmbeddings } from "@harness/graph"
import { EmbeddingCachePort, EmbeddingClient } from "@harness/service"
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
              vector: {
                components: Array.from({ length: cachedDimensions }, () =>
                  EmbeddingComponent.make(1),
                ),
              },
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
        const expectedCachedKeys = cachedEntries.map((e) => e.nodeKey).sort(compareCodeUnits)
        const cachedHashByKey = new Map(cachedEntries.map((e) => [e.nodeKey, e.contentHash]))
        const currentKeySet = new Set(expectedCurrentKeys)

        if (!scenario.sameModel || !scenario.sameDimensions) {
          match(forward)
            .with({ _tag: "ModelMismatchRebuild" }, (d) => {
              expect(d.embedKeys).toEqual(expectedCurrentKeys)
              expect(d.evictedKeys).toEqual(expectedCachedKeys)
            })
            .with({ _tag: "CacheHitAll" }, { _tag: "EmbedDelta" }, () => {
              expect.unreachable("Expected ModelMismatchRebuild when model or dimensions differ")
            })
            .exhaustive()
          return
        }

        const expectedReusedKeys = currentItems
          .filter((i) => cachedHashByKey.get(i.nodeKey) === i.contentHash)
          .map((i) => i.nodeKey)
          .sort(compareCodeUnits)
        const expectedEmbedKeys = currentItems
          .filter((i) => cachedHashByKey.get(i.nodeKey) !== i.contentHash)
          .map((i) => i.nodeKey)
          .sort(compareCodeUnits)
        const expectedEvictedKeys = cachedEntries
          .filter((e) => !currentKeySet.has(e.nodeKey))
          .map((e) => e.nodeKey)
          .sort(compareCodeUnits)

        if (expectedEmbedKeys.length === 0 && expectedEvictedKeys.length === 0) {
          match(forward)
            .with({ _tag: "CacheHitAll" }, (d) => {
              expect(d.reusedKeys).toEqual(expectedReusedKeys)
            })
            .with({ _tag: "EmbedDelta" }, { _tag: "ModelMismatchRebuild" }, () => {
              expect.unreachable("Expected CacheHitAll when all items match cached hashes")
            })
            .exhaustive()
        } else {
          match(forward)
            .with({ _tag: "EmbedDelta" }, (d) => {
              expect(d.reusedKeys).toEqual(expectedReusedKeys)
              expect(d.embedKeys).toEqual(expectedEmbedKeys)
              expect(d.evictedKeys).toEqual(expectedEvictedKeys)
            })
            .with({ _tag: "CacheHitAll" }, { _tag: "ModelMismatchRebuild" }, () => {
              expect.unreachable("Expected EmbedDelta when delta or evictions exist")
            })
            .exhaustive()
        }
      }),
  )

  it.effect(
    "integrates real decideEmbeddingSyncPlan with syncGraphEmbeddings across cold build, cache hit, delta/eviction, ModelMismatchRebuild, and unavailable degradation",
    () =>
      Effect.gen(function* () {
        let snapshot: EmbeddingCacheSnapshot | undefined
        const cacheLayer = Layer.succeed(
          EmbeddingCachePort,
          EmbeddingCachePort.of({
            readCache: () =>
              Effect.succeed(snapshot === undefined ? Option.none() : Option.some(snapshot)),
            writeCache: (_root, next) =>
              Effect.sync(() => {
                snapshot = next
              }),
          }),
        )

        const makeClientLayer = (opts: {
          readonly model: string
          readonly dimensions: number
          readonly available: boolean
        }) => {
          let embedCalls = 0
          const layer = Layer.succeed(
            EmbeddingClient,
            EmbeddingClient.of({
              config: {
                baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
                model: EmbeddingModelId.make(opts.model),
                dimensions: EmbeddingDimensionCount.make(opts.dimensions),
              },
              checkAvailability: Effect.succeed(
                opts.available
                  ? { _tag: "Available" as const }
                  : {
                      _tag: "Unavailable" as const,
                      cause: "network-error" as const,
                      reason: ErrorReasonMessage.make("Ollama offline"),
                    },
              ),
              embedBatch: (texts) =>
                Effect.sync(() => {
                  embedCalls++
                  return texts.map(() => ({
                    components: Array.from({ length: opts.dimensions }, () =>
                      EmbeddingComponent.make(1),
                    ),
                  }))
                }),
              embedQuery: () =>
                Effect.succeed({
                  components: Array.from({ length: opts.dimensions }, () =>
                    EmbeddingComponent.make(1),
                  ),
                }),
            }),
          )
          return { layer, getCalls: () => embedCalls }
        }

        const initialGraph = buildHarnessGraph({
          patternDocs: [
            { slug: "errors", path: "agent-patterns/errors.md", summary: "Errors summary v1" },
            { slug: "schema", path: "agent-patterns/schema.md", summary: "Schema summary v1" },
          ],
        })

        // 1. Cold build
        const c1 = makeClientLayer({ model: "qwen3-embedding:8b", dimensions: 4, available: true })
        const res1 = yield* syncGraphEmbeddings({
          graph: initialGraph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: decideEmbeddingSyncPlan,
        }).pipe(Effect.provide(Layer.mergeAll(c1.layer, cacheLayer)))
        expect(res1.mode).toBe("hybrid-rrf")
        expect(res1.embeddedDeltaCount).toBe(2)
        expect(c1.getCalls()).toBe(1)

        // 2. Cache hit -> 0 embed calls
        const res2 = yield* syncGraphEmbeddings({
          graph: initialGraph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: decideEmbeddingSyncPlan,
        }).pipe(Effect.provide(Layer.mergeAll(c1.layer, cacheLayer)))
        expect(res2.mode).toBe("hybrid-rrf")
        expect(res2.reusedCacheCount).toBe(2)
        expect(res2.embeddedDeltaCount).toBe(0)
        expect(c1.getCalls()).toBe(1)

        // 3. Delta update + eviction
        const deltaGraph = buildHarnessGraph({
          patternDocs: [
            { slug: "errors", path: "agent-patterns/errors.md", summary: "Errors summary v1" },
            {
              slug: "planning",
              path: "agent-patterns/planning.md",
              summary: "Planning summary v1",
            },
          ],
        })
        const res3 = yield* syncGraphEmbeddings({
          graph: deltaGraph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: decideEmbeddingSyncPlan,
        }).pipe(Effect.provide(Layer.mergeAll(c1.layer, cacheLayer)))
        expect(res3.mode).toBe("hybrid-rrf")
        expect(res3.reusedCacheCount).toBe(1)
        expect(res3.embeddedDeltaCount).toBe(1)
        expect(snapshot?.entries.map((e) => e.nodeKey)).toEqual([
          "PatternDoc:errors",
          "PatternDoc:planning",
        ])

        // 4. ModelMismatchRebuild when model changes -> reusedCacheCount 0, embeds all items
        const c2 = makeClientLayer({ model: "bge-m3", dimensions: 8, available: true })
        const res4 = yield* syncGraphEmbeddings({
          graph: deltaGraph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: decideEmbeddingSyncPlan,
        }).pipe(Effect.provide(Layer.mergeAll(c2.layer, cacheLayer)))
        expect(res4.mode).toBe("hybrid-rrf")
        expect(res4.reusedCacheCount).toBe(0)
        expect(res4.embeddedDeltaCount).toBe(2)
        expect(snapshot?.model).toBe("bge-m3")
        expect(snapshot?.dimensions).toBe(8)

        // 5. Provider unavailable on dirty delta preserves existing cache snapshot
        const prevSnapshot = snapshot
        const cOffline = makeClientLayer({ model: "bge-m3", dimensions: 8, available: false })
        const dirtyGraph = buildHarnessGraph({
          patternDocs: [
            { slug: "errors", path: "agent-patterns/errors.md", summary: "Errors summary v2" },
          ],
        })
        const res5 = yield* syncGraphEmbeddings({
          graph: dirtyGraph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: decideEmbeddingSyncPlan,
        }).pipe(Effect.provide(Layer.mergeAll(cOffline.layer, cacheLayer)))
        expect(res5.mode).toBe("bm25-only")
        expect(res5.degradedReason).toContain("Ollama offline")
        expect(snapshot).toEqual(prevSnapshot)
      }),
  )
})
