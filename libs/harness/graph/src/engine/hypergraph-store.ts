import { Effect, Option } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  decideConceptLattice,
  HARNESS_PERA_CONCEPT_LATTICE_CONFIG,
  validateRelationRolesWithLattice,
} from "../concept-lattice.js"
import {
  type AdrDocNode,
  type BranchingViolation,
  type ConceptLatticeResult,
  type EarsSpecNode,
  type EffectFnNode,
  type EffectSignatureRelation,
  type EntityNode,
  getArchimateRelationForRole,
  getEdgeKey,
  getNodeKey,
  type HarnessEdge,
  type HarnessGraph,
  HarnessGraphTypeId,
  type HarnessNode,
  type HttpEndpointTupleRelation,
  isEntityNode,
  isRelationNode,
  type LayerFlowRelation,
  type MigrationTupleRelation,
  NodeKey,
  type PatternDocNode,
  type PlaysRoleEdge,
  RelationId,
  type RelationNode,
  type SchemaDefNode,
  type ServiceLayerNode,
  type ServiceTagNode,
  type TaggedErrorNode,
  type TraceabilityTupleRelation,
  type UnresolvedGraphReference,
  type VitestCaseNode,
  RoleName,
} from "../model.js"

export type { HarnessGraph }

export interface BuildHarnessGraphInput {
  readonly entities?: ReadonlyArray<EntityNode> | undefined
  readonly relations?: ReadonlyArray<RelationNode> | undefined
  readonly playsRole?: ReadonlyArray<PlaysRoleEdge> | undefined
  readonly fns?: ReadonlyArray<Omit<EffectFnNode, "_tag">> | undefined
  readonly services?: ReadonlyArray<Omit<ServiceTagNode, "_tag">> | undefined
  readonly layers?: ReadonlyArray<Omit<ServiceLayerNode, "_tag">> | undefined
  readonly errors?: ReadonlyArray<Omit<TaggedErrorNode, "_tag">> | undefined
  readonly schemas?: ReadonlyArray<Omit<SchemaDefNode, "_tag">> | undefined
  readonly tests?: ReadonlyArray<Omit<VitestCaseNode, "_tag">> | undefined
  readonly patternDocs?: ReadonlyArray<Omit<PatternDocNode, "_tag">> | undefined
  readonly adrDocs?: ReadonlyArray<Omit<AdrDocNode, "_tag">> | undefined
  readonly earsSpecs?: ReadonlyArray<Omit<EarsSpecNode, "_tag">> | undefined
  readonly effectSignatures?: ReadonlyArray<Omit<EffectSignatureRelation, "_tag">> | undefined
  readonly layerFlows?: ReadonlyArray<Omit<LayerFlowRelation, "_tag">> | undefined
  readonly traceabilityTuples?: ReadonlyArray<Omit<TraceabilityTupleRelation, "_tag">> | undefined
  readonly httpEndpointTuples?: ReadonlyArray<Omit<HttpEndpointTupleRelation, "_tag">> | undefined
  readonly migrationTuples?: ReadonlyArray<Omit<MigrationTupleRelation, "_tag">> | undefined
  readonly requiresService?: ReadonlyArray<{ readonly callerQualname?: string | undefined; readonly fnQualname?: string | undefined; readonly tagId: string }> | undefined
  readonly failsWith?: ReadonlyArray<{ readonly callerQualname?: string | undefined; readonly fnQualname?: string | undefined; readonly errorTag: string }> | undefined
  readonly providesService?: ReadonlyArray<{ readonly layerQualname: string; readonly tagId: string }> | undefined
  readonly layerRequires?: ReadonlyArray<{ readonly layerQualname: string; readonly tagId: string }> | undefined
  readonly tracedCalls?: ReadonlyArray<{ readonly callerQualname: string; readonly calleeQualname: string; readonly callCount: number; readonly receiverLayer: string | null }> | undefined
  readonly exercisesSpans?: ReadonlyArray<{ readonly testId: string; readonly calleeQualname: string; readonly callCount: number; readonly receiverLayer: string | null }> | undefined
  readonly governsSymbols?: ReadonlyArray<{ readonly adrId: string; readonly targetKey: string; readonly targetKind: "span" | "service" | "error" | "EffectFn" | "ServiceTag" | "TaggedError" }> | undefined
  readonly specifiesSymbols?: ReadonlyArray<{ readonly specId: string; readonly targetKey: string; readonly targetKind: "span" | "service" | "error" | "EffectFn" | "ServiceTag" | "TaggedError"; readonly requirementIds?: ReadonlyArray<string> | undefined }> | undefined
  readonly branchingViolations?: ReadonlyArray<BranchingViolation> | undefined
  readonly unresolvedReferences?: ReadonlyArray<UnresolvedGraphReference> | undefined
}

