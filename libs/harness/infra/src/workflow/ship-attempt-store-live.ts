import { Effect, Layer, Result, Schema } from "effect"
import {
  AbsoluteRepoRoot,
  type AllocateShipAttemptInput,
  ShipAttempt,
  type ShipAttemptKeyParts,
  type UpdateShipAttemptStatusInput,
  type WorkflowRunId,
  WorkflowShipAttemptRecord,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  WriterLeaseHeldError,
  decodeShipAttemptKey,
  encodeShipAttemptKey,
  toBoundedReason,
} from "@harness/contract"
import {
  isOmnigraphPreconditionOrConflictError,
  isOmnigraphTooManyRequestsError,
} from "@harness/graph"
import { ShipAttemptStore, type ShipAttemptStoreShape } from "@harness/service"
import {
  type WorkflowStoreAttemptFailure,
  computeWorkflowRetryDelayMs,
  invokeWorkflowStoreQueryOnce,
  invokeWorkflowStoreQueryWithMeta,
  parseFiniteNumberOrString,
  toWorkflowStoreUnavailableError,
} from "../omnigraph-workflow-store.js"
import {
  type WorkflowReadModelOptions,
  makeStoreTarget,
  preserveStoreOrLeaseError,
  unwrapOption,
  verifyReadModelLeaseFence,
} from "./read-model-rebuild.js"

/** Options for constructing `ShipAttemptStoreLive`. */
export type ShipAttemptStoreOptions = WorkflowReadModelOptions

const MAX_ALLOCATE_CAS_RETRIES = 16

const ALLOCATE_OPERATION = WorkflowStoreOperation.make("ShipAttemptStore.allocateAttempt")
const UPDATE_OPERATION = WorkflowStoreOperation.make("ShipAttemptStore.updateStatus")
const LIST_OPERATION = WorkflowStoreOperation.make("ShipAttemptStore.listAttemptsForRun")

const resolvePortRepoRoot = (
  operation: WorkflowStoreOperation,
  options?: ShipAttemptStoreOptions,
): Effect.Effect<AbsoluteRepoRoot, WorkflowStoreUnavailableError> => {
  if (options?.repoRoot !== undefined) {
    return Effect.succeed(options.repoRoot)
  }
  const cwdCandidate = unwrapOption(Schema.decodeOption(AbsoluteRepoRoot)(process.cwd()))
  if (cwdCandidate !== undefined) {
    return Effect.succeed(cwdCandidate)
  }
  return Effect.fail(
    new WorkflowStoreUnavailableError({
      operation,
      reason: toBoundedReason(
        "Cannot resolve valid AbsoluteRepoRoot from options.repoRoot or process.cwd()",
      ),
    }),
  )
}

const decodeShipAttemptRow = (
  operation: WorkflowStoreOperation,
  row: Readonly<Record<string, unknown>>,
): Effect.Effect<WorkflowShipAttemptRecord, WorkflowStoreUnavailableError> =>
  Schema.decodeUnknownEffect(WorkflowShipAttemptRecord)({
    shipKey: row.shipKey,
    runId: row.runId,
    attempt: parseFiniteNumberOrString(row.attempt),
    treeHash: row.treeHash,
    status: row.status,
    updatedMs: parseFiniteNumberOrString(row.updatedMs),
  }).pipe(
    Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
    Effect.flatMap((decoded) =>
      Result.match(decodeShipAttemptKey(decoded.shipKey), {
        onFailure: (reason) =>
          Effect.fail(toWorkflowStoreUnavailableError(operation, new Error(reason))),
        onSuccess: (parts: ShipAttemptKeyParts) =>
          parts.runId !== decoded.runId || parts.attempt !== decoded.attempt
            ? Effect.fail(
                toWorkflowStoreUnavailableError(
                  operation,
                  new Error(
                    `WfShipAttempt shipKey '${decoded.shipKey}' does not match runId='${decoded.runId}' attempt=${decoded.attempt}`,
                  ),
                ),
              )
            : Effect.succeed(decoded),
      }),
    ),
  )

const decodeShipAttemptRowForCas = (
  operation: WorkflowStoreOperation,
  row: Readonly<Record<string, unknown>>,
): Effect.Effect<WorkflowShipAttemptRecord, WorkflowStoreAttemptFailure> =>
  decodeShipAttemptRow(operation, row).pipe(
    Effect.mapError((cause): WorkflowStoreAttemptFailure => ({
      _tag: "WorkflowStoreAttemptFailure",
      operation,
      cause,
    })),
  )

