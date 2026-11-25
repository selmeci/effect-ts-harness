import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { resolveNxAffectedArgs } from "../src/commands/daemon-and-omnigraph.service.js"
import { handleGuard } from "../src/commands/guard-and-route.command.js"
import {
  DEFAULT_VERIFY_MAX_PARALLEL,
  MAX_VERIFY_PARALLEL_CAP,
  resolveVerifyParallelCap,
  resolveVitestMaxWorkers,
} from "../src/commands/repo-path.js"
import { handleVerify } from "../src/commands/verify-and-done.command.js"
import { verifyFailureWithThrashing } from "../src/commands/verify-doc-fastpath.js"

const tempDirs: Array<string> = []
const originalEnv = process.env["HARNESS_VERIFY_PARALLEL"]
const originalOllamaUrl = process.env["HARNESS_OLLAMA_URL"]

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env["HARNESS_VERIFY_PARALLEL"]
  } else {
    process.env["HARNESS_VERIFY_PARALLEL"] = originalEnv
  }
  if (originalOllamaUrl === undefined) {
    delete process.env["HARNESS_OLLAMA_URL"]
  } else {
    process.env["HARNESS_OLLAMA_URL"] = originalOllamaUrl
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

const initTempRepo = (branchName: string, commits: number): string => {
  const dir = mkdtempSync(join(tmpdir(), "harness-nx-parallel-"))
  tempDirs.push(dir)
  execFileSync("git", ["init", "-b", branchName], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, encoding: "utf8" })
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(dir, `file-${String(i)}.txt`), `commit ${String(i)}\n`, "utf8")
    execFileSync("git", ["add", `file-${String(i)}.txt`], { cwd: dir, encoding: "utf8" })
    execFileSync("git", ["commit", "-m", `commit ${String(i)}`], { cwd: dir, encoding: "utf8" })
  }
  return dir
}

describe("resolveVerifyParallelCap", () => {
  it("exports expected default and maximum parallel caps", () => {
    expect(DEFAULT_VERIFY_MAX_PARALLEL).toBe(4)
    expect(MAX_VERIFY_PARALLEL_CAP).toBe(32)
  })

  it("caps cpuCount at DEFAULT_VERIFY_MAX_PARALLEL when env is unset", () => {
    expect(resolveVerifyParallelCap({}, 1)).toBe(1)
    expect(resolveVerifyParallelCap({}, 2)).toBe(2)
    expect(resolveVerifyParallelCap({}, 3)).toBe(3)
    expect(resolveVerifyParallelCap({}, 4)).toBe(4)
    expect(resolveVerifyParallelCap({}, 5)).toBe(4)
    expect(resolveVerifyParallelCap({}, 16)).toBe(4)
    expect(resolveVerifyParallelCap({}, 2.9)).toBe(2)
  })

  it("normalizes non-finite or <1 cpuCount to 1", () => {
    expect(resolveVerifyParallelCap({}, 0)).toBe(1)
    expect(resolveVerifyParallelCap({}, -1)).toBe(1)
    expect(resolveVerifyParallelCap({}, 0.5)).toBe(1)
    expect(resolveVerifyParallelCap({}, Number.NaN)).toBe(1)
    expect(resolveVerifyParallelCap({}, Number.POSITIVE_INFINITY)).toBe(1)
    expect(resolveVerifyParallelCap({}, Number.NEGATIVE_INFINITY)).toBe(1)
  })

  it("honors valid HARNESS_VERIFY_PARALLEL values and clamps to MAX_VERIFY_PARALLEL_CAP", () => {
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "1" }, 8)).toBe(1)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "6" }, 2)).toBe(6)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: " 8 " }, 2)).toBe(8)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "32" }, 2)).toBe(32)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "33" }, 2)).toBe(32)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "999" }, 2)).toBe(32)
  })

  it("falls back to capped cpuCount for invalid or unsafe HARNESS_VERIFY_PARALLEL values", () => {
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "0" }, 3)).toBe(3)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "-3" }, 3)).toBe(3)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "4.5" }, 3)).toBe(3)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "abc" }, 3)).toBe(3)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "04" }, 3)).toBe(3)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "" }, 3)).toBe(3)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "   " }, 3)).toBe(3)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: "99999999999999999999" }, 3)).toBe(3)
    expect(resolveVerifyParallelCap({ HARNESS_VERIFY_PARALLEL: undefined }, 3)).toBe(3)
  })

  it("uses process.env and availableParallelism by default", () => {
    process.env["HARNESS_VERIFY_PARALLEL"] = "5"
    expect(resolveVerifyParallelCap()).toBe(5)
  })
})

