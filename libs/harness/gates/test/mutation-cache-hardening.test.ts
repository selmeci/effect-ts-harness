import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Redacted } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  ContentSha256,
  ErrorReasonMessage,
  MUTATION_CACHE_FILENAME,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  type MutationCacheAuth,
  type MutationCacheEntry,
  MutationCacheHmacSecret,
  MutationCacheStore,
  MutationCacheTimestamp,
  MutationEpochMillis,
  MutationMaxAgeMillis,
  PackageRelKey,
  SourceLineNumber,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { runDomainMutationSuite } from "../src/mutation-check.js"
import { runVitestTargetList } from "../src/mutation-subprocess-helpers.js"
import { collectOrderedFileOutcomes } from "../src/mutation/mutation-suite-helpers.js"
import {
  type CodeMutant,
  MutantId,
  MutantSourceText,
  compileMutantSchemaModule,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import {
  MAX_MUTATION_CACHE_AGE_MS,
  MAX_MUTATION_CACHE_ENTRIES,
  computeFileMutationClosureDigest,
  computeMutantCacheKey,
  computeMutationContextDigestsChecked,
  computeMutationEntryMac,
  loadMutationCache,
  loadMutationCacheWithStatus,
  partitionMutationCacheLookup,
  saveMutationCacheAtomic,
  verifyMutationEntryMac,
} from "../src/mutation/mutation-cache.js"
import {
  flushMutationCache,
  preparePackageBaselines,
  recordKilledMutantsToCache,
} from "../src/mutation/mutation-suite-helpers.js"
import { resolveHarnessStateDir } from "../src/worktree.js"
import { isolatedTestHostIo, testHostIo } from "./helpers/test-host-io.js"

const TEST_HMAC_SECRET = Redacted.make(
  MutationCacheHmacSecret.make("hardening-hmac-secret-0123456789abcdef"),
)
const ALT_HMAC_SECRET = Redacted.make(
  MutationCacheHmacSecret.make("different-hmac-secret-0123456789abcdef"),
)
const TEST_CACHE_AUTH: MutationCacheAuth = {
  _tag: "Enabled",
  hmacSecret: TEST_HMAC_SECRET,
}

const notGit: SyncHostExecResult = {
  _tag: "Exited",
  exitCode: 128,
  stdout: "",
  stderr: "not a git repository",
}

const setupTempRepo = (
  domainSource: string,
  testSource = 'import { expect, it } from "vitest"\nit("ok", () => { expect(1).toBe(1) })\n',
): {
  readonly repoRoot: string
  readonly domainFile: string
  readonly testFile: string
} => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mutation-hardening-"))
  const domainDir = join(repoRoot, "libs", "sample", "domain", "src")
  const testDir = join(repoRoot, "libs", "sample", "domain", "test")
  mkdirSync(domainDir, { recursive: true })
  mkdirSync(testDir, { recursive: true })
  writeFileSync(join(repoRoot, "tsconfig.base.json"), '{"compilerOptions":{}}\n', "utf8")
  const domainFile = join(domainDir, "logic.ts")
  const testFile = join(testDir, "logic.test.ts")
  writeFileSync(domainFile, domainSource, "utf8")
  writeFileSync(testFile, testSource, "utf8")
  return { repoRoot, domainFile, testFile }
}

const DEFAULT_WITNESS_TEST = AstSourceFilePath.make("libs/sample/domain/test/logic.test.ts")
const DEFAULT_WITNESS_CLOSURE = computeContentSha256("sample-witness-closure")

const makeSignedEntry = (
  key: ContentSha256,
  mutantId: string,
  recordedAtStr: string,
  secret = TEST_HMAC_SECRET,
  lastAccessedAtStr?: string,
  witnessTestFile: AstSourceFilePath = DEFAULT_WITNESS_TEST,
  witnessClosureSha256: ContentSha256 = DEFAULT_WITNESS_CLOSURE,
): MutationCacheEntry => {
  const file = AstSourceFilePath.make("libs/sample/domain/src/logic.ts")
  const mId = MutantCacheId.make(mutantId)
  const recordedAt = MutationCacheTimestamp.make(recordedAtStr)
  return {
    key,
    file,
    mutantId: mId,
    status: "killed",
    recordedAt,
    ...(lastAccessedAtStr !== undefined
      ? { lastAccessedAt: MutationCacheTimestamp.make(lastAccessedAtStr) }
      : {}),
    witnessTestFile,
    witnessClosureSha256,
    mac: computeMutationEntryMac(secret, {
      key,
      file,
      mutantId: mId,
      status: "killed",
      recordedAt,
      witnessTestFile,
      witnessClosureSha256,
    }),
  }
}

const makeSampleMutant = (id = "logic.ts:1:0"): CodeMutant => ({
  id: MutantId.make(id),
  file: AstSourceFilePath.make("libs/sample/domain/src/logic.ts"),
  line: SourceLineNumber.make(1),
  category: "boolean-return",
  original: MutantSourceText.make("a === b"),
  replacement: MutantSourceText.make("false"),
  mutatedSource: MutantSourceText.make("export const isSame = (a: number, b: number) => false\n"),
})

