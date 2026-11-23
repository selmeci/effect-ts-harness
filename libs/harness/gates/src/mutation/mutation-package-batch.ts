/**
 * @fileoverview Package-level persistent warm Vitest runner bridge and outcome classifier.
 */
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { Cause, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type BatchExitCode,
  type BatchMutantOutcomeResult,
  BatchMutantResultEntry,
  type ContentSha256,
  computeContentSha256,
  type SubprocessSignalName,
} from "@harness/contract"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import {
  classifyMutantSubprocessResult,
  hasClearFailureEvidence,
  runVitestTargetList,
  stripAnsi,
} from "../mutation-subprocess-helpers.js"
import type { CodeMutant, MutantOutcome } from "./mutant-ast-generator.js"
import type { DomainFile } from "./mutation-target-discovery.js"

const PackageBatchFileOutputSchema = Schema.Struct({
  relFile: Schema.String,
  primaryResults: Schema.Array(BatchMutantResultEntry),
  fallbackResults: Schema.Array(BatchMutantResultEntry),
  restoreError: Schema.optional(Schema.String),
})

const PackageBatchRunnerOutputSchema = Schema.fromJsonString(
  Schema.Array(PackageBatchFileOutputSchema),
)

export interface PackageBatchFileInput {
  readonly file: DomainFile
  readonly originalContent: string
  readonly schemaSource: string
  readonly mutants: ReadonlyArray<CodeMutant>
  readonly uncachedMutants: ReadonlyArray<CodeMutant>
  readonly primaryTests: ReadonlyArray<string>
  readonly fallbackTests: ReadonlyArray<string>
  readonly cachedHitIds: ReadonlySet<string>
}

export interface PackageBatchFileResult {
  readonly file: DomainFile
  readonly fileOutcomes: ReadonlyMap<string, MutantOutcome>
  readonly fileNonCacheableIds: ReadonlySet<string>
}

export type RunPackageBatchResult =
  | { readonly _tag: "Ok"; readonly fileResults: ReadonlyArray<PackageBatchFileResult> }
  | {
      readonly _tag: "Abort"
      readonly partialResults: ReadonlyArray<PackageBatchFileResult>
      readonly diagnostic: string
    }

const toExecResult = (entryRes: BatchMutantOutcomeResult): SyncHostExecResult =>
  match(entryRes)
    .with({ _tag: "Signaled" }, (s) => {
      const signal: SubprocessSignalName = s.signal
      return { _tag: "Signaled" as const, signal, stdout: s.stdout, stderr: s.stderr }
    })
    .with({ _tag: "Exited" }, (e) => {
      const exitCode: BatchExitCode = e.exitCode
      return { _tag: "Exited" as const, exitCode, stdout: e.stdout, stderr: e.stderr }
    })
    .with({ _tag: "TimedOut" }, (t) => t)
    .with({ _tag: "SpawnFailed" }, (f) => f)
    .exhaustive()

