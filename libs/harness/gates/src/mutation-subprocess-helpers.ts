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
          const combinedOutput = `${cleanStdout}\n${cleanStderr}`
          const isInfraMissingRunner =
            /\bERR_PNPM_|Command\s+["']?vitest["']?\s+not found|Failed to load config|Failed to resolve import|Cannot find (?:module|package)|No test (?:files|suite) found|Startup Error/i.test(
              combinedOutput,
            )
          const abortInfra = (extra?: string) => {
            const reasons: Array<string> = [`exitCode=${r.exitCode}`]
            if (extra !== undefined) reasons.push(extra)
            if (cleanStderr.trim().length > 0) reasons.push(`stderr=${cleanStderr.trim()}`)
            return {
              kind: "abort" as const,
              diagnostic: `[mutation-check] Runner infrastructure failure for mutant '${mutantId}': ${reasons.join(", ")}`,
            }
          }
          if (r.exitCode < 0 || r.exitCode > 1) return abortInfra()
          const hasVitestTestFailureEvidence = /\bTests\s+[1-9]\d*\s+failed\b/.test(cleanStdout)
          const hasVitestTestPassSummary = /\bTests\s+[1-9]\d*\s+passed\b/.test(cleanStdout)
          if (r.exitCode === 1) {
            if (hasVitestTestFailureEvidence)
              return { kind: "outcome" as const, status: "killed" as const }
            if (isInfraMissingRunner) return abortInfra()
            const hasMutantBreakageEvidence =
              /\bSyntaxError:|\bERR_MODULE_NOT_FOUND\b/.test(combinedOutput) ||
              /\bTests\s+no tests\b/i.test(combinedOutput) ||
              /Transform failed with \d+ error/i.test(combinedOutput)
            if (hasMutantBreakageEvidence)
              return { kind: "outcome" as const, status: "killed" as const }
            return abortInfra("missingVitestFailureEvidence=true")
          }
          if (!hasVitestTestPassSummary && isInfraMissingRunner) return abortInfra()
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
):
  | { readonly kind: "ok"; readonly outcomes: ReadonlyArray<MutantOutcome> }
  | { readonly kind: "abort"; readonly diagnostic: string } => {
  const vitestCliPath = join(repoRoot, "node_modules", "vitest", "vitest.mjs")
  const batchRunnerPath = join(repoRoot, "tools", "parallel-vitest-batch.mjs")
  const useDirectVitest = hostIo.existsSync(vitestCliPath)
  const execCmd = useDirectVitest ? process.execPath : "pnpm"
  const execArgs = useDirectVitest
    ? [vitestCliPath, "run", "--maxWorkers=2", ...reachingTestFiles]
    : ["vitest", "run", ...reachingTestFiles]

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
        .with({ _tag: "Exited" }, (r) =>
          r.exitCode === 0
            ? undefined
            : baseFail(` (exitCode=${r.exitCode}${formatErr(r.stderr)})`),
        )
        .with({ _tag: "TimedOut" }, (r) => baseFail(` (timedOut=true${formatErr(r.stderr)})`))
        .with({ _tag: "Signaled" }, (r) => baseFail(` (signal=${r.signal}${formatErr(r.stderr)})`))
        .with({ _tag: "SpawnFailed" }, (r) => baseFail(` (spawnError=${r.spawnError})`))
        .exhaustive(),
    )
    .exhaustive()
  if (baselineDiag !== undefined) return { kind: "abort", diagnostic: baselineDiag }

  const originalSha256 = computeContentSha256(originalSource)
  const expectedMutatedSha256 = computeContentSha256(mutatedSchemaSource)
  let wroteMutatedSchema = false
  let restoredToOriginal = false
  const backupWriteErr = writeMutationBackup(
    repoRoot,
    backupPath,
    file.fullPath,
    originalSource,
    mutatedSchemaSource,
    hostIo,
  )
  if (backupWriteErr !== undefined) return { kind: "abort", diagnostic: backupWriteErr }

  const restoreOriginalFile = (): string | undefined => {
    if (restoredToOriginal) return undefined
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
      restoredToOriginal = true
      const unlinkErr = unlinkBackupChecked(backupPath, hostIo)
      if (unlinkErr !== undefined) {
        const diag = `[mutation-check] CRITICAL: Restored '${file.fullPath}' but ${unlinkErr}`
        process.stderr.write(`${diag}\n`)
        return diag
      }
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
        restoredToOriginal = true
        const unlinkErr = unlinkBackupChecked(backupPath, hostIo)
        if (unlinkErr !== undefined) {
          const diag = `[mutation-check] CRITICAL: Restored '${file.fullPath}' from backup retry but ${unlinkErr}`
          process.stderr.write(`${diag}\n`)
          return diag
        }
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

  const onProcessExit = () => {
    restoreOriginalFile()
  }
  const onSigInt = () => {
    onProcessExit()
    process.exit(130)
  }
  const onSigTerm = () => {
    onProcessExit()
    process.exit(143)
  }
  process.once("exit", onProcessExit)
  process.once("SIGINT", onSigInt)
  process.once("SIGTERM", onSigTerm)

  const passOutcomes: Array<MutantOutcome> = []
  const recordOutcome = (
    mutant: CodeMutant,
    execRes: Result.Result<SyncHostExecResult, unknown>,
  ): string | undefined =>
    match(classifyMutantSubprocessResult(mutant.id, execRes))
      .with({ kind: "abort" }, ({ diagnostic }) => diagnostic)
      .with({ kind: "outcome" }, ({ status }) => {
        passOutcomes.push({ mutant, status })
        return undefined
      })
      .exhaustive()

  const runLoopRes = Result.try(() => {
    let innerRunnerAbortDiagnostic: string | undefined = undefined
    const innerWriteSchemaErr = match(
      Result.try(() => {
        hostIo.writeTextSync(file.fullPath, mutatedSchemaSource)
        wroteMutatedSchema = true
      }),
    )
      .with({ _tag: "Success" }, () => undefined)
      .with({ _tag: "Failure" }, ({ failure }) =>
        failure instanceof Error ? failure.message : String(failure),
      )
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
        const batchAbort = (msg: string) => ({
          kind: "abort" as const,
          diagnostic: `[mutation-check] Batch runner ${msg} for '${file.relFile}'`,
        })
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
                      .with({ _tag: "Success" }, ({ value }) => ({
                        kind: "ok" as const,
                        entries: value,
                      }))
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
          .with({ kind: "abort" }, ({ diagnostic }) => {
            innerRunnerAbortDiagnostic = diagnostic
          })
          .with({ kind: "ok" }, ({ entries }) => {
            const byId = new Map(entries.map((e) => [e.id, e.result]))
            for (const mutant of mutantsToRun) {
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
          const execRes = Result.try(() =>
            hostIo.execFileSync(execCmd, execArgs, {
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
    const innerRestoreErr = restoreOriginalFile()
    return {
      writeSchemaErr: innerWriteSchemaErr,
      runnerAbortDiagnostic: innerRunnerAbortDiagnostic,
      restoreErr: innerRestoreErr,
    }
  })
  process.off("exit", onProcessExit)
  process.off("SIGINT", onSigInt)
  process.off("SIGTERM", onSigTerm)

  const { writeSchemaErr, runnerAbortDiagnostic, restoreErr } = match(runLoopRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => ({
      writeSchemaErr: undefined as string | undefined,
      runnerAbortDiagnostic:
        `[mutation-check] Unexpected error for '${file.relFile}': ${failure instanceof Error ? failure.message : String(failure)}` as
          | string
          | undefined,
      restoreErr: undefined as string | undefined,
    }))
    .exhaustive()

  if (writeSchemaErr !== undefined) {
    const suffix = restoreErr !== undefined ? ` (${restoreErr})` : ""
    return {
      kind: "abort",
      diagnostic: `[mutation-check] Failed to write mutated schema for '${file.relFile}': ${writeSchemaErr}${suffix}`,
    }
  }
  if (runnerAbortDiagnostic !== undefined)
    return { kind: "abort", diagnostic: runnerAbortDiagnostic }
  if (restoreErr !== undefined) return { kind: "abort", diagnostic: restoreErr }
  return { kind: "ok", outcomes: passOutcomes }
}
