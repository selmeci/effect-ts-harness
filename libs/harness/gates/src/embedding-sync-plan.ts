import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  type EmbeddingContentHash,
  type EmbeddingDimensionCount,
  type EmbeddingNodeKey,
  type EmbeddingSyncPlanDecision,
  type EmbeddingSyncPlanInput,
  ErrorReasonMessage,
} from "@harness/contract"

export const decideEmbeddingSyncPlan = Effect.fn("EmbeddingSyncPlan.decide")(function* (
  input: EmbeddingSyncPlanInput,
): Effect.fn.Return<EmbeddingSyncPlanDecision, never, never> {
  const sortedItems = [...input.items].sort((a, b) => compareCodeUnits(a.nodeKey, b.nodeKey))
  const allCurrentKeys = sortedItems.map((item) => item.nodeKey)

  if (input.cachedSnapshot === null) {
    return yield* Effect.succeed({
      _tag: "ModelMismatchRebuild" as const,
      reason: ErrorReasonMessage.make("No cached embedding snapshot present"),
      embedKeys: allCurrentKeys,
      evictedKeys: [],
    })
  }

  const cached = input.cachedSnapshot
  const cachedKeysSorted = [...new Set(cached.entries.map((entry) => entry.nodeKey))].sort(
    compareCodeUnits,
  )

  if (cached.model !== input.currentModel || cached.dimensions !== input.currentDimensions) {
    return {
      _tag: "ModelMismatchRebuild" as const,
      reason: ErrorReasonMessage.make(
        `Embedding model/dimension changed from ${cached.model} (${cached.dimensions}) to ${input.currentModel} (${input.currentDimensions})`,
      ),
      embedKeys: allCurrentKeys,
      evictedKeys: cachedKeysSorted,
    }
  }

  const cachedByKey = new Map<
    EmbeddingNodeKey,
    {
      readonly contentHash: EmbeddingContentHash
      readonly dimensions: EmbeddingDimensionCount
    }
  >()
  for (const entry of cached.entries) {
    cachedByKey.set(entry.nodeKey, {
      contentHash: entry.contentHash,
      dimensions: entry.dimensions,
    })
  }

  const currentKeySet = new Set<EmbeddingNodeKey>()
  const embedKeys: Array<EmbeddingNodeKey> = []
  const reusedKeys: Array<EmbeddingNodeKey> = []

  for (const item of sortedItems) {
    currentKeySet.add(item.nodeKey)
    const prev = cachedByKey.get(item.nodeKey)
    const isHit =
      prev !== undefined &&
      prev.contentHash === item.contentHash &&
      prev.dimensions === input.currentDimensions
    match(isHit)
      .with(true, () => {
        reusedKeys.push(item.nodeKey)
      })
      .with(false, () => {
        embedKeys.push(item.nodeKey)
      })
      .exhaustive()
  }

  const evictedKeys = cachedKeysSorted.filter((key) => !currentKeySet.has(key))

  if (embedKeys.length === 0 && evictedKeys.length === 0) {
    return {
      _tag: "CacheHitAll" as const,
      reusedKeys,
    }
  }

  return {
    _tag: "EmbedDelta" as const,
    embedKeys,
    reusedKeys,
    evictedKeys,
  }
})
