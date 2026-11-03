import { Option } from "effect"
import * as Graph from "effect/Graph"
import { findTestsReaching, resolveNode } from "./graph-engine.js"
import { getNodeKey, type HarnessEdge, type HarnessGraph, type HarnessNode } from "./model.js"

export type ArchiMateLayer =
  | "Motivation"
  | "Business"
  | "Application"
  | "Technology"
  | "Implementation"

export type ArchiMateAspect = "Motivation" | "Behavior" | "ActiveStructure" | "PassiveStructure"

export type ArchiMateElementType =
  | "DriverOrConstraint"
  | "Requirement"
  | "BusinessRule"
  | "BusinessProcess"
  | "BusinessEvent"
  | "ApplicationService"
  | "ApplicationComponent"
  | "ApplicationFunction"
  | "TechnologyService"
  | "WorkPackageTest"
  | "AssessmentPattern"

export type ArchiMateRelationType =
  | "Influence"
  | "Realization"
  | "Serving"
  | "Triggering"
  | "Verification"

export interface OntologyClassifiedNode {
  readonly key: string
  readonly label: string
  readonly nodeTag: HarnessNode["_tag"]
  readonly layer: ArchiMateLayer
  readonly aspect: ArchiMateAspect
  readonly elementType: ArchiMateElementType
  readonly file?: string | undefined
}

export interface OntologyClassifiedEdge {
  readonly from: string
  readonly to: string
  readonly edgeTag: HarnessEdge["_tag"]
  readonly relation: ArchiMateRelationType
  readonly fromLayer: ArchiMateLayer
  readonly toLayer: ArchiMateLayer
}

export interface OntologyLayerProjection {
  readonly layers: {
    readonly Motivation: ReadonlyArray<OntologyClassifiedNode>
    readonly Business: ReadonlyArray<OntologyClassifiedNode>
    readonly Application: ReadonlyArray<OntologyClassifiedNode>
    readonly Technology: ReadonlyArray<OntologyClassifiedNode>
    readonly Implementation: ReadonlyArray<OntologyClassifiedNode>
  }
  readonly edges: ReadonlyArray<OntologyClassifiedEdge>
  readonly mermaid: string
}

export interface OntologyWhyResult {
  readonly target: OntologyClassifiedNode | null
  readonly justified: boolean
  readonly governingAdrs: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly path: string
    readonly via: ReadonlyArray<string>
  }>
  readonly realizingSpecs: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly path: string
    readonly via: ReadonlyArray<string>
  }>
  readonly upwardChain: ReadonlyArray<OntologyClassifiedEdge>
}

export interface OntologyImpactResult {
  readonly target: OntologyClassifiedNode | null
  readonly impactByLayer: {
    readonly Motivation: ReadonlyArray<OntologyClassifiedNode>
    readonly Business: ReadonlyArray<OntologyClassifiedNode>
    readonly Application: ReadonlyArray<OntologyClassifiedNode>
    readonly Technology: ReadonlyArray<OntologyClassifiedNode>
    readonly Implementation: ReadonlyArray<OntologyClassifiedNode>
  }
  readonly affectedSpecs: ReadonlyArray<string>
  readonly affectedAdrs: ReadonlyArray<string>
  readonly reachingTests: ReadonlyArray<string>
}

const isTechnologyService = (tagId: string, name: string, packageTag: string): boolean =>
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)\b/.test(tagId) ||
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)\b/.test(name) ||
  packageTag === "infra"

