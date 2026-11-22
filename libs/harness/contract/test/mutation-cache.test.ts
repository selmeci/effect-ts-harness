import { Cause, Exit, Redacted, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  AstSourceFilePath,
  BatchMutantOutcomeResult,
  BatchMutantResultsSchema,
  ContentSha256,
  ErrorReasonMessage,
  MUTATION_CACHE_FILENAME,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  MutationCacheAuth,
  MutationCacheEntry,
  MutationCacheHmacSecret,
  MutationCacheHmacSecretResult,
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
  const redactedSecret = Redacted.make(sampleSecret)

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
      auth: { _tag: "Enabled", hmacSecret: redactedSecret },
      nowMs: 1_700_000_000_000,
      maxAgeMs: 43_200_000,
    })
    expect(lookupInput.auth._tag).toBe("Enabled")
    match(lookupInput.auth)
      .with({ _tag: "Enabled" }, ({ hmacSecret }) => {
        expect(Redacted.value(hmacSecret)).toBe(sampleSecret)
      })
      .with({ _tag: "Disabled" }, () => {
        expect.unreachable("Expected Enabled auth")
      })
      .exhaustive()
    expect(lookupInput.nowMs).toBe(MutationEpochMillis.make(1_700_000_000_000))
    expect(lookupInput.maxAgeMs).toBe(MutationMaxAgeMillis.make(43_200_000))

    const resolvedRes = Schema.decodeSync(MutationCacheHmacSecretResult)({
      _tag: "Resolved",
      secret: redactedSecret,
    })
    expect(resolvedRes._tag).toBe("Resolved")
    const unavailableRes = Schema.decodeSync(MutationCacheHmacSecretResult)({
      _tag: "Unavailable",
      reason: ErrorReasonMessage.make("key dir symlink"),
    })
    expect(unavailableRes._tag).toBe("Unavailable")
    const disabledAuth = Schema.decodeSync(MutationCacheAuth)({
      _tag: "Disabled",
      reason: ErrorReasonMessage.make("secret dir symlink"),
    })
    expect(disabledAuth._tag).toBe("Disabled")

    const batchDecoded = Schema.decodeSync(BatchMutantResultsSchema)(
      JSON.stringify([
        { id: "m-1", result: { _tag: "Exited", exitCode: 1, stdout: "FAIL", stderr: "" } },
        { id: "m-2", result: { _tag: "Signaled", signal: "SIGTERM", stdout: "", stderr: "" } },
        { id: "m-3", result: { _tag: "TimedOut", stdout: "", stderr: "timed out" } },
        {
          id: "m-4",
          result: { _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" },
        },
      ]),
    )
    expect(batchDecoded).toHaveLength(4)
    for (const outcome of batchDecoded.map((entry) => entry.result)) {
      const roundTripped = Schema.decodeSync(BatchMutantOutcomeResult)(
        Schema.encodeSync(BatchMutantOutcomeResult)(outcome),
      )
      expect(roundTripped._tag).toBe(outcome._tag)
      match(roundTripped)
        .with({ _tag: "Exited" }, (v) => expect(v.exitCode).toBe(1))
        .with({ _tag: "Signaled" }, (v) => expect(v.signal).toBe("SIGTERM"))
        .with({ _tag: "TimedOut" }, (v) => expect(v.stderr).toBe("timed out"))
        .with({ _tag: "SpawnFailed" }, (v) => expect(v.spawnError).toBe("ENOENT"))
        .exhaustive()
    }

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
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, mutantId: "id\0injected" }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheEntry)({ ...validEntry, mutantId: "id\ninjected" }),
    )
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
        auth: { _tag: "Disabled", reason: "no secret" },
        nowMs: 1_700_000_000_000,
      }),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheLookupInput)({
        candidateKeys: [sampleSha],
        store: { version: "wrong-version", entries: {} },
        auth: { _tag: "Disabled", reason: "no secret" },
        nowMs: 1_700_000_000_000,
      }),
    )
    expectRejected(
      Schema.decodeExit(BatchMutantResultsSchema)(
        JSON.stringify([
          { id: "m-1", result: { _tag: "Signaled", signal: "bad signal", stdout: "", stderr: "" } },
        ]),
      ),
    )
    expectRejected(
      Schema.decodeUnknownExit(MutationCacheAuth)({
        _tag: "Enabled",
        hmacSecret: "too-short",
      }),
    )
    expectRejected(
      Schema.decodeExit(MutationCacheAuth)({
        _tag: "Disabled",
        reason: "",
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
