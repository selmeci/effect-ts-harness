import { Effect, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  type BranchingViolation, type ConceptLatticeCycleError, type DpoCandidatePriors,
  type DpoRuleSpec, type EarsSpecNode, type EffectFnNode, type EffectSignatureRelation,
  type GraphInferenceError, type GraphInferenceResult, type GraphMeasure,
  type GraphPatch, GraphRewriteError, type HarnessEdge, type HarnessGraph, HarnessGraphTypeId,
  type HarnessNode, type HttpEndpointTupleRelation, type LayerFlowRelation, type MigrationTupleRelation,
  NodeKey, NonNegativeCount, PlaysRoleEdge, RelationId,
  type RewriteMode, type RewritePhase, RewriteRuleId, RoleName, type SchemaDefNode,
  type ServiceLayerNode, type ServiceTagNode, SystemOneScoreMillis, type TaggedErrorNode,
  type TraceabilityTupleRelation, type VitestCaseNode, formatDpoPriorKey, getArchimateRelationForRole,
  getEdgeKey, getNodeKey, isBipartitePlaysRoleIds, isBoundaryCallerQualname, isEntityNode, isRelationNode,
} from "../model.js"
import { isDeciderSpan, isReducerSpan } from "../policy-check.js"

/**
 * Canonical 4-phase Double-Pushout (DPO) rule catalog (`RFC-0003 §4.3 & §6.1–6.2`).
 * Ordered strictly across phases: `PLAN` < `REPAIR_ARCH` < `REPAIR_CODE` < `CLEANUP`.
 */
export const STANDARD_DPO_RULES: ReadonlyArray<DpoRuleSpec> = [
  // Phase 1: PLAN (Generative planning from EARS clauses)
  {
    id: RewriteRuleId.make("PLAN-01"), phase: "PLAN", category: "auto-plan",
    description: "Synthesize contract input SchemaDef, domain use-case EffectFn stub, EffectSignature, and TraceabilityTuple from EARS WHEN clause.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("PLAN-02"), phase: "PLAN", category: "auto-plan",
    description: "Synthesize pure .decide (R = never) and .evolve EffectFn stubs linked to TraceabilityTuple from EARS WHILE clause.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("PLAN-03"), phase: "PLAN", category: "auto-plan",
    description: "Synthesize contract TaggedError and attach fails-with PlaysRoleEdge to EffectSignature in K from EARS IF/THEN clause.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("PLAN-04"), phase: "PLAN", category: "auto-plan",
    description: "Synthesize ServiceTag port, attach requires-service to EffectSignature in K, and wire live/test ServiceLayer + LayerFlow + VitestCase from EARS WHERE clause.",
    preservesRelationInK: true, hasSpecNac: false,
  },

  // Phase 2: REPAIR_ARCH (Architectural antipattern repair)
  {
    id: RewriteRuleId.make("REP-01"), phase: "REPAIR_ARCH", category: "auto-repair",
    description: "Repair domain-requires-infra / domain-requires-cloud-binding by extracting a ServiceTag port in type:service, rewiring EffectSignature in K, and adding ServiceLayer + LayerFlow in type:infra.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-02"), phase: "REPAIR_ARCH", category: "auto-repair",
    description: "Repair impure-decider / impure-reducer by removing requires-service role edge from decider EffectSignature in K and splitting out a use-case orchestrator EffectFn.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-03"), phase: "REPAIR_ARCH", category: "auto-repair",
    description: "Repair aggregate-direct-bus-publish by replacing EventBus requirement on aggregate EffectSignature in K with OutboxStore port and inserting OutboxRelay worker.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-04a"), phase: "REPAIR_ARCH", category: "auto-repair",
    description: "Repair unhandled-error / COMP-01 by propagating the TaggedError via a fails-with PlaysRoleEdge on the caller EffectSignature in K.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-04b"), phase: "REPAIR_ARCH", category: "auto-repair",
    description: "Repair unhandled-error / COMP-01 by recording the error in caller caughtErrors (Effect.catchTag) while preserving EffectSignature in K.",
    preservesRelationInK: true, hasSpecNac: false,
  },

  // Phase 3: REPAIR_CODE (Code & contract hygiene repair)
  {
    id: RewriteRuleId.make("REP-05"), phase: "REPAIR_CODE", category: "auto-repair",
    description: "Repair untraced-decider by attaching a canonical <Scope>.decide span name and EffectSignature in K.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-06"), phase: "REPAIR_CODE", category: "auto-repair",
    description: "Repair unbranded-contract-schema by upgrading contract SchemaDef to isBranded: true.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-07"), phase: "REPAIR_CODE", category: "auto-repair",
    description: "Repair discriminant-branching / non-exhaustive-union-match by clearing ad-hoc branching violation via exhaustive ts-pattern match.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-08"), phase: "REPAIR_CODE", category: "auto-repair",
    description: "Repair untrusted-row-brand-make / unbranded-primitive-boundary by clearing the boundary hygiene violation and recording Schema.decodeUnknownEffect decoding.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-09"), phase: "REPAIR_CODE", category: "auto-repair",
    description: "Repair unmanaged-sql-ddl by wrapping raw DDL into a numbered MigrationTuple (1_init_tables) under SqliteMigrator.fromRecord.",
    preservesRelationInK: true, hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-10"), phase: "REPAIR_CODE", category: "auto-repair",
    description: "Repair stale-doc-reference / unmapped-spec-symbol by rebinding TraceabilityTuple in K (or creating a new TraceabilityTuple) to the unique matching symbol in scope.",
    preservesRelationInK: true, hasSpecNac: false,
  },

  // Phase 4: CLEANUP (Orphan pruning guarded by NAC_spec)
  {
    id: RewriteRuleId.make("REP-11"), phase: "CLEANUP", category: "cleanup",
    description: "Prune unused ServiceTag only when NAC_spec holds (unreferenced by any EffectSignature, LayerFlow, TraceabilityTuple, EarsSpec, AdrDoc, or active stub; domain/core/contract packages are excluded).",
    preservesRelationInK: true, hasSpecNac: true,
  },
]

