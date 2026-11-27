import { join } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  type ContentSha256,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  type MutationCacheAuth,
  type MutationCacheEntry,
  type MutationCacheStore,
  MutationCacheTimestamp,
  type MutationEpochMillis,
  PackageRelKey,
  compareCodeUnits,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { extractGitDiffModifiedLinesChecked } from "./mutation-backup.js"
import { runVitestPackageBaseline } from "../mutation-subprocess-helpers.js"
import {
  type CodeMutant,
  type MutantId,
  type MutantOutcome,
  discoverDomainMutants,
} from "./mutant-ast-generator.js"
import {
  type MutationContextDigests,
  computeMutantCacheKey,
  computeMutationContextDigestsChecked,
  computeMutationEntryMac,
  loadMutationCache,
  partitionMutationCacheLookup,
  saveMutationCacheAtomic,
} from "./mutation-cache.js"
import {
  computeWitnessTestAstDigestsForPath,
  prepareTwoTierLookupInputs,
  resolveMemoizedSourceOnlyClosureDigest,
  resolveMemoizedWitnessClosureDigest,
} from "./mutation-two-tier-cache.js"
import {
  type DomainFile,
  findDomainFilesChecked,
  findReachingTestFilesChecked,
  findUnclassifiedModifiedLibFilesChecked,
  partitionReachingTestFilesChecked,
  resolveDomainPackageRelDir,
} from "./mutation-target-discovery.js"
import {
  type PackageReachabilityIndex,
  partitionEligibleTestsChecked,
} from "./mutation-test-reachability.js"
import type { createSuiteTimingsTracker } from "./mutation-test-timings.js"
import { normalizeRepoRelTestPath } from "./mutation-witness.js"

type PartitionCheckedResult = ReturnType<typeof partitionReachingTestFilesChecked>
export type SuiteTimingsTracker = ReturnType<typeof createSuiteTimingsTracker>

/**
 * Discovers reaching tests, looks up verified measured timings, and partitions tests into primary and fallback stages.
 */
export const partitionTargetTestsWithTimings = (input: {
  readonly repoRoot: string
  readonly file: DomainFile
  readonly sourceContent: string
  readonly hostIo: SyncHostIo
  readonly reachabilityCache: Map<string, PackageReachabilityIndex>
  readonly timingsTracker: SuiteTimingsTracker
}): PartitionCheckedResult =>
  match(findReachingTestFilesChecked(input.repoRoot, input.file, input.hostIo))
    .with({ _tag: "Error" }, (err) => err)
    .with({ _tag: "Ok" }, ({ files: allTests }) => {
      const pkgKey = `${input.file.scope}/${input.file.pkgDir}`
      const measuredDurationMsByAbsPath = input.timingsTracker.lookupForPackage(pkgKey, allTests)
      const pkgDirRel = resolveDomainPackageRelDir(input.file)
      return partitionEligibleTestsChecked({
        repoRoot: input.repoRoot,
        pkgDirRel,
        pkgName: input.file.pkgName,
        relFile: input.file.relFile,
        sourceContent: input.sourceContent,
        allTests,
        hostIo: input.hostIo,
        reachabilityCache: input.reachabilityCache,
        measuredDurationMsByAbsPath,
      })
    })
    .exhaustive()

