import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Fiber, Option, Tracer } from "effect"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  GitCommonDirPath,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  LeaseHolderPid,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
} from "@harness/contract"
import { makeWorkflowOmnigraphClient, type OmnigraphClient } from "@harness/graph"
import {
  acquireWriterLease,
  evaluateWriterLeaseTakeover,
  invokeWorkflowStoreQuery,
  type LeaseTakeoverEvaluationInput,
  WRITER_LEASE_HEARTBEAT_TTL_MS,
} from "../src/index.js"
import {
  acquireOmnigraphClusterLockEffect,
  releaseOmnigraphClusterLock,
} from "../src/workflow/cluster-startup-lock.js"
import { refreshWriterLease, stopFlockChild } from "../src/writer-lease.js"

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

const findChildPidsHoldingFile = (targetPath: string): ReadonlyArray<number> => {
  const matched: Array<number> = []
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const commEnd = stat.lastIndexOf(")")
      if (commEnd < 0) continue
      const ppid = Number(
        stat
          .slice(commEnd + 1)
          .trim()
          .split(/\s+/)[1],
      )
      if (ppid !== process.pid) continue
      for (const fd of readdirSync(`/proc/${entry}/fd`)) {
        try {
          if (readlinkSync(`/proc/${entry}/fd/${fd}`) === targetPath) {
            matched.push(Number(entry))
            break
          }
        } catch {
          // fd closed concurrently
        }
      }
    } catch {
      // process exited concurrently
    }
  }
  return matched
}

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

type InvokeQueryResult = Awaited<
  ReturnType<InstanceType<typeof OmnigraphClient>["queries"]["invoke"]>
>

const fakeReadResult = (
  queryName: string,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  graphCommitId: string | null = null,
): InvokeQueryResult => ({
  queryName,
  rowCount: rows.length,
  rows: [...rows],
  graphCommitId,
  target: { branch: "main" },
})

const fakeMutationResult = (
  queryName: string,
  affectedNodes: number,
  affectedEdges = 0,
): InvokeQueryResult => ({
  queryName,
  affectedNodes,
  affectedEdges,
  branch: "main",
  commit: null,
})

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

