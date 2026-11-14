import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
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

  it("T-8: recovers orphan _stashed-scenarios without current.json, cleans up on end failure, and handles dual-directory collision", async () => {
    // 1. Orphan _stashed-scenarios without current.json recovered by `scenario end`
    const orphanDir = makeTempDir("harness-cli-scenario-orphan-")
    const stashedOrphan = join(orphanDir, ".harness", "scenario-runs", "_stashed-scenarios", "orphan-case")
    mkdirSync(stashedOrphan, { recursive: true })
    writeFileSync(join(stashedOrphan, "expectations.json"), JSON.stringify({ title: "Orphan", checks: [] }), "utf8")
    const orphanEnd = await Effect.runPromise(
      runScenarioCommand(["scenario", "end"], { repoRoot: orphanDir, skipBackgroundDaemons: true }),
    )
    expect(orphanEnd.exitCode).toBe(1)
    expect(orphanEnd.stderr).toContain("Recovered orphaned _stashed-scenarios")
    expect(existsSync(join(orphanDir, "scenarios", "orphan-case", "expectations.json"))).toBe(true)

    // 2. Failed discovery during `end` removes stale current.json and restores scenarios
    const failedDir = makeTempDir("harness-cli-scenario-fail-end-")
    seedScenarioWorkspace(failedDir, "fail-case", "Fail End")
    const opts = { repoRoot: failedDir, skipBackgroundDaemons: true }
    const startRes = await Effect.runPromise(runScenarioCommand(["scenario", "start", "fail-case"], opts))
    expect(startRes.exitCode).toBe(0)
    expect(existsSync(join(failedDir, ".harness", "scenario-runs", "current.json"))).toBe(true)
    const endErrRes = await Effect.runPromise(
      runScenarioCommand(
        ["scenario", "end", "--transcript", join(failedDir, "missing-transcript.jsonl")],
        opts,
      ),
    )
    expect(endErrRes.exitCode).toBe(1)
    expect(existsSync(join(failedDir, ".harness", "scenario-runs", "current.json"))).toBe(false)
    expect(existsSync(join(failedDir, "scenarios", "fail-case", "expectations.json"))).toBe(true)

    // 3. Dual _stashed-scenarios + scenarios/ collision: restores missing files, refuses to clobber
    const dualDir = makeTempDir("harness-cli-scenario-dual-")
    seedScenarioWorkspace(dualDir, "existing-case", "Existing")
    const dualStashed = join(dualDir, ".harness", "scenario-runs", "_stashed-scenarios")
    mkdirSync(join(dualStashed, "missing-case"), { recursive: true })
    writeFileSync(
      join(dualStashed, "missing-case", "expectations.json"),
      JSON.stringify({ title: "Missing", checks: [] }),
      "utf8",
    )
    mkdirSync(join(dualStashed, "existing-case"), { recursive: true })
    writeFileSync(join(dualStashed, "existing-case", "prompt.md"), "STASHED OVERWRITE\n", "utf8")

    const dualList = await Effect.runPromise(
      runScenarioCommand(["scenario", "list"], { repoRoot: dualDir, skipBackgroundDaemons: true }),
    )
    expect(dualList.exitCode).toBe(1)
    expect(dualList.stderr).toContain("Scenario restore collision")
    // Missing file was restored, existing file was NOT clobbered
    expect(existsSync(join(dualDir, "scenarios", "missing-case", "expectations.json"))).toBe(true)
    expect(readFileSync(join(dualDir, "scenarios", "existing-case", "prompt.md"), "utf8")).toBe(
      "Run scenario existing-case\n",
    )

    // 4. Rejects --transcript traversal outside repoRoot while run is active, then defect mid-handleEnd still restores scenarios/ via Effect.ensuring
    const defectDir = makeTempDir("harness-cli-scenario-defect-")
    seedScenarioWorkspace(defectDir, "defect-case", "Defect End")
    const defectOpts = { repoRoot: defectDir, skipBackgroundDaemons: true }
    const defectStart = await Effect.runPromise(
      runScenarioCommand(["scenario", "start", "defect-case"], defectOpts),
    )
    expect(defectStart.exitCode).toBe(0)
    expect(existsSync(join(defectDir, "scenarios"))).toBe(false)

    const escapeTranscript = await Effect.runPromise(
      runScenarioCommand(["scenario", "end", "--transcript", "../../etc/passwd"], defectOpts),
    )
    expect(escapeTranscript.exitCode).toBe(1)
    expect(escapeTranscript.stderr).toContain("escapes repository root")
    expect(existsSync(join(defectDir, "scenarios", "defect-case", "expectations.json"))).toBe(true)

    // Re-start to test unexpected defect mid-handleEnd
    const defectRestart = await Effect.runPromise(
      runScenarioCommand(["scenario", "start", "defect-case"], defectOpts),
    )
    expect(defectRestart.exitCode).toBe(0)
    expect(existsSync(join(defectDir, "scenarios"))).toBe(false)

    // Make transcript path a directory so readTextSync throws EISDIR defect mid-handleEnd
    const badTranscriptDir = join(defectDir, "dir-as-transcript.jsonl")
    mkdirSync(badTranscriptDir, { recursive: true })
    const defectExit = await Effect.runPromiseExit(
      runScenarioCommand(["scenario", "end", "--transcript", "dir-as-transcript.jsonl"], defectOpts),
    )
    match(defectExit)
      .with({ _tag: "Success" }, () => {
        expect.fail("Expected defectExit to fail with a defect")
      })
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(Cause.hasDies(cause)).toBe(true)
      })
      .exhaustive()
    expect(existsSync(join(defectDir, ".harness", "scenario-runs", "current.json"))).toBe(false)
    expect(existsSync(join(defectDir, "scenarios", "defect-case", "expectations.json"))).toBe(true)
  })
})
