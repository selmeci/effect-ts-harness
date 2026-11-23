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
  EmbeddingContentHash,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingProviderError,
  ErrorReasonMessage,
  KnowledgeQueryText,
  KnowledgeSearchInput,
  KnowledgeSearchLimit,
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
  })

  it("validates KnowledgeSearchInput and DocTreeInput structured contracts", () => {
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
    expect(treeOk.scope).toBe("harness")
    expectDecodeFailure(DocTreeInput, { mode: "unknown" })
  })

  it("formats descriptive Error.message getters on EmbeddingProviderError and DocTreePathError", () => {
    const providerErr = new EmbeddingProviderError({
      model: EmbeddingModelId.make("qwen3-embedding:8b"),
      reason: ErrorReasonMessage.make("Connection refused"),
    })
    expect(providerErr.message).toBe("[qwen3-embedding:8b] Connection refused")

    const pathErr = new DocTreePathError({
      requestedPath: DocTreePath.make("../secret.md"),
      reason: ErrorReasonMessage.make("Path escapes repository root boundary"),
    })
    expect(pathErr.message).toBe("[../secret.md] Path escapes repository root boundary")
  })
})
