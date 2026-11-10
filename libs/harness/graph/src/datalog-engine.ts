import {
  D2,
  MessageType,
  MultiSet,
  antiJoin,
  concat,
  consolidate,
  distinct,
  filter,
  innerJoin,
  iterate,
  map,
  output,
  reduce,
  type KeyValue,
  type Message,
} from "@electric-sql/d2ts"
import { Context, Effect, Layer, Semaphore } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { HARNESS_PERA_CONCEPT_LATTICE_CONFIG, decideConceptLattice } from "./concept-lattice.js"
import {
  type AdrDocNode,
  ConfidenceMillis,
  type DatalogFileDeltaResult,
  type DatalogFilePath,
  type DatalogRule,
  DatalogRuleId,
  type DerivationProof,
  type EarsSpecNode,
  type EffectFnNode,
  type EffectiveErrorPropagation,
  type EffectiveLayerDependency,
  type EffectiveServiceRequirement,
  type EffectiveTestReachability,
  GraphInferenceError,
  type GraphInferenceResult,
  type HarnessEdge,
  type HarnessGraph,
  HarnessGraphTypeId,
  type HarnessNode,
  type InhabitingSymbolCandidate,
  type InferredAntiPattern,
  type MigrationTupleRelation,
  type MinHeightProvenanceAnnotation,
  NodeKey,
  NonNegativeCount,
  PageRankScoreMillis,
  ProofHeight,
  ProofId,
  RelationId,
  RoleName,
  type SchemaDefNode,
  type SemanticEdgePriors,
  type ServiceLayerNode,
  type ServiceTagNode,
  StratumIndex,
  type SuggestedEdge,
  type TaggedErrorNode,
  type TypedHoleContextBundle,
  type VitestCaseNode,
  getEdgeKey,
  getNodeKey,
  isEntityNode,
  isRelationNode,
} from "./model.js"
import {
  isAggregateFnNode,
  isCloudBinding,
  isDeciderSpan,
  isEventBusServiceNode,
  isOutboxDrainOrBusPublishFnNode,
  isReducerSpan,
} from "./policy-check.js"

/**
 * Soufflé-style min-height provenance semiring reducer over `@electric-sql/d2ts` (`RFC-0002 §4.3`).
 * Retains only the minimal-height derivation witness for each derived tuple, netting Z-set
 * multiplicities and guaranteeing fixed-point convergence in at most `|V_E|` steps even on cyclic call graphs.
 */
export const minHeightReducer = (
  values: ReadonlyArray<readonly [MinHeightProvenanceAnnotation, number]>,
): Array<[MinHeightProvenanceAnnotation, number]> => {
  const netMap = new Map<string, { item: MinHeightProvenanceAnnotation; net: number }>()
  for (const [v, mult] of values) {
    const key = `${v.proofHeight}:${v.ruleId}:${v.witnessRelationId ?? ""}:${v.viaIntermediateKey ?? ""}`
    const existing = netMap.get(key)
    const nextNet = (existing?.net ?? 0) + mult
    if (nextNet === 0) {
      netMap.delete(key)
    } else {
      netMap.set(key, { item: v, net: nextNet })
    }
  }
  const positive: Array<MinHeightProvenanceAnnotation> = []
  for (const entry of netMap.values()) {
    if (entry.net > 0) {
      positive.push(entry.item)
    }
  }
  if (positive.length === 0) {
    return []
  }
  positive.sort((a, b) =>
    a.proofHeight !== b.proofHeight
      ? a.proofHeight - b.proofHeight
      : `${a.ruleId}:${a.viaIntermediateKey ?? ""}:${a.witnessRelationId ?? ""}`.localeCompare(
          `${b.ruleId}:${b.viaIntermediateKey ?? ""}:${b.witnessRelationId ?? ""}`,
        ),
  )
  const first = positive[0]
  return first !== undefined ? [[first, 1]] : []
}

/**
 * Flix-style bounded join-semilattice element for normative edge-completion confidence (`RFC-0002 §4.4`).
 */
export interface FlixConfidenceLatticeElement {
  readonly confidenceMillis: ConfidenceMillis
  readonly parentProofIds: ReadonlyArray<ProofId>
}

/**
 * Flix-style lattice join reducer over `@electric-sql/d2ts` (`RFC-0002 §4.4`):
 * `(c1, P1) ⊔ (c2, P2) = (max(c1, c2), dedupSort(P1 ∪ P2))`, with net Z-set multiplicities.
 */
export const flixConfidenceReducer = (
  values: ReadonlyArray<readonly [FlixConfidenceLatticeElement, number]>,
): Array<[FlixConfidenceLatticeElement, number]> => {
  const netMap = new Map<string, { item: FlixConfidenceLatticeElement; net: number }>()
  for (const [v, mult] of values) {
    const key = `${v.confidenceMillis}:${v.parentProofIds.join(",")}`
    const existing = netMap.get(key)
    const nextNet = (existing?.net ?? 0) + mult
    if (nextNet === 0) {
      netMap.delete(key)
    } else {
      netMap.set(key, { item: v, net: nextNet })
    }
  }
  const positive: Array<FlixConfidenceLatticeElement> = []
  for (const entry of netMap.values()) {
    if (entry.net > 0) {
      positive.push(entry.item)
    }
  }
  if (positive.length === 0) {
    return []
  }
  let maxConfidence = 0
  const mergedProofs = new Set<string>()
  for (const item of positive) {
    if (item.confidenceMillis > maxConfidence) {
      maxConfidence = item.confidenceMillis
    }
    for (const pid of item.parentProofIds) {
      mergedProofs.add(pid)
    }
  }
  return [
    [
      {
        confidenceMillis: ConfidenceMillis.make(maxConfidence),
        parentProofIds: Array.from(mergedProofs)
          .sort()
          .map((id) => ProofId.make(id)),
      },
      1,
    ],
  ]
}

/**
 * Canonical 4-stratum Datalog & Edge Completion rules (`RFC-0002` / `harness:SPEC-0007`).
 */
export const STANDARD_DATALOG_RULES: ReadonlyArray<DatalogRule> = [
  // Stratum S_1: Recursive positive closures (.iterate())
  {
    id: DatalogRuleId.make("INF-01"),
    stratum: 1,
    headPredicate: "EffectiveRequires",
    description:
      "Transitive service requirements propagated across EffectSignature caller -> callee chains.",
    hasNegation: false,
    isRecursive: true,
  },
  {
    id: DatalogRuleId.make("INF-02"),
    stratum: 1,
    headPredicate: "EffectiveFailsWith",
    description:
      "Transitive tagged error propagation across EffectSignature caller -> callee chains.",
    hasNegation: false,
    isRecursive: true,
  },
  {
    id: DatalogRuleId.make("INF-03"),
    stratum: 1,
    headPredicate: "LayerDependsOn",
    description: "Transitive Layer dependency closure and VitestCase -> EffectFn reachability.",
    hasNegation: false,
    isRecursive: true,
  },

  // Stratum S_2: Stratified negation antipatterns (.antiJoin())
  {
    id: DatalogRuleId.make("INF-04"),
    stratum: 2,
    headPredicate: "InferredAntiPattern(domain-requires-infra)",
    description:
      "Domain EffectFn transitively requires an infrastructure ServiceTag or cloud binding.",
    hasNegation: false,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("INF-05"),
    stratum: 2,
    headPredicate: "InferredAntiPattern(impure-decider)",
    description:
      "Pure .decide or .evolve function transitively requires a stateful ServiceTag (R != never).",
    hasNegation: false,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("INF-06"),
    stratum: 2,
    headPredicate: "InferredAntiPattern(layer-cycle|missing-layer-provider)",
    description:
      "ServiceLayer dependency cycle or required ServiceTag without any providing LayerFlow.",
    hasNegation: true,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("INF-07"),
    stratum: 2,
    headPredicate: "InferredAntiPattern(unmapped-spec-symbol)",
    description:
      "EarsSpec or AdrDoc references a span, service, or error absent from the workspace hypergraph.",
    hasNegation: true,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("INF-08"),
    stratum: 2,
    headPredicate: "InferredAntiPattern(aggregate-direct-bus-publish)",
    description:
      "Domain aggregate or decider directly requires an EventBus / MessageBroker without Outbox.",
    hasNegation: true,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("INF-09"),
    stratum: 2,
    headPredicate: "InferredAntiPattern(untested-domain-span)",
    description:
      "Non-stub domain EffectFn or destructive MigrationTuple has zero transitive VitestCase reachability.",
    hasNegation: true,
    isRecursive: false,
  },

  // Stratum S_3: Normative missing-edge completions & Hazel typed hole inhabitation (COMP-01..06)
  {
    id: DatalogRuleId.make("COMP-01"),
    stratum: 3,
    headPredicate: "SuggestedEdge(fails-with)",
    description:
      "Suggest missing fails-with PlaysRoleEdge on EffectSignature from specifying EarsSpec errors.",
    hasNegation: true,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("COMP-02"),
    stratum: 3,
    headPredicate: "SuggestedEdge(requires-service)",
    description:
      "Suggest missing requires-service PlaysRoleEdge on EffectSignature from specifying EarsSpec services.",
    hasNegation: true,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("COMP-03"),
    stratum: 3,
    headPredicate: "SuggestedEdge(provided-service)",
    description:
      "Suggest missing LayerFlow provider edge for an unprovided ServiceTag required by EffectSignature.",
    hasNegation: true,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("COMP-04"),
    stratum: 3,
    headPredicate: "SuggestedEdge(verifying-test)",
    description:
      "Suggest missing verifying-test PlaysRoleEdge on TraceabilityTuple for untested EffectFn.",
    hasNegation: true,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("COMP-05"),
    stratum: 3,
    headPredicate: "SuggestedEdge(governing-adr)",
    description:
      "Suggest missing governing-adr PlaysRoleEdge on TraceabilityTuple for symbols in AdrDoc.enforcedByFiles.",
    hasNegation: true,
    isRecursive: false,
  },
  {
    id: DatalogRuleId.make("COMP-06"),
    stratum: 3,
    headPredicate: "SuggestedHoleInhabitant(TypedHoleContextBundle)",
    description:
      "Compute type-compatible inhabitants and 10-iteration Personalized PageRank (alpha = 0.85) ego-graph context bundles for Hazel typed holes (EffectFn with isStub: true).",
    hasNegation: false,
    isRecursive: false,
  },
]

const makeOutputCollector = <T>(target: Array<T>): ((msg: Message<T>) => void) => {
  const accumulated = new Map<string, { item: T; net: number }>()

  const syncTarget = () => {
    target.length = 0
    for (const entry of accumulated.values()) {
      for (let i = 0; i < entry.net; i++) {
        target.push(entry.item)
      }
    }
  }

  return (msg: Message<T>) => {
    match(msg)
      .with({ type: MessageType.DATA }, ({ data }) => {
        for (const [item, multiplicity] of data.collection.getInner()) {
          const key = JSON.stringify(item)
          const existing = accumulated.get(key)
          const newNet = (existing?.net ?? 0) + multiplicity
          if (newNet <= 0) {
            accumulated.delete(key)
          } else {
            accumulated.set(key, { item, net: newNet })
          }
        }
        syncTarget()
      })
      .with({ type: MessageType.FRONTIER }, () => undefined)
      .exhaustive()
  }
}

const isDomainFn = (fnNode: EffectFnNode): boolean =>
  match(fnNode.packageTag)
    .with("domain", () => true)
    .with("contract", "service", "infra", "app", "unknown", () => false)
    .exhaustive()

const isDomainOrContractFn = (fnNode: EffectFnNode): boolean =>
  match(fnNode.packageTag)
    .with("domain", "contract", () => true)
    .with("service", "infra", "app", "unknown", () => false)
    .exhaustive()

const isInfraService = (svcNode: ServiceTagNode): boolean =>
  match(svcNode.packageTag)
    .with("infra", () => true)
    .with("contract", "domain", "service", "app", "unknown", undefined, () => false)
    .exhaustive()

const isAcceptedAdr = (adrNode: AdrDocNode): boolean =>
  match(adrNode.status)
    .with("accepted", () => true)
    .with("proposed", "superseded", "deprecated", () => false)
    .exhaustive()

const isProposedOrAcceptedSpec = (specNode: EarsSpecNode): boolean =>
  match(specNode.status)
    .with("proposed", "accepted", () => true)
    .with("superseded", "deprecated", () => false)
    .exhaustive()

const reconstructCallWitnessPath = (
  callerKey: string,
  calleeKey: string,
  provenanceByPair: ReadonlyMap<string, MinHeightProvenanceAnnotation>,
  visited: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  if (callerKey === calleeKey) {
    return [callerKey]
  }
  const pairKey = `${callerKey}->${calleeKey}`
  const ann = provenanceByPair.get(pairKey)
  if (ann === undefined || ann.proofHeight <= 1 || ann.viaIntermediateKey == null) {
    return [callerKey, calleeKey]
  }
  const midKey = ann.viaIntermediateKey
  if (midKey === callerKey || midKey === calleeKey || visited.has(pairKey)) {
    return [callerKey, calleeKey]
  }
  const nextVisited = new Set(visited)
  nextVisited.add(pairKey)
  const left = reconstructCallWitnessPath(callerKey, midKey, provenanceByPair, nextVisited)
  const right = reconstructCallWitnessPath(midKey, calleeKey, provenanceByPair, nextVisited)
  return [...left.slice(0, -1), ...right]
}

const findShortestLayerCycle = (
  startLayerKey: string,
  directLayerEdges: ReadonlyMap<string, ReadonlyArray<string>>,
  layerQualnameByKey: ReadonlyMap<string, string>,
): ReadonlyArray<string> => {
  const startQual = layerQualnameByKey.get(startLayerKey) ?? startLayerKey
  const visited = new Set<string>()
  const queue: Array<ReadonlyArray<string>> = [[startLayerKey]]
  while (queue.length > 0) {
    const currentPath = queue.shift()
    if (currentPath === undefined) {
      break
    }
    const last = currentPath[currentPath.length - 1]
    if (last === undefined) {
      continue
    }
    const nexts = directLayerEdges.get(last) ?? []
    for (const nextKey of nexts) {
      if (nextKey === startLayerKey) {
        return [...currentPath, startLayerKey].map((k) => layerQualnameByKey.get(k) ?? k)
      }
      if (!visited.has(nextKey)) {
        visited.add(nextKey)
        queue.push([...currentPath, nextKey])
      }
    }
  }
  return [startQual, startQual]
}

/**
 * Pure 4-stratum Differential Dataflow / Stratified Datalog decider (`GraphInfer.decide`, `R = never`).
 */
