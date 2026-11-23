import { Effect, Layer, Option, Schema, Semaphore } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  OwnedRelPath,
  RejectionJsonPayload,
  UnitRejection,
  WorkflowAttemptRecord,
  WorkflowAttemptVerdict,
  type WorkflowGqParamsMap,
  WorkflowRebuiltRunCount,
  WorkflowRunId,
  WorkflowRunRecord,
  type WorkflowStoreAvailabilityState,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  WorkflowUnitRecord,
  type WorkspaceFsError,
  WriterLeaseHeldError,
  toBoundedReason,
} from "@harness/contract"
import {
  isOmnigraphPreconditionOrConflictError,
  isOmnigraphTooManyRequestsError,
} from "@harness/graph"
import {
  WorkflowProjectionWriter,
  type WorkflowProjectionWriterShape,
  WorkflowReadModelQuery,
  type WorkflowReadModelQueryShape,
} from "@harness/service"
import {
  computeWorkflowRetryDelayMs,
  invokeWorkflowStoreQueryOnce,
  invokeWorkflowStoreQueryWithMeta,
  parseFiniteNumberOrString,
  toWorkflowStoreUnavailableError,
} from "../omnigraph-workflow-store.js"
import {
  type WorkflowReadModelLeaseFence,
  type WorkflowReadModelOptions,
  makeStoreTarget,
  optionalNonEmptyString,
  preserveStoreOrLeaseError,
  unwrapOption,
  verifyReadModelLeaseFence,
} from "./read-model-rebuild.js"
import { reconstructJournalViews } from "./read-model-rebuild-journal.js"

export type { WorkflowReadModelLeaseFence, WorkflowReadModelOptions }

const MAX_UPSERT_CAS_RETRIES = 16
const MAX_STALE_RUN_CLEAR_PAGES = 256
const WF_LIST_RUNS_PAGE_LIMIT = 256

const NonEmptyOwnedRelPathsSchema = Schema.NonEmptyArray(OwnedRelPath)
const RejectionFromJsonSchema = Schema.fromJsonString(UnitRejection)
const decodeWorkflowRunIdOption = Schema.decodeUnknownOption(WorkflowRunId)

const resolvePortRepoRoot = (
  operation: WorkflowStoreOperation,
  options?: WorkflowReadModelOptions,
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

const decodeRowWith = <A>(
  schema: Schema.Codec<A, unknown>,
  operation: WorkflowStoreOperation,
  candidate: Record<string, unknown>,
): Effect.Effect<A, WorkflowStoreUnavailableError> =>
  Schema.decodeEffect(schema)(candidate).pipe(
    Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
  )

const decodeRunRow = (
  operation: WorkflowStoreOperation,
  row: Readonly<Record<string, unknown>>,
): Effect.Effect<WorkflowRunRecord, WorkflowStoreUnavailableError> => {
  const planJson = optionalNonEmptyString(row.planJson)
  return decodeRowWith(WorkflowRunRecord, operation, {
    runId: row.runId,
    executionId: row.executionId,
    level: row.level,
    planSha: row.planSha,
    baseSha: row.baseSha,
    state: row.state,
    updatedMs: parseFiniteNumberOrString(row.updatedMs),
    ...(planJson !== undefined ? { planJson } : {}),
  })
}

const decodeUnitRow = (
  operation: WorkflowStoreOperation,
  row: Readonly<Record<string, unknown>>,
): Effect.Effect<WorkflowUnitRecord, WorkflowStoreUnavailableError> =>
  Schema.decodeUnknownEffect(NonEmptyOwnedRelPathsSchema)(row.ownedRelPaths).pipe(
    Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
    Effect.flatMap((ownedRelPaths) =>
      decodeRowWith(WorkflowUnitRecord, operation, {
        unitKey: row.unitKey,
        runId: row.runId,
        unitId: row.unitId,
        kind: row.kind,
        waveIndex: parseFiniteNumberOrString(row.waveIndex),
        status: row.status,
        ownedRelPaths,
        updatedMs: parseFiniteNumberOrString(row.updatedMs),
      }),
    ),
  )

const decodeAttemptRow = (
  operation: WorkflowStoreOperation,
  row: Readonly<Record<string, unknown>>,
): Effect.Effect<WorkflowAttemptRecord, WorkflowStoreUnavailableError> =>
  Effect.gen(function* () {
    const verdict = yield* Schema.decodeUnknownEffect(WorkflowAttemptVerdict)(row.verdict).pipe(
      Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
    )
    const runner = optionalNonEmptyString(row.runner)
    const packageStampHash = optionalNonEmptyString(row.packageStampHash)
    const baseFields = {
      attemptKey: row.attemptKey,
      runId: row.runId,
      unitId: row.unitId,
      attempt: parseFiniteNumberOrString(row.attempt),
      updatedMs: parseFiniteNumberOrString(row.updatedMs),
      ...(runner !== undefined ? { runner } : {}),
      ...(packageStampHash !== undefined ? { packageStampHash } : {}),
    }

    return yield* match(verdict)
      .with("rejected", () =>
        Effect.gen(function* () {
          const rejectionStr = optionalNonEmptyString(row.rejection)
          if (rejectionStr === undefined) {
            return yield* new WorkflowStoreUnavailableError({
              operation,
              reason: toBoundedReason(
                `WfAttempt '${String(row.attemptKey)}' has verdict 'rejected' without rejection payload`,
              ),
            })
          }
          const decodedRejection = yield* Schema.decodeEffect(RejectionFromJsonSchema)(
            rejectionStr,
          ).pipe(Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)))
          return yield* decodeRowWith(WorkflowAttemptRecord, operation, {
            ...baseFields,
            verdict: "rejected",
            rejection: decodedRejection,
          })
        }),
      )
      .with("dispatched", "completed", (nonRejectedVerdict) =>
        decodeRowWith(WorkflowAttemptRecord, operation, {
          ...baseFields,
          verdict: nonRejectedVerdict,
        }),
      )
      .exhaustive()
  })

