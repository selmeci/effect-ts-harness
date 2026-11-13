import {
  type EffectFnNode,
  type EntityNode,
  type GraphInferenceResult,
  type HarnessGraph,
  NodeKey,
  PlaysRoleEdge,
  type RelationNode,
  RewriteRuleId,
  type TraceabilityTupleRelation,
} from "../model.js"
import { isDeciderSpan, isReducerSpan } from "../policy-check.js"
import {
  type DraftGraphPatch,
  findErrorByTag,
  findFnBySpanOrQualname,
  findServiceByTagOrName,
  hasLayerProviderForService,
  indexHarnessGraph,
  makeEffectSignatureNode,
  makeLayerFlowNode,
  makePlaysRoleEdge,
  makeTraceabilityTupleNode,
  makeVitestCaseNode,
  sanitizeDpoIdentifier,
} from "./dpo-algebra-core.js"

// ============================================================================
// Phase 1: PLAN DPO Candidate Generators (PLAN-01..04)
// ============================================================================

export const findPhase1PlanPatches = (
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
          ? [`${sanitizeDpoIdentifier(specNode.id)}.execute`]
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

      const cleanId = sanitizeDpoIdentifier(spanName)
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
      const cleanScope = sanitizeDpoIdentifier(scopePrefix)
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
          file: `libs/service/src/${sanitizeDpoIdentifier(svcName).toLowerCase()}.ts`,
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
        const layerQual = `libs/infra/src/${sanitizeDpoIdentifier(svcName).toLowerCase()}-live.ts#${sanitizeDpoIdentifier(svcName)}Live`
        const layerKey = `ServiceLayer:${layerQual}`
        const layerFlowId = `LayerFlow:layer-flow:${layerQual}`
        if (!ctx.layersByKey.has(layerKey)) {
          insertedEntities.push({
            _tag: "ServiceLayer",
            qualname: layerQual,
            layerKind: "live",
            packageTag: "infra",
            file: `libs/infra/src/${sanitizeDpoIdentifier(svcName).toLowerCase()}-live.ts`,
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
              `libs/infra/src/${sanitizeDpoIdentifier(svcName).toLowerCase()}-live.ts`,
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
