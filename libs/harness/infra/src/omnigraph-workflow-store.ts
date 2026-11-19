import { Effect, Result, Schema, Semaphore } from "effect"
import { match, P } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  encodeSeqKey,
  ErrorReasonMessage,
  toErrorReasonMessage,
  WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
} from "@harness/contract"
import {
  isOmnigraphPreconditionOrConflictError,
  isOmnigraphTooManyRequestsError,
  makeWorkflowOmnigraphClient,
  type OmnigraphClient,
} from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

/** Hard process-wide cap keeping Omnigraph actor HTTP concurrency below the 16-request limit. */
export const WORKFLOW_MAX_CONCURRENT_HTTP = 12

/** Maximum exponential jittered OCC (`412`/`409`) and `429` retries per workflow store operation. */
export const WORKFLOW_MAX_OCC_RETRIES = 48

/** Per-HTTP request timeout (ms) enforced via `AbortSignal.timeout` on GQ store calls. */
export const WORKFLOW_HTTP_TIMEOUT_MS = 15_000

/** Default active entity types registered by `ClusterWorkflowEngine` in `harness-workflows`. */
export const DEFAULT_KNOWN_WORKFLOW_ENTITY_TYPES: ReadonlyArray<string> = [
  "Workflow/HarnessTaskWorkflow",
  "Workflow/ShipWorkflow",
  "Workflow/-/DurableClock",
]

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

export interface WorkflowStoreQueryInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly operation: WorkflowStoreOperation
  readonly queryName: WorkflowStoreOperation
  readonly params: Readonly<Record<string, unknown>>
  readonly client?: Omnigraph | undefined
  readonly ifGraphCommit?: string | undefined
  readonly branch?: string | undefined
  readonly expectMutation?: boolean | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly maxOccRetries?: number | undefined
}

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

export interface WorkflowStoreAttemptFailure {
  readonly _tag: "WorkflowStoreAttemptFailure"
  readonly operation: WorkflowStoreOperation
  readonly cause: unknown
}

const toWorkflowStoreFailureReason = (
  cause: unknown,
  fallback = "Workflow store request failed",
): WorkflowStoreFailureReason => {
  const raw = toErrorReasonMessage(cause, fallback).trim()
  const nonEmpty = raw.length > 0 ? raw : fallback
  const bounded = nonEmpty.length > 1024 ? `${nonEmpty.slice(0, 1021)}...` : nonEmpty
  return WorkflowStoreFailureReason.make(bounded.trim())
}

const toWorkflowStoreUnavailableError = (
  operation: WorkflowStoreOperation,
  cause: unknown,
): WorkflowStoreUnavailableError => {
  if (cause instanceof WorkflowStoreUnavailableError) {
    return cause
  }
  return new WorkflowStoreUnavailableError({
    operation,
    reason: toWorkflowStoreFailureReason(cause),
  })
}

const isRetryableWorkflowStoreCause = (
  cause: unknown,
  retryConflictAndPrecondition: boolean,
): boolean =>
  isOmnigraphTooManyRequestsError(cause) ||
  (retryConflictAndPrecondition && isOmnigraphPreconditionOrConflictError(cause))

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

const extractInvokeQueryResult = (raw: unknown): WorkflowStoreQueryWithMetaResult => {
  const rowsOpt = decodeRowsEnvelopeOption(raw)
  return match(rowsOpt)
    .with({ _tag: "Some" }, ({ value }) => ({
      rows: value.rows,
      graphCommitId: value.graphCommitId ?? null,
      affectedNodes: 0,
      affectedEdges: 0,
    }))
    .with({ _tag: "None" }, () =>
      match(decodeMutationEnvelopeOption(raw))
        .with({ _tag: "Some" }, ({ value }) => ({
          rows: [] as ReadonlyArray<Readonly<Record<string, unknown>>>,
          graphCommitId: value.commit?.graphCommitId ?? null,
          affectedNodes: value.affectedNodes,
          affectedEdges: value.affectedEdges,
        }))
        .with({ _tag: "None" }, () => ({
          rows: [] as ReadonlyArray<Readonly<Record<string, unknown>>>,
          graphCommitId: null,
          affectedNodes: 0,
          affectedEdges: 0,
        }))
        .exhaustive(),
    )
    .exhaustive()
}

/**
 * Executes a single HTTP attempt of a named GQ 2.1 query/mutation under the shared
 * HTTP semaphore, preserving the raw failure cause for outer retry/CAS loops.
 */
