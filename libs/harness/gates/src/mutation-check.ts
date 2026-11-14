/**
 * @fileoverview Mutation verification gate, mutant discovery, test execution, and span saturation analysis.
 */
import { join, relative } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  getActiveMutantId, setActiveMutantId, withActiveMutantEffect,
} from "./services/active-mutant-context.js"
import {
  CodeMutant, compileMutantSchemaModule, discoverDomainMutants, evaluateMutantSchemaInProcess,
  MutantCategory, MutantOutcome, type MutantSchemaModule, parseGitDiffModifiedLines,
} from "./mutation/mutant-ast-generator.js"
import {
  BackupSchema,
  extractGitDiffModifiedLinesChecked,
  type GitDiffExtractionResult,
  recoverStartupBackup,
  unlinkBackupChecked,
  writeMutationBackup,
} from "./mutation/mutation-backup.js"

export {
  MutantCategory, CodeMutant, MutantOutcome, type MutantSchemaModule,
  getActiveMutantId, setActiveMutantId, parseGitDiffModifiedLines,
  discoverDomainMutants, compileMutantSchemaModule, evaluateMutantSchemaInProcess,
}

export interface SpanSaturationSpec {
  readonly spanQualname: string
  readonly spanName: string
  readonly filePath: string
  readonly declaredErrorTags: ReadonlyArray<string>
  readonly declaredBranchTags?: ReadonlyArray<string> | undefined
}

export interface TraceSpanObservation {
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly name: string
  readonly exitTag?: "Success" | "Failure" | "Defect" | undefined
  readonly errorTag?: string | null | undefined
  readonly valueTag?: string | null | undefined
}

export interface SaturationViolation {
  readonly ruleId: "SAT-01" | "SAT-02"
  readonly kind: "unexercised-error-channel" | "shallow-branch-saturation"
  readonly spanQualname: string
  readonly spanName: string
  readonly filePath: string
  readonly missingTags: ReadonlyArray<string>
  readonly message: string
}

export type SpanSaturationObservation = TraceSpanObservation

export interface MutationEvaluationInput {
  readonly outcomes: ReadonlyArray<MutantOutcome>
  readonly minScore?: number | undefined
  readonly equivalencePriors?: Readonly<Record<string, number>> | undefined
  readonly saturationSpecs?: ReadonlyArray<SpanSaturationSpec> | undefined
  readonly traceObservations?: ReadonlyArray<TraceSpanObservation> | undefined
  readonly spanObservations?: ReadonlyArray<SpanSaturationObservation> | undefined
}

export interface MutationSuiteReport {
  readonly passed: boolean
  readonly totalMutants: number
  readonly killedCount: number
  readonly survivedCount: number
  readonly mutationScore: number
  readonly survivedMutants: ReadonlyArray<CodeMutant>
  readonly equivalentCount?: number | undefined
  readonly equivalentMutants?: ReadonlyArray<CodeMutant> | undefined
  readonly saturationViolations?: ReadonlyArray<SaturationViolation> | undefined
  readonly diagnostic?: string | undefined
}

