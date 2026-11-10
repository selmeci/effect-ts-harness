import * as fs from "node:fs"
import * as path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Graph from "effect/Graph"
import * as Option from "effect/Option"
import { match } from "ts-pattern"
import {
  HARNESS_PERA_CONCEPT_LATTICE_CONFIG,
  decideConceptLattice,
  validateRelationRolesWithLattice,
} from "./concept-lattice.js"
import {
  type AdrDocNode,
  type BranchingViolation,
  type EarsSpecNode,
  type EffectFnNode,
  type EffectSignatureRelation,
  type EntityNode,
  getArchimateRelationForRole,
  getEdgeKey,
  getNodeKey,
  GraphSnapshotError,
  HarnessEdge,
  type HarnessGraph,
  HarnessGraphTypeId,
  HarnessNode,
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
  type RelationTag,
  RoleName,
  type SchemaDefNode,
  type ServiceLayerNode,
  type ServiceTagNode,
  type TaggedErrorNode,
  type TraceabilityTupleRelation,
  UnresolvedGraphReference,
  type VitestCaseNode,
} from "./model.js"

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
  readonly requiresService?:
    | ReadonlyArray<{
        readonly callerQualname?: string | undefined
        readonly fnQualname?: string | undefined
        readonly tagId: string
      }>
    | undefined
  readonly failsWith?:
    | ReadonlyArray<{
        readonly callerQualname?: string | undefined
        readonly fnQualname?: string | undefined
        readonly errorTag: string
      }>
    | undefined
  readonly providesService?:
    | ReadonlyArray<{ readonly layerQualname: string; readonly tagId: string }>
    | undefined
  readonly layerRequires?:
    | ReadonlyArray<{ readonly layerQualname: string; readonly tagId: string }>
    | undefined
  readonly tracedCalls?:
    | ReadonlyArray<{
        readonly callerQualname: string
        readonly calleeQualname: string
        readonly callCount: number
        readonly receiverLayer: string | null
      }>
    | undefined
  readonly exercisesSpans?:
    | ReadonlyArray<{
        readonly testId: string
        readonly calleeQualname: string
        readonly callCount: number
        readonly receiverLayer: string | null
      }>
    | undefined
  readonly governsSymbols?:
    | ReadonlyArray<{
        readonly adrId: string
        readonly targetKey: string
        readonly targetKind:
          | "span"
          | "service"
          | "error"
          | "EffectFn"
          | "ServiceTag"
          | "TaggedError"
      }>
    | undefined
  readonly specifiesSymbols?:
    | ReadonlyArray<{
        readonly specId: string
        readonly targetKey: string
        readonly targetKind:
          | "span"
          | "service"
          | "error"
          | "EffectFn"
          | "ServiceTag"
          | "TaggedError"
        readonly requirementIds?: ReadonlyArray<string> | undefined
      }>
    | undefined
  readonly branchingViolations?: ReadonlyArray<BranchingViolation> | undefined
  readonly unresolvedReferences?: ReadonlyArray<UnresolvedGraphReference> | undefined
}

export const mapPlaysRoleToOmnigraphEdgeName = (
  relTag: HarnessNode["_tag"],
  entityTag: HarnessNode["_tag"],
  role: string,
): string | undefined =>
  match(relTag)
    .with("EffectSignature", () => {
      if (role === "caller" && entityTag === "EffectFn") return "PlaysCallerRole"
      if (role === "callee" && entityTag === "EffectFn") return "PlaysCalleeRole"
      if (role === "requires-service" && entityTag === "ServiceTag")
        return "PlaysRequiresServiceRole"
      if (role === "fails-with" && entityTag === "TaggedError") return "PlaysFailsWithRole"
      if (role === "input-schema" && entityTag === "SchemaDef") return "PlaysInputSchemaRole"
      if (role === "output-schema" && entityTag === "SchemaDef") return "PlaysOutputSchemaRole"
      if (role === "uses-schema" && entityTag === "SchemaDef") return "PlaysUsesSchemaRole"
      return undefined
    })
    .with("LayerFlow", () => {
      if (role === "provider-layer" && entityTag === "ServiceLayer") return "PlaysProviderLayerRole"
      if (role === "provided-service" && entityTag === "ServiceTag")
        return "PlaysProvidedServiceRole"
      if (role === "required-service" && entityTag === "ServiceTag")
        return "PlaysRequiredServiceRole"
      if (role === "fails-with" && entityTag === "TaggedError") return "PlaysLayerFailsWithRole"
      return undefined
    })
    .with("TraceabilityTuple", () => {
      if (role === "governing-adr" && entityTag === "AdrDoc") return "PlaysGoverningAdrRole"
      if ((role === "specifying-ears" || role === "specifying-spec") && entityTag === "EarsSpec") {
        return "PlaysSpecifyingEarsRole"
      }
      if (role === "realizing-symbol" || role === "governed-symbol") {
        return match(entityTag)
          .with("EffectFn", () => "PlaysRealizingFnRole")
          .with("ServiceTag", () => "PlaysRealizingServiceRole")
          .with("ServiceLayer", () => "PlaysRealizingLayerRole")
          .with("TaggedError", () => "PlaysRealizingErrorRole")
          .with("SchemaDef", () => "PlaysRealizingSchemaRole")
          .with(
            "VitestCase",
            "PatternDoc",
            "AdrDoc",
            "EarsSpec",
            "EffectSignature",
            "LayerFlow",
            "TraceabilityTuple",
            "HttpEndpointTuple",
            "MigrationTuple",
            () => undefined,
          )
          .exhaustive()
      }
      if (role === "specified-target") {
        return match(entityTag)
          .with("EffectFn", () => "PlaysSpecifiedTargetFnRole")
          .with("ServiceTag", () => "PlaysSpecifiedTargetServiceRole")
          .with("ServiceLayer", () => "PlaysSpecifiedTargetLayerRole")
          .with("TaggedError", () => "PlaysSpecifiedTargetErrorRole")
          .with("SchemaDef", () => "PlaysSpecifiedTargetSchemaRole")
          .with(
            "VitestCase",
            "PatternDoc",
            "AdrDoc",
            "EarsSpec",
            "EffectSignature",
            "LayerFlow",
            "TraceabilityTuple",
            "HttpEndpointTuple",
            "MigrationTuple",
            () => undefined,
          )
          .exhaustive()
      }
      if (role === "verifying-test" && entityTag === "VitestCase") return "PlaysVerifyingTestRole"
      if (role === "enforcing-pattern" && entityTag === "PatternDoc")
        return "PlaysEnforcingPatternRole"
      if (role === "exercising-test" && entityTag === "VitestCase") return "PlaysExercisingTestRole"
      if (role === "exercised-span" && entityTag === "EffectFn") return "PlaysExercisedSpanRole"
      return undefined
    })
    .with("HttpEndpointTuple", () => {
      if (role === "endpoint-handler" && entityTag === "EffectFn") return "PlaysEndpointHandlerRole"
      if (role === "request-schema" && entityTag === "SchemaDef") return "PlaysRequestSchemaRole"
      if (role === "response-schema" && entityTag === "SchemaDef") return "PlaysResponseSchemaRole"
      if (role === "endpoint-error" && entityTag === "TaggedError") return "PlaysEndpointErrorRole"
      return undefined
    })
    .with("MigrationTuple", () => {
      if (role === "verifying-test" && entityTag === "VitestCase") {
        return "PlaysMigrationVerifyingTestRole"
      }
      return undefined
    })
    .with(
      "EffectFn",
      "ServiceTag",
      "ServiceLayer",
      "TaggedError",
      "SchemaDef",
      "VitestCase",
      "PatternDoc",
      "AdrDoc",
      "EarsSpec",
      () => undefined,
    )
    .exhaustive()

export const isHarnessGraph = (u: unknown): u is HarnessGraph =>
  typeof u === "object" && u !== null && HarnessGraphTypeId in u

const PERA_CONCEPT_LATTICE_RESULT = Effect.runSync(
  decideConceptLattice(HARNESS_PERA_CONCEPT_LATTICE_CONFIG),
)

/**
 * Builds the in-memory Clean-Slate PERA Bipartite Levi Hypergraph (`G_Levi = (V_E u V_R, E_role)`).
 * Every semantic relationship is reified as a `RelationNode` in `V_R` connected to `EntityNode`s in `V_E`
 * exclusively via `PlaysRoleEdge`s (`relationIdx -> entityIdx`).
 */
