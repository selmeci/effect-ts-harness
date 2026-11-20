import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  Omnigraph,
  PreconditionFailedError,
  TooManyRequestsError,
  UnauthorizedError,
} from "@modernrelay/omnigraph"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WORKFLOW_GQ_QUERY_NAMES } from "@harness/contract"
import {
  HARNESS_OMNIGRAPH_GRAPH_ID,
  OmnigraphLoadError,
  WORKFLOW_OMNIGRAPH_GRAPH_ID,
  isOmnigraphPreconditionOrConflictError,
  isOmnigraphTooManyRequestsError,
  makeWorkflowOmnigraphClient,
  resolveGitCommonDir,
  resolveOmnigraphGraphId,
  resolveWorkflowOmnigraphConfig,
} from "../src/index.js"
import { makeExtendedTestHostIo, testHostIo } from "./helpers/test-host-io.js"

const graphConfigDir = resolve(import.meta.dirname, "..")

const isRowsEnvelope = (
  value: unknown,
): value is { readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>> } =>
  typeof value === "object" && value !== null && "rows" in value && Array.isArray(value.rows)

const requireRows = (res: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  if (!isRowsEnvelope(res)) {
    return expect.unreachable("Expected Omnigraph query result envelope with a rows array")
  }
  return res.rows
}
const omnigraphBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")
const omnigraphServerBin = join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph-server")

