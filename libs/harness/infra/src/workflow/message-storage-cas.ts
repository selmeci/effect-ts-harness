import { Effect, Semaphore } from "effect"
import type { ClusterError, Snowflake } from "effect/cluster"
import {
  type AbsoluteRepoRoot,
  type SeqKey,
  toErrorReasonMessage,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  invokeWorkflowStoreQueryOnce,
  retryWorkflowStoreAttempt,
} from "../omnigraph-workflow-store.js"
import { collectDanglingRequestIds } from "./message-storage-codec.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export interface OmnigraphClearRepliesInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly requestId: Snowflake.Snowflake
  readonly expectedReplyId?: Snowflake.Snowflake | undefined
  readonly seqKey?: SeqKey | undefined
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly writeMutex?: Semaphore.Semaphore | undefined
}

export interface ClearRepliesCoreInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly requestId: Snowflake.Snowflake
  readonly expectedReplyId?: Snowflake.Snowflake | undefined
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly writeMutex: Semaphore.Semaphore
}

export interface RepairDanglingRequestsInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly writeMutex?: Semaphore.Semaphore | undefined
}

const executeClearRepliesCore = (
  input: ClearRepliesCoreInput,
): Effect.Effect<void, WorkflowStoreUnavailableError> => {
  const reqId = String(input.requestId)
  const expectedReplyId =
    input.expectedReplyId !== undefined ? String(input.expectedReplyId) : undefined
  const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.clearReplies")

  // Single unretried compensation inside writeMutex; outer retry handles any backoff outside mutex.
  const compensateDanglingOnce = (): Effect.Effect<void> =>
    invokeWorkflowStoreQueryOnce({
      repoRoot: input.repoRoot,
      operation: WorkflowStoreOperation.make("OmnigraphMessageStorage.clearReplies.compensate"),
      queryName: WorkflowStoreOperation.make("wf_repair_dangling_requests"),
      params: {
        messageKeys: [reqId],
        clearReplyId: null,
        clearReadMs: null,
      },
      expectMutation: true,
      client: input.client,
      hostIo: input.hostIo,
      env: input.env,
    }).pipe(
      Effect.asVoid,
      Effect.catch((compErr) =>
        Effect.logWarning(
          `clearReplies Commit-2 compensation failed for ${reqId}: ${toErrorReasonMessage(compErr.cause, "Commit-2 compensation failed")}`,
        ),
      ),
    )

  return retryWorkflowStoreAttempt({
    operation,
    retryConflicts: true,
    runAttempt: () =>
      input.writeMutex.withPermit(
        Effect.gen(function* () {
          if (expectedReplyId !== undefined) {
            const readRes = yield* invokeWorkflowStoreQueryOnce({
              repoRoot: input.repoRoot,
              operation,
              queryName: WorkflowStoreOperation.make("wf_messages_by_keys"),
              params: { messageKeys: [reqId] },
              expectMutation: false,
              client: input.client,
              hostIo: input.hostIo,
              env: input.env,
            })
            const msg = readRes.rows[0]
            if (msg === undefined) {
              return
            }
            const currentLastReplyId =
              typeof msg.lastReplyId === "string" ? msg.lastReplyId : undefined
            if (currentLastReplyId !== expectedReplyId) {
              return
            }

            // Commit 1: delete WithExit replies only (never Interrupt envelopes in CAS mode).
            yield* invokeWorkflowStoreQueryOnce({
              repoRoot: input.repoRoot,
              operation,
              queryName: WorkflowStoreOperation.make("wf_clear_replies_cas_delete"),
              params: { requestId: reqId },
              expectMutation: true,
              ifGraphCommit: readRes.graphCommitId ?? undefined,
              client: input.client,
              hostIo: input.hostIo,
              env: input.env,
            })

            // Commit 2: guarded CAS reset across requestId + lastReplyId; compensate once on failure.
            yield* invokeWorkflowStoreQueryOnce({
              repoRoot: input.repoRoot,
              operation,
              queryName: WorkflowStoreOperation.make("wf_reset_message_for_clear_cas"),
              params: {
                requestId: reqId,
                expectedReplyId,
                clearReplyId: null,
                clearReadMs: null,
              },
              expectMutation: true,
              client: input.client,
              hostIo: input.hostIo,
              env: input.env,
            }).pipe(Effect.tapError(() => compensateDanglingOnce()))
            return
          }

          // Unconditional mode: Commit 1 deletes WithExit replies and Interrupt envelopes.
          yield* invokeWorkflowStoreQueryOnce({
            repoRoot: input.repoRoot,
            operation,
            queryName: WorkflowStoreOperation.make("wf_clear_replies_unconditional_delete"),
            params: { requestId: reqId },
            expectMutation: true,
            client: input.client,
            hostIo: input.hostIo,
            env: input.env,
          })

          // Commit 2: unconditional reset; compensate once on failure.
          yield* invokeWorkflowStoreQueryOnce({
            repoRoot: input.repoRoot,
            operation,
            queryName: WorkflowStoreOperation.make("wf_reset_message_for_clear"),
            params: {
              requestId: reqId,
              clearReplyId: null,
              clearReadMs: null,
            },
            expectMutation: true,
            client: input.client,
            hostIo: input.hostIo,
            env: input.env,
          }).pipe(Effect.tapError(() => compensateDanglingOnce()))
        }),
      ),
  })
}

