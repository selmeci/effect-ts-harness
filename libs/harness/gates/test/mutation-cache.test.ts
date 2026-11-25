import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Redacted, Schema } from "effect"
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
  PackageRelKey,
  SourceLineNumber,
  computeContentSha256,
} from "@harness/contract"
import { runWithTestTracer } from "@harness/ingest"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { runDomainMutationSuite } from "../src/mutation-check.js"
import {
  runVitestPackageBaseline,
  runVitestTargetList,
} from "../src/mutation-subprocess-helpers.js"
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
  computeFileMutationClosureDigest,
  computeMutantCacheKey,
  computeMutationContextDigests,
  computeMutationEntryMac,
  emptyMutationCacheStore,
  loadMutationCache,
  loadMutationCacheWithStatus,
  saveMutationCacheAtomic,
} from "../src/mutation/mutation-cache.js"
import { decideSpanBudgets, type SpanSample } from "../src/span-budget.js"
import { resolveHarnessStateDir } from "../src/worktree.js"
import { isolatedTestHostIo, testHostIo } from "./helpers/test-host-io.js"

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

const TEST_HMAC_SECRET = Redacted.make(
  MutationCacheHmacSecret.make("test-hmac-secret-0123456789abcdef0123456789"),
)
const TEST_CACHE_AUTH: MutationCacheAuth = {
  _tag: "Enabled",
  hmacSecret: TEST_HMAC_SECRET,
}

const DEFAULT_WITNESS_TEST = AstSourceFilePath.make("libs/sample/domain/test/logic.test.ts")
const DEFAULT_WITNESS_CLOSURE = computeContentSha256("sample-witness-closure")

