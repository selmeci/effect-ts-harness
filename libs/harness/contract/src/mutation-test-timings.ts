import { Schema } from "effect"
import {
  AstSourceFilePath,
  ContentSha256,
  TestTimingDurationMs,
} from "./ast-and-gate-primitives.js"
import { MutationCacheTimestamp, PackageRelKey } from "./mutation-cache.js"

export { TestTimingDurationMs }

/** Canonical persistence format version for non-authoritative adaptive test timing hints. */
export const MUTATION_TEST_TIMINGS_SCHEMA_VERSION = "mutation-test-timings-v1" as const

/** Relative filename under the active harness cache directory. */
export const MUTATION_TEST_TIMINGS_FILENAME = "mutation-test-timings-v1.json" as const

/** Exponential moving average decay factor (`alpha = 0.3`) for adaptive test duration tracking. */
export const MUTATION_TEST_TIMING_EMA_ALPHA = 0.3

/** Measured duration threshold (ms) at or above which a test suite is auto-classified as heavy. */
export const MUTATION_HEAVY_TEST_THRESHOLD_MS = 2000

export const MutationTestTimingsVersion = Schema.Literal(MUTATION_TEST_TIMINGS_SCHEMA_VERSION)
export type MutationTestTimingsVersion = typeof MutationTestTimingsVersion.Type

export const TestTimingSampleCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("TestTimingSampleCount"),
)
export type TestTimingSampleCount = typeof TestTimingSampleCount.Type

export const MutationTestTimingKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[^\0\r\n]+$/s)),
  Schema.brand("MutationTestTimingKey"),
)
export type MutationTestTimingKey = typeof MutationTestTimingKey.Type

export const MutationTestTimingEntry = Schema.Struct({
  pkgKey: PackageRelKey,
  relTestFile: AstSourceFilePath,
  contentSha256: ContentSha256,
  emaDurationMs: TestTimingDurationMs,
  sampleCount: TestTimingSampleCount,
  updatedAt: MutationCacheTimestamp,
})
export type MutationTestTimingEntry = typeof MutationTestTimingEntry.Type

export const MutationTestTimingsStore = Schema.Struct({
  version: MutationTestTimingsVersion,
  entries: Schema.Record(MutationTestTimingKey, MutationTestTimingEntry),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (store) =>
        Object.entries(store.entries).every(
          ([recordKey, entry]) => recordKey === `${entry.pkgKey}::${entry.relTestFile}`,
        ),
      {
        message:
          "MutationTestTimingsStore entries must key every entry by `${entry.pkgKey}::${entry.relTestFile}`",
      },
    ),
  ),
)
export type MutationTestTimingsStore = typeof MutationTestTimingsStore.Type
