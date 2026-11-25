import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Redacted } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  type ContentSha256,
  MUTATION_CACHE_SCHEMA_VERSION,
  MutantCacheId,
  type MutationCacheAuth,
  type MutationCacheEntry,
  MutationCacheHmacSecret,
  type MutationCacheStore,
  MutationCacheTimestamp,
  MutationEpochMillis,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import {
  MutationCache,
  computeFileMutationClosureDigest,
  computeMutationContextDigests,
  computeMutationEntryMac,
  isBarrelFilePath,
  isPureReExportBarrel,
  resolveBarrelClosureStep,
  runPackageMutantBatchChecked,
} from "../src/index.js"
import {
  type CachedBarrelMeta,
  loadCachedBarrelMeta,
} from "../src/mutation/mutation-barrel-closure.js"
import { extractBarrelExportIndex } from "../src/mutation/mutation-barrel-reachability.js"
import {
  compileMutantSchemaModule,
  discoverDomainMutants,
} from "../src/mutation/mutant-ast-generator.js"
import type { PackageBatchFileInput } from "../src/mutation/mutation-package-batch.js"
import { maybeEmitPackageBatchProgress } from "../src/mutation/mutation-batch-stream.js"
import { isolatedTestHostIo } from "./helpers/test-host-io.js"

const TEST_HMAC_SECRET = Redacted.make(
  MutationCacheHmacSecret.make("barrel-closure-hmac-secret-0123456789abcdef"),
)
const TEST_CACHE_AUTH: MutationCacheAuth = {
  _tag: "Enabled",
  hmacSecret: TEST_HMAC_SECRET,
}
const BASE_NOW_MS = MutationEpochMillis.make(Date.parse("2026-11-25T12:00:00.000Z"))
const RECORDED_AT = MutationCacheTimestamp.make("2026-11-25T11:30:00.000Z")

const writeFileMkdir = (filePath: string, content: string): void => {
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

const unwrapOpt = <A>(opt: Option.Option<A>): A =>
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => {
      throw new Error("Expected Option.Some")
    })
    .exhaustive()

const getOkClosure = (
  repoRoot: string,
  relFile: string,
  witness: string,
  hostIo = isolatedTestHostIo,
) => {
  const digests = unwrapOpt(computeMutationContextDigests(repoRoot, hostIo))
  return match(
    computeFileMutationClosureDigest({
      repoRoot,
      relFile,
      allReachingTests: [witness],
      digests,
      hostIo,
    }),
  )
    .with({ _tag: "Ok" }, (ok) => ok)
    .with({ _tag: "Disabled" }, ({ reason }) => {
      throw new Error(`Expected Ok closure: ${reason}`)
    })
    .exhaustive()
}

const setupBarrelRepo = (): string => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mutation-barrel-closure-"))
  writeFileMkdir(join(repoRoot, "tsconfig.base.json"), '{"compilerOptions":{}}\n')
  writeFileMkdir(
    join(repoRoot, "node_modules", "vitest", "package.json"),
    '{"name":"vitest","version":"5.0.0"}\n',
  )
  writeFileMkdir(join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "// vitest\n")
  writeFileMkdir(
    join(repoRoot, "libs", "sample", "domain", "package.json"),
    '{"name":"@sample/domain","nx":{"tags":["type:domain"]},"exports":{".":"./src/index.ts"}}\n',
  )
  writeFileMkdir(
    join(repoRoot, "libs", "sample", "domain", "src", "used.ts"),
    "export const usedFn = (n: number): number => n + 1\n",
  )
  writeFileMkdir(
    join(repoRoot, "libs", "sample", "domain", "src", "used-v2.ts"),
    "export const usedFn = (n: number): number => n + 2\n",
  )
  writeFileMkdir(
    join(repoRoot, "libs", "sample", "domain", "src", "unused.ts"),
    "export const unusedFn = (n: number): number => n * 2\n",
  )
  writeFileMkdir(
    join(repoRoot, "libs", "sample", "domain", "src", "index.ts"),
    ['export { usedFn } from "./used.js"', 'export { unusedFn } from "./unused.js"', ""].join("\n"),
  )
  writeFileMkdir(
    join(repoRoot, "libs", "sample", "domain", "test", "used.test.ts"),
    [
      'import { expect, it } from "vitest"',
      'import { usedFn } from "../src/index.js"',
      'it("usedFn", () => { expect(usedFn(1)).toBe(2) })',
      "",
    ].join("\n"),
  )
  return repoRoot
}

