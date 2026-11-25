import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { match } from "ts-pattern"
import { AstSourceFilePath, SourceLineNumber } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  checkMutateStamp,
  computeWorkspaceTreeHashChecked,
  MutantCount,
  MutantId,
  MutantSourceText,
  MutateStampPassed,
  removeMutateStamp,
  resolveHarnessStateDir,
  StampRelFilePath,
  writeMutateStamp,
  writeVerifyStamp,
} from "../src/index.js"
import {
  evaluateMutationOutcomes,
  getActiveMutantId,
  runDomainMutationSuite,
} from "../src/mutation-check.js"
import { setActiveMutantId } from "../src/mutation/mutant-ast-generator.js"
import { extractGitDiffModifiedLinesChecked } from "../src/mutation/mutation-backup.js"
import {
  findDomainFiles,
  findDomainFilesChecked,
  findUnclassifiedModifiedLibFilesChecked,
  partitionReachingTestFiles,
  readPackageManifest,
  resolveLibPackageClassificationChecked,
} from "../src/mutation/mutation-target-discovery.js"
import { isolatedTestHostIo, testHostIo } from "./helpers/test-host-io.js"

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

describe("Wave 2B #63 & P0/P1/P2 saturation: mutation-backup, discovery, mutation-check, and recovery", () => {
  it("1. mutation-backup: merges overlapping diff lines across git diff -U0 and git diff -U0 HEAD, and checks explicitBaseRef", () => {
    const overlapFile = "libs/demo/core/src/overlap.ts"
    const hostIo: SyncHostIo = {
      ...testHostIo,
      execFileSync: (_cmd, args) => {
        if (args.includes("rev-parse"))
          return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
        if (args.includes("diff") && !args.includes("HEAD") && !args.includes("deadbeef")) {
          return {
            _tag: "Exited",
            exitCode: 0,
            stdout: `+++ b/${overlapFile}\n@@ -0,0 +2,2 @@\n+a\n+b\n`,
            stderr: "",
          }
        }
        if (args.includes("diff") && args.includes("HEAD")) {
          return {
            _tag: "Exited",
            exitCode: 0,
            stdout: `+++ b/${overlapFile}\n@@ -0,0 +3,2 @@\n+b\n+c\n`,
            stderr: "",
          }
        }
        if (args.includes("merge-base"))
          return { _tag: "Exited", exitCode: 0, stdout: "deadbeef\n", stderr: "" }
        if (args.includes("diff") && args.includes("deadbeef")) {
          return {
            _tag: "Exited",
            exitCode: 0,
            stdout: `+++ b/${overlapFile}\n@@ -0,0 +5,1 @@\n+e\n`,
            stderr: "",
          }
        }
        return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
      },
    }

    const merged = extractGitDiffModifiedLinesChecked("/mock-repo", hostIo)
    match(merged)
      .with({ _tag: "Ok" }, ({ lines, diffMode }) => {
        expect(diffMode).toBe("working-tree")
        expect(Array.from(lines.get(overlapFile) ?? []).sort((a, b) => a - b)).toEqual([2, 3, 4])
      })
      .with({ _tag: "NotGit" }, { _tag: "Failed" }, () => {
        expect.unreachable("Expected ok for merged diff")
      })
      .exhaustive()

    const missingBase = extractGitDiffModifiedLinesChecked("/mock-repo", hostIo, {
      explicitBaseRef: true,
    })
    expect(missingBase).toEqual({
      _tag: "Failed",
      reason: "explicitBaseRef requires fallbackBaseRef",
    })

    const explicitOk = extractGitDiffModifiedLinesChecked("/mock-repo", hostIo, {
      explicitBaseRef: true,
      fallbackBaseRef: "main",
    })
    match(explicitOk)
      .with({ _tag: "Ok" }, ({ diffMode, lines }) => {
        expect(diffMode).toBe("branch-base")
        expect(Array.from(lines.get(overlapFile) ?? [])).toEqual([5])
      })
      .with({ _tag: "NotGit" }, { _tag: "Failed" }, () => {
        expect.unreachable("Expected ok for explicitBaseRef")
      })
      .exhaustive()
  })

  it("2. mutation-target-discovery: custom pkg name scope, test/fixtures inclusion/exclusion, and 2-char symbol-matching tier", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-disc-63-"))
    try {
      const customPkg = writePkg(dir, "acme", "engine", {
        type: "package.json",
        name: "@custom-org/workflow-kernel",
        tags: ["type:core"],
      })
      writeFileSync(join(customPkg, "src", "k.ts"), "export const k = 1\n", "utf8")

      const namelessPkg = writePkg(dir, "acme", "nameless", {
        type: "package.json",
        tags: ["type:core"],
      })
      writeFileSync(join(namelessPkg, "src", "n.ts"), "export const n = 1\n", "utf8")

      const scoped = findDomainFiles(dir, testHostIo, "@custom-org/workflow-kernel").map(
        (f) => f.relFile,
      )
      expect(scoped).toEqual(["libs/acme/engine/src/k.ts"])

      // test/fixtures/fx.ts included for type:core and excluded for type:contract
      const gatesPkg = writePkg(dir, "harness", "gates", {
        type: "package.json",
        name: "@harness/gates",
        tags: ["type:core"],
      })
      mkdirSync(join(gatesPkg, "test", "fixtures"), { recursive: true })
      writeFileSync(join(gatesPkg, "test", "fixtures", "fx.ts"), "export const fx = 1\n", "utf8")

      const protoPkg = writePkg(dir, "demo", "proto", {
        type: "package.json",
        name: "@demo/proto",
        tags: ["type:contract"],
      })
      mkdirSync(join(protoPkg, "test", "fixtures"), { recursive: true })
      writeFileSync(join(protoPkg, "test", "fixtures", "fx.ts"), "export const pfx = 1\n", "utf8")

      const allRel = findDomainFiles(dir, testHostIo).map((f) => f.relFile)
      expect(allRel).toContain("libs/harness/gates/test/fixtures/fx.ts")
      expect(allRel).not.toContain("libs/demo/proto/test/fixtures/fx.ts")

      // Symbol-matching tier (>= 3 tests, none matching stem)
      const symPkg = writePkg(dir, "sym", "core", {
        type: "package.json",
        name: "@sym/core",
        tags: ["type:core"],
      })
      const symTestDir = join(symPkg, "test")
      mkdirSync(symTestDir, { recursive: true })
      const symSource = [
        "export const fn = 1",
        "export const q = 1",
        "const ab = 2",
        "const z = 3",
        "type Ignored = number",
        "export { ab, , type Ignored }",
        "export { z }",
      ].join("\n")
      const symPath = join(symPkg, "src", "target-mod.ts")
      writeFileSync(symPath, symSource, "utf8")

      const tFn = join(symTestDir, "a-fn.test.ts")
      const tAb = join(symTestDir, "b-ab.test.ts")
      const tSingleChar = join(symTestDir, "c-single.test.ts")
      writeFileSync(tFn, "fn()\n", "utf8")
      writeFileSync(tAb, "ab()\n", "utf8")
      writeFileSync(tSingleChar, "const r = q + z\n", "utf8")

      const part = partitionReachingTestFiles(
        dir,
        {
          scope: "sym",
          pkgDir: "core",
          pkgName: "@sym/core",
          tier: "core",
          fullPath: symPath,
          relFile: "libs/sym/core/src/target-mod.ts",
        },
        symSource,
        testHostIo,
      )
      expect(part.primaryTests).toEqual([tFn, tAb])
      expect(part.fallbackTests).toEqual([tSingleChar])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("5a. mutation-check: saturation specs, startup backup aborts, and sourceCodeOverlays isolation", () => {
    const dummyMutant = {
      id: MutantId.make("m-sat"),
      file: AstSourceFilePath.make("libs/demo/domain/src/a.ts"),
      line: SourceLineNumber.make(1),
      category: "boolean-return" as const,
      original: MutantSourceText.make("return true"),
      replacement: MutantSourceText.make("return false"),
      mutatedSource: MutantSourceText.make("return false"),
    }
    const satSpecs = [
      {
        spanQualname: "Demo.op",
        spanName: "Demo.op",
        filePath: "libs/demo/domain/src/a.ts",
        declaredErrorTags: ["DemoError"],
      },
    ]
    const satPass = evaluateMutationOutcomes(
      [{ mutant: dummyMutant, status: "killed" }],
      undefined,
      undefined,
      satSpecs,
      [
        {
          spanId: "s1",
          parentSpanId: null,
          name: "Demo.op",
          exitTag: "Failure",
          errorTag: "DemoError",
        },
      ],
    )
    expect(satPass.passed).toBe(true)
    expect(satPass.saturationViolations).toEqual([])

    const satFail = evaluateMutationOutcomes(
      [{ mutant: dummyMutant, status: "killed" }],
      undefined,
      undefined,
      satSpecs,
      [{ spanId: "s1", parentSpanId: null, name: "Demo.op", exitTag: "Success" }],
    )
    expect(satFail.passed).toBe(false)
    expect(satFail.saturationViolations).toHaveLength(1)

    const dir = mkdtempSync(join(tmpdir(), "mut-check-63a-"))
    const prevBackupEnv = process.env["HARNESS_ACTIVE_BACKUP_PATH"]
    try {
      const protoPkg = writePkg(dir, "demo", "proto", {
        type: "package.json",
        name: "@demo/proto",
        tags: ["type:contract"],
      })
      mkdirSync(join(protoPkg, "test"), { recursive: true })
      const protoRel = "libs/demo/proto/src/schema.ts"
      writeFileSync(
        join(protoPkg, "src", "schema.ts"),
        "export const p = (n: number) => n === 1\n",
        "utf8",
      )
      writeFileSync(join(protoPkg, "test", "schema.test.ts"), "export const pt = 1\n", "utf8")

      mkdirSync(join(dir, ".harness"), { recursive: true })
      const backupPath = join(dir, ".harness", "mutation-backup.json")
      writeFileSync(backupPath, "{corrupt", "utf8")
      const startupAbort = runDomainMutationSuite(dir, testHostIo, { includeAllLines: true })
      expect(startupAbort.passed).toBe(false)
      expect("diffMode" in startupAbort).toBe(true)
      expect("scannedCandidateFiles" in startupAbort).toBe(true)

      const liveBackupContent = JSON.stringify({ sentinel: true })
      writeFileSync(backupPath, liveBackupContent, "utf8")
      process.env["HARNESS_ACTIVE_BACKUP_PATH"] = backupPath

      const overlayContract = runDomainMutationSuite(dir, testHostIo, {
        sourceCodeOverlays: { [protoRel]: "export const p = (n: number) => n === 1\n" },
        testRunner: () => "killed",
      })
      expect(overlayContract.passed).toBe(false)
      expect(testHostIo.readTextSync(backupPath)).toBe(liveBackupContent)

      const overlayContractOk = runDomainMutationSuite(dir, testHostIo, {
        sourceCodeOverlays: { [protoRel]: "export const p = (n: number) => n === 1\n" },
        testRunner: (m) => (m.id === "__baseline__" ? "survived" : "killed"),
      })
      expect(overlayContractOk.passed).toBe(true)
      expect(overlayContractOk.killedCount).toBe(1)
      expect(testHostIo.readTextSync(backupPath)).toBe(liveBackupContent)

      const virtualOverlay = runDomainMutationSuite(dir, testHostIo, {
        sourceCodeOverlays: {
          "libs/demo/core/src/virtual.ts": "export const v = (n: number) => n === 1\n",
        },
      })
      expect(virtualOverlay.passed).toBe(false)
      expect(virtualOverlay.survivedCount).toBe(1)
    } finally {
      if (prevBackupEnv === undefined)
        Reflect.deleteProperty(process.env, "HARNESS_ACTIVE_BACKUP_PATH")
      else process.env["HARNESS_ACTIVE_BACKUP_PATH"] = prevBackupEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const setupCoreAndMysteryRepo = (
    prefix: string,
  ): { readonly dir: string; readonly twoLineRel: string } => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    const corePkg = writePkg(dir, "demo", "core", {
      type: "package.json",
      name: "@demo/core",
      tags: ["type:core"],
    })
    const unclassPkg = writePkg(dir, "demo", "mystery", {
      type: "package.json",
      name: "@demo/mystery",
      tags: [],
    })
    mkdirSync(join(corePkg, "test"), { recursive: true })
    const twoLineRel = "libs/demo/core/src/two.ts"
    writeFileSync(
      join(corePkg, "src", "two.ts"),
      "export const f1 = (a: number) => a === 1\nexport const f2 = (b: number) => b === 2\n",
      "utf8",
    )
    writeFileSync(join(corePkg, "test", "two.test.ts"), "export const t = 1\n", "utf8")
    writeFileSync(
      join(unclassPkg, "src", "u.ts"),
      "export const u = (n: number) => n === 1\n",
      "utf8",
    )
    return { dir, twoLineRel }
  }

  it("5b-1. mutation-check: post-diff abort, empty repo strict fail, and strict/advisory scope matrix", () => {
    const { dir } = setupCoreAndMysteryRepo("mut-check-63b1-")
    try {
      const postDiffAbort = runDomainMutationSuite(dir, testHostIo, {
        includeAllLines: true,
        scope: "@demo/core",
        testRunner: (m) => {
          if (m.id !== "__baseline__") throw new Error("runner exploded")
          return "survived"
        },
      })
      expect(postDiffAbort.passed).toBe(false)
      expect(postDiffAbort.diffMode).toBe("all-lines")
      expect(postDiffAbort.scannedCandidateFiles).toBe(1)
      expect(postDiffAbort.diagnostic).toContain("Custom testRunner threw")

      expect(
        runDomainMutationSuite(dir, testHostIo, {
          enforcementMode: "advisory",
          scope: "nonexistent",
        }).passed,
      ).toBe(true)
      expect(
        runDomainMutationSuite(dir, testHostIo, { enforcementMode: "strict", scope: "nonexistent" })
          .passed,
      ).toBe(false)
      expect(
        runDomainMutationSuite(dir, testHostIo, {
          enforcementMode: "strict",
          scope: "@demo/core",
          includeAllLines: true,
          testRunner: (m) => (m.id === "__baseline__" ? "survived" : "killed"),
        }).passed,
      ).toBe(true)

      const emptyDir = mkdtempSync(join(tmpdir(), "mut-empty-63-"))
      try {
        expect(
          runDomainMutationSuite(emptyDir, testHostIo, { enforcementMode: "strict" }).passed,
        ).toBe(false)
      } finally {
        rmSync(emptyDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("5b-2. mutation-check: branch-base fallback, diff filtering, explicitTargets, includeAllLines, and unclassified lib matrix", () => {
    const { dir, twoLineRel } = setupCoreAndMysteryRepo("mut-check-63b2-")
    try {
      const branchFallbackIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args.includes("rev-parse"))
            return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
          if (args.includes("merge-base"))
            return { _tag: "Exited", exitCode: 0, stdout: "abc123\n", stderr: "" }
          if (args.includes("diff") && args.includes("abc123")) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: `+++ b/${twoLineRel}\n@@ -0,0 +2,1 @@\n+export const f2 = (b: number) => b === 2\n`,
              stderr: "",
            }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      }
      const advClean = runDomainMutationSuite(dir, branchFallbackIo, {
        enforcementMode: "advisory",
      })
      expect(advClean.diffMode).toBe("working-tree")
      expect(advClean.totalMutants).toBe(0)

      const strictBranch = runDomainMutationSuite(dir, branchFallbackIo, {
        enforcementMode: "strict",
        testRunner: (m) => (m.id === "__baseline__" ? "survived" : "killed"),
      })
      expect(strictBranch.diffMode).toBe("branch-base")
      expect(strictBranch.diffMatchedFiles).toEqual([twoLineRel])
      expect(strictBranch.totalMutants).toBe(1)

      const unclassIo: SyncHostIo = {
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
              stdout: "libs/demo/mystery/src/u.ts\n",
              stderr: "",
            }
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      }
      expect(runDomainMutationSuite(dir, unclassIo, { enforcementMode: "advisory" }).passed).toBe(
        true,
      )
      expect(
        runDomainMutationSuite(dir, unclassIo, { enforcementMode: "strict", scope: "@demo/core" })
          .passed,
      ).toBe(false)
      expect(
        runDomainMutationSuite(dir, unclassIo, {
          enforcementMode: "strict",
          targetFiles: [twoLineRel],
          testRunner: (m) => (m.id === "__baseline__" ? "survived" : "killed"),
        }).passed,
      ).toBe(true)
      expect(runDomainMutationSuite(dir, unclassIo, { enforcementMode: "strict" }).passed).toBe(
        false,
      )

      const explicitTargets = runDomainMutationSuite(dir, branchFallbackIo, {
        targetFiles: [twoLineRel],
        testRunner: (m) => (m.id === "__baseline__" ? "survived" : "killed"),
      })
      expect(explicitTargets.diffMode).toBe("explicit-files")
      expect(explicitTargets.totalMutants).toBe(2)

      const allLinesRes = runDomainMutationSuite(dir, branchFallbackIo, {
        scope: "@demo/core",
        includeAllLines: true,
        testRunner: (m) => (m.id === "__baseline__" ? "survived" : "killed"),
      })
      expect(allLinesRes.diffMode).toBe("all-lines")
      expect(allLinesRes.totalMutants).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("5b-3. mutation-check: testRunner restores prior HARNESS_ACTIVE_MUTANT_ID across baseline and mutant runs", () => {
    const { dir, twoLineRel } = setupCoreAndMysteryRepo("mut-check-63b3-")
    const prevEnvMut = process.env["HARNESS_ACTIVE_MUTANT_ID"]
    try {
      for (const initialActive of ["outer-mut", undefined]) {
        setActiveMutantId(initialActive)
        const observedActive: Array<string | undefined> = []
        runDomainMutationSuite(dir, testHostIo, {
          targetFiles: [twoLineRel],
          testRunner: (m) => {
            observedActive.push(getActiveMutantId())
            return m.id === "__baseline__" ? "survived" : "survived"
          },
        })
        expect(observedActive[0]).toBeUndefined()
        expect(observedActive[1]).toBeDefined()
        expect(getActiveMutantId()).toBe(initialActive)
      }
    } finally {
      setActiveMutantId(undefined)
      if (prevEnvMut === undefined) Reflect.deleteProperty(process.env, "HARNESS_ACTIVE_MUTANT_ID")
      else process.env["HARNESS_ACTIVE_MUTANT_ID"] = prevEnvMut
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("discovery corrupt-manifest & guarded I/O errors + backup unreadable untracked & diffFromMergeBase", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-disc-backup-"))
    try {
      const pkgDir = writePkg(dir, "demo", "bad", {
        type: "package.json",
        name: "@demo/bad",
        tags: [],
      })
      writeFileSync(join(pkgDir, "package.json"), "{corrupt-json", "utf8")

      const corruptManifest = resolveLibPackageClassificationChecked(pkgDir, "bad", testHostIo)
      expect(corruptManifest._tag).toBe("CorruptManifest")

      const readdirFailIo: SyncHostIo = {
        ...testHostIo,
        readdirSync: () => {
          throw new Error("readdir EIO")
        },
      }
      const domErr = findDomainFilesChecked(dir, readdirFailIo)
      expect(domErr._tag).toBe("Error")

      writeFileSync(join(pkgDir, "src", "a.ts"), "export const a = 1\n", "utf8")
      const unclassErr = findUnclassifiedModifiedLibFilesChecked(
        dir,
        new Map([["libs/demo/bad/src/a.ts", new Set([1])]]),
        [],
        testHostIo,
      )
      expect(unclassErr._tag).toBe("Error")

      // Unreadable untracked file fail-closed in mutation-backup.ts
      const untrackedFile = join(dir, "libs", "demo", "bad", "src", "untracked.ts")
      writeFileSync(untrackedFile, "export const u = 1\n", "utf8")
      const mockGitIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args.includes("rev-parse"))
            return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
          if (args.includes("merge-base"))
            return { _tag: "Exited", exitCode: 0, stdout: "abc123\n", stderr: "" }
          if (args.includes("ls-files")) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: "libs/demo/bad/src/untracked.ts\n",
              stderr: "",
            }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
        readTextSync: (p) => {
          if (p === untrackedFile) throw new Error("untracked EACCES")
          return testHostIo.readTextSync(p)
        },
      }
      const unreadableRes = extractGitDiffModifiedLinesChecked(dir, mockGitIo)
      expect(unreadableRes._tag).toBe("Failed")

      // diffFromMergeBase includes uncommitted working-tree changes + untracked .ts/.tsx under libs/
      const mbIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args.includes("rev-parse"))
            return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
          if (args.includes("merge-base"))
            return { _tag: "Exited", exitCode: 0, stdout: "abc123\n", stderr: "" }
          if (args.includes("diff") && args.includes("abc123")) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: [
                "diff --git a/libs/demo/bad/src/committed.ts b/libs/demo/bad/src/committed.ts",
                "+++ b/libs/demo/bad/src/committed.ts",
                "@@ -1,0 +1,1 @@",
                "+export const c = 1",
              ].join("\n"),
              stderr: "",
            }
          }
          if (args.includes("ls-files")) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: "libs/demo/bad/src/untracked.ts\n",
              stderr: "",
            }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      }
      const mbRes = extractGitDiffModifiedLinesChecked(dir, mbIo, {
        explicitBaseRef: true,
        fallbackBaseRef: "main",
      })
      match(mbRes)
        .with({ _tag: "Ok" }, ({ lines, diffMode }) => {
          expect(diffMode).toBe("branch-base")
          expect(lines.has("libs/demo/bad/src/committed.ts")).toBe(true)
          expect(lines.has("libs/demo/bad/src/untracked.ts")).toBe(true)
        })
        .with({ _tag: "Failed" }, { _tag: "NotGit" }, () => {
          expect.unreachable("Expected ok from diffFromMergeBase")
        })
        .exhaustive()

      // merge-base-failed returns { kind: "failed" }
      const mbFailIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args.includes("rev-parse"))
            return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
          if (args.includes("merge-base"))
            return { _tag: "Exited", exitCode: 1, stdout: "", stderr: "no merge base" }
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      }
      const mbFailRes = extractGitDiffModifiedLinesChecked(dir, mbFailIo, {
        explicitBaseRef: true,
        fallbackBaseRef: "main",
      })
      expect(mbFailRes._tag).toBe("Failed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("P0/P1/P2a saturation: HARNESS_STATE_DIR=., conflicting tags, $foo export, branch+working-tree diff, and symlink traversal refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-p0p1p2a-"))
    const prevStateDir = process.env["HARNESS_STATE_DIR"]
    try {
      process.env["HARNESS_STATE_DIR"] = "."
      expect(() => resolveHarnessStateDir(dir, process.env)).toThrow()
      Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")

      const conflictPkg = writePkg(dir, "demo", "conflict", {
        type: "package.json",
        name: "@demo/conflict",
        tags: ["type:contract", "type:infra"],
      })
      expect(resolveLibPackageClassificationChecked(conflictPkg, "conflict", testHostIo)._tag).toBe(
        "CorruptManifest",
      )

      const dollarDomainFile = {
        scope: "demo",
        pkgDir: "core",
        pkgName: "@demo/core",
        tier: "core" as const,
        fullPath: join(dir, "libs", "demo", "core", "src", "dollar.ts"),
        relFile: "libs/demo/core/src/dollar.ts",
      }
      mkdirSync(join(dir, "libs", "demo", "core", "src"), { recursive: true })
      mkdirSync(join(dir, "libs", "demo", "core", "test"), { recursive: true })
      const dollarSrc = "export const foo$bar = 1\n"
      writeFileSync(dollarDomainFile.fullPath, dollarSrc, "utf8")
      const t1 = join(dir, "libs", "demo", "core", "test", "a.test.ts")
      const t2 = join(dir, "libs", "demo", "core", "test", "b.test.ts")
      const t3 = join(dir, "libs", "demo", "core", "test", "c.test.ts")
      const t4 = join(dir, "libs", "demo", "core", "test", "d.test.ts")
      writeFileSync(t1, "const x = foo$bar\n", "utf8")
      writeFileSync(t2, "const y = 1\n", "utf8")
      writeFileSync(t3, "const z = 1\n", "utf8")
      writeFileSync(t4, "const w = 1\n", "utf8")
      expect(
        partitionReachingTestFiles(dir, dollarDomainFile, dollarSrc, testHostIo).primaryTests,
      ).toEqual([t1])

      const seenGitArgs: Array<ReadonlyArray<string>> = []
      const unionIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          seenGitArgs.push(args)
          if (args.includes("rev-parse") && args.includes("--is-inside-work-tree")) {
            return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
          }
          if (args.includes("rev-parse") && args.includes("--verify")) {
            return { _tag: "Exited", exitCode: 0, stdout: "deadbeef\n", stderr: "" }
          }
          if (args.includes("merge-base"))
            return { _tag: "Exited", exitCode: 0, stdout: "abc123\n", stderr: "" }
          if (args.includes("diff") && args.includes("abc123")) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout:
                "diff --git a/libs/demo/core/src/dollar.ts b/libs/demo/core/src/dollar.ts\n+++ b/libs/demo/core/src/dollar.ts\n@@ -1,0 +1,1 @@\n+export const $foo = 1\n",
              stderr: "",
            }
          }
          if (args.includes("diff") && !args.includes("HEAD") && !args.includes("abc123")) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout:
                "diff --git a/libs/demo/core/test/a.test.ts b/libs/demo/core/test/a.test.ts\n+++ b/libs/demo/core/test/a.test.ts\n@@ -1,0 +1,1 @@\n+// test edit\n",
              stderr: "",
            }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      }
      const unionRes = extractGitDiffModifiedLinesChecked(dir, unionIo, { fallbackBaseRef: "main" })
      match(unionRes)
        .with({ _tag: "Ok" }, ({ lines }) => {
          expect(lines.has("libs/demo/core/src/dollar.ts")).toBe(true)
          expect(lines.has("libs/demo/core/test/a.test.ts")).toBe(true)
        })
        .with({ _tag: "Failed" }, { _tag: "NotGit" }, () => {
          expect.unreachable("Expected Ok from branch-base + working-tree union")
        })
        .exhaustive()
      expect(seenGitArgs.some((a) => a.includes("core.quotePath=false"))).toBe(true)
      expect(
        extractGitDiffModifiedLinesChecked(dir, unionIo, {
          explicitBaseRef: true,
          fallbackBaseRef: "-foo",
        })._tag,
      ).toBe("Failed")

      const tempEvil = join(dir, "libs", "demo", "core", "src", "temp-evil.ts")
      const distEvilDir = join(dir, "libs", "demo", "core", "src", "dist")
      mkdirSync(distEvilDir, { recursive: true })
      writeFileSync(tempEvil, "export const e1 = 1\n", "utf8")
      writeFileSync(join(distEvilDir, "evil.ts"), "export const e2 = 1\n", "utf8")
      const hashBefore = computeWorkspaceTreeHashChecked(dir, testHostIo)
      writeFileSync(tempEvil, "export const e1 = 2\n", "utf8")
      const hashAfterTemp = computeWorkspaceTreeHashChecked(dir, testHostIo)
      expect(hashAfterTemp).not.toEqual(hashBefore)
      writeFileSync(join(distEvilDir, "evil.ts"), "export const e2 = 2\n", "utf8")
      expect(computeWorkspaceTreeHashChecked(dir, testHostIo)).not.toEqual(hashAfterTemp)

      const symDirIo: SyncHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === distEvilDir ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      match(computeWorkspaceTreeHashChecked(dir, symDirIo))
        .with({ _tag: "Failure" }, ({ failure }) => expect(failure).toContain("symbolic link"))
        .with({ _tag: "Success" }, () => expect.unreachable("Expected Failure for symlink dir"))
        .exhaustive()
    } finally {
      if (prevStateDir === undefined) Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      else process.env["HARNESS_STATE_DIR"] = prevStateDir
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("P0/P1/P2b-1: checkMutateStamp modes (all-lines, explicit-files, not-git, branch-base) and equivalencePriors", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-p0p1p2b1-"))
    try {
      mkdirSync(join(dir, "libs", "demo", "core", "src"), { recursive: true })
      writeFileSync(
        join(dir, "libs", "demo", "core", "src", "dollar.ts"),
        "export const x = 1\n",
        "utf8",
      )

      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "all-lines",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/core/src/dollar.ts")],
        diffMatchedFiles: [],
        evaluatedFiles: [],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(0),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(1),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, testHostIo, ["libs/demo/core/src/dollar.ts"])._tag).toBe("Valid")

      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "explicit-files",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [],
        diffMatchedFiles: [],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/core/src/dollar.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(false),
      })
      expect(checkMutateStamp(dir, testHostIo)._tag).toBe("Invalid")

      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "not-git",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/core/src/dollar.ts")],
        diffMatchedFiles: [],
        evaluatedFiles: [],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, testHostIo, ["libs/demo/core/src/dollar.ts"])._tag).toBe(
        "Invalid",
      )

      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "branch-base",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/core/src/dollar.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/core/src/dollar.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/core/src/dollar.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, testHostIo, ["libs/demo/core/src/dollar.ts"])._tag).toBe("Valid")

      const eqReport = evaluateMutationOutcomes(
        [
          {
            mutant: {
              id: MutantId.make("m-eq-0"),
              file: AstSourceFilePath.make("libs/demo/core/src/dollar.ts"),
              line: SourceLineNumber.make(1),
              category: "equality-operator",
              original: MutantSourceText.make("==="),
              replacement: MutantSourceText.make("!=="),
              mutatedSource: MutantSourceText.make("a !== b"),
            },
            status: "killed",
          },
        ],
        undefined,
        {},
      )
      expect("equivalentMutants" in eqReport).toBe(true)
      expect(eqReport.equivalentMutants).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("P0/P1/P2b-2: readPackageManifest merge precedence and findUnclassifiedModifiedLibFilesChecked filtering", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-p0p1p2b2-"))
    try {
      const mergedPkgDir = join(dir, "libs", "demo", "merged")
      mkdirSync(mergedPkgDir, { recursive: true })
      writeFileSync(join(mergedPkgDir, "package.json"), JSON.stringify({ name: "@demo/from-pkg" }))
      writeFileSync(
        join(mergedPkgDir, "project.json"),
        JSON.stringify({ name: "@demo/from-proj", tags: ["type:domain"] }),
      )
      match(readPackageManifest(mergedPkgDir, testHostIo))
        .with({ _tag: "Ok" }, ({ manifest }) => expect(manifest.pkgName).toBe("@demo/from-pkg"))
        .with({ _tag: "Missing" }, { _tag: "CorruptManifest" }, () =>
          expect.unreachable("Expected Ok from merged readPackageManifest"),
        )
        .exhaustive()

      mkdirSync(join(dir, "apps", "demo", "src"), { recursive: true })
      writeFileSync(join(dir, "apps", "demo", "src", "a.ts"), "export const a = 1\n")
      mkdirSync(join(dir, "libs", "demo", "mystery", "test"), { recursive: true })
      writeFileSync(
        join(dir, "libs", "demo", "mystery", "test", "a.test.ts"),
        "export const t = 1\n",
      )
      expect(
        findUnclassifiedModifiedLibFilesChecked(
          dir,
          new Map([
            ["apps/demo/src/a.ts", new Set([1])],
            ["libs/demo/mystery/test/a.test.ts", new Set([1])],
          ]),
          [],
          testHostIo,
        ),
      ).toEqual({ _tag: "Ok", files: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("P0/P1/P2b-3: writeVerifyStamp branch trimming, removeMutateStamp ENOENT/error handling, and .harness treeHash isolation", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-p0p1p2b3-"))
    try {
      mkdirSync(join(dir, "libs", "demo", "core", "src"), { recursive: true })
      writeFileSync(
        join(dir, "libs", "demo", "core", "src", "dollar.ts"),
        "export const x = 1\n",
        "utf8",
      )

      expect(writeVerifyStamp(dir, isolatedTestHostIo, "impl/custom").taskBranch).toBe(
        "impl/custom",
      )
      expect(writeVerifyStamp(dir, isolatedTestHostIo, "   ").taskBranch).toBe("unknown")

      const stampFile = join(dir, ".harness", "mutate-stamp.json")
      expect(Result.isSuccess(removeMutateStamp(dir, isolatedTestHostIo))).toBe(true)
      expect(isolatedTestHostIo.existsSync(stampFile)).toBe(false)

      writeMutateStamp(dir, isolatedTestHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/core/src/dollar.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/core/src/dollar.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/core/src/dollar.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      const enoentIo: SyncHostIo = {
        ...isolatedTestHostIo,
        unlinkSync: () => {
          throw { code: "ENOENT" }
        },
      }
      expect(Result.isSuccess(removeMutateStamp(dir, enoentIo))).toBe(true)
      for (const thrownVal of [null, "boom", new Error("EPERM: denied")] as const) {
        const failUnlinkIo: SyncHostIo = {
          ...isolatedTestHostIo,
          unlinkSync: () => {
            throw thrownVal
          },
        }
        expect(Result.isFailure(removeMutateStamp(dir, failUnlinkIo))).toBe(true)
      }
      const outsideRealpathIo: SyncHostIo = {
        ...isolatedTestHostIo,
        realpathSync: (p) =>
          p === stampFile ? "/outside/mutate-stamp.json" : isolatedTestHostIo.realpathSync(p),
      }
      expect(Result.isFailure(removeMutateStamp(dir, outsideRealpathIo))).toBe(true)

      const hashBase = computeWorkspaceTreeHashChecked(dir, isolatedTestHostIo)
      mkdirSync(join(dir, "apps", "demo", ".harness"), { recursive: true })
      writeFileSync(join(dir, "apps", "demo", ".harness", "telemetry-log.jsonl"), '{"ev":1}\n')
      expect(computeWorkspaceTreeHashChecked(dir, isolatedTestHostIo)).toEqual(hashBase)
      mkdirSync(join(dir, "libs", "demo", "src", ".harness"), { recursive: true })
      writeFileSync(
        join(dir, "libs", "demo", "src", ".harness", "backdoor.ts"),
        "export const x = 1\n",
      )
      expect(computeWorkspaceTreeHashChecked(dir, isolatedTestHostIo)).not.toEqual(hashBase)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
