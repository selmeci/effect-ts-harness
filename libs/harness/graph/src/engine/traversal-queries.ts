import * as Graph from "effect/Graph"
import * as Option from "effect/Option"
import { match } from "ts-pattern"
import {
  type EntityNode,
  getNodeKey,
  type HarnessGraph,
  type HarnessNode,
  isEntityNode,
  isRelationNode,
  type PlaysRoleEdge,
  type RelationId,
  type RelationNode,
  type RelationTag,
  type RoleName,
  type VitestCaseNode,
} from "../model.js"
import { matchesNodeTarget } from "./hypergraph-store.js"

/**
 * Resolves any `EntityNode` or `RelationNode` by `NodeKey`, `qualname`, `spanName`, `tagId`,
 * `errorTag`, `schemaName`, `testId`, `slug`, `id`, `relationId`, or `#shortName`.
 */
export const resolveNode = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): HarnessNode | undefined => {
  const directIdx =
    harnessGraph.nodeIndexByKey.get(symbolOrSpan) ??
    harnessGraph.nodeIndexByKey.get(`EffectFn:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`ServiceTag:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`ServiceLayer:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`TaggedError:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`SchemaDef:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`VitestCase:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`PatternDoc:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`AdrDoc:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`EarsSpec:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`EffectSignature:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`LayerFlow:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`TraceabilityTuple:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`HttpEndpointTuple:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`MigrationTuple:${symbolOrSpan}`)

  if (directIdx !== undefined) {
    return Option.getOrUndefined(Graph.getNode(harnessGraph.graph, directIdx))
  }

  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    const matched = match(node)
      .with({ _tag: "EffectFn" }, (n) => matchesNodeTarget(n, symbolOrSpan) || n.qualname.endsWith(`#${symbolOrSpan}`))
      .with({ _tag: "ServiceLayer" }, (n) => matchesNodeTarget(n, symbolOrSpan) || n.qualname.endsWith(`#${symbolOrSpan}`))
      .with({ _tag: "ServiceTag" }, (n) => matchesNodeTarget(n, symbolOrSpan) || n.tagId.endsWith(`#${symbolOrSpan}`))
      .with({ _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, (n) => matchesNodeTarget(n, symbolOrSpan) || n.path.endsWith(`/${symbolOrSpan}`) || n.path.includes(symbolOrSpan))
      .with({ _tag: "TaggedError" }, { _tag: "SchemaDef" }, { _tag: "VitestCase" }, (n) => matchesNodeTarget(n, symbolOrSpan))
      .with({ _tag: "EffectSignature" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" }, { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" }, (n) => n.relationId === symbolOrSpan)
      .exhaustive()
    if (matched) return node
  }
  return undefined
}

export interface CallerMatch {
  readonly nodeTag: HarnessNode["_tag"]
  readonly qualname: string
  readonly spanName?: string | undefined
  readonly name?: string | undefined
  readonly testId?: string | undefined
  readonly testFile?: string | undefined
  readonly testName?: string | undefined
  readonly tagId?: string | undefined
  readonly errorTag?: string | undefined
  readonly schemaName?: string | undefined
  readonly docId?: string | undefined
  readonly docPath?: string | undefined
  readonly edgeKind: string
  readonly role: RoleName
  readonly relationTag: RelationTag
  readonly relationId: RelationId
  readonly callCount?: number | undefined
  readonly receiverLayer?: string | null | undefined
}

const mapRoleToEdgeKind = (role: RoleName): string =>
  match<string, string>(role)
    .with("caller", "callee", () => "TracedCall")
    .with("requires-service", () => "RequiresService")
    .with("fails-with", () => "FailsWith")
    .with("provided-service", () => "ProvidesService")
    .with("required-service", () => "LayerRequires")
    .with("governing-adr", () => "GovernsSymbol")
    .with("specifying-ears", () => "SpecifiesSymbol")
    .with("exercising-test", "exercised-span", "verifying-test", () => "ExercisesSpan")
    .with("enforcing-pattern", () => "CoversPattern")
    .otherwise((r) => r)

const buildCallerMatchFromPeer = (
  peerNode: EntityNode,
  relNode: RelationNode,
  edge: PlaysRoleEdge,
  effectiveRole: RoleName,
): CallerMatch => {
  const base = {
    nodeTag: peerNode._tag,
    edgeKind: mapRoleToEdgeKind(effectiveRole),
    role: effectiveRole,
    relationTag: relNode._tag,
    relationId: relNode.relationId,
    ...(edge.callCount !== undefined ? { callCount: edge.callCount } : {}),
    ...(edge.receiverLayer !== undefined ? { receiverLayer: edge.receiverLayer } : {}),
  }

  return match(peerNode)
    .with({ _tag: "EffectFn" }, (n) => ({ ...base, qualname: n.qualname, spanName: n.spanName }))
    .with({ _tag: "ServiceTag" }, (n) => ({ ...base, qualname: n.tagId, tagId: n.tagId, name: n.name }))
    .with({ _tag: "ServiceLayer" }, (n) => ({ ...base, qualname: n.qualname }))
    .with({ _tag: "TaggedError" }, (n) => ({ ...base, qualname: n.errorTag, errorTag: n.errorTag, spanName: n.errorTag }))
    .with({ _tag: "SchemaDef" }, (n) => ({ ...base, qualname: n.schemaName, schemaName: n.schemaName }))
    .with({ _tag: "VitestCase" }, (n) => ({ ...base, qualname: n.testId, testId: n.testId, testFile: n.testFile, testName: n.testName }))
    .with({ _tag: "PatternDoc" }, (n) => ({ ...base, qualname: n.slug, docId: n.slug, docPath: n.path }))
    .with({ _tag: "AdrDoc" }, { _tag: "EarsSpec" }, (n) => ({ ...base, qualname: n.id, spanName: n.title, docId: n.id, docPath: n.path }))
    .exhaustive()
}

const SUBJECT_ROLES_BY_RELATION: Readonly<Record<RelationTag, ReadonlySet<string>>> = {
  EffectSignature: new Set(["caller"]),
  LayerFlow: new Set(["provider-layer"]),
  TraceabilityTuple: new Set([
    "governing-adr",
    "specifying-ears",
    "verifying-test",
    "exercising-test",
    "enforcing-pattern",
  ]),
  HttpEndpointTuple: new Set(["endpoint-handler"]),
  MigrationTuple: new Set(["verifying-test"]),
}

const OBJECT_ROLES_BY_RELATION: Readonly<Record<RelationTag, ReadonlySet<string>>> = {
  EffectSignature: new Set([
    "callee",
    "requires-service",
    "fails-with",
    "uses-schema",
    "input-schema",
    "output-schema",
  ]),
  LayerFlow: new Set(["provided-service", "required-service", "fails-with"]),
  TraceabilityTuple: new Set(["realizing-symbol", "exercised-span"]),
  HttpEndpointTuple: new Set(["request-schema", "response-schema", "endpoint-error"]),
  MigrationTuple: new Set(["migration-module"]),
}

/**
 * Finds all callers / governing / exercising entities of a target symbol across reified `RelationNode`s.
 */
export const findCallers = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): ReadonlyArray<CallerMatch> => {
  const targetNode = resolveNode(harnessGraph, symbolOrSpan)
  if (!targetNode) return []
  const targetIdx = harnessGraph.nodeIndexByKey.get(getNodeKey(targetNode))
  if (targetIdx === undefined) return []

  const results: Array<CallerMatch> = []
  const seen = new Set<string>()

  const incoming = Graph.incomingEdges(harnessGraph.graph, targetIdx)
  for (const inEdgeIdx of incoming) {
    const inEdge = Option.getOrUndefined(Graph.getEdge(harnessGraph.graph, inEdgeIdx))
    if (inEdge === undefined) continue
    const relCandidate = Option.getOrUndefined(Graph.getNode(harnessGraph.graph, inEdge.source))
    if (relCandidate === undefined || !isRelationNode(relCandidate)) continue
    const relNode = relCandidate

    const objectRoles = OBJECT_ROLES_BY_RELATION[relNode._tag]
    if (!objectRoles.has(inEdge.data.role)) continue

    const subjectRoles = SUBJECT_ROLES_BY_RELATION[relNode._tag]
    const outEdges = Graph.outgoingEdges(harnessGraph.graph, inEdge.source)
    for (const outEdgeIdx of outEdges) {
      if (outEdgeIdx === inEdgeIdx) continue
      const outEdge = Option.getOrUndefined(Graph.getEdge(harnessGraph.graph, outEdgeIdx))
      if (outEdge === undefined) continue
      if (!subjectRoles.has(outEdge.data.role)) continue
      const peerNode = Option.getOrUndefined(Graph.getNode(harnessGraph.graph, outEdge.target))
      if (peerNode === undefined || !isEntityNode(peerNode)) continue

      const effectiveRole = match(relNode._tag)
        .with("TraceabilityTuple", () => outEdge.data.role)
        .with("EffectSignature", "LayerFlow", "HttpEndpointTuple", "MigrationTuple", () => inEdge.data.role)
        .exhaustive()
      const matchEntry = buildCallerMatchFromPeer(
        peerNode,
        relNode,
        inEdge.data.callCount !== undefined || inEdge.data.receiverLayer !== undefined
          ? inEdge.data
          : outEdge.data,
        effectiveRole,
      )
      const dedupKey = `${relNode.relationId}:${getNodeKey(peerNode)}:${effectiveRole}`
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey)
        results.push(matchEntry)
      }
    }
  }

  return results
}

