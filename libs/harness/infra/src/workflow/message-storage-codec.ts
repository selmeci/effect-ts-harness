import { createHash } from "node:crypto"
import { Effect, Option, Result, Schema } from "effect"
import { ClusterError, type Envelope, type Reply, ShardId } from "effect/cluster"
import { match, P } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  encodeSeqKey,
  type SeqKey,
  toErrorReasonMessage,
  WorkflowStoreOperation,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  decodeJsonFieldSafely,
  invokeWorkflowStoreQueryOnce,
  type WorkflowStoreAttemptFailure,
} from "../omnigraph-workflow-store.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export interface WorkflowStoreRuntimeTarget {
  readonly repoRoot: AbsoluteRepoRoot
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

const MAX_PRIMARY_KEY_PLAINTEXT_LEN = 255

/**
 * Encodes a message primary key deterministically: keys `<= 255` characters are stored
 * verbatim, and longer keys are hashed as `sha256:<hex>`.
 */
const computePrimaryKeyHash = (primaryKey: string): string =>
  primaryKey.length <= MAX_PRIMARY_KEY_PLAINTEXT_LEN
    ? primaryKey
    : `sha256:${createHash("sha256").update(primaryKey).digest("hex")}`

const toPersistenceError = (cause: unknown): ClusterError.PersistenceError =>
  cause instanceof ClusterError.PersistenceError
    ? cause
    : new ClusterError.PersistenceError({ cause })

const encodeSeqKeyAsAttemptFailure = (
  operation: WorkflowStoreOperation,
  rawId: string,
): Effect.Effect<SeqKey, WorkflowStoreAttemptFailure> =>
  match(encodeSeqKey(rawId))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail<WorkflowStoreAttemptFailure>({
        _tag: "WorkflowStoreAttemptFailure",
        operation,
        cause: new Error(failure),
      }),
    )
    .exhaustive()

const ExitCauseEncodedSchema = Schema.Union([
  Schema.TaggedStruct("Fail", { error: Schema.optional(Schema.Unknown) }),
  Schema.TaggedStruct("Die", { defect: Schema.optional(Schema.Unknown) }),
  Schema.TaggedStruct("Interrupt", {
    fiberId: Schema.optional(Schema.NullOr(Schema.Finite)),
  }),
])

const ExitEncodedSchema = Schema.Union([
  Schema.TaggedStruct("Success", { value: Schema.optional(Schema.Unknown) }),
  Schema.TaggedStruct("Failure", {
    cause: Schema.Array(ExitCauseEncodedSchema),
  }),
])

const HeadersRecordSchema = Schema.Record(Schema.String, Schema.String)
const ChunkValuesSchema = Schema.NonEmptyArray(Schema.Unknown)

const readStringField = (value: unknown): string | undefined =>
  match(value)
    .with(P.string, (str) => str)
    .otherwise(() => undefined)

const readNonEmptyStringField = (value: unknown): string | undefined =>
  match(value)
    .with(P.string, (str) => (str.length > 0 ? str : undefined))
    .otherwise(() => undefined)

const parseShardIdEncoded = (
  raw: unknown,
): Result.Result<{ readonly group: string; readonly id: number }, string> => {
  const rawStr = readNonEmptyStringField(raw)
  if (rawStr === undefined) {
    return Result.fail(`Invalid shardId: ${String(raw)}`)
  }
  return Result.try({
    try: () => ShardId.fromStringEncoded(rawStr),
    catch: (err) => toErrorReasonMessage(err, `Invalid shardId '${rawStr}'`),
  })
}

