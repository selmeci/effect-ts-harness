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
import { match, P } from "ts-pattern"
import { type DeterministicFallbackReason, PriorSource } from "./hole-prior-decision.js"

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

const LOOKUP_METHOD_PREFIX_REGEX = /^(get|find|list|read|query|is|has|compute|decide)/i

const isSaga = (combined: string): boolean =>
  combined.includes("saga") || combined.includes("compensat") || combined.includes("outbox")

const isMutation = (combined: string): boolean =>
  combined.includes("insert") ||
  combined.includes("update") ||
  combined.includes("delete") ||
  combined.includes("write") ||
  combined.includes("mutate") ||
  combined.includes("save") ||
  combined.includes("append")

const isIdempotentIo = (combined: string): boolean =>
  combined.includes("fetch") ||
  combined.includes("http") ||
  combined.includes("query") ||
  combined.includes("read")

const isPureLookup = (methodName: string): boolean =>
  LOOKUP_METHOD_PREFIX_REGEX.test(methodName)

const computeDeterministicHazardFallback = (
  input: DstHazardPriorInput,
  reason: DeterministicFallbackReason = "timeout-or-unavailable",
): DstHazardPriorResult => {
  const combined =
    `${input.serviceTag} ${input.methodName} ${input.signatureSummary} ${input.earsClauseContext}`.toLowerCase()

  const riskLevel: DstHazardRiskLevel = match({ combined, methodName: input.methodName })
    .with(
      P.when(({ combined }) => isSaga(combined)),
      () => DstHazardRiskLevel.make("distributed_saga_step"),
    )
    .with(
      P.when(({ combined }) => isMutation(combined)),
      () => DstHazardRiskLevel.make("stateful_mutation"),
    )
    .with(
      P.when(({ combined }) => isIdempotentIo(combined)),
      () => DstHazardRiskLevel.make("idempotent_io"),
    )
    .with(
      P.when(({ methodName }) => isPureLookup(methodName)),
      () => DstHazardRiskLevel.make("pure_lookup"),
    )
    .otherwise(() => DstHazardRiskLevel.make("stateful_mutation"))

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
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ "decision.usedFallback": true })
        return computeDeterministicHazardFallback(input, "timeout-or-unavailable")
      }),
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
                "decision.usedFallback": false,
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
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({ "decision.usedFallback": true })
              return computeDeterministicHazardFallback(input, "invalid-output")
            }),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})
