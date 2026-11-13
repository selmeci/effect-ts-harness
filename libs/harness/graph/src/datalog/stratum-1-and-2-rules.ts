import {
  D2,
  MultiSet,
  type KeyValue,
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
} from "@electric-sql/d2ts"
import {
  type DatalogEvaluationContext,
  type ProofRegistrar,
  isAggregateFnNode,
  isCloudBinding,
  isDeciderSpan,
  isDomainFn,
  isDomainOrContractFn,
  isEventBusServiceNode,
  isInfraService,
  isOutboxDrainOrBusPublishFnNode,
  isProposedOrAcceptedSpec,
  isReducerSpan,
  makeOutputCollector,
  minHeightReducer,
} from "./datalog-types-and-semiring.js"
import {
  DatalogRuleId,
  type EffectFnNode,
  type EffectiveErrorPropagation,
  type EffectiveLayerDependency,
  type EffectiveServiceRequirement,
  type EffectiveTestReachability,
  type InferredAntiPattern,
  type MinHeightProvenanceAnnotation,
  NodeKey,
  ProofHeight,
  ProofId,
  RelationId,
  type ServiceTagNode,
  StratumIndex,
  type AntiPatternRuleId,
} from "../model.js"

export interface Stratum1Result {
  readonly effectiveRequires: ReadonlyArray<EffectiveServiceRequirement>
  readonly effectiveFailsWith: ReadonlyArray<EffectiveErrorPropagation>
  readonly effectiveLayerDeps: ReadonlyArray<EffectiveLayerDependency>
  readonly effectiveTestReach: ReadonlyArray<EffectiveTestReachability>
  readonly collectedCallReachProvenance: ReadonlyArray<KeyValue<string, MinHeightProvenanceAnnotation>>
  readonly collectedCallReach: ReadonlyArray<KeyValue<string, [string, string]>>
  readonly provenanceByPair: ReadonlyMap<string, MinHeightProvenanceAnnotation>
  readonly reqProofByPair: ReadonlyMap<string, ProofId>
  readonly failProofByPair: ReadonlyMap<string, ProofId>
  readonly directLayerEdges: ReadonlyMap<string, ReadonlyArray<string>>
}

export interface Stratum2Result {
  readonly antiPatterns: ReadonlyArray<InferredAntiPattern>
  readonly collectedUntestedDomainSpans: ReadonlyArray<KeyValue<string, [string, null]>>
}

export interface Stratum3D2Facts {
  readonly collectedComp01: ReadonlyArray<KeyValue<string, [[string, string, string], null]>>
  readonly collectedComp02: ReadonlyArray<KeyValue<string, [[string, string, string], null]>>
  readonly collectedComp03: ReadonlyArray<KeyValue<string, [string, null]>>
  readonly collectedComp05: ReadonlyArray<KeyValue<string, [[string, string], null]>>
}

export interface Stratum1And2Result {
  readonly stratum1: Stratum1Result
  readonly stratum2: Stratum2Result
  readonly stratum3Facts: Stratum3D2Facts
}

export const reconstructCallWitnessPath = (
  callerKey: string,
  calleeKey: string,
  provenanceByPair: ReadonlyMap<string, MinHeightProvenanceAnnotation>,
  visited: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  if (callerKey === calleeKey) return [callerKey]
  const pairKey = `${callerKey}->${calleeKey}`
  const ann = provenanceByPair.get(pairKey)
  if (!ann || ann.proofHeight <= 1 || ann.viaIntermediateKey == null) return [callerKey, calleeKey]
  const midKey = ann.viaIntermediateKey
  if (midKey === callerKey || midKey === calleeKey || visited.has(pairKey)) return [callerKey, calleeKey]
  const nextVisited = new Set(visited)
  nextVisited.add(pairKey)
  const left = reconstructCallWitnessPath(callerKey, midKey, provenanceByPair, nextVisited)
  const right = reconstructCallWitnessPath(midKey, calleeKey, provenanceByPair, nextVisited)
  return [...left.slice(0, -1), ...right]
}

