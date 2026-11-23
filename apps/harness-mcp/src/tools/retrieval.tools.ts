import * as path from "node:path"
import * as Graph from "effect/Graph"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  DocSummarySnippet,
  DocTreeInput,
  DocTreePath,
  DocTreePathError,
  type DocTreeResponse,
  type EmbeddingNodeKey,
  EmbeddingNodeKey as EmbeddingNodeKeySchema,
  type EmbeddingNodeKind,
  isPureInterruptCause,
  type KnowledgeSearchHit,
  KnowledgeSearchInput,
  type KnowledgeSearchResult,
  KnowledgeQueryText,
  LinkedGraphSymbolKey,
  type RetrievalMode,
  RetrievalMatchTitle,
  SimilarityScore,
  toErrorReasonMessage,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  executeNamedGqQueryInMemory,
  type HarnessGqQueryName,
  type HarnessGraph,
  inspectDocTree,
  invokeOmnigraphNamedQuery,
  makeOmnigraphSyncLayer,
  scoreLexicalBm25Lite,
} from "@harness/graph"
import { EmbeddingClient } from "@harness/service"
import { nodeSyncHostIo, OllamaEmbeddingClientLive, WorkspaceFsLive } from "@harness/infra"
import {
  isPathInsideRoot,
  McpToolName,
  type McpToolExecutionError,
  type McpToolPluginDescriptor,
  ProjectPathEscapeError,
  resolveDefaultRepoRoot,
  resolveGraphWithStatus,
  type ServerOptions,
} from "./mcp-helpers.js"

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
    Schema.Literals(["accepted", "proposed", "superseded", "deprecated"]).annotate({
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

export const resolveContainedRepoRoot = (
  rawRepoRoot: string | undefined,
  options?: ServerOptions,
): Effect.Effect<string, ProjectPathEscapeError> => {
  const boundaryRoot = options?.repoRoot ?? resolveDefaultRepoRoot(undefined, options)
  if (rawRepoRoot === undefined) {
    return Effect.succeed(boundaryRoot)
  }
  const trimmed = rawRepoRoot.trim()
  if (trimmed.length === 0 || !isPathInsideRoot(boundaryRoot, trimmed)) {
    return Effect.fail(
      new ProjectPathEscapeError({
        projectPath: rawRepoRoot,
        repoRoot: boundaryRoot,
        message: "repoRoot escapes configured workspace root",
      }),
    )
  }
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(boundaryRoot, trimmed)
  return Effect.succeed(resolved)
}

const collectLinkedSymbols = (
  graph: HarnessGraph,
  kind: EmbeddingNodeKind,
  rawId: string,
): ReadonlyArray<LinkedGraphSymbolKey> => {
  const symbols = new Set<string>()
  const addNonEmpty = (val: string | undefined) => {
    const trimmed = val?.trim()
    if (trimmed && trimmed !== "—" && trimmed !== rawId) symbols.add(trimmed)
  }

  for (const [nodeIdx, node] of Graph.nodes(graph.graph)) {
    match(node)
      .with({ _tag: "PatternDoc" }, (p) => {
        if (kind === "PatternDoc" && p.slug === rawId) {
          for (const s of p.coveredSpans ?? []) addNonEmpty(s)
          for (const t of p.coveredTags ?? []) addNonEmpty(t)
        }
      })
      .with({ _tag: "AdrDoc" }, (adr) => {
        if (kind === "AdrDoc" && adr.id === rawId) {
          for (const s of adr.governedSymbols ?? []) addNonEmpty(s)
          for (const s of adr.referencedSpans ?? []) addNonEmpty(s)
          for (const s of adr.referencedServices ?? []) addNonEmpty(s)
          for (const s of adr.referencedErrors ?? []) addNonEmpty(s)
        }
      })
      .with({ _tag: "EarsRequirement" }, (req) => {
        if (kind === "EarsRequirement" && req.id === rawId) {
          addNonEmpty(req.effectSymbol)
        }
      })
      .with({ _tag: "TraceabilityTuple" }, (tt) => {
        const matchesAdr = kind === "AdrDoc" && tt.adrId === rawId
        const matchesReq =
          kind === "EarsRequirement" &&
          tt.earsSpecId !== undefined &&
          `${tt.earsSpecId}::${tt.requirementId ?? ""}` === rawId
        if (matchesAdr || matchesReq) {
          addNonEmpty(tt.targetSymbolQualname)
          for (const edgeIdx of Graph.outgoingEdges(graph.graph, nodeIdx)) {
            match(Graph.getEdge(graph.graph, edgeIdx))
              .with({ _tag: "Some" }, ({ value: edge }) => {
                const role: string = edge.data.role
                match(role)
                  .with("specified-target", "realizing-symbol", () =>
                    addNonEmpty(edge.data.entityKey),
                  )
                  .otherwise(() => undefined)
              })
              .with({ _tag: "None" }, () => undefined)
              .exhaustive()
          }
        }
      })
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "EarsSpec" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }

  return [...symbols]
    .sort(compareCodeUnits)
    .slice(0, 12)
    .map((s) => LinkedGraphSymbolKey.make(s))
}

const mapRowToHit = (
  graph: HarnessGraph,
  kind: EmbeddingNodeKind,
  row: Readonly<Record<string, unknown>>,
  rankIndex: number,
  trimmedQuery: string,
): KnowledgeSearchHit | undefined => {
  if (typeof row["score"] === "number" && (!Number.isFinite(row["score"]) || row["score"] <= 0)) {
    return undefined
  }
  const scoreWithLexicalTieBreak = (lexicalText: string, titleText: string): SimilarityScore => {
    const rankRrf = 1 / (60 + rankIndex)
    const lexicalSignal = scoreLexicalBm25Lite(lexicalText, titleText, trimmedQuery)
    const boundedLexicalBonus = Math.min(1, lexicalSignal / 10) * 0.005
    return SimilarityScore.make(Number((rankRrf + boundedLexicalBonus).toFixed(6)))
  }

  return match(kind)
    .with("PatternDoc", () => {
      const slug = typeof row["slug"] === "string" ? row["slug"].trim() : ""
      if (!slug) return undefined
      const title =
        typeof row["title"] === "string" && row["title"].trim().length > 0
          ? row["title"].trim()
          : slug
      const summary = typeof row["summary"] === "string" ? row["summary"].trim() : ""
      const pathStr =
        typeof row["path"] === "string" && row["path"].trim().length > 0
          ? row["path"].trim()
          : `agent-patterns/${slug}.md`
      const fullTitle = `${slug} ${title}`
      return {
        nodeKey: EmbeddingNodeKeySchema.make(`PatternDoc:${slug}`),
        nodeKind: "PatternDoc" as const,
        title: RetrievalMatchTitle.make(title),
        snippet: DocSummarySnippet.make(summary.slice(0, 420)),
        path: DocTreePath.make(pathStr),
        score: scoreWithLexicalTieBreak(`${fullTitle} ${summary} ${pathStr}`, fullTitle),
        linkedSymbols: collectLinkedSymbols(graph, "PatternDoc", slug),
      }
    })
    .with("AdrDoc", () => {
      const id = typeof row["id"] === "string" ? row["id"].trim() : ""
      if (!id) return undefined
      const title =
        typeof row["title"] === "string" && row["title"].trim().length > 0
          ? row["title"].trim()
          : id
      const searchText = typeof row["searchText"] === "string" ? row["searchText"].trim() : title
      const pathStr = typeof row["path"] === "string" ? row["path"].trim() : ""
      if (!pathStr) return undefined
      const displayTitle = `${id} · ${title}`
      return {
        nodeKey: EmbeddingNodeKeySchema.make(`AdrDoc:${id}`),
        nodeKind: "AdrDoc" as const,
        title: RetrievalMatchTitle.make(displayTitle),
        snippet: DocSummarySnippet.make(searchText.slice(0, 420)),
        path: DocTreePath.make(pathStr),
        score: scoreWithLexicalTieBreak(`${displayTitle} ${searchText}`, displayTitle),
        linkedSymbols: collectLinkedSymbols(graph, "AdrDoc", id),
      }
    })
    .with("EarsRequirement", () => {
      const id = typeof row["id"] === "string" ? row["id"].trim() : ""
      if (!id) return undefined
      const specId = typeof row["specId"] === "string" ? row["specId"].trim() : ""
      const reqId = typeof row["requirementId"] === "string" ? row["requirementId"].trim() : id
      const area = typeof row["area"] === "string" ? row["area"].trim() : ""
      const clauseText = typeof row["clauseText"] === "string" ? row["clauseText"].trim() : ""
      const effectSymbol = typeof row["effectSymbol"] === "string" ? row["effectSymbol"].trim() : ""
      const pathStr = typeof row["path"] === "string" ? row["path"].trim() : ""
      if (!pathStr) return undefined
      const title = area ? `${specId}#${reqId} (${area})` : `${specId}#${reqId}`
      return {
        nodeKey: EmbeddingNodeKeySchema.make(`EarsRequirement:${id}`),
        nodeKind: "EarsRequirement" as const,
        title: RetrievalMatchTitle.make(title),
        snippet: DocSummarySnippet.make(clauseText.slice(0, 420)),
        path: DocTreePath.make(pathStr),
        score: scoreWithLexicalTieBreak(`${title} ${clauseText} ${effectSymbol}`, title),
        linkedSymbols: collectLinkedSymbols(graph, "EarsRequirement", id),
      }
    })
    .exhaustive()
}

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
  let anyLexicalFallback = false
  let degradedReason: string | undefined
  let queryVector: ReadonlyArray<number> | undefined

  const embedClientCheckExit = yield* Effect.exit(
    Effect.gen(function* () {
      const client = yield* EmbeddingClient
      const availability = yield* client.checkAvailability
      return yield* match(availability)
        .with("available", () =>
          client
            .embedQuery(KnowledgeQueryText.make(trimmedQuery))
            .pipe(Effect.map((vec) => ({ ok: true as const, components: vec.components }))),
        )
        .with("unavailable", () =>
          Effect.succeed({
            ok: false as const,
            reason: `Embedding provider unavailable for ${client.config.model}; degrading to BM25`,
          }),
        )
        .exhaustive()
    }).pipe(Effect.provide(embeddingLayer)),
  )

  yield* match(embedClientCheckExit)
    .with({ _tag: "Success" }, ({ value }) => {
      if (value.ok) {
        queryVector = value.components
      } else {
        anyBm25Fallback = true
        degradedReason = value.reason
      }
      return Effect.void
    })
    .with({ _tag: "Failure" }, ({ cause }) => {
      if (isPureInterruptCause(cause)) return Effect.interrupt
      anyBm25Fallback = true
      const errOpt = Cause.findErrorOption(cause)
      degradedReason = match(errOpt)
        .with(
          { _tag: "Some" },
          ({ value }) => `Embedding query failed: ${toErrorReasonMessage(value, "Provider error")}`,
        )
        .with(
          { _tag: "None" },
          () =>
            `Embedding query failed: ${toErrorReasonMessage(Cause.squash(cause), "Unexpected defect")}`,
        )
        .exhaustive()
      return Effect.void
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
        Effect.catchCause((cause) => {
          if (isPureInterruptCause(cause)) return Effect.interrupt
          const msg = toErrorReasonMessage(Cause.squash(cause), "Omnigraph query unavailable")
          return Effect.succeed({
            source: "memory-fallback" as const,
            rows: executeNamedGqQueryInMemory(graphStatus.graph, queryName, params),
            degraded: true as const,
            fallbackError: msg,
          })
        }),
      )

    if (queryVector !== undefined) {
      const vecRes = yield* runKindQuery(
        querySpec.vectorHybrid,
        querySpec.buildVectorParams(queryVector, trimmedQuery, statusFilter),
      )
      if (vecRes.source === "omnigraph") {
        addRowsForKind(kind, vecRes.rows)
        continue
      }
      const bm25FallbackAttempt = yield* runKindQuery(
        querySpec.bm25,
        querySpec.buildBm25Params(trimmedQuery, statusFilter),
      )
      if (bm25FallbackAttempt.source === "omnigraph") {
        anyBm25Fallback = true
        degradedReason = degradedReason ?? `Vector hybrid unavailable: ${vecRes.fallbackError}`
      } else {
        anyLexicalFallback = true
        degradedReason = degradedReason ?? bm25FallbackAttempt.fallbackError
      }
      addRowsForKind(kind, bm25FallbackAttempt.rows)
      continue
    }

    const bm25Res = yield* runKindQuery(
      querySpec.bm25,
      querySpec.buildBm25Params(trimmedQuery, statusFilter),
    )
    if (bm25Res.source === "memory-fallback") {
      anyLexicalFallback = true
      degradedReason = degradedReason ?? bm25Res.fallbackError
    }
    addRowsForKind(kind, bm25Res.rows)
  }

  const retrievalMode: RetrievalMode = anyLexicalFallback
    ? "lexical-fallback"
    : anyBm25Fallback
      ? "bm25-only"
      : "hybrid-rrf"

  const rankedHits = [...hitsByKey.values()]
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.nodeKey, b.nodeKey))
    .slice(0, limit)

  return {
    retrievalMode,
    degradedReason:
      degradedReason !== undefined
        ? toErrorReasonMessage(degradedReason, "Retrieval degraded")
        : null,
    hits: rankedHits,
  }
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

  const decodedDocInput = yield* Schema.decodeEffect(DocTreeInput)({
    mode,
    ...(trimmedPath !== undefined && trimmedPath.length > 0 ? { path: trimmedPath } : {}),
    ...(trimmedSectionId !== undefined && trimmedSectionId.length > 0
      ? { sectionId: trimmedSectionId }
      : {}),
    ...(trimmedScope !== undefined && trimmedScope.length > 0 ? { scope: trimmedScope } : {}),
  })

  const exit = yield* Effect.exit(
    inspectDocTree({
      repoRoot: WorkspaceFilePath.make(root),
      input: decodedDocInput,
      graph: graphStatus.graph,
    }).pipe(Effect.provide(fsLayer)),
  )

  return yield* match(exit)
    .with({ _tag: "Success" }, ({ value }) => Effect.succeed(value))
    .with({ _tag: "Failure" }, ({ cause }) => {
      if (isPureInterruptCause(cause)) return Effect.interrupt
      const errOpt = Cause.findErrorOption(cause)
      return match(errOpt)
        .with({ _tag: "Some" }, ({ value }) => Effect.fail(value))
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new DocTreePathError({
              requestedPath: DocTreePath.make(trimmedPath || "<catalog>"),
              reason: toErrorReasonMessage(Cause.squash(cause), "DocTree inspection failed"),
            }),
          ),
        )
        .exhaustive()
    })
    .exhaustive()
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
