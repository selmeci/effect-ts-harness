import * as Graph from "effect/Graph"
import * as Option from "effect/Option"
import { match } from "ts-pattern"
import {
  type EffectFnNode,
  type EntityNode,
  getEdgeKey,
  getNodeKey,
  type HarnessGraph,
  isEntityNode,
  type PlaysRoleEdge,
  RelationId,
  type RelationNode,
} from "../model.js"
import { pushUnique } from "./hypergraph-store.js"

export interface GraphDiffResult {
  readonly isGreen: boolean
  readonly missingFns: ReadonlyArray<string>
  readonly missingServices: ReadonlyArray<string>
  readonly missingLayers: ReadonlyArray<string>
  readonly missingErrors: ReadonlyArray<string>
  readonly remainingStubs: ReadonlyArray<string>
  readonly missingEdges: ReadonlyArray<PlaysRoleEdge>
}

export const diffHarnessGraphs = (
  implGraph: HarnessGraph,
  planGraph: HarnessGraph,
): GraphDiffResult => {
  const missingFns: Array<string> = []
  const missingServices: Array<string> = []
  const missingLayers: Array<string> = []
  const missingErrors: Array<string> = []
  const remainingStubs: Array<string> = []
  const missingEdges: Array<PlaysRoleEdge> = []

  const implFnsByFileAndSpan = new Map<string, EffectFnNode>()
  for (const [, node] of Graph.nodes(implGraph.graph)) {
    match(node)
      .with({ _tag: "EffectFn" }, (fn) => {
        implFnsByFileAndSpan.set(`${fn.file}::${fn.spanName}`, fn)
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

  const renamedSigMap = new Map<string, string>()

  for (const [, planNode] of Graph.nodes(planGraph.graph)) {
    const key = getNodeKey(planNode)
    const implIdx = implGraph.nodeIndexByKey.get(key)
    let implNode =
      implIdx !== undefined ? Option.getOrUndefined(Graph.getNode(implGraph.graph, implIdx)) : undefined

    if (implNode === undefined) {
      implNode = match(planNode)
        .with({ _tag: "EffectFn" }, (fn) => {
          const matchedBySpan = implFnsByFileAndSpan.get(`${fn.file}::${fn.spanName}`)
          if (matchedBySpan !== undefined) {
            renamedSigMap.set(
              `EffectSignature:${fn.qualname}`,
              `EffectSignature:${matchedBySpan.qualname}`,
            )
          }
          return matchedBySpan
        })
        .with(
          { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" }, { _tag: "SchemaDef" },
          { _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" },
          { _tag: "EffectSignature" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
          () => undefined,
        )
        .exhaustive()
    }

    if (implNode === undefined) {
      match(planNode)
        .with({ _tag: "EffectFn" }, (n) => missingFns.push(n.qualname))
        .with({ _tag: "ServiceTag" }, (n) => missingServices.push(n.tagId))
        .with({ _tag: "ServiceLayer" }, (n) => missingLayers.push(n.qualname))
        .with({ _tag: "TaggedError" }, (n) => missingErrors.push(n.errorTag))
        .with(
          { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "AdrDoc" },
          { _tag: "EarsSpec" }, { _tag: "EffectSignature" }, { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" }, { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
          () => {},
        )
        .exhaustive()
    } else {
      match(implNode)
        .with({ _tag: "EffectFn" }, (fn) => {
          if (fn.isStub === true) remainingStubs.push(fn.qualname)
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
  }

  for (const [, implNode] of Graph.nodes(implGraph.graph)) {
    match(implNode)
      .with({ _tag: "EffectFn" }, (fn) => {
        if (fn.isStub === true && !remainingStubs.includes(fn.qualname)) {
          remainingStubs.push(fn.qualname)
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

  const implEdgeKeys = new Set<string>()
  for (const [, edge] of Graph.edges(implGraph.graph)) {
    implEdgeKeys.add(getEdgeKey(edge.data))
  }

  const CHECKED_PLAN_ROLES = new Set([
    "requires-service",
    "fails-with",
    "provided-service",
    "required-service",
    "governing-adr",
    "specifying-ears",
  ])

  for (const [, planEdge] of Graph.edges(planGraph.graph)) {
    if (CHECKED_PLAN_ROLES.has(planEdge.data.role)) {
      const mappedRelId = renamedSigMap.get(planEdge.data.relationId)
      const effectiveEdge =
        mappedRelId !== undefined
          ? { ...planEdge.data, relationId: RelationId.make(mappedRelId) }
          : planEdge.data
      const eKey = getEdgeKey(effectiveEdge)
      if (!implEdgeKeys.has(eKey)) {
        missingEdges.push(planEdge.data)
      }
    }
  }

  const isGreen =
    missingFns.length === 0 &&
    missingServices.length === 0 &&
    missingLayers.length === 0 &&
    missingErrors.length === 0 &&
    remainingStubs.length === 0 &&
    missingEdges.length === 0

  return {
    isGreen,
    missingFns,
    missingServices,
    missingLayers,
    missingErrors,
    remainingStubs,
    missingEdges,
  }
}

export interface SubgraphMonomorphismResult {
  readonly isMonomorphic: boolean
  readonly missingEntities: ReadonlyArray<string>
  readonly missingRelations: ReadonlyArray<string>
  readonly missingRoleEdges: ReadonlyArray<PlaysRoleEdge>
}

/**
 * Verifies Bipartite Levi Subgraph Monomorphism $H \hookrightarrow G_{\text{extracted}}$
 * across entity vertices $V_E$, reified relation vertices $V_R$, and `PlaysRoleEdge` incidences $E_{\text{role}}$,
 * enforcing injectivity on both $\phi_E: V_E(H) \hookrightarrow V_E(G)$ and $\phi_R: V_R(H) \hookrightarrow V_R(G)$
 * as well as relation-preserving role incidence $(\phi_R(r), \phi_E(u), \text{role}) \in E_{\text{role}}(G)$.
 */
export const verifySubgraphMonomorphism = (
  extractedGraph: HarnessGraph,
  targetSubgraph: HarnessGraph,
  options?: {
    readonly requiredEntityKeys?: ReadonlySet<string> | undefined
    readonly requiredRelationIds?: ReadonlySet<string> | undefined
    readonly requiredRoleEdges?: ReadonlyArray<PlaysRoleEdge> | undefined
  },
): SubgraphMonomorphismResult => {
  const extractedEntitiesByKey = new Map<string, EntityNode>()
  const extractedRelationsById = new Map<string, RelationNode>()
  const extractedFnsByFileAndSpan = new Map<string, Array<string>>()
  const extractedEntitiesByTail = new Map<string, Array<string>>()

  const pushCandidate = (map: Map<string, Array<string>>, lookupKey: string, nodeKey: string): void => {
    let arr = map.get(lookupKey)
    if (arr === undefined) {
      arr = []
      map.set(lookupKey, arr)
    }
    pushUnique(arr, nodeKey)
  }

  for (const [, node] of Graph.nodes(extractedGraph.graph)) {
    const key = getNodeKey(node)
    if (isEntityNode(node)) {
      extractedEntitiesByKey.set(key, node)
      match(node)
        .with({ _tag: "EffectFn" }, (fn) => {
          pushCandidate(extractedFnsByFileAndSpan, `${fn.file}::${fn.spanName}`, key)
          pushCandidate(extractedEntitiesByTail, `EffectFn::${fn.file}::${fn.spanName}`, key)
          pushCandidate(extractedEntitiesByTail, `EffectFn::${fn.spanName}`, key)
          const fnShort = fn.qualname.split("#").pop()
          if (fnShort !== undefined) {
            pushCandidate(extractedEntitiesByTail, `EffectFn::${fn.file}::${fnShort}`, key)
            pushCandidate(extractedEntitiesByTail, `EffectFn::${fnShort}`, key)
          }
        })
        .with({ _tag: "ServiceTag" }, (svc) => {
          pushCandidate(extractedEntitiesByTail, `ServiceTag::${svc.file}::${svc.tagId}`, key)
          pushCandidate(extractedEntitiesByTail, `ServiceTag::${svc.file}::${svc.name}`, key)
          pushCandidate(extractedEntitiesByTail, `ServiceTag::${svc.tagId}`, key)
          pushCandidate(extractedEntitiesByTail, `ServiceTag::${svc.name}`, key)
        })
        .with({ _tag: "ServiceLayer" }, (lay) => {
          const layShort = lay.qualname.split("#").pop()
          if (layShort !== undefined) {
            pushCandidate(extractedEntitiesByTail, `ServiceLayer::${lay.file}::${layShort}`, key)
            pushCandidate(extractedEntitiesByTail, `ServiceLayer::${layShort}`, key)
          }
        })
        .with({ _tag: "TaggedError" }, (err) => {
          pushCandidate(extractedEntitiesByTail, `TaggedError::${err.file}::${err.errorTag}`, key)
          pushCandidate(extractedEntitiesByTail, `TaggedError::${err.errorTag}`, key)
        })
        .with({ _tag: "SchemaDef" }, (sch) => {
          pushCandidate(extractedEntitiesByTail, `SchemaDef::${sch.file}::${sch.schemaName}`, key)
          pushCandidate(extractedEntitiesByTail, `SchemaDef::${sch.schemaName}`, key)
        })
        .with({ _tag: "VitestCase" }, (vc) => {
          pushCandidate(extractedEntitiesByTail, `VitestCase::${vc.testFile}::${vc.testName}`, key)
          pushCandidate(extractedEntitiesByTail, `VitestCase::${vc.testFile}`, key)
        })
        .with({ _tag: "PatternDoc" }, (doc) => {
          pushCandidate(extractedEntitiesByTail, `PatternDoc::${doc.path}`, key)
        })
        .with({ _tag: "AdrDoc" }, (doc) => {
          pushCandidate(extractedEntitiesByTail, `AdrDoc::${doc.id}`, key)
        })
        .with({ _tag: "EarsSpec" }, (spec) => {
          pushCandidate(extractedEntitiesByTail, `EarsSpec::${spec.id}`, key)
        })
        .exhaustive()
    } else {
      extractedRelationsById.set(node.relationId, node)
      extractedRelationsById.set(key, node)
    }
  }

  const extractedEdgesByRelId = new Map<string, Array<PlaysRoleEdge>>()
  const extractedRoleTriples = new Set<string>()
  for (const [, edge] of Graph.edges(extractedGraph.graph)) {
    const d = edge.data
    extractedRoleTriples.add(`${d.relationId}::${d.role}::${d.entityKey}`)
    let list = extractedEdgesByRelId.get(d.relationId)
    if (list === undefined) {
      list = []
      extractedEdgesByRelId.set(d.relationId, list)
    }
    list.push(d)
  }

  const targetEdgesByRelId = new Map<string, Array<PlaysRoleEdge>>()
  for (const [, edge] of Graph.edges(targetSubgraph.graph)) {
    const d = edge.data
    let list = targetEdgesByRelId.get(d.relationId)
    if (list === undefined) {
      list = []
      targetEdgesByRelId.set(d.relationId, list)
    }
    list.push(d)
  }

  const missingEntities: Array<string> = []
  const missingRelations: Array<string> = []
  const missingRoleEdges: Array<PlaysRoleEdge> = []

  const entityKeyMap = new Map<string, string>()
  const usedExtractedEntityKeys = new Set<string>()

  const pickUnusedEntity = (candidates: ReadonlyArray<string | undefined>): string | undefined => {
    for (const cand of candidates) {
      if (cand !== undefined && extractedEntitiesByKey.has(cand) && !usedExtractedEntityKeys.has(cand)) {
        return cand
      }
    }
    return undefined
  }

  for (const [, targetNode] of Graph.nodes(targetSubgraph.graph)) {
    if (!isEntityNode(targetNode)) continue
    const key = getNodeKey(targetNode)
    if (options?.requiredEntityKeys !== undefined && !options.requiredEntityKeys.has(key)) {
      if (extractedEntitiesByKey.has(key)) {
        entityKeyMap.set(key, key)
      }
      continue
    }

    const exactMatch =
      extractedEntitiesByKey.get(key)?._tag === targetNode._tag && !usedExtractedEntityKeys.has(key)
        ? key
        : undefined

    const candidateKeys: Array<string | undefined> =
      exactMatch !== undefined
        ? [exactMatch]
        : match(targetNode)
            .with({ _tag: "EffectFn" }, (fn) => {
              const fnShort = fn.qualname.split("#").pop() ?? fn.spanName
              return [
                ...(extractedFnsByFileAndSpan.get(`${fn.file}::${fn.spanName}`) ?? []),
                ...(extractedEntitiesByTail.get(`EffectFn::${fn.file}::${fnShort}`) ?? []),
                ...(extractedEntitiesByTail.get(`EffectFn::${fn.spanName}`) ?? []),
                ...(extractedEntitiesByTail.get(`EffectFn::${fnShort}`) ?? []),
              ]
            })
            .with({ _tag: "ServiceTag" }, (svc) => [
              ...(extractedEntitiesByTail.get(`ServiceTag::${svc.file}::${svc.tagId}`) ?? []),
              ...(extractedEntitiesByTail.get(`ServiceTag::${svc.file}::${svc.name}`) ?? []),
              ...(extractedEntitiesByTail.get(`ServiceTag::${svc.tagId}`) ?? []),
              ...(extractedEntitiesByTail.get(`ServiceTag::${svc.name}`) ?? []),
            ])
            .with({ _tag: "ServiceLayer" }, (lay) => {
              const layShort = lay.qualname.split("#").pop() ?? lay.qualname
              return [
                ...(extractedEntitiesByTail.get(`ServiceLayer::${lay.file}::${layShort}`) ?? []),
                ...(extractedEntitiesByTail.get(`ServiceLayer::${layShort}`) ?? []),
              ]
            })
            .with({ _tag: "TaggedError" }, (err) => [
              ...(extractedEntitiesByTail.get(`TaggedError::${err.file}::${err.errorTag}`) ?? []),
              ...(extractedEntitiesByTail.get(`TaggedError::${err.errorTag}`) ?? []),
            ])
            .with({ _tag: "SchemaDef" }, (sch) => [
              ...(extractedEntitiesByTail.get(`SchemaDef::${sch.file}::${sch.schemaName}`) ?? []),
              ...(extractedEntitiesByTail.get(`SchemaDef::${sch.schemaName}`) ?? []),
            ])
            .with({ _tag: "VitestCase" }, (vc) => [
              ...(extractedEntitiesByTail.get(`VitestCase::${vc.testFile}::${vc.testName}`) ?? []),
              ...(extractedEntitiesByTail.get(`VitestCase::${vc.testFile}`) ?? []),
            ])
            .with({ _tag: "PatternDoc" }, (doc) => extractedEntitiesByTail.get(`PatternDoc::${doc.path}`) ?? [])
            .with({ _tag: "AdrDoc" }, (doc) => extractedEntitiesByTail.get(`AdrDoc::${doc.id}`) ?? [])
            .with({ _tag: "EarsSpec" }, (spec) => extractedEntitiesByTail.get(`EarsSpec::${spec.id}`) ?? [])
            .exhaustive()

    const chosen = pickUnusedEntity(candidateKeys)
    if (chosen !== undefined) {
      entityKeyMap.set(key, chosen)
      usedExtractedEntityKeys.add(chosen)
    } else {
      missingEntities.push(key)
    }
  }

  for (const [, targetNode] of Graph.nodes(targetSubgraph.graph)) {
    if (!isEntityNode(targetNode)) continue
    const key = getNodeKey(targetNode)
    if (entityKeyMap.has(key)) continue
    const fallbackCandidates = match(targetNode)
      .with({ _tag: "EffectFn" }, (fn) => {
        const fnShort = fn.qualname.split("#").pop() ?? fn.spanName
        return [
          key,
          ...(extractedFnsByFileAndSpan.get(`${fn.file}::${fn.spanName}`) ?? []),
          ...(extractedEntitiesByTail.get(`EffectFn::${fn.spanName}`) ?? []),
          ...(extractedEntitiesByTail.get(`EffectFn::${fnShort}`) ?? []),
        ]
      })
      .with({ _tag: "ServiceTag" }, (svc) => [
        key,
        ...(extractedEntitiesByTail.get(`ServiceTag::${svc.tagId}`) ?? []),
        ...(extractedEntitiesByTail.get(`ServiceTag::${svc.name}`) ?? []),
      ])
      .with({ _tag: "ServiceLayer" }, (lay) => {
        const layShort = lay.qualname.split("#").pop() ?? lay.qualname
        return [key, ...(extractedEntitiesByTail.get(`ServiceLayer::${layShort}`) ?? [])]
      })
      .with({ _tag: "TaggedError" }, (err) => [
        key,
        ...(extractedEntitiesByTail.get(`TaggedError::${err.errorTag}`) ?? []),
      ])
      .with({ _tag: "SchemaDef" }, (sch) => [
        key,
        ...(extractedEntitiesByTail.get(`SchemaDef::${sch.schemaName}`) ?? []),
      ])
      .with({ _tag: "VitestCase" }, (vc) => [
        key,
        ...(extractedEntitiesByTail.get(`VitestCase::${vc.testFile}`) ?? []),
      ])
      .with({ _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, () => [key])
      .exhaustive()
    const matchAny = fallbackCandidates.find((c) => c !== undefined && extractedEntitiesByKey.has(c))
    if (matchAny !== undefined) {
      entityKeyMap.set(key, matchAny)
    }
  }

  const relationIdMap = new Map<string, string>()
  const usedExtractedRelationIds = new Set<string>()
  const allExtractedRelationNodes: Array<RelationNode> = []
  for (const [, node] of Graph.nodes(extractedGraph.graph)) {
    if (!isEntityNode(node)) {
      allExtractedRelationNodes.push(node)
    }
  }

  const findMatchingExtractedRelation = (
    targetRel: RelationNode,
    allowReuse: boolean,
  ): RelationNode | undefined => {
    const relId = targetRel.relationId
    const direct = extractedRelationsById.get(relId) ?? extractedRelationsById.get(getNodeKey(targetRel))
    if (
      direct !== undefined &&
      direct._tag === targetRel._tag &&
      (allowReuse || !usedExtractedRelationIds.has(direct.relationId))
    ) {
      return direct
    }

    const targetIncident = targetEdgesByRelId.get(relId) ?? []
    for (const cand of allExtractedRelationNodes) {
      if (cand._tag !== targetRel._tag) continue
      if (!allowReuse && usedExtractedRelationIds.has(cand.relationId)) continue

      const candEdges = extractedEdgesByRelId.get(cand.relationId) ?? []
      const matchesKindSpecific = match(targetRel)
        .with({ _tag: "MigrationTuple" }, (mig) =>
          cand._tag === "MigrationTuple" && cand.migrationId === mig.migrationId,
        )
        .with({ _tag: "HttpEndpointTuple" }, (http) =>
          cand._tag === "HttpEndpointTuple" &&
          cand.method === http.method &&
          cand.path === http.path,
        )
        .with({ _tag: "EffectSignature" }, (sig) => {
          const callerEdge = targetIncident.find((e) =>
            match<string>(e.role).with("caller", () => true).otherwise(() => false),
          )
          const mappedCaller =
            callerEdge !== undefined
              ? (entityKeyMap.get(callerEdge.entityKey) ?? callerEdge.entityKey)
              : undefined
          return (
            (mappedCaller !== undefined &&
              candEdges.some(
                (e) =>
                  match<string>(e.role).with("caller", () => true).otherwise(() => false) &&
                  e.entityKey === mappedCaller,
              )) ||
            (cand._tag === "EffectSignature" &&
              cand.callerQualname.split("#").pop() === sig.callerQualname.split("#").pop())
          )
        })
        .with({ _tag: "LayerFlow" }, (lf) => {
          const provEdge = targetIncident.find((e) =>
            match<string>(e.role).with("provider-layer", () => true).otherwise(() => false),
          )
          const mappedProv =
            provEdge !== undefined
              ? (entityKeyMap.get(provEdge.entityKey) ?? provEdge.entityKey)
              : undefined
          return (
            (mappedProv !== undefined &&
              candEdges.some(
                (e) =>
                  match<string>(e.role).with("provider-layer", () => true).otherwise(() => false) &&
                  e.entityKey === mappedProv,
              )) ||
            (cand._tag === "LayerFlow" &&
              cand.layerQualname.split("#").pop() === lf.layerQualname.split("#").pop())
          )
        })
        .with({ _tag: "TraceabilityTuple" }, (tr) => {
          const symEdge = targetIncident.find((e) =>
            match<string>(e.role).with("realizing-symbol", "exercised-span", () => true).otherwise(() => false),
          )
          const mappedSym =
            symEdge !== undefined
              ? (entityKeyMap.get(symEdge.entityKey) ?? symEdge.entityKey)
              : undefined
          return (
            (mappedSym !== undefined &&
              candEdges.some(
                (e) =>
                  match<string>(e.role).with("realizing-symbol", "exercised-span", () => true).otherwise(() => false) &&
                  e.entityKey === mappedSym,
              )) ||
            (cand._tag === "TraceabilityTuple" &&
              cand.targetSymbolQualname === tr.targetSymbolQualname)
          )
        })
        .exhaustive()

      if (matchesKindSpecific) return cand
    }
    return undefined
  }

  for (const [, targetNode] of Graph.nodes(targetSubgraph.graph)) {
    if (isEntityNode(targetNode)) continue
    const relId = targetNode.relationId
    const key = getNodeKey(targetNode)
    const isRequired =
      options?.requiredRelationIds === undefined ||
      options.requiredRelationIds.has(relId) ||
      options.requiredRelationIds.has(key)

    const matchedRel = findMatchingExtractedRelation(targetNode, !isRequired)
    if (matchedRel !== undefined) {
      relationIdMap.set(relId, matchedRel.relationId)
      relationIdMap.set(key, matchedRel.relationId)
      if (isRequired) {
        usedExtractedRelationIds.add(matchedRel.relationId)
      }
    } else {
      if (isRequired) {
        missingRelations.push(relId)
      }
    }
  }

  const edgesToCheck =
    options?.requiredRoleEdges ??
    Array.from(Graph.edges(targetSubgraph.graph)).map(([, e]) => e.data)

  for (const edgeData of edgesToCheck) {
    const mappedEntity = entityKeyMap.get(edgeData.entityKey) ?? edgeData.entityKey
    const mappedRelation = relationIdMap.get(edgeData.relationId)

    const hasRelationPreservingEdge =
      mappedRelation !== undefined
        ? extractedRoleTriples.has(`${mappedRelation}::${edgeData.role}::${mappedEntity}`) ||
          extractedRoleTriples.has(`${mappedRelation}::${edgeData.role}::${edgeData.entityKey}`)
        : extractedRoleTriples.has(`${edgeData.relationId}::${edgeData.role}::${mappedEntity}`) ||
          extractedRoleTriples.has(`${edgeData.relationId}::${edgeData.role}::${edgeData.entityKey}`)

    if (!hasRelationPreservingEdge) {
      missingRoleEdges.push(edgeData)
    }
  }

  return {
    isMonomorphic:
      missingEntities.length === 0 &&
      missingRelations.length === 0 &&
      missingRoleEdges.length === 0,
    missingEntities,
    missingRelations,
    missingRoleEdges,
  }
}