/**
 * Pure lexicographical comparison `after <_lex before` in `(N^6, <_lex)` (`R = never`, `RFC-0003 §4.3`).
 */
export const isStrictlyDecreasingMeasure = (before: GraphMeasure, after: GraphMeasure): boolean => {
  const pairs: ReadonlyArray<readonly [number, number]> = [
    [before.archViolations, after.archViolations],
    [before.unmappedSpecSymbols, after.unmappedSpecSymbols],
    [before.codeHygieneViolations, after.codeHygieneViolations],
    [before.missingLayerProviders, after.missingLayerProviders],
    [before.untestedDomainSpans, after.untestedDomainSpans],
    [before.unresolvedSuggestedEdges, after.unresolvedSuggestedEdges],
  ]
  for (const [b, a] of pairs) {
    if (a < b) return true
    if (a > b) return false
  }
  return false
}

export const isEqualMeasure = (a: GraphMeasure, b: GraphMeasure): boolean =>
  a.archViolations === b.archViolations &&
  a.unmappedSpecSymbols === b.unmappedSpecSymbols &&
  a.codeHygieneViolations === b.codeHygieneViolations &&
  a.missingLayerProviders === b.missingLayerProviders &&
  a.untestedDomainSpans === b.untestedDomainSpans &&
  a.unresolvedSuggestedEdges === b.unresolvedSuggestedEdges

export const isZeroMeasure = (m: GraphMeasure): boolean =>
  m.archViolations === 0 && m.unmappedSpecSymbols === 0 && m.codeHygieneViolations === 0 &&
  m.missingLayerProviders === 0 && m.untestedDomainSpans === 0 && m.unresolvedSuggestedEdges === 0

/**
 * Computes the 6-component lexicographical termination measure `mu(G) in N^6` (`RFC-0003 §4.3`).
 */
