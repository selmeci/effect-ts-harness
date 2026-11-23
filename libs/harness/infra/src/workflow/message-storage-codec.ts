import { createHash } from "node:crypto"
import { Effect, Result, Schema } from "effect"
import { ClusterError, type Envelope, type Reply, ShardId } from "effect/cluster"
import { match } from "ts-pattern"
import {
  encodeSeqKey,
  MessageKey,
  PrimaryKeyHash,
  ReplyKey,
  SeqKey,
  toErrorReasonMessage,
  type WorkflowGqQueryName,
  WorkflowStoreOperation,
} from "@harness/contract"
import {
  decodeJsonFieldSafely,
  makeMintReplyKey,
  type WorkflowStoreAttemptFailure,
} from "./workflow-store-codec.js"

const MAX_PRIMARY_KEY_PLAINTEXT_LEN = 255

/**
 * Encodes a message primary key deterministically into a branded `PrimaryKeyHash`:
 * non-empty keys `<= 255` characters are stored verbatim, and empty or longer keys
 * are hashed as `sha256:<hex>`.
 */
const computePrimaryKeyHash = (primaryKey: string): PrimaryKeyHash =>
  primaryKey.length >= 1 && primaryKey.length <= MAX_PRIMARY_KEY_PLAINTEXT_LEN
    ? PrimaryKeyHash.make(primaryKey)
    : PrimaryKeyHash.make(`sha256:${createHash("sha256").update(primaryKey).digest("hex")}`)

const toPersistenceError = (cause: unknown): ClusterError.PersistenceError =>
  cause instanceof ClusterError.PersistenceError
    ? cause
    : new ClusterError.PersistenceError({ cause })

const decodeMessageKeyResult = Schema.decodeUnknownResult(MessageKey)
const decodeReplyKeyResult = Schema.decodeUnknownResult(ReplyKey)

const decodeMessageKeyAsAttemptFailure = (
  operation: WorkflowStoreOperation,
  rawId: unknown,
): Effect.Effect<MessageKey, WorkflowStoreAttemptFailure> =>
  match(decodeMessageKeyResult(rawId))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail<WorkflowStoreAttemptFailure>({
        _tag: "WorkflowStoreAttemptFailure",
        operation,
        cause: new Error(`Invalid MessageKey '${String(rawId)}': ${toErrorReasonMessage(failure)}`),
      }),
    )
    .exhaustive()

const decodeReplyKeyAsAttemptFailure = (
  operation: WorkflowStoreOperation,
  rawId: unknown,
): Effect.Effect<ReplyKey, WorkflowStoreAttemptFailure> =>
  match(decodeReplyKeyResult(rawId))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail<WorkflowStoreAttemptFailure>({
        _tag: "WorkflowStoreAttemptFailure",
        operation,
        cause: new Error(`Invalid ReplyKey '${String(rawId)}': ${toErrorReasonMessage(failure)}`),
      }),
    )
    .exhaustive()

const decodeMessageKeysAsAttemptFailure = (
  operation: WorkflowStoreOperation,
  rawIds: ReadonlyArray<unknown>,
): Effect.Effect<Array<MessageKey>, WorkflowStoreAttemptFailure> =>
  Effect.forEach(rawIds, (rawId) => decodeMessageKeyAsAttemptFailure(operation, rawId))

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

const assertAffectedNodes = (
  operation: WorkflowStoreOperation,
  queryName: WorkflowGqQueryName,
  actualNodes: number,
  expected: { readonly kind: "min" | "exact"; readonly count: number },
): Effect.Effect<void, WorkflowStoreAttemptFailure> => {
  const valid = match(expected.kind)
    .with("exact", () => actualNodes === expected.count)
    .with("min", () => actualNodes >= expected.count)
    .exhaustive()
  if (valid) {
    return Effect.void
  }
  const expectationText = match(expected.kind)
    .with("exact", () => `expected === ${expected.count}`)
    .with("min", () => `expected >= ${expected.count}`)
    .exhaustive()
  return Effect.fail<WorkflowStoreAttemptFailure>({
    _tag: "WorkflowStoreAttemptFailure",
    operation,
    cause: new Error(`${queryName} affected ${actualNodes} nodes (${expectationText})`),
  })
}

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

