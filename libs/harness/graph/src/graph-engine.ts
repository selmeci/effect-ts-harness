import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import { classifyOntologyEdge, classifyOntologyNode } from "./archimate-ontology.js"
import {
  type AdrDocNode,
  type BuildHarnessGraphInput,
  type CalleeResult,
  type CallerResult,
  type EarsSpecNode,
  type EffectFnNode,
  type ExercisesSpanEdge,
  type FailsWithEdge,
  getEdgeKey,
  getNodeKey,
  type GovernsSymbolEdge,
  type HarnessEdge,
  type HarnessGraph,
  type HarnessNode,
  type LayerRequiresEdge,
  type PatternDocNode,
  type ProvidesServiceEdge,
  type RequiresServiceEdge,
  type ServiceLayerNode,
  type ServiceTagNode,
  type SpecifiesSymbolEdge,
  type TaggedErrorNode,
  type TracedCallEdge,
  type VitestCaseNode
} from "./model.js"

export const buildHarnessGraph = (input: BuildHarnessGraphInput): HarnessGraph => {
  const nodeIndexByKey = new Map<string, Graph.NodeIndex>()

  const graph = Graph.directed<HarnessNode, HarnessEdge>((mutable) => {
    // 1. Add fns
    for (const fn of input.fns ?? []) {
      const node: EffectFnNode = { _tag: "EffectFn", ...fn }
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(node.qualname, idx)
    }

    // 2. Add services
    for (const s of input.services ?? []) {
      const node: ServiceTagNode = { _tag: "ServiceTag", ...s }
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(node.tagId, idx)
    }

    // 3. Add layers
    for (const l of input.layers ?? []) {
      const node: ServiceLayerNode = { _tag: "ServiceLayer", ...l }
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(node.qualname, idx)
    }

    // 4. Add errors
    for (const e of input.errors ?? []) {
      const node: TaggedErrorNode = { _tag: "TaggedError", ...e }
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(node.errorTag, idx)
    }

    // 5. Add tests
    for (const t of input.tests ?? []) {
      const node: VitestCaseNode = { _tag: "VitestCase", ...t }
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(node.testId, idx)
    }

    // 6. Add patternDocs
    for (const p of input.patternDocs ?? []) {
      const node: PatternDocNode = { _tag: "PatternDoc", ...p }
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(node.slug, idx)
    }

    // 7. Add adrDocs
    for (const a of input.adrDocs ?? []) {
      const node: AdrDocNode = { _tag: "AdrDoc", ...a }
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(node.id, idx)
    }

    // 8. Add earsSpecs
    for (const s of input.earsSpecs ?? []) {
      const node: EarsSpecNode = { _tag: "EarsSpec", ...s }
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(node.id, idx)
    }

    // Add edges
    for (const r of input.requiresService ?? []) {
      const srcKey = "callerQualname" in r ? r.callerQualname : r.fnQualname
      const srcIdx = nodeIndexByKey.get(srcKey)
      const dstIdx = nodeIndexByKey.get(r.tagId)
      if (srcIdx !== undefined && dstIdx !== undefined) {
        const edge: RequiresServiceEdge = {
          _tag: "RequiresService",
          callerQualname: srcKey,
          tagId: r.tagId
        }
        Graph.addEdge(mutable, srcIdx, dstIdx, edge)
      }
    }

    for (const f of input.failsWith ?? []) {
      const srcKey = "callerQualname" in f ? f.callerQualname : f.fnQualname
      const srcIdx = nodeIndexByKey.get(srcKey)
      const dstIdx = nodeIndexByKey.get(f.errorTag)
      if (srcIdx !== undefined && dstIdx !== undefined) {
        const edge: FailsWithEdge = {
          _tag: "FailsWith",
          callerQualname: srcKey,
          errorTag: f.errorTag
        }
        Graph.addEdge(mutable, srcIdx, dstIdx, edge)
      }
    }

    for (const p of input.providesService ?? []) {
      const srcIdx = nodeIndexByKey.get(p.layerQualname)
      const dstIdx = nodeIndexByKey.get(p.tagId)
      if (srcIdx !== undefined && dstIdx !== undefined) {
        const edge: ProvidesServiceEdge = {
          _tag: "ProvidesService",
          layerQualname: p.layerQualname,
          tagId: p.tagId
        }
        Graph.addEdge(mutable, srcIdx, dstIdx, edge)
      }
    }

    for (const lr of input.layerRequires ?? []) {
      const srcIdx = nodeIndexByKey.get(lr.layerQualname)
      const dstIdx = nodeIndexByKey.get(lr.tagId)
      if (srcIdx !== undefined && dstIdx !== undefined) {
        const edge: LayerRequiresEdge = {
          _tag: "LayerRequires",
          layerQualname: lr.layerQualname,
          tagId: lr.tagId
        }
        Graph.addEdge(mutable, srcIdx, dstIdx, edge)
      }
    }

    for (const tc of input.tracedCalls ?? []) {
      const srcIdx = nodeIndexByKey.get(tc.callerQualname)
      const dstIdx = nodeIndexByKey.get(tc.calleeQualname)
      if (srcIdx !== undefined && dstIdx !== undefined) {
        const edge: TracedCallEdge = {
          _tag: "TracedCall",
          callerQualname: tc.callerQualname,
          calleeQualname: tc.calleeQualname,
          callCount: tc.callCount,
          receiverLayer: tc.receiverLayer
        }
        Graph.addEdge(mutable, srcIdx, dstIdx, edge)
      }
    }

    for (const es of input.exercisesSpans ?? []) {
      const srcIdx = nodeIndexByKey.get(es.testId)
      const dstIdx = nodeIndexByKey.get(es.calleeQualname)
      if (srcIdx !== undefined && dstIdx !== undefined) {
        const edge: ExercisesSpanEdge = {
          _tag: "ExercisesSpan",
          testId: es.testId,
          calleeQualname: es.calleeQualname,
          callCount: es.callCount,
          receiverLayer: es.receiverLayer
        }
        Graph.addEdge(mutable, srcIdx, dstIdx, edge)
      }
    }

    for (const g of input.governsSymbols ?? []) {
      const srcIdx = nodeIndexByKey.get(g.adrId)
      const dstIdx = nodeIndexByKey.get(g.targetKey)
      if (srcIdx !== undefined && dstIdx !== undefined) {
        const edge: GovernsSymbolEdge = {
          _tag: "GovernsSymbol",
          adrId: g.adrId,
          targetKey: g.targetKey,
          targetKind: g.targetKind
        }
        Graph.addEdge(mutable, srcIdx, dstIdx, edge)
      }
    }

    for (const s of input.specifiesSymbols ?? []) {
      const srcIdx = nodeIndexByKey.get(s.specId)
      const dstIdx = nodeIndexByKey.get(s.targetKey)
      if (srcIdx !== undefined && dstIdx !== undefined) {
        const edge: SpecifiesSymbolEdge = {
          _tag: "SpecifiesSymbol",
          specId: s.specId,
          targetKey: s.targetKey,
          targetKind: s.targetKind
        }
        Graph.addEdge(mutable, srcIdx, dstIdx, edge)
      }
    }
  })

  return {
    graph,
    nodeIndexByKey,
    branchingViolations: input.branchingViolations
  }
}

