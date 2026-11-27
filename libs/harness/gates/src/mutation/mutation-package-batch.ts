/**
 * @fileoverview Package-level persistent warm Vitest runner bridge and outcome classifier.
 */
import { join } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import type {
  AstSourceFilePath,
  BatchMutantOutcomeResult,
  BatchMutantResultEntry,
  ContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  classifyMutantSubprocessResult,
  hasClearFailureEvidence,
  runVitestTargetList,
} from "../mutation-subprocess-helpers.js"
import type { CodeMutant, MutantOutcome } from "./mutant-ast-generator.js"
import { recoverStartupBackup } from "./mutation-backup.js"
import { isMutatedModuleInitFailure } from "./mutation-init-classifier.js"
import {
  type PackageBatchFileInput,
  type PackageBatchFileOutput,
  cleanupStreamReportFile,
  collectSurvivingMutants,
  mergeObservedDurationsIntoMap,
  needsSoloColdRecheck,
  readStreamedPackageBatchReports,
  recordBatchFileProgress,
  recordStageOutcomes,
  runSingleFileFallbackStage,
  shouldRecordOutcome,
  writePackageBatchPlan,
} from "./mutation-batch-stream.js"
import type { DomainFile } from "./mutation-target-discovery.js"
import {
  attributeKillWitnessFromExecResult,
  decodePackageBatchExecResult,
  extractBatchKillingTestFile,
  toBatchHostExecResult,
} from "./mutation-witness.js"

export type { PackageBatchFileInput }

export interface PackageBatchFileResult {
  readonly file: DomainFile
  readonly fileOutcomes: ReadonlyMap<string, MutantOutcome>
  readonly fileNonCacheableIds: ReadonlySet<string>
  readonly witnessByMutantId: ReadonlyMap<string, AstSourceFilePath>
}

export type RunPackageBatchResult =
  | {
      readonly _tag: "Ok"
      readonly fileResults: ReadonlyArray<PackageBatchFileResult>
      readonly observedDurationsMs: ReadonlyMap<string, number>
    }
  | {
      readonly _tag: "Abort"
      readonly partialResults: ReadonlyArray<PackageBatchFileResult>
      readonly observedDurationsMs: ReadonlyMap<string, number>
      readonly diagnostic: string
    }

const makeBatchAbort = (
  diagnostic: string,
  partialResults: ReadonlyArray<PackageBatchFileResult> = [],
  observedDurationsMs: ReadonlyMap<string, number> = new Map(),
): RunPackageBatchResult => ({ _tag: "Abort", partialResults, observedDurationsMs, diagnostic })

