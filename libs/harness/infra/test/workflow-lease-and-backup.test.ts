import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  BackupDirPath,
  BackupFileHash,
  encodeSeqKey,
  GitCommonDirPath,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  LeaseHolderPid,
  type SeqKey,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkspaceFsError,
  WriterLeaseHeldError,
} from "@harness/contract"
import { makeWorkflowOmnigraphClient, OmnigraphClient } from "@harness/graph"
import { WorkflowGraphBackup } from "@harness/service"
import {
  acquireWriterLease,
  invokeWorkflowStoreQuery,
  runOfflineWorkflowMaintenance,
  WRITER_LEASE_HEARTBEAT_TTL_MS,
} from "../src/index.js"
import { makeWorkflowGraphBackupLayer } from "../src/workflow-graph-backup.js"
import { refreshWriterLease, stopFlockChild, withAdvisoryFlock } from "../src/writer-lease.js"

const graphConfigDir = resolve(import.meta.dirname, "../../graph")
const omnigraphBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")
const omnigraphServerBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph-server")

const allocateLoopbackPort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.unref()
    server.on("error", rejectPort)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr === null || typeof addr === "string") {
        server.close(() => rejectPort(new Error("failed to allocate ephemeral port")))
        return
      }
      const { port } = addr
      server.close((err) => {
        if (err) {
          rejectPort(err)
          return
        }
        resolvePort(port)
      })
    })
  })

const unlockClusterIfLocked = (clusterDir: string, applyStdout: string): void => {
  const lockIds = new Set<string>()
  for (const m of applyStdout.matchAll(/Admission lock:\s*([A-Z0-9._-]+)/gi)) {
    if (m[1]) {
      lockIds.add(m[1])
    }
  }
  const lockJsonPath = join(clusterDir, "__cluster", "lock.json")
  if (existsSync(lockJsonPath)) {
    const parsed = JSON.parse(readFileSync(lockJsonPath, "utf8")) as Record<string, unknown>
    for (const key of ["lock_id", "id", "lockId"]) {
      const val = parsed[key]
      if (typeof val === "string" && val.length > 0) {
        lockIds.add(val)
      }
    }
  }
  for (const lockId of lockIds) {
    execFileSync(
      omnigraphBin,
      ["cluster", "force-unlock", lockId, "--target", `file://${clusterDir}`],
      { encoding: "utf8" },
    )
  }
}

