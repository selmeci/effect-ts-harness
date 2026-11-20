import { Effect, Layer, Option, Schema, Semaphore } from "effect"
import { MessageStorage, type Reply, ShardId, Snowflake } from "effect/cluster"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type LeaseEpoch,
  type LeaseFilePath,
  type MessageKey,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  invokeWorkflowStoreQuery,
  invokeWorkflowStoreQueryOnce,
  retryWorkflowStoreAttempt,
  toWorkflowStoreUnavailableError,
  type WorkflowStoreAttemptFailure,
} from "./omnigraph-workflow-store.js"
import {
  clearOmnigraphReplies,
  executeClearRepliesCore,
  type OmnigraphClearRepliesInput,
  repairDanglingProcessedRequests,
  type RepairDanglingRequestsInput,
} from "./workflow/message-storage-cas.js"
import {
  addressKeyFor,
  assertAffectedNodes,
  CandidateRowMetaSchema,
  collectDanglingRequestIds,
  computePrimaryKeyHash,
  decodeMessageKeyAsAttemptFailure,
  decodeMessageKeysAsAttemptFailure,
  decodeRepliesWithIsolation,
  decodeReplyKeyAsAttemptFailure,
  encodeSeqKeyAsAttemptFailure,
  toPersistenceError,
  WfMessageByPkRowSchema,
  WfMessageKeyForAddressRowSchema,
} from "./workflow/message-storage-codec.js"
import { hydrateCandidateRows, insertEnvelopeRow } from "./workflow/message-storage-hydration.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

/** Default claim timeout (`6 hours`, matching Effect Cluster `Sharding` activity protection). */
export const DEFAULT_WORKFLOW_CLAIM_TIMEOUT_MS = 6 * 60 * 60 * 1_000

const decodeCandidateRowMetaOption = Schema.decodeUnknownOption(CandidateRowMetaSchema)
const decodeByPkRowOption = Schema.decodeUnknownOption(WfMessageByPkRowSchema)
const decodeAddressKeyRowOption = Schema.decodeUnknownOption(WfMessageKeyForAddressRowSchema)

export interface OmnigraphMessageStorageOptions {
  readonly client?: Omnigraph | undefined
  readonly claimTimeoutMs?: number | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly writeMutex?: Semaphore.Semaphore | undefined
  readonly expectedLeaseEpoch?: LeaseEpoch | undefined
  readonly expectedLeaseOwner?: string | undefined
  readonly lockFilePath?: LeaseFilePath | undefined
}

const seqKeyForRow = (row: Readonly<Record<string, unknown>>): string =>
  match(decodeCandidateRowMetaOption(row))
    .with({ _tag: "Some" }, ({ value }) => value.seqKey ?? "")
    .with({ _tag: "None" }, () => "")
    .exhaustive()

const compareCandidateRowsBySeqKey = (
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): number => {
  const aSeq = seqKeyForRow(a)
  const bSeq = seqKeyForRow(b)
  if (aSeq < bSeq) return -1
  if (aSeq > bSeq) return 1
  return 0
}

const groupEntityIdsByType = (
  addresses: ReadonlyArray<{ readonly entityType: string; readonly entityId: string }>,
): Array<{ readonly entityType: string; readonly entityIds: Array<string> }> => {
  const byType = new Map<string, Set<string>>()
  for (const addr of addresses) {
    const existing = byType.get(addr.entityType)
    if (existing !== undefined) {
      existing.add(addr.entityId)
    } else {
      byType.set(addr.entityType, new Set([addr.entityId]))
    }
  }
  return Array.from(byType.entries(), ([entityType, ids]) => ({
    entityType,
    entityIds: Array.from(ids),
  }))
}

const mergeUniqueCandidateRows = (
  batches: ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>>,
): Array<Readonly<Record<string, unknown>>> => {
  const seenKeys = new Set<MessageKey>()
  const merged: Array<Readonly<Record<string, unknown>>> = []
  for (const rows of batches) {
    for (const row of rows) {
      const key = match(decodeCandidateRowMetaOption(row))
        .with({ _tag: "Some" }, ({ value }) => value.messageKey ?? undefined)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      if (key !== undefined) {
        if (seenKeys.has(key)) continue
        seenKeys.add(key)
      }
      merged.push(row)
    }
  }
  merged.sort(compareCandidateRowsBySeqKey)
  return merged
}

