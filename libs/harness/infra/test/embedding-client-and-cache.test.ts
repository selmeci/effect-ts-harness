import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber } from "effect"
import { match } from "ts-pattern"
import {
  EmbeddingBatchTimestamp,
  EmbeddingComponent,
  EmbeddingContentHash,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingProviderBaseUrl,
  EmbeddingProviderError,
  EmbeddingNodeKey,
  EmbeddingSourceText,
  KnowledgeQueryText,
  WorkspaceFilePath,
} from "@harness/contract"
import { EmbeddingCachePort, EmbeddingClient } from "@harness/service"
import { makeFileEmbeddingCacheLayer, makeOllamaEmbeddingClientLayer } from "../src/index.js"

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "harness-embed-infra-"))),
    use,
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true })
      }),
  )

const expectEmbeddingProviderError = (
  exit: Awaited<ReturnType<typeof Effect.runPromiseExit<unknown, EmbeddingProviderError>>>,
  expectedSubstr: string,
): void => {
  match(exit)
    .with({ _tag: "Failure" }, ({ cause }) => {
      match(Cause.findErrorOption(cause))
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value).toBeInstanceOf(EmbeddingProviderError)
          if (value instanceof EmbeddingProviderError) {
            expect(value.reason).toContain(expectedSubstr)
          }
        })
        .with({ _tag: "None" }, () => {
          expect.unreachable(`Expected EmbeddingProviderError containing '${expectedSubstr}'`)
        })
        .exhaustive()
    })
    .with({ _tag: "Success" }, () => {
      expect.unreachable(`Expected Failure with EmbeddingProviderError '${expectedSubstr}'`)
    })
    .exhaustive()
}