const decodeReplyRowIsolated = (
  row: Readonly<Record<string, unknown>>,
): Result.Result<Reply.Encoded, string> => {
  const replyKey = readNonEmptyStringField(row.replyKey)
  const requestId = readNonEmptyStringField(row.requestId)
  const rawPayload = readStringField(row.payload)
  if (replyKey === undefined || requestId === undefined || rawPayload === undefined) {
    return Result.fail(`Missing required fields on WfReply row (replyKey=${String(row.replyKey)})`)
  }

  return match(row.kind)
    .with("with_exit", () =>
      match(decodeJsonFieldSafely(rawPayload, ExitEncodedSchema))
        .with({ _tag: "Failure" }, ({ failure }) =>
          Result.fail(`Corrupt JSON on WfReply(with_exit) ${replyKey}: ${failure}`),
        )
        .with({ _tag: "Success" }, ({ success: exit }): Result.Result<Reply.Encoded, string> => {
          const normalizedExit = match(exit)
            .with({ _tag: "Success" }, (s) => ({
              _tag: "Success" as const,
              value: s.value,
            }))
            .with({ _tag: "Failure" }, (f) => ({
              _tag: "Failure" as const,
              cause: f.cause.map((item) =>
                match(item)
                  .with({ _tag: "Fail" }, (c) => ({
                    _tag: "Fail" as const,
                    error: c.error,
                  }))
                  .with({ _tag: "Die" }, (c) => ({
                    _tag: "Die" as const,
                    defect: c.defect,
                  }))
                  .with({ _tag: "Interrupt" }, (c) => ({
                    _tag: "Interrupt" as const,
                    fiberId: c.fiberId ?? null,
                  }))
                  .exhaustive(),
              ),
            }))
            .exhaustive()
          return Result.succeed({
            _tag: "WithExit" as const,
            id: replyKey,
            requestId,
            exit: normalizedExit,
          })
        })
        .exhaustive(),
    )
    .with("chunk", () => {
      const seq = row.sequence
      if (typeof seq !== "number" || !Number.isInteger(seq)) {
        return Result.fail(`Invalid sequence on WfReply(chunk) ${replyKey}: ${String(seq)}`)
      }
      return match(decodeJsonFieldSafely(rawPayload, ChunkValuesSchema))
        .with({ _tag: "Failure" }, ({ failure }) =>
          Result.fail(`Corrupt JSON on WfReply(chunk) ${replyKey}: ${failure}`),
        )
        .with({ _tag: "Success" }, ({ success: values }) =>
          Result.succeed<Reply.Encoded>({
            _tag: "Chunk",
            id: replyKey,
            requestId,
            sequence: seq,
            values,
          }),
        )
        .exhaustive()
    })
    .otherwise((otherKind) =>
      Result.fail(`Unknown WfReply kind '${String(otherKind)}' on ${replyKey}`),
    )
}

const decodeEnvelopeRowIsolated = (
  row: Readonly<Record<string, unknown>>,
): Result.Result<
  { readonly envelope: Envelope.Encoded; readonly lastReplyId: string | undefined },
  string
> => {
  const messageKey = readNonEmptyStringField(row.messageKey)
  const entityType = readNonEmptyStringField(row.entityType)
  const entityId = readNonEmptyStringField(row.entityId)
  const requestId = readNonEmptyStringField(row.requestId)
  if (
    messageKey === undefined ||
    entityType === undefined ||
    entityId === undefined ||
    requestId === undefined
  ) {
    return Result.fail(
      `Missing required fields on WfMessage row (messageKey=${String(row.messageKey)})`,
    )
  }

  return match(parseShardIdEncoded(row.shardId))
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .with({ _tag: "Success" }, ({ success: shardId }) => {
      const address = { shardId, entityType, entityId }
      const lastReplyId = readStringField(row.lastReplyId)

      return match(row.kind)
        .with("request", () => {
          const tag = readNonEmptyStringField(row.tag)
          const rawPayload = readStringField(row.payload)
          const rawHeaders = readStringField(row.headers)
          if (tag === undefined || rawPayload === undefined || rawHeaders === undefined) {
            return Result.fail(`Missing tag/payload/headers on WfMessage(request) ${messageKey}`)
          }
          const payloadRes = decodeJsonFieldSafely(rawPayload, Schema.Unknown)
          const headersRes = decodeJsonFieldSafely(rawHeaders, HeadersRecordSchema)
          return match(payloadRes)
            .with({ _tag: "Failure" }, ({ failure }) =>
              Result.fail(`Corrupt JSON payload on WfMessage(request) ${messageKey}: ${failure}`),
            )
            .with({ _tag: "Success" }, ({ success: payload }) =>
              match(headersRes)
                .with({ _tag: "Failure" }, ({ failure }) =>
                  Result.fail(
                    `Corrupt JSON headers on WfMessage(request) ${messageKey}: ${failure}`,
                  ),
                )
                .with({ _tag: "Success" }, ({ success: headers }) => {
                  const traceId = readNonEmptyStringField(row.traceId)
                  const spanId = readNonEmptyStringField(row.spanId)
                  const sampled = typeof row.sampled === "boolean" ? row.sampled : undefined
                  return Result.succeed({
                    envelope: {
                      _tag: "Request" as const,
                      requestId,
                      address,
                      tag,
                      payload,
                      headers,
                      ...(traceId !== undefined
                        ? {
                            traceId,
                            ...(spanId !== undefined ? { spanId } : {}),
                            ...(sampled !== undefined ? { sampled } : {}),
                          }
                        : {}),
                    },
                    lastReplyId,
                  })
                })
                .exhaustive(),
            )
            .exhaustive()
        })
        .with("ack_chunk", () => {
          const replyId = readNonEmptyStringField(row.replyId)
          if (replyId === undefined) {
            return Result.fail(`Missing replyId on WfMessage(ack_chunk) ${messageKey}`)
          }
          return Result.succeed({
            envelope: {
              _tag: "AckChunk" as const,
              id: messageKey,
              requestId,
              replyId,
              address,
            },
            lastReplyId: undefined,
          })
        })
        .with("interrupt", () =>
          Result.succeed({
            envelope: {
              _tag: "Interrupt" as const,
              id: messageKey,
              requestId,
              address,
            },
            lastReplyId: undefined,
          }),
        )
        .otherwise((otherKind) =>
          Result.fail(`Unknown WfMessage kind '${String(otherKind)}' on ${messageKey}`),
        )
    })
    .exhaustive()
}