const withOptionalRunLock = <A, E>(
  runId: WorkflowRunId,
  options: ShipAttemptStoreOptions | undefined,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> => (options?.runLock !== undefined ? options.runLock(runId, effect) : effect)

const handleCasRetryOrFail = <A>(config: {
  readonly operation: WorkflowStoreOperation
  readonly casAttempt: number
  readonly options?: ShipAttemptStoreOptions | undefined
  readonly retry: (
    nextCasAttempt: number,
  ) => Effect.Effect<A, WorkflowStoreUnavailableError | WriterLeaseHeldError>
  readonly failure: WorkflowStoreAttemptFailure
}): Effect.Effect<A, WorkflowStoreUnavailableError | WriterLeaseHeldError> => {
  const { operation, casAttempt, options, retry, failure } = config
  if (failure.cause instanceof WriterLeaseHeldError) {
    return options?.expectedLeaseEpoch !== undefined
      ? Effect.fail(failure.cause)
      : Effect.fail(toWorkflowStoreUnavailableError(operation, failure.cause))
  }
  if (
    casAttempt < MAX_ALLOCATE_CAS_RETRIES &&
    (isOmnigraphPreconditionOrConflictError(failure.cause) ||
      isOmnigraphTooManyRequestsError(failure.cause))
  ) {
    const delayMs = computeWorkflowRetryDelayMs(casAttempt, failure.cause)
    return Effect.sleep(delayMs).pipe(Effect.andThen(retry(casAttempt + 1)))
  }
  return Effect.fail(toWorkflowStoreUnavailableError(operation, failure.cause))
}

/** Allocates a monotonically increasing `WfShipAttempt` row under Omnigraph OCC and lease fencing. */
export const allocateShipAttemptImpl = Effect.fn("ShipAttemptStore.allocateAttempt")(function* (
  input: AllocateShipAttemptInput,
  options?: ShipAttemptStoreOptions,
): Effect.fn.Return<
  WorkflowShipAttemptRecord,
  WorkflowStoreUnavailableError | WriterLeaseHeldError
> {
  return yield* withOptionalRunLock(
    input.runId,
    options,
    Effect.gen(function* () {
      const repoRoot = yield* resolvePortRepoRoot(ALLOCATE_OPERATION, options)
      const target = makeStoreTarget(repoRoot, options)
      yield* verifyReadModelLeaseFence(target, ALLOCATE_OPERATION, options)
      const nowMs = options?.nowMs ?? (() => Date.now())

      const runCasAttempt = (
        casAttempt: number,
      ): Effect.Effect<
        WorkflowShipAttemptRecord,
        WorkflowStoreUnavailableError | WriterLeaseHeldError
      > =>
        Effect.gen(function* () {
          const readRes = yield* invokeWorkflowStoreQueryOnce({
            ...target,
            operation: ALLOCATE_OPERATION,
            queryName: "wf_ship_attempts_for_run",
            params: { runId: input.runId },
            expectMutation: false,
          })

          const existingAttempts = yield* Effect.forEach(readRes.rows, (row) =>
            decodeShipAttemptRowForCas(ALLOCATE_OPERATION, row),
          )
          const maxAttempt = existingAttempts.reduce(
            (highest, record) => Math.max(highest, record.attempt),
            0,
          )
          const nextAttempt = ShipAttempt.make(maxAttempt + 1)
          const shipKey = encodeShipAttemptKey(input.runId, nextAttempt)
          const updatedMs = WorkflowTimestampMs.make(Math.max(0, Math.floor(nowMs())))

          yield* invokeWorkflowStoreQueryOnce({
            ...target,
            operation: ALLOCATE_OPERATION,
            queryName: "wf_insert_ship_attempt",
            params: {
              shipKey,
              runId: input.runId,
              attempt: nextAttempt,
              treeHash: input.treeHash,
              status: "running",
              updatedMs,
            },
            expectMutation: true,
            ...(readRes.graphCommitId !== null ? { ifGraphCommit: readRes.graphCommitId } : {}),
          })

          return {
            shipKey,
            runId: input.runId,
            attempt: nextAttempt,
            treeHash: input.treeHash,
            status: "running",
            updatedMs,
          } satisfies WorkflowShipAttemptRecord
        }).pipe(
          Effect.catch((failure) =>
            handleCasRetryOrFail({
              operation: ALLOCATE_OPERATION,
              casAttempt,
              options,
              retry: runCasAttempt,
              failure,
            }),
          ),
        )

      return yield* runCasAttempt(0)
    }),
  )
})

/** Updates an allocated `WfShipAttempt` row (`running -> passed | failed`) under lease fencing. */
export const updateShipAttemptStatusImpl = Effect.fn("ShipAttemptStore.updateStatus")(function* (
  input: UpdateShipAttemptStatusInput,
  options?: ShipAttemptStoreOptions,
): Effect.fn.Return<
  WorkflowShipAttemptRecord,
  WorkflowStoreUnavailableError | WriterLeaseHeldError
> {
  return yield* withOptionalRunLock(
    input.runId,
    options,
    Effect.gen(function* () {
      const repoRoot = yield* resolvePortRepoRoot(UPDATE_OPERATION, options)
      const target = makeStoreTarget(repoRoot, options)
      yield* verifyReadModelLeaseFence(target, UPDATE_OPERATION, options)
      const shipKey = encodeShipAttemptKey(input.runId, input.attempt)
      const nowMs = options?.nowMs ?? (() => Date.now())

      const runCasAttempt = (
        casAttempt: number,
      ): Effect.Effect<
        WorkflowShipAttemptRecord,
        WorkflowStoreUnavailableError | WriterLeaseHeldError
      > =>
        Effect.gen(function* () {
          const readRes = yield* invokeWorkflowStoreQueryOnce({
            ...target,
            operation: UPDATE_OPERATION,
            queryName: "wf_get_ship_attempt",
            params: { shipKey },
            expectMutation: false,
          })

          const firstRow = readRes.rows[0]
          if (firstRow === undefined) {
            return yield* Effect.fail<WorkflowStoreAttemptFailure>({
              _tag: "WorkflowStoreAttemptFailure",
              operation: UPDATE_OPERATION,
              cause: new WorkflowStoreUnavailableError({
                operation: UPDATE_OPERATION,
                reason: toBoundedReason(`WfShipAttempt '${shipKey}' does not exist`),
              }),
            })
          }

          const current = yield* decodeShipAttemptRowForCas(UPDATE_OPERATION, firstRow)
          const updatedMs = WorkflowTimestampMs.make(Math.max(0, Math.floor(nowMs())))

          yield* invokeWorkflowStoreQueryOnce({
            ...target,
            operation: UPDATE_OPERATION,
            queryName: "wf_update_ship_attempt",
            params: {
              shipKey,
              status: input.status,
              updatedMs,
            },
            expectMutation: true,
            ...(readRes.graphCommitId !== null ? { ifGraphCommit: readRes.graphCommitId } : {}),
          })

          return {
            ...current,
            status: input.status,
            updatedMs,
          } satisfies WorkflowShipAttemptRecord
        }).pipe(
          Effect.catch((failure) =>
            handleCasRetryOrFail({
              operation: UPDATE_OPERATION,
              casAttempt,
              options,
              retry: runCasAttempt,
              failure,
            }),
          ),
        )

      return yield* runCasAttempt(0)
    }),
  )
})

/** Lists persisted `WfShipAttempt` records for a run sorted by monotonic `attempt`. */
export const listShipAttemptsForRunImpl = Effect.fn("ShipAttemptStore.listAttemptsForRun")(
  function* (
    runId: WorkflowRunId,
    options?: ShipAttemptStoreOptions,
  ): Effect.fn.Return<
    ReadonlyArray<WorkflowShipAttemptRecord>,
    WorkflowStoreUnavailableError | WriterLeaseHeldError
  > {
    const effect = Effect.gen(function* () {
      const repoRoot = yield* resolvePortRepoRoot(LIST_OPERATION, options)
      const target = makeStoreTarget(repoRoot, options)
      yield* verifyReadModelLeaseFence(target, LIST_OPERATION, options)

      const res = yield* invokeWorkflowStoreQueryWithMeta({
        ...target,
        operation: LIST_OPERATION,
        queryName: "wf_ship_attempts_for_run",
        params: { runId },
        expectMutation: false,
      }).pipe(Effect.mapError((err) => preserveStoreOrLeaseError(LIST_OPERATION, err)))

      const decoded = yield* Effect.forEach(res.rows, (row) =>
        decodeShipAttemptRow(LIST_OPERATION, row),
      )
      return [...decoded].sort((a, b) => a.attempt - b.attempt)
    })
    return yield* options?.readGate !== undefined ? options.readGate(effect) : effect
  },
)

/** Constructs a fenced Omnigraph-backed `ShipAttemptStore` layer. */
const makeShipAttemptStoreLayer = (
  options?: ShipAttemptStoreOptions,
): Layer.Layer<ShipAttemptStore> =>
  Layer.succeed(ShipAttemptStore, {
    allocateAttempt: (input) => allocateShipAttemptImpl(input, options),
    updateStatus: (input) => updateShipAttemptStatusImpl(input, options),
    listAttemptsForRun: (runId) => listShipAttemptsForRunImpl(runId, options),
  } satisfies ShipAttemptStoreShape)

export { makeShipAttemptStoreLayer }

/** Default Omnigraph-backed `ShipAttemptStore` layer. */
export const ShipAttemptStoreLive: Layer.Layer<ShipAttemptStore> = makeShipAttemptStoreLayer()
