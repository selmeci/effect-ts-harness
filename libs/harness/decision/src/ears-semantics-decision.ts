import {
  EarsClauseId,
  EarsGuardPairRelation,
  EarsGuardText,
  EarsVariantTag,
} from "@harness/gates"
import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { type DeterministicFallbackReason, PriorSource } from "./hole-prior-decision.js"
import { assertDecisionLimits } from "./idiom-router.js"

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
  assertDecisionLimits(definition)
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

  let relation: EarsGuardPairRelation = EarsGuardPairRelation.make("mutually_exclusive")
  if (firstLower === secondLower) {
    relation = EarsGuardPairRelation.make("equivalent")
  } else if (secondLower.includes(firstLower) && firstLower.length > 0) {
    relation = EarsGuardPairRelation.make("first_subsumes_second")
  } else if (firstLower.includes(secondLower) && secondLower.length > 0) {
    relation = EarsGuardPairRelation.make("second_subsumes_first")
  }

  return {
    firstClauseId: input.firstClauseId,
    secondClauseId: input.secondClauseId,
    activeStateVariant: matchedState,
    activeGuardVariant: matchedGuard,
    guardPairRelation: relation,
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
      Effect.succeed(computeDeterministicEarsFallback(input, "timeout-or-unavailable")),
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
            Effect.succeed(computeDeterministicEarsFallback(input, "invalid-output")),
          )
      }),
    )
    .exhaustive()
})
