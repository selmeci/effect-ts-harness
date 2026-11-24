import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  DocTreeInput,
  type DocTreeResponse,
  type EmbeddingNodeKey,
  type EmbeddingNodeKind,
  type KnowledgeSearchHit,
  KnowledgeSearchInput,
  type KnowledgeSearchResult,
  KnowledgeQueryText,
  toErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  executeNamedGqQueryInMemory,
  type HarnessGqQueryName,
  inspectDocTree,
  invokeOmnigraphNamedQuery,
  makeOmnigraphSyncLayer,
} from "@harness/graph"
import { EmbeddingClient } from "@harness/service"
import { nodeSyncHostIo, OllamaEmbeddingClientLive, WorkspaceFsLive } from "@harness/infra"
import {
  graphStatusMeta,
  McpToolName,
  type McpToolExecutionError,
  type McpToolPluginDescriptor,
  resolveContainedRepoRoot,
  resolveGraphWithStatus,
  type ServerOptions,
} from "./mcp-helpers.js"
import {
  buildKnowledgeSearchResult,
  graphHasNodesForKind,
  mapRowToHit,
  pushDistinctReason,
} from "./retrieval-search-helpers.js"

const BoundedQuery = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(1, 4096)),
  Schema.check(Schema.isPattern(/\S/)),
)
const BoundedRepoRoot = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(1, 1024)),
  Schema.check(Schema.isPattern(/\S/)),
)
const BoundedPath = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(1, 512)),
  Schema.check(Schema.isPattern(/\S/)),
)

const ALL_SEARCH_KINDS: ReadonlyArray<EmbeddingNodeKind> = [
  "PatternDoc",
  "AdrDoc",
  "EarsRequirement",
]