export const WfReplyRowSchema = Schema.Struct({
  replyKey: ReplyKey,
  seqKey: Schema.optional(Schema.NullOr(SeqKey)),
  requestId: MessageKey,
  kind: Schema.Literals(["with_exit", "chunk"]),
  payload: Schema.String,
  sequence: Schema.optional(Schema.NullOr(Schema.Int)),
  acked: Schema.optional(Schema.NullOr(Schema.Boolean)),
})

export const WfMessageRowSchema = Schema.Struct({
  messageKey: MessageKey,
  seqKey: Schema.optional(Schema.NullOr(SeqKey)),
  primaryKeyHash: Schema.optional(Schema.NullOr(PrimaryKeyHash)),
  shardId: Schema.NonEmptyString,
  entityType: Schema.NonEmptyString,
  entityId: Schema.NonEmptyString,
  kind: Schema.Literals(["request", "ack_chunk", "interrupt"]),
  tag: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  payload: Schema.optional(Schema.NullOr(Schema.String)),
  headers: Schema.optional(Schema.NullOr(Schema.String)),
  traceId: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  spanId: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  sampled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  requestId: MessageKey,
  replyId: Schema.optional(Schema.NullOr(ReplyKey)),
  processed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  lastReplyId: Schema.optional(Schema.NullOr(ReplyKey)),
  lastReadMs: Schema.optional(Schema.NullOr(Schema.Finite)),
  deliverAtMs: Schema.optional(Schema.NullOr(Schema.Finite)),
})

export const WfMessageByPkRowSchema = Schema.Struct({
  messageKey: MessageKey,
  lastReplyId: Schema.optional(Schema.NullOr(ReplyKey)),
})

export const WfDanglingRequestRowSchema = Schema.Struct({
  messageKey: Schema.optional(Schema.NullOr(MessageKey)),
  requestId: Schema.optional(Schema.NullOr(MessageKey)),
})

export const WfMessageKeyForAddressRowSchema = Schema.Struct({
  messageKey: MessageKey,
  requestId: MessageKey,
})

export const WfMessageClearStateRowSchema = Schema.Struct({
  messageKey: MessageKey,
  lastReplyId: Schema.optional(Schema.NullOr(ReplyKey)),
})

export const CandidateRowMetaSchema = Schema.Struct({
  messageKey: Schema.optional(Schema.NullOr(MessageKey)),
  seqKey: Schema.optional(Schema.NullOr(SeqKey)),
})

const CorruptReplyIdentitySchema = Schema.Struct({
  replyKey: Schema.optional(Schema.NullOr(ReplyKey)),
  requestId: MessageKey,
})

const decodeWfReplyRowResult = Schema.decodeUnknownResult(WfReplyRowSchema)
const decodeWfMessageRowResult = Schema.decodeUnknownResult(WfMessageRowSchema)
const decodeCorruptReplyIdentityOption = Schema.decodeUnknownOption(CorruptReplyIdentitySchema)
const decodeDanglingRequestRowOption = Schema.decodeUnknownOption(WfDanglingRequestRowSchema)

const parseShardIdEncoded = (
  rawStr: string,
): Result.Result<{ readonly group: string; readonly id: number }, string> =>
  Result.try({
    try: () => ShardId.fromStringEncoded(rawStr),
    catch: (err) => toErrorReasonMessage(err, `Invalid shardId '${rawStr}'`),
  })

const normalizeExitEncoded = (
  exit: typeof ExitEncodedSchema.Type,
): Extract<Reply.Encoded, { readonly _tag: "WithExit" }>["exit"] =>
  match(exit)
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

