import { Option } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  type ArchiMateLayer,
  classifyOntologyNode,
  projectOntologyLayers,
  queryOntologyWhy,
} from "./archimate-ontology.js"
import { HARNESS_GQ_QUERIES_TEXT, HARNESS_PG_SCHEMA_TEXT } from "./gq-static-assets.js"
import { findCallees, findCallers, findTestsReaching, resolveNode } from "./graph-engine.js"
import type { HarnessGraph, ServiceLayerNode, ServiceTagNode } from "./model.js"

export const HARNESS_GQ_QUERY_NAMES = [
  "resolve_effect_fn",
  "find_service_providers",
  "find_callers",
  "find_callees",
  "find_tests_reaching",
  "ontology_layer_nodes",
  "ontology_governed_by",
  "untested_domain_fns",
  "resolve_effect_fn_fuzzy",
  "ontology_realized_by_doc",
  "rank_patterns_hybrid",
  "rank_candidate_services_for_stub",
  "policy_unverified_domain_fns",
  "policy_orphan_effect_signatures",
] as const

export type HarnessGqQueryName = (typeof HARNESS_GQ_QUERY_NAMES)[number]

export interface HarnessGqQueryDescriptor {
  readonly name: HarnessGqQueryName
  readonly description: string
  readonly params: ReadonlyArray<string>
  readonly source: string
}