const makeSignedEntry = (
  key: ContentSha256,
  mutantId: string,
  recordedAtStr = "2026-11-18T16:00:00.000Z",
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
    witnessTestFile,
    witnessClosureSha256,
    mac: computeMutationEntryMac(TEST_HMAC_SECRET, {
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
            auth: TEST_CACHE_AUTH,
            nowMs: MutationEpochMillis.make(Date.parse("2026-11-18T16:30:00.000Z")),
            reachingTests: [DEFAULT_WITNESS_TEST],
            witnessClosureDigests: { [DEFAULT_WITNESS_TEST]: DEFAULT_WITNESS_CLOSURE },
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
          auth: TEST_CACHE_AUTH,
          nowMs: MutationEpochMillis.make(Date.parse("2026-11-18T16:30:00.000Z")),
          reachingTests: [DEFAULT_WITNESS_TEST],
          witnessClosureDigests: { [DEFAULT_WITNESS_TEST]: DEFAULT_WITNESS_CLOSURE },
        })
        expect(decision.hitKeys).toEqual(expectedHits)
        expect(decision.missKeys).toEqual(expectedMisses)
        expect(decision.hitKeys.length + decision.missKeys.length).toBe(candidateKeys.length)
      }),
  )

  it("disk cache roundtrips, handles corrupt JSON/EACCES/symlinks, and bounds entries", () => {
    const { repoRoot } = setupTempRepo("export const isSame = (a: number, b: number) => a === b\n")
    try {
      expect(loadMutationCache(repoRoot, isolatedTestHostIo)).toEqual(emptyMutationCacheStore())

      const key1 = computeContentSha256("entry-1")
      const store1: MutationCacheStore = {
        version: MUTATION_CACHE_SCHEMA_VERSION,
        entries: {
          [key1]: makeSignedEntry(key1, "m1"),
        },
      }
      expect(
        saveMutationCacheAtomic(repoRoot, store1, isolatedTestHostIo, TEST_CACHE_AUTH),
      ).toEqual({
        _tag: "Saved",
      })
      expect(loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)).toEqual(store1)
      expect(loadMutationCacheWithStatus(repoRoot, isolatedTestHostIo)).toEqual({
        _tag: "Unsafe",
        reason: "missing HMAC secret",
      })
      const disabledAuth: MutationCacheAuth = {
        _tag: "Disabled",
        reason: ErrorReasonMessage.make("keychain locked"),
      }
      expect(loadMutationCacheWithStatus(repoRoot, isolatedTestHostIo, disabledAuth)).toEqual({
        _tag: "Unsafe",
        reason: "keychain locked",
      })
      expect(saveMutationCacheAtomic(repoRoot, store1, isolatedTestHostIo, disabledAuth)).toEqual({
        _tag: "Skipped",
        reason: "keychain locked",
      })
      expect(loadMutationCache(repoRoot, isolatedTestHostIo)).toEqual(emptyMutationCacheStore())

      const stateDir = resolveHarnessStateDir(repoRoot)
      const cacheDir = join(stateDir, "cache")
      const cacheFile = join(cacheDir, MUTATION_CACHE_FILENAME)

      // Corrupt JSON & schema-invalid JSON
      writeFileSync(cacheFile, "{not-valid-json", "utf8")
      expect(loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)).toEqual(
        emptyMutationCacheStore(),
      )
      writeFileSync(cacheFile, JSON.stringify({ version: "wrong-v", entries: {} }), "utf8")
      expect(loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)).toEqual(
        emptyMutationCacheStore(),
      )

      // EACCES fail-safe on load & save
      const eaccesIo: SyncHostIo = {
        ...isolatedTestHostIo,
        readTextSync: () => {
          throw new Error("EACCES: permission denied")
        },
        writeTextSync: () => {
          throw new Error("EACCES: permission denied")
        },
      }
      expect(loadMutationCache(repoRoot, eaccesIo, TEST_CACHE_AUTH)).toEqual(
        emptyMutationCacheStore(),
      )
      expect(saveMutationCacheAtomic(repoRoot, store1, eaccesIo, TEST_CACHE_AUTH)._tag).toBe(
        "Failed",
      )

      // Symlinked cacheFile fail-safe
      rmSync(cacheFile, { force: true })
      const outsideTarget = join(repoRoot, "outside.json")
      writeFileSync(outsideTarget, JSON.stringify(store1), "utf8")
      symlinkSync(outsideTarget, cacheFile)
      expect(loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)).toEqual(
        emptyMutationCacheStore(),
      )
      expect(
        saveMutationCacheAtomic(repoRoot, store1, isolatedTestHostIo, TEST_CACHE_AUTH)._tag,
      ).toBe("Skipped")
      expect(readFileSync(outsideTarget, "utf8")).toBe(JSON.stringify(store1))
      rmSync(cacheFile)

      // Symlinked stateDir must NOT call mkdirRecursiveSync
      const outsideDir = mkdtempSync(join(tmpdir(), "outside-state-"))
      try {
        rmSync(stateDir, { recursive: true, force: true })
        symlinkSync(outsideDir, stateDir)
        let mkdirCalled = false
        const spyMkdirIo: SyncHostIo = {
          ...isolatedTestHostIo,
          mkdirRecursiveSync: (dirPath, mode) => {
            mkdirCalled = true
            isolatedTestHostIo.mkdirRecursiveSync(dirPath, mode)
          },
        }
        expect(loadMutationCache(repoRoot, spyMkdirIo, TEST_CACHE_AUTH)).toEqual(
          emptyMutationCacheStore(),
        )
        saveMutationCacheAtomic(repoRoot, store1, spyMkdirIo, TEST_CACHE_AUTH)
        expect(mkdirCalled).toBe(false)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
        rmSync(stateDir, { recursive: true, force: true })
      }

      // Realpath escape outside stateDir fails closed even if lstat reports non-symlink
      saveMutationCacheAtomic(repoRoot, store1, isolatedTestHostIo, TEST_CACHE_AUTH)
      const escapeRealpathIo: SyncHostIo = {
        ...isolatedTestHostIo,
        realpathSync: (p) =>
          p === cacheFile ? "/outside/evil-cache.json" : isolatedTestHostIo.realpathSync(p),
      }
      expect(loadMutationCache(repoRoot, escapeRealpathIo, TEST_CACHE_AUTH)).toEqual(
        emptyMutationCacheStore(),
      )

      // External HARNESS_STATE_DIR stops ancestor check at resolved stateDir without walking above it
      const outsideBase = mkdtempSync(join(tmpdir(), "ext-state-base-"))
      const externalStateDir = join(outsideBase, "state")
      mkdirSync(externalStateDir, { recursive: true })
      const prevStateDirEnv = process.env["HARNESS_STATE_DIR"]
      try {
        process.env["HARNESS_STATE_DIR"] = externalStateDir
        saveMutationCacheAtomic(repoRoot, store1, testHostIo, TEST_CACHE_AUTH)
        const throwAboveStateIo: SyncHostIo = {
          ...testHostIo,
          existsSync: (p) => {
            if (p === outsideBase) throw new Error("parent outside stateDir should not be probed")
            return testHostIo.existsSync(p)
          },
        }
        expect(loadMutationCache(repoRoot, throwAboveStateIo, TEST_CACHE_AUTH)).toEqual(store1)
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
        ...isolatedTestHostIo,
        writeTextSync: (p, content) => {
          exactWrittenJson = content
          isolatedTestHostIo.writeTextSync(p, content)
        },
      }
      saveMutationCacheAtomic(
        repoRoot,
        { version: MUTATION_CACHE_SCHEMA_VERSION, entries: exactEntries },
        captureExactIo,
        TEST_CACHE_AUTH,
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
        isolatedTestHostIo,
        TEST_CACHE_AUTH,
      )
      const loadedBounded = loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
      expect(Object.keys(loadedBounded.entries).length).toBe(MAX_MUTATION_CACHE_ENTRIES)
      const oldestKey = computeContentSha256("many-0")
      const newestKey = computeContentSha256(`many-${MAX_MUTATION_CACHE_ENTRIES + 9}`)
      expect(loadedBounded.entries[oldestKey]).toBeUndefined()
      expect(loadedBounded.entries[newestKey]).toBeDefined()
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("computeMutantCacheKey & closureDigest invalidate on source, schema, mutant, reachingTest, and tools/ changes while isolating unrelated .tsx, helpers, and docs", () => {
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
      const keyBase = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: origSha1,
        compiledSchemaSha256: schemaSha1,
        mutant,
        digests: digests1,
      })

      const keyDiffSrc = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: computeContentSha256(`${src}// changed`),
        compiledSchemaSha256: schemaSha1,
        mutant,
        digests: digests1,
      })
      expect(keyDiffSrc).not.toBe(keyBase)

      const keyDiffSchema = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: origSha1,
        compiledSchemaSha256: computeContentSha256("schema-v2"),
        mutant,
        digests: digests1,
      })
      expect(keyDiffSchema).not.toBe(keyBase)

      const keyDiffMutant = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: origSha1,
        compiledSchemaSha256: schemaSha1,
        mutant: { ...mutant, replacement: MutantSourceText.make("true") },
        digests: digests1,
      })
      expect(keyDiffMutant).not.toBe(keyBase)

      const getClosure = (d: typeof digests1) =>
        match(
          computeFileMutationClosureDigest({
            repoRoot,
            relFile,
            allReachingTests: [testFile],
            digests: d,
            hostIo: testHostIo,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok closure: ${reason}`)
          })
          .exhaustive()

      const closureBeforeTest = getClosure(digests1)
      writeFileSync(
        testFile,
        'import { expect, it } from "vitest"\nit("ok", () => { expect(2).toBe(2) })\n',
      )
      const digests2 = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      const closure1 = getClosure(digests2)
      expect(closure1.closureDigest).not.toBe(closureBeforeTest.closureDigest)
      expect(closure1.usedFallbackAllLibs).toBe(false)
      const keyClosureBase = computeMutantCacheKey({
        pkgKey,
        relFile,
        originalContentSha256: origSha1,
        compiledSchemaSha256: schemaSha1,
        mutant,
        digests: digests2,
      })

      // Unrelated .tsx file change keeps closureDigest & computeMutantCacheKey IDENTICAL
      writeFileSync(
        join(repoRoot, "libs", "shared", "service", "src", "view.tsx"),
        "export const V = 2\n",
      )
      const digestsTsx = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      const closureTsx = getClosure(digestsTsx)
      expect(closureTsx.closureDigest).toBe(closure1.closureDigest)
      expect(
        computeMutantCacheKey({
          pkgKey,
          relFile,
          originalContentSha256: origSha1,
          compiledSchemaSha256: schemaSha1,
          mutant,
          digests: digestsTsx,
        }),
      ).toBe(keyClosureBase)

      // Unrelated cross-package test helper change keeps closureDigest IDENTICAL
      writeFileSync(join(helperDir, "test-host-io.ts"), "export const helper = 2\n")
      const digestsHelper = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(getClosure(digestsHelper).closureDigest).toBe(closure1.closureDigest)

      // Unreferenced docs/specs change keeps closureDigest IDENTICAL
      mkdirSync(join(repoRoot, "docs", "specs"), { recursive: true })
      writeFileSync(join(repoRoot, "docs", "specs", "s1.md"), "# spec v1\n")
      const digestsSpec1 = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(getClosure(digestsSpec1).closureDigest).toBe(closure1.closureDigest)
      writeFileSync(join(repoRoot, "docs", "specs", "s1.md"), "# spec v2\n")
      const digestsSpec2 = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(getClosure(digestsSpec2).closureDigest).toBe(closure1.closureDigest)

      // tools/parallel-vitest-batch.mjs (rootRuntimeDigest) change DOES invalidate closureDigest & witness lookup
      writeFileSync(join(repoRoot, "tools", "parallel-vitest-batch.mjs"), "// v2\n")
      const digestsTools = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      const closureTools = getClosure(digestsTools)
      expect(closureTools.closureDigest).not.toBe(closure1.closureDigest)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("runDomainMutationSuite caches killed mutants, updates lastAccessedAt, aborts TimedOut, and honors disableMutantCache", () => {
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
        ...isolatedTestHostIo,
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

      const t1 = MutationEpochMillis.make(Date.parse("2026-11-18T16:00:00.000Z"))
      const firstReport = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: t1,
      })
      expect(firstReport.passed).toBe(true)
      expect(firstReport.killedCount).toBeGreaterThan(0)
      expect(firstReport.cachedKilledCount).toBe(0)
      const callsAfterFirst = baselineCalls + mutantCalls
      expect(callsAfterFirst).toBeGreaterThan(0)

      const cacheAfterFirst = loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
      const firstEntry = Object.values(cacheAfterFirst.entries)[0]!
      const firstKey = firstEntry.key
      expect(firstEntry.lastAccessedAt).toBeUndefined()

      // Second run: all mutants cached -> 1 unmutated baseline call, 0 mutant calls, recordedAt immutable, lastAccessedAt updated
      baselineCalls = 0
      mutantCalls = 0
      const t2 = MutationEpochMillis.make(Date.parse("2026-11-18T16:05:00.000Z"))
      const secondReport = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: t2,
      })
      expect(secondReport.passed).toBe(true)
      expect(secondReport.killedCount).toBe(firstReport.killedCount)
      expect(secondReport.cachedKilledCount).toBe(firstReport.killedCount)
      expect(baselineCalls).toBe(1)
      expect(mutantCalls).toBe(0)
      const cacheAfterSecond = loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
      expect(cacheAfterSecond.entries[firstKey]?.recordedAt).toBe(firstEntry.recordedAt)
      expect(cacheAfterSecond.entries[firstKey]?.lastAccessedAt).toBe("2026-11-18T16:05:00.000Z")
      expect(cacheAfterSecond.entries[firstKey]?.mac).toBe(firstEntry.mac)

      // disableMutantCache: true bypasses cache and runs Vitest again
      baselineCalls = 0
      mutantCalls = 0
      const bypassReport = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        disableMutantCache: true,
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: t2,
      })
      expect(bypassReport.passed).toBe(true)
      expect(bypassReport.cachedKilledCount).toBe(0)
      expect(baselineCalls + mutantCalls).toBe(callsAfterFirst)

      // TimedOut aborts fail-closed and NEVER caches kills to disk
      rmSync(resolveHarnessStateDir(repoRoot), { recursive: true, force: true })
      const timeoutIo: SyncHostIo = {
        ...isolatedTestHostIo,
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
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: t2,
      })
      expect(timeoutReport.passed).toBe(false)
      expect(timeoutReport.killedCount).toBe(0)
      expect(timeoutReport.diagnostic).toContain("timed out")
      expect(
        Object.keys(loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH).entries),
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

  it("tools/parallel-vitest-batch.mjs passes --bail=1, --maxWorkers=1, HARNESS_ACTIVE_MUTANT_ID, and strips HARNESS_BATCH_*", () => {
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
        expect(call.argv).toEqual(["run", "--bail=1", "--maxWorkers=1", "a.test.ts"])
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

  it("computeFileMutationClosureDigest tracks transitive relative & @harness/* imports, referenced asset buckets, and dynamic-import fallback", () => {
    const src =
      'import { helper } from "./dep.js"\nimport { x } from "@harness/contract"\nexport const f = () => helper() + x\n'
    const { repoRoot } = setupTempRepo(
      src,
      'import { expect, it } from "vitest"\nimport { f } from "../src/logic.js"\nit("ok", () => { expect(f()).toBe(2) })\n',
    )
    try {
      const srcDir = join(repoRoot, "libs", "sample", "domain", "src")
      writeFileSync(join(srcDir, "dep.ts"), "export const helper = () => 1\n")
      const contractDir = join(repoRoot, "libs", "harness", "contract")
      mkdirSync(join(contractDir, "src"), { recursive: true })
      writeFileSync(
        join(contractDir, "package.json"),
        '{"name":"@harness/contract","exports":{".":"./src/index.ts"}}\n',
      )
      writeFileSync(join(contractDir, "src", "index.ts"), "export const x = 1\n")
      mkdirSync(join(repoRoot, "libs", "unrelated", "core", "src"), { recursive: true })
      writeFileSync(
        join(repoRoot, "libs", "unrelated", "core", "src", "other.ts"),
        "export const u = 1\n",
      )
      mkdirSync(join(repoRoot, "docs", "specs"), { recursive: true })
      writeFileSync(join(repoRoot, "docs", "specs", "s1.md"), "# s1\n")

      const getClosure = (rel: string) => {
        const d = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
        return match(
          computeFileMutationClosureDigest({
            repoRoot,
            relFile: rel,
            allReachingTests: ["libs/sample/domain/test/logic.test.ts"],
            digests: d,
            hostIo: testHostIo,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok: ${reason}`)
          })
          .exhaustive()
      }

      const c0 = getClosure("libs/sample/domain/src/logic.ts")
      expect(c0.usedFallbackAllLibs).toBe(false)
      expect(c0.resolvedFiles).toContain("libs/sample/domain/src/dep.ts")
      expect(c0.resolvedFiles).toContain("libs/harness/contract/src/index.ts")

      // Transitive relative import change invalidates
      writeFileSync(join(srcDir, "dep.ts"), "export const helper = () => 2\n")
      const cDep = getClosure("libs/sample/domain/src/logic.ts")
      expect(cDep.closureDigest).not.toBe(c0.closureDigest)

      // Transitive @harness/contract import change invalidates
      writeFileSync(join(contractDir, "src", "index.ts"), "export const x = 2\n")
      const cContract = getClosure("libs/sample/domain/src/logic.ts")
      expect(cContract.closureDigest).not.toBe(cDep.closureDigest)

      // Referenced docs/ bucket invalidates when "docs/" is in closure
      writeFileSync(
        join(srcDir, "dep.ts"),
        'export const p = "docs/specs/s1.md"\nexport const helper = () => 2\n',
      )
      const cDocs1 = getClosure("libs/sample/domain/src/logic.ts")
      writeFileSync(join(repoRoot, "docs", "specs", "s1.md"), "# s1 v2\n")
      const cDocs2 = getClosure("libs/sample/domain/src/logic.ts")
      expect(cDocs2.closureDigest).not.toBe(cDocs1.closureDigest)

      // Non-literal dynamic import triggers usedFallbackAllLibs and invalidates on unrelated libs/ change
      writeFileSync(
        join(srcDir, "dep.ts"),
        "export const load = (m: string) => import(m)\nexport const helper = () => 2\n",
      )
      const cDyn1 = getClosure("libs/sample/domain/src/logic.ts")
      expect(cDyn1.usedFallbackAllLibs).toBe(true)
      writeFileSync(
        join(repoRoot, "libs", "unrelated", "core", "src", "other.ts"),
        "export const u = 2\n",
      )
      const cDyn2 = getClosure("libs/sample/domain/src/logic.ts")
      expect(cDyn2.closureDigest).not.toBe(cDyn1.closureDigest)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it.effect.prop(
    "REQ-1.1 property: full closure -> key -> MutationCache.decide preserves hits on unrelated edits and misses on dependency or dynamic-fallback edits",
    {
      unrelatedToken: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,12}$/)),
      depToken: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,12}$/)),
      useDynamicFallback: Schema.Boolean,
    },
    ({ unrelatedToken, depToken, useDynamicFallback }) =>
      Effect.gen(function* () {
        const src = 'import { depVal } from "./dep.js"\nexport const val = () => depVal\n'
        const { repoRoot } = setupTempRepo(src)
        try {
          const srcDir = join(repoRoot, "libs", "sample", "domain", "src")
          writeFileSync(
            join(srcDir, "dep.ts"),
            useDynamicFallback
              ? 'export const load = (m: string) => import(m)\nexport const depVal = "init"\n'
              : 'export const depVal = "init"\n',
          )
          const otherDir = join(repoRoot, "libs", "other", "core", "src")
          mkdirSync(otherDir, { recursive: true })
          writeFileSync(join(otherDir, "other.ts"), 'export const o = "init"\n')

          const relFile = AstSourceFilePath.make("libs/sample/domain/src/logic.ts")
          const testFile = AstSourceFilePath.make("libs/sample/domain/test/logic.test.ts")
          const pkgKey = PackageRelKey.make("sample/domain")
          const origSha = computeContentSha256(src)
          const schemaSha = computeContentSha256("schema")
          const mutant = {
            id: MutantId.make("m-prop"),
            file: relFile,
            line: SourceLineNumber.make(1),
            category: "boolean-return" as const,
            original: MutantSourceText.make("true"),
            replacement: MutantSourceText.make("false"),
            mutatedSource: MutantSourceText.make(src),
          }

          const computeKey = () => {
            const d = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
            const closure = match(
              computeFileMutationClosureDigest({
                repoRoot,
                relFile,
                allReachingTests: [testFile],
                digests: d,
                hostIo: testHostIo,
              }),
            )
              .with({ _tag: "Ok" }, (ok) => ok)
              .with({ _tag: "Disabled" }, ({ reason }) => {
                throw new Error(`Expected Ok: ${reason}`)
              })
              .exhaustive()
            return {
              closure,
              key: computeMutantCacheKey({
                pkgKey,
                relFile,
                originalContentSha256: origSha,
                compiledSchemaSha256: schemaSha,
                mutant,
                digests: d,
              }),
            }
          }

          const base = computeKey()
          const recordedAt = MutationCacheTimestamp.make(new Date().toISOString())
          const mutantCacheId = MutantCacheId.make(mutant.id)
          const store = {
            version: MUTATION_CACHE_SCHEMA_VERSION,
            entries: {
              [base.key]: {
                key: base.key,
                file: relFile,
                mutantId: mutantCacheId,
                status: "killed" as const,
                recordedAt,
                witnessTestFile: testFile,
                witnessClosureSha256: base.closure.closureDigest,
                mac: computeMutationEntryMac(TEST_HMAC_SECRET, {
                  key: base.key,
                  file: relFile,
                  mutantId: mutantCacheId,
                  status: "killed",
                  recordedAt,
                  witnessTestFile: testFile,
                  witnessClosureSha256: base.closure.closureDigest,
                }),
              },
            },
          }

          const nowMs = MutationEpochMillis.make(Date.now())
          writeFileSync(join(otherDir, "other.ts"), `export const o = "${unrelatedToken}-mut"\n`)
          const afterUnrelated = computeKey()
          const unrelatedDecision = yield* MutationCache.decide({
            candidateKeys: [afterUnrelated.key],
            store,
            auth: TEST_CACHE_AUTH,
            nowMs,
            reachingTests: [testFile],
            witnessClosureDigests: { [testFile]: afterUnrelated.closure.closureDigest },
          })
          if (useDynamicFallback) {
            expect(afterUnrelated.closure.usedFallbackAllLibs).toBe(true)
            expect(unrelatedDecision.missKeys).toEqual([afterUnrelated.key])
          } else {
            expect(afterUnrelated.closure.usedFallbackAllLibs).toBe(false)
            expect(afterUnrelated.key).toBe(base.key)
            expect(unrelatedDecision.hitKeys).toEqual([base.key])
          }

          writeFileSync(join(srcDir, "dep.ts"), `export const depVal = "${depToken}-mut"\n`)
          const afterDep = computeKey()
          const depDecision = yield* MutationCache.decide({
            candidateKeys: [afterDep.key],
            store,
            auth: TEST_CACHE_AUTH,
            nowMs,
            reachingTests: [testFile],
            witnessClosureDigests: { [testFile]: afterDep.closure.closureDigest },
          })
          expect(afterDep.closure.closureDigest).not.toBe(base.closure.closureDigest)
          expect(depDecision.missKeys).toEqual([afterDep.key])
        } finally {
          rmSync(repoRoot, { recursive: true, force: true })
        }
      }),
  )

  it("REQ-1.1 survivor coverage: dynamic quotes, exports, assets, and runtimeVersion", () => {
    const src = [
      'import "./side.js"',
      'import { rootFn } from "@sample/custom"',
      'import { subFn } from "@sample/custom/sub"',
      'import { brokenFn } from "@sample/corrupt"',
      'import { noPkgRoot } from "@sample/nopkg"',
      'import { noPkgLeaf } from "@sample/nopkg/leaf"',
      "export const loadAll = async () => {",
      '  await import("./double.js")',
      "  await import('./single.js')",
      "  await import(`./backtick.js`)",
      "  return rootFn() + subFn() + brokenFn() + noPkgRoot() + noPkgLeaf()",
      "}",
    ].join("\n")
    const { repoRoot } = setupTempRepo(src)
    try {
      const srcDir = join(repoRoot, "libs", "sample", "domain", "src")
      writeFileSync(join(srcDir, "side.ts"), "export const side = 1\n")
      writeFileSync(join(srcDir, "double.ts"), "export const d = 1\n")
      writeFileSync(join(srcDir, "single.ts"), "export const s = 1\n")
      writeFileSync(join(srcDir, "backtick.ts"), "export const b = 1\n")
      writeFileSync(
        join(repoRoot, "libs", "sample", "domain", "schema.pg"),
        "CREATE TABLE t(id int);\n",
      )

      // @sample/custom with package.json exports and NO src/index.ts or src/sub.ts
      const customDir = join(repoRoot, "libs", "sample", "custom")
      mkdirSync(join(customDir, "src", "nested"), { recursive: true })
      writeFileSync(
        join(customDir, "package.json"),
        JSON.stringify({
          name: "@sample/custom",
          exports: {
            ".": "./src/custom-root.ts",
            "./sub": { import: "./src/nested/sub-entry.ts" },
          },
        }),
      )
      writeFileSync(join(customDir, "src", "custom-root.ts"), "export const rootFn = () => 1\n")
      writeFileSync(
        join(customDir, "src", "nested", "sub-entry.ts"),
        "export const subFn = () => 1\n",
      )

      // @sample/corrupt with invalid JSON package.json falling back to src/index.ts
      const corruptDir = join(repoRoot, "libs", "sample", "corrupt")
      mkdirSync(join(corruptDir, "src"), { recursive: true })
      writeFileSync(join(corruptDir, "package.json"), "{not-valid-json")
      writeFileSync(join(corruptDir, "src", "index.ts"), "export const brokenFn = () => 1\n")

      // @sample/nopkg with NO package.json at all
      const noPkgDir = join(repoRoot, "libs", "sample", "nopkg")
      mkdirSync(join(noPkgDir, "src"), { recursive: true })
      writeFileSync(join(noPkgDir, "src", "index.ts"), "export const noPkgRoot = () => 1\n")
      writeFileSync(join(noPkgDir, "src", "leaf.ts"), "export const noPkgLeaf = () => 1\n")

      // Unrelated package for non-TS asset isolation check
      const otherDir = join(repoRoot, "libs", "other", "core", "src")
      const otherTestDir = join(repoRoot, "libs", "other", "core", "test")
      mkdirSync(otherDir, { recursive: true })
      mkdirSync(otherTestDir, { recursive: true })
      writeFileSync(join(otherDir, "other.ts"), "export const o = 1\n")
      writeFileSync(join(otherTestDir, "other.test.ts"), 'import { o } from "../src/other.js"\n')

      // Vitest package.json for runtimeVersion extraTag check
      mkdirSync(join(repoRoot, "node_modules", "vitest"), { recursive: true })
      writeFileSync(
        join(repoRoot, "node_modules", "vitest", "package.json"),
        '{"name":"vitest","version":"5.0.0"}\n',
      )

      const d0 = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      const getClosure = (rel: string, tests: ReadonlyArray<string>, digests = d0) =>
        match(
          computeFileMutationClosureDigest({
            repoRoot,
            relFile: rel,
            allReachingTests: tests,
            digests,
            hostIo: testHostIo,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok: ${reason}`)
          })
          .exhaustive()

      const c0 = getClosure("libs/sample/domain/src/logic.ts", [
        "libs/sample/domain/test/logic.test.ts",
      ])
      expect(c0.usedFallbackAllLibs).toBe(false)
      expect(c0.resolvedFiles).toContain("libs/sample/domain/src/side.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/domain/src/double.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/domain/src/single.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/domain/src/backtick.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/custom/src/custom-root.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/custom/src/nested/sub-entry.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/corrupt/src/index.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/nopkg/src/index.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/nopkg/src/leaf.ts")

      // Empty fileDigests still resolves via disk existence
      const cEmptyDigests = getClosure(
        "libs/sample/domain/src/logic.ts",
        ["libs/sample/domain/test/logic.test.ts"],
        { ...d0, fileDigests: new Map() },
      )
      expect(cEmptyDigests.resolvedFiles).toContain("libs/sample/domain/src/double.ts")
      expect(cEmptyDigests.closureDigest).toBe(c0.closureDigest)

      // Side-effect import change invalidates closureDigest
      writeFileSync(join(srcDir, "side.ts"), "export const side = 2\n")
      const dSide = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(
        getClosure(
          "libs/sample/domain/src/logic.ts",
          ["libs/sample/domain/test/logic.test.ts"],
          dSide,
        ).closureDigest,
      ).not.toBe(c0.closureDigest)

      // Non-TS asset in sample/domain invalidates sample/domain closure but NOT other/core closure
      const cOtherBefore = getClosure(
        "libs/other/core/src/other.ts",
        ["libs/other/core/test/other.test.ts"],
        dSide,
      )
      writeFileSync(
        join(repoRoot, "libs", "sample", "domain", "schema.pg"),
        "CREATE TABLE t(id text);\n",
      )
      const dAsset = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(
        getClosure(
          "libs/sample/domain/src/logic.ts",
          ["libs/sample/domain/test/logic.test.ts"],
          dAsset,
        ).closureDigest,
      ).not.toBe(
        getClosure(
          "libs/sample/domain/src/logic.ts",
          ["libs/sample/domain/test/logic.test.ts"],
          dSide,
        ).closureDigest,
      )
      expect(
        getClosure("libs/other/core/src/other.ts", ["libs/other/core/test/other.test.ts"], dAsset)
          .closureDigest,
      ).toBe(cOtherBefore.closureDigest)

      // Template-literal dynamic import with interpolation triggers fallback
      writeFileSync(
        join(srcDir, "side.ts"),
        "export const load = (x: string) => import(`./${x}.js`)\n",
      )
      const dInterp = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(
        getClosure(
          "libs/sample/domain/src/logic.ts",
          ["libs/sample/domain/test/logic.test.ts"],
          dInterp,
        ).usedFallbackAllLibs,
      ).toBe(true)

      // Mutating vitest version changes rootRuntimeDigest (extraTag binding)
      writeFileSync(
        join(repoRoot, "node_modules", "vitest", "package.json"),
        '{"name":"vitest","version":"5.1.0"}\n',
      )
      const dVitest = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(dVitest.rootRuntimeDigest).not.toBe(dInterp.rootRuntimeDigest)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-1.1 AST & workspace resolution: tsconfig paths, exports, require, and fallback", () => {
    const src = [
      'import { sc } from "@harness/sample-contract"',
      'import { wc } from "@sample/wild/foo"',
      'const commentLike = "/* not a comment */"',
      'const req = require("./req-dep.js")',
      "export const run = () => sc() + wc() + commentLike.length + req",
    ].join("\n")
    const { repoRoot } = setupTempRepo(src)
    try {
      const srcDir = join(repoRoot, "libs", "sample", "domain", "src")
      writeFileSync(join(srcDir, "req-dep.ts"), "export const reqDep = 1\n")

      // Package with name "@harness/sample-contract" located at libs/sample/contract + nested dist export
      const scDir = join(repoRoot, "libs", "sample", "contract")
      mkdirSync(join(scDir, "src"), { recursive: true })
      writeFileSync(
        join(scDir, "package.json"),
        JSON.stringify({
          name: "@harness/sample-contract",
          exports: { ".": { import: { default: "./dist/entry.js" } } },
        }),
      )
      writeFileSync(join(scDir, "src", "entry.ts"), "export const sc = () => 1\n")

      // Package with wildcard "./*" export
      const wildDir = join(repoRoot, "libs", "sample", "wild")
      mkdirSync(join(wildDir, "src", "items"), { recursive: true })
      writeFileSync(
        join(wildDir, "package.json"),
        JSON.stringify({ name: "@sample/wild", exports: { "./*": "./src/items/*.ts" } }),
      )
      writeFileSync(join(wildDir, "src", "items", "foo.ts"), "export const wc = () => 1\n")

      // All 5 asset buckets
      mkdirSync(join(repoRoot, "agent-patterns"), { recursive: true })
      writeFileSync(join(repoRoot, "agent-patterns", "p.md"), "# p1\n")
      mkdirSync(join(repoRoot, "adapters"), { recursive: true })
      writeFileSync(join(repoRoot, "adapters", "a.txt"), "a1\n")
      mkdirSync(join(repoRoot, "tools"), { recursive: true })
      writeFileSync(join(repoRoot, "tools", "helper.ts"), "export const t = 1\n")
      mkdirSync(join(repoRoot, "apps", "sample", "src"), { recursive: true })
      writeFileSync(join(repoRoot, "apps", "sample", "src", "helper.ts"), "export const app = 1\n")
      mkdirSync(join(repoRoot, "docs", "specs"), { recursive: true })
      writeFileSync(join(repoRoot, "docs", "specs", "s1.md"), "# s1\n")

      const getClosure = () => {
        const d = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
        return match(
          computeFileMutationClosureDigest({
            repoRoot,
            relFile: "libs/sample/domain/src/logic.ts",
            allReachingTests: ["libs/sample/domain/test/logic.test.ts"],
            digests: d,
            hostIo: testHostIo,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok: ${reason}`)
          })
          .exhaustive()
      }

      const c0 = getClosure()
      expect(c0.usedFallbackAllLibs).toBe(false)
      expect(c0.resolvedFiles).toContain("libs/sample/contract/src/entry.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/wild/src/items/foo.ts")
      expect(c0.resolvedFiles).toContain("libs/sample/domain/src/req-dep.ts")

      // Verify each of the 5 asset buckets invalidates when referenced via join/path
      const bucketCases: ReadonlyArray<readonly [string, string, string]> = [
        ['join(r, "docs", "specs")', join(repoRoot, "docs", "specs", "s1.md"), "# s2\n"],
        ['join(r, "agent-patterns")', join(repoRoot, "agent-patterns", "p.md"), "# p2\n"],
        ['join(r, "adapters")', join(repoRoot, "adapters", "a.txt"), "a2\n"],
        [
          'join(r, "tools", "helper.ts")',
          join(repoRoot, "tools", "helper.ts"),
          "export const t = 2\n",
        ],
        [
          'join(r, "apps", "sample")',
          join(repoRoot, "apps", "sample", "src", "helper.ts"),
          "export const app = 2\n",
        ],
      ]
      for (const [refExpr, assetPath, nextContent] of bucketCases) {
        writeFileSync(join(srcDir, "req-dep.ts"), `export const ref = ${refExpr}\n`)
        const before = getClosure()
        writeFileSync(assetPath, nextContent)
        const after = getClosure()
        expect(after.closureDigest).not.toBe(before.closureDigest)
      }

      // Unresolved @harness/* package sets usedFallbackAllLibs = true
      writeFileSync(
        join(srcDir, "req-dep.ts"),
        'import { missing } from "@harness/missing"\nexport const x = missing\n',
      )
      expect(getClosure().usedFallbackAllLibs).toBe(true)

      // vi.importActual(nonLiteral) sets usedFallbackAllLibs = true
      writeFileSync(
        join(srcDir, "req-dep.ts"),
        "export const f = (vi: any, p: string) => vi.importActual(p)\n",
      )
      expect(getClosure().usedFallbackAllLibs).toBe(true)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("runVitestPackageBaseline passes --bail=1 for direct vitest and pnpm fallback runners", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pkg-baseline-bail-"))
    try {
      const vitestMjs = join(tmpDir, "node_modules", "vitest", "vitest.mjs")
      const captured: Array<{ readonly cmd: string; readonly args: ReadonlyArray<string> }> = []
      const makeSpyIo = (hasVitestMjs: boolean): SyncHostIo => ({
        ...testHostIo,
        existsSync: (p) => (p === vitestMjs ? hasVitestMjs : testHostIo.existsSync(p)),
        execFileSync: (cmd, args) => {
          captured.push({ cmd, args })
          return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
        },
      })

      const directRes = runVitestPackageBaseline(
        tmpDir,
        "sample:domain",
        ["a.test.ts"],
        makeSpyIo(true),
        {},
      )
      expect(directRes._tag).toBe("Ok")
      expect(captured[0]?.args).toContain("--bail=1")
      expect(captured[0]?.args).toContain("--maxWorkers=2")

      const pnpmRes = runVitestPackageBaseline(
        tmpDir,
        "sample:domain",
        ["a.test.ts"],
        makeSpyIo(false),
        {},
      )
      expect(pnpmRes._tag).toBe("Ok")
      expect(captured[1]?.cmd).toBe("pnpm")
      expect(captured[1]?.args).toEqual(["vitest", "run", "--bail=1", "a.test.ts"])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("REQ-1.1 closure isolation: fixture 'libs/' strings without fs/hostIo do not trigger allLibsSrcDigest fallback", () => {
    const { repoRoot } = setupTempRepo("export const x = 1\n")
    try {
      const otherDir = join(repoRoot, "libs", "other", "core", "src")
      mkdirSync(otherDir, { recursive: true })
      writeFileSync(join(otherDir, "dep.ts"), "export const v = 1\n")
      const dir = join(repoRoot, "libs", "sample", "domain", "src")
      writeFileSync(
        join(dir, "fixture-str.ts"),
        'export const pathHint = "libs/demo/core/src/a.ts"\n',
      )
      writeFileSync(
        join(dir, "fs-no-libs.ts"),
        'import { readFileSync } from "node:fs"\nexport const f = () => readFileSync("foo.txt", "utf8")\n',
      )
      writeFileSync(
        join(dir, "fs-with-libs.ts"),
        'import { readFileSync } from "node:fs"\nexport const f = () => readFileSync("libs/other/core/src/dep.ts", "utf8")\n',
      )

      const d0 = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      const getC = (relFile: string, d = d0) =>
        match(
          computeFileMutationClosureDigest({
            repoRoot,
            relFile,
            allReachingTests: [],
            digests: d,
            hostIo: testHostIo,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok: ${reason}`)
          })
          .exhaustive()

      const cFixtureBefore = getC("libs/sample/domain/src/fixture-str.ts")
      const cFsNoLibs = getC("libs/sample/domain/src/fs-no-libs.ts")
      const cFsWithLibsBefore = getC("libs/sample/domain/src/fs-with-libs.ts")
      expect(cFixtureBefore.usedFallbackAllLibs).toBe(false)
      expect(cFsNoLibs.usedFallbackAllLibs).toBe(false)
      expect(cFsWithLibsBefore.usedFallbackAllLibs).toBe(true)

      writeFileSync(join(otherDir, "dep.ts"), "export const v = 2\n")
      const d1 = unwrapOpt(computeMutationContextDigests(repoRoot, testHostIo))
      expect(getC("libs/sample/domain/src/fixture-str.ts", d1).closureDigest).toBe(
        cFixtureBefore.closureDigest,
      )
      expect(getC("libs/sample/domain/src/fs-with-libs.ts", d1).closureDigest).not.toBe(
        cFsWithLibsBefore.closureDigest,
      )
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
