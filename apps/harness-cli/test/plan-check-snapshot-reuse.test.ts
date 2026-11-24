import { execFileSync } from "node:child_process"
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
import { Effect } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it } from "vitest"
import { readTelemetryEvents, writeVerifyStamp } from "@harness/gates"
import {
  extractWorkspaceTypeAwareGraph,
  resolveGitHeadState,
  saveGraphSnapshot,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { tryLoadReusableVerifiedPlanSnapshot } from "../src/commands/plan-snapshot-fastpath.js"
import { runCli } from "./run-cli-helper.js"

const tempDirs: Array<string> = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

const createVerifiedGitWorkspace = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  const srcDir = join(dir, "libs", "sample", "src")
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(
    join(srcDir, "a.ts"),
    `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.fnA")(function* () { return 1 })\n`,
    "utf8",
  )
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" })
  return dir
}

const seedVerifiedSnapshot = async (dir: string): Promise<void> => {
  const verifyRes = await runCli(["verify"], { repoRoot: dir, skipSubprocessVerify: true })
  expect(verifyRes.exitCode).toBe(0)
}

const addBrokenPackageJson = (dir: string): void => {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "broken-nx-trigger", scripts: { nx: "exit 1" } }),
    "utf8",
  )
  execFileSync("git", ["add", "package.json"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "add package.json"], { cwd: dir, stdio: "ignore" })
}

