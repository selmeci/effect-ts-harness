import { Schema } from "effect"
import { NonNegativeCount } from "./ast-and-gate-primitives.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

const TrimmedRetrievalString = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(4096)),
)

export const EMBEDDING_CACHE_SCHEMA_VERSION = 1 as const
export const DEFAULT_QWEN_EMBEDDING_MODEL = "qwen3-embedding:8b" as const
export const DEFAULT_QWEN_EMBEDDING_DIMENSIONS = 4096 as const

export const EmbeddingModelId = TrimmedRetrievalString.pipe(Schema.brand("EmbeddingModelId"))
export type EmbeddingModelId = typeof EmbeddingModelId.Type

export const EmbeddingContentHash = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("EmbeddingContentHash"),
)
export type EmbeddingContentHash = typeof EmbeddingContentHash.Type

export const EmbeddingDimensionCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("EmbeddingDimensionCount"),
)
export type EmbeddingDimensionCount = typeof EmbeddingDimensionCount.Type

export const EmbeddingComponent = Schema.Finite.pipe(Schema.brand("EmbeddingComponent"))
export type EmbeddingComponent = typeof EmbeddingComponent.Type

export const EmbeddingVector = Schema.Struct({
  components: Schema.Array(EmbeddingComponent),
})
export type EmbeddingVector = typeof EmbeddingVector.Type

export const EmbeddingNodeKey = TrimmedRetrievalString.pipe(Schema.brand("EmbeddingNodeKey"))
export type EmbeddingNodeKey = typeof EmbeddingNodeKey.Type

export const EmbeddingNodeKind = Schema.Literals(["PatternDoc", "AdrDoc", "EarsRequirement"])
export type EmbeddingNodeKind = typeof EmbeddingNodeKind.Type

export const EmbeddingProviderAvailability = Schema.Literals(["available", "unavailable"])
export type EmbeddingProviderAvailability = typeof EmbeddingProviderAvailability.Type

export const EmbeddingProviderBaseUrl = TrimmedRetrievalString.pipe(
  Schema.brand("EmbeddingProviderBaseUrl"),
)
export type EmbeddingProviderBaseUrl = typeof EmbeddingProviderBaseUrl.Type

export const EmbeddingSourceText = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("EmbeddingSourceText"),
)
export type EmbeddingSourceText = typeof EmbeddingSourceText.Type

export const KnowledgeQueryText = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(4096)),
  Schema.brand("KnowledgeQueryText"),
)
export type KnowledgeQueryText = typeof KnowledgeQueryText.Type

export const KnowledgeSearchLimit = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
  Schema.brand("KnowledgeSearchLimit"),
)
export type KnowledgeSearchLimit = typeof KnowledgeSearchLimit.Type

export const ConflictPairLimit = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  Schema.brand("ConflictPairLimit"),
)
export type ConflictPairLimit = typeof ConflictPairLimit.Type

export const DocScopeFilter = TrimmedRetrievalString.pipe(Schema.brand("DocScopeFilter"))
export type DocScopeFilter = typeof DocScopeFilter.Type

export const DocTreePath = TrimmedRetrievalString.pipe(Schema.brand("DocTreePath"))
export type DocTreePath = typeof DocTreePath.Type

export const DocSectionId = TrimmedRetrievalString.pipe(Schema.brand("DocSectionId"))
export type DocSectionId = typeof DocSectionId.Type

export const DocHeadingTitle = TrimmedRetrievalString.pipe(Schema.brand("DocHeadingTitle"))
export type DocHeadingTitle = typeof DocHeadingTitle.Type

export const DocHeadingLevel = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
  Schema.brand("DocHeadingLevel"),
)
export type DocHeadingLevel = typeof DocHeadingLevel.Type

export const DocLineNumber = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("DocLineNumber"),
)
export type DocLineNumber = typeof DocLineNumber.Type

export const DocSummarySnippet = Schema.String.pipe(Schema.brand("DocSummarySnippet"))
export type DocSummarySnippet = typeof DocSummarySnippet.Type

export const DocSectionSliceText = Schema.String.pipe(Schema.brand("DocSectionSliceText"))
export type DocSectionSliceText = typeof DocSectionSliceText.Type

export const GovernanceDocIdentifier = TrimmedRetrievalString.pipe(
  Schema.brand("GovernanceDocIdentifier"),
)
export type GovernanceDocIdentifier = typeof GovernanceDocIdentifier.Type

export const GovernanceDocLifecycleStatus = Schema.Literals([
  "accepted",
  "proposed",
  "superseded",
  "deprecated",
])
export type GovernanceDocLifecycleStatus = typeof GovernanceDocLifecycleStatus.Type

export const GovernanceDocKind = Schema.Literals(["AdrDoc", "EarsSpec"])
export type GovernanceDocKind = typeof GovernanceDocKind.Type

