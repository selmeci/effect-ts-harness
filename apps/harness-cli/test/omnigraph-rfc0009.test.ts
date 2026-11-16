import { execFileSync } from "node:child_process"
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
import { Effect } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readTelemetryEvents, writeVerifyStamp } from "@harness/gates"
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
  isBranchNotFoundError,
  runPreMergeOmnigraphBranchVerify,
  syncOmnigraphOnDone,
  syncVerifyImplToOmnigraph,
} from "../src/commands/done-omnigraph-helpers.js"
import { handleGc } from "../src/commands/gc-and-ontology.command.js"
import {
  acquireOmnigraphClusterLock,
  acquireOmnigraphClusterLockEffect,
  CLUSTER_SCHEMA_EPOCH,
  ensureOmnigraphEndpointTokens,
  evaluateClusterConfigDrift,
  killOmnigraphServerPidIfAlive,
  releaseOmnigraphClusterLock,
  runOfflineOmnigraphLintGate,
  runOmnigraphOptimizeAndCleanup,
  writeClusterDriftReceipts,
} from "../src/commands/omnigraph-auth-and-drift.js"
import {
  ensureLocalOmnigraphReady,
  stopStaleOmnigraphClusterBeforeDelete,
} from "../src/commands/omnigraph-lifecycle.js"
import { clusterYamlDeclaresPolicies } from "../src/commands/omnigraph-safety-helpers.js"

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

  it("runOfflineOmnigraphLintGate fails closed when binary or schema/query files are missing, succeeds on clean JSON, and fails on lint diagnostics", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-lint-")
    const missingBinRes = await Effect.runPromise(
      runOfflineOmnigraphLintGate(repoRoot, join(repoRoot, "missing-omnigraph")),
    )
    expect(missingBinRes.ok).toBe(false)
    if (!missingBinRes.ok) {
      expect(missingBinRes.message).toContain("omnigraph binary not found")
    }

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

    const missingQueryRepo = makeTempRepo("harness-rfc0009-lint-noq-")
    rmSync(join(missingQueryRepo, "libs", "harness", "graph", "queries", "harness.gq"))
    const missingQueryRes = await Effect.runPromise(
      runOfflineOmnigraphLintGate(missingQueryRepo, okBin),
    )
    expect(missingQueryRes.ok).toBe(false)
    if (!missingQueryRes.ok) {
      expect(missingQueryRes.message).toContain("Missing Omnigraph schema")
    }

    const missingSchemaRepo = makeTempRepo("harness-rfc0009-lint-nos-")
    rmSync(join(missingSchemaRepo, "libs", "harness", "graph", "schema.pg"))
    const missingSchemaRes = await Effect.runPromise(
      runOfflineOmnigraphLintGate(missingSchemaRepo, okBin),
    )
    expect(missingSchemaRes.ok).toBe(false)
    if (!missingSchemaRes.ok) {
      expect(missingSchemaRes.message).toContain("Missing Omnigraph schema")
    }

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
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
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
          const parsedReq = JSON.parse(body || "{}") as {
            readonly source?: string
            readonly target?: string
          }
          if (!isDryRun) {
            mergeCalled = true
          }
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "already_up_to_date",
              source: parsedReq.source ?? taskBranches.implBranch,
              target: parsedReq.target ?? taskBranches.mainBranch,
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
          branches: [taskBranches.mainBranch, taskBranches.planBranch, taskBranches.implBranch],
          serverRef: "srv-1",
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
      }),
      "utf8",
    )
    writeVerifyStamp(repoRoot, nodeSyncHostIo, taskBranches.implBranch)

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

  it("runOmnigraphOptimizeAndCleanup invokes optimize and cleanup --keep 5 --confirm with --graph harness and without --as", () => {
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
    expect(lines[0]).toContain(`optimize --target file://${clusterDir} --graph harness`)
    expect(lines[0]).not.toContain("--as")
    expect(lines[1]).toContain(`cleanup --target file://${clusterDir} --graph harness --keep 5 --confirm`)
    expect(lines[1]).not.toContain("--as")
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
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
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
          res.end(
            JSON.stringify({
              outcome: "merged",
              source: taskBranches.implBranch,
              target: taskBranches.mainBranch,
            }),
          )
        })
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
      }),
      "utf8",
    )
    writeVerifyStamp(repoRoot, nodeSyncHostIo, taskBranches.implBranch)

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

  it("syncOmnigraphOnDone enforces missing-merge-base when plan-graph-snapshot.json exists and falls back to main diff for Route B without plan snapshot", async () => {
    const setupScenario = async (options: {
      readonly writePlanSnapshot: boolean
      readonly stubInMainDiff: boolean
    }) => {
      const repoRoot = makeTempRepo("harness-rfc0009-routeb-")
      const configDir = join(repoRoot, "libs", "harness", "graph")
      const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
      mkdirSync(clusterDir, { recursive: true })
      const initialDrift = await Effect.runPromise(
        evaluateClusterConfigDrift(clusterDir, configDir, false),
      )
      writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)

      const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
      const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)
      let realMergeCalled = false
      const diffTargets: Array<string | null> = []

      const headers = {
        "Content-Type": "application/json",
        "Omnigraph-Http-Api": "0.14",
      } as const
      const server = createServer((req, res) => {
        const rawUrl = req.url ?? ""
        if (rawUrl === "/readyz") {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }))
          return
        }
        if (rawUrl === "/healthz") {
          res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
          res.end()
          return
        }
        if (rawUrl.includes("/branches/diff")) {
          const parsedUrl = new URL(rawUrl, "http://127.0.0.1")
          const target = parsedUrl.searchParams.get("target")
          diffTargets.push(target)
          if (target === taskBranches.planBranch) {
            res.writeHead(404, headers)
            res.end(
              JSON.stringify({ code: "not_found", message: `branch ${taskBranches.planBranch} not found` }),
            )
            return
          }
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "ok",
              serverRef: "srv-1",
              from_commit_id: "c1",
              to_commit_id: "c2",
              changes: options.stubInMainDiff
                ? [
                    {
                      id: "fn-stub-1",
                      kind: "node",
                      op: "insert",
                      type: { id: "t1", name: "EffectFn" },
                      before: null,
                      after: { properties: { isStub: true, spanName: "Demo.routeBStub" } },
                    },
                  ]
                : [],
              netNodeCount: options.stubInMainDiff ? 1 : 0,
              netEdgeCount: 0,
            }),
          )
          return
        }
        if (rawUrl.includes("/branches/merge")) {
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
            if (!isDryRun) {
              realMergeCalled = true
            }
            res.writeHead(200, headers)
            res.end(
              JSON.stringify({
                outcome: "already_up_to_date",
                source: parsedReq.source ?? taskBranches.implBranch,
                target: parsedReq.target ?? taskBranches.mainBranch,
                ...(isDryRun ? { dry_run: true } : {}),
                commit: null,
                serverRef: "srv-1",
              }),
            )
          })
          return
        }
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({ outcome: "ok", branches: [taskBranches.mainBranch, taskBranches.implBranch] }),
        )
      })

      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise)
        server.listen(0, "127.0.0.1", () => resolvePromise())
      })
      const port = (server.address() as AddressInfo).port

      if (options.writePlanSnapshot) {
        mkdirSync(join(repoRoot, ".harness"), { recursive: true })
        writeFileSync(join(repoRoot, ".harness", "plan-graph-snapshot.json"), "{}", "utf8")
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
      writeVerifyStamp(repoRoot, nodeSyncHostIo, taskBranches.implBranch)

      try {
        const res = await Effect.runPromise(
          syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
        )
        return {
          res,
          diffTargets,
          realMergeCalled,
          planBranch: taskBranches.planBranch,
        }
      } finally {
        server.closeAllConnections()
        server.close()
      }
    }

    const withPlan = await setupScenario({ writePlanSnapshot: true, stubInMainDiff: false })
    expect(withPlan.diffTargets).toEqual([withPlan.planBranch])
    expect(withPlan.res?.exitCode).toBe(1)
    expect(withPlan.res?.stderr).toContain("[missing-merge-base]")
    expect(withPlan.realMergeCalled).toBe(false)

    const routeBClean = await setupScenario({ writePlanSnapshot: false, stubInMainDiff: false })
    expect(routeBClean.diffTargets).toEqual([routeBClean.planBranch, "main"])
    expect(routeBClean.res).toBeUndefined()
    expect(routeBClean.realMergeCalled).toBe(true)

    const routeBStub = await setupScenario({ writePlanSnapshot: false, stubInMainDiff: true })
    expect(routeBStub.diffTargets).toEqual([routeBStub.planBranch, "main"])
    expect(routeBStub.res?.exitCode).toBe(1)
    expect(routeBStub.res?.stderr).toContain("[unimplemented-stub-remaining]")
    expect(routeBStub.res?.stderr).toContain("fn-stub-1")
    expect(routeBStub.realMergeCalled).toBe(false)
  })

  it("F-2.2: syncOmnigraphOnDone reloads .harness/graph-snapshot.json via /load mode overwrite before dry-run/merge and blocks on corrupt JSON or stub", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-f22-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const initialDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initialDrift.expectedStamp, configDir)
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)

    const events: Array<string> = []
    const loadModes: Array<string | null> = []
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
      if (url.includes("/load")) {
        let loadBody = ""
        req.on("data", (chunk) => {
          loadBody += String(chunk)
        })
        req.on("end", () => {
          const parsedUrl = new URL(url, "http://127.0.0.1")
          const queryMode = parsedUrl.searchParams.get("mode")
          const bodyMode = loadBody.match(/"mode"\s*:\s*"([^"]+)"/)?.[1] ?? null
          loadModes.push(queryMode ?? bodyMode ?? req.headers["x-omnigraph-load-mode"]?.toString() ?? "overwrite-called")
          events.push("load")
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "loaded",
              commit_id: "cmt-load-1",
              nodes_loaded: 1,
              edges_loaded: 0,
              serverRef: "srv-1",
            }),
          )
        })
        return
      }
      if (url.includes("/branches/diff")) {
        events.push("diff")
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
          const isDryRun = body.includes('"dry_run":true')
          events.push(isDryRun ? "dryRunMerge" : "merge")
          const parsedReq = JSON.parse(body || "{}") as {
            readonly source?: string
            readonly target?: string
          }
          res.writeHead(200, headers)
          res.end(
            JSON.stringify({
              outcome: "already_up_to_date",
              source: parsedReq.source ?? taskBranches.implBranch,
              target: parsedReq.target ?? taskBranches.mainBranch,
              ...(isDryRun ? { dry_run: true } : {}),
              commit: null,
              serverRef: "srv-1",
            }),
          )
        })
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
      }),
      "utf8",
    )

    try {
      const cleanGraph = buildHarnessGraph({
        fns: [
          {
            qualname: "src/demo.ts#cleanFn",
            spanName: "Demo.cleanFn",
            file: "src/demo.ts",
            line: 1,
            packageTag: "domain",
            isStub: false,
          },
        ],
      })
      saveGraphSnapshot(cleanGraph, join(repoRoot, ".harness", "graph-snapshot.json"), nodeSyncHostIo)
      const okRes = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(okRes).toBeUndefined()
      expect(loadModes).toEqual(["overwrite"])
      expect(events.indexOf("load")).toBeLessThan(events.indexOf("dryRunMerge"))
      expect(events.indexOf("dryRunMerge")).toBeLessThan(events.indexOf("merge"))

      const stubGraph = buildHarnessGraph({
        fns: [
          {
            qualname: "src/demo.ts#stubFn",
            spanName: "Demo.stubFn",
            file: "src/demo.ts",
            line: 1,
            packageTag: "domain",
            isStub: true,
          },
        ],
      })
      saveGraphSnapshot(stubGraph, join(repoRoot, ".harness", "graph-snapshot.json"), nodeSyncHostIo)
      const stubRes = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(stubRes?.exitCode).toBe(1)
      expect(stubRes?.stderr).toContain("[unimplemented-stub-remaining]")

      writeFileSync(join(repoRoot, ".harness", "graph-snapshot.json"), "{corrupt", "utf8")
      const corruptRes = await Effect.runPromise(
        syncOmnigraphOnDone(repoRoot, { repoRoot }, false, "block"),
      )
      expect(corruptRes?.exitCode).toBe(1)
      expect(corruptRes?.stderr).toContain("done:omnigraph-snapshot-load")
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("F-6.1: clusterYamlDeclaresPolicies handles comments, flow-style, empty values, and nested rules", () => {
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: # comment\n  - name: p1\n")).toBe(true)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: # comment\n- name: p1\n")).toBe(true)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies:\n  rules:\n    - allow: true\n")).toBe(
      true,
    )
    expect(clusterYamlDeclaresPolicies('{ name: "test", policies: ["p1"] }')).toBe(true)
    expect(clusterYamlDeclaresPolicies('{ name: "test", policies: { allow: true } }')).toBe(true)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: []\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: {}\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: null\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: # comment\nother: 1\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies("# policies:\n#  - name: p1\nname: test\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies('{ name: "test", policies: [] }')).toBe(false)
  })

  it("F-6.2 & S-1.1 & S-1.2: ensureLocalOmnigraphReady spawns policy-gated server with OMNIGRAPH_SERVER_BEARER_TOKENS_JSON and no --unauthenticated", async () => {
    const setupFakeBinRepo = (clusterYaml: string) => {
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

    const prevHome = process.env.HOME
    const prevApiKey = process.env.OMNIGRAPH_EMBEDDING_API_KEY
    const prevMock = process.env.OMNIGRAPH_EMBEDDINGS_MOCK
    const prevUrl = process.env.OMNIGRAPH_URL

    try {
      // Case 1: policy-gated cluster with unset OMNIGRAPH_EMBEDDING_API_KEY
      const policyCase = setupFakeBinRepo("name: test\npolicies:\n  - name: p1\n")
      process.env.HOME = policyCase.fakeHome
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
      expect(typeof serverMeta.pid).toBe("number")
      if (typeof serverMeta.pid === "number") {
        try {
          process.kill(serverMeta.pid, "SIGTERM")
        } catch {
          // ignore
        }
      }

      // Case 2: explicit OMNIGRAPH_EMBEDDING_API_KEY does NOT set OMNIGRAPH_EMBEDDINGS_MOCK="1", and no policies logs --unauthenticated warning
      const unauthCase = setupFakeBinRepo("name: test\n")
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
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
      if (prevApiKey === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDING_API_KEY")
      else process.env.OMNIGRAPH_EMBEDDING_API_KEY = prevApiKey
      if (prevMock === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_EMBEDDINGS_MOCK")
      else process.env.OMNIGRAPH_EMBEDDINGS_MOCK = prevMock
      if (prevUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevUrl
    }
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
      ["policy", "validate", "--target", `file://${tempClusterDir}`],
      { encoding: "utf8" },
    )
    expect(validateOut.length).toBeGreaterThanOrEqual(0)

    const testOut = execFileSync(
      omnigraphBin,
      [
        "policy",
        "test",
        "--target",
        `file://${tempClusterDir}`,
        "--tests",
        join(graphConfigDir, "policy-tests.yaml"),
      ],
      { encoding: "utf8" },
    )
    expect(testOut.length).toBeGreaterThanOrEqual(0)
  })

  it("F-7.4 & S-2.1: tools/omnigraph-mcp-launcher.mjs enforces loopback, canonicalRepoRoot, live PID, and 0o600 auth-tokens checks", () => {
    const launcherPath = resolve(import.meta.dirname, "../../../tools/omnigraph-mcp-launcher.mjs")
    const runLauncherWith = (setup: (repoRoot: string, clusterDir: string, canonicalRoot: string, expectedPort: number) => Record<string, string | undefined>) => {
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
      if (!("OMNIGRAPH_BASE_URL" in extraEnv)) Reflect.deleteProperty(childEnv, "OMNIGRAPH_BASE_URL")
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
        parsed: JSON.parse(exited.stdout.trim()) as { readonly url: string; readonly token: string },
        stderr: exited.stderr,
        expectedPort,
      }
    }

    // Non-loopback server.json.baseUrl is rejected
    const nonLoopbackMeta = runLauncherWith((_r, clusterDir, canonicalRoot) => {
      writeFileSync(
        join(clusterDir, "server.json"),
        JSON.stringify({ pid: process.pid, baseUrl: "https://evil.example.com:9000", canonicalRepoRoot: canonicalRoot }),
        "utf8",
      )
      return {}
    })
    expect(nonLoopbackMeta.parsed.url).toBe(`http://127.0.0.1:${nonLoopbackMeta.expectedPort}`)

    // Mismatched canonicalRepoRoot is rejected
    const wrongRootMeta = runLauncherWith((_r, clusterDir) => {
      writeFileSync(
        join(clusterDir, "server.json"),
        JSON.stringify({ pid: process.pid, baseUrl: "http://127.0.0.1:19999", canonicalRepoRoot: "/tmp/other-repo" }),
        "utf8",
      )
      return {}
    })
    expect(wrongRootMeta.parsed.url).toBe(`http://127.0.0.1:${wrongRootMeta.expectedPort}`)

    // Dead PID is rejected
    const deadPidMeta = runLauncherWith((_r, clusterDir, canonicalRoot) => {
      writeFileSync(
        join(clusterDir, "server.json"),
        JSON.stringify({ pid: 999999, baseUrl: "http://127.0.0.1:19999", canonicalRepoRoot: canonicalRoot }),
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
      res.end(JSON.stringify({ outcome: "ok", branches: [taskBranches.mainBranch, taskBranches.implBranch] }))
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const port = (server.address() as AddressInfo).port
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({ pid: process.pid, port, baseUrl: `http://127.0.0.1:${port}`, canonicalRepoRoot: canonicalRoot }),
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
      expect(res?.stderr).toContain("1 stub node(s)")
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("F-10.1 & F-10.2 & F-14.1: isBranchNotFoundError, HTTP 500/401 diff failure, and Antigravity hook exitCode 0", async () => {
    expect(isBranchNotFoundError({ name: "NotFoundError", message: "missing" })).toBe(true)
    expect(isBranchNotFoundError({ code: "branch_not_found" })).toBe(true)
    expect(isBranchNotFoundError({ status: 404, message: "branch plan/current not found" })).toBe(true)
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
      res.end(JSON.stringify({ outcome: "ok", branches: [taskBranches.mainBranch, taskBranches.implBranch] }))
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const port = (server.address() as AddressInfo).port
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({ pid: process.pid, port, baseUrl: `http://127.0.0.1:${port}`, canonicalRepoRoot: canonicalRoot }),
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

  it("F-13.1 & F-13.2 & F-13.3: startup lock prevents stealing live PID lock, enforces compare-and-delete, and waits on contention", async () => {
    const repoRoot = makeTempRepo("harness-rfc0009-locks-")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    const lockPath = `${clusterDir}.startup.lock`

    // F-13.2: old lock owned by live PID is NOT stolen
    mkdirSync(join(repoRoot, ".harness"), { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, lockToken: "other-owner-token", createdAtMs: 1 }),
      "utf8",
    )
    const oldDate = new Date(Date.now() - 120_000)
    utimesSync(lockPath, oldDate, oldDate)
    expect(acquireOmnigraphClusterLock(clusterDir)).toBeUndefined()

    // F-13.2: releaseOmnigraphClusterLock does not unlink lock owned by another token
    releaseOmnigraphClusterLock({ lockPath, lockToken: "wrong-token" })
    expect(nodeSyncHostIo.existsSync(lockPath)).toBe(true)

    // F-13.3: acquireOmnigraphClusterLockEffect waits and acquires when lock is released
    setTimeout(() => {
      rmSync(lockPath, { force: true })
    }, 150)
    const acquired = await Effect.runPromise(acquireOmnigraphClusterLockEffect(clusterDir, 2_000))
    expect(acquired).toBeDefined()
    if (acquired !== undefined) {
      releaseOmnigraphClusterLock(acquired)
      expect(nodeSyncHostIo.existsSync(lockPath)).toBe(false)
    }

    // F-13.3: bounded timeout returns undefined when live owner holds lock
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, lockToken: "held-token", createdAtMs: Date.now() }),
      "utf8",
    )
    const timedOut = await Effect.runPromise(acquireOmnigraphClusterLockEffect(clusterDir, 150))
    expect(timedOut).toBeUndefined()
    rmSync(lockPath, { force: true })

    // F-13.1: ensureLocalOmnigraphReady waits on startup lock before evaluating readyz/drift
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const initDrift = await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, false))
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
      JSON.stringify({ pid: process.pid, port: readyPort, baseUrl: `http://127.0.0.1:${readyPort}`, canonicalRepoRoot: canonicalRoot }),
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

  it("F-16.2 & F-16.4 & F-17.1a & S-3.1: handleGc --strict compact, syncVerifyImplToOmnigraph putBlob, LoadErr, lifecycle helpers, and isolated telemetry", async () => {
    // F-16.2: gc --strict invokes optimize/cleanup on non-isolated cluster dir
    const gcRepo = makeTempRepo("harness-rfc0009-gc-")
    const gcClusterDir = resolveOmnigraphClusterDir(gcRepo, nodeSyncHostIo)
    mkdirSync(gcClusterDir, { recursive: true })
    const prevHome = process.env.HOME
    const fakeHome = join(gcRepo, "fake-home")
    mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true })
    const gcOptLog = join(gcRepo, "gc-opt.log")
    writeFileSync(join(fakeHome, ".local", "bin", "omnigraph"), `#!/bin/sh\necho "$*" >> "${gcOptLog}"\n`, "utf8")
    chmodSync(join(fakeHome, ".local", "bin", "omnigraph"), 0o755)
    process.env.HOME = fakeHome
    try {
      await Effect.runPromise(handleGc(["gc", "--strict"], { repoRoot: gcRepo }))
      const optLog = readFileSync(gcOptLog, "utf8")
      expect(optLog).toContain("optimize")
      expect(optLog).toContain("cleanup")
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
    }

    // F-16.4 & F-17.1a: syncVerifyImplToOmnigraph sends putBlob when spans.jsonl + VitestCase exist
    const verifyRepo = makeTempRepo("harness-rfc0009-putblob-")
    const verifyClusterDir = resolveOmnigraphClusterDir(verifyRepo, nodeSyncHostIo)
    mkdirSync(verifyClusterDir, { recursive: true })
    const vDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(verifyClusterDir, join(verifyRepo, "libs", "harness", "graph"), false),
    )
    writeClusterDriftReceipts(verifyClusterDir, vDrift.expectedStamp, join(verifyRepo, "libs", "harness", "graph"))
    const canonicalRoot = resolveCanonicalRepoRoot(verifyRepo, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(verifyRepo, nodeSyncHostIo)
    const putBlobRequests: Array<string> = []
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
      if (url.includes("/load")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ outcome: "loaded", commit_id: "c1", nodes_loaded: 1, edges_loaded: 0 }))
        return
      }
      if (url.includes("/branches/diff")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ outcome: "ok", from_commit_id: "c0", to_commit_id: "c1", changes: [], netNodeCount: 0, netEdgeCount: 0 }))
        return
      }
      if (url.includes("/branches/merge")) {
        let body = ""
        req.on("data", (chunk) => { body += String(chunk) })
        req.on("end", () => {
          res.writeHead(200, headers)
          res.end(JSON.stringify({ outcome: "already_up_to_date", source: taskBranches.implBranch, target: taskBranches.mainBranch, dry_run: true, commit: null }))
        })
        return
      }
      res.writeHead(200, headers)
      res.end(JSON.stringify({ outcome: "ok", branches: [taskBranches.mainBranch, taskBranches.implBranch] }))
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(0, "127.0.0.1", () => resolvePromise())
    })
    const port = (server.address() as AddressInfo).port
    writeFileSync(
      join(verifyClusterDir, "server.json"),
      JSON.stringify({ pid: process.pid, port, baseUrl: `http://127.0.0.1:${port}`, canonicalRepoRoot: canonicalRoot }),
      "utf8",
    )
    const okBin = join(verifyRepo, "omnigraph-ok.sh")
    writeFileSync(okBin, '#!/bin/sh\necho \'{"status":"ok","errors":0,"warnings":0,"queries_processed":1,"findings":[]}\'\n', "utf8")
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
    } finally {
      server.closeAllConnections()
      server.close()
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
    }

    // F-17.1a: killOmnigraphServerPidIfAlive refuses unsafe PID (e.g. current vitest PID) & stopStaleOmnigraphClusterBeforeDelete
    expect(await Effect.runPromise(killOmnigraphServerPidIfAlive(process.pid, gcClusterDir, "test"))).toBe(false)
    expect(stopStaleOmnigraphClusterBeforeDelete(gcClusterDir, undefined)).toBe(true)

    // S-3.1: isolated workspace telemetry includes skipped-isolated-workspace
    const isoDir = mkdtempSync(join(tmpdir(), "harness-rfc0009-iso-"))
    tempDirs.push(isoDir)
    const isoRes = await Effect.runPromise(
      syncOmnigraphOnDone(isoDir, { repoRoot: isoDir }, false, "block"),
    )
    expect(isoRes).toBeUndefined()
    const telemetryLines = readTelemetryEvents(isoDir, nodeSyncHostIo)
    expect(telemetryLines[0]?.detail).toBe("skipped-isolated-workspace")
    expect(telemetryLines[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })
})
