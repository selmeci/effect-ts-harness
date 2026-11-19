import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  ContentSha256,
  MUTATION_CACHE_FILENAME,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  type MutationCacheEntry,
  MutationCacheHmacSecret,
  MutationCacheStore,
  MutationCacheTimestamp,
  MutationEpochMillis,
  PackageRelKey,
  SourceLineNumber,
  computeContentSha256,
} from "@harness/contract"
import { runWithTestTracer } from "@harness/ingest"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { runDomainMutationSuite } from "../src/mutation-check.js"
import { runVitestTargetList } from "../src/mutation-subprocess-helpers.js"
import {
  type CodeMutant,
  MutantId,
  MutantSourceText,
  compileMutantSchemaModule,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import {
  MAX_MUTATION_CACHE_ENTRIES,
  MutationCache,
  computeMutantCacheKey,
  computeMutationContextDigests,
  computeMutationEntryMac,
  emptyMutationCacheStore,
  hashReachingTestFiles,
  loadMutationCache,
  loadMutationCacheWithStatus,
  saveMutationCacheAtomic,
} from "../src/mutation/mutation-cache.js"
import { decideSpanBudgets, type SpanSample } from "../src/span-budget.js"
import { resolveHarnessStateDir } from "../src/worktree.js"
import { testHostIo } from "./helpers/test-host-io.js"

const setupTempRepo = (
  domainSource: string,
  testSource = 'import { expect, it } from "vitest"\nit("ok", () => { expect(1).toBe(1) })\n',
): {
  readonly repoRoot: string
  readonly domainFile: string
  readonly testFile: string
} => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mutation-cache-test-"))
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

const makeSampleMutant = (id = "logic.ts:1:0"): CodeMutant => ({
  id: MutantId.make(id),
  file: AstSourceFilePath.make("libs/sample/domain/src/logic.ts"),
  line: SourceLineNumber.make(1),
  category: "boolean-return",
  original: MutantSourceText.make("a === b"),
  replacement: MutantSourceText.make("false"),
  mutatedSource: MutantSourceText.make("export const isSame = (a: number, b: number) => false\n"),
})

const TEST_HMAC_SECRET = MutationCacheHmacSecret.make("test-hmac-secret-0123456789abcdef0123456789")

const makeSignedEntry = (
  key: ContentSha256,
  mutantId: string,
  recordedAtStr = "2026-11-18T16:00:00.000Z",
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
    mac: computeMutationEntryMac(TEST_HMAC_SECRET, {
      key,
      file,
      mutantId: mId,
      status: "killed",
      recordedAt,
    }),
  }
}

const unwrapOpt = <A>(opt: Option.Option<A>): A =>
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => {
      throw new Error("Expected Option.Some")
    })
    .exhaustive()

