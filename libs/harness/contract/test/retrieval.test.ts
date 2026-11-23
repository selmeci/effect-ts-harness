import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { match } from "ts-pattern"
import {
  ConflictPairLimit,
  DocHeadingLevel,
  DocLineNumber,
  DocScopeFilter,
  DocTreeInput,
  DocTreePath,
  DocTreePathError,
  EmbeddingBatchTimestamp,
  EmbeddingCacheError,
  EmbeddingCacheSnapshot,
  EmbeddingComponent,
  EmbeddingContentHash,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingNodeKey,
  EmbeddingProviderAvailability,
  EmbeddingProviderError,
  EmbeddingSourceText,
  EmbeddingVectorRecord,
  ErrorReasonMessage,
  KnowledgeQueryText,
  KnowledgeSearchInput,
  KnowledgeSearchLimit,
  KnowledgeSearchResult,
  MAX_EMBEDDING_SOURCE_TEXT_CHARS,
  SimilarityScore,
  WorkspaceFilePath,
} from "../src/index.js"

const expectDecodeFailure = <A>(schema: Schema.Decoder<A>, raw: unknown): void => {
  const opt = Schema.decodeUnknownOption(schema)(raw)
  match(opt)
    .with({ _tag: "None" }, () => {
      expect(opt._tag).toBe("None")
    })
    .with({ _tag: "Some" }, () => {
      expect.unreachable(`Expected decode failure for ${JSON.stringify(raw)}`)
    })
    .exhaustive()
}