export const HARNESS_GQ_QUERIES: Readonly<Record<HarnessGqQueryName, HarnessGqQueryDescriptor>> = {
  resolve_effect_fn: {
    name: "resolve_effect_fn",
    description:
      "Resolve an Effect function or symbol and return its properties and ArchiMate classification",
    params: ["spanOrQualname"],
    source: `query resolve_effect_fn($spanOrQualname: String) {
  match {
    $fn: EffectFn
    $fn.spanName = $spanOrQualname or $fn.qualname = $spanOrQualname
  }
  return {
    $fn.qualname,
    $fn.spanName,
    $fn.packageTag,
    $fn.file,
    $fn.line,
    $fn.successType,
    $fn.isStub,
    $fn.archimateLayer,
    $fn.archimateAspect,
    $fn.archimateElementType
  }
}`,
  },
  find_service_providers: {
    name: "find_service_providers",
    description: "Find all ServiceLayer implementations that provide a given ServiceTag",
    params: ["tagId"],
    source: `query find_service_providers($tagId: String) {
  match {
    $lf: LayerFlow
    $layer: ServiceLayer
    $tag: ServiceTag
    $lf playsProviderLayerRole $layer
    $lf playsProvidedServiceRole $tag
    $tag.tagId = $tagId or $tag.name = $tagId or $tag.qualname = $tagId
  }
  return {
    $layer.qualname as layerQualname,
    $layer.layerKind as layerKind,
    $layer.packageTag as packageTag,
    $layer.file as file,
    $tag.tagId as tagId
  }
}`,
  },
  find_callers: {
    name: "find_callers",
    description: "Find callers of an Effect function, service, or layer",
    params: ["target"],
    source: `query find_callers($target: String) {
  match {
    $sig: EffectSignature
    $caller: EffectFn
    $callee: EffectFn
    $sig playsCallerRole $caller
    $sig $rel:playsCalleeRole $callee
    $callee.qualname = $target or $callee.spanName = $target
  }
  return {
    $caller.qualname as caller,
    $rel.archimateRelation as rel,
    $callee.qualname as callee
  }
}`,
  },
  find_callees: {
    name: "find_callees",
    description: "Find callees of an Effect function, service, or layer",
    params: ["caller"],
    source: `query find_callees($caller: String) {
  match {
    $sig: EffectSignature
    $src: EffectFn
    $callee: EffectFn
    $sig playsCallerRole $src
    $sig $rel:playsCalleeRole $callee
    $src.qualname = $caller or $src.spanName = $caller
  }
  return {
    $src.qualname as src,
    $rel.archimateRelation as rel,
    $callee.qualname as callee
  }
}`,
  },
  find_tests_reaching: {
    name: "find_tests_reaching",
    description: "Find test cases reaching a given callee Effect function",
    params: ["callee"],
    source: `query find_tests_reaching($callee: String) {
  match {
    $tt: TraceabilityTuple
    $test: VitestCase
    $fn: EffectFn
    $tt playsExercisingTestRole $test
    $tt playsExercisedSpanRole $fn
    $fn.qualname = $callee or $fn.spanName = $callee
  }
  return {
    $test.testId as testId,
    $test.testFile as testFile,
    $test.testName as testName
  }
}`,
  },
  ontology_layer_nodes: {
    name: "ontology_layer_nodes",
    description: "Query all nodes projected onto a given ArchiMate layer",
    params: ["layer"],
    source: `query ontology_layer_nodes($layer: String) {
  match {
    $node: EffectFn
    $node.archimateLayer = $layer
  }
  return {
    $node
  }
}`,
  },
  ontology_governed_by: {
    name: "ontology_governed_by",
    description: "Query governing ADRs and realizing EARS specs for a symbol",
    params: ["symbol"],
    source: `query ontology_governed_by($symbol: String) {
  match {
    $tt: TraceabilityTuple
    $tt.targetSymbolQualname = $symbol
  }
  return {
    $tt.relationId as tupleId,
    $tt.adrId as adrId,
    $tt.earsSpecId as earsSpecId,
    $tt.requirementId as requirementId,
    $tt.earsPattern as earsPattern,
    $tt.targetSymbolQualname as targetQualname
  }
}`,
  },
  untested_domain_fns: {
    name: "untested_domain_fns",
    description: "Find all non-stub domain Effect functions that lack reaching test coverage",
    params: [],
    source: `query untested_domain_fns() {
  match {
    $fn: EffectFn
    ($fn.packageTag = "domain" or $fn.packageTag = "contract") and $fn.isStub = false
    not {
      $tt: TraceabilityTuple
      $test: VitestCase
      $tt playsExercisingTestRole $test
      $tt playsExercisedSpanRole $fn
    }
  }
  return {
    $fn.qualname as qualname,
    $fn.spanName as spanName,
    $fn.file as file
  }
}`,
  },
  resolve_effect_fn_fuzzy: {
    name: "resolve_effect_fn_fuzzy",
    description: "Typo-tolerant EffectFn resolution using Levenshtein fuzzy(..., 2) + BM25 ordering",
    params: ["query"],
    source: `query resolve_effect_fn_fuzzy($query: String) {
  match {
    $fn: EffectFn
    fuzzy($fn.spanName, $query, 2)
  }
  return {
    $fn.qualname,
    $fn.spanName,
    $fn.packageTag,
    $fn.file,
    $fn.line,
    $fn.isStub,
    bm25($fn.spanName, $query) as score
  }
  order { bm25($fn.spanName, $query) }
  limit 10
}`,
  },
  ontology_realized_by_doc: {
    name: "ontology_realized_by_doc",
    description: "Query all traceability tuples realizing a given AdrDoc or EarsSpec",
    params: ["docId"],
    source: `query ontology_realized_by_doc($docId: String) {
  match {
    $tt: TraceabilityTuple
    $tt.adrId = $docId or $tt.earsSpecId = $docId
  }
  return {
    $tt.relationId as tupleId,
    $tt.adrId as adrId,
    $tt.earsSpecId as earsSpecId,
    $tt.requirementId as requirementId,
    $tt.earsPattern as earsPattern,
    $tt.targetSymbolQualname as artifactQualname
  }
  order { $tt.targetSymbolQualname asc, $tt.relationId asc }
}`,
  },
  rank_patterns_hybrid: {
    name: "rank_patterns_hybrid",
    description: "Hybrid Scope-First, Rank-Second pattern routing for harness_route",
    params: ["query", "targetLayer"],
    source: `query rank_patterns_hybrid($query: String, $targetLayer: String) {
  match {
    $p: PatternDoc
    $p.archimateLayer = $targetLayer or $targetLayer = "*"
  }
  return {
    $p.slug as slug,
    $p.path as path,
    $p.title as title,
    $p.summary as summary
  }
  order { rrf(nearest($p.summaryEmbedding, $query), bm25($p.summary, $query)) }
  limit 8
}`,
  },
  rank_candidate_services_for_stub: {
    name: "rank_candidate_services_for_stub",
    description: "Hybrid Scope-First, Rank-Second ServiceTag discovery for stub<A, E, R>() hole completion",
    params: ["layer", "intent"],
    source: `query rank_candidate_services_for_stub($layer: String, $intent: String) {
  match {
    $svc: ServiceTag
    $svc.archimateLayer = $layer or $layer = "*"
  }
  return {
    $svc.tagId as tagId,
    $svc.qualname as qualname,
    $svc.file as file
  }
  order { rrf(nearest($svc.capabilityEmbedding, $intent), bm25($svc.name, $intent)) }
  limit 10
}`,
  },
  policy_unverified_domain_fns: {
    name: "policy_unverified_domain_fns",
    description: "GraphPolicy check: non-stub domain EffectFns lacking reaching test coverage",
    params: [],
    source: `query policy_unverified_domain_fns() {
  match {
    $fn: EffectFn
    $fn.packageTag = "domain" and $fn.isStub = false
    not {
      $tt: TraceabilityTuple
      $test: VitestCase
      $tt playsExercisingTestRole $test
      $tt playsExercisedSpanRole $fn
    }
  }
  return {
    $fn.qualname as qualname,
    $fn.spanName as spanName,
    $fn.file as file
  }
}`,
  },
  policy_orphan_effect_signatures: {
    name: "policy_orphan_effect_signatures",
    description: "GraphPolicy check: EffectSignature relation nodes missing a PlaysCallerRole edge",
    params: [],
    source: `query policy_orphan_effect_signatures() {
  match {
    $sig: EffectSignature
    not { $sig playsCallerRole $_ }
  }
  return {
    $sig.relationId as relationId,
    $sig.callerQualname as callerQualname,
    $sig.file as file
  }
}`,
  },
}

