import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Redacted, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  MUTATION_TEST_TIMINGS_FILENAME,
  MUTATION_TEST_TIMINGS_SCHEMA_VERSION,
  MutationCacheHmacSecret,
  MutationCacheTimestamp,
  MutationEpochMillis,
  MutationTestTimingKey,
  type MutationTestTimingsStore,
  PackageRelKey,
  TestTimingDurationMs,
  TestTimingSampleCount,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { runDomainMutationSuite } from "../src/mutation-check.js"
import {
  compileMutantSchemaModule,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import { recoverBackupIfPresent, writeMutationBackup } from "../src/mutation/mutation-backup.js"
import {
  type PackageBatchFileInput,
  mergeObservedDurationsIntoMap,
  recordStageOutcomes,
  validateBatchArtifactPath,
  writePackageBatchPlan,
} from "../src/mutation/mutation-batch-stream.js"
import { validateHarnessCacheFileSafety } from "../src/mutation/mutation-cache.js"
import {
  type QueuedPackageEntry,
  executeQueuedPackageBatches,
  runPackageMutantBatchChecked,
} from "../src/mutation/mutation-package-batch.js"
import { preparePackageBaselines } from "../src/mutation/mutation-suite-helpers.js"
import type { DomainFile } from "../src/mutation/mutation-target-discovery.js"
import {
  buildPackageReachabilityIndexChecked,
  partitionEligibleTestsChecked,
  selectReachabilityPartition,
} from "../src/mutation/mutation-test-reachability.js"
import {
  buildTimingEntryKey,
  createSuiteTimingsTracker,
  emptyMutationTestTimingsStore,
  loadMutationTestTimings,
  parseVitestBaselineTestDurations,
  recordObservedTestTimings,
  saveMutationTestTimingsAtomic,
} from "../src/mutation/mutation-test-timings.js"
import {
  PackageBatchFileOutputSchema,
  extractWitnessTestFileFromOutput,
} from "../src/mutation/mutation-witness.js"
import { isolatedTestHostIo } from "./helpers/test-host-io.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../../..")

const BatchPlanOutputSchema = Schema.fromJsonString(
  Schema.Struct({
    testDurationsMs: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
    maxWorkerRssBytes: Schema.optional(Schema.Finite),
    files: Schema.Array(
      Schema.Struct({ relFile: Schema.String, mutantIds: Schema.Array(Schema.String) }),
    ),
  }),
)

const exited = (exitCode: number, stdout: string, stderr = "") =>
  ({ _tag: "Exited", exitCode, stdout, stderr }) as const