describe("OllamaEmbeddingClientLive & FileEmbeddingCacheLive (ADR-0025 / SPEC-0031)", () => {
  it.effect(
    "detects qwen3-embedding:8b via /api/tags, adds Instruct prefix only on embedQuery, and L2-normalizes vectors",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly body?: string | undefined }> = []
        const mockFetch: typeof globalThis.fetch = async (input, init) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          const body = typeof init?.body === "string" ? init.body : undefined
          calls.push({ url, body })
          if (url.endsWith("/api/tags")) {
            return new Response(
              JSON.stringify({
                models: [{ name: "qwen3-embedding:8b", model: "qwen3-embedding:8b" }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          }
          const parsed = body
            ? (JSON.parse(body) as { input: ReadonlyArray<string> })
            : { input: [] }
          return new Response(
            JSON.stringify({
              data: parsed.input.map((_t, idx) => ({
                index: idx,
                embedding: [3, 4, 0, 0],
              })),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }

        const layer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: mockFetch,
        })

        const availability = yield* Effect.flatMap(
          EmbeddingClient,
          (c) => c.checkAvailability,
        ).pipe(Effect.provide(layer))
        expect(availability).toBe("available")

        const batchVecs = yield* Effect.flatMap(EmbeddingClient, (c) =>
          c.embedBatch([EmbeddingSourceText.make("Plain document summary")]),
        ).pipe(Effect.provide(layer))
        expect(batchVecs[0]?.components[0]).toBeCloseTo(0.6, 6)
        expect(batchVecs[0]?.components[1]).toBeCloseTo(0.8, 6)

        const queryVec = yield* Effect.flatMap(EmbeddingClient, (c) =>
          c.embedQuery(KnowledgeQueryText.make("typed errors in Effect")),
        ).pipe(Effect.provide(layer))
        expect(queryVec.components[0]).toBeCloseTo(0.6, 6)

        const batchReqBody = JSON.parse(calls[1]!.body!) as { input: ReadonlyArray<string> }
        const queryReqBody = JSON.parse(calls[2]!.body!) as { input: ReadonlyArray<string> }
        expect(batchReqBody.input[0]).toBe("Plain document summary")
        expect(queryReqBody.input[0]).toContain("Instruct:")
        expect(queryReqBody.input[0]).toContain("Query: typed errors in Effect")
      }),
  )

  it.effect(
    "returns unavailable on missing model/network failure and fails with EmbeddingProviderError on HTTP error, wrong dim, non-finite JSON, or zero norm",
    () =>
      Effect.gen(function* () {
        const missingModelLayer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: async (input) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (url.endsWith("/api/tags")) {
              return new Response(JSON.stringify({ models: [{ name: "clef-flash:latest" }] }), {
                status: 200,
              })
            }
            return new Response("Server failed", { status: 503 })
          },
        })

        const avail = yield* Effect.flatMap(EmbeddingClient, (c) => c.checkAvailability).pipe(
          Effect.provide(missingModelLayer),
        )
        expect(avail).toBe("unavailable")

        const httpExit = yield* Effect.exit(
          Effect.flatMap(EmbeddingClient, (c) =>
            c.embedBatch([EmbeddingSourceText.make("hello")]),
          ).pipe(Effect.provide(missingModelLayer)),
        )
        expectEmbeddingProviderError(httpExit, "503")

        const wrongDimLayer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: async () =>
            new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
              status: 200,
            }),
        })
        const dimExit = yield* Effect.exit(
          Effect.flatMap(EmbeddingClient, (c) =>
            c.embedBatch([EmbeddingSourceText.make("dim")]),
          ).pipe(Effect.provide(wrongDimLayer)),
        )
        expectEmbeddingProviderError(dimExit, "Dimension mismatch")

        const nonFiniteLayer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: async () =>
            new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, null, 0, 0] }] }), {
              status: 200,
            }),
        })
        const nonFiniteExit = yield* Effect.exit(
          Effect.flatMap(EmbeddingClient, (c) =>
            c.embedBatch([EmbeddingSourceText.make("nan")]),
          ).pipe(Effect.provide(nonFiniteLayer)),
        )
        expectEmbeddingProviderError(nonFiniteExit, "Unexpected /v1/embeddings payload")

        const zeroVecLayer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: async () =>
            new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 0, 0, 0] }] }), {
              status: 200,
            }),
        })
        const zeroExit = yield* Effect.exit(
          Effect.flatMap(EmbeddingClient, (c) =>
            c.embedBatch([EmbeddingSourceText.make("zero")]),
          ).pipe(Effect.provide(zeroVecLayer)),
        )
        expectEmbeddingProviderError(zeroExit, "L2 norm")
      }),
  )

  it.effect(
    "FileEmbeddingCacheLive persists atomically, self-heals on corrupt JSON, and refuses symlinks",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const cacheLayer = makeFileEmbeddingCacheLayer({ cacheFilename: "embeddings-v1.json" })
          const repoRoot = WorkspaceFilePath.make(dir)
          const snapshot = {
            schemaVersion: 1 as const,
            model: EmbeddingModelId.make("qwen3-embedding:8b"),
            dimensions: EmbeddingDimensionCount.make(2),
            updatedAt: EmbeddingBatchTimestamp.make("2026-11-22T00:00:00.000Z"),
            entries: [
              {
                nodeKey: EmbeddingNodeKey.make("PatternDoc:errors"),
                nodeKind: "PatternDoc" as const,
                contentHash: EmbeddingContentHash.make("a".repeat(64)),
                dimensions: EmbeddingDimensionCount.make(2),
                vector: { components: [EmbeddingComponent.make(1), EmbeddingComponent.make(0)] },
              },
            ],
          }

          yield* Effect.flatMap(EmbeddingCachePort, (p) => p.writeCache(repoRoot, snapshot)).pipe(
            Effect.provide(cacheLayer),
          )
          const loaded = yield* Effect.flatMap(EmbeddingCachePort, (p) =>
            p.readCache(repoRoot),
          ).pipe(Effect.provide(cacheLayer))
          match(loaded)
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value.entries).toHaveLength(1)
              expect(value.entries[0]?.nodeKey).toBe("PatternDoc:errors")
            })
            .with({ _tag: "None" }, () => {
              expect.unreachable("Expected cached snapshot to load")
            })
            .exhaustive()

          const cacheFile = join(dir, ".harness", "cache", "embeddings-v1.json")
          writeFileSync(cacheFile, "{not-valid-json", "utf8")
          const corruptLoaded = yield* Effect.flatMap(EmbeddingCachePort, (p) =>
            p.readCache(repoRoot),
          ).pipe(Effect.provide(cacheLayer))
          expect(corruptLoaded._tag).toBe("None")

          const targetFile = join(dir, "target.json")
          writeFileSync(targetFile, "untouched", "utf8")
          rmSync(cacheFile)
          symlinkSync(targetFile, cacheFile)

          const symlinkRead = yield* Effect.flatMap(EmbeddingCachePort, (p) =>
            p.readCache(repoRoot),
          ).pipe(Effect.provide(cacheLayer))
          expect(symlinkRead._tag).toBe("None")

          yield* Effect.flatMap(EmbeddingCachePort, (p) => p.writeCache(repoRoot, snapshot)).pipe(
            Effect.provide(cacheLayer),
          )
          expect(readFileSync(targetFile, "utf8")).toBe("untouched")

          const outsideCacheDir = join(dir, "outside-cache")
          mkdirSync(outsideCacheDir, { recursive: true })
          const outsideCacheFile = join(outsideCacheDir, "embeddings-v1.json")
          writeFileSync(outsideCacheFile, JSON.stringify(snapshot), "utf8")
          const cacheDirPath = join(dir, ".harness", "cache")
          rmSync(cacheDirPath, { recursive: true, force: true })
          symlinkSync(outsideCacheDir, cacheDirPath)

          const parentSymlinkRead = yield* Effect.flatMap(EmbeddingCachePort, (p) =>
            p.readCache(repoRoot),
          ).pipe(Effect.provide(cacheLayer))
          expect(parentSymlinkRead._tag).toBe("None")

          writeFileSync(outsideCacheFile, "parent-untouched", "utf8")
          yield* Effect.flatMap(EmbeddingCachePort, (p) => p.writeCache(repoRoot, snapshot)).pipe(
            Effect.provide(cacheLayer),
          )
          expect(readFileSync(outsideCacheFile, "utf8")).toBe("parent-untouched")
        }),
      ),
  )

  it.effect(
    "enforces loopback SSRF protections, redirect=error, transport/count failures, models[].model match, and fiber interruption",
    () =>
      Effect.gen(function* () {
        let fetchCalled = false
        for (const badUrl of [
          "http://169.254.169.254/v1",
          "http://user:pass@127.0.0.1:11434/v1",
          "not-a-valid-url",
        ]) {
          const badLayer = makeOllamaEmbeddingClientLayer({
            baseUrl: EmbeddingProviderBaseUrl.make(badUrl),
            model: EmbeddingModelId.make("qwen3-embedding:8b"),
            dimensions: EmbeddingDimensionCount.make(4),
            fetch: async () => {
              fetchCalled = true
              return new Response("unexpected", { status: 200 })
            },
          })
          const avail = yield* Effect.flatMap(EmbeddingClient, (c) => c.checkAvailability).pipe(
            Effect.provide(badLayer),
          )
          expect(avail).toBe("unavailable")
          const errExit = yield* Effect.exit(
            Effect.flatMap(EmbeddingClient, (c) =>
              c.embedBatch([EmbeddingSourceText.make("ssrf")]),
            ).pipe(Effect.provide(badLayer)),
          )
          expectEmbeddingProviderError(errExit, "")
          expect(fetchCalled).toBe(false)
        }

        let observedRedirect: string | undefined
        const modelOnlyFieldLayer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: async (_input, init) => {
            observedRedirect = init?.redirect
            return new Response(
              JSON.stringify({
                models: [{ name: "alias-name", model: "qwen3-embedding:8b:latest" }],
              }),
              { status: 200 },
            )
          },
        })
        const availModelField = yield* Effect.flatMap(
          EmbeddingClient,
          (c) => c.checkAvailability,
        ).pipe(Effect.provide(modelOnlyFieldLayer))
        expect(availModelField).toBe("available")
        expect(observedRedirect).toBe("error")

        const rejectLayer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: async () => Promise.reject(new Error("ECONNREFUSED")),
        })
        const rejectExit = yield* Effect.exit(
          Effect.flatMap(EmbeddingClient, (c) =>
            c.embedBatch([EmbeddingSourceText.make("net-err")]),
          ).pipe(Effect.provide(rejectLayer)),
        )
        expectEmbeddingProviderError(rejectExit, "ECONNREFUSED")

        const invalidJsonLayer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: async () => new Response("{bad-json", { status: 200 }),
        })
        const jsonExit = yield* Effect.exit(
          Effect.flatMap(EmbeddingClient, (c) =>
            c.embedBatch([EmbeddingSourceText.make("bad-json")]),
          ).pipe(Effect.provide(invalidJsonLayer)),
        )
        expectEmbeddingProviderError(jsonExit, "Invalid JSON")

        const countMismatchLayer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: async () =>
            new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }), {
              status: 200,
            }),
        })
        const countExit = yield* Effect.exit(
          Effect.flatMap(EmbeddingClient, (c) =>
            c.embedBatch([EmbeddingSourceText.make("first"), EmbeddingSourceText.make("second")]),
          ).pipe(Effect.provide(countMismatchLayer)),
        )
        expectEmbeddingProviderError(countExit, "Expected 2 embeddings")

        let abortedBySignal = false
        const interruptLayer = makeOllamaEmbeddingClientLayer({
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(4),
          fetch: async (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                abortedBySignal = true
                reject(new Error("aborted"))
              })
            }),
        })
        const fiber = yield* Effect.forkChild(
          Effect.flatMap(EmbeddingClient, (c) =>
            c.embedBatch([EmbeddingSourceText.make("hang")]),
          ).pipe(Effect.provide(interruptLayer)),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        expect(abortedBySignal).toBe(true)
      }),
  )
})
