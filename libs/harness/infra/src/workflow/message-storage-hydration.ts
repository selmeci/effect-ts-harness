import { Effect, Option, Schema } from "effect"
import { type Envelope, type Reply, ShardId } from "effect/cluster"
import { match } from "ts-pattern"
import {
  encodeSeqKey,
  type LeaseEpoch,
  type LeaseFilePath,
  MessageKey,
  type PrimaryKeyHash,
  ReplyKey,
  toErrorReasonMessage,
  type WorkflowGqQueryName,
  WorkflowStoreOperation,
  type AbsoluteRepoRoot,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  invokeWorkflowStoreQueryOnce,
  makeMintReplyKey,
  type WorkflowStoreAttemptFailure,
} from "../omnigraph-workflow-store.js"
import {
  addressKeyFor,
  assertAffectedNodes,
  decodeEnvelopeRowIsolated,
  decodeMessageKeyAsAttemptFailure,
  decodeRepliesWithIsolation,
  decodeReplyKeyAsAttemptFailure,
  encodeSeqKeyAsAttemptFailure,
} from "./message-storage-codec.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export interface WorkflowStoreRuntimeTarget {
  readonly repoRoot: AbsoluteRepoRoot
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly expectedLeaseEpoch?: LeaseEpoch | undefined
  readonly expectedLeaseOwner?: string | undefined
  readonly lockFilePath?: LeaseFilePath | undefined
}

const decodeReplyKeyResult = Schema.decodeUnknownResult(ReplyKey)

const CorruptMessageIdentitySchema = Schema.Struct({
  requestId: Schema.optional(Schema.NullOr(MessageKey)),
  messageKey: Schema.optional(Schema.NullOr(MessageKey)),
})
const decodeCorruptMessageIdentityOption = Schema.decodeUnknownOption(CorruptMessageIdentitySchema)

const fetchLastRepliesById = (
  target: WorkflowStoreRuntimeTarget,
  replyKeys: ReadonlyArray<ReplyKey>,
  operation: WorkflowStoreOperation,
): Effect.Effect<Map<ReplyKey, Reply.Encoded>, WorkflowStoreAttemptFailure> =>
  Effect.gen(function* () {
    const replyMap = new Map<ReplyKey, Reply.Encoded>()
    if (replyKeys.length === 0) {
      return replyMap
    }
    const res = yield* invokeWorkflowStoreQueryOnce({
      repoRoot: target.repoRoot,
      operation,
      queryName: "wf_replies_by_keys",
      params: { replyKeys },
      expectMutation: false,
      client: target.client,
      hostIo: target.hostIo,
      env: target.env,
    })
    const decodedReplies = yield* decodeRepliesWithIsolation(res.rows)
    for (const reply of decodedReplies) {
      match(decodeReplyKeyResult(reply.id))
        .with({ _tag: "Success" }, ({ success: rk }) => {
          replyMap.set(rk, reply)
        })
        .with({ _tag: "Failure" }, () => undefined)
        .exhaustive()
    }
    return replyMap
  })

const persistCorruptMessageDefect = (
  target: WorkflowStoreRuntimeTarget,
  operation: WorkflowStoreOperation,
  requestId: MessageKey,
  reason: string,
  mintReplyKey: () => ReplyKey,
): Effect.Effect<void, WorkflowStoreAttemptFailure> =>
  Effect.gen(function* () {
    const replyKey = mintReplyKey()
    const seqKey = yield* encodeSeqKeyAsAttemptFailure(operation, replyKey)
    const saveRes = yield* invokeWorkflowStoreQueryOnce({
      repoRoot: target.repoRoot,
      operation,
      queryName: "wf_save_reply_exit",
      params: {
        replyKey,
        seqKey,
        requestId,
        payload: JSON.stringify({
          _tag: "Failure",
          cause: [{ _tag: "Die", defect: `Corrupt WfMessage row: ${reason}` }],
        }),
      },
      expectMutation: true,
      expectedLeaseEpoch: target.expectedLeaseEpoch,
      expectedLeaseOwner: target.expectedLeaseOwner,
      lockFilePath: target.lockFilePath,
      client: target.client,
      hostIo: target.hostIo,
      env: target.env,
    })
    yield* assertAffectedNodes(operation, "wf_save_reply_exit", saveRes.affectedNodes, {
      kind: "min",
      count: 1,
    })
  })

