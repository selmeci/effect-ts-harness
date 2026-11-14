import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import {
  AggregateCount,
  AggregateId,
  type AggregateName,
  ErrorMessage,
  EventMetadata,
  PositiveInt,
  type ProcessorId,
  ProjectionArchiveCorruptionError,
  type ProjectionCatchUpStatus,
  StreamVersion,
  type TimestampMs,
} from "@harness/es-contract"
import {
  type ArchivedEvent,
  type CrossAggregateProjection,
  rebuildCrossProjection,
} from "@harness/es-core"
import { match } from "ts-pattern"

interface ArchiveEventRow {
  readonly aggregate_name: string
  readonly aggregate_id: string
  readonly stream_version: number
  readonly event_type: string
  readonly payload: string
  readonly metadata: string
  readonly archived_at: number
}

const decodeRowIdentity = <V extends number>(
  processorId: ProcessorId,
  aggregateName: AggregateName,
  rawAggregateId: string,
  rawVersion: number | null,
  decodeVersion: (raw: number) => Option.Option<V>,
  aggErrorPrefix: string,
  verErrorPrefix: string,
): Effect.Effect<
  { readonly aggregateId: AggregateId; readonly version: V },
  ProjectionArchiveCorruptionError
> => {
  const aggIdOpt = Schema.decodeOption(AggregateId)(rawAggregateId)
  const verOpt = rawVersion !== null ? decodeVersion(rawVersion) : Option.none<V>()
  const fallbackAggId = match(aggIdOpt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => AggregateId.make("unknown-id"))
    .exhaustive()
  const fallbackVer = StreamVersion.make(0)

  return match({ aggIdOpt, verOpt })
    .with(
      { aggIdOpt: { _tag: "Some" }, verOpt: { _tag: "Some" } },
      ({ aggIdOpt: { value: aggregateId }, verOpt: { value: version } }) =>
        Effect.succeed({ aggregateId, version }),
    )
    .with({ aggIdOpt: { _tag: "None" } }, () =>
      Effect.fail(
        new ProjectionArchiveCorruptionError({
          processorId,
          aggregateName,
          aggregateId: fallbackAggId,
          streamVersion: fallbackVer,
          reason: ErrorMessage.make(`${aggErrorPrefix}: ${String(rawAggregateId)}`),
        }),
      ),
    )
    .with({ verOpt: { _tag: "None" } }, () =>
      Effect.fail(
        new ProjectionArchiveCorruptionError({
          processorId,
          aggregateName,
          aggregateId: fallbackAggId,
          streamVersion: fallbackVer,
          reason: ErrorMessage.make(`${verErrorPrefix}: ${String(rawVersion)}`),
        }),
      ),
    )
    .exhaustive()
}

const loadValidatedArchiveEvents = <
  Event,
  ReadModel,
  QueryInput,
  ProjEnv,
  ProjErr,