export const buildHarnessGraph = (input: BuildHarnessGraphInput): HarnessGraph => {
  const nodeIndexByKey = new Map<string, Graph.NodeIndex>()
  const addedEdgeKeys = new Set<string>()
  const branchingViolations: Array<BranchingViolation> = [...(input.branchingViolations ?? [])]
  const unresolvedReferences: Array<UnresolvedGraphReference> = [
    ...(input.unresolvedReferences ?? []),
  ]

  const graph = Graph.directed<HarnessNode, HarnessEdge>((mutable) => {
    const addOrGetNode = (node: HarnessNode): Graph.NodeIndex => {
      const key = getNodeKey(node)
      const existing = nodeIndexByKey.get(key)
      if (existing !== undefined) {
        return existing
      }
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(key, idx)
      return idx
    }

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
    for (const entity of input.entities ?? []) {
      addOrGetNode(entity)
    }

    for (const fn of input.fns ?? []) {
      addOrGetNode({ _tag: "EffectFn", ...fn })
    }
    for (const svc of input.services ?? []) {
      addOrGetNode({
        _tag: "ServiceTag",
        qualname: svc.qualname ?? svc.tagId,
        identifier: svc.identifier ?? svc.name,
        ...svc,
      })
    }
    for (const layer of input.layers ?? []) {
      addOrGetNode({ _tag: "ServiceLayer", ...layer })
    }
    for (const err of input.errors ?? []) {
      addOrGetNode({
        _tag: "TaggedError",
        tag: err.tag ?? err.errorTag,
        qualname: err.qualname ?? err.errorTag,
        ...err,
      })
    }
    for (const sc of input.schemas ?? []) {
      addOrGetNode({
        _tag: "SchemaDef",
        name: sc.name ?? sc.schemaName,
        qualname: sc.qualname ?? sc.schemaName,
        ...sc,
      })
    }
    for (const test of input.tests ?? []) {
      addOrGetNode({
        _tag: "VitestCase",
        qualname: test.qualname ?? test.testId,
        name: test.name ?? test.testName,
        file: test.file ?? test.testFile,
        ...test,
      })
    }
    for (const doc of input.patternDocs ?? []) {
      addOrGetNode({
        _tag: "PatternDoc",
        title: doc.title ?? doc.summary,
        ...doc,
      })
    }
    for (const adr of input.adrDocs ?? []) {
      addOrGetNode({ _tag: "AdrDoc", ...adr })
    }
    for (const spec of input.earsSpecs ?? []) {
      addOrGetNode({ _tag: "EarsSpec", ...spec })
    }

    const resolveTargetEntityKey = (
      targetKey: string,
      preferredKind?:
        | "span"
        | "service"
        | "error"
        | "schema"
        | "layer"
        | "test"
        | "pattern"
        | "EffectFn"
        | "ServiceTag"
        | "TaggedError",
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
                          "EffectFn",
                          "ServiceTag",
                          "TaggedError",
                          "ServiceLayer",
                          "SchemaDef",
                          "VitestCase",
                          "PatternDoc",
                          "AdrDoc",
                          "EarsSpec",
                        ]
      for (const prefix of prefixes) {
        const candidate = `${prefix}:${targetKey}`
        const idx = nodeIndexByKey.get(candidate)
        if (idx !== undefined) {
          return { idx, key: NodeKey.make(candidate) }
        }
      }

      if (preferredKind !== undefined) {
        const preferredTag = match(preferredKind)
          .with("span", "EffectFn", () => "EffectFn" as const)
          .with("service", "ServiceTag", () => "ServiceTag" as const)
          .with("error", "TaggedError", () => "TaggedError" as const)
          .with("schema", () => "SchemaDef" as const)
          .with("layer", () => "ServiceLayer" as const)
          .with("test", () => "VitestCase" as const)
          .with("pattern", () => "PatternDoc" as const)
          .exhaustive()

        for (const [idx, node] of Graph.nodes(mutable)) {
          if (!isEntityNode(node) || node._tag !== preferredTag) continue
          const matched = match(node)
            .with({ _tag: "EffectFn" }, (n) => n.spanName === targetKey || n.qualname === targetKey)
            .with({ _tag: "ServiceTag" }, (n) => n.tagId === targetKey || n.name === targetKey)
            .with({ _tag: "TaggedError" }, (n) => n.errorTag === targetKey)
            .with({ _tag: "SchemaDef" }, (n) => n.schemaName === targetKey)
            .with({ _tag: "ServiceLayer" }, (n) => n.qualname === targetKey)
            .with({ _tag: "VitestCase" }, (n) => n.testId === targetKey || n.testName === targetKey)
            .with({ _tag: "PatternDoc" }, (n) => n.slug === targetKey || n.path === targetKey)
            .exhaustive()
          if (matched) {
            return { idx, key: getNodeKey(node) }
          }
        }
        return undefined
      }

      for (const [idx, node] of Graph.nodes(mutable)) {
        if (!isEntityNode(node)) continue
        const matched = match(node)
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
        if (matched) {
          return { idx, key: getNodeKey(node) }
        }
      }
      return undefined
    }

    // 2. Wire EffectSignature relations (explicit + aggregated from requiresService/failsWith/tracedCalls)
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
      const callerFn =
        Option.isSome(callerNodeOpt) && callerNodeOpt.value._tag === "EffectFn"
          ? callerNodeOpt.value
          : undefined
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
      if (caller !== undefined) {
        getOrCreateSigBuilder(caller).requiredServices.add(req.tagId)
      }
    }
    for (const fail of input.failsWith ?? []) {
      const caller = fail.callerQualname ?? fail.fnQualname
      if (caller !== undefined) {
        getOrCreateSigBuilder(caller).emittedErrors.add(fail.errorTag)
      }
    }
    for (const call of input.tracedCalls ?? []) {
      const b = getOrCreateSigBuilder(call.callerQualname)
      b.calleeQualnames.add(call.calleeQualname)
      b.calleeMeta.set(call.calleeQualname, {
        callCount: call.callCount,
        receiverLayer: call.receiverLayer,
      })
    }

    // Ensure every EffectFn with payloadSchemas also gets an EffectSignature if it has schemas
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
        unresolvedReferences.push({
          relationId: b.relationId,
          role: RoleName.make("caller"),
          targetKey: b.callerQualname,
          file: b.file,
          line: b.line,
        })
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

      for (const svcId of b.requiredServices) {
        const svcTarget = resolveTargetEntityKey(svcId, "service")
        if (svcTarget !== undefined) {
          addPlaysRole(sigIdx, b.relationId, svcTarget.idx, svcTarget.key, "requires-service")
        } else {
          unresolvedReferences.push({
            relationId: b.relationId,
            role: RoleName.make("requires-service"),
            targetKey: svcId,
            file: b.file,
            line: b.line,
          })
        }
      }
      for (const errTag of b.emittedErrors) {
        const errTarget = resolveTargetEntityKey(errTag, "error")
        if (errTarget !== undefined) {
          addPlaysRole(sigIdx, b.relationId, errTarget.idx, errTarget.key, "fails-with")
        } else {
          unresolvedReferences.push({
            relationId: b.relationId,
            role: RoleName.make("fails-with"),
            targetKey: errTag,
            file: b.file,
            line: b.line,
          })
        }
      }
      for (const calleeQual of b.calleeQualnames) {
        const calleeTarget = resolveTargetEntityKey(calleeQual, "span")
        if (calleeTarget !== undefined) {
          const meta = b.calleeMeta.get(calleeQual)
          addPlaysRole(sigIdx, b.relationId, calleeTarget.idx, calleeTarget.key, "callee", meta)
        } else {
          unresolvedReferences.push({
            relationId: b.relationId,
            role: RoleName.make("callee"),
            targetKey: calleeQual,
            file: b.file,
            line: b.line,
          })
        }
      }
      for (const schemaName of b.payloadSchemas) {
        const schemaTarget = resolveTargetEntityKey(schemaName, "schema")
        if (schemaTarget !== undefined) {
          addPlaysRole(sigIdx, b.relationId, schemaTarget.idx, schemaTarget.key, "uses-schema")
        } else {
          unresolvedReferences.push({
            relationId: b.relationId,
            role: RoleName.make("uses-schema"),
            targetKey: schemaName,
            file: b.file,
            line: b.line,
          })
        }
      }

      const callerNodeOpt = Graph.getNode(mutable, callerTarget.idx)
      const callerFnNode =
        Option.isSome(callerNodeOpt) && callerNodeOpt.value._tag === "EffectFn"
          ? callerNodeOpt.value
          : undefined

      if (callerFnNode?.inputSchema) {
        const inputTarget = resolveTargetEntityKey(callerFnNode.inputSchema, "schema")
        if (inputTarget !== undefined) {
          addPlaysRole(sigIdx, b.relationId, inputTarget.idx, inputTarget.key, "input-schema")
        } else {
          unresolvedReferences.push({
            relationId: b.relationId,
            role: RoleName.make("input-schema"),
            targetKey: callerFnNode.inputSchema,
            file: b.file,
            line: b.line,
          })
        }
      }

      if (callerFnNode?.outputSchema) {
        const outputTarget = resolveTargetEntityKey(callerFnNode.outputSchema, "schema")
        if (outputTarget !== undefined) {
          addPlaysRole(sigIdx, b.relationId, outputTarget.idx, outputTarget.key, "output-schema")
        } else {
          unresolvedReferences.push({
            relationId: b.relationId,
            role: RoleName.make("output-schema"),
            targetKey: callerFnNode.outputSchema,
            file: b.file,
            line: b.line,
          })
        }
      }
    }

    // 3. Wire LayerFlow relations (explicit + aggregated from providesService/layerRequires)
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
      const layerEntity =
        Option.isSome(layerNodeOpt) && layerNodeOpt.value._tag === "ServiceLayer"
          ? layerNodeOpt.value
          : undefined
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

    for (const prov of input.providesService ?? []) {
      getOrCreateLayerBuilder(prov.layerQualname).providesServices.add(prov.tagId)
    }
    for (const req of input.layerRequires ?? []) {
      getOrCreateLayerBuilder(req.layerQualname).requiresServices.add(req.tagId)
    }

    for (const [, b] of layerBuilders) {
      const layerTarget = resolveTargetEntityKey(b.layerQualname, "layer")
      if (layerTarget === undefined) {
        unresolvedReferences.push({
          relationId: b.relationId,
          role: RoleName.make("provider-layer"),
          targetKey: b.layerQualname,
          file: b.file,
          line: b.line,
        })
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

      for (const svcId of b.providesServices) {
        const svcTarget = resolveTargetEntityKey(svcId, "service")
        if (svcTarget !== undefined) {
          addPlaysRole(lfIdx, b.relationId, svcTarget.idx, svcTarget.key, "provided-service")
        } else {
          unresolvedReferences.push({
            relationId: b.relationId,
            role: RoleName.make("provided-service"),
            targetKey: svcId,
            file: b.file,
            line: b.line,
          })
        }
      }
      for (const svcId of b.requiresServices) {
        const svcTarget = resolveTargetEntityKey(svcId, "service")
        if (svcTarget !== undefined) {
          addPlaysRole(lfIdx, b.relationId, svcTarget.idx, svcTarget.key, "required-service")
        } else {
          unresolvedReferences.push({
            relationId: b.relationId,
            role: RoleName.make("required-service"),
            targetKey: svcId,
            file: b.file,
            line: b.line,
          })
        }
      }
      for (const errTag of b.emittedErrors) {
        const errTarget = resolveTargetEntityKey(errTag, "error")
        if (errTarget !== undefined) {
          addPlaysRole(lfIdx, b.relationId, errTarget.idx, errTarget.key, "fails-with")
        } else {
          unresolvedReferences.push({
            relationId: b.relationId,
            role: RoleName.make("fails-with"),
            targetKey: errTag,
            file: b.file,
            line: b.line,
          })
        }
      }
    }

    // 4. Wire TraceabilityTuple relations (explicit + exercisesSpans + governsSymbols + specifiesSymbols)
    for (const tt of input.traceabilityTuples ?? []) {
      const targetEntity = resolveTargetEntityKey(tt.targetSymbolQualname)
      if (targetEntity === undefined) {
        unresolvedReferences.push({
          relationId: tt.relationId,
          role: RoleName.make("realizing-symbol"),
          targetKey: tt.targetSymbolQualname,
        })
        continue
      }
      const ttNode: TraceabilityTupleRelation = { _tag: "TraceabilityTuple", ...tt }
      const ttIdx = addOrGetNode(ttNode)
      addPlaysRole(ttIdx, tt.relationId, targetEntity.idx, targetEntity.key, "realizing-symbol")

      if (tt.adrId !== undefined) {
        const adrTarget = resolveTargetEntityKey(`AdrDoc:${tt.adrId}`)
        if (adrTarget !== undefined) {
          addPlaysRole(ttIdx, tt.relationId, adrTarget.idx, adrTarget.key, "governing-adr")
        } else {
          unresolvedReferences.push({
            relationId: tt.relationId,
            role: RoleName.make("governing-adr"),
            targetKey: tt.adrId,
          })
        }
      }
      if (tt.earsSpecId !== undefined) {
        const specTarget = resolveTargetEntityKey(`EarsSpec:${tt.earsSpecId}`)
        if (specTarget !== undefined) {
          addPlaysRole(ttIdx, tt.relationId, specTarget.idx, specTarget.key, "specifying-ears")
        } else {
          unresolvedReferences.push({
            relationId: tt.relationId,
            role: RoleName.make("specifying-ears"),
            targetKey: tt.earsSpecId,
          })
        }
      }
      for (const testQual of tt.verifyingTestQualnames) {
        const testTarget = resolveTargetEntityKey(testQual, "test")
        if (testTarget !== undefined) {
          addPlaysRole(ttIdx, tt.relationId, testTarget.idx, testTarget.key, "verifying-test")
        } else {
          unresolvedReferences.push({
            relationId: tt.relationId,
            role: RoleName.make("verifying-test"),
            targetKey: testQual,
          })
        }
      }
      for (const patPath of tt.enforcingPatternPaths ?? []) {
        const patTarget = resolveTargetEntityKey(patPath, "pattern")
        if (patTarget !== undefined) {
          addPlaysRole(ttIdx, tt.relationId, patTarget.idx, patTarget.key, "enforcing-pattern")
        } else {
          unresolvedReferences.push({
            relationId: tt.relationId,
            role: RoleName.make("enforcing-pattern"),
            targetKey: patPath,
          })
        }
      }
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
        addPlaysRole(ttIdx, relId, testTarget.idx, testTarget.key, "exercising-test", {
          callCount: ex.callCount,
          receiverLayer: ex.receiverLayer,
        })
        addPlaysRole(ttIdx, relId, spanTarget.idx, spanTarget.key, "exercised-span", {
          callCount: ex.callCount,
          receiverLayer: ex.receiverLayer,
        })
      } else {
        if (testTarget === undefined) {
          unresolvedReferences.push({
            relationId: relId,
            role: RoleName.make("exercising-test"),
            targetKey: ex.testId,
          })
        }
        if (spanTarget === undefined) {
          unresolvedReferences.push({
            relationId: relId,
            role: RoleName.make("exercised-span"),
            targetKey: ex.calleeQualname,
          })
        }
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
        if (adrTarget === undefined) {
          unresolvedReferences.push({
            relationId: relId,
            role: RoleName.make("governing-adr"),
            targetKey: gov.adrId,
          })
        }
        if (symTarget === undefined) {
          unresolvedReferences.push({
            relationId: relId,
            role: RoleName.make("realizing-symbol"),
            targetKey: gov.targetKey,
          })
        }
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
        if (specTarget === undefined) {
          unresolvedReferences.push({
            relationId: relId,
            role: RoleName.make("specifying-ears"),
            targetKey: spec.specId,
          })
        }
        if (symTarget === undefined) {
          unresolvedReferences.push({
            relationId: relId,
            role: RoleName.make("realizing-symbol"),
            targetKey: spec.targetKey,
          })
        }
      }
    }

    // Connect EarsSpec nodes to matching specifiedSymbols via specified-target role (F-11)
    if (input.specifiesSymbols === undefined) {
      for (const [, node] of Graph.nodes(mutable)) {
        if (node._tag === "EarsSpec") {
          const specId = node.id
          const specTarget = resolveTargetEntityKey(`EarsSpec:${specId}`)
          if (specTarget === undefined) continue

          for (const targetKey of node.specifiedSymbols ?? []) {
            const matchedTarget = resolveTargetEntityKey(targetKey)
            if (matchedTarget !== undefined) {
              const relId = RelationId.make(
                `TraceabilityTuple:spec-target:${specId}->${matchedTarget.key}`,
              )
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
      const epNode: HttpEndpointTupleRelation = { _tag: "HttpEndpointTuple", ...ep }
      const epIdx = addOrGetNode(epNode)
      if (ep.handlerQualname !== undefined) {
        const handlerTarget = resolveTargetEntityKey(ep.handlerQualname, "span")
        if (handlerTarget !== undefined) {
          addPlaysRole(
            epIdx,
            ep.relationId,
            handlerTarget.idx,
            handlerTarget.key,
            "endpoint-handler",
          )
        } else {
          unresolvedReferences.push({
            relationId: ep.relationId,
            role: RoleName.make("endpoint-handler"),
            targetKey: ep.handlerQualname,
            file: ep.file,
            line: ep.line,
          })
        }
      }
      for (const reqSchema of ep.requestSchemaQualnames) {
        const scTarget = resolveTargetEntityKey(reqSchema, "schema")
        if (scTarget !== undefined) {
          addPlaysRole(epIdx, ep.relationId, scTarget.idx, scTarget.key, "request-schema")
        } else {
          unresolvedReferences.push({
            relationId: ep.relationId,
            role: RoleName.make("request-schema"),
            targetKey: reqSchema,
            file: ep.file,
            line: ep.line,
          })
        }
      }
      for (const resSchema of ep.responseSchemaQualnames) {
        const scTarget = resolveTargetEntityKey(resSchema, "schema")
        if (scTarget !== undefined) {
          addPlaysRole(epIdx, ep.relationId, scTarget.idx, scTarget.key, "response-schema")
        } else {
          unresolvedReferences.push({
            relationId: ep.relationId,
            role: RoleName.make("response-schema"),
            targetKey: resSchema,
            file: ep.file,
            line: ep.line,
          })
        }
      }
      for (const errTag of ep.errorTags) {
        const errTarget = resolveTargetEntityKey(errTag, "error")
        if (errTarget !== undefined) {
          addPlaysRole(epIdx, ep.relationId, errTarget.idx, errTarget.key, "endpoint-error")
        } else {
          unresolvedReferences.push({
            relationId: ep.relationId,
            role: RoleName.make("endpoint-error"),
            targetKey: errTag,
            file: ep.file,
            line: ep.line,
          })
        }
      }
    }

    for (const mig of input.migrationTuples ?? []) {
      const migNode: MigrationTupleRelation = { _tag: "MigrationTuple", ...mig }
      const migIdx = addOrGetNode(migNode)
      for (const testQual of mig.verifyingTestQualnames) {
        const testTarget = resolveTargetEntityKey(testQual, "test")
        if (testTarget !== undefined) {
          addPlaysRole(migIdx, mig.relationId, testTarget.idx, testTarget.key, "verifying-test")
        } else {
          unresolvedReferences.push({
            relationId: mig.relationId,
            role: RoleName.make("verifying-test"),
            targetKey: testQual,
            file: mig.moduleFile,
            line: mig.line,
          })
        }
      }
    }

    // 6. Wire any explicit RelationNodes and PlaysRoleEdges
    for (const rel of input.relations ?? []) {
      addOrGetNode(rel)
    }
    for (const edge of input.playsRole ?? []) {
      const relKeyCandidates = [
        edge.relationId,
        `EffectSignature:${edge.relationId}`,
        `LayerFlow:${edge.relationId}`,
        `TraceabilityTuple:${edge.relationId}`,
        `HttpEndpointTuple:${edge.relationId}`,
        `MigrationTuple:${edge.relationId}`,
      ]
      let relIdx: Graph.NodeIndex | undefined
      for (const cand of relKeyCandidates) {
        const found = nodeIndexByKey.get(cand)
        if (found !== undefined) {
          relIdx = found
          break
        }
      }
      const entityTarget = resolveTargetEntityKey(edge.entityKey)
      if (relIdx !== undefined && entityTarget !== undefined) {
        addPlaysRole(relIdx, edge.relationId, entityTarget.idx, entityTarget.key, edge.role, {
          archimateRelation: edge.archimateRelation,
          callCount: edge.callCount,
          receiverLayer: edge.receiverLayer,
        })
      } else {
        if (relIdx === undefined) {
          unresolvedReferences.push({
            relationId: edge.relationId,
            role: RoleName.make(edge.role),
            targetKey: edge.relationId,
          })
        }
        if (entityTarget === undefined) {
          unresolvedReferences.push({
            relationId: edge.relationId,
            role: RoleName.make(edge.role),
            targetKey: edge.entityKey,
          })
        }
      }
    }

    // 7. Validate all RelationNodes and their PlaysRoleEdges against the PERA Concept Lattice (F-4)
    for (const [relIdx, node] of Graph.nodes(mutable)) {
      if (!isRelationNode(node)) continue
      const roleEdges: Array<{ readonly role: string; readonly entityTag: string }> = []
      for (const edgeIdx of Graph.outgoingEdges(mutable, relIdx)) {
        const edgeOpt = Graph.getEdge(mutable, edgeIdx)
        if (Option.isSome(edgeOpt)) {
          const targetOpt = Graph.getNode(mutable, edgeOpt.value.target)
          if (Option.isSome(targetOpt)) {
            roleEdges.push({
              role: edgeOpt.value.data.role,
              entityTag: targetOpt.value._tag,
            })
          }
        }
      }
      const violations = validateRelationRolesWithLattice(
        PERA_CONCEPT_LATTICE_RESULT,
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

/**
 * Resolves any `EntityNode` or `RelationNode` by `NodeKey`, `qualname`, `spanName`, `tagId`,
 * `errorTag`, `schemaName`, `testId`, `slug`, `id`, `relationId`, or `#shortName`.
 */
export const resolveNode = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): HarnessNode | undefined => {
  const directIdx =
    harnessGraph.nodeIndexByKey.get(symbolOrSpan) ??
    harnessGraph.nodeIndexByKey.get(`EffectFn:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`ServiceTag:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`ServiceLayer:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`TaggedError:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`SchemaDef:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`VitestCase:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`PatternDoc:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`AdrDoc:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`EarsSpec:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`EffectSignature:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`LayerFlow:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`TraceabilityTuple:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`HttpEndpointTuple:${symbolOrSpan}`) ??
    harnessGraph.nodeIndexByKey.get(`MigrationTuple:${symbolOrSpan}`)

  if (directIdx !== undefined) {
    return Option.getOrUndefined(Graph.getNode(harnessGraph.graph, directIdx))
  }

  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    const matched = match(node)
      .with(
        { _tag: "EffectFn" },
        (n) =>
          n.spanName === symbolOrSpan ||
          n.qualname === symbolOrSpan ||
          n.qualname.endsWith(`#${symbolOrSpan}`),
      )
      .with(
        { _tag: "ServiceTag" },
        (n) =>
          n.name === symbolOrSpan ||
          n.tagId === symbolOrSpan ||
          n.tagId.endsWith(`#${symbolOrSpan}`),
      )
      .with(
        { _tag: "ServiceLayer" },
        (n) => n.qualname === symbolOrSpan || n.qualname.endsWith(`#${symbolOrSpan}`),
      )
      .with({ _tag: "TaggedError" }, (n) => n.errorTag === symbolOrSpan)
      .with({ _tag: "SchemaDef" }, (n) => n.schemaName === symbolOrSpan)
      .with({ _tag: "VitestCase" }, (n) => n.testId === symbolOrSpan || n.testName === symbolOrSpan)
      .with(
        { _tag: "PatternDoc" },
        (n) =>
          n.slug === symbolOrSpan ||
          n.path === symbolOrSpan ||
          n.path.endsWith(`/${symbolOrSpan}`) ||
          n.path.includes(symbolOrSpan),
      )
      .with(
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        (n) =>
          n.id === symbolOrSpan ||
          n.path === symbolOrSpan ||
          n.path.endsWith(`/${symbolOrSpan}`) ||
          n.path.includes(symbolOrSpan),
      )
      .with(
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        (n) => n.relationId === symbolOrSpan,
      )
      .exhaustive()

    if (matched) {
      return node
    }
  }
  return undefined
}

export interface CallerMatch {
  readonly nodeTag: HarnessNode["_tag"]
  readonly qualname: string
  readonly spanName?: string | undefined
  readonly name?: string | undefined
  readonly testId?: string | undefined
  readonly testFile?: string | undefined
  readonly testName?: string | undefined
  readonly tagId?: string | undefined
  readonly errorTag?: string | undefined
  readonly schemaName?: string | undefined
  readonly docId?: string | undefined
  readonly docPath?: string | undefined
  readonly edgeKind: string
  readonly role: RoleName
  readonly relationTag: RelationTag
  readonly relationId: RelationId
  readonly callCount?: number | undefined
  readonly receiverLayer?: string | null | undefined
}

const mapRoleToEdgeKind = (role: RoleName): string =>
  match<string, string>(role)
    .with("caller", "callee", () => "TracedCall")
    .with("requires-service", () => "RequiresService")
    .with("fails-with", () => "FailsWith")
    .with("provided-service", () => "ProvidesService")
    .with("required-service", () => "LayerRequires")
    .with("governing-adr", () => "GovernsSymbol")
    .with("specifying-ears", () => "SpecifiesSymbol")
    .with("exercising-test", "exercised-span", "verifying-test", () => "ExercisesSpan")
    .with("enforcing-pattern", () => "CoversPattern")
    .otherwise((r) => r)

const buildCallerMatchFromPeer = (
  peerNode: EntityNode,
  relNode: RelationNode,
  edge: PlaysRoleEdge,
  effectiveRole: RoleName,
): CallerMatch => {
  const base = {
    nodeTag: peerNode._tag,
    edgeKind: mapRoleToEdgeKind(effectiveRole),
    role: effectiveRole,
    relationTag: relNode._tag,
    relationId: relNode.relationId,
    ...(edge.callCount !== undefined ? { callCount: edge.callCount } : {}),
    ...(edge.receiverLayer !== undefined ? { receiverLayer: edge.receiverLayer } : {}),
  }

  return match(peerNode)
    .with({ _tag: "EffectFn" }, (n) => ({
      ...base,
      qualname: n.qualname,
      spanName: n.spanName,
    }))
    .with({ _tag: "ServiceTag" }, (n) => ({
      ...base,
      qualname: n.tagId,
      tagId: n.tagId,
      name: n.name,
    }))
    .with({ _tag: "ServiceLayer" }, (n) => ({
      ...base,
      qualname: n.qualname,
    }))
    .with({ _tag: "TaggedError" }, (n) => ({
      ...base,
      qualname: n.errorTag,
      errorTag: n.errorTag,
      spanName: n.errorTag,
    }))
    .with({ _tag: "SchemaDef" }, (n) => ({
      ...base,
      qualname: n.schemaName,
      schemaName: n.schemaName,
    }))
    .with({ _tag: "VitestCase" }, (n) => ({
      ...base,
      qualname: n.testId,
      testId: n.testId,
      testFile: n.testFile,
      testName: n.testName,
    }))
    .with({ _tag: "PatternDoc" }, (n) => ({
      ...base,
      qualname: n.slug,
      docId: n.slug,
      docPath: n.path,
    }))
    .with({ _tag: "AdrDoc" }, { _tag: "EarsSpec" }, (n) => ({
      ...base,
      qualname: n.id,
      spanName: n.title,
      docId: n.id,
      docPath: n.path,
    }))
    .exhaustive()
}

const SUBJECT_ROLES_BY_RELATION: Readonly<Record<RelationTag, ReadonlySet<string>>> = {
  EffectSignature: new Set(["caller"]),
  LayerFlow: new Set(["provider-layer"]),
  TraceabilityTuple: new Set([
    "governing-adr",
    "specifying-ears",
    "verifying-test",
    "exercising-test",
    "enforcing-pattern",
  ]),
  HttpEndpointTuple: new Set(["endpoint-handler"]),
  MigrationTuple: new Set(["verifying-test"]),
}

const OBJECT_ROLES_BY_RELATION: Readonly<Record<RelationTag, ReadonlySet<string>>> = {
  EffectSignature: new Set([
    "callee",
    "requires-service",
    "fails-with",
    "uses-schema",
    "input-schema",
    "output-schema",
  ]),
  LayerFlow: new Set(["provided-service", "required-service", "fails-with"]),
  TraceabilityTuple: new Set(["realizing-symbol", "exercised-span"]),
  HttpEndpointTuple: new Set(["request-schema", "response-schema", "endpoint-error"]),
  MigrationTuple: new Set(["migration-module"]),
}

/**
 * Finds all callers / governing / exercising entities of a target symbol across reified `RelationNode`s.
 */
export const findCallers = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): ReadonlyArray<CallerMatch> => {
  const targetNode = resolveNode(harnessGraph, symbolOrSpan)
  if (!targetNode) return []
  const targetIdx = harnessGraph.nodeIndexByKey.get(getNodeKey(targetNode))
  if (targetIdx === undefined) return []

  const results: Array<CallerMatch> = []
  const seen = new Set<string>()

  // Incoming PlaysRole edges from RelationNodes -> targetNode
  const incoming = Graph.incomingEdges(harnessGraph.graph, targetIdx)
  for (const inEdgeIdx of incoming) {
    const inEdgeOpt = Graph.getEdge(harnessGraph.graph, inEdgeIdx)
    if (Option.isNone(inEdgeOpt)) continue
    const inEdge = inEdgeOpt.value
    const relOpt = Graph.getNode(harnessGraph.graph, inEdge.source)
    if (Option.isNone(relOpt) || !isRelationNode(relOpt.value)) continue
    const relNode = relOpt.value

    const objectRoles = OBJECT_ROLES_BY_RELATION[relNode._tag]
    if (!objectRoles.has(inEdge.data.role)) continue

    const subjectRoles = SUBJECT_ROLES_BY_RELATION[relNode._tag]
    const outEdges = Graph.outgoingEdges(harnessGraph.graph, inEdge.source)
    for (const outEdgeIdx of outEdges) {
      if (outEdgeIdx === inEdgeIdx) continue
      const outEdgeOpt = Graph.getEdge(harnessGraph.graph, outEdgeIdx)
      if (Option.isNone(outEdgeOpt)) continue
      const outEdge = outEdgeOpt.value
      if (!subjectRoles.has(outEdge.data.role)) continue
      const peerOpt = Graph.getNode(harnessGraph.graph, outEdge.target)
      if (Option.isNone(peerOpt) || !isEntityNode(peerOpt.value)) continue

      const effectiveRole =
        relNode._tag === "TraceabilityTuple" ? outEdge.data.role : inEdge.data.role
      const matchEntry = buildCallerMatchFromPeer(
        peerOpt.value,
        relNode,
        inEdge.data.callCount !== undefined || inEdge.data.receiverLayer !== undefined
          ? inEdge.data
          : outEdge.data,
        effectiveRole,
      )
      const dedupKey = `${relNode.relationId}:${getNodeKey(peerOpt.value)}:${effectiveRole}`
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey)
        results.push(matchEntry)
      }
    }
  }

  return results
}

/**
 * Finds all callees, required services, emitted errors, schemas, and realized targets
 * of a symbol across reified `RelationNode`s.
 */
export const findCallees = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): ReadonlyArray<CallerMatch> => {
  const sourceNode = resolveNode(harnessGraph, symbolOrSpan)
  if (!sourceNode) return []
  const sourceIdx = harnessGraph.nodeIndexByKey.get(getNodeKey(sourceNode))
  if (sourceIdx === undefined) return []

  const results: Array<CallerMatch> = []
  const seen = new Set<string>()

  if (isRelationNode(sourceNode)) {
    const outEdges = Graph.outgoingEdges(harnessGraph.graph, sourceIdx)
    for (const outEdgeIdx of outEdges) {
      const outEdgeOpt = Graph.getEdge(harnessGraph.graph, outEdgeIdx)
      if (Option.isNone(outEdgeOpt)) continue
      const peerOpt = Graph.getNode(harnessGraph.graph, outEdgeOpt.value.target)
      if (Option.isNone(peerOpt) || !isEntityNode(peerOpt.value)) continue
      results.push(
        buildCallerMatchFromPeer(
          peerOpt.value,
          sourceNode,
          outEdgeOpt.value.data,
          outEdgeOpt.value.data.role,
        ),
      )
    }
    return results
  }

  const incoming = Graph.incomingEdges(harnessGraph.graph, sourceIdx)
  for (const inEdgeIdx of incoming) {
    const inEdgeOpt = Graph.getEdge(harnessGraph.graph, inEdgeIdx)
    if (Option.isNone(inEdgeOpt)) continue
    const inEdge = inEdgeOpt.value
    const relOpt = Graph.getNode(harnessGraph.graph, inEdge.source)
    if (Option.isNone(relOpt) || !isRelationNode(relOpt.value)) continue
    const relNode = relOpt.value

    const subjectRoles = SUBJECT_ROLES_BY_RELATION[relNode._tag]
    if (!subjectRoles.has(inEdge.data.role)) continue

    const objectRoles = OBJECT_ROLES_BY_RELATION[relNode._tag]
    const outEdges = Graph.outgoingEdges(harnessGraph.graph, inEdge.source)
    for (const outEdgeIdx of outEdges) {
      if (outEdgeIdx === inEdgeIdx) continue
      const outEdgeOpt = Graph.getEdge(harnessGraph.graph, outEdgeIdx)
      if (Option.isNone(outEdgeOpt)) continue
      const outEdge = outEdgeOpt.value
      if (!objectRoles.has(outEdge.data.role)) continue
      const peerOpt = Graph.getNode(harnessGraph.graph, outEdge.target)
      if (Option.isNone(peerOpt) || !isEntityNode(peerOpt.value)) continue

      const effectiveRole =
        relNode._tag === "TraceabilityTuple" &&
        (inEdge.data.role === "governing-adr" ||
          inEdge.data.role === "specifying-ears" ||
          inEdge.data.role === "verifying-test" ||
          inEdge.data.role === "exercising-test")
          ? inEdge.data.role
          : outEdge.data.role

      const matchEntry = buildCallerMatchFromPeer(
        peerOpt.value,
        relNode,
        outEdge.data,
        effectiveRole,
      )
      const dedupKey = `${relNode.relationId}:${getNodeKey(peerOpt.value)}:${effectiveRole}`
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey)
        results.push(matchEntry)
      }
    }
  }

  return results
}

