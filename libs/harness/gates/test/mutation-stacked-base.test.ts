import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Redacted } from "effect"
import { match } from "ts-pattern"
import {
  MUTATION_CACHE_FILENAME,
  type MutationCacheAuth,
  MutationCacheHmacSecret,
  MutationEpochMillis,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  MutantCount,
  MutateStampPassed,
  StampBranchName,
  StampRelFilePath,
  checkMutateStamp,
  runDomainMutationSuite,
  writeMutateStamp,
} from "../src/index.js"
import {
  compileMutantSchemaModule,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import { checkGitAncestorCommit } from "../src/mutation/mutation-backup.js"
import { loadMutationCache, saveMutationCacheAtomic } from "../src/mutation/mutation-cache.js"
import { runPackageMutantBatchChecked } from "../src/mutation/mutation-package-batch.js"
import { resolveStackedBaseContext } from "../src/mutation/mutation-stacked-base.js"
import { isolatedTestHostIo, testHostIo } from "./helpers/test-host-io.js"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)))

const TEST_HMAC_SECRET = Redacted.make(
  MutationCacheHmacSecret.make("stacked-base-test-hmac-secret-0123456789abcdef"),
)
const TEST_CACHE_AUTH: MutationCacheAuth = {
  _tag: "Enabled",
  hmacSecret: TEST_HMAC_SECRET,
}

