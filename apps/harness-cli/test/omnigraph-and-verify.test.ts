import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { makeFailingDecisionModelLayer } from "@harness/decision"
import { readTelemetryEvents } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import {
  isRootConfigOrSharedCoreChange,
  recordTelemetry,
  resolveModifiedFilesSinceStampOrHead,
} from "../src/commands/daemon-and-omnigraph.service.js"
import { syncOmnigraphOnDone } from "../src/commands/done-omnigraph-helpers.js"
import { CLUSTER_SCHEMA_EPOCH } from "../src/commands/omnigraph-auth-and-drift.js"
import { stopStaleOmnigraphClusterBeforeDelete } from "../src/commands/omnigraph-lifecycle.js"
import { handleVerify } from "../src/commands/verify-and-done.command.js"
import { runDeltaAstAndPluginGates } from "../src/commands/verify-delta-gates.js"
import { ensureLocalOmnigraphReady, resolveCommandTelemetryOutcome } from "../src/index.js"
import { setupNonIsolatedWorkspaceDir } from "./helpers/omnigraph-rfc0009-fixture.js"
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

describe("PR #28 adjudicated review fixes & verify delta gates", () => {
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