/**
 * Finds all `VitestCaseNode`s reaching `symbolOrSpan` directly (`TraceabilityTuple`)
 * or transitively through `EffectSignature` call chains.
 */
export const findTestsReaching = (
  harnessGraph: HarnessGraph,
  symbolOrSpan: string,
): ReadonlyArray<VitestCaseNode> => {
  const targetNode = resolveNode(harnessGraph, symbolOrSpan)
  if (!targetNode) return []
  const targetIdx = harnessGraph.nodeIndexByKey.get(getNodeKey(targetNode))
  if (targetIdx === undefined) return []

  const visited = new Set<Graph.NodeIndex>([targetIdx])
  const queue: Array<Graph.NodeIndex> = [targetIdx]
  const tests = new Map<string, VitestCaseNode>()

  while (queue.length > 0) {
    const currentEntityIdx = queue.shift()!
    const currentOpt = Graph.getNode(harnessGraph.graph, currentEntityIdx)
    match(currentOpt)
      .with({ _tag: "Some", value: { _tag: "VitestCase" } }, ({ value }) => {
        tests.set(value.testId, value)
      })
      .with({ _tag: "Some" }, () => {})
      .with({ _tag: "None" }, () => {})
      .exhaustive()

    const incoming = Graph.incomingEdges(harnessGraph.graph, currentEntityIdx)
    for (const inEdgeIdx of incoming) {
      const inEdgeOpt = Graph.getEdge(harnessGraph.graph, inEdgeIdx)
      if (Option.isNone(inEdgeOpt)) continue
      const inEdge = inEdgeOpt.value
      const relOpt = Graph.getNode(harnessGraph.graph, inEdge.source)
      if (Option.isNone(relOpt) || !isRelationNode(relOpt.value)) continue
      const relNode = relOpt.value

      // Traverse backwards across EffectSignature (callee -> caller) or TraceabilityTuple (exercised-span/realizing-symbol -> exercising-test/verifying-test)
      const isTargetRole = match(relNode)
        .with({ _tag: "EffectSignature" }, () => inEdge.data.role === "callee")
        .with(
          { _tag: "TraceabilityTuple" },
          () => inEdge.data.role === "exercised-span" || inEdge.data.role === "realizing-symbol",
        )
        .with(
          { _tag: "LayerFlow" },
          { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          () => false,
        )
        .exhaustive()

      if (!isTargetRole) continue

      const outEdges = Graph.outgoingEdges(harnessGraph.graph, inEdge.source)
      for (const outEdgeIdx of outEdges) {
        const outEdgeOpt = Graph.getEdge(harnessGraph.graph, outEdgeIdx)
        if (Option.isNone(outEdgeOpt)) continue
        const outEdge = outEdgeOpt.value
        const isSourceRole = match(relNode)
          .with({ _tag: "EffectSignature" }, () => outEdge.data.role === "caller")
          .with(
            { _tag: "TraceabilityTuple" },
            () => outEdge.data.role === "exercising-test" || outEdge.data.role === "verifying-test",
          )
          .with(
            { _tag: "LayerFlow" },
            { _tag: "HttpEndpointTuple" },
            { _tag: "MigrationTuple" },
            () => false,
          )
          .exhaustive()

        if (isSourceRole && !visited.has(outEdge.target)) {
          visited.add(outEdge.target)
          queue.push(outEdge.target)
        }
      }
    }
  }

  return Array.from(tests.values())
}

/**
 * Renders the Levi hypergraph as a Mermaid flowchart via `Graph.toMermaid`.
 */
export const renderMermaid = (harnessGraph: HarnessGraph): string =>
  Graph.toMermaid(harnessGraph.graph, {
    nodeLabel: (node) =>
      match(node)
        .with({ _tag: "EffectFn" }, (n) => `${n.spanName} [${n.packageTag}]`)
        .with({ _tag: "ServiceTag" }, (n) => `Service: ${n.name}`)
        .with({ _tag: "ServiceLayer" }, (n) => `Layer: ${n.qualname} (${n.layerKind ?? "live"})`)
        .with({ _tag: "TaggedError" }, (n) => `Error: ${n.errorTag}`)
        .with({ _tag: "SchemaDef" }, (n) => `Schema: ${n.schemaName}`)
        .with({ _tag: "VitestCase" }, (n) => `Test: ${n.testName}`)
        .with({ _tag: "PatternDoc" }, (n) => `Pattern: ${n.slug}`)
        .with({ _tag: "AdrDoc" }, (n) => `ADR:${n.id} (${n.title})`)
        .with({ _tag: "EarsSpec" }, (n) => `Spec:${n.id} (${n.title})`)
        .with({ _tag: "EffectSignature" }, (n) => `Sig: ${n.callerQualname}`)
        .with({ _tag: "LayerFlow" }, (n) => `LayerFlow: ${n.layerQualname}`)
        .with({ _tag: "TraceabilityTuple" }, (n) => `Trace: ${n.relationId}`)
        .with({ _tag: "HttpEndpointTuple" }, (n) => `HTTP: ${n.method} ${n.path}`)
        .with({ _tag: "MigrationTuple" }, (n) => `Migration: ${n.migrationId}`)
        .exhaustive(),
    edgeLabel: (edge) => `${edge._tag}:${edge.role}`,
  })

const getOmnigraphVertexQualname = (node: HarnessNode): string =>
  match(node)
    .with({ _tag: "EffectFn" }, (n) => n.qualname)
    .with({ _tag: "ServiceTag" }, (n) => n.tagId)
    .with({ _tag: "ServiceLayer" }, (n) => n.qualname)
    .with({ _tag: "TaggedError" }, (n) => n.errorTag)
    .with({ _tag: "SchemaDef" }, (n) => n.schemaName)
    .with({ _tag: "VitestCase" }, (n) => n.testId)
    .with({ _tag: "PatternDoc" }, (n) => n.slug)
    .with({ _tag: "AdrDoc" }, { _tag: "EarsSpec" }, (n) => n.id)
    .with(
      { _tag: "EffectSignature" },
      { _tag: "LayerFlow" },
      { _tag: "TraceabilityTuple" },
      { _tag: "HttpEndpointTuple" },
      { _tag: "MigrationTuple" },
      (n) => n.relationId,
    )
    .exhaustive()

/**
 * Exports the Clean-Slate PERA Levi hypergraph as Omnigraph NDJSON matching `schema.pg`.
 * Only concrete `EntityNode` and `RelationNode` vertices and `PlaysRole` edges are emitted.
 */
export const toOmnigraphNdjson = (harnessGraph: HarnessGraph): string => {
  const lines: Array<string> = []

  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    const line = match(node)
      .with({ _tag: "EffectFn" }, (n) =>
        JSON.stringify({
          type: "EffectFn",
          key: n.qualname,
          properties: {
            qualname: n.qualname,
            spanName: n.spanName,
            packageTag: n.packageTag,
            file: n.file,
            line: n.line,
            isStub: n.isStub ?? false,
            payloadSchemas: n.payloadSchemas ? JSON.stringify(n.payloadSchemas) : null,
            inputSchema: n.inputSchema ?? null,
            outputSchema: n.outputSchema ?? null,
          },
        }),
      )
      .with({ _tag: "ServiceTag" }, (n) =>
        JSON.stringify({
          type: "ServiceTag",
          key: n.tagId,
          properties: {
            qualname: n.tagId,
            identifier: n.name,
            file: n.file,
            line: n.line ?? 1,
          },
        }),
      )
      .with({ _tag: "ServiceLayer" }, (n) =>
        JSON.stringify({
          type: "ServiceLayer",
          key: n.qualname,
          properties: {
            qualname: n.qualname,
            file: n.file,
            line: n.line ?? 1,
          },
        }),
      )
      .with({ _tag: "TaggedError" }, (n) =>
        JSON.stringify({
          type: "TaggedError",
          key: n.errorTag,
          properties: {
            qualname: n.errorTag,
            tag: n.errorTag,
            file: n.file,
            line: n.line ?? 1,
          },
        }),
      )
      .with({ _tag: "SchemaDef" }, (n) =>
        JSON.stringify({
          type: "SchemaDef",
          key: n.schemaName,
          properties: {
            qualname: n.schemaName,
            name: n.schemaName,
            file: n.file,
            line: n.line ?? 1,
            isBranded: n.isBranded ?? false,
          },
        }),
      )
      .with({ _tag: "VitestCase" }, (n) =>
        JSON.stringify({
          type: "VitestCase",
          key: n.testId,
          properties: {
            qualname: n.testId,
            name: n.testName,
            file: n.testFile,
            line: n.line ?? 1,
            isPropertyTest: n.isPropertyTest ?? false,
          },
        }),
      )
      .with({ _tag: "PatternDoc" }, (n) =>
        JSON.stringify({
          type: "PatternDoc",
          key: n.slug,
          properties: {
            qualname: n.slug,
            path: n.path,
            title: n.title ?? n.summary,
            coveredSpans: n.coveredSpans ? JSON.stringify(n.coveredSpans) : null,
            coveredTags: n.coveredTags ? JSON.stringify(n.coveredTags) : null,
          },
        }),
      )
      .with({ _tag: "AdrDoc" }, (n) =>
        JSON.stringify({
          type: "AdrDoc",
          key: n.id,
          properties: {
            qualname: n.id,
            id: n.id,
            title: n.title,
            status: n.status,
            date: n.date ?? "2026-11-06",
            path: n.path,
            enforcedByFiles: JSON.stringify(n.enforcedByFiles),
          },
        }),
      )
      .with({ _tag: "EarsSpec" }, (n) =>
        JSON.stringify({
          type: "EarsSpec",
          key: n.id,
          properties: {
            qualname: n.id,
            id: n.id,
            title: n.title,
            status: n.status,
            date: n.date ?? "2026-11-06",
            path: n.path,
            enforcedByFiles: JSON.stringify(n.enforcedByFiles),
            informedByAdrs: n.informedByAdrs ? JSON.stringify(n.informedByAdrs) : null,
          },
        }),
      )
      .with({ _tag: "EffectSignature" }, (n) =>
        JSON.stringify({
          type: "EffectSignature",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            callerQualname: n.callerQualname,
            file: n.file,
            line: n.line,
          },
        }),
      )
      .with({ _tag: "LayerFlow" }, (n) =>
        JSON.stringify({
          type: "LayerFlow",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            layerQualname: n.layerQualname,
            file: n.file,
            line: n.line,
          },
        }),
      )
      .with({ _tag: "TraceabilityTuple" }, (n) =>
        JSON.stringify({
          type: "TraceabilityTuple",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            adrId: n.adrId ?? null,
            earsSpecId: n.earsSpecId ?? null,
            requirementId: n.requirementId ?? null,
            earsPattern: n.earsPattern ?? null,
            targetSymbolQualname: n.targetSymbolQualname,
          },
        }),
      )
      .with({ _tag: "HttpEndpointTuple" }, (n) =>
        JSON.stringify({
          type: "HttpEndpointTuple",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            endpointGroup: n.endpointGroup,
            endpointName: n.endpointName,
            method: n.method,
            path: n.path,
            handlerQualname: n.handlerQualname ?? null,
            file: n.file,
            line: n.line,
          },
        }),
      )
      .with({ _tag: "MigrationTuple" }, (n) =>
        JSON.stringify({
          type: "MigrationTuple",
          key: n.relationId,
          properties: {
            qualname: n.relationId,
            relationId: n.relationId,
            migrationId: n.migrationId,
            engine: n.engine,
            moduleFile: n.moduleFile,
            isDestructive: n.isDestructive,
            line: n.line,
          },
        }),
      )
      .exhaustive()

    lines.push(line)
  }

  for (const [, edge] of Graph.edges(harnessGraph.graph)) {
    const sourceNodeOpt = Graph.getNode(harnessGraph.graph, edge.source)
    const targetNodeOpt = Graph.getNode(harnessGraph.graph, edge.target)
    if (Option.isNone(sourceNodeOpt) || Option.isNone(targetNodeOpt)) continue

    const edgeName = mapPlaysRoleToOmnigraphEdgeName(
      sourceNodeOpt.value._tag,
      targetNodeOpt.value._tag,
      edge.data.role,
    )
    if (!edgeName) {
      // oxlint-disable-next-line -- synchronous boundary
      throw new Error(
        `Unmappable role '${edge.data.role}' from ${sourceNodeOpt.value._tag} to ${targetNodeOpt.value._tag} in toOmnigraphNdjson`,
      )
    }

    lines.push(
      JSON.stringify({
        edge: edgeName,
        from: getOmnigraphVertexQualname(sourceNodeOpt.value),
        to: getOmnigraphVertexQualname(targetNodeOpt.value),
        properties: {
          role: edge.data.role,
          archimateRelation: edge.data.archimateRelation ?? null,
        },
      }),
    )
  }

  return lines.join("\n")
}