export const resolveNode = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string
): HarnessNode | undefined => {
  const g = harnessGraph.graph
  const directIdx = harnessGraph.nodeIndexByKey.get(symbolOrSpan)
  if (directIdx !== undefined) {
    const node = Graph.getNode(g, directIdx)
    if (Option.isSome(node)) return node.value
  }

  for (const [, node] of Graph.nodes(g)) {
    switch (node._tag) {
      case "EffectFn": {
        if (
          node.spanName === symbolOrSpan ||
          node.qualname === symbolOrSpan ||
          node.qualname.endsWith(`#${symbolOrSpan}`)
        ) {
          return node
        }
        break
      }
      case "ServiceTag": {
        if (
          node.tagId === symbolOrSpan ||
          node.name === symbolOrSpan ||
          node.tagId.endsWith(`#${symbolOrSpan}`)
        ) {
          return node
        }
        break
      }
      case "ServiceLayer": {
        if (
          node.qualname === symbolOrSpan ||
          node.qualname.endsWith(`#${symbolOrSpan}`)
        ) {
          return node
        }
        break
      }
      case "TaggedError": {
        if (node.errorTag === symbolOrSpan) {
          return node
        }
        break
      }
      case "VitestCase": {
        if (node.testId === symbolOrSpan || node.testName === symbolOrSpan) {
          return node
        }
        break
      }
      case "PatternDoc": {
        if (
          node.slug === symbolOrSpan ||
          node.path === symbolOrSpan ||
          node.path.endsWith(`/${symbolOrSpan}`) ||
          node.path.endsWith(`/${symbolOrSpan}.md`)
        ) {
          return node
        }
        break
      }
      case "AdrDoc":
      case "EarsSpec": {
        if (
          node.id === symbolOrSpan ||
          node.path === symbolOrSpan ||
          node.path.endsWith(`/${symbolOrSpan}`) ||
          node.path.endsWith(`/${symbolOrSpan}.md`)
        ) {
          return node
        }
        break
      }
    }
  }

  return undefined
}

