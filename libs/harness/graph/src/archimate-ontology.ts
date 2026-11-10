import * as Graph from "effect/Graph"
import * as Option from "effect/Option"
import { match } from "ts-pattern"
import { findTestsReaching, type HarnessGraph, resolveNode } from "./graph-engine.js"
import {
  getArchimateRelationForRole,
  getNodeKey,
  type HarnessEdge,
  type HarnessNode,
  isEntityNode,
  isRelationNode,
} from "./model.js"

export type ArchiMateLayer =
  | "Motivation"
  | "Business"
  | "Application"
  | "Technology"
  | "Implementation"

export type ArchiMateAspect = "ActiveStructure" | "Behavior" | "PassiveStructure" | "Motivation"

export type ArchiMateElementType =
  | "DriverOrConstraint"
  | "Requirement"
  | "BusinessProcess"
  | "BusinessRule"
  | "BusinessEvent"
  | "DataObject"
  | "ApplicationService"
  | "ApplicationFunction"
  | "ApplicationComponent"
  | "TechnologyService"
  | "SystemSoftware"
  | "WorkPackageTest"
  | "AssessmentPattern"
  | "CollaborationRelation"

export type ArchiMateRelationType =
  | "Realization"
  | "Serving"
  | "Access"
  | "Triggering"
  | "Flow"
  | "Influence"
  | "Composition"
  | "Association"
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
  readonly sourceKey: string
  readonly targetKey: string
  readonly edgeTag: string
  readonly role: string
  readonly relationId: string
  readonly relation: ArchiMateRelationType
}

export interface OntologyLayerProjection {
  readonly layers: Readonly<Record<ArchiMateLayer, ReadonlyArray<OntologyClassifiedNode>>>
  readonly edges: ReadonlyArray<OntologyClassifiedEdge>
  readonly mermaid: string
}

export interface OntologyWhyResult {
  readonly symbol: string
  readonly target: OntologyClassifiedNode | null
  readonly resolvedNode: OntologyClassifiedNode | null
  readonly governingAdrs: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly status: string
    readonly path: string
    readonly via: ReadonlyArray<string>
  }>
  readonly realizingSpecs: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly status: string
    readonly path: string
    readonly via: ReadonlyArray<string>
    readonly requirementIds: ReadonlyArray<string>
  }>
  readonly specifyingEars: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly status: string
    readonly path: string
    readonly via: ReadonlyArray<string>
    readonly requirementIds: ReadonlyArray<string>
  }>
  readonly upwardChain: ReadonlyArray<OntologyClassifiedNode>
  readonly realizationPaths: ReadonlyArray<ReadonlyArray<string>>
  readonly justified: boolean
}

export interface OntologyImpactResult {
  readonly source: string
  readonly target: OntologyClassifiedNode | null
  readonly resolvedSource: OntologyClassifiedNode | null
  readonly affectedAdrs: ReadonlyArray<string>
  readonly affectedSpecs: ReadonlyArray<string>
  readonly reachingTests: ReadonlyArray<string>
  readonly impactByLayer: Readonly<Record<ArchiMateLayer, ReadonlyArray<OntologyClassifiedNode>>>
  readonly impactedSpans: ReadonlyArray<string>
  readonly impactedServices: ReadonlyArray<string>
  readonly impactedLayers: ReadonlyArray<string>
  readonly impactedErrors: ReadonlyArray<string>
  readonly impactedTests: ReadonlyArray<string>
}

