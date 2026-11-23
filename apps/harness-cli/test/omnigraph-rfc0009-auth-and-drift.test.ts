import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkflowStoreUnavailableError } from "@harness/contract"
import { readTelemetryEvents } from "@harness/gates"
import {
  buildHarnessGraph,
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import {
  isBranchNotFoundError,
  runOmnigraphMaintenance,
  runPreMergeOmnigraphBranchVerify,
  syncOmnigraphOnDone,
  syncVerifyImplToOmnigraph,
} from "../src/commands/done-omnigraph-helpers.js"
import { handleGc } from "../src/commands/gc-and-ontology.command.js"
import {
  acquireOmnigraphClusterLockEffect,
  ensureOmnigraphEndpointTokens,
  evaluateClusterConfigDrift,
  killOmnigraphServerPidIfAlive,
  releaseOmnigraphClusterLock,
  resolveOmnigraphConfigDir,
  tryAcquireOmnigraphClusterLock,
  writeClusterDriftReceipts,
} from "../src/commands/omnigraph-auth-and-drift.js"
import {
  ensureLocalOmnigraphReady,
  stopStaleOmnigraphClusterBeforeDelete,
} from "../src/commands/omnigraph-lifecycle.js"
import {
  cleanupRfc0009TempDirs,
  createRfc0009TempRepo,
  getDeadChildPid,
} from "./helpers/omnigraph-rfc0009-fixture.js"

describe("RFC-0009 Omnigraph v0.14.0 auth, spawn readiness, locks & maintenance", () => {
  const tempDirs: Array<string> = []
  const makeTempRepo = (prefix: string) => createRfc0009TempRepo(tempDirs, prefix)
  afterEach(() => {
    vi.restoreAllMocks()
    cleanupRfc0009TempDirs(tempDirs)
  })

  const setupFakeBinRepoForSpawn = (clusterYaml: string) => {
    const repoRoot = makeTempRepo("harness-rfc0009-spawn-")
    writeFileSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"), clusterYaml, "utf8")
    const fakeHome = join(repoRoot, "fake-home")
    const binDir = join(fakeHome, ".local", "bin")
    mkdirSync(binDir, { recursive: true })
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const port = deriveRepoOmnigraphPort(canonicalRoot, nodeSyncHostIo)
    const capturePath = join(repoRoot, "spawn-capture.json")

    const fakeCli = join(binDir, "omnigraph")
    writeFileSync(
      fakeCli,
      `#!/bin/sh
if [ "$1" = "cluster" ] && [ "$2" = "apply" ]; then
  mkdir -p "${join(repoRoot, ".harness", "omnigraph-cluster", "graphs", "harness.omni")}"
  echo '{"status":"applied"}'
  exit 0
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
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  argv: process.argv.slice(2),
  bearerTokensJson: process.env.OMNIGRAPH_SERVER_BEARER_TOKENS_JSON ?? null,
  embeddingApiKey: process.env.OMNIGRAPH_EMBEDDING_API_KEY ?? null,
  embeddingsMock: process.env.OMNIGRAPH_EMBEDDINGS_MOCK ?? null,
}));
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" });
  res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }));
});
server.listen(${port}, "127.0.0.1");
setTimeout(() => process.exit(0), 5000);
`,
      "utf8",
    )
    chmodSync(fakeServer, 0o755)
    return { repoRoot, fakeHome, capturePath }
  }

  const withSavedSpawnEnv = async (run: () => Promise<void>): Promise<void> => {
    const prevHome = process.env.HOME
    const prevApiKey = process.env.OMNIGRAPH_EMBEDDING_API_KEY
    const prevMock = process.env.OMNIGRAPH_EMBEDDINGS_MOCK
    const prevUrl = process.env.OMNIGRAPH_URL
    const prevEmbedBaseUrl = process.env.HARNESS_EMBEDDING_BASE_URL
    try {
      await run()
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
      if (prevApiKey === undefined)
        Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDING_API_KEY")
      else process.env.OMNIGRAPH_EMBEDDING_API_KEY = prevApiKey
      if (prevMock === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDINGS_MOCK")
      else process.env.OMNIGRAPH_EMBEDDINGS_MOCK = prevMock
      if (prevUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevUrl
      if (prevEmbedBaseUrl === undefined)
        Reflect.deleteProperty(process.env, "HARNESS_EMBEDDING_BASE_URL")
      else process.env.HARNESS_EMBEDDING_BASE_URL = prevEmbedBaseUrl
    }
  }

  it("F-6.2 & S-1.1 & S-1.2: ensureLocalOmnigraphReady spawns policy-gated server with OMNIGRAPH_SERVER_BEARER_TOKENS_JSON and no --unauthenticated", async () => {
    await withSavedSpawnEnv(async () => {
      // Case 1: policy-gated cluster with unset OMNIGRAPH_EMBEDDING_API_KEY and unavailable Ollama falls back to OMNIGRAPH_EMBEDDINGS_MOCK="1"
      const policyCase = setupFakeBinRepoForSpawn("name: test\npolicies:\n  - name: p1\n")
      process.env.HOME = policyCase.fakeHome
      process.env.HARNESS_EMBEDDING_BASE_URL = "http://127.0.0.1:1/v1"
      Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDING_API_KEY")
      Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDINGS_MOCK")
      Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")

      const ready1 = await Effect.runPromise(ensureLocalOmnigraphReady(policyCase.repoRoot))
      expect(ready1).toBe(true)

      const cap1 = JSON.parse(readFileSync(policyCase.capturePath, "utf8")) as {
        readonly argv: ReadonlyArray<string>
        readonly bearerTokensJson: string | null
        readonly embeddingApiKey: string | null
        readonly embeddingsMock: string | null
      }
      expect(cap1.argv).not.toContain("--unauthenticated")
      expect(cap1.bearerTokensJson).not.toBeNull()
      expect(cap1.embeddingsMock).toBe("1")
      expect(cap1.embeddingApiKey).toBe("ollama-local")

      const clusterDir1 = resolveOmnigraphClusterDir(policyCase.repoRoot, nodeSyncHostIo)
      const tokensPath = join(clusterDir1, "auth-tokens.json")
      const serverJsonPath = join(clusterDir1, "server.json")
      expect(statSync(tokensPath).mode & 0o777).toBe(0o600)
      expect(statSync(serverJsonPath).mode & 0o777).toBe(0o600)
      const serverMeta = JSON.parse(readFileSync(serverJsonPath, "utf8")) as Record<string, unknown>
      expect(serverMeta.token).toBeUndefined()
      expect(serverMeta.embeddingsMode).toBe("mock")
      expect(typeof serverMeta.pid).toBe("number")
      if (typeof serverMeta.pid === "number") {
        try {
          process.kill(serverMeta.pid, "SIGTERM")
        } catch {
          // ignore
        }
      }

      // Case 2: explicit OMNIGRAPH_EMBEDDING_API_KEY does NOT set OMNIGRAPH_EMBEDDINGS_MOCK="1", and no policies logs --unauthenticated warning
      const unauthCase = setupFakeBinRepoForSpawn("name: test\n")
      process.env.HOME = unauthCase.fakeHome
      process.env.OMNIGRAPH_EMBEDDING_API_KEY = "real-provider-key"
      Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDINGS_MOCK")

      const stderrChunks: Array<string> = []
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrChunks.push(String(chunk))
        return true
      })
      const ready2 = await Effect.runPromise(ensureLocalOmnigraphReady(unauthCase.repoRoot))
      stderrSpy.mockRestore()
      expect(ready2).toBe(true)

      const cap2 = JSON.parse(readFileSync(unauthCase.capturePath, "utf8")) as {
        readonly argv: ReadonlyArray<string>
        readonly embeddingsMock: string | null
        readonly embeddingApiKey: string | null
      }
      expect(cap2.argv).toContain("--unauthenticated")
      expect(cap2.embeddingApiKey).toBe("real-provider-key")
      expect(cap2.embeddingsMock).toBeNull()
      expect(stderrChunks.join("")).toContain(
        "Warning: spawning omnigraph-server with --unauthenticated because cluster.yaml declares no policies:",
      )
      const clusterDir2 = resolveOmnigraphClusterDir(unauthCase.repoRoot, nodeSyncHostIo)
      const serverMeta2 = JSON.parse(
        readFileSync(join(clusterDir2, "server.json"), "utf8"),
      ) as Record<string, unknown>
      if (typeof serverMeta2.pid === "number") {
        try {
          process.kill(serverMeta2.pid, "SIGTERM")
        } catch {
          // ignore
        }
      }
    })
  })

  it("F-6.2 & S-1.1: ensureLocalOmnigraphReady enables live qwen3-embedding:8b when available and preserves shared canonical cluster for linked worktrees", async () => {
    await withSavedSpawnEnv(async () => {
      // Case 3: live local Ollama qwen3-embedding:8b detected on HARNESS_EMBEDDING_BASE_URL omits OMNIGRAPH_EMBEDDINGS_MOCK
      const ollamaMockServer = createServer((req, res) => {
        if (req.url === "/api/tags") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              models: [{ name: "qwen3-embedding:8b", model: "qwen3-embedding:8b" }],
            }),
          )
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((resolveListen) => {
        ollamaMockServer.listen(0, "127.0.0.1", () => resolveListen())
      })
      try {
        const ollamaAddr = ollamaMockServer.address() as AddressInfo
        const ollamaCase = setupFakeBinRepoForSpawn("name: test\npolicies:\n  - name: p1\n")
        process.env.HOME = ollamaCase.fakeHome
        process.env.HARNESS_EMBEDDING_BASE_URL = `http://127.0.0.1:${ollamaAddr.port}/v1`
        Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDING_API_KEY")
        Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDINGS_MOCK")
        Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")

        const ready3 = await Effect.runPromise(ensureLocalOmnigraphReady(ollamaCase.repoRoot))
        expect(ready3).toBe(true)

        const cap3 = JSON.parse(readFileSync(ollamaCase.capturePath, "utf8")) as {
          readonly embeddingsMock: string | null
          readonly embeddingApiKey: string | null
        }
        expect(cap3.embeddingsMock).toBeNull()
        expect(cap3.embeddingApiKey).toBe("ollama-local")

        const clusterDir3 = resolveOmnigraphClusterDir(ollamaCase.repoRoot, nodeSyncHostIo)
        const serverMeta3 = JSON.parse(
          readFileSync(join(clusterDir3, "server.json"), "utf8"),
        ) as Record<string, unknown>
        expect(serverMeta3.embeddingsMode).toBe("live")
        if (typeof serverMeta3.pid === "number") {
          try {
            process.kill(serverMeta3.pid, "SIGTERM")
          } catch {
            // ignore
          }
        }

        // Case 4: NoOp fast-path upgrades running "mock" daemon to "live" when Ollama qwen3-embedding:8b becomes available
        const upgradeCase = setupFakeBinRepoForSpawn("name: test\npolicies:\n  - name: p1\n")
        process.env.HOME = upgradeCase.fakeHome
        process.env.HARNESS_EMBEDDING_BASE_URL = "http://127.0.0.1:1/v1"
        Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDING_API_KEY")
        Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDINGS_MOCK")
        Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")

        const upgradeInitialReady = await Effect.runPromise(
          ensureLocalOmnigraphReady(upgradeCase.repoRoot),
        )
        expect(upgradeInitialReady).toBe(true)
        const upgradeClusterDir = resolveOmnigraphClusterDir(upgradeCase.repoRoot, nodeSyncHostIo)
        const mockMeta = JSON.parse(
          readFileSync(join(upgradeClusterDir, "server.json"), "utf8"),
        ) as Record<string, unknown>
        expect(mockMeta.embeddingsMode).toBe("mock")
        const pid1 = mockMeta.pid
        expect(typeof pid1).toBe("number")

        try {
          process.env.HARNESS_EMBEDDING_BASE_URL = `http://127.0.0.1:${ollamaAddr.port}/v1`
          // Linked worktree sharing canonical cluster must NOT kill or upgrade the canonical mock daemon
          const linkedWtRoot = mkdtempSync(join(tmpdir(), "harness-rfc0009-wt-upgrade-"))
          const gitWtDir = join(upgradeCase.repoRoot, ".git", "worktrees", "wt-upgrade")
          mkdirSync(gitWtDir, { recursive: true })
          writeFileSync(join(gitWtDir, "commondir"), "../..\n", "utf8")
          writeFileSync(join(linkedWtRoot, ".git"), `gitdir: ${gitWtDir}\n`, "utf8")
          const wtStderrChunks: Array<string> = []
          const wtStderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            wtStderrChunks.push(String(chunk))
            return true
          })
          const prevAllowWt = process.env.HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD
          Reflect.deleteProperty(process.env, "HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD")
          try {
            const wtReady = await Effect.runPromise(ensureLocalOmnigraphReady(linkedWtRoot))
            expect(wtReady).toBe(true)
            const stillMockMeta = JSON.parse(
              readFileSync(join(upgradeClusterDir, "server.json"), "utf8"),
            ) as Record<string, unknown>
            expect(stillMockMeta.pid).toBe(pid1)
            expect(stillMockMeta.embeddingsMode).toBe("mock")
            expect(wtStderrChunks.join("")).toContain(
              "skipping mock-to-live embeddings upgrade of shared canonical cluster",
            )
          } finally {
            wtStderrSpy.mockRestore()
            if (prevAllowWt !== undefined) {
              process.env.HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD = prevAllowWt
            }
            rmSync(linkedWtRoot, { recursive: true, force: true })
          }

          const upgradeLiveReady = await Effect.runPromise(
            ensureLocalOmnigraphReady(upgradeCase.repoRoot),
          )
          expect(upgradeLiveReady).toBe(true)
          const liveMeta = JSON.parse(
            readFileSync(join(upgradeClusterDir, "server.json"), "utf8"),
          ) as Record<string, unknown>
          expect(liveMeta.embeddingsMode).toBe("live")
          expect(typeof liveMeta.pid).toBe("number")
          expect(liveMeta.pid).not.toBe(pid1)
          const capUpgrade = JSON.parse(readFileSync(upgradeCase.capturePath, "utf8")) as {
            readonly embeddingsMock: string | null
          }
          expect(capUpgrade.embeddingsMock).toBeNull()
        } finally {
          if (typeof pid1 === "number") {
            try {
              process.kill(pid1, "SIGTERM")
            } catch {
              // ignore
            }
          }
          try {
            const latestMeta = JSON.parse(
              readFileSync(join(upgradeClusterDir, "server.json"), "utf8"),
            ) as Record<string, unknown>
            if (typeof latestMeta.pid === "number") {
              process.kill(latestMeta.pid, "SIGTERM")
            }
          } catch {
            // ignore
          }
        }
      } finally {
        ollamaMockServer.closeAllConnections()
        ollamaMockServer.close()
      }
    })
  })

  it("F-7.2: evaluateClusterConfigDrift classifies cluster.yaml, graph.policy.yaml, and cluster.policy.yaml drift as RequiresCleanRebuild", async () => {
    for (const fileName of ["cluster.yaml", "graph.policy.yaml", "cluster.policy.yaml"] as const) {
      const repoRoot = makeTempRepo("harness-rfc0009-policydrift-")
      const configDir = join(repoRoot, "libs", "harness", "graph")
      writeFileSync(join(configDir, "graph.policy.yaml"), "version: 1\n", "utf8")
      writeFileSync(join(configDir, "cluster.policy.yaml"), "version: 1\n", "utf8")
      const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
      const initialDrift = await Effect.runPromise(
        evaluateClusterConfigDrift(clusterDir, configDir, false),
      )
      writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)

      writeFileSync(join(configDir, fileName), "# edited\nversion: 2\n", "utf8")
      const drifted = await Effect.runPromise(
        evaluateClusterConfigDrift(clusterDir, configDir, true),
      )
      expect(drifted.action._tag).toBe("RequiresCleanRebuild")
    }
  })

  it("F-7.3: executes omnigraph policy validate and policy-tests.yaml", () => {
    const omnigraphBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")
    expect(nodeSyncHostIo.existsSync(omnigraphBin)).toBe(true)

    const workspaceRoot = resolve(import.meta.dirname, "../../..")
    const graphConfigDir = join(workspaceRoot, "libs", "harness", "graph")
    const tempDir = mkdtempSync(join(tmpdir(), "harness-rfc0009-policytest-"))
    tempDirs.push(tempDir)
    const tempClusterDir = join(tempDir, "cluster")
    mkdirSync(tempClusterDir, { recursive: true })

    execFileSync(
      omnigraphBin,
      [
        "cluster",
        "apply",
        "--target",
        `file://${tempClusterDir}`,
        "--config",
        graphConfigDir,
        "--as",
        "harness-cli",
        "--json",
      ],
      { encoding: "utf8" },
    )
    const validateOut = execFileSync(
      omnigraphBin,
      ["policy", "validate", "--target", `file://${tempClusterDir}`, "--graph", "harness"],
      { encoding: "utf8" },
    )
    expect(validateOut).toContain("policy valid: bundle 'graph-access'")

    const testOut = execFileSync(
      omnigraphBin,
      [
        "policy",
        "test",
        "--target",
        `file://${tempClusterDir}`,
        "--graph",
        "harness",
        "--tests",
        join(graphConfigDir, "policy-tests.yaml"),
      ],
      { encoding: "utf8" },
    )
    expect(testOut).toContain("policy tests passed: 13 cases")
  })

  it("F-7.4 & S-2.1: tools/omnigraph-mcp-launcher.mjs enforces loopback, canonicalRepoRoot, live PID, and 0o600 auth-tokens checks", () => {
    const launcherPath = resolve(import.meta.dirname, "../../../tools/omnigraph-mcp-launcher.mjs")
    const runLauncherWith = (
      setup: (
        repoRoot: string,
        clusterDir: string,
        canonicalRoot: string,
        expectedPort: number,
      ) => Record<string, string | undefined>,
    ) => {
      const repoRoot = makeTempRepo("harness-rfc0009-launcher-sec-")
      const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
      mkdirSync(clusterDir, { recursive: true })
      const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
      const expectedPort = deriveRepoOmnigraphPort(canonicalRoot, nodeSyncHostIo)
      const binDir = join(repoRoot, "fake-bin")
      mkdirSync(binDir, { recursive: true })
      const fakeNpx = join(binDir, "npx")
      writeFileSync(
        fakeNpx,
        '#!/bin/sh\nprintf "{\\"url\\":\\"%s\\",\\"token\\":\\"%s\\"}\\n" "$OMNIGRAPH_URL" "$OMNIGRAPH_TOKEN"\n',
        "utf8",
      )
      chmodSync(fakeNpx, 0o755)
      const extraEnv = setup(repoRoot, clusterDir, canonicalRoot, expectedPort)
      const childEnv: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ...extraEnv,
      }
      if (!("OMNIGRAPH_URL" in extraEnv)) Reflect.deleteProperty(childEnv, "OMNIGRAPH_URL")
      if (!("OMNIGRAPH_BASE_URL" in extraEnv))
        Reflect.deleteProperty(childEnv, "OMNIGRAPH_BASE_URL")
      if (!("OMNIGRAPH_TOKEN" in extraEnv)) Reflect.deleteProperty(childEnv, "OMNIGRAPH_TOKEN")
      const res = nodeSyncHostIo.execFileSync(process.execPath, [launcherPath], {
        cwd: repoRoot,
        env: childEnv,
        timeoutMs: 10_000,
      })
      const exited = match(res)
        .with({ _tag: "Exited" }, (e) => e)
        .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, ({ _tag }) => {
          throw new Error(`Expected launcher exit, got ${_tag}`)
        })
        .exhaustive()
      return {
        parsed: JSON.parse(exited.stdout.trim()) as {
          readonly url: string
          readonly token: string
        },
        stderr: exited.stderr,
        expectedPort,
      }
    }

    // Non-loopback server.json.baseUrl is rejected
    const nonLoopbackMeta = runLauncherWith((_r, clusterDir, canonicalRoot) => {
      writeFileSync(
        join(clusterDir, "server.json"),
        JSON.stringify({
          pid: process.pid,
          baseUrl: "https://evil.example.com:9000",
          canonicalRepoRoot: canonicalRoot,
        }),
        "utf8",
      )
      return {}
    })
    expect(nonLoopbackMeta.parsed.url).toBe(`http://127.0.0.1:${nonLoopbackMeta.expectedPort}`)

    // Mismatched canonicalRepoRoot is rejected
    const wrongRootMeta = runLauncherWith((_r, clusterDir) => {
      writeFileSync(
        join(clusterDir, "server.json"),
        JSON.stringify({
          pid: process.pid,
          baseUrl: "http://127.0.0.1:19999",
          canonicalRepoRoot: "/tmp/other-repo",
        }),
        "utf8",
      )
      return {}
    })
    expect(wrongRootMeta.parsed.url).toBe(`http://127.0.0.1:${wrongRootMeta.expectedPort}`)

    // Dead PID is rejected
    const deadPidMeta = runLauncherWith((_r, clusterDir, canonicalRoot) => {
      writeFileSync(
        join(clusterDir, "server.json"),
        JSON.stringify({
          pid: getDeadChildPid(),
          baseUrl: "http://127.0.0.1:19999",
          canonicalRepoRoot: canonicalRoot,
        }),
        "utf8",
      )
      return {}
    })
    expect(deadPidMeta.parsed.url).toBe(`http://127.0.0.1:${deadPidMeta.expectedPort}`)

    // Permissive 0o644 auth-tokens.json is rejected with stderr warning
    const permTokens = runLauncherWith((_r, clusterDir) => {
      const tokensPath = join(clusterDir, "auth-tokens.json")
      writeFileSync(
        tokensPath,
        JSON.stringify({ schemaVersion: 1, cliToken: "cli", mcpToken: "mcp-secret" }),
        "utf8",
      )
      chmodSync(tokensPath, 0o644)
      return {}
    })
    expect(permTokens.parsed.token).toBe("")
    expect(permTokens.stderr).toContain("permissive mode 644")

    // Corrupt server.json logs stderr warning
    const corruptServer = runLauncherWith((_r, clusterDir) => {
      writeFileSync(join(clusterDir, "server.json"), "{corrupt-json", "utf8")
      return {}
    })
    expect(corruptServer.stderr).toContain("failed to read/parse JSON")

    // Non-loopback OMNIGRAPH_URL omits OMNIGRAPH_TOKEN
    const nonLoopbackEnv = runLauncherWith((_r, clusterDir) => {
      ensureOmnigraphEndpointTokens(clusterDir)
      return { OMNIGRAPH_URL: "https://remote.example.com" }
    })
    expect(nonLoopbackEnv.parsed.url).toBe("https://remote.example.com")
    expect(nonLoopbackEnv.parsed.token).toBe("")
  })

  it("F-8.1b: runPreMergeOmnigraphBranchVerify blocks unchanged stub present in both plan and impl via remainingStubCount", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-f81b-")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)

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
            to_commit_id: "c1",
            changes: [],
            netNodeCount: 0,
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

    try {
      const implGraph = buildHarnessGraph({
        fns: [
          {
            qualname: "src/demo.ts#unchangedStub",
            spanName: "Demo.unchangedStub",
            file: "src/demo.ts",
            line: 10,
            packageTag: "domain",
            isStub: true,
          },
        ],
      })
      const res = await Effect.runPromise(
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
      expect(res?.exitCode).toBe(1)
      expect(res?.stderr).toContain("[unimplemented-stub-remaining]")
      expect(res?.stderr).toContain("1 unchanged stub node(s)")
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("isBranchNotFoundError, HTTP 500/401 diff failure, and Antigravity hook exitCode 0", async () => {
    expect(isBranchNotFoundError({ name: "NotFoundError", message: "missing" })).toBe(false)
    expect(isBranchNotFoundError({ status: 404, message: "not found" })).toBe(false)
    expect(isBranchNotFoundError({ code: "branch_not_found" })).toBe(true)
    expect(isBranchNotFoundError({ status: 404, message: "branch plan/current not found" })).toBe(
      true,
    )
    expect(isBranchNotFoundError(new Error("listening on port 4040"))).toBe(false)
    expect(isBranchNotFoundError(new Error("config not found"))).toBe(false)
    expect(isBranchNotFoundError({ status: 500, message: "internal server error" })).toBe(false)
    expect(isBranchNotFoundError({ status: 401, message: "unauthorized" })).toBe(false)

    const repoRoot = makeTempRepo("harness-rfc0009-f102-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const initialDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)

    const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      if (url.includes("/branches/diff")) {
        res.writeHead(500, headers)
        res.end(JSON.stringify({ code: "internal_error", message: "db error" }))
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

    try {
      const diffFailRes = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(diffFailRes?.exitCode).toBe(1)
      expect(diffFailRes?.stderr).toContain("done:omnigraph-branch-diff")
      expect(diffFailRes?.stderr).not.toContain("missing-merge-base")

      const agyHookRes = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, true, "block"),
      )
      expect(agyHookRes?.exitCode).toBe(0)
      expect(JSON.parse(agyHookRes?.stdout ?? "{}")).toMatchObject({ decision: "block" })
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("startup lock prevents stealing live PID lock, enforces compare-and-delete, and waits on contention", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-locks-")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    const lockPath = `${clusterDir}.startup.lock`

    // Old lock owned by live PID is NOT stolen
    mkdirSync(join(repoRoot, ".harness"), { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, lockToken: "other-owner-token", createdAtMs: 1 }),
      "utf8",
    )
    const oldDate = new Date(Date.now() - 120_000)
    utimesSync(lockPath, oldDate, oldDate)
    expect(tryAcquireOmnigraphClusterLock(clusterDir)._tag).toBe("Contended")

    // releaseOmnigraphClusterLock does not unlink lock owned by another token
    releaseOmnigraphClusterLock({ lockPath, lockToken: "wrong-token" })
    expect(nodeSyncHostIo.existsSync(lockPath)).toBe(true)

    // acquireOmnigraphClusterLockEffect waits and acquires when lock is released
    setTimeout(() => {
      rmSync(lockPath, { force: true })
    }, 150)
    const acquired = await Effect.runPromise(
      acquireOmnigraphClusterLockEffect(clusterDir, { timeoutMs: 2_000 }),
    )
    expect(acquired.lockPath).toBe(lockPath)
    releaseOmnigraphClusterLock(acquired)
    expect(nodeSyncHostIo.existsSync(lockPath)).toBe(false)

    // Bounded timeout fails with WorkflowStoreUnavailableError when live owner holds lock
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, lockToken: "held-token", createdAtMs: Date.now() }),
      "utf8",
    )
    const timedOutExit = await Effect.runPromiseExit(
      acquireOmnigraphClusterLockEffect(clusterDir, { timeoutMs: 150 }),
    )
    match(timedOutExit)
      .with({ _tag: "Success" }, () => expect.fail("Expected timeout failure"))
      .with({ _tag: "Failure" }, ({ cause }) => {
        const errOpt = Cause.findErrorOption(cause)
        match(errOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(WorkflowStoreUnavailableError)
          })
          .with({ _tag: "None" }, () => expect.fail("Expected WorkflowStoreUnavailableError"))
          .exhaustive()
      })
      .exhaustive()
    rmSync(lockPath, { force: true })

    // ensureLocalOmnigraphReady waits on startup lock before evaluating readyz/drift
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const initDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initDrift.expectedStamp, configDir)
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const readyEvents: Array<string> = []
    const readyServer = createServer((req, res) => {
      if (req.url === "/readyz") {
        readyEvents.push("readyz")
        res.writeHead(200, { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" })
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      readyServer.once("error", rejectPromise)
      readyServer.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const readyPort = (readyServer.address() as AddressInfo).port
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port: readyPort,
        baseUrl: `http://127.0.0.1:${readyPort}`,
        canonicalRepoRoot: canonicalRoot,
        updatedAt: null,
      }),
      "utf8",
    )
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, lockToken: "f13-1-holder", createdAtMs: Date.now() }),
      "utf8",
    )
    setTimeout(() => {
      readyEvents.push("lock-released")
      rmSync(lockPath, { force: true })
    }, 150)
    try {
      const readyRes = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(readyRes).toBe(true)
      expect(readyEvents.indexOf("lock-released")).toBeLessThan(readyEvents.indexOf("readyz"))
    } finally {
      readyServer.closeAllConnections()
      readyServer.close()
    }
  })

  it("handleGc --strict runs optimize only while runOmnigraphMaintenance includeCleanup runs optimize + cleanup", async () => {
    // gc --strict invokes optimize only (without destructive cleanup) on non-isolated cluster dir
    const gcRepo = makeTempRepo("harness-rfc0009-gc-")
    const gcClusterDir = resolveOmnigraphClusterDir(gcRepo, nodeSyncHostIo)
    mkdirSync(gcClusterDir, { recursive: true })
    const prevHome = process.env.HOME
    const fakeHome = join(gcRepo, "fake-home")
    mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true })
    const gcOptLog = join(gcRepo, "gc-opt.log")
    writeFileSync(
      join(fakeHome, ".local", "bin", "omnigraph"),
      `#!/bin/sh\necho "$*" >> "${gcOptLog}"\n`,
      "utf8",
    )
    chmodSync(join(fakeHome, ".local", "bin", "omnigraph"), 0o755)
    process.env.HOME = fakeHome
    try {
      await Effect.runPromise(handleGc(["gc", "--strict"], { repoRoot: gcRepo }))
      const optLog = readFileSync(gcOptLog, "utf8")
      expect(optLog).toContain("optimize")
      expect(optLog).not.toContain("cleanup")

      // runOmnigraphMaintenance with includeCleanup: true (used by done) runs optimize + cleanup
      writeFileSync(gcOptLog, "", "utf8")
      runOmnigraphMaintenance(gcRepo, { includeCleanup: true })
      const doneOptLog = readFileSync(gcOptLog, "utf8")
      expect(doneOptLog).toContain("optimize")
      expect(doneOptLog).toContain("cleanup --target")
      expect(doneOptLog).toContain("--keep 5 --confirm")
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
    }

    // killOmnigraphServerPidIfAlive refuses unsafe PID (current vitest PID) & stopStaleOmnigraphClusterBeforeDelete
    expect(
      await Effect.runPromise(killOmnigraphServerPidIfAlive(process.pid, gcClusterDir, "test")),
    ).toBe(false)
    expect(stopStaleOmnigraphClusterBeforeDelete(gcClusterDir, undefined)).toBe(true)
  })

  it("syncVerifyImplToOmnigraph uploads and stats blob and isolated done skips omnigraph:merge-main telemetry", async () => {
    const prevHome = process.env.HOME
    // syncVerifyImplToOmnigraph sends putBlob + statBlob when spans.jsonl + VitestCase exist
    const verifyRepo = makeTempRepo("harness-rfc0009-putblob-")
    const verifyClusterDir = resolveOmnigraphClusterDir(verifyRepo, nodeSyncHostIo)
    mkdirSync(verifyClusterDir, { recursive: true })
    const vDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(
        verifyClusterDir,
        join(verifyRepo, "libs", "harness", "graph"),
        false,
      ),
    )
    writeClusterDriftReceipts(
      verifyClusterDir,
      vDrift.expectedStamp,
      join(verifyRepo, "libs", "harness", "graph"),
    )
    const canonicalRoot = resolveCanonicalRepoRoot(verifyRepo, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(verifyRepo, nodeSyncHostIo)
    const putBlobRequests: Array<string> = []
    const statBlobRequests: Array<string> = []
    const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      if (req.method === "PUT" && url.includes("/blob")) {
        putBlobRequests.push(url)
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "written",
            sha256: "abc",
            size: 10,
            etag: '"etag-1"',
            serverRef: "srv-1",
          }),
        )
        return
      }
      if (req.method === "HEAD" && url.includes("/blob")) {
        statBlobRequests.push(url)
        res.writeHead(200, {
          "Content-Length": "10",
          ETag: '"etag-1"',
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
        req.on("data", (chunk) => {
          body += String(chunk)
        })
        req.on("end", () => {
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "already_up_to_date",
              source: taskBranches.implBranch,
              target: taskBranches.mainBranch,
              dry_run: true,
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
      join(verifyClusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: canonicalRoot,
        updatedAt: null,
      }),
      "utf8",
    )
    const okBin = join(verifyRepo, "omnigraph-ok.sh")
    writeFileSync(
      okBin,
      '#!/bin/sh\necho \'{"status":"ok","errors":0,"warnings":0,"queries_processed":1,"findings":[]}\'\n',
      "utf8",
    )
    chmodSync(okBin, 0o755)
    mkdirSync(join(verifyRepo, "fake-home", ".local", "bin"), { recursive: true })
    writeFileSync(join(verifyRepo, "fake-home", ".local", "bin", "omnigraph"), readFileSync(okBin))
    chmodSync(join(verifyRepo, "fake-home", ".local", "bin", "omnigraph"), 0o755)
    process.env.HOME = join(verifyRepo, "fake-home")
    try {
      mkdirSync(join(verifyRepo, ".harness"), { recursive: true })
      writeFileSync(join(verifyRepo, ".harness", "spans.jsonl"), '{"span":"test"}\n', "utf8")
      const g = buildHarnessGraph({
        tests: [
          {
            testId: "test-case-1",
            testFile: "test/demo.test.ts",
            testName: "demo",
            line: 1,
            isPropertyTest: false,
          },
        ],
      })
      const syncRes = await Effect.runPromise(
        syncVerifyImplToOmnigraph(
          verifyRepo,
          g,
          join(verifyRepo, ".harness", "graph-snapshot.json"),
          taskBranches,
          { repoRoot: verifyRepo },
        ),
      )
      expect(syncRes).toBeUndefined()
      expect(putBlobRequests.length).toBe(1)
      expect(putBlobRequests[0]).toContain("spanTraceBlob")
      expect(statBlobRequests.length).toBe(1)
    } finally {
      server.closeAllConnections()
      server.close()
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
    }

    // Isolated workspace syncOmnigraphOnDone does not record omnigraph:merge-main telemetry
    const isoDir = mkdtempSync(join(tmpdir(), "harness-rfc0009-iso-"))
    tempDirs.push(isoDir)
    const isoRes = await Effect.runPromise(
      syncOmnigraphOnDone(isoDir, { repoRoot: isoDir }, false, "block"),
    )
    expect(isoRes).toBeUndefined()
    const telemetryLines = readTelemetryEvents(isoDir, nodeSyncHostIo)
    expect(telemetryLines.some((e) => e.toolName === "omnigraph:merge-main")).toBe(false)
  })

  it("startup lock steals dead-PID and aged corrupt locks, respects 2000ms grace on fresh corrupt locks, and aborts immediately on Failed", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-lock-r2-")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    mkdirSync(join(repoRoot, ".harness"), { recursive: true })
    const lockPath = `${clusterDir}.startup.lock`

    // Dead PID lock is stolen
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: getDeadChildPid(), lockToken: "dead", createdAtMs: 1 }),
      "utf8",
    )
    const deadRes = tryAcquireOmnigraphClusterLock(clusterDir)
    expect(deadRes._tag).toBe("Acquired")
    match(deadRes)
      .with({ _tag: "Acquired" }, ({ handle }) => releaseOmnigraphClusterLock(handle))
      .with({ _tag: "Contended" }, { _tag: "Failed" }, () => undefined)
      .exhaustive()

    // Fresh unparseable lock (< 2000ms) is Contended
    writeFileSync(lockPath, "{partial-json", "utf8")
    expect(tryAcquireOmnigraphClusterLock(clusterDir)._tag).toBe("Contended")

    // Aged unparseable lock (>= 2000ms) is stolen
    const aged = new Date(Date.now() - 5_000)
    utimesSync(lockPath, aged, aged)
    const agedRes = tryAcquireOmnigraphClusterLock(clusterDir)
    expect(agedRes._tag).toBe("Acquired")
    match(agedRes)
      .with({ _tag: "Acquired" }, ({ handle }) => releaseOmnigraphClusterLock(handle))
      .with({ _tag: "Contended" }, { _tag: "Failed" }, () => undefined)
      .exhaustive()

    // Failed write aborts acquireOmnigraphClusterLockEffect immediately
    vi.spyOn(nodeSyncHostIo, "tryWriteExclusiveTextSync").mockReturnValue({
      _tag: "Failed",
      code: "EACCES",
      message: "EACCES: permission denied",
    })
    const started = Date.now()
    const failedExit = await Effect.runPromiseExit(
      acquireOmnigraphClusterLockEffect(clusterDir, { timeoutMs: 10_000 }),
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    match(failedExit)
      .with({ _tag: "Success" }, () => expect.fail("Expected immediate lock write failure"))
      .with({ _tag: "Failure" }, ({ cause }) => {
        const errOpt = Cause.findErrorOption(cause)
        match(errOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            expect(value).toBeInstanceOf(WorkflowStoreUnavailableError)
            expect(value.reason).toContain("EACCES: permission denied")
          })
          .with({ _tag: "None" }, () => expect.fail("Expected WorkflowStoreUnavailableError"))
          .exhaustive()
      })
      .exhaustive()
  })

  it("killOmnigraphServerPidIfAlive terminates a real matching omnigraph-server child process", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-kill-real-")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const scriptPath = join(repoRoot, "omnigraph-server")
    writeFileSync(scriptPath, "setInterval(() => {}, 1000)\n", "utf8")
    const child = spawn(process.execPath, [scriptPath, "--cluster", `file://${clusterDir}`], {
      stdio: "ignore",
    })
    expect(child.pid).toBeDefined()
    const pid = child.pid!
    try {
      const killed = await Effect.runPromise(
        killOmnigraphServerPidIfAlive(pid, clusterDir, "test-kill"),
      )
      expect(killed).toBe(true)
    } finally {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already exited
      }
    }
  })

  it("F-1.1: linked worktree uses canonical config and refuses destructive RequiresCleanRebuild teardown", async () => {
    const canonicalRoot = makeTempRepo("harness-rfc0009-canon-")
    const worktreeRoot = makeTempRepo("harness-rfc0009-wt-")
    const gitWorktreeDir = join(canonicalRoot, ".git", "worktrees", "wt-1")
    mkdirSync(gitWorktreeDir, { recursive: true })
    writeFileSync(join(gitWorktreeDir, "commondir"), "../..\n", "utf8")
    writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${gitWorktreeDir}\n`, "utf8")

    // Worktree has modified cluster.yaml, canonical has original cluster.yaml
    writeFileSync(
      join(worktreeRoot, "libs", "harness", "graph", "cluster.yaml"),
      "name: worktree-changed\n",
      "utf8",
    )
    expect(resolveOmnigraphConfigDir(worktreeRoot, canonicalRoot, false)).toBe(
      join(canonicalRoot, "libs", "harness", "graph"),
    )

    // Seed canonical cluster with mismatched epoch so drift evaluates to RequiresCleanRebuild
    const clusterDir = resolveOmnigraphClusterDir(canonicalRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), "stale-epoch\n", "utf8")
    const sentinelPath = join(clusterDir, "sentinel.txt")
    writeFileSync(sentinelPath, "preserve-me", "utf8")

    const stderrChunks: Array<string> = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk))
      return true
    })
    const prevAllow = process.env.HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD
    Reflect.deleteProperty(process.env, "HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD")
    try {
      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(worktreeRoot))
      expect(ready).toBe(false)
      expect(readFileSync(sentinelPath, "utf8")).toBe("preserve-me")
      expect(stderrChunks.join("")).toContain("refusing destructive RequiresCleanRebuild")
    } finally {
      stderrSpy.mockRestore()
      if (prevAllow !== undefined) process.env.HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD = prevAllow
    }
  })

  it("F-1.1b: linked worktree fails closed across CLUSTER_SCHEMA_EPOCH mismatch even when canonical daemon responds /readyz", async () => {
    const canonicalRoot = makeTempRepo("harness-rfc0009-canon-epoch-")
    const worktreeRoot = makeTempRepo("harness-rfc0009-wt-epoch-")
    const gitWorktreeDir = join(canonicalRoot, ".git", "worktrees", "wt-epoch")
    mkdirSync(gitWorktreeDir, { recursive: true })
    writeFileSync(join(gitWorktreeDir, "commondir"), "../..\n", "utf8")
    writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${gitWorktreeDir}\n`, "utf8")

    const clusterDir = resolveOmnigraphClusterDir(canonicalRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), "stale-epoch\n", "utf8")

    let readyzRequests = 0
    const mockReadyServer = createServer((_req, res) => {
      readyzRequests += 1
      res.writeHead(200, { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" })
      res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
    })
    await new Promise<void>((resolveListen) => {
      mockReadyServer.listen(0, "127.0.0.1", () => resolveListen())
    })

    const addr = mockReadyServer.address() as AddressInfo
    const resolvedCanonical = resolveCanonicalRepoRoot(canonicalRoot, nodeSyncHostIo)
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        canonicalRepoRoot: resolvedCanonical,
        updatedAt: new Date().toISOString(),
        embeddingsMode: "mock",
      }),
      "utf8",
    )

    const stderrChunks: Array<string> = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk))
      return true
    })
    const prevAllow = process.env.HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD
    const prevUrl = process.env.OMNIGRAPH_URL
    Reflect.deleteProperty(process.env, "HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD")
    Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
    try {
      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(worktreeRoot))
      expect(ready).toBe(false)
      expect(readyzRequests).toBe(0)
      expect(stderrChunks.join("")).toContain("CLUSTER_SCHEMA_EPOCH mismatch")
    } finally {
      stderrSpy.mockRestore()
      mockReadyServer.closeAllConnections()
      mockReadyServer.close()
      if (prevAllow !== undefined) process.env.HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD = prevAllow
      if (prevUrl !== undefined) process.env.OMNIGRAPH_URL = prevUrl
    }
  })
})
