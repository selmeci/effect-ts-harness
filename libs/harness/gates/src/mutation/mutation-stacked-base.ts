/**
 * @fileoverview Verified stacked-PR base resolution and ancestor HMAC kill cache verification (`SPEC-0034` Area 5).
 */
import { Result } from "effect"
import { match } from "ts-pattern"
import type {
  ContentSha256,
  MutationCacheAuth,
  MutationCacheEntry,
  MutationCacheStore,
  MutationEpochMillis,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  type CodeMutant,
  type MutantOutcome,
  compileMutantSchemaModule,
  discoverDomainMutants,
  verifyMutantSchemaSyntax,
} from "./mutant-ast-generator.js"
import {
  extractGitDiffModifiedLinesChecked,
  isGitAncestorCommit,
  mergeLineMaps,
  resolveEffectiveGitBaseRef,
  resolveGitCommitSha,
} from "./mutation-backup.js"
import type { MutationContextDigests } from "./mutation-cache.js"
import type { MutationSuiteReport } from "./mutation-outcomes.js"
import {
  type SuiteTimingsTracker,
  checkUnclassifiedStrictFiles,
  hydrateFileMutantCacheHits,
  partitionTargetTestsWithTimings,
  resolveSuiteDiff,
} from "./mutation-suite-helpers.js"
import type { DomainFile } from "./mutation-target-discovery.js"
import type { PackageReachabilityIndex } from "./mutation-test-reachability.js"

export type StackedBaseResolution =
  | {
      readonly _tag: "DirectMain"
      readonly mainDiffLines: ReadonlyMap<string, ReadonlySet<number>>
      readonly diffMode: "working-tree" | "branch-base" | "not-git"
    }
  | {
      readonly _tag: "FallbackToMain"
      readonly parentRef: string
      readonly reason: string
      readonly mainDiffLines: ReadonlyMap<string, ReadonlySet<number>>
      readonly diffMode: "working-tree" | "branch-base" | "not-git"
    }
  | {
      readonly _tag: "Stacked"
      readonly parentRef: string
      readonly parentCommitSha: string
      readonly mainCommitSha: string
      readonly parentDiffLines: ReadonlyMap<string, ReadonlySet<number>>
      readonly ancestorOnlyLines: ReadonlyMap<string, ReadonlySet<number>>
      readonly combinedMainDiffLines: ReadonlyMap<string, ReadonlySet<number>>
      readonly diffMode: "branch-base"
    }

export type ResolveStackedBaseContextResult =
  | StackedBaseResolution
  | { readonly _tag: "Failed"; readonly reason: string }

export type VerifyAncestorLinesResult =
  | {
      readonly _tag: "Ok"
      readonly evalDiffLines: ReadonlyMap<string, ReadonlySet<number>>
      readonly verifiedAncestorOutcomes: ReadonlyArray<MutantOutcome>
      readonly verifiedAncestorEvaluatedFiles: ReadonlyArray<string>
      readonly ancestorVerifiedMutantCount: number
      readonly ancestorExpandedMutantCount: number
      readonly dirtiedCache: boolean
    }
  | { readonly _tag: "Abort"; readonly diagnostic: string }

export interface StackedBaseSuitePreparation {
  readonly abortDiagnostic?: string | undefined
  readonly diffMode: MutationSuiteReport["diffMode"]
  readonly evalDiffLines: ReadonlyMap<string, ReadonlySet<number>> | undefined
  readonly allMainDiffLines: ReadonlyMap<string, ReadonlySet<number>> | undefined
  readonly verifiedAncestorOutcomes: ReadonlyArray<MutantOutcome>
  readonly verifiedAncestorEvaluatedFiles: ReadonlyArray<string>
  readonly ancestorVerifiedMutantCount: number
  readonly ancestorExpandedMutantCount: number
  readonly stackedBaseRef: string | undefined
  readonly stackedBaseEligible: boolean
  readonly dirtiedCache: boolean
}

const cloneLineMap = (
  source: ReadonlyMap<string, ReadonlySet<number>>,
): Map<string, Set<number>> => {
  const out = new Map<string, Set<number>>()
  mergeLineMaps(out, source)
  return out
}