const encodeAttemptRejectionPayload = (
  operation: WorkflowStoreOperation,
  attempt: WorkflowAttemptRecord,
): Effect.Effect<RejectionJsonPayload | null, WorkflowStoreUnavailableError> =>
  match(attempt)
    .with({ verdict: "rejected" }, ({ rejection }) =>
      Schema.encodeEffect(RejectionFromJsonSchema)(rejection).pipe(
        Effect.map((encoded) => RejectionJsonPayload.make(encoded)),
        Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
      ),
    )
    .with({ verdict: "dispatched" }, { verdict: "completed" }, () => Effect.succeed(null))
    .exhaustive()

type RunLockFn = <A, E>(runId: WorkflowRunId, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>

const makeLocalRunLock = (): RunLockFn => {
  const mutexes = new Map<WorkflowRunId, Semaphore.Semaphore>()
  return <A, E>(runId: WorkflowRunId, effect: Effect.Effect<A, E>): Effect.Effect<A, E> => {
    let sem = mutexes.get(runId)
    if (sem === undefined) {
      sem = Semaphore.makeUnsafe(1)
      mutexes.set(runId, sem)
    }
    return sem.withPermit(effect)
  }
}

const upsertReadModelEntity = <
  QGet extends "wf_get_run" | "wf_get_unit" | "wf_get_attempt",
  QIns extends "wf_insert_run" | "wf_insert_unit" | "wf_insert_attempt",
  QUpd extends "wf_update_run" | "wf_update_unit" | "wf_update_attempt",
>(config: {
  readonly runId: WorkflowRunId
  readonly withRunLock: RunLockFn
  readonly options?: WorkflowReadModelOptions | undefined
  readonly operation: WorkflowStoreOperation
  readonly getQuery: QGet
  readonly getParams: WorkflowGqParamsMap[QGet]
  readonly insertQuery: QIns
  readonly insertParams: WorkflowGqParamsMap[QIns]
  readonly updateQuery: QUpd
  readonly updateParams: WorkflowGqParamsMap[QUpd]
}): Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
  config.withRunLock(
    config.runId,
    Effect.gen(function* () {
      const repoRoot = yield* resolvePortRepoRoot(config.operation, config.options)
      const target = makeStoreTarget(repoRoot, config.options)
      yield* verifyReadModelLeaseFence(target, config.operation, config.options)

      const runCasAttempt = (
        attempt: number,
      ): Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
        Effect.gen(function* () {
          const existing = yield* invokeWorkflowStoreQueryOnce({
            ...target,
            operation: config.operation,
            queryName: config.getQuery,
            params: config.getParams,
            expectMutation: false,
          })
          yield* existing.rows.length === 0
            ? invokeWorkflowStoreQueryOnce({
                ...target,
                operation: config.operation,
                queryName: config.insertQuery,
                params: config.insertParams,
                expectMutation: true,
                ...(existing.graphCommitId !== null
                  ? { ifGraphCommit: existing.graphCommitId }
                  : {}),
              })
            : invokeWorkflowStoreQueryOnce({
                ...target,
                operation: config.operation,
                queryName: config.updateQuery,
                params: config.updateParams,
                expectMutation: true,
                ...(existing.graphCommitId !== null
                  ? { ifGraphCommit: existing.graphCommitId }
                  : {}),
              })
        }).pipe(
          Effect.catch((failure) => {
            if (failure.cause instanceof WriterLeaseHeldError) {
              return config.options?.expectedLeaseEpoch !== undefined
                ? Effect.fail(failure.cause)
                : Effect.fail(toWorkflowStoreUnavailableError(config.operation, failure.cause))
            }
            if (
              attempt < MAX_UPSERT_CAS_RETRIES &&
              (isOmnigraphPreconditionOrConflictError(failure.cause) ||
                isOmnigraphTooManyRequestsError(failure.cause))
            ) {
              const delayMs = computeWorkflowRetryDelayMs(attempt, failure.cause)
              return Effect.sleep(delayMs).pipe(Effect.andThen(runCasAttempt(attempt + 1)))
            }
            return Effect.fail(toWorkflowStoreUnavailableError(config.operation, failure.cause))
          }),
        )

      yield* runCasAttempt(0)
    }),
  )

const upsertRunImpl = (
  run: WorkflowRunRecord,
  withRunLock: RunLockFn,
  options?: WorkflowReadModelOptions,
): Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
  upsertReadModelEntity({
    runId: run.runId,
    withRunLock,
    options,
    operation: WorkflowStoreOperation.make("WorkflowProjectionWriter.upsertRun"),
    getQuery: "wf_get_run",
    getParams: { runId: run.runId },
    insertQuery: "wf_insert_run",
    insertParams: {
      runId: run.runId,
      executionId: run.executionId,
      level: run.level,
      planSha: run.planSha,
      baseSha: run.baseSha,
      state: run.state,
      planJson: run.planJson ?? null,
      updatedMs: run.updatedMs,
    },
    updateQuery: "wf_update_run",
    updateParams: { runId: run.runId, state: run.state, updatedMs: run.updatedMs },
  })

const upsertUnitImpl = (
  unit: WorkflowUnitRecord,
  withRunLock: RunLockFn,
  options?: WorkflowReadModelOptions,
): Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
  upsertReadModelEntity({
    runId: unit.runId,
    withRunLock,
    options,
    operation: WorkflowStoreOperation.make("WorkflowProjectionWriter.upsertUnit"),
    getQuery: "wf_get_unit",
    getParams: { unitKey: unit.unitKey },
    insertQuery: "wf_insert_unit",
    insertParams: {
      unitKey: unit.unitKey,
      runId: unit.runId,
      unitId: unit.unitId,
      kind: unit.kind,
      waveIndex: unit.waveIndex,
      status: unit.status,
      ownedRelPaths: unit.ownedRelPaths,
      updatedMs: unit.updatedMs,
    },
    updateQuery: "wf_update_unit",
    updateParams: { unitKey: unit.unitKey, status: unit.status, updatedMs: unit.updatedMs },
  })

const upsertAttemptImpl = (
  attempt: WorkflowAttemptRecord,
  withRunLock: RunLockFn,
  options?: WorkflowReadModelOptions,
): Effect.Effect<void, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
  Effect.gen(function* () {
    const operation = WorkflowStoreOperation.make("WorkflowProjectionWriter.upsertAttempt")
    const rejectionPayload = yield* encodeAttemptRejectionPayload(operation, attempt)
    yield* upsertReadModelEntity({
      runId: attempt.runId,
      withRunLock,
      options,
      operation,
      getQuery: "wf_get_attempt",
      getParams: { attemptKey: attempt.attemptKey },
      insertQuery: "wf_insert_attempt",
      insertParams: {
        attemptKey: attempt.attemptKey,
        runId: attempt.runId,
        unitId: attempt.unitId,
        attempt: attempt.attempt,
        verdict: attempt.verdict,
        runner: attempt.runner ?? null,
        rejection: rejectionPayload,
        packageStampHash: attempt.packageStampHash ?? null,
        updatedMs: attempt.updatedMs,
      },
      updateQuery: "wf_update_attempt",
      updateParams: {
        attemptKey: attempt.attemptKey,
        verdict: attempt.verdict,
        runner: attempt.runner ?? null,
        rejection: rejectionPayload,
        packageStampHash: attempt.packageStampHash ?? null,
        updatedMs: attempt.updatedMs,
      },
    })
  })

const queryAndDecodeRows = <
  Q extends "wf_list_runs" | "wf_units_for_run" | "wf_attempts_for_run",
  A,
>(config: {
  readonly options?: WorkflowReadModelOptions | undefined
  readonly operationName: string
  readonly queryName: Q
  readonly params: WorkflowGqParamsMap[Q]
  readonly decodeRow: (
    operation: WorkflowStoreOperation,
    row: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, WorkflowStoreUnavailableError>
}): Effect.Effect<ReadonlyArray<A>, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
  Effect.gen(function* () {
    const operation = WorkflowStoreOperation.make(config.operationName)
    const repoRoot = yield* resolvePortRepoRoot(operation, config.options)
    const target = makeStoreTarget(repoRoot, config.options)
    yield* verifyReadModelLeaseFence(target, operation, config.options)

    const res = yield* invokeWorkflowStoreQueryWithMeta({
      ...target,
      operation,
      queryName: config.queryName,
      params: config.params,
      expectMutation: false,
    }).pipe(Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)))

    return yield* Effect.forEach(res.rows, (row) => config.decodeRow(operation, row))
  })