export const loadHarnessPgSchemaText = (): string => HARNESS_PG_SCHEMA_TEXT

export const loadHarnessGqQueriesText = (): string => HARNESS_GQ_QUERIES_TEXT

const levenshteinWithin2 = (a: string, b: string): number => {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 2) return Number.POSITIVE_INFINITY
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      curr.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > 2) return Number.POSITIVE_INFINITY
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0
  }
  const dist = prev[b.length] ?? Number.POSITIVE_INFINITY
  return dist <= 2 ? dist : Number.POSITIVE_INFINITY
}

const tokenizeFuzzy = (s: string): ReadonlyArray<string> =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[._\-#/\s]+/).filter((t) => t.length > 0)

const scoreFuzzyEffectFn = (
  spanName: string,
  qualname: string,
  query: string,
  queryTokens: ReadonlyArray<string>,
): number => {
  const spanLower = spanName.toLowerCase()
  const qualLower = qualname.toLowerCase()
  if (query === "" || spanLower === query || qualLower === query) return 1
  if (spanLower.includes(query) || qualLower.includes(query)) return 0.8
  const spanTokens = [spanLower, ...tokenizeFuzzy(spanName)]
  let minDist = Number.POSITIVE_INFINITY
  for (const qt of queryTokens.length > 0 ? queryTokens : [query]) {
    for (const st of spanTokens) {
      const d = levenshteinWithin2(qt, st)
      if (d < minDist) minDist = d
    }
  }
  return minDist <= 2 ? 1 / (1 + minDist) : 0
}

const getStringParam = (
  params: Readonly<Record<string, unknown>> | undefined,
  key: string,
  defaultValue = "",
): string => {
  const val = params?.[key]
  if (typeof val === "string") return val
  if (typeof val === "number" || typeof val === "boolean") return `${val}`
  return defaultValue
}

export const executeNamedGqQueryInMemory = (
  harnessGraph: HarnessGraph,
  name: HarnessGqQueryName,
  params?: Readonly<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  match(name)
    .with("resolve_effect_fn", () => {
      const spanOrQualname = getStringParam(params, "spanOrQualname")
      const node = resolveNode(harnessGraph, spanOrQualname)
      if (node) {
        const ont = classifyOntologyNode(node)
        return [
          {
            ...node,
            ...ont,
            archimateLayer: ont.layer,
            archimateAspect: ont.aspect,
            archimateElementType: ont.elementType,
          },
        ]
      }
      return []
    })
    .with("find_service_providers", () => {
      const tagIdParam = getStringParam(params, "tagId")
      const results: Array<Record<string, unknown>> = []
      const g = harnessGraph.graph
      for (const [nodeIdx, node] of Graph.nodes(g)) {
        match(node)
          .with({ _tag: "LayerFlow" }, () => {
            let layerNode: ServiceLayerNode | undefined
            const providedTags: Array<ServiceTagNode> = []
            for (const edgeIdx of Graph.outgoingEdges(g, nodeIdx)) {
              const edge = Option.getOrUndefined(Graph.getEdge(g, edgeIdx))
              if (edge === undefined) continue
              const target = Option.getOrUndefined(Graph.getNode(g, edge.target))
              if (target === undefined) continue
              match<string>(edge.data.role)
                .with("provider-layer", () => {
                  match(target)
                    .with({ _tag: "ServiceLayer" }, (t) => { layerNode = t })
                    .with(
                      { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "TaggedError" },
                      { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" },
                      { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, { _tag: "EffectSignature" },
                      { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
                      { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
                      () => {},
                    )
                    .exhaustive()
                })
                .with("provided-service", () => {
                  match(target)
                    .with({ _tag: "ServiceTag" }, (t) => { providedTags.push(t) })
                    .with(
                      { _tag: "EffectFn" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
                      { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" },
                      { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, { _tag: "EffectSignature" },
                      { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
                      { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
                      () => {},
                    )
                    .exhaustive()
                })
                .otherwise(() => {})
            }
            if (layerNode) {
              for (const tag of providedTags) {
                if (
                  tag.tagId === tagIdParam ||
                  tag.name === tagIdParam ||
                  tag.qualname === tagIdParam ||
                  tag.identifier === tagIdParam
                ) {
                  results.push({
                    layerQualname: layerNode.qualname,
                    layerKind: layerNode.layerKind,
                    packageTag: layerNode.packageTag,
                    file: layerNode.file,
                    tagId: tag.tagId,
                  })
                }
              }
            }
          })
          .with(
            { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "ServiceLayer" },
            { _tag: "TaggedError" }, { _tag: "SchemaDef" }, { _tag: "VitestCase" },
            { _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" },
            { _tag: "EffectSignature" }, { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return results
    })
    .with("find_callers", () => {
      const target = getStringParam(params, "target")
      return findCallers(harnessGraph, target).map((c) => ({ ...c }))
    })
    .with("find_callees", () => {
      const caller = getStringParam(params, "caller")
      return findCallees(harnessGraph, caller).map((c) => ({ ...c }))
    })
    .with("find_tests_reaching", () => {
      const callee = getStringParam(params, "callee")
      return findTestsReaching(harnessGraph, callee).map((t) => ({ ...t }))
    })
    .with("ontology_layer_nodes", () => {
      const layerParam = getStringParam(params, "layer", "Business")
      const validLayer: ArchiMateLayer | undefined = match(layerParam)
        .with("Motivation", "Business", "Application", "Technology", "Implementation", (l) => l)
        .otherwise(() => undefined)
      if (validLayer === undefined) return []
      const projection = projectOntologyLayers(harnessGraph)
      return projection.layers[validLayer].map((node) => ({ ...node }))
    })
    .with("ontology_governed_by", () => {
      const symbol = getStringParam(params, "symbol")
      const why = queryOntologyWhy(harnessGraph, symbol)
      return [
        ...(why.governingAdrs ?? []).map((a) => ({ docKind: "AdrDoc" as const, ...a })),
        ...(why.specifyingEars ?? []).map((s) => ({ docKind: "EarsSpec" as const, ...s })),
      ]
    })
    .with("untested_domain_fns", () => {
      const results: Array<Record<string, unknown>> = []
      const g = harnessGraph.graph
      for (const [, node] of Graph.nodes(g)) {
        match(node)
          .with({ _tag: "EffectFn" }, (fn) => {
            if ((fn.packageTag === "domain" || fn.packageTag === "contract") && !fn.isStub) {
              const reaching = findTestsReaching(harnessGraph, fn.qualname)
              if (reaching.length === 0) {
                results.push({
                  qualname: fn.qualname,
                  spanName: fn.spanName,
                  file: fn.file,
                })
              }
            }
          })
          .with(
            { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" }, { _tag: "SchemaDef" },
            { _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" },
            { _tag: "EffectSignature" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return results
    })
    .with("resolve_effect_fn_fuzzy", () => {
      const query = getStringParam(params, "query").trim().toLowerCase()
      const queryTokens = tokenizeFuzzy(query)
      const scored: Array<{ readonly score: number; readonly row: Record<string, unknown> }> = []
      for (const [, node] of Graph.nodes(harnessGraph.graph)) {
        match(node)
          .with({ _tag: "EffectFn" }, (fn) => {
            const score = scoreFuzzyEffectFn(fn.spanName, fn.qualname, query, queryTokens)
            if (score > 0) {
              scored.push({
                score,
                row: { qualname: fn.qualname, spanName: fn.spanName, packageTag: fn.packageTag, file: fn.file, line: fn.line, isStub: fn.isStub ?? false, score },
              })
            }
          })
          .with(
            { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" }, { _tag: "SchemaDef" },
            { _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" },
            { _tag: "EffectSignature" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, 10).map((entry) => entry.row)
    })
    .with("ontology_realized_by_doc", () => {
      const docId = getStringParam(params, "docId")
      const g = harnessGraph.graph
      const results: Array<Record<string, unknown>> = []
      for (const [nodeIdx, node] of Graph.nodes(g)) {
        match(node)
          .with({ _tag: "TraceabilityTuple" }, (tt) => {
            let edgeAdrId: string | undefined
            let edgeEarsSpecId: string | undefined
            let edgeArtifactQualname: string | undefined
            for (const edgeIdx of Graph.outgoingEdges(g, nodeIdx)) {
              const edge = Option.getOrUndefined(Graph.getEdge(g, edgeIdx))
              if (!edge) continue
              const target = Option.getOrUndefined(Graph.getNode(g, edge.target))
              if (!target) continue
              match<string>(edge.data.role)
                .with("governing-adr", "specifying-ears", () => {
                  match(target)
                    .with({ _tag: "AdrDoc" }, (d) => { edgeAdrId = d.id })
                    .with({ _tag: "EarsSpec" }, (d) => { edgeEarsSpecId = d.id })
                    .with(
                      { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
                      { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "EffectSignature" },
                      { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" }, { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
                      () => {},
                    )
                    .exhaustive()
                })
                .with("realizing-symbol", () => { edgeArtifactQualname = edge.data.entityKey })
                .otherwise(() => {})
            }
            const adrId = edgeAdrId ?? tt.adrId ?? null
            const earsSpecId = edgeEarsSpecId ?? tt.earsSpecId ?? null
            if (adrId === docId || earsSpecId === docId) {
              results.push({
                tupleId: tt.relationId, adrId, earsSpecId,
                requirementId: tt.requirementId ?? null, earsPattern: tt.earsPattern ?? null,
                artifactQualname: edgeArtifactQualname ?? tt.targetSymbolQualname,
              })
            }
          })
          .with(
            { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
            { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "AdrDoc" },
            { _tag: "EarsSpec" }, { _tag: "EffectSignature" }, { _tag: "LayerFlow" },
            { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return results.sort((a, b) =>
        String(a.artifactQualname).localeCompare(String(b.artifactQualname)) || String(a.tupleId).localeCompare(String(b.tupleId)),
      )
    })
    .with("rank_patterns_hybrid", () => {
      const query = getStringParam(params, "query").toLowerCase()
      const targetLayer = getStringParam(params, "targetLayer", "*")
      const scored: Array<{ readonly score: number; readonly row: Record<string, unknown> }> = []
      for (const [, node] of Graph.nodes(harnessGraph.graph)) {
        match(node)
          .with({ _tag: "PatternDoc" }, (p) => {
            const ont = classifyOntologyNode(p)
            if (targetLayer !== "*" && ont.layer !== targetLayer) return
            const haystack = `${p.slug} ${p.title ?? ""} ${p.summary}`.toLowerCase()
            const score = query === "" ? 0.5 : haystack.includes(query) ? 1 : 0.1
            scored.push({
              score,
              row: { slug: p.slug, path: p.path, title: p.title ?? null, summary: p.summary },
            })
          })
          .with(
            { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
            { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" },
            { _tag: "EffectSignature" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((entry) => entry.row)
    })
    .with("rank_candidate_services_for_stub", () => {
      const layer = getStringParam(params, "layer")
      const intent = getStringParam(params, "intent").toLowerCase()
      const scored: Array<{ readonly score: number; readonly row: Record<string, unknown> }> = []
      for (const [, node] of Graph.nodes(harnessGraph.graph)) {
        match(node)
          .with({ _tag: "ServiceTag" }, (svc) => {
            const ont = classifyOntologyNode(svc)
            if (layer !== "" && layer !== "*" && ont.layer !== layer) return
            const haystack = `${svc.tagId} ${svc.name} ${svc.qualname}`.toLowerCase()
            const score = intent === "" ? 0.5 : haystack.includes(intent) ? 1 : 0.1
            scored.push({
              score,
              row: {
                tagId: svc.tagId,
                qualname: svc.qualname,
                file: svc.file,
              },
            })
          })
          .with(
            { _tag: "EffectFn" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
            { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" },
            { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, { _tag: "EffectSignature" },
            { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((entry) => entry.row)
    })
    .with("policy_unverified_domain_fns", () => {
      const results: Array<Record<string, unknown>> = []
      for (const [, node] of Graph.nodes(harnessGraph.graph)) {
        match(node)
          .with({ _tag: "EffectFn" }, (fn) => {
            if (fn.packageTag === "domain" && !fn.isStub && findTestsReaching(harnessGraph, fn.qualname).length === 0) {
              results.push({ qualname: fn.qualname, spanName: fn.spanName, file: fn.file })
            }
          })
          .with(
            { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" }, { _tag: "SchemaDef" },
            { _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" },
            { _tag: "EffectSignature" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return results
    })
    .with("policy_orphan_effect_signatures", () => {
      const results: Array<Record<string, unknown>> = []
      const g = harnessGraph.graph
      for (const [nodeIdx, node] of Graph.nodes(g)) {
        match(node)
          .with({ _tag: "EffectSignature" }, (sig) => {
            let hasCaller = false
            for (const edgeIdx of Graph.outgoingEdges(g, nodeIdx)) {
              const edge = Option.getOrUndefined(Graph.getEdge(g, edgeIdx))
              const roleStr: string | undefined = edge === undefined ? undefined : String(edge.data.role)
              if (match(roleStr).with("caller", () => true).otherwise(() => false)) {
                hasCaller = true
                break
              }
            }
            if (!hasCaller) {
              results.push({ relationId: sig.relationId, callerQualname: sig.callerQualname, file: sig.file })
            }
          })
          .with(
            { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
            { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "AdrDoc" },
            { _tag: "EarsSpec" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return results
    })
    .exhaustive()