const padSeqKey = (snowflake: string): string => snowflake.padStart(20, "0")

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
  for (const m of applyStdout.matchAll(/Admission lock:\s*([A-Z0-9]+)/gi)) {
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

describe("Workflow graph assets, disjoint Cedar policies, and live Omnigraph 0.14.0 verification", () => {
  const tempDirs: Array<string> = []
  let serverProc: ChildProcess | undefined
  let serverBaseUrl = ""
  const cliToken = "wf2-test-cli-token"
  const mcpToken = "wf2-test-mcp-token"

  beforeAll(async () => {
    expect(existsSync(omnigraphBin)).toBe(true)
    expect(existsSync(omnigraphServerBin)).toBe(true)

    const tempRoot = mkdtempSync(join(tmpdir(), "wf2-graph-assets-"))
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
            "agent-mcp": mcpToken,
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

  it("lints workflows.schema.pg and workflow-queries/workflows.gq with 0 errors and exact query parity", () => {
    const gqPath = join(graphConfigDir, "workflow-queries", "workflows.gq")
    const gqText = readFileSync(gqPath, "utf8")
    const declaredQueryNames = [...gqText.matchAll(/^query\s+([a-zA-Z0-9_]+)\s*\(/gm)].map(
      (match) => match[1] ?? "",
    )
    expect(declaredQueryNames).toEqual([...WORKFLOW_GQ_QUERY_NAMES])
    expect(declaredQueryNames).toHaveLength(51)

    const out = execFileSync(
      omnigraphBin,
      [
        "lint",
        "--schema",
        join(graphConfigDir, "workflows.schema.pg"),
        "--query",
        gqPath,
        "--json",
      ],
      { encoding: "utf8" },
    )
    const parsed = JSON.parse(out) as {
      readonly status: string
      readonly errors: number
      readonly queries_processed: number
      readonly results: ReadonlyArray<{ readonly name: string; readonly status: string }>
    }
    expect(parsed.status).toBe("ok")
    expect(parsed.errors).toBe(0)
    expect(parsed.queries_processed).toBe(declaredQueryNames.length)
    expect(parsed.results).toHaveLength(declaredQueryNames.length)
    expect(parsed.results.map((r) => r.name)).toEqual(declaredQueryNames)
    expect(parsed.results.every((r) => r.status === "ok")).toBe(true)
  })

  it("validates disjoint policies per graph and confirms policy test without --graph requires --graph on multi-graph clusters", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wf2-policy-validate-"))
    tempDirs.push(tempRoot)
    const clusterDir = join(tempRoot, "cluster")
    mkdirSync(clusterDir, { recursive: true })

    execFileSync(
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

    const wfValidateOut = execFileSync(
      omnigraphBin,
      [
        "policy",
        "validate",
        "--target",
        `file://${clusterDir}`,
        "--graph",
        WORKFLOW_OMNIGRAPH_GRAPH_ID,
      ],
      { encoding: "utf8" },
    )
    expect(wfValidateOut).toContain("policy valid: bundle 'workflow-access'")

    const harnessValidateOut = execFileSync(
      omnigraphBin,
      [
        "policy",
        "validate",
        "--target",
        `file://${clusterDir}`,
        "--graph",
        HARNESS_OMNIGRAPH_GRAPH_ID,
      ],
      { encoding: "utf8" },
    )
    expect(harnessValidateOut).toContain("policy valid: bundle 'graph-access'")

    const wfPolicyTestOut = execFileSync(
      omnigraphBin,
      [
        "policy",
        "test",
        "--target",
        `file://${clusterDir}`,
        "--graph",
        WORKFLOW_OMNIGRAPH_GRAPH_ID,
        "--tests",
        join(graphConfigDir, "workflow-policy-tests.yaml"),
      ],
      { encoding: "utf8" },
    )
    expect(wfPolicyTestOut).toContain("policy tests passed: 21 cases")

    const harnessPolicyTestOut = execFileSync(
      omnigraphBin,
      [
        "policy",
        "test",
        "--target",
        `file://${clusterDir}`,
        "--graph",
        HARNESS_OMNIGRAPH_GRAPH_ID,
        "--tests",
        join(graphConfigDir, "policy-tests.yaml"),
      ],
      { encoding: "utf8" },
    )
    expect(harnessPolicyTestOut).toContain("policy tests passed: 13 cases")

    let missingGraphErr = ""
    try {
      execFileSync(
        omnigraphBin,
        [
          "policy",
          "test",
          "--target",
          `file://${clusterDir}`,
          "--tests",
          join(graphConfigDir, "policy-tests.yaml"),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
    } catch (err) {
      const e = err as { readonly stderr?: Buffer | string; readonly message: string }
      missingGraphErr =
        typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? e.message)
    }
    expect(missingGraphErr).toContain("has 2 policy bundles")
    expect(missingGraphErr).toContain("--graph")
  })

  it("enforces agent-mcp denial on harness-workflows (404 on stored query invoke, 403 on read/list/mutate) while allowing agent-mcp reads on harness", async () => {
    const mcpWorkflowOg = new Omnigraph({
      baseUrl: serverBaseUrl,
      graphId: WORKFLOW_OMNIGRAPH_GRAPH_ID,
      token: mcpToken,
    })

    await expect(mcpWorkflowOg.queries.invoke("wf_count_all")).rejects.toBeInstanceOf(NotFoundError)
    await expect(mcpWorkflowOg.snapshot({ branch: "main" })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(mcpWorkflowOg.queries.list()).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      mcpWorkflowOg.query({
        query: "query q() { match { $m: WfMessage } return { $m.messageKey } }",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      mcpWorkflowOg.mutate({
        query:
          'query q() { insert WfWriterLease { name: "x", owner: "mcp", leaseEpoch: 1, heartbeatMs: 1 } }',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)

    const mcpHarnessOg = new Omnigraph({
      baseUrl: serverBaseUrl,
      graphId: HARNESS_OMNIGRAPH_GRAPH_ID,
      token: mcpToken,
    })
    const harnessSnap = await mcpHarnessOg.snapshot({ branch: "main" })
    expect(harnessSnap.graphBranch).toBe("main")
    const harnessQuery = await mcpHarnessOg.queries.invoke("ontology_governed_by", {
      branch: "main",
      expectMutation: false,
      params: { symbol: "nonexistent" },
    })
    expect("rows" in harnessQuery).toBe(true)

    const unauthWorkflowOg = new Omnigraph({
      baseUrl: serverBaseUrl,
      graphId: WORKFLOW_OMNIGRAPH_GRAPH_ID,
      token: "invalid-token",
    })
    await expect(unauthWorkflowOg.snapshot({ branch: "main" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
  })

  it("executes all harness-workflows stored queries end-to-end as harness-cli", async () => {
    const og = makeWorkflowOmnigraphClient({
      baseUrl: serverBaseUrl,
      token: cliToken,
    })

    const msg1 = "248476693641609216"
    const msg2 = "248476693641609220"
    const msg3 = "248476693641609230"
    const chunk1 = "248476693641609240"
    const ack1 = "248476693641609250"
    const exit1 = "248476693641609260"
    const int1 = "248476693641609270"
    const orphan1 = "248476693641609280"

    // 1. Insert requests (null optional params + primaryKeyHash)
    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: msg1,
        seqKey: padSeqKey(msg1),
        primaryKeyHash: "pk-1",
        shardId: "shard-0",
        entityType: "HarnessTask",
        entityId: "run-1",
        tag: "Run",
        payload: JSON.stringify({ step: 1 }),
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: msg1,
        deliverAtMs: null,
      },
    })

    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: msg2,
        seqKey: padSeqKey(msg2),
        primaryKeyHash: null,
        shardId: "shard-0",
        entityType: "OtherEntity",
        entityId: "other-1",
        tag: "Ping",
        payload: "{}",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: msg2,
        deliverAtMs: 1_000,
      },
    })

    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: msg3,
        seqKey: padSeqKey(msg3),
        primaryKeyHash: null,
        shardId: "shard-0",
        entityType: "HarnessTask",
        entityId: "run-1",
        tag: "Delayed",
        payload: "{}",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: msg3,
        deliverAtMs: 9_999_999_999_999,
      },
    })

    // 2. Primary key lookup & message batch lookup
    const pkRes = await og.queries.invoke("wf_message_by_pk", {
      branch: "main",
      expectMutation: false,
      params: { primaryKeyHash: "pk-1" },
    })
    const pkRows = requireRows(pkRes)
    expect(pkRows).toHaveLength(1)
    expect(pkRows[0]?.messageKey).toBe(msg1)
    expect(pkRows[0]?.seqKey).toBe(padSeqKey(msg1))

    // 3. Unprocessed candidate queries (unfiltered vs address-filtered before limit 1024)
    const candAll = await og.queries.invoke("wf_unprocessed_candidate_messages", {
      branch: "main",
      expectMutation: false,
      params: { shardIds: ["shard-0"], claimCutoffMs: 500, nowMs: 2_000 },
    })
    expect(requireRows(candAll).map((r) => r.messageKey)).toEqual([msg1, msg2])

    const candAddr = await og.queries.invoke("wf_unprocessed_candidate_messages_for_addresses", {
      branch: "main",
      expectMutation: false,
      params: {
        shardIds: ["shard-0"],
        entityType: "HarnessTask",
        entityIds: ["run-1"],
        claimCutoffMs: 500,
        nowMs: 2_000,
      },
    })
    expect(requireRows(candAddr).map((r) => r.messageKey)).toEqual([msg1])

    // Single-entityType filter rejects another entityType even when entityId matches
    const crossTypeMsg = "248476693641609225"
    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: crossTypeMsg,
        seqKey: padSeqKey(crossTypeMsg),
        primaryKeyHash: null,
        shardId: "shard-0",
        entityType: "OtherEntity",
        entityId: "run-1",
        tag: "Ping",
        payload: "{}",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: crossTypeMsg,
        deliverAtMs: null,
      },
    })
    const candAddrSingleType = await og.queries.invoke(
      "wf_unprocessed_candidate_messages_for_addresses",
      {
        branch: "main",
        expectMutation: false,
        params: {
          shardIds: ["shard-0"],
          entityType: "HarnessTask",
          entityIds: ["run-1"],
          claimCutoffMs: 500,
          nowMs: 2_000,
        },
      },
    )
    expect(requireRows(candAddrSingleType).map((r) => r.messageKey)).toEqual([msg1])

    // 4. Claim & resets
    await og.queries.invoke("wf_claim_messages", {
      branch: "main",
      expectMutation: true,
      params: { messageKeys: [msg1], nowMs: 1_500 },
    })
    const candAfterClaim = await og.queries.invoke("wf_unprocessed_candidate_messages", {
      branch: "main",
      expectMutation: false,
      params: { shardIds: ["shard-0"], claimCutoffMs: 500, nowMs: 2_000 },
    })
    expect(requireRows(candAfterClaim).map((r) => r.messageKey)).toEqual([msg2, crossTypeMsg])

    const byId = await og.queries.invoke("wf_unprocessed_messages_by_id", {
      branch: "main",
      expectMutation: false,
      params: { messageKeys: [msg1, msg3], nowMs: 2_000 },
    })
    expect(requireRows(byId).map((r) => r.messageKey)).toEqual([msg1])

    await og.queries.invoke("wf_reset_requests", {
      branch: "main",
      expectMutation: true,
      params: { messageKeys: [msg1], clearReadMs: null },
    })
    await og.queries.invoke("wf_reset_address_group", {
      branch: "main",
      expectMutation: true,
      params: {
        shardId: "shard-0",
        entityType: "HarnessTask",
        entityIds: ["run-1"],
        clearReadMs: null,
      },
    })
    await og.queries.invoke("wf_reset_address", {
      branch: "main",
      expectMutation: true,
      params: {
        shardId: "shard-0",
        entityType: "OtherEntity",
        entityId: "other-1",
        clearReadMs: null,
      },
    })
    await og.queries.invoke("wf_reset_shards", {
      branch: "main",
      expectMutation: true,
      params: { shardIds: ["shard-0"], clearReadMs: null },
    })

    // 5. Chunk + AckChunk + Interrupt + WithExit + replies queries
    await og.queries.invoke("wf_save_reply_chunk", {
      branch: "main",
      expectMutation: true,
      params: {
        replyKey: chunk1,
        seqKey: padSeqKey(chunk1),
        requestId: msg1,
        payload: JSON.stringify({ part: 1 }),
        sequence: 0,
      },
    })
    await og.queries.invoke("wf_insert_ack_chunk", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: ack1,
        seqKey: padSeqKey(ack1),
        primaryKeyHash: null,
        shardId: "shard-0",
        entityType: "HarnessTask",
        entityId: "run-1",
        requestId: msg1,
        replyId: chunk1,
        deliverAtMs: null,
      },
    })
    await og.queries.invoke("wf_insert_interrupt", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: int1,
        seqKey: padSeqKey(int1),
        primaryKeyHash: null,
        shardId: "shard-0",
        entityType: "HarnessTask",
        entityId: "run-1",
        requestId: msg1,
        deliverAtMs: null,
      },
    })
    await og.queries.invoke("wf_save_reply_exit", {
      branch: "main",
      expectMutation: true,
      params: {
        replyKey: exit1,
        seqKey: padSeqKey(exit1),
        requestId: msg1,
        payload: JSON.stringify({ ok: true }),
      },
    })
    const repliesFiltered = await og.queries.invoke("wf_replies_for", {
      branch: "main",
      expectMutation: false,
      params: { requestIds: [msg1] },
    })
    expect(requireRows(repliesFiltered).map((r) => r.replyKey)).toEqual([exit1])
    const repliesUnfiltered = await og.queries.invoke("wf_replies_for_unfiltered", {
      branch: "main",
      expectMutation: false,
      params: { requestIds: [msg1] },
    })
    expect(requireRows(repliesUnfiltered).map((r) => r.replyKey)).toEqual([chunk1, exit1])

    // 6. clearReplies CAS delete (preserves Interrupt) + dangling repair + CAS reset on BOTH request & interrupt + unconditional clear
    await og.queries.invoke("wf_clear_replies_cas_delete", {
      branch: "main",
      expectMutation: true,
      params: { requestId: msg1 },
    })
    const dangling = await og.queries.invoke("wf_dangling_processed_requests", {
      branch: "main",
      expectMutation: false,
    })
    expect(requireRows(dangling).map((r) => r.messageKey)).toEqual([msg1])
    await og.queries.invoke("wf_repair_dangling_requests", {
      branch: "main",
      expectMutation: true,
      params: { messageKeys: [msg1], clearReplyId: null, clearReadMs: null },
    })
    const repairedList = requireRows(
      await og.queries.invoke("wf_messages_by_keys", {
        branch: "main",
        expectMutation: false,
        params: { messageKeys: [msg1, int1] },
      }),
    )
    expect(repairedList).toHaveLength(2)
    for (const row of repairedList) {
      expect(row.processed).toBe(false)
      expect(row.lastReplyId ?? null).toBeNull()
      expect(row.lastReadMs ?? null).toBeNull()
    }

    // Re-save exit so BOTH msg1 and int1 get lastReplyId = exit1 & processed = true, then test CAS reset
    const exit2 = "248476693641609265"
    await og.queries.invoke("wf_save_reply_exit", {
      branch: "main",
      expectMutation: true,
      params: {
        replyKey: exit2,
        seqKey: padSeqKey(exit2),
        requestId: msg1,
        payload: JSON.stringify({ ok: true }),
      },
    })
    await og.queries.invoke("wf_clear_replies_cas_delete", {
      branch: "main",
      expectMutation: true,
      params: { requestId: msg1 },
    })
    await og.queries.invoke("wf_reset_message_for_clear_cas", {
      branch: "main",
      expectMutation: true,
      params: {
        requestId: msg1,
        expectedReplyId: exit2,
        clearReplyId: null,
        clearReadMs: null,
      },
    })
    const casResetList = requireRows(
      await og.queries.invoke("wf_messages_by_keys", {
        branch: "main",
        expectMutation: false,
        params: { messageKeys: [msg1, int1] },
      }),
    )
    expect(casResetList).toHaveLength(2)
    for (const row of casResetList) {
      expect(row.processed).toBe(false)
      expect(row.lastReplyId ?? null).toBeNull()
      expect(row.lastReadMs ?? null).toBeNull()
    }

    await og.queries.invoke("wf_clear_replies_unconditional_delete", {
      branch: "main",
      expectMutation: true,
      params: { requestId: msg1 },
    })
    await og.queries.invoke("wf_reset_message_for_clear", {
      branch: "main",
      expectMutation: true,
      params: { requestId: msg1, clearReplyId: null, clearReadMs: null },
    })

    const msg1AfterClearList = requireRows(
      await og.queries.invoke("wf_messages_by_keys", {
        branch: "main",
        expectMutation: false,
        params: { messageKeys: [msg1, int1] },
      }),
    )
    expect(msg1AfterClearList).toHaveLength(1)
    expect(msg1AfterClearList[0]?.messageKey).toBe(msg1)
    expect(msg1AfterClearList[0]?.lastReplyId ?? null).toBeNull()
    expect(msg1AfterClearList[0]?.lastReadMs ?? null).toBeNull()
    expect(msg1AfterClearList[0]?.processed).toBe(false)

    // 7. Orphan entityType scan + quarantine + pagination + count
    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: orphan1,
        seqKey: padSeqKey(orphan1),
        primaryKeyHash: null,
        shardId: "shard-0",
        entityType: "UnknownLegacyEntity",
        entityId: "legacy-1",
        tag: "Run",
        payload: "{}",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: orphan1,
        deliverAtMs: null,
      },
    })
    const orphans = await og.queries.invoke("wf_orphan_entity_messages", {
      branch: "main",
      expectMutation: false,
      params: { knownEntityTypes: ["HarnessTask", "OtherEntity"] },
    })
    expect(requireRows(orphans).map((r) => r.messageKey)).toEqual([orphan1])
    await og.queries.invoke("wf_quarantine_orphan_messages", {
      branch: "main",
      expectMutation: true,
      params: { messageKeys: [orphan1] },
    })

    const countRows = requireRows(
      await og.queries.invoke("wf_count_all", {
        branch: "main",
        expectMutation: false,
      }),
    )
    expect(countRows[0]?.totalMessages).toBe(6)

    const replyCountRows = requireRows(
      await og.queries.invoke("wf_count_replies", {
        branch: "main",
        expectMutation: false,
      }),
    )
    expect(replyCountRows[0]?.totalReplies).toBe(1)

    const pageRows = requireRows(
      await og.queries.invoke("wf_all_entities", {
        branch: "main",
        expectMutation: false,
        params: { afterSeqKey: "" },
      }),
    )
    expect(pageRows).toHaveLength(6)
    const repliesPageRows = requireRows(
      await og.queries.invoke("wf_all_replies", {
        branch: "main",
        expectMutation: false,
        params: { afterSeqKey: "" },
      }),
    )
    expect(repliesPageRows.map((r) => r.replyKey)).toEqual([chunk1])

    // 8. WfWriterLease CAS lifecycle
    await og.queries.invoke("wf_insert_writer_lease", {
      branch: "main",
      expectMutation: true,
      params: { name: "engine", owner: "daemon-1", leaseEpoch: 1, heartbeatMs: 1000 },
    })
    await og.queries.invoke("wf_cas_writer_lease", {
      branch: "main",
      expectMutation: true,
      params: {
        name: "engine",
        expectedEpoch: 1,
        owner: "daemon-2",
        nextEpoch: 2,
        heartbeatMs: 2000,
      },
    })
    await og.queries.invoke("wf_refresh_writer_lease", {
      branch: "main",
      expectMutation: true,
      params: { name: "engine", owner: "daemon-2", expectedEpoch: 2, heartbeatMs: 3000 },
    })
    const leaseRows = requireRows(
      await og.queries.invoke("wf_get_writer_lease", {
        branch: "main",
        expectMutation: false,
        params: { name: "engine" },
      }),
    )
    expect(leaseRows[0]).toMatchObject({
      name: "engine",
      owner: "daemon-2",
      leaseEpoch: 2,
      heartbeatMs: 3000,
    })

    // 9. clearAddress + replies_by_keys + reply_by_key
    const singleReplyRows = requireRows(
      await og.queries.invoke("wf_reply_by_key", {
        branch: "main",
        expectMutation: false,
        params: { replyKey: chunk1 },
      }),
    )
    expect(singleReplyRows).toHaveLength(1)
    const batchRepliesRows = requireRows(
      await og.queries.invoke("wf_replies_by_keys", {
        branch: "main",
        expectMutation: false,
        params: { replyKeys: [chunk1] },
      }),
    )
    expect(batchRepliesRows).toHaveLength(1)

    const keysRows = requireRows(
      await og.queries.invoke("wf_message_keys_for_address", {
        branch: "main",
        expectMutation: false,
        params: { entityType: "HarnessTask", entityId: "run-1" },
      }),
    )
    const reqIds = Array.from(new Set(keysRows.map((r) => String(r.requestId))))
    expect(reqIds.length).toBeGreaterThan(0)
    await og.queries.invoke("wf_clear_address", {
      branch: "main",
      expectMutation: true,
      params: {
        requestIds: reqIds,
        entityType: "HarnessTask",
        entityId: "run-1",
      },
    })
    const keysAfterClear = requireRows(
      await og.queries.invoke("wf_message_keys_for_address", {
        branch: "main",
        expectMutation: false,
        params: { entityType: "HarnessTask", entityId: "run-1" },
      }),
    )
    expect(keysAfterClear).toEqual([])
    const repliesAfterClear = requireRows(
      await og.queries.invoke("wf_replies_for_unfiltered", {
        branch: "main",
        expectMutation: false,
        params: { requestIds: reqIds },
      }),
    )
    expect(repliesAfterClear).toEqual([])
  })

  it("executes all WF-3 read-model stored queries end-to-end against live Omnigraph 0.14.0", async () => {
    const og = makeWorkflowOmnigraphClient({
      baseUrl: serverBaseUrl,
      token: cliToken,
    })

    const runId1 = "wf3-run-001"
    const runId2 = "wf3-run-002"
    const planSha1 = "1".repeat(64)
    const planSha2 = "2".repeat(64)
    const baseSha1 = "a".repeat(40)
    const baseSha2 = "b".repeat(40)
    const stampHash = "c".repeat(64)

    // 1. Missing/empty lookups return empty rows
    expect(
      requireRows(
        await og.queries.invoke("wf_probe_runs", {
          branch: "main",
          expectMutation: false,
          params: {},
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_list_runs", {
          branch: "main",
          expectMutation: false,
          params: {},
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_get_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf3-missing-run" },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_get_unit", {
          branch: "main",
          expectMutation: false,
          params: { unitKey: "wf3-missing-run/unit-0" },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_units_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf3-missing-run" },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_get_attempt", {
          branch: "main",
          expectMutation: false,
          params: { attemptKey: "wf3-missing-run/unit-0#1" },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_attempts_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: "wf3-missing-run" },
        }),
      ),
    ).toEqual([])

    // 2. WfRun lifecycle: wf_insert_run, wf_get_run, wf_list_runs, wf_update_run
    const planJson1 = JSON.stringify({ runId: runId1, level: "epic" })
    await og.queries.invoke("wf_insert_run", {
      branch: "main",
      expectMutation: true,
      params: {
        runId: runId1,
        executionId: "exec-wf3-001",
        level: "epic",
        planSha: planSha1,
        baseSha: baseSha1,
        state: "running",
        planJson: planJson1,
        updatedMs: 1_000,
      },
    })
    await og.queries.invoke("wf_insert_run", {
      branch: "main",
      expectMutation: true,
      params: {
        runId: runId2,
        executionId: "exec-wf3-002",
        level: "slice",
        planSha: planSha2,
        baseSha: baseSha2,
        state: "waiting",
        planJson: null,
        updatedMs: 2_000,
      },
    })

    const gotRun1 = requireRows(
      await og.queries.invoke("wf_get_run", {
        branch: "main",
        expectMutation: false,
        params: { runId: runId1 },
      }),
    )
    expect(gotRun1).toHaveLength(1)
    expect(gotRun1[0]).toMatchObject({
      runId: runId1,
      executionId: "exec-wf3-001",
      level: "epic",
      planSha: planSha1,
      baseSha: baseSha1,
      state: "running",
      planJson: planJson1,
      updatedMs: 1_000,
    })

    const gotRun2 = requireRows(
      await og.queries.invoke("wf_get_run", {
        branch: "main",
        expectMutation: false,
        params: { runId: runId2 },
      }),
    )
    expect(gotRun2).toHaveLength(1)
    expect(gotRun2[0]?.planJson ?? null).toBeNull()

    const listedBeforeUpdate = requireRows(
      await og.queries.invoke("wf_list_runs", {
        branch: "main",
        expectMutation: false,
        params: {},
      }),
    )
    expect(listedBeforeUpdate.map((r) => r.runId)).toEqual([runId2, runId1])

    const probedPopulated = requireRows(
      await og.queries.invoke("wf_probe_runs", {
        branch: "main",
        expectMutation: false,
        params: {},
      }),
    )
    expect(probedPopulated).toHaveLength(1)
    expect(Object.keys(probedPopulated[0] ?? {})).toEqual(["runId"])
    expect([runId1, runId2]).toContain(probedPopulated[0]?.runId)

    await og.queries.invoke("wf_update_run", {
      branch: "main",
      expectMutation: true,
      params: {
        runId: runId1,
        state: "completed",
        updatedMs: 3_000,
      },
    })
    const gotRun1Updated = requireRows(
      await og.queries.invoke("wf_get_run", {
        branch: "main",
        expectMutation: false,
        params: { runId: runId1 },
      }),
    )
    expect(gotRun1Updated[0]).toMatchObject({
      runId: runId1,
      state: "completed",
      updatedMs: 3_000,
    })
    const listedAfterUpdate = requireRows(
      await og.queries.invoke("wf_list_runs", {
        branch: "main",
        expectMutation: false,
        params: {},
      }),
    )
    expect(listedAfterUpdate.map((r) => r.runId)).toEqual([runId1, runId2])

    // 3. WfUnit lifecycle: wf_insert_unit, wf_get_unit, wf_units_for_run, wf_update_unit
    const unitKey1b = `${runId1}/unit-b`
    const unitKey1a = `${runId1}/unit-a`
    const unitKey2a = `${runId2}/unit-other`
    await og.queries.invoke("wf_insert_unit", {
      branch: "main",
      expectMutation: true,
      params: {
        unitKey: unitKey1b,
        runId: runId1,
        unitId: "unit-b",
        kind: "package",
        waveIndex: 1,
        status: "pending",
        ownedRelPaths: ["libs/harness/graph/src/index.ts", "libs/harness/graph/test"],
        updatedMs: 1_100,
      },
    })
    await og.queries.invoke("wf_insert_unit", {
      branch: "main",
      expectMutation: true,
      params: {
        unitKey: unitKey1a,
        runId: runId1,
        unitId: "unit-a",
        kind: "slice",
        waveIndex: 0,
        status: "dispatched",
        ownedRelPaths: ["libs/harness/contract/src"],
        updatedMs: 1_200,
      },
    })
    await og.queries.invoke("wf_insert_unit", {
      branch: "main",
      expectMutation: true,
      params: {
        unitKey: unitKey2a,
        runId: runId2,
        unitId: "unit-other",
        kind: "package",
        waveIndex: 0,
        status: "pending",
        ownedRelPaths: ["apps/harness-cli/src"],
        updatedMs: 2_100,
      },
    })

    const gotUnit1b = requireRows(
      await og.queries.invoke("wf_get_unit", {
        branch: "main",
        expectMutation: false,
        params: { unitKey: unitKey1b },
      }),
    )
    expect(gotUnit1b).toHaveLength(1)
    expect(gotUnit1b[0]).toMatchObject({
      unitKey: unitKey1b,
      runId: runId1,
      unitId: "unit-b",
      kind: "package",
      waveIndex: 1,
      status: "pending",
      ownedRelPaths: ["libs/harness/graph/src/index.ts", "libs/harness/graph/test"],
      updatedMs: 1_100,
    })

    await og.queries.invoke("wf_update_unit", {
      branch: "main",
      expectMutation: true,
      params: {
        unitKey: unitKey1a,
        status: "completed",
        updatedMs: 1_500,
      },
    })
    const gotUnit1a = requireRows(
      await og.queries.invoke("wf_get_unit", {
        branch: "main",
        expectMutation: false,
        params: { unitKey: unitKey1a },
      }),
    )
    expect(gotUnit1a[0]).toMatchObject({
      unitKey: unitKey1a,
      status: "completed",
      updatedMs: 1_500,
    })

    const unitsForRun1 = requireRows(
      await og.queries.invoke("wf_units_for_run", {
        branch: "main",
        expectMutation: false,
        params: { runId: runId1 },
      }),
    )
    expect(unitsForRun1.map((u) => u.unitKey)).toEqual([unitKey1a, unitKey1b])

    // 4. WfAttempt lifecycle: wf_insert_attempt, wf_get_attempt, wf_attempts_for_run, wf_update_attempt
    const attemptKey1a1 = `${runId1}/unit-a#1`
    const attemptKey1a2 = `${runId1}/unit-a#2`
    const attemptKey2a1 = `${runId2}/unit-other#1`
    await og.queries.invoke("wf_insert_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        attemptKey: attemptKey1a2,
        runId: runId1,
        unitId: "unit-a",
        attempt: 2,
        verdict: "dispatched",
        runner: "antigravity",
        rejection: null,
        packageStampHash: null,
        updatedMs: 1_600,
      },
    })
    await og.queries.invoke("wf_insert_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        attemptKey: attemptKey1a1,
        runId: runId1,
        unitId: "unit-a",
        attempt: 1,
        verdict: "rejected",
        runner: "claude-code",
        rejection: JSON.stringify({ _tag: "StampMissing" }),
        packageStampHash: null,
        updatedMs: 1_300,
      },
    })
    await og.queries.invoke("wf_insert_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        attemptKey: attemptKey2a1,
        runId: runId2,
        unitId: "unit-other",
        attempt: 1,
        verdict: "dispatched",
        runner: null,
        rejection: null,
        packageStampHash: null,
        updatedMs: 2_200,
      },
    })

    const gotAttempt1 = requireRows(
      await og.queries.invoke("wf_get_attempt", {
        branch: "main",
        expectMutation: false,
        params: { attemptKey: attemptKey1a1 },
      }),
    )
    expect(gotAttempt1).toHaveLength(1)
    expect(gotAttempt1[0]).toMatchObject({
      attemptKey: attemptKey1a1,
      runId: runId1,
      unitId: "unit-a",
      attempt: 1,
      verdict: "rejected",
      runner: "claude-code",
      rejection: JSON.stringify({ _tag: "StampMissing" }),
      updatedMs: 1_300,
    })
    expect(gotAttempt1[0]?.packageStampHash ?? null).toBeNull()

    await og.queries.invoke("wf_update_attempt", {
      branch: "main",
      expectMutation: true,
      params: {
        attemptKey: attemptKey1a2,
        verdict: "completed",
        runner: "antigravity",
        rejection: null,
        packageStampHash: stampHash,
        updatedMs: 1_900,
      },
    })
    const gotAttempt2 = requireRows(
      await og.queries.invoke("wf_get_attempt", {
        branch: "main",
        expectMutation: false,
        params: { attemptKey: attemptKey1a2 },
      }),
    )
    expect(gotAttempt2[0]).toMatchObject({
      attemptKey: attemptKey1a2,
      verdict: "completed",
      runner: "antigravity",
      packageStampHash: stampHash,
      updatedMs: 1_900,
    })
    expect(gotAttempt2[0]?.rejection ?? null).toBeNull()

    const attemptsForRun1 = requireRows(
      await og.queries.invoke("wf_attempts_for_run", {
        branch: "main",
        expectMutation: false,
        params: { runId: runId1 },
      }),
    )
    expect(attemptsForRun1.map((a) => a.attemptKey)).toEqual([attemptKey1a1, attemptKey1a2])

    // 5. wf_delete_run_views removes all WfAttempt, WfUnit, WfRun for runId1 while preserving runId2
    await og.queries.invoke("wf_delete_run_views", {
      branch: "main",
      expectMutation: true,
      params: { runId: runId1 },
    })
    expect(
      requireRows(
        await og.queries.invoke("wf_get_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId1 },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_units_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId1 },
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_attempts_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId1 },
        }),
      ),
    ).toEqual([])

    expect(
      requireRows(
        await og.queries.invoke("wf_list_runs", {
          branch: "main",
          expectMutation: false,
          params: {},
        }),
      ).map((r) => r.runId),
    ).toEqual([runId2])
    expect(
      requireRows(
        await og.queries.invoke("wf_units_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId2 },
        }),
      ).map((u) => u.unitKey),
    ).toEqual([unitKey2a])
    expect(
      requireRows(
        await og.queries.invoke("wf_attempts_for_run", {
          branch: "main",
          expectMutation: false,
          params: { runId: runId2 },
        }),
      ).map((a) => a.attemptKey),
    ).toEqual([attemptKey2a1])

    // Clean up remaining runId2 views
    await og.queries.invoke("wf_delete_run_views", {
      branch: "main",
      expectMutation: true,
      params: { runId: runId2 },
    })
    expect(
      requireRows(
        await og.queries.invoke("wf_list_runs", {
          branch: "main",
          expectMutation: false,
          params: {},
        }),
      ),
    ).toEqual([])
    expect(
      requireRows(
        await og.queries.invoke("wf_probe_runs", {
          branch: "main",
          expectMutation: false,
          params: {},
        }),
      ),
    ).toEqual([])
  })

  it("exports resolveGitCommonDir, error classifiers, and workflow client helpers", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "wf2-git-common-"))
    tempDirs.push(tmpRoot)

    const nonGit = join(tmpRoot, "plain")
    mkdirSync(nonGit, { recursive: true })
    expect(resolveGitCommonDir(nonGit, testHostIo)).toBeNull()

    const primary = join(tmpRoot, "primary")
    mkdirSync(join(primary, ".git"), { recursive: true })
    expect(resolveGitCommonDir(primary, testHostIo)).toBe(join(primary, ".git"))

    const wtWithCommon = join(tmpRoot, "wt-common")
    const wtGitDir = join(primary, ".git", "worktrees", "wt-1")
    mkdirSync(wtWithCommon, { recursive: true })
    mkdirSync(wtGitDir, { recursive: true })
    writeFileSync(join(wtWithCommon, ".git"), `gitdir: ${wtGitDir}\n`, "utf8")
    writeFileSync(join(wtGitDir, "commondir"), "../..\n", "utf8")
    expect(resolveGitCommonDir(wtWithCommon, testHostIo)).toBe(join(primary, ".git"))

    const wtWithoutCommon = join(tmpRoot, "wt-no-common")
    const wtGitDir2 = join(primary, ".git", "worktrees", "wt-2")
    mkdirSync(wtWithoutCommon, { recursive: true })
    mkdirSync(wtGitDir2, { recursive: true })
    writeFileSync(join(wtWithoutCommon, ".git"), `gitdir: ${wtGitDir2}\n`, "utf8")
    expect(resolveGitCommonDir(wtWithoutCommon, testHostIo)).toBe(wtGitDir2)

    const throwingIo = makeExtendedTestHostIo({
      existsSync: () => {
        throw new Error("boom")
      },
    })
    expect(resolveGitCommonDir(primary, throwingIo)).toBeNull()

    const tooMany = new TooManyRequestsError({
      status: 429,
      message: "rate limited",
      request: { method: "POST", url: "http://127.0.0.1/query" },
    })
    const conflict = new ConflictError({
      status: 409,
      message: "conflict",
      request: { method: "POST", url: "http://127.0.0.1/mutate" },
    })
    const precondition = new PreconditionFailedError({
      status: 412,
      message: "stale",
      request: { method: "POST", url: "http://127.0.0.1/mutate" },
    })

    expect(isOmnigraphTooManyRequestsError(tooMany)).toBe(true)
    expect(isOmnigraphTooManyRequestsError({ status: 429 })).toBe(true)
    expect(isOmnigraphTooManyRequestsError(new OmnigraphLoadError({ cause: tooMany }))).toBe(true)
    expect(isOmnigraphTooManyRequestsError(conflict)).toBe(false)
    expect(isOmnigraphTooManyRequestsError(null)).toBe(false)

    const cyclic: Record<string, unknown> = {}
    cyclic.cause = cyclic
    expect(isOmnigraphTooManyRequestsError(cyclic)).toBe(false)

    expect(isOmnigraphPreconditionOrConflictError(precondition)).toBe(true)
    expect(isOmnigraphPreconditionOrConflictError(conflict)).toBe(true)
    expect(isOmnigraphPreconditionOrConflictError({ status: 412 })).toBe(true)
    expect(isOmnigraphPreconditionOrConflictError({ status: 409 })).toBe(true)
    expect(
      isOmnigraphPreconditionOrConflictError(new OmnigraphLoadError({ cause: precondition })),
    ).toBe(true)
    expect(isOmnigraphPreconditionOrConflictError(tooMany)).toBe(false)
    expect(isOmnigraphPreconditionOrConflictError("not-an-error")).toBe(false)

    expect(resolveOmnigraphGraphId(undefined, {})).toBe(HARNESS_OMNIGRAPH_GRAPH_ID)
    expect(resolveOmnigraphGraphId({ graphId: "custom" }, { OMNIGRAPH_GRAPH_ID: "env-g" })).toBe(
      "custom",
    )
    expect(resolveOmnigraphGraphId(undefined, { OMNIGRAPH_GRAPH_ID: "env-g" })).toBe("env-g")

    const cfg = resolveWorkflowOmnigraphConfig({ baseUrl: "http://127.0.0.1:19000", token: "tok" })
    expect(cfg).toEqual({
      baseUrl: "http://127.0.0.1:19000",
      graphId: WORKFLOW_OMNIGRAPH_GRAPH_ID,
      token: "tok",
    })
  })
})
