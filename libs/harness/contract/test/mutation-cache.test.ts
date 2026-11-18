import { Cause, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AstSourceFilePath,
  ContentSha256,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  MutationCacheEntry,
  MutationCacheLookupDecision,
  MutationCacheLookupInput,
  MutationCacheStore,
  MutationCacheTimestamp,
  NonNegativeCount,
  computeContentSha256,
} from "../src/index.js"

describe("MutationCache contract schemas", () => {
  const sampleSha = computeContentSha256("sample-mutant-key")

  it("decodes valid MutationCacheEntry, MutationCacheStore, and MutationCacheLookupDecision", () => {
    const entry = Schema.decodeSync(MutationCacheEntry)({
      key: sampleSha,
      file: "libs/sample/domain/src/logic.ts",
      mutantId: "logic.ts:1:0",
      status: "killed",
      recordedAt: "2026-11-18T16:00:00.000Z",
    })
    expect(entry.key).toBe(sampleSha)
    expect(entry.file).toBe(AstSourceFilePath.make("libs/sample/domain/src/logic.ts"))
    expect(entry.mutantId).toBe(MutantCacheId.make("logic.ts:1:0"))
    expect(entry.status).toBe("killed")
    expect(entry.recordedAt).toBe(MutationCacheTimestamp.make("2026-11-18T16:00:00.000Z"))

    const store = Schema.decodeSync(MutationCacheStore)({
      version: MUTATION_CACHE_SCHEMA_VERSION,
      entries: {
        [sampleSha]: entry,
      },
    })
    expect(store.version).toBe(MUTATION_CACHE_SCHEMA_VERSION)
    expect(store.entries[sampleSha]).toEqual(entry)

    const decision = Schema.decodeSync(MutationCacheLookupDecision)({
      hitKeys: [sampleSha],
      missKeys: [],
      hitCount: 1,
      missCount: 0,
    })
    expect(decision.hitKeys).toEqual([ContentSha256.make(sampleSha)])
    expect(decision.hitCount).toBe(NonNegativeCount.make(1))
    expect(decision.missCount).toBe(NonNegativeCount.make(0))
  })

  it("rejects invalid MutationCacheEntry, MutationCacheStore, MutationCacheLookupInput, and MutationCacheLookupDecision payloads", () => {
    const expectRejected = <A, E>(exit: Exit.Exit<A, E>): void => {
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    }

    const validEntry = {
      key: sampleSha,
      file: "libs/sample/domain/src/logic.ts",
      mutantId: "logic.ts:1:0",
      status: "killed",
      recordedAt: "2026-11-18T16:00:00.000Z",
    }

    // Invalid status & key
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, status: "survived" }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, key: "not-a-sha256" }),
    )
    // Empty branded fields
    expectRejected(Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, file: "" }))
    expectRejected(Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, mutantId: "" }))
    expectRejected(Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, recordedAt: "" }))
    // Non-object / number inputs
    expectRejected(Schema.decodeUnknownExit(MutationCacheEntry)(42))
    expectRejected(Schema.decodeUnknownExit(MutationCacheStore)(null))
    expectRejected(Schema.decodeUnknownExit(MutationCacheStore)(123))

    // Invalid store version & non-64-hex record key (stripped by Schema.Record) & invalid entry value
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheStore)({
        version: "mutation-cache-v99",
        entries: {},
      }),
    )
    const badKeyStoreExit = Schema.decodeUnknownExit(MutationCacheStore)({
      version: MUTATION_CACHE_SCHEMA_VERSION,
      entries: {
        "not-a-64-hex-key": validEntry,
      },
    })
    expect(
      Exit.isFailure(badKeyStoreExit) || Object.keys(badKeyStoreExit.value.entries).length === 0,
    ).toBe(true)
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheStore)({
        version: MUTATION_CACHE_SCHEMA_VERSION,
        entries: {
          [sampleSha]: { ...validEntry, status: "survived" },
        },
      }),
    )

    // Invalid MutationCacheLookupInput
    expectRejected(
      Schema.decodeExit(MutationCacheLookupInput)({
        candidateKeys: ["short-key"],
        store: { version: MUTATION_CACHE_SCHEMA_VERSION, entries: {} },
      }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheLookupInput)({
        candidateKeys: [sampleSha],
        store: { version: "wrong-version", entries: {} },
      }),
    )

    // Invalid MutationCacheLookupDecision
    expectRejected(
      Schema.decodeExit(MutationCacheLookupDecision)({
        hitKeys: [],
        missKeys: [],
        hitCount: -1,
        missCount: 0,
      }),
    )
  })
})
