import { Effect, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { decideGraphInference } from "./datalog-engine.js"
import {
  type BranchingViolation,
  CandidateRank,
  type ConceptLatticeCycleError,
  type DpoCandidatePriors,
  type DpoRuleSpec,
  type EarsSpecNode,
  type EffectFnNode,
  type EffectSignatureRelation,
  type EntityNode,
  type GraphInferenceError,
  type GraphInferenceResult,
  type GraphMeasure,
  type GraphPatch,
  GraphRewriteError,
  type GraphRewriteOutcome,
  type GraphRewriteResult,
  type HarnessEdge,
  type HarnessGraph,
  HarnessGraphTypeId,
  type HarnessNode,
  type HttpEndpointTupleRelation,
  type LayerFlowRelation,
  type MigrationTupleRelation,
  NodeKey,
  NonNegativeCount,
  PlaysRoleEdge,
  RelationId,
  type RelationNode,
  type RewriteCandidate,
  type RewriteMode,
  type RewritePhase,
  RewriteRuleId,
  RoleName,
  type SchemaDefNode,
  type ServiceLayerNode,
  type ServiceTagNode,
  SystemOneScoreMillis,
  type TaggedErrorNode,
  type TraceabilityTupleRelation,
  type VitestCaseNode,
  formatDpoPriorKey,
  getArchimateRelationForRole,
  getEdgeKey,
  getNodeKey,
  isBipartitePlaysRoleIds,
  isBoundaryCallerQualname,
  isEntityNode,
  isRelationNode,
} from "./model.js"
import { isDeciderSpan, isReducerSpan } from "./policy-check.js"

/**
 * Canonical 4-phase Double-Pushout (DPO) rule catalog (`RFC-0003 §4.3 & §6.1–6.2`).
 * Ordered strictly across phases: `PLAN` < `REPAIR_ARCH` < `REPAIR_CODE` < `CLEANUP`.
 */
export const STANDARD_DPO_RULES: ReadonlyArray<DpoRuleSpec> = [
  // Phase 1: PLAN (Generative planning from EARS clauses)
  {
    id: RewriteRuleId.make("PLAN-01"),
    phase: "PLAN",
    category: "auto-plan",
    description:
      "Synthesize contract input SchemaDef, domain use-case EffectFn stub, EffectSignature, and TraceabilityTuple from EARS WHEN clause.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("PLAN-02"),
    phase: "PLAN",
    category: "auto-plan",
    description:
      "Synthesize pure .decide (R = never) and .evolve EffectFn stubs linked to TraceabilityTuple from EARS WHILE clause.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("PLAN-03"),
    phase: "PLAN",
    category: "auto-plan",
    description:
      "Synthesize contract TaggedError and attach fails-with PlaysRoleEdge to EffectSignature in K from EARS IF/THEN clause.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("PLAN-04"),
    phase: "PLAN",
    category: "auto-plan",
    description:
      "Synthesize ServiceTag port, attach requires-service to EffectSignature in K, and wire live/test ServiceLayer + LayerFlow + VitestCase from EARS WHERE clause.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },

  // Phase 2: REPAIR_ARCH (Architectural antipattern repair)
  {
    id: RewriteRuleId.make("REP-01"),
    phase: "REPAIR_ARCH",
    category: "auto-repair",
    description:
      "Repair domain-requires-infra / domain-requires-cloud-binding by extracting a ServiceTag port in type:service, rewiring EffectSignature in K, and adding ServiceLayer + LayerFlow in type:infra.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-02"),
    phase: "REPAIR_ARCH",
    category: "auto-repair",
    description:
      "Repair impure-decider / impure-reducer by removing requires-service role edge from decider EffectSignature in K and splitting out a use-case orchestrator EffectFn.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-03"),
    phase: "REPAIR_ARCH",
    category: "auto-repair",
    description:
      "Repair aggregate-direct-bus-publish by replacing EventBus requirement on aggregate EffectSignature in K with OutboxStore port and inserting OutboxRelay worker.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-04a"),
    phase: "REPAIR_ARCH",
    category: "auto-repair",
    description:
      "Repair unhandled-error / COMP-01 by propagating the TaggedError via a fails-with PlaysRoleEdge on the caller EffectSignature in K.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-04b"),
    phase: "REPAIR_ARCH",
    category: "auto-repair",
    description:
      "Repair unhandled-error / COMP-01 by recording the error in caller caughtErrors (Effect.catchTag) while preserving EffectSignature in K.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },

  // Phase 3: REPAIR_CODE (Code & contract hygiene repair)
  {
    id: RewriteRuleId.make("REP-05"),
    phase: "REPAIR_CODE",
    category: "auto-repair",
    description:
      "Repair untraced-decider by attaching a canonical <Scope>.decide span name and EffectSignature in K.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-06"),
    phase: "REPAIR_CODE",
    category: "auto-repair",
    description:
      "Repair unbranded-contract-schema by upgrading contract SchemaDef to isBranded: true.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-07"),
    phase: "REPAIR_CODE",
    category: "auto-repair",
    description:
      "Repair discriminant-branching / non-exhaustive-union-match by clearing ad-hoc branching violation via exhaustive ts-pattern match.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-08"),
    phase: "REPAIR_CODE",
    category: "auto-repair",
    description:
      "Repair untrusted-row-brand-make / unbranded-primitive-boundary by clearing the boundary hygiene violation and recording Schema.decodeUnknownEffect decoding.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-09"),
    phase: "REPAIR_CODE",
    category: "auto-repair",
    description:
      "Repair unmanaged-sql-ddl by wrapping raw DDL into a numbered MigrationTuple (1_init_tables) under SqliteMigrator.fromRecord.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },
  {
    id: RewriteRuleId.make("REP-10"),
    phase: "REPAIR_CODE",
    category: "auto-repair",
    description:
      "Repair stale-doc-reference / unmapped-spec-symbol by rebinding TraceabilityTuple in K (or creating a new TraceabilityTuple) to the unique matching symbol in scope.",
    preservesRelationInK: true,
    hasSpecNac: false,
  },

  // Phase 4: CLEANUP (Orphan pruning guarded by NAC_spec)
  {
    id: RewriteRuleId.make("REP-11"),
    phase: "CLEANUP",
    category: "cleanup",
    description:
      "Prune unused ServiceTag only when NAC_spec holds (unreferenced by any EffectSignature, LayerFlow, TraceabilityTuple, EarsSpec, AdrDoc, or active stub; domain/core/contract packages are excluded).",
    preservesRelationInK: true,
    hasSpecNac: true,
  },
]