const applyBatchPassOutcomes = (input: {
  readonly repoRoot: string
  readonly backupPath: string
  readonly hostIo: SyncHostIo
  readonly baseSubprocessEnv: Readonly<Record<string, string | undefined>>
  readonly fileEntry: PackageBatchFileInput
  readonly passTests: ReadonlyArray<string>
  readonly expectedMutants: ReadonlyArray<CodeMutant>
  readonly rawEntries: ReadonlyArray<BatchMutantResultEntry>
  readonly fileOutcomes: Map<string, MutantOutcome>
  readonly fileNonCacheableIds: Set<string>
  readonly witnessByMutantId: Map<string, AstSourceFilePath>
  readonly onlyUpdateOnKill: boolean
}): string | undefined => {
  const byId = new Map<string, BatchMutantOutcomeResult>(
    input.rawEntries.map((e) => [e.id, e.result]),
  )
  for (const mutant of input.expectedMutants) {
    const entryRes = byId.get(mutant.id)
    if (entryRes === undefined) {
      return `[mutation-check] Package batch runner missing result for mutant '${mutant.id}'`
    }
    const mapped = toBatchHostExecResult(entryRes)
    if (needsSoloColdRecheck(mapped, { baselineImportClean: true })) {
      const soloRes = runVitestTargetList(
        input.repoRoot,
        input.fileEntry.file,
        input.hostIo,
        input.baseSubprocessEnv,
        input.passTests,
        input.fileEntry.originalContent,
        input.fileEntry.schemaSource,
        input.backupPath,
        [mutant],
        { skipBaselineCheck: !input.onlyUpdateOnKill },
      )
      const soloDiag = match(soloRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
        .with({ _tag: "Ok" }, ({ outcomes, nonCacheableIds, witnessByMutantId: soloWitness }) => {
          for (const id of nonCacheableIds) input.fileNonCacheableIds.add(id)
          const single = outcomes[0]
          if (single === undefined) {
            return `[mutation-check] Missing solo recheck outcome for mutant '${mutant.id}'`
          }
          if (shouldRecordOutcome(input.onlyUpdateOnKill, single.status)) {
            input.fileOutcomes.set(mutant.id, single)
            match(single.status)
              .with("killed", () => {
                if (!input.fileNonCacheableIds.has(mutant.id)) {
                  const w = soloWitness.get(mutant.id)
                  if (w !== undefined) input.witnessByMutantId.set(mutant.id, w)
                }
              })
              .with("survived", "equivalent", () => {})
              .exhaustive()
          }
          return undefined
        })
        .exhaustive()
      if (soloDiag !== undefined) return soloDiag
      continue
    }

    const classified = classifyMutantSubprocessResult(mutant.id, Result.succeed(mapped), {
      baselineImportClean: true,
    })
    const abortDiag = match(classified)
      .with({ kind: "abort" }, ({ diagnostic }) => diagnostic)
      .with({ kind: "outcome" }, ({ status }) => {
        match(mapped)
          .with({ _tag: "Signaled" }, { _tag: "TimedOut" }, () => {
            input.fileNonCacheableIds.add(mutant.id)
          })
          .with({ _tag: "Exited" }, (r) => {
            const isModuleInitKill = isMutatedModuleInitFailure({
              exitCode: r.exitCode,
              stdout: r.stdout,
              stderr: r.stderr,
              baselineImportClean: true,
            })
            if (
              r.exitCode === 1 &&
              !hasClearFailureEvidence(r.stdout, r.stderr) &&
              !isModuleInitKill
            ) {
              input.fileNonCacheableIds.add(mutant.id)
            }
          })
          .with({ _tag: "SpawnFailed" }, () => {})
          .exhaustive()
        if (shouldRecordOutcome(input.onlyUpdateOnKill, status)) {
          input.fileOutcomes.set(mutant.id, { mutant, status })
          match(status)
            .with("killed", () => {
              attributeKillWitnessFromExecResult({
                repoRoot: input.repoRoot,
                passTests: input.passTests,
                mutantId: mutant.id,
                execResult: mapped,
                nonCacheableIds: input.fileNonCacheableIds,
                witnessByMutantId: input.witnessByMutantId,
                explicitKillingTestFile: extractBatchKillingTestFile(entryRes),
              })
            })
            .with("survived", () => {})
            .exhaustive()
        }
        return undefined
      })
      .exhaustive()
    if (abortDiag !== undefined) return abortDiag
  }
  return undefined
}

const processBatchFallbackStage = (input: {
  readonly repoRoot: string
  readonly backupPath: string
  readonly hostIo: SyncHostIo
  readonly baseSubprocessEnv: Readonly<Record<string, string | undefined>>
  readonly fileEntry: PackageBatchFileInput
  readonly stageTests: ReadonlyArray<string>
  readonly stageResults: ReadonlyArray<BatchMutantResultEntry>
  readonly fileOutcomes: Map<string, MutantOutcome>
  readonly fileNonCacheableIds: Set<string>
  readonly witnessByMutantId: Map<string, AstSourceFilePath>
}): string | undefined => {
  const surviving = collectSurvivingMutants(input.fileEntry.uncachedMutants, input.fileOutcomes)
  if (surviving.length === 0 || input.stageTests.length === 0) return undefined
  const reportedIds = new Set<string>(input.stageResults.map((r) => r.id))
  const reported = surviving.filter((m) => reportedIds.has(m.id))
  const unreported = surviving.filter((m) => !reportedIds.has(m.id))

  if (reported.length > 0) {
    const fbAbort = applyBatchPassOutcomes({
      repoRoot: input.repoRoot,
      backupPath: input.backupPath,
      hostIo: input.hostIo,
      baseSubprocessEnv: input.baseSubprocessEnv,
      fileEntry: input.fileEntry,
      passTests: input.stageTests,
      expectedMutants: reported,
      rawEntries: input.stageResults,
      fileOutcomes: input.fileOutcomes,
      fileNonCacheableIds: input.fileNonCacheableIds,
      witnessByMutantId: input.witnessByMutantId,
      onlyUpdateOnKill: true,
    })
    if (fbAbort !== undefined) return fbAbort
  }

  if (unreported.length > 0) {
    const soloFbRes = runVitestTargetList(
      input.repoRoot,
      input.fileEntry.file,
      input.hostIo,
      input.baseSubprocessEnv,
      input.stageTests,
      input.fileEntry.originalContent,
      input.fileEntry.schemaSource,
      input.backupPath,
      unreported,
      { skipBaselineCheck: false },
    )
    return match(soloFbRes)
      .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
      .with({ _tag: "Ok" }, ({ outcomes: fbOutcomes, nonCacheableIds, witnessByMutantId }) => {
        recordStageOutcomes(
          fbOutcomes,
          nonCacheableIds,
          witnessByMutantId,
          input.fileOutcomes,
          input.fileNonCacheableIds,
          input.witnessByMutantId,
          true,
        )
        return undefined
      })
      .exhaustive()
  }
  return undefined
}

const processBatchFileReport = (input: {
  readonly repoRoot: string
  readonly backupPath: string
  readonly hostIo: SyncHostIo
  readonly baseSubprocessEnv: Readonly<Record<string, string | undefined>>
  readonly fileEntry: PackageBatchFileInput
  readonly report: PackageBatchFileOutput
}):
  | { readonly _tag: "Ok"; readonly fileResult: PackageBatchFileResult }
  | { readonly _tag: "Abort"; readonly diagnostic: string } => {
  if (input.report.restoreError !== undefined) {
    return { _tag: "Abort", diagnostic: input.report.restoreError }
  }
  const fileOutcomes = new Map<string, MutantOutcome>()
  const fileNonCacheableIds = new Set<string>()
  const witnessByMutantId = new Map<string, AstSourceFilePath>()
  for (const mutant of input.fileEntry.mutants) {
    if (input.fileEntry.cachedHitIds.has(mutant.id)) {
      fileOutcomes.set(mutant.id, { mutant, status: "killed" })
    }
  }
  const primaryAbort = applyBatchPassOutcomes({
    repoRoot: input.repoRoot,
    backupPath: input.backupPath,
    hostIo: input.hostIo,
    baseSubprocessEnv: input.baseSubprocessEnv,
    fileEntry: input.fileEntry,
    passTests: input.fileEntry.primaryTests,
    expectedMutants: input.fileEntry.uncachedMutants,
    rawEntries: input.report.primaryResults,
    fileOutcomes,
    fileNonCacheableIds,
    witnessByMutantId,
    onlyUpdateOnKill: false,
  })
  if (primaryAbort !== undefined) return { _tag: "Abort", diagnostic: primaryAbort }
  const scopedErr = processBatchFallbackStage({
    repoRoot: input.repoRoot,
    backupPath: input.backupPath,
    hostIo: input.hostIo,
    baseSubprocessEnv: input.baseSubprocessEnv,
    fileEntry: input.fileEntry,
    stageTests: input.fileEntry.scopedFallbackTests,
    stageResults: input.report.scopedFallbackResults,
    fileOutcomes,
    fileNonCacheableIds,
    witnessByMutantId,
  })
  if (scopedErr !== undefined) return { _tag: "Abort", diagnostic: scopedErr }
  const pkgFbErr = processBatchFallbackStage({
    repoRoot: input.repoRoot,
    backupPath: input.backupPath,
    hostIo: input.hostIo,
    baseSubprocessEnv: input.baseSubprocessEnv,
    fileEntry: input.fileEntry,
    stageTests: input.fileEntry.packageFallbackTests,
    stageResults: input.report.packageFallbackResults,
    fileOutcomes,
    fileNonCacheableIds,
    witnessByMutantId,
  })
  if (pkgFbErr !== undefined) return { _tag: "Abort", diagnostic: pkgFbErr }
  return {
    _tag: "Ok",
    fileResult: {
      file: input.fileEntry.file,
      fileOutcomes,
      fileNonCacheableIds,
      witnessByMutantId,
    },
  }
}

/**
 * Executes uncached mutants for all evaluated files of one package inside a shared persistent warm Vitest worker pool.
 */
export const runPackageMutantBatchChecked = (input: {
  readonly repoRoot: string
  readonly pkgKey: string
  readonly backupPath: string
  readonly hostIo: SyncHostIo
  readonly baseSubprocessEnv: Readonly<Record<string, string | undefined>>
  readonly allPackageTests: ReadonlyArray<string>
  readonly files: ReadonlyArray<PackageBatchFileInput>
  readonly measuredDurationsMs?: Readonly<Record<string, number>> | undefined
  readonly maxSurvivors?: number | undefined
  readonly maxWorkerRssBytes?: number | undefined
}): RunPackageBatchResult => {
  const vitestCliPath = join(input.repoRoot, "node_modules", "vitest", "vitest.mjs")
  const runnerPath = join(input.repoRoot, "tools", "package-vitest-batch.mjs")
  if (!input.hostIo.existsSync(vitestCliPath) || !input.hostIo.existsSync(runnerPath)) {
    return makeBatchAbort(
      `[mutation-check] Package batch runner or vitest CLI missing for '${input.pkgKey}'.`,
    )
  }

  const planRes = writePackageBatchPlan({
    repoRoot: input.repoRoot,
    backupPath: input.backupPath,
    vitestCliPath,
    hostIo: input.hostIo,
    allPackageTests: input.allPackageTests,
    files: input.files,
    measuredDurationsMs: input.measuredDurationsMs,
    maxSurvivors: input.maxSurvivors,
    maxWorkerRssBytes: input.maxWorkerRssBytes,
  })
  const planOrErr = match(planRes)
    .with({ _tag: "Ok" }, (ok) => ok)
    .with({ _tag: "Err" }, ({ diagnostic }) => diagnostic)
    .exhaustive()
  if (typeof planOrErr === "string") {
    return makeBatchAbort(planOrErr)
  }
  const { planPath, streamReportPath, totalMutants } = planOrErr

  const packageTimeoutMs = Math.max(
    180_000,
    Math.min(1_800_000, totalMutants * 15_000 + input.files.length * 30_000),
  )
  const execRes = Result.try(() =>
    input.hostIo.execFileSync(process.execPath, [runnerPath], {
      cwd: input.repoRoot,
      timeoutMs: packageTimeoutMs,
      maxBufferBytes: 64 * 1024 * 1024,
      env: { ...input.baseSubprocessEnv, HARNESS_PACKAGE_PLAN_FILE: planPath },
    }),
  )
  cleanupStreamReportFile(planPath, input.hostIo, input.repoRoot)
  const streamedReports = readStreamedPackageBatchReports(
    streamReportPath,
    input.hostIo,
    input.repoRoot,
  )
  cleanupStreamReportFile(streamReportPath, input.hostIo, input.repoRoot)

  const decoded = decodePackageBatchExecResult(input.pkgKey, execRes)
  const reportsOrErr = match(decoded)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success }) => success)
    .exhaustive()
  const startupRecoverErr = recoverStartupBackup(input.repoRoot, input.backupPath, input.hostIo)
  if (startupRecoverErr !== undefined) {
    const diagnostic =
      typeof reportsOrErr === "string" ? `${reportsOrErr}; ${startupRecoverErr}` : startupRecoverErr
    return makeBatchAbort(diagnostic)
  }
  if (typeof reportsOrErr === "string") {
    const partialResults: Array<PackageBatchFileResult> = []
    const observedDurationsMs = new Map<string, number>()
    const streamedByRel = new Map<string, PackageBatchFileOutput>(
      streamedReports.map((r) => [r.relFile, r]),
    )
    let recoveryAbortDiag: string | undefined
    for (const fileEntry of input.files) {
      const report = streamedByRel.get(fileEntry.file.relFile)
      if (report === undefined) break
      const processed = processBatchFileReport({
        repoRoot: input.repoRoot,
        backupPath: input.backupPath,
        hostIo: input.hostIo,
        baseSubprocessEnv: input.baseSubprocessEnv,
        fileEntry,
        report,
      })
      const abortDiag = match(processed)
        .with({ _tag: "Ok" }, ({ fileResult }) => {
          mergeObservedDurationsIntoMap(observedDurationsMs, report.observedTestDurationsMs)
          partialResults.push(fileResult)
          return undefined
        })
        .with({ _tag: "Abort" }, ({ diagnostic }) => `${fileEntry.file.relFile}: ${diagnostic}`)
        .exhaustive()
      if (abortDiag !== undefined) {
        recoveryAbortDiag = abortDiag
        break
      }
    }
    return makeBatchAbort(
      recoveryAbortDiag !== undefined
        ? `${reportsOrErr}; NDJSON recovery aborted (${recoveryAbortDiag})`
        : reportsOrErr,
      partialResults,
      observedDurationsMs,
    )
  }

  const reportByRel = new Map<string, PackageBatchFileOutput>(
    reportsOrErr.map((r) => [r.relFile, r]),
  )
  const fileResults: Array<PackageBatchFileResult> = []
  const observedDurationsMs = new Map<string, number>()
  const batchStartedMs = Date.now()
  const progress = { killed: 0, survived: 0, lastProgressMs: batchStartedMs }

  for (const fileEntry of input.files) {
    const report = reportByRel.get(fileEntry.file.relFile)
    if (report === undefined) {
      if (input.maxSurvivors !== undefined && progress.survived >= input.maxSurvivors) {
        break
      }
      return makeBatchAbort(
        `[mutation-check] Package batch runner missing report for '${fileEntry.file.relFile}'`,
        fileResults,
        observedDurationsMs,
      )
    }
    mergeObservedDurationsIntoMap(observedDurationsMs, report.observedTestDurationsMs)
    const processed = processBatchFileReport({
      repoRoot: input.repoRoot,
      backupPath: input.backupPath,
      hostIo: input.hostIo,
      baseSubprocessEnv: input.baseSubprocessEnv,
      fileEntry,
      report,
    })
    const abortDiag = match(processed)
      .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
      .with({ _tag: "Ok" }, ({ fileResult }) => {
        fileResults.push(fileResult)
        recordBatchFileProgress({
          pkgKey: input.pkgKey,
          fileOutcomes: fileResult.fileOutcomes,
          completed: fileResults.length,
          totalFiles: input.files.length,
          batchStartedMs,
          counts: progress,
        })
        return undefined
      })
      .exhaustive()
    if (abortDiag !== undefined) {
      return makeBatchAbort(abortDiag, fileResults, observedDurationsMs)
    }
  }

  return { _tag: "Ok", fileResults, observedDurationsMs }
}

