import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  type BranchingViolation, type EntityNode, type GraphInferenceResult, type HarnessGraph,
  NodeKey, PlaysRoleEdge, type RelationNode, RewriteRuleId,
} from "../model.js"
import { isDeciderSpan, isReducerSpan } from "../policy-check.js"
import {
  type DraftGraphPatch, findFnBySpanOrQualname, hasLayerProviderForService,
  indexHarnessGraph, makeEffectSignatureNode, makeHttpEndpointTupleNode,
  makeLayerFlowNode, makeMigrationTupleNode, makePlaysRoleEdge,
  makeTraceabilityTupleNode, makeVitestCaseNode, sanitizeDpoIdentifier,
} from "./dpo-algebra-core.js"

// ============================================================================
// Phase 3: REPAIR_CODE DPO Candidate Generators (REP-05..10 + Completions)
// ============================================================================

export const findPhase3CodeRepairPatches = (
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
      const cleanScope = sanitizeDpoIdentifier(symbolTail.replace(/^decide|^evolve/, "")) || "Domain"
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
          ruleId: RewriteRuleId.make("REP-05"), phase: "REPAIR_CODE", ruleCategory: "auto-repair",
          description: `Upgrade untraced decider '${fnNode.qualname}' to traced Effect.fn("${canonicalSpan}") while preserving EffectSignature '${sigRelId}' in K.`,
          primaryNodeKey: NodeKey.make(fnKey), preservedInterfaceKeys: preservedKeys,
          deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
          insertedEntityNodes: [{ ...fnNode, spanName: canonicalSpan }],
          insertedRelationNodes: insertedRelations, insertedRoleEdges: insertedEdges,
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
          ruleId: RewriteRuleId.make("REP-06"), phase: "REPAIR_CODE", ruleCategory: "auto-repair",
          description: `Brand contract SchemaDef '${schemaNode.schemaName}' via Schema.brand("${schemaNode.schemaName}") in K.`,
          primaryNodeKey: NodeKey.make(schemaKey), preservedInterfaceKeys: [NodeKey.make(schemaKey)],
          deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
          insertedEntityNodes: [{ ...schemaNode, isBranded: true }],
          insertedRelationNodes: [], insertedRoleEdges: [],
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
        ruleId: RewriteRuleId.make("REP-07"), phase: "REPAIR_CODE", ruleCategory: "auto-repair",
        description: `Replace ad-hoc '${branchingViolation.rule}' in '${branchingViolation.enclosingSymbol}' with exhaustive ts-pattern match(...).exhaustive().`,
        primaryNodeKey: primaryKey, preservedInterfaceKeys: preserved,
        deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
        insertedEntityNodes: [], insertedRelationNodes: [], insertedRoleEdges: [],
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
        ruleId: RewriteRuleId.make("REP-08"), phase: "REPAIR_CODE", ruleCategory: "auto-repair",
        description: `Replace raw brand construction / boundary violation in '${boundaryViolation.enclosingSymbol}' with Schema.decodeUnknownEffect error edge in EffectSignature in K.`,
        primaryNodeKey: primaryKey, preservedInterfaceKeys: preserved,
        deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities, insertedRelationNodes: insertedRelations, insertedRoleEdges: insertedEdges,
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
        ruleId: RewriteRuleId.make("REP-09"), phase: "REPAIR_CODE", ruleCategory: "auto-repair",
        description: `Wrap unmanaged SQL DDL in '${ddlViolation.file}' into numbered MigrationTuple '1_init_tables' under SqliteMigrator.fromRecord.`,
        primaryNodeKey: primaryKey, preservedInterfaceKeys: preserved,
        deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
        insertedEntityNodes: [], insertedRelationNodes: insertedRelations, insertedRoleEdges: insertedEdges,
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
      }
      if (!isErr && isSvc) {
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
        const cleanSym = sanitizeDpoIdentifier(missingSymbol)
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
          ruleId: RewriteRuleId.make("REP-10"), phase: "REPAIR_CODE", ruleCategory: "auto-repair",
          description: `Resolve unmapped EARS symbol '${missingSymbol}' for '${specNode.id}' and bind via TraceabilityTuple '${traceRelId}' in K.`,
          primaryNodeKey: specKey, preservedInterfaceKeys: preserved,
          deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
          insertedEntityNodes: insertedEntities, insertedRelationNodes: insertedRelations, insertedRoleEdges: insertedEdges,
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
    const svcClean = sanitizeDpoIdentifier(rawSvcName)
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
        ruleId: RewriteRuleId.make("PLAN-04"), phase: "REPAIR_CODE", ruleCategory: "auto-repair",
        description: `Wire missing ServiceLayer provider '${layerQual}' and LayerFlow '${flowId}' for required service '${svcKey}'.`,
        primaryNodeKey: svcKey, preservedInterfaceKeys: preserved,
        deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities, insertedRelationNodes: insertedRelations,
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
    const cleanTarget = sanitizeDpoIdentifier(targetKey)
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
        ruleId: RewriteRuleId.make("PLAN-04"), phase: "REPAIR_CODE", ruleCategory: "auto-repair",
        description: `Attach verifying property test '${testId}' to '${targetKey}' via preserved relation in K.`,
        primaryNodeKey: targetKey, preservedInterfaceKeys: preserved,
        deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities, insertedRelationNodes: insertedRelations, insertedRoleEdges: insertedEdges,
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
          const layerQual = `libs/infra/src/auto-layer.ts#${sanitizeDpoIdentifier(relId)}Live`
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
      const svcClean = sanitizeDpoIdentifier(targetEntKey.replace(/^ServiceTag:/, ""))
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
        ruleId: RewriteRuleId.make("REP-10"), phase: "REPAIR_CODE", ruleCategory: "auto-repair",
        description: `Complete SuggestedEdge (${nextSuggestion.ruleId}) by attaching '${nextSuggestion.role}' -> '${targetEntKey}' on '${relId}'.`,
        primaryNodeKey: targetEntKey, preservedInterfaceKeys: preserved,
        deletedEntityKeys: [], deletedRelationIds: [], deletedRoleEdges: [],
        insertedEntityNodes: insertedEntities, insertedRelationNodes: insertedRelations, insertedRoleEdges: insertedEdges,
      },
    ]
  }

  return []
}

// ============================================================================
// Phase 4: CLEANUP DPO Candidate Generator (REP-11 with NAC_spec)
// ============================================================================

export const findPhase4CleanupPatches = (graph: HarnessGraph): ReadonlyArray<DraftGraphPatch> => {
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
        { _tag: "EffectFn" }, { _tag: "ServiceTag" }, { _tag: "ServiceLayer" },
        { _tag: "TaggedError" }, { _tag: "SchemaDef" }, { _tag: "VitestCase" },
        { _tag: "PatternDoc" }, { _tag: "EffectSignature" }, { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" }, { _tag: "HttpEndpointTuple" }, { _tag: "MigrationTuple" },
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
        ruleId: RewriteRuleId.make("REP-11"), phase: "CLEANUP", ruleCategory: "cleanup",
        description: `Prune orphan ServiceTag '${svcNode.name}' (${svcKey}) satisfying NAC_spec (zero incident role edges and unreferenced by EARS/ADR/stubs).`,
        primaryNodeKey: NodeKey.make(svcKey), preservedInterfaceKeys: [],
        deletedEntityKeys: [NodeKey.make(svcKey)], deletedRelationIds: [], deletedRoleEdges: [],
        insertedEntityNodes: [], insertedRelationNodes: [], insertedRoleEdges: [],
      },
    ]
  }

  return []
}