export const findTestsReaching = (
  harnessGraph: HarnessGraph,
  targetNameOrQualname: string
): ReadonlyArray<VitestCaseNode> => {
  const targetNode = resolveNode(harnessGraph, targetNameOrQualname)
  if (!targetNode) return []
  const targetKey = getNodeKey(targetNode)
  const targetIndex = harnessGraph.nodeIndexByKey.get(targetKey)
  if (targetIndex === undefined) return []

  const testResults = new Map<string, VitestCaseNode>()
  const walker = Graph.dfs(harnessGraph.graph, {
    start: [targetIndex],
    direction: "incoming"
  })

  for (const [, node] of walker) {
    if (node._tag === "VitestCase") {
      testResults.set(node.testId, node)
    }
  }

  return Array.from(testResults.values())
}

export const findCallees = (
  harnessGraph: HarnessGraph,
  target: string
): ReadonlyArray<CalleeResult> => {
  const targetNode = resolveNode(harnessGraph, target)
  if (!targetNode) return []
  const targetKey = getNodeKey(targetNode)
  const targetIndex = harnessGraph.nodeIndexByKey.get(targetKey)
  if (targetIndex === undefined) return []

  const results: Array<CalleeResult> = []
  const g = harnessGraph.graph

  for (const [, edge] of Graph.edges(g)) {
    if (edge.source === targetIndex) {
      const calleeOpt = Graph.getNode(g, edge.target)
      if (Option.isSome(calleeOpt)) {
        const callee = calleeOpt.value
        if (edge.data._tag === "TracedCall") {
          results.push({
            qualname: (callee as EffectFnNode).qualname,
            spanName: (callee as EffectFnNode).spanName,
            edgeKind: "TracedCall",
            receiverLayer: edge.data.receiverLayer,
            callCount: edge.data.callCount
          })
        } else if (edge.data._tag === "RequiresService") {
          const serviceTag = callee as ServiceTagNode
          // Look for providing layers
          const candidateLayers: Array<string> = []
          for (const [, otherEdge] of Graph.edges(g)) {
            if (otherEdge.target === edge.target && otherEdge.data._tag === "ProvidesService") {
              const layerNode = Graph.getNode(g, otherEdge.source)
              if (Option.isSome(layerNode)) {
                candidateLayers.push((layerNode.value as ServiceLayerNode).qualname)
              }
            }
          }
          results.push({
            qualname: serviceTag.tagId,
            spanName: serviceTag.name,
            tagId: serviceTag.tagId,
            name: serviceTag.name,
            edgeKind: "RequiresService",
            receiverLayer: candidateLayers[0] ?? null,
            candidates: candidateLayers
          })
        } else if (edge.data._tag === "ProvidesService" || edge.data._tag === "LayerRequires") {
          const serviceTag = callee as ServiceTagNode
          results.push({
            qualname: serviceTag.tagId,
            spanName: serviceTag.name,
            tagId: serviceTag.tagId,
            name: serviceTag.name,
            edgeKind: edge.data._tag,
            receiverLayer: null
          })
        } else if (edge.data._tag === "FailsWith") {
          const errNode = callee as TaggedErrorNode
          results.push({
            qualname: errNode.errorTag,
            spanName: errNode.errorTag,
            edgeKind: "FailsWith",
            receiverLayer: null
          })
        } else if (edge.data._tag === "GovernsSymbol" || edge.data._tag === "SpecifiesSymbol") {
          if (callee._tag === "EffectFn") {
            results.push({
              qualname: callee.qualname,
              spanName: callee.spanName,
              edgeKind: edge.data._tag,
              receiverLayer: null
            })
          } else if (callee._tag === "ServiceTag") {
            results.push({
              qualname: callee.tagId,
              spanName: callee.name,
              tagId: callee.tagId,
              name: callee.name,
              edgeKind: edge.data._tag,
              receiverLayer: null
            })
          } else if (callee._tag === "TaggedError") {
            results.push({
              qualname: callee.errorTag,
              spanName: callee.errorTag,
              edgeKind: edge.data._tag,
              receiverLayer: null
            })
          }
        }
      }
    }
  }

  return results
}