export const RequirementId = TrimmedRetrievalString.pipe(Schema.brand("RequirementId"))
export type RequirementId = typeof RequirementId.Type

export const EarsClauseText = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("EarsClauseText"),
)
export type EarsClauseText = typeof EarsClauseText.Type

export const EarsEffectSymbol = Schema.String.pipe(Schema.brand("EarsEffectSymbol"))
export type EarsEffectSymbol = typeof EarsEffectSymbol.Type

export const SimilarityScore = Schema.Finite.pipe(Schema.brand("SimilarityScore"))
export type SimilarityScore = typeof SimilarityScore.Type

export const RetrievalMatchTitle = Schema.String.pipe(Schema.brand("RetrievalMatchTitle"))
export type RetrievalMatchTitle = typeof RetrievalMatchTitle.Type

export const LinkedGraphSymbolKey = TrimmedRetrievalString.pipe(
  Schema.brand("LinkedGraphSymbolKey"),
)
export type LinkedGraphSymbolKey = typeof LinkedGraphSymbolKey.Type

export const EmbeddingBatchTimestamp = TrimmedRetrievalString.pipe(
  Schema.brand("EmbeddingBatchTimestamp"),
)
export type EmbeddingBatchTimestamp = typeof EmbeddingBatchTimestamp.Type

export const EmbeddingProviderConfig = Schema.Struct({
  baseUrl: EmbeddingProviderBaseUrl,
  model: EmbeddingModelId,
  dimensions: EmbeddingDimensionCount,
})
export type EmbeddingProviderConfig = typeof EmbeddingProviderConfig.Type

export const EmbeddingVectorRecord = Schema.Struct({
  nodeKey: EmbeddingNodeKey,
  nodeKind: EmbeddingNodeKind,
  contentHash: EmbeddingContentHash,
  dimensions: EmbeddingDimensionCount,
  vector: EmbeddingVector,
})
export type EmbeddingVectorRecord = typeof EmbeddingVectorRecord.Type

export const EmbeddingCacheSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(EMBEDDING_CACHE_SCHEMA_VERSION),
  model: EmbeddingModelId,
  dimensions: EmbeddingDimensionCount,
  updatedAt: EmbeddingBatchTimestamp,
  entries: Schema.Array(EmbeddingVectorRecord),
})
export type EmbeddingCacheSnapshot = typeof EmbeddingCacheSnapshot.Type

export const EmbeddingSyncCandidateItem = Schema.Struct({
  nodeKey: EmbeddingNodeKey,
  nodeKind: EmbeddingNodeKind,
  contentHash: EmbeddingContentHash,
  sourceText: EmbeddingSourceText,
})
export type EmbeddingSyncCandidateItem = typeof EmbeddingSyncCandidateItem.Type

export const EmbeddingSyncPlanInput = Schema.Struct({
  currentModel: EmbeddingModelId,
  currentDimensions: EmbeddingDimensionCount,
  items: Schema.Array(EmbeddingSyncCandidateItem),
  cachedSnapshot: Schema.NullOr(EmbeddingCacheSnapshot),
})
export type EmbeddingSyncPlanInput = typeof EmbeddingSyncPlanInput.Type

export const EmbeddingSyncPlanDecision = Schema.Union([
  Schema.TaggedStruct("CacheHitAll", {
    reusedKeys: Schema.Array(EmbeddingNodeKey),
  }),
  Schema.TaggedStruct("EmbedDelta", {
    embedKeys: Schema.Array(EmbeddingNodeKey),
    reusedKeys: Schema.Array(EmbeddingNodeKey),
    evictedKeys: Schema.Array(EmbeddingNodeKey),
  }),
  Schema.TaggedStruct("ModelMismatchRebuild", {
    reason: ErrorReasonMessage,
    embedKeys: Schema.Array(EmbeddingNodeKey),
    evictedKeys: Schema.Array(EmbeddingNodeKey),
  }),
])
export type EmbeddingSyncPlanDecision = typeof EmbeddingSyncPlanDecision.Type

export const RetrievalMode = Schema.Literals(["hybrid-rrf", "bm25-only", "lexical-fallback"])
export type RetrievalMode = typeof RetrievalMode.Type

export const KnowledgeSearchHit = Schema.Struct({
  nodeKey: EmbeddingNodeKey,
  nodeKind: EmbeddingNodeKind,
  title: RetrievalMatchTitle,
  snippet: DocSummarySnippet,
  path: DocTreePath,
  score: SimilarityScore,
  linkedSymbols: Schema.Array(LinkedGraphSymbolKey),
})
export type KnowledgeSearchHit = typeof KnowledgeSearchHit.Type

