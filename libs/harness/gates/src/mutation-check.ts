/**
 * @fileoverview Mutation verification gate, mutant discovery, test execution, and span saturation analysis.
 */
import { join, resolve } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  type ContentSha256,
  type MutationCacheAuth,
  type MutationCacheEntry,
  MutationEpochMillis,
  SourceLineNumber,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { runVitestTargetList, stripAnsi } from "./mutation-subprocess-helpers.js"
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
  verifyMutantSchemaSyntax,
} from "./mutation/mutant-ast-generator.js"
import {
  extractGitDiffModifiedLinesChecked,
  recoverStartupBackup,
} from "./mutation/mutation-backup.js"
import {
  computeMutationContextDigestsChecked,
  loadMutationCache,
} from "./mutation/mutation-cache.js"
import {
  checkUnclassifiedStrictFiles,
  collectOrderedFileOutcomes,
  flushMutationCache,
  hydrateFileMutantCacheHits,
  preparePackageBaselines,
  recordKilledMutantsToCache,
  resolveSuiteDiff,
  resolveTargetsForSuite,
} from "./mutation/mutation-suite-helpers.js"
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
  partitionReachingTestFilesChecked,
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
}

export const extractGitDiffModifiedLines = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyMap<string, ReadonlySet<number>> | undefined =>
  match(extractGitDiffModifiedLinesChecked(repoRoot, hostIo))
    .with({ _tag: "Ok" }, ({ lines }) => lines)
    .with({ _tag: "NotGit" }, () => undefined)
    .with({ _tag: "Failed" }, () => undefined)
    .exhaustive()

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

