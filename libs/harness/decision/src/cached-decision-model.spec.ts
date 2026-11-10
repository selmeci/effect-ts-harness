import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import * as AiError from "effect/ai/AiError"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  CachedDecisionLookupInput,
  CachedDecisionLookupResult,
  CachedDecisionModel,
  CanonicalInputJson,
  canonicalJson,
  clearGlobalDecisionCache,
  computeDecisionCacheKey,
  decideCachedDecisionLookup,
  DecisionCacheHitStatus,
  DecisionCacheKey,
  DecisionPromptVersion,
  DecisionTaskId,
  evaluateBatchCachedDecisions,
  HARNESS_DECISION_PROMPT_VERSION,
  IdiomRouterV1,
  makeCachedDecisionModelLayer,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
  resolveDecisionCachePath,
  routeStep,
  wrapDecisionModelLayer,
} from "./index.js"

const CompositeLookupInputsArb = Schema.Array(CachedDecisionLookupInput)

const makeCountingDecisionModelLayer = (counter: { count: number }, yieldTicks: number = 0) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: (options) =>
        Effect.gen(function* () {
          counter.count += 1
          for (let i = 0; i < yieldTicks; i += 1) {
            yield* Effect.yieldNow
          }
          const answers: Record<string, DecisionModel.ProviderAnswer> = {}
          for (const [key, decision] of Object.entries(options.decisions)) {
            if (decision._tag === "Probability") {
              answers[key] = { _tag: "Probability", probability: 0.9 }
            } else if (decision._tag === "Classify") {
              const labels = Object.keys(decision.criteria)
              const chosenLabel = labels.includes("schema") ? "schema" : (labels[0] ?? "effect")
              const probabilities: Record<string, number> = {}
              for (const l of labels) {
                probabilities[l] = l === chosenLabel ? 1 : 0
              }
              answers[key] = { _tag: "Classify", label: chosenLabel, probabilities }
            }
          }
          return {
            answers,
            usage: { inputTokens: 12, outputTokens: 4 },
            metadata: {},
          }
        }),
    }),
  )

