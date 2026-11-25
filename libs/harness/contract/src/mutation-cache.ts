import { Schema } from "effect"
import {
  AstSourceFilePath,
  ContentSha256,
  TestTimingDurationMs,
} from "./ast-and-gate-primitives.js"
import {
  BatchExitCode,
  ErrorReasonMessage,
  SubprocessOutput,
  SubprocessSignalName,
} from "./workspace-and-process.js"

/** Canonical persistence format version for HMAC-authenticated incremental mutant outcomes. */
export const MUTATION_CACHE_SCHEMA_VERSION = "mutation-cache-v3" as const

/** Relative filename under the active harness cache directory. */
export const MUTATION_CACHE_FILENAME = "mutation-cache-v3.json" as const

export const MutationCacheVersion = Schema.Literal(MUTATION_CACHE_SCHEMA_VERSION)
export type MutationCacheVersion = typeof MutationCacheVersion.Type

export const MutationCacheStatus = Schema.Literal("killed")
export type MutationCacheStatus = typeof MutationCacheStatus.Type

export const MutantCacheId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[^\0\r\n]+$/s)),
  Schema.brand("MutantCacheId"),
)
export type MutantCacheId = typeof MutantCacheId.Type

const ISO_8601_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/**
 * Validated ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:mm:ss(.sss)Z`) parseable to finite epoch millis.
 * Rejects empty or non-UTC timestamps that would silently produce `NaN` in TTL checks.
 */
export const MutationCacheTimestamp = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(ISO_8601_UTC_TIMESTAMP_RE)),
  Schema.check(
    Schema.makeFilter((ts) => Number.isFinite(Date.parse(ts)), {
      message: "MutationCacheTimestamp must be a parseable ISO-8601 UTC timestamp",
    }),
  ),
  Schema.brand("MutationCacheTimestamp"),
)
export type MutationCacheTimestamp = typeof MutationCacheTimestamp.Type

/** Hex-encoded 256-bit HMAC-SHA256 authentication tag binding entry identity to an out-of-workspace key. */
export const MutationCacheMac = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("MutationCacheMac"),
)
export type MutationCacheMac = typeof MutationCacheMac.Type

/** Out-of-workspace HMAC secret key material (>= 32 printable non-empty characters). */
export const MutationCacheHmacSecret = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isBetweenLength(32, 4096)),
  Schema.check(Schema.isPattern(/^[^\0\r\n]+$/)),
  Schema.brand("MutationCacheHmacSecret"),
)
export type MutationCacheHmacSecret = typeof MutationCacheHmacSecret.Type

export const RedactedMutationCacheHmacSecret = Schema.Redacted(MutationCacheHmacSecret)
export type RedactedMutationCacheHmacSecret = typeof RedactedMutationCacheHmacSecret.Type

export const MutationCacheHmacSecretResult = Schema.TaggedUnion({
  Resolved: {
    secret: RedactedMutationCacheHmacSecret,
  },
  Unavailable: {
    reason: ErrorReasonMessage,
  },
})
export type MutationCacheHmacSecretResult = typeof MutationCacheHmacSecretResult.Type

export const MutationCacheAuth = Schema.TaggedUnion({
  Enabled: {
    hmacSecret: RedactedMutationCacheHmacSecret,
  },
  Disabled: {
    reason: ErrorReasonMessage,
  },
})
export type MutationCacheAuth = typeof MutationCacheAuth.Type

export const MutationEpochMillis = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("MutationEpochMillis"),
)
export type MutationEpochMillis = typeof MutationEpochMillis.Type

export const MutationMaxAgeMillis = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("MutationMaxAgeMillis"),
)
export type MutationMaxAgeMillis = typeof MutationMaxAgeMillis.Type

export const PackageRelKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[^\0\r\n:]+$/)),
  Schema.brand("PackageRelKey"),
)
export type PackageRelKey = typeof PackageRelKey.Type

