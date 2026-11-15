import {
  EarsClauseId,
  EarsGuardPairRelation,
  EarsGuardText,
  EarsVariantTag,
} from "@harness/gates"
import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match, P } from "ts-pattern"
import { type DeterministicFallbackReason, PriorSource } from "./hole-prior-decision.js"

export const EARS_GUARD_RELATION_CRITERIA: Readonly<
  Record<
    | "equivalent"
    | "first_subsumes_second"
    | "second_subsumes_first"
    | "mutually_exclusive"
    | "independent_overlapping",
    string
  >
> = {
  equivalent: "Both IF guards express the exact same logical condition.",
  first_subsumes_second: "The first IF guard is strictly broader and implies the second IF guard.",
  second_subsumes_first: "The second IF guard is strictly broader and implies the first IF guard.",
  mutually_exclusive: "Both IF guards cannot hold simultaneously.",
  independent_overlapping:
    "The two IF guards are independent conditions that can overlap simultaneously.",
}

const DEFAULT_STATE_VARIANT_CRITERIA: Readonly<Record<string, string>> = {
  Unrestricted: "Clause applies across all states in the domain.",
  Active: "Clause applies when the aggregate or workflow is in its active state.",
}

const DEFAULT_GUARD_VARIANT_CRITERIA: Readonly<Record<string, string>> = {
  None: "Clause has no IF guard condition.",
  Guarded: "Clause is restricted by an IF guard condition.",
}

export const buildEarsClauseSemanticsDecision = (
  stateVariants: ReadonlyArray<string>,
  guardVariants: ReadonlyArray<string>,
) => {
  const boundedStates = stateVariants.slice(0, 26)
  const stateCriteria: Record<string, string> = {}
  if (boundedStates.length >= 2) {
    for (const v of boundedStates) {
      stateCriteria[v] = `Clause applies while state variant is '${v}'.`
    }
  } else {
    Object.assign(stateCriteria, DEFAULT_STATE_VARIANT_CRITERIA)
  }

  const boundedGuards = guardVariants.slice(0, 26)
  const guardCriteria: Record<string, string> = {}
  if (boundedGuards.length >= 2) {
    for (const g of boundedGuards) {
      guardCriteria[g] = `Clause IF guard corresponds to variant '${g}'.`
    }
  } else {
    Object.assign(guardCriteria, DEFAULT_GUARD_VARIANT_CRITERIA)
  }

  const definition = Decision.make({
    input: Schema.Struct({
      firstClauseId: Schema.String,
      secondClauseId: Schema.String,
      firstClauseText: Schema.String,
      secondClauseText: Schema.String,
      stateVariantsCsv: Schema.String,
      guardVariantsCsv: Schema.String,
    }),
    decisions: {
      activeStateVariant: Decision.classify({
        instructions:
          "Which finite state variant from the Schema.TaggedUnion state domain does the first clause apply to?",
        criteria: stateCriteria,
      }),
      activeGuardVariant: Decision.classify({
        instructions:
          "Which finite guard variant from the Schema.TaggedUnion guard domain does the first clause test?",
        criteria: guardCriteria,
      }),
      guardPairRelation: Decision.classify({
        instructions:
          "What is the logical relationship between the IF guard of the first EARS clause and the IF guard of the second EARS clause?",
        criteria: EARS_GUARD_RELATION_CRITERIA,
      }),
    },
  })
  return definition
}

export const EarsClauseSemanticsV1 = buildEarsClauseSemanticsDecision(
  ["Unrestricted", "Active"],
  ["None", "Guarded"],
)

export const EarsClauseSemanticsInput = Schema.Struct({
  firstClauseId: EarsClauseId,
  secondClauseId: EarsClauseId,
  firstClauseText: EarsGuardText,
  secondClauseText: EarsGuardText,
  stateVariants: Schema.Array(EarsVariantTag),
  guardVariants: Schema.Array(EarsVariantTag),
})
export type EarsClauseSemanticsInput = typeof EarsClauseSemanticsInput.Type