const runCustomTestRunner = (
  file: DomainFile,
  originalContent: string,
  schemaSource: string,
  mutants: ReadonlyArray<CodeMutant>,
  reachingTestFiles: ReadonlyArray<string>,
  runner: NonNullable<RunMutationOptions["testRunner"]>,
  outcomes: Array<MutantOutcome>,
): string | undefined => {
  const prevGlobal = getActiveMutantId()
  const restoreInProcessEnv = () => {
    setActiveMutantId(prevGlobal)
  }
  const baselineMutant: CodeMutant = {
    id: MutantId.make("__baseline__"),
    file: AstSourceFilePath.make(file.relFile),
    line: SourceLineNumber.make(1),
    category: "boolean-return",
    original: MutantSourceText.make(""),
    replacement: MutantSourceText.make(""),
    mutatedSource: MutantSourceText.make(originalContent),
  }
  setActiveMutantId(undefined)
  const baselineRes = Result.try(() => runner(baselineMutant, originalContent, reachingTestFiles))
  restoreInProcessEnv()
  const baselineDiag = match(baselineRes)
    .with({ _tag: "Success" }, ({ success }) =>
      success === "survived"
        ? undefined
        : `[mutation-check] Baseline test suite failed on unmutated file '${file.relFile}'`,
    )
    .with(
      { _tag: "Failure" },
      ({ failure }) =>
        `[mutation-check] Baseline test suite failed on unmutated file '${file.relFile}': ${failure instanceof Error ? failure.message : String(failure)}`,
    )
    .exhaustive()
  if (baselineDiag !== undefined) return baselineDiag
  for (const mutant of mutants) {
    setActiveMutantId(mutant.id)
    const runRes = Result.try(() => runner(mutant, schemaSource, reachingTestFiles))
    restoreInProcessEnv()
    const runnerDiag = match(runRes)
      .with({ _tag: "Success" }, ({ success }) => {
        outcomes.push({ mutant, status: success === "killed" ? "killed" : "survived" })
        return undefined
      })
      .with(
        { _tag: "Failure" },
        ({ failure }) =>
          `[mutation-check] Custom testRunner threw for mutant '${mutant.id}': ${failure instanceof Error ? failure.message : String(failure)}`,
      )
      .exhaustive()
    if (runnerDiag !== undefined) return runnerDiag
  }
  return undefined
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
  const untestedFiles: Array<UntestedMutationFile> = []

  let cachedKilledCount = 0

  const isStrictMode = match(options?.enforcementMode)
    .with("strict", () => true)
    .with("advisory", undefined, () => false)
    .exhaustive()

  const makeReport = (
    outcomesSoFar: ReadonlyArray<MutantOutcome>,
    extra: { readonly passed?: false; readonly diagnostic?: string },
  ): MutationSuiteReport => ({
    ...evaluateMutationOutcomes(
      outcomesSoFar,
      options?.minScore,
      options?.equivalencePriors,
      options?.saturationSpecs,
      options?.spanObservations,
    ),
    ...extra,
    cachedKilledCount,
    diffMode,
    scannedCandidateFiles,
    scannedFiles,
    diffMatchedFiles,
    evaluatedFiles,
    ...(untestedFiles.length > 0 ? { untestedFiles } : {}),
  })
  let flushCacheIfDirty: () => void = () => {}
  const abortWith = (
    outcomesSoFar: ReadonlyArray<MutantOutcome>,
    diagnostic: string,
  ): MutationSuiteReport => {
    flushCacheIfDirty()
    process.stderr.write(`${diagnostic}\n`)
    return makeReport(outcomesSoFar, { passed: false, diagnostic })
  }

  const rawOverlays = options?.sourceCodeOverlays
  const hasOverlays = rawOverlays !== undefined
  const normalizedOverlays = new Map<string, string>()
  if (rawOverlays !== undefined) {
    for (const [k, v] of Object.entries(rawOverlays)) {
      normalizedOverlays.set(k.replace(/\\/g, "/").replace(/^\.\//, ""), v)
    }
  }

  const backupPath = join(repoRoot, ".harness", "mutation-backup.json")
  const resolvedBackupPath = resolve(backupPath)
  const startupDiag =
    !hasOverlays && hostIo.getEnv()["HARNESS_ACTIVE_BACKUP_PATH"] !== resolvedBackupPath
      ? recoverStartupBackup(repoRoot, backupPath, hostIo)
      : undefined
  if (startupDiag !== undefined) return abortWith([], startupDiag)

  const targetFilesOpt = options?.targetFiles
  const hasTargetFilesOpt = targetFilesOpt !== undefined
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
    .with({ _tag: "Ok" }, ({ domainFiles, targets }) => ({ domainFiles, targets }))
    .exhaustive()
  if (typeof targetsOrAbort === "string") return abortWith([], targetsOrAbort)
  const { domainFiles, targets } = targetsOrAbort
  scannedCandidateFiles = targets.length

  const resolvedDiff = match(
    resolveSuiteDiff({
      repoRoot,
      hostIo,
      hasOverlays,
      isExplicitTarget,
      diffOnly: options?.diffOnly,
      includeAllLines: options?.includeAllLines,
      baseRef: options?.baseRef,
      explicitBaseRef: options?.explicitBaseRef,
      isStrictMode,
    }),
  )
    .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
    .with({ _tag: "Ok" }, (ok) => ok)
    .exhaustive()
  if (typeof resolvedDiff === "string") return abortWith([], resolvedDiff)
  diffMode = resolvedDiff.diffMode
  const diffLinesMap = resolvedDiff.diffLinesMap

  if (
    isStrictMode &&
    options?.scope === undefined &&
    !hasTargetFilesOpt &&
    diffLinesMap !== undefined
  ) {
    const unclassifiedErr = checkUnclassifiedStrictFiles(
      repoRoot,
      diffLinesMap,
      domainFiles,
      hostIo,
    )
    if (unclassifiedErr !== undefined) return abortWith([], unclassifiedErr)
  }

  const suiteNowMs = options?.nowMs ?? MutationEpochMillis.make(Date.now())
  const cacheAuth = options?.cacheAuth
  const cacheRequested =
    options?.disableMutantCache !== true &&
    !hasOverlays &&
    options?.testRunner === undefined &&
    (options?.enableMutantCache ?? true)
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
  const cacheEntries: Record<ContentSha256, MutationCacheEntry> = {}
  let cacheDirty = false
  flushCacheIfDirty = () => {
    if (!cacheEnabled || !cacheDirty || enabledCacheAuth === undefined) return
    if (flushMutationCache(repoRoot, hostIo, enabledCacheAuth, cacheEntries)) {
      cacheDirty = false
    }
  }

  const baseSubprocessEnv: Record<string, string | undefined> = {
    ...hostIo.getEnv(),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    HARNESS_ACTIVE_BACKUP_PATH: resolvedBackupPath,
  }
  delete baseSubprocessEnv["HARNESS_ACTIVE_MUTANT_ID"]

  const globalBypassDiffFilter =
    options?.includeAllLines === true || (isExplicitTarget && options?.diffOnly !== true)
  const baselinePrepRes =
    !hasOverlays && options?.testRunner === undefined
      ? preparePackageBaselines({
          repoRoot,
          targets,
          hostIo,
          baseSubprocessEnv,
          diffLinesMap,
          bypassDiffFilter: globalBypassDiffFilter,
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
  if (typeof baselinePrep === "string") return abortWith([], baselinePrep)

  const outcomes: Array<MutantOutcome> = []
  for (const file of targets) {
    const overlaySource = normalizedOverlays.get(file.relFile)
    if (diffLinesMap !== undefined && diffLinesMap.has(file.relFile)) {
      diffMatchedFiles.push(file.relFile)
    }
    const bypassDiffFilter = overlaySource !== undefined || globalBypassDiffFilter
    if (!bypassDiffFilter && diffLinesMap !== undefined && !diffLinesMap.has(file.relFile)) {
      continue
    }

    scannedFiles.push(file.relFile)
    const modifiedLines = bypassDiffFilter ? undefined : diffLinesMap?.get(file.relFile)
    const originalContent = match(
      overlaySource !== undefined
        ? Result.succeed(overlaySource)
        : Result.try({
            try: () => hostIo.readTextSync(file.fullPath),
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          }),
    )
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) => ({ readErr: failure }))
      .exhaustive()
    if (typeof originalContent !== "string") {
      return abortWith(
        outcomes,
        `[mutation-check] Failed to read source file '${file.relFile}': ${originalContent.readErr}`,
      )
    }

    const mutants = discoverDomainMutants(
      file.relFile,
      originalContent,
      modifiedLines !== undefined && modifiedLines.size > 0 ? { modifiedLines } : undefined,
    )
    if (mutants.length === 0) continue

    evaluatedFiles.push(file.relFile)
    const schemaBundle = compileMutantSchemaModule(file.relFile, originalContent, mutants)
    const syntaxErrors = verifyMutantSchemaSyntax(file.relFile, schemaBundle.schemaSource)
    if (syntaxErrors.length > 0) {
      return abortWith(
        outcomes,
        `[mutation-check] Compiled mutant schema for '${file.relFile}' failed syntax verification: ${syntaxErrors.join("; ")}`,
      )
    }

    if (overlaySource !== undefined && options?.testRunner === undefined) {
      for (const mutant of mutants) outcomes.push({ mutant, status: "survived" })
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
      continue
    }

    const partition = match(
      baselinePrep?.partitionCache.get(file.relFile) ??
        partitionReachingTestFilesChecked(repoRoot, file, originalContent, hostIo),
    )
      .with({ _tag: "Ok" }, ({ partition: p }) => p)
      .with({ _tag: "Error" }, ({ reason }) => reason)
      .exhaustive()
    if (typeof partition === "string") return abortWith(outcomes, `[mutation-check] ${partition}`)
    const { primaryTests, fallbackTests } = partition
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
    })
    if (dirtiedCache) cacheDirty = true

    const uncachedMutants = mutants.filter((m) => !cachedHitIds.has(m.id))
    cachedKilledCount += mutants.length - uncachedMutants.length

    const pkgBaselinePassed =
      baselinePrep?.passedPackageBaselines.has(`${file.scope}/${file.pkgDir}`) === true
    const primaryRes = runVitestTargetList(
      repoRoot,
      file,
      hostIo,
      baseSubprocessEnv,
      primaryTests,
      originalContent,
      schemaBundle.schemaSource,
      backupPath,
      uncachedMutants,
      { skipBaselineCheck: pkgBaselinePassed },
    )
    const fileNonCacheableIds = new Set<string>()
    const primaryOutcomes = match(primaryRes)
      .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
      .with({ _tag: "Ok" }, ({ outcomes: resOutcomes, nonCacheableIds }) => {
        for (const id of nonCacheableIds) fileNonCacheableIds.add(id)
        return resOutcomes
      })
      .exhaustive()
    if (typeof primaryOutcomes === "string") return abortWith(outcomes, primaryOutcomes)

    const fileOutcomes = new Map<string, MutantOutcome>(
      primaryOutcomes.map((o) => [o.mutant.id, o]),
    )
    for (const mutant of mutants) {
      if (cachedHitIds.has(mutant.id)) {
        fileOutcomes.set(mutant.id, { mutant, status: "killed" })
      }
    }
    const survivingMutants = primaryOutcomes
      .filter((o) =>
        match(o.status)
          .with("survived", () => true)
          .with("killed", "equivalent", () => false)
          .exhaustive(),
      )
      .map((o) => o.mutant)

    if (survivingMutants.length > 0 && fallbackTests.length > 0) {
      const fallbackRes = runVitestTargetList(
        repoRoot,
        file,
        hostIo,
        baseSubprocessEnv,
        fallbackTests,
        originalContent,
        schemaBundle.schemaSource,
        backupPath,
        survivingMutants,
      )
      const fallbackAbort = match(fallbackRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
        .with({ _tag: "Ok" }, ({ outcomes: fbOutcomes, nonCacheableIds }) => {
          for (const id of nonCacheableIds) fileNonCacheableIds.add(id)
          for (const fbOutcome of fbOutcomes) {
            match(fbOutcome.status)
              .with("killed", () => {
                fileOutcomes.set(fbOutcome.mutant.id, fbOutcome)
              })
              .with("survived", "equivalent", () => {})
              .exhaustive()
          }
          return undefined
        })
        .exhaustive()
      if (fallbackAbort !== undefined) {
        return abortWith(
          [...outcomes, ...collectOrderedFileOutcomes(mutants, fileOutcomes).present],
          fallbackAbort,
        )
      }
    }
    const ordered = collectOrderedFileOutcomes(mutants, fileOutcomes)
    if (ordered.missingIds.length > 0) {
      return abortWith(
        [...outcomes, ...ordered.present],
        `[mutation-check] Missing outcome(s) for mutant(s) in '${file.relFile}': ${ordered.missingIds.join(", ")}`,
      )
    }
    if (
      recordKilledMutantsToCache({
        relFile: file.relFile,
        uncachedMutants,
        fileOutcomes,
        mutantKeys,
        fileNonCacheableIds,
        cacheAuth: enabledCacheAuth,
        nowMs: suiteNowMs,
        cacheEntries,
      })
    ) {
      cacheDirty = true
    }
    outcomes.push(...ordered.present)
    flushCacheIfDirty()
  }

  flushCacheIfDirty()

  if (isStrictMode && untestedFiles.length > 0) {
    return abortWith(
      outcomes,
      `[mutation-check] Untested modified file(s) in strict mode (0 reaching tests): ${untestedFiles.map((u) => u.file).join(", ")}`,
    )
  }
  if (isStrictMode && outcomes.length === 0) {
    return abortWith(
      outcomes,
      "[mutation-check] Zero mutants evaluated in strict mode (SPEC-0018 REQ-2.2).",
    )
  }

  return makeReport(outcomes, {})
}

export const MutationCheck = {
  decide: decideMutationCheck,
  evaluateReport: evaluateMutationOutcomes,
  runSuite: runDomainMutationSuite,
  withActiveMutant: withActiveMutantEffect,
} as const
