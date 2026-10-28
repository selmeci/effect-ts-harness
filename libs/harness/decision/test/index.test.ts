import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  assertDecisionLimits,
  deterministicLearnFallback,
  LearnProposalV1,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
  proposeLearningAction,
  triageFailure,
  type LearnProposalInput
} from "../src/index.js"

describe("LearnProposalV1 and proposeLearningAction", () => {
  it("validates LearnProposalV1 within decision limits", () => {
    expect(() => assertDecisionLimits(LearnProposalV1)).not.toThrow()
  })

  describe("proposeLearningAction with mock DecisionModel", () => {
    it.effect("uses DecisionModel answers when available and actionable (prob >= 0.6)", () =>
      Effect.gen(function* () {
        const input: LearnProposalInput = {
          kind: "route_miss",
          summary: "Custom Effect Service",
          detail: "no matching block found",
          occurrences: 3
        }

        const result = yield* proposeLearningAction(input).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              learnActionableProb: 0.95,
              learnTargetLabel: "agent-pattern"
            })
          )
        )

        expect(result.source).toBe("decision-model")
        expect(result.actionable).toBe(true)
        expect(result.confidence).toBe(0.95)
        expect(result.target).toBe("agent-pattern")
        expect(result.recommendation).toContain("Custom Effect Service")
      })
    )

    it.effect("marks actionable as false when probability < 0.6", () =>
      Effect.gen(function* () {
        const input: LearnProposalInput = {
          kind: "guard_escalation",
          summary: "git status",
          detail: "escalated by guard",
          occurrences: 1
        }

        const result = yield* proposeLearningAction(input).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              learnActionableProb: 0.4,
              learnTargetLabel: "guard-allowlist"
            })
          )
        )

        expect(result.source).toBe("decision-model")
        expect(result.actionable).toBe(false)
        expect(result.confidence).toBe(0.4)
        expect(result.target).toBe("guard-allowlist")
      })
    )

    it.effect("supports triage-rule and ast-graph-gate targets via mock layer", () =>
      Effect.gen(function* () {
        const triageRes = yield* proposeLearningAction({
          kind: "verify_failure",
          summary: "typecheck failure",
          detail: "Type 'string' is not assignable to type 'number'",
          occurrences: 2
        }).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              learnActionableProb: 0.88,
              learnTargetLabel: "triage-rule"
            })
          )
        )
        expect(triageRes.target).toBe("triage-rule")
        expect(triageRes.source).toBe("decision-model")

        const astRes = yield* proposeLearningAction({
          kind: "verify_failure",
          summary: "banned async",
          detail: "harness/syntax-bans violation",
          occurrences: 2
        }).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              learnActionableProb: 0.9,
              learnTargetLabel: "ast-graph-gate"
            })
          )
        )
        expect(astRes.target).toBe("ast-graph-gate")
        expect(astRes.source).toBe("decision-model")
      })
    )
  })

  describe("proposeLearningAction deterministic fallback on DecisionModel failure/timeout", () => {
    it.effect("falls back for route_miss to agent-pattern", () =>
      Effect.gen(function* () {
        const input: LearnProposalInput = {
          kind: "route_miss",
          summary: "D1 Repository Cache",
          detail: "No pattern matched for caching layer",
          occurrences: 4
        }

        const result = yield* proposeLearningAction(input).pipe(
          Effect.provide(makeFailingDecisionModelLayer())
        )

        expect(result).toEqual({
          target: "agent-pattern",
          actionable: true,
          confidence: 0.85,
          recommendation:
            'Create or expand an agent-patterns/*.md recipe for "D1 Repository Cache" and register it in IdiomRouterV1 (11 of 26 slots available).',
          source: "deterministic-fallback"
        })
      })
    )

    it.effect("falls back for verify_failure with ast/graph keywords to ast-graph-gate", () =>
      Effect.gen(function* () {
        const keywords = [
          "domain-requires-",
          "impure-decider",
          "layer-cycle",
          "harness/syntax-bans"
        ]

        for (const kw of keywords) {
          const input: LearnProposalInput = {
            kind: "verify_failure",
            summary: `Recurrent ${kw} error`,
            detail: `Failed verify with ${kw} in libs/sample/domain`,
            occurrences: 3
          }

          const result = yield* proposeLearningAction(input).pipe(
            Effect.provide(makeFailingDecisionModelLayer())
          )

          expect(result.target).toBe("ast-graph-gate")
          expect(result.actionable).toBe(true)
          expect(result.confidence).toBe(0.85)
          expect(result.source).toBe("deterministic-fallback")
          expect(result.recommendation).toBe(
            `Strengthen AST/graph gate in tools/oxlint/syntax-bans.js or checkEffectGraph for recurring violation: Recurrent ${kw} error`
          )
        }
      })
    )

    it.effect("falls back for verify_failure without ast keywords to triage-rule", () =>
      Effect.gen(function* () {
        const input: LearnProposalInput = {
          kind: "verify_failure",
          summary: "Vitest assertion mismatch",
          detail: "expected true to be false in sample.test.ts",
          occurrences: 2
        }

        const result = yield* proposeLearningAction(input).pipe(
          Effect.provide(makeFailingDecisionModelLayer())
        )

        expect(result).toEqual({
          target: "triage-rule",
          actionable: true,
          confidence: 0.85,
          recommendation:
            "Add deterministic pattern and hint to DETERMINISTIC_TRIAGE_RULES in libs/harness/decision/src/triage-decision.ts for: Vitest assertion mismatch",
          source: "deterministic-fallback"
        })
      })
    )

    it.effect("falls back for guard_escalation with actionable based on occurrences >= 2", () =>
      Effect.gen(function* () {
        const inputOnce: LearnProposalInput = {
          kind: "guard_escalation",
          summary: "pnpm install",
          detail: "guard asked for confirmation",
          occurrences: 1
        }

        const resultOnce = yield* proposeLearningAction(inputOnce).pipe(
          Effect.provide(makeFailingDecisionModelLayer())
        )

        expect(resultOnce.target).toBe("guard-allowlist")
        expect(resultOnce.actionable).toBe(false)
        expect(resultOnce.confidence).toBe(0.8)
        expect(resultOnce.source).toBe("deterministic-fallback")
        expect(resultOnce.recommendation).toBe(
          'Review command "pnpm install" — if safe and recurring, add its prefix to ALLOWLIST in libs/harness/gates/src/policy.ts.'
        )

        const inputRecurring: LearnProposalInput = {
          kind: "guard_escalation",
          summary: "pnpm install",
          detail: "guard asked for confirmation",
          occurrences: 2
        }

        const resultRecurring = yield* proposeLearningAction(inputRecurring).pipe(
          Effect.provide(makeFailingDecisionModelLayer())
        )

        expect(resultRecurring.target).toBe("guard-allowlist")
        expect(resultRecurring.actionable).toBe(true)
        expect(resultRecurring.confidence).toBe(0.8)
        expect(resultRecurring.source).toBe("deterministic-fallback")
      })
    )
  })

  it("deterministicLearnFallback helper directly produces expected results", () => {
    const routeMiss = deterministicLearnFallback({
      kind: "route_miss",
      summary: "My Pattern",
      detail: "",
      occurrences: 1
    })
    expect(routeMiss.target).toBe("agent-pattern")
    expect(routeMiss.actionable).toBe(true)

    const guardEscalation1 = deterministicLearnFallback({
      kind: "guard_escalation",
      summary: "cmd",
      detail: "",
      occurrences: 1
    })
    expect(guardEscalation1.actionable).toBe(false)

    const guardEscalation2 = deterministicLearnFallback({
      kind: "guard_escalation",
      summary: "cmd",
      detail: "",
      occurrences: 5
    })
    expect(guardEscalation2.actionable).toBe(true)
  })

  it.effect("triageFailure deterministically classifies lazyEffect, redundant-or-die, schema-number, and prefer-typed-schema-decoder", () =>
    Effect.gen(function* () {
      const lazyRes = yield* triageFailure(
        "TS377091: Service 'PhotoRepo' member 'listAll' returns a lazy Effect. effect(lazyEffect)"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(lazyRes.kind).toBe("mechanical")
      expect(lazyRes.hint).toContain("TS377091")

      const orDieRes = yield* triageFailure(
        "effecttsgo(redundant-or-die): This generator applies Effect.orDie to every yielded effect."
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(orDieRes.kind).toBe("mechanical")
      expect(orDieRes.hint).toContain("TS377088")

      const schemaNumRes = yield* triageFailure(
        "effecttsgo(schema-number): This Schema number API accepts NaN"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(schemaNumRes.kind).toBe("mechanical")
      expect(schemaNumRes.hint).toContain("TS377087")

      const decoderRes = yield* triageFailure(
        "effecttsgo(prefer-typed-schema-decoder): Use decodeSync"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(decoderRes.kind).toBe("mechanical")
      expect(decoderRes.hint).toContain("TS377092")
    })
  )

  it.effect("triageFailure deterministically classifies security & reliability lint messages", () =>
    Effect.gen(function* () {
      const configRes = yield* triageFailure(
        "harness(syntax-bans): Sensitive configuration keys must use Config.redacted(...) instead of Config.string(...)"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(configRes.kind).toBe("mechanical")
      expect(configRes.hint).toContain("Config.redacted")

      const sqlRes = yield* triageFailure(
        "harness(syntax-bans): Raw SQL template interpolation in .prepare() is banned (SQL injection risk)"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(sqlRes.kind).toBe("mechanical")
      expect(sqlRes.hint).toContain("parameterized queries")

      const impureRes = yield* triageFailure(
        "harness(syntax-bans): Impure global Date.now() / new Date() / Math.random() is banned in type:domain"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(impureRes.kind).toBe("mechanical")
      expect(impureRes.hint).toContain("Impure global")

      const retryRes = yield* triageFailure(
        "harness(syntax-bans): Unbounded Effect.retry with Schedule.forever is banned (retry storm risk)"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(retryRes.kind).toBe("mechanical")
      expect(retryRes.hint).toContain("Schedule.forever")

      const ignoreRes = yield* triageFailure(
        "harness(syntax-bans): Swallowing typed errors with Effect.ignore is banned in type:domain"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(ignoreRes.kind).toBe("mechanical")
      expect(ignoreRes.hint).toContain("Effect.ignore")

      const discBranchRes = yield* triageFailure(
        "[discriminant-branching] Condition in 'libs/sample/domain/src/index.ts#checkQuota' branches on union discriminant"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(discBranchRes.kind).toBe("mechanical")
      expect(discBranchRes.hint).toContain("pattern-matching.md")

      const nonExhaustiveRes = yield* triageFailure(
        "[non-exhaustive-union-match] match(res) in 'libs/sample/domain/src/index.ts#formatPayment' matches on a closed union"
      ).pipe(Effect.provide(makeFailingDecisionModelLayer()))
      expect(nonExhaustiveRes.kind).toBe("mechanical")
      expect(nonExhaustiveRes.hint).toContain(".exhaustive()")
    })
  )
})
