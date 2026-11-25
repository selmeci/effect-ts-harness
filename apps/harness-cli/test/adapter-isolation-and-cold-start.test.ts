import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveHarnessStateDir } from "@harness/gates/hook-fastpath"
import {
  CLI_REPO_ROOT,
  recordTelemetry,
  shouldSuppressLiveRepoTestSideEffects,
} from "../src/commands/daemon-and-omnigraph.service.js"

describe("Adapter cold-start & test side-effect isolation", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..")

  it("never loads typescript on guard --format=antigravity cold start", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "harness-guard-cold-state-"))
    try {
      const res = spawnSync(
        process.execPath,
        [
          "--import",
          "./tools/node-ts-resolver.mjs",
          "apps/harness-cli/src/index.ts",
          "guard",
          "--format=antigravity",
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            HARNESS_STATE_DIR: stateDir,
            NODE_DEBUG: "module",
          },
          input: JSON.stringify({
            toolCall: { name: "run_command", args: { CommandLine: "git status" } },
          }),
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        },
      )
      expect(res.status).toBe(0)
      expect(JSON.parse(res.stdout.trim())).toEqual({ decision: "allow" })
      expect(res.stderr).not.toContain("node_modules/typescript")
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it("shouldSuppressLiveRepoTestSideEffects protects CLI_REPO_ROOT while preserving temp repoRoot telemetry writes", async () => {
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, { HARNESS_DISABLE_LIVE_TELEMETRY: "1" }),
    ).toBe(true)
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, { HARNESS_TEST_ISOLATION: "1" }),
    ).toBe(true)
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {
        HARNESS_DISABLE_LIVE_TELEMETRY: "1",
        HARNESS_STATE_DIR: "/tmp/custom-state",
      }),
    ).toBe(false)

    const tempRepo = mkdtempSync(join(tmpdir(), "harness-telemetry-isolation-"))
    try {
      expect(
        shouldSuppressLiveRepoTestSideEffects(tempRepo, { HARNESS_DISABLE_LIVE_TELEMETRY: "1" }),
      ).toBe(false)
      recordTelemetry(
        { repoRoot: tempRepo },
        {
          surface: "cli",
          category: "guard",
          toolName: "guard",
          outcome: "ok",
          durationMs: 1,
        },
      )
      const { recordFriction } = await import("../src/commands/daemon-and-omnigraph.service.js")
      const liveFrictionPath = join(CLI_REPO_ROOT, ".harness", "friction-log.jsonl")
      const beforeLiveFriction = existsSync(liveFrictionPath)
        ? readFileSync(liveFrictionPath, "utf8")
        : undefined
      const prevDisable = process.env.HARNESS_DISABLE_LIVE_TELEMETRY
      const prevStateDir = process.env.HARNESS_STATE_DIR
      process.env.HARNESS_DISABLE_LIVE_TELEMETRY = "1"
      Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      try {
        recordFriction(
          { repoRoot: CLI_REPO_ROOT },
          { kind: "route_miss", summary: "suppressed-test", detail: "should-not-write" },
        )
        const afterLiveFriction = existsSync(liveFrictionPath)
          ? readFileSync(liveFrictionPath, "utf8")
          : undefined
        expect(afterLiveFriction).toBe(beforeLiveFriction)
      } finally {
        if (prevDisable === undefined)
          Reflect.deleteProperty(process.env, "HARNESS_DISABLE_LIVE_TELEMETRY")
        else process.env.HARNESS_DISABLE_LIVE_TELEMETRY = prevDisable
        if (prevStateDir !== undefined) process.env.HARNESS_STATE_DIR = prevStateDir
      }

      recordFriction(
        { repoRoot: tempRepo },
        {
          kind: "route_miss",
          summary: "temp-friction",
          detail: "should-write",
        },
      )
      expect(
        existsSync(join(resolveHarnessStateDir(tempRepo, process.env), "telemetry-log.jsonl")),
      ).toBe(true)
      expect(
        existsSync(join(resolveHarnessStateDir(tempRepo, process.env), "friction-log.jsonl")),
      ).toBe(true)
    } finally {
      rmSync(tempRepo, { recursive: true, force: true })
    }
  })

  it("S-7.2b: HARNESS_TEST_ISOLATION=1 suppresses CLI_REPO_ROOT side effects unless HARNESS_STATE_DIR is set or repoRoot is temp", () => {
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, { HARNESS_TEST_ISOLATION: "1" }),
    ).toBe(true)
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {
        HARNESS_TEST_ISOLATION: "1",
        HARNESS_STATE_DIR: "",
      }),
    ).toBe(true)
    expect(
      shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {
        HARNESS_TEST_ISOLATION: "1",
        HARNESS_STATE_DIR: "/tmp/custom-state",
      }),
    ).toBe(false)
    expect(shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, { VITEST: "true" })).toBe(true)
    expect(
      shouldSuppressLiveRepoTestSideEffects(join(CLI_REPO_ROOT, "apps", "harness-mcp"), {
        VITEST: "true",
      }),
    ).toBe(true)
    expect(shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, { NODE_ENV: "test" })).toBe(true)
    expect(shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {})).toBe(false)

    const tempRepo = mkdtempSync(join(tmpdir(), "harness-test-isolation-"))
    try {
      expect(shouldSuppressLiveRepoTestSideEffects(tempRepo, { HARNESS_TEST_ISOLATION: "1" })).toBe(
        false,
      )
      expect(
        shouldSuppressLiveRepoTestSideEffects(CLI_REPO_ROOT, {
          HARNESS_TEST_ISOLATION: "1",
          HARNESS_STATE_DIR: "   ",
        }),
      ).toBe(true)
    } finally {
      rmSync(tempRepo, { recursive: true, force: true })
    }
  })

  it("REQ-4.1: writeDoneSessionReport, tryCachePreInvocationResult, and handleReport suppress writes to CLI_REPO_ROOT and invalid HARNESS_STATE_DIR does not throw", async () => {
    const { Effect } = await import("effect")
    const { writeDoneSessionReport } = await import("../src/commands/mutate-and-bench.command.js")
    const { tryCachePreInvocationResult } = await import("../src/commands/session-fastpath.js")
    const { handleReport, handleSession } =
      await import("../src/commands/session-learn-report.command.js")

    const liveHarnessDir = join(CLI_REPO_ROOT, ".harness")
    const watchedFiles = [
      join(liveHarnessDir, "session-report.json"),
      join(liveHarnessDir, "session-report.md"),
      join(liveHarnessDir, "session-preinvocation-cache.json"),
      join(liveHarnessDir, "last-done.json"),
    ]
    const beforeContents = watchedFiles.map((p) =>
      existsSync(p) ? readFileSync(p, "utf8") : undefined,
    )

    const prevDisable = process.env.HARNESS_DISABLE_LIVE_TELEMETRY
    const prevStateDir = process.env.HARNESS_STATE_DIR
    process.env.HARNESS_DISABLE_LIVE_TELEMETRY = "1"
    Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
    try {
      writeDoneSessionReport(CLI_REPO_ROOT)
      tryCachePreInvocationResult(CLI_REPO_ROOT, liveHarnessDir, true, false, [], "", {
        repoRoot: CLI_REPO_ROOT,
        skipBackgroundDaemons: true,
      })
      const reportRes = await Effect.runPromise(
        handleReport(["--format=json"], { repoRoot: CLI_REPO_ROOT }),
      )
      expect(reportRes.exitCode).toBe(0)

      watchedFiles.forEach((p, idx) => {
        const after = existsSync(p) ? readFileSync(p, "utf8") : undefined
        expect(after).toBe(beforeContents[idx])
      })

      // Invalid HARNESS_STATE_DIR ("." and whitespace) must never crash session/report handlers
      const tempRepo = mkdtempSync(join(tmpdir(), "harness-invalid-state-dir-"))
      try {
        writeFileSync(join(tempRepo, "tsconfig.base.json"), '{"compilerOptions":{}}\n', "utf8")
        for (const badStateDir of [".", "   "]) {
          process.env.HARNESS_STATE_DIR = badStateDir
          const sessionRes = await Effect.runPromise(
            handleSession(["--format=antigravity"], {
              repoRoot: tempRepo,
              skipBackgroundDaemons: true,
            }),
          )
          expect(sessionRes.exitCode).toBe(0)
          const rptRes = await Effect.runPromise(
            handleReport(["--format=json"], { repoRoot: tempRepo }),
          )
          expect(rptRes.exitCode).toBe(0)
        }
      } finally {
        rmSync(tempRepo, { recursive: true, force: true })
      }
    } finally {
      if (prevDisable === undefined)
        Reflect.deleteProperty(process.env, "HARNESS_DISABLE_LIVE_TELEMETRY")
      else process.env.HARNESS_DISABLE_LIVE_TELEMETRY = prevDisable
      if (prevStateDir === undefined) Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      else process.env.HARNESS_STATE_DIR = prevStateDir
    }

    // Importing @harness/infra/hook-fastpath with whitespace HARNESS_STATE_DIR must not throw at module load
    const hookLoadOut = execFileSync(
      process.execPath,
      [
        "--import",
        join(CLI_REPO_ROOT, "tools/node-ts-resolver.mjs"),
        "--input-type=module",
        "-e",
        'await import("@harness/infra/hook-fastpath"); process.stdout.write("INFRA_HOOK_OK");',
      ],
      {
        cwd: CLI_REPO_ROOT,
        env: { ...process.env, HARNESS_STATE_DIR: "   " },
        encoding: "utf8",
      },
    )
    expect(hookLoadOut).toContain("INFRA_HOOK_OK")
  })
})
