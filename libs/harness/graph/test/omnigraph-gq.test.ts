import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import type { FetchLike } from "@modernrelay/omnigraph"
import { Effect, Option, Schema } from "effect"
import {
  buildHarnessGraph,
  diffOmnigraphBranches,
  executeNamedGqQueryInMemory,
  HARNESS_GQ_QUERIES,
  HARNESS_GQ_QUERY_NAMES,
  invokeOmnigraphNamedQuery,
  OmnigraphSync,
  queryOmnigraph,
  resolveOmnigraphBaseUrl,
  syncToOmnigraphAndSnapshot
} from "../src/index.js"

const decodeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown)
)

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly body?: string | undefined
}

const toUrlString = (input: string | URL | Request): string => {
  if (typeof input === "string") return input
  if ("url" in input) return input.url
  return input.href
}

describe("Omnigraph 0.14.0 schema.pg and queries/harness.gq", () => {
  const graphDir = path.resolve(import.meta.dirname, "..")
  const schemaPath = path.join(graphDir, "schema.pg")
  const queriesPath = path.join(graphDir, "queries/harness.gq")

  it.effect("declares all 8 node types and ArchiMate properties in schema.pg", () =>
    Effect.gen(function* () {
      yield* Effect.void
      const schema = fs.readFileSync(schemaPath, "utf8")

      const expectedNodes = [
        "node EffectFn",
        "node ServiceTag",
        "node ServiceLayer",
        "node TaggedError",
        "node VitestCase",
        "node PatternDoc",
        "node AdrDoc",
        "node EarsSpec"
      ]
      for (const nodeDecl of expectedNodes) {
        expect(schema).toContain(nodeDecl)
      }

      expect(schema).toContain(
        "archimateLayer: enum(Motivation, Business, Application, Technology, Implementation) @index"
      )
      expect(schema).toContain(
        "archimateAspect: enum(Motivation, Behavior, ActiveStructure, PassiveStructure) @index"
      )
      expect(schema).toContain("archimateElementType: String @index")
      expect(schema).toContain("isPropertyTest: Bool @index")

      const expectedEdges = [
        "edge RequiresService: EffectFn -> ServiceTag",
        "edge FailsWith: EffectFn -> TaggedError",
        "edge ProvidesService: ServiceLayer -> ServiceTag",
        "edge LayerRequires: ServiceLayer -> ServiceTag",
        "edge TracedCall: EffectFn -> EffectFn",
        "edge ExercisesSpan: VitestCase -> EffectFn",
        "edge GovernsSymbol: AdrDoc -> Any",
        "edge SpecifiesSymbol: EarsSpec -> Any"
      ]
      for (const edgeDecl of expectedEdges) {
        expect(schema).toContain(edgeDecl)
      }

      expect(schema).toContain("archimateRelation: String @index")
    })
  )

  it.effect("declares all 8 canonical GQ queries in queries/harness.gq", () =>
    Effect.gen(function* () {
      yield* Effect.void
      const gqSource = fs.readFileSync(queriesPath, "utf8")

      for (const queryName of HARNESS_GQ_QUERY_NAMES) {
        expect(gqSource).toContain(`query ${queryName}`)
        expect(HARNESS_GQ_QUERIES[queryName]).toBeDefined()
        expect(HARNESS_GQ_QUERIES[queryName].name).toBe(queryName)
      }
    })
  )
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
        isStub: false
      },
      {
        qualname: "libs/sample/domain/src/index.ts#untested",
        spanName: "Sample.untested",
        file: "libs/sample/domain/src/index.ts",
        line: 10,
        packageTag: "domain",
        successType: "void",
        isStub: false
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
        layerKind: "live",
        packageTag: "infra",
        file: "libs/sample/infra/src/index.ts"
      }
    ],
    errors: [
      {
        errorTag: "PhotoNotFound",
        file: "libs/sample/domain/src/errors.ts"
      }
    ],
    tests: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        testFile: "libs/sample/domain/test/index.test.ts",
        testName: "greets by name",
        lastTreeHash: "abc123"
      }
    ],
    patternDocs: [
      {
        slug: "planning",
        path: "agent-patterns/planning.md",
        summary: "Plan-as-Code markdown template with stub skeleton pattern."
      }
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
        referencedErrors: []
      }
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
        referencedErrors: []
      }
    ],
    providesService: [
      {
        layerQualname: "PhotoRepoLive",
        tagId: "PhotoRepo"
      }
    ],
    exercisesSpans: [
      {
        testId: "libs/sample/domain/test/index.test.ts::greets by name",
        calleeQualname: "libs/sample/domain/src/index.ts#greet",
        callCount: 1,
        receiverLayer: null
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
        targetKey: "libs/sample/domain/src/index.ts#greet",
        targetKind: "EffectFn"
      }
    ]
  })

  it.effect("executes all 8 named GQ queries in memory deterministically", () =>
    Effect.gen(function* () {
      yield* Effect.void
      const fnRows = executeNamedGqQueryInMemory(
        sampleGraph,
        "resolve_effect_fn",
        { spanOrQualname: "Sample.greet" }
      )
      expect(fnRows).toHaveLength(1)
      expect(fnRows[0]?.spanName).toBe("Sample.greet")
      expect(fnRows[0]?.archimateLayer).toBe("Business")

      const provRows = executeNamedGqQueryInMemory(
        sampleGraph,
        "find_service_providers",
        { tagId: "PhotoRepo" }
      )
      expect(provRows).toHaveLength(1)
      expect(provRows[0]?.layerQualname).toBe("PhotoRepoLive")
      expect(provRows[0]?.tagId).toBe("PhotoRepo")

      const callerRows = executeNamedGqQueryInMemory(
        sampleGraph,
        "find_callers",
        { target: "PhotoRepo" }
      )
      expect(callerRows.some((c) => c.qualname === "sample:ADR-0001")).toBe(true)

      const calleeRows = executeNamedGqQueryInMemory(
        sampleGraph,
        "find_callees",
        { caller: "sample:SPEC-0001" }
      )
      expect(
        calleeRows.some(
          (c) => c.qualname === "libs/sample/domain/src/index.ts#greet"
        )
      ).toBe(true)

      const testRows = executeNamedGqQueryInMemory(
        sampleGraph,
        "find_tests_reaching",
        { callee: "Sample.greet" }
      )
      expect(testRows).toHaveLength(1)
      expect(testRows[0]?.testId).toBe(
        "libs/sample/domain/test/index.test.ts::greets by name"
      )

      const layerRows = executeNamedGqQueryInMemory(
        sampleGraph,
        "ontology_layer_nodes",
        { layer: "Motivation" }
      )
      expect(layerRows.length).toBeGreaterThanOrEqual(2)

      const whyRows = executeNamedGqQueryInMemory(
        sampleGraph,
        "ontology_governed_by",
        { symbol: "Sample.greet" }
      )
      expect(whyRows.some((w) => w.id === "sample:SPEC-0001")).toBe(true)

      const untestedRows = executeNamedGqQueryInMemory(
        sampleGraph,
        "untested_domain_fns"
      )
      expect(untestedRows).toHaveLength(1)
      expect(untestedRows[0]?.spanName).toBe("Sample.untested")
    })
  )

  it.effect("falls back to memory-fallback across all 8 queries when Omnigraph is offline", () =>
    Effect.gen(function* () {
      const offlineFetch: FetchLike = () =>
        Promise.resolve(
          new Response("Service Unavailable", {
            status: 503,
            headers: { "Omnigraph-Http-Api": "0.14" }
          })
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
            symbol: "Sample.greet"
          }
        }).pipe(Effect.provide(OmnigraphSync.Live))

        expect(res.source).toBe("memory-fallback")
        expect(Array.isArray(res.rows)).toBe(true)
      }
    })
  )
})

