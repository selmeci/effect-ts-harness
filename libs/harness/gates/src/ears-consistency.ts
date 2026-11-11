import { Effect, Schema } from "effect"
import { match } from "ts-pattern"

export const EarsSpecId = Schema.NonEmptyString.pipe(Schema.brand("EarsSpecId"))
export type EarsSpecId = typeof EarsSpecId.Type

export const EarsFilePath = Schema.NonEmptyString.pipe(Schema.brand("EarsFilePath"))
export type EarsFilePath = typeof EarsFilePath.Type

export const EarsClauseId = Schema.NonEmptyString.pipe(Schema.brand("EarsClauseId"))
export type EarsClauseId = typeof EarsClauseId.Type

export const EarsEffectSymbolName = Schema.NonEmptyString.pipe(Schema.brand("EarsEffectSymbolName"))
export type EarsEffectSymbolName = typeof EarsEffectSymbolName.Type

export const EarsVariantTag = Schema.NonEmptyString.pipe(Schema.brand("EarsVariantTag"))
export type EarsVariantTag = typeof EarsVariantTag.Type

export const EarsGuardText = Schema.String.pipe(Schema.brand("EarsGuardText"))
export type EarsGuardText = typeof EarsGuardText.Type

export const EarsOutcomeTag = Schema.NonEmptyString.pipe(Schema.brand("EarsOutcomeTag"))
export type EarsOutcomeTag = typeof EarsOutcomeTag.Type

export const EarsConsistencyMessage = Schema.NonEmptyString.pipe(
  Schema.brand("EarsConsistencyMessage"),
)
export type EarsConsistencyMessage = typeof EarsConsistencyMessage.Type

export const EarsClausePatternKind = Schema.Literals([
  "Ubiquitous",
  "Event-driven",
  "State-driven",
  "Unwanted behaviour",
  "Optional feature",
  "Complex",
]).pipe(Schema.brand("EarsClausePatternKind"))
export type EarsClausePatternKind = typeof EarsClausePatternKind.Type

export const EarsClausePolarity = Schema.Literals(["shall", "shall_not"]).pipe(
  Schema.brand("EarsClausePolarity"),
)
export type EarsClausePolarity = typeof EarsClausePolarity.Type

export const EARS_GUARD_PAIR_RELATIONS = [
  "equivalent",
  "first_subsumes_second",
  "second_subsumes_first",
  "mutually_exclusive",
  "independent_overlapping",
] as const

export const EarsGuardPairRelation = Schema.Literals(EARS_GUARD_PAIR_RELATIONS).pipe(
  Schema.brand("EarsGuardPairRelation"),
)
export type EarsGuardPairRelation = typeof EarsGuardPairRelation.Type

export const EarsConsistencyRuleId = Schema.Literals(["EARS-01", "EARS-02", "EARS-03"]).pipe(
  Schema.brand("EarsConsistencyRuleId"),
)
export type EarsConsistencyRuleId = typeof EarsConsistencyRuleId.Type

export const EarsConsistencyViolationKind = Schema.Literals([
  "ears-contradictory-clauses",
  "ears-shadowed-clause",
  "ears-incomplete-state-coverage",
]).pipe(Schema.brand("EarsConsistencyViolationKind"))
export type EarsConsistencyViolationKind = typeof EarsConsistencyViolationKind.Type

export const EarsConsistencyFlag = Schema.Boolean.pipe(Schema.brand("EarsConsistencyFlag"))
export type EarsConsistencyFlag = typeof EarsConsistencyFlag.Type

export const EarsSemanticClause = Schema.Struct({
  clauseId: EarsClauseId,
  pattern: EarsClausePatternKind,
  effectSymbol: EarsEffectSymbolName,
  activeStateVariant: Schema.optional(EarsVariantTag),
  guardVariant: Schema.optional(EarsVariantTag),
  guardText: Schema.optional(EarsGuardText),
  outcomeTag: EarsOutcomeTag,
  polarity: EarsClausePolarity,
})
export type EarsSemanticClause = typeof EarsSemanticClause.Type

export const EarsGuardPairPrior = Schema.Struct({
  firstClauseId: EarsClauseId,
  secondClauseId: EarsClauseId,
  relation: EarsGuardPairRelation,
})
export type EarsGuardPairPrior = typeof EarsGuardPairPrior.Type

