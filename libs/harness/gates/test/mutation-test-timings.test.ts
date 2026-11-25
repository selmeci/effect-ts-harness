import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Exit, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  MUTATION_HEAVY_TEST_THRESHOLD_MS,
  MUTATION_TEST_TIMING_EMA_ALPHA,
  MUTATION_TEST_TIMINGS_FILENAME,
  MUTATION_TEST_TIMINGS_SCHEMA_VERSION,
  MutationCacheTimestamp,
  MutationTestTimingKey,
  MutationTestTimingsStore,
  PackageRelKey,
  TestTimingDurationMs,
  TestTimingSampleCount,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { partitionReachingTestFiles } from "../src/mutation/mutation-target-discovery.js"
import {
  buildPackageReachabilityIndexChecked,
  sortTestAbsPathsBySpeed,
} from "../src/mutation/mutation-test-reachability.js"
import {
  buildTimingEntryKey,
  buildVerifiedTestTimingLookup,
  computeNextEmaDurationMs,
  createSuiteTimingsTracker,
  emptyMutationTestTimingsStore,
  isHeavyTestByTimingOrStatic,
  loadMutationTestTimings,
  parseVitestBaselineTestDurations,
  recordObservedTestTimings,
  saveMutationTestTimingsAtomic,
} from "../src/mutation/mutation-test-timings.js"
import { resolveHarnessStateDir } from "../src/worktree.js"
import { isolatedTestHostIo } from "./helpers/test-host-io.js"

const PKG_KEY = PackageRelKey.make("demo/core")

const setupDemoPkg = (prefix = "timings-test-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const pkg = join(dir, "libs", "demo", "core")
  mkdirSync(join(pkg, "src"), { recursive: true })
  mkdirSync(join(pkg, "test"), { recursive: true })
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@demo/core", nx: { tags: ["type:core"] } }),
    "utf8",
  )
  return { dir, pkg }
}

const expectDecodeFails = <A, E>(exit: Exit.Exit<A, E>): void => {
  match(exit)
    .with({ _tag: "Failure" }, ({ cause }) => {
      expect(Cause.hasFails(cause)).toBe(true)
    })
    .with({ _tag: "Success" }, () => {
      expect.unreachable("Expected decode failure")
    })
    .exhaustive()
}

