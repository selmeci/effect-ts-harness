import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { buildHarnessGraph } from "@harness/graph"
import { executeToolEffect } from "../src/server.js"

describe("harness-mcp ontology tools", () => {
  const graph = buildHarnessGraph({
    adrDocs: [
      {
        id: "sample:ADR-0001",
        title: "D1 persistence boundaries",
        status: "accepted",
        path: "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
        enforcedByFiles: [],
        referencedSpans: [],
        referencedServices: ["PhotoRepo"],
        referencedErrors: []
      }
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
        referencedErrors: []
      }
    ],
    services: [
      {
        tagId: "PhotoRepo",
        name: "PhotoRepo",
        packageTag: "service",
        file: "libs/sample/service/src/index.ts"
      }
    ],
    layers: [
      {
        qualname: "PhotoRepoLive",
        layerKind: "infra",
        packageTag: "infra",
        file: "libs/sample/infra/src/index.ts"
      }
    ],
    governsSymbols: [
      {
        adrId: "sample:ADR-0001",
        targetKey: "PhotoRepo",
        targetKind: "ServiceTag"
      }
    ],
    specifiesSymbols: [
      {
        specId: "sample:SPEC-0001",
        targetKey: "PhotoRepo",
        targetKind: "ServiceTag"
      }
    ],
    providesService: [
      {
        layerQualname: "PhotoRepoLive",
        tagId: "PhotoRepo"
      }
    ]
  })

  const WhyTraceSchema = Schema.Struct({
    justified: Schema.Boolean,
    governingAdrs: Schema.Array(
      Schema.Struct({
        id: Schema.String
      })
    ),
    realizingSpecs: Schema.Array(
      Schema.Struct({
        id: Schema.String
      })
    )
  })
  const decodeWhyTrace = Schema.decodeUnknownSync(WhyTraceSchema)

  const ImpactSchema = Schema.Struct({
    target: Schema.NullOr(
      Schema.Struct({
        key: Schema.String,
        layer: Schema.String
      })
    ),
    affectedSpecs: Schema.Array(Schema.String),
    affectedAdrs: Schema.Array(Schema.String)
  })
  const decodeImpact = Schema.decodeUnknownSync(ImpactSchema)

  const CheckResultSchema = Schema.Struct({
    clean: Schema.Boolean,
    findings: Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        nodeId: Schema.String,
        message: Schema.String
      })
    ),
    semanticConflicts: Schema.Array(
      Schema.Struct({
        sourceId: Schema.String,
        targetId: Schema.String,
        hasConflict: Schema.Boolean,
        conflictKind: Schema.String
      })
    ),
    evaluatedPairs: Schema.Finite,
    layerCounts: Schema.Struct({
      Motivation: Schema.Finite,
      Business: Schema.Finite,
      Application: Schema.Finite,
      Technology: Schema.Finite,
      Implementation: Schema.Finite
    })
  })
  const decodeCheckResult = Schema.decodeUnknownSync(CheckResultSchema)

  it.effect("executes harness_ontology_why to trace upward to Motivation", () =>
    Effect.gen(function* () {
      const raw = yield* executeToolEffect(
        "harness_ontology_why",
        { symbolOrSpan: "PhotoRepoLive" },
        { graph }
      )
      const res = decodeWhyTrace(raw)
      expect(res.justified).toBe(true)
      expect(res.governingAdrs.some((a) => a.id === "sample:ADR-0001")).toBe(true)
      expect(res.realizingSpecs.some((s) => s.id === "sample:SPEC-0001")).toBe(true)
    })
  )

  it.effect("executes harness_ontology_impact to analyze cross-layer impact", () =>
    Effect.gen(function* () {
      const raw = yield* executeToolEffect(
        "harness_ontology_impact",
        { symbolOrSpan: "PhotoRepo" },
        { graph }
      )
      const res = decodeImpact(raw)
      expect(res.target).not.toBeNull()
      expect(res.target?.key).toBe("PhotoRepo")
      expect(res.affectedSpecs).toContain("sample:SPEC-0001")
      expect(res.affectedAdrs).toContain("sample:ADR-0001")
    })
  )

  it.effect("executes harness_ontology_check cleanly when no conflicts exist", () =>
    Effect.gen(function* () {
      const cleanDocs = [
        {
          id: "sample:SPEC-0001",
          docPath: "libs/sample/docs/specs/0001.md",
          status: "accepted" as const,
          markdown: `---
id: sample:SPEC-0001
title: Sample Gallery
status: accepted
---

# Sample Gallery

| ID | Pattern | Requirement | Effect Symbol | Verification |
|---|---|---|---|---|
| REQ-1.1 | Event-driven | When a photo is uploaded, the service shall store it in PhotoRepo. | PhotoRepo | test |
`
        },
        {
          id: "sample:ADR-0001",
          docPath: "libs/sample/docs/adr/0001.md",
          status: "accepted" as const,
          referencedServices: ["PhotoRepo"],
          markdown: `---
id: sample:ADR-0001
title: D1 persistence boundaries
status: accepted
referencedServices:
  - PhotoRepo
---

# D1 persistence boundaries

## Context and Problem Statement
Context

## Decision Drivers
* Persistence

## Considered Options
* Option 1

## Decision Outcome
**Chosen option:** "D1 persistence with PhotoRepo"

## Rejected Alternatives
### 1 · Option 2
**Why rejected:** Rejected

## Consequences and Enforcement
### Deterministic Enforcement
| Rule | Component | Enforcement Tool | Verified in CI |
|---|---|---|---|
| Rule 1 | Infra | AST | Yes |
`
        }
      ]

      const raw = yield* executeToolEffect(
        "harness_ontology_check",
        { scope: "sample" },
        {
          graph,
          governanceDocs: cleanDocs,
          decisionLayer: makeMockDecisionModelLayer()
        }
      )

      const res = decodeCheckResult(raw)
      expect(res.clean).toBe(true)
      expect(res.findings.length).toBe(0)
      expect(res.semanticConflicts.length).toBe(0)
      expect(res.layerCounts.Motivation).toBe(2)
      expect(res.layerCounts.Application).toBe(1)
      expect(res.layerCounts.Technology).toBe(1)
    })
  )

  it.effect("executes harness_ontology_check and flags semantic conflicts", () =>
    Effect.gen(function* () {
      const conflictingDocs = [
        {
          id: "sample:SPEC-0001",
          docPath: "libs/sample/docs/specs/0001.md",
          status: "accepted" as const,
          markdown: `---
id: sample:SPEC-0001
title: Sample Gallery
status: accepted
---

# Sample Gallery

| ID | Pattern | Requirement | Effect Symbol | Verification |
|---|---|---|---|---|
| REQ-1.1 | Event-driven | When upload is submitted, the system shall approve photo upload. | Sample.uploadPhoto | test |
| REQ-1.2 | Event-driven | When upload is submitted, the system shall reject photo upload. | Sample.uploadPhoto | test |
`
        }
      ]

      const conflictLayer = makeMockDecisionModelLayer({
        contradictsProb: 0.95,
        conflictKindLabel: "state-transition-conflict"
      })

      const raw = yield* executeToolEffect(
        "harness_ontology_check",
        { scope: "sample" },
        {
          graph,
          governanceDocs: conflictingDocs,
          decisionLayer: conflictLayer
        }
      )

      const res = decodeCheckResult(raw)
      expect(res.clean).toBe(false)
      expect(res.semanticConflicts.length).toBeGreaterThan(0)
      const conflict = res.semanticConflicts[0]
      expect(conflict?.hasConflict).toBe(true)
      expect(conflict?.conflictKind).toBe("state-transition-conflict")
      expect(conflict?.sourceId).toBe("sample:SPEC-0001#REQ-1.1")
      expect(conflict?.targetId).toBe("sample:SPEC-0001#REQ-1.2")
    })
  )

  it.effect("executes harness_gq_query for ontology_layer_nodes", () =>
    Effect.gen(function* () {
      const raw = yield* executeToolEffect(
        "harness_gq_query",
        { queryName: "ontology_layer_nodes", params: { layer: "Business" } },
        { graph }
      )
      const res = raw as {
        readonly source: string
        readonly rows: ReadonlyArray<Record<string, unknown>>
      }
      expect(["omnigraph", "memory-fallback"]).toContain(res.source)
      expect(Array.isArray(res.rows)).toBe(true)
    })
  )

  it.effect("executes harness_telemetry_report and formats report after running MCP tools", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-mcp-telemetry-"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(tmpDir, { recursive: true, force: true })
        })
      )

      yield* executeToolEffect(
        "harness_ontology_why",
        { symbolOrSpan: "PhotoRepo" },
        { repoRoot: tmpDir, graph }
      )

      yield* executeToolEffect(
        "harness_gq_query",
        { queryName: "ontology_layer_nodes", params: { layer: "Business" } },
        { repoRoot: tmpDir, graph }
      )

      const raw = yield* executeToolEffect(
        "harness_telemetry_report",
        { format: "markdown" },
        { repoRoot: tmpDir, graph }
      )

      const res = raw as {
        readonly markdown: string
        readonly report: {
          readonly totalEvents: number
          readonly kpis: { readonly graphDiscoveryCalls: number }
        }
      }

      expect(typeof res.markdown).toBe("string")
      expect(res.markdown).toContain("# Harness Session Observability Report")
      expect(res.markdown).toContain("Key Performance Indicators")
      expect(res.report.totalEvents).toBe(2)
      expect(res.report.kpis.graphDiscoveryCalls).toBe(2)
    })
  )

  it.effect("executes harness_lsp_diagnostics and records gate telemetry", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-mcp-lsp-"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(tmpDir, { recursive: true, force: true })
        })
      )

      const rawClean = yield* executeToolEffect(
        "harness_lsp_diagnostics",
        { file: "libs/sample/domain/src/index.ts" },
        {
          repoRoot: tmpDir,
          lspDiagnosticsRunner: () => ({
            clean: true,
            diagnostics: [],
            summary: {
              filesChecked: 1,
              filesWithoutPlugin: 0,
              totalFiles: 1,
              errors: 0,
              warnings: 0,
              messages: 0
            }
          })
        }
      )

      const cleanRes = rawClean as {
        readonly clean: boolean
        readonly summary: { readonly filesChecked: number; readonly errors: number }
      }
      expect(cleanRes.clean).toBe(true)
      expect(cleanRes.summary.filesChecked).toBe(1)
      expect(cleanRes.summary.errors).toBe(0)
    })
  )
})

