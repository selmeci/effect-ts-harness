import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { AstSourceFilePath, computeContentSha256, SourceLineNumber } from "@harness/contract"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { MutantId, MutantSourceText } from "../src/index.js"
import { checkMigrationFiles } from "../src/migration-check.js"
import { normalizePriorMillis, runDomainMutationSuite, stripAnsi } from "../src/mutation-check.js"
import {
  classifyMutantSubprocessResult,
  runVitestTargetList,
} from "../src/mutation-subprocess-helpers.js"
import { isAssertionFailure } from "../src/mutation/mutant-ast-generator.js"
import {
  BackupSchema,
  extractGitDiffModifiedLinesChecked,
  recoverStartupBackup,
  unlinkBackupChecked,
  writeMutationBackup,
} from "../src/mutation/mutation-backup.js"
import { testHostIo } from "./helpers/test-host-io.js"

const setupTempMutationRepo = (
  domainSource: string,
): {
  readonly repoRoot: string
  readonly domainFile: string
  readonly backupPath: string
} => {
  const repoRoot = mkdtempSync(join(tmpdir(), "mutation-check-test-"))
  const domainDir = join(repoRoot, "libs", "sample", "domain", "src")
  const testDir = join(repoRoot, "libs", "sample", "domain", "test")
  mkdirSync(domainDir, { recursive: true })
  mkdirSync(testDir, { recursive: true })
  const domainFile = join(domainDir, "logic.ts")
  writeFileSync(domainFile, domainSource, "utf8")
  writeFileSync(
    join(testDir, "logic.test.ts"),
    'import { expect, it } from "vitest"\nit("ok", () => { expect(1).toBe(1) })\n',
    "utf8",
  )
  return {
    repoRoot,
    domainFile,
    backupPath: join(repoRoot, ".harness", "mutation-backup.json"),
  }
}

const isBaselineInvocation = (env?: Readonly<Record<string, string | undefined>>): boolean =>
  env?.["HARNESS_ACTIVE_MUTANT_ID"] === undefined

const notGitExecResult: SyncHostExecResult = {
  _tag: "Exited",
  exitCode: 128,
  stdout: "",
  stderr: "not a git repository",
}

const greenBaselineResult: SyncHostExecResult = {
  _tag: "Exited",
  exitCode: 0,
  stdout: "Tests  1 passed (1)\n",
  stderr: "",
}

