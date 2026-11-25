import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Redacted, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  type ContentSha256,
  MUTATION_CACHE_FILENAME,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  type MutationCacheAuth,
  type MutationCacheEntry,
  MutationCacheHmacSecret,
  MutationCacheMac,
  type MutationCacheStore,
  MutationCacheTimestamp,
  MutationEpochMillis,
  PackageRelKey,
  computeContentSha256,
} from "@harness/contract"
import { runWithTestTracer } from "@harness/ingest"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { runDomainMutationSuite } from "../src/mutation-check.js"
import {
  compileMutantSchemaModule,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import {
  MAX_MUTATION_CACHE_AGE_MS,
  MutationCache,
  computeFileMutationClosureDigest,
  computeMutantCacheKey,
  computeMutationContextDigests,
  computeMutationEntryMac,
  loadMutationCache,
  loadMutationCacheWithStatus,
  saveMutationCacheAtomic,
  validateHarnessCacheFileSafety,
  verifyMutationEntryMac,
} from "../src/mutation/mutation-cache.js"
import { extractWitnessTestFileFromOutput } from "../src/mutation/mutation-witness.js"
import { hydrateFileMutantCacheHits } from "../src/mutation/mutation-suite-helpers.js"
import { decideSpanBudgets, type SpanSample } from "../src/span-budget.js"
import { resolveHarnessStateDir } from "../src/worktree.js"
import { isolatedTestHostIo } from "./helpers/test-host-io.js"

const TEST_HMAC_SECRET = Redacted.make(
  MutationCacheHmacSecret.make("witness-test-hmac-secret-0123456789abcdef"),
)
const TEST_CACHE_AUTH: MutationCacheAuth = {
  _tag: "Enabled",
  hmacSecret: TEST_HMAC_SECRET,
}

const WITNESS_TEST_A = AstSourceFilePath.make("libs/sample/domain/test/logic.test.ts")
const WITNESS_TEST_B = AstSourceFilePath.make("libs/sample/domain/test/other.test.ts")
const CLOSURE_A = computeContentSha256("witness-closure-a")
const CLOSURE_B = computeContentSha256("witness-closure-b")
const BASE_NOW_MS = MutationEpochMillis.make(Date.parse("2026-11-25T10:00:00.000Z"))
const RECORDED_AT = MutationCacheTimestamp.make("2026-11-25T09:30:00.000Z")

const makeSignedEntry = (
  key: ContentSha256,
  mutantId: string,
  opts?: {
    readonly witnessTestFile?: AstSourceFilePath
    readonly witnessClosureSha256?: ContentSha256
    readonly recordedAt?: MutationCacheTimestamp
  },
): MutationCacheEntry => {
  const file = AstSourceFilePath.make("libs/sample/domain/src/logic.ts")
  const mId = MutantCacheId.make(mutantId)
  const recordedAt = opts?.recordedAt ?? RECORDED_AT
  const witnessTestFile = opts?.witnessTestFile ?? WITNESS_TEST_A
  const witnessClosureSha256 = opts?.witnessClosureSha256 ?? CLOSURE_A
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

const writeFileMkdir = (filePath: string, content: string): void => {
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

const setupWitnessTempRepo = (): string => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mutation-witness-cache-"))
  writeFileMkdir(join(repoRoot, "tsconfig.base.json"), '{"compilerOptions":{}}\n')
  writeFileMkdir(
    join(repoRoot, "node_modules", "vitest", "package.json"),
    '{"name":"vitest","version":"5.0.0"}\n',
  )
  writeFileMkdir(join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "// vitest\n")
  writeFileMkdir(
    join(repoRoot, "libs", "sample", "domain", "package.json"),
    '{"name":"@sample/domain","nx":{"tags":["type:domain"]}}\n',
  )
  writeFileMkdir(
    join(repoRoot, "libs", "es", "infra", "package.json"),
    '{"name":"@es/infra","nx":{"tags":["type:infra"]}}\n',
  )
  writeFileMkdir(
    join(repoRoot, "libs", "es", "infra", "src", "memory.ts"),
    "export const mem = () => 1\n",
  )
  return repoRoot
}

const NOT_GIT_RESULT: SyncHostExecResult = {
  _tag: "Exited",
  exitCode: 128,
  stdout: "",
  stderr: "not a git repository",
}

describe("SPEC-0034 Area 1: Witness-Scoped Mutation Cache & Incremental Flush", () => {
  it.effect(
    "REQ-1.1 SpanTrace: MutationCache.decide binds witnessTestFile + witnessClosureSha256 with exitTag=Success and zero span budget violations",
    () =>
      Effect.gen(function* () {
        const kHit = computeContentSha256("hit")
        const kNotReaching = computeContentSha256("not-reaching")
        const kWrongClosure = computeContentSha256("wrong-closure")
        const hitEntry = makeSignedEntry(kHit, "m-hit")
        const wrongWitnessMac: MutationCacheEntry = {
          ...hitEntry,
          witnessTestFile: WITNESS_TEST_B,
        }
        expect(verifyMutationEntryMac(TEST_HMAC_SECRET, hitEntry)).toBe(true)
        expect(verifyMutationEntryMac(TEST_HMAC_SECRET, wrongWitnessMac)).toBe(false)
        expect(
          verifyMutationEntryMac(TEST_HMAC_SECRET, {
            ...hitEntry,
            witnessClosureSha256: CLOSURE_B,
          }),
        ).toBe(false)

        const store: MutationCacheStore = {
          version: MUTATION_CACHE_SCHEMA_VERSION,
          entries: {
            [kHit]: hitEntry,
            [kNotReaching]: makeSignedEntry(kNotReaching, "m-nr", {
              witnessTestFile: WITNESS_TEST_B,
              witnessClosureSha256: CLOSURE_B,
            }),
            [kWrongClosure]: makeSignedEntry(kWrongClosure, "m-wc", {
              witnessTestFile: WITNESS_TEST_A,
              witnessClosureSha256: CLOSURE_B,
            }),
          },
        }
        const { result, spans } = yield* runWithTestTracer(
          "MutationCache.decide::witness-span",
          MutationCache.decide({
            candidateKeys: [kHit, kNotReaching, kWrongClosure],
            store,
            auth: TEST_CACHE_AUTH,
            nowMs: BASE_NOW_MS,
            reachingTests: [WITNESS_TEST_A],
            witnessClosureDigests: { [WITNESS_TEST_A]: CLOSURE_A, [WITNESS_TEST_B]: CLOSURE_B },
          }),
          new Map(),
        )
        expect(result.hitKeys).toEqual([kHit])
        expect(result.missKeys).toEqual([kNotReaching, kWrongClosure])
        const decideSpan = spans.find((s) => s.name === "MutationCache.decide")
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
        const violations = yield* decideSpanBudgets({ spans: spanSamples })
        expect(violations).toEqual([])
      }),
  )

  it.effect.prop(
    "REQ-1.1 PropertyTest: MutationCache.decide preserves exact hitKeys/missKeys across arbitrary witness entries, reaching tests, and tampered/expired variants",
    {
      items: Schema.Array(
        Schema.Struct({
          seed: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,8}$/)),
          variant: Schema.Literals([
            "valid",
            "missing",
            "tamper-mac",
            "tamper-witness",
            "tamper-closure",
            "expired",
            "not-reaching",
            "missing-digest",
          ]),
        }),
      ).pipe(Schema.check(Schema.isMaxLength(16))),
      fallbackToken: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,8}$/)),
    },
    ({ items, fallbackToken }) =>
      Effect.gen(function* () {
        const candidateKeys: Array<ContentSha256> = []
        const entries: Record<ContentSha256, MutationCacheEntry> = {}
        const expectedHits: Array<ContentSha256> = []
        const expectedMisses: Array<ContentSha256> = []
        const witnessC = AstSourceFilePath.make("libs/sample/domain/test/unreached.test.ts")
        const witnessNoDigest = AstSourceFilePath.make("libs/sample/domain/test/no-digest.test.ts")

        items.forEach((item, idx) => {
          const key = computeContentSha256(`${item.seed}-${idx}`)
          candidateKeys.push(key)
          const expiredAt = MutationCacheTimestamp.make(
            new Date(BASE_NOW_MS - MAX_MUTATION_CACHE_AGE_MS - 1000).toISOString(),
          )
          const base = makeSignedEntry(key, `m-${idx}`)
          match(item.variant)
            .with("valid", () => {
              entries[key] = base
              expectedHits.push(key)
            })
            .with("missing", () => {
              expectedMisses.push(key)
            })
            .with("tamper-mac", () => {
              const flipped = `${base.mac.slice(0, 63)}${base.mac.endsWith("0") ? "1" : "0"}`
              entries[key] = { ...base, mac: MutationCacheMac.make(flipped) }
              expectedMisses.push(key)
            })
            .with("tamper-witness", () => {
              entries[key] = { ...base, witnessTestFile: WITNESS_TEST_B }
              expectedMisses.push(key)
            })
            .with("tamper-closure", () => {
              entries[key] = { ...base, witnessClosureSha256: CLOSURE_B }
              expectedMisses.push(key)
            })
            .with("expired", () => {
              entries[key] = makeSignedEntry(key, `m-${idx}`, { recordedAt: expiredAt })
              expectedMisses.push(key)
            })
            .with("not-reaching", () => {
              entries[key] = makeSignedEntry(key, `m-${idx}`, { witnessTestFile: witnessC })
              expectedMisses.push(key)
            })
            .with("missing-digest", () => {
              entries[key] = makeSignedEntry(key, `m-${idx}`, {
                witnessTestFile: witnessNoDigest,
              })
              expectedMisses.push(key)
            })
            .exhaustive()
        })

        const decision = yield* MutationCache.decide({
          candidateKeys,
          store: { version: MUTATION_CACHE_SCHEMA_VERSION, entries },
          auth: TEST_CACHE_AUTH,
          nowMs: BASE_NOW_MS,
          reachingTests: [WITNESS_TEST_A, witnessNoDigest],
          witnessClosureDigests: {
            [WITNESS_TEST_A]: CLOSURE_A,
            [witnessC]: CLOSURE_B,
            [AstSourceFilePath.make(`libs/sample/domain/test/fb-${fallbackToken}.test.ts`)]:
              CLOSURE_B,
          },
        })
        expect(decision.hitKeys).toEqual(expectedHits)
        expect(decision.missKeys).toEqual(expectedMisses)
        expect(decision.hitKeys.length + decision.missKeys.length).toBe(candidateKeys.length)
      }),
  )

  it("REQ-1.2 Witness-Scoped Hit Isolation: unrelated fallback test and libs/es/infra edits preserve 100% cache hit while witness edits or removal invalidate", () => {
    const repoRoot = setupWitnessTempRepo()
    try {
      const logicPath = join(repoRoot, "libs", "sample", "domain", "src", "logic.ts")
      const witnessPath = join(repoRoot, "libs", "sample", "domain", "test", "logic.test.ts")
      const fallbackPath = join(repoRoot, "libs", "sample", "domain", "test", "fallback.test.ts")
      const logicSrc = "export const isSame = (a: number, b: number): boolean => a === b\n"
      writeFileMkdir(logicPath, logicSrc)
      writeFileMkdir(
        witnessPath,
        'import { expect, it } from "vitest"\nimport { isSame } from "../src/logic.js"\nit("ok", () => { expect(isSame(1, 1)).toBe(true) })\n',
      )
      writeFileMkdir(
        fallbackPath,
        'import { expect, it } from "vitest"\nit("fb", () => { expect(1).toBe(1) })\n',
      )

      let mutantCalls = 0
      let failFile = "libs/sample/domain/test/logic.test.ts"
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (cmd, _args, opts) => {
          if (cmd === "git") return NOT_GIT_RESULT
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          mutantCalls += 1
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: `FAIL  ${failFile}\nTests  1 failed (1)\n`,
            stderr: "",
          }
        },
      }

      const r1 = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: BASE_NOW_MS,
      })
      expect(r1.passed).toBe(true)
      expect(r1.killedCount).toBeGreaterThan(0)
      expect(r1.cachedKilledCount).toBe(0)
      const cachedStore = loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
      expect(Object.values(cachedStore.entries).length).toBe(r1.killedCount)
      for (const entry of Object.values(cachedStore.entries)) {
        expect(entry.witnessTestFile).toBe("libs/sample/domain/test/logic.test.ts")
      }

      // Edit unrelated fallback.test.ts AND unrelated libs/es/infra/src/memory.ts -> 100% hit, 0 mutant calls
      mutantCalls = 0
      writeFileMkdir(
        fallbackPath,
        'import { expect, it } from "vitest"\nit("fb", () => { expect(2).toBe(2) })\n',
      )
      writeFileMkdir(
        join(repoRoot, "libs", "es", "infra", "src", "memory.ts"),
        "export const mem = () => 999\n",
      )
      const r2 = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: BASE_NOW_MS,
      })
      expect(r2.passed).toBe(true)
      expect(r2.cachedKilledCount).toBe(r1.killedCount)
      expect(mutantCalls).toBe(0)

      // Edit witness logic.test.ts -> cache miss & re-evaluation
      mutantCalls = 0
      writeFileMkdir(
        witnessPath,
        'import { expect, it } from "vitest"\nimport { isSame } from "../src/logic.js"\nit("ok2", () => { expect(isSame(2, 2)).toBe(true) })\n',
      )
      const r3 = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: BASE_NOW_MS,
      })
      expect(r3.passed).toBe(true)
      expect(r3.cachedKilledCount).toBe(0)
      expect(mutantCalls).toBe(r1.killedCount)

      // Remove logic.test.ts from reaching tests (non-importing) & add alt.test.ts -> miss & re-evaluation
      mutantCalls = 0
      writeFileMkdir(
        witnessPath,
        'import { expect, it } from "vitest"\nit("detached", () => { expect(1).toBe(1) })\n',
      )
      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "test", "alt.test.ts"),
        'import { expect, it } from "vitest"\nimport { isSame } from "../src/logic.js"\nit("alt", () => { expect(isSame(1, 1)).toBe(true) })\n',
      )
      failFile = "libs/sample/domain/test/alt.test.ts"
      const r4 = runDomainMutationSuite(repoRoot, mockIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: BASE_NOW_MS,
      })
      expect(r4.passed).toBe(true)
      expect(r4.cachedKilledCount).toBe(0)
      expect(mutantCalls).toBe(r1.killedCount)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-1.3 Fail-Closed Security: symlinked witness test file, missing closure digest, expired TTL, and tampered entry reject as misses", () => {
    const repoRoot = setupWitnessTempRepo()
    try {
      const logicSrc = "export const isSame = (a: number, b: number): boolean => a === b\n"
      const logicPath = join(repoRoot, "libs", "sample", "domain", "src", "logic.ts")
      const realWitness = join(repoRoot, "outside-witness.test.ts")
      const symlinkWitness = join(repoRoot, "libs", "sample", "domain", "test", "logic.test.ts")
      writeFileMkdir(logicPath, logicSrc)
      writeFileMkdir(
        realWitness,
        'import { expect, it } from "vitest"\nit("w", () => { expect(1).toBe(1) })\n',
      )
      writeFileMkdir(
        symlinkWitness,
        'import { expect, it } from "vitest"\nit("w", () => { expect(1).toBe(1) })\n',
      )

      const digests = unwrapOpt(computeMutationContextDigests(repoRoot, isolatedTestHostIo))
      rmSync(symlinkWitness)
      symlinkSync(realWitness, symlinkWitness)
      const closureRes = computeFileMutationClosureDigest({
        repoRoot,
        relFile: "libs/sample/domain/src/logic.ts",
        allReachingTests: ["libs/sample/domain/test/logic.test.ts"],
        digests,
        hostIo: isolatedTestHostIo,
      })
      expect(closureRes._tag).toBe("Disabled")

      const mutants = discoverDomainMutants("libs/sample/domain/src/logic.ts", logicSrc)
      const schemaBundle = compileMutantSchemaModule(
        "libs/sample/domain/src/logic.ts",
        logicSrc,
        mutants,
      )
      const m0 = mutants[0]!
      const key = computeMutantCacheKey({
        pkgKey: PackageRelKey.make("sample/domain"),
        relFile: AstSourceFilePath.make("libs/sample/domain/src/logic.ts"),
        originalContentSha256: computeContentSha256(logicSrc),
        compiledSchemaSha256: computeContentSha256(schemaBundle.schemaSource),
        mutant: m0,
        digests,
      })
      const entry = makeSignedEntry(key, m0.id)
      const origWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = (() => true) as typeof process.stderr.write
      try {
        const hitRes = hydrateFileMutantCacheHits({
          repoRoot,
          file: {
            scope: "sample",
            pkgDir: "domain",
            tier: "domain",
            fullPath: logicPath,
            relFile: "libs/sample/domain/src/logic.ts",
          },
          originalContent: logicSrc,
          schemaSource: schemaBundle.schemaSource,
          mutants: [m0],
          allReachingTests: ["libs/sample/domain/test/logic.test.ts"],
          hostIo: isolatedTestHostIo,
          cacheEnabled: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: BASE_NOW_MS,
          contextDigests: digests,
          loadedCacheStore: { version: MUTATION_CACHE_SCHEMA_VERSION, entries: { [key]: entry } },
          cacheEntries: {},
        })
        expect(hitRes.cachedHitIds.size).toBe(0)
      } finally {
        process.stderr.write = origWrite
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-1.3 Read-Only Common-Repo Cache: linked worktree rejects invalid/tampered/missing-witness entries without mutating common repo cache", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-witness-ro-"))
    try {
      const mainRepo = join(root, "main-repo")
      const wtRepo = join(mainRepo, ".worktrees", "wt1")
      const wtGitDir = join(mainRepo, ".git", "worktrees", "wt1")
      mkdirSync(join(mainRepo, ".git", "objects"), { recursive: true })
      mkdirSync(wtGitDir, { recursive: true })
      mkdirSync(wtRepo, { recursive: true })
      writeFileSync(join(wtGitDir, "commondir"), "../..\n", "utf8")
      writeFileSync(join(wtRepo, ".git"), `gitdir: ${wtGitDir}\n`, "utf8")

      writeFileMkdir(join(wtRepo, "tsconfig.base.json"), '{"compilerOptions":{}}\n')
      writeFileMkdir(
        join(wtRepo, "node_modules", "vitest", "package.json"),
        '{"name":"vitest","version":"5.0.0"}\n',
      )
      writeFileMkdir(join(wtRepo, "node_modules", "vitest", "vitest.mjs"), "// vitest\n")
      writeFileMkdir(
        join(wtRepo, "libs", "sample", "domain", "package.json"),
        '{"name":"@sample/domain","nx":{"tags":["type:domain"]}}\n',
      )
      const logicSrc = "export const isSame = (a: number, b: number): boolean => a === b\n"
      writeFileMkdir(join(wtRepo, "libs", "sample", "domain", "src", "logic.ts"), logicSrc)
      writeFileMkdir(
        join(wtRepo, "libs", "sample", "domain", "test", "logic.test.ts"),
        'import { expect, it } from "vitest"\nimport { isSame } from "../src/logic.js"\nit("ok", () => { expect(isSame(1, 1)).toBe(true) })\n',
      )

      const digests = unwrapOpt(computeMutationContextDigests(wtRepo, isolatedTestHostIo))
      const mutants = discoverDomainMutants("libs/sample/domain/src/logic.ts", logicSrc)
      const schemaBundle = compileMutantSchemaModule(
        "libs/sample/domain/src/logic.ts",
        logicSrc,
        mutants,
      )
      const key0 = computeMutantCacheKey({
        pkgKey: PackageRelKey.make("sample/domain"),
        relFile: AstSourceFilePath.make("libs/sample/domain/src/logic.ts"),
        originalContentSha256: computeContentSha256(logicSrc),
        compiledSchemaSha256: computeContentSha256(schemaBundle.schemaSource),
        mutant: mutants[0]!,
        digests,
      })
      const key1 = computeMutantCacheKey({
        pkgKey: PackageRelKey.make("sample/domain"),
        relFile: AstSourceFilePath.make("libs/sample/domain/src/logic.ts"),
        originalContentSha256: computeContentSha256(logicSrc),
        compiledSchemaSha256: computeContentSha256(schemaBundle.schemaSource),
        mutant: mutants[1] ?? mutants[0]!,
        digests,
      })
      const missingWitnessEntry = makeSignedEntry(key0, mutants[0]!.id, {
        witnessTestFile: AstSourceFilePath.make("libs/sample/domain/test/removed-witness.test.ts"),
      })
      const tamperedEntry = {
        ...makeSignedEntry(key1, (mutants[1] ?? mutants[0]!).id),
        witnessTestFile: WITNESS_TEST_B,
      }
      saveMutationCacheAtomic(
        mainRepo,
        {
          version: MUTATION_CACHE_SCHEMA_VERSION,
          entries: { [key0]: missingWitnessEntry, [key1]: tamperedEntry },
        },
        isolatedTestHostIo,
        TEST_CACHE_AUTH,
      )
      const mainCacheFile = join(resolveHarnessStateDir(mainRepo), "cache", MUTATION_CACHE_FILENAME)
      const mainCacheBefore = readFileSync(mainCacheFile, "utf8")

      const loaded = loadMutationCache(wtRepo, isolatedTestHostIo, TEST_CACHE_AUTH)
      expect(loaded.entries[key1]).toBeUndefined()

      let mutantCalls = 0
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (cmd, _args, opts) => {
          if (cmd === "git") return NOT_GIT_RESULT
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
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
      const report = runDomainMutationSuite(wtRepo, mockIo, {
        includeAllLines: true,
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: BASE_NOW_MS,
      })
      expect(report.passed).toBe(true)
      expect(report.cachedKilledCount).toBe(0)
      expect(mutantCalls).toBe(mutants.length)
      expect(readFileSync(mainCacheFile, "utf8")).toBe(mainCacheBefore)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("REQ-1.4 Tightened allLibsSrcDigest AST Precision: synthetic strings & mkdtempSync stay isolated while real repo-root traversal invalidates on libs/es/infra edits", () => {
    const repoRoot = setupWitnessTempRepo()
    try {
      const srcDir = join(repoRoot, "libs", "sample", "domain", "src")
      const testDir = join(repoRoot, "libs", "sample", "domain", "test")
      writeFileMkdir(
        join(repoRoot, "libs", "other", "core", "src", "dep.ts"),
        "export const dep = 1\n",
      )
      writeFileMkdir(
        join(srcDir, "literal-only.ts"),
        'export const hint = "libs/es/infra/src/memory.ts"\n',
      )
      writeFileMkdir(
        join(testDir, "literal-only.test.ts"),
        'import { hint } from "../src/literal-only.js"\nexport const t = hint\n',
      )
      writeFileMkdir(
        join(srcDir, "tmp-fs.ts"),
        [
          'import { mkdtempSync, readFileSync } from "node:fs"',
          'import { join } from "node:path"',
          'export const readTmp = () => { const d = mkdtempSync("/tmp/x-"); const p = join(d, "libs", "es", "infra", "src", "memory.ts"); return readFileSync(p, "utf8") }',
        ].join("\n"),
      )
      writeFileMkdir(
        join(testDir, "tmp-fs.test.ts"),
        'import { readTmp } from "../src/tmp-fs.js"\nexport const t = readTmp\n',
      )
      writeFileMkdir(
        join(srcDir, "real-root-scan.ts"),
        [
          'import { readdirSync } from "node:fs"',
          'import { join, resolve } from "node:path"',
          'const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../../..")',
          'export const scan = () => readdirSync(join(REAL_REPO_ROOT, "libs"))',
        ].join("\n"),
      )
      writeFileMkdir(
        join(testDir, "real-root-scan.test.ts"),
        'import { scan } from "../src/real-root-scan.js"\nexport const t = scan\n',
      )
      writeFileMkdir(
        join(srcDir, "direct-libs-read.ts"),
        [
          'import { readFileSync } from "node:fs"',
          'export const readDirect = () => readFileSync("libs/other/core/src/dep.ts", "utf8")',
        ].join("\n"),
      )
      writeFileMkdir(
        join(testDir, "direct-libs-read.test.ts"),
        'import { readDirect } from "../src/direct-libs-read.js"\nexport const t = readDirect\n',
      )

      const getClosure = (relFile: string, witness: string) => {
        const d = unwrapOpt(computeMutationContextDigests(repoRoot, isolatedTestHostIo))
        return match(
          computeFileMutationClosureDigest({
            repoRoot,
            relFile,
            allReachingTests: [witness],
            digests: d,
            hostIo: isolatedTestHostIo,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok closure: ${reason}`)
          })
          .exhaustive()
      }

      const litBefore = getClosure(
        "libs/sample/domain/src/literal-only.ts",
        "libs/sample/domain/test/literal-only.test.ts",
      )
      const tmpBefore = getClosure(
        "libs/sample/domain/src/tmp-fs.ts",
        "libs/sample/domain/test/tmp-fs.test.ts",
      )
      const scanBefore = getClosure(
        "libs/sample/domain/src/real-root-scan.ts",
        "libs/sample/domain/test/real-root-scan.test.ts",
      )
      const directBefore = getClosure(
        "libs/sample/domain/src/direct-libs-read.ts",
        "libs/sample/domain/test/direct-libs-read.test.ts",
      )
      expect(litBefore.usedFallbackAllLibs).toBe(false)
      expect(tmpBefore.usedFallbackAllLibs).toBe(false)
      expect(scanBefore.usedFallbackAllLibs).toBe(true)
      expect(directBefore.usedFallbackAllLibs).toBe(true)

      writeFileMkdir(
        join(repoRoot, "libs", "es", "infra", "src", "memory.ts"),
        "export const mem = () => 42\n",
      )

      const litAfter = getClosure(
        "libs/sample/domain/src/literal-only.ts",
        "libs/sample/domain/test/literal-only.test.ts",
      )
      const tmpAfter = getClosure(
        "libs/sample/domain/src/tmp-fs.ts",
        "libs/sample/domain/test/tmp-fs.test.ts",
      )
      const scanAfter = getClosure(
        "libs/sample/domain/src/real-root-scan.ts",
        "libs/sample/domain/test/real-root-scan.test.ts",
      )
      const directAfter = getClosure(
        "libs/sample/domain/src/direct-libs-read.ts",
        "libs/sample/domain/test/direct-libs-read.test.ts",
      )
      expect(litAfter.closureDigest).toBe(litBefore.closureDigest)
      expect(tmpAfter.closureDigest).toBe(tmpBefore.closureDigest)
      expect(scanAfter.closureDigest).not.toBe(scanBefore.closureDigest)
      expect(directAfter.closureDigest).not.toBe(directBefore.closureDigest)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-1.5 Incremental Batch Flush: batch 1 kills are flushed to disk before batch 2 aborts (TimedOut and Exited(1))", () => {
    const runAbortScenario = (abortMode: "TimedOut" | "Exited1") => {
      const repoRoot = setupWitnessTempRepo()
      const origWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = (() => true) as typeof process.stderr.write
      try {
        writeFileMkdir(join(repoRoot, "tools", "package-vitest-batch.mjs"), "// batch\n")
        writeFileMkdir(
          join(repoRoot, "libs", "sample2", "domain", "package.json"),
          JSON.stringify({ name: "@sample2/domain", nx: { tags: ["type:domain"] } }),
        )
        for (const n of [1, 2, 3, 4]) {
          writeFileMkdir(
            join(repoRoot, "libs", "sample", "domain", "src", `f${n}.ts`),
            `export const fn${n} = (a: number, b: number): boolean => a === b\n`,
          )
          writeFileMkdir(
            join(repoRoot, "libs", "sample", "domain", "test", `f${n}.test.ts`),
            `import { expect, it } from "vitest"\nimport { fn${n} } from "../src/f${n}.js"\nit("ok", () => { expect(fn${n}(1, 1)).toBe(true) })\n`,
          )
        }
        for (const n of [5, 6]) {
          writeFileMkdir(
            join(repoRoot, "libs", "sample2", "domain", "src", `f${n}.ts`),
            `export const fn${n} = (a: number, b: number): boolean => a === b\n`,
          )
          writeFileMkdir(
            join(repoRoot, "libs", "sample2", "domain", "test", `f${n}.test.ts`),
            `import { expect, it } from "vitest"\nimport { fn${n} } from "../src/f${n}.js"\nit("ok", () => { expect(fn${n}(1, 1)).toBe(true) })\n`,
          )
        }

        let batchCallCount = 0
        let cachedCountBeforeBatch2 = 0
        const mockIo: SyncHostIo = {
          ...isolatedTestHostIo,
          execFileSync: (cmd, args, opts) => {
            if (cmd === "git") return NOT_GIT_RESULT
            if (args.some((a) => a.endsWith("package-vitest-batch.mjs"))) {
              batchCallCount += 1
              const planRaw = isolatedTestHostIo.readTextSync(
                opts!.env!["HARNESS_PACKAGE_PLAN_FILE"]!,
              )
              const plan = JSON.parse(planRaw) as {
                readonly files: ReadonlyArray<{
                  readonly relFile: string
                  readonly mutantIds: ReadonlyArray<string>
                }>
              }
              if (batchCallCount === 1) {
                expect(plan.files).toHaveLength(4)
                const rows = plan.files.map((f) => {
                  const testRel = f.relFile.replace("/src/", "/test/").replace(/\.ts$/, ".test.ts")
                  return {
                    relFile: f.relFile,
                    primaryResults: f.mutantIds.map((id) => ({
                      id,
                      result: {
                        _tag: "Exited" as const,
                        exitCode: 1,
                        stdout: `FAIL  ${testRel}\nTests  1 failed (1)\n`,
                        stderr: "",
                        killingTestFile: AstSourceFilePath.make(testRel),
                      },
                    })),
                    scopedFallbackResults: [],
                    packageFallbackResults: [],
                  }
                })
                return {
                  _tag: "Exited",
                  exitCode: 0,
                  stdout: JSON.stringify(rows),
                  stderr: "",
                }
              }

              // Batch 2: verify batch 1 kills are ALREADY persisted to disk before batch 2 aborts
              const midStore = loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
              cachedCountBeforeBatch2 = Object.keys(midStore.entries).length
              return abortMode === "TimedOut"
                ? { _tag: "TimedOut", stdout: "", stderr: "" }
                : { _tag: "Exited", exitCode: 1, stdout: "", stderr: "worker crashed" }
            }
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  5 passed (5)\n", stderr: "" }
          },
        }

        const report = runDomainMutationSuite(repoRoot, mockIo, {
          includeAllLines: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: BASE_NOW_MS,
        })
        expect(report.passed).toBe(false)
        expect(batchCallCount).toBe(2)
        expect(cachedCountBeforeBatch2).toBeGreaterThan(0)
        const finalStore = loadMutationCache(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
        const entries = Object.values(finalStore.entries)
        expect(entries.length).toBe(cachedCountBeforeBatch2)
        expect(entries.every((e) => !e.file.endsWith("f5.ts"))).toBe(true)
        expect(entries.some((e) => e.file.endsWith("f1.ts"))).toBe(true)
        expect(entries.some((e) => e.file.endsWith("f4.ts"))).toBe(true)
      } finally {
        process.stderr.write = origWrite
        rmSync(repoRoot, { recursive: true, force: true })
      }
    }
    runAbortScenario("TimedOut")
    runAbortScenario("Exited1")
  })

  it("REQ-1.4 Security Hardening: detects multi-arg '..', resolveRepoRoot, ['libs','apps'], *.hostIo.*, and indirect 'libs/...' reads", () => {
    const repoRoot = setupWitnessTempRepo()
    try {
      const srcDir = join(repoRoot, "libs", "sample", "domain", "src")
      const testDir = join(repoRoot, "libs", "sample", "domain", "test")
      const cases: ReadonlyArray<{ readonly name: string; readonly code: string }> = [
        {
          name: "multi-arg-dots",
          code: [
            'import { readdirSync } from "node:fs"',
            'import { join, resolve } from "node:path"',
            'const R = resolve(import.meta.dirname, "..", "..", "..", "..")',
            'export const scan = () => readdirSync(join(R, "libs"))',
          ].join("\n"),
        },
        {
          name: "resolve-repo-root-loop",
          code: [
            'import { join } from "node:path"',
            'import { isFileSync } from "node:fs"',
            "declare const resolveRepoRoot: () => string",
            "declare const walk: (p: string) => void",
            'export const scan = () => { const root = resolveRepoRoot(); for (const sub of ["libs", "apps"]) walk(join(root, sub)); return isFileSync }',
          ].join("\n"),
        },
        {
          name: "indirect-libs-read",
          code: [
            'import { readFileSync } from "node:fs"',
            'export const readIndirect = () => { const p = "libs/es/infra/src/memory.ts"; return readFileSync(p, "utf8") }',
          ].join("\n"),
        },
        {
          name: "workspace-yaml-symlink",
          code: [
            'import { isSymbolicLinkSync } from "node:fs"',
            'const marker = "pnpm-workspace.yaml"',
            'export const check = (hostIo: { readdirSync: (p: string) => unknown }) => ({ marker, sym: isSymbolicLinkSync("libs/es/infra/src/memory.ts"), hostIo })',
          ].join("\n"),
        },
      ]
      for (const c of cases) {
        writeFileMkdir(join(srcDir, `${c.name}.ts`), c.code)
        writeFileMkdir(
          join(testDir, `${c.name}.test.ts`),
          `import { ${c.name === "indirect-libs-read" ? "readIndirect" : c.name === "workspace-yaml-symlink" ? "check" : "scan"} } from "../src/${c.name}.js"\nexport const t = 1\n`,
        )
      }
      writeFileMkdir(join(srcDir, "member-hostio.ts"), "export const val = 1\n")
      writeFileMkdir(
        join(testDir, "member-hostio.test.ts"),
        [
          'import { val } from "../src/member-hostio.js"',
          "declare const resolveCanonicalRepoRoot: () => string",
          'export const run = (input: { hostIo: { readdirSync: (p: string) => unknown } }) => { const root = resolveCanonicalRepoRoot(); return [val, "libs/es/infra/src/memory.ts", input.hostIo.readdirSync(root)] }',
        ].join("\n"),
      )

      const getClosure = (relFile: string, witness: string) => {
        const d = unwrapOpt(computeMutationContextDigests(repoRoot, isolatedTestHostIo))
        return match(
          computeFileMutationClosureDigest({
            repoRoot,
            relFile,
            allReachingTests: [witness],
            digests: d,
            hostIo: isolatedTestHostIo,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "Disabled" }, ({ reason }) => {
            throw new Error(`Expected Ok closure: ${reason}`)
          })
          .exhaustive()
      }

      const targets = [
        ...cases.map((c) => [
          `libs/sample/domain/src/${c.name}.ts`,
          `libs/sample/domain/test/${c.name}.test.ts`,
        ]),
        [
          "libs/sample/domain/src/member-hostio.ts",
          "libs/sample/domain/test/member-hostio.test.ts",
        ],
      ] as const
      const before = targets.map(([s, t]) => getClosure(s, t))
      for (const b of before) expect(b.usedFallbackAllLibs).toBe(true)

      writeFileMkdir(
        join(repoRoot, "libs", "es", "infra", "src", "memory.ts"),
        "export const mem = () => 99\n",
      )
      for (const [idx, [s, t]] of targets.entries()) {
        expect(getClosure(s, t).closureDigest).not.toBe(before[idx]!.closureDigest)
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-1.3 & Witness Attribution: rejects dangling symlinks even with checkFileExists=false and strips |proj| FAIL prefixes", () => {
    const repoRoot = setupWitnessTempRepo()
    try {
      const cacheDir = join(resolveHarnessStateDir(repoRoot, {}), "cache")
      mkdirSync(cacheDir, { recursive: true })
      const cacheFile = join(cacheDir, MUTATION_CACHE_FILENAME)
      const danglingTarget = join(repoRoot, "does-not-exist-target.json")
      symlinkSync(danglingTarget, cacheFile)

      expect(
        validateHarnessCacheFileSafety(repoRoot, cacheFile, false, isolatedTestHostIo),
      ).toContain("symlink")
      expect(
        validateHarnessCacheFileSafety(repoRoot, cacheFile, true, isolatedTestHostIo),
      ).toContain("symlink")
      expect(loadMutationCacheWithStatus(repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)._tag).toBe(
        "Unsafe",
      )
      expect(
        saveMutationCacheAtomic(
          repoRoot,
          { version: MUTATION_CACHE_SCHEMA_VERSION, entries: {} },
          isolatedTestHostIo,
          TEST_CACHE_AUTH,
        )._tag,
      ).toBe("Skipped")

      const passTest = join(repoRoot, "libs", "sample", "domain", "test", "logic.test.ts")
      const witness = extractWitnessTestFileFromOutput(
        repoRoot,
        [passTest, join(repoRoot, "libs", "sample", "domain", "test", "other.test.ts")],
        " FAIL  |gates| libs/sample/domain/test/logic.test.ts > suite > case [12ms]\n",
        "",
      )
      expect(witness).toBe(WITNESS_TEST_A)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
