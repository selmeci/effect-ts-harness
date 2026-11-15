import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { readTelemetryEvents } from "@harness/gates"
import { buildHarnessGraph, resolveOmnigraphClusterDir } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  ensureLocalOmnigraphReady,
  isSafeOmnigraphPidToKill,
} from "../src/commands/omnigraph-lifecycle.js"
import { syncOmnigraphOnDone } from "../src/commands/done-omnigraph-helpers.js"
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
    semanticSkipped: Schema.optional(Schema.Boolean),
    degraded: Schema.optional(Schema.Boolean),
    evaluationError: Schema.optional(Schema.String),
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

  it.effect("marks ontology check degraded and exits 1 when decisionLayer fails under --strict", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-ontology-degraded-"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(tmpDir, { recursive: true, force: true })
        }),
      )
      mkdirSync(join(tmpDir, "libs/sample/docs/specs"), { recursive: true })
      writeFileSync(
        join(tmpDir, "libs/sample/docs/specs/0001.md"),
        `---
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
        "utf8",
      )

      const failingLayer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () => Effect.die("LLM timeout"),
        }),
      )

      const res = yield* runCliEffect(["ontology", "check", "--scope=sample", "--strict"], {
        repoRoot: tmpDir,
        implGraph,
        decisionLayer: failingLayer,
      })
      expect(res.exitCode).toBe(1)
      const report = decodeCheckOutput(res.stdout)
      expect(report.clean).toBe(false)
      expect(report.degraded).toBe(true)
      expect(report.evaluationError).toContain("DecisionModel")
    }),
  )

  it.effect("supports --deterministic flag on ontology check without invoking decisionLayer", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-ontology-det-"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(tmpDir, { recursive: true, force: true })
        }),
      )

      const res = yield* runCliEffect(["ontology", "check", "--scope=sample", "--deterministic"], {
        repoRoot: tmpDir,
        implGraph,
      })
      expect(res.exitCode).toBe(0)
      const report = decodeCheckOutput(res.stdout)
      expect(report.clean).toBe(true)
      expect(report.degraded).toBe(false)
      expect(report.semanticSkipped).toBe(true)
      expect(report.evaluatedPairs).toBe(0)
    }),
  )

  it.effect("rejects vim omnigraph.md and omnigraph without --cluster in isSafeOmnigraphPidToKill", () =>
    Effect.sync(() => {
      const makeFakeHostIo = (argv: ReadonlyArray<string>): SyncHostIo => ({
        ...nodeSyncHostIo,
        existsSync: (filePath) => filePath.endsWith("/cmdline"),
        readTextSync: () => argv.join("\0"),
      })

      expect(
        isSafeOmnigraphPidToKill(
          4242,
          "/tmp/cluster-a",
          makeFakeHostIo(["vim", "omnigraph.md"]),
        ),
      ).toBe(false)
      expect(
        isSafeOmnigraphPidToKill(
          4242,
          "/tmp/cluster-a",
          makeFakeHostIo(["/home/u/.local/bin/omnigraph", "serve"]),
        ),
      ).toBe(false)
      expect(
        isSafeOmnigraphPidToKill(
          4242,
          "/tmp/cluster-a",
          makeFakeHostIo([
            "/home/u/.local/bin/omnigraph-server",
            "--cluster",
            "file:///tmp/cluster-b",
          ]),
        ),
      ).toBe(false)
      expect(
        isSafeOmnigraphPidToKill(
          4242,
          "/tmp/cluster-a",
          makeFakeHostIo([
            "/home/u/.local/bin/omnigraph-server",
            "--cluster",
            "file:///tmp/cluster-a",
            "--bind",
            "127.0.0.1:8080",
          ]),
        ),
      ).toBe(true)
    }),
  )

  it.live("returns false on drift teardown rmRecursiveSync failure without calling old server or refreshing stamp", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-drift-fail-"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(tmpDir, { recursive: true, force: true })
        }),
      )
      mkdirSync(join(tmpDir, "libs", "harness", "graph"), { recursive: true })
      writeFileSync(join(tmpDir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n", "utf8")

      const clusterDir = resolveOmnigraphClusterDir(tmpDir, nodeSyncHostIo)
      mkdirSync(clusterDir, { recursive: true })
      writeFileSync(join(clusterDir, ".config-stamp"), "stale-stamp", "utf8")

      const fetchSpy = vi.spyOn(globalThis, "fetch")
      const rmSpy = vi.spyOn(nodeSyncHostIo, "rmRecursiveSync").mockImplementation(() => {
        throw new Error("EACCES: permission denied")
      })
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

      const ready = yield* ensureLocalOmnigraphReady(tmpDir).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            fetchSpy.mockRestore()
            rmSpy.mockRestore()
            stderrSpy.mockRestore()
          }),
        ),
      )

      expect(ready).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(readFileSync(join(clusterDir, ".config-stamp"), "utf8")).toBe("stale-stamp")
    }),
  )

  it.live("syncOmnigraphOnDone fails closed when omnigraph server is not ready and records real durationMs", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-done-not-ready-"))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmSync(tmpDir, { recursive: true, force: true })
        }),
      )
      mkdirSync(join(tmpDir, "libs", "harness", "graph"), { recursive: true })
      writeFileSync(join(tmpDir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n", "utf8")

      const clusterDir = resolveOmnigraphClusterDir(tmpDir, nodeSyncHostIo)
      mkdirSync(clusterDir, { recursive: true })
      writeFileSync(join(clusterDir, ".config-stamp"), "stale", "utf8")

      const rmSpy = vi.spyOn(nodeSyncHostIo, "rmRecursiveSync").mockImplementation(() => {
        throw new Error("boom")
      })
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

      const result = yield* syncOmnigraphOnDone(tmpDir, { repoRoot: tmpDir }, false, "block").pipe(
        Effect.ensuring(
          Effect.sync(() => {
            rmSpy.mockRestore()
            stderrSpy.mockRestore()
          }),
        ),
      )

      expect(result).toBeDefined()
      expect(result?.stdout).toContain("Omnigraph server is not ready")
      const telemetryLines = readTelemetryEvents(tmpDir, nodeSyncHostIo)
      const last = telemetryLines[telemetryLines.length - 1]
      expect(last?.outcome).toBe("fail")
      expect(last?.engineSource).toBe("omnigraph")
      expect(last?.detail).toBe("omnigraph-server-not-ready")
      expect(typeof last?.durationMs).toBe("number")
      expect(last?.durationMs).toBeGreaterThanOrEqual(0)
    }),
  )
})