const decodeRepliesWithIsolation = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): Effect.Effect<Array<Reply.Encoded>> =>
  Effect.gen(function* () {
    const out: Array<Reply.Encoded> = []
    for (const row of rows) {
      yield* match(decodeReplyRowIsolated(row))
        .with({ _tag: "Success" }, ({ success }) =>
          Effect.sync(() => {
            out.push(success)
          }),
        )
        .with({ _tag: "Failure" }, ({ failure }) =>
          Effect.logWarning(`Skipping corrupt WfReply row: ${failure}`),
        )
        .exhaustive()
    }
    return out
  })

const addressKeyFor = (address: {
  readonly shardId: { readonly group: string; readonly id: number } | ShardId.ShardId
  readonly entityType: string
  readonly entityId: string
}): string => `${ShardId.toString(address.shardId)}::${address.entityType}::${address.entityId}`

const collectDanglingRequestIds = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): Array<string> => {
  const ids = new Set<string>()
  for (const row of rows) {
    const id = readNonEmptyStringField(row.requestId) ?? readNonEmptyStringField(row.messageKey)
    if (id !== undefined) {
      ids.add(id)
    }
  }
  return Array.from(ids)
}

const fetchLastRepliesById = (
  target: WorkflowStoreRuntimeTarget,
  replyKeys: ReadonlyArray<string>,
  operation: WorkflowStoreOperation,
): Effect.Effect<Map<string, Reply.Encoded>, WorkflowStoreAttemptFailure> =>
  Effect.gen(function* () {
    const replyMap = new Map<string, Reply.Encoded>()
    if (replyKeys.length === 0) {
      return replyMap
    }
    const res = yield* invokeWorkflowStoreQueryOnce({
      repoRoot: target.repoRoot,
      operation,
      queryName: WorkflowStoreOperation.make("wf_replies_by_keys"),
      params: { replyKeys: [...replyKeys] },
      expectMutation: false,
      client: target.client,
      hostIo: target.hostIo,
      env: target.env,
    })
    const decodedReplies = yield* decodeRepliesWithIsolation(res.rows)
    for (const reply of decodedReplies) {
      replyMap.set(reply.id, reply)
    }
    return replyMap
  })

const hydrateCandidateRows = (
  target: WorkflowStoreRuntimeTarget,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  operation: WorkflowStoreOperation,
  addressFilter?: ReadonlySet<string>,
  limit?: number,
): Effect.Effect<
  {
    readonly items: Array<{
      readonly envelope: Envelope.Encoded
      readonly lastSentReply: Option.Option<Reply.Encoded>
    }>
    readonly messageKeys: Array<string>
  },
  WorkflowStoreAttemptFailure