export const EarsConsistencyInput = Schema.Struct({
  specId: EarsSpecId,
  filePath: EarsFilePath,
  stateDomainVariants: Schema.Array(EarsVariantTag),
  guardDomainVariants: Schema.Array(EarsVariantTag),
  clauses: Schema.Array(EarsSemanticClause),
  guardPairPriors: Schema.optional(Schema.Array(EarsGuardPairPrior)),
  requireExhaustiveStateCoverage: Schema.optional(EarsConsistencyFlag),
})
export type EarsConsistencyInput = typeof EarsConsistencyInput.Type

export const EarsConsistencyViolation = Schema.Struct({
  ruleId: EarsConsistencyRuleId,
  kind: EarsConsistencyViolationKind,
  specId: EarsSpecId,
  filePath: EarsFilePath,
  clauseIds: Schema.Array(EarsClauseId),
  effectSymbol: EarsEffectSymbolName,
  message: EarsConsistencyMessage,
  uncoveredStateVariants: Schema.optional(Schema.Array(EarsVariantTag)),
})
export type EarsConsistencyViolation = typeof EarsConsistencyViolation.Type

export const EarsConsistencyReport = Schema.Struct({
  ok: EarsConsistencyFlag,
  specId: EarsSpecId,
  violations: Schema.Array(EarsConsistencyViolation),
})
export type EarsConsistencyReport = typeof EarsConsistencyReport.Type

export class EarsConsistencyError extends Schema.TaggedError<EarsConsistencyError>()(
  "EarsConsistencyError",
  {
    specId: EarsSpecId,
    violations: Schema.Array(EarsConsistencyViolation),
    message: EarsConsistencyMessage,
  },
) {}

