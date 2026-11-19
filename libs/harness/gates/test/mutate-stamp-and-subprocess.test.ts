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
  isImmutableTcbPath,
  MutantCount,
  MutantId,
  MutantSourceText,
  MutateStampPassed,
  removeMutateStamp,
  StampRelFilePath,
  writeMutateStamp,
  writeVerifyStamp,
} from "../src/index.js"
import { parseDstSeedEnv } from "../src/verify-stamp.js"
import { runDomainMutationSuite } from "../src/mutation-check.js"
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
  verifyMutantSchemaSyntax,
} from "../src/mutation/mutant-ast-generator.js"
import { testHostIo } from "./helpers/test-host-io.js"

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

  it("classifies exitCode 1 with FAIL header in stderr (Vitest v5 --bail=1) as killed", () => {
    const res = classifyMutantSubprocessResult(
      "m-stderr-fail",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout: "",
        stderr: " FAIL  libs/demo/test/a.test.ts > fails\n",
      }),
    )
    expect(res).toEqual({ kind: "outcome", status: "killed" })
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

describe("mutation-subprocess-helpers & mutant-ast-generator: Wave 2B #63 saturation", () => {
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

  it("REQ-1.2: batched per-package baseline runs 1 baseline call across multiple files and falls back to per-file baseline on package failure", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pkg-baseline-test-"))
    try {
      const srcDir = join(repoRoot, "libs", "demo", "domain", "src")
      const testDir = join(repoRoot, "libs", "demo", "domain", "test")
      mkdirSync(srcDir, { recursive: true })
      mkdirSync(testDir, { recursive: true })
      writeFileSync(join(repoRoot, "package.json"), '{"name":"tmp"}\n')
      writeFileSync(join(srcDir, "a.ts"), "export const eqA = (x: number, y: number) => x === y\n")
      writeFileSync(join(srcDir, "b.ts"), "export const eqB = (x: number, y: number) => x === y\n")
      writeFileSync(join(testDir, "a.test.ts"), 'import { eqA } from "../src/a.js"\n')
      writeFileSync(join(testDir, "b.test.ts"), 'import { eqB } from "../src/b.js"\n')

      let baselineCalls = 0
      const notGit: SyncHostExecResult = {
        _tag: "Exited",
        exitCode: 128,
        stdout: "",
        stderr: "not a git repository",
      }
      const okIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, opts) => {
          if (cmd === "git") return notGit
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            baselineCalls += 1
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  2 passed (2)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/demo/domain/test/a.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      const okReport = runDomainMutationSuite(repoRoot, okIo, {
        includeAllLines: true,
        disableMutantCache: true,
      })
      expect(okReport.passed).toBe(true)
      expect(okReport.evaluatedFiles).toEqual([
        "libs/demo/domain/src/a.ts",
        "libs/demo/domain/src/b.ts",
      ])
      expect(baselineCalls).toBe(1)

      // When package baseline fails and a.test.ts passes while b.test.ts fails,
      // fall back to per-file baseline and emit exact failing file 'libs/demo/domain/src/b.ts'
      const failIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, args, opts) => {
          if (cmd === "git") return notGit
          if (opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
            if (args.some((a) => a.includes("b.test.ts"))) {
              return { _tag: "Exited", exitCode: 1, stdout: "", stderr: "b-broken" }
            }
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/demo/domain/test/a.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      // Make a.test.ts import only a.ts (already true), and use targetFiles: [a.ts] first to verify single-file < 2 guard
      let singleBaselineCalls = 0
      const singleReport = runDomainMutationSuite(
        repoRoot,
        {
          ...okIo,
          execFileSync: (cmd, args, opts) => {
            if (cmd !== "git" && opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined) {
              singleBaselineCalls += 1
            }
            return okIo.execFileSync(cmd, args, opts)
          },
        },
        {
          targetFiles: ["libs/demo/domain/src/a.ts"],
          includeAllLines: true,
          disableMutantCache: true,
        },
      )
      expect(singleReport.passed).toBe(true)
      expect(singleBaselineCalls).toBe(1)

      // In failIo: a.test.ts only reaches a.ts? Wait: findReachingTestFilesChecked returns all tests in test/ unless filtered,
      // so mock a.test.ts-only pass when only a.test.ts is in args; if both a.test.ts and b.test.ts are in args,
      // package baseline fails and a.ts passes if a.ts only imports a.test.ts — let's ensure a.test.ts has a vitest import so
      // partitionReachingTestFilesChecked puts a.test.ts in primaryTests for a.ts and b.test.ts in primaryTests for b.ts.
      const failReport = runDomainMutationSuite(repoRoot, failIo, {
        includeAllLines: true,
        disableMutantCache: true,
      })
      expect(failReport.passed).toBe(false)
      expect(failReport.diagnostic).toContain(
        "[mutation-check] Baseline test suite failed on unmutated file 'libs/demo/domain/src/",
      )
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-Adv.9: runVitestTargetList scales baseline, batch, and sequential timeouts with reachingTestFiles.length", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "scaled-timeout-"))
    try {
      const srcDir = join(repoRoot, "libs", "demo", "domain", "src")
      mkdirSync(srcDir, { recursive: true })
      const modPath = join(srcDir, "mod.ts")
      const src = "export const eq = (a: number, b: number) => a === b\n"
      writeFileSync(modPath, src)
      const mutants = discoverDomainMutants("libs/demo/domain/src/mod.ts", src)
      const bundle = compileMutantSchemaModule("libs/demo/domain/src/mod.ts", src, mutants)
      const seenTimeouts: Array<number | undefined> = []
      const io: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, _args, opts) => {
          seenTimeouts.push(opts?.timeoutMs)
          return opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined
            ? { _tag: "Exited", exitCode: 0, stdout: "Tests  5 passed (5)\n", stderr: "" }
            : { _tag: "Exited", exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "" }
        },
      }
      const fiveTests = ["t1.test.ts", "t2.test.ts", "t3.test.ts", "t4.test.ts", "t5.test.ts"]
      const res = runVitestTargetList(
        repoRoot,
        {
          scope: "demo",
          pkgDir: "domain",
          tier: "domain",
          fullPath: modPath,
          relFile: "libs/demo/domain/src/mod.ts",
        },
        io,
        {},
        fiveTests,
        src,
        bundle.schemaSource,
        join(repoRoot, ".harness", "mutation-backup.json"),
        mutants.slice(0, 1),
      )
      expect(res._tag).toBe("Ok")
      expect(seenTimeouts).toEqual([50_000, 50_000])
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("REQ-1.3: diffOnly filters explicit targetFiles to git diff modified lines and skips unchanged files", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "diff-only-target-"))
    try {
      const srcDir = join(repoRoot, "libs", "demo", "domain", "src")
      const testDir = join(repoRoot, "libs", "demo", "domain", "test")
      mkdirSync(srcDir, { recursive: true })
      mkdirSync(testDir, { recursive: true })
      writeFileSync(join(repoRoot, "package.json"), '{"name":"tmp"}\n')
      writeFileSync(
        join(srcDir, "a.ts"),
        "export const f1 = (x: number) => x === 1\nexport const f2 = (x: number) => x === 2\n",
      )
      writeFileSync(join(srcDir, "b.ts"), "export const g1 = (x: number) => x === 1\n")
      writeFileSync(
        join(testDir, "a.test.ts"),
        'import { f1, f2 } from "../src/a.js"\nimport { g1 } from "../src/b.js"\n',
      )

      const unifiedDiff = [
        "diff --git a/libs/demo/domain/src/a.ts b/libs/demo/domain/src/a.ts",
        "--- a/libs/demo/domain/src/a.ts",
        "+++ b/libs/demo/domain/src/a.ts",
        "@@ -2,0 +2,1 @@",
        "+export const f2 = (x: number) => x === 2",
      ].join("\n")

      const mutatedLinesSeen: Array<number> = []
      const diffIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, args, opts) => {
          if (cmd === "git") {
            if (args.includes("rev-parse")) {
              return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
            }
            if (args.includes("diff")) {
              return { _tag: "Exited", exitCode: 0, stdout: unifiedDiff, stderr: "" }
            }
            return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
          }
          const activeId = opts?.env?.["HARNESS_ACTIVE_MUTANT_ID"]
          if (activeId === undefined) {
            return { _tag: "Exited", exitCode: 0, stdout: "Tests  1 passed (1)\n", stderr: "" }
          }
          const lineMatch = /:(\d+)(?:@|:)/.exec(activeId)
          if (lineMatch !== null) mutatedLinesSeen.push(Number(lineMatch[1]))
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "FAIL  libs/demo/domain/test/a.test.ts\nTests  1 failed (1)\n",
            stderr: "",
          }
        },
      }

      const report = runDomainMutationSuite(repoRoot, diffIo, {
        targetFiles: ["libs/demo/domain/src/a.ts", "libs/demo/domain/src/b.ts"],
        diffOnly: true,
        disableMutantCache: true,
      })
      expect(report.passed).toBe(true)
      expect(report.diffMode).toBe("working-tree")
      expect(report.diffMatchedFiles).toEqual(["libs/demo/domain/src/a.ts"])
      expect(report.evaluatedFiles).toEqual(["libs/demo/domain/src/a.ts"])
      expect(report.totalMutants).toBeGreaterThan(0)
      expect(mutatedLinesSeen.length).toBeGreaterThan(0)
      expect(mutatedLinesSeen.every((line) => line === 2)).toBe(true)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
