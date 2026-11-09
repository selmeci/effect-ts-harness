import {
  DpoPriorKey,
  NodeKey,
  RewriteRuleId,
  SystemOneScoreMillis,
  formatDpoPriorKey,
  isBoundaryCallerQualname,
} from "@harness/gates"
import { Effect, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { MAX_BATCHED_HOLE_CANDIDATES, PriorSource } from "./hole-prior-decision.js"
import { assertDecisionLimits } from "./idiom-router.js"

export { DpoPriorKey, RewriteRuleId, SystemOneScoreMillis, formatDpoPriorKey }

export const DPO_REPAIR_STRATEGIES = [
  "propagate_in_E",
  "catch_and_translate_at_boundary",
  "extract_service_port",
  "split_pure_decider",
  "wire_transactional_outbox",
  "convert_to_defect",
] as const
export type DpoRepairStrategy = (typeof DPO_REPAIR_STRATEGIES)[number]

export const DPO_COHESION_LEVELS = [
  "poor",
  "acceptable",
  "good",
  "idiomatic",
] as const
export type DpoCohesionLevel = (typeof DPO_COHESION_LEVELS)[number]

export const COHESION_SCORE_MILLIS: Readonly<Record<DpoCohesionLevel, SystemOneScoreMillis>> = {
  poor: SystemOneScoreMillis.make(200),
  acceptable: SystemOneScoreMillis.make(500),
  good: SystemOneScoreMillis.make(800),
  idiomatic: SystemOneScoreMillis.make(950),
}

const REPAIR_STRATEGY_CRITERIA = {
  propagate_in_E:
    "Propagate the TaggedError in the caller's E channel (REP-04a) when the caller is a domain use-case or decider and the error is declared in EARS.",
  catch_and_translate_at_boundary:
    "Catch and handle or translate the error via Effect.catchTag at an HTTP, RPC, or worker boundary (REP-04b).",
  extract_service_port:
    "Extract a Context.Service port in type:service and wire a live ServiceLayer in type:infra (REP-01).",
  split_pure_decider:
    "Keep .decide / .evolve pure (R = never) and move stateful service dependencies to a use-case orchestrator (REP-02).",
  wire_transactional_outbox:
    "Replace direct EventBus publish in an aggregate handler with OutboxStore + OutboxRelay (REP-03).",
  convert_to_defect:
    "Treat unrecoverable invariant violations as defects rather than domain E-channel errors.",
} as const

/**
 * System One calibrated sensor for semantic tie-breaking among mu-equivalent Double-Pushout (DPO)
 * repair candidates (`RFC-0003 §4.3`).
 */
export const DpoCandidateRankerV1 = Decision.make({
  input: Schema.Struct({
    primaryNodeKey: Schema.String,
    ruleId: Schema.String,
    violationKind: Schema.String,
    callerSummary: Schema.String,
    candidatePatchSummary: Schema.String,
    earsClauseContext: Schema.String,
  }),
  decisions: {
    repairStrategy: Decision.classify({
      instructions:
        "Which Effect architectural repair strategy best resolves this violation for the caller and EARS requirement?",
      criteria: REPAIR_STRATEGY_CRITERIA,
    }),
    architecturalCohesion: Decision.rate({
      instructions:
        "How idiomatic and cohesive is the resulting hypergraph patch with Effect-TS v4 architecture rules?",
      criteria: DPO_COHESION_LEVELS,
    }),
  },
})

assertDecisionLimits(DpoCandidateRankerV1)

export const MAX_BATCHED_DPO_CANDIDATES = MAX_BATCHED_HOLE_CANDIDATES

export const buildBatchedDpoRankerDecision = (candidateCount: number) => {
  const boundedCount = Math.min(MAX_BATCHED_DPO_CANDIDATES, Math.max(1, candidateCount))
  const decisions: Record<
    string,
    | (typeof DpoCandidateRankerV1.decisions)["repairStrategy"]
    | (typeof DpoCandidateRankerV1.decisions)["architecturalCohesion"]
  > = {}
  for (let i = 0; i < boundedCount; i++) {
    decisions[`repairStrategy_${i}`] = Decision.classify({
      instructions: `Which Effect architectural repair strategy best resolves candidate #${i}?`,
      criteria: REPAIR_STRATEGY_CRITERIA,
    })
    decisions[`architecturalCohesion_${i}`] = Decision.rate({
      instructions: `How idiomatic and cohesive is candidate #${i} with Effect-TS v4 architecture rules?`,
      criteria: DPO_COHESION_LEVELS,
    })
  }
  const definition = Decision.make({
    input: Schema.Struct({
      candidatesBatchJson: Schema.String,
    }),
    decisions,
  })
  assertDecisionLimits(definition)
  return definition
}

export const DpoCandidateRankInput = Schema.Struct({
  primaryNodeKey: NodeKey,
  ruleId: RewriteRuleId,
  violationKind: Schema.NonEmptyString,
  callerSummary: Schema.String,
  candidatePatchSummary: Schema.String,
  earsClauseContext: Schema.String,
})
export type DpoCandidateRankInput = typeof DpoCandidateRankInput.Type

export const DpoCandidateRankResult = Schema.Struct({
  primaryNodeKey: NodeKey,
  ruleId: RewriteRuleId,
  priorKey: DpoPriorKey,
  scoreMillis: SystemOneScoreMillis,
  strategyLabel: Schema.Literals(DPO_REPAIR_STRATEGIES),
  cohesionLabel: Schema.Literals(DPO_COHESION_LEVELS),
  source: PriorSource,
})
export type DpoCandidateRankResult = typeof DpoCandidateRankResult.Type

export const DpoCandidateBatchResult = Schema.Struct({
  candidatePriors: Schema.Record(Schema.String, SystemOneScoreMillis),
  results: Schema.Array(DpoCandidateRankResult),
  source: PriorSource,
})
export type DpoCandidateBatchResult = typeof DpoCandidateBatchResult.Type

const normalizeStrategyLabel = (raw: string): DpoRepairStrategy =>
  match(raw)
    .with("propagate_in_E", () => "propagate_in_E" as const)
    .with("catch_and_translate_at_boundary", () => "catch_and_translate_at_boundary" as const)
    .with("extract_service_port", () => "extract_service_port" as const)
    .with("split_pure_decider", () => "split_pure_decider" as const)
    .with("wire_transactional_outbox", () => "wire_transactional_outbox" as const)
    .with("convert_to_defect", () => "convert_to_defect" as const)
    .otherwise(() => "propagate_in_E" as const)

const normalizeCohesionLabel = (raw: string): DpoCohesionLevel =>
  match(raw)
    .with("poor", () => "poor" as const)
    .with("acceptable", () => "acceptable" as const)
    .with("good", () => "good" as const)
    .with("idiomatic", () => "idiomatic" as const)
    .otherwise(() => "acceptable" as const)

const doesRuleAlignWithStrategy = (
  ruleId: string,
  strategy: DpoRepairStrategy,
): boolean =>
  match(ruleId)
    .with("REP-04a", () => strategy === "propagate_in_E")
    .with("REP-04b", () => strategy === "catch_and_translate_at_boundary")
    .with("REP-01", () => strategy === "extract_service_port")
    .with("REP-02", () => strategy === "split_pure_decider")
    .with("REP-03", () => strategy === "wire_transactional_outbox")
    .otherwise(() => true)

const computeCandidateScoreMillis = (
  ruleId: string,
  strategyLabel: DpoRepairStrategy,
  cohesionLabel: DpoCohesionLevel,
): SystemOneScoreMillis => {
  const baseCohesion = COHESION_SCORE_MILLIS[cohesionLabel]
  const aligned = doesRuleAlignWithStrategy(ruleId, strategyLabel)
  const rawScore = aligned ? Math.min(1000, baseCohesion + 50) : Math.max(50, baseCohesion - 250)
  return SystemOneScoreMillis.make(rawScore)
}

const computeDeterministicFallbackRank = (
  input: DpoCandidateRankInput,
): DpoCandidateRankResult => {
  const isBoundaryCaller = isBoundaryCallerQualname(input.callerSummary)
  const fallbackStrategy: DpoRepairStrategy = match(input.ruleId as string)
    .with("REP-04b", () =>
      isBoundaryCaller ? ("catch_and_translate_at_boundary" as const) : ("propagate_in_E" as const),
    )
    .with("REP-04a", () =>
      isBoundaryCaller ? ("catch_and_translate_at_boundary" as const) : ("propagate_in_E" as const),
    )
    .with("REP-01", () => "extract_service_port" as const)
    .with("REP-02", () => "split_pure_decider" as const)
    .with("REP-03", () => "wire_transactional_outbox" as const)
    .otherwise(() => "propagate_in_E" as const)

  const aligned = doesRuleAlignWithStrategy(input.ruleId, fallbackStrategy)
  const fallbackScore = SystemOneScoreMillis.make(aligned ? 750 : 450)
  return {
    primaryNodeKey: input.primaryNodeKey,
    ruleId: input.ruleId,
    priorKey: formatDpoPriorKey(input.primaryNodeKey, input.ruleId),
    scoreMillis: fallbackScore,
    strategyLabel: fallbackStrategy,
    cohesionLabel: "acceptable",
    source: { _tag: "DeterministicFallback", reason: "timeout-or-unavailable" },
  }
}

export const evaluateDpoCandidateRank = Effect.fn("DpoCandidateRanker.evaluate")(function* (
  input: DpoCandidateRankInput,
): Effect.fn.Return<DpoCandidateRankResult, never, DecisionModel.DecisionModel> {
  const outcome = yield* DecisionModel.decide(DpoCandidateRankerV1, { input }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catch(() => Effect.succeedNone),
  )

  return yield* match(outcome)
    .with({ _tag: "None" }, () => Effect.succeed(computeDeterministicFallbackRank(input)))
    .with({ _tag: "Some" }, ({ value }) =>
      Effect.gen(function* () {
        const strategyLabel = normalizeStrategyLabel(value.answers.repairStrategy.label as string)
        const cohesionLabel = normalizeCohesionLabel(
          value.answers.architecturalCohesion.label as string,
        )
        const scoreMillis = computeCandidateScoreMillis(
          input.ruleId,
          strategyLabel,
          cohesionLabel,
        )
        const priorKey = formatDpoPriorKey(input.primaryNodeKey, input.ruleId)

        yield* Effect.annotateCurrentSpan({
          "decision.definition": "DpoCandidateRankerV1",
          "decision.priorKey": priorKey,
          "decision.strategyLabel": strategyLabel,
          "decision.cohesionLabel": cohesionLabel,
          "decision.scoreMillis": scoreMillis,
        })

        return {
          primaryNodeKey: input.primaryNodeKey,
          ruleId: input.ruleId,
          priorKey,
          scoreMillis,
          strategyLabel,
          cohesionLabel,
          source: { _tag: "DecisionModel" },
        } satisfies DpoCandidateRankResult
      }),
    )
    .exhaustive()
})

export const evaluateDpoCandidatePriorsBatch = Effect.fn("DpoCandidateRanker.evaluateBatch")(
  function* (
    inputs: ReadonlyArray<DpoCandidateRankInput>,
  ): Effect.fn.Return<DpoCandidateBatchResult, never, DecisionModel.DecisionModel> {
    if (inputs.length === 0) {
      return {
        candidatePriors: {},
        results: [],
        source: { _tag: "DecisionModel" },
      } satisfies DpoCandidateBatchResult
    }

    const candidatePriors: Record<string, SystemOneScoreMillis> = {}
    const results: Array<DpoCandidateRankResult> = []
    let usedFallback = false

    for (let offset = 0; offset < inputs.length; offset += MAX_BATCHED_DPO_CANDIDATES) {
      const chunk = inputs.slice(offset, offset + MAX_BATCHED_DPO_CANDIDATES)
      const batchedDef = buildBatchedDpoRankerDecision(chunk.length)
      const candidatesBatchJson = JSON.stringify(
        chunk.map((item, idx) => ({
          index: idx,
          primaryNodeKey: item.primaryNodeKey,
          ruleId: item.ruleId,
          violationKind: item.violationKind,
          callerSummary: item.callerSummary,
          candidatePatchSummary: item.candidatePatchSummary,
          earsClauseContext: item.earsClauseContext,
        })),
      )

      const outcome = yield* DecisionModel.decide(batchedDef, {
        input: { candidatesBatchJson },
      }).pipe(
        Effect.timeoutOption("1500 millis"),
        Effect.catch(() => Effect.succeedNone),
      )

      yield* match(outcome)
        .with({ _tag: "None" }, () =>
          Effect.sync(() => {
            usedFallback = true
            for (const item of chunk) {
              const fb = computeDeterministicFallbackRank(item)
              if (candidatePriors[fb.priorKey] === undefined) {
                candidatePriors[fb.priorKey] = fb.scoreMillis
              }
              results.push(fb)
            }
          }),
        )
        .with({ _tag: "Some" }, ({ value }) =>
          Effect.sync(() => {
            const answersRecord = value.answers as Record<
              string,
              { readonly label?: string } | undefined
            >
            for (let i = 0; i < chunk.length; i++) {
              const item = chunk[i]!
              const stratAns = answersRecord[`repairStrategy_${i}`]
              const cohAns = answersRecord[`architecturalCohesion_${i}`]
              const strategyLabel = normalizeStrategyLabel(
                typeof stratAns?.label === "string" ? stratAns.label : "propagate_in_E",
              )
              const cohesionLabel = normalizeCohesionLabel(
                typeof cohAns?.label === "string" ? cohAns.label : "acceptable",
              )
              const scoreMillis = computeCandidateScoreMillis(
                item.ruleId,
                strategyLabel,
                cohesionLabel,
              )
              const priorKey = formatDpoPriorKey(item.primaryNodeKey, item.ruleId)
              const existingScore = candidatePriors[priorKey]
              candidatePriors[priorKey] =
                existingScore !== undefined && existingScore > scoreMillis
                  ? existingScore
                  : scoreMillis
              results.push({
                primaryNodeKey: item.primaryNodeKey,
                ruleId: item.ruleId,
                priorKey,
                scoreMillis,
                strategyLabel,
                cohesionLabel,
                source: { _tag: "DecisionModel" },
              })
            }
          }),
        )
        .exhaustive()
    }

    yield* Effect.annotateCurrentSpan({
      "decision.definition": "DpoCandidateRankerV1.batch",
      "decision.batchSize": inputs.length,
      "decision.usedFallback": usedFallback,
    })

    return {
      candidatePriors,
      results,
      source: usedFallback
        ? { _tag: "DeterministicFallback", reason: "timeout-or-unavailable" }
        : { _tag: "DecisionModel" },
    }
  },
)