export interface SerializedGraphSnapshot {
  readonly nodes: ReadonlyArray<HarnessNode>
  readonly edges: ReadonlyArray<{
    readonly sourceKey: string
    readonly targetKey: string
    readonly data: HarnessEdge
  }>
}

export const serializeGraphSnapshot = (harnessGraph: HarnessGraph): SerializedGraphSnapshot => {
  const nodes: Array<HarnessNode> = []
  const edges: Array<{ sourceKey: string; targetKey: string; data: HarnessEdge }> = []

  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    nodes.push(node)
  }

  for (const [, edge] of Graph.edges(harnessGraph.graph)) {
    const sourceOpt = Graph.getNode(harnessGraph.graph, edge.source)
    const targetOpt = Graph.getNode(harnessGraph.graph, edge.target)
    if (Option.isSome(sourceOpt) && Option.isSome(targetOpt)) {
      edges.push({
        sourceKey: getNodeKey(sourceOpt.value),
        targetKey: getNodeKey(targetOpt.value),
        data: edge.data,
      })
    }
  }

  return { nodes, edges }
}

const SerializedGraphSnapshotSchema = Schema.Struct({
  nodes: Schema.Array(HarnessNode),
  edges: Schema.Array(
    Schema.Struct({
      sourceKey: Schema.String,
      targetKey: Schema.String,
      data: HarnessEdge,
    }),
  ),
})