describe("mutation-test-timings contracts & EMA store (REQ-3.1)", () => {
  it("validates MutationTestTimingsStore schema bounds and rejects malformed fields", () => {
    expect(MUTATION_TEST_TIMINGS_SCHEMA_VERSION).toBe("mutation-test-timings-v1")
    expect(MUTATION_TEST_TIMINGS_FILENAME).toBe("mutation-test-timings-v1.json")
    expect(MUTATION_TEST_TIMING_EMA_ALPHA).toBe(0.3)
    expect(MUTATION_HEAVY_TEST_THRESHOLD_MS).toBe(2000)

    const rel = AstSourceFilePath.make("libs/demo/core/test/a.test.ts")
    const key = buildTimingEntryKey(PKG_KEY, rel)
    const valid = Schema.decodeSync(MutationTestTimingsStore)({
      version: MUTATION_TEST_TIMINGS_SCHEMA_VERSION,
      entries: {
        [key]: {
          pkgKey: PKG_KEY,
          relTestFile: rel,
          contentSha256: computeContentSha256("test-a"),
          emaDurationMs: 125.5,
          sampleCount: 3,
          updatedAt: "2026-11-25T10:00:00.000Z",
        },
      },
    })
    expect(valid.entries[key]?.emaDurationMs).toBe(125.5)

    expectDecodeFails(Schema.decodeExit(TestTimingDurationMs)(-1))
    expectDecodeFails(Schema.decodeExit(TestTimingDurationMs)(Number.NaN))
    expectDecodeFails(Schema.decodeExit(TestTimingSampleCount)(0))
    expectDecodeFails(Schema.decodeExit(TestTimingSampleCount)(1.5))
    expectDecodeFails(Schema.decodeExit(MutationTestTimingKey)("bad\nkey"))
    expectDecodeFails(
      Schema.decodeUnknownExit(MutationTestTimingsStore)({ version: "v0", entries: {} }),
    )
    expectDecodeFails(
      Schema.decodeExit(MutationTestTimingsStore)({
        version: MUTATION_TEST_TIMINGS_SCHEMA_VERSION,
        entries: {
          [buildTimingEntryKey(
            PKG_KEY,
            AstSourceFilePath.make("libs/demo/core/test/other.test.ts"),
          )]: {
            pkgKey: PKG_KEY,
            relTestFile: rel,
            contentSha256: computeContentSha256("test-a"),
            emaDurationMs: 50,
            sampleCount: 1,
            updatedAt: "2026-11-25T10:00:00.000Z",
          },
        },
      }),
    )
  })

  it("computes alpha=0.3 EMA updates, resets on hash change, merges newer entries, and caps at 4096", () => {
    expect(computeNextEmaDurationMs(undefined, 100)).toBe(TestTimingDurationMs.make(100))
    expect(computeNextEmaDurationMs(100, 200)).toBe(TestTimingDurationMs.make(130))
    expect(computeNextEmaDurationMs(100, -50)).toBe(TestTimingDurationMs.make(70))

    const { dir, pkg } = setupDemoPkg()
    try {
      const tA = join(pkg, "test", "a.test.ts")
      const tB = join(pkg, "test", "b.test.ts")
      writeFileSync(tA, "export const a = 1\n", "utf8")
      writeFileSync(tB, "export const b = 1\n", "utf8")

      const r1 = recordObservedTestTimings({
        repoRoot: dir,
        pkgKey: PKG_KEY,
        observedByRelOrAbs: new Map([
          ["libs/demo/core/test/a.test.ts", 100],
          [tB, 300],
          ["libs/demo/core/test/missing.test.ts", 50],
          [tA, 100],
        ]),
        store: emptyMutationTestTimingsStore(),
        nowMs: 1_764_000_000_000,
        hostIo: isolatedTestHostIo,
      })
      expect(r1.dirty).toBe(true)
      const keyA = buildTimingEntryKey(
        PKG_KEY,
        AstSourceFilePath.make("libs/demo/core/test/a.test.ts"),
      )
      const keyB = buildTimingEntryKey(
        PKG_KEY,
        AstSourceFilePath.make("libs/demo/core/test/b.test.ts"),
      )
      expect(r1.store.entries[keyA]?.sampleCount).toBe(2)
      expect(r1.store.entries[keyB]?.emaDurationMs).toBe(300)

      const r2 = recordObservedTestTimings({
        repoRoot: dir,
        pkgKey: PKG_KEY,
        observedByRelOrAbs: { "libs/demo/core/test/a.test.ts": 200 },
        store: r1.store,
        nowMs: 1_764_000_001_000,
        hostIo: isolatedTestHostIo,
      })
      expect(r2.store.entries[keyA]?.emaDurationMs).toBe(130)
      expect(r2.store.entries[keyA]?.sampleCount).toBe(3)

      // Modifying test file resets sampleCount to 1 with fresh EMA
      writeFileSync(tA, "export const a = 2\n", "utf8")
      const r3 = recordObservedTestTimings({
        repoRoot: dir,
        pkgKey: PKG_KEY,
        observedByRelOrAbs: { [tA]: 45 },
        store: r2.store,
        nowMs: 1_764_000_002_000,
        hostIo: isolatedTestHostIo,
      })
      expect(r3.store.entries[keyA]?.sampleCount).toBe(1)
      expect(r3.store.entries[keyA]?.emaDurationMs).toBe(45)

      // Save + merge keeps newer on-disk entry and caps at 4096
      expect(saveMutationTestTimingsAtomic(dir, r3.store, isolatedTestHostIo)).toBe(true)
      const staleStore: MutationTestTimingsStore = {
        version: MUTATION_TEST_TIMINGS_SCHEMA_VERSION,
        entries: {
          [keyA]: {
            ...r3.store.entries[keyA]!,
            emaDurationMs: TestTimingDurationMs.make(999),
            updatedAt: MutationCacheTimestamp.make("2020-01-01T00:00:00.000Z"),
          },
        },
      }
      expect(saveMutationTestTimingsAtomic(dir, staleStore, isolatedTestHostIo)).toBe(true)
      const loadedAfterMerge = loadMutationTestTimings(dir, isolatedTestHostIo)
      expect(loadedAfterMerge.entries[keyA]?.emaDurationMs).toBe(45)

      const bulkEntries: Record<MutationTestTimingKey, (typeof r3.store.entries)[typeof keyA]> = {}
      for (let i = 0; i < 4105; i += 1) {
        const rel = AstSourceFilePath.make(`libs/demo/core/test/bulk-${i}.test.ts`)
        bulkEntries[buildTimingEntryKey(PKG_KEY, rel)] = {
          pkgKey: PKG_KEY,
          relTestFile: rel,
          contentSha256: computeContentSha256(`b-${i}`),
          emaDurationMs: TestTimingDurationMs.make(10),
          sampleCount: TestTimingSampleCount.make(1),
          updatedAt: MutationCacheTimestamp.make(
            new Date(1_700_000_000_000 + i * 1000).toISOString(),
          ),
        }
      }
      expect(
        saveMutationTestTimingsAtomic(
          dir,
          { version: MUTATION_TEST_TIMINGS_SCHEMA_VERSION, entries: bulkEntries },
          isolatedTestHostIo,
        ),
      ).toBe(true)
      const capped = loadMutationTestTimings(dir, isolatedTestHostIo)
      expect(Object.keys(capped.entries)).toHaveLength(4096)
      expect(
        capped.entries[
          buildTimingEntryKey(
            PKG_KEY,
            AstSourceFilePath.make("libs/demo/core/test/bulk-4104.test.ts"),
          )
        ],
      ).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads linked worktree common repo timings read-only and persists tracker updates locally", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-timings-"))
    try {
      const mainRepo = join(root, "main-repo")
      const wtRepo = join(mainRepo, ".worktrees", "wt1")
      const wtGitDir = join(mainRepo, ".git", "worktrees", "wt1")
      mkdirSync(join(mainRepo, "libs", "demo", "core", "test"), { recursive: true })
      mkdirSync(wtGitDir, { recursive: true })
      mkdirSync(join(wtRepo, "libs", "demo", "core", "test"), { recursive: true })
      writeFileSync(join(wtGitDir, "commondir"), "../..\n", "utf8")
      writeFileSync(join(wtRepo, ".git"), `gitdir: ${wtGitDir}\n`, "utf8")

      const mainTest = join(mainRepo, "libs", "demo", "core", "test", "a.test.ts")
      const wtTest = join(wtRepo, "libs", "demo", "core", "test", "a.test.ts")
      const wtTestB = join(wtRepo, "libs", "demo", "core", "test", "b.test.ts")
      writeFileSync(mainTest, "export const x = 1\n", "utf8")
      writeFileSync(wtTest, "export const x = 1\n", "utf8")
      writeFileSync(wtTestB, "export const y = 2\n", "utf8")

      const mainRec = recordObservedTestTimings({
        repoRoot: mainRepo,
        pkgKey: PKG_KEY,
        observedByRelOrAbs: { "libs/demo/core/test/a.test.ts": 150 },
        store: emptyMutationTestTimingsStore(),
        nowMs: 1_764_000_000_000,
        hostIo: isolatedTestHostIo,
      })
      expect(saveMutationTestTimingsAtomic(mainRepo, mainRec.store, isolatedTestHostIo)).toBe(true)

      const mainCachePath = join(
        resolveHarnessStateDir(mainRepo, {}),
        "cache",
        MUTATION_TEST_TIMINGS_FILENAME,
      )
      const mainBefore = readFileSync(mainCachePath, "utf8")

      const tracker = createSuiteTimingsTracker(wtRepo, isolatedTestHostIo)
      const lookup1 = tracker.lookupForPackage(PKG_KEY, [wtTest, wtTestB])
      expect(lookup1.get(wtTest)).toBe(150)
      expect(lookup1.has(wtTestB)).toBe(false)

      tracker.recordObserved(PKG_KEY, { [wtTestB]: 220 }, 1_764_000_010_000)
      tracker.flushIfDirty()

      expect(readFileSync(mainCachePath, "utf8")).toBe(mainBefore)
      const wtLoaded = loadMutationTestTimings(wtRepo, isolatedTestHostIo)
      expect(
        wtLoaded.entries[
          buildTimingEntryKey(PKG_KEY, AstSourceFilePath.make("libs/demo/core/test/b.test.ts"))
        ]?.emaDurationMs,
      ).toBe(220)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("mutation-test-timings ordering & Vitest parser (REQ-3.2)", () => {
  it("orders primaryTests and fallbackTests strictly ascending by measured duration and auto-classifies >= 2000ms as heavy", () => {
    expect(isHeavyTestByTimingOrStatic("/repo/libs/a/test/mutation-check.test.ts")).toBe(true)
    expect(
      isHeavyTestByTimingOrStatic(
        "/repo/libs/a/test/mutation-check.test.ts",
        new Map([["/repo/libs/a/test/mutation-check.test.ts", 250]]),
      ),
    ).toBe(false)
    expect(
      isHeavyTestByTimingOrStatic(
        "/repo/libs/a/test/fast.test.ts",
        new Map([["/repo/libs/a/test/fast.test.ts", 2000]]),
      ),
    ).toBe(true)

    const { dir, pkg } = setupDemoPkg("timings-order-")
    try {
      const target = join(pkg, "src", "target.ts")
      const other = join(pkg, "src", "other.ts")
      writeFileSync(target, "export const fn = () => 1\n", "utf8")
      writeFileSync(other, "export const other = () => 2\n", "utf8")
      writeFileSync(
        join(pkg, "src", "index.ts"),
        'export { fn } from "./target.js"\nexport { other } from "./other.js"\n',
        "utf8",
      )

      const tPrimSlow = join(pkg, "test", "prim-slow.test.ts")
      const tPrimFast = join(pkg, "test", "prim-fast.test.ts")
      const tPrimHeavy = join(pkg, "test", "prim-heavy.test.ts")
      const tFbLongFast = join(pkg, "test", "fb-long-fast.test.ts")
      const tFbShortSlow = join(pkg, "test", "fb-short-slow.test.ts")
      const tFbHeavy = join(pkg, "test", "fb-heavy.test.ts")

      writeFileSync(
        tPrimSlow,
        'import { fn } from "../src/target.js"\nexport const a = fn()\n',
        "utf8",
      )
      writeFileSync(
        tPrimFast,
        `import { fn } from "../src/target.js"\n${"// pad\n".repeat(15)}export const b = fn()\n`,
        "utf8",
      )
      writeFileSync(
        tPrimHeavy,
        'import { fn } from "../src/target.js"\nexport const c = fn()\n',
        "utf8",
      )
      writeFileSync(
        tFbLongFast,
        `import { other } from "../src/other.js"\n${"// pad\n".repeat(20)}export const d = other()\n`,
        "utf8",
      )
      writeFileSync(
        tFbShortSlow,
        'import { other } from "../src/other.js"\nexport const e = other()\n',
        "utf8",
      )
      writeFileSync(
        tFbHeavy,
        'import { other } from "../src/other.js"\nexport const f = other()\n',
        "utf8",
      )

      const rec = recordObservedTestTimings({
        repoRoot: dir,
        pkgKey: PKG_KEY,
        observedByRelOrAbs: new Map([
          [tPrimSlow, 400],
          [tPrimFast, 35],
          [tPrimHeavy, 2400],
          [tFbLongFast, 50],
          [tFbShortSlow, 800],
          [tFbHeavy, 2100],
        ]),
        store: emptyMutationTestTimingsStore(),
        nowMs: 1_764_000_000_000,
        hostIo: isolatedTestHostIo,
      })
      const lookup = buildVerifiedTestTimingLookup({
        repoRoot: dir,
        pkgKey: PKG_KEY,
        testAbsPaths: [tPrimSlow, tPrimFast, tPrimHeavy, tFbLongFast, tFbShortSlow, tFbHeavy],
        store: rec.store,
        hostIo: isolatedTestHostIo,
      })

      const part = partitionReachingTestFiles(
        dir,
        {
          scope: "demo",
          pkgDir: "core",
          pkgName: "@demo/core",
          tier: "core",
          fullPath: target,
          relFile: "libs/demo/core/src/target.ts",
        },
        readFileSync(target, "utf8"),
        isolatedTestHostIo,
        undefined,
        lookup,
      )
      expect(part.primaryTests).toEqual([tPrimFast, tPrimSlow, tPrimHeavy])
      expect(part.fallbackTests).toEqual([tFbLongFast, tFbShortSlow, tFbHeavy])

      // Tiebreak uses prioritySet -> lineCount -> compareCodeUnits
      const built = buildPackageReachabilityIndexChecked(
        dir,
        "libs/demo/core",
        "@demo/core",
        [],
        isolatedTestHostIo,
      )
      match(built)
        .with({ _tag: "Error" }, ({ reason }) => expect.unreachable(reason))
        .with({ _tag: "Ok" }, ({ index }) => {
          const tied = sortTestAbsPathsBySpeed(
            [tFbLongFast, tFbShortSlow],
            index,
            new Set([tFbLongFast]),
            new Map([
              [tFbLongFast, 100],
              [tFbShortSlow, 100],
            ]),
          )
          expect(tied).toEqual([tFbLongFast, tFbShortSlow])
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("parses Vitest baseline stdout ms/s durations and limits elapsed fallback to single-file runs", () => {
    const repoRoot = "/repo"
    const testFiles = [
      "/repo/libs/demo/core/test/alpha.test.ts",
      "/repo/libs/demo/core/test/beta.test.ts",
      "/repo/libs/demo/core/test/gamma.test.ts",
    ]
    const stdout = [
      "\u001b[32m ✓ \u001b[39m libs/demo/core/test/alpha.test.ts (12 tests) 142ms",
      " ✔ |core| test/beta.test.ts (3 tests | 1 skipped) 2.34s",
      " ✓ |core| libs/demo/core/test/gamma.test.ts (4 tests) 310ms 128 MB heap used",
    ].join("\n")
    const parsed = parseVitestBaselineTestDurations(stdout, repoRoot, testFiles, 999)
    expect(parsed.get("libs/demo/core/test/alpha.test.ts")).toBe(142)
    expect(parsed.get("libs/demo/core/test/beta.test.ts")).toBe(2340)
    expect(parsed.get("libs/demo/core/test/gamma.test.ts")).toBe(310)

    const multiNoMatch = parseVitestBaselineTestDurations(
      "no summary lines",
      repoRoot,
      testFiles,
      500,
    )
    expect(multiNoMatch.size).toBe(0)

    const singleFallback = parseVitestBaselineTestDurations(
      "no summary lines",
      repoRoot,
      [testFiles[0]!],
      512,
    )
    expect(singleFallback.get("libs/demo/core/test/alpha.test.ts")).toBe(512)
  })
})

describe("mutation-test-timings safety & fallback (REQ-3.3)", () => {
  it("falls back cleanly on missing, symlinked, escaping, oversized, corrupt, schema-invalid, and hash-stale timings", () => {
    const { dir, pkg } = setupDemoPkg("timings-safety-")
    try {
      const target = join(pkg, "src", "calc.ts")
      writeFileSync(target, "export const calc = (n: number) => n + 1\n", "utf8")
      const tShort = join(pkg, "test", "short.test.ts")
      const tLong = join(pkg, "test", "long.test.ts")
      const tMeta = join(pkg, "test", "mutation-check.test.ts")
      writeFileSync(tShort, "export const s = 1\n", "utf8")
      writeFileSync(tLong, `${"// line\n".repeat(12)}export const l = 2\n`, "utf8")
      writeFileSync(tMeta, "export const m = 3\n", "utf8")

      // Missing timings file -> empty store
      expect(loadMutationTestTimings(dir, isolatedTestHostIo)).toEqual(
        emptyMutationTestTimingsStore(),
      )

      const cacheDir = join(resolveHarnessStateDir(dir, {}), "cache")
      mkdirSync(cacheDir, { recursive: true })
      const timingsPath = join(cacheDir, MUTATION_TEST_TIMINGS_FILENAME)

      // Corrupt JSON
      writeFileSync(timingsPath, "{not-json", "utf8")
      expect(loadMutationTestTimings(dir, isolatedTestHostIo)).toEqual(
        emptyMutationTestTimingsStore(),
      )

      // Schema-invalid JSON
      writeFileSync(
        timingsPath,
        JSON.stringify({ version: "mutation-test-timings-v1", entries: { k: { bad: true } } }),
        "utf8",
      )
      expect(loadMutationTestTimings(dir, isolatedTestHostIo)).toEqual(
        emptyMutationTestTimingsStore(),
      )

      // Oversized file (> 8 MiB)
      writeFileSync(timingsPath, " ".repeat(8 * 1024 * 1024 + 64), "utf8")
      expect(loadMutationTestTimings(dir, isolatedTestHostIo)).toEqual(
        emptyMutationTestTimingsStore(),
      )
      rmSync(timingsPath)

      // Symlinked timings file rejected on both load and save without touching target
      const externalTarget = join(dir, "outside.json")
      writeFileSync(
        externalTarget,
        JSON.stringify({ version: MUTATION_TEST_TIMINGS_SCHEMA_VERSION, entries: {} }),
        "utf8",
      )
      symlinkSync(externalTarget, timingsPath)
      expect(loadMutationTestTimings(dir, isolatedTestHostIo)).toEqual(
        emptyMutationTestTimingsStore(),
      )
      expect(
        saveMutationTestTimingsAtomic(dir, emptyMutationTestTimingsStore(), isolatedTestHostIo),
      ).toBe(false)
      rmSync(timingsPath)

      // Symlinked cache dir escaping repoRoot and invalid HARNESS_WORKTREE_ID rejected
      const outsideCache = mkdtempSync(join(tmpdir(), "timings-outside-"))
      try {
        rmSync(cacheDir, { recursive: true, force: true })
        symlinkSync(outsideCache, cacheDir)
        expect(
          saveMutationTestTimingsAtomic(dir, emptyMutationTestTimingsStore(), isolatedTestHostIo),
        ).toBe(false)
        expect(loadMutationTestTimings(dir, isolatedTestHostIo)).toEqual(
          emptyMutationTestTimingsStore(),
        )
      } finally {
        rmSync(outsideCache, { recursive: true, force: true })
      }
      const badWorktreeIo: SyncHostIo = {
        ...isolatedTestHostIo,
        getEnv: () => ({ HARNESS_WORKTREE_ID: ".." }),
      }
      expect(
        saveMutationTestTimingsAtomic(dir, emptyMutationTestTimingsStore(), badWorktreeIo),
      ).toBe(false)

      // Hash-stale timing entry skipped in lookup, falling back to line-count + static HEAVY_META_TEST_BASENAMES
      const rec = recordObservedTestTimings({
        repoRoot: dir,
        pkgKey: PKG_KEY,
        observedByRelOrAbs: new Map([
          [tShort, 900],
          [tLong, 20],
        ]),
        store: emptyMutationTestTimingsStore(),
        nowMs: 1_764_000_000_000,
        hostIo: isolatedTestHostIo,
      })
      writeFileSync(tLong, `${"// modified\n".repeat(12)}export const l = 99\n`, "utf8")
      const lookup = buildVerifiedTestTimingLookup({
        repoRoot: dir,
        pkgKey: PKG_KEY,
        testAbsPaths: [tShort, tLong, tMeta],
        store: rec.store,
        hostIo: isolatedTestHostIo,
      })
      expect(lookup.has(tShort)).toBe(true)
      expect(lookup.has(tLong)).toBe(false)

      const part = partitionReachingTestFiles(
        dir,
        {
          scope: "demo",
          pkgDir: "core",
          pkgName: "@demo/core",
          tier: "core",
          fullPath: target,
          relFile: "libs/demo/core/src/calc.ts",
        },
        readFileSync(target, "utf8"),
        isolatedTestHostIo,
        undefined,
        lookup,
      )
      expect(part.primaryTests).toEqual([tShort, tLong, tMeta])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
