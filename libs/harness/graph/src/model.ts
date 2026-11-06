import { Effect, Schema } from "effect"
import type * as Graph from "effect/Graph"
import { match } from "ts-pattern"

/**
 * Clean-Slate Plan Stub helper for `@harness/graph` deciders during `HARNESS_PLAN_CHECK=1`.
 */
export const stub = <A, E = never, R = never>(
  ..._usedArgs: ReadonlyArray<unknown>
): Effect.Effect<A, E, R> => Effect.die("HARNESS_PLAN_STUB")

// ============================================================================
// 1. Branded Domain Scalars (PERA Ontology & Datalog Engine)
// ============================================================================

export const NodeKey = Schema.NonEmptyString.pipe(Schema.brand("NodeKey"))
export type NodeKey = typeof NodeKey.Type

export const RelationId = Schema.NonEmptyString.pipe(Schema.brand("RelationId"))
export type RelationId = typeof RelationId.Type

export const ConceptId = Schema.NonEmptyString.pipe(Schema.brand("ConceptId"))
export type ConceptId = typeof ConceptId.Type

export const RoleName = Schema.NonEmptyString.pipe(Schema.brand("RoleName"))
export type RoleName = typeof RoleName.Type

export const DatalogRuleId = Schema.NonEmptyString.pipe(Schema.brand("DatalogRuleId"))
export type DatalogRuleId = typeof DatalogRuleId.Type

export const ProofId = Schema.NonEmptyString.pipe(Schema.brand("ProofId"))
export type ProofId = typeof ProofId.Type

export const ConfidenceMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  Schema.brand("ConfidenceMillis"),
)
export type ConfidenceMillis = typeof ConfidenceMillis.Type

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

export const StandardRoleName = Schema.Literals([
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
])
export type StandardRoleName = typeof StandardRoleName.Type

export const PlaysRoleEdge = Schema.TaggedStruct("PlaysRole", {
  relationId: RelationId,
  entityKey: NodeKey,
  role: RoleName,
  archimateRelation: Schema.optional(Schema.String),
  callCount: Schema.optional(Schema.Int),
  receiverLayer: Schema.optional(Schema.NullOr(Schema.String)),
})
export type PlaysRoleEdge = typeof PlaysRoleEdge.Type

export const HarnessEdge = PlaysRoleEdge
export type HarnessEdge = typeof HarnessEdge.Type

// ============================================================================
// 5. Concept Lattice Contracts (ConceptLattice.decide)
// ============================================================================

export const ConceptKind = Schema.Literals(["entity", "relation"])
export type ConceptKind = typeof ConceptKind.Type

export const RoleSpec = Schema.Struct({
  role: RoleName,
  minCard: Schema.Int,
  maxCard: Schema.NullOr(Schema.Int),
  allowedPlayers: Schema.Array(ConceptId),
  archimateRelation: Schema.optional(Schema.String),
})
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

export class ConceptLatticeCycleError extends Schema.TaggedError<ConceptLatticeCycleError>()(
  "ConceptLatticeCycleError",
  {
    cycle: Schema.Array(ConceptId),
    message: Schema.String,
  },
) {}

// ============================================================================
// 6. Stratified Datalog & Edge Completion Contracts (GraphInfer.decide)
// ============================================================================

export const StratumIndex = Schema.Literals([0, 1, 2, 3])
export type StratumIndex = typeof StratumIndex.Type

export const ProofHeight = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("ProofHeight"),
)
export type ProofHeight = typeof ProofHeight.Type

export const MinHeightProvenanceAnnotation = Schema.Struct({
  proofHeight: ProofHeight,
  ruleId: DatalogRuleId,
  witnessRelationId: Schema.optional(RelationId),
  viaIntermediateKey: Schema.optional(Schema.NullOr(NodeKey)),
})
export type MinHeightProvenanceAnnotation = typeof MinHeightProvenanceAnnotation.Type

