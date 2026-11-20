import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { killOmnigraphServerPidIfAlive } from "../src/commands/omnigraph-auth-and-drift.js"
import { ensureLocalOmnigraphReady } from "../src/commands/omnigraph-lifecycle.js"
import {
  readPendingWorkflowRestoreJournal,
  resolveWorkflowBackupDir,
} from "../src/commands/omnigraph-workflow-backup.js"

const tempDirs: Array<string> = []
const childPids: Array<number> = []

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

describe("RFC-0013 WF-2 CLI Clean Rebuild and Journal Recovery", () => {
  afterEach(() => {
    while (childPids.length > 0) {
      const pid = childPids.pop()
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // already exited
        }
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it("aborts clean rebuild BEFORE killing server PID or deleting cluster when pre-rebuild workflow backup fails", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf2-abort-")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })
    const sentinel = join(clusterDir, "preserve.txt")
    writeFileSync(sentinel, "keep-me", "utf8")
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), "old-epoch\n", "utf8")

    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    let exportHits = 0
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url === "/readyz") {
        res.writeHead(200, { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" })
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 2 }))
        return
      }
      if (url.includes("/export")) {
        exportHits += 1
        res.writeHead(500, { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" })
        res.end(JSON.stringify({ error: "export unavailable" }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resPromise, rejPromise) => {
      server.once("error", rejPromise)
      server.listen(0, "127.0.0.1", () => resPromise())
    })
    const port = (server.address() as AddressInfo).port

    const dummyServer = spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => process.exit(0), 20000)",
        "--",
        "omnigraph-server",
        "--cluster",
        `file://${clusterDir}`,
      ],
      { stdio: "ignore" },
    )
    expect(dummyServer.pid).toBeGreaterThan(1)
    if (dummyServer.pid !== undefined) childPids.push(dummyServer.pid)

    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: dummyServer.pid,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        canonicalRepoRoot: canonicalRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    const prevUrl = process.env.OMNIGRAPH_URL
    Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
    try {
      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(ready).toBe(false)
      expect(exportHits).toBeGreaterThanOrEqual(1)
      expect(readFileSync(sentinel, "utf8")).toBe("keep-me")
      let stillAlive = true
      try {
        process.kill(dummyServer.pid!, 0)
      } catch {
        stillAlive = false
      }
      expect(stillAlive).toBe(true)
    } finally {
      if (prevUrl !== undefined) process.env.OMNIGRAPH_URL = prevUrl
      server.closeAllConnections()
      server.close()
    }
  })

  it("runs offline backup fallback on stopped cluster and restores onto main (mode=merge) after rebuild", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf2-offline-restore-")
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), "old-epoch\n", "utf8")

    const fakeHome = join(repoRoot, "fake-home")
    const binDir = join(fakeHome, ".local", "bin")
    mkdirSync(binDir, { recursive: true })
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const port = deriveRepoOmnigraphPort(canonicalRoot, nodeSyncHostIo)
    const exportedLine = JSON.stringify({
      type: "WfMessage",
      id: "msg-1",
      data: { messageKey: "msg-1", seqKey: "00000000000000000001" },
    })

    const loadCapturePath = join(repoRoot, "load-capture.json")
    const fakeCli = join(binDir, "omnigraph")
    writeFileSync(
      fakeCli,
      `#!/bin/sh
if [ "$1" = "export" ]; then
  printf '%s\\n' '${exportedLine}'
  exit 0
fi
if [ "$1" = "cluster" ] && [ "$2" = "apply" ]; then
  mkdir -p "${join(clusterDir, "graphs", "harness.omni")}"
  mkdir -p "${join(clusterDir, "graphs", "harness-workflows.omni")}"
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
const server = http.createServer((req, res) => {
  const url = req.url || "";
  const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" };
  if (url === "/healthz") {
    res.writeHead(200, { "Omnigraph-Http-Api": "0.14" });
    res.end();
    return;
  }
  if (url === "/readyz") {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 2 }));
    return;
  }
  if (url.includes("/load")) {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      fs.writeFileSync(${JSON.stringify(loadCapturePath)}, JSON.stringify({ url, body }));
      res.writeHead(200, headers);
      res.end(JSON.stringify({ outcome: "loaded", commit_id: "c-restored", totalEntities: 1, nodes_loaded: 1, edges_loaded: 0 }));
    });
    return;
  }
  if (url.includes("/queries/wf_count_all")) {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ rows: [{ totalMessages: 1 }], graphCommitId: "c-restored" }));
    return;
  }
  if (url.includes("/queries/wf_count_replies")) {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ rows: [{ totalReplies: 0 }], graphCommitId: "c-restored" }));
    return;
  }
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "not found: " + url }));
});
server.listen(${port}, "127.0.0.1");
setTimeout(() => process.exit(0), 15000);
`,
      "utf8",
    )
    chmodSync(fakeServer, 0o755)

    const prevHome = process.env.HOME
    const prevUrl = process.env.OMNIGRAPH_URL
    process.env.HOME = fakeHome
    Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
    try {
      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(ready).toBe(true)

      const backupDir = resolveWorkflowBackupDir(repoRoot)
      expect(backupDir).toBe(join(repoRoot, ".git", "harness", "workflow-backups"))
      const backupFiles = readdirSync(backupDir).filter((f) => f.endsWith(".ndjson"))
      expect(backupFiles).toHaveLength(1)
      const savedContent = readFileSync(join(backupDir, backupFiles[0]!), "utf8")
      expect(savedContent).toContain('"messageKey":"msg-1"')
      const expectedHash = createHash("sha256").update(savedContent, "utf8").digest("hex")
      expect(backupFiles[0]).toContain(expectedHash.slice(0, 12))

      const capturedLoad = JSON.parse(readFileSync(loadCapturePath, "utf8")) as {
        readonly url: string
        readonly body: string
      }
      expect(capturedLoad.url).toContain("/load")
      const loadPayload = JSON.parse(capturedLoad.body) as {
        readonly branch?: string
        readonly mode?: string
        readonly data?: string
      }
      expect(loadPayload.branch).toBe("main")
      expect(loadPayload.mode).toBe("merge")
      expect(loadPayload.data).toContain('"messageKey":"msg-1"')

      const serverMeta = JSON.parse(readFileSync(join(clusterDir, "server.json"), "utf8")) as {
        readonly pid?: number
      }
      if (typeof serverMeta.pid === "number") {
        childPids.push(serverMeta.pid)
      }
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
      if (prevUrl === undefined) Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      else process.env.OMNIGRAPH_URL = prevUrl
    }
  })

  it("aborts BEFORE deleting cluster files when offline workflow backup fails (serverAlive=false)", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf2-offline-fail-")
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })
    const sentinel = join(clusterDir, "keep-offline.txt")
    writeFileSync(sentinel, "preserve-offline", "utf8")
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), "old-epoch\n", "utf8")

    const fakeHome = join(repoRoot, "fake-home")
    const binDir = join(fakeHome, ".local", "bin")
    mkdirSync(binDir, { recursive: true })
    const fakeCli = join(binDir, "omnigraph")
    writeFileSync(
      fakeCli,
      '#!/bin/sh\nif [ "$1" = "export" ]; then\n  echo "export failed" >&2\n  exit 1\nfi\nexit 0\n',
      "utf8",
    )
    chmodSync(fakeCli, 0o755)
    const fakeServer = join(binDir, "omnigraph-server")
    writeFileSync(fakeServer, "#!/bin/sh\nexit 0\n", "utf8")
    chmodSync(fakeServer, 0o755)

    const prevHome = process.env.HOME
    const prevUrl = process.env.OMNIGRAPH_URL
    process.env.HOME = fakeHome
    Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
    try {
      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(ready).toBe(false)
      expect(readFileSync(sentinel, "utf8")).toBe("preserve-offline")
      expect(existsSync(join(clusterDir, "graphs", "harness-workflows.omni"))).toBe(true)
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
      if (prevUrl !== undefined) process.env.OMNIGRAPH_URL = prevUrl
    }
  })

  it("preserves pending-workflow-restore.json on restore failure, kills spawned server without advertising server.json, and recovers full entities on retry", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf2-pending-retry-")
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), "old-epoch\n", "utf8")

    const fakeHome = join(repoRoot, "fake-home")
    const binDir = join(fakeHome, ".local", "bin")
    mkdirSync(binDir, { recursive: true })
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    const port = deriveRepoOmnigraphPort(canonicalRoot, nodeSyncHostIo)
    const exportedLine = JSON.stringify({
      type: "WfMessage",
      id: "msg-retry-1",
      data: { messageKey: "msg-retry-1", seqKey: "00000000000000000001" },
    })
    const exportCountFile = join(repoRoot, "export-count.txt")
    writeFileSync(exportCountFile, "0", "utf8")

    const fakeCli = join(binDir, "omnigraph")
    writeFileSync(
      fakeCli,
      `#!/bin/sh
if [ "$1" = "export" ]; then
  n=$(cat "${exportCountFile}")
  echo $((n + 1)) > "${exportCountFile}"
  printf '%s\\n' '${exportedLine}'
  exit 0
fi
if [ "$1" = "cluster" ] && [ "$2" = "apply" ]; then
  mkdir -p "${join(clusterDir, "graphs", "harness.omni")}"
  mkdir -p "${join(clusterDir, "graphs", "harness-workflows.omni")}"
  echo '{"status":"applied"}'
  exit 0
fi
exit 0
`,
      "utf8",
    )
    chmodSync(fakeCli, 0o755)

    const modeFlagFile = join(repoRoot, "restore-mode.txt")
    writeFileSync(modeFlagFile, "fail", "utf8")
    const spawnedPidsFile = join(repoRoot, "spawned-pids.log")
    const restoredBodiesFile = join(repoRoot, "restored-bodies.log")
    const fakeServer = join(binDir, "omnigraph-server")
    writeFileSync(
      fakeServer,
      `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(spawnedPidsFile)}, String(process.pid) + "\\n");
const server = http.createServer((req, res) => {
  const url = req.url || "";
  const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" };
  if (url === "/healthz") { res.writeHead(200, { "Omnigraph-Http-Api": "0.14" }); res.end(); return; }
  if (url === "/readyz") {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 2 }));
    return;
  }
  if (url.includes("/load")) {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      const mode = fs.readFileSync(${JSON.stringify(modeFlagFile)}, "utf8").trim();
      if (mode === "fail") {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "transient restore rejection" }));
        return;
      }
      fs.appendFileSync(${JSON.stringify(restoredBodiesFile)}, body + "\\n");
      res.writeHead(200, headers);
      res.end(JSON.stringify({ outcome: "loaded", commit_id: "c-retried", totalEntities: 1, nodes_loaded: 1, edges_loaded: 0 }));
    });
    return;
  }
  if (url.includes("/queries/wf_count_all")) {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ rows: [{ totalMessages: 1 }], graphCommitId: "c-retried" }));
    return;
  }
  if (url.includes("/queries/wf_count_replies")) {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ rows: [{ totalReplies: 0 }], graphCommitId: "c-retried" }));
    return;
  }
  res.writeHead(404, headers);
  res.end();
});
server.listen(${port}, "127.0.0.1");
setTimeout(() => process.exit(0), 15000);
`,
      "utf8",
    )
    chmodSync(fakeServer, 0o755)

    const prevHome = process.env.HOME
    const prevUrl = process.env.OMNIGRAPH_URL
    process.env.HOME = fakeHome
    Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
    try {
      const ready1 = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(ready1).toBe(false)
      expect(existsSync(join(clusterDir, "server.json"))).toBe(false)
      expect(existsSync(join(clusterDir, ".cluster-schema-epoch"))).toBe(false)
      const firstPid = Number(readFileSync(spawnedPidsFile, "utf8").trim().split("\n")[0])
      expect(Number.isInteger(firstPid)).toBe(true)
      let firstAlive = true
      try {
        process.kill(firstPid, 0)
      } catch {
        firstAlive = false
      }
      expect(firstAlive).toBe(false)
      const pending1 = readPendingWorkflowRestoreJournal(repoRoot, clusterDir)
      expect(pending1._tag).toBe("Some")

      writeFileSync(modeFlagFile, "ok", "utf8")
      const ready2 = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(ready2).toBe(true)
      expect(Number(readFileSync(exportCountFile, "utf8").trim())).toBe(1)
      expect(readPendingWorkflowRestoreJournal(repoRoot, clusterDir)._tag).toBe("None")
      expect(existsSync(join(clusterDir, "server.json"))).toBe(true)
      expect(readFileSync(restoredBodiesFile, "utf8")).toContain("msg-retry-1")

      const meta2 = JSON.parse(readFileSync(join(clusterDir, "server.json"), "utf8")) as {
        readonly pid?: number
      }
      if (typeof meta2.pid === "number") childPids.push(meta2.pid)
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
      if (prevUrl !== undefined) process.env.OMNIGRAPH_URL = prevUrl
    }
  })

  it("subdirectory invocation resolves clusterRepoRoot and backupDir properly and killOmnigraphServerPidIfAlive escalates to SIGKILL", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-wf2-subdir-")
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    const subDir = join(repoRoot, "apps", "sub-pkg")
    mkdirSync(subDir, { recursive: true })

    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })
    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), "old-epoch\n", "utf8")

    const fakeHome = join(repoRoot, "fake-home")
    const binDir = join(fakeHome, ".local", "bin")
    mkdirSync(binDir, { recursive: true })
    const port = deriveRepoOmnigraphPort(repoRoot, nodeSyncHostIo)
    const line = JSON.stringify({
      type: "WfMessage",
      id: "msg-sub-1",
      data: { messageKey: "msg-sub-1", seqKey: "00000000000000000001" },
    })

    writeFileSync(
      join(binDir, "omnigraph"),
      `#!/bin/sh
if [ "$1" = "export" ]; then printf '%s\\n' '${line}'; exit 0; fi
if [ "$1" = "cluster" ] && [ "$2" = "apply" ]; then
  mkdir -p "${join(clusterDir, "graphs", "harness.omni")}"
  mkdir -p "${join(clusterDir, "graphs", "harness-workflows.omni")}"
  echo '{"status":"applied"}'
  exit 0
fi
exit 0
`,
      "utf8",
    )
    chmodSync(join(binDir, "omnigraph"), 0o755)
    writeFileSync(
      join(binDir, "omnigraph-server"),
      `#!${process.execPath}
const http = require("node:http");
const server = http.createServer((req, res) => {
  const url = req.url || "";
  const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" };
  if (url === "/healthz") { res.writeHead(200, { "Omnigraph-Http-Api": "0.14" }); res.end(); return; }
  if (url === "/readyz") { res.writeHead(200, headers); res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 2 })); return; }
  if (url.includes("/load")) { res.writeHead(200, headers); res.end(JSON.stringify({ outcome: "loaded", commit_id: "c-sub", totalEntities: 1 })); return; }
  if (url.includes("/queries/wf_count_all")) { res.writeHead(200, headers); res.end(JSON.stringify({ rows: [{ totalMessages: 1 }], graphCommitId: "c-sub" })); return; }
  if (url.includes("/queries/wf_count_replies")) { res.writeHead(200, headers); res.end(JSON.stringify({ rows: [{ totalReplies: 0 }], graphCommitId: "c-sub" })); return; }
  res.writeHead(404); res.end();
});
server.listen(${port}, "127.0.0.1");
setTimeout(() => process.exit(0), 15000);
`,
      "utf8",
    )
    chmodSync(join(binDir, "omnigraph-server"), 0o755)

    const trapChild = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => process.exit(0), 20000)",
        "--",
        "omnigraph-server",
        "--cluster",
        `file://${clusterDir}`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    expect(trapChild.pid).toBeGreaterThan(1)
    if (trapChild.pid !== undefined) childPids.push(trapChild.pid)
    await new Promise<void>((resPromise) => {
      trapChild.stdout?.once("data", () => resPromise())
    })
    const killedOk = await Effect.runPromise(
      killOmnigraphServerPidIfAlive(trapChild.pid, clusterDir, "sigkill-test"),
    )
    expect(killedOk).toBe(true)

    const prevHome = process.env.HOME
    const prevUrl = process.env.OMNIGRAPH_URL
    process.env.HOME = fakeHome
    Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
    try {
      const ready = await Effect.runPromise(ensureLocalOmnigraphReady(subDir))
      expect(ready).toBe(true)
      const backupDir = resolveWorkflowBackupDir(repoRoot)
      const files = readdirSync(backupDir).filter((f) => f.endsWith(".ndjson"))
      expect(files).toHaveLength(1)
      const meta = JSON.parse(readFileSync(join(clusterDir, "server.json"), "utf8")) as {
        readonly pid?: number
      }
      if (typeof meta.pid === "number") childPids.push(meta.pid)
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
      if (prevUrl !== undefined) process.env.OMNIGRAPH_URL = prevUrl
    }
  })
})
