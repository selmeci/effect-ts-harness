import {
  MessageType,
  type Message,
} from "@electric-sql/d2ts"
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
  type HarnessGraph,
  type MigrationTupleRelation,
  type MinHeightProvenanceAnnotation,
  ProofHeight,
  ProofId,
  type SchemaDefNode,
  type SemanticEdgePriors,
  type ServiceLayerNode,
  type ServiceTagNode,
  type TaggedErrorNode,
  type VitestCaseNode,
  getNodeKey,
} from "../model.js"

export interface FlixConfidenceLatticeElement {
  readonly confidenceMillis: ConfidenceMillis
  readonly parentProofIds: ReadonlyArray<ProofId>
}

export interface DatalogEvaluationContext {
  readonly harnessGraph: HarnessGraph
  readonly priors?: SemanticEdgePriors | undefined
  readonly fnsByKey: ReadonlyMap<string, EffectFnNode>
  readonly servicesByKey: ReadonlyMap<string, ServiceTagNode>
  readonly layersByKey: ReadonlyMap<string, ServiceLayerNode>
  readonly errorsByKey: ReadonlyMap<string, TaggedErrorNode>
  readonly schemasByKey: ReadonlyMap<string, SchemaDefNode>
  readonly testsByKey: ReadonlyMap<string, VitestCaseNode>
  readonly adrsByKey: ReadonlyMap<string, AdrDocNode>
  readonly specsByKey: ReadonlyMap<string, EarsSpecNode>
  readonly migrationsById: ReadonlyMap<string, MigrationTupleRelation>
  readonly allEntityKeys: ReadonlySet<string>

  readonly fnQualnameByKey: ReadonlyMap<string, string>
  readonly svcTagIdByKey: ReadonlyMap<string, string>
  readonly layerQualnameByKey: ReadonlyMap<string, string>
  readonly errTagByKey: ReadonlyMap<string, string>

  readonly sigRoles: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
  readonly sigIdByCallerKey: ReadonlyMap<string, string>
  readonly layerFlowRoles: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
  readonly traceRoles: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
  readonly migrationRoles: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
  readonly httpRoles: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>

  readonly directCallPairs: ReadonlyArray<readonly [string, string]>
  readonly directCallRelIdByPair: ReadonlyMap<string, string>
  readonly directOutgoingCalls: ReadonlyMap<string, ReadonlyArray<string>>
  readonly directReqPairs: ReadonlyArray<readonly [string, string]>
  readonly directFailPairs: ReadonlyArray<readonly [string, string]>
  readonly directLayerProvidesPairs: ReadonlyArray<readonly [string, string]>
  readonly directLayerRequiresPairs: ReadonlyArray<readonly [string, string]>
  readonly directTestSpanPairs: ReadonlyArray<readonly [string, string]>
  readonly traceIdByTargetKey: ReadonlyMap<string, string>
  readonly existingTraceGoverningAdrs: ReadonlySet<string>
  readonly existingSpecToTargetPairs: ReadonlyArray<readonly [string, string]>
}

export const isCloudBinding = (node: ServiceTagNode): boolean =>
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)(\b|[A-Z])/.test(node.tagId) ||
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)(\b|[A-Z])/.test(node.name)

export const isDeciderSpan = (spanName: string): boolean =>
  spanName.endsWith(".decide") || spanName === "decide"

export const isReducerSpan = (spanName: string): boolean =>
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

export const isEventBusServiceNode = (node: ServiceTagNode): boolean =>
  node.tagId === "EventBus" ||
  node.tagId.endsWith("EventBus") ||
  node.tagId.endsWith(".EventBus") ||
  node.name === "EventBus" ||
  node.name.endsWith("EventBus")

export const isOutboxDrainOrBusPublishFnNode = (node: EffectFnNode): boolean =>
  node.spanName === "Outbox.drain" ||
  node.spanName === "EventBus.publish" ||
  node.qualname.includes("Outbox.drain") ||
  node.qualname.includes("EventBus.publish")

export const isDomainFn = (fnNode: EffectFnNode): boolean =>
  match(fnNode.packageTag)
    .with("domain", () => true)
    .with("contract", "service", "infra", "app", "unknown", () => false)
    .exhaustive()

export const isDomainOrContractFn = (fnNode: EffectFnNode): boolean =>
  match(fnNode.packageTag)
    .with("domain", "contract", () => true)
    .with("service", "infra", "app", "unknown", () => false)
    .exhaustive()

