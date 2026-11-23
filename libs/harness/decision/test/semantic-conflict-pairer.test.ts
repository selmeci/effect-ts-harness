import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ConflictPairLimit,
  DocLineNumber,
  DocTreePath,
  EarsAreaName,
  EarsClauseText,
  EarsEffectSymbol,
  EarsPatternName,
  EarsRequirementNodeId,
  EarsVerificationKind,
  EmbeddingBatchTimestamp,
  EmbeddingComponent,
  EmbeddingContentHash,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingNodeKey,
  EmbeddingProviderBaseUrl,
  ErrorReasonMessage,
  GovernanceDocIdentifier,
  type RequirementEmbeddingItem,
  RequirementId,
  SimilarityScore,
  WorkspaceFilePath,
} from "@harness/contract"
import { buildHarnessGraph } from "@harness/graph"
import { EmbeddingCachePort, EmbeddingClient } from "@harness/service"
import {
  collectSemanticConflictCandidates,
  decideSemanticConflictPairs,
} from "../src/semantic-conflict-pairer.js"

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

const presetToComponents = (preset: typeof UnitVectorPreset.Type) =>
  match(preset)
    .with("high-1", () => toUnit(1, 0, 0))
    .with("high-2", () => toUnit(0.995, 0.0998, 0))
    .with("medium", () => toUnit(0.7, 0.7141, 0))
    .with("orthogonal", () => toUnit(0, 0, 1))
    .exhaustive()

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

  it.effect(
    "collectSemanticConflictCandidates fast-paths <2 specs, pairs & deduplicates high-similarity requirements, and fails closed on degraded sync",
    () =>
      Effect.gen(function* () {
        const makeReqNode = (
          specId: string,
          reqId: string,
          clauseText: string,
          effectSymbol: string,
        ) => ({
          id: EarsRequirementNodeId.make(`${specId}::${reqId}`),
          specId: GovernanceDocIdentifier.make(specId),
          requirementId: RequirementId.make(reqId),
          area: EarsAreaName.make("Core"),
          pattern: EarsPatternName.make("Event-driven"),
          clauseText: EarsClauseText.make(clauseText),
          effectSymbol: EarsEffectSymbol.make(effectSymbol),
          verification: EarsVerificationKind.make("UnitTest"),
          path: DocTreePath.make(`docs/${specId}.md`),
          line: DocLineNumber.make(10),
          status: "accepted" as const,
        })

        let clientCalls = 0
        const model = EmbeddingModelId.make("qwen3-embedding:8b")
        const dims = EmbeddingDimensionCount.make(3)

        const availableClientLayer = Layer.succeed(
          EmbeddingClient,
          EmbeddingClient.of({
            config: {
              baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
              model,
              dimensions: dims,
            },
            checkAvailability: Effect.succeed({ _tag: "Available" as const }),
            embedBatch: (texts) =>
              Effect.sync(() => {
                clientCalls++
                return texts.map((t) => ({
                  components: t.includes("contradicting")
                    ? toUnit(0.99, 0.141, 0)
                    : toUnit(1, 0, 0),
                }))
              }),
            embedQuery: () => Effect.succeed({ components: toUnit(1, 0, 0) }),
          }),
        )

        const emptyCacheLayer = Layer.succeed(
          EmbeddingCachePort,
          EmbeddingCachePort.of({
            readCache: () => Effect.succeedNone,
            writeCache: () => Effect.void,
          }),
        )

        // 1. Fast-path when <2 active specs exist
        const singleSpecGraph = buildHarnessGraph({
          earsRequirements: [
            makeReqNode("spec-a", "REQ-1.1", "When submitted, reject order.", "Order.a"),
          ],
        })
        const fastRes = yield* collectSemanticConflictCandidates({
          repoRoot: WorkspaceFilePath.make("/repo"),
          graph: singleSpecGraph,
          docs: [
            {
              id: "spec-a",
              status: "accepted",
              docPath: "docs/spec-a.md",
            },
          ],
          existingPairs: [],
        }).pipe(Effect.provide(Layer.mergeAll(availableClientLayer, emptyCacheLayer)))
        expect(fastRes).toEqual({ pairs: [], degraded: false, degradedReason: null })
        expect(clientCalls).toBe(0)

        // 2. Cross-spec semantic pairing + dedup against existingPairs
        const crossSpecGraph = buildHarnessGraph({
          earsRequirements: [
            makeReqNode("spec-a", "REQ-1.1", "When submitted, reject order.", "Order.a"),
            makeReqNode(
              "spec-b",
              "REQ-2.1",
              "When submitted, contradicting accept order.",
              "Order.b",
            ),
            makeReqNode("spec-c", "REQ-3.1", "When submitted, also accept order.", "Order.c"),
          ],
        })
        const docs = [
          {
            id: "spec-a",
            status: "accepted" as const,
            docPath: "docs/spec-a.md",
          },
          {
            id: "spec-b",
            status: "accepted" as const,
            docPath: "docs/spec-b.md",
          },
          {
            id: "spec-c",
            status: "accepted" as const,
            docPath: "docs/spec-c.md",
          },
        ]

        const pairedRes = yield* collectSemanticConflictCandidates({
          repoRoot: WorkspaceFilePath.make("/repo"),
          graph: crossSpecGraph,
          docs,
          existingPairs: [
            {
              sourceId: "spec-c#REQ-3.1",
              sourceText: "dup",
              targetId: "spec-a#REQ-1.1",
              targetText: "dup",
              sharedSymbol: "Order.shared",
            },
          ],
        }).pipe(Effect.provide(Layer.mergeAll(availableClientLayer, emptyCacheLayer)))
        expect(pairedRes.degraded).toBe(false)
        expect(pairedRes.degradedReason).toBeNull()
        const pairKeys = pairedRes.pairs.map((p) => `${p.sourceId}<->${p.targetId}`)
        expect(pairKeys).toContain("spec-a#REQ-1.1<->spec-b#REQ-2.1")
        expect(pairKeys).not.toContain("spec-a#REQ-1.1<->spec-c#REQ-3.1")

        // 3. Fail closed (degraded: true) when provider is unavailable on >=2 active specs
        const offlineLayer = Layer.succeed(
          EmbeddingClient,
          EmbeddingClient.of({
            config: {
              baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
              model,
              dimensions: dims,
            },
            checkAvailability: Effect.succeed({
              _tag: "Unavailable" as const,
              cause: "network-error" as const,
              reason: ErrorReasonMessage.make("Ollama offline"),
            }),
            embedBatch: () => Effect.die("Should not run"),
            embedQuery: () => Effect.die("Should not run"),
          }),
        )
        const degradedRes = yield* collectSemanticConflictCandidates({
          repoRoot: WorkspaceFilePath.make("/repo"),
          graph: crossSpecGraph,
          docs,
          existingPairs: [],
        }).pipe(Effect.provide(Layer.mergeAll(offlineLayer, emptyCacheLayer)))
        expect(degradedRes.pairs).toEqual([])
        expect(degradedRes.degraded).toBe(true)
        expect(degradedRes.degradedReason).toContain("Ollama offline")

        // 4. Fail closed (degraded: true) when cache returns partial/empty vector map for active req
        const incompleteCacheLayer = Layer.succeed(
          EmbeddingCachePort,
          EmbeddingCachePort.of({
            readCache: () =>
              Effect.succeedSome({
                schemaVersion: 1 as const,
                model,
                dimensions: dims,
                updatedAt: EmbeddingBatchTimestamp.make("2026-11-22T00:00:00.000Z"),
                entries: [
                  {
                    nodeKey: EmbeddingNodeKey.make("EarsRequirement:spec-a::REQ-1.1"),
                    nodeKind: "EarsRequirement" as const,
                    contentHash: EmbeddingContentHash.make("0".repeat(64)),
                    dimensions: dims,
                    vector: { components: toUnit(1, 0, 0) },
                  },
                ],
              }),
            writeCache: () => Effect.void,
          }),
        )
        const missingVecRes = yield* collectSemanticConflictCandidates({
          repoRoot: WorkspaceFilePath.make("/repo"),
          graph: crossSpecGraph,
          docs,
          existingPairs: [],
        }).pipe(Effect.provide(Layer.mergeAll(offlineLayer, incompleteCacheLayer)))
        expect(missingVecRes.degraded).toBe(true)
        expect(missingVecRes.pairs).toEqual([])
      }),
  )
})
