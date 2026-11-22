import { Effect, Schema, Semaphore } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  encodeSeqKey,
  LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  MessageKey,
  toBoundedReason,
  type WorkflowGqParamsMap,
  type WorkflowGqQueryName,
  type WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
} from "@harness/contract"
import {
  isOmnigraphPreconditionOrConflictError,
  isOmnigraphTooManyRequestsError,
  makeWorkflowOmnigraphClient,
  type OmnigraphClient,
} from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"
import {
  decodeJsonFieldSafely,
  makeMintReplyKey,
  parseFiniteNumberOrString,
  toWorkflowStoreUnavailableError,
  type WorkflowStoreAttemptFailure,
} from "./workflow/workflow-store-codec.js"
import { decodeWriterLeaseRow, makeHeldLeaseError } from "./workflow/writer-lease-codec.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

/** Hard process-wide cap keeping Omnigraph actor HTTP concurrency below the 16-request limit. */
export const WORKFLOW_MAX_CONCURRENT_HTTP = 12

/** Maximum exponential jittered OCC (`412`/`409`) and `429` retries per workflow store operation. */
export const WORKFLOW_MAX_OCC_RETRIES = 48

/** Per-HTTP request timeout (ms) enforced via `AbortSignal.timeout` on GQ store calls. */
export const WORKFLOW_HTTP_TIMEOUT_MS = 15_000

const DEFAULT_FENCE_LOCK_PATH = LeaseFilePath.make("/harness/daemon.lock")
const NO_ACTIVE_LEASE_HOLDER = LeaseHolderId.make("no-active-lease")

const LEASE_MANAGEMENT_QUERY_NAMES: ReadonlySet<WorkflowGqQueryName> = new Set([
  "wf_insert_writer_lease",
  "wf_cas_writer_lease",
  "wf_refresh_writer_lease",
])

/**
 * Single process-wide semaphore bounding all HTTP traffic targeting `harness-workflows`
 * below Omnigraph's 16-request per-actor cap.
 */
const workflowHttpSemaphore = Semaphore.makeUnsafe(WORKFLOW_MAX_CONCURRENT_HTTP)

const RowsEnvelopeSchema = Schema.Struct({
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  graphCommitId: Schema.optional(Schema.NullOr(Schema.String)),
})
const decodeRowsEnvelopeOption = Schema.decodeUnknownOption(RowsEnvelopeSchema)

const MutationEnvelopeSchema = Schema.Struct({
  affectedNodes: Schema.Finite,
  affectedEdges: Schema.Finite,
  commit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        graphCommitId: Schema.String,
      }),
    ),
  ),
})
const decodeMutationEnvelopeOption = Schema.decodeUnknownOption(MutationEnvelopeSchema)

const decodeMessageKeyOption = Schema.decodeUnknownOption(MessageKey)

export interface WorkflowStoreQueryInput<Q extends WorkflowGqQueryName = WorkflowGqQueryName> {
  readonly repoRoot: AbsoluteRepoRoot
  readonly operation: WorkflowStoreOperation
  readonly queryName: Q
  readonly params: WorkflowGqParamsMap[Q]
  readonly client?: Omnigraph | undefined
  readonly ifGraphCommit?: string | undefined
  readonly branch?: string | undefined
  readonly expectMutation?: boolean | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly maxOccRetries?: number | undefined
  readonly expectedLeaseEpoch?: LeaseEpoch | undefined
  readonly expectedLeaseOwner?: string | undefined
  readonly lockFilePath?: LeaseFilePath | undefined
}

export type WorkflowStoreInvokeError<TInput> = "expectedLeaseEpoch" extends keyof TInput
  ? TInput["expectedLeaseEpoch"] extends undefined
    ? WorkflowStoreUnavailableError
    : WorkflowStoreUnavailableError | WriterLeaseHeldError
  : WorkflowStoreUnavailableError

