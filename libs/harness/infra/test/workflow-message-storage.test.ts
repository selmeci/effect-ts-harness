import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Duration, Effect, Layer, Option, Schema, Semaphore } from "effect"
import {
  EntityAddress,
  EntityId,
  EntityType,
  type Envelope,
  ShardId,
  Snowflake,
} from "effect/cluster"
import { Activity, Workflow, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  decodeSeqKey,
  encodeSeqKey,
  type SeqKey,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
} from "@harness/contract"
import { makeWorkflowOmnigraphClient, OmnigraphClient } from "@harness/graph"
import {
  clearOmnigraphReplies,
  invokeWorkflowStoreQuery,
  makeHarnessWorkflowEngineLayer,
  makeOmnigraphEncodedDriver,
  WORKFLOW_MAX_CONCURRENT_HTTP,
  WORKFLOW_MAX_OCC_RETRIES,
} from "../src/index.js"
import {
  computePrimaryKeyHash,
  repairDanglingProcessedRequests,
} from "../src/omnigraph-message-storage.js"
import { quarantineOrphanEntityMessages } from "../src/omnigraph-workflow-store.js"

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

describe("OmnigraphMessageStorage, workflow store semaphore/retries, and WorkflowEngine live", () => {
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
    makeWorkflowOmnigraphClient({
      baseUrl: serverBaseUrl,
      token: cliToken,
    })

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

  it("supports all 13 MessageStorage.Encoded methods, primaryKey hashing, and lossless SeqKey > 2^53 ordering", async () => {
    const client = createClient()
    const driver = await Effect.runPromise(makeOmnigraphEncodedDriver(repoRoot, { client }))

    // Verify SeqKey encoding/decoding past Number.MAX_SAFE_INTEGER (2^53 - 1)
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

    // Primary key lookup for >255 char key
    const lookedUp = await Effect.runPromise(driver.requestIdForPrimaryKey(longPrimaryKey))
    expect(unwrapOption(lookedUp)).toBe(reqId1)

    // Save chunk reply & duplicate primaryKey returns Duplicate with lastReceivedReply
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

    // AckChunk marks chunk acked so repliesFor excludes it while repliesForUnfiltered retains it
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
    const filteredAfterAck = await Effect.runPromise(driver.repliesFor([String(reqId1)]))
    expect(filteredAfterAck).toHaveLength(0)
    const unfilteredAfterAck = await Effect.runPromise(
      driver.repliesForUnfiltered([String(reqId1)]),
    )
    expect(unfilteredAfterAck).toHaveLength(1)

    // Save second request + future delayed request (minted after ackId so seqKey order is reqId1 < ackId < reqId2)
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

    // unprocessedMessages claims & honors limit + deliverAt + lossless order
    const batch1 = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(addr1.shardId)], now, { limit: 2 }),
    )
    expect(batch1).toHaveLength(2)
    expect(batch1.map((b) => envelopeMessageId(b.envelope))).toEqual([
      String(reqId1),
      String(ackId),
    ])

    // Claimed messages excluded until resetRequests / resetAddresses / resetShards
    const batch2 = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(addr1.shardId)], now),
    )
    expect(batch2.map((b) => envelopeMessageId(b.envelope))).toEqual([String(reqId2)])

    // unprocessedMessagesById ignores lastReadMs claim while still honoring deliverAt
    const byId = await Effect.runPromise(
      driver.unprocessedMessagesById([reqId1, delayedReqId], now),
    )
    expect(byId.map((b) => envelopeMessageId(b.envelope))).toEqual([String(reqId1)])

    // resetRequests, resetAddresses, resetShards, withTransaction
    await Effect.runPromise(driver.resetRequests([reqId1]))
    const afterResetReq = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(addr1.shardId)], now, {
        addresses: [addr1],
      }),
    )
    expect(afterResetReq.some((m) => envelopeMessageId(m.envelope) === String(reqId1))).toBe(true)

    await Effect.runPromise(driver.resetAddresses([addr1, addr2]))
    await Effect.runPromise(driver.resetShards([ShardId.toString(addr1.shardId)]))
    const txRes = await Effect.runPromise(driver.withTransaction(Effect.succeed("tx-ok")))
    expect(txRes).toBe("tx-ok")

    // WithExit reply + clearAddress cleanup
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

    // 1. Mismatched expectedReplyId must leave WithExit & processed=true untouched
    await Effect.runPromise(
      clearOmnigraphReplies({
        repoRoot,
        requestId: reqId,
        expectedReplyId: wrongExpectedExitId,
        client,
      }),
    )
    expect(await Effect.runPromise(driver.repliesFor([String(reqId)]))).toHaveLength(1)

    // 2. Matching expectedReplyId deletes WithExit, resets processed=false, and PRESERVES kind="interrupt"
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
        queryName: WorkflowStoreOperation.make("wf_messages_by_keys"),
        params: { messageKeys: [String(reqId), String(intrId)] },
        client,
      }),
    )
    expect(msgAndInt.map((r) => r.kind)).toEqual(["request", "interrupt"])
    expect(msgAndInt[0]?.processed).toBe(false)

    // 3. Re-save WithExit, then simulate Commit-2 failure on wf_reset_message_for_clear_cas -> immediate compensation
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

    // Verify immediate Commit-2 compensation repaired processed back to false!
    const afterComp = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.afterComp"),
        queryName: WorkflowStoreOperation.make("wf_messages_by_keys"),
        params: { messageKeys: [String(reqId)] },
        client,
      }),
    )
    expect(afterComp[0]?.processed).toBe(false)

    // 4. Unconditional clearReplies deletes both WithExit AND kind="interrupt"
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
        queryName: WorkflowStoreOperation.make("wf_messages_by_keys"),
        params: { messageKeys: [String(reqId), String(intrId)] },
        client,
      }),
    )
    expect(afterUncond.map((r) => r.kind)).toEqual(["request"])
    expect(afterUncond[0]?.processed).toBe(false)

    // 5. Verify explicit repairDanglingProcessedRequests repairs manually wedged rows
    await client.mutate({
      query: `query wedge($k: String) { update WfMessage set { processed: true } where messageKey = $k }`,
      params: { k: String(reqId) },
    })
    const repaired = await Effect.runPromise(repairDanglingProcessedRequests({ repoRoot, client }))
    expect(repaired).toBeGreaterThanOrEqual(1)

    await Effect.runPromise(driver.clearAddress(addr))
  })

  it("filters opts.addresses inside GQ before limit 1024 when >1024 older non-resident messages exist", async () => {
    const client = createClient()
    const driver = await Effect.runPromise(makeOmnigraphEncodedDriver(repoRoot, { client }))

    const nonResidentAddr = makeAddress("starve", 0, "NonResidentEntity", "nr-1")
    const residentAddr = makeAddress("starve", 0, "ResidentEntity", "res-1")

    // Bulk load 1,050 older unprocessed messages for NonResidentEntity via Omnigraph load
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
            shardId: ShardId.toString(nonResidentAddr.shardId),
            entityType: nonResidentAddr.entityType,
            entityId: nonResidentAddr.entityId,
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

    // Now save 2 later messages for ResidentEntity
    const resId1 = mintSnowflake()
    const resId2 = mintSnowflake()
    for (const id of [resId1, resId2]) {
      await Effect.runPromise(
        driver.saveEnvelope({
          envelope: {
            _tag: "Request",
            requestId: String(id),
            address: {
              shardId: { group: residentAddr.shardId.group, id: residentAddr.shardId.id },
              entityType: residentAddr.entityType,
              entityId: residentAddr.entityId,
            },
            tag: "Serve",
            payload: { ok: true },
            headers: {},
          },
          primaryKey: null,
          deliverAt: null,
        }),
      )
    }

    // Must return ResidentEntity messages immediately despite >1,024 older NonResidentEntity rows!
    const polled = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(residentAddr.shardId)], Date.now(), {
        addresses: [residentAddr],
      }),
    )
    expect(polled.map((m) => envelopeMessageId(m.envelope))).toEqual([
      String(resId1),
      String(resId2),
    ])

    await Effect.runPromise(driver.clearAddress(nonResidentAddr))
    await Effect.runPromise(driver.clearAddress(residentAddr))
  }, 30_000)

  it("caps concurrent HTTP calls at WORKFLOW_MAX_CONCURRENT_HTTP (12) and retries 429/412/409", async () => {
    const client = createClient()
    let inFlight = 0
    let maxInFlight = 0
    let transientErrorsRemaining = 3

    const instrumentedClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      inFlight += 1
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight
      }
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
            queryName: WorkflowStoreOperation.make("wf_count_all"),
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
  })

  it("isolates per-row malformed JSON defects without aborting healthy sibling rows", async () => {
    const client = createClient()
    const driver = await Effect.runPromise(makeOmnigraphEncodedDriver(repoRoot, { client }))
    const addr = makeAddress("corrupt", 0, "CorruptIsolationEntity", "iso-1")

    const corruptMsgId = String(mintSnowflake())
    const corruptSk = unwrapSeqKey(corruptMsgId)
    await client.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: corruptMsgId,
        seqKey: corruptSk,
        primaryKeyHash: null,
        shardId: ShardId.toString(addr.shardId),
        entityType: addr.entityType,
        entityId: addr.entityId,
        tag: "Broken",
        payload: "{not-valid-json",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: corruptMsgId,
        deliverAtMs: null,
      },
    })

    const validMsgId = String(mintSnowflake())
    await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Request",
          requestId: validMsgId,
          address: {
            shardId: { group: addr.shardId.group, id: addr.shardId.id },
            entityType: addr.entityType,
            entityId: addr.entityId,
          },
          tag: "Healthy",
          payload: { ok: true },
          headers: {},
        },
        primaryKey: null,
        deliverAt: null,
      }),
    )

    const polled = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(addr.shardId)], Date.now(), {
        addresses: [addr],
      }),
    )
    expect(polled).toHaveLength(1)
    expect(envelopeMessageId(polled[0]!.envelope)).toBe(validMsgId)

    // Also test corrupt WfReply isolation alongside a valid sibling reply
    const corruptReplyId = String(mintSnowflake())
    const corruptReplySk = unwrapSeqKey(corruptReplyId)
    await client.mutate({
      query: `query insBadReply($id: String, $sk: String, $req: String) {
        insert WfReply {
          replyKey: $id,
          seqKey: $sk,
          requestId: $req,
          kind: "with_exit",
          payload: "{bad-exit-json",
          acked: false
        }
      }`,
      params: { id: corruptReplyId, sk: corruptReplySk, req: validMsgId },
    })
    const goodReplyId = String(mintSnowflake())
    await Effect.runPromise(
      driver.saveReply({
        _tag: "WithExit",
        id: goodReplyId,
        requestId: validMsgId,
        exit: { _tag: "Success", value: "recovered" },
      }),
    )

    const replies = await Effect.runPromise(driver.repliesForUnfiltered([validMsgId]))
    expect(replies).toHaveLength(1)
    expect(replies[0]?.id).toBe(goodReplyId)

    await Effect.runPromise(driver.clearAddress(addr))
  })

  it("quarantines orphan entityTypes at startup, runs live ClusterWorkflowEngine, and maps outages to WorkflowStoreUnavailableError", async () => {
    const client = createClient()
    const orphanId = String(mintSnowflake())
    const orphanSk = unwrapSeqKey(orphanId)

    await client.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: orphanId,
        seqKey: orphanSk,
        primaryKeyHash: null,
        shardId: "default:0",
        entityType: "LegacyOrphanWorkflow",
        entityId: "orphan-run-1",
        tag: "Run",
        payload: "{}",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: orphanId,
        deliverAtMs: null,
      },
    })

    const EchoWorkflow = Workflow.make("Wf2EchoWorkflow", {
      payload: { value: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ value }) => value,
    })

    const EchoActivity = Activity.make({
      name: "EchoStep",
      success: Schema.String,
      execute: Effect.succeed("step-ok"),
    })

    const EchoWorkflowLayer = EchoWorkflow.toLayer(
      Effect.fn("Wf2EchoWorkflow.run")(function* ({ value }) {
        const stepRes = yield* EchoActivity
        return `${value}:${stepRes}`
      }),
    )

    const engineLayer = makeHarnessWorkflowEngineLayer(repoRoot, {
      client,
      knownEntityTypes: ["Workflow/Wf2EchoWorkflow", "Workflow/-/DurableClock"],
      entityMessagePollInterval: Duration.millis(250),
      entityReplyPollInterval: Duration.millis(200),
    })

    const fullLayer = EchoWorkflowLayer.pipe(Layer.provideMerge(engineLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        return yield* engine.execute(EchoWorkflow, {
          executionId: "wf2-echo-exec-1",
          payload: { value: "hello" },
        })
      }).pipe(Effect.provide(fullLayer)),
    )
    expect(result).toBe("hello:step-ok")

    // Confirm orphan entity message was quarantined at startup
    const orphanRows = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.checkOrphan"),
        queryName: WorkflowStoreOperation.make("wf_messages_by_keys"),
        params: { messageKeys: [orphanId] },
        client,
      }),
    )
    expect(orphanRows[0]?.processed).toBe(true)

    // Direct quarantine helper returns 0 once already quarantined
    const secondQuarantine = await Effect.runPromise(
      quarantineOrphanEntityMessages({
        repoRoot,
        knownEntityTypes: ["Workflow/Wf2EchoWorkflow", "Workflow/-/DurableClock"],
        client,
      }),
    )
    expect(secondQuarantine.quarantinedCount).toBe(0)

    // Outage test against unreachable port -> WorkflowStoreUnavailableError
    const deadPort = await allocateLoopbackPort()
    const deadClient = new OmnigraphClient({
      baseUrl: `http://127.0.0.1:${deadPort}`,
      graphId: "harness-workflows",
      token: cliToken,
    })
    const outageErr = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.outage"),
        queryName: WorkflowStoreOperation.make("wf_count_all"),
        params: {},
        client: deadClient,
      }).pipe(Effect.flip),
    )
    expect(outageErr).toBeInstanceOf(WorkflowStoreUnavailableError)

    const deadDriver = await Effect.runPromise(
      makeOmnigraphEncodedDriver(repoRoot, { client: deadClient }),
    )
    const driverErr = await Effect.runPromise(deadDriver.repliesFor(["missing"]).pipe(Effect.flip))
    expect(driverErr._tag).toBe("PersistenceError")
  }, 30_000)

  it("compensates unconditional clearReplies Commit-2 failures, serializes concurrent saveReply via writeMutex, and deletes addresses atomically without repair resurrection", async () => {
    const client = createClient()
    const writeMutex = Semaphore.makeUnsafe(1)
    const driver = await Effect.runPromise(
      makeOmnigraphEncodedDriver(repoRoot, { client, writeMutex }),
    )

    const addr = makeAddress("atomic", 0, "AtomicAddressEntity", "addr-1")
    const reqId = mintSnowflake()
    const intrId = mintSnowflake()
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
      driver.saveReply({
        _tag: "WithExit",
        id: String(exitId),
        requestId: String(reqId),
        exit: { _tag: "Success", value: "ok" },
      }),
    )

    // 1. Unconditional clearReplies Commit-2 failure -> immediate repair back to processed=false
    const failUncondCommit2Client = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_reset_message_for_clear") {
        throw new Error("Injected unconditional Commit-2 failure")
      }
      return orig(name, input, opts)
    })
    const uncondErr = await Effect.runPromise(
      clearOmnigraphReplies({
        repoRoot,
        requestId: reqId,
        client: failUncondCommit2Client,
        writeMutex,
      }).pipe(Effect.flip),
    )
    expect(uncondErr).toBeInstanceOf(WorkflowStoreUnavailableError)

    const afterUncondComp = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.afterUncondComp"),
        queryName: WorkflowStoreOperation.make("wf_messages_by_keys"),
        params: { messageKeys: [String(reqId), String(intrId)] },
        client,
      }),
    )
    expect(afterUncondComp.map((r) => r.kind)).toEqual(["request"])
    expect(afterUncondComp[0]?.processed).toBe(false)

    // 2. Concurrent clearReplies + saveReply serialized by writeMutex: saveReply must land AFTER Commit 2
    const nextExitId = mintSnowflake()
    await Effect.runPromise(
      driver.saveReply({
        _tag: "WithExit",
        id: String(nextExitId),
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
          delayedDriver.clearReplies(reqId, { expectedReplyId: nextExitId }),
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
        queryName: WorkflowStoreOperation.make("wf_messages_by_keys"),
        params: { messageKeys: [String(reqId)] },
        client,
      }),
    )
    expect(postConcurrentMsgs[0]?.processed).toBe(true)
    expect(postConcurrentMsgs[0]?.lastReplyId).toBe(String(freshExitId))

    // 3. Atomic clearAddress prevents resurrection even when processed=true without WithExit reply
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
        queryName: WorkflowStoreOperation.make("wf_messages_by_keys"),
        params: { messageKeys: [String(reqId)] },
        client,
      }),
    )
    expect(afterClearAddr).toHaveLength(0)
  })

  it("queries opts.addresses per entityType so same entityId across Workflow and DurableClock is never starved under >1024 unrelated rows", async () => {
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

  it("exhausts WORKFLOW_MAX_OCC_RETRIES and fails with WorkflowStoreUnavailableError preserving operation and reason", async () => {
    const client = createClient()
    let attemptCount = 0
    const always412Client = wrapQueriesInvoke(client, async () => {
      attemptCount += 1
      throw Object.assign(new Error("always-occ-412"), {
        status: 412,
        retryAfter: "0.005",
      })
    })

    const op = WorkflowStoreOperation.make("test.occExhaustion")
    const err = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: op,
        queryName: WorkflowStoreOperation.make("wf_count_all"),
        params: {},
        client: always412Client,
      }).pipe(Effect.flip),
    )

    expect(attemptCount).toBe(WORKFLOW_MAX_OCC_RETRIES + 1)
    expect(err).toBeInstanceOf(WorkflowStoreUnavailableError)
    expect(err.operation).toBe(op)
    expect(err.reason).toContain("always-occ-412")
  }, 15_000)
})