const subtractLineMaps = (
  minuend: ReadonlyMap<string, ReadonlySet<number>>,
  subtrahend: ReadonlyMap<string, ReadonlySet<number>>,
): Map<string, Set<number>> => {
  const out = new Map<string, Set<number>>()
  for (const [file, lines] of minuend.entries()) {
    const subLines = subtrahend.get(file)
    const remaining = new Set<number>()
    for (const ln of lines) {
      if (!(subLines?.has(ln) ?? false)) remaining.add(ln)
    }
    if (remaining.size > 0) out.set(file, remaining)
  }
  return out
}

/**
 * Resolves stacked-PR parent ancestry and partitions `main...HEAD` into `<parentRef>...HEAD`
 * plus ancestor-only `main...<parentRef>` lines, failing closed to `main` on invalid or
 * non-ancestor refs (`SPEC-0034` `REQ-5.1`).
 */
export const resolveStackedBaseContext = (input: {
  readonly repoRoot: string
  readonly parentRef: string
  readonly hostIo: SyncHostIo
}): ResolveStackedBaseContextResult => {
  const mainDiffRes = extractGitDiffModifiedLinesChecked(input.repoRoot, input.hostIo, {
    fallbackBaseRef: "main",
  })
  const mainDiff = match(mainDiffRes)
    .with({ _tag: "NotGit" }, () => undefined)
    .with({ _tag: "Failed" }, ({ reason }) => reason)
    .with({ _tag: "Ok" }, (ok) => ok)
    .exhaustive()

  if (mainDiff === undefined) {
    return { _tag: "DirectMain", mainDiffLines: new Map(), diffMode: "not-git" }
  }
  if (typeof mainDiff === "string") {
    return { _tag: "Failed", reason: mainDiff }
  }

  const fallback = (reason: string): StackedBaseResolution => {
    process.stderr.write(
      `[mutation-check] Warning: Stacked --base '${input.parentRef}' (${reason}); failing closed to 'main'.\n`,
    )
    return {
      _tag: "FallbackToMain",
      parentRef: input.parentRef,
      reason,
      mainDiffLines: mainDiff.lines,
      diffMode: mainDiff.diffMode,
    }
  }

  if (
    input.parentRef.trim().length === 0 ||
    input.parentRef.startsWith("-") ||
    /[\0\r\n]/.test(input.parentRef)
  ) {
    return fallback("invalid base ref")
  }

  const parentCommitSha = resolveGitCommitSha(input.repoRoot, input.hostIo, input.parentRef)
  if (parentCommitSha === undefined) {
    return fallback(`ref '${input.parentRef}' does not resolve to a commit`)
  }
  if (!isGitAncestorCommit(input.repoRoot, input.hostIo, parentCommitSha, "HEAD")) {
    return fallback(`ref '${input.parentRef}' is not an ancestor of HEAD`)
  }

  const effectiveMainRef = resolveEffectiveGitBaseRef(input.repoRoot, input.hostIo, "main", false)
  const mainCommitSha =
    resolveGitCommitSha(input.repoRoot, input.hostIo, effectiveMainRef) ??
    resolveGitCommitSha(input.repoRoot, input.hostIo, "origin/main")
  if (mainCommitSha === undefined) {
    return fallback("unable to resolve 'main' commit SHA")
  }
  if (parentCommitSha === mainCommitSha) {
    return {
      _tag: "DirectMain",
      mainDiffLines: mainDiff.lines,
      diffMode: mainDiff.diffMode,
    }
  }

  const parentDiffRes = extractGitDiffModifiedLinesChecked(input.repoRoot, input.hostIo, {
    fallbackBaseRef: input.parentRef,
    explicitBaseRef: true,
  })
  return match(parentDiffRes)
    .with({ _tag: "NotGit" }, () => ({
      _tag: "DirectMain" as const,
      mainDiffLines: new Map<string, ReadonlySet<number>>(),
      diffMode: "not-git" as const,
    }))
    .with({ _tag: "Failed" }, ({ reason }) =>
      fallback(`failed to extract diff for '${input.parentRef}': ${reason}`),
    )
    .with({ _tag: "Ok" }, ({ lines: parentDiffLines }) => ({
      _tag: "Stacked" as const,
      parentRef: input.parentRef,
      parentCommitSha,
      mainCommitSha,
      parentDiffLines,
      ancestorOnlyLines: subtractLineMaps(mainDiff.lines, parentDiffLines),
      combinedMainDiffLines: mainDiff.lines,
      diffMode: "branch-base" as const,
    }))
    .exhaustive()
}

