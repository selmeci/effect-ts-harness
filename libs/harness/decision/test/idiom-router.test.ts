import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { match } from "ts-pattern"
import {
  IDIOM_BLOCKS,
  IdiomRouterV1,
  routeStep,
  selectRouteWithHybridCandidates,
  validateDecisionLimits,
} from "../src/idiom-router.js"
import { makeMockDecisionModelLayer } from "../src/mock-layer.js"

describe("IdiomRouterV1 data constraints", () => {
  it("puts review first (tie-break mitigation)", () => {
    expect(IDIOM_BLOCKS[0]).toBe("review")
  })

  it("includes all MVP v2 application stack and Effect building block categories", () => {
    expect(IDIOM_BLOCKS).toEqual([
      "review",
      "services-and-layers",
      "errors",
      "schema",
      "pattern-matching",
      "event-sourcing",
      "resources-scope",
      "concurrency",
      "schedule",
      "testing",
      "alchemy-infra",
      "d1-repository",
      "durable-object-state",
      "httpapi",
      "rpc",
      "atom",
      "decision-model",
      "planning",
      "effect",
    ])
  })

  it("enforces Ollama's 2-26 option limit and 1-64 question limit via validateDecisionLimits", async () => {
    const validExit = await Effect.runPromiseExit(validateDecisionLimits(IdiomRouterV1))
    expect(Exit.isSuccess(validExit)).toBe(true)

    const tooManyOptions = Object.fromEntries(
      Array.from({ length: 27 }, (_, idx) => [`opt${idx}`, `Option ${idx}`]),
    )
    const invalidExit = await Effect.runPromiseExit(
      validateDecisionLimits({
        decisions: {
          bad: {
            _tag: "Classify",
            criteria: tooManyOptions,
          },
        },
      }),
    )
    match(invalidExit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(Cause.hasDies(cause)).toBe(true)
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected invalidExit to fail with die")
      })
      .exhaustive()

    const emptyExit = await Effect.runPromiseExit(validateDecisionLimits({ decisions: {} }))
    match(emptyExit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(Cause.hasDies(cause)).toBe(true)
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected empty decisions to fail with die")
      })
      .exhaustive()
  })
})

describe("Deterministic routing for Phase 4 event schema evolution", () => {
  const mockModel = makeMockDecisionModelLayer()

  it("routes prompts mentioning event schema upcasters to event-sourcing", async () => {
    const result1 = await Effect.runPromise(
      routeStep("Define event schema upcasters for v1 to v2 evolution").pipe(
        Effect.provide(mockModel),
      ),
    )
    expect(result1).toBe("event-sourcing")

    const result2 = await Effect.runPromise(
      routeStep("Implement upcaster for OrderCreated event").pipe(Effect.provide(mockModel)),
    )
    expect(result2).toBe("event-sourcing")
  })

  it("routes prompts mentioning toJsonSchemaDocument to schema", async () => {
    const result = await Effect.runPromise(
      routeStep("Export event schema to JSON Schema using toJsonSchemaDocument").pipe(
        Effect.provide(mockModel),
      ),
    )
    expect(result).toBe("schema")
  })

  it("routes prompts mentioning AggregateApiSpec to httpapi", async () => {
    const result = await Effect.runPromise(
      routeStep("Expose aggregate command endpoints via AggregateApiSpec").pipe(
        Effect.provide(mockModel),
      ),
    )
    expect(result).toBe("httpapi")
  })

  it("routes prompts mentioning AtomHttpApi to atom", async () => {
    const result = await Effect.runPromise(
      routeStep("Manage frontend reactive state with AtomHttpApi").pipe(Effect.provide(mockModel)),
    )
    expect(result).toBe("atom")
  })

  it("routes event-snapshots to event-sourcing and snapshot tests to testing", async () => {
    const esResult = await Effect.runPromise(
      routeStep("Freeze event-snapshots registry for v1 and v2 schemas").pipe(
        Effect.provide(mockModel),
      ),
    )
    expect(esResult).toBe("event-sourcing")

    const testResult = await Effect.runPromise(
      routeStep("Run snapshot test with TestClock to verify timeout").pipe(
        Effect.provide(mockModel),
      ),
    )
    expect(testResult).toBe("testing")
  })

  it("verifies precedence when prompt mentions schema evolution (toJsonSchemaDocument, upcaster) and HttpApi", async () => {
    const schemaPrecedence = await Effect.runPromise(
      routeStep("Export HttpApi contract to JSON schema using toJsonSchemaDocument").pipe(
        Effect.provide(mockModel),
      ),
    )
    expect(schemaPrecedence).toBe("schema")

    const httpApiPrecedence = await Effect.runPromise(
      routeStep("Expose event upcaster endpoints over HttpApi transport").pipe(
        Effect.provide(mockModel),
      ),
    )
    expect(httpApiPrecedence).toBe("httpapi")
  })

  it("routes prompts mentioning clef-flash System One DecisionModel to decision-model", async () => {
    const result = await Effect.runPromise(
      routeStep("Configure clef-flash System One DecisionModel").pipe(Effect.provide(mockModel)),
    )
    expect(result).toBe("decision-model")
  })

  it("routes planning/skeleton prompts deterministically to planning and upgrades review routes from hybrid candidates", async () => {
    const planningResult = await Effect.runPromise(
      routeStep("Author EARS spec and stub<A, E, R> skeleton before plan-check").pipe(
        Effect.provide(mockModel),
      ),
    )
    expect(planningResult).toBe("planning")

    expect(
      selectRouteWithHybridCandidates({ block: "review", source: "degraded-fallback" }, [
        { slug: "review", score: 0.99 },
        { slug: "resources-scope", score: 0.85 },
      ]),
    ).toEqual({
      block: "resources-scope",
      source: "hybrid-retrieval",
    })

    expect(
      selectRouteWithHybridCandidates({ block: "review", source: "degraded-fallback" }, [
        { slug: "testing", score: 0.75 },
      ]),
    ).toEqual({
      block: "testing",
      source: "hybrid-retrieval",
    })

    expect(
      selectRouteWithHybridCandidates({ block: "review", source: "degraded-fallback" }, [
        { slug: "resources-scope" },
      ]),
    ).toEqual({
      block: "review",
      source: "degraded-fallback",
    })

    expect(
      selectRouteWithHybridCandidates({ block: "review", source: "degraded-fallback" }, [
        { slug: "resources-scope", score: 0.5 },
      ]),
    ).toEqual({
      block: "review",
      source: "degraded-fallback",
    })

    expect(
      selectRouteWithHybridCandidates({ block: "schema", source: "deterministic" }, [
        { slug: "resources-scope", score: 0.99 },
      ]),
    ).toEqual({
      block: "schema",
      source: "deterministic",
    })
  })
})
