import {
  DST_HAZARD_RISK_LEVELS,
  DstHazardRiskLevel,
  DstMethodName,
  DstProbabilityMillis,
  DstServiceTag,
} from "@harness/gates"
import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { type DeterministicFallbackReason, PriorSource } from "./hole-prior-decision.js"
import { assertDecisionLimits } from "./idiom-router.js"

export const getHazardProbabilityMillis = (
  riskLevel: DstHazardRiskLevel,
): DstProbabilityMillis =>
  match(riskLevel as "pure_lookup" | "idempotent_io" | "stateful_mutation" | "distributed_saga_step")
    .with("pure_lookup", () => DstProbabilityMillis.make(100))
    .with("idempotent_io", () => DstProbabilityMillis.make(300))
    .with("stateful_mutation", () => DstProbabilityMillis.make(650))
    .with("distributed_saga_step", () => DstProbabilityMillis.make(900))
    .exhaustive()

export const DstHazardPriorV1 = Decision.make({
  input: Schema.Struct({
    serviceTag: Schema.String,
    methodName: Schema.String,
    signatureSummary: Schema.String,
    earsClauseContext: Schema.String,
  }),
  decisions: {
    concurrencyRisk: Decision.rate({
      instructions:
        "Rate the concurrency, partial-failure, and state-corruption hazard of this service method under fault injection.",
      criteria: DST_HAZARD_RISK_LEVELS,
    }),
  },
})

assertDecisionLimits(DstHazardPriorV1)

export const DstHazardPriorInput = Schema.Struct({
  serviceTag: DstServiceTag,
  methodName: DstMethodName,
  signatureSummary: Schema.String,
  earsClauseContext: Schema.String,
})
export type DstHazardPriorInput = typeof DstHazardPriorInput.Type

export const DstHazardPriorResult = Schema.Struct({
  serviceTag: DstServiceTag,
  methodName: DstMethodName,
  riskLevel: DstHazardRiskLevel,
  hazardProbMillis: DstProbabilityMillis,
  source: PriorSource,
})
export type DstHazardPriorResult = typeof DstHazardPriorResult.Type

const parseHazardRiskLevel = (raw: unknown): Option.Option<DstHazardRiskLevel> =>
  match(raw)
    .with("pure_lookup", () => Option.some(DstHazardRiskLevel.make("pure_lookup")))
    .with("idempotent_io", () => Option.some(DstHazardRiskLevel.make("idempotent_io")))
    .with("stateful_mutation", () => Option.some(DstHazardRiskLevel.make("stateful_mutation")))
    .with("distributed_saga_step", () =>
      Option.some(DstHazardRiskLevel.make("distributed_saga_step")),
    )
    .otherwise(() => Option.none())

const computeDeterministicHazardFallback = (
  input: DstHazardPriorInput,
  reason: DeterministicFallbackReason = "timeout-or-unavailable",
): DstHazardPriorResult => {
  const combined =
    `${input.serviceTag} ${input.methodName} ${input.signatureSummary} ${input.earsClauseContext}`.toLowerCase()
  let riskLevel: DstHazardRiskLevel = DstHazardRiskLevel.make("pure_lookup")
  if (combined.includes("saga") || combined.includes("compensat") || combined.includes("outbox")) {
    riskLevel = DstHazardRiskLevel.make("distributed_saga_step")
  } else if (
    combined.includes("insert") ||
    combined.includes("update") ||
    combined.includes("delete") ||
    combined.includes("write") ||
    combined.includes("mutate") ||
    combined.includes("save") ||
    combined.includes("append")
  ) {
    riskLevel = DstHazardRiskLevel.make("stateful_mutation")
  } else if (
    combined.includes("fetch") ||
    combined.includes("http") ||
    combined.includes("query") ||
    combined.includes("read")
  ) {
    riskLevel = DstHazardRiskLevel.make("idempotent_io")
  }

  return {
    serviceTag: input.serviceTag,
    methodName: input.methodName,
    riskLevel,
    hazardProbMillis: getHazardProbabilityMillis(riskLevel),
    source: { _tag: "DeterministicFallback", reason },
  }
}

export const evaluateDstHazardPrior = Effect.fn("DstHazardPrior.evaluate")(function* (
  input: DstHazardPriorInput,
): Effect.fn.Return<DstHazardPriorResult, never, DecisionModel.DecisionModel> {
  const outcome = yield* DecisionModel.decide(DstHazardPriorV1, { input }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catch((error) =>
      Effect.annotateCurrentSpan({
        "decision.fallback_error": String(error),
      }).pipe(Effect.as(Option.none())),
    ),
  )

  return yield* match(outcome)
    .with({ _tag: "None" }, () =>
      Effect.succeed(computeDeterministicHazardFallback(input, "timeout-or-unavailable")),
    )
    .with({ _tag: "Some" }, ({ value }) =>
      Effect.gen(function* () {
        const parsedRisk = parseHazardRiskLevel(value.answers.concurrencyRisk?.label)
        return yield* match(parsedRisk)
          .with({ _tag: "Some" }, ({ value: riskLevel }) =>
            Effect.gen(function* () {
              const hazardProbMillis = getHazardProbabilityMillis(riskLevel)
              yield* Effect.annotateCurrentSpan({
                "decision.definition": "DstHazardPriorV1",
                "decision.serviceTag": input.serviceTag,
                "decision.methodName": input.methodName,
                "decision.riskLevel": riskLevel,
                "decision.hazardProbMillis": hazardProbMillis,
              })
              return {
                serviceTag: input.serviceTag,
                methodName: input.methodName,
                riskLevel,
                hazardProbMillis,
                source: { _tag: "DecisionModel" },
              } satisfies DstHazardPriorResult
            }),
          )
          .with({ _tag: "None" }, () =>
            Effect.succeed(computeDeterministicHazardFallback(input, "invalid-output")),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})
