import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { readTelemetryEvents } from "@harness/gates"
import { buildHarnessGraph, saveGraphSnapshot } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { executeToolEffect } from "../src/server.js"
import { shouldSuppressLiveMcpTestSideEffects } from "../src/tools/mcp-helpers.js"

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

  const WhyTraceSchema = Schema.Struct({
    justified: Schema.Boolean,
    governingAdrs: Schema.Array(
      Schema.Struct({
        id: Schema.String,
      }),
    ),
    realizingSpecs: Schema.Array(
      Schema.Struct({
        id: Schema.String,
      }),
    ),
  })
  const decodeWhyTrace = Schema.decodeUnknownSync(WhyTraceSchema)

  const ImpactSchema = Schema.Struct({
    target: Schema.NullOr(
      Schema.Struct({
        key: Schema.String,
        layer: Schema.String,
      }),
    ),
    affectedSpecs: Schema.Array(Schema.String),
    affectedAdrs: Schema.Array(Schema.String),
  })
  const decodeImpact = Schema.decodeUnknownSync(ImpactSchema)

  const CheckResultSchema = Schema.Struct({
    clean: Schema.Boolean,
    findings: Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        nodeId: Schema.String,
        message: Schema.String,
      }),
    ),
    semanticConflicts: Schema.Array(
      Schema.Struct({
        sourceId: Schema.String,
        targetId: Schema.String,
        hasConflict: Schema.Boolean,
        conflictKind: Schema.String,
      }),
    ),
    evaluatedPairs: Schema.Finite,
    degraded: Schema.optional(Schema.Boolean),
    degradedReason: Schema.optional(Schema.String),
    evaluationError: Schema.optional(Schema.String),
    layerCounts: Schema.Struct({
      Motivation: Schema.Finite,
      Business: Schema.Finite,
      Application: Schema.Finite,
      Technology: Schema.Finite,
      Implementation: Schema.Finite,
    }),
  })
  const decodeCheckResult = Schema.decodeUnknownSync(CheckResultSchema)

  it.effect("executes harness_ontology_why to trace upward to Motivation", () =>
    Effect.gen(function* () {
      const raw = yield* executeToolEffect(
        "harness_ontology_why",
        { symbolOrSpan: "PhotoRepoLive" },
        { graph },
      )
      const res = decodeWhyTrace(raw)
      expect(res.justified).toBe(true)
      expect(res.governingAdrs.some((a) => a.id === "sample:ADR-0001")).toBe(true)
      expect(res.realizingSpecs.some((s) => s.id === "sample:SPEC-0001")).toBe(true)
    }),
  )

  it.effect("executes harness_ontology_impact to analyze cross-layer impact", () =>
    Effect.gen(function* () {
      const raw = yield* executeToolEffect(
        "harness_ontology_impact",
        { symbolOrSpan: "PhotoRepo" },
        { graph },
      )
      const res = decodeImpact(raw)
      expect(res.target).not.toBeNull()
      expect(res.target?.key).toBe("PhotoRepo")
      expect(res.affectedSpecs).toContain("sample:SPEC-0001")
      expect(res.affectedAdrs).toContain("sample:ADR-0001")
    }),
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
`,
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
`,
        },
      ]

      const raw = yield* executeToolEffect(
        "harness_ontology_check",
        { scope: "sample" },
        {
          graph,
          governanceDocs: cleanDocs,
          decisionLayer: makeMockDecisionModelLayer(),
        },
      )

      const res = decodeCheckResult(raw)
      expect(res.clean).toBe(true)
      expect(res.findings.length).toBe(0)
      expect(res.semanticConflicts.length).toBe(0)
      expect(res.layerCounts.Motivation).toBe(2)
      expect(res.layerCounts.Application).toBe(1)
      expect(res.layerCounts.Technology).toBe(1)
    }),
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
`,
        },
      ]

      const conflictLayer = makeMockDecisionModelLayer({
        contradictsProb: 0.95,
        conflictKindLabel: "state-transition-conflict",
      })

      const raw = yield* executeToolEffect(
        "harness_ontology_check",
        { scope: "sample" },
        {
          graph,
          governanceDocs: conflictingDocs,
          decisionLayer: conflictLayer,
        },
      )

      const res = decodeCheckResult(raw)
      expect(res.clean).toBe(false)
      expect(res.semanticConflicts.length).toBeGreaterThan(0)
      const conflict = res.semanticConflicts[0]
      expect(conflict?.hasConflict).toBe(true)
      expect(conflict?.conflictKind).toBe("state-transition-conflict")
      expect(conflict?.sourceId).toBe("sample:SPEC-0001#REQ-1.1")
      expect(conflict?.targetId).toBe("sample:SPEC-0001#REQ-1.2")
    }),
  )

  it.effect("executes harness_gq_query for ontology_layer_nodes", () =>
    Effect.gen(function* () {
      const raw = yield* executeToolEffect(
        "harness_gq_query",
        { queryName: "ontology_layer_nodes", params: { layer: "Application" } },
        { graph, skipOmnigraphSpawn: true },
      )
      const res = raw as {
        readonly source: string
        readonly rows: ReadonlyArray<Record<string, unknown>>
      }
      expect(["omnigraph", "memory-fallback"]).toContain(res.source)
      expect(res.rows.length).toBeGreaterThan(0)
    }),
  )

  it.effect("executes harness_telemetry_report and formats report after running MCP tools", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-mcp-telemetry-"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(tmpDir, { recursive: true, force: true })
        }),
      )

      yield* executeToolEffect(
        "harness_ontology_why",
        { symbolOrSpan: "PhotoRepo" },
        { repoRoot: tmpDir, graph, skipOmnigraphSpawn: true },
      )

      yield* executeToolEffect(
        "harness_gq_query",
        { queryName: "ontology_layer_nodes", params: { layer: "Business" } },
        { repoRoot: tmpDir, graph, skipOmnigraphSpawn: true },
      )

      const raw = yield* executeToolEffect(
        "harness_telemetry_report",
        { format: "markdown" },
        { repoRoot: tmpDir, graph },
      )

      const res = raw as {
        readonly markdown: string
        readonly resolvedRepoRoot: string
        readonly report: {
          readonly totalEvents: number
          readonly kpis: { readonly graphDiscoveryCalls: number }
        }
      }

      expect(typeof res.markdown).toBe("string")
      expect(res.resolvedRepoRoot).toBe(tmpDir)
      expect(res.markdown).toContain("# Harness Session Observability Report")
      expect(res.markdown).toContain("Key Performance Indicators")
      expect(res.report.totalEvents).toBe(2)
      expect(res.report.kpis.graphDiscoveryCalls).toBe(2)

      const rawJson = (yield* executeToolEffect(
        "harness_telemetry_report",
        { format: "json" },
        { repoRoot: tmpDir, graph },
      )) as { readonly resolvedRepoRoot: string; readonly totalEvents: number }
      expect(rawJson.resolvedRepoRoot).toBe(tmpDir)
      expect(rawJson.totalEvents).toBe(3)
    }),
  )

  it.effect("executes harness_lsp_diagnostics and records gate telemetry", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-mcp-lsp-"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(tmpDir, { recursive: true, force: true })
        }),
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
              messages: 0,
            },
          }),
        },
      )

      const cleanRes = rawClean as {
        readonly clean: boolean
        readonly summary: { readonly filesChecked: number; readonly errors: number }
      }
      expect(cleanRes.clean).toBe(true)
      expect(cleanRes.summary.filesChecked).toBe(1)
      expect(cleanRes.summary.errors).toBe(0)

      yield* executeToolEffect(
        "harness_lsp_diagnostics",
        { file: "libs/sample/domain/src/index.ts" },
        {
          repoRoot: tmpDir,
          lspDiagnosticsRunner: () => ({
            clean: false,
            diagnostics: [{ message: "type mismatch" }],
            summary: {
              filesChecked: 1,
              filesWithoutPlugin: 0,
              totalFiles: 1,
              errors: 2,
              warnings: 1,
              messages: 3,
            },
          }),
        },
      )

      const events = readTelemetryEvents(tmpDir, nodeSyncHostIo)
      const diagEvent = events.find(
        (e) => e.toolName === "harness_lsp_diagnostics" && e.outcome === "diagnostics_found",
      )
      expect(diagEvent?.detail).toBe("errors=2;warnings=1")

      const repoRoot = join(import.meta.dirname, "../../..")
      expect(shouldSuppressLiveMcpTestSideEffects(repoRoot, { VITEST: "true" })).toBe(true)
      expect(
        shouldSuppressLiveMcpTestSideEffects(join(repoRoot, "apps", "harness-mcp"), {
          NODE_ENV: "test",
        }),
      ).toBe(true)
      expect(shouldSuppressLiveMcpTestSideEffects(tmpDir, { VITEST: "true" })).toBe(false)
      expect(
        shouldSuppressLiveMcpTestSideEffects(repoRoot, {
          VITEST: "true",
          HARNESS_STATE_DIR: "/tmp/custom-mcp-state",
        }),
      ).toBe(false)
    }),
  )

  it.effect("marks harness_ontology_check degraded and non-clean when decisionLayer fails", () =>
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
`,
        },
      ]

      const failingLayer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () => Effect.die("LLM timeout"),
        }),
      )

      const raw = yield* executeToolEffect(
        "harness_ontology_check",
        { scope: "sample" },
        {
          graph,
          governanceDocs: conflictingDocs,
          decisionLayer: failingLayer,
        },
      )

      const res = decodeCheckResult(raw)
      expect(res.clean).toBe(false)
      expect(res.degraded).toBe(true)
      expect(res.evaluationError).toContain("DecisionModel")
    }),
  )

  it.effect(
    "marks harness_ontology_check degraded and non-clean when graph snapshot is corrupt",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-mcp-corrupt-graph-"))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmSync(tmpDir, { recursive: true, force: true })
          }),
        )
        mkdirSync(join(tmpDir, ".harness"), { recursive: true })
        writeFileSync(join(tmpDir, ".harness", "graph-snapshot.json"), "{not valid json", "utf8")

        const raw = yield* executeToolEffect(
          "harness_ontology_check",
          { scope: "sample" },
          {
            repoRoot: tmpDir,
            governanceDocs: [],
            decisionLayer: makeMockDecisionModelLayer(),
          },
        )

        const res = decodeCheckResult(raw)
        expect(res.clean).toBe(false)
        expect(res.degraded).toBe(true)
        expect(typeof res.evaluationError).toBe("string")
      }),
  )

  it.effect(
    "marks harness_ontology_check degraded and non-clean when graph snapshot is missing",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-mcp-missing-graph-"))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmSync(tmpDir, { recursive: true, force: true })
          }),
        )

        const raw = yield* executeToolEffect(
          "harness_ontology_check",
          { scope: "sample" },
          {
            repoRoot: tmpDir,
            governanceDocs: [],
            decisionLayer: makeMockDecisionModelLayer(),
          },
        )

        const res = decodeCheckResult(raw)
        expect(res.clean).toBe(false)
        expect(res.degraded).toBe(true)
        expect(res.degradedReason).toBe("missing-graph-snapshot")
      }),
  )

  it.effect(
    "marks harness_ontology_check degraded when recorded graph-head.json exists but git HEAD is unavailable",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-mcp-no-git-head-"))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmSync(tmpDir, { recursive: true, force: true })
          }),
        )
        mkdirSync(join(tmpDir, ".harness"), { recursive: true })
        saveGraphSnapshot(graph, join(tmpDir, ".harness", "graph-snapshot.json"), nodeSyncHostIo)
        writeFileSync(
          join(tmpDir, ".harness", "graph-head.json"),
          JSON.stringify({
            headSha: "deadbeef",
            gitBranch: "main",
            updatedAt: "2026-01-01T00:00:00Z",
          }),
          "utf8",
        )

        const raw = yield* executeToolEffect(
          "harness_ontology_check",
          { scope: "sample" },
          {
            repoRoot: tmpDir,
            governanceDocs: [],
            decisionLayer: makeMockDecisionModelLayer(),
          },
        )

        const res = decodeCheckResult(raw)
        expect(res.clean).toBe(false)
        expect(res.degraded).toBe(true)
        expect(res.degradedReason).toBe("git-head-unavailable")
      }),
  )

  it.effect(
    "F-8.1: harness_ontology_why and harness_ontology_impact surface degraded: true on missing snapshot",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-mcp-ontology-degraded-"))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmSync(tmpDir, { recursive: true, force: true })
          }),
        )

        const whyRes = (yield* executeToolEffect(
          "harness_ontology_why",
          { symbolOrSpan: "PhotoRepo", repoRoot: tmpDir },
          { repoRoot: tmpDir },
        )) as { readonly degraded: boolean; readonly degradedReason?: string }
        expect(whyRes.degraded).toBe(true)
        expect(whyRes.degradedReason).toBe("missing-graph-snapshot")

        const impactRes = (yield* executeToolEffect(
          "harness_ontology_impact",
          { symbolOrSpan: "PhotoRepo", repoRoot: tmpDir },
          { repoRoot: tmpDir },
        )) as { readonly degraded: boolean; readonly degradedReason?: string }
        expect(impactRes.degraded).toBe(true)
        expect(impactRes.degradedReason).toBe("missing-graph-snapshot")
      }),
  )

  it.effect(
    "fails closed with degradedReason=unreadable-governance-docs when governance doc cannot be read",
    () =>
      Effect.gen(function* () {
        if (typeof process.getuid === "function" && process.getuid() === 0) return
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-mcp-unreadable-doc-"))
        const adrDir = join(tmpDir, "docs", "adr")
        const adrPath = join(adrDir, "ADR-0001.md")
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (existsSync(adrPath)) chmodSync(adrPath, 0o644)
            rmSync(tmpDir, { recursive: true, force: true })
          }),
        )
        mkdirSync(adrDir, { recursive: true })
        writeFileSync(adrPath, "# ADR-0001\n", "utf8")
        chmodSync(adrPath, 0o000)

        const raw = yield* executeToolEffect(
          "harness_ontology_check",
          { repoRoot: tmpDir },
          {
            repoRoot: tmpDir,
            graph,
            decisionLayer: makeMockDecisionModelLayer(),
          },
        )
        const res = decodeCheckResult(raw)
        expect(res.clean).toBe(false)
        expect(res.degraded).toBe(true)
        expect(res.degradedReason).toBe("unreadable-governance-docs")
        expect(res.evaluationError).toContain("Unreadable governance docs:")
        expect(res.findings.some((f) => f.kind === "unreadable-workspace-file")).toBe(true)
      }),
  )
})
