import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { Effect, Layer, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { makeFailingDecisionModelLayer } from "@harness/decision"
import { GraphGcReport, readTelemetryEvents } from "@harness/gates"
import { buildHarnessGraph } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import {
  isRootConfigOrSharedCoreChange,
  readGitBranchDiffFiles,
  recordTelemetry,
  resolveModifiedFilesSinceStampOrHead,
} from "../src/commands/daemon-and-omnigraph.service.js"
import { handleGc } from "../src/commands/gc-and-ontology.command.js"
import { syncOmnigraphOnDone } from "../src/commands/done-omnigraph-helpers.js"
import { handleRoute } from "../src/commands/guard-and-route.command.js"
import { CLUSTER_SCHEMA_EPOCH } from "../src/commands/omnigraph-auth-and-drift.js"
import { stopStaleOmnigraphClusterBeforeDelete } from "../src/commands/omnigraph-lifecycle.js"
import { handlePlanCheck } from "../src/commands/plan-and-repair.command.js"
import {
  handleDoctorOrSession,
  handleIngest,
} from "../src/commands/session-learn-report.command.js"
import { handleVerify } from "../src/commands/verify-and-done.command.js"
import {
  isReadOnlyStopTurn,
  isSubagentStopContext,
} from "../src/commands/stop-hook-and-transcript.js"
import { runDeltaAstAndPluginGates } from "../src/commands/verify-delta-gates.js"
import {
  ensureLocalOmnigraphReady,
  resolveCommandTelemetryOutcome,
  runDeclarativeCli,
} from "../src/index.js"
import { runCli } from "./run-cli-helper.js"

describe("Omnigraph & Verify Delta Gates (extracted from index.test.ts)", () => {
  it("falls through to /readyz readiness poll when omnigraph setup throws before spawn (F-2, F-10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-omnigraph-readyz-"))
    const homeDir = mkdtempSync(join(tmpdir(), "harness-cli-home-"))
    let readyzCalls = 0
    const server = http.createServer((req, res) => {
      if (req.url === "/readyz") {
        readyzCalls += 1
        if (readyzCalls === 1) {
          res.writeHead(503)
          res.end()
          return
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Omnigraph-Http-Api": "0.14",
        })
        res.end(JSON.stringify({ ready: true, ready_graph_count: 1 }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const prevHome = process.env["HOME"]
    const prevUrl = process.env["OMNIGRAPH_URL"]
    try {
      await Effect.runPromise(
        Effect.callback<void>((resume) => {
          server.listen(0, "127.0.0.1", () => resume(Effect.void))
        }),
      )
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      expect(port).toBeGreaterThan(0)

      const configDir = join(dir, "libs", "harness", "graph")
      mkdirSync(join(configDir, "queries"), { recursive: true })
      writeFileSync(join(configDir, "cluster.yaml"), "name: test\n", "utf-8")
      writeFileSync(join(configDir, "schema.pg"), "", "utf-8")
      writeFileSync(join(configDir, "queries", "harness.gq"), "", "utf-8")

      const clusterRootDir = join(dir, ".harness", "omnigraph-cluster")
      mkdirSync(clusterRootDir, { recursive: true })
      writeFileSync(join(clusterRootDir, ".config-stamp"), "name: test\n\n---\n\n---\n", "utf-8")
      writeFileSync(join(clusterRootDir, ".cluster-schema-epoch"), CLUSTER_SCHEMA_EPOCH, "utf-8")

      const localBinDir = join(homeDir, ".local", "bin")
      mkdirSync(localBinDir, { recursive: true })
      const omnigraphStub = join(localBinDir, "omnigraph")
      const omnigraphServerStub = join(localBinDir, "omnigraph-server")
      writeFileSync(omnigraphStub, "#!/usr/bin/env bash\nexit 1\n", "utf-8")
      writeFileSync(omnigraphServerStub, "#!/usr/bin/env bash\nexit 0\n", "utf-8")
      chmodSync(omnigraphStub, 0o755)
      chmodSync(omnigraphServerStub, 0o755)

      process.env["HOME"] = homeDir
      process.env["OMNIGRAPH_URL"] = `http://127.0.0.1:${port}`

      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(dir))
      expect(ready).toBe(true)
      expect(readyzCalls).toBeGreaterThanOrEqual(2)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      if (prevUrl === undefined) delete process.env["OMNIGRAPH_URL"]
      else process.env["OMNIGRAPH_URL"] = prevUrl
      await Effect.runPromise(
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void))
        }),
      )
      rmSync(dir, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

describe("PR #28 adjudicated review fixes (F-6.2, F-8.3c, F-11.1, F-12.1, F-14.1, F-20.1a)", () => {
  it("F-6.2: emits stderr diagnostic when DecisionModel dies in session/doctor while preserving interrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-f62-"))
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    try {
      const dyingDecisionLayer = Layer.succeed(
        DecisionModel.DecisionModel,
        DecisionModel.DecisionModel.of({
          [DecisionModel.TypeId]: DecisionModel.TypeId,
          decide: () => Effect.die(new Error("boom")),
        }),
      )

      const res = await runCli(["session"], { repoRoot: dir }, dyingDecisionLayer)
      expect(res.exitCode).toBe(0)
      expect(stderrChunks.join("")).toContain("[harness learn] decision model fallback:")
      expect(stderrChunks.join("")).toContain("boom")
    } finally {
      process.stderr.write = origWrite
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-8.3c: runDeltaAstAndPluginGates fails when workspace has a HarnessTierTopology violation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-f83c-"))
    try {
      mkdirSync(join(dir, "libs", "sample", "contract", "src"), { recursive: true })
      writeFileSync(
        join(dir, "libs", "sample", "contract", "package.json"),
        JSON.stringify({
          name: "@sample/contract",
          nx: { tags: ["scope:sample", "type:contract"] },
          dependencies: { "@sample/infra": "workspace:*" },
        }),
      )
      const gateResult = await Effect.runPromise(runDeltaAstAndPluginGates(dir, []))
      match(gateResult)
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value.exitCode).toBe(1)
          expect(value.stderr).toContain("verify:tier-topology")
          expect(value.stderr).toContain("forbidden-contract-dependency")
        })
        .with({ _tag: "None" }, () => {
          expect.fail("Expected gateResult to be Some")
        })
        .exhaustive()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-11.1: does not write graph-head.json when Omnigraph sync fails in non-isolated workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-f111-"))
    const fakeHome = mkdtempSync(join(tmpdir(), "harness-f111-home-"))
    const origHome = process.env.HOME
    const origUrl = process.env.OMNIGRAPH_URL
    try {
      process.env.HOME = fakeHome
      Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      mkdirSync(join(dir, "libs", "harness", "graph"), { recursive: true })
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n")
      writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n")

      const res = await runCli(["ingest"], { repoRoot: dir })
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain("[harness:ingest] Omnigraph sync failed:")
      const parsed = JSON.parse(res.stdout) as {
        readonly syncedToOmnigraph: boolean
        readonly error?: string
      }
      expect(parsed.syncedToOmnigraph).toBe(false)
      expect(typeof parsed.error).toBe("string")
      expect(existsSync(join(dir, ".harness", "graph-head.json"))).toBe(false)
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome
      else Reflect.deleteProperty(process.env, "HOME")
      if (origUrl !== undefined) process.env.OMNIGRAPH_URL = origUrl
      else Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      rmSync(dir, { recursive: true, force: true })
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it("F-12.1: logs warning with err.reason when TsCompilerOverlayService falls back to extractTypeGraph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-f121-"))
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    try {
      await runCli(["verify"], {
        repoRoot: join(dir, "nonexistent-repo"),
        skipSubprocessVerify: true,
      })
      expect(stderrChunks.join("")).toContain("TsCompilerOverlayService failed")
      expect(stderrChunks.join("")).toContain("Repository root path does not exist")
    } finally {
      process.stderr.write = origWrite
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("F-14.1: resolveCommandTelemetryOutcome checks exitCode and block/continue decisions for done", () => {
    expect(
      resolveCommandTelemetryOutcome("done", { exitCode: 1, stdout: "{}", stderr: "err" }),
    ).toBe("fail")
    expect(
      resolveCommandTelemetryOutcome("done", {
        exitCode: 0,
        stdout: '{"decision":"block"}',
        stderr: "",
      }),
    ).toBe("fail")
    expect(
      resolveCommandTelemetryOutcome("done", {
        exitCode: 0,
        stdout: '{"decision":"continue"}',
        stderr: "",
      }),
    ).toBe("fail")
    expect(resolveCommandTelemetryOutcome("done", { exitCode: 0, stdout: "{}", stderr: "" })).toBe(
      "ok",
    )
  })

  it("F-20.1a: recordTelemetry writes telemetry when skipBackgroundDaemons is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-f201a-"))
    try {
      recordTelemetry(
        { repoRoot: dir, skipBackgroundDaemons: false },
        {
          surface: "cli",
          category: "lifecycle",
          toolName: "help",
          outcome: "ok",
          durationMs: 1,
        },
      )
      const events = readTelemetryEvents(dir, nodeSyncHostIo)
      expect(events.length).toBe(1)
      expect(events[0]?.toolName).toBe("help")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("PR #28 Round 4 security & correctness fixes", () => {
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

  it("F-4.1: isRootConfigOrSharedCoreChange classifies root configs, tools/, nested package.json/tsconfig.json, and domain files", () => {
    expect(isRootConfigOrSharedCoreChange([])).toBe(true)
    expect(isRootConfigOrSharedCoreChange(["tsconfig.base.json"])).toBe(true)
    expect(isRootConfigOrSharedCoreChange(["libs/harness/gates/src/index.ts"])).toBe(true)
    expect(isRootConfigOrSharedCoreChange(["apps/harness-cli/src/index.ts"])).toBe(true)
    expect(isRootConfigOrSharedCoreChange(["tools/oxlint/syntax-bans.js"])).toBe(true)
    expect(isRootConfigOrSharedCoreChange(["libs/sample/domain/package.json"])).toBe(true)
    expect(isRootConfigOrSharedCoreChange(["apps/sample/tsconfig.json"])).toBe(true)
    expect(isRootConfigOrSharedCoreChange(["libs/sample/domain/src/cart.ts"])).toBe(false)
  })

  it("F-19.2: runDeltaAstAndPluginGates fails closed on GitFailed in verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-f41-"))
    try {
      mkdirSync(join(dir, ".git"), { recursive: true })
      const failingHostIo = {
        ...nodeSyncHostIo,
        execFileSync: () => ({
          _tag: "Exited" as const,
          exitCode: 128,
          stdout: "",
          stderr: "fatal: corrupt git index",
        }),
      }
      const res = resolveModifiedFilesSinceStampOrHead(dir, failingHostIo)
      expect(res._tag).toBe("GitFailed")

      const gateRes = await Effect.runPromise(runDeltaAstAndPluginGates(dir, res))
      match(gateRes)
        .with({ _tag: "Some" }, ({ value }) => {
          expect(value.exitCode).toBe(1)
          expect(value.stderr).toContain("verify:git-delta")
        })
        .with({ _tag: "None" }, () => {
          expect.fail("Expected runDeltaAstAndPluginGates to fail closed on GitFailed")
        })
        .exhaustive()
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

  it("handleVerify fails cleanly with verify:dst-seed on invalid DST_SEED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-dst-seed-err-"))
    const prevSeed = process.env["DST_SEED"]
    try {
      process.env["DST_SEED"] = "not-a-seed"
      const res = await Effect.runPromise(
        handleVerify({
          repoRoot: dir,
          skipSubprocessVerify: true,
          skipBackgroundDaemons: true,
          mutateStampPolicy: "skip",
          governanceDocs: [],
        }),
      )
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain("[GATE FAILURE] verify:dst-seed")
    } finally {
      if (prevSeed === undefined) Reflect.deleteProperty(process.env, "DST_SEED")
      else process.env["DST_SEED"] = prevSeed
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

  it("S-3.5: stopStaleOmnigraphClusterBeforeDelete returns false when pkill times out and PID is alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-s35-"))
    try {
      const mockHostIo = {
        ...nodeSyncHostIo,
        execFileSync: () => ({
          _tag: "TimedOut" as const,
          stdout: "",
          stderr: "pkill timed out",
        }),
      }
      const ok = stopStaleOmnigraphClusterBeforeDelete(dir, 99999, mockHostIo, () => true)
      expect(ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  it("I-7b: handleVerify fails closed with verify:git-delta and no verify-stamp.json when .git is corrupt (GitFailed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-i7b-verify-git-"))
    try {
      mkdirSync(join(dir, ".harness"), { recursive: true })
      writeFileSync(join(dir, ".git"), "gitdir: /nonexistent-git-dir\n", "utf8")
      const res = await Effect.runPromise(
        handleVerify({
          repoRoot: dir,
          skipBackgroundDaemons: true,
          decisionLayer: makeFailingDecisionModelLayer("offline"),
        }),
      )
      expect(res.exitCode).toBe(1)
      expect(`${res.stdout}\n${res.stderr}`).toContain("verify:git-delta")
      expect(existsSync(join(dir, ".harness", "verify-stamp.json"))).toBe(false)
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

  const startDoneMergeMockServer = async (options: {
    readonly mergeFails: boolean
    readonly branches?: ReadonlyArray<string>
  }): Promise<{
    readonly url: string
    readonly requests: ReadonlyArray<{ readonly method: string; readonly url: string }>
    readonly close: () => Promise<void>
  }> => {
    const requests: Array<{ readonly method: string; readonly url: string }> = []
    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = http.createServer((req, res) => {
      const method = req.method ?? "GET"
      const url = req.url ?? "/"
      requests.push({ method, url })

      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, ready_graph_count: 1 }))
        return
      }
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (method === "GET" && url.endsWith("/branches")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "ok",
            branches: options.branches ?? ["main", "impl/current", "impl/wt-cli-unit"],
            serverRef: "srv-1",
          }),
        )
        return
      }
      if (method === "POST" && url.endsWith("/branches")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ outcome: "created", branch: "impl/current", serverRef: "srv-1" }))
        return
      }
      if (method === "POST" && url.includes("/branches/merge")) {
        let body = ""
        req.on("data", (chunk) => {
          body += String(chunk)
        })
        req.on("end", () => {
          const isDryRun = body.includes('"dry_run":true')
          const parsedReq = JSON.parse(body || "{}") as {
            readonly source?: string
            readonly target?: string
          }
          if (options.mergeFails && !isDryRun) {
            res.writeHead(500, headers)
            res.end(JSON.stringify({ error: "mock merge failure" }))
            return
          }
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "already_up_to_date",
              source: parsedReq.source ?? "impl/current",
              target: parsedReq.target ?? "main",
              ...(isDryRun ? { dry_run: true } : { branch_deleted: true }),
              commit: null,
              serverRef: "srv-1",
            }),
          )
        })
        return
      }
      if (method === "GET" && url.includes("/branches/diff")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "ok",
            serverRef: "srv-1",
            from_commit_id: "cmt-1",
            to_commit_id: "cmt-2",
            changes: [],
            netNodeCount: 0,
            netEdgeCount: 0,
          }),
        )
        return
      }
      if (method === "DELETE" && url.includes("/branches/")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ outcome: "deleted", serverRef: "srv-1" }))
        return
      }
      res.writeHead(404, headers)
      res.end(JSON.stringify({ error: "not found" }))
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
      requests,
      close: async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }

  const setupNonIsolatedWorkspaceDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    const configDir = join(dir, "libs", "harness", "graph")
    mkdirSync(join(configDir, "queries"), { recursive: true })
    writeFileSync(join(configDir, "cluster.yaml"), "name: test\n", "utf8")
    writeFileSync(join(configDir, "schema.pg"), "", "utf8")
    writeFileSync(join(configDir, "queries", "harness.gq"), "", "utf8")
    const clusterRootDir = join(dir, ".harness", "omnigraph-cluster")
    mkdirSync(clusterRootDir, { recursive: true })
    writeFileSync(join(clusterRootDir, ".config-stamp"), "name: test\n\n---\n\n---\n", "utf8")
    writeFileSync(join(clusterRootDir, ".cluster-schema-epoch"), CLUSTER_SCHEMA_EPOCH, "utf8")
    return dir
  }

  it("S-8d: syncOmnigraphOnDone returns undefined on successful HTTP merge in non-isolated workspace", async () => {
    const dir = setupNonIsolatedWorkspaceDir("harness-s8d-ok-")
    const prevUrl = process.env.OMNIGRAPH_URL
    const mockServer = await startDoneMergeMockServer({ mergeFails: false })
    process.env.OMNIGRAPH_URL = mockServer.url
    try {
      const result = await Effect.runPromise(
        syncOmnigraphOnDone(dir, { repoRoot: dir, skipBackgroundDaemons: true }, true, "block"),
      )
      expect(result).toBeUndefined()
      expect(
        mockServer.requests.some((r) => r.method === "POST" && r.url.includes("/branches/merge")),
      ).toBe(true)
    } finally {
      await mockServer.close()
      if (prevUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevUrl
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("S-8d: syncOmnigraphOnDone returns block decision when POST /branches/merge returns HTTP 500", async () => {
    const dir = setupNonIsolatedWorkspaceDir("harness-s8d-fail-")
    const prevUrl = process.env.OMNIGRAPH_URL
    const mockServer = await startDoneMergeMockServer({ mergeFails: true })
    process.env.OMNIGRAPH_URL = mockServer.url
    try {
      const result = await Effect.runPromise(
        syncOmnigraphOnDone(dir, { repoRoot: dir, skipBackgroundDaemons: true }, true, "block"),
      )
      expect(result).toBeDefined()
      expect(result?.exitCode).toBe(0)
      const parsed = JSON.parse(result?.stdout ?? "{}") as {
        readonly decision?: string
        readonly reason?: string
      }
      expect(parsed.decision).toBe("block")
      expect(parsed.reason).toMatch(/^Omnigraph branch merge \(.*\) failed$/)
    } finally {
      await mockServer.close()
      if (prevUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevUrl
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("S-8d: syncOmnigraphOnDone blocks when source branch impl/current is missing from /branches", async () => {
    const dir = setupNonIsolatedWorkspaceDir("harness-s8d-missing-src-")
    const prevUrl = process.env.OMNIGRAPH_URL
    const mockServer = await startDoneMergeMockServer({
      mergeFails: false,
      branches: ["main"],
    })
    process.env.OMNIGRAPH_URL = mockServer.url
    try {
      const result = await Effect.runPromise(
        syncOmnigraphOnDone(dir, { repoRoot: dir, skipBackgroundDaemons: true }, true, "block"),
      )
      expect(result).toBeDefined()
      expect(result?.exitCode).toBe(0)
      const parsed = JSON.parse(result?.stdout ?? "{}") as {
        readonly decision?: string
        readonly reason?: string
      }
      expect(parsed.decision).toBe("block")
      expect(parsed.reason).toMatch(/^Omnigraph branch merge \(.*\) failed$/)
    } finally {
      await mockServer.close()
      if (prevUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevUrl
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
