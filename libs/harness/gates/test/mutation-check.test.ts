import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { computeContentSha256 } from "@harness/contract"
import type { SyncHostExecResult, SyncHostIo } from "@harness/service/host-io"
import { checkMigrationFiles } from "../src/migration-check.js"
import { runDomainMutationSuite, stripAnsi } from "../src/mutation-check.js"
import {
  extractGitDiffModifiedLinesChecked,
  recoverStartupBackup,
} from "../src/mutation/mutation-backup.js"
import { testHostIo } from "./helpers/test-host-io.js"

const setupTempMutationRepo = (domainSource: string): {
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
        execFileSync: (_cmd, _args, options) =>
          isBaselineInvocation(options?.env)
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
        execFileSync: () => ({
          _tag: "TimedOut",
          stdout: "",
          stderr: "",
        }),
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
        execFileSync: (_cmd, _args, options) =>
          isBaselineInvocation(options?.env)
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
        execFileSync: (_cmd, _args, options) =>
          isBaselineInvocation(options?.env)
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
        execFileSync: (_cmd, _args, options) =>
          isBaselineInvocation(options?.env)
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
        execFileSync: (_file, _args, options) => {
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
      const realReport = runDomainMutationSuite(repoRoot, realSpawnHostIo, { includeAllLines: true })
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
          execFileSync: (_cmd, _args, options) =>
            isBaselineInvocation(options?.env) ? greenBaselineResult : c.res,
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
          if (args[0] === "rev-parse") {
            return { _tag: "Exited", exitCode: 0, stdout: "true\n", stderr: "" }
          }
          if (args[0] === "diff") return diffRes
          return { _tag: "Exited", exitCode: 0, stdout: "", stderr: "" }
        },
      })

      const exit128Report = runDomainMutationSuite(
        repoRoot,
        makeGitFailHostIo({ _tag: "Exited", exitCode: 128, stdout: "", stderr: "fatal: bad object" }),
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
        execFileSync: (_cmd, _args, options) =>
          isBaselineInvocation(options?.env)
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
      const unlinkReport = runDomainMutationSuite(repoRoot, unlinkFailHostIo, { includeAllLines: true })
      expect(unlinkReport.passed).toBe(false)
      expect(unlinkReport.diagnostic).toContain("Failed to unlink")

      // Now simulate user editing the file after a stale backup was left behind
      const userEdited = "export const isSame = (a: number, b: number): boolean => a === b && true\n"
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
        execFileSync: (_cmd, _args, options) => {
          seenEnvs.push(options?.env)
          if (isBaselineInvocation(options?.env)) {
            return greenBaselineResult
          }
          return {
            _tag: "Exited",
            exitCode: 1,
            stdout: "\x1b[31m FAIL \x1b[39m libs/sample/domain/test/logic.test.ts\n\x1b[31mTests  1 failed\x1b[39m (1)\n",
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
      expect(seenEnvs[1]?.["NO_COLOR"]).toBe("1")
      expect(seenEnvs[1]?.["FORCE_COLOR"]).toBe("0")
      expect(seenEnvs[1]?.["HARNESS_ACTIVE_MUTANT_ID"]).toBeDefined()
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
        execFileSync: () => {
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
        if (args[0] === "rev-parse") return revParseRes
        return greenBaselineResult
      },
    })

    const spawnFailed = extractGitDiffModifiedLinesChecked(
      "/tmp/nonexistent",
      makeRevParseHostIo({ _tag: "SpawnFailed", spawnError: "ENOENT", stdout: "", stderr: "" }),
    )
    expect(spawnFailed.kind).toBe("failed")

    const timedOut = extractGitDiffModifiedLinesChecked(
      "/tmp/nonexistent",
      makeRevParseHostIo({ _tag: "TimedOut", stdout: "", stderr: "" }),
    )
    expect(timedOut.kind).toBe("failed")

    const dubiousOwnership = extractGitDiffModifiedLinesChecked(
      "/tmp/nonexistent",
      makeRevParseHostIo({
        _tag: "Exited",
        exitCode: 128,
        stdout: "",
        stderr: "fatal: detected dubious ownership in repository at '/tmp/nonexistent'",
      }),
    )
    expect(dubiousOwnership.kind).toBe("failed")

    const notGit = extractGitDiffModifiedLinesChecked(
      "/tmp/nonexistent",
      makeRevParseHostIo({
        _tag: "Exited",
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      }),
    )
    expect(notGit).toEqual({ kind: "not-git" })
  })

  it("M-2.3 (3) & (4): Signaled, TimedOut, SyntaxError, and Tests no tests after green baseline count as killed; Signaled on baseline aborts", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      // Signaled on baseline aborts
      const signaledBaselineHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: () => ({
          _tag: "Signaled",
          signal: "SIGKILL",
          stdout: "",
          stderr: "",
        }),
      }
      const baselineSignaledReport = runDomainMutationSuite(repoRoot, signaledBaselineHostIo, {
        includeAllLines: true,
      })
      expect(baselineSignaledReport.passed).toBe(false)
      expect(baselineSignaledReport.diagnostic).toContain("signal=SIGKILL")

      // After green baseline, Signaled, TimedOut, SyntaxError, and Tests no tests count as killed
      const mutantKillCases: ReadonlyArray<{ readonly label: string; readonly res: SyncHostExecResult }> = [
        {
          label: "Signaled SIGKILL",
          res: { _tag: "Signaled", signal: "SIGKILL", stdout: "", stderr: "" },
        },
        {
          label: "TimedOut",
          res: { _tag: "TimedOut", stdout: "", stderr: "" },
        },
        {
          label: "SyntaxError",
          res: { _tag: "Exited", exitCode: 1, stdout: "", stderr: "SyntaxError: Unexpected token '}'" },
        },
        {
          label: "Tests no tests",
          res: {
            _tag: "Exited",
            exitCode: 1,
            stdout: " FAIL  libs/sample/domain/test/logic.test.ts\n      Tests  no tests\n",
            stderr: "",
          },
        },
      ]

      for (const c of mutantKillCases) {
        const hostIo: SyncHostIo = {
          ...testHostIo,
          execFileSync: (_cmd, _args, options) =>
            isBaselineInvocation(options?.env) ? greenBaselineResult : c.res,
        }
        const report = runDomainMutationSuite(repoRoot, hostIo, { includeAllLines: true })
        expect(report.passed, c.label).toBe(true)
        expect(report.killedCount, c.label).toBe(1)
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("M-2.3 (5): in-run restoreOriginalFile SHA-256 guard refuses to overwrite concurrent external edits", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, domainFile, backupPath } = setupTempMutationRepo(source)
    const externalEdit = "export const isSame = (a: number, b: number): boolean => false // user edit\n"
    try {
      const concurrentEditHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_cmd, _args, options) => {
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
      const report = runDomainMutationSuite(repoRoot, concurrentEditHostIo, { includeAllLines: true })
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
})