/**
 * Performs `D2` two-commit `$expectedReplyId` CAS reply clearing while holding
 * `writeMutex` across both commits, compensating intra-process Commit-2 failures
 * via a single unretried `wf_repair_dangling_requests` call.
 */
export const clearOmnigraphReplies = Effect.fn("OmnigraphMessageStorage.clearReplies")(function* (
  input: OmnigraphClearRepliesInput,
): Effect.fn.Return<void, ClusterError.PersistenceError | WorkflowStoreUnavailableError> {
  const writeMutex = input.writeMutex ?? (yield* Semaphore.make(1))
  return yield* executeClearRepliesCore({
    repoRoot: input.repoRoot,
    requestId: input.requestId,
    expectedReplyId: input.expectedReplyId,
    client: input.client,
    hostIo: input.hostIo,
    env: input.env,
    writeMutex,
  })
})

/**
 * Scans `harness-workflows` for `WfMessage(processed = true, kind = "request")` rows
 * lacking a corresponding `WfReply(kind = "with_exit")` and repairs them (and any
 * co-located `interrupt` rows sharing `requestId`) back to `processed = false`.
 */
export const repairDanglingProcessedRequests = Effect.fn("OmnigraphMessageStorage.repairDangling")(
  function* (
    input: RepairDanglingRequestsInput,
  ): Effect.fn.Return<number, WorkflowStoreUnavailableError> {
    const writeMutex = input.writeMutex ?? (yield* Semaphore.make(1))
    const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.repairDangling")

    return yield* retryWorkflowStoreAttempt({
      operation,
      retryConflicts: true,
      runAttempt: () =>
        writeMutex.withPermit(
          Effect.gen(function* () {
            const danglingRes = yield* invokeWorkflowStoreQueryOnce({
              repoRoot: input.repoRoot,
              operation,
              queryName: WorkflowStoreOperation.make("wf_dangling_processed_requests"),
              params: {},
              expectMutation: false,
              client: input.client,
              hostIo: input.hostIo,
              env: input.env,
            })

            if (danglingRes.rows.length === 0) {
              return 0
            }

            const idList = collectDanglingRequestIds(danglingRes.rows)
            if (idList.length === 0) {
              return 0
            }

            yield* invokeWorkflowStoreQueryOnce({
              repoRoot: input.repoRoot,
              operation,
              queryName: WorkflowStoreOperation.make("wf_repair_dangling_requests"),
              params: {
                messageKeys: idList,
                clearReplyId: null,
                clearReadMs: null,
              },
              expectMutation: true,
              ifGraphCommit: danglingRes.graphCommitId ?? undefined,
              client: input.client,
              hostIo: input.hostIo,
              env: input.env,
            })

            return idList.length
          }),
        ),
    })
  },
)

export { executeClearRepliesCore }
