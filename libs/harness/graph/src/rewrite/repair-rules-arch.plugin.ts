import { Effect } from "effect"
import { match } from "ts-pattern"
import { decideGraphInference } from "../datalog-engine.js"
import {
  type DpoCandidatePriors, type EffectFnNode, type EntityNode, type GraphInferenceResult,
  type GraphMeasure, GraphRewriteError, type HarnessGraph, NodeKey, PlaysRoleEdge,
  type RelationNode, RewriteRuleId, type SystemOneScoreMillis,
} from "../model.js"
import {
  applyDpoPatchToGraph, computeGraphMeasure, type DraftGraphPatch, hasLayerProviderForService,
  indexHarnessGraph, isStrictlyDecreasingMeasure, makeEffectSignatureNode, makeLayerFlowNode,
  makePlaysRoleEdge, mapInferenceErrorToRewriteError, type Phase2CandidateBranch, sanitizeDpoIdentifier,
  scoreDraftPatch,
} from "./dpo-algebra-core.js"

// ============================================================================
// Phase 2: REPAIR_ARCH DPO Candidate Generators (REP-01..04b)
// ============================================================================

export const findPhase2ArchRepairBranches = (
  graph: HarnessGraph,
  inference: GraphInferenceResult,
): ReadonlyArray<Phase2CandidateBranch> => {
  const ctx = indexHarnessGraph(graph)

  // 1. REP-01: domain-requires-infra / domain-requires-cloud-binding
  for (const ap of inference.antiPatterns) {
    if (
      (ap.ruleId === "domain-requires-infra" || ap.ruleId === "domain-requires-cloud-binding") &&
      ap.targetKey !== undefined
    ) {
      const hasMoreSpecificRule = inference.antiPatterns.some(
        (other) =>
          other.nodeKey === ap.nodeKey && other.targetKey === ap.targetKey &&
          (other.ruleId === "aggregate-direct-bus-publish" || other.ruleId === "impure-decider" || other.ruleId === "impure-reducer"),
      )
      if (hasMoreSpecificRule) continue
      const infraSvcKey = ap.targetKey
      const infraSvc = ctx.servicesByKey.get(infraSvcKey)
      let targetSigRelId: string | undefined
      let targetCallerKey = ap.nodeKey
      let deletedEdge: PlaysRoleEdge | undefined

      for (const [relId, edges] of ctx.edgesByRelId.entries()) {
        const reqEdge = edges.find((e) => e.entityKey === infraSvcKey && match<string>(e.role).with("requires-service", () => true).otherwise(() => false))
        const callerEdge = edges.find((e) => match<string>(e.role).with("caller", () => true).otherwise(() => false))
        if (reqEdge !== undefined && callerEdge !== undefined) {
          targetSigRelId = relId
          targetCallerKey = callerEdge.entityKey
          deletedEdge = reqEdge
          if (callerEdge.entityKey === ap.nodeKey) break
        }
      }

      if (targetSigRelId !== undefined && deletedEdge !== undefined) {
        const rawSvcName = infraSvc?.name ?? infraSvcKey.replace(/^ServiceTag:/, "").split("#").pop() ?? "Infra"
        const basePortName = rawSvcName.replace(/^(?:Drizzle|D1|Sqlite|Cloudflare|Live)/, "")
        const portName = basePortName.length > 0 && basePortName !== rawSvcName ? basePortName : `${rawSvcName}Port`
        const portKey = `ServiceTag:${portName}`
        const layerQual = `libs/infra/src/${sanitizeDpoIdentifier(portName).toLowerCase()}-live.ts#${sanitizeDpoIdentifier(portName)}Live`
        const layerKey = `ServiceLayer:${layerQual}`
        const layerFlowId = `LayerFlow:layer-flow:${layerQual}`

        const insertedEntities: Array<EntityNode> = []
        const insertedRelations: Array<RelationNode> = []
        const insertedEdges: Array<PlaysRoleEdge> = [
          makePlaysRoleEdge(targetSigRelId, portKey, "requires-service"),
        ]

        if (!ctx.servicesByKey.has(portKey)) {
          insertedEntities.push({
            _tag: "ServiceTag", tagId: portName, name: portName, packageTag: "service",
            file: `libs/service/src/${sanitizeDpoIdentifier(portName).toLowerCase()}.ts`, line: 1,
          })
        }
        if (!ctx.layersByKey.has(layerKey)) {
          insertedEntities.push({
            _tag: "ServiceLayer", qualname: layerQual, layerKind: "live", packageTag: "infra",
            file: `libs/infra/src/${sanitizeDpoIdentifier(portName).toLowerCase()}-live.ts`, line: 1,
          })
        }
        if (!ctx.layerRelationsById.has(layerFlowId)) {
          insertedRelations.push(
            makeLayerFlowNode(layerFlowId, layerQual, `libs/infra/src/${sanitizeDpoIdentifier(portName).toLowerCase()}-live.ts`),
          )
        }
        insertedEdges.push(
          makePlaysRoleEdge(layerFlowId, layerKey, "provider-layer"),
          makePlaysRoleEdge(layerFlowId, portKey, "provided-service"),
          makePlaysRoleEdge(layerFlowId, infraSvcKey, "required-service"),
        )

        if (!hasLayerProviderForService(ctx, infraSvcKey)) {
          const infraLayerQual = `libs/infra/src/${sanitizeDpoIdentifier(rawSvcName).toLowerCase()}-infra.ts#${sanitizeDpoIdentifier(rawSvcName)}InfraLive`
          const infraLayerKey = `ServiceLayer:${infraLayerQual}`
          const infraFlowId = `LayerFlow:layer-flow:${infraLayerQual}`
          if (!ctx.layersByKey.has(infraLayerKey)) {
            insertedEntities.push({
              _tag: "ServiceLayer", qualname: infraLayerQual, layerKind: "infra", packageTag: "infra",
              file: `libs/infra/src/${sanitizeDpoIdentifier(rawSvcName).toLowerCase()}-infra.ts`, line: 1,
            })
          }
          if (!ctx.layerRelationsById.has(infraFlowId)) {
            insertedRelations.push(
              makeLayerFlowNode(infraFlowId, infraLayerQual, `libs/infra/src/${sanitizeDpoIdentifier(rawSvcName).toLowerCase()}-infra.ts`),
            )
          }
          insertedEdges.push(
            makePlaysRoleEdge(infraFlowId, infraLayerKey, "provider-layer"),
            makePlaysRoleEdge(infraFlowId, infraSvcKey, "provided-service"),
          )
        }

        for (const [, specNode] of ctx.specsByKey.entries()) {
          if (specNode.referencedServices?.includes(rawSvcName) || specNode.referencedServices?.includes(infraSvc?.tagId ?? "")) {
            const updatedSvcs = (specNode.referencedServices ?? []).map((s) =>
              s === rawSvcName || s === infraSvc?.tagId ? portName : s,
            )
            insertedEntities.push({ ...specNode, referencedServices: updatedSvcs })
          }
        }

        return [
          [
            {
              ruleId: RewriteRuleId.make("REP-01"), phase: "REPAIR_ARCH", ruleCategory: "auto-repair",
              description: `Extract service port '${portName}' in type:service, rewire preserved EffectSignature '${targetSigRelId}' in K, and bind '${layerQual}' in type:infra.`,
              primaryNodeKey: targetCallerKey,
              preservedInterfaceKeys: [targetCallerKey, infraSvcKey, NodeKey.make(targetSigRelId)],
              deletedEntityKeys: [], deletedRelationIds: [],
              deletedRoleEdges: [deletedEdge],
              insertedEntityNodes: insertedEntities, insertedRelationNodes: insertedRelations, insertedRoleEdges: insertedEdges,
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
          firstHopStep !== undefined ? (firstHopStep.startsWith("EffectFn:") ? firstHopStep : `EffectFn:${firstHopStep}`) : undefined
        const directEdge =
          sigEdges.find((e) => e.entityKey === targetKey && match<string>(e.role).with("requires-service", "fails-with", "callee", () => true).otherwise(() => false)) ??
          (firstHopCalleeKey !== undefined ? sigEdges.find((e) => (e.entityKey === firstHopCalleeKey || e.entityKey === firstHopStep) && match<string>(e.role).with("callee", () => true).otherwise(() => false)) : undefined)

        if (directEdge !== undefined) {
          const scopePrefix = deciderNode.spanName.replace(/\.(?:decide|evolve)$/, "")
          const ucSpan = `${scopePrefix}.execute`
          const cleanScope = sanitizeDpoIdentifier(scopePrefix)
          const ucQual = `${deciderNode.file}#execute${cleanScope}`
          const ucKey = `EffectFn:${ucQual}`
          const ucSigId = `EffectSignature:sig:${ucQual}`

          const insertedEntities: Array<EntityNode> = []
          const insertedRelations: Array<RelationNode> = []
          const insertedEdges: Array<PlaysRoleEdge> = []

          if (!ctx.fnsByKey.has(ucKey)) {
            insertedEntities.push({
              _tag: "EffectFn", qualname: ucQual, spanName: ucSpan, packageTag: "domain",
              file: deciderNode.file, line: deciderNode.line + 20, isStub: true,
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
          match<string>(directEdge.role)
            .with("callee", () => { if (directEdge.entityKey !== deciderKey) insertedEdges.push(makePlaysRoleEdge(ucSigId, directEdge.entityKey, "callee")) })
            .otherwise(() => {})

          if (targetKey.startsWith("ServiceTag:")) {
            const svcNode = ctx.servicesByKey.get(targetKey)
            if (svcNode?.packageTag === "infra") {
              insertedEntities.push({ ...svcNode, packageTag: "service" })
            }
            insertedEdges.push(makePlaysRoleEdge(ucSigId, targetKey, "requires-service"))
            if (!hasLayerProviderForService(ctx, targetKey)) {
              const svcClean = sanitizeDpoIdentifier(svcNode?.name ?? targetKey.replace(/^ServiceTag:/, ""))
              const layerQual = `libs/infra/src/${svcClean.toLowerCase()}-live.ts#${svcClean}Live`
              const layerKey = `ServiceLayer:${layerQual}`
              const flowId = `LayerFlow:layer-flow:${layerQual}`
              if (!ctx.layersByKey.has(layerKey)) {
                insertedEntities.push({
                  _tag: "ServiceLayer", qualname: layerQual, layerKind: "live", packageTag: "infra",
                  file: `libs/infra/src/${svcClean.toLowerCase()}-live.ts`, line: 1,
                })
              }
              if (!ctx.layerRelationsById.has(flowId)) {
                insertedRelations.push(
                  makeLayerFlowNode(flowId, layerQual, `libs/infra/src/${svcClean.toLowerCase()}-live.ts`),
                )
              }
              insertedEdges.push(
                makePlaysRoleEdge(flowId, layerKey, "provider-layer"),
                makePlaysRoleEdge(flowId, targetKey, "provided-service"),
              )
            }
          }

          const traceRelId = ctx.traceIdByTargetKey.get(deciderKey)
          const preservedKeys: Array<NodeKey> = [
            deciderKey, targetKey, NodeKey.make(sigRelId),
            ...(directEdge.entityKey !== targetKey ? [directEdge.entityKey] : []),
          ]
          if (traceRelId !== undefined) {
            preservedKeys.push(NodeKey.make(traceRelId))
            insertedEdges.push(makePlaysRoleEdge(traceRelId, ucKey, "realizing-symbol"))
          }

          return [
            [
              {
                ruleId: RewriteRuleId.make("REP-02"), phase: "REPAIR_ARCH", ruleCategory: "auto-repair",
                description: `Remove impure '${directEdge.role}' edge from '${deciderNode.spanName}' EffectSignature '${sigRelId}' in K (restoring R = never) and split out orchestrator '${ucSpan}'.`,
                primaryNodeKey: deciderKey, preservedInterfaceKeys: preservedKeys,
                deletedEntityKeys: [], deletedRelationIds: [],
                deletedRoleEdges: [directEdge],
                insertedEntityNodes: insertedEntities, insertedRelationNodes: insertedRelations, insertedRoleEdges: insertedEdges,
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
          (e) => e.entityKey === busTargetKey && match<string>(e.role).with("requires-service", "callee", () => true).otherwise(() => false),
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
              _tag: "ServiceTag", tagId: "OutboxStore", name: "OutboxStore", packageTag: "service",
              file: "libs/service/src/outbox-store.ts", line: 1,
            })
          }
          if (!ctx.fnsByKey.has(relayKey)) {
            insertedEntities.push({
              _tag: "EffectFn", qualname: relayQual, spanName: "Outbox.drain", packageTag: "infra",
              file: "libs/infra/src/outbox-relay.ts", line: 1,
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
          }
          if (busTargetKey.startsWith("EffectFn:")) {
            insertedEdges.push(makePlaysRoleEdge(relaySigId, busTargetKey, "callee"))
          }

          if (!hasLayerProviderForService(ctx, outboxPortKey)) {
            if (!ctx.layersByKey.has(outboxLayerKey)) {
              insertedEntities.push({
                _tag: "ServiceLayer", qualname: outboxLayerQual, layerKind: "live", packageTag: "infra",
                file: "libs/infra/src/outbox-store-live.ts", line: 1,
              })
            }
            if (!ctx.layerRelationsById.has(outboxFlowId)) {
              insertedRelations.push(
                makeLayerFlowNode(outboxFlowId, outboxLayerQual, "libs/infra/src/outbox-store-live.ts"),
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
                ruleId: RewriteRuleId.make("REP-03"), phase: "REPAIR_ARCH", ruleCategory: "auto-repair",
                description: `Replace direct EventBus coupling on aggregate '${aggNode.spanName}' EffectSignature '${sigRelId}' in K with transactional OutboxStore port and OutboxRelay worker.`,
                primaryNodeKey: aggKey, preservedInterfaceKeys: [aggKey, busTargetKey, NodeKey.make(sigRelId)],
                deletedEntityKeys: [], deletedRelationIds: [],
                deletedRoleEdges: [offendingEdge],
                insertedEntityNodes: insertedEntities, insertedRelationNodes: insertedRelations, insertedRoleEdges: insertedEdges,
              },
            ],
          ]
        }
      }
    }
  }

  // 4. REP-04a vs REP-04b: Multi-candidate resolution of unhandled-error / COMP-01
  const comp01Suggestion = inference.suggestedEdges.find(
    (s) => s.ruleId === "COMP-01" && match<string>(s.role).with("fails-with", () => true).otherwise(() => false),
  )
  if (comp01Suggestion !== undefined) {
    const sigRelId = comp01Suggestion.relationId
    const errKey = comp01Suggestion.targetEntityKey
    const errNode = ctx.errorsByKey.get(errKey)
    const errTag = errNode?.errorTag ?? errKey.replace(/^TaggedError:/, "")
    const callerEdge = (ctx.edgesByRelId.get(sigRelId) ?? []).find((e) => match<string>(e.role).with("caller", () => true).otherwise(() => false))
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
        ruleId: RewriteRuleId.make("REP-04a"), phase: "REPAIR_ARCH", ruleCategory: "auto-repair",
        description: `Propagate TaggedError '${errTag}' in caller '${callerNode.spanName}' E-channel by attaching fails-with PlaysRoleEdge to EffectSignature '${sigRelId}' in K.`,
        primaryNodeKey: callerKey, preservedInterfaceKeys: basePreserved,
        deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
        insertedEntityNodes: [], insertedRelationNodes: baseRelations,
        insertedRoleEdges: [...baseEdges, makePlaysRoleEdge(sigRelId, errKey, "fails-with")],
      }

      const updatedCaught = Array.from(new Set([...(callerNode.caughtErrors ?? []), errTag])).sort()
      const updatedCaller: EffectFnNode = { ...callerNode, caughtErrors: updatedCaught }
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
        ruleId: RewriteRuleId.make("REP-04b"), phase: "REPAIR_ARCH", ruleCategory: "auto-repair",
        description: `Catch and handle TaggedError '${errTag}' via Effect.catchTag at boundary '${callerNode.spanName}' while preserving EffectSignature '${sigRelId}' in K.`,
        primaryNodeKey: callerKey, preservedInterfaceKeys: preservedFor04b,
        deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
        insertedEntityNodes: updatedSpecsForBoundary, insertedRelationNodes: baseRelations, insertedRoleEdges: baseEdges,
      }

      return [[patch04a], [patch04b]]
    }
  }

  return []
}

// ============================================================================
// Confluence Branch Selection & Evaluation
// ============================================================================

export interface EvaluatedArchBranch {
  readonly draft: DraftGraphPatch
  readonly nextGraph: HarnessGraph
  readonly nextInference: GraphInferenceResult
  readonly nextMeasure: GraphMeasure
  readonly scoreMillis: SystemOneScoreMillis
}

export const evaluateAndSelectArchRepairBranch = Effect.fn(
  "GraphRewrite.evaluateArchBranches",
)(function* (
  branches: ReadonlyArray<Phase2CandidateBranch>,
  currentGraph: HarnessGraph,
  currentMeasure: GraphMeasure,
  candidatePriors?: DpoCandidatePriors,
): Effect.fn.Return<
  {
    readonly winner: EvaluatedArchBranch
    readonly alternatives: ReadonlyArray<EvaluatedArchBranch>
  },
  GraphRewriteError,
  never
> {
  const evaluatedBranches: Array<EvaluatedArchBranch> = []

  for (const branch of branches) {
    const draft = branch[0]
    if (draft === undefined) continue
    const nextGraph = yield* applyDpoPatchToGraph(currentGraph, draft)
    const nextInference = yield* decideGraphInference(nextGraph).pipe(
      Effect.mapError((err) =>
        mapInferenceErrorToRewriteError(err, draft.ruleId, draft.primaryNodeKey),
      ),
    )
    const nextMeasure = computeGraphMeasure(nextGraph, nextInference)
    if (!isStrictlyDecreasingMeasure(currentMeasure, nextMeasure)) {
      if (branches.length > 1) continue
      return yield* new GraphRewriteError({
        ruleId: draft.ruleId, nodeKey: draft.primaryNodeKey, reason: "non-decreasing-measure",
        message: `Rule ${draft.ruleId} failed to strictly decrease measure mu(G) in N^6.`,
      })
    }
    const scoreMillis = scoreDraftPatch(draft, currentGraph, candidatePriors)
    evaluatedBranches.push({ draft, nextGraph, nextInference, nextMeasure, scoreMillis })
  }

  if (evaluatedBranches.length === 0) {
    const fallbackDraft = branches[0]?.[0]
    return yield* new GraphRewriteError({
      ...(fallbackDraft !== undefined
        ? { ruleId: fallbackDraft.ruleId, nodeKey: fallbackDraft.primaryNodeKey }
        : {}),
      reason: "non-decreasing-measure",
      message: "No competing architectural repair branch strictly decreased measure mu(G) in N^6.",
    })
  }

  evaluatedBranches.sort((a, b) => {
    if (isStrictlyDecreasingMeasure(a.nextMeasure, b.nextMeasure)) return 1
    if (isStrictlyDecreasingMeasure(b.nextMeasure, a.nextMeasure)) return -1
    if (a.scoreMillis !== b.scoreMillis) return b.scoreMillis - a.scoreMillis
    return a.draft.ruleId.localeCompare(b.draft.ruleId)
  })

  return {
    winner: evaluatedBranches[0]!,
    alternatives: evaluatedBranches.slice(1),
  }
})
