import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  type ContentSha256,
  type MutationCacheEntry,
  type MutationCacheHmacSecret,
  type MutationCacheStore,
  MutationCacheTimestamp,
  PackageRelKey,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { type CodeMutant, type MutantId, type MutantOutcome } from "./mutant-ast-generator.js"
import {
  type MutationContextDigests,
  computeMutantCacheKey,
  hashReachingTestFiles,
  partitionMutationCacheLookup,
} from "./mutation-cache.js"
import type { DomainFile } from "./mutation-target-discovery.js"

/**
 * Computes candidate cache keys for a file's mutants and partitions hits vs misses.
 */
export const hydrateFileMutantCacheHits = (input: {
  readonly repoRoot: string
  readonly file: DomainFile
  readonly originalContent: string
  readonly schemaSource: string
  readonly mutants: ReadonlyArray<CodeMutant>
  readonly allReachingTests: ReadonlyArray<string>
  readonly hostIo: SyncHostIo
  readonly cacheEnabled: boolean
  readonly hmacSecret: MutationCacheHmacSecret | undefined
  readonly contextDigests: MutationContextDigests | undefined
  readonly loadedCacheStore: MutationCacheStore | undefined
  readonly cacheEntries: Record<ContentSha256, MutationCacheEntry>
}): {
  readonly mutantKeys: ReadonlyMap<string, ContentSha256>
  readonly cachedHitIds: ReadonlySet<string>
  readonly dirtiedCache: boolean
} => {
  const mutantKeys = new Map<string, ContentSha256>()
  const cachedHitIds = new Set<string>()
  let dirtiedCache = false
  if (
    !input.cacheEnabled ||
    input.hmacSecret === undefined ||
    input.contextDigests === undefined ||
    input.loadedCacheStore === undefined
  ) {
    return { mutantKeys, cachedHitIds, dirtiedCache }
  }
  const compiledSchemaSha256 = computeContentSha256(input.schemaSource)
  const originalSha256 = computeContentSha256(input.originalContent)
  const reachingTestHashes = match(
    hashReachingTestFiles(input.repoRoot, input.allReachingTests, input.hostIo),
  )
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
  if (reachingTestHashes === undefined) {
    return { mutantKeys, cachedHitIds, dirtiedCache }
  }
  const pkgKey = PackageRelKey.make(`${input.file.scope}/${input.file.pkgDir}`)
  const relFile = AstSourceFilePath.make(input.file.relFile)
  const candidateKeys: Array<ContentSha256> = []
  const keyToMutantIds = new Map<ContentSha256, Array<string>>()
  for (const mutant of input.mutants) {
    const key = computeMutantCacheKey({
      pkgKey,
      relFile,
      originalContentSha256: originalSha256,
      compiledSchemaSha256,
      mutant,
      reachingTestHashes,
      digests: input.contextDigests,
    })
    mutantKeys.set(mutant.id, key)
    candidateKeys.push(key)
    const list = keyToMutantIds.get(key)
    if (list !== undefined) list.push(mutant.id)
    else keyToMutantIds.set(key, [mutant.id])
  }
  if (candidateKeys.length > 0) {
    const lookupDecision = partitionMutationCacheLookup({
      candidateKeys,
      store: input.loadedCacheStore,
      hmacSecret: input.hmacSecret,
    })
    const touchedAt = MutationCacheTimestamp.make(new Date().toISOString())
    for (const hitKey of lookupDecision.hitKeys) {
      const existing = input.loadedCacheStore.entries[hitKey]
      if (existing !== undefined) {
        input.cacheEntries[hitKey] = { ...existing, lastAccessedAt: touchedAt }
        dirtiedCache = true
      }
      for (const mId of keyToMutantIds.get(hitKey) ?? []) cachedHitIds.add(mId)
    }
  }
  return { mutantKeys, cachedHitIds, dirtiedCache }
}

/**
 * Result of ordering per-file mutant outcomes while reporting any missing mutant IDs.
 */
export interface OrderedFileOutcomes {
  readonly present: ReadonlyArray<MutantOutcome>
  readonly missingIds: ReadonlyArray<MutantId>
}

/**
 * Partitions per-file mutant execution outcomes into deterministic present outcomes and missing mutant IDs.
 */
export const collectOrderedFileOutcomes = (
  mutants: ReadonlyArray<CodeMutant>,
  fileOutcomes: ReadonlyMap<string, MutantOutcome>,
): OrderedFileOutcomes => {
  const present: Array<MutantOutcome> = []
  const missingIds: Array<MutantId> = []
  for (const mutant of mutants) {
    const o = fileOutcomes.get(mutant.id)
    if (o !== undefined) {
      present.push(o)
    } else {
      missingIds.push(mutant.id)
    }
  }
  return { present, missingIds }
}