export const DatalogRule = Schema.Struct({
  id: DatalogRuleId,
  stratum: StratumIndex,
  headPredicate: Schema.String,
  description: Schema.String,
  hasNegation: Schema.Boolean,
  isRecursive: Schema.Boolean,
})
export type DatalogRule = typeof DatalogRule.Type

export const DerivationProof = Schema.Struct({
  proofId: ProofId,
  ruleId: DatalogRuleId,
  stratum: StratumIndex,
  proofHeight: Schema.optional(ProofHeight),
  conclusion: Schema.String,
  premises: Schema.Array(Schema.String),
  witnessPath: Schema.optional(Schema.Array(Schema.String)),
  explanation: Schema.optional(Schema.String),
  parentProofIds: Schema.Array(ProofId),
})
export type DerivationProof = typeof DerivationProof.Type

export const AntiPatternRuleId = Schema.Literals([
  "domain-requires-infra",
  "domain-requires-cloud-binding",
  "impure-decider",
  "impure-reducer",
  "layer-cycle",
  "missing-layer-provider",
  "unmapped-spec-symbol",
  "aggregate-direct-bus-publish",
  "untested-domain-span",
  "unverified-migration",
])
export type AntiPatternRuleId = typeof AntiPatternRuleId.Type

export const InferredAntiPattern = Schema.Struct({
  ruleId: AntiPatternRuleId,
  datalogRuleId: DatalogRuleId,
  nodeKey: NodeKey,
  targetKey: Schema.optional(NodeKey),
  path: Schema.Array(Schema.String),
  message: Schema.String,
  proof: DerivationProof,
})
export type InferredAntiPattern = typeof InferredAntiPattern.Type

export const RelationTag = Schema.Literals([
  "EffectSignature",
  "LayerFlow",
  "TraceabilityTuple",
  "HttpEndpointTuple",
  "MigrationTuple",
])
export type RelationTag = typeof RelationTag.Type

export const SuggestedEdge = Schema.Struct({
  ruleId: DatalogRuleId,
  relationTag: RelationTag,
  relationId: RelationId,
  role: RoleName,
  targetEntityKey: NodeKey,
  sourceEntityKey: Schema.optional(NodeKey),
  confidenceMillis: ConfidenceMillis,
  rationale: Schema.String,
  proof: DerivationProof,
})
export type SuggestedEdge = typeof SuggestedEdge.Type

export const PageRankScoreMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  Schema.brand("PageRankScoreMillis"),
)
export type PageRankScoreMillis = typeof PageRankScoreMillis.Type

export const InhabitingSymbolCandidate = Schema.Struct({
  symbolKey: NodeKey,
  inhabitsChannel: Schema.Literals(["A", "E", "R", "decider-delegate"]),
  signatureSummary: Schema.String,
  pprScore: PageRankScoreMillis,
})
export type InhabitingSymbolCandidate = typeof InhabitingSymbolCandidate.Type

export const TypedHoleContextBundle = Schema.Struct({
  holeQualname: Schema.String,
  spanName: Schema.String,
  successTypeSignature: Schema.String,
  allowedErrorConstructors: Schema.Array(Schema.String),
  requiredServiceCapabilities: Schema.Array(Schema.String),
  inhabitingCandidates: Schema.Array(InhabitingSymbolCandidate),
  estimatedTokens: Schema.Int,
})
export type TypedHoleContextBundle = typeof TypedHoleContextBundle.Type

export const SemanticEdgePriors = Schema.Struct({
  edgeConfidenceOverrides: Schema.Record(Schema.String, ConfidenceMillis),
  holeTeleportationWeights: Schema.Record(NodeKey, PageRankScoreMillis),
})
export type SemanticEdgePriors = typeof SemanticEdgePriors.Type

export const ZSetWeight = Schema.Literals([-1, 1])
export type ZSetWeight = typeof ZSetWeight.Type

