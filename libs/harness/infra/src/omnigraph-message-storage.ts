import { Effect, Layer, Option, Semaphore } from "effect"
import { MessageStorage, type Reply, ShardId, Snowflake } from "effect/cluster"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
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
  collectDanglingRequestIds,
  computePrimaryKeyHash,
  decodeRepliesWithIsolation,
  encodeSeqKeyAsAttemptFailure,
  hydrateCandidateRows,
  insertEnvelopeRow,
  toPersistenceError,
} from "./workflow/message-storage-codec.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

/** Default claim timeout (`6 hours`, matching Effect Cluster `Sharding` activity protection). */
export const DEFAULT_WORKFLOW_CLAIM_TIMEOUT_MS = 6 * 60 * 60 * 1_000

export interface OmnigraphMessageStorageOptions {
  readonly client?: Omnigraph | undefined
  readonly claimTimeoutMs?: number | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly writeMutex?: Semaphore.Semaphore | undefined
}

const compareCandidateRowsBySeqKey = (
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): number => {
  const aSeq = typeof a.seqKey === "string" ? a.seqKey : ""
  const bSeq = typeof b.seqKey === "string" ? b.seqKey : ""
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
  const seenKeys = new Set<string>()
  const merged: Array<Readonly<Record<string, unknown>>> = []
  for (const rows of batches) {
    for (const row of rows) {
      const key = typeof row.messageKey === "string" ? row.messageKey : undefined
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
 * filtering, local `writeMutex`, and per-row JSON decode isolation).
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

    const storeConfig = { client, hostIo, env }
    const storeTarget = { repoRoot, client, hostIo, env }

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
                    queryName: WorkflowStoreOperation.make("wf_message_by_pk"),
                    params: { primaryKeyHash },
                    expectMutation: false,
                    ...storeConfig,
                  })
                  const existingRow = existingRes.rows[0]
                  if (existingRow !== undefined) {
                    const originalId = Snowflake.Snowflake(String(existingRow.messageKey))
                    const lastReplyId =
                      typeof existingRow.lastReplyId === "string"
                        ? existingRow.lastReplyId
                        : undefined
                    let lastReceivedReply: Option.Option<Reply.Encoded> = Option.none()
                    if (lastReplyId !== undefined && lastReplyId.length > 0) {
                      const replyRes = yield* invokeWorkflowStoreQueryOnce({
                        repoRoot,
                        operation,
                        queryName: WorkflowStoreOperation.make("wf_reply_by_key"),
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
                const seqKey = yield* encodeSeqKeyAsAttemptFailure(operation, reply.id)
                yield* match(reply)
                  .with({ _tag: "WithExit" }, (exitReply) =>
                    invokeWorkflowStoreQueryOnce({
                      repoRoot,
                      operation,
                      queryName: WorkflowStoreOperation.make("wf_save_reply_exit"),
                      params: {
                        replyKey: exitReply.id,
                        seqKey,
                        requestId: exitReply.requestId,
                        payload: JSON.stringify(exitReply.exit),
                      },
                      expectMutation: true,
                      ...storeConfig,
                    }),
                  )
                  .with({ _tag: "Chunk" }, (chunkReply) =>
                    invokeWorkflowStoreQueryOnce({
                      repoRoot,
                      operation,
                      queryName: WorkflowStoreOperation.make("wf_save_reply_chunk"),
                      params: {
                        replyKey: chunkReply.id,
                        seqKey,
                        requestId: chunkReply.requestId,
                        payload: JSON.stringify(chunkReply.values),
                        sequence: chunkReply.sequence,
                      },
                      expectMutation: true,
                      ...storeConfig,
                    }),
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
          writeMutex,
        }).pipe(Effect.mapError(toPersistenceError)),

      requestIdForPrimaryKey: (primaryKey) => {
        const operation = WorkflowStoreOperation.make(
          "OmnigraphMessageStorage.requestIdForPrimaryKey",
        )
        return invokeWorkflowStoreQuery({
          repoRoot,
          operation,
          queryName: WorkflowStoreOperation.make("wf_message_by_pk"),
          params: { primaryKeyHash: computePrimaryKeyHash(primaryKey) },
          expectMutation: false,
          ...storeConfig,
        }).pipe(
          Effect.map((rows) => {
            const first = rows[0]
            if (!first || typeof first.messageKey !== "string" || first.messageKey.length === 0) {
              return Option.none<Snowflake.Snowflake>()
            }
            return Option.some(Snowflake.Snowflake(first.messageKey))
          }),
          Effect.mapError(toPersistenceError),
        )
      },

      repliesFor: (requestIds) =>
        invokeWorkflowStoreQuery({
          repoRoot,
          operation: WorkflowStoreOperation.make("OmnigraphMessageStorage.repliesFor"),
          queryName: WorkflowStoreOperation.make("wf_replies_for"),
          params: { requestIds: [...requestIds] },
          expectMutation: false,
          ...storeConfig,
        }).pipe(Effect.flatMap(decodeRepliesWithIsolation), Effect.mapError(toPersistenceError)),

      repliesForUnfiltered: (requestIds) =>
        invokeWorkflowStoreQuery({
          repoRoot,
          operation: WorkflowStoreOperation.make("OmnigraphMessageStorage.repliesForUnfiltered"),
          queryName: WorkflowStoreOperation.make("wf_replies_for_unfiltered"),
          params: { requestIds: [...requestIds] },
          expectMutation: false,
          ...storeConfig,
        }).pipe(Effect.flatMap(decodeRepliesWithIsolation), Effect.mapError(toPersistenceError)),

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
                        queryName: WorkflowStoreOperation.make(
                          "wf_unprocessed_candidate_messages_for_addresses",
                        ),
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
                    queryName: WorkflowStoreOperation.make("wf_unprocessed_candidate_messages"),
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
                )

                if (hydrated.messageKeys.length === 0) {
                  return []
                }

                yield* invokeWorkflowStoreQueryOnce({
                  repoRoot,
                  operation,
                  queryName: WorkflowStoreOperation.make("wf_claim_messages"),
                  params: {
                    messageKeys: hydrated.messageKeys,
                    nowMs: now,
                  },
                  expectMutation: true,
                  ifGraphCommit: candidateGraphCommitId,
                  ...storeConfig,
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
        const messageKeys = Array.from(messageIds, String)
        if (messageKeys.length === 0) {
          return Effect.succeed([])
        }
        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            Effect.gen(function* () {
              const res = yield* invokeWorkflowStoreQueryOnce({
                repoRoot,
                operation,
                queryName: WorkflowStoreOperation.make("wf_unprocessed_messages_by_id"),
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
        const messageKeys = requestIds.map(String)
        return retryWorkflowStoreAttempt({
          operation,
          retryConflicts: true,
          runAttempt: () =>
            writeMutex.withPermit(
              invokeWorkflowStoreQueryOnce({
                repoRoot,
                operation,
                queryName: WorkflowStoreOperation.make("wf_reset_requests"),
                params: { messageKeys, clearReadMs: null },
                expectMutation: true,
                ...storeConfig,
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
                (group) =>
                  group.entityIds.length === 1
                    ? invokeWorkflowStoreQueryOnce({
                        repoRoot,
                        operation,
                        queryName: WorkflowStoreOperation.make("wf_reset_address"),
                        params: {
                          shardId: group.shardId,
                          entityType: group.entityType,
                          entityId: group.entityIds[0],
                          clearReadMs: null,
                        },
                        expectMutation: true,
                        ...storeConfig,
                      })
                    : invokeWorkflowStoreQueryOnce({
                        repoRoot,
                        operation,
                        queryName: WorkflowStoreOperation.make("wf_reset_address_group"),
                        params: {
                          shardId: group.shardId,
                          entityType: group.entityType,
                          entityIds: group.entityIds,
                          clearReadMs: null,
                        },
                        expectMutation: true,
                        ...storeConfig,
                      }),
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
                  queryName: WorkflowStoreOperation.make("wf_message_keys_for_address"),
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
                const requestIds = Array.from(
                  new Set(
                    keysRes.rows
                      .map((row) => row.requestId)
                      .filter((id): id is string => typeof id === "string" && id.length > 0),
                  ),
                )
                yield* invokeWorkflowStoreQueryOnce({
                  repoRoot,
                  operation,
                  queryName: WorkflowStoreOperation.make("wf_clear_address"),
                  params: {
                    requestIds,
                    entityType: address.entityType,
                    entityId: address.entityId,
                  },
                  expectMutation: true,
                  ifGraphCommit: keysRes.graphCommitId ?? undefined,
                  ...storeConfig,
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
                  queryName: WorkflowStoreOperation.make("wf_dangling_processed_requests"),
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
                      queryName: WorkflowStoreOperation.make("wf_repair_dangling_requests"),
                      params: {
                        messageKeys,
                        clearReplyId: null,
                        clearReadMs: null,
                      },
                      expectMutation: true,
                      ...storeConfig,
                    })
                  }
                }
                yield* invokeWorkflowStoreQueryOnce({
                  repoRoot,
                  operation,
                  queryName: WorkflowStoreOperation.make("wf_reset_shards"),
                  params: {
                    shardIds: shardIdList,
                    clearReadMs: null,
                  },
                  expectMutation: true,
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
