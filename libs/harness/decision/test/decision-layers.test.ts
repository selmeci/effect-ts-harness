import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeFailingDecisionModelLayer } from "../src/mock-layer.js"
import { triageFailure } from "../src/triage-decision.js"

describe("triageFailure ontology realization chain", () => {
  it.effect("classifies ontology-broken-realization-chain with updated hint", () =>
    Effect.gen(function* () {
      const res = yield* triageFailure("ontology-broken-realization-chain").pipe(
        Effect.provide(makeFailingDecisionModelLayer()),
      )
      expect(res.kind).toBe("mechanical")
      expect(res.hint).toBe(
        "Every domain/core Effect.fn must be justified by an accepted EARS spec (specifies) and ADR (governs) in the ontology realization chain — add the symbol to the spec EARS table and spec/ADR frontmatter spans (see agent-patterns/planning.md).",
      )
    }),
  )

  it.effect("classifies aggregate-direct-bus-publish with Outbox.drain hint", () =>
    Effect.gen(function* () {
      const violationPayload = JSON.stringify({
        rule: "aggregate-direct-bus-publish",
        message:
          "Aggregate function 'libs/es/infra/src/aggregate.ts#handleCommand' must not publish directly to EventBus",
      })
      const res = yield* triageFailure(violationPayload).pipe(
        Effect.provide(makeFailingDecisionModelLayer()),
      )
      expect(res.kind).toBe("mechanical")
      expect(res.hint).toContain("es_outbox")
      expect(res.hint).toContain("Outbox.drain")
    }),
  )
})