export const findCallers = (
  harnessGraph: HarnessGraph,
  target: string
): ReadonlyArray<CallerResult> => {
  const targetNode = resolveNode(harnessGraph, target)
  if (!targetNode) return []
  const targetKey = getNodeKey(targetNode)
  const targetIndex = harnessGraph.nodeIndexByKey.get(targetKey)
  if (targetIndex === undefined) return []

  const results: Array<CallerResult> = []
  const g = harnessGraph.graph

  for (const [, edge] of Graph.edges(g)) {
    if (edge.target === targetIndex) {
      const callerOpt = Graph.getNode(g, edge.source)
      if (Option.isSome(callerOpt)) {
        const caller = callerOpt.value
        if (edge.data._tag === "TracedCall") {
          results.push({
            qualname: (caller as EffectFnNode).qualname,
            spanName: (caller as EffectFnNode).spanName,
            edgeKind: "TracedCall",
            receiverLayer: edge.data.receiverLayer,
            callCount: edge.data.callCount
          })
        } else if (edge.data._tag === "ExercisesSpan") {
          results.push({
            qualname: (caller as VitestCaseNode).testId,
            testId: (caller as VitestCaseNode).testId,
            spanName: (caller as VitestCaseNode).testName,
            edgeKind: "ExercisesSpan",
            receiverLayer: edge.data.receiverLayer,
            callCount: edge.data.callCount
          })
        } else if (edge.data._tag === "RequiresService") {
          results.push({
            qualname: (caller as EffectFnNode).qualname,
            spanName: (caller as EffectFnNode).spanName,
            edgeKind: "RequiresService",
            receiverLayer: null
          })
        } else if (edge.data._tag === "FailsWith") {
          results.push({
            qualname: (caller as EffectFnNode).qualname,
            spanName: (caller as EffectFnNode).spanName,
            edgeKind: "FailsWith",
            receiverLayer: null
          })
        } else if (edge.data._tag === "ProvidesService" || edge.data._tag === "LayerRequires") {
          results.push({
            qualname: (caller as ServiceLayerNode).qualname,
            edgeKind: edge.data._tag,
            receiverLayer: null
          })
        } else if (edge.data._tag === "GovernsSymbol" || edge.data._tag === "SpecifiesSymbol") {
          if (caller._tag === "AdrDoc" || caller._tag === "EarsSpec") {
            results.push({
              qualname: caller.id,
              spanName: caller.title,
              edgeKind: edge.data._tag,
              receiverLayer: null
            })
          }
        }
      }
    }
  }

  return results
}

