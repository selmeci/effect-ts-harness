import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeMockDecisionModelLayer } from "@harness/decision"
import { DstSeed, writeVerifyStamp } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { runDeclarativeCli } from "../src/commands/declarative-cli.js"
import { hasDoneCliFlag, normalizeDoneResultForCli } from "../src/commands/done-cli-helper.js"
import type { CliResult } from "../src/commands/hook-format.js"
import { handleDone } from "../src/commands/verify-and-done.command.js"

const tempDirs: Array<string> = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

const createTempGitRepo = (prefix: string): string => {
  const rawDir = mkdtempSync(join(tmpdir(), prefix))
  const dir = realpathSync.native(rawDir)
  tempDirs.push(dir)
  mkdirSync(join(dir, "libs", "demo", "src"), { recursive: true })
  writeFileSync(join(dir, "libs", "demo", "src", "mod.ts"), "export const v = 1\n", "utf8")
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["add", "."], { cwd: dir, encoding: "utf8" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8" })
  return dir
}

interface MockStdinStream extends EventEmitter {
  isTTY: boolean
  paused: boolean
  resumed: boolean
  pause: () => void
  resume: () => void
}

const createMockStdin = (isTTY: boolean): MockStdinStream => {
  const emitter = new EventEmitter() as MockStdinStream
  emitter.isTTY = isTTY
  emitter.paused = false
  emitter.resumed = false
  emitter.pause = () => {
    emitter.paused = true
  }
  emitter.resume = () => {
    emitter.resumed = true
  }
  return emitter
}

const withMockedStdin = async <A>(mockStdin: MockStdinStream, fn: () => Promise<A>): Promise<A> => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: mockStdin,
  })
  try {
    return await fn()
  } finally {
    if (originalDescriptor !== undefined) {
      Object.defineProperty(process, "stdin", originalDescriptor)
    }
  }
}

