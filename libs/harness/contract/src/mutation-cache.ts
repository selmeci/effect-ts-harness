import { Schema } from "effect"
import { AstSourceFilePath, ContentSha256, NonNegativeCount } from "./ast-and-gate-primitives.js"

/** Canonical persistence format version for incremental mutant outcomes. */
export const MUTATION_CACHE_SCHEMA_VERSION = "mutation-cache-v1" as const

export const MutationCacheVersion = Schema.Literal(MUTATION_CACHE_SCHEMA_VERSION)
export type MutationCacheVersion = typeof MutationCacheVersion.Type

export const MutationCacheStatus = Schema.Literal("killed")
export type MutationCacheStatus = typeof MutationCacheStatus.Type

export const MutantCacheId = Schema.NonEmptyString.pipe(Schema.brand("MutantCacheId"))
export type MutantCacheId = typeof MutantCacheId.Type

export const MutationCacheTimestamp = Schema.NonEmptyString.pipe(
  Schema.brand("MutationCacheTimestamp"),
)
export type MutationCacheTimestamp = typeof MutationCacheTimestamp.Type

export const MutationCacheEntry = Schema.Struct({
  key: ContentSha256,
  file: AstSourceFilePath,
  mutantId: MutantCacheId,
  status: MutationCacheStatus,
  recordedAt: MutationCacheTimestamp,
})
export type MutationCacheEntry = typeof MutationCacheEntry.Type

export const MutationCacheStore = Schema.Struct({
  version: MutationCacheVersion,
  entries: Schema.Record(ContentSha256, MutationCacheEntry),
})
export type MutationCacheStore = typeof MutationCacheStore.Type

export const MutationCacheLookupInput = Schema.Struct({
  candidateKeys: Schema.Array(ContentSha256),
  store: MutationCacheStore,
})
export type MutationCacheLookupInput = typeof MutationCacheLookupInput.Type

export const MutationCacheLookupDecision = Schema.Struct({
  hitKeys: Schema.Array(ContentSha256),
  missKeys: Schema.Array(ContentSha256),
  hitCount: NonNegativeCount,
  missCount: NonNegativeCount,
})
export type MutationCacheLookupDecision = typeof MutationCacheLookupDecision.Type