const SearchKnowledgeInputSchema = Schema.Struct({
  query: BoundedQuery.annotate({
    description:
      "Natural-language query for PatternDoc, AdrDoc, and EarsRequirement knowledge retrieval",
  }),
  kinds: Schema.optional(
    Schema.Array(Schema.Literals(["PatternDoc", "AdrDoc", "EarsRequirement"]))
      .pipe(Schema.check(Schema.isMaxLength(3)))
      .annotate({
        description: "Optional filter restricting node kinds returned",
      }),
  ),
  status: Schema.optional(
    Schema.Literals(["draft", "accepted", "proposed", "superseded", "deprecated"]).annotate({
      description: "Optional lifecycle status filter for AdrDoc and EarsRequirement",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 30 }))).annotate({
      description: "Maximum number of ranked hits to return (default 8)",
    }),
  ),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const DocTreeToolInputSchema = Schema.Struct({
  mode: Schema.optional(
    Schema.Literals(["catalog", "tree", "section"]).annotate({
      description:
        "Inspection mode: catalog (default), tree (headings), or section (bounded slice)",
    }),
  ),
  path: Schema.optional(
    BoundedPath.annotate({
      description: "Repo-relative markdown/text path required for tree and section modes",
    }),
  ),
  sectionId: Schema.optional(
    BoundedPath.annotate({
      description: "Heading sectionId (e.g. h2-3) required for section mode",
    }),
  ),
  scope: Schema.optional(
    BoundedPath.annotate({
      description: "Optional scope filter for catalog mode (e.g. harness, es, sample)",
    }),
  ),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const decodeSearchKnowledgeInput = Schema.decodeUnknownEffect(SearchKnowledgeInputSchema)
const decodeDocTreeToolInput = Schema.decodeUnknownEffect(DocTreeToolInputSchema)

export type SearchKnowledgeRawArgs = typeof SearchKnowledgeInputSchema.Type
export type DocTreeRawArgs = typeof DocTreeToolInputSchema.Type

interface EmbedProbeReady {
  readonly _tag: "Ready"
  readonly components: ReadonlyArray<number>
}

interface EmbedProbeUnavailable {
  readonly _tag: "Unavailable"
  readonly reason: string
}

type EmbedProbeOutcome = EmbedProbeReady | EmbedProbeUnavailable

const getQueryNamesForKind = (
  kind: EmbeddingNodeKind,
): {
  readonly vectorHybrid: HarnessGqQueryName
  readonly bm25: HarnessGqQueryName
  readonly buildVectorParams: (
    vector: ReadonlyArray<number>,
    textQuery: string,
    status: string,
  ) => Readonly<Record<string, unknown>>
  readonly buildBm25Params: (textQuery: string, status: string) => Readonly<Record<string, unknown>>
} =>
  match(kind)
    .with("PatternDoc", () => ({
      vectorHybrid: "rank_patterns_vector_hybrid" as const,
      bm25: "rank_patterns_bm25" as const,
      buildVectorParams: (vector: ReadonlyArray<number>, textQuery: string) => ({
        vectorQuery: [...vector],
        textQuery,
        targetLayer: "*",
      }),
      buildBm25Params: (query: string) => ({ query, targetLayer: "*" }),
    }))
    .with("AdrDoc", () => ({
      vectorHybrid: "search_adrs_vector_hybrid" as const,
      bm25: "search_adrs_bm25" as const,
      buildVectorParams: (vector: ReadonlyArray<number>, textQuery: string, status: string) => ({
        vectorQuery: [...vector],
        textQuery,
        status,
      }),
      buildBm25Params: (query: string, status: string) => ({ query, status }),
    }))
    .with("EarsRequirement", () => ({
      vectorHybrid: "search_requirements_vector_hybrid" as const,
      bm25: "search_requirements_bm25" as const,
      buildVectorParams: (vector: ReadonlyArray<number>, textQuery: string, status: string) => ({
        vectorQuery: [...vector],
        textQuery,
        status,
      }),
      buildBm25Params: (query: string, status: string) => ({ query, status }),
    }))
    .exhaustive()

export const executeSearchKnowledgeTool = Effect.fn("HarnessMcp.searchKnowledge")(function* (
  input: SearchKnowledgeRawArgs,
  options?: ServerOptions,
): Effect.fn.Return<KnowledgeSearchResult, McpToolExecutionError> {
  const root = yield* resolveContainedRepoRoot(input.repoRoot, options)
  const decodedSearchInput = yield* Schema.decodeEffect(KnowledgeSearchInput)({
    query: input.query.trim(),
    ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  })
  const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, input)
  const targetKinds =
    decodedSearchInput.kinds && decodedSearchInput.kinds.length > 0
      ? [...new Set(decodedSearchInput.kinds)]
      : ALL_SEARCH_KINDS
  const statusFilter = decodedSearchInput.status ?? "*"
  const limit = decodedSearchInput.limit ?? 8
  const trimmedQuery = decodedSearchInput.query
  const syncLayer = options?.omnigraphSyncLayer ?? makeOmnigraphSyncLayer(nodeSyncHostIo)
  const embeddingLayer = options?.embeddingClientLayer ?? OllamaEmbeddingClientLive
  const skipOmnigraph =
    (options?.skipOmnigraphSpawn === true ||
      (options?.graph !== undefined && options?.skipOmnigraphSpawn !== false)) &&
    !process.env["OMNIGRAPH_URL"] &&
    options?.omnigraphSyncLayer === undefined

  let anyBm25Fallback = false
  let anyLexicalFallback = graphStatus.degraded
  const degradedReasons: Array<string> = []
  if (graphStatus.degraded) {
    pushDistinctReason(degradedReasons, graphStatus.degradedReason ?? "degraded-graph-snapshot")
  }
  let queryVector: ReadonlyArray<number> | undefined

  const embedResult = yield* Effect.gen(function* () {
    const client = yield* EmbeddingClient
    const availability = yield* client.checkAvailability
    return yield* match(availability)
      .with({ _tag: "Available" }, () =>
        client.embedQuery(KnowledgeQueryText.make(trimmedQuery)).pipe(
          Effect.map((vec): EmbedProbeOutcome => ({
            _tag: "Ready",
            components: vec.components,
          })),
        ),
      )
      .with({ _tag: "Unavailable" }, ({ cause, reason }) =>
        Effect.succeed<EmbedProbeOutcome>({
          _tag: "Unavailable",
          reason: `Embedding provider unavailable (${cause}) for ${client.config.model}: ${reason}; degrading to BM25`,
        }),
      )
      .exhaustive()
  }).pipe(
    Effect.provide(embeddingLayer),
    Effect.catch((err) =>
      Effect.succeed<EmbedProbeOutcome>({
        _tag: "Unavailable",
        reason: `Embedding query failed: ${toErrorReasonMessage(err, "Provider error")}`,
      }),
    ),
  )

  match(embedResult)
    .with({ _tag: "Ready" }, ({ components }) => {
      queryVector = components
    })
    .with({ _tag: "Unavailable" }, ({ reason }) => {
      anyBm25Fallback = true
      pushDistinctReason(degradedReasons, reason)
    })
    .exhaustive()

  const hitsByKey = new Map<EmbeddingNodeKey, KnowledgeSearchHit>()
  const addRowsForKind = (
    kind: EmbeddingNodeKind,
    rows: ReadonlyArray<Record<string, unknown>>,
  ) => {
    for (let idx = 0; idx < rows.length; idx++) {
      const hit = mapRowToHit(graphStatus.graph, kind, rows[idx]!, idx, trimmedQuery)
      if (hit === undefined) continue
      const existing = hitsByKey.get(hit.nodeKey)
      if (existing === undefined || hit.score > existing.score) {
        hitsByKey.set(hit.nodeKey, hit)
      }
    }
  }

  for (const kind of targetKinds) {
    const querySpec = getQueryNamesForKind(kind)
    const runKindQuery = (
      queryName: HarnessGqQueryName,
      params: Readonly<Record<string, unknown>>,
    ) =>
      invokeOmnigraphNamedQuery({
        repoRoot: root,
        actor: "agent-mcp",
        name: queryName,
        params,
        fallbackGraph: graphStatus.graph,
        ...(skipOmnigraph ? { baseUrl: "http://127.0.0.1:1" } : {}),
      }).pipe(
        Effect.provide(syncLayer),
        Effect.catch((err) =>
          Effect.succeed({
            source: "memory-fallback" as const,
            rows: executeNamedGqQueryInMemory(graphStatus.graph, queryName, params),
            degraded: true as const,
            fallbackError: toErrorReasonMessage(err, "Omnigraph query unavailable"),
          }),
        ),
      )

    const runBm25WithReason = (reasonForOmnigraphBm25?: string) =>
      runKindQuery(querySpec.bm25, querySpec.buildBm25Params(trimmedQuery, statusFilter)).pipe(
        Effect.map((bm25Res) => {
          match(bm25Res)
            .with({ source: "omnigraph" }, () => {
              anyBm25Fallback = true
              pushDistinctReason(degradedReasons, reasonForOmnigraphBm25)
            })
            .with({ source: "memory-fallback" }, ({ fallbackError }) => {
              anyLexicalFallback = true
              pushDistinctReason(degradedReasons, fallbackError)
            })
            .exhaustive()
          addRowsForKind(kind, bm25Res.rows)
        }),
      )

    if (queryVector !== undefined) {
      const vecRes = yield* runKindQuery(
        querySpec.vectorHybrid,
        querySpec.buildVectorParams(queryVector, trimmedQuery, statusFilter),
      )
      yield* match(vecRes)
        .with({ source: "omnigraph" }, ({ rows }) => {
          if (rows.length > 0) {
            addRowsForKind(kind, rows)
            return Effect.void
          }
          if (graphHasNodesForKind(graphStatus.graph, kind, statusFilter)) {
            return runBm25WithReason(
              `Omnigraph vector column unpopulated for ${kind}; operating in bm25-only mode`,
            )
          }
          return Effect.void
        })
        .with({ source: "memory-fallback" }, ({ fallbackError }) => {
          const vectorFailReason = `Vector hybrid unavailable for ${kind}: ${fallbackError}`
          pushDistinctReason(degradedReasons, vectorFailReason)
          return runBm25WithReason(vectorFailReason)
        })
        .exhaustive()
      continue
    }

    const bm25Res = yield* runKindQuery(
      querySpec.bm25,
      querySpec.buildBm25Params(trimmedQuery, statusFilter),
    )
    match(bm25Res)
      .with({ source: "omnigraph" }, () => undefined)
      .with({ source: "memory-fallback" }, ({ fallbackError }) => {
        anyLexicalFallback = true
        pushDistinctReason(degradedReasons, fallbackError)
      })
      .exhaustive()
    addRowsForKind(kind, bm25Res.rows)
  }

  const rankedHits = [...hitsByKey.values()]
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.nodeKey, b.nodeKey))
    .slice(0, limit)

  return buildKnowledgeSearchResult({
    anyLexicalFallback,
    anyBm25Fallback,
    degradedReasons,
    hits: rankedHits,
  })
})