export const evaluateSpanSaturationViolations = (
  specs: ReadonlyArray<SpanSaturationSpec>,
  observations: ReadonlyArray<TraceSpanObservation>,
): ReadonlyArray<SaturationViolation> => {
  const byId = new Map<string, TraceSpanObservation>(observations.map((o) => [o.spanId, o]))

  const getAncestorSpanNamesAndSelf = (obs: TraceSpanObservation): ReadonlySet<string> => {
    const names = new Set<string>([obs.name])
    const visited = new Set<string>([obs.spanId])
    let curParentId = obs.parentSpanId
    while (curParentId !== null && !visited.has(curParentId)) {
      visited.add(curParentId)
      const parent = byId.get(curParentId)
      if (parent === undefined) break
      names.add(parent.name)
      curParentId = parent.parentSpanId
    }
    return names
  }

  const errorTagsBySpan = new Map<string, Set<string>>()
  const branchTagsBySpan = new Map<string, Set<string>>()
  const recordTag = (map: Map<string, Set<string>>, key: string, val: string) => {
    let s = map.get(key)
    if (s === undefined) {
      s = new Set<string>()
      map.set(key, s)
    }
    s.add(val)
  }

  for (const obs of observations) {
    for (const spanName of getAncestorSpanNamesAndSelf(obs)) {
      if (obs.exitTag === "Failure" && typeof obs.errorTag === "string" && obs.errorTag.length > 0) {
        recordTag(errorTagsBySpan, spanName, obs.errorTag)
        recordTag(branchTagsBySpan, spanName, obs.errorTag)
      }
      if (typeof obs.valueTag === "string" && obs.valueTag.length > 0) {
        recordTag(branchTagsBySpan, spanName, obs.valueTag)
      }
    }
  }

  const violations: Array<SaturationViolation> = []
  for (const spec of specs) {
    const observedErrors = errorTagsBySpan.get(spec.spanName) ?? new Set<string>()
    const missingErrors = spec.declaredErrorTags.filter((tag) => !observedErrors.has(tag))
    if (missingErrors.length > 0) {
      violations.push({
        ruleId: "SAT-01",
        kind: "unexercised-error-channel",
        spanQualname: spec.spanQualname,
        spanName: spec.spanName,
        filePath: spec.filePath,
        missingTags: missingErrors,
        message: `[SAT-01] Unexercised error channel(s) on '${spec.spanName}' (${spec.spanQualname}): [${missingErrors.join(", ")}] were never observed on '${spec.spanName}' or its descendant spans.`,
      })
    }

    const declaredBranches = spec.declaredBranchTags ?? []
    if (declaredBranches.length >= 2) {
      const observedBranches = branchTagsBySpan.get(spec.spanName) ?? new Set<string>()
      const missingBranches = declaredBranches.filter((tag) => !observedBranches.has(tag))
      if (missingBranches.length > 0) {
        violations.push({
          ruleId: "SAT-02",
          kind: "shallow-branch-saturation",
          spanQualname: spec.spanQualname,
          spanName: spec.spanName,
          filePath: spec.filePath,
          missingTags: missingBranches,
          message: `[SAT-02] Shallow branch saturation on '${spec.spanName}' (${spec.spanQualname}): missing branch/outcome tags [${missingBranches.join(", ")}].`,
        })
      }
    }
  }

  return violations
}

export const normalizePriorMillis = (raw: number): number =>
  raw > 0 && raw < 1 ? Math.round(raw * 1000) : Math.round(raw)

export const isMutantMarkedEquivalent = (
  outcome: MutantOutcome,
  priors: Readonly<Record<string, number>> | undefined,
  threshold = 850,
): boolean =>
  match(outcome.status)
    .with("equivalent", () => true)
    .with("killed", "survived", () => {
      const prior = priors?.[outcome.mutant.id]
      if (prior === undefined) return false
      return normalizePriorMillis(prior) >= threshold
    })
    .exhaustive()

export const evaluateMutationOutcomes = (
  outcomes: ReadonlyArray<MutantOutcome>,
  minScore?: number,
  equivalencePriors?: Readonly<Record<string, number>>,
  saturationSpecs?: ReadonlyArray<SpanSaturationSpec>,
  spanObservations?: ReadonlyArray<SpanSaturationObservation>,
): MutationSuiteReport => {
  const equivalentMutantIds = new Set(
    outcomes
      .filter((o) =>
        match(o.status)
          .with("killed", () => false)
          .with("survived", "equivalent", () => isMutantMarkedEquivalent(o, equivalencePriors))
          .exhaustive(),
      )
      .map((o) => o.mutant.id),
  )
  const equivalentMutants = outcomes
    .filter((o) => equivalentMutantIds.has(o.mutant.id))
    .map((o) => o.mutant)
  const survivedMutants = outcomes
    .filter((o) =>
      match(o.status)
        .with("survived", () => !equivalentMutantIds.has(o.mutant.id))
        .with("killed", "equivalent", () => false)
        .exhaustive(),
    )
    .map((o) => o.mutant)
  const survivedCount = survivedMutants.length
  const killedCount = outcomes.filter((o) =>
    match(o.status)
      .with("killed", () => true)
      .with("survived", "equivalent", () => false)
      .exhaustive(),
  ).length
  const totalMutants = outcomes.length
  const actionableMutants = totalMutants - equivalentMutants.length
  const mutationScore = actionableMutants <= 0 ? 1 : killedCount / actionableMutants
  const effectiveMinScore = minScore ?? 1

  const saturationViolations =
    saturationSpecs !== undefined && spanObservations !== undefined
      ? evaluateSpanSaturationViolations(saturationSpecs, spanObservations)
      : undefined

  const saturationPassed = saturationViolations === undefined || saturationViolations.length === 0
  const passed = survivedCount === 0 && mutationScore >= effectiveMinScore && saturationPassed

  return {
    passed,
    totalMutants,
    killedCount,
    survivedCount,
    mutationScore,
    survivedMutants,
    ...(equivalencePriors !== undefined || equivalentMutants.length > 0
      ? { equivalentCount: equivalentMutants.length, equivalentMutants }
      : {}),
    ...(saturationViolations !== undefined ? { saturationViolations } : {}),
  } satisfies MutationSuiteReport
}