>(
  projection: CrossAggregateProjection<Event, ReadModel, QueryInput, ProjEnv, ProjErr>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<ArchiveEventRow>`
      SELECT
        aggregate_name,
        aggregate_id,
        stream_version,
        event_type,
        payload,
        metadata,
        archived_at
      FROM es_event_archive
      WHERE aggregate_name = ${projection.aggregateName}
      ORDER BY aggregate_id ASC, stream_version ASC
    `

    const expectedVersionsByAgg = new Map<string, number>()
    const lastVersionByAgg = new Map<
      string,
      { readonly lastVersion: StreamVersion; readonly updatedAt: TimestampMs }
    >()
    const archivedEvents: Array<ArchivedEvent<Event>> = []

    for (const row of rows) {
      const { aggregateId: aggId, version: streamVer } = yield* decodeRowIdentity(
        projection.processorId,
        projection.aggregateName,
        row.aggregate_id,
        row.stream_version,
        (raw) => Schema.decodeOption(StreamVersion)(raw),
        "Invalid archive aggregate_id",
        "Invalid archive stream_version",
      )

      const expected = expectedVersionsByAgg.get(row.aggregate_id) ?? 1
      if (streamVer !== expected) {
        return yield* new ProjectionArchiveCorruptionError({
          processorId: projection.processorId,
          aggregateName: projection.aggregateName,
          aggregateId: aggId,
          streamVersion: streamVer,
          reason: ErrorMessage.make(
            `Non-contiguous archive stream: expected version ${expected}, got ${row.stream_version}`,
          ),
        })
      }
      expectedVersionsByAgg.set(aggId, expected + 1)

      const event = yield* Schema.decodeEffect(Schema.fromJsonString(projection.eventSchema))(
        row.payload,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectionArchiveCorruptionError({
              processorId: projection.processorId,
              aggregateName: projection.aggregateName,
              aggregateId: aggId,
              streamVersion: streamVer,
              reason: ErrorMessage.make(`Corrupt archive event JSON: ${String(cause)}`),
            }),
        ),
      )

      const metadata = yield* Schema.decodeEffect(Schema.fromJsonString(EventMetadata))(
        row.metadata,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectionArchiveCorruptionError({
              processorId: projection.processorId,
              aggregateName: projection.aggregateName,
              aggregateId: aggId,
              streamVersion: streamVer,
              reason: ErrorMessage.make(`Corrupt archive metadata JSON: ${String(cause)}`),
            }),
        ),
      )

      if (metadata.aggregateId !== aggId || metadata.streamVersion !== streamVer) {
        return yield* new ProjectionArchiveCorruptionError({
          processorId: projection.processorId,
          aggregateName: projection.aggregateName,
          aggregateId: aggId,
          streamVersion: streamVer,
          reason: ErrorMessage.make("Archive metadata mismatch with row columns"),
        })
      }

      lastVersionByAgg.set(aggId, {
        lastVersion: streamVer,
        updatedAt: metadata.timestamp,
      })

      archivedEvents.push({
        aggregateName: projection.aggregateName,
        aggregateId: aggId,
        event,
        metadata,
      })
    }

    return { archivedEvents, lastVersionByAgg }
  })

export const rebuildProjectorFromArchive = Effect.fn("Projector.rebuild")(function* <
  Event,
  ReadModel,
  QueryInput = void,
  ProjEnv = never,
  ProjErr = never,
>(projection: CrossAggregateProjection<Event, ReadModel, QueryInput, ProjEnv, ProjErr>) {
  const sql = yield* SqlClient
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { archivedEvents, lastVersionByAgg } = yield* loadValidatedArchiveEvents(projection)

      yield* sql`
        DELETE FROM es_projection_gaps
        WHERE processor_id = ${projection.processorId}
          AND aggregate_name = ${projection.aggregateName}
      `
      yield* sql`
        DELETE FROM es_projection_checkpoints
        WHERE processor_id = ${projection.processorId}
          AND aggregate_name = ${projection.aggregateName}
      `

      yield* rebuildCrossProjection(projection, archivedEvents)

      for (const [aggId, info] of lastVersionByAgg.entries()) {
        yield* sql`
          INSERT INTO es_projection_checkpoints (
            processor_id,
            aggregate_name,
            aggregate_id,
            last_stream_version,
            updated_at
          ) VALUES (
            ${projection.processorId},
            ${projection.aggregateName},
            ${aggId},
            ${info.lastVersion},
            ${info.updatedAt}
          )
        `
      }
    }),
  )
})