const makeWitnessEntry = (
  key: ContentSha256,
  fileRel: string,
  witnessRel: string,
  witnessClosureSha256: ContentSha256,
): MutationCacheEntry => {
  const file = AstSourceFilePath.make(fileRel)
  const mutantId = MutantCacheId.make("m-1")
  const witnessTestFile = AstSourceFilePath.make(witnessRel)
  return {
    key,
    file,
    mutantId,
    status: "killed",
    recordedAt: RECORDED_AT,
    witnessTestFile,
    witnessClosureSha256,
    mac: computeMutationEntryMac(TEST_HMAC_SECRET, {
      key,
      file,
      mutantId,
      status: "killed",
      recordedAt: RECORDED_AT,
      witnessTestFile,
      witnessClosureSha256,
    }),
  }
}

describe("SPEC-0035 Area 2: Symbol-Aware Barrel Witness Closure & Progress Streaming", () => {
  it("REQ-2.1/2.2: isBarrelFilePath and isPureReExportBarrel classify pure vs non-pure barrels accurately", () => {
    expect(isBarrelFilePath("libs/sample/domain/src/index.ts")).toBe(true)
    expect(isBarrelFilePath("src/index.mts")).toBe(true)
    expect(isBarrelFilePath("libs/sample/domain/src/sub/index.ts")).toBe(false)
    expect(isBarrelFilePath("libs/sample/domain/src/used.ts")).toBe(false)
    expect(isBarrelFilePath("libs/sample/domain/test/index.ts")).toBe(false)

    expect(
      isPureReExportBarrel(
        "libs/sample/domain/src/index.ts",
        [
          'import type { Id } from "./types.js"',
          'import { localHelper } from "./helper.js"',
          "export interface PublicShape { readonly id: Id }",
          "export type PublicAlias = string",
          'export type { Id } from "./types.js"',
          'export { usedFn } from "./used.js"',
          'export * from "./wild.js"',
          "export { localHelper }",
        ].join("\n"),
      ),
    ).toBe(true)

    expect(
      isPureReExportBarrel("src/index.ts", 'export const x = 1\nexport { a } from "./a.js"\n'),
    ).toBe(false)
    expect(
      isPureReExportBarrel("src/index.ts", 'import "./polyfill.js"\nexport { a } from "./a.js"\n'),
    ).toBe(false)
    expect(isPureReExportBarrel("src/index.ts", "export function f() { return 1 }\n")).toBe(false)
    expect(isPureReExportBarrel("src/index.ts", "export default { ok: true }\n")).toBe(false)
    expect(
      isPureReExportBarrel(
        "src/index.ts",
        'import {} from "./side-effect.js"\nexport { usedFn } from "./used.js"\n',
      ),
    ).toBe(false)
    expect(
      isPureReExportBarrel(
        "src/index.ts",
        'import { unusedInit } from "./side-effect.js"\nexport { usedFn } from "./used.js"\n',
      ),
    ).toBe(false)
    expect(
      isPureReExportBarrel(
        "src/index.ts",
        'import { unusedInit } from "./side-effect.js"\nexport type { unusedInit }\nexport { usedFn } from "./used.js"\n',
      ),
    ).toBe(false)
    expect(
      isPureReExportBarrel(
        "src/index.ts",
        'import def from "./side-effect.js"\nexport { def }\nexport { usedFn } from "./used.js"\n',
      ),
    ).toBe(false)
    expect(
      isPureReExportBarrel(
        "src/index.ts",
        'import * as ns from "./side-effect.js"\nexport { ns }\nexport { usedFn } from "./used.js"\n',
      ),
    ).toBe(false)
    expect(
      isPureReExportBarrel(
        "src/index.ts",
        'import { type Id } from "./types.js"\nexport { usedFn } from "./used.js"\n',
      ),
    ).toBe(false)
  })

  it.effect(
    "REQ-2.1/2.2: unrelated sibling module and sibling barrel export edits preserve witnessClosureSha256 and cache hit",
    () =>
      Effect.gen(function* () {
        const repoRoot = setupBarrelRepo()
        try {
          const targetRel = "libs/sample/domain/src/used.ts"
          const witnessRel = "libs/sample/domain/test/used.test.ts"
          const before = getOkClosure(repoRoot, targetRel, witnessRel)
          expect(before.resolvedFiles).toContain(targetRel)
          expect(before.resolvedFiles).toContain(witnessRel)
          expect(before.resolvedFiles).not.toContain("libs/sample/domain/src/unused.ts")
          expect(before.resolvedFiles).not.toContain("libs/sample/domain/src/index.ts")

          const candidateKey = computeContentSha256("mutant-key-1")
          const store: MutationCacheStore = {
            version: MUTATION_CACHE_SCHEMA_VERSION,
            entries: {
              [candidateKey]: makeWitnessEntry(
                candidateKey,
                targetRel,
                witnessRel,
                before.closureDigest,
              ),
            },
          }

          // Edit unrelated sibling module AND add/edit unrelated barrel exports
          writeFileMkdir(
            join(repoRoot, "libs", "sample", "domain", "src", "unused.ts"),
            "export const unusedFn = (n: number): number => n * 999\n",
          )
          writeFileMkdir(
            join(repoRoot, "libs", "sample", "domain", "src", "other.ts"),
            "export const otherFn = (): number => 7\n",
          )
          writeFileMkdir(
            join(repoRoot, "libs", "sample", "domain", "src", "index.ts"),
            [
              'export { usedFn } from "./used.js"',
              'export { unusedFn } from "./unused.js"',
              'export { otherFn } from "./other.js"',
              "",
            ].join("\n"),
          )

          const afterSibling = getOkClosure(repoRoot, targetRel, witnessRel)
          expect(afterSibling.closureDigest).toBe(before.closureDigest)

          const witnessPath = AstSourceFilePath.make(witnessRel)
          const decision = yield* MutationCache.decide({
            candidateKeys: [candidateKey],
            store,
            auth: TEST_CACHE_AUTH,
            nowMs: BASE_NOW_MS,
            reachingTests: [witnessPath],
            witnessClosureDigests: { [witnessPath]: afterSibling.closureDigest },
          })
          expect(decision.hitKeys).toEqual([candidateKey])
          expect(decision.missKeys).toEqual([])
        } finally {
          rmSync(repoRoot, { recursive: true, force: true })
        }
      }),
  )

  it("REQ-2.1/2.2: rewiring imported barrel symbol or editing target invalidates closureDigest", () => {
    const repoRoot = setupBarrelRepo()
    try {
      const targetRel = "libs/sample/domain/src/used.ts"
      const witnessRel = "libs/sample/domain/test/used.test.ts"
      const base = getOkClosure(repoRoot, targetRel, witnessRel)

      // Rewire usedFn in src/index.ts to ./used-v2.js
      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "src", "index.ts"),
        [
          'export { usedFn } from "./used-v2.js"',
          'export { unusedFn } from "./unused.js"',
          "",
        ].join("\n"),
      )
      const rewired = getOkClosure(repoRoot, targetRel, witnessRel)
      expect(rewired.closureDigest).not.toBe(base.closureDigest)
      expect(rewired.resolvedFiles).toContain("libs/sample/domain/src/used-v2.ts")

      // Restore index.ts and edit used.ts directly
      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "src", "index.ts"),
        ['export { usedFn } from "./used.js"', 'export { unusedFn } from "./unused.js"', ""].join(
          "\n",
        ),
      )
      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "src", "used.ts"),
        "export const usedFn = (n: number): number => n + 100\n",
      )
      const editedUsed = getOkClosure(repoRoot, targetRel, witnessRel)
      expect(editedUsed.closureDigest).not.toBe(base.closureDigest)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-2.2: non-pure barrel hashes barrel bytes, includes src/index.ts in resolvedFiles, and invalidates on barrel edit", () => {
    const repoRoot = setupBarrelRepo()
    try {
      const targetRel = "libs/sample/domain/src/used.ts"
      const witnessRel = "libs/sample/domain/test/used.test.ts"
      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "src", "index.ts"),
        [
          'export { usedFn } from "./used.js"',
          'export { unusedFn } from "./unused.js"',
          "export const runtimeFlag = 1",
          "",
        ].join("\n"),
      )
      const before = getOkClosure(repoRoot, targetRel, witnessRel)
      expect(before.resolvedFiles).toContain("libs/sample/domain/src/index.ts")
      expect(before.resolvedFiles).toContain("libs/sample/domain/src/unused.ts")

      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "src", "index.ts"),
        [
          'export { usedFn } from "./used.js"',
          'export { unusedFn } from "./unused.js"',
          "export const runtimeFlag = 2",
          "",
        ].join("\n"),
      )
      const after = getOkClosure(repoRoot, targetRel, witnessRel)
      expect(after.closureDigest).not.toBe(before.closureDigest)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-2.1: resolveBarrelClosureStep fails closed to FullBarrel on namespace, default, side-effect, dynamic, unmapped, and wildcard symbols", () => {
    const barrelRel = "libs/sample/domain/src/index.ts"
    const importerRel = "libs/sample/domain/test/used.test.ts"
    const resolveImport = (fromRel: string, spec: string): string | undefined => {
      if (fromRel === importerRel && spec === "../src/index.js") return barrelRel
      if (fromRel === barrelRel && spec === "./used.js") return "libs/sample/domain/src/used.ts"
      if (fromRel === barrelRel && spec === "./wild.js") return "libs/sample/domain/src/wild.ts"
      return undefined
    }
    const pureBarrel = 'export { usedFn } from "./used.js"\nexport * from "./wild.js"\n'

    const pruned = resolveBarrelClosureStep({
      importerRel,
      importerContent: 'import { usedFn } from "../src/index.js"\n',
      barrelRel,
      barrelContent: pureBarrel,
      resolveImport,
    })
    expect(pruned._tag).toBe("Pruned")

    const failCases: ReadonlyArray<string> = [
      'import * as pkg from "../src/index.js"\n',
      'import pkg from "../src/index.js"\n',
      'import "../src/index.js"\n',
      'export const load = () => import("../src/index.js")\n',
      "export const loadTpl = () => import(`../src/index.js`)\n",
      'export const req = () => require("../src/index.js")\n',
      "export const reqTpl = () => require(`../src/index.js`)\n",
      'import { usedFn } from "../src/index.js"\nexport const tplWithNamed = async () => { void usedFn; return await import(`../src/index.js`) }\n',
      'import { usedFn } from "../src/index.js"\nexport const actualWithNamed = async () => { void usedFn; return await vi.importActual("../src/index.js") }\n',
      'import { usedFn } from "../src/index.js"\nexport const mockWithNamed = async () => { void usedFn; return await vi.importMock(`../src/index.js`) }\n',
      'import { usedFn } from "../src/index.js"\nimport pkg = require("../src/index.js")\nexport const eqWithNamed = [usedFn, pkg]\n',
      'import { unmappedSym } from "../src/index.js"\n',
      'import { fromWild } from "../src/index.js"\n',
      'import type { OnlyType } from "../src/index.js"\n',
    ]
    for (const importerContent of failCases) {
      expect(
        resolveBarrelClosureStep({
          importerRel,
          importerContent,
          barrelRel,
          barrelContent: pureBarrel,
          resolveImport,
        })._tag,
      ).toBe("FullBarrel")
    }
  })

  it("REQ-2.1: symlinked barrel fails closed even when imported via named symbol and cross-package @sample/domain prunes siblings", () => {
    const repoRoot = setupBarrelRepo()
    try {
      const targetRel = "libs/sample/domain/src/used.ts"
      const witnessRel = "libs/sample/domain/test/pkg-import.test.ts"
      writeFileMkdir(
        join(repoRoot, witnessRel),
        'import { usedFn } from "@sample/domain"\nexport const res = usedFn(1)\n',
      )
      const pkgClosureBefore = getOkClosure(repoRoot, targetRel, witnessRel)
      expect(pkgClosureBefore.resolvedFiles).not.toContain("libs/sample/domain/src/unused.ts")
      expect(pkgClosureBefore.resolvedFiles).not.toContain("libs/sample/domain/src/index.ts")

      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "src", "unused.ts"),
        "export const unusedFn = (n: number): number => n * 42\n",
      )
      const pkgClosureAfter = getOkClosure(repoRoot, targetRel, witnessRel)
      expect(pkgClosureAfter.closureDigest).toBe(pkgClosureBefore.closureDigest)

      const barrelPath = join(repoRoot, "libs", "sample", "domain", "src", "index.ts")
      const digests = unwrapOpt(computeMutationContextDigests(repoRoot, isolatedTestHostIo))
      const symlinkIo: SyncHostIo = {
        ...isolatedTestHostIo,
        isSymbolicLinkSync: (p) =>
          p === barrelPath ? true : isolatedTestHostIo.isSymbolicLinkSync(p),
      }
      const res = computeFileMutationClosureDigest({
        repoRoot,
        relFile: targetRel,
        allReachingTests: [witnessRel],
        digests,
        hostIo: symlinkIo,
      })
      expect(res._tag).toBe("Disabled")
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-2.3: runPackageMutantBatchChecked emits throttled stderr progress lines on multi-file batches and stays silent on single-file batches", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "batch-progress-"))
    const origWrite = process.stderr.write.bind(process.stderr)
    const stderrChunks: Array<string> = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      writeFileMkdir(join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "// vitest\n")
      writeFileMkdir(join(repoRoot, "tools", "package-vitest-batch.mjs"), "// runner\n")

      const makeFileInput = (idx: number): PackageBatchFileInput => {
        const relFile = `libs/demo/domain/src/f${idx}.ts`
        const src = `export const f${idx} = (n: number): number => n + ${idx}\n`
        writeFileMkdir(join(repoRoot, relFile), src)
        const testFile = `libs/demo/domain/test/f${idx}.test.ts`
        writeFileMkdir(join(repoRoot, testFile), `export const t${idx} = 1\n`)
        const mutants = discoverDomainMutants(relFile, src)
        const mod = compileMutantSchemaModule(relFile, src, mutants)
        return {
          file: {
            scope: "demo",
            pkgDir: join(repoRoot, "libs", "demo", "domain"),
            pkgName: "demo/domain",
            tier: "domain",
            fullPath: join(repoRoot, relFile),
            relFile,
          },
          originalContent: src,
          schemaSource: mod.schemaSource,
          mutants,
          uncachedMutants: mutants,
          primaryTests: [join(repoRoot, testFile)],
          fallbackTests: [],
          scopedFallbackTests: [],
          packageFallbackTests: [],
          cachedHitIds: new Set<string>(),
        }
      }

      const files = [1, 2, 3, 4, 5, 6].map(makeFileInput)
      const mockIo: SyncHostIo = {
        ...isolatedTestHostIo,
        execFileSync: (_cmd, args, opts): SyncHostExecResult => {
          if (args.some((a) => a.endsWith("package-vitest-batch.mjs"))) {
            const planRaw = isolatedTestHostIo.readTextSync(
              opts!.env!["HARNESS_PACKAGE_PLAN_FILE"]!,
            )
            const parsed = JSON.parse(planRaw) as {
              readonly files: ReadonlyArray<{
                readonly relFile: string
                readonly mutantIds: ReadonlyArray<string>
              }>
            }
            const rows = parsed.files.map((f) => ({
              relFile: f.relFile,
              primaryResults: f.mutantIds.map((id) => ({
                id,
                result: {
                  _tag: "Exited" as const,
                  exitCode: 1,
                  stdout: `FAIL  ${f.relFile.replace("/src/", "/test/").replace(/\.ts$/, ".test.ts")}\nTests  1 failed (1)\n`,
                  stderr: "",
                },
              })),
              scopedFallbackResults: [],
              packageFallbackResults: [],
            }))
            return { _tag: "Exited", exitCode: 0, stdout: JSON.stringify(rows), stderr: "" }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      }

      const singleRes = runPackageMutantBatchChecked({
        repoRoot,
        pkgKey: "demo/domain",
        backupPath: join(repoRoot, ".harness", "mutation-backup.json"),
        hostIo: mockIo,
        baseSubprocessEnv: {},
        allPackageTests: [],
        files: [files[0]!],
      })
      expect(singleRes._tag).toBe("Ok")
      expect(stderrChunks.join("")).toBe("")

      const multiRes = runPackageMutantBatchChecked({
        repoRoot,
        pkgKey: "demo/domain",
        backupPath: join(repoRoot, ".harness", "mutation-backup.json"),
        hostIo: mockIo,
        baseSubprocessEnv: {},
        allPackageTests: [],
        files,
      })
      expect(multiRes._tag).toBe("Ok")
      const progressLines = stderrChunks
        .join("")
        .split("\n")
        .filter((l) => l.includes("[mutation-check] demo/domain progress:"))
      expect(progressLines.length).toBe(3)
      expect(progressLines[0]).toContain("1/6 files")
      expect(progressLines[1]).toContain("5/6 files")
      expect(progressLines[2]).toContain("6/6 files")
    } finally {
      process.stderr.write = origWrite
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-2.2: unexported runtime imports in barrel and vi.importActual/template dynamic imports in test fail closed in closureDigest", () => {
    const repoRoot = setupBarrelRepo()
    try {
      const targetRel = "libs/sample/domain/src/used.ts"
      const witnessRel = "libs/sample/domain/test/used.test.ts"
      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "src", "side-effect.ts"),
        "export const unusedInit = () => 1\n",
      )
      for (const importLine of [
        'import {} from "./side-effect.js"',
        'import { unusedInit } from "./side-effect.js"',
      ]) {
        writeFileMkdir(
          join(repoRoot, "libs", "sample", "domain", "src", "index.ts"),
          [
            importLine,
            'export { usedFn } from "./used.js"',
            'export { unusedFn } from "./unused.js"',
            "",
          ].join("\n"),
        )
        const closure = getOkClosure(repoRoot, targetRel, witnessRel)
        expect(closure.resolvedFiles).toContain("libs/sample/domain/src/index.ts")
        expect(closure.resolvedFiles).toContain("libs/sample/domain/src/side-effect.ts")
        expect(closure.resolvedFiles).toContain("libs/sample/domain/src/unused.ts")
      }

      // Restore pure barrel and verify vi.importActual + template literal dynamic import in witness test fail closed
      writeFileMkdir(
        join(repoRoot, "libs", "sample", "domain", "src", "index.ts"),
        ['export { usedFn } from "./used.js"', 'export { unusedFn } from "./unused.js"', ""].join(
          "\n",
        ),
      )
      for (const extraCall of [
        'await vi.importActual("../src/index.js")',
        "await import(`../src/index.js`)",
      ]) {
        writeFileMkdir(
          join(repoRoot, witnessRel),
          [
            'import { expect, it, vi } from "vitest"',
            'import { usedFn } from "../src/index.js"',
            `it("usedFn", async () => { void usedFn(1); ${extraCall}; expect(true).toBe(true) })`,
            "",
          ].join("\n"),
        )
        const closure = getOkClosure(repoRoot, targetRel, witnessRel)
        expect(closure.resolvedFiles).toContain("libs/sample/domain/src/index.ts")
        expect(closure.resolvedFiles).toContain("libs/sample/domain/src/unused.ts")
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  const unwrapOkBarrelMeta = (res: ReturnType<typeof loadCachedBarrelMeta>): CachedBarrelMeta =>
    match(res)
      .with({ _tag: "Ok" }, ({ meta }) => meta)
      .with({ _tag: "Disabled" }, ({ reason }) => {
        throw new Error(`Expected Ok barrel meta: ${reason}`)
      })
      .exhaustive()

  const captureStderr = (fn: () => void): string => {
    const origWrite = process.stderr.write.bind(process.stderr)
    const chunks: Array<string> = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      fn()
      return chunks.join("")
    } finally {
      process.stderr.write = origWrite
    }
  }

  it("REQ-2.3: maybeEmitPackageBatchProgress clamps elapsed seconds monotonically at 0.0s", () => {
    const output = captureStderr(() => {
      maybeEmitPackageBatchProgress({
        pkgKey: "demo/domain",
        completed: 1,
        totalFiles: 3,
        killedCount: 1,
        survivedCount: 0,
        batchStartedMs: Date.now() + 60_000,
        lastProgressMs: 0,
      })
    })
    expect(output).toContain("(1 killed, 0 survived, 0.0s)")
  })

  it("REQ-2.1: isPureReExportBarrel returns false when exportIndex omits a locally re-exported unmapped import", () => {
    const barrelRel = "libs/sample/domain/src/index.ts"
    const barrelContent = 'import { ext } from "unmapped-ext-pkg"\nexport { ext }\n'
    const exportIndex = extractBarrelExportIndex(barrelRel, barrelContent, () => undefined)
    expect(isPureReExportBarrel(barrelRel, barrelContent, exportIndex)).toBe(false)
  })

  it("REQ-2.1: loadCachedBarrelMeta fast-path reuses cached meta on matching knownFileDigest without re-reading disk and refreshes on digest change", () => {
    const repoRoot = setupBarrelRepo()
    try {
      const barrelRel = "libs/sample/domain/src/index.ts"
      const fullBarrelPath = join(repoRoot, barrelRel)
      const content1 = isolatedTestHostIo.readTextSync(fullBarrelPath)
      const sha1 = computeContentSha256(content1)

      let readCalls = 0
      const countingIo: SyncHostIo = {
        ...isolatedTestHostIo,
        readTextSync: (filePath) => {
          readCalls += 1
          return isolatedTestHostIo.readTextSync(filePath)
        },
      }
      const resolveImport = (_fromRel: string, spec: string): string | undefined =>
        spec === "./used.js"
          ? "libs/sample/domain/src/used.ts"
          : spec === "./unused.js"
            ? "libs/sample/domain/src/unused.ts"
            : spec === "./used-v2.js"
              ? "libs/sample/domain/src/used-v2.ts"
              : undefined
      const barrelMetaCache = new Map<string, CachedBarrelMeta>()

      const res1 = unwrapOkBarrelMeta(
        loadCachedBarrelMeta({
          barrelMetaCache,
          barrelRel,
          fullBarrelPath,
          knownFileDigest: sha1,
          hostIo: countingIo,
          resolveImport,
          getDisabledReason: () => undefined,
        }),
      )
      expect(readCalls).toBe(1)
      expect(res1.fileSha).toBe(sha1)

      const res2 = unwrapOkBarrelMeta(
        loadCachedBarrelMeta({
          barrelMetaCache,
          barrelRel,
          fullBarrelPath,
          knownFileDigest: sha1,
          hostIo: countingIo,
          resolveImport,
          getDisabledReason: () => undefined,
        }),
      )
      expect(res2).toBe(res1)
      expect(readCalls).toBe(1)

      const content2 = 'export { usedFn } from "./used-v2.js"\n'
      const sha2 = computeContentSha256(content2)
      expect(sha2).not.toBe(sha1)
      writeFileMkdir(fullBarrelPath, content2)

      const res3 = unwrapOkBarrelMeta(
        loadCachedBarrelMeta({
          barrelMetaCache,
          barrelRel,
          fullBarrelPath,
          knownFileDigest: sha2,
          hostIo: countingIo,
          resolveImport,
          getDisabledReason: () => undefined,
        }),
      )
      expect(readCalls).toBe(2)
      expect(res3).not.toBe(res1)
      expect(res3.fileSha).toBe(sha2)
      expect(res3.content).toBe(content2)
      expect(res3.content).not.toBe(res1.content)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-2.1: loadCachedBarrelMeta post-read SHA hit skips re-parsing when knownFileDigest is undefined and refreshes when disk changes", () => {
    const repoRoot = setupBarrelRepo()
    try {
      const barrelRel = "libs/sample/domain/src/index.ts"
      const fullBarrelPath = join(repoRoot, barrelRel)
      let resolveCalls = 0
      const resolveImport = (_fromRel: string, spec: string): string | undefined => {
        resolveCalls += 1
        return spec === "./used.js"
          ? "libs/sample/domain/src/used.ts"
          : spec === "./unused.js"
            ? "libs/sample/domain/src/unused.ts"
            : spec === "./used-v2.js"
              ? "libs/sample/domain/src/used-v2.ts"
              : undefined
      }
      const barrelMetaCache = new Map<string, CachedBarrelMeta>()

      const res1 = unwrapOkBarrelMeta(
        loadCachedBarrelMeta({
          barrelMetaCache,
          barrelRel,
          fullBarrelPath,
          knownFileDigest: undefined,
          hostIo: isolatedTestHostIo,
          resolveImport,
          getDisabledReason: () => undefined,
        }),
      )
      expect(resolveCalls).toBeGreaterThan(0)
      const countAfterFirst = resolveCalls

      const res2 = unwrapOkBarrelMeta(
        loadCachedBarrelMeta({
          barrelMetaCache,
          barrelRel,
          fullBarrelPath,
          knownFileDigest: undefined,
          hostIo: isolatedTestHostIo,
          resolveImport,
          getDisabledReason: () => undefined,
        }),
      )
      expect(res2).toBe(res1)
      expect(resolveCalls).toBe(countAfterFirst)

      const updatedContent = 'export { usedFn } from "./used-v2.js"\n'
      writeFileMkdir(fullBarrelPath, updatedContent)
      const res3 = unwrapOkBarrelMeta(
        loadCachedBarrelMeta({
          barrelMetaCache,
          barrelRel,
          fullBarrelPath,
          knownFileDigest: undefined,
          hostIo: isolatedTestHostIo,
          resolveImport,
          getDisabledReason: () => undefined,
        }),
      )
      expect(res3).not.toBe(res2)
      expect(res3.content).toBe(updatedContent)
      expect(resolveCalls).toBeGreaterThan(countAfterFirst)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-2.3: maybeEmitPackageBatchProgress requires totalFiles >= 2 and emits at exact 2-file boundary", () => {
    const singleOutput = captureStderr(() => {
      maybeEmitPackageBatchProgress({
        pkgKey: "demo/domain",
        completed: 1,
        totalFiles: 1,
        killedCount: 1,
        survivedCount: 0,
        batchStartedMs: Date.now() - 1000,
        lastProgressMs: 0,
      })
    })
    expect(singleOutput).toBe("")

    const twoFileOutput = captureStderr(() => {
      maybeEmitPackageBatchProgress({
        pkgKey: "demo/domain",
        completed: 1,
        totalFiles: 2,
        killedCount: 1,
        survivedCount: 0,
        batchStartedMs: Date.now() - 1000,
        lastProgressMs: 0,
      })
    })
    expect(twoFileOutput).toContain("1/2 files")
  })

  it("REQ-2.3: maybeEmitPackageBatchProgress emits at exact 15_000ms elapsed boundary and stays silent at 14_999ms", () => {
    const origDateNow = Date.now
    Date.now = () => 20_000
    try {
      let returnedBefore = 0
      const silentOutput = captureStderr(() => {
        returnedBefore = maybeEmitPackageBatchProgress({
          pkgKey: "demo/domain",
          completed: 2,
          totalFiles: 7,
          killedCount: 1,
          survivedCount: 1,
          batchStartedMs: 1_000,
          lastProgressMs: 5_001,
        })
      })
      expect(returnedBefore).toBe(5_001)
      expect(silentOutput).toBe("")

      let returnedAtBoundary = 0
      const boundaryOutput = captureStderr(() => {
        returnedAtBoundary = maybeEmitPackageBatchProgress({
          pkgKey: "demo/domain",
          completed: 2,
          totalFiles: 7,
          killedCount: 1,
          survivedCount: 1,
          batchStartedMs: 1_000,
          lastProgressMs: 5_000,
        })
      })
      expect(returnedAtBoundary).toBe(20_000)
      expect(boundaryOutput).toContain("2/7 files")
    } finally {
      Date.now = origDateNow
    }
  })
})