const invokeWorkflowStoreQueryOnce = (
  input: WorkflowStoreQueryInput,
): Effect.Effect<WorkflowStoreQueryWithMetaResult, WorkflowStoreAttemptFailure> =>
  withWorkflowHttpPermit(
    Effect.tryPromise({
      try: (fiberSignal) => {
        const og = resolveWorkflowClientForStore({
          repoRoot: input.repoRoot,
          client: input.client,
          hostIo: input.hostIo,
          env: input.env,
        })
        const hasParams = Object.keys(input.params).length > 0
        const signal = AbortSignal.any([fiberSignal, AbortSignal.timeout(WORKFLOW_HTTP_TIMEOUT_MS)])
        return og.queries.invoke(
          input.queryName,
          {
            branch: input.branch ?? "main",
            ...(input.expectMutation !== undefined ? { expectMutation: input.expectMutation } : {}),
            ...(hasParams ? { params: input.params } : {}),
          },
          {
            signal,
            ...(input.ifGraphCommit !== undefined ? { ifGraphCommit: input.ifGraphCommit } : {}),
          },
        )
      },
      catch: (cause): WorkflowStoreAttemptFailure => ({
        _tag: "WorkflowStoreAttemptFailure",
        operation: input.operation,
        cause,
      }),
    }).pipe(Effect.map(extractInvokeQueryResult)),
  )

/**
 * Retries a store operation with bounded exponential jittered backoff on `429` and
 * (when `retryConflicts` is enabled) `412`/`409` OCC conflicts. Never holds an HTTP
 * semaphore permit or caller mutex during backoff sleep.
 */
const retryWorkflowStoreAttempt = <A>(options: {
  readonly operation: WorkflowStoreOperation
  readonly maxRetries?: number | undefined
  readonly retryConflicts?: boolean | undefined
  readonly runAttempt: () => Effect.Effect<A, WorkflowStoreAttemptFailure>
}): Effect.Effect<A, WorkflowStoreUnavailableError> => {
  const maxRetries = Math.max(0, options.maxRetries ?? WORKFLOW_MAX_OCC_RETRIES)
  const retryConflicts = options.retryConflicts ?? true

  const loop = (attempt: number): Effect.Effect<A, WorkflowStoreUnavailableError> =>
    options.runAttempt().pipe(
      Effect.catch((failure) => {
        if (attempt < maxRetries && isRetryableWorkflowStoreCause(failure.cause, retryConflicts)) {
          const delayMs = computeWorkflowRetryDelayMs(attempt, failure.cause)
          return Effect.sleep(delayMs).pipe(Effect.andThen(loop(attempt + 1)))
        }
        return Effect.fail(toWorkflowStoreUnavailableError(options.operation, failure.cause))
      }),
    )

  return loop(0)
}

/**
 * Executes a named GQ 2.1 query or mutation against `harness-workflows` and returns
 * rows alongside `graphCommitId` and mutation `affectedNodes` / `affectedEdges`.
 */
export const invokeWorkflowStoreQueryWithMeta = Effect.fn("WorkflowStore.invokeWithMeta")(
  function* (
    input: WorkflowStoreQueryInput,
  ): Effect.fn.Return<WorkflowStoreQueryWithMetaResult, WorkflowStoreUnavailableError> {
    return yield* retryWorkflowStoreAttempt({
      operation: input.operation,
      maxRetries: input.maxOccRetries,
      retryConflicts: input.ifGraphCommit === undefined,
      runAttempt: () => invokeWorkflowStoreQueryOnce(input),
    })
  },
)

/**
 * Executes a named GQ 2.1 query or mutation against the `harness-workflows` graph
 * through the shared process-wide HTTP semaphore (`WORKFLOW_MAX_CONCURRENT_HTTP`)
 * with bounded `429`/`412` retries and `WorkflowStoreUnavailableError` mapping.
 */
export const invokeWorkflowStoreQuery = Effect.fn("WorkflowStore.invoke")(function* (
  input: WorkflowStoreQueryInput,
): Effect.fn.Return<
  ReadonlyArray<Readonly<Record<string, unknown>>>,
  WorkflowStoreUnavailableError
> {
  const res = yield* retryWorkflowStoreAttempt({
    operation: input.operation,
    maxRetries: input.maxOccRetries,
    retryConflicts: input.ifGraphCommit === undefined,
    runAttempt: () => invokeWorkflowStoreQueryOnce(input),
  })
  return res.rows
})

/**
 * Safely decodes a JSON string against an Effect `Schema` without throwing,
 * returning a `Result` so individual corrupt storage rows can be isolated and
 * skipped without aborting healthy sibling rows.
 */
const decodeJsonFieldSafely = <
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  raw: string,
  schema: S,
): Result.Result<S["Type"], ErrorReasonMessage> => {
  const jsonSchema = Schema.fromJsonString(schema)
  const res = Schema.decodeResult(jsonSchema)(raw)
  return match(res)
    .with({ _tag: "Success" }, ({ success }) => Result.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(ErrorReasonMessage.make(toErrorReasonMessage(failure, "Invalid JSON field"))),
    )
    .exhaustive()
}

