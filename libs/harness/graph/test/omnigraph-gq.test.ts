import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import type { FetchLike } from "@modernrelay/omnigraph"
import { Effect } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  executeNamedGqQueryInMemory,
  HARNESS_GQ_QUERIES,
  HARNESS_GQ_QUERY_NAMES,
  invokeOmnigraphNamedQuery,
  OmnigraphLoadError,
  RelationId,
  toOmnigraphServerNdjsonResult,
} from "../src/index.js"
import {
  DocLineNumber,
  DocTreePath,
  EarsAreaName,
  EarsClauseText,
  EarsEffectSymbol,
  EarsPatternName,
  EarsRequirementNodeId,
  EarsVerificationKind,
  GovernanceDocIdentifier,
  RequirementId,
} from "@harness/contract"
import { OmnigraphSyncLive } from "./helpers/omnigraph-gq-fixture.js"

describe("Omnigraph 0.14.0 schema.pg and queries/harness.gq", () => {
  const graphDir = path.resolve(import.meta.dirname, "..")
  const schemaPath = path.join(graphDir, "schema.pg")
  const queriesPath = path.join(graphDir, "queries/harness.gq")

  it.effect(
    "declares all PERA EntityNode, RelationNode, and Plays*Role edge types in schema.pg",
    () =>
      Effect.gen(function* () {
        yield* Effect.void
        const schema = fs.readFileSync(schemaPath, "utf8")

        const expectedNodes = [
          "node EffectFn",
          "node ServiceTag",
          "node ServiceLayer",
          "node TaggedError",
          "node SchemaDef",
          "node VitestCase",
          "node PatternDoc",
          "node AdrDoc",
          "node EarsSpec",
          "node EarsRequirement",
          "node EffectSignature",
          "node LayerFlow",
          "node TraceabilityTuple",
          "node HttpEndpointTuple",
          "node MigrationTuple",
          "node WorkflowRun",
          "node WorkUnit",
          "node UnitAttempt",
        ]
        for (const nodeDecl of expectedNodes) {
          expect(schema).toContain(nodeDecl)
        }
        expect(schema).not.toContain("node Any")

        expect(schema).toContain(
          "archimateLayer: enum(Motivation, Business, Application, Technology, Implementation)? @index",
        )
        expect(schema).toContain(
          "archimateAspect: enum(Motivation, Behavior, ActiveStructure, PassiveStructure)? @index",
        )
        expect(schema).toContain("archimateElementType: String? @index")
        expect(schema).toContain("isPropertyTest: Bool? @index")

        const expectedEdges = [
          "edge PlaysCallerRole: EffectSignature -> EffectFn",
          "edge PlaysCalleeRole: EffectSignature -> EffectFn",
          "edge PlaysRequiresServiceRole: EffectSignature -> ServiceTag",
          "edge PlaysFailsWithRole: EffectSignature -> TaggedError",
          "edge PlaysProviderLayerRole: LayerFlow -> ServiceLayer",
          "edge PlaysProvidedServiceRole: LayerFlow -> ServiceTag",
          "edge PlaysRequiredServiceRole: LayerFlow -> ServiceTag",
          "edge PlaysGoverningAdrRole: TraceabilityTuple -> AdrDoc",
          "edge PlaysSpecifyingEarsRole: TraceabilityTuple -> EarsSpec",
          "edge PlaysSpecifiedRequirementRole: TraceabilityTuple -> EarsRequirement",
          "edge PlaysExercisingTestRole: TraceabilityTuple -> VitestCase",
          "edge PlaysExercisedSpanRole: TraceabilityTuple -> EffectFn",
          "edge PlaysRunUnitRole: WorkflowRun -> WorkUnit",
          "edge PlaysUnitAttemptRole: WorkUnit -> UnitAttempt",
          "edge PlaysUnitStubRole: WorkUnit -> EffectFn",
          "edge PlaysUnitEarsRole: WorkUnit -> EarsSpec",
          "edge PlaysUnitTraceabilityRole: WorkUnit -> TraceabilityTuple",
          "edge PlaysAttemptTestRole: UnitAttempt -> VitestCase",
        ]
        for (const edgeDecl of expectedEdges) {
          expect(schema).toContain(edgeDecl)
        }

        expect(schema).toContain("archimateRelation: String @index")
        expect(schema).toContain("node GraphPolicy")
        expect(schema).toContain("@instruction(")
        const vectorFields = [...schema.matchAll(/(\w+):\s*Vector\(4096\)\?\s*@embed\(/g)].map(
          (m) => m[1],
        )
        expect(vectorFields).toEqual(["summaryEmbedding", "searchEmbedding", "clauseEmbedding"])

        const edgeMatches = [...schema.matchAll(/edge\s+(Plays\w+Role):[\s\S]*?\{([\s\S]*?)\}/g)]
        expect(edgeMatches).toHaveLength(39)
        for (const [, edgeName, edgeBody] of edgeMatches) {
          expect(edgeBody, `${edgeName} must declare @key(@src, @dst, role)`).toContain(
            "@key(@src, @dst, role)",
          )
        }
      }),
  )

  it.effect("declares all 22 canonical GQ queries in queries/harness.gq", () => {
    return Effect.gen(function* () {
      yield* Effect.void
      const gqSource = fs.readFileSync(queriesPath, "utf8")
      expect(HARNESS_GQ_QUERY_NAMES).toHaveLength(22)

      for (const queryName of HARNESS_GQ_QUERY_NAMES) {
        expect(gqSource).toContain(`query ${queryName}`)
        expect(HARNESS_GQ_QUERIES[queryName]).toBeDefined()
        expect(HARNESS_GQ_QUERIES[queryName].name).toBe(queryName)
      }
    })
  })
})

describe("Deterministic in-memory GQ query execution and fallback", () => {
  const sampleGraph = buildHarnessGraph({
    fns: [
      {
        qualname: "libs/sample/domain/src/index.ts#greet",
        spanName: "Sample.greet",
        file: "libs/sample/domain/src/index.ts",
        line: 4,
        packageTag: "domain",
        successType: "string",
        isStub: false,
      },
      {
        qualname: "libs/sample/domain/src/index.ts#untested",
        spanName: "Sample.untested",
        file: "libs/sample/domain/src/index.ts",
        line: 10,
        packageTag: "domain",
        successType: "void",
        isStub: false,
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
        layerKind: "live",
        packageTag: "infra",
        file: "libs/sample/infra/src/index.ts",
      },
    ],
    errors: [
      {
        errorTag: "PhotoNotFound",
        file: "libs/sample/domain/src/errors.ts",
      },
    ],
    tests: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        testFile: "libs/sample/domain/test/index.test.ts",
        testName: "greets by name",
        lastTreeHash: "abc123",
      },
    ],
    patternDocs: [
      {
        slug: "planning",
        path: "agent-patterns/planning.md",
        summary: "Plan-as-Code markdown template with stub skeleton pattern.",
      },
    ],
    adrDocs: [
      {
        id: "sample:ADR-0001",
        title: "D1 persistence boundaries",
        status: "accepted",
        path: "docs/adr/0001.md",
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
        path: "docs/specs/0001.md",
        enforcedByFiles: [],
        referencedSpans: ["Sample.greet"],
        referencedServices: [],
        referencedErrors: [],
      },
    ],
    providesService: [
      {
        layerQualname: "PhotoRepoLive",
        tagId: "PhotoRepo",
      },
    ],
    exercisesSpans: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        calleeQualname: "libs/sample/domain/src/index.ts#greet",
        callCount: 1,
        receiverLayer: null,
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
        targetKey: "libs/sample/domain/src/index.ts#greet",
        targetKind: "EffectFn",
      },
    ],
  })

  it.effect("executes all 8 named GQ queries in memory deterministically", () =>
    Effect.gen(function* () {
      yield* Effect.void
      const fnRows = executeNamedGqQueryInMemory(sampleGraph, "resolve_effect_fn", {
        spanOrQualname: "Sample.greet",
      })
      expect(fnRows).toHaveLength(1)
      expect(fnRows[0]?.spanName).toBe("Sample.greet")
      expect(fnRows[0]?.archimateLayer).toBe("Business")

      const provRows = executeNamedGqQueryInMemory(sampleGraph, "find_service_providers", {
        tagId: "PhotoRepo",
      })
      expect(provRows).toHaveLength(1)
      expect(provRows[0]?.layerQualname).toBe("PhotoRepoLive")
      expect(provRows[0]?.tagId).toBe("PhotoRepo")

      const callerRows = executeNamedGqQueryInMemory(sampleGraph, "find_callers", {
        target: "PhotoRepo",
      })
      expect(callerRows.some((c) => c.qualname === "sample:ADR-0001")).toBe(true)

      const calleeRows = executeNamedGqQueryInMemory(sampleGraph, "find_callees", {
        caller: "sample:SPEC-0001",
      })
      expect(calleeRows.some((c) => c.qualname === "libs/sample/domain/src/index.ts#greet")).toBe(
        true,
      )

      const testRows = executeNamedGqQueryInMemory(sampleGraph, "find_tests_reaching", {
        callee: "Sample.greet",
      })
      expect(testRows).toHaveLength(1)
      expect(testRows[0]?.testId).toBe("libs/sample/domain/test/index.test.ts::greets by name")

      const layerRows = executeNamedGqQueryInMemory(sampleGraph, "ontology_layer_nodes", {
        layer: "Motivation",
      })
      expect(layerRows.length).toBeGreaterThanOrEqual(2)

      const whyRows = executeNamedGqQueryInMemory(sampleGraph, "ontology_governed_by", {
        symbol: "Sample.greet",
      })
      expect(whyRows.some((w) => w.id === "sample:SPEC-0001")).toBe(true)

      const untestedRows = executeNamedGqQueryInMemory(sampleGraph, "untested_domain_fns")
      expect(untestedRows).toHaveLength(1)
      expect(untestedRows[0]?.spanName).toBe("Sample.untested")

      const fuzzyRows = executeNamedGqQueryInMemory(sampleGraph, "resolve_effect_fn_fuzzy", {
        query: "Sample.gret",
      })
      expect(fuzzyRows.length).toBeGreaterThanOrEqual(1)
      expect(fuzzyRows[0]?.spanName).toBe("Sample.greet")

      const realizedRows = executeNamedGqQueryInMemory(sampleGraph, "ontology_realized_by_doc", {
        docId: "sample:ADR-0001",
      })
      expect(realizedRows).toHaveLength(1)
      expect(realizedRows[0]?.artifactQualname).toBe("ServiceTag:PhotoRepo")

      const patternRows = executeNamedGqQueryInMemory(sampleGraph, "rank_patterns_hybrid", {
        query: "stub",
        targetLayer: "*",
      })
      expect(patternRows).toHaveLength(1)
      expect(patternRows[0]?.slug).toBe("planning")

      const patternVecRows = executeNamedGqQueryInMemory(
        sampleGraph,
        "rank_patterns_vector_hybrid",
        {
          vectorQuery: [1, 0, 0, 0],
          textQuery: "skeleton",
          targetLayer: "*",
        },
      )
      expect(patternVecRows.map((r) => r["slug"])).toContain("planning")

      const patternBm25Rows = executeNamedGqQueryInMemory(sampleGraph, "rank_patterns_bm25", {
        query: "skeleton",
        targetLayer: "*",
      })
      expect(patternBm25Rows.map((r) => r["slug"])).toContain("planning")

      const blankPatternRows = executeNamedGqQueryInMemory(sampleGraph, "rank_patterns_bm25", {
        query: "   ",
        targetLayer: "*",
      })
      expect(blankPatternRows).toEqual([])

      const stopwordTrapRows = executeNamedGqQueryInMemory(sampleGraph, "rank_patterns_bm25", {
        query: "step",
        targetLayer: "*",
      })
      expect(stopwordTrapRows).toEqual([])

      const oneCharFuzzyRows = executeNamedGqQueryInMemory(sampleGraph, "resolve_effect_fn_fuzzy", {
        query: "a",
      })
      expect(oneCharFuzzyRows).toEqual([])

      const adrVecRows = executeNamedGqQueryInMemory(sampleGraph, "search_adrs_vector_hybrid", {
        vectorQuery: [1, 0, 0, 0],
        textQuery: "persistence",
        status: "accepted",
      })
      expect(adrVecRows.map((r) => r["id"])).toContain("sample:ADR-0001")

      const adrBm25Rows = executeNamedGqQueryInMemory(sampleGraph, "search_adrs_bm25", {
        query: "persistence",
        status: "*",
      })
      expect(adrBm25Rows.map((r) => r["id"])).toContain("sample:ADR-0001")
    }),
  )

  it.effect(
    "executes requirement retrieval and structural policy GQ queries in memory deterministically",
    () =>
      Effect.gen(function* () {
        yield* Effect.void
        const reqGraph = buildHarnessGraph({
          earsRequirements: [
            {
              id: EarsRequirementNodeId.make("sample:SPEC-0001::REQ-1.1"),
              specId: GovernanceDocIdentifier.make("sample:SPEC-0001"),
              requirementId: RequirementId.make("REQ-1.1"),
              area: EarsAreaName.make("Gallery"),
              pattern: EarsPatternName.make("Event-driven"),
              clauseText: EarsClauseText.make(
                "When uploading photos, system persists metadata deterministically.",
              ),
              effectSymbol: EarsEffectSymbol.make("Sample.greet"),
              verification: EarsVerificationKind.make("UnitTest"),
              path: DocTreePath.make("docs/specs/0001.md"),
              line: DocLineNumber.make(12),
              status: "accepted",
            },
          ],
        })
        const reqVecRows = executeNamedGqQueryInMemory(
          reqGraph,
          "search_requirements_vector_hybrid",
          {
            vectorQuery: [1, 0, 0, 0],
            textQuery: "uploading photos",
            status: "accepted",
          },
        )
        expect(reqVecRows.map((r) => r["id"])).toContain("sample:SPEC-0001::REQ-1.1")

        const reqBm25Rows = executeNamedGqQueryInMemory(reqGraph, "search_requirements_bm25", {
          query: "photos",
          status: "*",
        })
        expect(reqBm25Rows.map((r) => r["id"])).toContain("sample:SPEC-0001::REQ-1.1")

        const stubSvcRows = executeNamedGqQueryInMemory(
          sampleGraph,
          "rank_candidate_services_for_stub",
          {
            layer: "*",
            intent: "photo",
          },
        )
        expect(stubSvcRows).toHaveLength(1)
        expect(stubSvcRows[0]?.tagId).toBe("PhotoRepo")

        const policyUnverifiedRows = executeNamedGqQueryInMemory(
          sampleGraph,
          "policy_unverified_domain_fns",
        )
        expect(policyUnverifiedRows).toHaveLength(1)
        expect(policyUnverifiedRows[0]?.spanName).toBe("Sample.untested")

        const linkedSigGraph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/index.ts#linked",
              spanName: "Sample.linked",
              file: "libs/sample/domain/src/index.ts",
              line: 4,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
          ],
          services: [
            {
              tagId: "LinkedSvc",
              name: "LinkedSvc",
              packageTag: "service",
              file: "libs/sample/service/src/index.ts",
            },
          ],
          requiresService: [
            {
              fnQualname: "libs/sample/domain/src/index.ts#linked",
              tagId: "LinkedSvc",
            },
          ],
        })
        expect(
          Array.from(Graph.nodes(linkedSigGraph.graph)).some(
            ([, n]) => n._tag === "EffectSignature",
          ),
        ).toBe(true)
        expect(
          executeNamedGqQueryInMemory(linkedSigGraph, "policy_orphan_effect_signatures"),
        ).toEqual([])

        const baseOrphanGraph = buildHarnessGraph({ fns: [] })
        const graphWithOrphanSig = {
          ...baseOrphanGraph,
          graph: Graph.mutate(baseOrphanGraph.graph, (mutable) => {
            Graph.addNode(mutable, {
              _tag: "EffectSignature",
              relationId: RelationId.make("sig:orphan-1"),
              callerQualname: "libs/sample/domain/src/index.ts#missing",
              requiredServices: [],
              emittedErrors: [],
              calleeQualnames: [],
              payloadSchemas: [],
              file: "libs/sample/domain/src/index.ts",
              line: 1,
            })
          }),
        }
        const orphanSigRows = executeNamedGqQueryInMemory(
          graphWithOrphanSig,
          "policy_orphan_effect_signatures",
        )
        expect(orphanSigRows).toHaveLength(1)
        expect(orphanSigRows[0]?.relationId).toBe("sig:orphan-1")
      }),
  )

  it.effect(
    "emits null for missing embeddings when embeddingsByNodeKey is provided so merge clears stale vectors",
    () =>
      Effect.gen(function* () {
        yield* Effect.void
        const ndjsonRes = toOmnigraphServerNdjsonResult(
          sampleGraph,
          new Map([["AdrDoc:sample:ADR-0001", [0.25, 0.75]]]),
        )
        const ndjson = match(ndjsonRes)
          .with({ _tag: "Success" }, ({ success }) => success)
          .with({ _tag: "Failure" }, ({ failure }) => expect.unreachable(String(failure)))
          .exhaustive()
        const lines = ndjson
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map(
            (l) =>
              JSON.parse(l) as {
                readonly type: string
                readonly id: string
                readonly data: Record<string, unknown>
              },
          )
        const patternLine = lines.find((l) => l.type === "PatternDoc" && l.id === "planning")
        const adrLine = lines.find((l) => l.type === "AdrDoc" && l.id === "sample:ADR-0001")
        expect(patternLine?.data["summaryEmbedding"]).toBeNull()
        expect(adrLine?.data["searchEmbedding"]).toEqual([0.25, 0.75])

        const preserveRes = toOmnigraphServerNdjsonResult(
          sampleGraph,
          new Map([["AdrDoc:sample:ADR-0001", [0.25, 0.75]]]),
          { clearMissingEmbeddings: false },
        )
        const preserveNdjson = match(preserveRes)
          .with({ _tag: "Success" }, ({ success }) => success)
          .with({ _tag: "Failure" }, ({ failure }) => expect.unreachable(String(failure)))
          .exhaustive()
        const preserveLines = preserveNdjson
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map(
            (l) =>
              JSON.parse(l) as {
                readonly type: string
                readonly id: string
                readonly data: Record<string, unknown>
              },
          )
        const preservedPatternLine = preserveLines.find(
          (l) => l.type === "PatternDoc" && l.id === "planning",
        )
        const updatedAdrLine = preserveLines.find(
          (l) => l.type === "AdrDoc" && l.id === "sample:ADR-0001",
        )
        expect("summaryEmbedding" in (preservedPatternLine?.data ?? {})).toBe(false)
        expect(updatedAdrLine?.data["searchEmbedding"]).toEqual([0.25, 0.75])
      }),
  )

  it.effect("falls back to memory-fallback across all 22 queries when Omnigraph is offline", () =>
    Effect.gen(function* () {
      const offlineFetch: FetchLike = () =>
        Promise.resolve(
          new Response("Service Unavailable", {
            status: 503,
            headers: { "Omnigraph-Http-Api": "0.14" },
          }),
        )

      for (const queryName of HARNESS_GQ_QUERY_NAMES) {
        const res = yield* invokeOmnigraphNamedQuery({
          name: queryName,
          fetch: offlineFetch,
          fallbackGraph: sampleGraph,
          params: {
            spanOrQualname: "Sample.greet",
            tagId: "PhotoRepo",
            target: "PhotoRepo",
            caller: "sample:SPEC-0001",
            callee: "Sample.greet",
            layer: "Motivation",
            symbol: "Sample.greet",
            runId: "wf6-run-001",
          },
        }).pipe(Effect.provide(OmnigraphSyncLive))

        match(res)
          .with({ source: "memory-fallback" }, (fallback) => {
            expect(fallback.degraded).toBe(true)
            expect(fallback.fallbackError.length).toBeGreaterThan(0)
          })
          .with({ source: "omnigraph" }, () => {
            expect.unreachable("Expected memory-fallback")
          })
          .exhaustive()
        expect(Array.isArray(res.rows)).toBe(true)
      }

      const failWithoutFallback = yield* Effect.flip(
        invokeOmnigraphNamedQuery({
          name: "resolve_effect_fn",
          fetch: offlineFetch,
          params: { spanOrQualname: "Sample.greet" },
        }).pipe(Effect.provide(OmnigraphSyncLive)),
      )
      expect(failWithoutFallback).toBeInstanceOf(OmnigraphLoadError)
    }),
  )
})
