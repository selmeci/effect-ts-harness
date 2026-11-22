import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
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
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Fiber, Schema } from "effect"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  BackupDirPath,
  BackupFileHash,
  encodeSeqKey,
  GitCommonDirPath,
  isPureInterruptCause,
  LeaseFilePath,
  MessageKey,
  ReplyKey,
  type SeqKey,
  WorkflowBackupFilePath,
  WorkflowCleanupKeepVersions,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkspaceFsError,
} from "@harness/contract"
import { makeWorkflowOmnigraphClient, OmnigraphClient } from "@harness/graph"
import { WorkflowGraphBackup } from "@harness/service"
import {
  invokeWorkflowStoreQuery,
  runOfflineWorkflowMaintenance,
  withAdvisoryFlock,
} from "../src/index.js"
import { isLocalPidAlive } from "../src/writer-lease.js"
import { makeWorkflowGraphBackupLayer } from "../src/workflow-graph-backup.js"

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
    if (m[1]) lockIds.add(m[1])
  }
  const lockJsonPath = join(clusterDir, "__cluster", "lock.json")
  if (existsSync(lockJsonPath)) {
    const parsed = JSON.parse(readFileSync(lockJsonPath, "utf8")) as Record<string, unknown>
    for (const key of ["lock_id", "id", "lockId"]) {
      const val = parsed[key]
      if (typeof val === "string" && val.length > 0) lockIds.add(val)
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
        if (body.ready === true) return
      }
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for omnigraph-server readiness at ${baseUrl}`)
}

const stopChildProcess = async (proc: ChildProcess | undefined): Promise<void> => {
  if (!proc || proc.exitCode !== null) return
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL")
    }, 3_000)
    proc.once("exit", () => {
      clearTimeout(timer)
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
          "agent-mcp": "wf2-backup-mcp-token",
        }),
      },
    },
  )
  proc.stdout?.resume()
  proc.stderr?.resume()
  await waitForServerReady(baseUrl, proc)
  return { baseUrl, proc, port }
}

const wrapQueriesInvoke = (
  client: InstanceType<typeof OmnigraphClient>,
  onInvoke: (
    name: string,
    orig: typeof client.queries.invoke,
    input?: Parameters<typeof client.queries.invoke>[1],
    opts?: Parameters<typeof client.queries.invoke>[2],
  ) => ReturnType<typeof client.queries.invoke>,
): InstanceType<typeof OmnigraphClient> =>
  new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "queries") {
        return new Proxy(target.queries, {
          get(qTarget, qProp, qReceiver) {
            if (qProp === "invoke") {
              return (
                name: string,
                input?: Parameters<typeof target.queries.invoke>[1],
                opts?: Parameters<typeof target.queries.invoke>[2],
              ) => onInvoke(name, qTarget.invoke.bind(qTarget), input, opts)
            }
            return Reflect.get(qTarget, qProp, qReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })

describe("WorkflowGraphBackup (export, merge/replace, WfReply parity, partial-restore annotation) & offline maintenance", () => {
  const tempDirs: Array<string> = []
  const cliToken = "wf2-backup-cli-token"
  let primaryBaseUrl = ""
  let primaryProc: ChildProcess | undefined
  let restoreProc: ChildProcess | undefined

  beforeAll(async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wf2-backup-maint-"))
    tempDirs.push(tempRoot)
    const primaryClusterDir = join(tempRoot, "primary-cluster")
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

  const seedBackupSampleEntities = async (
    client: ReturnType<typeof makeWorkflowOmnigraphClient>,
  ) => {
    const m1 = MessageKey.make("248476693641700001")
    const m2 = MessageKey.make("248476693641700002")
    const r1 = ReplyKey.make("248476693641700003")

    await client.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: m1,
        seqKey: unwrapSeqKey(m1),
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
    await client.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: m2,
        seqKey: unwrapSeqKey(m2),
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
    await client.queries.invoke("wf_save_reply_exit", {
      branch: "main",
      expectMutation: true,
      params: {
        replyKey: r1,
        seqKey: unwrapSeqKey(r1),
        requestId: m1,
        payload: JSON.stringify({ _tag: "Success", value: "ok" }),
      },
    })
  }

  const wrapLoadSpy = (
    client: ReturnType<typeof makeWorkflowOmnigraphClient>,
    onLoad: () => void,
  ): ReturnType<typeof makeWorkflowOmnigraphClient> =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "load") {
          return (...args: Parameters<typeof target.load>) => {
            onLoad()
            return target.load(...args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

  it("exports deterministic SHA-256 backups, restores merge & replace (expectedSha256 + WfReply parity), and annotates partial-restore failures", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "wf2-backup-ws-"))
    tempDirs.push(wsRoot)
    const repoRoot = AbsoluteRepoRoot.make(wsRoot)
    const backupDir = BackupDirPath.make(join(wsRoot, "backups"))
    const primaryClient = makeWorkflowOmnigraphClient({ baseUrl: primaryBaseUrl, token: cliToken })
    await seedBackupSampleEntities(primaryClient)

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
    const restoreBackupLayer = makeWorkflowGraphBackupLayer({ repoRoot, client: restoreClient })

    const mergeRestore = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({ backupFile: summary1.backupFile, mode: "merge" })
      }).pipe(Effect.provide(restoreBackupLayer)),
    )
    expect(mergeRestore.restoredEntityCount).toBe(summary1.entityCount)
    expect(mergeRestore.sha256).toBe(summary1.sha256)

    const countAfterMerge = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.countMerge"),
        queryName: "wf_count_all",
        params: {},
        client: restoreClient,
      }),
    )
    expect(countAfterMerge[0]?.totalMessages).toBe(2)

    // Extra message on restore target -> mode: "replace" with expectedSha256 overwrites back to exact counts
    const extraId = MessageKey.make("248476693641700099")
    await restoreClient.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: extraId,
        seqKey: unwrapSeqKey(extraId),
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
          expectedSha256: summary1.sha256,
        })
      }).pipe(Effect.provide(restoreBackupLayer)),
    )
    expect(replaceRestore.restoredEntityCount).toBe(summary1.entityCount)

    const repliesAfterReplace = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.countRepliesAfterReplace"),
        queryName: "wf_count_replies",
        params: {},
        client: restoreClient,
      }),
    )
    expect(repliesAfterReplace[0]?.totalReplies).toBe(1)

    // F-6.1 & F-17.4: Empty backup with mode: "replace" MUST fail closed BEFORE calling og.load
    const emptyBackupPath = WorkflowBackupFilePath.make(join(wsRoot, "empty.ndjson"))
    writeFileSync(emptyBackupPath, "", "utf8")
    const emptySha = BackupFileHash.make(createHash("sha256").update("", "utf8").digest("hex"))
    let loadCallsOnEmpty = 0
    const spyEmptyClient = wrapLoadSpy(restoreClient, () => {
      loadCallsOnEmpty += 1
    })
    const emptyReplaceErr = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({
          backupFile: emptyBackupPath,
          mode: "replace",
          expectedSha256: emptySha,
        })
      }).pipe(
        Effect.provide(makeWorkflowGraphBackupLayer({ repoRoot, client: spyEmptyClient })),
        Effect.flip,
      ),
    )
    expect(emptyReplaceErr).toBeInstanceOf(WorkspaceFsError)
    expect(loadCallsOnEmpty).toBe(0)

    // F-6.2 & F-6.3 & F-17.4: Missing WfReply after og.load fails closed AND annotates partial-restore state
    const missingReplyClient = wrapQueriesInvoke(restoreClient, async (name, orig, input, opts) => {
      if (name === "wf_count_replies") {
        return {
          queryName: name,
          rowCount: 1,
          rows: [{ totalReplies: 0 }],
          graphCommitId: "c-miss-reply",
          target: { branch: "main" },
        }
      }
      return orig(name, input, opts)
    })
    const replyVerifyErr = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({
          backupFile: summary1.backupFile,
          mode: "replace",
          expectedSha256: summary1.sha256,
        })
      }).pipe(
        Effect.provide(makeWorkflowGraphBackupLayer({ repoRoot, client: missingReplyClient })),
        Effect.flip,
      ),
    )
    expect(replyVerifyErr).toBeInstanceOf(WorkspaceFsError)
    expect(replyVerifyErr.reason).toContain("og.load already ran")
    expect(replyVerifyErr.reason).toContain("partial-restore state")

    await stopChildProcess(restoreProc)
    restoreProc = undefined
  }, 30_000)

  it("rejects sha mismatch before og.load, missing files, corrupt NDJSON, and dead export servers", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "wf2-backup-neg-"))
    tempDirs.push(wsRoot)
    const repoRoot = AbsoluteRepoRoot.make(wsRoot)
    const backupDir = BackupDirPath.make(join(wsRoot, "backups"))
    const primaryClient = makeWorkflowOmnigraphClient({ baseUrl: primaryBaseUrl, token: cliToken })
    const primaryBackupLayer = makeWorkflowGraphBackupLayer({
      repoRoot,
      client: primaryClient,
      nowMs: () => 1_700_000_000_002,
    })

    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.exportBackup(backupDir)
      }).pipe(Effect.provide(primaryBackupLayer)),
    )

    let ogLoadCalled = false
    const spyClient = wrapLoadSpy(primaryClient, () => {
      ogLoadCalled = true
    })
    const shaMismatchErr = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({
          backupFile: summary.backupFile,
          mode: "merge",
          expectedSha256: BackupFileHash.make("0".repeat(64)),
        })
      }).pipe(
        Effect.provide(makeWorkflowGraphBackupLayer({ repoRoot, client: spyClient })),
        Effect.flip,
      ),
    )
    expect(shaMismatchErr).toBeInstanceOf(WorkspaceFsError)
    expect(ogLoadCalled).toBe(false)

    const missingErr = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({
          backupFile: WorkflowBackupFilePath.make(join(wsRoot, "missing.ndjson")),
          mode: "merge",
        })
      }).pipe(Effect.provide(primaryBackupLayer), Effect.flip),
    )
    expect(missingErr).toBeInstanceOf(WorkspaceFsError)

    const corruptPath = WorkflowBackupFilePath.make(join(wsRoot, "corrupt.ndjson"))
    writeFileSync(corruptPath, "{corrupt-line\n", "utf8")
    const corruptErr = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* WorkflowGraphBackup
        return yield* svc.restoreBackup({ backupFile: corruptPath, mode: "merge" })
      }).pipe(Effect.provide(primaryBackupLayer), Effect.flip),
    )
    expect(corruptErr).toBeInstanceOf(WorkspaceFsError)

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
  }, 30_000)

  it("runs offline maintenance, verifies safety export before cleanup, and preserves rows across restart", async () => {
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
      for (let i = 0; i < 20; i += 1) {
        const id = MessageKey.make(String(248476693641800000n + BigInt(i)))
        await client.queries.invoke("wf_insert_request_message", {
          branch: "main",
          expectMutation: true,
          params: {
            messageKey: id,
            seqKey: unwrapSeqKey(id),
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
          params: { messageKeys: [id], nowMs: Date.now() },
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
          keepVersions: WorkflowCleanupKeepVersions.make(1),
          clusterDir: maintClusterDir,
        }).pipe(Effect.flip),
      )
      expect(liveServerErr).toBeInstanceOf(WorkflowStoreUnavailableError)

      await stopChildProcess(maintProc)
      maintProc = undefined

      // F-5.2: Corrupt/undecodable server.json MUST fail closed
      writeFileSync(join(maintClusterDir, "server.json"), "{corrupt-server-json", "utf8")
      const corruptServerErr = await Effect.runPromise(
        runOfflineWorkflowMaintenance({
          repoRoot,
          commonGitDir,
          backupDir,
          clusterDir: maintClusterDir,
        }).pipe(Effect.flip),
      )
      expect(corruptServerErr).toBeInstanceOf(WorkflowStoreUnavailableError)
      rmSync(join(maintClusterDir, "server.json"), { force: true })

      // 2. Refuse if daemon.lock is held by an active writer
      const heldErr = await Effect.runPromise(
        withAdvisoryFlock(
          lockFilePath,
          runOfflineWorkflowMaintenance({
            repoRoot,
            commonGitDir,
            backupDir,
            keepVersions: WorkflowCleanupKeepVersions.make(1),
            clusterDir: maintClusterDir,
          }).pipe(Effect.flip),
        ),
      )
      expect(heldErr).toBeInstanceOf(WorkflowStoreUnavailableError)

      // 3. Run offline maintenance cleanly with omitted keepVersions (defaults to 1)
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

      // 4. Restart server on maintained cluster and verify all 20 rows remain intact
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
              "agent-mcp": "wf2-backup-mcp-token",
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
          queryName: "wf_count_all",
          params: {},
          client: restartedClient,
        }),
      )
      expect(countRows[0]?.totalMessages).toBe(20)
    } finally {
      await stopChildProcess(maintProc)
    }
  }, 45_000)

  it("aborts offline maintenance on foreign __cluster/lock.json, corrupt export NDJSON, active startup.lock, and symlink clusterDir, and unlocks run-created lock", async () => {
    // F-17.5 & F-20.3 & F-5.1: Stub omnigraph CLI tests for real __cluster/lock.json force-unlock,
    // pre-existing foreign admission lock abort, and corrupt export NDJSON abort before cleanup.
    const stubRoot = mkdtempSync(join(tmpdir(), "wf2-maint-stub-"))
    tempDirs.push(stubRoot)
    const stubGit = GitCommonDirPath.make(join(stubRoot, ".git"))
    const stubCluster = join(stubRoot, "cluster")
    const stubClusterMeta = join(stubCluster, "__cluster")
    const stubLockJson = join(stubClusterMeta, "lock.json")
    const stubBackupDir = BackupDirPath.make(join(stubRoot, "backups"))
    const stubLog = join(stubRoot, "invocations.log")
    mkdirSync(stubGit, { recursive: true })
    mkdirSync(stubClusterMeta, { recursive: true })

    const stubBin = join(stubRoot, "omnigraph-stub.sh")
    writeFileSync(
      stubBin,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${stubLog}'`,
        'if [ "$1" = "export" ]; then',
        `  if [ "${"${STUB_CORRUPT_EXPORT:-0}"}" = "1" ]; then printf '{not-valid-ndjson\\n'; exit 0; fi`,
        `  printf '{"type":"WfMessage","id":"1","data":{"messageKey":"1"}}\\n'`,
        `  printf '{"lock_id":"adm-run-99"}' > '${stubLockJson}'`,
        "  exit 0",
        "fi",
        'if [ "$1" = "cluster" ] && [ "$2" = "force-unlock" ]; then',
        `  rm -f '${stubLockJson}'`,
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      "utf8",
    )
    chmodSync(stubBin, 0o755)

    // F-20.3: Pre-existing __cluster/lock.json MUST abort without running export/cleanup/force-unlock
    writeFileSync(stubLockJson, JSON.stringify({ lock_id: "foreign-lock-1" }), "utf8")
    const foreignLockErr = await Effect.runPromise(
      runOfflineWorkflowMaintenance({
        repoRoot: AbsoluteRepoRoot.make(stubRoot),
        commonGitDir: stubGit,
        backupDir: stubBackupDir,
        omnigraphBin: stubBin,
        clusterDir: stubCluster,
      }).pipe(Effect.flip),
    )
    expect(foreignLockErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    expect(existsSync(stubLockJson)).toBe(true)
    expect(existsSync(stubLog)).toBe(false)
    rmSync(stubLockJson, { force: true })

    // F-5.1: Corrupt export NDJSON aborts BEFORE optimize / cleanup --confirm
    const corruptExportErr = await Effect.runPromise(
      runOfflineWorkflowMaintenance({
        repoRoot: AbsoluteRepoRoot.make(stubRoot),
        commonGitDir: stubGit,
        backupDir: stubBackupDir,
        omnigraphBin: stubBin,
        clusterDir: stubCluster,
        env: { STUB_CORRUPT_EXPORT: "1" },
      }).pipe(Effect.flip),
    )
    expect(corruptExportErr).toBeInstanceOf(WorkspaceFsError)
    const logAfterCorrupt = readFileSync(stubLog, "utf8")
    expect(logAfterCorrupt).not.toContain("cleanup")
    rmSync(stubLog, { force: true })

    // F-17.5: Maintenance-created __cluster/lock.json is unlocked via exact lock_id `adm-run-99`
    await Effect.runPromise(
      runOfflineWorkflowMaintenance({
        repoRoot: AbsoluteRepoRoot.make(stubRoot),
        commonGitDir: stubGit,
        backupDir: stubBackupDir,
        omnigraphBin: stubBin,
        clusterDir: stubCluster,
      }),
    )
    expect(existsSync(stubLockJson)).toBe(false)
    const invocations = readFileSync(stubLog, "utf8")
    expect(invocations).toContain("cluster force-unlock adm-run-99")

    // Active <clusterDir>.startup.lock MUST fail closed before touching daemon.lock or running omnigraph
    rmSync(stubLog, { force: true })
    const activeStartupLock = `${stubCluster}.startup.lock`
    writeFileSync(
      activeStartupLock,
      JSON.stringify({ pid: process.pid, lockToken: "live-holder", createdAtMs: Date.now() }),
      "utf8",
    )
    const contendedErr = await Effect.runPromise(
      runOfflineWorkflowMaintenance({
        repoRoot: AbsoluteRepoRoot.make(stubRoot),
        commonGitDir: stubGit,
        backupDir: stubBackupDir,
        omnigraphBin: stubBin,
        clusterDir: stubCluster,
      }).pipe(Effect.flip),
    )
    match(contendedErr)
      .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
        expect(err.reason).toContain("Cluster startup lock held")
      })
      .with({ _tag: "WorkspaceFsError" }, (err) => {
        throw new Error(`Expected WorkflowStoreUnavailableError, got ${err.message}`)
      })
      .exhaustive()
    expect(existsSync(stubLog)).toBe(false)
    rmSync(activeStartupLock, { force: true })

    // Symlink clusterDir MUST be refused fail-closed
    const symlinkCluster = join(stubRoot, "symlink-cluster")
    symlinkSync(stubCluster, symlinkCluster)
    const symlinkClusterErr = await Effect.runPromise(
      runOfflineWorkflowMaintenance({
        repoRoot: AbsoluteRepoRoot.make(stubRoot),
        commonGitDir: stubGit,
        backupDir: stubBackupDir,
        omnigraphBin: stubBin,
        clusterDir: symlinkCluster,
      }).pipe(Effect.flip),
    )
    match(symlinkClusterErr)
      .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
        expect(err.reason).toContain("Refusing symlink Omnigraph cluster directory")
      })
      .with({ _tag: "WorkspaceFsError" }, (err) => {
        throw new Error(`Expected WorkflowStoreUnavailableError, got ${err.message}`)
      })
      .exhaustive()
    expect(existsSync(stubLog)).toBe(false)
  }, 45_000)

  it("F-22: runOmnigraphCli interruption escalates SIGTERM -> SIGKILL and awaits child termination BEFORE force-unlock or fiber interrupt resolves", async () => {
    const stubRoot = mkdtempSync(join(tmpdir(), "wf2-maint-interrupt-"))
    tempDirs.push(stubRoot)
    const stubGit = GitCommonDirPath.make(join(stubRoot, ".git"))
    const stubCluster = join(stubRoot, "cluster")
    const stubClusterMeta = join(stubCluster, "__cluster")
    const stubLockJson = join(stubClusterMeta, "lock.json")
    const stubBackupDir = BackupDirPath.make(join(stubRoot, "backups"))
    const startedFile = join(stubRoot, "started.pid")
    const unlockEventFile = join(stubRoot, "unlock-event.json")
    mkdirSync(stubGit, { recursive: true })
    mkdirSync(stubClusterMeta, { recursive: true })

    const stubBin = join(stubRoot, "omnigraph-slow-stub.mjs")
    writeFileSync(
      stubBin,
      [
        `#!${process.execPath}`,
        'import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"',
        "const args = process.argv.slice(2)",
        'if (args[0] === "export") {',
        '  process.on("SIGTERM", () => {})',
        `  writeFileSync(${JSON.stringify(stubLockJson)}, JSON.stringify({ lock_id: "adm-interrupt-1" }), "utf8")`,
        `  writeFileSync(${JSON.stringify(startedFile)}, String(process.pid), "utf8")`,
        "  setInterval(() => {}, 1000)",
        '} else if (args[0] === "cluster" && args[1] === "force-unlock") {',
        `  const pidRaw = existsSync(${JSON.stringify(startedFile)}) ? Number(readFileSync(${JSON.stringify(startedFile)}, "utf8").trim()) : 0`,
        "  let childAliveAtUnlock = false",
        "  if (Number.isInteger(pidRaw) && pidRaw > 0) {",
        "    try { process.kill(pidRaw, 0); childAliveAtUnlock = true } catch { childAliveAtUnlock = false }",
        "  }",
        `  writeFileSync(${JSON.stringify(unlockEventFile)}, JSON.stringify({ childAliveAtUnlock, lockId: args[2] }), "utf8")`,
        `  rmSync(${JSON.stringify(stubLockJson)}, { force: true })`,
        "  process.exit(0)",
        "} else {",
        "  process.exit(0)",
        "}",
      ].join("\n"),
      "utf8",
    )
    chmodSync(stubBin, 0o755)

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* runOfflineWorkflowMaintenance({
          repoRoot: AbsoluteRepoRoot.make(stubRoot),
          commonGitDir: stubGit,
          backupDir: stubBackupDir,
          omnigraphBin: stubBin,
          clusterDir: stubCluster,
        }).pipe(Effect.forkChild)

        for (let i = 0; i < 100; i += 1) {
          if (existsSync(startedFile)) break
          yield* Effect.sleep("25 millis")
        }
        expect(existsSync(startedFile)).toBe(true)
        const childPid = Number(readFileSync(startedFile, "utf8").trim())
        expect(childPid).toBeGreaterThan(0)
        expect(isLocalPidAlive(childPid)).toBe(true)

        yield* Fiber.interrupt(fiber)
        // Child MUST already be dead the instant Fiber.interrupt resolves (no zombie race).
        expect(isLocalPidAlive(childPid)).toBe(false)
        return yield* Fiber.await(fiber)
      }),
    )

    match(exit)
      .with({ _tag: "Failure" }, ({ cause }) => {
        expect(isPureInterruptCause(cause)).toBe(true)
      })
      .with({ _tag: "Success" }, () => {
        expect.unreachable("Expected pure interrupt exit")
      })
      .exhaustive()

    expect(existsSync(unlockEventFile)).toBe(true)
    const unlockEvent = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          childAliveAtUnlock: Schema.Boolean,
          lockId: Schema.String,
        }),
      ),
    )(readFileSync(unlockEventFile, "utf8"))
    expect(unlockEvent.childAliveAtUnlock).toBe(false)
    expect(unlockEvent.lockId).toBe("adm-interrupt-1")
    expect(existsSync(stubLockJson)).toBe(false)
  }, 15_000)
})
