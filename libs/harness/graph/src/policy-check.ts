import { Option } from "effect"
import * as Graph from "effect/Graph"
import { renderMermaid } from "./graph-engine.js"
import {
  type EarsSpecNode,
  type EffectFnNode,
  getNodeKey,
  type HarnessGraph,
  type HarnessNode,
  type ServiceTagNode,
  type TaggedErrorNode
} from "./model.js"

export interface GraphPolicyViolation {
  readonly rule:
    | "domain-requires-infra"
    | "domain-requires-cloud-binding"
    | "layer-cycle"
    | "impure-decider"
    | "impure-reducer"
    | "dead-event-payload"
    | "terminal-state-unhandled"
    | "unmapped-spec-symbol"
    | "discriminant-branching"
    | "non-exhaustive-union-match"
    | "schema-boolean-state"
    | "fallback-json-equality"
    | "vacuous-error-assertion"
    | "unscoped-effect-run"
  readonly message: string
  readonly path: ReadonlyArray<string>
}

export interface CheckEffectGraphResult {
  readonly ok: boolean
  readonly violations: ReadonlyArray<GraphPolicyViolation>
  readonly mermaid: string
}

const isCloudBinding = (node: ServiceTagNode): boolean =>
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)\b/.test(node.tagId) ||
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)\b/.test(node.name)

const isDeciderSpan = (spanName: string): boolean =>
  spanName.endsWith(".decide") || spanName === "decide"

const isReducerSpan = (spanName: string): boolean =>
  spanName.endsWith(".evolve") ||
  spanName === "evolve" ||
  spanName.endsWith(".fold") ||
  spanName === "fold"