describe("mutation-check infrastructure failure and backup recovery (F-4.3, F-5.1)", () => {
  it("F-4.3: does NOT count SpawnFailed (ENOENT), missing vitest, or baseline TimedOut as killed and fails the mutation gate", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, domainFile } = setupTempMutationRepo(source)
    try {
      const spawnErrorHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, options) =>
          cmd === "git"
            ? notGitExecResult
            : isBaselineInvocation(options?.env)
              ? greenBaselineResult
              : {
                  _tag: "SpawnFailed",
                  spawnError: "ENOENT",
                  stdout: "",
                  stderr: "",
                },
      }
      const spawnReport = runDomainMutationSuite(repoRoot, spawnErrorHostIo, {
        includeAllLines: true,
      })
      expect(spawnReport.passed).toBe(false)
      expect(spawnReport.killedCount).toBe(0)
      expect(spawnReport.diagnostic).toContain("spawnError=ENOENT")
      expect(readFileSync(domainFile, "utf8")).toBe(source)

      const baselineTimeoutHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd) =>
          cmd === "git"
            ? notGitExecResult
            : {
                _tag: "TimedOut",
                stdout: "",
                stderr: "",
              },
      }
      const timeoutReport = runDomainMutationSuite(repoRoot, baselineTimeoutHostIo, {
        includeAllLines: true,
      })
      expect(timeoutReport.passed).toBe(false)
      expect(timeoutReport.killedCount).toBe(0)
      expect(timeoutReport.diagnostic).toContain("timedOut=true")
      expect(readFileSync(domainFile, "utf8")).toBe(source)

      const pnpmMissingVitestHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, options) =>
          cmd === "git"
            ? notGitExecResult
            : isBaselineInvocation(options?.env)
              ? greenBaselineResult
              : {
                  _tag: "Exited",
                  exitCode: 127,
                  stdout: "",
                  stderr: 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "vitest" not found',
                },
      }
      const missingVitestReport = runDomainMutationSuite(repoRoot, pnpmMissingVitestHostIo, {
        includeAllLines: true,
      })
      expect(missingVitestReport.passed).toBe(false)
      expect(missingVitestReport.killedCount).toBe(0)
      expect(missingVitestReport.diagnostic).toContain("exitCode=127")
      expect(readFileSync(domainFile, "utf8")).toBe(source)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-5.1: failed startup backup recovery aborts without overwriting or deleting .harness/mutation-backup.json", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, domainFile, backupPath } = setupTempMutationRepo(source)
    try {
      mkdirSync(join(repoRoot, ".harness"), { recursive: true })
      const corruptBackup = "{not-valid-json"
      writeFileSync(backupPath, corruptBackup, "utf8")

      const stderrChunks: Array<string> = []
      const origWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
        return true
      }) as typeof process.stderr.write

      try {
        const report = runDomainMutationSuite(repoRoot, testHostIo, {
          includeAllLines: true,
        })
        expect(report.passed).toBe(false)
        expect(report.diagnostic).toContain("Failed to restore startup backup")
        expect(existsSync(backupPath)).toBe(true)
        expect(readFileSync(backupPath, "utf8")).toBe(corruptBackup)
        expect(readFileSync(domainFile, "utf8")).toBe(source)
        expect(stderrChunks.join("")).toContain("Failed to restore startup backup")
      } finally {
        process.stderr.write = origWrite
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-5.1: failed originalSource restore emits stderr diagnostic, preserves .harness/mutation-backup.json, and fails gate", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, domainFile, backupPath } = setupTempMutationRepo(source)
    try {
      let writeCountToDomainFile = 0
      const failingRestoreHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, options) =>
          cmd === "git"
            ? notGitExecResult
            : isBaselineInvocation(options?.env)
              ? greenBaselineResult
              : {
                  _tag: "Exited",
                  exitCode: 1,
                  stdout: "FAIL  libs/sample/domain/test/logic.test.ts\nTests  1 failed (1)\n",
                  stderr: "test failed as expected",
                },
        writeTextSync: (filePath, content) => {
          if (filePath === domainFile) {
            writeCountToDomainFile += 1
            if (writeCountToDomainFile >= 2) {
              throw new Error("EACCES: simulated restore failure")
            }
          }
          testHostIo.writeTextSync(filePath, content)
        },
        renameSync: (oldPath, newPath) => {
          if (newPath === domainFile) {
            throw new Error("EACCES: simulated rename restore failure")
          }
          testHostIo.renameSync(oldPath, newPath)
        },
      }

      const stderrChunks: Array<string> = []
      const origWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
        return true
      }) as typeof process.stderr.write

      try {
        const report = runDomainMutationSuite(repoRoot, failingRestoreHostIo, {
          includeAllLines: true,
        })
        expect(report.passed).toBe(false)
        expect(report.diagnostic).toContain("Failed to restore")
        expect(existsSync(backupPath)).toBe(true)
        expect(stderrChunks.join("")).toContain("Preserving")
      } finally {
        process.stderr.write = origWrite
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-4.3: multi-line Vitest Unhandled Error / Cannot find module or No test files found aborts with passed=false", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      const multilineErrHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, options) =>
          cmd === "git"
            ? notGitExecResult
            : isBaselineInvocation(options?.env)
              ? greenBaselineResult
              : {
                  _tag: "Exited",
                  exitCode: 1,
                  stdout: "",
                  stderr: "⎯⎯⎯ Unhandled Errors ⎯⎯⎯\n\nError: Cannot find module '@missing/pkg'\n",
                },
      }
      const report = runDomainMutationSuite(repoRoot, multilineErrHostIo, { includeAllLines: true })
      expect(report.passed).toBe(false)
      expect(report.killedCount).toBe(0)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("C-1 & T-5: real spawnSync child-process adapter maps Exited cleanly", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      const realSpawnHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (file, _args, options) => {
          if (file === "git") return notGitExecResult
          if (isBaselineInvocation(options?.env)) {
            const baseRes = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
              cwd: options?.cwd,
              encoding: "utf8",
              timeout: options?.timeoutMs,
            })
            return {
              _tag: "Exited",
              exitCode: baseRes.status ?? -1,
              stdout: baseRes.stdout ?? "",
              stderr: baseRes.stderr ?? "",
            }
          }
          const res = spawnSync(
            process.execPath,
            [
              "-e",
              "process.stdout.write('FAIL  libs/sample/domain/test/logic.test.ts\\nTests  1 failed (1)\\n'); process.exit(1)",
            ],
            { cwd: options?.cwd, encoding: "utf8", timeout: options?.timeoutMs },
          )
          if (res.signal !== null) {
            return {
              _tag: "Signaled",
              signal: res.signal,
              stdout: res.stdout ?? "",
              stderr: res.stderr ?? "",
            }
          }
          return {
            _tag: "Exited",
            exitCode: res.status ?? -1,
            stdout: res.stdout ?? "",
            stderr: res.stderr ?? "",
          }
        },
      }
      const realReport = runDomainMutationSuite(repoRoot, realSpawnHostIo, {
        includeAllLines: true,
      })
      expect(realReport.passed).toBe(true)
      expect(realReport.killedCount).toBeGreaterThan(0)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("C-1, M-2, T-5: aborts on SpawnFailed/exitCode=2/exitCode=1 without Vitest failure evidence", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      const cases: ReadonlyArray<{ readonly label: string; readonly res: SyncHostExecResult }> = [
        {
          label: "SpawnFailed ENOENT",
          res: { _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" },
        },
        {
          label: "exitCode 2",
          res: { _tag: "Exited", exitCode: 2, stdout: "", stderr: "vitest crash" },
        },
        {
          label: "exitCode 1 with no failure evidence",
          res: { _tag: "Exited", exitCode: 1, stdout: "", stderr: "unexpected crash" },
        },
      ]

      for (const c of cases) {
        const hostIo: SyncHostIo = {
          ...testHostIo,
          execFileSync: (cmd, _args, options) =>
            cmd === "git"
              ? notGitExecResult
              : isBaselineInvocation(options?.env)
                ? greenBaselineResult
                : c.res,
        }
        const report = runDomainMutationSuite(repoRoot, hostIo, { includeAllLines: true })
        expect(report.passed, c.label).toBe(false)
        expect(report.killedCount, c.label).toBe(0)
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("C-2: fails closed when git diff fails with exitCode 128 or TimedOut", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      const makeGitFailHostIo = (diffRes: SyncHostExecResult): SyncHostIo => ({
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args.includes("rev-parse")) {
            return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
          }
          if (args.includes("diff")) return diffRes
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      })

      const exit128Report = runDomainMutationSuite(
        repoRoot,
        makeGitFailHostIo({
          _tag: "Exited",
          exitCode: 128,
          stdout: "",
          stderr: "fatal: bad object",
        }),
      )
      expect(exit128Report.passed).toBe(false)
      expect(exit128Report.diagnostic).toContain("git diff")

      const timedOutReport = runDomainMutationSuite(
        repoRoot,
        makeGitFailHostIo({ _tag: "TimedOut", stdout: "", stderr: "" }),
      )
      expect(timedOutReport.passed).toBe(false)
      expect(timedOutReport.diagnostic).toContain("timedOut=true")
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("M-1: fails closed on backup unlink failure and refuses to overwrite user-modified file on startup", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, domainFile, backupPath } = setupTempMutationRepo(source)
    try {
      const unlinkFailHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, options) =>
          cmd === "git"
            ? notGitExecResult
            : isBaselineInvocation(options?.env)
              ? greenBaselineResult
              : {
                  _tag: "Exited",
                  exitCode: 1,
                  stdout: "Tests  1 failed (1)\n",
                  stderr: "",
                },
        unlinkSync: (path) => {
          if (path === backupPath) throw new Error("EPERM: unlink denied")
          testHostIo.unlinkSync(path)
        },
      }
      const unlinkReport = runDomainMutationSuite(repoRoot, unlinkFailHostIo, {
        includeAllLines: true,
      })
      expect(unlinkReport.passed).toBe(false)
      expect(unlinkReport.diagnostic).toContain("Failed to unlink")

      // Now simulate user editing the file after a stale backup was left behind
      const userEdited =
        "export const isSame = (a: number, b: number): boolean => a === b && true\n"
      writeFileSync(domainFile, userEdited, "utf8")
      writeFileSync(
        backupPath,
        JSON.stringify({
          filePath: domainFile,
          originalSha256: computeContentSha256(source),
          mutatedSha256: computeContentSha256("mutated"),
          content: source,
        }),
        "utf8",
      )

      const userEditReport = runDomainMutationSuite(repoRoot, testHostIo, { includeAllLines: true })
      expect(userEditReport.passed).toBe(false)
      expect(userEditReport.diagnostic).toContain("refusing to overwrite user edits")
      expect(readFileSync(domainFile, "utf8")).toBe(userEdited)
      expect(existsSync(backupPath)).toBe(true)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("ignores Vitest FAIL breadcrumb test titles containing infra keywords while still aborting on real module load failures", () => {
    const killedBreadcrumb = classifyMutantSubprocessResult(
      "m-breadcrumb",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout:
          " FAIL  libs/demo.test.ts > suite > Tests no tests and ERR_MODULE_NOT_FOUND abort\nTests  1 failed (1)\n",
        stderr: "",
      }),
    )
    expect(killedBreadcrumb).toEqual({ kind: "outcome", status: "killed" })

    const realModuleAbort = classifyMutantSubprocessResult(
      "m-real-module-err",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout:
          " FAIL  suiteB.test.ts [ suiteB.test.ts ]\nTests  1 failed (1)\nError [ERR_MODULE_NOT_FOUND]: Cannot find module\n",
        stderr: "",
      }),
    )
    expect(realModuleAbort.kind).toBe("abort")

    const treeFailBreadcrumb = classifyMutantSubprocessResult(
      "m-tree-breadcrumb",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout:
          " × libs/demo.test.ts > suite > Cannot find module or No test files found\nTests  1 failed (1)\n",
        stderr: "",
      }),
    )
    expect(treeFailBreadcrumb).toEqual({ kind: "outcome", status: "killed" })

    const assertionNoiseKilled = classifyMutantSubprocessResult(
      "m-assertion-noise",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout:
          "Tests  1 failed (1)\nAssertionError: expected \"Cannot find module '@missing/pkg'\" not to be reached\n",
        stderr: "",
      }),
    )
    expect(assertionNoiseKilled).toEqual({ kind: "outcome", status: "killed" })

    const skippedBailTitleKilled = classifyMutantSubprocessResult(
      "m-bail-skipped-title",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout:
          " × libs/demo.test.ts > M-1\n ↓ M-2.3: SyntaxError, Tests no tests, 0 test files, and ERR_MODULE_NOT_FOUND\nTests  1 failed | 1 skipped (2)\n",
        stderr: "",
      }),
    )
    expect(skippedBailTitleKilled).toEqual({ kind: "outcome", status: "killed" })
  })
})

