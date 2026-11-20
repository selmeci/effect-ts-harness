import { Effect, Schema, Semaphore } from "effect"
import type { ClusterError, Snowflake } from "effect/cluster"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type LeaseEpoch,
  type LeaseFilePath,
  type SeqKey,
  toErrorReasonMessage,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  invokeWorkflowStoreQueryOnce,
  retryWorkflowStoreAttempt,
  toWorkflowStoreUnavailableError,
  type WorkflowStoreAttemptFailure,
} from "../omnigraph-workflow-store.js"
import {
  assertAffectedNodes,
  collectDanglingRequestIds,
  decodeMessageKeyAsAttemptFailure,
  decodeReplyKeyAsAttemptFailure,
  WfMessageClearStateRowSchema,
} from "./message-storage-codec.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

const decodeClearStateRowOption = Schema.decodeUnknownOption(WfMessageClearStateRowSchema)

export interface OmnigraphClearRepliesInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly requestId: Snowflake.Snowflake
  readonly expectedReplyId?: Snowflake.Snowflake | undefined
  readonly seqKey?: SeqKey | undefined
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly writeMutex?: Semaphore.Semaphore | undefined
  readonly expectedLeaseEpoch?: LeaseEpoch | undefined
  readonly expectedLeaseOwner?: string | undefined
  readonly lockFilePath?: LeaseFilePath | undefined
}

export interface ClearRepliesCoreInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly requestId: Snowflake.Snowflake
  readonly expectedReplyId?: Snowflake.Snowflake | undefined
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly writeMutex: Semaphore.Semaphore
  readonly expectedLeaseEpoch?: LeaseEpoch | undefined
  readonly expectedLeaseOwner?: string | undefined
  readonly lockFilePath?: LeaseFilePath | undefined
}

export interface RepairDanglingRequestsInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly writeMutex?: Semaphore.Semaphore | undefined
  readonly expectedLeaseEpoch?: LeaseEpoch | undefined
  readonly expectedLeaseOwner?: string | undefined
  readonly lockFilePath?: LeaseFilePath | undefined
}

const mapUnfencedLeaseError = (
  operation: WorkflowStoreOperation,
  expectedLeaseEpoch: LeaseEpoch | undefined,
  err: WorkflowStoreUnavailableError | WriterLeaseHeldError,
): WorkflowStoreUnavailableError | WriterLeaseHeldError =>
  expectedLeaseEpoch === undefined && err instanceof WriterLeaseHeldError
    ? toWorkflowStoreUnavailableError(operation, err)
    : err