export interface QuarantineOrphanEntityMessagesInput {
  readonly repoRoot: AbsoluteRepoRoot
  readonly knownEntityTypes: ReadonlyArray<string>
  readonly client?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

export interface QuarantineOrphanEntityMessagesResult {
  readonly quarantinedCount: number
  readonly orphanEntityTypes: ReadonlyArray<string>
}

const MAX_ORPHAN_QUARANTINE_BATCHES = 128

const parseFiniteNumberOrString = (raw: unknown): number | undefined =>
  match(raw)
    .with(P.number, (num) => (Number.isFinite(num) ? num : undefined))
    .with(P.string, (str) => {
      const trimmed = str.trim()
      if (trimmed.length === 0) {
        return undefined
      }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? parsed : undefined
    })
    .otherwise(() => undefined)

/**
 * Scans `harness-workflows` for unprocessed `WfMessage` rows whose `entityType` is
 * no longer in `knownEntityTypes` and marks them `processed = true` (with a terminal
 * `WfReply` so `resetShards` dangling-request repair does not un-quarantine them) before
 * `Sharding` begins polling.
 */
export const quarantineOrphanEntityMessages = Effect.fn("WorkflowStore.quarantineOrphans")(
  function* (
    input: QuarantineOrphanEntityMessagesInput,
  ): Effect.fn.Return<QuarantineOrphanEntityMessagesResult, WorkflowStoreUnavailableError> {
    const knownList =
      input.knownEntityTypes.length > 0 ? [...input.knownEntityTypes] : ["__never_empty__"]
    const seenTypes = new Set<string>()
    let quarantinedCount = 0
    let orphanReplyCounter = 0n
    const mintSyntheticOrphanReplyKey = (): string => {
      orphanReplyCounter = (orphanReplyCounter + 1n) % 10000n
      return (BigInt(Date.now()) * 10000n + orphanReplyCounter).toString()
    }

    for (let batch = 0; batch < MAX_ORPHAN_QUARANTINE_BATCHES; batch += 1) {
      const rows = yield* invokeWorkflowStoreQuery({
        repoRoot: input.repoRoot,
        operation: WorkflowStoreOperation.make("WorkflowStore.quarantineOrphans.scan"),
        queryName: WorkflowStoreOperation.make("wf_orphan_entity_messages"),
        params: { knownEntityTypes: knownList },
        expectMutation: false,
        client: input.client,
        hostIo: input.hostIo,
        env: input.env,
      })

      if (rows.length === 0) {
        break
      }

      const messageKeys: Array<string> = []
      const requestIds = new Set<string>()
      for (const row of rows) {
        const key = row.messageKey
        if (typeof key === "string" && key.length > 0) {
          messageKeys.push(key)
        }
        const requestId = row.requestId
        if (typeof requestId === "string" && requestId.length > 0) {
          requestIds.add(requestId)
        }
        const entityType = row.entityType
        if (typeof entityType === "string" && entityType.length > 0) {
          seenTypes.add(entityType)
        }
      }

      if (messageKeys.length === 0) {
        break
      }

      // Save terminal WithExit replies so resetShards dangling-request repair preserves quarantine.
      for (const requestId of requestIds) {
        const replyKey = mintSyntheticOrphanReplyKey()
        const seqKeyRes = encodeSeqKey(replyKey)
        const seqKey = match(seqKeyRes)
          .with({ _tag: "Success" }, ({ success }) => success)
          .with({ _tag: "Failure" }, () => replyKey.padStart(20, "0"))
          .exhaustive()
        yield* invokeWorkflowStoreQuery({
          repoRoot: input.repoRoot,
          operation: WorkflowStoreOperation.make("WorkflowStore.quarantineOrphans.saveExit"),
          queryName: WorkflowStoreOperation.make("wf_save_reply_exit"),
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
          client: input.client,
          hostIo: input.hostIo,
          env: input.env,
        })
      }

      yield* invokeWorkflowStoreQuery({
        repoRoot: input.repoRoot,
        operation: WorkflowStoreOperation.make("WorkflowStore.quarantineOrphans.mark"),
        queryName: WorkflowStoreOperation.make("wf_quarantine_orphan_messages"),
        params: { messageKeys },
        expectMutation: true,
        client: input.client,
        hostIo: input.hostIo,
        env: input.env,
      })

      quarantinedCount += messageKeys.length
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
  parseFiniteNumberOrString,
  resolveWorkflowClientForStore,
  retryWorkflowStoreAttempt,
  toWorkflowStoreFailureReason,
  toWorkflowStoreUnavailableError,
  withWorkflowHttpPermit,
}