export interface WorkflowStoreRetryPolicy {
  readonly maxConcurrentHttp: number
  readonly maxOccRetries: number
  readonly lastFailureReason?: WorkflowStoreFailureReason | undefined
}

export interface WorkflowStoreQueryWithMetaResult {
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly graphCommitId: string | null
  readonly affectedNodes: number
  readonly affectedEdges: number
}

const isRetryableWorkflowStoreCause = (
  cause: unknown,
  retryConflictAndPrecondition: boolean,
): boolean =>
  !(cause instanceof WriterLeaseHeldError) &&
  (isOmnigraphTooManyRequestsError(cause) ||
    (retryConflictAndPrecondition && isOmnigraphPreconditionOrConflictError(cause)))

const computeWorkflowRetryDelayMs = (attempt: number, cause?: unknown): number => {
  if (typeof cause === "object" && cause !== null) {
    const retryAfter = Reflect.get(cause, "retryAfter")
    if (typeof retryAfter === "string") {
      const parsedSeconds = Number(retryAfter.trim())
      if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
        return Math.min(2_000, Math.max(5, Math.ceil(parsedSeconds * 1_000)))
      }
    }
  }
  const expBase = Math.min(250, 5 * Math.pow(1.5, Math.min(attempt, 12)))
  const jitter = 0.5 + Math.random() * 0.5
  return Math.max(2, Math.floor(expBase * jitter))
}

/**
 * Runs an effect while holding one permit on the shared process-wide `WORKFLOW_MAX_CONCURRENT_HTTP`
 * semaphore (`12` max in-flight requests to `harness-workflows`).
 */
const withWorkflowHttpPermit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  workflowHttpSemaphore.withPermit(effect)

const resolveWorkflowClientForStore = (options: {
  readonly repoRoot: AbsoluteRepoRoot
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}): Omnigraph =>
  options.client ??
  makeWorkflowOmnigraphClient({
    repoRoot: options.repoRoot,
    hostIo: options.hostIo ?? nodeSyncHostIo,
    ...(options.env !== undefined ? { env: options.env } : {}),
  })

const extractInvokeQueryResult = (
  raw: unknown,
  operation: WorkflowStoreOperation,
): Effect.Effect<WorkflowStoreQueryWithMetaResult, WorkflowStoreAttemptFailure> =>
  match(decodeRowsEnvelopeOption(raw))
    .with({ _tag: "Some" }, ({ value }) =>
      Effect.succeed<WorkflowStoreQueryWithMetaResult>({
        rows: value.rows,
        graphCommitId: value.graphCommitId ?? null,
        affectedNodes: 0,
        affectedEdges: 0,
      }),
    )
    .with({ _tag: "None" }, () =>
      match(decodeMutationEnvelopeOption(raw))
        .with({ _tag: "Some" }, ({ value }) =>
          Effect.succeed<WorkflowStoreQueryWithMetaResult>({
            rows: [] as ReadonlyArray<Readonly<Record<string, unknown>>>,
            graphCommitId: value.commit?.graphCommitId ?? null,
            affectedNodes: value.affectedNodes,
            affectedEdges: value.affectedEdges,
          }),
        )
        .with({ _tag: "None" }, () =>
          Effect.fail<WorkflowStoreAttemptFailure>({
            _tag: "WorkflowStoreAttemptFailure",
            operation,
            cause: new Error("Omnigraph query response matched neither rows nor mutation envelope"),
          }),
        )
        .exhaustive(),
    )
    .exhaustive()