const insertRunDirect = (
  target: ReturnType<typeof makeStoreTarget>,
  operation: WorkflowStoreOperation,
  run: WorkflowRunRecord,
  ifGraphCommit?: string,
): Effect.Effect<string | undefined, WorkflowStoreUnavailableError | WriterLeaseHeldError> => {
  // Omit explicit ifGraphCommit under active single-writer lease fencing so checkWriterLeaseFence
  // supplies a fresh leaseCommitId per attempt and background lease heartbeats retry cleanly.
  const effectiveIfGraphCommit = target.expectedLeaseEpoch === undefined ? ifGraphCommit : undefined
  return invokeWorkflowStoreQueryWithMeta({
    ...target,
    operation,
    queryName: "wf_insert_run",
    params: {
      runId: run.runId,
      executionId: run.executionId,
      level: run.level,
      planSha: run.planSha,
      baseSha: run.baseSha,
      state: run.state,
      planJson: run.planJson ?? null,
      updatedMs: run.updatedMs,
    },
    expectMutation: true,
    ...(effectiveIfGraphCommit !== undefined ? { ifGraphCommit: effectiveIfGraphCommit } : {}),
  }).pipe(
    Effect.map((res) => res.graphCommitId ?? undefined),
    Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)),
  )
}

const insertUnitDirect = (
  target: ReturnType<typeof makeStoreTarget>,
  operation: WorkflowStoreOperation,
  unit: WorkflowUnitRecord,
  ifGraphCommit?: string,
): Effect.Effect<string | undefined, WorkflowStoreUnavailableError | WriterLeaseHeldError> => {
  const effectiveIfGraphCommit = target.expectedLeaseEpoch === undefined ? ifGraphCommit : undefined
  return invokeWorkflowStoreQueryWithMeta({
    ...target,
    operation,
    queryName: "wf_insert_unit",
    params: {
      unitKey: unit.unitKey,
      runId: unit.runId,
      unitId: unit.unitId,
      kind: unit.kind,
      waveIndex: unit.waveIndex,
      status: unit.status,
      ownedRelPaths: unit.ownedRelPaths,
      updatedMs: unit.updatedMs,
    },
    expectMutation: true,
    ...(effectiveIfGraphCommit !== undefined ? { ifGraphCommit: effectiveIfGraphCommit } : {}),
  }).pipe(
    Effect.map((res) => res.graphCommitId ?? undefined),
    Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)),
  )
}

