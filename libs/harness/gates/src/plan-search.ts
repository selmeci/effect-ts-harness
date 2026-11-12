import { Effect, Schema } from "effect"

export const PlanSearchCandidateId = Schema.NonEmptyString.pipe(
  Schema.brand("PlanSearchCandidateId"),
)
export type PlanSearchCandidateId = typeof PlanSearchCandidateId.Type

export const PlanCandidateId = PlanSearchCandidateId
export type PlanCandidateId = PlanSearchCandidateId

export const PlanSearchWorktreeId = Schema.NonEmptyString.pipe(Schema.brand("PlanSearchWorktreeId"))
export type PlanSearchWorktreeId = typeof PlanSearchWorktreeId.Type

export const PlanSearchSummary = Schema.NonEmptyString.pipe(Schema.brand("PlanSearchSummary"))
export type PlanSearchSummary = typeof PlanSearchSummary.Type

export const PlanCandidateDescription = PlanSearchSummary
export type PlanCandidateDescription = PlanSearchSummary

export const PlanSearchFailureReason = PlanSearchSummary
export type PlanSearchFailureReason = PlanSearchSummary

export const PlanSearchCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("PlanSearchCount"),
)
export type PlanSearchCount = typeof PlanSearchCount.Type

export const PlanSearchScoreMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  Schema.brand("PlanSearchScoreMillis"),
)
export type PlanSearchScoreMillis = typeof PlanSearchScoreMillis.Type

export const PlanSearchFlag = Schema.Boolean.pipe(Schema.brand("PlanSearchFlag"))
export type PlanSearchFlag = typeof PlanSearchFlag.Type

export const PlanSearchCandidate = Schema.Struct({
  candidateId: PlanSearchCandidateId,
  worktreeId: PlanSearchWorktreeId,
  summary: PlanSearchSummary,
  violationCount: PlanSearchCount,
  cyclomaticComplexity: PlanSearchCount,
  stubHoleCount: PlanSearchCount,
  cohesionPriorMillis: Schema.optional(PlanSearchScoreMillis),
})
export type PlanSearchCandidate = typeof PlanSearchCandidate.Type

export const PlanCandidateSkeleton = PlanSearchCandidate
export type PlanCandidateSkeleton = PlanSearchCandidate

export const PlanSearchInput = Schema.Struct({
  candidates: Schema.Array(PlanSearchCandidate),
  requireZeroViolations: Schema.optional(PlanSearchFlag),
})
export type PlanSearchInput = typeof PlanSearchInput.Type

export const PlanSearchReport = Schema.Struct({
  winner: PlanSearchCandidate,
  rankedCandidates: Schema.Array(PlanSearchCandidate),
})
export type PlanSearchReport = typeof PlanSearchReport.Type

export class PlanSearchError extends Schema.TaggedError<PlanSearchError>()("PlanSearchError", {
  reason: PlanSearchSummary,
  candidateCount: PlanSearchCount,
}) {}

export const comparePlanSearchCandidates = (
  a: PlanSearchCandidate,
  b: PlanSearchCandidate,
): number => {
  if (a.violationCount !== b.violationCount) {
    return a.violationCount - b.violationCount
  }
  const aComplexity = a.cyclomaticComplexity + a.stubHoleCount
  const bComplexity = b.cyclomaticComplexity + b.stubHoleCount
  if (aComplexity !== bComplexity) {
    return aComplexity - bComplexity
  }
  const aPrior = a.cohesionPriorMillis ?? 500
  const bPrior = b.cohesionPriorMillis ?? 500
  if (bPrior !== aPrior) {
    return bPrior - aPrior
  }
  return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0
}

export const decidePlanSearch = Effect.fn("PlanSearch.decide")(function* (
  input: PlanSearchInput,
): Effect.fn.Return<PlanSearchReport, PlanSearchError, never> {
  if (input.candidates.length === 0) {
    return yield* new PlanSearchError({
      reason: PlanSearchSummary.make(
        "PlanSearch.decide requires at least one candidate skeleton decomposition.",
      ),
      candidateCount: PlanSearchCount.make(0),
    })
  }

  const rankedCandidates = [...input.candidates].sort(comparePlanSearchCandidates)
  const winner = rankedCandidates[0]!

  if (input.requireZeroViolations === true && winner.violationCount > 0) {
    return yield* new PlanSearchError({
      reason: PlanSearchSummary.make(
        `All ${input.candidates.length} candidate skeleton(s) have violationCount > 0 (best candidate '${winner.candidateId}' has ${winner.violationCount} violation(s)).`,
      ),
      candidateCount: PlanSearchCount.make(input.candidates.length),
    })
  }

  return {
    winner,
    rankedCandidates,
  }
})

export const PlanSearch = {
  decide: decidePlanSearch,
  compareCandidates: comparePlanSearchCandidates,
} as const
