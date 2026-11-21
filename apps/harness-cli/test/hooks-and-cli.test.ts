import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DETERMINISTIC_TRIAGE_RULES, makeMockDecisionModelLayer } from "@harness/decision"
import { CLEF_SYSTEMONE_ONLY_BANNED_REASON, DstSeed, writeVerifyStamp } from "@harness/gates"
import { buildHarnessGraph, resolveOmnigraphClusterDir, saveGraphSnapshot } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { runWithTestTracer } from "@harness/ingest"
import {
  ensureLocalOmnigraphReady,
  isLoopbackOmnigraphUrl,
  isSafeOmnigraphPidToKill,
  isValidLockId,
} from "../src/commands/omnigraph-lifecycle.js"
import { makeReadStdinEffect } from "../src/commands/daemon-and-omnigraph.service.js"
import { handleGuard, handleRoute } from "../src/commands/guard-and-route.command.js"
import { handleDone } from "../src/commands/verify-and-done.command.js"
import { resolveCliInfraLayer } from "../src/commands/declarative-cli.js"
import { runCliEffect, runDeclarativeCli, teardownCliMain } from "../src/index.js"
import { runCli } from "./run-cli-helper.js"

const REPO_ROOT = resolve(import.meta.dirname, "../../..")

interface MockStdinStream extends EventEmitter {
  isTTY: boolean
  paused: boolean
  resumed: boolean
  pause: () => void
  resume: () => void
}