const needsSoloColdRecheck = (mapped: SyncHostExecResult): boolean =>
  match(mapped)
    .with({ _tag: "TimedOut" }, () => true)
    .with(
      { _tag: "Exited" },
      (e) => e.exitCode === 1 && !hasClearFailureEvidence(e.stdout, e.stderr),
    )
    .with({ _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => false)
    .exhaustive()

const shouldRecordOutcome = (
  onlyUpdateOnKill: boolean,
  status: "killed" | "survived" | "equivalent",
): boolean =>
  !onlyUpdateOnKill ||
  match(status)
    .with("killed", () => true)
    .with("survived", "equivalent", () => false)
    .exhaustive()

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
    const mapped = toExecResult(entryRes)
    if (needsSoloColdRecheck(mapped)) {
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
        { skipBaselineCheck: true },
      )
      const soloDiag = match(soloRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
        .with({ _tag: "Ok" }, ({ outcomes, nonCacheableIds }) => {
          for (const id of nonCacheableIds) input.fileNonCacheableIds.add(id)
          const single = outcomes[0]
          if (single === undefined) {
            return `[mutation-check] Missing solo recheck outcome for mutant '${mutant.id}'`
          }
          if (shouldRecordOutcome(input.onlyUpdateOnKill, single.status)) {
            input.fileOutcomes.set(mutant.id, single)
          }
          return undefined
        })
        .exhaustive()
      if (soloDiag !== undefined) return soloDiag
      continue
    }

    const classified = classifyMutantSubprocessResult(mutant.id, Result.succeed(mapped))
    const abortDiag = match(classified)
      .with({ kind: "abort" }, ({ diagnostic }) => diagnostic)
      .with({ kind: "outcome" }, ({ status }) => {
        match(mapped)
          .with({ _tag: "Signaled" }, { _tag: "TimedOut" }, () => {
            input.fileNonCacheableIds.add(mutant.id)
          })
          .with({ _tag: "Exited" }, (r) => {
            if (r.exitCode === 1 && !hasClearFailureEvidence(r.stdout, r.stderr)) {
              input.fileNonCacheableIds.add(mutant.id)
            }
          })
          .with({ _tag: "SpawnFailed" }, () => {})
          .exhaustive()
        if (shouldRecordOutcome(input.onlyUpdateOnKill, status)) {
          input.fileOutcomes.set(mutant.id, { mutant, status })
        }
        return undefined
      })
      .exhaustive()
    if (abortDiag !== undefined) return abortDiag
  }
  return undefined
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
}): RunPackageBatchResult => {
  const vitestCliPath = join(input.repoRoot, "node_modules", "vitest", "vitest.mjs")
  const runnerPath = join(input.repoRoot, "tools", "package-vitest-batch.mjs")
  if (!input.hostIo.existsSync(vitestCliPath) || !input.hostIo.existsSync(runnerPath)) {
    return {
      _tag: "Abort",
      partialResults: [],
      diagnostic: `[mutation-check] Package batch runner or vitest CLI missing for '${input.pkgKey}'.`,
    }
  }

  let totalMutants = 0
  const planFiles = input.files.map((f) => {
    totalMutants += f.uncachedMutants.length
    return {
      relFile: f.file.relFile,
      fullPath: f.file.fullPath,
      originalSha256: computeContentSha256(f.originalContent),
      mutatedSha256: computeContentSha256(f.schemaSource),
      originalSource: f.originalContent,
      schemaSource: f.schemaSource,
      primaryTests: f.primaryTests,
      fallbackTests: f.fallbackTests,
      mutantIds: f.uncachedMutants.map((m) => m.id),
      primaryTimeoutMs: Math.max(30_000, Math.min(180_000, f.primaryTests.length * 10_000)),
      fallbackTimeoutMs: Math.max(
        30_000,
        Math.min(180_000, Math.max(1, f.fallbackTests.length) * 10_000),
      ),
    }
  })

  const planPath = join(
    dirname(input.backupPath),
    `pkg-plan-${process.pid}-${randomBytes(6).toString("hex")}.json`,
  )
  const writePlanRes = Result.try({
    try: () => {
      input.hostIo.mkdirRecursiveSync(dirname(planPath))
      input.hostIo.writeTextSync(
        planPath,
        JSON.stringify({
          cwd: input.repoRoot,
          backupPath: input.backupPath,
          vitestCli: vitestCliPath,
          allPackageTests: input.allPackageTests,
          baselinedTests: Array.from(new Set(input.files.flatMap((f) => f.primaryTests))),
          files: planFiles,
        }),
      )
    },
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  const writePlanErr = match(writePlanRes)
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
  if (writePlanErr !== undefined) {
    return {
      _tag: "Abort",
      partialResults: [],
      diagnostic: `[mutation-check] Failed to write package batch plan '${planPath}': ${writePlanErr}`,
    }
  }

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
  Result.try(() => {
    if (input.hostIo.existsSync(planPath)) input.hostIo.unlinkSync(planPath)
  })

  const batchAbort = (msg: string) =>
    Result.fail<string>(`[mutation-check] Package batch runner ${msg} for '${input.pkgKey}'`)
  const decoded = match(execRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      batchAbort(`threw: ${failure instanceof Error ? failure.message : String(failure)}`),
    )
    .with({ _tag: "Success" }, ({ success }) =>
      match(success)
        .with({ _tag: "Exited" }, (r) =>
          r.exitCode !== 0
            ? batchAbort(`exited with code ${r.exitCode}: ${stripAnsi(r.stderr).trim()}`)
            : match(Schema.decodeExit(PackageBatchRunnerOutputSchema)(r.stdout))
                .with({ _tag: "Success" }, ({ value }) => Result.succeed(value))
                .with({ _tag: "Failure" }, ({ cause }) =>
                  batchAbort(
                    `emitted invalid JSON schema (stdoutLen=${r.stdout.length}): ${Cause.pretty(cause).slice(0, 240)}`,
                  ),
                )
                .exhaustive(),
        )
        .with({ _tag: "TimedOut" }, () => batchAbort("timed out"))
        .with({ _tag: "Signaled" }, (r) => batchAbort(`signaled (${r.signal})`))
        .with({ _tag: "SpawnFailed" }, (r) => batchAbort(`spawn failed (${r.spawnError})`))
        .exhaustive(),
    )
    .exhaustive()

  const reportsOrErr = match(decoded)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .with({ _tag: "Success" }, ({ success }) => success)
    .exhaustive()
  if (typeof reportsOrErr === "string") {
    return { _tag: "Abort", partialResults: [], diagnostic: reportsOrErr }
  }

  const reportByRel = new Map(reportsOrErr.map((r) => [r.relFile, r]))
  const fileResults: Array<PackageBatchFileResult> = []

  for (const fileEntry of input.files) {
    const report = reportByRel.get(fileEntry.file.relFile)
    if (report === undefined) {
      return {
        _tag: "Abort",
        partialResults: fileResults,
        diagnostic: `[mutation-check] Package batch runner missing report for '${fileEntry.file.relFile}'`,
      }
    }

    const fileOutcomes = new Map<string, MutantOutcome>()
    const fileNonCacheableIds = new Set<string>()
    for (const mutant of fileEntry.mutants) {
      if (fileEntry.cachedHitIds.has(mutant.id)) {
        fileOutcomes.set(mutant.id, { mutant, status: "killed" })
      }
    }

    const primaryAbort = applyBatchPassOutcomes({
      repoRoot: input.repoRoot,
      backupPath: input.backupPath,
      hostIo: input.hostIo,
      baseSubprocessEnv: input.baseSubprocessEnv,
      fileEntry,
      passTests: fileEntry.primaryTests,
      expectedMutants: fileEntry.uncachedMutants,
      rawEntries: report.primaryResults,
      fileOutcomes,
      fileNonCacheableIds,
      onlyUpdateOnKill: false,
    })
    if (primaryAbort !== undefined) {
      return { _tag: "Abort", partialResults: fileResults, diagnostic: primaryAbort }
    }

    const surviving = fileEntry.uncachedMutants.filter((m) =>
      match(fileOutcomes.get(m.id)?.status)
        .with("survived", () => true)
        .with("killed", "equivalent", undefined, () => false)
        .exhaustive(),
    )
    const reportedFallbackIds = new Set<string>(report.fallbackResults.map((r) => r.id))
    const reportedFallback = surviving.filter((m) => reportedFallbackIds.has(m.id))
    const unreportedFallback = surviving.filter((m) => !reportedFallbackIds.has(m.id))

    if (surviving.length > 0 && fileEntry.fallbackTests.length > 0 && reportedFallback.length > 0) {
      const fbAbort = applyBatchPassOutcomes({
        repoRoot: input.repoRoot,
        backupPath: input.backupPath,
        hostIo: input.hostIo,
        baseSubprocessEnv: input.baseSubprocessEnv,
        fileEntry,
        passTests: fileEntry.fallbackTests,
        expectedMutants: reportedFallback,
        rawEntries: report.fallbackResults,
        fileOutcomes,
        fileNonCacheableIds,
        onlyUpdateOnKill: true,
      })
      if (fbAbort !== undefined) {
        return { _tag: "Abort", partialResults: fileResults, diagnostic: fbAbort }
      }
    }

    if (report.restoreError !== undefined) {
      fileResults.push({ file: fileEntry.file, fileOutcomes, fileNonCacheableIds })
      return {
        _tag: "Abort",
        partialResults: fileResults,
        diagnostic: report.restoreError,
      }
    }

    if (unreportedFallback.length > 0 && fileEntry.fallbackTests.length > 0) {
      const soloFbRes = runVitestTargetList(
        input.repoRoot,
        fileEntry.file,
        input.hostIo,
        input.baseSubprocessEnv,
        fileEntry.fallbackTests,
        fileEntry.originalContent,
        fileEntry.schemaSource,
        input.backupPath,
        unreportedFallback,
        { skipBaselineCheck: true },
      )
      const soloFbDiag = match(soloFbRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
        .with({ _tag: "Ok" }, ({ outcomes: fbOutcomes, nonCacheableIds }) => {
          for (const id of nonCacheableIds) fileNonCacheableIds.add(id)
          for (const o of fbOutcomes) {
            if (shouldRecordOutcome(true, o.status)) {
              fileOutcomes.set(o.mutant.id, o)
            }
          }
          return undefined
        })
        .exhaustive()
      if (soloFbDiag !== undefined) {
        return { _tag: "Abort", partialResults: fileResults, diagnostic: soloFbDiag }
      }
    }
    fileResults.push({ file: fileEntry.file, fileOutcomes, fileNonCacheableIds })
  }

  return { _tag: "Ok", fileResults }
}

export type RunSingleFilePassResult =
  | { readonly _tag: "Ok"; readonly result: PackageBatchFileResult }
  | {
      readonly _tag: "Abort"
      readonly partialResult: PackageBatchFileResult
      readonly diagnostic: string
    }

/** Runs primary and conditional fallback Vitest passes for a single domain file. */
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
  readonly fallbackTests: ReadonlyArray<string>
  readonly cachedHitIds: ReadonlySet<string>
  readonly pkgBaselinePassed: boolean
}): RunSingleFilePassResult {
  const fileNonCacheableIds = new Set<string>()
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
    .with({ _tag: "Ok" }, ({ outcomes: resOutcomes, nonCacheableIds }) => {
      for (const id of nonCacheableIds) fileNonCacheableIds.add(id)
      return resOutcomes
    })
    .exhaustive()
  if (typeof primaryOutcomes === "string") {
    return {
      _tag: "Abort",
      partialResult: {
        file: input.file,
        fileOutcomes: new Map(),
        fileNonCacheableIds,
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
  const survivingMutants = primaryOutcomes
    .filter((o) =>
      match(o.status)
        .with("survived", () => true)
        .with("killed", "equivalent", () => false)
        .exhaustive(),
    )
    .map((o) => o.mutant)

  if (survivingMutants.length > 0 && input.fallbackTests.length > 0) {
    const fallbackRes = runVitestTargetList(
      input.repoRoot,
      input.file,
      input.hostIo,
      input.baseSubprocessEnv,
      input.fallbackTests,
      input.originalContent,
      input.schemaSource,
      input.backupPath,
      survivingMutants,
      { skipBaselineCheck: input.pkgBaselinePassed },
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
      return {
        _tag: "Abort",
        partialResult: { file: input.file, fileOutcomes, fileNonCacheableIds },
        diagnostic: fallbackAbort,
      }
    }
  }

  return {
    _tag: "Ok",
    result: { file: input.file, fileOutcomes, fileNonCacheableIds },
  }
}

export interface QueuedPackageEntry {
  readonly pkgKey: string
  readonly input: PackageBatchFileInput
  readonly mutantKeys: ReadonlyMap<string, ContentSha256>
}

/** Executes queued package batches using one persistent warm Vitest pool per multi-file package. */
export function executeQueuedPackageBatches(input: {
  readonly repoRoot: string
  readonly backupPath: string
  readonly hostIo: SyncHostIo
  readonly baseSubprocessEnv: Readonly<Record<string, string | undefined>>
  readonly queuedByPkg: ReadonlyMap<string, ReadonlyArray<QueuedPackageEntry>>
  readonly finalizeEntry: (
    entry: QueuedPackageEntry,
    result: PackageBatchFileResult,
  ) => string | undefined
  readonly recordPartialOnAbort: (entry: QueuedPackageEntry, result: PackageBatchFileResult) => void
}): string | undefined {
  for (const [pkgKey, queuedEntries] of input.queuedByPkg.entries()) {
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
        fallbackTests: only.input.fallbackTests,
        cachedHitIds: only.input.cachedHitIds,
        pkgBaselinePassed: true,
      })
      const abortErr = match(passRes)
        .with({ _tag: "Abort" }, ({ partialResult, diagnostic }) => {
          input.recordPartialOnAbort(only, partialResult)
          return diagnostic
        })
        .with({ _tag: "Ok" }, ({ result }) => input.finalizeEntry(only, result))
        .exhaustive()
      if (abortErr !== undefined) return abortErr
      continue
    }

    const allPkgTestSet = new Set<string>()
    for (const q of queuedEntries) {
      for (const t of q.input.primaryTests) allPkgTestSet.add(t)
      for (const t of q.input.fallbackTests) allPkgTestSet.add(t)
    }
    const pkgBatchRes = runPackageMutantBatchChecked({
      repoRoot: input.repoRoot,
      pkgKey,
      backupPath: input.backupPath,
      hostIo: input.hostIo,
      baseSubprocessEnv: input.baseSubprocessEnv,
      allPackageTests: Array.from(allPkgTestSet),
      files: queuedEntries.map((q) => q.input),
    })
    const entryByRel = new Map(queuedEntries.map((q) => [q.input.file.relFile, q]))
    const batchAbort = match(pkgBatchRes)
      .with({ _tag: "Abort" }, ({ partialResults, diagnostic }) => {
        for (const pr of partialResults) {
          const matched = entryByRel.get(pr.file.relFile)
          if (matched === undefined) continue
          input.finalizeEntry(matched, pr)
        }
        return diagnostic
      })
      .with({ _tag: "Ok" }, ({ fileResults }) => {
        for (const fr of fileResults) {
          const matched = entryByRel.get(fr.file.relFile)
          if (matched === undefined) continue
          const finErr = input.finalizeEntry(matched, fr)
          if (finErr !== undefined) return finErr
        }
        return undefined
      })
      .exhaustive()
    if (batchAbort !== undefined) return batchAbort
  }
  return undefined
}