const runGit = (cwd: string, args: ReadonlyArray<string>): string =>
  match(isolatedTestHostIo.execFileSync("git", args, { cwd }))
    .with({ _tag: "Exited" }, (r) => {
      if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`)
      }
      return r.stdout.trim()
    })
    .with({ _tag: "TimedOut" }, () => {
      throw new Error(`git ${args.join(" ")} timed out`)
    })
    .with({ _tag: "Signaled" }, (r) => {
      throw new Error(`git ${args.join(" ")} signaled: ${r.signal}`)
    })
    .with({ _tag: "SpawnFailed" }, (r) => {
      throw new Error(`git ${args.join(" ")} spawn failed: ${r.spawnError}`)
    })
    .exhaustive()

interface StackedRepoFixture {
  readonly repoRoot: string
  readonly relA: string
  readonly relB: string
  readonly testA: string
  readonly testB: string
}

const createStackedGitFixture = (): StackedRepoFixture => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mutation-stacked-base-"))
  runGit(repoRoot, ["init"])
  runGit(repoRoot, ["checkout", "-B", "main"])
  runGit(repoRoot, ["config", "user.email", "stacked@example.com"])
  runGit(repoRoot, ["config", "user.name", "Stacked Test"])

  mkdirSync(join(repoRoot, "libs", "sample", "domain", "src"), { recursive: true })
  mkdirSync(join(repoRoot, "libs", "sample", "domain", "test"), { recursive: true })
  writeFileSync(join(repoRoot, ".gitignore"), "/.harness/\n", "utf8")
  writeFileSync(join(repoRoot, "tsconfig.base.json"), '{"compilerOptions":{}}\n', "utf8")
  writeFileSync(
    join(repoRoot, "libs", "sample", "domain", "package.json"),
    '{"name":"@sample/domain","nx":{"tags":["type:domain"]}}\n',
    "utf8",
  )
  writeFileSync(
    join(repoRoot, "libs", "sample", "domain", "src", "seed.ts"),
    "export const seed = (x: number): number => x\n",
    "utf8",
  )
  writeFileSync(
    join(repoRoot, "libs", "sample", "domain", "test", "seed.test.ts"),
    'import { expect, it } from "vitest"\nimport { seed } from "../src/seed.js"\nit("seed", () => { expect(seed(1)).toBe(1) })\n',
    "utf8",
  )
  runGit(repoRoot, ["add", "-A"])
  runGit(repoRoot, ["commit", "-m", "init main"])

  const relA = "libs/sample/domain/src/a.ts"
  const testA = "libs/sample/domain/test/a.test.ts"
  runGit(repoRoot, ["checkout", "-b", "parent"])
  writeFileSync(
    join(repoRoot, relA),
    "export const isSameA = (a: number, b: number): boolean => a === b\n",
    "utf8",
  )
  writeFileSync(
    join(repoRoot, testA),
    'import { expect, it } from "vitest"\nimport { isSameA } from "../src/a.js"\nit("a", () => { expect(isSameA(1, 1)).toBe(true) })\n',
    "utf8",
  )
  runGit(repoRoot, ["add", "-A"])
  runGit(repoRoot, ["commit", "-m", "parent feature a"])

  const relB = "libs/sample/domain/src/b.ts"
  const testB = "libs/sample/domain/test/b.test.ts"
  runGit(repoRoot, ["checkout", "-b", "child"])
  writeFileSync(
    join(repoRoot, relB),
    "export const isSameB = (a: number, b: number): boolean => a === b\n",
    "utf8",
  )
  writeFileSync(
    join(repoRoot, testB),
    'import { expect, it } from "vitest"\nimport { isSameB } from "../src/b.js"\nit("b", () => { expect(isSameB(2, 2)).toBe(true) })\n',
    "utf8",
  )
  runGit(repoRoot, ["add", "-A"])
  runGit(repoRoot, ["commit", "-m", "child feature b"])

  return { repoRoot, relA, relB, testA, testB }
}

const makeVitestMockIo = (
  repoRoot: string,
  opts?: {
    readonly surviveMutantPrefix?: string | undefined
    readonly invokedMutantTests?: Array<string> | undefined
  },
): SyncHostIo => ({
  ...isolatedTestHostIo,
  execFileSync: (cmd, args, execOpts) => {
    if (cmd === "git") return isolatedTestHostIo.execFileSync(cmd, args, execOpts)
    const testArgs = args
      .filter((a) => a.endsWith(".test.ts") || a.endsWith(".spec.ts"))
      .map((a) => relative(repoRoot, resolve(repoRoot, a)).replace(/\\/g, "/"))
    const activeMutantId = execOpts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
    if (activeMutantId === undefined) {
      return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
    }
    opts?.invokedMutantTests?.push(...testArgs)
    const primaryTest = testArgs[0] ?? "libs/sample/domain/test/b.test.ts"
    if (
      opts?.surviveMutantPrefix !== undefined &&
      activeMutantId.startsWith(opts.surviveMutantPrefix)
    ) {
      return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
    }
    return {
      _tag: "Exited",
      exitCode: 1,
      stdout: `FAIL  ${primaryTest}\nTests  1 failed (1)\n`,
      stderr: "",
    }
  },
})

const seedParentCacheOnBranch = (fixture: StackedRepoFixture, nowMs: MutationEpochMillis): void => {
  runGit(fixture.repoRoot, ["checkout", "parent"])
  const parentReport = runDomainMutationSuite(
    fixture.repoRoot,
    makeVitestMockIo(fixture.repoRoot),
    {
      enforcementMode: "strict",
      baseRef: "main",
      explicitBaseRef: true,
      cacheAuth: TEST_CACHE_AUTH,
      nowMs,
    },
  )
  expect(parentReport.passed).toBe(true)
  expect(parentReport.killedCount).toBeGreaterThan(0)
  runGit(fixture.repoRoot, ["checkout", "child"])
}

describe("mutation-stacked-base: SPEC-0034 Area 5", () => {
  it("REQ-5.1: stacked --base parent verifies ancestor HMAC hits without re-running parent tests and validates combined mutate-stamp", () => {
    const fixture = createStackedGitFixture()
    try {
      const t1 = MutationEpochMillis.make(Date.parse("2026-11-25T10:00:00.000Z"))
      seedParentCacheOnBranch(fixture, t1)

      const invokedMutantTests: Array<string> = []
      const t2 = MutationEpochMillis.make(Date.parse("2026-11-25T10:05:00.000Z"))
      const report = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot, { invokedMutantTests }),
        {
          enforcementMode: "strict",
          baseRef: "parent",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: t2,
        },
      )

      expect(report.passed).toBe(true)
      expect(report.diffMode).toBe("branch-base")
      expect(report.stackedBaseVerified).toBe(true)
      expect(report.stackedBaseRef).toBe("parent")
      expect(report.ancestorVerifiedMutantCount ?? 0).toBeGreaterThan(0)
      expect(report.ancestorExpandedMutantCount).toBe(0)
      expect(report.diffMatchedFiles).toContain(fixture.relA)
      expect(report.diffMatchedFiles).toContain(fixture.relB)
      expect(report.evaluatedFiles).toContain(fixture.relA)
      expect(report.evaluatedFiles).toContain(fixture.relB)
      expect(invokedMutantTests.length).toBeGreaterThan(0)
      expect(invokedMutantTests.every((t) => t === fixture.testB)).toBe(true)

      writeMutateStamp(fixture.repoRoot, isolatedTestHostIo, {
        enforcementMode: "strict",
        diffMode: report.diffMode,
        scannedCandidateFiles: MutantCount.make(report.scannedCandidateFiles),
        scannedFiles: report.scannedFiles.map((f) => StampRelFilePath.make(f)),
        diffMatchedFiles: report.diffMatchedFiles.map((f) => StampRelFilePath.make(f)),
        evaluatedFiles: report.evaluatedFiles.map((f) => StampRelFilePath.make(f)),
        totalMutants: MutantCount.make(report.totalMutants),
        killedCount: MutantCount.make(report.killedCount),
        equivalentCount: MutantCount.make(report.equivalentCount),
        survivedCount: MutantCount.make(report.survivedCount),
        passed: MutateStampPassed.make(report.passed),
        ...(report.stackedBaseRef !== undefined
          ? { stackedBaseRef: StampBranchName.make(report.stackedBaseRef) }
          : {}),
      })

      const checkRes = checkMutateStamp(fixture.repoRoot, isolatedTestHostIo, [
        fixture.relA,
        fixture.relB,
      ])
      const stampChecked = match(checkRes)
        .with({ _tag: "Valid" }, ({ stamp }) => ({
          valid: true as const,
          stackedBaseRef: stamp.stackedBaseRef,
        }))
        .with({ _tag: "Invalid" }, ({ reason }) => ({ valid: false as const, reason }))
        .exhaustive()
      expect(stampChecked).toEqual({ valid: true, stackedBaseRef: "parent" })
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-5.2: missing, tampered HMAC, expired TTL, or edited witness test expands ancestor lines and catches survivors", () => {
    const fixture = createStackedGitFixture()
    try {
      const t1 = MutationEpochMillis.make(Date.parse("2026-11-25T10:00:00.000Z"))
      seedParentCacheOnBranch(fixture, t1)

      // 1) Tamper HMAC on one cache entry -> triggers expansion of ancestor lines and fails if a.ts survives
      const store = loadMutationCache(fixture.repoRoot, isolatedTestHostIo, TEST_CACHE_AUTH)
      const keys = Object.keys(store.entries)
      expect(keys.length).toBeGreaterThan(0)
      const firstKey = keys[0] as keyof typeof store.entries
      const firstEntry = store.entries[firstKey]!
      const tamperedStore = {
        ...store,
        entries: {
          ...store.entries,
          [firstKey]: {
            ...firstEntry,
            witnessClosureSha256: computeContentSha256("tampered-closure"),
          },
        },
      }
      saveMutationCacheAtomic(fixture.repoRoot, tamperedStore, isolatedTestHostIo, TEST_CACHE_AUTH)

      const invokedOnTamper: Array<string> = []
      const tamperSurvivorReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot, {
          invokedMutantTests: invokedOnTamper,
          surviveMutantPrefix: "libs/sample/domain/src/a.ts:",
        }),
        {
          enforcementMode: "strict",
          baseRef: "parent",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: MutationEpochMillis.make(Date.parse("2026-11-25T10:05:00.000Z")),
        },
      )
      expect(tamperSurvivorReport.passed).toBe(false)
      expect(tamperSurvivorReport.stackedBaseVerified).toBe(false)
      expect(tamperSurvivorReport.ancestorExpandedMutantCount ?? 0).toBeGreaterThan(0)
      expect(invokedOnTamper).toContain(fixture.testA)

      // 2) Re-evaluating with killing tests passes and refreshes cache; expired TTL also expands
      const freshKillReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot),
        {
          enforcementMode: "strict",
          baseRef: "parent",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: MutationEpochMillis.make(Date.parse("2026-11-25T10:10:00.000Z")),
        },
      )
      expect(freshKillReport.passed).toBe(true)
      expect(freshKillReport.stackedBaseVerified).toBe(true)

      // 3) Edited witness test invalidates witness closure digest and expands ancestor lines
      writeFileSync(
        join(fixture.repoRoot, fixture.testA),
        'import { expect, it } from "vitest"\nimport { isSameA } from "../src/a.js"\nit("a edited", () => { expect(isSameA(1, 2)).toBe(false) })\n',
        "utf8",
      )
      const invokedOnWitnessEdit: Array<string> = []
      const witnessEditReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot, { invokedMutantTests: invokedOnWitnessEdit }),
        {
          enforcementMode: "strict",
          baseRef: "parent",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: MutationEpochMillis.make(Date.parse("2026-11-25T10:12:00.000Z")),
        },
      )
      expect(witnessEditReport.passed).toBe(true)
      expect(witnessEditReport.ancestorExpandedMutantCount ?? 0).toBeGreaterThan(0)
      expect(invokedOnWitnessEdit).toContain(fixture.testA)

      // 4) Expired TTL (> 12h) expands ancestor lines cleanly
      const expiredReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot),
        {
          enforcementMode: "strict",
          baseRef: "parent",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: MutationEpochMillis.make(Date.parse("2026-11-26T10:10:00.000Z")),
        },
      )
      expect(expiredReport.passed).toBe(true)
      expect(expiredReport.ancestorExpandedMutantCount ?? 0).toBeGreaterThan(0)

      // 5) Empty cache file (missing entries) expands ancestor lines cleanly
      rmSync(join(fixture.repoRoot, ".harness", "cache", MUTATION_CACHE_FILENAME), { force: true })
      const missingCacheReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot),
        {
          enforcementMode: "strict",
          baseRef: "parent",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: MutationEpochMillis.make(Date.parse("2026-11-26T10:15:00.000Z")),
        },
      )
      expect(missingCacheReport.passed).toBe(true)
      expect(missingCacheReport.ancestorExpandedMutantCount ?? 0).toBeGreaterThan(0)
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-5.1 & REQ-5.3: missing ref, non-ancestor sibling branch, and unclassified ancestor lib file fail closed", () => {
    const fixture = createStackedGitFixture()
    try {
      const t1 = MutationEpochMillis.make(Date.parse("2026-11-25T10:00:00.000Z"))
      seedParentCacheOnBranch(fixture, t1)

      // Clear cache to assert fallback evaluates ancestor file directly against main
      rmSync(join(fixture.repoRoot, ".harness", "cache", MUTATION_CACHE_FILENAME), { force: true })

      // Nonexistent baseRef fails closed to main, evaluates ancestor file directly, stackedBaseVerified=false
      const invokedMissing: Array<string> = []
      const missingRefReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot, { invokedMutantTests: invokedMissing }),
        {
          enforcementMode: "strict",
          baseRef: "nonexistent-branch",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: t1,
        },
      )
      expect(missingRefReport.passed).toBe(true)
      expect(missingRefReport.stackedBaseVerified).toBe(false)
      expect(missingRefReport.stackedBaseRef).toBeUndefined()
      expect(invokedMissing).toContain(fixture.testA)
      expect(invokedMissing).toContain(fixture.testB)

      // Non-ancestor sibling branch also fails closed to main (clear cache again so direct eval is observed)
      rmSync(join(fixture.repoRoot, ".harness", "cache", MUTATION_CACHE_FILENAME), { force: true })
      runGit(fixture.repoRoot, ["checkout", "main"])
      runGit(fixture.repoRoot, ["checkout", "-b", "sibling"])
      writeFileSync(
        join(fixture.repoRoot, "libs", "sample", "domain", "src", "sib.ts"),
        "export const sib = (x: number): number => x + 1\n",
        "utf8",
      )
      runGit(fixture.repoRoot, ["add", "-A"])
      runGit(fixture.repoRoot, ["commit", "-m", "sibling commit"])
      runGit(fixture.repoRoot, ["checkout", "child"])

      const invokedSibling: Array<string> = []
      const siblingReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot, { invokedMutantTests: invokedSibling }),
        {
          enforcementMode: "strict",
          baseRef: "sibling",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: t1,
        },
      )
      expect(siblingReport.passed).toBe(true)
      expect(siblingReport.stackedBaseVerified).toBe(false)
      expect(siblingReport.stackedBaseRef).toBeUndefined()
      expect(invokedSibling).toContain(fixture.testA)

      // Unclassified modified file in main...parent fails closed in strict mode (REQ-5.3)
      runGit(fixture.repoRoot, ["checkout", "parent"])
      mkdirSync(join(fixture.repoRoot, "libs", "unknown", "misc", "src"), { recursive: true })
      writeFileSync(
        join(fixture.repoRoot, "libs", "unknown", "misc", "src", "extra.ts"),
        "export const extra = 1\n",
        "utf8",
      )
      runGit(fixture.repoRoot, ["add", "-A"])
      runGit(fixture.repoRoot, ["commit", "-m", "unclassified ancestor file"])
      runGit(fixture.repoRoot, ["checkout", "-b", "child-unclassified"])
      writeFileSync(
        join(fixture.repoRoot, fixture.relB),
        "export const isSameB = (a: number, b: number): boolean => a === b\n",
        "utf8",
      )
      writeFileSync(
        join(fixture.repoRoot, fixture.testB),
        'import { expect, it } from "vitest"\nimport { isSameB } from "../src/b.js"\nit("b", () => { expect(isSameB(2, 2)).toBe(true) })\n',
        "utf8",
      )
      runGit(fixture.repoRoot, ["add", "-A"])
      runGit(fixture.repoRoot, ["commit", "-m", "child on unclassified parent"])

      const unclassifiedReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot),
        {
          enforcementMode: "strict",
          baseRef: "parent",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: t1,
        },
      )
      expect(unclassifiedReport.passed).toBe(false)
      expect(unclassifiedReport.diagnostic).toContain("Unclassified modified lib file(s)")
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-5.3: warm batch enforces isolate:true despite HARNESS_MUTATE_WARM_ISOLATE=0/HARNESS_WARM_ISOLATE=0 and --base main (DirectMain) verifies cleanly", () => {
    const isoDir = mkdtempSync(join(tmpdir(), "stacked-isolate-"))
    try {
      mkdirSync(join(isoDir, "libs", "demo", "core", "src"), { recursive: true })
      mkdirSync(join(isoDir, "libs", "demo", "core", "test"), { recursive: true })
      writeFileSync(join(isoDir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
      writeFileSync(
        join(isoDir, "libs", "demo", "core", "package.json"),
        JSON.stringify({ name: "@demo/core", nx: { tags: ["type:core"] } }),
        "utf8",
      )
      symlinkSync(join(REPO_ROOT, "node_modules"), join(isoDir, "node_modules"), "dir")
      symlinkSync(join(REPO_ROOT, "tools"), join(isoDir, "tools"), "dir")

      const cacheModRel = "libs/demo/core/src/mod-cache.ts"
      const targetRel = "libs/demo/core/src/target.ts"
      const testRel = "libs/demo/core/test/target.test.ts"
      writeFileSync(
        join(isoDir, cacheModRel),
        [
          "const seen = new Set<string>()",
          "export const checkOnce = (k: string): boolean => {",
          "  const existed = seen.has(k)",
          "  seen.add(k)",
          "  return existed",
          "}",
        ].join("\n"),
        "utf8",
      )
      const targetSrc = [
        "export const evalA = (n: number): number => n + 1",
        "export const evalSurv = (n: number): number => n - 1",
      ].join("\n")
      writeFileSync(join(isoDir, targetRel), targetSrc, "utf8")
      writeFileSync(
        join(isoDir, testRel),
        [
          'import { expect, it } from "vitest"',
          'import { checkOnce } from "../src/mod-cache.js"',
          'import { evalA, evalSurv } from "../src/target.js"',
          'it("fresh module state per mutant", () => {',
          '  expect(checkOnce("a")).toBe(false)',
          "  expect(evalA(2)).toBe(3)",
          '  expect(typeof evalSurv).toBe("function")',
          "})",
        ].join("\n"),
        "utf8",
      )

      const mutants = discoverDomainMutants(targetRel, targetSrc)
      const mod = compileMutantSchemaModule(targetRel, targetSrc, mutants)
      const batchRes = runPackageMutantBatchChecked({
        repoRoot: isoDir,
        pkgKey: "demo/core",
        backupPath: join(isoDir, ".harness", "mutation-backup.json"),
        hostIo: testHostIo,
        baseSubprocessEnv: {
          ...process.env,
          HARNESS_MUTATE_WARM_ISOLATE: "0",
          HARNESS_WARM_ISOLATE: "0",
          HARNESS_MUTATE_CONCURRENCY: "1",
        },
        allPackageTests: [testRel],
        files: [
          {
            file: {
              scope: "demo",
              pkgDir: "core",
              pkgName: "@demo/core",
              tier: "core",
              fullPath: join(isoDir, targetRel),
              relFile: targetRel,
            },
            originalContent: targetSrc,
            schemaSource: mod.schemaSource,
            mutants,
            uncachedMutants: mutants,
            primaryTests: [testRel],
            scopedFallbackTests: [],
            packageFallbackTests: [],
            fallbackTests: [],
            cachedHitIds: new Set<string>(),
          },
        ],
      })
      match(batchRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => expect.unreachable(diagnostic))
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          expect(fileResults).toHaveLength(1)
          const outcomes = Array.from(fileResults[0]!.fileOutcomes.values())
          const killed = outcomes.filter((o) => o.status === "killed")
          const survived = outcomes.filter((o) => o.status === "survived")
          expect(killed.length).toBeGreaterThanOrEqual(1)
          expect(survived.length).toBeGreaterThanOrEqual(1)
        })
        .exhaustive()
    } finally {
      rmSync(isoDir, { recursive: true, force: true })
    }

    const fixture = createStackedGitFixture()
    try {
      const t1 = MutationEpochMillis.make(Date.parse("2026-11-25T10:00:00.000Z"))
      const report = runDomainMutationSuite(fixture.repoRoot, makeVitestMockIo(fixture.repoRoot), {
        enforcementMode: "strict",
        baseRef: "main",
        explicitBaseRef: true,
        cacheAuth: TEST_CACHE_AUTH,
        nowMs: t1,
      })
      expect(report.passed).toBe(true)
      expect(report.stackedBaseVerified).toBe(true)
      expect(report.stackedBaseRef).toBe("main")
      expect(report.ancestorVerifiedMutantCount).toBe(0)
      expect(report.ancestorExpandedMutantCount).toBe(0)
      expect(report.diffMatchedFiles).toContain(fixture.relA)
      expect(report.diffMatchedFiles).toContain(fixture.relB)
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it("REQ-5.1 & REQ-5.2: child edits to ancestor file expand all ancestor lines without duplicate outcomes, and comment-only child passes with zero Vitest runs", () => {
    const fixture = createStackedGitFixture()
    try {
      const t1 = MutationEpochMillis.make(Date.parse("2026-11-25T10:00:00.000Z"))
      seedParentCacheOnBranch(fixture, t1)

      // Child branch with comment-only edit in b.ts (0 child mutants) -> 0 Vitest runs, passes via verified ancestor
      runGit(fixture.repoRoot, ["checkout", "parent"])
      runGit(fixture.repoRoot, ["checkout", "-b", "child-no-mutants"])
      writeFileSync(
        join(fixture.repoRoot, fixture.relB),
        "// comment only\nexport type Empty = 1\n",
      )
      runGit(fixture.repoRoot, ["add", "-A"])
      runGit(fixture.repoRoot, ["commit", "-m", "comment only child"])

      const invokedCommentChild: Array<string> = []
      const commentChildReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot, { invokedMutantTests: invokedCommentChild }),
        {
          enforcementMode: "strict",
          baseRef: "parent",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: MutationEpochMillis.make(Date.parse("2026-11-25T10:05:00.000Z")),
        },
      )
      expect(commentChildReport.passed).toBe(true)
      expect(commentChildReport.stackedBaseVerified).toBe(true)
      expect(commentChildReport.ancestorVerifiedMutantCount ?? 0).toBeGreaterThan(0)
      expect(invokedCommentChild).toHaveLength(0)

      // Child edits a.ts directly -> expands ancestor lines of a.ts into single pass with zero duplicates
      writeFileSync(
        join(fixture.repoRoot, fixture.relA),
        [
          "export const isSameA = (a: number, b: number): boolean => a === b",
          "export const isPosA = (x: number): boolean => x > 0",
          "",
        ].join("\n"),
        "utf8",
      )
      const childEditReport = runDomainMutationSuite(
        fixture.repoRoot,
        makeVitestMockIo(fixture.repoRoot),
        {
          enforcementMode: "strict",
          baseRef: "parent",
          explicitBaseRef: true,
          cacheAuth: TEST_CACHE_AUTH,
          nowMs: MutationEpochMillis.make(Date.parse("2026-11-25T10:06:00.000Z")),
        },
      )
      expect(childEditReport.passed).toBe(true)
      expect(childEditReport.ancestorVerifiedMutantCount).toBe(0)
      expect(childEditReport.ancestorExpandedMutantCount ?? 0).toBeGreaterThan(0)
      expect(childEditReport.evaluatedFiles).toEqual([fixture.relA])
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-5.1 Security: rejects option-injection and control-char base refs and propagates git merge-base errors into FallbackToMain", () => {
    const fixture = createStackedGitFixture()
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      for (const badRef of ["--exec=echo", "--output=/tmp/x", "parent\0bad", "parent\nbad"]) {
        const res = resolveStackedBaseContext({
          repoRoot: fixture.repoRoot,
          parentRef: badRef,
          hostIo: isolatedTestHostIo,
        })
        match(res)
          .with({ _tag: "FallbackToMain" }, ({ reason }) => {
            expect(reason).toBe("invalid base ref")
          })
          .with({ _tag: "DirectMain" }, { _tag: "Stacked" }, { _tag: "Failed" }, (other) =>
            expect.unreachable(`Expected FallbackToMain for ${badRef}, got ${other._tag}`),
          )
          .exhaustive()
      }

      const exitedErrorIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: () => ({
          _tag: "Exited",
          exitCode: 128,
          stdout: "",
          stderr: "fatal: bad object",
        }),
      }
      const timedOutIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: () => ({ _tag: "TimedOut", stdout: "", stderr: "" }),
      }
      const signaledIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: () => ({ _tag: "Signaled", signal: "SIGKILL", stdout: "", stderr: "" }),
      }
      const spawnFailedIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: () => ({
          _tag: "SpawnFailed",
          spawnError: "ENOENT",
          stdout: "",
          stderr: "",
        }),
      }
      const throwingIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: () => {
          throw new Error("boom")
        },
      }
      for (const io of [exitedErrorIo, timedOutIo, signaledIo, spawnFailedIo, throwingIo]) {
        const anc = checkGitAncestorCommit(fixture.repoRoot, io, "parent", "HEAD")
        expect(anc._tag).toBe("Error")
      }

      const mergeBaseFailIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (cmd, args, opts) => {
          if (cmd === "git" && args.includes("merge-base") && args.includes("--is-ancestor")) {
            return {
              _tag: "Exited",
              exitCode: 128,
              stdout: "",
              stderr: "fatal: corrupt commit graph",
            }
          }
          return isolatedTestHostIo.execFileSync(cmd, args, opts)
        },
      }
      const mergeBaseRes = resolveStackedBaseContext({
        repoRoot: fixture.repoRoot,
        parentRef: "parent",
        hostIo: mergeBaseFailIo,
      })
      match(mergeBaseRes)
        .with({ _tag: "FallbackToMain" }, ({ reason }) => {
          expect(reason).toContain("git merge-base error:")
        })
        .with({ _tag: "DirectMain" }, { _tag: "Stacked" }, { _tag: "Failed" }, (other) =>
          expect.unreachable(`Expected FallbackToMain, got ${other._tag}`),
        )
        .exhaustive()
    } finally {
      process.stderr.write = origWrite
      rmSync(fixture.repoRoot, { recursive: true, force: true })
    }
  })
})