describe("plan-check verified snapshot reuse (SPEC-0033 REQ-2.4)", () => {
  it("reuses verified snapshot with 0 stubs, skips nx subprocess, emits telemetry, and skips plan snapshot under --graph-only", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-hit-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    const directHit = await Effect.runPromise(
      tryLoadReusableVerifiedPlanSnapshot(dir, false, nodeSyncHostIo),
    )
    expect(directHit._tag).toBe("Hit")
    const directStubMiss = await Effect.runPromise(
      tryLoadReusableVerifiedPlanSnapshot(dir, true, nodeSyncHostIo),
    )
    expect(directStubMiss).toEqual({ _tag: "Miss", reason: "active-stubs" })

    const graphOnlyRes = await runCli(["plan-check", "--graph-only"], { repoRoot: dir })
    expect(graphOnlyRes.exitCode).toBe(0)
    expect(graphOnlyRes.stdout).toContain("flowchart TD")
    expect(graphOnlyRes.stdout).toContain("Sample.fnA")
    expect(existsSync(join(dir, ".harness", "plan-graph-snapshot.json"))).toBe(false)

    const res = await runCli(["plan-check"], { repoRoot: dir })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain("flowchart TD")
    expect(res.stdout).toContain("Sample.fnA")
    expect(existsSync(join(dir, ".harness", "plan-graph-snapshot.json"))).toBe(true)

    const events = readTelemetryEvents(dir, nodeSyncHostIo)
    expect(
      events.some(
        (e) =>
          e.toolName === "omnigraph:sync-plan" &&
          e.outcome === "ok" &&
          e.detail === "reused-verified-snapshot",
      ),
    ).toBe(true)
  })

  it("falls back to full path when source file is edited (treeHash mismatch)", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-edit-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    writeFileSync(
      join(dir, "libs", "sample", "src", "a.ts"),
      `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.fnA")(function* () { return 2 })\n`,
      "utf8",
    )
    const res = await runCli(["plan-check"], { repoRoot: dir })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("[GATE FAILURE] plan-check:subprocess")
  })

  it("falls back to full path on new git commit (HEAD change)", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-commit-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    writeFileSync(join(dir, "README.md"), "new commit\n", "utf8")
    execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "advance head"], { cwd: dir, stdio: "ignore" })
    const res = await runCli(["plan-check"], { repoRoot: dir })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("[GATE FAILURE] plan-check:subprocess")
  })

  it("falls back to full path on branch switch (gitBranch mismatch)", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-branch-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    execFileSync("git", ["checkout", "-b", "feat/other"], { cwd: dir, stdio: "ignore" })
    const res = await runCli(["plan-check"], { repoRoot: dir })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("[GATE FAILURE] plan-check:subprocess")
  })

  it("falls back to full path when workspace has an active stub()", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-stub-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    writeFileSync(
      join(dir, "libs", "sample", "src", "b.ts"),
      `import { Effect } from "effect"\nimport { stub } from "@harness/contract"\nexport const fnB = Effect.fn("Sample.fnB")(function* () { return yield* stub<number, never, never>() })\n`,
      "utf8",
    )
    const res = await runCli(["plan-check"], { repoRoot: dir })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("[GATE FAILURE] plan-check:subprocess")
  })

  it("falls back to full path on corrupt, symlinked, or missing graph-snapshot.json", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-snap-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    const snapshotPath = join(dir, ".harness", "graph-snapshot.json")
    writeFileSync(snapshotPath, "{corrupt-json", "utf8")
    const corruptRes = await runCli(["plan-check"], { repoRoot: dir })
    expect(corruptRes.exitCode).toBe(1)
    expect(corruptRes.stderr).toContain("[GATE FAILURE] plan-check:subprocess")

    writeVerifyStamp(dir, nodeSyncHostIo)
    const directCorruptMiss = await Effect.runPromise(
      tryLoadReusableVerifiedPlanSnapshot(dir, false, nodeSyncHostIo),
    )
    expect(directCorruptMiss).toEqual({ _tag: "Miss", reason: "corrupt-snapshot" })

    const target = join(dir, "outside.json")
    writeFileSync(target, "{}", "utf8")
    rmSync(snapshotPath, { force: true })
    symlinkSync(target, snapshotPath)
    const symlinkRes = await runCli(["plan-check"], { repoRoot: dir })
    expect(symlinkRes.exitCode).toBe(1)
    expect(symlinkRes.stderr).toContain("[GATE FAILURE] plan-check:subprocess")

    rmSync(snapshotPath, { force: true })
    const missingRes = await runCli(["plan-check"], { repoRoot: dir })
    expect(missingRes.exitCode).toBe(1)
    expect(missingRes.stderr).toContain("[GATE FAILURE] plan-check:subprocess")
  })

  it("falls back to full path when HARNESS_STATE_DIR or HARNESS_WORKTREE_ID is set", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-env-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    const prevStateDir = process.env.HARNESS_STATE_DIR
    const prevWorktreeId = process.env.HARNESS_WORKTREE_ID
    try {
      process.env.HARNESS_STATE_DIR = ".custom-harness"
      const customDirRes = await runCli(["plan-check"], { repoRoot: dir })
      expect(customDirRes.exitCode).toBe(1)
      expect(customDirRes.stderr).toContain("[GATE FAILURE] plan-check:subprocess")

      Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      process.env.HARNESS_WORKTREE_ID = "wt-1"
      const wtRes = await runCli(["plan-check"], { repoRoot: dir })
      expect(wtRes.exitCode).toBe(1)
      expect(wtRes.stderr).toContain("[GATE FAILURE] plan-check:subprocess")
    } finally {
      if (prevStateDir === undefined) Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      else process.env.HARNESS_STATE_DIR = prevStateDir
      if (prevWorktreeId === undefined) Reflect.deleteProperty(process.env, "HARNESS_WORKTREE_ID")
      else process.env.HARNESS_WORKTREE_ID = prevWorktreeId
    }
  })

  it("still fails [dead-tagged-error] and duplicate span checks even when verified snapshot would hit", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-gates-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    const deadErrRes = await runCli(["plan-check", "--graph-only"], {
      repoRoot: dir,
      governanceDocs: [
        {
          docPath: "docs/spec.md",
          id: "spec-001",
          status: "accepted" as const,
          referencedErrors: ["MissingTaggedError"],
        },
      ],
    })
    expect(deadErrRes.exitCode).toBe(1)
    expect(deadErrRes.stdout).toContain("[dead-tagged-error]")

    writeFileSync(
      join(dir, "libs", "sample", "src", "dup.ts"),
      `import { Effect } from "effect"\nexport const fnDup = Effect.fn("Sample.fnA")(function* () { return 9 })\n`,
      "utf8",
    )
    const dupRes = await runCli(["plan-check"], { repoRoot: dir })
    expect(dupRes.exitCode).toBe(1)
    expect(dupRes.stderr).toContain("Duplicate span names found: Sample.fnA")
  })

  it("falls back when graph-snapshot.json is modified after writeVerifyStamp (snapshot-hash-mismatch)", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-sha-mismatch-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    const snapshotPath = join(dir, ".harness", "graph-snapshot.json")
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>
    writeFileSync(snapshotPath, JSON.stringify({ ...parsed, mutatedAfterStamp: true }), "utf8")

    const miss = await Effect.runPromise(
      tryLoadReusableVerifiedPlanSnapshot(dir, false, nodeSyncHostIo),
    )
    expect(miss).toEqual({ _tag: "Miss", reason: "snapshot-hash-mismatch" })

    const res = await runCli(["plan-check"], { repoRoot: dir })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("[GATE FAILURE] plan-check:subprocess")
  })

  it("reuses verified snapshot in non-isolated workspace without contacting Omnigraph", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-nonisolated-")
    mkdirSync(join(dir, "libs", "harness", "graph"), { recursive: true })
    writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "cluster: test\n", "utf8")
    execFileSync("git", ["add", "libs/harness/graph/cluster.yaml"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "add cluster.yaml"], { cwd: dir, stdio: "ignore" })

    const graph = await Effect.runPromise(extractWorkspaceTypeAwareGraph(dir, nodeSyncHostIo))
    saveGraphSnapshot(graph, join(dir, ".harness", "graph-snapshot.json"), nodeSyncHostIo)
    const head = resolveGitHeadState(dir, nodeSyncHostIo)
    writeFileSync(
      join(dir, ".harness", "graph-head.json"),
      JSON.stringify({ ...head, updatedAt: new Date().toISOString() }),
      "utf8",
    )
    writeVerifyStamp(dir, nodeSyncHostIo)

    const prevOmnigraphUrl = process.env.OMNIGRAPH_URL
    try {
      process.env.OMNIGRAPH_URL = "http://127.0.0.1:1"
      const res = await runCli(["plan-check"], { repoRoot: dir, skipBackgroundDaemons: true })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain("flowchart TD")
      expect(res.stdout).toContain("Sample.fnA")
    } finally {
      if (prevOmnigraphUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevOmnigraphUrl
    }
  })

  it("falls back when verified graph-snapshot.json contains isStub: true even with matching hash", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-snap-stubs-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    const snapshotPath = join(dir, ".harness", "graph-snapshot.json")
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      nodes: Array<Record<string, unknown>>
      [key: string]: unknown
    }
    const stubbedNodes = parsed.nodes.map((entry) =>
      match(entry)
        .with({ _tag: "EffectFn" }, (val) => ({ ...val, isStub: true }))
        .otherwise(() => entry),
    )
    writeFileSync(snapshotPath, JSON.stringify({ ...parsed, nodes: stubbedNodes }), "utf8")
    writeVerifyStamp(dir, nodeSyncHostIo)

    const miss = await Effect.runPromise(
      tryLoadReusableVerifiedPlanSnapshot(dir, false, nodeSyncHostIo),
    )
    expect(miss).toEqual({ _tag: "Miss", reason: "snapshot-has-stubs" })

    const res = await runCli(["plan-check"], { repoRoot: dir })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("[GATE FAILURE] plan-check:subprocess")
  })

  it("falls back on symlinked .harness/graph-head.json", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-sym-head-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    const outsideDir = mkdtempSync(join(tmpdir(), "harness-outside-head-"))
    tempDirs.push(outsideDir)
    const headMetaPath = join(dir, ".harness", "graph-head.json")
    const outsideHead = join(outsideDir, "outside-head.json")
    writeFileSync(outsideHead, readFileSync(headMetaPath, "utf8"), "utf8")
    rmSync(headMetaPath, { force: true })
    symlinkSync(outsideHead, headMetaPath)

    const miss = await Effect.runPromise(
      tryLoadReusableVerifiedPlanSnapshot(dir, false, nodeSyncHostIo),
    )
    expect(miss).toEqual({ _tag: "Miss", reason: "unsafe-or-missing-head-meta" })

    const res = await runCli(["plan-check"], { repoRoot: dir })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("[GATE FAILURE] plan-check:subprocess")
  })

  it("fails closed when .harness/plan-graph-snapshot.json is a symlink on non-graph-only reuse", async () => {
    const dir = createVerifiedGitWorkspace("harness-plan-reuse-sym-plan-")
    addBrokenPackageJson(dir)
    await seedVerifiedSnapshot(dir)

    const outsideDir = mkdtempSync(join(tmpdir(), "harness-outside-plan-"))
    tempDirs.push(outsideDir)
    const outsidePlan = join(outsideDir, "outside-plan.json")
    writeFileSync(outsidePlan, "{}", "utf8")
    symlinkSync(outsidePlan, join(dir, ".harness", "plan-graph-snapshot.json"))

    const res = await runCli(["plan-check"], { repoRoot: dir })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("[GATE FAILURE] plan-check:snapshot-write")
  })
})
