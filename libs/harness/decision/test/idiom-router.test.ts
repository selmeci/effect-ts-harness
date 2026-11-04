import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  assertDecisionLimits,
  IDIOM_BLOCKS,
  IdiomRouterV1,
  routeStep,
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

  it("enforces Ollama's 2-26 option limit and 1-64 question limit via assertDecisionLimits", () => {
    expect(() => assertDecisionLimits(IdiomRouterV1)).not.toThrow()

    const tooManyOptions = Object.fromEntries(
      Array.from({ length: 27 }, (_, idx) => [`opt${idx}`, `Option ${idx}`]),
    )
    expect(() =>
      assertDecisionLimits({
        decisions: {
          bad: {
            _tag: "Classify",
            criteria: tooManyOptions,
          },
        },
      }),
    ).toThrow(/26/)
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

  it("routes prompts mentioning event-snapshots to testing", async () => {
    const result = await Effect.runPromise(
      routeStep("Run event-snapshots regression suite to detect breaking changes").pipe(
        Effect.provide(mockModel),
      ),
    )
    expect(result).toBe("testing")
  })
})