const decodeReplyRowIsolated = (
  rawRow: Readonly<Record<string, unknown>>,
): Result.Result<Reply.Encoded, string> =>
  match(decodeWfReplyRowResult(rawRow))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(toErrorReasonMessage(failure, "Invalid WfReply row schema")),
    )
    .with({ _tag: "Success" }, ({ success: row }) =>
      match(row.kind)
        .with("with_exit", () =>
          match(decodeJsonFieldSafely(row.payload, ExitEncodedSchema))
            .with({ _tag: "Failure" }, ({ failure }) =>
              Result.fail(`Corrupt JSON on WfReply(with_exit) ${row.replyKey}: ${failure}`),
            )
            .with({ _tag: "Success" }, ({ success: exit }) =>
              Result.succeed<Reply.Encoded>({
                _tag: "WithExit",
                id: row.replyKey,
                requestId: row.requestId,
                exit: normalizeExitEncoded(exit),
              }),
            )
            .exhaustive(),
        )
        .with("chunk", () => {
          const seq = row.sequence
          if (seq === undefined || seq === null) {
            return Result.fail(`Invalid sequence on WfReply(chunk) ${row.replyKey}: ${String(seq)}`)
          }
          return match(decodeJsonFieldSafely(row.payload, ChunkValuesSchema))
            .with({ _tag: "Failure" }, ({ failure }) =>
              Result.fail(`Corrupt JSON on WfReply(chunk) ${row.replyKey}: ${failure}`),
            )
            .with({ _tag: "Success" }, ({ success: values }) =>
              Result.succeed<Reply.Encoded>({
                _tag: "Chunk",
                id: row.replyKey,
                requestId: row.requestId,
                sequence: seq,
                values,
              }),
            )
            .exhaustive()
        })
        .exhaustive(),
    )
    .exhaustive()

const decodeEnvelopeRowIsolated = (
  rawRow: Readonly<Record<string, unknown>>,
): Result.Result<
  {
    readonly messageKey: MessageKey
    readonly envelope: Envelope.Encoded
    readonly lastReplyId: ReplyKey | undefined
  },
  string