export const deserializeGraphSnapshotEffect = Effect.fn("GraphEngine.deserializeSnapshot")(
  function* (snapshot: SerializedGraphSnapshot, snapshotPath = "<in-memory>") {
    const nodeIndexByKey = new Map<string, Graph.NodeIndex>()

    let danglingEdge: (typeof snapshot.edges)[number] | undefined
    const graph = Graph.directed<HarnessNode, HarnessEdge>((mutable) => {
      for (const node of snapshot.nodes) {
        const idx = Graph.addNode(mutable, node)
        nodeIndexByKey.set(getNodeKey(node), idx)
      }

      for (const edge of snapshot.edges) {
        const s = nodeIndexByKey.get(edge.sourceKey)
        const t = nodeIndexByKey.get(edge.targetKey)
        if (s === undefined || t === undefined) {
          danglingEdge ??= edge
          continue
        }
        Graph.addEdge(mutable, s, t, edge.data)
      }
    })

    if (danglingEdge !== undefined) {
      return yield* new GraphSnapshotError({
        path: snapshotPath,
        reason: "dangling-edge",
        message: `Snapshot edge references missing node: sourceKey='${danglingEdge.sourceKey}', targetKey='${danglingEdge.targetKey}' at ${snapshotPath}`,
      })
    }

    const result: HarnessGraph = {
      [HarnessGraphTypeId]: HarnessGraphTypeId,
      graph,
      nodeIndexByKey,
    }
    return result
  },
)

