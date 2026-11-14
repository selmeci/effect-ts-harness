import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import * as AiError from "effect/ai/AiError"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  DecisionCachePayloadJson,
  DecisionCacheTtlMillis,
  NonNegativeCount,
} from "@harness/contract"
import { DecisionCachePort } from "@harness/service"
import {
  CachedDecisionLookupInput,
  CachedDecisionLookupResult,
  CachedDecisionModel,
  CanonicalInputJson,
  canonicalJson,
  computeDecisionCacheKey,
  decideCachedDecisionLookup,
  DecisionCacheHitStatus,
  DecisionCacheKey,
  DecisionPromptVersion,
  DecisionTaskId,
  evaluateBatchCachedDecisions,
  HARNESS_DECISION_PROMPT_VERSION,
  IdiomRouterV1,
  lookupOrComputeDecisionPayload,
  makeCachedDecisionModelLayer,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
  resolveDecisionCachePath,
  routeStep,
  wrapDecisionModelLayer,
} from "../src/index.js"

const CompositeLookupInputsArb = Schema.Array(CachedDecisionLookupInput)

const makeInMemoryDecisionCachePortLayer = (): Layer.Layer<DecisionCachePort> => {
  const entries = new Map<
    string,
    { readonly payload: DecisionCachePayloadJson; readonly expiresAtMs: number }
  >()
  let hits = 0
  let misses = 0
  return Layer.succeed(DecisionCachePort, {
    lookup: (key) =>
      Effect.sync(() => {
        const entry = entries.get(key)
        if (entry === undefined || Date.now() > entry.expiresAtMs) {
          if (entry !== undefined) entries.delete(key)
          misses += 1
          return Option.none<DecisionCachePayloadJson>()
        }
        hits += 1
        return Option.some(entry.payload)
      }),
    store: (key, payload, ttlMillis) =>
      Effect.sync(() => {
        entries.set(key, {
          payload,
          expiresAtMs: Date.now() + ttlMillis,
        })
      }),
    clear: Effect.sync(() => {
      entries.clear()
      hits = 0
      misses = 0
    }),
    stats: Effect.sync(() => ({
      hits: NonNegativeCount.make(hits),
      misses: NonNegativeCount.make(misses),
      coalescedRequests: NonNegativeCount.make(0),
      size: NonNegativeCount.make(entries.size),
    })),
  })
}

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
            match(decision)
              .with({ _tag: "Probability" }, () => {
                answers[key] = { _tag: "Probability", probability: 0.9 }
              })
              .with({ _tag: "Classify" }, (d) => {
                const labels = Object.keys(d.criteria)
                const chosenLabel = labels.includes("schema") ? "schema" : (labels[0] ?? "effect")
                const probabilities: Record<string, number> = {}
                for (const l of labels) {
                  probabilities[l] = l === chosenLabel ? 1 : 0
                }
                answers[key] = { _tag: "Classify", label: chosenLabel, probabilities }
              })
              .with({ _tag: "Rate" }, () => {
                throw new Error("Unexpected Rate decision")
              })
              .exhaustive()
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
        const portLayer = makeInMemoryDecisionCachePortLayer()
        const cachedLayer = wrapDecisionModelLayer(baseLayer, {
          promptVersion: HARNESS_DECISION_PROMPT_VERSION,
        }).pipe(Layer.provideMerge(portLayer))

        // First call -> cache miss (1 underlying call)
        const r1 = yield* routeStep("Validate customer checkout payload").pipe(
          Effect.provide(cachedLayer),
        )
        expect(r1).toBe("schema")
        expect(counter.count).toBe(1)

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
          promptVersion: "decisions-v2",
        }).pipe(Layer.provideMerge(portLayer))
        const r4 = yield* routeStep("Validate customer checkout payload").pipe(
          Effect.provide(v2Layer),
        )
        expect(r4).toBe("schema")
        expect(counter.count).toBe(3)

        // Fresh layer reading persisted DecisionCachePort -> 0 new underlying calls
        const portBackedLayer = Layer.provide(
          makeCachedDecisionModelLayer({
            promptVersion: "decisions-v2",
          }),
          baseLayer,
        ).pipe(Layer.provideMerge(portLayer))
        const r5 = yield* routeStep("Validate customer checkout payload").pipe(
          Effect.provide(portBackedLayer),
        )
        expect(r5).toBe("schema")
        expect(counter.count).toBe(3)

        expect(resolveDecisionCachePath("/tmp/repo")).toContain("decisions-v1.json")
        expect(DecisionTaskId.make("route")).toBe("route")
        expect(DecisionPromptVersion.make("decisions-v1")).toBe("decisions-v1")
        expect(DecisionCacheKey.make(key1)).toBe(key1)
        expect(DecisionCacheHitStatus.make("hit")).toBe("hit")
        expect(CanonicalInputJson.make("{}")).toBe("{}")
        expect(CachedDecisionLookupResult.fields).toBeDefined()
      }),
  )

  it.effect(
    "coalesces concurrent identical requests into a single underlying DecisionModel invocation",
    () =>
      Effect.gen(function* () {
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
        const sample = inputs[0] ?? {
          taskId: DecisionTaskId.make("route"),
          promptVersion: HARNESS_DECISION_PROMPT_VERSION,
          canonicalInputJson: CanonicalInputJson.make("{}"),
        }
        const combinedLayer = Layer.mergeAll(
          makeMockDecisionModelLayer(),
          makeInMemoryDecisionCachePortLayer(),
        )
        const [first, second] = yield* Effect.gen(function* () {
          const a = yield* CachedDecisionModel.decide(sample)
          const b = yield* decideCachedDecisionLookup(sample)
          return [a, b] as const
        }).pipe(Effect.provide(combinedLayer))

        expect(first.cacheKey).toBe(second.cacheKey)
        expect(first.cacheStatus).toBe("miss")
        expect(second.cacheStatus).toBe("hit")
      }),
  )

  it.effect(
    "does not cache failures in decideCachedDecisionLookup or makeCachedDecisionModelLayer",
    () =>
      Effect.gen(function* () {
        const sample = {
          taskId: DecisionTaskId.make("test-failure-caching"),
          promptVersion: HARNESS_DECISION_PROMPT_VERSION,
          canonicalInputJson: CanonicalInputJson.make('{"input":"test"}'),
        }
        const portLayer = makeInMemoryDecisionCachePortLayer()

        // 1. decideCachedDecisionLookup with failing layer does not cache failure
        const failingLayer = Layer.mergeAll(makeFailingDecisionModelLayer("Network timeout"), portLayer)
        const mockLayer = Layer.mergeAll(makeMockDecisionModelLayer(), portLayer)
        const [miss1, miss2, hit] = yield* Effect.gen(function* () {
          const a = yield* decideCachedDecisionLookup(sample).pipe(Effect.provide(failingLayer))
          const b = yield* decideCachedDecisionLookup(sample).pipe(Effect.provide(mockLayer))
          const c = yield* decideCachedDecisionLookup(sample).pipe(Effect.provide(mockLayer))
          return [a, b, c] as const
        })
        expect(miss1.cacheStatus).toBe("miss")
        expect(miss2.cacheStatus).toBe("miss")
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
                  match(decision)
                    .with({ _tag: "Probability" }, () => {
                      answers[key] = { _tag: "Probability", probability: 0.95 }
                    })
                    .with({ _tag: "Classify" }, (d) => {
                      const labels = Object.keys(d.criteria)
                      const chosenLabel = labels.includes("schema")
                        ? "schema"
                        : (labels[0] ?? "effect")
                      const probabilities: Record<string, number> = {}
                      for (const l of labels) {
                        probabilities[l] = l === chosenLabel ? 1 : 0
                      }
                      answers[key] = { _tag: "Classify", label: chosenLabel, probabilities }
                    })
                    .with({ _tag: "Rate" }, () => {
                      throw new Error("Unexpected Rate decision")
                    })
                    .exhaustive()
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
          match(exit1)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasFails(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected exit1 to fail")
            })
            .exhaustive()
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

  it.effect(
    "isolates in-memory caches per layer build when no DecisionCachePort is provided",
    () =>
      Effect.gen(function* () {
        const counter = { count: 0 }
        const baseLayer = makeCountingDecisionModelLayer(counter)

        const layer1 = wrapDecisionModelLayer(baseLayer, { promptVersion: "isolated-v1" })
        const layer2 = wrapDecisionModelLayer(baseLayer, { promptVersion: "isolated-v1" })

        yield* routeStep("Evaluate isolated step").pipe(Effect.provide(layer1))
        expect(counter.count).toBe(1)

        // Separate layer build without shared DecisionCachePort misses and invokes model again
        yield* routeStep("Evaluate isolated step").pipe(Effect.provide(layer2))
        expect(counter.count).toBe(2)
      }),
  )

  it.effect(
    "REQ-3.2: DecisionCache.lookupOrCompute memoizes payloads via DecisionCachePort",
    () =>
      Effect.gen(function* () {
        let computeCalls = 0
        const key = computeDecisionCacheKey({
          taskId: "req-3-2",
          input: { step: "memoize" },
        })
        const ttlMillis = DecisionCacheTtlMillis.make(60_000)

        const result1 = yield* lookupOrComputeDecisionPayload({
          key,
          ttlMillis,
          compute: Effect.sync(() => {
            computeCalls += 1
            return DecisionCachePayloadJson.make('{"answer":"ok"}')
          }),
        })
        const result2 = yield* lookupOrComputeDecisionPayload({
          key,
          ttlMillis,
          compute: Effect.sync(() => {
            computeCalls += 1
            return DecisionCachePayloadJson.make('{"answer":"other"}')
          }),
        })

        expect(result1).toBe('{"answer":"ok"}')
        expect(result2).toBe('{"answer":"ok"}')
        expect(computeCalls).toBe(1)

        const port = yield* DecisionCachePort
        const stats = yield* port.stats
        expect(stats.hits).toBe(1)
        expect(stats.misses).toBe(1)
        expect(stats.size).toBe(1)
      }).pipe(Effect.provide(makeInMemoryDecisionCachePortLayer())),
  )
})