const invokeRawQueryOnce = (options: {
  readonly og: Omnigraph
  readonly operation: WorkflowStoreOperation
  readonly queryName: WorkflowGqQueryName
  readonly params: Readonly<Record<string, unknown>>
  readonly branch: string
  readonly expectMutation: boolean | undefined
  readonly ifGraphCommit: string | undefined
}): Effect.Effect<WorkflowStoreQueryWithMetaResult, WorkflowStoreAttemptFailure> =>
  withWorkflowHttpPermit(
    Effect.tryPromise({
      try: (fiberSignal) => {
        const hasParams = Object.keys(options.params).length > 0
        const signal = AbortSignal.any([fiberSignal, AbortSignal.timeout(WORKFLOW_HTTP_TIMEOUT_MS)])
        return options.og.queries.invoke(
          options.queryName,
          {
            branch: options.branch,
            ...(options.expectMutation !== undefined
              ? { expectMutation: options.expectMutation }
              : {}),
            ...(hasParams ? { params: options.params } : {}),
          },
          {
            signal,
            ...(options.ifGraphCommit !== undefined
              ? { ifGraphCommit: options.ifGraphCommit }
              : {}),
          },
        )
      },
      catch: (cause): WorkflowStoreAttemptFailure => ({
        _tag: "WorkflowStoreAttemptFailure",
        operation: options.operation,
        cause,
      }),
    }).pipe(Effect.flatMap((raw) => extractInvokeQueryResult(raw, options.operation))),
  )

const checkWriterLeaseFence = <Q extends WorkflowGqQueryName>(
  og: Omnigraph,
  input: WorkflowStoreQueryInput<Q>,
  branch: string,
): Effect.Effect<string | undefined, WorkflowStoreAttemptFailure> =>
  Effect.gen(function* () {
    const expectedEpoch = input.expectedLeaseEpoch
    if (expectedEpoch === undefined) {
      return undefined
    }
    const leaseMeta = yield* invokeRawQueryOnce({
      og,
      operation: input.operation,
      queryName: "wf_get_writer_lease",
      params: { name: "engine" },
      branch,
      expectMutation: false,
      ifGraphCommit: undefined,
    })
    const lockPath = input.lockFilePath ?? DEFAULT_FENCE_LOCK_PATH
    const firstRow = leaseMeta.rows[0]
    if (firstRow === undefined) {
      return yield* Effect.fail<WorkflowStoreAttemptFailure>({
        _tag: "WorkflowStoreAttemptFailure",
        operation: input.operation,
        cause: new WriterLeaseHeldError({
          holderId: NO_ACTIVE_LEASE_HOLDER,
          lockFilePath: lockPath,
        }),
      })
    }
    const decoded = yield* match(decodeWriterLeaseRow(firstRow))
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail<WorkflowStoreAttemptFailure>({
          _tag: "WorkflowStoreAttemptFailure",
          operation: input.operation,
          cause: new Error(failure),
        }),
      )
      .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
      .exhaustive()

    const ownerMismatch =
      input.expectedLeaseOwner !== undefined && decoded.row.owner !== input.expectedLeaseOwner
    if (decoded.row.leaseEpoch !== expectedEpoch || ownerMismatch) {
      return yield* Effect.fail<WorkflowStoreAttemptFailure>({
        _tag: "WorkflowStoreAttemptFailure",
        operation: input.operation,
        cause: makeHeldLeaseError(
          decoded.parsedOwner.holderId,
          decoded.row.leaseEpoch,
          lockPath,
          decoded.parsedOwner.holderPid,
        ),
      })
    }
    return leaseMeta.graphCommitId ?? undefined
  })

/**
 * Executes a single HTTP attempt of a named GQ 2.1 query/mutation under the shared
 * HTTP semaphore, enforcing `expectedLeaseEpoch` fencing on mutations and preserving
 * the raw failure cause for outer retry/CAS loops.
 */