export const classifyOntologyNode = (node: HarnessNode): OntologyClassifiedNode => {
  switch (node._tag) {
    case "AdrDoc":
      return {
        key: node.id,
        label: node.title,
        nodeTag: "AdrDoc",
        layer: "Motivation",
        aspect: "Motivation",
        elementType: "DriverOrConstraint",
        file: node.path,
      }
    case "EarsSpec":
      return {
        key: node.id,
        label: node.title,
        nodeTag: "EarsSpec",
        layer: "Motivation",
        aspect: "Motivation",
        elementType: "Requirement",
        file: node.path,
      }
    case "EffectFn": {
      if (node.packageTag === "domain") {
        const isRule = node.spanName === "decide" || node.spanName.endsWith(".decide")
        return {
          key: node.qualname,
          label: node.spanName,
          nodeTag: "EffectFn",
          layer: "Business",
          aspect: "Behavior",
          elementType: isRule ? "BusinessRule" : "BusinessProcess",
          file: node.file,
        }
      }
      return {
        key: node.qualname,
        label: node.spanName,
        nodeTag: "EffectFn",
        layer: "Application",
        aspect: "Behavior",
        elementType: "ApplicationFunction",
        file: node.file,
      }
    }
    case "TaggedError":
      return {
        key: node.errorTag,
        label: node.errorTag,
        nodeTag: "TaggedError",
        layer: "Business",
        aspect: "PassiveStructure",
        elementType: "BusinessEvent",
        file: node.file,
      }
    case "ServiceTag": {
      const isTech = isTechnologyService(node.tagId, node.name, node.packageTag)
      return {
        key: node.tagId,
        label: node.name,
        nodeTag: "ServiceTag",
        layer: isTech ? "Technology" : "Application",
        aspect: isTech ? "ActiveStructure" : "Behavior",
        elementType: isTech ? "TechnologyService" : "ApplicationService",
        file: node.file,
      }
    }
    case "ServiceLayer": {
      const isInfra = node.layerKind === "infra"
      return {
        key: node.qualname,
        label: node.qualname.split("#")[1] ?? node.qualname,
        nodeTag: "ServiceLayer",
        layer: isInfra ? "Technology" : "Application",
        aspect: "ActiveStructure",
        elementType: "ApplicationComponent",
        file: node.file,
      }
    }
    case "PatternDoc":
      return {
        key: node.slug,
        label: node.slug,
        nodeTag: "PatternDoc",
        layer: "Technology",
        aspect: "PassiveStructure",
        elementType: "AssessmentPattern",
        file: node.path,
      }
    case "VitestCase":
      return {
        key: node.testId,
        label: node.testName,
        nodeTag: "VitestCase",
        layer: "Implementation",
        aspect: "Behavior",
        elementType: "WorkPackageTest",
        file: node.testFile,
      }
  }
}

export const classifyOntologyEdge = (edge: HarnessEdge): ArchiMateRelationType => {
  switch (edge._tag) {
    case "GovernsSymbol":
      return "Influence"
    case "SpecifiesSymbol":
    case "ProvidesService":
      return "Realization"
    case "RequiresService":
    case "LayerRequires":
      return "Serving"
    case "FailsWith":
    case "TracedCall":
      return "Triggering"
    case "ExercisesSpan":
      return "Verification"
  }
}