export const deserializeGraphSnapshot = (
  snapshot: SerializedGraphSnapshot,
  snapshotPath = "<in-memory>",
): HarnessGraph => {
  const exit = Effect.runSyncExit(deserializeGraphSnapshotEffect(snapshot, snapshotPath))
  if (Exit.isFailure(exit)) {
    const failureOpt = Cause.findErrorOption(exit.cause)
    if (Option.isSome(failureOpt)) {
      // oxlint-disable-next-line -- synchronous boundary
      throw failureOpt.value
    }
    // oxlint-disable-next-line -- synchronous boundary
    throw Cause.squash(exit.cause)
  }
  return exit.value
}

export const saveGraphSnapshot = (
  harnessGraph: HarnessGraph,
  snapshotPath = path.resolve(process.cwd(), ".harness/graph-snapshot.json"),
): void => {
  const dir = path.dirname(snapshotPath)
  fs.mkdirSync(dir, { recursive: true })
  const serialized = serializeGraphSnapshot(harnessGraph)
  fs.writeFileSync(snapshotPath, JSON.stringify(serialized, null, 2), "utf8")
}

export const loadGraphSnapshotEffect = Effect.fn("GraphEngine.loadSnapshot")(function* (
  snapshotPath = path.resolve(process.cwd(), ".harness/graph-snapshot.json"),
) {
  if (!fs.existsSync(snapshotPath)) {
    return yield* new GraphSnapshotError({
      path: snapshotPath,
      reason: "missing-file",
      message: `Graph snapshot file does not exist at '${snapshotPath}'`,
    })
  }

  const raw = yield* Effect.try({
    try: () => fs.readFileSync(snapshotPath, "utf8"),
    catch: (err) =>
      new GraphSnapshotError({
        path: snapshotPath,
        reason: "invalid-json",
        message: `Failed to read snapshot file at '${snapshotPath}': ${String(err)}`,
      }),
  })

  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(SerializedGraphSnapshotSchema))(
    raw,
  ).pipe(
    Effect.mapError(
      (err) =>
        new GraphSnapshotError({
          path: snapshotPath,
          reason: "invalid-json",
          message: `Snapshot JSON decoding failed at '${snapshotPath}': ${String(err)}`,
        }),
    ),
  )

  return yield* deserializeGraphSnapshotEffect(decoded, snapshotPath)
})