export const decideMutationReport = Effect.fn("MutationCheck.decide")(function* (
  input: MutationEvaluationInput,
) {
  return yield* Effect.succeed(
    evaluateMutationOutcomes(
      input.outcomes,
      input.minScore,
      input.equivalencePriors,
      input.saturationSpecs,
      input.spanObservations ?? input.traceObservations,
    ),
  )
})

/**
 * Decides whether the mutation suite report passes based on killed mutants,
 * minimum score threshold, equivalence priors, and span saturation specifications.
 */
export const decideMutationCheck = decideMutationReport

interface DomainFile {
  readonly scope: string
  readonly tier: "domain" | "core" | "contract"
  readonly fullPath: string
  readonly relFile: string
}

const findDomainFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
  scope?: string,
): ReadonlyArray<DomainFile> => {
  const results: Array<DomainFile> = []
  const libsDir = join(repoRoot, "libs")
  if (!hostIo.existsSync(libsDir)) return results

  const cleanScope = scope
    ? scope.replace(/^@harness\//, "").replace(/-(domain|core|contract)$/, "")
    : undefined
  const scopes =
    cleanScope !== undefined
      ? [cleanScope]
      : hostIo.readdirSync(libsDir).map((e) => e.name)

  for (const s of scopes) {
    const scopePath = join(libsDir, s)
    const tiersToScan = [
      { dir: join(scopePath, "domain", "src"), tier: "domain" as const },
      { dir: join(scopePath, "domain", "test", "fixtures"), tier: "domain" as const },
      { dir: join(scopePath, "core", "src"), tier: "core" as const },
      { dir: join(scopePath, "core", "test", "fixtures"), tier: "core" as const },
      { dir: join(scopePath, "contract", "src"), tier: "contract" as const },
    ]

    for (const { dir, tier } of tiersToScan) {
      if (!hostIo.existsSync(dir)) continue
      const walk = (d: string) => {
        for (const entry of hostIo.readdirSync(d)) {
          const full = join(d, entry.name)
          match({ isDirectory: entry.isDirectory, isFile: entry.isFile })
            .with({ isDirectory: true }, () => {
              walk(full)
            })
            .with({ isDirectory: false, isFile: true }, () => {
              if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
                if (tier === "contract") {
                  const content = hostIo.readTextSync(full)
                  if (content.includes("Effect.fn") || content.includes("Effect.gen") || content.includes("match(")) {
                    results.push({ scope: s, tier, fullPath: full, relFile: relative(repoRoot, full).replace(/\\/g, "/") })
                  }
                } else {
                  results.push({ scope: s, tier, fullPath: full, relFile: relative(repoRoot, full).replace(/\\/g, "/") })
                }
              }
            })
            .with({ isDirectory: false, isFile: false }, () => {})
            .exhaustive()
        }
      }
      walk(dir)
    }
  }

  return results
}

export const extractGitDiffModifiedLines = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyMap<string, ReadonlySet<number>> | undefined => {
  const res = extractGitDiffModifiedLinesChecked(repoRoot, hostIo)
  return match(res)
    .with({ kind: "ok" }, ({ lines }) => lines)
    .with({ kind: "not-git" }, () => undefined)
    .with({ kind: "failed" }, () => undefined)
    .exhaustive()
}

export const getWorkspaceGitDiffModifiedLines = extractGitDiffModifiedLines