/**
 * Verifies ancestor-only modified lines against witness-scoped HMAC cache entries and expands any
 * unverified, expired, tampered, or child-edited lines into `evalDiffLines` (`REQ-5.1`, `REQ-5.2`).
 */
export const verifyAncestorLinesAgainstHmacCache = (input: {
  readonly repoRoot: string
  readonly hostIo: SyncHostIo
  readonly targets: ReadonlyArray<DomainFile>
  readonly parentDiffLines: ReadonlyMap<string, ReadonlySet<number>>
  readonly ancestorOnlyLines: ReadonlyMap<string, ReadonlySet<number>>
  readonly stageAOnly: boolean
  readonly cacheEnabled: boolean
  readonly cacheAuth: MutationCacheAuth | undefined
  readonly nowMs: MutationEpochMillis
  readonly contextDigests: MutationContextDigests | undefined
  readonly loadedCacheStore: MutationCacheStore | undefined
  readonly cacheEntries: Record<ContentSha256, MutationCacheEntry>
  readonly timingsTracker: SuiteTimingsTracker
  readonly reachabilityCache: Map<string, PackageReachabilityIndex>
  readonly witnessClosureMemo: Map<string, ContentSha256 | null>
  readonly precomputedPartitions?:
    | Map<string, ReturnType<typeof partitionTargetTestsWithTimings>>
    | undefined
}): VerifyAncestorLinesResult => {
  const effectiveEvalLines = cloneLineMap(input.parentDiffLines)
  const verifiedAncestorOutcomes: Array<MutantOutcome> = []
  const verifiedAncestorEvaluatedFiles: Array<string> = []
  const verifiedSet = new Set<string>()
  let ancestorVerifiedMutantCount = 0
  let ancestorExpandedMutantCount = 0
  let dirtiedCache = false

  for (const file of input.targets) {
    const ancestorLines = input.ancestorOnlyLines.get(file.relFile)
    if (ancestorLines === undefined || ancestorLines.size === 0) continue

    const readRes = Result.try({
      try: () => input.hostIo.readTextSync(file.fullPath),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    })
    const originalContent = match(readRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) => ({ readErr: failure }))
      .exhaustive()
    if (typeof originalContent !== "string") {
      return {
        _tag: "Abort",
        diagnostic: `[mutation-check] Failed to read source file '${file.relFile}': ${originalContent.readErr}`,
      }
    }

    const ancestorMutants = discoverDomainMutants(file.relFile, originalContent, {
      modifiedLines: ancestorLines,
    })
    if (ancestorMutants.length === 0) continue

    if (input.parentDiffLines.has(file.relFile)) {
      mergeLineMaps(effectiveEvalLines, new Map([[file.relFile, ancestorLines]]))
      ancestorExpandedMutantCount += ancestorMutants.length
      continue
    }

    const schemaBundle = compileMutantSchemaModule(file.relFile, originalContent, ancestorMutants)
    const syntaxErrors = verifyMutantSchemaSyntax(file.relFile, schemaBundle.schemaSource)
    if (syntaxErrors.length > 0) {
      return {
        _tag: "Abort",
        diagnostic: `[mutation-check] Compiled mutant schema for '${file.relFile}' failed syntax verification: ${syntaxErrors.join("; ")}`,
      }
    }

    if (!input.cacheEnabled) {
      mergeLineMaps(effectiveEvalLines, new Map([[file.relFile, ancestorLines]]))
      ancestorExpandedMutantCount += ancestorMutants.length
      continue
    }

    const partRes = partitionTargetTestsWithTimings({
      repoRoot: input.repoRoot,
      file,
      sourceContent: originalContent,
      hostIo: input.hostIo,
      reachabilityCache: input.reachabilityCache,
      timingsTracker: input.timingsTracker,
    })
    const partition = match(partRes)
      .with({ _tag: "Ok" }, ({ partition: p }) => p)
      .with({ _tag: "Error" }, ({ reason }) => reason)
      .exhaustive()
    if (typeof partition === "string") {
      return { _tag: "Abort", diagnostic: `[mutation-check] ${partition}` }
    }
    input.precomputedPartitions?.set(file.relFile, partRes)

    const fallbackTests = input.stageAOnly ? [] : partition.fallbackTests
    const allReachingTests = [...partition.primaryTests, ...fallbackTests]
    if (allReachingTests.length === 0) {
      mergeLineMaps(effectiveEvalLines, new Map([[file.relFile, ancestorLines]]))
      ancestorExpandedMutantCount += ancestorMutants.length
      continue
    }

    const { cachedHitIds, dirtiedCache: fileDirtied } = hydrateFileMutantCacheHits({
      repoRoot: input.repoRoot,
      file,
      originalContent,
      schemaSource: schemaBundle.schemaSource,
      mutants: ancestorMutants,
      allReachingTests,
      hostIo: input.hostIo,
      cacheEnabled: input.cacheEnabled,
      cacheAuth: input.cacheAuth,
      nowMs: input.nowMs,
      contextDigests: input.contextDigests,
      loadedCacheStore: input.loadedCacheStore,
      cacheEntries: input.cacheEntries,
      witnessClosureMemo: input.witnessClosureMemo,
    })
    if (fileDirtied) dirtiedCache = true

    const mutantsByLine = new Map<number, Array<CodeMutant>>()
    for (const mutant of ancestorMutants) {
      const list = mutantsByLine.get(mutant.line)
      if (list !== undefined) list.push(mutant)
      else mutantsByLine.set(mutant.line, [mutant])
    }

    for (const [line, lineMutants] of mutantsByLine.entries()) {
      const allLineVerified = lineMutants.every((m) => cachedHitIds.has(m.id))
      if (allLineVerified) {
        for (const mutant of lineMutants) {
          verifiedAncestorOutcomes.push({ mutant, status: "killed" })
          ancestorVerifiedMutantCount += 1
        }
        if (!verifiedSet.has(file.relFile)) {
          verifiedSet.add(file.relFile)
          verifiedAncestorEvaluatedFiles.push(file.relFile)
        }
      } else {
        mergeLineMaps(effectiveEvalLines, new Map([[file.relFile, new Set([line])]]))
        ancestorExpandedMutantCount += lineMutants.length
      }
    }
  }

  return {
    _tag: "Ok",
    evalDiffLines: effectiveEvalLines,
    verifiedAncestorOutcomes,
    verifiedAncestorEvaluatedFiles,
    ancestorVerifiedMutantCount,
    ancestorExpandedMutantCount,
    dirtiedCache,
  }
}