const hydrateCandidateRows = (
  target: WorkflowStoreRuntimeTarget,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  operation: WorkflowStoreOperation,
  addressFilter?: ReadonlySet<string>,
  limit?: number,
  options?: { readonly persistCorruptDefect?: boolean | undefined },
): Effect.Effect<
  {
    readonly items: Array<{
      readonly envelope: Envelope.Encoded
      readonly lastSentReply: Option.Option<Reply.Encoded>
    }>
    readonly messageKeys: Array<MessageKey>
  },
  WorkflowStoreAttemptFailure
> =>
  Effect.gen(function* () {
    const mintReplyKey = makeMintReplyKey()
    const preliminary: Array<{
      readonly messageKey: MessageKey
      readonly envelope: Envelope.Encoded
      readonly lastReplyId: ReplyKey | undefined
    }> = []

    for (const row of rows) {
      if (limit !== undefined && preliminary.length >= limit) {
        break
      }
      const parsedRow = yield* match(decodeEnvelopeRowIsolated(row))
        .with({ _tag: "Failure" }, ({ failure }) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`Corrupt WfMessage row: ${failure}`)
            if (options?.persistCorruptDefect === true) {
              const ident = decodeCorruptMessageIdentityOption(row)
              yield* match(ident)
                .with({ _tag: "Some" }, ({ value }) => {
                  const targetReqId = value.requestId ?? value.messageKey
                  return targetReqId !== undefined && targetReqId !== null
                    ? persistCorruptMessageDefect(
                        target,
                        operation,
                        targetReqId,
                        failure,
                        mintReplyKey,
                      )
                    : Effect.void
                })
                .with({ _tag: "None" }, () => Effect.void)
                .exhaustive()
            }
            return undefined
          }),
        )
        .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
        .exhaustive()
      if (parsedRow === undefined) {
        continue
      }
      const { messageKey, envelope, lastReplyId } = parsedRow
      if (addressFilter !== undefined && !addressFilter.has(addressKeyFor(envelope.address))) {
        continue
      }
      preliminary.push({ messageKey, envelope, lastReplyId })
    }

    if (preliminary.length === 0) {
      return { items: [], messageKeys: [] }
    }

    const replyKeysToFetch = Array.from(
      new Set(
        preliminary
          .map((entry) => entry.lastReplyId)
          .filter((id): id is ReplyKey => id !== undefined),
      ),
    )
    const replyMap = yield* fetchLastRepliesById(target, replyKeysToFetch, operation)

    const items: Array<{
      readonly envelope: Envelope.Encoded
      readonly lastSentReply: Option.Option<Reply.Encoded>
    }> = []
    const messageKeys: Array<MessageKey> = []
    for (const entry of preliminary) {
      const lastReply =
        entry.lastReplyId !== undefined ? replyMap.get(entry.lastReplyId) : undefined
      items.push({
        envelope: entry.envelope,
        lastSentReply: Option.fromNullishOr(lastReply),
      })
      messageKeys.push(entry.messageKey)
    }
    return { items, messageKeys }
  })

