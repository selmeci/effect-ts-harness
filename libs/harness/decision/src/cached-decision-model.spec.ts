import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
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
  makeCachedDecisionModelLayer,
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
})