const emptyStackedPrep = (
  diffMode: MutationSuiteReport["diffMode"],
  extra: Partial<StackedBaseSuitePreparation>,
): StackedBaseSuitePreparation => ({
  diffMode,
  evalDiffLines: undefined,
  allMainDiffLines: undefined,
  verifiedAncestorOutcomes: [],
  verifiedAncestorEvaluatedFiles: [],
  ancestorVerifiedMutantCount: 0,
  ancestorExpandedMutantCount: 0,
  stackedBaseRef: undefined,
  stackedBaseEligible: false,
  dirtiedCache: false,
  ...extra,
})

/**
 * Resolves stacked-PR base context, enforces strict unclassified-file checks over all `main...HEAD`
 * diffs (`REQ-5.3`), and verifies ancestor mutants against the HMAC kill cache.
 */
export const prepareStackedBaseForSuite = (input: {
  readonly repoRoot: string
  readonly hostIo: SyncHostIo
  readonly parentRef: string
  readonly domainFiles: ReadonlyArray<DomainFile>
  readonly targets: ReadonlyArray<DomainFile>
  readonly stageAOnly: boolean
  readonly cacheEnabled: boolean
  readonly cacheAuth: MutationCacheAuth | undefined
  readonly nowMs: MutationEpochMillis
  readonly contextDigests: MutationContextDigests | undefined
  readonly loadedCacheStore: MutationCacheStore | undefined
  readonly cacheEntries: Record<ContentSha256, MutationCacheEntry>
  readonly timingsTracker: SuiteTimingsTracker
  readonly reachabilityCache: Map<string, PackageReachabilityIndex>
  readonly witnessClosureMemo: Map<string, ContentSha256 | null>
  readonly precomputedPartitions?:
    | Map<string, ReturnType<typeof partitionTargetTestsWithTimings>>
    | undefined
}): StackedBaseSuitePreparation =>
  match(
    resolveStackedBaseContext({
      repoRoot: input.repoRoot,
      parentRef: input.parentRef,
      hostIo: input.hostIo,
    }),
  )
    .with({ _tag: "Failed" }, ({ reason }) =>
      emptyStackedPrep("working-tree", {
        abortDiagnostic: `[mutation-check] Failed to extract git diff modified lines: ${reason}`,
      }),
    )
    .with({ _tag: "DirectMain" }, { _tag: "FallbackToMain" }, (res) => {
      if (res.diffMode === "not-git") return emptyStackedPrep("not-git", {})
      const unclassifiedErr = checkUnclassifiedStrictFiles(
        input.repoRoot,
        res.mainDiffLines,
        input.domainFiles,
        input.hostIo,
      )
      if (unclassifiedErr !== undefined) {
        return emptyStackedPrep(res.diffMode, { abortDiagnostic: unclassifiedErr })
      }
      return emptyStackedPrep(res.diffMode, {
        evalDiffLines: res.mainDiffLines,
        allMainDiffLines: res.mainDiffLines,
        ...match(res)
          .with({ _tag: "DirectMain" }, () => ({
            stackedBaseRef: input.parentRef,
            stackedBaseEligible: true,
          }))
          .with({ _tag: "FallbackToMain" }, () => ({}))
          .exhaustive(),
      })
    })
    .with(
      { _tag: "Stacked" },
      ({ parentRef, parentDiffLines, ancestorOnlyLines, combinedMainDiffLines, diffMode }) => {
        const unclassifiedErr = checkUnclassifiedStrictFiles(
          input.repoRoot,
          combinedMainDiffLines,
          input.domainFiles,
          input.hostIo,
        )
        if (unclassifiedErr !== undefined) {
          return emptyStackedPrep(diffMode, { abortDiagnostic: unclassifiedErr })
        }
        return match(
          verifyAncestorLinesAgainstHmacCache({
            repoRoot: input.repoRoot,
            hostIo: input.hostIo,
            targets: input.targets,
            parentDiffLines,
            ancestorOnlyLines,
            stageAOnly: input.stageAOnly,
            cacheEnabled: input.cacheEnabled,
            cacheAuth: input.cacheAuth,
            nowMs: input.nowMs,
            contextDigests: input.contextDigests,
            loadedCacheStore: input.loadedCacheStore,
            cacheEntries: input.cacheEntries,
            timingsTracker: input.timingsTracker,
            reachabilityCache: input.reachabilityCache,
            witnessClosureMemo: input.witnessClosureMemo,
            precomputedPartitions: input.precomputedPartitions,
          }),
        )
          .with({ _tag: "Abort" }, ({ diagnostic }) =>
            emptyStackedPrep(diffMode, {
              abortDiagnostic: diagnostic,
              stackedBaseRef: parentRef,
            }),
          )
          .with(
            { _tag: "Ok" },
            ({
              evalDiffLines,
              verifiedAncestorOutcomes,
              verifiedAncestorEvaluatedFiles,
              ancestorVerifiedMutantCount,
              ancestorExpandedMutantCount,
              dirtiedCache,
            }) =>
              emptyStackedPrep(diffMode, {
                evalDiffLines,
                allMainDiffLines: combinedMainDiffLines,
                verifiedAncestorOutcomes,
                verifiedAncestorEvaluatedFiles,
                ancestorVerifiedMutantCount,
                ancestorExpandedMutantCount,
                stackedBaseRef: parentRef,
                stackedBaseEligible: true,
                dirtiedCache,
              }),
          )
          .exhaustive()
      },
    )
    .exhaustive()

