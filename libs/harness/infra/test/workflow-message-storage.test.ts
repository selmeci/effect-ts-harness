import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Option, Semaphore } from "effect"
import {
  EntityAddress,
  EntityId,
  EntityType,
  type Envelope,
  ShardId,
  Snowflake,
} from "effect/cluster"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  decodeSeqKey,
  encodeSeqKey,
  MessageKey,
  type SeqKey,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
} from "@harness/contract"
import { makeWorkflowOmnigraphClient, type OmnigraphClient } from "@harness/graph"
import {
  clearOmnigraphReplies,
  invokeWorkflowStoreQuery,
  makeOmnigraphEncodedDriver,
  WORKFLOW_MAX_CONCURRENT_HTTP,
  WORKFLOW_MAX_OCC_RETRIES,
} from "../src/index.js"
import {
  computePrimaryKeyHash,
  repairDanglingProcessedRequests,
} from "../src/omnigraph-message-storage.js"

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

const makeAddress = (group: string, id: number, entityType: string, entityId: string) =>
  EntityAddress.make({
    shardId: ShardId.make(group, id),
    entityType: EntityType.make(entityType),
    entityId: EntityId.make(entityId),
  })

const unwrapSeqKey = (value: bigint | string): SeqKey =>
  match(encodeSeqKey(value))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      throw new Error(failure)
    })
    .exhaustive()

const unwrapOption = <A>(opt: Option.Option<A>): A =>
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => {
      throw new Error("Expected Option.Some, got None")
    })
    .exhaustive()

const envelopeMessageId = (env: Envelope.Encoded): string =>
  match(env)
    .with({ _tag: "Request" }, (req) => req.requestId)
    .with({ _tag: "AckChunk" }, { _tag: "Interrupt" }, (ctrl) => ctrl.id)
    .exhaustive()

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