export type RunSingleFilePassResult =
  | {
      readonly _tag: "Ok"
      readonly result: PackageBatchFileResult
      readonly observedDurationsMs: ReadonlyMap<string, number>
    }
  | {
      readonly _tag: "Abort"
      readonly partialResult: PackageBatchFileResult
      readonly diagnostic: string
    }

/** Runs primary and conditional two-stage fallback Vitest passes for a single domain file. */
export function runSingleFileVitestPass(input: {
  readonly repoRoot: string
  readonly backupPath: string
  readonly hostIo: SyncHostIo
  readonly baseSubprocessEnv: Readonly<Record<string, string | undefined>>
  readonly file: DomainFile
  readonly originalContent: string
  readonly schemaSource: string
  readonly mutants: ReadonlyArray<CodeMutant>
  readonly uncachedMutants: ReadonlyArray<CodeMutant>
  readonly primaryTests: ReadonlyArray<string>
  readonly scopedFallbackTests: ReadonlyArray<string>
  readonly packageFallbackTests: ReadonlyArray<string>
  readonly cachedHitIds: ReadonlySet<string>
  readonly pkgBaselinePassed: boolean
}): RunSingleFilePassResult {
  const fileNonCacheableIds = new Set<string>()
  const witnessByMutantId = new Map<string, AstSourceFilePath>()
  const observedDurationsMs = new Map<string, number>()
  const primaryRes = runVitestTargetList(
    input.repoRoot,
    input.file,
    input.hostIo,
    input.baseSubprocessEnv,
    input.primaryTests,
    input.originalContent,
    input.schemaSource,
    input.backupPath,
    input.uncachedMutants,
    { skipBaselineCheck: input.pkgBaselinePassed },
  )
  const primaryOutcomes = match(primaryRes)
    .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
    .with(
      { _tag: "Ok" },
      ({
        outcomes: resOutcomes,
        nonCacheableIds,
        witnessByMutantId: primaryWitness,
        observedDurationsMs: primaryObserved,
      }) => {
        mergeObservedDurationsIntoMap(observedDurationsMs, primaryObserved)
        for (const id of nonCacheableIds) fileNonCacheableIds.add(id)
        for (const [mId, witness] of primaryWitness) {
          if (!fileNonCacheableIds.has(mId)) witnessByMutantId.set(mId, witness)
        }
        return resOutcomes
      },
    )
    .exhaustive()
  if (typeof primaryOutcomes === "string") {
    return {
      _tag: "Abort",
      partialResult: {
        file: input.file,
        fileOutcomes: new Map(),
        fileNonCacheableIds,
        witnessByMutantId,
      },
      diagnostic: primaryOutcomes,
    }
  }

  const fileOutcomes = new Map<string, MutantOutcome>(primaryOutcomes.map((o) => [o.mutant.id, o]))
  for (const mutant of input.mutants) {
    if (input.cachedHitIds.has(mutant.id)) {
      fileOutcomes.set(mutant.id, { mutant, status: "killed" })
    }
  }

  for (const stageTests of [input.scopedFallbackTests, input.packageFallbackTests]) {
    const stageAbort = runSingleFileFallbackStage({
      repoRoot: input.repoRoot,
      backupPath: input.backupPath,
      hostIo: input.hostIo,
      baseSubprocessEnv: input.baseSubprocessEnv,
      file: input.file,
      originalContent: input.originalContent,
      schemaSource: input.schemaSource,
      stageTests,
      fileOutcomes,
      fileNonCacheableIds,
      witnessByMutantId,
      observedDurationsMs,
    })
    if (stageAbort !== undefined) {
      return {
        _tag: "Abort",
        partialResult: { file: input.file, fileOutcomes, fileNonCacheableIds, witnessByMutantId },
        diagnostic: stageAbort,
      }
    }
  }

  return {
    _tag: "Ok",
    result: { file: input.file, fileOutcomes, fileNonCacheableIds, witnessByMutantId },
    observedDurationsMs,
  }
}

