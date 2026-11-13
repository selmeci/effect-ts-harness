import { Schema } from "effect"
import type * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  type BranchingViolation,
  CandidateRank,
  ConceptId,
  GraphMeasure,
  NodeKey,
  RELATION_TAGS,
  RelationId,
  RewriteMode,
  RewritePhase,
  RewriteRuleCategory,
  RewriteRuleId,
  RoleName,
  SystemOneScoreMillis,
  type UnresolvedGraphReference,
} from "./model-rewrite-and-cache.js"

// ============================================================================
// 1. Branded Domain Scalars (PERA Ontology & Datalog Engine)
// ============================================================================

export const PackageTag = Schema.Literals([
  "contract",
  "domain",
  "service",
  "infra",
  "app",
  "unknown",
])
export type PackageTag = typeof PackageTag.Type

export const LayerKind = Schema.Literals(["live", "test", "infra", "emulated"])
export type LayerKind = typeof LayerKind.Type

export const AdrStatus = Schema.Literals(["proposed", "accepted", "superseded", "deprecated"])
export type AdrStatus = typeof AdrStatus.Type

export const EarsStatus = Schema.Literals(["proposed", "accepted", "superseded", "deprecated"])
export type EarsStatus = typeof EarsStatus.Type

export const GovernanceDocStatus = AdrStatus
export type GovernanceDocStatus = typeof GovernanceDocStatus.Type

export const EarsPatternKind = Schema.Literals([
  "Ubiquitous",
  "Event-driven",
  "State-driven",
  "Unwanted behaviour",
  "Where-driven",
  "Complex",
])
export type EarsPatternKind = typeof EarsPatternKind.Type

// ============================================================================
// 2. Entity Nodes (V_E) — Independent Architectural Concepts
// ============================================================================

export const EffectFnNode = Schema.TaggedStruct("EffectFn", {
  qualname: Schema.String,
  spanName: Schema.String,
  packageTag: PackageTag,
  file: Schema.String,
  line: Schema.Int,
  successType: Schema.optional(Schema.String),
  isStub: Schema.optional(Schema.Boolean),
  payloadSchemas: Schema.optional(Schema.Array(Schema.String)),
  inputSchema: Schema.optional(Schema.String),
  outputSchema: Schema.optional(Schema.String),
  caughtErrors: Schema.optional(Schema.Array(Schema.String)),
})
export type EffectFnNode = typeof EffectFnNode.Type

export const ServiceTagNode = Schema.TaggedStruct("ServiceTag", {
  tagId: Schema.String,
  name: Schema.String,
  packageTag: Schema.optional(PackageTag),
  file: Schema.String,
  line: Schema.optional(Schema.Int),
  qualname: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
})
export type ServiceTagNode = typeof ServiceTagNode.Type

export const ServiceLayerNode = Schema.TaggedStruct("ServiceLayer", {
  qualname: Schema.String,
  layerKind: Schema.optional(LayerKind),
  packageTag: Schema.optional(PackageTag),
  file: Schema.String,
  line: Schema.optional(Schema.Int),
})
export type ServiceLayerNode = typeof ServiceLayerNode.Type

export const TaggedErrorNode = Schema.TaggedStruct("TaggedError", {
  errorTag: Schema.String,
  file: Schema.String,
  line: Schema.optional(Schema.Int),
  tag: Schema.optional(Schema.String),
  qualname: Schema.optional(Schema.String),
})
export type TaggedErrorNode = typeof TaggedErrorNode.Type

export const SchemaDefNode = Schema.TaggedStruct("SchemaDef", {
  schemaName: Schema.String,
  packageTag: Schema.optional(PackageTag),
  file: Schema.String,
  line: Schema.optional(Schema.Int),
  isBranded: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  qualname: Schema.optional(Schema.String),
})
export type SchemaDefNode = typeof SchemaDefNode.Type

export const VitestCaseNode = Schema.TaggedStruct("VitestCase", {
  testId: Schema.String,
  testFile: Schema.String,
  testName: Schema.String,
  lastTreeHash: Schema.optional(Schema.String),
  isPropertyTest: Schema.optional(Schema.Boolean),
  hasNonPrimitiveArbitrary: Schema.optional(Schema.Boolean),
  qualname: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Int),
})
export type VitestCaseNode = typeof VitestCaseNode.Type