export const EarsClauseSemanticsResult = Schema.Struct({
  firstClauseId: EarsClauseId,
  secondClauseId: EarsClauseId,
  activeStateVariant: EarsVariantTag,
  activeGuardVariant: EarsVariantTag,
  guardPairRelation: EarsGuardPairRelation,
  source: PriorSource,
})
export type EarsClauseSemanticsResult = typeof EarsClauseSemanticsResult.Type

const parseGuardPairRelation = (raw: unknown): Option.Option<EarsGuardPairRelation> =>
  match(raw)
    .with("equivalent", () => Option.some(EarsGuardPairRelation.make("equivalent")))
    .with("first_subsumes_second", () =>
      Option.some(EarsGuardPairRelation.make("first_subsumes_second")),
    )
    .with("second_subsumes_first", () =>
      Option.some(EarsGuardPairRelation.make("second_subsumes_first")),
    )
    .with("mutually_exclusive", () =>
      Option.some(EarsGuardPairRelation.make("mutually_exclusive")),
    )
    .with("independent_overlapping", () =>
      Option.some(EarsGuardPairRelation.make("independent_overlapping")),
    )
    .otherwise(() => Option.none())

const isNegatedGuardPair = (a: string, b: string): boolean => {
  const normA = a.replace(/^(while\s+\w+\s+)?if\s+/i, "").trim()
  const normB = b.replace(/^(while\s+\w+\s+)?if\s+/i, "").trim()

  if (
    normB === `not ${normA}` ||
    normA === `not ${normB}` ||
    normB === `!${normA}` ||
    normA === `!${normB}` ||
    normB === `! ${normA}` ||
    normA === `! ${normB}` ||
    normB === `non-${normA}` ||
    normA === `non-${normB}` ||
    normB === `no ${normA}` ||
    normA === `no ${normB}`
  ) {
    return true
  }

  if (
    normB.includes(`not ${normA}`) ||
    normA.includes(`not ${normB}`) ||
    normB.includes(`!${normA}`) ||
    normA.includes(`!${normB}`)
  ) {
    return true
  }

  const strippedA = normA.replace(/\bnot\s+/g, "").replace(/!\s*/g, "").trim()
  const strippedB = normB.replace(/\bnot\s+/g, "").replace(/!\s*/g, "").trim()
  const hasNegationA = /\b(not|never|no|false)\b/i.test(normA) || normA.includes("!")
  const hasNegationB = /\b(not|never|no|false)\b/i.test(normB) || normB.includes("!")

  if (strippedA === strippedB && hasNegationA !== hasNegationB) {
    return true
  }

  if (
    (normA.includes("valid") && (normB.includes("invalid") || normB.includes("not valid"))) ||
    (normB.includes("valid") && (normA.includes("invalid") || normA.includes("not valid"))) ||
    (normA.includes("empty") && (normB.includes("non-empty") || normB.includes("not empty"))) ||
    (normB.includes("empty") && (normA.includes("non-empty") || normA.includes("not empty")))
  ) {
    return true
  }

  return false
}

export const computeGuardRelationFallback = (
  firstLower: string,
  secondLower: string,
): EarsGuardPairRelation =>
  match([firstLower, secondLower] as const)
    .with(
      P.when(([a, b]) => a === b && a.length > 0),
      () => EarsGuardPairRelation.make("equivalent"),
    )
    .with(
      P.when(([a, b]) => isNegatedGuardPair(a, b)),
      () => EarsGuardPairRelation.make("mutually_exclusive"),
    )
    .with(
      P.when(([a, b]) => b.includes(a) && a.length > 0),
      () => EarsGuardPairRelation.make("first_subsumes_second"),
    )
    .with(
      P.when(([a, b]) => a.includes(b) && b.length > 0),
      () => EarsGuardPairRelation.make("second_subsumes_first"),
    )
    .otherwise(() => EarsGuardPairRelation.make("independent_overlapping"))