export const loadGraphSnapshot = (
  snapshotPath = path.resolve(process.cwd(), ".harness/graph-snapshot.json"),
): HarnessGraph => {
  const exit = Effect.runSyncExit(loadGraphSnapshotEffect(snapshotPath))
  if (Exit.isFailure(exit)) {
    const failureOpt = Cause.findErrorOption(exit.cause)
    if (Option.isSome(failureOpt)) {
      // oxlint-disable-next-line -- synchronous boundary
      throw failureOpt.value
    }
    // oxlint-disable-next-line -- synchronous boundary
    throw Cause.squash(exit.cause)
  }
  return exit.value
}

export interface GraphDiffResult {
  readonly isGreen: boolean
  readonly missingFns: ReadonlyArray<string>
  readonly missingServices: ReadonlyArray<string>
  readonly missingLayers: ReadonlyArray<string>
  readonly missingErrors: ReadonlyArray<string>
  readonly remainingStubs: ReadonlyArray<string>
  readonly missingEdges: ReadonlyArray<PlaysRoleEdge>
}

export const diffHarnessGraphs = (
  implGraph: HarnessGraph,
  planGraph: HarnessGraph,
): GraphDiffResult => {
  const missingFns: Array<string> = []
  const missingServices: Array<string> = []
  const missingLayers: Array<string> = []
  const missingErrors: Array<string> = []
  const remainingStubs: Array<string> = []
  const missingEdges: Array<PlaysRoleEdge> = []

  const implFnsByFileAndSpan = new Map<string, EffectFnNode>()
  for (const [, node] of Graph.nodes(implGraph.graph)) {
    if (node._tag === "EffectFn") {
      implFnsByFileAndSpan.set(`${node.file}::${node.spanName}`, node)
    }
  }

  const renamedSigMap = new Map<string, string>()

  for (const [, planNode] of Graph.nodes(planGraph.graph)) {
    const key = getNodeKey(planNode)
    const implIdx = implGraph.nodeIndexByKey.get(key)
    let implNode =
      implIdx !== undefined
        ? Option.getOrUndefined(Graph.getNode(implGraph.graph, implIdx))
        : undefined

    if (implNode === undefined && planNode._tag === "EffectFn") {
      const matchedBySpan = implFnsByFileAndSpan.get(`${planNode.file}::${planNode.spanName}`)
      if (matchedBySpan !== undefined) {
        implNode = matchedBySpan
        renamedSigMap.set(
          `EffectSignature:${planNode.qualname}`,
          `EffectSignature:${matchedBySpan.qualname}`,
        )
      }
    }

    if (implNode === undefined) {
      match(planNode)
        .with({ _tag: "EffectFn" }, (n) => missingFns.push(n.qualname))
        .with({ _tag: "ServiceTag" }, (n) => missingServices.push(n.tagId))
        .with({ _tag: "ServiceLayer" }, (n) => missingLayers.push(n.qualname))
        .with({ _tag: "TaggedError" }, (n) => missingErrors.push(n.errorTag))
        .with(
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
          () => {},
        )
        .exhaustive()
    } else if (implNode._tag === "EffectFn" && implNode.isStub === true) {
      remainingStubs.push(implNode.qualname)
    }
  }

  for (const [, implNode] of Graph.nodes(implGraph.graph)) {
    if (
      implNode._tag === "EffectFn" &&
      implNode.isStub === true &&
      !remainingStubs.includes(implNode.qualname)
    ) {
      remainingStubs.push(implNode.qualname)
    }
  }

  const implEdgeKeys = new Set<string>()
  for (const [, edge] of Graph.edges(implGraph.graph)) {
    implEdgeKeys.add(getEdgeKey(edge.data))
  }

  const CHECKED_PLAN_ROLES = new Set([
    "requires-service",
    "fails-with",
    "provided-service",
    "required-service",
    "governing-adr",
    "specifying-ears",
  ])

  for (const [, planEdge] of Graph.edges(planGraph.graph)) {
    if (CHECKED_PLAN_ROLES.has(planEdge.data.role)) {
      const mappedRelId = renamedSigMap.get(planEdge.data.relationId)
      const effectiveEdge =
        mappedRelId !== undefined
          ? { ...planEdge.data, relationId: RelationId.make(mappedRelId) }
          : planEdge.data
      const eKey = getEdgeKey(effectiveEdge)
      if (!implEdgeKeys.has(eKey)) {
        missingEdges.push(planEdge.data)
      }
    }
  }

  const isGreen =
    missingFns.length === 0 &&
    missingServices.length === 0 &&
    missingLayers.length === 0 &&
    missingErrors.length === 0 &&
    remainingStubs.length === 0 &&
    missingEdges.length === 0

  return {
    isGreen,
    missingFns,
    missingServices,
    missingLayers,
    missingErrors,
    remainingStubs,
    missingEdges,
  }
}

