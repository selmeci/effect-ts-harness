import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import type { FetchLike } from "@modernrelay/omnigraph"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  decideOmnigraphReconcile,
  diffOmnigraphBranches,
  executeNamedGqQueryInMemory,
  HARNESS_GQ_QUERIES,
  HARNESS_GQ_QUERY_NAMES,
  invokeOmnigraphNamedQuery,
  loadHarnessGqQueriesText,
  loadHarnessPgSchemaText,
  makeOmnigraphSyncLayer,
  mergeOmnigraphBranch,
  OmnigraphReconcileInput,
  queryOmnigraph,
  readGraphHeadMeta,
  RelationId,
  resolveGitHeadState,
  resolveOmnigraphBaseUrl,
  resolveOmnigraphTaskBranches,
  saveGraphSnapshot,
  syncToOmnigraphAndSnapshot,
  toOmnigraphNdjson,
  writeGraphHeadMeta,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

const OmnigraphSyncLive = makeOmnigraphSyncLayer(testHostIo)

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

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
          "node EffectSignature",
          "node LayerFlow",
          "node TraceabilityTuple",
          "node HttpEndpointTuple",
          "node MigrationTuple",
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
          "edge PlaysExercisingTestRole: TraceabilityTuple -> VitestCase",
          "edge PlaysExercisedSpanRole: TraceabilityTuple -> EffectFn",
        ]
        for (const edgeDecl of expectedEdges) {
          expect(schema).toContain(edgeDecl)
        }

        expect(schema).toContain("archimateRelation: String @index")
      }),
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
    }),
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
    }),
  )

  it.effect("falls back to memory-fallback across all 8 queries when Omnigraph is offline", () =>
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
          },
        }).pipe(Effect.provide(OmnigraphSyncLive))

        expect(res.source).toBe("memory-fallback")
        expect(Array.isArray(res.rows)).toBe(true)
      }
    }),
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
        isStub: false,
      },
    ],
    services: [
      {
        tagId: "Greeter",
        name: "Greeter",
        packageTag: "service",
        file: "libs/sample/service/src/index.ts",
      },
    ],
    requiresService: [
      {
        fnQualname: "libs/sample/domain/src/index.ts#greet",
        tagId: "Greeter",
      },
    ],
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
              headers: { "Omnigraph-Http-Api": "0.14" },
            }),
          )
        }

        if (urlStr.endsWith("/graphs/harness/load")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                graphCommitId: "cmt-100",
                serverRef: "9d92f397",
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14",
                },
              },
            ),
          )
        }

        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "Omnigraph-Http-Api": "0.14" },
          }),
        )
      }

      const syncRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
        branch: "plan/current",
        from: "main",
        fetch: mockFetch,
        snapshotPath: ".harness/test-snapshot.json",
      }).pipe(Effect.provide(OmnigraphSyncLive))

      expect(syncRes.syncedToOmnigraph).toBe(true)
      const loadReq = recorded.find((r) => r.url.endsWith("/load"))
      expect(loadReq).toBeDefined()
      expect(loadReq?.body).toBeDefined()

      const parsedBody = decodeJson(loadReq?.body ?? "{}") as {
        readonly branch: string
        readonly from: string
        readonly data: string
      }
      expect(parsedBody.branch).toBe("plan/current")
      expect(parsedBody.from).toBe("main")

      const lines = parsedBody.data
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => decodeJson(l) as { readonly type?: string; readonly edge?: string })
      expect(lines.some((l) => l.type === "EffectFn")).toBe(true)
      expect(lines.some((l) => l.type === "EffectSignature")).toBe(true)
      expect(lines.some((l) => l.edge === "PlaysCallerRole")).toBe(true)
      expect(lines.every((l) => l.type !== "Any" && l.edge !== "Any")).toBe(true)
    }),
  )

  it.effect("queries live Omnigraph, invokes stored queries, and diffs branches", () =>
    Effect.gen(function* () {
      const mockFetch: FetchLike = (input, _init) => {
        const urlStr = toUrlString(input)
        if (urlStr.endsWith("/healthz")) {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: { "Omnigraph-Http-Api": "0.14" },
            }),
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
                    spanName: "Sample.greet",
                  },
                ],
                graphCommitId: "cmt-200",
                serverRef: "9d92f397",
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14",
                },
              },
            ),
          )
        }

        if (urlStr.endsWith("/graphs/harness/query")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                rows: [{ count: 42 }],
                graphCommitId: "cmt-300",
                serverRef: "9d92f397",
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14",
                },
              },
            ),
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
                netEdgeCount: 0,
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14",
                },
              },
            ),
          )
        }

        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "Omnigraph-Http-Api": "0.14" },
          }),
        )
      }

      const invokeRes = yield* invokeOmnigraphNamedQuery({
        name: "resolve_effect_fn",
        params: { spanOrQualname: "Sample.greet" },
        fetch: mockFetch,
      }).pipe(Effect.provide(OmnigraphSyncLive))

      expect(invokeRes.source).toBe("omnigraph")
      expect(invokeRes.rows).toHaveLength(1)
      expect(invokeRes.rows[0]?.spanName).toBe("Sample.greet")

      const queryRes = yield* queryOmnigraph({
        query: "query count_nodes { match { $n } return { count: count($n) } }",
        fetch: mockFetch,
      }).pipe(Effect.provide(OmnigraphSyncLive))

      match(queryRes)
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value).toHaveLength(1)
          expect(value[0]?.count).toBe(42)
        })
        .with({ _tag: "None" }, () => {
          expect.unreachable("Expected queryRes to be Some")
        })
        .exhaustive()

      const diffRes = yield* diffOmnigraphBranches({
        source: "impl/current",
        target: "plan/current",
        fetch: mockFetch,
      }).pipe(Effect.provide(OmnigraphSyncLive))

      match(diffRes)
        .with({ _tag: "Some" }, ({ value }) => {
          expect(Array.isArray(value.changes)).toBe(true)
        })
        .with({ _tag: "None" }, () => {
          expect.unreachable("Expected diffRes to be Some")
        })
        .exhaustive()
    }),
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
        JSON.stringify({ baseUrl: "http://127.0.0.1:19991", canonicalRepoRoot: repoA }),
      )
      fs.writeFileSync(
        path.join(clusterB, "server.json"),
        JSON.stringify({ baseUrl: "http://127.0.0.1:24442", canonicalRepoRoot: repoB }),
      )

      const urlA = resolveOmnigraphBaseUrl({ repoRoot: repoA }, {}, testHostIo)
      const urlB = resolveOmnigraphBaseUrl({ repoRoot: repoB }, {}, testHostIo)

      expect(urlA).toBe("http://127.0.0.1:19991")
      expect(urlB).toBe("http://127.0.0.1:24442")
      expect(urlA).not.toBe(urlB)

      // When server.json does not exist, port is derived deterministically from repoRoot
      const repoC = fs.mkdtempSync(path.join(tmpdir(), "og-repo-c-"))
      try {
        const urlC = resolveOmnigraphBaseUrl({ repoRoot: repoC }, {}, testHostIo)
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

  it.effect(
    "merges task branch into main, deletes cleanupBranches, and persists graph-head.json",
    () =>
      Effect.gen(function* () {
        const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-merge-cleanup-"))
        try {
          const gitDir = path.join(repoDir, ".git", "refs", "heads", "feat")
          fs.mkdirSync(gitDir, { recursive: true })
          fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/feat/my-pr\n")
          const commitSha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
          fs.writeFileSync(path.join(gitDir, "my-pr"), `${commitSha}\n`)

          const taskBranches = resolveOmnigraphTaskBranches(repoDir, testHostIo, {})
          expect(taskBranches).toEqual({
            planBranch: "plan/branch-feat_my-pr",
            implBranch: "impl/branch-feat_my-pr",
            mainBranch: "main",
          })

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
                  headers: { "Omnigraph-Http-Api": "0.14" },
                }),
              )
            }

            if (urlStr.endsWith("/graphs/harness/load")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "ok",
                    graphCommitId: "cmt-load-1",
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            if (urlStr.endsWith("/graphs/harness/branches") && method === "GET") {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "ok",
                    branches: [
                      taskBranches.mainBranch,
                      taskBranches.implBranch,
                      taskBranches.planBranch,
                    ],
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            if (urlStr.includes("/graphs/harness/branches/merge")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "already_up_to_date",
                    source: taskBranches.implBranch,
                    target: taskBranches.mainBranch,
                    commit: null,
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            if (method === "DELETE" && urlStr.includes("/graphs/harness/branches/")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "deleted",
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            return Promise.resolve(
              new Response("Not Found", {
                status: 404,
                headers: { "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }

          const snapshotPath = path.join(repoDir, ".harness", "graph-snapshot.json")
          const syncRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: repoDir,
            branch: taskBranches.implBranch,
            from: taskBranches.mainBranch,
            snapshotPath,
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(syncRes.syncedToOmnigraph).toBe(true)
          const headMeta = readGraphHeadMeta(repoDir, testHostIo)
          expect(headMeta?.headSha).toBe(commitSha)
          expect(headMeta?.gitBranch).toBe("feat/my-pr")

          recorded.length = 0
          const merged = yield* mergeOmnigraphBranch({
            repoRoot: repoDir,
            source: taskBranches.implBranch,
            target: taskBranches.mainBranch,
            cleanupBranches: [taskBranches.implBranch, taskBranches.planBranch],
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(merged).toBe(true)
          const deleteRequests = recorded.filter((r) => r.method === "DELETE")
          expect(deleteRequests).toHaveLength(2)
          expect(deleteRequests[0]?.url).toContain("impl%2Fbranch-feat_my-pr")
          expect(deleteRequests[1]?.url).toContain("plan%2Fbranch-feat_my-pr")
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "F-15: syncToOmnigraphAndSnapshot returns syncedToOmnigraph: false with error when /load returns HTTP 500",
    () =>
      Effect.gen(function* () {
        const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-sync-err-"))
        try {
          const snapshotPath = path.join(repoDir, ".harness", "graph-snapshot.json")
          const mockFetch: FetchLike = (input) => {
            const urlStr = toUrlString(input)
            if (urlStr.includes("/graphs/harness/load")) {
              return Promise.resolve(
                new Response("Internal Server Error in Omnigraph", {
                  status: 500,
                  headers: { "Content-Type": "text/plain", "Omnigraph-Http-Api": "0.14" },
                }),
              )
            }
            return Promise.resolve(
              new Response("{}", {
                status: 200,
                headers: { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }

          const res = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: repoDir,
            branch: "impl/test-err",
            from: "main",
            snapshotPath,
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(res.syncedToOmnigraph).toBe(false)
          expect(res.error).toBeDefined()
          expect(res.error).toContain("500")
          expect(fs.existsSync(snapshotPath)).toBe(true)
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "F-15: mergeOmnigraphBranch falls back to loading .harness/graph-snapshot.json when /branches/merge returns HTTP 500, and returns false when fallback snapshot is missing or corrupt",
    () =>
      Effect.gen(function* () {
        const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-merge-fallback-"))
        try {
          const harnessDir = path.join(repoDir, ".harness")
          fs.mkdirSync(harnessDir, { recursive: true })
          const snapshotPath = path.join(harnessDir, "graph-snapshot.json")

          let loadCalledOnFallback = false
          const mockFetchWithMergeFail: FetchLike = (input, init) => {
            const urlStr = toUrlString(input)
            const method =
              init?.method ??
              (typeof input === "object" && "method" in input ? input.method : "GET")

            if (urlStr.endsWith("/graphs/harness/branches") && method === "GET") {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "ok",
                    branches: ["main", "impl/current"],
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            if (urlStr.includes("/graphs/harness/branches/merge")) {
              return Promise.resolve(
                new Response("Merge failed internally", {
                  status: 500,
                  headers: { "Content-Type": "text/plain", "Omnigraph-Http-Api": "0.14" },
                }),
              )
            }

            if (urlStr.includes("/graphs/harness/load") && method === "POST") {
              loadCalledOnFallback = true
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "loaded",
                    commit: {
                      sha: "abc12345",
                      parentSha: null,
                      treeSha: "def",
                      author: "test",
                      message: "m",
                      timestamp: "t",
                    },
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            return Promise.resolve(
              new Response("{}", {
                status: 200,
                headers: { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }

          // Case A: Missing fallback snapshot -> returns false
          const mergedMissing = yield* mergeOmnigraphBranch({
            repoRoot: repoDir,
            source: "impl/current",
            target: "main",
            fetch: mockFetchWithMergeFail,
          }).pipe(Effect.provide(OmnigraphSyncLive))
          expect(mergedMissing).toBe(false)
          expect(loadCalledOnFallback).toBe(false)

          // Case B: Corrupt fallback snapshot -> returns false
          fs.writeFileSync(snapshotPath, "{ corrupted json: 123", "utf8")
          const mergedCorrupt = yield* mergeOmnigraphBranch({
            repoRoot: repoDir,
            source: "impl/current",
            target: "main",
            fetch: mockFetchWithMergeFail,
          }).pipe(Effect.provide(OmnigraphSyncLive))
          expect(mergedCorrupt).toBe(false)
          expect(loadCalledOnFallback).toBe(false)

          // Case C: Valid fallback snapshot exists -> succeeds via /load and returns true
          saveGraphSnapshot(sampleGraph, snapshotPath, testHostIo)
          const mergedSuccess = yield* mergeOmnigraphBranch({
            repoRoot: repoDir,
            source: "impl/current",
            target: "main",
            fetch: mockFetchWithMergeFail,
          }).pipe(Effect.provide(OmnigraphSyncLive))
          expect(mergedSuccess).toBe(true)
          expect(loadCalledOnFallback).toBe(true)
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "F-29: every edge emitted by toOmnigraphNdjson on a comprehensive graph is declared in schema.pg",
    () =>
      Effect.gen(function* () {
        yield* Effect.void
        const schemaPath = path.resolve(import.meta.dirname, "../schema.pg")
        const schema = fs.readFileSync(schemaPath, "utf8")
        const edgeMatches = schema.matchAll(/^edge\s+([A-Za-z0-9_]+):/gm)
        const declaredEdgeTypes = new Set<string>()
        for (const m of edgeMatches) {
          if (m[1]) {
            declaredEdgeTypes.add(m[1])
          }
        }
        expect(declaredEdgeTypes.size).toBeGreaterThanOrEqual(25)

        const comprehensiveGraph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/comprehensive/domain/src/index.ts#callerFn",
              spanName: "Caller.fn",
              file: "libs/comprehensive/domain/src/index.ts",
              line: 1,
              packageTag: "domain",
              successType: "string",
              inputSchema: "InputSchemaDef",
              outputSchema: "OutputSchemaDef",
              payloadSchemas: ["UsesSchemaDef"],
              isStub: false,
            },
            {
              qualname: "libs/comprehensive/domain/src/index.ts#calleeFn",
              spanName: "Callee.fn",
              file: "libs/comprehensive/domain/src/index.ts",
              line: 10,
              packageTag: "domain",
              successType: "void",
              isStub: false,
            },
            {
              qualname: "libs/comprehensive/infra/src/index.ts#httpHandler",
              spanName: "Http.handler",
              file: "libs/comprehensive/infra/src/index.ts",
              line: 20,
              packageTag: "infra",
              successType: "void",
              isStub: false,
            },
          ],
          services: [
            {
              tagId: "CompService",
              name: "CompService",
              packageTag: "service",
              file: "libs/comprehensive/service/src/index.ts",
            },
            {
              tagId: "LayerReqService",
              name: "LayerReqService",
              packageTag: "service",
              file: "libs/comprehensive/service/src/index.ts",
            },
          ],
          layers: [
            {
              qualname: "CompLayerLive",
              layerKind: "live",
              packageTag: "infra",
              file: "libs/comprehensive/infra/src/layer.ts",
            },
          ],
          errors: [
            {
              errorTag: "SigError",
              file: "libs/comprehensive/contract/src/errors.ts",
            },
            {
              errorTag: "LayerError",
              file: "libs/comprehensive/contract/src/errors.ts",
            },
            {
              errorTag: "HttpError",
              file: "libs/comprehensive/contract/src/errors.ts",
            },
          ],
          schemas: [
            {
              schemaName: "InputSchemaDef",
              file: "libs/comprehensive/contract/src/schemas.ts",
            },
            {
              schemaName: "OutputSchemaDef",
              file: "libs/comprehensive/contract/src/schemas.ts",
            },
            {
              schemaName: "UsesSchemaDef",
              file: "libs/comprehensive/contract/src/schemas.ts",
            },
            {
              schemaName: "HttpRequestSchema",
              file: "libs/comprehensive/contract/src/schemas.ts",
            },
            {
              schemaName: "HttpResponseSchema",
              file: "libs/comprehensive/contract/src/schemas.ts",
            },
          ],
          tests: [
            {
              testId: "libs/comprehensive/domain/test/index.test.ts::test 1",
              testFile: "libs/comprehensive/domain/test/index.test.ts",
              testName: "test 1",
            },
            {
              testId: "libs/comprehensive/infra/test/mig.test.ts::migration test",
              testFile: "libs/comprehensive/infra/test/mig.test.ts",
              testName: "migration test",
            },
          ],
          patternDocs: [
            {
              slug: "comp-pattern",
              path: "agent-patterns/comp.md",
              summary: "Comprehensive pattern",
            },
          ],
          adrDocs: [
            {
              id: "ADR-COMP",
              title: "Comprehensive ADR",
              status: "accepted",
              path: "docs/adr/comp.md",
              enforcedByFiles: [],
            },
          ],
          earsSpecs: [
            {
              id: "SPEC-COMP",
              title: "Comprehensive Spec",
              status: "accepted",
              path: "docs/specs/comp.md",
              enforcedByFiles: [],
            },
          ],
          requiresService: [
            {
              callerQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
              tagId: "CompService",
            },
          ],
          failsWith: [
            {
              callerQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
              errorTag: "SigError",
            },
          ],
          tracedCalls: [
            {
              callerQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
              calleeQualname: "libs/comprehensive/domain/src/index.ts#calleeFn",
              callCount: 2,
              receiverLayer: null,
            },
          ],
          providesService: [
            {
              layerQualname: "CompLayerLive",
              tagId: "CompService",
            },
          ],
          layerRequires: [
            {
              layerQualname: "CompLayerLive",
              tagId: "LayerReqService",
            },
          ],
          layerFlows: [
            {
              relationId: RelationId.make("LayerFlow:CompLayerLive"),
              layerQualname: "CompLayerLive",
              providesServices: ["CompService"],
              requiresServices: ["LayerReqService"],
              emittedErrors: ["LayerError"],
              file: "libs/comprehensive/infra/src/layer.ts",
              line: 1,
            },
          ],
          exercisesSpans: [
            {
              testId: "libs/comprehensive/domain/test/index.test.ts::test 1",
              calleeQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
              callCount: 1,
              receiverLayer: null,
            },
          ],
          governsSymbols: [
            {
              adrId: "ADR-COMP",
              targetKey: "libs/comprehensive/domain/src/index.ts#callerFn",
              targetKind: "EffectFn",
            },
          ],
          specifiesSymbols: [
            {
              specId: "SPEC-COMP",
              targetKey: "libs/comprehensive/domain/src/index.ts#callerFn",
              targetKind: "EffectFn",
            },
          ],
          traceabilityTuples: [
            {
              relationId: RelationId.make("TraceabilityTuple:pattern-and-test"),
              adrId: "ADR-COMP",
              earsSpecId: "SPEC-COMP",
              targetSymbolQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
              verifyingTestQualnames: ["libs/comprehensive/domain/test/index.test.ts::test 1"],
              enforcingPatternPaths: ["agent-patterns/comp.md"],
            },
            {
              relationId: RelationId.make("TraceabilityTuple:realize-svc"),
              targetSymbolQualname: "CompService",
              verifyingTestQualnames: [],
            },
            {
              relationId: RelationId.make("TraceabilityTuple:realize-layer"),
              targetSymbolQualname: "CompLayerLive",
              verifyingTestQualnames: [],
            },
            {
              relationId: RelationId.make("TraceabilityTuple:realize-err"),
              targetSymbolQualname: "SigError",
              verifyingTestQualnames: [],
            },
            {
              relationId: RelationId.make("TraceabilityTuple:realize-schema"),
              targetSymbolQualname: "InputSchemaDef",
              verifyingTestQualnames: [],
            },
          ],
          httpEndpointTuples: [
            {
              relationId: RelationId.make("HttpEndpoint:CompEp"),
              endpointGroup: "Comp",
              endpointName: "handle",
              method: "POST",
              path: "/comp",
              handlerQualname: "libs/comprehensive/infra/src/index.ts#httpHandler",
              requestSchemaQualnames: ["HttpRequestSchema"],
              responseSchemaQualnames: ["HttpResponseSchema"],
              errorTags: ["HttpError"],
              file: "libs/comprehensive/infra/src/http.ts",
              line: 1,
            },
          ],
          migrationTuples: [
            {
              relationId: RelationId.make("Migration:1_comp_mig"),
              migrationId: "1_comp_mig",
              engine: "SqliteMigrator",
              moduleFile: "libs/comprehensive/infra/src/mig.ts",
              isDestructive: false,
              verifyingTestQualnames: ["libs/comprehensive/infra/test/mig.test.ts::migration test"],
              line: 1,
            },
          ],
        })

        const ndjson = toOmnigraphNdjson(comprehensiveGraph)
        const emittedEdgeNames = new Set<string>()

        for (const line of ndjson.split("\n")) {
          if (!line.trim()) continue
          const parsed = JSON.parse(line) as { readonly edge?: string }
          if (parsed.edge !== undefined) {
            emittedEdgeNames.add(parsed.edge)
            expect(declaredEdgeTypes.has(parsed.edge)).toBe(true)
          }
        }

        expect(emittedEdgeNames.size).toBeGreaterThanOrEqual(15)
        expect(emittedEdgeNames.has("PlaysCallerRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysCalleeRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRequiresServiceRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysFailsWithRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysInputSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysOutputSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysUsesSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysProviderLayerRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysProvidedServiceRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRequiredServiceRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysLayerFailsWithRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysGoverningAdrRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysSpecifyingEarsRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingFnRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingServiceRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingLayerRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingErrorRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysVerifyingTestRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysEnforcingPatternRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysExercisingTestRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysExercisedSpanRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysEndpointHandlerRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRequestSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysResponseSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysEndpointErrorRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysMigrationVerifyingTestRole")).toBe(true)
      }),
  )
})

describe("OmnigraphReconcile.decide and Git HEAD state tracking", () => {
  it.effect.prop(
    "evaluates OmnigraphReconcile.decide deterministically across all composite inputs",
    [OmnigraphReconcileInput],
    ([input]) =>
      Effect.gen(function* () {
        const decision = yield* decideOmnigraphReconcile(input)
        const branchTrimmed = input.currentGitBranch?.trim() ?? ""
        const expectedTargetBranch =
          branchTrimmed.length > 0 && branchTrimmed !== "main" && branchTrimmed !== "master"
            ? `impl/branch-${branchTrimmed.replace(/[^a-zA-Z0-9._-]/g, "_")}`
            : "main"
        expect(decision.targetOmnigraphBranch).toBe(expectedTargetBranch)
        if (!input.snapshotExists) {
          expect(decision).toEqual({
            needsReconcile: true,
            reason: "missing-snapshot",
            targetOmnigraphBranch: expectedTargetBranch,
          })
        } else if (
          input.currentHeadSha !== null &&
          input.currentHeadSha.length > 0 &&
          input.recordedHeadSha !== input.currentHeadSha
        ) {
          expect(decision).toEqual({
            needsReconcile: true,
            reason: "head-sha-changed",
            targetOmnigraphBranch: expectedTargetBranch,
          })
        } else if (
          input.currentGitBranch !== null &&
          input.recordedGitBranch !== null &&
          input.recordedGitBranch !== input.currentGitBranch
        ) {
          expect(decision).toEqual({
            needsReconcile: true,
            reason: "git-branch-changed",
            targetOmnigraphBranch: expectedTargetBranch,
          })
        } else {
          expect(decision).toEqual({
            needsReconcile: false,
            reason: "up-to-date",
            targetOmnigraphBranch: expectedTargetBranch,
          })
        }
      }),
  )

  it("resolves Git HEAD state from loose refs, packed-refs, and linked worktrees", () => {
    const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-git-head-"))
    try {
      const refsDir = path.join(repoDir, ".git", "refs", "heads")
      fs.mkdirSync(refsDir, { recursive: true })
      const mainSha = "1111111111111111111111111111111111111111"
      const packedSha = "2222222222222222222222222222222222222222"
      fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n")
      fs.writeFileSync(path.join(refsDir, "main"), `${mainSha}\n`)
      fs.writeFileSync(
        path.join(repoDir, ".git", "packed-refs"),
        `# pack-refs with: peeled fully-peeled sorted\n${packedSha} refs/heads/release/v1\n`,
      )

      const mainHead = resolveGitHeadState(repoDir, testHostIo, {})
      expect(mainHead).toEqual({
        headSha: mainSha,
        gitBranch: "main",
      })
      expect(resolveOmnigraphTaskBranches(repoDir, testHostIo, {})).toEqual({
        planBranch: "plan/current",
        implBranch: "impl/current",
        mainBranch: "main",
      })

      fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/release/v1\n")
      const packedHead = resolveGitHeadState(repoDir, testHostIo, {})
      expect(packedHead).toEqual({
        headSha: packedSha,
        gitBranch: "release/v1",
      })
      expect(resolveOmnigraphTaskBranches(repoDir, testHostIo, {})).toEqual({
        planBranch: "plan/branch-release_v1",
        implBranch: "impl/branch-release_v1",
        mainBranch: "main",
      })

      writeGraphHeadMeta(repoDir, testHostIo, {
        headSha: packedSha,
        gitBranch: "release/v1",
      })
      const persisted = readGraphHeadMeta(repoDir, testHostIo)
      expect(persisted?.headSha).toBe(packedSha)
      expect(persisted?.gitBranch).toBe("release/v1")
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true })
    }
  })

  it("serves embedded schema.pg and queries/harness.gq assets verbatim", () => {
    const graphPkgDir = path.resolve(import.meta.dirname, "..")
    expect(loadHarnessPgSchemaText()).toBe(
      fs.readFileSync(path.resolve(graphPkgDir, "schema.pg"), "utf8"),
    )
    expect(loadHarnessGqQueriesText()).toBe(
      fs.readFileSync(path.resolve(graphPkgDir, "queries/harness.gq"), "utf8"),
    )
  })
})