export const PatternDocNode = Schema.TaggedStruct("PatternDoc", {
  slug: Schema.String,
  path: Schema.String,
  summary: Schema.String,
  patternName: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  coveredSpans: Schema.optional(Schema.Array(Schema.String)),
  coveredTags: Schema.optional(Schema.Array(Schema.String)),
})
export type PatternDocNode = typeof PatternDocNode.Type

export const AdrDocNode = Schema.TaggedStruct("AdrDoc", {
  id: Schema.String,
  title: Schema.String,
  status: AdrStatus,
  date: Schema.optional(Schema.String),
  path: Schema.String,
  enforcedByFiles: Schema.Array(Schema.String),
  governedSymbols: Schema.optional(Schema.Array(Schema.String)),
  referencedSpans: Schema.optional(Schema.Array(Schema.String)),
  referencedServices: Schema.optional(Schema.Array(Schema.String)),
  referencedErrors: Schema.optional(Schema.Array(Schema.String)),
})
export type AdrDocNode = typeof AdrDocNode.Type

export const EarsSpecNode = Schema.TaggedStruct("EarsSpec", {
  id: Schema.String,
  title: Schema.String,
  status: EarsStatus,
  date: Schema.optional(Schema.String),
  path: Schema.String,
  enforcedByFiles: Schema.Array(Schema.String),
  informedByAdrs: Schema.optional(Schema.Array(Schema.String)),
  specifiedSymbols: Schema.optional(Schema.Array(Schema.String)),
  referencedSpans: Schema.optional(Schema.Array(Schema.String)),
  referencedServices: Schema.optional(Schema.Array(Schema.String)),
  referencedErrors: Schema.optional(Schema.Array(Schema.String)),
})
export type EarsSpecNode = typeof EarsSpecNode.Type

export const EntityNode = Schema.Union([
  EffectFnNode,
  ServiceTagNode,
  ServiceLayerNode,
  TaggedErrorNode,
  SchemaDefNode,
  VitestCaseNode,
  PatternDocNode,
  AdrDocNode,
  EarsSpecNode,
])
export type EntityNode = typeof EntityNode.Type

// ============================================================================
// 3. Reified Relation Nodes (V_R) — First-Class k-ary Hyperedges
// ============================================================================

export const EffectSignatureRelation = Schema.TaggedStruct("EffectSignature", {
  relationId: RelationId,
  callerQualname: Schema.String,
  requiredServices: Schema.Array(Schema.String),
  emittedErrors: Schema.Array(Schema.String),
  calleeQualnames: Schema.Array(Schema.String),
  payloadSchemas: Schema.Array(Schema.String),
  file: Schema.String,
  line: Schema.Int,
})
export type EffectSignatureRelation = typeof EffectSignatureRelation.Type

export const LayerFlowRelation = Schema.TaggedStruct("LayerFlow", {
  relationId: RelationId,
  layerQualname: Schema.String,
  providesServices: Schema.Array(Schema.String),
  requiresServices: Schema.Array(Schema.String),
  emittedErrors: Schema.optional(Schema.Array(Schema.String)),
  file: Schema.String,
  line: Schema.Int,
})
export type LayerFlowRelation = typeof LayerFlowRelation.Type

export const TraceabilityTupleRelation = Schema.TaggedStruct("TraceabilityTuple", {
  relationId: RelationId,
  adrId: Schema.optional(Schema.String),
  earsSpecId: Schema.optional(Schema.String),
  requirementId: Schema.optional(Schema.String),
  earsPattern: Schema.optional(EarsPatternKind),
  targetSymbolQualname: Schema.String,
  verifyingTestQualnames: Schema.Array(Schema.String),
  enforcingPatternPaths: Schema.optional(Schema.Array(Schema.String)),
})
export type TraceabilityTupleRelation = typeof TraceabilityTupleRelation.Type

export const HttpMethod = Schema.Literals([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
])
export type HttpMethod = typeof HttpMethod.Type

export const HttpEndpointTupleRelation = Schema.TaggedStruct("HttpEndpointTuple", {
  relationId: RelationId,
  endpointGroup: Schema.String,
  endpointName: Schema.String,
  method: HttpMethod,
  path: Schema.String,
  handlerQualname: Schema.optional(Schema.String),
  requestSchemaQualnames: Schema.Array(Schema.String),
  responseSchemaQualnames: Schema.Array(Schema.String),
  errorTags: Schema.Array(Schema.String),
  file: Schema.String,
  line: Schema.Int,
})
export type HttpEndpointTupleRelation = typeof HttpEndpointTupleRelation.Type

