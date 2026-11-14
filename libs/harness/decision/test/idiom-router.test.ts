import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import {
  IDIOM_BLOCKS,
  IdiomRouterV1,
  routeStep,
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
    expect(Exit.isFailure(invalidExit)).toBe(true)
    if (Exit.isFailure(invalidExit)) {
      expect(Cause.hasDies(invalidExit.cause)).toBe(true)
    }
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
})
