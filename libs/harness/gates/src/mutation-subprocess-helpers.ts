import { join } from "node:path"
import { Cause, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { computeContentSha256 } from "@harness/contract"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import type { CodeMutant, MutantOutcome } from "./mutation/mutant-ast-generator.js"
import {
  BackupSchema,
  unlinkBackupChecked,
  writeMutationBackup,
} from "./mutation/mutation-backup.js"
import type { DomainFile } from "./mutation/mutation-target-discovery.js"

const BaseIo = { stdout: Schema.String, stderr: Schema.String }
const BatchResultsSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      result: Schema.TaggedUnion({
        Exited: { exitCode: Schema.Finite, ...BaseIo },
        TimedOut: { ...BaseIo },
        Signaled: { signal: Schema.String, ...BaseIo },
        SpawnFailed: { spawnError: Schema.String, ...BaseIo },
      }),
    }),
  ),
)

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_ESCAPE_REGEX = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
)

export const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE_REGEX, "")

export type MutantSubprocessOutcome =
  | { readonly kind: "abort"; readonly diagnostic: string }
  | { readonly kind: "outcome"; readonly status: "killed" | "survived" }

export type MutantBatchRunResult =
  | {
      readonly _tag: "Ok"
      readonly outcomes: ReadonlyArray<MutantOutcome>
      readonly nonCacheableIds: ReadonlySet<string>
    }
  | { readonly _tag: "Abort"; readonly diagnostic: string }

const isInfraMissingOutput = (combinedOutput: string): boolean =>
  /\bERR_PNPM_|Command\s+["']?vitest["']?\s+not found|Failed to load config|Failed to resolve import|Cannot find (?:module|package)|No test (?:files|suite) found|\b0 test files\b|\bTests\s+no tests\b|Startup Error|\bERR_MODULE_NOT_FOUND\b/i.test(
    combinedOutput,
  )

const stripInnerMutationDiagnostics = (stderr: string): string =>
  stderr.replace(/^\[mutation-check\].*$/gm, "")

const stripVitestTestAssertionNoise = (text: string): string =>
  text
    .replace(/^\s*FAIL\s+[^\r\n]*>\s+[^\r\n]*$/gm, "")
    // Strip Vitest v5 reporter status lines (↓ skipped, ○ pending/todo, · dot pass noise) so assertion/test titles don't trigger infra-failure regexes.
    .replace(/^\s*[×✗✕✓✔❯↓○·]\s+[^\r\n]*$/gm, "")
    .replace(/^\s*(?:AssertionError|ExpectError|Expected|Received):[^\r\n]*$/gm, "")
    .replace(/^\s*[+-]\s[^\r\n]*$/gm, "")

const hasCleanVitestPassSummary = (cleanStdout: string): boolean =>
  /\bTests\s+[1-9]\d*\s+passed\b/.test(cleanStdout) &&
  !(isInfraMissingOutput(cleanStdout) || /\bTests\s+0\s+passed\b/i.test(cleanStdout))