export const decideGraphInference = Effect.fn("GraphInfer.decide")(function* (
  harnessGraph: HarnessGraph,
  priors?: SemanticEdgePriors,
) {
  yield* decideConceptLattice(HARNESS_PERA_CONCEPT_LATTICE_CONFIG)

  return yield* Effect.try({
    try: () => {
      // ======================================================================
      // Stratum S_0: Extract Extensional Database (EDB) facts from Levi Hypergraph
      // ======================================================================
      const fnsByKey = new Map<string, EffectFnNode>()
      const servicesByKey = new Map<string, ServiceTagNode>()
      const layersByKey = new Map<string, ServiceLayerNode>()
      const errorsByKey = new Map<string, TaggedErrorNode>()
      const schemasByKey = new Map<string, SchemaDefNode>()
      const testsByKey = new Map<string, VitestCaseNode>()
      const adrsByKey = new Map<string, AdrDocNode>()
      const specsByKey = new Map<string, EarsSpecNode>()
      const migrationsById = new Map<string, MigrationTupleRelation>()
      const allEntityKeys = new Set<string>()

      const fnQualnameByKey = new Map<string, string>()
      const svcTagIdByKey = new Map<string, string>()
      const layerQualnameByKey = new Map<string, string>()
      const errTagByKey = new Map<string, string>()

      // Relation role maps: relationId -> role -> Set<entityKey>
      const sigRoles = new Map<string, Map<string, Set<string>>>()
      const sigIdByCallerKey = new Map<string, string>()
      const layerFlowRoles = new Map<string, Map<string, Set<string>>>()
      const traceRoles = new Map<string, Map<string, Set<string>>>()
      const migrationRoles = new Map<string, Map<string, Set<string>>>()
      const httpRoles = new Map<string, Map<string, Set<string>>>()

      for (const [, node] of Graph.nodes(harnessGraph.graph)) {
        const key = getNodeKey(node)
        match(node)
          .with({ _tag: "EffectFn" }, (n) => {
            fnsByKey.set(key, n)
            fnQualnameByKey.set(key, n.qualname)
            allEntityKeys.add(key)
          })
          .with({ _tag: "ServiceTag" }, (n) => {
            servicesByKey.set(key, n)
            svcTagIdByKey.set(key, n.tagId)
            allEntityKeys.add(key)
          })
          .with({ _tag: "ServiceLayer" }, (n) => {
            layersByKey.set(key, n)
            layerQualnameByKey.set(key, n.qualname)
            allEntityKeys.add(key)
          })
          .with({ _tag: "TaggedError" }, (n) => {
            errorsByKey.set(key, n)
            errTagByKey.set(key, n.errorTag)
            allEntityKeys.add(key)
          })
          .with({ _tag: "SchemaDef" }, (n) => {
            schemasByKey.set(key, n)
            allEntityKeys.add(key)
          })
          .with({ _tag: "VitestCase" }, (n) => {
            testsByKey.set(key, n)
            allEntityKeys.add(key)
          })
          .with({ _tag: "AdrDoc" }, (n) => {
            adrsByKey.set(key, n)
            allEntityKeys.add(key)
          })
          .with({ _tag: "EarsSpec" }, (n) => {
            specsByKey.set(key, n)
            allEntityKeys.add(key)
          })
          .with({ _tag: "PatternDoc" }, () => {
            allEntityKeys.add(key)
          })
          .with({ _tag: "EffectSignature" }, (n) => {
            if (!sigRoles.has(n.relationId)) {
              sigRoles.set(n.relationId, new Map())
            }
          })
          .with({ _tag: "LayerFlow" }, (n) => {
            if (!layerFlowRoles.has(n.relationId)) {
              layerFlowRoles.set(n.relationId, new Map())
            }
          })
          .with({ _tag: "TraceabilityTuple" }, (n) => {
            if (!traceRoles.has(n.relationId)) {
              traceRoles.set(n.relationId, new Map())
            }
          })
          .with({ _tag: "MigrationTuple" }, (n) => {
            migrationsById.set(n.relationId, n)
            if (!migrationRoles.has(n.relationId)) {
              migrationRoles.set(n.relationId, new Map())
            }
          })
          .with({ _tag: "HttpEndpointTuple" }, (n) => {
            if (!httpRoles.has(n.relationId)) {
              httpRoles.set(n.relationId, new Map())
            }
          })
          .exhaustive()
      }

      for (const [, edge] of Graph.edges(harnessGraph.graph)) {
        const { relationId, entityKey, role } = edge.data
        const targetMap = sigRoles.has(relationId)
          ? sigRoles.get(relationId)
          : layerFlowRoles.has(relationId)
            ? layerFlowRoles.get(relationId)
            : traceRoles.has(relationId)
              ? traceRoles.get(relationId)
              : migrationRoles.has(relationId)
                ? migrationRoles.get(relationId)
                : httpRoles.has(relationId)
                  ? httpRoles.get(relationId)
                  : undefined
        if (targetMap !== undefined) {
          let set = targetMap.get(role)
          if (set === undefined) {
            set = new Set<string>()
            targetMap.set(role, set)
          }
          set.add(entityKey)
        }
      }

      // Direct EDB tuples
      const directCallPairs: Array<[string, string]> = []
      const directCallRelIdByPair = new Map<string, string>()
      const directOutgoingCalls = new Map<string, Array<string>>()
      const directReqPairs: Array<[string, string]> = []
      const directFailPairs: Array<[string, string]> = []

      for (const [relId, roles] of sigRoles.entries()) {
        const callers = Array.from(roles.get("caller") ?? []).sort()
        const callees = Array.from(roles.get("callee") ?? []).sort()
        const reqSvcs = Array.from(roles.get("requires-service") ?? []).sort()
        const failErrs = Array.from(roles.get("fails-with") ?? []).sort()

        for (const callerKey of callers) {
          sigIdByCallerKey.set(callerKey, relId)
          for (const calleeKey of callees) {
            directCallPairs.push([callerKey, calleeKey])
            directCallRelIdByPair.set(`${callerKey}->${calleeKey}`, relId)
            const list = directOutgoingCalls.get(callerKey) ?? []
            if (!list.includes(calleeKey)) {
              list.push(calleeKey)
              list.sort()
              directOutgoingCalls.set(callerKey, list)
            }
          }
          for (const svcKey of reqSvcs) {
            directReqPairs.push([callerKey, svcKey])
          }
          for (const errKey of failErrs) {
            const callerNode = fnsByKey.get(callerKey)
            const errTag = errTagByKey.get(errKey) ?? errKey.replace(/^TaggedError:/, "")
            if (
              callerNode?.caughtErrors?.includes(errTag) ||
              callerNode?.caughtErrors?.includes(errKey)
            ) {
              continue
            }
            directFailPairs.push([callerKey, errKey])
          }
        }
      }

      const directLayerProvidesPairs: Array<[string, string]> = []
      const directLayerRequiresPairs: Array<[string, string]> = []
      for (const [, roles] of layerFlowRoles.entries()) {
        const layers = Array.from(roles.get("provider-layer") ?? []).sort()
        const providedSvcs = Array.from(roles.get("provided-service") ?? []).sort()
        const requiredSvcs = Array.from(roles.get("required-service") ?? []).sort()
        for (const layerKey of layers) {
          for (const svcKey of providedSvcs) {
            directLayerProvidesPairs.push([layerKey, svcKey])
          }
          for (const svcKey of requiredSvcs) {
            directLayerRequiresPairs.push([layerKey, svcKey])
          }
        }
      }

      const directTestSpanPairs: Array<[string, string]> = []
      const traceIdByTargetKey = new Map<string, string>()
      const existingTraceGoverningAdrs = new Set<string>()
      const existingSpecToTargetPairs: Array<[string, string]> = []
      for (const [relId, roles] of traceRoles.entries()) {
        const tests = Array.from(
          new Set([
            ...(roles.get("verifying-test") ?? []),
            ...(roles.get("exercising-test") ?? []),
          ]),
        ).sort()
        const targets = Array.from(
          new Set([
            ...(roles.get("realizing-symbol") ?? []),
            ...(roles.get("exercised-span") ?? []),
            ...(roles.get("specified-target") ?? []),
          ]),
        ).sort()
        const specs = Array.from(roles.get("specifying-ears") ?? []).sort()
        const adrs = Array.from(roles.get("governing-adr") ?? []).sort()
        for (const targetKey of targets) {
          traceIdByTargetKey.set(targetKey, relId)
          for (const testKey of tests) {
            directTestSpanPairs.push([testKey, targetKey])
          }
          for (const specKey of specs) {
            existingSpecToTargetPairs.push([specKey, targetKey])
          }
          for (const adrKey of adrs) {
            existingTraceGoverningAdrs.add(`${adrKey}->${targetKey}`)
          }
        }
      }

      // ======================================================================
      // Build @electric-sql/d2ts Dataflow Graph across Strata S_0 -> S_1 -> S_2 -> S_3
      // ======================================================================
      const d2 = new D2({ initialFrontier: 0 })

      // S_0 Inputs
      const inDirectCalls = d2.newInput<KeyValue<string, MinHeightProvenanceAnnotation>>()
      const inDirectRequires = d2.newInput<KeyValue<string, string>>()
      const inDirectFails = d2.newInput<KeyValue<string, string>>()
      const inLayerProvides = d2.newInput<KeyValue<string, string>>() // key: svcKey, val: providerLayerKey
      const inLayerRequires = d2.newInput<KeyValue<string, string>>() // key: reqSvcKey, val: consumerLayerKey
      const inDirectTestSpans = d2.newInput<KeyValue<string, string>>() // key: targetSpanKey, val: testKey
      const inDomainNonStubFns = d2.newInput<KeyValue<string, string>>() // key: fnKey, val: fnKey
      const inDestructiveMigrations = d2.newInput<KeyValue<string, string>>() // key: migrationRelId, val: migrationRelId
      const inMigrationVerifyingTests = d2.newInput<KeyValue<string, string>>() // key: migrationRelId, val: testKey
      const inSpecExpectedErrors = d2.newInput<KeyValue<string, [string, string, string]>>() // key: `${callerKey}->${errKey}`, val: [specKey, callerKey, errKey]
      const inSpecExpectedServices = d2.newInput<KeyValue<string, [string, string, string]>>() // key: `${callerKey}->${svcKey}`, val: [specKey, callerKey, svcKey]
      const inAdrExpectedTargets = d2.newInput<KeyValue<string, [string, string]>>() // key: `${adrKey}->${targetKey}`, val: [adrKey, targetKey]
      const inExistingTraceAdrs = d2.newInput<KeyValue<string, string>>() // key: `${adrKey}->${targetKey}`, val: adrKey

      // Inputs for INF-04, INF-05, INF-07, INF-08
      const inDomainFns = d2.newInput<KeyValue<string, string>>()
      const inInfraServices = d2.newInput<KeyValue<string, string>>()
      const inCloudBindingServices = d2.newInput<KeyValue<string, string>>()
      const inDeciderFns = d2.newInput<KeyValue<string, string>>()
      const inReducerFns = d2.newInput<KeyValue<string, string>>()
      const inAggregateFns = d2.newInput<KeyValue<string, string>>()
      const inEventBusServices = d2.newInput<KeyValue<string, string>>()
      const inOutboxOrBusPublishFns = d2.newInput<KeyValue<string, string>>()
      const inSpecDeclaredSpans = d2.newInput<KeyValue<string, [string, string]>>()
      const inKnownSpans = d2.newInput<KeyValue<string, string>>()
      const inSpecDeclaredServices = d2.newInput<KeyValue<string, [string, string]>>()
      const inKnownServices = d2.newInput<KeyValue<string, string>>()
      const inSpecDeclaredErrors = d2.newInput<KeyValue<string, [string, string]>>()
      const inKnownErrors = d2.newInput<KeyValue<string, string>>()

      // ----------------------------------------------------------------------
      // Stratum S_1: Recursive Positive Closures (.iterate() + reduce(minHeightReducer))
      // ----------------------------------------------------------------------
      // 1. Transitive Call Reachability with Soufflé Min-Height Provenance Semiring
      const maxGraphDepth = Math.max(1, fnsByKey.size + 1)
      const callReachProvenanceStream = inDirectCalls.pipe(
        iterate((reach) => {
          const byCallee = reach.pipe(
            map(([pairKey, ann]): KeyValue<string, readonly [string, number]> => {
              const [callerKey = "", calleeKey = ""] = pairKey.split("->")
              return [calleeKey, [callerKey, ann.proofHeight] as const]
            }),
          )
          const byCaller = reach.pipe(
            map(([pairKey, ann]): KeyValue<string, readonly [string, number]> => {
              const [callerKey = "", calleeKey = ""] = pairKey.split("->")
              return [callerKey, [calleeKey, ann.proofHeight] as const]
            }),
          )
          const stepped = byCallee.pipe(
            innerJoin(byCaller),
            map(
              ([midKey, [[callerKey, h1], [calleeKey, h2]]]): KeyValue<
                string,
                MinHeightProvenanceAnnotation
              > => [
                `${callerKey}->${calleeKey}`,
                {
                  proofHeight: ProofHeight.make(Math.min(maxGraphDepth, h1 + h2)),
                  ruleId: DatalogRuleId.make("INF-01"),
                  viaIntermediateKey: NodeKey.make(midKey),
                },
              ],
            ),
          )
          return reach.pipe(concat(stepped), reduce(minHeightReducer), consolidate())
        }),
        consolidate(),
      )

      const collectedCallReachProvenance: Array<KeyValue<string, MinHeightProvenanceAnnotation>> =
        []
      callReachProvenanceStream.pipe(output(makeOutputCollector(collectedCallReachProvenance)))

      const callReachStream = callReachProvenanceStream.pipe(
        map(([pairKey]): KeyValue<string, [string, string]> => {
          const [callerKey = "", calleeKey = ""] = pairKey.split("->")
          return [pairKey, [callerKey, calleeKey]]
        }),
        consolidate(),
      )

      const collectedCallReach: Array<KeyValue<string, [string, string]>> = []
      callReachStream.pipe(output(makeOutputCollector(collectedCallReach)))

      // INF-01: EffectiveRequires(callerKey, svcKey) = DirectRequires U (CallReach join DirectRequires)
      const callReachByCallee = callReachStream.pipe(
        map(([_pairKey, [callerKey, calleeKey]]): KeyValue<string, string> => [
          calleeKey,
          callerKey,
        ]),
      )
      const transitiveRequiresStream = callReachByCallee.pipe(
        innerJoin(inDirectRequires),
        map(([_calleeKey, [callerKey, svcKey]]): KeyValue<string, [string, string]> => [
          `${callerKey}->${svcKey}`,
          [callerKey, svcKey],
        ]),
      )
      const directRequiresKeyed = inDirectRequires.pipe(
        map(([callerKey, svcKey]): KeyValue<string, [string, string]> => [
          `${callerKey}->${svcKey}`,
          [callerKey, svcKey],
        ]),
      )
      const effectiveRequiresStream = directRequiresKeyed.pipe(
        concat(transitiveRequiresStream),
        distinct(),
        consolidate(),
      )
      const collectedEffectiveRequires: Array<KeyValue<string, [string, string]>> = []
      effectiveRequiresStream.pipe(output(makeOutputCollector(collectedEffectiveRequires)))

      // INF-02: EffectiveFailsWith(callerKey, errKey) = DirectFails U (CallReach join DirectFails)
      const transitiveFailsStream = callReachByCallee.pipe(
        innerJoin(inDirectFails),
        filter(([_calleeKey, [callerKey, errKey]]) => {
          const callerNode = fnsByKey.get(callerKey)
          if (callerNode?.caughtErrors === undefined || callerNode.caughtErrors.length === 0) {
            return true
          }
          const errTag = errTagByKey.get(errKey) ?? errKey.replace(/^TaggedError:/, "")
          return (
            !callerNode.caughtErrors.includes(errTag) && !callerNode.caughtErrors.includes(errKey)
          )
        }),
        map(([_calleeKey, [callerKey, errKey]]): KeyValue<string, [string, string]> => [
          `${callerKey}->${errKey}`,
          [callerKey, errKey],
        ]),
      )
      const directFailsKeyed = inDirectFails.pipe(
        map(([callerKey, errKey]): KeyValue<string, [string, string]> => [
          `${callerKey}->${errKey}`,
          [callerKey, errKey],
        ]),
      )
      const effectiveFailsStream = directFailsKeyed.pipe(
        concat(transitiveFailsStream),
        distinct(),
        consolidate(),
      )
      const collectedEffectiveFails: Array<KeyValue<string, [string, string]>> = []
      effectiveFailsStream.pipe(output(makeOutputCollector(collectedEffectiveFails)))

      // INF-03a: LayerDependency(consumerLayerKey, providerLayerKey) via .iterate()
      const directLayerDepPairsStream = inLayerRequires.pipe(
        innerJoin(inLayerProvides),
        map(
          ([_svcKey, [consumerLayerKey, providerLayerKey]]): KeyValue<string, [string, string]> => [
            `${consumerLayerKey}->${providerLayerKey}`,
            [consumerLayerKey, providerLayerKey],
          ],
        ),
        distinct(),
      )
      const layerReachStream = directLayerDepPairsStream.pipe(
        iterate((reach) => {
          const byTarget = reach.pipe(
            map(([_pairKey, [srcLayer, dstLayer]]): KeyValue<string, string> => [
              dstLayer,
              srcLayer,
            ]),
          )
          const bySource = reach.pipe(
            map(([_pairKey, [srcLayer, dstLayer]]): KeyValue<string, string> => [
              srcLayer,
              dstLayer,
            ]),
          )
          const stepped = byTarget.pipe(
            innerJoin(bySource),
            map(([_midLayer, [srcLayer, dstLayer]]): KeyValue<string, [string, string]> => [
              `${srcLayer}->${dstLayer}`,
              [srcLayer, dstLayer],
            ]),
          )
          return reach.pipe(concat(stepped), distinct())
        }),
        consolidate(),
      )
      const collectedLayerReach: Array<KeyValue<string, [string, string]>> = []
      layerReachStream.pipe(output(makeOutputCollector(collectedLayerReach)))

      // INF-03b: EffectiveTestReach(testKey, targetSpanKey) = DirectTestSpans U (DirectTestSpans join CallReach)
      const callReachByCaller = callReachStream.pipe(
        map(([_pairKey, [callerKey, calleeKey]]): KeyValue<string, string> => [
          callerKey,
          calleeKey,
        ]),
      )
      const transitiveTestReachStream = inDirectTestSpans.pipe(
        innerJoin(callReachByCaller),
        map(([_entrySpanKey, [testKey, targetSpanKey]]): KeyValue<string, [string, string]> => [
          `${testKey}->${targetSpanKey}`,
          [testKey, targetSpanKey],
        ]),
      )
      const directTestReachKeyed = inDirectTestSpans.pipe(
        map(([targetSpanKey, testKey]): KeyValue<string, [string, string]> => [
          `${testKey}->${targetSpanKey}`,
          [testKey, targetSpanKey],
        ]),
      )
      const effectiveTestReachStream = directTestReachKeyed.pipe(
        concat(transitiveTestReachStream),
        distinct(),
        consolidate(),
      )
      const collectedEffectiveTestReach: Array<KeyValue<string, [string, string]>> = []
      effectiveTestReachStream.pipe(output(makeOutputCollector(collectedEffectiveTestReach)))

      // ----------------------------------------------------------------------
      // Stratum S_2: Stratified Negation Antipatterns (.antiJoin() & filters)
      // ----------------------------------------------------------------------
      // INF-04a: domain-requires-infra (inDomainFns join effectiveRequires join inInfraServices)
      const effReqByCaller = effectiveRequiresStream.pipe(
        map(([_pairKey, [callerKey, svcKey]]): KeyValue<string, [string, string]> => [
          callerKey,
          [callerKey, svcKey],
        ]),
      )
      const domainEffReq = effReqByCaller.pipe(
        innerJoin(inDomainFns),
        map(([_callerKey, [[callerKey, svcKey]]]): KeyValue<string, [string, string]> => [
          svcKey,
          [callerKey, svcKey],
        ]),
      )
      const domainRequiresInfraStream = domainEffReq.pipe(
        innerJoin(inInfraServices),
        map(([_svcKey, [[callerKey, svcKey]]]): KeyValue<string, [string, string]> => [
          `${callerKey}->${svcKey}`,
          [callerKey, svcKey],
        ]),
        distinct(),
        consolidate(),
      )
      const collectedDomainRequiresInfra: Array<KeyValue<string, [string, string]>> = []
      domainRequiresInfraStream.pipe(output(makeOutputCollector(collectedDomainRequiresInfra)))

      // INF-04b: domain-requires-cloud-binding (inDomainFns join effectiveRequires join inCloudBindingServices)
      const domainRequiresCloudBindingStream = domainEffReq.pipe(
        innerJoin(inCloudBindingServices),
        map(([_svcKey, [[callerKey, svcKey]]]): KeyValue<string, [string, string]> => [
          `${callerKey}->${svcKey}`,
          [callerKey, svcKey],
        ]),
        distinct(),
        consolidate(),
      )
      const collectedDomainRequiresCloudBinding: Array<KeyValue<string, [string, string]>> = []
      domainRequiresCloudBindingStream.pipe(
        output(makeOutputCollector(collectedDomainRequiresCloudBinding)),
      )

      // INF-05a: impure-decider (effectiveRequires join inDeciderFns)
      const impureDeciderStream = effReqByCaller.pipe(
        innerJoin(inDeciderFns),
        map(([_callerKey, [[callerKey, svcKey]]]): KeyValue<string, [string, string]> => [
          `${callerKey}->${svcKey}`,
          [callerKey, svcKey],
        ]),
        distinct(),
        consolidate(),
      )
      const collectedImpureDeciders: Array<KeyValue<string, [string, string]>> = []
      impureDeciderStream.pipe(output(makeOutputCollector(collectedImpureDeciders)))

      // INF-05b: impure-reducer (requires service: effectiveRequires join inReducerFns)
      const impureReducerSvcStream = effReqByCaller.pipe(
        innerJoin(inReducerFns),
        map(([_callerKey, [[callerKey, svcKey]]]): KeyValue<string, [string, string]> => [
          `${callerKey}->${svcKey}`,
          [callerKey, svcKey],
        ]),
        distinct(),
        consolidate(),
      )
      const collectedImpureReducerSvcs: Array<KeyValue<string, [string, string]>> = []
      impureReducerSvcStream.pipe(output(makeOutputCollector(collectedImpureReducerSvcs)))

      // INF-05c: impure-reducer (fails with error: effectiveFails join inReducerFns)
      const effFailsByCaller = effectiveFailsStream.pipe(
        map(([_pairKey, [callerKey, errKey]]): KeyValue<string, [string, string]> => [
          callerKey,
          [callerKey, errKey],
        ]),
      )
      const impureReducerErrStream = effFailsByCaller.pipe(
        innerJoin(inReducerFns),
        map(([_callerKey, [[callerKey, errKey]]]): KeyValue<string, [string, string]> => [
          `${callerKey}->${errKey}`,
          [callerKey, errKey],
        ]),
        distinct(),
        consolidate(),
      )
      const collectedImpureReducerErrs: Array<KeyValue<string, [string, string]>> = []
      impureReducerErrStream.pipe(output(makeOutputCollector(collectedImpureReducerErrs)))

      // INF-06a: Layer cycles (srcLayer === dstLayer in LayerReach)
      const layerCyclesStream = layerReachStream.pipe(
        filter(([_pairKey, [srcLayer, dstLayer]]) => srcLayer === dstLayer),
        consolidate(),
      )
      const collectedLayerCycles: Array<KeyValue<string, [string, string]>> = []
      layerCyclesStream.pipe(output(makeOutputCollector(collectedLayerCycles)))

      // INF-06b: Missing layer provider (LayerRequires antiJoin LayerProvides)
      const missingLayerProvidersStream = inLayerRequires.pipe(
        antiJoin(inLayerProvides),
        consolidate(),
      )
      const collectedMissingLayerProviders: Array<KeyValue<string, [string, null]>> = []
      missingLayerProvidersStream.pipe(output(makeOutputCollector(collectedMissingLayerProviders)))

      // INF-07a: unmapped spec spans (inSpecDeclaredSpans antiJoin inKnownSpans)
      const unmappedSpecSpansStream = inSpecDeclaredSpans.pipe(
        antiJoin(inKnownSpans),
        consolidate(),
      )
      const collectedUnmappedSpecSpans: Array<KeyValue<string, [[string, string], null]>> = []
      unmappedSpecSpansStream.pipe(output(makeOutputCollector(collectedUnmappedSpecSpans)))

      // INF-07b: unmapped spec services (inSpecDeclaredServices antiJoin inKnownServices)
      const unmappedSpecServicesStream = inSpecDeclaredServices.pipe(
        antiJoin(inKnownServices),
        consolidate(),
      )
      const collectedUnmappedSpecServices: Array<KeyValue<string, [[string, string], null]>> = []
      unmappedSpecServicesStream.pipe(output(makeOutputCollector(collectedUnmappedSpecServices)))

      // INF-07c: unmapped spec errors (inSpecDeclaredErrors antiJoin inKnownErrors)
      const unmappedSpecErrorsStream = inSpecDeclaredErrors.pipe(
        antiJoin(inKnownErrors),
        consolidate(),
      )
      const collectedUnmappedSpecErrors: Array<KeyValue<string, [[string, string], null]>> = []
      unmappedSpecErrorsStream.pipe(output(makeOutputCollector(collectedUnmappedSpecErrors)))

      // INF-08a: aggregate-direct-bus-publish (inAggregateFns join effectiveRequires join inEventBusServices)
      const aggregateBusSvcStream = effReqByCaller.pipe(
        innerJoin(inAggregateFns),
        map(([_callerKey, [[callerKey, svcKey]]]): KeyValue<string, [string, string]> => [
          svcKey,
          [callerKey, svcKey],
        ]),
        innerJoin(inEventBusServices),
        map(([_svcKey, [[callerKey, svcKey]]]): KeyValue<string, [string, string]> => [
          `${callerKey}->${svcKey}`,
          [callerKey, svcKey],
        ]),
        distinct(),
        consolidate(),
      )
      const collectedAggregateBusSvcs: Array<KeyValue<string, [string, string]>> = []
      aggregateBusSvcStream.pipe(output(makeOutputCollector(collectedAggregateBusSvcs)))

      // INF-08b: aggregate-direct-bus-publish (calls Outbox.drain or EventBus.publish)
      const callReachByCallerKey = callReachStream.pipe(
        map(([_pairKey, [callerKey, calleeKey]]): KeyValue<string, [string, string]> => [
          callerKey,
          [callerKey, calleeKey],
        ]),
      )
      const aggregateBusCallStream = callReachByCallerKey.pipe(
        innerJoin(inAggregateFns),
        map(([_callerKey, [[callerKey, calleeKey]]]): KeyValue<string, [string, string]> => [
          calleeKey,
          [callerKey, calleeKey],
        ]),
        innerJoin(inOutboxOrBusPublishFns),
        map(([_calleeKey, [[callerKey, calleeKey]]]): KeyValue<string, [string, string]> => [
          `${callerKey}->${calleeKey}`,
          [callerKey, calleeKey],
        ]),
        distinct(),
        consolidate(),
      )
      const collectedAggregateBusCalls: Array<KeyValue<string, [string, string]>> = []
      aggregateBusCallStream.pipe(output(makeOutputCollector(collectedAggregateBusCalls)))

      // INF-09a: Untested domain spans (DomainNonStubFns antiJoin EffectiveTestReach-by-span)
      const coveredSpansStream = effectiveTestReachStream.pipe(
        map(([_pairKey, [testKey, targetSpanKey]]): KeyValue<string, string> => [
          targetSpanKey,
          testKey,
        ]),
        distinct(),
      )
      const untestedDomainSpansStream = inDomainNonStubFns.pipe(
        antiJoin(coveredSpansStream),
        consolidate(),
      )
      const collectedUntestedDomainSpans: Array<KeyValue<string, [string, null]>> = []
      untestedDomainSpansStream.pipe(output(makeOutputCollector(collectedUntestedDomainSpans)))

      // INF-09b: Unverified destructive migrations (DestructiveMigrations antiJoin MigrationVerifyingTests)
      const unverifiedMigrationsStream = inDestructiveMigrations.pipe(
        antiJoin(inMigrationVerifyingTests),
        consolidate(),
      )
      const collectedUnverifiedMigrations: Array<KeyValue<string, [string, null]>> = []
      unverifiedMigrationsStream.pipe(output(makeOutputCollector(collectedUnverifiedMigrations)))

      // ----------------------------------------------------------------------
      // Stratum S_3: Normative Missing-Edge Completions (COMP-01..05 via .antiJoin())
      // ----------------------------------------------------------------------
      // COMP-01: Spec expected error on caller antiJoin DirectFailsKeyed
      const comp01Stream = inSpecExpectedErrors.pipe(antiJoin(directFailsKeyed), consolidate())
      const collectedComp01: Array<KeyValue<string, [[string, string, string], null]>> = []
      comp01Stream.pipe(output(makeOutputCollector(collectedComp01)))

      // COMP-02: Spec expected service on caller antiJoin DirectRequiresKeyed
      const comp02Stream = inSpecExpectedServices.pipe(antiJoin(directRequiresKeyed), consolidate())
      const collectedComp02: Array<KeyValue<string, [[string, string, string], null]>> = []
      comp02Stream.pipe(output(makeOutputCollector(collectedComp02)))

      // COMP-03: Required service by EffectSignature antiJoin LayerProvides
      const fnRequiredBySvcKey = inDirectRequires.pipe(
        map(([callerKey, svcKey]): KeyValue<string, string> => [svcKey, callerKey]),
        distinct(),
      )
      const comp03Stream = fnRequiredBySvcKey.pipe(antiJoin(inLayerProvides), consolidate())
      const collectedComp03: Array<KeyValue<string, [string, null]>> = []
      comp03Stream.pipe(output(makeOutputCollector(collectedComp03)))

      // COMP-05: AdrExpectedTargets antiJoin ExistingTraceAdrs
      const comp05Stream = inAdrExpectedTargets.pipe(antiJoin(inExistingTraceAdrs), consolidate())
      const collectedComp05: Array<KeyValue<string, [[string, string], null]>> = []
      comp05Stream.pipe(output(makeOutputCollector(collectedComp05)))

      d2.finalize()

      // ======================================================================
      // Feed Stratum S_0 EDB MultiSets into D2 and execute to fixed point
      // ======================================================================
      inDirectCalls.sendData(
        0,
        new MultiSet(
          directCallPairs.map(([callerKey, calleeKey]) => {
            const pairKey = `${callerKey}->${calleeKey}`
            const relId = directCallRelIdByPair.get(pairKey)
            return [
              [
                pairKey,
                {
                  proofHeight: ProofHeight.make(1),
                  ruleId: DatalogRuleId.make("INF-01"),
                  ...(relId !== undefined ? { witnessRelationId: RelationId.make(relId) } : {}),
                  viaIntermediateKey: NodeKey.make(calleeKey),
                },
              ],
              1,
            ]
          }),
        ),
      )
      inDirectCalls.sendFrontier(1)

      inDirectRequires.sendData(
        0,
        new MultiSet(directReqPairs.map(([callerKey, svcKey]) => [[callerKey, svcKey], 1])),
      )
      inDirectRequires.sendFrontier(1)

      inDirectFails.sendData(
        0,
        new MultiSet(directFailPairs.map(([callerKey, errKey]) => [[callerKey, errKey], 1])),
      )
      inDirectFails.sendFrontier(1)

      inLayerProvides.sendData(
        0,
        new MultiSet(directLayerProvidesPairs.map(([layerKey, svcKey]) => [[svcKey, layerKey], 1])),
      )
      inLayerProvides.sendFrontier(1)

      inLayerRequires.sendData(
        0,
        new MultiSet(directLayerRequiresPairs.map(([layerKey, svcKey]) => [[svcKey, layerKey], 1])),
      )
      inLayerRequires.sendFrontier(1)

      inDirectTestSpans.sendData(
        0,
        new MultiSet(directTestSpanPairs.map(([testKey, targetKey]) => [[targetKey, testKey], 1])),
      )
      inDirectTestSpans.sendFrontier(1)

      const domainNonStubEntries: Array<[KeyValue<string, string>, number]> = []
      const domainFnEntries: Array<[KeyValue<string, string>, number]> = []
      const deciderFnEntries: Array<[KeyValue<string, string>, number]> = []
      const reducerFnEntries: Array<[KeyValue<string, string>, number]> = []
      const aggregateFnEntries: Array<[KeyValue<string, string>, number]> = []
      const outboxDrainEntries: Array<[KeyValue<string, string>, number]> = []

      for (const [fnKey, fnNode] of fnsByKey.entries()) {
        if (isDomainOrContractFn(fnNode) && !fnNode.isStub) {
          domainNonStubEntries.push([[fnKey, fnKey], 1])
        }
        if (isDomainFn(fnNode)) {
          domainFnEntries.push([[fnKey, fnKey], 1])
        }
        if (isDomainOrContractFn(fnNode) && isDeciderSpan(fnNode.spanName)) {
          deciderFnEntries.push([[fnKey, fnKey], 1])
        }
        if (isDomainOrContractFn(fnNode) && isReducerSpan(fnNode.spanName)) {
          reducerFnEntries.push([[fnKey, fnKey], 1])
        }
        if (isAggregateFnNode(fnNode)) {
          aggregateFnEntries.push([[fnKey, fnKey], 1])
        }
        if (isOutboxDrainOrBusPublishFnNode(fnNode)) {
          outboxDrainEntries.push([[fnKey, fnKey], 1])
        }
      }
      inDomainNonStubFns.sendData(0, new MultiSet(domainNonStubEntries))
      inDomainNonStubFns.sendFrontier(1)

      inDomainFns.sendData(0, new MultiSet(domainFnEntries))
      inDomainFns.sendFrontier(1)

      inDeciderFns.sendData(0, new MultiSet(deciderFnEntries))
      inDeciderFns.sendFrontier(1)

      inReducerFns.sendData(0, new MultiSet(reducerFnEntries))
      inReducerFns.sendFrontier(1)

      inAggregateFns.sendData(0, new MultiSet(aggregateFnEntries))
      inAggregateFns.sendFrontier(1)

      inOutboxOrBusPublishFns.sendData(0, new MultiSet(outboxDrainEntries))
      inOutboxOrBusPublishFns.sendFrontier(1)

      const infraSvcEntries: Array<[KeyValue<string, string>, number]> = []
      const cloudBindingEntries: Array<[KeyValue<string, string>, number]> = []
      const eventBusSvcEntries: Array<[KeyValue<string, string>, number]> = []

      for (const [svcKey, svcNode] of servicesByKey.entries()) {
        if (isInfraService(svcNode)) {
          infraSvcEntries.push([[svcKey, svcKey], 1])
        } else if (isCloudBinding(svcNode)) {
          cloudBindingEntries.push([[svcKey, svcKey], 1])
        }
        if (isEventBusServiceNode(svcNode)) {
          eventBusSvcEntries.push([[svcKey, svcKey], 1])
        }
      }
      inInfraServices.sendData(0, new MultiSet(infraSvcEntries))
      inInfraServices.sendFrontier(1)

      inCloudBindingServices.sendData(0, new MultiSet(cloudBindingEntries))
      inCloudBindingServices.sendFrontier(1)

      inEventBusServices.sendData(0, new MultiSet(eventBusSvcEntries))
      inEventBusServices.sendFrontier(1)

      const knownSpanEntries: Array<[KeyValue<string, string>, number]> = []
      for (const fnNode of fnsByKey.values()) {
        knownSpanEntries.push([[fnNode.spanName, fnNode.spanName], 1])
        knownSpanEntries.push([[fnNode.qualname, fnNode.qualname], 1])
        const hashIdx = fnNode.qualname.lastIndexOf("#")
        if (hashIdx !== -1) {
          const suffix = fnNode.qualname.slice(hashIdx + 1)
          knownSpanEntries.push([[suffix, suffix], 1])
        }
      }
      inKnownSpans.sendData(0, new MultiSet(knownSpanEntries))
      inKnownSpans.sendFrontier(1)

      const knownSvcEntries: Array<[KeyValue<string, string>, number]> = []
      for (const svcNode of servicesByKey.values()) {
        knownSvcEntries.push([[svcNode.tagId, svcNode.tagId], 1])
        knownSvcEntries.push([[svcNode.name, svcNode.name], 1])
        const hashIdx = svcNode.tagId.lastIndexOf("#")
        if (hashIdx !== -1) {
          const suffix = svcNode.tagId.slice(hashIdx + 1)
          knownSvcEntries.push([[suffix, suffix], 1])
        }
      }
      inKnownServices.sendData(0, new MultiSet(knownSvcEntries))
      inKnownServices.sendFrontier(1)

      const knownErrEntries: Array<[KeyValue<string, string>, number]> = []
      for (const errNode of errorsByKey.values()) {
        knownErrEntries.push([[errNode.errorTag, errNode.errorTag], 1])
        if (errNode.tag !== undefined) {
          knownErrEntries.push([[errNode.tag, errNode.tag], 1])
        }
      }
      inKnownErrors.sendData(0, new MultiSet(knownErrEntries))
      inKnownErrors.sendFrontier(1)

      const destructiveMigrationEntries: Array<[KeyValue<string, string>, number]> = []
      const migrationVerifyingTestEntries: Array<[KeyValue<string, string>, number]> = []
      for (const [relId, migNode] of migrationsById.entries()) {
        if (migNode.isDestructive) {
          destructiveMigrationEntries.push([[relId, relId], 1])
        }
        const migTests = migrationRoles.get(relId)?.get("verifying-test") ?? new Set<string>()
        for (const testKey of migTests) {
          migrationVerifyingTestEntries.push([[relId, testKey], 1])
        }
      }
      inDestructiveMigrations.sendData(0, new MultiSet(destructiveMigrationEntries))
      inDestructiveMigrations.sendFrontier(1)
      inMigrationVerifyingTests.sendData(0, new MultiSet(migrationVerifyingTestEntries))
      inMigrationVerifyingTests.sendFrontier(1)

      // Prepare Spec expected error & service triples for COMP-01, COMP-02, and INF-07
      const specExpectedErrorEntries: Array<[KeyValue<string, [string, string, string]>, number]> =
        []
      const specExpectedServiceEntries: Array<
        [KeyValue<string, [string, string, string]>, number]
      > = []
      const specDeclaredSpansEntries: Array<[KeyValue<string, [string, string]>, number]> = []
      const specDeclaredSvcEntries: Array<[KeyValue<string, [string, string]>, number]> = []
      const specDeclaredErrEntries: Array<[KeyValue<string, [string, string]>, number]> = []

      for (const [specKey, specNode] of specsByKey.entries()) {
        if (!isProposedOrAcceptedSpec(specNode)) {
          continue
        }
        for (const span of specNode.referencedSpans ?? []) {
          specDeclaredSpansEntries.push([[span, [specKey, span]], 1])
        }
        for (const svc of specNode.referencedServices ?? []) {
          specDeclaredSvcEntries.push([[svc, [specKey, svc]], 1])
        }
        for (const err of specNode.referencedErrors ?? []) {
          specDeclaredErrEntries.push([[err, [specKey, err]], 1])
        }
      }
      inSpecDeclaredSpans.sendData(0, new MultiSet(specDeclaredSpansEntries))
      inSpecDeclaredSpans.sendFrontier(1)
      inSpecDeclaredServices.sendData(0, new MultiSet(specDeclaredSvcEntries))
      inSpecDeclaredServices.sendFrontier(1)
      inSpecDeclaredErrors.sendData(0, new MultiSet(specDeclaredErrEntries))
      inSpecDeclaredErrors.sendFrontier(1)

      for (const [specKey, targetKey] of existingSpecToTargetPairs) {
        const specNode = specsByKey.get(specKey)
        const fnNode = fnsByKey.get(targetKey)
        if (specNode === undefined || fnNode === undefined) {
          continue
        }
        for (const errName of specNode.referencedErrors ?? []) {
          const errKey = `TaggedError:${errName}`
          if (errorsByKey.has(errKey)) {
            specExpectedErrorEntries.push([
              [`${targetKey}->${errKey}`, [specKey, targetKey, errKey]],
              1,
            ])
          }
        }
        for (const svcName of specNode.referencedServices ?? []) {
          for (const [svcKey, svcNode] of servicesByKey.entries()) {
            if (
              svcNode.tagId === svcName ||
              svcNode.name === svcName ||
              svcNode.tagId.endsWith(`#${svcName}`)
            ) {
              specExpectedServiceEntries.push([
                [`${targetKey}->${svcKey}`, [specKey, targetKey, svcKey]],
                1,
              ])
            }
          }
        }
      }
      inSpecExpectedErrors.sendData(0, new MultiSet(specExpectedErrorEntries))
      inSpecExpectedErrors.sendFrontier(1)
      inSpecExpectedServices.sendData(0, new MultiSet(specExpectedServiceEntries))
      inSpecExpectedServices.sendFrontier(1)

      // Prepare ADR expected target tuples for COMP-05
      const adrExpectedEntries: Array<[KeyValue<string, [string, string]>, number]> = []
      for (const [adrKey, adrNode] of adrsByKey.entries()) {
        if (!isAcceptedAdr(adrNode)) {
          continue
        }
        for (const enforcedFile of adrNode.enforcedByFiles) {
          for (const [fnKey, fnNode] of fnsByKey.entries()) {
            if (fnNode.file === enforcedFile || fnNode.file.endsWith(enforcedFile)) {
              adrExpectedEntries.push([[`${adrKey}->${fnKey}`, [adrKey, fnKey]], 1])
            }
          }
        }
      }
      inAdrExpectedTargets.sendData(0, new MultiSet(adrExpectedEntries))
      inAdrExpectedTargets.sendFrontier(1)
      inExistingTraceAdrs.sendData(
        0,
        new MultiSet(Array.from(existingTraceGoverningAdrs).map((k) => [[k, k], 1])),
      )
      inExistingTraceAdrs.sendFrontier(1)

      d2.run()

      // ======================================================================
      // Materialize DerivationProof DAG & Structured Outputs
      // ======================================================================
      const provenanceByPair = new Map<string, MinHeightProvenanceAnnotation>(
        collectedCallReachProvenance,
      )

      const proofsById = new Map<string, DerivationProof>()
      const registerProof = (proof: DerivationProof): DerivationProof => {
        let computedHeight = proof.proofHeight
        if (computedHeight === undefined) {
          if (proof.parentProofIds.length > 0) {
            let maxParent = 1
            for (const pid of proof.parentProofIds) {
              const parentProof = proofsById.get(pid)
              if (parentProof?.proofHeight !== undefined && parentProof.proofHeight > maxParent) {
                maxParent = parentProof.proofHeight
              }
            }
            computedHeight = ProofHeight.make(maxParent + 1)
          } else {
            computedHeight = ProofHeight.make(Math.max(1, proof.premises.length - 1))
          }
        }
        const enriched: DerivationProof = {
          ...proof,
          proofHeight: computedHeight,
          witnessPath: proof.witnessPath ?? proof.premises,
          explanation:
            proof.explanation ??
            `[${proof.ruleId}@S${proof.stratum}/h=${computedHeight}] ${proof.conclusion} <= ${proof.premises.join(" ∧ ")}`,
        }
        proofsById.set(enriched.proofId, enriched)
        return enriched
      }

      const directReqSet = new Set(directReqPairs.map(([c, s]) => `${c}->${s}`))
      const directFailSet = new Set(directFailPairs.map(([c, e]) => `${c}->${e}`))
      const directTestSpanSet = new Set(directTestSpanPairs.map(([t, s]) => `${t}->${s}`))

      // 1. EffectiveServiceRequirement (INF-01)
      const effectiveRequires: Array<EffectiveServiceRequirement> = []
      const reqProofByPair = new Map<string, ProofId>()
      const sortedEffReq = [...collectedEffectiveRequires].sort((a, b) => a[0].localeCompare(b[0]))
      for (const [pairKey, [callerKey, serviceKey]] of sortedEffReq) {
        const isDirect = directReqSet.has(pairKey)
        const svcTag = svcTagIdByKey.get(serviceKey) ?? serviceKey
        let witnessPath: ReadonlyArray<string>
        if (isDirect) {
          const callerQual = fnQualnameByKey.get(callerKey) ?? callerKey
          witnessPath = [callerQual, svcTag]
        } else {
          // Find shortest call path to a callee that directly requires serviceKey
          let bestCallPath: ReadonlyArray<string> | undefined
          for (const [calleeKey, reqSvcKey] of directReqPairs) {
            if (reqSvcKey !== serviceKey) {
              continue
            }
            const reached = collectedCallReach.some(
              ([, [c, cal]]) => c === callerKey && cal === calleeKey,
            )
            if (reached) {
              const rawPath = reconstructCallWitnessPath(callerKey, calleeKey, provenanceByPair)
              const candidate = rawPath.map((k) => fnQualnameByKey.get(k) ?? k)
              if (
                bestCallPath === undefined ||
                candidate.length < bestCallPath.length ||
                (candidate.length === bestCallPath.length &&
                  candidate.join("->").localeCompare(bestCallPath.join("->")) < 0)
              ) {
                bestCallPath = candidate
              }
            }
          }
          const baseCallPath = bestCallPath ?? [fnQualnameByKey.get(callerKey) ?? callerKey]
          witnessPath = [...baseCallPath, svcTag]
        }

        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-01:${callerKey}->${serviceKey}`),
          ruleId: DatalogRuleId.make("INF-01"),
          stratum: StratumIndex.make(1),
          conclusion: `EffectiveRequires(${callerKey}, ${serviceKey})`,
          premises: witnessPath.map((step) => `Step(${step})`),
          parentProofIds: [],
        })
        reqProofByPair.set(pairKey, proof.proofId)
        effectiveRequires.push({
          callerKey: NodeKey.make(callerKey),
          serviceKey: NodeKey.make(serviceKey),
          isDirect,
          path: witnessPath,
          proof,
        })
      }

      // 2. EffectiveErrorPropagation (INF-02)
      const effectiveFailsWith: Array<EffectiveErrorPropagation> = []
      const failProofByPair = new Map<string, ProofId>()
      const sortedEffFails = [...collectedEffectiveFails].sort((a, b) => a[0].localeCompare(b[0]))
      for (const [pairKey, [callerKey, errorKey]] of sortedEffFails) {
        const isDirect = directFailSet.has(pairKey)
        const errTag = errTagByKey.get(errorKey) ?? errorKey
        let witnessPath: ReadonlyArray<string>
        if (isDirect) {
          const callerQual = fnQualnameByKey.get(callerKey) ?? callerKey
          witnessPath = [callerQual, errTag]
        } else {
          let bestCallPath: ReadonlyArray<string> | undefined
          for (const [calleeKey, failErrKey] of directFailPairs) {
            if (failErrKey !== errorKey) {
              continue
            }
            const reached = collectedCallReach.some(
              ([, [c, cal]]) => c === callerKey && cal === calleeKey,
            )
            if (reached) {
              const rawPath = reconstructCallWitnessPath(callerKey, calleeKey, provenanceByPair)
              const candidate = rawPath.map((k) => fnQualnameByKey.get(k) ?? k)
              if (
                bestCallPath === undefined ||
                candidate.length < bestCallPath.length ||
                (candidate.length === bestCallPath.length &&
                  candidate.join("->").localeCompare(bestCallPath.join("->")) < 0)
              ) {
                bestCallPath = candidate
              }
            }
          }
          const baseCallPath = bestCallPath ?? [fnQualnameByKey.get(callerKey) ?? callerKey]
          witnessPath = [...baseCallPath, errTag]
        }

        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-02:${callerKey}->${errorKey}`),
          ruleId: DatalogRuleId.make("INF-02"),
          stratum: StratumIndex.make(1),
          conclusion: `EffectiveFailsWith(${callerKey}, ${errorKey})`,
          premises: witnessPath.map((step) => `Step(${step})`),
          parentProofIds: [],
        })
        failProofByPair.set(pairKey, proof.proofId)
        effectiveFailsWith.push({
          callerKey: NodeKey.make(callerKey),
          errorKey: NodeKey.make(errorKey),
          isDirect,
          path: witnessPath,
          proof,
        })
      }

      // 3. EffectiveLayerDependency (INF-03a)
      const effectiveLayerDeps: Array<EffectiveLayerDependency> = []
      const directLayerEdges = new Map<string, Array<string>>()
      const providersBySvcKey = new Map<string, Array<string>>()
      for (const [layerKey, svcKey] of directLayerProvidesPairs) {
        const list = providersBySvcKey.get(svcKey) ?? []
        if (!list.includes(layerKey)) {
          list.push(layerKey)
          list.sort()
          providersBySvcKey.set(svcKey, list)
        }
      }
      const seenLayerSvcPairs = new Set<string>()
      const sortedDirectLayerRequires = [...directLayerRequiresPairs].sort((a, b) =>
        `${a[0]}->${a[1]}`.localeCompare(`${b[0]}->${b[1]}`),
      )
      for (const [layerKey, reqSvcKey] of sortedDirectLayerRequires) {
        const providers = providersBySvcKey.get(reqSvcKey) ?? []
        for (const providerKey of providers) {
          const list = directLayerEdges.get(layerKey) ?? []
          if (!list.includes(providerKey)) {
            list.push(providerKey)
            list.sort()
            directLayerEdges.set(layerKey, list)
          }
        }
        const primaryProviderKey = providers[0]
        const layerQual = layerQualnameByKey.get(layerKey) ?? layerKey
        const svcTag = svcTagIdByKey.get(reqSvcKey) ?? reqSvcKey
        const providerQual =
          primaryProviderKey !== undefined
            ? (layerQualnameByKey.get(primaryProviderKey) ?? primaryProviderKey)
            : undefined
        const path =
          providerQual !== undefined ? [layerQual, svcTag, providerQual] : [layerQual, svcTag]
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-03:layer:${layerKey}->${reqSvcKey}`),
          ruleId: DatalogRuleId.make("INF-03"),
          stratum: StratumIndex.make(1),
          conclusion: `EffectiveLayerDep(${layerKey}, ${reqSvcKey})`,
          premises: path.map((p) => `LayerStep(${p})`),
          parentProofIds: [],
        })
        seenLayerSvcPairs.add(`${layerKey}->${reqSvcKey}`)
        effectiveLayerDeps.push({
          layerKey: NodeKey.make(layerKey),
          requiredServiceKey: NodeKey.make(reqSvcKey),
          ...(primaryProviderKey !== undefined
            ? { providerLayerKey: NodeKey.make(primaryProviderKey) }
            : {}),
          isDirect: true,
          path,
          proof,
        })
      }

      // Emit transitive EffectiveLayerDependency entries from collectedLayerReach
      const sortedLayerReach = [...collectedLayerReach].sort((a, b) => a[0].localeCompare(b[0]))
      for (const [, [srcLayerKey, dstLayerKey]] of sortedLayerReach) {
        if (srcLayerKey === dstLayerKey) {
          continue
        }
        for (const [midLayerKey, reqSvcKey] of sortedDirectLayerRequires) {
          if (midLayerKey !== dstLayerKey) {
            continue
          }
          const pairId = `${srcLayerKey}->${reqSvcKey}`
          if (seenLayerSvcPairs.has(pairId)) {
            continue
          }
          seenLayerSvcPairs.add(pairId)
          const providers = providersBySvcKey.get(reqSvcKey) ?? []
          const primaryProviderKey = providers[0]
          const srcQual = layerQualnameByKey.get(srcLayerKey) ?? srcLayerKey
          const dstQual = layerQualnameByKey.get(dstLayerKey) ?? dstLayerKey
          const svcTag = svcTagIdByKey.get(reqSvcKey) ?? reqSvcKey
          const providerQual =
            primaryProviderKey !== undefined
              ? (layerQualnameByKey.get(primaryProviderKey) ?? primaryProviderKey)
              : undefined
          const path =
            providerQual !== undefined
              ? [srcQual, dstQual, svcTag, providerQual]
              : [srcQual, dstQual, svcTag]
          const proof = registerProof({
            proofId: ProofId.make(`proof:INF-03:layer:${srcLayerKey}->${reqSvcKey}`),
            ruleId: DatalogRuleId.make("INF-03"),
            stratum: StratumIndex.make(1),
            conclusion: `EffectiveLayerDep(${srcLayerKey}, ${reqSvcKey})`,
            premises: path.map((p) => `LayerStep(${p})`),
            parentProofIds: [],
          })
          effectiveLayerDeps.push({
            layerKey: NodeKey.make(srcLayerKey),
            requiredServiceKey: NodeKey.make(reqSvcKey),
            ...(primaryProviderKey !== undefined
              ? { providerLayerKey: NodeKey.make(primaryProviderKey) }
              : {}),
            isDirect: false,
            path,
            proof,
          })
        }
      }

      // 4. EffectiveTestReachability (INF-03b)
      const effectiveTestReach: Array<EffectiveTestReachability> = []
      const sortedTestReach = [...collectedEffectiveTestReach].sort((a, b) =>
        a[0].localeCompare(b[0]),
      )
      for (const [pairKey, [testKey, targetSpanKey]] of sortedTestReach) {
        const testNode = testsByKey.get(testKey)
        const isDirect = directTestSpanSet.has(pairKey)
        const targetQual = fnQualnameByKey.get(targetSpanKey) ?? targetSpanKey
        const path = [testNode?.testId ?? testKey, targetQual]
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-03:test:${testKey}->${targetSpanKey}`),
          ruleId: DatalogRuleId.make("INF-03"),
          stratum: StratumIndex.make(1),
          conclusion: `EffectiveTestReach(${testKey}, ${targetSpanKey})`,
          premises: path.map((p) => `TestStep(${p})`),
          parentProofIds: [],
        })
        effectiveTestReach.push({
          testKey: NodeKey.make(testKey),
          targetSpanKey: NodeKey.make(targetSpanKey),
          isPropertyTest: testNode?.isPropertyTest ?? false,
          isDirect,
          path,
          proof,
        })
      }

      // ======================================================================
      // Stratum S_2: Materialize InferredAntiPattern tuples (INF-04..09)
      // ======================================================================
      const antiPatterns: Array<InferredAntiPattern> = []

      // INF-04a: domain-requires-infra from D2 domainRequiresInfraStream
      for (const [pairKey, [callerKey, serviceKey]] of collectedDomainRequiresInfra) {
        const fnNode = fnsByKey.get(callerKey)
        const svcNode = servicesByKey.get(serviceKey)
        if (fnNode === undefined || svcNode === undefined) {
          continue
        }
        const parentProofId = reqProofByPair.get(pairKey)
        const req = effectiveRequires.find(
          (r) => r.callerKey === callerKey && r.serviceKey === serviceKey,
        )
        const path = req?.path ?? [fnNode.qualname, svcNode.tagId]
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-04:domain-requires-infra:${callerKey}->${serviceKey}`),
          ruleId: DatalogRuleId.make("INF-04"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(domain-requires-infra, ${callerKey}, ${serviceKey})`,
          premises: [
            `EffectiveRequires(${callerKey}, ${serviceKey})`,
            `PackageTag(${serviceKey}, infra)`,
          ],
          parentProofIds: parentProofId !== undefined ? [parentProofId] : [],
        })
        antiPatterns.push({
          ruleId: "domain-requires-infra",
          datalogRuleId: DatalogRuleId.make("INF-04"),
          nodeKey: NodeKey.make(callerKey),
          targetKey: NodeKey.make(serviceKey),
          path,
          message: `Domain Effect.fn '${fnNode.spanName}' (${fnNode.qualname}) requires infra ServiceTag '${svcNode.tagId}'`,
          proof,
        })
      }

      // INF-04b: domain-requires-cloud-binding from D2 domainRequiresCloudBindingStream
      for (const [pairKey, [callerKey, serviceKey]] of collectedDomainRequiresCloudBinding) {
        const fnNode = fnsByKey.get(callerKey)
        const svcNode = servicesByKey.get(serviceKey)
        if (fnNode === undefined || svcNode === undefined) {
          continue
        }
        const parentProofId = reqProofByPair.get(pairKey)
        const req = effectiveRequires.find(
          (r) => r.callerKey === callerKey && r.serviceKey === serviceKey,
        )
        const path = req?.path ?? [fnNode.qualname, svcNode.tagId]
        const proof = registerProof({
          proofId: ProofId.make(
            `proof:INF-04:domain-requires-cloud-binding:${callerKey}->${serviceKey}`,
          ),
          ruleId: DatalogRuleId.make("INF-04"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(domain-requires-cloud-binding, ${callerKey}, ${serviceKey})`,
          premises: [
            `EffectiveRequires(${callerKey}, ${serviceKey})`,
            `CloudBinding(${serviceKey})`,
          ],
          parentProofIds: parentProofId !== undefined ? [parentProofId] : [],
        })
        antiPatterns.push({
          ruleId: "domain-requires-cloud-binding",
          datalogRuleId: DatalogRuleId.make("INF-04"),
          nodeKey: NodeKey.make(callerKey),
          targetKey: NodeKey.make(serviceKey),
          path,
          message: `Domain Effect.fn '${fnNode.spanName}' (${fnNode.qualname}) requires cloud binding '${svcNode.tagId}'`,
          proof,
        })
      }

      // INF-05a: impure-decider from D2 impureDeciderStream
      for (const [pairKey, [callerKey, serviceKey]] of collectedImpureDeciders) {
        const fnNode = fnsByKey.get(callerKey)
        const svcNode = servicesByKey.get(serviceKey)
        if (fnNode === undefined || svcNode === undefined) {
          continue
        }
        const parentProofId = reqProofByPair.get(pairKey)
        const req = effectiveRequires.find(
          (r) => r.callerKey === callerKey && r.serviceKey === serviceKey,
        )
        const path = req?.path ?? [fnNode.qualname, svcNode.tagId]
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-05:impure-decider:${callerKey}->${serviceKey}`),
          ruleId: DatalogRuleId.make("INF-05"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(impure-decider, ${callerKey}, ${serviceKey})`,
          premises: [
            `EffectiveRequires(${callerKey}, ${serviceKey})`,
            `DeciderSpan(${fnNode.spanName})`,
          ],
          parentProofIds: parentProofId !== undefined ? [parentProofId] : [],
        })
        antiPatterns.push({
          ruleId: "impure-decider",
          datalogRuleId: DatalogRuleId.make("INF-05"),
          nodeKey: NodeKey.make(callerKey),
          targetKey: NodeKey.make(serviceKey),
          path,
          message: `Decider '${fnNode.spanName}' (${fnNode.qualname}) must be pure (R = never) but requires service '${svcNode.tagId}'`,
          proof,
        })
      }

      // INF-05b: impure-reducer (requires service) from D2 impureReducerSvcStream
      for (const [pairKey, [callerKey, serviceKey]] of collectedImpureReducerSvcs) {
        const fnNode = fnsByKey.get(callerKey)
        const svcNode = servicesByKey.get(serviceKey)
        if (fnNode === undefined || svcNode === undefined) {
          continue
        }
        const parentProofId = reqProofByPair.get(pairKey)
        const req = effectiveRequires.find(
          (r) => r.callerKey === callerKey && r.serviceKey === serviceKey,
        )
        const path = req?.path ?? [fnNode.qualname, svcNode.tagId]
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-05:impure-reducer:svc:${callerKey}->${serviceKey}`),
          ruleId: DatalogRuleId.make("INF-05"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(impure-reducer, ${callerKey}, ${serviceKey})`,
          premises: [
            `EffectiveRequires(${callerKey}, ${serviceKey})`,
            `ReducerSpan(${fnNode.spanName})`,
          ],
          parentProofIds: parentProofId !== undefined ? [parentProofId] : [],
        })
        antiPatterns.push({
          ruleId: "impure-reducer",
          datalogRuleId: DatalogRuleId.make("INF-05"),
          nodeKey: NodeKey.make(callerKey),
          targetKey: NodeKey.make(serviceKey),
          path,
          message: `Reducer '${fnNode.spanName}' (${fnNode.qualname}) is a reducer (.evolve/.fold) which must be pure and cannot require service '${svcNode.tagId}'`,
          proof,
        })
      }

      // INF-05c: impure-reducer (fails with error) from D2 impureReducerErrStream
      for (const [pairKey, [callerKey, errorKey]] of collectedImpureReducerErrs) {
        const fnNode = fnsByKey.get(callerKey)
        const errNode = errorsByKey.get(errorKey)
        if (fnNode === undefined || errNode === undefined) {
          continue
        }
        const parentProofId = failProofByPair.get(pairKey)
        const fail = effectiveFailsWith.find(
          (f) => f.callerKey === callerKey && f.errorKey === errorKey,
        )
        const path = fail?.path ?? [fnNode.qualname, errNode.errorTag]
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-05:impure-reducer:err:${callerKey}->${errorKey}`),
          ruleId: DatalogRuleId.make("INF-05"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(impure-reducer, ${callerKey}, ${errorKey})`,
          premises: [
            `EffectiveFailsWith(${callerKey}, ${errorKey})`,
            `ReducerSpan(${fnNode.spanName})`,
          ],
          parentProofIds: parentProofId !== undefined ? [parentProofId] : [],
        })
        antiPatterns.push({
          ruleId: "impure-reducer",
          datalogRuleId: DatalogRuleId.make("INF-05"),
          nodeKey: NodeKey.make(callerKey),
          targetKey: NodeKey.make(errorKey),
          path,
          message: `Reducer '${fnNode.spanName}' (${fnNode.qualname}) is a reducer (.evolve/.fold) which must be infallible and cannot fail with '${errNode.errorTag}'`,
          proof,
        })
      }

      // INF-08a: aggregate-direct-bus-publish (requires EventBus) from D2 aggregateBusSvcStream
      for (const [pairKey, [callerKey, serviceKey]] of collectedAggregateBusSvcs) {
        const fnNode = fnsByKey.get(callerKey)
        const svcNode = servicesByKey.get(serviceKey)
        if (fnNode === undefined || svcNode === undefined) {
          continue
        }
        const parentProofId = reqProofByPair.get(pairKey)
        const req = effectiveRequires.find(
          (r) => r.callerKey === callerKey && r.serviceKey === serviceKey,
        )
        const path = req?.path ?? [fnNode.qualname, svcNode.tagId]
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-08:bus-svc:${callerKey}->${serviceKey}`),
          ruleId: DatalogRuleId.make("INF-08"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(aggregate-direct-bus-publish, ${callerKey}, ${serviceKey})`,
          premises: [
            `EffectiveRequires(${callerKey}, ${serviceKey})`,
            `AggregateFn(${fnNode.qualname})`,
            `EventBus(${svcNode.tagId})`,
          ],
          parentProofIds: parentProofId !== undefined ? [parentProofId] : [],
        })
        antiPatterns.push({
          ruleId: "aggregate-direct-bus-publish",
          datalogRuleId: DatalogRuleId.make("INF-08"),
          nodeKey: NodeKey.make(callerKey),
          targetKey: NodeKey.make(serviceKey),
          path,
          message: `Aggregate function '${fnNode.spanName}' (${fnNode.qualname}) directly requires EventBus '${svcNode.tagId}'; use transactional Outbox instead`,
          proof,
        })
      }

      // INF-08b: aggregate-direct-bus-publish (calls Outbox.drain or EventBus.publish) from D2 aggregateBusCallStream
      for (const [, [callerKey, calleeKey]] of collectedAggregateBusCalls) {
        const callerNode = fnsByKey.get(callerKey)
        const calleeNode = fnsByKey.get(calleeKey)
        if (callerNode === undefined || calleeNode === undefined) {
          continue
        }
        const rawPath = reconstructCallWitnessPath(callerKey, calleeKey, provenanceByPair)
        const rawWitness = rawPath.map((k) => fnQualnameByKey.get(k) ?? k)
        const witnessPath =
          rawWitness.length >= 2
            ? [...rawWitness.slice(0, -1), calleeNode.spanName]
            : [callerNode.qualname, calleeNode.spanName]
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-08:call:${callerKey}->${calleeKey}`),
          ruleId: DatalogRuleId.make("INF-08"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(aggregate-direct-bus-publish, ${callerKey}, ${calleeKey})`,
          premises: witnessPath.map((step) => `CallStep(${step})`),
          parentProofIds: [],
        })
        antiPatterns.push({
          ruleId: "aggregate-direct-bus-publish",
          datalogRuleId: DatalogRuleId.make("INF-08"),
          nodeKey: NodeKey.make(callerKey),
          targetKey: NodeKey.make(calleeKey),
          path: witnessPath,
          message: `Aggregate function '${callerNode.spanName}' (${callerNode.qualname}) calls '${calleeNode.spanName}' synchronously in command execution path`,
          proof,
        })
      }

      // INF-06a: layer-cycle from D2 layerCyclesStream
      const seenCycleSignatures = new Set<string>()
      const sortedLayerCycles = [...collectedLayerCycles].sort((a, b) => a[0].localeCompare(b[0]))
      for (const [, [cycleLayerKey]] of sortedLayerCycles) {
        const cyclePath = findShortestLayerCycle(
          cycleLayerKey,
          directLayerEdges,
          layerQualnameByKey,
        )
        const sig = [...cyclePath].sort().join("|")
        if (seenCycleSignatures.has(sig)) {
          continue
        }
        seenCycleSignatures.add(sig)
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-06:layer-cycle:${cycleLayerKey}`),
          ruleId: DatalogRuleId.make("INF-06"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(layer-cycle, ${cycleLayerKey})`,
          premises: cyclePath.map((p) => `LayerDep(${p})`),
          parentProofIds: [],
        })
        antiPatterns.push({
          ruleId: "layer-cycle",
          datalogRuleId: DatalogRuleId.make("INF-06"),
          nodeKey: NodeKey.make(cycleLayerKey),
          path: cyclePath,
          message: `ServiceLayer dependency cycle detected: ${cyclePath.join(" -> ")}`,
          proof,
        })
      }

      // INF-06b: missing-layer-provider from D2 antiJoin
      for (const [reqSvcKey, [consumerLayerKey]] of collectedMissingLayerProviders) {
        const layerQual = layerQualnameByKey.get(consumerLayerKey) ?? consumerLayerKey
        const svcTag = svcTagIdByKey.get(reqSvcKey) ?? reqSvcKey
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-06:missing-provider:${consumerLayerKey}->${reqSvcKey}`),
          ruleId: DatalogRuleId.make("INF-06"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(missing-layer-provider, ${consumerLayerKey}, ${reqSvcKey})`,
          premises: [
            `LayerRequires(${consumerLayerKey}, ${reqSvcKey})`,
            `!LayerProvides(*, ${reqSvcKey})`,
          ],
          parentProofIds: [],
        })
        antiPatterns.push({
          ruleId: "missing-layer-provider",
          datalogRuleId: DatalogRuleId.make("INF-06"),
          nodeKey: NodeKey.make(consumerLayerKey),
          targetKey: NodeKey.make(reqSvcKey),
          path: [layerQual, svcTag],
          message: `ServiceLayer '${layerQual}' requires ServiceTag '${svcTag}', which has no providing LayerFlow in the hypergraph`,
          proof,
        })
      }

      // INF-07: unmapped-spec-symbol from D2 antiJoin streams
      for (const [, [[specKey, span]]] of collectedUnmappedSpecSpans) {
        const specNode = specsByKey.get(specKey)
        const specId = specNode?.id ?? specKey
        const specPath = specNode?.path ?? specKey
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-07:span:${specId}:${span}`),
          ruleId: DatalogRuleId.make("INF-07"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(unmapped-spec-symbol, ${specKey}, ${span})`,
          premises: [`SpecDeclaresSpan(${specId}, ${span})`, `!EffectFn(${span})`],
          parentProofIds: [],
        })
        antiPatterns.push({
          ruleId: "unmapped-spec-symbol",
          datalogRuleId: DatalogRuleId.make("INF-07"),
          nodeKey: NodeKey.make(specKey),
          path: [specId, span],
          message: `EARS Spec '${specId}' (${specPath}) declares EffectFn span '${span}', which is missing from the graph`,
          proof,
        })
      }
      for (const [, [[specKey, svc]]] of collectedUnmappedSpecServices) {
        const specNode = specsByKey.get(specKey)
        const specId = specNode?.id ?? specKey
        const specPath = specNode?.path ?? specKey
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-07:svc:${specId}:${svc}`),
          ruleId: DatalogRuleId.make("INF-07"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(unmapped-spec-symbol, ${specKey}, ${svc})`,
          premises: [`SpecDeclaresService(${specId}, ${svc})`, `!ServiceTag(${svc})`],
          parentProofIds: [],
        })
        antiPatterns.push({
          ruleId: "unmapped-spec-symbol",
          datalogRuleId: DatalogRuleId.make("INF-07"),
          nodeKey: NodeKey.make(specKey),
          path: [specId, svc],
          message: `EARS Spec '${specId}' (${specPath}) declares ServiceTag '${svc}', which is missing from the graph`,
          proof,
        })
      }
      for (const [, [[specKey, err]]] of collectedUnmappedSpecErrors) {
        const specNode = specsByKey.get(specKey)
        const specId = specNode?.id ?? specKey
        const specPath = specNode?.path ?? specKey
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-07:err:${specId}:${err}`),
          ruleId: DatalogRuleId.make("INF-07"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(unmapped-spec-symbol, ${specKey}, ${err})`,
          premises: [`SpecDeclaresError(${specId}, ${err})`, `!TaggedError(${err})`],
          parentProofIds: [],
        })
        antiPatterns.push({
          ruleId: "unmapped-spec-symbol",
          datalogRuleId: DatalogRuleId.make("INF-07"),
          nodeKey: NodeKey.make(specKey),
          path: [specId, err],
          message: `EARS Spec '${specId}' (${specPath}) declares TaggedError '${err}', which is missing from the graph`,
          proof,
        })
      }

      // INF-09a: untested-domain-span from D2 antiJoin
      for (const [fnKey] of collectedUntestedDomainSpans) {
        const fnNode = fnsByKey.get(fnKey)
        if (fnNode === undefined) {
          continue
        }
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-09:untested-span:${fnKey}`),
          ruleId: DatalogRuleId.make("INF-09"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(untested-domain-span, ${fnKey})`,
          premises: [`DomainEffectFn(${fnKey})`, `!EffectiveTestReach(*, ${fnKey})`],
          parentProofIds: [],
        })
        antiPatterns.push({
          ruleId: "untested-domain-span",
          datalogRuleId: DatalogRuleId.make("INF-09"),
          nodeKey: NodeKey.make(fnKey),
          path: [fnNode.qualname],
          message: `Non-stub ${fnNode.packageTag} EffectFn '${fnNode.spanName}' (${fnNode.qualname}) has zero transitive VitestCase coverage`,
          proof,
        })
      }

      // INF-09b: unverified-migration from D2 antiJoin
      for (const [migRelId] of collectedUnverifiedMigrations) {
        const migNode = migrationsById.get(migRelId)
        if (migNode === undefined) {
          continue
        }
        const migKey = getNodeKey(migNode)
        const proof = registerProof({
          proofId: ProofId.make(`proof:INF-09:unverified-migration:${migRelId}`),
          ruleId: DatalogRuleId.make("INF-09"),
          stratum: StratumIndex.make(2),
          conclusion: `AntiPattern(unverified-migration, ${migKey})`,
          premises: [
            `DestructiveMigration(${migRelId})`,
            `!PlaysRole(${migRelId}, *, verifying-test)`,
          ],
          parentProofIds: [],
        })
        antiPatterns.push({
          ruleId: "unverified-migration",
          datalogRuleId: DatalogRuleId.make("INF-09"),
          nodeKey: migKey,
          path: [migRelId, migNode.migrationId],
          message: `Destructive SQLite migration '${migNode.migrationId}' (${migNode.moduleFile}) has no verifying-test PlaysRoleEdge`,
          proof,
        })
      }

      // ======================================================================
      // Stratum S_3: Materialize Normative Missing-Edge Completions (COMP-01..05)
      // ======================================================================
      const suggestedEdges: Array<SuggestedEdge> = []

      // COMP-01: Missing fails-with PlaysRoleEdge on EffectSignature
      // Also include transitive errors from EffectiveFailsWith that are not directly on caller's EffectSignature
      for (const [pairKey, [[specKey, callerKey, errKey]]] of collectedComp01) {
        const relId =
          sigIdByCallerKey.get(callerKey) ??
          `EffectSignature:${fnQualnameByKey.get(callerKey) ?? callerKey}`
        const parentId = failProofByPair.get(pairKey)
        const proof = registerProof({
          proofId: ProofId.make(`proof:COMP-01:${relId}->${errKey}`),
          ruleId: DatalogRuleId.make("COMP-01"),
          stratum: StratumIndex.make(3),
          conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${errKey}, fails-with)`,
          premises: [
            `SpecSpecifiesTarget(${specKey}, ${callerKey})`,
            `SpecReferencesError(${specKey}, ${errKey})`,
            `!PlaysRole(${relId}, ${errKey}, fails-with)`,
          ],
          parentProofIds: parentId !== undefined ? [parentId] : [],
        })
        suggestedEdges.push({
          ruleId: DatalogRuleId.make("COMP-01"),
          relationTag: "EffectSignature",
          relationId: RelationId.make(relId),
          role: RoleName.make("fails-with"),
          targetEntityKey: NodeKey.make(errKey),
          sourceEntityKey: NodeKey.make(callerKey),
          confidenceMillis: ConfidenceMillis.make(950),
          rationale: `EARS spec '${specKey}' specifies '${callerKey}' and declares error '${errKey}', which is missing from '${relId}'`,
          proof,
        })
      }

      for (const fail of effectiveFailsWith) {
        if (!fail.isDirect) {
          const relId =
            sigIdByCallerKey.get(fail.callerKey) ??
            `EffectSignature:${fnQualnameByKey.get(fail.callerKey) ?? fail.callerKey}`
          const alreadySuggested = suggestedEdges.some(
            (s) =>
              s.relationId === relId &&
              s.role === "fails-with" &&
              s.targetEntityKey === fail.errorKey,
          )
          if (!alreadySuggested) {
            const proof = registerProof({
              proofId: ProofId.make(`proof:COMP-01:transitive:${relId}->${fail.errorKey}`),
              ruleId: DatalogRuleId.make("COMP-01"),
              stratum: StratumIndex.make(3),
              conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${fail.errorKey}, fails-with)`,
              premises: [
                fail.proof.conclusion,
                `!PlaysRole(${relId}, ${fail.errorKey}, fails-with)`,
              ],
              parentProofIds: [fail.proof.proofId],
            })
            suggestedEdges.push({
              ruleId: DatalogRuleId.make("COMP-01"),
              relationTag: "EffectSignature",
              relationId: RelationId.make(relId),
              role: RoleName.make("fails-with"),
              targetEntityKey: fail.errorKey,
              sourceEntityKey: fail.callerKey,
              confidenceMillis: ConfidenceMillis.make(900),
              rationale: `Transitive callee propagates '${fail.errorKey}' along [${fail.path.join(" -> ")}], but caller signature '${relId}' lacks a direct fails-with role edge`,
              proof,
            })
          }
        }
      }

      // COMP-02: Missing requires-service PlaysRoleEdge on EffectSignature
      for (const [pairKey, [[specKey, callerKey, svcKey]]] of collectedComp02) {
        const callerNode = fnsByKey.get(callerKey)
        const svcNode = servicesByKey.get(svcKey)
        const callerIsDomainOrContract =
          callerNode !== undefined && isDomainOrContractFn(callerNode)
        const svcIsInfraOrCloud =
          svcNode !== undefined && (isInfraService(svcNode) || isCloudBinding(svcNode))
        if (callerIsDomainOrContract && svcIsInfraOrCloud) {
          continue
        }
        const relId =
          sigIdByCallerKey.get(callerKey) ??
          `EffectSignature:${fnQualnameByKey.get(callerKey) ?? callerKey}`
        const parentId = reqProofByPair.get(pairKey)
        const proof = registerProof({
          proofId: ProofId.make(`proof:COMP-02:${relId}->${svcKey}`),
          ruleId: DatalogRuleId.make("COMP-02"),
          stratum: StratumIndex.make(3),
          conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${svcKey}, requires-service)`,
          premises: [
            `SpecSpecifiesTarget(${specKey}, ${callerKey})`,
            `SpecReferencesService(${specKey}, ${svcKey})`,
            `!PlaysRole(${relId}, ${svcKey}, requires-service)`,
          ],
          parentProofIds: parentId !== undefined ? [parentId] : [],
        })
        suggestedEdges.push({
          ruleId: DatalogRuleId.make("COMP-02"),
          relationTag: "EffectSignature",
          relationId: RelationId.make(relId),
          role: RoleName.make("requires-service"),
          targetEntityKey: NodeKey.make(svcKey),
          sourceEntityKey: NodeKey.make(callerKey),
          confidenceMillis: ConfidenceMillis.make(950),
          rationale: `EARS spec '${specKey}' specifies '${callerKey}' and declares service '${svcKey}', which is missing from '${relId}'`,
          proof,
        })
      }

      // COMP-03: Missing LayerFlow provider edge for required ServiceTag
      for (const [svcKey, [callerKey]] of collectedComp03) {
        const svcTag = svcTagIdByKey.get(svcKey) ?? svcKey
        const relId = `LayerFlow:suggested:${svcTag}`
        const proof = registerProof({
          proofId: ProofId.make(`proof:COMP-03:${relId}->${svcKey}`),
          ruleId: DatalogRuleId.make("COMP-03"),
          stratum: StratumIndex.make(3),
          conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${svcKey}, provided-service)`,
          premises: [
            `DirectRequires(${callerKey}, ${svcKey})`,
            `!PlaysRole(LayerFlow:*, ${svcKey}, provided-service)`,
          ],
          parentProofIds: [],
        })
        suggestedEdges.push({
          ruleId: DatalogRuleId.make("COMP-03"),
          relationTag: "LayerFlow",
          relationId: RelationId.make(relId),
          role: RoleName.make("provided-service"),
          targetEntityKey: NodeKey.make(svcKey),
          sourceEntityKey: NodeKey.make(callerKey),
          confidenceMillis: ConfidenceMillis.make(850),
          rationale: `ServiceTag '${svcTag}' is required by '${callerKey}' but has no providing LayerFlow in the hypergraph`,
          proof,
        })
      }

      // COMP-04: Missing verifying-test PlaysRoleEdge on TraceabilityTuple for untested domain EffectFn
      for (const [fnKey] of collectedUntestedDomainSpans) {
        const fnNode = fnsByKey.get(fnKey)
        if (fnNode === undefined) {
          continue
        }
        const relId = traceIdByTargetKey.get(fnKey) ?? `TraceabilityTuple:fn:${fnNode.qualname}`
        const proof = registerProof({
          proofId: ProofId.make(`proof:COMP-04:${relId}->${fnKey}`),
          ruleId: DatalogRuleId.make("COMP-04"),
          stratum: StratumIndex.make(3),
          conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${fnKey}, verifying-test)`,
          premises: [`DomainEffectFn(${fnKey})`, `!EffectiveTestReach(*, ${fnKey})`],
          parentProofIds: [ProofId.make(`proof:INF-09:untested-span:${fnKey}`)],
        })
        suggestedEdges.push({
          ruleId: DatalogRuleId.make("COMP-04"),
          relationTag: "TraceabilityTuple",
          relationId: RelationId.make(relId),
          role: RoleName.make("verifying-test"),
          targetEntityKey: NodeKey.make(fnKey),
          confidenceMillis: ConfidenceMillis.make(900),
          rationale: `Non-stub ${fnNode.packageTag} EffectFn '${fnNode.spanName}' lacks a verifying-test role edge on TraceabilityTuple '${relId}'`,
          proof,
        })
      }

      // COMP-05: Missing governing-adr PlaysRoleEdge on TraceabilityTuple for symbols in AdrDoc.enforcedByFiles
      for (const [, [[adrKey, fnKey]]] of collectedComp05) {
        const fnNode = fnsByKey.get(fnKey)
        const relId =
          traceIdByTargetKey.get(fnKey) ?? `TraceabilityTuple:fn:${fnNode?.qualname ?? fnKey}`
        const proof = registerProof({
          proofId: ProofId.make(`proof:COMP-05:${relId}->${adrKey}`),
          ruleId: DatalogRuleId.make("COMP-05"),
          stratum: StratumIndex.make(3),
          conclusion: `SuggestedEdge(PlaysRole, ${relId}, ${adrKey}, governing-adr)`,
          premises: [
            `AdrEnforcesFile(${adrKey}, ${fnNode?.file ?? fnKey})`,
            `!PlaysRole(${relId}, ${adrKey}, governing-adr)`,
          ],
          parentProofIds: [],
        })
        suggestedEdges.push({
          ruleId: DatalogRuleId.make("COMP-05"),
          relationTag: "TraceabilityTuple",
          relationId: RelationId.make(relId),
          role: RoleName.make("governing-adr"),
          targetEntityKey: NodeKey.make(adrKey),
          sourceEntityKey: NodeKey.make(fnKey),
          confidenceMillis: ConfidenceMillis.make(920),
          rationale: `ADR '${adrKey}' lists '${fnNode?.file ?? fnKey}' in enforcedByFiles, but '${relId}' lacks a governing-adr role edge`,
          proof,
        })
      }

      // Apply Flix confidence lattice join & System One SemanticEdgePriors overrides
      const mergedSuggestedMap = new Map<string, SuggestedEdge>()
      const groupedByEdgeKey = new Map<string, Array<SuggestedEdge>>()
      for (const edge of suggestedEdges) {
        const edgeIdentity = `${edge.relationTag}::${edge.targetEntityKey}::${edge.role}`
        const group = groupedByEdgeKey.get(edgeIdentity) ?? []
        group.push(edge)
        groupedByEdgeKey.set(edgeIdentity, group)
      }
      for (const [edgeIdentity, group] of groupedByEdgeKey.entries()) {
        const primary = group[0]
        if (primary === undefined) {
          continue
        }
        const latticeInputs: Array<readonly [FlixConfidenceLatticeElement, number]> = group.map(
          (g) => [
            {
              confidenceMillis: g.confidenceMillis,
              parentProofIds: [g.proof.proofId, ...g.proof.parentProofIds],
            },
            1,
          ],
        )
        const overrideKeys = [
          edgeIdentity,
          `${primary.relationId}:${primary.role}:${primary.targetEntityKey}`,
          `${primary.sourceEntityKey ?? primary.relationId}->${primary.targetEntityKey}`,
          `${primary.targetEntityKey}:${primary.role}`,
          primary.targetEntityKey,
        ]
        for (const k of overrideKeys) {
          const overrideVal = priors?.edgeConfidenceOverrides[k]
          if (overrideVal !== undefined) {
            latticeInputs.push([
              {
                confidenceMillis: overrideVal,
                parentProofIds: [primary.proof.proofId],
              },
              1,
            ])
          }
        }
        const reduced = flixConfidenceReducer(latticeInputs)[0]?.[0]
        const joinedConfidence = reduced?.confidenceMillis ?? primary.confidenceMillis
        const mergedParentProofIds = reduced?.parentProofIds ?? primary.proof.parentProofIds
        const updatedProof: DerivationProof = {
          ...primary.proof,
          parentProofIds: mergedParentProofIds,
        }
        proofsById.set(updatedProof.proofId, updatedProof)
        mergedSuggestedMap.set(edgeIdentity, {
          ...primary,
          confidenceMillis: joinedConfidence,
          proof: updatedProof,
        })
      }
      const finalSuggestedEdges = Array.from(mergedSuggestedMap.values())

      // ======================================================================
      // COMP-06: Hazel Typed Hole Inhabitation & System-One-Seeded PPR Bundles
      // ======================================================================
      const entityNeighbors = new Map<string, Set<string>>()
      const addHyperedgeClique = (roleMap: ReadonlyMap<string, Set<string>>): void => {
        const participants = new Set<string>()
        for (const keys of roleMap.values()) {
          for (const k of keys) {
            participants.add(k)
          }
        }
        const arr = Array.from(participants)
        for (const u of arr) {
          let uSet = entityNeighbors.get(u)
          if (uSet === undefined) {
            uSet = new Set<string>()
            entityNeighbors.set(u, uSet)
          }
          for (const v of arr) {
            if (u !== v) {
              uSet.add(v)
            }
          }
        }
      }
      for (const roles of sigRoles.values()) {
        addHyperedgeClique(roles)
      }
      for (const roles of layerFlowRoles.values()) {
        addHyperedgeClique(roles)
      }
      for (const roles of traceRoles.values()) {
        addHyperedgeClique(roles)
      }
      for (const roles of migrationRoles.values()) {
        addHyperedgeClique(roles)
      }
      for (const roles of httpRoles.values()) {
        addHyperedgeClique(roles)
      }

      const typedHoleBundles: Array<TypedHoleContextBundle> = []
      const stubFns = Array.from(fnsByKey.entries())
        .filter(([, fnNode]) => fnNode.isStub)
        .sort((a, b) => a[0].localeCompare(b[0]))

      for (const [holeKey, holeFn] of stubFns) {
        const sigRelId = sigIdByCallerKey.get(holeKey)
        const roles = sigRelId !== undefined ? sigRoles.get(sigRelId) : undefined
        const outputSchemaKeys = new Set<string>(roles?.get("output-schema") ?? [])
        const inputSchemaKeys = new Set<string>(roles?.get("input-schema") ?? [])
        const directErrorKeys = new Set<string>(roles?.get("fails-with") ?? [])
        const directServiceKeys = new Set<string>(roles?.get("requires-service") ?? [])

        // Fallback to holeFn.outputSchema / holeFn.inputSchema / holeFn.successType matching schemasByKey
        if (holeFn.outputSchema !== undefined) {
          for (const [sKey, sNode] of schemasByKey.entries()) {
            if (
              sNode.schemaName === holeFn.outputSchema ||
              sNode.name === holeFn.outputSchema ||
              sKey === `SchemaDef:${holeFn.outputSchema}`
            ) {
              outputSchemaKeys.add(sKey)
            }
          }
        } else if (
          holeFn.successType !== undefined &&
          holeFn.successType !== "void" &&
          holeFn.successType !== "never"
        ) {
          for (const [sKey, sNode] of schemasByKey.entries()) {
            if (
              sNode.schemaName === holeFn.successType ||
              sNode.name === holeFn.successType ||
              sKey === `SchemaDef:${holeFn.successType}`
            ) {
              outputSchemaKeys.add(sKey)
            }
          }
        }

        if (holeFn.inputSchema !== undefined) {
          for (const [sKey, sNode] of schemasByKey.entries()) {
            if (
              sNode.schemaName === holeFn.inputSchema ||
              sNode.name === holeFn.inputSchema ||
              sKey === `SchemaDef:${holeFn.inputSchema}`
            ) {
              inputSchemaKeys.add(sKey)
            }
          }
        }

        // Include errors & services declared by any specifying EarsSpec
        for (const [specKey, targetKey] of existingSpecToTargetPairs) {
          if (targetKey !== holeKey) {
            continue
          }
          const specNode = specsByKey.get(specKey)
          if (specNode === undefined) {
            continue
          }
          for (const errName of specNode.referencedErrors ?? []) {
            const errKey = `TaggedError:${errName}`
            if (errorsByKey.has(errKey)) {
              directErrorKeys.add(errKey)
            }
          }
          for (const svcName of specNode.referencedServices ?? []) {
            for (const [svcKey, svcNode] of servicesByKey.entries()) {
              if (
                svcNode.tagId === svcName ||
                svcNode.name === svcName ||
                svcNode.tagId.endsWith(`#${svcName}`)
              ) {
                directServiceKeys.add(svcKey)
              }
            }
          }
        }

        // Personalized PageRank (alpha = 0.85, 10 power iterations)
        const rawSeeds = new Map<string, number>()
        rawSeeds.set(holeKey, 1.0)
        for (const k of [
          ...outputSchemaKeys,
          ...inputSchemaKeys,
          ...directErrorKeys,
          ...directServiceKeys,
        ]) {
          rawSeeds.set(k, Math.max(rawSeeds.get(k) ?? 0, 1.0))
        }

        // +0.5 seed weight bonus for EARS specified-target / realizing-symbol neighbors
        for (const [, traceRoleMap] of traceRoles.entries()) {
          const targets = new Set([
            ...(traceRoleMap.get("realizing-symbol") ?? []),
            ...(traceRoleMap.get("specified-target") ?? []),
            ...(traceRoleMap.get("exercised-span") ?? []),
          ])
          if (targets.has(holeKey)) {
            for (const entityKeys of traceRoleMap.values()) {
              for (const ek of entityKeys) {
                if (ek !== holeKey && allEntityKeys.has(ek)) {
                  rawSeeds.set(ek, Math.max(rawSeeds.get(ek) ?? 0, 0.5))
                }
              }
            }
          }
        }

        if (priors?.holeTeleportationWeights !== undefined) {
          for (const [k, weightMillis] of Object.entries(priors.holeTeleportationWeights)) {
            if (weightMillis > 0 && allEntityKeys.has(k)) {
              rawSeeds.set(k, Math.max(rawSeeds.get(k) ?? 0, weightMillis / 1000))
            }
          }
        }
        let seedSum = 0
        for (const w of rawSeeds.values()) {
          seedSum += w
        }
        const normalizedSeeds = new Map<string, number>()
        for (const [k, w] of rawSeeds.entries()) {
          normalizedSeeds.set(k, seedSum > 0 ? w / seedSum : 0)
        }

        let ppr = new Map<string, number>(normalizedSeeds)
        const alpha = 0.85
        for (let step = 0; step < 10; step++) {
          const nextPpr = new Map<string, number>()
          for (const [sKey, sWeight] of normalizedSeeds.entries()) {
            nextPpr.set(sKey, (1 - alpha) * sWeight)
          }
          let danglingMass = 0
          for (const [u, uMass] of ppr.entries()) {
            if (uMass <= 0) {
              continue
            }
            const neighbors = entityNeighbors.get(u)
            if (neighbors === undefined || neighbors.size === 0) {
              danglingMass += uMass
            } else {
              const share = (alpha * uMass) / neighbors.size
              for (const v of neighbors) {
                nextPpr.set(v, (nextPpr.get(v) ?? 0) + share)
              }
            }
          }
          if (danglingMass > 0) {
            for (const [sKey, sWeight] of normalizedSeeds.entries()) {
              nextPpr.set(sKey, (nextPpr.get(sKey) ?? 0) + alpha * danglingMass * sWeight)
            }
          }
          ppr = nextPpr
        }

        const holePkgPrefix = holeFn.file.split("/").slice(0, 3).join("/")
        const rawCandidates: Array<{
          readonly symbolKey: NodeKey
          readonly inhabitsChannel: "A" | "E" | "R" | "decider-delegate"
          readonly signatureSummary: string
          readonly rawMass: number
        }> = []

        const pushCandidate = (
          symbolKey: string,
          inhabitsChannel: "A" | "E" | "R" | "decider-delegate",
          signatureSummary: string,
          bonusMass: number,
        ): void => {
          const overrideMillis = priors?.holeTeleportationWeights[NodeKey.make(symbolKey)]
          const baseMass = ppr.get(symbolKey) ?? 0
          const effectiveMass =
            overrideMillis !== undefined
              ? Math.max(baseMass + bonusMass, overrideMillis / 1000)
              : baseMass + bonusMass
          rawCandidates.push({
            symbolKey: NodeKey.make(symbolKey),
            inhabitsChannel,
            signatureSummary,
            rawMass: effectiveMass,
          })
        }

        // Channel A: output/input SchemaDefs + same-domain SchemaDefs
        for (const [schemaKey, schemaNode] of schemasByKey.entries()) {
          const isDirectSchema = outputSchemaKeys.has(schemaKey) || inputSchemaKeys.has(schemaKey)
          const isSameScope = schemaNode.file.startsWith(holePkgPrefix)
          if (isDirectSchema || isSameScope || (ppr.get(schemaKey) ?? 0) > 0) {
            const schemaLabel = schemaNode.name ?? schemaNode.schemaName
            pushCandidate(
              schemaKey,
              "A",
              `Schema ${schemaLabel}${schemaNode.isBranded === true ? " (branded)" : ""}`,
              isDirectSchema ? 0.5 : isSameScope ? 0.15 : 0.05,
            )
          }
        }

        // Channel E: direct & spec-referenced TaggedErrors
        for (const errKey of Array.from(directErrorKeys).sort()) {
          const errNode = errorsByKey.get(errKey)
          if (errNode !== undefined) {
            pushCandidate(
              errKey,
              "E",
              `TaggedError<${errNode.tag ?? errNode.errorTag}>("${errNode.errorTag}")`,
              0.6,
            )
          }
        }

        // Channel R: direct & spec-referenced ServiceTags
        for (const svcKey of Array.from(directServiceKeys).sort()) {
          const svcNode = servicesByKey.get(svcKey)
          if (svcNode !== undefined) {
            pushCandidate(svcKey, "R", `Context.Service<${svcNode.name}>("${svcNode.tagId}")`, 0.6)
          }
        }

        // Channel decider-delegate: pure .decide / .evolve functions
        for (const [otherKey, otherFn] of fnsByKey.entries()) {
          if (otherKey === holeKey) {
            continue
          }
          if (isDeciderSpan(otherFn.spanName) || isReducerSpan(otherFn.spanName)) {
            const isSameScope = otherFn.file.startsWith(holePkgPrefix)
            pushCandidate(
              otherKey,
              "decider-delegate",
              `Effect.fn("${otherFn.spanName}") (${otherFn.qualname})`,
              isSameScope ? 0.45 : 0.2,
            )
          }
        }

        let maxRawMass = 0
        for (const c of rawCandidates) {
          if (c.rawMass > maxRawMass) {
            maxRawMass = c.rawMass
          }
        }

        const scoredCandidates: Array<InhabitingSymbolCandidate> = rawCandidates
          .map((c) => {
            const normalizedMillis =
              maxRawMass > 0
                ? Math.min(1000, Math.max(1, Math.round((c.rawMass / maxRawMass) * 950)))
                : 500
            const overrideMillis = priors?.holeTeleportationWeights[c.symbolKey]
            const finalScore =
              overrideMillis !== undefined
                ? Math.max(normalizedMillis, overrideMillis)
                : normalizedMillis
            return {
              symbolKey: c.symbolKey,
              inhabitsChannel: c.inhabitsChannel,
              signatureSummary: c.signatureSummary,
              pprScore: PageRankScoreMillis.make(finalScore),
            }
          })
          .sort((a, b) =>
            a.pprScore !== b.pprScore
              ? b.pprScore - a.pprScore
              : a.symbolKey.localeCompare(b.symbolKey),
          )

        // Cap ego-graph slice to <= 1500 estimated tokens
        const MAX_HOLE_TOKENS = 1500
        let estimatedTokens = Math.min(
          MAX_HOLE_TOKENS,
          96 + Math.ceil((holeFn.qualname.length + holeFn.spanName.length) / 4),
        )
        const boundedCandidates: Array<InhabitingSymbolCandidate> = []
        for (const cand of scoredCandidates) {
          const candTokens = Math.max(
            16,
            Math.ceil((cand.symbolKey.length + cand.signatureSummary.length + 16) / 4),
          )
          if (estimatedTokens + candTokens > MAX_HOLE_TOKENS) {
            break
          }
          boundedCandidates.push(cand)
          estimatedTokens += candTokens
        }

        const outputSchemaNames = Array.from(outputSchemaKeys)
          .map(
            (k) =>
              schemasByKey.get(k)?.name ??
              schemasByKey.get(k)?.schemaName ??
              k.replace(/^SchemaDef:/, ""),
          )
          .sort()
        const successTypeSignature =
          outputSchemaNames.length > 0
            ? outputSchemaNames.join(" | ")
            : (holeFn.successType ?? "unknown")
        const allowedErrorConstructors = Array.from(directErrorKeys)
          .map((k) => errTagByKey.get(k) ?? k.replace(/^TaggedError:/, ""))
          .sort()
        const requiredServiceCapabilities = Array.from(directServiceKeys)
          .map((k) => svcTagIdByKey.get(k) ?? k.replace(/^ServiceTag:/, ""))
          .sort()

        registerProof({
          proofId: ProofId.make(`proof:COMP-06:${holeKey}`),
          ruleId: DatalogRuleId.make("COMP-06"),
          stratum: StratumIndex.make(3),
          proofHeight: ProofHeight.make(1),
          conclusion: `SuggestedHoleInhabitant(${holeKey}, candidates=${boundedCandidates.length})`,
          premises: [
            `StubEffectFn(${holeKey})`,
            ...boundedCandidates
              .slice(0, 4)
              .map((c) => `Inhabits(${c.symbolKey}, ${c.inhabitsChannel})`),
          ],
          parentProofIds: [],
          witnessPath: [holeFn.qualname, ...boundedCandidates.slice(0, 4).map((c) => c.symbolKey)],
        })

        typedHoleBundles.push({
          holeQualname: holeFn.qualname,
          spanName: holeFn.spanName,
          successTypeSignature,
          allowedErrorConstructors,
          requiredServiceCapabilities,
          inhabitingCandidates: boundedCandidates,
          estimatedTokens,
        })
      }

      antiPatterns.sort((a, b) =>
        a.ruleId !== b.ruleId
          ? a.ruleId.localeCompare(b.ruleId)
          : a.nodeKey !== b.nodeKey
            ? a.nodeKey.localeCompare(b.nodeKey)
            : (a.targetKey ?? "").localeCompare(b.targetKey ?? ""),
      )

      finalSuggestedEdges.sort((a, b) =>
        a.ruleId !== b.ruleId
          ? a.ruleId.localeCompare(b.ruleId)
          : a.relationId !== b.relationId
            ? a.relationId.localeCompare(b.relationId)
            : a.targetEntityKey.localeCompare(b.targetEntityKey),
      )

      const proofs = Array.from(proofsById.values()).sort((a, b) =>
        a.stratum !== b.stratum ? a.stratum - b.stratum : a.proofId.localeCompare(b.proofId),
      )

      let maxDepth = 0
      for (const [, ann] of collectedCallReachProvenance) {
        if (ann.proofHeight > maxDepth) {
          maxDepth = ann.proofHeight
        }
      }
      for (const proof of proofsById.values()) {
        if (proof.proofHeight !== undefined && proof.proofHeight > maxDepth) {
          maxDepth = proof.proofHeight
        }
      }
      const hasGraphContent = Graph.nodeCount(harnessGraph.graph) > 0 || directCallPairs.length > 0
      const iterations = hasGraphContent ? Math.max(1, maxDepth) : 0

      return {
        effectiveRequires,
        effectiveFailsWith,
        effectiveLayerDeps,
        effectiveTestReach,
        antiPatterns,
        suggestedEdges: finalSuggestedEdges,
        typedHoleBundles,
        proofs,
        iterations,
      }
    },
    catch: (err) =>
      new GraphInferenceError({
        reason: "d2ts-execution-failed",
        message: String(err),
      }),
  })
})

