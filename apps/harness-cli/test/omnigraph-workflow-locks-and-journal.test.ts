import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { match } from "ts-pattern"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BackupFileHash,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  WorkflowBackupTimestampMs,
} from "@harness/contract"
import {
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import {
  ensureOmnigraphEndpointTokens,
  evaluateClusterConfigDrift,
  writeClusterDriftReceipts,
} from "../src/commands/omnigraph-auth-and-drift.js"
import { ensureLocalOmnigraphReady } from "../src/commands/omnigraph-lifecycle.js"
import { readOmnigraphServerMetaChecked } from "../src/commands/omnigraph-lifecycle-setup.js"
import {
  readClusterConfigStampDigest,
  readPendingWorkflowRestoreJournal,
  resolveWorkflowBackupDir,
  runWorkflowRestoreAfterRebuild,
  withClusterDaemonLockIfGit,
  writePendingWorkflowRestoreJournal,
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

const spawnFlockHolder = async (lockFilePath: string): Promise<number> => {
  mkdirSync(join(lockFilePath, ".."), { recursive: true })
  const child = spawn(
    "/usr/bin/flock",
    [lockFilePath, process.execPath, "-e", "console.log('locked'); setInterval(() => {}, 1000)"],
    { stdio: ["ignore", "pipe", "ignore"] },
  )
  expect(child.pid).toBeGreaterThan(1)
  if (child.pid !== undefined) {
    childPids.push(child.pid)
  }
  await new Promise<void>((resolveReady, rejectReady) => {
    child.once("error", rejectReady)
    child.stdout?.once("data", () => resolveReady())
  })
  return child.pid!
}

const makeVerifiedBackupFile = (
  repoRoot: string,
  ndjsonLine = JSON.stringify({
    type: "WfMessage",
    id: "msg-journal-1",
    data: { messageKey: "msg-journal-1", seqKey: "00000000000000000001" },
  }),
) => {
  const backupDir = resolveWorkflowBackupDir(repoRoot)
  mkdirSync(backupDir, { recursive: true })
  const content = `${ndjsonLine}\n`
  const sha256 = BackupFileHash.make(createHash("sha256").update(content, "utf8").digest("hex"))
  const backupFile = WorkflowBackupFilePath.make(
    join(backupDir, `workflow-backup-1000-${sha256.slice(0, 12)}.ndjson`),
  )
  writeFileSync(backupFile, content, { encoding: "utf8", mode: 0o600 })
  return {
    _tag: "BackedUp" as const,
    backupFile,
    timestampMs: WorkflowBackupTimestampMs.make(1000),
    sha256,
    entityCount: WorkflowBackupCount.make(1),
  }
}

describe("RFC-0013 WF-2 Daemon Lock Scoping and Pending Journal Binding", () => {
  afterEach(() => {
    vi.restoreAllMocks()
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

  it("F-11.1: warm/cold NoOp and LiveClusterApply never acquire daemon.lock, while RequiresCleanRebuild does", async () => {
    // 1. Cold NoOp in a git repo never creates or locks daemon.lock
    const coldRepo = makeTempWorkflowRepo("harness-f11-1-cold-")
    mkdirSync(join(coldRepo, ".git"), { recursive: true })
    const coldClusterDir = resolveOmnigraphClusterDir(coldRepo, nodeSyncHostIo)
    mkdirSync(join(coldClusterDir, "graphs", "harness.omni"), { recursive: true })
    const coldConfigDir = join(coldRepo, "libs", "harness", "graph")
    const coldDrift = await Effect.runPromise(
      evaluateClusterConfigDrift(coldClusterDir, coldConfigDir, false),
    )
    writeClusterDriftReceipts(coldClusterDir, coldDrift.expectedStamp, coldConfigDir)

    const fakeHome = join(coldRepo, "fake-home")
    const binDir = join(fakeHome, ".local", "bin")
    mkdirSync(binDir, { recursive: true })
    const coldPort = deriveRepoOmnigraphPort(coldRepo, nodeSyncHostIo)
    writeFileSync(join(binDir, "omnigraph"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(
      join(binDir, "omnigraph-server"),
      `#!${process.execPath}
const http = require("node:http");
const server = http.createServer((req, res) => {
  const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" };
  if (req.url === "/readyz") {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 1 }));
    return;
  }
  res.writeHead(404, headers);
  res.end();
});
server.listen(${coldPort}, "127.0.0.1");
setTimeout(() => process.exit(0), 15000);
`,
      { mode: 0o755 },
    )
    const prevHome = process.env.HOME
    const prevUrl = process.env.OMNIGRAPH_URL
    process.env.HOME = fakeHome
    Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
    try {
      const coldOk = await Effect.runPromise(ensureLocalOmnigraphReady(coldRepo))
      expect(coldOk).toBe(true)
      const coldDaemonLock = join(coldRepo, ".git", "harness", "daemon.lock")
      expect(existsSync(coldDaemonLock)).toBe(false)
      const coldMeta = JSON.parse(readFileSync(join(coldClusterDir, "server.json"), "utf8")) as {
        readonly pid?: number
      }
      if (typeof coldMeta.pid === "number") childPids.push(coldMeta.pid)

      // 2. Warm NoOp succeeds even when daemon.lock is actively held by another process
      await spawnFlockHolder(coldDaemonLock)
      const warmOk = await Effect.runPromise(ensureLocalOmnigraphReady(coldRepo))
      expect(warmOk).toBe(true)

      // 3. LiveClusterApply succeeds even when daemon.lock is actively held
      writeFileSync(
        join(coldConfigDir, "workflows.schema.pg"),
        "node WfMessage {\n  messageKey: String @key\n  seqKey: String @index\n  extraField: String?\n}\n",
        "utf8",
      )
      const applyOk = await Effect.runPromise(ensureLocalOmnigraphReady(coldRepo))
      expect(applyOk).toBe(true)
      const applyMeta = JSON.parse(readFileSync(join(coldClusterDir, "server.json"), "utf8")) as {
        readonly pid?: number
      }
      if (typeof applyMeta.pid === "number") childPids.push(applyMeta.pid)

      // 4. RequiresCleanRebuild DOES acquire daemon.lock and fails closed while daemon.lock is held
      writeFileSync(join(coldClusterDir, ".cluster-schema-epoch"), "old-epoch\n", "utf8")
      const sentinel = join(coldClusterDir, "keep-on-lock-contention.txt")
      writeFileSync(sentinel, "preserved", "utf8")
      const rebuildBlocked = await Effect.runPromise(ensureLocalOmnigraphReady(coldRepo))
      expect(rebuildBlocked).toBe(false)
      expect(readFileSync(sentinel, "utf8")).toBe("preserved")
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME")
      else process.env.HOME = prevHome
      if (prevUrl !== undefined) process.env.OMNIGRAPH_URL = prevUrl
    }
  })

  it("F-11.2: withClusterDaemonLockIfGit fails closed when .git exists with unresolvable/invalid common dir and allows non-git dirs", async () => {
    // 1. Corrupt .git file -> resolveGitCommonDir returns null -> MUST fail closed
    const corruptGitRepo = mkdtempSync(join(tmpdir(), "harness-f11-2-corrupt-"))
    tempDirs.push(corruptGitRepo)
    writeFileSync(join(corruptGitRepo, ".git"), "corrupt-pointer-without-gitdir\n", "utf8")

    let ranCorrupt = false
    const corruptResult = await Effect.runPromise(
      withClusterDaemonLockIfGit(
        corruptGitRepo,
        Effect.sync(() => {
          ranCorrupt = true
          return true
        }),
      ),
    )
    expect(corruptResult).toBe(false)
    expect(ranCorrupt).toBe(false)

    // 2. .git exists with invalid GitCommonDirPath (whitespace/newline in commondir target) -> fail closed
    const badCommonDirRepo = mkdtempSync(join(tmpdir(), "harness-f11-2-badpath-"))
    tempDirs.push(badCommonDirRepo)
    const realGitDir = join(badCommonDirRepo, "worktree-git")
    mkdirSync(realGitDir, { recursive: true })
    writeFileSync(join(badCommonDirRepo, ".git"), `gitdir: ${realGitDir}\n`, "utf8")
    writeFileSync(join(realGitDir, "commondir"), "bad\nline", "utf8")

    let ranBadPath = false
    const badPathResult = await Effect.runPromise(
      withClusterDaemonLockIfGit(
        badCommonDirRepo,
        Effect.sync(() => {
          ranBadPath = true
          return true
        }),
      ),
    )
    expect(badPathResult).toBe(false)
    expect(ranBadPath).toBe(false)

    // 3. Non-git directory without .git -> runs unlocked
    const nonGitRepo = mkdtempSync(join(tmpdir(), "harness-f11-2-nongit-"))
    tempDirs.push(nonGitRepo)
    let ranNonGit = false
    const nonGitResult = await Effect.runPromise(
      withClusterDaemonLockIfGit(
        nonGitRepo,
        Effect.sync(() => {
          ranNonGit = true
          return true
        }),
      ),
    )
    expect(nonGitResult).toBe(true)
    expect(ranNonGit).toBe(true)
  })

  it("F-11.3: pending-workflow-restore.json fails closed on clusterRootDir mismatch, preRebuildConfigStamp mismatch, and populated graph, while recovering empty graph", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-f11-3-journal-")
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })
    const configDir = join(repoRoot, "libs", "harness", "graph")

    const backup = makeVerifiedBackupFile(repoRoot)
    const stampA = "stamp-A"
    writeFileSync(join(clusterDir, ".config-stamp"), stampA, "utf8")
    const stampADigest = readClusterConfigStampDigest(clusterDir)
    expect(stampADigest).not.toBeNull()

    // 1. Write journal bound to clusterDir + stampADigest
    const writeRes = writePendingWorkflowRestoreJournal(repoRoot, backup, clusterDir, stampADigest)
    expect(writeRes._tag).toBe("Success")

    // 2. clusterRootDir mismatch fails closed
    const wrongClusterDir = join(repoRoot, ".harness", "other-cluster")
    const clusterMismatch = readPendingWorkflowRestoreJournal(repoRoot, wrongClusterDir)
    expect(clusterMismatch._tag).toBe("Invalid")

    // 3. preRebuildConfigStamp mismatch fails closed in readPendingWorkflowRestoreJournal and RequiresCleanRebuild
    writeFileSync(join(clusterDir, ".config-stamp"), "stamp-B-drifted", "utf8")
    const stampMismatch = readPendingWorkflowRestoreJournal(repoRoot, clusterDir)
    expect(stampMismatch._tag).toBe("Invalid")

    writeFileSync(join(clusterDir, ".cluster-schema-epoch"), "old-epoch\n", "utf8")
    const sentinel = join(clusterDir, "keep-on-stamp-mismatch.txt")
    writeFileSync(sentinel, "keep", "utf8")
    const blockedRebuild = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
    expect(blockedRebuild).toBe(false)
    expect(readFileSync(sentinel, "utf8")).toBe("keep")

    // 4. Stale journal alongside an ALREADY-POPULATED live harness-workflows graph (totalMessages > 0) fails closed
    const drift = await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, false))
    writeClusterDriftReceipts(clusterDir, drift.expectedStamp, configDir)
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)

    let loadCalls = 0
    let serverMsgCount = 2
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url === "/readyz") {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ready: true, status: "serving", ready_graph_count: 2 }))
        return
      }
      if (url.includes("/queries/wf_count_all")) {
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({ rows: [{ totalMessages: serverMsgCount }], graphCommitId: "c-live" }),
        )
        return
      }
      if (url.includes("/queries/wf_count_replies")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [{ totalReplies: 0 }], graphCommitId: "c-live" }))
        return
      }
      if (url.includes("/load")) {
        loadCalls += 1
        serverMsgCount = 1
        res.writeHead(200, headers)
        res.end(
          JSON.stringify({
            outcome: "loaded",
            commit_id: "c-restored",
            totalEntities: 1,
            nodes_loaded: 1,
            edges_loaded: 0,
          }),
        )
        return
      }
      res.writeHead(404, headers)
      res.end()
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

    const prevUrl = process.env.OMNIGRAPH_URL
    Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
    try {
      const populatedBlocked = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(populatedBlocked).toBe(false)
      expect(loadCalls).toBe(0)

      // 5. When harness-workflows is empty (0 rows after mid-rebuild crash), NoOp recovers cleanly & clears journal
      serverMsgCount = 0
      const emptyRecovered = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
      expect(emptyRecovered).toBe(true)
      expect(loadCalls).toBe(1)
      expect(readPendingWorkflowRestoreJournal(repoRoot, clusterDir)._tag).toBe("None")
    } finally {
      if (prevUrl !== undefined) process.env.OMNIGRAPH_URL = prevUrl
      server.closeAllConnections()
      server.close()
    }
  })

  it("enforces backupDir containment, entityCount parity, daemon.lock on NoOp pending restore, and symlink rejection on auth-tokens/server.json/.config-stamp", async () => {
    const repoRoot = makeTempWorkflowRepo("harness-sec-journal-")
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    const clusterDir = resolveOmnigraphClusterDir(repoRoot, nodeSyncHostIo)
    mkdirSync(join(clusterDir, "graphs", "harness.omni"), { recursive: true })
    mkdirSync(join(clusterDir, "graphs", "harness-workflows.omni"), { recursive: true })
    const configDir = join(repoRoot, "libs", "harness", "graph")

    // 1. Escaping backupFile outside backupDir (outside file and symlinked dir) MUST fail closed
    const outsideDir = mkdtempSync(join(tmpdir(), "harness-outside-backup-"))
    tempDirs.push(outsideDir)
    const outsideContent = '{"type":"WfMessage","id":"x","data":{"messageKey":"x"}}\n'
    const outsideSha = BackupFileHash.make(
      createHash("sha256").update(outsideContent, "utf8").digest("hex"),
    )
    const outsideFile = join(outsideDir, "escaped.ndjson")
    writeFileSync(outsideFile, outsideContent, "utf8")

    const backupDir = resolveWorkflowBackupDir(repoRoot)
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(
      join(backupDir, "pending-workflow-restore.json"),
      JSON.stringify({
        backupFile: outsideFile,
        timestampMs: 1000,
        sha256: outsideSha,
        entityCount: 1,
        clusterRootDir: clusterDir,
        preRebuildConfigStamp: null,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    )
    const outsideRes = readPendingWorkflowRestoreJournal(repoRoot, clusterDir)
    expect(outsideRes._tag).toBe("Invalid")

    const symlinkSubdir = join(backupDir, "linked-sub")
    symlinkSync(outsideDir, symlinkSubdir)
    writeFileSync(
      join(backupDir, "pending-workflow-restore.json"),
      JSON.stringify({
        backupFile: join(symlinkSubdir, "escaped.ndjson"),
        timestampMs: 1000,
        sha256: outsideSha,
        entityCount: 1,
        clusterRootDir: clusterDir,
        preRebuildConfigStamp: null,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    )
    const symlinkEscapeRes = readPendingWorkflowRestoreJournal(repoRoot, clusterDir)
    expect(symlinkEscapeRes._tag).toBe("Invalid")
    rmSync(join(backupDir, "pending-workflow-restore.json"), { force: true })

    // 2. Empty backup file with valid SHA-256 while journal declares entityCount=2 MUST fail runWorkflowRestoreAfterRebuild & keep journal
    const drift = await Effect.runPromise(evaluateClusterConfigDrift(clusterDir, configDir, false))
    writeClusterDriftReceipts(clusterDir, drift.expectedStamp, configDir)
    const emptyBackupFile = WorkflowBackupFilePath.make(join(backupDir, "empty-spoof.ndjson"))
    writeFileSync(emptyBackupFile, "", { encoding: "utf8", mode: 0o600 })
    const emptySha = BackupFileHash.make(createHash("sha256").update("", "utf8").digest("hex"))
    const spoofedBackup = {
      _tag: "BackedUp" as const,
      backupFile: emptyBackupFile,
      timestampMs: WorkflowBackupTimestampMs.make(1001),
      sha256: emptySha,
      entityCount: WorkflowBackupCount.make(2),
    }
    expect(writePendingWorkflowRestoreJournal(repoRoot, spoofedBackup, clusterDir)._tag).toBe(
      "Success",
    )

    const emptyServer = createServer((req, res) => {
      const url = req.url ?? ""
      const headers = { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" } as const
      if (url === "/healthz") {
        res.writeHead(200, { "Omnigraph-Http-Api": "0.14" })
        res.end()
        return
      }
      if (url.includes("/queries/wf_count_all")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [{ totalMessages: 0 }], graphCommitId: "c1" }))
        return
      }
      if (url.includes("/queries/wf_count_replies")) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ rows: [{ totalReplies: 0 }], graphCommitId: "c1" }))
        return
      }
      res.writeHead(404, headers)
      res.end()
    })
    await new Promise<void>((resPromise, rejPromise) => {
      emptyServer.once("error", rejPromise)
      emptyServer.listen(0, "127.0.0.1", () => resPromise())
    })
    const emptyPort = (emptyServer.address() as AddressInfo).port
    const canonicalRoot = resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo)
    writeFileSync(
      join(clusterDir, "server.json"),
      JSON.stringify({
        pid: process.pid,
        port: emptyPort,
        baseUrl: `http://127.0.0.1:${emptyPort}`,
        canonicalRepoRoot: canonicalRoot,
        updatedAt: null,
      }),
      "utf8",
    )

    try {
      const spoofOk = await Effect.runPromise(
        runWorkflowRestoreAfterRebuild({
          clusterRepoRoot: repoRoot,
          clusterRootDir: clusterDir,
          baseUrl: `http://127.0.0.1:${emptyPort}`,
          backup: spoofedBackup,
        }),
      )
      expect(spoofOk).toBe(false)
      expect(readPendingWorkflowRestoreJournal(repoRoot, clusterDir)._tag).toBe("Some")

      // 3. NoOp pending restore MUST fail closed when daemon.lock is already held
      const validBackup = makeVerifiedBackupFile(repoRoot)
      const postDigest = readClusterConfigStampDigest(clusterDir)
      writePendingWorkflowRestoreJournal(repoRoot, validBackup, clusterDir, postDigest, postDigest)
      const lockFilePath = join(repoRoot, ".git", "harness", "daemon.lock")
      await spawnFlockHolder(lockFilePath)

      const prevUrl = process.env.OMNIGRAPH_URL
      Reflect.deleteProperty(process.env, "OMNIGRAPH_URL")
      try {
        const blockedByDaemonLock = await Effect.runPromise(ensureLocalOmnigraphReady(repoRoot))
        expect(blockedByDaemonLock).toBe(false)
        expect(readPendingWorkflowRestoreJournal(repoRoot, clusterDir)._tag).toBe("Some")
      } finally {
        if (prevUrl !== undefined) process.env.OMNIGRAPH_URL = prevUrl
      }
    } finally {
      emptyServer.closeAllConnections()
      emptyServer.close()
    }

    // 4. Symlink checks on auth-tokens.json, server.json, and .config-stamp fail closed
    const secretTarget = join(outsideDir, "real-secret.txt")
    writeFileSync(
      secretTarget,
      JSON.stringify({ schemaVersion: 1, cliToken: "t1", mcpToken: "t2" }),
      "utf8",
    )
    chmodSync(secretTarget, 0o600)
    const symClusterDir = join(outsideDir, "sym-cluster")
    mkdirSync(symClusterDir, { recursive: true })
    symlinkSync(secretTarget, join(symClusterDir, "auth-tokens.json"))
    symlinkSync(secretTarget, join(symClusterDir, "server.json"))
    symlinkSync(secretTarget, join(symClusterDir, ".config-stamp"))

    match(ensureOmnigraphEndpointTokens(symClusterDir))
      .with({ _tag: "Success" }, () => expect.fail("Expected symlink check failure"))
      .with({ _tag: "Failure" }, ({ failure }) => {
        expect(failure).toBeInstanceOf(Error)
        expect(failure.message.length).toBeGreaterThan(0)
      })
      .exhaustive()
    const symServerMeta = readOmnigraphServerMetaChecked(symClusterDir)
    expect(symServerMeta.corruptOrUnreadable).toBe(true)
    expect(symServerMeta.serverMeta).toBeUndefined()
    expect(readClusterConfigStampDigest(symClusterDir)).toBeNull()
  })
})
