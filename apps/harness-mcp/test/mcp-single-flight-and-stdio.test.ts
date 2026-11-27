import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { createMcpSingleFlightController, McpSingleFlight } from "../src/server.js"
import { runMcpStdioMain } from "../src/stdio-entrypoint.js"
import { isUncacheableSingleFlightKey } from "../src/tools/mcp-single-flight.js"

const tempDirs: Array<string> = []

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}

const makeTempWorkspace = (files: Readonly<Record<string, string>>, withGit = true): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sf-stdio-"))
  tempDirs.push(dir)
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, "utf8")
  }
  if (withGit) {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe", env: GIT_ENV })
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe", env: GIT_ENV })
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe", env: GIT_ENV })
  }
  return dir
}

const waitForCondition = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for stdio condition")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe("McpSingleFlight hardening (F-2.1, F-2.2, F-2.3, S-1.2) & runMcpStdioMain (S-3.3)", () => {
  it.effect(
    "F-2.1: editing already-dirty tracked files, staged diffs, or untracked file contents invalidates computeDigestKey",
    () =>
      Effect.gen(function* () {
        const repo = makeTempWorkspace({
          "libs/pkg/src/index.ts": "export const value = 1\n",
        })
        const controller = createMcpSingleFlightController()
        const trackedFile = path.join(repo, "libs/pkg/src/index.ts")
        const untrackedFile = path.join(repo, "libs/pkg/src/untracked.ts")

        // Make tracked file dirty (`M ` in git status)
        fs.writeFileSync(trackedFile, "export const value = 2\n", "utf8")
        let execCount = 0
        const runTool = () =>
          McpSingleFlight.run({
            controller,
            repoRoot: repo,
            toolName: "harness_ontology_check",
            args: { scope: "pkg" },
            effect: Effect.sync(() => {
              execCount += 1
              return { run: execCount }
            }),
          })

        const first = yield* runTool()
        const cached = yield* runTool()
        expect(first).toEqual({ run: 1 })
        expect(cached).toEqual({ run: 1 })
        expect(execCount).toBe(1)

        // Edit the ALREADY-dirty tracked file -> git status filename stays identical, content hash changes
        fs.writeFileSync(trackedFile, "export const value = 3\n", "utf8")
        const afterDirtyEdit = yield* runTool()
        expect(afterDirtyEdit).toEqual({ run: 2 })
        expect(execCount).toBe(2)

        // Stage the dirty tracked file -> git diff --cached changes
        execFileSync("git", ["add", "libs/pkg/src/index.ts"], {
          cwd: repo,
          stdio: "pipe",
          env: GIT_ENV,
        })
        const afterStage = yield* runTool()
        expect(afterStage).toEqual({ run: 3 })
        expect(execCount).toBe(3)

        // Create an untracked file and then edit its contents -> untracked SHA-256 changes
        fs.writeFileSync(untrackedFile, "export const draft = 'a'\n", "utf8")
        const afterUntrackedCreate = yield* runTool()
        expect(afterUntrackedCreate).toEqual({ run: 4 })

        fs.writeFileSync(untrackedFile, "export const draft = 'b'\n", "utf8")
        const afterUntrackedEdit = yield* runTool()
        expect(afterUntrackedEdit).toEqual({ run: 5 })
        expect(execCount).toBe(5)
      }),
  )

  it.effect(
    "F-2.2: git failure logs warning to stderr and bypasses cache while respecting maxConcurrency <= 2",
    () =>
      Effect.gen(function* () {
        const nonGitRepo = makeTempWorkspace(
          {
            "libs/pkg/src/index.ts": "export const x = 1\n",
          },
          false,
        )
        const controller = createMcpSingleFlightController({ maxConcurrency: 4 })
        const stderrChunks: Array<string> = []
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
          stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
          return true
        })

        try {
          const digestKey = yield* controller.computeDigestKey({
            repoRoot: nonGitRepo,
            toolName: "harness_review_route",
            args: { changedFiles: ["libs/pkg/src/index.ts"] },
          })
          expect(isUncacheableSingleFlightKey(digestKey)).toBe(true)
          expect(stderrChunks.join("")).toContain("[harness-mcp] single-flight git")
          expect(stderrChunks.join("")).toContain("bypassing cache")

          let calls = 0
          const runUncacheable = () =>
            McpSingleFlight.run({
              controller,
              repoRoot: nonGitRepo,
              toolName: "harness_review_route",
              args: { changedFiles: ["libs/pkg/src/index.ts"] },
              effect: Effect.sync(() => {
                calls += 1
                return { call: calls }
              }),
            })

          const r1 = yield* runUncacheable()
          const r2 = yield* runUncacheable()
          expect(r1).toEqual({ call: 1 })
          expect(r2).toEqual({ call: 2 })
          expect(calls).toBe(2)
          expect(controller.getStats().cacheSize).toBe(0)

          // Uncacheable executions still obey semaphore maxConcurrency <= 2
          const gate = yield* Deferred.make<void>()
          const twoStarted = yield* Deferred.make<void>()
          let active = 0
          let peak = 0
          const runBounded = (idx: number) =>
            controller.execute(
              `uncacheable:manual-${idx}`,
              Effect.gen(function* () {
                active += 1
                peak = Math.max(peak, active)
                if (active === 2) {
                  yield* Deferred.succeed(twoStarted, undefined)
                }
                yield* Deferred.await(gate)
                active -= 1
                return idx
              }),
            )
          const fiber = yield* Effect.forkChild(
            Effect.all([runBounded(1), runBounded(2), runBounded(3), runBounded(4)], {
              concurrency: "unbounded",
            }),
          )
          yield* Deferred.await(twoStarted)
          expect(peak).toBeLessThanOrEqual(2)
          yield* Deferred.succeed(gate, undefined)
          const boundedResults = yield* Fiber.join(fiber)
          expect(boundedResults).toEqual([1, 2, 3, 4])
          expect(peak).toBe(2)
          expect(controller.getStats().cacheSize).toBe(0)
        } finally {
          stderrSpy.mockRestore()
        }
      }),
  )

  it.effect(
    "F-2.3 & S-1.2: cacheTtlMs expires stale entries and clear() prevents in-flight pre-clear leaders from populating post-clear cache",
    () =>
      Effect.gen(function* () {
        const controller = createMcpSingleFlightController({ cacheTtlMs: 500 })
        let ttlRuns = 0
        const ttlEffect = Effect.sync(() => {
          ttlRuns += 1
          return { ttlRuns }
        })

        expect(yield* controller.execute("ttl-key", ttlEffect)).toEqual({ ttlRuns: 1 })
        yield* TestClock.adjust("400 millis")
        expect(yield* controller.execute("ttl-key", ttlEffect)).toEqual({ ttlRuns: 1 })
        expect(ttlRuns).toBe(1)

        yield* TestClock.adjust("100 millis")
        expect(yield* controller.execute("ttl-key", ttlEffect)).toEqual({ ttlRuns: 2 })
        expect(ttlRuns).toBe(2)

        // S-1.2: clear() while leader is in-flight prevents stale post-clear cache population
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let leaderCount = 0

        const preClearLeader = yield* Effect.forkChild(
          controller.execute(
            "race-key",
            Effect.gen(function* () {
              leaderCount += 1
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              return "pre-clear-value"
            }),
          ),
        )
        yield* Deferred.await(started)
        const preClearWaiter = yield* Effect.forkChild(
          controller.execute("race-key", Effect.succeed("should-coalesce-pre-clear")),
        )
        yield* Effect.yieldNow

        controller.clear()
        expect(controller.getStats().cacheSize).toBe(0)
        expect(controller.getStats().inFlightCount).toBe(0)

        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(preClearLeader)).toBe("pre-clear-value")
        expect(yield* Fiber.join(preClearWaiter)).toBe("pre-clear-value")
        expect(leaderCount).toBe(1)
        // Must NOT have populated post-clear cache
        expect(controller.getStats().cacheSize).toBe(0)

        const postClear = yield* controller.execute("race-key", Effect.succeed("fresh-post-clear"))
        expect(postClear).toBe("fresh-post-clear")
        expect(controller.getStats().cacheSize).toBe(1)
      }),
  )

  it("S-3.3: runMcpStdioMain handles connect success with signal/stdin shutdown and connect failure cleanly", async () => {
    const prevDaemonSock = process.env["HARNESS_DAEMON_SOCK"]
    const prevSkipWarmup = process.env["HARNESS_SKIP_OLLAMA_WARMUP"]
    const origProcessExit: unknown = Reflect.get(process, "exit")
    process.env["HARNESS_DAEMON_SOCK"] = "0"
    process.env["HARNESS_SKIP_OLLAMA_WARMUP"] = "1"

    try {
      // 1) Connect succeeds -> SIGINT triggers clean server.close() and process.exit(0)
      const signalHandlers = new Map<string, () => void>()
      const stdinHandlers = new Map<string, () => void>()
      const exitCodes1: Array<number | string | null | undefined> = []
      Reflect.set(process, "exit", (code?: number | string | null) => {
        exitCodes1.push(code)
      })
      const procOnceSpy = vi.spyOn(process, "once").mockImplementation(((
        event: string | symbol,
        listener: () => void,
      ) => {
        signalHandlers.set(String(event), listener)
        return process
      }) as typeof process.once)
      const stdinOnceSpy = vi.spyOn(process.stdin, "once").mockImplementation(((
        event: string | symbol,
        listener: () => void,
      ) => {
        stdinHandlers.set(String(event), listener)
        return process.stdin
      }) as typeof process.stdin.once)

      const server1 = new McpServer({ name: "test-stdio-ok", version: "0.0.0" })
      let capturedTransport: { onclose?: () => void } | undefined
      const connectSpy1 = vi.spyOn(server1, "connect").mockImplementation(async (transport) => {
        capturedTransport = transport
      })
      const closeSpy1 = vi.spyOn(server1, "close").mockResolvedValue(undefined)

      try {
        runMcpStdioMain(server1)
        await waitForCondition(
          () => connectSpy1.mock.calls.length === 1 && capturedTransport?.onclose !== undefined,
        )
        expect(signalHandlers.has("SIGINT")).toBe(true)
        expect(signalHandlers.has("SIGTERM")).toBe(true)
        expect(stdinHandlers.has("end")).toBe(true)
        expect(stdinHandlers.has("close")).toBe(true)

        // Trigger SIGINT and verify idempotency on second trigger (SIGTERM / stdin close)
        signalHandlers.get("SIGINT")?.()
        signalHandlers.get("SIGTERM")?.()
        stdinHandlers.get("close")?.()
        await waitForCondition(() => exitCodes1.length === 1)
        expect(closeSpy1).toHaveBeenCalledTimes(1)
        expect(exitCodes1).toEqual([0])
      } finally {
        procOnceSpy.mockRestore()
        stdinOnceSpy.mockRestore()
        connectSpy1.mockRestore()
        closeSpy1.mockRestore()
      }

      // 2) Connect fails -> logs fatal error to stderr and shuts down with exit code 1
      const stderrChunks: Array<string> = []
      const exitCodes2: Array<number | string | null | undefined> = []
      Reflect.set(process, "exit", (code?: number | string | null) => {
        exitCodes2.push(code)
      })
      const procOnceSpy2 = vi
        .spyOn(process, "once")
        .mockImplementation((() => process) as typeof process.once)
      const stdinOnceSpy2 = vi
        .spyOn(process.stdin, "once")
        .mockImplementation((() => process.stdin) as typeof process.stdin.once)
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
        return true
      })

      const server2 = new McpServer({ name: "test-stdio-fail", version: "0.0.0" })
      const connectSpy2 = vi
        .spyOn(server2, "connect")
        .mockRejectedValue(new Error("Simulated stdio transport bind failure"))
      const closeSpy2 = vi.spyOn(server2, "close").mockResolvedValue(undefined)

      try {
        runMcpStdioMain(server2)
        await waitForCondition(() => exitCodes2.length === 1)
        expect(closeSpy2).toHaveBeenCalledTimes(1)
        expect(exitCodes2).toEqual([1])
        expect(stderrChunks.join("")).toContain(
          "[harness-mcp] Fatal error: An error occurred in Effect.tryPromise",
        )
      } finally {
        procOnceSpy2.mockRestore()
        stdinOnceSpy2.mockRestore()
        stderrSpy.mockRestore()
        connectSpy2.mockRestore()
        closeSpy2.mockRestore()
      }
    } finally {
      Reflect.set(process, "exit", origProcessExit)
      if (prevDaemonSock === undefined) {
        Reflect.deleteProperty(process.env, "HARNESS_DAEMON_SOCK")
      } else {
        process.env["HARNESS_DAEMON_SOCK"] = prevDaemonSock
      }
      if (prevSkipWarmup === undefined) {
        Reflect.deleteProperty(process.env, "HARNESS_SKIP_OLLAMA_WARMUP")
      } else {
        process.env["HARNESS_SKIP_OLLAMA_WARMUP"] = prevSkipWarmup
      }
    }
  })
})
