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
    $doc: AdrDoc
    $target: EffectFn
    $tt $rel:playsGoverningAdrRole $doc
    $tt playsRealizingFnRole $target
    $target.qualname = $symbol or $target.spanName = $symbol
  }
  return {
    $doc,
    $rel.archimateRelation as rel,
    $target
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
}

export const loadHarnessPgSchemaText = (): string => HARNESS_PG_SCHEMA_TEXT

export const loadHarnessGqQueriesText = (): string => HARNESS_GQ_QUERIES_TEXT

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
            { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
            { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" },
            { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, { _tag: "EffectSignature" },
            { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
            () => {},
          )
          .exhaustive()
      }
      return results
    })
    .exhaustive()