export const KnowledgeSearchInput = Schema.Struct({
  query: KnowledgeQueryText,
  kinds: Schema.optional(Schema.Array(EmbeddingNodeKind).pipe(Schema.check(Schema.isMaxLength(3)))),
  status: Schema.optional(GovernanceDocLifecycleStatus),
  limit: Schema.optional(KnowledgeSearchLimit),
})
export type KnowledgeSearchInput = typeof KnowledgeSearchInput.Type

export const KnowledgeSearchResult = Schema.Struct({
  retrievalMode: RetrievalMode,
  degradedReason: Schema.NullOr(ErrorReasonMessage),
  hits: Schema.Array(KnowledgeSearchHit),
})
export type KnowledgeSearchResult = typeof KnowledgeSearchResult.Type

export const DocTreeHeadingNode = Schema.Struct({
  sectionId: DocSectionId,
  level: DocHeadingLevel,
  title: DocHeadingTitle,
  startLine: DocLineNumber,
  endLine: DocLineNumber,
  preview: DocSummarySnippet,
})
export type DocTreeHeadingNode = typeof DocTreeHeadingNode.Type

export const GovernanceCatalogEntry = Schema.Struct({
  id: GovernanceDocIdentifier,
  kind: GovernanceDocKind,
  title: DocHeadingTitle,
  status: GovernanceDocLifecycleStatus,
  path: DocTreePath,
  summary: DocSummarySnippet,
  informedByAdrs: Schema.Array(GovernanceDocIdentifier),
  requirementCount: NonNegativeCount,
  sections: Schema.Array(DocTreeHeadingNode),
})
export type GovernanceCatalogEntry = typeof GovernanceCatalogEntry.Type

export const DocTreeMode = Schema.Literals(["catalog", "tree", "section"])
export type DocTreeMode = typeof DocTreeMode.Type

export const DocTreeInput = Schema.Struct({
  mode: DocTreeMode,
  path: Schema.optional(DocTreePath),
  sectionId: Schema.optional(DocSectionId),
  scope: Schema.optional(DocScopeFilter),
})
export type DocTreeInput = typeof DocTreeInput.Type

export const DocTreeResponse = Schema.Union([
  Schema.TaggedStruct("GovernanceCatalog", {
    totalDocs: NonNegativeCount,
    entries: Schema.Array(GovernanceCatalogEntry),
  }),
  Schema.TaggedStruct("DocumentTree", {
    path: DocTreePath,
    totalLines: NonNegativeCount,
    sections: Schema.Array(DocTreeHeadingNode),
  }),
  Schema.TaggedStruct("SectionContent", {
    path: DocTreePath,
    section: DocTreeHeadingNode,
    content: DocSectionSliceText,
  }),
])
export type DocTreeResponse = typeof DocTreeResponse.Type

export const RequirementEmbeddingItem = Schema.Struct({
  nodeKey: EmbeddingNodeKey,
  specId: GovernanceDocIdentifier,
  requirementId: RequirementId,
  clauseText: EarsClauseText,
  effectSymbol: EarsEffectSymbol,
  vector: EmbeddingVector,
})
export type RequirementEmbeddingItem = typeof RequirementEmbeddingItem.Type

export const SemanticConflictPairerInput = Schema.Struct({
  items: Schema.Array(RequirementEmbeddingItem),
  minSimilarity: SimilarityScore,
  maxPairs: ConflictPairLimit,
})
export type SemanticConflictPairerInput = typeof SemanticConflictPairerInput.Type

export const SemanticConflictCandidate = Schema.Struct({
  sourceNodeKey: EmbeddingNodeKey,
  targetNodeKey: EmbeddingNodeKey,
  sourceId: GovernanceDocIdentifier,
  sourceRequirementId: RequirementId,
  sourceText: EarsClauseText,
  targetId: GovernanceDocIdentifier,
  targetRequirementId: RequirementId,
  targetText: EarsClauseText,
  similarity: SimilarityScore,
})
export type SemanticConflictCandidate = typeof SemanticConflictCandidate.Type

export const SemanticConflictPairerResult = Schema.Struct({
  candidates: Schema.Array(SemanticConflictCandidate),
})
export type SemanticConflictPairerResult = typeof SemanticConflictPairerResult.Type

export class EmbeddingProviderError extends Schema.TaggedError<EmbeddingProviderError>()(
  "EmbeddingProviderError",
  {
    model: EmbeddingModelId,
    reason: ErrorReasonMessage,
  },
) {
  override get message(): string {
    return `[${this.model}] ${this.reason}`
  }
}

export class DocTreePathError extends Schema.TaggedError<DocTreePathError>()("DocTreePathError", {
  requestedPath: DocTreePath,
  reason: ErrorReasonMessage,
}) {
  override get message(): string {
    return `[${this.requestedPath}] ${this.reason}`
  }
}
