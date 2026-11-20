import { Effect, Layer, Option, Schema } from "effect"
import {
  AbsoluteRepoRoot,
  WorkflowAttemptRecord,
  type WorkflowGqParamsMap,
  WorkflowRebuiltRunCount,
  type WorkflowRunId,
  WorkflowRunRecord,
  type WorkflowStoreAvailabilityState,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
  WorkflowTimestampMs,
  WorkflowUnitRecord,
  type WorkspaceFsError,
} from "@harness/contract"
import {
  WorkflowProjectionWriter,
  type WorkflowProjectionWriterShape,
  WorkflowReadModelQuery,
  type WorkflowReadModelQueryShape,
} from "@harness/service"
import {
  invokeWorkflowStoreQueryWithMeta,
  parseFiniteNumberOrString,
  toWorkflowStoreUnavailableError,
} from "../omnigraph-workflow-store.js"
import {
  type WorkflowReadModelOptions,
  makeStoreTarget,
  optionalNonEmptyString,
  reconstructJournalViews,
  unwrapOption,
} from "./read-model-rebuild.js"

export type { WorkflowReadModelOptions }

const resolvePortRepoRoot = (options?: WorkflowReadModelOptions): AbsoluteRepoRoot =>
  options?.repoRoot ??
  unwrapOption(Schema.decodeOption(AbsoluteRepoRoot)(process.cwd())) ??
  AbsoluteRepoRoot.make("/tmp")

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
  decodeRowWith(WorkflowUnitRecord, operation, {
    unitKey: row.unitKey,
    runId: row.runId,
    unitId: row.unitId,
    kind: row.kind,
    waveIndex: parseFiniteNumberOrString(row.waveIndex),
    status: row.status,
    ownedRelPaths: Array.isArray(row.ownedRelPaths) ? row.ownedRelPaths : [],
    updatedMs: parseFiniteNumberOrString(row.updatedMs),
  })

const decodeAttemptRow = (
  operation: WorkflowStoreOperation,
  row: Readonly<Record<string, unknown>>,
): Effect.Effect<WorkflowAttemptRecord, WorkflowStoreUnavailableError> => {
  const runner = optionalNonEmptyString(row.runner)
  const rejection = optionalNonEmptyString(row.rejection)
  const packageStampHash = optionalNonEmptyString(row.packageStampHash)
  return decodeRowWith(WorkflowAttemptRecord, operation, {
    attemptKey: row.attemptKey,
    runId: row.runId,
    unitId: row.unitId,
    attempt: parseFiniteNumberOrString(row.attempt),
    verdict: row.verdict,
    updatedMs: parseFiniteNumberOrString(row.updatedMs),
    ...(runner !== undefined ? { runner } : {}),
    ...(rejection !== undefined ? { rejection } : {}),
    ...(packageStampHash !== undefined ? { packageStampHash } : {}),
  })
}

const upsertReadModelEntity = <
  QGet extends "wf_get_run" | "wf_get_unit" | "wf_get_attempt",
  QIns extends "wf_insert_run" | "wf_insert_unit" | "wf_insert_attempt",
  QUpd extends "wf_update_run" | "wf_update_unit" | "wf_update_attempt",
>(config: {
  readonly repoRoot: AbsoluteRepoRoot
  readonly options?: WorkflowReadModelOptions | undefined
  readonly operation: WorkflowStoreOperation
  readonly getQuery: QGet
  readonly getParams: WorkflowGqParamsMap[QGet]
  readonly insertQuery: QIns
  readonly insertParams: WorkflowGqParamsMap[QIns]
  readonly updateQuery: QUpd
  readonly updateParams: WorkflowGqParamsMap[QUpd]
}): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  Effect.gen(function* () {
    const target = makeStoreTarget(config.repoRoot, config.options)
    const existing = yield* invokeWorkflowStoreQueryWithMeta({
      ...target,
      operation: config.operation,
      queryName: config.getQuery,
      params: config.getParams,
      expectMutation: false,
    })
    yield* invokeWorkflowStoreQueryWithMeta(
      existing.rows.length === 0
        ? {
            ...target,
            operation: config.operation,
            queryName: config.insertQuery,
            params: config.insertParams,
            expectMutation: true,
          }
        : {
            ...target,
            operation: config.operation,
            queryName: config.updateQuery,
            params: config.updateParams,
            expectMutation: true,
          },
    )
  }).pipe(Effect.mapError((err) => toWorkflowStoreUnavailableError(config.operation, err)))