const executeClearRepliesCore = (
  input: ClearRepliesCoreInput,
): Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError> => {
  const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.clearReplies")

  const compensateDanglingOnce = (
    reqId: ReturnType<typeof decodeMessageKeyAsAttemptFailure> extends Effect.Effect<
      infer A,
      infer _
    >
      ? A
      : never,
    commit2Err: WorkflowStoreAttemptFailure,
  ): Effect.Effect<never, WorkflowStoreAttemptFailure> =>
    invokeWorkflowStoreQueryOnce({
      repoRoot: input.repoRoot,
      operation: WorkflowStoreOperation.make("OmnigraphMessageStorage.clearReplies.compensate"),
      queryName: "wf_repair_dangling_requests",
      params: {
        messageKeys: [reqId],
        clearReplyId: null,
        clearReadMs: null,
      },
      expectMutation: true,
      expectedLeaseEpoch: input.expectedLeaseEpoch,
      expectedLeaseOwner: input.expectedLeaseOwner,
      lockFilePath: input.lockFilePath,
      client: input.client,
      hostIo: input.hostIo,
      env: input.env,
    }).pipe(
      Effect.flatMap(() => Effect.fail(commit2Err)),
      Effect.catch((compErr) => {
        if (commit2Err.cause instanceof WriterLeaseHeldError) {
          return Effect.fail(commit2Err)
        }
        if (compErr.cause instanceof WriterLeaseHeldError) {
          return Effect.fail(compErr)
        }
        const commit2Msg = toErrorReasonMessage(commit2Err.cause, "Commit-2 reset failed")
        const compMsg = toErrorReasonMessage(compErr.cause, "Commit-2 compensation failed")
        return Effect.fail<WorkflowStoreAttemptFailure>({
          _tag: "WorkflowStoreAttemptFailure",
          operation,
          cause: new Error(
            `Commit-2 failed (${commit2Msg}); compensation also failed (${compMsg})`,
          ),
        })
      }),
    )

  return retryWorkflowStoreAttempt({
    operation,
    retryConflicts: true,
    runAttempt: () =>
      input.writeMutex.withPermit(
        Effect.gen(function* () {
          const reqId = yield* decodeMessageKeyAsAttemptFailure(operation, String(input.requestId))
          const expectedReplyId =
            input.expectedReplyId !== undefined
              ? yield* decodeReplyKeyAsAttemptFailure(operation, String(input.expectedReplyId))
              : undefined

          if (expectedReplyId !== undefined) {
            const readRes = yield* invokeWorkflowStoreQueryOnce({
              repoRoot: input.repoRoot,
              operation,
              queryName: "wf_messages_by_keys",
              params: { messageKeys: [reqId] },
              expectMutation: false,
              client: input.client,
              hostIo: input.hostIo,
              env: input.env,
            })
            const rawMsg = readRes.rows[0]
            if (rawMsg === undefined) {
              return
            }
            const msg = yield* match(decodeClearStateRowOption(rawMsg))
              .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
              .with({ _tag: "None" }, () =>
                Effect.fail<WorkflowStoreAttemptFailure>({
                  _tag: "WorkflowStoreAttemptFailure",
                  operation,
                  cause: new Error(`Corrupt WfMessage row returned during clearReplies(${reqId})`),
                }),
              )
              .exhaustive()
            if ((msg.lastReplyId ?? undefined) !== expectedReplyId) {
              return
            }

            // Commit 1: delete WithExit replies only (never Interrupt envelopes in CAS mode).
            yield* invokeWorkflowStoreQueryOnce({
              repoRoot: input.repoRoot,
              operation,
              queryName: "wf_clear_replies_cas_delete",
              params: { requestId: reqId },
              expectMutation: true,
              ifGraphCommit: readRes.graphCommitId ?? undefined,
              expectedLeaseEpoch: input.expectedLeaseEpoch,
              expectedLeaseOwner: input.expectedLeaseOwner,
              lockFilePath: input.lockFilePath,
              client: input.client,
              hostIo: input.hostIo,
              env: input.env,
            })

            // Commit 2: guarded CAS reset across requestId + lastReplyId; compensate once on failure.
            yield* invokeWorkflowStoreQueryOnce({
              repoRoot: input.repoRoot,
              operation,
              queryName: "wf_reset_message_for_clear_cas",
              params: {
                requestId: reqId,
                expectedReplyId,
                clearReplyId: null,
                clearReadMs: null,
              },
              expectMutation: true,
              expectedLeaseEpoch: input.expectedLeaseEpoch,
              expectedLeaseOwner: input.expectedLeaseOwner,
              lockFilePath: input.lockFilePath,
              client: input.client,
              hostIo: input.hostIo,
              env: input.env,
            }).pipe(
              Effect.flatMap((resetRes) =>
                assertAffectedNodes(
                  operation,
                  "wf_reset_message_for_clear_cas",
                  resetRes.affectedNodes,
                  { kind: "min", count: 1 },
                ),
              ),
              Effect.catch((commit2Err) => compensateDanglingOnce(reqId, commit2Err)),
            )
            return
          }

          // Unconditional mode: Commit 1 deletes WithExit replies and Interrupt envelopes.
          yield* invokeWorkflowStoreQueryOnce({
            repoRoot: input.repoRoot,
            operation,
            queryName: "wf_clear_replies_unconditional_delete",
            params: { requestId: reqId },
            expectMutation: true,
            expectedLeaseEpoch: input.expectedLeaseEpoch,
            expectedLeaseOwner: input.expectedLeaseOwner,
            lockFilePath: input.lockFilePath,
            client: input.client,
            hostIo: input.hostIo,
            env: input.env,
          })

          // Commit 2: unconditional reset; compensate once on failure.
          yield* invokeWorkflowStoreQueryOnce({
            repoRoot: input.repoRoot,
            operation,
            queryName: "wf_reset_message_for_clear",
            params: {
              requestId: reqId,
              clearReplyId: null,
              clearReadMs: null,
            },
            expectMutation: true,
            expectedLeaseEpoch: input.expectedLeaseEpoch,
            expectedLeaseOwner: input.expectedLeaseOwner,
            lockFilePath: input.lockFilePath,
            client: input.client,
            hostIo: input.hostIo,
            env: input.env,
          }).pipe(
            Effect.flatMap((resetRes) =>
              assertAffectedNodes(operation, "wf_reset_message_for_clear", resetRes.affectedNodes, {
                kind: "min",
                count: 1,
              }),
            ),
            Effect.catch((commit2Err) => compensateDanglingOnce(reqId, commit2Err)),
          )
        }),
      ),
  })
}