export const computeGraphMeasure = (
  graph: HarnessGraph,
  inference: GraphInferenceResult,
): GraphMeasure => {
  let archViolations = 0
  let unmappedSpecSymbols = 0
  let missingLayerProviders = 0
  let untestedDomainSpans = 0

  for (const ap of inference.antiPatterns) {
    match(ap.ruleId)
      .with(
        "domain-requires-infra", "domain-requires-cloud-binding", "impure-decider",
        "impure-reducer", "aggregate-direct-bus-publish", "layer-cycle",
        () => { archViolations += 1 },
      )
      .with("unmapped-spec-symbol", () => { unmappedSpecSymbols += 1 })
      .with("missing-layer-provider", () => { missingLayerProviders += 1 })
      .with("untested-domain-span", "unverified-migration", () => { untestedDomainSpans += 1 })
      .exhaustive()
  }

  let codeHygieneViolations = (graph.branchingViolations ?? []).length

  // Also count proposed EARS specs that have no realizing TraceabilityTuple edge yet
  const realizedSpecKeys = new Set<string>()
  for (const [, edge] of Graph.edges(graph.graph)) {
    if (edge.data.role === "specifying-ears" || edge.data.role === "specifying-spec") {
      realizedSpecKeys.add(edge.data.entityKey)
    }
  }
  for (const [, node] of Graph.nodes(graph.graph)) {
    match(node)
      .with({ _tag: "SchemaDef" }, (n) => {
        if (n.packageTag === "contract" && n.isBranded === false) codeHygieneViolations += 1
      })
      .with({ _tag: "EffectFn" }, (n) => {
        if (
          (n.packageTag === "domain" || n.packageTag === "contract") &&
          (isDeciderSpan(n.qualname) || isReducerSpan(n.qualname) || /(?:^|#|\.)(?:decide|evolve)/i.test(n.qualname)) &&
          (n.spanName === "untraced" || n.spanName === "<untraced>")
        ) {
          codeHygieneViolations += 1
        }
      })
      .with({ _tag: "EarsSpec" }, (n) => {
        if (n.status === "proposed") {
          const specKey = getNodeKey(n)
          if (!realizedSpecKeys.has(specKey)) {
            const declaredCount = (n.referencedSpans?.length ?? 0) + (n.referencedServices?.length ?? 0) + (n.referencedErrors?.length ?? 0)
            if (declaredCount === 0) unmappedSpecSymbols += 1
          }
        }
      })
      .with(
        { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
        { _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "AdrDoc" },
        { _tag: "EffectSignature" }, { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }

  return {
    archViolations: NonNegativeCount.make(archViolations),
    unmappedSpecSymbols: NonNegativeCount.make(unmappedSpecSymbols),
    codeHygieneViolations: NonNegativeCount.make(codeHygieneViolations),
    missingLayerProviders: NonNegativeCount.make(missingLayerProviders),
    untestedDomainSpans: NonNegativeCount.make(untestedDomainSpans),
    unresolvedSuggestedEdges: NonNegativeCount.make(inference.suggestedEdges.length),
  }
}

export type DraftGraphPatch = Omit<GraphPatch, "beforeMeasure" | "afterMeasure"> & {
  readonly clearViolationFilter?: ((v: BranchingViolation) => boolean) | undefined
}

export type Phase2CandidateBranch = ReadonlyArray<DraftGraphPatch>

export interface DecideGraphRewriteOptions {
  readonly maxPhaseSteps?: number
}

export const makePlaysRoleEdge = (relationId: string, entityKey: string, role: string): PlaysRoleEdge => {
  const arch = getArchimateRelationForRole(role)
  return Schema.decodeSync(PlaysRoleEdge)({
    _tag: "PlaysRole",
    relationId: RelationId.make(relationId),
    entityKey: NodeKey.make(entityKey),
    role: RoleName.make(role),
    ...(arch !== undefined ? { archimateRelation: arch } : {}),
  })
}

export const makeEffectSignatureNode = (
  relationId: string, callerQualname: string, file = "libs/domain/src/synthesized.ts", line = 1,
): EffectSignatureRelation => ({
  _tag: "EffectSignature", relationId: RelationId.make(relationId), callerQualname,
  requiredServices: [], emittedErrors: [], calleeQualnames: [], payloadSchemas: [], file, line,
})

export const makeLayerFlowNode = (
  relationId: string, layerQualname: string, file = "libs/infra/src/synthesized-layer.ts", line = 1,
): LayerFlowRelation => ({
  _tag: "LayerFlow", relationId: RelationId.make(relationId), layerQualname,
  providesServices: [], requiresServices: [], file, line,
})

export const makeTraceabilityTupleNode = (
  relationId: string, targetSymbolQualname = "synthesized",
): TraceabilityTupleRelation => ({
  _tag: "TraceabilityTuple", relationId: RelationId.make(relationId), targetSymbolQualname,
  verifyingTestQualnames: [],
})

export const makeHttpEndpointTupleNode = (relationId: string): HttpEndpointTupleRelation => ({
  _tag: "HttpEndpointTuple", relationId: RelationId.make(relationId), endpointGroup: "SynthesizedGroup",
  endpointName: "synthesizedEndpoint", method: "POST", path: "/synthesized",
  handlerQualname: "libs/infra/src/http.ts#synthesizedEndpoint",
  requestSchemaQualnames: [], responseSchemaQualnames: [], errorTags: [], file: "libs/infra/src/http.ts", line: 1,
})

export const makeMigrationTupleNode = (
  relationId: string, migrationId: string, moduleFile: string,
): MigrationTupleRelation => ({
  _tag: "MigrationTuple", relationId: RelationId.make(relationId), migrationId,
  engine: "SqliteMigrator", moduleFile, isDestructive: false, verifyingTestQualnames: [], line: 1,
})

export const makeVitestCaseNode = (
  testId: string, testFile: string, testName: string, line = 1,
): VitestCaseNode => ({
  _tag: "VitestCase", testId, testFile, testName, isPropertyTest: true, line,
})

/**
 * Verifies the Double-Pushout Gluing Condition (Dangling Condition + Bipartite Levi Relation Preservation Law)
 * before applying a candidate `GraphPatch` to `HarnessGraph` (`RFC-0003 §4.2`).
 */
export const verifyDpoGluingCondition = (
  graph: HarnessGraph,
  patch: Omit<GraphPatch, "beforeMeasure" | "afterMeasure">,
): Effect.Effect<void, GraphRewriteError> =>
  Effect.gen(function* () {
    const preservedSet = new Set<string>(patch.preservedInterfaceKeys)
    const deletedEntitySet = new Set<string>(patch.deletedEntityKeys)
    const deletedRelationSet = new Set<string>(patch.deletedRelationIds)
    const deletedEdgeKeys = new Set<string>(patch.deletedRoleEdges.map(getEdgeKey))

    const relKeyByRelId = new Map<string, string>()
    const existingNodeKeys = new Set<string>()
    for (const [, node] of Graph.nodes(graph.graph)) {
      const nKey = getNodeKey(node)
      existingNodeKeys.add(nKey)
      if (isRelationNode(node)) {
        relKeyByRelId.set(node.relationId, nKey)
        existingNodeKeys.add(node.relationId)
      }
    }

    // 1. Bipartite Levi Relation Preservation Law (V_R in K)
    for (const delEdge of patch.deletedRoleEdges) {
      const relId = delEdge.relationId
      const canonicalRelKey = relKeyByRelId.get(relId) ?? relId
      const isRelDeleted = deletedRelationSet.has(relId) || deletedRelationSet.has(canonicalRelKey)
      if (!isRelDeleted && !preservedSet.has(relId) && !preservedSet.has(canonicalRelKey)) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId, nodeKey: NodeKey.make(canonicalRelKey), reason: "bipartite-relation-deleted",
          message: `Rule ${patch.ruleId} deletes PlaysRoleEdge ${getEdgeKey(delEdge)} on relation '${relId}' without preserving '${relId}' in gluing interface K.`,
        })
      }
    }

    // 2. Dangling Condition (Dangling(m) = empty)
    for (const [, edge] of Graph.edges(graph.graph)) {
      const data = edge.data
      const edgeKey = getEdgeKey(data)
      if (deletedEdgeKeys.has(edgeKey)) continue
      const canonicalRelKey = relKeyByRelId.get(data.relationId) ?? data.relationId
      if (deletedRelationSet.has(data.relationId) || deletedRelationSet.has(canonicalRelKey)) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId, nodeKey: NodeKey.make(canonicalRelKey), reason: "bipartite-relation-deleted",
          message: `Rule ${patch.ruleId} deletes relation '${data.relationId}' in L \\ K while leaving incident PlaysRoleEdge '${edgeKey}' dangling in G.`,
        })
      }
      if (deletedEntitySet.has(data.entityKey)) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId, nodeKey: data.entityKey, reason: "dangling-edge",
          message: `Rule ${patch.ruleId} deletes entity '${data.entityKey}' in L \\ K while leaving incident PlaysRoleEdge '${edgeKey}' dangling in G.`,
        })
      }
    }

    // 3. Verify inserted PlaysRoleEdges
    const postPushoutNodeKeys = new Set<string>(existingNodeKeys)
    for (const delEnt of deletedEntitySet) postPushoutNodeKeys.delete(delEnt)
    for (const delRel of deletedRelationSet) {
      postPushoutNodeKeys.delete(delRel)
      const mapped = relKeyByRelId.get(delRel)
      if (mapped !== undefined) postPushoutNodeKeys.delete(mapped)
    }
    for (const insEnt of patch.insertedEntityNodes) postPushoutNodeKeys.add(getNodeKey(insEnt))
    for (const insRel of patch.insertedRelationNodes) {
      postPushoutNodeKeys.add(getNodeKey(insRel))
      postPushoutNodeKeys.add(insRel.relationId)
    }

    for (const insEdge of patch.insertedRoleEdges) {
      if (!isBipartitePlaysRoleIds(insEdge.relationId, insEdge.entityKey)) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId, nodeKey: insEdge.entityKey, reason: "invalid-graph",
          message: `Rule ${patch.ruleId} inserts non-bipartite PlaysRoleEdge '${getEdgeKey(insEdge)}'.`,
        })
      }
      if (!postPushoutNodeKeys.has(insEdge.relationId) || !postPushoutNodeKeys.has(insEdge.entityKey)) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId, nodeKey: insEdge.entityKey, reason: "dangling-edge",
          message: `Rule ${patch.ruleId} inserts PlaysRoleEdge '${getEdgeKey(insEdge)}' referencing missing endpoint in target graph H.`,
        })
      }
    }
  })

