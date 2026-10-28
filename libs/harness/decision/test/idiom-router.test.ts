import { describe, expect, it } from "vitest"
import { assertDecisionLimits, IDIOM_BLOCKS, IdiomRouterV1 } from "../src/idiom-router.js"

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
      "effect"
    ])
  })

  it("enforces Ollama's 2-26 option limit and 1-64 question limit via assertDecisionLimits", () => {
    expect(() => assertDecisionLimits(IdiomRouterV1)).not.toThrow()

    const tooManyOptions = Object.fromEntries(
      Array.from({ length: 27 }, (_, idx) => [`opt${idx}`, `Option ${idx}`])
    )
    expect(() =>
      assertDecisionLimits({
        decisions: {
          bad: {
            _tag: "Classify",
            criteria: tooManyOptions
          }
        }
      })
    ).toThrow(/26/)
  })
})