export const findReachingTestFiles = (
  repoRoot: string,
  file: DomainFile,
  hostIo: SyncHostIo,
): ReadonlyArray<string> => {
  const testDir = join(repoRoot, "libs", file.scope, file.tier, "test")
  if (!hostIo.existsSync(testDir)) return []
  const reaching: Array<string> = []
  const walk = (dir: string) => {
    for (const entry of hostIo.readdirSync(dir)) {
      const full = join(dir, entry.name)
      match({ isDirectory: entry.isDirectory, isFile: entry.isFile })
        .with({ isDirectory: true }, () => {
          walk(full)
        })
        .with({ isDirectory: false, isFile: true }, () => {
          if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) {
            reaching.push(full)
          }
        })
        .with({ isDirectory: false, isFile: false }, () => {})
        .exhaustive()
    }
  }
  walk(testDir)
  return reaching
}

export const collectReachingTestAssertions = (
  repoRoot: string,
  file: DomainFile,
  hostIo: SyncHostIo,
): string =>
  findReachingTestFiles(repoRoot, file, hostIo).map((full) => hostIo.readTextSync(full)).join("\n")

export interface RunMutationOptions {
  readonly scope?: string | undefined
  readonly includeAllLines?: boolean | undefined
  readonly minScore?: number | undefined
  readonly testRunner?: ((mutant: CodeMutant, schemaSource: string, reachingTestFiles: ReadonlyArray<string>) => "killed" | "survived") | undefined
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
  const makeAbortedReport = (
    outcomesSoFar: ReadonlyArray<MutantOutcome>,
    diagnostic: string,
  ): MutationSuiteReport => {
    const base = evaluateMutationOutcomes(
      outcomesSoFar,
      options?.minScore,
      options?.equivalencePriors,
      options?.saturationSpecs,
      options?.spanObservations,
    )
    return {
      ...base,
      passed: false,
      diagnostic,
    }
  }

  const backupPath = join(repoRoot, ".harness", "mutation-backup.json")
  const startupDiag = recoverStartupBackup(repoRoot, backupPath, hostIo)
  if (startupDiag !== undefined) {
    process.stderr.write(`${startupDiag}\n`)
    return makeAbortedReport([], startupDiag)
  }

  const domainFiles = findDomainFiles(repoRoot, hostIo, options?.scope)
  const diffResult: GitDiffExtractionResult =
    options?.includeAllLines === true
      ? { kind: "not-git" }
      : extractGitDiffModifiedLinesChecked(repoRoot, hostIo)
  const diffAbortDiag = match(diffResult)
    .with({ kind: "failed" }, ({ reason }) => `[mutation-check] Failed to extract git diff modified lines: ${reason}`)
    .with({ kind: "ok" }, () => undefined)
    .with({ kind: "not-git" }, () => undefined)
    .exhaustive()
  if (diffAbortDiag !== undefined) {
    process.stderr.write(`${diffAbortDiag}\n`)
    return makeAbortedReport([], diffAbortDiag)
  }
  const diffLinesMap = match(diffResult)
    .with({ kind: "ok" }, ({ lines }) => lines)
    .with({ kind: "not-git" }, () => undefined)
    .with({ kind: "failed" }, () => undefined)
    .exhaustive()
  const outcomes: Array<MutantOutcome> = []