export const tokenizeCamelOrPath = (raw: string): ReadonlyArray<string> =>
  raw.split(/[._$/:-]+/).flatMap((part) =>
    part
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([0-9])([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .trim()
      .split(/\s+/)
      .filter((tok) => tok.length > 0),
  )

const INFRA_OR_CLOUD_TOKENS = new Set<string>([
  "KV",
  "R2",
  "D1",
  "Sql",
  "Drizzle",
  "Sqlite",
  "SqlClient",
  "D1Database",
  "DurableObjectStorage",
  "DurableObject",
  "Cloudflare",
  "Alchemy",
])

export const isInfraOrCloudIdentifier = (id: string, file: string): boolean => {
  if (file.includes("/contract/") || file.includes("/contract.")) {
    return false
  }
  if (id.endsWith("Schema") || id.endsWith("Validator")) {
    return false
  }
  if (
    id.startsWith("Cloudflare.") ||
    id.startsWith("@effect/sql") ||
    id.startsWith("drizzle-orm")
  ) {
    return true
  }
  if (file.includes("/infra/")) {
    return true
  }
  const tokens = tokenizeCamelOrPath(id)
  return tokens.some((tok) => INFRA_OR_CLOUD_TOKENS.has(tok))
}

export const classifyOntologyNode = (node: HarnessNode): OntologyClassifiedNode =>
  match(node)
    .with({ _tag: "AdrDoc" }, (n) => ({
      key: n.id,
      label: n.title,
      nodeTag: n._tag,
      layer: "Motivation" as const,
      aspect: "Motivation" as const,
      elementType: "DriverOrConstraint" as const,
      file: n.path,
    }))
    .with({ _tag: "EarsSpec" }, (n) => ({
      key: n.id,
      label: n.title,
      nodeTag: n._tag,
      layer: "Motivation" as const,
      aspect: "Motivation" as const,
      elementType: "Requirement" as const,
      file: n.path,
    }))
    .with({ _tag: "EffectFn" }, (n) => {
      const isRule = n.spanName.endsWith(".decide") || n.spanName === "decide"
      if (n.packageTag === "domain" || n.packageTag === "contract") {
        return {
          key: n.qualname,
          label: n.spanName,
          nodeTag: n._tag,
          layer: "Business" as const,
          aspect: "Behavior" as const,
          elementType: isRule ? ("BusinessRule" as const) : ("BusinessProcess" as const),
          file: n.file,
        }
      }
      return {
        key: n.qualname,
        label: n.spanName,
        nodeTag: n._tag,
        layer: "Application" as const,
        aspect: "Behavior" as const,
        elementType: "ApplicationFunction" as const,
        file: n.file,
      }
    })
    .with({ _tag: "TaggedError" }, (n) => ({
      key: n.errorTag,
      label: n.errorTag,
      nodeTag: n._tag,
      layer: "Business" as const,
      aspect: "PassiveStructure" as const,
      elementType: "BusinessEvent" as const,
      file: n.file,
    }))
    .with({ _tag: "SchemaDef" }, (n) => ({
      key: n.schemaName,
      label: n.schemaName,
      nodeTag: n._tag,
      layer: "Business" as const,
      aspect: "PassiveStructure" as const,
      elementType: "DataObject" as const,
      file: n.file,
    }))
    .with({ _tag: "ServiceTag" }, (n) => {
      const isTech = isInfraOrCloudIdentifier(n.tagId, n.file)
      return {
        key: n.tagId,
        label: n.name,
        nodeTag: n._tag,
        layer: isTech ? ("Technology" as const) : ("Application" as const),
        aspect: isTech ? ("ActiveStructure" as const) : ("Behavior" as const),
        elementType: isTech ? ("TechnologyService" as const) : ("ApplicationService" as const),
        file: n.file,
      }
    })
    .with({ _tag: "ServiceLayer" }, (n) => {
      const isTech = n.layerKind === "infra" || n.packageTag === "infra"
      return {
        key: n.qualname,
        label: n.qualname.split("#").pop() ?? n.qualname,
        nodeTag: n._tag,
        layer: isTech ? ("Technology" as const) : ("Application" as const),
        aspect: "ActiveStructure" as const,
        elementType: "ApplicationComponent" as const,
        file: n.file,
      }
    })
    .with({ _tag: "PatternDoc" }, (n) => ({
      key: n.slug,
      label: n.slug,
      nodeTag: n._tag,
      layer: "Technology" as const,
      aspect: "PassiveStructure" as const,
      elementType: "AssessmentPattern" as const,
      file: n.path,
    }))
    .with({ _tag: "VitestCase" }, (n) => ({
      key: n.testId,
      label: n.testName,
      nodeTag: n._tag,
      layer: "Implementation" as const,
      aspect: "Behavior" as const,
      elementType: "WorkPackageTest" as const,
      file: n.testFile,
    }))
    .with({ _tag: "EffectSignature" }, (n) => ({
      key: n.relationId,
      label: `Sig:${n.callerQualname}`,
      nodeTag: n._tag,
      layer: "Application" as const,
      aspect: "Behavior" as const,
      elementType: "CollaborationRelation" as const,
      file: n.file,
    }))
    .with({ _tag: "LayerFlow" }, (n) => ({
      key: n.relationId,
      label: `LayerFlow:${n.layerQualname}`,
      nodeTag: n._tag,
      layer: "Technology" as const,
      aspect: "ActiveStructure" as const,
      elementType: "CollaborationRelation" as const,
      file: n.file,
    }))
    .with({ _tag: "TraceabilityTuple" }, (n) => ({
      key: n.relationId,
      label: `Trace:${n.targetSymbolQualname}`,
      nodeTag: n._tag,
      layer: "Motivation" as const,
      aspect: "Motivation" as const,
      elementType: "CollaborationRelation" as const,
    }))
    .with({ _tag: "HttpEndpointTuple" }, (n) => ({
      key: n.relationId,
      label: `HTTP:${n.method} ${n.path}`,
      nodeTag: n._tag,
      layer: "Application" as const,
      aspect: "Behavior" as const,
      elementType: "CollaborationRelation" as const,
      file: n.file,
    }))
    .with({ _tag: "MigrationTuple" }, (n) => ({
      key: n.relationId,
      label: `Migration:${n.migrationId}`,
      nodeTag: n._tag,
      layer: "Technology" as const,
      aspect: "Behavior" as const,
      elementType: "CollaborationRelation" as const,
      file: n.moduleFile,
    }))
    .exhaustive()

export const classifyRoleRelation = (role: string): ArchiMateRelationType => {
  const canonical = getArchimateRelationForRole(role)
  if (canonical === "Assignment" || canonical === "Verification") {
    return "Verification"
  }
  return match(role)
    .with("governing-adr", "enforcing-pattern", () => "Influence" as const)
    .with(
      "specifying-ears",
      "realizing-symbol",
      "provider-layer",
      "provided-service",
      "endpoint-handler",
      "migration-module",
      () => "Realization" as const,
    )
    .with("verifying-test", "exercising-test", "exercised-span", () => "Verification" as const)
    .with("requires-service", "required-service", () => "Serving" as const)
    .with("fails-with", "callee", () => "Triggering" as const)
    .with(
      "caller",
      "uses-schema",
      "input-schema",
      "output-schema",
      "request-schema",
      "response-schema",
      "endpoint-error",
      () => "Access" as const,
    )
    .otherwise(() => {
      if (canonical !== undefined) {
        return match(canonical)
          .with("Realization", () => "Realization" as const)
          .with("Serving", () => "Serving" as const)
          .with("Access", () => "Access" as const)
          .with("Triggering", () => "Triggering" as const)
          .with("Flow", () => "Flow" as const)
          .with("Influence", () => "Influence" as const)
          .with("Composition", () => "Composition" as const)
          .with("Association", () => "Association" as const)
          .otherwise(() => "Association" as const)
      }
      return "Association" as const
    })
}

export const classifyOntologyEdge = (edge: HarnessEdge): ArchiMateRelationType => {
  if (edge.archimateRelation !== undefined) {
    const explicit = match(edge.archimateRelation)
      .with("Realization", () => "Realization" as const)
      .with("Serving", () => "Serving" as const)
      .with("Access", () => "Access" as const)
      .with("Triggering", () => "Triggering" as const)
      .with("Flow", () => "Flow" as const)
      .with("Influence", () => "Influence" as const)
      .with("Composition", () => "Composition" as const)
      .with("Association", () => "Association" as const)
      .with("Verification", () => "Verification" as const)
      .otherwise(() => undefined)
    if (explicit !== undefined) {
      return explicit
    }
  }
  return classifyRoleRelation(edge.role)
}

const renderOntologyMermaidFromParts = (
  layers: Readonly<Record<ArchiMateLayer, ReadonlyArray<OntologyClassifiedNode>>>,
  edges: ReadonlyArray<OntologyClassifiedEdge>,
): string => {
  const lines: Array<string> = ["flowchart TB"]
  const sanitizeId = (key: string): string => `N_${key.replace(/[^a-zA-Z0-9_]/g, "_")}`

  const layerOrder: ReadonlyArray<ArchiMateLayer> = [
    "Motivation",
    "Business",
    "Application",
    "Technology",
    "Implementation",
  ]

  for (const layer of layerOrder) {
    const nodes = layers[layer]
    lines.push(`  subgraph ${layer}["${layer}"]`)
    for (const n of nodes) {
      const safeLabel = n.label.replace(/"/g, "'")
      lines.push(`    ${sanitizeId(`${n.nodeTag}:${n.key}`)}["[${n.elementType}] ${safeLabel}"]`)
    }
    lines.push("  end")
  }

  for (const edge of edges) {
    lines.push(
      `  ${sanitizeId(edge.sourceKey)} -->|${edge.relation}:${edge.role}| ${sanitizeId(edge.targetKey)}`,
    )
  }

  return lines.join("\n")
}

export const projectOntologyLayers = (harnessGraph: HarnessGraph): OntologyLayerProjection => {
  const layers: Record<ArchiMateLayer, Array<OntologyClassifiedNode>> = {
    Motivation: [],
    Business: [],
    Application: [],
    Technology: [],
    Implementation: [],
  }

  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    if (isEntityNode(node)) {
      const classified = classifyOntologyNode(node)
      layers[classified.layer].push(classified)
    }
  }

  const edges: Array<OntologyClassifiedEdge> = []
  for (const [, edge] of Graph.edges(harnessGraph.graph)) {
    const srcOpt = Graph.getNode(harnessGraph.graph, edge.source)
    const dstOpt = Graph.getNode(harnessGraph.graph, edge.target)
    if (Option.isSome(srcOpt) && Option.isSome(dstOpt)) {
      edges.push({
        sourceKey: getNodeKey(srcOpt.value),
        targetKey: getNodeKey(dstOpt.value),
        edgeTag: edge.data._tag,
        role: edge.data.role,
        relationId: edge.data.relationId,
        relation: classifyOntologyEdge(edge.data),
      })
    }
  }

  return {
    layers,
    edges,
    mermaid: renderOntologyMermaidFromParts(layers, edges),
  }
}

export const renderOntologyMermaid = (harnessGraph: HarnessGraph): string =>
  projectOntologyLayers(harnessGraph).mermaid

export const queryOntologyWhy = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): OntologyWhyResult => {
  const targetNode = resolveNode(harnessGraph, symbolOrSpan)
  if (!targetNode) {
    return {
      symbol: symbolOrSpan,
      target: null,
      resolvedNode: null,
      governingAdrs: [],
      realizingSpecs: [],
      specifyingEars: [],
      upwardChain: [],
      realizationPaths: [],
      justified: false,
    }
  }

  const classifiedTarget = classifyOntologyNode(targetNode)
  const targetKey = getNodeKey(targetNode)
  const targetIdx = harnessGraph.nodeIndexByKey.get(targetKey)
  if (targetIdx === undefined) {
    return {
      symbol: symbolOrSpan,
      target: classifiedTarget,
      resolvedNode: classifiedTarget,
      governingAdrs: [],
      realizingSpecs: [],
      specifyingEars: [],
      upwardChain: [classifiedTarget],
      realizationPaths: [],
      justified: false,
    }
  }

  const governingAdrsMap = new Map<
    string,
    { id: string; title: string; status: string; path: string; via: ReadonlyArray<string> }
  >()
  const specifyingEarsMap = new Map<
    string,
    {
      id: string
      title: string
      status: string
      path: string
      via: ReadonlyArray<string>
      requirementIds: Set<string>
    }
  >()
  const upwardChain: Array<OntologyClassifiedNode> = []
  const realizationPaths: Array<ReadonlyArray<string>> = []

  const visited = new Set<Graph.NodeIndex>([targetIdx])
  const queue: Array<{
    readonly idx: Graph.NodeIndex
    readonly labelPath: ReadonlyArray<string>
    readonly keyPath: ReadonlyArray<string>
  }> = [
    {
      idx: targetIdx,
      labelPath: [classifiedTarget.label],
      keyPath: [classifiedTarget.key],
    },
  ]

  while (queue.length > 0) {
    const current = queue.shift()!
    const currentOpt = Graph.getNode(harnessGraph.graph, current.idx)
    if (Option.isNone(currentOpt)) continue
    const currentNode = currentOpt.value

    if (isEntityNode(currentNode)) {
      upwardChain.push(classifyOntologyNode(currentNode))
    }

    if (currentNode._tag === "AdrDoc") {
      const via = [...current.keyPath].reverse()
      if (!governingAdrsMap.has(currentNode.id)) {
        governingAdrsMap.set(currentNode.id, {
          id: currentNode.id,
          title: currentNode.title,
          status: currentNode.status,
          path: currentNode.path,
          via,
        })
      }
      if (current.labelPath.length > 1) {
        realizationPaths.push([...current.labelPath].reverse())
      }
      continue
    }

    if (currentNode._tag === "EarsSpec") {
      const via = [...current.keyPath].reverse()
      const existing = specifyingEarsMap.get(currentNode.id)
      const reqSet = existing ? existing.requirementIds : new Set<string>()
      specifyingEarsMap.set(currentNode.id, {
        id: currentNode.id,
        title: currentNode.title,
        status: currentNode.status,
        path: currentNode.path,
        via: existing ? existing.via : via,
        requirementIds: reqSet,
      })
      if (current.labelPath.length > 1) {
        realizationPaths.push([...current.labelPath].reverse())
      }
      for (const adrId of currentNode.informedByAdrs ?? []) {
        const adrIdx = harnessGraph.nodeIndexByKey.get(`AdrDoc:${adrId}`)
        if (adrIdx !== undefined && !visited.has(adrIdx)) {
          const adrOpt = Graph.getNode(harnessGraph.graph, adrIdx)
          if (Option.isSome(adrOpt)) {
            const adrClassified = classifyOntologyNode(adrOpt.value)
            visited.add(adrIdx)
            queue.push({
              idx: adrIdx,
              labelPath: [...current.labelPath, adrClassified.label],
              keyPath: [...current.keyPath, adrClassified.key],
            })
          }
        }
      }
    }

    const incoming = Graph.incomingEdges(harnessGraph.graph, current.idx)
    for (const inEdgeIdx of incoming) {
      const inEdgeOpt = Graph.getEdge(harnessGraph.graph, inEdgeIdx)
      if (Option.isNone(inEdgeOpt)) continue
      const inEdge = inEdgeOpt.value
      const relOpt = Graph.getNode(harnessGraph.graph, inEdge.source)
      if (Option.isNone(relOpt) || !isRelationNode(relOpt.value)) continue
      const relNode = relOpt.value

      const outEdges = Graph.outgoingEdges(harnessGraph.graph, inEdge.source)
      for (const outEdgeIdx of outEdges) {
        if (outEdgeIdx === inEdgeIdx) continue
        const outEdgeOpt = Graph.getEdge(harnessGraph.graph, outEdgeIdx)
        if (Option.isNone(outEdgeOpt)) continue
        const outEdge = outEdgeOpt.value
        const peerIdx = outEdge.target

        const canHop =
          (relNode._tag === "TraceabilityTuple" &&
            (outEdge.data.role === "governing-adr" || outEdge.data.role === "specifying-ears")) ||
          (relNode._tag === "EffectSignature" &&
            ((inEdge.data.role === "callee" && outEdge.data.role === "caller") ||
              (inEdge.data.role === "caller" &&
                (outEdge.data.role === "requires-service" ||
                  outEdge.data.role === "fails-with")))) ||
          (relNode._tag === "LayerFlow" &&
            ((inEdge.data.role === "provider-layer" && outEdge.data.role === "provided-service") ||
              (inEdge.data.role === "provided-service" && outEdge.data.role === "provider-layer")))

        if (!canHop) continue

        const peerOpt = Graph.getNode(harnessGraph.graph, peerIdx)
        if (Option.isNone(peerOpt)) continue
        const peerNode = peerOpt.value
        const peerClassified = classifyOntologyNode(peerNode)

        if (
          relNode._tag === "TraceabilityTuple" &&
          peerNode._tag === "EarsSpec" &&
          relNode.requirementId
        ) {
          const existing = specifyingEarsMap.get(peerNode.id)
          if (existing) {
            existing.requirementIds.add(relNode.requirementId)
          } else {
            specifyingEarsMap.set(peerNode.id, {
              id: peerNode.id,
              title: peerNode.title,
              status: peerNode.status,
              path: peerNode.path,
              via: [...current.keyPath, peerClassified.key].reverse(),
              requirementIds: new Set([relNode.requirementId]),
            })
          }
        }

        if (!visited.has(peerIdx)) {
          visited.add(peerIdx)
          queue.push({
            idx: peerIdx,
            labelPath: [...current.labelPath, peerClassified.label],
            keyPath: [...current.keyPath, peerClassified.key],
          })
        }
      }
    }
  }

  if (classifiedTarget.file) {
    for (const [, node] of Graph.nodes(harnessGraph.graph)) {
      if (node._tag === "AdrDoc" && node.enforcedByFiles.includes(classifiedTarget.file)) {
        if (!governingAdrsMap.has(node.id)) {
          governingAdrsMap.set(node.id, {
            id: node.id,
            title: node.title,
            status: node.status,
            path: node.path,
            via: [node.id, classifiedTarget.key],
          })
          realizationPaths.push([node.title, classifiedTarget.label])
        }
      } else if (node._tag === "EarsSpec" && node.enforcedByFiles.includes(classifiedTarget.file)) {
        if (!specifyingEarsMap.has(node.id)) {
          specifyingEarsMap.set(node.id, {
            id: node.id,
            title: node.title,
            status: node.status,
            path: node.path,
            via: [node.id, classifiedTarget.key],
            requirementIds: new Set<string>(),
          })
          realizationPaths.push([node.title, classifiedTarget.label])
        }
      }
    }
  }

  const governingAdrs = Array.from(governingAdrsMap.values())
  const realizingSpecs = Array.from(specifyingEarsMap.values()).map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    path: s.path,
    via: s.via,
    requirementIds: Array.from(s.requirementIds),
  }))

  return {
    symbol: symbolOrSpan,
    target: classifiedTarget,
    resolvedNode: classifiedTarget,
    governingAdrs,
    realizingSpecs,
    specifyingEars: realizingSpecs,
    upwardChain,
    realizationPaths,
    justified: governingAdrs.length > 0 || realizingSpecs.length > 0,
  }
}

