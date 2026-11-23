import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import { writeVerifyStamp } from "@harness/gates"
import {
  buildHarnessGraph,
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
  saveGraphSnapshot,
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
import { clusterYamlDeclaresPolicies } from "../src/commands/omnigraph-safety-helpers.js"
import {
  cleanupRfc0009TempDirs,
  createRfc0009TempRepo,
} from "./helpers/omnigraph-rfc0009-fixture.js"

describe("RFC-0009 Omnigraph v0.14.0 lint, drift, merge & launcher", () => {
  const tempDirs: Array<string> = []
  const makeTempRepo = (prefix: string) => createRfc0009TempRepo(tempDirs, prefix)
  afterEach(() => {
    vi.restoreAllMocks()
    cleanupRfc0009TempDirs(tempDirs)
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
              ...(isDryRun ? { dry_run: true } : { branch_deleted: true }),
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
        updatedAt: null,
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
    expect(lines[1]).toContain(
      `cleanup --target file://${clusterDir} --graph harness --keep 5 --confirm`,
    )
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
        updatedAt: null,
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
              JSON.stringify({
                code: "not_found",
                message: `branch ${taskBranches.planBranch} not found`,
              }),
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
                ...(isDryRun ? { dry_run: true } : { branch_deleted: true }),
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
            branches: [taskBranches.mainBranch, taskBranches.implBranch],
          }),
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
          updatedAt: null,
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
          loadModes.push(
            queryMode ??
              bodyMode ??
              req.headers["x-omnigraph-load-mode"]?.toString() ??
              "overwrite-called",
          )
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
              ...(isDryRun ? { dry_run: true } : { branch_deleted: true }),
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
        updatedAt: null,
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
      saveGraphSnapshot(
        cleanGraph,
        join(repoRoot, ".harness", "graph-snapshot.json"),
        nodeSyncHostIo,
      )
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
      saveGraphSnapshot(
        stubGraph,
        join(repoRoot, ".harness", "graph-snapshot.json"),
        nodeSyncHostIo,
      )
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
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: # comment\n  - name: p1\n")).toBe(
      true,
    )
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: # comment\n- name: p1\n")).toBe(true)
    expect(
      clusterYamlDeclaresPolicies("name: test\npolicies:\n  rules:\n    - allow: true\n"),
    ).toBe(true)
    expect(clusterYamlDeclaresPolicies('{ name: "test", policies: ["p1"] }')).toBe(true)
    expect(clusterYamlDeclaresPolicies('{ name: "test", policies: { allow: true } }')).toBe(true)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: []\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: {}\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: null\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies("name: test\npolicies: # comment\nother: 1\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies("# policies:\n#  - name: p1\nname: test\n")).toBe(false)
    expect(clusterYamlDeclaresPolicies('{ name: "test", policies: [] }')).toBe(false)
  })
})