const invokeWorkflowStoreQueryOnce = <Q extends WorkflowGqQueryName>(
  input: WorkflowStoreQueryInput<Q>,
): Effect.Effect<WorkflowStoreQueryWithMetaResult, WorkflowStoreAttemptFailure> =>
  Effect.gen(function* () {
    const og = resolveWorkflowClientForStore({
      repoRoot: input.repoRoot,
      client: input.client,
      hostIo: input.hostIo,
      env: input.env,
    })
    const branch = input.branch ?? "main"
    const shouldFence =
      input.expectedLeaseEpoch !== undefined &&
      input.expectMutation === true &&
      !LEASE_MANAGEMENT_QUERY_NAMES.has(input.queryName)

    const leaseCommitId = shouldFence ? yield* checkWriterLeaseFence(og, input, branch) : undefined
    const effectiveIfGraphCommit = input.ifGraphCommit ?? leaseCommitId

    return yield* invokeRawQueryOnce({
      og,
      operation: input.operation,
      queryName: input.queryName,
      params: input.params as Readonly<Record<string, unknown>>,
      branch,
      expectMutation: input.expectMutation,
      ifGraphCommit: effectiveIfGraphCommit,
    })
  })

/**
 * Retries a store operation with bounded exponential jittered backoff on `429` and
 * (when `retryConflicts` is enabled) `412`/`409` OCC conflicts. Never retries
 * `WriterLeaseHeldError` and never holds an HTTP semaphore permit during backoff sleep.
 */
const retryWorkflowStoreAttempt = <A>(options: {
  readonly operation: WorkflowStoreOperation
  readonly maxRetries?: number | undefined
  readonly retryConflicts?: boolean | undefined
  readonly runAttempt: () => Effect.Effect<A, WorkflowStoreAttemptFailure>
}): Effect.Effect<A, WorkflowStoreUnavailableError | WriterLeaseHeldError> => {
  const maxRetries = Math.max(0, options.maxRetries ?? WORKFLOW_MAX_OCC_RETRIES)
  const retryConflicts = options.retryConflicts ?? true

  const loop = (
    attempt: number,
  ): Effect.Effect<A, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
    options.runAttempt().pipe(
      Effect.catch((failure) => {
        if (failure.cause instanceof WriterLeaseHeldError) {
          return Effect.fail(failure.cause)
        }
        if (attempt < maxRetries && isRetryableWorkflowStoreCause(failure.cause, retryConflicts)) {
          const delayMs = computeWorkflowRetryDelayMs(attempt, failure.cause)
          return Effect.sleep(delayMs).pipe(Effect.andThen(loop(attempt + 1)))
        }
        return Effect.fail(toWorkflowStoreUnavailableError(options.operation, failure.cause))
      }),
    )

  return loop(0)
}

const mapUnfencedLeaseError = (
  operation: WorkflowStoreOperation,
  expectedLeaseEpoch: LeaseEpoch | undefined,
  err: WorkflowStoreUnavailableError | WriterLeaseHeldError,
): WorkflowStoreUnavailableError | WriterLeaseHeldError =>
  expectedLeaseEpoch === undefined && err instanceof WriterLeaseHeldError
    ? toWorkflowStoreUnavailableError(operation, err)
    : err

/**
 * Executes a named GQ 2.1 query or mutation against `harness-workflows` and returns
 * rows alongside `graphCommitId` and mutation `affectedNodes` / `affectedEdges`.
 */
export const invokeWorkflowStoreQueryWithMeta = Effect.fn("WorkflowStore.invokeWithMeta")(
  function* <Q extends WorkflowGqQueryName, const TInput extends WorkflowStoreQueryInput<Q>>(
    input: TInput,
  ): Effect.fn.Return<WorkflowStoreQueryWithMetaResult, WorkflowStoreInvokeError<TInput>> {
    return yield* retryWorkflowStoreAttempt({
      operation: input.operation,
      maxRetries: input.maxOccRetries,
      retryConflicts: input.ifGraphCommit === undefined,
      runAttempt: () => invokeWorkflowStoreQueryOnce(input),
    }).pipe(
      Effect.mapError(
        (err) =>
          mapUnfencedLeaseError(
            input.operation,
            input.expectedLeaseEpoch,
            err,
          ) as WorkflowStoreInvokeError<TInput>,
      ),
    )
  },
)