describe("done-cli-helper & done --cli mode", () => {
  it("hasDoneCliFlag detects --cli accurately and rejects falsy or post-terminator forms", () => {
    expect(hasDoneCliFlag(["done", "--cli"])).toBe(true)
    expect(hasDoneCliFlag(["--cli"])).toBe(true)
    expect(hasDoneCliFlag(["done", "--cli=true"])).toBe(true)
    expect(hasDoneCliFlag(["done", "--cli=TRUE"])).toBe(true)
    expect(hasDoneCliFlag(["done", "--cli=yes"])).toBe(true)
    expect(hasDoneCliFlag(["done", "--cli=on"])).toBe(true)
    expect(hasDoneCliFlag(["done", "--cli=1"])).toBe(true)
    expect(hasDoneCliFlag(["done", "--cli", "true"])).toBe(true)
    expect(hasDoneCliFlag(["done", "--cli", "--format=antigravity"])).toBe(true)
    expect(hasDoneCliFlag(["done", "--format=antigravity"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--format", "--cli"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--cli=false"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--cli=no"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--cli=off"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--cli=0"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--no-cli"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--cli", "false"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--cli", "FALSE"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--cli", "no"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--cli", "off"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--cli", "0"])).toBe(false)
    expect(hasDoneCliFlag(["done", "--", "--cli"])).toBe(false)
    expect(hasDoneCliFlag([])).toBe(false)
  })

  it("normalizeDoneResultForCli preserves Stop-hook results when isCliMode=false and normalizes block/continue when isCliMode=true", () => {
    const blockZero: CliResult = {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: "stamp missing" }),
      stderr: "",
    }
    expect(normalizeDoneResultForCli(blockZero, false)).toBe(blockZero)
    expect(normalizeDoneResultForCli(blockZero, true)).toEqual({
      exitCode: 1,
      stdout: blockZero.stdout,
      stderr: "stamp missing",
    })

    const continueZero: CliResult = {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "continue", reason: "graph diff failed" }),
      stderr: "",
    }
    expect(normalizeDoneResultForCli(continueZero, true)).toEqual({
      exitCode: 1,
      stdout: continueZero.stdout,
      stderr: "graph diff failed",
    })

    const fallbackReason: CliResult = {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: 123 }),
      stderr: "   ",
    }
    expect(normalizeDoneResultForCli(fallbackReason, true)).toEqual({
      exitCode: 1,
      stdout: fallbackReason.stdout,
      stderr: "done: blocked",
    })

    const whitespaceReason: CliResult = {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason: "   " }),
      stderr: "",
    }
    expect(normalizeDoneResultForCli(whitespaceReason, true)).toEqual({
      exitCode: 1,
      stdout: whitespaceReason.stdout,
      stderr: "done: blocked",
    })

    const preserveNonZeroAndStderr: CliResult = {
      exitCode: 2,
      stdout: JSON.stringify({ decision: "block", reason: "ignored" }),
      stderr: "existing stderr",
    }
    expect(normalizeDoneResultForCli(preserveNonZeroAndStderr, true)).toEqual(
      preserveNonZeroAndStderr,
    )

    const stopDecision: CliResult = {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "stop" }),
      stderr: "",
    }
    expect(normalizeDoneResultForCli(stopDecision, true)).toEqual(stopDecision)

    const emptyStdout: CliResult = { exitCode: 0, stdout: "", stderr: "" }
    expect(normalizeDoneResultForCli(emptyStdout, true)).toEqual(emptyStdout)

    const nonJsonStdout: CliResult = { exitCode: 0, stdout: "ok", stderr: "" }
    expect(normalizeDoneResultForCli(nonJsonStdout, true)).toEqual(nonJsonStdout)
  })

  it("skips Stop-hook stdin reading on non-TTY/empty stdin when --cli is passed, while preserving Stop-hook contract without --cli", async () => {
    const dir = createTempGitRepo("harness-done-cli-stdin-")
    writeVerifyStamp(dir, nodeSyncHostIo, "impl/test", {
      dstSeed: DstSeed.make(1),
      dstSeedsRun: 1,
    })

    // Hanging non-TTY stdin must NOT block or time out when --cli is set
    const hangingStdin = createMockStdin(false)
    const cliNonTtyRes = await withMockedStdin(hangingStdin, () =>
      Effect.runPromise(
        runDeclarativeCli(["done", "--cli"], {
          repoRoot: dir,
          stdinTimeoutMs: 25,
          skipBackgroundDaemons: true,
        }),
      ),
    )
    expect(cliNonTtyRes.exitCode).toBe(0)
    expect(hangingStdin.resumed).toBe(false)

    // Empty explicit stdin with --cli must still pass when tree has valid stamp
    const cliEmptyStdinRes = await Effect.runPromise(
      handleDone(["done", "--cli"], {
        repoRoot: dir,
        stdin: "",
        skipBackgroundDaemons: true,
      }),
    )
    expect(cliEmptyStdinRes.exitCode).toBe(0)

    // Without --cli, empty stdin preserves Stop-hook block contract unchanged
    const hookEmptyStdinRes = await Effect.runPromise(
      handleDone(["done"], {
        repoRoot: dir,
        stdin: "",
        skipBackgroundDaemons: true,
      }),
    )
    expect(hookEmptyStdinRes.exitCode).toBe(2)
    expect(JSON.parse(hookEmptyStdinRes.stdout)).toEqual({
      decision: "block",
      reason: "done: empty Stop hook stdin payload",
    })
  })

  it("converts missing/invalid verify stamp into exitCode 1 with reason on stderr in --cli mode", async () => {
    const dir = createTempGitRepo("harness-done-cli-invalid-stamp-")

    const viaHandleDone = await Effect.runPromise(
      handleDone(["done", "--cli"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(viaHandleDone.exitCode).toBe(1)
    expect(viaHandleDone.stderr).toContain("verify")
    expect(JSON.parse(viaHandleDone.stdout)).toMatchObject({ decision: "block" })

    const viaDeclarative = await Effect.runPromise(
      runDeclarativeCli(["done", "--cli"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(viaDeclarative.exitCode).toBe(1)
    expect(viaDeclarative.stderr).toContain("verify")
  })

  it("runs full verify-stamp checks on --cli even in subagent or read-only transcript contexts", async () => {
    const dir = createTempGitRepo("harness-done-cli-subagent-")
    const transcriptPath = join(dir, "transcript.jsonl")
    writeFileSync(
      transcriptPath,
      JSON.stringify({ source: "USER_EXPLICIT", content: "check status" }) + "\n",
      "utf8",
    )

    vi.stubEnv("HARNESS_SUBAGENT", "1")
    try {
      // Without --cli, subagent Stop hook bypasses with exitCode 0
      const hookBypassRes = await Effect.runPromise(
        handleDone(["done"], {
          repoRoot: dir,
          stdin: JSON.stringify({ stop_hook_active: false, transcriptPath }),
          skipBackgroundDaemons: true,
        }),
      )
      expect(hookBypassRes.exitCode).toBe(0)
      expect(hookBypassRes.telemetryDetail).toBe("subagent=true")

      // With --cli, subagent bypass is skipped and missing stamp fails with exitCode 1
      const cliForcedCheck = await Effect.runPromise(
        handleDone(["done", "--cli"], {
          repoRoot: dir,
          stdin: JSON.stringify({ stop_hook_active: false, transcriptPath }),
          skipBackgroundDaemons: true,
        }),
      )
      expect(cliForcedCheck.exitCode).toBe(1)
      expect(cliForcedCheck.stderr).toContain("verify")

      // With --cli and valid verify stamp under HARNESS_SUBAGENT=1, check passes
      writeVerifyStamp(dir, nodeSyncHostIo, "impl/test", {
        dstSeed: DstSeed.make(1),
        dstSeedsRun: 1,
      })
      const cliValidSubagent = await Effect.runPromise(
        handleDone(["done", "--cli"], {
          repoRoot: dir,
          stdin: JSON.stringify({ stop_hook_active: false, transcriptPath }),
          skipBackgroundDaemons: true,
        }),
      )
      expect(cliValidSubagent.exitCode).toBe(0)
      expect(cliValidSubagent.telemetryDetail).toBe("completed")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("fails closed with non-zero exitCode on --cli with --format=antigravity for unknown flags, -h, and rejects -- --cli", async () => {
    const dir = createTempGitRepo("harness-done-cli-failclosed-")

    const unknownFlagRes = await Effect.runPromise(
      runDeclarativeCli(["done", "--cli", "--format=antigravity", "--unknown-flag"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(unknownFlagRes.exitCode).not.toBe(0)
    expect(unknownFlagRes.stderr.trim().length).toBeGreaterThan(0)

    const helpFlagRes = await Effect.runPromise(
      runDeclarativeCli(["done", "--cli", "--format=antigravity", "-h"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(helpFlagRes.exitCode).not.toBe(0)
    expect(helpFlagRes.stderr.trim().length).toBeGreaterThan(0)

    const smuggledCliRes = await Effect.runPromise(
      runDeclarativeCli(["done", "--", "--cli"], {
        repoRoot: dir,
        stdin: JSON.stringify({ stop_hook_active: false }),
        skipBackgroundDaemons: true,
      }),
    )
    expect(smuggledCliRes.exitCode).toBe(2)
    expect(JSON.parse(smuggledCliRes.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("CLI parse failure"),
    })
  })

  it("routes runDeclarativeCli(['done', '--format=antigravity', '--cli']) through handleDone", async () => {
    const dir = createTempGitRepo("harness-done-cli-antigravity-")

    const missingStampRes = await Effect.runPromise(
      runDeclarativeCli(["done", "--format=antigravity", "--cli"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(missingStampRes.exitCode).toBe(1)
    expect(missingStampRes.stderr).toContain("verify")
    expect(JSON.parse(missingStampRes.stdout)).toMatchObject({ decision: "continue" })

    writeVerifyStamp(dir, nodeSyncHostIo, "impl/test", {
      dstSeed: DstSeed.make(1),
      dstSeedsRun: 1,
    })
    const validStampRes = await Effect.runPromise(
      runDeclarativeCli(["done", "--format=antigravity", "--cli"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      }),
    )
    expect(validStampRes.exitCode).toBe(0)
    expect(JSON.parse(validStampRes.stdout)).toEqual({ decision: "stop" })
  })

  it("bypasses non-subagent read-only transcript turns without --cli, while --cli enforces the verify stamp", async () => {
    const dir = createTempGitRepo("harness-done-cli-readonly-")
    const transcriptPath = join(dir, "transcript.jsonl")
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ source: "USER_EXPLICIT", content: "inspect git status" }),
        JSON.stringify({
          source: "PLANNER_RESPONSE",
          tool_calls: [{ name: "run_command", args: { CommandLine: "git status" } }],
        }),
      ].join("\n") + "\n",
      "utf8",
    )

    vi.stubEnv("HARNESS_SUBAGENT", "")
    try {
      const hookReadOnlyRes = await Effect.runPromise(
        handleDone(["done"], {
          repoRoot: dir,
          stdin: JSON.stringify({ stop_hook_active: false, transcriptPath }),
          skipBackgroundDaemons: true,
        }),
      )
      expect(hookReadOnlyRes.exitCode).toBe(0)
      expect(hookReadOnlyRes.telemetryDetail).toBe("readOnly=true")

      const cliEnforcedRes = await Effect.runPromise(
        handleDone(["done", "--cli"], {
          repoRoot: dir,
          stdin: JSON.stringify({ stop_hook_active: false, transcriptPath }),
          skipBackgroundDaemons: true,
        }),
      )
      expect(cliEnforcedRes.exitCode).toBe(1)
      expect(cliEnforcedRes.stderr).toContain("verify")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("SPEC-0032 REQ-2.3: bypasses HARNESS_DONE_DEADLINE_MS timeout in --cli mode while enforcing it for Stop hooks", async () => {
    const dir = createTempGitRepo("harness-done-cli-deadline-")
    writeVerifyStamp(dir, nodeSyncHostIo, "impl/test", {
      dstSeed: DstSeed.make(1),
      dstSeedsRun: 1,
    })

    const baseLayer = makeMockDecisionModelLayer({
      implementedProb: 0.95,
      noOutOfScopeProb: 0.95,
    })
    const slowDecisionLayer = Layer.effect(
      DecisionModel.DecisionModel,
      Effect.gen(function* () {
        const model = yield* Effect.provide(DecisionModel.DecisionModel, baseLayer)
        const delayedModel: DecisionModel.DecisionModel = {
          ...model,
          decide: (definition, options) =>
            Effect.sleep(Duration.millis(60)).pipe(
              Effect.andThen(model.decide(definition, options)),
            ),
        }
        return delayedModel
      }),
    )
    const planSteps = [
      {
        stepId: "step-1",
        planStep: "Verify deadline bypass in --cli mode",
        stepDiff: "+ export const ok = true",
      },
    ]

    vi.stubEnv("HARNESS_DONE_DEADLINE_MS", "20")
    try {
      const hookRes = await Effect.runPromise(
        handleDone(["done"], {
          repoRoot: dir,
          stdin: JSON.stringify({ stop_hook_active: false }),
          planSteps,
          decisionLayer: slowDecisionLayer,
          skipBackgroundDaemons: true,
        }),
      )
      expect(hookRes.exitCode).toBe(2)
      expect(JSON.parse(hookRes.stdout)).toEqual({
        decision: "block",
        reason: expect.stringContaining("Stop hook verification exceeded internal deadline"),
      })

      const cliRes = await Effect.runPromise(
        handleDone(["done", "--cli"], {
          repoRoot: dir,
          planSteps,
          decisionLayer: slowDecisionLayer,
          skipBackgroundDaemons: true,
        }),
      )
      expect(cliRes.exitCode).toBe(0)
      expect(cliRes.telemetryDetail).toBe("completed")
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
