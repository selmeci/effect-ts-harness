import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { renderMermaid } from "./graph-engine.js"
import {
  type EarsSpecNode,
  type EffectFnNode,
  getNodeKey,
  type HarnessGraph,
  type HarnessNode,
  type ServiceTagNode,
  type TaggedErrorNode,
  type ViolationRule,
} from "./model.js"

export interface GraphPolicyViolation {
  readonly rule: ViolationRule
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

export const isAggregateFnNode = (node: EffectFnNode): boolean =>
  node.spanName.startsWith("Aggregate.") ||
  node.spanName.startsWith("AggregateInfra.") ||
  node.spanName.startsWith("AggregateHttp.") ||
  node.spanName.endsWith(".handleCommand") ||
  node.spanName.endsWith(".executeCommand") ||
  /(?:-aggregate|\.aggregate|\/aggregate|^aggregate)\.ts$/.test(node.file)

const isEventBusServiceNode = (node: ServiceTagNode): boolean =>
  node.tagId === "EventBus" ||
  node.tagId.endsWith("EventBus") ||
  node.tagId.endsWith(".EventBus") ||
  node.name === "EventBus" ||
  node.name.endsWith("EventBus")

const isOutboxDrainOrBusPublishFnNode = (node: EffectFnNode): boolean =>
  node.spanName === "Outbox.drain" ||
  node.spanName === "EventBus.publish" ||
  node.qualname.includes("Outbox.drain") ||
  node.qualname.includes("EventBus.publish")

const resolveNodeKey = (
  graph: Graph.DirectedGraph<HarnessNode, unknown>,
  nodeIdx: Graph.NodeIndex,
): string =>
  match(Graph.getNode(graph, nodeIdx))
    .with({ _tag: "Some" }, ({ value }) => getNodeKey(value))
    .with({ _tag: "None" }, () => String(nodeIdx))
    .exhaustive()

export const checkEffectGraph = (harnessGraph: HarnessGraph): CheckEffectGraphResult => {
  const violations: Array<GraphPolicyViolation> = []

  const domainFns: Array<{ readonly index: Graph.NodeIndex; readonly node: EffectFnNode }> = []
  const deciderFns: Array<{ readonly index: Graph.NodeIndex; readonly node: EffectFnNode }> = []
  const reducerFns: Array<{ readonly index: Graph.NodeIndex; readonly node: EffectFnNode }> = []
  const aggregateFns: Array<{ readonly index: Graph.NodeIndex; readonly node: EffectFnNode }> = []
  const forbiddenOutboxTargets: Array<{
    readonly index: Graph.NodeIndex
    readonly ident: string
    readonly kind: "service" | "call"
  }> = []
  const allFns: Array<EffectFnNode> = []
  const allServices: Array<ServiceTagNode> = []
  const allErrors: Array<TaggedErrorNode> = []
  const earsSpecs: Array<EarsSpecNode> = []
  const forbiddenServices: Array<{
    readonly index: Graph.NodeIndex
    readonly node: ServiceTagNode
    readonly rule: "domain-requires-infra" | "domain-requires-cloud-binding"
  }> = []

  // 1. Collect domain functions, aggregate functions, forbidden services/targets, all symbols, and EARS specs in a single pass
  for (const [idx, node] of Graph.nodes(harnessGraph.graph)) {
    match(node)
      .with({ _tag: "EffectFn" }, (fnNode) => {
        allFns.push(fnNode)
        if (fnNode.packageTag === "domain") {
          domainFns.push({ index: idx, node: fnNode })
        }
        if (isDeciderSpan(fnNode.spanName)) {
          deciderFns.push({ index: idx, node: fnNode })
        }
        if (isReducerSpan(fnNode.spanName)) {
          reducerFns.push({ index: idx, node: fnNode })
        }
        if (isAggregateFnNode(fnNode)) {
          aggregateFns.push({ index: idx, node: fnNode })
        }
        if (isOutboxDrainOrBusPublishFnNode(fnNode)) {
          forbiddenOutboxTargets.push({
            index: idx,
            ident: fnNode.spanName.length > 0 ? fnNode.spanName : "EventBus.publish",
            kind: "call",
          })
        }
      })
      .with({ _tag: "ServiceTag" }, (svcNode) => {
        allServices.push(svcNode)
        if (svcNode.packageTag === "infra") {
          forbiddenServices.push({
            index: idx,
            node: svcNode,
            rule: "domain-requires-infra",
          })
        } else if (isCloudBinding(svcNode)) {
          forbiddenServices.push({
            index: idx,
            node: svcNode,
            rule: "domain-requires-cloud-binding",
          })
        }
        if (isEventBusServiceNode(svcNode)) {
          forbiddenOutboxTargets.push({
            index: idx,
            ident: svcNode.tagId,
            kind: "service",
          })
        }
      })
      .with({ _tag: "TaggedError" }, (errNode) => {
        allErrors.push(errNode)
      })
      .with({ _tag: "EarsSpec" }, (specNode) => {
        earsSpecs.push(specNode)
      })
      .with(
        { _tag: "ServiceLayer" },
        { _tag: "VitestCase" },
        { _tag: "AdrDoc" },
        { _tag: "PatternDoc" },
        () => undefined,
      )
      .exhaustive()
  }

  // Rule 1: domain-requires-infra & domain-requires-cloud-binding via Graph.simplePaths
  for (const domainFn of domainFns) {
    for (const forbiddenSvc of forbiddenServices) {
      const walker = Graph.simplePaths(harnessGraph.graph, {
        source: domainFn.index,
        target: forbiddenSvc.index,
        limit: 1,
      })
      for (const pathResult of walker) {
        const pathKeys = pathResult.path.map((nodeIdx) =>
          resolveNodeKey(harnessGraph.graph, nodeIdx),
        )
        const message = match(forbiddenSvc.rule)
          .with(
            "domain-requires-infra",
            () =>
              `Domain function '${domainFn.node.qualname}' forbidden dependency on infra service '${forbiddenSvc.node.tagId}'`,
          )
          .with(
            "domain-requires-cloud-binding",
            () =>
              `Domain function '${domainFn.node.qualname}' forbidden dependency on cloud binding '${forbiddenSvc.node.tagId}'`,
          )
          .exhaustive()
        violations.push({
          rule: forbiddenSvc.rule,
          message,
          path: pathKeys,
        })
      }
    }
  }

  // Rule 2: impure-decider (all decider functions across domain/contract/service cannot require any services)
  for (const { index: fnIdx, node: fnNode } of deciderFns) {
    for (const [, edge] of Graph.edges(harnessGraph.graph)) {
      if (edge.source === fnIdx) {
        match(edge.data)
          .with({ _tag: "RequiresService" }, (req) => {
            violations.push({
              rule: "impure-decider",
              message: `Decider function '${fnNode.qualname}' (${fnNode.spanName}) must be pure and cannot require service '${req.tagId}'`,
              path: [fnNode.qualname, req.tagId],
            })
          })
          .with(
            { _tag: "FailsWith" },
            { _tag: "ProvidesService" },
            { _tag: "LayerRequires" },
            { _tag: "TracedCall" },
            { _tag: "ExercisesSpan" },
            { _tag: "GovernsSymbol" },
            { _tag: "SpecifiesSymbol" },
            () => undefined,
          )
          .exhaustive()
      }
    }
  }

  // Rule 2b: impure-reducer (all reducer/evolve functions must be pure R=never and infallible E=never)
  for (const { index: fnIdx, node: fnNode } of reducerFns) {
    for (const [, edge] of Graph.edges(harnessGraph.graph)) {
      if (edge.source === fnIdx) {
        match(edge.data)
          .with({ _tag: "RequiresService" }, (req) => {
            violations.push({
              rule: "impure-reducer",
              message: `Reducer function '${fnNode.qualname}' (${fnNode.spanName}) must be pure and cannot require service '${req.tagId}'`,
              path: [fnNode.qualname, req.tagId],
            })
          })
          .with({ _tag: "FailsWith" }, (fail) => {
            violations.push({
              rule: "impure-reducer",
              message: `Reducer function '${fnNode.qualname}' (${fnNode.spanName}) must be infallible and cannot fail with '${fail.errorTag}'`,
              path: [fnNode.qualname, fail.errorTag],
            })
          })
          .with(
            { _tag: "ProvidesService" },
            { _tag: "LayerRequires" },
            { _tag: "TracedCall" },
            { _tag: "ExercisesSpan" },
            { _tag: "GovernsSymbol" },
            { _tag: "SpecifiesSymbol" },
            () => undefined,
          )
          .exhaustive()
      }
    }
  }

  // Rule 2c: aggregate-direct-bus-publish via transitive Graph.simplePaths
  // (aggregates and command handlers write to es_outbox, never require EventBus or invoke Outbox.drain / EventBus.publish directly or transitively)
  for (const aggFn of aggregateFns) {
    const reportedTargetIdents = new Set<string>()
    for (const target of forbiddenOutboxTargets) {
      if (aggFn.index === target.index || reportedTargetIdents.has(target.ident)) {
        continue
      }
      const walker = Graph.simplePaths(harnessGraph.graph, {
        source: aggFn.index,
        target: target.index,
        limit: 1,
      })
      for (const pathResult of walker) {
        reportedTargetIdents.add(target.ident)
        const intermediateKeys = pathResult.path
          .slice(0, -1)
          .map((nodeIdx) => resolveNodeKey(harnessGraph.graph, nodeIdx))
        const pathKeys = [...intermediateKeys, target.ident]
        const message = match(target.kind)
          .with(
            "service",
            () =>
              `Aggregate function '${aggFn.node.qualname}' (${aggFn.node.spanName}) cannot require or publish directly to '${target.ident}' — aggregates must persist events to es_outbox inside the SQLite transaction and let a separate outbox relay publish asynchronously.`,
          )
          .with(
            "call",
            () =>
              `Aggregate function '${aggFn.node.qualname}' (${aggFn.node.spanName}) cannot invoke '${target.ident}' during command execution — aggregates must persist events to es_outbox inside the SQLite transaction and let a separate outbox relay drain asynchronously.`,
          )
          .exhaustive()
        violations.push({
          rule: "aggregate-direct-bus-publish",
          message,
          path: pathKeys,
        })
      }
    }
  }

  // Rule 3: layer-cycle via Graph.findCycle on projected dependency graph
  const nodeMap = new Map<Graph.NodeIndex, Graph.NodeIndex>()
  const depGraph = Graph.directed<HarnessNode, string>((mutable) => {
    for (const [origIdx, node] of Graph.nodes(harnessGraph.graph)) {
      match(node)
        .with({ _tag: "ServiceLayer" }, { _tag: "ServiceTag" }, (svcOrLayer) => {
          const newIdx = Graph.addNode(mutable, svcOrLayer)
          nodeMap.set(origIdx, newIdx)
        })
        .with(
          { _tag: "EffectFn" },
          { _tag: "TaggedError" },
          { _tag: "VitestCase" },
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "PatternDoc" },
          () => undefined,
        )
        .exhaustive()
    }

    for (const [, edge] of Graph.edges(harnessGraph.graph)) {
      match(edge.data)
        .with({ _tag: "LayerRequires" }, () => {
          const src = nodeMap.get(edge.source)
          const dst = nodeMap.get(edge.target)
          if (src !== undefined && dst !== undefined) {
            Graph.addEdge(mutable, src, dst, "LayerRequires")
          }
        })
        .with({ _tag: "ProvidesService" }, () => {
          // In harnessGraph, edge is Layer -> ServiceTag.
          // In dependency projection, ServiceTag is provided by Layer, so ServiceTag -> Layer.
          const src = nodeMap.get(edge.target)
          const dst = nodeMap.get(edge.source)
          if (src !== undefined && dst !== undefined) {
            Graph.addEdge(mutable, src, dst, "ProvidesService")
          }
        })
        .with(
          { _tag: "RequiresService" },
          { _tag: "FailsWith" },
          { _tag: "TracedCall" },
          { _tag: "ExercisesSpan" },
          { _tag: "GovernsSymbol" },
          { _tag: "SpecifiesSymbol" },
          () => undefined,
        )
        .exhaustive()
    }
  })

