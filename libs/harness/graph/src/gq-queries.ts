import { Option } from "effect"
import * as Graph from "effect/Graph"
import { compareCodeUnits } from "@harness/contract"
import { match } from "ts-pattern"
import {
  type ArchiMateLayer,
  classifyOntologyNode,
  projectOntologyLayers,
  queryOntologyWhy,
} from "./archimate-ontology.js"
import {
  HARNESS_GQ_QUERIES,
  HARNESS_GQ_QUERY_NAMES,
  type HarnessGqQueryDescriptor,
  type HarnessGqQueryName,
} from "./gq-query-descriptors.js"
import { executeRetrievalMemoryQuery } from "./gq-retrieval-memory.js"
import { HARNESS_GQ_QUERIES_TEXT, HARNESS_PG_SCHEMA_TEXT } from "./gq-static-assets.js"
import { findCallees, findCallers, findTestsReaching, resolveNode } from "./graph-engine.js"
import type { HarnessGraph, ServiceLayerNode, ServiceTagNode } from "./model.js"

export {
  HARNESS_GQ_QUERIES,
  HARNESS_GQ_QUERY_NAMES,
  type HarnessGqQueryDescriptor,
  type HarnessGqQueryName,
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
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[._\-#/\s]+/)
    .filter((t) => t.length > 0)

const scoreFuzzyEffectFn = (
  spanName: string,
  qualname: string,
  query: string,
  queryTokens: ReadonlyArray<string>,
): number => {
  if (query.length === 0) return 0
  const spanLower = spanName.toLowerCase()
  const qualLower = qualname.toLowerCase()
  if (spanLower === query || qualLower === query) return 1
  if (query.length < 2) {
    return tokenizeFuzzy(spanName).includes(query) ? 0.9 : 0
  }
  if (spanLower.includes(query) || qualLower.includes(query)) return 0.8
  const spanTokens = [spanLower, ...tokenizeFuzzy(spanName)]
  let minDist = Number.POSITIVE_INFINITY
  for (const qt of queryTokens.length > 0 ? queryTokens : [query]) {
    if (qt.length < 2) continue
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
                    .with({ _tag: "ServiceLayer" }, (t) => {
                      layerNode = t
                    })
                    .with(
                      { _tag: "EffectFn" },
                      { _tag: "ServiceTag" },
                      { _tag: "TaggedError" },
                      { _tag: "SchemaDef" },
                      { _tag: "VitestCase" },
                      { _tag: "PatternDoc" },
                      { _tag: "AdrDoc" },
                      { _tag: "EarsSpec" },
                      { _tag: "EarsRequirement" },
                      { _tag: "EffectSignature" },
                      { _tag: "LayerFlow" },
                      { _tag: "TraceabilityTuple" },
                      { _tag: "HttpEndpointTuple" },
                      { _tag: "MigrationTuple" },
                      () => {},
                    )
                    .exhaustive()
                })
                .with("provided-service", () => {
                  match(target)
                    .with({ _tag: "ServiceTag" }, (t) => {
                      providedTags.push(t)
                    })
                    .with(
                      { _tag: "EffectFn" },
                      { _tag: "ServiceLayer" },
                      { _tag: "TaggedError" },
                      { _tag: "SchemaDef" },
                      { _tag: "VitestCase" },
                      { _tag: "PatternDoc" },
                      { _tag: "AdrDoc" },
                      { _tag: "EarsSpec" },
                      { _tag: "EarsRequirement" },
                      { _tag: "EffectSignature" },
                      { _tag: "LayerFlow" },
                      { _tag: "TraceabilityTuple" },
                      { _tag: "HttpEndpointTuple" },
                      { _tag: "MigrationTuple" },
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
            { _tag: "EffectFn" },
            { _tag: "ServiceTag" },
            { _tag: "ServiceLayer" },
            { _tag: "TaggedError" },
            { _tag: "SchemaDef" },
            { _tag: "VitestCase" },
            { _tag: "PatternDoc" },
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            { _tag: "EarsRequirement" },
            { _tag: "EffectSignature" },
            { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
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
      for (const [, node] of Graph.nodes(harnessGraph.graph)) {
        match(node)
          .with({ _tag: "EffectFn" }, (fn) => {
            if ((fn.packageTag === "domain" || fn.packageTag === "contract") && !fn.isStub) {
              const reaching = findTestsReaching(harnessGraph, fn.qualname)
              if (reaching.length === 0) {
                results.push({ qualname: fn.qualname, spanName: fn.spanName, file: fn.file })
              }
            }
          })
          .with(
            { _tag: "ServiceTag" },
            { _tag: "ServiceLayer" },
            { _tag: "TaggedError" },
            { _tag: "SchemaDef" },
            { _tag: "VitestCase" },
            { _tag: "PatternDoc" },
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            { _tag: "EarsRequirement" },
            { _tag: "EffectSignature" },
            { _tag: "LayerFlow" },
            { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
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
                row: {
                  qualname: fn.qualname,
                  spanName: fn.spanName,
                  packageTag: fn.packageTag,
                  file: fn.file,
                  line: fn.line,
                  isStub: fn.isStub ?? false,
                  score,
                },
              })
            }
          })
          .with(
            { _tag: "ServiceTag" },
            { _tag: "ServiceLayer" },
            { _tag: "TaggedError" },
            { _tag: "SchemaDef" },
            { _tag: "VitestCase" },
            { _tag: "PatternDoc" },
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            { _tag: "EarsRequirement" },
            { _tag: "EffectSignature" },
            { _tag: "LayerFlow" },
            { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((entry) => entry.row)
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
                    .with({ _tag: "AdrDoc" }, (d) => {
                      edgeAdrId = d.id
                    })
                    .with({ _tag: "EarsSpec" }, (d) => {
                      edgeEarsSpecId = d.id
                    })
                    .with(
                      { _tag: "EffectFn" },
                      { _tag: "ServiceTag" },
                      { _tag: "ServiceLayer" },
                      { _tag: "TaggedError" },
                      { _tag: "SchemaDef" },
                      { _tag: "VitestCase" },
                      { _tag: "PatternDoc" },
                      { _tag: "EarsRequirement" },
                      { _tag: "EffectSignature" },
                      { _tag: "LayerFlow" },
                      { _tag: "TraceabilityTuple" },
                      { _tag: "HttpEndpointTuple" },
                      { _tag: "MigrationTuple" },
                      () => {},
                    )
                    .exhaustive()
                })
                .with("realizing-symbol", () => {
                  edgeArtifactQualname = edge.data.entityKey
                })
                .otherwise(() => {})
            }
            const adrId = edgeAdrId ?? tt.adrId ?? null
            const earsSpecId = edgeEarsSpecId ?? tt.earsSpecId ?? null
            if (adrId === docId || earsSpecId === docId) {
              results.push({
                tupleId: tt.relationId,
                adrId,
                earsSpecId,
                requirementId: tt.requirementId ?? null,
                earsPattern: tt.earsPattern ?? null,
                artifactQualname: edgeArtifactQualname ?? tt.targetSymbolQualname,
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
            { _tag: "EarsRequirement" },
            { _tag: "EffectSignature" },
            { _tag: "LayerFlow" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return results.sort(
        (a, b) =>
          compareCodeUnits(String(a.artifactQualname), String(b.artifactQualname)) ||
          compareCodeUnits(String(a.tupleId), String(b.tupleId)),
      )
    })
    .with(
      "rank_patterns_hybrid",
      "rank_patterns_vector_hybrid",
      "rank_patterns_bm25",
      "search_adrs_vector_hybrid",
      "search_adrs_bm25",
      "search_requirements_vector_hybrid",
      "search_requirements_bm25",
      (matchedName) => executeRetrievalMemoryQuery(harnessGraph, matchedName, params),
    )
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
                score,
              },
            })
          })
          .with(
            { _tag: "EffectFn" },
            { _tag: "ServiceLayer" },
            { _tag: "TaggedError" },
            { _tag: "SchemaDef" },
            { _tag: "VitestCase" },
            { _tag: "PatternDoc" },
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            { _tag: "EarsRequirement" },
            { _tag: "EffectSignature" },
            { _tag: "LayerFlow" },
            { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
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
            if (
              fn.packageTag === "domain" &&
              !fn.isStub &&
              findTestsReaching(harnessGraph, fn.qualname).length === 0
            ) {
              results.push({ qualname: fn.qualname, spanName: fn.spanName, file: fn.file })
            }
          })
          .with(
            { _tag: "ServiceTag" },
            { _tag: "ServiceLayer" },
            { _tag: "TaggedError" },
            { _tag: "SchemaDef" },
            { _tag: "VitestCase" },
            { _tag: "PatternDoc" },
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            { _tag: "EarsRequirement" },
            { _tag: "EffectSignature" },
            { _tag: "LayerFlow" },
            { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
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
              const roleStr: string | undefined =
                edge === undefined ? undefined : String(edge.data.role)
              if (
                match(roleStr)
                  .with("caller", () => true)
                  .otherwise(() => false)
              ) {
                hasCaller = true
                break
              }
            }
            if (!hasCaller) {
              results.push({
                relationId: sig.relationId,
                callerQualname: sig.callerQualname,
                file: sig.file,
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
            { _tag: "EarsRequirement" },
            { _tag: "LayerFlow" },
            { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return results
    })
    .with("workflow_pending_units", "ears_without_completed_unit", () => [])
    .exhaustive()