const ROLE_EDGE_MAP: Readonly<Record<string, string>> = {
  "EffectSignature:EffectFn:caller": "PlaysCallerRole",
  "EffectSignature:EffectFn:callee": "PlaysCalleeRole",
  "EffectSignature:ServiceTag:requires-service": "PlaysRequiresServiceRole",
  "EffectSignature:TaggedError:fails-with": "PlaysFailsWithRole",
  "EffectSignature:SchemaDef:input-schema": "PlaysInputSchemaRole",
  "EffectSignature:SchemaDef:output-schema": "PlaysOutputSchemaRole",
  "EffectSignature:SchemaDef:uses-schema": "PlaysUsesSchemaRole",
  "LayerFlow:ServiceLayer:provider-layer": "PlaysProviderLayerRole",
  "LayerFlow:ServiceTag:provided-service": "PlaysProvidedServiceRole",
  "LayerFlow:ServiceTag:required-service": "PlaysRequiredServiceRole",
  "LayerFlow:TaggedError:fails-with": "PlaysLayerFailsWithRole",
  "TraceabilityTuple:AdrDoc:governing-adr": "PlaysGoverningAdrRole",
  "TraceabilityTuple:EarsSpec:specifying-ears": "PlaysSpecifyingEarsRole",
  "TraceabilityTuple:EarsSpec:specifying-spec": "PlaysSpecifyingEarsRole",
  "TraceabilityTuple:VitestCase:verifying-test": "PlaysVerifyingTestRole",
  "TraceabilityTuple:PatternDoc:enforcing-pattern": "PlaysEnforcingPatternRole",
  "TraceabilityTuple:VitestCase:exercising-test": "PlaysExercisingTestRole",
  "TraceabilityTuple:EffectFn:exercised-span": "PlaysExercisedSpanRole",
  "TraceabilityTuple:EffectFn:realizing-symbol": "PlaysRealizingFnRole",
  "TraceabilityTuple:ServiceTag:realizing-symbol": "PlaysRealizingServiceRole",
  "TraceabilityTuple:ServiceLayer:realizing-symbol": "PlaysRealizingLayerRole",
  "TraceabilityTuple:TaggedError:realizing-symbol": "PlaysRealizingErrorRole",
  "TraceabilityTuple:SchemaDef:realizing-symbol": "PlaysRealizingSchemaRole",
  "TraceabilityTuple:EffectFn:governed-symbol": "PlaysRealizingFnRole",
  "TraceabilityTuple:ServiceTag:governed-symbol": "PlaysRealizingServiceRole",
  "TraceabilityTuple:ServiceLayer:governed-symbol": "PlaysRealizingLayerRole",
  "TraceabilityTuple:TaggedError:governed-symbol": "PlaysRealizingErrorRole",
  "TraceabilityTuple:SchemaDef:governed-symbol": "PlaysRealizingSchemaRole",
  "TraceabilityTuple:EffectFn:specified-target": "PlaysSpecifiedTargetFnRole",
  "TraceabilityTuple:ServiceTag:specified-target": "PlaysSpecifiedTargetServiceRole",
  "TraceabilityTuple:ServiceLayer:specified-target": "PlaysSpecifiedTargetLayerRole",
  "TraceabilityTuple:TaggedError:specified-target": "PlaysSpecifiedTargetErrorRole",
  "TraceabilityTuple:SchemaDef:specified-target": "PlaysSpecifiedTargetSchemaRole",
  "HttpEndpointTuple:EffectFn:endpoint-handler": "PlaysEndpointHandlerRole",
  "HttpEndpointTuple:SchemaDef:request-schema": "PlaysRequestSchemaRole",
  "HttpEndpointTuple:SchemaDef:response-schema": "PlaysResponseSchemaRole",
  "HttpEndpointTuple:TaggedError:endpoint-error": "PlaysEndpointErrorRole",
  "MigrationTuple:VitestCase:verifying-test": "PlaysMigrationVerifyingTestRole",
}

export const mapPlaysRoleToOmnigraphEdgeName = (
  relTag: HarnessNode["_tag"],
  entityTag: HarnessNode["_tag"],
  role: string,
): string | undefined => ROLE_EDGE_MAP[`${relTag}:${entityTag}:${role}`]

export const isHarnessGraph = (u: unknown): u is HarnessGraph =>
  typeof u === "object" && u !== null && HarnessGraphTypeId in u

let cachedPeraConceptLatticeResult: ConceptLatticeResult | undefined

export const getPeraConceptLatticeResult = (): ConceptLatticeResult => {
  if (cachedPeraConceptLatticeResult === undefined) {
    cachedPeraConceptLatticeResult = Effect.runSync(
      decideConceptLattice(HARNESS_PERA_CONCEPT_LATTICE_CONFIG),
    )
  }
  return cachedPeraConceptLatticeResult
}

export const pushUnique = <T>(arr: Array<T>, item: T): void => {
  if (!arr.includes(item)) {
    arr.push(item)
  }
}

