import { Cause, Clock, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { DurableDeferred } from "effect/workflow"
import { match } from "ts-pattern"
import { describe, expect, it } from "@effect/vitest"
import {
  AbsoluteRepoRoot,
  AttemptNumber,
  CompiledPlan as CompiledPlanSchema,
  type CompiledPlan,
  type CompiledWorkUnit,
  EarsRequirementKey,
  EscalationDecision,
  EscalationOrdinal,
  EscalationResolution,
  FrictionLogState,
  GateExitCode,
  GitCommitSha,
  LlmPhaseReceipt,
  MergeSliceWaveOutcome,
  MessageKey,
  NxProjectName,
  OwnedRelPath,
  PackageStampHash,
  PackageVerifyCommand,
  PlanSha256,
  ReviewDepth,
  ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewRoutingSource,
  SHARED_STEP_UNIT_ID,
  SliceBranchName,
  StubSymbolKey,
  UnitOutcome,
  UnitRejection,
  WaveIndex,
  WorkUnitId,
  type WorkflowAttemptKey,
  type WorkflowAttemptRecord,
  WorkflowExecutionId,
  type WorkflowRunId,
  WorkflowRunId as WorkflowRunIdSchema,
  type WorkflowRunRecord,
  type WorkflowRunState,
  WorkflowStoreOperation,
  type WorkflowUnitRecord,
  type WorkflowUnitStatus,
  WorkspaceTreeHash,
  compareCodeUnits,
  encodeSeqKey,
} from "@harness/contract"
import {
  HarnessTaskWorkflow,
  HarnessTaskWorkflowLayer,
  LlmPhaseDone,
  executionIdOf,
  makeUnitCompletionDeferred,
  makeUnitEscalationDeferred,
} from "@harness/gates"
import { OmnigraphClient as OmnigraphClientClass } from "@harness/graph"
import {
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowReadModelQuery,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import { makeHarnessWorkflowEngineLayer } from "../src/workflow-engine-live.js"
import {
  makeWorkflowProjectionWriterLayer,
  makeWorkflowReadModelQueryLayer,
  rebuildWorkflowReadModelViews,
} from "../src/workflow/read-model-live.js"
import {
  reconstructJournalViews,
  replayActivityMessage,
} from "../src/workflow/read-model-rebuild-journal.js"
import { WorkflowTimestampMs } from "@harness/contract"

type OmnigraphClient = InstanceType<typeof OmnigraphClientClass>
type RowMap = Readonly<Record<string, unknown>>

const CANONICAL_ROOT = AbsoluteRepoRoot.make("/tmp/harness-wf3-diff-repo")
const BASE_SHA = GitCommitSha.make("1".repeat(40))
const PLAN_SHA = PlanSha256.make("2".repeat(64))
const TREE_HASH = WorkspaceTreeHash.make("3".repeat(64))
const STAMP_A = PackageStampHash.make("a".repeat(64))
const STAMP_B = PackageStampHash.make("b".repeat(64))
const NORMALIZED_TS = WorkflowTimestampMs.make(0)

const asString = (val: unknown): string | null => (typeof val === "string" ? val : null)
const strVal = (val: unknown, fallback: string = ""): string =>
  typeof val === "string" ? val : fallback
const asNullableNumber = (val: unknown): number | null =>
  typeof val === "number" && Number.isFinite(val) ? val : null
const asStringArray = (val: unknown): ReadonlyArray<string> =>
  Array.isArray(val) ? val.filter((entry): entry is string => typeof entry === "string") : []
const asStringSet = (val: unknown): Set<string> => new Set(asStringArray(val))
const hasRowField = (
  row: Readonly<Record<string, unknown>>,
  field: string,
  expected: string,
): boolean => row[field] === expected

const makeInMemoryWorkflowOmnigraphClient = (): OmnigraphClient => {
  const messages = new Map<string, Record<string, unknown>>()
  const replies = new Map<string, Record<string, unknown>>()
  const runs = new Map<string, Record<string, unknown>>()
  const units = new Map<string, Record<string, unknown>>()
  const attempts = new Map<string, Record<string, unknown>>()
  let commitSeq = 1

  const nextCommit = (): string => {
    commitSeq += 1
    return `mem-commit-${commitSeq}`
  }

  const isActiveReplyRow = (r: Readonly<Record<string, unknown>>): boolean =>
    hasRowField(r, "kind", "with_exit") || (hasRowField(r, "kind", "chunk") && r.acked === false)

  const hasActiveReplyFor = (requestId: string): boolean => {
    for (const r of replies.values()) {
      if (r.requestId === requestId && isActiveReplyRow(r)) {
        return true
      }
    }
    return false
  }

  const baseClient = new OmnigraphClientClass({
    baseUrl: "http://127.0.0.1:1",
    graphId: "harness-workflows",
  })

  const invokeMock = (
    queryName: string,
    input?: { readonly params?: Readonly<Record<string, unknown>> | undefined },
  ): Promise<unknown> => {
    const p = input?.params ?? {}
    return Promise.resolve().then(() =>
      match(queryName)
        .with("wf_get_writer_lease", () => ({
          queryName,
          rowCount: 0,
          rows: [],
          graphCommitId: nextCommit(),
          target: { branch: "main" },
        }))
        .with("wf_orphan_entity_messages", () => ({
          queryName,
          rowCount: 0,
          rows: [],
          graphCommitId: nextCommit(),
          target: { branch: "main" },
        }))
        .with("wf_dangling_processed_requests", () => {
          const rows = Array.from(messages.values()).filter((m) => {
            if (m.processed !== true || !hasRowField(m, "kind", "request")) return false
            const reqId = asString(m.requestId)
            if (reqId === null) return false
            for (const r of replies.values()) {
              if (r.requestId === reqId && hasRowField(r, "kind", "with_exit")) return false
            }
            return true
          })
          return {
            queryName,
            rowCount: rows.length,
            rows: rows.map((m) => ({
              messageKey: m.messageKey,
              requestId: m.requestId,
              shardId: m.shardId,
              lastReplyId: m.lastReplyId ?? null,
            })),
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_repair_dangling_requests", () => {
          const keys = asStringSet(p.messageKeys)
          let count = 0
          for (const m of messages.values()) {
            const reqId = asString(m.requestId)
            if (reqId !== null && keys.has(reqId) && m.processed === true) {
              m.processed = false
              m.lastReplyId = p.clearReplyId ?? null
              m.lastReadMs = p.clearReadMs ?? null
              count += 1
            }
          }
          return {
            queryName,
            affectedNodes: count,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_message_by_pk", () => {
          const pkHash = asString(p.primaryKeyHash)
          const rows = Array.from(messages.values())
            .filter((m) => pkHash !== null && m.primaryKeyHash === pkHash)
            .map((m) => ({ ...m }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_messages_by_keys", () => {
          const keys = asStringSet(p.messageKeys)
          const rows = Array.from(messages.values())
            .filter((m) => keys.has(strVal(m.messageKey)))
            .sort((a, b) => compareCodeUnits(strVal(a.seqKey), strVal(b.seqKey)))
            .map((m) => ({ ...m }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_reply_by_key", () => {
          const row = replies.get(strVal(p.replyKey))
          return {
            queryName,
            rowCount: row === undefined ? 0 : 1,
            rows: row === undefined ? [] : [{ ...row }],
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_replies_by_keys", () => {
          const keys = asStringSet(p.replyKeys)
          const rows = Array.from(replies.values())
            .filter((r) => keys.has(strVal(r.replyKey)))
            .sort((a, b) => compareCodeUnits(strVal(a.seqKey), strVal(b.seqKey)))
            .map((r) => ({ ...r }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_replies_for", () => {
          const reqIds = asStringSet(p.requestIds)
          const rows = Array.from(replies.values())
            .filter((r) => reqIds.has(strVal(r.requestId)) && isActiveReplyRow(r))
            .sort((a, b) => compareCodeUnits(strVal(a.seqKey), strVal(b.seqKey)))
            .map((r) => ({ ...r }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_replies_for_unfiltered", () => {
          const reqIds = asStringSet(p.requestIds)
          const rows = Array.from(replies.values())
            .filter((r) => reqIds.has(strVal(r.requestId)))
            .sort((a, b) => compareCodeUnits(strVal(a.seqKey), strVal(b.seqKey)))
            .map((r) => ({ ...r }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_insert_request_message", () => {
          const messageKey = strVal(p.messageKey)
          const pkHash = p.primaryKeyHash === null ? null : asString(p.primaryKeyHash)
          if (pkHash !== null) {
            for (const existing of messages.values()) {
              if (existing.primaryKeyHash === pkHash) {
                throw Object.assign(new Error("unique constraint violation"), { status: 409 })
              }
            }
          }
          messages.set(messageKey, {
            messageKey,
            seqKey: strVal(p.seqKey),
            primaryKeyHash: pkHash,
            shardId: strVal(p.shardId),
            entityType: strVal(p.entityType),
            entityId: strVal(p.entityId),
            kind: "request",
            tag: strVal(p.tag),
            payload: strVal(p.payload),
            headers: strVal(p.headers, "{}"),
            traceId: p.traceId ?? null,
            spanId: p.spanId ?? null,
            sampled: p.sampled ?? null,
            requestId: strVal(p.requestId, messageKey),
            replyId: null,
            processed: false,
            lastReplyId: null,
            lastReadMs: null,
            deliverAtMs: p.deliverAtMs ?? null,
          })
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_insert_ack_chunk", () => {
          const messageKey = strVal(p.messageKey)
          const replyId = strVal(p.replyId)
          const requestId = strVal(p.requestId)
          const targetReply = replies.get(replyId)
          if (targetReply !== undefined) targetReply.acked = true
          for (const m of messages.values()) {
            if (
              m.processed === false &&
              m.requestId === requestId &&
              hasRowField(m, "kind", "ack_chunk")
            ) {
              m.processed = true
            }
          }
          messages.set(messageKey, {
            messageKey,
            seqKey: strVal(p.seqKey),
            primaryKeyHash: p.primaryKeyHash ?? null,
            shardId: strVal(p.shardId),
            entityType: strVal(p.entityType),
            entityId: strVal(p.entityId),
            kind: "ack_chunk",
            tag: null,
            payload: null,
            headers: null,
            traceId: null,
            spanId: null,
            sampled: null,
            requestId,
            replyId,
            processed: false,
            lastReplyId: null,
            lastReadMs: null,
            deliverAtMs: p.deliverAtMs ?? null,
          })
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_insert_interrupt", () => {
          const messageKey = strVal(p.messageKey)
          messages.set(messageKey, {
            messageKey,
            seqKey: strVal(p.seqKey),
            primaryKeyHash: p.primaryKeyHash ?? null,
            shardId: strVal(p.shardId),
            entityType: strVal(p.entityType),
            entityId: strVal(p.entityId),
            kind: "interrupt",
            tag: null,
            payload: null,
            headers: null,
            traceId: null,
            spanId: null,
            sampled: null,
            requestId: strVal(p.requestId),
            replyId: null,
            processed: false,
            lastReplyId: null,
            lastReadMs: null,
            deliverAtMs: p.deliverAtMs ?? null,
          })
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_save_reply_exit", () => {
          const replyKey = strVal(p.replyKey)
          const requestId = strVal(p.requestId)
          replies.set(replyKey, {
            replyKey,
            seqKey: strVal(p.seqKey),
            requestId,
            kind: "with_exit",
            payload: strVal(p.payload),
            sequence: null,
            acked: false,
          })
          for (const m of messages.values()) {
            if (m.requestId === requestId) {
              m.processed = true
              m.lastReplyId = replyKey
            }
          }
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_save_reply_chunk", () => {
          const replyKey = strVal(p.replyKey)
          const requestId = strVal(p.requestId)
          replies.set(replyKey, {
            replyKey,
            seqKey: strVal(p.seqKey),
            requestId,
            kind: "chunk",
            payload: strVal(p.payload),
            sequence: p.sequence ?? 0,
            acked: false,
          })
          for (const m of messages.values()) {
            if (m.messageKey === requestId) {
              m.lastReplyId = replyKey
            }
          }
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_clear_replies_unconditional_delete", () => {
          const reqId = strVal(p.requestId)
          let count = 0
          for (const [k, r] of replies.entries()) {
            if (r.requestId === reqId && hasRowField(r, "kind", "with_exit")) {
              replies.delete(k)
              count += 1
            }
          }
          for (const [k, m] of messages.entries()) {
            if (m.requestId === reqId && hasRowField(m, "kind", "interrupt")) {
              messages.delete(k)
              count += 1
            }
          }
          return {
            queryName,
            affectedNodes: count,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_clear_replies_cas_delete", () => {
          const reqId = strVal(p.requestId)
          let count = 0
          for (const [k, r] of replies.entries()) {
            if (r.requestId === reqId && hasRowField(r, "kind", "with_exit")) {
              replies.delete(k)
              count += 1
            }
          }
          return {
            queryName,
            affectedNodes: count,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_reset_message_for_clear", "wf_reset_message_for_clear_cas", () => {
          const reqId = strVal(p.requestId)
          const expectedReplyId = asString(p.expectedReplyId)
          let count = 0
          for (const m of messages.values()) {
            if (
              m.requestId === reqId &&
              (queryName === "wf_reset_message_for_clear" || m.lastReplyId === expectedReplyId)
            ) {
              m.processed = false
              m.lastReplyId = p.clearReplyId ?? null
              m.lastReadMs = p.clearReadMs ?? null
              count += 1
            }
          }
          return {
            queryName,
            affectedNodes: count,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with(
          "wf_unprocessed_candidate_messages",
          "wf_unprocessed_candidate_messages_for_addresses",
          () => {
            const shardSet = asStringSet(p.shardIds)
            const entityType = asString(p.entityType)
            const entityIds = asStringSet(p.entityIds)
            const claimCutoff = asNullableNumber(p.claimCutoffMs) ?? 0
            const nowMs = asNullableNumber(p.nowMs) ?? Date.now()
            const forAddresses = queryName === "wf_unprocessed_candidate_messages_for_addresses"
            const rows = Array.from(messages.values())
              .filter((m) => {
                if (!shardSet.has(strVal(m.shardId))) return false
                if (forAddresses) {
                  if (m.entityType !== entityType || !entityIds.has(strVal(m.entityId))) {
                    return false
                  }
                }
                if (m.processed !== false) return false
                const lastRead = asNullableNumber(m.lastReadMs)
                if (lastRead !== null && lastRead >= claimCutoff) return false
                const deliverAt = asNullableNumber(m.deliverAtMs)
                if (deliverAt !== null && deliverAt > nowMs) return false
                return !hasActiveReplyFor(strVal(m.requestId))
              })
              .sort((a, b) => compareCodeUnits(strVal(a.seqKey), strVal(b.seqKey)))
              .slice(0, 1024)
              .map((m) => ({ ...m }))
            return {
              queryName,
              rowCount: rows.length,
              rows,
              graphCommitId: nextCommit(),
              target: { branch: "main" },
            }
          },
        )
        .with("wf_claim_messages", () => {
          const keys = asStringSet(p.messageKeys)
          const nowMs = asNullableNumber(p.nowMs) ?? Date.now()
          let count = 0
          for (const m of messages.values()) {
            if (keys.has(strVal(m.messageKey)) && m.processed === false) {
              m.lastReadMs = nowMs
              count += 1
            }
          }
          return {
            queryName,
            affectedNodes: count,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_unprocessed_messages_by_id", () => {
          const keys = asStringSet(p.messageKeys)
          const nowMs = asNullableNumber(p.nowMs) ?? Date.now()
          const rows = Array.from(messages.values())
            .filter((m) => {
              if (!keys.has(strVal(m.messageKey)) || m.processed !== false) return false
              const deliverAt = asNullableNumber(m.deliverAtMs)
              if (deliverAt !== null && deliverAt > nowMs) return false
              return !hasActiveReplyFor(strVal(m.requestId))
            })
            .sort((a, b) => compareCodeUnits(strVal(a.seqKey), strVal(b.seqKey)))
            .map((m) => ({ ...m }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_reset_requests", () => {
          const keys = asStringSet(p.messageKeys)
          let count = 0
          for (const m of messages.values()) {
            if (m.processed === false && keys.has(strVal(m.messageKey))) {
              m.lastReadMs = p.clearReadMs ?? null
              count += 1
            }
          }
          return {
            queryName,
            affectedNodes: count,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_reset_address", "wf_reset_address_group", "wf_reset_shards", () => {
          const shardSet = asStringSet(p.shardIds)
          const entityIds = asStringSet(p.entityIds)
          let count = 0
          for (const m of messages.values()) {
            if (m.processed !== false) continue
            const matches =
              queryName === "wf_reset_shards"
                ? shardSet.has(strVal(m.shardId))
                : queryName === "wf_reset_address"
                  ? m.shardId === p.shardId &&
                    m.entityType === p.entityType &&
                    m.entityId === p.entityId
                  : m.shardId === p.shardId &&
                    m.entityType === p.entityType &&
                    entityIds.has(strVal(m.entityId))
            if (matches) {
              m.lastReadMs = p.clearReadMs ?? null
              count += 1
            }
          }
          return {
            queryName,
            affectedNodes: count,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_message_keys_for_address", () => {
          const rows = Array.from(messages.values())
            .filter((m) => m.entityType === p.entityType && m.entityId === p.entityId)
            .map((m) => ({ messageKey: m.messageKey, requestId: m.requestId }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_clear_address", () => {
          const reqIds = asStringSet(p.requestIds)
          let count = 0
          for (const [k, m] of messages.entries()) {
            if (m.entityType === p.entityType && m.entityId === p.entityId) {
              messages.delete(k)
              count += 1
            }
          }
          for (const [k, r] of replies.entries()) {
            if (reqIds.has(strVal(r.requestId))) {
              replies.delete(k)
              count += 1
            }
          }
          return {
            queryName,
            affectedNodes: count,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_all_entities", () => {
          const after = strVal(p.afterSeqKey)
          const rows = Array.from(messages.values())
            .filter((m) => compareCodeUnits(strVal(m.seqKey), after) > 0)
            .sort((a, b) => compareCodeUnits(strVal(a.seqKey), strVal(b.seqKey)))
            .slice(0, 1024)
            .map((m) => ({ ...m }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_all_replies", () => {
          const after = strVal(p.afterSeqKey)
          const rows = Array.from(replies.values())
            .filter((r) => compareCodeUnits(strVal(r.seqKey), after) > 0)
            .sort((a, b) => compareCodeUnits(strVal(a.seqKey), strVal(b.seqKey)))
            .slice(0, 1024)
            .map((r) => ({ ...r }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_get_run", () => {
          const row = runs.get(strVal(p.runId))
          return {
            queryName,
            rowCount: row === undefined ? 0 : 1,
            rows: row === undefined ? [] : [{ ...row }],
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_list_runs", () => {
          const rows = Array.from(runs.values())
            .sort((a, b) => {
              const dt = Number(b.updatedMs ?? 0) - Number(a.updatedMs ?? 0)
              return dt !== 0 ? dt : compareCodeUnits(strVal(a.runId), strVal(b.runId))
            })
            .slice(0, 256)
            .map((r) => ({ ...r }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_probe_runs", () => {
          const first = runs.values().next().value
          return {
            queryName,
            rowCount: first === undefined ? 0 : 1,
            rows: first === undefined ? [] : [{ runId: first.runId }],
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_insert_run", () => {
          const runId = strVal(p.runId)
          runs.set(runId, { ...p })
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_update_run", () => {
          const existing = runs.get(strVal(p.runId))
          if (existing !== undefined) {
            existing.state = p.state
            existing.updatedMs = p.updatedMs
          }
          return {
            queryName,
            affectedNodes: existing === undefined ? 0 : 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_get_unit", () => {
          const row = units.get(strVal(p.unitKey))
          return {
            queryName,
            rowCount: row === undefined ? 0 : 1,
            rows: row === undefined ? [] : [{ ...row }],
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_units_for_run", () => {
          const rows = Array.from(units.values())
            .filter((u) => u.runId === p.runId)
            .sort((a, b) => {
              const dw = Number(a.waveIndex ?? 0) - Number(b.waveIndex ?? 0)
              return dw !== 0 ? dw : compareCodeUnits(strVal(a.unitId), strVal(b.unitId))
            })
            .map((u) => ({ ...u }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_insert_unit", () => {
          const unitKey = strVal(p.unitKey)
          units.set(unitKey, { ...p })
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_update_unit", () => {
          const existing = units.get(strVal(p.unitKey))
          if (existing !== undefined) {
            existing.status = p.status
            existing.updatedMs = p.updatedMs
          }
          return {
            queryName,
            affectedNodes: existing === undefined ? 0 : 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_get_attempt", () => {
          const row = attempts.get(strVal(p.attemptKey))
          return {
            queryName,
            rowCount: row === undefined ? 0 : 1,
            rows: row === undefined ? [] : [{ ...row }],
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_attempts_for_run", () => {
          const rows = Array.from(attempts.values())
            .filter((a) => a.runId === p.runId)
            .sort((a, b) => {
              const du = compareCodeUnits(strVal(a.unitId), strVal(b.unitId))
              return du !== 0 ? du : Number(a.attempt ?? 0) - Number(b.attempt ?? 0)
            })
            .map((a) => ({ ...a }))
          return {
            queryName,
            rowCount: rows.length,
            rows,
            graphCommitId: nextCommit(),
            target: { branch: "main" },
          }
        })
        .with("wf_insert_attempt", () => {
          const attemptKey = strVal(p.attemptKey)
          attempts.set(attemptKey, { ...p })
          return {
            queryName,
            affectedNodes: 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_update_attempt", () => {
          const existing = attempts.get(strVal(p.attemptKey))
          if (existing !== undefined) {
            existing.verdict = p.verdict
            existing.runner = p.runner ?? null
            existing.rejection = p.rejection ?? null
            existing.packageStampHash = p.packageStampHash ?? null
            existing.updatedMs = p.updatedMs
          }
          return {
            queryName,
            affectedNodes: existing === undefined ? 0 : 1,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .with("wf_delete_run_views", () => {
          const runId = strVal(p.runId)
          let count = 0
          for (const [k, a] of attempts.entries()) {
            if (a.runId === runId) {
              attempts.delete(k)
              count += 1
            }
          }
          for (const [k, u] of units.entries()) {
            if (u.runId === runId) {
              units.delete(k)
              count += 1
            }
          }
          if (runs.delete(runId)) count += 1
          return {
            queryName,
            affectedNodes: count,
            affectedEdges: 0,
            branch: "main",
            commit: { graphCommitId: nextCommit() },
          }
        })
        .otherwise(() => ({
          queryName,
          rowCount: 0,
          rows: [],
          affectedNodes: 0,
          affectedEdges: 0,
          branch: "main",
          commit: null,
          graphCommitId: nextCommit(),
          target: { branch: "main" },
        })),
    )
  }

  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      if (prop === "queries") {
        return new Proxy(target.queries, {
          get(qTarget, qProp, qReceiver) {
            if (qProp === "invoke") return invokeMock
            return Reflect.get(qTarget, qProp, qReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

const makePackageUnit = (
  id: string,
  projectName: string,
  ownedRelPaths: ReadonlyArray<string>,
  waveIndex: number,
  dependsOn: ReadonlyArray<string> = [],
): CompiledWorkUnit => ({
  _tag: "PackageUnit",
  unitId: WorkUnitId.make(id),
  projectName: NxProjectName.make(projectName),
  waveIndex: WaveIndex.make(waveIndex),
  dependsOn: dependsOn.map((d) => WorkUnitId.make(d)),
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  stubKeys: [StubSymbolKey.make("Harness.driveWorkUnit")],
  earsKeys: [EarsRequirementKey.make("REQ-1.1")],
  packageVerifyCommand: PackageVerifyCommand.make(`pnpm nx run ${projectName}:verify`),
})

const makeSliceUnit = (
  id: string,
  branch: string,
  ownedRelPaths: ReadonlyArray<string>,
  waveIndex: number,
): CompiledWorkUnit => ({
  _tag: "SliceUnit",
  unitId: WorkUnitId.make(id),
  branch: SliceBranchName.make(branch),
  waveIndex: WaveIndex.make(waveIndex),
  dependsOn: [],
  ownedRelPaths: ownedRelPaths.map((p) => OwnedRelPath.make(p)),
  earsKeys: [EarsRequirementKey.make("REQ-1.1")],
})

const makeReviewStubLayer = (): Layer.Layer<WorkflowReviewRouter> =>
  Layer.succeed(WorkflowReviewRouter, {
    routeReview: () =>
      Effect.succeed<ReviewRoutingPlan>({
        _tag: "SkipReviewPlan",
        depth: ReviewDepth.make("skip"),
        source: ReviewRoutingSource.make("deterministic"),
        reason: ReviewRoutingReason.make("differential replay test"),
        selections: [],
      }),
  })

const snapshotAndCompareViews = Effect.fnUntraced(function* (
  client: OmnigraphClient,
  runId: WorkflowRunId,
) {
  const query = yield* WorkflowReadModelQuery
  const liveRunOpt = yield* query.getRun(runId)
  const liveRun = match(liveRunOpt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => expect.unreachable(`Expected live WfRun '${runId}' to exist`))
    .exhaustive()
  const liveUnits = yield* query.listUnits(runId)
  const liveAttempts = yield* query.listAttempts(runId)

  const normalizeRun = (run: WorkflowRunRecord): RowMap => ({
    ...run,
    updatedMs: NORMALIZED_TS,
  })
  const normalizeUnits = (rows: ReadonlyArray<WorkflowUnitRecord>): ReadonlyArray<RowMap> =>
    rows
      .map((u) => ({ ...u, updatedMs: NORMALIZED_TS }))
      .sort((a, b) => compareCodeUnits(String(a.unitKey), String(b.unitKey)))
  const normalizeAttempts = (rows: ReadonlyArray<WorkflowAttemptRecord>): ReadonlyArray<RowMap> =>
    rows
      .map((a) => ({ ...a, updatedMs: NORMALIZED_TS }))
      .sort((a, b) => compareCodeUnits(String(a.attemptKey), String(b.attemptKey)))

  const liveNorm = {
    run: normalizeRun(liveRun),
    units: normalizeUnits(liveUnits),
    attempts: normalizeAttempts(liveAttempts),
  }

  yield* rebuildWorkflowReadModelViews(CANONICAL_ROOT, { client })

  const rebuiltRunOpt = yield* query.getRun(runId)
  const rebuiltRun = match(rebuiltRunOpt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => expect.unreachable(`Expected rebuilt WfRun '${runId}' to exist`))
    .exhaustive()
  const rebuiltUnits = yield* query.listUnits(runId)
  const rebuiltAttempts = yield* query.listAttempts(runId)

  expect({
    run: normalizeRun(rebuiltRun),
    units: normalizeUnits(rebuiltUnits),
    attempts: normalizeAttempts(rebuiltAttempts),
  }).toEqual(liveNorm)

  return liveRun
})

const makeDiffStack = (
  client: OmnigraphClient,
  layers: {
    readonly worktreeLayer: Layer.Layer<WorkflowWorktreePort>
    readonly verifierLayer: Layer.Layer<UnitVerifier>
  },
) => {
  const engineLayer = makeHarnessWorkflowEngineLayer(CANONICAL_ROOT, {
    client,
    shardsPerGroup: 2,
    entityMessagePollInterval: "20 millis",
    entityReplyPollInterval: "20 millis",
  })
  const projectionWriterLayer = makeWorkflowProjectionWriterLayer({
    repoRoot: CANONICAL_ROOT,
    client,
  })
  const readModelLayer = makeWorkflowReadModelQueryLayer({ repoRoot: CANONICAL_ROOT, client })
  const dispatcherLayer = Layer.succeed(UnitAgentDispatcher, {
    runnerKind: "live" as const,
    dispatchUnit: () => Effect.succeed({ _tag: "Completed" as const }),
  })
  const baseServices = Layer.mergeAll(
    engineLayer,
    projectionWriterLayer,
    readModelLayer,
    layers.worktreeLayer,
    layers.verifierLayer,
    dispatcherLayer,
    makeReviewStubLayer(),
  )
  return HarnessTaskWorkflowLayer.pipe(Layer.provideMerge(baseServices))
}

const completeLlmPhase = Effect.fnUntraced(function* (executionId: WorkflowExecutionId) {
  const token = DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
    workflow: HarnessTaskWorkflow,
    executionId,
  })
  yield* DurableDeferred.succeed(LlmPhaseDone, {
    token,
    value: LlmPhaseReceipt.make({
      frictionLogCleared: FrictionLogState.make("cleared"),
      workspaceHash: TREE_HASH,
    }),
  })
})

const waitForWaitingRun = Effect.fnUntraced(function* (runId: WorkflowRunId) {
  const query = yield* WorkflowReadModelQuery
  for (let i = 0; i < 150; i += 1) {
    const runOpt = yield* query.getRun(runId)
    const isWaiting = match(runOpt)
      .with({ _tag: "Some" }, ({ value }) => value.state === "waiting")
      .with({ _tag: "None" }, () => false)
      .exhaustive()
    if (isWaiting) return
    yield* Effect.sleep("25 millis")
  }
  expect.unreachable(`Timed out waiting for WfRun '${runId}' to enter state='waiting'`)
})

describe("REQ-3.1: Differential live HarnessTaskWorkflow projections vs rebuildWorkflowReadModelViews", () => {
  it.live(
    "matches exactly across multi-wave + sharedStep completion and paused LlmPhaseDone waiting state",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-diff-multiwave"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [
            makePackageUnit("u-w0", "@harness/alpha", ["libs/alpha/src"], 0),
            makePackageUnit("u-w1", "@harness/beta", ["libs/beta/src"], 1, ["u-w0"]),
          ],
          sharedStepPaths: [OwnedRelPath.make("libs/shared/src")],
        }
        const executionId = yield* executionIdOf(plan)

        const stack = makeDiffStack(client, {
          worktreeLayer: Layer.succeed(WorkflowWorktreePort, {
            provisionWorktrees: (p) =>
              Effect.succeed({
                runId: p.runId,
                canonicalRepoRoot: CANONICAL_ROOT,
                entries: p.units.map((u) => ({
                  unitId: u.unitId,
                  cwd: CANONICAL_ROOT,
                  worktreeKind: "canonical" as const,
                })),
              }),
            removeWorktreeCheckouts: () => Effect.void,
            mergeSliceWave: (input) =>
              Effect.succeed({ _tag: "Merged" as const, mergedBranches: input.branches }),
          }),
          verifierLayer: Layer.succeed(UnitVerifier, {
            completeUnit: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: input.unit.unitId,
                  attempt: input.attempt,
                  changedPaths: [...input.unit.ownedRelPaths],
                  packageStampHash: STAMP_A,
                }),
              ),
            completeSharedStep: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: SHARED_STEP_UNIT_ID,
                  attempt: input.attempt,
                  changedPaths: [...input.sharedStepPaths],
                  packageStampHash: STAMP_B,
                }),
              ),
          }),
        })

        yield* Effect.gen(function* () {
          const runFiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(Effect.forkChild)

          for (const uid of [
            WorkUnitId.make("u-w0"),
            WorkUnitId.make("u-w1"),
            SHARED_STEP_UNIT_ID,
          ]) {
            const def = makeUnitCompletionDeferred(
              uid,
              AttemptNumber.make(1),
              EscalationOrdinal.make(1),
            )
            const tok = DurableDeferred.tokenFromExecutionId(def, {
              workflow: HarnessTaskWorkflow,
              executionId,
            })
            yield* DurableDeferred.succeed(def, {
              token: tok,
              value: UnitOutcome.cases.Completed.make({
                unitId: uid,
                attempt: AttemptNumber.make(1),
                changedPaths: [OwnedRelPath.make("libs/demo/src")],
                packageStampHash: STAMP_A,
              }),
            })
          }

          // Trace 3: Pause while waiting on LlmPhaseDone -> compare live waiting state vs rebuilt waiting state
          yield* waitForWaitingRun(plan.runId)
          const waitingLive = yield* snapshotAndCompareViews(client, plan.runId)
          expect(waitingLive.state).toBe("waiting")

          // Complete LlmPhaseDone -> finish run -> compare final completed live views vs rebuilt views (Trace 1)
          yield* completeLlmPhase(executionId)
          const receipt = yield* Fiber.join(runFiber)
          expect(receipt.runId).toBe(plan.runId)

          const completedLive = yield* snapshotAndCompareViews(client, plan.runId)
          expect(completedLive.state).toBe("completed")
        }).pipe(Effect.provide(stack))
      }),
    20_000,
  )

  it.live(
    "matches exactly across L1 MergeSliceWave conflict -> escalation retry -> clean merge completion",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const unitId = WorkUnitId.make("slice-conflict")
        const branch = SliceBranchName.make("slice/diff-conflict")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-diff-merge-conflict"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makeSliceUnit(unitId, branch, ["libs/conflict/src"], 0)],
          sharedStepPaths: [],
        }
        const executionId = yield* executionIdOf(plan)
        let mergeCall = 0
        const mergeEscalated = Deferred.makeUnsafe<void>()

        const stack = makeDiffStack(client, {
          worktreeLayer: Layer.succeed(WorkflowWorktreePort, {
            provisionWorktrees: (p) =>
              Effect.succeed({
                runId: p.runId,
                canonicalRepoRoot: CANONICAL_ROOT,
                entries: p.units.map((u) => ({
                  unitId: u.unitId,
                  cwd: CANONICAL_ROOT,
                  worktreeKind: "linked" as const,
                  branch,
                })),
              }),
            removeWorktreeCheckouts: () => Effect.void,
            mergeSliceWave: (input) =>
              Effect.sync(() => {
                mergeCall += 1
                if (mergeCall === 1) {
                  return MergeSliceWaveOutcome.cases.Conflict.make({
                    branch,
                  })
                }
                return MergeSliceWaveOutcome.cases.Merged.make({ mergedBranches: input.branches })
              }),
          }),
          verifierLayer: Layer.succeed(UnitVerifier, {
            completeUnit: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: input.unit.unitId,
                  attempt: input.attempt,
                  changedPaths: [...input.unit.ownedRelPaths],
                  packageStampHash: STAMP_A,
                }),
              ),
            completeSharedStep: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: SHARED_STEP_UNIT_ID,
                  attempt: input.attempt,
                  changedPaths: [...input.sharedStepPaths],
                  packageStampHash: STAMP_B,
                }),
              ),
          }),
        })

        yield* Effect.gen(function* () {
          const query = yield* WorkflowReadModelQuery
          const runFiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(Effect.forkChild)

          const compDef = makeUnitCompletionDeferred(
            unitId,
            AttemptNumber.make(1),
            EscalationOrdinal.make(1),
          )
          const compTok = DurableDeferred.tokenFromExecutionId(compDef, {
            workflow: HarnessTaskWorkflow,
            executionId,
          })
          yield* DurableDeferred.succeed(compDef, {
            token: compTok,
            value: UnitOutcome.cases.Completed.make({
              unitId,
              attempt: AttemptNumber.make(1),
              changedPaths: [OwnedRelPath.make("libs/conflict/src")],
              packageStampHash: STAMP_A,
            }),
          })

          // Wait until MergeSliceWave conflict sets unit status to 'escalated' & run state to 'waiting'
          for (let i = 0; i < 150; i += 1) {
            const units = yield* query.listUnits(plan.runId)
            const runOpt = yield* query.getRun(plan.runId)
            const ready =
              units.some((u) => u.unitId === unitId && u.status === "escalated") &&
              match(runOpt)
                .with({ _tag: "Some" }, ({ value }) => value.state === "waiting")
                .with({ _tag: "None" }, () => false)
                .exhaustive()
            if (ready) {
              yield* Deferred.succeed(mergeEscalated, void 0)
              break
            }
            yield* Effect.sleep("25 millis")
          }
          yield* Deferred.await(mergeEscalated)

          // Snapshot live waiting conflict state vs rebuilt
          yield* snapshotAndCompareViews(client, plan.runId)

          // Resolve merge escalation with 'retry'
          const escDef = makeUnitEscalationDeferred(unitId, EscalationOrdinal.make(1))
          const escTok = DurableDeferred.tokenFromExecutionId(escDef, {
            workflow: HarnessTaskWorkflow,
            executionId,
          })
          yield* DurableDeferred.succeed(escDef, {
            token: escTok,
            value: EscalationResolution.make({ decision: EscalationDecision.make("retry") }),
          })

          yield* waitForWaitingRun(plan.runId)
          yield* completeLlmPhase(executionId)
          yield* Fiber.join(runFiber)

          const finalRun = yield* snapshotAndCompareViews(client, plan.runId)
          expect(finalRun.state).toBe("completed")
        }).pipe(Effect.provide(stack))
      }),
    20_000,
  )

  it.live(
    "matches exactly on operator abort after 3 rejections (TaskRunAbortedError)",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const unitId = WorkUnitId.make("u-abort")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-diff-abort"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makePackageUnit(unitId, "@harness/abort", ["libs/abort/src"], 0)],
          sharedStepPaths: [],
        }
        const executionId = yield* executionIdOf(plan)

        const stack = makeDiffStack(client, {
          worktreeLayer: Layer.succeed(WorkflowWorktreePort, {
            provisionWorktrees: (p) =>
              Effect.succeed({
                runId: p.runId,
                canonicalRepoRoot: CANONICAL_ROOT,
                entries: p.units.map((u) => ({
                  unitId: u.unitId,
                  cwd: CANONICAL_ROOT,
                  worktreeKind: "canonical" as const,
                })),
              }),
            removeWorktreeCheckouts: () => Effect.void,
            mergeSliceWave: (input) =>
              Effect.succeed({ _tag: "Merged" as const, mergedBranches: input.branches }),
          }),
          verifierLayer: Layer.succeed(UnitVerifier, {
            completeUnit: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Rejected.make({
                  unitId: input.unit.unitId,
                  attempt: input.attempt,
                  rejection: UnitRejection.cases.PackageVerifyFailed.make({
                    exitCode: GateExitCode.make(1),
                    failureKind: "non-zero-exit",
                  }),
                }),
              ),
            completeSharedStep: (input) =>
              Effect.succeed(
                UnitOutcome.cases.Completed.make({
                  unitId: SHARED_STEP_UNIT_ID,
                  attempt: input.attempt,
                  changedPaths: [...input.sharedStepPaths],
                  packageStampHash: STAMP_B,
                }),
              ),
          }),
        })

        yield* Effect.gen(function* () {
          const runFiber = yield* HarnessTaskWorkflow.execute({ plan }).pipe(Effect.forkChild)

          for (const attemptNum of [1, 2, 3] as const) {
            const def = makeUnitCompletionDeferred(
              unitId,
              AttemptNumber.make(attemptNum),
              EscalationOrdinal.make(1),
            )
            const tok = DurableDeferred.tokenFromExecutionId(def, {
              workflow: HarnessTaskWorkflow,
              executionId,
            })
            yield* DurableDeferred.succeed(def, {
              token: tok,
              value: UnitOutcome.cases.Rejected.make({
                unitId,
                attempt: AttemptNumber.make(attemptNum),
                rejection: UnitRejection.cases.PackageVerifyFailed.make({
                  exitCode: GateExitCode.make(1),
                  failureKind: "non-zero-exit",
                }),
              }),
            })
          }

          yield* waitForWaitingRun(plan.runId)
          const escDef = makeUnitEscalationDeferred(unitId, EscalationOrdinal.make(1))
          const escTok = DurableDeferred.tokenFromExecutionId(escDef, {
            workflow: HarnessTaskWorkflow,
            executionId,
          })
          yield* DurableDeferred.succeed(escDef, {
            token: escTok,
            value: EscalationResolution.make({ decision: EscalationDecision.make("abort") }),
          })

          const exit = yield* Fiber.await(runFiber)
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              expect(Cause.hasFails(cause)).toBe(true)
            })
            .with({ _tag: "Success" }, () =>
              expect.unreachable("Expected aborted workflow failure"),
            )
            .exhaustive()

          const abortedRun = yield* snapshotAndCompareViews(client, plan.runId)
          expect(abortedRun.state).toBe("aborted")
        }).pipe(Effect.provide(stack))
      }),
    20_000,
  )

  it.effect(
    "directly exercises replayActivityMessage across dispatch, escalation, retry, and completion transitions",
    () =>
      Effect.gen(function* () {
        const unitId = WorkUnitId.make("u-direct")
        const plan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-replay-direct"),
          level: "slice",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makePackageUnit(unitId, "@harness/direct", ["libs/direct/src"], 0)],
          sharedStepPaths: [],
        }
        const now = yield* Clock.currentTimeMillis
        const unitStatusMap = new Map<WorkUnitId, WorkflowUnitStatus>([[unitId, "pending"]])
        const attemptsMap = new Map<WorkflowAttemptKey, WorkflowAttemptRecord>()
        const mergeConflictUnits = new Set<WorkUnitId>()
        let runState: WorkflowRunState = "running"

        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan,
          activityName: `ProjectUnitDispatched/${unitId}/1`,
          actReplyStr: undefined,
          hasRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap,
          attemptsMap,
          mergeConflictUnits,
          getRunState: () => runState,
          setRunState: (next) => {
            runState = next
          },
        })
        expect(unitStatusMap.get(unitId)).toBe("dispatched")

        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan,
          activityName: "ProjectRunCompleted",
          actReplyStr: undefined,
          hasRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap,
          attemptsMap,
          mergeConflictUnits,
          getRunState: () => runState,
          setRunState: (next) => {
            runState = next
          },
        })
        expect(runState).toBe("completed")

        // Retry transition from escalated -> dispatched and waiting -> running
        unitStatusMap.set(unitId, "escalated")
        runState = "waiting"
        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan,
          activityName: `ProjectUnitEscalationRetried/${unitId}/1`,
          actReplyStr: undefined,
          hasRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap,
          attemptsMap,
          mergeConflictUnits,
          getRunState: () => runState,
          setRunState: (next) => {
            runState = next
          },
        })
        expect(unitStatusMap.get(unitId)).toBe("dispatched")
        expect(runState).toBe("running")

        // Non-waiting activity leaves runState='running', while ProjectRunWaitingLlmPhase moves running -> waiting
        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan,
          activityName: "RouteReview",
          actReplyStr: undefined,
          hasRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap,
          attemptsMap,
          mergeConflictUnits,
          getRunState: () => runState,
          setRunState: (next) => {
            runState = next
          },
        })
        expect(runState).toBe("running")

        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan,
          activityName: "ProjectRunWaitingLlmPhase",
          actReplyStr: undefined,
          hasRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap,
          attemptsMap,
          mergeConflictUnits,
          getRunState: () => runState,
          setRunState: (next) => {
            runState = next
          },
        })
        expect(runState).toBe("waiting")

        // VerifyUnit promotes pending -> dispatched without clobbering escalated
        unitStatusMap.set(unitId, "pending")
        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan,
          activityName: `VerifyUnit/${unitId}/1`,
          actReplyStr: undefined,
          hasRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap,
          attemptsMap,
          mergeConflictUnits,
          getRunState: () => runState,
          setRunState: (next) => {
            runState = next
          },
        })
        expect(unitStatusMap.get(unitId)).toBe("dispatched")

        unitStatusMap.set(unitId, "escalated")
        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan,
          activityName: `VerifyUnit/${unitId}/2`,
          actReplyStr: undefined,
          hasRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap,
          attemptsMap,
          mergeConflictUnits,
          getRunState: () => runState,
          setRunState: (next) => {
            runState = next
          },
        })
        expect(unitStatusMap.get(unitId)).toBe("escalated")

        // Non-undefined Failure actReply transitions runState to aborted
        runState = "running"
        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan,
          activityName: "RouteReview",
          actReplyStr: JSON.stringify({ _tag: "Failure" }),
          hasRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap,
          attemptsMap,
          mergeConflictUnits,
          getRunState: () => runState,
          setRunState: (next) => {
            runState = next
          },
        })
        expect(runState).toBe("aborted")

        // MergeSliceWave Merged resolves only escalated slices while preserving pending slices
        const sliceAlpha = WorkUnitId.make("slice-alpha")
        const sliceBeta = WorkUnitId.make("slice-beta")
        const slicePlan: CompiledPlan = {
          runId: WorkflowRunIdSchema.make("run-replay-merge-direct"),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [
            makeSliceUnit(sliceAlpha, "slice/direct-alpha", ["libs/alpha/src"], 0),
            makeSliceUnit(sliceBeta, "slice/direct-beta", ["libs/beta/src"], 0),
          ],
          sharedStepPaths: [],
        }
        const sliceStatusMap = new Map<WorkUnitId, WorkflowUnitStatus>([
          [sliceAlpha, "escalated"],
          [sliceBeta, "pending"],
        ])
        let sliceRunState: WorkflowRunState = "waiting"
        yield* replayActivityMessage({
          operation: WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          plan: slicePlan,
          activityName: "MergeSliceWave/0/r2",
          actReplyStr: JSON.stringify({
            _tag: "Success",
            value: {
              _tag: "Complete",
              exit: {
                _tag: "Success",
                value: {
                  _tag: "Merged",
                  mergedBranches: [
                    "slice/direct-alpha",
                    "slice/direct-beta",
                    "slice/unknown-branch",
                  ],
                },
              },
            },
          }),
          hasRunReply: false,
          nowValue: WorkflowTimestampMs.make(Math.floor(now)),
          unitStatusMap: sliceStatusMap,
          attemptsMap: new Map<WorkflowAttemptKey, WorkflowAttemptRecord>(),
          mergeConflictUnits: new Set<WorkUnitId>(),
          getRunState: () => sliceRunState,
          setRunState: (next) => {
            sliceRunState = next
          },
        })
        expect(sliceStatusMap.get(sliceAlpha)).toBe("completed")
        expect(sliceStatusMap.get(sliceBeta)).toBe("pending")
      }),
  )

  it.effect(
    "reconstructJournalViews transitions waiting -> running on llm-phase-done, escalation retry, and MergeRetried without a run exit reply",
    () =>
      Effect.gen(function* () {
        const client = makeInMemoryWorkflowOmnigraphClient()
        const encodeRunPayload = Schema.encodeEffect(
          Schema.fromJsonString(Schema.Struct({ plan: CompiledPlanSchema })),
        )
        let rawId = 500000000000000001n
        const insertJournalMsg = (
          executionId: WorkflowExecutionId,
          tag: "run" | "activity" | "deferred",
          payload: string,
        ) =>
          Effect.promise(async () => {
            const idNum = rawId
            rawId += 1n
            const messageKey = MessageKey.make(idNum.toString())
            const seqRes = encodeSeqKey(messageKey)
            const seqKey = match(seqRes)
              .with({ _tag: "Success" }, ({ success }) => success)
              .with({ _tag: "Failure" }, ({ failure }) => expect.unreachable(failure))
              .exhaustive()
            await client.queries.invoke("wf_insert_request_message", {
              branch: "main",
              expectMutation: true,
              params: {
                messageKey,
                seqKey,
                primaryKeyHash: null,
                shardId: "default:0",
                entityType: "Workflow/HarnessTaskWorkflow",
                entityId: executionId,
                tag,
                payload,
                headers: "{}",
                traceId: null,
                spanId: null,
                sampled: null,
                requestId: messageKey,
                deliverAtMs: null,
              },
            })
          })

        const unitId = WorkUnitId.make("slice-jrnl")
        const makeEpicPlan = (runIdStr: string): CompiledPlan => ({
          runId: WorkflowRunIdSchema.make(runIdStr),
          level: "epic",
          planSha: PLAN_SHA,
          baseSha: BASE_SHA,
          mode: { _tag: "Manual" },
          units: [makeSliceUnit(unitId, "slice/jrnl-branch", ["libs/jrnl/src"], 0)],
          sharedStepPaths: [],
        })

        // Run A: ProjectRunWaitingLlmPhase -> llm-phase-done deferred (no run reply) -> running
        const planLlm = makeEpicPlan("run-jrnl-llm-resume")
        const execLlm = yield* executionIdOf(planLlm)
        yield* insertJournalMsg(execLlm, "run", yield* encodeRunPayload({ plan: planLlm }))
        yield* insertJournalMsg(
          execLlm,
          "activity",
          JSON.stringify({ name: "ProjectRunWaitingLlmPhase" }),
        )
        yield* insertJournalMsg(
          execLlm,
          "deferred",
          JSON.stringify({
            name: "llm-phase-done",
            exit: {
              _tag: "Success",
              value: { frictionLogCleared: "cleared", workspaceHash: TREE_HASH },
            },
          }),
        )

        // Run B: ProjectUnitEscalated -> escalation retry deferred (no run reply) -> running
        const planEsc = makeEpicPlan("run-jrnl-esc-resume")
        const execEsc = yield* executionIdOf(planEsc)
        yield* insertJournalMsg(execEsc, "run", yield* encodeRunPayload({ plan: planEsc }))
        yield* insertJournalMsg(
          execEsc,
          "activity",
          JSON.stringify({ name: `ProjectUnitEscalated/${unitId}/1` }),
        )
        yield* insertJournalMsg(
          execEsc,
          "deferred",
          JSON.stringify({
            name: `escalation/${unitId}/1`,
            exit: { _tag: "Success", value: { decision: "retry" } },
          }),
        )

        // Run C: ProjectWaveMergeEscalated -> ProjectWaveMergeRetried (no run reply) -> running
        const planMerge = makeEpicPlan("run-jrnl-merge-resume")
        const execMerge = yield* executionIdOf(planMerge)
        yield* insertJournalMsg(execMerge, "run", yield* encodeRunPayload({ plan: planMerge }))
        yield* insertJournalMsg(
          execMerge,
          "activity",
          JSON.stringify({ name: "ProjectWaveMergeEscalated/0/1" }),
        )
        yield* insertJournalMsg(
          execMerge,
          "activity",
          JSON.stringify({ name: "ProjectWaveMergeRetried/0/1" }),
        )

        const now = yield* Clock.currentTimeMillis
        const bundles = yield* reconstructJournalViews(
          CANONICAL_ROOT,
          WorkflowStoreOperation.make("WorkflowReadModel.rebuild"),
          WorkflowTimestampMs.make(Math.floor(now)),
          { client },
        )

        const byRun = new Map(bundles.map((b) => [b.run.runId, b] as const))
        expect(byRun.get(planLlm.runId)?.run.state).toBe("running")
        expect(byRun.get(planEsc.runId)?.run.state).toBe("running")
        expect(byRun.get(planEsc.runId)?.units[0]?.status).toBe("dispatched")
        expect(byRun.get(planMerge.runId)?.run.state).toBe("running")
      }),
  )
})
