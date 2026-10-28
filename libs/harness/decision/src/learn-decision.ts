import { Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import type { FrictionEventKind } from "@harness/gates"
import { assertDecisionLimits } from "./idiom-router.js"

export const LEARN_TARGETS = [
  "agent-pattern",
  "triage-rule",
  "guard-allowlist",
  "ast-graph-gate"
] as const
export type LearnTarget = (typeof LEARN_TARGETS)[number]

export const LearnProposalV1 = Decision.make({
  input: Schema.Struct({
    kind: Schema.String,
    summary: Schema.String,
    detail: Schema.String,
    occurrences: Schema.Int
  }),
  decisions: {
    actionable: Decision.probability({
      instructions:
        "Should this recurring development friction be promoted into a reusable pattern, triage hint, guard rule, or AST/graph gate?"
    }),
    target: Decision.classify({
      instructions:
        "Which harness mechanism best prevents or resolves this friction in future tasks?",
      criteria: {
        "agent-pattern":
          "New or updated recipe in agent-patterns/*.md registered in IdiomRouterV1",
        "triage-rule":
          "Deterministic compiler/test failure pattern and hint in DETERMINISTIC_TRIAGE_RULES",
        "guard-allowlist":
          "Safe recurring CLI command prefix for ALLOWLIST in policy.ts",
        "ast-graph-gate":
          "Strict AST lint rule in tools/oxlint/syntax-bans.js or graph rule in checkEffectGraph"
      }
    })
  }
})

assertDecisionLimits(LearnProposalV1)

export interface LearnProposalInput {
  readonly kind: FrictionEventKind
  readonly summary: string
  readonly detail: string
  readonly occurrences: number
}

export interface LearnProposalResult {
  readonly target: LearnTarget
  readonly actionable: boolean
  readonly confidence: number
  readonly recommendation: string
  readonly source: "decision-model" | "deterministic-fallback"
}

export const deterministicLearnFallback = (
  input: LearnProposalInput
): LearnProposalResult => {
  if (input.kind === "route_miss") {
    return {
      target: "agent-pattern",
      actionable: true,
      confidence: 0.85,
      recommendation: `Create or expand an agent-patterns/*.md recipe for "${input.summary}" and register it in IdiomRouterV1 (11 of 26 slots available).`,
      source: "deterministic-fallback"
    }
  }

  if (input.kind === "verify_failure") {
    const isAstGraphGate =
      input.detail.includes("domain-requires-") ||
      input.detail.includes("impure-decider") ||
      input.detail.includes("layer-cycle") ||
      input.detail.includes("discriminant-branching") ||
      input.detail.includes("non-exhaustive-union-match") ||
      input.detail.includes("harness/syntax-bans")
    const target: LearnTarget = isAstGraphGate ? "ast-graph-gate" : "triage-rule"
    const recommendation = isAstGraphGate
      ? `Strengthen AST/graph gate in tools/oxlint/syntax-bans.js or checkEffectGraph for recurring violation: ${input.summary}`
      : `Add deterministic pattern and hint to DETERMINISTIC_TRIAGE_RULES in libs/harness/decision/src/triage-decision.ts for: ${input.summary}`
    return {
      target,
      actionable: true,
      confidence: 0.85,
      recommendation,
      source: "deterministic-fallback"
    }
  }

  return {
    target: "guard-allowlist",
    actionable: input.occurrences >= 2,
    confidence: 0.8,
    recommendation: `Review command "${input.summary}" — if safe and recurring, add its prefix to ALLOWLIST in libs/harness/gates/src/policy.ts.`,
    source: "deterministic-fallback"
  }
}

export const proposeLearningAction = Effect.fn("Harness.proposeLearningAction")(function* (
  input: LearnProposalInput
) {
  const outcome = yield* DecisionModel.decide(LearnProposalV1, {
    input: {
      kind: input.kind,
      summary: input.summary,
      detail: input.detail,
      occurrences: input.occurrences
    }
  }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catchCause(() => Effect.succeedNone)
  )

  if (Option.isNone(outcome)) {
    return deterministicLearnFallback(input)
  }

  const { answers } = outcome.value
  const prob = answers.actionable.probability
  const fallback = deterministicLearnFallback(input)
  const rawTarget = answers.target.label
  const target: LearnTarget = (LEARN_TARGETS as ReadonlyArray<string>).includes(rawTarget)
    ? (rawTarget as LearnTarget)
    : fallback.target

  yield* Effect.annotateCurrentSpan({
    "decision.definition": "LearnProposalV1",
    "decision.target": target,
    "decision.actionable": String(prob)
  })

  return {
    target,
    actionable: prob >= 0.6,
    confidence: prob,
    recommendation: fallback.recommendation,
    source: "decision-model" as const
  }
})