const insertAttemptDirect = (
  target: ReturnType<typeof makeStoreTarget>,
  operation: WorkflowStoreOperation,
  attempt: WorkflowAttemptRecord,
  ifGraphCommit?: string,
): Effect.Effect<string | undefined, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
  Effect.gen(function* () {
    const rejectionPayload = yield* encodeAttemptRejectionPayload(operation, attempt)
    const effectiveIfGraphCommit =
      target.expectedLeaseEpoch === undefined ? ifGraphCommit : undefined
    const res = yield* invokeWorkflowStoreQueryWithMeta({
      ...target,
      operation,
      queryName: "wf_insert_attempt",
      params: {
        attemptKey: attempt.attemptKey,
        runId: attempt.runId,
        unitId: attempt.unitId,
        attempt: attempt.attempt,
        verdict: attempt.verdict,
        runner: attempt.runner ?? null,
        rejection: rejectionPayload,
        packageStampHash: attempt.packageStampHash ?? null,
        updatedMs: attempt.updatedMs,
      },
      expectMutation: true,
      ...(effectiveIfGraphCommit !== undefined ? { ifGraphCommit: effectiveIfGraphCommit } : {}),
    }).pipe(Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)))
    return res.graphCommitId ?? undefined
  })

const clearExistingReadModelViews = (
  target: ReturnType<typeof makeStoreTarget>,
  operation: WorkflowStoreOperation,
  rebuiltRunIds: ReadonlyArray<WorkflowRunId>,
  initialGraphCommitId: string | undefined,
): Effect.Effect<string | undefined, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
  Effect.gen(function* () {
    const chainExplicitCommit = target.expectedLeaseEpoch === undefined
    let latestCommitId = chainExplicitCommit ? initialGraphCommitId : undefined
    const deletedRunIds = new Set<WorkflowRunId>()
    let clearedAllExisting = false

    for (let page = 0; page < MAX_STALE_RUN_CLEAR_PAGES; page += 1) {
      const existingBatch = yield* invokeWorkflowStoreQueryWithMeta({
        ...target,
        operation,
        queryName: "wf_list_runs",
        params: {},
        expectMutation: false,
      }).pipe(Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)))

      if (chainExplicitCommit && existingBatch.graphCommitId !== null) {
        latestCommitId = existingBatch.graphCommitId
      }

      if (existingBatch.rows.length === 0) {
        clearedAllExisting = true
        break
      }

      const batchRunIds: Array<WorkflowRunId> = []
      for (const row of existingBatch.rows) {
        const id = unwrapOption(decodeWorkflowRunIdOption(row.runId))
        if (id === undefined) {
          return yield* new WorkflowStoreUnavailableError({
            operation,
            reason: toBoundedReason(
              `Corrupt WfRun row encountered in wf_list_runs: invalid runId ${JSON.stringify(row.runId)}`,
            ),
          })
        }
        batchRunIds.push(id)
      }

      for (const runId of batchRunIds) {
        if (deletedRunIds.has(runId)) {
          return yield* new WorkflowStoreUnavailableError({
            operation,
            reason: toBoundedReason(
              `wf_delete_run_views stalled: runId '${runId}' remained in wf_list_runs after deletion`,
            ),
          })
        }
        const delRes = yield* invokeWorkflowStoreQueryWithMeta({
          ...target,
          operation,
          queryName: "wf_delete_run_views",
          params: { runId },
          expectMutation: true,
          ...(chainExplicitCommit && latestCommitId !== undefined
            ? { ifGraphCommit: latestCommitId }
            : {}),
        }).pipe(Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)))
        if (chainExplicitCommit && delRes.graphCommitId !== null) {
          latestCommitId = delRes.graphCommitId
        }
        deletedRunIds.add(runId)
      }

      if (existingBatch.rows.length < WF_LIST_RUNS_PAGE_LIMIT) {
        clearedAllExisting = true
        break
      }
    }

    if (!clearedAllExisting) {
      return yield* new WorkflowStoreUnavailableError({
        operation,
        reason: toBoundedReason(
          `Existing WfRun clear exceeded MAX_STALE_RUN_CLEAR_PAGES (${MAX_STALE_RUN_CLEAR_PAGES})`,
        ),
      })
    }

    for (const runId of rebuiltRunIds) {
      if (deletedRunIds.has(runId)) {
        continue
      }
      const delRes = yield* invokeWorkflowStoreQueryWithMeta({
        ...target,
        operation,
        queryName: "wf_delete_run_views",
        params: { runId },
        expectMutation: true,
        ...(chainExplicitCommit && latestCommitId !== undefined
          ? { ifGraphCommit: latestCommitId }
          : {}),
      }).pipe(Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)))
      if (chainExplicitCommit && delRes.graphCommitId !== null) {
        latestCommitId = delRes.graphCommitId
      }
      deletedRunIds.add(runId)
    }

    return latestCommitId
  })