export const findShortestLayerCycle = (
  startLayerKey: string,
  directLayerEdges: ReadonlyMap<string, ReadonlyArray<string>>,
  layerQualnameByKey: ReadonlyMap<string, string>,
): ReadonlyArray<string> => {
  const startQual = layerQualnameByKey.get(startLayerKey) ?? startLayerKey
  const visited = new Set<string>()
  const queue: Array<ReadonlyArray<string>> = [[startLayerKey]]
  while (queue.length > 0) {
    const currentPath = queue.shift()
    if (!currentPath) break
    const last = currentPath[currentPath.length - 1]
    if (!last) continue
    for (const nextKey of directLayerEdges.get(last) ?? []) {
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

const sendBatch = <T>(
  input: { sendData: (version: number, data: MultiSet<T>) => void; sendFrontier: (version: number) => void },
  items: ReadonlyArray<T>,
): void => {
  const multisetItems: Array<[T, number]> = items.map((x): [T, number] => [x, 1])
  input.sendData(0, new MultiSet(multisetItems))
  input.sendFrontier(1)
}

const collectStream = <T>(stream: { readonly pipe: (op: ReturnType<typeof output<T>>) => unknown }): Array<T> => {
  const target: Array<T> = []
  stream.pipe(output(makeOutputCollector(target)))
  return target
}

export const runStratum1And2 = (
  ctx: DatalogEvaluationContext,
  proofReg: ProofRegistrar,
): Stratum1And2Result => {
  const { registerProof } = proofReg
  const d2 = new D2({ initialFrontier: 0 })

  const inDirectCalls = d2.newInput<KeyValue<string, MinHeightProvenanceAnnotation>>()
  const inStr = () => d2.newInput<KeyValue<string, string>>()
  const inDirectRequires = inStr(), inDirectFails = inStr(), inLayerProvides = inStr(), inLayerRequires = inStr()
  const inDirectTestSpans = inStr(), inDomainNonStubFns = inStr(), inDestructiveMigrations = inStr()
  const inMigrationVerifyingTests = inStr(), inExistingTraceAdrs = inStr(), inDomainFns = inStr()
  const inInfraServices = inStr(), inCloudBindingServices = inStr(), inDeciderFns = inStr()
  const inReducerFns = inStr(), inAggregateFns = inStr(), inOutboxOrBusPublishFns = inStr(), inEventBusServices = inStr()
  const inKnownSpans = inStr(), inKnownServices = inStr(), inKnownErrors = inStr()
  const inSpecExpectedErrors = d2.newInput<KeyValue<string, [string, string, string]>>()
  const inSpecExpectedServices = d2.newInput<KeyValue<string, [string, string, string]>>()
  const inAdrExpectedTargets = d2.newInput<KeyValue<string, [string, string]>>()
  const inSpecDeclaredSpans = d2.newInput<KeyValue<string, [string, string]>>()
  const inSpecDeclaredServices = d2.newInput<KeyValue<string, [string, string]>>()
  const inSpecDeclaredErrors = d2.newInput<KeyValue<string, [string, string]>>()

  // S_1: Call Reachability
  const maxGraphDepth = Math.max(1, ctx.fnsByKey.size + 1)
  const callReachProvenanceStream = inDirectCalls.pipe(
    iterate((reach) => {
      const byCallee = reach.pipe(map(([p, ann]): KeyValue<string, readonly [string, number]> => {
        const [c = "", cal = ""] = p.split("->")
        return [cal, [c, ann.proofHeight] as const]
      }))
      const byCaller = reach.pipe(map(([p, ann]): KeyValue<string, readonly [string, number]> => {
        const [c = "", cal = ""] = p.split("->")
        return [c, [cal, ann.proofHeight] as const]
      }))
      const stepped = byCallee.pipe(
        innerJoin(byCaller),
        map(([_mid, [[c, h1], [cal, h2]]]): KeyValue<string, MinHeightProvenanceAnnotation> => [
          `${c}->${cal}`,
          { proofHeight: ProofHeight.make(Math.min(maxGraphDepth, h1 + h2)), ruleId: DatalogRuleId.make("INF-01"), viaIntermediateKey: NodeKey.make(_mid) },
        ]),
      )
      return reach.pipe(concat(stepped), reduce(minHeightReducer), consolidate())
    }),
    consolidate(),
  )
  const collectedCallReachProvenance = collectStream<KeyValue<string, MinHeightProvenanceAnnotation>>(callReachProvenanceStream)
  const callReachStream = callReachProvenanceStream.pipe(
    map(([p]): KeyValue<string, [string, string]> => {
      const [c = "", cal = ""] = p.split("->")
      return [p, [c, cal]]
    }),
    consolidate(),
  )
  const collectedCallReach = collectStream<KeyValue<string, [string, string]>>(callReachStream)

  // INF-01: EffectiveRequires
  const callReachByCallee = callReachStream.pipe(map(([_p, [c, cal]]): KeyValue<string, string> => [cal, c]))
  const transitiveRequiresStream = callReachByCallee.pipe(
    innerJoin(inDirectRequires),
    map(([_cal, [c, s]]): KeyValue<string, [string, string]> => [`${c}->${s}`, [c, s]]),
  )
  const directRequiresKeyed = inDirectRequires.pipe(map(([c, s]): KeyValue<string, [string, string]> => [`${c}->${s}`, [c, s]]))
  const effectiveRequiresStream = directRequiresKeyed.pipe(concat(transitiveRequiresStream), distinct(), consolidate())
  const collectedEffectiveRequires = collectStream<KeyValue<string, [string, string]>>(effectiveRequiresStream)

  // INF-02: EffectiveFailsWith
  const transitiveFailsStream = callReachByCallee.pipe(
    innerJoin(inDirectFails),
    filter(([_cal, [callerKey, errKey]]) => {
      const callerNode = ctx.fnsByKey.get(callerKey)
      if (!callerNode?.caughtErrors || callerNode.caughtErrors.length === 0) return true
      const errTag = ctx.errTagByKey.get(errKey) ?? errKey.replace(/^TaggedError:/, "")
      return !callerNode.caughtErrors.includes(errTag) && !callerNode.caughtErrors.includes(errKey)
    }),
    map(([_cal, [c, e]]): KeyValue<string, [string, string]> => [`${c}->${e}`, [c, e]]),
  )
  const directFailsKeyed = inDirectFails.pipe(map(([c, e]): KeyValue<string, [string, string]> => [`${c}->${e}`, [c, e]]))
  const effectiveFailsStream = directFailsKeyed.pipe(concat(transitiveFailsStream), distinct(), consolidate())
  const collectedEffectiveFails = collectStream<KeyValue<string, [string, string]>>(effectiveFailsStream)

  // INF-03a: LayerDependency
  const directLayerDepPairsStream = inLayerRequires.pipe(
    innerJoin(inLayerProvides),
    map(([_svc, [cLayer, pLayer]]): KeyValue<string, [string, string]> => [`${cLayer}->${pLayer}`, [cLayer, pLayer]]),
    distinct(),
  )
  const layerReachStream = directLayerDepPairsStream.pipe(
    iterate((reach) => {
      const byTarget = reach.pipe(map(([_k, [src, dst]]): KeyValue<string, string> => [dst, src]))
      const bySource = reach.pipe(map(([_k, [src, dst]]): KeyValue<string, string> => [src, dst]))
      return reach.pipe(
        concat(byTarget.pipe(innerJoin(bySource), map(([_mid, [src, dst]]): KeyValue<string, [string, string]> => [`${src}->${dst}`, [src, dst]]))),
        distinct(),
      )
    }),
    consolidate(),
  )
  const collectedLayerReach = collectStream<KeyValue<string, [string, string]>>(layerReachStream)

  // INF-03b: EffectiveTestReach
  const callReachByCaller = callReachStream.pipe(map(([_k, [c, cal]]): KeyValue<string, string> => [c, cal]))
  const transitiveTestReachStream = inDirectTestSpans.pipe(
    innerJoin(callReachByCaller),
    map(([_entry, [testKey, targetKey]]): KeyValue<string, [string, string]> => [`${testKey}->${targetKey}`, [testKey, targetKey]]),
  )
  const directTestReachKeyed = inDirectTestSpans.pipe(map(([targetKey, testKey]): KeyValue<string, [string, string]> => [`${testKey}->${targetKey}`, [testKey, targetKey]]))
  const effectiveTestReachStream = directTestReachKeyed.pipe(concat(transitiveTestReachStream), distinct(), consolidate())
  const collectedEffectiveTestReach = collectStream<KeyValue<string, [string, string]>>(effectiveTestReachStream)

  // S_2: Negation & Antipattern Streams
  const effReqByCaller = effectiveRequiresStream.pipe(map(([_k, [c, s]]): KeyValue<string, [string, string]> => [c, [c, s]]))
  const domainEffReq = effReqByCaller.pipe(innerJoin(inDomainFns), map(([_c, [[c, s]]]): KeyValue<string, [string, string]> => [s, [c, s]]))

  const collectedDomainRequiresInfra = collectStream<KeyValue<string, [string, string]>>(
    domainEffReq.pipe(innerJoin(inInfraServices), map(([_s, [[c, s]]]): KeyValue<string, [string, string]> => [`${c}->${s}`, [c, s]]), distinct(), consolidate()),
  )
  const collectedDomainRequiresCloudBinding = collectStream<KeyValue<string, [string, string]>>(
    domainEffReq.pipe(innerJoin(inCloudBindingServices), map(([_s, [[c, s]]]): KeyValue<string, [string, string]> => [`${c}->${s}`, [c, s]]), distinct(), consolidate()),
  )
  const collectedImpureDeciders = collectStream<KeyValue<string, [string, string]>>(
    effReqByCaller.pipe(innerJoin(inDeciderFns), map(([_c, [[c, s]]]): KeyValue<string, [string, string]> => [`${c}->${s}`, [c, s]]), distinct(), consolidate()),
  )
  const collectedImpureReducerSvcs = collectStream<KeyValue<string, [string, string]>>(
    effReqByCaller.pipe(innerJoin(inReducerFns), map(([_c, [[c, s]]]): KeyValue<string, [string, string]> => [`${c}->${s}`, [c, s]]), distinct(), consolidate()),
  )
  const effFailsByCaller = effectiveFailsStream.pipe(map(([_k, [c, e]]): KeyValue<string, [string, string]> => [c, [c, e]]))
  const collectedImpureReducerErrs = collectStream<KeyValue<string, [string, string]>>(
    effFailsByCaller.pipe(innerJoin(inReducerFns), map(([_c, [[c, e]]]): KeyValue<string, [string, string]> => [`${c}->${e}`, [c, e]]), distinct(), consolidate()),
  )
  const collectedLayerCycles = collectStream<KeyValue<string, [string, string]>>(
    layerReachStream.pipe(filter(([_k, [src, dst]]) => src === dst), consolidate()),
  )
  const collectedMissingLayerProviders = collectStream<KeyValue<string, [string, null]>>(
    inLayerRequires.pipe(antiJoin(inLayerProvides), consolidate()),
  )
  const collectedUnmappedSpecSpans = collectStream<KeyValue<string, [[string, string], null]>>(
    inSpecDeclaredSpans.pipe(antiJoin(inKnownSpans), consolidate()),
  )
  const collectedUnmappedSpecServices = collectStream<KeyValue<string, [[string, string], null]>>(
    inSpecDeclaredServices.pipe(antiJoin(inKnownServices), consolidate()),
  )
  const collectedUnmappedSpecErrors = collectStream<KeyValue<string, [[string, string], null]>>(
    inSpecDeclaredErrors.pipe(antiJoin(inKnownErrors), consolidate()),
  )

  const aggregateBusSvcStream = effReqByCaller.pipe(
    innerJoin(inAggregateFns),
    map(([_c, [[c, s]]]): KeyValue<string, [string, string]> => [s, [c, s]]),
    innerJoin(inEventBusServices),
    map(([_s, [[c, s]]]): KeyValue<string, [string, string]> => [`${c}->${s}`, [c, s]]),
    distinct(),
    consolidate(),
  )
  const collectedAggregateBusSvcs = collectStream<KeyValue<string, [string, string]>>(aggregateBusSvcStream)

  const callReachByCallerKey = callReachStream.pipe(map(([_k, [c, cal]]): KeyValue<string, [string, string]> => [c, [c, cal]]))
  const aggregateBusCallStream = callReachByCallerKey.pipe(
    innerJoin(inAggregateFns),
    map(([_c, [[c, cal]]]): KeyValue<string, [string, string]> => [cal, [c, cal]]),
    innerJoin(inOutboxOrBusPublishFns),
    map(([_cal, [[c, cal]]]): KeyValue<string, [string, string]> => [`${c}->${cal}`, [c, cal]]),
    distinct(),
    consolidate(),
  )
  const collectedAggregateBusCalls = collectStream<KeyValue<string, [string, string]>>(aggregateBusCallStream)

  const coveredSpansStream = effectiveTestReachStream.pipe(map(([_k, [t, s]]): KeyValue<string, string> => [s, t]), distinct())
  const collectedUntestedDomainSpans = collectStream<KeyValue<string, [string, null]>>(inDomainNonStubFns.pipe(antiJoin(coveredSpansStream), consolidate()))
  const collectedUnverifiedMigrations = collectStream<KeyValue<string, [string, null]>>(inDestructiveMigrations.pipe(antiJoin(inMigrationVerifyingTests), consolidate()))

  // S_3: Fact anti-joins for edge completion
  const collectedComp01 = collectStream<KeyValue<string, [[string, string, string], null]>>(inSpecExpectedErrors.pipe(antiJoin(directFailsKeyed), consolidate()))
  const collectedComp02 = collectStream<KeyValue<string, [[string, string, string], null]>>(inSpecExpectedServices.pipe(antiJoin(directRequiresKeyed), consolidate()))
  const fnRequiredBySvcKey = inDirectRequires.pipe(map(([c, s]): KeyValue<string, string> => [s, c]), distinct())
  const collectedComp03 = collectStream<KeyValue<string, [string, null]>>(fnRequiredBySvcKey.pipe(antiJoin(inLayerProvides), consolidate()))
  const collectedComp05 = collectStream<KeyValue<string, [[string, string], null]>>(inAdrExpectedTargets.pipe(antiJoin(inExistingTraceAdrs), consolidate()))

  d2.finalize()

  // Feed Inputs
  sendBatch(inDirectCalls, ctx.directCallPairs.map(([c, cal]) => {
    const pairKey = `${c}->${cal}`
    const relId = ctx.directCallRelIdByPair.get(pairKey)
    return [pairKey, { proofHeight: ProofHeight.make(1), ruleId: DatalogRuleId.make("INF-01"), ...(relId ? { witnessRelationId: RelationId.make(relId) } : {}), viaIntermediateKey: NodeKey.make(cal) }] as const
  }))
  sendBatch(inDirectRequires, ctx.directReqPairs as ReadonlyArray<KeyValue<string, string>>)
  sendBatch(inDirectFails, ctx.directFailPairs as ReadonlyArray<KeyValue<string, string>>)
  sendBatch(inLayerProvides, ctx.directLayerProvidesPairs.map(([l, s]): KeyValue<string, string> => [s, l]))
  sendBatch(inLayerRequires, ctx.directLayerRequiresPairs.map(([l, s]): KeyValue<string, string> => [s, l]))
  sendBatch(inDirectTestSpans, ctx.directTestSpanPairs.map(([t, s]): KeyValue<string, string> => [s, t]))

  sendBatch(inDomainNonStubFns, Array.from(ctx.fnsByKey.entries()).filter(([, n]) => isDomainOrContractFn(n) && !n.isStub).map(([k]): KeyValue<string, string> => [k, k]))
  sendBatch(inDomainFns, Array.from(ctx.fnsByKey.entries()).filter(([, n]) => isDomainFn(n)).map(([k]): KeyValue<string, string> => [k, k]))
  sendBatch(inDeciderFns, Array.from(ctx.fnsByKey.entries()).filter(([, n]) => isDomainOrContractFn(n) && isDeciderSpan(n.spanName)).map(([k]): KeyValue<string, string> => [k, k]))
  sendBatch(inReducerFns, Array.from(ctx.fnsByKey.entries()).filter(([, n]) => isDomainOrContractFn(n) && isReducerSpan(n.spanName)).map(([k]): KeyValue<string, string> => [k, k]))
  sendBatch(inAggregateFns, Array.from(ctx.fnsByKey.entries()).filter(([, n]) => isAggregateFnNode(n)).map(([k]): KeyValue<string, string> => [k, k]))
  sendBatch(inOutboxOrBusPublishFns, Array.from(ctx.fnsByKey.entries()).filter(([, n]) => isOutboxDrainOrBusPublishFnNode(n)).map(([k]): KeyValue<string, string> => [k, k]))

  sendBatch(inInfraServices, Array.from(ctx.servicesByKey.entries()).filter(([, s]) => isInfraService(s)).map(([k]): KeyValue<string, string> => [k, k]))
  sendBatch(inCloudBindingServices, Array.from(ctx.servicesByKey.entries()).filter(([, s]) => !isInfraService(s) && isCloudBinding(s)).map(([k]): KeyValue<string, string> => [k, k]))
  sendBatch(inEventBusServices, Array.from(ctx.servicesByKey.entries()).filter(([, s]) => isEventBusServiceNode(s)).map(([k]): KeyValue<string, string> => [k, k]))

  const knownSpans = Array.from(ctx.fnsByKey.values()).flatMap((n): Array<KeyValue<string, string>> => {
    const idx = n.qualname.lastIndexOf("#")
    return idx !== -1
      ? [[n.spanName, n.spanName], [n.qualname, n.qualname], [n.qualname.slice(idx + 1), n.qualname.slice(idx + 1)]]
      : [[n.spanName, n.spanName], [n.qualname, n.qualname]]
  })
  sendBatch(inKnownSpans, knownSpans)

  const knownSvcs = Array.from(ctx.servicesByKey.values()).flatMap((s): Array<KeyValue<string, string>> => {
    const idx = s.tagId.lastIndexOf("#")
    return idx !== -1
      ? [[s.tagId, s.tagId], [s.name, s.name], [s.tagId.slice(idx + 1), s.tagId.slice(idx + 1)]]
      : [[s.tagId, s.tagId], [s.name, s.name]]
  })
  sendBatch(inKnownServices, knownSvcs)

  const knownErrs = Array.from(ctx.errorsByKey.values()).flatMap((e): Array<KeyValue<string, string>> =>
    e.tag !== undefined ? [[e.errorTag, e.errorTag], [e.tag, e.tag]] : [[e.errorTag, e.errorTag]]
  )
  sendBatch(inKnownErrors, knownErrs)

  sendBatch(inDestructiveMigrations, Array.from(ctx.migrationsById.entries()).filter(([, m]) => m.isDestructive).map(([relId]): KeyValue<string, string> => [relId, relId]))
  sendBatch(inMigrationVerifyingTests, Array.from(ctx.migrationsById.keys()).flatMap((relId) =>
    Array.from(ctx.migrationRoles.get(relId)?.get("verifying-test") ?? []).map((t): KeyValue<string, string> => [relId, t])
  ))

  const activeSpecs = Array.from(ctx.specsByKey.entries()).filter(([, n]) => isProposedOrAcceptedSpec(n))
  sendBatch(inSpecDeclaredSpans, activeSpecs.flatMap(([k, n]) => (n.referencedSpans ?? []).map((s): KeyValue<string, [string, string]> => [s, [k, s]])))
  sendBatch(inSpecDeclaredServices, activeSpecs.flatMap(([k, n]) => (n.referencedServices ?? []).map((s): KeyValue<string, [string, string]> => [s, [k, s]])))
  sendBatch(inSpecDeclaredErrors, activeSpecs.flatMap(([k, n]) => (n.referencedErrors ?? []).map((e): KeyValue<string, [string, string]> => [e, [k, e]])))

  const specExpectedErrors: Array<KeyValue<string, [string, string, string]>> = []
  const specExpectedSvcs: Array<KeyValue<string, [string, string, string]>> = []
  for (const [specKey, targetKey] of ctx.existingSpecToTargetPairs) {
    const specNode = ctx.specsByKey.get(specKey)
    if (!specNode || !ctx.fnsByKey.has(targetKey)) continue
    for (const err of specNode.referencedErrors ?? []) {
      const eKey = `TaggedError:${err}`
      if (ctx.errorsByKey.has(eKey)) specExpectedErrors.push([`${targetKey}->${eKey}`, [specKey, targetKey, eKey]])
    }
    for (const svc of specNode.referencedServices ?? []) {
      for (const [sKey, sNode] of ctx.servicesByKey.entries()) {
        if (sNode.tagId === svc || sNode.name === svc || sNode.tagId.endsWith(`#${svc}`)) {
          specExpectedSvcs.push([`${targetKey}->${sKey}`, [specKey, targetKey, sKey]])
        }
      }
    }
  }
  sendBatch(inSpecExpectedErrors, specExpectedErrors)
  sendBatch(inSpecExpectedServices, specExpectedSvcs)

  sendBatch(inAdrExpectedTargets, Array.from(ctx.adrsByKey.entries()).filter(([, n]) => n.status === "accepted").flatMap(([k, n]) =>
    n.enforcedByFiles.flatMap((file) => Array.from(ctx.fnsByKey.entries()).filter(([, fn]) => fn.file === file || fn.file.endsWith(file)).map(([fnKey]): KeyValue<string, [string, string]> => [`${k}->${fnKey}`, [k, fnKey]]))
  ))
  sendBatch(inExistingTraceAdrs, Array.from(ctx.existingTraceGoverningAdrs).map((k): KeyValue<string, string> => [k, k]))

  d2.run()

  // Materialize Stratum 1 Outputs
  const provenanceByPair = new Map<string, MinHeightProvenanceAnnotation>(collectedCallReachProvenance)
  const directReqSet = new Set(ctx.directReqPairs.map(([c, s]) => `${c}->${s}`))
  const directFailSet = new Set(ctx.directFailPairs.map(([c, e]) => `${c}->${e}`))
  const directTestSpanSet = new Set(ctx.directTestSpanPairs.map(([t, s]) => `${t}->${s}`))

  const buildCallWitness = (callerKey: string, targetKey: string, directPairs: ReadonlyArray<readonly [string, string]>, targetLabel: string): ReadonlyArray<string> => {
    let bestPath: ReadonlyArray<string> | undefined
    for (const [calleeKey, target] of directPairs) {
      if (target !== targetKey) continue
      if (collectedCallReach.some(([, [c, cal]]) => c === callerKey && cal === calleeKey)) {
        const cand = reconstructCallWitnessPath(callerKey, calleeKey, provenanceByPair).map((k) => ctx.fnQualnameByKey.get(k) ?? k)
        if (!bestPath || cand.length < bestPath.length || (cand.length === bestPath.length && cand.join("->").localeCompare(bestPath.join("->")) < 0)) {
          bestPath = cand
        }
      }
    }
    return [...(bestPath ?? [ctx.fnQualnameByKey.get(callerKey) ?? callerKey]), targetLabel]
  }

  const effectiveRequires: Array<EffectiveServiceRequirement> = []
  const reqProofByPair = new Map<string, ProofId>()
  for (const [pairKey, [callerKey, serviceKey]] of [...collectedEffectiveRequires].sort((a, b) => a[0].localeCompare(b[0]))) {
    const isDirect = directReqSet.has(pairKey)
    const svcTag = ctx.svcTagIdByKey.get(serviceKey) ?? serviceKey
    const witnessPath = isDirect ? [ctx.fnQualnameByKey.get(callerKey) ?? callerKey, svcTag] : buildCallWitness(callerKey, serviceKey, ctx.directReqPairs, svcTag)
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-01:${callerKey}->${serviceKey}`),
      ruleId: DatalogRuleId.make("INF-01"),
      stratum: StratumIndex.make(1),
      conclusion: `EffectiveRequires(${callerKey}, ${serviceKey})`,
      premises: witnessPath.map((step) => `Step(${step})`),
      parentProofIds: [],
    })
    reqProofByPair.set(pairKey, proof.proofId)
    effectiveRequires.push({ callerKey: NodeKey.make(callerKey), serviceKey: NodeKey.make(serviceKey), isDirect, path: witnessPath, proof })
  }

  const effectiveFailsWith: Array<EffectiveErrorPropagation> = []
  const failProofByPair = new Map<string, ProofId>()
  for (const [pairKey, [callerKey, errorKey]] of [...collectedEffectiveFails].sort((a, b) => a[0].localeCompare(b[0]))) {
    const isDirect = directFailSet.has(pairKey)
    const errTag = ctx.errTagByKey.get(errorKey) ?? errorKey
    const witnessPath = isDirect ? [ctx.fnQualnameByKey.get(callerKey) ?? callerKey, errTag] : buildCallWitness(callerKey, errorKey, ctx.directFailPairs, errTag)
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-02:${callerKey}->${errorKey}`),
      ruleId: DatalogRuleId.make("INF-02"),
      stratum: StratumIndex.make(1),
      conclusion: `EffectiveFailsWith(${callerKey}, ${errorKey})`,
      premises: witnessPath.map((step) => `Step(${step})`),
      parentProofIds: [],
    })
    failProofByPair.set(pairKey, proof.proofId)
    effectiveFailsWith.push({ callerKey: NodeKey.make(callerKey), errorKey: NodeKey.make(errorKey), isDirect, path: witnessPath, proof })
  }

  const effectiveLayerDeps: Array<EffectiveLayerDependency> = []
  const directLayerEdges = new Map<string, Array<string>>()
  const providersBySvcKey = new Map<string, Array<string>>()
  for (const [layerKey, svcKey] of ctx.directLayerProvidesPairs) {
    const list = providersBySvcKey.get(svcKey) ?? []
    if (!list.includes(layerKey)) { list.push(layerKey); list.sort(); providersBySvcKey.set(svcKey, list) }
  }
  const seenLayerSvcPairs = new Set<string>()

  const addLayerDep = (layerKey: string, reqSvcKey: string, isDirect: boolean, prefixPath: ReadonlyArray<string>) => {
    const pairId = `${layerKey}->${reqSvcKey}`
    if (seenLayerSvcPairs.has(pairId)) return
    seenLayerSvcPairs.add(pairId)
    const primary = (providersBySvcKey.get(reqSvcKey) ?? [])[0]
    const svcTag = ctx.svcTagIdByKey.get(reqSvcKey) ?? reqSvcKey
    const pQual = primary !== undefined ? (ctx.layerQualnameByKey.get(primary) ?? primary) : undefined
    const path = pQual !== undefined ? [...prefixPath, svcTag, pQual] : [...prefixPath, svcTag]
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-03:layer:${layerKey}->${reqSvcKey}`),
      ruleId: DatalogRuleId.make("INF-03"),
      stratum: StratumIndex.make(1),
      conclusion: `EffectiveLayerDep(${layerKey}, ${reqSvcKey})`,
      premises: path.map((p) => `LayerStep(${p})`),
      parentProofIds: [],
    })
    effectiveLayerDeps.push({ layerKey: NodeKey.make(layerKey), requiredServiceKey: NodeKey.make(reqSvcKey), ...(primary ? { providerLayerKey: NodeKey.make(primary) } : {}), isDirect, path, proof })
  }

  for (const [layerKey, reqSvcKey] of [...ctx.directLayerRequiresPairs].sort((a, b) => `${a[0]}->${a[1]}`.localeCompare(`${b[0]}->${b[1]}`))) {
    for (const p of providersBySvcKey.get(reqSvcKey) ?? []) {
      const list = directLayerEdges.get(layerKey) ?? []
      if (!list.includes(p)) { list.push(p); list.sort(); directLayerEdges.set(layerKey, list) }
    }
    addLayerDep(layerKey, reqSvcKey, true, [ctx.layerQualnameByKey.get(layerKey) ?? layerKey])
  }

  for (const [, [srcKey, dstKey]] of [...collectedLayerReach].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (srcKey === dstKey) continue
    for (const [midKey, reqSvc] of ctx.directLayerRequiresPairs) {
      if (midKey === dstKey) {
        addLayerDep(srcKey, reqSvc, false, [ctx.layerQualnameByKey.get(srcKey) ?? srcKey, ctx.layerQualnameByKey.get(dstKey) ?? dstKey])
      }
    }
  }

  const effectiveTestReach: Array<EffectiveTestReachability> = []
  for (const [pairKey, [testKey, targetKey]] of [...collectedEffectiveTestReach].sort((a, b) => a[0].localeCompare(b[0]))) {
    const testNode = ctx.testsByKey.get(testKey)
    const isDirect = directTestSpanSet.has(pairKey)
    const targetQual = ctx.fnQualnameByKey.get(targetKey) ?? targetKey
    const path = [testNode?.testId ?? testKey, targetQual]
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-03:test:${testKey}->${targetKey}`),
      ruleId: DatalogRuleId.make("INF-03"),
      stratum: StratumIndex.make(1),
      conclusion: `EffectiveTestReach(${testKey}, ${targetKey})`,
      premises: path.map((p) => `TestStep(${p})`),
      parentProofIds: [],
    })
    effectiveTestReach.push({ testKey: NodeKey.make(testKey), targetSpanKey: NodeKey.make(targetKey), isPropertyTest: testNode?.isPropertyTest ?? false, isDirect, path, proof })
  }

  // Materialize Stratum 2 Antipatterns
  const antiPatterns: Array<InferredAntiPattern> = []

  const pushReqAntiPattern = (
    pairs: ReadonlyArray<KeyValue<string, [string, string]>>,
    ruleId: AntiPatternRuleId,
    datalogRuleId: DatalogRuleId,
    tag: string,
    premiseSecond: (svcNode: ServiceTagNode) => string,
    messageFn: (fnNode: EffectFnNode, svcNode: ServiceTagNode) => string,
  ) => {
    for (const [pairKey, [callerKey, svcKey]] of pairs) {
      const fnNode = ctx.fnsByKey.get(callerKey)
      const svcNode = ctx.servicesByKey.get(svcKey)
      if (!fnNode || !svcNode) continue
      const parentProofId = reqProofByPair.get(pairKey)
      const req = effectiveRequires.find((r) => r.callerKey === callerKey && r.serviceKey === svcKey)
      const path = req?.path ?? [fnNode.qualname, svcNode.tagId]
      const proof = registerProof({
        proofId: ProofId.make(`proof:${datalogRuleId}:${tag}:${callerKey}->${svcKey}`),
        ruleId: datalogRuleId,
        stratum: StratumIndex.make(2),
        conclusion: `AntiPattern(${ruleId}, ${callerKey}, ${svcKey})`,
        premises: [`EffectiveRequires(${callerKey}, ${svcKey})`, premiseSecond(svcNode)],
        parentProofIds: parentProofId ? [parentProofId] : [],
      })
      antiPatterns.push({ ruleId, datalogRuleId, nodeKey: NodeKey.make(callerKey), targetKey: NodeKey.make(svcKey), path, message: messageFn(fnNode, svcNode), proof })
    }
  }

  pushReqAntiPattern(collectedDomainRequiresInfra, "domain-requires-infra", DatalogRuleId.make("INF-04"), "domain-requires-infra", (s) => `PackageTag(${s.tagId}, infra)`, (fn, svc) => `Domain Effect.fn '${fn.spanName}' (${fn.qualname}) requires infra ServiceTag '${svc.tagId}'`)
  pushReqAntiPattern(collectedDomainRequiresCloudBinding, "domain-requires-cloud-binding", DatalogRuleId.make("INF-04"), "domain-requires-cloud-binding", (s) => `CloudBinding(${s.tagId})`, (fn, svc) => `Domain Effect.fn '${fn.spanName}' (${fn.qualname}) requires cloud binding '${svc.tagId}'`)
  pushReqAntiPattern(collectedImpureDeciders, "impure-decider", DatalogRuleId.make("INF-05"), "impure-decider", () => `DeciderSpan(decide)`, (fn, svc) => `Decider '${fn.spanName}' (${fn.qualname}) must be pure (R = never) but requires service '${svc.tagId}'`)
  pushReqAntiPattern(collectedImpureReducerSvcs, "impure-reducer", DatalogRuleId.make("INF-05"), "impure-reducer:svc", (s) => `ReducerSpan(${s.tagId})`, (fn, svc) => `Reducer '${fn.spanName}' (${fn.qualname}) is a reducer (.evolve/.fold) which must be pure and cannot require service '${svc.tagId}'`)

  for (const [pairKey, [callerKey, errorKey]] of collectedImpureReducerErrs) {
    const fnNode = ctx.fnsByKey.get(callerKey)
    const errNode = ctx.errorsByKey.get(errorKey)
    if (!fnNode || !errNode) continue
    const parentProofId = failProofByPair.get(pairKey)
    const fail = effectiveFailsWith.find((f) => f.callerKey === callerKey && f.errorKey === errorKey)
    const path = fail?.path ?? [fnNode.qualname, errNode.errorTag]
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-05:impure-reducer:err:${callerKey}->${errorKey}`),
      ruleId: DatalogRuleId.make("INF-05"),
      stratum: StratumIndex.make(2),
      conclusion: `AntiPattern(impure-reducer, ${callerKey}, ${errorKey})`,
      premises: [`EffectiveFailsWith(${callerKey}, ${errorKey})`, `ReducerSpan(${fnNode.spanName})`],
      parentProofIds: parentProofId ? [parentProofId] : [],
    })
    antiPatterns.push({ ruleId: "impure-reducer", datalogRuleId: DatalogRuleId.make("INF-05"), nodeKey: NodeKey.make(callerKey), targetKey: NodeKey.make(errorKey), path, message: `Reducer '${fnNode.spanName}' (${fnNode.qualname}) is a reducer (.evolve/.fold) which must be infallible and cannot fail with '${errNode.errorTag}'`, proof })
  }

  pushReqAntiPattern(collectedAggregateBusSvcs, "aggregate-direct-bus-publish", DatalogRuleId.make("INF-08"), "bus-svc", (s) => `EventBus(${s.tagId})`, (fn, svc) => `Aggregate function '${fn.spanName}' (${fn.qualname}) directly requires EventBus '${svc.tagId}'; use transactional Outbox instead`)

  for (const [, [callerKey, calleeKey]] of collectedAggregateBusCalls) {
    const callerNode = ctx.fnsByKey.get(callerKey)
    const calleeNode = ctx.fnsByKey.get(calleeKey)
    if (!callerNode || !calleeNode) continue
    const rawPath = reconstructCallWitnessPath(callerKey, calleeKey, provenanceByPair)
    const rawWitness = rawPath.map((k) => ctx.fnQualnameByKey.get(k) ?? k)
    const witnessPath = rawWitness.length >= 2 ? [...rawWitness.slice(0, -1), calleeNode.spanName] : [callerNode.qualname, calleeNode.spanName]
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-08:call:${callerKey}->${calleeKey}`),
      ruleId: DatalogRuleId.make("INF-08"),
      stratum: StratumIndex.make(2),
      conclusion: `AntiPattern(aggregate-direct-bus-publish, ${callerKey}, ${calleeKey})`,
      premises: witnessPath.map((step) => `CallStep(${step})`),
      parentProofIds: [],
    })
    antiPatterns.push({ ruleId: "aggregate-direct-bus-publish", datalogRuleId: DatalogRuleId.make("INF-08"), nodeKey: NodeKey.make(callerKey), targetKey: NodeKey.make(calleeKey), path: witnessPath, message: `Aggregate function '${callerNode.spanName}' (${callerNode.qualname}) calls '${calleeNode.spanName}' synchronously in command execution path`, proof })
  }

  const seenCycleSignatures = new Set<string>()
  for (const [, [cycleLayerKey]] of [...collectedLayerCycles].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cyclePath = findShortestLayerCycle(cycleLayerKey, directLayerEdges, ctx.layerQualnameByKey)
    const sig = [...cyclePath].sort().join("|")
    if (seenCycleSignatures.has(sig)) continue
    seenCycleSignatures.add(sig)
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-06:layer-cycle:${cycleLayerKey}`),
      ruleId: DatalogRuleId.make("INF-06"),
      stratum: StratumIndex.make(2),
      conclusion: `AntiPattern(layer-cycle, ${cycleLayerKey})`,
      premises: cyclePath.map((p) => `LayerDep(${p})`),
      parentProofIds: [],
    })
    antiPatterns.push({ ruleId: "layer-cycle", datalogRuleId: DatalogRuleId.make("INF-06"), nodeKey: NodeKey.make(cycleLayerKey), path: cyclePath, message: `ServiceLayer dependency cycle detected: ${cyclePath.join(" -> ")}`, proof })
  }

  for (const [reqSvcKey, [consumerLayerKey]] of collectedMissingLayerProviders) {
    const layerQual = ctx.layerQualnameByKey.get(consumerLayerKey) ?? consumerLayerKey
    const svcTag = ctx.svcTagIdByKey.get(reqSvcKey) ?? reqSvcKey
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-06:missing-provider:${consumerLayerKey}->${reqSvcKey}`),
      ruleId: DatalogRuleId.make("INF-06"),
      stratum: StratumIndex.make(2),
      conclusion: `AntiPattern(missing-layer-provider, ${consumerLayerKey}, ${reqSvcKey})`,
      premises: [`LayerRequires(${consumerLayerKey}, ${reqSvcKey})`, `!LayerProvides(*, ${reqSvcKey})`],
      parentProofIds: [],
    })
    antiPatterns.push({ ruleId: "missing-layer-provider", datalogRuleId: DatalogRuleId.make("INF-06"), nodeKey: NodeKey.make(consumerLayerKey), targetKey: NodeKey.make(reqSvcKey), path: [layerQual, svcTag], message: `ServiceLayer '${layerQual}' requires ServiceTag '${svcTag}', which has no providing LayerFlow in the hypergraph`, proof })
  }

  const unmappedDefs = [
    [collectedUnmappedSpecSpans, "span", "EffectFn", "EffectFn span"] as const,
    [collectedUnmappedSpecServices, "svc", "ServiceTag", "ServiceTag"] as const,
    [collectedUnmappedSpecErrors, "err", "TaggedError", "TaggedError"] as const,
  ]
  for (const [items, kind, symType, desc] of unmappedDefs) {
    for (const [, [[specKey, name]]] of items) {
      const specNode = ctx.specsByKey.get(specKey)
      const specId = specNode?.id ?? specKey
      const proof = registerProof({
        proofId: ProofId.make(`proof:INF-07:${kind}:${specId}:${name}`),
        ruleId: DatalogRuleId.make("INF-07"),
        stratum: StratumIndex.make(2),
        conclusion: `AntiPattern(unmapped-spec-symbol, ${specKey}, ${name})`,
        premises: [`SpecDeclares${symType}(${specId}, ${name})`, `!${symType}(${name})`],
        parentProofIds: [],
      })
      antiPatterns.push({ ruleId: "unmapped-spec-symbol", datalogRuleId: DatalogRuleId.make("INF-07"), nodeKey: NodeKey.make(specKey), path: [specId, name], message: `EARS Spec '${specId}' (${specNode?.path ?? specKey}) declares ${desc} '${name}', which is missing from the graph`, proof })
    }
  }

  for (const [fnKey] of collectedUntestedDomainSpans) {
    const fnNode = ctx.fnsByKey.get(fnKey)
    if (!fnNode) continue
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-09:untested-span:${fnKey}`),
      ruleId: DatalogRuleId.make("INF-09"),
      stratum: StratumIndex.make(2),
      conclusion: `AntiPattern(untested-domain-span, ${fnKey})`,
      premises: [`DomainEffectFn(${fnKey})`, `!EffectiveTestReach(*, ${fnKey})`],
      parentProofIds: [],
    })
    antiPatterns.push({ ruleId: "untested-domain-span", datalogRuleId: DatalogRuleId.make("INF-09"), nodeKey: NodeKey.make(fnKey), path: [fnNode.qualname], message: `Non-stub ${fnNode.packageTag} EffectFn '${fnNode.spanName}' (${fnNode.qualname}) has zero transitive VitestCase coverage`, proof })
  }

  for (const [migRelId] of collectedUnverifiedMigrations) {
    const migNode = ctx.migrationsById.get(migRelId)
    if (!migNode) continue
    const migKey = NodeKey.make(`MigrationTuple:${migRelId}`)
    const proof = registerProof({
      proofId: ProofId.make(`proof:INF-09:unverified-migration:${migRelId}`),
      ruleId: DatalogRuleId.make("INF-09"),
      stratum: StratumIndex.make(2),
      conclusion: `AntiPattern(unverified-migration, ${migKey})`,
      premises: [`DestructiveMigration(${migRelId})`, `!PlaysRole(${migRelId}, *, verifying-test)`],
      parentProofIds: [],
    })
    antiPatterns.push({ ruleId: "unverified-migration", datalogRuleId: DatalogRuleId.make("INF-09"), nodeKey: migKey, path: [migRelId, migNode.migrationId], message: `Destructive SQLite migration '${migNode.migrationId}' (${migNode.moduleFile}) has no verifying-test PlaysRoleEdge`, proof })
  }

  return {
    stratum1: {
      effectiveRequires,
      effectiveFailsWith,
      effectiveLayerDeps,
      effectiveTestReach,
      collectedCallReachProvenance,
      collectedCallReach,
      provenanceByPair,
      reqProofByPair,
      failProofByPair,
      directLayerEdges,
    },
    stratum2: {
      antiPatterns,
      collectedUntestedDomainSpans,
    },
    stratum3Facts: {
      collectedComp01,
      collectedComp02,
      collectedComp03,
      collectedComp05,
    },
  }
}