const withTempDir = (prefix: string, fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const makeDomainFile = (root: string, pkgDir: string, relFile: string): DomainFile => ({
  scope: "demo",
  pkgDir,
  pkgName: `@demo/${pkgDir}`,
  tier: "core",
  fullPath: join(root, relFile),
  relFile,
})

const makeBatchFileInput = (
  dir: string,
  pkgDir: string,
  relFile: string,
  src: string,
  primaryTests: ReadonlyArray<string>,
): PackageBatchFileInput => {
  mkdirSync(dirname(join(dir, relFile)), { recursive: true })
  writeFileSync(join(dir, relFile), src, "utf8")
  const mutants = discoverDomainMutants(relFile, src)
  return {
    file: makeDomainFile(dir, pkgDir, relFile),
    originalContent: src,
    schemaSource: compileMutantSchemaModule(relFile, src, mutants).schemaSource,
    mutants,
    uncachedMutants: mutants,
    primaryTests,
    scopedFallbackTests: [],
    packageFallbackTests: [],
    fallbackTests: [],
    cachedHitIds: new Set<string>(),
  }
}

const setupBatchPkgRepo = (dir: string): void => {
  mkdirSync(join(dir, "libs/demo/core/src"), { recursive: true })
  mkdirSync(join(dir, "libs/demo/core/test"), { recursive: true })
  mkdirSync(join(dir, "node_modules/vitest"), { recursive: true })
  mkdirSync(join(dir, "tools"), { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
  writeFileSync(
    join(dir, "libs/demo/core/package.json"),
    JSON.stringify({ name: "@demo/core", nx: { tags: ["type:core"] } }),
    "utf8",
  )
  writeFileSync(join(dir, "node_modules/vitest/vitest.mjs"), "// stub\n", "utf8")
  writeFileSync(join(dir, "tools/package-vitest-batch.mjs"), "// stub\n", "utf8")
}

const runGit = (cwd: string, args: ReadonlyArray<string>): string =>
  match(isolatedTestHostIo.execFileSync("git", args, { cwd }))
    .with({ _tag: "Exited" }, (r) => {
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`)
      return r.stdout.trim()
    })
    .with({ _tag: "TimedOut" }, () => {
      throw new Error("git timed out")
    })
    .with({ _tag: "Signaled" }, (r) => {
      throw new Error(`git signaled: ${r.signal}`)
    })
    .with({ _tag: "SpawnFailed" }, (r) => {
      throw new Error(`git spawn failed: ${r.spawnError}`)
    })
    .exhaustive()

const makeTimingEntry = (
  pkgKey: PackageRelKey,
  relTestFile: AstSourceFilePath,
  emaMs: number,
  sampleCount: number,
) => ({
  pkgKey,
  relTestFile,
  contentSha256: computeContentSha256("test-content"),
  emaDurationMs: TestTimingDurationMs.make(emaMs),
  sampleCount: TestTimingSampleCount.make(sampleCount),
  updatedAt: MutationCacheTimestamp.make("2026-11-25T10:00:00.000Z"),
})

const unwrapPlan = (res: ReturnType<typeof writePackageBatchPlan>) =>
  match(res)
    .with({ _tag: "Ok" }, (ok) => ok)
    .with({ _tag: "Err" }, ({ diagnostic }) => expect.unreachable(diagnostic))
    .exhaustive()

const unwrapBatchAbort = (res: ReturnType<typeof runPackageMutantBatchChecked>): string =>
  match(res)
    .with({ _tag: "Abort" }, ({ diagnostic }) => diagnostic)
    .with({ _tag: "Ok" }, () => expect.unreachable("Expected Abort"))
    .exhaustive()

describe("mutation-spec0034-survivors: backup, path safety, batch stream, and cache", () => {
  it("recoverBackupIfPresent skips active backup when HARNESS_ACTIVE_BACKUP_PATH matches and recovers on mismatch", () => {
    withTempDir("spec0034-backup-", (dir) => {
      const targetPath = join(dir, "libs/demo/core/src/v.ts")
      mkdirSync(dirname(targetPath), { recursive: true })
      const backupPath = join(dir, ".harness/active-backup.json")
      const original = "export const v = (a: number, b: number): boolean => a === b\n"
      const mutated = "export const v = (a: number, b: number): boolean => a !== b\n"
      writeFileSync(targetPath, original, "utf8")
      expect(
        writeMutationBackup(dir, backupPath, targetPath, original, mutated, isolatedTestHostIo),
      ).toBeUndefined()
      writeFileSync(targetPath, mutated, "utf8")

      const envWith = (val: string): SyncHostIo => ({
        ...isolatedTestHostIo,
        getEnv: () => ({ ...isolatedTestHostIo.getEnv(), HARNESS_ACTIVE_BACKUP_PATH: val }),
      })
      expect(
        recoverBackupIfPresent(dir, backupPath, false, envWith(resolve(backupPath))),
      ).toBeUndefined()
      expect(existsSync(backupPath)).toBe(true)
      expect(readFileSync(targetPath, "utf8")).toBe(mutated)

      expect(
        recoverBackupIfPresent(dir, backupPath, false, envWith(`${resolve(backupPath)}-other`)),
      ).toBeUndefined()
      expect(existsSync(backupPath)).toBe(false)
      expect(readFileSync(targetPath, "utf8")).toBe(original)
    })
  })

  it("validateBatchArtifactPath validates existing files with undefined repoRoot and rejects realpath escapes", () => {
    withTempDir("spec0034-batch-path-undef-", (dir) => {
      withTempDir("spec0034-batch-outside-", (outsideDir) => {
        const validFile = join(dir, "valid.json")
        writeFileSync(validFile, "{}", "utf8")
        expect(validateBatchArtifactPath(undefined, validFile, isolatedTestHostIo)).toBeUndefined()
        expect(
          validateBatchArtifactPath(undefined, join(dir, "absent.json"), isolatedTestHostIo),
        ).toBeUndefined()
        expect(
          validateBatchArtifactPath(dir, join(outsideDir, "bad.json"), isolatedTestHostIo),
        ).toContain("escapes repoRoot")
        const escapedIo: SyncHostIo = {
          ...isolatedTestHostIo,
          realpathSync: (p) =>
            p === validFile ? join(outsideDir, "escaped.json") : isolatedTestHostIo.realpathSync(p),
        }
        expect(validateBatchArtifactPath(undefined, validFile, escapedIo)).toContain(
          "realpath escape detected",
        )
      })
    })
  })

  it("validateBatchArtifactPath walks deepest existing ancestor to resolvedRoot without escaping symlinked parent", () => {
    withTempDir("spec0034-batch-ancestors-", (base) => {
      withTempDir("spec0034-batch-anc-out-", (outside) => {
        const realParent = join(base, "real-parent")
        const repoRoot = join(realParent, "repo")
        mkdirSync(join(repoRoot, ".harness"), { recursive: true })
        const symParent = join(base, "sym-parent")
        symlinkSync(realParent, symParent, "dir")
        const repoViaSymParent = join(symParent, "repo")
        const leaf = ".harness/nonexistent-sub/plan.json"
        expect(
          validateBatchArtifactPath(
            repoViaSymParent,
            join(repoViaSymParent, leaf),
            isolatedTestHostIo,
          ),
        ).toBeUndefined()
        const escapeIo: SyncHostIo = {
          ...isolatedTestHostIo,
          realpathSync: (p) =>
            p === join(repoRoot, ".harness") ? outside : isolatedTestHostIo.realpathSync(p),
        }
        expect(validateBatchArtifactPath(repoRoot, join(repoRoot, leaf), escapeIo)).toContain(
          "realpath escape detected",
        )
      })
    })
  })

  it("mergeObservedDurationsIntoMap, recordStageOutcomes, and writePackageBatchPlan handle 0ms durations, stage witnesses, and optional plan fields", () => {
    const durations = new Map<string, number>()
    mergeObservedDurationsIntoMap(durations, { "a.test.ts": 0, "b.test.ts": -1 })
    expect(durations.get("a.test.ts")).toBe(0)
    expect(durations.has("b.test.ts")).toBe(false)

    withTempDir("spec0034-plan-fields-", (dir) => {
      const fileInput = makeBatchFileInput(
        dir,
        "core",
        "libs/demo/core/src/eq.ts",
        "export const eq = (a: number, b: number): boolean => a === b\n",
        ["libs/demo/core/test/a.test.ts"],
      )
      const m1 = fileInput.mutants[0]!
      const m2 = { ...m1, id: "eq.ts:999:0" as typeof m1.id }
      const witnessMap = new Map<string, AstSourceFilePath>()
      const witnessA = AstSourceFilePath.make("libs/demo/core/test/a.test.ts")
      recordStageOutcomes(
        [
          { mutant: m1, status: "killed" },
          { mutant: m2, status: "killed" },
        ],
        new Set(),
        new Map([[m1.id, witnessA]]),
        new Map(),
        new Set<string>(),
        witnessMap,
        true,
      )
      expect(witnessMap.get(m1.id)).toBe(witnessA)
      expect(witnessMap.has(m2.id)).toBe(false)

      const baseOpts = {
        repoRoot: dir,
        backupPath: join(dir, ".harness/backup.json"),
        vitestCliPath: join(dir, "node_modules/vitest/vitest.mjs"),
        hostIo: isolatedTestHostIo,
        allPackageTests: ["libs/demo/core/test/a.test.ts"],
        files: [fileInput],
      }
      const p0 = unwrapPlan(writePackageBatchPlan(baseOpts))
      const parsed0 = Schema.decodeSync(BatchPlanOutputSchema)(readFileSync(p0.planPath, "utf8"))
      expect("testDurationsMs" in parsed0).toBe(false)
      expect("maxWorkerRssBytes" in parsed0).toBe(false)

      const p1 = unwrapPlan(
        writePackageBatchPlan({
          ...baseOpts,
          measuredDurationsMs: { "libs/demo/core/test/a.test.ts": 15 },
          maxWorkerRssBytes: 1024,
        }),
      )
      const parsed1 = Schema.decodeSync(BatchPlanOutputSchema)(readFileSync(p1.planPath, "utf8"))
      expect(parsed1.testDurationsMs).toEqual({ "libs/demo/core/test/a.test.ts": 15 })
      expect(parsed1.maxWorkerRssBytes).toBe(1024)
    })
  })

  it("validateHarnessCacheFileSafety rejects a directory inside cacheDir when checkFileExists is true", () => {
    withTempDir("spec0034-cache-dir-", (dir) => {
      const subDir = join(dir, ".harness/cache/some-subdir")
      mkdirSync(subDir, { recursive: true })
      const reason = validateHarnessCacheFileSafety(dir, subDir, true, isolatedTestHostIo)
      expect(reason).toBeDefined()
      expect(reason).toContain("symlink or non-file")
    })
  })
})

describe("mutation-spec0034-survivors: package batch, stacked base, and baselines", () => {
  it("runPackageMutantBatchChecked records solo cold recheck witness for TimedOut batch mutant when witness exists", () => {
    withTempDir("spec0034-solo-witness-", (dir) => {
      setupBatchPkgRepo(dir)
      const relFile = "libs/demo/core/src/cmp.ts"
      const testA = "libs/demo/core/test/a.test.ts"
      const testB = "libs/demo/core/test/b.test.ts"
      const fileInput = makeBatchFileInput(
        dir,
        "core",
        relFile,
        "export const cmp = (a: number, b: number): boolean => a === b && b !== 0\n",
        [testA, testB],
      )
      const [m1, m2] = [fileInput.mutants[0]!, fileInput.mutants[1]!]
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (_cmd, _args, opts) => {
          if (opts?.env?.["HARNESS_PACKAGE_PLAN_FILE"] !== undefined) {
            return exited(
              0,
              JSON.stringify([
                {
                  relFile,
                  primaryResults: [
                    { id: m1.id, result: { _tag: "TimedOut", stdout: "", stderr: "" } },
                    { id: m2.id, result: { _tag: "TimedOut", stdout: "", stderr: "" } },
                  ],
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
              ]),
            )
          }
          return opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === m1.id
            ? exited(1, `FAIL  ${testA}\nTests  1 failed (1)\n`)
            : exited(1, "AssertionError: mismatch\nTests  1 failed (1)\n")
        },
      }
      const res = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath: join(dir, ".harness/active-backup.json"),
        hostIo: mockIo,
        baseSubprocessEnv: {},
        allPackageTests: [testA, testB],
        files: [{ ...fileInput, mutants: [m1, m2], uncachedMutants: [m1, m2] }],
      })
      match(res)
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          expect(fileResults[0]!.witnessByMutantId.get(m1.id)).toBe(AstSourceFilePath.make(testA))
          expect(fileResults[0]!.witnessByMutantId.has(m2.id)).toBe(false)
        })
        .with({ _tag: "Abort" }, ({ diagnostic }) => expect.unreachable(diagnostic))
        .exhaustive()
    })
  })

  it("runPackageMutantBatchChecked preserves runner diagnostic alongside CRITICAL backup recovery error", () => {
    withTempDir("spec0034-startup-rec-", (dir) => {
      setupBatchPkgRepo(dir)
      const fileInput = makeBatchFileInput(
        dir,
        "core",
        "libs/demo/core/src/f1.ts",
        "export const f1 = (a: number, b: number): boolean => a === b\n",
        ["libs/demo/core/test/f1.test.ts"],
      )
      const backupPath = join(dir, ".harness/active-backup.json")
      const runWithExit = (code: number) =>
        unwrapBatchAbort(
          runPackageMutantBatchChecked({
            repoRoot: dir,
            pkgKey: "demo/core",
            backupPath,
            hostIo: {
              ...isolatedTestHostIo,
              execFileSync: () => {
                mkdirSync(dirname(backupPath), { recursive: true })
                writeFileSync(backupPath, "{corrupt-backup", "utf8")
                return code === 0 ? exited(0, "[]") : exited(1, "", "worker crashed")
              },
            },
            baseSubprocessEnv: {},
            allPackageTests: ["libs/demo/core/test/f1.test.ts"],
            files: [fileInput],
          }),
        )
      expect(runWithExit(0).startsWith("[mutation-check] CRITICAL:")).toBe(true)
      const diag1 = runWithExit(1)
      expect(diag1).toContain("worker crashed")
      expect(diag1).toContain("; [mutation-check] CRITICAL:")
    })
  })

  it("executeQueuedPackageBatches stops immediately after single-file package when isEarlyStopped flips true", () => {
    withTempDir("spec0034-early-stop-", (dir) => {
      setupBatchPkgRepo(dir)
      const makeEntry = (pkgDir: string): QueuedPackageEntry => {
        const input = makeBatchFileInput(
          dir,
          pkgDir,
          `libs/demo/${pkgDir}/src/f.ts`,
          "export const f = (a: number, b: number): boolean => a === b\n",
          [`libs/demo/${pkgDir}/test/f.test.ts`],
        )
        return {
          pkgKey: `demo/${pkgDir}`,
          mutantKeys: new Map(input.mutants.map((m) => [m.id, computeContentSha256(m.id)])),
          input,
        }
      }
      const queuedByPkg = new Map<string, ReadonlyArray<QueuedPackageEntry>>([
        ["demo/pkgA", [makeEntry("pkgA")]],
        ["demo/pkgB", [makeEntry("pkgB")]],
      ])
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: () => exited(1, "FAIL  libs/demo/pkgA/test/f.test.ts\nTests  1 failed (1)\n"),
      }
      const backupPath = join(dir, ".harness/active-backup.json")

      const runQueue = (stopOnFinalize: boolean) => {
        let stopped = false
        let earlyChecks = 0
        const finalized: Array<string> = []
        const res = executeQueuedPackageBatches({
          repoRoot: dir,
          backupPath,
          hostIo: mockIo,
          baseSubprocessEnv: {},
          queuedByPkg,
          finalizeEntry: (entry) => {
            finalized.push(entry.pkgKey)
            if (stopOnFinalize) stopped = true
            return undefined
          },
          recordPartialOnAbort: () => {},
          isEarlyStopped: () => {
            earlyChecks += 1
            return stopped
          },
        })
        return { res, finalized, earlyChecks }
      }
      expect(runQueue(true)).toEqual({ res: undefined, finalized: ["demo/pkgA"], earlyChecks: 2 })
      expect(runQueue(false)).toEqual({
        res: undefined,
        finalized: ["demo/pkgA", "demo/pkgB"],
        earlyChecks: 4,
      })
    })
  })

  it("runDomainMutationSuite forwards stageAOnly to exclude or include fallback witness hits in stacked-base cache verification", () => {
    withTempDir("spec0034-stacked-stagea-", (repoRoot) => {
      runGit(repoRoot, ["init"])
      runGit(repoRoot, ["checkout", "-B", "main"])
      runGit(repoRoot, ["config", "user.email", "stacked@example.com"])
      runGit(repoRoot, ["config", "user.name", "Stacked Test"])
      mkdirSync(join(repoRoot, "libs/sample/domain/src"), { recursive: true })
      mkdirSync(join(repoRoot, "libs/sample/domain/test"), { recursive: true })
      writeFileSync(join(repoRoot, ".gitignore"), "/.harness/\n")
      writeFileSync(join(repoRoot, "tsconfig.base.json"), '{"compilerOptions":{}}\n')
      writeFileSync(
        join(repoRoot, "libs/sample/domain/package.json"),
        '{"name":"@sample/domain","nx":{"tags":["type:domain"]}}\n',
      )
      const writeMod = (srcRel: string, src: string, testRel: string, test: string) => {
        writeFileSync(join(repoRoot, srcRel), src)
        writeFileSync(join(repoRoot, testRel), test)
      }
      const testFallback = "libs/sample/domain/test/fallback.test.ts"
      writeMod(
        "libs/sample/domain/src/seed.ts",
        "export const seed = (x: number): number => x\n",
        "libs/sample/domain/test/seed.test.ts",
        'import { expect, it } from "vitest"\nimport { seed } from "../src/seed.js"\nit("s", () => { expect(seed(1)).toBe(1) })\n',
      )
      writeFileSync(
        join(repoRoot, testFallback),
        'import { expect, it } from "vitest"\nimport { seed } from "../src/seed.js"\nit("fb", () => { expect(seed(2)).toBe(2) })\n',
      )
      runGit(repoRoot, ["add", "-A"])
      runGit(repoRoot, ["commit", "-m", "init main"])

      const relA = "libs/sample/domain/src/a.ts"
      const testA = "libs/sample/domain/test/a.test.ts"
      runGit(repoRoot, ["checkout", "-b", "parent"])
      writeMod(
        relA,
        "export const isSameA = (a: number, b: number): boolean => a === b\n",
        testA,
        'import { expect, it } from "vitest"\nimport { isSameA } from "../src/a.js"\nit("a", () => { expect(isSameA(1, 1)).toBe(true) })\n',
      )
      runGit(repoRoot, ["add", "-A"])
      runGit(repoRoot, ["commit", "-m", "parent a"])

      const auth = {
        _tag: "Enabled" as const,
        hmacSecret: Redacted.make(
          MutationCacheHmacSecret.make("stacked-stagea-hmac-secret-0123456789abcdef"),
        ),
      }
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (cmd, args, execOpts) => {
          if (cmd === "git") return isolatedTestHostIo.execFileSync(cmd, args, execOpts)
          const testArgs = args
            .filter((a) => a.endsWith(".test.ts") || a.endsWith(".spec.ts"))
            .map((a) => relative(repoRoot, resolve(repoRoot, a)).replace(/\\/g, "/"))
          const activeId = execOpts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
          if (activeId === undefined) return exited(0, "Tests  1 passed (1)\n")
          if (activeId.startsWith(`${relA}:`) && !testArgs.includes(testFallback)) {
            return exited(0, "Tests  1 passed (1)\n")
          }
          const witness = testArgs.includes(testFallback) ? testFallback : (testArgs[0] ?? testA)
          return exited(1, `FAIL  ${witness}\nTests  1 failed (1)\n`)
        },
      }
      const runSuite = (baseRef: string, iso: string, stageAOnly?: boolean) =>
        runDomainMutationSuite(repoRoot, mockIo, {
          enforcementMode: "strict",
          baseRef,
          explicitBaseRef: true,
          ...(stageAOnly !== undefined ? { stageAOnly } : {}),
          cacheAuth: auth,
          nowMs: MutationEpochMillis.make(Date.parse(iso)),
        })

      expect(runSuite("main", "2026-11-25T10:00:00.000Z").passed).toBe(true)

      runGit(repoRoot, ["checkout", "-b", "child"])
      writeMod(
        "libs/sample/domain/src/b.ts",
        "export const isSameB = (a: number, b: number): boolean => a === b\n",
        "libs/sample/domain/test/b.test.ts",
        'import { expect, it } from "vitest"\nimport { isSameB } from "../src/b.js"\nit("b", () => { expect(isSameB(2, 2)).toBe(true) })\n',
      )
      runGit(repoRoot, ["add", "-A"])
      runGit(repoRoot, ["commit", "-m", "child b"])

      const stageATrue = runSuite("parent", "2026-11-25T10:01:00.000Z", true)
      expect(stageATrue.ancestorExpandedMutantCount ?? 0).toBeGreaterThan(0)
      expect(stageATrue.ancestorVerifiedMutantCount).toBe(0)

      const stageAOmitted = runSuite("parent", "2026-11-25T10:02:00.000Z")
      expect(stageAOmitted.passed).toBe(true)
      expect(stageAOmitted.ancestorVerifiedMutantCount ?? 0).toBeGreaterThan(0)
      expect(stageAOmitted.ancestorExpandedMutantCount).toBe(0)
    })
  })

  it("preparePackageBaselines forwards non-empty modifiedLines and skips baseline when no mutants fall on modified lines", () => {
    withTempDir("spec0034-baseline-lines-", (dir) => {
      setupBatchPkgRepo(dir)
      const f1Rel = "libs/demo/core/src/f1.ts"
      const f2Rel = "libs/demo/core/src/f2.ts"
      const runTestCase = (rel: string, imp: string, fnCall: string) =>
        `import { expect, it } from "vitest"\nimport { ${imp} } from "${rel}"\nit("t", () => { expect(${fnCall}).toBe(true) })\n`
      writeFileSync(
        join(dir, f1Rel),
        "// comment\nexport const f1 = (a: number, b: number): boolean => a === b\n",
      )
      writeFileSync(
        join(dir, f2Rel),
        "// comment\nexport const f2 = (a: number, b: number): boolean => a !== b\n",
      )
      writeFileSync(
        join(dir, "libs/demo/core/test/f1.test.ts"),
        runTestCase("../src/f1.js", "f1", "f1(1, 1)"),
      )
      writeFileSync(
        join(dir, "libs/demo/core/test/f2.test.ts"),
        runTestCase("../src/f2.js", "f2", "f2(1, 2)"),
      )

      let execCalls = 0
      const countingIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: () => {
          execCalls += 1
          return exited(0, "Tests  2 passed (2)\n")
        },
      }
      const targets = [makeDomainFile(dir, "core", f1Rel), makeDomainFile(dir, "core", f2Rel)]
      const unwrapBase = (diffLinesMap: ReadonlyMap<string, ReadonlySet<number>>) =>
        match(
          preparePackageBaselines({
            repoRoot: dir,
            targets,
            hostIo: countingIo,
            baseSubprocessEnv: {},
            diffLinesMap,
            bypassDiffFilter: false,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "ReadError" }, ({ reason }) => expect.unreachable(reason))
          .exhaustive()

      const commentOnly = unwrapBase(
        new Map([
          [f1Rel, new Set([1])],
          [f2Rel, new Set([1])],
        ]),
      )
      expect(commentOnly.passedPackageBaselines.size).toBe(0)
      expect(commentOnly.partitionCache.size).toBe(0)
      expect(execCalls).toBe(0)

      const emptyLines = unwrapBase(
        new Map([
          [f1Rel, new Set<number>()],
          [f2Rel, new Set<number>()],
        ]),
      )
      expect(emptyLines.passedPackageBaselines.has("demo/core")).toBe(true)
      expect(execCalls).toBe(1)
    })
  })

  it("preparePackageBaselines logs a stderr warning and excludes pkgKey when batched baseline fails across >= 2 files", () => {
    withTempDir("spec0034-baseline-fail-", (dir) => {
      setupBatchPkgRepo(dir)
      const f1Rel = "libs/demo/core/src/f1.ts"
      const f2Rel = "libs/demo/core/src/f2.ts"
      writeFileSync(join(dir, f1Rel), "export const f1 = (a: number, b: number) => a === b\n")
      writeFileSync(join(dir, f2Rel), "export const f2 = (a: number, b: number) => a !== b\n")
      writeFileSync(
        join(dir, "libs/demo/core/test/f1.test.ts"),
        'import { expect, it } from "vitest"\nimport { f1 } from "../src/f1.js"\nit("t", () => { expect(f1(1, 1)).toBe(true) })\n',
      )
      writeFileSync(
        join(dir, "libs/demo/core/test/f2.test.ts"),
        'import { expect, it } from "vitest"\nimport { f2 } from "../src/f2.js"\nit("t", () => { expect(f2(1, 2)).toBe(true) })\n',
      )

      const failingIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: () => exited(1, "FAIL libs/demo/core/test/f1.test.ts\n", "baseline boom"),
      }
      const chunks: Array<string> = []
      const origWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
        return true
      }) as typeof process.stderr.write
      try {
        const res = match(
          preparePackageBaselines({
            repoRoot: dir,
            targets: [makeDomainFile(dir, "core", f1Rel), makeDomainFile(dir, "core", f2Rel)],
            hostIo: failingIo,
            baseSubprocessEnv: {},
            diffLinesMap: undefined,
            bypassDiffFilter: true,
          }),
        )
          .with({ _tag: "Ok" }, (ok) => ok)
          .with({ _tag: "ReadError" }, ({ reason }) => expect.unreachable(reason))
          .exhaustive()
        expect(res.passedPackageBaselines.has("demo/core")).toBe(false)
      } finally {
        process.stderr.write = origWrite
      }
      expect(chunks.join("")).toContain("[mutation-check] Warning: Batched package baseline")
    })
  })
})

describe("mutation-spec0034-survivors: reachability sorting, timings store, and witness extraction", () => {
  it("selectReachabilityPartition sorts symbolMatchedTests by measured duration when duration map is provided", () => {
    withTempDir("spec0034-reach-sym-", (dir) => {
      mkdirSync(join(dir, "libs/demo/core/src"), { recursive: true })
      mkdirSync(join(dir, "libs/demo/core/test"), { recursive: true })
      const relTarget = "libs/demo/core/src/target.ts"
      const testA = join(dir, "libs/demo/core/test/a.test.ts")
      const testB = join(dir, "libs/demo/core/test/b.test.ts")
      writeFileSync(join(dir, relTarget), "export const x = 1\n", "utf8")
      writeFileSync(testA, `${"// line\n".repeat(30)}export const a = 1\n`, "utf8")
      writeFileSync(testB, "export const b = 1\n", "utf8")
      match(
        buildPackageReachabilityIndexChecked(
          dir,
          "libs/demo/core",
          "@demo/core",
          [testA, testB],
          isolatedTestHostIo,
        ),
      )
        .with({ _tag: "Ok" }, ({ index }) => {
          expect(
            selectReachabilityPartition({
              index,
              targetRelFile: relTarget,
              eligibleTests: [testA, testB],
              directStemTests: [],
              symbolMatchedTests: [testA, testB],
              measuredDurationMsByAbsPath: new Map([
                [testA, 500],
                [testB, 10],
              ]),
            }).primaryTests,
          ).toEqual([testB, testA])
          expect(
            selectReachabilityPartition({
              index,
              targetRelFile: relTarget,
              eligibleTests: [testA, testB],
              directStemTests: [],
              symbolMatchedTests: [testA, testB],
            }).primaryTests,
          ).toEqual([testA, testB])
        })
        .with({ _tag: "Error" }, ({ reason }) => expect.unreachable(reason))
        .exhaustive()
    })
  })

  it("partitionEligibleTestsChecked sorts 2-test packages by heavyDiff, measured duration, and tie-break", () => {
    withTempDir("spec0034-reach-2tests-", (dir) => {
      const aTest = join(dir, "libs/demo/core/test/a.test.ts")
      const zTest = join(dir, "libs/demo/core/test/z.test.ts")
      const policyTest = join(dir, "libs/demo/core/test/policy-check.test.ts")
      const base = {
        repoRoot: dir,
        pkgDirRel: "libs/demo/core",
        pkgName: "@demo/core",
        relFile: "libs/demo/core/src/mod.ts",
        sourceContent: "export const m = 1\n",
        hostIo: isolatedTestHostIo,
      }
      const expectPrimary = (
        allTests: ReadonlyArray<string>,
        expected: ReadonlyArray<string>,
        measuredDurationMsByAbsPath?: ReadonlyMap<string, number>,
      ) =>
        match(partitionEligibleTestsChecked({ ...base, allTests, measuredDurationMsByAbsPath }))
          .with({ _tag: "Ok" }, ({ partition }) => expect(partition.primaryTests).toEqual(expected))
          .with({ _tag: "Error" }, ({ reason }) => expect.unreachable(reason))
          .exhaustive()
      expectPrimary([zTest, aTest], [zTest, aTest])
      expectPrimary(
        [aTest, zTest],
        [zTest, aTest],
        new Map([
          [aTest, 100],
          [zTest, 10],
        ]),
      )
      expectPrimary(
        [zTest, aTest],
        [aTest, zTest],
        new Map([
          [aTest, 50],
          [zTest, 50],
        ]),
      )
      expectPrimary([policyTest, zTest], [zTest, policyTest], new Map([[zTest, 50]]))
    })
  })

  it("saveMutationTestTimingsAtomic merges equal timestamp+sampleCount and evicts deterministically above 4096 entries", () => {
    withTempDir("spec0034-timings-merge-", (dir) => {
      const pkgKey = PackageRelKey.make("demo/core")
      const rel = AstSourceFilePath.make("libs/demo/core/test/a.test.ts")
      const key = buildTimingEntryKey(pkgKey, rel)
      const makeStore = (emaMs: number, sampleCount: number): MutationTestTimingsStore => ({
        version: MUTATION_TEST_TIMINGS_SCHEMA_VERSION,
        entries: { [key]: makeTimingEntry(pkgKey, rel, emaMs, sampleCount) },
      })
      expect(saveMutationTestTimingsAtomic(dir, makeStore(111, 3), isolatedTestHostIo)).toBe(true)
      expect(saveMutationTestTimingsAtomic(dir, makeStore(222, 3), isolatedTestHostIo)).toBe(true)
      expect(loadMutationTestTimings(dir, isolatedTestHostIo).entries[key]?.emaDurationMs).toBe(222)
      expect(saveMutationTestTimingsAtomic(dir, makeStore(333, 2), isolatedTestHostIo)).toBe(true)
      expect(loadMutationTestTimings(dir, isolatedTestHostIo).entries[key]?.emaDurationMs).toBe(222)

      withTempDir("spec0034-timings-cap-", (capDir) => {
        const capEntries: Record<
          MutationTestTimingKey,
          MutationTestTimingsStore["entries"][MutationTestTimingKey]
        > = {}
        for (let i = 4097; i >= 0; i -= 1) {
          const r = AstSourceFilePath.make(
            `libs/demo/core/test/t${String(i).padStart(4, "0")}.test.ts`,
          )
          capEntries[buildTimingEntryKey(pkgKey, r)] = makeTimingEntry(pkgKey, r, 10, 1)
        }
        expect(
          saveMutationTestTimingsAtomic(
            capDir,
            { version: MUTATION_TEST_TIMINGS_SCHEMA_VERSION, entries: capEntries },
            isolatedTestHostIo,
          ),
        ).toBe(true)
        const loaded = loadMutationTestTimings(capDir, isolatedTestHostIo)
        expect(Object.keys(loaded.entries).length).toBe(4096)
        const tKey = (p: string) => buildTimingEntryKey(pkgKey, AstSourceFilePath.make(p))
        expect(Object.hasOwn(loaded.entries, tKey("libs/demo/core/test/t0000.test.ts"))).toBe(true)
        expect(Object.hasOwn(loaded.entries, tKey("libs/demo/core/test/t4097.test.ts"))).toBe(false)
      })
    })
  })

  it("saveMutationTestTimingsAtomic rejects non-file targets and encode failures, and cleans tmp on renameSync throw", () => {
    withTempDir("spec0034-timings-fail-", (dir) => {
      withTempDir("spec0034-timings-out-", (outside) => {
        const cacheDir = join(dir, ".harness/cache")
        const timingsFile = join(cacheDir, MUTATION_TEST_TIMINGS_FILENAME)
        mkdirSync(timingsFile, { recursive: true })
        expect(
          saveMutationTestTimingsAtomic(dir, emptyMutationTestTimingsStore(), isolatedTestHostIo),
        ).toBe(false)
        rmSync(timingsFile, { recursive: true, force: true })

        const outsideFile = join(outside, "ext.json")
        writeFileSync(outsideFile, "{}", "utf8")
        symlinkSync(outsideFile, timingsFile)
        expect(
          saveMutationTestTimingsAtomic(dir, emptyMutationTestTimingsStore(), isolatedTestHostIo),
        ).toBe(false)
        rmSync(timingsFile, { force: true })

        const pkgKey = PackageRelKey.make("demo/core")
        const badKey = MutationTestTimingKey.make(`${pkgKey}::libs/demo/core/test/other.test.ts`)
        const badStore: MutationTestTimingsStore = {
          version: MUTATION_TEST_TIMINGS_SCHEMA_VERSION,
          entries: {
            [badKey]: makeTimingEntry(
              pkgKey,
              AstSourceFilePath.make("libs/demo/core/test/a.test.ts"),
              10,
              1,
            ),
          },
        }
        expect(saveMutationTestTimingsAtomic(dir, badStore, isolatedTestHostIo)).toBe(false)

        const throwRenameIo: SyncHostIo = {
          ...isolatedTestHostIo,
          renameSync: () => {
            throw new Error("disk full")
          },
        }
        expect(
          saveMutationTestTimingsAtomic(dir, emptyMutationTestTimingsStore(), throwRenameIo),
        ).toBe(false)
        expect(readdirSync(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([])
      })
    })
  })

  it("createSuiteTimingsTracker().flushIfDirty logs stderr warning when saving timings cache fails", () => {
    withTempDir("spec0034-timings-warn-", (dir) => {
      withTempDir("spec0034-timings-warn-out-", (outside) => {
        const testRel = "libs/demo/core/test/a.test.ts"
        mkdirSync(join(dir, "libs/demo/core/test"), { recursive: true })
        writeFileSync(join(dir, testRel), "export const a = 1\n", "utf8")
        const cacheDir = join(dir, ".harness", "cache")
        mkdirSync(cacheDir, { recursive: true })
        const outsideFile = join(outside, "ext.json")
        writeFileSync(outsideFile, "{}", "utf8")
        symlinkSync(outsideFile, join(cacheDir, MUTATION_TEST_TIMINGS_FILENAME))
        const tracker = createSuiteTimingsTracker(dir, isolatedTestHostIo)
        tracker.recordObserved("demo/core", { [testRel]: 42 }, 1000)
        const chunks: Array<string> = []
        const origWrite = process.stderr.write.bind(process.stderr)
        process.stderr.write = ((chunk: string | Uint8Array) => {
          chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
          return true
        }) as typeof process.stderr.write
        try {
          tracker.flushIfDirty()
        } finally {
          process.stderr.write = origWrite
        }
        expect(chunks.join("")).toContain(
          "[mutation-check] Warning: Failed to persist mutation test timings cache.",
        )
      })
    })
  })

  it("recordObservedTestTimings and parseVitestBaselineTestDurations accept epoch 0ms timestamps and 0ms durations", () => {
    withTempDir("spec0034-timings-zero-", (dir) => {
      const pkgKey = PackageRelKey.make("demo/core")
      const rel = "libs/demo/core/test/foo.test.ts"
      mkdirSync(join(dir, "libs/demo/core/test"), { recursive: true })
      writeFileSync(join(dir, rel), "export const x = 1\n", "utf8")
      const recAt = (nowMs: number) =>
        recordObservedTestTimings({
          repoRoot: dir,
          pkgKey,
          observedByRelOrAbs: { [rel]: 5 },
          store: emptyMutationTestTimingsStore(),
          nowMs,
          hostIo: isolatedTestHostIo,
        })
      const epochZero = recAt(0)
      expect(epochZero.dirty).toBe(true)
      expect(
        epochZero.store.entries[buildTimingEntryKey(pkgKey, AstSourceFilePath.make(rel))]
          ?.updatedAt,
      ).toBe(MutationCacheTimestamp.make("1970-01-01T00:00:00.000Z"))
      expect(recAt(-1).dirty).toBe(false)
      expect(parseVitestBaselineTestDurations(`✓ ${rel} (1 test) 0ms\n`, dir, [rel]).get(rel)).toBe(
        0,
      )
      expect(parseVitestBaselineTestDurations("", dir, [rel], 0).get(rel)).toBe(0)
      expect(parseVitestBaselineTestDurations("", dir, [rel], -1).size).toBe(0)
    })
  })

  it("extractWitnessTestFileFromOutput prefers explicitKillingTestFile over stdout FAIL lines when present in passTests", () => {
    withTempDir("spec0034-witness-explicit-", (dir) => {
      const pass = ["test/a.test.ts", "test/b.test.ts"]
      expect(
        extractWitnessTestFileFromOutput(
          dir,
          pass,
          "FAIL test/b.test.ts > fail",
          "",
          AstSourceFilePath.make("test/a.test.ts"),
        ),
      ).toBe(AstSourceFilePath.make("test/a.test.ts"))
      expect(
        extractWitnessTestFileFromOutput(
          dir,
          pass,
          "FAIL test/b.test.ts > fail",
          "",
          AstSourceFilePath.make("test/c.test.ts"),
        ),
      ).toBe(AstSourceFilePath.make("test/b.test.ts"))
    })
  })
})

const BatchFileReportsArraySchema = Schema.fromJsonString(
  Schema.Array(PackageBatchFileOutputSchema),
)

const buildBatchPlanFile = (
  dir: string,
  opts: {
    readonly files: ReadonlyArray<{
      readonly fileInput: PackageBatchFileInput
      readonly primaryTests?: ReadonlyArray<string>
      readonly scopedFallbackTests?: ReadonlyArray<string>
      readonly packageFallbackTests?: ReadonlyArray<string>
    }>
    readonly allPackageTests: ReadonlyArray<string>
    readonly streamReportPath: string
    readonly backupPath: string
    readonly maxSurvivors?: number
  },
): string => {
  const planPath = join(dir, "pkg-plan.json")
  writeFileSync(
    planPath,
    JSON.stringify({
      cwd: dir,
      backupPath: opts.backupPath,
      vitestCli: join(dir, "node_modules/vitest/vitest.mjs"),
      allPackageTests: opts.allPackageTests,
      baselinedTests: opts.allPackageTests.filter((t) => t.endsWith("primary.test.ts")),
      streamReportPath: opts.streamReportPath,
      ...(opts.maxSurvivors !== undefined ? { maxSurvivors: opts.maxSurvivors } : {}),
      files: opts.files.map((entry) => ({
        relFile: entry.fileInput.file.relFile,
        fullPath: entry.fileInput.file.fullPath,
        originalSha256: computeContentSha256(entry.fileInput.originalContent),
        mutatedSha256: computeContentSha256(entry.fileInput.schemaSource),
        originalSource: entry.fileInput.originalContent,
        schemaSource: entry.fileInput.schemaSource,
        primaryTests: entry.primaryTests ?? entry.fileInput.primaryTests,
        scopedFallbackTests: entry.scopedFallbackTests ?? entry.fileInput.scopedFallbackTests,
        packageFallbackTests: entry.packageFallbackTests ?? entry.fileInput.packageFallbackTests,
        mutantIds: entry.fileInput.uncachedMutants.map((m) => m.id),
        primaryTimeoutMs: 30_000,
        scopedFallbackTimeoutMs: 30_000,
        packageFallbackTimeoutMs: 30_000,
      })),
    }),
    "utf8",
  )
  return planPath
}

describe("mutation-spec0034-survivors: package-vitest-batch runner safety and schema contracts", () => {
  it("#1: fallback baseline failure with empty output and 300-char trailing-space output decodes cleanly through PackageBatchFileOutputSchema", () => {
    for (const mode of ["empty", "trailing-space"] as const) {
      withTempDir(`spec0034-fb-base-${mode}-`, (dir) => {
        setupBatchPkgRepo(dir)
        rmSync(join(dir, "tools"), { recursive: true, force: true })
        symlinkSync(join(REAL_REPO_ROOT, "tools"), join(dir, "tools"), "dir")
        const tPrimary = "libs/demo/core/test/primary.test.ts"
        const tFb =
          mode === "empty"
            ? "libs/demo/core/test/fb-empty.test.ts"
            : "libs/demo/core/test/fb-300space.test.ts"
        writeFileSync(join(dir, tPrimary), "// primary\n", "utf8")
        writeFileSync(join(dir, tFb), "// fallback\n", "utf8")
        writeFileSync(
          join(dir, "node_modules/vitest/vitest.mjs"),
          [
            "const args = process.argv.slice(2)",
            'if (args.some((a) => a.endsWith("primary.test.ts"))) {',
            '  console.log("Tests  1 passed (1)")',
            "  process.exit(0)",
            "}",
            'if (args.some((a) => a.endsWith("fb-empty.test.ts"))) {',
            "  process.exit(1)",
            "}",
            'if (args.some((a) => a.endsWith("fb-300space.test.ts"))) {',
            '  process.stderr.write("E".repeat(290) + "          extra-after-300")',
            "  process.exit(1)",
            "}",
            "process.exit(0)",
          ].join("\n"),
          "utf8",
        )
        const fileInput = makeBatchFileInput(
          dir,
          "core",
          "libs/demo/core/src/f1.ts",
          "export const f1 = (a: number, b: number): boolean => a === b\n",
          [tPrimary],
        )
        const planPath = buildBatchPlanFile(dir, {
          files: [{ fileInput, scopedFallbackTests: [tFb] }],
          allPackageTests: [tPrimary, tFb],
          streamReportPath: join(dir, "stream.ndjson"),
          backupPath: join(dir, "backup.json"),
        })
        const res = spawnSync(process.execPath, [join(dir, "tools/package-vitest-batch.mjs")], {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            HARNESS_PACKAGE_PLAN_FILE: planPath,
            HARNESS_MUTATE_USE_WARM_VITEST: "0",
          },
          timeout: 20_000,
        })
        expect(res.status, res.stderr).toBe(0)
        const reports = Schema.decodeSync(BatchFileReportsArraySchema)(res.stdout.trim())
        expect(reports).toHaveLength(1)
        const restoreErr = reports[0]!.restoreError
        expect(restoreErr).toBeDefined()
        if (mode === "empty") {
          expect(restoreErr).toBe(
            "[mutation-check] Baseline test suite failed on fallback tests for 'libs/demo/core/src/f1.ts' (1 file(s))",
          )
        } else {
          expect(restoreErr).toContain("E".repeat(290))
          expect(restoreErr).not.toContain("extra-after-300")
          expect(restoreErr).toBe(restoreErr!.trim())
        }
      })
    }
  })

  it("#7 & #9: pre-mutation disk SHA mismatch and symlinked target refuse mutation cleanly, and appendStreamReport failure after activeMutation=null does not crash", () => {
    withTempDir("spec0034-sha-sym-", (dir) => {
      setupBatchPkgRepo(dir)
      rmSync(join(dir, "tools"), { recursive: true, force: true })
      symlinkSync(join(REAL_REPO_ROOT, "tools"), join(dir, "tools"), "dir")
      const tPrimary = "libs/demo/core/test/primary.test.ts"
      writeFileSync(join(dir, tPrimary), "// primary\n", "utf8")
      writeFileSync(
        join(dir, "node_modules/vitest/vitest.mjs"),
        'console.log("Tests  1 passed (1)")\nprocess.exit(0)\n',
        "utf8",
      )

      const origSrc = "export const f1 = (a: number, b: number): boolean => a === b\n"
      const fileInput = makeBatchFileInput(dir, "core", "libs/demo/core/src/f1.ts", origSrc, [
        tPrimary,
      ])
      const streamBlocker = join(dir, "stream-blocker")
      writeFileSync(streamBlocker, "not-a-directory\n", "utf8")
      const shaPlanPath = buildBatchPlanFile(dir, {
        files: [{ fileInput }],
        allPackageTests: [tPrimary],
        streamReportPath: join(streamBlocker, "pkg-stream.ndjson"),
        backupPath: join(dir, "backup.json"),
      })
      const externalEdit = "// user edited before mutation\n"
      writeFileSync(fileInput.file.fullPath, externalEdit, "utf8")
      const shaRes = spawnSync(process.execPath, [join(dir, "tools/package-vitest-batch.mjs")], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_PACKAGE_PLAN_FILE: shaPlanPath,
          HARNESS_MUTATE_USE_WARM_VITEST: "0",
        },
        timeout: 20_000,
      })
      expect(shaRes.status, shaRes.stderr).toBe(0)
      expect(shaRes.stderr).toContain(
        "[package-vitest-batch] Warning: Failed to append stream report",
      )
      const shaReports = Schema.decodeSync(BatchFileReportsArraySchema)(shaRes.stdout.trim())
      expect(shaReports).toHaveLength(1)
      expect(shaReports[0]!.restoreError).toContain("Refusing to mutate")
      expect(shaReports[0]!.restoreError).toContain("does not match planned originalSha256")
      expect(readFileSync(fileInput.file.fullPath, "utf8")).toBe(externalEdit)

      const outsideTarget = join(dir, "outside-target.ts")
      writeFileSync(outsideTarget, origSrc, "utf8")
      rmSync(fileInput.file.fullPath, { force: true })
      symlinkSync(outsideTarget, fileInput.file.fullPath)
      const symPlanPath = buildBatchPlanFile(dir, {
        files: [{ fileInput }],
        allPackageTests: [tPrimary],
        streamReportPath: join(dir, "sym-stream.ndjson"),
        backupPath: join(dir, "sym-backup.json"),
      })
      const symRes = spawnSync(process.execPath, [join(dir, "tools/package-vitest-batch.mjs")], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_PACKAGE_PLAN_FILE: symPlanPath,
          HARNESS_MUTATE_USE_WARM_VITEST: "0",
        },
        timeout: 20_000,
      })
      expect(symRes.status, symRes.stderr).toBe(0)
      const symReports = Schema.decodeSync(BatchFileReportsArraySchema)(symRes.stdout.trim())
      expect(symReports).toHaveLength(1)
      expect(symReports[0]!.restoreError).toContain("Refusing to operate on symbolic link")
      expect(lstatSync(fileInput.file.fullPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(outsideTarget, "utf8")).toBe(origSrc)
    })
  })

  it("#9: SIGTERM mid-run restores original source on disk and countFileConfirmedSurvivors respects maxSurvivors across fallback stages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spec0034-sigterm-maxsurv-"))
    try {
      setupBatchPkgRepo(dir)
      rmSync(join(dir, "tools"), { recursive: true, force: true })
      symlinkSync(join(REAL_REPO_ROOT, "tools"), join(dir, "tools"), "dir")

      const tPrimary = "libs/demo/core/test/primary.test.ts"
      const tScoped = "libs/demo/core/test/scoped.test.ts"
      const tPkgFb = "libs/demo/core/test/pkgfb.test.ts"
      writeFileSync(join(dir, tPrimary), "// primary\n", "utf8")
      writeFileSync(join(dir, tScoped), "// scoped\n", "utf8")
      writeFileSync(join(dir, tPkgFb), "// pkgfb\n", "utf8")

      const readyFlag = join(dir, "mutant-active.flag")
      writeFileSync(
        join(dir, "node_modules/vitest/vitest.mjs"),
        [
          'import { writeFileSync } from "node:fs"',
          "const args = process.argv.slice(2)",
          'const readyFile = process.env["TEST_MUTANT_READY_FILE"] ?? ""',
          'const activeId = process.env["HARNESS_ACTIVE_MUTANT_ID"] ?? ""',
          "if (readyFile.length > 0 && activeId.length > 0) {",
          '  writeFileSync(readyFile, activeId, "utf8")',
          "  setInterval(() => {}, 1000)",
          '} else if (args.some((a) => a.endsWith("pkgfb.test.ts"))) {',
          '  if (process.env["TEST_KILL_IN_PKGFB"] === "1" && activeId.length > 0) {',
          '    console.log("Tests  1 failed (1)")',
          "    process.exit(1)",
          "  }",
          '  console.log("Tests  1 passed (1)")',
          "  process.exit(0)",
          "} else {",
          '  if (activeId.includes("f2.ts:")) {',
          '    console.log("Tests  1 failed (1)")',
          "    process.exit(1)",
          "  }",
          '  console.log("Tests  1 passed (1)")',
          "  process.exit(0)",
          "}",
        ].join("\n"),
        "utf8",
      )

      const origF1 = "export const f1 = (a: number, b: number): boolean => a === b\n"
      const origF2 = "export const f2 = (a: number, b: number): boolean => a !== b\n"
      const input1 = makeBatchFileInput(dir, "core", "libs/demo/core/src/f1.ts", origF1, [tPrimary])
      const input2 = makeBatchFileInput(dir, "core", "libs/demo/core/src/f2.ts", origF2, [tPrimary])

      // 1) SIGTERM mid-run restores original source and cleans backupPath
      const sigBackup = join(dir, "sig-backup.json")
      const sigPlanPath = buildBatchPlanFile(dir, {
        files: [{ fileInput: input1 }],
        allPackageTests: [tPrimary],
        streamReportPath: join(dir, "sig-stream.ndjson"),
        backupPath: sigBackup,
      })
      const child = spawn(process.execPath, [join(dir, "tools/package-vitest-batch.mjs")], {
        cwd: dir,
        env: {
          ...process.env,
          HARNESS_PACKAGE_PLAN_FILE: sigPlanPath,
          HARNESS_MUTATE_USE_WARM_VITEST: "0",
          TEST_MUTANT_READY_FILE: readyFlag,
        },
        stdio: ["ignore", "pipe", "pipe"],
      })
      const deadline = Date.now() + 10_000
      while (!existsSync(readyFlag)) {
        if (Date.now() > deadline) {
          child.kill("SIGKILL")
          throw new Error("Timed out waiting for package-vitest-batch mutant start")
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(readFileSync(input1.file.fullPath, "utf8")).toBe(input1.schemaSource)
      expect(existsSync(sigBackup)).toBe(true)
      child.kill("SIGTERM")
      const exitInfo = await new Promise<{ code: number | null; sig: NodeJS.Signals | null }>(
        (resolveExit) => {
          child.on("close", (code, sig) => resolveExit({ code, sig }))
        },
      )
      expect(exitInfo.code === 143 || exitInfo.sig === "SIGTERM").toBe(true)
      expect(readFileSync(input1.file.fullPath, "utf8")).toBe(origF1)
      expect(existsSync(sigBackup)).toBe(false)

      // 2) countFileConfirmedSurvivors stops after f1 when mutant survives scoped + package fallback (maxSurvivors: 1)
      const fbPlanPath = buildBatchPlanFile(dir, {
        files: [
          {
            fileInput: input1,
            scopedFallbackTests: [tScoped],
            packageFallbackTests: [tPkgFb],
          },
          {
            fileInput: input2,
            scopedFallbackTests: [tScoped],
            packageFallbackTests: [tPkgFb],
          },
        ],
        allPackageTests: [tPrimary, tScoped, tPkgFb],
        streamReportPath: join(dir, "fb-stream.ndjson"),
        backupPath: join(dir, "fb-backup.json"),
        maxSurvivors: 1,
      })
      const stopRes = spawnSync(process.execPath, [join(dir, "tools/package-vitest-batch.mjs")], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_PACKAGE_PLAN_FILE: fbPlanPath,
          HARNESS_MUTATE_USE_WARM_VITEST: "0",
        },
        timeout: 20_000,
      })
      expect(stopRes.status, stopRes.stderr).toBe(0)
      const stopReports = Schema.decodeSync(BatchFileReportsArraySchema)(stopRes.stdout.trim())
      expect(stopReports.map((r) => r.relFile)).toEqual(["libs/demo/core/src/f1.ts"])

      // 3) When packageFallbackTests kills f1's survivor, confirmedSurvivors stays 0 so f2 is evaluated
      const contRes = spawnSync(process.execPath, [join(dir, "tools/package-vitest-batch.mjs")], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_PACKAGE_PLAN_FILE: fbPlanPath,
          HARNESS_MUTATE_USE_WARM_VITEST: "0",
          TEST_KILL_IN_PKGFB: "1",
        },
        timeout: 20_000,
      })
      expect(contRes.status, contRes.stderr).toBe(0)
      const contReports = Schema.decodeSync(BatchFileReportsArraySchema)(contRes.stdout.trim())
      expect(contReports.map((r) => r.relFile)).toEqual([
        "libs/demo/core/src/f1.ts",
        "libs/demo/core/src/f2.ts",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("mutant-coverage-setup omits overlapped it.concurrent tests from perTestHits while keeping moduleHits and sequential perTestHits", () => {
    withTempDir("spec0034-cov-overlap-", (dir) => {
      const covOutDir = join(dir, "cov-out")
      mkdirSync(covOutDir, { recursive: true })
      symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
      writeFileSync(
        join(dir, "mod.ts"),
        [
          "export const recordHit = (id: string): string => {",
          '  const hits: unknown = Reflect.get(globalThis, "__HARNESS_MUTANT_HITS")',
          "  if (hits instanceof Set) hits.add(id)",
          "  return id",
          "}",
        ].join("\n"),
        "utf8",
      )
      const testFile = join(dir, "overlap.test.ts")
      writeFileSync(
        testFile,
        [
          'import { describe, expect, it } from "vitest"',
          'import { recordHit } from "./mod.js"',
          'describe("concurrent overlap", () => {',
          '  it.concurrent("conc-a", async () => {',
          '    recordHit("m-conc-a")',
          "    await new Promise((r) => setTimeout(r, 40))",
          '    expect(recordHit("m-conc-a-after")).toBe("m-conc-a-after")',
          "  })",
          '  it.concurrent("conc-b", async () => {',
          '    recordHit("m-conc-b")',
          "    await new Promise((r) => setTimeout(r, 40))",
          '    expect(recordHit("m-conc-b-after")).toBe("m-conc-b-after")',
          "  })",
          "})",
          'describe("sequential isolated", () => {',
          '  it("seq-only", () => {',
          '    expect(recordHit("m-seq")).toBe("m-seq")',
          "  })",
          "})",
        ].join("\n"),
        "utf8",
      )
      const configPath = join(dir, "vitest.config.mjs")
      const setupFile = join(REAL_REPO_ROOT, "tools/mutant-coverage-setup.mjs")
      writeFileSync(
        configPath,
        `export default { test: { setupFiles: [${JSON.stringify(setupFile)}] } }\n`,
        "utf8",
      )
      const res = spawnSync(
        process.execPath,
        [
          join(REAL_REPO_ROOT, "node_modules/vitest/vitest.mjs"),
          "run",
          "--root",
          dir,
          "--config",
          configPath,
          testFile,
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, HARNESS_COVERAGE_OUT_DIR: covOutDir },
          timeout: 30_000,
        },
      )
      expect(res.status, res.stderr).toBe(0)
      const files = readdirSync(covOutDir).filter((f) => f.endsWith(".json"))
      expect(files).toHaveLength(1)
      const CoverageReportSchema = Schema.fromJsonString(
        Schema.Struct({
          testFile: Schema.String,
          hits: Schema.Array(Schema.String),
          perTestHits: Schema.Array(
            Schema.Struct({
              testName: Schema.String,
              durationMs: Schema.Finite,
              hits: Schema.Array(Schema.String),
            }),
          ),
        }),
      )
      const report = Schema.decodeSync(CoverageReportSchema)(
        readFileSync(join(covOutDir, files[0]!), "utf8"),
      )
      expect(report.hits).toContain("m-conc-a")
      expect(report.hits).toContain("m-conc-b")
      expect(report.hits).toContain("m-seq")
      expect(
        report.perTestHits.some(
          (entry) => entry.testName.includes("conc-a") || entry.testName.includes("conc-b"),
        ),
      ).toBe(false)
      const seqEntry = report.perTestHits.find((entry) => entry.testName.includes("seq-only"))
      expect(seqEntry).toBeDefined()
      expect(seqEntry!.hits).toContain("m-seq")
      expect(Number.isFinite(seqEntry!.durationMs) && seqEntry!.durationMs > 0).toBe(true)
    })
  })
})
