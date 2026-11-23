import { createHash } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { match } from "ts-pattern"
import {
  EmbeddingBatchTimestamp,
  EmbeddingComponent,
  EmbeddingContentHash,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingNodeKey,
  EmbeddingProviderBaseUrl,
  EmbeddingProviderError,
  EmbeddingSourceText,
  type EmbeddingCacheSnapshot,
  ErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
import { EmbeddingCachePort, EmbeddingClient } from "@harness/service"
import { buildHarnessGraph, embedGraphDelta, syncGraphEmbeddings } from "../src/index.js"

const DIMS = 4
const MODEL = EmbeddingModelId.make("qwen3-embedding:8b")

const makeTestDecision = (input: {
  readonly items: ReadonlyArray<{
    readonly nodeKey: EmbeddingNodeKey
    readonly contentHash: EmbeddingContentHash
  }>
  readonly cachedSnapshot: EmbeddingCacheSnapshot | null
}) => {
  if (input.cachedSnapshot === null) {
    return Effect.succeed({
      _tag: "ModelMismatchRebuild" as const,
      reason: ErrorReasonMessage.make("No cached snapshot"),
      embedKeys: input.items.map((i) => i.nodeKey),
      evictedKeys: [],
    })
  }
  const byKey = new Map(input.cachedSnapshot.entries.map((e) => [e.nodeKey, e.contentHash]))
  const currentKeys = new Set(input.items.map((i) => i.nodeKey))
  const embedKeys = input.items
    .filter((i) => byKey.get(i.nodeKey) !== i.contentHash)
    .map((i) => i.nodeKey)
  const reusedKeys = input.items
    .filter((i) => byKey.get(i.nodeKey) === i.contentHash)
    .map((i) => i.nodeKey)
  const evictedKeys = input.cachedSnapshot.entries
    .filter((e) => !currentKeys.has(e.nodeKey))
    .map((e) => e.nodeKey)
  if (embedKeys.length === 0 && evictedKeys.length === 0) {
    return Effect.succeed({ _tag: "CacheHitAll" as const, reusedKeys })
  }
  return Effect.succeed({
    _tag: "EmbedDelta" as const,
    embedKeys,
    reusedKeys,
    evictedKeys,
  })
}

const makeInMemoryCacheLayer = (
  initial?: EmbeddingCacheSnapshot,
): {
  readonly layer: Layer.Layer<EmbeddingCachePort>
  readonly getSnapshot: () => EmbeddingCacheSnapshot | undefined
} => {
  let current = initial
  const layer = Layer.succeed(
    EmbeddingCachePort,
    EmbeddingCachePort.of({
      readCache: () => Effect.succeed(current === undefined ? Option.none() : Option.some(current)),
      writeCache: (_root, snapshot) =>
        Effect.sync(() => {
          current = snapshot
        }),
    }),
  )
  return { layer, getSnapshot: () => current }
}

const makeUnitVec = (base: number) => [
  EmbeddingComponent.make(base),
  EmbeddingComponent.make(base),
  EmbeddingComponent.make(base),
  EmbeddingComponent.make(base),
]

describe("GraphEmbeddings delta embed & graceful bm25-only degradation (SPEC-0031)", () => {
  it.effect("chunks batches > 16 and L2-normalizes vectors in embedDelta", () =>
    Effect.gen(function* () {
      const batchLengths: Array<number> = []
      const clientLayer = Layer.succeed(
        EmbeddingClient,
        EmbeddingClient.of({
          config: {
            baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
            model: MODEL,
            dimensions: EmbeddingDimensionCount.make(DIMS),
          },
          checkAvailability: Effect.succeed("available" as const),
          embedBatch: (texts) =>
            Effect.sync(() => {
              batchLengths.push(texts.length)
              return texts.map(() => ({
                components: makeUnitVec(2),
              }))
            }),
          embedQuery: () => Effect.succeed({ components: makeUnitVec(0.5) }),
        }),
      )

      const inputs = Array.from({ length: 19 }, (_, idx) =>
        EmbeddingSourceText.make(`Document passage ${idx}`),
      )
      const vectors = yield* embedGraphDelta(inputs).pipe(Effect.provide(clientLayer))

      expect(batchLengths).toEqual([16, 3])
      expect(vectors).toHaveLength(19)
      for (const comp of vectors[0]!.components) {
        expect(comp).toBeCloseTo(0.5, 6)
      }
    }),
  )

  it.effect(
    "fails embedDelta with typed EmbeddingProviderError on dimension mismatch or non-finite component",
    () =>
      Effect.gen(function* () {
        const badDimLayer = Layer.succeed(
          EmbeddingClient,
          EmbeddingClient.of({
            config: {
              baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
              model: MODEL,
              dimensions: EmbeddingDimensionCount.make(DIMS),
            },
            checkAvailability: Effect.succeed("available" as const),
            embedBatch: () =>
              Effect.succeed([
                { components: [EmbeddingComponent.make(1), EmbeddingComponent.make(0)] },
              ]),
            embedQuery: () => Effect.succeed({ components: makeUnitVec(0.5) }),
          }),
        )

        const exit = yield* Effect.exit(
          embedGraphDelta([EmbeddingSourceText.make("test")]).pipe(Effect.provide(badDimLayer)),
        )
        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(EmbeddingProviderError)
                expect(value.reason).toContain("Expected 4 vector dimensions")
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected EmbeddingProviderError")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected dimension mismatch failure")
          })
          .exhaustive()

        const zeroNormLayer = Layer.succeed(
          EmbeddingClient,
          EmbeddingClient.of({
            config: {
              baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
              model: MODEL,
              dimensions: EmbeddingDimensionCount.make(DIMS),
            },
            checkAvailability: Effect.succeed("available" as const),
            embedBatch: () =>
              Effect.succeed([
                {
                  components: [
                    EmbeddingComponent.make(0),
                    EmbeddingComponent.make(0),
                    EmbeddingComponent.make(0),
                    EmbeddingComponent.make(0),
                  ],
                },
              ]),
            embedQuery: () => Effect.succeed({ components: makeUnitVec(0.5) }),
          }),
        )

        const secondExit = yield* Effect.exit(
          embedGraphDelta([EmbeddingSourceText.make("zero")]).pipe(Effect.provide(zeroNormLayer)),
        )
        match(secondExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(EmbeddingProviderError)
                expect(value.reason).toContain("L2 norm")
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected zero-norm EmbeddingProviderError")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected zero-norm failure")
          })
          .exhaustive()

        const nonFiniteLayer = Layer.succeed(
          EmbeddingClient,
          EmbeddingClient.of({
            config: {
              baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
              model: MODEL,
              dimensions: EmbeddingDimensionCount.make(DIMS),
            },
            checkAvailability: Effect.succeed("available" as const),
            embedBatch: () =>
              Effect.succeed([
                {
                  components: [
                    EmbeddingComponent.make(1),
                    EmbeddingComponent.make(Number.NaN, { disableChecks: true }),
                    EmbeddingComponent.make(0),
                    EmbeddingComponent.make(0),
                  ],
                },
              ]),
            embedQuery: () => Effect.succeed({ components: makeUnitVec(0.5) }),
          }),
        )
        const nonFiniteExit = yield* Effect.exit(
          embedGraphDelta([EmbeddingSourceText.make("nan")]).pipe(Effect.provide(nonFiniteLayer)),
        )
        match(nonFiniteExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(EmbeddingProviderError)
                expect(value.reason).toContain("non-finite component")
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected non-finite EmbeddingProviderError")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected non-finite failure")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "sync invokes 0 embedBatch calls on CacheHitAll and embeds only dirty items (including EarsRequirement) using TestClock timestamps",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_732_233_600_000)
        const graph = buildHarnessGraph({
          patternDocs: [
            {
              slug: "errors",
              path: "agent-patterns/errors.md",
              summary: "Typed errors summary",
            },
          ],
          adrDocs: [
            {
              id: "harness:ADR-0025",
              title: "Three-Tier Retrieval",
              status: "accepted",
              path: "libs/harness/docs/adr/0025.md",
              enforcedByFiles: [],
              searchText: "Three-Tier Retrieval Context",
            },
          ],
          earsRequirements: [
            {
              id: "harness:SPEC-0031::REQ-1.1",
              specId: "harness:SPEC-0031",
              requirementId: "REQ-1.1",
              area: "Retrieval",
              pattern: "Event-driven",
              clauseText: "When searching knowledge, system embeds EarsRequirement clauses.",
              effectSymbol: "GraphEmbeddings.sync",
              verification: "UnitTest",
              path: "libs/harness/docs/specs/0031.md",
              line: 20,
              status: "accepted",
            },
          ],
        })

        let embedCallCount = 0
        let lastEmbeddedTexts: ReadonlyArray<string> = []
        const clientLayer = Layer.succeed(
          EmbeddingClient,
          EmbeddingClient.of({
            config: {
              baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
              model: MODEL,
              dimensions: EmbeddingDimensionCount.make(DIMS),
            },
            checkAvailability: Effect.succeed("available" as const),
            embedBatch: (texts) =>
              Effect.sync(() => {
                embedCallCount++
                lastEmbeddedTexts = texts
                return texts.map(() => ({ components: makeUnitVec(1) }))
              }),
            embedQuery: () => Effect.succeed({ components: makeUnitVec(0.5) }),
          }),
        )

        const cache = makeInMemoryCacheLayer()
        const firstRun = yield* syncGraphEmbeddings({
          graph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: makeTestDecision,
        }).pipe(Effect.provide(Layer.mergeAll(clientLayer, cache.layer)))

        expect(firstRun.mode).toBe("hybrid-rrf")
        expect(firstRun.embeddedDeltaCount).toBe(3)
        expect(firstRun.reusedCacheCount).toBe(0)
        expect(firstRun.degradedReason).toBeNull()
        expect(embedCallCount).toBe(1)
        expect(cache.getSnapshot()?.entries).toHaveLength(3)
        expect(cache.getSnapshot()?.updatedAt).toBe("2024-11-22T00:00:00.000Z")

        const secondRun = yield* syncGraphEmbeddings({
          graph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: makeTestDecision,
        }).pipe(Effect.provide(Layer.mergeAll(clientLayer, cache.layer)))

        expect(secondRun.mode).toBe("hybrid-rrf")
        expect(secondRun.totalItems).toBe(3)
        expect(secondRun.embeddedDeltaCount).toBe(0)
        expect(secondRun.reusedCacheCount).toBe(3)
        expect(embedCallCount).toBe(1)

        yield* TestClock.adjust("5000 millis")
        const dirtyGraph = buildHarnessGraph({
          patternDocs: [
            {
              slug: "errors",
              path: "agent-patterns/errors.md",
              summary: "Updated typed errors summary",
            },
          ],
          adrDocs: [
            {
              id: "harness:ADR-0025",
              title: "Three-Tier Retrieval",
              status: "accepted",
              path: "libs/harness/docs/adr/0025.md",
              enforcedByFiles: [],
              searchText: "Three-Tier Retrieval Context",
            },
          ],
          earsRequirements: [
            {
              id: "harness:SPEC-0031::REQ-1.1",
              specId: "harness:SPEC-0031",
              requirementId: "REQ-1.1",
              area: "Retrieval",
              pattern: "Event-driven",
              clauseText: "When searching knowledge, system embeds EarsRequirement clauses.",
              effectSymbol: "GraphEmbeddings.sync",
              verification: "UnitTest",
              path: "libs/harness/docs/specs/0031.md",
              line: 20,
              status: "accepted",
            },
          ],
        })

        const thirdRun = yield* syncGraphEmbeddings({
          graph: dirtyGraph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: makeTestDecision,
        }).pipe(Effect.provide(Layer.mergeAll(clientLayer, cache.layer)))

        expect(thirdRun.mode).toBe("hybrid-rrf")
        expect(thirdRun.embeddedDeltaCount).toBe(1)
        expect(thirdRun.reusedCacheCount).toBe(2)
        expect(embedCallCount).toBe(2)
        expect(lastEmbeddedTexts).toEqual(["Updated typed errors summary"])
        expect(cache.getSnapshot()?.updatedAt).toBe("2024-11-22T00:00:05.000Z")

        yield* TestClock.adjust("5000 millis")
        const prunedGraph = buildHarnessGraph({
          patternDocs: [
            {
              slug: "errors",
              path: "agent-patterns/errors.md",
              summary: "Updated typed errors summary",
            },
          ],
          earsRequirements: [
            {
              id: "harness:SPEC-0031::REQ-1.1",
              specId: "harness:SPEC-0031",
              requirementId: "REQ-1.1",
              area: "Retrieval",
              pattern: "Event-driven",
              clauseText: "When searching knowledge, system embeds EarsRequirement clauses.",
              effectSymbol: "GraphEmbeddings.sync",
              verification: "UnitTest",
              path: "libs/harness/docs/specs/0031.md",
              line: 20,
              status: "accepted",
            },
          ],
        })
        const fourthRun = yield* syncGraphEmbeddings({
          graph: prunedGraph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: makeTestDecision,
        }).pipe(Effect.provide(Layer.mergeAll(clientLayer, cache.layer)))

        expect(fourthRun.mode).toBe("hybrid-rrf")
        expect(fourthRun.totalItems).toBe(2)
        expect(fourthRun.embeddedDeltaCount).toBe(0)
        expect(fourthRun.reusedCacheCount).toBe(2)
        expect(embedCallCount).toBe(2)
        expect(cache.getSnapshot()?.entries).toHaveLength(2)
      }),
  )

  it.effect(
    "degrades cleanly to bm25-only with explicit reason and zero mock vectors when Ollama is unavailable or errors",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          patternDocs: [
            {
              slug: "errors",
              path: "agent-patterns/errors.md",
              summary: "Typed errors summary",
            },
          ],
        })

        const unavailableLayer = Layer.succeed(
          EmbeddingClient,
          EmbeddingClient.of({
            config: {
              baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:1/v1"),
              model: MODEL,
              dimensions: EmbeddingDimensionCount.make(DIMS),
            },
            checkAvailability: Effect.succeed("unavailable" as const),
            embedBatch: () => Effect.die(new Error("Should not call embedBatch when unavailable")),
            embedQuery: () => Effect.die(new Error("Should not call embedQuery")),
          }),
        )
        const cache = makeInMemoryCacheLayer({
          schemaVersion: 1,
          model: MODEL,
          dimensions: EmbeddingDimensionCount.make(DIMS),
          updatedAt: EmbeddingBatchTimestamp.make("2026-11-22T00:00:00.000Z"),
          entries: [
            {
              nodeKey: EmbeddingNodeKey.make("PatternDoc:stale-unrelated"),
              nodeKind: "PatternDoc",
              contentHash: EmbeddingContentHash.make(
                createHash("sha256").update("old", "utf8").digest("hex"),
              ),
              dimensions: EmbeddingDimensionCount.make(DIMS),
              vector: { components: makeUnitVec(0.5) },
            },
          ],
        })

        const outcome = yield* syncGraphEmbeddings({
          graph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: makeTestDecision,
        }).pipe(Effect.provide(Layer.mergeAll(unavailableLayer, cache.layer)))

        expect(outcome.mode).toBe("bm25-only")
        expect(outcome.embeddedDeltaCount).toBe(0)
        expect(outcome.degradedReason).toContain("unavailable")
        expect(outcome.vectorsByNodeKey.has(EmbeddingNodeKey.make("PatternDoc:errors"))).toBe(false)

        const failingClientLayer = Layer.succeed(
          EmbeddingClient,
          EmbeddingClient.of({
            config: {
              baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
              model: MODEL,
              dimensions: EmbeddingDimensionCount.make(DIMS),
            },
            checkAvailability: Effect.succeed("available" as const),
            embedBatch: () =>
              Effect.fail(
                new EmbeddingProviderError({
                  model: MODEL,
                  reason: ErrorReasonMessage.make("Connection reset by Ollama"),
                }),
              ),
            embedQuery: () =>
              Effect.fail(
                new EmbeddingProviderError({
                  model: MODEL,
                  reason: ErrorReasonMessage.make("Connection reset by Ollama"),
                }),
              ),
          }),
        )

        const errOutcome = yield* syncGraphEmbeddings({
          graph,
          repoRoot: WorkspaceFilePath.make("/repo"),
          decidePlan: makeTestDecision,
        }).pipe(Effect.provide(Layer.mergeAll(failingClientLayer, cache.layer)))

        expect(errOutcome.mode).toBe("bm25-only")
        expect(errOutcome.embeddedDeltaCount).toBe(0)
        expect(errOutcome.degradedReason).toContain("Connection reset by Ollama")
        expect(errOutcome.vectorsByNodeKey.has(EmbeddingNodeKey.make("PatternDoc:errors"))).toBe(
          false,
        )
      }),
  )
})