export const MigrationEngineKind = Schema.Literals(["SqliteMigrator", "DrizzleD1"])
export type MigrationEngineKind = typeof MigrationEngineKind.Type

export const MigrationTupleRelation = Schema.TaggedStruct("MigrationTuple", {
  relationId: RelationId,
  migrationId: Schema.String,
  engine: MigrationEngineKind,
  moduleFile: Schema.String,
  isDestructive: Schema.Boolean,
  verifyingTestQualnames: Schema.Array(Schema.String),
  line: Schema.Int,
})
export type MigrationTupleRelation = typeof MigrationTupleRelation.Type

export const RelationNode = Schema.Union([
  EffectSignatureRelation,
  LayerFlowRelation,
  TraceabilityTupleRelation,
  HttpEndpointTupleRelation,
  MigrationTupleRelation,
])
export type RelationNode = typeof RelationNode.Type

export const HarnessNode = Schema.Union([EntityNode, RelationNode])
export type HarnessNode = typeof HarnessNode.Type

// ============================================================================
// 4. Role-Playing Incidence Edges (E_role) — Bipartite Levi Hypergraph
// ============================================================================

export const STANDARD_ROLE_NAMES = [
  "caller",
  "callee",
  "requires-service",
  "fails-with",
  "uses-schema",
  "input-schema",
  "output-schema",
  "provider-layer",
  "provided-service",
  "required-service",
  "governing-adr",
  "specifying-ears",
  "specified-target",
  "realizing-symbol",
  "verifying-test",
  "enforcing-pattern",
  "exercising-test",
  "exercised-span",
  "endpoint-handler",
  "request-schema",
  "response-schema",
  "endpoint-error",
  "migration-module",
] as const

export const StandardRoleName = Schema.Literals(STANDARD_ROLE_NAMES)
export type StandardRoleName = typeof StandardRoleName.Type

export const ARCHIMATE_BY_ROLE: Readonly<Record<StandardRoleName, string>> = {
  caller: "Triggering",
  callee: "Flow",
  "requires-service": "Serving",
  "fails-with": "Access",
  "uses-schema": "Access",
  "input-schema": "Access",
  "output-schema": "Access",
  "provider-layer": "Realization",
  "provided-service": "Realization",
  "required-service": "Serving",
  "governing-adr": "Influence",
  "specifying-ears": "Realization",
  "specified-target": "Realization",
  "realizing-symbol": "Realization",
  "verifying-test": "Assignment",
  "enforcing-pattern": "Influence",
  "exercising-test": "Triggering",
  "exercised-span": "Triggering",
  "endpoint-handler": "Triggering",
  "request-schema": "Access",
  "response-schema": "Access",
  "endpoint-error": "Access",
  "migration-module": "Realization",
}

export const isStandardRoleName = (role: string): role is StandardRoleName =>
  Object.prototype.hasOwnProperty.call(ARCHIMATE_BY_ROLE, role)

export const getArchimateRelationForRole = (role: string): string | undefined =>
  isStandardRoleName(role) ? ARCHIMATE_BY_ROLE[role] : undefined

export const ENTITY_NODE_TAGS = [
  "EffectFn",
  "ServiceTag",
  "ServiceLayer",
  "TaggedError",
  "SchemaDef",
  "VitestCase",
  "PatternDoc",
  "AdrDoc",
  "EarsSpec",
] as const

export const EntityNodeTag = Schema.Literals(ENTITY_NODE_TAGS)
export type EntityNodeTag = typeof EntityNodeTag.Type

export const isBipartitePlaysRoleIds = (relationId: RelationId, entityKey: NodeKey): boolean => {
  if ((relationId as string) === (entityKey as string)) {
    return false
  }
  const hasEntityPrefixInRelation = ENTITY_NODE_TAGS.some((tag) => relationId.startsWith(`${tag}:`))
  if (hasEntityPrefixInRelation) {
    return false
  }
  const hasValidEntityPrefix = ENTITY_NODE_TAGS.some((tag) => entityKey.startsWith(`${tag}:`))
  if (hasValidEntityPrefix) {
    return true
  }
  const hasRelationPrefixInEntity =
    RELATION_TAGS.some((tag) => entityKey.startsWith(`${tag}:`)) ||
    /^(?:sig|layer-flow|trace|http-endpoint|mig):/.test(entityKey)
  if (hasRelationPrefixInEntity) {
    return false
  }
  return true
}

