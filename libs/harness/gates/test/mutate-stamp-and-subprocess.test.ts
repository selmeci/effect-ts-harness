import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { match } from "ts-pattern"
import { AstSourceFilePath, SourceLineNumber } from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import {
  checkMutateStamp,
  checkVerifyStamp,
  classifyFileWrite,
  computeWorkspaceTreeHashChecked,
  isImmutableTcbPath,
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
import { parseDstSeedEnv } from "../src/verify-stamp.js"
import { evaluateMutationOutcomes, runDomainMutationSuite } from "../src/mutation-check.js"
import {
  classifyMutantSubprocessResult,
  runVitestTargetList,
} from "../src/mutation-subprocess-helpers.js"
import {
  compileMutantSchemaModule,
  discoverDomainMutants,
  evaluateMutantSchemaInProcess,
  isAssertionFailure,
  locateWrapTargetSpan,
  setActiveMutantId,
  verifyMutantSchemaSyntax,
} from "../src/mutation/mutant-ast-generator.js"
import { extractGitDiffModifiedLinesChecked } from "../src/mutation/mutation-backup.js"
import {
  findDomainFiles,
  findDomainFilesChecked,
  findUnclassifiedModifiedLibFilesChecked,
  partitionReachingTestFiles,
  readPackageManifest,
  resolveLibPackageClassificationChecked,
} from "../src/mutation/mutation-target-discovery.js"
import { testHostIo } from "./helpers/test-host-io.js"

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

describe("verify-stamp, policy, and rule-synthesizer: mutate stamp lifecycle, guard denial, and TCB protection", () => {
  it("writeMutateStamp / checkMutateStamp / removeMutateStamp and VerifyStamp mutate metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-stamp-"))
    try {
      const srcFile = join(dir, "libs", "demo", "domain", "src", "x.ts")
      mkdirSync(join(dir, "libs", "demo", "domain", "src"), { recursive: true })
      writeFileSync(srcFile, "export const x = 1\n", "utf8")

      // Missing stamp
      const missing = checkMutateStamp(dir, testHostIo)
      expect(missing._tag).toBe("Invalid")

      // Corrupt JSON
      mkdirSync(join(dir, ".harness"), { recursive: true })
      writeFileSync(join(dir, ".harness", "mutate-stamp.json"), "{bad-json", "utf8")
      const corrupt = checkMutateStamp(dir, testHostIo)
      expect(corrupt._tag).toBe("Invalid")

      // Advisory enforcementMode rejected
      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "advisory",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(2),
        killedCount: MutantCount.make(2),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      const advisory = checkMutateStamp(dir, testHostIo)
      expect(advisory._tag).toBe("Invalid")

      // Valid strict stamp accepted
      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(2),
        killedCount: MutantCount.make(2),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      const valid = checkMutateStamp(dir, testHostIo)
      expect(valid._tag).toBe("Valid")

      // VerifyStamp carries mutateEnforcementMode + mutantsEvaluated
      const verifyStamp = writeVerifyStamp(dir, testHostIo, "impl/test", undefined, {
        mutateEnforcementMode: "strict",
        mutantsEvaluated: MutantCount.make(2),
      })
      expect(verifyStamp.mutateEnforcementMode).toBe("strict")
      expect(verifyStamp.mutantsEvaluated).toBe(2)
      const checkedVerify = checkVerifyStamp(dir, testHostIo)
      expect(checkedVerify.valid).toBe(true)

      // Stale treeHash after file edit rejected
      writeFileSync(srcFile, "export const x = 2\n", "utf8")
      const stale = checkMutateStamp(dir, testHostIo)
      expect(stale._tag).toBe("Invalid")

      // removeMutateStamp cleans up
      removeMutateStamp(dir, testHostIo)
      expect(checkMutateStamp(dir, testHostIo)._tag).toBe("Invalid")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("classifyFileWrite denies mutate-stamp.json and isImmutableTcbPath protects mutation TCB files", () => {
    expect(classifyFileWrite(".harness/mutate-stamp.json").verdict).toBe("deny")
    expect(classifyFileWrite(".harness/worktrees/wt1/mutate-stamp.json").verdict).toBe("deny")

    expect(isImmutableTcbPath("libs/harness/gates/src/mutation/mutation-backup.ts")).toBe(true)
    expect(isImmutableTcbPath("libs/harness/gates/src/mutation/mutation-target-discovery.ts")).toBe(
      true,
    )
    expect(isImmutableTcbPath("libs/harness/gates/src/mutation-subprocess-helpers.ts")).toBe(true)
    expect(isImmutableTcbPath("libs/harness/gates/src/verify-stamp.ts")).toBe(true)
  })
})

describe("mutation-subprocess-helpers: classifyMutantSubprocessResult", () => {
  const noisyInfraStderr =
    'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "vitest" not found\nError: Cannot find module "@missing/pkg"\n'

  it("aborts when Vitest test failure evidence is paired with noisy infra strings in stderr", () => {
    const res = classifyMutantSubprocessResult(
      "m-1",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout: "Tests  1 failed (1)\n",
        stderr: noisyInfraStderr,
      }),
    )
    expect(res.kind).toBe("abort")
  })

  it("aborts when stderr contains infra errors even on exitCode 0 with passed summary", () => {
    const res = classifyMutantSubprocessResult(
      "m-2",
      Result.succeed({
        _tag: "Exited",
        exitCode: 0,
        stdout: "Tests  5 passed (5)\n",
        stderr: noisyInfraStderr,
      }),
    )
    expect(res.kind).toBe("abort")
  })

  it("aborts when stdout is empty and stderr contains infra errors on exitCode 1 or 0", () => {
    const res1 = classifyMutantSubprocessResult(
      "m-3",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: noisyInfraStderr,
      }),
    )
    expect(res1.kind).toBe("abort")

    const res0 = classifyMutantSubprocessResult(
      "m-4",
      Result.succeed({
        _tag: "Exited",
        exitCode: 0,
        stdout: "",
        stderr: noisyInfraStderr,
      }),
    )
    expect(res0.kind).toBe("abort")
  })
})

