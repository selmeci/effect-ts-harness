import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { AstSourceContent, AstSourceFilePath } from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { SelfDogfooding, writeVerifyStamp } from "../src/index.js"
import { runDomainMutationSuite } from "../src/mutation-check.js"
import {
  compileMutantSchemaModule,
  discoverDomainMutants,
  evaluateMutantSchemaInProcess,
  setActiveMutantId,
  verifyMutantSchemaSyntax,
} from "../src/mutation/mutant-ast-generator.js"
import { extractGitDiffModifiedLinesChecked } from "../src/mutation/mutation-backup.js"
import {
  findDomainFiles,
  findUnclassifiedModifiedLibFiles,
  partitionReachingTestFiles,
  resolveLibPackageClassification,
} from "../src/mutation/mutation-target-discovery.js"
import { testHostIo } from "./helpers/test-host-io.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../../..")

const writePkg = (
  repoRoot: string,
  scope: string,
  pkgDir: string,
  manifest: {
    readonly type: "package.json" | "project.json"
    readonly name?: string
    readonly tags?: ReadonlyArray<string>
  } | null,
): string => {
  const pkgPath = join(repoRoot, "libs", scope, pkgDir)
  mkdirSync(join(pkgPath, "src"), { recursive: true })
  if (manifest !== null) {
    if (manifest.type === "package.json") {
      writeFileSync(
        join(pkgPath, "package.json"),
        JSON.stringify({
          ...(manifest.name !== undefined ? { name: manifest.name } : {}),
          ...(manifest.tags !== undefined ? { nx: { tags: manifest.tags } } : {}),
        }),
        "utf8",
      )
    } else {
      writeFileSync(
        join(pkgPath, "project.json"),
        JSON.stringify({
          ...(manifest.name !== undefined ? { name: manifest.name } : {}),
          ...(manifest.tags !== undefined ? { tags: manifest.tags } : {}),
        }),
        "utf8",
      )
    }
  }
  return pkgPath
}