export interface QueuedPackageEntry {
  readonly pkgKey: string
  readonly input: PackageBatchFileInput
  readonly mutantKeys: ReadonlyMap<string, ContentSha256>
}

/** Executes queued package batches using one continuous persistent warm Vitest pool per package. */
export function executeQueuedPackageBatches(input: {
  readonly repoRoot: string
  readonly backupPath: string
  readonly hostIo: SyncHostIo
  readonly baseSubprocessEnv: Readonly<Record<string, string | undefined>>
  readonly queuedByPkg: ReadonlyMap<string, ReadonlyArray<QueuedPackageEntry>>
  readonly finalizeEntry: (
    entry: QueuedPackageEntry,
    result: PackageBatchFileResult,
    opts?: { readonly skipSurvivorLimit?: boolean },
  ) => string | undefined
  readonly recordPartialOnAbort: (entry: QueuedPackageEntry, result: PackageBatchFileResult) => void
  readonly onBatchFlushed?: (() => void) | undefined
  readonly isEarlyStopped?: (() => boolean) | undefined
  readonly getMeasuredDurationsRecord?:
    | ((
        pkgKey: string,
        entries: ReadonlyArray<QueuedPackageEntry>,
      ) => Readonly<Record<string, number>>)
    | undefined
  readonly onObservedTestDurations?:
    | ((
        pkgKey: string,
        observed: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
      ) => void)
    | undefined
  readonly getRemainingSurvivorBudget?:
    | ((entries: ReadonlyArray<QueuedPackageEntry>) => number | undefined)
    | undefined
  readonly maxWorkerRssBytes?: number | undefined
}): string | undefined {
  for (const [pkgKey, queuedEntries] of input.queuedByPkg.entries()) {
    if (input.isEarlyStopped?.() === true) return undefined
    if (queuedEntries.length === 0) continue
    if (queuedEntries.length < 2) {
      const only = queuedEntries[0]!
      const passRes = runSingleFileVitestPass({
        repoRoot: input.repoRoot,
        backupPath: input.backupPath,
        hostIo: input.hostIo,
        baseSubprocessEnv: input.baseSubprocessEnv,
        file: only.input.file,
        originalContent: only.input.originalContent,
        schemaSource: only.input.schemaSource,
        mutants: only.input.mutants,
        uncachedMutants: only.input.uncachedMutants,
        primaryTests: only.input.primaryTests,
        scopedFallbackTests: only.input.scopedFallbackTests,
        packageFallbackTests: only.input.packageFallbackTests,
        cachedHitIds: only.input.cachedHitIds,
        pkgBaselinePassed: true,
      })
      const abortErr = match(passRes)
        .with({ _tag: "Abort" }, ({ partialResult, diagnostic }) => {
          input.recordPartialOnAbort(only, partialResult)
          return diagnostic
        })
        .with({ _tag: "Ok" }, ({ result, observedDurationsMs }) => {
          if (observedDurationsMs.size > 0) {
            input.onObservedTestDurations?.(pkgKey, observedDurationsMs)
          }
          return input.finalizeEntry(only, result)
        })
        .exhaustive()
      input.onBatchFlushed?.()
      if (abortErr !== undefined) return abortErr
      if (input.isEarlyStopped?.() === true) return undefined
      continue
    }

    const pkgTestSet = new Set<string>()
    let pkgMutants = 0
    for (const q of queuedEntries) {
      pkgMutants += q.input.uncachedMutants.length
      for (const t of q.input.primaryTests) pkgTestSet.add(t)
      for (const t of [...q.input.scopedFallbackTests, ...q.input.packageFallbackTests]) {
        pkgTestSet.add(t)
      }
    }
    const batchStartedMs = Date.now()
    const pkgBatchRes = runPackageMutantBatchChecked({
      repoRoot: input.repoRoot,
      pkgKey,
      backupPath: input.backupPath,
      hostIo: input.hostIo,
      baseSubprocessEnv: input.baseSubprocessEnv,
      allPackageTests: Array.from(pkgTestSet),
      files: queuedEntries.map((q) => q.input),
      measuredDurationsMs: input.getMeasuredDurationsRecord?.(pkgKey, queuedEntries),
      maxSurvivors: input.getRemainingSurvivorBudget?.(queuedEntries),
      maxWorkerRssBytes: input.maxWorkerRssBytes,
    })
    const entryByRel = new Map(queuedEntries.map((q) => [q.input.file.relFile, q]))
    let processedCount = 0
    const batchAbort = match(pkgBatchRes)
      .with({ _tag: "Abort" }, ({ partialResults, observedDurationsMs, diagnostic }) => {
        if (observedDurationsMs.size > 0) {
          input.onObservedTestDurations?.(pkgKey, observedDurationsMs)
        }
        for (const pr of partialResults) {
          const matched = entryByRel.get(pr.file.relFile)
          if (matched === undefined) continue
          processedCount += 1
          const finErr = input.finalizeEntry(matched, pr, { skipSurvivorLimit: true })
          if (finErr !== undefined) return `${diagnostic}; ${finErr}`
        }
        return diagnostic
      })
      .with({ _tag: "Ok" }, ({ fileResults, observedDurationsMs }) => {
        if (observedDurationsMs.size > 0) {
          input.onObservedTestDurations?.(pkgKey, observedDurationsMs)
        }
        for (const fr of fileResults) {
          const matched = entryByRel.get(fr.file.relFile)
          if (matched === undefined) continue
          processedCount += 1
          const finErr = input.finalizeEntry(matched, fr)
          if (finErr !== undefined) return finErr
          if (input.isEarlyStopped?.() === true) break
        }
        if (processedCount < queuedEntries.length && input.isEarlyStopped?.() !== true) {
          return `[mutation-check] Package batch for '${pkgKey}' completed only ${processedCount}/${queuedEntries.length} queued file(s) without hitting survivor limit`
        }
        return undefined
      })
      .exhaustive()
    input.onBatchFlushed?.()
    const elapsedSec = (Math.max(0, Date.now() - batchStartedMs) / 1000).toFixed(1)
    process.stderr.write(
      `[mutation-check] ${pkgKey} (${processedCount}/${queuedEntries.length} files, ${pkgMutants} mutants) done in ${elapsedSec}s\n`,
    )
    if (batchAbort !== undefined) return batchAbort
    if (input.isEarlyStopped?.() === true) return undefined
  }
  return undefined
}
