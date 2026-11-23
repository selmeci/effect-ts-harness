import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  DocLineNumber,
  DocTreePath,
  EarsAreaName,
  EarsClauseText,
  EarsEffectSymbol,
  EarsPatternName,
  EarsRequirementNodeId,
  EarsVerificationKind,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingProviderBaseUrl,
  EmbeddingProviderError,
  ErrorReasonMessage,
  GovernanceDocIdentifier,
  RequirementId,
} from "@harness/contract"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { readTelemetryEvents } from "@harness/gates"
import { buildHarnessGraph, resolveOmnigraphClusterDir } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { EmbeddingCachePort, EmbeddingClient } from "@harness/service"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  ensureLocalOmnigraphReady,
  isSafeOmnigraphPidToKill,
} from "../src/commands/omnigraph-lifecycle.js"
import {
  computeSyncEmbeddingsForGraph,
  toSyncEmbeddingOptions,
} from "../src/commands/omnigraph-embedding-sync-helper.js"
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

  it.effect(
    "marks ontology check degraded and exits 1 when decisionLayer fails under --strict",
    () =>
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

  it.effect(
    "rejects vim omnigraph.md and omnigraph without --cluster in isSafeOmnigraphPidToKill",
    () =>
      Effect.sync(() => {
        const makeFakeHostIo = (argv: ReadonlyArray<string>): SyncHostIo => ({
          ...nodeSyncHostIo,
          existsSync: (filePath) => filePath.endsWith("/cmdline"),
          readTextSync: () => argv.join("\0"),
        })

        expect(
          isSafeOmnigraphPidToKill(4242, "/tmp/cluster-a", makeFakeHostIo(["vim", "omnigraph.md"])),
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

  it.live(
    "returns false on drift teardown rmRecursiveSync failure without calling old server or refreshing stamp",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-drift-fail-"))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmSync(tmpDir, { recursive: true, force: true })
          }),
        )
        mkdirSync(join(tmpDir, "libs", "harness", "graph"), { recursive: true })
        writeFileSync(
          join(tmpDir, "libs", "harness", "graph", "cluster.yaml"),
          "name: test\n",
          "utf8",
        )

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

  it.live(
    "syncOmnigraphOnDone fails closed when omnigraph server is not ready and records real durationMs",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-done-not-ready-"))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmSync(tmpDir, { recursive: true, force: true })
          }),
        )
        mkdirSync(join(tmpDir, "libs", "harness", "graph"), { recursive: true })
        writeFileSync(
          join(tmpDir, "libs", "harness", "graph", "cluster.yaml"),
          "name: test\n",
          "utf8",
        )

        const clusterDir = resolveOmnigraphClusterDir(tmpDir, nodeSyncHostIo)
        mkdirSync(clusterDir, { recursive: true })
        writeFileSync(join(clusterDir, ".config-stamp"), "stale", "utf8")

        const rmSpy = vi.spyOn(nodeSyncHostIo, "rmRecursiveSync").mockImplementation(() => {
          throw new Error("boom")
        })
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

        const result = yield* syncOmnigraphOnDone(
          tmpDir,
          { repoRoot: tmpDir },
          false,
          "block",
        ).pipe(
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

  const makeSemanticCheckTestFixtures = (tmpDir: string) => {
    mkdirSync(join(tmpDir, "libs/sample/docs/specs"), { recursive: true })
    writeFileSync(
      join(tmpDir, "libs/sample/docs/specs/0001.md"),
      `---\nid: sample:SPEC-0001\ntitle: Spec One\nstatus: accepted\n---\n`,
      "utf8",
    )
    writeFileSync(
      join(tmpDir, "libs/sample/docs/specs/0002.md"),
      `---\nid: sample:SPEC-0002\ntitle: Spec Two\nstatus: accepted\n---\n`,
      "utf8",
    )

    const crossSpecGraph = buildHarnessGraph({
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
      providesService: [{ layerQualname: "PhotoRepoLive", tagId: "PhotoRepo" }],
      specifiesSymbols: [
        { specId: "sample:SPEC-0001", targetKey: "PhotoRepo", targetKind: "ServiceTag" },
        { specId: "sample:SPEC-0002", targetKey: "PhotoRepo", targetKind: "ServiceTag" },
      ],
      earsSpecs: [
        {
          id: "sample:SPEC-0001",
          title: "Spec One",
          status: "accepted",
          path: "libs/sample/docs/specs/0001.md",
          enforcedByFiles: [],
          referencedServices: ["PhotoRepo"],
        },
        {
          id: "sample:SPEC-0002",
          title: "Spec Two",
          status: "accepted",
          path: "libs/sample/docs/specs/0002.md",
          enforcedByFiles: [],
          referencedServices: ["PhotoRepo"],
        },
      ],
      earsRequirements: [
        {
          id: EarsRequirementNodeId.make("sample:SPEC-0001::REQ-1.1"),
          specId: GovernanceDocIdentifier.make("sample:SPEC-0001"),
          requirementId: RequirementId.make("REQ-1.1"),
          area: EarsAreaName.make("Core"),
          pattern: EarsPatternName.make("Event-driven"),
          clauseText: EarsClauseText.make("When image arrives, approve upload."),
          effectSymbol: EarsEffectSymbol.make("Sample.a"),
          verification: EarsVerificationKind.make("UnitTest"),
          path: DocTreePath.make("libs/sample/docs/specs/0001.md"),
          line: DocLineNumber.make(10),
          status: "accepted",
        },
        {
          id: EarsRequirementNodeId.make("sample:SPEC-0002::REQ-2.1"),
          specId: GovernanceDocIdentifier.make("sample:SPEC-0002"),
          requirementId: RequirementId.make("REQ-2.1"),
          area: EarsAreaName.make("Core"),
          pattern: EarsPatternName.make("Event-driven"),
          clauseText: EarsClauseText.make("When image arrives, reject upload."),
          effectSymbol: EarsEffectSymbol.make("Sample.b"),
          verification: EarsVerificationKind.make("UnitTest"),
          path: DocTreePath.make("libs/sample/docs/specs/0002.md"),
          line: DocLineNumber.make(10),
          status: "accepted",
        },
      ],
    })

    const offlineClientLayer = Layer.succeed(
      EmbeddingClient,
      EmbeddingClient.of({
        config: {
          baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:1/v1"),
          model: EmbeddingModelId.make("qwen3-embedding:8b"),
          dimensions: EmbeddingDimensionCount.make(3),
        },
        checkAvailability: Effect.succeed({
          _tag: "Unavailable" as const,
          cause: "network-error" as const,
          reason: ErrorReasonMessage.make("Ollama offline"),
        }),
        embedBatch: () =>
          Effect.fail(
            new EmbeddingProviderError({
              model: EmbeddingModelId.make("qwen3-embedding:8b"),
              reason: ErrorReasonMessage.make("Offline"),
            }),
          ),
        embedQuery: () =>
          Effect.fail(
            new EmbeddingProviderError({
              model: EmbeddingModelId.make("qwen3-embedding:8b"),
              reason: ErrorReasonMessage.make("Offline"),
            }),
          ),
      }),
    )
    const emptyCacheLayer = Layer.succeed(
      EmbeddingCachePort,
      EmbeddingCachePort.of({
        readCache: () => Effect.succeedNone,
        writeCache: () => Effect.void,
      }),
    )
    return { crossSpecGraph, offlineClientLayer, emptyCacheLayer }
  }

  it.effect(
    "ontology check --strict fails closed when semantic conflict embeddings degrade on cross-spec requirements, while --deterministic bypasses it",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-sem-degrade-"))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmSync(tmpDir, { recursive: true, force: true })
          }),
        )
        const { crossSpecGraph, offlineClientLayer, emptyCacheLayer } =
          makeSemanticCheckTestFixtures(tmpDir)

        const strictRes = yield* runCliEffect(["ontology", "check", "--scope=sample", "--strict"], {
          repoRoot: tmpDir,
          implGraph: crossSpecGraph,
          decisionLayer: makeMockDecisionModelLayer(),
          embeddingClientLayer: offlineClientLayer,
          embeddingCacheLayer: emptyCacheLayer,
          governanceDocs: [
            {
              id: "sample:SPEC-0001",
              status: "accepted",
              docPath: "libs/sample/docs/specs/0001.md",
            },
            {
              id: "sample:SPEC-0002",
              status: "accepted",
              docPath: "libs/sample/docs/specs/0002.md",
            },
          ],
        })
        expect(strictRes.exitCode).toBe(1)
        const strictReport = decodeCheckOutput(strictRes.stdout)
        expect(strictReport.clean).toBe(false)
        expect(strictReport.degraded).toBe(true)
        expect(strictReport.evaluationError).toContain("Ollama offline")

        const detRes = yield* runCliEffect(
          ["ontology", "check", "--scope=sample", "--deterministic", "--strict"],
          {
            repoRoot: tmpDir,
            implGraph: crossSpecGraph,
            embeddingClientLayer: offlineClientLayer,
            embeddingCacheLayer: emptyCacheLayer,
            governanceDocs: [
              {
                id: "sample:SPEC-0001",
                status: "accepted",
                docPath: "libs/sample/docs/specs/0001.md",
              },
              {
                id: "sample:SPEC-0002",
                status: "accepted",
                docPath: "libs/sample/docs/specs/0002.md",
              },
            ],
          },
        )
        expect(detRes.exitCode).toBe(0)
        const detReport = decodeCheckOutput(detRes.stdout)
        expect(detReport.clean).toBe(true)
        expect(detReport.semanticSkipped).toBe(true)
      }),
  )

  it.effect(
    "computeSyncEmbeddingsForGraph & toSyncEmbeddingOptions preserve Ready / Degraded / Skipped semantics",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-cli-embed-sync-"))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmSync(tmpDir, { recursive: true, force: true })
          }),
        )
        const { crossSpecGraph, offlineClientLayer, emptyCacheLayer } =
          makeSemanticCheckTestFixtures(tmpDir)

        const skipped = yield* computeSyncEmbeddingsForGraph(tmpDir, crossSpecGraph, {
          skipBackgroundDaemons: true,
        })
        expect(skipped._tag).toBe("Skipped")
        expect(toSyncEmbeddingOptions(skipped)).toEqual({})

        const stderrMessages: Array<string> = []
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
          stderrMessages.push(String(chunk))
          return true
        })
        const degraded = yield* computeSyncEmbeddingsForGraph(tmpDir, crossSpecGraph, {
          embeddingClientLayer: offlineClientLayer,
          embeddingCacheLayer: emptyCacheLayer,
        }).pipe(Effect.ensuring(Effect.sync(() => stderrSpy.mockRestore())))
        expect(degraded._tag).toBe("Degraded")
        expect(stderrMessages.join("")).toContain("Degraded to bm25-only")
        expect(toSyncEmbeddingOptions(degraded)).toEqual({})
        expect(
          toSyncEmbeddingOptions({
            _tag: "Degraded",
            vectorsByNodeKey: new Map([["PatternDoc:a", [1, 0, 0]]]),
            reason: ErrorReasonMessage.make("partial"),
          }),
        ).toEqual({
          embeddingsByNodeKey: new Map([["PatternDoc:a", [1, 0, 0]]]),
          clearMissingEmbeddings: false,
        })
        expect(
          toSyncEmbeddingOptions({
            _tag: "Ready",
            vectorsByNodeKey: new Map([["PatternDoc:a", [1, 0, 0]]]),
          }),
        ).toEqual({
          embeddingsByNodeKey: new Map([["PatternDoc:a", [1, 0, 0]]]),
          clearMissingEmbeddings: true,
        })
      }),
  )
})