/**
 * Applies a validated DPO `GraphPatch` (or `DraftGraphPatch`) to a `HarnessGraph`.
 */
export const applyDpoPatchToGraph = (
  graph: HarnessGraph,
  patch: DraftGraphPatch,
): Effect.Effect<HarnessGraph, GraphRewriteError> =>
  Effect.gen(function* () {
    yield* verifyDpoGluingCondition(graph, patch)

    const deletedEntitySet = new Set<string>(patch.deletedEntityKeys)
    const deletedRelationSet = new Set<string>(patch.deletedRelationIds)
    const deletedEdgeKeys = new Set<string>(patch.deletedRoleEdges.map(getEdgeKey))

    const nodesByKey = new Map<string, HarnessNode>()
    const knownEndpointKeys = new Set<string>()
    for (const [, node] of Graph.nodes(graph.graph)) {
      const key = getNodeKey(node)
      if (isEntityNode(node) && deletedEntitySet.has(key)) continue
      if (isRelationNode(node) && (deletedRelationSet.has(key) || deletedRelationSet.has(node.relationId))) {
        continue
      }
      nodesByKey.set(key, node)
      knownEndpointKeys.add(key)
      if (isRelationNode(node)) knownEndpointKeys.add(node.relationId)
    }

    for (const insEnt of patch.insertedEntityNodes) {
      const key = getNodeKey(insEnt)
      nodesByKey.set(key, insEnt)
      knownEndpointKeys.add(key)
    }
    for (const insRel of patch.insertedRelationNodes) {
      const key = getNodeKey(insRel)
      nodesByKey.set(key, insRel)
      knownEndpointKeys.add(key)
      knownEndpointKeys.add(insRel.relationId)
    }

    const edgesByKey = new Map<string, HarnessEdge>()
    for (const [, edge] of Graph.edges(graph.graph)) {
      const eKey = getEdgeKey(edge.data)
      if (deletedEdgeKeys.has(eKey)) continue
      edgesByKey.set(eKey, edge.data)
    }
    for (const insEdge of patch.insertedRoleEdges) {
      edgesByKey.set(getEdgeKey(insEdge), insEdge)
    }

    for (const [, edgeData] of edgesByKey.entries()) {
      if (!knownEndpointKeys.has(edgeData.relationId) || !knownEndpointKeys.has(edgeData.entityKey)) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId, nodeKey: edgeData.entityKey, reason: "dangling-edge",
          message: `Rule ${patch.ruleId} produced dangling PlaysRoleEdge '${getEdgeKey(edgeData)}' with missing endpoint in target graph.`,
        })
      }
    }

    const nodeIndexByKey = new Map<string, Graph.NodeIndex>()
    const directed = Graph.directed<HarnessNode, HarnessEdge>((mutable) => {
      const sortedNodeEntries = Array.from(nodesByKey.entries()).sort((a, b) => a[0].localeCompare(b[0]))
      for (const [key, node] of sortedNodeEntries) {
        const idx = Graph.addNode(mutable, node)
        nodeIndexByKey.set(key, idx)
        if (isRelationNode(node)) nodeIndexByKey.set(node.relationId, idx)
      }

      const sortedEdges = Array.from(edgesByKey.entries()).sort((a, b) => a[0].localeCompare(b[0]))
      for (const [, edgeData] of sortedEdges) {
        const relIdx = nodeIndexByKey.get(edgeData.relationId)
        const entIdx = nodeIndexByKey.get(edgeData.entityKey)
        if (relIdx !== undefined && entIdx !== undefined) {
          Graph.addEdge(mutable, relIdx, entIdx, edgeData)
        }
      }
    })

    const clearFilter = patch.clearViolationFilter
    const nextViolations =
      clearFilter !== undefined
        ? (graph.branchingViolations ?? []).filter((v) => !clearFilter(v))
        : (graph.branchingViolations ?? [])

    return {
      [HarnessGraphTypeId]: HarnessGraphTypeId,
      graph: directed,
      nodeIndexByKey,
      branchingViolations: nextViolations,
      unresolvedReferences: graph.unresolvedReferences ?? [],
    }
  })