> =>
  Effect.gen(function* () {
    const preliminary: Array<{
      readonly messageKey: string
      readonly envelope: Envelope.Encoded
      readonly lastReplyId: string | undefined
    }> = []

    for (const row of rows) {
      if (limit !== undefined && preliminary.length >= limit) {
        break
      }
      const parsedRow = yield* match(decodeEnvelopeRowIsolated(row))
        .with({ _tag: "Failure" }, ({ failure }) =>
          Effect.logWarning(`Skipping corrupt WfMessage row: ${failure}`).pipe(
            Effect.as(undefined),
          ),
        )
        .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
        .exhaustive()
      if (parsedRow === undefined) {
        continue
      }
      const { envelope, lastReplyId } = parsedRow
      if (addressFilter !== undefined && !addressFilter.has(addressKeyFor(envelope.address))) {
        continue
      }
      const messageKey = match(envelope)
        .with({ _tag: "Request" }, (req) => req.requestId)
        .with({ _tag: "AckChunk" }, { _tag: "Interrupt" }, (ctrl) => ctrl.id)
        .exhaustive()
      preliminary.push({ messageKey, envelope, lastReplyId })
    }

    if (preliminary.length === 0) {
      return { items: [], messageKeys: [] }
    }

    const replyKeysToFetch = Array.from(
      new Set(
        preliminary
          .map((entry) => entry.lastReplyId)
          .filter((id): id is string => id !== undefined && id.length > 0),
      ),
    )
    const replyMap = yield* fetchLastRepliesById(target, replyKeysToFetch, operation)

    const items: Array<{
      readonly envelope: Envelope.Encoded
      readonly lastSentReply: Option.Option<Reply.Encoded>
    }> = []
    const messageKeys: Array<string> = []
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
  primaryKeyHash: string | null,
  deliverAt: number | null,
  ifGraphCommit: string | undefined,
  operation: WorkflowStoreOperation,
): Effect.Effect<void, WorkflowStoreAttemptFailure> =>
  match(envelope)
    .with({ _tag: "Request" }, (req) =>
      Effect.gen(function* () {
        const seqKey = yield* encodeSeqKeyAsAttemptFailure(operation, req.requestId)
        yield* invokeWorkflowStoreQueryOnce({
          repoRoot: target.repoRoot,
          operation,
          queryName: WorkflowStoreOperation.make("wf_insert_request_message"),
          params: {
            messageKey: req.requestId,
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
            requestId: req.requestId,
            deliverAtMs: deliverAt,
          },
          expectMutation: true,
          ifGraphCommit,
          client: target.client,
          hostIo: target.hostIo,
          env: target.env,
        })
      }),
    )
    .with({ _tag: "AckChunk" }, (ack) =>
      Effect.gen(function* () {
        const seqKey = yield* encodeSeqKeyAsAttemptFailure(operation, ack.id)
        yield* invokeWorkflowStoreQueryOnce({
          repoRoot: target.repoRoot,
          operation,
          queryName: WorkflowStoreOperation.make("wf_insert_ack_chunk"),
          params: {
            messageKey: ack.id,
            seqKey,
            primaryKeyHash,
            shardId: ShardId.toString(ack.address.shardId),
            entityType: ack.address.entityType,
            entityId: ack.address.entityId,
            requestId: ack.requestId,
            replyId: ack.replyId,
            deliverAtMs: deliverAt,
          },
          expectMutation: true,
          ifGraphCommit,
          client: target.client,
          hostIo: target.hostIo,
          env: target.env,
        })
      }),
    )
    .with({ _tag: "Interrupt" }, (intr) =>
      Effect.gen(function* () {
        const seqKey = yield* encodeSeqKeyAsAttemptFailure(operation, intr.id)
        yield* invokeWorkflowStoreQueryOnce({
          repoRoot: target.repoRoot,
          operation,
          queryName: WorkflowStoreOperation.make("wf_insert_interrupt"),
          params: {
            messageKey: intr.id,
            seqKey,
            primaryKeyHash,
            shardId: ShardId.toString(intr.address.shardId),
            entityType: intr.address.entityType,
            entityId: intr.address.entityId,
            requestId: intr.requestId,
            deliverAtMs: deliverAt,
          },
          expectMutation: true,
          ifGraphCommit,
          client: target.client,
          hostIo: target.hostIo,
          env: target.env,
        })
      }),
    )
    .exhaustive()

export {
  addressKeyFor,
  ChunkValuesSchema,
  collectDanglingRequestIds,
  computePrimaryKeyHash,
  decodeEnvelopeRowIsolated,
  decodeRepliesWithIsolation,
  decodeReplyRowIsolated,
  encodeSeqKeyAsAttemptFailure,
  ExitEncodedSchema,
  fetchLastRepliesById,
  HeadersRecordSchema,
  hydrateCandidateRows,
  insertEnvelopeRow,
  parseShardIdEncoded,
  toPersistenceError,
}