export const checkProjectorCatchUp = Effect.fn("Projector.checkCatchUp")(function* (
  processorId: ProcessorId,
  aggregateName: AggregateName,
) {
  const sql = yield* SqlClient

  const { archiveHeads, checkpoints, gapRows } = yield* sql.withTransaction(
    Effect.gen(function* () {
      const archiveHeads = yield* sql<{ aggregate_id: string; max_version: number | null }>`
        SELECT aggregate_id, MAX(stream_version) AS max_version
        FROM es_event_archive
        WHERE aggregate_name = ${aggregateName}
        GROUP BY aggregate_id
        ORDER BY aggregate_id ASC
      `

      const checkpoints = yield* sql<{ aggregate_id: string; last_stream_version: number }>`
        SELECT aggregate_id, last_stream_version
        FROM es_projection_checkpoints
        WHERE processor_id = ${processorId}
          AND aggregate_name = ${aggregateName}
      `

      const gapRows = yield* sql<{ aggregate_id: string; stream_version: number }>`
        SELECT aggregate_id, stream_version
        FROM es_projection_gaps
        WHERE processor_id = ${processorId}
          AND aggregate_name = ${aggregateName}
        ORDER BY aggregate_id ASC, stream_version ASC
      `

      return { archiveHeads, checkpoints, gapRows }
    }),
  )

  const checkpointMap = new Map<string, { aggregateId: AggregateId; version: StreamVersion }>()
  for (const cp of checkpoints) {
    const validatedCp = yield* decodeRowIdentity(
      processorId,
      aggregateName,
      cp.aggregate_id,
      cp.last_stream_version,
      (raw) => Schema.decodeOption(StreamVersion)(raw),
      "Invalid checkpoint aggregate_id",
      "Invalid checkpoint last_stream_version",
    )
    checkpointMap.set(validatedCp.aggregateId, validatedCp)
  }

  const headMap = new Map<string, { aggregateId: AggregateId; version: StreamVersion }>()
  for (const head of archiveHeads) {
    const validatedHead = yield* decodeRowIdentity(
      processorId,
      aggregateName,
      head.aggregate_id,
      head.max_version,
      (raw) => (raw > 0 ? Schema.decodeOption(StreamVersion)(raw) : Option.none()),
      "Invalid archive head aggregate_id",
      "Invalid archive head max_version",
    )
    headMap.set(validatedHead.aggregateId, validatedHead)
  }

  for (const [aggId, cp] of checkpointMap.entries()) {
    const head = headMap.get(aggId)
    const headVer = head !== undefined ? head.version : StreamVersion.make(0)
    if (cp.version > headVer) {
      return yield* new ProjectionArchiveCorruptionError({
        processorId,
        aggregateName,
        aggregateId: cp.aggregateId,
        streamVersion: cp.version,
        reason: ErrorMessage.make(
          `Checkpoint version ${cp.version} exceeds archive head ${headVer}`,
        ),
      })
    }
  }

  const validatedGaps: Array<{ aggregateId: AggregateId; streamVersion: PositiveInt }> = []
  for (const gap of gapRows) {
    const validatedGap = yield* decodeRowIdentity(
      processorId,
      aggregateName,
      gap.aggregate_id,
      gap.stream_version,
      (raw) => Schema.decodeOption(PositiveInt)(raw),
      "Invalid gap aggregate_id",
      "Invalid gap stream_version",
    )
    validatedGaps.push({ aggregateId: validatedGap.aggregateId, streamVersion: validatedGap.version })
  }

  const firstGap = validatedGaps[0]
  if (firstGap !== undefined) {
    const cpEntry = checkpointMap.get(firstGap.aggregateId)
    const cpVer = cpEntry !== undefined ? cpEntry.version : StreamVersion.make(0)
    const headEntry = headMap.get(firstGap.aggregateId)
    const headVer = headEntry !== undefined ? headEntry.version : StreamVersion.make(0)
    const laggingStatus: ProjectionCatchUpStatus = {
      _tag: "Lagging",
      laggingAggregateId: firstGap.aggregateId,
      checkpointVersion: cpVer,
      archiveHeadVersion: headVer,
    }
    return laggingStatus
  }

  for (const head of headMap.values()) {
    const cpEntry = checkpointMap.get(head.aggregateId)
    const cpVer = cpEntry !== undefined ? cpEntry.version : StreamVersion.make(0)
    if (cpVer < head.version) {
      const laggingStatus: ProjectionCatchUpStatus = {
        _tag: "Lagging",
        laggingAggregateId: head.aggregateId,
        checkpointVersion: cpVer,
        archiveHeadVersion: head.version,
      }
      return laggingStatus
    }
  }

  const caughtUpStatus: ProjectionCatchUpStatus = {
    _tag: "CaughtUp",
    archiveAggregatesCount: AggregateCount.make(headMap.size),
  }
  return caughtUpStatus
})