export interface IndexedHarnessGraph {
  readonly fnsByKey: Map<string, EffectFnNode>
  readonly servicesByKey: Map<string, ServiceTagNode>
  readonly layersByKey: Map<string, ServiceLayerNode>
  readonly errorsByKey: Map<string, TaggedErrorNode>
  readonly schemasByKey: Map<string, SchemaDefNode>
  readonly testsByKey: Map<string, VitestCaseNode>
  readonly specsByKey: Map<string, EarsSpecNode>
  readonly sigRelationsById: Map<string, EffectSignatureRelation>
  readonly layerRelationsById: Map<string, LayerFlowRelation>
  readonly traceRelationsById: Map<string, TraceabilityTupleRelation>
  readonly migrationRelationsById: Map<string, MigrationTupleRelation>
  readonly sigIdByCallerKey: Map<string, string>
  readonly traceIdBySpecKey: Map<string, string>
  readonly traceIdByTargetKey: Map<string, string>
  readonly edgesByRelId: Map<string, Array<PlaysRoleEdge>>
  readonly incidentEdgesByEntityKey: Map<string, Array<PlaysRoleEdge>>
}

export type IndexedGraphContext = IndexedHarnessGraph

export const indexHarnessGraph = (graph: HarnessGraph): IndexedHarnessGraph => {
  const fnsByKey = new Map<string, EffectFnNode>()
  const servicesByKey = new Map<string, ServiceTagNode>()
  const layersByKey = new Map<string, ServiceLayerNode>()
  const errorsByKey = new Map<string, TaggedErrorNode>()
  const schemasByKey = new Map<string, SchemaDefNode>()
  const testsByKey = new Map<string, VitestCaseNode>()
  const specsByKey = new Map<string, EarsSpecNode>()
  const sigRelationsById = new Map<string, EffectSignatureRelation>()
  const layerRelationsById = new Map<string, LayerFlowRelation>()
  const traceRelationsById = new Map<string, TraceabilityTupleRelation>()
  const migrationRelationsById = new Map<string, MigrationTupleRelation>()
  const sigIdByCallerKey = new Map<string, string>()
  const traceIdBySpecKey = new Map<string, string>()
  const traceIdByTargetKey = new Map<string, string>()
  const edgesByRelId = new Map<string, Array<PlaysRoleEdge>>()
  const incidentEdgesByEntityKey = new Map<string, Array<PlaysRoleEdge>>()

  for (const [, node] of Graph.nodes(graph.graph)) {
    const key = getNodeKey(node)
    match(node)
      .with({ _tag: "EffectFn" }, (n) => { fnsByKey.set(key, n) })
      .with({ _tag: "ServiceTag" }, (n) => { servicesByKey.set(key, n) })
      .with({ _tag: "ServiceLayer" }, (n) => { layersByKey.set(key, n) })
      .with({ _tag: "TaggedError" }, (n) => { errorsByKey.set(key, n) })
      .with({ _tag: "SchemaDef" }, (n) => { schemasByKey.set(key, n) })
      .with({ _tag: "VitestCase" }, (n) => { testsByKey.set(key, n) })
      .with({ _tag: "EarsSpec" }, (n) => { specsByKey.set(key, n) })
      .with({ _tag: "PatternDoc" }, { _tag: "AdrDoc" }, () => undefined)
      .with({ _tag: "EffectSignature" }, (n) => {
        sigRelationsById.set(n.relationId, n); sigRelationsById.set(key, n)
      })
      .with({ _tag: "LayerFlow" }, (n) => {
        layerRelationsById.set(n.relationId, n); layerRelationsById.set(key, n)
      })
      .with({ _tag: "TraceabilityTuple" }, (n) => {
        traceRelationsById.set(n.relationId, n); traceRelationsById.set(key, n)
      })
      .with({ _tag: "MigrationTuple" }, (n) => {
        migrationRelationsById.set(n.relationId, n); migrationRelationsById.set(key, n)
      })
      .with({ _tag: "HttpEndpointTuple" }, () => undefined)
      .exhaustive()
  }

  for (const [, edge] of Graph.edges(graph.graph)) {
    const data = edge.data
    let relList = edgesByRelId.get(data.relationId)
    if (relList === undefined) {
      relList = []; edgesByRelId.set(data.relationId, relList)
    }
    relList.push(data)

    let entList = incidentEdgesByEntityKey.get(data.entityKey)
    if (entList === undefined) {
      entList = []; incidentEdgesByEntityKey.set(data.entityKey, entList)
    }
    entList.push(data)

    if (data.role === "caller") sigIdByCallerKey.set(data.entityKey, data.relationId)
    if (data.role === "specifying-ears" || data.role === "specifying-spec") traceIdBySpecKey.set(data.entityKey, data.relationId)
    if (data.role === "realizing-symbol" || data.role === "specified-target" || data.role === "exercised-span") {
      traceIdByTargetKey.set(data.entityKey, data.relationId)
    }
  }

  return {
    fnsByKey, servicesByKey, layersByKey, errorsByKey, schemasByKey, testsByKey, specsByKey,
    sigRelationsById, layerRelationsById, traceRelationsById, migrationRelationsById,
    sigIdByCallerKey, traceIdBySpecKey, traceIdByTargetKey, edgesByRelId, incidentEdgesByEntityKey,
  }
}

