/**
 * @fileoverview Mutation verification gate, mutant discovery, test execution, and span saturation analysis.
 */
import { join, resolve } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
import { AstSourceFilePath, SourceLineNumber } from "@harness/contract"
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
  findDomainFilesChecked,
  findReachingTestFiles,
  findReachingTestFilesChecked,
  findUnclassifiedModifiedLibFiles,
  findUnclassifiedModifiedLibFilesChecked,
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
  readonly enforcementMode?: "strict" | "advisory" | undefined
  readonly targetFiles?: ReadonlyArray<string> | undefined
  readonly baseRef?: string | undefined
  readonly explicitBaseRef?: boolean | undefined
  readonly minScore?: number | undefined
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
  const untestedFiles: Array<UntestedMutationFile> = []

  const isStrictMode = match(options?.enforcementMode)
    .with("strict", () => true)
    .with("advisory", undefined, () => false)
    .exhaustive()

  const makeAbortedReport = (
    outcomesSoFar: ReadonlyArray<MutantOutcome>,
    diagnostic: string,
  ): MutationSuiteReport => ({
    ...evaluateMutationOutcomes(
      outcomesSoFar,
      options?.minScore,
      options?.equivalencePriors,
      options?.saturationSpecs,
      options?.spanObservations,
    ),
    passed: false,
    diagnostic,
    diffMode,
    scannedCandidateFiles,
    scannedFiles,
    diffMatchedFiles,
    evaluatedFiles,
    ...(untestedFiles.length > 0 ? { untestedFiles } : {}),
  })
  const abortWith = (
    outcomesSoFar: ReadonlyArray<MutantOutcome>,
    diagnostic: string,
  ): MutationSuiteReport => {
    process.stderr.write(`${diagnostic}\n`)
    return makeAbortedReport(outcomesSoFar, diagnostic)
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
  if (!hasOverlays && hasTargetFilesOpt && !isExplicitTarget) {
    return abortWith([], "[mutation-check] Explicit targetFiles (--file) was provided but empty.")
  }

  const domainFilesRes = findDomainFilesChecked(
    repoRoot,
    hostIo,
    options?.scope,
    options?.targetFiles,
  )
  const domainFiles = match(domainFilesRes)
    .with({ _tag: "Ok" }, ({ files }) => files)
    .with({ _tag: "Error" }, () => undefined)
    .exhaustive()
  if (domainFiles === undefined) {
    const errReason = match(domainFilesRes)
      .with({ _tag: "Error" }, ({ reason }) => reason)
      .with({ _tag: "Ok" }, () => "")
      .exhaustive()
    return abortWith([], `[mutation-check] Target discovery failed: ${errReason}`)
  }

  const domainByRel = new Map(domainFiles.map((f) => [f.relFile, f]))
  const targets: Array<DomainFile> = []
  if (hasOverlays) {
    for (const relFile of normalizedOverlays.keys()) {
      const existing = domainByRel.get(relFile)
      if (existing !== undefined) {
        targets.push(existing)
        continue
      }
      const parts = /^libs\/([^/]+)\/([^/]+)\//.exec(relFile)
      if (parts === null) {
        return abortWith(
          [],
          `[mutation-check] Invalid overlay path '${relFile}': expected 'libs/<scope>/<pkg>/...'`,
        )
      }
      const scope = parts[1]!
      const pkgDir = parts[2]!
      const tier = match<string, DomainFile["tier"]>(pkgDir)
        .with("contract", () => "contract")
        .with("core", "gates", "graph", "decision", "ingest", () => "core")
        .otherwise(() => "domain")
      targets.push({ scope, pkgDir, tier, fullPath: join(repoRoot, relFile), relFile })
    }
  } else {
    targets.push(...domainFiles)
  }
  scannedCandidateFiles = targets.length

  if (!hasOverlays && hasTargetFilesOpt) {
    const discoveredSet = new Set(domainFiles.map((f) => f.relFile))
    for (const rawTarget of targetFilesOpt) {
      const normTarget = rawTarget.replace(/\\/g, "/").replace(/^\.\//, "")
      if (!discoveredSet.has(normTarget)) {
        return abortWith(
          [],
          `[mutation-check] Requested target file '${normTarget}' was not found in discovered domain/core/contract files.`,
        )
      }
    }
  }
  if (!hasOverlays && isStrictMode && options?.scope !== undefined && domainFiles.length === 0) {
    return abortWith(
      [],
      `[mutation-check] No domain/core/contract files matched scope '${options.scope}' in strict mode.`,
    )
  }

  const resolvedDiff = hasOverlays
    ? { _tag: "Ok" as const, diffMode: "explicit-files" as const, diffLinesMap: undefined }
    : isExplicitTarget
      ? { _tag: "Ok" as const, diffMode: "explicit-files" as const, diffLinesMap: undefined }
      : match(
          extractGitDiffModifiedLinesChecked(repoRoot, hostIo, {
            fallbackBaseRef: options?.baseRef ?? (isStrictMode ? "main" : undefined),
            explicitBaseRef: options?.explicitBaseRef,
          }),
        )
          .with({ _tag: "Failed" }, ({ reason }) => ({
            _tag: "Abort" as const,
            diagnostic: `[mutation-check] Failed to extract git diff modified lines: ${reason}`,
          }))
          .with({ _tag: "Ok" }, ({ lines, diffMode: extractedMode }) => ({
            _tag: "Ok" as const,
            diffMode: options?.includeAllLines === true ? ("all-lines" as const) : extractedMode,
            diffLinesMap: lines,
          }))
          .with({ _tag: "NotGit" }, () => ({
            _tag: "Ok" as const,
            diffMode:
              options?.includeAllLines === true ? ("all-lines" as const) : ("not-git" as const),
            diffLinesMap: undefined,
          }))
          .exhaustive()

  const diffAbort = match(resolvedDiff)
    .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
    .with({ _tag: "Ok" }, (ok) => {
      diffMode = ok.diffMode
      return undefined
    })
    .exhaustive()
  if (diffAbort !== undefined) return abortWith([], diffAbort)
  const diffLinesMap = match(resolvedDiff)
    .with({ _tag: "Ok" }, ({ diffLinesMap: m }) => m)
    .with({ _tag: "Abort" }, () => undefined)
    .exhaustive()

  if (
    isStrictMode &&
    options?.scope === undefined &&
    !hasTargetFilesOpt &&
    diffLinesMap !== undefined
  ) {
    const unclassifiedRes = findUnclassifiedModifiedLibFilesChecked(
      repoRoot,
      diffLinesMap,
      domainFiles,
      hostIo,
    )
    const unclassifiedErr = match(unclassifiedRes)
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
    if (unclassifiedErr !== undefined) return abortWith([], unclassifiedErr)
  }

  const outcomes: Array<MutantOutcome> = []
  for (const file of targets) {
    const overlaySource = normalizedOverlays.get(file.relFile)
    if (diffLinesMap !== undefined && diffLinesMap.has(file.relFile)) {
      diffMatchedFiles.push(file.relFile)
    }
    const bypassDiffFilter =
      overlaySource !== undefined || options?.includeAllLines === true || isExplicitTarget
    if (!bypassDiffFilter && diffLinesMap !== undefined && !diffLinesMap.has(file.relFile)) {
      continue
    }

    scannedFiles.push(file.relFile)
    const modifiedLines = bypassDiffFilter ? undefined : diffLinesMap?.get(file.relFile)
    const originalContentRes =
      overlaySource !== undefined
        ? Result.succeed(overlaySource)
        : Result.try({
            try: () => hostIo.readTextSync(file.fullPath),
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          })
    const originalContent = match(originalContentRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, () => undefined)
      .exhaustive()
    if (originalContent === undefined) {
      const readErr = match(originalContentRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, () => "")
        .exhaustive()
      return abortWith(
        outcomes,
        `[mutation-check] Failed to read source file '${file.relFile}': ${readErr}`,
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
      const reachingRes = findReachingTestFilesChecked(repoRoot, file, hostIo)
      const reachingTestFiles = match(reachingRes)
        .with({ _tag: "Ok" }, ({ files }) => files)
        .with({ _tag: "Error" }, () => undefined)
        .exhaustive()
      if (reachingTestFiles === undefined) {
        const errReason = match(reachingRes)
          .with({ _tag: "Error" }, ({ reason }) => reason)
          .with({ _tag: "Ok" }, () => "")
          .exhaustive()
        return abortWith(outcomes, `[mutation-check] ${errReason}`)
      }
      if (reachingTestFiles.length === 0) {
        untestedFiles.push({
          file: file.relFile,
          reason: `0 reaching tests found for '${file.relFile}'`,
        })
        continue
      }
      const runner = options.testRunner
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
      const baselineRes = Result.try(() =>
        runner(baselineMutant, originalContent, reachingTestFiles),
      )
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
      if (baselineDiag !== undefined) return abortWith(outcomes, baselineDiag)

      for (const mutant of mutants) {
        setActiveMutantId(mutant.id)
        const runRes = Result.try(() =>
          runner(mutant, schemaBundle.schemaSource, reachingTestFiles),
        )
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
        if (runnerDiag !== undefined) return abortWith(outcomes, runnerDiag)
      }
      continue
    }

    const baseSubprocessEnv: Record<string, string | undefined> = {
      ...hostIo.getEnv(),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      HARNESS_ACTIVE_BACKUP_PATH: resolvedBackupPath,
    }
    delete baseSubprocessEnv["HARNESS_ACTIVE_MUTANT_ID"]

    const partitionRes = partitionReachingTestFilesChecked(repoRoot, file, originalContent, hostIo)
    const partition = match(partitionRes)
      .with({ _tag: "Ok" }, ({ partition: p }) => p)
      .with({ _tag: "Error" }, () => undefined)
      .exhaustive()
    if (partition === undefined) {
      const errReason = match(partitionRes)
        .with({ _tag: "Error" }, ({ reason }) => reason)
        .with({ _tag: "Ok" }, () => "")
        .exhaustive()
      return abortWith(outcomes, `[mutation-check] ${errReason}`)
    }
    const { primaryTests, fallbackTests } = partition
    if (primaryTests.length === 0 && fallbackTests.length === 0) {
      untestedFiles.push({
        file: file.relFile,
        reason: `0 reaching tests found for '${file.relFile}'`,
      })
      continue
    }
    const primaryRes = runVitestTargetList(
      repoRoot,
      file,
      hostIo,
      baseSubprocessEnv,
      primaryTests,
      originalContent,
      schemaBundle.schemaSource,
      backupPath,
      mutants,
    )
    const primaryOutcomes = match(primaryRes)
      .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
      .with({ _tag: "Ok" }, ({ outcomes: resOutcomes }) => resOutcomes)
      .exhaustive()
    if (typeof primaryOutcomes === "string") return abortWith(outcomes, primaryOutcomes)

    const fileOutcomes = new Map<string, MutantOutcome>(
      primaryOutcomes.map((o) => [o.mutant.id, o]),
    )
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
        .with({ _tag: "Ok" }, ({ outcomes: fbOutcomes }) => {
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
        for (const o of fileOutcomes.values()) outcomes.push(o)
        return abortWith(outcomes, fallbackAbort)
      }
    }
    for (const o of fileOutcomes.values()) outcomes.push(o)
  }

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

  return {
    ...evaluateMutationOutcomes(
      outcomes,
      options?.minScore,
      options?.equivalencePriors,
      options?.saturationSpecs,
      options?.spanObservations,
    ),
    diffMode,
    scannedCandidateFiles,
    scannedFiles,
    diffMatchedFiles,
    evaluatedFiles,
    ...(untestedFiles.length > 0 ? { untestedFiles } : {}),
  }
}

export const MutationCheck = {
  decide: decideMutationCheck,
  evaluateReport: evaluateMutationOutcomes,
  runSuite: runDomainMutationSuite,
  withActiveMutant: withActiveMutantEffect,
} as const
