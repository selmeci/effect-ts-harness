import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it } from "vitest"
import { DETERMINISTIC_TRIAGE_RULES, makeMockDecisionModelLayer } from "@harness/decision"
import { CLEF_SYSTEMONE_ONLY_BANNED_REASON, DstSeed, writeVerifyStamp } from "@harness/gates"
import { buildHarnessGraph, saveGraphSnapshot } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { runWithTestTracer } from "@harness/ingest"
import { makeReadStdinEffect } from "../src/commands/daemon-and-omnigraph.service.js"
import { handleGuard, handleRoute } from "../src/commands/guard-and-route.command.js"
import { handleDone } from "../src/commands/verify-and-done.command.js"
import { runCliEffect, runDeclarativeCli } from "../src/index.js"
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

describe("hooks, stdin, declarative flags, hooks.json parity & fastpath", () => {
  const tempDirs: Array<string> = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
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
      ).toBe("Some")

      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-m", "second"], { cwd: dir })
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

      // 7. Non-root gitignored file (.env.local) keeps PreInvocation cache Hit; root .env invalidates
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
        "Some",
      )
      writeFileSync(join(dir, ".env"), "SECRET=1\n", "utf8")
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
