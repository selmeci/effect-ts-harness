import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as net from "node:net"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect, Layer, Option } from "effect"
import { Snowflake } from "effect/cluster"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  BackupDirPath,
  BackupFileHash,
  DaemonSocketPath,
  GitCommonDirPath,
  LeaseFilePath,
  LeaseHolderId,
  LeaseHolderPid,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WorkflowDaemonCapability,
  WorkflowStoreUnavailableError,
  WorkspaceFsError,
} from "@harness/contract"
import {
  buildHarnessGraph,
  OmnigraphClient,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
  saveGraphSnapshot,
} from "@harness/graph"
import {
  acquireWriterLease,
  clearOmnigraphReplies,
  exportWorkflowGraphBackup,
  handshakeWorkflowDaemon,
  makeWorkflowGraphBackupLayer,
  nodeSyncHostIo,
  quarantineOrphanEntityMessages,
  queryWorkflowDaemonCommand,
  refreshWriterLease,
  repairDanglingProcessedRequests,
  restoreWorkflowGraphBackup,
  runOfflineWorkflowMaintenance,
  UnixSocketDaemonLive,
  validateWorktreeRepoRoot,
} from "@harness/infra"
import { type IndexedEffectFn, runWithTestTracer } from "@harness/ingest"
import { tryQueryWarmDaemonSocket } from "../src/commands/daemon-and-omnigraph.service.js"
import { syncOmnigraphOnDone } from "../src/commands/done-omnigraph-helpers.js"
import {
  computeOmnigraphConfigStamp,
  evaluateClusterConfigDrift,
  runOfflineOmnigraphLintGate,
  writeClusterDriftReceipts,
} from "../src/commands/omnigraph-auth-and-drift.js"
import {
  afterRebuildWorkflowBackup,
  beforeRebuildWorkflowBackup,
} from "../src/commands/omnigraph-workflow-backup.js"

const tempDirs: Array<string> = []

const makeTempWorkflowRepo = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  mkdirSync(join(dir, "libs", "harness", "graph", "queries"), { recursive: true })
  mkdirSync(join(dir, "libs", "harness", "graph", "workflow-queries"), { recursive: true })
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'libs/*'\n", "utf8")
  writeFileSync(join(dir, "libs", "harness", "graph", "cluster.yaml"), "name: test\n", "utf8")
  writeFileSync(join(dir, "libs", "harness", "graph", "schema.pg"), "node EffectFn {}\n", "utf8")
  writeFileSync(
    join(dir, "libs", "harness", "graph", "queries", "harness.gq"),
    "query q() { match { $n: EffectFn } return { $n.id as id } }\n",
    "utf8",
  )
  writeFileSync(join(dir, "libs", "harness", "graph", "graph.policy.yaml"), "version: 1\n", "utf8")
  writeFileSync(
    join(dir, "libs", "harness", "graph", "cluster.policy.yaml"),
    "version: 1\n",
    "utf8",
  )
  writeFileSync(
    join(dir, "libs", "harness", "graph", "workflows.schema.pg"),
    "node WfMessage {\n  messageKey: String @key\n  seqKey: String @index\n}\n",
    "utf8",
  )
  writeFileSync(
    join(dir, "libs", "harness", "graph", "workflow-queries", "workflows.gq"),
    "query wf_count_all() { match { $m: WfMessage } return { count($m) as totalMessages } }\n",
    "utf8",
  )
  writeFileSync(
    join(dir, "libs", "harness", "graph", "workflows.policy.yaml"),
    "version: 1\nprotected_branches: [main]\n",
    "utf8",
  )
  return dir
}