export const addEntityNodeIfMissing = (
  mutable: Graph.MutableDirectedGraph<HarnessNode, HarnessEdge>,
  nodeIndexByKey: Map<string, Graph.NodeIndex>,
  node: HarnessNode,
): Graph.NodeIndex => {
  const key = getNodeKey(node)
  const existing = nodeIndexByKey.get(key)
  if (existing !== undefined) return existing
  const idx = Graph.addNode(mutable, node)
  nodeIndexByKey.set(key, idx)
  return idx
}

type TargetEntityKind =
  | "span"
  | "service"
  | "error"
  | "schema"
  | "layer"
  | "test"
  | "pattern"
  | "EffectFn"
  | "ServiceTag"
  | "TaggedError"

const matchesNodeTarget = (node: EntityNode, targetKey: string): boolean =>
  match(node)
    .with({ _tag: "EffectFn" }, (n) => n.spanName === targetKey || n.qualname === targetKey)
    .with({ _tag: "ServiceTag" }, (n) => n.tagId === targetKey || n.name === targetKey)
    .with({ _tag: "TaggedError" }, (n) => n.errorTag === targetKey)
    .with({ _tag: "SchemaDef" }, (n) => n.schemaName === targetKey)
    .with({ _tag: "ServiceLayer" }, (n) => n.qualname === targetKey)
    .with({ _tag: "VitestCase" }, (n) => n.testId === targetKey || n.testName === targetKey)
    .with({ _tag: "PatternDoc" }, (n) => n.slug === targetKey || n.path === targetKey)
    .with({ _tag: "AdrDoc" }, (n) => n.id === targetKey)
    .with({ _tag: "EarsSpec" }, (n) => n.id === targetKey)
    .exhaustive()

/**
 * Builds the in-memory Clean-Slate PERA Bipartite Levi Hypergraph (`G_Levi = (V_E u V_R, E_role)`).
 */