export const renderMermaid = (harnessGraph: HarnessGraph): string => {
  return Graph.toMermaid(harnessGraph.graph, {
    nodeLabel: (node: HarnessNode) => {
      switch (node._tag) {
        case "EffectFn":
          return node.spanName
        case "ServiceTag":
          return `Tag:${node.name}`
        case "ServiceLayer":
          return `Layer:${node.qualname.split("#")[1] ?? node.qualname}`
        case "TaggedError":
          return `Error:${node.errorTag}`
        case "VitestCase":
          return `Test:${node.testName}`
        case "PatternDoc":
          return `Pattern:${node.slug}`
        case "AdrDoc":
          return `ADR:${node.id}`
        case "EarsSpec":
          return `Spec:${node.id}`
      }
    },
    edgeLabel: (edge: HarnessEdge) => {
      switch (edge._tag) {
        case "TracedCall":
          return edge.receiverLayer ? `calls[${edge.receiverLayer}]` : `calls(${edge.callCount})`
        case "ExercisesSpan":
          return `exercises(${edge.callCount})`
        case "RequiresService":
          return "requires"
        case "ProvidesService":
          return "provides"
        case "LayerRequires":
          return "layerRequires"
        case "FailsWith":
          return "failsWith"
        case "GovernsSymbol":
          return "governs"
        case "SpecifiesSymbol":
          return "specifies"
      }
    }
  })
}

