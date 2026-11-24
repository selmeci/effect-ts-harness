import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { makeFailingDecisionModelLayer } from "@harness/decision"
import { GraphGcReport } from "@harness/gates"
import { buildHarnessGraph } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { readGitBranchDiffFiles } from "../src/commands/daemon-and-omnigraph.service.js"
import { handleGc } from "../src/commands/gc-and-ontology.command.js"
import { handleRoute } from "../src/commands/guard-and-route.command.js"
import { handlePlanCheck } from "../src/commands/plan-and-repair.command.js"
import {
  handleDoctorOrSession,
  handleIngest,
} from "../src/commands/session-learn-report.command.js"
import {
  isReadOnlyStopTurn,
  isSubagentStopContext,
} from "../src/commands/stop-hook-and-transcript.js"
import { resolveCommandTelemetryOutcome, runDeclarativeCli } from "../src/index.js"
import { setupNonIsolatedWorkspaceDir } from "./helpers/omnigraph-rfc0009-fixture.js"
import { runCli } from "./run-cli-helper.js"

describe("PR #28 Round 4 stop-hook, gc, route, plan-check & session fixes", () => {
  it("F-3.1: done ALWAYS blocks when verify-stamp.json is missing even if transcript mentions verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-f31-"))
    try {
      const transcriptPath = join(dir, "transcript.jsonl")
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ source: "USER_EXPLICIT", content: "edit and verify" }),
          JSON.stringify({
            source: "MODEL",
            tool_calls: [{ name: "write_to_file", args: { TargetFile: "src/foo.ts" } }],
          }),
          JSON.stringify({
            source: "SYSTEM",
            content: `The command exited with code 0.\n{"taskBranch":"impl/test","treeHash":"${"a".repeat(64)}"}`,
          }),
        ].join("\n"),
        "utf8",
      )
      const res = await runCli(["done"], {
        repoRoot: dir,
        skipBackgroundDaemons: true,
        stdin: JSON.stringify({ transcriptPath }),
      })
      expect(res.exitCode).toBe(0)
      const parsed = JSON.parse(res.stdout) as { readonly decision: string }
      expect(parsed.decision).toBe("block")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-3.2 & F-13.1: isReadOnlyStopTurn rejects shell escapes, mutating flags, and corrupt JSONL lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-f32-"))
    try {
      const makeTranscript = (command: string): string => {
        const path = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
        writeFileSync(
          path,
          [
            JSON.stringify({ source: "USER_EXPLICIT", content: "check" }),
            JSON.stringify({
              source: "MODEL",
              tool_calls: [{ name: "run_command", args: { CommandLine: command } }],
            }),
          ].join("\n"),
          "utf8",
        )
        return path
      }

      // Disallowed commands / flags / env / substitutions
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("env rm -rf /tmp/x") })).toBe(
        false,
      )
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("echo $(whoami)") })).toBe(false)
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("echo `whoami`") })).toBe(false)
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("cat <(ls)") })).toBe(false)
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("echo a\nrm -rf b") })).toBe(false)
      expect(
        isReadOnlyStopTurn({ transcriptPath: makeTranscript("GIT_EXTERNAL_DIFF=/tmp/x git diff") }),
      ).toBe(false)
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("find . -exec rm {} +") })).toBe(
        false,
      )
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("git branch -D feat") })).toBe(
        false,
      )
      expect(
        isReadOnlyStopTurn({ transcriptPath: makeTranscript("git remote add origin https://x") }),
      ).toBe(false)
      expect(
        isReadOnlyStopTurn({ transcriptPath: makeTranscript("git diff --output=/tmp/out") }),
      ).toBe(false)
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("rg --pre=sh foo") })).toBe(false)

      // Allowed read-only commands
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("CI=1 rg foo src/") })).toBe(true)
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("git remote -v") })).toBe(true)
      expect(isReadOnlyStopTurn({ transcriptPath: makeTranscript("git diff --stat") })).toBe(true)

      // F-13.1: corrupt JSONL line fails closed
      const corruptPath = join(dir, "corrupt.jsonl")
      writeFileSync(
        corruptPath,
        [JSON.stringify({ source: "USER_EXPLICIT", content: "hi" }), "{not-valid-json"].join("\n"),
        "utf8",
      )
      expect(isReadOnlyStopTurn({ transcriptPath: corruptPath })).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-7.1: gc --strict exits 1 and includes unreadable-workspace-file on unreadable ADR/Spec, and governance-doc-read-error on malformed frontmatter", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    const dir = mkdtempSync(join(tmpdir(), "harness-f71-"))
    const adrDir = join(dir, "docs", "adr")
    const adrPath = join(adrDir, "ADR-0001.md")
    try {
      mkdirSync(adrDir, { recursive: true })
      writeFileSync(adrPath, "# ADR-0001\n", "utf8")
      chmodSync(adrPath, 0o000)
      const res = await Effect.runPromise(
        handleGc(["gc", "--strict"], { repoRoot: dir, implGraph: buildHarnessGraph({}) }),
      )
      expect(res.exitCode).toBe(1)
      const parsed = Schema.decodeUnknownSync(GraphGcReport)(JSON.parse(res.stdout))
      expect(parsed.clean).toBe(false)
      expect(parsed.findings.some((f) => f.kind === "unreadable-workspace-file")).toBe(true)

      chmodSync(adrPath, 0o644)
      writeFileSync(adrPath, "---\nid: ADR-0001\nstatus: bogus\n---\n", "utf8")
      const e2eRes = await Effect.runPromise(handleGc(["gc", "--strict"], { repoRoot: dir }))
      expect(e2eRes.exitCode).toBe(1)
      const e2eParsed = Schema.decodeUnknownSync(GraphGcReport)(JSON.parse(e2eRes.stdout))
      expect(e2eParsed.clean).toBe(false)
      expect(e2eParsed.findings.some((f) => f.kind === "governance-doc-read-error")).toBe(true)
    } finally {
      if (existsSync(adrPath)) chmodSync(adrPath, 0o644)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-11.1: runDeclarativeCli returns exitCode 1 when non-hook command fails to execute and 0 for --version", async () => {
    const versionRes = await Effect.runPromise(runDeclarativeCli(["--version"]))
    expect(versionRes.exitCode).toBe(0)

    const badFlagRes = await Effect.runPromise(runDeclarativeCli(["help", "--unknown-flag"]))
    expect(badFlagRes.exitCode).toBe(1)
  })

  it("S-3.3: handleRoute emits block=review;source=degraded-fallback telemetryDetail when model degrades", async () => {
    const res = await Effect.runPromise(
      handleRoute(["route", "unmatched-obscure-step-xyz"], {
        decisionLayer: makeFailingDecisionModelLayer("offline"),
      }),
    )
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("review")
    expect(res.telemetryDetail).toBe("block=review;source=degraded-fallback")
  })

  it("W3B: handlePlanCheck fails closed on unreadable governance docs", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    const dir = mkdtempSync(join(tmpdir(), "harness-w3b-plan-"))
    const adrDir = join(dir, "docs", "adr")
    const adrPath = join(adrDir, "ADR-0001.md")
    try {
      mkdirSync(adrDir, { recursive: true })
      writeFileSync(adrPath, "# ADR-0001\n", "utf8")
      chmodSync(adrPath, 0o000)
      const res = await Effect.runPromise(
        handlePlanCheck(["plan-check", "--graph-only"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
          skipSubprocessVerify: true,
        }),
      )
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain("[GATE FAILURE]")
      expect(res.stderr).toContain("unreadable-workspace-file")
    } finally {
      if (existsSync(adrPath)) chmodSync(adrPath, 0o644)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("W3B: Stop-hook adversarial hardening blocks truncation, shell escapes, git branch mutations, docs/rfcs edits, and corrupt subagent JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-w3b-stop-"))
    try {
      const writeTranscript = (lines: ReadonlyArray<string>): string => {
        const path = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
        writeFileSync(path, lines.join("\n"), "utf8")
        return path
      }
      const cmdTranscript = (cmd: string): string =>
        writeTranscript([
          JSON.stringify({ source: "USER_EXPLICIT", content: "check" }),
          JSON.stringify({
            source: "MODEL",
            tool_calls: [{ name: "run_command", args: { CommandLine: cmd } }],
          }),
        ])

      // 1. "Stop hook blocked termination:" followed by write_file is NOT truncated
      expect(
        isReadOnlyStopTurn({
          transcriptPath: writeTranscript([
            JSON.stringify({ source: "USER_EXPLICIT", content: "work" }),
            JSON.stringify({
              source: "SYSTEM",
              content: "Stop hook blocked termination: missing stamp",
            }),
            JSON.stringify({
              source: "MODEL",
              tool_calls: [
                { name: "write_file", args: { TargetFile: "apps/harness-cli/src/index.ts" } },
              ],
            }),
          ]),
        }),
      ).toBe(false)

      // 2. Background & operator
      expect(
        isReadOnlyStopTurn({ transcriptPath: cmdTranscript("echo ok & node -e 'console.log(1)'") }),
      ).toBe(false)

      // 3. Quoted flags, backslashes, and ${...} expansion
      expect(isReadOnlyStopTurn({ transcriptPath: cmdTranscript('find . "-delete"') })).toBe(false)
      expect(
        isReadOnlyStopTurn({ transcriptPath: cmdTranscript("find . \\-exec sh -c id \\;") }),
      ).toBe(false)
      expect(isReadOnlyStopTurn({ transcriptPath: cmdTranscript("find . ${X:--delete}") })).toBe(
        false,
      )

      // 4. Tightened git branch allowlist
      expect(isReadOnlyStopTurn({ transcriptPath: cmdTranscript("git branch new-branch") })).toBe(
        false,
      )
      expect(isReadOnlyStopTurn({ transcriptPath: cmdTranscript("git branch -df feat") })).toBe(
        false,
      )
      expect(
        isReadOnlyStopTurn({ transcriptPath: cmdTranscript("git branch --show-current") }),
      ).toBe(true)
      expect(isReadOnlyStopTurn({ transcriptPath: cmdTranscript("git branch -a") })).toBe(true)

      // 5. Editing docs/rfcs/*.md is NOT exempted
      expect(
        isReadOnlyStopTurn({
          transcriptPath: writeTranscript([
            JSON.stringify({ source: "USER_EXPLICIT", content: "edit rfc" }),
            JSON.stringify({
              source: "MODEL",
              tool_calls: [
                { name: "write_file", args: { TargetFile: "/repo/docs/rfcs/0008-test.md" } },
              ],
            }),
          ]),
        }),
      ).toBe(false)

      // 6. Corrupt JSONL line in isSubagentStopContext fails closed (returns false)
      const corruptSubagentPath = writeTranscript([
        JSON.stringify({ source: "SYSTEM", content: "[Message] subagent brief" }),
        "{corrupt-json-line",
      ])
      expect(isSubagentStopContext(dir, { transcriptPath: corruptSubagentPath })).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("W3B: readGitBranchDiffFiles fails closed on timeout/corrupt-repo and falls back to full .ts scan when refs are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-w3b-git-"))
    try {
      mkdirSync(join(dir, "libs", "a", "src"), { recursive: true })
      mkdirSync(join(dir, "apps", "b", "test"), { recursive: true })
      writeFileSync(join(dir, "libs", "a", "src", "index.ts"), "export const a = 1\n", "utf8")
      writeFileSync(join(dir, "apps", "b", "test", "b.test.ts"), "export const b = 2\n", "utf8")

      const timedOutHostIo = {
        ...nodeSyncHostIo,
        execFileSync: () => ({
          _tag: "TimedOut" as const,
          stdout: "",
          stderr: "timed out",
        }),
      }
      expect(readGitBranchDiffFiles(dir, timedOutHostIo)._tag).toBe("GitFailed")

      const corruptRepoHostIo = {
        ...nodeSyncHostIo,
        execFileSync: () => ({
          _tag: "Exited" as const,
          exitCode: 128,
          stdout: "",
          stderr: "fatal: index file corrupt",
        }),
      }
      expect(readGitBranchDiffFiles(dir, corruptRepoHostIo)._tag).toBe("GitFailed")

      const missingRefsHostIo = {
        ...nodeSyncHostIo,
        execFileSync: () => ({
          _tag: "Exited" as const,
          exitCode: 128,
          stdout: "",
          stderr: "fatal: ambiguous argument 'main...HEAD': unknown revision",
        }),
      }
      const fallbackRes = readGitBranchDiffFiles(dir, missingRefsHostIo)
      match(fallbackRes)
        .with({ _tag: "Resolved" }, ({ files }) => {
          expect(files).toContain("libs/a/src/index.ts")
          expect(files).toContain("apps/b/test/b.test.ts")
        })
        .with({ _tag: "GitFailed" }, ({ reason }) => {
          expect.fail(`Expected Resolved, got GitFailed: ${reason}`)
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("S-4: resolveCommandTelemetryOutcome records degraded-fallback as fallback even for non-review blocks", () => {
    expect(
      resolveCommandTelemetryOutcome("route", {
        exitCode: 0,
        stdout: "effect",
        stderr: "",
        telemetryDetail: "block=effect;source=degraded-fallback",
      }),
    ).toBe("fallback")
    expect(
      resolveCommandTelemetryOutcome("route", {
        exitCode: 0,
        stdout: "review",
        stderr: "",
        telemetryDetail: "block=review;source=model",
      }),
    ).toBe("ok")
    expect(
      resolveCommandTelemetryOutcome("route", {
        exitCode: 0,
        stdout: "agent-patterns/errors.md",
        stderr: "",
        telemetryDetail: "block=errors;source=deterministic",
      }),
    ).toBe("ok")
    expect(
      resolveCommandTelemetryOutcome("route", {
        exitCode: 0,
        stdout: "review",
        stderr: "",
      }),
    ).toBe("fallback")
  })

  const startFailingSyncOmnigraphServer = async (): Promise<{
    readonly url: string
    readonly close: () => Promise<void>
  }> => {
    const server = http.createServer((req, res) => {
      if (req.url === "/readyz") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Omnigraph-Http-Api": "0.14",
        })
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "mock sync failure" }))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const addr = server.address()
    if (typeof addr !== "object" || addr === null) {
      throw new Error("Expected TCP address")
    }
    return {
      url: `http://127.0.0.1:${addr.port}`,
      close: async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }

  it("I-3a: handleDoctorOrSession surfaces reconcile sync failures to stderr, exitCode=1, and reconcileError", async () => {
    const dir = setupNonIsolatedWorkspaceDir("harness-i3a-session-")
    const prevUrl = process.env.OMNIGRAPH_URL
    const mockServer = await startFailingSyncOmnigraphServer()
    process.env.OMNIGRAPH_URL = mockServer.url
    try {
      const res = await Effect.runPromise(
        handleDoctorOrSession(["session"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
          decisionLayer: makeFailingDecisionModelLayer("offline"),
        }),
      )
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain("reconcileError=")
      const parsed = JSON.parse(res.stdout) as {
        omnigraphInitialized: boolean
        reconcileError?: string
      }
      expect(parsed.omnigraphInitialized).toBe(false)
      expect(typeof parsed.reconcileError).toBe("string")
      expect((parsed.reconcileError ?? "").length).toBeGreaterThan(0)
    } finally {
      await mockServer.close()
      if (prevUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevUrl
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("I-3b: handleIngest surfaces Omnigraph sync failures with exitCode 1 (CLI) and exitCode 0 (--format=antigravity)", async () => {
    const dir = setupNonIsolatedWorkspaceDir("harness-i3b-ingest-")
    const prevUrl = process.env.OMNIGRAPH_URL
    const mockServer = await startFailingSyncOmnigraphServer()
    process.env.OMNIGRAPH_URL = mockServer.url
    try {
      const cliRes = await Effect.runPromise(
        handleIngest(["ingest"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(cliRes.exitCode).toBe(1)
      expect(cliRes.stderr).toContain("[harness:ingest] Omnigraph sync failed:")
      const cliJson = JSON.parse(cliRes.stdout) as { syncedToOmnigraph: boolean; error?: string }
      expect(cliJson.syncedToOmnigraph).toBe(false)
      expect(typeof cliJson.error).toBe("string")
      expect((cliJson.error ?? "").length).toBeGreaterThan(0)

      rmSync(join(dir, ".harness", "graph-snapshot.json"), { force: true })
      const agyRes = await Effect.runPromise(
        handleIngest(["ingest", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(agyRes.exitCode).toBe(0)
      expect(agyRes.stderr).toContain("[harness:ingest] Omnigraph sync failed:")
      const agyJson = JSON.parse(agyRes.stdout) as { error?: string }
      expect(typeof agyJson.error).toBe("string")
      expect((agyJson.error ?? "").length).toBeGreaterThan(0)
    } finally {
      await mockServer.close()
      if (prevUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevUrl
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runDeclarativeCli session --format=antigravity emits pure parseable JSON stdout even when plan-graph-snapshot.json is corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-session-corrupt-plan-"))
    try {
      mkdirSync(join(dir, ".harness"), { recursive: true })
      writeFileSync(join(dir, ".harness", "plan-graph-snapshot.json"), "{corrupt-json", "utf8")
      const res = await Effect.runPromise(
        runDeclarativeCli(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(res.exitCode).toBe(0)
      const parsed = JSON.parse(res.stdout) as { readonly injectSteps?: ReadonlyArray<string> }
      expect(Array.isArray(parsed.injectSteps)).toBe(true)
      expect(parsed.injectSteps?.some((s) => s.includes("Corrupt plan graph snapshot"))).toBe(true)
      expect(res.stderr).toContain("Corrupt plan graph snapshot")
      expect(existsSync(join(dir, ".harness", "session-preinvocation-cache.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-13.b: session --format=antigravity validates corrupt graph-snapshot.json alone without writing cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-session-corrupt-impl-"))
    try {
      mkdirSync(join(dir, ".harness"), { recursive: true })
      writeFileSync(join(dir, ".harness", "graph-snapshot.json"), "{corrupt-json", "utf8")
      const res = await Effect.runPromise(
        runDeclarativeCli(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(res.exitCode).toBe(0)
      const parsed = JSON.parse(res.stdout) as { readonly injectSteps?: ReadonlyArray<string> }
      expect(Array.isArray(parsed.injectSteps)).toBe(true)
      expect(
        parsed.injectSteps?.some((s) => s.includes("Corrupt implementation graph snapshot")),
      ).toBe(true)
      expect(res.stderr).toContain("Corrupt implementation graph snapshot")
      expect(existsSync(join(dir, ".harness", "session-preinvocation-cache.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-11.b / F-13.a: Antigravity session fails closed on invalid HARNESS_STATE_DIR and surfaces !nodeOk / !effectLspOk / !omnigraphInitialized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-session-f13a-"))
    const prevStateDir = process.env.HARNESS_STATE_DIR
    const prevOmnigraphUrl = process.env.OMNIGRAPH_URL
    try {
      writeFileSync(
        join(dir, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: {} }),
        "utf8",
      )
      process.env.HARNESS_STATE_DIR = "."

      const invalidStateRes = await Effect.runPromise(
        handleDoctorOrSession(["session", "--format=antigravity"], {
          repoRoot: dir,
          skipBackgroundDaemons: true,
        }),
      )
      expect(invalidStateRes.exitCode).toBe(0)
      expect(existsSync(join(dir, ".harness"))).toBe(false)
      const statePayload = JSON.parse(invalidStateRes.stdout) as {
        readonly injectSteps: ReadonlyArray<string>
      }
      expect(
        statePayload.injectSteps.some((s) =>
          s.includes("Harness state/snapshot directory is unavailable or invalid"),
        ),
      ).toBe(true)
      expect(statePayload.injectSteps.some((s) => s.includes("Effect language service"))).toBe(true)
      expect(invalidStateRes.stderr).toContain("Harness state/snapshot directory")
      expect(invalidStateRes.stderr).toContain("Effect language service")

      Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      const nodeSpy = vi.spyOn(process.versions, "node", "get").mockReturnValue("20.0.0")
      try {
        const oldNodeRes = await Effect.runPromise(
          handleDoctorOrSession(["session", "--format=antigravity"], {
            repoRoot: dir,
            skipBackgroundDaemons: true,
          }),
        )
        expect(oldNodeRes.exitCode).toBe(0)
        const oldNodePayload = JSON.parse(oldNodeRes.stdout) as {
          readonly injectSteps: ReadonlyArray<string>
        }
        expect(oldNodePayload.injectSteps.some((s) => s.includes("Node.js >= 24"))).toBe(true)
        expect(oldNodeRes.stderr).toContain("Node.js >= 24")
      } finally {
        nodeSpy.mockRestore()
      }

      const nonIsolatedDir = setupNonIsolatedWorkspaceDir("harness-f13a-og-")
      try {
        process.env.OMNIGRAPH_URL = "http://127.0.0.1:1"
        const ogFailRes = await Effect.runPromise(
          handleDoctorOrSession(["session", "--format=antigravity"], {
            repoRoot: nonIsolatedDir,
            skipBackgroundDaemons: true,
          }),
        )
        expect(ogFailRes.exitCode).toBe(0)
        const ogPayload = JSON.parse(ogFailRes.stdout) as {
          readonly injectSteps: ReadonlyArray<string>
        }
        expect(ogPayload.injectSteps.some((s) => s.includes("Omnigraph"))).toBe(true)
        expect(ogFailRes.stderr).toContain("Omnigraph")
        expect(
          existsSync(join(nonIsolatedDir, ".harness", "session-preinvocation-cache.json")),
        ).toBe(false)
      } finally {
        rmSync(nonIsolatedDir, { recursive: true, force: true })
      }
    } finally {
      if (prevStateDir === undefined) Reflect.deleteProperty(process.env, "HARNESS_STATE_DIR")
      else process.env.HARNESS_STATE_DIR = prevStateDir
      if (prevOmnigraphUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevOmnigraphUrl
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