describe("resolveNxAffectedArgs", () => {
  it("appends --parallel when targets include verify across all branches", () => {
    process.env["HARNESS_VERIFY_PARALLEL"] = "6"

    const mainRepo = initTempRepo("main", 1)
    expect(resolveNxAffectedArgs(mainRepo, ["verify"], ["a.ts", "b.ts"])).toEqual([
      "nx",
      "affected",
      "--files=a.ts,b.ts",
      "-t",
      "verify",
      "--parallel=6",
    ])
    expect(resolveNxAffectedArgs(mainRepo, ["verify"], [])).toEqual([
      "nx",
      "affected",
      "--base=main",
      "-t",
      "verify",
      "--parallel=6",
    ])
    expect(resolveNxAffectedArgs(mainRepo, ["verify"])).toEqual([
      "nx",
      "affected",
      "--base=main",
      "-t",
      "verify",
      "--parallel=6",
    ])

    const headRepo = initTempRepo("feature", 2)
    expect(resolveNxAffectedArgs(headRepo, ["verify"])).toEqual([
      "nx",
      "affected",
      "--base=HEAD~1",
      "-t",
      "verify",
      "--parallel=6",
    ])

    const singleCommitRepo = initTempRepo("orphan", 1)
    expect(resolveNxAffectedArgs(singleCommitRepo, ["verify"])).toEqual([
      "nx",
      "run-many",
      "-t",
      "verify",
      "--parallel=6",
    ])
  })

  it("omits --parallel when targets do not include verify", () => {
    process.env["HARNESS_VERIFY_PARALLEL"] = "6"

    const mainRepo = initTempRepo("main", 1)
    expect(resolveNxAffectedArgs(mainRepo, ["typecheck", "lint"], ["a.ts"])).toEqual([
      "nx",
      "affected",
      "--files=a.ts",
      "-t",
      "typecheck",
      "lint",
    ])
    expect(resolveNxAffectedArgs(mainRepo, ["typecheck", "lint"])).toEqual([
      "nx",
      "affected",
      "--base=main",
      "-t",
      "typecheck",
      "lint",
    ])

    const headRepo = initTempRepo("feature", 2)
    expect(resolveNxAffectedArgs(headRepo, ["typecheck", "lint"])).toEqual([
      "nx",
      "affected",
      "--base=HEAD~1",
      "-t",
      "typecheck",
      "lint",
    ])

    const singleCommitRepo = initTempRepo("orphan", 1)
    expect(resolveNxAffectedArgs(singleCommitRepo, ["typecheck", "lint"])).toEqual([
      "nx",
      "run-many",
      "-t",
      "typecheck",
      "lint",
    ])
  })
})

describe("verifyFailureWithThrashing and VITEST_MAX_WORKERS", () => {
  it("preserves telemetryDetail across both exitCode 1 and thrashing exitCode 2 escalation", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-thrash-detail-"))
    tempDirs.push(dir)
    const detailMsg =
      "[triage:mechanical] timeout-contention — Test timed out under parallel Nx load"

    const first = verifyFailureWithThrashing(
      { repoRoot: dir },
      dir,
      "verify:mechanical",
      "Test timed out in 5000ms",
      "Test timed out in 5000ms",
      detailMsg,
    )
    expect(first.exitCode).toBe(1)
    expect(first.telemetryDetail).toBe(detailMsg)

    verifyFailureWithThrashing(
      { repoRoot: dir },
      dir,
      "verify:mechanical",
      "Test timed out in 5000ms",
      "Test timed out in 5000ms",
      detailMsg,
    )
    const third = verifyFailureWithThrashing(
      { repoRoot: dir },
      dir,
      "verify:mechanical",
      "Test timed out in 5000ms",
      "Test timed out in 5000ms",
      detailMsg,
    )
    expect(third.exitCode).toBe(2)
    expect(third.telemetryDetail).toBe(detailMsg)
  })

  it("computes VITEST_MAX_WORKERS via resolveVitestMaxWorkers and forwards it plus timeout-contention telemetryDetail from handleVerify", async () => {
    expect(resolveVitestMaxWorkers({}, 4, 16)).toBe("4")
    expect(resolveVitestMaxWorkers({}, 8, 4)).toBe("1")
    expect(resolveVitestMaxWorkers({ VITEST_MAX_WORKERS: " 3 " }, 4, 16)).toBe("3")
    expect(resolveVitestMaxWorkers({ VITEST_MAX_WORKERS: "" }, 4, 16)).toBe("4")
    expect(resolveVitestMaxWorkers({ VITEST_MAX_WORKERS: "abc" }, 4, 16)).toBe("4")

    const dir = mkdtempSync(join(tmpdir(), "harness-verify-workers-"))
    tempDirs.push(dir)
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "verify-workers-fixture" }))

    process.env["HARNESS_VERIFY_PARALLEL"] = "2"
    let capturedWorkers: string | undefined
    const origExecFileSync = nodeSyncHostIo.execFileSync.bind(nodeSyncHostIo)
    const execSpy = vi
      .spyOn(nodeSyncHostIo, "execFileSync")
      .mockImplementation((cmd, args, opts) => {
        if (cmd === "pnpm") {
          capturedWorkers = opts?.env?.["VITEST_MAX_WORKERS"]
          return {
            _tag: "Exited" as const,
            exitCode: 1,
            stdout: "",
            stderr: "FAIL  test/slow.test.ts\nError: Test timed out in 5000ms",
          }
        }
        return origExecFileSync(cmd, args, opts)
      })

    try {
      const verifyResult = await Effect.runPromise(
        handleVerify({
          repoRoot: dir,
          decisionLayer: makeMockDecisionModelLayer({ triageKind: "mechanical" }),
        }),
      )
      expect(verifyResult.exitCode).toBe(1)
      expect(capturedWorkers).toMatch(/^[1-9]\d*$/)
      expect(verifyResult.telemetryDetail).toContain("timeout-contention")
    } finally {
      execSpy.mockRestore()
    }
  })
})

describe("guard-and-route Ollama readiness short-circuit", () => {
  it("short-circuits immediately to ask without waiting 2500ms when Ollama probe fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-guard-ollama-"))
    tempDirs.push(dir)
    process.env["HARNESS_OLLAMA_URL"] = "http://127.0.0.1:1"

    const startedAt = Date.now()
    const result = await Effect.runPromise(
      handleGuard(["guard", "--format=antigravity"], {
        repoRoot: dir,
        stdin: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "npm run custom-unknown-script" },
          },
        }),
      }),
    )
    const elapsedMs = Date.now() - startedAt

    expect(elapsedMs).toBeLessThan(2000)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ask")
    expect(result.stdout).toContain("DecisionModel unavailable (Ollama readiness probe failed)")
  })
})