export const toOmnigraphNdjson = (harnessGraph: HarnessGraph): string => {
  const lines: Array<string> = []
  const g = harnessGraph.graph

  for (const [, node] of Graph.nodes(g)) {
    const ont = classifyOntologyNode(node)
    switch (node._tag) {
      case "EffectFn": {
        lines.push(
          JSON.stringify({
            type: "EffectFn",
            id: node.qualname,
            data: {
              qualname: node.qualname,
              spanName: node.spanName,
              packageTag: node.packageTag,
              file: node.file,
              line: node.line,
              successType: node.successType,
              isStub: node.isStub,
              archimateLayer: ont.layer,
              archimateAspect: ont.aspect,
              archimateElementType: ont.elementType
            }
          })
        )
        break
      }
      case "ServiceTag": {
        lines.push(
          JSON.stringify({
            type: "ServiceTag",
            id: node.tagId,
            data: {
              tagId: node.tagId,
              name: node.name,
              packageTag: node.packageTag,
              file: node.file,
              archimateLayer: ont.layer,
              archimateAspect: ont.aspect,
              archimateElementType: ont.elementType
            }
          })
        )
        break
      }
      case "ServiceLayer": {
        lines.push(
          JSON.stringify({
            type: "ServiceLayer",
            id: node.qualname,
            data: {
              qualname: node.qualname,
              layerKind: node.layerKind,
              packageTag: node.packageTag,
              file: node.file,
              archimateLayer: ont.layer,
              archimateAspect: ont.aspect,
              archimateElementType: ont.elementType
            }
          })
        )
        break
      }
      case "TaggedError": {
        lines.push(
          JSON.stringify({
            type: "TaggedError",
            id: node.errorTag,
            data: {
              errorTag: node.errorTag,
              file: node.file,
              archimateLayer: ont.layer,
              archimateAspect: ont.aspect,
              archimateElementType: ont.elementType
            }
          })
        )
        break
      }
      case "VitestCase": {
        lines.push(
          JSON.stringify({
            type: "VitestCase",
            id: node.testId,
            data: {
              testId: node.testId,
              testFile: node.testFile,
              testName: node.testName,
              lastTreeHash: node.lastTreeHash,
              isPropertyTest: node.isPropertyTest ?? false,
              archimateLayer: ont.layer,
              archimateAspect: ont.aspect,
              archimateElementType: ont.elementType
            }
          })
        )
        break
      }
      case "PatternDoc": {
        lines.push(
          JSON.stringify({
            type: "PatternDoc",
            id: node.slug,
            data: {
              slug: node.slug,
              path: node.path,
              summary: node.summary,
              archimateLayer: ont.layer,
              archimateAspect: ont.aspect,
              archimateElementType: ont.elementType
            }
          })
        )
        break
      }
      case "AdrDoc": {
        lines.push(
          JSON.stringify({
            type: "AdrDoc",
            id: node.id,
            data: {
              id: node.id,
              title: node.title,
              status: node.status,
              path: node.path,
              enforcedByFiles: node.enforcedByFiles,
              referencedSpans: node.referencedSpans,
              referencedServices: node.referencedServices,
              referencedErrors: node.referencedErrors,
              archimateLayer: ont.layer,
              archimateAspect: ont.aspect,
              archimateElementType: ont.elementType
            }
          })
        )
        break
      }
      case "EarsSpec": {
        lines.push(
          JSON.stringify({
            type: "EarsSpec",
            id: node.id,
            data: {
              id: node.id,
              title: node.title,
              status: node.status,
              path: node.path,
              enforcedByFiles: node.enforcedByFiles,
              referencedSpans: node.referencedSpans,
              referencedServices: node.referencedServices,
              referencedErrors: node.referencedErrors,
              archimateLayer: ont.layer,
              archimateAspect: ont.aspect,
              archimateElementType: ont.elementType
            }
          })
        )
        break
      }
    }
  }

  for (const [, edge] of Graph.edges(g)) {
    const rel = classifyOntologyEdge(edge.data)
    switch (edge.data._tag) {
      case "RequiresService": {
        lines.push(
          JSON.stringify({
            edge: "RequiresService",
            type: "RequiresService",
            from: edge.data.callerQualname,
            to: edge.data.tagId,
            data: {
              archimateRelation: rel
            }
          })
        )
        break
      }
      case "FailsWith": {
        lines.push(
          JSON.stringify({
            edge: "FailsWith",
            type: "FailsWith",
            from: edge.data.callerQualname,
            to: edge.data.errorTag,
            data: {
              archimateRelation: rel
            }
          })
        )
        break
      }
      case "ProvidesService": {
        lines.push(
          JSON.stringify({
            edge: "ProvidesService",
            type: "ProvidesService",
            from: edge.data.layerQualname,
            to: edge.data.tagId,
            data: {
              archimateRelation: rel
            }
          })
        )
        break
      }
      case "LayerRequires": {
        lines.push(
          JSON.stringify({
            edge: "LayerRequires",
            type: "LayerRequires",
            from: edge.data.layerQualname,
            to: edge.data.tagId,
            data: {
              archimateRelation: rel
            }
          })
        )
        break
      }
      case "TracedCall": {
        lines.push(
          JSON.stringify({
            edge: "TracedCall",
            type: "TracedCall",
            from: edge.data.callerQualname,
            to: edge.data.calleeQualname,
            data: {
              callCount: edge.data.callCount,
              receiverLayer: edge.data.receiverLayer,
              archimateRelation: rel
            }
          })
        )
        break
      }
      case "ExercisesSpan": {
        lines.push(
          JSON.stringify({
            edge: "ExercisesSpan",
            type: "ExercisesSpan",
            from: edge.data.testId,
            to: edge.data.calleeQualname,
            data: {
              callCount: edge.data.callCount,
              receiverLayer: edge.data.receiverLayer,
              archimateRelation: rel
            }
          })
        )
        break
      }
      case "GovernsSymbol": {
        lines.push(
          JSON.stringify({
            edge: "GovernsSymbol",
            type: "GovernsSymbol",
            from: edge.data.adrId,
            to: edge.data.targetKey,
            data: {
              targetKind: edge.data.targetKind,
              archimateRelation: rel
            }
          })
        )
        break
      }
      case "SpecifiesSymbol": {
        lines.push(
          JSON.stringify({
            edge: "SpecifiesSymbol",
            type: "SpecifiesSymbol",
            from: edge.data.specId,
            to: edge.data.targetKey,
            data: {
              targetKind: edge.data.targetKind,
              archimateRelation: rel
            }
          })
        )
        break
      }
    }
  }

  return lines.join("\n")
}