export const classifyMutantSubprocessResult = (
  mutantId: string,
  execRes: Result.Result<SyncHostExecResult, unknown>,
): MutantSubprocessOutcome =>
  match(execRes)
    .with({ _tag: "Failure" }, ({ failure }) => ({
      kind: "abort" as const,
      diagnostic: `[mutation-check] Runner execution threw for mutant '${mutantId}': ${failure instanceof Error ? failure.message : String(failure)}`,
    }))
    .with({ _tag: "Success" }, ({ success }: { readonly success: SyncHostExecResult }) =>
      match(success)
        .with({ _tag: "SpawnFailed" }, (r) => ({
          kind: "abort" as const,
          diagnostic: `[mutation-check] Runner infrastructure failure for mutant '${mutantId}': spawnError=${r.spawnError}`,
        }))
        .with({ _tag: "TimedOut" }, () => ({
          kind: "outcome" as const,
          status: "killed" as const,
        }))
        .with({ _tag: "Signaled" }, () => ({
          kind: "outcome" as const,
          status: "killed" as const,
        }))
        .with({ _tag: "Exited" }, (r) => {
          const cleanStdout = stripAnsi(r.stdout)
          const cleanStderr = stripAnsi(r.stderr)
          const filteredStderr = stripInnerMutationDiagnostics(cleanStderr)
          const combinedOutput = `${cleanStdout}\n${filteredStderr}`
          const infraScanOutput = `${stripVitestTestAssertionNoise(cleanStdout)}\n${stripVitestTestAssertionNoise(filteredStderr)}`
          const isInfraMissingRunner = isInfraMissingOutput(infraScanOutput)
          const abortInfra = (extra?: string) => {
            const reasons: Array<string> = [`exitCode=${r.exitCode}`]
            if (extra !== undefined) reasons.push(extra)
            const collapsedStderr = cleanStderr.trim().replace(/\r?\n+/g, " | ")
            if (collapsedStderr.length > 0) reasons.push(`stderr=${collapsedStderr}`)
            return {
              kind: "abort" as const,
              diagnostic: `[mutation-check] Runner infrastructure failure for mutant '${mutantId}': ${reasons.join(", ")}`,
            }
          }
          if (r.exitCode < 0 || r.exitCode > 1) return abortInfra()
          const hasExplicitFailedCount = /\bTests\s+[1-9]\d*\s+failed\b/.test(cleanStdout)
          const hasAssertionOrExpectError = /\b(?:AssertionError|ExpectError)\b/.test(
            combinedOutput,
          )
          const hasRunnerSyntaxOrTransformError =
            /\bSyntaxError:|Transform failed with \d+ error/i.test(infraScanOutput)
          if (r.exitCode === 1) {
            if (isInfraMissingRunner) return abortInfra("infraFailure=true")
            if (hasRunnerSyntaxOrTransformError) {
              return abortInfra("runnerSyntaxOrTransformError=true")
            }
            if (
              hasExplicitFailedCount ||
              hasAssertionOrExpectError ||
              /^\s*FAIL\s+/m.test(cleanStdout)
            ) {
              return { kind: "outcome" as const, status: "killed" as const }
            }
            return abortInfra("missingVitestFailureEvidence=true")
          }
          if (isInfraMissingRunner || /\bTests\s+0\s+passed\b/i.test(cleanStdout)) {
            return abortInfra("infraFailure=true")
          }
          if (hasCleanVitestPassSummary(cleanStdout)) {
            return { kind: "outcome" as const, status: "survived" as const }
          }
          return { kind: "outcome" as const, status: "survived" as const }
        })
        .exhaustive(),
    )
    .exhaustive()

