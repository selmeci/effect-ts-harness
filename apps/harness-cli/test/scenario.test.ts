import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { runScenarioCommand } from "../src/commands/scenario.command.js"

const tempDirs: Array<string> = []

const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const seedScenarioWorkspace = (root: string, id: string, title: string): void => {
  const scenarioDir = join(root, "scenarios", id)
  mkdirSync(scenarioDir, { recursive: true })
  writeFileSync(
    join(scenarioDir, "expectations.json"),
    JSON.stringify({
      title,
      checks: [
        {
          id: "has-telemetry",
          type: "count",
          source: "telemetry",
          min: 0,
        },
      ],
    }),
    "utf8",
  )
  writeFileSync(join(scenarioDir, "prompt.md"), `Run scenario ${id}\n`, "utf8")
  writeFileSync(join(scenarioDir, "scenario.md"), "## s1\nStep 1 guide\n", "utf8")
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe("scenario.command behavioral suite (F-7.2)", () => {
  it("supports list (with --filter), start, status, mark, end, and eval in a temp workspace", async () => {
    const tmpDir = makeTempDir("harness-cli-scenario-")
    seedScenarioWorkspace(tmpDir, "alpha-case", "Alpha Scenario")
    seedScenarioWorkspace(tmpDir, "beta-case", "Beta Scenario")

    const transcriptPath = join(tmpDir, "transcript.jsonl")
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), tool: "read_file", args: {} })}\n`,
      "utf8",
    )

    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    const listAll = await Effect.runPromise(runScenarioCommand(["scenario", "list"], opts))
    expect(listAll.exitCode).toBe(0)
    expect(listAll.stdout).toContain("alpha-case")
    expect(listAll.stdout).toContain("beta-case")

    const listFiltered = await Effect.runPromise(
      runScenarioCommand(["scenario", "list", "--filter", "alpha"], opts),
    )
    expect(listFiltered.exitCode).toBe(0)
    expect(listFiltered.stdout).toContain("alpha-case")
    expect(listFiltered.stdout).not.toContain("beta-case")

    const startRes = await Effect.runPromise(
      runScenarioCommand(["scenario", "start", "alpha-case"], opts),
    )
    expect(startRes.exitCode).toBe(0)
    expect(existsSync(join(tmpDir, ".harness", "scenario-runs", "current.json"))).toBe(true)
    expect(existsSync(join(tmpDir, "scenarios"))).toBe(false)

    const statusRes = await Effect.runPromise(runScenarioCommand(["scenario", "status"], opts))
    expect(statusRes.exitCode).toBe(0)
    expect(statusRes.stdout).toContain("Active: alpha-case")

    const markRes = await Effect.runPromise(
      runScenarioCommand(["scenario", "mark", "s1", "started step 1"], opts),
    )
    expect(markRes.exitCode).toBe(0)
    expect(markRes.stdout).toContain("Step 1 guide")

    const endRes = await Effect.runPromise(
      runScenarioCommand(["scenario", "end", "--transcript", transcriptPath], opts),
    )
    expect(endRes.exitCode).toBe(0)
    expect(existsSync(join(tmpDir, "scenarios", "alpha-case", "expectations.json"))).toBe(true)
    expect(existsSync(join(tmpDir, ".harness", "scenario-runs", "current.json"))).toBe(false)

    const evalRes = await Effect.runPromise(runScenarioCommand(["scenario", "eval"], opts))
    expect(evalRes.exitCode).toBe(0)
    expect(evalRes.stdout).toContain("PASS")
  })

  it("rejects invalid scenario id and conversation path traversal with exitCode 1", async () => {
    const tmpDir = makeTempDir("harness-cli-scenario-sec-")
    seedScenarioWorkspace(tmpDir, "valid-case", "Valid")
    const opts = { repoRoot: tmpDir, skipBackgroundDaemons: true }

    const badId = await Effect.runPromise(
      runScenarioCommand(["scenario", "start", "../escape"], opts),
    )
    expect(badId.exitCode).toBe(1)

    const badConv = await Effect.runPromise(
      runScenarioCommand(["scenario", "end", "--conversation=../escape"], opts),
    )
    expect(badConv.exitCode).toBe(1)
  })

  it("resolves git worktree exclude file via git rev-parse and restores scenarios + exclude on failed end", async () => {
    const mainRepo = makeTempDir("harness-cli-wt-main-")
    const worktreeDir = join(makeTempDir("harness-cli-wt-parent-"), "wt")

    execFileSync("git", ["init"], { cwd: mainRepo })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainRepo })
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: mainRepo })
    writeFileSync(join(mainRepo, "README.md"), "init\n", "utf8")
    execFileSync("git", ["add", "README.md"], { cwd: mainRepo })
    execFileSync("git", ["commit", "-m", "init"], { cwd: mainRepo })
    execFileSync("git", ["worktree", "add", "-b", "wt-branch", worktreeDir], { cwd: mainRepo })

    expect(statSync(join(worktreeDir, ".git")).isFile()).toBe(true)

    const gitExcludePath = execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: worktreeDir, encoding: "utf8" },
    ).trim()
    mkdirSync(join(gitExcludePath, ".."), { recursive: true })
    writeFileSync(gitExcludePath, "# initial exclude\n", "utf8")

    seedScenarioWorkspace(worktreeDir, "wt-case", "Worktree Scenario")
    const opts = { repoRoot: worktreeDir, skipBackgroundDaemons: true }

    const startRes = await Effect.runPromise(
      runScenarioCommand(["scenario", "start", "wt-case"], opts),
    )
    expect(startRes.exitCode).toBe(0)
    expect(existsSync(join(worktreeDir, "scenarios"))).toBe(false)
    expect(readFileSync(gitExcludePath, "utf8")).toContain("scenario-runner-hide-start")

    const failedEnd = await Effect.runPromise(
      runScenarioCommand(
        ["scenario", "end", "--transcript", join(worktreeDir, "does-not-exist.jsonl")],
        opts,
      ),
    )
    expect(failedEnd.exitCode).toBe(1)
    expect(existsSync(join(worktreeDir, "scenarios", "wt-case", "expectations.json"))).toBe(true)
    expect(readFileSync(gitExcludePath, "utf8")).not.toContain("scenario-runner-hide-start")
  })
})