const computeDeterministicEarsFallback = (
  input: EarsClauseSemanticsInput,
  reason: DeterministicFallbackReason = "timeout-or-unavailable",
): EarsClauseSemanticsResult => {
  const firstLower = input.firstClauseText.toLowerCase().trim()
  const secondLower = input.secondClauseText.toLowerCase().trim()

  const matchedState =
    input.stateVariants.find((v) => firstLower.includes(v.toLowerCase())) ??
    input.stateVariants[0] ??
    EarsVariantTag.make("Unrestricted")

  const matchedGuard =
    input.guardVariants.find((g) => firstLower.includes(g.toLowerCase())) ??
    input.guardVariants[0] ??
    EarsVariantTag.make("None")

  const guardPairRelation = computeGuardRelationFallback(firstLower, secondLower)

  return {
    firstClauseId: input.firstClauseId,
    secondClauseId: input.secondClauseId,
    activeStateVariant: matchedState,
    activeGuardVariant: matchedGuard,
    guardPairRelation,
    source: { _tag: "DeterministicFallback", reason },
  }
}

export const evaluateEarsClauseSemantics = Effect.fn("EarsClauseSemantics.evaluate")(function* (
  input: EarsClauseSemanticsInput,
): Effect.fn.Return<EarsClauseSemanticsResult, never, DecisionModel.DecisionModel> {
  const decisionDef = buildEarsClauseSemanticsDecision(input.stateVariants, input.guardVariants)
  const outcome = yield* DecisionModel.decide(decisionDef, {
    input: {
      firstClauseId: input.firstClauseId,
      secondClauseId: input.secondClauseId,
      firstClauseText: input.firstClauseText,
      secondClauseText: input.secondClauseText,
      stateVariantsCsv: input.stateVariants.join(","),
      guardVariantsCsv: input.guardVariants.join(","),
    },
  }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catch((error) =>
      Effect.annotateCurrentSpan({
        "decision.fallback_error": String(error),
      }).pipe(Effect.as(Option.none())),
    ),
  )

  return yield* match(outcome)
    .with({ _tag: "None" }, () =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ "decision.usedFallback": true })
        yield* Effect.logWarning(
          `DecisionModel offline or timed out; using deterministic fallback for EARS clauses '${input.firstClauseId}' and '${input.secondClauseId}'`,
        )
        return computeDeterministicEarsFallback(input, "timeout-or-unavailable")
      }),
    )
    .with({ _tag: "Some" }, ({ value }) =>
      Effect.gen(function* () {
        const rawState = value.answers.activeStateVariant?.label
        const rawGuard = value.answers.activeGuardVariant?.label
        const parsedRel = parseGuardPairRelation(value.answers.guardPairRelation?.label)

        const stateValid =
          typeof rawState === "string" &&
          rawState.length > 0 &&
          (input.stateVariants.length < 2 ||
            input.stateVariants.some((v) => (v as string) === rawState))
        const guardValid =
          typeof rawGuard === "string" &&
          rawGuard.length > 0 &&
          (input.guardVariants.length < 2 ||
            input.guardVariants.some((g) => (g as string) === rawGuard))

        return yield* match([stateValid, guardValid, parsedRel] as const)
          .with([true, true, { _tag: "Some" }], ([, , { value: guardPairRelation }]) =>
            Effect.gen(function* () {
              const activeStateVariant = EarsVariantTag.make(rawState ?? "Unrestricted")
              const activeGuardVariant = EarsVariantTag.make(rawGuard ?? "None")
              yield* Effect.annotateCurrentSpan({
                "decision.definition": "EarsClauseSemanticsV1",
                "decision.firstClauseId": input.firstClauseId,
                "decision.secondClauseId": input.secondClauseId,
                "decision.activeStateVariant": activeStateVariant,
                "decision.activeGuardVariant": activeGuardVariant,
                "decision.guardPairRelation": guardPairRelation,
                "decision.usedFallback": false,
              })
              return {
                firstClauseId: input.firstClauseId,
                secondClauseId: input.secondClauseId,
                activeStateVariant,
                activeGuardVariant,
                guardPairRelation,
                source: { _tag: "DecisionModel" },
              } satisfies EarsClauseSemanticsResult
            }),
          )
          .otherwise(() =>
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({ "decision.usedFallback": true })
              yield* Effect.logWarning(
                `DecisionModel produced invalid output; using deterministic fallback for EARS clauses '${input.firstClauseId}' and '${input.secondClauseId}'`,
              )
              return computeDeterministicEarsFallback(input, "invalid-output")
            }),
          )
      }),
    )
    .exhaustive()
})
