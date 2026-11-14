import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it } from "vitest"
import { makeMockDecisionModelLayer } from "@harness/decision"
import {
  ensureLocalOmnigraphReady,
  isLoopbackOmnigraphUrl,
  isSafeOmnigraphPidToKill,
  isValidLockId,
} from "../src/commands/omnigraph-lifecycle.js"
import { makeReadStdinEffect } from "../src/commands/daemon-and-omnigraph.service.js"
import { runDeclarativeCli, teardownCliMain } from "../src/index.js"
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
              expect(value.reason).toContain("Timed out reading stdin")
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
              expect(value.reason).toContain("exceeded maximum size")
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
      const res = await withMockedStdin(mockStdin, () =>
        runCli(["guard"], { stdinTimeoutMs: 30 }),
      )
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
        const idx = cmd.indexOf("index.ts ")
        expect(idx).toBeGreaterThan(-1)
        return cmd
          .slice(idx + "index.ts ".length)
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
              ? JSON.stringify({ stop_hook_active: false, fullyIdle: true })
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
        teardownCliMain(
          Exit.succeed(undefined),
          (code) => onExitCodes.push(code),
          (s) => stderrChunks.push(s),
          ["node", "index.ts", "guard"],
          (s) => stdoutChunks.push(s),
        )
        expect(process.exitCode).toBe(2)
        expect(onExitCodes).toEqual([2])

        // 2. Exit.fail normal (1)
        reset()
        teardownCliMain(
          Exit.fail("verify-err"),
          (code) => onExitCodes.push(code),
          (s) => stderrChunks.push(s),
          ["node", "index.ts", "verify"],
          (s) => stdoutChunks.push(s),
        )
        expect(stderrChunks.join("")).toContain("verify-err")
        expect(process.exitCode).toBe(1)
        expect(onExitCodes).toEqual([1])

        // 3. Exit.fail hook (2)
        reset()
        teardownCliMain(
          Exit.fail("guard-err"),
          (code) => onExitCodes.push(code),
          (s) => stderrChunks.push(s),
          ["node", "index.ts", "guard"],
          (s) => stdoutChunks.push(s),
        )
        expect(stderrChunks.join("")).toContain("guard-err")
        expect(process.exitCode).toBe(2)
        expect(onExitCodes).toEqual([2])

        // 4. Exit.die normal (1)
        reset()
        teardownCliMain(
          Exit.failCause(Cause.die(new Error("boom-normal"))),
          (code) => onExitCodes.push(code),
          (s) => stderrChunks.push(s),
          ["node", "index.ts", "verify"],
          (s) => stdoutChunks.push(s),
        )
        expect(stderrChunks.join("")).toContain("boom-normal")
        expect(process.exitCode).toBe(1)
        expect(onExitCodes).toEqual([1])

        // 5. Exit.die hook (2) + 3-token normalized argv
        reset()
        teardownCliMain(
          Exit.failCause(Cause.die(new Error("boom-hook"))),
          (code) => onExitCodes.push(code),
          (s) => stderrChunks.push(s),
          ["guard", "--format=claude", "--bogus"],
          (s) => stdoutChunks.push(s),
        )
        expect(stderrChunks.join("")).toContain("boom-hook")
        expect(process.exitCode).toBe(2)
        expect(onExitCodes).toEqual([2])

        // 6. Exit.interrupt (130)
        reset()
        teardownCliMain(
          Exit.interrupt(1),
          (code) => onExitCodes.push(code),
          (s) => stderrChunks.push(s),
          ["node", "index.ts", "guard"],
          (s) => stdoutChunks.push(s),
        )
        expect(process.exitCode).toBe(130)
        expect(onExitCodes).toEqual([130])

        // 7. Antigravity guard & done fail-closed stdout JSON
        reset()
        teardownCliMain(
          Exit.failCause(Cause.die(new Error("agy-guard-die"))),
          (code) => onExitCodes.push(code),
          (s) => stderrChunks.push(s),
          ["guard", "--format=antigravity"],
          (s) => stdoutChunks.push(s),
        )
        expect(JSON.parse(stdoutChunks.join(""))).toEqual({
          decision: "deny",
          reason: expect.stringContaining("agy-guard-die"),
        })

        reset()
        teardownCliMain(
          Exit.failCause(Cause.die(new Error("agy-done-die"))),
          (code) => onExitCodes.push(code),
          (s) => stderrChunks.push(s),
          ["done", "--format", "antigravity"],
          (s) => stdoutChunks.push(s),
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
  })
})
