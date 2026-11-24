import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  checkOntologyPairConflict,
  validateDecisionLimits,
  checkPlanStepCoverage,
  GuardV1,
  IdiomRouterV1,
  LearnProposalV1,
  makeFailingDecisionModelLayer,
  makeMockDecisionModelLayer,
  OntologyConflictV1,
  PlanStepCoverageV1,
  routeStep,
  TriageV1,
} from "../src/index.js"

describe("Harness plan coverage, idiom router & ontology conflict decisions", () => {
  it.effect(
    "keeps all decision definitions within Ollama System One limits (<=26 options, <=64 questions)",
    () =>
      Effect.gen(function* () {
        for (const def of [
          IdiomRouterV1,
          GuardV1,
          TriageV1,
          PlanStepCoverageV1,
          LearnProposalV1,
          OntologyConflictV1,
        ]) {
          yield* validateDecisionLimits(def)
        }
      }),
  )

  it.effect("evaluates per-step plan coverage with deterministic mock DecisionModel", () =>
    Effect.gen(function* () {
      const pass = yield* checkPlanStepCoverage({
        stepId: "step-1",
        planStep: "Add GreetInput schema",
        stepDiff: "+export const GreetInput = Schema.Struct({ name: Schema.String })",
      }).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({ implementedProb: 0.95, noOutOfScopeProb: 0.95 }),
        ),
      )
      expect(pass.covered).toBe(true)

      const fail = yield* checkPlanStepCoverage({
        stepId: "step-2",
        planStep: "Add PhotoRepo D1 insert",
        stepDiff: "",
      }).pipe(
        Effect.provide(makeMockDecisionModelLayer({ implementedProb: 0.2, noOutOfScopeProb: 0.9 })),
      )
      expect(fail.covered).toBe(false)
      expect(fail.reason).toContain("step-2")
    }),
  )

  it.effect(
    "deterministically routes unambiguous pattern keywords without calling DecisionModel (REQ-1.1, REQ-1.2, REQ-1.3)",
    () =>
      Effect.gen(function* () {
        const failingLayer = makeFailingDecisionModelLayer()

        // REQ-1.1: event-sourcing keywords
        expect(
          yield* routeStep("event sourcing decider core").pipe(Effect.provide(failingLayer)),
        ).toBe("event-sourcing")
        expect(yield* routeStep("event sourcing").pipe(Effect.provide(failingLayer))).toBe(
          "event-sourcing",
        )
        expect(
          yield* routeStep("implement pure evolve transition").pipe(Effect.provide(failingLayer)),
        ).toBe("event-sourcing")
        expect(
          yield* routeStep("persist batch in event-store").pipe(Effect.provide(failingLayer)),
        ).toBe("event-sourcing")
        expect(
          yield* routeStep("load aggregate root state").pipe(Effect.provide(failingLayer)),
        ).toBe("event-sourcing")

        // REQ-1.2: other deterministic building blocks
        expect(
          yield* routeStep("exhaustive pattern matching with ts-pattern").pipe(
            Effect.provide(failingLayer),
          ),
        ).toBe("pattern-matching")
        expect(
          yield* routeStep("d1-repository with @effect/sql-d1").pipe(Effect.provide(failingLayer)),
        ).toBe("d1-repository")
        expect(
          yield* routeStep("durable-object-state counter").pipe(Effect.provide(failingLayer)),
        ).toBe("durable-object-state")
        expect(yield* routeStep("httpapi endpoint group").pipe(Effect.provide(failingLayer))).toBe(
          "httpapi",
        )
        expect(yield* routeStep("rpcgroup handler").pipe(Effect.provide(failingLayer))).toBe("rpc")
        expect(yield* routeStep("atomhttpapi client").pipe(Effect.provide(failingLayer))).toBe(
          "atom",
        )

        // REQ-1.3: empty or whitespace steps default to "review"
        expect(yield* routeStep("   ").pipe(Effect.provide(failingLayer))).toBe("review")

        // REQ-1.3: confidence threshold boundary (0.69 -> review, 0.70 -> blockLabel)
        const belowThreshold = yield* routeStep("Custom unclassified step").pipe(
          Effect.provide(makeMockDecisionModelLayer({ fitsAnyProb: 0.69, blockLabel: "schema" })),
        )
        expect(belowThreshold).toBe("review")

        const atThreshold = yield* routeStep("Custom unclassified step").pipe(
          Effect.provide(makeMockDecisionModelLayer({ fitsAnyProb: 0.7, blockLabel: "schema" })),
        )
        expect(atThreshold).toBe("schema")
      }),
  )

  it.effect(
    "checkOntologyPairConflict boundary: probability === 0.7 with non-none conflictKind detects conflict",
    () =>
      Effect.gen(function* () {
        const mockLayer = makeMockDecisionModelLayer({
          contradictsProb: 0.7,
          conflictKindLabel: "state-transition-conflict",
        })
        const result = yield* checkOntologyPairConflict({
          sourceId: "sample:SPEC-0001:REQ-1.1",
          sourceText: "When upload is requested, the system shall approve.",
          targetId: "sample:SPEC-0001:REQ-1.2",
          targetText: "When upload is requested, the system shall reject.",
          sharedSymbol: "Sample.uploadPhoto",
        }).pipe(Effect.provide(mockLayer))

        expect(result.hasConflict).toBe(true)
        expect(result.probability).toBe(0.7)
        expect(result.conflictKind).toBe("state-transition-conflict")
      }),
  )
})
