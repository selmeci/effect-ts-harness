/**
 * @fileoverview Mutation verification gate, mutant discovery, test execution, and span saturation analysis.
 */
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  type ContentSha256,
  type MutationCacheAuth,
  type MutationCacheEntry,
  MutationEpochMillis,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { runCustomTestRunner, stripAnsi } from "./mutation-subprocess-helpers.js"
import {
  getActiveMutantId,
  setActiveMutantId,
  withActiveMutantEffect,
} from "./services/active-mutant-context.js"
import {
  CodeMutant,
  compileMutantSchemaModule,
  discoverDomainMutants,
  evaluateMutantSchemaInProcess,
  MutantCategory,
  MutantId,
  MutantOutcome,
  MutantSourceText,
  type MutantSchemaModule,
  parseGitDiffModifiedLines,
} from "./mutation/mutant-ast-generator.js"
import {
  extractGitDiffModifiedLines,
  recoverBackupIfPresent,
  recoverStartupBackup,
} from "./mutation/mutation-backup.js"
import {
  applyFileOutcomesAndRecordKills,
  flushMutationCache,
  hydrateFileMutantCacheHits,
  initSuiteCacheContext,
  partitionTargetTestsWithTimings,
  preparePackageBaselines,
  resolveTargetsForSuite,
} from "./mutation/mutation-suite-helpers.js"
import {
  type PreparedMutationTarget,
  buildMutationSubprocessEnv,
  readAndCompileTargetMutants,
  readLastSurvivorIds,
  toQueuedMutationBatchEntry,
  writeLastSurvivorIds,
} from "./mutation/mutation-two-tier-cache.js"
import {
  applyStackedBaseOutcomes,
  formatStackedBaseReportFields,
  resolveSuiteDiffOrStackedBase,
  type StackedBaseSuitePreparation,
} from "./mutation/mutation-stacked-base.js"
import { createSuiteTimingsTracker } from "./mutation/mutation-test-timings.js"
import { formatSurvivorLine } from "./mutation/mutation-witness.js"
import type { PackageReachabilityIndex } from "./mutation/mutation-test-reachability.js"
import {
  executeQueuedPackageBatches,
  type PackageBatchFileResult,
  type QueuedPackageEntry,
  runSingleFileVitestPass,
} from "./mutation/mutation-package-batch.js"
import {
  decideMutationCheck,
  decideMutationReport,
  evaluateMutationOutcomes,
  evaluateSpanSaturationViolations,
  isMutantMarkedEquivalent,
  normalizePriorMillis,
  type MutationEvaluationInput,
  type MutationOutcomesSummary,
  type MutationSuiteReport,
  type SaturationViolation,
  type SpanSaturationObservation,
  type SpanSaturationSpec,
  type TraceSpanObservation,
  type UntestedMutationFile,
} from "./mutation/mutation-outcomes.js"
import {
  type DomainFile,
  findDomainFiles,
  findReachingTestFiles,
  findReachingTestFilesChecked,
  findUnclassifiedModifiedLibFiles,
  partitionReachingTestFiles,
} from "./mutation/mutation-target-discovery.js"

export {
  stripAnsi,
  MutantCategory,
  MutantId,
  MutantSourceText,
  CodeMutant,
  MutantOutcome,
  type MutantSchemaModule,
  type DomainFile,
  type SpanSaturationSpec,
  type TraceSpanObservation,
  type SaturationViolation,
  type SpanSaturationObservation,
  type MutationEvaluationInput,
  type UntestedMutationFile,
  type MutationOutcomesSummary,
  type MutationSuiteReport,
  evaluateSpanSaturationViolations,
  normalizePriorMillis,
  isMutantMarkedEquivalent,
  evaluateMutationOutcomes,
  decideMutationReport,
  decideMutationCheck,
  getActiveMutantId,
  setActiveMutantId,
  parseGitDiffModifiedLines,
  discoverDomainMutants,
  compileMutantSchemaModule,
  evaluateMutantSchemaInProcess,
  findDomainFiles,
  findReachingTestFiles,
  findUnclassifiedModifiedLibFiles,
  partitionReachingTestFiles,
  extractGitDiffModifiedLines,
}