export const PlaysRoleEdge = Schema.TaggedStruct("PlaysRole", {
  relationId: RelationId,
  entityKey: NodeKey,
  role: RoleName,
  archimateRelation: Schema.optional(Schema.String),
  callCount: Schema.optional(Schema.Int),
  receiverLayer: Schema.optional(Schema.NullOr(Schema.String)),
}).pipe(
  Schema.check(
    Schema.makeFilter((edge) => isBipartitePlaysRoleIds(edge.relationId, edge.entityKey), {
      title: "BipartitePlaysRoleInvariant",
      description:
        "PlaysRoleEdge must connect a reified RelationNode (V_R) to an EntityNode (V_E) in G_Levi",
    }),
  ),
)
export type PlaysRoleEdge = typeof PlaysRoleEdge.Type

export const HarnessEdge = PlaysRoleEdge
export type HarnessEdge = typeof HarnessEdge.Type

// ============================================================================
// 5. Concept Lattice Contracts (ConceptLattice.decide)
// ============================================================================

export const ConceptKind = Schema.Literals(["entity", "relation"])
export type ConceptKind = typeof ConceptKind.Type

export const NonNegativeCardInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

export const RoleSpec = Schema.Struct({
  role: RoleName,
  minCard: NonNegativeCardInt,
  maxCard: Schema.NullOr(NonNegativeCardInt),
  allowedPlayers: Schema.Array(ConceptId),
  archimateRelation: Schema.optional(Schema.String),
}).pipe(
  Schema.check(
    Schema.makeFilter((spec) => spec.maxCard === null || spec.minCard <= spec.maxCard, {
      title: "ValidRoleCardinality",
      description:
        "RoleSpec minCard must be less than or equal to maxCard when maxCard is non-null",
    }),
  ),
)
export type RoleSpec = typeof RoleSpec.Type

export const ConceptSpec = Schema.Struct({
  id: ConceptId,
  kind: ConceptKind,
  supertypes: Schema.Array(ConceptId),
  playsRoles: Schema.Array(RoleName),
  relatesRoles: Schema.optional(Schema.Array(RoleSpec)),
})
export type ConceptSpec = typeof ConceptSpec.Type

export const ConceptLatticeConfig = Schema.Struct({
  concepts: Schema.Array(ConceptSpec),
})
export type ConceptLatticeConfig = typeof ConceptLatticeConfig.Type

export const ConceptClosureEntry = Schema.Struct({
  conceptId: ConceptId,
  kind: ConceptKind,
  supertypesClosure: Schema.Array(ConceptId),
  subtypesClosure: Schema.Array(ConceptId),
  inheritedPlayedRoles: Schema.Array(RoleName),
  inheritedRelatedRoles: Schema.Array(RoleSpec),
})
export type ConceptClosureEntry = typeof ConceptClosureEntry.Type

export const ConceptLatticeResult = Schema.Struct({
  entries: Schema.Array(ConceptClosureEntry),
  topologicalOrder: Schema.Array(ConceptId),
})
export type ConceptLatticeResult = typeof ConceptLatticeResult.Type

export const ConceptLatticeErrorReason = Schema.Literals([
  "cycle",
  "dangling-supertype",
  "duplicate-concept-id",
  "invalid-role-refinement",
])
export type ConceptLatticeErrorReason = typeof ConceptLatticeErrorReason.Type

export class ConceptLatticeCycleError extends Schema.TaggedError<ConceptLatticeCycleError>()(
  "ConceptLatticeCycleError",
  {
    cycle: Schema.Array(ConceptId),
    message: Schema.String,
    reason: Schema.optional(ConceptLatticeErrorReason),
  },
) {}

export class GraphSnapshotError extends Schema.TaggedError<GraphSnapshotError>()(
  "GraphSnapshotError",
  {
    path: Schema.String,
    reason: Schema.Literals(["missing-file", "invalid-json", "dangling-edge", "lattice-violation"]),
    message: Schema.String,
  },
) {}

// ============================================================================
// 6. Node Identity & Partition Helpers
// ============================================================================

export const isRelationNode = (node: HarnessNode): node is RelationNode =>
  match(node._tag)
    .with(
      "EffectSignature",
      "LayerFlow",
      "TraceabilityTuple",
      "HttpEndpointTuple",
      "MigrationTuple",
      () => true,
    )
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
      () => false,
    )
    .exhaustive()