> =>
  match(decodeWfMessageRowResult(rawRow))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(toErrorReasonMessage(failure, "Invalid WfMessage row schema")),
    )
    .with({ _tag: "Success" }, ({ success: row }) =>
      match(parseShardIdEncoded(row.shardId))
        .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
        .with({ _tag: "Success" }, ({ success: shardId }) => {
          const address = { shardId, entityType: row.entityType, entityId: row.entityId }
          const lastReplyId = row.lastReplyId ?? undefined

          return match(row.kind)
            .with("request", () => {
              if (
                row.tag === undefined ||
                row.tag === null ||
                row.payload === undefined ||
                row.payload === null ||
                row.headers === undefined ||
                row.headers === null
              ) {
                return Result.fail(
                  `Missing tag/payload/headers on WfMessage(request) ${row.messageKey}`,
                )
              }
              const tag = row.tag
              const payloadRes = decodeJsonFieldSafely(row.payload, Schema.Unknown)
              const headersRes = decodeJsonFieldSafely(row.headers, HeadersRecordSchema)
              return match(payloadRes)
                .with({ _tag: "Failure" }, ({ failure }) =>
                  Result.fail(
                    `Corrupt JSON payload on WfMessage(request) ${row.messageKey}: ${failure}`,
                  ),
                )
                .with({ _tag: "Success" }, ({ success: payload }) =>
                  match(headersRes)
                    .with({ _tag: "Failure" }, ({ failure }) =>
                      Result.fail(
                        `Corrupt JSON headers on WfMessage(request) ${row.messageKey}: ${failure}`,
                      ),
                    )
                    .with({ _tag: "Success" }, ({ success: headers }) => {
                      const traceId = row.traceId ?? undefined
                      const spanId = row.spanId ?? undefined
                      const sampled = row.sampled ?? undefined
                      return Result.succeed({
                        messageKey: row.messageKey,
                        envelope: {
                          _tag: "Request" as const,
                          requestId: row.requestId,
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
              const replyId = row.replyId ?? undefined
              if (replyId === undefined) {
                return Result.fail(`Missing replyId on WfMessage(ack_chunk) ${row.messageKey}`)
              }
              return Result.succeed({
                messageKey: row.messageKey,
                envelope: {
                  _tag: "AckChunk" as const,
                  id: row.messageKey,
                  requestId: row.requestId,
                  replyId,
                  address,
                },
                lastReplyId: undefined,
              })
            })
            .with("interrupt", () =>
              Result.succeed({
                messageKey: row.messageKey,
                envelope: {
                  _tag: "Interrupt" as const,
                  id: row.messageKey,
                  requestId: row.requestId,
                  address,
                },
                lastReplyId: undefined,
              }),
            )
            .exhaustive()
        })
        .exhaustive(),
    )
    .exhaustive()

/**
 * Decodes `WfReply` rows in Effect Cluster semantics (`MessageStorage.ts`):
 * corrupt reply rows with an identifiable `requestId` synthesize a terminal
 * `WithExit(Die)` reply and ignore further replies for that `requestId` in the batch.
 */
const decodeRepliesWithIsolation = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  mintReplyKey: () => ReplyKey = makeMintReplyKey(),
): Effect.Effect<Array<Reply.Encoded>> =>
  Effect.gen(function* () {
    const out: Array<Reply.Encoded> = []
    const ignoredRequests = new Set<MessageKey>()
    for (const row of rows) {
      const identityOpt = decodeCorruptReplyIdentityOption(row)
      const knownRequestId = match(identityOpt)
        .with({ _tag: "Some" }, ({ value }) => value.requestId)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      if (knownRequestId !== undefined && ignoredRequests.has(knownRequestId)) {
        continue
      }
      yield* match(decodeReplyRowIsolated(row))
        .with({ _tag: "Success" }, ({ success }) =>
          Effect.sync(() => {
            out.push(success)
          }),
        )
        .with({ _tag: "Failure" }, ({ failure }) =>
          match(identityOpt)
            .with({ _tag: "Some" }, ({ value }) =>
              Effect.gen(function* () {
                ignoredRequests.add(value.requestId)
                const syntheticId = value.replyKey ?? mintReplyKey()
                yield* Effect.logWarning(
                  `Corrupt WfReply row for requestId=${value.requestId}; synthesizing WithExit(Die): ${failure}`,
                )
                out.push({
                  _tag: "WithExit",
                  id: syntheticId,
                  requestId: value.requestId,
                  exit: {
                    _tag: "Failure",
                    cause: [{ _tag: "Die", defect: `Corrupt WfReply row: ${failure}` }],
                  },
                })
              }),
            )
            .with({ _tag: "None" }, () =>
              Effect.logWarning(`Skipping unidentifiable corrupt WfReply row: ${failure}`),
            )
            .exhaustive(),
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
): Array<MessageKey> => {
  const ids = new Set<MessageKey>()
  for (const row of rows) {
    match(decodeDanglingRequestRowOption(row))
      .with({ _tag: "Some" }, ({ value }) => {
        const id = value.requestId ?? value.messageKey
        if (id !== undefined && id !== null) {
          ids.add(id)
        }
      })
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
  }
  return Array.from(ids)
}

export {
  addressKeyFor,
  assertAffectedNodes,
  ChunkValuesSchema,
  collectDanglingRequestIds,
  computePrimaryKeyHash,
  decodeEnvelopeRowIsolated,
  decodeMessageKeyAsAttemptFailure,
  decodeMessageKeysAsAttemptFailure,
  decodeRepliesWithIsolation,
  decodeReplyKeyAsAttemptFailure,
  decodeReplyRowIsolated,
  encodeSeqKeyAsAttemptFailure,
  ExitEncodedSchema,
  HeadersRecordSchema,
  parseShardIdEncoded,
  toPersistenceError,
}