export const sanitizeDpoIdentifier = (raw: string): string =>
  raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "") || "Synthesized"

export const findFnBySpanOrQualname = (
  ctx: IndexedHarnessGraph,
  spanOrQual: string,
): { readonly key: string; readonly node: EffectFnNode } | undefined => {
  for (const [key, node] of ctx.fnsByKey.entries()) {
    if (node.spanName === spanOrQual || node.qualname === spanOrQual || node.qualname.endsWith(`#${spanOrQual}`)) {
      return { key, node }
    }
  }
  return undefined
}

export const findServiceByTagOrName = (
  ctx: IndexedHarnessGraph,
  svcName: string,
): { readonly key: string; readonly node: ServiceTagNode } | undefined => {
  for (const [key, node] of ctx.servicesByKey.entries()) {
    if (node.tagId === svcName || node.name === svcName || node.tagId.endsWith(`#${svcName}`)) {
      return { key, node }
    }
  }
  return undefined
}

export const findErrorByTag = (
  ctx: IndexedHarnessGraph,
  errTag: string,
): { readonly key: string; readonly node: TaggedErrorNode } | undefined => {
  for (const [key, node] of ctx.errorsByKey.entries()) {
    if (node.errorTag === errTag || node.tag === errTag || key === `TaggedError:${errTag}`) {
      return { key, node }
    }
  }
  return undefined
}