describe("Wave 2B #63 saturation: mutation-backup, discovery, subprocess-helpers, ast-generator, and mutation-check", () => {
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

  const makeSubprocessFixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-sub-63-"))
    const srcPath = join(dir, "libs", "demo", "core", "src", "mod.ts")
    const testPath = join(dir, "libs", "demo", "core", "test", "mod.test.ts")
    const backupPath = join(dir, ".harness", "mutation-backup.json")
    const vitestCliPath = join(dir, "node_modules", "vitest", "vitest.mjs")
    const batchRunnerPath = join(dir, "tools", "parallel-vitest-batch.mjs")
    mkdirSync(join(dir, "libs", "demo", "core", "src"), { recursive: true })
    mkdirSync(join(dir, "libs", "demo", "core", "test"), { recursive: true })
    mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true })
    mkdirSync(join(dir, "tools"), { recursive: true })
    writeFileSync(vitestCliPath, "// stub\n", "utf8")
    writeFileSync(batchRunnerPath, "// stub\n", "utf8")

    const originalSource = "export const eq = (a: number, b: number) => a === b\n"
    const mutatedSchemaSource = "export const eq = (a: number, b: number) => a !== b\n"
    writeFileSync(srcPath, originalSource, "utf8")
    writeFileSync(testPath, "// test\n", "utf8")

    const domainFile = {
      scope: "demo",
      pkgDir: "core",
      pkgName: "@demo/core",
      tier: "core" as const,
      fullPath: srcPath,
      relFile: "libs/demo/core/src/mod.ts",
    }
    const m1 = {
      id: MutantId.make("m-1"),
      file: AstSourceFilePath.make(domainFile.relFile),
      line: SourceLineNumber.make(1),
      category: "equality-operator" as const,
      original: MutantSourceText.make("==="),
      replacement: MutantSourceText.make("!=="),
      mutatedSource: MutantSourceText.make(mutatedSchemaSource),
    }
    const m2 = {
      id: MutantId.make("m-2"),
      file: AstSourceFilePath.make(domainFile.relFile),
      line: SourceLineNumber.make(1),
      category: "equality-operator" as const,
      original: MutantSourceText.make("==="),
      replacement: MutantSourceText.make("!=="),
      mutatedSource: MutantSourceText.make(mutatedSchemaSource),
    }
    return {
      dir,
      srcPath,
      testPath,
      backupPath,
      vitestCliPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
      m2,
    }
  }

  it("3a. mutation-subprocess-helpers: diagnostics & backup-retry restore", () => {
    const missingEvidence = classifyMutantSubprocessResult(
      "m-x",
      Result.succeed({ _tag: "Exited", exitCode: 1, stdout: "", stderr: "" }),
    )
    match(missingEvidence)
      .with({ kind: "abort" }, ({ diagnostic }) => {
        expect(diagnostic).toContain("missingVitestFailureEvidence=true")
      })
      .with({ kind: "outcome" }, () => {
        expect.unreachable("Expected abort")
      })
      .exhaustive()

    const exit2 = classifyMutantSubprocessResult(
      "m-x",
      Result.succeed({ _tag: "Exited", exitCode: 2, stdout: "", stderr: "boom" }),
    )
    expect(exit2).toEqual({
      kind: "abort",
      diagnostic:
        "[mutation-check] Runner infrastructure failure for mutant 'm-x': exitCode=2, stderr=boom",
    })

    const {
      dir,
      srcPath,
      testPath,
      backupPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
    } = makeSubprocessFixture()
    try {
      for (const failUnlink of [true, false]) {
        writeFileSync(srcPath, originalSource, "utf8")
        let srcWriteCount = 0
        const retryIo: SyncHostIo = {
          ...testHostIo,
          existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
          writeTextSync: (p, c) => {
            if (p === srcPath) {
              srcWriteCount += 1
              if (srcWriteCount === 2) throw new Error("disk busy")
            }
            testHostIo.writeTextSync(p, c)
          },
          unlinkSync: (p) => {
            if (failUnlink && p === backupPath) throw new Error("unlink denied")
            testHostIo.unlinkSync(p)
          },
          execFileSync: (_cmd, _args, opts) => {
            if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
              return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
            }
            return { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" }
          },
        }
        const retryRes = runVitestTargetList(
          dir,
          domainFile,
          retryIo,
          { NO_COLOR: "1" },
          [testPath],
          originalSource,
          mutatedSchemaSource,
          backupPath,
          [m1],
        )
        if (failUnlink) {
          match(retryRes)
            .with({ _tag: "Abort" }, ({ diagnostic }) => {
              expect(diagnostic).toContain("from backup retry but Failed to unlink")
            })
            .with({ _tag: "Ok" }, () => {
              expect.unreachable("Expected abort when unlink fails")
            })
            .exhaustive()
          if (testHostIo.existsSync(backupPath)) testHostIo.unlinkSync(backupPath)
        } else {
          match(retryRes)
            .with({ _tag: "Ok" }, ({ outcomes }) => {
              expect(outcomes).toHaveLength(1)
              expect(outcomes[0]?.status).toBe("killed")
            })
            .with({ _tag: "Abort" }, ({ diagnostic }) => {
              expect.unreachable(`Expected ok, got: ${diagnostic}`)
            })
            .exhaustive()
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3b. mutation-subprocess-helpers: batch vs sequential runner selection and batch error cases", () => {
    const {
      dir,
      testPath,
      backupPath,
      vitestCliPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
      m2,
    } = makeSubprocessFixture()
    try {
      const seenSingleArgs: Array<ReadonlyArray<string>> = []
      const singleIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, args, opts) => {
          seenSingleArgs.push(args)
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" }
        },
      }
      const singleRes = runVitestTargetList(
        dir,
        domainFile,
        singleIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1],
      )
      expect(singleRes._tag).toBe("Ok")
      expect(seenSingleArgs.every((a) => !a.includes(batchRunnerPath))).toBe(true)
      expect(seenSingleArgs.some((a) => a.includes(vitestCliPath))).toBe(true)

      const makeBatchIo = (batchResult: SyncHostExecResult): SyncHostIo => ({
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args[0] === batchRunnerPath) return batchResult
          return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
        },
      })

      const batchOk = runVitestTargetList(
        dir,
        domainFile,
        makeBatchIo({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "m-1",
              result: { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" },
            },
            { id: "m-2", result: { _tag: "Signaled", signal: "SIGKILL", stdout: "", stderr: "" } },
          ]),
          stderr: "",
        }),
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      match(batchOk)
        .with({ _tag: "Ok" }, ({ outcomes }) => {
          expect(outcomes.map((o) => o.status)).toEqual(["killed", "killed"])
        })
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected batchOk, got: ${diagnostic}`)
        })
        .exhaustive()

      const batchExit2 = runVitestTargetList(
        dir,
        domainFile,
        makeBatchIo({ _tag: "Exited", exitCode: 2, stdout: "", stderr: "batch crash" }),
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(
        batchExit2._tag === "Abort" && batchExit2.diagnostic.includes("exited with code 2"),
      ).toBe(true)

      const batchMissing = runVitestTargetList(
        dir,
        domainFile,
        makeBatchIo({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "m-1",
              result: { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" },
            },
          ]),
          stderr: "",
        }),
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(
        batchMissing._tag === "Abort" &&
          batchMissing.diagnostic.includes("Batch runner missing result"),
      ).toBe(true)

      const batchSpawnFail = runVitestTargetList(
        dir,
        domainFile,
        makeBatchIo({
          _tag: "Exited",
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: "m-1",
              result: { _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" },
            },
            {
              id: "m-2",
              result: { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" },
            },
          ]),
          stderr: "",
        }),
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(
        batchSpawnFail._tag === "Abort" && batchSpawnFail.diagnostic.includes("spawnError="),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3c. mutation-subprocess-helpers: sequential loop with 2 mutants (survive vs abort)", () => {
    const {
      dir,
      testPath,
      backupPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
      m2,
    } = makeSubprocessFixture()
    try {
      const seqSurviveIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
        execFileSync: () => ({
          _tag: "Exited",
          exitCode: 0,
          stdout: "Tests  1 passed (1)\n",
          stderr: "",
        }),
      }
      const seqSurviveRes = runVitestTargetList(
        dir,
        domainFile,
        seqSurviveIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      match(seqSurviveRes)
        .with({ _tag: "Ok" }, ({ outcomes }) => {
          expect(outcomes).toHaveLength(2)
          expect(outcomes.map((o) => o.status)).toEqual(["survived", "survived"])
        })
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected ok, got: ${diagnostic}`)
        })
        .exhaustive()

      let seqExecCalls = 0
      const seqAbortIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
        execFileSync: (_cmd, _args, opts) => {
          seqExecCalls += 1
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return { _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" }
        },
      }
      const seqAbortRes = runVitestTargetList(
        dir,
        domainFile,
        seqAbortIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1, m2],
      )
      expect(seqAbortRes._tag).toBe("Abort")
      expect(seqExecCalls).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3d. mutation-subprocess-helpers: writeSchemaErr when 1st writeTextSync throws", () => {
    const {
      dir,
      srcPath,
      testPath,
      backupPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
    } = makeSubprocessFixture()
    try {
      for (const failUnlink of [false, true]) {
        writeFileSync(srcPath, originalSource, "utf8")
        let firstWrite = true
        const writeErrIo: SyncHostIo = {
          ...testHostIo,
          writeTextSync: (p, c) => {
            if (p === srcPath && firstWrite) {
              firstWrite = false
              throw new Error("schema write denied")
            }
            testHostIo.writeTextSync(p, c)
          },
          unlinkSync: (p) => {
            if (failUnlink && p === backupPath) throw new Error("unlink blocked")
            testHostIo.unlinkSync(p)
          },
          execFileSync: () => ({
            _tag: "Exited",
            exitCode: 0,
            stdout: "Tests  1 passed (1)\n",
            stderr: "",
          }),
        }
        const writeErrRes = runVitestTargetList(
          dir,
          domainFile,
          writeErrIo,
          { NO_COLOR: "1" },
          [testPath],
          originalSource,
          mutatedSchemaSource,
          backupPath,
          [m1],
        )
        match(writeErrRes)
          .with({ _tag: "Abort" }, ({ diagnostic }) => {
            expect(diagnostic).toContain("Failed to write mutated schema")
            if (failUnlink) {
              expect(diagnostic).toContain("Failed to unlink")
            } else {
              expect(diagnostic.endsWith("schema write denied")).toBe(true)
            }
          })
          .with({ _tag: "Ok" }, () => {
            expect.unreachable("Expected abort on writeSchemaErr")
          })
          .exhaustive()
        if (testHostIo.existsSync(backupPath)) testHostIo.unlinkSync(backupPath)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3e. mutation-subprocess-helpers: mid-run reversion guard", () => {
    const {
      dir,
      srcPath,
      testPath,
      backupPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
    } = makeSubprocessFixture()
    try {
      writeFileSync(srcPath, originalSource, "utf8")
      const clobberIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
        execFileSync: (_cmd, _args, opts) => {
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          testHostIo.writeTextSync(srcPath, originalSource)
          return { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" }
        },
      }
      const clobberRes = runVitestTargetList(
        dir,
        domainFile,
        clobberIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1],
      )
      match(clobberRes)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect(diagnostic).toContain("modified externally mid-run")
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable("Expected abort on mid-run reversion")
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("3f. mutation-subprocess-helpers: mid-loop exception always runs restoreOriginalFile and reports restore status", () => {
    const {
      dir,
      srcPath,
      testPath,
      backupPath,
      batchRunnerPath,
      originalSource,
      mutatedSchemaSource,
      domainFile,
      m1,
    } = makeSubprocessFixture()
    try {
      const throwingIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => (p === batchRunnerPath ? false : testHostIo.existsSync(p)),
        execFileSync: (_cmd, _args, opts) => {
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          throw new Error("unexpected mid-loop exec crash")
        },
      }
      const res = runVitestTargetList(
        dir,
        domainFile,
        throwingIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSchemaSource,
        backupPath,
        [m1],
      )
      expect(testHostIo.readTextSync(srcPath)).toBe(originalSource)
      expect(testHostIo.existsSync(backupPath)).toBe(false)
      match(res)
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect(diagnostic).toContain("unexpected mid-loop exec crash")
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable("Expected abort on mid-loop exception")
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("4. mutant-ast-generator: offset-0, CRLF, locateWrapTargetSpan edge cases, shebang, and syntax verification", () => {
    const topMutants = discoverDomainMutants(
      "libs/demo/domain/src/top.ts",
      "events.reduce((a, b) => a + b, 0)\n",
    )
    expect(topMutants).toHaveLength(1)

    const crlfSource = ["const pad = 'x === y'", "events.reduce((a, b) => a + b, 0)"].join("\r\n")
    const crlfMutants = discoverDomainMutants("libs/demo/domain/src/crlf.ts", crlfSource)
    expect(crlfMutants).toHaveLength(1)
    expect(crlfMutants[0]?.line).toBe(2)
    expect(crlfMutants[0]?.mutatedSource).toContain("\r\n")

    const spanOf = (code: string, needle: string, atEnd = false): string | undefined => {
      const sf = ts.createSourceFile(
        "span.ts",
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const start = code.indexOf(needle)
      const span = locateWrapTargetSpan(
        sf,
        atEnd ? start + needle.length : start,
        start + needle.length,
      )
      return span === undefined ? undefined : code.slice(span.start, span.end)
    }

    expect(spanOf("if (flag) { return a === b }", "flag", true)).toBe("flag")
    expect(spanOf("if (flagA && flagB) { return a === b }", "flagB")).toBe("flagA && flagB")
    expect(spanOf("if (flag) { return a === b }", "a === b")).toBe("a === b")
    expect(spanOf("function f() { return }", "return")).toBeUndefined()
    expect(spanOf("function f(a: number, b: number) { return a === b }", "a === b")).toBe("a === b")
    expect(spanOf("class Sub extends Base { m() { return super.foo() } }", "super")).toBe(
      "super.foo()",
    )
    expect(spanOf("const v = obj.prop", "prop")).toBe("obj.prop")
    expect(spanOf("const v = obj.prop", "obj")).toBe("obj")
    expect(spanOf("const o = { key: val }", "key")).toBe("{ key: val }")
    expect(spanOf("const o = { key: val }", "val")).toBe("val")
    expect(spanOf("fn(arg)", "fn")).toBe("fn(arg)")
    expect(spanOf("fn(arg)", "arg")).toBe("arg")
    expect(spanOf("new Cls(arg)", "Cls")).toBe("new Cls(arg)")
    expect(spanOf("new Cls(arg)", "arg")).toBe("arg")
    expect(spanOf("tag`tpl`", "tag")).toBe("tag`tpl`")
    expect(spanOf("obj.x += 1", "obj.x")).toBe("obj.x += 1")
    expect(spanOf("obj.x += 1", "1")).toBe("1")
    expect(spanOf("++obj.x", "obj.x")).toBe("++obj.x")

    const shebangSrc = "#!/usr/bin/env node\nexport const eq = (a: number, b: number) => a === b\n"
    const shebangMutants = discoverDomainMutants("libs/demo/domain/src/cli.ts", shebangSrc)
    const shebangBundle = compileMutantSchemaModule(
      "libs/demo/domain/src/cli.ts",
      shebangSrc,
      shebangMutants,
    )
    expect(shebangBundle.schemaSource.startsWith("#!/usr/bin/env node\nfunction __hMut")).toBe(true)
    expect(
      verifyMutantSchemaSyntax("libs/demo/domain/src/cli.ts", shebangBundle.schemaSource),
    ).toEqual([])
    expect(verifyMutantSchemaSyntax("bad.ts", "export const x = (;").length).toBeGreaterThan(0)

    expect(isAssertionFailure(new Error("plain failure"))).toBe(false)
    const assertionErr = new Error("boom")
    assertionErr.name = "AssertionError"
    expect(isAssertionFailure(assertionErr)).toBe(true)
    const expectErr = new Error("boom")
    expectErr.name = "ExpectError"
    expect(isAssertionFailure(expectErr)).toBe(true)

    expect(evaluateMutantSchemaInProcess(topMutants, [() => true]).map((o) => o.status)).toEqual([
      "survived",
    ])
    expect(evaluateMutantSchemaInProcess(topMutants, [() => {}]).map((o) => o.status)).toEqual([
      "survived",
    ])
    expect(evaluateMutantSchemaInProcess(topMutants, [() => false]).map((o) => o.status)).toEqual([
      "killed",
    ])
  })

  it("5. mutation-check: saturation specs, makeAbortedReport metadata, overlays, strict/advisory matrix, diff filtering, and testRunner env restoration", () => {
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

    const dir = mkdtempSync(join(tmpdir(), "mut-check-63-"))
    const prevEnvMut = process.env["HARNESS_ACTIVE_MUTANT_ID"]
    const prevBackupEnv = process.env["HARNESS_ACTIVE_BACKUP_PATH"]
    try {
      const corePkg = writePkg(dir, "demo", "core", {
        type: "package.json",
        name: "@demo/core",
        tags: ["type:core"],
      })
      const protoPkg = writePkg(dir, "demo", "proto", {
        type: "package.json",
        name: "@demo/proto",
        tags: ["type:contract"],
      })
      const unclassPkg = writePkg(dir, "demo", "mystery", {
        type: "package.json",
        name: "@demo/mystery",
        tags: [],
      })
      mkdirSync(join(corePkg, "test"), { recursive: true })
      mkdirSync(join(protoPkg, "test"), { recursive: true })

      const twoLineFile = join(corePkg, "src", "two.ts")
      const twoLineRel = "libs/demo/core/src/two.ts"
      writeFileSync(
        twoLineFile,
        "export const f1 = (a: number) => a === 1\nexport const f2 = (b: number) => b === 2\n",
        "utf8",
      )
      writeFileSync(join(corePkg, "test", "two.test.ts"), "export const t = 1\n", "utf8")

      const protoRel = "libs/demo/proto/src/schema.ts"
      writeFileSync(
        join(protoPkg, "src", "schema.ts"),
        "export const p = (n: number) => n === 1\n",
        "utf8",
      )
      writeFileSync(join(protoPkg, "test", "schema.test.ts"), "export const pt = 1\n", "utf8")

      writeFileSync(
        join(unclassPkg, "src", "u.ts"),
        "export const u = (n: number) => n === 1\n",
        "utf8",
      )

      // Startup backup abort omits diffMode and scannedCandidateFiles
      mkdirSync(join(dir, ".harness"), { recursive: true })
      const backupPath = join(dir, ".harness", "mutation-backup.json")
      writeFileSync(backupPath, "{corrupt", "utf8")
      const startupAbort = runDomainMutationSuite(dir, testHostIo, { includeAllLines: true })
      expect(startupAbort.passed).toBe(false)
      expect("diffMode" in startupAbort).toBe(true)
      expect("scannedCandidateFiles" in startupAbort).toBe(true)

      // Active HARNESS_ACTIVE_BACKUP_PATH is NOT clobbered when running with matching path or sourceCodeOverlays
      const liveBackupContent = JSON.stringify({ sentinel: true })
      writeFileSync(backupPath, liveBackupContent, "utf8")
      process.env["HARNESS_ACTIVE_BACKUP_PATH"] = backupPath

      const overlayContract = runDomainMutationSuite(dir, testHostIo, {
        sourceCodeOverlays: { [protoRel]: "export const p = (n: number) => n === 1\n" },
        testRunner: () => "killed",
      })
      // Note: testRunner returns "killed" for baseline too -> baseline fails unless baseline returns "survived"!
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

      Reflect.deleteProperty(process.env, "HARNESS_ACTIVE_BACKUP_PATH")
      if (testHostIo.existsSync(backupPath)) testHostIo.unlinkSync(backupPath)

      // Post-diff abort sets diffMode: "all-lines" and scannedCandidateFiles
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

      // enforcementMode advisory vs strict matrix
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

      // Unclassified modified lib file matrix
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

      // targetFiles vs includeAllLines
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

      // testRunner HARNESS_ACTIVE_MUTANT_ID restoration (pre-set vs undefined)
      for (const initialEnv of ["outer-mut", undefined]) {
        if (initialEnv === undefined)
          Reflect.deleteProperty(process.env, "HARNESS_ACTIVE_MUTANT_ID")
        else process.env["HARNESS_ACTIVE_MUTANT_ID"] = initialEnv
        const observedEnv: Array<string | undefined> = []
        runDomainMutationSuite(dir, testHostIo, {
          targetFiles: [twoLineRel],
          testRunner: (m) => {
            observedEnv.push(process.env["HARNESS_ACTIVE_MUTANT_ID"])
            return m.id === "__baseline__" ? "survived" : "survived"
          },
        })
        expect(observedEnv[0]).toBeUndefined()
        expect(observedEnv[1]).toBeDefined()
        expect(process.env["HARNESS_ACTIVE_MUTANT_ID"]).toBe(initialEnv)
      }
    } finally {
      setActiveMutantId(undefined)
      if (prevEnvMut === undefined) Reflect.deleteProperty(process.env, "HARNESS_ACTIVE_MUTANT_ID")
      else process.env["HARNESS_ACTIVE_MUTANT_ID"] = prevEnvMut
      if (prevBackupEnv === undefined)
        Reflect.deleteProperty(process.env, "HARNESS_ACTIVE_BACKUP_PATH")
      else process.env["HARNESS_ACTIVE_BACKUP_PATH"] = prevBackupEnv
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("checkMutateStamp exact reason strings across all failure modes and parseDstSeedEnv", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-stamp-reasons-"))
    try {
      const srcFile = join(dir, "libs", "demo", "domain", "src", "x.ts")
      mkdirSync(join(dir, "libs", "demo", "domain", "src"), { recursive: true })
      writeFileSync(srcFile, "export const x = 1\n", "utf8")
      const stampPath = join(dir, ".harness", "mutate-stamp.json")

      // missing
      expect(checkMutateStamp(dir, testHostIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Missing .harness/mutate-stamp.json. Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // missing
      mkdirSync(join(dir, ".harness"), { recursive: true })
      const statFailIo: SyncHostIo = {
        ...testHostIo,
        existsSync: (p) => {
          if (p === stampPath) throw new Error("stat EACCES")
          return testHostIo.existsSync(p)
        },
      }
      expect(checkMutateStamp(dir, statFailIo)).toEqual({
        _tag: "Invalid",
        reason: `Failed to stat '${stampPath}': stat EACCES`,
      })
      writeFileSync(stampPath, "{}", "utf8")
      const readFailIo: SyncHostIo = {
        ...testHostIo,
        readTextSync: (p) => {
          if (p === stampPath) throw new Error("read EIO")
          return testHostIo.readTextSync(p)
        },
      }
      expect(checkMutateStamp(dir, readFailIo)).toEqual({
        _tag: "Invalid",
        reason: `Failed to read '${stampPath}': read EIO`,
      })

      // corrupt JSON
      writeFileSync(stampPath, "{not-json", "utf8")
      expect(checkMutateStamp(dir, testHostIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Invalid .harness/mutate-stamp.json. Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // advisory
      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "advisory",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, testHostIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Advisory .harness/mutate-stamp.json is insufficient for verify. Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // totalMutants: 0
      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [],
        totalMutants: MutantCount.make(0),
        killedCount: MutantCount.make(0),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, testHostIo)._tag).toBe("Invalid")

      // survivedCount > 0
      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(2),
        killedCount: MutantCount.make(2),
        survivedCount: MutantCount.make(1),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, testHostIo)._tag).toBe("Invalid")

      // killedCount !== totalMutants
      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(2),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, testHostIo)._tag).toBe("Invalid")

      // missing requiredDiffFiles coverage
      writeMutateStamp(dir, testHostIo, {
        enforcementMode: "strict",
        diffMode: "working-tree",
        scannedCandidateFiles: MutantCount.make(1),
        scannedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        diffMatchedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        evaluatedFiles: [StampRelFilePath.make("libs/demo/domain/src/x.ts")],
        totalMutants: MutantCount.make(1),
        killedCount: MutantCount.make(1),
        survivedCount: MutantCount.make(0),
        equivalentCount: MutantCount.make(0),
        passed: MutateStampPassed.make(true),
      })
      expect(checkMutateStamp(dir, testHostIo, ["libs/demo/domain/src/other.ts"])).toEqual({
        _tag: "Invalid",
        reason:
          "Mutate stamp does not cover required diff file(s): libs/demo/domain/src/other.ts. Run pnpm harness mutate --strict.",
      })

      // symlink refusal
      const symlinkIo: SyncHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === srcFile ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      expect(checkMutateStamp(dir, symlinkIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Failed to compute workspace tree hash (Refusing to hash symbolic link 'libs/demo/domain/src/x.ts'). Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // unreadable file refusal
      const unreadIo: SyncHostIo = {
        ...testHostIo,
        readBytesSync: (p) => {
          if (p === srcFile) throw new Error("EACCES")
          return testHostIo.readBytesSync(p)
        },
      }
      expect(checkMutateStamp(dir, unreadIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Failed to compute workspace tree hash (Failed to read workspace file 'libs/demo/domain/src/x.ts' while computing tree hash: EACCES). Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // treeHash mismatch
      writeFileSync(srcFile, "export const x = 2\n", "utf8")
      expect(checkMutateStamp(dir, testHostIo)).toEqual({
        _tag: "Invalid",
        reason:
          "Workspace files changed since last mutate --strict. Run pnpm harness mutate --strict after your latest edits before verify.",
      })

      // Invalid DST_SEED
      expect(() => parseDstSeedEnv("not-an-int")).toThrow('Invalid DST_SEED value "not-an-int"')
      expect(() => parseDstSeedEnv("-5")).toThrow('Invalid DST_SEED value "-5"')
      expect(parseDstSeedEnv("42")).toBe(42)
      expect(parseDstSeedEnv(undefined)).toBeUndefined()
    } finally {
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

  it("P0/P1/P2 saturation: branch-base+working-tree union, core.quotePath=false, --base -foo, SIGINT/partial-write restore, treeHash traversal & symlink refusal, checkMutateStamp modes, HARNESS_STATE_DIR=., conflicting tags, and $foo export match", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-p0p1p2-"))
    const prevStateDir = process.env["HARNESS_STATE_DIR"]
    try {
      // 1. HARNESS_STATE_DIR=. rejection
      process.env["HARNESS_STATE_DIR"] = "."
      expect(() => resolveHarnessStateDir(dir)).toThrow()
      Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")

      // 2. Conflicting type:contract + type:infra -> CorruptManifest
      const conflictPkg = writePkg(dir, "demo", "conflict", {
        type: "package.json",
        name: "@demo/conflict",
        tags: ["type:contract", "type:infra"],
      })
      expect(resolveLibPackageClassificationChecked(conflictPkg, "conflict", testHostIo)._tag).toBe(
        "CorruptManifest",
      )

      // 3. $foo export regex match in partitionReachingTestFiles
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
      const part = partitionReachingTestFiles(dir, dollarDomainFile, dollarSrc, testHostIo)
      expect(part.primaryTests).toEqual([t1])

      // 4. core.quotePath=false & --base -foo rejection & branch-base + working-tree union
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
          if (args.includes("merge-base")) {
            return { _tag: "Exited", exitCode: 0, stdout: "abc123\n", stderr: "" }
          }
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

      const badBaseRes = extractGitDiffModifiedLinesChecked(dir, unionIo, {
        explicitBaseRef: true,
        fallbackBaseRef: "-foo",
      })
      expect(badBaseRes._tag).toBe("Failed")

      // 5. libs/*/src/temp-evil.ts & libs/*/src/dist/evil.ts NOT skipped by computeWorkspaceTreeHashChecked
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
      const hashAfterDist = computeWorkspaceTreeHashChecked(dir, testHostIo)
      expect(hashAfterDist).not.toEqual(hashAfterTemp)

      // 6. Nested dir symlink refusal
      const symDirIo: SyncHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === distEvilDir ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      const symRes = computeWorkspaceTreeHashChecked(dir, symDirIo)
      match(symRes)
        .with({ _tag: "Failure" }, ({ failure }) => {
          expect(failure).toContain("symbolic link")
        })
        .with({ _tag: "Success" }, () => {
          expect.unreachable("Expected Failure for symlink dir")
        })
        .exhaustive()

      // 7. checkMutateStamp passed: false / equivalentCount / all-lines / explicit-files / branch-base / not-git / positive requiredDiffFiles
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

      // 8. evaluateMutationOutcomes with defined equivalencePriors & 0 equivalent mutants
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

      // 9. readPackageManifest merges package.json pkgName over project.json
      const mergedPkgDir = join(dir, "libs", "demo", "merged")
      mkdirSync(mergedPkgDir, { recursive: true })
      writeFileSync(join(mergedPkgDir, "package.json"), JSON.stringify({ name: "@demo/from-pkg" }))
      writeFileSync(
        join(mergedPkgDir, "project.json"),
        JSON.stringify({ name: "@demo/from-proj", tags: ["type:domain"] }),
      )
      const mergedManifest = readPackageManifest(mergedPkgDir, testHostIo)
      match(mergedManifest)
        .with({ _tag: "Ok" }, ({ manifest }) => {
          expect(manifest.pkgName).toBe("@demo/from-pkg")
        })
        .with({ _tag: "Missing" }, { _tag: "CorruptManifest" }, () => {
          expect.unreachable("Expected Ok from merged readPackageManifest")
        })
        .exhaustive()

      // 10. findUnclassifiedModifiedLibFilesChecked ignores apps/ and libs/*/test/
      mkdirSync(join(dir, "apps", "demo", "src"), { recursive: true })
      writeFileSync(join(dir, "apps", "demo", "src", "a.ts"), "export const a = 1\n")
      mkdirSync(join(dir, "libs", "demo", "mystery", "test"), { recursive: true })
      writeFileSync(
        join(dir, "libs", "demo", "mystery", "test", "a.test.ts"),
        "export const t = 1\n",
      )
      const unclassIgnored = findUnclassifiedModifiedLibFilesChecked(
        dir,
        new Map([
          ["apps/demo/src/a.ts", new Set([1])],
          ["libs/demo/mystery/test/a.test.ts", new Set([1])],
        ]),
        [],
        testHostIo,
      )
      expect(unclassIgnored).toEqual({ _tag: "Ok", files: [] })

      // 11. writeVerifyStamp taskBranch trimming & removeMutateStamp edge cases
      expect(writeVerifyStamp(dir, testHostIo, "impl/custom").taskBranch).toBe("impl/custom")
      expect(writeVerifyStamp(dir, testHostIo, "   ").taskBranch).toBe("unknown")

      const stampFile = join(dir, ".harness", "mutate-stamp.json")
      expect(Result.isSuccess(removeMutateStamp(dir, testHostIo))).toBe(true)
      expect(testHostIo.existsSync(stampFile)).toBe(false)

      writeMutateStamp(dir, testHostIo, {
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
        ...testHostIo,
        unlinkSync: () => {
          throw { code: "ENOENT" }
        },
      }
      expect(Result.isSuccess(removeMutateStamp(dir, enoentIo))).toBe(true)

      for (const thrownVal of [null, "boom", new Error("EPERM: denied")] as const) {
        const failUnlinkIo: SyncHostIo = {
          ...testHostIo,
          unlinkSync: () => {
            throw thrownVal
          },
        }
        expect(Result.isFailure(removeMutateStamp(dir, failUnlinkIo))).toBe(true)
      }

      const outsideRealpathIo: SyncHostIo = {
        ...testHostIo,
        realpathSync: (p) =>
          p === stampFile ? "/outside/mutate-stamp.json" : testHostIo.realpathSync(p),
      }
      expect(Result.isFailure(removeMutateStamp(dir, outsideRealpathIo))).toBe(true)

      // 12. computeWorkspaceTreeHashChecked ignores package-root .harness/ while hashing src/.harness/
      const hashBase = computeWorkspaceTreeHashChecked(dir, testHostIo)
      mkdirSync(join(dir, "apps", "demo", ".harness"), { recursive: true })
      writeFileSync(join(dir, "apps", "demo", ".harness", "telemetry-log.jsonl"), '{"ev":1}\n')
      expect(computeWorkspaceTreeHashChecked(dir, testHostIo)).toEqual(hashBase)

      mkdirSync(join(dir, "libs", "demo", "src", ".harness"), { recursive: true })
      writeFileSync(
        join(dir, "libs", "demo", "src", ".harness", "backdoor.ts"),
        "export const x = 1\n",
      )
      expect(computeWorkspaceTreeHashChecked(dir, testHostIo)).not.toEqual(hashBase)
    } finally {
      if (prevStateDir === undefined) Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      else process.env["HARNESS_STATE_DIR"] = prevStateDir
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