const insertEnvelopeRow = (
  target: WorkflowStoreRuntimeTarget,
  envelope: Envelope.Encoded,
  primaryKeyHash: PrimaryKeyHash | null,
  deliverAt: number | null,
  ifGraphCommit: string | undefined,
  operation: WorkflowStoreOperation,
): Effect.Effect<void, WorkflowStoreAttemptFailure> =>
  match(envelope)
    .with({ _tag: "Request" }, (req) =>
      Effect.gen(function* () {
        const messageKey = yield* decodeMessageKeyAsAttemptFailure(operation, req.requestId)
        const seqKey = yield* encodeSeqKeyAsAttemptFailure(operation, messageKey)
        const res = yield* invokeWorkflowStoreQueryOnce({
          repoRoot: target.repoRoot,
          operation,
          queryName: "wf_insert_request_message",
          params: {
            messageKey,
            seqKey,
            primaryKeyHash,
            shardId: ShardId.toString(req.address.shardId),
            entityType: req.address.entityType,
            entityId: req.address.entityId,
            tag: req.tag,
            payload: JSON.stringify(req.payload),
            headers: JSON.stringify(req.headers),
            traceId: req.traceId ?? null,
            spanId: req.spanId ?? null,
            sampled: req.sampled ?? null,
            requestId: messageKey,
            deliverAtMs: deliverAt,
          },
          expectMutation: true,
          ifGraphCommit,
          expectedLeaseEpoch: target.expectedLeaseEpoch,
          expectedLeaseOwner: target.expectedLeaseOwner,
          lockFilePath: target.lockFilePath,
          client: target.client,
          hostIo: target.hostIo,
          env: target.env,
        })
        yield* assertAffectedNodes(operation, "wf_insert_request_message", res.affectedNodes, {
          kind: "min",
          count: 1,
        })
      }),
    )
    .with({ _tag: "AckChunk" }, (ack) =>
      Effect.gen(function* () {
        const messageKey = yield* decodeMessageKeyAsAttemptFailure(operation, ack.id)
        const requestId = yield* decodeMessageKeyAsAttemptFailure(operation, ack.requestId)
        const replyId = yield* decodeReplyKeyAsAttemptFailure(operation, ack.replyId)
        const seqKey = yield* encodeSeqKeyAsAttemptFailure(operation, messageKey)
        const res = yield* invokeWorkflowStoreQueryOnce({
          repoRoot: target.repoRoot,
          operation,
          queryName: "wf_insert_ack_chunk",
          params: {
            messageKey,
            seqKey,
            primaryKeyHash,
            shardId: ShardId.toString(ack.address.shardId),
            entityType: ack.address.entityType,
            entityId: ack.address.entityId,
            requestId,
            replyId,
            deliverAtMs: deliverAt,
          },
          expectMutation: true,
          ifGraphCommit,
          expectedLeaseEpoch: target.expectedLeaseEpoch,
          expectedLeaseOwner: target.expectedLeaseOwner,
          lockFilePath: target.lockFilePath,
          client: target.client,
          hostIo: target.hostIo,
          env: target.env,
        })
        yield* assertAffectedNodes(operation, "wf_insert_ack_chunk", res.affectedNodes, {
          kind: "min",
          count: 1,
        })
      }),
    )
    .with({ _tag: "Interrupt" }, (intr) =>
      Effect.gen(function* () {
        const messageKey = yield* decodeMessageKeyAsAttemptFailure(operation, intr.id)
        const requestId = yield* decodeMessageKeyAsAttemptFailure(operation, intr.requestId)
        const seqKey = yield* encodeSeqKeyAsAttemptFailure(operation, messageKey)
        const res = yield* invokeWorkflowStoreQueryOnce({
          repoRoot: target.repoRoot,
          operation,
          queryName: "wf_insert_interrupt",
          params: {
            messageKey,
            seqKey,
            primaryKeyHash,
            shardId: ShardId.toString(intr.address.shardId),
            entityType: intr.address.entityType,
            entityId: intr.address.entityId,
            requestId,
            deliverAtMs: deliverAt,
          },
          expectMutation: true,
          ifGraphCommit,
          expectedLeaseEpoch: target.expectedLeaseEpoch,
          expectedLeaseOwner: target.expectedLeaseOwner,
          lockFilePath: target.lockFilePath,
          client: target.client,
          hostIo: target.hostIo,
          env: target.env,
        })
        yield* assertAffectedNodes(operation, "wf_insert_interrupt", res.affectedNodes, {
          kind: "min",
          count: 1,
        })
      }),
    )
    .exhaustive()

export {
  encodeSeqKey,
  fetchLastRepliesById,
  hydrateCandidateRows,
  insertEnvelopeRow,
  toErrorReasonMessage,
  type WorkflowGqQueryName,
}