export interface SubgraphMonomorphismResult {
  readonly isMonomorphic: boolean
  readonly missingEntities: ReadonlyArray<string>
  readonly missingRelations: ReadonlyArray<string>
  readonly missingRoleEdges: ReadonlyArray<PlaysRoleEdge>
}

/**
 * Verifies Bipartite Levi Subgraph Monomorphism $H \hookrightarrow G_{\text{extracted}}$
 * across entity vertices $V_E$, reified relation vertices $V_R$, and `PlaysRoleEdge` incidences $E_{\text{role}}$.
 */
export const verifySubgraphMonomorphism = (
  extractedGraph: HarnessGraph,
  targetSubgraph: HarnessGraph,
  options?: {
    readonly requiredEntityKeys?: ReadonlySet<string> | undefined
    readonly requiredRelationIds?: ReadonlySet<string> | undefined
    readonly requiredRoleEdges?: ReadonlyArray<PlaysRoleEdge> | undefined
  },
): SubgraphMonomorphismResult => {
  const extractedFnsByFileAndSpan = new Map<string, EffectFnNode>()
  const extractedEntitiesByTail = new Map<string, string>()
  const extractedNodeKeys = new Set<string>()

  for (const [, node] of Graph.nodes(extractedGraph.graph)) {
    const key = getNodeKey(node)
    extractedNodeKeys.add(key)
    match(node)
      .with({ _tag: "EffectFn" }, (fn) => {
        extractedFnsByFileAndSpan.set(`${fn.file}::${fn.spanName}`, fn)
        extractedEntitiesByTail.set(`EffectFn::${fn.spanName}`, key)
        const fnShort = fn.qualname.split("#").pop()
        if (fnShort !== undefined) {
          extractedEntitiesByTail.set(`EffectFn::${fnShort}`, key)
        }
      })
      .with({ _tag: "ServiceTag" }, (svc) => {
        extractedEntitiesByTail.set(`ServiceTag::${svc.tagId}`, key)
        extractedEntitiesByTail.set(`ServiceTag::${svc.name}`, key)
      })
      .with({ _tag: "ServiceLayer" }, (lay) => {
        const layShort = lay.qualname.split("#").pop()
        if (layShort !== undefined) {
          extractedEntitiesByTail.set(`ServiceLayer::${layShort}`, key)
        }
      })
      .with({ _tag: "TaggedError" }, (err) => {
        extractedEntitiesByTail.set(`TaggedError::${err.errorTag}`, key)
      })
      .with({ _tag: "SchemaDef" }, (sch) => {
        extractedEntitiesByTail.set(`SchemaDef::${sch.schemaName}`, key)
      })
      .with({ _tag: "VitestCase" }, (vc) => {
        extractedEntitiesByTail.set(`VitestCase::${vc.testFile}`, key)
      })
      .with(
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        (relOrDoc) => {
          if ("relationId" in relOrDoc) {
            extractedNodeKeys.add(relOrDoc.relationId)
          }
        },
      )
      .exhaustive()
  }

  const missingEntities: Array<string> = []
  const missingRelations: Array<string> = []
  const missingRoleEdges: Array<PlaysRoleEdge> = []
  const entityKeyMap = new Map<string, string>()

  for (const [, targetNode] of Graph.nodes(targetSubgraph.graph)) {
    const key = getNodeKey(targetNode)
    if (isEntityNode(targetNode)) {
      if (options?.requiredEntityKeys !== undefined && !options.requiredEntityKeys.has(key)) {
        continue
      }
      if (extractedNodeKeys.has(key)) {
        entityKeyMap.set(key, key)
        continue
      }
      const mappedKey = match(targetNode)
        .with({ _tag: "EffectFn" }, (fn) => {
          const bySpan = extractedFnsByFileAndSpan.get(`${fn.file}::${fn.spanName}`)
          if (bySpan !== undefined) return getNodeKey(bySpan)
          const fnShort = fn.qualname.split("#").pop() ?? fn.spanName
          return (
            extractedEntitiesByTail.get(`EffectFn::${fn.spanName}`) ??
            extractedEntitiesByTail.get(`EffectFn::${fnShort}`)
          )
        })
        .with(
          { _tag: "ServiceTag" },
          (svc) =>
            extractedEntitiesByTail.get(`ServiceTag::${svc.tagId}`) ??
            extractedEntitiesByTail.get(`ServiceTag::${svc.name}`),
        )
        .with({ _tag: "ServiceLayer" }, (lay) => {
          const layShort = lay.qualname.split("#").pop() ?? lay.qualname
          return extractedEntitiesByTail.get(`ServiceLayer::${layShort}`)
        })
        .with({ _tag: "TaggedError" }, (err) =>
          extractedEntitiesByTail.get(`TaggedError::${err.errorTag}`),
        )
        .with({ _tag: "SchemaDef" }, (sch) =>
          extractedEntitiesByTail.get(`SchemaDef::${sch.schemaName}`),
        )
        .with({ _tag: "VitestCase" }, (vc) =>
          extractedEntitiesByTail.get(`VitestCase::${vc.testFile}`),
        )
        .with({ _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, () => key)
        .exhaustive()

      if (mappedKey !== undefined) {
        entityKeyMap.set(key, mappedKey)
      } else {
        missingEntities.push(key)
      }
    } else {
      const relId = targetNode.relationId
      if (
        options?.requiredRelationIds !== undefined &&
        !options.requiredRelationIds.has(relId) &&
        !options.requiredRelationIds.has(key)
      ) {
        continue
      }
      match(targetNode)
        .with({ _tag: "MigrationTuple" }, (migNode) => {
          const hasMatchingMigration = Array.from(Graph.nodes(extractedGraph.graph)).some(
            ([, n]) => n._tag === "MigrationTuple" && n.migrationId === migNode.migrationId,
          )
          if (!hasMatchingMigration && !extractedNodeKeys.has(relId) && !extractedNodeKeys.has(key)) {
            missingRelations.push(relId)
          }
        })
        .with(
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          () => undefined,
        )
        .exhaustive()
    }
  }

  const extractedRolePairs = new Set<string>()
  for (const [, edge] of Graph.edges(extractedGraph.graph)) {
    extractedRolePairs.add(`${edge.data.role}::${edge.data.entityKey}`)
  }

  const edgesToCheck =
    options?.requiredRoleEdges ??
    Array.from(Graph.edges(targetSubgraph.graph)).map(([, e]) => e.data)

  for (const edgeData of edgesToCheck) {
    if (
      edgeData.role === "specifying-ears" ||
      edgeData.role === "governing-adr" ||
      edgeData.role === "realizing-symbol" ||
      edgeData.role === "verifying-test" ||
      edgeData.role === "exercised-span" ||
      edgeData.role === "exercising-test" ||
      edgeData.role === "input-schema" ||
      edgeData.role === "output-schema" ||
      edgeData.role === "migration-module"
    ) {
      continue
    }
    const mappedEntity = entityKeyMap.get(edgeData.entityKey) ?? edgeData.entityKey
    if (
      !extractedRolePairs.has(`${edgeData.role}::${mappedEntity}`) &&
      !extractedRolePairs.has(`${edgeData.role}::${edgeData.entityKey}`)
    ) {
      missingRoleEdges.push(edgeData)
    }
  }

  return {
    isMonomorphic:
      missingEntities.length === 0 &&
      missingRelations.length === 0 &&
      missingRoleEdges.length === 0,
    missingEntities,
    missingRelations,
    missingRoleEdges,
  }
}