/**
 * Resolves either stacked-PR base diff/ancestor verification or standard suite diff + unclassified
 * file checks, keeping `mutation-check.ts` concise.
 */
export const resolveSuiteDiffOrStackedBase = (input: {
  readonly repoRoot: string
  readonly hostIo: SyncHostIo
  readonly hasOverlays: boolean
  readonly suiteOptions: {
    readonly targetFiles?: ReadonlyArray<string> | undefined
    readonly diffOnly?: boolean | undefined
    readonly includeAllLines?: boolean | undefined
    readonly baseRef?: string | undefined
    readonly explicitBaseRef?: boolean | undefined
    readonly scope?: string | undefined
    readonly stageAOnly?: boolean | undefined
  }
  readonly isStrictMode: boolean
  readonly domainFiles: ReadonlyArray<DomainFile>
  readonly targets: ReadonlyArray<DomainFile>
  readonly unclassifiedPackages: ReadonlyArray<string>
  readonly cacheCtx: {
    readonly cacheEnabled: boolean
    readonly enabledCacheAuth: MutationCacheAuth | undefined
    readonly nowMs: MutationEpochMillis
    readonly contextDigests: MutationContextDigests | undefined
    readonly loadedCacheStore: MutationCacheStore | undefined
    readonly cacheEntries: Record<ContentSha256, MutationCacheEntry>
  }
  readonly timingsTracker: SuiteTimingsTracker
  readonly reachabilityCache: Map<string, PackageReachabilityIndex>
  readonly witnessClosureMemo: Map<string, ContentSha256 | null>
  readonly precomputedPartitions: Map<string, ReturnType<typeof partitionTargetTestsWithTimings>>
}): {
  readonly stackedPrep?: StackedBaseSuitePreparation | undefined
  readonly diffMode: MutationSuiteReport["diffMode"]
  readonly evalDiffLines: ReadonlyMap<string, ReadonlySet<number>> | undefined
  readonly allMainDiffLines: ReadonlyMap<string, ReadonlySet<number>> | undefined
  readonly abortDiagnostic?: string | undefined
} => {
  const opts = input.suiteOptions
  const hasTargetFilesOpt = opts.targetFiles !== undefined
  const isExplicitTarget = (opts.targetFiles?.length ?? 0) > 0
  const useStackedBase =
    input.isStrictMode &&
    opts.explicitBaseRef === true &&
    opts.baseRef !== undefined &&
    !input.hasOverlays &&
    !isExplicitTarget &&
    opts.scope === undefined &&
    opts.diffOnly !== true &&
    opts.includeAllLines !== true

  if (useStackedBase && opts.baseRef !== undefined) {
    const stackedPrep = prepareStackedBaseForSuite({
      repoRoot: input.repoRoot,
      hostIo: input.hostIo,
      parentRef: opts.baseRef,
      domainFiles: input.domainFiles,
      targets: input.targets,
      stageAOnly: opts.stageAOnly === true,
      cacheEnabled: input.cacheCtx.cacheEnabled,
      cacheAuth: input.cacheCtx.enabledCacheAuth,
      nowMs: input.cacheCtx.nowMs,
      contextDigests: input.cacheCtx.contextDigests,
      loadedCacheStore: input.cacheCtx.loadedCacheStore,
      cacheEntries: input.cacheCtx.cacheEntries,
      timingsTracker: input.timingsTracker,
      reachabilityCache: input.reachabilityCache,
      witnessClosureMemo: input.witnessClosureMemo,
      precomputedPartitions: input.precomputedPartitions,
    })
    return {
      stackedPrep,
      diffMode: stackedPrep.diffMode,
      evalDiffLines: stackedPrep.evalDiffLines,
      allMainDiffLines: stackedPrep.allMainDiffLines,
      abortDiagnostic: stackedPrep.abortDiagnostic,
    }
  }

  const resolvedDiff = match(
    resolveSuiteDiff({
      repoRoot: input.repoRoot,
      hostIo: input.hostIo,
      hasOverlays: input.hasOverlays,
      isExplicitTarget,
      diffOnly: opts.diffOnly,
      includeAllLines: opts.includeAllLines,
      baseRef: opts.baseRef,
      explicitBaseRef: opts.explicitBaseRef,
      isStrictMode: input.isStrictMode,
    }),
  )
    .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
    .with({ _tag: "Ok" }, (ok) => ok)
    .exhaustive()
  if (typeof resolvedDiff === "string") {
    return {
      diffMode: "working-tree",
      evalDiffLines: undefined,
      allMainDiffLines: undefined,
      abortDiagnostic: resolvedDiff,
    }
  }
  const strictDiffLines =
    input.isStrictMode && opts.scope === undefined && !hasTargetFilesOpt
      ? resolvedDiff.diffLinesMap
      : undefined
  if (strictDiffLines !== undefined) {
    const unclassifiedErr = checkUnclassifiedStrictFiles(
      input.repoRoot,
      strictDiffLines,
      input.domainFiles,
      input.hostIo,
    )
    if (unclassifiedErr !== undefined) {
      return {
        diffMode: resolvedDiff.diffMode,
        evalDiffLines: resolvedDiff.diffLinesMap,
        allMainDiffLines: resolvedDiff.diffLinesMap,
        abortDiagnostic: unclassifiedErr,
      }
    }
  }
  if (strictDiffLines === undefined && input.unclassifiedPackages.length > 0) {
    process.stderr.write(
      `[mutation-check] Warning: Skipped unclassified library package(s): ${input.unclassifiedPackages.join(", ")}\n`,
    )
  }
  return {
    diffMode: resolvedDiff.diffMode,
    evalDiffLines: resolvedDiff.diffLinesMap,
    allMainDiffLines: resolvedDiff.diffLinesMap,
  }
}