describe("RFC-0013 WF-2 CLI Drift, Policy, Backup, and Spans", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it("tracks workflow schema, queries, and policy in config stamp & drift evaluation", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf2-drift-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = join(repoRoot, ".harness", "omnigraph-cluster")
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })

    const stampInitial = computeOmnigraphConfigStamp(configDir)
    const initDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, false),
    )
    writeClusterDriftReceipts(clusterDir, initDrift.expectedStamp, configDir)
    expect(
      (await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, true))).action
        ._tag,
    ).toBe("NoOp")

    // 1. Additive edit to workflows.schema.pg -> LiveClusterApply
    writeFileSync(
      join(configDir, "workflows.schema.pg"),
      "node WfMessage {\n  messageKey: String @key\n  seqKey: String @index\n  extraField: String?\n}\n",
      "utf8",
    )
    expect(computeOmnigraphConfigStamp(configDir)).not.toBe(stampInitial)
    const additiveSchemaDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(additiveSchemaDrift.action._tag).toBe("LiveClusterApply")
    writeClusterDriftReceipts(clusterDir, additiveSchemaDrift.expectedStamp, configDir)

    // 2. Edit to workflow-queries/workflows.gq -> LiveClusterApply
    writeFileSync(
      join(configDir, "workflow-queries", "workflows.gq"),
      "query wf_count_all() { match { $m: WfMessage } return { count($m) as totalMessages } }\nquery wf_extra() { match { $m: WfMessage } return { $m.messageKey as k } }\n",
      "utf8",
    )
    const queryDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(queryDrift.action._tag).toBe("LiveClusterApply")
    writeClusterDriftReceipts(clusterDir, queryDrift.expectedStamp, configDir)

    // 3. Edge @key(...) edit in workflows.schema.pg -> RequiresCleanRebuild
    writeFileSync(
      join(configDir, "workflows.schema.pg"),
      "node WfMessage {\n  messageKey: String @key\n  seqKey: String @index\n}\nedge WfEdge: WfMessage -> WfMessage { @key(@src, @dst, role) role: String }\n",
      "utf8",
    )
    const edgeKeyDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(edgeKeyDrift.action._tag).toBe("RequiresCleanRebuild")
    writeClusterDriftReceipts(clusterDir, edgeKeyDrift.expectedStamp, configDir)

    // 4. Edit to workflows.policy.yaml -> RequiresCleanRebuild
    writeFileSync(
      join(configDir, "workflows.policy.yaml"),
      "version: 1\nprotected_branches: [main, prod]\n",
      "utf8",
    )
    const policyDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(clusterDir, configDir, true),
    )
    expect(policyDrift.action._tag).toBe("RequiresCleanRebuild")
  })

  it("consumes real makeWorkflowGraphBackupLayer in beforeRebuildWorkflowBackup & afterRebuildWorkflowBackup with typed error checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-wf2-port-"))
    tempDirs.push(dir)
    const backupDir = BackupDirPath.make(join(dir, "backups"))
    const rowJson = JSON.stringify({
      type: "WfMessage",
      id: "m-direct-1",
      data: { messageKey: "m-direct-1", seqKey: "00000000000000000001" },
    })
    const directServer = createServer((req, res) => {
      const url = req.url ?? ""
      const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/export")) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Omnigraph-Http-Api": "0.14" })
        res.end(`${rowJson}\n`)
        return
      }
      if (url.includes("/load")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "loaded",
            commit_id: "c-direct",
            totalEntities: 1,
            nodes_loaded: 1,
            edges_loaded: 0,
          }),
        )
        return
      }
      if (url.includes("/queries/wf_count_all")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [{ totalMessages: 1 }], graphCommitId: "c-direct" }))
        return
      }
      if (url.includes("/queries/wf_count_replies")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [{ totalReplies: 0 }], graphCommitId: "c-direct" }))
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resPromise, rejPromise) => {
      directServer.once("error", rejPromise)
      directServer.listen(0, "127.0.0.1", () => resPromise())
    })
    const directPort = (directServer.address() as AddressInfo).port
    const directClient = new OmnigraphClient({
      baseUrl: `http://127.0.0.1:${directPort}`,
      graphId: "harness-workflows",
    })
    const realLayer = makeWorkflowGraphBackupLayer({
      repoRoot: AbsoluteRepoRoot.make(dir),
      client: directClient,
      nowMs: () => 5000,
    })

    const deadServer = createServer()
    await new Promise<void>((resPromise) => deadServer.listen(0, "127.0.0.1", () => resPromise()))
    const deadPort = (deadServer.address() as AddressInfo).port
    await new Promise<void>((resPromise) => deadServer.close(() => resPromise()))
    const deadLayer = makeWorkflowGraphBackupLayer({
      repoRoot: AbsoluteRepoRoot.make(dir),
      client: new OmnigraphClient({
        baseUrl: `http://127.0.0.1:${deadPort}`,
        graphId: "harness-workflows",
      }),
    })

    try {
      const expRes = await Effect.runPromise(
        beforeRebuildWorkflowBackup(backupDir).pipe(Effect.provide(realLayer)),
      )
      expect(expRes.entityCount).toBe(1)

      const restRes = await Effect.runPromise(
        afterRebuildWorkflowBackup({
          backupFile: expRes.backupFile,
          mode: "merge",
          expectedSha256: expRes.sha256,
        }).pipe(Effect.provide(realLayer)),
      )
      expect(restRes.mode).toBe("merge")
      expect(restRes.restoredEntityCount).toBe(1)
      expect(restRes.sha256).toBe(expRes.sha256)

      // Tampered expectedSha256 fails with WorkspaceFsError before calling og.load
      const badShaExit = await Effect.runPromiseExit(
        afterRebuildWorkflowBackup({
          backupFile: expRes.backupFile,
          mode: "merge",
          expectedSha256: BackupFileHash.make("f".repeat(64)),
        }).pipe(Effect.provide(realLayer)),
      )
      match(badShaExit)
        .with({ _tag: "Success" }, () => expect.fail("Expected WorkspaceFsError on SHA mismatch"))
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasDies(cause)).toBe(false)
          expect(Cause.hasFails(cause)).toBe(true)
          const err = Cause.findErrorOption(cause)
          match(err)
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value).toBeInstanceOf(WorkspaceFsError)
              expect(value.reason).toContain("SHA-256 mismatch")
            })
            .with({ _tag: "None" }, () => expect.fail("Expected typed error in Cause"))
            .exhaustive()
        })
        .exhaustive()

      // Dead store fails with WorkflowStoreUnavailableError (no defects)
      const failExit = await Effect.runPromiseExit(
        beforeRebuildWorkflowBackup(backupDir).pipe(Effect.provide(deadLayer)),
      )
      match(failExit)
        .with({ _tag: "Success" }, () => expect.fail("Expected Failure when backup store is down"))
        .with({ _tag: "Failure" }, ({ cause }) => {
          expect(Cause.hasDies(cause)).toBe(false)
          expect(Cause.hasFails(cause)).toBe(true)
          const err = Cause.findErrorOption(cause)
          match(err)
            .with({ _tag: "Some" }, ({ value }) => {
              match(value)
                .with({ _tag: "WorkflowStoreUnavailableError" }, (errVal) => {
                  expect(errVal).toBeInstanceOf(WorkflowStoreUnavailableError)
                  expect(errVal.operation).toBe("WorkflowGraphBackup.exportBackup")
                  expect(errVal.reason.length).toBeGreaterThan(0)
                })
                .with({ _tag: "WorkspaceFsError" }, () =>
                  expect.fail("Expected WorkflowStoreUnavailableError, got WorkspaceFsError"),
                )
                .exhaustive()
            })
            .with({ _tag: "None" }, () =>
              expect.fail("Expected typed WorkflowStoreUnavailableError"),
            )
            .exhaustive()
        })
        .exhaustive()

      // Also exercise exportWorkflowGraphBackup & restoreWorkflowGraphBackup directly
      const directExport = await Effect.runPromise(
        exportWorkflowGraphBackup(backupDir, {
          repoRoot: AbsoluteRepoRoot.make(dir),
          client: directClient,
          nowMs: () => 5001,
        }),
      )
      expect(directExport.entityCount).toBe(1)
      const directRestore = await Effect.runPromise(
        restoreWorkflowGraphBackup(
          {
            backupFile: directExport.backupFile,
            mode: "merge",
            expectedSha256: directExport.sha256,
          },
          {
            repoRoot: AbsoluteRepoRoot.make(dir),
            client: directClient,
            nowMs: () => 6000,
          },
        ),
      )
      expect(directRestore.restoredEntityCount).toBe(1)
      expect(directRestore.sha256).toBe(directExport.sha256)
    } finally {
      directServer.closeAllConnections()
      directServer.close()
    }
  })

  it("executes omnigraph policy validate and policy test for --graph harness-workflows", () => {
    const omnigraphBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")
    expect(nodeSyncHostIo.existsSync(omnigraphBin)).toBe(true)

    const workspaceRoot = resolve(import.meta.dirname, "../../..")
    const graphConfigDir = join(workspaceRoot, "libs", "harness", "graph")
    const tempDir = mkdtempSync(join(tmpdir(), "harness-wf2-policy-"))
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
      [
        "policy",
        "validate",
        "--target",
        `file://${tempClusterDir}`,
        "--graph",
        "harness-workflows",
      ],
      { encoding: "utf8" },
    )
    expect(validateOut).toContain("policy valid: bundle 'workflow-access'")

    const testOut = execFileSync(
      omnigraphBin,
      [
        "policy",
        "test",
        "--target",
        `file://${tempClusterDir}`,
        "--graph",
        "harness-workflows",
        "--tests",
        join(graphConfigDir, "workflow-policy-tests.yaml"),
      ],
      { encoding: "utf8" },
    )
    expect(testOut).toContain("policy tests passed: 21 cases")
  })

  it("runOfflineOmnigraphLintGate lints both harness and harness-workflows schema/query pairs", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf2-lint-")
    const seenArgs: Array<string> = []
    const lintBin = join(repoRoot, "omnigraph-lint.sh")
    const logPath = join(repoRoot, "lint-args.log")
    writeFileSync(
      lintBin,
      `#!/bin/sh
echo "$*" >> "${logPath}"
if echo "$*" | grep -q "workflows.schema.pg"; then
  cat <<'EOF'
{"status":"error","queries_processed":1,"findings":[{"code":"WF001","message":"Invalid workflow query","target":"wf_bad"}]}
EOF
  exit 1
fi
cat <<'EOF'
{"status":"ok","queries_processed":1,"findings":[]}
EOF
`,
      "utf8",
    )
    chmodSync(lintBin, 0o755)

    const failRes = await Effect.runPromise(runOfflineOmnigraphLintGate(repoRoot, lintBin))
    expect(failRes.ok).toBe(false)
    if (!failRes.ok) {
      expect(failRes.message).toContain("Invalid workflow query")
    }
    const logged = readFileSync(logPath, "utf8")
    seenArgs.push(...logged.trim().split("\n"))
    expect(seenArgs).toHaveLength(2)
    expect(seenArgs[0]).toContain("schema.pg")
    expect(seenArgs[1]).toContain("workflows.schema.pg")
  })

  it("regression: syncOmnigraphOnDone ONLY targets harness graph and never touches harness-workflows", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf2-done-reg-")
    const configDir = join(repoRoot, "libs", "harness", "graph")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(clusterDir, { recursive: true })
    const drift = await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, false))
    writeClusterDriftReceipts(clusterDir, drift.expectedStamp, configDir)
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot, nodeSyncHostIo)

    const requestedUrls: Array<string> = []
    const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      requestedUrls.push(url)
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 2 }))
        return
      }
      if (req.method === "GET" && url.includes("/blob")) {
        res.writeHead(404, headers)
        res.end(JSON.stringify({ error: "not found" }))
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
    await new Promise<void>((resPromise, rejPromise) => {
      server.once("error", rejPromise)
      server.listen(0, "127.0.0.1", () => resPromise())
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
    const g = buildHarnessGraph({
      tests: [
        {
          testId: "tc-wf2-reg-1",
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
      expect(requestedUrls.some((u) => u.includes("/graphs/harness/"))).toBe(true)
      expect(requestedUrls.some((u) => u.includes("harness-workflows"))).toBe(false)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it("tryQueryWarmDaemonSocket resolves <git-common-dir>/harness/daemon.sock inside git repos", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "harness-wf2-sock-"))
    tempDirs.push(repoRoot)
    const sockDir = join(repoRoot, ".git", "harness")
    mkdirSync(sockDir, { recursive: true })
    const sockPath = join(sockDir, "daemon.sock")

    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write(JSON.stringify({ ok: true, status: "warm" }) + "\n")
        socket.end()
      })
    })
    await new Promise<void>((resPromise) => server.listen(sockPath, () => resPromise()))
    try {
      const resOpt = await Effect.runPromise(tryQueryWarmDaemonSocket(repoRoot, "ping"))
      expect(Option.isSome(resOpt)).toBe(true)
      const val = match(resOpt)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      expect(val?.status).toBe("warm")
      expect(existsSync(join(repoRoot, ".harness", "daemon.sock"))).toBe(false)
    } finally {
      await new Promise<void>((resPromise) => server.close(() => resPromise()))
    }
  })

  it("runWithTestTracer records all SPEC-0021 WF-2 spans with Effect.scoped acquireWriterLease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-wf2-tracer-"))
    tempDirs.push(dir)
    const gitRepo = join(dir, "repo")
    mkdirSync(gitRepo, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: gitRepo })
    const commonGitDir = GitCommonDirPath.make(join(gitRepo, ".git"))
    const backupDir = BackupDirPath.make(join(dir, "backups"))
    const lockFilePath = LeaseFilePath.make(join(commonGitDir, "harness", "daemon.lock"))
    const clusterDir = join(dir, "cluster")
    mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })
    const emptyFnIndex = new Map<string, IndexedEffectFn>()

    const rowJson = JSON.stringify({
      type: "WfMessage",
      id: "m-tr-1",
      data: { messageKey: "m-tr-1", seqKey: "00000000000000000001" },
    })
    const httpServer = createServer((req, res) => {
      const url = req.url ?? ""
      const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/export")) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Omnigraph-Http-Api": "0.14" })
        res.end(`${rowJson}\n`)
        return
      }
      if (url.includes("/load")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ outcome: "loaded", commit_id: "c1", totalEntities: 1 }))
        return
      }
      if (url.includes("/queries/wf_count_all")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [{ totalMessages: 1 }], graphCommitId: "c1" }))
        return
      }
      if (url.includes("/queries/wf_count_replies")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [{ totalReplies: 0 }], graphCommitId: "c1" }))
        return
      }
      if (url.includes("/queries/wf_get_writer_lease")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [], graphCommitId: "c1" }))
        return
      }
      if (
        url.includes("/queries/wf_orphan_entity_messages") ||
        url.includes("/queries/wf_dangling_processed_requests")
      ) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [], graphCommitId: "c1" }))
        return
      }
      if (
        url.includes("/queries/wf_insert_writer_lease") ||
        url.includes("/queries/wf_refresh_writer_lease") ||
        url.includes("/queries/wf_clear_replies_unconditional_delete") ||
        url.includes("/queries/wf_reset_message_for_clear")
      ) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({ affectedNodes: 1, affectedEdges: 0, commit: { graphCommitId: "c2" } }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resPromise) => httpServer.listen(0, "127.0.0.1", () => resPromise()))
    const httpPort = (httpServer.address() as AddressInfo).port
    const client = new OmnigraphClient({
      baseUrl: `http://127.0.0.1:${httpPort}`,
      graphId: "harness-workflows",
    })
    const absRepoRoot = AbsoluteRepoRoot.make(gitRepo)
    const backupLayer = makeWorkflowGraphBackupLayer({
      repoRoot: absRepoRoot,
      client,
      nowMs: () => 9000,
    })

    const sockPath = DaemonSocketPath.make(join(dir, "daemon.sock"))
    const ipcServer = net.createServer((socket) => {
      let buf = ""
      socket.on("data", (chunk) => {
        buf += String(chunk)
        const nlIdx = buf.indexOf("\n")
        if (nlIdx < 0) return
        const reqObj = JSON.parse(buf.slice(0, nlIdx)) as {
          readonly id?: string
          readonly command?: string
        }
        if (reqObj.command === "ping") {
          socket.write(
            JSON.stringify({ id: reqObj.id ?? "req-ping", ok: true, status: "warm" }) + "\n",
          )
          socket.end()
          return
        }
        socket.write(
          JSON.stringify({
            id: reqObj.id ?? "req-1",
            ok: true,
            handshake: {
              protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
              capabilities: ["workflow.handshake"],
              repoRoot: absRepoRoot,
              commonGitDir,
              writerLeaseEpoch: 1,
            },
          }) + "\n",
        )
        socket.end()
      })
    })
    await new Promise<void>((resPromise) => ipcServer.listen(sockPath, () => resPromise()))

    const fakeOmnigraph = join(dir, "omnigraph-maint.sh")
    writeFileSync(
      fakeOmnigraph,
      `#!/bin/sh\nif [ "$1" = "export" ]; then printf '%s\\n' '${rowJson}'; fi\nexit 0\n`,
      "utf8",
    )
    chmodSync(fakeOmnigraph, 0o755)

    try {
      const { spans } = await Effect.runPromise(
        runWithTestTracer(
          "wf2-spec0021-spans",
          Effect.gen(function* () {
            yield* validateWorktreeRepoRoot(absRepoRoot)
            const backup = yield* beforeRebuildWorkflowBackup(backupDir)
            yield* afterRebuildWorkflowBackup({
              backupFile: backup.backupFile,
              mode: "merge",
              expectedSha256: backup.sha256,
            })
            yield* Effect.scoped(
              Effect.gen(function* () {
                const lease = yield* acquireWriterLease({
                  commonGitDir,
                  lockFilePath,
                  holderId: LeaseHolderId.make("wf2-test"),
                  holderPid: LeaseHolderPid.make(process.pid),
                  repoRoot: absRepoRoot,
                  client,
                })
                yield* refreshWriterLease({
                  commonGitDir,
                  lockFilePath,
                  holderId: LeaseHolderId.make("wf2-test"),
                  holderPid: LeaseHolderPid.make(process.pid),
                  leaseEpoch: lease.leaseEpoch,
                  repoRoot: absRepoRoot,
                  client,
                })
              }),
            )
            yield* quarantineOrphanEntityMessages({
              repoRoot: absRepoRoot,
              knownEntityTypes: ["Workflow/Test"],
              client,
            })
            yield* repairDanglingProcessedRequests({
              repoRoot: absRepoRoot,
              client,
            })
            yield* clearOmnigraphReplies({
              repoRoot: absRepoRoot,
              requestId: Snowflake.Snowflake(1001n),
              client,
            })
            yield* runOfflineWorkflowMaintenance({
              repoRoot: absRepoRoot,
              commonGitDir,
              backupDir,
              omnigraphBin: fakeOmnigraph,
              clusterDir,
            })
            yield* handshakeWorkflowDaemon({
              socketPath: sockPath,
              request: { protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION, repoRoot: absRepoRoot },
              requiredCapabilities: [WorkflowDaemonCapability.make("workflow.handshake")],
            })
            yield* queryWorkflowDaemonCommand({
              socketPath: sockPath,
              command: "ping",
            })
          }).pipe(Effect.provide(Layer.merge(backupLayer, UnixSocketDaemonLive))),
          emptyFnIndex,
        ),
      )

      const recordedNames = new Set(spans.map((s) => s.name))
      for (const expectedSpan of [
        "OmnigraphWorkflowBackup.beforeRebuild",
        "OmnigraphWorkflowBackup.afterRebuild",
        "WorkflowGraphBackup.exportBackup",
        "WorkflowGraphBackup.restoreBackup",
        "WorktreeRepoRoot.validate",
        "WorkflowStore.invoke",
        "WorkflowStore.invokeWithMeta",
        "WorkflowStore.quarantineOrphans",
        "WfWriterLease.acquire",
        "WfWriterLease.refresh",
        "OmnigraphMessageStorage.clearReplies",
        "OmnigraphMessageStorage.repairDangling",
        "WorkflowMaintenance.runOffline",
        "OmnigraphCluster.acquireStartupLock",
        "HarnessDaemonClient.handshake",
        "HarnessDaemonClient.queryCommand",
      ] as const) {
        expect(recordedNames.has(expectedSpan), `missing span ${expectedSpan}`).toBe(true)
      }
    } finally {
      httpServer.closeAllConnections()
      httpServer.close()
      await new Promise<void>((resPromise) => ipcServer.close(() => resPromise()))
    }
  })
})
