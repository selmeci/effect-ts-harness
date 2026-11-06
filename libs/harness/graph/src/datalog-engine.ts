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
import { Effect } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  type AdrDocNode,
  ConfidenceMillis,
  type DatalogRule,
  DatalogRuleId,
  type DerivationProof,
  type EarsSpecNode,
  type EffectFnNode,
  type EffectiveErrorPropagation,
  type EffectiveLayerDependency,
  type EffectiveServiceRequirement,
  type EffectiveTestReachability,
  type GraphInferenceResult,
  type HarnessGraph,
  type InhabitingSymbolCandidate,
  type InferredAntiPattern,
  type MigrationTupleRelation,
  type MinHeightProvenanceAnnotation,
  NodeKey,
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
  getNodeKey,
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
 * Retains only the minimal-height derivation witness for each derived tuple, guaranteeing
 * fixed-point convergence in at most `|V_E|` steps even on cyclic call graphs.
 */
export const minHeightReducer = (
  values: ReadonlyArray<readonly [MinHeightProvenanceAnnotation, number]>,
): Array<[MinHeightProvenanceAnnotation, number]> => {
  const positive = values.filter(([, mult]) => mult > 0).map(([v]) => v)
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
 * `(c1, P1) ⊔ (c2, P2) = (max(c1, c2), dedupSort(P1 ∪ P2))`.
 */
export const flixConfidenceReducer = (
  values: ReadonlyArray<readonly [FlixConfidenceLatticeElement, number]>,
): Array<[FlixConfidenceLatticeElement, number]> => {
  const positive = values.filter(([, mult]) => mult > 0).map(([v]) => v)
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
    description:
      "Transitive Layer dependency closure and VitestCase -> EffectFn reachability.",
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
      "Compute 1-hop type-compatible inhabitants and Personalized PageRank ego-graph context bundles for Hazel typed holes (EffectFn with isStub: true).",
    hasNegation: false,
    isRecursive: false,
  },
]

const collectPositiveData = <T>(
  messages: Array<T>,
  handler: (msg: Message<T>) => void,
): ((msg: Message<T>) => void) => {
  void messages
  return handler
}

const makeOutputCollector = <T>(target: Array<T>): ((msg: Message<T>) => void) =>
  collectPositiveData(target, (msg) => {
    match(msg)
      .with({ type: MessageType.DATA }, ({ data }) => {
        for (const [item, multiplicity] of data.collection.getInner()) {
          if (multiplicity > 0) {
            target.push(item)
          }
        }
      })
      .with({ type: MessageType.FRONTIER }, () => undefined)
      .exhaustive()
  })

