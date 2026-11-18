import { Cause, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AstSourceFilePath,
  ContentSha256,
  MUTATION_CACHE_FILENAME,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  MutationCacheEntry,
  MutationCacheHmacSecret,
  MutationCacheLookupDecision,
  MutationCacheLookupInput,
  MutationCacheMac,
  MutationCacheStore,
  MutationCacheTimestamp,
  MutationEpochMillis,
  MutationMaxAgeMillis,
  PackageRelKey,
  RuntimeVersionTag,
  computeContentSha256,
} from "../src/index.js"

describe("MutationCache contract schemas", () => {
  const sampleSha = computeContentSha256("sample-mutant-key")
  const otherSha = computeContentSha256("other-mutant-key")
  const sampleMac = MutationCacheMac.make(computeContentSha256("sample-hmac-tag"))
  const sampleSecret = MutationCacheHmacSecret.make("0123456789abcdef0123456789abcdef")

  it("decodes valid MutationCacheEntry, MutationCacheStore, MutationCacheLookupInput, and MutationCacheLookupDecision", () => {
    expect(MUTATION_CACHE_SCHEMA_VERSION).toBe("mutation-cache-v2")
    expect(MUTATION_CACHE_FILENAME).toBe("mutation-cache-v2.json")

    const entry = Schema.decodeSync(MutationCacheEntry)({
      key: sampleSha,
      file: "libs/sample/domain/src/logic.ts",
      mutantId: "logic.ts:1:0",
      status: "killed",
      recordedAt: "2026-11-18T16:00:00.000Z",
      lastAccessedAt: "2026-11-18T16:05:00Z",
      mac: sampleMac,
    })
    expect(entry.key).toBe(sampleSha)
    expect(entry.file).toBe(AstSourceFilePath.make("libs/sample/domain/src/logic.ts"))
    expect(entry.mutantId).toBe(MutantCacheId.make("logic.ts:1:0"))
    expect(entry.status).toBe("killed")
    expect(entry.recordedAt).toBe(MutationCacheTimestamp.make("2026-11-18T16:00:00.000Z"))
    expect(entry.lastAccessedAt).toBe(MutationCacheTimestamp.make("2026-11-18T16:05:00Z"))
    expect(entry.mac).toBe(sampleMac)

    const store = Schema.decodeSync(MutationCacheStore)({
      version: MUTATION_CACHE_SCHEMA_VERSION,
      entries: {
        [sampleSha]: entry,
      },
    })
    expect(store.version).toBe(MUTATION_CACHE_SCHEMA_VERSION)
    expect(store.entries[sampleSha]).toEqual(entry)

    const lookupInput = Schema.decodeSync(MutationCacheLookupInput)({
      candidateKeys: [sampleSha],
      store,
      hmacSecret: sampleSecret,
      nowMs: 1_700_000_000_000,
      maxAgeMs: 43_200_000,
    })
    expect(lookupInput.hmacSecret).toBe(sampleSecret)
    expect(lookupInput.nowMs).toBe(MutationEpochMillis.make(1_700_000_000_000))
    expect(lookupInput.maxAgeMs).toBe(MutationMaxAgeMillis.make(43_200_000))

    const decision = Schema.decodeSync(MutationCacheLookupDecision)({
      hitKeys: [sampleSha],
      missKeys: [],
    })
    expect(decision.hitKeys).toEqual([ContentSha256.make(sampleSha)])
    expect(decision.missKeys).toEqual([])
    expect(PackageRelKey.make("libs/harness/gates")).toBe("libs/harness/gates")
    expect(RuntimeVersionTag.make("node:v22|vitest:5.0.3")).toBe("node:v22|vitest:5.0.3")
  })

  it("rejects invalid timestamps, macs, secrets, key mismatches, and malformed payloads", () => {
    const expectRejected = <A, E>(exit: Exit.Exit<A, E>): void => {
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    }

    const validEntry = {
      key: sampleSha,
      file: "libs/sample/domain/src/logic.ts",
      mutantId: "logic.ts:1:0",
      status: "killed",
      recordedAt: "2026-11-18T16:00:00.000Z",
      mac: sampleMac,
    }

    // Invalid status, key, and mac
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, status: "survived" }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, key: "not-a-sha256" }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, mac: "short-mac" }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({
        key: sampleSha,
        file: validEntry.file,
        mutantId: validEntry.mutantId,
        status: validEntry.status,
        recordedAt: validEntry.recordedAt,
      }),
    )

    // Invalid or empty branded fields & non-ISO-8601 UTC timestamps
    expectRejected(Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, file: "" }))
    expectRejected(Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, mutantId: "" }))
    expectRejected(Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, recordedAt: "" }))
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({
        ...validEntry,
        recordedAt: "not-a-timestamp",
      }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({
        ...validEntry,
        recordedAt: "2026-99-99T00:00:00Z",
      }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({
        ...validEntry,
        recordedAt: "2026-11-18T16:00:00+02:00",
      }),
    )

    // Non-object / number inputs
    expectRejected(Schema.decodeUnknownExit(MutationCacheEntry)(42))
    expectRejected(Schema.decodeUnknownExit(MutationCacheStore)(null))
    expectRejected(Schema.decodeUnknownExit(MutationCacheStore)(123))

    // Invalid store version (including stale v1) & recordKey !== entry.key spoofing
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheStore)({
        version: "mutation-cache-v1",
        entries: {},
      }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheStore)({
        version: MUTATION_CACHE_SCHEMA_VERSION,
        entries: {
          [otherSha]: validEntry,
        },
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

    // Invalid secret, nowMs, maxAgeMs, PackageRelKey, RuntimeVersionTag
    expectRejected(Schema.decodeExit(MutationCacheHmacSecret)("too-short"))
    expectRejected(Schema.decodeExit(MutationCacheHmacSecret)("  padded  "))
    expectRejected(Schema.decodeExit(MutationEpochMillis)(-1))
    expectRejected(Schema.decodeExit(MutationMaxAgeMillis)(0))
    expectRejected(Schema.decodeExit(PackageRelKey)(""))
    expectRejected(Schema.decodeExit(RuntimeVersionTag)(""))

    // Invalid MutationCacheLookupInput & MutationCacheLookupDecision
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
    expectRejected(
      Schema.decodeExit(MutationCacheLookupDecision)({
        hitKeys: ["bad"],
        missKeys: [],
      }),
    )
  })
})