export const isEntityNode = (node: HarnessNode): node is EntityNode => !isRelationNode(node)

export const getNodeKey = (node: HarnessNode): NodeKey =>
  match(node)
    .with({ _tag: "EffectFn" }, (n) => NodeKey.make(`EffectFn:${n.qualname}`))
    .with({ _tag: "ServiceTag" }, (n) => NodeKey.make(`ServiceTag:${n.tagId}`))
    .with({ _tag: "ServiceLayer" }, (n) => NodeKey.make(`ServiceLayer:${n.qualname}`))
    .with({ _tag: "TaggedError" }, (n) => NodeKey.make(`TaggedError:${n.errorTag}`))
    .with({ _tag: "SchemaDef" }, (n) => NodeKey.make(`SchemaDef:${n.schemaName}`))
    .with({ _tag: "VitestCase" }, (n) => NodeKey.make(`VitestCase:${n.testId}`))
    .with({ _tag: "PatternDoc" }, (n) => NodeKey.make(`PatternDoc:${n.slug}`))
    .with({ _tag: "AdrDoc" }, (n) => NodeKey.make(`AdrDoc:${n.id}`))
    .with({ _tag: "EarsSpec" }, (n) => NodeKey.make(`EarsSpec:${n.id}`))
    .with(
      { _tag: "EffectSignature" },
      { _tag: "LayerFlow" },
      { _tag: "TraceabilityTuple" },
      { _tag: "HttpEndpointTuple" },
      { _tag: "MigrationTuple" },
      (n) =>
        n.relationId.startsWith(`${n._tag}:`)
          ? NodeKey.make(n.relationId)
          : NodeKey.make(`${n._tag}:${n.relationId}`),
    )
    .exhaustive()

export const getEdgeKey = (edge: HarnessEdge): string =>
  `${edge._tag}:${edge.relationId}->${edge.entityKey}:${edge.role}`

export const HarnessGraphTypeId: unique symbol = Symbol.for("@harness/graph/HarnessGraph")
export type HarnessGraphTypeId = typeof HarnessGraphTypeId

export interface HarnessGraph {
  readonly [HarnessGraphTypeId]?: HarnessGraphTypeId
  readonly graph: Graph.DirectedGraph<HarnessNode, HarnessEdge>
  readonly nodeIndexByKey: ReadonlyMap<string, Graph.NodeIndex>
  readonly branchingViolations?: ReadonlyArray<BranchingViolation> | undefined
  readonly unresolvedReferences?: ReadonlyArray<UnresolvedGraphReference> | undefined
}

export const GraphPatch = Schema.Struct({
  ruleId: RewriteRuleId,
  phase: RewritePhase,
  ruleCategory: RewriteRuleCategory,
  description: Schema.String,
  primaryNodeKey: NodeKey,
  preservedInterfaceKeys: Schema.Array(NodeKey),
  deletedEntityKeys: Schema.Array(NodeKey),
  deletedRelationIds: Schema.Array(RelationId),
  deletedRoleEdges: Schema.Array(Schema.suspend(() => PlaysRoleEdge)),
  insertedEntityNodes: Schema.Array(Schema.suspend(() => EntityNode)),
  insertedRelationNodes: Schema.Array(Schema.suspend(() => RelationNode)),
  insertedRoleEdges: Schema.Array(Schema.suspend(() => PlaysRoleEdge)),
  beforeMeasure: GraphMeasure,
  afterMeasure: GraphMeasure,
})
export type GraphPatch = typeof GraphPatch.Type

export const RewriteCandidate = Schema.Struct({
  rank: CandidateRank,
  rationale: Schema.String,
  patches: Schema.Array(GraphPatch),
  finalMeasure: GraphMeasure,
  systemOneTieBreaker: SystemOneScoreMillis,
  isPolicyClean: Schema.Boolean,
})
export type RewriteCandidate = typeof RewriteCandidate.Type

export const GraphRewriteResult = Schema.Struct({
  mode: RewriteMode,
  initialMeasure: GraphMeasure,
  recommendedCandidate: Schema.OptionFromNullOr(RewriteCandidate),
  alternativeCandidates: Schema.Array(RewriteCandidate),
})
export type GraphRewriteResult = typeof GraphRewriteResult.Type

export interface GraphRewriteOutcome {
  readonly result: GraphRewriteResult
  readonly targetGraph: HarnessGraph
}

export * from "./model-rewrite-and-cache.js"
