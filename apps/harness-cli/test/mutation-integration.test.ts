import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runDomainMutationSuite } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"

const REPO_ROOT = resolve(import.meta.dirname, "../../..")

describe("T-5 + C-1: real runDomainMutationSuite integration with nodeSyncHostIo", () => {
  const tempDirs: Array<string> = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it("kills a real mutant in a temp domain package and restores the original file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "harness-mutation-t5-"))
    tempDirs.push(tmpDir)

    const srcDir = join(tmpDir, "libs", "demo", "domain", "src")
    const testDir = join(tmpDir, "libs", "demo", "domain", "test")
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(testDir, { recursive: true })

    // Share workspace node_modules so `pnpm vitest run` executes without network install
    symlinkSync(join(REPO_ROOT, "node_modules"), join(tmpDir, "node_modules"), "dir")
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "mutation-t5-tmp", private: true, type: "module" }),
      "utf8",
    )

    const domainFile = join(srcDir, "index.ts")
    const originalSource = [
      "export const checkFlag = (ok: boolean): boolean => {",
      '  if (!ok) throw new Error("invalid")',
      "  return true",
      "}",
      "",
    ].join("\n")
    writeFileSync(domainFile, originalSource, "utf8")

    writeFileSync(
      join(testDir, "index.test.ts"),
      [
        'import { describe, expect, it } from "vitest"',
        'import { checkFlag } from "../src/index.js"',
        'describe("checkFlag", () => {',
        '  it("returns true when ok", () => {',
        "    expect(checkFlag(true)).toBe(true)",
        "  })",
        "})",
      ].join("\n"),
      "utf8",
    )

    const prevCi = process.env["CI"]
    delete process.env["CI"]
    let report: ReturnType<typeof runDomainMutationSuite>
    try {
      report = runDomainMutationSuite(tmpDir, nodeSyncHostIo, {
        includeAllLines: true,
      })
    } finally {
      if (prevCi !== undefined) {
        process.env["CI"] = prevCi
      }
    }

    expect(report.totalMutants).toBe(1)
    expect(report.killedCount).toBe(1)
    expect(report.survivedCount).toBe(0)
    expect(report.passed).toBe(true)
    expect(readFileSync(domainFile, "utf8")).toBe(originalSource)
  }, 30_000)

  it("F-2.1: succeeds cleanly when FORCE_COLOR=3 is set in process.env", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "harness-mutation-f21-"))
    tempDirs.push(tmpDir)

    const srcDir = join(tmpDir, "libs", "demo", "domain", "src")
    const testDir = join(tmpDir, "libs", "demo", "domain", "test")
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(testDir, { recursive: true })

    symlinkSync(join(REPO_ROOT, "node_modules"), join(tmpDir, "node_modules"), "dir")
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "mutation-f21-tmp", private: true, type: "module" }),
      "utf8",
    )

    const domainFile = join(srcDir, "index.ts")
    const originalSource = [
      "export const checkFlag = (ok: boolean): boolean => {",
      '  if (!ok) throw new Error("invalid")',
      "  return true",
      "}",
      "",
    ].join("\n")
    writeFileSync(domainFile, originalSource, "utf8")

    writeFileSync(
      join(testDir, "index.test.ts"),
      [
        'import { describe, expect, it } from "vitest"',
        'import { checkFlag } from "../src/index.js"',
        'describe("checkFlag", () => {',
        '  it("returns true when ok", () => {',
        "    expect(checkFlag(true)).toBe(true)",
        "  })",
        "})",
      ].join("\n"),
      "utf8",
    )

    const prevCi = process.env["CI"]
    const prevForceColor = process.env["FORCE_COLOR"]
    delete process.env["CI"]
    process.env["FORCE_COLOR"] = "3"
    let report: ReturnType<typeof runDomainMutationSuite>
    try {
      report = runDomainMutationSuite(tmpDir, nodeSyncHostIo, {
        includeAllLines: true,
      })
    } finally {
      if (prevCi !== undefined) {
        process.env["CI"] = prevCi
      }
      if (prevForceColor === undefined) {
        delete process.env["FORCE_COLOR"]
      } else {
        process.env["FORCE_COLOR"] = prevForceColor
      }
    }

    expect(report.totalMutants).toBe(1)
    expect(report.killedCount).toBe(1)
    expect(report.survivedCount).toBe(0)
    expect(report.passed).toBe(true)
    expect(readFileSync(domainFile, "utf8")).toBe(originalSource)
  }, 30_000)
})
