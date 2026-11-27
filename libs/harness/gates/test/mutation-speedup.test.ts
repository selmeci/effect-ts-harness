import { fork, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  ContentSha256,
  MUTATION_CACHE_FILENAME,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  type MutationCacheAuth,
  MutationCacheHmacSecret,
  MutationCacheTimestamp,
  computeContentSha256,
} from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import { SelfDogfooding } from "../src/index.js"
import { resolveCommonVitestConfigPath } from "../src/mutation-subprocess-helpers.js"
import {
  type CodeMutant,
  compileMutantSchemaModule,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import { extractGitDiffModifiedLinesChecked } from "../src/mutation/mutation-backup.js"
import {
  computeMutationEntryMac,
  loadMutationCache,
  resolveLinkedWorktreeCommonRepoRoot,
  saveMutationCacheAtomic,
} from "../src/mutation/mutation-cache.js"
import { computeMutationContextDigestsChecked } from "../src/mutation/mutation-context-digest.js"
import {
  type PackageBatchFileResult,
  type QueuedPackageEntry,
  executeQueuedPackageBatches,
  runPackageMutantBatchChecked,
  runSingleFileVitestPass,
} from "../src/mutation/mutation-package-batch.js"
import {
  type DomainFile,
  partitionReachingTestFiles,
  partitionReachingTestFilesChecked,
} from "../src/mutation/mutation-target-discovery.js"
import {
  buildPackageReachabilityIndexChecked,
  getOrBuildPackageReachabilityIndexChecked,
  type PackageReachabilityIndex,
} from "../src/mutation/mutation-test-reachability.js"
import { isolatedTestHostIo, testHostIo } from "./helpers/test-host-io.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../../..")
const SHA_HEAD = "1111111111111111111111111111111111111111"
const SHA_LOCAL_MAIN = "2222222222222222222222222222222222222222"
const SHA_ORIGIN_MAIN = "3333333333333333333333333333333333333333"
const SHA_SIBLING = "4444444444444444444444444444444444444444"

const BatchResultJsonSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      result: Schema.Struct({
        _tag: Schema.String,
        exitCode: Schema.optional(Schema.Finite),
        stdout: Schema.optional(Schema.String),
        stderr: Schema.optional(Schema.String),
      }),
    }),
  ),
)

const fb = (tests: ReadonlyArray<string> = []) => ({
  scopedFallbackTests: tests,
  packageFallbackTests: [] as ReadonlyArray<string>,
  fallbackTests: tests,
})
const makeBatchFile = (
  dir: string,
  relFile: string,
  originalContent: string,
  schemaSource: string,
  mutants: ReadonlyArray<ReturnType<typeof discoverDomainMutants>[number]>,
  primaryTests: ReadonlyArray<string>,
  fallback: ReadonlyArray<string> = [],
) => ({
  file: makeMockFile(dir, relFile),
  originalContent,
  schemaSource,
  mutants,
  uncachedMutants: mutants,
  primaryTests,
  ...fb(fallback),
  cachedHitIds: new Set<string>(),
})
const emptyBatchEntry = (relFile: string) =>
  JSON.stringify([
    { relFile, primaryResults: [], scopedFallbackResults: [], packageFallbackResults: [] },
  ])

describe("mutation-speedup: hit hook & warm coverage-guided Vitest batch", () => {
  it.effect(
    "HOISTED_MUTANT_HELPER records executed mutant IDs into globalThis.__HARNESS_MUTANT_HITS and stays dogfood-clean",
    () =>
      Effect.gen(function* () {
        const src = [
          "export const check = (x: number): boolean => {",
          "  if (x >= 10) return true",
          "  return false",
          "}",
        ].join("\n")
        const mutants = discoverDomainMutants("libs/demo/domain/src/hit.ts", src)
        expect(mutants.length).toBeGreaterThanOrEqual(2)
        const bundle = compileMutantSchemaModule("libs/demo/domain/src/hit.ts", src, mutants)
        expect(bundle.schemaSource).toContain("__HARNESS_MUTANT_HITS")
        expect(bundle.schemaSource.split("\n").length).toBe(src.split("\n").length)

        const dogfood = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/demo/domain/src/hit.ts"),
              content: AstSourceContent.make(bundle.schemaSource),
            },
          ],
        })
        expect(dogfood.verdict).toBe("clean")

        const recorded = new Set<string>()
        const dir = mkdtempSync(join(tmpdir(), "mut-hit-exec-"))
        Reflect.set(globalThis, "__HARNESS_MUTANT_HITS", recorded)
        try {
          const transpiled = ts.transpileModule(bundle.schemaSource, {
            fileName: "hit.ts",
            compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
          }).outputText
          const modPath = join(dir, "hit.mjs")
          writeFileSync(modPath, transpiled, "utf8")
          const mod = (yield* Effect.promise(() => import(pathToFileURL(modPath).href))) as {
            readonly check: (x: number) => boolean
          }
          expect(mod.check(15)).toBe(true)
          expect(recorded.has("libs/demo/domain/src/hit.ts:2:>=->")).toBe(false)
          expect(recorded.size).toBeGreaterThanOrEqual(2)
          for (const m of mutants.filter((x) => x.line === 2)) {
            expect(recorded.has(m.id)).toBe(true)
          }
        } finally {
          Reflect.deleteProperty(globalThis, "__HARNESS_MUTANT_HITS")
          rmSync(dir, { recursive: true, force: true })
        }
      }),
  )

  it("warm Vitest pool runs coverage probe, kills top-level & targeted mutants, falls back for survivors, and supports cold mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "warm-batch-e2e-"))
    try {
      const modPath = join(dir, "calc.ts")
      const tA = join(dir, "a.test.ts")
      const tB = join(dir, "b.test.ts")
      writeFileSync(
        modPath,
        [
          'function __hMut(id: string): boolean { const g: object = globalThis; const hit: unknown = Reflect.get(g, "__HARNESS_MUTANT_HITS"); if (hit instanceof Set) hit.add(id); const env: unknown = Reflect.get(Reflect.get(g, "process"), "env"); return Reflect.get(env, "HARNESS_ACTIVE_MUTANT_ID") === id; }',
          'export const TOP = __hMut("m-top") ? 999 : 10',
          'export const addOne = (x: number) => (__hMut("m-a") ? x - 1 : x + 1)',
          'export const mulTwo = (x: number) => (__hMut("m-b") ? x + 2 : x * 2)',
          'export const unusedPath = (x: number) => (__hMut("m-surv") ? x - 10 : x)',
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        tA,
        [
          'import { expect, it } from "vitest"',
          'import { TOP, addOne } from "./calc.js"',
          'it("a", () => { expect(TOP + addOne(2)).toBe(13) })',
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        tB,
        [
          'import { expect, it } from "vitest"',
          'import { mulTwo } from "./calc.js"',
          'it("b", () => { expect(mulTwo(3)).toBe(6) })',
        ].join("\n"),
        "utf8",
      )

      const batchScript = fileURLToPath(
        new URL("../../../../tools/parallel-vitest-batch.mjs", import.meta.url),
      )
      const vitestCli = join(REAL_REPO_ROOT, "node_modules", "vitest", "vitest.mjs")

      const warmProc = spawnSync(process.execPath, [batchScript], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_MUTATE_CONCURRENCY: "2",
          HARNESS_BATCH_VITEST_CLI: vitestCli,
          HARNESS_BATCH_CWD: dir,
          HARNESS_BATCH_TIMEOUT_MS: "25000",
          HARNESS_BATCH_TESTS_JSON: JSON.stringify([tA, tB]),
          HARNESS_BATCH_MUTANTS_JSON: JSON.stringify(["m-top", "m-a", "m-b", "m-surv"]),
        },
      })
      expect(warmProc.status).toBe(0)
      const parsedWarm = Schema.decodeSync(BatchResultJsonSchema)(warmProc.stdout)
      const byId = new Map(parsedWarm.map((e) => [e.id, e.result]))
      expect(byId.get("m-top")?.exitCode).toBe(1)
      expect(byId.get("m-a")?.exitCode).toBe(1)
      expect(byId.get("m-b")?.exitCode).toBe(1)
      expect(byId.get("m-surv")?.exitCode).toBe(0)
      expect(byId.get("m-surv")?.stdout).toMatch(/\bTests\s+2\s+passed\b/)

      const coldProc = spawnSync(process.execPath, [batchScript], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_MUTATE_USE_WARM_VITEST: "0",
          HARNESS_MUTATE_CONCURRENCY: "1",
          HARNESS_BATCH_VITEST_CLI: vitestCli,
          HARNESS_BATCH_CWD: dir,
          HARNESS_BATCH_TIMEOUT_MS: "25000",
          HARNESS_BATCH_TESTS_JSON: JSON.stringify([tA]),
          HARNESS_BATCH_MUTANTS_JSON: JSON.stringify(["m-a"]),
        },
      })
      expect(coldProc.status).toBe(0)
      const parsedCold = Schema.decodeSync(BatchResultJsonSchema)(coldProc.stdout)
      expect(parsedCold[0]?.result.exitCode).toBe(1)

      // Fail-closed: module resolution error in warm mode must NOT emit 'Tests N failed'
      const brokenTest = join(dir, "broken.test.ts")
      writeFileSync(
        brokenTest,
        'import { missing } from "./nonexistent.js"\nimport { it } from "vitest"\nit("x", () => { missing() })\n',
        "utf8",
      )
      const brokenProc = spawnSync(process.execPath, [batchScript], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_MUTATE_CONCURRENCY: "1",
          HARNESS_BATCH_VITEST_CLI: vitestCli,
          HARNESS_BATCH_CWD: dir,
          HARNESS_BATCH_TIMEOUT_MS: "25000",
          HARNESS_BATCH_TESTS_JSON: JSON.stringify([brokenTest]),
          HARNESS_BATCH_MUTANTS_JSON: JSON.stringify(["m-a"]),
        },
      })
      expect(brokenProc.status).toBe(0)
      const parsedBroken = Schema.decodeSync(BatchResultJsonSchema)(brokenProc.stdout)
      expect(parsedBroken[0]?.result.stderr).toMatch(/Cannot find module/i)
      expect(parsedBroken[0]?.result.stdout ?? "").not.toMatch(/\bTests\s+[1-9]\d*\s+failed\b/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 25_000)
})

