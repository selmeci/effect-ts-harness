import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Logger } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  checkOntologyPairConflict,
  checkPlanStepCoverage,
  decideGuardCommand,
  evaluateOntologyConflictsWithStatus,
  proposeLearningAction,
  routeStep,
  triageFailure,
} from "../src/index.js"

const interruptLayer = Layer.succeed(DecisionModel.DecisionModel, {
  [DecisionModel.TypeId]: DecisionModel.TypeId,
  decide: () => Effect.interrupt,
})

const makeDefectCaptureLayer = (warnings: Array<string>) => {
  const captureLogger = Logger.make((options) => {
    if (options.logLevel === "Warn") {
      warnings.push(String(options.message))
    }
  })
  const dieLayer = Layer.succeed(DecisionModel.DecisionModel, {
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: () => Effect.die(new Error("simulated model defect")),
  })
  return Layer.mergeAll(dieLayer, Logger.layer([captureLogger]))
}

const assertInterruptPropagates = <A, E>(
  label: string,
  eff: Effect.Effect<A, E, DecisionModel.DecisionModel>,
) =>
  Effect.gen(function* () {
    const exit = yield* eff.pipe(Effect.provide(interruptLayer), Effect.exit)
    match(exit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(Cause.hasInterrupts(cause), label).toBe(true)
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable(`Expected fiber interruption to propagate for ${label}`)
      })
      .exhaustive()
  })

describe("Decision catchCause interrupt propagation & defect warning (F-6.3, T-11, C-8)", () => {
  it.effect("T-11: propagates fiber interruption across all 6 decision modules without returning fallback", () =>
    Effect.gen(function* () {
      yield* assertInterruptPropagates(
        "idiom-router",
        routeStep("Add Schema validation for user input"),
      )
      yield* assertInterruptPropagates(
        "triage-decision",
        triageFailure("ambiguous runtime anomaly without deterministic pattern"),
      )
      yield* assertInterruptPropagates(
        "plan-coverage-decision",
        checkPlanStepCoverage({
          stepId: "step-1",
          planStep: "Implement repository",
          stepDiff: "export const save = stub()",
        }),
      )
      yield* assertInterruptPropagates(
        "learn-decision",
        proposeLearningAction({
          kind: "route_miss",
          summary: "Missed route",
          detail: "Step fell through to review",
          occurrences: 2,
        }),
      )
      yield* assertInterruptPropagates(
        "ontology-conflict-decision",
        checkOntologyPairConflict({
          sourceId: "SPEC-0001#REQ-1",
          sourceText: "WHEN a happens THEN b",
          targetId: "ADR-0001",
          targetText: "Chosen option: c",
          sharedSymbol: "Foo",
        }),
      )
      yield* assertInterruptPropagates(
        "guard-decision",
        decideGuardCommand("custom-ambiguous-tool --check"),
      )
    }),
  )

  it.effect("T-11 & C-8: logs warning diagnostic and returns fallback/degraded flag across all 6 decision modules", () =>
    Effect.gen(function* () {
      const checkModule = <A>(
        label: string,
        eff: Effect.Effect<A, never, DecisionModel.DecisionModel>,
        assertFallback: (value: A) => void,
      ) =>
        Effect.gen(function* () {
          const warnings: Array<string> = []
          const result = yield* eff.pipe(Effect.provide(makeDefectCaptureLayer(warnings)))
          assertFallback(result)
          expect(
            warnings.some((w) => w.includes("Decision model fallback:")),
            label,
          ).toBe(true)
        })

      yield* checkModule(
        "idiom-router",
        routeStep("Add Schema validation for user input"),
        (res) => {
          expect(res).toBe("review")
        },
      )
      yield* checkModule(
        "triage-decision",
        triageFailure("ambiguous runtime anomaly without deterministic pattern"),
        (res) => {
          expect(res.kind).toBe("semantic")
        },
      )
      yield* checkModule(
        "plan-coverage-decision",
        checkPlanStepCoverage({
          stepId: "step-1",
          planStep: "Implement repository",
          stepDiff: "export const save = stub()",
        }),
        (res) => {
          expect(res.covered).toBe(false)
        },
      )
      yield* checkModule(
        "learn-decision",
        proposeLearningAction({
          kind: "route_miss",
          summary: "Missed route",
          detail: "Step fell through to review",
          occurrences: 2,
        }),
        (res) => {
          expect(res.target).toBe("agent-pattern")
        },
      )
      yield* checkModule(
        "ontology-conflict-decision",
        checkOntologyPairConflict({
          sourceId: "SPEC-0001#REQ-1",
          sourceText: "WHEN a happens THEN b",
          targetId: "ADR-0001",
          targetText: "Chosen option: c",
          sharedSymbol: "Foo",
        }),
        (res) => {
          expect(res.timedOutOrUnavailable).toBe(true)
          expect(res.hasConflict).toBe(false)
        },
      )
      yield* checkModule(
        "ontology-conflict-decision:withStatus",
        evaluateOntologyConflictsWithStatus([
          {
            sourceId: "SPEC-0001#REQ-1",
            sourceText: "WHEN a happens THEN b",
            targetId: "ADR-0001",
            targetText: "Chosen option: c",
            sharedSymbol: "Foo",
          },
        ]),
        (res) => {
          expect(res.degraded).toBe(true)
          expect(res.conflicts).toEqual([])
          expect(res.evaluationError).toContain("timed out or was unavailable")
        },
      )
      yield* checkModule(
        "guard-decision",
        decideGuardCommand("custom-ambiguous-tool --check"),
        (res) => {
          expect(res.verdict).toBe("ask")
        },
      )
    }),
  )

  it.effect("F-12.1: composite Cause.combine(Cause.die, Cause.interrupt) logs warning and returns degraded fallback instead of disappearing as pure interrupt", () =>
    Effect.gen(function* () {
      const warnings: Array<string> = []
      const captureLogger = Logger.make((options) => {
        if (options.logLevel === "Warn") {
          warnings.push(String(options.message))
        }
      })
      const compositeLayer = Layer.mergeAll(
        Layer.succeed(DecisionModel.DecisionModel, {
          [DecisionModel.TypeId]: DecisionModel.TypeId,
          decide: () =>
            Effect.failCause(Cause.combine(Cause.die(new Error("boom")), Cause.interrupt(0))),
        }),
        Logger.layer([captureLogger]),
      )

      const routeRes = yield* routeStep("Add Schema validation for user input").pipe(
        Effect.provide(compositeLayer),
      )
      expect(routeRes).toBe("review")

      const ontologyRes = yield* checkOntologyPairConflict({
        sourceId: "SPEC-0001#REQ-1",
        sourceText: "WHEN a happens THEN b",
        targetId: "ADR-0001",
        targetText: "Chosen option: c",
        sharedSymbol: "Foo",
      }).pipe(Effect.provide(compositeLayer))
      expect(ontologyRes.timedOutOrUnavailable).toBe(true)
      expect(ontologyRes.hasConflict).toBe(false)
      expect(warnings.filter((w) => w.includes("Decision model fallback:")).length).toBe(2)
    }),
  )
})
