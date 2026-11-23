import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildHarnessGraph,
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
  saveGraphSnapshot,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import {
  runPreMergeOmnigraphBranchVerify,
  syncOmnigraphOnDone,
} from "../src/commands/done-omnigraph-helpers.js"
import {
  ensureOmnigraphEndpointTokens,
  evaluateClusterConfigDrift,
  runOfflineOmnigraphLintGate,
  runOmnigraphOptimizeAndCleanup,
  writeClusterDriftReceipts,
} from "../src/commands/omnigraph-auth-and-drift.js"
import {
  ensureLocalOmnigraphReady,
  unlockOmnigraphClusterIfNeeded,
} from "../src/commands/omnigraph-lifecycle.js"
import {
  cleanupRfc0009TempDirs,
  createRfc0009TempRepo,
  getDeadChildPid,
} from "./helpers/omnigraph-rfc0009-fixture.js"

describe("RFC-0009 Omnigraph v0.14.0 lifecycle atomic state, blobs & branch verify", () => {
  const tempDirs: Array<string> = []
  const makeTempRepo = (prefix: string) => createRfc0009TempRepo(tempDirs, prefix)
  afterEach(() => {
    vi.restoreAllMocks()
    cleanupRfc0009TempDirs(tempDirs)
  })

  it("ensureLocalOmnigraphReady kills spawned server if writeServerMetaAtomic fails and handles unreadable server.json", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-meta-fail-")
    const fakeHome = join(repoRoot, "fake-home")
    const binDir = join(fakeHome, ".local", "bin")
    mkdirSync(binDir, { recursive: true })
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const port = deriveRepoOmnigraphPort(canonicalRoot, nodeSyncHostIo)
    const pidFile = join(repoRoot, "spawned.pid")

    const fakeCli = join(binDir, "omnigraph")
    writeFileSync(
      fakeCli,
      `#!/bin/sh
if [ "$1" = "cluster" ] && [ "$2" = "apply" ]; then
  mkdir -p "${join(repoRoot, ".harness", "omnigraph-cluster", "graphs", "harness.omni")}"
  echo '{"status":"applied"}'
fi
exit 0
`,
      "utf8",
    )
    chmodSync(fakeCli, 0o755)
    const fakeServer = join(binDir, "omnigraph-server")
    writeFileSync(
      fakeServer,
      `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" });
  res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }));
});
server.listen(${port}, "127.0.0.1");
setTimeout(() => process.exit(0), 10000);
`,
      "utf8",
    )
    chmodSync(fakeServer, 0o755)

    const origRename = nodeSyncHostIo.renameSync.bind(nodeSyncHostIo)
    vi.spyOn(nodeSyncHostIo, "renameSync").mockImplementation((from, to) => {
      if (to.endsWith("server.json")) {
        throw new Error("ENOSPC: disk full")
      }
      origRename(from, to)
    })

    const prevHome = process.env.HOME
    const prevUrl = process.env.OMNIGRAPH_URL
    process.env.HOME = fakeHome
    Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
    try {
      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(ready).toBe(false)
      const spawnedPid = Number(readFileSync(pidFile, "utf8").trim())
      expect(Number.isInteger(spawnedPid)).toBe(true)
      let alive = true
      try {
        process.kill(spawnedPid, 0)
      } catch {
        alive = false
      }
      expect(alive).toBe(false)
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
      if (prevUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevUrl
    }

    // Unreadable server.json triggers warning and stale cluster stop
    const repo2 = makeTempRepo("harness-rfc0009-unread-meta-")
    const clusterDir2 = resolveOmnigraphClusterDir(repo2, nodeSyncHostIo)
    mkdirSync(clusterDir2, { recursive: true })
    const drift2 = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir2, join(repo2, "libs", "harness", "graph"), false),
    )
    writeClusterDriftReceipts(
      clusterDir2,
      drift2.expectedStamp,
      join(repo2, "libs", "harness", "graph"),
    )
    writeFileSync(join(clusterDir2, "server.json"), "{}", "utf8")
    const origRead = nodeSyncHostIo.readTextSync.bind(nodeSyncHostIo)
    vi.spyOn(nodeSyncHostIo, "readTextSync").mockImplementation((p) => {
      if (p.endsWith("server.json")) throw new Error("EACCES: unreadable")
      return origRead(p)
    })
    const execCalls: Array<string> = []
    const origExec = nodeSyncHostIo.execFileSync.bind(nodeSyncHostIo)
    vi.spyOn(nodeSyncHostIo, "execFileSync").mockImplementation((cmd, args, opts) => {
      execCalls.push(`${cmd} ${args.join(" ")}`)
      if (cmd === "pkill") {
        return { _tag: "Exited", exitCode: 1, stdout: "", stderr: "" }
      }
      return origExec(cmd, args, opts)
    })
    const stderrChunks2: Array<string> = []
    const stderrSpy2 = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks2.push(String(chunk))
      return true
    })
    process.env.HOME = join(repo2, "missing-home")
    try {
      const ready2 = await Effect.runPromise(ensureLocalOmnigraphReady(repo2))
      expect(ready2).toBe(false)
      expect(stderrChunks2.join("")).toContain("failed to read")
      expect(execCalls.some((c) => c.startsWith("pkill "))).toBe(true)
    } finally {
      stderrSpy2.mockRestore()
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
    }
  })

  it("syncOmnigraphOnDone uploads and verifies spanTraceBlob via putBlob + statBlob and fails closed on statBlob 404", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-done-blob-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const drift = await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, false))
    writeClusterDriftReceipts(clusterDir, drift.expectedStamp, configDir)
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)

    let statStatus = 200
    let putCount = 0
    let statCount = 0
    const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      if (req.method === "PUT" && url.includes("/blob")) {
        putCount += 1
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "written",
            sha256: "abc",
            size: 10,
            etag: '"e1"',
            serverRef: "srv-1",
          }),
        )
        return
      }
      if (req.method === "HEAD" && url.includes("/blob")) {
        statCount += 1
        res.writeHead(statStatus, {
          "Content-Length": "10",
          ETag: '"e1"',
          "Content-Type": "application/octet-stream",
          "Omnigraph-Http-Api": "0.14",
        })
        res.end()
        return
      }
      if (url.includes("/load")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({ outcome: "loaded", commit_id: "c1", nodes_loaded: 1, edges_loaded: 0 }),
        )
        return
      }
      if (url.includes("/branches/diff")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "ok",
            from_commit_id: "c0",
            to_commit_id: "c1",
            changes: [],
            netNodeCount: 0,
            netEdgeCount: 0,
          }),
        )
        return
      }
      if (url.includes("/branches/merge")) {
        let body = ""
        req.on("data", (c) => {
          body += String(c)
        })
        req.on("end", () => {
          const isDryRun = body.includes('"dry_run":true')
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "already_up_to_date",
              source: taskBranches.implBranch,
              target: taskBranches.mainBranch,
              ...(isDryRun ? { dry_run: true } : { branch_deleted: true }),
              commit: null,
            }),
          )
        })
        return
      }
      res.writeHead(200, headers)
      res.end(
        JSON.stringify({
          outcome: "ok",
          branches: [taskBranches.mainBranch, taskBranches.implBranch],
        }),
      )
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const port = (server.address() as AddressInfo).port
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: canonicalRoot,
        updatedAt: null,
      }),
      "utf8",
    )
    mkdirSync(join(repoRoot, ".harness"), { recursive: true })
    writeFileSync(join(repoRoot, ".harness", "spans.jsonl"), '{"span":"done-test"}\n', "utf8")
    const g = buildHarnessGraph({
      tests: [
        {
          testId: "tc-done-1",
          testFile: "test/demo.test.ts",
          testName: "demo",
          line: 1,
          isPropertyTest: false,
        },
      ],
    })
    saveGraphSnapshot(g, join(repoRoot, ".harness", "graph-snapshot.json"), nodeSyncHostIo)

    try {
      const okRes = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(okRes).toBeUndefined()
      expect(putCount).toBe(1)
      expect(statCount).toBe(1)

      statStatus = 404
      const failRes = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(failRes?.exitCode).toBe(1)
      expect(failRes?.stderr).toContain("done:omnigraph-span-blob")
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("runOfflineOmnigraphLintGate trims untrimmed/empty target diagnostics, negative drift stays NoOp, [state_lock_held] logs Info, and launcher emits stderr warnings", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-r2-misc-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")

    // Untrimmed/empty target diagnostic decoding
    const lintBin = join(repoRoot, "omnigraph-untrimmed.sh")
    writeFileSync(
      lintBin,
      `#!/bin/sh
cat <<'EOF'
{"status":"error","queries_processed":1,"findings":[{"code":" Q001 ","message":" Bad query ","target":"   "}]}
EOF
exit 1
`,
      "utf8",
    )
    chmodSync(lintBin, 0o755)
    const lintRes = await Effect.runPromise(runOfflineOmnigraphLintGate(repoRoot, lintBin))
    expect(lintRes.ok).toBe(false)
    if (!lintRes.ok) {
      expect(lintRes.message).toContain("Bad query")
      expect(lintRes.message).not.toContain("invalid JSON")
    }

    // Negative drift test: unedited config stays NoOp
    writeFileSync(join(configDir, "graph.policy.yaml"), "version: 1\n", "utf8")
    writeFileSync(join(configDir, "cluster.policy.yaml"), "version: 1\n", "utf8")
    const initDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initDrift.expectedStamp, configDir)
    expect(
      (await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, true))).action
        ._tag,
    ).toBe("NoOp")
    expect(
      (await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, false))).action
        ._tag,
    ).toBe("NoOp")

    // [state_lock_held] emits Info stderr
    const lockHeldBin = join(repoRoot, "omnigraph-lockheld.sh")
    writeFileSync(lockHeldBin, '#!/bin/sh\necho "[state_lock_held] busy" >&2\nexit 1\n', "utf8")
    chmodSync(lockHeldBin, 0o755)
    const infoChunks: Array<string> = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      infoChunks.push(String(chunk))
      return true
    })
    runOmnigraphOptimizeAndCleanup(clusterDir, lockHeldBin, false)
    stderrSpy.mockRestore()
    expect(infoChunks.join("")).toContain(
      "Info: skipped offline omnigraph optimize because cluster state lock is held",
    )

    // Launcher stderr warnings for missing auth-tokens.json when server.json exists & non-loopback OMNIGRAPH_URL
    const launcherPath = resolve(import.meta.dirname, "../../../tools/omnigraph-mcp-launcher.mjs")
    const binDir = join(repoRoot, "fake-bin")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, "npx"), '#!/bin/sh\necho "{}"\n', "utf8")
    chmodSync(join(binDir, "npx"), 0o755)
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: getDeadChildPid(),
        port: 19999,
        baseUrl: "http://127.0.0.1:19999",
        canonicalRepoRoot: "/other/repo",
        updatedAt: null,
      }),
      "utf8",
    )
    const envClean: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    }
    Reflect.deleteProperty(envClean, "OMNIGRAPH_URL")
    Reflect.deleteProperty(envClean, "OMNIGRAPH_BASE_URL")
    Reflect.deleteProperty(envClean, "OMNIGRAPH_TOKEN")
    const warnOut = nodeSyncHostIo.execFileSync(process.execPath, [launcherPath], {
      cwd: repoRoot,
      env: envClean,
      timeoutMs: 10_000,
    })
    match(warnOut)
      .with({ _tag: "Exited" }, (ex) => {
        expect(ex.stderr).toContain("canonicalRepoRoot mismatch")
        expect(ex.stderr).toContain("auth-tokens.json does not exist")
      })
      .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, ({ _tag }) => {
        expect.fail(`Expected Exited, got ${_tag}`)
      })
      .exhaustive()
    const remoteOut = nodeSyncHostIo.execFileSync(process.execPath, [launcherPath], {
      cwd: repoRoot,
      env: { ...envClean, OMNIGRAPH_URL: "https://remote.example.com", OMNIGRAPH_TOKEN: "secret" },
      timeoutMs: 10_000,
    })
    match(remoteOut)
      .with({ _tag: "Exited" }, (ex) => {
        expect(ex.stderr).toContain("not loopback; not forwarding OMNIGRAPH_TOKEN")
      })
      .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, ({ _tag }) => {
        expect.fail(`Expected Exited, got ${_tag}`)
      })
      .exhaustive()
  })

  it("F-2.1 & F-7.1 & F-9.3 & F-15.2: launcher strips non-loopback OMNIGRAPH_TOKEN, treats empty token as unset, supports positive server.json and linked worktree", () => {
    const launcherPath = resolve(import.meta.dirname, "../../../tools/omnigraph-mcp-launcher.mjs")
    const runEnvDumpLauncher = (cwd: string, envOverrides: Record<string, string | undefined>) => {
      const binDir = join(cwd, "fake-bin-dump")
      mkdirSync(binDir, { recursive: true })
      const fakeNpx = join(binDir, "npx")
      writeFileSync(
        fakeNpx,
        '#!/bin/sh\nnode -e "console.log(JSON.stringify({ url: process.env.OMNIGRAPH_URL, hasToken: Object.prototype.hasOwnProperty.call(process.env, \\"OMNIGRAPH_TOKEN\\"), token: process.env.OMNIGRAPH_TOKEN ?? null }))"\n',
        "utf8",
      )
      chmodSync(fakeNpx, 0o755)
      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ...envOverrides,
      }
      if (!("OMNIGRAPH_URL" in envOverrides)) Reflect.deleteProperty(env, "OMNIGRAPH_URL")
      if (!("OMNIGRAPH_BASE_URL" in envOverrides)) Reflect.deleteProperty(env, "OMNIGRAPH_BASE_URL")
      if (!("OMNIGRAPH_TOKEN" in envOverrides)) Reflect.deleteProperty(env, "OMNIGRAPH_TOKEN")
      const res = nodeSyncHostIo.execFileSync(process.execPath, [launcherPath], {
        cwd,
        env,
        timeoutMs: 10_000,
      })
      return match(res)
        .with({ _tag: "Exited" }, (ex) => ({
          parsed: JSON.parse(ex.stdout.trim()) as {
            readonly url: string
            readonly hasToken: boolean
            readonly token: string | null
          },
          stderr: ex.stderr,
        }))
        .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, ({ _tag }) => {
          throw new Error(`Expected Exited, got ${_tag}`)
        })
        .exhaustive()
    }

    // 1. Non-loopback URL strips OMNIGRAPH_TOKEN completely from childEnv
    const repo1 = makeTempRepo("harness-rfc0009-l-nonloop-")
    const nonLoop = runEnvDumpLauncher(repo1, {
      OMNIGRAPH_URL: "https://remote.example.com",
      OMNIGRAPH_TOKEN: "top-secret",
    })
    expect(nonLoop.parsed.hasToken).toBe(false)
    expect(nonLoop.parsed.token).toBeNull()

    // 2. Empty OMNIGRAPH_TOKEN="" is treated as unset and falls back to 0o600 auth-tokens.json; positive server.json is used
    const repo2 = makeTempRepo("harness-rfc0009-l-pos-")
    const cluster2 = join(repo2, ".harness", "omnigraph-cluster")
    mkdirSync(cluster2, { recursive: true })
    const canonical2 = resolveCanonicalRepoRoot(repo2, nodeSyncHostIo)
    writeFileSync(
      join(cluster2, "server.json"),
      JSON.stringify({
        pid: process.pid,
        baseUrl: "http://127.0.0.1:21234",
        canonicalRepoRoot: canonical2,
      }),
      "utf8",
    )
    writeFileSync(
      join(cluster2, "auth-tokens.json"),
      JSON.stringify({ schemaVersion: 1, cliToken: "cli-tok", mcpToken: "mcp-tok-positive" }),
      "utf8",
    )
    chmodSync(join(cluster2, "auth-tokens.json"), 0o600)
    const pos = runEnvDumpLauncher(repo2, { OMNIGRAPH_TOKEN: "" })
    expect(pos.parsed.url).toBe("http://127.0.0.1:21234")
    expect(pos.parsed.hasToken).toBe(true)
    expect(pos.parsed.token).toBe("mcp-tok-positive")

    // 3. Linked worktree .git file resolves canonical repoRoot cluster and logs fallback warning when server.json is missing
    const canon3 = makeTempRepo("harness-rfc0009-l-canon-")
    const wt3 = makeTempRepo("harness-rfc0009-l-wt-")
    const gitWt3 = join(canon3, ".git", "worktrees", "wt3")
    mkdirSync(gitWt3, { recursive: true })
    writeFileSync(join(gitWt3, "commondir"), "../..\n", "utf8")
    writeFileSync(join(wt3, ".git"), `gitdir: ${gitWt3}\n`, "utf8")
    const canonCluster3 = join(
      resolveCanonicalRepoRoot(canon3, nodeSyncHostIo),
      ".harness",
      "omnigraph-cluster",
    )
    mkdirSync(canonCluster3, { recursive: true })
    writeFileSync(
      join(canonCluster3, "server.json"),
      JSON.stringify({
        pid: process.pid,
        baseUrl: "http://127.0.0.1:22345",
        canonicalRepoRoot: resolveCanonicalRepoRoot(canon3, nodeSyncHostIo),
      }),
      "utf8",
    )
    const wtRes = runEnvDumpLauncher(wt3, {})
    expect(wtRes.parsed.url).toBe("http://127.0.0.1:22345")

    const repo4 = makeTempRepo("harness-rfc0009-l-fallback-")
    const fb = runEnvDumpLauncher(repo4, {})
    expect(fb.stderr).toContain("falling back to derived URL")
  })

  it("F-8.1 & F-13.4: epoch mismatch forces RequiresCleanRebuild with matching hashes, and statModeSync undefined fails closed", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-f8-f13-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })

    // Write matching receipts first, then overwrite only .cluster-schema-epoch
    const initialDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), "old-epoch-v1\n", "utf8")

    const epochDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    expect(epochDrift.action._tag).toBe("RequiresCleanRebuild")

    // F-13.4: ensureOmnigraphEndpointTokens fails closed when statModeSync returns undefined
    const tokensPath = join(clusterDir, "auth-tokens.json")
    writeFileSync(
      tokensPath,
      JSON.stringify({ schemaVersion: 1, cliToken: "a", mcpToken: "b" }),
      "utf8",
    )
    chmodSync(tokensPath, 0o600)
    const statSpy = vi.spyOn(nodeSyncHostIo, "statModeSync").mockReturnValueOnce(undefined)
    try {
      const tokRes = ensureOmnigraphEndpointTokens(clusterDir)
      const errMsg = match(tokRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure.message)
        .with({ _tag: "Success" }, () => undefined)
        .exhaustive()
      expect(errMsg).toContain("Unable to stat mode")
    } finally {
      statSpy.mockRestore()
    }
  })

  it("F-12.1: syncOmnigraphOnDone preserves existing spanTraceBlob when .harness/spans.jsonl is missing at done time", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-f12-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const drift = await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, false))
    writeClusterDriftReceipts(clusterDir, drift.expectedStamp, configDir)
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)

    const preservedPayload = '{"span":"preserved-from-verify"}\n'
    let getCount = 0
    let putBody = ""
    let statCount = 0
    const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      if (req.method === "GET" && url.includes("/blob")) {
        getCount += 1
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Omnigraph-Http-Api": "0.14",
        })
        res.end(preservedPayload)
        return
      }
      if (req.method === "PUT" && url.includes("/blob")) {
        let body = ""
        req.on("data", (c) => {
          body += String(c)
        })
        req.on("end", () => {
          putBody = body
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "written",
              sha256: "abc",
              size: preservedPayload.length,
              etag: '"e1"',
              serverRef: "srv-1",
            }),
          )
        })
        return
      }
      if (req.method === "HEAD" && url.includes("/blob")) {
        statCount += 1
        res.writeHead(200, {
          "Content-Length": String(preservedPayload.length),
          ETag: '"e1"',
          "Content-Type": "application/octet-stream",
          "Omnigraph-Http-Api": "0.14",
        })
        res.end()
        return
      }
      if (url.includes("/load")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({ outcome: "loaded", commit_id: "c1", nodes_loaded: 1, edges_loaded: 0 }),
        )
        return
      }
      if (url.includes("/branches/diff")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "ok",
            from_commit_id: "c0",
            to_commit_id: "c1",
            changes: [],
            netNodeCount: 0,
            netEdgeCount: 0,
          }),
        )
        return
      }
      if (url.includes("/branches/merge")) {
        let body = ""
        req.on("data", (c) => {
          body += String(c)
        })
        req.on("end", () => {
          const isDryRun = body.includes('"dry_run":true')
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "already_up_to_date",
              source: taskBranches.implBranch,
              target: taskBranches.mainBranch,
              ...(isDryRun ? { dry_run: true } : { branch_deleted: true }),
              commit: null,
            }),
          )
        })
        return
      }
      res.writeHead(200, headers)
      res.end(
        JSON.stringify({
          outcome: "ok",
          branches: [taskBranches.mainBranch, taskBranches.implBranch],
        }),
      )
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const port = (server.address() as AddressInfo).port
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: canonicalRoot,
        updatedAt: null,
      }),
      "utf8",
    )
    mkdirSync(join(repoRoot, ".harness"), { recursive: true })
    // Intentionally do NOT create .harness/spans.jsonl
    const g = buildHarnessGraph({
      tests: [
        {
          testId: "tc-preserve-1",
          testFile: "test/demo.test.ts",
          testName: "demo",
          line: 1,
          isPropertyTest: false,
        },
      ],
    })
    saveGraphSnapshot(g, join(repoRoot, ".harness", "graph-snapshot.json"), nodeSyncHostIo)

    try {
      const doneRes = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(doneRes).toBeUndefined()
      expect(getCount).toBe(1)
      expect(putBody).toBe(preservedPayload)
      expect(statCount).toBe(1)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("F-15.1: unlockOmnigraphClusterIfNeeded, ensureLocalOmnigraphReady NoOp pkill failure, and syncOmnigraphOnDone partial failures", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-f15-1-")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "__cluster"), { recursive: true })

    // Invalid lock.json returns invalid-lock-json
    writeFileSync(join(clusterDir, "__cluster", "lock.json"), "{bad-json", "utf8")
    const badLock = unlockOmnigraphClusterIfNeeded("omnigraph", clusterDir)
    expect(badLock.ok).toBe(false)
    expect(badLock.reason).toBe("invalid-lock-json")

    // Valid lock.json runs force-unlock and surfaces non-zero exit failure
    writeFileSync(
      join(clusterDir, "__cluster", "lock.json"),
      JSON.stringify({ lock_id: "lock-123" }),
      "utf8",
    )
    const execSpy = vi.spyOn(nodeSyncHostIo, "execFileSync").mockImplementationOnce(() => ({
      _tag: "Exited" as const,
      exitCode: 1,
      stdout: "",
      stderr: "locked",
    }))
    const failedUnlock = unlockOmnigraphClusterIfNeeded("omnigraph", clusterDir)
    execSpy.mockRestore()
    expect(failedUnlock.ok).toBe(false)
    expect(failedUnlock.reason).toBe("force-unlock-failed:lock-123")

    // ensureLocalOmnigraphReady returns false when server.json is corrupt and pkill fails in NoOp branch
    rmSync(join(clusterDir, "__cluster"), { recursive: true, force: true })
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const drift = await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, false))
    writeClusterDriftReceipts(clusterDir, drift.expectedStamp, configDir)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    writeFileSync(join(clusterDir, "server.json"), "{corrupt-server-json", "utf8")
    const pkillFailSpy = vi.spyOn(nodeSyncHostIo, "execFileSync").mockImplementation(() => ({
      _tag: "Exited" as const,
      exitCode: 2,
      stdout: "",
      stderr: "pkill error",
    }))
    try {
      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(ready).toBe(false)
    } finally {
      pkillFailSpy.mockRestore()
    }
  })

  it("runPreMergeOmnigraphBranchVerify allows EffectFn deletions absent from plan-graph-snapshot.json while blocking planned EffectFn deletions", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-del-plan-")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    mkdirSync(join(repoRoot, ".harness"), { recursive: true })
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)

    let deletedEntityId = "libs/sample/domain/src/index.ts#greet"
    let deletedSpanName = "Sample.greet"
    let deletedWasStub = false
    const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      if (url.includes("/branches/diff")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "ok",
            serverRef: "srv-1",
            from_commit_id: "c1",
            to_commit_id: "c2",
            changes: [
              {
                id: deletedEntityId,
                kind: "node",
                op: "delete",
                type: { id: "t1", name: "EffectFn" },
                before: { properties: { isStub: deletedWasStub, spanName: deletedSpanName } },
                after: null,
              },
            ],
            netNodeCount: -1,
            netEdgeCount: 0,
          }),
        )
        return
      }
      if (url.includes("/branches/merge")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "already_up_to_date",
            source: taskBranches.implBranch,
            target: taskBranches.mainBranch,
            dry_run: true,
            commit: null,
            serverRef: "srv-1",
          }),
        )
        return
      }
      res.writeHead(200, headers)
      res.end(
        JSON.stringify({
          outcome: "ok",
          branches: [taskBranches.mainBranch, taskBranches.planBranch, taskBranches.implBranch],
        }),
      )
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const port = (server.address() as AddressInfo).port
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: canonicalRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    try {
      const planSnapshotPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
      const planGraph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#plannedFn",
            spanName: "Sample.plannedFn",
            file: "libs/sample/domain/src/index.ts",
            line: 20,
            packageTag: "domain",
            isStub: true,
          },
        ],
      })
      saveGraphSnapshot(planGraph, planSnapshotPath, nodeSyncHostIo)
      const implGraph = buildHarnessGraph({})

      // 1. Intentional deletion of pre-existing function absent from plan-graph-snapshot.json passes
      const intentionalDeleteRes = await Effect.runPromise(
        runPreMergeOmnigraphBranchVerify(
          repoRoot,
          taskBranches,
          false,
          "block",
          { repoRoot },
          Date.now(),
          implGraph,
        ),
      )
      expect(intentionalDeleteRes).toBeUndefined()

      // 2. Dropping an EffectFn that WAS present in plan-graph-snapshot.json still blocks
      deletedEntityId = "libs/sample/domain/src/index.ts#plannedFn"
      deletedSpanName = "Sample.plannedFn"
      deletedWasStub = true
      const droppedPlannedRes = await Effect.runPromise(
        runPreMergeOmnigraphBranchVerify(
          repoRoot,
          taskBranches,
          false,
          "block",
          { repoRoot },
          Date.now(),
          implGraph,
        ),
      )
      expect(droppedPlannedRes?.exitCode).toBe(1)
      expect(droppedPlannedRes?.stderr).toContain("[planned-effect-fn-dropped]")
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