/** Formats optional stacked-base report metadata fields for `MutationSuiteReport`. */
export const formatStackedBaseReportFields = (
  stackedPrep: StackedBaseSuitePreparation | undefined,
  passed: boolean,
  earlyTerminated: boolean | undefined,
  stageAOnly: boolean | undefined,
): Pick<
  MutationSuiteReport,
  | "stackedBaseRef"
  | "stackedBaseVerified"
  | "ancestorVerifiedMutantCount"
  | "ancestorExpandedMutantCount"
> => {
  if (stackedPrep === undefined) return {}
  return {
    ...(stackedPrep.stackedBaseRef !== undefined
      ? { stackedBaseRef: stackedPrep.stackedBaseRef }
      : {}),
    stackedBaseVerified:
      stackedPrep.stackedBaseEligible && passed && earlyTerminated !== true && stageAOnly !== true,
    ancestorVerifiedMutantCount: stackedPrep.ancestorVerifiedMutantCount,
    ancestorExpandedMutantCount: stackedPrep.ancestorExpandedMutantCount,
  }
}

/** Applies verified ancestor outcomes and file tracking from `StackedBaseSuitePreparation`. */
export const applyStackedBaseOutcomes = (
  stackedPrep: StackedBaseSuitePreparation | undefined,
  outcomes: Array<MutantOutcome>,
  evaluatedFiles: Array<string>,
  evaluatedFilesSet: Set<string>,
): { readonly cachedKilledDelta: number; readonly dirtiedCache: boolean } => {
  if (stackedPrep === undefined) return { cachedKilledDelta: 0, dirtiedCache: false }
  outcomes.push(...stackedPrep.verifiedAncestorOutcomes)
  for (const rel of stackedPrep.verifiedAncestorEvaluatedFiles) {
    if (!evaluatedFilesSet.has(rel)) {
      evaluatedFilesSet.add(rel)
      evaluatedFiles.push(rel)
    }
  }
  return {
    cachedKilledDelta: stackedPrep.ancestorVerifiedMutantCount,
    dirtiedCache: stackedPrep.dirtiedCache,
  }
}