export const queryOntologyImpact = (
  harnessGraph: HarnessGraph,
  idOrPath: string,
): OntologyImpactResult => {
  const emptyLayers: Record<ArchiMateLayer, Array<OntologyClassifiedNode>> = {
    Motivation: [],
    Business: [],
    Application: [],
    Technology: [],
    Implementation: [],
  }

  const sourceNode = resolveNode(harnessGraph, idOrPath)
  if (!sourceNode) {
    return {
      source: idOrPath,
      target: null,
      resolvedSource: null,
      affectedAdrs: [],
      affectedSpecs: [],
      reachingTests: [],
      impactByLayer: emptyLayers,
      impactedSpans: [],
      impactedServices: [],
      impactedLayers: [],
      impactedErrors: [],
      impactedTests: [],
    }
  }

  const classifiedSource = classifyOntologyNode(sourceNode)
  const sourceKey = getNodeKey(sourceNode)
  const sourceIdx = harnessGraph.nodeIndexByKey.get(sourceKey)
  if (sourceIdx === undefined) {
    return {
      source: idOrPath,
      target: classifiedSource,
      resolvedSource: classifiedSource,
      affectedAdrs: [],
      affectedSpecs: [],
      reachingTests: [],
      impactByLayer: emptyLayers,
      impactedSpans: [],
      impactedServices: [],
      impactedLayers: [],
      impactedErrors: [],
      impactedTests: [],
    }
  }

  const affectedAdrs = new Set<string>()
  const affectedSpecs = new Set<string>()
  const impactedSpans = new Set<string>()
  const impactedServices = new Set<string>()
  const impactedLayers = new Set<string>()
  const impactedErrors = new Set<string>()
  const impactedTests = new Set<string>()
  const impactByLayer: Record<ArchiMateLayer, Array<OntologyClassifiedNode>> = {
    Motivation: [],
    Business: [],
    Application: [],
    Technology: [],
    Implementation: [],
  }

  const visited = new Set<Graph.NodeIndex>([sourceIdx])
  const queue: Array<Graph.NodeIndex> = [sourceIdx]

  while (queue.length > 0) {
    const currentIdx = queue.shift()!
    const currentOpt = Graph.getNode(harnessGraph.graph, currentIdx)
    if (Option.isNone(currentOpt)) continue
    const node = currentOpt.value

    if (currentIdx !== sourceIdx && isEntityNode(node)) {
      const classified = classifyOntologyNode(node)
      impactByLayer[classified.layer].push(classified)

      match(node)
        .with({ _tag: "AdrDoc" }, (n) => {
          affectedAdrs.add(n.id)
        })
        .with({ _tag: "EarsSpec" }, (n) => {
          affectedSpecs.add(n.id)
        })
        .with({ _tag: "EffectFn" }, (n) => {
          impactedSpans.add(n.spanName)
          for (const t of findTestsReaching(harnessGraph, n.qualname)) {
            impactedTests.add(t.testId)
          }
        })
        .with({ _tag: "ServiceTag" }, (n) => {
          impactedServices.add(n.tagId)
        })
        .with({ _tag: "ServiceLayer" }, (n) => {
          impactedLayers.add(n.qualname)
        })
        .with({ _tag: "TaggedError" }, (n) => {
          impactedErrors.add(n.errorTag)
        })
        .with({ _tag: "VitestCase" }, (n) => {
          impactedTests.add(n.testId)
        })
        .with({ _tag: "SchemaDef" }, { _tag: "PatternDoc" }, () => undefined)
        .exhaustive()
    }

    const incoming = Graph.incomingEdges(harnessGraph.graph, currentIdx)
    for (const inEdgeIdx of incoming) {
      const inEdgeOpt = Graph.getEdge(harnessGraph.graph, inEdgeIdx)
      if (Option.isNone(inEdgeOpt)) continue
      const inEdge = inEdgeOpt.value
      const relOpt = Graph.getNode(harnessGraph.graph, inEdge.source)
      if (Option.isNone(relOpt) || !isRelationNode(relOpt.value)) continue

      const outEdges = Graph.outgoingEdges(harnessGraph.graph, inEdge.source)
      for (const outEdgeIdx of outEdges) {
        if (outEdgeIdx === inEdgeIdx) continue
        const outEdgeOpt = Graph.getEdge(harnessGraph.graph, outEdgeIdx)
        if (Option.isNone(outEdgeOpt)) continue
        const peerIdx = outEdgeOpt.value.target
        if (!visited.has(peerIdx)) {
          visited.add(peerIdx)
          queue.push(peerIdx)
        }
      }
    }
  }

  const testsArray = Array.from(impactedTests)

  return {
    source: idOrPath,
    target: classifiedSource,
    resolvedSource: classifiedSource,
    affectedAdrs: Array.from(affectedAdrs),
    affectedSpecs: Array.from(affectedSpecs),
    reachingTests: testsArray,
    impactByLayer,
    impactedSpans: Array.from(impactedSpans),
    impactedServices: Array.from(impactedServices),
    impactedLayers: Array.from(impactedLayers),
    impactedErrors: Array.from(impactedErrors),
    impactedTests: testsArray,
  }
}