const createMockStdin = (isTTY = false): MockStdinStream => {
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

describe("hooks, stdin, teardown, omnigraph-lifecycle, and subprocess CLI", () => {
  const tempDirs: Array<string> = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  describe("F-1.2: makeReadStdinEffect", () => {
    it("reads slow chunked stdin arriving after >120ms and pauses stdin on completion", async () => {
      const mockStdin = createMockStdin(false)
      const result = await withMockedStdin(mockStdin, async () => {
        const promise = Effect.runPromise(makeReadStdinEffect({ timeoutMs: 1000 }))
        setTimeout(() => {
          mockStdin.emit("data", Buffer.from('{"tool_name":"Bash",'))
        }, 70)
        setTimeout(() => {
          mockStdin.emit("data", Buffer.from('"tool_input":{"command":"pnpm test"}}'))
          mockStdin.emit("end")
        }, 140)
        return promise
      })
      expect(result).toBe('{"tool_name":"Bash","tool_input":{"command":"pnpm test"}}')
      expect(mockStdin.paused).toBe(true)
      expect(mockStdin.listenerCount("data")).toBe(0)
      expect(mockStdin.listenerCount("end")).toBe(0)
      expect(mockStdin.listenerCount("error")).toBe(0)
    })

    it("fails with StdinReadError on overall timeout", async () => {
      const mockStdin = createMockStdin(false)
      const exit = await withMockedStdin(mockStdin, () =>
        Effect.runPromiseExit(makeReadStdinEffect({ timeoutMs: 40 })),
      )
      match(exit)
        .with({ _tag: "Success" }, () => {
          expect.fail("Expected timeout failure")
        })
        .with({ _tag: "Failure" }, ({ cause }) => {
          match(Cause.findErrorOption(cause))
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value._tag).toBe("StdinReadError")
              expect(value.reasonKind).toBe("Timeout")
            })
            .with({ _tag: "None" }, () => {
              expect.fail("Expected StdinReadError in cause")
            })
            .exhaustive()
        })
        .exhaustive()
      expect(mockStdin.paused).toBe(true)
    })

    it("fails with StdinReadError when payload exceeds maxBytes cap", async () => {
      const mockStdin = createMockStdin(false)
      const exit = await withMockedStdin(mockStdin, () => {
        const promise = Effect.runPromiseExit(
          makeReadStdinEffect({ timeoutMs: 1000, maxBytes: 16 }),
        )
        setTimeout(() => {
          mockStdin.emit("data", Buffer.from("0123456789abcdef0123"))
        }, 10)
        return promise
      })
      match(exit)
        .with({ _tag: "Success" }, () => {
          expect.fail("Expected overflow failure")
        })
        .with({ _tag: "Failure" }, ({ cause }) => {
          match(Cause.findErrorOption(cause))
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value._tag).toBe("StdinReadError")
              expect(value.reasonKind).toBe("MaxBytesExceeded")
            })
            .with({ _tag: "None" }, () => {
              expect.fail("Expected StdinReadError in cause")
            })
            .exhaustive()
        })
        .exhaustive()
      expect(mockStdin.paused).toBe(true)
    })
  })

  describe("F-1.3 & F-1.4: fail-closed stdin handling in guard and done", () => {
    it("handleGuard denies on StdinReadError timeout", async () => {
      const mockStdin = createMockStdin(false)
      const res = await withMockedStdin(mockStdin, () => runCli(["guard"], { stdinTimeoutMs: 30 }))
      expect(res.exitCode).toBe(2)
      expect(res.stderr).toContain("failed or timed out reading hook stdin payload")
    })

    it("handleGuard denies on empty hook stdin (--format=antigravity with stdin: '')", async () => {
      const res = await runCli(["guard", "--format=antigravity"], { stdin: "" })
      expect(res.exitCode).toBe(0)
      expect(JSON.parse(res.stdout)).toEqual({
        decision: "deny",
        reason: expect.stringContaining("empty hook stdin payload"),
      })
    })

    it("handleDone blocks when stdin read fails with StdinReadError", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-done-stdin-err-"))
      tempDirs.push(dir)
      const mockStdin = createMockStdin(false)
      const res = await withMockedStdin(mockStdin, () =>
        runCli(["done"], { repoRoot: dir, stdinTimeoutMs: 30 }),
      )
      expect(res.exitCode).toBe(2)
      expect(JSON.parse(res.stdout)).toEqual({
        decision: "block",
        reason: expect.stringContaining("failed or timed out reading Stop hook stdin"),
      })
    })
  })

  describe("F-2.1 & F-19.1: declarative CLI flags and guard security", () => {
    it("accepts ingest --format=antigravity, plan-synth --verify, and repair --verify", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-flags-"))
      tempDirs.push(dir)

      const ingestRes = await Effect.runPromise(
        runDeclarativeCli(["ingest", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(ingestRes.exitCode).toBe(0)

      const planSynthRes = await Effect.runPromise(
        runDeclarativeCli(["plan-synth", "--verify"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(planSynthRes.stderr).not.toContain("Unrecognized")

      const repairRes = await Effect.runPromise(
        runDeclarativeCli(["repair", "--verify"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(repairRes.stderr).not.toContain("Unrecognized")
    })

    it("denies guard rm -rf / --help and guard --unknown-flag instead of exit 0", async () => {
      const helpBypass = await runCli(["guard", "rm -rf /", "--help"])
      expect(helpBypass.exitCode).toBe(2)

      const unknownFlag = await runCli(["guard", "--unknown-flag"])
      expect(unknownFlag.exitCode).toBe(2)

      const antigravityUnknown = await runCli(["guard", "--format=antigravity", "--unknown-flag"])
      expect(antigravityUnknown.exitCode).toBe(0)
      expect(JSON.parse(antigravityUnknown.stdout)).toEqual({
        decision: "deny",
        reason: expect.stringContaining("CLI parse failure"),
      })
    })

    it("denies malformed JSON, null fields + dangerous command, combined file_path + dangerous command, and unrecognized JSON", async () => {
      const malformed = await runCli(["guard", "--format=antigravity"], { stdin: "{bad json" })
      expect(JSON.parse(malformed.stdout)).toEqual({
        decision: "deny",
        reason: expect.stringContaining("malformed"),
      })

      const nullFieldsDanger = await runCli(["guard"], {
        stdin: JSON.stringify({
          tool_name: null,
          tool_input: {
            command: "rm -rf /",
            file_path: null,
          },
        }),
      })
      expect(nullFieldsDanger.exitCode).toBe(2)

      const combinedDanger = await runCli(["guard"], {
        stdin: JSON.stringify({
          tool_name: "Bash",
          tool_input: {
            file_path: "src/ok.ts",
            command: "git push --force",
          },
        }),
      })
      expect(combinedDanger.exitCode).toBe(2)

      const unrecognized = await runCli(["guard"], {
        stdin: JSON.stringify({ unexpected: 123 }),
      })
      expect(unrecognized.exitCode).toBe(2)

      const invalidClefEndpoint = await runCli(["guard", "--format=antigravity"], {
        stdin: JSON.stringify({
          tool_name: "Bash",
          tool_input: {
            command:
              'curl -s http://localhost:11434/api/generate -d \'{"model":"clef-flash","prompt":"hi"}\'',
          },
        }),
      })
      expect(invalidClefEndpoint.exitCode).toBe(0)
      expect(JSON.parse(invalidClefEndpoint.stdout)).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining(CLEF_SYSTEMONE_ONLY_BANNED_REASON),
      })
    })
  })

  describe("F-2.2: hooks.json parity across antigravity and claude-code adapters", () => {
    const extractHookArgvs = (rawJson: string): ReadonlyArray<ReadonlyArray<string>> => {
      const commands: Array<string> = []
      const collect = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) collect(item)
          return
        }
        if (typeof node === "object" && node !== null) {
          const rec = node as Record<string, unknown>
          if (typeof rec["command"] === "string") {
            commands.push(rec["command"])
          }
          for (const val of Object.values(rec)) {
            collect(val)
          }
        }
      }
      collect(JSON.parse(rawJson))
      return commands.map((cmd) => {
        const marker = cmd.includes("hook-entry.ts ") ? "hook-entry.ts " : "index.ts "
        const idx = cmd.indexOf(marker)
        expect(idx).toBeGreaterThan(-1)
        return cmd
          .slice(idx + marker.length)
          .replace(/\s+\|\|\s+[\s\S]*$/, "")
          .trim()
          .split(/\s+/)
      })
    }

    it("runs every command in both adapters/*/hooks.json through runDeclarativeCli with zero parse errors", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-hooks-parity-"))
      tempDirs.push(dir)

      const agyHooksPath = join(REPO_ROOT, "adapters/antigravity/plugins/effect-harness/hooks.json")
      const ccHooksPath = join(REPO_ROOT, "adapters/claude-code/hooks.json")
      const argvs = [
        ...extractHookArgvs(readFileSync(agyHooksPath, "utf8")),
        ...extractHookArgvs(readFileSync(ccHooksPath, "utf8")),
      ]
      expect(argvs.length).toBeGreaterThanOrEqual(8)

      const allowLayer = makeMockDecisionModelLayer({
        fitsAnyProb: 0.9,
        blockLabel: "effect",
        destructiveProb: 0.05,
        secretAccessProb: 0.05,
        exfiltrationProb: 0.05,
      })

      for (const argv of argvs) {
        const sub = argv[0]
        const isAgy = argv.includes("--format=antigravity")
        const stdin =
          sub === "guard"
            ? JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" } })
            : sub === "done"
              ? isAgy
                ? JSON.stringify({ fullyIdle: true })
                : JSON.stringify({ stop_hook_active: false })
              : JSON.stringify({})

        const res = await Effect.runPromise(
          runDeclarativeCli(argv, {
            repoRoot: dir,
            stdin,
            decisionLayer: allowLayer,
            skipBackgroundDaemons: true,
            skipAutoSessionReport: true,
          }),
        )
        expect(res.exitCode).toBe(0)
        if (sub === "guard") {
          if (isAgy) {
            expect(JSON.parse(res.stdout)).toEqual({ decision: "allow" })
          } else {
            expect(res.stdout).toBe("")
          }
        } else if (sub === "done") {
          expect(JSON.parse(res.stdout)).toEqual({
            decision: isAgy ? "continue" : "block",
            reason: expect.any(String),
          })
        } else if (sub === "session") {
          const parsed = JSON.parse(res.stdout) as Record<string, unknown>
          expect(typeof parsed).toBe("object")
          expect(parsed).not.toBeNull()
        } else if (sub === "ingest") {
          expect(res.stdout.length).toBeGreaterThan(0)
        }
        expect(res.stderr).not.toContain("Unrecognized")
        expect(res.stderr).not.toContain("unknown command")
        expect(res.stderr).not.toContain("CLI parse failure")
      }
    })
  })

  describe("F-3.1 & F-7.3: teardownCliMain and real subprocess exit-code paths", () => {
    it("T-6: teardownCliMain handles all 6 Exit cases, 3-token normalized argv, and Antigravity stdout JSON", () => {
      const prevExitCode = process.exitCode
      const stderrChunks: Array<string> = []
      const stdoutChunks: Array<string> = []
      const onExitCodes: Array<number> = []
      const reset = () => {
        onExitCodes.length = 0
        stderrChunks.length = 0
        stdoutChunks.length = 0
        process.exitCode = 0
      }
      try {
        // 1. Exit.succeed
        process.exitCode = 2
        teardownCliMain(Exit.succeed(undefined), (code) => onExitCodes.push(code), {
          writeStderr: (s) => stderrChunks.push(s),
          argv: ["node", "index.ts", "guard"],
          writeStdout: (s) => stdoutChunks.push(s),
        })
        expect(process.exitCode).toBe(2)
        expect(onExitCodes).toEqual([2])

        // 2. Exit.fail normal (1)
        reset()
        teardownCliMain(Exit.fail("verify-err"), (code) => onExitCodes.push(code), {
          writeStderr: (s) => stderrChunks.push(s),
          argv: ["node", "index.ts", "verify"],
          writeStdout: (s) => stdoutChunks.push(s),
        })
        expect(stderrChunks.join("")).toContain("verify-err")
        expect(process.exitCode).toBe(1)
        expect(onExitCodes).toEqual([1])

        // 3. Exit.fail hook (2)
        reset()
        teardownCliMain(Exit.fail("guard-err"), (code) => onExitCodes.push(code), {
          writeStderr: (s) => stderrChunks.push(s),
          argv: ["node", "index.ts", "guard"],
          writeStdout: (s) => stdoutChunks.push(s),
        })
        expect(stderrChunks.join("")).toContain("guard-err")
        expect(process.exitCode).toBe(2)
        expect(onExitCodes).toEqual([2])

        // 4. Exit.die normal (1)
        reset()
        teardownCliMain(
          Exit.failCause(Cause.die(new Error("boom-normal"))),
          (code) => onExitCodes.push(code),
          {
            writeStderr: (s) => stderrChunks.push(s),
            argv: ["node", "index.ts", "verify"],
            writeStdout: (s) => stdoutChunks.push(s),
          },
        )
        expect(stderrChunks.join("")).toContain("boom-normal")
        expect(process.exitCode).toBe(1)
        expect(onExitCodes).toEqual([1])

        // 5. Exit.die hook (2) + 3-token normalized argv
        reset()
        teardownCliMain(
          Exit.failCause(Cause.die(new Error("boom-hook"))),
          (code) => onExitCodes.push(code),
          {
            writeStderr: (s) => stderrChunks.push(s),
            argv: ["guard", "--format=claude", "--bogus"],
            writeStdout: (s) => stdoutChunks.push(s),
          },
        )
        expect(stderrChunks.join("")).toContain("boom-hook")
        expect(process.exitCode).toBe(2)
        expect(onExitCodes).toEqual([2])

        // 6. Exit.interrupt: hook commands (guard/done) fail closed with 2; non-hook (verify) returns 130
        reset()
        teardownCliMain(Exit.interrupt(1), (code) => onExitCodes.push(code), {
          writeStderr: (s) => stderrChunks.push(s),
          argv: ["node", "index.ts", "guard"],
          writeStdout: (s) => stdoutChunks.push(s),
        })
        expect(process.exitCode).toBe(2)
        expect(onExitCodes).toEqual([2])
        expect(stderrChunks.join("")).toContain("interrupted by signal")

        reset()
        teardownCliMain(Exit.interrupt(1), (code) => onExitCodes.push(code), {
          writeStderr: (s) => stderrChunks.push(s),
          argv: ["node", "index.ts", "done"],
          writeStdout: (s) => stdoutChunks.push(s),
        })
        expect(process.exitCode).toBe(2)
        expect(onExitCodes).toEqual([2])
        expect(JSON.parse(stdoutChunks.join(""))).toEqual({
          decision: "block",
          reason: expect.stringContaining("interrupted by signal"),
        })

        reset()
        teardownCliMain(Exit.interrupt(1), (code) => onExitCodes.push(code), {
          writeStderr: (s) => stderrChunks.push(s),
          argv: ["node", "index.ts", "guard", "--format=antigravity"],
          writeStdout: (s) => stdoutChunks.push(s),
        })
        expect(process.exitCode).toBe(2)
        expect(onExitCodes).toEqual([2])
        expect(JSON.parse(stdoutChunks.join(""))).toEqual({
          decision: "deny",
          reason: expect.stringContaining("interrupted by signal"),
        })

        reset()
        teardownCliMain(Exit.interrupt(1), (code) => onExitCodes.push(code), {
          writeStderr: (s) => stderrChunks.push(s),
          argv: ["node", "index.ts", "verify"],
          writeStdout: (s) => stdoutChunks.push(s),
        })
        expect(process.exitCode).toBe(130)
        expect(onExitCodes).toEqual([130])

        // 7. Antigravity guard & done fail-closed stdout JSON
        reset()
        teardownCliMain(
          Exit.failCause(Cause.die(new Error("agy-guard-die"))),
          (code) => onExitCodes.push(code),
          {
            writeStderr: (s) => stderrChunks.push(s),
            argv: ["guard", "--format=antigravity"],
            writeStdout: (s) => stdoutChunks.push(s),
          },
        )
        expect(JSON.parse(stdoutChunks.join(""))).toEqual({
          decision: "deny",
          reason: expect.stringContaining("agy-guard-die"),
        })

        reset()
        teardownCliMain(
          Exit.failCause(Cause.die(new Error("agy-done-die"))),
          (code) => onExitCodes.push(code),
          {
            writeStderr: (s) => stderrChunks.push(s),
            argv: ["done", "--format", "antigravity"],
            writeStdout: (s) => stdoutChunks.push(s),
          },
        )
        expect(JSON.parse(stdoutChunks.join(""))).toEqual({
          decision: "continue",
          reason: expect.stringContaining("agy-done-die"),
        })
      } finally {
        process.exitCode = prevExitCode
      }
    })

    it("C-3, C-4, C-10, T-6: two-token --format antigravity, done --format=antigravity empty stdin, and decisionLayer Effect.die fail closed", async () => {
      const twoTokenBogus = await runCli(["guard", "--format", "antigravity", "--bogus"], {
        stdin: "{}",
      })
      expect(twoTokenBogus.exitCode).toBe(0)
      expect(JSON.parse(twoTokenBogus.stdout)).toEqual({
        decision: "deny",
        reason: expect.stringContaining("CLI parse failure"),
      })

      const agyEmptyDone = await runCli(["done", "--format=antigravity"], { stdin: "" })
      expect(agyEmptyDone.exitCode).toBe(0)
      expect(JSON.parse(agyEmptyDone.stdout)).toEqual({
        decision: "continue",
        reason: expect.stringContaining("empty Stop hook stdin payload"),
      })

      const dyingDecisionLayer = Layer.effect(
        DecisionModel.DecisionModel,
        Effect.die(new Error("decisionLayer-exploded")),
      )
      const dieGuardRes = await Effect.runPromise(
        runDeclarativeCli(
          ["guard", "--format=antigravity"],
          { stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" } }) },
          dyingDecisionLayer,
        ),
      )
      expect(dieGuardRes.exitCode).toBe(0)
      expect(JSON.parse(dieGuardRes.stdout)).toEqual({
        decision: "deny",
        reason: expect.stringContaining("decisionLayer-exploded"),
      })

      // Stdin-detected Antigravity format WITHOUT --format=antigravity when decisionLayer dies
      const dieAgyStdinGuard = await Effect.runPromise(
        runDeclarativeCli(
          ["guard"],
          {
            stdin: JSON.stringify({
              toolCall: { name: "Bash", args: { CommandLine: "echo hi" } },
            }),
          },
          dyingDecisionLayer,
        ),
      )
      expect(dieAgyStdinGuard.exitCode).toBe(0)
      expect(JSON.parse(dieAgyStdinGuard.stdout)).toEqual({
        decision: "deny",
        reason: expect.stringContaining("decisionLayer-exploded"),
      })

      const tmpDieDoneRepo = mkdtempSync(join(tmpdir(), "harness-die-done-agy-"))
      tempDirs.push(tmpDieDoneRepo)
      writeVerifyStamp(tmpDieDoneRepo, nodeSyncHostIo, "impl/test", {
        dstSeed: DstSeed.make(1),
        dstSeedsRun: 1,
      })
      const dieAgyStdinDone = await Effect.runPromise(
        runDeclarativeCli(
          ["done"],
          {
            repoRoot: tmpDieDoneRepo,
            skipBackgroundDaemons: true,
            stdin: JSON.stringify({
              fullyIdle: true,
              conversationId: "conv-die-1",
              workspacePaths: [tmpDieDoneRepo],
            }),
            planSteps: [{ stepId: "step-1", planStep: "step-1", stepDiff: "diff" }],
          },
          dyingDecisionLayer,
        ),
      )
      expect(dieAgyStdinDone.exitCode).toBe(0)
      expect(JSON.parse(dieAgyStdinDone.stdout)).toEqual({
        decision: "continue",
        reason: expect.stringContaining("decisionLayer-exploded"),
      })
    })

    it("C-3, C-4, C-10, T-6: real subprocesses fail closed on empty stdin, guard --format=antigravity --bogus, and done --bogus", () => {
      const runSub = (args: ReadonlyArray<string>, input?: string) =>
        spawnSync(
          process.execPath,
          ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", ...args],
          { cwd: REPO_ROOT, input, encoding: "utf8", timeout: 10_000 },
        )

      const emptyGuard = runSub(["guard"], "")
      expect(emptyGuard.status).toBe(2)
      expect(emptyGuard.stderr).toContain("empty hook stdin payload")

      const emptyDone = runSub(["done"], "")
      expect(emptyDone.status).toBe(2)
      expect(JSON.parse(emptyDone.stdout.trim())).toEqual({
        decision: "block",
        reason: expect.stringContaining("empty Stop hook stdin payload"),
      })

      const bogusAgyGuard = runSub(["guard", "--format=antigravity", "--bogus"], "{}")
      expect(bogusAgyGuard.status).toBe(0)
      expect(bogusAgyGuard.stdout).not.toContain("USAGE")
      expect(JSON.parse(bogusAgyGuard.stdout.trim())).toEqual({
        decision: "deny",
        reason: expect.stringContaining("CLI parse failure"),
      })

      const bogusDone = runSub(["done", "--bogus"], "{}")
      expect(bogusDone.status).toBe(2)
      expect(bogusDone.stdout).not.toContain("USAGE")
      expect(JSON.parse(bogusDone.stdout.trim())).toEqual({
        decision: "block",
        reason: expect.stringContaining("CLI parse failure"),
      })
    })

    it("executes index.ts via Node subprocess for exit codes 0 (help), 1 (unknown), and 2 (guard deny)", () => {
      const runSub = (args: ReadonlyArray<string>) =>
        spawnSync(
          process.execPath,
          ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", ...args],
          { cwd: REPO_ROOT, encoding: "utf8", timeout: 10_000 },
        )

      const helpRes = runSub(["help"])
      expect(helpRes.status).toBe(0)
      expect(helpRes.stdout).toContain("harness help")

      const unknownRes = runSub(["definitely-not-a-command"])
      expect(unknownRes.status).toBe(1)
      expect(unknownRes.stderr).toContain("unknown command")

      const guardRes = runSub(["guard", "rm -rf /"])
      expect(guardRes.status).toBe(2)
      expect(guardRes.stderr).toContain("Blocked by harness guard")
    })

    it("F-9.1: done blocks with exitCode 2 and valid JSON when HARNESS_DONE_DEADLINE_MS expires", async () => {
      const prevDeadline = process.env.HARNESS_DONE_DEADLINE_MS
      process.env.HARNESS_DONE_DEADLINE_MS = "20"
      try {
        const tmpRepo = mkdtempSync(join(tmpdir(), "harness-done-deadline-"))
        tempDirs.push(tmpRepo)
        writeVerifyStamp(tmpRepo, nodeSyncHostIo, "impl/test", {
          dstSeed: DstSeed.make(1),
          dstSeedsRun: 1,
        })
        const slowDecisionLayer = Layer.effect(DecisionModel.DecisionModel, Effect.never)
        const res = await Effect.runPromise(
          handleDone(["done"], {
            repoRoot: tmpRepo,
            skipBackgroundDaemons: true,
            stdin: JSON.stringify({ stop_hook_active: false }),
            planSteps: [{ stepId: "step-1", planStep: "step-1", stepDiff: "diff" }],
            decisionLayer: slowDecisionLayer,
          }),
        )
        expect(res.exitCode).toBe(2)
        expect(JSON.parse(res.stdout)).toEqual({
          decision: "block",
          reason: expect.stringContaining("internal deadline (20ms)"),
        })
      } finally {
        if (prevDeadline !== undefined) process.env.HARNESS_DONE_DEADLINE_MS = prevDeadline
        else Reflect.deleteProperty(process.env, "HARNESS_DONE_DEADLINE_MS")
      }
    })

    it("M-12.1(e): cold-loading guard in a fresh Node subprocess never loads @harness/ingest", () => {
      const preload = [
        'import { registerHooks } from "node:module";',
        "const loaded = [];",
        "registerHooks({ load(url, ctx, next) { loaded.push(url); return next(url, ctx); } });",
        'process.on("exit", () => { process.stderr.write("__INGEST_LOADED__=" + String(loaded.some((u) => u.includes("libs/harness/ingest"))) + "\\n"); });',
      ].join(" ")
      const sub = spawnSync(
        process.execPath,
        [
          "--import",
          "./tools/node-ts-resolver.mjs",
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
          "apps/harness-cli/src/index.ts",
          "guard",
        ],
        {
          cwd: REPO_ROOT,
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
          encoding: "utf8",
          timeout: 15_000,
        },
      )
      expect(sub.status).toBe(0)
      expect(sub.stderr).toContain("__INGEST_LOADED__=false")
    })

    it("F-1.1 & M-4.1: real subprocess SIGINT and SIGTERM fail closed for guard and done", async () => {
      const stdinReadyPreload = [
        "const iv = setInterval(() => {",
        '  if (process.stdin.listenerCount("data") > 0) {',
        "    clearInterval(iv);",
        '    process.stderr.write("__HOOK_STDIN_READY__\\n");',
        "  }",
        "}, 20);",
        "iv.unref();",
      ].join(" ")
      const runSignalSub = (args: ReadonlyArray<string>, signal: "SIGINT" | "SIGTERM") =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              "./tools/node-ts-resolver.mjs",
              "--import",
              `data:text/javascript,${encodeURIComponent(stdinReadyPreload)}`,
              "apps/harness-cli/src/index.ts",
              ...args,
            ],
            {
              cwd: REPO_ROOT,
              stdio: ["pipe", "pipe", "pipe"],
              env: {
                ...process.env,
                HARNESS_WORKTREE_ID: "",
                CLAUDE_AGENT_ID: "",
                ANTIGRAVITY_SUBAGENT: "",
              },
            },
          )
          let stdout = ""
          let stderr = ""
          let signaled = false
          const sendSignal = () => {
            if (signaled) return
            signaled = true
            child.kill(signal)
          }
          const fallbackTimer = setTimeout(sendSignal, 3800)
          child.stdout.on("data", (d) => {
            stdout += String(d)
          })
          child.stderr.on("data", (d) => {
            stderr += String(d)
            if (!signaled && stderr.includes("__HOOK_STDIN_READY__")) {
              sendSignal()
            }
          })
          child.on("close", (code) => {
            clearTimeout(fallbackTimer)
            resolvePromise({ code, stdout, stderr })
          })
        })

      // 1. Claude guard SIGTERM
      const claudeGuardTerm = await runSignalSub(["guard"], "SIGTERM")
      expect(claudeGuardTerm.code).toBe(2)
      expect(claudeGuardTerm.stderr).toContain("interrupted")

      // 2. Claude done SIGINT
      const claudeDoneInt = await runSignalSub(["done"], "SIGINT")
      expect(claudeDoneInt.code).toBe(2)
      expect(JSON.parse(claudeDoneInt.stdout.trim())).toEqual({
        decision: "block",
        reason: expect.stringContaining("interrupted"),
      })

      // 3. Antigravity guard with --format=antigravity SIGTERM
      const agyFlagGuardTerm = await runSignalSub(["guard", "--format=antigravity"], "SIGTERM")
      expect(agyFlagGuardTerm.code).toBe(2)
      expect(JSON.parse(agyFlagGuardTerm.stdout.trim())).toEqual({
        decision: "deny",
        reason: expect.stringContaining("interrupted"),
      })

      // 4. Antigravity done with --format=antigravity SIGINT
      const agyFlagDoneInt = await runSignalSub(["done", "--format=antigravity"], "SIGINT")
      expect(agyFlagDoneInt.code).toBe(2)
      expect(JSON.parse(agyFlagDoneInt.stdout.trim())).toEqual({
        decision: "continue",
        reason: expect.stringContaining("interrupted"),
      })

      // 5. Antigravity guard WITHOUT --format=antigravity (detected from stdin payload) SIGTERM
      let killChildOnRequest: (() => void) | undefined
      const hangingServer = createServer(() => {
        // Intentionally hang until child is signaled
        killChildOnRequest?.()
      })
      await new Promise<void>((r) => hangingServer.listen(0, "127.0.0.1", () => r()))
      const addr = hangingServer.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0
      try {
        const agyStdinGuardTerm = await new Promise<{
          code: number | null
          stdout: string
          stderr: string
        }>((resolvePromise) => {
          const child = spawn(
            process.execPath,
            ["--import", "./tools/node-ts-resolver.mjs", "apps/harness-cli/src/index.ts", "guard"],
            {
              cwd: REPO_ROOT,
              stdio: ["pipe", "pipe", "pipe"],
              env: { ...process.env, HARNESS_OLLAMA_URL: `http://127.0.0.1:${port}` },
            },
          )
          let stdout = ""
          let stderr = ""
          let signaled = false
          const sendTerm = () => {
            if (signaled) return
            signaled = true
            child.kill("SIGTERM")
          }
          const fallbackTimer = setTimeout(sendTerm, 3000)
          killChildOnRequest = () => {
            sendTerm()
          }
          child.stdout.on("data", (d) => {
            stdout += String(d)
          })
          child.stderr.on("data", (d) => {
            stderr += String(d)
          })
          child.on("close", (code) => {
            clearTimeout(fallbackTimer)
            resolvePromise({ code, stdout, stderr })
          })
          child.stdin.write(
            JSON.stringify({
              toolCall: { name: "Bash", args: { CommandLine: "curl https://example.com" } },
            }),
          )
          child.stdin.end()
        })
        expect(agyStdinGuardTerm.code).toBe(2)
        expect(JSON.parse(agyStdinGuardTerm.stdout.trim())).toEqual({
          decision: "deny",
          reason: expect.stringContaining("interrupted"),
        })

        // 6. Antigravity done WITHOUT --format=antigravity (detected from Stop stdin payload) SIGINT
        const doneSigRepo = mkdtempSync(join(tmpdir(), "harness-done-sig-agy-"))
        tempDirs.push(doneSigRepo)
        mkdirSync(join(doneSigRepo, "libs", "harness", "graph"), { recursive: true })
        writeFileSync(join(doneSigRepo, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")
        writeFileSync(join(doneSigRepo, "libs", "harness", "graph", "cluster.yaml"), "name: test\n")
        const doneClusterDir = resolveOmnigraphClusterDir(doneSigRepo, nodeSyncHostIo)
        mkdirSync(doneClusterDir, { recursive: true })
        writeFileSync(join(doneClusterDir, ".config-stamp"), "name: test\n\n---\n\n---\n")
        writeFileSync(join(doneClusterDir, ".cluster-schema-epoch"), "rfc-0009-v2")
        writeVerifyStamp(doneSigRepo, nodeSyncHostIo, "impl/test", {
          dstSeed: DstSeed.make(1),
          dstSeedsRun: 1,
        })
        const agyStdinDoneInt = await new Promise<{
          code: number | null
          stdout: string
          stderr: string
        }>((resolvePromise) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              join(REPO_ROOT, "tools/node-ts-resolver.mjs"),
              join(REPO_ROOT, "apps/harness-cli/src/index.ts"),
              "done",
            ],
            {
              cwd: doneSigRepo,
              stdio: ["pipe", "pipe", "pipe"],
              env: {
                ...process.env,
                HARNESS_OLLAMA_URL: `http://127.0.0.1:${port}`,
                OMNIGRAPH_URL: `http://127.0.0.1:${port}`,
                HARNESS_WORKTREE_ID: "",
                CLAUDE_AGENT_ID: "",
                ANTIGRAVITY_SUBAGENT: "",
              },
            },
          )
          let stdout = ""
          let stderr = ""
          let signaled = false
          const sendInt = () => {
            if (signaled) return
            signaled = true
            child.kill("SIGINT")
          }
          const fallbackTimer = setTimeout(sendInt, 4000)
          killChildOnRequest = () => {
            sendInt()
          }
          child.stdout.on("data", (d) => {
            stdout += String(d)
          })
          child.stderr.on("data", (d) => {
            stderr += String(d)
          })
          child.on("close", (code) => {
            clearTimeout(fallbackTimer)
            resolvePromise({ code, stdout, stderr })
          })
          child.stdin.write(
            JSON.stringify({
              fullyIdle: true,
              conversationId: "conv-1",
              workspacePaths: [doneSigRepo],
            }),
          )
          child.stdin.end()
        })
        expect(agyStdinDoneInt.code).toBe(2)
        expect(JSON.parse(agyStdinDoneInt.stdout.trim())).toEqual({
          decision: "continue",
          reason: expect.stringContaining("interrupted"),
        })
      } finally {
        hangingServer.closeAllConnections()
        hangingServer.close()
      }
    }, 25_000)
  })

  describe("F-10.1: omnigraph-lifecycle safety checks", () => {
    it("T-10: validates loopback URLs strictly (rejects evil subdomains, userinfo, 0.0.0.0, ftp), safe PIDs, and lock.json IDs", () => {
      expect(isLoopbackOmnigraphUrl("http://127.0.0.1:8080")).toBe(true)
      expect(isLoopbackOmnigraphUrl("http://localhost:9000")).toBe(true)
      expect(isLoopbackOmnigraphUrl("http://[::1]:8080")).toBe(true)
      expect(isLoopbackOmnigraphUrl("https://evil.example.com:8080")).toBe(false)
      expect(isLoopbackOmnigraphUrl("http://127.0.0.1.evil.com")).toBe(false)
      expect(isLoopbackOmnigraphUrl("http://localhost@evil.com")).toBe(false)
      expect(isLoopbackOmnigraphUrl("http://user@127.0.0.1:8080")).toBe(false)
      expect(isLoopbackOmnigraphUrl("http://0.0.0.0:8080")).toBe(false)
      expect(isLoopbackOmnigraphUrl("ftp://127.0.0.1:8080")).toBe(false)
      expect(isLoopbackOmnigraphUrl("not-a-url")).toBe(false)

      expect(isSafeOmnigraphPidToKill(1)).toBe(false)
      expect(isSafeOmnigraphPidToKill(0)).toBe(false)
      expect(isSafeOmnigraphPidToKill(-5)).toBe(false)
      expect(isSafeOmnigraphPidToKill(process.pid)).toBe(false)

      expect(isValidLockId("lock_123.abc-1")).toBe(true)
      expect(isValidLockId("../evil; rm -rf /")).toBe(false)
      expect(isValidLockId("")).toBe(false)
    })

    it("returns false without running curl when omnigraph binary is missing and logs corrupt server.json", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-omnigraph-life-"))
      const fakeHome = mkdtempSync(join(tmpdir(), "harness-fake-home-"))
      tempDirs.push(dir, fakeHome)

      mkdirSync(join(dir, "libs", "harness", "graph"), { recursive: true })
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")
      writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n")
      mkdirSync(join(dir, ".harness", "omnigraph-cluster"), { recursive: true })
      writeFileSync(join(dir, ".harness", "omnigraph-cluster", "server.json"), "{corrupt-json")

      const origHome = process.env.HOME
      const origUrl = process.env.OMNIGRAPH_URL
      const stderrWrites: Array<string> = []
      const origWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk))
        return true
      }) as typeof process.stderr.write

      try {
        process.env.HOME = fakeHome
        Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
        const ready = await Effect.runPromise(ensureLocalOmnigraphReady(dir))
        expect(ready).toBe(false)
        const combined = stderrWrites.join("")
        expect(combined).toContain("failed to decode")
        expect(combined).toContain("Missing omnigraph binaries")
        expect(existsSync(join(fakeHome, ".local", "bin", "omnigraph"))).toBe(false)
      } finally {
        process.stderr.write = origWrite
        if (origHome !== undefined) process.env.HOME = origHome
        else Reflect.deleteProperty(process.env, "HOME")
        if (origUrl !== undefined) process.env.OMNIGRAPH_URL = origUrl
        else Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      }
    })

    it("Sec-P1.4: returns false instead of accepting a foreign repo omnigraph-server when server.json belongs to another repo and binaries are missing", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-omnigraph-foreign-"))
      const fakeHome = mkdtempSync(join(tmpdir(), "harness-fake-home-foreign-"))
      tempDirs.push(dir, fakeHome)

      mkdirSync(join(dir, "libs", "harness", "graph"), { recursive: true })
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")
      writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n")
      const clusterDir = resolveOmnigraphClusterDir(dir, nodeSyncHostIo)
      mkdirSync(clusterDir, { recursive: true })
      writeFileSync(join(clusterDir, ".config-stamp"), "name: test\n\n---\n\n---\n")

      const foreignServer = createServer((req, res) => {
        if (req.url === "/readyz") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Omnigraph-Http-Api": "0.14",
          })
          res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
          return
        }
        res.writeHead(404)
        res.end()
      })

      await new Promise<void>((resolvePromise, rejectPromise) => {
        foreignServer.once("error", rejectPromise)
        foreignServer.listen(0, "127.0.0.1", () => resolvePromise())
      })
      const foreignPort = (foreignServer.address() as AddressInfo).port

      const exitedPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid
      expect(exitedPid).toBeGreaterThan(1)
      writeFileSync(
        join(clusterDir, "server.json"),
        JSON.stringify({
          pid: exitedPid,
          port: foreignPort,
          baseUrl: `http://127.0.0.1:${foreignPort}`,
          canonicalRepoRoot: "/other/repo",
          updatedAt: null,
        }),
      )

      const origHome = process.env.HOME
      const origUrl = process.env.OMNIGRAPH_URL
      try {
        process.env.HOME = fakeHome
        Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
        const ready = await Effect.runPromise(ensureLocalOmnigraphReady(dir))
        expect(ready).toBe(false)
      } finally {
        foreignServer.closeAllConnections()
        foreignServer.close()
        if (origHome !== undefined) process.env.HOME = origHome
        else Reflect.deleteProperty(process.env, "HOME")
        if (origUrl !== undefined) process.env.OMNIGRAPH_URL = origUrl
        else Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      }
    })
  })

  it("S-1: handleDone surfaces corrupt transcript reason to stderr and block reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-s1-corrupt-"))
    try {
      const transcriptPath = join(dir, "transcript.jsonl")
      writeFileSync(transcriptPath, "{not-valid-json\n", "utf8")
      const res = await Effect.runPromise(
        handleDone(["done", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
          stdin: JSON.stringify({
            stop_hook_active: false,
            transcriptPath,
          }),
        }),
      )
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toContain("Corrupt transcript JSONL line 1")
      const parsed = JSON.parse(res.stdout) as { decision: string; reason: string }
      expect(parsed.decision).toBe("continue")
      expect(parsed.reason).toContain("Corrupt transcript JSONL line 1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("S-3: runDeclarativeCli rejects mixed command and -v/--version or -h/--help flags with exitCode 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-s3-version-"))
    try {
      const res = await Effect.runPromise(
        runDeclarativeCli(["gc", "--strict", "-v"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(res.exitCode).toBe(1)

      const vGuardRes = await Effect.runPromise(
        runDeclarativeCli(["-v", "guard"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(vGuardRes.exitCode).not.toBe(0)

      const hDoneRes = await Effect.runPromise(
        runDeclarativeCli(["-h", "done"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(hDoneRes.exitCode).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("denies --skip-nx-cache in guard with explicit reason", async () => {
    const res = await Effect.runPromise(
      runDeclarativeCli(["guard", "--format=antigravity"], {
        skipBackgroundDaemons: true,
        stdin: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm nx run gates:verify --skip-nx-cache" },
          },
        }),
      }),
    )
    expect(res.exitCode).toBe(0)
    const parsed = JSON.parse(res.stdout) as { decision: string; reason?: string }
    expect(parsed.decision).toBe("deny")
    expect(parsed.reason).toContain("--skip-nx-cache")
  })

  it("caches session --format=antigravity PreInvocation and invalidates on friction-log.jsonl or tracked git file change", async () => {
    const { execFileSync } = await import("node:child_process")
    const dir = mkdtempSync(join(tmpdir(), "harness-session-fastpath-"))
    try {
      mkdirSync(join(dir, "libs", "demo", "src"), { recursive: true })
      writeFileSync(
        join(dir, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { plugins: [{ name: "@effect/language-service" }] } }),
        "utf8",
      )
      mkdirSync(join(dir, "node_modules", "@effect", "tsgo"), { recursive: true })
      writeFileSync(join(dir, "node_modules", "@effect", "tsgo", "package.json"), "{}", "utf8")
      const trackedFile = join(dir, "libs", "demo", "src", "mod.ts")
      writeFileSync(trackedFile, "export const v = 1\n", "utf8")
      execFileSync("git", ["init"], { cwd: dir })
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir })

      const first = await Effect.runPromise(
        runDeclarativeCli(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(first.exitCode).toBe(0)
      const cachePath = join(dir, ".harness", "session-preinvocation-cache.json")
      expect(existsSync(cachePath)).toBe(true)

      const second = await Effect.runPromise(
        runDeclarativeCli(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(second.exitCode).toBe(0)
      expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout))

      const { tryReadPreInvocationSessionCache } =
        await import("../src/commands/session-fastpath.js")
      expect(
        tryReadPreInvocationSessionCache(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        })._tag,
      ).toBe("Some")

      writeFileSync(
        join(dir, ".harness", "friction-log.jsonl"),
        `${JSON.stringify({ timestamp: new Date().toISOString(), kind: "route_miss", summary: "s", detail: "d" })}\n`,
        "utf8",
      )
      expect(
        tryReadPreInvocationSessionCache(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        })._tag,
      ).toBe("None")

      const third = await Effect.runPromise(
        runDeclarativeCli(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(third.exitCode).toBe(0)
      expect(
        tryReadPreInvocationSessionCache(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        })._tag,
      ).toBe("Some")

      writeFileSync(trackedFile, "export const v = 2\n", "utf8")
      expect(
        tryReadPreInvocationSessionCache(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        })._tag,
      ).toBe("None")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("enforces PreInvocation cache TTL expiry, future timestamp, HARNESS_REQUIRE_OLLAMA=1, corrupt JSON, symlink rejection, and verify-stamp invalidation", async () => {
    const { execFileSync } = await import("node:child_process")
    const { symlinkSync } = await import("node:fs")
    const { PRE_INVOCATION_CACHE_TTL_MS, tryReadPreInvocationSessionCache } =
      await import("../src/commands/session-fastpath.js")
    const dir = mkdtempSync(join(tmpdir(), "harness-session-hardening-"))
    try {
      mkdirSync(join(dir, "libs", "demo", "src"), { recursive: true })
      writeFileSync(
        join(dir, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { plugins: [{ name: "@effect/language-service" }] } }),
        "utf8",
      )
      mkdirSync(join(dir, "node_modules", "@effect", "tsgo"), { recursive: true })
      writeFileSync(join(dir, "node_modules", "@effect", "tsgo", "package.json"), "{}", "utf8")
      writeFileSync(join(dir, "libs", "demo", "src", "mod.ts"), "export const v = 1\n", "utf8")
      execFileSync("git", ["init"], { cwd: dir })
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir })

      const opts = { repoRoot: dir, skipBackgroundDaemons: true } as const
      const first = await Effect.runPromise(
        runDeclarativeCli(["session", "--format=antigravity"], opts),
      )
      expect(first.exitCode).toBe(0)
      const cachePath = join(dir, ".harness", "session-preinvocation-cache.json")
      const originalRaw = readFileSync(cachePath, "utf8")
      const original = JSON.parse(originalRaw) as Record<string, unknown>

      // 1. > 300_000ms TTL expiry miss
      expect(PRE_INVOCATION_CACHE_TTL_MS).toBe(300_000)
      writeFileSync(
        cachePath,
        JSON.stringify({
          ...original,
          recordedAtMs: Date.now() - PRE_INVOCATION_CACHE_TTL_MS - 10,
        }),
        "utf8",
      )
      expect(tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag).toBe(
        "None",
      )

      // 2. Future recordedAtMs (now + 5_000) rejection
      writeFileSync(
        cachePath,
        JSON.stringify({ ...original, recordedAtMs: Date.now() + 5_000 }),
        "utf8",
      )
      expect(tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag).toBe(
        "None",
      )

      // 3. HARNESS_REQUIRE_OLLAMA=1 cache bypass
      writeFileSync(cachePath, originalRaw, "utf8")
      const prevRequireOllama = process.env.HARNESS_REQUIRE_OLLAMA
      process.env.HARNESS_REQUIRE_OLLAMA = "1"
      try {
        expect(
          tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag,
        ).toBe("None")
      } finally {
        if (prevRequireOllama === undefined)
          Reflect.deleteProperty(process.env, "HARNESS_REQUIRE_OLLAMA")
        else process.env.HARNESS_REQUIRE_OLLAMA = prevRequireOllama
      }

      // 4. Corrupt JSON rejection
      writeFileSync(cachePath, "{not-valid-json", "utf8")
      expect(tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag).toBe(
        "None",
      )

      // 5. Symlinked cache file rejection
      const outsideTarget = join(dir, "outside.json")
      writeFileSync(outsideTarget, originalRaw, "utf8")
      rmSync(cachePath, { force: true })
      symlinkSync(outsideTarget, cachePath)
      expect(tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag).toBe(
        "None",
      )
      rmSync(cachePath, { force: true })
      rmSync(outsideTarget, { force: true })

      // 5b. Dangling symlink at cachePath is rejected even though existsSync is false
      symlinkSync("/nonexistent/dangling-target", cachePath)
      expect(tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag).toBe(
        "None",
      )
      rmSync(cachePath, { force: true })

      // 6. Modifying .harness/verify-stamp.json invalidates PreInvocation cache
      writeFileSync(cachePath, originalRaw, "utf8")
      expect(tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag).toBe(
        "Some",
      )
      writeFileSync(join(dir, ".harness", "verify-stamp.json"), '{"valid":true}\n', "utf8")
      expect(tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag).toBe(
        "None",
      )

      // 7. Non-root gitignored file (.env.local) invalidates PreInvocation cache
      rmSync(join(dir, ".harness", "verify-stamp.json"), { force: true })
      writeFileSync(join(dir, ".gitignore"), "*.local\n", "utf8")
      execFileSync("git", ["add", ".gitignore"], { cwd: dir })
      execFileSync("git", ["commit", "-m", "gitignore"], { cwd: dir })
      const rewarm = await Effect.runPromise(
        runDeclarativeCli(["session", "--format=antigravity"], opts),
      )
      expect(rewarm.exitCode).toBe(0)
      expect(tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag).toBe(
        "Some",
      )
      writeFileSync(join(dir, "libs", "demo", ".env.local"), "SECRET=1\n", "utf8")
      expect(tryReadPreInvocationSessionCache(["session", "--format=antigravity"], opts)._tag).toBe(
        "None",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("never loads typescript on route or warm session --format=antigravity", async () => {
    const { execFileSync, spawnSync } = await import("node:child_process")
    const repoRoot = resolve(import.meta.dirname, "../../..")

    // Check route cold start
    const routeRes = spawnSync(
      process.execPath,
      [
        "--import",
        "./tools/node-ts-resolver.mjs",
        "apps/harness-cli/src/index.ts",
        "route",
        "plan",
        "domain",
        "usecase",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_DEBUG: "module",
          HARNESS_DISABLE_LIVE_TELEMETRY: "1",
        },
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    )
    expect(routeRes.status).toBe(0)
    expect(routeRes.stderr).not.toContain("node_modules/typescript")

    // Check warm session --format=antigravity
    const dir = mkdtempSync(join(tmpdir(), "harness-warm-session-cold-"))
    try {
      mkdirSync(join(dir, "libs", "demo", "src"), { recursive: true })
      writeFileSync(
        join(dir, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { plugins: [{ name: "@effect/language-service" }] } }),
        "utf8",
      )
      mkdirSync(join(dir, "node_modules", "@effect", "tsgo"), { recursive: true })
      writeFileSync(join(dir, "node_modules", "@effect", "tsgo", "package.json"), "{}", "utf8")
      writeFileSync(join(dir, "libs", "demo", "src", "mod.ts"), "export const v = 1\n", "utf8")
      execFileSync("git", ["init"], { cwd: dir })
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir })

      // Prime cache in-process
      const prime = await Effect.runPromise(
        runDeclarativeCli(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(prime.exitCode).toBe(0)

      // Run warm session in a fresh subprocess from dir with NODE_DEBUG=module
      const warmRes = spawnSync(
        process.execPath,
        [
          "--import",
          resolve(repoRoot, "tools/node-ts-resolver.mjs"),
          resolve(repoRoot, "apps/harness-cli/src/index.ts"),
          "session",
          "--format=antigravity",
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            NODE_DEBUG: "module",
            HARNESS_DISABLE_LIVE_TELEMETRY: "1",
          },
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        },
      )
      expect(warmRes.status).toBe(0)
      expect(warmRes.stderr).not.toContain("node_modules/typescript")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("F-4.3b & S-4.3: triage hint omits self-bypass; guard asks + audits HARNESS_ALLOW_SKIP_NX_CACHE=1 and denies --skipNxCache / NX_*_NX_CACHE", async () => {
    const rule = DETERMINISTIC_TRIAGE_RULES.find((r) => r.id === "skip-nx-cache-banned")
    expect(rule).toBeDefined()
    expect(rule?.result.hint).not.toContain("HARNESS_ALLOW_SKIP_NX_CACHE")

    for (const cmd of [
      "pnpm nx run gates:verify --skipNxCache",
      "NX_SKIP_NX_CACHE=true pnpm nx run gates:verify",
      "NX_DISABLE_NX_CACHE=true pnpm nx run gates:verify",
    ]) {
      const denyRes = await Effect.runPromise(
        runDeclarativeCli(["guard", "--format=antigravity"], {
          skipBackgroundDaemons: true,
          stdin: JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd } } }),
        }),
      )
      expect(denyRes.exitCode).toBe(0)
      expect((JSON.parse(denyRes.stdout) as { decision: string }).decision).toBe("deny")
    }

    const dir = mkdtempSync(join(tmpdir(), "harness-skip-nx-audit-"))
    const stderrWrites: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      const askRes = await Effect.runPromise(
        runDeclarativeCli(["guard", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
          stdin: JSON.stringify({
            toolCall: {
              name: "run_command",
              args: {
                CommandLine:
                  "HARNESS_ALLOW_SKIP_NX_CACHE=1 pnpm nx run gates:verify --skip-nx-cache",
              },
            },
          }),
        }),
      )
      expect(askRes.exitCode).toBe(0)
      expect((JSON.parse(askRes.stdout) as { decision: string }).decision).toBe("ask")
      expect(stderrWrites.join("")).toContain(
        "[harness:guard] Audit: HARNESS_ALLOW_SKIP_NX_CACHE=1 override requested human confirmation.",
      )
      const frictionRaw = readFileSync(join(dir, ".harness", "friction-log.jsonl"), "utf8")
      expect(frictionRaw).toContain("ruleId=skip-nx-cache-override; verdict=ask")
    } finally {
      process.stderr.write = origWrite
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-10.1 & F-10.2: fast-path cache hit replays stderr verbatim and records cache=hit telemetry", async () => {
    const { execFileSync } = await import("node:child_process")
    const { tryReadPreInvocationSessionCache, writePreInvocationSessionCache } =
      await import("../src/commands/session-fastpath.js")
    const dir = mkdtempSync(join(tmpdir(), "harness-session-telemetry-"))
    try {
      mkdirSync(join(dir, "libs", "demo", "src"), { recursive: true })
      writeFileSync(
        join(dir, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { plugins: [{ name: "@effect/language-service" }] } }),
        "utf8",
      )
      mkdirSync(join(dir, "node_modules", "@effect", "tsgo"), { recursive: true })
      writeFileSync(join(dir, "node_modules", "@effect", "tsgo", "package.json"), "{}", "utf8")
      writeFileSync(join(dir, "libs", "demo", "src", "mod.ts"), "export const v = 1\n", "utf8")
      execFileSync("git", ["init"], { cwd: dir })
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir })

      const first = await Effect.runPromise(
        runCliEffect(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(first.exitCode).toBe(0)

      // REQ-3.2: non-empty friction-log.jsonl must not self-invalidate on telemetry-log.jsonl appends
      writeFileSync(join(dir, ".harness", "friction-log.jsonl"), '{"kind":"note"}\n', "utf8")
      const warmedWithFriction = await Effect.runPromise(
        runCliEffect(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(warmedWithFriction.exitCode).toBe(0)

      const second = await Effect.runPromise(
        runCliEffect(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(second.exitCode).toBe(0)
      expect(second.telemetryDetail).toBe("cache=hit")

      // REQ-3.2: `done` writes last-done.json and invalidates SessionHandoff.decide cache (cache=miss)
      writeVerifyStamp(dir, nodeSyncHostIo, "impl/test", {
        dstSeed: DstSeed.make(1),
        dstSeedsRun: 1,
      })
      const doneRes = await Effect.runPromise(
        runCliEffect(["done"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
          stdin: JSON.stringify({ stop_hook_active: false }),
        }),
      )
      expect(doneRes.exitCode).toBe(0)
      expect(existsSync(join(dir, ".harness", "last-done.json"))).toBe(true)
      const { result: afterDone } = await Effect.runPromise(
        runWithTestTracer(
          "session-after-done",
          runCliEffect(["session", "--format=antigravity"], {
            repoRoot: dir,
            skipBackgroundDaemons: true,
          }),
          new Map(),
        ),
      )
      expect(afterDone.exitCode).toBe(0)
      expect(afterDone.telemetryDetail).toBe("cache=miss")

      const telemetryLines = readFileSync(join(dir, ".harness", "telemetry-log.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { detail?: string; toolName?: string })
      expect(telemetryLines.some((e) => e.toolName === "session" && e.detail === "cache=hit")).toBe(
        true,
      )

      const cachePath = join(dir, ".harness", "session-preinvocation-cache.json")
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
        fingerprint: string
        ollamaReady: boolean
        ollamaProbed: boolean
        injectSteps: ReadonlyArray<string>
      }
      writePreInvocationSessionCache(dir, join(dir, ".harness"), {
        fingerprint: cached.fingerprint,
        recordedAtMs: Date.now(),
        ollamaReady: cached.ollamaReady,
        ollamaProbed: cached.ollamaProbed,
        injectSteps: cached.injectSteps,
        stderr: "[harness:session] Warning: preserved stderr",
      })
      const hit = tryReadPreInvocationSessionCache(["session", "--format=antigravity"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
      })
      expect(hit._tag).toBe("Some")
      match(hit)
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value.stderr).toBe("[harness:session] Warning: preserved stderr")
        })
        .with({ _tag: "None" }, () => {
          expect.unreachable()
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("F-15.1b: warm in-process handleGuard and handleRoute complete well under 50ms p50/p95", async () => {
    const guardOpts = {
      skipBackgroundDaemons: true,
      decisionLayer: makeMockDecisionModelLayer({
        destructiveProb: 0.05,
        secretAccessProb: 0.05,
        exfiltrationProb: 0.05,
      }),
      stdin: JSON.stringify({
        toolCall: { name: "run_command", args: { CommandLine: "git status" } },
      }),
    }
    const routeOpts = {
      skipBackgroundDaemons: true,
      decisionLayer: makeMockDecisionModelLayer({
        fitsAnyProb: 0.9,
        blockLabel: "pattern-matching",
      }),
    }
    for (let i = 0; i < 5; i++) {
      await Effect.runPromise(handleGuard(["guard", "--format=antigravity"], guardOpts))
      await Effect.runPromise(handleRoute(["route", "plan", "domain", "usecase"], routeOpts))
    }
    const measure = async (fn: () => Promise<unknown>): Promise<{ p50: number; p95: number }> => {
      const samples: Array<number> = []
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now()
        await fn()
        samples.push(performance.now() - t0)
      }
      samples.sort((a, b) => a - b)
      return {
        p50: samples[Math.floor(samples.length * 0.5)] ?? 0,
        p95: samples[Math.floor(samples.length * 0.95)] ?? 0,
      }
    }
    const guardStats = await measure(() =>
      Effect.runPromise(handleGuard(["guard", "--format=antigravity"], guardOpts)),
    )
    const routeStats = await measure(() =>
      Effect.runPromise(handleRoute(["route", "plan", "domain", "usecase"], routeOpts)),
    )
    expect(guardStats.p50).toBeLessThan(50)
    expect(guardStats.p95).toBeLessThan(50)
    expect(routeStats.p50).toBeLessThan(50)
    expect(routeStats.p95).toBeLessThan(50)
  })

  it("F-16.6: pre-invocation fingerprint invalidation and safe cache dir handling", async () => {
    const { execFileSync } = await import("node:child_process")
    const { renameSync, symlinkSync } = await import("node:fs")
    const {
      computePreInvocationFingerprint,
      resolveHarnessStateDirSafe,
      tryReadPreInvocationSessionCache,
      writePreInvocationSessionCache,
    } = await import("../src/commands/session-fastpath.js")

    const prevStateDir = process.env.HARNESS_STATE_DIR
    process.env.HARNESS_STATE_DIR = "."
    const stderrLogs: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLogs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      expect(resolveHarnessStateDirSafe(REPO_ROOT)._tag).toBe("None")
      expect(stderrLogs.join("")).toContain("invalid HARNESS_STATE_DIR")
    } finally {
      process.stderr.write = origWrite
      if (prevStateDir === undefined) Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      else process.env.HARNESS_STATE_DIR = prevStateDir
    }

    const outer = mkdtempSync(join(tmpdir(), "harness-fp-outer-"))
    const symParent = join(outer, "sym-parent")
    const realParent = join(outer, "real-parent")
    mkdirSync(realParent, { recursive: true })
    symlinkSync(realParent, symParent)
    const dir = join(symParent, "repo")
    mkdirSync(join(dir, "libs", "demo", "src"), { recursive: true })
    try {
      writeFileSync(
        join(dir, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { plugins: [{ name: "@effect/language-service" }] } }),
        "utf8",
      )
      mkdirSync(join(dir, "node_modules", "@effect", "tsgo"), { recursive: true })
      writeFileSync(join(dir, "node_modules", "@effect", "tsgo", "package.json"), "{}", "utf8")
      const tracked = join(dir, "libs", "demo", "src", "file with spaces.ts")
      writeFileSync(tracked, "export const a = 1\n", "utf8")
      execFileSync("git", ["init"], { cwd: dir })
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir })

      const hDir = join(dir, ".harness")
      const fp0 = computePreInvocationFingerprint(dir, hDir, nodeSyncHostIo)
      expect(fp0._tag).toBe("Some")

      // S-5.2a: symlinked ancestor above repoRoot still allows cache write & read
      match(fp0)
        .with({ _tag: "Some" }, ({ value: fpVal }) => {
          writePreInvocationSessionCache(dir, hDir, {
            fingerprint: fpVal,
            recordedAtMs: Date.now(),
            ollamaReady: true,
            ollamaProbed: true,
            injectSteps: [],
            stderr: "",
          })
          expect(
            tryReadPreInvocationSessionCache(["session", "--format=antigravity"], {
              repoRoot: dir,
            })._tag,
          ).toBe("Some")
        })
        .with({ _tag: "None" }, () => {
          expect.unreachable()
        })
        .exhaustive()

      // Untracked file invalidates
      const untracked = join(dir, "libs", "demo", "src", "new file.ts")
      writeFileSync(untracked, "export const b = 2\n", "utf8")
      const fpUntracked = computePreInvocationFingerprint(dir, hDir, nodeSyncHostIo)
      expect(fpUntracked._tag).toBe("Some")
      expect(fpUntracked).not.toEqual(fp0)
      rmSync(untracked, { force: true })

      // S-2.1: Renamed file with spaces invalidates
      const renamed = join(dir, "libs", "demo", "src", "renamed file.ts")
      renameSync(tracked, renamed)
      const fpRenamed = computePreInvocationFingerprint(dir, hDir, nodeSyncHostIo)
      expect(fpRenamed._tag).toBe("Some")
      expect(fpRenamed).not.toEqual(fp0)

      // Deleted file invalidates
      rmSync(renamed, { force: true })
      const fpDeleted = computePreInvocationFingerprint(dir, hDir, nodeSyncHostIo)
      expect(fpDeleted._tag).toBe("Some")
      expect(fpDeleted).not.toEqual(fpRenamed)
      execFileSync("git", ["checkout", "--", "."], { cwd: dir })

      // .env change invalidates
      writeFileSync(join(dir, ".env"), "FOO=bar\n", "utf8")
      const fpEnv = computePreInvocationFingerprint(dir, hDir, nodeSyncHostIo)
      expect(fpEnv._tag).toBe("Some")
      expect(fpEnv).not.toEqual(fp0)
      rmSync(join(dir, ".env"), { force: true })

      // HARNESS_OLLAMA_URL change invalidates
      const prevOllamaUrl = process.env.HARNESS_OLLAMA_URL
      process.env.HARNESS_OLLAMA_URL = "http://127.0.0.1:19999"
      try {
        const fpUrl = computePreInvocationFingerprint(dir, hDir, nodeSyncHostIo)
        expect(fpUrl._tag).toBe("Some")
        expect(fpUrl).not.toEqual(fp0)
      } finally {
        if (prevOllamaUrl === undefined) Reflect.deleteProperty(process.env, "HARNESS_OLLAMA_URL")
        else process.env.HARNESS_OLLAMA_URL = prevOllamaUrl
      }

      // F-9.1: Broken symlink aborts fingerprinting to Option.none()
      symlinkSync(join(dir, "does-not-exist"), join(dir, ".env"))
      expect(computePreInvocationFingerprint(dir, hDir, nodeSyncHostIo)._tag).toBe("None")
      rmSync(join(dir, ".env"), { force: true })

      // F-11.1: Git timeout aborts fingerprinting to Option.none()
      const timedOutIo = {
        ...nodeSyncHostIo,
        execFileSync: () => ({ _tag: "TimedOut" as const, stdout: "", stderr: "" }),
      }
      expect(computePreInvocationFingerprint(dir, hDir, timedOutIo)._tag).toBe("None")

      // S-5.1: Failed cache write emits stderr warning
      const errLogs: Array<string> = []
      const origErrWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array) => {
        errLogs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
        return true
      }) as typeof process.stderr.write
      try {
        writePreInvocationSessionCache(
          dir,
          hDir,
          {
            fingerprint: "0".repeat(64),
            recordedAtMs: Date.now(),
            ollamaReady: true,
            ollamaProbed: true,
            injectSteps: [],
            stderr: "",
          },
          {
            ...nodeSyncHostIo,
            writeTextSync: () => {
              throw new Error("disk full")
            },
          },
        )
        expect(errLogs.join("")).toContain("Failed to write hook session cache")
      } finally {
        process.stderr.write = origErrWrite
      }
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  }, 30_000)

  it("F-9.a / F-9.b: fastpath returns None on null git head state and guards throwing existsSync", async () => {
    const { computePreInvocationFingerprint, resolveHarnessTsgoPkgJsonPath } =
      await import("../src/commands/session-fastpath.js")
    const dir = mkdtempSync(join(tmpdir(), "harness-fastpath-f9-"))
    try {
      mkdirSync(join(dir, ".git"), { recursive: true })
      const nullHeadIo = {
        ...nodeSyncHostIo,
        execFileSync: () => ({ _tag: "Exited" as const, exitCode: 0, stdout: "", stderr: "" }),
      }
      expect(computePreInvocationFingerprint(dir, join(dir, ".harness"), nullHeadIo)._tag).toBe(
        "None",
      )

      const throwingExistsIo = {
        ...nodeSyncHostIo,
        existsSync: () => {
          throw new Error("EIO: existsSync failed")
        },
      }
      expect(() => resolveHarnessTsgoPkgJsonPath(dir, throwingExistsIo)).not.toThrow()
      expect(
        computePreInvocationFingerprint(dir, join(dir, ".harness"), throwingExistsIo)._tag,
      ).toBe("None")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-11.a: resolveCliInfraLayer fails closed when HarnessInfraLive import fails", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const rejectImport = () => Promise.reject(new Error("module load failed"))

      const doneAgy = await Effect.runPromise(
        resolveCliInfraLayer("done", ["done", "--format=antigravity"], false, {
          importInfraModule: rejectImport,
        }),
      )
      expect(doneAgy._tag).toBe("FailClosed")
      match(doneAgy)
        .with({ _tag: "FailClosed" }, ({ result }) => {
          expect(result.exitCode).toBe(0)
          expect(JSON.parse(result.stdout)).toMatchObject({
            decision: "continue",
            reason: expect.stringContaining("Failed to load HarnessInfraLive"),
          })
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable()
        })
        .exhaustive()

      const verifyRes = await Effect.runPromise(
        resolveCliInfraLayer("verify", ["verify"], false, {
          importInfraModule: rejectImport,
        }),
      )
      expect(verifyRes._tag).toBe("FailClosed")
      match(verifyRes)
        .with({ _tag: "FailClosed" }, ({ result }) => {
          expect(result.exitCode).toBe(1)
          expect(result.stderr).toContain("Failed to load HarnessInfraLive")
        })
        .with({ _tag: "Ok" }, () => {
          expect.unreachable()
        })
        .exhaustive()
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("F-11.4: session-fastpath rejects symlinked .harness dir and symlinked session-preinvocation-cache.json", async () => {
    const { symlinkSync } = await import("node:fs")
    const { execFileSync } = await import("node:child_process")
    const {
      computePreInvocationFingerprint,
      tryReadPreInvocationSessionCache,
      writePreInvocationSessionCache,
    } = await import("../src/commands/session-fastpath.js")
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const dir = mkdtempSync(join(tmpdir(), "harness-f114-symlink-"))
    const outsideDir = mkdtempSync(join(tmpdir(), "harness-f114-outside-"))
    try {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
      writeFileSync(
        join(dir, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { plugins: [{ name: "@effect/language-service" }] } }),
        "utf8",
      )
      mkdirSync(join(dir, "node_modules", "@effect", "tsgo"), { recursive: true })
      writeFileSync(join(dir, "node_modules", "@effect", "tsgo", "package.json"), "{}", "utf8")
      execFileSync("git", ["init"], { cwd: dir })
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir })

      // 1. Symlinked .harness directory is rejected for both write and read
      const symlinkHarnessDir = join(dir, ".harness")
      symlinkSync(outsideDir, symlinkHarnessDir)
      const validEntry = {
        fingerprint: "a".repeat(64),
        recordedAtMs: Date.now(),
        ollamaReady: true,
        ollamaProbed: true,
        injectSteps: [],
        stderr: "",
      }
      writePreInvocationSessionCache(dir, symlinkHarnessDir, validEntry)
      expect(existsSync(join(outsideDir, "session-preinvocation-cache.json"))).toBe(false)
      writeFileSync(
        join(outsideDir, "session-preinvocation-cache.json"),
        JSON.stringify({ version: "session-preinvocation-v1", ...validEntry }),
        "utf8",
      )
      expect(
        tryReadPreInvocationSessionCache(["session", "--format=antigravity"], { repoRoot: dir })
          ._tag,
      ).toBe("None")

      // 2. Real .harness directory with symlinked session-preinvocation-cache.json is rejected
      rmSync(symlinkHarnessDir, { force: true })
      mkdirSync(symlinkHarnessDir, { recursive: true })
      const fpOpt = computePreInvocationFingerprint(dir, symlinkHarnessDir, nodeSyncHostIo)
      expect(fpOpt._tag).toBe("Some")
      const fpVal = match(fpOpt)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => expect.unreachable())
        .exhaustive()
      const outsideCacheFile = join(outsideDir, "real-cache.json")
      writeFileSync(
        outsideCacheFile,
        JSON.stringify({
          version: "session-preinvocation-v1",
          ...validEntry,
          fingerprint: fpVal,
        }),
        "utf8",
      )
      symlinkSync(outsideCacheFile, join(symlinkHarnessDir, "session-preinvocation-cache.json"))
      expect(
        tryReadPreInvocationSessionCache(["session", "--format=antigravity"], { repoRoot: dir })
          ._tag,
      ).toBe("None")
    } finally {
      stderrSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it("F-11.5: handleDoctorOrSession recovers when decisionLayer dies and exits 0 with modelWarm: false", async () => {
    const { execFileSync } = await import("node:child_process")
    const { handleDoctorOrSession } =
      await import("../src/commands/session-learn-report.command.js")
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const dir = mkdtempSync(join(tmpdir(), "harness-f115-decision-die-"))
    try {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
      writeFileSync(
        join(dir, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { plugins: [{ name: "@effect/language-service" }] } }),
        "utf8",
      )
      mkdirSync(join(dir, "node_modules", "@effect", "tsgo"), { recursive: true })
      writeFileSync(join(dir, "node_modules", "@effect", "tsgo", "package.json"), "{}", "utf8")
      execFileSync("git", ["init"], { cwd: dir })
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir })

      const failingDecisionLayer = Layer.effect(
        DecisionModel.DecisionModel,
        Effect.die(new Error("boom")),
      )
      const res = await Effect.runPromise(
        handleDoctorOrSession(["session"], {
          repoRoot: dir,
          decisionLayer: failingDecisionLayer,
          skipBackgroundDaemons: true,
        }),
      )
      expect(res.exitCode).toBe(0)
      const parsed = JSON.parse(res.stdout) as { modelWarm: boolean }
      expect(parsed.modelWarm).toBe(false)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("[harness learn] decision model fallback:"),
      )
    } finally {
      stderrSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("REQ-4.1: handleGuard enforces HARNESS_UNIT_WORKER=1 via CliEnv.env across commands and file reads while allowing complete/status/verify", async () => {
    const workerEnv = { HARNESS_UNIT_WORKER: "1" } as const
    const nonWorkerEnv = { HARNESS_UNIT_WORKER: "0" } as const

    for (const cmd of [
      "pnpm harness workflow start --plan plan.json",
      "pnpm harness workflow resume --run-id wf-12345678",
      "pnpm harness workflow abort --run-id wf-12345678",
      "pnpm harness workflow done",
      "pnpm harness done",
      "pnpm --filter harness-cli start workflow start",
      "cat .git/harness/daemon.sock",
      "cat .harness/omnigraph-cluster/auth-tokens.*",
      "rg -u . .harness/omnigraph-cluster",
    ]) {
      const agyRes = await Effect.runPromise(
        handleGuard(["guard", "--format=antigravity"], {
          env: workerEnv,
          stdin: JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd } } }),
          skipBackgroundDaemons: true,
        }),
      )
      expect(agyRes.exitCode, cmd).toBe(0)
      expect(JSON.parse(agyRes.stdout)).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("HARNESS_UNIT_WORKER=1"),
      })

      const ccRes = await Effect.runPromise(
        handleGuard(["guard"], {
          env: workerEnv,
          stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
          skipBackgroundDaemons: true,
        }),
      )
      expect(ccRes.exitCode, cmd).toBe(2)
      expect(ccRes.stderr).toContain("HARNESS_UNIT_WORKER=1")
    }

    for (const stdinPayload of [
      JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/repo/.harness/omnigraph-cluster/auth-tokens.json" },
      }),
      JSON.stringify({
        toolCall: {
          name: "view_file",
          args: { AbsolutePath: "/repo/.git/harness/daemon.sock" },
        },
      }),
      JSON.stringify({
        toolCall: {
          name: "view_file_outline",
          args: { AbsolutePath: "/repo/auth-tokens.json" },
        },
      }),
      JSON.stringify({
        toolCall: {
          name: "view_code_item",
          args: { File: "/repo/.git/harness/daemon.sock" },
        },
      }),
      JSON.stringify({
        toolCall: {
          name: "find_by_name",
          args: { SearchDirectory: "/repo/.git/harness/daemon.sock" },
        },
      }),
      JSON.stringify({
        toolCall: {
          name: "read_file",
          args: { Path: "/repo/.harness/omnigraph-cluster/auth-tokens.json" },
        },
      }),
      JSON.stringify({
        toolCall: {
          name: "read_file",
          args: { Path: "/repo/.git/harness/daemon.sock" },
        },
      }),
      JSON.stringify({
        tool_name: "Glob",
        tool_input: { pattern: "**/*auth-tokens*" },
      }),
      JSON.stringify({
        tool_name: "Grep",
        tool_input: { pattern: ".", glob: "**/auth-tokens.json" },
      }),
    ]) {
      const res = await Effect.runPromise(
        handleGuard(["guard", "--format=antigravity"], {
          env: workerEnv,
          stdin: stdinPayload,
          skipBackgroundDaemons: true,
        }),
      )
      expect(res.exitCode).toBe(0)
      expect(JSON.parse(res.stdout)).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("HARNESS_UNIT_WORKER=1"),
      })
    }

    for (const allowedCmd of [
      "pnpm harness workflow complete --unit u1 --repo-root /tmp/repo",
      "pnpm harness workflow status --json",
      "nx run @harness/contract:verify",
    ]) {
      const res = await Effect.runPromise(
        handleGuard(["guard", "--format=antigravity"], {
          env: workerEnv,
          stdin: JSON.stringify({
            toolCall: { name: "run_command", args: { CommandLine: allowedCmd } },
          }),
          skipBackgroundDaemons: true,
        }),
      )
      expect(res.exitCode, allowedCmd).toBe(0)
      expect(JSON.parse(res.stdout)).toEqual({ decision: "allow" })
    }

    const normalReadRes = await Effect.runPromise(
      handleGuard(["guard"], {
        env: workerEnv,
        stdin: JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "libs/harness/contract/src/workflow.ts" },
        }),
        skipBackgroundDaemons: true,
      }),
    )
    expect(normalReadRes.exitCode).toBe(0)
    expect(normalReadRes.stdout).toBe("")

    const dir = mkdtempSync(join(tmpdir(), "harness-worker-guard-symlink-"))
    tempDirs.push(dir)
    const clusterDir = join(dir, ".harness", "omnigraph-cluster")
    mkdirSync(clusterDir, { recursive: true })
    const targetTokens = join(clusterDir, "auth-tokens.json")
    writeFileSync(targetTokens, JSON.stringify({ token: "secret" }), "utf8")
    const { symlinkSync } = await import("node:fs")
    const symlinkPath = join(dir, "alias-tokens.json")
    symlinkSync(targetTokens, symlinkPath)
    const symlinkReadRes = await Effect.runPromise(
      handleGuard(["guard", "--format=antigravity"], {
        env: workerEnv,
        stdin: JSON.stringify({ toolCall: { name: "read_file", args: { Path: symlinkPath } } }),
        skipBackgroundDaemons: true,
      }),
    )
    expect(symlinkReadRes.exitCode).toBe(0)
    expect(JSON.parse(symlinkReadRes.stdout)).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("HARNESS_UNIT_WORKER=1"),
    })

    const nonWorkerStartRes = await Effect.runPromise(
      handleGuard(["guard", "--format=antigravity"], {
        env: nonWorkerEnv,
        stdin: JSON.stringify({
          toolCall: {
            name: "run_command",
            args: { CommandLine: "pnpm harness workflow start --plan plan.json" },
          },
        }),
        skipBackgroundDaemons: true,
      }),
    )
    expect(nonWorkerStartRes.exitCode).toBe(0)
    expect(JSON.parse(nonWorkerStartRes.stdout)).toEqual({ decision: "allow" })

    // F-4.1: secret & harness-state reads denied even in non-worker mode
    for (const readInput of [
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: ".env" } }),
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: ".git/harness/daemon.sock" } }),
      JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: ".git/harness/auth-tokens.json" },
      }),
      JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: ".git/harness/workflow-backups/2026-11-20.ndjson" },
      }),
    ]) {
      const readDeny = await Effect.runPromise(
        handleGuard(["guard", "--format=antigravity"], {
          env: nonWorkerEnv,
          stdin: readInput,
          skipBackgroundDaemons: true,
        }),
      )
      expect(readDeny.exitCode).toBe(0)
      expect(JSON.parse(readDeny.stdout)).toMatchObject({ decision: "deny" })
    }

    // F-16.2: Grep/grep_search pattern/Query regexes allowed; Glob/SearchPath secret/harness paths denied
    const grepEnvPatternAllow = await Effect.runPromise(
      handleGuard(["guard", "--format=antigravity"], {
        env: nonWorkerEnv,
        stdin: JSON.stringify({
          tool_name: "Grep",
          tool_input: { pattern: "process\\.env", path: "libs/" },
        }),
        skipBackgroundDaemons: true,
      }),
    )
    expect(JSON.parse(grepEnvPatternAllow.stdout)).toEqual({ decision: "allow" })

    const agyGrepAllow = await Effect.runPromise(
      handleGuard(["guard", "--format=antigravity"], {
        env: nonWorkerEnv,
        stdin: JSON.stringify({
          toolCall: {
            name: "grep_search",
            args: { Query: "process.env", SearchPath: "libs/" },
          },
        }),
        skipBackgroundDaemons: true,
      }),
    )
    expect(JSON.parse(agyGrepAllow.stdout)).toEqual({ decision: "allow" })

    const globEnvDeny = await Effect.runPromise(
      handleGuard(["guard", "--format=antigravity"], {
        env: nonWorkerEnv,
        stdin: JSON.stringify({
          tool_name: "Glob",
          tool_input: { pattern: "**/.env*" },
        }),
        skipBackgroundDaemons: true,
      }),
    )
    expect(JSON.parse(globEnvDeny.stdout)).toMatchObject({ decision: "deny" })

    // F-16.1: deep nesting > 8 fails closed
    let deepPayload: Record<string, unknown> = { leaf: ".env" }
    for (let i = 0; i < 10; i++) {
      deepPayload = { child: deepPayload }
    }
    const deepDeny = await Effect.runPromise(
      handleGuard(["guard", "--format=antigravity"], {
        env: nonWorkerEnv,
        stdin: JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: "libs/a.ts", extra: deepPayload },
        }),
        skipBackgroundDaemons: true,
      }),
    )
    expect(JSON.parse(deepDeny.stdout)).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("maximum inspection depth"),
    })

    // F-3.6: non-existent file inside symlinked .git/harness dir fails closed
    const symHarnessAlias = join(dir, "sym-harness-dir")
    mkdirSync(join(dir, ".git", "harness"), { recursive: true })
    symlinkSync(join(dir, ".git", "harness"), symHarnessAlias)
    const symNewFileDeny = await Effect.runPromise(
      handleGuard(["guard", "--format=antigravity"], {
        env: nonWorkerEnv,
        stdin: JSON.stringify({
          toolCall: {
            name: "write_to_file",
            args: { TargetFile: join(symHarnessAlias, "new.sock") },
          },
        }),
        skipBackgroundDaemons: true,
      }),
    )
    expect(JSON.parse(symNewFileDeny.stdout)).toMatchObject({ decision: "deny" })

    // F-3.3 & F-3.4: worker mode blocks doctor, complete --phase llm, and nx run harness-cli:start
    for (const workerCmd of [
      "pnpm harness workflow doctor",
      "pnpm harness workflow complete --phase llm",
      "nx run harness-cli:start -- workflow abort",
    ]) {
      const workerDeny = await Effect.runPromise(
        handleGuard(["guard", "--format=antigravity"], {
          env: workerEnv,
          stdin: JSON.stringify({
            toolCall: { name: "run_command", args: { CommandLine: workerCmd } },
          }),
          skipBackgroundDaemons: true,
        }),
      )
      expect(JSON.parse(workerDeny.stdout), workerCmd).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("HARNESS_UNIT_WORKER=1"),
      })
    }
  })

  it("SPEC-0024 idempotent done: persists treeHash in last-done.json, short-circuits repeated Stop hooks with alreadyDone=true, and fails closed on stale/corrupt/mutated state", async () => {
    const { execFileSync } = await import("node:child_process")
    const { symlinkSync, utimesSync } = await import("node:fs")
    const { isAlreadyDoneForVerifiedTree, readLastDoneMarker } =
      await import("../src/commands/session-fastpath.js")

    const dir = mkdtempSync(join(tmpdir(), "harness-idempotent-done-"))
    tempDirs.push(dir)
    mkdirSync(join(dir, "libs", "demo", "src"), { recursive: true })
    writeFileSync(join(dir, "libs", "demo", "src", "mod.ts"), "export const v = 1\n", "utf8")
    execFileSync("git", ["init"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
    execFileSync("git", ["add", "."], { cwd: dir })
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir })

    const stamp = writeVerifyStamp(dir, nodeSyncHostIo, "impl/test", {
      dstSeed: DstSeed.make(1),
      dstSeedsRun: 1,
    })
    const emptyGraph = buildHarnessGraph({})
    const planSnapshotPath = join(dir, ".harness", "plan-graph-snapshot.json")
    const implSnapshotPath = join(dir, ".harness", "graph-snapshot.json")
    saveGraphSnapshot(emptyGraph, planSnapshotPath, nodeSyncHostIo)
    saveGraphSnapshot(emptyGraph, implSnapshotPath, nodeSyncHostIo)
    const pastSeconds = (Date.now() - 10_000) / 1000
    utimesSync(planSnapshotPath, pastSeconds, pastSeconds)

    // 1. First done persists { completedAt, treeHash } in .harness/last-done.json
    const firstDone = await Effect.runPromise(
      runCliEffect(["done"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
        stdin: JSON.stringify({ stop_hook_active: false }),
      }),
    )
    expect(firstDone.exitCode).toBe(0)
    const marker = readLastDoneMarker(dir, nodeSyncHostIo)
    expect(marker).toBeDefined()
    expect(marker?.treeHash).toBe(stamp.treeHash)

    // 2. Second handleDone short-circuits BEFORE loadSnapshotPair / syncOmnigraphOnDone even if
    //    plan-graph-snapshot.json remains on disk and graph-snapshot.json is corrupt
    writeFileSync(implSnapshotPath, "{corrupt-snapshot-should-not-be-read", "utf8")
    const secondDone = await Effect.runPromise(
      handleDone(["done", "--format=antigravity"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
        stdin: JSON.stringify({ stop_hook_active: false }),
      }),
    )
    expect(secondDone.exitCode).toBe(0)
    expect(JSON.parse(secondDone.stdout)).toEqual({ decision: "stop" })
    expect(secondDone.telemetryDetail).toBe("alreadyDone=true")

    // 3. Touching plan-graph-snapshot.json with a newer mtime invalidates alreadyDone=true
    const futureMs = Date.parse(marker!.completedAt) + 5_000
    utimesSync(planSnapshotPath, futureMs / 1000, futureMs / 1000)
    expect(isAlreadyDoneForVerifiedTree(dir, stamp, undefined, nodeSyncHostIo)).toBe(false)
    utimesSync(planSnapshotPath, pastSeconds, pastSeconds)
    expect(isAlreadyDoneForVerifiedTree(dir, stamp, undefined, nodeSyncHostIo)).toBe(true)

    // 4. Newer verify-stamp.json timestamp also invalidates alreadyDone=true
    const newerStamp = {
      ...stamp,
      timestamp: new Date(Date.parse(marker!.completedAt) + 5_000).toISOString(),
    }
    expect(isAlreadyDoneForVerifiedTree(dir, newerStamp, undefined, nodeSyncHostIo)).toBe(false)

    // 5. Editing a workspace file still blocks at checkVerifyStamp
    writeFileSync(join(dir, "libs", "demo", "src", "mod.ts"), "export const v = 2\n", "utf8")
    const dirtyDone = await Effect.runPromise(
      handleDone(["done", "--format=antigravity"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
        stdin: JSON.stringify({ stop_hook_active: false }),
      }),
    )
    expect(dirtyDone.exitCode).toBe(0)
    expect(JSON.parse(dirtyDone.stdout)).toMatchObject({
      decision: "continue",
      reason: expect.stringContaining("Workspace files changed since last verify"),
    })

    // 6. Corrupt or symlinked .harness/last-done.json fails closed
    const markerPath = join(dir, ".harness", "last-done.json")
    writeFileSync(markerPath, "{corrupt-json", "utf8")
    expect(readLastDoneMarker(dir, nodeSyncHostIo)).toBeUndefined()

    const outsideTarget = join(dir, "outside.json")
    writeFileSync(
      outsideTarget,
      JSON.stringify({ completedAt: new Date().toISOString(), treeHash: stamp.treeHash }),
      "utf8",
    )
    rmSync(markerPath)
    symlinkSync(outsideTarget, markerPath)
    expect(readLastDoneMarker(dir, nodeSyncHostIo)).toBeUndefined()
  })
})
