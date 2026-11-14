import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import type { SyncHostIo } from "@harness/service/host-io"
import { runDomainMutationSuite } from "../src/mutation-check.js"
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
  writeFileSync(join(testDir, "logic.test.ts"), 'import { expect, it } from "vitest"\nit("ok", () => { expect(1).toBe(1) })\n', "utf8")
  return {
    repoRoot,
    domainFile,
    backupPath: join(repoRoot, ".harness", "mutation-backup.json"),
  }
}

describe("mutation-check infrastructure failure and backup recovery (F-4.3, F-5.1)", () => {
  it("F-4.3: does NOT count spawnError (ENOENT) or timedOut as killed and fails the mutation gate", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot, domainFile } = setupTempMutationRepo(source)
    try {
      const spawnErrorHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: () => ({
          exitCode: -1,
          stdout: "",
          stderr: "",
          spawnError: "ENOENT",
        }),
      }
      const spawnReport = runDomainMutationSuite(repoRoot, spawnErrorHostIo, {
        includeAllLines: true,
      })
      expect(spawnReport.passed).toBe(false)
      expect(spawnReport.killedCount).toBe(0)
      expect(spawnReport.diagnostic).toContain("spawnError=ENOENT")
      expect(readFileSync(domainFile, "utf8")).toBe(source)

      const timeoutHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: () => ({
          exitCode: -1,
          stdout: "",
          stderr: "",
          timedOut: true,
        }),
      }
      const timeoutReport = runDomainMutationSuite(repoRoot, timeoutHostIo, {
        includeAllLines: true,
      })
      expect(timeoutReport.passed).toBe(false)
      expect(timeoutReport.killedCount).toBe(0)
      expect(timeoutReport.diagnostic).toContain("timedOut=true")
      expect(readFileSync(domainFile, "utf8")).toBe(source)

      const pnpmMissingVitestHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: () => ({
          exitCode: 127,
          stdout: "",
          stderr: "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command \"vitest\" not found",
        }),
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
        execFileSync: () => ({
          exitCode: 1,
          stdout: "FAIL  libs/sample/domain/test/logic.test.ts\nTests  1 failed (1)\n",
          stderr: "test failed as expected",
        }),
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
        execFileSync: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "⎯⎯⎯ Unhandled Errors ⎯⎯⎯\n\nError: Cannot find module '@missing/pkg'\n",
        }),
      }
      const report = runDomainMutationSuite(repoRoot, multilineErrHostIo, { includeAllLines: true })
      expect(report.passed).toBe(false)
      expect(report.killedCount).toBe(0)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("C-1 & T-5: real spawnSync child-process adapter and null-signal defense do not falsely abort", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      const realSpawnHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: (_file, _args, options) => {
          const res = spawnSync(
            process.execPath,
            ["-e", "process.stdout.write('FAIL  libs/sample/domain/test/logic.test.ts\\nTests  1 failed (1)\\n'); process.exit(1)"],
            { cwd: options?.cwd, encoding: "utf8", timeout: options?.timeoutMs },
          )
          return {
            exitCode: res.status ?? -1,
            stdout: res.stdout ?? "",
            stderr: res.stderr ?? "",
            signal: res.signal ?? undefined,
            timedOut: res.error?.message.includes("ETIMEDOUT") ?? false,
            spawnError: res.error?.message,
          }
        },
      }
      const realReport = runDomainMutationSuite(repoRoot, realSpawnHostIo, { includeAllLines: true })
      expect(realReport.passed).toBe(true)
      expect(realReport.killedCount).toBeGreaterThan(0)

      const nullSignalHostIo: SyncHostIo = {
        ...testHostIo,
        execFileSync: () => {
          const res: {
            exitCode: number
            stdout: string
            stderr: string
            signal?: string | undefined
          } = {
            exitCode: 1,
            stdout: "Tests  1 failed (1)\n",
            stderr: "",
          }
          Object.defineProperty(res, "signal", { value: null, enumerable: true })
          return res
        },
      }
      const nullSignalReport = runDomainMutationSuite(repoRoot, nullSignalHostIo, { includeAllLines: true })
      expect(nullSignalReport.passed).toBe(true)
      expect(nullSignalReport.killedCount).toBeGreaterThan(0)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("C-1, M-2, T-5: aborts on timedOut/spawnError/signal/exitCode=2/SyntaxError without Vitest failure evidence", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      const cases: ReadonlyArray<{ readonly label: string; readonly res: ReturnType<SyncHostIo["execFileSync"]> }> = [
        { label: "timedOut with exitCode 1", res: { exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "", timedOut: true } },
        { label: "timedOut with exitCode 0", res: { exitCode: 0, stdout: "", stderr: "", timedOut: true } },
        { label: "spawnError ENOENT with exitCode 1", res: { exitCode: 1, stdout: "Tests  1 failed (1)\n", stderr: "", spawnError: "ENOENT" } },
        { label: "signal SIGKILL with exitCode 0", res: { exitCode: 0, stdout: "", stderr: "", signal: "SIGKILL" } },
        { label: "exitCode 2", res: { exitCode: 2, stdout: "", stderr: "vitest crash" } },
        { label: "exitCode 1 with SyntaxError and no Vitest summary", res: { exitCode: 1, stdout: "", stderr: "SyntaxError: Unexpected token '}'" } },
        {
          label: "exitCode 1 with Vitest FAIL banner, SyntaxError, and Tests no tests",
          res: {
            exitCode: 1,
            stdout: " FAIL  libs/sample/domain/test/logic.test.ts\nSyntaxError: Unexpected token '}'\n Test Files  1 failed (1)\n      Tests  no tests\n",
            stderr: "",
          },
        },
      ]

      for (const c of cases) {
        const hostIo: SyncHostIo = { ...testHostIo, execFileSync: () => c.res }
        const report = runDomainMutationSuite(repoRoot, hostIo, { includeAllLines: true })
        expect(report.passed, c.label).toBe(false)
        expect(report.killedCount, c.label).toBe(0)
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it("C-2: fails closed when git diff fails with exitCode 128 or timedOut", () => {
    const source = "export const isSame = (a: number, b: number): boolean => a === b\n"
    const { repoRoot } = setupTempMutationRepo(source)
    try {
      const makeGitFailHostIo = (diffRes: ReturnType<SyncHostIo["execFileSync"]>): SyncHostIo => ({
        ...testHostIo,
        execFileSync: (_cmd, args) => {
          if (args[0] === "rev-parse") return { exitCode: 0, stdout: "true\n", stderr: "" }
          if (args[0] === "diff") return diffRes
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      })

      const exit128Report = runDomainMutationSuite(repoRoot, makeGitFailHostIo({ exitCode: 128, stdout: "", stderr: "fatal: bad object" }))
      expect(exit128Report.passed).toBe(false)
      expect(exit128Report.diagnostic).toContain("git diff")

      const timedOutReport = runDomainMutationSuite(repoRoot, makeGitFailHostIo({ exitCode: -1, stdout: "", stderr: "", timedOut: true }))
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
        execFileSync: () => ({
          exitCode: 1,
          stdout: "Tests  1 failed (1)\n",
          stderr: "",
        }),
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
      const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")
      writeFileSync(
        backupPath,
        JSON.stringify({
          filePath: domainFile,
          originalSha256: sha256(source),
          mutatedSha256: sha256("mutated"),
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