export const renderOntologyMermaid = (harnessGraph: HarnessGraph): string => {
  const g = harnessGraph.graph
  const lines: Array<string> = ["flowchart TB"]

  const layers: Record<ArchiMateLayer, Array<{ readonly id: string; readonly label: string }>> = {
    Motivation: [],
    Business: [],
    Application: [],
    Technology: [],
    Implementation: [],
  }

  const keyToId = new Map<string, string>()
  let idCounter = 0
  const getSafeId = (key: string): string => {
    let id = keyToId.get(key)
    if (!id) {
      id = `n${idCounter++}`
      keyToId.set(key, id)
    }
    return id
  }

  for (const [, node] of Graph.nodes(g)) {
    const classified = classifyOntologyNode(node)
    const id = getSafeId(classified.key)
    const label = `${classified.label} (${classified.elementType})`.replace(/"/g, "'")
    layers[classified.layer].push({ id, label })
  }

  const layerOrder: ReadonlyArray<ArchiMateLayer> = [
    "Motivation",
    "Business",
    "Application",
    "Technology",
    "Implementation",
  ]

  for (const layer of layerOrder) {
    lines.push(`  subgraph ${layer}`)
    for (const item of layers[layer]) {
      lines.push(`    ${item.id}["${item.label}"]`)
    }
    lines.push("  end")
  }

  for (const [, edge] of Graph.edges(g)) {
    const srcNodeOpt = Graph.getNode(g, edge.source)
    const dstNodeOpt = Graph.getNode(g, edge.target)
    if (Option.isSome(srcNodeOpt) && Option.isSome(dstNodeOpt)) {
      const srcKey = getNodeKey(srcNodeOpt.value)
      const dstKey = getNodeKey(dstNodeOpt.value)
      const srcId = getSafeId(srcKey)
      const dstId = getSafeId(dstKey)
      const rel = classifyOntologyEdge(edge.data)
      lines.push(`  ${srcId} -- ${rel} --> ${dstId}`)
    }
  }

  return lines.join("\n")
}

export const projectOntologyLayers = (harnessGraph: HarnessGraph): OntologyLayerProjection => {
  const g = harnessGraph.graph
  const motivation: Array<OntologyClassifiedNode> = []
  const business: Array<OntologyClassifiedNode> = []
  const application: Array<OntologyClassifiedNode> = []
  const technology: Array<OntologyClassifiedNode> = []
  const implementation: Array<OntologyClassifiedNode> = []

  const nodeMap = new Map<Graph.NodeIndex, OntologyClassifiedNode>()

  for (const [idx, node] of Graph.nodes(g)) {
    const classified = classifyOntologyNode(node)
    nodeMap.set(idx, classified)
    switch (classified.layer) {
      case "Motivation":
        motivation.push(classified)
        break
      case "Business":
        business.push(classified)
        break
      case "Application":
        application.push(classified)
        break
      case "Technology":
        technology.push(classified)
        break
      case "Implementation":
        implementation.push(classified)
        break
    }
  }

  const edges: Array<OntologyClassifiedEdge> = []
  for (const [, edge] of Graph.edges(g)) {
    const srcNode = nodeMap.get(edge.source)
    const dstNode = nodeMap.get(edge.target)
    if (srcNode !== undefined && dstNode !== undefined) {
      edges.push({
        from: srcNode.key,
        to: dstNode.key,
        edgeTag: edge.data._tag,
        relation: classifyOntologyEdge(edge.data),
        fromLayer: srcNode.layer,
        toLayer: dstNode.layer,
      })
    }
  }

  const mermaid = renderOntologyMermaid(harnessGraph)

  return {
    layers: {
      Motivation: motivation,
      Business: business,
      Application: application,
      Technology: technology,
      Implementation: implementation,
    },
    edges,
    mermaid,
  }
}

export const queryOntologyWhy = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): OntologyWhyResult => {
  const targetNode = resolveNode(harnessGraph, symbolOrSpan)
  if (!targetNode) {
    return {
      target: null,
      justified: false,
      governingAdrs: [],
      realizingSpecs: [],
      upwardChain: [],
    }
  }

  const targetClassified = classifyOntologyNode(targetNode)
  const targetKey = getNodeKey(targetNode)
  const targetIndex = harnessGraph.nodeIndexByKey.get(targetKey)

  if (targetIndex === undefined) {
    return {
      target: targetClassified,
      justified: false,
      governingAdrs: [],
      realizingSpecs: [],
      upwardChain: [],
    }
  }

  const governingAdrs: Array<{
    readonly id: string
    readonly title: string
    readonly path: string
    readonly via: ReadonlyArray<string>
  }> = []
  const realizingSpecs: Array<{
    readonly id: string
    readonly title: string
    readonly path: string
    readonly via: ReadonlyArray<string>
  }> = []
  const seenAdrs = new Set<string>()
  const seenSpecs = new Set<string>()

  if (targetNode._tag === "AdrDoc") {
    governingAdrs.push({
      id: targetNode.id,
      title: targetNode.title,
      path: targetNode.path,
      via: [targetKey],
    })
    seenAdrs.add(targetNode.id)
  } else if (targetNode._tag === "EarsSpec") {
    realizingSpecs.push({
      id: targetNode.id,
      title: targetNode.title,
      path: targetNode.path,
      via: [targetKey],
    })
    seenSpecs.add(targetNode.id)
  }

  const upwardChain: Array<OntologyClassifiedEdge> = []
  const seenEdges = new Set<string>()

  const queue: Array<{
    readonly nodeIndex: Graph.NodeIndex
    readonly pathKeys: ReadonlyArray<string>
  }> = [{ nodeIndex: targetIndex, pathKeys: [targetKey] }]

  const visited = new Set<Graph.NodeIndex>([targetIndex])
  const g = harnessGraph.graph

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break

    const currNodeOpt = Graph.getNode(g, current.nodeIndex)
    if (Option.isNone(currNodeOpt)) continue
    const currNode = currNodeOpt.value

    // Case 1: Incoming edges v -> u
    const inEdgeIndices = Graph.incomingEdges(g, current.nodeIndex)
    for (const eIdx of inEdgeIndices) {
      const edgeOpt = Graph.getEdge(g, eIdx)
      if (Option.isNone(edgeOpt)) continue
      const edge = edgeOpt.value
      const tag = edge.data._tag
      if (
        tag === "GovernsSymbol" ||
        tag === "SpecifiesSymbol" ||
        tag === "RequiresService" ||
        tag === "LayerRequires" ||
        tag === "FailsWith" ||
        tag === "TracedCall" ||
        tag === "ProvidesService"
      ) {
        const vIdx = edge.source
        const vNodeOpt = Graph.getNode(g, vIdx)
        if (Option.isNone(vNodeOpt)) continue
        const vNode = vNodeOpt.value
        const vKey = getNodeKey(vNode)

        const fromClassified = classifyOntologyNode(vNode)
        const toClassified = classifyOntologyNode(currNode)
        const edgeKey = `${fromClassified.key}->${toClassified.key}:${edge.data._tag}`
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey)
          upwardChain.push({
            from: fromClassified.key,
            to: toClassified.key,
            edgeTag: edge.data._tag,
            relation: classifyOntologyEdge(edge.data),
            fromLayer: fromClassified.layer,
            toLayer: toClassified.layer,
          })
        }

        const newPath = [vKey, ...current.pathKeys]

        if (vNode._tag === "AdrDoc" && !seenAdrs.has(vNode.id)) {
          seenAdrs.add(vNode.id)
          governingAdrs.push({
            id: vNode.id,
            title: vNode.title,
            path: vNode.path,
            via: newPath,
          })
        } else if (vNode._tag === "EarsSpec" && !seenSpecs.has(vNode.id)) {
          seenSpecs.add(vNode.id)
          realizingSpecs.push({
            id: vNode.id,
            title: vNode.title,
            path: vNode.path,
            via: newPath,
          })
        }

        if (!visited.has(vIdx)) {
          visited.add(vIdx)
          queue.push({ nodeIndex: vIdx, pathKeys: newPath })
        }
      }
    }

    // Case 2: currNode is ServiceLayer with outgoing ProvidesService edge currNode -> v
    if (currNode._tag === "ServiceLayer") {
      const outEdgeIndices = Graph.outgoingEdges(g, current.nodeIndex)
      for (const eIdx of outEdgeIndices) {
        const edgeOpt = Graph.getEdge(g, eIdx)
        if (Option.isNone(edgeOpt)) continue
        const edge = edgeOpt.value
        if (edge.data._tag === "ProvidesService") {
          const vIdx = edge.target
          const vNodeOpt = Graph.getNode(g, vIdx)
          if (Option.isNone(vNodeOpt)) continue
          const vNode = vNodeOpt.value
          const vKey = getNodeKey(vNode)

          const fromClassified = classifyOntologyNode(currNode)
          const toClassified = classifyOntologyNode(vNode)
          const edgeKey = `${fromClassified.key}->${toClassified.key}:${edge.data._tag}`
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey)
            upwardChain.push({
              from: fromClassified.key,
              to: toClassified.key,
              edgeTag: edge.data._tag,
              relation: classifyOntologyEdge(edge.data),
              fromLayer: fromClassified.layer,
              toLayer: toClassified.layer,
            })
          }

          const newPath = [vKey, ...current.pathKeys]

          if (vNode._tag === "AdrDoc" && !seenAdrs.has(vNode.id)) {
            seenAdrs.add(vNode.id)
            governingAdrs.push({
              id: vNode.id,
              title: vNode.title,
              path: vNode.path,
              via: newPath,
            })
          } else if (vNode._tag === "EarsSpec" && !seenSpecs.has(vNode.id)) {
            seenSpecs.add(vNode.id)
            realizingSpecs.push({
              id: vNode.id,
              title: vNode.title,
              path: vNode.path,
              via: newPath,
            })
          }

          if (!visited.has(vIdx)) {
            visited.add(vIdx)
            queue.push({ nodeIndex: vIdx, pathKeys: newPath })
          }
        }
      }
    }
  }

  const justified =
    governingAdrs.length > 0 ||
    realizingSpecs.length > 0 ||
    targetNode._tag === "AdrDoc" ||
    targetNode._tag === "EarsSpec"

  return {
    target: targetClassified,
    justified,
    governingAdrs,
    realizingSpecs,
    upwardChain,
  }
}