describe("mutation-speedup: merge-aware git diff extraction", () => {
  const makeShaGitIo = (opts: {
    readonly refs: Readonly<Record<string, string | undefined>>
    readonly ancestorPairs?: ReadonlyArray<readonly [string, string]>
    readonly diffByBase: Readonly<Record<string, string>>
    readonly diffErrorBase?: string
  }): SyncHostIo => ({
    ...testHostIo,
    execFileSync: (_cmd, args) => {
      if (args.includes("--is-inside-work-tree")) {
        return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
      }
      if (args.includes("rev-parse") && args.includes("--verify")) {
        const refArg = args[args.length - 1] ?? ""
        const rawRef = refArg.replace(/\^\{commit\}$/, "")
        const sha = opts.refs[rawRef] ?? (/^[0-9a-f]{40}$/i.test(rawRef) ? rawRef : undefined)
        return sha !== undefined
          ? { _tag: "Exited", exitCode: 0, stdout: `${sha}\n`, stderr: "" }
          : { _tag: "Exited", exitCode: 128, stdout: "", stderr: "missing ref" }
      }
      if (args.includes("--is-ancestor")) {
        const a = args[args.length - 2] ?? ""
        const b = args[args.length - 1] ?? ""
        const isAnc = (opts.ancestorPairs ?? []).some(([x, y]) => x === a && y === b)
        return isAnc
          ? { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
          : { _tag: "Exited", exitCode: 1, stdout: "", stderr: "" }
      }
      if (args.includes("merge-base")) {
        const target = args[args.length - 1] ?? ""
        const resolved = target === "main" ? (opts.refs["main"] ?? target) : target
        return { _tag: "Exited", exitCode: 0, stdout: `${resolved}\n`, stderr: "" }
      }
      if (args.includes("diff")) {
        for (const [base, out] of Object.entries(opts.diffByBase)) {
          if (args.includes(base)) {
            if (opts.diffErrorBase === base) {
              return { _tag: "Exited", exitCode: 128, stdout: "", stderr: "diff boom" }
            }
            return { _tag: "Exited", exitCode: 0, stdout: out, stderr: "" }
          }
        }
        return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
      }
      return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
    },
  })

  it("scopes uncommitted incoming origin/main MERGE_HEAD diff to MERGE_HEAD while keeping sibling/reverse merges full", () => {
    const incomingIo = makeShaGitIo({
      refs: {
        HEAD: SHA_HEAD,
        MERGE_HEAD: SHA_ORIGIN_MAIN,
        main: SHA_LOCAL_MAIN,
        "origin/main": SHA_ORIGIN_MAIN,
      },
      diffByBase: {
        [SHA_ORIGIN_MAIN]:
          "+++ b/libs/demo/domain/src/feat.ts\n@@ -0,0 +5,1 @@\n+export const feat = 1\n",
        [SHA_HEAD]:
          "+++ b/libs/demo/domain/src/main-pr44.ts\n@@ -0,0 +10,1 @@\n+export const upstream = 1\n",
      },
    })
    const incomingRes = extractGitDiffModifiedLinesChecked("/mock-repo", incomingIo, {
      fallbackBaseRef: "main",
    })
    match(incomingRes)
      .with({ _tag: "Ok" }, ({ lines, diffMode }) => {
        expect(diffMode).toBe("branch-base")
        expect(lines.has("libs/demo/domain/src/feat.ts")).toBe(true)
        expect(lines.has("libs/demo/domain/src/main-pr44.ts")).toBe(false)
      })
      .with({ _tag: "Failed" }, { _tag: "NotGit" }, () => {
        expect.unreachable("Expected Ok for incoming MERGE_HEAD")
      })
      .exhaustive()

    const incomingErrIo = makeShaGitIo({
      refs: { HEAD: SHA_HEAD, MERGE_HEAD: SHA_ORIGIN_MAIN, "origin/main": SHA_ORIGIN_MAIN },
      diffByBase: { [SHA_ORIGIN_MAIN]: "x" },
      diffErrorBase: SHA_ORIGIN_MAIN,
    })
    expect(
      extractGitDiffModifiedLinesChecked("/mock-repo", incomingErrIo, { fallbackBaseRef: "main" })
        ._tag,
    ).toBe("Failed")

    const siblingMergeIo = makeShaGitIo({
      refs: {
        HEAD: SHA_HEAD,
        MERGE_HEAD: SHA_SIBLING,
        main: SHA_LOCAL_MAIN,
        "origin/main": SHA_ORIGIN_MAIN,
      },
      diffByBase: {
        [SHA_LOCAL_MAIN]:
          "+++ b/libs/demo/domain/src/sibling.ts\n@@ -0,0 +3,1 @@\n+export const sib = 1\n",
      },
    })
    const siblingRes = extractGitDiffModifiedLinesChecked("/mock-repo", siblingMergeIo, {
      fallbackBaseRef: "main",
    })
    match(siblingRes)
      .with({ _tag: "Ok" }, ({ lines }) => {
        expect(lines.has("libs/demo/domain/src/sibling.ts")).toBe(true)
      })
      .with({ _tag: "Failed" }, { _tag: "NotGit" }, () => {
        expect.unreachable("Expected Ok for sibling merge fallback")
      })
      .exhaustive()
  })

  it("uses origin/<baseRef> instead of stale local main when merged into HEAD, while honoring explicitBaseRef", () => {
    const staleMainIo = makeShaGitIo({
      refs: { HEAD: SHA_HEAD, main: SHA_LOCAL_MAIN, "origin/main": SHA_ORIGIN_MAIN },
      ancestorPairs: [
        [SHA_LOCAL_MAIN, SHA_ORIGIN_MAIN],
        [SHA_ORIGIN_MAIN, SHA_HEAD],
      ],
      diffByBase: {
        [SHA_ORIGIN_MAIN]:
          "+++ b/libs/demo/domain/src/only-feature.ts\n@@ -0,0 +1,1 @@\n+export const f = 1\n",
        [SHA_LOCAL_MAIN]:
          "+++ b/libs/demo/domain/src/stale-upstream.ts\n@@ -0,0 +1,1 @@\n+export const u = 1\n",
      },
    })
    const autoRes = extractGitDiffModifiedLinesChecked("/mock-repo", staleMainIo, {
      fallbackBaseRef: "main",
    })
    match(autoRes)
      .with({ _tag: "Ok" }, ({ lines }) => {
        expect(lines.has("libs/demo/domain/src/only-feature.ts")).toBe(true)
        expect(lines.has("libs/demo/domain/src/stale-upstream.ts")).toBe(false)
      })
      .with({ _tag: "Failed" }, { _tag: "NotGit" }, () => {
        expect.unreachable("Expected Ok for stale local main override")
      })
      .exhaustive()

    const explicitRes = extractGitDiffModifiedLinesChecked("/mock-repo", staleMainIo, {
      explicitBaseRef: true,
      fallbackBaseRef: "main",
    })
    match(explicitRes)
      .with({ _tag: "Ok" }, ({ lines }) => {
        expect(lines.has("libs/demo/domain/src/stale-upstream.ts")).toBe(true)
      })
      .with({ _tag: "Failed" }, { _tag: "NotGit" }, () => {
        expect.unreachable("Expected Ok for explicitBaseRef")
      })
      .exhaustive()
  })
})

describe("mutation-speedup: static reverse-import reachability", () => {
  it("isolates internal non-barrel importers, prioritizes barrel importers & speed, and handles symlinks closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "reach-idx-"))
    try {
      const pkg = join(dir, "libs", "demo", "core")
      mkdirSync(join(pkg, "src", "sub"), { recursive: true })
      mkdirSync(join(pkg, "test", "helpers"), { recursive: true })

      const leafPath = join(pkg, "src", "sub", "leaf.ts")
      const helperPath = join(pkg, "src", "facade.ts")
      const indexPath = join(pkg, "src", "index.ts")
      const barrelOnlyModPath = join(pkg, "src", "barrel-only.ts")

      writeFileSync(leafPath, "export const internalLeafFn = (n: number) => n + 1\n", "utf8")
      writeFileSync(
        helperPath,
        'import { internalLeafFn } from "./sub/leaf.js"\nexport const callFacade = () => internalLeafFn(1)\n',
        "utf8",
      )
      writeFileSync(barrelOnlyModPath, "export const barrelOnlySymbol = 42\n", "utf8")
      writeFileSync(
        indexPath,
        'export { internalLeafFn } from "./sub/leaf.js"\nexport { barrelOnlySymbol } from "./barrel-only.js"\n',
        "utf8",
      )

      const tFacade = join(pkg, "test", "facade-suite.test.ts")
      const tBarrel = join(pkg, "test", "barrel-suite.test.ts")
      const tUnrelSmall = join(pkg, "test", "unrelated-small.test.ts")
      const tHeavy = join(pkg, "test", "mutation-check.test.ts")
      writeFileSync(
        join(pkg, "test", "helpers", "bridge.ts"),
        'export { callFacade } from "../../src/facade.js"\n',
        "utf8",
      )
      writeFileSync(
        tFacade,
        'import { callFacade } from "./helpers/bridge.js"\nexport const a = callFacade\n',
        "utf8",
      )
      writeFileSync(
        tBarrel,
        'import * as barrelApi from "../src/index.js"\nexport const b = barrelApi.barrelOnlySymbol\n',
        "utf8",
      )
      writeFileSync(tUnrelSmall, "export const u = 1\n", "utf8")
      writeFileSync(
        tHeavy,
        `import { barrelOnlySymbol } from "../src/index.js"\n${"// line\n".repeat(10)}export const h = barrelOnlySymbol\n`,
        "utf8",
      )

      const domainLeaf = {
        scope: "demo",
        pkgDir: "core",
        pkgName: "@demo/core",
        tier: "core" as const,
        fullPath: leafPath,
        relFile: "libs/demo/core/src/sub/leaf.ts",
      }
      const cache = new Map<string, PackageReachabilityIndex>()
      const leafPart = partitionReachingTestFiles(
        dir,
        domainLeaf,
        readFileSync(leafPath, "utf8"),
        testHostIo,
        cache,
      )
      expect(leafPart.primaryTests).toEqual([tFacade])
      expect(leafPart.fallbackTests[0]).toBe(tBarrel)
      expect(leafPart.fallbackTests[leafPart.fallbackTests.length - 1]).toBe(tHeavy)

      const barrelPart = partitionReachingTestFiles(
        dir,
        {
          ...domainLeaf,
          fullPath: barrelOnlyModPath,
          relFile: "libs/demo/core/src/barrel-only.ts",
        },
        readFileSync(barrelOnlyModPath, "utf8"),
        testHostIo,
        cache,
      )
      expect(barrelPart.primaryTests).toEqual([tBarrel, tHeavy])
      expect(barrelPart.fallbackTests).toEqual([tUnrelSmall, tFacade])

      // Verify reachability cache avoids re-reading when cached
      const denyIo: SyncHostIo = {
        ...testHostIo,
        readdirSync: () => {
          throw new Error("should not readdir when cached")
        },
      }
      expect(
        getOrBuildPackageReachabilityIndexChecked(
          dir,
          "libs/demo/core",
          "@demo/core",
          [],
          denyIo,
          cache,
        )._tag,
      ).toBe("Ok")

      // Symlink fails closed
      symlinkSync(tUnrelSmall, join(pkg, "test", "bad-link.test.ts"))
      expect(
        buildPackageReachabilityIndexChecked(dir, "libs/demo/core", "@demo/core", [], testHostIo)
          ._tag,
      ).toBe("Error")
      expect(
        partitionReachingTestFilesChecked(
          dir,
          domainLeaf,
          readFileSync(leafPath, "utf8"),
          testHostIo,
        )._tag,
      ).toBe("Error")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("narrows live @harness/gates internal plugin primaryTests below 20 instead of full package", () => {
    const rel = "libs/harness/gates/src/plugins/ast-workflow-fence-law.ts"
    const full = join(REAL_REPO_ROOT, rel)
    const part = partitionReachingTestFiles(
      REAL_REPO_ROOT,
      {
        scope: "harness",
        pkgDir: "gates",
        pkgName: "@harness/gates",
        tier: "core",
        fullPath: full,
        relFile: rel,
      },
      readFileSync(full, "utf8"),
      testHostIo,
    )
    expect(part.primaryTests.length).toBeGreaterThan(0)
    expect(part.primaryTests.length).toBeLessThan(20)
    expect(part.fallbackTests.length).toBeGreaterThan(10)
  })
})

describe("mutation-speedup: read-only worktree shared cache & runtime digests", () => {
  it("hydrates valid HMAC entries from linked main repo cache without mutating corrupt main cache and isolates Unsafe local paths", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-shared-cache-"))
    try {
      const mainRepo = join(root, "main-repo")
      const wtRepo = join(mainRepo, ".worktrees", "wt1")
      const wtGitDir = join(mainRepo, ".git", "worktrees", "wt1")
      mkdirSync(join(mainRepo, ".git", "objects"), { recursive: true })
      mkdirSync(wtGitDir, { recursive: true })
      mkdirSync(wtRepo, { recursive: true })
      writeFileSync(join(wtGitDir, "commondir"), "../..\n", "utf8")
      writeFileSync(join(wtRepo, ".git"), `gitdir: ${wtGitDir}\n`, "utf8")

      expect(resolveLinkedWorktreeCommonRepoRoot(wtRepo, isolatedTestHostIo)).toBe(mainRepo)
      expect(resolveLinkedWorktreeCommonRepoRoot(mainRepo, isolatedTestHostIo)).toBeUndefined()

      const auth: MutationCacheAuth = {
        _tag: "Enabled",
        hmacSecret: Redacted.make(MutationCacheHmacSecret.make("a".repeat(64))),
      }
      const keyShared = ContentSha256.make("1".repeat(64))
      const keyShared2 = ContentSha256.make("2".repeat(64))
      const recordedAt = MutationCacheTimestamp.make("2026-11-23T12:00:00.000Z")
      const file = AstSourceFilePath.make("libs/demo/domain/src/a.ts")
      const witnessTestFile = AstSourceFilePath.make("libs/demo/domain/test/a.test.ts")
      const witnessClosureSha256 = computeContentSha256("demo-witness-closure")
      const mutantId = MutantCacheId.make("libs/demo/domain/src/a.ts:1:===->!==")
      const hmac = match(auth)
        .with({ _tag: "Enabled" }, ({ hmacSecret }) => hmacSecret)
        .exhaustive()

      saveMutationCacheAtomic(
        mainRepo,
        {
          version: MUTATION_CACHE_SCHEMA_VERSION,
          entries: {
            [keyShared]: {
              key: keyShared,
              file,
              mutantId,
              status: "killed",
              recordedAt,
              witnessTestFile,
              witnessClosureSha256,
              mac: computeMutationEntryMac(hmac, {
                key: keyShared,
                file,
                mutantId,
                status: "killed",
                recordedAt,
                witnessTestFile,
                witnessClosureSha256,
              }),
            },
            [keyShared2]: {
              key: keyShared2,
              file,
              mutantId,
              status: "killed",
              recordedAt,
              witnessTestFile,
              witnessClosureSha256,
              mac: computeMutationEntryMac(hmac, {
                key: keyShared2,
                file,
                mutantId,
                status: "killed",
                recordedAt,
                witnessTestFile,
                witnessClosureSha256,
              }),
            },
          },
        },
        isolatedTestHostIo,
        auth,
      )

      const localOverrideTs = MutationCacheTimestamp.make("2026-11-23T14:00:00.000Z")
      saveMutationCacheAtomic(
        wtRepo,
        {
          version: MUTATION_CACHE_SCHEMA_VERSION,
          entries: {
            [keyShared]: {
              key: keyShared,
              file,
              mutantId,
              status: "killed",
              recordedAt: localOverrideTs,
              witnessTestFile,
              witnessClosureSha256,
              mac: computeMutationEntryMac(hmac, {
                key: keyShared,
                file,
                mutantId,
                status: "killed",
                recordedAt: localOverrideTs,
                witnessTestFile,
                witnessClosureSha256,
              }),
            },
          },
        },
        isolatedTestHostIo,
        auth,
      )

      const hydrated = loadMutationCache(wtRepo, isolatedTestHostIo, auth)
      expect(Object.keys(hydrated.entries).sort()).toEqual([keyShared, keyShared2].sort())
      expect(hydrated.entries[keyShared]?.recordedAt).toBe(localOverrideTs)

      // Corrupt shared cache is ignored WITHOUT modifying or quarantining main repo cache
      const sharedCacheFile = join(mainRepo, ".harness", "cache", MUTATION_CACHE_FILENAME)
      writeFileSync(sharedCacheFile, "{corrupt-shared-json", "utf8")
      const afterCorruptShared = loadMutationCache(wtRepo, isolatedTestHostIo, auth)
      expect(Object.keys(afterCorruptShared.entries)).toEqual([keyShared])
      expect(readFileSync(sharedCacheFile, "utf8")).toBe("{corrupt-shared-json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("includes warm-vitest-worker.mjs and mutant-coverage-setup.mjs in computeMutationContextDigestsChecked", () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-tools-"))
    try {
      mkdirSync(join(dir, "tools"), { recursive: true })
      mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true })
      writeFileSync(
        join(dir, "node_modules", "vitest", "package.json"),
        JSON.stringify({ name: "vitest", version: "5.0.3" }),
      )
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }))
      writeFileSync(join(dir, "tools", "warm-vitest-worker.mjs"), "// v1\n")
      writeFileSync(join(dir, "tools", "mutant-coverage-setup.mjs"), "// c1\n")
      writeFileSync(join(dir, "tools", "package-vitest-batch.mjs"), "// p1\n")
      writeFileSync(join(dir, "tools", "vitest-pool-helpers.mjs"), "// h1\n")

      const d1 = computeMutationContextDigestsChecked(dir, testHostIo)
      writeFileSync(join(dir, "tools", "warm-vitest-worker.mjs"), "// v2\n")
      const d2 = computeMutationContextDigestsChecked(dir, testHostIo)
      writeFileSync(join(dir, "tools", "mutant-coverage-setup.mjs"), "// c2\n")
      const d3 = computeMutationContextDigestsChecked(dir, testHostIo)
      writeFileSync(join(dir, "tools", "package-vitest-batch.mjs"), "// p2\n")
      const d4 = computeMutationContextDigestsChecked(dir, testHostIo)
      writeFileSync(join(dir, "tools", "vitest-pool-helpers.mjs"), "// h2\n")
      const d5 = computeMutationContextDigestsChecked(dir, testHostIo)

      match([d1, d2, d3, d4, d5] as const)
        .with(
          [{ _tag: "Ok" }, { _tag: "Ok" }, { _tag: "Ok" }, { _tag: "Ok" }, { _tag: "Ok" }],
          ([a, b, c, d, e]) => {
            expect(a.digests.rootRuntimeDigest).not.toBe(b.digests.rootRuntimeDigest)
            expect(b.digests.rootRuntimeDigest).not.toBe(c.digests.rootRuntimeDigest)
            expect(c.digests.rootRuntimeDigest).not.toBe(d.digests.rootRuntimeDigest)
            expect(d.digests.rootRuntimeDigest).not.toBe(e.digests.rootRuntimeDigest)
          },
        )
        .otherwise(() => {
          expect.unreachable("Expected all context digests to succeed")
        })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const makeMockFile = (root: string, relFile: string): DomainFile => ({
  scope: "harness",
  pkgDir: "demo",
  pkgName: "@demo/domain",
  tier: "domain",
  fullPath: join(root, relFile),
  relFile,
})

const readSingleMutant = (relFile: string, src: string): CodeMutant => {
  const mutants = discoverDomainMutants(relFile, src)
  expect(mutants.length).toBeGreaterThan(0)
  return mutants[0]!
}

describe("mutation-speedup: Wave 2 persistent package pool & config resolution", () => {
  it("resolveCommonVitestConfigPath locates package or root vitest config and handles empty/divergent sets", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-vcfg-"))
    try {
      mkdirSync(join(dir, "libs", "a", "test"), { recursive: true })
      mkdirSync(join(dir, "libs", "b", "test"), { recursive: true })
      writeFileSync(join(dir, "libs", "a", "vitest.config.ts"), "export default {}\n", "utf8")
      expect(resolveCommonVitestConfigPath(dir, [], testHostIo)).toBeUndefined()
      expect(resolveCommonVitestConfigPath(dir, ["libs/a/test/x.test.ts"], testHostIo)).toBe(
        join(dir, "libs", "a", "vitest.config.ts"),
      )
      expect(
        resolveCommonVitestConfigPath(
          dir,
          ["libs/a/test/x.test.ts", "libs/b/test/y.test.ts"],
          testHostIo,
        ),
      ).toBeUndefined()
      writeFileSync(join(dir, "vitest.config.mjs"), "export default {}\n", "utf8")
      expect(
        resolveCommonVitestConfigPath(
          dir,
          ["libs/a/test/x.test.ts", "libs/b/test/y.test.ts"],
          testHostIo,
        ),
      ).toBe(join(dir, "vitest.config.mjs"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.effect(
    "warm-vitest-worker isolates state across runs and handles invalidate IPC",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "warm-worker-iso-"))
        const stateDir = join(dir, "state")
        mkdirSync(join(dir, "src"), { recursive: true })
        mkdirSync(join(dir, "test"), { recursive: true })
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
        symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir")
        writeFileSync(join(dir, "src", "dep.ts"), "export const val = 1\n", "utf8")
        writeFileSync(
          join(dir, "test", "fail.test.ts"),
          'import { expect, it } from "vitest"\nit("fails", () => { expect(1).toBe(2) })\n',
          "utf8",
        )
        writeFileSync(
          join(dir, "test", "pass.test.ts"),
          'import { expect, it } from "vitest"\nit("passes", () => { expect(1).toBe(1) })\n',
          "utf8",
        )
        const workerScript = join(REAL_REPO_ROOT, "tools", "warm-vitest-worker.mjs")
        const vitestEntry = join(REAL_REPO_ROOT, "node_modules", "vitest", "dist", "node.js")
        const child = fork(workerScript, [], {
          cwd: dir,
          env: {
            ...process.env,
            HARNESS_WARM_MODE: "worker",
            HARNESS_WARM_VITEST_NODE_ENTRY: vitestEntry,
            HARNESS_WARM_CWD: dir,
            HARNESS_WARM_TESTS_JSON: JSON.stringify(["test/fail.test.ts", "test/pass.test.ts"]),
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        })
        const nextMsg = (predicate: (msg: Readonly<Record<string, unknown>>) => boolean) =>
          new Promise<Readonly<Record<string, unknown>>>((resolveMsg, rejectMsg) => {
            const onMsg = (raw: unknown) => {
              if (typeof raw !== "object" || raw === null) return
              const rec = Object.fromEntries(Object.entries(raw))
              if (predicate(rec)) {
                child.off("message", onMsg)
                resolveMsg(rec)
              }
            }
            child.on("message", onMsg)
            child.once("error", rejectMsg)
          })
        try {
          yield* Effect.promise(() => nextMsg((m) => m["type"] === "ready"))
          child.send({
            type: "run",
            id: "m-fail",
            testFiles: ["test/fail.test.ts"],
            stateDir,
          })
          const failMsg = yield* Effect.promise(() =>
            nextMsg((m) => m["type"] === "result" && m["id"] === "m-fail"),
          )
          const failRes = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ _tag: Schema.String, exitCode: Schema.Finite }),
          )(failMsg["result"])
          expect(failRes.exitCode).toBe(1)

          child.send({ type: "invalidate", reqId: 1, files: ["src/dep.ts", "test/pass.test.ts"] })
          yield* Effect.promise(() =>
            nextMsg((m) => m["type"] === "invalidated" && m["reqId"] === 1),
          )

          child.send({
            type: "run",
            id: "m-pass",
            testFiles: ["test/pass.test.ts"],
            stateDir,
          })
          const passMsg = yield* Effect.promise(() =>
            nextMsg((m) => m["type"] === "result" && m["id"] === "m-pass"),
          )
          const passRes = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ _tag: Schema.String, exitCode: Schema.Finite, stdout: Schema.String }),
          )(passMsg["result"])
          expect(passRes.exitCode).toBe(0)
          expect(passRes.stdout).toContain("1 passed")

          yield* Effect.promise(
            () =>
              new Promise<void>((resolveStop) => {
                child.once("close", () => resolveStop())
                child.send({ type: "shutdown" })
              }),
          )
        } finally {
          child.kill("SIGKILL")
          rmSync(dir, { recursive: true, force: true })
        }
      }),
    30_000,
  )

  it("runPackageMutantBatchChecked kills primary + fallback mutants across 2 interdependent files and restores files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-batch-e2e-"))
    try {
      const pkgDir = join(dir, "libs", "demo", "domain")
      mkdirSync(join(pkgDir, "src"), { recursive: true })
      mkdirSync(join(pkgDir, "test"), { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
      symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir")
      symlinkSync(join(REAL_REPO_ROOT, "tools"), join(dir, "tools"), "dir")

      const relA = "libs/demo/domain/src/a.ts"
      const relB = "libs/demo/domain/src/b.ts"
      const srcA = [
        "export const inc = (n: number): number => n + 1",
        "export const extra = (n: number): number => n - 1",
      ].join("\n")
      const srcB = [
        'import { inc } from "./a.js"',
        "export const dblInc = (n: number): number => inc(n) + 1",
      ].join("\n")
      writeFileSync(join(dir, relA), srcA, "utf8")
      writeFileSync(join(dir, relB), srcB, "utf8")
      const tA = "libs/demo/domain/test/a.test.ts"
      const tB = "libs/demo/domain/test/b.test.ts"
      writeFileSync(
        join(dir, tA),
        'import { expect, it } from "vitest"\nimport { inc } from "../src/a.js"\nit("inc", () => { expect(inc(2)).toBe(3) })\n',
        "utf8",
      )
      writeFileSync(
        join(dir, tB),
        'import { expect, it } from "vitest"\nimport { extra } from "../src/a.js"\nimport { dblInc } from "../src/b.js"\nit("both", () => { expect(extra(5)).toBe(4); expect(dblInc(2)).toBe(4) })\n',
        "utf8",
      )

      const mutsA = discoverDomainMutants(relA, srcA)
      const mutsB = discoverDomainMutants(relB, srcB)
      expect(mutsA.length).toBeGreaterThanOrEqual(2)
      expect(mutsB.length).toBeGreaterThanOrEqual(1)
      const modA = compileMutantSchemaModule(relA, srcA, mutsA)
      const modB = compileMutantSchemaModule(relB, srcB, mutsB)
      const backupPath = join(dir, ".harness", "mutation-backup.json")
      const res = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "harness/domain",
        backupPath,
        hostIo: testHostIo,
        baseSubprocessEnv: process.env,
        allPackageTests: [tA, tB],
        files: [
          makeBatchFile(dir, relA, srcA, modA.schemaSource, mutsA, [tA], [tB]),
          makeBatchFile(dir, relB, srcB, modB.schemaSource, mutsB, [tB]),
        ],
      })
      match(res)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected Ok package batch result, got Abort: ${diagnostic}`)
        })
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          expect(fileResults.length).toBe(2)
          for (const fr of fileResults) {
            for (const outcome of fr.fileOutcomes.values()) {
              expect(outcome.status).toBe("killed")
            }
          }
          expect(readFileSync(join(dir, relA), "utf8")).toBe(srcA)
          expect(readFileSync(join(dir, relB), "utf8")).toBe(srcB)
          expect(testHostIo.existsSync(backupPath)).toBe(false)
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("runPackageMutantBatchChecked aborts cleanly on missing infra, write errors, bad subprocess exits/JSON, and restoreError", () => {
    const repoRoot = "/mock-pkg-repo"
    const relA = "libs/demo/domain/src/a.ts"
    const srcA = "export const inc = (n: number): number => n + 1"
    const mut = readSingleMutant(relA, srcA)
    const entry = makeBatchFile(
      repoRoot,
      relA,
      srcA,
      srcA,
      [mut],
      ["libs/demo/domain/test/a.test.ts"],
      ["libs/demo/domain/test/b.test.ts"],
    )
    const baseIo = (
      execResult: ReturnType<SyncHostIo["execFileSync"]>,
      opts?: { readonly exists?: boolean; readonly writeThrows?: boolean },
    ): SyncHostIo => ({
      ...testHostIo,
      existsSync: (p) =>
        opts?.exists === false ? false : !p.endsWith("backup.json") && !p.includes("pkg-stream-"),
      realpathSync: (p) => p,
      mkdirRecursiveSync: () => {},
      writeTextSync: () => {
        if (opts?.writeThrows) throw new Error("disk full")
      },
      unlinkSync: () => {},
      execFileSync: () => execResult,
    })
    expect(
      runPackageMutantBatchChecked({
        repoRoot,
        pkgKey: "harness/domain",
        backupPath: `${repoRoot}/.harness/backup.json`,
        hostIo: baseIo(
          { _tag: "Exited", exitCode: 0, stdout: "[]", stderr: "" },
          { exists: false },
        ),
        baseSubprocessEnv: {},
        allPackageTests: entry.primaryTests,
        files: [entry],
      })._tag,
    ).toBe("Abort")
    expect(
      runPackageMutantBatchChecked({
        repoRoot,
        pkgKey: "harness/domain",
        backupPath: `${repoRoot}/.harness/backup.json`,
        hostIo: baseIo(
          { _tag: "Exited", exitCode: 0, stdout: "[]", stderr: "" },
          { writeThrows: true },
        ),
        baseSubprocessEnv: {},
        allPackageTests: entry.primaryTests,
        files: [entry],
      })._tag,
    ).toBe("Abort")
    for (const badExec of [
      { _tag: "Exited", exitCode: 1, stdout: "", stderr: "boom" },
      { _tag: "Exited", exitCode: 0, stdout: "{bad-json", stderr: "" },
      { _tag: "TimedOut", stdout: "", stderr: "" },
      { _tag: "Signaled", signal: "SIGTERM", stdout: "", stderr: "" },
      { _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" },
      { _tag: "Exited", exitCode: 0, stdout: "[]", stderr: "" },
      { _tag: "Exited", exitCode: 0, stdout: emptyBatchEntry(relA), stderr: "" },
    ] as const) {
      expect(
        runPackageMutantBatchChecked({
          repoRoot,
          pkgKey: "harness/domain",
          backupPath: `${repoRoot}/.harness/backup.json`,
          hostIo: baseIo(badExec),
          baseSubprocessEnv: {},
          allPackageTests: entry.primaryTests,
          files: [entry],
        })._tag,
      ).toBe("Abort")
    }

    const killedOut = [
      { id: mut.id, result: { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed", stderr: "" } },
    ]
    const restoreErrRes = runPackageMutantBatchChecked({
      repoRoot,
      pkgKey: "harness/domain",
      backupPath: `${repoRoot}/.harness/backup.json`,
      hostIo: baseIo({
        _tag: "Exited",
        exitCode: 0,
        stdout: JSON.stringify([
          {
            relFile: relA,
            primaryResults: killedOut,
            scopedFallbackResults: [],
            packageFallbackResults: [],
            restoreError: "restore failed",
          },
        ]),
        stderr: "",
      }),
      baseSubprocessEnv: {},
      allPackageTests: entry.primaryTests,
      files: [entry],
    })
    match(restoreErrRes)
      .with({ _tag: "Abort" }, ({ partialResults, diagnostic }) => {
        expect(diagnostic).toBe("restore failed")
        expect(partialResults.length).toBe(0)
      })
      .with({ _tag: "Ok" }, () => {
        expect.unreachable("Expected Abort on restoreError")
      })
      .exhaustive()
  })

  it("handles solo cold recheck + unreported fallback and executeQueuedPackageBatches single/multi paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-batch-solo-fb-"))
    try {
      const pkgDir = join(dir, "libs", "demo", "domain")
      mkdirSync(join(pkgDir, "src"), { recursive: true })
      mkdirSync(join(pkgDir, "test"), { recursive: true })
      writeFileSync(join(dir, "node_modules_marker"), "", "utf8")
      const relA = "libs/demo/domain/src/a.ts"
      const srcA = "export const inc = (n: number): number => n + 1"
      writeFileSync(join(dir, relA), srcA, "utf8")
      const mut = readSingleMutant(relA, srcA)
      const mod = compileMutantSchemaModule(relA, srcA, [mut])
      let callIdx = 0
      const mockIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) =>
          p.endsWith("vitest.mjs") ||
          p.endsWith("package-vitest-batch.mjs") ||
          testHostIo.existsSync(p),
        unlinkSync: () => {},
        execFileSync: (_cmd, _args, opts) => {
          callIdx += 1
          if (callIdx === 1) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  relFile: relA,
                  primaryResults: [
                    {
                      id: mut.id,
                      result: { _tag: "Exited", exitCode: 1, stdout: "ambiguous", stderr: "" },
                    },
                  ],
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          if (callIdx === 2 || opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
          }
          return { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" }
        },
      }
      const res = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "harness/domain",
        backupPath: join(dir, ".harness", "backup.json"),
        hostIo: mockIo,
        baseSubprocessEnv: {},
        allPackageTests: ["libs/demo/domain/test/a.test.ts", "libs/demo/domain/test/b.test.ts"],
        files: [
          makeBatchFile(
            dir,
            relA,
            srcA,
            mod.schemaSource,
            [mut],
            ["libs/demo/domain/test/a.test.ts"],
            ["libs/demo/domain/test/b.test.ts"],
          ),
        ],
      })
      match(res)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected Ok after solo + fallback recheck: ${diagnostic}`)
        })
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          expect(fileResults[0]?.fileOutcomes.get(mut.id)?.status).toBe("killed")
        })
        .exhaustive()

      const singleCallIo: SyncHostIo = {
        ...testHostIo,
        unlinkSync: () => {},
        execFileSync: (_cmd, _args) => ({
          _tag: "Exited",
          exitCode: 1,
          stdout: "Tests 1 failed (1)\n",
          stderr: "",
        }),
      }
      const finalized: Array<PackageBatchFileResult> = []
      const queuedMap = new Map<string, ReadonlyArray<QueuedPackageEntry>>([
        [
          "harness/domain",
          [
            {
              pkgKey: "harness/domain",
              mutantKeys: new Map([[mut.id, computeContentSha256("k")]]),
              baselineVerified: true,
              input: makeBatchFile(
                dir,
                relA,
                srcA,
                mod.schemaSource,
                [mut],
                ["libs/demo/domain/test/a.test.ts"],
              ),
            },
          ],
        ],
      ])
      const execErr = executeQueuedPackageBatches({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "backup.json"),
        hostIo: singleCallIo,
        baseSubprocessEnv: {},
        queuedByPkg: queuedMap,
        finalizeEntry: (_e, r) => {
          finalized.push(r)
          return undefined
        },
        recordPartialOnAbort: () => {},
      })
      expect(execErr).toBeUndefined()
      expect(finalized.length).toBe(1)
      expect(finalized[0]?.fileOutcomes.get(mut.id)?.status).toBe("killed")

      const passRes: ReturnType<typeof runSingleFileVitestPass> = runSingleFileVitestPass({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "backup.json"),
        hostIo: singleCallIo,
        baseSubprocessEnv: {},
        file: makeMockFile(dir, relA),
        originalContent: srcA,
        schemaSource: mod.schemaSource,
        mutants: [mut],
        uncachedMutants: [mut],
        primaryTests: ["libs/demo/domain/test/a.test.ts"],
        scopedFallbackTests: [],
        packageFallbackTests: [],
        cachedHitIds: new Set(),
        pkgBaselinePassed: true,
      })
      expect(passRes._tag).toBe("Ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("parallel-vitest-batch enforces isolate:true even when HARNESS_MUTATE_WARM_ISOLATE=0 and kills top-level and function mutants", () => {
    const dir = mkdtempSync(join(tmpdir(), "iso-false-batch-"))
    try {
      const modPath = join(dir, "calc.ts")
      const tPath = join(dir, "calc.test.ts")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
      symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir")
      writeFileSync(
        modPath,
        [
          'function __hMut(id: string): boolean { const g: object = globalThis; const env: unknown = Reflect.get(Reflect.get(g, "process"), "env"); return Reflect.get(env, "HARNESS_ACTIVE_MUTANT_ID") === id; }',
          'export const TOP = __hMut("m-top") ? 999 : 10',
          'export const addOne = (x: number) => (__hMut("m-fn") ? x - 1 : x + 1)',
          'export const untouched = (x: number) => (__hMut("m-surv") ? x - 5 : x)',
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        tPath,
        'import { expect, it } from "vitest"\nimport { TOP, addOne } from "./calc.js"\nit("kills", () => { expect(TOP + addOne(2)).toBe(13) })\n',
        "utf8",
      )
      for (const warmIsolate of ["1", "0"]) {
        const res = spawnSync(
          process.execPath,
          [join(REAL_REPO_ROOT, "tools", "parallel-vitest-batch.mjs")],
          {
            cwd: dir,
            encoding: "utf8",
            env: {
              ...process.env,
              HARNESS_MUTATE_CONCURRENCY: "1",
              HARNESS_MUTATE_WARM_ISOLATE: warmIsolate,
              HARNESS_BATCH_VITEST_CLI: join(
                REAL_REPO_ROOT,
                "node_modules",
                "vitest",
                "vitest.mjs",
              ),
              HARNESS_BATCH_CWD: dir,
              HARNESS_BATCH_TIMEOUT_MS: "20000",
              HARNESS_BATCH_TESTS_JSON: JSON.stringify(["calc.test.ts"]),
              HARNESS_BATCH_MUTANTS_JSON: JSON.stringify(["m-fn", "m-top", "m-surv"]),
            },
          },
        )
        expect(res.status, res.stderr).toBe(0)
        const parsed = Schema.decodeSync(BatchResultJsonSchema)(res.stdout)
        const byId = new Map(parsed.map((e) => [e.id, e.result]))
        expect(byId.get("m-fn")?.exitCode).toBe(1)
        expect(byId.get("m-top")?.exitCode).toBe(1)
        expect(byId.get("m-surv")?.exitCode).toBe(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("two-phase runner skips heavy tests on fast primary/Stage 2a kill and fails closed on broken heavy fallback baseline before killing Stage 2b", () => {
    const dir = mkdtempSync(join(tmpdir(), "two-phase-fb-"))
    try {
      const pkgDir = join(dir, "libs", "demo", "domain")
      mkdirSync(join(pkgDir, "src"), { recursive: true })
      mkdirSync(join(pkgDir, "test"), { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
      symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir")
      symlinkSync(join(REAL_REPO_ROOT, "tools"), join(dir, "tools"), "dir")

      const relA = "libs/demo/domain/src/a.ts"
      const relB = "libs/demo/domain/src/b.ts"
      const srcA2 = [
        "export const p = (n: number): number => n + 1",
        "export const fFast = (n: number): number => n - 1",
      ].join("\n")
      const srcB = "export const bFn = (n: number): number => n + 1"
      const tPrim = "libs/demo/domain/test/primary.test.ts"
      const tFast = "libs/demo/domain/test/fast.test.ts"
      const tHeavy = "libs/demo/domain/test/workflow-graph-assets.test.ts"
      writeFileSync(join(dir, relA), srcA2, "utf8")
      writeFileSync(join(dir, relB), srcB, "utf8")
      writeFileSync(
        join(dir, tPrim),
        'import { expect, it } from "vitest"\nimport { p } from "../src/a.js"\nimport { bFn } from "../src/b.js"\nit("p", () => { expect(p(2)).toBe(3); expect(bFn(1)).toBe(2) })\n',
        "utf8",
      )
      writeFileSync(
        join(dir, tFast),
        'import { expect, it } from "vitest"\nimport { fFast } from "../src/a.js"\nit("fast", () => { expect(fFast(5)).toBe(4) })\n',
        "utf8",
      )
      writeFileSync(
        join(dir, tHeavy),
        'import { expect, it } from "vitest"\nit("broken", () => { expect(1).toBe(2) })\n',
        "utf8",
      )

      const mutsA2 = discoverDomainMutants(relA, srcA2)
      const mutsB = discoverDomainMutants(relB, srcB)
      const modA2 = compileMutantSchemaModule(relA, srcA2, mutsA2)
      const modB = compileMutantSchemaModule(relB, srcB, mutsB)
      const backupPath = join(dir, ".harness", "mutation-backup.json")
      const stage2aOnly = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "harness/domain",
        backupPath,
        hostIo: testHostIo,
        baseSubprocessEnv: process.env,
        allPackageTests: [tPrim, tFast, tHeavy],
        files: [
          makeBatchFile(dir, relB, srcB, modB.schemaSource, mutsB, [tPrim, tHeavy]),
          makeBatchFile(dir, relA, srcA2, modA2.schemaSource, mutsA2, [tPrim], [tFast, tHeavy]),
        ],
      })
      expect(stage2aOnly._tag).toBe("Ok")

      const srcA3 = `${srcA2}\nexport const fHeavy = (n: number): boolean => n >= 1`
      writeFileSync(join(dir, relA), srcA3, "utf8")
      const mutsA3 = discoverDomainMutants(relA, srcA3)
      const modA3 = compileMutantSchemaModule(relA, srcA3, mutsA3)
      const brokenHeavyRes = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "harness/domain",
        backupPath,
        hostIo: testHostIo,
        baseSubprocessEnv: process.env,
        allPackageTests: [tPrim, tFast, tHeavy],
        files: [
          makeBatchFile(dir, relA, srcA3, modA3.schemaSource, mutsA3, [tPrim], [tFast, tHeavy]),
        ],
      })
      match(brokenHeavyRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect(diagnostic).toContain("Baseline test suite failed on fallback tests")
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable("Expected Abort when lazy heavy fallback baseline fails")
        })
        .exhaustive()
      expect(readFileSync(join(dir, relA), "utf8")).toBe(srcA3)

      writeFileSync(
        join(dir, tHeavy),
        'import { expect, it } from "vitest"\nimport { fHeavy } from "../src/a.js"\nit("heavy", () => { expect(fHeavy(1)).toBe(true); expect(fHeavy(0)).toBe(false) })\n',
        "utf8",
      )
      const fixedHeavyRes = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "harness/domain",
        backupPath,
        hostIo: testHostIo,
        baseSubprocessEnv: process.env,
        allPackageTests: [tPrim, tFast, tHeavy],
        files: [
          makeBatchFile(dir, relA, srcA3, modA3.schemaSource, mutsA3, [tPrim], [tFast, tHeavy]),
        ],
      })
      match(fixedHeavyRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected Ok after heavy fallback kill: ${diagnostic}`)
        })
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          for (const o of fileResults[0]!.fileOutcomes.values()) {
            expect(o.status).toBe("killed")
          }
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("per-it testNamePattern Stage 0 targets single tests on heavy files and falls back to full suite for survivors", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage0-testname-"))
    try {
      const pkgDir = join(dir, "libs", "demo", "domain")
      mkdirSync(join(pkgDir, "src"), { recursive: true })
      mkdirSync(join(pkgDir, "test"), { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
      symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir")
      symlinkSync(join(REAL_REPO_ROOT, "tools"), join(dir, "tools"), "dir")

      const relA = "libs/demo/domain/src/a.ts"
      const origA = [
        "export const fnA = (x: number): boolean => x === 1",
        "export const fnB = (x: number): boolean => x === 2",
        "export const fnFallback = (x: number): boolean => x >= 0",
        "export const fnExtra = (x: number): boolean => x === 9",
      ].join("\n")
      writeFileSync(join(dir, relA), origA, "utf8")
      const muts = discoverDomainMutants(relA, origA)
      const mutA = muts.find((m) => m.line === 1)!
      const mutB = muts.find((m) => m.line === 2)!
      const mutFb = muts.find((m) => m.line === 3 && m.original === ">=" && m.replacement === ">")!
      const mutExtra = muts.find((m) => m.line === 4)!
      expect([mutA, mutB, mutFb, mutExtra].every(Boolean)).toBe(true)
      const selected = [mutA, mutB, mutFb, mutExtra]
      const mod = compileMutantSchemaModule(relA, origA, selected)

      const logPath = join(dir, "it-runs.log")
      const tHeavy = "libs/demo/domain/test/policy-check.test.ts"
      writeFileSync(
        join(dir, tHeavy),
        [
          'import { appendFileSync } from "node:fs"',
          'import { describe, expect, it } from "vitest"',
          'import { fnA, fnB, fnExtra, fnFallback } from "../src/a.js"',
          `const logRun = (name: string) => { const m = process.env["HARNESS_ACTIVE_MUTANT_ID"] ?? ""; if (m) appendFileSync(${JSON.stringify(logPath)}, \`\${m}|\${name}\\n\`) }`,
          'describe("Suite [regex] (group)", () => {',
          '  it("fast [a] (1)", () => { logRun("a"); expect(fnA(1)).toBe(true); expect(fnFallback(1)).toBe(true) })',
          '  it("other (b)", () => { logRun("b"); expect(fnB(2)).toBe(true); expect(fnExtra(9)).toBe(true) })',
          '  it("catches >= edge", () => { logRun("edge"); expect(fnFallback(0)).toBe(true) })',
          "})",
        ].join("\n"),
        "utf8",
      )

      const backupPath = join(dir, ".harness", "mutation-backup.json")
      const res = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "harness/domain",
        backupPath,
        hostIo: testHostIo,
        baseSubprocessEnv: { ...process.env, HARNESS_MUTATE_CONCURRENCY: "1" },
        allPackageTests: [tHeavy],
        files: [makeBatchFile(dir, relA, origA, mod.schemaSource, selected, [tHeavy])],
      })
      match(res)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected Ok from Stage 0 per-it batch: ${diagnostic}`)
        })
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          const outcomesMap = fileResults[0]!.fileOutcomes
          for (const m of selected) {
            expect(outcomesMap.get(m.id)?.status).toBe("killed")
          }
          const lines = readFileSync(logPath, "utf8").trim().split("\n")
          const runsFor = (id: string) =>
            lines.filter((l) => l.startsWith(`${id}|`)).map((l) => l.split("|")[1])
          expect(runsFor(mutA.id)).toEqual(["a"])
          expect(runsFor(mutB.id)).toEqual(["b"])
          expect(runsFor(mutFb.id)).toContain("a")
          expect(runsFor(mutFb.id)).toContain("edge")
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