/**
 * Constructs the 13-method `MessageStorage.Encoded` driver backed by Omnigraph
 * graph `harness-workflows` (`seqKey` ordering, per-`entityType` GQ `addresses` pre-limit
 * filtering, local `writeMutex`, optional `expectedLeaseEpoch` fencing, and per-row
 * decode isolation).
 */
const makeOmnigraphEncodedDriver = (
  repoRoot: AbsoluteRepoRoot,
  options?: OmnigraphMessageStorageOptions,
): Effect.Effect<MessageStorage.Encoded, WorkflowStoreUnavailableError> =>
  Effect.gen(function* () {
    const client = options?.client
    const hostIo = options?.hostIo
    const env = options?.env
    const claimTimeoutMs = options?.claimTimeoutMs ?? DEFAULT_WORKFLOW_CLAIM_TIMEOUT_MS
    const writeMutex = options?.writeMutex ?? (yield* Semaphore.make(1))
    const expectedLeaseEpoch = options?.expectedLeaseEpoch
    const expectedLeaseOwner = options?.expectedLeaseOwner
    const lockFilePath = options?.lockFilePath

    const storeConfig = { client, hostIo, env }
    const fenceConfig = { expectedLeaseEpoch, expectedLeaseOwner, lockFilePath }
    const storeTarget = { repoRoot, ...storeConfig, ...fenceConfig }

    const encoded: MessageStorage.Encoded = {
      saveEnvelope: ({ envelope, primaryKey, deliverAt }) => {
        const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.saveEnvelope")
        const primaryKeyHash = primaryKey !== null ? computePrimaryKeyHash(primaryKey) : null
        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            writeMutex.withPermit(
              Effect.gen(function* () {
                if (primaryKeyHash !== null) {
                  const existingRes = yield* invokeWorkflowStoreQueryOnce({
                    repoRoot,
                    operation,
                    queryName: "wf_message_by_pk",
                    params: { primaryKeyHash },
                    expectMutation: false,
                    ...storeConfig,
                  })
                  const rawExisting = existingRes.rows[0]
                  if (rawExisting !== undefined) {
                    const existingRow = yield* match(decodeByPkRowOption(rawExisting))
                      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
                      .with({ _tag: "None" }, () =>
                        Effect.fail<WorkflowStoreAttemptFailure>({
                          _tag: "WorkflowStoreAttemptFailure",
                          operation,
                          cause: new Error(
                            "Corrupt WfMessage row returned by wf_message_by_pk lookup",
                          ),
                        }),
                      )
                      .exhaustive()
                    const originalId = Snowflake.Snowflake(existingRow.messageKey)
                    const lastReplyId = existingRow.lastReplyId ?? undefined
                    let lastReceivedReply: Option.Option<Reply.Encoded> = Option.none()
                    if (lastReplyId !== undefined) {
                      const replyRes = yield* invokeWorkflowStoreQueryOnce({
                        repoRoot,
                        operation,
                        queryName: "wf_reply_by_key",
                        params: { replyKey: lastReplyId },
                        expectMutation: false,
                        ...storeConfig,
                      })
                      const decodedReplies = yield* decodeRepliesWithIsolation(replyRes.rows)
                      lastReceivedReply = Option.fromNullishOr(decodedReplies[0])
                    }
                    return MessageStorage.SaveResultEncoded.Duplicate({
                      originalId,
                      lastReceivedReply,
                    })
                  }
                  yield* insertEnvelopeRow(
                    storeTarget,
                    envelope,
                    primaryKeyHash,
                    deliverAt,
                    existingRes.graphCommitId ?? undefined,
                    operation,
                  )
                  return MessageStorage.SaveResultEncoded.Success()
                }
                yield* insertEnvelopeRow(
                  storeTarget,
                  envelope,
                  null,
                  deliverAt,
                  undefined,
                  operation,
                )
                return MessageStorage.SaveResultEncoded.Success()
              }),
            ),
        }).pipe(Effect.mapError(toPersistenceError))
      },

      saveReply: (reply) => {
        const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.saveReply")
        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            writeMutex.withPermit(
              Effect.gen(function* () {
                const replyKey = yield* decodeReplyKeyAsAttemptFailure(operation, reply.id)
                const requestId = yield* decodeMessageKeyAsAttemptFailure(
                  operation,
                  reply.requestId,
                )
                const seqKey = yield* encodeSeqKeyAsAttemptFailure(operation, replyKey)
                yield* match(reply)
                  .with({ _tag: "WithExit" }, (exitReply) =>
                    invokeWorkflowStoreQueryOnce({
                      repoRoot,
                      operation,
                      queryName: "wf_save_reply_exit",
                      params: {
                        replyKey,
                        seqKey,
                        requestId,
                        payload: JSON.stringify(exitReply.exit),
                      },
                      expectMutation: true,
                      ...fenceConfig,
                      ...storeConfig,
                    }).pipe(
                      Effect.flatMap((res) =>
                        assertAffectedNodes(operation, "wf_save_reply_exit", res.affectedNodes, {
                          kind: "min",
                          count: 1,
                        }),
                      ),
                    ),
                  )
                  .with({ _tag: "Chunk" }, (chunkReply) =>
                    invokeWorkflowStoreQueryOnce({
                      repoRoot,
                      operation,
                      queryName: "wf_save_reply_chunk",
                      params: {
                        replyKey,
                        seqKey,
                        requestId,
                        payload: JSON.stringify(chunkReply.values),
                        sequence: chunkReply.sequence,
                      },
                      expectMutation: true,
                      ...fenceConfig,
                      ...storeConfig,
                    }).pipe(
                      Effect.flatMap((res) =>
                        assertAffectedNodes(operation, "wf_save_reply_chunk", res.affectedNodes, {
                          kind: "min",
                          count: 1,
                        }),
                      ),
                    ),
                  )
                  .exhaustive()
              }),
            ),
        }).pipe(Effect.asVoid, Effect.mapError(toPersistenceError))
      },

      clearReplies: (requestId, clearOptions) =>
        executeClearRepliesCore({
          repoRoot,
          requestId,
          expectedReplyId: clearOptions?.expectedReplyId,
          ...storeConfig,
          ...fenceConfig,
          writeMutex,
        }).pipe(Effect.mapError(toPersistenceError)),

      requestIdForPrimaryKey: (primaryKey) => {
        const operation = WorkflowStoreOperation.make(
          "OmnigraphMessageStorage.requestIdForPrimaryKey",
        )
        return invokeWorkflowStoreQuery({
          repoRoot,
          operation,
          queryName: "wf_message_by_pk",
          params: { primaryKeyHash: computePrimaryKeyHash(primaryKey) },
          expectMutation: false,
          ...storeConfig,
        }).pipe(
          Effect.flatMap((rows) => {
            const first = rows[0]
            if (first === undefined) {
              return Effect.succeed(Option.none<Snowflake.Snowflake>())
            }
            return match(decodeByPkRowOption(first))
              .with({ _tag: "Some" }, ({ value }) =>
                Effect.succeedSome(Snowflake.Snowflake(value.messageKey)),
              )
              .with({ _tag: "None" }, () =>
                Effect.fail(
                  toWorkflowStoreUnavailableError(
                    operation,
                    new Error("Corrupt WfMessage row returned by wf_message_by_pk"),
                  ),
                ),
              )
              .exhaustive()
          }),
          Effect.mapError(toPersistenceError),
        )
      },

      repliesFor: (requestIds) => {
        const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.repliesFor")
        return decodeMessageKeysAsAttemptFailure(operation, requestIds).pipe(
          Effect.flatMap((keys) =>
            invokeWorkflowStoreQuery({
              repoRoot,
              operation,
              queryName: "wf_replies_for",
              params: { requestIds: keys },
              expectMutation: false,
              ...storeConfig,
            }),
          ),
          Effect.flatMap((rows) => decodeRepliesWithIsolation(rows)),
          Effect.mapError(toPersistenceError),
        )
      },

      repliesForUnfiltered: (requestIds) => {
        const operation = WorkflowStoreOperation.make(
          "OmnigraphMessageStorage.repliesForUnfiltered",
        )
        return decodeMessageKeysAsAttemptFailure(operation, requestIds).pipe(
          Effect.flatMap((keys) =>
            invokeWorkflowStoreQuery({
              repoRoot,
              operation,
              queryName: "wf_replies_for_unfiltered",
              params: { requestIds: keys },
              expectMutation: false,
              ...storeConfig,
            }),
          ),
          Effect.flatMap((rows) => decodeRepliesWithIsolation(rows)),
          Effect.mapError(toPersistenceError),
        )
      },

      unprocessedMessages: (shardIds, now, queryOptions) => {
        if (queryOptions?.addresses !== undefined && queryOptions.addresses.length === 0) {
          return Effect.succeed([])
        }
        if (queryOptions?.limit !== undefined && queryOptions.limit <= 0) {
          return Effect.succeed([])
        }
        const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.unprocessedMessages")
        const shardIdList = [...shardIds]
        const claimCutoffMs = now - claimTimeoutMs
        const addresses = queryOptions?.addresses
        const addressFilter =
          addresses !== undefined ? new Set(addresses.map(addressKeyFor)) : undefined
        const addressGroups = addresses !== undefined ? groupEntityIdsByType(addresses) : undefined

        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            writeMutex.withPermit(
              Effect.gen(function* () {
                let candidateRows: ReadonlyArray<Readonly<Record<string, unknown>>>
                let candidateGraphCommitId: string | undefined

                if (addressGroups !== undefined) {
                  const perTypeResults = yield* Effect.forEach(
                    addressGroups,
                    (group) =>
                      invokeWorkflowStoreQueryOnce({
                        repoRoot,
                        operation,
                        queryName: "wf_unprocessed_candidate_messages_for_addresses",
                        params: {
                          shardIds: shardIdList,
                          entityType: group.entityType,
                          entityIds: group.entityIds,
                          claimCutoffMs,
                          nowMs: now,
                        },
                        expectMutation: false,
                        ...storeConfig,
                      }),
                    { concurrency: 1 },
                  )
                  candidateRows = mergeUniqueCandidateRows(perTypeResults.map((res) => res.rows))
                  candidateGraphCommitId =
                    perTypeResults[perTypeResults.length - 1]?.graphCommitId ?? undefined
                } else {
                  const candidateRes = yield* invokeWorkflowStoreQueryOnce({
                    repoRoot,
                    operation,
                    queryName: "wf_unprocessed_candidate_messages",
                    params: {
                      shardIds: shardIdList,
                      claimCutoffMs,
                      nowMs: now,
                    },
                    expectMutation: false,
                    ...storeConfig,
                  })
                  candidateRows = candidateRes.rows
                  candidateGraphCommitId = candidateRes.graphCommitId ?? undefined
                }

                const hydrated = yield* hydrateCandidateRows(
                  storeTarget,
                  candidateRows,
                  operation,
                  addressFilter,
                  queryOptions?.limit,
                  { persistCorruptDefect: true },
                )

                if (hydrated.messageKeys.length === 0) {
                  return []
                }

                const claimRes = yield* invokeWorkflowStoreQueryOnce({
                  repoRoot,
                  operation,
                  queryName: "wf_claim_messages",
                  params: {
                    messageKeys: hydrated.messageKeys,
                    nowMs: now,
                  },
                  expectMutation: true,
                  ifGraphCommit: candidateGraphCommitId,
                  ...fenceConfig,
                  ...storeConfig,
                })
                yield* assertAffectedNodes(operation, "wf_claim_messages", claimRes.affectedNodes, {
                  kind: "exact",
                  count: hydrated.messageKeys.length,
                })

                return hydrated.items
              }),
            ),
        }).pipe(Effect.mapError(toPersistenceError))
      },

      unprocessedMessagesById: (messageIds, now) => {
        const operation = WorkflowStoreOperation.make(
          "OmnigraphMessageStorage.unprocessedMessagesById",
        )
        const rawIds = Array.from(messageIds, String)
        if (rawIds.length === 0) {
          return Effect.succeed([])
        }
        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            Effect.gen(function* () {
              const messageKeys = yield* decodeMessageKeysAsAttemptFailure(operation, rawIds)
              const res = yield* invokeWorkflowStoreQueryOnce({
                repoRoot,
                operation,
                queryName: "wf_unprocessed_messages_by_id",
                params: { messageKeys, nowMs: now },
                expectMutation: false,
                ...storeConfig,
              })
              const hydrated = yield* hydrateCandidateRows(storeTarget, res.rows, operation)
              return hydrated.items
            }),
        }).pipe(Effect.mapError(toPersistenceError))
      },

      resetRequests: (requestIds) => {
        if (requestIds.length === 0) {
          return Effect.void
        }
        const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.resetRequests")
        const rawIds = requestIds.map(String)
        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            writeMutex.withPermit(
              Effect.gen(function* () {
                const messageKeys = yield* decodeMessageKeysAsAttemptFailure(operation, rawIds)
                yield* invokeWorkflowStoreQueryOnce({
                  repoRoot,
                  operation,
                  queryName: "wf_reset_requests",
                  params: { messageKeys, clearReadMs: null },
                  expectMutation: true,
                  ...fenceConfig,
                  ...storeConfig,
                })
              }),
            ),
        }).pipe(Effect.asVoid, Effect.mapError(toPersistenceError))
      },

      resetAddresses: (addresses) => {
        if (addresses.length === 0) {
          return Effect.void
        }
        const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.resetAddresses")
        const grouped = new Map<
          string,
          {
            readonly shardId: string
            readonly entityType: string
            readonly entityIds: Array<string>
          }
        >()
        for (const addr of addresses) {
          const shardId = ShardId.toString(addr.shardId)
          const groupKey = `${shardId}::${addr.entityType}`
          const existing = grouped.get(groupKey)
          if (existing !== undefined) {
            if (!existing.entityIds.includes(addr.entityId)) {
              existing.entityIds.push(addr.entityId)
            }
          } else {
            grouped.set(groupKey, {
              shardId,
              entityType: addr.entityType,
              entityIds: [addr.entityId],
            })
          }
        }
        const groups = Array.from(grouped.values())

        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            writeMutex.withPermit(
              Effect.forEach(
                groups,
                (group) => {
                  const singleEntityId = group.entityIds[0]
                  return group.entityIds.length === 1 && singleEntityId !== undefined
                    ? invokeWorkflowStoreQueryOnce({
                        repoRoot,
                        operation,
                        queryName: "wf_reset_address",
                        params: {
                          shardId: group.shardId,
                          entityType: group.entityType,
                          entityId: singleEntityId,
                          clearReadMs: null,
                        },
                        expectMutation: true,
                        ...fenceConfig,
                        ...storeConfig,
                      })
                    : invokeWorkflowStoreQueryOnce({
                        repoRoot,
                        operation,
                        queryName: "wf_reset_address_group",
                        params: {
                          shardId: group.shardId,
                          entityType: group.entityType,
                          entityIds: group.entityIds,
                          clearReadMs: null,
                        },
                        expectMutation: true,
                        ...fenceConfig,
                        ...storeConfig,
                      })
                },
                { discard: true },
              ),
            ),
        }).pipe(Effect.asVoid, Effect.mapError(toPersistenceError))
      },

      clearAddress: (address) => {
        const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.clearAddress")
        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            writeMutex.withPermit(
              Effect.gen(function* () {
                const keysRes = yield* invokeWorkflowStoreQueryOnce({
                  repoRoot,
                  operation,
                  queryName: "wf_message_keys_for_address",
                  params: {
                    entityType: address.entityType,
                    entityId: address.entityId,
                  },
                  expectMutation: false,
                  ...storeConfig,
                })
                if (keysRes.rows.length === 0) {
                  return
                }
                const requestIdSet = new Set<MessageKey>()
                for (const rawRow of keysRes.rows) {
                  const decodedRow = yield* match(decodeAddressKeyRowOption(rawRow))
                    .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
                    .with({ _tag: "None" }, () =>
                      Effect.fail<WorkflowStoreAttemptFailure>({
                        _tag: "WorkflowStoreAttemptFailure",
                        operation,
                        cause: new Error("Corrupt row returned by wf_message_keys_for_address"),
                      }),
                    )
                    .exhaustive()
                  requestIdSet.add(decodedRow.requestId)
                }
                const requestIds = Array.from(requestIdSet)
                const clearRes = yield* invokeWorkflowStoreQueryOnce({
                  repoRoot,
                  operation,
                  queryName: "wf_clear_address",
                  params: {
                    requestIds,
                    entityType: address.entityType,
                    entityId: address.entityId,
                  },
                  expectMutation: true,
                  ifGraphCommit: keysRes.graphCommitId ?? undefined,
                  ...fenceConfig,
                  ...storeConfig,
                })
                yield* assertAffectedNodes(operation, "wf_clear_address", clearRes.affectedNodes, {
                  kind: "min",
                  count: 1,
                })
              }),
            ),
        }).pipe(Effect.asVoid, Effect.mapError(toPersistenceError))
      },

      resetShards: (shardIds) => {
        const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.resetShards")
        const shardIdList = [...shardIds]
        if (shardIdList.length === 0) {
          return Effect.void
        }
        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            writeMutex.withPermit(
              Effect.gen(function* () {
                const danglingRes = yield* invokeWorkflowStoreQueryOnce({
                  repoRoot,
                  operation,
                  queryName: "wf_dangling_processed_requests",
                  params: {},
                  expectMutation: false,
                  ...storeConfig,
                })
                if (danglingRes.rows.length > 0) {
                  const messageKeys = collectDanglingRequestIds(danglingRes.rows)
                  if (messageKeys.length > 0) {
                    yield* invokeWorkflowStoreQueryOnce({
                      repoRoot,
                      operation,
                      queryName: "wf_repair_dangling_requests",
                      params: {
                        messageKeys,
                        clearReplyId: null,
                        clearReadMs: null,
                      },
                      expectMutation: true,
                      ...fenceConfig,
                      ...storeConfig,
                    })
                  }
                }
                yield* invokeWorkflowStoreQueryOnce({
                  repoRoot,
                  operation,
                  queryName: "wf_reset_shards",
                  params: {
                    shardIds: shardIdList,
                    clearReadMs: null,
                  },
                  expectMutation: true,
                  ...fenceConfig,
                  ...storeConfig,
                })
              }),
            ),
        }).pipe(Effect.asVoid, Effect.mapError(toPersistenceError))
      },

      withTransaction: (effect) => effect,
    }

    return encoded
  }).pipe(
    Effect.catchDefect((cause) =>
      Effect.fail(
        toWorkflowStoreUnavailableError(
          WorkflowStoreOperation.make("OmnigraphMessageStorage.init"),
          cause,
        ),
      ),
    ),
  )

/**
 * Builds the `MessageStorage.MessageStorage` layer for a specific repository root.
 */
const makeOmnigraphMessageStorageLayer = (
  repoRoot: AbsoluteRepoRoot,
  options?: OmnigraphMessageStorageOptions,
): Layer.Layer<MessageStorage.MessageStorage, WorkflowStoreUnavailableError> =>
  Layer.effect(
    MessageStorage.MessageStorage,
    makeOmnigraphEncodedDriver(repoRoot, options).pipe(Effect.flatMap(MessageStorage.makeEncoded)),
  ).pipe(Layer.provide(Snowflake.layerGenerator))

export {
  clearOmnigraphReplies,
  computePrimaryKeyHash,
  makeOmnigraphEncodedDriver,
  makeOmnigraphMessageStorageLayer,
  type OmnigraphClearRepliesInput,
  repairDanglingProcessedRequests,
  type RepairDanglingRequestsInput,
}