export const saveGraphSnapshot = (
  harnessGraph: HarnessGraph,
  filePath: string
): void => {
  const snapshot = Graph.toSnapshot(harnessGraph.graph)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8")
}

const decodeJsonToSnapshot = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown)
)

export const loadGraphSnapshot = (filePath: string): HarnessGraph => {
  const content = fs.readFileSync(filePath, "utf-8")
  const raw = decodeJsonToSnapshot(content) as Graph.Snapshot<
    HarnessNode,
    HarnessEdge,
    "directed"
  >
  const graph = Graph.fromSnapshot(raw) as Graph.DirectedGraph<HarnessNode, HarnessEdge>
  const nodeIndexByKey = new Map<string, Graph.NodeIndex>()
  for (const [idx, node] of Graph.nodes(graph)) {
    nodeIndexByKey.set(getNodeKey(node), idx)
  }
  return { graph, nodeIndexByKey }
}

export const saveGraphSnapshotEffect = (
  harnessGraph: HarnessGraph,
  filePath: string
): Effect.Effect<void> => Effect.sync(() => saveGraphSnapshot(harnessGraph, filePath))

export const loadGraphSnapshotEffect = (
  filePath: string
): Effect.Effect<HarnessGraph> => Effect.sync(() => loadGraphSnapshot(filePath))

export interface HarnessGraphDiff {
  readonly missingFns: ReadonlyArray<string>
  readonly missingServices: ReadonlyArray<string>
  readonly remainingStubs: ReadonlyArray<string>
  readonly missingEdges: ReadonlyArray<HarnessEdge>
  readonly differenceGraph: Graph.DirectedGraph<HarnessNode, HarnessEdge>
  readonly isGreen: boolean
}

export const diffHarnessGraphs = (
  implGraph: HarnessGraph,
  planGraph: HarnessGraph
): HarnessGraphDiff => {
  const missingFns: Array<string> = []
  const missingServices: Array<string> = []
  const remainingStubs: Array<string> = []
  const missingEdges: Array<HarnessEdge> = []

  // Check planned EffectFn
  for (const [, node] of Graph.nodes(planGraph.graph)) {
    if (node._tag === "EffectFn") {
      const implNode = resolveNode(implGraph, node.qualname)
      if (!implNode || implNode._tag !== "EffectFn") {
        missingFns.push(node.qualname)
      }
    } else if (node._tag === "ServiceTag") {
      const implNode = resolveNode(implGraph, node.tagId)
      if (!implNode || implNode._tag !== "ServiceTag") {
        missingServices.push(node.tagId)
      }
    }
  }

  // Check stubs in impl
  for (const [, node] of Graph.nodes(implGraph.graph)) {
    if (node._tag === "EffectFn" && node.isStub) {
      remainingStubs.push(node.qualname)
    }
  }

  // Check planned edges
  const implEdgeKeys = new Set<string>()
  for (const [, edge] of Graph.edges(implGraph.graph)) {
    implEdgeKeys.add(getEdgeKey(edge.data))
  }

  for (const [, edge] of Graph.edges(planGraph.graph)) {
    if (
      edge.data._tag === "RequiresService" ||
      edge.data._tag === "FailsWith" ||
      edge.data._tag === "SpecifiesSymbol" ||
      edge.data._tag === "GovernsSymbol"
    ) {
      const key = getEdgeKey(edge.data)
      if (!implEdgeKeys.has(key)) {
        missingEdges.push(edge.data)
      }
    }
  }

  const differenceGraph = Graph.difference(implGraph.graph, planGraph.graph, {
    nodeIdentity: getNodeKey,
    edgeIdentity: getEdgeKey
  })

  const isGreen =
    missingFns.length === 0 &&
    missingServices.length === 0 &&
    remainingStubs.length === 0 &&
    missingEdges.length === 0

  return {
    missingFns,
    missingServices,
    remainingStubs,
    missingEdges,
    differenceGraph,
    isGreen
  }
}