  match(Graph.findCycle(depGraph))
    .with({ _tag: "Some" }, ({ value: cycle }) => {
      const path = cycle.path.map((idx) => resolveNodeKey(depGraph, idx))
      violations.push({
        rule: "layer-cycle",
        message: `Layer dependency cycle detected: ${path.join(" -> ")}`,
        path,
      })
    })
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

  // Rule 4: unmapped-spec-symbol (every proposed or accepted EarsSpec must map all its declared spans, services, and errors to nodes in the graph via SpecifiesSymbol edges)
  for (const node of earsSpecs) {
    if (node.status !== "proposed" && node.status !== "accepted") {
      continue
    }

    for (const span of node.referencedSpans) {
      const exists = allFns.some(
        (fn) => fn.spanName === span || fn.qualname === span || fn.qualname.endsWith(`#${span}`),
      )
      if (!exists) {
        violations.push({
          rule: "unmapped-spec-symbol",
          message: `EARS Spec '${node.id}' (${node.path}) declares EffectFn span '${span}', which is missing from the graph`,
          path: [node.id, span],
        })
      }
    }

    for (const svc of node.referencedServices) {
      const exists = allServices.some(
        (s) => s.tagId === svc || s.name === svc || s.tagId.endsWith(`#${svc}`),
      )
      if (!exists) {
        violations.push({
          rule: "unmapped-spec-symbol",
          message: `EARS Spec '${node.id}' (${node.path}) declares ServiceTag '${svc}', which is missing from the graph`,
          path: [node.id, svc],
        })
      }
    }

    for (const err of node.referencedErrors) {
      const exists = allErrors.some((e) => e.errorTag === err)
      if (!exists) {
        violations.push({
          rule: "unmapped-spec-symbol",
          message: `EARS Spec '${node.id}' (${node.path}) declares TaggedError '${err}', which is missing from the graph`,
          path: [node.id, err],
        })
      }
    }
  }

  // Rule 5: discriminant-branching and non-exhaustive-union-match from type-aware extractor
  for (const bv of harnessGraph.branchingViolations ?? []) {
    violations.push({
      rule: bv.rule,
      message: bv.message,
      path: bv.path ?? [bv.file, bv.enclosingSymbol],
    })
  }

  const mermaid = renderMermaid(harnessGraph)

  return {
    ok: violations.length === 0,
    violations,
    mermaid,
  }
}
