import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { loadPatternDocs } from "../src/pattern-index.js"

describe("agent-patterns index", () => {
  it("loads all 16 reviewed pattern files with non-empty summaries", () => {
    const repoRoot = resolve(import.meta.dirname, "../../../..")
    const docs = loadPatternDocs(repoRoot)
    expect(docs.map((d) => d.slug).sort()).toEqual([
      "alchemy-infra",
      "atom",
      "concurrency",
      "d1-repository",
      "durable-object-state",
      "errors",
      "event-sourcing",
      "httpapi",
      "pattern-matching",
      "planning",
      "resources-scope",
      "rpc",
      "schedule",
      "schema",
      "services-and-layers",
      "testing"
    ])
    for (const doc of docs) {
      expect(doc.summary.length).toBeGreaterThan(20)
    }
  })
})
