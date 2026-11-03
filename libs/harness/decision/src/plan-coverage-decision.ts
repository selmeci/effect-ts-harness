import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"

export const PlanStepCoverageV1 = Decision.make({
  input: Schema.Struct({
    stepId: Schema.String,
    planStep: Schema.String,
    stepDiff: Schema.String,
  }),
  decisions: {
    implemented: Decision.probability({
      instructions: "Is this plan step implemented in the diff?",
    }),
    noOutOfScopeEdits: Decision.probability({
      instructions: "Are all edits in this diff strictly within the scope of this step?",
    }),
  },
})

export interface PlanStepCoverageInput {
  readonly stepId: string
  readonly planStep: string
  readonly stepDiff: string
}

export interface PlanStepCoverageResult {
  readonly covered: boolean
  readonly reason: string
}

export const checkPlanStepCoverage = Effect.fn("Harness.checkPlanStepCoverage")(function* (
  input: PlanStepCoverageInput,
) {
  const outcome = yield* DecisionModel.decide(PlanStepCoverageV1, { input }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catchCause(() => Effect.succeedNone),
  )

  if (Option.isNone(outcome)) {
    return {
      covered: false,
      reason: `Plan step ${input.stepId} coverage check failed: DecisionModel unavailable or timed out.`,
    }
  }

  const { answers } = outcome.value
  yield* Effect.annotateCurrentSpan({
    "decision.definition": "PlanStepCoverageV1",
    "decision.implemented": answers.implemented.probability,
    "decision.noOutOfScopeEdits": answers.noOutOfScopeEdits.probability,
  })

  if (answers.implemented.probability >= 0.7 && answers.noOutOfScopeEdits.probability >= 0.7) {
    return {
      covered: true,
      reason: `Plan step ${input.stepId} covered.`,
    }
  }

  return {
    covered: false,
    reason: `Plan step ${input.stepId} failed coverage check (implemented=${answers.implemented.probability}, noOutOfScopeEdits=${answers.noOutOfScopeEdits.probability}).`,
  }
})