export const RuntimeVersionTag = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[^\0]+$/)),
  Schema.brand("RuntimeVersionTag"),
)
export type RuntimeVersionTag = typeof RuntimeVersionTag.Type

export const MutationCacheEntry = Schema.Struct({
  key: ContentSha256,
  file: AstSourceFilePath,
  mutantId: MutantCacheId,
  status: MutationCacheStatus,
  /** Immutable creation/verification timestamp enforced by the cache TTL window. */
  recordedAt: MutationCacheTimestamp,
  /** Mutable access timestamp updated on cache hit so LRU eviction preserves hot entries without extending TTL. */
  lastAccessedAt: Schema.optional(MutationCacheTimestamp),
  witnessTestFile: AstSourceFilePath,
  witnessClosureSha256: ContentSha256,
  mac: MutationCacheMac,
})
export type MutationCacheEntry = typeof MutationCacheEntry.Type

export const MutationCacheStore = Schema.Struct({
  version: MutationCacheVersion,
  entries: Schema.Record(ContentSha256, MutationCacheEntry),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (store) =>
        Object.entries(store.entries).every(([recordKey, entry]) => entry.key === recordKey),
      {
        message: "MutationCacheStore entries must key every entry by entry.key",
      },
    ),
  ),
)
export type MutationCacheStore = typeof MutationCacheStore.Type

export const MutationCacheLookupInput = Schema.Struct({
  candidateKeys: Schema.Array(ContentSha256),
  store: MutationCacheStore,
  auth: MutationCacheAuth,
  nowMs: MutationEpochMillis,
  maxAgeMs: Schema.optional(MutationMaxAgeMillis),
  reachingTests: Schema.Array(AstSourceFilePath),
  witnessClosureDigests: Schema.Record(AstSourceFilePath, ContentSha256),
})
export type MutationCacheLookupInput = typeof MutationCacheLookupInput.Type

export const MutationCacheLookupDecision = Schema.Struct({
  hitKeys: Schema.Array(ContentSha256),
  missKeys: Schema.Array(ContentSha256),
})
export type MutationCacheLookupDecision = typeof MutationCacheLookupDecision.Type

export const BatchMutantOutcomeResult = Schema.TaggedUnion({
  Exited: {
    exitCode: BatchExitCode,
    stdout: SubprocessOutput,
    stderr: SubprocessOutput,
    killingTestFile: Schema.optional(AstSourceFilePath),
  },
  TimedOut: {
    stdout: SubprocessOutput,
    stderr: SubprocessOutput,
  },
  Signaled: {
    signal: SubprocessSignalName,
    stdout: SubprocessOutput,
    stderr: SubprocessOutput,
  },
  SpawnFailed: {
    spawnError: ErrorReasonMessage,
    stdout: SubprocessOutput,
    stderr: SubprocessOutput,
  },
})
export type BatchMutantOutcomeResult = typeof BatchMutantOutcomeResult.Type

export const BatchMutantResultEntry = Schema.Struct({
  id: MutantCacheId,
  result: BatchMutantOutcomeResult,
})
export type BatchMutantResultEntry = typeof BatchMutantResultEntry.Type

export const BatchMutantResultsSchema = Schema.fromJsonString(Schema.Array(BatchMutantResultEntry))

export const PackageBatchFileOutputSchema = Schema.Struct({
  schemaVersion: Schema.optional(Schema.Literal(1)),
  relFile: AstSourceFilePath,
  primaryResults: Schema.Array(BatchMutantResultEntry),
  scopedFallbackResults: Schema.Array(BatchMutantResultEntry),
  packageFallbackResults: Schema.Array(BatchMutantResultEntry),
  observedTestDurationsMs: Schema.optional(Schema.Record(AstSourceFilePath, TestTimingDurationMs)),
  restoreError: Schema.optional(ErrorReasonMessage),
})
export type PackageBatchFileOutput = typeof PackageBatchFileOutputSchema.Type