/**
 * Computes candidate witness-independent cache keys for a file's mutants and partitions hits vs misses
 * against witness-scoped closure digests.
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
  readonly cacheAuth: MutationCacheAuth | undefined
  readonly nowMs: MutationEpochMillis
  readonly contextDigests: MutationContextDigests | undefined
  readonly loadedCacheStore: MutationCacheStore | undefined
  readonly cacheEntries: Record<ContentSha256, MutationCacheEntry>
  readonly witnessClosureMemo?: Map<string, ContentSha256 | null> | undefined
  readonly sourceClosureMemo?: Map<string, ContentSha256 | null> | undefined
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
    input.cacheAuth === undefined ||
    input.contextDigests === undefined ||
    input.loadedCacheStore === undefined
  ) {
    return { mutantKeys, cachedHitIds, dirtiedCache }
  }
  const authEnabled = match(input.cacheAuth)
    .with({ _tag: "Enabled" }, () => true)
    .with({ _tag: "Disabled" }, () => false)
    .exhaustive()
  if (!authEnabled) {
    return { mutantKeys, cachedHitIds, dirtiedCache }
  }
  const compiledSchemaSha256 = computeContentSha256(input.schemaSource)
  const originalSha256 = computeContentSha256(input.originalContent)
  const reachingTests: Array<AstSourceFilePath> = []
  const reachingSet = new Set<AstSourceFilePath>()
  for (const rawTest of input.allReachingTests) {
    match(normalizeRepoRelTestPath(input.repoRoot, rawTest))
      .with({ _tag: "Some" }, ({ value }) => {
        if (!reachingSet.has(value)) {
          reachingSet.add(value)
          reachingTests.push(value)
        }
      })
      .with({ _tag: "None" }, () => {})
      .exhaustive()
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
      digests: input.contextDigests,
    })
    mutantKeys.set(mutant.id, key)
    candidateKeys.push(key)
    const list = keyToMutantIds.get(key)
    if (list !== undefined) list.push(mutant.id)
    else keyToMutantIds.set(key, [mutant.id])
  }
  if (candidateKeys.length > 0) {
    const twoTierInputs = prepareTwoTierLookupInputs({
      repoRoot: input.repoRoot,
      relFile,
      candidateKeys,
      loadedCacheStore: input.loadedCacheStore,
      reachingSet,
      digests: input.contextDigests,
      hostIo: input.hostIo,
      witnessClosureMemo: input.witnessClosureMemo,
      sourceClosureMemo: input.sourceClosureMemo,
    })
    const lookupDecision = partitionMutationCacheLookup({
      candidateKeys,
      store: input.loadedCacheStore,
      auth: input.cacheAuth,
      nowMs: input.nowMs,
      reachingTests,
      ...twoTierInputs,
    })
    const touchedAt = MutationCacheTimestamp.make(new Date(input.nowMs).toISOString())
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

export type ResolveSuiteTargetsResult =
  | {
      readonly _tag: "Ok"
      readonly domainFiles: ReadonlyArray<DomainFile>
      readonly targets: ReadonlyArray<DomainFile>
      readonly unclassifiedPackages: ReadonlyArray<string>
    }
  | { readonly _tag: "Abort"; readonly diagnostic: string }

/**
 * Discovers domain/core/contract targets, resolves sourceCodeOverlays, and validates explicit targetFiles.
 */
