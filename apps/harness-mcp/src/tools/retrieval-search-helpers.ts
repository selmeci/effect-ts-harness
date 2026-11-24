import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  DocSummarySnippet,
  DocTreePath,
  EmbeddingNodeKey as EmbeddingNodeKeySchema,
  type EmbeddingNodeKind,
  type KnowledgeSearchHit,
  type KnowledgeSearchResult,
  LinkedGraphSymbolKey,
  RetrievalMatchTitle,
  SimilarityScore,
  toErrorReasonMessage,
} from "@harness/contract"
import { type HarnessGraph, scoreLexicalBm25Lite } from "@harness/graph"

/** Push a non-blank, distinct degradation reason onto the ordered list. */
export const pushDistinctReason = (reasons: Array<string>, raw: string | undefined): void => {
  const trimmed = raw?.trim()
  if (trimmed !== undefined && trimmed.length > 0 && !reasons.includes(trimmed)) {
    reasons.push(trimmed)
  }
}

/** Return true when the active in-memory graph contains at least one node matching `kind` and `statusFilter`. */
export const graphHasNodesForKind = (
  graph: HarnessGraph,
  kind: EmbeddingNodeKind,
  statusFilter: string,
): boolean => {
  for (const [, node] of Graph.nodes(graph.graph)) {
    const matched = match(node)
      .with({ _tag: "PatternDoc" }, () => kind === "PatternDoc")
      .with(
        { _tag: "AdrDoc" },
        (adr) => kind === "AdrDoc" && (statusFilter === "*" || adr.status === statusFilter),
      )
      .with(
        { _tag: "EarsRequirement" },
        (req) =>
          kind === "EarsRequirement" && (statusFilter === "*" || req.status === statusFilter),
      )
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
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => false,
      )
      .exhaustive()
    if (matched) return true
  }
  return false
}

export const collectLinkedSymbols = (
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

export const mapRowToHit = (
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

export interface BuildKnowledgeSearchResultInput {
  readonly anyLexicalFallback: boolean
  readonly anyBm25Fallback: boolean
  readonly degradedReasons: ReadonlyArray<string>
  readonly hits: ReadonlyArray<KnowledgeSearchHit>
}

/** Couple `retrievalMode` and non-null `degradedReason` into the validated `KnowledgeSearchResult` union. */
export const buildKnowledgeSearchResult = (
  input: BuildKnowledgeSearchResultInput,
): KnowledgeSearchResult => {
  if (input.anyLexicalFallback) {
    return {
      retrievalMode: "lexical-fallback",
      degradedReason: toErrorReasonMessage(
        input.degradedReasons.join("; "),
        "Omnigraph query unavailable; operating in lexical-fallback mode",
      ),
      hits: input.hits,
    }
  }
  if (input.anyBm25Fallback) {
    return {
      retrievalMode: "bm25-only",
      degradedReason: toErrorReasonMessage(
        input.degradedReasons.join("; "),
        "Embedding retrieval unavailable; operating in bm25-only mode",
      ),
      hits: input.hits,
    }
  }
  return {
    retrievalMode: "hybrid-rrf",
    degradedReason: null,
    hits: input.hits,
  }
}