export const checkEffectGraph = (harnessGraph: HarnessGraph): CheckEffectGraphResult => {
  const violations: Array<GraphPolicyViolation> = []

  const domainFns: Array<{ readonly index: Graph.NodeIndex; readonly node: EffectFnNode }> = []
  const allFns: Array<EffectFnNode> = []
  const allServices: Array<ServiceTagNode> = []
  const allErrors: Array<TaggedErrorNode> = []
  const earsSpecs: Array<EarsSpecNode> = []
  const forbiddenServices: Array<{
    readonly index: Graph.NodeIndex
    readonly node: ServiceTagNode
    readonly rule: "domain-requires-infra" | "domain-requires-cloud-binding"
  }> = []

  // 1. Collect domain functions, forbidden services, all symbols, and EARS specs
  for (const [idx, node] of Graph.nodes(harnessGraph.graph)) {
    if (node._tag === "EffectFn") {
      allFns.push(node)
      if (node.packageTag === "domain") {
        domainFns.push({ index: idx, node })
      }
    } else if (node._tag === "ServiceTag") {
      allServices.push(node)
      if (node.packageTag === "infra") {
        forbiddenServices.push({
          index: idx,
          node,
          rule: "domain-requires-infra"
        })
      } else if (isCloudBinding(node)) {
        forbiddenServices.push({
          index: idx,
          node,
          rule: "domain-requires-cloud-binding"
        })
      }
    } else if (node._tag === "TaggedError") {
      allErrors.push(node)
    } else if (node._tag === "EarsSpec") {
      earsSpecs.push(node)
    }
  }

  // Rule 1: domain-requires-infra & domain-requires-cloud-binding via Graph.simplePaths
  for (const domainFn of domainFns) {
    for (const forbiddenSvc of forbiddenServices) {
      const walker = Graph.simplePaths(harnessGraph.graph, {
        source: domainFn.index,
        target: forbiddenSvc.index,
        limit: 1
      })
      for (const pathResult of walker) {
        const pathKeys = pathResult.path.map((nodeIdx) => {
          const nodeOpt = Graph.getNode(harnessGraph.graph, nodeIdx)
          return Option.isSome(nodeOpt) ? getNodeKey(nodeOpt.value) : String(nodeIdx)
        })
        const message =
          forbiddenSvc.rule === "domain-requires-infra"
            ? `Domain function '${domainFn.node.qualname}' forbidden dependency on infra service '${forbiddenSvc.node.tagId}'`
            : `Domain function '${domainFn.node.qualname}' forbidden dependency on cloud binding '${forbiddenSvc.node.tagId}'`
        violations.push({
          rule: forbiddenSvc.rule,
          message,
          path: pathKeys
        })
      }
    }
  }

  // Rule 2: impure-decider (all decider functions across domain/contract/service cannot require any services)
  for (const [fnIdx, fnNode] of Graph.nodes(harnessGraph.graph)) {
    if (fnNode._tag === "EffectFn" && isDeciderSpan(fnNode.spanName)) {
      for (const [, edge] of Graph.edges(harnessGraph.graph)) {
        if (edge.source === fnIdx && edge.data._tag === "RequiresService") {
          violations.push({
            rule: "impure-decider",
            message: `Decider function '${fnNode.qualname}' (${fnNode.spanName}) must be pure and cannot require service '${edge.data.tagId}'`,
            path: [fnNode.qualname, edge.data.tagId]
          })
        }
      }
    }
  }

  // Rule 2b: impure-reducer (all reducer/evolve functions must be pure R=never and infallible E=never)
  for (const [fnIdx, fnNode] of Graph.nodes(harnessGraph.graph)) {
    if (fnNode._tag === "EffectFn" && isReducerSpan(fnNode.spanName)) {
      for (const [, edge] of Graph.edges(harnessGraph.graph)) {
        if (edge.source === fnIdx && edge.data._tag === "RequiresService") {
          violations.push({
            rule: "impure-reducer",
            message: `Reducer function '${fnNode.qualname}' (${fnNode.spanName}) must be pure and cannot require service '${edge.data.tagId}'`,
            path: [fnNode.qualname, edge.data.tagId]
          })
        } else if (edge.source === fnIdx && edge.data._tag === "FailsWith") {
          violations.push({
            rule: "impure-reducer",
            message: `Reducer function '${fnNode.qualname}' (${fnNode.spanName}) must be infallible and cannot fail with '${edge.data.errorTag}'`,
            path: [fnNode.qualname, edge.data.errorTag]
          })
        }
      }
    }
  }

  // Rule 3: layer-cycle via Graph.findCycle on projected dependency graph
  const nodeMap = new Map<Graph.NodeIndex, Graph.NodeIndex>()
  const depGraph = Graph.directed<HarnessNode, string>((mutable) => {
    for (const [origIdx, node] of Graph.nodes(harnessGraph.graph)) {
      if (node._tag === "ServiceLayer" || node._tag === "ServiceTag") {
        const newIdx = Graph.addNode(mutable, node)
        nodeMap.set(origIdx, newIdx)
      }
    }

    for (const [, edge] of Graph.edges(harnessGraph.graph)) {
      if (edge.data._tag === "LayerRequires") {
        const src = nodeMap.get(edge.source)
        const dst = nodeMap.get(edge.target)
        if (src !== undefined && dst !== undefined) {
          Graph.addEdge(mutable, src, dst, "LayerRequires")
        }
      } else if (edge.data._tag === "ProvidesService") {
        // In harnessGraph, edge is Layer -> ServiceTag.
        // In dependency projection, ServiceTag is provided by Layer, so ServiceTag -> Layer.
        const src = nodeMap.get(edge.target)
        const dst = nodeMap.get(edge.source)
        if (src !== undefined && dst !== undefined) {
          Graph.addEdge(mutable, src, dst, "ProvidesService")
        }
      }
    }
  })

  const cycleOpt = Graph.findCycle(depGraph)
  if (Option.isSome(cycleOpt)) {
    const cycle = cycleOpt.value
    const path = cycle.path.map((idx) => {
      const nodeOpt = Graph.getNode(depGraph, idx)
      return Option.isSome(nodeOpt) ? getNodeKey(nodeOpt.value) : String(idx)
    })
    violations.push({
      rule: "layer-cycle",
      message: `Layer dependency cycle detected: ${path.join(" -> ")}`,
      path
    })
  }

  // Rule 4: unmapped-spec-symbol (every proposed or accepted EarsSpec must map all its declared spans, services, and errors to nodes in the graph via SpecifiesSymbol edges)
  for (const node of earsSpecs) {
    if (node.status !== "proposed" && node.status !== "accepted") {
      continue
    }

    for (const span of node.referencedSpans) {
      const exists = allFns.some(
        (fn) => fn.spanName === span || fn.qualname === span || fn.qualname.endsWith(`#${span}`)
      )
      if (!exists) {
        violations.push({
          rule: "unmapped-spec-symbol",
          message: `EARS Spec '${node.id}' (${node.path}) declares EffectFn span '${span}', which is missing from the graph`,
          path: [node.id, span]
        })
      }
    }

    for (const svc of node.referencedServices) {
      const exists = allServices.some(
        (s) => s.tagId === svc || s.name === svc || s.tagId.endsWith(`#${svc}`)
      )
      if (!exists) {
        violations.push({
          rule: "unmapped-spec-symbol",
          message: `EARS Spec '${node.id}' (${node.path}) declares ServiceTag '${svc}', which is missing from the graph`,
          path: [node.id, svc]
        })
      }
    }

    for (const err of node.referencedErrors) {
      const exists = allErrors.some((e) => e.errorTag === err)
      if (!exists) {
        violations.push({
          rule: "unmapped-spec-symbol",
          message: `EARS Spec '${node.id}' (${node.path}) declares TaggedError '${err}', which is missing from the graph`,
          path: [node.id, err]
        })
      }
    }
  }

  // Rule 5: discriminant-branching and non-exhaustive-union-match from type-aware extractor
  for (const bv of harnessGraph.branchingViolations ?? []) {
    violations.push({
      rule: bv.rule,
      message: bv.message,
      path: [bv.file, bv.enclosingSymbol]
    })
  }

  const mermaid = renderMermaid(harnessGraph)

  return {
    ok: violations.length === 0,
    violations,
    mermaid
  }
}