export const queryOntologyImpact = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): OntologyImpactResult => {
  const targetNode = resolveNode(harnessGraph, symbolOrSpan)
  if (!targetNode) {
    return {
      target: null,
      impactByLayer: {
        Motivation: [],
        Business: [],
        Application: [],
        Technology: [],
        Implementation: [],
      },
      affectedSpecs: [],
      affectedAdrs: [],
      reachingTests: [],
    }
  }

  const targetClassified = classifyOntologyNode(targetNode)
  const targetKey = getNodeKey(targetNode)
  const targetIndex = harnessGraph.nodeIndexByKey.get(targetKey)

  if (targetIndex === undefined) {
    return {
      target: targetClassified,
      impactByLayer: {
        Motivation: [],
        Business: [],
        Application: [],
        Technology: [],
        Implementation: [],
      },
      affectedSpecs: [],
      affectedAdrs: [],
      reachingTests: [],
    }
  }

  const impactByLayer: {
    Motivation: Array<OntologyClassifiedNode>
    Business: Array<OntologyClassifiedNode>
    Application: Array<OntologyClassifiedNode>
    Technology: Array<OntologyClassifiedNode>
    Implementation: Array<OntologyClassifiedNode>
  } = {
    Motivation: [],
    Business: [],
    Application: [],
    Technology: [],
    Implementation: [],
  }

  const affectedSpecs: Array<string> = []
  const affectedAdrs: Array<string> = []
  const reachingTests: Array<string> = []
  const seenSpecs = new Set<string>()
  const seenAdrs = new Set<string>()
  const seenTests = new Set<string>()

  const staticTests = findTestsReaching(harnessGraph, symbolOrSpan)
  for (const t of staticTests) {
    if (!seenTests.has(t.testId)) {
      seenTests.add(t.testId)
      reachingTests.push(t.testId)
    }
  }

  const visited = new Set<Graph.NodeIndex>([targetIndex])
  const queue: Array<Graph.NodeIndex> = [targetIndex]
  const g = harnessGraph.graph

  while (queue.length > 0) {
    const currIdx = queue.shift()
    if (currIdx === undefined) break

    // Outgoing edges
    const outEdges = Graph.outgoingEdges(g, currIdx)
    for (const eIdx of outEdges) {
      const edgeOpt = Graph.getEdge(g, eIdx)
      if (Option.isNone(edgeOpt)) continue
      const nextIdx = edgeOpt.value.target
      if (!visited.has(nextIdx)) {
        visited.add(nextIdx)
        queue.push(nextIdx)
        const nodeOpt = Graph.getNode(g, nextIdx)
        if (Option.isSome(nodeOpt)) {
          const classified = classifyOntologyNode(nodeOpt.value)
          impactByLayer[classified.layer].push(classified)
          if (nodeOpt.value._tag === "EarsSpec" && !seenSpecs.has(nodeOpt.value.id)) {
            seenSpecs.add(nodeOpt.value.id)
            affectedSpecs.push(nodeOpt.value.id)
          } else if (nodeOpt.value._tag === "AdrDoc" && !seenAdrs.has(nodeOpt.value.id)) {
            seenAdrs.add(nodeOpt.value.id)
            affectedAdrs.push(nodeOpt.value.id)
          } else if (nodeOpt.value._tag === "VitestCase" && !seenTests.has(nodeOpt.value.testId)) {
            seenTests.add(nodeOpt.value.testId)
            reachingTests.push(nodeOpt.value.testId)
          }
        }
      }
    }

    // Incoming edges
    const inEdges = Graph.incomingEdges(g, currIdx)
    for (const eIdx of inEdges) {
      const edgeOpt = Graph.getEdge(g, eIdx)
      if (Option.isNone(edgeOpt)) continue
      const nextIdx = edgeOpt.value.source
      if (!visited.has(nextIdx)) {
        visited.add(nextIdx)
        queue.push(nextIdx)
        const nodeOpt = Graph.getNode(g, nextIdx)
        if (Option.isSome(nodeOpt)) {
          const classified = classifyOntologyNode(nodeOpt.value)
          impactByLayer[classified.layer].push(classified)
          if (nodeOpt.value._tag === "EarsSpec" && !seenSpecs.has(nodeOpt.value.id)) {
            seenSpecs.add(nodeOpt.value.id)
            affectedSpecs.push(nodeOpt.value.id)
          } else if (nodeOpt.value._tag === "AdrDoc" && !seenAdrs.has(nodeOpt.value.id)) {
            seenAdrs.add(nodeOpt.value.id)
            affectedAdrs.push(nodeOpt.value.id)
          } else if (nodeOpt.value._tag === "VitestCase" && !seenTests.has(nodeOpt.value.testId)) {
            seenTests.add(nodeOpt.value.testId)
            reachingTests.push(nodeOpt.value.testId)
          }
        }
      }
    }
  }

  return {
    target: targetClassified,
    impactByLayer,
    affectedSpecs,
    affectedAdrs,
    reachingTests,
  }
}
