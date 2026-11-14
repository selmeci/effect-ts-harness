import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import type { SyncHostIo } from "@harness/service"
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
          stdout: "",
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
})