describe("CachedDecisionModel — Content-Addressable Caching & Request Coalescing (PERF-03, RFC-0006)", () => {
  it.effect(
    "produces identical cache keys regardless of object key order and hits cache without re-invoking underlying model",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-decision-cache-"))
        const cacheFile = join(tmpDir, "decisions-v1.json")
        clearGlobalDecisionCache()

        const key1 = computeDecisionCacheKey({
          taskId: "route",
          input: { b: 2, a: 1, nested: { y: "two", x: "one" } },
        })
        const key2 = computeDecisionCacheKey({
          taskId: "route",
          input: { a: 1, nested: { x: "one", y: "two" }, b: 2 },
        })
        expect(key1).toBe(key2)
        expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')

        const keyDifferentVersion = computeDecisionCacheKey({
          taskId: "route",
          promptVersion: "decisions-v2",
          input: { a: 1, b: 2, nested: { x: "one", y: "two" } },
        })
        expect(keyDifferentVersion).not.toBe(key1)

        const counter = { count: 0 }
        const baseLayer = makeCountingDecisionModelLayer(counter)
        const cachedLayer = wrapDecisionModelLayer(baseLayer, {
          cacheFilePath: cacheFile,
          promptVersion: HARNESS_DECISION_PROMPT_VERSION,
        })

        // First call -> cache miss (1 underlying call)
        const r1 = yield* routeStep("Validate customer checkout payload").pipe(
          Effect.provide(cachedLayer),
        )
        expect(r1).toBe("schema")
        expect(counter.count).toBe(1)
        expect(existsSync(cacheFile)).toBe(true)

        // Second identical call -> cache hit (still 1 underlying call)
        const r2 = yield* routeStep("Validate customer checkout payload").pipe(
          Effect.provide(cachedLayer),
        )
        expect(r2).toBe("schema")
        expect(counter.count).toBe(1)

        // Different input -> cache miss (2 underlying calls)
        const r3 = yield* routeStep("Coordinate inventory reservation workflow").pipe(
          Effect.provide(cachedLayer),
        )
        expect(r3).toBe("schema")
        expect(counter.count).toBe(2)

        // Changed promptVersion -> cache miss (3 underlying calls)
        const v2Layer = wrapDecisionModelLayer(baseLayer, {
          cacheFilePath: cacheFile,
          promptVersion: "decisions-v2",
        })
        const r4 = yield* routeStep("Validate customer checkout payload").pipe(
          Effect.provide(v2Layer),
        )
        expect(r4).toBe("schema")
        expect(counter.count).toBe(3)

        // Fresh layer reading persisted disk cache -> 0 new underlying calls
        const diskBackedLayer = Layer.provide(
          makeCachedDecisionModelLayer({
            cacheFilePath: cacheFile,
            promptVersion: "decisions-v2",
          }),
          baseLayer,
        )
        const r5 = yield* routeStep("Validate customer checkout payload").pipe(
          Effect.provide(diskBackedLayer),
        )
        expect(r5).toBe("schema")
        expect(counter.count).toBe(3)

        expect(resolveDecisionCachePath(tmpDir)).toContain("decisions-v1.json")
        expect(DecisionTaskId.make("route")).toBe("route")
        expect(DecisionPromptVersion.make("decisions-v1")).toBe("decisions-v1")
        expect(DecisionCacheKey.make(key1)).toBe(key1)
        expect(DecisionCacheHitStatus.make("hit")).toBe("hit")
        expect(CanonicalInputJson.make("{}")).toBe("{}")
        expect(CachedDecisionLookupResult.fields).toBeDefined()

        rmSync(tmpDir, { recursive: true, force: true })
      }),
  )

  it.effect(
    "coalesces concurrent identical requests into a single underlying DecisionModel invocation",
    () =>
      Effect.gen(function* () {
        clearGlobalDecisionCache()
        const counter = { count: 0 }
        const slowBaseLayer = makeCountingDecisionModelLayer(counter, 4)
        const wrappedLayer = CachedDecisionModel.wrapLayer(slowBaseLayer, {
          promptVersion: "coalesce-test-v1",
        })

        const results = yield* evaluateBatchCachedDecisions([
          routeStep("Concurrent coalesced step"),
          routeStep("Concurrent coalesced step"),
          routeStep("Concurrent coalesced step"),
          routeStep("Concurrent coalesced step"),
        ]).pipe(Effect.provide(wrappedLayer))

        expect(results).toHaveLength(4)
        expect(counter.count).toBe(1)
      }),
  )

  it.effect.prop(
    "property: CachedDecisionModel.decide deterministically computes cache keys and transitions from miss to hit",
    [CompositeLookupInputsArb],
    ([inputs]) =>
      Effect.gen(function* () {
        clearGlobalDecisionCache()
        const sample = inputs[0] ?? {
          taskId: DecisionTaskId.make("route"),
          promptVersion: HARNESS_DECISION_PROMPT_VERSION,
          canonicalInputJson: CanonicalInputJson.make("{}"),
        }
        const mockLayer = makeMockDecisionModelLayer()
        const first = yield* CachedDecisionModel.decide(sample).pipe(Effect.provide(mockLayer))
        const second = yield* decideCachedDecisionLookup(sample).pipe(Effect.provide(mockLayer))

        expect(first.cacheKey).toBe(second.cacheKey)
        expect(first.cacheStatus).toBe("miss")
        expect(second.cacheStatus).toBe("hit")
      }),
  )

  it.effect(
    "does not cache failures in decideCachedDecisionLookup or makeCachedDecisionModelLayer",
    () =>
      Effect.gen(function* () {
        clearGlobalDecisionCache()
        const sample = {
          taskId: DecisionTaskId.make("test-failure-caching"),
          promptVersion: HARNESS_DECISION_PROMPT_VERSION,
          canonicalInputJson: CanonicalInputJson.make('{"input":"test"}'),
        }

        // 1. decideCachedDecisionLookup with failing layer does not cache failure
        const failingLayer = makeFailingDecisionModelLayer("Network timeout")
        const miss1 = yield* decideCachedDecisionLookup(sample).pipe(Effect.provide(failingLayer))
        expect(miss1.cacheStatus).toBe("miss")

        // Next call with mock layer should STILL be a miss (because failure was not cached)
        const mockLayer = makeMockDecisionModelLayer()
        const miss2 = yield* decideCachedDecisionLookup(sample).pipe(Effect.provide(mockLayer))
        expect(miss2.cacheStatus).toBe("miss")

        // Now that mockLayer succeeded, it should be cached as a hit
        const hit = yield* decideCachedDecisionLookup(sample).pipe(Effect.provide(mockLayer))
        expect(hit.cacheStatus).toBe("hit")

        // 2. makeCachedDecisionModelLayer with dynamic failing/succeeding model
        let fails = true
        const counter = { count: 0 }
        const dynamicLayer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: (options) =>
              Effect.gen(function* () {
                if (fails) {
                  return yield* AiError.make({
                    module: "DecisionModel",
                    method: "decide",
                    reason: new AiError.UnknownError({ description: "Model down" }),
                  })
                }
                counter.count += 1
                const answers: Record<string, DecisionModel.ProviderAnswer> = {}
                for (const [key, decision] of Object.entries(options.decisions)) {
                  if (decision._tag === "Probability") {
                    answers[key] = { _tag: "Probability", probability: 0.95 }
                  } else if (decision._tag === "Classify") {
                    const labels = Object.keys(decision.criteria)
                    const chosenLabel = labels.includes("schema")
                      ? "schema"
                      : (labels[0] ?? "effect")
                    const probabilities: Record<string, number> = {}
                    for (const l of labels) {
                      probabilities[l] = l === chosenLabel ? 1 : 0
                    }
                    answers[key] = { _tag: "Classify", label: chosenLabel, probabilities }
                  }
                }
                return {
                  answers,
                  usage: { inputTokens: 10, outputTokens: 2 },
                  metadata: {},
                }
              }),
          }),
        )

        const cachedLayer = wrapDecisionModelLayer(dynamicLayer, {
          promptVersion: "fail-cache-test",
        })

        const runDecide = (step: string) =>
          DecisionModel.decide(IdiomRouterV1, {
            input: { planStep: step },
          })

        yield* Effect.gen(function* () {
          // Call 1: fails
          const exit1 = yield* runDecide("Perform failure check").pipe(Effect.exit)
          expect(exit1._tag).toBe("Failure")
          expect(counter.count).toBe(0)

          // Switch to working model
          fails = false

          // Call 2: succeeds and increments counter to 1 (not served from cache!)
          const res2 = yield* runDecide("Perform failure check")
          expect(res2.answers.block.label).toBe("schema")
          expect(counter.count).toBe(1)

          // Call 3: hits cache and counter remains 1
          const res3 = yield* runDecide("Perform failure check")
          expect(res3.answers.block.label).toBe("schema")
          expect(counter.count).toBe(1)
        }).pipe(Effect.provide(cachedLayer))
      }),
  )

  it("produces distinct cache keys for different modelId values", () => {
    const keyModelA = computeDecisionCacheKey({
      taskId: "route",
      modelId: "gpt-4o",
      input: { prompt: "hello" },
    })
    const keyModelB = computeDecisionCacheKey({
      taskId: "route",
      modelId: "claude-3-5-sonnet",
      input: { prompt: "hello" },
    })
    const keyNoModel = computeDecisionCacheKey({
      taskId: "route",
      input: { prompt: "hello" },
    })

    expect(keyModelA).not.toBe(keyModelB)
    expect(keyModelA).not.toBe(keyNoModel)
    expect(keyModelB).not.toBe(keyNoModel)
  })

  it.effect(
    "expires cached entries when ttlMillis elapses and re-invokes the underlying model",
    () => {
      const counter = { count: 0 }
      const baseLayer = makeCountingDecisionModelLayer(counter)
      const shortTtlLayer = wrapDecisionModelLayer(baseLayer, {
        ttlMillis: 5,
        promptVersion: "ttl-test-v1",
      })

      return Effect.gen(function* () {
        // Call 1 -> count: 1
        const r1 = yield* routeStep("TTL check step")
        expect(r1).toBe("schema")
        expect(counter.count).toBe(1)

        // Immediate Call 2 -> hits cache, count stays 1
        const r2 = yield* routeStep("TTL check step")
        expect(r2).toBe("schema")
        expect(counter.count).toBe(1)

        // Wait 25ms (> 5ms ttl)
        yield* Effect.callback<void>((resume) => {
          setTimeout(() => resume(Effect.void), 25)
        })

        // Call 3 -> expired, re-invokes model, count: 2
        const r3 = yield* routeStep("TTL check step")
        expect(r3).toBe("schema")
        expect(counter.count).toBe(2)
      }).pipe(Effect.provide(shortTtlLayer))
    },
  )

  it.effect("handles corrupt JSON in cache file gracefully without throwing", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-corrupt-json-"))
      const cacheFile = join(tmpDir, "decisions-v1.json")
      writeFileSync(cacheFile, "CORRUPT NOT JSON {[[[", "utf8")

      const counter = { count: 0 }
      const baseLayer = makeCountingDecisionModelLayer(counter)
      const diskLayer = wrapDecisionModelLayer(baseLayer, {
        cacheFilePath: cacheFile,
        promptVersion: HARNESS_DECISION_PROMPT_VERSION,
      })

      const res = yield* routeStep("Test after corrupt cache").pipe(Effect.provide(diskLayer))
      expect(res).toBe("schema")
      expect(counter.count).toBe(1)

      rmSync(tmpDir, { recursive: true, force: true })
    }),
  )

  it.effect(
    "does not populate globalDecisionMemoryCache when shareGlobalMemoryCache is omitted or false",
    () =>
      Effect.gen(function* () {
        clearGlobalDecisionCache()
        const counter = { count: 0 }
        const baseLayer = makeCountingDecisionModelLayer(counter)

        // 1. Without shareGlobalMemoryCache
        const unsharedLayer = wrapDecisionModelLayer(baseLayer, {
          promptVersion: "unshared-v1",
        })
        yield* routeStep("Evaluate unshared step").pipe(Effect.provide(unsharedLayer))
        expect(counter.count).toBe(1)

        // The global cache should remain empty
        const lookup = yield* decideCachedDecisionLookup({
          taskId: DecisionTaskId.make("route"),
          promptVersion: DecisionPromptVersion.make("unshared-v1"),
          canonicalInputJson: CanonicalInputJson.make('{"planStep":"Evaluate unshared step"}'),
        }).pipe(Effect.provide(baseLayer))
        expect(lookup.cacheStatus).toBe("miss")

        // 2. With shareGlobalMemoryCache: true
        clearGlobalDecisionCache()
        const sharedLayer = wrapDecisionModelLayer(baseLayer, {
          promptVersion: "shared-v1",
          shareGlobalMemoryCache: true,
        })
        yield* routeStep("Evaluate shared step").pipe(Effect.provide(sharedLayer))
        expect(counter.count).toBe(3) // 1 from unshared + 1 from probe + 1 from shared

        // Another instance sharing global memory cache should hit memory cache without re-invoking
        const sharedLayer2 = wrapDecisionModelLayer(baseLayer, {
          promptVersion: "shared-v1",
          shareGlobalMemoryCache: true,
        })
        yield* routeStep("Evaluate shared step").pipe(Effect.provide(sharedLayer2))
        expect(counter.count).toBe(3) // No increment! Hit globalDecisionMemoryCache
      }),
  )
})