export const getWorkspaceGitDiffModifiedLines = extractGitDiffModifiedLines

export const collectReachingTestAssertions = (
  repoRoot: string,
  file: DomainFile,
  hostIo: SyncHostIo,
): string =>
  findReachingTestFiles(repoRoot, file, hostIo)
    .map((full) => hostIo.readTextSync(full))
    .join("\n")

export interface RunMutationOptions {
  readonly scope?: string | undefined
  readonly includeAllLines?: boolean | undefined
  readonly diffOnly?: boolean | undefined
  readonly enforcementMode?: "strict" | "advisory" | undefined
  readonly targetFiles?: ReadonlyArray<string> | undefined
  readonly baseRef?: string | undefined
  readonly explicitBaseRef?: boolean | undefined
  readonly minScore?: number | undefined
  readonly failFast?: boolean | undefined
  readonly maxSurvivors?: number | undefined
  readonly suppressSurvivorStderr?: boolean | undefined
  readonly stageAOnly?: boolean | undefined
  readonly survivorsOnly?: boolean | undefined
  readonly disableMutantCache?: boolean | undefined
  readonly enableMutantCache?: boolean | undefined
  readonly cacheAuth?: MutationCacheAuth | undefined
  readonly nowMs?: MutationEpochMillis | undefined
  readonly testRunner?:
    | ((
        mutant: CodeMutant,
        schemaSource: string,
        reachingTestFiles: ReadonlyArray<string>,
      ) => "killed" | "survived")
    | undefined
  readonly spanObservations?: ReadonlyArray<SpanSaturationObservation> | undefined
  readonly saturationSpecs?: ReadonlyArray<SpanSaturationSpec> | undefined
  readonly equivalencePriors?: Readonly<Record<string, number>> | undefined
  readonly sourceCodeOverlays?: Readonly<Record<string, string>> | undefined
}