export const resolveTargetsForSuite = (input: {
  readonly repoRoot: string
  readonly hostIo: SyncHostIo
  readonly scope: string | undefined
  readonly targetFiles: ReadonlyArray<string> | undefined
  readonly hasOverlays: boolean
  readonly normalizedOverlays: ReadonlyMap<string, string>
  readonly isStrictMode: boolean
}): ResolveSuiteTargetsResult => {
  const hasTargetFilesOpt = input.targetFiles !== undefined
  const isExplicitTarget = (input.targetFiles?.length ?? 0) > 0
  if (!input.hasOverlays && hasTargetFilesOpt && !isExplicitTarget) {
    return {
      _tag: "Abort",
      diagnostic: "[mutation-check] Explicit targetFiles (--file) was provided but empty.",
    }
  }
  const discoveredRes = match(
    findDomainFilesChecked(input.repoRoot, input.hostIo, input.scope, input.targetFiles),
  )
    .with({ _tag: "Ok" }, ({ files, unclassifiedPackages }) => ({
      files,
      unclassifiedPackages,
    }))
    .with({ _tag: "Error" }, ({ reason }) => reason)
    .exhaustive()
  if (typeof discoveredRes === "string") {
    return {
      _tag: "Abort",
      diagnostic: `[mutation-check] Target discovery failed: ${discoveredRes}`,
    }
  }
  const { files: domainFiles, unclassifiedPackages } = discoveredRes
  const domainByRel = new Map(domainFiles.map((f) => [f.relFile, f]))
  const targets: Array<DomainFile> = []
  if (input.hasOverlays) {
    for (const relFile of input.normalizedOverlays.keys()) {
      const existing = domainByRel.get(relFile)
      if (existing !== undefined) {
        targets.push(existing)
        continue
      }
      const appParts = /^apps\/([^/]+)\//.exec(relFile)
      if (appParts !== null) {
        targets.push({
          scope: "apps",
          pkgDir: appParts[1]!,
          tier: "app-pure",
          fullPath: join(input.repoRoot, relFile),
          relFile,
        })
        continue
      }
      const parts = /^libs\/([^/]+)\/([^/]+)\//.exec(relFile)
      if (parts === null) {
        return {
          _tag: "Abort",
          diagnostic: `[mutation-check] Invalid overlay path '${relFile}': expected 'libs/<scope>/<pkg>/...' or 'apps/<app>/...'`,
        }
      }
      const scope = parts[1]!
      const pkgDir = parts[2]!
      const tier = match<string, DomainFile["tier"]>(pkgDir)
        .with("contract", () => "contract")
        .with("core", "gates", "graph", "decision", "ingest", () => "core")
        .otherwise(() => "domain")
      targets.push({ scope, pkgDir, tier, fullPath: join(input.repoRoot, relFile), relFile })
    }
  } else {
    targets.push(...domainFiles)
  }

  if (!input.hasOverlays && input.targetFiles !== undefined) {
    const discoveredSet = new Set(domainFiles.map((f) => f.relFile))
    for (const rawTarget of input.targetFiles) {
      const normTarget = rawTarget.replace(/\\/g, "/").replace(/^\.\//, "")
      if (!discoveredSet.has(normTarget)) {
        return {
          _tag: "Abort",
          diagnostic: `[mutation-check] Requested target file '${normTarget}' was not found in discovered domain/core/contract files.`,
        }
      }
    }
  }
  if (
    !input.hasOverlays &&
    input.isStrictMode &&
    input.scope !== undefined &&
    domainFiles.length === 0
  ) {
    return {
      _tag: "Abort",
      diagnostic: `[mutation-check] No domain/core/contract files matched scope '${input.scope}' in strict mode.`,
    }
  }
  return { _tag: "Ok", domainFiles, targets, unclassifiedPackages }
}

export type PreparePackageBaselinesResult =
  | {
      readonly _tag: "Ok"
      readonly partitionCache: ReadonlyMap<string, PartitionCheckedResult>
      readonly passedPackageBaselines: ReadonlySet<string>
    }
  | { readonly _tag: "ReadError"; readonly relFile: string; readonly reason: string }

/**
 * Partitions reaching test files for candidate files with at least one active mutant,
 * runs one batched Vitest baseline over `primaryTests` for packages with >= 2 evaluated files,
 * and records passing package keys (failing packages fall back to per-file baselines).
 */
export const preparePackageBaselines = (input: {
  readonly repoRoot: string
  readonly targets: ReadonlyArray<DomainFile>
  readonly hostIo: SyncHostIo
  readonly baseSubprocessEnv: Readonly<Record<string, string | undefined>>
  readonly diffLinesMap: ReadonlyMap<string, ReadonlySet<number>> | undefined
  readonly bypassDiffFilter: boolean
  readonly uncachedFilesSet?: ReadonlySet<string> | undefined
  readonly precomputedPartitions?: ReadonlyMap<string, PartitionCheckedResult> | undefined
  readonly onObservedDurations?:
    | ((pkgKey: string, observed: ReadonlyMap<string, number>) => void)
    | undefined
}): PreparePackageBaselinesResult => {
  const partitionCache = new Map<string, PartitionCheckedResult>()
  const reachabilityCache = new Map<string, PackageReachabilityIndex>()
  const pkgPrimaryTests = new Map<string, Set<string>>()
  const pkgFileCounts = new Map<string, number>()

  for (const file of input.targets) {
    if (
      !input.bypassDiffFilter &&
      input.diffLinesMap !== undefined &&
      !input.diffLinesMap.has(file.relFile)
    ) {
      continue
    }
    const prePart = input.precomputedPartitions?.get(file.relFile)
    let partRes: PartitionCheckedResult
    if (prePart !== undefined) {
      partRes = prePart
    } else {
      const content = match(
        Result.try({
          try: () => input.hostIo.readTextSync(file.fullPath),
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }),
      )
        .with({ _tag: "Success" }, ({ success }) => success)
        .with({ _tag: "Failure" }, ({ failure }) => ({ readErr: failure }))
        .exhaustive()
      if (typeof content !== "string") {
        return { _tag: "ReadError", relFile: file.relFile, reason: content.readErr }
      }
      const modifiedLines = input.bypassDiffFilter
        ? undefined
        : input.diffLinesMap?.get(file.relFile)
      const mutants = discoverDomainMutants(
        file.relFile,
        content,
        modifiedLines !== undefined && modifiedLines.size > 0 ? { modifiedLines } : undefined,
      )
      if (mutants.length === 0) continue

      partRes = partitionReachingTestFilesChecked(
        input.repoRoot,
        file,
        content,
        input.hostIo,
        reachabilityCache,
      )
    }
    partitionCache.set(file.relFile, partRes)
    const shouldIncludeInBaseline =
      input.uncachedFilesSet === undefined || input.uncachedFilesSet.has(file.relFile)
    if (!shouldIncludeInBaseline) continue
    match(partRes)
      .with({ _tag: "Ok" }, ({ partition }) => {
        if (partition.primaryTests.length > 0 || partition.fallbackTests.length > 0) {
          const pkgKey = `${file.scope}/${file.pkgDir}`
          pkgFileCounts.set(pkgKey, (pkgFileCounts.get(pkgKey) ?? 0) + 1)
          let set = pkgPrimaryTests.get(pkgKey)
          if (set === undefined) {
            set = new Set<string>()
            pkgPrimaryTests.set(pkgKey, set)
          }
          for (const t of partition.primaryTests) set.add(t)
        }
      })
      .with({ _tag: "Error" }, () => {})
      .exhaustive()
  }

  const passedPackageBaselines = new Set<string>()
  const sortedPkgs = [...pkgPrimaryTests.entries()].sort((a, b) => compareCodeUnits(a[0], b[0]))
  for (const [pkgKey, testSet] of sortedPkgs) {
    if ((pkgFileCounts.get(pkgKey) ?? 0) < 2) continue
    const tests = [...testSet].sort(compareCodeUnits)
    const res = runVitestPackageBaseline(
      input.repoRoot,
      pkgKey,
      tests,
      input.hostIo,
      input.baseSubprocessEnv,
    )
    match(res)
      .with({ _tag: "Ok" }, ({ observedDurationsMs }) => {
        passedPackageBaselines.add(pkgKey)
        if (observedDurationsMs.size > 0) {
          input.onObservedDurations?.(pkgKey, observedDurationsMs)
        }
      })
      .with({ _tag: "Failed" }, ({ diagnostic }) => {
        process.stderr.write(
          `[mutation-check] Warning: Batched package baseline for '${pkgKey}' failed (${diagnostic}); falling back to per-file baselines.\n`,
        )
      })
      .exhaustive()
  }

  return { _tag: "Ok", partitionCache, passedPackageBaselines }
}

export type ResolveSuiteDiffResult =
  | {
      readonly _tag: "Ok"
      readonly diffMode: "explicit-files" | "working-tree" | "branch-base" | "all-lines" | "not-git"
      readonly diffLinesMap: ReadonlyMap<string, ReadonlySet<number>> | undefined
    }
  | { readonly _tag: "Abort"; readonly diagnostic: string }

/**
 * Resolves git diff modified lines and diffMode for the mutation suite.
 */
export const resolveSuiteDiff = (input: {
  readonly repoRoot: string
  readonly hostIo: SyncHostIo
  readonly hasOverlays: boolean
  readonly isExplicitTarget: boolean
  readonly diffOnly: boolean | undefined
  readonly includeAllLines: boolean | undefined
  readonly baseRef: string | undefined
  readonly explicitBaseRef: boolean | undefined
  readonly isStrictMode: boolean
}): ResolveSuiteDiffResult => {
  const shouldExtractDiff =
    !input.hasOverlays &&
    (!input.isExplicitTarget || (input.diffOnly === true && input.includeAllLines !== true))
  if (!shouldExtractDiff) {
    return { _tag: "Ok", diffMode: "explicit-files", diffLinesMap: undefined }
  }
  return match(
    extractGitDiffModifiedLinesChecked(input.repoRoot, input.hostIo, {
      fallbackBaseRef: input.baseRef ?? (input.isStrictMode ? "main" : undefined),
      explicitBaseRef: input.explicitBaseRef,
    }),
  )
    .with({ _tag: "Failed" }, ({ reason }) => ({
      _tag: "Abort" as const,
      diagnostic: `[mutation-check] Failed to extract git diff modified lines: ${reason}`,
    }))
    .with({ _tag: "Ok" }, ({ lines, diffMode: extractedMode }) => ({
      _tag: "Ok" as const,
      diffMode: input.includeAllLines === true ? ("all-lines" as const) : extractedMode,
      diffLinesMap: lines,
    }))
    .with({ _tag: "NotGit" }, () => ({
      _tag: "Ok" as const,
      diffMode: input.includeAllLines === true ? ("all-lines" as const) : ("not-git" as const),
      diffLinesMap: undefined,
    }))
    .exhaustive()
}

/**
 * Checks for unclassified modified lib files in strict mode when no scope or targetFiles filter is active.
 */
export const checkUnclassifiedStrictFiles = (
  repoRoot: string,
  diffLinesMap: ReadonlyMap<string, ReadonlySet<number>>,
  domainFiles: ReadonlyArray<DomainFile>,
  hostIo: SyncHostIo,
): string | undefined =>
  match(findUnclassifiedModifiedLibFilesChecked(repoRoot, diffLinesMap, domainFiles, hostIo))
    .with(
      { _tag: "Error" },
      ({ reason }) => `[mutation-check] Failed to classify modified lib files: ${reason}`,
    )
    .with({ _tag: "Ok" }, ({ files }) =>
      files.length > 0
        ? `[mutation-check] Unclassified modified lib file(s) in strict mode: ${files.join(", ")}`
        : undefined,
    )
    .exhaustive()

/**
 * Records killed uncached mutants into the in-memory cache entries map and returns true if any were added.
 */
export const recordKilledMutantsToCache = (input: {
  readonly relFile: string
  readonly uncachedMutants: ReadonlyArray<CodeMutant>
  readonly fileOutcomes: ReadonlyMap<string, MutantOutcome>
  readonly mutantKeys: ReadonlyMap<string, ContentSha256>
  readonly fileNonCacheableIds: ReadonlySet<string>
  readonly witnessByMutantId: ReadonlyMap<string, AstSourceFilePath>
  readonly repoRoot: string
  readonly digests: MutationContextDigests | undefined
  readonly hostIo: SyncHostIo
  readonly cacheAuth: MutationCacheAuth | undefined
  readonly nowMs: MutationEpochMillis
  readonly cacheEntries: Record<ContentSha256, MutationCacheEntry>
  readonly witnessClosureMemo?: Map<string, ContentSha256 | null> | undefined
}): boolean => {
  if (input.cacheAuth === undefined || input.digests === undefined) return false
  const hmacSecret = match(input.cacheAuth)
    .with({ _tag: "Enabled" }, ({ hmacSecret: secret }) => secret)
    .with({ _tag: "Disabled" }, () => undefined)
    .exhaustive()
  if (hmacSecret === undefined) return false
  let dirtied = false
  const recordedAt = MutationCacheTimestamp.make(new Date(input.nowMs).toISOString())
  const fileAstPath = AstSourceFilePath.make(input.relFile)
  for (const mutant of input.uncachedMutants) {
    const outcome = input.fileOutcomes.get(mutant.id)
    const key = input.mutantKeys.get(mutant.id)
    const witnessTestFile = input.witnessByMutantId.get(mutant.id)
    match(outcome?.status)
      .with("killed", () => {
        if (
          key !== undefined &&
          witnessTestFile !== undefined &&
          !input.fileNonCacheableIds.has(mutant.id)
        ) {
          const witnessClosureSha256 = resolveMemoizedWitnessClosureDigest({
            repoRoot: input.repoRoot,
            relFile: input.relFile,
            witnessTestFile,
            digests: input.digests!,
            hostIo: input.hostIo,
            witnessClosureMemo: input.witnessClosureMemo,
          })
          if (witnessClosureSha256 !== undefined) {
            const sourceClosureSha256 = resolveMemoizedSourceOnlyClosureDigest({
              repoRoot: input.repoRoot,
              relFile: input.relFile,
              digests: input.digests!,
              hostIo: input.hostIo,
            })
            const witnessTestAstDigests = computeWitnessTestAstDigestsForPath(
              input.repoRoot,
              witnessTestFile,
              input.hostIo,
            )
            const mutantCacheId = MutantCacheId.make(mutant.id)
            const entryBase = {
              key,
              file: fileAstPath,
              mutantId: mutantCacheId,
              status: "killed" as const,
              recordedAt,
              witnessTestFile,
              witnessClosureSha256,
              ...(sourceClosureSha256 !== undefined ? { sourceClosureSha256 } : {}),
              ...(witnessTestAstDigests !== undefined ? { witnessTestAstDigests } : {}),
            }
            const mac = computeMutationEntryMac(hmacSecret, entryBase)
            input.cacheEntries[key] = { ...entryBase, mac }
            dirtied = true
          }
        }
      })
      .with("survived", "equivalent", undefined, () => {})
      .exhaustive()
  }
  return dirtied
}

export interface SuiteCacheContext {
  readonly enabledCacheAuth: MutationCacheAuth | undefined
  readonly contextDigests: MutationContextDigests | undefined
  readonly cacheEnabled: boolean
  readonly loadedCacheStore: MutationCacheStore | undefined
}

/** Resolves cache auth, context digests, and initial cache store for a mutation suite run. */
export const initSuiteCacheContext = (
  repoRoot: string,
  hostIo: SyncHostIo,
  cacheRequested: boolean,
  cacheAuth: MutationCacheAuth | undefined,
): SuiteCacheContext => {
  const enabledCacheAuth: MutationCacheAuth | undefined = cacheRequested
    ? cacheAuth === undefined
      ? (() => {
          process.stderr.write(
            "[mutation-check] Warning: Mutation cache disabled (missing HMAC secret).\n",
          )
          return undefined
        })()
      : match(cacheAuth)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            process.stderr.write(`[mutation-check] Warning: Mutation cache disabled (${reason}).\n`)
            return undefined
          })
          .with({ _tag: "Enabled" }, (enabled) => enabled)
          .exhaustive()
    : undefined
  const contextDigests =
    enabledCacheAuth !== undefined
      ? match(computeMutationContextDigestsChecked(repoRoot, hostIo))
          .with({ _tag: "Ok" }, ({ digests }) => digests)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            process.stderr.write(`[mutation-check] Warning: Mutation cache disabled (${reason}).\n`)
            return undefined
          })
          .exhaustive()
      : undefined
  const cacheEnabled = enabledCacheAuth !== undefined && contextDigests !== undefined
  const loadedCacheStore =
    cacheEnabled && enabledCacheAuth !== undefined
      ? loadMutationCache(repoRoot, hostIo, enabledCacheAuth)
      : undefined
  return { enabledCacheAuth, contextDigests, cacheEnabled, loadedCacheStore }
}

