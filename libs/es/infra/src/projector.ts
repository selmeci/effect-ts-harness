import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import {
  AggregateCount,
  AggregateId,
  type AggregateName,
  ErrorMessage,
  EventMetadata,
  PositiveInt,
  ProcessorId,
  ProjectionArchiveCorruptionError,
  type ProjectionCatchUpStatus,
  type PublishedEventEnvelope,
  StreamVersion,
  TimestampMs,
} from "@harness/es-contract"
import {
  type ArchivedEvent,
  applyCrossProjection,
  type CrossAggregateProjection,
  decideProjectionSequence,
  rebuildCrossProjection,
} from "@harness/es-core"
import { match } from "ts-pattern"

export const PROJECTOR_MIGRATIONS_TABLE = "es_projector_sql_migrations"

export const projectorCoreMigrations: Readonly<
  Record<string, Effect.Effect<void, SqlError, SqlClient>>
> = {
  "1_init_es_projector_tables": Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_event_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aggregate_name TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        command_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        UNIQUE(aggregate_name, aggregate_id, stream_version)
      );
    `
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_projection_checkpoints (
        processor_id TEXT NOT NULL,
        aggregate_name TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        last_stream_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (processor_id, aggregate_name, aggregate_id)
      );
    `
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_projection_gaps (
        processor_id TEXT NOT NULL,
        aggregate_name TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT NOT NULL,
        parked_at INTEGER NOT NULL,
        PRIMARY KEY (processor_id, aggregate_name, aggregate_id, stream_version)
      );
    `
  }),
}

export const initializeProjectorTables = Effect.fn("ProjectorInfra.initTables")(function* (
  additionalMigrations?: Readonly<Record<string, Effect.Effect<void, SqlError, SqlClient>>>,
) {
  return yield* SqliteMigrator.run({
    loader: SqliteMigrator.fromRecord({
      ...projectorCoreMigrations,
      ...additionalMigrations,
    }),
    table: PROJECTOR_MIGRATIONS_TABLE,
  })
})

export const ingestPublishedEvent = Effect.fn("Projector.ingest")(function* <
  Event,
  ReadModel,
  QueryInput = void,
  ProjEnv = never,
  ProjErr = never,
>(
  envelope: PublishedEventEnvelope,
  projections: ReadonlyArray<
    CrossAggregateProjection<Event, ReadModel, QueryInput, ProjEnv, ProjErr>
  >,
) {
  const sql = yield* SqlClient
  const defaultProcessorId = projections[0]?.processorId ?? ProcessorId.make(envelope.aggregateName)

  if (envelope.streamVersion <= 0) {
    return yield* new ProjectionArchiveCorruptionError({
      processorId: defaultProcessorId,
      aggregateName: envelope.aggregateName,
      aggregateId: envelope.aggregateId,
      streamVersion: envelope.streamVersion,
      reason: ErrorMessage.make("PublishedEventEnvelope streamVersion must be positive (> 0)"),
    })
  }

  if (
    envelope.metadata.aggregateId !== envelope.aggregateId ||
    envelope.metadata.streamVersion !== envelope.streamVersion
  ) {
    return yield* new ProjectionArchiveCorruptionError({
      processorId: defaultProcessorId,
      aggregateName: envelope.aggregateName,
      aggregateId: envelope.aggregateId,
      streamVersion: envelope.streamVersion,
      reason: ErrorMessage.make("Metadata aggregateId or streamVersion mismatch with envelope"),
    })
  }

  yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(envelope.payload).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectionArchiveCorruptionError({
          processorId: defaultProcessorId,
          aggregateName: envelope.aggregateName,
          aggregateId: envelope.aggregateId,
          streamVersion: envelope.streamVersion,
          reason: ErrorMessage.make(`Invalid payload JSON in envelope: ${String(cause)}`),
        }),
    ),
  )

  for (const projection of projections) {
    if (projection.aggregateName !== envelope.aggregateName) {
      continue
    }
    yield* Schema.decodeEffect(Schema.fromJsonString(projection.eventSchema))(
      envelope.payload,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectionArchiveCorruptionError({
            processorId: projection.processorId,
            aggregateName: envelope.aggregateName,
            aggregateId: envelope.aggregateId,
            streamVersion: envelope.streamVersion,
            reason: ErrorMessage.make(
              `Payload does not match projection eventSchema: ${String(cause)}`,
            ),
          }),
      ),
    )
  }

  const metadataJsonSchema = Schema.fromJsonString(EventMetadata)
  const metadataJson = yield* Schema.encodeEffect(metadataJsonSchema)(envelope.metadata).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectionArchiveCorruptionError({
          processorId: defaultProcessorId,
          aggregateName: envelope.aggregateName,
          aggregateId: envelope.aggregateId,
          streamVersion: envelope.streamVersion,
          reason: ErrorMessage.make(`Corrupt metadata JSON: ${String(cause)}`),
        }),
    ),
  )

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existingRows = yield* sql<{
        aggregate_name: string
        aggregate_id: string
        stream_version: number
        command_id: string
        event_type: string
        payload: string
        metadata: string
      }>`
        SELECT aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata
        FROM es_event_archive
        WHERE aggregate_name = ${envelope.aggregateName}
          AND aggregate_id = ${envelope.aggregateId}
          AND stream_version = ${envelope.streamVersion}
      `

      const existing = existingRows[0]
      if (
        existing !== undefined &&
        (existing.payload !== envelope.payload ||
          existing.event_type !== envelope.eventType ||
          existing.command_id !== envelope.metadata.commandId ||
          existing.metadata !== metadataJson)
      ) {
        return yield* new ProjectionArchiveCorruptionError({
          processorId: defaultProcessorId,
          aggregateName: envelope.aggregateName,
          aggregateId: envelope.aggregateId,
          streamVersion: envelope.streamVersion,
          reason: ErrorMessage.make(
            "Conflicting archived event payload, event_type, command_id, or metadata at existing version",
          ),
        })
      }

      if (existing === undefined) {
        yield* sql`
          INSERT INTO es_event_archive (
            aggregate_name,
            aggregate_id,
            stream_version,
            command_id,
            event_type,
            payload,
            metadata,
            archived_at
          ) VALUES (
            ${envelope.aggregateName},
            ${envelope.aggregateId},
            ${envelope.streamVersion},
            ${envelope.metadata.commandId},
            ${envelope.eventType},
            ${envelope.payload},
            ${metadataJson},
            ${envelope.metadata.timestamp}
          )
        `
      }

      const decisions: Array<import("@harness/es-contract").ProjectionSequenceDecision> = []

      for (const projection of projections) {
        if (projection.aggregateName !== envelope.aggregateName) {
          continue
        }

        const checkpointRows = yield* sql<{ last_stream_version: number }>`
          SELECT last_stream_version
          FROM es_projection_checkpoints
          WHERE processor_id = ${projection.processorId}
            AND aggregate_name = ${projection.aggregateName}
            AND aggregate_id = ${envelope.aggregateId}
        `
        const firstCp = checkpointRows[0]
        const checkpointVersion =
          firstCp !== undefined
            ? yield* match(Schema.decodeOption(StreamVersion)(firstCp.last_stream_version))
                .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
                .with({ _tag: "None" }, () =>
                  Effect.fail(
                    new ProjectionArchiveCorruptionError({
                      processorId: projection.processorId,
                      aggregateName: projection.aggregateName,
                      aggregateId: envelope.aggregateId,
                      streamVersion: StreamVersion.make(0),
                      reason: ErrorMessage.make(
                        `Invalid checkpoint last_stream_version: ${String(firstCp.last_stream_version)}`,
                      ),
                    }),
                  ),
                )
                .exhaustive()
            : StreamVersion.make(0)

        const gapRows = yield* sql<{
          stream_version: number
          payload: string
          metadata: string
        }>`
          SELECT stream_version, payload, metadata
          FROM es_projection_gaps
          WHERE processor_id = ${projection.processorId}
            AND aggregate_name = ${projection.aggregateName}
            AND aggregate_id = ${envelope.aggregateId}
          ORDER BY stream_version ASC
        `
        const parkedVersions: Array<StreamVersion> = []
        for (const r of gapRows) {
          const streamVer = yield* match(Schema.decodeOption(PositiveInt)(r.stream_version))
            .with({ _tag: "Some" }, ({ value }) => Effect.succeed(StreamVersion.make(value)))
            .with({ _tag: "None" }, () =>
              Effect.fail(
                new ProjectionArchiveCorruptionError({
                  processorId: projection.processorId,
                  aggregateName: projection.aggregateName,
                  aggregateId: envelope.aggregateId,
                  streamVersion: StreamVersion.make(0),
                  reason: ErrorMessage.make(
                    `Invalid parked gap stream_version: ${String(r.stream_version)}`,
                  ),
                }),
              ),
            )
            .exhaustive()
          parkedVersions.push(streamVer)
        }

        const decision = yield* decideProjectionSequence({
          checkpointVersion,
          incomingVersion: envelope.streamVersion,
          parkedVersions,
        })

        decisions.push(decision)

        yield* match(decision)
          .with({ _tag: "SkipDuplicateEvent" }, () => Effect.void)
          .with({ _tag: "ParkOutOfOrderEvent" }, () =>
            sql`
              INSERT INTO es_projection_gaps (
                processor_id,
                aggregate_name,
                aggregate_id,
                stream_version,
                event_type,
                payload,
                metadata,
                parked_at
              ) VALUES (
                ${projection.processorId},
                ${projection.aggregateName},
                ${envelope.aggregateId},
                ${envelope.streamVersion},
                ${envelope.eventType},
                ${envelope.payload},
                ${metadataJson},
                ${envelope.metadata.timestamp}
              )
              ON CONFLICT (processor_id, aggregate_name, aggregate_id, stream_version) DO NOTHING
            `.pipe(Effect.asVoid),
          )
          .with({ _tag: "ApplyContiguousEvents" }, ({ versionsToApply, newCheckpointVersion }) =>
            Effect.gen(function* () {
              let latestAppliedTimestamp: TimestampMs = envelope.metadata.timestamp
              for (const ver of versionsToApply) {
                let vPayload: string
                let vMetadata: string
                if (ver === envelope.streamVersion) {
                  vPayload = envelope.payload
                  vMetadata = metadataJson
                } else {
                  const matchedGap = gapRows.find((g) => g.stream_version === ver)
                  if (matchedGap !== undefined) {
                    vPayload = matchedGap.payload
                    vMetadata = matchedGap.metadata
                  } else {
                    const arch = yield* sql<{ payload: string; metadata: string }>`
                      SELECT payload, metadata
                      FROM es_event_archive
                      WHERE aggregate_name = ${projection.aggregateName}
                        AND aggregate_id = ${envelope.aggregateId}
                        AND stream_version = ${ver}
                    `
                    const archRow = arch[0]
                    if (archRow === undefined) {
                      return yield* new ProjectionArchiveCorruptionError({
                        processorId: projection.processorId,
                        aggregateName: projection.aggregateName,
                        aggregateId: envelope.aggregateId,
                        streamVersion: ver,
                        reason: ErrorMessage.make(`Missing archive row for version ${ver}`),
                      })
                    }
                    vPayload = archRow.payload
                    vMetadata = archRow.metadata
                  }
                }

                const eventVal = yield* Schema.decodeEffect(
                  Schema.fromJsonString(projection.eventSchema),
                )(vPayload).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProjectionArchiveCorruptionError({
                        processorId: projection.processorId,
                        aggregateName: projection.aggregateName,
                        aggregateId: envelope.aggregateId,
                        streamVersion: ver,
                        reason: ErrorMessage.make(`Corrupt event JSON: ${String(cause)}`),
                      }),
                  ),
                )

                const metaVal = yield* Schema.decodeEffect(Schema.fromJsonString(EventMetadata))(
                  vMetadata,
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProjectionArchiveCorruptionError({
                        processorId: projection.processorId,
                        aggregateName: projection.aggregateName,
                        aggregateId: envelope.aggregateId,
                        streamVersion: ver,
                        reason: ErrorMessage.make(`Corrupt metadata JSON: ${String(cause)}`),
                      }),
                  ),
                )

                if (metaVal.aggregateId !== envelope.aggregateId || metaVal.streamVersion !== ver) {
                  return yield* new ProjectionArchiveCorruptionError({
                    processorId: projection.processorId,
                    aggregateName: projection.aggregateName,
                    aggregateId: envelope.aggregateId,
                    streamVersion: ver,
                    reason: ErrorMessage.make("Parked gap metadata mismatch"),
                  })
                }

                latestAppliedTimestamp = metaVal.timestamp
                yield* applyCrossProjection(projection, eventVal, metaVal)
              }

              yield* sql`
                DELETE FROM es_projection_gaps
                WHERE processor_id = ${projection.processorId}
                  AND aggregate_name = ${projection.aggregateName}
                  AND aggregate_id = ${envelope.aggregateId}
                  AND stream_version <= ${newCheckpointVersion}
              `

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
                  ${envelope.aggregateId},
                  ${newCheckpointVersion},
                  ${latestAppliedTimestamp}
                )
                ON CONFLICT (processor_id, aggregate_name, aggregate_id)
                DO UPDATE SET
                  last_stream_version = excluded.last_stream_version,
                  updated_at = excluded.updated_at
              `
            }),
          )
          .exhaustive()
      }

      return decisions
    }),
  )
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
      const rows = yield* sql<{
        aggregate_name: string
        aggregate_id: string
        stream_version: number
        event_type: string
        payload: string
        metadata: string
        archived_at: number
      }>`
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
        { lastVersion: StreamVersion; updatedAt: TimestampMs }
      >()
      const archivedEvents: Array<ArchivedEvent<Event>> = []

      for (const row of rows) {
        const aggIdOpt = Schema.decodeOption(AggregateId)(row.aggregate_id)
        const streamVerOpt = Schema.decodeOption(StreamVersion)(row.stream_version)
        const fallbackAggId = match(aggIdOpt)
          .with({ _tag: "Some" }, ({ value }) => value)
          .with({ _tag: "None" }, () => AggregateId.make("unknown-id"))
          .exhaustive()
        const fallbackStreamVer = match(streamVerOpt)
          .with({ _tag: "Some" }, ({ value }) => value)
          .with({ _tag: "None" }, () => StreamVersion.make(0))
          .exhaustive()

        const expected = expectedVersionsByAgg.get(row.aggregate_id) ?? 1

        const decoded = yield* match({ aggIdOpt, streamVerOpt })
          .with(
            { aggIdOpt: { _tag: "Some" }, streamVerOpt: { _tag: "Some" } },
            ({ aggIdOpt: { value: aggId }, streamVerOpt: { value: streamVer } }) => {
              if (streamVer !== expected) {
                return Effect.fail(
                  new ProjectionArchiveCorruptionError({
                    processorId: projection.processorId,
                    aggregateName: projection.aggregateName,
                    aggregateId: aggId,
                    streamVersion: streamVer,
                    reason: ErrorMessage.make(
                      `Non-contiguous archive stream: expected version ${expected}, got ${row.stream_version}`,
                    ),
                  }),
                )
              }
              return Effect.succeed({ aggId, streamVer })
            },
          )
          .with({ aggIdOpt: { _tag: "None" } }, () =>
            Effect.fail(
              new ProjectionArchiveCorruptionError({
                processorId: projection.processorId,
                aggregateName: projection.aggregateName,
                aggregateId: fallbackAggId,
                streamVersion: fallbackStreamVer,
                reason: ErrorMessage.make(
                  `Invalid archive aggregate_id: ${String(row.aggregate_id)}`,
                ),
              }),
            ),
          )
          .with({ streamVerOpt: { _tag: "None" } }, () =>
            Effect.fail(
              new ProjectionArchiveCorruptionError({
                processorId: projection.processorId,
                aggregateName: projection.aggregateName,
                aggregateId: fallbackAggId,
                streamVersion: fallbackStreamVer,
                reason: ErrorMessage.make(
                  `Invalid archive stream_version: ${String(row.stream_version)}`,
                ),
              }),
            ),
          )
          .exhaustive()

        const { aggId, streamVer } = decoded
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

      yield* rebuildCrossProjection(projection, archivedEvents)

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
  const checkpointMap = new Map<string, { aggregateId: AggregateId; version: StreamVersion }>()
  for (const cp of checkpoints) {
    const aggIdOpt = Schema.decodeOption(AggregateId)(cp.aggregate_id)
    const verOpt = Schema.decodeOption(StreamVersion)(cp.last_stream_version)
    const fallbackAggId = match(aggIdOpt)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => AggregateId.make("unknown-id"))
      .exhaustive()
    const fallbackVer = StreamVersion.make(0)

    const validatedCp = yield* match({ aggIdOpt, verOpt })
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
            reason: ErrorMessage.make(
              `Invalid checkpoint aggregate_id: ${String(cp.aggregate_id)}`,
            ),
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
            reason: ErrorMessage.make(
              `Invalid checkpoint last_stream_version: ${String(cp.last_stream_version)}`,
            ),
          }),
        ),
      )
      .exhaustive()

    checkpointMap.set(validatedCp.aggregateId, validatedCp)
  }

  const headMap = new Map<string, { aggregateId: AggregateId; version: StreamVersion }>()
  for (const head of archiveHeads) {
    const aggIdOpt = Schema.decodeOption(AggregateId)(head.aggregate_id)
    const verOpt =
      head.max_version !== null && head.max_version > 0
        ? Schema.decodeOption(StreamVersion)(head.max_version)
        : Option.none()
    const fallbackAggId = match(aggIdOpt)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => AggregateId.make("unknown-id"))
      .exhaustive()
    const fallbackVer = StreamVersion.make(0)

    const validatedHead = yield* match({ aggIdOpt, verOpt })
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
            reason: ErrorMessage.make(
              `Invalid archive head aggregate_id: ${String(head.aggregate_id)}`,
            ),
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
            reason: ErrorMessage.make(
              `Invalid archive head max_version: ${String(head.max_version)}`,
            ),
          }),
        ),
      )
      .exhaustive()

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

  const gapRows = yield* sql<{ aggregate_id: string; stream_version: number }>`
    SELECT aggregate_id, stream_version
    FROM es_projection_gaps
    WHERE processor_id = ${processorId}
      AND aggregate_name = ${aggregateName}
    ORDER BY aggregate_id ASC, stream_version ASC
  `

  const validatedGaps: Array<{ aggregateId: AggregateId; streamVersion: PositiveInt }> = []
  for (const gap of gapRows) {
    const aggIdOpt = Schema.decodeOption(AggregateId)(gap.aggregate_id)
    const verOpt = Schema.decodeOption(PositiveInt)(gap.stream_version)
    const fallbackAggId = match(aggIdOpt)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => AggregateId.make("unknown-id"))
      .exhaustive()
    const fallbackVer = StreamVersion.make(0)

    const validatedGap = yield* match({ aggIdOpt, verOpt })
      .with(
        { aggIdOpt: { _tag: "Some" }, verOpt: { _tag: "Some" } },
        ({ aggIdOpt: { value: aggregateId }, verOpt: { value: streamVersion } }) =>
          Effect.succeed({ aggregateId, streamVersion }),
      )
      .with({ aggIdOpt: { _tag: "None" } }, () =>
        Effect.fail(
          new ProjectionArchiveCorruptionError({
            processorId,
            aggregateName,
            aggregateId: fallbackAggId,
            streamVersion: fallbackVer,
            reason: ErrorMessage.make(`Invalid gap aggregate_id: ${String(gap.aggregate_id)}`),
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
            reason: ErrorMessage.make(`Invalid gap stream_version: ${String(gap.stream_version)}`),
          }),
        ),
      )
      .exhaustive()

    validatedGaps.push(validatedGap)
  }

  if (validatedGaps.length > 0) {
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