const shortestCallWitnessPath = (
  startCallerKey: string,
  targetCalleeKey: string,
  directOutgoingCalls: ReadonlyMap<string, ReadonlyArray<string>>,
  fnQualnameByKey: ReadonlyMap<string, string>,
): ReadonlyArray<string> => {
  const startQual = fnQualnameByKey.get(startCallerKey) ?? startCallerKey
  const targetQual = fnQualnameByKey.get(targetCalleeKey) ?? targetCalleeKey
  if (startCallerKey === targetCalleeKey) {
    return [startQual]
  }
  const visited = new Set<string>([startCallerKey])
  const queue: Array<ReadonlyArray<string>> = [[startCallerKey]]
  while (queue.length > 0) {
    const currentPath = queue.shift()
    if (currentPath === undefined) {
      break
    }
    const last = currentPath[currentPath.length - 1]
    if (last === undefined) {
      continue
    }
    const nexts = directOutgoingCalls.get(last) ?? []
    for (const nextKey of nexts) {
      const nextPath = [...currentPath, nextKey]
      if (nextKey === targetCalleeKey) {
        return nextPath.map((k) => fnQualnameByKey.get(k) ?? k)
      }
      if (!visited.has(nextKey)) {
        visited.add(nextKey)
        queue.push(nextPath)
      }
    }
  }
  return [startQual, targetQual]
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
export const decideGraphInference = Effect.fn("GraphInfer.decide")(
  (
    harnessGraph: HarnessGraph,
    priors?: SemanticEdgePriors,
  ): Effect.Effect<GraphInferenceResult, never, never> =>
    Effect.sync(() => {
      let iterations = 0

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

      // ----------------------------------------------------------------------
      // Stratum S_1: Recursive Positive Closures (.iterate() + reduce(minHeightReducer))
      // ----------------------------------------------------------------------
      // 1. Transitive Call Reachability with Soufflé Min-Height Provenance Semiring
      const maxGraphDepth = Math.max(1, fnsByKey.size + 1)
      const callReachProvenanceStream = inDirectCalls.pipe(
        iterate((reach) => {
          const byCallee = reach.pipe(
            map(([pairKey, ann]): KeyValue<string, readonly [string, number]> => {
              iterations += 1
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

      const collectedCallReachProvenance: Array<KeyValue<string, MinHeightProvenanceAnnotation>> = []
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
        map(([_svcKey, [consumerLayerKey, providerLayerKey]]): KeyValue<string, [string, string]> => [
          `${consumerLayerKey}->${providerLayerKey}`,
          [consumerLayerKey, providerLayerKey],
        ]),
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
      const comp01Stream = inSpecExpectedErrors.pipe(
        antiJoin(directFailsKeyed),
        consolidate(),
      )
      const collectedComp01: Array<KeyValue<string, [[string, string, string], null]>> = []
      comp01Stream.pipe(output(makeOutputCollector(collectedComp01)))

      // COMP-02: Spec expected service on caller antiJoin DirectRequiresKeyed
      const comp02Stream = inSpecExpectedServices.pipe(
        antiJoin(directRequiresKeyed),
        consolidate(),
      )
      const collectedComp02: Array<KeyValue<string, [[string, string, string], null]>> = []
      comp02Stream.pipe(output(makeOutputCollector(collectedComp02)))

      // COMP-03: Required service by EffectSignature antiJoin LayerProvides
      const fnRequiredBySvcKey = inDirectRequires.pipe(
        map(([callerKey, svcKey]): KeyValue<string, string> => [svcKey, callerKey]),
        distinct(),
      )
      const comp03Stream = fnRequiredBySvcKey.pipe(
        antiJoin(inLayerProvides),
        consolidate(),
      )
      const collectedComp03: Array<KeyValue<string, [string, null]>> = []
      comp03Stream.pipe(output(makeOutputCollector(collectedComp03)))

      // COMP-05: AdrExpectedTargets antiJoin ExistingTraceAdrs
      const comp05Stream = inAdrExpectedTargets.pipe(
        antiJoin(inExistingTraceAdrs),
        consolidate(),
      )
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
        new MultiSet(
          directLayerProvidesPairs.map(([layerKey, svcKey]) => [[svcKey, layerKey], 1]),
        ),
      )
      inLayerProvides.sendFrontier(1)

      inLayerRequires.sendData(
        0,
        new MultiSet(
          directLayerRequiresPairs.map(([layerKey, svcKey]) => [[svcKey, layerKey], 1]),
        ),
      )
      inLayerRequires.sendFrontier(1)

      inDirectTestSpans.sendData(
        0,
        new MultiSet(
          directTestSpanPairs.map(([testKey, targetKey]) => [[targetKey, testKey], 1]),
        ),
      )
      inDirectTestSpans.sendFrontier(1)

      const domainNonStubEntries: Array<[KeyValue<string, string>, number]> = []
      for (const [fnKey, fnNode] of fnsByKey.entries()) {
        if ((fnNode.packageTag === "domain" || fnNode.packageTag === "contract") && !fnNode.isStub) {
          domainNonStubEntries.push([[fnKey, fnKey], 1])
        }
      }
      inDomainNonStubFns.sendData(0, new MultiSet(domainNonStubEntries))
      inDomainNonStubFns.sendFrontier(1)

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

      // Prepare Spec expected error & service triples for COMP-01 and COMP-02
      const specExpectedErrorEntries: Array<[KeyValue<string, [string, string, string]>, number]> = []
      const specExpectedServiceEntries: Array<[KeyValue<string, [string, string, string]>, number]> = []
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
            if (svcNode.tagId === svcName || svcNode.name === svcName || svcNode.tagId.endsWith(`#${svcName}`)) {
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
        if (adrNode.status !== "accepted") {
          continue
        }
        for (const enforcedFile of adrNode.enforcedByFiles) {
          for (const [fnKey, fnNode] of fnsByKey.entries()) {
            if (fnNode.file === enforcedFile || fnNode.file.endsWith(enforcedFile)) {
              adrExpectedEntries.push([
                [`${adrKey}->${fnKey}`, [adrKey, fnKey]],
                1,
              ])
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
              const candidate = shortestCallWitnessPath(
                callerKey,
                calleeKey,
                directOutgoingCalls,
                fnQualnameByKey,
              )
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
              const candidate = shortestCallWitnessPath(
                callerKey,
                calleeKey,
                directOutgoingCalls,
                fnQualnameByKey,
              )
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

      // INF-04, INF-05 (service), INF-08 (service): Over EffectiveRequires
      for (const req of effectiveRequires) {
        const fnNode = fnsByKey.get(req.callerKey)
        const svcNode = servicesByKey.get(req.serviceKey)
        if (fnNode === undefined || svcNode === undefined) {
          continue
        }

        // INF-04: domain-requires-infra / domain-requires-cloud-binding
        if (fnNode.packageTag === "domain") {
          if (svcNode.packageTag === "infra") {
            const proof = registerProof({
              proofId: ProofId.make(
                `proof:INF-04:domain-requires-infra:${req.callerKey}->${req.serviceKey}`,
              ),
              ruleId: DatalogRuleId.make("INF-04"),
              stratum: StratumIndex.make(2),
              conclusion: `AntiPattern(domain-requires-infra, ${req.callerKey}, ${req.serviceKey})`,
              premises: [req.proof.conclusion, `PackageTag(${req.serviceKey}, infra)`],
              parentProofIds: [req.proof.proofId],
            })
            antiPatterns.push({
              ruleId: "domain-requires-infra",
              datalogRuleId: DatalogRuleId.make("INF-04"),
              nodeKey: req.callerKey,
              targetKey: req.serviceKey,
              path: req.path,
              message: `Domain Effect.fn '${fnNode.spanName}' (${fnNode.qualname}) requires infra ServiceTag '${svcNode.tagId}'`,
              proof,
            })
          } else if (isCloudBinding(svcNode)) {
            const proof = registerProof({
              proofId: ProofId.make(
                `proof:INF-04:domain-requires-cloud-binding:${req.callerKey}->${req.serviceKey}`,
              ),
              ruleId: DatalogRuleId.make("INF-04"),
              stratum: StratumIndex.make(2),
              conclusion: `AntiPattern(domain-requires-cloud-binding, ${req.callerKey}, ${req.serviceKey})`,
              premises: [req.proof.conclusion, `CloudBinding(${req.serviceKey})`],
              parentProofIds: [req.proof.proofId],
            })
            antiPatterns.push({
              ruleId: "domain-requires-cloud-binding",
              datalogRuleId: DatalogRuleId.make("INF-04"),
              nodeKey: req.callerKey,
              targetKey: req.serviceKey,
              path: req.path,
              message: `Domain Effect.fn '${fnNode.spanName}' (${fnNode.qualname}) requires cloud binding '${svcNode.tagId}'`,
              proof,
            })
          }
        }

        // INF-05a: impure-decider
        if (
          (fnNode.packageTag === "domain" || fnNode.packageTag === "contract") &&
          isDeciderSpan(fnNode.spanName)
        ) {
          const proof = registerProof({
            proofId: ProofId.make(`proof:INF-05:impure-decider:${req.callerKey}->${req.serviceKey}`),
            ruleId: DatalogRuleId.make("INF-05"),
            stratum: StratumIndex.make(2),
            conclusion: `AntiPattern(impure-decider, ${req.callerKey}, ${req.serviceKey})`,
            premises: [req.proof.conclusion, `DeciderSpan(${fnNode.spanName})`],
            parentProofIds: [req.proof.proofId],
          })
          antiPatterns.push({
            ruleId: "impure-decider",
            datalogRuleId: DatalogRuleId.make("INF-05"),
            nodeKey: req.callerKey,
            targetKey: req.serviceKey,
            path: req.path,
            message: `Decider '${fnNode.spanName}' (${fnNode.qualname}) must be pure (R = never) but requires service '${svcNode.tagId}'`,
            proof,
          })
        }

        // INF-05b: impure-reducer (requires service)
        if (
          (fnNode.packageTag === "domain" || fnNode.packageTag === "contract") &&
          isReducerSpan(fnNode.spanName)
        ) {
          const proof = registerProof({
            proofId: ProofId.make(
              `proof:INF-05:impure-reducer:svc:${req.callerKey}->${req.serviceKey}`,
            ),
            ruleId: DatalogRuleId.make("INF-05"),
            stratum: StratumIndex.make(2),
            conclusion: `AntiPattern(impure-reducer, ${req.callerKey}, ${req.serviceKey})`,
            premises: [req.proof.conclusion, `ReducerSpan(${fnNode.spanName})`],
            parentProofIds: [req.proof.proofId],
          })
          antiPatterns.push({
            ruleId: "impure-reducer",
            datalogRuleId: DatalogRuleId.make("INF-05"),
            nodeKey: req.callerKey,
            targetKey: req.serviceKey,
            path: req.path,
            message: `Reducer '${fnNode.spanName}' (${fnNode.qualname}) is a reducer (.evolve/.fold) which must be pure and cannot require service '${svcNode.tagId}'`,
            proof,
          })
        }

        // INF-08a: aggregate-direct-bus-publish (aggregate requires EventBus)
        if (isAggregateFnNode(fnNode) && isEventBusServiceNode(svcNode)) {
          const proof = registerProof({
            proofId: ProofId.make(
              `proof:INF-08:bus-svc:${req.callerKey}->${req.serviceKey}`,
            ),
            ruleId: DatalogRuleId.make("INF-08"),
            stratum: StratumIndex.make(2),
            conclusion: `AntiPattern(aggregate-direct-bus-publish, ${req.callerKey}, ${req.serviceKey})`,
            premises: [req.proof.conclusion, `AggregateFn(${fnNode.qualname})`, `EventBus(${svcNode.tagId})`],
            parentProofIds: [req.proof.proofId],
          })
          antiPatterns.push({
            ruleId: "aggregate-direct-bus-publish",
            datalogRuleId: DatalogRuleId.make("INF-08"),
            nodeKey: req.callerKey,
            targetKey: req.serviceKey,
            path: req.path,
            message: `Aggregate function '${fnNode.spanName}' (${fnNode.qualname}) directly requires EventBus '${svcNode.tagId}'; use transactional Outbox instead`,
            proof,
          })
        }
      }

      // INF-05c: impure-reducer (fails with error) over EffectiveFailsWith
      for (const fail of effectiveFailsWith) {
        const fnNode = fnsByKey.get(fail.callerKey)
        const errNode = errorsByKey.get(fail.errorKey)
        if (fnNode === undefined || errNode === undefined) {
          continue
        }
        if (
          (fnNode.packageTag === "domain" || fnNode.packageTag === "contract") &&
          isReducerSpan(fnNode.spanName)
        ) {
          const proof = registerProof({
            proofId: ProofId.make(
              `proof:INF-05:impure-reducer:err:${fail.callerKey}->${fail.errorKey}`,
            ),
            ruleId: DatalogRuleId.make("INF-05"),
            stratum: StratumIndex.make(2),
            conclusion: `AntiPattern(impure-reducer, ${fail.callerKey}, ${fail.errorKey})`,
            premises: [fail.proof.conclusion, `ReducerSpan(${fnNode.spanName})`],
            parentProofIds: [fail.proof.proofId],
          })
          antiPatterns.push({
            ruleId: "impure-reducer",
            datalogRuleId: DatalogRuleId.make("INF-05"),
            nodeKey: fail.callerKey,
            targetKey: fail.errorKey,
            path: fail.path,
            message: `Reducer '${fnNode.spanName}' (${fnNode.qualname}) is a reducer (.evolve/.fold) which must be infallible and cannot fail with '${errNode.errorTag}'`,
            proof,
          })
        }
      }

      // INF-08b: aggregate-direct-bus-publish via CallReach to Outbox.drain / EventBus.publish
      const sortedCallReach = [...collectedCallReach].sort((a, b) => a[0].localeCompare(b[0]))
      for (const [, [callerKey, calleeKey]] of sortedCallReach) {
        const callerNode = fnsByKey.get(callerKey)
        const calleeNode = fnsByKey.get(calleeKey)
        if (callerNode === undefined || calleeNode === undefined) {
          continue
        }
        if (isAggregateFnNode(callerNode) && isOutboxDrainOrBusPublishFnNode(calleeNode)) {
          const rawWitness = shortestCallWitnessPath(
            callerKey,
            calleeKey,
            directOutgoingCalls,
            fnQualnameByKey,
          )
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
          premises: [`LayerRequires(${consumerLayerKey}, ${reqSvcKey})`, `!LayerProvides(*, ${reqSvcKey})`],
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

      // INF-07: unmapped-spec-symbol
      const allFns = Array.from(fnsByKey.values())
      const allServices = Array.from(servicesByKey.values())
      const allErrors = Array.from(errorsByKey.values())
      for (const [specKey, specNode] of specsByKey.entries()) {
        if (specNode.status !== "proposed" && specNode.status !== "accepted") {
          continue
        }
        for (const span of specNode.referencedSpans ?? []) {
          const exists = allFns.some(
            (fn) => fn.spanName === span || fn.qualname === span || fn.qualname.endsWith(`#${span}`),
          )
          if (!exists) {
            const proof = registerProof({
              proofId: ProofId.make(`proof:INF-07:span:${specNode.id}:${span}`),
              ruleId: DatalogRuleId.make("INF-07"),
              stratum: StratumIndex.make(2),
              conclusion: `AntiPattern(unmapped-spec-symbol, ${specKey}, ${span})`,
              premises: [`SpecDeclaresSpan(${specNode.id}, ${span})`, `!EffectFn(${span})`],
              parentProofIds: [],
            })
            antiPatterns.push({
              ruleId: "unmapped-spec-symbol",
              datalogRuleId: DatalogRuleId.make("INF-07"),
              nodeKey: NodeKey.make(specKey),
              path: [specNode.id, span],
              message: `EARS Spec '${specNode.id}' (${specNode.path}) declares EffectFn span '${span}', which is missing from the graph`,
              proof,
            })
          }
        }
        for (const svc of specNode.referencedServices ?? []) {
          const exists = allServices.some(
            (s) => s.tagId === svc || s.name === svc || s.tagId.endsWith(`#${svc}`),
          )
          if (!exists) {
            const proof = registerProof({
              proofId: ProofId.make(`proof:INF-07:svc:${specNode.id}:${svc}`),
              ruleId: DatalogRuleId.make("INF-07"),
              stratum: StratumIndex.make(2),
              conclusion: `AntiPattern(unmapped-spec-symbol, ${specKey}, ${svc})`,
              premises: [`SpecDeclaresService(${specNode.id}, ${svc})`, `!ServiceTag(${svc})`],
              parentProofIds: [],
            })
            antiPatterns.push({
              ruleId: "unmapped-spec-symbol",
              datalogRuleId: DatalogRuleId.make("INF-07"),
              nodeKey: NodeKey.make(specKey),
              path: [specNode.id, svc],
              message: `EARS Spec '${specNode.id}' (${specNode.path}) declares ServiceTag '${svc}', which is missing from the graph`,
              proof,
            })
          }
        }
        for (const err of specNode.referencedErrors ?? []) {
          const exists = allErrors.some((e) => e.errorTag === err)
          if (!exists) {
            const proof = registerProof({
              proofId: ProofId.make(`proof:INF-07:err:${specNode.id}:${err}`),
              ruleId: DatalogRuleId.make("INF-07"),
              stratum: StratumIndex.make(2),
              conclusion: `AntiPattern(unmapped-spec-symbol, ${specKey}, ${err})`,
              premises: [`SpecDeclaresError(${specNode.id}, ${err})`, `!TaggedError(${err})`],
              parentProofIds: [],
            })
            antiPatterns.push({
              ruleId: "unmapped-spec-symbol",
              datalogRuleId: DatalogRuleId.make("INF-07"),
              nodeKey: NodeKey.make(specKey),
              path: [specNode.id, err],
              message: `EARS Spec '${specNode.id}' (${specNode.path}) declares TaggedError '${err}', which is missing from the graph`,
              proof,
            })
          }
        }
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
          premises: [`DestructiveMigration(${migRelId})`, `!PlaysRole(${migRelId}, *, verifying-test)`],
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
        const edgeIdentity = `${edge.relationId}::${edge.role}::${edge.targetEntityKey}`
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
        mergedSuggestedMap.set(edgeIdentity, {
          ...primary,
          confidenceMillis: joinedConfidence,
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
        const outputSchemaKeys = Array.from(roles?.get("output-schema") ?? []).sort()
        const inputSchemaKeys = Array.from(roles?.get("input-schema") ?? []).sort()
        const directErrorKeys = new Set<string>(roles?.get("fails-with") ?? [])
        const directServiceKeys = new Set<string>(roles?.get("requires-service") ?? [])

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
          rawSeeds.set(k, Math.max(rawSeeds.get(k) ?? 0, 0.85))
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
          const isDirectSchema =
            outputSchemaKeys.includes(schemaKey) || inputSchemaKeys.includes(schemaKey)
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
            pushCandidate(
              svcKey,
              "R",
              `Context.Service<${svcNode.name}>("${svcNode.tagId}")`,
              0.6,
            )
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

        const outputSchemaNames = outputSchemaKeys.map(
          (k) => schemasByKey.get(k)?.name ?? k.replace(/^SchemaDef:/, ""),
        )
        const successTypeSignature =
          outputSchemaNames.length > 0 ? outputSchemaNames.join(" | ") : "unknown"
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
            ...boundedCandidates.slice(0, 4).map((c) => `Inhabits(${c.symbolKey}, ${c.inhabitsChannel})`),
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
    }),
)