describe("MutationCache hardening & regressions", () => {
  it("F-2.1c & F-3.1: HMAC signing/verification, fail-closed without secret, TTL expiry, and lastAccessedAt LRU", () => {
    const k1 = computeContentSha256("k1")
    const k2 = computeContentSha256("k2")
    const recordedAt = "2026-11-18T10:00:00.000Z"
    const entry1 = makeSignedEntry(k1, "m1", recordedAt)
    const entry1WithAccess = makeSignedEntry(
      k1,
      "m1",
      recordedAt,
      TEST_HMAC_SECRET,
      "2026-11-18T15:00:00.000Z",
    )
    expect(entry1WithAccess.mac).toBe(entry1.mac)
    expect(verifyMutationEntryMac(TEST_HMAC_SECRET, entry1WithAccess)).toBe(true)
    expect(verifyMutationEntryMac(ALT_HMAC_SECRET, entry1WithAccess)).toBe(false)

    const tampered = { ...entry1, mutantId: MutantCacheId.make("m-evil") }
    expect(verifyMutationEntryMac(TEST_HMAC_SECRET, tampered)).toBe(false)

    // Length-prefixed MAC prevents delimiter collision when a field contains ':'
    const macA = computeMutationEntryMac(TEST_HMAC_SECRET, {
      key: computeContentSha256("collision"),
      file: AstSourceFilePath.make("a/b"),
      mutantId: MutantCacheId.make("1:c"),
      status: "killed",
      recordedAt: MutationCacheTimestamp.make(recordedAt),
      witnessTestFile: DEFAULT_WITNESS_TEST,
      witnessClosureSha256: DEFAULT_WITNESS_CLOSURE,
    })
    const macB = computeMutationEntryMac(TEST_HMAC_SECRET, {
      key: computeContentSha256("collision"),
      file: AstSourceFilePath.make("a/b:1"),
      mutantId: MutantCacheId.make("c"),
      status: "killed",
      recordedAt: MutationCacheTimestamp.make(recordedAt),
      witnessTestFile: DEFAULT_WITNESS_TEST,
      witnessClosureSha256: DEFAULT_WITNESS_CLOSURE,
    })
    expect(macA).not.toBe(macB)

    const store: MutationCacheStore = {
      version: MUTATION_CACHE_SCHEMA_VERSION,
      entries: { [k1]: entry1WithAccess, [k2]: makeSignedEntry(k2, "m2", recordedAt) },
    }
    const defaultWitnessArgs = {
      reachingTests: [DEFAULT_WITNESS_TEST],
      witnessClosureDigests: { [DEFAULT_WITNESS_TEST]: DEFAULT_WITNESS_CLOSURE },
    }

    // Disabled auth fails closed
    const noSecret = partitionMutationCacheLookup({
      candidateKeys: [k1, k2],
      store,
      auth: { _tag: "Disabled", reason: ErrorReasonMessage.make("no secret") },
      nowMs: MutationEpochMillis.make(Date.parse(recordedAt)),
      ...defaultWitnessArgs,
    })
    expect(noSecret.hitKeys).toEqual([])
    expect(noSecret.missKeys).toEqual([k1, k2])

    // Within 12h TTL & exact boundaries (ageMs === 0 and ageMs === MAX_MUTATION_CACHE_AGE_MS -> hits)
    const exactZeroAge = partitionMutationCacheLookup({
      candidateKeys: [k1, k2],
      store,
      auth: TEST_CACHE_AUTH,
      nowMs: MutationEpochMillis.make(Date.parse(recordedAt)),
      maxAgeMs: MutationMaxAgeMillis.make(MAX_MUTATION_CACHE_AGE_MS),
      ...defaultWitnessArgs,
    })
    expect(exactZeroAge.hitKeys).toEqual([k1, k2])

    const exactTtlBoundary = partitionMutationCacheLookup({
      candidateKeys: [k1, k2],
      store,
      auth: TEST_CACHE_AUTH,
      nowMs: MutationEpochMillis.make(Date.parse(recordedAt) + MAX_MUTATION_CACHE_AGE_MS),
      maxAgeMs: MutationMaxAgeMillis.make(MAX_MUTATION_CACHE_AGE_MS),
      ...defaultWitnessArgs,
    })
    expect(exactTtlBoundary.hitKeys).toEqual([k1, k2])

    // Past 12h TTL (ageMs === maxAgeMs + 1) or negative ageMs -> misses
    const expired = partitionMutationCacheLookup({
      candidateKeys: [k1, k2],
      store,
      auth: TEST_CACHE_AUTH,
      nowMs: MutationEpochMillis.make(Date.parse(recordedAt) + MAX_MUTATION_CACHE_AGE_MS + 1),
      ...defaultWitnessArgs,
    })
    expect(expired.hitKeys).toEqual([])
    expect(expired.missKeys).toEqual([k1, k2])

    const futureRecorded = partitionMutationCacheLookup({
      candidateKeys: [k1],
      store,
      auth: TEST_CACHE_AUTH,
      nowMs: MutationEpochMillis.make(Date.parse("2026-11-18T09:00:00.000Z")),
      ...defaultWitnessArgs,
    })
    expect(futureRecorded.hitKeys).toEqual([])

    // LRU pruning uses lastAccessedAt ?? recordedAt descending
    const { repoRoot } = setupTempRepo("export const x = 1\n")
    try {
      const entries: Record<ContentSha256, MutationCacheEntry> = {}
      const hotKey = computeContentSha256("hot-old-recorded")
      entries[hotKey] = makeSignedEntry(
        hotKey,
        "hot",
        "2026-11-18T01:00:00.000Z",
        TEST_HMAC_SECRET,
        "2026-11-18T23:59:59.000Z",
      )
      for (let i = 0; i < MAX_MUTATION_CACHE_ENTRIES; i++) {
        const k = computeContentSha256(`filler-${i}`)
        const ts = new Date(Date.parse("2026-11-18T02:00:00.000Z") + i * 1000).toISOString()
        entries[k] = makeSignedEntry(k, `m-${i}`, ts)
      }
      saveMutationCacheAtomic(
        repoRoot,
        { version: MUTATION_CACHE_SCHEMA_VERSION, entries },
        testHostIo,
        TEST_CACHE_AUTH,
      )
      const loaded = loadMutationCache(repoRoot, testHostIo, TEST_CACHE_AUTH)
      expect(loaded.entries[hotKey]).toBeDefined()
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-2.1c & F-8.1: runDomainMutationSuite warns on stderr and disables cache when auth is unavailable or symlinked", () => {
    const src = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempRepo(src)
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      const mockIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, opts) => {
          if (cmd === "git") return notGit
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/sample/domain/test/logic.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      const noSecretReport = runDomainMutationSuite(repoRoot, mockIo, { includeAllLines: true })
      expect(noSecretReport.passed).toBe(true)
      expect(stderrChunks.join("")).toContain(
        "[mutation-check] Warning: Mutation cache disabled (missing HMAC secret).",
      )
      expect(
        existsSync(join(resolveHarnessStateDir(repoRoot), "cache", MUTATION_CACHE_FILENAME)),
      ).toBe(false)

      // Disabled cacheAuth logs exact failure reason
      stderrChunks.length = 0
      const disabledReport = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        cacheAuth: { _tag: "Disabled", reason: ErrorReasonMessage.make("secret file corrupt") },
      })
      expect(disabledReport.passed).toBe(true)
      expect(stderrChunks.join("")).toContain(
        "[mutation-check] Warning: Mutation cache disabled (secret file corrupt).",
      )

      // Symlink in tools/ triggers Disabled with exact path
      stderrChunks.length = 0
      mkdirSync(join(repoRoot, "tools"), { recursive: true })
      const target = join(repoRoot, "outside.mjs")
      writeFileSync(target, "// outside\n", "utf8")
      const linkPath = join(repoRoot, "tools", "bad-link.mjs")
      symlinkSync(target, linkPath)
      const ctxRes = computeMutationContextDigestsChecked(repoRoot, testHostIo)
      match(ctxRes)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          expect(reason).toContain(linkPath)
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable("Expected Disabled")
        })
        .exhaustive()

      runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
      })
      expect(stderrChunks.join("")).toContain("[mutation-check] Warning: Mutation cache disabled (")
      expect(stderrChunks.join("")).toContain(linkPath)
    } finally {
      process.stderr.write = origWrite
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-5.1, F-6.1, F-7.1: per-entry quarantine/recovery, Skipped on missing secret/invalid HARNESS_STATE_DIR", () => {
    const { repoRoot } = setupTempRepo("export const x = 1\n")
    const prevStateDir = process.env["HARNESS_STATE_DIR"]
    try {
      expect(
        saveMutationCacheAtomic(
          repoRoot,
          { version: MUTATION_CACHE_SCHEMA_VERSION, entries: {} },
          isolatedTestHostIo,
        )._tag,
      ).toBe("Skipped")

      expect(loadMutationCacheWithStatus(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)._tag).toBe(
        "Missing",
      )

      const kGood = computeContentSha256("good")
      const kTampered = computeContentSha256("tampered")
      const kMismatch = computeContentSha256("mismatch")
      const goodEntry = makeSignedEntry(kGood, "m-good", "2026-11-18T16:00:00.000Z")
      const tamperedEntry = {
        ...makeSignedEntry(kTampered, "m-bad", "2026-11-18T16:00:00.000Z"),
        mutantId: MutantCacheId.make("m-tampered"),
      }
      const cacheDir = join(resolveHarnessStateDir(repoRoot), "cache")
      mkdirSync(cacheDir, { recursive: true })
      const cacheFile = join(cacheDir, MUTATION_CACHE_FILENAME)
      writeFileSync(
        cacheFile,
        JSON.stringify({
          version: MUTATION_CACHE_SCHEMA_VERSION,
          entries: {
            [kGood]: goodEntry,
            [kTampered]: tamperedEntry,
            [kMismatch]: goodEntry,
          },
        }),
        "utf8",
      )
      const loaded = loadMutationCacheWithStatus(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
      match(loaded)
        .with({ _tag: "Loaded" }, ({ droppedEntryCount, store }) => {
          expect(droppedEntryCount).toBe(2)
          expect(Object.keys(store.entries)).toEqual([kGood])
        })
        .with({ _tag: "Missing" }, { _tag: "Corrupt" }, { _tag: "Unsafe" }, () => {
          expect.unreachable("Expected Loaded")
        })
        .exhaustive()

      // Corrupt top-level JSON is quarantined to .corrupt
      writeFileSync(cacheFile, "{broken", "utf8")
      const corruptRes = loadMutationCacheWithStatus(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
      match(corruptRes)
        .with({ _tag: "Corrupt" }, ({ quarantinedPath }) => {
          expect(quarantinedPath).toBe(`${cacheFile}.corrupt`)
          expect(existsSync(`${cacheFile}.corrupt`)).toBe(true)
        })
        .with({ _tag: "Loaded" }, { _tag: "Missing" }, { _tag: "Unsafe" }, () => {
          expect.unreachable("Expected Corrupt")
        })
        .exhaustive()

      // Invalid HARNESS_STATE_DIR resolving to repoRoot returns Unsafe / Skipped without throwing
      process.env["HARNESS_STATE_DIR"] = "."
      expect(loadMutationCacheWithStatus(repoRoot, testHostIo, TEST_CACHE_AUTH)._tag).toBe("Unsafe")
      expect(
        saveMutationCacheAtomic(
          repoRoot,
          { version: MUTATION_CACHE_SCHEMA_VERSION, entries: {} },
          testHostIo,
          TEST_CACHE_AUTH,
        )._tag,
      ).toBe("Skipped")

      // External non-existent HARNESS_STATE_DIR succeeds safely and roundtrips saved entries
      const outsideParent = mkdtempSync(join(tmpdir(), "external-state-parent-"))
      try {
        process.env["HARNESS_STATE_DIR"] = join(outsideParent, "nested-nonexistent-state")
        const extStore: MutationCacheStore = {
          version: MUTATION_CACHE_SCHEMA_VERSION,
          entries: { [kGood]: goodEntry },
        }
        expect(saveMutationCacheAtomic(repoRoot, extStore, testHostIo, TEST_CACHE_AUTH)).toEqual({
          _tag: "Saved",
        })
        expect(loadMutationCache(repoRoot, testHostIo, TEST_CACHE_AUTH)).toEqual(extStore)
      } finally {
        rmSync(outsideParent, { recursive: true, force: true })
      }
    } finally {
      if (prevStateDir === undefined) delete process.env["HARNESS_STATE_DIR"]
      else process.env["HARNESS_STATE_DIR"] = prevStateDir
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-3.1: Exited(1) without explicit failed count or AssertionError/ExpectError is marked nonCacheableIds", () => {
    const src = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, domainFile, testFile } = setupTempRepo(src)
    try {
      const mutants = discoverDomainMutants("libs/sample/domain/src/logic.ts", src)
      const schemaBundle = compileMutantSchemaModule(
        "libs/sample/domain/src/logic.ts",
        src,
        mutants,
      )
      const mockIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, _args, opts) => {
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/sample/domain/test/logic.test.ts\n",
            stderr: "",
          }
        },
      }
      const res = runVitestTargetList(
        repoRoot,
        {
          scope: "sample",
          pkgDir: "domain",
          tier: "domain",
          fullPath: domainFile,
          relFile: "libs/sample/domain/src/logic.ts",
        },
        mockIo,
        {},
        [testFile],
        src,
        schemaBundle.schemaSource,
        join(repoRoot, ".harness", "mutation-backup.json"),
        mutants.slice(0, 1),
      )
      match(res)
        .with({ _tag: "Ok" }, ({ nonCacheableIds }) => {
          expect(nonCacheableIds.has(mutants[0]!.id)).toBe(true)
        })
        .with({ _tag: "Abort" }, () => {
          expect.unreachable("Expected Ok")
        })
        .exhaustive()
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-16.1, F-16.2, F-16.3: survived never cached, mixed hit+miss, overlays/custom testRunner disable cache, fallbackTests cached", () => {
    const src =
      "export const check = (a: number, b: number): boolean => (a === b ? true : b === 0)\n"
    const { repoRoot } = setupTempRepo(
      src,
      'import { expect, it } from "vitest"\nimport { check } from "../src/logic.js"\nit("ok", () => { expect(check(1, 1)).toBe(true) })\n',
    )
    const fallbackTest = join(repoRoot, "libs", "sample", "domain", "test", "extra.test.ts")
    writeFileSync(
      fallbackTest,
      'import { expect, it } from "vitest"\nit("extra", () => { expect(1).toBe(1) })\n',
      "utf8",
    )
    try {
      const mutants = discoverDomainMutants("libs/sample/domain/src/logic.ts", src)
      expect(mutants.length).toBeGreaterThanOrEqual(2)
      const survivedId = mutants[0]!.id
      const fallbackKilledId = mutants[1]!.id

      const executedMutantIds: Array<string> = []
      const mixedIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, args, opts) => {
          if (cmd === "git") return notGit
          const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
          if (activeId === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          executedMutantIds.push(activeId)
          const isFallback = args.some((a) => a.includes("extra.test.ts"))
          if (activeId === survivedId) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          if (activeId === fallbackKilledId && !isFallback) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: `FAIL  libs/sample/domain/test/${isFallback ? "extra.test.ts" : "logic.test.ts"}\nTests  1 failed (1)\n`,
            stderr: "",
          }
        },
      }
      const r1 = runDomainMutationSuite(repoRoot, mixedIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
      })
      expect(r1.survivedCount).toBe(1)
      const cachedAfter1 = loadMutationCache(repoRoot, testHostIo, TEST_CACHE_AUTH)
      const cachedMutantIds1 = Object.values(cachedAfter1.entries).map((e) => e.mutantId)
      expect(cachedMutantIds1).not.toContain(survivedId)
      expect(cachedMutantIds1).toContain(fallbackKilledId)

      // Second run: only survivedId runs as a miss; fallbackKilledId and others are cache hits
      executedMutantIds.length = 0
      const r2 = runDomainMutationSuite(repoRoot, mixedIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
      })
      expect(r2.cachedKilledCount).toBe(mutants.length - 1)
      expect(executedMutantIds).toEqual([survivedId])

      // F-16.2: custom testRunner, sourceCodeOverlays, and disableMutantCache (--no-cache) never write cache
      const stateDir = resolveHarnessStateDir(repoRoot)
      rmSync(stateDir, { recursive: true, force: true })
      runDomainMutationSuite(repoRoot, mixedIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        disableMutantCache: true,
      })
      expect(existsSync(join(stateDir, "cache", MUTATION_CACHE_FILENAME))).toBe(false)

      runDomainMutationSuite(repoRoot, testHostIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        testRunner: () => "killed",
      })
      expect(existsSync(join(stateDir, "cache", MUTATION_CACHE_FILENAME))).toBe(false)

      runDomainMutationSuite(repoRoot, testHostIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        sourceCodeOverlays: { "libs/sample/domain/src/logic.ts": src },
      })
      expect(existsSync(join(stateDir, "cache", MUTATION_CACHE_FILENAME))).toBe(false)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-16.4 & F-1.1 & S-1.7: key invalidates on root/pkg configs, non-ts lib files, docs, agent-patterns, tools, and runtimeVersion", () => {
    const src = [
      'import { otherFn } from "@other/infra"',
      'const refs = ["docs/specs/s1.md", "agent-patterns/guide.md", "tools/helper.ts"]',
      "export const isSame = (a: number, b: number) => a === b && otherFn() > 0 && refs.length > 0",
      "",
    ].join("\n")
    const { repoRoot } = setupTempRepo(src)
    try {
      mkdirSync(join(repoRoot, "agent-patterns"), { recursive: true })
      mkdirSync(join(repoRoot, "docs", "adr"), { recursive: true })
      mkdirSync(join(repoRoot, "docs", "specs"), { recursive: true })
      mkdirSync(join(repoRoot, "tools"), { recursive: true })
      mkdirSync(join(repoRoot, "libs", "other", "infra", "src"), { recursive: true })
      mkdirSync(join(repoRoot, "node_modules", "vitest"), { recursive: true })
      writeFileSync(join(repoRoot, "nx.json"), '{"v":1}\n', "utf8")
      writeFileSync(join(repoRoot, ".oxlintrc.json"), '{"v":1}\n', "utf8")
      writeFileSync(join(repoRoot, "vitest.config.ts"), "export default {}\n", "utf8")
      writeFileSync(
        join(repoRoot, "node_modules", "vitest", "package.json"),
        '{"name":"vitest","version":"3.0.0"}\n',
        "utf8",
      )
      writeFileSync(
        join(repoRoot, "libs", "sample", "domain", "package.json"),
        '{"name":"a"}\n',
        "utf8",
      )
      writeFileSync(
        join(repoRoot, "libs", "sample", "domain", "project.json"),
        '{"name":"a"}\n',
        "utf8",
      )
      writeFileSync(
        join(repoRoot, "libs", "other", "infra", "package.json"),
        '{"name":"@other/infra"}\n',
        "utf8",
      )
      writeFileSync(
        join(repoRoot, "libs", "other", "infra", "src", "index.ts"),
        "export const otherFn = () => 1\n",
        "utf8",
      )
      writeFileSync(
        join(repoRoot, "libs", "other", "infra", "src", "schema.pg"),
        "CREATE TABLE t(id int);\n",
        "utf8",
      )
      writeFileSync(join(repoRoot, "agent-patterns", "guide.md"), "# v1\n", "utf8")
      writeFileSync(join(repoRoot, "docs", "adr", "a1.md"), "# adr v1\n", "utf8")
      writeFileSync(join(repoRoot, "docs", "specs", "s1.md"), "# s1\n", "utf8")
      writeFileSync(join(repoRoot, "tools", "helper.ts"), "export const h = 1\n", "utf8")

      const getWsDigest = () =>
        match(computeMutationContextDigestsChecked(repoRoot, testHostIo))
          .with({ _tag: "Ok" }, ({ digests }) => digests)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok: ${reason}`)
          })
          .exhaustive()

      const d0 = getWsDigest()
      const mutant = makeSampleMutant()
      const origSha = computeContentSha256(src)
      const schemaSha = computeContentSha256("schema")
      const keyFor = (digests: typeof d0): string => {
        const closure = match(
          computeFileMutationClosureDigest({
            repoRoot,
            relFile: "libs/sample/domain/src/logic.ts",
            allReachingTests: ["libs/sample/domain/test/logic.test.ts"],
            digests,
            hostIo: testHostIo,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok closure: ${reason}`)
          })
          .exhaustive()
        const key = computeMutantCacheKey({
          pkgKey: PackageRelKey.make("sample/domain"),
          relFile: AstSourceFilePath.make("libs/sample/domain/src/logic.ts"),
          originalContentSha256: origSha,
          compiledSchemaSha256: schemaSha,
          mutant,
          digests,
        })
        return `${key}:${closure.closureDigest}`
      }

      const k0 = keyFor(d0)
      const mutators: ReadonlyArray<readonly [string, () => void]> = [
        ["nx.json", () => writeFileSync(join(repoRoot, "nx.json"), '{"v":2}\n', "utf8")],
        [
          ".oxlintrc.json",
          () => writeFileSync(join(repoRoot, ".oxlintrc.json"), '{"v":2}\n', "utf8"),
        ],
        [
          "vitest.config.ts",
          () => writeFileSync(join(repoRoot, "vitest.config.ts"), "export default {x:1}\n", "utf8"),
        ],
        [
          "vitest runtimeVersion",
          () =>
            writeFileSync(
              join(repoRoot, "node_modules", "vitest", "package.json"),
              '{"name":"vitest","version":"3.0.1"}\n',
              "utf8",
            ),
        ],
        [
          "package.json",
          () => writeFileSync(join(repoRoot, "package.json"), '{"name":"mut-root"}\n', "utf8"),
        ],
        [
          "pnpm-lock.yaml",
          () => writeFileSync(join(repoRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8"),
        ],
        [
          "pkg package.json",
          () =>
            writeFileSync(
              join(repoRoot, "libs", "sample", "domain", "package.json"),
              '{"name":"b"}\n',
              "utf8",
            ),
        ],
        [
          "pkg project.json",
          () =>
            writeFileSync(
              join(repoRoot, "libs", "sample", "domain", "project.json"),
              '{"name":"b"}\n',
              "utf8",
            ),
        ],
        [
          "other pkg schema.pg",
          () =>
            writeFileSync(
              join(repoRoot, "libs", "other", "infra", "src", "schema.pg"),
              "CREATE TABLE t(id text);\n",
              "utf8",
            ),
        ],
        [
          "agent-patterns",
          () => writeFileSync(join(repoRoot, "agent-patterns", "guide.md"), "# v2\n", "utf8"),
        ],
        [
          "docs/adr",
          () => writeFileSync(join(repoRoot, "docs", "adr", "a1.md"), "# adr v2\n", "utf8"),
        ],
        [
          "docs/specs",
          () => writeFileSync(join(repoRoot, "docs", "specs", "s1.md"), "# s2\n", "utf8"),
        ],
        [
          "tools",
          () => writeFileSync(join(repoRoot, "tools", "helper.ts"), "export const h = 2\n", "utf8"),
        ],
      ]
      let prevKey = k0
      for (const [label, mutate] of mutators) {
        mutate()
        const nextKey = keyFor(getWsDigest())
        expect(nextKey, `expected invalidation for ${label}`).not.toBe(prevKey)
        prevKey = nextKey
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-13.1 & F-16.5: incremental flush preserves kills before later-file abort and merges disjoint concurrent entries", () => {
    const src1 = "export const f1 = (a: number, b: number): boolean => a === b\n"
    const src2 = "export const f2 = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempRepo(src1)
    mkdirSync(join(repoRoot, "libs", "zzz", "domain", "src"), { recursive: true })
    mkdirSync(join(repoRoot, "libs", "zzz", "domain", "test"), { recursive: true })
    const f2Path = join(repoRoot, "libs", "zzz", "domain", "src", "logic2.ts")
    const t2Path = join(repoRoot, "libs", "zzz", "domain", "test", "logic2.test.ts")
    writeFileSync(f2Path, src2, "utf8")
    writeFileSync(
      t2Path,
      'import { expect, it } from "vitest"\nit("ok2", () => { expect(1).toBe(1) })\n',
      "utf8",
    )
    try {
      const mockIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, args, opts) => {
          if (cmd === "git") return notGit
          const isFile2 = args.some((a) => a.includes("logic2.test.ts"))
          if (isFile2) {
            return { _tag: "SpawnFailed", spawnError: "boom-file-2", stdout: "", stderr: "" }
          }
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  logic.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      const aborted = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
      })
      expect(aborted.passed).toBe(false)
      const savedAfterAbort = loadMutationCache(repoRoot, testHostIo, TEST_CACHE_AUTH)
      expect(Object.keys(savedAfterAbort.entries).length).toBeGreaterThan(0)

      // F-16.5: concurrent/interleaved run writes disjoint entry without clobbering existing
      const extraKey = computeContentSha256("concurrent-disjoint-entry")
      const extraEntry = makeSignedEntry(extraKey, "concurrent-m", "2026-11-18T16:00:00.000Z")
      const mergedIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, opts) => {
          if (cmd === "git") return notGit
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/zzz/domain/test/logic2.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      // Inject extraKey on disk, then run logic2.ts only; both entries must survive
      const current = loadMutationCache(repoRoot, testHostIo, TEST_CACHE_AUTH)
      saveMutationCacheAtomic(
        repoRoot,
        {
          version: MUTATION_CACHE_SCHEMA_VERSION,
          entries: { ...current.entries, [extraKey]: extraEntry },
        },
        testHostIo,
        TEST_CACHE_AUTH,
      )
      runDomainMutationSuite(repoRoot, mergedIo, {
        targetFiles: ["libs/zzz/domain/src/logic2.ts"],
        cacheAuth: TEST_CACHE_AUTH,
      })
      const afterConcurrent = loadMutationCache(repoRoot, testHostIo, TEST_CACHE_AUTH)
      expect(afterConcurrent.entries[extraKey]).toBeDefined()
      expect(Object.keys(afterConcurrent.entries).length).toBeGreaterThanOrEqual(2)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-12.1: aborts explicitly when a mutant lacks an entry in fileOutcomes", () => {
    const src = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempRepo(src)
    try {
      const mutants = discoverDomainMutants("libs/sample/domain/src/logic.ts", src)
      expect(mutants.length).toBeGreaterThanOrEqual(1)
      // Trigger batch path (>=2 mutants? use 2 mutants by adding another binary op)
      const src2 =
        "export const isSame = (a: number, b: number): boolean => (a === b ? true : b === 0)\n"
      writeFileSync(join(repoRoot, "libs", "sample", "domain", "src", "logic.ts"), src2, "utf8")
      const twoMutants = discoverDomainMutants("libs/sample/domain/src/logic.ts", src2)
      expect(twoMutants.length).toBeGreaterThanOrEqual(2)
      const missingBatchIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) =>
          p.endsWith("vitest.mjs") || p.endsWith("parallel-vitest-batch.mjs")
            ? true
            : testHostIo.existsSync(p),
        execFileSync: (cmd, args) => {
          if (cmd === "git") return notGit
          if (args.some((a) => a.includes("parallel-vitest-batch.mjs"))) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  id: twoMutants[0]!.id,
                  result: {
                    _tag: "Exited",
                    exitCode: 1,
                    stdout: "FAIL t\nTests 1 failed\n",
                    stderr: "",
                  },
                },
              ]),
              stderr: "",
            }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
        },
      }
      const report = runDomainMutationSuite(repoRoot, missingBatchIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
      })
      expect(report.passed).toBe(false)
      expect(report.diagnostic).toBeDefined()
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("collectOrderedFileOutcomes, inspectAncestorPath error handling, symlinked external state dir, and apps/vitest root digest fallback", () => {
    const src = "export const cmp = (a: number, b: number): boolean => (a === b ? true : b === 0)\n"
    const twoMutants = discoverDomainMutants("libs/sample/domain/src/logic.ts", src)
    expect(twoMutants.length).toBeGreaterThanOrEqual(2)
    const m0 = twoMutants[0]!
    const m1 = twoMutants[1]!
    const ordered = collectOrderedFileOutcomes(
      [m0, m1],
      new Map([[m0.id, { mutant: m0, status: "killed" }]]),
    )
    expect(ordered.present).toEqual([{ mutant: m0, status: "killed" }])
    expect(ordered.missingIds).toEqual([m1.id])

    const { repoRoot } = setupTempRepo(src)
    const externalReal = mkdtempSync(join(tmpdir(), "mut-ext-real-"))
    const externalSym = join(tmpdir(), `mut-ext-sym-${process.pid}-${Date.now()}`)
    const prevStateDir = process.env["HARNESS_STATE_DIR"]
    try {
      const store = { version: MUTATION_CACHE_SCHEMA_VERSION, entries: {} }
      const cacheDir = join(resolveHarnessStateDir(repoRoot), "cache")

      const enoentSymIo: SyncHostIo = {
        ...isolatedTestHostIo,
        isSymbolicLinkSync: (p) => {
          if (p === cacheDir && !isolatedTestHostIo.existsSync(p)) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" })
          }
          return isolatedTestHostIo.isSymbolicLinkSync(p)
        },
      }
      expect(saveMutationCacheAtomic(repoRoot, store, enoentSymIo, TEST_CACHE_AUTH)._tag).toBe(
        "Saved",
      )

      const eaccesSymIo: SyncHostIo = {
        ...isolatedTestHostIo,
        isSymbolicLinkSync: (p) => {
          if (p === cacheDir) throw Object.assign(new Error("denied"), { code: "EACCES" })
          return isolatedTestHostIo.isSymbolicLinkSync(p)
        },
      }
      match(saveMutationCacheAtomic(repoRoot, store, eaccesSymIo, TEST_CACHE_AUTH))
        .with({ _tag: "Skipped" }, ({ reason }) => {
          expect(reason).toContain("unsafe cache ancestor path")
        })
        .with({ _tag: "Saved" }, { _tag: "Failed" }, () => {
          expect.unreachable("Expected Skipped on EACCES ancestor")
        })
        .exhaustive()

      const nonStrCodeIo: SyncHostIo = {
        ...isolatedTestHostIo,
        isSymbolicLinkSync: (p) => {
          if (p === cacheDir && !isolatedTestHostIo.existsSync(p)) {
            throw Object.assign(new Error("numeric"), { code: 123 })
          }
          return isolatedTestHostIo.isSymbolicLinkSync(p)
        },
      }
      rmSync(cacheDir, { recursive: true, force: true })
      expect(saveMutationCacheAtomic(repoRoot, store, nonStrCodeIo, TEST_CACHE_AUTH)._tag).toBe(
        "Saved",
      )

      const nullThrowIo: SyncHostIo = {
        ...isolatedTestHostIo,
        isSymbolicLinkSync: (p) => {
          if (p === cacheDir && isolatedTestHostIo.existsSync(p))
            return isolatedTestHostIo.isSymbolicLinkSync(p)
          if (p === cacheDir) throw null
          return isolatedTestHostIo.isSymbolicLinkSync(p)
        },
      }
      rmSync(cacheDir, { recursive: true, force: true })
      expect(saveMutationCacheAtomic(repoRoot, store, nullThrowIo, TEST_CACHE_AUTH)._tag).toBe(
        "Saved",
      )

      mkdirSync(join(externalReal, "cache"), { recursive: true })
      symlinkSync(externalReal, externalSym)
      process.env["HARNESS_STATE_DIR"] = externalSym
      const symStateSave = saveMutationCacheAtomic(repoRoot, store, testHostIo, TEST_CACHE_AUTH)
      match(symStateSave)
        .with({ _tag: "Skipped" }, ({ reason }) => {
          expect(reason).toContain("unsafe cache ancestor path")
        })
        .with({ _tag: "Saved" }, { _tag: "Failed" }, () => {
          expect.unreachable("Expected Skipped on symlinked external HARNESS_STATE_DIR")
        })
        .exhaustive()
    } finally {
      if (prevStateDir === undefined) delete process.env["HARNESS_STATE_DIR"]
      else process.env["HARNESS_STATE_DIR"] = prevStateDir
      rmSync(repoRoot, { recursive: true, force: true })
      rmSync(externalSym, { recursive: true, force: true })
      rmSync(externalReal, { recursive: true, force: true })
    }

    const { repoRoot: root2 } = setupTempRepo(src)
    try {
      mkdirSync(join(root2, "apps", "demo", "test"), { recursive: true })
      // F-7.a: semver range in devDependencies is ignored; exact installed vitest version resolves
      writeFileSync(
        join(root2, "package.json"),
        JSON.stringify({ name: "app-exact", devDependencies: { vitest: "^99.0.0" } }),
        "utf8",
      )
      writeFileSync(
        join(root2, "apps", "demo", "test", "helper.ts"),
        "export const h = 1\n",
        "utf8",
      )
      const lockDigests = match(computeMutationContextDigestsChecked(root2, testHostIo))
        .with({ _tag: "Ok" }, ({ digests }) => digests)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          throw new Error(`Expected Ok: ${reason}`)
        })
        .exhaustive()
      expect(lockDigests.runtimeVersion).not.toContain("^99.0.0")

      // pnpm-lock.yaml exact vitest version resolution
      writeFileSync(
        join(root2, "pnpm-lock.yaml"),
        "importers:\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^4.3.2\n        version: 4.3.2(@types/node@26.0.0)\n",
        "utf8",
      )
      const fromLock = match(computeMutationContextDigestsChecked(root2, testHostIo))
        .with({ _tag: "Ok" }, ({ digests }) => digests)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          throw new Error(`Expected Ok from lockfile: ${reason}`)
        })
        .exhaustive()
      expect(fromLock.runtimeVersion).toContain("vitest:4.3.2")

      // node_modules/vitest/package.json exact version overrides lockfile, whereas range is rejected
      mkdirSync(join(root2, "node_modules", "vitest"), { recursive: true })
      writeFileSync(
        join(root2, "node_modules", "vitest", "package.json"),
        JSON.stringify({ name: "vitest", version: "9.8.7" }),
        "utf8",
      )
      const okDigests = match(computeMutationContextDigestsChecked(root2, testHostIo))
        .with({ _tag: "Ok" }, ({ digests }) => digests)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          throw new Error(`Expected Ok: ${reason}`)
        })
        .exhaustive()
      expect(okDigests.runtimeVersion).toContain("vitest:9.8.7")

      // Missing vitest across repoRoot and ancestors fails closed as Disabled
      rmSync(join(root2, "pnpm-lock.yaml"))
      rmSync(join(root2, "node_modules"), { recursive: true, force: true })
      const noVitestIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => (p.endsWith("vitest/package.json") ? false : testHostIo.existsSync(p)),
      }
      expect(computeMutationContextDigestsChecked(root2, noVitestIo)).toEqual({
        _tag: "Disabled",
        reason: "unable to resolve exact installed vitest version",
      })

      symlinkSync(
        join(root2, "apps", "demo", "test", "helper.ts"),
        join(root2, "apps", "demo", "test", "sym-helper.ts"),
      )
      expect(computeMutationContextDigestsChecked(root2, testHostIo)._tag).toBe("Disabled")
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  it("F-16.7: real Vitest --bail=1 stops on first failing test without running subsequent tests", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vitest-bail-real-"))
    try {
      const gatesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
      const repoRoot = resolve(gatesRoot, "../../..")
      const vitestCli = join(repoRoot, "node_modules", "vitest", "vitest.mjs")
      const vitestEntry = join(repoRoot, "node_modules", "vitest", "dist", "index.js")
      const markerFile = join(tmpDir, "executed.log")
      const testFile = join(tmpDir, "bail-check.test.ts")
      writeFileSync(
        testFile,
        `import { appendFileSync } from "node:fs"
import { expect, it } from ${JSON.stringify(vitestEntry)}
it("first fails", () => {
  appendFileSync(${JSON.stringify(markerFile)}, "first\\n")
  expect(1).toBe(2)
})
it("second should not run", () => {
  appendFileSync(${JSON.stringify(markerFile)}, "second\\n")
  expect(1).toBe(1)
})
`,
        "utf8",
      )
      const proc = spawnSync(
        process.execPath,
        [vitestCli, "run", "--root", tmpDir, "--bail=1", "--no-file-parallelism", testFile],
        { cwd: tmpDir, encoding: "utf8", timeout: 20_000 },
      )
      expect(proc.status).toBe(1)
      const executed = readFileSync(markerFile, "utf8").trim().split("\n")
      expect(executed).toEqual(["first"])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("REQ-1.1 hardening: computeFileMutationClosureDigest fails closed on symlinked or unreadable transitive imports", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mutation-closure-hard-"))
    try {
      const srcDir = join(repoRoot, "libs", "sample", "domain", "src")
      const testDir = join(repoRoot, "libs", "sample", "domain", "test")
      mkdirSync(srcDir, { recursive: true })
      mkdirSync(testDir, { recursive: true })
      writeFileSync(join(repoRoot, "package.json"), '{"name":"tmp"}\n')
      writeFileSync(
        join(srcDir, "logic.ts"),
        'import { d } from "./dep.js"\nexport const f = () => d\n',
      )
      writeFileSync(join(srcDir, "dep.ts"), "export const d = 1\n")
      writeFileSync(join(testDir, "logic.test.ts"), 'import { f } from "../src/logic.js"\n')

      const digests = match(computeMutationContextDigestsChecked(repoRoot, testHostIo))
        .with({ _tag: "Ok" }, ({ digests: d }) => d)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          throw new Error(`Expected Ok: ${reason}`)
        })
        .exhaustive()

      const depPath = join(srcDir, "dep.ts")
      const unreadableIo: SyncHostIo = {
        ...testHostIo,
        readTextSync: (p) => {
          if (p === depPath) throw new Error("EACCES: dep")
          return testHostIo.readTextSync(p)
        },
      }
      expect(
        computeFileMutationClosureDigest({
          repoRoot,
          relFile: "libs/sample/domain/src/logic.ts",
          allReachingTests: ["libs/sample/domain/test/logic.test.ts"],
          digests,
          hostIo: unreadableIo,
        })._tag,
      ).toBe("Disabled")

      const symlinkIo: SyncHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === depPath ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      expect(
        computeFileMutationClosureDigest({
          repoRoot,
          relFile: "libs/sample/domain/src/logic.ts",
          allReachingTests: ["libs/sample/domain/test/logic.test.ts"],
          digests,
          hostIo: symlinkIo,
        })._tag,
      ).toBe("Disabled")

      // Realpath escape / symlinked ancestor inside closure fails closed
      const escapeIo: SyncHostIo = {
        ...testHostIo,
        realpathSync: (p) => (p === depPath ? "/etc/passwd" : testHostIo.realpathSync(p)),
      }
      expect(
        computeFileMutationClosureDigest({
          repoRoot,
          relFile: "libs/sample/domain/src/logic.ts",
          allReachingTests: ["libs/sample/domain/test/logic.test.ts"],
          digests,
          hostIo: escapeIo,
        })._tag,
      ).toBe("Disabled")
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-1.2 & cache helpers: preparePackageBaselines, recordKilledMutantsToCache, and flushMutationCache", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "suite-helpers-hard-"))
    try {
      const srcDir = join(repoRoot, "libs", "demo", "domain", "src")
      const testDir = join(repoRoot, "libs", "demo", "domain", "test")
      mkdirSync(srcDir, { recursive: true })
      mkdirSync(testDir, { recursive: true })
      writeFileSync(join(repoRoot, "package.json"), '{"name":"tmp"}\n')
      const fileA = {
        scope: "demo",
        pkgDir: "domain",
        tier: "domain" as const,
        fullPath: join(srcDir, "a.ts"),
        relFile: "libs/demo/domain/src/a.ts",
      }
      const fileB = {
        scope: "demo",
        pkgDir: "domain",
        tier: "domain" as const,
        fullPath: join(srcDir, "b.ts"),
        relFile: "libs/demo/domain/src/b.ts",
      }
      writeFileSync(fileA.fullPath, "export const eqA = (x: number, y: number) => x === y\n")
      writeFileSync(fileB.fullPath, "export const eqB = (x: number, y: number) => x === y\n")
      writeFileSync(join(testDir, "a.test.ts"), 'import { eqA } from "../src/a.js"\n')
      writeFileSync(join(testDir, "b.test.ts"), 'import { eqB } from "../src/b.js"\n')

      const baselineTestsSeen: Array<string> = []
      const prepIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          baselineTestsSeen.push(...args)
          return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
        },
      }
      const diffLinesMap = new Map<string, ReadonlySet<number>>([[fileA.relFile, new Set([1])]])
      const prepRes = preparePackageBaselines({
        repoRoot,
        targets: [fileA, fileB],
        hostIo: prepIo,
        baseSubprocessEnv: {},
        diffLinesMap,
        bypassDiffFilter: false,
      })
      const prepOk = match(prepRes)
        .with({ _tag: "Ok" }, (ok) => ok)
        .with({ _tag: "ReadError" }, ({ relFile, reason }) => {
          throw new Error(`Expected Ok for ${relFile}: ${reason}`)
        })
        .exhaustive()
      expect(prepOk.partitionCache.has(fileA.relFile)).toBe(true)
      expect(prepOk.partitionCache.has(fileB.relFile)).toBe(false)
      expect(baselineTestsSeen.some((a) => a.includes("b.test.ts"))).toBe(false)

      // recordKilledMutantsToCache
      const mutant = makeSampleMutant()
      const key = computeContentSha256("k1")
      const mutantKeys = new Map([[mutant.id, key]])
      const fileOutcomes = new Map([[mutant.id, { mutant, status: "killed" as const }]])
      const witnessByMutantId = new Map([
        [mutant.id, AstSourceFilePath.make("libs/demo/domain/test/a.test.ts")],
      ])
      const cacheDigests = match(computeMutationContextDigestsChecked(repoRoot, testHostIo))
        .with({ _tag: "Ok" }, ({ digests }) => digests)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          throw new Error(`Expected Ok digests: ${reason}`)
        })
        .exhaustive()
      const cacheEntries: Record<ContentSha256, MutationCacheEntry> = {}
      const nowMs = MutationEpochMillis.make(Date.parse("2026-11-18T16:00:00.000Z"))
      const baseRecordArgs = {
        relFile: fileA.relFile,
        uncachedMutants: [mutant],
        fileOutcomes,
        mutantKeys,
        fileNonCacheableIds: new Set<string>(),
        witnessByMutantId,
        repoRoot,
        digests: cacheDigests,
        hostIo: testHostIo,
        nowMs,
        cacheEntries,
      }
      expect(recordKilledMutantsToCache({ ...baseRecordArgs, cacheAuth: undefined })).toBe(false)
      expect(recordKilledMutantsToCache({ ...baseRecordArgs, cacheAuth: TEST_CACHE_AUTH })).toBe(
        true,
      )
      expect(cacheEntries[key]?.status).toBe("killed")

      // flushMutationCache: Saved -> true, Failed -> false, Skipped (symlink) -> false
      expect(flushMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH, cacheEntries)).toBe(
        true,
      )
      const failMkdirIo: SyncHostIo = {
        ...isolatedTestHostIo,
        mkdirRecursiveSync: () => {
          throw new Error("EACCES: mkdir")
        },
      }
      expect(flushMutationCache(repoRoot, failMkdirIo, TEST_CACHE_AUTH, cacheEntries)).toBe(false)
      const symlinkStateIo: SyncHostIo = {
        ...isolatedTestHostIo,
        isSymbolicLinkSync: (p) =>
          p.endsWith(".harness") ? true : isolatedTestHostIo.isSymbolicLinkSync(p),
      }
      expect(flushMutationCache(repoRoot, symlinkStateIo, TEST_CACHE_AUTH, cacheEntries)).toBe(
        false,
      )
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-1.1 edge cases: ancestor symlinks, tsconfig paths, and unresolved imports/exports fallback", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "closure-edges-"))
    try {
      mkdirSync(join(repoRoot, "libs", "acme", "core", "src"), { recursive: true })
      mkdirSync(join(repoRoot, "libs", "app", "domain", "src", "nested"), { recursive: true })
      mkdirSync(join(repoRoot, "docs", "specs"), { recursive: true })
      writeFileSync(
        join(repoRoot, "package.json"),
        '{"name":"tmp","devDependencies":{"vitest":"1.0.0"}}\n',
      )
      writeFileSync(
        join(repoRoot, "tsconfig.base.json"),
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@acme/core": ["./libs/acme/core/src/index.ts"],
              "@acme/core/*": ["./libs/acme/core/src/*"],
              "@alias-only/core": ["./tools/noop.ts", "./libs/acme/core/src/index.ts"],
            },
          },
        }),
      )
      writeFileSync(join(repoRoot, "docs", "specs", "guide.md"), "# Guide v1\n")
      writeFileSync(join(repoRoot, "index.ts"), "export const rootVal = 1\n")
      writeFileSync(
        join(repoRoot, "entry.ts"),
        'import { rootVal } from "."\nexport const out = rootVal\n',
      )
      writeFileSync(
        join(repoRoot, "libs", "acme", "core", "package.json"),
        '{"name":"@acme/core"}\n',
      )
      writeFileSync(
        join(repoRoot, "libs", "acme", "core", "src", "index.ts"),
        "export const c = 1\n",
      )
      writeFileSync(
        join(repoRoot, "libs", "app", "domain", "src", "docs-helper.ts"),
        "export const d = 1\n",
      )
      writeFileSync(
        join(repoRoot, "libs", "app", "domain", "src", "nested", "dep.ts"),
        "export const n = 1\n",
      )
      writeFileSync(
        join(repoRoot, "libs", "app", "domain", "src", "clean.ts"),
        'import { d } from "./docs-helper.js"\nexport { d as dd } from "./docs-helper.js"\nexport const x = d\n',
      )
      writeFileSync(
        join(repoRoot, "libs", "app", "domain", "src", "uses-docs.ts"),
        'export const pathHint = "docs/specs/guide.md"\n',
      )
      writeFileSync(
        join(repoRoot, "libs", "app", "domain", "src", "uses-acme-missing.ts"),
        'import { x } from "@acme/core/missing"\nexport const y = x\n',
      )
      writeFileSync(
        join(repoRoot, "libs", "app", "domain", "src", "uses-nested.ts"),
        'import { n } from "./nested/dep.js"\nexport const z = n\n',
      )

      const digests1 = match(computeMutationContextDigestsChecked(repoRoot, testHostIo))
        .with({ _tag: "Ok" }, ({ digests }) => digests)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          throw new Error(`Expected Ok digests1: ${reason}`)
        })
        .exhaustive()

      expect(digests1.workspacePackages.get("@acme/core")).toBe("libs/acme/core")
      expect(digests1.workspacePackages.get("@alias-only/core")).toBe("libs/acme/core")

      const unwrapOk = (
        relFile: string,
        digests: typeof digests1,
        hostIo: SyncHostIo = testHostIo,
      ) =>
        match(
          computeFileMutationClosureDigest({
            repoRoot,
            relFile,
            allReachingTests: [],
            digests,
            hostIo,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok closure for ${relFile}: ${reason}`)
          })
          .exhaustive()

      const clean1 = unwrapOk("libs/app/domain/src/clean.ts", digests1)
      const docs1 = unwrapOk("libs/app/domain/src/uses-docs.ts", digests1)
      const rootEntry1 = unwrapOk("entry.ts", digests1)
      const acmeMissing = unwrapOk("libs/app/domain/src/uses-acme-missing.ts", digests1)
      expect(acmeMissing.usedFallbackAllLibs).toBe(true)

      // Mutating docs/specs/guide.md & index.ts isolates clean.ts while invalidating uses-docs.ts & entry.ts
      writeFileSync(join(repoRoot, "docs", "specs", "guide.md"), "# Guide v2\n")
      writeFileSync(join(repoRoot, "index.ts"), "export const rootVal = 2\n")
      const digests2 = match(computeMutationContextDigestsChecked(repoRoot, testHostIo))
        .with({ _tag: "Ok" }, ({ digests }) => digests)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          throw new Error(`Expected Ok digests2: ${reason}`)
        })
        .exhaustive()

      const clean2 = unwrapOk("libs/app/domain/src/clean.ts", digests2)
      const docs2 = unwrapOk("libs/app/domain/src/uses-docs.ts", digests2)
      const rootEntry2 = unwrapOk("entry.ts", digests2)

      expect(clean2.closureDigest).toBe(clean1.closureDigest)
      expect(docs2.closureDigest).not.toBe(docs1.closureDigest)
      expect(rootEntry2.closureDigest).not.toBe(rootEntry1.closureDigest)

      // Ancestor symlink check catches symlinked parent directory even when leaf is inside repoReal
      const nestedDir = join(repoRoot, "libs", "app", "domain", "src", "nested")
      const symParentIo: SyncHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === nestedDir ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      const symAncestorRes = computeFileMutationClosureDigest({
        repoRoot,
        relFile: "libs/app/domain/src/uses-nested.ts",
        allReachingTests: [],
        digests: digests2,
        hostIo: symParentIo,
      })
      match(symAncestorRes)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          expect(reason).toContain("symlink")
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable("Expected Disabled on symlinked ancestor directory")
        })
        .exhaustive()

      // F-8.a: missing relative import triggers usedFallbackAllLibs = true and distinguishes unresolved specifier
      writeFileSync(
        join(repoRoot, "libs", "app", "domain", "src", "missing-rel-a.ts"),
        'import { m } from "./does-not-exist-a.js"\nexport const v = m\n',
      )
      writeFileSync(
        join(repoRoot, "libs", "app", "domain", "src", "missing-rel-b.ts"),
        'import { m } from "./does-not-exist-b.js"\nexport const v = m\n',
      )
      const missingRelA = unwrapOk("libs/app/domain/src/missing-rel-a.ts", digests2)
      const missingRelB = unwrapOk("libs/app/domain/src/missing-rel-b.ts", digests2)
      expect(missingRelA.usedFallbackAllLibs).toBe(true)
      expect(missingRelB.usedFallbackAllLibs).toBe(true)

      // F-8.b: package with explicit exports pointing to missing target fails closed to UnresolvedWorkspace (not src/index.ts)
      mkdirSync(join(repoRoot, "libs", "acme", "broken-exp", "src"), { recursive: true })
      writeFileSync(
        join(repoRoot, "libs", "acme", "broken-exp", "package.json"),
        JSON.stringify({ name: "@harness/broken-exp", exports: { ".": "./src/missing-entry.ts" } }),
      )
      writeFileSync(
        join(repoRoot, "libs", "acme", "broken-exp", "src", "index.ts"),
        "export const fallbackShouldNotResolve = 1\n",
      )
      writeFileSync(
        join(repoRoot, "libs", "app", "domain", "src", "uses-broken-exp.ts"),
        'import { fallbackShouldNotResolve } from "@harness/broken-exp"\nexport const v = fallbackShouldNotResolve\n',
      )
      const digests3 = match(computeMutationContextDigestsChecked(repoRoot, testHostIo))
        .with({ _tag: "Ok" }, ({ digests }) => digests)
        .with({ _tag: "Disabled" }, ({ reason }) => {
          throw new Error(`Expected Ok digests3: ${reason}`)
        })
        .exhaustive()
      const brokenExpClosure = unwrapOk("libs/app/domain/src/uses-broken-exp.ts", digests3)
      expect(brokenExpClosure.usedFallbackAllLibs).toBe(true)
      expect(brokenExpClosure.resolvedFiles).not.toContain("libs/acme/broken-exp/src/index.ts")
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