/** Reconstructs `WfRun`, `WfUnit`, and `WfAttempt` read-model views from the `WfMessage`/`WfReply` journal. */
export const rebuildWorkflowReadModelViews = Effect.fn("Harness.rebuildWorkflowReadModelViews")(
  function* (
    repoRoot: AbsoluteRepoRoot,
    options?: WorkflowReadModelOptions,
  ): Effect.fn.Return<
    WorkflowRebuiltRunCount,
    WorkflowStoreUnavailableError | WriterLeaseHeldError | WorkspaceFsError
  > {
    const operation = WorkflowStoreOperation.make("WorkflowReadModel.rebuildViews")
    const target = makeStoreTarget(repoRoot, options)
    const nowValue = WorkflowTimestampMs.make(
      Math.max(0, Math.trunc(options?.nowMs !== undefined ? options.nowMs() : Date.now())),
    )

    const initialLeaseCommit = yield* verifyReadModelLeaseFence(target, operation, options)

    // Phase 1: Reconstruct & validate ALL journal bundles in memory BEFORE deleting any view rows.
    const rebuiltRuns = yield* reconstructJournalViews(repoRoot, operation, nowValue, options).pipe(
      Effect.withSpan("WorkflowReadModel.scanJournal"),
    )

    // Phase 2: Clear stale/existing view rows ONLY after full validation succeeds.
    let latestCommitId = yield* clearExistingReadModelViews(
      target,
      operation,
      rebuiltRuns.map((bundle) => bundle.run.runId),
      initialLeaseCommit,
    ).pipe(Effect.withSpan("WorkflowReadModel.clearStaleViews"))

    // Phase 3: Write rebuilt run/unit/attempt bundles under sequential OCC/lease fencing.
    for (const bundle of rebuiltRuns) {
      latestCommitId = yield* Effect.gen(function* () {
        let commitId = yield* insertRunDirect(target, operation, bundle.run, latestCommitId)
        yield* Effect.forEach(
          bundle.units,
          (unit) =>
            insertUnitDirect(target, operation, unit, commitId).pipe(
              Effect.tap((next) =>
                Effect.sync(() => {
                  commitId = next ?? commitId
                }),
              ),
            ),
          { discard: true, concurrency: 1 },
        ).pipe(Effect.withSpan("WorkflowReadModel.insertUnits"))
        yield* Effect.forEach(
          bundle.attempts,
          (attempt) =>
            insertAttemptDirect(target, operation, attempt, commitId).pipe(
              Effect.tap((next) =>
                Effect.sync(() => {
                  commitId = next ?? commitId
                }),
              ),
            ),
          { discard: true, concurrency: 1 },
        ).pipe(Effect.withSpan("WorkflowReadModel.insertAttempts"))
        return commitId
      }).pipe(Effect.withSpan("WorkflowReadModel.writeRebuiltRun"))
    }

    return WorkflowRebuiltRunCount.make(rebuiltRuns.length)
  },
)