export const executeDocTreeTool = Effect.fn("HarnessMcp.docTree")(function* (
  input: DocTreeRawArgs,
  options?: ServerOptions,
): Effect.fn.Return<DocTreeResponse, McpToolExecutionError> {
  const root = yield* resolveContainedRepoRoot(input.repoRoot, options)
  const mode = input.mode ?? "catalog"
  const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, input)
  const fsLayer = options?.workspaceFsLayer ?? WorkspaceFsLive

  const trimmedPath = input.path?.trim()
  const trimmedSectionId = input.sectionId?.trim()
  const trimmedScope = input.scope?.trim()

  const rawDocInput = match(mode)
    .with("catalog", (catalogMode) => ({
      mode: catalogMode,
      ...(trimmedScope !== undefined && trimmedScope.length > 0 ? { scope: trimmedScope } : {}),
    }))
    .with("tree", (treeMode) => ({
      mode: treeMode,
      ...(trimmedPath !== undefined && trimmedPath.length > 0 ? { path: trimmedPath } : {}),
    }))
    .with("section", (sectionMode) => ({
      mode: sectionMode,
      ...(trimmedPath !== undefined && trimmedPath.length > 0 ? { path: trimmedPath } : {}),
      ...(trimmedSectionId !== undefined && trimmedSectionId.length > 0
        ? { sectionId: trimmedSectionId }
        : {}),
    }))
    .exhaustive()

  const decodedDocInput = yield* Schema.decodeUnknownEffect(DocTreeInput)(rawDocInput)

  const docTreeRes = yield* inspectDocTree({
    repoRoot: WorkspaceFilePath.make(root),
    input: decodedDocInput,
    graph: graphStatus.graph,
  }).pipe(Effect.provide(fsLayer))
  if (mode === "catalog" && graphStatus.degraded) {
    return {
      ...docTreeRes,
      ...graphStatusMeta(graphStatus),
    }
  }
  return docTreeRes
})

export const buildRetrievalToolDescriptors = (
  options?: ServerOptions,
): ReadonlyArray<McpToolPluginDescriptor> => [
  {
    name: McpToolName.make("harness_search_knowledge"),
    description:
      "Search PatternDoc, AdrDoc, and EarsRequirement knowledge semantically via Omnigraph hybrid RRF (with explicit BM25/lexical fallback) and hydrate linked Effect graph symbols.",
    inputSchema: SearchKnowledgeInputSchema,
    execute: (args) =>
      decodeSearchKnowledgeInput(args).pipe(
        Effect.flatMap((decoded) => executeSearchKnowledgeTool(decoded, options)),
      ),
  },
  {
    name: McpToolName.make("harness_doc_tree"),
    description:
      "Inspect the deterministic governance catalog (all AdrDoc & EarsSpec entries) or navigate a large markdown/text file via heading tree and line-bounded section slices.",
    inputSchema: DocTreeToolInputSchema,
    execute: (args) =>
      decodeDocTreeToolInput(args).pipe(
        Effect.flatMap((decoded) => executeDocTreeTool(decoded, options)),
      ),
  },
]