describe("OmnigraphMessageStorage core methods, D2 CAS, address pre-filtering, and concurrency", () => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  let repoRoot: AbsoluteRepoRoot
  const cliToken = "wf2-storage-cli-token"
  let nextSnowflake = 248476693641609216n

  const mintSnowflake = (): Snowflake.Snowflake => {
    nextSnowflake += 1n
    return Snowflake.Snowflake(nextSnowflake)
  }

  const createClient = () =>
    makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken })

  beforeAll(async () => {
    expect(existsSync(omnigraphBin)).toBe(true)
    expect(existsSync(omnigraphServerBin)).toBe(true)

    const tempRoot = mkdtempSync(join(tmpdir(), "wf2-msg-storage-"))
    tempDirs.push(tempRoot)
    repoRoot = AbsoluteRepoRoot.make(tempRoot)
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
    serverBaseUrl = `http://127.0.0.1:${port}`
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
            "agent-mcp": "wf2-storage-mcp-token",
          }),
        },
      },
    )
    serverProc.stdout?.resume()
    serverProc.stderr?.resume()
    await waitForServerReady(serverBaseUrl, serverProc)
  }, 30_000)

  afterAll(async () => {
    await stopChildProcess(serverProc)
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("supports all 13 MessageStorage.Encoded methods, PrimaryKeyHash, and lossless SeqKey > 2^53 ordering", async () => {
    const client = createClient()
    const driver = await Effect.runPromise(makeOmnigraphEncodedDriver(repoRoot, { client }))

    const big1 = 248476693641609216n
    const big2 = 248476693641609217n
    const sk1 = unwrapSeqKey(big1)
    const sk2 = unwrapSeqKey(big2)
    expect(sk1 < sk2).toBe(true)
    expect(decodeSeqKey(sk1)).toBe(big1)
    expect(decodeSeqKey(sk2)).toBe(big2)

    const reqId1 = mintSnowflake()
    const addr1 = makeAddress("default", 0, "MethodEntity", "m-1")
    const addr2 = makeAddress("default", 0, "MethodEntity", "m-2")
    const longPrimaryKey = `MethodEntity/m-1/Run/${"x".repeat(300)}`
    expect(computePrimaryKeyHash(longPrimaryKey).startsWith("sha256:")).toBe(true)

    const res1 = await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Request",
          requestId: String(reqId1),
          address: {
            shardId: { group: addr1.shardId.group, id: addr1.shardId.id },
            entityType: addr1.entityType,
            entityId: addr1.entityId,
          },
          tag: "Step",
          payload: { step: 1 },
          headers: { "x-trace": "t1" },
          traceId: "trace-1",
          spanId: "span-1",
          sampled: true,
        },
        primaryKey: longPrimaryKey,
        deliverAt: null,
      }),
    )
    expect(res1._tag).toBe("Success")

    const lookedUp = await Effect.runPromise(driver.requestIdForPrimaryKey(longPrimaryKey))
    expect(unwrapOption(lookedUp)).toBe(reqId1)

    const chunkId = mintSnowflake()
    await Effect.runPromise(
      driver.saveReply({
        _tag: "Chunk",
        id: String(chunkId),
        requestId: String(reqId1),
        sequence: 0,
        values: ["chunk-a"],
      }),
    )

    const dup = await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Request",
          requestId: String(mintSnowflake()),
          address: {
            shardId: { group: addr1.shardId.group, id: addr1.shardId.id },
            entityType: addr1.entityType,
            entityId: addr1.entityId,
          },
          tag: "Step",
          payload: { step: 1 },
          headers: {},
        },
        primaryKey: longPrimaryKey,
        deliverAt: null,
      }),
    )
    match(dup)
      .with({ _tag: "Success" }, () => {
        throw new Error("Expected Duplicate save result")
      })
      .with({ _tag: "Duplicate" }, (d) => {
        expect(d.originalId).toBe(reqId1)
        const reply = unwrapOption(d.lastReceivedReply)
        expect(reply.id).toBe(String(chunkId))
      })
      .exhaustive()

    const ackId = mintSnowflake()
    await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "AckChunk",
          id: String(ackId),
          requestId: String(reqId1),
          replyId: String(chunkId),
          address: {
            shardId: { group: addr1.shardId.group, id: addr1.shardId.id },
            entityType: addr1.entityType,
            entityId: addr1.entityId,
          },
        },
        primaryKey: null,
        deliverAt: null,
      }),
    )
    expect(await Effect.runPromise(driver.repliesFor([String(reqId1)]))).toHaveLength(0)
    expect(await Effect.runPromise(driver.repliesForUnfiltered([String(reqId1)]))).toHaveLength(1)

    const reqId2 = mintSnowflake()
    const delayedReqId = mintSnowflake()
    const now = Date.now()
    await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Request",
          requestId: String(reqId2),
          address: {
            shardId: { group: addr2.shardId.group, id: addr2.shardId.id },
            entityType: addr2.entityType,
            entityId: addr2.entityId,
          },
          tag: "Step",
          payload: { step: 2 },
          headers: {},
        },
        primaryKey: "short-pk-2",
        deliverAt: now - 1_000,
      }),
    )
    await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Request",
          requestId: String(delayedReqId),
          address: {
            shardId: { group: addr2.shardId.group, id: addr2.shardId.id },
            entityType: addr2.entityType,
            entityId: addr2.entityId,
          },
          tag: "Delayed",
          payload: {},
          headers: {},
        },
        primaryKey: null,
        deliverAt: now + 600_000,
      }),
    )

    const batch1 = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(addr1.shardId)], now, { limit: 2 }),
    )
    expect(batch1.map((b) => envelopeMessageId(b.envelope))).toEqual([
      String(reqId1),
      String(ackId),
    ])

    const batch2 = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(addr1.shardId)], now),
    )
    expect(batch2.map((b) => envelopeMessageId(b.envelope))).toEqual([String(reqId2)])

    const byId = await Effect.runPromise(
      driver.unprocessedMessagesById([reqId1, delayedReqId], now),
    )
    expect(byId.map((b) => envelopeMessageId(b.envelope))).toEqual([String(reqId1)])

    await Effect.runPromise(driver.resetRequests([reqId1]))
    const afterResetReq = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(addr1.shardId)], now, {
        addresses: [addr1],
      }),
    )
    expect(afterResetReq.some((m) => envelopeMessageId(m.envelope) === String(reqId1))).toBe(true)

    await Effect.runPromise(driver.resetAddresses([addr1, addr2]))
    await Effect.runPromise(driver.resetShards([ShardId.toString(addr1.shardId)]))
    expect(await Effect.runPromise(driver.withTransaction(Effect.succeed("tx-ok")))).toBe("tx-ok")

    const exitReplyId = mintSnowflake()
    await Effect.runPromise(
      driver.saveReply({
        _tag: "WithExit",
        id: String(exitReplyId),
        requestId: String(reqId1),
        exit: { _tag: "Success", value: { ok: true } },
      }),
    )
    const exitReplies = await Effect.runPromise(driver.repliesFor([String(reqId1)]))
    expect(exitReplies).toHaveLength(1)
    expect(exitReplies[0]?._tag).toBe("WithExit")

    await Effect.runPromise(driver.clearAddress(addr1))
    await Effect.runPromise(driver.clearAddress(addr2))
    const pkAfterClear = await Effect.runPromise(driver.requestIdForPrimaryKey(longPrimaryKey))
    expect(Option.isNone(pkAfterClear)).toBe(true)
  })

  it("enforces D2 CAS clearReplies, preserves kind=interrupt on expectedReplyId, and compensates Commit-2 failure", async () => {
    const client = createClient()
    const driver = await Effect.runPromise(makeOmnigraphEncodedDriver(repoRoot, { client }))

    const reqId = mintSnowflake()
    const exitId = mintSnowflake()
    const wrongExpectedExitId = mintSnowflake()
    const intrId = mintSnowflake()
    const addr = makeAddress("cas", 0, "CasEntity", "cas-1")

    await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Request",
          requestId: String(reqId),
          address: {
            shardId: { group: addr.shardId.group, id: addr.shardId.id },
            entityType: addr.entityType,
            entityId: addr.entityId,
          },
          tag: "Run",
          payload: { ok: 1 },
          headers: {},
        },
        primaryKey: null,
        deliverAt: null,
      }),
    )
    await Effect.runPromise(
      driver.saveReply({
        _tag: "WithExit",
        id: String(exitId),
        requestId: String(reqId),
        exit: { _tag: "Success", value: "done" },
      }),
    )
    await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Interrupt",
          id: String(intrId),
          requestId: String(reqId),
          address: {
            shardId: { group: addr.shardId.group, id: addr.shardId.id },
            entityType: addr.entityType,
            entityId: addr.entityId,
          },
        },
        primaryKey: null,
        deliverAt: null,
      }),
    )

    await Effect.runPromise(
      clearOmnigraphReplies({
        repoRoot,
        requestId: reqId,
        expectedReplyId: wrongExpectedExitId,
        client,
      }),
    )
    expect(await Effect.runPromise(driver.repliesFor([String(reqId)]))).toHaveLength(1)

    await Effect.runPromise(
      clearOmnigraphReplies({
        repoRoot,
        requestId: reqId,
        expectedReplyId: exitId,
        client,
      }),
    )
    expect(await Effect.runPromise(driver.repliesFor([String(reqId)]))).toHaveLength(0)

    const msgAndInt = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.checkInterrupt"),
        queryName: "wf_messages_by_keys",
        params: {
          messageKeys: [MessageKey.make(String(reqId)), MessageKey.make(String(intrId))],
        },
        client,
      }),
    )
    expect(msgAndInt.map((r) => r.kind)).toEqual(["request", "interrupt"])
    expect(msgAndInt[0]?.processed).toBe(false)

    const exitId2 = mintSnowflake()
    await Effect.runPromise(
      driver.saveReply({
        _tag: "WithExit",
        id: String(exitId2),
        requestId: String(reqId),
        exit: { _tag: "Success", value: "done-2" },
      }),
    )

    const failingCommit2Client = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_reset_message_for_clear_cas") {
        throw new Error("Injected Commit-2 failure")
      }
      return orig(name, input, opts)
    })

    const clearFailure = await Effect.runPromise(
      clearOmnigraphReplies({
        repoRoot,
        requestId: reqId,
        expectedReplyId: exitId2,
        client: failingCommit2Client,
      }).pipe(Effect.flip),
    )
    expect(clearFailure).toBeInstanceOf(WorkflowStoreUnavailableError)

    const afterComp = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.afterComp"),
        queryName: "wf_messages_by_keys",
        params: { messageKeys: [MessageKey.make(String(reqId))] },
        client,
      }),
    )
    expect(afterComp[0]?.processed).toBe(false)

    const exitId3 = mintSnowflake()
    await Effect.runPromise(
      driver.saveReply({
        _tag: "WithExit",
        id: String(exitId3),
        requestId: String(reqId),
        exit: { _tag: "Success", value: "done-3" },
      }),
    )
    await Effect.runPromise(driver.clearReplies(reqId))
    const afterUncond = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.afterUncond"),
        queryName: "wf_messages_by_keys",
        params: {
          messageKeys: [MessageKey.make(String(reqId)), MessageKey.make(String(intrId))],
        },
        client,
      }),
    )
    expect(afterUncond.map((r) => r.kind)).toEqual(["request"])
    expect(afterUncond[0]?.processed).toBe(false)

    await client.mutate({
      query: `query wedge($k: String) { update WfMessage set { processed: true } where messageKey = $k }`,
      params: { k: String(reqId) },
    })
    const repaired = await Effect.runPromise(repairDanglingProcessedRequests({ repoRoot, client }))
    expect(repaired).toBeGreaterThanOrEqual(1)

    await Effect.runPromise(driver.clearAddress(addr))
  })

  it("filters opts.addresses per entityType in GQ across >1024 unrelated rows and same-entityId Workflow/DurableClock", async () => {
    const client = createClient()
    const driver = await Effect.runPromise(makeOmnigraphEncodedDriver(repoRoot, { client }))

    const noiseAddr = makeAddress("multi", 0, "NoiseStarveEntity", "noise-1")
    const workflowAddr = makeAddress("multi", 0, "Workflow/SharedTag", "shared-exec-1")
    const clockAddr = makeAddress("multi", 0, "Workflow/-/DurableClock", "shared-exec-1")

    const bulkLines: Array<string> = []
    for (let i = 0; i < 1050; i += 1) {
      const id = String(mintSnowflake())
      const sk = unwrapSeqKey(id)
      bulkLines.push(
        JSON.stringify({
          type: "WfMessage",
          id,
          data: {
            messageKey: id,
            seqKey: sk,
            shardId: ShardId.toString(noiseAddr.shardId),
            entityType: noiseAddr.entityType,
            entityId: noiseAddr.entityId,
            kind: "request",
            tag: "Noise",
            payload: "{}",
            headers: "{}",
            requestId: id,
            processed: false,
          },
        }),
      )
    }
    await client.load({ branch: "main", mode: "merge", data: `${bulkLines.join("\n")}\n` })

    const wfMsgId = mintSnowflake()
    const clockMsgId = mintSnowflake()
    for (const [msgId, targetAddr, tag] of [
      [wfMsgId, workflowAddr, "Run"],
      [clockMsgId, clockAddr, "Sleep"],
    ] as const) {
      await Effect.runPromise(
        driver.saveEnvelope({
          envelope: {
            _tag: "Request",
            requestId: String(msgId),
            address: {
              shardId: { group: targetAddr.shardId.group, id: targetAddr.shardId.id },
              entityType: targetAddr.entityType,
              entityId: targetAddr.entityId,
            },
            tag,
            payload: { tag },
            headers: {},
          },
          primaryKey: null,
          deliverAt: null,
        }),
      )
    }

    const polled = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(workflowAddr.shardId)], Date.now(), {
        addresses: [workflowAddr, clockAddr],
      }),
    )
    expect(polled.map((m) => envelopeMessageId(m.envelope))).toEqual([
      String(wfMsgId),
      String(clockMsgId),
    ])

    await Effect.runPromise(driver.clearAddress(noiseAddr))
    await Effect.runPromise(driver.clearAddress(workflowAddr))
    await Effect.runPromise(driver.clearAddress(clockAddr))
  }, 30_000)

  it("caps concurrent HTTP at WORKFLOW_MAX_CONCURRENT_HTTP, retries 429/412/409, exhausts WORKFLOW_MAX_OCC_RETRIES, and serializes writeMutex + atomic clearAddress", async () => {
    const client = createClient()
    let inFlight = 0
    let maxInFlight = 0
    let transientErrorsRemaining = 3

    const instrumentedClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      inFlight += 1
      if (inFlight > maxInFlight) maxInFlight = inFlight
      try {
        await new Promise((r) => setTimeout(r, 20))
        if (transientErrorsRemaining > 0) {
          const n = transientErrorsRemaining
          transientErrorsRemaining -= 1
          const status = n === 3 ? 429 : n === 2 ? 412 : 409
          throw Object.assign(new Error(`transient-${status}`), { status })
        }
        return await orig(name, input, opts)
      } finally {
        inFlight -= 1
      }
    })

    const results = await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: 36 }, (_, idx) => idx),
        () =>
          invokeWorkflowStoreQuery({
            repoRoot,
            operation: WorkflowStoreOperation.make("test.concurrencyCap"),
            queryName: "wf_count_all",
            params: {},
            client: instrumentedClient,
          }),
        { concurrency: "unbounded" },
      ),
    )

    expect(results).toHaveLength(36)
    expect(transientErrorsRemaining).toBe(0)
    expect(maxInFlight).toBeLessThanOrEqual(WORKFLOW_MAX_CONCURRENT_HTTP)
    expect(maxInFlight).toBeGreaterThan(1)

    // Retry exhaustion
    let attemptCount = 0
    const always412Client = wrapQueriesInvoke(client, async () => {
      attemptCount += 1
      throw Object.assign(new Error("always-occ-412"), { status: 412, retryAfter: "0.005" })
    })
    const op = WorkflowStoreOperation.make("test.occExhaustion")
    const err = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: op,
        queryName: "wf_count_all",
        params: {},
        client: always412Client,
      }).pipe(Effect.flip),
    )
    expect(attemptCount).toBe(WORKFLOW_MAX_OCC_RETRIES + 1)
    expect(err).toBeInstanceOf(WorkflowStoreUnavailableError)
    expect(err.operation).toBe(op)
    expect(err.reason).toContain("always-occ-412")

    // Concurrent clearReplies + saveReply writeMutex serialization + atomic clearAddress
    const writeMutex = Semaphore.makeUnsafe(1)
    const driver = await Effect.runPromise(
      makeOmnigraphEncodedDriver(repoRoot, { client, writeMutex }),
    )
    const addr = makeAddress("atomic", 0, "AtomicAddressEntity", "addr-1")
    const reqId = mintSnowflake()
    const exitId = mintSnowflake()

    await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Request",
          requestId: String(reqId),
          address: {
            shardId: { group: addr.shardId.group, id: addr.shardId.id },
            entityType: addr.entityType,
            entityId: addr.entityId,
          },
          tag: "Step",
          payload: { a: 1 },
          headers: {},
        },
        primaryKey: null,
        deliverAt: null,
      }),
    )
    await Effect.runPromise(
      driver.saveReply({
        _tag: "WithExit",
        id: String(exitId),
        requestId: String(reqId),
        exit: { _tag: "Success", value: "before-concurrent" },
      }),
    )

    const delayedCasClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_clear_replies_cas_delete") {
        await new Promise((r) => setTimeout(r, 60))
      }
      return orig(name, input, opts)
    })
    const delayedDriver = await Effect.runPromise(
      makeOmnigraphEncodedDriver(repoRoot, { client: delayedCasClient, writeMutex }),
    )
    const freshExitId = mintSnowflake()
    await Effect.runPromise(
      Effect.all(
        [
          delayedDriver.clearReplies(reqId, { expectedReplyId: exitId }),
          driver.saveReply({
            _tag: "WithExit",
            id: String(freshExitId),
            requestId: String(reqId),
            exit: { _tag: "Success", value: "after-clear" },
          }),
        ],
        { concurrency: 2 },
      ),
    )
    const postConcurrentMsgs = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.postConcurrent"),
        queryName: "wf_messages_by_keys",
        params: { messageKeys: [MessageKey.make(String(reqId))] },
        client,
      }),
    )
    expect(postConcurrentMsgs[0]?.processed).toBe(true)
    expect(postConcurrentMsgs[0]?.lastReplyId).toBe(String(freshExitId))

    await client.mutate({
      query: `query wedgeBeforeClear($k: String) { update WfMessage set { processed: true } where messageKey = $k }`,
      params: { k: String(reqId) },
    })
    await Effect.runPromise(driver.clearAddress(addr))
    await Effect.runPromise(repairDanglingProcessedRequests({ repoRoot, client, writeMutex }))
    const afterClearAddr = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.afterClearAddr"),
        queryName: "wf_messages_by_keys",
        params: { messageKeys: [MessageKey.make(String(reqId))] },
        client,
      }),
    )
    expect(afterClearAddr).toHaveLength(0)
  }, 20_000)
})