const normalizeGuardText = (raw: string | undefined): string =>
  (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ")

const invertGuardRelation = (rel: EarsGuardPairRelation): EarsGuardPairRelation =>
  match(rel as (typeof EARS_GUARD_PAIR_RELATIONS)[number])
    .with("equivalent", () => EarsGuardPairRelation.make("equivalent"))
    .with("first_subsumes_second", () => EarsGuardPairRelation.make("second_subsumes_first"))
    .with("second_subsumes_first", () => EarsGuardPairRelation.make("first_subsumes_second"))
    .with("mutually_exclusive", () => EarsGuardPairRelation.make("mutually_exclusive"))
    .with("independent_overlapping", () => EarsGuardPairRelation.make("independent_overlapping"))
    .exhaustive()

const resolveGuardPairRelation = (
  first: EarsSemanticClause,
  second: EarsSemanticClause,
  priors: ReadonlyArray<EarsGuardPairPrior>,
): EarsGuardPairRelation => {
  for (const p of priors) {
    if (p.firstClauseId === first.clauseId && p.secondClauseId === second.clauseId) {
      return p.relation
    }
    if (p.firstClauseId === second.clauseId && p.secondClauseId === first.clauseId) {
      return invertGuardRelation(p.relation)
    }
  }

  const firstGuardVar = first.guardVariant
  const secondGuardVar = second.guardVariant
  const firstGuardStr = normalizeGuardText(first.guardText)
  const secondGuardStr = normalizeGuardText(second.guardText)

  const firstUnrestricted = firstGuardVar === undefined && firstGuardStr.length === 0
  const secondUnrestricted = secondGuardVar === undefined && secondGuardStr.length === 0

  if (firstUnrestricted && secondUnrestricted) {
    return EarsGuardPairRelation.make("equivalent")
  }
  if (firstUnrestricted && !secondUnrestricted) {
    return EarsGuardPairRelation.make("first_subsumes_second")
  }
  if (!firstUnrestricted && secondUnrestricted) {
    return EarsGuardPairRelation.make("second_subsumes_first")
  }

  if (firstGuardVar !== undefined && secondGuardVar !== undefined) {
    return firstGuardVar === secondGuardVar
      ? EarsGuardPairRelation.make("equivalent")
      : EarsGuardPairRelation.make("mutually_exclusive")
  }

  if (firstGuardStr.length > 0 && secondGuardStr.length > 0) {
    if (firstGuardStr === secondGuardStr) {
      return EarsGuardPairRelation.make("equivalent")
    }
    if (
      secondGuardStr.includes(firstGuardStr) &&
      (secondGuardStr.includes(" and ") || secondGuardStr.includes(" && "))
    ) {
      return EarsGuardPairRelation.make("first_subsumes_second")
    }
    if (
      firstGuardStr.includes(secondGuardStr) &&
      (firstGuardStr.includes(" and ") || firstGuardStr.includes(" && "))
    ) {
      return EarsGuardPairRelation.make("second_subsumes_first")
    }
  }

  return EarsGuardPairRelation.make("mutually_exclusive")
}

const doStatesOverlap = (first: EarsSemanticClause, second: EarsSemanticClause): boolean =>
  first.activeStateVariant === undefined ||
  second.activeStateVariant === undefined ||
  first.activeStateVariant === second.activeStateVariant

const doesFirstStateCoverSecond = (
  first: EarsSemanticClause,
  second: EarsSemanticClause,
): boolean =>
  first.activeStateVariant === undefined || first.activeStateVariant === second.activeStateVariant

export const evaluateEarsConsistencyReport = (
  input: EarsConsistencyInput,
): EarsConsistencyReport => {
  const violations: Array<EarsConsistencyViolation> = []
  const priors = input.guardPairPriors ?? []
  const clauses = input.clauses

  for (let i = 0; i < clauses.length; i++) {
    const first = clauses[i]!
    for (let j = i + 1; j < clauses.length; j++) {
      const second = clauses[j]!
      if (first.effectSymbol !== second.effectSymbol) {
        continue
      }

      const statesOverlap = doStatesOverlap(first, second)
      if (!statesOverlap) {
        continue
      }

      const guardRel = resolveGuardPairRelation(first, second, priors)
      const guardsOverlap = guardRel !== "mutually_exclusive"
      const sameOutcome =
        first.outcomeTag === second.outcomeTag && first.polarity === second.polarity

      // EARS-02: Earlier clause shadows subsequent clause
      const firstCoversSecondState = doesFirstStateCoverSecond(first, second)
      const firstCoversSecondGuard =
        guardRel === "equivalent" || guardRel === "first_subsumes_second"

      if (firstCoversSecondState && firstCoversSecondGuard && sameOutcome) {
        violations.push({
          ruleId: EarsConsistencyRuleId.make("EARS-02"),
          kind: EarsConsistencyViolationKind.make("ears-shadowed-clause"),
          specId: input.specId,
          filePath: input.filePath,
          clauseIds: [first.clauseId, second.clauseId],
          effectSymbol: first.effectSymbol,
          message: EarsConsistencyMessage.make(
            `[EARS-02] Clause '${second.clauseId}' on '${first.effectSymbol}' is shadowed by earlier clause '${first.clauseId}' (guard relation: ${guardRel}).`,
          ),
        })
        continue
      }

      if (
        firstCoversSecondState &&
        guardRel === "first_subsumes_second" &&
        !sameOutcome &&
        first.activeStateVariant === second.activeStateVariant
      ) {
        violations.push({
          ruleId: EarsConsistencyRuleId.make("EARS-02"),
          kind: EarsConsistencyViolationKind.make("ears-shadowed-clause"),
          specId: input.specId,
          filePath: input.filePath,
          clauseIds: [first.clauseId, second.clauseId],
          effectSymbol: first.effectSymbol,
          message: EarsConsistencyMessage.make(
            `[EARS-02] Clause '${second.clauseId}' on '${first.effectSymbol}' is shadowed by broader earlier guard in '${first.clauseId}' (guard relation: ${guardRel}).`,
          ),
        })
      }

      // EARS-01: Contradictory outcomes under overlapping state and guard
      if (guardsOverlap && !sameOutcome) {
        violations.push({
          ruleId: EarsConsistencyRuleId.make("EARS-01"),
          kind: EarsConsistencyViolationKind.make("ears-contradictory-clauses"),
          specId: input.specId,
          filePath: input.filePath,
          clauseIds: [first.clauseId, second.clauseId],
          effectSymbol: first.effectSymbol,
          message: EarsConsistencyMessage.make(
            `[EARS-01] Clauses '${first.clauseId}' (${first.polarity} -> ${first.outcomeTag}) and '${second.clauseId}' (${second.polarity} -> ${second.outcomeTag}) prescribe contradictory outcomes on '${first.effectSymbol}' under overlapping state and guard (${guardRel}).`,
          ),
        })
      }
    }
  }

  // EARS-03: State-space completeness over stateDomainVariants
  const hasStateDrivenClause = clauses.some(
    (c) => c.pattern === "State-driven" || c.activeStateVariant !== undefined,
  )
  const shouldCheckStateCoverage =
    input.stateDomainVariants.length > 0 &&
    (input.requireExhaustiveStateCoverage === true ||
      (input.requireExhaustiveStateCoverage !== false && hasStateDrivenClause))

  if (shouldCheckStateCoverage) {
    const clausesBySymbol = new Map<EarsEffectSymbolName, Array<EarsSemanticClause>>()
    for (const c of clauses) {
      const list = clausesBySymbol.get(c.effectSymbol) ?? []
      list.push(c)
      clausesBySymbol.set(c.effectSymbol, list)
    }

    if (clausesBySymbol.size === 0) {
      violations.push({
        ruleId: EarsConsistencyRuleId.make("EARS-03"),
        kind: EarsConsistencyViolationKind.make("ears-incomplete-state-coverage"),
        specId: input.specId,
        filePath: input.filePath,
        clauseIds: [],
        effectSymbol: EarsEffectSymbolName.make(input.specId),
        message: EarsConsistencyMessage.make(
          `[EARS-03] Spec '${input.specId}' leaves state variants uncovered: ${input.stateDomainVariants.join(", ")}.`,
        ),
        uncoveredStateVariants: [...input.stateDomainVariants],
      })
    } else {
      for (const [symbol, symbolClauses] of clausesBySymbol.entries()) {
        const symbolUsesState =
          input.requireExhaustiveStateCoverage === true ||
          symbolClauses.some(
            (c) => c.pattern === "State-driven" || c.activeStateVariant !== undefined,
          )
        if (!symbolUsesState) {
          continue
        }
        const hasUnrestrictedStateClause = symbolClauses.some(
          (c) => c.activeStateVariant === undefined && c.pattern === "Ubiquitous",
        )
        if (hasUnrestrictedStateClause) {
          continue
        }
        const coveredStates = new Set<string>()
        for (const c of symbolClauses) {
          if (c.activeStateVariant !== undefined) {
            coveredStates.add(c.activeStateVariant)
          }
        }
        const uncovered = input.stateDomainVariants.filter((s) => !coveredStates.has(s))
        if (uncovered.length > 0) {
          violations.push({
            ruleId: EarsConsistencyRuleId.make("EARS-03"),
            kind: EarsConsistencyViolationKind.make("ears-incomplete-state-coverage"),
            specId: input.specId,
            filePath: input.filePath,
            clauseIds: symbolClauses.map((c) => c.clauseId),
            effectSymbol: symbol,
            message: EarsConsistencyMessage.make(
              `[EARS-03] Incomplete state coverage for '${symbol}' in '${input.specId}': missing state variants [${uncovered.join(", ")}].`,
            ),
            uncoveredStateVariants: uncovered,
          })
        }
      }
    }
  }

  return {
    ok: EarsConsistencyFlag.make(violations.length === 0),
    specId: input.specId,
    violations,
  }
}

export const decideEarsConsistency = Effect.fn("EarsConsistency.decide")(function* (
  input: EarsConsistencyInput,
): Effect.fn.Return<EarsConsistencyReport, EarsConsistencyError, never> {
  const report = evaluateEarsConsistencyReport(input)
  if (!report.ok) {
    return yield* new EarsConsistencyError({
      specId: input.specId,
      violations: report.violations,
      message: EarsConsistencyMessage.make(
        `EARS consistency check failed for '${input.specId}' with ${report.violations.length} violation(s): ${report.violations.map((v) => v.message).join("; ")}`,
      ),
    })
  }
  return report
})

export const EarsConsistency = {
  decide: decideEarsConsistency,
  evaluateReport: evaluateEarsConsistencyReport,
} as const
