/**
 * @fileoverview Mutation outcome evaluation and span saturation analysis.
 */
import { Effect } from "effect"
import { match } from "ts-pattern"
import type { CodeMutant, MutantOutcome } from "./mutant-ast-generator.js"

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

export interface UntestedMutationFile {
  readonly file: string
  readonly reason: string
}

export interface MutationOutcomesSummary {
  readonly passed: boolean
  readonly totalMutants: number
  readonly killedCount: number
  readonly survivedCount: number
  readonly equivalentCount: number
  readonly mutationScore: number
  readonly survivedMutants: ReadonlyArray<CodeMutant>
  readonly equivalentMutants?: ReadonlyArray<CodeMutant> | undefined
  readonly saturationViolations?: ReadonlyArray<SaturationViolation> | undefined
}

export interface MutationSuiteReport extends MutationOutcomesSummary {
  readonly diagnostic?: string | undefined
  readonly cachedKilledCount?: number | undefined
  readonly diffMode: "all-lines" | "explicit-files" | "working-tree" | "branch-base" | "not-git"
  readonly scannedCandidateFiles: number
  readonly scannedFiles: ReadonlyArray<string>
  readonly diffMatchedFiles: ReadonlyArray<string>
  readonly evaluatedFiles: ReadonlyArray<string>
  readonly untestedFiles?: ReadonlyArray<UntestedMutationFile> | undefined
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

/**
 * Normalizes an equivalence prior expressed on the canonical `0..1000` millis scale
 * (`SPEC-0009 REQ-3.1`, `ConfidenceMillis`).
 *
 * Unit-interval `[0, 1]` floats are intentionally not rescaled because `1 === 1.0` in JS:
 * rescaling `<= 1` fails open by inflating `1` millis (`0.1%`) to `1000` millis (`100%`),
 * while rescaling `< 1` created a `0.999 -> 999` vs `1.0 -> 1` cliff. Non-finite and
 * negative inputs clamp fail-closed to `0`; values above `1000` clamp to `1000`.
 */
export const normalizePriorMillis = (raw: number): number => {
  if (!Number.isFinite(raw)) {
    return 0
  }
  return Math.min(1000, Math.max(0, Math.round(raw)))
}

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
): MutationOutcomesSummary => {
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
    equivalentCount: equivalentMutants.length,
    mutationScore,
    survivedMutants,
    ...(equivalencePriors !== undefined || equivalentMutants.length > 0
      ? { equivalentMutants }
      : {}),
    ...(saturationViolations !== undefined ? { saturationViolations } : {}),
  }
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
