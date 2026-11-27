import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  checkMutateStamp,
  MutantCount,
  MutateStampPassed,
  resolveHarnessStateDir,
  StampRelFilePath,
  writeMutateStamp,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { handleMutate } from "../src/commands/mutate-and-bench.command.js"
import { parseMutateCliFlags } from "../src/commands/mutate-flags.js"
import { evaluateVerifyMutateStampGate } from "../src/commands/mutate-stamp-gate.js"
import { type CliResult, runDeclarativeCli } from "../src/index.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../..")

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const gitCommitAll = (cwd: string, message: string): void => {
  git(cwd, ["add", "-A"])
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message])
}

const initTempGitRepo = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  git(dir, ["init", "-b", "main"])
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.harness\n", "utf8")
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "temp-repo", type: "module" }),
    "utf8",
  )
  symlinkSync(join(REAL_REPO_ROOT, "node_modules"), join(dir, "node_modules"))
  gitCommitAll(dir, "init")
  return dir
}

const writeDemoGatesFile = (dir: string, relSubPath: string, content: string): void => {
  const pkgDir = join(dir, "libs", "demo", "gates")
  const pkgJsonPath = join(pkgDir, "package.json")
  if (!existsSync(pkgJsonPath)) {
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name: "@demo/gates", nx: { tags: ["type:core"] } }),
      "utf8",
    )
  }
  const fullPath = join(pkgDir, relSubPath)
  mkdirSync(join(fullPath, ".."), { recursive: true })
  writeFileSync(fullPath, content, "utf8")
}

const writeValidStamp = (dir: string): string => {
  writeMutateStamp(dir, nodeSyncHostIo, {
    enforcementMode: "strict",
    diffMode: "working-tree",
    scannedCandidateFiles: MutantCount.make(1),
    scannedFiles: [StampRelFilePath.make("libs/demo/gates/src/a.ts")],
    diffMatchedFiles: [StampRelFilePath.make("libs/demo/gates/src/a.ts")],
    evaluatedFiles: [StampRelFilePath.make("libs/demo/gates/src/a.ts")],
    totalMutants: MutantCount.make(1),
    killedCount: MutantCount.make(1),
    survivedCount: MutantCount.make(0),
    equivalentCount: MutantCount.make(0),
    passed: MutateStampPassed.make(true),
  })
  return join(resolveHarnessStateDir(dir, process.env), "mutate-stamp.json")
}

interface ParsedMutateReport {
  readonly passed: boolean
  readonly earlyTerminated?: boolean
  readonly stageAOnly?: boolean
  readonly stackedBaseVerified?: boolean
  readonly stackedBaseRef?: string
  readonly ancestorVerifiedMutantCount?: number
  readonly ancestorExpandedMutantCount?: number
  readonly diffMatchedFiles: ReadonlyArray<string>
  readonly totalMutants: number
  readonly killedCount: number
  readonly survivedCount: number
  readonly evaluatedFiles: ReadonlyArray<string>
  readonly survivedMutants: ReadonlyArray<{
    readonly file: string
    readonly line: number
    readonly original: string
    readonly replacement: string
  }>
}

const setupStackedMainParentFeatRepo = (
  prefix: string,
  parentStrong: boolean,
): { readonly dir: string; readonly stampPath: string } => {
  const dir = initTempGitRepo(prefix)
  git(dir, ["checkout", "-b", "parent"])
  writeDemoGatesFile(dir, "src/a.ts", "export const isParentOk = (n: number): boolean => n >= 10\n")
  writeDemoGatesFile(
    dir,
    "test/a.test.ts",
    [
      'import { expect, it } from "vitest"',
      'import { isParentOk } from "../src/a.js"',
      parentStrong
        ? 'it("kills a", () => { expect(isParentOk(10)).toBe(true); expect(isParentOk(11)).toBe(true); expect(isParentOk(9)).toBe(false) })'
        : 'it("weak a", () => { expect(isParentOk(20)).toBe(true) })',
    ].join("\n"),
  )
  gitCommitAll(dir, "parent adds a.ts")

  git(dir, ["checkout", "-b", "feat"])
  writeDemoGatesFile(dir, "src/b.ts", "export const isFeatOk = (n: number): boolean => n === 42\n")
  writeDemoGatesFile(
    dir,
    "test/b.test.ts",
    [
      'import { expect, it } from "vitest"',
      'import { isFeatOk } from "../src/b.js"',
      'it("kills b", () => { expect(isFeatOk(42)).toBe(true); expect(isFeatOk(41)).toBe(false) })',
    ].join("\n"),
  )
  gitCommitAll(dir, "feat adds b.ts")

  return {
    dir,
    stampPath: join(resolveHarnessStateDir(dir, process.env), "mutate-stamp.json"),
  }
}