export const buildHarnessGraph = (input: BuildHarnessGraphInput): HarnessGraph => {
  const nodeIndexByKey = new Map<string, Graph.NodeIndex>()
  const addedEdgeKeys = new Set<string>()
  const branchingViolations: Array<BranchingViolation> = [...(input.branchingViolations ?? [])]
  const unresolvedReferences: Array<UnresolvedGraphReference> = [
    ...(input.unresolvedReferences ?? []),
  ]

  const graph = Graph.directed<HarnessNode, HarnessEdge>((mutable) => {
    const addOrGetNode = (node: HarnessNode): Graph.NodeIndex =>
      addEntityNodeIfMissing(mutable, nodeIndexByKey, node)

    const addPlaysRole = (
      relIdx: Graph.NodeIndex,
      relId: RelationId,
      entityIdx: Graph.NodeIndex,
      entityKey: NodeKey,
      roleStr: string,
      extra?: {
        readonly archimateRelation?: string | undefined
        readonly callCount?: number | undefined
        readonly receiverLayer?: string | null | undefined
      },
    ): void => {
      const role = RoleName.make(roleStr)
      const edge: PlaysRoleEdge = {
        _tag: "PlaysRole",
        relationId: relId,
        entityKey,
        role,
        archimateRelation:
          extra?.archimateRelation ?? getArchimateRelationForRole(roleStr) ?? "Association",
        ...(extra?.callCount !== undefined ? { callCount: extra.callCount } : {}),
        ...(extra?.receiverLayer !== undefined ? { receiverLayer: extra.receiverLayer } : {}),
      }
      const edgeKey = getEdgeKey(edge)
      if (!addedEdgeKeys.has(edgeKey)) {
        addedEdgeKeys.add(edgeKey)
        Graph.addEdge(mutable, relIdx, entityIdx, edge)
      }
    }

    // 1. Register explicit EntityNodes
    for (const entity of input.entities ?? []) addOrGetNode(entity)
    for (const fn of input.fns ?? []) addOrGetNode({ _tag: "EffectFn", ...fn })
    for (const svc of input.services ?? []) addOrGetNode({ _tag: "ServiceTag", qualname: svc.qualname ?? svc.tagId, identifier: svc.identifier ?? svc.name, ...svc })
    for (const layer of input.layers ?? []) addOrGetNode({ _tag: "ServiceLayer", ...layer })
    for (const err of input.errors ?? []) addOrGetNode({ _tag: "TaggedError", tag: err.tag ?? err.errorTag, qualname: err.qualname ?? err.errorTag, ...err })
    for (const sc of input.schemas ?? []) addOrGetNode({ _tag: "SchemaDef", name: sc.name ?? sc.schemaName, qualname: sc.qualname ?? sc.schemaName, ...sc })
    for (const test of input.tests ?? []) addOrGetNode({ _tag: "VitestCase", qualname: test.qualname ?? test.testId, name: test.name ?? test.testName, file: test.file ?? test.testFile, ...test })
    for (const doc of input.patternDocs ?? []) addOrGetNode({ _tag: "PatternDoc", title: doc.title ?? doc.summary, ...doc })
    for (const adr of input.adrDocs ?? []) addOrGetNode({ _tag: "AdrDoc", ...adr })
    for (const spec of input.earsSpecs ?? []) addOrGetNode({ _tag: "EarsSpec", ...spec })

    const resolveTargetEntityKey = (
      targetKey: string,
      preferredKind?: TargetEntityKind,
    ): { readonly idx: Graph.NodeIndex; readonly key: NodeKey } | undefined => {
      if (nodeIndexByKey.has(targetKey)) {
        return { idx: nodeIndexByKey.get(targetKey)!, key: NodeKey.make(targetKey) }
      }
      const prefixes =
        preferredKind === "span" || preferredKind === "EffectFn"
          ? ["EffectFn"]
          : preferredKind === "service" || preferredKind === "ServiceTag"
            ? ["ServiceTag"]
            : preferredKind === "error" || preferredKind === "TaggedError"
              ? ["TaggedError"]
              : preferredKind === "schema"
                ? ["SchemaDef"]
                : preferredKind === "layer"
                  ? ["ServiceLayer"]
                  : preferredKind === "test"
                    ? ["VitestCase"]
                    : preferredKind === "pattern"
                      ? ["PatternDoc"]
                      : [
                          "EffectFn", "ServiceTag", "TaggedError", "ServiceLayer",
                          "SchemaDef", "VitestCase", "PatternDoc", "AdrDoc", "EarsSpec",
                        ]
      for (const prefix of prefixes) {
        const candidate = `${prefix}:${targetKey}`
        const idx = nodeIndexByKey.get(candidate)
        if (idx !== undefined) return { idx, key: NodeKey.make(candidate) }
      }

      const preferredTag = preferredKind !== undefined
        ? match(preferredKind)
            .with("span", "EffectFn", () => "EffectFn" as const)
            .with("service", "ServiceTag", () => "ServiceTag" as const)
            .with("error", "TaggedError", () => "TaggedError" as const)
            .with("schema", () => "SchemaDef" as const)
            .with("layer", () => "ServiceLayer" as const)
            .with("test", () => "VitestCase" as const)
            .with("pattern", () => "PatternDoc" as const)
            .exhaustive()
        : undefined

      for (const [idx, node] of Graph.nodes(mutable)) {
        if (!isEntityNode(node)) continue
        if (preferredTag !== undefined && node._tag !== preferredTag) continue
        if (matchesNodeTarget(node, targetKey)) return { idx, key: getNodeKey(node) }
      }
      return undefined
    }

    const linkPlaysRoleOrUnresolved = (
      relIdx: Graph.NodeIndex,
      relId: RelationId,
      targetKey: string,
      preferredKind: TargetEntityKind | undefined,
      role: string,
      extra?: {
        readonly file?: string | undefined
        readonly line?: number | undefined
        readonly archimateRelation?: string | undefined
        readonly callCount?: number | undefined
        readonly receiverLayer?: string | null | undefined
      },
    ): boolean => {
      const target = resolveTargetEntityKey(targetKey, preferredKind)
      if (target !== undefined) {
        addPlaysRole(relIdx, relId, target.idx, target.key, role, extra)
        return true
      }
      unresolvedReferences.push({
        relationId: relId,
        role: RoleName.make(role),
        targetKey,
        ...(extra?.file !== undefined ? { file: extra.file } : {}),
        ...(extra?.line !== undefined ? { line: extra.line } : {}),
      })
      return false
    }

    // 2. Wire EffectSignature relations
    const sigBuilders = new Map<
      string,
      {
        relationId: RelationId
        callerQualname: string
        requiredServices: Set<string>
        emittedErrors: Set<string>
        calleeQualnames: Set<string>
        calleeMeta: Map<string, { callCount: number; receiverLayer: string | null }>
        payloadSchemas: Set<string>
        file: string
        line: number
      }
    >()

    const getOrCreateSigBuilder = (callerQualname: string) => {
      const existing = sigBuilders.get(callerQualname)
      if (existing !== undefined) return existing
      const callerEntry = resolveTargetEntityKey(callerQualname, "span")
      const callerNodeOpt =
        callerEntry !== undefined ? Graph.getNode(mutable, callerEntry.idx) : Option.none()
      const callerFn = match(callerNodeOpt)
        .with({ _tag: "Some", value: { _tag: "EffectFn" } }, ({ value }) => value)
        .with({ _tag: "Some" }, () => undefined)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      const builder = {
        relationId: RelationId.make(`EffectSignature:${callerQualname}`),
        callerQualname,
        requiredServices: new Set<string>(),
        emittedErrors: new Set<string>(),
        calleeQualnames: new Set<string>(),
        calleeMeta: new Map<string, { callCount: number; receiverLayer: string | null }>(),
        payloadSchemas: new Set<string>(callerFn?.payloadSchemas ?? []),
        file: callerFn?.file ?? "",
        line: callerFn?.line ?? 1,
      }
      sigBuilders.set(callerQualname, builder)
      return builder
    }

    for (const sig of input.effectSignatures ?? []) {
      const b = getOrCreateSigBuilder(sig.callerQualname)
      b.relationId = sig.relationId
      b.file = sig.file
      b.line = sig.line
      for (const s of sig.requiredServices) b.requiredServices.add(s)
      for (const e of sig.emittedErrors) b.emittedErrors.add(e)
      for (const c of sig.calleeQualnames) b.calleeQualnames.add(c)
      for (const sc of sig.payloadSchemas) b.payloadSchemas.add(sc)
    }

    for (const req of input.requiresService ?? []) {
      const caller = req.callerQualname ?? req.fnQualname
      if (caller !== undefined) getOrCreateSigBuilder(caller).requiredServices.add(req.tagId)
    }
    for (const fail of input.failsWith ?? []) {
      const caller = fail.callerQualname ?? fail.fnQualname
      if (caller !== undefined) getOrCreateSigBuilder(caller).emittedErrors.add(fail.errorTag)
    }
    for (const call of input.tracedCalls ?? []) {
      const b = getOrCreateSigBuilder(call.callerQualname)
      b.calleeQualnames.add(call.calleeQualname)
      b.calleeMeta.set(call.calleeQualname, { callCount: call.callCount, receiverLayer: call.receiverLayer })
    }

    for (const [, node] of Graph.nodes(mutable)) {
      if (node._tag === "EffectFn") {
        if ((node.payloadSchemas?.length ?? 0) > 0 || node.inputSchema || node.outputSchema) {
          const b = getOrCreateSigBuilder(node.qualname)
          for (const s of node.payloadSchemas ?? []) b.payloadSchemas.add(s)
          if (node.inputSchema) b.payloadSchemas.add(node.inputSchema)
          if (node.outputSchema) b.payloadSchemas.add(node.outputSchema)
        }
      }
    }

    for (const [, b] of sigBuilders) {
      const callerTarget = resolveTargetEntityKey(b.callerQualname, "span")
      if (callerTarget === undefined) {
        unresolvedReferences.push({ relationId: b.relationId, role: RoleName.make("caller"), targetKey: b.callerQualname, file: b.file, line: b.line })
        continue
      }
      const sigNode: EffectSignatureRelation = {
        _tag: "EffectSignature",
        relationId: b.relationId,
        callerQualname: b.callerQualname,
        requiredServices: Array.from(b.requiredServices),
        emittedErrors: Array.from(b.emittedErrors),
        calleeQualnames: Array.from(b.calleeQualnames),
        payloadSchemas: Array.from(b.payloadSchemas),
        file: b.file,
        line: b.line,
      }
      const sigIdx = addOrGetNode(sigNode)
      addPlaysRole(sigIdx, b.relationId, callerTarget.idx, callerTarget.key, "caller")

      for (const svcId of b.requiredServices) linkPlaysRoleOrUnresolved(sigIdx, b.relationId, svcId, "service", "requires-service", { file: b.file, line: b.line })
      for (const errTag of b.emittedErrors) linkPlaysRoleOrUnresolved(sigIdx, b.relationId, errTag, "error", "fails-with", { file: b.file, line: b.line })
      for (const calleeQual of b.calleeQualnames) {
        const meta = b.calleeMeta.get(calleeQual)
        linkPlaysRoleOrUnresolved(sigIdx, b.relationId, calleeQual, "span", "callee", { callCount: meta?.callCount, receiverLayer: meta?.receiverLayer, file: b.file, line: b.line })
      }
      for (const schemaName of b.payloadSchemas) linkPlaysRoleOrUnresolved(sigIdx, b.relationId, schemaName, "schema", "uses-schema", { file: b.file, line: b.line })

      const callerNodeOpt = Graph.getNode(mutable, callerTarget.idx)
      const callerFnNode = match(callerNodeOpt)
        .with({ _tag: "Some", value: { _tag: "EffectFn" } }, ({ value }) => value)
        .with({ _tag: "Some" }, () => undefined)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()

      if (callerFnNode?.inputSchema) linkPlaysRoleOrUnresolved(sigIdx, b.relationId, callerFnNode.inputSchema, "schema", "input-schema", { file: b.file, line: b.line })
      if (callerFnNode?.outputSchema) linkPlaysRoleOrUnresolved(sigIdx, b.relationId, callerFnNode.outputSchema, "schema", "output-schema", { file: b.file, line: b.line })
    }

    // 3. Wire LayerFlow relations
    const layerBuilders = new Map<
      string,
      {
        relationId: RelationId
        layerQualname: string
        providesServices: Set<string>
        requiresServices: Set<string>
        emittedErrors: Set<string>
        file: string
        line: number
      }
    >()

    const getOrCreateLayerBuilder = (layerQualname: string) => {
      const existing = layerBuilders.get(layerQualname)
      if (existing !== undefined) return existing
      const layerEntry = resolveTargetEntityKey(layerQualname, "layer")
      const layerNodeOpt =
        layerEntry !== undefined ? Graph.getNode(mutable, layerEntry.idx) : Option.none()
      const layerEntity = match(layerNodeOpt)
        .with({ _tag: "Some", value: { _tag: "ServiceLayer" } }, ({ value }) => value)
        .with({ _tag: "Some" }, () => undefined)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      const builder = {
        relationId: RelationId.make(`LayerFlow:${layerQualname}`),
        layerQualname,
        providesServices: new Set<string>(),
        requiresServices: new Set<string>(),
        emittedErrors: new Set<string>(),
        file: layerEntity?.file ?? "",
        line: layerEntity?.line ?? 1,
      }
      layerBuilders.set(layerQualname, builder)
      return builder
    }

    for (const lf of input.layerFlows ?? []) {
      const b = getOrCreateLayerBuilder(lf.layerQualname)
      b.relationId = lf.relationId
      b.file = lf.file
      b.line = lf.line
      for (const p of lf.providesServices) b.providesServices.add(p)
      for (const r of lf.requiresServices) b.requiresServices.add(r)
      for (const e of lf.emittedErrors ?? []) b.emittedErrors.add(e)
    }

    for (const prov of input.providesService ?? []) getOrCreateLayerBuilder(prov.layerQualname).providesServices.add(prov.tagId)
    for (const req of input.layerRequires ?? []) getOrCreateLayerBuilder(req.layerQualname).requiresServices.add(req.tagId)

    for (const [, b] of layerBuilders) {
      const layerTarget = resolveTargetEntityKey(b.layerQualname, "layer")
      if (layerTarget === undefined) {
        unresolvedReferences.push({ relationId: b.relationId, role: RoleName.make("provider-layer"), targetKey: b.layerQualname, file: b.file, line: b.line })
        continue
      }
      const lfNode: LayerFlowRelation = {
        _tag: "LayerFlow",
        relationId: b.relationId,
        layerQualname: b.layerQualname,
        providesServices: Array.from(b.providesServices),
        requiresServices: Array.from(b.requiresServices),
        emittedErrors: Array.from(b.emittedErrors),
        file: b.file,
        line: b.line,
      }
      const lfIdx = addOrGetNode(lfNode)
      addPlaysRole(lfIdx, b.relationId, layerTarget.idx, layerTarget.key, "provider-layer")

      for (const svcId of b.providesServices) linkPlaysRoleOrUnresolved(lfIdx, b.relationId, svcId, "service", "provided-service", { file: b.file, line: b.line })
      for (const svcId of b.requiresServices) linkPlaysRoleOrUnresolved(lfIdx, b.relationId, svcId, "service", "required-service", { file: b.file, line: b.line })
      for (const errTag of b.emittedErrors) linkPlaysRoleOrUnresolved(lfIdx, b.relationId, errTag, "error", "fails-with", { file: b.file, line: b.line })
    }

    // 4. Wire TraceabilityTuple relations
    for (const tt of input.traceabilityTuples ?? []) {
      const targetEntity = resolveTargetEntityKey(tt.targetSymbolQualname)
      if (targetEntity === undefined) {
        unresolvedReferences.push({ relationId: tt.relationId, role: RoleName.make("realizing-symbol"), targetKey: tt.targetSymbolQualname })
        continue
      }
      const ttNode: TraceabilityTupleRelation = { _tag: "TraceabilityTuple", ...tt }
      const ttIdx = addOrGetNode(ttNode)
      addPlaysRole(ttIdx, tt.relationId, targetEntity.idx, targetEntity.key, "realizing-symbol")

      if (tt.adrId !== undefined) linkPlaysRoleOrUnresolved(ttIdx, tt.relationId, `AdrDoc:${tt.adrId}`, undefined, "governing-adr")
      if (tt.earsSpecId !== undefined) linkPlaysRoleOrUnresolved(ttIdx, tt.relationId, `EarsSpec:${tt.earsSpecId}`, undefined, "specifying-ears")
      for (const testQual of tt.verifyingTestQualnames) linkPlaysRoleOrUnresolved(ttIdx, tt.relationId, testQual, "test", "verifying-test")
      for (const patPath of tt.enforcingPatternPaths ?? []) linkPlaysRoleOrUnresolved(ttIdx, tt.relationId, patPath, "pattern", "enforcing-pattern")
    }

    for (const ex of input.exercisesSpans ?? []) {
      const testTarget = resolveTargetEntityKey(ex.testId, "test")
      const spanTarget = resolveTargetEntityKey(ex.calleeQualname, "span")
      const relId = RelationId.make(`TraceabilityTuple:exercise:${ex.testId}->${ex.calleeQualname}`)
      if (testTarget !== undefined && spanTarget !== undefined) {
        const ttNode: TraceabilityTupleRelation = {
          _tag: "TraceabilityTuple",
          relationId: relId,
          targetSymbolQualname: ex.calleeQualname,
          verifyingTestQualnames: [ex.testId],
        }
        const ttIdx = addOrGetNode(ttNode)
        addPlaysRole(ttIdx, relId, testTarget.idx, testTarget.key, "exercising-test", { callCount: ex.callCount, receiverLayer: ex.receiverLayer })
        addPlaysRole(ttIdx, relId, spanTarget.idx, spanTarget.key, "exercised-span", { callCount: ex.callCount, receiverLayer: ex.receiverLayer })
      } else {
        if (testTarget === undefined) unresolvedReferences.push({ relationId: relId, role: RoleName.make("exercising-test"), targetKey: ex.testId })
        if (spanTarget === undefined) unresolvedReferences.push({ relationId: relId, role: RoleName.make("exercised-span"), targetKey: ex.calleeQualname })
      }
    }

    for (const gov of input.governsSymbols ?? []) {
      const adrTarget = resolveTargetEntityKey(`AdrDoc:${gov.adrId}`)
      const symTarget = resolveTargetEntityKey(gov.targetKey, gov.targetKind)
      const resolvedKey = symTarget !== undefined ? symTarget.key : gov.targetKey
      const relId = RelationId.make(`TraceabilityTuple:governs:${gov.adrId}->${resolvedKey}`)
      if (adrTarget !== undefined && symTarget !== undefined) {
        const ttNode: TraceabilityTupleRelation = {
          _tag: "TraceabilityTuple",
          relationId: relId,
          adrId: gov.adrId,
          targetSymbolQualname: symTarget.key,
          verifyingTestQualnames: [],
        }
        const ttIdx = addOrGetNode(ttNode)
        addPlaysRole(ttIdx, relId, adrTarget.idx, adrTarget.key, "governing-adr")
        addPlaysRole(ttIdx, relId, symTarget.idx, symTarget.key, "realizing-symbol")
      } else {
        if (adrTarget === undefined) unresolvedReferences.push({ relationId: relId, role: RoleName.make("governing-adr"), targetKey: gov.adrId })
        if (symTarget === undefined) unresolvedReferences.push({ relationId: relId, role: RoleName.make("realizing-symbol"), targetKey: gov.targetKey })
      }
    }

    for (const spec of input.specifiesSymbols ?? []) {
      const specTarget = resolveTargetEntityKey(`EarsSpec:${spec.specId}`)
      const symTarget = resolveTargetEntityKey(spec.targetKey, spec.targetKind)
      const resolvedKey = symTarget !== undefined ? symTarget.key : spec.targetKey
      const relId = RelationId.make(`TraceabilityTuple:specifies:${spec.specId}->${resolvedKey}`)
      if (specTarget !== undefined && symTarget !== undefined) {
        const ttNode: TraceabilityTupleRelation = {
          _tag: "TraceabilityTuple",
          relationId: relId,
          earsSpecId: spec.specId,
          requirementId: spec.requirementIds?.[0],
          targetSymbolQualname: symTarget.key,
          verifyingTestQualnames: [],
        }
        const ttIdx = addOrGetNode(ttNode)
        addPlaysRole(ttIdx, relId, specTarget.idx, specTarget.key, "specifying-ears")
        addPlaysRole(ttIdx, relId, symTarget.idx, symTarget.key, "realizing-symbol")
      } else {
        if (specTarget === undefined) unresolvedReferences.push({ relationId: relId, role: RoleName.make("specifying-ears"), targetKey: spec.specId })
        if (symTarget === undefined) unresolvedReferences.push({ relationId: relId, role: RoleName.make("realizing-symbol"), targetKey: spec.targetKey })
      }
    }

    if (input.specifiesSymbols === undefined) {
      for (const [, node] of Graph.nodes(mutable)) {
        if (node._tag === "EarsSpec") {
          const specId = node.id
          const specTarget = resolveTargetEntityKey(`EarsSpec:${specId}`)
          if (specTarget === undefined) continue

          for (const targetKey of node.specifiedSymbols ?? []) {
            const matchedTarget = resolveTargetEntityKey(targetKey)
            if (matchedTarget !== undefined) {
              const relId = RelationId.make(`TraceabilityTuple:spec-target:${specId}->${matchedTarget.key}`)
              const ttNode: TraceabilityTupleRelation = {
                _tag: "TraceabilityTuple",
                relationId: relId,
                earsSpecId: specId,
                targetSymbolQualname: matchedTarget.key,
                verifyingTestQualnames: [],
              }
              const ttIdx = addOrGetNode(ttNode)
              addPlaysRole(ttIdx, relId, specTarget.idx, specTarget.key, "specifying-ears")
              addPlaysRole(ttIdx, relId, matchedTarget.idx, matchedTarget.key, "specified-target")
            }
          }
        }
      }
    }

    // 5. Wire HttpEndpointTuple and MigrationTuple relations
    for (const ep of input.httpEndpointTuples ?? []) {
      const epIdx = addOrGetNode({ _tag: "HttpEndpointTuple", ...ep })
      if (ep.handlerQualname !== undefined) linkPlaysRoleOrUnresolved(epIdx, ep.relationId, ep.handlerQualname, "span", "endpoint-handler", { file: ep.file, line: ep.line })
      for (const reqSchema of ep.requestSchemaQualnames) linkPlaysRoleOrUnresolved(epIdx, ep.relationId, reqSchema, "schema", "request-schema", { file: ep.file, line: ep.line })
      for (const resSchema of ep.responseSchemaQualnames) linkPlaysRoleOrUnresolved(epIdx, ep.relationId, resSchema, "schema", "response-schema", { file: ep.file, line: ep.line })
      for (const errTag of ep.errorTags) linkPlaysRoleOrUnresolved(epIdx, ep.relationId, errTag, "error", "endpoint-error", { file: ep.file, line: ep.line })
    }

    for (const mig of input.migrationTuples ?? []) {
      const migIdx = addOrGetNode({ _tag: "MigrationTuple", ...mig })
      for (const testQual of mig.verifyingTestQualnames) linkPlaysRoleOrUnresolved(migIdx, mig.relationId, testQual, "test", "verifying-test", { file: mig.moduleFile, line: mig.line })
    }

    // 6. Wire any explicit RelationNodes and PlaysRoleEdges
    for (const rel of input.relations ?? []) addOrGetNode(rel)
    for (const edge of input.playsRole ?? []) {
      const relKeyCandidates = [edge.relationId, `EffectSignature:${edge.relationId}`, `LayerFlow:${edge.relationId}`, `TraceabilityTuple:${edge.relationId}`, `HttpEndpointTuple:${edge.relationId}`, `MigrationTuple:${edge.relationId}`]
      let relIdx: Graph.NodeIndex | undefined
      for (const cand of relKeyCandidates) {
        const found = nodeIndexByKey.get(cand)
        if (found !== undefined) { relIdx = found; break }
      }
      const entityTarget = resolveTargetEntityKey(edge.entityKey)
      if (relIdx !== undefined && entityTarget !== undefined) {
        addPlaysRole(relIdx, edge.relationId, entityTarget.idx, entityTarget.key, edge.role, { archimateRelation: edge.archimateRelation, callCount: edge.callCount, receiverLayer: edge.receiverLayer })
      } else {
        if (relIdx === undefined) unresolvedReferences.push({ relationId: edge.relationId, role: RoleName.make(edge.role), targetKey: edge.relationId })
        if (entityTarget === undefined) unresolvedReferences.push({ relationId: edge.relationId, role: RoleName.make(edge.role), targetKey: edge.entityKey })
      }
    }

    // 7. Validate all RelationNodes and their PlaysRoleEdges against the PERA Concept Lattice (F-4)
    for (const [relIdx, node] of Graph.nodes(mutable)) {
      if (!isRelationNode(node)) continue
      const roleEdges: Array<{ readonly role: string; readonly entityTag: string }> = []
      for (const edgeIdx of Graph.outgoingEdges(mutable, relIdx)) {
        const edgeOpt = Graph.getEdge(mutable, edgeIdx)
        match(edgeOpt)
          .with({ _tag: "Some" }, ({ value: edge }) => {
            const targetOpt = Graph.getNode(mutable, edge.target)
            match(targetOpt)
              .with({ _tag: "Some" }, ({ value: target }) => {
                roleEdges.push({
                  role: edge.data.role,
                  entityTag: target._tag,
                })
              })
              .with({ _tag: "None" }, () => {})
              .exhaustive()
          })
          .with({ _tag: "None" }, () => {})
          .exhaustive()
      }
      const violations = validateRelationRolesWithLattice(
        getPeraConceptLatticeResult(),
        node._tag,
        roleEdges,
      )
      for (const v of violations) {
        branchingViolations.push({
          rule: "invalid-graph-role",
          message: v,
          file: "file" in node ? String(node.file) : "",
          line: "line" in node ? Number(node.line) : 1,
          enclosingSymbol: node.relationId,
        })
      }
    }
  })

  return {
    [HarnessGraphTypeId]: HarnessGraphTypeId,
    graph,
    nodeIndexByKey,
    ...(branchingViolations.length > 0 ? { branchingViolations } : {}),
    ...(unresolvedReferences.length > 0 ? { unresolvedReferences } : {}),
  }
}