describe("MutationCache", () => {
  it.effect(
    "MutationCache.decide emits span with exitTag=Success, zero budget violations, and guards entry.key !== candidateKey",
    () =>
      Effect.gen(function* () {
        const k1 = computeContentSha256("k1")
        const k2 = computeContentSha256("k2")
        const k3 = computeContentSha256("k3")
        const store: MutationCacheStore = {
          version: MUTATION_CACHE_SCHEMA_VERSION,
          entries: {
            [k1]: makeSignedEntry(k1, "m1"),
            // Corrupted entry where record key !== entry.key must be treated as a miss
            [k3]: { ...makeSignedEntry(k1, "m3") },
          },
        }
        const { result, spans } = yield* runWithTestTracer(
          "MutationCache.decide::partition",
          MutationCache.decide({
            candidateKeys: [k1, k2, k3],
            store,
            hmacSecret: TEST_HMAC_SECRET,
            nowMs: MutationEpochMillis.make(Date.parse("2026-11-18T16:30:00.000Z")),
          }),
          new Map(),
        )
        expect(result.hitKeys).toEqual([k1])
        expect(result.missKeys).toEqual([k2, k3])
        const decideSpan = spans.find((s) => s.name === "MutationCache.decide")
        expect(decideSpan).toBeDefined()
        expect(decideSpan?.exitTag).toBe("Success")

        const spanSamples: ReadonlyArray<SpanSample> = spans.map((s) => ({
          spanId: s.spanId,
          name: s.name,
          parentSpanId: s.parentSpanId,
          durationMs: s.durationMs,
          startTimeMs: s.startTimeMs,
          endTimeMs: s.endTimeMs,
          exitTag: match(s.exitTag)
            .with("Success", () => "Success" as const)
            .with("Failure", () => "Failure" as const)
            .with("Defect", () => "Defect" as const)
            .with("Interrupt", () => "Failure" as const)
            .with(undefined, () => undefined)
            .exhaustive(),
          errorTag: s.errorTag,
        }))
        const budgetViolations = yield* decideSpanBudgets({ spans: spanSamples })
        expect(budgetViolations).toEqual([])
      }),
  )

  it.effect.prop(
    "MutationCache.decide property: preserves exact hitKeys, missKeys, order, and count sum",
    {
      seeds: Schema.Array(Schema.NonEmptyString),
      presentFlags: Schema.Array(Schema.Boolean),
    },
    ({ seeds, presentFlags }) =>
      Effect.gen(function* () {
        const candidateKeys: Array<ContentSha256> = seeds.map((s) => computeContentSha256(s))
        const entries: Record<ContentSha256, MutationCacheEntry> = {}
        candidateKeys.forEach((key, idx) => {
          if (presentFlags[idx] === true) {
            entries[key] = makeSignedEntry(key, `m-${idx}`)
          }
        })
        const expectedHits = candidateKeys.filter((k) => Object.hasOwn(entries, k))
        const expectedMisses = candidateKeys.filter((k) => !Object.hasOwn(entries, k))
        const decision = yield* MutationCache.decide({
          candidateKeys,
          store: { version: MUTATION_CACHE_SCHEMA_VERSION, entries },
          hmacSecret: TEST_HMAC_SECRET,
          nowMs: MutationEpochMillis.make(Date.parse("2026-11-18T16:30:00.000Z")),
        })
        expect(decision.hitKeys).toEqual(expectedHits)
        expect(decision.missKeys).toEqual(expectedMisses)
        expect(decision.hitKeys.length + decision.missKeys.length).toBe(candidateKeys.length)
      }),
  )

  it("disk cache roundtrips, handles corrupt/schema-invalid JSON, EACCES, symlinked stateDir/cacheDir, and bounds MAX_MUTATION_CACHE_ENTRIES", () => {
    const { repoRoot } = setupTempRepo("export const isSame = (a: number, b: number) => a === b\n")
    try {
      expect(loadMutationCache(repoRoot, testHostIo)).toEqual(emptyMutationCacheStore())

      const key1 = computeContentSha256("entry-1")
      const store1: MutationCacheStore = {
        version: MUTATION_CACHE_SCHEMA_VERSION,
        entries: {
          [key1]: makeSignedEntry(key1, "m1"),
        },
      }
      expect(saveMutationCacheAtomic(repoRoot, store1, testHostIo, TEST_HMAC_SECRET)).toEqual({
        _tag: "Saved",
      })
      expect(loadMutationCache(repoRoot, testHostIo, TEST_HMAC_SECRET)).toEqual(store1)
      expect(loadMutationCacheWithStatus(repoRoot, testHostIo)).toEqual({
        _tag: "Unsafe",
        reason: "missing HMAC secret",
      })
      expect(loadMutationCache(repoRoot, testHostIo)).toEqual(emptyMutationCacheStore())

      const stateDir = resolveHarnessStateDir(repoRoot)
      const cacheDir = join(stateDir, "cache")
      const cacheFile = join(cacheDir, MUTATION_CACHE_FILENAME)

      // Corrupt JSON & schema-invalid JSON
      writeFileSync(cacheFile, "{not-valid-json", "utf8")
      expect(loadMutationCache(repoRoot, testHostIo, TEST_HMAC_SECRET)).toEqual(
        emptyMutationCacheStore(),
      )
      writeFileSync(cacheFile, JSON.stringify({ version: "wrong-v", entries: {} }), "utf8")
      expect(loadMutationCache(repoRoot, testHostIo, TEST_HMAC_SECRET)).toEqual(
        emptyMutationCacheStore(),
      )

      // EACCES fail-safe on load & save
      const eaccesIo: SyncHostIo = {
        ...testHostIo,
        readTextSync: () => {
          throw new Error("EACCES: permission denied")
        },
        writeTextSync: () => {
          throw new Error("EACCES: permission denied")
        },
      }
      expect(loadMutationCache(repoRoot, eaccesIo, TEST_HMAC_SECRET)).toEqual(
        emptyMutationCacheStore(),
      )
      expect(saveMutationCacheAtomic(repoRoot, store1, eaccesIo, TEST_HMAC_SECRET)._tag).toBe(
        "Failed",
      )

      // Symlinked cacheFile fail-safe
      rmSync(cacheFile, { force: true })
      const outsideTarget = join(repoRoot, "outside.json")
      writeFileSync(outsideTarget, JSON.stringify(store1), "utf8")
      symlinkSync(outsideTarget, cacheFile)
      expect(loadMutationCache(repoRoot, testHostIo, TEST_HMAC_SECRET)).toEqual(
        emptyMutationCacheStore(),
      )
      expect(saveMutationCacheAtomic(repoRoot, store1, testHostIo, TEST_HMAC_SECRET)._tag).toBe(
        "Skipped",
      )
      expect(readFileSync(outsideTarget, "utf8")).toBe(JSON.stringify(store1))
      rmSync(cacheFile)

      // Symlinked stateDir must NOT call mkdirRecursiveSync
      const outsideDir = mkdtempSync(join(tmpdir(), "outside-state-"))
      try {
        rmSync(stateDir, { recursive: true, force: true })
        symlinkSync(outsideDir, stateDir)
        let mkdirCalled = false
        const spyMkdirIo: SyncHostIo = {
          ...testHostIo,
          mkdirRecursiveSync: (dirPath, mode) => {
            mkdirCalled = true
            testHostIo.mkdirRecursiveSync(dirPath, mode)
          },
        }
        expect(loadMutationCache(repoRoot, spyMkdirIo, TEST_HMAC_SECRET)).toEqual(
          emptyMutationCacheStore(),
        )
        saveMutationCacheAtomic(repoRoot, store1, spyMkdirIo, TEST_HMAC_SECRET)
        expect(mkdirCalled).toBe(false)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
        rmSync(stateDir, { recursive: true, force: true })
      }

      // Realpath escape outside stateDir fails closed even if lstat reports non-symlink
      saveMutationCacheAtomic(repoRoot, store1, testHostIo, TEST_HMAC_SECRET)
      const escapeRealpathIo: SyncHostIo = {
        ...testHostIo,
        realpathSync: (p) =>
          p === cacheFile ? "/outside/evil-cache.json" : testHostIo.realpathSync(p),
      }
      expect(loadMutationCache(repoRoot, escapeRealpathIo, TEST_HMAC_SECRET)).toEqual(
        emptyMutationCacheStore(),
      )

      // External HARNESS_STATE_DIR stops ancestor check at resolved stateDir without walking above it
      const outsideBase = mkdtempSync(join(tmpdir(), "ext-state-base-"))
      const externalStateDir = join(outsideBase, "state")
      mkdirSync(externalStateDir, { recursive: true })
      const prevStateDirEnv = process.env["HARNESS_STATE_DIR"]
      try {
        process.env["HARNESS_STATE_DIR"] = externalStateDir
        saveMutationCacheAtomic(repoRoot, store1, testHostIo, TEST_HMAC_SECRET)
        const throwAboveStateIo: SyncHostIo = {
          ...testHostIo,
          existsSync: (p) => {
            if (p === outsideBase) throw new Error("parent outside stateDir should not be probed")
            return testHostIo.existsSync(p)
          },
        }
        expect(loadMutationCache(repoRoot, throwAboveStateIo, TEST_HMAC_SECRET)).toEqual(store1)
      } finally {
        if (prevStateDirEnv === undefined) delete process.env["HARNESS_STATE_DIR"]
        else process.env["HARNESS_STATE_DIR"] = prevStateDirEnv
        rmSync(outsideBase, { recursive: true, force: true })
      }

      // Exact MAX_MUTATION_CACHE_ENTRIES preserves entry order without pruning/re-sorting
      const exactEntries: Record<ContentSha256, MutationCacheEntry> = {}
      const kOldest = computeContentSha256("exact-0")
      for (let i = 0; i < MAX_MUTATION_CACHE_ENTRIES; i++) {
        const k = i === 0 ? kOldest : computeContentSha256(`exact-${i}`)
        const ts =
          i === 0
            ? "2020-01-01T00:00:00.000Z"
            : new Date(Date.parse("2026-11-18T00:00:00.000Z") + i * 1000).toISOString()
        exactEntries[k] = makeSignedEntry(k, `m-${i}`, ts)
      }
      let exactWrittenJson = ""
      const captureExactIo: SyncHostIo = {
        ...testHostIo,
        writeTextSync: (p, content) => {
          exactWrittenJson = content
          testHostIo.writeTextSync(p, content)
        },
      }
      saveMutationCacheAtomic(
        repoRoot,
        { version: MUTATION_CACHE_SCHEMA_VERSION, entries: exactEntries },
        captureExactIo,
        TEST_HMAC_SECRET,
      )
      const exactParsed = JSON.parse(exactWrittenJson) as { entries: Record<string, unknown> }
      expect(Object.keys(exactParsed.entries)[0]).toBe(kOldest)

      // MAX_MUTATION_CACHE_ENTRIES + 10 bound evicts oldest entries
      const manyEntries: Record<ContentSha256, MutationCacheEntry> = {}
      for (let i = 0; i < MAX_MUTATION_CACHE_ENTRIES + 10; i++) {
        const k = computeContentSha256(`many-${i}`)
        const ts = new Date(Date.parse("2026-11-18T00:00:00.000Z") + i * 1000).toISOString()
        manyEntries[k] = makeSignedEntry(k, `m-${i}`, ts)
      }
      saveMutationCacheAtomic(
        repoRoot,
        { version: MUTATION_CACHE_SCHEMA_VERSION, entries: manyEntries },
        testHostIo,
        TEST_HMAC_SECRET,
      )
      const loadedBounded = loadMutationCache(repoRoot, testHostIo, TEST_HMAC_SECRET)
      expect(Object.keys(loadedBounded.entries).length).toBe(MAX_MUTATION_CACHE_ENTRIES)
      const oldestKey = computeContentSha256("many-0")
      const newestKey = computeContentSha256(`many-${MAX_MUTATION_CACHE_ENTRIES + 9}`)
      expect(loadedBounded.entries[oldestKey]).toBeUndefined()
      expect(loadedBounded.entries[newestKey]).toBeDefined()
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("computeMutantCacheKey invalidates on source, schema, reachingTest, mutant, .tsx, cross-pkg helper, and tools/ changes", () => {
    const src = "export const isSame = (a: number, b: number) => a === b\n"
    const { repoRoot, testFile } = setupTempRepo(src)
    try {
      const helperDir = join(repoRoot, "libs", "shared", "service", "test")
      mkdirSync(join(repoRoot, "libs", "shared", "service", "src"), { recursive: true })
      mkdirSync(helperDir, { recursive: true })
      mkdirSync(join(repoRoot, "tools"), { recursive: true })
      writeFileSync(
        join(repoRoot, "libs", "shared", "service", "src", "view.tsx"),
        "export const V = 1\n",
      )
      writeFileSync(join(helperDir, "test-host-io.ts"), "export const helper = 1\n")
      writeFileSync(join(repoRoot, "tools", "parallel-vitest-batch.mjs"), "// v1\n")

      const digests1 = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      const mutant = makeSampleMutant()
      const origSha1 = computeContentSha256(src)
      const schemaSha1 = computeContentSha256("schema-v1")
      const pkgKey = PackageRelKey.make("sample/domain")
      const relFile = AstSourceFilePath.make("libs/sample/domain/src/logic.ts")
      const reachingHashes1 = unwrapOpt(hashReachingTestFiles(repoRoot, [testFile], testHostIo))
      const keyBase = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: origSha1,
        compiledSchemaSha256: schemaSha1,
        mutant,
        reachingTestHashes: reachingHashes1,
        digests: digests1,
      })

      const keyDiffSrc = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: computeContentSha256(`${src}// changed`),
        compiledSchemaSha256: schemaSha1,
        mutant,
        reachingTestHashes: reachingHashes1,
        digests: digests1,
      })
      expect(keyDiffSrc).not.toBe(keyBase)

      const keyDiffSchema = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: origSha1,
        compiledSchemaSha256: computeContentSha256("schema-v2"),
        mutant,
        reachingTestHashes: reachingHashes1,
        digests: digests1,
      })
      expect(keyDiffSchema).not.toBe(keyBase)

      const keyDiffMutant = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: origSha1,
        compiledSchemaSha256: schemaSha1,
        mutant: { ...mutant, replacement: MutantSourceText.make("true") },
        reachingTestHashes: reachingHashes1,
        digests: digests1,
      })
      expect(keyDiffMutant).not.toBe(keyBase)

      writeFileSync(
        testFile,
        'import { expect, it } from "vitest"\nit("ok", () => { expect(2).toBe(2) })\n',
      )
      const reachingHashes2 = unwrapOpt(hashReachingTestFiles(repoRoot, [testFile], testHostIo))
      const keyDiffTest = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: origSha1,
        compiledSchemaSha256: schemaSha1,
        mutant,
        reachingTestHashes: reachingHashes2,
        digests: digests1,
      })
      expect(keyDiffTest).not.toBe(keyBase)

      // .tsx file change invalidates workspaceSrcDigest
      writeFileSync(
        join(repoRoot, "libs", "shared", "service", "src", "view.tsx"),
        "export const V = 2\n",
      )
      const digestsTsx = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(digestsTsx.workspaceSrcDigest).not.toBe(digests1.workspaceSrcDigest)

      // Cross-package test helper change invalidates workspaceSrcDigest
      writeFileSync(join(helperDir, "test-host-io.ts"), "export const helper = 2\n")
      const digestsHelper = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(digestsHelper.workspaceSrcDigest).not.toBe(digestsTsx.workspaceSrcDigest)

      // tools/ change invalidates workspaceSrcDigest
      writeFileSync(join(repoRoot, "tools", "parallel-vitest-batch.mjs"), "// v2\n")
      const digestsTools = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(digestsTools.workspaceSrcDigest).not.toBe(digestsHelper.workspaceSrcDigest)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("runDomainMutationSuite caches killed mutants, updates lastAccessedAt on hit while keeping recordedAt immutable, runs 1 baseline call on full hit, skips Signaled/TimedOut caching, and honors disableMutantCache", () => {
    const src = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempRepo(
      src,
      'import { expect, it } from "vitest"\nimport { isSame } from "../src/logic.js"\nit("ok", () => { expect(isSame(1, 1)).toBe(true) })\n',
    )
    try {
      let baselineCalls = 0
      let mutantCalls = 0
      const notGit: SyncHostExecResult = {
        _tag: "Exited",
        exitCode: 128,
        stdout: "",
        stderr: "not a git repository",
      }
      const mockIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, opts) => {
          if (cmd === "git") return notGit
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            baselineCalls += 1
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          mutantCalls += 1
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/sample/domain/test/logic.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }

      const firstReport = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        hmacSecret: TEST_HMAC_SECRET,
      })
      expect(firstReport.passed).toBe(true)
      expect(firstReport.killedCount).toBeGreaterThan(0)
      expect(firstReport.cachedKilledCount).toBe(0)
      const callsAfterFirst = baselineCalls + mutantCalls
      expect(callsAfterFirst).toBeGreaterThan(0)

      const cacheAfterFirst = loadMutationCache(repoRoot, testHostIo, TEST_HMAC_SECRET)
      const firstEntry = Object.values(cacheAfterFirst.entries)[0]!
      const firstKey = firstEntry.key
      expect(firstEntry.lastAccessedAt).toBeUndefined()

      // Second run: all mutants cached -> 1 unmutated baseline call, 0 mutant calls, recordedAt immutable, lastAccessedAt updated
      baselineCalls = 0
      mutantCalls = 0
      const secondReport = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        hmacSecret: TEST_HMAC_SECRET,
      })
      expect(secondReport.passed).toBe(true)
      expect(secondReport.killedCount).toBe(firstReport.killedCount)
      expect(secondReport.cachedKilledCount).toBe(firstReport.killedCount)
      expect(baselineCalls).toBe(1)
      expect(mutantCalls).toBe(0)
      const cacheAfterSecond = loadMutationCache(repoRoot, testHostIo, TEST_HMAC_SECRET)
      expect(cacheAfterSecond.entries[firstKey]?.recordedAt).toBe(firstEntry.recordedAt)
      expect(cacheAfterSecond.entries[firstKey]?.lastAccessedAt).toBeDefined()
      expect(cacheAfterSecond.entries[firstKey]?.mac).toBe(firstEntry.mac)

      // disableMutantCache: true bypasses cache and runs Vitest again
      baselineCalls = 0
      mutantCalls = 0
      const bypassReport = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        disableMutantCache: true,
        hmacSecret: TEST_HMAC_SECRET,
      })
      expect(bypassReport.passed).toBe(true)
      expect(bypassReport.cachedKilledCount).toBe(0)
      expect(baselineCalls + mutantCalls).toBe(callsAfterFirst)

      // Signaled/TimedOut kills are reported as killed yet NEVER cached to disk
      rmSync(resolveHarnessStateDir(repoRoot), { recursive: true, force: true })
      const timeoutIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, opts) => {
          if (cmd === "git") return notGit
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return { _tag: "TimedOut", stdout: "", stderr: "" }
        },
      }
      const timeoutReport = runDomainMutationSuite(repoRoot, timeoutIo, {
        includeAllLines: true,
        hmacSecret: TEST_HMAC_SECRET,
      })
      expect(timeoutReport.passed).toBe(true)
      expect(timeoutReport.killedCount).toBeGreaterThan(0)
      expect(
        Object.keys(loadMutationCache(repoRoot, testHostIo, TEST_HMAC_SECRET).entries),
      ).toHaveLength(0)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("runVitestTargetList passes --bail=1 on active mutant runs and omits it on baseline", () => {
    const src = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, domainFile, testFile } = setupTempRepo(src)
    try {
      const mutants = discoverDomainMutants("libs/sample/domain/src/logic.ts", src)
      expect(mutants.length).toBeGreaterThan(0)
      const schemaBundle = compileMutantSchemaModule(
        "libs/sample/domain/src/logic.ts",
        src,
        mutants,
      )
      const recordedCalls: Array<{
        readonly isBaseline: boolean
        readonly args: ReadonlyArray<string>
      }> = []

      const spyIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args, opts) => {
          const isBaseline = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined
          recordedCalls.push({ isBaseline, args })
          if (isBaseline) {
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
        spyIo,
        {},
        [testFile],
        src,
        schemaBundle.schemaSource,
        join(repoRoot, ".harness", "mutation-backup.json"),
        mutants.slice(0, 1),
      )
      expect(res._tag).toBe("Ok")
      const baselineCall = recordedCalls.find((c) => c.isBaseline)
      const mutantCall = recordedCalls.find((c) => !c.isBaseline)
      expect(baselineCall).toBeDefined()
      expect(mutantCall).toBeDefined()
      expect(baselineCall?.args.includes("--bail=1")).toBe(false)
      expect(mutantCall?.args.includes("--bail=1")).toBe(true)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("tools/parallel-vitest-batch.mjs passes --bail=1, --maxWorkers=2, HARNESS_ACTIVE_MUTANT_ID, and strips HARNESS_BATCH_*", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "parallel-batch-test-"))
    try {
      const fakeVitest = join(tmpDir, "fake-vitest.mjs")
      const recordFile = join(tmpDir, "calls.jsonl")
      writeFileSync(
        fakeVitest,
        `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  activeMutant: process.env.HARNESS_ACTIVE_MUTANT_ID ?? null,
  hasBatchEnv: Object.keys(process.env).some((k) => k.startsWith("HARNESS_BATCH_")),
}) + "\\n");
process.stdout.write("FAIL  dummy.test.ts\\n");
process.exit(1);
`,
        "utf8",
      )
      const batchScript = fileURLToPath(
        new URL("../../../../tools/parallel-vitest-batch.mjs", import.meta.url),
      )
      const proc = spawnSync(process.execPath, [batchScript], {
        cwd: tmpDir,
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_BATCH_VITEST_CLI: fakeVitest,
          HARNESS_BATCH_CWD: tmpDir,
          HARNESS_BATCH_TIMEOUT_MS: "5000",
          HARNESS_BATCH_TESTS_JSON: JSON.stringify(["a.test.ts"]),
          HARNESS_BATCH_MUTANTS_JSON: JSON.stringify(["m-1", "m-2"]),
        },
      })
      expect(proc.status).toBe(0)
      const calls = readFileSync(recordFile, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { argv: string[]; activeMutant: string; hasBatchEnv: boolean },
        )
      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call.argv).toEqual(["run", "--bail=1", "--maxWorkers=2", "a.test.ts"])
        expect(["m-1", "m-2"]).toContain(call.activeMutant)
        expect(call.hasBatchEnv).toBe(false)
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("computeMutationContextDigests fails closed on unreadable src, nested subdir error, or symlink entry inside src", () => {
    const src = "export const isSame = (a: number, b: number) => a === b\n"
    const { repoRoot } = setupTempRepo(src)
    try {
      const srcDir = join(repoRoot, "libs", "sample", "domain", "src")
      const nestedDir = join(srcDir, "nested")
      mkdirSync(nestedDir, { recursive: true })
      writeFileSync(join(nestedDir, "leaf.ts"), "export const leaf = 1\n", "utf8")

      // Direct src readdir failure -> None
      const failSrcIo: SyncHostIo = {
        ...testHostIo,
        readdirSync: (dirPath) => {
          if (dirPath === srcDir) throw new Error("EACCES: src")
          return testHostIo.readdirSync(dirPath)
        },
      }
      expect(computeMutationContextDigests(repoRoot, failSrcIo)._tag).toBe("None")

      // Nested subdir readdir failure -> None
      const failNestedIo: SyncHostIo = {
        ...testHostIo,
        readdirSync: (dirPath) => {
          if (dirPath === nestedDir) throw new Error("EACCES: nested")
          return testHostIo.readdirSync(dirPath)
        },
      }
      expect(computeMutationContextDigests(repoRoot, failNestedIo)._tag).toBe("None")

      // Symlink file inside src -> None
      const outsideFile = join(repoRoot, "outside.ts")
      writeFileSync(outsideFile, "export const x = 1\n", "utf8")
      symlinkSync(outsideFile, join(nestedDir, "link.ts"))
      expect(computeMutationContextDigests(repoRoot, testHostIo)._tag).toBe("None")
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
