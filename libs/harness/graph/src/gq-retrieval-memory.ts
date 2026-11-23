import * as Graph from "effect/Graph"
import { compareCodeUnits } from "@harness/contract"
import { match } from "ts-pattern"
import { classifyOntologyNode } from "./archimate-ontology.js"
import type { HarnessGqQueryName } from "./gq-query-descriptors.js"
import type { HarnessGraph } from "./model.js"

const getQueryStringParam = (
  params: Readonly<Record<string, unknown>> | undefined,
  key: string,
  defaultValue = "",
): string => {
  const val = params?.[key]
  if (typeof val === "string") return val
  if (typeof val === "number" || typeof val === "boolean") return `${val}`
  return defaultValue
}

const getTextQueryParam = (params: Readonly<Record<string, unknown>> | undefined): string =>
  getQueryStringParam(params, "textQuery") || getQueryStringParam(params, "query")

const RETRIEVAL_STOPWORDS = new Set([
  "any",
  "all",
  "and",
  "are",
  "for",
  "from",
  "into",
  "step",
  "task",
  "that",
  "the",
  "this",
  "with",
])

export const tokenizeRetrievalText = (text: string): ReadonlyArray<string> =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !RETRIEVAL_STOPWORDS.has(token))

const scorePhraseMatch = (titleLower: string, haystackLower: string, phrase: string): number => {
  if (titleLower.includes(phrase)) return 3.0
  if (haystackLower.includes(phrase)) return 2.0
  return 0
}

const scoreTokenFrequency = (hayTokens: ReadonlyArray<string>, token: string): number => {
  let tf = 0
  for (const hTok of hayTokens) {
    if (hTok === token) {
      tf += 1
      continue
    }
    if (
      hTok.length >= 3 &&
      token.length >= 3 &&
      (hTok.startsWith(token) || token.startsWith(hTok))
    ) {
      tf += 0.5
    }
  }
  return tf
}

export const scoreLexicalBm25Lite = (haystack: string, title: string, query: string): number => {
  const trimmed = query.trim().toLowerCase()
  if (trimmed.length === 0) return 0
  const haystackLower = haystack.toLowerCase()
  const titleLower = title.toLowerCase()
  const queryTokens = [...new Set(tokenizeRetrievalText(trimmed))]
  if (queryTokens.length === 0) return 0

  const hayTokens = tokenizeRetrievalText(haystack)
  const docLenNorm = Math.max(1, Math.log2(hayTokens.length + 2))
  let score = scorePhraseMatch(titleLower, haystackLower, trimmed)

  for (const token of queryTokens) {
    const tf = scoreTokenFrequency(hayTokens, token)
    if (tf > 0) {
      const saturatedTf = (tf * 2.2) / (tf + 1.2)
      const titleBonus = titleLower.includes(token) ? 0.6 : 0
      score += saturatedTf / docLenNorm + titleBonus
    }
  }

  return Number(score.toFixed(6))
}

export const executePatternRankMemory = (
  harnessGraph: HarnessGraph,
  query: string,
  targetLayer: string,
): ReadonlyArray<Record<string, unknown>> => {
  const scored: Array<{
    readonly key: string
    readonly score: number
    readonly row: Record<string, unknown>
  }> = []
  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    match(node)
      .with({ _tag: "PatternDoc" }, (p) => {
        const ont = classifyOntologyNode(p)
        if (targetLayer !== "*" && ont.layer !== targetLayer) return
        const fullText = `${p.slug} ${p.title ?? ""} ${(p.headings ?? []).join(" ")} ${p.summary}`
        const score = scoreLexicalBm25Lite(fullText, `${p.slug} ${p.title ?? ""}`, query)
        if (score > 0) {
          scored.push({
            key: p.slug,
            score,
            row: {
              slug: p.slug,
              path: p.path,
              title: p.title ?? null,
              summary: p.summary,
              score,
            },
          })
        }
      })
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }
  return scored
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.key, b.key))
    .slice(0, 8)
    .map((entry) => entry.row)
}

export const executeAdrSearchMemory = (
  harnessGraph: HarnessGraph,
  query: string,
  statusFilter: string,
): ReadonlyArray<Record<string, unknown>> => {
  const scored: Array<{
    readonly key: string
    readonly score: number
    readonly row: Record<string, unknown>
  }> = []
  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    match(node)
      .with({ _tag: "AdrDoc" }, (adr) => {
        if (statusFilter !== "*" && adr.status !== statusFilter) return
        const text = adr.searchText ?? `${adr.title} ${adr.summary ?? ""}`
        const score = scoreLexicalBm25Lite(text, `${adr.id} ${adr.title}`, query)
        if (score > 0) {
          scored.push({
            key: adr.id,
            score,
            row: {
              id: adr.id,
              title: adr.title,
              status: adr.status,
              path: adr.path,
              searchText: text,
              score,
            },
          })
        }
      })
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }
  return scored
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.key, b.key))
    .slice(0, 10)
    .map((entry) => entry.row)
}

export const executeRequirementSearchMemory = (
  harnessGraph: HarnessGraph,
  query: string,
  statusFilter: string,
): ReadonlyArray<Record<string, unknown>> => {
  const scored: Array<{
    readonly key: string
    readonly score: number
    readonly row: Record<string, unknown>
  }> = []
  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    match(node)
      .with({ _tag: "EarsRequirement" }, (req) => {
        if (statusFilter !== "*" && req.status !== statusFilter) return
        const fullText = `${req.id} ${req.area} ${req.pattern} ${req.clauseText} ${req.effectSymbol}`
        const score = scoreLexicalBm25Lite(fullText, `${req.requirementId} ${req.area}`, query)
        if (score > 0) {
          scored.push({
            key: req.id,
            score,
            row: {
              id: req.id,
              specId: req.specId,
              requirementId: req.requirementId,
              area: req.area,
              pattern: req.pattern,
              clauseText: req.clauseText,
              effectSymbol: req.effectSymbol,
              path: req.path,
              line: req.line,
              status: req.status,
              score,
            },
          })
        }
      })
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }
  return scored
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.key, b.key))
    .slice(0, 10)
    .map((entry) => entry.row)
}

export const executeRetrievalMemoryQuery = (
  harnessGraph: HarnessGraph,
  name: Extract<
    HarnessGqQueryName,
    | "rank_patterns_hybrid"
    | "rank_patterns_vector_hybrid"
    | "rank_patterns_bm25"
    | "search_adrs_vector_hybrid"
    | "search_adrs_bm25"
    | "search_requirements_vector_hybrid"
    | "search_requirements_bm25"
  >,
  params?: Readonly<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  match(name)
    .with("rank_patterns_hybrid", "rank_patterns_vector_hybrid", "rank_patterns_bm25", () =>
      executePatternRankMemory(
        harnessGraph,
        getTextQueryParam(params),
        getQueryStringParam(params, "targetLayer", "*"),
      ),
    )
    .with("search_adrs_vector_hybrid", "search_adrs_bm25", () =>
      executeAdrSearchMemory(
        harnessGraph,
        getTextQueryParam(params),
        getQueryStringParam(params, "status", "*"),
      ),
    )
    .with("search_requirements_vector_hybrid", "search_requirements_bm25", () =>
      executeRequirementSearchMemory(
        harnessGraph,
        getTextQueryParam(params),
        getQueryStringParam(params, "status", "*"),
      ),
    )
    .exhaustive()
