import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import { writeVerifyStamp } from "@harness/gates"
import {
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { syncOmnigraphOnDone } from "../src/commands/done-omnigraph-helpers.js"
import {
  CLUSTER_SCHEMA_EPOCH,
  ensureOmnigraphEndpointTokens,
  evaluateClusterConfigDrift,
  runOfflineOmnigraphLintGate,
  runOmnigraphOptimizeAndCleanup,
  writeClusterDriftReceipts,
} from "../src/commands/omnigraph-auth-and-drift.js"

const tempDirs: Array<string> = []

const makeTempRepo = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  mkdirSync(join(dir, "libs", "harness", "graph", "queries"), { recursive: true })
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n", "utf8")
  writeFileSync(join(dir, "libs", "harness", "graph", "schema.pg"), "node EffectFn {}\n", "utf8")
  writeFileSync(
    join(dir, "libs", "harness", "graph", "queries", "harness.gq"),
    "query q() { match (n:EffectFn) return n }\n",
    "utf8",
  )
  return dir
}

describe("RFC-0009 Omnigraph v0.14.0 CLI integration", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it("runOfflineOmnigraphLintGate succeeds on clean JSON and fails on lint diagnostics", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-lint-")
    const missingRes = await Effect.runPromise(
      runOfflineOmnigraphLintGate(repoRoot, join(repoRoot, "missing-omnigraph")),
    )
    expect(missingRes).toEqual({ ok: true })

    const okBin = join(repoRoot, "omnigraph-ok.sh")
    writeFileSync(
      okBin,
      `#!/bin/sh
cat <<'EOF'
{"status":"ok","errors":0,"warnings":0,"queries_processed":14,"findings":[]}
EOF
`,
      "utf8",
    )
    chmodSync(okBin, 0o755)
    const okRes = await Effect.runPromise(runOfflineOmnigraphLintGate(repoRoot, okBin))
    expect(okRes).toEqual({ ok: true })

    const failBin = join(repoRoot, "omnigraph-fail.sh")
    writeFileSync(
      failBin,
      `#!/bin/sh
cat <<'EOF'
{"status":"error","errors":1,"warnings":0,"queries_processed":1,"findings":[{"code":"Q001","message":"Unknown node type","target":"bad_query"}]}
EOF
exit 1
`,
      "utf8",
    )
    chmodSync(failBin, 0o755)
    const failRes = await Effect.runPromise(runOfflineOmnigraphLintGate(repoRoot, failBin))
    expect(failRes.ok).toBe(false)
    if (!failRes.ok) {
      expect(failRes.message).toContain("Unknown node type")
    }
  })

  it("evaluateClusterConfigDrift classifies epoch mismatch, query/schema change, and unchanged state", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-drift-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    mkdirSync(clusterDir, { recursive: true })

    writeFileSync(join(clusterDir, ".config-stamp"), "legacy-stamp", "utf8")
    const legacyDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    expect(legacyDrift.action._tag).toBe("RequiresCleanRebuild")

    writeClusterDriftReceipts(clusterDir, legacyDrift.expectedStamp, configDir)
    expect(readFileSync(join(clusterDir, ".cluster-schema-epoch"), "utf8")).toBe(
      CLUSTER_SCHEMA_EPOCH,
    )

    const unchangedDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(unchangedDrift.action._tag).toBe("NoOp")

    writeFileSync(
      join(configDir, "queries", "harness.gq"),
      "query q2() { match (n:EffectFn) return n }\n",
      "utf8",
    )
    const queryDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(queryDrift.action._tag).toBe("LiveClusterApply")
  })

  it("ensureOmnigraphEndpointTokens writes 0o600 auth-tokens.json and fails closed on chmodSync error", () => {
    const repoRoot = makeTempRepo("harness-rfc0009-tokens-")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    const tokens = match(ensureOmnigraphEndpointTokens(clusterDir))
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect.fail(`Expected Success, got Failure: ${failure.message}`),
      )
      .exhaustive()
    expect(tokens.schemaVersion).toBe(1)
    expect(tokens.cliToken.length).toBe(64)
    expect(tokens.mcpToken.length).toBe(64)

    const tokensPath = join(clusterDir, "auth-tokens.json")
    expect(statSync(tokensPath).mode & 0o777).toBe(0o600)

    const repoRoot2 = makeTempRepo("harness-rfc0009-tokens-fail-")
    const clusterDir2 = join(repoRoot2, ".harness", "omnigraph-cluster")
    vi.spyOn(nodeSyncHostIo, "chmodSync").mockImplementation((target) => {
      if (target.endsWith(".tmp") || target.includes("auth-tokens.json.tmp")) {
        throw new Error("EPERM: chmod failed")
      }
    })
    match(ensureOmnigraphEndpointTokens(clusterDir2))
      .with({ _tag: "Success" }, () => {
        expect.fail("Expected Failure when chmodSync fails")
      })
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure.message).toContain("EPERM: chmod failed")
      })
      .exhaustive()
  })

  it("syncOmnigraphOnDone fails closed on pre-merge decideOmnigraphBranchVerify stub violation without merging", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-done-verify-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const initialDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)

    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const port = deriveRepoOmnigraphPort(canonicalRoot, nodeSyncHostIo)
    let mergeCalled = false

    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/branches/merge")) {
        let body = ""
        req.on("data", (chunk) => {
          body += String(chunk)
        })
        req.on("end", () => {
          const isDryRun = body.includes('"dry_run":true')
          if (!isDryRun) {
            mergeCalled = true
          }
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "already_up_to_date",
              source: "impl/current",
              target: "main",
              ...(isDryRun ? { dry_run: true } : {}),
              commit: null,
              serverRef: "srv-1",
            }),
          )
        })
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
                id: "fn-1",
                kind: "node",
                op: "insert",
                type: { id: "t1", name: "EffectFn" },
                before: null,
                after: { properties: { isStub: true, spanName: "Demo.stub" } },
              },
            ],
            netNodeCount: 1,
            netEdgeCount: 0,
          }),
        )
        return
      }
      res.writeHead(200, headers)
      res.end(
        JSON.stringify({
          outcome: "ok",
          branches: ["main", "plan/current", "impl/current"],
          serverRef: "srv-1",
        }),
      )
    })

    const bound = await new Promise<boolean>((resolvePromise) => {
      server.once("error", () => resolvePromise(false))
      server.listen(port, "127.0.0.1", () => resolvePromise(true))
    })
    if (!bound) {
      return
    }

    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: canonicalRoot,
      }),
      "utf8",
    )
    writeVerifyStamp(repoRoot, nodeSyncHostIo, "impl/current")

    try {
      const res = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(res).toBeDefined()
      expect(res?.exitCode).toBe(1)
      expect(res?.stderr).toContain("done:omnigraph-branch-verify")
      expect(mergeCalled).toBe(false)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("runOfflineOmnigraphLintGate rejects invalid JSON and allows warning-only output", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-lint-warn-")
    const badJsonBin = join(repoRoot, "omnigraph-bad-json.sh")
    writeFileSync(badJsonBin, "#!/bin/sh\necho 'not-json'\n", "utf8")
    chmodSync(badJsonBin, 0o755)
    const badRes = await Effect.runPromise(runOfflineOmnigraphLintGate(repoRoot, badJsonBin))
    expect(badRes.ok).toBe(false)
    if (!badRes.ok) {
      expect(badRes.message).toContain("invalid JSON")
    }

    const warnBin = join(repoRoot, "omnigraph-warn.sh")
    writeFileSync(
      warnBin,
      `#!/bin/sh
cat <<'EOF'
{"status":"ok","errors":0,"warnings":1,"queries_processed":14,"findings":[{"code":"W001","message":"Minor hint","severity":"warning"}]}
EOF
`,
      "utf8",
    )
    chmodSync(warnBin, 0o755)
    const warnRes = await Effect.runPromise(runOfflineOmnigraphLintGate(repoRoot, warnBin))
    expect(warnRes).toEqual({ ok: true })
  })

  it("evaluateClusterConfigDrift detects @key(...) edits in schema.pg as RequiresCleanRebuild", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-edgekey-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    writeFileSync(
      join(configDir, "schema.pg"),
      "node EffectFn {}\nedge PlaysRole(@src: EffectFn, @dst: EffectFn, role: String) @key(@src, @dst, role)\n",
      "utf8",
    )
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    const initialDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)

    writeFileSync(
      join(configDir, "schema.pg"),
      "node EffectFn {}\nedge PlaysRole(@src: EffectFn, @dst: EffectFn, role: String) @key(@src, @dst)\n",
      "utf8",
    )
    const keyDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(keyDrift.action._tag).toBe("RequiresCleanRebuild")
  })

  it("runOmnigraphOptimizeAndCleanup invokes optimize and cleanup --keep 5 with --graph harness --as harness-cli", () => {
    const repoRoot = makeTempRepo("harness-rfc0009-opt-")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    mkdirSync(clusterDir, { recursive: true })
    const argsLog = join(repoRoot, "omnigraph-args.log")
    const fakeBin = join(repoRoot, "omnigraph-opt.sh")
    writeFileSync(fakeBin, `#!/bin/sh\necho "$*" >> "${argsLog}"\n`, "utf8")
    chmodSync(fakeBin, 0o755)

    runOmnigraphOptimizeAndCleanup(clusterDir, fakeBin)
    const lines = readFileSync(argsLog, "utf8").trim().split("\n")
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain(`optimize --target file://${clusterDir} --graph harness --as harness-cli`)
    expect(lines[1]).toContain(`cleanup --target file://${clusterDir} --graph harness --as harness-cli --keep 5`)
  })

  it("syncOmnigraphOnDone fails closed on 409 dry-run merge conflict without calling merge", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-409-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const initialDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)

    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const port = deriveRepoOmnigraphPort(canonicalRoot, nodeSyncHostIo)
    let realMergeCalled = false
    const headers = {
      "Content-Type": "application/json",
      "Omnigraph-Http-Api": "0.14",
    } as const

    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
        return
      }
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
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
          if (body.includes('"dry_run":true')) {
            res.writeHead(409, headers)
            res.end(
              JSON.stringify({
                code: "merge_conflict",
                message: "divergent insert",
                merge_conflicts: [
                  {
                    kind: "divergent_insert",
                    entity_kind: "node",
                    type_name: "EffectFn",
                    entity_id: "fn-1",
                    message: "concurrent insert on EffectFn fn-1",
                  },
                ],
              }),
            )
            return
          }
          realMergeCalled = true
          res.writeHead(200, headers)
          res.end(JSON.stringify({ outcome: "merged", source: "impl/current", target: "main" }))
        })
        return
      }
      res.writeHead(200, headers)
      res.end(JSON.stringify({ outcome: "ok", branches: ["main", "plan/current", "impl/current"] }))
    })

    const bound = await new Promise<boolean>((resolvePromise) => {
      server.once("error", () => resolvePromise(false))
      server.listen(port, "127.0.0.1", () => resolvePromise(true))
    })
    if (!bound) return

    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: canonicalRoot,
      }),
      "utf8",
    )
    writeVerifyStamp(repoRoot, nodeSyncHostIo, "impl/current")

    try {
      const res = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(res?.exitCode).toBe(1)
      expect(res?.stderr).toContain("done:omnigraph-branch-verify")
      expect(realMergeCalled).toBe(false)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("tools/omnigraph-mcp-launcher.mjs resolves validated loopback URL + 0o600 mcpToken and ignores :8080 default", () => {
    const repoRoot = makeTempRepo("harness-rfc0009-launcher-")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    const tokens = match(ensureOmnigraphEndpointTokens(clusterDir))
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect.fail(`Expected Success, got Failure: ${failure.message}`),
      )
      .exhaustive()
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

    const launcherPath = resolve(import.meta.dirname, "../../../tools/omnigraph-mcp-launcher.mjs")
    const out = execFileSync(process.execPath, [launcherPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        OMNIGRAPH_URL: "http://127.0.0.1:8080",
        OMNIGRAPH_BASE_URL: "http://127.0.0.1:8080",
      },
      encoding: "utf8",
    })
    const parsed = JSON.parse(out.trim()) as { readonly url: string; readonly token: string }
    expect(parsed.url).toBe(`http://127.0.0.1:${expectedPort}`)
    expect(parsed.token).toBe(tokens.mcpToken)
  })
})