const waitForServerReady = async (baseUrl: string, proc: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`omnigraph-server exited early with code ${proc.exitCode}`)
    }
    try {
      const res = await fetch(`${baseUrl}/readyz`)
      if (res.ok) {
        const body = (await res.json()) as { readonly ready?: boolean }
        if (body.ready === true) {
          return
        }
      }
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for omnigraph-server readiness at ${baseUrl}`)
}

const stopChildProcess = async (proc: ChildProcess | undefined): Promise<void> => {
  if (!proc || proc.exitCode !== null) {
    return
  }
  await new Promise<void>((resolveStop) => {
    const forceKillTimer = setTimeout(() => {
      if (proc.exitCode === null) {
        proc.kill("SIGKILL")
      }
    }, 3_000)
    proc.once("exit", () => {
      clearTimeout(forceKillTimer)
      resolveStop()
    })
    proc.kill("SIGTERM")
  })
}

const unwrapSeqKey = (value: string): SeqKey =>
  match(encodeSeqKey(value))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      throw new Error(failure)
    })
    .exhaustive()

const startClusterAndServer = async (
  clusterDir: string,
  cliToken: string,
): Promise<{ readonly baseUrl: string; readonly proc: ChildProcess; readonly port: number }> => {
  mkdirSync(clusterDir, { recursive: true })
  const applyOut = execFileSync(
    omnigraphBin,
    [
      "cluster",
      "apply",
      "--target",
      `file://${clusterDir}`,
      "--config",
      graphConfigDir,
      "--as",
      "harness-cli",
      "--json",
    ],
    { encoding: "utf8" },
  )
  unlockClusterIfLocked(clusterDir, applyOut)

  const port = await allocateLoopbackPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const proc = spawn(
    omnigraphServerBin,
    ["--cluster", `file://${clusterDir}`, "--bind", `127.0.0.1:${port}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OMNIGRAPH_EMBEDDINGS_MOCK: "1",
        OMNIGRAPH_EMBEDDING_API_KEY: "mock",
        OMNIGRAPH_SERVER_BEARER_TOKENS_JSON: JSON.stringify({
          "harness-cli": cliToken,
          "agent-mcp": "wf2-lease-mcp-token",
        }),
      },
    },
  )
  proc.stdout?.resume()
  proc.stderr?.resume()
  await waitForServerReady(baseUrl, proc)
  return { baseUrl, proc, port }
}

describe("WfWriterLease (flock + SIGKILL <1s takeover), WorkflowGraphBackup, and offline maintenance", () => {
  const tempDirs: Array<string> = []
  const cliToken = "wf2-lease-cli-token"
  let primaryClusterDir = ""
  let primaryBaseUrl = ""
  let primaryProc: ChildProcess | undefined
  let restoreProc: ChildProcess | undefined

  beforeAll(async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wf2-lease-backup-"))
    tempDirs.push(tempRoot)
    primaryClusterDir = join(tempRoot, "primary-cluster")
    const started = await startClusterAndServer(primaryClusterDir, cliToken)
    primaryBaseUrl = started.baseUrl
    primaryProc = started.proc
  }, 30_000)

  afterAll(async () => {
    await stopChildProcess(restoreProc)
    await stopChildProcess(primaryProc)
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("enforces exclusive OS flock contention, refresh fencing, and <1s SIGKILL crash takeover", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "wf2-lease-ws-"))
    tempDirs.push(wsRoot)
    const commonGitDir = GitCommonDirPath.make(join(wsRoot, ".git"))
    mkdirSync(commonGitDir, { recursive: true })
    const repoRoot = AbsoluteRepoRoot.make(wsRoot)
    const lockFilePath = LeaseFilePath.make(join(commonGitDir, "harness", "daemon.lock"))
    const client = makeWorkflowOmnigraphClient({ baseUrl: primaryBaseUrl, token: cliToken })

    const holder1 = LeaseHolderId.make("daemon-1")
    const holder2 = LeaseHolderId.make("daemon-2")
    const pid = LeaseHolderPid.make(process.pid)

    // 1. Initial lease acquisition -> epoch 1
    const handle1 = await Effect.runPromise(
      acquireWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: holder1,
        holderPid: pid,
        repoRoot,
        client,
      }),
    )
    expect(handle1.leaseEpoch).toBe(1)
    expect(existsSync(`${lockFilePath}.meta.json`)).toBe(true)

    // 2. Concurrent acquisition while held -> WriterLeaseHeldError
    const heldErr = await Effect.runPromise(
      acquireWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: holder2,
        holderPid: pid,
        repoRoot,
        client,
      }).pipe(Effect.flip),
    )
    match(heldErr)
      .with({ _tag: "WriterLeaseHeldError" }, (err) => {
        expect(err.holderId).toBe(holder1)
        expect(err.leaseEpoch).toBe(1)
        expect(err.holderPid).toBe(pid)
      })
      .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
        throw new Error(`Unexpected WorkflowStoreUnavailableError: ${err.message}`)
      })
      .exhaustive()

    // 3. Refresh succeeds on epoch 1, fails with WriterLeaseHeldError on stale epoch 0
    await Effect.runPromise(
      refreshWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: holder1,
        holderPid: pid,
        leaseEpoch: handle1.leaseEpoch,
        repoRoot,
        client,
      }),
    )
    const staleRefreshErr = await Effect.runPromise(
      refreshWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: holder1,
        holderPid: pid,
        leaseEpoch: LeaseEpoch.make(0),
        repoRoot,
        client,
      }).pipe(Effect.flip),
    )
    expect(staleRefreshErr).toBeInstanceOf(WriterLeaseHeldError)

    // 4. Clean release removes meta and frees OS flock -> immediate takeover at epoch 2
    await Effect.runPromise(handle1.release)
    expect(existsSync(`${lockFilePath}.meta.json`)).toBe(false)

    const handle2 = await Effect.runPromise(
      acquireWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: holder2,
        holderPid: pid,
        repoRoot,
        client,
      }),
    )
    expect(handle2.leaseEpoch).toBe(2)
    await Effect.runPromise(handle2.release)

    // 5. Simulate external OS process holding flock + fresh heartbeat, then SIGKILL -> < 1s takeover!
    const flockChild = spawn(
      "/usr/bin/flock",
      ["-n", "-F", "-E", "75", lockFilePath, "/usr/bin/cat"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    await new Promise<void>((resolveReady, rejectReady) => {
      flockChild.once("error", rejectReady)
      flockChild.stdout.once("data", () => resolveReady())
      flockChild.stdin.write("ready\n")
    })
    const crashedPid = flockChild.pid
    expect(typeof crashedPid).toBe("number")
    if (crashedPid === undefined) {
      throw new Error("missing flock child pid")
    }

    // Record crashed holder metadata + fresh Omnigraph heartbeat (0 ms old, well within 45s TTL)
    writeFileSync(
      `${lockFilePath}.meta.json`,
      JSON.stringify({
        holderId: "crashed-daemon",
        holderPid: crashedPid,
        leaseEpoch: 2,
        acquiredAtMs: Date.now(),
      }),
      "utf8",
    )
    await invokeWorkflowStoreQuery({
      repoRoot,
      operation: WorkflowStoreOperation.make("test.setCrashedLease"),
      queryName: WorkflowStoreOperation.make("wf_cas_writer_lease"),
      params: {
        name: "engine",
        expectedEpoch: 2,
        owner: `crashed-daemon#${crashedPid}`,
        nextEpoch: 3,
        heartbeatMs: Date.now(),
      },
      expectMutation: true,
      client,
    }).pipe(Effect.runPromise)

    // While child holds flock, acquire fails with WriterLeaseHeldError
    const whileAliveErr = await Effect.runPromise(
      acquireWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: LeaseHolderId.make("recovery-daemon"),
        holderPid: pid,
        repoRoot,
        client,
      }).pipe(Effect.flip),
    )
    expect(whileAliveErr).toBeInstanceOf(WriterLeaseHeldError)

    // Send SIGKILL to child holding flock, wait for OS exit, then acquire immediately!
    const exitPromise = new Promise<void>((resolveExit) => {
      flockChild.once("exit", () => resolveExit())
    })
    flockChild.kill("SIGKILL")
    await exitPromise

    const t0 = Date.now()
    const recovered = await Effect.runPromise(
      acquireWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: LeaseHolderId.make("recovery-daemon"),
        holderPid: pid,
        repoRoot,
        client,
      }),
    )
    const elapsedMs = Date.now() - t0
    expect(elapsedMs).toBeLessThan(1_000)
    expect(recovered.leaseEpoch).toBe(4)

    await Effect.runPromise(recovered.release)

    // 6. WRITER_LEASE_HEARTBEAT_TTL_MS boundary: 44_999ms rejected vs 45_000ms takeover
    const stalePid = 999_999
    const baseTtlMs = 2_000_000_000
    writeFileSync(
      `${lockFilePath}.meta.json`,
      JSON.stringify({
        holderId: "ttl-holder",
        holderPid: stalePid,
        leaseEpoch: 4,
        acquiredAtMs: baseTtlMs,
      }),
      "utf8",
    )
    await invokeWorkflowStoreQuery({
      repoRoot,
      operation: WorkflowStoreOperation.make("test.setTtlLease"),
      queryName: WorkflowStoreOperation.make("wf_cas_writer_lease"),
      params: {
        name: "engine",
        expectedEpoch: 4,
        owner: `ttl-holder#${stalePid}`,
        nextEpoch: 5,
        heartbeatMs: baseTtlMs,
      },
      expectMutation: true,
      client,
    }).pipe(Effect.runPromise)

    const beforeTtlErr = await Effect.runPromise(
      acquireWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: LeaseHolderId.make("ttl-contender"),
        holderPid: pid,
        repoRoot,
        client,
        nowMs: () => baseTtlMs + (WRITER_LEASE_HEARTBEAT_TTL_MS - 1),
        isPidAlive: () => true,
      }).pipe(Effect.flip),
    )
    match(beforeTtlErr)
      .with({ _tag: "WriterLeaseHeldError" }, (err) => {
        expect(err.holderId).toBe("ttl-holder")
        expect(err.leaseEpoch).toBe(5)
        expect(err.lockFilePath).toBe(lockFilePath)
      })
      .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
        throw new Error(`Unexpected WorkflowStoreUnavailableError: ${err.message}`)
      })
      .exhaustive()

    const atTtlHandle = await Effect.runPromise(
      acquireWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: LeaseHolderId.make("ttl-winner"),
        holderPid: pid,
        repoRoot,
        client,
        nowMs: () => baseTtlMs + WRITER_LEASE_HEARTBEAT_TTL_MS,
        isPidAlive: () => true,
      }),
    )
    expect(atTtlHandle.leaseEpoch).toBe(6)
    await Effect.runPromise(atTtlHandle.release)

    // 7. Same-PID container restart after SIGKILL takes over <1s even with live PID + fresh heartbeat
    const samePidNow = 3_000_000_000
    writeFileSync(
      `${lockFilePath}.meta.json`,
      JSON.stringify({
        holderId: "restarted-same-pid",
        holderPid: process.pid,
        leaseEpoch: 6,
        acquiredAtMs: samePidNow,
        holderStartTime: "999999999",
      }),
      "utf8",
    )
    await invokeWorkflowStoreQuery({
      repoRoot,
      operation: WorkflowStoreOperation.make("test.setSamePidLease"),
      queryName: WorkflowStoreOperation.make("wf_cas_writer_lease"),
      params: {
        name: "engine",
        expectedEpoch: 6,
        owner: `restarted-same-pid#${process.pid}@999999999`,
        nextEpoch: 7,
        heartbeatMs: samePidNow,
      },
      expectMutation: true,
      client,
    }).pipe(Effect.runPromise)

    const tSame0 = Date.now()
    const samePidTakeover = await Effect.runPromise(
      acquireWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: LeaseHolderId.make("restarted-same-pid"),
        holderPid: pid,
        repoRoot,
        client,
        nowMs: () => samePidNow + 100,
        isPidAlive: () => true,
      }),
    )
    expect(Date.now() - tSame0).toBeLessThan(1_000)
    expect(samePidTakeover.leaseEpoch).toBe(8)
    await Effect.runPromise(samePidTakeover.release)

    // 8. stopFlockChild never hangs on an externally signal-killed child
    const killedCat = spawn("/usr/bin/cat", [], { stdio: ["pipe", "pipe", "pipe"] })
    const killedCatExit = new Promise<void>((resolveExit) => {
      killedCat.once("exit", () => resolveExit())
    })
    killedCat.kill("SIGKILL")
    await killedCatExit
    const stopStart = Date.now()
    await Effect.runPromise(stopFlockChild(killedCat))
    expect(Date.now() - stopStart).toBeLessThan(1_000)
  })

  it("exports deterministic SHA-256 NDJSON backups, restores onto a fresh cluster (merge & replace), and fails closed", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "wf2-backup-ws-"))
    tempDirs.push(wsRoot)
    const repoRoot = AbsoluteRepoRoot.make(wsRoot)
    const backupDir = BackupDirPath.make(join(wsRoot, "backups"))
    const primaryClient = makeWorkflowOmnigraphClient({ baseUrl: primaryBaseUrl, token: cliToken })

    // Populate WfMessage + WfReply rows on primary
    const m1 = "248476693641700001"
    const m2 = "248476693641700002"
    const r1 = "248476693641700003"
    const sk1 = unwrapSeqKey(m1)
    const sk2 = unwrapSeqKey(m2)
    const skr1 = unwrapSeqKey(r1)

    await primaryClient.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: m1,
        seqKey: sk1,
        primaryKeyHash: "backup-pk-1",
        shardId: "default:0",
        entityType: "BackupEntity",
        entityId: "b-1",
        tag: "Run",
        payload: JSON.stringify({ step: "one" }),
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: m1,
        deliverAtMs: null,
      },
    })
    await primaryClient.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: m2,
        seqKey: sk2,
        primaryKeyHash: null,
        shardId: "default:1",
        entityType: "BackupEntity",
        entityId: "b-2",
        tag: "Run",
        payload: JSON.stringify({ step: "two" }),
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: m2,
        deliverAtMs: null,
      },
    })
    await primaryClient.queries.invoke("wf_save_reply_exit", {
      branch: "main",
      expectMutation: true,
      params: {
        replyKey: r1,
        seqKey: skr1,
        requestId: m1,
        payload: JSON.stringify({ _tag: "Success", value: "ok" }),
      },
    })

    const primaryBackupLayer = makeWorkflowGraphBackupLayer({
      repoRoot,
      client: primaryClient,
      nowMs: () => 1_700_000_000_001,
    })

    const summary1 = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.exportBackup(backupDir)
      }).pipe(Effect.provide(primaryBackupLayer)),
    )
    expect(existsSync(summary1.backupFile)).toBe(true)
    expect(summary1.entityCount).toBeGreaterThanOrEqual(3)

    const rawFile = readFileSync(summary1.backupFile, "utf8")
    const expectedSha = createHash("sha256").update(rawFile, "utf8").digest("hex")
    expect(summary1.sha256).toBe(expectedSha)

    // Export again -> deterministic SHA-256 matches
    const summary2 = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.exportBackup(BackupDirPath.make(join(wsRoot, "backups-2")))
      }).pipe(Effect.provide(primaryBackupLayer)),
    )
    expect(summary2.sha256).toBe(summary1.sha256)

    // Restore onto a brand-new empty cluster
    const restoreClusterDir = join(wsRoot, "restore-cluster")
    const restoreStarted = await startClusterAndServer(restoreClusterDir, cliToken)
    restoreProc = restoreStarted.proc
    const restoreClient = makeWorkflowOmnigraphClient({
      baseUrl: restoreStarted.baseUrl,
      token: cliToken,
    })
    const restoreBackupLayer = makeWorkflowGraphBackupLayer({
      repoRoot,
      client: restoreClient,
    })

    const mergeRestore = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({
          backupFile: summary1.backupFile,
          mode: "merge",
        })
      }).pipe(Effect.provide(restoreBackupLayer)),
    )
    expect(mergeRestore.restoredEntityCount).toBe(summary1.entityCount)
    expect(mergeRestore.sha256).toBe(summary1.sha256)

    const countAfterMerge = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.countMerge"),
        queryName: WorkflowStoreOperation.make("wf_count_all"),
        params: {},
        client: restoreClient,
      }),
    )
    expect(countAfterMerge[0]?.totalMessages).toBe(2)

    // Add an extra message on restore target, then restore with mode: "replace" -> exact count restored
    const extraId = "248476693641700099"
    const extraSk = unwrapSeqKey(extraId)
    await restoreClient.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: extraId,
        seqKey: extraSk,
        primaryKeyHash: null,
        shardId: "default:0",
        entityType: "ExtraEntity",
        entityId: "extra-1",
        tag: "Run",
        payload: "{}",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: extraId,
        deliverAtMs: null,
      },
    })

    const replaceRestore = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({
          backupFile: summary1.backupFile,
          mode: "replace",
        })
      }).pipe(Effect.provide(restoreBackupLayer)),
    )
    expect(replaceRestore.restoredEntityCount).toBe(summary1.entityCount)

    const countAfterReplace = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.countReplace"),
        queryName: WorkflowStoreOperation.make("wf_count_all"),
        params: {},
        client: restoreClient,
      }),
    )
    expect(countAfterReplace[0]?.totalMessages).toBe(2)

    // Fail-closed checks: missing file, corrupt NDJSON, unreachable server
    const missingErr = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({
          backupFile: WorkflowBackupFilePath.make(join(wsRoot, "missing.ndjson")),
          mode: "merge",
        })
      }).pipe(Effect.provide(restoreBackupLayer), Effect.flip),
    )
    expect(missingErr).toBeInstanceOf(WorkspaceFsError)

    const corruptPath = WorkflowBackupFilePath.make(join(wsRoot, "corrupt.ndjson"))
    writeFileSync(corruptPath, "{corrupt-line\n", "utf8")
    const corruptErr = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({
          backupFile: corruptPath,
          mode: "merge",
        })
      }).pipe(Effect.provide(restoreBackupLayer), Effect.flip),
    )
    expect(corruptErr).toBeInstanceOf(WorkspaceFsError)

    // expectedSha256 mismatch MUST fail BEFORE calling og.load
    let ogLoadCalled = false
    const spyClient = new Proxy(restoreClient, {
      get(target, prop, receiver) {
        if (prop === "load") {
          return (...args: Parameters<typeof target.load>) => {
            ogLoadCalled = true
            return target.load(...args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const spyBackupLayer = makeWorkflowGraphBackupLayer({ repoRoot, client: spyClient })
    const shaMismatchErr = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({
          backupFile: summary1.backupFile,
          mode: "merge",
          expectedSha256: BackupFileHash.make("0".repeat(64)),
        })
      }).pipe(Effect.provide(spyBackupLayer), Effect.flip),
    )
    expect(shaMismatchErr).toBeInstanceOf(WorkspaceFsError)
    expect(ogLoadCalled).toBe(false)

    const deadPort = await allocateLoopbackPort()
    const deadBackupLayer = makeWorkflowGraphBackupLayer({
      repoRoot,
      client: new OmnigraphClient({
        baseUrl: `http://127.0.0.1:${deadPort}`,
        graphId: "harness-workflows",
        token: cliToken,
      }),
    })
    const deadExportErr = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.exportBackup(backupDir)
      }).pipe(Effect.provide(deadBackupLayer), Effect.flip),
    )
    expect(deadExportErr).toBeInstanceOf(WorkflowStoreUnavailableError)

    await stopChildProcess(restoreProc)
    restoreProc = undefined
  }, 30_000)

  it("runs offline optimize, cleanup --keep <n> --confirm, and force-unlock while refusing live server or held daemon.lock", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "wf2-maint-ws-"))
    tempDirs.push(wsRoot)
    const commonGitDir = GitCommonDirPath.make(join(wsRoot, ".git"))
    mkdirSync(commonGitDir, { recursive: true })
    const repoRoot = AbsoluteRepoRoot.make(wsRoot)
    const backupDir = BackupDirPath.make(join(wsRoot, "maint-backups"))
    const maintClusterDir = join(wsRoot, "maint-cluster")
    const lockFilePath = LeaseFilePath.make(join(commonGitDir, "harness", "daemon.lock"))

    const started = await startClusterAndServer(maintClusterDir, cliToken)
    let maintProc: ChildProcess | undefined = started.proc
    const client = makeWorkflowOmnigraphClient({ baseUrl: started.baseUrl, token: cliToken })

    try {
      // Create 20 commits + updates so Lance builds multiple dataset versions/fragments to compact & prune
      for (let i = 0; i < 20; i += 1) {
        const id = String(248476693641800000n + BigInt(i))
        const sk = unwrapSeqKey(id)
        await client.queries.invoke("wf_insert_request_message", {
          branch: "main",
          expectMutation: true,
          params: {
            messageKey: id,
            seqKey: sk,
            primaryKeyHash: null,
            shardId: "default:0",
            entityType: "MaintEntity",
            entityId: `m-${i}`,
            tag: "Run",
            payload: JSON.stringify({ idx: i, pad: "x".repeat(512) }),
            headers: "{}",
            traceId: null,
            spanId: null,
            sampled: null,
            requestId: id,
            deliverAtMs: null,
          },
        })
        await client.queries.invoke("wf_claim_messages", {
          branch: "main",
          expectMutation: true,
          params: {
            messageKeys: [id],
            nowMs: Date.now(),
          },
        })
      }

      // 1. Refuse if server.json points to a live PID
      writeFileSync(
        join(maintClusterDir, "server.json"),
        JSON.stringify({
          pid: maintProc.pid,
          port: started.port,
          baseUrl: started.baseUrl,
          canonicalRepoRoot: wsRoot,
          updatedAt: new Date().toISOString(),
        }),
        "utf8",
      )
      const liveServerErr = await Effect.runPromise(
        runOfflineWorkflowMaintenance({
          repoRoot,
          commonGitDir,
          backupDir,
          keepVersions: WorkflowBackupCount.make(1),
          clusterDir: maintClusterDir,
        }).pipe(Effect.flip),
      )
      expect(liveServerErr).toBeInstanceOf(WorkflowStoreUnavailableError)

      // Stop omnigraph-server before offline maintenance
      await stopChildProcess(maintProc)
      maintProc = undefined

      // 2. Refuse if daemon.lock is held by an active writer
      const heldErr = await Effect.runPromise(
        withAdvisoryFlock(
          lockFilePath,
          runOfflineWorkflowMaintenance({
            repoRoot,
            commonGitDir,
            backupDir,
            keepVersions: WorkflowBackupCount.make(1),
            clusterDir: maintClusterDir,
          }).pipe(Effect.flip),
        ),
      )
      expect(heldErr).toBeInstanceOf(WorkflowStoreUnavailableError)

      // 3. Run offline maintenance cleanly with omitted keepVersions (defaults to DEFAULT_WORKFLOW_CLEANUP_KEEP_VERSIONS = 1)
      const summary = await Effect.runPromise(
        runOfflineWorkflowMaintenance({
          repoRoot,
          commonGitDir,
          backupDir,
          clusterDir: maintClusterDir,
        }),
      )
      expect(existsSync(summary.backupFile)).toBe(true)
      expect(summary.reclaimedBytes).toBeGreaterThan(0)
      expect(existsSync(join(maintClusterDir, "__cluster", "lock.json"))).toBe(false)

      // 4. Restart server on maintained cluster and verify all 15 rows remain intact
      const restartedPort = await allocateLoopbackPort()
      const restartedUrl = `http://127.0.0.1:${restartedPort}`
      maintProc = spawn(
        omnigraphServerBin,
        ["--cluster", `file://${maintClusterDir}`, "--bind", `127.0.0.1:${restartedPort}`],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            OMNIGRAPH_EMBEDDINGS_MOCK: "1",
            OMNIGRAPH_EMBEDDING_API_KEY: "mock",
            OMNIGRAPH_SERVER_BEARER_TOKENS_JSON: JSON.stringify({
              "harness-cli": cliToken,
              "agent-mcp": "wf2-lease-mcp-token",
            }),
          },
        },
      )
      await waitForServerReady(restartedUrl, maintProc)
      maintProc.stdout?.resume()
      maintProc.stderr?.resume()
      const restartedClient = makeWorkflowOmnigraphClient({
        baseUrl: restartedUrl,
        token: cliToken,
      })
      const countRows = await Effect.runPromise(
        invokeWorkflowStoreQuery({
          repoRoot,
          operation: WorkflowStoreOperation.make("test.afterMaint"),
          queryName: WorkflowStoreOperation.make("wf_count_all"),
          params: {},
          client: restartedClient,
        }),
      )
      expect(countRows[0]?.totalMessages).toBe(20)
    } finally {
      await stopChildProcess(maintProc)
    }
  }, 45_000)
})