describe("Trustworthy mutation-check & fail-closed migration-check (F-2.1, F-4.1, F-5.2, F-7.1, M-2.1..M-2.3)", () => {
  it("F-2.1: stripAnsi strips CSI/OSC codes and coloured ANSI Vitest output is recognized as killed", () => {
    const colored = "\x1b[31mTests  1 failed\x1b[39m (1)\n"
    expect(stripAnsi(colored)).toBe("Tests  1 failed (1)\n")
    expect(stripAnsi("\x1b]0;vitest\x07ok")).toBe("ok")

    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      const seenEnvs: Array<Readonly<Record<string, string | undefined>> | undefined> = []
      const ansiHostIo: SyncHostIo = {
        ...testHostIo,
        getEnv: () => ({
          ...testHostIo.getEnv(),
          HARNESS_STATE_DIR: "/tmp/leaked-parent-worktree-state",
        }),
        execFileSync: (cmd, _args, options) => {
          if (cmd === "git") return notGitExecResult
          seenEnvs.push(options?.env)
          if (isBaselineInvocation(options?.env)) {
            return greenBaselineResult
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout:
              "\x1b[31m FAIL \x1b[39m libs/sample/domain/test/logic.test.ts\n\x1b[31mTests  1 failed\x1b[39m (1)\n",
            stderr: "",
          }
        },
      }
      const report = runDomainMutationSuite(repoRoot, ansiHostIo, { includeAllLines: true })
      expect(report.passed).toBe(true)
      expect(report.killedCount).toBe(1)
      expect(seenEnvs.length).toBeGreaterThanOrEqual(2)
      expect(seenEnvs[0]?.["NO_COLOR"]).toBe("1")
      expect(seenEnvs[0]?.["FORCE_COLOR"]).toBe("0")
      expect(seenEnvs[0]?.["HARNESS_ACTIVE_MUTANT_ID"]).toBeUndefined()
      expect(seenEnvs[0]?.["HARNESS_STATE_DIR"]).toBeUndefined()
      expect(seenEnvs[1]?.["NO_COLOR"]).toBe("1")
      expect(seenEnvs[1]?.["FORCE_COLOR"]).toBe("0")
      expect(seenEnvs[1]?.["HARNESS_ACTIVE_MUTANT_ID"]).toBeDefined()
      expect(seenEnvs[1]?.["HARNESS_STATE_DIR"]).toBeUndefined()
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("M-2.3 (1): baseline failure aborts before any mutant runs (0 false kills)", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, backupPath } = setupTempMutationRepo(source)
    try {
      let execCalls = 0
      const redBaselineHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd) => {
          if (cmd === "git") return notGitExecResult
          execCalls += 1
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "Tests  1 failed (1)\n",
            stderr: "pre-existing failure",
          }
        },
      }
      const report = runDomainMutationSuite(repoRoot, redBaselineHostIo, { includeAllLines: true })
      expect(report.passed).toBe(false)
      expect(report.killedCount).toBe(0)
      expect(report.diagnostic).toContain("Baseline test suite failed on unmutated file")
      expect(execCalls).toBe(1)
      expect(existsSync(backupPath)).toBe(false)

      // Also verify injected options.testRunner baseline failure aborts before mutants
      let runnerCalls = 0
      const runnerReport = runDomainMutationSuite(repoRoot, testHostIo, {
        includeAllLines: true,
        testRunner: () => {
          runnerCalls += 1
          return "killed"
        },
      })
      expect(runnerReport.passed).toBe(false)
      expect(runnerReport.killedCount).toBe(0)
      expect(runnerReport.diagnostic).toContain("Baseline test suite failed on unmutated file")
      expect(runnerCalls).toBe(1)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("M-2.3 (2): rev-parse SpawnFailed, TimedOut, and exitCode=128 dubious ownership return failed while not-a-git-repo returns not-git", () => {
    const makeRevParseHostIo = (revParseRes: SyncHostExecResult): SyncHostIo => ({
      ...testHostIo,
      execFileSync: (_cmd, args) => {
        if (args.includes("rev-parse")) return revParseRes
        return greenBaselineResult
      },
    })

    const spawnFailed = extractGitDiffModifiedLinesChecked(
      "/tmp/nonexistent",
      makeRevParseHostIo({ _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" }),
    )
    expect(spawnFailed._tag).toBe("Failed")

    const timedOut = extractGitDiffModifiedLinesChecked(
      "/tmp/nonexistent",
      makeRevParseHostIo({ _tag: "TimedOut", stdout: "", stderr: "" }),
    )
    expect(timedOut._tag).toBe("Failed")

    const dubiousOwnership = extractGitDiffModifiedLinesChecked(
      "/tmp/nonexistent",
      makeRevParseHostIo({
        _tag: "Exited",
        exitCode: 128,
        stdout: "",
        stderr: "fatal: detected dubious ownership in repository at '/tmp/nonexistent'",
      }),
    )
    expect(dubiousOwnership._tag).toBe("Failed")

    const notGit = extractGitDiffModifiedLinesChecked(
      "/tmp/nonexistent",
      makeRevParseHostIo({
        _tag: "Exited",
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      }),
    )
    expect(notGit).toEqual({ _tag: "NotGit" })
  })

  it("M-2.3 (3) & (4): Signaled/TimedOut and runner/0-test errors abort and fail closed", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      // Signaled on baseline aborts
      const signaledBaselineHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd) =>
          cmd === "git"
            ? notGitExecResult
            : {
                _tag: "Signaled",
                signal: "SIGKILL",
                stdout: "",
                stderr: "",
              },
      }
      const baselineSignaledReport = runDomainMutationSuite(repoRoot, signaledBaselineHostIo, {
        includeAllLines: true,
      })
      expect(baselineSignaledReport.passed).toBe(false)
      expect(baselineSignaledReport.diagnostic).toContain("signal=SIGKILL")

      // After green baseline, Signaled and TimedOut fail closed (abort)
      const mutantAbortCases: ReadonlyArray<{
        readonly label: string
        readonly res: SyncHostExecResult
        readonly expectedDiag: string
      }> = [
        {
          label: "Signaled SIGKILL",
          res: { _tag: "Signaled", signal: "SIGKILL", stdout: "", stderr: "" },
          expectedDiag: "terminated by signal SIGKILL",
        },
        {
          label: "TimedOut",
          res: { _tag: "TimedOut", stdout: "", stderr: "" },
          expectedDiag: "timed out",
        },
      ]

      for (const c of mutantAbortCases) {
        const hostIo: SyncHostIo = {
          ...testHostIo,
          execFileSync: (cmd, _args, options) =>
            cmd === "git"
              ? notGitExecResult
              : isBaselineInvocation(options?.env)
                ? greenBaselineResult
                : c.res,
        }
        const report = runDomainMutationSuite(repoRoot, hostIo, {
          includeAllLines: true,
          enforcementMode: "strict",
          disableMutantCache: true,
        })
        expect(report.passed, c.label).toBe(false)
        expect(report.killedCount, c.label).toBe(0)
        expect(report.diagnostic, c.label).toContain(c.expectedDiag)
      }

      // Runner/loader errors & 0-test runs fail closed / abort in strict mode
      const abortCases: ReadonlyArray<{
        readonly label: string
        readonly res: SyncHostExecResult
      }> = [
        {
          label: "SyntaxError",
          res: {
            _tag: "Exited",
            exitCode: 1,
            stdout: "",
            stderr: "SyntaxError: Unexpected token '}'",
          },
        },
        {
          label: "Tests no tests",
          res: {
            _tag: "Exited",
            exitCode: 1,
            stdout: " FAIL  libs/demo.test.ts\n      Tests  no tests\n",
            stderr: "",
          },
        },
        {
          label: "0 test files",
          res: {
            _tag: "Exited",
            exitCode: 1,
            stdout: " 0 test files\n",
            stderr: "",
          },
        },
        {
          label: "ERR_MODULE_NOT_FOUND",
          res: {
            _tag: "Exited",
            exitCode: 1,
            stdout: "",
            stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/missing.js'",
          },
        },
      ]

      for (const c of abortCases) {
        const hostIo: SyncHostIo = {
          ...testHostIo,
          execFileSync: (cmd, _args, options) =>
            cmd === "git"
              ? notGitExecResult
              : isBaselineInvocation(options?.env)
                ? greenBaselineResult
                : c.res,
        }
        const report = runDomainMutationSuite(repoRoot, hostIo, {
          includeAllLines: true,
          enforcementMode: "strict",
          disableMutantCache: true,
        })
        expect(report.passed, c.label).toBe(false)
        expect(report.killedCount, c.label).toBe(0)
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("M-2.3 (5): in-run restoreOriginalFile SHA-256 guard refuses to overwrite concurrent external edits", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, domainFile, backupPath } = setupTempMutationRepo(source)
    const externalEdit =
      "export const isSame = (a: number, b: number): boolean => false // user edit\n"
    try {
      const concurrentEditHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, _args, options) => {
          if (cmd === "git") return notGitExecResult
          if (isBaselineInvocation(options?.env)) return greenBaselineResult
          writeFileSync(domainFile, externalEdit, "utf8")
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "Tests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      const report = runDomainMutationSuite(repoRoot, concurrentEditHostIo, {
        includeAllLines: true,
      })
      expect(report.passed).toBe(false)
      expect(report.diagnostic).toContain("modified externally mid-run")
      expect(readFileSync(domainFile, "utf8")).toBe(externalEdit)
      expect(existsSync(backupPath)).toBe(true)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("M-2.3 (6): startup recovery handles mutatedSha256 restore, originalSha256 unlink, and legacy originalSource format", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const mutated = "export const isSame = (a: number, b: number): boolean => a !== b\n"
    const { repoRoot, domainFile, backupPath } = setupTempMutationRepo(source)
    try {
      mkdirSync(join(repoRoot, ".harness"), { recursive: true })

      // Case 1: currentSha256 === mutatedSha256 -> restores original & unlinks backup
      writeFileSync(domainFile, mutated, "utf8")
      writeFileSync(
        backupPath,
        JSON.stringify({
          filePath: domainFile,
          originalSha256: computeContentSha256(source),
          mutatedSha256: computeContentSha256(mutated),
          content: source,
        }),
        "utf8",
      )
      expect(recoverStartupBackup(repoRoot, backupPath, testHostIo)).toBeUndefined()
      expect(readFileSync(domainFile, "utf8")).toBe(source)
      expect(existsSync(backupPath)).toBe(false)

      // Case 2: currentSha256 === originalSha256 -> unlinks backup
      writeFileSync(
        backupPath,
        JSON.stringify({
          filePath: domainFile,
          originalSha256: computeContentSha256(source),
          mutatedSha256: computeContentSha256(mutated),
          content: source,
        }),
        "utf8",
      )
      expect(recoverStartupBackup(repoRoot, backupPath, testHostIo)).toBeUndefined()
      expect(readFileSync(domainFile, "utf8")).toBe(source)
      expect(existsSync(backupPath)).toBe(false)

      // Case 3: legacy backup format (originalSource without content/originalSha256)
      writeFileSync(
        backupPath,
        JSON.stringify({
          filePath: domainFile,
          originalSource: source,
        }),
        "utf8",
      )
      expect(recoverStartupBackup(repoRoot, backupPath, testHostIo)).toBeUndefined()
      expect(readFileSync(domainFile, "utf8")).toBe(source)
      expect(existsSync(backupPath)).toBe(false)

      // Case 4: refuse symlink backupPath and symlink resolvedTarget; atomic write cleans .tmp.*
      writeFileSync(
        backupPath,
        JSON.stringify({ filePath: domainFile, originalSource: source }),
        "utf8",
      )
      const symlinkBackupIo: SyncHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === backupPath ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      const symBackupErr = recoverStartupBackup(repoRoot, backupPath, symlinkBackupIo)
      expect(symBackupErr).toContain("Refusing symlink")
      expect(existsSync(backupPath)).toBe(true)

      const symlinkTargetIo: SyncHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === domainFile ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      const symTargetErr = recoverStartupBackup(repoRoot, backupPath, symlinkTargetIo)
      expect(symTargetErr).toContain("Refusing symlink")
      expect(existsSync(backupPath)).toBe(true)

      expect(recoverStartupBackup(repoRoot, backupPath, testHostIo)).toBeUndefined()
      expect(existsSync(`${domainFile}.tmp.${process.pid}`)).toBe(false)

      // F-15.1: BackupSchema rejects empty/incomplete objects while accepting current & legacy payloads
      expect(Schema.decodeOption(BackupSchema)("{}")._tag).toBe("None")
      expect(
        Schema.decodeOption(BackupSchema)(JSON.stringify({ filePath: "libs/a.ts" }))._tag,
      ).toBe("None")
      expect(Schema.decodeOption(BackupSchema)(JSON.stringify({ content: "x" }))._tag).toBe("None")
      expect(
        Schema.decodeOption(BackupSchema)(JSON.stringify({ filePath: "", content: "x" }))._tag,
      ).toBe("None")
      expect(
        Schema.decodeOption(BackupSchema)(JSON.stringify({ filePath: "libs/a.ts", content: "" }))
          ._tag,
      ).toBe("Some")
      expect(
        Schema.decodeOption(BackupSchema)(
          JSON.stringify({ filePath: "libs/a.ts", originalSource: "x" }),
        )._tag,
      ).toBe("Some")

      writeFileSync(backupPath, "{}", "utf8")
      expect(recoverStartupBackup(repoRoot, backupPath, testHostIo)).toContain(
        "Backup JSON failed schema decoding",
      )
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("F-5.2: checkMigrationFiles fails closed when a migration file is missing or unreadable", () => {
    const missingReport = checkMigrationFiles(["/nonexistent/0001_init.sql"], testHostIo)
    expect(missingReport.safe).toBe(false)
    expect(missingReport.requiresEscalation).toBe(true)
    expect(missingReport.violations).toHaveLength(1)
    expect(missingReport.violations[0]?.kind).toBe("unreadable-migration-file")

    const unreadableHostIo: SyncHostIo = {
      ...testHostIo,
      existsSync: () => true,
      readTextSync: () => {
        throw new Error("EACCES: permission denied")
      },
    }
    const unreadableReport = checkMigrationFiles(["/restricted/0002_alter.sql"], unreadableHostIo)
    expect(unreadableReport.safe).toBe(false)
    expect(unreadableReport.requiresEscalation).toBe(true)
    expect(unreadableReport.violations).toHaveLength(1)
    expect(unreadableReport.violations[0]?.kind).toBe("unreadable-migration-file")
    expect(unreadableReport.violations[0]?.message).toContain("EACCES")
  })

  it("reports explicit untestedFiles and fails closed in strict mode when 0 reaching tests or 0 mutants or empty targetFiles", () => {
    // 1. 0 reaching tests -> untestedFiles reported, strict fails closed
    const noTestsRepo = mkdtempSync(join(tmpdir(), "mut-notests-"))
    try {
      mkdirSync(join(noTestsRepo, "libs", "sample", "domain", "src"), { recursive: true })
      writeFileSync(
        join(noTestsRepo, "libs", "sample", "domain", "src", "logic.ts"),
        "export const isSame = (a: number, b: number): boolean => a === b\n",
        "utf8",
      )
      const report = runDomainMutationSuite(noTestsRepo, testHostIo, {
        includeAllLines: true,
        enforcementMode: "strict",
      })
      expect(report.passed).toBe(false)
      expect(report.untestedFiles).toBeDefined()
      expect(report.untestedFiles?.length).toBeGreaterThan(0)
      expect(report.diagnostic).toContain("0 reaching tests")
    } finally {
      rmSync(noTestsRepo, { recursive: true, force: true })
    }

    // 2. 0 mutants in strict mode (SPEC-0018 REQ-2.2) -> fails closed
    const zeroMutantsRepo = setupTempMutationRepo("export const VERSION = 1\n")
    try {
      const zeroReport = runDomainMutationSuite(zeroMutantsRepo.repoRoot, testHostIo, {
        includeAllLines: true,
        enforcementMode: "strict",
      })
      expect(zeroReport.passed).toBe(false)
      expect(zeroReport.totalMutants).toBe(0)

      // 3. Empty targetFiles -> fails closed
      const emptyTargetReport = runDomainMutationSuite(zeroMutantsRepo.repoRoot, testHostIo, {
        targetFiles: [],
        enforcementMode: "strict",
      })
      expect(emptyTargetReport.passed).toBe(false)
    } finally {
      rmSync(zeroMutantsRepo.repoRoot, { recursive: true, force: true })
    }
  })

  it("isAssertionFailure accepts real AssertionError/ExpectError and rejects arbitrary error prose", () => {
    const assertionErr = new Error("expected 1 to be 2")
    assertionErr.name = "AssertionError"
    expect(isAssertionFailure(assertionErr)).toBe(true)

    const expectErr = new Error("mismatch")
    expectErr.name = "ExpectError"
    expect(isAssertionFailure(expectErr)).toBe(true)

    const proseErr = new Error("Failed toBe connected toEqual database")
    expect(isAssertionFailure(proseErr)).toBe(false)

    expect(isAssertionFailure(Object.assign(new Error("assert"), { code: "ERR_ASSERTION" }))).toBe(
      true,
    )
    expect(isAssertionFailure(Object.assign(new Error("enoent"), { code: "ENOENT" }))).toBe(false)

    const noTestsRes = classifyMutantSubprocessResult(
      "m-no-tests",
      Result.succeed({
        _tag: "Exited",
        exitCode: 1,
        stdout: " FAIL  libs/demo.test.ts\nTests  no tests\n",
        stderr: "",
      }),
    )
    match(noTestsRes)
      .with({ kind: "abort" }, ({ diagnostic }) => {
        expect(diagnostic).toContain("infraFailure=true")
      })
      .with({ kind: "outcome" }, () => {
        expect.unreachable("Expected abort for Tests no tests")
      })
      .exhaustive()
  })

  it("aborts on mixed failed+infra output, baseline 0-passed, out-of-package overlay, and tracks 0-mutant sibling in --strict --all", () => {
    // 1. Mixed Tests 1 failed + Tests no tests / ERR_MODULE_NOT_FOUND / SyntaxError abort
    for (const [label, stdout, stderr] of [
      ["mixed no tests", "Tests  1 failed (1)\nTests  no tests\n", ""],
      [
        "mixed ERR_MODULE_NOT_FOUND",
        "Tests  1 failed (1)\n",
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/missing.js'",
      ],
      ["mixed SyntaxError", "Tests  1 failed (1)\n", "SyntaxError: Unexpected token '}'"],
    ] as const) {
      const res = classifyMutantSubprocessResult(
        label,
        Result.succeed({ _tag: "Exited", exitCode: 1, stdout, stderr }),
      )
      expect(res.kind, label).toBe("abort")
    }

    // 2. baselineExecRes Tests 0 passed aborts
    const { repoRoot } = setupTempMutationRepo(
      "export const isSame = (a: number, b: number): boolean => a === b\n",
    )
    try {
      const zeroBaselineIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd) =>
          cmd === "git"
            ? notGitExecResult
            : {
                _tag: "Exited",
                exitCode: 0,
                stdout: "Tests  0 passed (0)\n",
                stderr: "",
              },
      }
      const zeroBaselineReport = runDomainMutationSuite(repoRoot, zeroBaselineIo, {
        includeAllLines: true,
        enforcementMode: "strict",
      })
      expect(zeroBaselineReport.passed).toBe(false)

      // 3. Overlay outside libs/<scope>/<pkg>/ aborts
      const badOverlayReport = runDomainMutationSuite(repoRoot, testHostIo, {
        enforcementMode: "strict",
        sourceCodeOverlays: { "apps/evil/src/index.ts": "export const x = 1\n" },
      })
      expect(badOverlayReport.passed).toBe(false)

      // 4. --strict --all populates scannedFiles & diffMatchedFiles for 0-mutant contract sibling
      const contractDir = join(repoRoot, "libs", "sample", "contract", "src")
      mkdirSync(contractDir, { recursive: true })
      writeFileSync(
        join(repoRoot, "libs", "sample", "contract", "package.json"),
        JSON.stringify({ name: "@sample/contract", nx: { tags: ["type:contract"] } }),
        "utf8",
      )
      writeFileSync(join(contractDir, "types.ts"), "export const KIND = 'v1'\n", "utf8")
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
              stdout: "libs/sample/contract/src/types.ts\n",
              stderr: "",
            }
          }
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      }
      const allReport = runDomainMutationSuite(repoRoot, mockGitIo, {
        includeAllLines: true,
        enforcementMode: "strict",
        testRunner: (m) => (m.id === "__baseline__" ? "survived" : "killed"),
      })
      expect(allReport.diagnostic).toBeUndefined()
      expect(allReport.passed).toBe(true)
      expect(allReport.scannedFiles).toContain("libs/sample/contract/src/types.ts")
      expect(allReport.diffMatchedFiles).toContain("libs/sample/contract/src/types.ts")
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("does NOT false-abort classifyMutantSubprocessResult or runVitestTargetList baseline on inner [mutation-check] stderr diagnostics when stdout passes", () => {
    const innerDiagStderr =
      "[mutation-check] Runner infrastructure failure for mutant 'm-inner': exitCode=1, infraFailure=true, stderr=Error: Cannot find module '@missing/pkg'\n"
    const subRes = classifyMutantSubprocessResult(
      "m-outer",
      Result.succeed({
        _tag: "Exited",
        exitCode: 0,
        stdout: "Tests  5 passed (5)\n",
        stderr: innerDiagStderr,
      }),
    )
    expect(subRes).toEqual({ kind: "outcome", status: "survived" })

    const { repoRoot, domainFile, backupPath } = setupTempMutationRepo(
      "export const isSame = (a: number, b: number): boolean => a === b\n",
    )
    try {
      const testPath = join(repoRoot, "libs", "sample", "domain", "test", "logic.test.ts")
      const vitestCliPath = join(repoRoot, "node_modules", "vitest", "vitest.mjs")
      mkdirSync(join(repoRoot, "node_modules", "vitest"), { recursive: true })
      writeFileSync(vitestCliPath, "// stub\n", "utf8")

      const originalSource = "export const isSame = (a: number, b: number): boolean => a === b\n"
      const mutatedSource = "export const isSame = (a: number, b: number): boolean => a !== b\n"
      const baselineHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, _args, options) => {
          if (isBaselineInvocation(options?.env)) {
            return {
              _tag: "Exited",
              exitCode: 0,
              stdout: "Tests  5 passed (5)\n",
              stderr: innerDiagStderr,
            }
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "Tests  1 failed (1)\n",
            stderr: "",
          }
        },
      }
      const runRes = runVitestTargetList(
        repoRoot,
        {
          scope: "sample",
          pkgDir: "domain",
          pkgName: "@sample/domain",
          tier: "domain",
          fullPath: domainFile,
          relFile: "libs/sample/domain/src/logic.ts",
        },
        baselineHostIo,
        { NO_COLOR: "1" },
        [testPath],
        originalSource,
        mutatedSource,
        backupPath,
        [
          {
            id: MutantId.make("m-1"),
            file: AstSourceFilePath.make("libs/sample/domain/src/logic.ts"),
            line: SourceLineNumber.make(1),
            category: "equality-operator",
            original: MutantSourceText.make("==="),
            replacement: MutantSourceText.make("!=="),
            mutatedSource: MutantSourceText.make(mutatedSource),
          },
        ],
      )
      match(runRes)
        .with({ _tag: "Ok" }, ({ outcomes }) => {
          expect(outcomes).toHaveLength(1)
          expect(outcomes[0]?.status).toBe("killed")
        })
        .with({ _tag: "Abort" }, ({ diagnostic }) => {
          expect.unreachable(`Expected Ok without false-abort on baseline, got: ${diagnostic}`)
        })
        .exhaustive()
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("preserves partial primary outcomes in aborted report when fallback test suite fails with infra error", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      writeFileSync(
        join(repoRoot, "libs", "sample", "domain", "test", "logic.test.ts"),
        'import { isSame } from "../src/logic.js"\nimport { expect, it } from "vitest"\nit("ok", () => { expect(isSame(1, 1)).toBe(true) })\n',
        "utf8",
      )
      const fallbackTestPath = join(repoRoot, "libs", "sample", "domain", "test", "other.test.ts")
      writeFileSync(
        fallbackTestPath,
        'import { expect, it } from "vitest"\nit("unrelated", () => { expect(1).toBe(1) })\n',
        "utf8",
      )
      writeFileSync(
        join(repoRoot, "libs", "sample", "domain", "test", "other2.test.ts"),
        'import { expect, it } from "vitest"\nit("unrelated2", () => { expect(2).toBe(2) })\n',
        "utf8",
      )
      const fallbackAbortHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (cmd, args, options) => {
          if (cmd === "git") return notGitExecResult
          if (isBaselineInvocation(options?.env)) return greenBaselineResult
          if (args.some((a) => a.includes("other.test.ts"))) {
            return { _tag: "SpawnFailed", spawnError: "fallback-boom", stdout: "", stderr: "" }
          }
          return {
            _tag: "Exited",
            exitCode: 0,
            stdout: "Tests  1 passed (1)\n",
            stderr: "",
          }
        },
      }
      const report = runDomainMutationSuite(repoRoot, fallbackAbortHostIo, {
        includeAllLines: true,
        disableMutantCache: true,
      })
      expect(report.passed).toBe(false)
      expect(report.diagnostic).toContain("fallback-boom")
      expect(report.totalMutants).toBeGreaterThanOrEqual(1)
      expect(report.survivedCount).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("normalizePriorMillis normalizes equivalence priors on the canonical 0..1000 millis scale fail-closed", () => {
    expect(normalizePriorMillis(Number.NaN)).toBe(0)
    expect(normalizePriorMillis(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizePriorMillis(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(normalizePriorMillis(-10)).toBe(0)
    expect(normalizePriorMillis(0)).toBe(0)
    expect(normalizePriorMillis(0.4)).toBe(0)
    expect(normalizePriorMillis(0.85)).toBe(1)
    expect(normalizePriorMillis(1)).toBe(1)
    expect(normalizePriorMillis(1.0)).toBe(1)
    expect(normalizePriorMillis(849.4)).toBe(849)
    expect(normalizePriorMillis(849.6)).toBe(850)
    expect(normalizePriorMillis(850)).toBe(850)
    expect(normalizePriorMillis(1000)).toBe(1000)
    expect(normalizePriorMillis(1500)).toBe(1000)
  })

  it("SPEC-0030 2nd-pass: unlinkBackupChecked and writeMutationBackup fail closed on symlinks and clean up temp files on write/rename failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "mut-backup-2nd-pass-"))
    try {
      const danglingLink = join(dir, "dangling-backup.json")
      symlinkSync("/nonexistent/dangling-target", danglingLink)
      expect(unlinkBackupChecked(danglingLink, testHostIo)).toContain("Refusing symlink")

      const backupDir = join(dir, ".harness", "backups")
      const backupPath = join(backupDir, "unit.backup.json")
      mkdirSync(backupDir, { recursive: true })
      symlinkSync("/nonexistent/sym-dir", join(dir, ".harness", "sym-backup-dir"))
      const symDirErr = writeMutationBackup(
        dir,
        join(dir, ".harness", "sym-backup-dir", "unit.backup.json"),
        "libs/sample/domain/src/logic.ts",
        "export const a = 1",
        "export const a = 2",
        testHostIo,
      )
      expect(symDirErr).toContain("Refusing symlink")

      const writeFailIo: SyncHostIo = {
        ...testHostIo,
        writeTextSync: (p, content) => {
          testHostIo.writeTextSync(p, content)
          throw new Error("disk full during write")
        },
      }
      const writeFailErr = writeMutationBackup(
        dir,
        backupPath,
        "libs/sample/domain/src/logic.ts",
        "export const a = 1",
        "export const a = 2",
        writeFailIo,
      )
      expect(writeFailErr).toContain("disk full during write")
      expect(existsSync(backupPath)).toBe(false)

      const unlinkFailIo: SyncHostIo = {
        ...writeFailIo,
        unlinkSync: () => {
          throw new Error("unlink temp denied")
        },
      }
      const combinedErr = writeMutationBackup(
        dir,
        backupPath,
        "libs/sample/domain/src/logic.ts",
        "export const a = 1",
        "export const a = 2",
        unlinkFailIo,
      )
      expect(combinedErr).toContain("disk full during write")
      expect(combinedErr).toContain("cleanup unlink failed: unlink temp denied")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
