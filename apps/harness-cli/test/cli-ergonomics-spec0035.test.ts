import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReviewDepth } from "@harness/contract"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "@harness/decision"
import { runDeclarativeCli } from "../src/commands/declarative-cli.js"
import {
  runOmnigraphMaintenance,
  runOmnigraphOptimizeAndCleanup,
} from "../src/commands/omnigraph-lint-gate.js"
import { runCli } from "./run-cli-helper.js"

const tempDirs: Array<string> = []

const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe("SPEC-0035 CLI ergonomics, review-route, report --json, plan-check --mermaid, and state_lock_held deduplication", () => {
  it("REQ-5.1: vitest.config.ts clears inherited HARNESS_WORKTREE_ID in test.env", () => {
    expect(process.env.HARNESS_WORKTREE_ID).toBe("")
  })

  it("REQ-6.1: review-route routes --files --json via Harness.routeReviewDiff and enriches manifest tags", async () => {
    const dir = makeTempDir("harness-review-route-files-")
    const pkgDir = join(dir, "libs", "order", "domain", "src")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(dir, "libs", "order", "domain", "package.json"),
      JSON.stringify({ name: "@order/domain", nx: { tags: ["type:domain"] } }),
      "utf8",
    )
    writeFileSync(join(pkgDir, "order-decider.ts"), "export const decide = () => 1\n", "utf8")

    const res = await runCli(
      ["review-route", "--files", "libs/order/domain/src/order-decider.ts", "--json"],
      {
        repoRoot: dir,
        decisionLayer: makeFailingDecisionModelLayer(),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.stderr).toBe("")
    const payload = JSON.parse(res.stdout) as {
      readonly plan: {
        readonly _tag: string
        readonly depth: string
        readonly source: string
        readonly selections: ReadonlyArray<{ readonly reviewer: string }>
      }
      readonly signals: {
        readonly changedFiles: ReadonlyArray<string>
        readonly touchedTiers: ReadonlyArray<string>
      }
    }
    expect(payload.plan._tag).toBe("ActiveReviewPlan")
    expect(payload.plan.source).toBe("degraded-fallback")
    expect(payload.signals.changedFiles).toEqual(["libs/order/domain/src/order-decider.ts"])
    expect(payload.signals.touchedTiers).toContain("type:domain")
    expect(payload.plan.selections.length).toBeGreaterThan(0)
  })

  it("REQ-6.1: review-route supports --base <ref>, model augmentation, --format=text, and clean skip", async () => {
    const dir = makeTempDir("harness-review-route-base-")
    const srcDir = join(dir, "libs", "sample", "contract", "src")
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(
      join(dir, "libs", "sample", "contract", "package.json"),
      JSON.stringify({ name: "@sample/contract", nx: { tags: ["type:contract"] } }),
      "utf8",
    )
    writeFileSync(join(srcDir, "index.ts"), "export const v = 1\n", "utf8")
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" })

    const cleanRes = await runCli(["review-route", "--base", "main", "--json"], {
      repoRoot: dir,
      decisionLayer: makeMockDecisionModelLayer({}),
    })
    expect(cleanRes.exitCode).toBe(0)
    expect(JSON.parse(cleanRes.stdout)).toMatchObject({
      plan: {
        _tag: "SkipReviewPlan",
        depth: "skip",
      },
    })

    writeFileSync(
      join(srcDir, "index.ts"),
      "export const v = 2\nexport const tokenSecret = 'updated'\n",
      "utf8",
    )

    const diffRes = await runCli(["review-route", "--base", "main", "--json"], {
      repoRoot: dir,
      decisionLayer: makeMockDecisionModelLayer({
        reviewDepthLabel: ReviewDepth.make("focused"),
        needsSecurityProb: 0.9,
      }),
    })
    expect(diffRes.exitCode).toBe(0)
    const parsed = JSON.parse(diffRes.stdout) as {
      readonly plan: {
        readonly _tag: string
        readonly depth: string
        readonly selections: ReadonlyArray<{ readonly reviewer: string }>
      }
      readonly signals: {
        readonly changedFiles: ReadonlyArray<string>
        readonly changedLineCount: number
      }
    }
    expect(parsed.plan._tag).toBe("ActiveReviewPlan")
    expect(parsed.signals.changedFiles).toEqual(["libs/sample/contract/src/index.ts"])
    expect(parsed.signals.changedLineCount).toBeGreaterThan(0)
    expect(parsed.plan.selections.some((s) => s.reviewer === "effect-security-reviewer")).toBe(true)

    const textRes = await runCli(["review-route", "--base", "main", "--format=text"], {
      repoRoot: dir,
      decisionLayer: makeMockDecisionModelLayer({
        reviewDepthLabel: ReviewDepth.make("focused"),
        needsSecurityProb: 0.9,
      }),
    })
    expect(textRes.exitCode).toBe(0)
    expect(textRes.stdout).toContain("depth:")
    expect(textRes.stdout).toContain("reviewers:")
  })

  it("REQ-6.1: review-route rejects unsafe paths and invalid --base refs", async () => {
    const dir = makeTempDir("harness-review-route-invalid-")
    const pkgDir = join(dir, "libs", "order", "domain", "src")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, "order-decider.ts"), "export const decide = () => 1\n", "utf8")
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" })

    const badPathRes = await runCli(["review-route", "--files", "../outside.ts", "--json"], {
      repoRoot: dir,
      decisionLayer: makeFailingDecisionModelLayer(),
    })
    expect(badPathRes.exitCode).toBe(1)
    expect(badPathRes.stderr).toContain("Invalid review-route input")

    const badBaseRes = await runCli(["review-route", "--base=-evil", "--json"], {
      repoRoot: dir,
      decisionLayer: makeFailingDecisionModelLayer(),
    })
    expect(badBaseRes.exitCode).toBe(1)
    expect(badBaseRes.stderr).toContain("Invalid --base")

    const spaceFlagBaseRes = await runCli(["review-route", "--base", "-evil", "--json"], {
      repoRoot: dir,
      decisionLayer: makeFailingDecisionModelLayer(),
    })
    expect(spaceFlagBaseRes.exitCode).toBe(1)

    const missingRefWithFilesRes = await runCli(
      [
        "review-route",
        "--files",
        "libs/order/domain/src/order-decider.ts",
        "--base",
        "refs/heads/does-not-exist",
        "--json",
      ],
      {
        repoRoot: dir,
        decisionLayer: makeFailingDecisionModelLayer(),
      },
    )
    expect(missingRefWithFilesRes.exitCode).toBe(1)
    expect(missingRefWithFilesRes.stderr).toContain("Invalid --base")
  })

  it("REQ-6.1: review-route propagates main...HEAD fallback diffBase into changedLineCount and records routing telemetry", async () => {
    const dir = makeTempDir("harness-review-route-fallback-")
    const srcDir = join(dir, "libs", "sample", "contract", "src")
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(
      join(dir, "libs", "sample", "contract", "package.json"),
      JSON.stringify({ name: "@sample/contract", nx: { tags: ["type:contract"] } }),
      "utf8",
    )
    writeFileSync(join(srcDir, "index.ts"), "export const v = 1\n", "utf8")
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["checkout", "-b", "feat/branch-diff"], { cwd: dir, stdio: "ignore" })
    writeFileSync(
      join(srcDir, "index.ts"),
      "export const v = 1\nexport const extra1 = 2\nexport const extra2 = 3\n",
      "utf8",
    )
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "feat change"], { cwd: dir, stdio: "ignore" })

    const res = await runCli(["review-route", "--json"], {
      repoRoot: dir,
      decisionLayer: makeFailingDecisionModelLayer(),
    })
    expect(res.exitCode).toBe(0)
    const parsed = JSON.parse(res.stdout) as {
      readonly signals: {
        readonly changedFiles: ReadonlyArray<string>
        readonly changedLineCount: number
      }
    }
    expect(parsed.signals.changedFiles).toEqual(["libs/sample/contract/src/index.ts"])
    expect(parsed.signals.changedLineCount).toBeGreaterThanOrEqual(2)

    const telemetryLog = readFileSync(join(dir, ".harness", "telemetry-log.jsonl"), "utf8")
    const entries = telemetryLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly toolName: string; readonly category: string })
    expect(entries.some((e) => e.toolName === "review-route" && e.category === "routing")).toBe(
      true,
    )
  })

  it("REQ-6.1: report --json emits valid JSON session report", async () => {
    const dir = makeTempDir("harness-report-json-")
    await runCli(["guard", "pnpm test"], { repoRoot: dir })

    const jsonRes = await runCli(["report", "--json"], { repoRoot: dir })
    expect(jsonRes.exitCode).toBe(0)
    const report = JSON.parse(jsonRes.stdout) as {
      readonly totalEvents: number
      readonly healthScore: number
      readonly grade: string
    }
    expect(report.totalEvents).toBe(1)
    expect(report.healthScore).toBe(100)
    expect(report.grade).toBe("A")

    const mdRes = await runCli(["report", "--format=markdown"], { repoRoot: dir })
    expect(mdRes.exitCode).toBe(0)
    expect(mdRes.stdout).toContain("# ")
    expect(() => JSON.parse(mdRes.stdout)).toThrow()

    const conflictRes = await runCli(["report", "--json", "--format", "markdown"], {
      repoRoot: dir,
    })
    expect(conflictRes.exitCode).toBe(1)
    expect(conflictRes.stderr).toContain("Conflicting flags")

    const invalidFmtRes = await runCli(["report", "--format", "yaml"], { repoRoot: dir })
    expect(invalidFmtRes.exitCode).toBe(1)
    expect(invalidFmtRes.stderr).toContain("Unsupported --format")
  })

  it("REQ-6.1 & REQ-6.2: runDeclarativeCli dispatches review-route (including repeated --files), report --json, and plan-check --mermaid", async () => {
    const dir = makeTempDir("harness-declarative-e2e-")
    const pkgDir = join(dir, "libs", "order", "domain", "src")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(dir, "libs", "order", "domain", "package.json"),
      JSON.stringify({ name: "@order/domain", nx: { tags: ["type:domain"] } }),
      "utf8",
    )
    writeFileSync(
      join(pkgDir, "order-decider.ts"),
      [
        'import { Effect, Schema } from "effect"',
        'export const OrderId = Schema.NonEmptyString.pipe(Schema.brand("OrderId"))',
        'export const fnA = Effect.fn("Order.decideA")(function* () { return OrderId.make("order-1") })',
        "",
      ].join("\n"),
      "utf8",
    )
    writeFileSync(
      join(pkgDir, "order-extra.ts"),
      [
        'import { Effect } from "effect"',
        'import { OrderId } from "./order-decider.js"',
        'export const fnB = Effect.fn("Order.decideB")(function* () { return OrderId.make("order-2") })',
        "",
      ].join("\n"),
      "utf8",
    )

    const envOpts = {
      repoRoot: dir,
      skipBackgroundDaemons: true,
      skipAutoSessionReport: true,
      decisionLayer: makeFailingDecisionModelLayer(),
    }

    const reviewRes = await Effect.runPromise(
      runDeclarativeCli(
        [
          "review-route",
          "--files",
          "libs/order/domain/src/order-decider.ts",
          "--files",
          "libs/order/domain/src/order-extra.ts",
          "--json",
        ],
        envOpts,
      ),
    )
    expect(reviewRes.exitCode).toBe(0)
    const reviewPayload = JSON.parse(reviewRes.stdout) as {
      readonly plan: { readonly _tag: string }
      readonly signals: { readonly changedFiles: ReadonlyArray<string> }
    }
    expect(reviewPayload.plan._tag).toBe("ActiveReviewPlan")
    expect(reviewPayload.signals.changedFiles).toEqual([
      "libs/order/domain/src/order-decider.ts",
      "libs/order/domain/src/order-extra.ts",
    ])

    const reportRes = await Effect.runPromise(runDeclarativeCli(["report", "--json"], envOpts))
    expect(reportRes.exitCode).toBe(0)
    const reportPayload = JSON.parse(reportRes.stdout) as { readonly grade: string }
    expect(reportPayload.grade).toBe("A")

    const reportConflictRes = await Effect.runPromise(
      runDeclarativeCli(["report", "--json", "--format", "markdown"], envOpts),
    )
    expect(reportConflictRes.exitCode).toBe(1)
    expect(reportConflictRes.stderr).toContain("Conflicting flags")

    const planMermaidRes = await Effect.runPromise(
      runDeclarativeCli(["plan-check", "--graph-only", "--mermaid"], envOpts),
    )
    expect(planMermaidRes.stderr).toBe("")
    expect(planMermaidRes.exitCode).toBe(0)
    expect(planMermaidRes.stdout).toContain("flowchart TD")
    expect(planMermaidRes.stdout).toContain("Order.decideA")
  })

  it("REQ-6.2: plan-check emits compact JSON summary (<1 KB) by default and full flowchart with --mermaid", async () => {
    const dir = makeTempDir("harness-plan-compact-")
    const srcDir = join(dir, "libs", "sample", "src")
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(
      join(srcDir, "a.ts"),
      `import { Effect } from "effect"\nexport const fnA = Effect.fn("Sample.fnA")(function* () { return 1 })\n`,
      "utf8",
    )

    const defaultRes = await runCli(["plan-check", "--graph-only"], { repoRoot: dir })
    expect(defaultRes.exitCode).toBe(0)
    expect(defaultRes.stdout.length).toBeLessThan(1024)
    expect(defaultRes.stdout).not.toContain("flowchart TD")
    expect(JSON.parse(defaultRes.stdout)).toMatchObject({
      valid: true,
      snapshotReused: false,
      stubCount: 0,
      mermaidOmitted: true,
    })

    const mermaidRes = await runCli(["plan-check", "--graph-only", "--mermaid"], { repoRoot: dir })
    expect(mermaidRes.exitCode).toBe(0)
    expect(mermaidRes.stdout).toContain("flowchart TD")
    expect(mermaidRes.stdout).toContain("Sample.fnA")
  })

  it("REQ-6.3: runOmnigraphMaintenance and runOmnigraphOptimizeAndCleanup deduplicate [state_lock_held] info lines", () => {
    const dir = makeTempDir("harness-omnigraph-lock-")
    mkdirSync(join(dir, "libs", "harness", "graph"), { recursive: true })
    writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "cluster: test\n", "utf8")
    const clusterDir = join(dir, ".harness", "omnigraph-cluster")
    mkdirSync(clusterDir, { recursive: true })
    const logFile = join(dir, "invocations.log")
    const fakeBin = join(dir, "omnigraph-fake.sh")
    writeFileSync(
      fakeBin,
      [
        "#!/bin/sh",
        `echo "$1" >> ${JSON.stringify(logFile)}`,
        'echo "[state_lock_held] cluster state lock is held" >&2',
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeBin, 0o755)

    const optChunks: Array<string> = []
    const spy1 = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      optChunks.push(String(chunk))
      return true
    })
    try {
      runOmnigraphOptimizeAndCleanup(clusterDir, fakeBin, true)
    } finally {
      spy1.mockRestore()
    }
    const optStderr = optChunks.join("")
    const optMatches = optStderr.match(/\[harness:omnigraph\] Info: skipped offline omnigraph/g)
    expect(optMatches).toHaveLength(1)
    expect(optStderr).toContain(
      "[harness:omnigraph] Info: skipped offline omnigraph (optimize, cleanup) because cluster state lock is held by running omnigraph-server",
    )

    writeFileSync(logFile, "", "utf8")
    const maintChunks: Array<string> = []
    const spy2 = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      maintChunks.push(String(chunk))
      return true
    })
    try {
      runOmnigraphMaintenance(dir, { includeCleanup: true, omnigraphBin: fakeBin })
    } finally {
      spy2.mockRestore()
    }
    const maintStderr = maintChunks.join("")
    const maintMatches = maintStderr.match(/\[harness:omnigraph\] Info: skipped offline omnigraph/g)
    expect(maintMatches).toHaveLength(1)
    expect(maintStderr).toContain(
      "[harness:omnigraph] Info: skipped offline omnigraph (rebuild-full-text-indexes, optimize, cleanup) because cluster state lock is held by running omnigraph-server",
    )
    const invoked = readFileSync(logFile, "utf8").trim().split("\n")
    expect(invoked).toEqual([
      "rebuild-full-text-indexes",
      "rebuild-full-text-indexes",
      "rebuild-full-text-indexes",
      "optimize",
      "cleanup",
    ])

    const stdoutLockBin = join(dir, "omnigraph-stdout-lock.sh")
    writeFileSync(
      stdoutLockBin,
      [
        "#!/bin/sh",
        'echo "unrelated stderr line" >&2',
        'echo "[state_lock_held] cluster state lock is held"',
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    )
    chmodSync(stdoutLockBin, 0o755)
    const stdoutLockChunks: Array<string> = []
    const spy3 = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stdoutLockChunks.push(String(chunk))
      return true
    })
    try {
      runOmnigraphOptimizeAndCleanup(clusterDir, stdoutLockBin, false)
    } finally {
      spy3.mockRestore()
    }
    const stdoutLockStderr = stdoutLockChunks.join("")
    expect(stdoutLockStderr).toContain(
      "[harness:omnigraph] Info: skipped offline omnigraph optimize because cluster state lock is held by running omnigraph-server",
    )
  })
})