  for (const file of domainFiles) {
    const overlaySource = options?.sourceCodeOverlays?.[file.relFile]
    if (overlaySource === undefined && options?.includeAllLines !== true && diffLinesMap !== undefined) {
      if (!diffLinesMap.has(file.relFile)) continue
    }

    const modifiedLines =
      options?.includeAllLines === true || overlaySource !== undefined
        ? undefined
        : diffLinesMap !== undefined
          ? diffLinesMap.get(file.relFile)
          : undefined

    const originalContent = overlaySource ?? hostIo.readTextSync(file.fullPath)
    const mutants = discoverDomainMutants(
      file.relFile,
      originalContent,
      modifiedLines !== undefined && modifiedLines.size > 0 ? { modifiedLines } : undefined,
    )
    if (mutants.length === 0) continue

    const schemaBundle = compileMutantSchemaModule(file.relFile, originalContent, mutants)
    const reachingTestFiles = findReachingTestFiles(repoRoot, file, hostIo)

    if (reachingTestFiles.length === 0) {
      for (const mutant of mutants) outcomes.push({ mutant, status: "survived" })
      continue
    }

    if (options?.testRunner !== undefined) {
      const runner = options.testRunner
      const prevGlobal = getActiveMutantId()
      for (const mutant of mutants) {
        setActiveMutantId(mutant.id)
        const runRes = Result.try(() => runner(mutant, schemaBundle.schemaSource, reachingTestFiles))
        setActiveMutantId(prevGlobal)
        const runnerDiag = match(runRes)
          .with({ _tag: "Success" }, ({ success }) => {
            outcomes.push({ mutant, status: success === "killed" ? "killed" : "survived" })
            return undefined
          })
          .with({ _tag: "Failure" }, ({ failure }) =>
            `[mutation-check] Custom testRunner threw for mutant '${mutant.id}': ${failure instanceof Error ? failure.message : String(failure)}`,
          )
          .exhaustive()
        if (runnerDiag !== undefined) {
          process.stderr.write(`${runnerDiag}\n`)
          return makeAbortedReport(outcomes, runnerDiag)
        }
      }
      continue
    }

    if (overlaySource !== undefined) {
      for (const mutant of mutants) {
        outcomes.push({ mutant, status: "survived" })
      }
      continue
    }

    const originalSource = originalContent
    const backupWriteErr = writeMutationBackup(
      repoRoot,
      backupPath,
      file.fullPath,
      originalSource,
      schemaBundle.schemaSource,
      hostIo,
    )
    if (backupWriteErr !== undefined) {
      process.stderr.write(`${backupWriteErr}\n`)
      return makeAbortedReport(outcomes, backupWriteErr)
    }

    const restoreOriginalFile = (): string | undefined => {
      const primaryWrite = Result.try(() => {
        hostIo.writeTextSync(file.fullPath, originalSource)
      })
      const primaryError = match(primaryWrite)
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
        return undefined
      }

      // Retry restoring from backupPath before giving up
      const retryRes = Result.try(() => {
        const raw = hostIo.readTextSync(backupPath)
        const decoded = Schema.decodeOption(BackupSchema)(raw)
        const sourceToWrite = match(decoded)
          .with({ _tag: "Some" }, ({ value }) => value.content ?? value.originalSource ?? originalSource)
          .with({ _tag: "None" }, () => originalSource)
          .exhaustive()
        hostIo.writeTextSync(file.fullPath, sourceToWrite)
      })

      return match(retryRes)
        .with({ _tag: "Success" }, () => {
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
    const onSigInt = () => { onProcessExit(); process.exit(130) }
    const onSigTerm = () => { onProcessExit(); process.exit(143) }
    process.once("exit", onProcessExit); process.once("SIGINT", onSigInt); process.once("SIGTERM", onSigTerm)

    const prevGlobal = getActiveMutantId()
    const prevEnv = process.env["HARNESS_ACTIVE_MUTANT_ID"]
    const cleanupProcessState = () => {
      setActiveMutantId(prevGlobal)
      if (prevEnv === undefined) {
        delete process.env["HARNESS_ACTIVE_MUTANT_ID"]
      } else {
        process.env["HARNESS_ACTIVE_MUTANT_ID"] = prevEnv
      }
      process.removeListener("exit", onProcessExit)
      process.removeListener("SIGINT", onSigInt)
      process.removeListener("SIGTERM", onSigTerm)
    }

    const writeSchemaRes = Result.try(() => {
      hostIo.writeTextSync(file.fullPath, schemaBundle.schemaSource)
    })
    const writeSchemaErr = match(writeSchemaRes)
      .with({ _tag: "Success" }, () => undefined)
      .with({ _tag: "Failure" }, ({ failure }) =>
        failure instanceof Error ? failure.message : String(failure),
      )
      .exhaustive()

    if (writeSchemaErr !== undefined) {
      cleanupProcessState()
      const restoreErr = restoreOriginalFile()
      const diag =
        restoreErr !== undefined
          ? `[mutation-check] Failed to write mutated schema for '${file.relFile}': ${writeSchemaErr} (${restoreErr})`
          : `[mutation-check] Failed to write mutated schema for '${file.relFile}': ${writeSchemaErr}`
      process.stderr.write(`${diag}\n`)
      return makeAbortedReport(outcomes, diag)
    }

    let runnerAbortDiagnostic: string | undefined = undefined
    for (const mutant of mutants) {
      setActiveMutantId(mutant.id)
      process.env["HARNESS_ACTIVE_MUTANT_ID"] = mutant.id
      const execRes = Result.try(() =>
        hostIo.execFileSync("pnpm", ["vitest", "run", ...reachingTestFiles], {
          cwd: repoRoot,
          timeoutMs: 30_000,
          env: { ...process.env, HARNESS_ACTIVE_MUTANT_ID: mutant.id },
        }),
      )
      const outcomeOrAbort = match(execRes)
        .with({ _tag: "Success" }, ({ success }) => {
          const combinedOutput = `${success.stdout}\n${success.stderr}`
          const hasVitestTestFailureEvidence =
            /\bTests\s+[1-9]\d*\s+failed\b/.test(combinedOutput)
          const hasModuleLoadOrSyntaxError =
            /\b(?:SyntaxError:|ERR_MODULE_NOT_FOUND)\b/.test(combinedOutput) ||
            /\bTests\s+no tests\b/i.test(combinedOutput)
          const isExit1WithoutTestFailure =
            success.exitCode === 1 && !hasVitestTestFailureEvidence
          const isRunnerStartupOrCompileError =
            success.exitCode < 0 ||
            success.exitCode > 1 ||
            hasModuleLoadOrSyntaxError ||
            isExit1WithoutTestFailure ||
            /\bERR_PNPM_|ERR_MODULE_NOT_FOUND|Command\s+["']?vitest["']?\s+not found|Failed to load config|Failed to resolve import|Cannot find (?:module|package)|No test (?:files|suite) found|Startup Error|Transform failed with \d+ error/i.test(
              combinedOutput,
            )
          if (
            success.spawnError != null ||
            success.timedOut === true ||
            success.signal != null ||
            isRunnerStartupOrCompileError
          ) {
            const reasons: Array<string> = []
            if (success.spawnError != null) reasons.push(`spawnError=${success.spawnError}`)
            if (success.timedOut === true) reasons.push("timedOut=true")
            if (success.signal != null) reasons.push(`signal=${success.signal}`)
            if (isRunnerStartupOrCompileError) reasons.push(`exitCode=${success.exitCode}`)
            if (isExit1WithoutTestFailure) reasons.push("missingVitestFailureEvidence=true")
            if (success.stderr.trim().length > 0) reasons.push(`stderr=${success.stderr.trim()}`)
            return {
              kind: "abort" as const,
              diagnostic: `[mutation-check] Runner infrastructure failure for mutant '${mutant.id}': ${reasons.join(", ")}`,
            }
          }
          return {
            kind: "outcome" as const,
            status: success.exitCode !== 0 ? ("killed" as const) : ("survived" as const),
          }
        })
        .with({ _tag: "Failure" }, ({ failure }) => ({
          kind: "abort" as const,
          diagnostic: `[mutation-check] Runner execution threw for mutant '${mutant.id}': ${failure instanceof Error ? failure.message : String(failure)}`,
        }))
        .exhaustive()

      const abortDiagnostic = match(outcomeOrAbort)
        .with({ kind: "abort" }, ({ diagnostic }) => diagnostic)
        .with({ kind: "outcome" }, ({ status }) => {
          outcomes.push({ mutant, status })
          return undefined
        })
        .exhaustive()
      if (abortDiagnostic !== undefined) {
        runnerAbortDiagnostic = abortDiagnostic
        break
      }
    }

    cleanupProcessState()
    const restoreErr = restoreOriginalFile()

    if (runnerAbortDiagnostic !== undefined) {
      process.stderr.write(`${runnerAbortDiagnostic}\n`)
      return makeAbortedReport(outcomes, runnerAbortDiagnostic)
    }
    if (restoreErr !== undefined) {
      return makeAbortedReport(outcomes, restoreErr)
    }
  }

  return evaluateMutationOutcomes(
    outcomes,
    options?.minScore,
    options?.equivalencePriors,
    options?.saturationSpecs,
    options?.spanObservations,
  )
}

export const MutationCheck = {
  decide: decideMutationCheck,
  evaluateReport: evaluateMutationOutcomes,
  runSuite: runDomainMutationSuite,
  withActiveMutant: withActiveMutantEffect,
} as const