/** Constructs a write-only `WorkflowProjectionWriter` layer backed by `workflows.gq` stored queries. */
const makeWorkflowProjectionWriterLayer = (
  options?: WorkflowReadModelOptions,
): Layer.Layer<WorkflowProjectionWriter> => {
  const withRunLock = options?.runLock ?? makeLocalRunLock()
  return Layer.succeed(WorkflowProjectionWriter, {
    upsertRun: (run: WorkflowRunRecord) => upsertRunImpl(run, withRunLock, options),
    upsertUnit: (unit: WorkflowUnitRecord) => upsertUnitImpl(unit, withRunLock, options),
    upsertAttempt: (attempt: WorkflowAttemptRecord) =>
      upsertAttemptImpl(attempt, withRunLock, options),
  } satisfies WorkflowProjectionWriterShape)
}

/** Constructs a read-only `WorkflowReadModelQuery` layer backed by `workflows.gq` stored queries. */
const makeWorkflowReadModelQueryLayer = (
  options?: WorkflowReadModelOptions,
): Layer.Layer<WorkflowReadModelQuery> => {
  const withReadGate =
    options?.readGate ?? (<A, E>(eff: Effect.Effect<A, E>): Effect.Effect<A, E> => eff)
  return Layer.succeed(WorkflowReadModelQuery, {
    getRun: (runId: WorkflowRunId) =>
      withReadGate(
        Effect.gen(function* () {
          const operation = WorkflowStoreOperation.make("WorkflowReadModelQuery.getRun")
          const repoRoot = yield* resolvePortRepoRoot(operation, options)
          const target = makeStoreTarget(repoRoot, options)
          yield* verifyReadModelLeaseFence(target, operation, options)
          const res = yield* invokeWorkflowStoreQueryWithMeta({
            ...target,
            operation,
            queryName: "wf_get_run",
            params: { runId },
            expectMutation: false,
          }).pipe(Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)))
          const first = res.rows[0]
          if (first === undefined) {
            return Option.none<WorkflowRunRecord>()
          }
          return Option.some(yield* decodeRunRow(operation, first))
        }),
      ),
    listRuns: withReadGate(
      queryAndDecodeRows({
        options,
        operationName: "WorkflowReadModelQuery.listRuns",
        queryName: "wf_list_runs",
        params: {},
        decodeRow: decodeRunRow,
      }),
    ),
    listUnits: (runId: WorkflowRunId) =>
      withReadGate(
        queryAndDecodeRows({
          options,
          operationName: "WorkflowReadModelQuery.listUnits",
          queryName: "wf_units_for_run",
          params: { runId },
          decodeRow: decodeUnitRow,
        }),
      ),
    listAttempts: (runId: WorkflowRunId) =>
      withReadGate(
        queryAndDecodeRows({
          options,
          operationName: "WorkflowReadModelQuery.listAttempts",
          queryName: "wf_attempts_for_run",
          params: { runId },
          decodeRow: decodeAttemptRow,
        }),
      ),
    probeAvailability: withReadGate(
      Effect.gen(function* () {
        const operation = WorkflowStoreOperation.make("WorkflowReadModelQuery.probeAvailability")
        const repoRoot = yield* resolvePortRepoRoot(operation, options)
        const target = makeStoreTarget(repoRoot, options)
        return yield* invokeWorkflowStoreQueryWithMeta({
          ...target,
          operation,
          queryName: "wf_probe_runs",
          params: {},
          expectMutation: false,
          maxOccRetries: 1,
        })
      }).pipe(
        Effect.match({
          onFailure: (): WorkflowStoreAvailabilityState => "inactive",
          onSuccess: (): WorkflowStoreAvailabilityState => "ready",
        }),
      ),
    ),
  } satisfies WorkflowReadModelQueryShape)
}

/** Production write-only `WorkflowProjectionWriter` layer. */
export const WorkflowProjectionWriterLive: Layer.Layer<WorkflowProjectionWriter> =
  makeWorkflowProjectionWriterLayer()

/** Production read-only `WorkflowReadModelQuery` layer. */
export const WorkflowReadModelQueryLive: Layer.Layer<WorkflowReadModelQuery> =
  makeWorkflowReadModelQueryLayer()

export { makeWorkflowProjectionWriterLayer, makeWorkflowReadModelQueryLayer }