describe("WfWriterLease (scoped acquireRelease, split-brain fencing, CAS conflict, takeover matrix)", () => {
  const tempDirs: Array<string> = []
  const cliToken = "wf2-writer-lease-cli-token"
  let baseUrl = ""
  let serverProc: ChildProcess | undefined

  beforeAll(async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wf2-writer-lease-"))
    tempDirs.push(tempRoot)
    const clusterDir = join(tempRoot, "cluster")
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
    baseUrl = `http://127.0.0.1:${port}`
    serverProc = spawn(
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
            "agent-mcp": "wf2-writer-lease-mcp-token",
          }),
        },
      },
    )
    serverProc.stdout?.resume()
    serverProc.stderr?.resume()
    await waitForServerReady(baseUrl, serverProc)
  }, 30_000)

  afterAll(async () => {
    await stopChildProcess(serverProc)
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("enforces scoped acquireRelease, flock contention, split-brain refreshWriterLease, and <1s SIGKILL crash takeover", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "wf2-lease-ws-"))
    tempDirs.push(wsRoot)
    const commonGitDir = GitCommonDirPath.make(join(wsRoot, ".git"))
    mkdirSync(commonGitDir, { recursive: true })
    const repoRoot = AbsoluteRepoRoot.make(wsRoot)
    const lockFilePath = LeaseFilePath.make(join(commonGitDir, "harness", "daemon.lock"))
    const client = makeWorkflowOmnigraphClient({ baseUrl, token: cliToken })

    const holder1 = LeaseHolderId.make("daemon-1")
    const holder2 = LeaseHolderId.make("daemon-2")
    const pid = LeaseHolderPid.make(process.pid)

    // 1. Scoped initial acquisition -> epoch 1, released automatically when scope closes
    const acquiredEpoch1 = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* acquireWriterLease({
            commonGitDir,
            lockFilePath,
            holderId: holder1,
            holderPid: pid,
            repoRoot,
            client,
          })
          expect(lease.leaseEpoch).toBe(1)
          expect(existsSync(`${lockFilePath}.meta.json`)).toBe(true)

          // 2. Concurrent acquisition while held -> WriterLeaseHeldError
          const heldErr = yield* acquireWriterLease({
            commonGitDir,
            lockFilePath,
            holderId: holder2,
            holderPid: pid,
            repoRoot,
            client,
          }).pipe(Effect.flip)
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
          yield* refreshWriterLease({
            commonGitDir,
            lockFilePath,
            holderId: holder1,
            holderPid: pid,
            leaseEpoch: lease.leaseEpoch,
            repoRoot,
            client,
          })
          const staleRefreshErr = yield* refreshWriterLease({
            commonGitDir,
            lockFilePath,
            holderId: holder1,
            holderPid: pid,
            leaseEpoch: LeaseEpoch.make(0),
            repoRoot,
            client,
          }).pipe(Effect.flip)
          expect(staleRefreshErr).toBeInstanceOf(WriterLeaseHeldError)
          return lease.leaseEpoch
        }),
      ),
    )
    expect(acquiredEpoch1).toBe(1)
    expect(existsSync(`${lockFilePath}.meta.json`)).toBe(false)

    // 4. F-17.1: Second writer takes over at epoch 2; original writer's split-brain refresh fails with WriterLeaseHeldError
    const epoch2 = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease2 = yield* acquireWriterLease({
            commonGitDir,
            lockFilePath,
            holderId: holder2,
            holderPid: pid,
            repoRoot,
            client,
          })
          expect(lease2.leaseEpoch).toBe(2)

          const splitBrainRefreshErr = yield* refreshWriterLease({
            commonGitDir,
            lockFilePath,
            holderId: holder1,
            holderPid: pid,
            leaseEpoch: acquiredEpoch1,
            repoRoot,
            client,
          }).pipe(Effect.flip)
          match(splitBrainRefreshErr)
            .with({ _tag: "WriterLeaseHeldError" }, (err) => {
              expect(err.holderId).toBe(holder2)
              expect(err.leaseEpoch).toBe(2)
              expect(err.holderPid).toBe(pid)
            })
            .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
              throw new Error(`Unexpected WorkflowStoreUnavailableError: ${err.message}`)
            })
            .exhaustive()
          return lease2.leaseEpoch
        }),
      ),
    )
    expect(epoch2).toBe(2)

    // 5. External flock child + fresh heartbeat -> SIGKILL -> < 1s takeover
    const flockChild = spawn(
      "/usr/bin/flock",
      ["-n", "-F", "-E", "75", lockFilePath, "/usr/bin/cat"],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    await new Promise<void>((resolveReady, rejectReady) => {
      flockChild.once("error", rejectReady)
      flockChild.stdout.once("data", () => resolveReady())
      flockChild.stdin.write("ready\n")
    })
    const crashedPid = flockChild.pid!
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
    await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.setCrashedLease"),
        queryName: "wf_cas_writer_lease",
        params: {
          name: "engine",
          expectedEpoch: LeaseEpoch.make(2),
          owner: `crashed-daemon#${crashedPid}`,
          nextEpoch: LeaseEpoch.make(3),
          heartbeatMs: Date.now(),
        },
        expectMutation: true,
        client,
      }),
    )

    const whileAliveErr = await Effect.runPromise(
      Effect.scoped(
        acquireWriterLease({
          commonGitDir,
          lockFilePath,
          holderId: LeaseHolderId.make("recovery-daemon"),
          holderPid: pid,
          repoRoot,
          client,
        }),
      ).pipe(Effect.flip),
    )
    expect(whileAliveErr).toBeInstanceOf(WriterLeaseHeldError)

    const exitPromise = new Promise<void>((resolveExit) => {
      flockChild.once("exit", () => resolveExit())
    })
    flockChild.kill("SIGKILL")
    await exitPromise

    const t0 = Date.now()
    const recoveredEpoch = await Effect.runPromise(
      Effect.scoped(
        acquireWriterLease({
          commonGitDir,
          lockFilePath,
          holderId: LeaseHolderId.make("recovery-daemon"),
          holderPid: pid,
          repoRoot,
          client,
        }).pipe(Effect.map((l) => l.leaseEpoch)),
      ),
    )
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(recoveredEpoch).toBe(4)

    // 6. TTL boundary: 44_999ms rejected vs 45_000ms takeover
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
    await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.setTtlLease"),
        queryName: "wf_cas_writer_lease",
        params: {
          name: "engine",
          expectedEpoch: LeaseEpoch.make(4),
          owner: `ttl-holder#${stalePid}`,
          nextEpoch: LeaseEpoch.make(5),
          heartbeatMs: baseTtlMs,
        },
        expectMutation: true,
        client,
      }),
    )

    const beforeTtlErr = await Effect.runPromise(
      Effect.scoped(
        acquireWriterLease({
          commonGitDir,
          lockFilePath,
          holderId: LeaseHolderId.make("ttl-contender"),
          holderPid: pid,
          repoRoot,
          client,
          nowMs: () => baseTtlMs + (WRITER_LEASE_HEARTBEAT_TTL_MS - 1),
          isPidAlive: () => true,
        }),
      ).pipe(Effect.flip),
    )
    expect(beforeTtlErr).toBeInstanceOf(WriterLeaseHeldError)

    const atTtlEpoch = await Effect.runPromise(
      Effect.scoped(
        acquireWriterLease({
          commonGitDir,
          lockFilePath,
          holderId: LeaseHolderId.make("ttl-winner"),
          holderPid: pid,
          repoRoot,
          client,
          nowMs: () => baseTtlMs + WRITER_LEASE_HEARTBEAT_TTL_MS,
          isPidAlive: () => true,
        }).pipe(Effect.map((l) => l.leaseEpoch)),
      ),
    )
    expect(atTtlEpoch).toBe(6)

    // 7. Same-PID container restart <1s takeover
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
    await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.setSamePidLease"),
        queryName: "wf_cas_writer_lease",
        params: {
          name: "engine",
          expectedEpoch: LeaseEpoch.make(6),
          owner: `restarted-same-pid#${process.pid}@999999999`,
          nextEpoch: LeaseEpoch.make(7),
          heartbeatMs: samePidNow,
        },
        expectMutation: true,
        client,
      }),
    )
    const tSame0 = Date.now()
    const samePidEpoch = await Effect.runPromise(
      Effect.scoped(
        acquireWriterLease({
          commonGitDir,
          lockFilePath,
          holderId: LeaseHolderId.make("restarted-same-pid"),
          holderPid: pid,
          repoRoot,
          client,
          nowMs: () => samePidNow + 100,
          isPidAlive: () => true,
        }).pipe(Effect.map((l) => l.leaseEpoch)),
      ),
    )
    expect(Date.now() - tSame0).toBeLessThan(1_000)
    expect(samePidEpoch).toBe(8)

    // 8. stopFlockChild never hangs on externally SIGKILLed child
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

  it("F-17.2/F-3.2/F-3.3/F-4.2: fails closed on CAS epoch conflict, corrupt lease state, insert 0 nodes, and missing-meta fresh-heartbeat leases", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "wf2-lease-cas-"))
    tempDirs.push(wsRoot)
    const commonGitDir = GitCommonDirPath.make(join(wsRoot, ".git"))
    mkdirSync(commonGitDir, { recursive: true })
    const repoRoot = AbsoluteRepoRoot.make(wsRoot)
    const lockFilePath = LeaseFilePath.make(join(commonGitDir, "harness", "daemon.lock"))
    const baseClient = makeWorkflowOmnigraphClient({ baseUrl, token: cliToken })
    const pid = LeaseHolderPid.make(process.pid)
    const stalePid = 999_998
    const now = 4_000_000_000

    // F-4.2: wf_insert_writer_lease returning affectedNodes: 0 fails closed
    const insertZeroClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_get_writer_lease") {
        return fakeReadResult(name, [], "c1")
      }
      if (name === "wf_insert_writer_lease") {
        return fakeMutationResult(name, 0, 0)
      }
      return orig(name, input, opts)
    })
    const insertZeroErr = await Effect.runPromise(
      Effect.scoped(
        acquireWriterLease({
          commonGitDir,
          lockFilePath,
          holderId: LeaseHolderId.make("zero-insert"),
          holderPid: pid,
          repoRoot,
          client: insertZeroClient,
        }),
      ).pipe(Effect.flip),
    )
    expect(insertZeroErr).toBeInstanceOf(WorkflowStoreUnavailableError)

    // F-17.2: Concurrent CAS conflict during acquire -> WriterLeaseHeldError with winning holder
    let casConflictInjected = false
    const casConflictClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_get_writer_lease") {
        return casConflictInjected
          ? fakeReadResult(
              name,
              [
                {
                  name: "engine",
                  owner: "concurrent-winner#777777",
                  leaseEpoch: 9,
                  heartbeatMs: now,
                },
              ],
              "c2",
            )
          : fakeReadResult(
              name,
              [
                {
                  name: "engine",
                  owner: `expired-holder#${stalePid}`,
                  leaseEpoch: 8,
                  heartbeatMs: now - WRITER_LEASE_HEARTBEAT_TTL_MS - 1_000,
                },
              ],
              "c1",
            )
      }
      if (name === "wf_cas_writer_lease") {
        casConflictInjected = true
        return fakeMutationResult(name, 0, 0)
      }
      return orig(name, input, opts)
    })
    const casErr = await Effect.runPromise(
      Effect.scoped(
        acquireWriterLease({
          commonGitDir,
          lockFilePath,
          holderId: LeaseHolderId.make("cas-loser"),
          holderPid: pid,
          repoRoot,
          client: casConflictClient,
          nowMs: () => now,
          isPidAlive: () => false,
        }),
      ).pipe(Effect.flip),
    )
    match(casErr)
      .with({ _tag: "WriterLeaseHeldError" }, (err) => {
        expect(err.holderId).toBe("concurrent-winner")
        expect(err.leaseEpoch).toBe(9)
        expect(err.holderPid).toBe(777777)
      })
      .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
        throw new Error(`Expected WriterLeaseHeldError on CAS conflict, got ${err.message}`)
      })
      .exhaustive()

    // F-3.3: !flockHeld && !metaPresent with live PID + fresh heartbeat MUST refuse takeover (never clobber!)
    rmSync(`${lockFilePath}.meta.json`, { force: true })
    const freshNoMetaClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
      if (name === "wf_get_writer_lease") {
        return fakeReadResult(
          name,
          [
            {
              name: "engine",
              owner: `active-other#${stalePid}`,
              leaseEpoch: 10,
              heartbeatMs: now - 1_000,
            },
          ],
          "c3",
        )
      }
      return orig(name, input, opts)
    })
    const missingMetaFreshErr = await Effect.runPromise(
      Effect.scoped(
        acquireWriterLease({
          commonGitDir,
          lockFilePath,
          holderId: LeaseHolderId.make("no-meta-contender"),
          holderPid: pid,
          repoRoot,
          client: freshNoMetaClient,
          nowMs: () => now,
          isPidAlive: () => true,
        }),
      ).pipe(Effect.flip),
    )
    expect(missingMetaFreshErr).toBeInstanceOf(WriterLeaseHeldError)

    // F-3.2: Corrupt WfWriterLease graph rows (epoch < 1, non-int, empty owner, invalid heartbeatMs) fail closed
    for (const corruptRow of [
      { name: "engine", owner: "bad#123", leaseEpoch: 0, heartbeatMs: now },
      { name: "engine", owner: "bad#123", leaseEpoch: 1.5, heartbeatMs: now },
      { name: "engine", owner: "", leaseEpoch: 1, heartbeatMs: now },
      { name: "engine", owner: "bad#123", leaseEpoch: 1, heartbeatMs: -5 },
    ]) {
      const corruptClient = wrapQueriesInvoke(baseClient, async (name, orig, input, opts) => {
        if (name === "wf_get_writer_lease") {
          return fakeReadResult(name, [corruptRow], "c4")
        }
        return orig(name, input, opts)
      })
      const corruptErr = await Effect.runPromise(
        Effect.scoped(
          acquireWriterLease({
            commonGitDir,
            lockFilePath,
            holderId: LeaseHolderId.make("corrupt-check"),
            holderPid: pid,
            repoRoot,
            client: corruptClient,
            nowMs: () => now,
          }),
        ).pipe(Effect.flip),
      )
      expect(corruptErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    }

    // F-3.2: Corrupt .meta.json file fails closed instead of treating corrupt meta as missing
    mkdirSync(join(commonGitDir, "harness"), { recursive: true })
    writeFileSync(
      `${lockFilePath}.meta.json`,
      JSON.stringify({ holderId: "bad", leaseEpoch: 0 }),
      "utf8",
    )
    const corruptMetaErr = await Effect.runPromise(
      Effect.scoped(
        acquireWriterLease({
          commonGitDir,
          lockFilePath,
          holderId: LeaseHolderId.make("corrupt-meta-check"),
          holderPid: pid,
          repoRoot,
          client: insertZeroClient,
        }),
      ).pipe(Effect.flip),
    )
    expect(corruptMetaErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    rmSync(`${lockFilePath}.meta.json`, { force: true })
  })

  it("F-17.3: exhaustive evaluateWriterLeaseTakeover matrix across flockHeld, metaState, pidAlive, samePidOrReused, staleByHeartbeat, and corrupt state", () => {
    const pid = LeaseHolderPid.make(4242)
    const cases: ReadonlyArray<{
      readonly label: string
      readonly input: LeaseTakeoverEvaluationInput
      readonly expected: "Allow" | "Held" | "Corrupt"
    }> = [
      {
        label: "corrupt meta always fails closed even when flock free and pid dead",
        input: {
          flockHeld: false,
          metaState: "corrupt",
          metaCorruptReason: "bad json",
          rowValid: true,
          oldPid: pid,
          pidAlive: false,
          samePidOrReused: false,
          staleByHeartbeat: true,
        },
        expected: "Corrupt",
      },
      {
        label: "corrupt graph row always fails closed",
        input: {
          flockHeld: false,
          metaState: "present",
          rowValid: false,
          rowCorruptReason: "epoch 0",
          oldPid: pid,
          pidAlive: false,
          samePidOrReused: false,
          staleByHeartbeat: true,
        },
        expected: "Corrupt",
      },
      {
        label: "flockHeld=true with meta missing refuses takeover",
        input: {
          flockHeld: true,
          metaState: "missing",
          rowValid: true,
          oldPid: pid,
          pidAlive: false,
          samePidOrReused: true,
          staleByHeartbeat: true,
        },
        expected: "Held",
      },
      {
        label: "flockHeld=true with meta present refuses takeover",
        input: {
          flockHeld: true,
          metaState: "present",
          rowValid: true,
          oldPid: pid,
          pidAlive: true,
          samePidOrReused: false,
          staleByHeartbeat: false,
        },
        expected: "Held",
      },
      {
        label:
          "flockHeld=false, meta missing, pid alive, same start time, fresh heartbeat refuses takeover",
        input: {
          flockHeld: false,
          metaState: "missing",
          rowValid: true,
          oldPid: pid,
          pidAlive: true,
          samePidOrReused: false,
          staleByHeartbeat: false,
        },
        expected: "Held",
      },
      {
        label: "flockHeld=false, meta missing, no oldPid, fresh heartbeat refuses takeover",
        input: {
          flockHeld: false,
          metaState: "missing",
          rowValid: true,
          oldPid: undefined,
          pidAlive: false,
          samePidOrReused: false,
          staleByHeartbeat: false,
        },
        expected: "Held",
      },
      {
        label: "flockHeld=false, meta missing, no oldPid, stale heartbeat allows takeover",
        input: {
          flockHeld: false,
          metaState: "missing",
          rowValid: true,
          oldPid: undefined,
          pidAlive: false,
          samePidOrReused: false,
          staleByHeartbeat: true,
        },
        expected: "Allow",
      },
      {
        label: "flockHeld=false, meta missing, pid dead allows takeover",
        input: {
          flockHeld: false,
          metaState: "missing",
          rowValid: true,
          oldPid: pid,
          pidAlive: false,
          samePidOrReused: false,
          staleByHeartbeat: false,
        },
        expected: "Allow",
      },
      {
        label:
          "flockHeld=false, meta present, pid alive, same start time, fresh heartbeat refuses takeover",
        input: {
          flockHeld: false,
          metaState: "present",
          rowValid: true,
          oldPid: pid,
          pidAlive: true,
          samePidOrReused: false,
          staleByHeartbeat: false,
        },
        expected: "Held",
      },
      {
        label:
          "flockHeld=false, meta present, pid alive, PID reused (different start time), fresh heartbeat allows takeover",
        input: {
          flockHeld: false,
          metaState: "present",
          rowValid: true,
          oldPid: pid,
          pidAlive: true,
          samePidOrReused: true,
          staleByHeartbeat: false,
        },
        expected: "Allow",
      },
      {
        label:
          "flockHeld=false, meta present, pid alive, same start time, stale heartbeat allows takeover",
        input: {
          flockHeld: false,
          metaState: "present",
          rowValid: true,
          oldPid: pid,
          pidAlive: true,
          samePidOrReused: false,
          staleByHeartbeat: true,
        },
        expected: "Allow",
      },
    ]

    for (const tc of cases) {
      const actual = evaluateWriterLeaseTakeover(tc.input)
      expect(actual._tag, tc.label).toBe(tc.expected)
    }
  })

  it("F-1.1: waitForFlockLoss stays pending during normal lease and scope close, and fires immediately on unexpected flock child exit", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "wf2-flock-loss-"))
    tempDirs.push(wsRoot)
    const commonGitDir = GitCommonDirPath.make(join(wsRoot, ".git"))
    mkdirSync(commonGitDir, { recursive: true })
    const repoRoot = AbsoluteRepoRoot.make(wsRoot)
    const lockFilePath = LeaseFilePath.make(join(commonGitDir, "harness", "daemon.lock"))
    const client = makeWorkflowOmnigraphClient({ baseUrl, token: cliToken })
    const pid = LeaseHolderPid.make(process.pid)

    // 1. Does NOT fire spuriously while held OR on normal scope close
    let normalCloseLossObserved = false
    let capturedWaitForLoss: Effect.Effect<void> | undefined
    await Effect.runPromise(
      Effect.gen(function* () {
        const leaseRef = yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* acquireWriterLease({
              commonGitDir,
              lockFilePath,
              holderId: LeaseHolderId.make("flock-loss-normal"),
              holderPid: pid,
              repoRoot,
              client,
            })
            const earlyWait = yield* Effect.timeoutOption(lease.waitForFlockLoss, "40 millis")
            expect(Option.isNone(earlyWait)).toBe(true)
            return { waitForFlockLoss: lease.waitForFlockLoss }
          }),
        )
        capturedWaitForLoss = leaseRef.waitForFlockLoss
        const postCloseWait = yield* Effect.timeoutOption(leaseRef.waitForFlockLoss, "40 millis")
        normalCloseLossObserved = match(postCloseWait)
          .with({ _tag: "Some" }, () => true)
          .with({ _tag: "None" }, () => false)
          .exhaustive()
      }),
    )
    expect(Effect.isEffect(capturedWaitForLoss)).toBe(true)
    expect(normalCloseLossObserved).toBe(false)

    // 2. Fires immediately when the OS flock child exits unexpectedly before release
    const unexpectedLossObserved = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* acquireWriterLease({
            commonGitDir,
            lockFilePath,
            holderId: LeaseHolderId.make("flock-loss-killed"),
            holderPid: pid,
            repoRoot,
            client,
          })
          const watcher = yield* lease.waitForFlockLoss.pipe(Effect.as(true), Effect.forkChild)
          const childPids = findChildPidsHoldingFile(lockFilePath)
          expect(childPids.length).toBeGreaterThanOrEqual(1)
          for (const childPid of childPids) {
            process.kill(childPid, "SIGKILL")
          }
          const fired = yield* Fiber.join(watcher).pipe(Effect.timeoutOption("2 seconds"))
          return Option.getOrElse(fired, () => false)
        }),
      ),
    )
    expect(unexpectedLossObserved).toBe(true)
  })

  it("refreshWriterLease fails with WriterLeaseHeldError when WfWriterLease row is missing, and emits WfWriterLease.refresh + OmnigraphCluster.acquireStartupLock spans", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "wf2-refresh-miss-"))
    tempDirs.push(wsRoot)
    const commonGitDir = GitCommonDirPath.make(join(wsRoot, ".git"))
    mkdirSync(commonGitDir, { recursive: true })
    const repoRoot = AbsoluteRepoRoot.make(wsRoot)
    const lockFilePath = LeaseFilePath.make(join(commonGitDir, "harness", "daemon.lock"))
    const baseClient = makeWorkflowOmnigraphClient({ baseUrl, token: cliToken })

    const missingRowClient = wrapQueriesInvoke(baseClient, async (name) => {
      if (name === "wf_refresh_writer_lease") {
        return fakeMutationResult(name, 0, 0)
      }
      if (name === "wf_get_writer_lease") {
        return fakeReadResult(name, [], "c-missing")
      }
      return fakeReadResult(name, [], "c-other")
    })

    const spanNames: Array<string> = []
    const testTracer = Tracer.make({
      span: (options) => {
        spanNames.push(options.name)
        return new Tracer.NativeSpan(options)
      },
    })

    const missingErr = await Effect.runPromise(
      refreshWriterLease({
        commonGitDir,
        lockFilePath,
        holderId: LeaseHolderId.make("refresh-holder"),
        holderPid: LeaseHolderPid.make(process.pid),
        leaseEpoch: LeaseEpoch.make(3),
        repoRoot,
        client: missingRowClient,
      }).pipe(Effect.provideService(Tracer.Tracer, testTracer), Effect.flip),
    )

    match(missingErr)
      .with({ _tag: "WriterLeaseHeldError" }, (err) => {
        expect(err.holderId).toBe("no-active-lease")
        expect(err.leaseEpoch).toBe(0)
        expect(err.lockFilePath).toBe(lockFilePath)
        expect(err.holderPid).toBeUndefined()
      })
      .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
        throw new Error(`Expected WriterLeaseHeldError on missing refresh row, got ${err.message}`)
      })
      .exhaustive()

    const lockHandle = await Effect.runPromise(
      acquireOmnigraphClusterLockEffect(join(wsRoot, "cluster-span"), { timeoutMs: 0 }).pipe(
        Effect.provideService(Tracer.Tracer, testTracer),
      ),
    )
    releaseOmnigraphClusterLock(lockHandle)

    expect(spanNames).toContain("WfWriterLease.refresh")
    expect(spanNames).toContain("OmnigraphCluster.acquireStartupLock")
  })
})