export const hasLayerProviderForService = (ctx: IndexedHarnessGraph, serviceKey: string): boolean => {
  for (const [relId] of ctx.layerRelationsById.entries()) {
    const edges = ctx.edgesByRelId.get(relId) ?? []
    const hasProvider = edges.some((e) => e.role === "provider-layer")
    const providesSvc = edges.some((e) => e.role === "provided-service" && e.entityKey === serviceKey)
    if (hasProvider && providesSvc) return true
  }
  return false
}

export const scoreDraftPatch = (
  patch: DraftGraphPatch,
  graph: HarnessGraph,
  candidatePriors?: DpoCandidatePriors,
): SystemOneScoreMillis => {
  const directPrior = candidatePriors?.[formatDpoPriorKey(patch.primaryNodeKey, patch.ruleId)]
  if (directPrior !== undefined) return directPrior
  const ruleOnlyPrior = candidatePriors?.[patch.ruleId]
  if (ruleOnlyPrior !== undefined) return ruleOnlyPrior

  const nodeIdx = graph.nodeIndexByKey.get(patch.primaryNodeKey)
  const rawNode = nodeIdx !== undefined ? Graph.getNode(graph.graph, nodeIdx) : Option.none()
  const isBoundaryCaller = match(rawNode)
    .with({ _tag: "Some" }, ({ value }) =>
      match(value)
        .with({ _tag: "EffectFn" }, (fn) => fn.packageTag === "infra" || fn.packageTag === "app" || isBoundaryCallerQualname(fn.qualname))
        .with(
          { _tag: "ServiceTag" }, { _tag: "ServiceLayer" }, { _tag: "TaggedError" },
          { _tag: "SchemaDef" }, { _tag: "VitestCase" }, { _tag: "PatternDoc" },
          { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, { _tag: "EffectSignature" },
          { _tag: "LayerFlow" }, { _tag: "TraceabilityTuple" }, { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          () => false,
        )
        .exhaustive(),
    )
    .with({ _tag: "None" }, () => false)
    .exhaustive()

  return match(patch.ruleId as string)
    .with("REP-04a", () => SystemOneScoreMillis.make(isBoundaryCaller ? 450 : 800))
    .with("REP-04b", () => SystemOneScoreMillis.make(isBoundaryCaller ? 850 : 500))
    .otherwise(() => SystemOneScoreMillis.make(750))
}

export const sortPatchesDeterministically = (
  patches: ReadonlyArray<DraftGraphPatch>,
): ReadonlyArray<DraftGraphPatch> =>
  [...patches].sort((a, b) => {
    const cmp = a.ruleId.localeCompare(b.ruleId)
    if (cmp !== 0) return cmp
    return a.primaryNodeKey.localeCompare(b.primaryNodeKey)
  })

export const getPhasesForMode = (mode: RewriteMode): ReadonlyArray<RewritePhase> =>
  match(mode)
    .with("auto-plan", () => ["PLAN"] as const)
    .with("auto-repair", () => ["REPAIR_ARCH", "REPAIR_CODE"] as const)
    .with("cleanup", () => ["CLEANUP"] as const)
    .with("full", () => ["PLAN", "REPAIR_ARCH", "REPAIR_CODE", "CLEANUP"] as const)
    .exhaustive()

export const mapInferenceErrorToRewriteError = (
  err: GraphInferenceError | ConceptLatticeCycleError,
  ruleId?: RewriteRuleId,
  nodeKey?: NodeKey,
): GraphRewriteError =>
  match(err)
    .with({ _tag: "ConceptLatticeCycleError" }, (cycleErr) =>
      new GraphRewriteError({
        ...(ruleId !== undefined ? { ruleId } : {}),
        ...(nodeKey !== undefined ? { nodeKey } : {}),
        reason: "concept-lattice-cycle",
        message: `[ConceptLatticeCycleError:${cycleErr.reason}] ${cycleErr.message}`,
      }),
    )
    .with({ _tag: "GraphInferenceError" }, (infErr) =>
      new GraphRewriteError({
        ...(ruleId !== undefined ? { ruleId } : {}),
        ...(nodeKey !== undefined ? { nodeKey } : {}),
        reason: infErr.reason === "invalid-graph" ? "invalid-graph" : "inference-failed",
        message: `[GraphInferenceError:${infErr.reason}] ${infErr.message}`,
      }),
    )
    .exhaustive()