export interface DatalogFileDeltaStepInput {
  readonly filePath: DatalogFilePath
  readonly nextGraph: HarnessGraph
  readonly priors?: SemanticEdgePriors | undefined
}

export interface DatalogSessionSnapshot {
  readonly epoch: NonNegativeCount
  readonly graph: HarnessGraph
  readonly inference: GraphInferenceResult
}

export interface DatalogSessionShape {
  readonly currentGraph: Effect.Effect<HarnessGraph>
  readonly latestInference: Effect.Effect<GraphInferenceResult, GraphInferenceError>
  readonly snapshot: Effect.Effect<DatalogSessionSnapshot>
  readonly stepFileDelta: (
    input: DatalogFileDeltaStepInput,
  ) => Effect.Effect<DatalogFileDeltaResult, GraphInferenceError>
}

const getEntityNodeFilePath = (node: HarnessNode): string | undefined =>
  match(node)
    .with(
      { _tag: "EffectFn" },
      { _tag: "ServiceTag" },
      { _tag: "ServiceLayer" },
      { _tag: "TaggedError" },
      { _tag: "SchemaDef" },
      (n) => n.file,
    )
    .with({ _tag: "VitestCase" }, (n) => n.testFile)
    .with({ _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, (n) => n.path)
    .with({ _tag: "MigrationTuple" }, (n) => n.moduleFile)
    .with({ _tag: "EffectSignature" }, (n) => n.file)
    .with({ _tag: "LayerFlow" }, (n) => n.file)
    .with({ _tag: "HttpEndpointTuple" }, (n) => n.file)
    .with({ _tag: "TraceabilityTuple" }, (n) => {
      const hashIdx = n.targetSymbolQualname.indexOf("#")
      return hashIdx > 0 ? n.targetSymbolQualname.slice(0, hashIdx) : undefined
    })
    .exhaustive()

export const normalizeWorkspacePath = (p: string): string => {
  const forward = p.trim().replace(/\\/g, "/").replace(/\/+/g, "/")
  const withoutLeadingDot = forward.replace(/^\.\//, "")
  const workspaceAnchor = /(?:^|\/)((?:libs|apps|packages|tools|docs|samples)\/.+)$/.exec(
    withoutLeadingDot,
  )
  if (workspaceAnchor?.[1] !== undefined) {
    return workspaceAnchor[1]
  }
  return withoutLeadingDot.replace(/^\/+/, "")
}

const matchesFilePath = (candidateFile: string | undefined, targetFile: string): boolean => {
  if (candidateFile === undefined) {
    return false
  }
  const normCandidate = normalizeWorkspacePath(candidateFile)
  const normTarget = normalizeWorkspacePath(targetFile)
  return normCandidate.length > 0 && normCandidate === normTarget
}

const computeGraphStructureFingerprint = (graph: HarnessGraph): string => {
  const nodeEntries: Array<string> = []
  for (const [, node] of Graph.nodes(graph.graph)) {
    nodeEntries.push(`${getNodeKey(node)}:${JSON.stringify(node)}`)
  }
  nodeEntries.sort()

  const edgeEntries: Array<string> = []
  for (const [, edge] of Graph.edges(graph.graph)) {
    edgeEntries.push(`${getEdgeKey(edge.data)}:${JSON.stringify(edge.data)}`)
  }
  edgeEntries.sort()

  return JSON.stringify({
    nodes: nodeEntries,
    edges: edgeEntries,
    violations: graph.branchingViolations ?? [],
    unresolved: graph.unresolvedReferences ?? [],
  })
}

const extractFileEdbFacts = (
  graph: HarnessGraph,
  targetFile?: string,
): Map<string, ReadonlyArray<string>> => {
  const normalizedTarget = targetFile !== undefined ? normalizeWorkspacePath(targetFile) : undefined
  const nodeFileByKey = new Map<string, string>()
  const factsByFile = new Map<string, Set<string>>()

  const addFact = (rawFile: string, fact: string): void => {
    const normalizedFile = normalizeWorkspacePath(rawFile)
    if (normalizedFile.length === 0) {
      return
    }
    if (normalizedTarget !== undefined && normalizedFile !== normalizedTarget) {
      return
    }
    let set = factsByFile.get(normalizedFile)
    if (set === undefined) {
      set = new Set<string>()
      factsByFile.set(normalizedFile, set)
    }
    set.add(fact)
  }

  for (const [, node] of Graph.nodes(graph.graph)) {
    const key = getNodeKey(node)
    const rawFile = getEntityNodeFilePath(node) ?? normalizedTarget
    if (rawFile !== undefined) {
      const normalizedFile = normalizeWorkspacePath(rawFile)
      nodeFileByKey.set(key, normalizedFile)
      if (isRelationNode(node)) {
        nodeFileByKey.set(node.relationId, normalizedFile)
      }
      addFact(normalizedFile, `node:${key}:${JSON.stringify(node)}`)
    }
  }

  for (const [, edge] of Graph.edges(graph.graph)) {
    const data = edge.data
    const relFile = nodeFileByKey.get(data.relationId)
    const entFile = nodeFileByKey.get(data.entityKey)
    const edgeFact = `edge:${getEdgeKey(data)}`
    if (relFile !== undefined) {
      addFact(relFile, edgeFact)
    }
    if (entFile !== undefined && entFile !== relFile) {
      addFact(entFile, edgeFact)
    }
  }

  const out = new Map<string, ReadonlyArray<string>>()
  for (const [file, set] of factsByFile.entries()) {
    out.set(file, Array.from(set).sort())
  }
  return out
}

const mergeFileSubgraphIntoWorkspace = (
  baseGraph: HarnessGraph,
  filePath: string,
  nextGraph: HarnessGraph,
): HarnessGraph => {
  const normalizedTarget = normalizeWorkspacePath(filePath)
  const removedEntityKeys = new Set<string>()
  const removedRelationIds = new Set<string>()
  const keptNodes = new Map<string, HarnessNode>()

  for (const [, node] of Graph.nodes(baseGraph.graph)) {
    const key = getNodeKey(node)
    const file = getEntityNodeFilePath(node)
    if (matchesFilePath(file, normalizedTarget)) {
      if (isEntityNode(node)) {
        removedEntityKeys.add(key)
      } else if (isRelationNode(node)) {
        removedRelationIds.add(node.relationId)
        removedRelationIds.add(key)
      }
      continue
    }
    keptNodes.set(key, node)
  }

  // Determine which remaining relations in baseGraph were exclusively owned by removedEntityKeys
  const relationIncidentNonRemoved = new Set<string>()
  const relationIncidentRemoved = new Set<string>()
  for (const [, edge] of Graph.edges(baseGraph.graph)) {
    const { relationId, entityKey } = edge.data
    if (removedEntityKeys.has(entityKey)) {
      relationIncidentRemoved.add(relationId)
    } else {
      relationIncidentNonRemoved.add(relationId)
    }
  }

  for (const [key, node] of Array.from(keptNodes.entries())) {
    if (isRelationNode(node)) {
      if (
        relationIncidentRemoved.has(node.relationId) &&
        !relationIncidentNonRemoved.has(node.relationId)
      ) {
        keptNodes.delete(key)
        removedRelationIds.add(node.relationId)
        removedRelationIds.add(key)
      }
    }
  }

  for (const [, node] of Graph.nodes(nextGraph.graph)) {
    keptNodes.set(getNodeKey(node), node)
  }

  const keptEdges = new Map<string, HarnessEdge>()
  for (const [, edge] of Graph.edges(baseGraph.graph)) {
    const data = edge.data
    if (removedRelationIds.has(data.relationId)) {
      continue
    }
    const relNodeKeyExists =
      keptNodes.has(data.relationId) ||
      Array.from(keptNodes.values()).some(
        (n) => isRelationNode(n) && n.relationId === data.relationId,
      )
    if (relNodeKeyExists && keptNodes.has(data.entityKey)) {
      keptEdges.set(getEdgeKey(data), data)
    }
  }
  for (const [, edge] of Graph.edges(nextGraph.graph)) {
    keptEdges.set(getEdgeKey(edge.data), edge.data)
  }

  const nodeIndexByKey = new Map<string, Graph.NodeIndex>()
  const directed = Graph.directed<HarnessNode, HarnessEdge>((mutable) => {
    for (const [key, node] of keptNodes.entries()) {
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(key, idx)
      if (isRelationNode(node)) {
        nodeIndexByKey.set(node.relationId, idx)
      }
    }
    for (const edge of keptEdges.values()) {
      const relIdx = nodeIndexByKey.get(edge.relationId)
      const entIdx = nodeIndexByKey.get(edge.entityKey)
      if (relIdx !== undefined && entIdx !== undefined) {
        Graph.addEdge(mutable, relIdx, entIdx, edge)
      }
    }
  })

  const preservedViolations = (baseGraph.branchingViolations ?? []).filter(
    (v) => !matchesFilePath(v.file, normalizedTarget),
  )
  const nextViolations = nextGraph.branchingViolations ?? []

  const preservedUnresolved = (baseGraph.unresolvedReferences ?? []).filter(
    (u) => !matchesFilePath(u.file, normalizedTarget),
  )
  const nextUnresolved = nextGraph.unresolvedReferences ?? []

  return {
    [HarnessGraphTypeId]: HarnessGraphTypeId,
    graph: directed,
    nodeIndexByKey,
    branchingViolations: [...preservedViolations, ...nextViolations],
    unresolvedReferences: [...preservedUnresolved, ...nextUnresolved],
  }
}

const MAX_D2_STEPS = 10_000

const stepD2Bounded = (d2: D2): boolean => {
  let steps = 0
  while (d2.pendingWork()) {
    if (steps >= MAX_D2_STEPS) {
      return false
    }
    d2.step()
    steps += 1
  }
  return true
}

export class DatalogSession extends Context.Service<DatalogSession, DatalogSessionShape>()(
  "@harness/graph/DatalogSession",
) {
  static readonly make = (
    initialGraph: HarnessGraph,
    initialPriors?: SemanticEdgePriors,
  ): Effect.Effect<DatalogSessionShape, GraphInferenceError> =>
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1)
      let activeGraph = initialGraph
      let activePriors = initialPriors
      let activeFingerprint = computeGraphStructureFingerprint(initialGraph)
      let activeInference = yield* decideGraphInference(initialGraph, initialPriors).pipe(
        Effect.mapError((err) =>
          match(err)
            .with({ _tag: "GraphInferenceError" }, (e) => e)
            .with(
              { _tag: "ConceptLatticeCycleError" },
              (e) =>
                new GraphInferenceError({
                  reason: "concept-lattice-cycle",
                  message: e.message,
                }),
            )
            .exhaustive(),
        ),
      )
      let currentEpoch = 0

      const fileFactsByPath = new Map<string, ReadonlyArray<string>>()
      const initialFactsMap = extractFileEdbFacts(initialGraph)
      for (const [file, facts] of initialFactsMap.entries()) {
        fileFactsByPath.set(file, facts)
      }

      const materializedEdbZSet = new Map<string, number>()
      const d2 = new D2({ initialFrontier: 0 })
      const inFileEdb = d2.newInput<KeyValue<string, string>>()
      inFileEdb.pipe(
        distinct(),
        consolidate(),
        output((msg) => {
          match(msg)
            .with({ type: MessageType.DATA }, ({ data }) => {
              for (const [[fact, file], weight] of data.collection.getInner()) {
                const compositeKey = `${file}::${fact}`
                const nextWeight = (materializedEdbZSet.get(compositeKey) ?? 0) + weight
                if (nextWeight <= 0) {
                  materializedEdbZSet.delete(compositeKey)
                } else {
                  materializedEdbZSet.set(compositeKey, nextWeight)
                }
              }
            })
            .with({ type: MessageType.FRONTIER }, () => undefined)
            .exhaustive()
        }),
      )
      d2.finalize()

      const initialEntries: Array<[KeyValue<string, string>, number]> = []
      for (const [file, facts] of fileFactsByPath.entries()) {
        for (const fact of facts) {
          initialEntries.push([[fact, file], 1])
        }
      }
      const initialConverged = yield* Effect.try({
        try: () => {
          const nextEpoch = currentEpoch + 1
          inFileEdb.sendData(currentEpoch, new MultiSet(initialEntries))
          inFileEdb.sendFrontier(nextEpoch)
          const converged = stepD2Bounded(d2)
          if (converged) {
            currentEpoch = nextEpoch
          }
          return converged
        },
        catch: (err) =>
          new GraphInferenceError({
            reason: "d2ts-session-step-failed",
            message: String(err),
          }),
      })
      if (!initialConverged) {
        return yield* new GraphInferenceError({
          reason: "d2ts-session-step-failed",
          message: `D2 session exceeded ${MAX_D2_STEPS} pending steps without converging.`,
        })
      }

      return DatalogSession.of({
        currentGraph: Effect.sync(() => activeGraph),
        latestInference: Effect.sync(() => activeInference),
        snapshot: semaphore.withPermits(1)(
          Effect.sync(() => ({
            epoch: NonNegativeCount.make(currentEpoch),
            graph: activeGraph,
            inference: activeInference,
          })),
        ),
        stepFileDelta: (input) =>
          semaphore.withPermits(1)(
            Effect.gen(function* () {
              const normalizedTarget = normalizeWorkspacePath(input.filePath)
              if (normalizedTarget.length === 0) {
                return yield* new GraphInferenceError({
                  reason: "invalid-graph",
                  message: `Invalid empty or whitespace filePath '${input.filePath}' passed to DatalogSession.stepFileDelta.`,
                })
              }

              // Phase 1: Compute merged graph, Z-set delta entries, and next inference BEFORE mutating D2 or session state
              const nextPriors = input.priors !== undefined ? input.priors : activePriors
              const mergedGraph = mergeFileSubgraphIntoWorkspace(
                activeGraph,
                normalizedTarget,
                input.nextGraph,
              )

              const oldFacts = new Set<string>(fileFactsByPath.get(normalizedTarget) ?? [])
              const nextFileMap = extractFileEdbFacts(mergedGraph, normalizedTarget)
              const newFactsArray = nextFileMap.get(normalizedTarget) ?? []
              const newFacts = new Set<string>(newFactsArray)

              const deltaEntries: Array<[KeyValue<string, string>, number]> = []
              let retractedFactCount = 0
              let insertedFactCount = 0

              for (const oldFact of oldFacts) {
                if (!newFacts.has(oldFact)) {
                  deltaEntries.push([[oldFact, normalizedTarget], -1])
                  retractedFactCount += 1
                }
              }
              for (const newFact of newFacts) {
                if (!oldFacts.has(newFact)) {
                  deltaEntries.push([[newFact, normalizedTarget], 1])
                  insertedFactCount += 1
                }
              }

              const nextFingerprint = computeGraphStructureFingerprint(mergedGraph)
              const isNoOpDelta =
                retractedFactCount === 0 &&
                insertedFactCount === 0 &&
                input.priors === undefined &&
                activeFingerprint === nextFingerprint

              const nextInference = isNoOpDelta
                ? activeInference
                : yield* decideGraphInference(mergedGraph, nextPriors).pipe(
                    Effect.mapError((err) =>
                      match(err)
                        .with({ _tag: "GraphInferenceError" }, (e) => e)
                        .with(
                          { _tag: "ConceptLatticeCycleError" },
                          (e) =>
                            new GraphInferenceError({
                              reason: "concept-lattice-cycle",
                              message: e.message,
                            }),
                        )
                        .exhaustive(),
                    ),
                  )

              // Phase 2: Commit Z-set delta to D2 and update session state atomically
              const nextEpoch = currentEpoch + 1
              const stepConverged = yield* Effect.try({
                try: () => {
                  inFileEdb.sendData(currentEpoch, new MultiSet(deltaEntries))
                  inFileEdb.sendFrontier(nextEpoch)
                  return stepD2Bounded(d2)
                },
                catch: (err) =>
                  new GraphInferenceError({
                    reason: "d2ts-session-step-failed",
                    message: String(err),
                  }),
              })
              if (!stepConverged) {
                return yield* new GraphInferenceError({
                  reason: "d2ts-session-step-failed",
                  message: `D2 session exceeded ${MAX_D2_STEPS} pending steps without converging.`,
                })
              }

              currentEpoch = nextEpoch
              if (newFactsArray.length > 0) {
                fileFactsByPath.set(normalizedTarget, newFactsArray)
              } else {
                fileFactsByPath.delete(normalizedTarget)
              }
              activeGraph = mergedGraph
              activePriors = nextPriors
              activeFingerprint = nextFingerprint
              activeInference = nextInference

              return {
                filePath: input.filePath,
                epoch: NonNegativeCount.make(currentEpoch),
                retractedFactCount: NonNegativeCount.make(retractedFactCount),
                insertedFactCount: NonNegativeCount.make(insertedFactCount),
                inference: activeInference,
              } satisfies DatalogFileDeltaResult
            }),
          ),
      })
    })

  static readonly layer = (
    initialGraph: HarnessGraph,
    priors?: SemanticEdgePriors,
  ): Layer.Layer<DatalogSession, GraphInferenceError> =>
    Layer.effect(DatalogSession, DatalogSession.make(initialGraph, priors))
}

export const datalogSessionLive: Layer.Layer<DatalogSession, GraphInferenceError> = Layer.effect(
  DatalogSession,
  Effect.suspend(() =>
    DatalogSession.make({
      [HarnessGraphTypeId]: HarnessGraphTypeId,
      graph: Graph.directed<HarnessNode, HarnessEdge>(() => {}),
      nodeIndexByKey: new Map(),
      branchingViolations: [],
      unresolvedReferences: [],
    }),
  ),
)

export const stepDatalogFileDelta = Effect.fn("DatalogSession.stepFileDelta")(function* (
  input: DatalogFileDeltaStepInput,
): Effect.fn.Return<DatalogFileDeltaResult, GraphInferenceError, DatalogSession> {
  const session = yield* DatalogSession
  return yield* session.stepFileDelta(input)
})
