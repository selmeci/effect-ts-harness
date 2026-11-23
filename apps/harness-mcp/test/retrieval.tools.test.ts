import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  DocTreePathError,
  EmbeddingComponent,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingProviderBaseUrl,
  EmbeddingProviderError,
  ErrorReasonMessage,
  WorkspaceFileContent,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { decideSpanBudgets, type SpanSample } from "@harness/gates"
import { makeMockDecisionModelLayer } from "@harness/decision"
import {
  buildHarnessGraph,
  NodeKey,
  OmnigraphLoadError,
  OmnigraphSync,
  RelationId,
  RoleName,
  scoreLexicalBm25Lite,
} from "@harness/graph"
import { runWithTestTracer } from "@harness/ingest"
import { EmbeddingClient, WorkspaceFs } from "@harness/service"
import { executeToolEffect, ProjectPathEscapeError } from "../src/server.js"
import { executeDocTreeTool, executeSearchKnowledgeTool } from "../src/tools/retrieval.tools.js"

const makeMockOmnigraphSyncLayer = (
  onInvoke: (
    name: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<
    | {
        readonly source: "omnigraph"
        readonly rows: ReadonlyArray<Record<string, unknown>>
        readonly degraded: false
      }
    | {
        readonly source: "memory-fallback"
        readonly rows: ReadonlyArray<Record<string, unknown>>
        readonly degraded: true
        readonly fallbackError: string
      },
    OmnigraphLoadError
  >,
): Layer.Layer<OmnigraphSync> => {
  const unavailable = () => Effect.fail(new OmnigraphLoadError({ cause: "unused" }))
  return Layer.succeed(
    OmnigraphSync,
    OmnigraphSync.of({
      sync: (_g, opts) =>
        Effect.succeed({
          syncedToOmnigraph: false,
          snapshotPath: opts?.snapshotPath ?? ".harness/graph-snapshot.json",
        }),
      mergeBranch: () => Effect.void,
      dryRunMerge: () => unavailable(),
      diffBranches: () => unavailable(),
      query: () => unavailable(),
      mutateConditional: () => unavailable(),
      invokeNamedQuery: (input) => onInvoke(input.name, input.params),
      pollChanges: () => unavailable(),
      proposeMergeCommit: () => unavailable(),
      inspectCommitChanges: () => unavailable(),
      publishCommit: () => unavailable(),
      dropCommit: () => unavailable(),
      putBlob: () => unavailable(),
      getBlobText: () => Effect.succeed(null),
      statBlob: () => unavailable(),
    }),
  )
}

const makeEmbeddingLayer = (opts: {
  readonly availability: "available" | "unavailable"
  readonly vector?: ReadonlyArray<number> | undefined
  readonly failQuery?: boolean | undefined
}): Layer.Layer<EmbeddingClient> =>
  Layer.succeed(
    EmbeddingClient,
    EmbeddingClient.of({
      config: {
        baseUrl: EmbeddingProviderBaseUrl.make("http://127.0.0.1:11434/v1"),
        model: EmbeddingModelId.make("qwen3-embedding:8b"),
        dimensions: EmbeddingDimensionCount.make(opts.vector?.length ?? 4),
      },
      checkAvailability: Effect.succeed(opts.availability),
      embedBatch: (texts) =>
        Effect.succeed(
          texts.map(() => ({
            components: (opts.vector ?? [1, 0, 0, 0]).map((v) => EmbeddingComponent.make(v)),
          })),
        ),
      embedQuery: () =>
        opts.failQuery
          ? Effect.fail(
              new EmbeddingProviderError({
                model: EmbeddingModelId.make("qwen3-embedding:8b"),
                reason: ErrorReasonMessage.make("Embedding timeout"),
              }),
            )
          : Effect.succeed({
              components: (opts.vector ?? [1, 0, 0, 0]).map((v) => EmbeddingComponent.make(v)),
            }),
    }),
  )

const makeMemoryFsLayer = (files: ReadonlyMap<string, string>): Layer.Layer<WorkspaceFs> =>
  Layer.succeed(
    WorkspaceFs,
    WorkspaceFs.of({
      exists: (filePath) => Effect.succeed(files.has(filePath)),
      realPath: (filePath) => Effect.succeed(filePath),
      readTextFile: (filePath) => {
        const content = files.get(filePath)
        return content !== undefined
          ? Effect.succeed(WorkspaceFileContent.make(content))
          : Effect.fail(
              new WorkspaceFsError({
                filePath,
                operation: WorkspaceFsOperation.make("read"),
                reason: ErrorReasonMessage.make(`Missing: ${filePath}`),
              }),
            )
      },
      writeTextFileAtomic: () => Effect.void,
    }),
  )

const buildSampleRetrievalGraph = () =>
  buildHarnessGraph({
    fns: [
      {
        qualname: "libs/harness/graph/src/sync.ts#syncGraphEmbeddings",
        spanName: "GraphEmbeddings.sync",
        packageTag: "domain",
        file: "libs/harness/graph/src/sync.ts",
        line: 20,
        isStub: false,
      },
    ],
    patternDocs: [
      {
        slug: "errors",
        path: "agent-patterns/errors.md",
        title: "Typed Errors Pattern",
        headings: ["Typed Errors Pattern"],
        summary: "Use Schema.TaggedError instead of silent catch-all mocks.",
        coveredSpans: ["GraphEmbeddings.sync"],
        coveredTags: ["EmbeddingProviderError"],
      },
      {
        slug: "resources-scope",
        path: "agent-patterns/resources-scope.md",
        title: "Resources & Scope",
        headings: ["Resources & Scope"],
        summary: "Acquire and release scoped resources deterministically.",
      },
    ],
    adrDocs: [
      {
        id: "harness:ADR-0025",
        title: "Three-Tier Retrieval Architecture",
        status: "accepted",
        path: "libs/harness/docs/adr/0025.md",
        enforcedByFiles: ["libs/harness/graph/src/sync.ts"],
        referencedSpans: ["GraphEmbeddings.sync"],
        searchText:
          "Never silently inject mock vectors when embeddings fail; degrade to bm25-only.",
        summary: "Prevent silent mock fallback when embeddings fail.",
      },
    ],
    earsSpecs: [
      {
        id: "harness:SPEC-0031",
        title: "Three-Tier Retrieval Spec",
        status: "proposed",
        path: "libs/harness/docs/specs/0031.md",
        enforcedByFiles: ["libs/harness/graph/src/sync.ts"],
        informedByAdrs: ["harness:ADR-0025"],
        referencedSpans: ["GraphEmbeddings.sync"],
      },
    ],
    earsRequirements: [
      {
        id: "harness:SPEC-0031::REQ-2.3",
        specId: "harness:SPEC-0031",
        requirementId: "REQ-2.3",
        area: "Embedding Sync",
        pattern: "Unwanted behaviour",
        clauseText:
          "If Ollama is unreachable, GraphEmbeddings.sync shall degrade to bm25-only without mock vectors.",
        effectSymbol: "GraphEmbeddings.sync",
        verification: "UnitTest",
        path: "libs/harness/docs/specs/0031.md",
        line: 42,
        status: "proposed",
      },
    ],
    governsSymbols: [
      {
        adrId: "harness:ADR-0025",
        targetKey: "libs/harness/graph/src/sync.ts#syncGraphEmbeddings",
        targetKind: "EffectFn",
      },
    ],
  })

describe("HarnessMcp 3-tier retrieval tools (ADR-0025 / SPEC-0031)", () => {
  it.effect(
    "searchKnowledge executes hybrid-rrf when Ollama and Omnigraph are healthy and hydrates linkedSymbols",
    () =>
      Effect.gen(function* () {
        const graph = buildSampleRetrievalGraph()
        const invokedQueries: Array<string> = []
        const syncLayer = makeMockOmnigraphSyncLayer((name) => {
          invokedQueries.push(name)
          if (name === "rank_patterns_vector_hybrid") {
            return Effect.succeed({
              source: "omnigraph" as const,
              degraded: false as const,
              rows: [
                {
                  slug: "errors",
                  path: "agent-patterns/errors.md",
                  title: "Typed Errors Pattern",
                  summary: "Use Schema.TaggedError instead of silent catch-all mocks.",
                },
              ],
            })
          }
          if (name === "search_adrs_vector_hybrid") {
            return Effect.succeed({
              source: "omnigraph" as const,
              degraded: false as const,
              rows: [
                {
                  id: "harness:ADR-0025",
                  title: "Three-Tier Retrieval Architecture",
                  path: "libs/harness/docs/adr/0025.md",
                  searchText:
                    "Never silently inject mock vectors when embeddings fail; degrade to bm25-only.",
                },
              ],
            })
          }
          return Effect.succeed({
            source: "omnigraph" as const,
            degraded: false as const,
            rows: [
              {
                id: "harness:SPEC-0031::REQ-2.3",
                specId: "harness:SPEC-0031",
                requirementId: "REQ-2.3",
                area: "Embedding Sync",
                clauseText:
                  "If Ollama is unreachable, GraphEmbeddings.sync shall degrade to bm25-only without mock vectors.",
                path: "libs/harness/docs/specs/0031.md",
              },
            ],
          })
        })

        const result = yield* executeSearchKnowledgeTool(
          {
            query: "prevent silent mock fallback when embeddings fail",
            limit: 6,
            repoRoot: "/repo",
          },
          {
            repoRoot: "/repo",
            graph,
            skipTelemetry: true,
            embeddingClientLayer: makeEmbeddingLayer({ availability: "available" }),
            omnigraphSyncLayer: syncLayer,
          },
        )

        expect(result.retrievalMode).toBe("hybrid-rrf")
        expect(result.degradedReason).toBeNull()
        expect(result.hits).toHaveLength(3)
        expect(invokedQueries).toEqual([
          "rank_patterns_vector_hybrid",
          "search_adrs_vector_hybrid",
          "search_requirements_vector_hybrid",
        ])

        const adrHit = result.hits.find((h) => h.nodeKind === "AdrDoc")
        expect(
          adrHit?.linkedSymbols.some(
            (s) => s.includes("syncGraphEmbeddings") || s === "GraphEmbeddings.sync",
          ),
        ).toBe(true)

        const reqHit = result.hits.find((h) => h.nodeKind === "EarsRequirement")
        expect(reqHit?.linkedSymbols).toContain("GraphEmbeddings.sync")
      }),
  )

  it.effect(
    "searchKnowledge degrades explicitly to bm25-only when Ollama is unavailable and lexical-fallback when Omnigraph fails",
    () =>
      Effect.gen(function* () {
        const graph = buildSampleRetrievalGraph()
        const omnigraphBm25Layer = makeMockOmnigraphSyncLayer((name) => {
          if (name === "search_adrs_bm25") {
            return Effect.succeed({
              source: "omnigraph" as const,
              degraded: false as const,
              rows: [
                {
                  id: "harness:ADR-0025",
                  title: "Three-Tier Retrieval Architecture",
                  path: "libs/harness/docs/adr/0025.md",
                  searchText: "Never silently inject mock vectors when embeddings fail.",
                  score: 0.9,
                },
              ],
            })
          }
          return Effect.succeed({
            source: "omnigraph" as const,
            degraded: false as const,
            rows: [],
          })
        })

        const bm25Result = yield* executeSearchKnowledgeTool(
          {
            query: "mock vectors",
            kinds: ["AdrDoc"],
            repoRoot: "/repo",
          },
          {
            repoRoot: "/repo",
            graph,
            skipTelemetry: true,
            embeddingClientLayer: makeEmbeddingLayer({ availability: "unavailable" }),
            omnigraphSyncLayer: omnigraphBm25Layer,
          },
        )

        expect(bm25Result.retrievalMode).toBe("bm25-only")
        expect(bm25Result.degradedReason).toContain("unavailable")
        expect(bm25Result.hits.map((h) => h.nodeKey)).toEqual(["AdrDoc:harness:ADR-0025"])

        const lexicalResult = yield* executeSearchKnowledgeTool(
          {
            query: "GraphEmbeddings.sync",
            kinds: ["EarsRequirement"],
            status: "proposed",
            limit: 1,
            repoRoot: "/repo",
          },
          {
            repoRoot: "/repo",
            graph,
            skipTelemetry: true,
            skipOmnigraphSpawn: true,
            embeddingClientLayer: makeEmbeddingLayer({
              availability: "available",
              failQuery: true,
            }),
          },
        )

        expect(lexicalResult.retrievalMode).toBe("lexical-fallback")
        expect(lexicalResult.degradedReason).toContain("Embedding timeout")
        expect(lexicalResult.hits).toHaveLength(1)
        expect(lexicalResult.hits[0]?.nodeKey).toBe("EarsRequirement:harness:SPEC-0031::REQ-2.3")
      }),
  )

  it.effect(
    "docTree executes catalog, tree, and section modes and fails with DocTreePathError on escape",
    () =>
      Effect.gen(function* () {
        const graph = buildSampleRetrievalGraph()
        const fsLayer = makeMemoryFsLayer(
          new Map([
            [
              "/repo/libs/harness/docs/adr/0025.md",
              "# ADR-0025\n\n## Context\n\nContext body.\n\n## Decision\n\nDecision body.\n",
            ],
          ]),
        )
        const serverOpts = {
          repoRoot: "/repo",
          graph,
          skipTelemetry: true,
          workspaceFsLayer: fsLayer,
        }

        const catalog = yield* executeDocTreeTool(
          { mode: "catalog", repoRoot: "/repo" },
          serverOpts,
        )
        match(catalog)
          .with({ _tag: "GovernanceCatalog" }, (c) => {
            expect(c.totalDocs).toBe(2)
          })
          .with({ _tag: "DocumentTree" }, { _tag: "SectionContent" }, () => {
            expect.unreachable("Expected GovernanceCatalog")
          })
          .exhaustive()

        const tree = yield* executeDocTreeTool(
          { mode: "tree", path: "libs/harness/docs/adr/0025.md", repoRoot: "/repo" },
          serverOpts,
        )
        match(tree)
          .with({ _tag: "DocumentTree" }, (t) => {
            expect(t.sections.map((s) => s.sectionId)).toEqual(["h1-1", "h2-2", "h2-3"])
          })
          .with({ _tag: "GovernanceCatalog" }, { _tag: "SectionContent" }, () => {
            expect.unreachable("Expected DocumentTree")
          })
          .exhaustive()

        const section = yield* executeDocTreeTool(
          {
            mode: "section",
            path: "libs/harness/docs/adr/0025.md",
            sectionId: "h2-3",
            repoRoot: "/repo",
          },
          serverOpts,
        )
        match(section)
          .with({ _tag: "SectionContent" }, (s) => {
            expect(s.content).toContain("Decision body.")
          })
          .with({ _tag: "GovernanceCatalog" }, { _tag: "DocumentTree" }, () => {
            expect.unreachable("Expected SectionContent")
          })
          .exhaustive()

        const escapeExit = yield* Effect.exit(
          executeDocTreeTool(
            { mode: "tree", path: "../../etc/passwd", repoRoot: "/repo" },
            serverOpts,
          ),
        )
        match(escapeExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(DocTreePathError)
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected DocTreePathError on traversal escape")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected escape path to fail")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "harness_resolve provides fuzzy suggestions on miss and harness_route upgrades review via hybrid pattern retrieval",
    () =>
      Effect.gen(function* () {
        const graph = buildSampleRetrievalGraph()
        const resolveMiss = (yield* executeToolEffect(
          "harness_resolve",
          { symbolOrSpan: "GraphEmbedings.sync" },
          {
            repoRoot: "/repo",
            graph,
            skipTelemetry: true,
            skipOmnigraphSpawn: true,
            skipActiveWorkspaceLookup: true,
          },
        )) as {
          readonly node: unknown
          readonly suggestions?: ReadonlyArray<Record<string, unknown>>
        }

        expect(resolveMiss.node).toBeNull()
        expect(resolveMiss.suggestions?.some((s) => s["spanName"] === "GraphEmbeddings.sync")).toBe(
          true,
        )

        const routedPlanning = (yield* executeToolEffect(
          "harness_route",
          { planStep: "Write EARS spec and stub<A, E, R> skeletons before plan-check" },
          {
            repoRoot: "/repo",
            graph,
            skipTelemetry: true,
            skipOmnigraphSpawn: true,
            skipActiveWorkspaceLookup: true,
            decisionLayer: makeMockDecisionModelLayer({ blockLabel: "review", fitsAnyProb: 0.2 }),
          },
        )) as { readonly block: string; readonly source: string }

        expect(routedPlanning.block).toBe("planning")
        expect(routedPlanning.source).toBe("deterministic")

        const routedHybrid = (yield* executeToolEffect(
          "harness_route",
          { planStep: "Acquire scoped resources safely" },
          {
            repoRoot: "/repo",
            graph,
            skipTelemetry: true,
            skipOmnigraphSpawn: true,
            skipActiveWorkspaceLookup: true,
            decisionLayer: makeMockDecisionModelLayer({ blockLabel: "review", fitsAnyProb: 0.2 }),
          },
        )) as {
          readonly block: string
          readonly source: string
          readonly candidatePatterns?: ReadonlyArray<string>
        }

        expect(routedHybrid.block).toBe("resources-scope")
        expect(routedHybrid.source).toBe("hybrid-retrieval")
        expect(routedHybrid.candidatePatterns?.[0]).toBe("resources-scope")

        const outOfScopeRoute = (yield* executeToolEffect(
          "harness_route",
          { planStep: "paint the fence purple" },
          {
            repoRoot: "/repo",
            graph,
            skipTelemetry: true,
            skipOmnigraphSpawn: true,
            skipActiveWorkspaceLookup: true,
            decisionLayer: makeMockDecisionModelLayer({ blockLabel: "review", fitsAnyProb: 0.2 }),
          },
        )) as { readonly block: string; readonly source: string }
        expect(outOfScopeRoute.block).toBe("review")

        const planningOnlyGraph = buildHarnessGraph({
          patternDocs: [
            {
              slug: "planning",
              path: "agent-patterns/planning.md",
              title: "Two-Stage Governance Mapping",
              headings: ["Interface Signatures", "Effect Blueprints"],
              summary:
                "Translate requirement clauses into schemas, capability ports, and typed holes.",
            },
          ],
        })
        const planningHybridRoute = (yield* executeToolEffect(
          "harness_route",
          { planStep: "translate requirement clauses into typed holes and capability ports" },
          {
            repoRoot: "/repo",
            graph: planningOnlyGraph,
            skipTelemetry: true,
            skipOmnigraphSpawn: true,
            skipActiveWorkspaceLookup: true,
            decisionLayer: makeMockDecisionModelLayer({ blockLabel: "review", fitsAnyProb: 0.2 }),
          },
        )) as { readonly block: string; readonly source: string }
        expect(planningHybridRoute.block).toBe("planning")
        expect(planningHybridRoute.source).toBe("hybrid-retrieval")
      }),
  )

  it.effect(
    "enforces repoRoot containment, trims whitespace queries, scores fairly without short-circuiting fallback, and excludes self-IDs in linkedSymbols",
    () =>
      Effect.gen(function* () {
        const base = buildSampleRetrievalGraph()
        const multiTargetGraph = {
          ...base,
          graph: Graph.mutate(base.graph, (mutable) => {
            const relIdx = Graph.addNode(mutable, {
              _tag: "TraceabilityTuple",
              relationId: RelationId.make("TraceabilityTuple:req:harness:SPEC-0031#REQ-2.3"),
              earsSpecId: "harness:SPEC-0031",
              requirementId: "REQ-2.3",
              targetSymbolQualname: "harness:SPEC-0031::REQ-2.3",
              verifyingTestQualnames: [],
            })
            const fnIdx = Graph.addNode(mutable, {
              _tag: "EffectFn",
              qualname: "libs/harness/graph/src/extra.ts#extraFn",
              spanName: "Extra.fn",
              packageTag: "domain",
              file: "libs/harness/graph/src/extra.ts",
              line: 5,
              isStub: false,
            })
            Graph.addEdge(mutable, relIdx, fnIdx, {
              _tag: "PlaysRole",
              relationId: RelationId.make("TraceabilityTuple:req:harness:SPEC-0031#REQ-2.3"),
              entityKey: NodeKey.make("EffectFn:libs/harness/graph/src/extra.ts#extraFn"),
              role: RoleName.make("specified-target"),
              archimateRelation: "Realization",
            })
          }),
        }

        const fsLayer = makeMemoryFsLayer(
          new Map([
            ["/repo/libs/harness/docs/adr/0025.md", "# ADR-0025\n\n## Decision\n\nBody.\n"],
          ]),
        )

        for (const toolCall of [
          executeSearchKnowledgeTool(
            { query: "typed errors", repoRoot: "/outside/repo" },
            { repoRoot: "/repo", graph: multiTargetGraph, skipTelemetry: true },
          ),
          executeDocTreeTool(
            { mode: "catalog", repoRoot: "/outside/repo" },
            {
              repoRoot: "/repo",
              graph: multiTargetGraph,
              skipTelemetry: true,
              workspaceFsLayer: fsLayer,
            },
          ),
          executeToolEffect(
            "harness_route",
            { planStep: "typed errors", repoRoot: "/outside/repo" },
            {
              repoRoot: "/repo",
              graph: multiTargetGraph,
              skipTelemetry: true,
              skipOmnigraphSpawn: true,
              decisionLayer: makeMockDecisionModelLayer({ blockLabel: "review", fitsAnyProb: 0.2 }),
            },
          ),
        ]) {
          const exit = yield* Effect.exit(toolCall)
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              match(Cause.findErrorOption(cause))
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value).toBeInstanceOf(ProjectPathEscapeError)
                })
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected ProjectPathEscapeError on escaping repoRoot")
                })
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected ProjectPathEscapeError")
            })
            .exhaustive()
        }

        const whitespaceExit = yield* Effect.exit(
          executeToolEffect(
            "harness_search_knowledge",
            { query: "   ", repoRoot: "/repo" },
            { repoRoot: "/repo", graph: multiTargetGraph, skipTelemetry: true },
          ),
        )
        match(whitespaceExit)
          .with({ _tag: "Failure" }, () => {
            expect(true).toBe(true)
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected whitespace-only query to fail Schema validation")
          })
          .exhaustive()

        const invokedNames: Array<string> = []
        const mixedSyncLayer = makeMockOmnigraphSyncLayer((name) => {
          invokedNames.push(name)
          if (name === "rank_patterns_vector_hybrid") {
            return Effect.fail(new OmnigraphLoadError({ cause: "pattern vector index busy" }))
          }
          if (name === "rank_patterns_bm25") {
            return Effect.succeed({
              source: "omnigraph" as const,
              degraded: false as const,
              rows: [
                {
                  slug: "errors",
                  path: "agent-patterns/errors.md",
                  title: "Typed Errors Pattern",
                  summary: "Use Schema.TaggedError for explicit failures and retries.",
                  score: 8.5,
                },
              ],
            })
          }
          if (name === "search_adrs_vector_hybrid") {
            return Effect.succeed({
              source: "omnigraph" as const,
              degraded: false as const,
              rows: [
                {
                  id: "harness:ADR-0025",
                  title: "Unrelated Storage Note",
                  path: "libs/harness/docs/adr/0025.md",
                  searchText: "Database connection pooling defaults.",
                },
              ],
            })
          }
          return Effect.succeed({
            source: "omnigraph" as const,
            degraded: false as const,
            rows: [
              {
                id: "harness:SPEC-0031::REQ-2.3",
                specId: "harness:SPEC-0031",
                requirementId: "REQ-2.3",
                area: "Embedding Sync",
                clauseText: "Validate Schema.TaggedError boundaries during embedding sync.",
                effectSymbol: "GraphEmbeddings.sync",
                path: "libs/harness/docs/specs/0031.md",
              },
            ],
          })
        })

        const mixedRes = yield* executeSearchKnowledgeTool(
          {
            query: "Typed Errors Pattern Schema.TaggedError",
            repoRoot: "/repo",
          },
          {
            repoRoot: "/repo",
            graph: multiTargetGraph,
            skipTelemetry: true,
            embeddingClientLayer: makeEmbeddingLayer({ availability: "available" }),
            omnigraphSyncLayer: mixedSyncLayer,
          },
        )
        expect(invokedNames).toContain("search_adrs_vector_hybrid")
        expect(invokedNames).toContain("search_requirements_vector_hybrid")
        expect(mixedRes.retrievalMode).toBe("bm25-only")
        expect(mixedRes.hits[0]?.nodeKey).toBe("PatternDoc:errors")

        const reqHit = mixedRes.hits.find((h) => h.nodeKind === "EarsRequirement")
        expect(reqHit?.linkedSymbols).not.toContain("harness:SPEC-0031::REQ-2.3")
        expect(reqHit?.linkedSymbols).toContain("EffectFn:libs/harness/graph/src/extra.ts#extraFn")

        const { spans: searchSpans } = yield* runWithTestTracer(
          "mcp.search.budget",
          executeSearchKnowledgeTool(
            { query: "Schema.TaggedError", kinds: ["PatternDoc"], repoRoot: "/repo" },
            {
              repoRoot: "/repo",
              graph: multiTargetGraph,
              skipTelemetry: true,
              skipOmnigraphSpawn: true,
              embeddingClientLayer: makeEmbeddingLayer({ availability: "unavailable" }),
            },
          ),
          new Map(),
        )
        const { spans: docSpans } = yield* runWithTestTracer(
          "mcp.doctree.budget",
          executeDocTreeTool(
            { mode: "tree", path: "libs/harness/docs/adr/0025.md", repoRoot: "/repo" },
            {
              repoRoot: "/repo",
              graph: multiTargetGraph,
              skipTelemetry: true,
              workspaceFsLayer: fsLayer,
            },
          ),
          new Map(),
        )
        const combinedSpans = [...searchSpans, ...docSpans]
        expect(combinedSpans.some((s) => s.name === "HarnessMcp.searchKnowledge")).toBe(true)
        expect(combinedSpans.some((s) => s.name === "HarnessMcp.docTree")).toBe(true)
        const spanSamples: ReadonlyArray<SpanSample> = combinedSpans.map((s) => ({
          spanId: s.spanId,
          name: s.name,
          parentSpanId: s.parentSpanId,
          durationMs: s.durationMs,
          startTimeMs: s.startTimeMs,
          endTimeMs: s.endTimeMs,
          exitTag: match(s.exitTag)
            .with("Success", () => "Success" as const)
            .with("Failure", () => "Failure" as const)
            .with("Defect", () => "Defect" as const)
            .with("Interrupt", () => "Failure" as const)
            .with(undefined, () => undefined)
            .exhaustive(),
          errorTag: s.errorTag,
        }))
        const violations = yield* decideSpanBudgets({ spans: spanSamples })
        expect(violations).toEqual([])
      }),
  )

  it("scores stopword-only and single-character queries as 0 while preserving 2-char technical identifiers", () => {
    const title = "D1 Repository Step"
    const body = "Any migration step for this task uses d1 SQLite client."
    expect(scoreLexicalBm25Lite(body, title, "Any step")).toBe(0)
    expect(scoreLexicalBm25Lite(body, title, "this task")).toBe(0)
    expect(scoreLexicalBm25Lite(body, title, "a")).toBe(0)
    expect(scoreLexicalBm25Lite(body, title, "d1")).toBeGreaterThan(0)
  })
})