export const isInfraService = (svcNode: ServiceTagNode): boolean =>
  match(svcNode.packageTag)
    .with("infra", () => true)
    .with("contract", "domain", "service", "app", "unknown", undefined, () => false)
    .exhaustive()

export const isAcceptedAdr = (adrNode: AdrDocNode): boolean =>
  match(adrNode.status)
    .with("accepted", () => true)
    .with("proposed", "superseded", "deprecated", () => false)
    .exhaustive()

export const isProposedOrAcceptedSpec = (specNode: EarsSpecNode): boolean =>
  match(specNode.status)
    .with("proposed", "accepted", () => true)
    .with("superseded", "deprecated", () => false)
    .exhaustive()

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

export const STANDARD_DATALOG_RULES: ReadonlyArray<DatalogRule> = [
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

export const makeOutputCollector = <T>(target: Array<T>): ((msg: Message<T>) => void) => {
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

export const makeProofRegistrar = () => {
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

  return {
    proofsById,
    registerProof,
  }
}

export type ProofRegistrar = ReturnType<typeof makeProofRegistrar>

export const extractEdbTuplesFromGraph = (
  harnessGraph: HarnessGraph,
  priors?: SemanticEdgePriors,
): DatalogEvaluationContext => {
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
        fnsByKey.set(key, n); fnQualnameByKey.set(key, n.qualname); allEntityKeys.add(key)
      })
      .with({ _tag: "ServiceTag" }, (n) => {
        servicesByKey.set(key, n); svcTagIdByKey.set(key, n.tagId); allEntityKeys.add(key)
      })
      .with({ _tag: "ServiceLayer" }, (n) => {
        layersByKey.set(key, n); layerQualnameByKey.set(key, n.qualname); allEntityKeys.add(key)
      })
      .with({ _tag: "TaggedError" }, (n) => {
        errorsByKey.set(key, n); errTagByKey.set(key, n.errorTag); allEntityKeys.add(key)
      })
      .with({ _tag: "SchemaDef" }, (n) => { schemasByKey.set(key, n); allEntityKeys.add(key) })
      .with({ _tag: "VitestCase" }, (n) => { testsByKey.set(key, n); allEntityKeys.add(key) })
      .with({ _tag: "AdrDoc" }, (n) => { adrsByKey.set(key, n); allEntityKeys.add(key) })
      .with({ _tag: "EarsSpec" }, (n) => { specsByKey.set(key, n); allEntityKeys.add(key) })
      .with({ _tag: "PatternDoc" }, () => { allEntityKeys.add(key) })
      .with({ _tag: "EffectSignature" }, (n) => { if (!sigRoles.has(n.relationId)) sigRoles.set(n.relationId, new Map()) })
      .with({ _tag: "LayerFlow" }, (n) => { if (!layerFlowRoles.has(n.relationId)) layerFlowRoles.set(n.relationId, new Map()) })
      .with({ _tag: "TraceabilityTuple" }, (n) => { if (!traceRoles.has(n.relationId)) traceRoles.set(n.relationId, new Map()) })
      .with({ _tag: "MigrationTuple" }, (n) => {
        migrationsById.set(n.relationId, n)
        if (!migrationRoles.has(n.relationId)) migrationRoles.set(n.relationId, new Map())
      })
      .with({ _tag: "HttpEndpointTuple" }, (n) => { if (!httpRoles.has(n.relationId)) httpRoles.set(n.relationId, new Map()) })
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

  return {
    harnessGraph,
    priors,
    fnsByKey,
    servicesByKey,
    layersByKey,
    errorsByKey,
    schemasByKey,
    testsByKey,
    adrsByKey,
    specsByKey,
    migrationsById,
    allEntityKeys,
    fnQualnameByKey,
    svcTagIdByKey,
    layerQualnameByKey,
    errTagByKey,
    sigRoles,
    sigIdByCallerKey,
    layerFlowRoles,
    traceRoles,
    migrationRoles,
    httpRoles,
    directCallPairs,
    directCallRelIdByPair,
    directOutgoingCalls,
    directReqPairs,
    directFailPairs,
    directLayerProvidesPairs,
    directLayerRequiresPairs,
    directTestSpanPairs,
    traceIdByTargetKey,
    existingTraceGoverningAdrs,
    existingSpecToTargetPairs,
  }
}