/**
 * Executes a named GQ 2.1 query or mutation against the `harness-workflows` graph
 * through the shared process-wide HTTP semaphore (`WORKFLOW_MAX_CONCURRENT_HTTP`)
 * with bounded `429`/`412` retries and `WorkflowStoreUnavailableError` / `WriterLeaseHeldError` mapping.
 */
export const invokeWorkflowStoreQuery = Effect.fn("WorkflowStore.invoke")(function* <
  Q extends WorkflowGqQueryName,
  const TInput extends WorkflowStoreQueryInput<Q>,
>(
  input: TInput,
): Effect.fn.Return<
  ReadonlyArray<Readonly<Record<string, unknown>>>,
  WorkflowStoreInvokeError<TInput>
> {
  const res = yield* retryWorkflowStoreAttempt({
    operation: input.operation,
    maxRetries: input.maxOccRetries,
    retryConflicts: input.ifGraphCommit === undefined,
    runAttempt: () => invokeWorkflowStoreQueryOnce(input),
  }).pipe(
    Effect.mapError(
      (err) =>
        mapUnfencedLeaseError(
          input.operation,
          input.expectedLeaseEpoch,
          err,
        ) as WorkflowStoreInvokeError<TInput>,
    ),
  )
  return res.rows
})

export interface QuarantineOrphanEntityMessagesInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly knownEntityTypes: ReadonlyArray<string>
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly expectedLeaseEpoch?: LeaseEpoch | undefined
  readonly lockFilePath?: LeaseFilePath | undefined
}

export interface QuarantineOrphanEntityMessagesResult {
  readonly quarantinedCount: number
  readonly orphanEntityTypes: ReadonlyArray<string>
}

export const MAX_ORPHAN_QUARANTINE_BATCHES = 128

/**
 * Scans `harness-workflows` for unprocessed `WfMessage` rows whose `entityType` is
 * no longer in `knownEntityTypes` and marks them `processed = true` (with a terminal
 * `WfReply` so `resetShards` dangling-request repair does not un-quarantine them) before
 * `Sharding` begins polling. Fails closed on empty `knownEntityTypes` or incomplete
 * quarantine after `MAX_ORPHAN_QUARANTINE_BATCHES` batches.
 */