export const runVitestTargetList = (
  repoRoot: string,
  file: DomainFile,
  hostIo: SyncHostIo,
  baseSubprocessEnv: Readonly<Record<string, string | undefined>>,
  reachingTestFiles: ReadonlyArray<string>,
  originalSource: string,
  mutatedSchemaSource: string,
  backupPath: string,
  mutantsToRun: ReadonlyArray<CodeMutant>,
): MutantBatchRunResult => {
  const vitestCliPath = join(repoRoot, "node_modules", "vitest", "vitest.mjs")
  const batchRunnerPath = join(repoRoot, "tools", "parallel-vitest-batch.mjs")
  const useDirectVitest = hostIo.existsSync(vitestCliPath)
  const execCmd = useDirectVitest ? process.execPath : "pnpm"
  const execArgs = useDirectVitest
    ? [vitestCliPath, "run", "--maxWorkers=2", ...reachingTestFiles]
    : ["vitest", "run", ...reachingTestFiles]
  const mutantExecArgs = useDirectVitest
    ? [vitestCliPath, "run", "--bail=1", "--maxWorkers=2", ...reachingTestFiles]
    : ["vitest", "run", "--bail=1", ...reachingTestFiles]

  const baselineExecRes = Result.try(() =>
    hostIo.execFileSync(execCmd, execArgs, {
      cwd: repoRoot,
      timeoutMs: 30_000,
      env: baseSubprocessEnv,
    }),
  )
  const formatErr = (stderr: string) =>
    stripAnsi(stderr).trim().length > 0 ? `, stderr=${stripAnsi(stderr).trim()}` : ""
  const baseFail = (detail: string) =>
    `[mutation-check] Baseline test suite failed on unmutated file '${file.relFile}'${detail}`
  const baselineDiag = match(baselineExecRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      baseFail(`: ${failure instanceof Error ? failure.message : String(failure)}`),
    )
    .with({ _tag: "Success" }, ({ success }) =>
      match(success)
        .with({ _tag: "Exited" }, (r) => {
          const cleanStdout = stripAnsi(r.stdout)
          const cleanStderr = stripAnsi(r.stderr)
          const filteredStderr = stripInnerMutationDiagnostics(cleanStderr)
          const combined = `${cleanStdout}\n${filteredStderr}`
          if (r.exitCode !== 0) {
            return baseFail(` (exitCode=${r.exitCode}${formatErr(r.stderr)})`)
          }
          if (isInfraMissingOutput(combined) || /\bTests\s+0\s+passed\b/i.test(cleanStdout)) {
            return baseFail(` (infraFailure=true${formatErr(r.stderr)})`)
          }
          return undefined
        })
        .with({ _tag: "TimedOut" }, (r) => baseFail(` (timedOut=true${formatErr(r.stderr)})`))
        .with({ _tag: "Signaled" }, (r) => baseFail(` (signal=${r.signal}${formatErr(r.stderr)})`))
        .with({ _tag: "SpawnFailed" }, (r) => baseFail(` (spawnError=${r.spawnError})`))
        .exhaustive(),
    )
    .exhaustive()
  if (baselineDiag !== undefined) return { _tag: "Abort", diagnostic: baselineDiag }
  if (mutantsToRun.length === 0) {
    return { _tag: "Ok", outcomes: [], nonCacheableIds: new Set() }
  }

  const originalSha256 = computeContentSha256(originalSource)
  const expectedMutatedSha256 = computeContentSha256(mutatedSchemaSource)
  let wroteMutatedSchema = false
  let writeSchemaAttemptFailed = false
  let restoredToOriginal = false
  const backupWriteErr = writeMutationBackup(
    repoRoot,
    backupPath,
    file.fullPath,
    originalSource,
    mutatedSchemaSource,
    hostIo,
  )
  if (backupWriteErr !== undefined) return { _tag: "Abort", diagnostic: backupWriteErr }

  const restoreOriginalFile = (skipConflictGuard: boolean = false): string | undefined => {
    if (restoredToOriginal) return undefined
    if (!skipConflictGuard) {
      const conflictDiag = match(Result.try(() => hostIo.readTextSync(file.fullPath)))
        .with({ _tag: "Success" }, ({ success: currentDiskContent }) => {
          const currentSha256 = computeContentSha256(currentDiskContent)
          const expectedDiskSha = wroteMutatedSchema ? expectedMutatedSha256 : originalSha256
          return currentSha256 !== expectedDiskSha
            ? `[mutation-check] CRITICAL: Target '${file.relFile}' was modified externally mid-run (sha256=${currentSha256}); refusing to overwrite user edits. Preserving '${backupPath}'.`
            : undefined
        })
        .with(
          { _tag: "Failure" },
          ({ failure }) =>
            `[mutation-check] CRITICAL: Failed to read '${file.fullPath}' before restore (${failure instanceof Error ? failure.message : String(failure)}). Preserving '${backupPath}'.`,
        )
        .exhaustive()
      if (conflictDiag !== undefined) {
        process.stderr.write(`${conflictDiag}\n`)
        return conflictDiag
      }
    }

    const primaryError = match(
      Result.try(() => {
        hostIo.writeTextSync(file.fullPath, originalSource)
      }),
    )
      .with({ _tag: "Success" }, () => undefined)
      .with({ _tag: "Failure" }, ({ failure }) =>
        failure instanceof Error ? failure.message : String(failure),
      )
      .exhaustive()
    if (primaryError === undefined) {
      const unlinkErr = unlinkBackupChecked(backupPath, hostIo)
      if (unlinkErr !== undefined) {
        const diag = `[mutation-check] CRITICAL: Restored '${file.fullPath}' but ${unlinkErr}`
        process.stderr.write(`${diag}\n`)
        return diag
      }
      restoredToOriginal = true
      return undefined
    }

    return match(
      Result.try(() => {
        const decoded = Schema.decodeOption(BackupSchema)(hostIo.readTextSync(backupPath))
        const sourceToWrite = match(decoded)
          .with(
            { _tag: "Some" },
            ({ value }) => value.content ?? value.originalSource ?? originalSource,
          )
          .with({ _tag: "None" }, () => originalSource)
          .exhaustive()
        hostIo.writeTextSync(file.fullPath, sourceToWrite)
      }),
    )
      .with({ _tag: "Success" }, () => {
        const unlinkErr = unlinkBackupChecked(backupPath, hostIo)
        if (unlinkErr !== undefined) {
          const diag = `[mutation-check] CRITICAL: Restored '${file.fullPath}' from backup retry but ${unlinkErr}`
          process.stderr.write(`${diag}\n`)
          return diag
        }
        restoredToOriginal = true
        return undefined
      })
      .with({ _tag: "Failure" }, ({ failure }) => {
        const retryMsg = failure instanceof Error ? failure.message : String(failure)
        const diag = `[mutation-check] CRITICAL: Failed to restore '${file.fullPath}' (${primaryError}; backup retry: ${retryMsg}). Preserving '${backupPath}'.`
        process.stderr.write(`${diag}\n`)
        return diag
      })
      .exhaustive()
  }

  const signalState: { current: "SIGINT" | "SIGTERM" | undefined } = { current: undefined }
  const onProcessExit = () => {
    restoreOriginalFile(writeSchemaAttemptFailed)
  }
  const onSigInt = () => {
    signalState.current = "SIGINT"
    restoreOriginalFile(writeSchemaAttemptFailed)
  }
  const onSigTerm = () => {
    signalState.current = "SIGTERM"
    restoreOriginalFile(writeSchemaAttemptFailed)
  }
  process.once("exit", onProcessExit)
  process.once("SIGINT", onSigInt)
  process.once("SIGTERM", onSigTerm)

  const passOutcomes: Array<MutantOutcome> = []
  const nonCacheableIds = new Set<string>()
  const recordOutcome = (
    mutant: CodeMutant,
    execRes: Result.Result<SyncHostExecResult, unknown>,
  ): string | undefined =>
    match(classifyMutantSubprocessResult(mutant.id, execRes))
      .with({ kind: "abort" }, ({ diagnostic }) => diagnostic)
      .with({ kind: "outcome" }, ({ status }) => {
        match(execRes)
          .with({ _tag: "Success" }, ({ success }) =>
            match(success)
              .with({ _tag: "Signaled" }, { _tag: "TimedOut" }, () => {
                nonCacheableIds.add(mutant.id)
              })
              .with({ _tag: "Exited" }, (r) => {
                if (r.exitCode === 1) {
                  const cleanStdout = stripAnsi(r.stdout)
                  const cleanStderr = stripAnsi(r.stderr)
                  const combinedOutput = `${cleanStdout}\n${stripInnerMutationDiagnostics(cleanStderr)}`
                  const hasExplicitFailedCount = /\bTests\s+[1-9]\d*\s+failed\b/.test(cleanStdout)
                  const hasAssertionOrExpectError = /\b(?:AssertionError|ExpectError)\b/.test(
                    combinedOutput,
                  )
                  if (!hasExplicitFailedCount && !hasAssertionOrExpectError) {
                    nonCacheableIds.add(mutant.id)
                  }
                }
              })
              .with({ _tag: "SpawnFailed" }, () => {})
              .exhaustive(),
          )
          .with({ _tag: "Failure" }, () => {})
          .exhaustive()
        passOutcomes.push({ mutant, status })
        return undefined
      })
      .exhaustive()

  const runLoopRes = Result.try(() => {
    let innerRunnerAbortDiagnostic: string | undefined = undefined
    const innerWriteSchemaErr = match(
      Result.try(() => {
        wroteMutatedSchema = true
        hostIo.writeTextSync(file.fullPath, mutatedSchemaSource)
      }),
    )
      .with({ _tag: "Success" }, () => undefined)
      .with({ _tag: "Failure" }, ({ failure }) => {
        writeSchemaAttemptFailed = true
        return failure instanceof Error ? failure.message : String(failure)
      })
      .exhaustive()

    if (innerWriteSchemaErr === undefined) {
      if (mutantsToRun.length >= 2 && hostIo.existsSync(batchRunnerPath) && useDirectVitest) {
        const batchExecRes = Result.try(() =>
          hostIo.execFileSync(process.execPath, [batchRunnerPath], {
            cwd: repoRoot,
            timeoutMs: Math.max(120_000, mutantsToRun.length * 10_000),
            maxBufferBytes: 64 * 1024 * 1024,
            env: {
              ...baseSubprocessEnv,
              HARNESS_BATCH_VITEST_CLI: vitestCliPath,
              HARNESS_BATCH_CWD: repoRoot,
              HARNESS_BATCH_TIMEOUT_MS: "30000",
              HARNESS_BATCH_TESTS_JSON: JSON.stringify(reachingTestFiles),
              HARNESS_BATCH_MUTANTS_JSON: JSON.stringify(mutantsToRun.map((m) => m.id)),
            },
          }),
        )
        const batchAbort = (msg: string) =>
          Result.fail<string>(`[mutation-check] Batch runner ${msg} for '${file.relFile}'`)
        const decodedBatch = match(batchExecRes)
          .with({ _tag: "Failure" }, ({ failure }) =>
            batchAbort(`threw: ${failure instanceof Error ? failure.message : String(failure)}`),
          )
          .with({ _tag: "Success" }, ({ success }) =>
            match(success)
              .with({ _tag: "Exited" }, (r) =>
                r.exitCode !== 0
                  ? batchAbort(`exited with code ${r.exitCode}: ${stripAnsi(r.stderr).trim()}`)
                  : match(Schema.decodeExit(BatchResultsSchema)(r.stdout))
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

        match(decodedBatch)
          .with({ _tag: "Failure" }, ({ failure }) => {
            innerRunnerAbortDiagnostic = failure
          })
          .with({ _tag: "Success" }, ({ success: entries }) => {
            const byId = new Map(entries.map((e) => [e.id, e.result]))
            for (const mutant of mutantsToRun) {
              if (signalState.current !== undefined) break
              const entryRes = byId.get(mutant.id)
              if (entryRes === undefined) {
                innerRunnerAbortDiagnostic = `[mutation-check] Batch runner missing result for mutant '${mutant.id}'`
                break
              }
              const mappedExec: SyncHostExecResult = match(entryRes)
                .with({ _tag: "Signaled" }, (s) => ({
                  _tag: "Signaled" as const,
                  signal: "SIGKILL" as const,
                  stdout: s.stdout,
                  stderr: s.stderr,
                }))
                .with({ _tag: "Exited" }, (e) => e)
                .with({ _tag: "TimedOut" }, (t) => t)
                .with({ _tag: "SpawnFailed" }, (f) => f)
                .exhaustive()
              const abortDiagnostic = recordOutcome(mutant, Result.succeed(mappedExec))
              if (abortDiagnostic !== undefined) {
                innerRunnerAbortDiagnostic = abortDiagnostic
                break
              }
            }
          })
          .exhaustive()
      } else {
        for (const mutant of mutantsToRun) {
          if (signalState.current !== undefined) break
          const execRes = Result.try(() =>
            hostIo.execFileSync(execCmd, mutantExecArgs, {
              cwd: repoRoot,
              timeoutMs: 30_000,
              env: { ...baseSubprocessEnv, HARNESS_ACTIVE_MUTANT_ID: mutant.id },
            }),
          )
          const abortDiagnostic = recordOutcome(mutant, execRes)
          if (abortDiagnostic !== undefined) {
            innerRunnerAbortDiagnostic = abortDiagnostic
            break
          }
        }
      }
    }
    return {
      writeSchemaErr: innerWriteSchemaErr,
      runnerAbortDiagnostic: innerRunnerAbortDiagnostic,
    }
  })
  const restoreErr = restoreOriginalFile(writeSchemaAttemptFailed)
  process.off("exit", onProcessExit)
  process.off("SIGINT", onSigInt)
  process.off("SIGTERM", onSigTerm)

  const loopSummary = match(runLoopRes)
    .with({ _tag: "Success" }, ({ success }) => ({
      writeSchemaErr: success.writeSchemaErr,
      runnerAbortDiagnostic: success.runnerAbortDiagnostic,
    }))
    .with({ _tag: "Failure" }, ({ failure }) => ({
      writeSchemaErr: undefined,
      runnerAbortDiagnostic: `[mutation-check] Unexpected error for '${file.relFile}': ${failure instanceof Error ? failure.message : String(failure)}`,
    }))
    .exhaustive()

  const restoreSuffix = restoreErr !== undefined ? ` (restore error: ${restoreErr})` : ""
  if (signalState.current !== undefined) {
    return {
      _tag: "Abort",
      diagnostic: `[mutation-check] Aborted due to ${signalState.current} while mutating '${file.relFile}'${restoreSuffix}`,
    }
  }
  if (loopSummary.writeSchemaErr !== undefined) {
    return {
      _tag: "Abort",
      diagnostic: `[mutation-check] Failed to write mutated schema for '${file.relFile}': ${loopSummary.writeSchemaErr}${restoreSuffix}`,
    }
  }
  if (loopSummary.runnerAbortDiagnostic !== undefined) {
    return { _tag: "Abort", diagnostic: `${loopSummary.runnerAbortDiagnostic}${restoreSuffix}` }
  }
  if (restoreErr !== undefined) return { _tag: "Abort", diagnostic: restoreErr }
  return { _tag: "Ok", outcomes: passOutcomes, nonCacheableIds }
}