describe("SPEC-0034 Area 2 CLI flags, fail-fast, stage-a-only, and stamp prevention", () => {
  const tempDirs: Array<string> = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
  })

  it("parseMutateCliFlags parses valid flags, defaults --fail-fast to maxSurvivors=1, and fails closed on invalid inputs", () => {
    expect(parseMutateCliFlags(["mutate", "--strict", "--fail-fast", "--stage-a-only"])).toEqual({
      _tag: "Ok",
      parsed: {
        isStrict: true,
        isAll: false,
        isDiff: false,
        disableMutantCache: false,
        failFast: true,
        stageAOnly: true,
        survivorsOnly: false,
        scope: undefined,
        targetFiles: undefined,
        baseRef: undefined,
        maxSurvivors: 1,
      },
    })

    expect(
      parseMutateCliFlags([
        "mutate",
        "--fail-fast",
        "--max-survivors=3",
        "--scope=@demo/gates",
        "--file=a.ts, b.ts",
        "--base",
        "main",
        "--all",
        "--diff",
        "--no-cache",
      ]),
    ).toEqual({
      _tag: "Ok",
      parsed: {
        isStrict: false,
        isAll: true,
        isDiff: true,
        disableMutantCache: true,
        failFast: true,
        stageAOnly: false,
        survivorsOnly: false,
        scope: "@demo/gates",
        targetFiles: ["a.ts", "b.ts"],
        baseRef: "main",
        maxSurvivors: 3,
      },
    })

    for (const invalidArgs of [
      ["mutate", "--max-survivors"],
      ["mutate", "--max-survivors="],
      ["mutate", "--max-survivors", "0"],
      ["mutate", "--max-survivors=-1"],
      ["mutate", "--max-survivors=1.5"],
      ["mutate", "--max-survivors=abc"],
      ["mutate", "--max-survivors=01"],
      ["mutate", "--max-survivors=99999999999999999999"],
      ["mutate", "--scope"],
      ["mutate", "--file"],
      ["mutate", "--file= , "],
      ["mutate", "--base"],
      ["mutate", "--base", "-bad"],
      ["mutate", "--failfast"],
      ["mutate", "--unknown"],
      ["mutate", "--help"],
      ["mutate", "-h"],
      ["mutate", "--base", "a", "--base", "b"],
      ["mutate", "--scope=a", "--scope=b"],
      ["mutate", "fail-fast"],
      ["mutate", "mutate"],
    ]) {
      const res = parseMutateCliFlags(invalidArgs)
      expect(res._tag, invalidArgs.join(" ")).toBe("Invalid")
    }
  })

  it("REQ-2.1 & REQ-2.2: --fail-fast and --max-survivors <N> halt early, print exact survivor lines to stderr, exit 1, and delete stale stamp", async () => {
    const dir = initTempGitRepo("cli-spec0034-failfast-")
    tempDirs.push(dir)
    git(dir, ["checkout", "-b", "feat/fail-fast"])

    writeDemoGatesFile(dir, "src/a.ts", "export const isOne = (n: number): boolean => n === 1\n")
    writeDemoGatesFile(
      dir,
      "src/b.ts",
      [
        "export const isAtLeastTen = (n: number): boolean => n >= 10",
        "export const isAtMostZero = (n: number): boolean => n <= 0",
        "",
      ].join("\n"),
    )
    writeDemoGatesFile(dir, "src/c.ts", "export const isAdult = (n: number): boolean => n >= 18\n")
    writeDemoGatesFile(
      dir,
      "test/suite.test.ts",
      [
        'import { expect, it } from "vitest"',
        'import { isOne } from "../src/a.js"',
        'import { isAtLeastTen, isAtMostZero } from "../src/b.js"',
        'import { isAdult } from "../src/c.js"',
        'it("kills a", () => { expect(isOne(1)).toBe(true); expect(isOne(2)).toBe(false) })',
        'it("weak b", () => { expect(isAtLeastTen(20)).toBe(true); expect(isAtMostZero(-5)).toBe(true) })',
        'it("weak c", () => { expect(isAdult(25)).toBe(true) })',
      ].join("\n"),
    )
    gitCommitAll(dir, "add multi-file suite")

    const stampPath = writeValidStamp(dir)
    expect(existsSync(stampPath)).toBe(true)

    const ffDirectStderr: Array<string> = []
    const ffSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      ffDirectStderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    })
    let ffRes: CliResult
    try {
      ffRes = await Effect.runPromise(
        handleMutate(["mutate", "--strict", "--fail-fast"], { repoRoot: dir }),
      )
    } finally {
      ffSpy.mockRestore()
    }
    expect(ffRes.exitCode).toBe(1)
    expect(existsSync(stampPath)).toBe(false)
    const ffReport = JSON.parse(ffRes.stdout) as ParsedMutateReport
    expect(ffReport.passed).toBe(false)
    expect(ffReport.earlyTerminated).toBe(true)
    expect(ffReport.totalMutants).toBe(3)
    expect(ffReport.killedCount).toBe(1)
    expect(ffReport.survivedCount).toBe(2)
    expect(ffReport.survivedMutants.every((m) => m.file !== "libs/demo/gates/src/c.ts")).toBe(true)
    const ffDirectText = ffDirectStderr.join("")
    const ffStderrLines = ffRes.stderr.split("\n")
    for (const m of ffReport.survivedMutants) {
      const line = `${m.file}:${m.line}:${m.original}->${m.replacement}`
      expect(ffDirectText).not.toContain(line)
      expect(ffStderrLines.filter((l) => l === line)).toHaveLength(1)
    }

    writeValidStamp(dir)
    const maxDirectStderr: Array<string> = []
    const maxSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      maxDirectStderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    })
    let maxRes: CliResult
    try {
      maxRes = await Effect.runPromise(
        runDeclarativeCli(["mutate", "--strict", "--max-survivors=2"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
    } finally {
      maxSpy.mockRestore()
    }
    expect(maxRes.exitCode).toBe(1)
    expect(existsSync(stampPath)).toBe(false)
    const maxReport = JSON.parse(maxRes.stdout) as ParsedMutateReport
    expect(maxReport.passed).toBe(false)
    expect(maxReport.earlyTerminated).toBe(true)
    expect(maxReport.totalMutants).toBe(3)
    expect(maxReport.survivedCount).toBe(2)
    expect(maxReport.survivedMutants.every((m) => m.file !== "libs/demo/gates/src/c.ts")).toBe(true)
    const maxDirectText = maxDirectStderr.join("")
    const maxStderrLines = maxRes.stderr.split("\n")
    for (const m of maxReport.survivedMutants) {
      const line = `${m.file}:${m.line}:${m.original}->${m.replacement}`
      expect(maxDirectText).not.toContain(line)
      expect(maxStderrLines.filter((l) => l === line)).toHaveLength(1)
    }
  }, 90_000)

  it("REQ-2.2: invalid --max-survivors (0, -1, abc, bare) fails closed with exitCode 1 and deletes stale stamp via handleMutate and runDeclarativeCli", async () => {
    const dir = initTempGitRepo("cli-spec0034-invalid-max-")
    tempDirs.push(dir)

    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ["mutate", "--max-survivors=0"],
      ["mutate", "--max-survivors=-1"],
      ["mutate", "--max-survivors", "-1"],
      ["mutate", "--max-survivors=abc"],
      ["mutate", "--max-survivors", "abc"],
      ["mutate", "--max-survivors"],
    ]

    for (const args of cases) {
      const stampPath = writeValidStamp(dir)
      expect(existsSync(stampPath), args.join(" ")).toBe(true)

      const directRes = await Effect.runPromise(handleMutate(args, { repoRoot: dir }))
      expect(directRes.exitCode, `handleMutate ${args.join(" ")}`).toBe(1)
      expect(directRes.stderr.length, `handleMutate stderr ${args.join(" ")}`).toBeGreaterThan(0)
      expect(existsSync(stampPath), `handleMutate stamp ${args.join(" ")}`).toBe(false)

      writeValidStamp(dir)
      const cliRes = await Effect.runPromise(
        runDeclarativeCli(args, { repoRoot: dir, skipBackgroundDaemons: true }),
      )
      expect(cliRes.exitCode, `declarative ${args.join(" ")}`).toBe(1)
      expect(cliRes.stderr.length, `declarative stderr ${args.join(" ")}`).toBeGreaterThan(0)
      expect(existsSync(stampPath), `declarative stamp ${args.join(" ")}`).toBe(false)
    }
  })

  it("REQ-2.2: unknown flags (--failfast), duplicate scalar flags (--base/--scope), and unexpected positional args (fail-fast) fail closed in handleMutate and runDeclarativeCli", async () => {
    const dir = initTempGitRepo("cli-spec0034-flag-parity-")
    tempDirs.push(dir)

    const invalidCases: ReadonlyArray<ReadonlyArray<string>> = [
      ["mutate", "--failfast"],
      ["mutate", "--base", "a", "--base", "b"],
      ["mutate", "--scope=x", "--scope=y"],
      ["mutate", "fail-fast"],
      ["mutate", "--unknown", "--help"],
    ]

    for (const args of invalidCases) {
      const stampPath = writeValidStamp(dir)
      expect(existsSync(stampPath), args.join(" ")).toBe(true)

      const directRes = await Effect.runPromise(handleMutate(args, { repoRoot: dir }))
      expect(directRes.exitCode, `handleMutate ${args.join(" ")}`).toBe(1)
      expect(directRes.stderr.length, `handleMutate stderr ${args.join(" ")}`).toBeGreaterThan(0)
      expect(existsSync(stampPath), `handleMutate stamp ${args.join(" ")}`).toBe(false)

      writeValidStamp(dir)
      const cliRes = await Effect.runPromise(
        runDeclarativeCli(args, { repoRoot: dir, skipBackgroundDaemons: true }),
      )
      expect(cliRes.exitCode, `declarative ${args.join(" ")}`).toBe(1)
      expect(cliRes.stderr.length, `declarative stderr ${args.join(" ")}`).toBeGreaterThan(0)
      expect(existsSync(stampPath), `declarative stamp ${args.join(" ")}`).toBe(false)
    }

    const helpRes = await Effect.runPromise(
      runDeclarativeCli(["mutate", "--help"], { repoRoot: dir, skipBackgroundDaemons: true }),
    )
    expect(helpRes.exitCode).toBe(0)
    expect(helpRes.stdout).toContain("--fail-fast")
    expect(helpRes.stdout).toContain("--max-survivors")
    expect(helpRes.stdout).toContain("--stage-a-only")
  })

  it("REQ-2.3 & REQ-2.4: --stage-a-only kills via primary test without running packageFallback test, exits 0, and never writes stamp", async () => {
    const dir = initTempGitRepo("cli-spec0034-stage-a-")
    tempDirs.push(dir)
    git(dir, ["checkout", "-b", "feat/stage-a"])

    writeDemoGatesFile(
      dir,
      "src/engine.ts",
      "export const isAdult = (age: number): boolean => age >= 18\n",
    )
    writeDemoGatesFile(
      dir,
      "test/engine.test.ts",
      [
        'import { expect, it } from "vitest"',
        'import { isAdult } from "../src/engine.js"',
        'it("kills >=", () => { expect(isAdult(18)).toBe(true); expect(isAdult(17)).toBe(false) })',
      ].join("\n"),
    )
    writeDemoGatesFile(
      dir,
      "test/unrelated-a.test.ts",
      'import { expect, it } from "vitest"\nit("ok", () => { expect(1).toBe(1) })\n',
    )
    writeDemoGatesFile(
      dir,
      "test/fallback-boom.test.ts",
      'import { it } from "vitest"\nit("boom", () => { throw new Error("packageFallback must not run under --stage-a-only") })\n',
    )
    gitCommitAll(dir, "add stage-a fixture")

    const stampPath = join(resolveHarnessStateDir(dir, process.env), "mutate-stamp.json")
    const stageARes = await Effect.runPromise(
      runDeclarativeCli(["mutate", "--strict", "--stage-a-only"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(stageARes.exitCode).toBe(0)
    const report = JSON.parse(stageARes.stdout) as ParsedMutateReport
    expect(report.passed).toBe(true)
    expect(report.stageAOnly).toBe(true)
    expect(report.killedCount).toBe(1)
    expect(existsSync(stampPath)).toBe(false)
    expect(stageARes.stderr).toContain(
      "[mutation-check] Notice: .harness/mutate-stamp.json was not written (--stage-a-only).",
    )
  }, 60_000)

  it("REQ-2.4: clean strict --fail-fast writes stamp, while --scope, --stage-a-only, --file, --diff, and unverified --base never write stamp and emit notice", async () => {
    const dir = initTempGitRepo("cli-spec0034-stamp-policy-")
    tempDirs.push(dir)
    git(dir, ["checkout", "-b", "feat/stamp-policy"])

    writeDemoGatesFile(
      dir,
      "src/engine.ts",
      "export const isSame = (a: number, b: number): boolean => a === b\n",
    )
    writeDemoGatesFile(
      dir,
      "test/engine.test.ts",
      [
        'import { expect, it } from "vitest"',
        'import { isSame } from "../src/engine.js"',
        'it("kills ===", () => { expect(isSame(1, 1)).toBe(true); expect(isSame(1, 2)).toBe(false) })',
      ].join("\n"),
    )
    gitCommitAll(dir, "add clean passing gates")

    const stampPath = join(resolveHarnessStateDir(dir, process.env), "mutate-stamp.json")

    const scopeRes = await Effect.runPromise(
      handleMutate(["mutate", "--strict", "--scope=@demo/gates"], { repoRoot: dir }),
    )
    expect(scopeRes.exitCode).toBe(0)
    expect(existsSync(stampPath)).toBe(false)
    expect(scopeRes.stderr).toContain(
      "[mutation-check] Notice: .harness/mutate-stamp.json was not written (--scope).",
    )

    const stageARes = await Effect.runPromise(
      handleMutate(["mutate", "--strict", "--stage-a-only"], { repoRoot: dir }),
    )
    expect(stageARes.exitCode).toBe(0)
    expect(existsSync(stampPath)).toBe(false)
    expect(stageARes.stderr).toContain(
      "[mutation-check] Notice: .harness/mutate-stamp.json was not written (--stage-a-only).",
    )

    const fileRes = await Effect.runPromise(
      handleMutate(["mutate", "--strict", "--file=libs/demo/gates/src/engine.ts"], {
        repoRoot: dir,
      }),
    )
    expect(fileRes.exitCode).toBe(0)
    expect(existsSync(stampPath)).toBe(false)
    expect(fileRes.stderr).toContain(
      "[mutation-check] Notice: .harness/mutate-stamp.json was not written (--file).",
    )

    const diffRes = await Effect.runPromise(
      handleMutate(["mutate", "--strict", "--diff"], { repoRoot: dir }),
    )
    expect(diffRes.exitCode).toBe(0)
    expect(existsSync(stampPath)).toBe(false)
    expect(diffRes.stderr).toContain(
      "[mutation-check] Notice: .harness/mutate-stamp.json was not written (--diff).",
    )

    const unverifiedBaseRes = await Effect.runPromise(
      handleMutate(["mutate", "--strict", "--base=nonexistent-parent"], { repoRoot: dir }),
    )
    expect(unverifiedBaseRes.exitCode).toBe(0)
    expect(existsSync(stampPath)).toBe(false)
    expect(unverifiedBaseRes.stderr).toContain(
      "[mutation-check] Notice: .harness/mutate-stamp.json was not written (unverified --base 'nonexistent-parent').",
    )

    const ffPassRes = await Effect.runPromise(
      runDeclarativeCli(["mutate", "--strict", "--fail-fast"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(ffPassRes.exitCode).toBe(0)
    const ffReport = JSON.parse(ffPassRes.stdout) as ParsedMutateReport
    expect(ffReport.passed).toBe(true)
    expect(ffReport.earlyTerminated).not.toBe(true)
    expect(ffPassRes.stderr).not.toContain("was not written")
    expect(existsSync(stampPath)).toBe(true)
  }, 90_000)

  it("REQ-5.1: stacked --strict --base parent verifies ancestor witness cache, mints stackedBaseRef stamp, and passes verify stamp gate against main", async () => {
    const { dir, stampPath } = setupStackedMainParentFeatRepo("cli-spec0034-stacked-pass-", true)
    tempDirs.push(dir)

    git(dir, ["checkout", "parent"])
    const parentRes = await Effect.runPromise(
      handleMutate(["mutate", "--strict"], { repoRoot: dir }),
    )
    expect(parentRes.exitCode).toBe(0)
    rmSync(stampPath, { force: true })

    git(dir, ["checkout", "feat"])
    const featRes = await Effect.runPromise(
      runDeclarativeCli(["mutate", "--strict", "--base", "parent"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(featRes.exitCode).toBe(0)
    const report = JSON.parse(featRes.stdout) as ParsedMutateReport
    expect(report.passed).toBe(true)
    expect(report.stackedBaseVerified).toBe(true)
    expect(report.stackedBaseRef).toBe("parent")
    expect(report.ancestorVerifiedMutantCount ?? 0).toBeGreaterThan(0)
    expect(report.ancestorExpandedMutantCount).toBe(0)
    expect(report.diffMatchedFiles).toContain("libs/demo/gates/src/a.ts")
    expect(report.diffMatchedFiles).toContain("libs/demo/gates/src/b.ts")
    expect(existsSync(stampPath)).toBe(true)

    const stampInfo = match(
      checkMutateStamp(dir, nodeSyncHostIo, [
        "libs/demo/gates/src/a.ts",
        "libs/demo/gates/src/b.ts",
      ]),
    )
      .with({ _tag: "Valid" }, ({ stamp }) => ({
        valid: true as const,
        stackedBaseRef: stamp.stackedBaseRef,
      }))
      .with({ _tag: "Invalid" }, ({ reason }) => ({ valid: false as const, reason }))
      .exhaustive()
    expect(stampInfo).toEqual({ valid: true, stackedBaseRef: "parent" })

    expect(
      evaluateVerifyMutateStampGate(dir, { repoRoot: dir, mutateStampPolicy: "enforce" }),
    ).toBeUndefined()
  }, 90_000)

  it("REQ-5.2 & REQ-2.4: uncached ancestor survivor expands to ancestor, deletes stale stamp; --base --stage-a-only never writes stamp", async () => {
    // Case A: uncached surviving ancestor mutant expands and deletes stale stamp
    const { dir: failDir, stampPath: failStampPath } = setupStackedMainParentFeatRepo(
      "cli-spec0034-stacked-fail-",
      false,
    )
    tempDirs.push(failDir)
    writeValidStamp(failDir)
    expect(existsSync(failStampPath)).toBe(true)

    const failRes = await Effect.runPromise(
      handleMutate(["mutate", "--strict", "--base", "parent"], { repoRoot: failDir }),
    )
    expect(failRes.exitCode).toBe(1)
    expect(existsSync(failStampPath)).toBe(false)
    const failReport = JSON.parse(failRes.stdout) as ParsedMutateReport
    expect(failReport.passed).toBe(false)
    expect(failReport.stackedBaseVerified).toBe(false)
    expect(failReport.ancestorExpandedMutantCount ?? 0).toBeGreaterThan(0)
    expect(failReport.evaluatedFiles).toContain("libs/demo/gates/src/a.ts")
    expect(failReport.survivedMutants.some((m) => m.file === "libs/demo/gates/src/a.ts")).toBe(true)

    // Case B: --strict --base parent --stage-a-only never writes stamp even when passing
    const { dir: stageADir, stampPath: stageAStampPath } = setupStackedMainParentFeatRepo(
      "cli-spec0034-stacked-stagea-",
      true,
    )
    tempDirs.push(stageADir)
    git(stageADir, ["checkout", "parent"])
    const parentRes = await Effect.runPromise(
      handleMutate(["mutate", "--strict"], { repoRoot: stageADir }),
    )
    expect(parentRes.exitCode).toBe(0)
    rmSync(stageAStampPath, { force: true })

    git(stageADir, ["checkout", "feat"])
    const stageARes = await Effect.runPromise(
      runDeclarativeCli(["mutate", "--strict", "--base", "parent", "--stage-a-only"], {
        repoRoot: stageADir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(stageARes.exitCode).toBe(0)
    const stageAReport = JSON.parse(stageARes.stdout) as ParsedMutateReport
    expect(stageAReport.passed).toBe(true)
    expect(stageAReport.stageAOnly).toBe(true)
    expect(existsSync(stageAStampPath)).toBe(false)
  }, 90_000)
})