export const quarantineOrphanEntityMessages = Effect.fn("WorkflowStore.quarantineOrphans")(
  function* (
    input: QuarantineOrphanEntityMessagesInput,
  ): Effect.fn.Return<
    QuarantineOrphanEntityMessagesResult,
    WorkflowStoreUnavailableError | WriterLeaseHeldError
  > {
    const operation = WorkflowStoreOperation.make("WorkflowStore.quarantineOrphans")
    const knownList = input.knownEntityTypes.filter((entry) => entry.trim().length > 0)
    if (knownList.length === 0) {
      return yield* new WorkflowStoreUnavailableError({
        operation,
        reason: toBoundedReason(
          "knownEntityTypes must be non-empty when running orphan entity quarantine",
        ),
      })
    }

    const seenTypes = new Set<string>()
    let quarantinedCount = 0

    let exhaustedBatches = true
    for (let batch = 0; batch < MAX_ORPHAN_QUARANTINE_BATCHES; batch += 1) {
      const rows = yield* invokeWorkflowStoreQuery({
        repoRoot: input.repoRoot,
        operation: WorkflowStoreOperation.make("WorkflowStore.quarantineOrphans.scan"),
        queryName: "wf_orphan_entity_messages",
        params: { knownEntityTypes: knownList },
        expectMutation: false,
        client: input.client,
        hostIo: input.hostIo,
        env: input.env,
      })

      if (rows.length === 0) {
        exhaustedBatches = false
        break
      }

      const messageKeys: Array<MessageKey> = []
      const requestIds = new Set<MessageKey>()
      for (const row of rows) {
        match(decodeMessageKeyOption(row.messageKey))
          .with({ _tag: "Some" }, ({ value }) => {
            messageKeys.push(value)
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
        match(decodeMessageKeyOption(row.requestId))
          .with({ _tag: "Some" }, ({ value }) => {
            requestIds.add(value)
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
        if (typeof row.entityType === "string" && row.entityType.length > 0) {
          seenTypes.add(row.entityType)
        }
      }

      if (messageKeys.length === 0) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            "Orphan entity scan returned rows without valid MessageKey identifiers",
          ),
        })
      }

      // Save terminal WithExit replies so resetShards dangling-request repair preserves quarantine.
      const mintReplyKey = makeMintReplyKey()
      for (const requestId of requestIds) {
        const replyKey = mintReplyKey()
        const seqKey = yield* match(encodeSeqKey(replyKey))
          .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
          .with({ _tag: "Failure" }, ({ failure }) =>
            Effect.fail(
              new WorkflowStoreUnavailableError({
                operation: WorkflowStoreOperation.make("WorkflowStore.quarantineOrphans.saveExit"),
                reason: toBoundedReason(failure),
              }),
            ),
          )
          .exhaustive()
        yield* invokeWorkflowStoreQuery({
          repoRoot: input.repoRoot,
          operation: WorkflowStoreOperation.make("WorkflowStore.quarantineOrphans.saveExit"),
          queryName: "wf_save_reply_exit",
          params: {
            replyKey,
            seqKey,
            requestId,
            payload: JSON.stringify({
              _tag: "Failure",
              cause: [{ _tag: "Die", defect: "Orphan entityType quarantined at startup" }],
            }),
          },
          expectMutation: true,
          expectedLeaseEpoch: input.expectedLeaseEpoch,
          lockFilePath: input.lockFilePath,
          client: input.client,
          hostIo: input.hostIo,
          env: input.env,
        })
      }

      yield* invokeWorkflowStoreQuery({
        repoRoot: input.repoRoot,
        operation: WorkflowStoreOperation.make("WorkflowStore.quarantineOrphans.mark"),
        queryName: "wf_quarantine_orphan_messages",
        params: { messageKeys },
        expectMutation: true,
        expectedLeaseEpoch: input.expectedLeaseEpoch,
        lockFilePath: input.lockFilePath,
        client: input.client,
        hostIo: input.hostIo,
        env: input.env,
      })

      quarantinedCount += messageKeys.length
    }

    if (exhaustedBatches) {
      const remainingRows = yield* invokeWorkflowStoreQuery({
        repoRoot: input.repoRoot,
        operation: WorkflowStoreOperation.make("WorkflowStore.quarantineOrphans.verifyRemaining"),
        queryName: "wf_orphan_entity_messages",
        params: { knownEntityTypes: knownList },
        expectMutation: false,
        client: input.client,
        hostIo: input.hostIo,
        env: input.env,
      })
      if (remainingRows.length > 0) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Orphan entity message quarantine exceeded ${MAX_ORPHAN_QUARANTINE_BATCHES} batches with ${remainingRows.length} remaining orphan rows`,
          ),
        })
      }
    }

    const orphanEntityTypes = Array.from(seenTypes).sort()
    if (quarantinedCount > 0) {
      yield* Effect.logWarning(
        `Quarantined ${quarantinedCount} orphan workflow messages for unregistered entityTypes: ${orphanEntityTypes.join(", ")}`,
      )
    }

    return { quarantinedCount, orphanEntityTypes }
  },
)

export {
  computeWorkflowRetryDelayMs,
  decodeJsonFieldSafely,
  invokeWorkflowStoreQueryOnce,
  isRetryableWorkflowStoreCause,
  makeMintReplyKey,
  parseFiniteNumberOrString,
  resolveWorkflowClientForStore,
  retryWorkflowStoreAttempt,
  toWorkflowStoreUnavailableError,
  withWorkflowHttpPermit,
  type WorkflowStoreAttemptFailure,
}