/**
 * Finds all callees, required services, emitted errors, schemas, and realized targets
 * of a symbol across reified `RelationNode`s.
 */
export const findCallees = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): ReadonlyArray<CallerMatch> => {
  const sourceNode = resolveNode(harnessGraph, symbolOrSpan)
  if (!sourceNode) return []
  const sourceIdx = harnessGraph.nodeIndexByKey.get(getNodeKey(sourceNode))
  if (sourceIdx === undefined) return []

  const results: Array<CallerMatch> = []
  const seen = new Set<string>()

  if (isRelationNode(sourceNode)) {
    const outEdges = Graph.outgoingEdges(harnessGraph.graph, sourceIdx)
    for (const outEdgeIdx of outEdges) {
      const outEdge = Option.getOrUndefined(Graph.getEdge(harnessGraph.graph, outEdgeIdx))
      if (outEdge === undefined) continue
      const peerNode = Option.getOrUndefined(Graph.getNode(harnessGraph.graph, outEdge.target))
      if (peerNode === undefined || !isEntityNode(peerNode)) continue
      results.push(
        buildCallerMatchFromPeer(
          peerNode,
          sourceNode,
          outEdge.data,
          outEdge.data.role,
        ),
      )
    }
    return results
  }

  const incoming = Graph.incomingEdges(harnessGraph.graph, sourceIdx)
  for (const inEdgeIdx of incoming) {
    const inEdge = Option.getOrUndefined(Graph.getEdge(harnessGraph.graph, inEdgeIdx))
    if (inEdge === undefined) continue
    const relNode = Option.getOrUndefined(Graph.getNode(harnessGraph.graph, inEdge.source))
    if (relNode === undefined || !isRelationNode(relNode)) continue

    const subjectRoles = SUBJECT_ROLES_BY_RELATION[relNode._tag]
    if (!subjectRoles.has(inEdge.data.role)) continue

    const objectRoles = OBJECT_ROLES_BY_RELATION[relNode._tag]
    const outEdges = Graph.outgoingEdges(harnessGraph.graph, inEdge.source)
    for (const outEdgeIdx of outEdges) {
      if (outEdgeIdx === inEdgeIdx) continue
      const outEdge = Option.getOrUndefined(Graph.getEdge(harnessGraph.graph, outEdgeIdx))
      if (outEdge === undefined) continue
      if (!objectRoles.has(outEdge.data.role)) continue
      const peerNode = Option.getOrUndefined(Graph.getNode(harnessGraph.graph, outEdge.target))
      if (peerNode === undefined || !isEntityNode(peerNode)) continue

      const effectiveRole = match(relNode._tag)
        .with("TraceabilityTuple", () =>
          match<string>(inEdge.data.role)
            .with("governing-adr", "specifying-ears", "verifying-test", "exercising-test", () => inEdge.data.role)
            .otherwise(() => outEdge.data.role),
        )
        .with("EffectSignature", "LayerFlow", "HttpEndpointTuple", "MigrationTuple", () => outEdge.data.role)
        .exhaustive()

      const matchEntry = buildCallerMatchFromPeer(
        peerNode,
        relNode,
        outEdge.data,
        effectiveRole,
      )
      const dedupKey = `${relNode.relationId}:${getNodeKey(peerNode)}:${effectiveRole}`
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey)
        results.push(matchEntry)
      }
    }
  }

  return results
}