/**
 * Performs `D2` two-commit `$expectedReplyId` CAS reply clearing while holding
 * `writeMutex` across both commits, compensating intra-process Commit-2 failures
 * via a single unretried `wf_repair_dangling_requests` call and propagating dual
 * Commit-2 + compensation failures explicitly.
 */
export const clearOmnigraphReplies = Effect.fn("OmnigraphMessageStorage.clearReplies")(function* (
  input: OmnigraphClearRepliesInput,
): Effect.fn.Return<
  void,
  ClusterError.PersistenceError | WorkflowStoreUnavailableError | WriterLeaseHeldError
> {
  const operation = WorkflowStoreOperation.make("OmnigraphMessageStorage.clearReplies")
  const writeMutex = input.writeMutex ?? (yield* Semaphore.make(1))
  return yield* executeClearRepliesCore({
    repoRoot: input.repoRoot,
    requestId: input.requestId,
    expectedReplyId: input.expectedReplyId,
    client: input.client,
    hostIo: input.hostIo,
    env: input.env,
    writeMutex,
    expectedLeaseEpoch: input.expectedLeaseEpoch,
    expectedLeaseOwner: input.expectedLeaseOwner,
    lockFilePath: input.lockFilePath,
  }).pipe(Effect.mapError((err) => mapUnfencedLeaseError(operation, input.expectedLeaseEpoch, err)))
})

/**
 * Scans `harness-workflows` for `WfMessage(processed = true, kind = "request")` rows
 * lacking a corresponding `WfReply(kind = "with_exit")` and repairs them (and any
 * co-located `interrupt` rows sharing `requestId`) back to `processed = false`.
 */
export const repairDanglingProcessedRequests = Effect.fn("OmnigraphMessageStorage.repairDangling")(
  function* (
    input: RepairDanglingRequestsInput,
  ): Effect.fn.Return<number, WorkflowStoreUnavailableError | WriterLeaseHeldError> {
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
              queryName: "wf_dangling_processed_requests",
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

            const repairRes = yield* invokeWorkflowStoreQueryOnce({
              repoRoot: input.repoRoot,
              operation,
              queryName: "wf_repair_dangling_requests",
              params: {
                messageKeys: idList,
                clearReplyId: null,
                clearReadMs: null,
              },
              expectMutation: true,
              ifGraphCommit: danglingRes.graphCommitId ?? undefined,
              expectedLeaseEpoch: input.expectedLeaseEpoch,
              expectedLeaseOwner: input.expectedLeaseOwner,
              lockFilePath: input.lockFilePath,
              client: input.client,
              hostIo: input.hostIo,
              env: input.env,
            })
            yield* assertAffectedNodes(
              operation,
              "wf_repair_dangling_requests",
              repairRes.affectedNodes,
              { kind: "min", count: 1 },
            )

            return idList.length
          }),
        ),
    }).pipe(
      Effect.mapError((err) => mapUnfencedLeaseError(operation, input.expectedLeaseEpoch, err)),
    )
  },
)

export { executeClearRepliesCore }
