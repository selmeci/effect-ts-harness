import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Duration, Effect, Layer, Schema, Tracer } from "effect"
import { EntityAddress, EntityId, EntityType, ShardId, Snowflake } from "effect/cluster"
import { Activity, Workflow, WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  AbsoluteRepoRoot,
  encodeSeqKey,
  LeaseEpoch,
  LeaseFilePath,
  MessageKey,
  type SeqKey,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
} from "@harness/contract"
import { makeWorkflowOmnigraphClient, OmnigraphClient } from "@harness/graph"
import {
  clearOmnigraphReplies,
  invokeWorkflowStoreQuery,
  invokeWorkflowStoreQueryWithMeta,
  makeHarnessWorkflowEngineLayer,
  makeOmnigraphEncodedDriver,
  MAX_ORPHAN_QUARANTINE_BATCHES,
  quarantineOrphanEntityMessages,
  repairDanglingProcessedRequests,
} from "../src/index.js"

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

describe("OmnigraphMessageStorage fencing, fail-closed guards, corrupt-row semantics, and orphan quarantine", () => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  let repoRoot: AbsoluteRepoRoot
  const cliToken = "wf2-fencing-cli-token"
  let nextSnowflake = 248476693641900000n

  const mintSnowflake = (): Snowflake.Snowflake => {
    nextSnowflake += 1n
    return Snowflake.Snowflake(nextSnowflake)
  }

  const createClient = () =>
    makeWorkflowOmnigraphClient({ baseUrl: serverBaseUrl, token: cliToken })

  beforeAll(async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wf2-fencing-"))
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
            "agent-mcp": "wf2-fencing-mcp-token",
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

  it("F-2.1 & F-17.1: stale expectedLeaseEpoch fails split-brain writes with WriterLeaseHeldError without mutating graph and resolves OCC 412 takeover", async () => {
    const client = createClient()
    const lockPath = LeaseFilePath.make(join(repoRoot, ".git", "harness", "daemon.lock"))

    // Seed active writer lease at epoch 2
    await client.queries.invoke("wf_insert_writer_lease", {
      branch: "main",
      expectMutation: true,
      params: {
        name: "engine",
        owner: "winner-daemon#1234",
        leaseEpoch: 2,
        heartbeatMs: Date.now(),
      },
    })

    // 1. Direct stale write with expectedLeaseEpoch=1 fails immediately without mutating graph
    const staleMsgId = MessageKey.make(String(mintSnowflake()))
    let mutationReachedServer = 0
    const spyClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_insert_request_message") {
        mutationReachedServer += 1
      }
      return orig(name, input, opts)
    })

    const directStaleErr = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.fencedDirectWrite"),
        queryName: "wf_insert_request_message",
        params: {
          messageKey: staleMsgId,
          seqKey: unwrapSeqKey(staleMsgId),
          primaryKeyHash: null,
          shardId: "default:0",
          entityType: "FenceEntity",
          entityId: "f-1",
          tag: "Run",
          payload: "{}",
          headers: "{}",
          traceId: null,
          spanId: null,
          sampled: null,
          requestId: staleMsgId,
          deliverAtMs: null,
        },
        expectMutation: true,
        expectedLeaseEpoch: LeaseEpoch.make(1),
        lockFilePath: lockPath,
        client: spyClient,
      }).pipe(Effect.flip),
    )
    expect(mutationReachedServer).toBe(0)
    match(directStaleErr)
      .with({ _tag: "WriterLeaseHeldError" }, (err) => {
        expect(err.holderId).toBe("winner-daemon")
        expect(err.leaseEpoch).toBe(2)
        expect(err.lockFilePath).toBe(lockPath)
      })
      .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
        throw new Error(`Expected WriterLeaseHeldError, got ${err.message}`)
      })
      .exhaustive()

    // Confirm row was NOT inserted into graph
    const rowsAfterStale = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.verifyNoMutate"),
        queryName: "wf_messages_by_keys",
        params: { messageKeys: [staleMsgId] },
        client,
      }),
    )
    expect(rowsAfterStale).toHaveLength(0)

    // 2. Concurrent lease takeover between wf_get_writer_lease and mutation -> OCC 412 -> re-check -> WriterLeaseHeldError
    let leaseCheckCount = 0
    let observedIfGraphCommit: string | undefined
    const occTakeoverClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_get_writer_lease") {
        leaseCheckCount += 1
        return leaseCheckCount === 1
          ? fakeReadResult(
              name,
              [{ name: "engine", owner: "stale-writer#100", leaseEpoch: 1, heartbeatMs: 1 }],
              "commit-before-takeover",
            )
          : fakeReadResult(
              name,
              [{ name: "engine", owner: "winner-daemon#200", leaseEpoch: 2, heartbeatMs: 2 }],
              "commit-after-takeover",
            )
      }
      if (name === "wf_insert_request_message") {
        observedIfGraphCommit = opts?.ifGraphCommit
        throw Object.assign(new Error("precondition failed"), { status: 412 })
      }
      return orig(name, input, opts)
    })

    const occTakeoverErr = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.fencedOccTakeover"),
        queryName: "wf_insert_request_message",
        params: {
          messageKey: staleMsgId,
          seqKey: unwrapSeqKey(staleMsgId),
          primaryKeyHash: null,
          shardId: "default:0",
          entityType: "FenceEntity",
          entityId: "f-2",
          tag: "Run",
          payload: "{}",
          headers: "{}",
          traceId: null,
          spanId: null,
          sampled: null,
          requestId: staleMsgId,
          deliverAtMs: null,
        },
        expectMutation: true,
        expectedLeaseEpoch: LeaseEpoch.make(1),
        lockFilePath: lockPath,
        client: occTakeoverClient,
      }).pipe(Effect.flip),
    )
    expect(observedIfGraphCommit).toBe("commit-before-takeover")
    expect(leaseCheckCount).toBe(2)
    expect(occTakeoverErr).toBeInstanceOf(WriterLeaseHeldError)

    // 3. Fenced makeOmnigraphEncodedDriver surfaces WriterLeaseHeldError inside PersistenceError.cause
    const fencedDriver = await Effect.runPromise(
      makeOmnigraphEncodedDriver(repoRoot, {
        client,
        expectedLeaseEpoch: LeaseEpoch.make(1),
        lockFilePath: lockPath,
      }),
    )
    const driverErr = await Effect.runPromise(
      fencedDriver
        .saveEnvelope({
          envelope: {
            _tag: "Request",
            requestId: staleMsgId,
            address: {
              shardId: { group: "default", id: 0 },
              entityType: "FenceEntity",
              entityId: "f-3",
            },
            tag: "Run",
            payload: {},
            headers: {},
          },
          primaryKey: null,
          deliverAt: null,
        })
        .pipe(Effect.flip),
    )
    expect(driverErr._tag).toBe("PersistenceError")
    expect(driverErr.cause).toBeInstanceOf(WriterLeaseHeldError)
  })

  it("F-3.1 & F-4.1 & F-4.2 & F-13.2: fails closed on malformed envelopes, affectedNodes mismatches, and dual Commit-2 + compensation failures", async () => {
    const client = createClient()

    // F-3.1: Unexpected Omnigraph envelope fails closed (never empty rows fallback)
    const badEnvelopeClient = wrapQueriesInvoke(client, async (name) => ({
      queryName: name,
      rowCount: 0,
      rows: "not-an-array",
      target: { branch: "main" },
    }))
    const badEnvelopeErr = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.badEnvelope"),
        queryName: "wf_count_all",
        params: {},
        client: badEnvelopeClient,
      }).pipe(Effect.flip),
    )
    expect(badEnvelopeErr).toBeInstanceOf(WorkflowStoreUnavailableError)

    // F-4.1: wf_claim_messages returning affectedNodes !== messageKeys.length fails closed
    const driver = await Effect.runPromise(makeOmnigraphEncodedDriver(repoRoot, { client }))
    const addr = makeAddress("claim", 0, "ClaimMismatchEntity", "cm-1")
    const claimMsgId = mintSnowflake()
    await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Request",
          requestId: String(claimMsgId),
          address: {
            shardId: { group: "claim", id: 0 },
            entityType: addr.entityType,
            entityId: addr.entityId,
          },
          tag: "Run",
          payload: {},
          headers: {},
        },
        primaryKey: null,
        deliverAt: null,
      }),
    )
    const badClaimClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_claim_messages") {
        return fakeMutationResult(name, 0, 0)
      }
      return orig(name, input, opts)
    })
    const badClaimDriver = await Effect.runPromise(
      makeOmnigraphEncodedDriver(repoRoot, { client: badClaimClient }),
    )
    const claimMismatchErr = await Effect.runPromise(
      badClaimDriver
        .unprocessedMessages(["claim:0"], Date.now(), { addresses: [addr] })
        .pipe(Effect.flip),
    )
    expect(claimMismatchErr._tag).toBe("PersistenceError")

    // F-4.2: wf_save_reply_exit returning affectedNodes: 0 fails closed
    const badSaveReplyClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_save_reply_exit") {
        return fakeMutationResult(name, 0, 0)
      }
      return orig(name, input, opts)
    })
    const badSaveDriver = await Effect.runPromise(
      makeOmnigraphEncodedDriver(repoRoot, { client: badSaveReplyClient }),
    )
    const saveZeroErr = await Effect.runPromise(
      badSaveDriver
        .saveReply({
          _tag: "WithExit",
          id: String(mintSnowflake()),
          requestId: String(claimMsgId),
          exit: { _tag: "Success", value: "ok" },
        })
        .pipe(Effect.flip),
    )
    expect(saveZeroErr._tag).toBe("PersistenceError")

    // F-13.2: Dual Commit-2 + compensation failure propagates BOTH details into WorkflowStoreUnavailableError
    const dualFailClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_reset_message_for_clear") {
        throw new Error("primary-commit2-boom")
      }
      if (name === "wf_repair_dangling_requests") {
        throw new Error("compensation-boom")
      }
      return orig(name, input, opts)
    })
    const dualErr = await Effect.runPromise(
      clearOmnigraphReplies({
        repoRoot,
        requestId: claimMsgId,
        client: dualFailClient,
      }).pipe(Effect.flip),
    )
    expect(dualErr).toBeInstanceOf(WorkflowStoreUnavailableError)
    expect(dualErr.message).toContain("primary-commit2-boom")
    expect(dualErr.message).toContain("compensation-boom")

    await Effect.runPromise(driver.clearAddress(addr))
  })

  it("F-13.1: persists terminal WithExit(Die) for corrupt WfMessage rows and synthesizes WithExit(Die) for corrupt WfReply rows", async () => {
    const client = createClient()
    const driver = await Effect.runPromise(makeOmnigraphEncodedDriver(repoRoot, { client }))
    const addr = makeAddress("corrupt2", 0, "CorruptSemanticsEntity", "cs-1")

    const corruptMsgId = MessageKey.make(String(mintSnowflake()))
    await client.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: corruptMsgId,
        seqKey: unwrapSeqKey(corruptMsgId),
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

    const validMsgId = MessageKey.make(String(mintSnowflake()))
    await Effect.runPromise(
      driver.saveEnvelope({
        envelope: {
          _tag: "Request",
          requestId: validMsgId,
          address: {
            shardId: { group: "corrupt2", id: 0 },
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

    // Corrupt WfMessage is excluded from polled items AND receives persisted terminal WithExit(Die) reply
    const polled = await Effect.runPromise(
      driver.unprocessedMessages([ShardId.toString(addr.shardId)], Date.now(), {
        addresses: [addr],
      }),
    )
    expect(polled).toHaveLength(1)
    match(polled[0]?.envelope)
      .with({ _tag: "Request" }, (req) => {
        expect(req.requestId).toBe(validMsgId)
      })
      .with({ _tag: "AckChunk" }, { _tag: "Interrupt" }, undefined, () => {
        expect.unreachable("Expected Request envelope for validMsgId")
      })
      .exhaustive()

    const corruptMsgReplies = await Effect.runPromise(driver.repliesForUnfiltered([corruptMsgId]))
    expect(corruptMsgReplies).toHaveLength(1)
    const firstCorruptMsgReply = corruptMsgReplies[0]
    match(firstCorruptMsgReply)
      .with({ _tag: "WithExit" }, (reply) => {
        match(reply.exit)
          .with({ _tag: "Failure" }, (exitFailure) => {
            expect(exitFailure.cause[0]?._tag).toBe("Die")
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected Failure(Die) for corrupt WfMessage")
          })
          .exhaustive()
      })
      .with({ _tag: "Chunk" }, undefined, () => {
        expect.unreachable("Expected WithExit reply for corrupt WfMessage")
      })
      .exhaustive()

    // Corrupt WfReply on one requestId synthesizes WithExit(Die) while preserving healthy sibling requestId
    const corruptReplyReqId = MessageKey.make(String(mintSnowflake()))
    const corruptReplyId = String(mintSnowflake())
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
      params: { id: corruptReplyId, sk: unwrapSeqKey(corruptReplyId), req: corruptReplyReqId },
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

    const replies = await Effect.runPromise(
      driver.repliesForUnfiltered([corruptReplyReqId, validMsgId]),
    )
    expect(replies).toHaveLength(2)
    const badSynthesized = replies.find((r) => r.requestId === corruptReplyReqId)
    const healthySibling = replies.find((r) => r.requestId === validMsgId)
    match(badSynthesized)
      .with({ _tag: "WithExit" }, (reply) => {
        match(reply.exit)
          .with({ _tag: "Failure" }, (exitFailure) => {
            expect(exitFailure.cause[0]?._tag).toBe("Die")
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected Failure(Die) for corrupt WfReply")
          })
          .exhaustive()
      })
      .with({ _tag: "Chunk" }, undefined, () => {
        expect.unreachable("Expected WithExit reply for corrupt WfReply")
      })
      .exhaustive()
    expect(healthySibling?.id).toBe(goodReplyId)

    await Effect.runPromise(driver.clearAddress(addr))
  })

  it("F-12.1/F-12.2/F-12.3: rejects empty knownEntityTypes, fails after 128 batches, and skips quarantine when undefined", async () => {
    const client = createClient()

    // F-12.1: Empty knownEntityTypes rejected fail-closed
    const emptyErr = await Effect.runPromise(
      quarantineOrphanEntityMessages({ repoRoot, knownEntityTypes: [], client }).pipe(Effect.flip),
    )
    expect(emptyErr).toBeInstanceOf(WorkflowStoreUnavailableError)

    // F-12.2: >128 batches still returning orphan rows fails closed
    const endlessId = MessageKey.make(String(mintSnowflake()))
    const endlessOrphanClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_orphan_entity_messages") {
        return fakeReadResult(
          name,
          [
            {
              messageKey: endlessId,
              seqKey: unwrapSeqKey(endlessId),
              shardId: "default:0",
              entityType: "EndlessOrphan",
              entityId: "o-1",
              requestId: endlessId,
            },
          ],
          "c-endless",
        )
      }
      if (name === "wf_save_reply_exit" || name === "wf_quarantine_orphan_messages") {
        return fakeMutationResult(name, 1, 0)
      }
      return orig(name, input, opts)
    })
    const batchOverflowErr = await Effect.runPromise(
      quarantineOrphanEntityMessages({
        repoRoot,
        knownEntityTypes: ["Workflow/Known"],
        client: endlessOrphanClient,
      }).pipe(Effect.flip),
    )
    match(batchOverflowErr)
      .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
        expect(err.reason).toContain(String(MAX_ORPHAN_QUARANTINE_BATCHES))
      })
      .with({ _tag: "WriterLeaseHeldError" }, (err) => {
        throw new Error(`Expected WorkflowStoreUnavailableError, got ${err.message}`)
      })
      .exhaustive()

    // F-12.3: Insert an orphan message, then start engine WITHOUT knownEntityTypes -> NOT quarantined!
    const unquarantinedId = MessageKey.make(String(mintSnowflake()))
    await client.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: unquarantinedId,
        seqKey: unwrapSeqKey(unquarantinedId),
        primaryKeyHash: null,
        shardId: "default:0",
        entityType: "UnlistedEntity",
        entityId: "u-1",
        tag: "Run",
        payload: "{}",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: unquarantinedId,
        deliverAtMs: null,
      },
    })

    const EchoWorkflow = Workflow.make("Wf2SkipQuarantineWorkflow", {
      payload: { value: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ value }) => value,
    })
    const EchoActivity = Activity.make({
      name: "EchoStep",
      success: Schema.String,
      execute: Effect.succeed("ok"),
    })
    const EchoLayer = EchoWorkflow.toLayer(
      Effect.fn("Wf2SkipQuarantineWorkflow.run")(function* ({ value }) {
        const step = yield* EchoActivity
        return `${value}:${step}`
      }),
    )

    const noQuarantineEngine = makeHarnessWorkflowEngineLayer(repoRoot, {
      client,
      entityMessagePollInterval: Duration.millis(250),
      entityReplyPollInterval: Duration.millis(200),
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        return yield* engine.execute(EchoWorkflow, {
          executionId: "wf2-skip-quarantine-1",
          payload: { value: "hi" },
        })
      }).pipe(Effect.provide(EchoLayer.pipe(Layer.provideMerge(noQuarantineEngine)))),
    )
    expect(result).toBe("hi:ok")

    // UnlistedEntity message must STILL be processed=false because quarantine was skipped!
    const stillUnprocessed = await Effect.runPromise(
      invokeWorkflowStoreQuery({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.checkSkippedQuarantine"),
        queryName: "wf_messages_by_keys",
        params: { messageKeys: [unquarantinedId] },
        client,
      }),
    )
    expect(stillUnprocessed[0]?.processed).toBe(false)

    // Explicit knownEntityTypes DOES quarantine UnlistedEntity!
    const quarantined = await Effect.runPromise(
      quarantineOrphanEntityMessages({
        repoRoot,
        knownEntityTypes: ["Workflow/Wf2SkipQuarantineWorkflow", "Workflow/-/DurableClock"],
        client,
      }),
    )
    expect(quarantined.quarantinedCount).toBeGreaterThanOrEqual(1)
    expect(quarantined.orphanEntityTypes).toContain("UnlistedEntity")
  }, 30_000)

  it("enforces expectedLeaseOwner mismatch fencing and emits WorkflowStore/repairDangling spans", async () => {
    const client = createClient()
    const lockPath = LeaseFilePath.make(join(repoRoot, ".git", "harness", "daemon.lock"))
    const expectedOwner = "owner-daemon#4321"

    await client.queries.invoke("wf_insert_writer_lease", {
      branch: "main",
      expectMutation: true,
      params: {
        name: "engine",
        owner: expectedOwner,
        leaseEpoch: 4,
        heartbeatMs: Date.now(),
      },
    })

    // Matching expectedLeaseEpoch but mismatched expectedLeaseOwner MUST fail closed with WriterLeaseHeldError
    const mismatchMsgId = MessageKey.make(String(mintSnowflake()))
    let mutationSent = 0
    const spyClient = wrapQueriesInvoke(client, async (name, orig, input, opts) => {
      if (name === "wf_insert_request_message") mutationSent += 1
      return orig(name, input, opts)
    })

    const ownerMismatchErr = await Effect.runPromise(
      invokeWorkflowStoreQueryWithMeta({
        repoRoot,
        operation: WorkflowStoreOperation.make("test.ownerMismatchFence"),
        queryName: "wf_insert_request_message",
        params: {
          messageKey: mismatchMsgId,
          seqKey: unwrapSeqKey(mismatchMsgId),
          primaryKeyHash: null,
          shardId: "default:0",
          entityType: "OwnerFenceEntity",
          entityId: "of-1",
          tag: "Run",
          payload: "{}",
          headers: "{}",
          traceId: null,
          spanId: null,
          sampled: null,
          requestId: mismatchMsgId,
          deliverAtMs: null,
        },
        expectMutation: true,
        expectedLeaseEpoch: LeaseEpoch.make(4),
        expectedLeaseOwner: "impostor-daemon#9999",
        lockFilePath: lockPath,
        client: spyClient,
      }).pipe(Effect.flip),
    )
    expect(mutationSent).toBe(0)
    match(ownerMismatchErr)
      .with({ _tag: "WriterLeaseHeldError" }, (err) => {
        expect(err.holderId).toBe("owner-daemon")
        expect(err.leaseEpoch).toBe(4)
        expect(err.holderPid).toBe(4321)
        expect(err.lockFilePath).toBe(lockPath)
      })
      .with({ _tag: "WorkflowStoreUnavailableError" }, (err) => {
        throw new Error(`Expected WriterLeaseHeldError, got ${err.message}`)
      })
      .exhaustive()

    // Matching expectedLeaseOwner succeeds and emits WorkflowStore.invokeWithMeta, WorkflowStore.quarantineOrphans, and OmnigraphMessageStorage.repairDangling spans
    const spanNames: Array<string> = []
    const testTracer = Tracer.make({
      span: (options) => {
        spanNames.push(options.name)
        return new Tracer.NativeSpan(options)
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const res = yield* invokeWorkflowStoreQueryWithMeta({
          repoRoot,
          operation: WorkflowStoreOperation.make("test.ownerMatchWithMeta"),
          queryName: "wf_insert_request_message",
          params: {
            messageKey: mismatchMsgId,
            seqKey: unwrapSeqKey(mismatchMsgId),
            primaryKeyHash: null,
            shardId: "default:0",
            entityType: "OwnerFenceEntity",
            entityId: "of-1",
            tag: "Run",
            payload: "{}",
            headers: "{}",
            traceId: null,
            spanId: null,
            sampled: null,
            requestId: mismatchMsgId,
            deliverAtMs: null,
          },
          expectMutation: true,
          expectedLeaseEpoch: LeaseEpoch.make(4),
          expectedLeaseOwner: expectedOwner,
          lockFilePath: lockPath,
          client,
        })
        expect(res.affectedNodes).toBeGreaterThanOrEqual(1)
        yield* quarantineOrphanEntityMessages({
          repoRoot,
          knownEntityTypes: ["OwnerFenceEntity", "Workflow/-/DurableClock"],
          client,
        })
        yield* repairDanglingProcessedRequests({
          repoRoot,
          client,
        })
      }).pipe(Effect.provideService(Tracer.Tracer, testTracer)),
    )

    expect(spanNames).toContain("WorkflowStore.invokeWithMeta")
    expect(spanNames).toContain("WorkflowStore.quarantineOrphans")
    expect(spanNames).toContain("OmnigraphMessageStorage.repairDangling")
  })
})
