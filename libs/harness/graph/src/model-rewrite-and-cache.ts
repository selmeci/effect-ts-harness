import { Schema } from "effect"
import { NonNegativeCount } from "@harness/contract"

export { NonNegativeCount }

export const RELATION_TAGS = [
  "EffectSignature",
  "LayerFlow",
  "TraceabilityTuple",
  "HttpEndpointTuple",
  "MigrationTuple",
] as const

export const RelationTag = Schema.Literals(RELATION_TAGS)
export type RelationTag = typeof RelationTag.Type

// ============================================================================
// 1. Branded Scalars (PERA Ontology, Inference & DPO Rewrite)
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

// ============================================================================
// 2. Stratified Datalog & Edge Completion Contracts (GraphInfer.decide)
// ============================================================================

export class GraphInferenceError extends Schema.TaggedError<GraphInferenceError>()(
  "GraphInferenceError",
  { reason: Schema.String, message: Schema.String },
) {}

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

export const ANTI_PATTERN_RULE_IDS = [
  "domain-requires-infra", "domain-requires-cloud-binding", "impure-decider",
  "impure-reducer", "layer-cycle", "missing-layer-provider",
  "unmapped-spec-symbol", "aggregate-direct-bus-publish", "untested-domain-span", "unverified-migration",
] as const

export const AntiPatternRuleId = Schema.Literals(ANTI_PATTERN_RULE_IDS)
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
  proofs: Schema.Array(DerivationProof),
})
export type GraphInferenceResult = typeof GraphInferenceResult.Type

// ============================================================================
// 3. AST Violations & Unresolved References
// ============================================================================

export const AST_VIOLATION_RULE_IDS = [
  "discriminant-branching", "non-exhaustive-union-match", "node-sqlite-in-infra",
  "unsafe-type-cast", "unscoped-effect-run", "fallback-json-equality",
  "vacuous-error-assertion", "schema-boolean-state", "unbranded-schema-field",
  "handwritten-tagged-union", "untraced-decider", "missing-aggregate-id-guard",
  "unbranded-primitive-boundary", "unbranded-contract-schema", "terminal-state-unhandled",
  "dead-event-payload", "unasserted-state-field", "unmanaged-sql-ddl",
  "invalid-migrator-record-key", "unsafe-sql-migration", "unresolved-graph-reference",
  "invalid-graph-role",
] as const

export const ViolationRule = Schema.Literals([...ANTI_PATTERN_RULE_IDS, ...AST_VIOLATION_RULE_IDS])
export type ViolationRule = typeof ViolationRule.Type

export interface BranchingViolation {
  readonly rule: ViolationRule
  readonly message: string
  readonly file: string
  readonly line: number
  readonly enclosingSymbol: string
  readonly path?: ReadonlyArray<string> | undefined
}

export const UnresolvedGraphReference = Schema.Struct({
  relationId: Schema.String,
  role: Schema.String,
  targetKey: Schema.String,
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Int),
})
export type UnresolvedGraphReference = typeof UnresolvedGraphReference.Type

// ============================================================================
// 4. Incremental DBSP Z-Set Session Contracts
// ============================================================================

export const DatalogFilePath = Schema.NonEmptyString.pipe(Schema.brand("DatalogFilePath"))
export type DatalogFilePath = typeof DatalogFilePath.Type

export const DatalogFileDeltaResult = Schema.Struct({
  filePath: DatalogFilePath,
  epoch: NonNegativeCount,
  retractedFactCount: NonNegativeCount,
  insertedFactCount: NonNegativeCount,
  inference: GraphInferenceResult,
})
export type DatalogFileDeltaResult = typeof DatalogFileDeltaResult.Type

// ============================================================================
// 5. Double-Pushout (DPO) Graph Rewriting Contracts
// ============================================================================

export const RewriteRuleId = Schema.NonEmptyString.pipe(Schema.brand("RewriteRuleId"))
export type RewriteRuleId = typeof RewriteRuleId.Type

