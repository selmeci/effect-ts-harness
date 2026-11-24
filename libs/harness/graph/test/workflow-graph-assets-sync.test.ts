import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ForbiddenError, NotFoundError, Omnigraph, UnauthorizedError } from "@modernrelay/omnigraph"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HARNESS_OMNIGRAPH_GRAPH_ID, WORKFLOW_OMNIGRAPH_GRAPH_ID } from "../src/index.js"
import {
  clearAddressRows,
  graphConfigDir,
  omnigraphBin,
  padSeqKey,
  requireRows,
  startWorkflowGraphServerHarness,
} from "./helpers/workflow-graph-server-fixture.js"

describe("Workflow graph disjoint Cedar policies & WfMessage claim/chunk sync", () => {
  const harness = startWorkflowGraphServerHarness("wf2-graph-sync-")
  const tempDirs = harness.tempDirs
  const createCliClient = () => harness.createCliClient()
  const mcpToken = harness.mcpToken
  beforeAll(() => harness.start(), 30_000)
  afterAll(() => harness.stop())

  it("validates disjoint policies per graph and requires --graph on multi-graph clusters", () => {
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
      baseUrl: harness.getServerBaseUrl(),
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
      baseUrl: harness.getServerBaseUrl(),
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
      baseUrl: harness.getServerBaseUrl(),
      graphId: WORKFLOW_OMNIGRAPH_GRAPH_ID,
      token: "invalid-token",
    })
    await expect(unauthWorkflowOg.snapshot({ branch: "main" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
  })

  it("inserts WfMessage requests and queries by primaryKeyHash and unprocessed candidates", async () => {
    const og = createCliClient()
    const msg1 = "248476693641609216"
    const msg2 = "248476693641609220"
    const msg3 = "248476693641609230"
    const crossTypeMsg = "248476693641609225"

    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: msg1,
        seqKey: padSeqKey(msg1),
        primaryKeyHash: "pk-1",
        shardId: "shard-0",
        entityType: "HarnessTask",
        entityId: "run-cand-1",
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
        entityId: "other-cand-1",
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
        entityId: "run-cand-1",
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
    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: crossTypeMsg,
        seqKey: padSeqKey(crossTypeMsg),
        primaryKeyHash: null,
        shardId: "shard-0",
        entityType: "OtherEntity",
        entityId: "run-cand-1",
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

    const pkRows = requireRows(
      await og.queries.invoke("wf_message_by_pk", {
        branch: "main",
        expectMutation: false,
        params: { primaryKeyHash: "pk-1" },
      }),
    )
    expect(pkRows).toHaveLength(1)
    expect(pkRows[0]?.messageKey).toBe(msg1)
    expect(pkRows[0]?.seqKey).toBe(padSeqKey(msg1))

    const candAll = await og.queries.invoke("wf_unprocessed_candidate_messages", {
      branch: "main",
      expectMutation: false,
      params: { shardIds: ["shard-0"], claimCutoffMs: 500, nowMs: 2_000 },
    })
    expect(requireRows(candAll).map((r) => r.messageKey)).toEqual([msg1, msg2, crossTypeMsg])

    const candAddr = await og.queries.invoke("wf_unprocessed_candidate_messages_for_addresses", {
      branch: "main",
      expectMutation: false,
      params: {
        shardIds: ["shard-0"],
        entityType: "HarnessTask",
        entityIds: ["run-cand-1"],
        claimCutoffMs: 500,
        nowMs: 2_000,
      },
    })
    expect(requireRows(candAddr).map((r) => r.messageKey)).toEqual([msg1])

    await clearAddressRows(og, "HarnessTask", "run-cand-1")
    await clearAddressRows(og, "OtherEntity", "other-cand-1")
    await clearAddressRows(og, "OtherEntity", "run-cand-1")
  })

  it("claims and resets unprocessed WfMessage rows across requests, addresses, groups, and shards", async () => {
    const og = createCliClient()
    const msg1 = "248476693641619216"
    const msg2 = "248476693641619220"
    const msg3 = "248476693641619230"

    for (const [key, entityType, entityId, deliverAtMs] of [
      [msg1, "HarnessTask", "run-claim-1", null],
      [msg2, "OtherEntity", "other-claim-1", 1_000],
      [msg3, "HarnessTask", "run-claim-1", 9_999_999_999_999],
    ] as const) {
      await og.queries.invoke("wf_insert_request_message", {
        branch: "main",
        expectMutation: true,
        params: {
          messageKey: key,
          seqKey: padSeqKey(key),
          primaryKeyHash: null,
          shardId: "shard-1",
          entityType,
          entityId,
          tag: "Run",
          payload: "{}",
          headers: "{}",
          traceId: null,
          spanId: null,
          sampled: null,
          requestId: key,
          deliverAtMs,
        },
      })
    }

    await og.queries.invoke("wf_claim_messages", {
      branch: "main",
      expectMutation: true,
      params: { messageKeys: [msg1], nowMs: 1_500 },
    })
    const candAfterClaim = await og.queries.invoke("wf_unprocessed_candidate_messages", {
      branch: "main",
      expectMutation: false,
      params: { shardIds: ["shard-1"], claimCutoffMs: 500, nowMs: 2_000 },
    })
    expect(requireRows(candAfterClaim).map((r) => r.messageKey)).toEqual([msg2])

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
        shardId: "shard-1",
        entityType: "HarnessTask",
        entityIds: ["run-claim-1"],
        clearReadMs: null,
      },
    })
    await og.queries.invoke("wf_reset_address", {
      branch: "main",
      expectMutation: true,
      params: {
        shardId: "shard-1",
        entityType: "OtherEntity",
        entityId: "other-claim-1",
        clearReadMs: null,
      },
    })
    await og.queries.invoke("wf_reset_shards", {
      branch: "main",
      expectMutation: true,
      params: { shardIds: ["shard-1"], clearReadMs: null },
    })

    const candAfterReset = await og.queries.invoke("wf_unprocessed_candidate_messages", {
      branch: "main",
      expectMutation: false,
      params: { shardIds: ["shard-1"], claimCutoffMs: 500, nowMs: 2_000 },
    })
    expect(requireRows(candAfterReset).map((r) => r.messageKey)).toEqual([msg1, msg2])

    await clearAddressRows(og, "HarnessTask", "run-claim-1")
    await clearAddressRows(og, "OtherEntity", "other-claim-1")
  })

  it("handles reply chunks, ack chunks, interrupts, CAS reply clear, dangling repair, and unconditional clear", async () => {
    const og = createCliClient()
    const msg1 = "248476693641629216"
    const chunk1 = "248476693641629240"
    const ack1 = "248476693641629250"
    const exit1 = "248476693641629260"
    const exit2 = "248476693641629265"
    const int1 = "248476693641629270"

    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: msg1,
        seqKey: padSeqKey(msg1),
        primaryKeyHash: null,
        shardId: "shard-2",
        entityType: "HarnessTask",
        entityId: "run-reply-1",
        tag: "Run",
        payload: "{}",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: msg1,
        deliverAtMs: null,
      },
    })
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
        shardId: "shard-2",
        entityType: "HarnessTask",
        entityId: "run-reply-1",
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
        shardId: "shard-2",
        entityType: "HarnessTask",
        entityId: "run-reply-1",
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
    expect(msg1AfterClearList[0]?.processed).toBe(false)

    await clearAddressRows(og, "HarnessTask", "run-reply-1")
  })

  it("scans and quarantines orphan entity messages, counts rows, and paginates entities and replies", async () => {
    const og = createCliClient()
    const msg1 = "248476693641639216"
    const orphan1 = "248476693641639280"
    const chunk1 = "248476693641639240"

    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: msg1,
        seqKey: padSeqKey(msg1),
        primaryKeyHash: null,
        shardId: "shard-3",
        entityType: "HarnessTask",
        entityId: "run-orphan-1",
        tag: "Run",
        payload: "{}",
        headers: "{}",
        traceId: null,
        spanId: null,
        sampled: null,
        requestId: msg1,
        deliverAtMs: null,
      },
    })
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
    await og.queries.invoke("wf_insert_request_message", {
      branch: "main",
      expectMutation: true,
      params: {
        messageKey: orphan1,
        seqKey: padSeqKey(orphan1),
        primaryKeyHash: null,
        shardId: "shard-3",
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
      await og.queries.invoke("wf_count_all", { branch: "main", expectMutation: false }),
    )
    expect(countRows[0]?.totalMessages).toBe(2)

    const replyCountRows = requireRows(
      await og.queries.invoke("wf_count_replies", { branch: "main", expectMutation: false }),
    )
    expect(replyCountRows[0]?.totalReplies).toBe(1)

    const pageRows = requireRows(
      await og.queries.invoke("wf_all_entities", {
        branch: "main",
        expectMutation: false,
        params: { afterSeqKey: "" },
      }),
    )
    expect(pageRows).toHaveLength(2)

    const repliesPageRows = requireRows(
      await og.queries.invoke("wf_all_replies", {
        branch: "main",
        expectMutation: false,
        params: { afterSeqKey: "" },
      }),
    )
    expect(repliesPageRows.map((r) => r.replyKey)).toEqual([chunk1])

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

    await clearAddressRows(og, "HarnessTask", "run-orphan-1")
    await clearAddressRows(og, "UnknownLegacyEntity", "legacy-1")
    const repliesAfterClear = requireRows(
      await og.queries.invoke("wf_replies_for_unfiltered", {
        branch: "main",
        expectMutation: false,
        params: { requestIds: [msg1] },
      }),
    )
    expect(repliesAfterClear).toEqual([])
  })
})