describe("Retrieval & PageIndex-lite contracts (ADR-0025 / SPEC-0031)", () => {
  it("validates positive and negative bounds on retrieval scalars", () => {
    const validHash = "0123456789abcdef".repeat(4)
    expect(Schema.decodeSync(EmbeddingContentHash)(validHash)).toBe(validHash)
    expectDecodeFailure(EmbeddingContentHash, "abc")
    expectDecodeFailure(EmbeddingContentHash, "A".repeat(64))

    expect(Schema.decodeSync(EmbeddingDimensionCount)(4096)).toBe(4096)
    expectDecodeFailure(EmbeddingDimensionCount, 0)
    expectDecodeFailure(EmbeddingDimensionCount, -1)
    expectDecodeFailure(EmbeddingDimensionCount, 1.5)

    expect(Schema.decodeSync(KnowledgeSearchLimit)(1)).toBe(1)
    expect(Schema.decodeSync(KnowledgeSearchLimit)(30)).toBe(30)
    expectDecodeFailure(KnowledgeSearchLimit, 0)
    expectDecodeFailure(KnowledgeSearchLimit, 31)
    expectDecodeFailure(KnowledgeSearchLimit, 2.5)

    expect(Schema.decodeSync(ConflictPairLimit)(1)).toBe(1)
    expect(Schema.decodeSync(ConflictPairLimit)(100)).toBe(100)
    expectDecodeFailure(ConflictPairLimit, 0)
    expectDecodeFailure(ConflictPairLimit, 101)

    expect(Schema.decodeSync(DocScopeFilter)("harness")).toBe("harness")
    expectDecodeFailure(DocScopeFilter, "")
    expectDecodeFailure(DocScopeFilter, "  harness")

    expect(Schema.decodeSync(DocHeadingLevel)(1)).toBe(1)
    expect(Schema.decodeSync(DocHeadingLevel)(6)).toBe(6)
    expectDecodeFailure(DocHeadingLevel, 0)
    expectDecodeFailure(DocHeadingLevel, 7)

    expect(Schema.decodeSync(DocLineNumber)(1)).toBe(1)
    expectDecodeFailure(DocLineNumber, 0)
    expectDecodeFailure(DocLineNumber, -4)

    expect(Schema.decodeSync(SimilarityScore)(-1)).toBe(-1)
    expect(Schema.decodeSync(SimilarityScore)(0.84)).toBe(0.84)
    expect(Schema.decodeSync(SimilarityScore)(1)).toBe(1)
    expectDecodeFailure(SimilarityScore, -1.01)
    expectDecodeFailure(SimilarityScore, 1.01)
    expectDecodeFailure(SimilarityScore, Number.NaN)

    expect(
      Schema.decodeSync(EmbeddingSourceText)("x".repeat(MAX_EMBEDDING_SOURCE_TEXT_CHARS)),
    ).toHaveLength(MAX_EMBEDDING_SOURCE_TEXT_CHARS)
    expectDecodeFailure(EmbeddingSourceText, "x".repeat(MAX_EMBEDDING_SOURCE_TEXT_CHARS + 1))
  })

  it("validates KnowledgeSearchInput, KnowledgeSearchResult, EmbeddingProviderAvailability, and DocTreeInput structured contracts", () => {
    const searchOk = Schema.decodeSync(KnowledgeSearchInput)({
      query: "selective embeddings",
      kinds: ["PatternDoc", "AdrDoc", "EarsRequirement"],
      status: "accepted",
      limit: 10,
    })
    expect(searchOk.status).toBe("accepted")
    expect(searchOk.limit).toBe(10)

    expectDecodeFailure(KnowledgeSearchInput, {
      query: "  untrimmed",
    })
    expectDecodeFailure(KnowledgeSearchInput, {
      query: "valid",
      kinds: ["PatternDoc", "AdrDoc", "EarsRequirement", "PatternDoc"],
    })
    expectDecodeFailure(KnowledgeSearchInput, {
      query: "valid",
      limit: 31,
    })
    expectDecodeFailure(KnowledgeQueryText, "x".repeat(4097))

    const treeOk = Schema.decodeSync(DocTreeInput)({
      mode: "catalog",
      scope: "harness",
    })
    expect(treeOk.mode).toBe("catalog")
    expect(Schema.decodeSync(DocTreeInput)({ mode: "tree", path: "README.md" }).mode).toBe("tree")
    expect(
      Schema.decodeSync(DocTreeInput)({
        mode: "section",
        path: "README.md",
        sectionId: "h1-1",
      }).mode,
    ).toBe("section")
    expectDecodeFailure(DocTreeInput, { mode: "unknown" })
    expectDecodeFailure(DocTreeInput, { mode: "tree" })
    expectDecodeFailure(DocTreeInput, { mode: "section", path: "README.md" })

    expect(
      Schema.decodeSync(KnowledgeSearchResult)({
        retrievalMode: "hybrid-rrf",
        degradedReason: null,
        hits: [],
      }).retrievalMode,
    ).toBe("hybrid-rrf")
    expect(
      Schema.decodeSync(KnowledgeSearchResult)({
        retrievalMode: "bm25-only",
        degradedReason: "Ollama offline",
        hits: [],
      }).retrievalMode,
    ).toBe("bm25-only")
    expectDecodeFailure(KnowledgeSearchResult, {
      retrievalMode: "hybrid-rrf",
      degradedReason: "should not be present",
      hits: [],
    })
    expectDecodeFailure(KnowledgeSearchResult, {
      retrievalMode: "bm25-only",
      degradedReason: null,
      hits: [],
    })

    const avail = Schema.decodeSync(EmbeddingProviderAvailability)({ _tag: "Available" })
    expect(avail._tag).toBe("Available")
    const unavail = Schema.decodeSync(EmbeddingProviderAvailability)({
      _tag: "Unavailable",
      cause: "timeout",
      reason: "Timed out probing /api/tags",
    })
    expect(unavail._tag).toBe("Unavailable")
    expectDecodeFailure(EmbeddingProviderAvailability, { _tag: "Unavailable", cause: "other" })
  })

  it("enforces relational dimension and unique nodeKey invariants on cache records and snapshots", () => {
    const validHash = "0123456789abcdef".repeat(4)
    const validRecord = {
      nodeKey: EmbeddingNodeKey.make("PatternDoc:errors"),
      nodeKind: "PatternDoc" as const,
      contentHash: EmbeddingContentHash.make(validHash),
      dimensions: EmbeddingDimensionCount.make(2),
      vector: { components: [EmbeddingComponent.make(1), EmbeddingComponent.make(0)] },
    }
    expect(Schema.decodeSync(EmbeddingVectorRecord)(validRecord).dimensions).toBe(2)
    expectDecodeFailure(EmbeddingVectorRecord, {
      ...validRecord,
      dimensions: 4,
    })

    const validSnapshot = {
      schemaVersion: 1 as const,
      model: EmbeddingModelId.make("qwen3-embedding:8b"),
      dimensions: EmbeddingDimensionCount.make(2),
      updatedAt: EmbeddingBatchTimestamp.make("2026-11-23T00:00:00.000Z"),
      entries: [validRecord],
    }
    expect(Schema.decodeSync(EmbeddingCacheSnapshot)(validSnapshot).entries).toHaveLength(1)
    expectDecodeFailure(EmbeddingCacheSnapshot, {
      ...validSnapshot,
      dimensions: 4,
    })
    expectDecodeFailure(EmbeddingCacheSnapshot, {
      ...validSnapshot,
      entries: [validRecord, validRecord],
    })
  })

  it("formats descriptive Error.message getters on EmbeddingProviderError, EmbeddingCacheError, and DocTreePathError", () => {
    const providerErr = new EmbeddingProviderError({
      model: EmbeddingModelId.make("qwen3-embedding:8b"),
      reason: ErrorReasonMessage.make("Connection refused"),
    })
    expect(providerErr.message).toBe("[qwen3-embedding:8b] Connection refused")

    const cacheErr = new EmbeddingCacheError({
      operation: "read",
      kind: "symlink-refused",
      path: WorkspaceFilePath.make("/repo/.harness/cache/embeddings-v1.json"),
      reason: ErrorReasonMessage.make("Refusing symlink cache file"),
    })
    expect(cacheErr.message).toBe(
      "[read:symlink-refused] /repo/.harness/cache/embeddings-v1.json: Refusing symlink cache file",
    )

    const pathErr = new DocTreePathError({
      requestedPath: DocTreePath.make("../secret.md"),
      reason: ErrorReasonMessage.make("Path escapes repository root boundary"),
    })
    expect(pathErr.message).toBe("[../secret.md] Path escapes repository root boundary")
  })
})
