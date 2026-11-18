/**
 * @fileoverview Mutation verification gate, mutant discovery, test execution, and span saturation analysis.
 */
import { join, resolve } from "node:path"
import { Effect, Result } from "effect"
import { match } from "ts-pattern"
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
  MutantOutcome,
  type MutantSchemaModule,
  parseGitDiffModifiedLines,
  verifyMutantSchemaSyntax,
} from "./mutation/mutant-ast-generator.js"
import {
  extractGitDiffModifiedLinesChecked,
  recoverStartupBackup,
} from "./mutation/mutation-backup.js"
import {
  type DomainFile,
  findDomainFiles,
  findReachingTestFiles,
  findUnclassifiedModifiedLibFiles,
  partitionReachingTestFiles,
} from "./mutation/mutation-target-discovery.js"

export {
  stripAnsi,
  MutantCategory,
  CodeMutant,
  MutantOutcome,
  type MutantSchemaModule,
  type DomainFile,
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
  readonly diffMode?:
    | "all-lines"
    | "explicit-files"
    | "working-tree"
    | "branch-base"
    | "not-git"
    | undefined
  readonly scannedCandidateFiles?: number | undefined
  readonly diffMatchedFiles?: ReadonlyArray<string> | undefined
  readonly evaluatedFiles?: ReadonlyArray<string> | undefined
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
      if (
        obs.exitTag === "Failure" &&
        typeof obs.errorTag === "string" &&
        obs.errorTag.length > 0
      ) {
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
      return prior !== undefined && normalizePriorMillis(prior) >= threshold
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
  const actionableMutants = outcomes.length - equivalentMutants.length
  const mutationScore = actionableMutants <= 0 ? 1 : killedCount / actionableMutants
  const saturationViolations =
    saturationSpecs !== undefined && spanObservations !== undefined
      ? evaluateSpanSaturationViolations(saturationSpecs, spanObservations)
      : undefined
  const passed =
    survivedCount === 0 &&
    mutationScore >= (minScore ?? 1) &&
    (saturationViolations === undefined || saturationViolations.length === 0)

  return {
    passed,
    totalMutants: outcomes.length,
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

export const decideMutationCheck = decideMutationReport

export const extractGitDiffModifiedLines = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyMap<string, ReadonlySet<number>> | undefined =>
  match(extractGitDiffModifiedLinesChecked(repoRoot, hostIo))
    .with({ kind: "ok" }, ({ lines }) => lines)
    .with({ kind: "not-git" }, () => undefined)
    .with({ kind: "failed" }, () => undefined)
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
  let diffMode: MutationSuiteReport["diffMode"] = undefined
  let scannedCandidateFiles: number | undefined = undefined
  const diffMatchedFiles: Array<string> = []
  const evaluatedFiles: Array<string> = []

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
    ...(diffMode !== undefined ? { diffMode } : {}),
    ...(scannedCandidateFiles !== undefined ? { scannedCandidateFiles } : {}),
    diffMatchedFiles,
    evaluatedFiles,
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
    !hasOverlays && process.env["HARNESS_ACTIVE_BACKUP_PATH"] !== resolvedBackupPath
      ? recoverStartupBackup(repoRoot, backupPath, hostIo)
      : undefined
  if (startupDiag !== undefined) return abortWith([], startupDiag)

  const domainFiles = findDomainFiles(repoRoot, hostIo, options?.scope, options?.targetFiles)
  const domainByRel = new Map(domainFiles.map((f) => [f.relFile, f]))
  const targets: ReadonlyArray<DomainFile> = hasOverlays
    ? Array.from(normalizedOverlays.keys()).map((relFile) => {
        const existing = domainByRel.get(relFile)
        if (existing !== undefined) return existing
        const parts = /^libs\/([^/]+)\/([^/]+)\//.exec(relFile)
        const scope = parts?.[1] ?? "sample"
        const pkgDir = parts?.[2] ?? "domain"
        const tier = match<string, DomainFile["tier"]>(pkgDir)
          .with("contract", () => "contract")
          .with("core", "gates", "graph", "decision", "ingest", () => "core")
          .otherwise(() => "domain")
        return { scope, pkgDir, tier, fullPath: join(repoRoot, relFile), relFile }
      })
    : domainFiles
  scannedCandidateFiles = targets.length

  const targetFilesOpt = options?.targetFiles
  const hasTargetFilesOpt = targetFilesOpt !== undefined
  const isExplicitTarget = (targetFilesOpt?.length ?? 0) > 0

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
  if (
    !hasOverlays &&
    options?.enforcementMode === "strict" &&
    options?.scope !== undefined &&
    domainFiles.length === 0
  ) {
    return abortWith(
      [],
      `[mutation-check] No domain/core/contract files matched scope '${options.scope}' in strict mode.`,
    )
  }

  const resolvedDiff = hasOverlays
    ? { kind: "ok" as const, diffMode: "explicit-files" as const, diffLinesMap: undefined }
    : options?.includeAllLines === true
      ? { kind: "ok" as const, diffMode: "all-lines" as const, diffLinesMap: undefined }
      : isExplicitTarget
        ? { kind: "ok" as const, diffMode: "explicit-files" as const, diffLinesMap: undefined }
        : match(
            extractGitDiffModifiedLinesChecked(repoRoot, hostIo, {
              fallbackBaseRef:
                options?.baseRef ?? (options?.enforcementMode === "strict" ? "main" : undefined),
              explicitBaseRef: options?.explicitBaseRef,
            }),
          )
            .with({ kind: "failed" }, ({ reason }) => ({
              kind: "abort" as const,
              diagnostic: `[mutation-check] Failed to extract git diff modified lines: ${reason}`,
            }))
            .with({ kind: "ok" }, ({ lines, diffMode: extractedMode }) => ({
              kind: "ok" as const,
              diffMode: extractedMode,
              diffLinesMap: lines,
            }))
            .with({ kind: "not-git" }, () => ({
              kind: "ok" as const,
              diffMode: "not-git" as const,
              diffLinesMap: undefined,
            }))
            .exhaustive()

  const diffAbort = match(resolvedDiff)
    .with({ kind: "abort" }, ({ diagnostic }) => diagnostic)
    .with({ kind: "ok" }, (ok) => {
      diffMode = ok.diffMode
      return undefined
    })
    .exhaustive()
  if (diffAbort !== undefined) return abortWith([], diffAbort)
  const diffLinesMap = match(resolvedDiff)
    .with({ kind: "ok" }, ({ diffLinesMap: m }) => m)
    .with({ kind: "abort" }, () => undefined)
    .exhaustive()

  if (
    options?.enforcementMode === "strict" &&
    options?.scope === undefined &&
    !hasTargetFilesOpt &&
    diffLinesMap !== undefined
  ) {
    const unclassified = findUnclassifiedModifiedLibFiles(
      repoRoot,
      diffLinesMap,
      domainFiles,
      hostIo,
    )
    if (unclassified.length > 0)
      return abortWith(
        [],
        `[mutation-check] Unclassified modified lib file(s) in strict mode: ${unclassified.join(", ")}`,
      )
  }

  const outcomes: Array<MutantOutcome> = []
  for (const file of targets) {
    const overlaySource = normalizedOverlays.get(file.relFile)
    const bypassDiffFilter =
      overlaySource !== undefined || options?.includeAllLines === true || isExplicitTarget
    if (!bypassDiffFilter && diffLinesMap !== undefined) {
      if (!diffLinesMap.has(file.relFile)) continue
      diffMatchedFiles.push(file.relFile)
    }

    const modifiedLines = bypassDiffFilter ? undefined : diffLinesMap?.get(file.relFile)
    const originalContent = overlaySource ?? hostIo.readTextSync(file.fullPath)
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

    const reachingTestFiles = findReachingTestFiles(repoRoot, file, hostIo)
    if (reachingTestFiles.length === 0) {
      for (const mutant of mutants) outcomes.push({ mutant, status: "survived" })
      continue
    }

    if (options?.testRunner !== undefined) {
      const runner = options.testRunner
      const prevGlobal = getActiveMutantId()
      const prevEnv = process.env["HARNESS_ACTIVE_MUTANT_ID"]
      const restoreInProcessEnv = () => {
        setActiveMutantId(prevGlobal)
        if (prevEnv === undefined) delete process.env["HARNESS_ACTIVE_MUTANT_ID"]
        else process.env["HARNESS_ACTIVE_MUTANT_ID"] = prevEnv
      }
      const baselineMutant: CodeMutant = {
        id: "__baseline__",
        file: file.relFile,
        line: 1,
        category: "boolean-return",
        original: "",
        replacement: "",
        mutatedSource: originalContent,
      }
      setActiveMutantId(undefined)
      delete process.env["HARNESS_ACTIVE_MUTANT_ID"]
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
        process.env["HARNESS_ACTIVE_MUTANT_ID"] = mutant.id
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
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      HARNESS_ACTIVE_BACKUP_PATH: resolvedBackupPath,
    }
    delete baseSubprocessEnv["HARNESS_ACTIVE_MUTANT_ID"]

    const { primaryTests, fallbackTests } = partitionReachingTestFiles(
      repoRoot,
      file,
      originalContent,
      hostIo,
    )
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
      .with({ kind: "abort" }, ({ diagnostic }) => diagnostic)
      .with({ kind: "ok" }, ({ outcomes: resOutcomes }) => resOutcomes)
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
        .with({ kind: "abort" }, ({ diagnostic }) => diagnostic)
        .with({ kind: "ok" }, ({ outcomes: fbOutcomes }) => {
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

  return {
    ...evaluateMutationOutcomes(
      outcomes,
      options?.minScore,
      options?.equivalencePriors,
      options?.saturationSpecs,
      options?.spanObservations,
    ),
    ...(diffMode !== undefined ? { diffMode } : {}),
    scannedCandidateFiles,
    diffMatchedFiles,
    evaluatedFiles,
  }
}

export const MutationCheck = {
  decide: decideMutationCheck,
  evaluateReport: evaluateMutationOutcomes,
  runSuite: runDomainMutationSuite,
  withActiveMutant: withActiveMutantEffect,
} as const