const upsertRunImpl = (
  repoRoot: AbsoluteRepoRoot,
  run: WorkflowRunRecord,
  options?: WorkflowReadModelOptions,
): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  upsertReadModelEntity({
    repoRoot,
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
  repoRoot: AbsoluteRepoRoot,
  unit: WorkflowUnitRecord,
  options?: WorkflowReadModelOptions,
): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  upsertReadModelEntity({
    repoRoot,
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
  repoRoot: AbsoluteRepoRoot,
  attempt: WorkflowAttemptRecord,
  options?: WorkflowReadModelOptions,
): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  upsertReadModelEntity({
    repoRoot,
    options,
    operation: WorkflowStoreOperation.make("WorkflowProjectionWriter.upsertAttempt"),
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
      rejection: attempt.rejection ?? null,
      packageStampHash: attempt.packageStampHash ?? null,
      updatedMs: attempt.updatedMs,
    },
    updateQuery: "wf_update_attempt",
    updateParams: {
      attemptKey: attempt.attemptKey,
      verdict: attempt.verdict,
      runner: attempt.runner ?? null,
      rejection: attempt.rejection ?? null,
      packageStampHash: attempt.packageStampHash ?? null,
      updatedMs: attempt.updatedMs,
    },
  })

const queryAndDecodeRows = <
  Q extends "wf_list_runs" | "wf_units_for_run" | "wf_attempts_for_run",
  A,
>(config: {
  readonly target: ReturnType<typeof makeStoreTarget>
  readonly operationName: string
  readonly queryName: Q
  readonly params: WorkflowGqParamsMap[Q]
  readonly decodeRow: (
    operation: WorkflowStoreOperation,
    row: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, WorkflowStoreUnavailableError>
}): Effect.Effect<ReadonlyArray<A>, WorkflowStoreUnavailableError> => {
  const operation = WorkflowStoreOperation.make(config.operationName)
  return invokeWorkflowStoreQueryWithMeta({
    ...config.target,
    operation,
    queryName: config.queryName,
    params: config.params,
    expectMutation: false,
  }).pipe(
    Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
    Effect.flatMap((res) => Effect.forEach(res.rows, (row) => config.decodeRow(operation, row))),
  )
}

const insertRunDirect = (
  target: ReturnType<typeof makeStoreTarget>,
  operation: WorkflowStoreOperation,
  run: WorkflowRunRecord,
): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  invokeWorkflowStoreQueryWithMeta({
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
  }).pipe(
    Effect.asVoid,
    Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
  )

const insertUnitDirect = (
  target: ReturnType<typeof makeStoreTarget>,
  operation: WorkflowStoreOperation,
  unit: WorkflowUnitRecord,
): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  invokeWorkflowStoreQueryWithMeta({
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
  }).pipe(
    Effect.asVoid,
    Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
  )

const insertAttemptDirect = (
  target: ReturnType<typeof makeStoreTarget>,
  operation: WorkflowStoreOperation,
  attempt: WorkflowAttemptRecord,
): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  invokeWorkflowStoreQueryWithMeta({
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
      rejection: attempt.rejection ?? null,
      packageStampHash: attempt.packageStampHash ?? null,
      updatedMs: attempt.updatedMs,
    },
    expectMutation: true,
  }).pipe(
    Effect.asVoid,
    Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
  )

/** Reconstructs `WfRun`, `WfUnit`, and `WfAttempt` read-model views from the `WfMessage`/`WfReply` journal. */
export const rebuildWorkflowReadModelViews = Effect.fn("Harness.rebuildWorkflowReadModelViews")(
  function* (
    repoRoot: AbsoluteRepoRoot,
    options?: WorkflowReadModelOptions,
  ): Effect.fn.Return<WorkflowRebuiltRunCount, WorkflowStoreUnavailableError | WorkspaceFsError> {
    const operation = WorkflowStoreOperation.make("WorkflowReadModel.rebuildViews")
    const target = makeStoreTarget(repoRoot, options)
    const nowValue = WorkflowTimestampMs.make(
      Math.max(0, Math.trunc(options?.nowMs !== undefined ? options.nowMs() : Date.now())),
    )

    const { runIdsToDelete, rebuiltRuns } = yield* reconstructJournalViews(
      repoRoot,
      operation,
      nowValue,
      options,
    ).pipe(Effect.withSpan("WorkflowReadModel.scanJournal"))

    yield* Effect.forEach(
      runIdsToDelete,
      (runId) =>
        invokeWorkflowStoreQueryWithMeta({
          ...target,
          operation,
          queryName: "wf_delete_run_views",
          params: { runId },
          expectMutation: true,
        }).pipe(Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err))),
      { discard: true },
    ).pipe(Effect.withSpan("WorkflowReadModel.clearStaleViews"))

    for (const bundle of rebuiltRuns) {
      yield* Effect.gen(function* () {
        yield* insertRunDirect(target, operation, bundle.run)
        yield* Effect.forEach(bundle.units, (unit) => insertUnitDirect(target, operation, unit), {
          discard: true,
        }).pipe(Effect.withSpan("WorkflowReadModel.insertUnits"))
        yield* Effect.forEach(
          bundle.attempts,
          (attempt) => insertAttemptDirect(target, operation, attempt),
          { discard: true },
        ).pipe(Effect.withSpan("WorkflowReadModel.insertAttempts"))
      }).pipe(Effect.withSpan("WorkflowReadModel.writeRebuiltRun"))
    }

    return WorkflowRebuiltRunCount.make(rebuiltRuns.length)
  },
)

