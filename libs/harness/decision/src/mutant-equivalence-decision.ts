import { ConfidenceMillis } from "@harness/gates"
import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { type DeterministicFallbackReason, PriorSource } from "./hole-prior-decision.js"
import { assertDecisionLimits } from "./idiom-router.js"

export const EQUIVALENT_MUTANT_THRESHOLD_MILLIS = 850

export const MutantEquivalenceV1 = Decision.make({
  input: Schema.Struct({
    mutantId: Schema.String,
    filePath: Schema.String,
    spanName: Schema.String,
    originalSnippet: Schema.String,
    mutatedSnippet: Schema.String,
    enclosingFunctionAstSummary: Schema.String,
  }),
  decisions: {
    isEquivalent: Decision.probability({
      instructions:
        "Is this mutated code snippet semantically equivalent to the original snippet or strictly unreachable due to TypeScript types and Effect invariants?",
    }),
  },
})

assertDecisionLimits(MutantEquivalenceV1)

export const MutantEquivalenceInput = Schema.Struct({
  mutantId: Schema.NonEmptyString,
  filePath: Schema.NonEmptyString,
  spanName: Schema.NonEmptyString,
  originalSnippet: Schema.String,
  mutatedSnippet: Schema.String,
  enclosingFunctionAstSummary: Schema.String,
})
export type MutantEquivalenceInput = typeof MutantEquivalenceInput.Type

export const MutantEquivalenceResult = Schema.Struct({
  mutantId: Schema.NonEmptyString,
  equivalenceProbMillis: ConfidenceMillis,
  isEquivalent: Schema.Boolean,
  source: PriorSource,
})
export type MutantEquivalenceResult = typeof MutantEquivalenceResult.Type

const computeDeterministicMutantFallback = (
  input: MutantEquivalenceInput,
  reason: DeterministicFallbackReason = "timeout-or-unavailable",
): MutantEquivalenceResult => {
  const isIdentical = input.originalSnippet.trim() === input.mutatedSnippet.trim()
  const probMillis = ConfidenceMillis.make(isIdentical ? 1000 : 0)
  return {
    mutantId: input.mutantId,
    equivalenceProbMillis: probMillis,
    isEquivalent: probMillis >= EQUIVALENT_MUTANT_THRESHOLD_MILLIS,
    source: { _tag: "DeterministicFallback", reason },
  }
}

export const evaluateMutantEquivalence = Effect.fn("MutantEquivalence.evaluate")(function* (
  input: MutantEquivalenceInput,
): Effect.fn.Return<MutantEquivalenceResult, never, DecisionModel.DecisionModel> {
  const outcome = yield* DecisionModel.decide(MutantEquivalenceV1, { input }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catch((error) =>
      Effect.annotateCurrentSpan({
        "decision.fallback_error": String(error),
      }).pipe(Effect.as(Option.none())),
    ),
  )

  return yield* match(outcome)
    .with({ _tag: "None" }, () =>
      Effect.succeed(computeDeterministicMutantFallback(input, "timeout-or-unavailable")),
    )
    .with({ _tag: "Some" }, ({ value }) =>
      Effect.gen(function* () {
        const rawProb = value.answers.isEquivalent?.probability
        if (typeof rawProb !== "number" || Number.isNaN(rawProb)) {
          return computeDeterministicMutantFallback(input, "invalid-output")
        }
        const clampedMillis = Math.min(1000, Math.max(0, Math.round(rawProb * 1000)))
        const equivalenceProbMillis = ConfidenceMillis.make(clampedMillis)
        const isEquivalent = equivalenceProbMillis >= EQUIVALENT_MUTANT_THRESHOLD_MILLIS
        yield* Effect.annotateCurrentSpan({
          "decision.definition": "MutantEquivalenceV1",
          "decision.mutantId": input.mutantId,
          "decision.equivalenceProbMillis": equivalenceProbMillis,
          "decision.isEquivalent": isEquivalent,
        })
        return {
          mutantId: input.mutantId,
          equivalenceProbMillis,
          isEquivalent,
          source: { _tag: "DecisionModel" },
        } satisfies MutantEquivalenceResult
      }),
    )
    .exhaustive()
})