export const DpoPriorKey = Schema.NonEmptyString.pipe(Schema.brand("DpoPriorKey"))
export type DpoPriorKey = typeof DpoPriorKey.Type

export const formatDpoPriorKey = (
  primaryNodeKey: NodeKey,
  ruleId: RewriteRuleId,
): DpoPriorKey => DpoPriorKey.make(`${primaryNodeKey}::${String(ruleId).replace(/::/g, ":")}`)

export const parseDpoPriorKey = (
  priorKey: DpoPriorKey,
): { readonly primaryNodeKey: NodeKey; readonly ruleId: RewriteRuleId } | undefined => {
  const raw = String(priorKey)
  const sepIdx = raw.lastIndexOf("::")
  if (sepIdx <= 0 || sepIdx + 2 >= raw.length) return undefined
  return {
    primaryNodeKey: NodeKey.make(raw.slice(0, sepIdx)),
    ruleId: RewriteRuleId.make(raw.slice(sepIdx + 2)),
  }
}

export const BOUNDARY_CALLER_PATTERN =
  /\b(?:http|endpoint|rpc|controller|handler|route|worker|relay)\b/i
export const isBoundaryCallerQualname = (text: string): boolean =>
  BOUNDARY_CALLER_PATTERN.test(text)

export const REWRITE_PHASES = ["PLAN", "REPAIR_ARCH", "REPAIR_CODE", "CLEANUP"] as const
export const RewritePhase = Schema.Literals(REWRITE_PHASES)
export type RewritePhase = typeof RewritePhase.Type

export const RewriteMode = Schema.Literals(["auto-plan", "auto-repair", "cleanup", "full"])
export type RewriteMode = typeof RewriteMode.Type

export const RewriteRuleCategory = Schema.Literals(["auto-plan", "auto-repair", "cleanup"])
export type RewriteRuleCategory = typeof RewriteRuleCategory.Type

export const GraphMeasure = Schema.Struct({
  archViolations: NonNegativeCount,
  unmappedSpecSymbols: NonNegativeCount,
  codeHygieneViolations: NonNegativeCount,
  missingLayerProviders: NonNegativeCount,
  untestedDomainSpans: NonNegativeCount,
  unresolvedSuggestedEdges: NonNegativeCount,
})
export type GraphMeasure = typeof GraphMeasure.Type

export const SystemOneScoreMillis = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  Schema.brand("SystemOneScoreMillis"),
)
export type SystemOneScoreMillis = typeof SystemOneScoreMillis.Type

export const DpoCandidatePriors = Schema.Record(DpoPriorKey, SystemOneScoreMillis)
export type DpoCandidatePriors = typeof DpoCandidatePriors.Type

export const CandidateRank = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("CandidateRank"),
)
export type CandidateRank = typeof CandidateRank.Type

export const GraphRewriteErrorReason = Schema.Literals([
  "dangling-edge", "bipartite-relation-deleted", "non-decreasing-measure",
  "step-bound-exceeded", "concept-lattice-cycle", "invalid-graph", "inference-failed",
])
export type GraphRewriteErrorReason = typeof GraphRewriteErrorReason.Type

export class GraphRewriteError extends Schema.TaggedError<GraphRewriteError>()(
  "GraphRewriteError",
  {
    ruleId: Schema.optional(RewriteRuleId),
    nodeKey: Schema.optional(NodeKey),
    reason: GraphRewriteErrorReason,
    message: Schema.String,
  },
) {}

export const DpoRuleSpec = Schema.Struct({
  id: RewriteRuleId,
  phase: RewritePhase,
  category: RewriteRuleCategory,
  description: Schema.String,
  preservesRelationInK: Schema.Boolean,
  hasSpecNac: Schema.Boolean,
})
export type DpoRuleSpec = typeof DpoRuleSpec.Type