/** Constructs a write-only `WorkflowProjectionWriter` layer backed by `workflows.gq` stored queries. */
const makeWorkflowProjectionWriterLayer = (
  options?: WorkflowReadModelOptions,
): Layer.Layer<WorkflowProjectionWriter> => {
  const repoRoot = resolvePortRepoRoot(options)
  return Layer.succeed(WorkflowProjectionWriter, {
    upsertRun: (run: WorkflowRunRecord) => upsertRunImpl(repoRoot, run, options),
    upsertUnit: (unit: WorkflowUnitRecord) => upsertUnitImpl(repoRoot, unit, options),
    upsertAttempt: (attempt: WorkflowAttemptRecord) =>
      upsertAttemptImpl(repoRoot, attempt, options),
  } satisfies WorkflowProjectionWriterShape)
}

/** Constructs a read-only `WorkflowReadModelQuery` layer backed by `workflows.gq` stored queries. */
const makeWorkflowReadModelQueryLayer = (
  options?: WorkflowReadModelOptions,
): Layer.Layer<WorkflowReadModelQuery> => {
  const repoRoot = resolvePortRepoRoot(options)
  const target = makeStoreTarget(repoRoot, options)

  return Layer.succeed(WorkflowReadModelQuery, {
    getRun: (runId: WorkflowRunId) => {
      const operation = WorkflowStoreOperation.make("WorkflowReadModelQuery.getRun")
      return invokeWorkflowStoreQueryWithMeta({
        ...target,
        operation,
        queryName: "wf_get_run",
        params: { runId },
        expectMutation: false,
      }).pipe(
        Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
        Effect.flatMap((res) => {
          const first = res.rows[0]
          if (first === undefined) {
            return Effect.succeed(Option.none<WorkflowRunRecord>())
          }
          return decodeRunRow(operation, first).pipe(Effect.asSome)
        }),
      )
    },
    listRuns: queryAndDecodeRows({
      target,
      operationName: "WorkflowReadModelQuery.listRuns",
      queryName: "wf_list_runs",
      params: {},
      decodeRow: decodeRunRow,
    }),
    listUnits: (runId: WorkflowRunId) =>
      queryAndDecodeRows({
        target,
        operationName: "WorkflowReadModelQuery.listUnits",
        queryName: "wf_units_for_run",
        params: { runId },
        decodeRow: decodeUnitRow,
      }),
    listAttempts: (runId: WorkflowRunId) =>
      queryAndDecodeRows({
        target,
        operationName: "WorkflowReadModelQuery.listAttempts",
        queryName: "wf_attempts_for_run",
        params: { runId },
        decodeRow: decodeAttemptRow,
      }),
    probeAvailability: invokeWorkflowStoreQueryWithMeta({
      ...target,
      operation: WorkflowStoreOperation.make("WorkflowReadModelQuery.probeAvailability"),
      queryName: "wf_probe_runs",
      params: {},
      expectMutation: false,
      maxOccRetries: 1,
    }).pipe(
      Effect.match({
        onFailure: (): WorkflowStoreAvailabilityState => "inactive",
        onSuccess: (): WorkflowStoreAvailabilityState => "ready",
      }),
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