export const runDomainMutationSuite = (
  repoRoot: string,
  hostIo: SyncHostIo,
  options?: RunMutationOptions,
): MutationSuiteReport => {
  let diffMode: MutationSuiteReport["diffMode"] = "working-tree"
  let scannedCandidateFiles = 0
  const scannedFiles: Array<string> = []
  const diffMatchedFiles: Array<string> = []
  const evaluatedFiles: Array<string> = []
  const evaluatedFilesSet = new Set<string>()
  const untestedFiles: Array<UntestedMutationFile> = []

  let cachedKilledCount = 0
  let stackedPrep: StackedBaseSuitePreparation | undefined = undefined

  const isStrictMode = match(options?.enforcementMode)
    .with("strict", () => true)
    .with("advisory", undefined, () => false)
    .exhaustive()

  const makeReport = (
    outcomesSoFar: ReadonlyArray<MutantOutcome>,
    extra: {
      readonly passed?: false
      readonly earlyTerminated?: boolean
      readonly diagnostic?: string
    },
  ): MutationSuiteReport => {
    const summary = evaluateMutationOutcomes(
      outcomesSoFar,
      options?.minScore,
      options?.equivalencePriors,
      options?.saturationSpecs,
      options?.spanObservations,
      extra.earlyTerminated,
      survivorLimit,
    )
    return {
      ...summary,
      ...extra,
      ...(options?.stageAOnly !== undefined ? { stageAOnly: options.stageAOnly } : {}),
      ...formatStackedBaseReportFields(
        stackedPrep,
        extra.passed === false ? false : summary.passed,
        extra.earlyTerminated,
        options?.stageAOnly,
      ),
      cachedKilledCount,
      diffMode,
      scannedCandidateFiles,
      scannedFiles,
      diffMatchedFiles,
      evaluatedFiles,
      ...(untestedFiles.length > 0 ? { untestedFiles } : {}),
    }
  }
  const survivorLimit = options?.maxSurvivors ?? (options?.failFast === true ? 1 : undefined)
  const timingsTracker = createSuiteTimingsTracker(repoRoot, hostIo)
  let flushCacheIfDirty: () => void = () => {}
  const rawOverlays = options?.sourceCodeOverlays
  const hasOverlays = rawOverlays !== undefined
  const normalizedOverlays = new Map<string, string>(
    Object.entries(rawOverlays ?? {}).map(([k, v]) => [
      k.replace(/\\/g, "/").replace(/^\.\//, ""),
      v,
    ]),
  )
  const backupPath = join(repoRoot, ".harness", "mutation-backup.json")
  const resolvedBackupPath = resolve(backupPath)

  const abortWith = (
    outcomesSoFar: ReadonlyArray<MutantOutcome>,
    diagnostic: string,
    abortOpts?: { readonly skipBackupRecovery?: boolean },
  ): MutationSuiteReport => {
    const recoverErr =
      abortOpts?.skipBackupRecovery === true
        ? undefined
        : recoverBackupIfPresent(repoRoot, backupPath, hasOverlays, hostIo)
    const finalDiagnostic = recoverErr !== undefined ? `${diagnostic}; ${recoverErr}` : diagnostic
    flushCacheIfDirty()
    timingsTracker.flushIfDirty()
    process.stderr.write(`${finalDiagnostic}\n`)
    return makeReport(outcomesSoFar, { passed: false, diagnostic: finalDiagnostic })
  }
  if (
    options?.maxSurvivors !== undefined &&
    (!Number.isInteger(options.maxSurvivors) || options.maxSurvivors < 1)
  ) {
    return abortWith(
      [],
      `[mutation-check] Invalid maxSurvivors '${String(options.maxSurvivors)}': expected a positive integer >= 1.`,
    )
  }

  const startupDiag =
    !hasOverlays && hostIo.getEnv()["HARNESS_ACTIVE_BACKUP_PATH"] !== resolvedBackupPath
      ? recoverStartupBackup(repoRoot, backupPath, hostIo)
      : undefined
  if (startupDiag !== undefined) return abortWith([], startupDiag, { skipBackupRecovery: true })

  const targetFilesOpt = options?.targetFiles
  const isExplicitTarget = (targetFilesOpt?.length ?? 0) > 0
  const resolvedTargets = resolveTargetsForSuite({
    repoRoot,
    hostIo,
    scope: options?.scope,
    targetFiles: targetFilesOpt,
    hasOverlays,
    normalizedOverlays,
    isStrictMode,
  })
  const targetsOrAbort = match(resolvedTargets)
    .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
    .with({ _tag: "Ok" }, (ok) => ok)
    .exhaustive()
  if (typeof targetsOrAbort === "string") return abortWith([], targetsOrAbort)
  const { domainFiles, targets, unclassifiedPackages } = targetsOrAbort
  scannedCandidateFiles = targets.length

  const suiteNowMs = options?.nowMs ?? MutationEpochMillis.make(Date.now())
  const cacheRequested =
    options?.disableMutantCache !== true &&
    !hasOverlays &&
    options?.testRunner === undefined &&
    (options?.enableMutantCache ?? true)
  const cacheCtx = {
    ...initSuiteCacheContext(repoRoot, hostIo, cacheRequested, options?.cacheAuth),
    nowMs: suiteNowMs,
    cacheEntries: {} as Record<ContentSha256, MutationCacheEntry>,
  }
  const { enabledCacheAuth, contextDigests, cacheEnabled, loadedCacheStore, cacheEntries } =
    cacheCtx
  let cacheDirty = false
  flushCacheIfDirty = () => {
    if (!cacheEnabled || !cacheDirty || enabledCacheAuth === undefined) return
    // flushMutationCache already emits a stderr warning when persistence returns false.
    if (flushMutationCache(repoRoot, hostIo, enabledCacheAuth, cacheEntries)) cacheDirty = false
  }
  const witnessClosureMemo = new Map<string, ContentSha256 | null>()
  const sourceClosureMemo = new Map<string, ContentSha256 | null>()
  const priorSurvivorIds =
    options?.survivorsOnly === true ? readLastSurvivorIds(repoRoot, hostIo) : undefined
  const reachabilityCache = new Map<string, PackageReachabilityIndex>()
  const precomputedPartitions = new Map<
    string,
    ReturnType<typeof partitionTargetTestsWithTimings>
  >()
  const outcomes: Array<MutantOutcome> = []

  const diffPrep = resolveSuiteDiffOrStackedBase({
    repoRoot,
    hostIo,
    hasOverlays,
    suiteOptions: options ?? {},
    isStrictMode,
    domainFiles,
    targets,
    unclassifiedPackages,
    cacheCtx,
    timingsTracker,
    reachabilityCache,
    witnessClosureMemo,
    precomputedPartitions,
  })
  stackedPrep = diffPrep.stackedPrep
  diffMode = diffPrep.diffMode
  const diffLinesMap = diffPrep.evalDiffLines
  const allMainDiffLines = diffPrep.allMainDiffLines
  if (stackedPrep !== undefined) {
    const prepAbort = match(stackedPrep)
      .with({ _tag: "Abort" }, ({ abortDiagnostic }) => abortDiagnostic)
      .with({ _tag: "Ok" }, () => {
        const appliedStacked = applyStackedBaseOutcomes(
          stackedPrep,
          outcomes,
          evaluatedFiles,
          evaluatedFilesSet,
        )
        if (appliedStacked.dirtiedCache) cacheDirty = true
        cachedKilledCount += appliedStacked.cachedKilledDelta
        return undefined
      })
      .exhaustive()
    if (prepAbort !== undefined) return abortWith(outcomes, prepAbort)
  }
  if (diffPrep.abortDiagnostic !== undefined) return abortWith(outcomes, diffPrep.abortDiagnostic)

  const baseSubprocessEnv = buildMutationSubprocessEnv(hostIo, resolvedBackupPath)

  const globalBypassDiffFilter =
    options?.includeAllLines === true || (isExplicitTarget && options?.diffOnly !== true)
  const hasPackageBatchInfra =
    !hasOverlays &&
    options?.testRunner === undefined &&
    hostIo.existsSync(join(repoRoot, "tools", "package-vitest-batch.mjs")) &&
    hostIo.existsSync(join(repoRoot, "node_modules", "vitest", "vitest.mjs"))
  const queuedByPkg = new Map<string, Array<QueuedPackageEntry>>()
  let earlyTerminated = false
  let earlyReport: MutationSuiteReport | undefined = undefined

  const getConfirmedSurvivors = () =>
    outcomes.filter((o) =>
      match(o.status)
        .with("survived", () => !isMutantMarkedEquivalent(o, options?.equivalencePriors))
        .with("killed", "equivalent", () => false)
        .exhaustive(),
    )
  const checkSurvivorLimit = (): MutationSuiteReport | undefined => {
    if (survivorLimit === undefined) return undefined
    const confirmed = getConfirmedSurvivors()
    if (confirmed.length < survivorLimit) return undefined
    if (!earlyTerminated) {
      earlyTerminated = true
      if (options?.suppressSurvivorStderr !== true) {
        for (const o of confirmed) process.stderr.write(`${formatSurvivorLine(o.mutant)}\n`)
      }
      flushCacheIfDirty()
      timingsTracker.flushIfDirty()
      earlyReport = makeReport(outcomes, {
        passed: false,
        earlyTerminated: true,
        diagnostic: `[mutation-check] Early termination: ${confirmed.length} confirmed survivor(s) reached limit ${survivorLimit}.`,
      })
    }
    return earlyReport
  }
  const recordOutcomesForFile = (
    mutants: ReadonlyArray<CodeMutant>,
    uncachedMutants: ReadonlyArray<CodeMutant>,
    mutantKeys: ReadonlyMap<string, ContentSha256>,
    result: PackageBatchFileResult,
    requireAllOutcomes: boolean,
  ): string | undefined =>
    applyFileOutcomesAndRecordKills({
      relFile: result.file.relFile,
      mutants,
      uncachedMutants,
      mutantKeys,
      fileOutcomes: result.fileOutcomes,
      fileNonCacheableIds: result.fileNonCacheableIds,
      witnessByMutantId: result.witnessByMutantId,
      repoRoot,
      contextDigests,
      hostIo,
      enabledCacheAuth,
      nowMs: suiteNowMs,
      cacheEntries,
      witnessClosureMemo,
      outcomes,
      markDirty: () => {
        cacheDirty = true
      },
      flushCache: flushCacheIfDirty,
      requireAllOutcomes,
    })

  const uncachedFilesSet = new Set<string>()
  const pkgEvalFileCounts = new Map<string, number>()
  const preparedTargets: Array<PreparedMutationTarget> = []

  for (const file of targets) {
    const overlaySource = normalizedOverlays.get(file.relFile)
    const inMainDiff = (allMainDiffLines ?? diffLinesMap)?.has(file.relFile) === true
    const inEvalDiff = diffLinesMap !== undefined && diffLinesMap.has(file.relFile)
    if (inMainDiff || inEvalDiff) diffMatchedFiles.push(file.relFile)
    const bypassDiffFilter = overlaySource !== undefined || globalBypassDiffFilter
    if (!bypassDiffFilter && diffLinesMap !== undefined && !inEvalDiff) {
      if (inMainDiff) scannedFiles.push(file.relFile)
      continue
    }
    scannedFiles.push(file.relFile)
    const modifiedLines = bypassDiffFilter ? undefined : diffLinesMap?.get(file.relFile)
    const compiledTarget = readAndCompileTargetMutants({
      file,
      overlaySource,
      modifiedLines,
      priorSurvivorIds,
      hostIo,
    })
    const compiledRes = match(compiledTarget)
      .with({ _tag: "Skip" }, () => "skip" as const)
      .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
      .with({ _tag: "Ok" }, (ok) => ok)
      .exhaustive()
    if (compiledRes === "skip") continue
    if (typeof compiledRes === "string") return abortWith(outcomes, compiledRes)
    const { originalContent, mutants, schemaBundle } = compiledRes
    if (!evaluatedFilesSet.has(file.relFile)) {
      evaluatedFilesSet.add(file.relFile)
      evaluatedFiles.push(file.relFile)
    }
    if (overlaySource !== undefined && options?.testRunner === undefined) {
      for (const mutant of mutants) outcomes.push({ mutant, status: "survived" })
      const early = checkSurvivorLimit()
      if (early !== undefined) return early
      continue
    }
    if (options?.testRunner !== undefined) {
      const reachingTestFiles = match(findReachingTestFilesChecked(repoRoot, file, hostIo))
        .with({ _tag: "Ok" }, ({ files }) => files)
        .with({ _tag: "Error" }, ({ reason }) => reason)
        .exhaustive()
      if (typeof reachingTestFiles === "string") {
        return abortWith(outcomes, `[mutation-check] ${reachingTestFiles}`)
      }
      if (reachingTestFiles.length === 0) {
        untestedFiles.push({
          file: file.relFile,
          reason: `0 reaching tests found for '${file.relFile}'`,
        })
        continue
      }
      const runnerDiag = runCustomTestRunner(
        file,
        originalContent,
        schemaBundle.schemaSource,
        mutants,
        reachingTestFiles,
        options.testRunner,
        outcomes,
      )
      if (runnerDiag !== undefined) return abortWith(outcomes, runnerDiag)
      const early = checkSurvivorLimit()
      if (early !== undefined) return early
      continue
    }
    const partRes = partitionTargetTestsWithTimings({
      repoRoot,
      file,
      sourceContent: originalContent,
      hostIo,
      reachabilityCache,
      timingsTracker,
    })
    const partition = match(partRes)
      .with({ _tag: "Ok" }, ({ partition: p }) => p)
      .with({ _tag: "Error" }, ({ reason }) => reason)
      .exhaustive()
    if (typeof partition === "string") return abortWith(outcomes, `[mutation-check] ${partition}`)
    precomputedPartitions.set(file.relFile, partRes)
    const primaryTests = partition.primaryTests
    const scopedFallbackTests = options?.stageAOnly === true ? [] : partition.scopedFallbackTests
    const packageFallbackTests = options?.stageAOnly === true ? [] : partition.packageFallbackTests
    const fallbackTests = options?.stageAOnly === true ? [] : partition.fallbackTests
    if (primaryTests.length === 0 && fallbackTests.length === 0) {
      untestedFiles.push({
        file: file.relFile,
        reason: `0 reaching tests found for '${file.relFile}'`,
      })
      continue
    }
    const { mutantKeys, cachedHitIds, dirtiedCache } = hydrateFileMutantCacheHits({
      repoRoot,
      file,
      originalContent,
      schemaSource: schemaBundle.schemaSource,
      mutants,
      allReachingTests: [...primaryTests, ...fallbackTests],
      hostIo,
      cacheEnabled,
      cacheAuth: enabledCacheAuth,
      nowMs: suiteNowMs,
      contextDigests,
      loadedCacheStore,
      cacheEntries,
      witnessClosureMemo,
      sourceClosureMemo,
    })
    if (dirtiedCache) cacheDirty = true
    const uncachedMutants = mutants.filter((m) => !cachedHitIds.has(m.id))
    cachedKilledCount += mutants.length - uncachedMutants.length
    if (uncachedMutants.length > 0) uncachedFilesSet.add(file.relFile)
    const pkgKey = `${file.scope}/${file.pkgDir}`
    pkgEvalFileCounts.set(pkgKey, (pkgEvalFileCounts.get(pkgKey) ?? 0) + 1)
    preparedTargets.push({
      file,
      pkgKey,
      originalContent,
      schemaSource: schemaBundle.schemaSource,
      mutants,
      uncachedMutants,
      mutantKeys,
      primaryTests,
      scopedFallbackTests,
      packageFallbackTests,
      cachedHitIds,
    })
  }

  const baselinePrepRes =
    !hasOverlays && options?.testRunner === undefined && preparedTargets.length > 0
      ? preparePackageBaselines({
          repoRoot,
          targets: preparedTargets.map((p) => p.file),
          hostIo,
          baseSubprocessEnv,
          diffLinesMap,
          bypassDiffFilter: globalBypassDiffFilter,
          uncachedFilesSet,
          precomputedPartitions,
          onObservedDurations: (pkgKey, obs) => timingsTracker.recordObserved(pkgKey, obs),
        })
      : undefined
  const baselinePrep =
    baselinePrepRes === undefined
      ? undefined
      : match(baselinePrepRes)
          .with({ _tag: "Ok" }, (ok) => ok)
          .with(
            { _tag: "ReadError" },
            ({ relFile, reason }) =>
              `[mutation-check] Failed to read source file '${relFile}': ${reason}`,
          )
          .exhaustive()
  if (typeof baselinePrep === "string") return abortWith(outcomes, baselinePrep)

  const queueBatchEntry = (prep: PreparedMutationTarget) => {
    const list = queuedByPkg.get(prep.pkgKey) ?? []
    list.push(toQueuedMutationBatchEntry(prep))
    queuedByPkg.set(prep.pkgKey, list)
  }

  for (const prep of preparedTargets) {
    if (earlyTerminated) break
    const pkgBaselinePassed = baselinePrep?.passedPackageBaselines.has(prep.pkgKey) === true
    const evalCountInPkg = pkgEvalFileCounts.get(prep.pkgKey) ?? 0
    if (prep.uncachedMutants.length === 0 && evalCountInPkg >= 2) {
      const cachedOutcomes = new Map<string, MutantOutcome>(
        prep.mutants.map((m) => [m.id, { mutant: m, status: "killed" as const }]),
      )
      const finErr = recordOutcomesForFile(
        prep.mutants,
        prep.uncachedMutants,
        prep.mutantKeys,
        {
          file: prep.file,
          fileOutcomes: cachedOutcomes,
          fileNonCacheableIds: new Set(),
          witnessByMutantId: new Map(),
        },
        true,
      )
      if (finErr !== undefined) return abortWith(outcomes, finErr)
      continue
    }
    if (hasPackageBatchInfra && pkgBaselinePassed && prep.uncachedMutants.length > 0) {
      queueBatchEntry(prep)
      continue
    }
    const singlePass = runSingleFileVitestPass({
      repoRoot,
      backupPath,
      hostIo,
      baseSubprocessEnv,
      file: prep.file,
      originalContent: prep.originalContent,
      schemaSource: prep.schemaSource,
      mutants: prep.mutants,
      uncachedMutants: prep.uncachedMutants,
      primaryTests: prep.primaryTests,
      scopedFallbackTests: prep.scopedFallbackTests,
      packageFallbackTests: prep.packageFallbackTests,
      cachedHitIds: prep.cachedHitIds,
      pkgBaselinePassed,
    })
    const singleErr = match(singlePass)
      .with({ _tag: "Abort" }, ({ partialResult, diagnostic }) => {
        recordOutcomesForFile(
          prep.mutants,
          prep.uncachedMutants,
          prep.mutantKeys,
          partialResult,
          false,
        )
        return diagnostic
      })
      .with({ _tag: "Ok" }, ({ result, observedDurationsMs }) => {
        if (observedDurationsMs.size > 0)
          timingsTracker.recordObserved(prep.pkgKey, observedDurationsMs)
        return recordOutcomesForFile(
          prep.mutants,
          prep.uncachedMutants,
          prep.mutantKeys,
          result,
          true,
        )
      })
      .exhaustive()
    if (singleErr !== undefined) return abortWith(outcomes, singleErr)
    const early = checkSurvivorLimit()
    if (early !== undefined) return early
  }

  const batchAbort = executeQueuedPackageBatches({
    repoRoot,
    backupPath,
    hostIo,
    baseSubprocessEnv,
    queuedByPkg,
    finalizeEntry: (entry, result, finalizeOpts) => {
      const finErr = recordOutcomesForFile(
        entry.input.mutants,
        entry.input.uncachedMutants,
        entry.mutantKeys,
        result,
        true,
      )
      if (finErr !== undefined) return finErr
      if (finalizeOpts?.skipSurvivorLimit !== true) checkSurvivorLimit()
      return undefined
    },
    recordPartialOnAbort: (entry, partialResult) => {
      recordOutcomesForFile(
        entry.input.mutants,
        entry.input.uncachedMutants,
        entry.mutantKeys,
        partialResult,
        false,
      )
    },
    onBatchFlushed: () => {
      flushCacheIfDirty()
    },
    isEarlyStopped: () => earlyTerminated,
    getMeasuredDurationsRecord: (pkgKey, entries) =>
      Object.fromEntries(
        timingsTracker.lookupForPackage(
          pkgKey,
          entries.flatMap((e) => [
            ...e.input.primaryTests,
            ...e.input.scopedFallbackTests,
            ...e.input.packageFallbackTests,
          ]),
        ),
      ),
    onObservedTestDurations: (pkgKey, obs) => timingsTracker.recordObserved(pkgKey, obs),
    getRemainingSurvivorBudget: (entries) => {
      if (survivorLimit === undefined) return undefined
      const eqCount = entries
        .flatMap((e) => e.input.uncachedMutants)
        .filter((m) => normalizePriorMillis(options?.equivalencePriors?.[m.id] ?? 0) >= 850).length
      return Math.max(1, survivorLimit - getConfirmedSurvivors().length) + eqCount
    },
  })
  if (batchAbort !== undefined) return abortWith(outcomes, batchAbort)
  if (earlyReport !== undefined) return earlyReport

  flushCacheIfDirty()
  timingsTracker.flushIfDirty()
  if (!hasOverlays && options?.testRunner === undefined) {
    writeLastSurvivorIds(
      repoRoot,
      getConfirmedSurvivors().map((o) => o.mutant.id),
      hostIo,
    )
  }

  if (isStrictMode && untestedFiles.length > 0) {
    return abortWith(
      outcomes,
      `[mutation-check] Untested modified file(s) in strict mode (0 reaching tests): ${untestedFiles.map((u) => u.file).join(", ")}`,
    )
  }
  if (isStrictMode && options?.survivorsOnly !== true && outcomes.length === 0) {
    return abortWith(
      outcomes,
      "[mutation-check] Zero mutants evaluated in strict mode (SPEC-0018 REQ-2.2).",
    )
  }

  return makeReport(outcomes, {})
}

/** Effect-traced `MutationCheck.run` wrapper delegating to `runDomainMutationSuite` (`SPEC-0037 REQ-3.1..REQ-3.4`). */
export const runMutationCheck = Effect.fn("MutationCheck.run")(function* (
  repoRoot: string,
  hostIo: SyncHostIo,
  options?: RunMutationOptions,
) {
  return yield* Effect.succeed(runDomainMutationSuite(repoRoot, hostIo, options))
})

export const MutationCheck = {
  decide: decideMutationCheck,
  evaluateReport: evaluateMutationOutcomes,
  run: runMutationCheck,
  runSuite: runDomainMutationSuite,
  withActiveMutant: withActiveMutantEffect,
} as const
