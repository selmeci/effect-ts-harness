import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { buildHarnessGraph } from "@harness/graph"
import { runCliEffect } from "../src/index.js"

describe("harness-cli ontology command", () => {
  const implGraph = buildHarnessGraph({
    adrDocs: [
      {
        id: "sample:ADR-0001",
        title: "D1 persistence boundaries",
        status: "accepted",
        path: "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
        enforcedByFiles: [],
        referencedSpans: [],
        referencedServices: ["PhotoRepo"],
        referencedErrors: [],
      },
    ],
    earsSpecs: [
      {
        id: "sample:SPEC-0001",
        title: "Sample Gallery",
        status: "accepted",
        path: "libs/sample/docs/specs/2026-10-25-sample-photo-gallery.md",
        enforcedByFiles: [],
        referencedSpans: [],
        referencedServices: ["PhotoRepo"],
        referencedErrors: [],
      },
    ],
    services: [
      {
        tagId: "PhotoRepo",
        name: "PhotoRepo",
        packageTag: "service",
        file: "libs/sample/service/src/index.ts",
      },
    ],
    layers: [
      {
        qualname: "PhotoRepoLive",
        layerKind: "infra",
        packageTag: "infra",
        file: "libs/sample/infra/src/index.ts",
      },
    ],
    governsSymbols: [
      {
        adrId: "sample:ADR-0001",
        targetKey: "PhotoRepo",
        targetKind: "ServiceTag",
      },
    ],
    specifiesSymbols: [
      {
        specId: "sample:SPEC-0001",
        targetKey: "PhotoRepo",
        targetKind: "ServiceTag",
      },
    ],
    providesService: [
      {
        layerQualname: "PhotoRepoLive",
        tagId: "PhotoRepo",
      },
    ],
  })

  const CheckOutputSchema = Schema.Struct({
    clean: Schema.Boolean,
    findings: Schema.Array(Schema.Unknown),
    semanticConflicts: Schema.Array(Schema.Unknown),
    evaluatedPairs: Schema.Finite,
  })
  const decodeCheckOutput = Schema.decodeUnknownSync(Schema.fromJsonString(CheckOutputSchema))

  it.effect("queries ontology why for a symbol", () =>
    Effect.gen(function* () {
      const res = yield* runCliEffect(["ontology", "why", "PhotoRepoLive"], {
        implGraph,
      })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain('"justified":true')
      expect(res.stdout).toContain("sample:ADR-0001")
      expect(res.stdout).toContain("sample:SPEC-0001")
    }),
  )

  it.effect("queries ontology impact for a service", () =>
    Effect.gen(function* () {
      const res = yield* runCliEffect(["ontology", "impact", "PhotoRepo"], {
        implGraph,
      })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain('"PhotoRepo"')
      expect(res.stdout).toContain("Motivation")
      expect(res.stdout).toContain("Technology")
    }),
  )

  it.effect("renders ontology layers as Mermaid diagram", () =>
    Effect.gen(function* () {
      const res = yield* runCliEffect(["ontology", "layers", "--format=mermaid"], {
        implGraph,
      })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain("flowchart TB")
      expect(res.stdout).toContain("subgraph Motivation")
      expect(res.stdout).toContain("subgraph Application")
    }),
  )

  it.effect("runs ontology check in strict mode with mock decision layer", () =>
    Effect.gen(function* () {
      const res = yield* runCliEffect(["ontology", "check", "--scope=sample", "--strict"], {
        implGraph,
        decisionLayer: makeMockDecisionModelLayer(),
      })
      expect(res.exitCode).toBe(0)
      const report = decodeCheckOutput(res.stdout)
      expect(report.clean).toBe(true)
      expect(report.findings.length).toBe(0)
    }),
  )
})