/**
 * Pure lexicographical comparison `after <_lex before` in `(N^6, <_lex)` (`R = never`, `RFC-0003 §4.3`).
 * Phases 2 (`REPAIR_ARCH`) and 3 (`REPAIR_CODE`) enforce strict decrease; Phase 1 (`PLAN`) ensures
 * `archViolations` and `codeHygieneViolations` do not increase, and Phase 4 (`CLEANUP`) requires `after <=_lex before`.
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
  m.archViolations === 0 &&
  m.unmappedSpecSymbols === 0 &&
  m.codeHygieneViolations === 0 &&
  m.missingLayerProviders === 0 &&
  m.untestedDomainSpans === 0 &&
  m.unresolvedSuggestedEdges === 0

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
        "domain-requires-infra",
        "domain-requires-cloud-binding",
        "impure-decider",
        "impure-reducer",
        "aggregate-direct-bus-publish",
        "layer-cycle",
        () => {
          archViolations += 1
        },
      )
      .with("unmapped-spec-symbol", () => {
        unmappedSpecSymbols += 1
      })
      .with("missing-layer-provider", () => {
        missingLayerProviders += 1
      })
      .with("untested-domain-span", "unverified-migration", () => {
        untestedDomainSpans += 1
      })
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
        if (n.packageTag === "contract" && n.isBranded === false) {
          codeHygieneViolations += 1
        }
      })
      .with({ _tag: "EffectFn" }, (n) => {
        if (
          (n.packageTag === "domain" || n.packageTag === "contract") &&
          (isDeciderSpan(n.qualname) ||
            isReducerSpan(n.qualname) ||
            /(?:^|#|\.)(?:decide|evolve)/i.test(n.qualname)) &&
          (n.spanName === "untraced" || n.spanName === "<untraced>")
        ) {
          codeHygieneViolations += 1
        }
      })
      .with({ _tag: "EarsSpec" }, (n) => {
        if (n.status === "proposed") {
          const specKey = getNodeKey(n)
          if (!realizedSpecKeys.has(specKey)) {
            const declaredCount =
              (n.referencedSpans?.length ?? 0) +
              (n.referencedServices?.length ?? 0) +
              (n.referencedErrors?.length ?? 0)
            if (declaredCount === 0) {
              unmappedSpecSymbols += 1
            }
          }
        }
      })
      .with(
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
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

const makePlaysRoleEdge = (relationId: string, entityKey: string, role: string): PlaysRoleEdge => {
  const arch = getArchimateRelationForRole(role)
  return Schema.decodeSync(PlaysRoleEdge)({
    _tag: "PlaysRole",
    relationId: RelationId.make(relationId),
    entityKey: NodeKey.make(entityKey),
    role: RoleName.make(role),
    ...(arch !== undefined ? { archimateRelation: arch } : {}),
  })
}

const makeEffectSignatureNode = (
  relationId: string,
  callerQualname: string,
  file = "libs/domain/src/synthesized.ts",
  line = 1,
): EffectSignatureRelation => ({
  _tag: "EffectSignature",
  relationId: RelationId.make(relationId),
  callerQualname,
  requiredServices: [],
  emittedErrors: [],
  calleeQualnames: [],
  payloadSchemas: [],
  file,
  line,
})

const makeLayerFlowNode = (
  relationId: string,
  layerQualname: string,
  file = "libs/infra/src/synthesized-layer.ts",
  line = 1,
): LayerFlowRelation => ({
  _tag: "LayerFlow",
  relationId: RelationId.make(relationId),
  layerQualname,
  providesServices: [],
  requiresServices: [],
  file,
  line,
})

const makeTraceabilityTupleNode = (
  relationId: string,
  targetSymbolQualname = "synthesized",
): TraceabilityTupleRelation => ({
  _tag: "TraceabilityTuple",
  relationId: RelationId.make(relationId),
  targetSymbolQualname,
  verifyingTestQualnames: [],
})

const makeHttpEndpointTupleNode = (relationId: string): HttpEndpointTupleRelation => ({
  _tag: "HttpEndpointTuple",
  relationId: RelationId.make(relationId),
  endpointGroup: "SynthesizedGroup",
  endpointName: "synthesizedEndpoint",
  method: "POST",
  path: "/synthesized",
  handlerQualname: "libs/infra/src/http.ts#synthesizedEndpoint",
  requestSchemaQualnames: [],
  responseSchemaQualnames: [],
  errorTags: [],
  file: "libs/infra/src/http.ts",
  line: 1,
})

const makeMigrationTupleNode = (
  relationId: string,
  migrationId: string,
  moduleFile: string,
): MigrationTupleRelation => ({
  _tag: "MigrationTuple",
  relationId: RelationId.make(relationId),
  migrationId,
  engine: "SqliteMigrator",
  moduleFile,
  isDestructive: false,
  verifyingTestQualnames: [],
  line: 1,
})

const makeVitestCaseNode = (
  testId: string,
  testFile: string,
  testName: string,
  line = 1,
): VitestCaseNode => ({
  _tag: "VitestCase",
  testId,
  testFile,
  testName,
  isPropertyTest: true,
  line,
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

    // Map existing relationId -> canonical nodeKey in graph
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

    // 1. Bipartite Levi Relation Preservation Law (V_R in K):
    // When deleting a single role edge on a relation rel in V_R without deleting rel itself,
    // rel MUST remain in the gluing interface K (preservedInterfaceKeys).
    for (const delEdge of patch.deletedRoleEdges) {
      const relId = delEdge.relationId
      const canonicalRelKey = relKeyByRelId.get(relId) ?? relId
      const isRelDeleted = deletedRelationSet.has(relId) || deletedRelationSet.has(canonicalRelKey)
      if (!isRelDeleted) {
        if (!preservedSet.has(relId) && !preservedSet.has(canonicalRelKey)) {
          return yield* new GraphRewriteError({
            ruleId: patch.ruleId,
            nodeKey: NodeKey.make(canonicalRelKey),
            reason: "bipartite-relation-deleted",
            message: `Rule ${patch.ruleId} deletes PlaysRoleEdge ${getEdgeKey(delEdge)} on relation '${relId}' without preserving '${relId}' in gluing interface K.`,
          })
        }
      }
    }

    // 2. Dangling Condition (Dangling(m) = empty):
    // No remaining edge e in E_G \ E_{L \ K} may be incident to any deleted node in V_L \ V_K.
    for (const [, edge] of Graph.edges(graph.graph)) {
      const data = edge.data
      const edgeKey = getEdgeKey(data)
      if (deletedEdgeKeys.has(edgeKey)) {
        continue
      }
      const canonicalRelKey = relKeyByRelId.get(data.relationId) ?? data.relationId
      if (deletedRelationSet.has(data.relationId) || deletedRelationSet.has(canonicalRelKey)) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId,
          nodeKey: NodeKey.make(canonicalRelKey),
          reason: "bipartite-relation-deleted",
          message: `Rule ${patch.ruleId} deletes relation '${data.relationId}' in L \\ K while leaving incident PlaysRoleEdge '${edgeKey}' dangling in G.`,
        })
      }
      if (deletedEntitySet.has(data.entityKey)) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId,
          nodeKey: data.entityKey,
          reason: "dangling-edge",
          message: `Rule ${patch.ruleId} deletes entity '${data.entityKey}' in L \\ K while leaving incident PlaysRoleEdge '${edgeKey}' dangling in G.`,
        })
      }
    }

    // 3. Verify that all inserted PlaysRoleEdges satisfy the bipartite V_R -> V_E invariant
    // and reference valid post-pushout vertices in V_H.
    const postPushoutNodeKeys = new Set<string>(existingNodeKeys)
    for (const delEnt of deletedEntitySet) {
      postPushoutNodeKeys.delete(delEnt)
    }
    for (const delRel of deletedRelationSet) {
      postPushoutNodeKeys.delete(delRel)
      const mapped = relKeyByRelId.get(delRel)
      if (mapped !== undefined) {
        postPushoutNodeKeys.delete(mapped)
      }
    }
    for (const insEnt of patch.insertedEntityNodes) {
      postPushoutNodeKeys.add(getNodeKey(insEnt))
    }
    for (const insRel of patch.insertedRelationNodes) {
      postPushoutNodeKeys.add(getNodeKey(insRel))
      postPushoutNodeKeys.add(insRel.relationId)
    }

    for (const insEdge of patch.insertedRoleEdges) {
      if (!isBipartitePlaysRoleIds(insEdge.relationId, insEdge.entityKey)) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId,
          nodeKey: insEdge.entityKey,
          reason: "invalid-graph",
          message: `Rule ${patch.ruleId} inserts non-bipartite PlaysRoleEdge '${getEdgeKey(insEdge)}'.`,
        })
      }
      if (
        !postPushoutNodeKeys.has(insEdge.relationId) ||
        !postPushoutNodeKeys.has(insEdge.entityKey)
      ) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId,
          nodeKey: insEdge.entityKey,
          reason: "dangling-edge",
          message: `Rule ${patch.ruleId} inserts PlaysRoleEdge '${getEdgeKey(insEdge)}' referencing missing endpoint in target graph H.`,
        })
      }
    }
  })

/**
 * Applies a validated DPO `GraphPatch` (or `DraftGraphPatch`) to a `HarnessGraph`,
 * enforcing the Gluing Condition (Dangling Condition + Bipartite Levi Relation Preservation Law)
 * and returning the rewritten target hypergraph $H$.
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
      if (isEntityNode(node) && deletedEntitySet.has(key)) {
        continue
      }
      if (
        isRelationNode(node) &&
        (deletedRelationSet.has(key) || deletedRelationSet.has(node.relationId))
      ) {
        continue
      }
      nodesByKey.set(key, node)
      knownEndpointKeys.add(key)
      if (isRelationNode(node)) {
        knownEndpointKeys.add(node.relationId)
      }
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
      if (deletedEdgeKeys.has(eKey)) {
        continue
      }
      edgesByKey.set(eKey, edge.data)
    }
    for (const insEdge of patch.insertedRoleEdges) {
      edgesByKey.set(getEdgeKey(insEdge), insEdge)
    }

    for (const [, edgeData] of edgesByKey.entries()) {
      if (
        !knownEndpointKeys.has(edgeData.relationId) ||
        !knownEndpointKeys.has(edgeData.entityKey)
      ) {
        return yield* new GraphRewriteError({
          ruleId: patch.ruleId,
          nodeKey: edgeData.entityKey,
          reason: "dangling-edge",
          message: `Rule ${patch.ruleId} produced dangling PlaysRoleEdge '${getEdgeKey(edgeData)}' with missing endpoint in target graph.`,
        })
      }
    }

    const nodeIndexByKey = new Map<string, Graph.NodeIndex>()
    const directed = Graph.directed<HarnessNode, HarnessEdge>((mutable) => {
      const sortedNodeEntries = Array.from(nodesByKey.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
      )
      for (const [key, node] of sortedNodeEntries) {
        const idx = Graph.addNode(mutable, node)
        nodeIndexByKey.set(key, idx)
        if (isRelationNode(node)) {
          nodeIndexByKey.set(node.relationId, idx)
        }
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

interface IndexedGraphContext {
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

const indexHarnessGraph = (graph: HarnessGraph): IndexedGraphContext => {
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
      .with({ _tag: "EffectFn" }, (n) => {
        fnsByKey.set(key, n)
      })
      .with({ _tag: "ServiceTag" }, (n) => {
        servicesByKey.set(key, n)
      })
      .with({ _tag: "ServiceLayer" }, (n) => {
        layersByKey.set(key, n)
      })
      .with({ _tag: "TaggedError" }, (n) => {
        errorsByKey.set(key, n)
      })
      .with({ _tag: "SchemaDef" }, (n) => {
        schemasByKey.set(key, n)
      })
      .with({ _tag: "VitestCase" }, (n) => {
        testsByKey.set(key, n)
      })
      .with({ _tag: "EarsSpec" }, (n) => {
        specsByKey.set(key, n)
      })
      .with({ _tag: "PatternDoc" }, { _tag: "AdrDoc" }, () => undefined)
      .with({ _tag: "EffectSignature" }, (n) => {
        sigRelationsById.set(n.relationId, n)
        sigRelationsById.set(key, n)
      })
      .with({ _tag: "LayerFlow" }, (n) => {
        layerRelationsById.set(n.relationId, n)
        layerRelationsById.set(key, n)
      })
      .with({ _tag: "TraceabilityTuple" }, (n) => {
        traceRelationsById.set(n.relationId, n)
        traceRelationsById.set(key, n)
      })
      .with({ _tag: "MigrationTuple" }, (n) => {
        migrationRelationsById.set(n.relationId, n)
        migrationRelationsById.set(key, n)
      })
      .with({ _tag: "HttpEndpointTuple" }, () => undefined)
      .exhaustive()
  }

  for (const [, edge] of Graph.edges(graph.graph)) {
    const data = edge.data
    let relList = edgesByRelId.get(data.relationId)
    if (relList === undefined) {
      relList = []
      edgesByRelId.set(data.relationId, relList)
    }
    relList.push(data)

    let entList = incidentEdgesByEntityKey.get(data.entityKey)
    if (entList === undefined) {
      entList = []
      incidentEdgesByEntityKey.set(data.entityKey, entList)
    }
    entList.push(data)

    if (data.role === "caller") {
      sigIdByCallerKey.set(data.entityKey, data.relationId)
    }
    if (data.role === "specifying-ears" || data.role === "specifying-spec") {
      traceIdBySpecKey.set(data.entityKey, data.relationId)
    }
    if (
      data.role === "realizing-symbol" ||
      data.role === "specified-target" ||
      data.role === "exercised-span"
    ) {
      traceIdByTargetKey.set(data.entityKey, data.relationId)
    }
  }

  return {
    fnsByKey,
    servicesByKey,
    layersByKey,
    errorsByKey,
    schemasByKey,
    testsByKey,
    specsByKey,
    sigRelationsById,
    layerRelationsById,
    traceRelationsById,
    migrationRelationsById,
    sigIdByCallerKey,
    traceIdBySpecKey,
    traceIdByTargetKey,
    edgesByRelId,
    incidentEdgesByEntityKey,
  }
}

const sanitizeIdentifier = (raw: string): string =>
  raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "") || "Synthesized"

const findFnBySpanOrQualname = (
  ctx: IndexedGraphContext,
  spanOrQual: string,
): { readonly key: string; readonly node: EffectFnNode } | undefined => {
  for (const [key, node] of ctx.fnsByKey.entries()) {
    if (
      node.spanName === spanOrQual ||
      node.qualname === spanOrQual ||
      node.qualname.endsWith(`#${spanOrQual}`)
    ) {
      return { key, node }
    }
  }
  return undefined
}

const findServiceByTagOrName = (
  ctx: IndexedGraphContext,
  svcName: string,
): { readonly key: string; readonly node: ServiceTagNode } | undefined => {
  for (const [key, node] of ctx.servicesByKey.entries()) {
    if (node.tagId === svcName || node.name === svcName || node.tagId.endsWith(`#${svcName}`)) {
      return { key, node }
    }
  }
  return undefined
}

const findErrorByTag = (
  ctx: IndexedGraphContext,
  errTag: string,
): { readonly key: string; readonly node: TaggedErrorNode } | undefined => {
  for (const [key, node] of ctx.errorsByKey.entries()) {
    if (node.errorTag === errTag || node.tag === errTag || key === `TaggedError:${errTag}`) {
      return { key, node }
    }
  }
  return undefined
}

const hasLayerProviderForService = (ctx: IndexedGraphContext, serviceKey: string): boolean => {
  for (const [relId] of ctx.layerRelationsById.entries()) {
    const edges = ctx.edgesByRelId.get(relId) ?? []
    const hasProvider = edges.some((e) => e.role === "provider-layer")
    const providesSvc = edges.some(
      (e) => e.role === "provided-service" && e.entityKey === serviceKey,
    )
    if (hasProvider && providesSvc) {
      return true
    }
  }
  return false
}

// ============================================================================
// Phase 1: PLAN DPO Candidate Generators (PLAN-01..04)
// ============================================================================

const findPhase1PlanPatches = (
  graph: HarnessGraph,
  inference: GraphInferenceResult,
): ReadonlyArray<DraftGraphPatch> => {
  const ctx = indexHarnessGraph(graph)
  const patches: Array<DraftGraphPatch> = []

  const sortedSpecs = Array.from(ctx.specsByKey.entries()).sort((a, b) => a[0].localeCompare(b[0]))

  for (const [specKey, specNode] of sortedSpecs) {
    if (specNode.status !== "proposed" && specNode.status !== "accepted") {
      continue
    }

    const existingTraceRelId = ctx.traceIdBySpecKey.get(specKey)
    const traceRelId = existingTraceRelId ?? `TraceabilityTuple:trace:${specNode.id}`
    const traceRelNode: TraceabilityTupleRelation = makeTraceabilityTupleNode(
      traceRelId,
      specNode.id,
    )
    const traceExists = existingTraceRelId !== undefined

    const declaredSpans =
      specNode.referencedSpans !== undefined && specNode.referencedSpans.length > 0
        ? specNode.referencedSpans
        : specNode.status === "proposed"
          ? [`${sanitizeIdentifier(specNode.id)}.execute`]
          : []

    // PLAN-01: WHEN clause -> Input SchemaDef + Use-Case EffectFn stub + EffectSignature + TraceabilityTuple
    for (const spanName of declaredSpans) {
      if (isDeciderSpan(spanName) || isReducerSpan(spanName)) {
        continue
      }
      const existingFn = findFnBySpanOrQualname(ctx, spanName)
      if (existingFn !== undefined) {
        continue
      }

      const cleanId = sanitizeIdentifier(spanName)
      const schemaName = `${cleanId}Input`
      const schemaKey = `SchemaDef:${schemaName}`
      const fnQualname = `libs/domain/src/${cleanId.toLowerCase()}.ts#${cleanId}`
      const fnKey = `EffectFn:${fnQualname}`
      const sigRelId = `EffectSignature:sig:${fnQualname}`
      const testId = `libs/domain/test/${cleanId.toLowerCase()}.test.ts#${spanName} property test`
      const testKey = `VitestCase:${testId}`

      const insertedEntities: Array<EntityNode> = []
      const insertedRelations: Array<RelationNode> = [
        makeEffectSignatureNode(
          sigRelId,
          fnQualname,
          `libs/domain/src/${cleanId.toLowerCase()}.ts`,
        ),
      ]
      if (!traceExists) {
        insertedRelations.push(traceRelNode)
      }

      if (!ctx.schemasByKey.has(schemaKey)) {
        insertedEntities.push({
          _tag: "SchemaDef",
          schemaName,
          name: schemaName,
          file: `libs/contract/src/${cleanId.toLowerCase()}.ts`,
          line: 1,
          packageTag: "contract",
          isBranded: true,
        })
      }

      insertedEntities.push({
        _tag: "EffectFn",
        qualname: fnQualname,
        spanName,
        packageTag: "domain",
        file: `libs/domain/src/${cleanId.toLowerCase()}.ts`,
        line: 1,
        isStub: true,
        inputSchema: schemaName,
        outputSchema: schemaName,
        successType: schemaName,
      })

      if (!ctx.testsByKey.has(testKey)) {
        insertedEntities.push(
          makeVitestCaseNode(
            testId,
            `libs/domain/test/${cleanId.toLowerCase()}.test.ts`,
            `${spanName} property test`,
          ),
        )
      }

      const insertedEdges: Array<PlaysRoleEdge> = [
        makePlaysRoleEdge(sigRelId, fnKey, "caller"),
        makePlaysRoleEdge(sigRelId, schemaKey, "input-schema"),
        makePlaysRoleEdge(sigRelId, schemaKey, "output-schema"),
        makePlaysRoleEdge(traceRelId, fnKey, "realizing-symbol"),
        makePlaysRoleEdge(traceRelId, testKey, "verifying-test"),
      ]
      if (!traceExists) {
        insertedEdges.push(makePlaysRoleEdge(traceRelId, specKey, "specifying-ears"))
      }

      const preservedKeys: Array<NodeKey> = [NodeKey.make(specKey)]
      if (traceExists) {
        preservedKeys.push(NodeKey.make(traceRelId))
      }

      patches.push({
        ruleId: RewriteRuleId.make("PLAN-01"),
        phase: "PLAN",
        ruleCategory: "auto-plan",
        description: `Synthesize contract input SchemaDef '${schemaName}', domain use-case stub '${spanName}', EffectSignature, and TraceabilityTuple for EARS spec '${specNode.id}'.`,
        primaryNodeKey: NodeKey.make(specKey),
        preservedInterfaceKeys: preservedKeys,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities,
        insertedRelationNodes: insertedRelations,
        insertedRoleEdges: insertedEdges,
      })
      return patches
    }

    // PLAN-02: WHILE clause -> Pure .decide (R = never) + .evolve EffectFn stubs + TraceabilityTuple
    for (const spanName of declaredSpans) {
      if (!isDeciderSpan(spanName) && !isReducerSpan(spanName)) {
        continue
      }
      const existingFn = findFnBySpanOrQualname(ctx, spanName)
      if (existingFn !== undefined) {
        continue
      }

      const scopePrefix = spanName.replace(/\.(?:decide|evolve)$/, "")
      const decideSpan = `${scopePrefix}.decide`
      const evolveSpan = `${scopePrefix}.evolve`
      const cleanScope = sanitizeIdentifier(scopePrefix)
      const decideQual = `libs/domain/src/${cleanScope.toLowerCase()}.ts#decide${cleanScope}`
      const evolveQual = `libs/domain/src/${cleanScope.toLowerCase()}.ts#evolve${cleanScope}`
      const decideKey = `EffectFn:${decideQual}`
      const evolveKey = `EffectFn:${evolveQual}`
      const decideSigId = `EffectSignature:sig:${decideQual}`
      const evolveSigId = `EffectSignature:sig:${evolveQual}`
      const testId = `libs/domain/test/${cleanScope.toLowerCase()}.test.ts#${decideSpan} property test`
      const testKey = `VitestCase:${testId}`

      const insertedEntities: Array<EntityNode> = []
      const insertedRelations: Array<RelationNode> = []
      const insertedEdges: Array<PlaysRoleEdge> = []

      if (!traceExists) {
        insertedRelations.push(traceRelNode)
        insertedEdges.push(makePlaysRoleEdge(traceRelId, specKey, "specifying-ears"))
      }

      if (findFnBySpanOrQualname(ctx, decideSpan) === undefined) {
        insertedEntities.push({
          _tag: "EffectFn",
          qualname: decideQual,
          spanName: decideSpan,
          packageTag: "domain",
          file: `libs/domain/src/${cleanScope.toLowerCase()}.ts`,
          line: 1,
          isStub: true,
        })
        insertedRelations.push(
          makeEffectSignatureNode(
            decideSigId,
            decideQual,
            `libs/domain/src/${cleanScope.toLowerCase()}.ts`,
          ),
        )
        insertedEdges.push(
          makePlaysRoleEdge(decideSigId, decideKey, "caller"),
          makePlaysRoleEdge(traceRelId, decideKey, "realizing-symbol"),
        )
      }

      if (findFnBySpanOrQualname(ctx, evolveSpan) === undefined) {
        insertedEntities.push({
          _tag: "EffectFn",
          qualname: evolveQual,
          spanName: evolveSpan,
          packageTag: "domain",
          file: `libs/domain/src/${cleanScope.toLowerCase()}.ts`,
          line: 10,
          isStub: true,
        })
        insertedRelations.push(
          makeEffectSignatureNode(
            evolveSigId,
            evolveQual,
            `libs/domain/src/${cleanScope.toLowerCase()}.ts`,
            10,
          ),
        )
        insertedEdges.push(
          makePlaysRoleEdge(evolveSigId, evolveKey, "caller"),
          makePlaysRoleEdge(traceRelId, evolveKey, "realizing-symbol"),
        )
      }

      if (!ctx.testsByKey.has(testKey)) {
        insertedEntities.push(
          makeVitestCaseNode(
            testId,
            `libs/domain/test/${cleanScope.toLowerCase()}.test.ts`,
            `${decideSpan} property test`,
          ),
        )
      }
      insertedEdges.push(makePlaysRoleEdge(traceRelId, testKey, "verifying-test"))

      const preservedKeys: Array<NodeKey> = [NodeKey.make(specKey)]
      if (traceExists) {
        preservedKeys.push(NodeKey.make(traceRelId))
      }

      patches.push({
        ruleId: RewriteRuleId.make("PLAN-02"),
        phase: "PLAN",
        ruleCategory: "auto-plan",
        description: `Synthesize pure '${decideSpan}' (R = never) and '${evolveSpan}' EffectFn stubs linked to TraceabilityTuple for EARS spec '${specNode.id}'.`,
        primaryNodeKey: NodeKey.make(specKey),
        preservedInterfaceKeys: preservedKeys,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities,
        insertedRelationNodes: insertedRelations,
        insertedRoleEdges: insertedEdges,
      })
      return patches
    }

    // Find realizing EffectFns for this spec to wire PLAN-03 (IF/THEN errors) and PLAN-04 (WHERE services)
    const specRealizingFns: Array<{ readonly key: string; readonly node: EffectFnNode }> = []
    for (const spanName of declaredSpans) {
      const found = findFnBySpanOrQualname(ctx, spanName)
      if (found !== undefined) {
        specRealizingFns.push(found)
      }
    }
    if (existingTraceRelId !== undefined) {
      for (const e of ctx.edgesByRelId.get(existingTraceRelId) ?? []) {
        if (e.role === "realizing-symbol" || e.role === "specified-target") {
          const fnNode = ctx.fnsByKey.get(e.entityKey)
          if (fnNode !== undefined && !specRealizingFns.some((item) => item.key === e.entityKey)) {
            specRealizingFns.push({ key: e.entityKey, node: fnNode })
          }
        }
      }
    }

    // PLAN-03: IF/THEN clause -> TaggedError + fails-with PlaysRoleEdge on EffectSignature in K
    for (const errTag of specNode.referencedErrors ?? []) {
      const existingErr = findErrorByTag(ctx, errTag)
      const errKey = existingErr?.key ?? `TaggedError:${errTag}`
      const targetFn =
        specRealizingFns.find((f) => !isReducerSpan(f.node.spanName)) ?? specRealizingFns[0]

      const sigRelId =
        targetFn !== undefined
          ? (ctx.sigIdByCallerKey.get(targetFn.key) ??
            `EffectSignature:sig:${targetFn.node.qualname}`)
          : undefined
      const sigExists = sigRelId !== undefined && ctx.sigRelationsById.has(sigRelId)
      const alreadyWiredOnSig =
        sigRelId !== undefined &&
        (ctx.edgesByRelId.get(sigRelId) ?? []).some(
          (e) => e.role === "fails-with" && e.entityKey === errKey,
        )

      if (existingErr !== undefined && (targetFn === undefined || alreadyWiredOnSig)) {
        continue
      }

      const insertedEntities: Array<EntityNode> = []
      const insertedRelations: Array<RelationNode> = []
      const insertedEdges: Array<PlaysRoleEdge> = []
      const preservedKeys: Array<NodeKey> = [NodeKey.make(specKey)]

      if (existingErr === undefined) {
        insertedEntities.push({
          _tag: "TaggedError",
          errorTag: errTag,
          tag: errTag,
          file: "libs/contract/src/errors.ts",
          line: 1,
        })
      } else {
        preservedKeys.push(NodeKey.make(errKey))
      }

      if (!traceExists) {
        insertedRelations.push(traceRelNode)
        insertedEdges.push(makePlaysRoleEdge(traceRelId, specKey, "specifying-ears"))
      } else {
        preservedKeys.push(NodeKey.make(traceRelId))
      }
      insertedEdges.push(makePlaysRoleEdge(traceRelId, errKey, "realizing-symbol"))

      if (targetFn !== undefined && sigRelId !== undefined) {
        preservedKeys.push(NodeKey.make(targetFn.key))
        if (!sigExists) {
          insertedRelations.push(
            makeEffectSignatureNode(sigRelId, targetFn.node.qualname, targetFn.node.file),
          )
          insertedEdges.push(makePlaysRoleEdge(sigRelId, targetFn.key, "caller"))
        } else {
          preservedKeys.push(NodeKey.make(sigRelId))
        }
        if (!alreadyWiredOnSig) {
          insertedEdges.push(makePlaysRoleEdge(sigRelId, errKey, "fails-with"))
        }
      }

      patches.push({
        ruleId: RewriteRuleId.make("PLAN-03"),
        phase: "PLAN",
        ruleCategory: "auto-plan",
        description: `Synthesize contract TaggedError '${errTag}' and wire fails-with role edge on EffectSignature in K for EARS spec '${specNode.id}'.`,
        primaryNodeKey: NodeKey.make(specKey),
        preservedInterfaceKeys: preservedKeys,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities,
        insertedRelationNodes: insertedRelations,
        insertedRoleEdges: insertedEdges,
      })
      return patches
    }

    // PLAN-04: WHERE clause -> ServiceTag port + requires-service on EffectSignature in K + ServiceLayer + LayerFlow + VitestCase
    for (const svcName of specNode.referencedServices ?? []) {
      const existingSvc = findServiceByTagOrName(ctx, svcName)
      const svcKey = existingSvc?.key ?? `ServiceTag:${svcName}`
      const nonDeciderFns = specRealizingFns.filter(
        (f) => !isDeciderSpan(f.node.spanName) && !isReducerSpan(f.node.spanName),
      )
      const hasProvider = existingSvc !== undefined && hasLayerProviderForService(ctx, svcKey)
      const allTargetsWired = nonDeciderFns.every((fn) => {
        const sId = ctx.sigIdByCallerKey.get(fn.key)
        return (
          sId !== undefined &&
          (ctx.edgesByRelId.get(sId) ?? []).some(
            (e) => e.role === "requires-service" && e.entityKey === svcKey,
          )
        )
      })

      if (existingSvc !== undefined && hasProvider && allTargetsWired) {
        continue
      }

      const insertedEntities: Array<EntityNode> = []
      const insertedRelations: Array<RelationNode> = []
      const insertedEdges: Array<PlaysRoleEdge> = []
      const preservedKeys: Array<NodeKey> = [NodeKey.make(specKey)]

      if (existingSvc === undefined) {
        insertedEntities.push({
          _tag: "ServiceTag",
          tagId: svcName,
          name: svcName,
          packageTag: "service",
          file: `libs/service/src/${sanitizeIdentifier(svcName).toLowerCase()}.ts`,
          line: 1,
        })
      } else {
        preservedKeys.push(NodeKey.make(svcKey))
      }

      if (!traceExists) {
        insertedRelations.push(traceRelNode)
        insertedEdges.push(makePlaysRoleEdge(traceRelId, specKey, "specifying-ears"))
      } else {
        preservedKeys.push(NodeKey.make(traceRelId))
      }
      insertedEdges.push(makePlaysRoleEdge(traceRelId, svcKey, "realizing-symbol"))

      if (!hasProvider) {
        const layerQual = `libs/infra/src/${sanitizeIdentifier(svcName).toLowerCase()}-live.ts#${sanitizeIdentifier(svcName)}Live`
        const layerKey = `ServiceLayer:${layerQual}`
        const layerFlowId = `LayerFlow:layer-flow:${layerQual}`
        if (!ctx.layersByKey.has(layerKey)) {
          insertedEntities.push({
            _tag: "ServiceLayer",
            qualname: layerQual,
            layerKind: "live",
            packageTag: "infra",
            file: `libs/infra/src/${sanitizeIdentifier(svcName).toLowerCase()}-live.ts`,
            line: 1,
          })
        } else {
          preservedKeys.push(NodeKey.make(layerKey))
        }
        if (!ctx.layerRelationsById.has(layerFlowId)) {
          insertedRelations.push(
            makeLayerFlowNode(
              layerFlowId,
              layerQual,
              `libs/infra/src/${sanitizeIdentifier(svcName).toLowerCase()}-live.ts`,
            ),
          )
        } else {
          preservedKeys.push(NodeKey.make(layerFlowId))
        }
        insertedEdges.push(
          makePlaysRoleEdge(layerFlowId, layerKey, "provider-layer"),
          makePlaysRoleEdge(layerFlowId, svcKey, "provided-service"),
        )
      }

      for (const targetFn of nonDeciderFns) {
        preservedKeys.push(NodeKey.make(targetFn.key))
        const sigRelId =
          ctx.sigIdByCallerKey.get(targetFn.key) ?? `EffectSignature:sig:${targetFn.node.qualname}`
        if (!ctx.sigRelationsById.has(sigRelId)) {
          insertedRelations.push(
            makeEffectSignatureNode(sigRelId, targetFn.node.qualname, targetFn.node.file),
          )
          insertedEdges.push(makePlaysRoleEdge(sigRelId, targetFn.key, "caller"))
        } else {
          preservedKeys.push(NodeKey.make(sigRelId))
        }
        const alreadyReq = (ctx.edgesByRelId.get(sigRelId) ?? []).some(
          (e) => e.role === "requires-service" && e.entityKey === svcKey,
        )
        if (!alreadyReq) {
          insertedEdges.push(makePlaysRoleEdge(sigRelId, svcKey, "requires-service"))
        }
      }

      patches.push({
        ruleId: RewriteRuleId.make("PLAN-04"),
        phase: "PLAN",
        ruleCategory: "auto-plan",
        description: `Synthesize ServiceTag port '${svcName}', wire requires-service on EffectSignature in K, and add live ServiceLayer + LayerFlow for EARS spec '${specNode.id}'.`,
        primaryNodeKey: NodeKey.make(specKey),
        preservedInterfaceKeys: preservedKeys,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities,
        insertedRelationNodes: insertedRelations,
        insertedRoleEdges: insertedEdges,
      })
      return patches
    }
  }

  void inference
  return patches
}

// ============================================================================
// Phase 2: REPAIR_ARCH DPO Candidate Generators (REP-01..04b)
// ============================================================================

const findPhase2ArchRepairBranches = (
  graph: HarnessGraph,
  inference: GraphInferenceResult,
): ReadonlyArray<ReadonlyArray<DraftGraphPatch>> => {
  const ctx = indexHarnessGraph(graph)

  // 1. REP-01: domain-requires-infra / domain-requires-cloud-binding
  for (const ap of inference.antiPatterns) {
    if (
      (ap.ruleId === "domain-requires-infra" || ap.ruleId === "domain-requires-cloud-binding") &&
      ap.targetKey !== undefined
    ) {
      const hasMoreSpecificRule = inference.antiPatterns.some(
        (other) =>
          other.nodeKey === ap.nodeKey &&
          other.targetKey === ap.targetKey &&
          (other.ruleId === "aggregate-direct-bus-publish" ||
            other.ruleId === "impure-decider" ||
            other.ruleId === "impure-reducer"),
      )
      if (hasMoreSpecificRule) {
        continue
      }
      const infraSvcKey = ap.targetKey
      const infraSvc = ctx.servicesByKey.get(infraSvcKey)
      // Find the EffectSignature relation that directly has requires-service -> infraSvcKey
      let targetSigRelId: string | undefined
      let targetCallerKey = ap.nodeKey
      let deletedEdge: PlaysRoleEdge | undefined

      for (const [relId, edges] of ctx.edgesByRelId.entries()) {
        const reqEdge = edges.find(
          (e) => e.role === "requires-service" && e.entityKey === infraSvcKey,
        )
        const callerEdge = edges.find((e) => e.role === "caller")
        if (reqEdge !== undefined && callerEdge !== undefined) {
          targetSigRelId = relId
          targetCallerKey = callerEdge.entityKey
          deletedEdge = reqEdge
          if (callerEdge.entityKey === ap.nodeKey) {
            break
          }
        }
      }

      if (targetSigRelId !== undefined && deletedEdge !== undefined) {
        const rawSvcName =
          infraSvc?.name ??
          infraSvcKey
            .replace(/^ServiceTag:/, "")
            .split("#")
            .pop() ??
          "Infra"
        const basePortName = rawSvcName.replace(/^(?:Drizzle|D1|Sqlite|Cloudflare|Live)/, "")
        const portName =
          basePortName.length > 0 && basePortName !== rawSvcName
            ? basePortName
            : `${rawSvcName}Port`
        const portKey = `ServiceTag:${portName}`
        const layerQual = `libs/infra/src/${sanitizeIdentifier(portName).toLowerCase()}-live.ts#${sanitizeIdentifier(portName)}Live`
        const layerKey = `ServiceLayer:${layerQual}`
        const layerFlowId = `LayerFlow:layer-flow:${layerQual}`

        const insertedEntities: Array<EntityNode> = []
        const insertedRelations: Array<RelationNode> = []
        const insertedEdges: Array<PlaysRoleEdge> = [
          makePlaysRoleEdge(targetSigRelId, portKey, "requires-service"),
        ]

        if (!ctx.servicesByKey.has(portKey)) {
          insertedEntities.push({
            _tag: "ServiceTag",
            tagId: portName,
            name: portName,
            packageTag: "service",
            file: `libs/service/src/${sanitizeIdentifier(portName).toLowerCase()}.ts`,
            line: 1,
          })
        }
        if (!ctx.layersByKey.has(layerKey)) {
          insertedEntities.push({
            _tag: "ServiceLayer",
            qualname: layerQual,
            layerKind: "live",
            packageTag: "infra",
            file: `libs/infra/src/${sanitizeIdentifier(portName).toLowerCase()}-live.ts`,
            line: 1,
          })
        }
        if (!ctx.layerRelationsById.has(layerFlowId)) {
          insertedRelations.push(
            makeLayerFlowNode(
              layerFlowId,
              layerQual,
              `libs/infra/src/${sanitizeIdentifier(portName).toLowerCase()}-live.ts`,
            ),
          )
        }
        insertedEdges.push(
          makePlaysRoleEdge(layerFlowId, layerKey, "provider-layer"),
          makePlaysRoleEdge(layerFlowId, portKey, "provided-service"),
          makePlaysRoleEdge(layerFlowId, infraSvcKey, "required-service"),
        )

        // Ensure infraSvcKey also has a provider layer so missingLayerProviders does not increase
        if (!hasLayerProviderForService(ctx, infraSvcKey)) {
          const infraLayerQual = `libs/infra/src/${sanitizeIdentifier(rawSvcName).toLowerCase()}-infra.ts#${sanitizeIdentifier(rawSvcName)}InfraLive`
          const infraLayerKey = `ServiceLayer:${infraLayerQual}`
          const infraFlowId = `LayerFlow:layer-flow:${infraLayerQual}`
          if (!ctx.layersByKey.has(infraLayerKey)) {
            insertedEntities.push({
              _tag: "ServiceLayer",
              qualname: infraLayerQual,
              layerKind: "infra",
              packageTag: "infra",
              file: `libs/infra/src/${sanitizeIdentifier(rawSvcName).toLowerCase()}-infra.ts`,
              line: 1,
            })
          }
          if (!ctx.layerRelationsById.has(infraFlowId)) {
            insertedRelations.push(
              makeLayerFlowNode(
                infraFlowId,
                infraLayerQual,
                `libs/infra/src/${sanitizeIdentifier(rawSvcName).toLowerCase()}-infra.ts`,
              ),
            )
          }
          insertedEdges.push(
            makePlaysRoleEdge(infraFlowId, infraLayerKey, "provider-layer"),
            makePlaysRoleEdge(infraFlowId, infraSvcKey, "provided-service"),
          )
        }

        // If any EarsSpec referenced infraSvc, update its referencedServices to include portName
        for (const [, specNode] of ctx.specsByKey.entries()) {
          if (
            specNode.referencedServices?.includes(rawSvcName) ||
            specNode.referencedServices?.includes(infraSvc?.tagId ?? "")
          ) {
            const updatedSvcs = (specNode.referencedServices ?? []).map((s) =>
              s === rawSvcName || s === infraSvc?.tagId ? portName : s,
            )
            insertedEntities.push({
              ...specNode,
              referencedServices: updatedSvcs,
            })
          }
        }

        return [
          [
            {
              ruleId: RewriteRuleId.make("REP-01"),
              phase: "REPAIR_ARCH",
              ruleCategory: "auto-repair",
              description: `Extract service port '${portName}' in type:service, rewire preserved EffectSignature '${targetSigRelId}' in K, and bind '${layerQual}' in type:infra.`,
              primaryNodeKey: targetCallerKey,
              preservedInterfaceKeys: [targetCallerKey, infraSvcKey, NodeKey.make(targetSigRelId)],
              deletedEntityKeys: [],
              deletedRelationIds: [],
              deletedRoleEdges: [deletedEdge],
              insertedEntityNodes: insertedEntities,
              insertedRelationNodes: insertedRelations,
              insertedRoleEdges: insertedEdges,
            },
          ],
        ]
      }
    }
  }

  // 2. REP-02: impure-decider / impure-reducer
  for (const ap of inference.antiPatterns) {
    if (
      (ap.ruleId === "impure-decider" || ap.ruleId === "impure-reducer") &&
      ap.targetKey !== undefined
    ) {
      const deciderKey = ap.nodeKey
      const deciderNode = ctx.fnsByKey.get(deciderKey)
      const targetKey = ap.targetKey
      const sigRelId = ctx.sigIdByCallerKey.get(deciderKey)

      if (deciderNode !== undefined && sigRelId !== undefined) {
        const sigEdges = ctx.edgesByRelId.get(sigRelId) ?? []
        const firstHopStep = ap.path.length > 2 ? ap.path[1] : undefined
        const firstHopCalleeKey =
          firstHopStep !== undefined
            ? firstHopStep.startsWith("EffectFn:")
              ? firstHopStep
              : `EffectFn:${firstHopStep}`
            : undefined
        const directEdge =
          sigEdges.find(
            (e) =>
              (e.role === "requires-service" || e.role === "fails-with" || e.role === "callee") &&
              e.entityKey === targetKey,
          ) ??
          (firstHopCalleeKey !== undefined
            ? sigEdges.find(
                (e) =>
                  e.role === "callee" &&
                  (e.entityKey === firstHopCalleeKey || e.entityKey === firstHopStep),
              )
            : undefined)

        if (directEdge !== undefined) {
          const scopePrefix = deciderNode.spanName.replace(/\.(?:decide|evolve)$/, "")
          const ucSpan = `${scopePrefix}.execute`
          const cleanScope = sanitizeIdentifier(scopePrefix)
          const ucQual = `${deciderNode.file}#execute${cleanScope}`
          const ucKey = `EffectFn:${ucQual}`
          const ucSigId = `EffectSignature:sig:${ucQual}`

          const insertedEntities: Array<EntityNode> = []
          const insertedRelations: Array<RelationNode> = []
          const insertedEdges: Array<PlaysRoleEdge> = []

          if (!ctx.fnsByKey.has(ucKey)) {
            insertedEntities.push({
              _tag: "EffectFn",
              qualname: ucQual,
              spanName: ucSpan,
              packageTag: "domain",
              file: deciderNode.file,
              line: deciderNode.line + 20,
              isStub: true,
            })
          }
          if (!ctx.sigRelationsById.has(ucSigId)) {
            insertedRelations.push(
              makeEffectSignatureNode(ucSigId, ucQual, deciderNode.file, deciderNode.line + 20),
            )
          }
          insertedEdges.push(
            makePlaysRoleEdge(ucSigId, ucKey, "caller"),
            makePlaysRoleEdge(ucSigId, deciderKey, "callee"),
          )
          if (directEdge.role === "callee" && directEdge.entityKey !== deciderKey) {
            insertedEdges.push(makePlaysRoleEdge(ucSigId, directEdge.entityKey, "callee"))
          }

          if (targetKey.startsWith("ServiceTag:")) {
            const svcNode = ctx.servicesByKey.get(targetKey)
            if (svcNode?.packageTag === "infra") {
              // Upgrade or provide a service port if needed
              insertedEntities.push({
                ...svcNode,
                packageTag: "service",
              })
            }
            insertedEdges.push(makePlaysRoleEdge(ucSigId, targetKey, "requires-service"))
            if (!hasLayerProviderForService(ctx, targetKey)) {
              const svcClean = sanitizeIdentifier(
                svcNode?.name ?? targetKey.replace(/^ServiceTag:/, ""),
              )
              const layerQual = `libs/infra/src/${svcClean.toLowerCase()}-live.ts#${svcClean}Live`
              const layerKey = `ServiceLayer:${layerQual}`
              const flowId = `LayerFlow:layer-flow:${layerQual}`
              if (!ctx.layersByKey.has(layerKey)) {
                insertedEntities.push({
                  _tag: "ServiceLayer",
                  qualname: layerQual,
                  layerKind: "live",
                  packageTag: "infra",
                  file: `libs/infra/src/${svcClean.toLowerCase()}-live.ts`,
                  line: 1,
                })
              }
              if (!ctx.layerRelationsById.has(flowId)) {
                insertedRelations.push(
                  makeLayerFlowNode(
                    flowId,
                    layerQual,
                    `libs/infra/src/${svcClean.toLowerCase()}-live.ts`,
                  ),
                )
              }
              insertedEdges.push(
                makePlaysRoleEdge(flowId, layerKey, "provider-layer"),
                makePlaysRoleEdge(flowId, targetKey, "provided-service"),
              )
            }
          }

          // If any TraceabilityTuple references deciderKey, also link ucKey so it is covered by tests
          const traceRelId = ctx.traceIdByTargetKey.get(deciderKey)
          const preservedKeys: Array<NodeKey> = [
            deciderKey,
            targetKey,
            NodeKey.make(sigRelId),
            ...(directEdge.entityKey !== targetKey ? [directEdge.entityKey] : []),
          ]
          if (traceRelId !== undefined) {
            preservedKeys.push(NodeKey.make(traceRelId))
            insertedEdges.push(makePlaysRoleEdge(traceRelId, ucKey, "realizing-symbol"))
          }

          return [
            [
              {
                ruleId: RewriteRuleId.make("REP-02"),
                phase: "REPAIR_ARCH",
                ruleCategory: "auto-repair",
                description: `Remove impure '${directEdge.role}' edge from '${deciderNode.spanName}' EffectSignature '${sigRelId}' in K (restoring R = never) and split out orchestrator '${ucSpan}'.`,
                primaryNodeKey: deciderKey,
                preservedInterfaceKeys: preservedKeys,
                deletedEntityKeys: [],
                deletedRelationIds: [],
                deletedRoleEdges: [directEdge],
                insertedEntityNodes: insertedEntities,
                insertedRelationNodes: insertedRelations,
                insertedRoleEdges: insertedEdges,
              },
            ],
          ]
        }
      }
    }
  }

  // 3. REP-03: aggregate-direct-bus-publish
  for (const ap of inference.antiPatterns) {
    if (ap.ruleId === "aggregate-direct-bus-publish" && ap.targetKey !== undefined) {
      const aggKey = ap.nodeKey
      const aggNode = ctx.fnsByKey.get(aggKey)
      const busTargetKey = ap.targetKey
      const sigRelId = ctx.sigIdByCallerKey.get(aggKey)

      if (aggNode !== undefined && sigRelId !== undefined) {
        const sigEdges = ctx.edgesByRelId.get(sigRelId) ?? []
        const offendingEdge = sigEdges.find(
          (e) =>
            (e.role === "requires-service" || e.role === "callee") && e.entityKey === busTargetKey,
        )

        if (offendingEdge !== undefined) {
          const outboxPortKey = "ServiceTag:OutboxStore"
          const relayQual = "libs/infra/src/outbox-relay.ts#drainOutboxRelay"
          const relayKey = `EffectFn:${relayQual}`
          const relaySigId = `EffectSignature:sig:${relayQual}`
          const outboxLayerQual = "libs/infra/src/outbox-store-live.ts#OutboxStoreLive"
          const outboxLayerKey = `ServiceLayer:${outboxLayerQual}`
          const outboxFlowId = `LayerFlow:layer-flow:${outboxLayerQual}`

          const insertedEntities: Array<EntityNode> = []
          const insertedRelations: Array<RelationNode> = []
          const insertedEdges: Array<PlaysRoleEdge> = [
            makePlaysRoleEdge(sigRelId, outboxPortKey, "requires-service"),
          ]

          if (!ctx.servicesByKey.has(outboxPortKey)) {
            insertedEntities.push({
              _tag: "ServiceTag",
              tagId: "OutboxStore",
              name: "OutboxStore",
              packageTag: "service",
              file: "libs/service/src/outbox-store.ts",
              line: 1,
            })
          }
          if (!ctx.fnsByKey.has(relayKey)) {
            insertedEntities.push({
              _tag: "EffectFn",
              qualname: relayQual,
              spanName: "Outbox.drain",
              packageTag: "infra",
              file: "libs/infra/src/outbox-relay.ts",
              line: 1,
            })
          }
          if (!ctx.sigRelationsById.has(relaySigId)) {
            insertedRelations.push(
              makeEffectSignatureNode(relaySigId, relayQual, "libs/infra/src/outbox-relay.ts"),
            )
          }
          insertedEdges.push(
            makePlaysRoleEdge(relaySigId, relayKey, "caller"),
            makePlaysRoleEdge(relaySigId, outboxPortKey, "requires-service"),
          )
          if (busTargetKey.startsWith("ServiceTag:")) {
            insertedEdges.push(makePlaysRoleEdge(relaySigId, busTargetKey, "requires-service"))
          } else if (busTargetKey.startsWith("EffectFn:")) {
            insertedEdges.push(makePlaysRoleEdge(relaySigId, busTargetKey, "callee"))
          }

          if (!hasLayerProviderForService(ctx, outboxPortKey)) {
            if (!ctx.layersByKey.has(outboxLayerKey)) {
              insertedEntities.push({
                _tag: "ServiceLayer",
                qualname: outboxLayerQual,
                layerKind: "live",
                packageTag: "infra",
                file: "libs/infra/src/outbox-store-live.ts",
                line: 1,
              })
            }
            if (!ctx.layerRelationsById.has(outboxFlowId)) {
              insertedRelations.push(
                makeLayerFlowNode(
                  outboxFlowId,
                  outboxLayerQual,
                  "libs/infra/src/outbox-store-live.ts",
                ),
              )
            }
            insertedEdges.push(
              makePlaysRoleEdge(outboxFlowId, outboxLayerKey, "provider-layer"),
              makePlaysRoleEdge(outboxFlowId, outboxPortKey, "provided-service"),
            )
          }

          return [
            [
              {
                ruleId: RewriteRuleId.make("REP-03"),
                phase: "REPAIR_ARCH",
                ruleCategory: "auto-repair",
                description: `Replace direct EventBus coupling on aggregate '${aggNode.spanName}' EffectSignature '${sigRelId}' in K with transactional OutboxStore port and OutboxRelay worker.`,
                primaryNodeKey: aggKey,
                preservedInterfaceKeys: [aggKey, busTargetKey, NodeKey.make(sigRelId)],
                deletedEntityKeys: [],
                deletedRelationIds: [],
                deletedRoleEdges: [offendingEdge],
                insertedEntityNodes: insertedEntities,
                insertedRelationNodes: insertedRelations,
                insertedRoleEdges: insertedEdges,
              },
            ],
          ]
        }
      }
    }
  }

  // 4. REP-04a vs REP-04b: Multi-candidate resolution of unhandled-error / COMP-01
  const comp01Suggestion = inference.suggestedEdges.find(
    (s) => s.ruleId === "COMP-01" && s.role === "fails-with",
  )
  if (comp01Suggestion !== undefined) {
    const sigRelId = comp01Suggestion.relationId
    const errKey = comp01Suggestion.targetEntityKey
    const errNode = ctx.errorsByKey.get(errKey)
    const errTag = errNode?.errorTag ?? errKey.replace(/^TaggedError:/, "")
    const callerEdge = (ctx.edgesByRelId.get(sigRelId) ?? []).find((e) => e.role === "caller")
    const callerKey =
      comp01Suggestion.sourceEntityKey ??
      callerEdge?.entityKey ??
      NodeKey.make(`EffectFn:${sigRelId.replace(/^EffectSignature:sig:/, "")}`)
    const callerNode = ctx.fnsByKey.get(callerKey)

    if (callerNode !== undefined) {
      const sigExists = ctx.sigRelationsById.has(sigRelId)
      const basePreserved: Array<NodeKey> = [callerKey, errKey]
      const baseRelations: Array<RelationNode> = []
      const baseEdges: Array<PlaysRoleEdge> = []

      if (sigExists) {
        basePreserved.push(NodeKey.make(sigRelId))
      } else {
        baseRelations.push(makeEffectSignatureNode(sigRelId, callerNode.qualname, callerNode.file))
        baseEdges.push(makePlaysRoleEdge(sigRelId, callerKey, "caller"))
      }

      const patch04a: DraftGraphPatch = {
        ruleId: RewriteRuleId.make("REP-04a"),
        phase: "REPAIR_ARCH",
        ruleCategory: "auto-repair",
        description: `Propagate TaggedError '${errTag}' in caller '${callerNode.spanName}' E-channel by attaching fails-with PlaysRoleEdge to EffectSignature '${sigRelId}' in K.`,
        primaryNodeKey: callerKey,
        preservedInterfaceKeys: basePreserved,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: [],
        insertedRelationNodes: baseRelations,
        insertedRoleEdges: [...baseEdges, makePlaysRoleEdge(sigRelId, errKey, "fails-with")],
      }

      // REP-04b: Catch and handle error at boundary via Effect.catchTag
      // Updates callerNode.caughtErrors and satisfies any COMP-01 spec expectation
      const updatedCaught = Array.from(new Set([...(callerNode.caughtErrors ?? []), errTag])).sort()
      const updatedCaller: EffectFnNode = {
        ...callerNode,
        caughtErrors: updatedCaught,
      }
      const updatedSpecsForBoundary: Array<EntityNode> = [updatedCaller]
      const preservedFor04b: Array<NodeKey> = [...basePreserved]
      for (const [specKey, specNode] of ctx.specsByKey.entries()) {
        if ((specNode.referencedErrors ?? []).includes(errTag)) {
          preservedFor04b.push(NodeKey.make(specKey))
          updatedSpecsForBoundary.push({
            ...specNode,
            referencedErrors: (specNode.referencedErrors ?? []).filter((e) => e !== errTag),
          })
        }
      }

      const patch04b: DraftGraphPatch = {
        ruleId: RewriteRuleId.make("REP-04b"),
        phase: "REPAIR_ARCH",
        ruleCategory: "auto-repair",
        description: `Catch and handle TaggedError '${errTag}' via Effect.catchTag at boundary '${callerNode.spanName}' while preserving EffectSignature '${sigRelId}' in K.`,
        primaryNodeKey: callerKey,
        preservedInterfaceKeys: preservedFor04b,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: updatedSpecsForBoundary,
        insertedRelationNodes: baseRelations,
        insertedRoleEdges: baseEdges,
      }

      return [[patch04a], [patch04b]]
    }
  }

  return []
}

// ============================================================================
// Phase 3: REPAIR_CODE DPO Candidate Generators (REP-05..10 + Completions)
// ============================================================================

const findPhase3CodeRepairPatches = (
  graph: HarnessGraph,
  inference: GraphInferenceResult,
): ReadonlyArray<DraftGraphPatch> => {
  const ctx = indexHarnessGraph(graph)

  // REP-05: untraced-decider
  for (const [fnKey, fnNode] of ctx.fnsByKey.entries()) {
    const isDeciderOrReducerCandidate =
      (fnNode.packageTag === "domain" || fnNode.packageTag === "contract") &&
      (isDeciderSpan(fnNode.qualname) ||
        isReducerSpan(fnNode.qualname) ||
        /(?:^|#|\.)(?:decide|evolve)/i.test(fnNode.qualname))
    const isUntracedDeciderNode =
      isDeciderOrReducerCandidate &&
      (fnNode.spanName === "untraced" || fnNode.spanName === "<untraced>")
    const matchesUntracedViolation = (v: BranchingViolation): boolean =>
      v.rule === "untraced-decider" &&
      (v.enclosingSymbol === fnNode.qualname || (isUntracedDeciderNode && v.file === fnNode.file))
    const hasUntracedViolation = (graph.branchingViolations ?? []).some(matchesUntracedViolation)

    if (hasUntracedViolation || isUntracedDeciderNode) {
      const symbolTail = fnNode.qualname.split("#").pop() ?? "Domain"
      const cleanScope = sanitizeIdentifier(symbolTail.replace(/^decide|^evolve/, "")) || "Domain"
      const canonicalSpan = isReducerSpan(fnNode.qualname)
        ? `${cleanScope}.evolve`
        : `${cleanScope}.decide`
      const sigRelId = ctx.sigIdByCallerKey.get(fnKey) ?? `EffectSignature:sig:${fnNode.qualname}`
      const sigExists = ctx.sigRelationsById.has(sigRelId)

      const preservedKeys: Array<NodeKey> = [NodeKey.make(fnKey)]
      const insertedRelations: Array<RelationNode> = []
      const insertedEdges: Array<PlaysRoleEdge> = []
      if (sigExists) {
        preservedKeys.push(NodeKey.make(sigRelId))
      } else {
        insertedRelations.push(makeEffectSignatureNode(sigRelId, fnNode.qualname, fnNode.file))
        insertedEdges.push(makePlaysRoleEdge(sigRelId, fnKey, "caller"))
      }

      return [
        {
          ruleId: RewriteRuleId.make("REP-05"),
          phase: "REPAIR_CODE",
          ruleCategory: "auto-repair",
          description: `Upgrade untraced decider '${fnNode.qualname}' to traced Effect.fn("${canonicalSpan}") while preserving EffectSignature '${sigRelId}' in K.`,
          primaryNodeKey: NodeKey.make(fnKey),
          preservedInterfaceKeys: preservedKeys,
          deletedEntityKeys: [],
          deletedRelationIds: [],
          deletedRoleEdges: [],
          insertedEntityNodes: [
            {
              ...fnNode,
              spanName: canonicalSpan,
            },
          ],
          insertedRelationNodes: insertedRelations,
          insertedRoleEdges: insertedEdges,
          clearViolationFilter: matchesUntracedViolation,
        },
      ]
    }
  }

  // REP-06: unbranded-contract-schema
  for (const [schemaKey, schemaNode] of ctx.schemasByKey.entries()) {
    const isUnbrandedContractNode =
      schemaNode.packageTag === "contract" && schemaNode.isBranded === false
    const matchesSchemaViolation = (v: BranchingViolation): boolean =>
      (v.rule === "unbranded-contract-schema" || v.rule === "unbranded-schema-field") &&
      (v.enclosingSymbol === schemaNode.qualname ||
        v.enclosingSymbol === schemaNode.schemaName ||
        v.enclosingSymbol.endsWith(`#${schemaNode.schemaName}`) ||
        (isUnbrandedContractNode && v.file === schemaNode.file))
    const hasUnbrandedViolation = (graph.branchingViolations ?? []).some(matchesSchemaViolation)
    if (isUnbrandedContractNode || hasUnbrandedViolation) {
      return [
        {
          ruleId: RewriteRuleId.make("REP-06"),
          phase: "REPAIR_CODE",
          ruleCategory: "auto-repair",
          description: `Brand contract SchemaDef '${schemaNode.schemaName}' via Schema.brand("${schemaNode.schemaName}") in K.`,
          primaryNodeKey: NodeKey.make(schemaKey),
          preservedInterfaceKeys: [NodeKey.make(schemaKey)],
          deletedEntityKeys: [],
          deletedRelationIds: [],
          deletedRoleEdges: [],
          insertedEntityNodes: [
            {
              ...schemaNode,
              isBranded: true,
            },
          ],
          insertedRelationNodes: [],
          insertedRoleEdges: [],
          clearViolationFilter: matchesSchemaViolation,
        },
      ]
    }
  }

  // REP-07: discriminant-branching / non-exhaustive-union-match
  const branchingViolation = (graph.branchingViolations ?? []).find(
    (v) => v.rule === "discriminant-branching" || v.rule === "non-exhaustive-union-match",
  )
  if (branchingViolation !== undefined) {
    const targetFn =
      findFnBySpanOrQualname(ctx, branchingViolation.enclosingSymbol) ??
      Array.from(ctx.fnsByKey.entries())
        .map(([key, node]) => ({ key, node }))
        .find((item) => item.node.file === branchingViolation.file)
    const primaryKey = NodeKey.make(
      targetFn?.key ?? `EffectFn:${branchingViolation.enclosingSymbol}`,
    )
    const preserved: Array<NodeKey> = targetFn !== undefined ? [primaryKey] : []
    return [
      {
        ruleId: RewriteRuleId.make("REP-07"),
        phase: "REPAIR_CODE",
        ruleCategory: "auto-repair",
        description: `Replace ad-hoc '${branchingViolation.rule}' in '${branchingViolation.enclosingSymbol}' with exhaustive ts-pattern match(...).exhaustive().`,
        primaryNodeKey: primaryKey,
        preservedInterfaceKeys: preserved,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: [],
        insertedRelationNodes: [],
        insertedRoleEdges: [],
        clearViolationFilter: (v) =>
          v.rule === branchingViolation.rule &&
          v.file === branchingViolation.file &&
          v.line === branchingViolation.line,
      },
    ]
  }

  // REP-08: unbranded-primitive-boundary / unsafe-type-cast
  const boundaryViolation = (graph.branchingViolations ?? []).find(
    (v) => v.rule === "unbranded-primitive-boundary" || v.rule === "unsafe-type-cast",
  )
  if (boundaryViolation !== undefined) {
    const targetFn =
      findFnBySpanOrQualname(ctx, boundaryViolation.enclosingSymbol) ??
      Array.from(ctx.fnsByKey.entries())
        .map(([key, node]) => ({ key, node }))
        .find((item) => item.node.file === boundaryViolation.file)
    const primaryKey = NodeKey.make(
      targetFn?.key ?? `EffectFn:${boundaryViolation.enclosingSymbol}`,
    )
    const errKey = "TaggedError:SchemaDecodeError"
    const insertedEntities: Array<EntityNode> = []
    const insertedRelations: Array<RelationNode> = []
    const insertedEdges: Array<PlaysRoleEdge> = []
    const preserved: Array<NodeKey> = []

    if (!ctx.errorsByKey.has(errKey)) {
      insertedEntities.push({
        _tag: "TaggedError",
        errorTag: "SchemaDecodeError",
        tag: "SchemaDecodeError",
        file: "libs/contract/src/errors.ts",
        line: 1,
      })
    } else {
      preserved.push(NodeKey.make(errKey))
    }

    if (targetFn !== undefined) {
      preserved.push(primaryKey)
      const sigRelId =
        ctx.sigIdByCallerKey.get(targetFn.key) ?? `EffectSignature:sig:${targetFn.node.qualname}`
      if (ctx.sigRelationsById.has(sigRelId)) {
        preserved.push(NodeKey.make(sigRelId))
      } else {
        insertedRelations.push(
          makeEffectSignatureNode(sigRelId, targetFn.node.qualname, targetFn.node.file),
        )
        insertedEdges.push(makePlaysRoleEdge(sigRelId, targetFn.key, "caller"))
      }
      insertedEdges.push(makePlaysRoleEdge(sigRelId, errKey, "fails-with"))
    }

    return [
      {
        ruleId: RewriteRuleId.make("REP-08"),
        phase: "REPAIR_CODE",
        ruleCategory: "auto-repair",
        description: `Replace raw brand construction / boundary violation in '${boundaryViolation.enclosingSymbol}' with Schema.decodeUnknownEffect error edge in EffectSignature in K.`,
        primaryNodeKey: primaryKey,
        preservedInterfaceKeys: preserved,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities,
        insertedRelationNodes: insertedRelations,
        insertedRoleEdges: insertedEdges,
        clearViolationFilter: (v) =>
          v.rule === boundaryViolation.rule &&
          v.file === boundaryViolation.file &&
          v.line === boundaryViolation.line,
      },
    ]
  }

  // REP-09: unmanaged-sql-ddl / invalid-migrator-record-key
  const ddlViolation = (graph.branchingViolations ?? []).find(
    (v) => v.rule === "unmanaged-sql-ddl" || v.rule === "invalid-migrator-record-key",
  )
  if (ddlViolation !== undefined) {
    const migRelId = "MigrationTuple:1_init_tables"
    const targetFn = Array.from(ctx.fnsByKey.entries())
      .map(([key, node]) => ({ key, node }))
      .find((item) => item.node.file === ddlViolation.file)
    const primaryKey = NodeKey.make(targetFn?.key ?? `EffectFn:${ddlViolation.enclosingSymbol}`)
    const insertedRelations: Array<RelationNode> = []
    const insertedEdges: Array<PlaysRoleEdge> = []
    const preserved: Array<NodeKey> = []

    if (!ctx.migrationRelationsById.has(migRelId)) {
      insertedRelations.push(makeMigrationTupleNode(migRelId, "1_init_tables", ddlViolation.file))
    } else {
      preserved.push(NodeKey.make(migRelId))
    }

    if (targetFn !== undefined) {
      preserved.push(primaryKey)
      insertedEdges.push(makePlaysRoleEdge(migRelId, targetFn.key, "migration-module"))
    }

    return [
      {
        ruleId: RewriteRuleId.make("REP-09"),
        phase: "REPAIR_CODE",
        ruleCategory: "auto-repair",
        description: `Wrap unmanaged SQL DDL in '${ddlViolation.file}' into numbered MigrationTuple '1_init_tables' under SqliteMigrator.fromRecord.`,
        primaryNodeKey: primaryKey,
        preservedInterfaceKeys: preserved,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: [],
        insertedRelationNodes: insertedRelations,
        insertedRoleEdges: insertedEdges,
        clearViolationFilter: (v) =>
          v.rule === ddlViolation.rule &&
          v.file === ddlViolation.file &&
          v.line === ddlViolation.line,
      },
    ]
  }

  // REP-10: unmapped-spec-symbol / stale-doc-reference
  const unmappedAp = inference.antiPatterns.find((ap) => ap.ruleId === "unmapped-spec-symbol")
  if (unmappedAp !== undefined) {
    const specKey = unmappedAp.nodeKey
    const specNode = ctx.specsByKey.get(specKey)
    const missingSymbol = unmappedAp.path[unmappedAp.path.length - 1] ?? "Synthesized.decide"
    if (specNode !== undefined) {
      const traceRelId =
        ctx.traceIdBySpecKey.get(specKey) ?? `TraceabilityTuple:trace:${specNode.id}`
      const traceExists = ctx.traceRelationsById.has(traceRelId)
      const preserved: Array<NodeKey> = [specKey]
      const insertedEntities: Array<EntityNode> = []
      const insertedRelations: Array<RelationNode> = []
      const insertedEdges: Array<PlaysRoleEdge> = []

      if (traceExists) {
        preserved.push(NodeKey.make(traceRelId))
      } else {
        insertedRelations.push(makeTraceabilityTupleNode(traceRelId, missingSymbol))
        insertedEdges.push(makePlaysRoleEdge(traceRelId, specKey, "specifying-ears"))
      }

      const isErr = (specNode.referencedErrors ?? []).includes(missingSymbol)
      const isSvc = (specNode.referencedServices ?? []).includes(missingSymbol)

      if (isErr) {
        const errKey = `TaggedError:${missingSymbol}`
        insertedEntities.push({
          _tag: "TaggedError",
          errorTag: missingSymbol,
          tag: missingSymbol,
          file: "libs/contract/src/errors.ts",
          line: 1,
        })
        insertedEdges.push(makePlaysRoleEdge(traceRelId, errKey, "realizing-symbol"))
      } else if (isSvc) {
        const svcKey = `ServiceTag:${missingSymbol}`
        insertedEntities.push({
          _tag: "ServiceTag",
          tagId: missingSymbol,
          name: missingSymbol,
          packageTag: "service",
          file: "libs/service/src/ports.ts",
          line: 1,
        })
        insertedEdges.push(makePlaysRoleEdge(traceRelId, svcKey, "realizing-symbol"))
      } else {
        // If there is a single existing EffectFn in the same scope whose span was renamed, rebind or create
        const cleanSym = sanitizeIdentifier(missingSymbol)
        const fnQual = `libs/domain/src/${cleanSym.toLowerCase()}.ts#${cleanSym}`
        const fnKey = `EffectFn:${fnQual}`
        const sigRelId = `EffectSignature:sig:${fnQual}`
        insertedEntities.push({
          _tag: "EffectFn",
          qualname: fnQual,
          spanName: missingSymbol,
          packageTag: "domain",
          file: `libs/domain/src/${cleanSym.toLowerCase()}.ts`,
          line: 1,
          isStub: true,
        })
        insertedRelations.push(
          makeEffectSignatureNode(sigRelId, fnQual, `libs/domain/src/${cleanSym.toLowerCase()}.ts`),
        )
        insertedEdges.push(
          makePlaysRoleEdge(sigRelId, fnKey, "caller"),
          makePlaysRoleEdge(traceRelId, fnKey, "realizing-symbol"),
        )
      }

      return [
        {
          ruleId: RewriteRuleId.make("REP-10"),
          phase: "REPAIR_CODE",
          ruleCategory: "auto-repair",
          description: `Resolve unmapped EARS symbol '${missingSymbol}' for '${specNode.id}' and bind via TraceabilityTuple '${traceRelId}' in K.`,
          primaryNodeKey: specKey,
          preservedInterfaceKeys: preserved,
          deletedEntityKeys: [],
          deletedRelationIds: [],
          deletedRoleEdges: [],
          insertedEntityNodes: insertedEntities,
          insertedRelationNodes: insertedRelations,
          insertedRoleEdges: insertedEdges,
        },
      ]
    }
  }

  // Also resolve remaining missing-layer-provider, untested-domain-span, or COMP-02..05 suggestedEdges
  const missingLayerAp = inference.antiPatterns.find((ap) => ap.ruleId === "missing-layer-provider")
  if (missingLayerAp !== undefined && missingLayerAp.targetKey !== undefined) {
    const svcKey = missingLayerAp.targetKey
    const svcNode = ctx.servicesByKey.get(svcKey)
    const rawSvcName = svcNode?.name ?? svcKey.replace(/^ServiceTag:/, "")
    const svcClean = sanitizeIdentifier(rawSvcName)
    const layerQual = `libs/infra/src/${svcClean.toLowerCase()}-live.ts#${svcClean}Live`
    const layerKey = `ServiceLayer:${layerQual}`
    const flowId = `LayerFlow:layer-flow:${layerQual}`

    const insertedEntities: Array<EntityNode> = []
    const insertedRelations: Array<RelationNode> = []
    const preserved: Array<NodeKey> = []
    if (ctx.servicesByKey.has(svcKey)) {
      preserved.push(svcKey)
    } else {
      insertedEntities.push({
        _tag: "ServiceTag",
        tagId: rawSvcName,
        name: rawSvcName,
        packageTag: "service",
        file: `libs/service/src/${svcClean.toLowerCase()}.ts`,
        line: 1,
      })
    }
    if (!ctx.layersByKey.has(layerKey)) {
      insertedEntities.push({
        _tag: "ServiceLayer",
        qualname: layerQual,
        layerKind: "live",
        packageTag: "infra",
        file: `libs/infra/src/${svcClean.toLowerCase()}-live.ts`,
        line: 1,
      })
    }
    if (!ctx.layerRelationsById.has(flowId)) {
      insertedRelations.push(
        makeLayerFlowNode(flowId, layerQual, `libs/infra/src/${svcClean.toLowerCase()}-live.ts`),
      )
    }

    return [
      {
        ruleId: RewriteRuleId.make("PLAN-04"),
        phase: "REPAIR_CODE",
        ruleCategory: "auto-repair",
        description: `Wire missing ServiceLayer provider '${layerQual}' and LayerFlow '${flowId}' for required service '${svcKey}'.`,
        primaryNodeKey: svcKey,
        preservedInterfaceKeys: preserved,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities,
        insertedRelationNodes: insertedRelations,
        insertedRoleEdges: [
          makePlaysRoleEdge(flowId, layerKey, "provider-layer"),
          makePlaysRoleEdge(flowId, svcKey, "provided-service"),
        ],
      },
    ]
  }

  const untestedAp = inference.antiPatterns.find(
    (ap) => ap.ruleId === "untested-domain-span" || ap.ruleId === "unverified-migration",
  )
  if (untestedAp !== undefined) {
    const targetKey = untestedAp.nodeKey
    const cleanTarget = sanitizeIdentifier(targetKey)
    const testId = `libs/domain/test/${cleanTarget.toLowerCase()}.test.ts#${cleanTarget} property test`
    const testKey = `VitestCase:${testId}`
    const insertedEntities: Array<EntityNode> = []
    const insertedRelations: Array<RelationNode> = []
    const insertedEdges: Array<PlaysRoleEdge> = []
    const preserved: Array<NodeKey> = []

    if (!ctx.testsByKey.has(testKey)) {
      insertedEntities.push(
        makeVitestCaseNode(
          testId,
          `libs/domain/test/${cleanTarget.toLowerCase()}.test.ts`,
          `${cleanTarget} property test`,
        ),
      )
    } else {
      preserved.push(NodeKey.make(testKey))
    }

    if (untestedAp.ruleId === "unverified-migration") {
      const migRelId = targetKey
      preserved.push(NodeKey.make(migRelId))
      insertedEdges.push(makePlaysRoleEdge(migRelId, testKey, "verifying-test"))
    } else {
      preserved.push(targetKey)
      const traceRelId =
        ctx.traceIdByTargetKey.get(targetKey) ?? `TraceabilityTuple:trace:${cleanTarget}`
      if (ctx.traceRelationsById.has(traceRelId)) {
        preserved.push(NodeKey.make(traceRelId))
      } else {
        insertedRelations.push(makeTraceabilityTupleNode(traceRelId, targetKey))
      }
      insertedEdges.push(
        makePlaysRoleEdge(traceRelId, targetKey, "exercised-span"),
        makePlaysRoleEdge(traceRelId, testKey, "verifying-test"),
      )
    }

    return [
      {
        ruleId: RewriteRuleId.make("PLAN-04"),
        phase: "REPAIR_CODE",
        ruleCategory: "auto-repair",
        description: `Attach verifying property test '${testId}' to '${targetKey}' via preserved relation in K.`,
        primaryNodeKey: targetKey,
        preservedInterfaceKeys: preserved,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities,
        insertedRelationNodes: insertedRelations,
        insertedRoleEdges: insertedEdges,
      },
    ]
  }

  // Remaining SuggestedEdge completions (COMP-02..05)
  const nextSuggestion = inference.suggestedEdges.find((s) => {
    if (s.ruleId === "COMP-02" && s.sourceEntityKey !== undefined) {
      const caller = ctx.fnsByKey.get(s.sourceEntityKey)
      const svc = ctx.servicesByKey.get(s.targetEntityKey)
      if (
        caller !== undefined &&
        (caller.packageTag === "domain" || caller.packageTag === "contract") &&
        svc !== undefined &&
        svc.packageTag === "infra"
      ) {
        return false
      }
    }
    return true
  })
  if (nextSuggestion !== undefined) {
    const relId = nextSuggestion.relationId
    const targetEntKey = nextSuggestion.targetEntityKey
    const preserved: Array<NodeKey> = [targetEntKey]
    const insertedEntities: Array<EntityNode> = []
    const insertedRelations: Array<RelationNode> = []
    const insertedEdges: Array<PlaysRoleEdge> = []

    const relExists =
      ctx.sigRelationsById.has(relId) ||
      ctx.layerRelationsById.has(relId) ||
      ctx.traceRelationsById.has(relId) ||
      ctx.migrationRelationsById.has(relId)

    if (relExists) {
      preserved.push(NodeKey.make(relId))
    } else {
      match(nextSuggestion.relationTag)
        .with("EffectSignature", () => {
          insertedRelations.push(
            makeEffectSignatureNode(relId, relId.replace(/^EffectSignature:sig:/, "")),
          )
          if (nextSuggestion.sourceEntityKey !== undefined) {
            preserved.push(nextSuggestion.sourceEntityKey)
            insertedEdges.push(makePlaysRoleEdge(relId, nextSuggestion.sourceEntityKey, "caller"))
          }
        })
        .with("LayerFlow", () => {
          const layerQual = `libs/infra/src/auto-layer.ts#${sanitizeIdentifier(relId)}Live`
          const layerKey = `ServiceLayer:${layerQual}`
          if (!ctx.layersByKey.has(layerKey)) {
            insertedEntities.push({
              _tag: "ServiceLayer",
              qualname: layerQual,
              layerKind: "live",
              packageTag: "infra",
              file: "libs/infra/src/auto-layer.ts",
              line: 1,
            })
          }
          insertedRelations.push(
            makeLayerFlowNode(relId, layerQual, "libs/infra/src/auto-layer.ts"),
          )
          insertedEdges.push(makePlaysRoleEdge(relId, layerKey, "provider-layer"))
        })
        .with("TraceabilityTuple", () => {
          insertedRelations.push(makeTraceabilityTupleNode(relId, targetEntKey))
          if (nextSuggestion.sourceEntityKey !== undefined) {
            preserved.push(nextSuggestion.sourceEntityKey)
            insertedEdges.push(
              makePlaysRoleEdge(relId, nextSuggestion.sourceEntityKey, "realizing-symbol"),
            )
          }
        })
        .with("HttpEndpointTuple", () => {
          insertedRelations.push(makeHttpEndpointTupleNode(relId))
        })
        .with("MigrationTuple", () => {
          insertedRelations.push(
            makeMigrationTupleNode(relId, "1_init_tables", "libs/infra/src/migrations.ts"),
          )
        })
        .exhaustive()
    }

    if (
      nextSuggestion.ruleId === "COMP-02" &&
      targetEntKey.startsWith("ServiceTag:") &&
      !hasLayerProviderForService(ctx, targetEntKey)
    ) {
      const svcClean = sanitizeIdentifier(targetEntKey.replace(/^ServiceTag:/, ""))
      const layerQual = `libs/infra/src/${svcClean.toLowerCase()}-live.ts#${svcClean}Live`
      const layerKey = `ServiceLayer:${layerQual}`
      const flowId = `LayerFlow:layer-flow:${layerQual}`
      if (!ctx.layersByKey.has(layerKey)) {
        insertedEntities.push({
          _tag: "ServiceLayer",
          qualname: layerQual,
          layerKind: "live",
          packageTag: "infra",
          file: `libs/infra/src/${svcClean.toLowerCase()}-live.ts`,
          line: 1,
        })
      }
      if (!ctx.layerRelationsById.has(flowId)) {
        insertedRelations.push(
          makeLayerFlowNode(flowId, layerQual, `libs/infra/src/${svcClean.toLowerCase()}-live.ts`),
        )
      }
      insertedEdges.push(
        makePlaysRoleEdge(flowId, layerKey, "provider-layer"),
        makePlaysRoleEdge(flowId, targetEntKey, "provided-service"),
      )
    }

    insertedEdges.push(makePlaysRoleEdge(relId, targetEntKey, nextSuggestion.role))

    return [
      {
        ruleId: RewriteRuleId.make("REP-10"),
        phase: "REPAIR_CODE",
        ruleCategory: "auto-repair",
        description: `Complete SuggestedEdge (${nextSuggestion.ruleId}) by attaching '${nextSuggestion.role}' -> '${targetEntKey}' on '${relId}'.`,
        primaryNodeKey: targetEntKey,
        preservedInterfaceKeys: preserved,
        deletedEntityKeys: [],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities,
        insertedRelationNodes: insertedRelations,
        insertedRoleEdges: insertedEdges,
      },
    ]
  }

  return []
}

// ============================================================================
// Phase 4: CLEANUP DPO Candidate Generator (REP-11 with NAC_spec)
// ============================================================================

const findPhase4CleanupPatches = (graph: HarnessGraph): ReadonlyArray<DraftGraphPatch> => {
  const ctx = indexHarnessGraph(graph)

  // Collect all services referenced by any EarsSpec or AdrDoc or active stub
  const specProtectedServiceNames = new Set<string>()
  for (const [, node] of Graph.nodes(graph.graph)) {
    match(node)
      .with({ _tag: "EarsSpec" }, { _tag: "AdrDoc" }, (n) => {
        for (const svc of n.referencedServices ?? []) {
          specProtectedServiceNames.add(svc)
          specProtectedServiceNames.add(`ServiceTag:${svc}`)
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
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }

  const hasActiveStubInWorkspace = Array.from(ctx.fnsByKey.values()).some(
    (fn) => fn.isStub === true,
  )

  const sortedServices = Array.from(ctx.servicesByKey.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )

  for (const [svcKey, svcNode] of sortedServices) {
    const incidentEdges = ctx.incidentEdgesByEntityKey.get(svcKey) ?? []
    if (incidentEdges.length > 0) {
      continue
    }

    // Check NAC_spec: never prune a service referenced by an EarsSpec, AdrDoc, or while active stubs exist in the same package scope
    if (
      specProtectedServiceNames.has(svcKey) ||
      specProtectedServiceNames.has(svcNode.tagId) ||
      specProtectedServiceNames.has(svcNode.name)
    ) {
      continue
    }

    const svcScopePrefix = svcNode.file.split("/").slice(0, 2).join("/")
    const sameScopeStubExists =
      hasActiveStubInWorkspace &&
      svcNode.packageTag !== "infra" &&
      Array.from(ctx.fnsByKey.values()).some(
        (fn) => fn.isStub === true && fn.file.split("/").slice(0, 2).join("/") === svcScopePrefix,
      )
    if (sameScopeStubExists) {
      continue
    }

    return [
      {
        ruleId: RewriteRuleId.make("REP-11"),
        phase: "CLEANUP",
        ruleCategory: "cleanup",
        description: `Prune orphan ServiceTag '${svcNode.name}' (${svcKey}) satisfying NAC_spec (zero incident role edges and unreferenced by EARS/ADR/stubs).`,
        primaryNodeKey: NodeKey.make(svcKey),
        preservedInterfaceKeys: [],
        deletedEntityKeys: [NodeKey.make(svcKey)],
        deletedRelationIds: [],
        deletedRoleEdges: [],
        insertedEntityNodes: [],
        insertedRelationNodes: [],
        insertedRoleEdges: [],
      },
    ]
  }

  return []
}

const getPhasesForMode = (mode: RewriteMode): ReadonlyArray<RewritePhase> =>
  match(mode)
    .with("auto-plan", () => ["PLAN"] as const)
    .with("auto-repair", () => ["REPAIR_ARCH", "REPAIR_CODE"] as const)
    .with("cleanup", () => ["CLEANUP"] as const)
    .with("full", () => ["PLAN", "REPAIR_ARCH", "REPAIR_CODE", "CLEANUP"] as const)
    .exhaustive()

const scoreDraftPatch = (
  patch: DraftGraphPatch,
  graph: HarnessGraph,
  candidatePriors?: DpoCandidatePriors,
): SystemOneScoreMillis => {
  const directPrior = candidatePriors?.[formatDpoPriorKey(patch.primaryNodeKey, patch.ruleId)]
  if (directPrior !== undefined) {
    return directPrior
  }
  const ruleOnlyPrior = candidatePriors?.[patch.ruleId]
  if (ruleOnlyPrior !== undefined) {
    return ruleOnlyPrior
  }

  const nodeIdx = graph.nodeIndexByKey.get(patch.primaryNodeKey)
  const rawNode = nodeIdx !== undefined ? Graph.getNode(graph.graph, nodeIdx) : Option.none()
  const isBoundaryCaller = match(rawNode)
    .with({ _tag: "Some" }, ({ value }) =>
      match(value)
        .with(
          { _tag: "EffectFn" },
          (fn) =>
            fn.packageTag === "infra" ||
            fn.packageTag === "app" ||
            isBoundaryCallerQualname(fn.qualname),
        )
        .with(
          { _tag: "ServiceTag" },
          { _tag: "ServiceLayer" },
          { _tag: "TaggedError" },
          { _tag: "SchemaDef" },
          { _tag: "VitestCase" },
          { _tag: "PatternDoc" },
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
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

export interface DecideGraphRewriteOptions {
  readonly maxPhaseSteps?: number
}

const mapInferenceErrorToRewriteError = (
  err: GraphInferenceError | ConceptLatticeCycleError,
  ruleId?: RewriteRuleId,
  nodeKey?: NodeKey,
): GraphRewriteError =>
  match(err)
    .with(
      { _tag: "ConceptLatticeCycleError" },
      (cycleErr) =>
        new GraphRewriteError({
          ...(ruleId !== undefined ? { ruleId } : {}),
          ...(nodeKey !== undefined ? { nodeKey } : {}),
          reason: "concept-lattice-cycle",
          message: `[ConceptLatticeCycleError:${cycleErr.reason}] ${cycleErr.message}`,
        }),
    )
    .with(
      { _tag: "GraphInferenceError" },
      (infErr) =>
        new GraphRewriteError({
          ...(ruleId !== undefined ? { ruleId } : {}),
          ...(nodeKey !== undefined ? { nodeKey } : {}),
          reason: infErr.reason === "invalid-graph" ? "invalid-graph" : "inference-failed",
          message: `[GraphInferenceError:${infErr.reason}] ${infErr.message}`,
        }),
    )
    .exhaustive()

/**
 * Pure Double-Pushout (DPO) Algebraic Graph Rewriting Decider (`GraphRewrite.decide`, `R = never`).
 */
