import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { match } from "ts-pattern"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  compileMutantSchemaModule,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import {
  extractBarrelExportIndex,
  extractBarrelImportUsage,
} from "../src/mutation/mutation-barrel-reachability.js"
import {
  type QueuedPackageEntry,
  executeQueuedPackageBatches,
  runPackageMutantBatchChecked,
  runSingleFileVitestPass,
} from "../src/mutation/mutation-package-batch.js"
import {
  type DomainFile,
  partitionReachingTestFiles,
} from "../src/mutation/mutation-target-discovery.js"
import {
  buildPackageReachabilityIndexChecked,
  isHeavyMetaTestAbsPath,
  resolvePackageImport,
  selectReachabilityPartition,
} from "../src/mutation/mutation-test-reachability.js"
import { testHostIo } from "./helpers/test-host-io.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../../..")

const makeDomainFile = (root: string, relFile: string, pkgName = "@demo/core"): DomainFile => ({
  scope: "demo",
  pkgDir: "core",
  pkgName,
  tier: "core",
  fullPath: join(root, relFile),
  relFile,
})

describe("mutation-scoped-fallback: barrel export/import graph & scoped closure", () => {
  it("extracts barrel exports for named, aliased, wildcard, namespace, local wrapper, and skips type-only", () => {
    const pkgRel = "libs/demo/core"
    const barrelRel = `${pkgRel}/src/index.ts`
    const knownFiles = new Map<string, string>([
      [barrelRel, barrelRel],
      [`${pkgRel}/src/sub.ts`, `${pkgRel}/src/sub.ts`],
      [`${pkgRel}/src/wild.ts`, `${pkgRel}/src/wild.ts`],
      [`${pkgRel}/src/ns.ts`, `${pkgRel}/src/ns.ts`],
      [`${pkgRel}/src/wrapped.ts`, `${pkgRel}/src/wrapped.ts`],
      [`${pkgRel}/src/type-only.ts`, `${pkgRel}/src/type-only.ts`],
    ])
    const barrelContent = [
      'import { wrapTarget, type IgnoredType } from "./wrapped.js"',
      'import defWrap from "./wrapped.js"',
      'import * as wrapNs from "./wrapped.js"',
      'export type { TypeSym } from "./type-only.js"',
      'export { fn, fn as aliasFn, type HiddenType } from "./sub.js"',
      'export * from "./wild.js"',
      'export * as nsMod from "./ns.js"',
      "export { wrapTarget as reExportedWrap }",
      "export const wrapperConst = () => wrapTarget()",
      "export function wrapperFn() { return defWrap() }",
      "export default wrapNs",
    ].join("\n")

    const exportsIdx = extractBarrelExportIndex(barrelRel, barrelContent, (fromRel, spec) =>
      resolvePackageImport(fromRel, spec, pkgRel, "@demo/core", knownFiles),
    )
    expect(exportsIdx.exportsByTarget.get(`${pkgRel}/src/sub.ts`)).toEqual(
      new Set(["fn", "aliasFn"]),
    )
    expect(exportsIdx.wildcardTargets).toEqual(new Set([`${pkgRel}/src/wild.ts`]))
    expect(exportsIdx.exportsByTarget.get(`${pkgRel}/src/ns.ts`)).toEqual(new Set(["nsMod"]))
    expect(exportsIdx.exportsByTarget.get(`${pkgRel}/src/wrapped.ts`)).toEqual(
      new Set(["reExportedWrap", "wrapperConst", "wrapperFn", "default"]),
    )
    expect(exportsIdx.exportsByTarget.has(`${pkgRel}/src/type-only.ts`)).toBe(false)
  })

  it("extracts runtime barrel import usages and excludes type-only imports", () => {
    const pkgRel = "libs/demo/core"
    const barrelRel = `${pkgRel}/src/index.ts`
    const knownFiles = new Map<string, string>([
      [barrelRel, barrelRel],
      [`${pkgRel}/test/a.test.ts`, `${pkgRel}/test/a.test.ts`],
    ])

    const resolveImp = (fromRel: string, spec: string) =>
      resolvePackageImport(fromRel, spec, pkgRel, "@demo/core", knownFiles)

    expect(
      extractBarrelImportUsage(
        `${pkgRel}/test/a.test.ts`,
        'import type { fn } from "../src/index.js"\nexport type X = fn\n',
        barrelRel,
        resolveImp,
      ),
    ).toBeUndefined()

    const mixed = extractBarrelImportUsage(
      `${pkgRel}/test/a.test.ts`,
      'import { type FooType, aliasFn as localAlias } from "@demo/core"\n',
      barrelRel,
      resolveImp,
    )
    expect(mixed?.importsAllFromBarrel).toBe(false)
    expect(mixed?.importedNames).toEqual(new Set(["aliasFn"]))

    const sideEffect = extractBarrelImportUsage(
      `${pkgRel}/test/a.test.ts`,
      'import "../src/index.js"\n',
      barrelRel,
      resolveImp,
    )
    expect(sideEffect?.importsAllFromBarrel).toBe(true)

    const reExporter = extractBarrelImportUsage(
      `${pkgRel}/test/a.test.ts`,
      'export { fn as forwarded, type SkipType } from "../src/index.js"\n',
      barrelRel,
      resolveImp,
    )
    expect(reExporter?.importsAllFromBarrel).toBe(false)
    expect(reExporter?.importedNames).toEqual(new Set(["fn"]))
  })

  it("places barrel-helper consumers in scopedFallbackTests and unrelated/other-symbol barrel consumers in packageFallbackTests", () => {
    const dir = mkdtempSync(join(tmpdir(), "scoped-fb-part-"))
    try {
      const pkg = join(dir, "libs", "demo", "core")
      mkdirSync(join(pkg, "src"), { recursive: true })
      mkdirSync(join(pkg, "test", "helpers"), { recursive: true })

      const targetPath = join(pkg, "src", "target.ts")
      const otherPath = join(pkg, "src", "other.ts")
      const wildPath = join(pkg, "src", "wild.ts")
      const internalOnlyPath = join(pkg, "src", "internal-only.ts")
      writeFileSync(targetPath, "export const computeTarget = (x: number) => x + 1\n", "utf8")
      writeFileSync(otherPath, "export const computeOther = (x: number) => x * 2\n", "utf8")
      writeFileSync(wildPath, "export const computeWild = (x: number) => x - 1\n", "utf8")
      writeFileSync(
        internalOnlyPath,
        "export const internalSecret = (x: number) => x + 9\n",
        "utf8",
      )
      writeFileSync(
        join(pkg, "src", "index.ts"),
        [
          'export { computeTarget as aliasedHelper } from "./target.js"',
          'export { computeOther } from "./other.js"',
          'export * from "./wild.js"',
        ].join("\n"),
        "utf8",
      )

      const tDirect = join(pkg, "test", "direct.test.ts")
      const tBridge = join(pkg, "test", "bridge.test.ts")
      const tOtherBarrel = join(pkg, "test", "other-barrel.test.ts")
      const tTypeOnly = join(pkg, "test", "type-only.test.ts")
      const tUnrelated = join(pkg, "test", "unrelated.test.ts")
      const tNamespace = join(pkg, "test", "namespace.test.ts")

      writeFileSync(
        join(pkg, "test", "helpers", "bridge.ts"),
        'import { aliasedHelper } from "../../src/index.js"\nexport const runBridge = () => aliasedHelper(1)\n',
        "utf8",
      )
      writeFileSync(
        tDirect,
        [
          'import { computeTarget } from "../src/target.js"',
          'import { internalSecret } from "../src/internal-only.js"',
          "export const d = computeTarget(1) + internalSecret(1)",
        ].join("\n"),
        "utf8",
      )
      writeFileSync(
        tBridge,
        'import { runBridge } from "./helpers/bridge.js"\nexport const b = runBridge()\n',
        "utf8",
      )
      writeFileSync(
        tOtherBarrel,
        'import { computeOther } from "../src/index.js"\nexport const o = computeOther(2)\n',
        "utf8",
      )
      writeFileSync(
        tTypeOnly,
        'import type { aliasedHelper } from "../src/index.js"\nexport type T = typeof aliasedHelper\n',
        "utf8",
      )
      writeFileSync(tUnrelated, "export const u = 1\n", "utf8")
      writeFileSync(
        tNamespace,
        'import * as api from "@demo/core"\nexport const n = api.computeOther(1)\n',
        "utf8",
      )

      const part = partitionReachingTestFiles(
        dir,
        makeDomainFile(dir, "libs/demo/core/src/target.ts"),
        readFileSync(targetPath, "utf8"),
        testHostIo,
      )
      expect(part.primaryTests).toEqual([tDirect])
      expect(part.scopedFallbackTests).toContain(tBridge)
      expect(part.scopedFallbackTests).toContain(tNamespace)
      expect(part.scopedFallbackTests).not.toContain(tOtherBarrel)
      expect(part.scopedFallbackTests).not.toContain(tTypeOnly)
      expect(part.scopedFallbackTests).not.toContain(tUnrelated)
      expect(part.packageFallbackTests).toContain(tOtherBarrel)
      expect(part.packageFallbackTests).toContain(tTypeOnly)
      expect(part.packageFallbackTests).toContain(tUnrelated)
      expect(part.fallbackTests).toEqual([
        ...part.scopedFallbackTests,
        ...part.packageFallbackTests,
      ])

      // Wildcard export in barrel includes named barrel consumers in primaryTests (via static barrel reachability) and keeps unrelated in packageFallbackTests
      const wildPart = partitionReachingTestFiles(
        dir,
        makeDomainFile(dir, "libs/demo/core/src/wild.ts"),
        readFileSync(wildPath, "utf8"),
        testHostIo,
      )
      expect(wildPart.primaryTests).toContain(tOtherBarrel)
      expect(wildPart.packageFallbackTests).toContain(tUnrelated)

      // Internal-only module not exported by barrel does NOT pull namespace barrel importers into scopedFallbackTests
      const internalPart = partitionReachingTestFiles(
        dir,
        makeDomainFile(dir, "libs/demo/core/src/internal-only.ts"),
        readFileSync(internalOnlyPath, "utf8"),
        testHostIo,
      )
      expect(internalPart.scopedFallbackTests).toEqual([])
      expect(internalPart.packageFallbackTests).not.toHaveLength(0)

      // Verify selectReachabilityPartition disjointness across all tests
      const built = buildPackageReachabilityIndexChecked(
        dir,
        "libs/demo/core",
        "@demo/core",
        [],
        testHostIo,
      )
      match(built)
        .with({ _tag: "Error" }, ({ reason }) => {
          expect.unreachable(`Expected Ok reachability index: ${reason}`)
        })
        .with({ _tag: "Ok" }, ({ index }) => {
          const eligible = [tDirect, tBridge, tOtherBarrel, tTypeOnly, tUnrelated, tNamespace]
          const sel = selectReachabilityPartition({
            index,
            targetRelFile: "libs/demo/core/src/target.ts",
            eligibleTests: eligible,
            directStemTests: [],
            symbolMatchedTests: [],
          })
          expect(sel.primaryTests).toEqual([tDirect])
          const all = new Set([
            ...sel.primaryTests,
            ...sel.scopedFallbackTests,
            ...sel.packageFallbackTests,
          ])
          expect(all.size).toBe(eligible.length)
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("mutation-scoped-fallback: two-stage fallback execution", () => {
  it("runSingleFileVitestPass stops after scopedFallbackTests when all survivors are killed and escalates to packageFallbackTests only when survivors remain", () => {
    const dir = mkdtempSync(join(tmpdir(), "single-two-stage-"))
    try {
      const pkg = join(dir, "libs", "demo", "core")
      mkdirSync(join(pkg, "src"), { recursive: true })
      mkdirSync(join(pkg, "test"), { recursive: true })
      const rel = "libs/demo/core/src/calc.ts"
      const src = "export const inc = (n: number): number => n + 1\n"
      writeFileSync(join(dir, rel), src, "utf8")
      const mut = discoverDomainMutants(rel, src)[0]!
      const mod = compileMutantSchemaModule(rel, src, [mut])
      const tPrim = join(pkg, "test", "prim.test.ts")
      const tScoped = join(pkg, "test", "scoped.test.ts")
      const tPkg = join(pkg, "test", "pkg.test.ts")

      const calls: Array<ReadonlyArray<string>> = []
      const makeMockIo = (killStage: "scoped" | "package"): SyncHostIo => ({
        ...testHostIo,
        unlinkSync: () => {},
        execFileSync: (_cmd, args, opts) => {
          const testArgs = args.filter((a) => a.endsWith(".test.ts"))
          calls.push(testArgs)
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
          }
          const isKill = match(killStage)
            .with("scoped", () => testArgs.includes(tScoped))
            .with("package", () => testArgs.includes(tPkg))
            .exhaustive()
          return isKill
            ? { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" }
            : { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
        },
      })

      const resScopedKill = runSingleFileVitestPass({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "backup.json"),
        hostIo: makeMockIo("scoped"),
        baseSubprocessEnv: {},
        file: makeDomainFile(dir, rel),
        originalContent: src,
        schemaSource: mod.schemaSource,
        mutants: [mut],
        uncachedMutants: [mut],
        primaryTests: [tPrim],
        scopedFallbackTests: [tScoped],
        packageFallbackTests: [tPkg],
        cachedHitIds: new Set(),
        pkgBaselinePassed: true,
      })
      match(resScopedKill)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected Ok: ${diagnostic}`)
        })
        .with({ _tag: "Ok" }, ({ result }) => {
          expect(result.fileOutcomes.get(mut.id)?.status).toBe("killed")
        })
        .exhaustive()
      expect(calls.some((c) => c.includes(tScoped))).toBe(true)
      expect(calls.some((c) => c.includes(tPkg))).toBe(false)

      calls.length = 0
      const resPkgEscalation = runSingleFileVitestPass({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "backup.json"),
        hostIo: makeMockIo("package"),
        baseSubprocessEnv: {},
        file: makeDomainFile(dir, rel),
        originalContent: src,
        schemaSource: mod.schemaSource,
        mutants: [mut],
        uncachedMutants: [mut],
        primaryTests: [tPrim],
        scopedFallbackTests: [tScoped],
        packageFallbackTests: [tPkg],
        cachedHitIds: new Set(),
        pkgBaselinePassed: true,
      })
      match(resPkgEscalation)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected Ok: ${diagnostic}`)
        })
        .with({ _tag: "Ok" }, ({ result }) => {
          expect(result.fileOutcomes.get(mut.id)?.status).toBe("killed")
        })
        .exhaustive()
      expect(calls.some((c) => c.includes(tScoped))).toBe(true)
      expect(calls.some((c) => c.includes(tPkg))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runPackageMutantBatchChecked skips packageFallbackTests on scoped kill and runs solo cold recheck against the matching stage list", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-two-stage-"))
    try {
      const pkg = join(dir, "libs", "demo", "domain")
      mkdirSync(join(pkg, "src"), { recursive: true })
      mkdirSync(join(pkg, "test"), { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8")
      symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir")
      symlinkSync(join(REAL_REPO_ROOT, "tools"), join(dir, "tools"), "dir")

      const relA = "libs/demo/domain/src/a.ts"
      const srcA = [
        "export const pFn = (n: number): number => n + 1",
        "export const sFn = (n: number): number => n - 1",
      ].join("\n")
      writeFileSync(join(dir, relA), srcA, "utf8")
      const muts = discoverDomainMutants(relA, srcA)
      const mod = compileMutantSchemaModule(relA, srcA, muts)

      const tPrim = "libs/demo/domain/test/prim.test.ts"
      const tScoped = "libs/demo/domain/test/scoped.test.ts"
      const tPkg = "libs/demo/domain/test/pkg.test.ts"
      const pkgMarker = join(dir, "pkg-ran.marker")
      writeFileSync(
        join(dir, tPrim),
        'import { expect, it } from "vitest"\nimport { pFn } from "../src/a.js"\nit("p", () => { expect(pFn(1)).toBe(2) })\n',
        "utf8",
      )
      writeFileSync(
        join(dir, tScoped),
        'import { expect, it } from "vitest"\nimport { sFn } from "../src/a.js"\nit("s", () => { expect(sFn(5)).toBe(4) })\n',
        "utf8",
      )
      writeFileSync(
        join(dir, tPkg),
        `import { writeFileSync } from "node:fs"\nimport { expect, it } from "vitest"\nwriteFileSync(${JSON.stringify(pkgMarker)}, "ran")\nit("u", () => { expect(1).toBe(1) })\n`,
        "utf8",
      )

      const backupPath = join(dir, ".harness", "mutation-backup.json")
      const res = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/domain",
        backupPath,
        hostIo: testHostIo,
        baseSubprocessEnv: process.env,
        allPackageTests: [tPrim, tScoped, tPkg],
        files: [
          {
            file: makeDomainFile(dir, relA, "@demo/domain"),
            originalContent: srcA,
            schemaSource: mod.schemaSource,
            mutants: muts,
            uncachedMutants: muts,
            primaryTests: [tPrim],
            scopedFallbackTests: [tScoped],
            packageFallbackTests: [tPkg],
            fallbackTests: [tScoped, tPkg],
            cachedHitIds: new Set(),
          },
        ],
      })
      match(res)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected Ok: ${diagnostic}`)
        })
        .with({ _tag: "Ok" }, ({ fileResults }) => {
          for (const m of muts) {
            expect(fileResults[0]?.fileOutcomes.get(m.id)?.status).toBe("killed")
          }
        })
        .exhaustive()
      expect(testHostIo.existsSync(pkgMarker)).toBe(false)

      // Solo cold recheck uses matching stage list (scopedFallbackTests -> packageFallbackTests)
      const soloArgs: Array<ReadonlyArray<string>> = []
      let batchCall = 0
      const soloIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) =>
          p.endsWith("vitest.mjs") ||
          p.endsWith("package-vitest-batch.mjs") ||
          testHostIo.existsSync(p),
        unlinkSync: () => {},
        execFileSync: (_cmd, args, opts) => {
          batchCall += 1
          if (batchCall === 1) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  relFile: relA,
                  primaryResults: muts.map((m) => ({
                    id: m.id,
                    result: {
                      _tag: "Exited",
                      exitCode: 0,
                      stdout: "Tests 1 passed (1)",
                      stderr: "",
                    },
                  })),
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
          }
          soloArgs.push(args.filter((a) => a.endsWith(".test.ts")))
          const hitPkg = args.some((a) => a.endsWith("pkg.test.ts"))
          return hitPkg
            ? { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" }
            : { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
        },
      }
      const soloRes = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/domain",
        backupPath,
        hostIo: soloIo,
        baseSubprocessEnv: {},
        allPackageTests: [tPrim, tScoped, tPkg],
        files: [
          {
            file: makeDomainFile(dir, relA, "@demo/domain"),
            originalContent: srcA,
            schemaSource: mod.schemaSource,
            mutants: [muts[0]!],
            uncachedMutants: [muts[0]!],
            primaryTests: [tPrim],
            scopedFallbackTests: [tScoped],
            packageFallbackTests: [tPkg],
            fallbackTests: [tScoped, tPkg],
            cachedHitIds: new Set(),
          },
        ],
      })
      expect(soloRes._tag).toBe("Ok")
      expect(soloArgs.some((a) => a.includes(tScoped))).toBe(true)
      expect(soloArgs.some((a) => a.includes(tPkg))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("live @harness/gates dogfooding moves unrelated tests into packageFallbackTests instead of scopedFallbackTests", () => {
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
    expect(part.packageFallbackTests.length).toBeGreaterThan(10)
    expect(part.fallbackTests).toEqual([...part.scopedFallbackTests, ...part.packageFallbackTests])
  })

  it("extracts dynamic import/require, hoisted exports, local wrappers, destructured exports, anonymous default, and subpath package imports", () => {
    const pkgRel = "libs/demo/core"
    const barrelRel = `${pkgRel}/src/index.ts`
    const knownFiles = new Map<string, string>([
      [barrelRel, barrelRel],
      [`${pkgRel}/src/sub.ts`, `${pkgRel}/src/sub.ts`],
      [`${pkgRel}/src/dep.ts`, `${pkgRel}/src/dep.ts`],
      [`${pkgRel}/src/hoisted.ts`, `${pkgRel}/src/hoisted.ts`],
    ])
    const resolveImport = (fromRel: string, spec: string) =>
      resolvePackageImport(fromRel, spec, pkgRel, "@demo/core", knownFiles)

    expect(resolveImport(`${pkgRel}/test/a.test.ts`, "@demo/core/sub")).toBe(`${pkgRel}/src/sub.ts`)
    expect(resolveImport(`${pkgRel}/test/a.test.ts`, "@demo/core")).toBe(barrelRel)

    const barrelContent = [
      "export { hoistedFn }",
      'import { hoistedFn } from "./hoisted.js"',
      'import { dep } from "./dep.js"',
      "const wrap = () => dep()",
      "function wrapLocalFn() { return dep() }",
      "export { wrap, wrapLocalFn }",
      "export const { a, b } = makeApi(dep)",
      "export default function () { return dep() }",
    ].join("\n")
    const idx = extractBarrelExportIndex(barrelRel, barrelContent, resolveImport)
    expect(Array.from(idx.exportsByTarget.get(`${pkgRel}/src/hoisted.ts`) ?? [])).toEqual([
      "hoistedFn",
    ])
    expect(Array.from(idx.exportsByTarget.get(`${pkgRel}/src/dep.ts`) ?? []).sort()).toEqual([
      "a",
      "b",
      "default",
      "wrap",
      "wrapLocalFn",
    ])

    const dynUsage = extractBarrelImportUsage(
      `${pkgRel}/test/dyn.test.ts`,
      'export const load = async () => import("../src/index.js")',
      barrelRel,
      resolveImport,
    )
    expect(dynUsage?.importsAllFromBarrel).toBe(true)

    const reqUsage = extractBarrelImportUsage(
      `${pkgRel}/test/req.test.ts`,
      'const mod = require("../src/index.js")',
      barrelRel,
      resolveImport,
    )
    expect(reqUsage?.importsAllFromBarrel).toBe(true)
  })

  it("handles mixed scopedFallbackResults, fallback solo-recheck abort, restoreError ordering without solo recheck or caching, and fallback baseline check", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-fb-edge-"))
    try {
      const pkg = join(dir, "libs", "demo", "core")
      mkdirSync(join(pkg, "src"), { recursive: true })
      mkdirSync(join(pkg, "test"), { recursive: true })
      const relA = "libs/demo/core/src/a.ts"
      const srcA = [
        "export const fnA = (n: number): number => n + 1",
        "export const fnB = (n: number): number => n - 1",
      ].join("\n")
      writeFileSync(join(dir, relA), srcA, "utf8")
      const muts = discoverDomainMutants(relA, srcA)
      expect(muts.length).toBeGreaterThanOrEqual(2)
      const mut1 = muts[0]!
      const mut2 = muts[1]!
      const selected = [mut1, mut2]
      const mod = compileMutantSchemaModule(relA, srcA, selected)
      const tPrim = "libs/demo/core/test/prim.test.ts"
      const tScoped = "libs/demo/core/test/scoped.test.ts"
      writeFileSync(
        join(dir, tPrim),
        'import { expect, it } from "vitest"\nit("p", () => expect(1).toBe(1))\n',
        "utf8",
      )
      writeFileSync(
        join(dir, tScoped),
        'import { expect, it } from "vitest"\nit("s", () => expect(1).toBe(1))\n',
        "utf8",
      )
      const backupPath = join(dir, ".harness", "mutation-backup.json")
      const makeBatchFile = () => ({
        file: makeDomainFile(dir, relA, "@demo/core"),
        originalContent: srcA,
        schemaSource: mod.schemaSource,
        mutants: selected,
        uncachedMutants: selected,
        primaryTests: [tPrim],
        scopedFallbackTests: [tScoped],
        packageFallbackTests: [],
        fallbackTests: [tScoped],
        cachedHitIds: new Set<string>(),
      })

      // 1. Mixed scopedFallbackResults: mut1 clean survivor, mut2 unreported -> solo recheck runs for mut2
      let call = 0
      const soloIds: Array<string | undefined> = []
      const mixedIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) =>
          p.endsWith("vitest.mjs") ||
          p.endsWith("package-vitest-batch.mjs") ||
          testHostIo.existsSync(p),
        unlinkSync: () => {},
        execFileSync: (_cmd, _args, opts) => {
          call += 1
          if (call === 1) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  relFile: relA,
                  primaryResults: selected.map((m) => ({
                    id: m.id,
                    result: {
                      _tag: "Exited",
                      exitCode: 0,
                      stdout: "Tests 1 passed (1)",
                      stderr: "",
                    },
                  })),
                  scopedFallbackResults: [
                    {
                      id: mut1.id,
                      result: {
                        _tag: "Exited",
                        exitCode: 0,
                        stdout: "Tests 1 passed (1)",
                        stderr: "",
                      },
                    },
                  ],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
          if (activeId === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
          }
          soloIds.push(activeId)
          return { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" }
        },
      }
      const mixedRes = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath,
        hostIo: soloIoEnv(mixedIo),
        baseSubprocessEnv: {},
        allPackageTests: [tPrim, tScoped],
        files: [makeBatchFile()],
      })
      expect(mixedRes._tag).toBe("Ok")
      expect(soloIds).toEqual([mut2.id])

      // 2. Abort inside processBatchFallbackStage when ambiguous exitCode:1 solo recheck SpawnFailed
      let abortCall = 0
      const fbAbortIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) =>
          p.endsWith("vitest.mjs") ||
          p.endsWith("package-vitest-batch.mjs") ||
          testHostIo.existsSync(p),
        unlinkSync: () => {},
        execFileSync: (_cmd, _args, opts) => {
          abortCall += 1
          if (abortCall === 1) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  relFile: relA,
                  primaryResults: selected.map((m) => ({
                    id: m.id,
                    result: {
                      _tag: "Exited",
                      exitCode: 0,
                      stdout: "Tests 1 passed (1)",
                      stderr: "",
                    },
                  })),
                  scopedFallbackResults: [
                    {
                      id: mut1.id,
                      result: { _tag: "Exited", exitCode: 1, stdout: "", stderr: "" },
                    },
                  ],
                  packageFallbackResults: [],
                },
              ]),
              stderr: "",
            }
          }
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
          }
          return { _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" }
        },
      }
      const fbAbortRes = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath,
        hostIo: fbAbortIo,
        baseSubprocessEnv: {},
        allPackageTests: [tPrim, tScoped],
        files: [makeBatchFile()],
      })
      expect(abortCall).toBe(3)
      match(fbAbortRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect(diagnostic).toContain("ENOENT")
        })
        .with({ _tag: "Ok" }, () => expect.unreachable("Expected Abort from fallback solo recheck"))
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const setupRestoreOrderFixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-fb-restore-"))
    const pkg = join(dir, "libs", "demo", "core")
    mkdirSync(join(pkg, "src"), { recursive: true })
    mkdirSync(join(pkg, "test"), { recursive: true })
    const relA = "libs/demo/core/src/a.ts"
    const srcA = [
      "export const fnA = (n: number): number => n + 1",
      "export const fnB = (n: number): number => n - 1",
    ].join("\n")
    writeFileSync(join(dir, relA), srcA, "utf8")
    const muts = discoverDomainMutants(relA, srcA)
    const mut1 = muts[0]!
    const selected = [mut1, muts[1]!]
    const mod = compileMutantSchemaModule(relA, srcA, selected)
    const tPrim = "libs/demo/core/test/prim.test.ts"
    const tScoped = "libs/demo/core/test/scoped.test.ts"
    writeFileSync(
      join(dir, tPrim),
      'import { expect, it } from "vitest"\nit("p", () => expect(1).toBe(1))\n',
      "utf8",
    )
    writeFileSync(
      join(dir, tScoped),
      'import { expect, it } from "vitest"\nit("s", () => expect(1).toBe(1))\n',
      "utf8",
    )
    const backupPath = join(dir, ".harness", "mutation-backup.json")
    const makeBatchFile = () => ({
      file: makeDomainFile(dir, relA, "@demo/core"),
      originalContent: srcA,
      schemaSource: mod.schemaSource,
      mutants: selected,
      uncachedMutants: selected,
      primaryTests: [tPrim],
      scopedFallbackTests: [tScoped],
      packageFallbackTests: [],
      fallbackTests: [tScoped],
      cachedHitIds: new Set<string>(),
    })
    return { dir, relA, srcA, mut1, selected, mod, tPrim, tScoped, backupPath, makeBatchFile }
  }

  it("checks restoreError ordering without solo recheck or caching, and enforces fallback baseline check", () => {
    const { dir, relA, srcA, mut1, selected, mod, tPrim, tScoped, backupPath, makeBatchFile } =
      setupRestoreOrderFixture()
    try {
      // 3a. restoreError with empty primaryResults preserves restoreError
      const emptyRestoreIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) =>
          p.endsWith("vitest.mjs") ||
          p.endsWith("package-vitest-batch.mjs") ||
          testHostIo.existsSync(p),
        unlinkSync: () => {},
        execFileSync: () => ({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify([
            {
              relFile: relA,
              primaryResults: [],
              scopedFallbackResults: [],
              packageFallbackResults: [],
              restoreError: "disk write failed",
            },
          ]),
          stderr: "",
        }),
      }
      const emptyRestoreRes = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath,
        hostIo: emptyRestoreIo,
        baseSubprocessEnv: {},
        allPackageTests: [tPrim, tScoped],
        files: [makeBatchFile()],
      })
      match(emptyRestoreRes)
        .with({ _tag: "Ok" }, () => expect.unreachable("Expected Abort"))
        .with({ _tag: "Abort" }, ({ diagnostic, partialResults }) => {
          expect(diagnostic).toBe("disk write failed")
          expect(partialResults).toEqual([])
        })
        .exhaustive()

      // 3b. restoreError with ambiguous primaryResults skips solo recheck and does not push tainted file into partialResults
      let restoreCalls = 0
      const taintedRestoreIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) =>
          p.endsWith("vitest.mjs") ||
          p.endsWith("package-vitest-batch.mjs") ||
          testHostIo.existsSync(p),
        unlinkSync: () => {},
        execFileSync: () => {
          restoreCalls += 1
          return {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify([
              {
                relFile: relA,
                primaryResults: selected.map((m) => ({
                  id: m.id,
                  result: { _tag: "Exited", exitCode: 1, stdout: "", stderr: "" },
                })),
                scopedFallbackResults: [],
                packageFallbackResults: [],
                restoreError: "restore conflict",
              },
            ]),
            stderr: "",
          }
        },
      }
      const taintedRestoreRes = runPackageMutantBatchChecked({
        repoRoot: dir,
        pkgKey: "demo/core",
        backupPath,
        hostIo: taintedRestoreIo,
        baseSubprocessEnv: {},
        allPackageTests: [tPrim, tScoped],
        files: [makeBatchFile()],
      })
      expect(restoreCalls).toBe(1)
      match(taintedRestoreRes)
        .with({ _tag: "Ok" }, () => expect.unreachable("Expected Abort"))
        .with({ _tag: "Abort" }, ({ diagnostic, partialResults }) => {
          expect(diagnostic).toBe("restore conflict")
          expect(partialResults).toEqual([])
        })
        .exhaustive()

      // 4. runSingleFileVitestPass with pkgBaselinePassed: true still enforces baseline on scopedFallbackTests
      let singleCall = 0
      const brokenFallbackBaselineIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => p.endsWith("vitest.mjs") || testHostIo.existsSync(p),
        unlinkSync: () => {},
        execFileSync: (_cmd, args, opts) => {
          singleCall += 1
          if (args.some((a) => a.endsWith("prim.test.ts"))) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests 1 passed (1)\n", stderr: "" }
          }
          // Baseline check runs without HARNESS_ACTIVE_MUTANT_ID; mutant run gets a clean failure if baseline were skipped.
          return opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined
            ? { _tag: "Exited", exitCode: 1, stdout: "Baseline failed\n", stderr: "" }
            : { _tag: "Exited", exitCode: 1, stdout: "Tests 1 failed (1)\n", stderr: "" }
        },
      }
      const singleRes = runSingleFileVitestPass({
        repoRoot: dir,
        backupPath,
        hostIo: brokenFallbackBaselineIo,
        baseSubprocessEnv: {},
        file: makeDomainFile(dir, relA, "@demo/core"),
        originalContent: srcA,
        schemaSource: mod.schemaSource,
        mutants: [mut1],
        uncachedMutants: [mut1],
        primaryTests: [tPrim],
        scopedFallbackTests: [tScoped],
        packageFallbackTests: [],
        cachedHitIds: new Set(),
        pkgBaselinePassed: true,
      })
      expect(singleCall).toBe(2)
      match(singleRes)
        .with({ _tag: "Ok" }, () =>
          expect.unreachable("Expected Abort from fallback baseline failure"),
        )
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect(diagnostic.toLowerCase()).toContain("baseline")
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("enforces baseline check on processBatchFallbackStage solo rechecks", () => {
    const { dir, relA, selected, mut1, tPrim, tScoped, backupPath, makeBatchFile } =
      setupRestoreOrderFixture()
    try {
      // 5a: reported ambiguous mutant (applyBatchPassOutcomes); 5b: unreported surviving mutant (runVitestTargetList)
      const fallbackResultCases = [
        [
          {
            id: mut1.id,
            result: { _tag: "Exited" as const, exitCode: 1, stdout: "", stderr: "" },
          },
        ],
        [],
      ]
      for (const scopedFallbackResults of fallbackResultCases) {
        let batchFbCalls = 0
        const batchFbBaselineIo: SyncHostIo = {
          ...testHostIo,
          existsSync: (p) =>
            p.endsWith("vitest.mjs") ||
            p.endsWith("package-vitest-batch.mjs") ||
            testHostIo.existsSync(p),
          unlinkSync: () => {},
          execFileSync: () => {
            batchFbCalls += 1
            if (batchFbCalls === 1) {
              return {
                _tag: "Exited",
                exitCode: 0,
                stdout: JSON.stringify([
                  {
                    relFile: relA,
                    primaryResults: selected.map((m) => ({
                      id: m.id,
                      result: {
                        _tag: "Exited",
                        exitCode: 0,
                        stdout: "Tests 1 passed (1)",
                        stderr: "",
                      },
                    })),
                    scopedFallbackResults,
                    packageFallbackResults: [],
                  },
                ]),
                stderr: "",
              }
            }
            return { _tag: "Exited", exitCode: 1, stdout: "Baseline failed\n", stderr: "" }
          },
        }
        const batchFbBaselineRes = runPackageMutantBatchChecked({
          repoRoot: dir,
          pkgKey: "demo/core",
          backupPath,
          hostIo: batchFbBaselineIo,
          baseSubprocessEnv: {},
          allPackageTests: [tPrim, tScoped],
          files: [makeBatchFile()],
        })
        expect(batchFbCalls).toBe(2)
        match(batchFbBaselineRes)
          .with({ _tag: "Ok" }, () => expect.unreachable("Expected Abort"))
          .with({ _tag: "Abort" }, ({ diagnostic }) => {
            expect(diagnostic.toLowerCase()).toContain("baseline")
          })
          .exhaustive()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("chunks executeQueuedPackageBatches at 4 files with incremental finalize and classifies heavy split tests", () => {
    for (const heavyBase of [
      "policy-check-architecture-and-layers.test.ts",
      "policy-check-patterns-and-types.test.ts",
      "governance-nodes.test.ts",
      "mutation-cache.test.ts",
      "mutation-scoped-fallback.test.ts",
    ]) {
      expect(isHeavyMetaTestAbsPath(`/repo/libs/demo/test/${heavyBase}`)).toBe(true)
    }
    expect(isHeavyMetaTestAbsPath("/repo/libs/demo/test/fast-unit.test.ts")).toBe(false)

    const dir = mkdtempSync(join(tmpdir(), "pkg-chunk-"))
    const stderrLines: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      const makeEntry = (idx: number): QueuedPackageEntry => {
        const relFile = `libs/demo/core/src/f${idx}.ts`
        const src = `export const f${idx} = (n: number): number => n + 1`
        const mut = discoverDomainMutants(relFile, src)[0]!
        return {
          pkgKey: "demo/core",
          mutantKeys: new Map(),
          input: {
            file: makeDomainFile(dir, relFile),
            originalContent: src,
            schemaSource: compileMutantSchemaModule(relFile, src, [mut]).schemaSource,
            mutants: [mut],
            uncachedMutants: [mut],
            primaryTests: [`libs/demo/core/test/f${idx}.test.ts`],
            scopedFallbackTests: [],
            packageFallbackTests: [],
            fallbackTests: [],
            cachedHitIds: new Set(),
          },
        }
      }
      const makeMockBatchIo = (batchSizes: Array<number>): SyncHostIo => ({
        ...testHostIo,
        existsSync: (p) =>
          p.endsWith("vitest.mjs") ||
          p.endsWith("package-vitest-batch.mjs") ||
          testHostIo.existsSync(p),
        mkdirRecursiveSync: () => {},
        writeTextSync: (_p, content) => {
          if (content.includes('"files":')) {
            batchSizes.push((JSON.parse(content) as { files: ReadonlyArray<unknown> }).files.length)
          }
        },
        unlinkSync: () => {},
        execFileSync: (_cmd, _args, opts) => {
          const planPath = opts?.env?.["HARNESS_PACKAGE_PLAN_FILE"] ?? ""
          const count = batchSizes[batchSizes.length - 1] ?? 0
          const startIdx = batchSizes.slice(0, -1).reduce((a, b) => a + b, 0)
          void planPath
          return {
            _tag: "Exited",
            exitCode: 0,
            stdout: JSON.stringify(
              Array.from({ length: count }, (_, k) => {
                const entry = entriesFive[startIdx + k]!
                return {
                  relFile: entry.input.file.relFile,
                  primaryResults: entry.input.uncachedMutants.map((m) => ({
                    id: m.id,
                    result: {
                      _tag: "Exited",
                      exitCode: 1,
                      stdout: "Tests 1 failed (1)",
                      stderr: "",
                    },
                  })),
                  scopedFallbackResults: [],
                  packageFallbackResults: [],
                }
              }),
            ),
            stderr: "",
          }
        },
      })

      const entriesFive = [0, 1, 2, 3, 4].map(makeEntry)
      const sizesFour: Array<number> = []
      const finalizedFour: Array<string> = []
      const errFour = executeQueuedPackageBatches({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "backup.json"),
        hostIo: makeMockBatchIo(sizesFour),
        baseSubprocessEnv: {},
        queuedByPkg: new Map([["demo/core", entriesFive.slice(0, 4)]]),
        finalizeEntry: (e) => {
          finalizedFour.push(e.input.file.relFile)
          return undefined
        },
        recordPartialOnAbort: () => {},
      })
      expect(errFour).toBeUndefined()
      expect(sizesFour).toEqual([4])
      expect(finalizedFour).toHaveLength(4)

      const sizesFive: Array<number> = []
      const finalizedFive: Array<string> = []
      const errFive = executeQueuedPackageBatches({
        repoRoot: dir,
        backupPath: join(dir, ".harness", "backup.json"),
        hostIo: makeMockBatchIo(sizesFive),
        baseSubprocessEnv: {},
        queuedByPkg: new Map([["demo/core", entriesFive]]),
        finalizeEntry: (e) => {
          finalizedFive.push(e.input.file.relFile)
          return undefined
        },
        recordPartialOnAbort: () => {},
      })
      expect(errFive).toBeUndefined()
      expect(sizesFive).toEqual([4, 1])
      expect(finalizedFive).toHaveLength(5)
      expect(stderrLines.join("")).toContain(
        "[mutation-check] demo/core (4/5 files, 4 mutants) done in ",
      )
      expect(stderrLines.join("")).toContain(
        "[mutation-check] demo/core (5/5 files, 1 mutants) done in ",
      )
    } finally {
      process.stderr.write = origWrite
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const soloIoEnv = (io: SyncHostIo): SyncHostIo => io