/**
 * Finds all `VitestCaseNode`s reaching `symbolOrSpan` directly (`TraceabilityTuple`)
 * or transitively through `EffectSignature` call chains.
 */
export const findTestsReaching = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): ReadonlyArray<VitestCaseNode> => {
  const targetNode = resolveNode(harnessGraph, symbolOrSpan)
  if (!targetNode) return []
  const targetIdx = harnessGraph.nodeIndexByKey.get(getNodeKey(targetNode))
  if (targetIdx === undefined) return []

  const visited = new Set<Graph.NodeIndex>([targetIdx])
  const queue: Array<Graph.NodeIndex> = [targetIdx]
  const tests = new Map<string, VitestCaseNode>()

  while (queue.length > 0) {
    const currentEntityIdx = queue.shift()!
    const currentOpt = Graph.getNode(harnessGraph.graph, currentEntityIdx)
    match(currentOpt)
      .with({ _tag: "Some", value: { _tag: "VitestCase" } }, ({ value }) => {
        tests.set(value.testId, value)
      })
      .with({ _tag: "Some" }, () => {})
      .with({ _tag: "None" }, () => {})
      .exhaustive()

    const incoming = Graph.incomingEdges(harnessGraph.graph, currentEntityIdx)
    for (const inEdgeIdx of incoming) {
      const inEdge = Option.getOrUndefined(Graph.getEdge(harnessGraph.graph, inEdgeIdx))
      if (inEdge === undefined) continue
      const relNode = Option.getOrUndefined(Graph.getNode(harnessGraph.graph, inEdge.source))
      if (relNode === undefined || !isRelationNode(relNode)) continue

      const isTargetRole = match(relNode)
        .with({ _tag: "EffectSignature" }, () => inEdge.data.role === "callee")
        .with(
          { _tag: "TraceabilityTuple" },
          () => inEdge.data.role === "exercised-span" || inEdge.data.role === "realizing-symbol",
        )
        .with({ _tag: "LayerFlow" }, { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" }, () => false)
        .exhaustive()

      if (!isTargetRole) continue

      const outEdges = Graph.outgoingEdges(harnessGraph.graph, inEdge.source)
      for (const outEdgeIdx of outEdges) {
        const outEdge = Option.getOrUndefined(Graph.getEdge(harnessGraph.graph, outEdgeIdx))
        if (outEdge === undefined) continue
        const isSourceRole = match(relNode)
          .with({ _tag: "EffectSignature" }, () => outEdge.data.role === "caller")
          .with(
            { _tag: "TraceabilityTuple" },
            () => outEdge.data.role === "exercising-test" || outEdge.data.role === "verifying-test",
          )
          .with({ _tag: "LayerFlow" }, { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" }, () => false)
          .exhaustive()

        if (isSourceRole && !visited.has(outEdge.target)) {
          visited.add(outEdge.target)
          queue.push(outEdge.target)
        }
      }
    }
  }

  return Array.from(tests.values())
}

/**
 * Renders the Levi hypergraph as a Mermaid flowchart via `Graph.toMermaid`.
 */
export const renderMermaid = (harnessGraph: HarnessGraph): string =>
  Graph.toMermaid(harnessGraph.graph, {
    nodeLabel: (node) =>
      match(node)
        .with({ _tag: "EffectFn" }, (n) => `${n.spanName} [${n.packageTag}]`)
        .with({ _tag: "ServiceTag" }, (n) => `Service: ${n.name}`)
        .with({ _tag: "ServiceLayer" }, (n) => `Layer: ${n.qualname} (${n.layerKind ?? "live"})`)
        .with({ _tag: "TaggedError" }, (n) => `Error: ${n.errorTag}`)
        .with({ _tag: "SchemaDef" }, (n) => `Schema: ${n.schemaName}`)
        .with({ _tag: "VitestCase" }, (n) => `Test: ${n.testName}`)
        .with({ _tag: "PatternDoc" }, (n) => `Pattern: ${n.slug}`)
        .with({ _tag: "AdrDoc" }, (n) => `ADR:${n.id} (${n.title})`)
        .with({ _tag: "EarsSpec" }, (n) => `Spec:${n.id} (${n.title})`)
        .with({ _tag: "EffectSignature" }, (n) => `Sig: ${n.callerQualname}`)
        .with({ _tag: "LayerFlow" }, (n) => `LayerFlow: ${n.layerQualname}`)
        .with({ _tag: "TraceabilityTuple" }, (n) => `Trace: ${n.relationId}`)
        .with({ _tag: "HttpEndpointTuple" }, (n) => `HTTP: ${n.method} ${n.path}`)
        .with({ _tag: "MigrationTuple" }, (n) => `Migration: ${n.migrationId}`)
        .exhaustive(),
    edgeLabel: (edge) => `${edge._tag}:${edge.role}`,
  })