export const decideGraphRewrite = Effect.fn("GraphRewrite.decide")(function* (
  graph: HarnessGraph,
  mode: RewriteMode,
  candidatePriors?: DpoCandidatePriors,
  options?: DecideGraphRewriteOptions,
): Effect.fn.Return<GraphRewriteOutcome, GraphRewriteError, never> {
  const initialInference = yield* decideGraphInference(graph).pipe(
    Effect.mapError((err) => mapInferenceErrorToRewriteError(err)),
  )
  const initialMeasure = computeGraphMeasure(graph, initialInference)
  const activePhases = getPhasesForMode(mode)

  let currentGraph = graph
  let currentInference: GraphInferenceResult = initialInference
  let currentMeasure = initialMeasure
  const appliedPatches: Array<GraphPatch> = []
  const alternativeCandidates: Array<RewriteCandidate> = []
  let branchWinnerScore: SystemOneScoreMillis | undefined
  const maxSteps =
    options?.maxPhaseSteps !== undefined && options.maxPhaseSteps >= 1
      ? Math.floor(options.maxPhaseSteps)
      : Math.max(64, Graph.nodeCount(graph.graph) * 4)

  for (const phase of activePhases) {
    let phaseSteps = 0
    let converged = false
    while (phaseSteps < maxSteps && !converged) {
      yield* match(phase)
        .with("PLAN", () =>
          Effect.gen(function* () {
            const planDrafts = findPhase1PlanPatches(currentGraph, currentInference)
            const draft = planDrafts[0]
            if (draft === undefined) {
              converged = true
              return
            }
            phaseSteps += 1
            const nextGraph = yield* applyDpoPatchToGraph(currentGraph, draft)
            const nextInference = yield* decideGraphInference(nextGraph).pipe(
              Effect.mapError((err) =>
                mapInferenceErrorToRewriteError(err, draft.ruleId, draft.primaryNodeKey),
              ),
            )
            const nextMeasure = computeGraphMeasure(nextGraph, nextInference)
            if (
              nextMeasure.archViolations > currentMeasure.archViolations ||
              nextMeasure.codeHygieneViolations > currentMeasure.codeHygieneViolations
            ) {
              return yield* new GraphRewriteError({
                ruleId: draft.ruleId,
                nodeKey: draft.primaryNodeKey,
                reason: "non-decreasing-measure",
                message: `Planning rule ${draft.ruleId} introduced new architectural or code hygiene violations.`,
              })
            }
            const { clearViolationFilter: _ignored, ...cleanDraft } = draft
            appliedPatches.push({
              ...cleanDraft,
              beforeMeasure: currentMeasure,
              afterMeasure: nextMeasure,
            })
            currentGraph = nextGraph
            currentInference = nextInference
            currentMeasure = nextMeasure
          }),
        )
        .with("REPAIR_ARCH", () =>
          Effect.gen(function* () {
            const branches = findPhase2ArchRepairBranches(currentGraph, currentInference)
            if (branches.length === 0) {
              converged = true
              return
            }
            phaseSteps += 1

            // Evaluate all competing branches (e.g. REP-04a vs REP-04b)
            const evaluatedBranches: Array<{
              readonly draft: DraftGraphPatch
              readonly nextGraph: HarnessGraph
              readonly nextInference: GraphInferenceResult
              readonly nextMeasure: GraphMeasure
              readonly scoreMillis: SystemOneScoreMillis
            }> = []

            for (const branch of branches) {
              const draft = branch[0]
              if (draft === undefined) {
                continue
              }
              const nextGraph = yield* applyDpoPatchToGraph(currentGraph, draft)
              const nextInference = yield* decideGraphInference(nextGraph).pipe(
                Effect.mapError((err) =>
                  mapInferenceErrorToRewriteError(err, draft.ruleId, draft.primaryNodeKey),
                ),
              )
              const nextMeasure = computeGraphMeasure(nextGraph, nextInference)
              if (!isStrictlyDecreasingMeasure(currentMeasure, nextMeasure)) {
                if (branches.length > 1) {
                  continue
                }
                return yield* new GraphRewriteError({
                  ruleId: draft.ruleId,
                  nodeKey: draft.primaryNodeKey,
                  reason: "non-decreasing-measure",
                  message: `Rule ${draft.ruleId} failed to strictly decrease measure mu(G) in N^6.`,
                })
              }
              const scoreMillis = scoreDraftPatch(draft, currentGraph, candidatePriors)
              evaluatedBranches.push({
                draft,
                nextGraph,
                nextInference,
                nextMeasure,
                scoreMillis,
              })
            }

            if (evaluatedBranches.length === 0) {
              const fallbackDraft = branches[0]?.[0]
              return yield* new GraphRewriteError({
                ...(fallbackDraft !== undefined
                  ? { ruleId: fallbackDraft.ruleId, nodeKey: fallbackDraft.primaryNodeKey }
                  : {}),
                reason: "non-decreasing-measure",
                message:
                  "No competing architectural repair branch strictly decreased measure mu(G) in N^6.",
              })
            }

            evaluatedBranches.sort((a, b) => {
              if (isStrictlyDecreasingMeasure(a.nextMeasure, b.nextMeasure)) return 1
              if (isStrictlyDecreasingMeasure(b.nextMeasure, a.nextMeasure)) return -1
              if (a.scoreMillis !== b.scoreMillis) return b.scoreMillis - a.scoreMillis
              return a.draft.ruleId.localeCompare(b.draft.ruleId)
            })

            const winner = evaluatedBranches[0]!
            if (evaluatedBranches.length > 1 || branchWinnerScore === undefined) {
              branchWinnerScore = winner.scoreMillis
            }
            for (let idx = 1; idx < evaluatedBranches.length; idx++) {
              const alt = evaluatedBranches[idx]!
              const { clearViolationFilter: _ignoredAlt, ...cleanAltDraft } = alt.draft
              const altPatch: GraphPatch = {
                ...cleanAltDraft,
                beforeMeasure: currentMeasure,
                afterMeasure: alt.nextMeasure,
              }
              alternativeCandidates.push({
                rank: CandidateRank.make(alternativeCandidates.length + 2),
                rationale: `${alt.draft.description} (System One tie-breaker: ${alt.scoreMillis}/1000)`,
                patches: [...appliedPatches, altPatch],
                finalMeasure: alt.nextMeasure,
                systemOneTieBreaker: alt.scoreMillis,
                isPolicyClean: isZeroMeasure(alt.nextMeasure),
              })
            }

            const { clearViolationFilter: _ignoredWin, ...cleanWinnerDraft } = winner.draft
            appliedPatches.push({
              ...cleanWinnerDraft,
              beforeMeasure: currentMeasure,
              afterMeasure: winner.nextMeasure,
            })
            currentGraph = winner.nextGraph
            currentInference = winner.nextInference
            currentMeasure = winner.nextMeasure
          }),
        )
        .with("REPAIR_CODE", () =>
          Effect.gen(function* () {
            const codeDrafts = findPhase3CodeRepairPatches(currentGraph, currentInference)
            const draft = codeDrafts[0]
            if (draft === undefined) {
              converged = true
              return
            }
            phaseSteps += 1
            const nextGraph = yield* applyDpoPatchToGraph(currentGraph, draft)
            const nextInference = yield* decideGraphInference(nextGraph).pipe(
              Effect.mapError((err) =>
                mapInferenceErrorToRewriteError(err, draft.ruleId, draft.primaryNodeKey),
              ),
            )
            const nextMeasure = computeGraphMeasure(nextGraph, nextInference)
            if (!isStrictlyDecreasingMeasure(currentMeasure, nextMeasure)) {
              return yield* new GraphRewriteError({
                ruleId: draft.ruleId,
                nodeKey: draft.primaryNodeKey,
                reason: "non-decreasing-measure",
                message: `Rule ${draft.ruleId} failed to strictly decrease measure mu(G) in N^6.`,
              })
            }
            const { clearViolationFilter: _ignored, ...cleanDraft } = draft
            appliedPatches.push({
              ...cleanDraft,
              beforeMeasure: currentMeasure,
              afterMeasure: nextMeasure,
            })
            currentGraph = nextGraph
            currentInference = nextInference
            currentMeasure = nextMeasure
          }),
        )
        .with("CLEANUP", () =>
          Effect.gen(function* () {
            const cleanupDrafts = findPhase4CleanupPatches(currentGraph)
            const draft = cleanupDrafts[0]
            if (draft === undefined) {
              converged = true
              return
            }
            phaseSteps += 1
            const nextGraph = yield* applyDpoPatchToGraph(currentGraph, draft)
            const nextInference = yield* decideGraphInference(nextGraph).pipe(
              Effect.mapError((err) =>
                mapInferenceErrorToRewriteError(err, draft.ruleId, draft.primaryNodeKey),
              ),
            )
            const nextMeasure = computeGraphMeasure(nextGraph, nextInference)
            if (
              !isStrictlyDecreasingMeasure(currentMeasure, nextMeasure) &&
              !isEqualMeasure(currentMeasure, nextMeasure)
            ) {
              return yield* new GraphRewriteError({
                ruleId: draft.ruleId,
                nodeKey: draft.primaryNodeKey,
                reason: "non-decreasing-measure",
                message: `Cleanup rule ${draft.ruleId} increased measure mu(G) in N^6.`,
              })
            }
            const { clearViolationFilter: _ignored, ...cleanDraft } = draft
            appliedPatches.push({
              ...cleanDraft,
              beforeMeasure: currentMeasure,
              afterMeasure: nextMeasure,
            })
            currentGraph = nextGraph
            currentInference = nextInference
            currentMeasure = nextMeasure
          }),
        )
        .exhaustive()
    }
    if (!converged) {
      const remainingAtBound = match(phase)
        .with("PLAN", () => findPhase1PlanPatches(currentGraph, currentInference).length)
        .with(
          "REPAIR_ARCH",
          () => findPhase2ArchRepairBranches(currentGraph, currentInference).length,
        )
        .with(
          "REPAIR_CODE",
          () => findPhase3CodeRepairPatches(currentGraph, currentInference).length,
        )
        .with("CLEANUP", () => findPhase4CleanupPatches(currentGraph).length)
        .exhaustive()
      if (remainingAtBound > 0) {
        return yield* new GraphRewriteError({
          reason: "step-bound-exceeded",
          message: `Phase '${phase}' exceeded maximum step bound (${maxSteps}) without reaching a normal form.`,
        })
      }
    }
  }

  if (appliedPatches.length === 0) {
    const emptyResult: GraphRewriteResult = {
      mode,
      initialMeasure,
      recommendedCandidate: Option.none(),
      alternativeCandidates: [],
    }
    return {
      result: emptyResult,
      targetGraph: currentGraph,
    }
  }

  const firstPatch = appliedPatches[0]!
  const primaryScore = branchWinnerScore ?? scoreDraftPatch(firstPatch, graph, candidatePriors)

  const recommended: RewriteCandidate = {
    rank: CandidateRank.make(1),
    rationale: `Applied ${appliedPatches.length} DPO rewrite step(s) (${appliedPatches.map((p) => p.ruleId).join(" -> ")}) reaching measure (${currentMeasure.archViolations}, ${currentMeasure.unmappedSpecSymbols}, ${currentMeasure.codeHygieneViolations}, ${currentMeasure.missingLayerProviders}, ${currentMeasure.untestedDomainSpans}, ${currentMeasure.unresolvedSuggestedEdges}).`,
    patches: appliedPatches,
    finalMeasure: currentMeasure,
    systemOneTieBreaker: primaryScore,
    isPolicyClean: isZeroMeasure(currentMeasure),
  }

  return {
    result: {
      mode,
      initialMeasure,
      recommendedCandidate: Option.some(recommended),
      alternativeCandidates,
    },
    targetGraph: currentGraph,
  }
})