export const EffectiveServiceRequirement = Schema.Struct({
  callerKey: NodeKey,
  serviceKey: NodeKey,
  isDirect: Schema.Boolean,
  path: Schema.Array(Schema.String),
  proof: DerivationProof,
})
export type EffectiveServiceRequirement = typeof EffectiveServiceRequirement.Type

export const EffectiveErrorPropagation = Schema.Struct({
  callerKey: NodeKey,
  errorKey: NodeKey,
  isDirect: Schema.Boolean,
  path: Schema.Array(Schema.String),
  proof: DerivationProof,
})
export type EffectiveErrorPropagation = typeof EffectiveErrorPropagation.Type

export const EffectiveLayerDependency = Schema.Struct({
  layerKey: NodeKey,
  requiredServiceKey: NodeKey,
  providerLayerKey: Schema.optional(NodeKey),
  isDirect: Schema.Boolean,
  path: Schema.Array(Schema.String),
  proof: DerivationProof,
})
export type EffectiveLayerDependency = typeof EffectiveLayerDependency.Type

export const EffectiveTestReachability = Schema.Struct({
  testKey: NodeKey,
  targetSpanKey: NodeKey,
  isPropertyTest: Schema.Boolean,
  isDirect: Schema.Boolean,
  path: Schema.Array(Schema.String),
  proof: DerivationProof,
})
export type EffectiveTestReachability = typeof EffectiveTestReachability.Type

export const GraphInferenceResult = Schema.Struct({
  effectiveRequires: Schema.Array(EffectiveServiceRequirement),
  effectiveFailsWith: Schema.Array(EffectiveErrorPropagation),
  effectiveLayerDeps: Schema.Array(EffectiveLayerDependency),
  effectiveTestReach: Schema.Array(EffectiveTestReachability),
  antiPatterns: Schema.Array(InferredAntiPattern),
  suggestedEdges: Schema.Array(SuggestedEdge),
  typedHoleBundles: Schema.optional(Schema.Array(TypedHoleContextBundle)),
  iterations: Schema.optional(Schema.Int),
  durationMs: Schema.optional(Schema.Finite),
  proofs: Schema.Array(DerivationProof),
})
export type GraphInferenceResult = typeof GraphInferenceResult.Type

// ============================================================================
// 7. Node Identity & Partition Helpers
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

export const ViolationRule = Schema.Literals([
  "domain-requires-infra",
  "domain-requires-cloud-binding",
  "impure-decider",
  "impure-reducer",
  "layer-cycle",
  "missing-layer-provider",
  "unmapped-spec-symbol",
  "aggregate-direct-bus-publish",
  "untested-domain-span",
  "unverified-migration",
  "discriminant-branching",
  "non-exhaustive-union-match",
  "node-sqlite-in-infra",
  "unsafe-type-cast",
  "unscoped-effect-run",
  "fallback-json-equality",
  "vacuous-error-assertion",
  "schema-boolean-state",
  "unbranded-schema-field",
  "handwritten-tagged-union",
  "untraced-decider",
  "missing-aggregate-id-guard",
  "unbranded-primitive-boundary",
  "unbranded-contract-schema",
  "terminal-state-unhandled",
  "dead-event-payload",
  "unasserted-state-field",
  "unmanaged-sql-ddl",
  "invalid-migrator-record-key",
  "unsafe-sql-migration",
])
export type ViolationRule = typeof ViolationRule.Type

export interface BranchingViolation {
  readonly rule: ViolationRule
  readonly message: string
  readonly file: string
  readonly line: number
  readonly enclosingSymbol: string
  readonly path?: ReadonlyArray<string> | undefined
}

export interface HarnessGraph {
  readonly graph: Graph.DirectedGraph<HarnessNode, HarnessEdge>
  readonly nodeIndexByKey: ReadonlyMap<string, Graph.NodeIndex>
  readonly branchingViolations?: ReadonlyArray<BranchingViolation> | undefined
}