describe("mutant-ast-generator: expression wrapping, multi-mutant same line, AST filter & line preservation", () => {
  it.effect(
    "discovers and compiles non-if binary, arithmetic, method call preserving this, and property initializer mutants",
    () =>
      Effect.gen(function* () {
        const source = [
          "export const eq = (a: number, b: number) => a === b",
          "export const bump = (m: Map<string, number>, k: string) => (m.get(k) ?? 0) + 1",
          "export const sum = (events: ReadonlyArray<number>) => events.reduce((a, b) => a + b, 0)",
          "export const makeSummary = (s: { readonly itemCount: number }) => ({ totalItems: s.itemCount })",
        ].join("\n")

        const mutants = discoverDomainMutants("libs/demo/domain/src/ops.ts", source)
        expect(mutants.some((m) => m.original === "===" && m.replacement === "!==")).toBe(true)
        expect(mutants.some((m) => m.original === "+ 1" && m.replacement === "- 1")).toBe(true)
        expect(
          mutants.some(
            (m) =>
              m.original === "events.reduce(" && m.replacement === "events.slice(0, 1).reduce(",
          ),
        ).toBe(true)
        expect(
          mutants.some(
            (m) => m.original === "totalItems: s.itemCount" && m.replacement === "totalItems: 0",
          ),
        ).toBe(true)

        const bundle = compileMutantSchemaModule("libs/demo/domain/src/ops.ts", source, mutants)
        expect(bundle.mutantIds.length).toBe(mutants.length)
        expect(bundle.schemaSource).toContain("events.slice(0, 1).reduce(")
        expect(
          verifyMutantSchemaSyntax("libs/demo/domain/src/ops.ts", bundle.schemaSource),
        ).toEqual([])
        expect(bundle.schemaSource.split("\n").length).toBe(source.split("\n").length)

        const dogfood = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/demo/domain/src/ops.ts"),
              content: AstSourceContent.make(bundle.schemaSource),
            },
          ],
        })
        expect(dogfood.verdict).toBe("clean")
        expect(dogfood.violations).toEqual([])
      }),
  )

  it.effect(
    "assigns distinct @2 IDs, coalesces multi-mutant same line into a single ternary, and executes accurately",
    () =>
      Effect.gen(function* () {
        const source = [
          "export const isControl = (code: number): boolean => {",
          "  if (code <= 0x1f || code === 0x7f) return true",
          "  return false",
          "}",
          "export const bothDefined = (a: number | undefined, b: number | undefined): boolean => {",
          "  if (a !== undefined && b !== undefined) return true",
          "  return false",
          "}",
        ].join("\n")

        const mutants = discoverDomainMutants("libs/demo/domain/src/multi.ts", source)
        const line6Ids = mutants
          .filter((m) => m.line === 6 && m.original === "!==")
          .map((m) => m.id)
        expect(line6Ids).toEqual([
          "libs/demo/domain/src/multi.ts:6:!==->===",
          "libs/demo/domain/src/multi.ts:6@2:!==->===",
        ])

        const bundle = compileMutantSchemaModule("libs/demo/domain/src/multi.ts", source, mutants)
        expect(bundle.mutantIds.length).toBe(mutants.length)
        expect(
          verifyMutantSchemaSyntax("libs/demo/domain/src/multi.ts", bundle.schemaSource),
        ).toEqual([])

        const dogfood = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/demo/domain/src/multi.ts"),
              content: AstSourceContent.make(bundle.schemaSource),
            },
          ],
        })
        expect(dogfood.verdict).toBe("clean")
        expect(dogfood.violations).toEqual([])

        // Transpile to ESM in a temp dir and import to verify coalesced ternary runtime behavior
        const transpiled = ts.transpileModule(bundle.schemaSource, {
          fileName: "multi.ts",
          compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
        }).outputText

        const dir = mkdtempSync(join(tmpdir(), "mut-ast-exec-"))
        try {
          const modPath = join(dir, "multi.mjs")
          writeFileSync(modPath, transpiled, "utf8")
          const mod = (yield* Effect.promise(() => import(pathToFileURL(modPath).href))) as {
            readonly isControl: (code: number) => boolean
            readonly bothDefined: (a: number | undefined, b: number | undefined) => boolean
          }

          const outcomes = evaluateMutantSchemaInProcess(mutants, [
            () => {
              expect(mod.isControl(0x1f)).toBe(true)
              expect(mod.isControl(0x7f)).toBe(true)
              expect(mod.isControl(0x20)).toBe(false)
              expect(mod.bothDefined(1, 2)).toBe(true)
              expect(mod.bothDefined(undefined, 2)).toBe(false)
              expect(mod.bothDefined(1, undefined)).toBe(false)
            },
          ])
          expect(outcomes.every((o) => o.status === "killed")).toBe(true)
          setActiveMutantId(undefined)
        } finally {
          setActiveMutantId(undefined)
          rmSync(dir, { recursive: true, force: true })
        }
      }),
  )

  it("AST validity filter skips TypeNode, type aliases, interfaces, imports, regex literals, and string literals, and deduplicates overlapping patterns", () => {
    const source = [
      'import {a} from "./a.js"',
      "type Union = 1 | 2",
      "type EqCheck<A, B> = A extends B ? true : false",
      "interface Foo { readonly ok: boolean }",
      'export const str = "a === b && 1 + 1"',
      "export const re = /a === b/",
      "export const typed = (x: number): number => x",
      "export const incItem = (item: { readonly count: number }): number => item.count + 1",
    ].join("\n")

    const mutants = discoverDomainMutants("libs/demo/domain/src/filter.ts", source)
    expect(mutants.every((m) => m.line === 8)).toBe(true)
    expect(mutants.filter((m) => m.line === 8)).toHaveLength(1)
    expect(mutants[0]?.original).toBe("+ 1")
    expect(mutants[0]?.replacement).toBe("- 1")
  })

  it.effect.prop(
    "preserves exact line count across top-level imports, no imports, and #! shebangs",
    {
      prefixKind: Schema.Literals(["imports", "none", "shebang"]),
      opKind: Schema.Literals(["===", "!==", ">=", "<="]),
    },
    ({ prefixKind, opKind }) =>
      Effect.sync(() => {
        const header = match(prefixKind)
          .with("imports", () => 'import {Schema} from "effect"\n\n')
          .with("none", () => "")
          .with("shebang", () => "#!/usr/bin/env node\n")
          .exhaustive()
        const source = `${header}export const cmp = (a: number, b: number): boolean => a ${opKind} b\n`
        const mutants = discoverDomainMutants("libs/demo/domain/src/prop.ts", source)
        expect(mutants.length).toBeGreaterThanOrEqual(1)
        const bundle = compileMutantSchemaModule("libs/demo/domain/src/prop.ts", source, mutants)
        expect(bundle.schemaSource.split("\n").length).toBe(source.split("\n").length)
        expect(
          verifyMutantSchemaSyntax("libs/demo/domain/src/prop.ts", bundle.schemaSource),
        ).toEqual([])
      }),
  )
})

