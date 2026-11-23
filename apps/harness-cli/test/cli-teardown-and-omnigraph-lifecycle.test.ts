import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DstSeed, writeVerifyStamp } from "@harness/gates"
import { resolveOmnigraphClusterDir } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { CLUSTER_SCHEMA_EPOCH } from "../src/commands/omnigraph-auth-and-drift.js"
import {
  ensureLocalOmnigraphReady,
  isLoopbackOmnigraphUrl,
  isSafeOmnigraphPidToKill,
  isValidLockId,
} from "../src/commands/omnigraph-lifecycle.js"
import { handleGuard } from "../src/commands/guard-and-route.command.js"
import { handleDone } from "../src/commands/verify-and-done.command.js"
import { resolveCliInfraLayer } from "../src/commands/declarative-cli.js"
import { runDeclarativeCli, teardownCliMain } from "../src/index.js"
import { runCli } from "./run-cli-helper.js"

const REPO_ROOT = resolve(import.meta.dirname, "../../..")

describe("teardownCliMain subprocess, omnigraph-lifecycle & worker isolation", () => {
  const tempDirs: Array<string> = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
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
    }, 25_000) // spawns 4 real Node hook child processes with SIGTERM/SIGINT signal delivery and teardown

    it("F-1.1 & M-4.1: real subprocess SIGTERM and SIGINT detected from Antigravity stdin payloads fail closed", async () => {
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
        writeFileSync(join(doneClusterDir, ".cluster-schema-epoch"), CLUSTER_SCHEMA_EPOCH)
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
    }, 25_000) // exercises hanging Omnigraph HTTP socket timeout and SIGTERM/SIGKILL cleanup in child process
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

  it("SPEC-0023 REQ-4.1: handleGuard enforces HARNESS_UNIT_WORKER=1 via CliEnv.env across commands and file reads while allowing complete/status/verify", async () => {
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
  })

  it("F-4.1/F-16.1/F-16.2/F-3.6/F-3.3/F-3.4: enforces secret/harness-dir fails closed across non-worker & worker modes", async () => {
    const workerEnv = { HARNESS_UNIT_WORKER: "1" } as const
    const nonWorkerEnv = { HARNESS_UNIT_WORKER: "0" } as const
    const dir = mkdtempSync(join(tmpdir(), "harness-worker-guard-symdir-"))
    tempDirs.push(dir)
    const { symlinkSync } = await import("node:fs")

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
})