describe("OmnigraphSync against mock wire protocol (Omnigraph-Http-Api: 0.14)", () => {
  const sampleGraph = buildHarnessGraph({
    fns: [
      {
        qualname: "libs/sample/domain/src/index.ts#greet",
        spanName: "Sample.greet",
        file: "libs/sample/domain/src/index.ts",
        line: 4,
        packageTag: "domain",
        successType: "string",
        isStub: false
      }
    ]
  })

  it.effect("syncs with branch and forks from main using exact Omnigraph 0.14 protocol", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = []

      const mockFetch: FetchLike = (input, init) => {
        const urlStr = toUrlString(input)
        const method = init?.method ?? "GET"
        const body = typeof init?.body === "string" ? init.body : undefined
        recorded.push({ url: urlStr, method, body })

        if (urlStr.endsWith("/healthz")) {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: { "Omnigraph-Http-Api": "0.14" }
            })
          )
        }

        if (urlStr.endsWith("/graphs/harness/load")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                graphCommitId: "cmt-100",
                serverRef: "9d92f397"
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14"
                }
              }
            )
          )
        }

        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "Omnigraph-Http-Api": "0.14" }
          })
        )
      }

      const syncRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
        branch: "plan/current",
        from: "main",
        fetch: mockFetch,
        snapshotPath: ".harness/test-snapshot.json"
      }).pipe(Effect.provide(OmnigraphSync.Live))

      expect(syncRes.syncedToOmnigraph).toBe(true)
      const loadReq = recorded.find((r) => r.url.endsWith("/load"))
      expect(loadReq).toBeDefined()
      expect(loadReq?.body).toBeDefined()

      const parsedBody = decodeJson(loadReq?.body ?? "{}") as {
        readonly branch: string
        readonly from: string
      }
      expect(parsedBody.branch).toBe("plan/current")
      expect(parsedBody.from).toBe("main")
    })
  )

  it.effect("queries live Omnigraph, invokes stored queries, and diffs branches", () =>
    Effect.gen(function* () {
      const mockFetch: FetchLike = (input, _init) => {
        const urlStr = toUrlString(input)
        if (urlStr.endsWith("/healthz")) {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: { "Omnigraph-Http-Api": "0.14" }
            })
          )
        }

        if (urlStr.includes("/graphs/harness/queries/resolve_effect_fn")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                rows: [
                  {
                    qualname: "libs/sample/domain/src/index.ts#greet",
                    spanName: "Sample.greet"
                  }
                ],
                graphCommitId: "cmt-200",
                serverRef: "9d92f397"
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14"
                }
              }
            )
          )
        }

        if (urlStr.endsWith("/graphs/harness/query")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                rows: [{ count: 42 }],
                graphCommitId: "cmt-300",
                serverRef: "9d92f397"
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14"
                }
              }
            )
          )
        }

        if (urlStr.includes("/graphs/harness/branches/diff")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                serverRef: "9d92f397",
                changes: [],
                netNodeCount: 0,
                netEdgeCount: 0
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14"
                }
              }
            )
          )
        }

        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "Omnigraph-Http-Api": "0.14" }
          })
        )
      }

      const invokeRes = yield* invokeOmnigraphNamedQuery({
        name: "resolve_effect_fn",
        params: { spanOrQualname: "Sample.greet" },
        fetch: mockFetch
      }).pipe(Effect.provide(OmnigraphSync.Live))

      expect(invokeRes.source).toBe("omnigraph")
      expect(invokeRes.rows).toHaveLength(1)
      expect(invokeRes.rows[0]?.spanName).toBe("Sample.greet")

      const queryRes = yield* queryOmnigraph({
        query: "query count_nodes { match { $n } return { count: count($n) } }",
        fetch: mockFetch
      }).pipe(Effect.provide(OmnigraphSync.Live))

      expect(Option.isSome(queryRes)).toBe(true)
      if (Option.isSome(queryRes)) {
        expect(queryRes.value).toHaveLength(1)
        expect(queryRes.value[0]?.count).toBe(42)
      }

      const diffRes = yield* diffOmnigraphBranches({
        source: "impl/current",
        target: "plan/current",
        fetch: mockFetch
      }).pipe(Effect.provide(OmnigraphSync.Live))

      expect(Option.isSome(diffRes)).toBe(true)
      if (Option.isSome(diffRes)) {
        expect(Array.isArray(diffRes.value.changes)).toBe(true)
      }
    })
  )

  it("resolves Omnigraph base URL from server.json and isolates two repositories", () => {
    const repoA = fs.mkdtempSync(path.join(tmpdir(), "og-repo-a-"))
    const repoB = fs.mkdtempSync(path.join(tmpdir(), "og-repo-b-"))
    try {
      const clusterA = path.join(repoA, ".harness", "omnigraph-cluster")
      const clusterB = path.join(repoB, ".harness", "omnigraph-cluster")
      fs.mkdirSync(clusterA, { recursive: true })
      fs.mkdirSync(clusterB, { recursive: true })

      fs.writeFileSync(
        path.join(clusterA, "server.json"),
        JSON.stringify({ baseUrl: "http://127.0.0.1:19991", canonicalRepoRoot: repoA })
      )
      fs.writeFileSync(
        path.join(clusterB, "server.json"),
        JSON.stringify({ baseUrl: "http://127.0.0.1:24442", canonicalRepoRoot: repoB })
      )

      const urlA = resolveOmnigraphBaseUrl({ repoRoot: repoA }, {})
      const urlB = resolveOmnigraphBaseUrl({ repoRoot: repoB }, {})

      expect(urlA).toBe("http://127.0.0.1:19991")
      expect(urlB).toBe("http://127.0.0.1:24442")
      expect(urlA).not.toBe(urlB)

      // When server.json does not exist, port is derived deterministically from repoRoot
      const repoC = fs.mkdtempSync(path.join(tmpdir(), "og-repo-c-"))
      try {
        const urlC = resolveOmnigraphBaseUrl({ repoRoot: repoC }, {})
        expect(urlC).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        expect(urlC).not.toBe(urlA)
        expect(urlC).not.toBe(urlB)
      } finally {
        fs.rmSync(repoC, { recursive: true, force: true })
      }
    } finally {
      fs.rmSync(repoA, { recursive: true, force: true })
      fs.rmSync(repoB, { recursive: true, force: true })
    }
  })
})