describe("mutation-target-discovery: tag classification, scope/target filtering, reaching test partitioning, and live workspace dogfooding", () => {
  it("classifies type:core in non-core folders, type:domain, type:contract, excludes service/infra/app, and handles manifest-less fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-disc-tags-"))
    try {
      const gatesPkg = writePkg(dir, "harness", "gates", {
        type: "package.json",
        name: "@harness/gates",
        tags: ["type:core"],
      })
      writeFileSync(
        join(gatesPkg, "src", "gate.ts"),
        "export const g = (x: number) => x >= 1\n",
        "utf8",
      )

      const graphPkg = writePkg(dir, "harness", "graph", {
        type: "package.json",
        name: "@harness/graph",
        tags: ["type:core"],
      })
      writeFileSync(
        join(graphPkg, "src", "gr.ts"),
        "export const gr = (x: number) => x >= 1\n",
        "utf8",
      )

      const decPkg = writePkg(dir, "harness", "decision", {
        type: "package.json",
        name: "@harness/decision",
        tags: ["type:core"],
      })
      writeFileSync(
        join(decPkg, "src", "dec.ts"),
        "export const d = (x: number) => x >= 1\n",
        "utf8",
      )

      const ingPkg = writePkg(dir, "harness", "ingest", {
        type: "package.json",
        name: "@harness/ingest",
        tags: ["type:core"],
      })
      writeFileSync(
        join(ingPkg, "src", "ing.ts"),
        "export const i = (x: number) => x >= 1\n",
        "utf8",
      )

      const domPkg = writePkg(dir, "demo", "billing", {
        type: "project.json",
        name: "demo-billing",
        tags: ["type:domain"],
      })
      writeFileSync(
        join(domPkg, "src", "bill.ts"),
        "export const b = (x: number) => x >= 1\n",
        "utf8",
      )

      const conPkg = writePkg(dir, "demo", "proto", {
        type: "package.json",
        name: "@demo/proto",
        tags: ["type:contract"],
      })
      writeFileSync(
        join(conPkg, "src", "helper.ts"),
        "export const isOk = (x: number) => x === 1\n",
        "utf8",
      )

      const svcPkg = writePkg(dir, "demo", "svc", {
        type: "package.json",
        name: "@demo/svc",
        tags: ["type:service"],
      })
      writeFileSync(join(svcPkg, "src", "svc.ts"), "export const s = 1\n", "utf8")

      const infPkg = writePkg(dir, "demo", "inf", {
        type: "package.json",
        name: "@demo/inf",
        tags: ["type:infra"],
      })
      writeFileSync(join(infPkg, "src", "inf.ts"), "export const i = 1\n", "utf8")

      const appPkg = writePkg(dir, "demo", "app", {
        type: "package.json",
        name: "@demo/app",
        tags: ["type:app"],
      })
      writeFileSync(join(appPkg, "src", "app.ts"), "export const a = 1\n", "utf8")

      // No manifests: domain/core/contract fallback vs unknown folder
      const noManDom = writePkg(dir, "nom", "domain", null)
      writeFileSync(join(noManDom, "src", "nd.ts"), "export const nd = 1\n", "utf8")
      const noManCore = writePkg(dir, "nom", "core", null)
      writeFileSync(join(noManCore, "src", "nc.ts"), "export const nc = 1\n", "utf8")
      const noManContract = writePkg(dir, "nom", "contract", null)
      writeFileSync(join(noManContract, "src", "ncon.ts"), "export const ncon = 1\n", "utf8")
      const noManUnknown = writePkg(dir, "nom", "mystery", null)
      writeFileSync(join(noManUnknown, "src", "unk.ts"), "export const unk = 1\n", "utf8")

      expect(resolveLibPackageClassification(noManUnknown, "mystery", testHostIo)).toBe(
        "unclassified",
      )

      const all = findDomainFiles(dir, testHostIo)
      const rels = all.map((f) => f.relFile)
      expect(rels).toContain("libs/harness/gates/src/gate.ts")
      expect(rels).toContain("libs/harness/graph/src/gr.ts")
      expect(rels).toContain("libs/harness/decision/src/dec.ts")
      expect(rels).toContain("libs/harness/ingest/src/ing.ts")
      expect(rels).toContain("libs/demo/billing/src/bill.ts")
      expect(rels).toContain("libs/demo/proto/src/helper.ts")
      expect(rels).toContain("libs/nom/domain/src/nd.ts")
      expect(rels).toContain("libs/nom/core/src/nc.ts")
      expect(rels).toContain("libs/nom/contract/src/ncon.ts")
      expect(rels).not.toContain("libs/demo/svc/src/svc.ts")
      expect(rels).not.toContain("libs/demo/inf/src/inf.ts")
      expect(rels).not.toContain("libs/demo/app/src/app.ts")
      expect(rels).not.toContain("libs/nom/mystery/src/unk.ts")

      // Scope filters
      expect(findDomainFiles(dir, testHostIo, "harness").map((f) => f.pkgDir)).toEqual([
        "decision",
        "gates",
        "graph",
        "ingest",
      ])
      expect(findDomainFiles(dir, testHostIo, "@harness/gates").map((f) => f.relFile)).toEqual([
        "libs/harness/gates/src/gate.ts",
      ])
      expect(findDomainFiles(dir, testHostIo, "harness/gates").map((f) => f.relFile)).toEqual([
        "libs/harness/gates/src/gate.ts",
      ])
      expect(findDomainFiles(dir, testHostIo, "gates").map((f) => f.relFile)).toEqual([
        "libs/harness/gates/src/gate.ts",
      ])
      expect(findDomainFiles(dir, testHostIo, "harness-gates").map((f) => f.pkgDir)).toEqual([
        "decision",
        "gates",
        "graph",
        "ingest",
      ])
      expect(findDomainFiles(dir, testHostIo, "nonexistent")).toEqual([])

      // targetFiles filtering with backslash and leading ./
      const targeted = findDomainFiles(dir, testHostIo, undefined, [
        "./libs\\harness\\gates\\src\\gate.ts",
      ])
      expect(targeted.map((f) => f.relFile)).toEqual(["libs/harness/gates/src/gate.ts"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("findUnclassifiedModifiedLibFiles detects unclassified .ts while ignoring excluded tiers and .d.ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-disc-unclass-"))
    try {
      const mysteryPkg = writePkg(dir, "demo", "mystery", {
        type: "package.json",
        name: "@demo/mystery",
        tags: [],
      })
      writeFileSync(join(mysteryPkg, "src", "x.ts"), "export const x = 1\n", "utf8")
      writeFileSync(
        join(mysteryPkg, "src", "types.d.ts"),
        "export declare const t: number\n",
        "utf8",
      )

      const svcPkg = writePkg(dir, "demo", "svc", {
        type: "package.json",
        name: "@demo/svc",
        tags: ["type:service"],
      })
      writeFileSync(join(svcPkg, "src", "s.ts"), "export const s = 1\n", "utf8")

      const discovered = findDomainFiles(dir, testHostIo)
      const diffMap = new Map<string, ReadonlySet<number>>([
        ["libs/demo/mystery/src/x.ts", new Set([1])],
        ["libs/demo/mystery/src/types.d.ts", new Set([1])],
        ["libs/demo/svc/src/s.ts", new Set([1])],
      ])
      const unclassified = findUnclassifiedModifiedLibFiles(dir, diffMap, discovered, testHostIo)
      expect(unclassified).toEqual(["libs/demo/mystery/src/x.ts"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("partitionReachingTestFiles handles <=2 tests, >=3 tests with stem/symbol matching, self-dogfooding-plugin exclusion, and 0-match fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-disc-part-"))
    try {
      const pkg = writePkg(dir, "demo", "core", {
        type: "package.json",
        name: "@demo/core",
        tags: ["type:core"],
      })
      const testDir = join(pkg, "test")
      mkdirSync(testDir, { recursive: true })
      const alphaPath = join(pkg, "src", "alpha.ts")
      const alphaSource = "export const computeAlpha = (x: number) => x + 1\n"
      writeFileSync(alphaPath, alphaSource, "utf8")
      const selfDogPath = join(pkg, "src", "self-dogfooding-plugin.ts")
      const selfDogSource = "export const runSelfDogfood = () => true\n"
      writeFileSync(selfDogPath, selfDogSource, "utf8")

      const t1 = join(testDir, "alpha.test.ts")
      const t2 = join(testDir, "other.test.ts")
      writeFileSync(t1, "import {computeAlpha} from '../src/alpha.js'\n", "utf8")
      writeFileSync(t2, "export const z = 1\n", "utf8")

      const domainAlpha = {
        scope: "demo",
        pkgDir: "core",
        pkgName: "@demo/core",
        tier: "core" as const,
        fullPath: alphaPath,
        relFile: "libs/demo/core/src/alpha.ts",
      }
      // <= 2 tests: all returned as primary
      const p2 = partitionReachingTestFiles(dir, domainAlpha, alphaSource, testHostIo)
      expect(p2.primaryTests).toHaveLength(2)
      expect(p2.fallbackTests).toEqual([])

      // Add a 3rd and 4th test (including self-dogfooding-plugin-harness.test.ts referencing computeAlpha)
      const t3 = join(testDir, "unrelated.test.ts")
      const t4 = join(testDir, "self-dogfooding-plugin-harness.test.ts")
      writeFileSync(t3, "export const u = 1\n", "utf8")
      writeFileSync(t4, "computeAlpha(1)\n", "utf8")

      const p4 = partitionReachingTestFiles(dir, domainAlpha, alphaSource, testHostIo)
      expect(p4.primaryTests).toEqual([t1])
      expect(p4.fallbackTests).toContain(t2)
      expect(p4.fallbackTests).toContain(t3)
      expect(p4.fallbackTests).not.toContain(t4)

      // When file IS self-dogfooding-plugin.ts, t4 is eligible for primary
      const domainSelfDog = {
        scope: "demo",
        pkgDir: "core",
        pkgName: "@demo/core",
        tier: "core" as const,
        fullPath: selfDogPath,
        relFile: "libs/demo/core/src/self-dogfooding-plugin.ts",
      }
      writeFileSync(t4, "runSelfDogfood()\n", "utf8")
      const pSelf = partitionReachingTestFiles(dir, domainSelfDog, selfDogSource, testHostIo)
      expect(pSelf.primaryTests).toContain(t4)

      // 0 matching tests falls back to eligibleTests (excluding self-dogfooding-plugin-harness.test.ts) as primary
      const nomatchPath = join(pkg, "src", "nomatch.ts")
      const nomatchSource = "export const uniqueUnreferencedSymbol = 1\n"
      writeFileSync(nomatchPath, nomatchSource, "utf8")
      const pZero = partitionReachingTestFiles(
        dir,
        { ...domainAlpha, fullPath: nomatchPath, relFile: "libs/demo/core/src/nomatch.ts" },
        nomatchSource,
        testHostIo,
      )
      expect(pZero.primaryTests).toHaveLength(3)
      expect(pZero.primaryTests).not.toContain(t4)
      expect(pZero.fallbackTests).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("live dogfooding: findDomainFiles discovers @harness/gates plan-workflow-compiler.ts and @harness/contract repo-identity.ts & workflow.ts", () => {
    const gatesFiles = findDomainFiles(REAL_REPO_ROOT, testHostIo, "@harness/gates").map(
      (f) => f.relFile,
    )
    expect(gatesFiles).toContain("libs/harness/gates/src/plan-workflow-compiler.ts")

    const contractFiles = findDomainFiles(REAL_REPO_ROOT, testHostIo, "@harness/contract").map(
      (f) => f.relFile,
    )
    expect(contractFiles).toContain("libs/harness/contract/src/repo-identity.ts")
    expect(contractFiles).toContain("libs/harness/contract/src/workflow.ts")
  })
})

describe("mutation-backup: untracked files, branch-base fallback, explicitBaseRef, and fail-closed git errors", () => {
  const makeGitMockHostIo = (
    handler: (args: ReadonlyArray<string>) => SyncHostExecResult,
    files: Readonly<Record<string, string>> = {},
  ): SyncHostIo => ({
    ...testHostIo,
    existsSync: (p) => p in files || testHostIo.existsSync(p),
    readTextSync: (p) => (p in files ? files[p]! : testHostIo.readTextSync(p)),
    execFileSync: (_cmd, args) => handler(args),
  })

  it("merges untracked git ls-files --others lines (1..N) into diff map with diffMode working-tree", () => {
    const untrackedRel = "libs/demo/core/src/new-file.ts"
    const untrackedAbs = join("/mock-repo", untrackedRel)
    const hostIo = makeGitMockHostIo(
      (args) => {
        if (args.includes("rev-parse"))
          return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
        if (args.includes("ls-files"))
          return { _tag: "Exited", exitCode: 0, stdout: `${untrackedRel}\n`, stderr: "" }
        return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
      },
      { [untrackedAbs]: "line1\nline2\nline3" },
    )
    const res = extractGitDiffModifiedLinesChecked("/mock-repo", hostIo)
    match(res)
      .with({ _tag: "Ok" }, ({ lines, diffMode }) => {
        expect(diffMode).toBe("working-tree")
        expect(Array.from(lines.get(untrackedRel) ?? [])).toEqual([1, 2, 3])
      })
      .with({ _tag: "NotGit" }, { _tag: "Failed" }, () => {
        expect.unreachable("Expected kind: ok")
      })
      .exhaustive()
  })

  it("falls back to branch-base when working tree has no libs/ diff and fallbackBaseRef is provided", () => {
    const hostIo = makeGitMockHostIo((args) => {
      if (args.includes("rev-parse"))
        return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
      if (args.includes("merge-base"))
        return { _tag: "Exited", exitCode: 0, stdout: "abc123\n", stderr: "" }
      if (args.includes("diff") && args.includes("abc123")) {
        return {
          _tag: "Exited",
          exitCode: 0,
          stdout: "+++ b/libs/demo/core/src/a.ts\n@@ -0,0 +10,2 @@\n+line10\n+line11\n",
          stderr: "",
        }
      }
      return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
    })
    const res = extractGitDiffModifiedLinesChecked("/mock-repo", hostIo, {
      fallbackBaseRef: "main",
    })
    match(res)
      .with({ _tag: "Ok" }, ({ lines, diffMode }) => {
        expect(diffMode).toBe("branch-base")
        expect(Array.from(lines.get("libs/demo/core/src/a.ts") ?? [])).toEqual([10, 11])
      })
      .with({ _tag: "NotGit" }, { _tag: "Failed" }, () => {
        expect.unreachable("Expected branch-base ok")
      })
      .exhaustive()
  })

  it("fails closed when explicitBaseRef=true without fallbackBaseRef or when merge-base / ls-files fails or times out", () => {
    const baseHostIo = makeGitMockHostIo((args) => {
      if (args.includes("rev-parse"))
        return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
      if (args.includes("merge-base"))
        return {
          _tag: "Exited",
          exitCode: 128,
          stdout: "",
          stderr: "fatal: Not a valid object name",
        }
      return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
    })

    const missingBase = extractGitDiffModifiedLinesChecked("/mock-repo", baseHostIo, {
      explicitBaseRef: true,
    })
    expect(missingBase._tag).toBe("Failed")

    const failedMergeBase = extractGitDiffModifiedLinesChecked("/mock-repo", baseHostIo, {
      explicitBaseRef: true,
      fallbackBaseRef: "main",
    })
    expect(failedMergeBase._tag).toBe("Failed")

    const lsFilesExitErr = makeGitMockHostIo((args) => {
      if (args.includes("rev-parse"))
        return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
      if (args.includes("ls-files"))
        return { _tag: "Exited", exitCode: 128, stdout: "", stderr: "ls-files failed" }
      return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
    })
    expect(extractGitDiffModifiedLinesChecked("/mock-repo", lsFilesExitErr)._tag).toBe("Failed")

    const lsFilesTimeout = makeGitMockHostIo((args) => {
      if (args.includes("rev-parse"))
        return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
      if (args.includes("ls-files")) return { _tag: "TimedOut", stdout: "", stderr: "" }
      return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
    })
    expect(extractGitDiffModifiedLinesChecked("/mock-repo", lsFilesTimeout)._tag).toBe("Failed")
  })
})

describe("mutation-check: strict fail-closed modes and primary/fallback test partitioning", () => {
  it("fails closed on strict scope matching 0 files, nonexistent targetFiles, and unclassified modified lib files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-check-fail-"))
    try {
      const mysteryPkg = writePkg(dir, "demo", "mystery", {
        type: "package.json",
        name: "@demo/mystery",
        tags: [],
      })
      writeFileSync(
        join(mysteryPkg, "src", "x.ts"),
        "export const x = (a: number) => a >= 1\n",
        "utf8",
      )

      const noScopeReport = runDomainMutationSuite(dir, testHostIo, {
        enforcementMode: "strict",
        scope: "nonexistent",
      })
      expect(noScopeReport.passed).toBe(false)
      expect(noScopeReport.diagnostic).toContain("nonexistent")

      const missingTargetReport = runDomainMutationSuite(dir, testHostIo, {
        targetFiles: ["libs/demo/missing/src/nope.ts"],
      })
      expect(missingTargetReport.passed).toBe(false)
      expect(missingTargetReport.diagnostic).toContain("not found")

      const gitHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args.includes("rev-parse"))
            return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
          if (args.includes("merge-base"))
            return { _tag: "Exited", exitCode: 0, stdout: "abc123\n", stderr: "" }
          if (args.includes("ls-files"))
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: "libs/demo/mystery/src/x.ts\n",
              stderr: "",
            }
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      }
      const unclassReport = runDomainMutationSuite(dir, gitHostIo, { enforcementMode: "strict" })
      expect(unclassReport.passed).toBe(false)
      expect(unclassReport.diagnostic).toContain("Unclassified modified lib file")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("upgrades primary survivor to killed via fallback tests, and aborts cleanly on fallback infrastructure failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-check-fb-"))
    try {
      const pkg = writePkg(dir, "demo", "core", {
        type: "package.json",
        name: "@demo/core",
        tags: ["type:core"],
      })
      const testDir = join(pkg, "test")
      mkdirSync(testDir, { recursive: true })
      writeFileSync(
        join(pkg, "src", "calc.ts"),
        "export const isPos = (n: number): boolean => n >= 1\n",
        "utf8",
      )
      const primaryTest = join(testDir, "calc.test.ts")
      const fallbackA = join(testDir, "extra-a.test.ts")
      const fallbackB = join(testDir, "extra-b.test.ts")
      writeFileSync(primaryTest, "import {isPos} from '../src/calc.js'\n", "utf8")
      writeFileSync(fallbackA, "export const a = 1\n", "utf8")
      writeFileSync(fallbackB, "export const b = 2\n", "utf8")

      const upgradeHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args, opts) => {
          if (args.includes("rev-parse"))
            return { _tag: "Exited", exitCode: 128, stdout: "", stderr: "not a git repository" }
          const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
          if (activeId === undefined)
            return { _tag: "Exited", exitCode: 0, stdout: "ok", stderr: "" }
          if (args.includes(primaryTest)) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  extra-a.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      const upgraded = runDomainMutationSuite(dir, upgradeHostIo, { includeAllLines: true })
      expect(upgraded.passed).toBe(true)
      expect(upgraded.killedCount).toBe(1)

      const abortFallbackHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args, opts) => {
          if (args.includes("rev-parse"))
            return { _tag: "Exited", exitCode: 128, stdout: "", stderr: "not a git repository" }
          const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
          if (args.includes(primaryTest)) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          if (activeId === undefined) {
            return { _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
        },
      }
      const aborted = runDomainMutationSuite(dir, abortFallbackHostIo, {
        includeAllLines: true,
        disableMutantCache: true,
      })
      expect(aborted.passed).toBe(false)
      expect(aborted.diagnostic).toContain("Baseline test suite failed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("exempts package-root vitest.config.* from findUnclassifiedModifiedLibFiles while still flagging other non-src lib files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-vitest-cfg-"))
    try {
      const pkg = writePkg(dir, "demo", "core", {
        type: "package.json",
        name: "@demo/core",
        tags: ["type:core"],
      })
      writeFileSync(join(pkg, "vitest.config.ts"), "export default {}\n", "utf8")
      writeFileSync(join(pkg, "extra.ts"), "export const extra = 1\n", "utf8")
      const unclassified = findUnclassifiedModifiedLibFiles(
        dir,
        new Map([
          ["libs/demo/core/vitest.config.ts", new Set([1])],
          ["libs/demo/core/extra.ts", new Set([1])],
        ]),
        [],
        testHostIo,
      )
      expect(unclassified).toEqual(["libs/demo/core/extra.ts"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("S-2.c: writeVerifyStamp cleans up temp stamp file on containment escape or renameSync failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "stamp-tmp-cleanup-"))
    try {
      writeFileSync(join(dir, "file.ts"), "export const x = 1\n", "utf8")
      const tmpStampPath = join(dir, ".harness", `verify-stamp.json.tmp-${process.pid}`)

      // 1. Escape containment via realpathSync returning outside path
      const escapedHostIo: SyncHostIo = {
        ...testHostIo,
        realpathSync: (p) =>
          p.includes(".tmp-") ? "/escaped/outside" : testHostIo.realpathSync(p),
      }
      expect(() => writeVerifyStamp(dir, escapedHostIo, "impl/current")).toThrow(/escaped/)
      expect(testHostIo.existsSync(tmpStampPath)).toBe(false)

      // 2. renameSync failure cleans up temp stamp file
      const renameFailHostIo: SyncHostIo = {
        ...testHostIo,
        renameSync: () => {
          throw new Error("EACCES: rename denied")
        },
      }
      expect(() => writeVerifyStamp(dir, renameFailHostIo, "impl/current")).toThrow(
        /EACCES: rename denied/,
      )
      expect(testHostIo.existsSync(tmpStampPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