/**
 * Persists dirty mutation cache entries atomically on top of the latest on-disk store.
 */
export const flushMutationCache = (
  repoRoot: string,
  hostIo: SyncHostIo,
  cacheAuth: MutationCacheAuth,
  cacheEntries: Record<ContentSha256, MutationCacheEntry>,
): boolean => {
  const freshStore = loadMutationCache(repoRoot, hostIo, cacheAuth)
  const saveRes = saveMutationCacheAtomic(
    repoRoot,
    {
      version: MUTATION_CACHE_SCHEMA_VERSION,
      entries: { ...freshStore.entries, ...cacheEntries },
    },
    hostIo,
    cacheAuth,
  )
  return match(saveRes)
    .with({ _tag: "Saved" }, () => true)
    .with({ _tag: "Skipped" }, { _tag: "Failed" }, ({ reason }) => {
      process.stderr.write(
        `[mutation-check] Warning: Failed to persist mutation cache: ${reason}\n`,
      )
      return false
    })
    .exhaustive()
}

/** Records killed mutants to cache, appends ordered outcomes, and invokes flush callback. */
export const applyFileOutcomesAndRecordKills = (input: {
  readonly relFile: string
  readonly mutants: ReadonlyArray<CodeMutant>
  readonly uncachedMutants: ReadonlyArray<CodeMutant>
  readonly mutantKeys: ReadonlyMap<string, ContentSha256>
  readonly fileOutcomes: ReadonlyMap<string, MutantOutcome>
  readonly fileNonCacheableIds: ReadonlySet<string>
  readonly witnessByMutantId: ReadonlyMap<string, AstSourceFilePath>
  readonly repoRoot: string
  readonly contextDigests: MutationContextDigests | undefined
  readonly hostIo: SyncHostIo
  readonly enabledCacheAuth: MutationCacheAuth | undefined
  readonly nowMs: MutationEpochMillis
  readonly cacheEntries: Record<ContentSha256, MutationCacheEntry>
  readonly witnessClosureMemo: Map<string, ContentSha256 | null>
  readonly outcomes: Array<MutantOutcome>
  readonly markDirty: () => void
  readonly flushCache: () => void
  readonly requireAllOutcomes: boolean
}): string | undefined => {
  if (!input.requireAllOutcomes && input.fileOutcomes.size === 0) return undefined
  const ordered = collectOrderedFileOutcomes(input.mutants, input.fileOutcomes)
  if (input.requireAllOutcomes && ordered.missingIds.length > 0) {
    input.outcomes.push(...ordered.present)
    return `[mutation-check] Missing outcome(s) for mutant(s) in '${input.relFile}': ${ordered.missingIds.join(", ")}`
  }
  if (
    recordKilledMutantsToCache({
      relFile: input.relFile,
      uncachedMutants: input.uncachedMutants,
      fileOutcomes: input.fileOutcomes,
      mutantKeys: input.mutantKeys,
      fileNonCacheableIds: input.fileNonCacheableIds,
      witnessByMutantId: input.witnessByMutantId,
      repoRoot: input.repoRoot,
      digests: input.contextDigests,
      hostIo: input.hostIo,
      cacheAuth: input.enabledCacheAuth,
      nowMs: input.nowMs,
      cacheEntries: input.cacheEntries,
      witnessClosureMemo: input.witnessClosureMemo,
    })
  ) {
    input.markDirty()
  }
  input.outcomes.push(...ordered.present)
  input.flushCache()
  return undefined
}
