import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import {
  type AggregateName,
  ErrorMessage,
  EventMetadata,
  PositiveInt,
  ProcessorId,
  ProjectionArchiveCorruptionError,
  type ProjectionSequenceDecision,
  type PublishedEventEnvelope,
  StreamVersion,
  type TimestampMs,
} from "@harness/es-contract"
import {
  applyCrossProjection,
  type CrossAggregateProjection,
  decideProjectionSequence,
} from "@harness/es-core"
import { match } from "ts-pattern"
import { checkProjectorCatchUp, rebuildProjectorFromArchive } from "./projector-rebuild.js"

export { checkProjectorCatchUp, rebuildProjectorFromArchive }

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

interface GapRow {
  readonly stream_version: number
  readonly payload: string
  readonly metadata: string
}

const decodeJsonOrCorrupt = <A, I>(
  schema: Schema.Codec<A, I>,
  raw: string,
  processorId: ProcessorId,
  aggregateName: AggregateName,
  aggregateId: import("@harness/es-contract").AggregateId,
  streamVersion: StreamVersion,
  prefix: string,
) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectionArchiveCorruptionError({
          processorId,
          aggregateName,
          aggregateId,
          streamVersion,
          reason: ErrorMessage.make(`${prefix}: ${String(cause)}`),
        }),
    ),
  )

const validateEnvelopeForProjections = <Event, ReadModel, QueryInput, ProjEnv, ProjErr>(
  envelope: PublishedEventEnvelope,
  projections: ReadonlyArray<
    CrossAggregateProjection<Event, ReadModel, QueryInput, ProjEnv, ProjErr>
  >,
  defaultProcessorId: ProcessorId,
) =>
  Effect.gen(function* () {
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

    yield* decodeJsonOrCorrupt(
      Schema.Unknown,
      envelope.payload,
      defaultProcessorId,
      envelope.aggregateName,
      envelope.aggregateId,
      envelope.streamVersion,
      "Invalid payload JSON in envelope",
    )

    for (const projection of projections) {
      if (projection.aggregateName === envelope.aggregateName) {
        yield* decodeJsonOrCorrupt(
          projection.eventSchema,
          envelope.payload,
          projection.processorId,
          envelope.aggregateName,
          envelope.aggregateId,
          envelope.streamVersion,
          "Payload does not match projection eventSchema",
        )
      }
    }

    return yield* Schema.encodeEffect(Schema.fromJsonString(EventMetadata))(envelope.metadata).pipe(
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
  })

const upsertEventArchiveRow = (
  envelope: PublishedEventEnvelope,
  metadataJson: string,
  defaultProcessorId: ProcessorId,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
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
          aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, archived_at
        ) VALUES (
          ${envelope.aggregateName}, ${envelope.aggregateId}, ${envelope.streamVersion}, ${envelope.metadata.commandId}, ${envelope.eventType}, ${envelope.payload}, ${metadataJson}, ${envelope.metadata.timestamp}
        )
      `
    }
  })

const loadSerializedEventForVersion = <Event, ReadModel, QueryInput, ProjEnv, ProjErr>(
  projection: CrossAggregateProjection<Event, ReadModel, QueryInput, ProjEnv, ProjErr>,
  envelope: PublishedEventEnvelope,
  metadataJson: string,
  gapRows: ReadonlyArray<GapRow>,
  ver: StreamVersion,
) =>
  Effect.gen(function* () {
    if (ver === envelope.streamVersion) {
      return { payload: envelope.payload, metadata: metadataJson }
    }
    const matchedGap = gapRows.find((g) => g.stream_version === ver)
    if (matchedGap !== undefined) {
      return { payload: matchedGap.payload, metadata: matchedGap.metadata }
    }
    const sql = yield* SqlClient
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
    return { payload: archRow.payload, metadata: archRow.metadata }
  })

const applyContiguousEventsForProjection = <Event, ReadModel, QueryInput, ProjEnv, ProjErr>(
  projection: CrossAggregateProjection<Event, ReadModel, QueryInput, ProjEnv, ProjErr>,
  envelope: PublishedEventEnvelope,
  metadataJson: string,
  gapRows: ReadonlyArray<GapRow>,
  versionsToApply: ReadonlyArray<StreamVersion>,
  newCheckpointVersion: StreamVersion,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    let latestAppliedTimestamp: TimestampMs = envelope.metadata.timestamp

    for (const ver of versionsToApply) {
      const serialized = yield* loadSerializedEventForVersion(
        projection,
        envelope,
        metadataJson,
        gapRows,
        ver,
      )

      const eventVal = yield* decodeJsonOrCorrupt(
        projection.eventSchema,
        serialized.payload,
        projection.processorId,
        projection.aggregateName,
        envelope.aggregateId,
        ver,
        "Corrupt event JSON",
      )

      const metaVal = yield* decodeJsonOrCorrupt(
        EventMetadata,
        serialized.metadata,
        projection.processorId,
        projection.aggregateName,
        envelope.aggregateId,
        ver,
        "Corrupt metadata JSON",
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
        processor_id, aggregate_name, aggregate_id, last_stream_version, updated_at
      ) VALUES (
        ${projection.processorId}, ${projection.aggregateName}, ${envelope.aggregateId}, ${newCheckpointVersion}, ${latestAppliedTimestamp}
      )
      ON CONFLICT (processor_id, aggregate_name, aggregate_id)
      DO UPDATE SET
        last_stream_version = excluded.last_stream_version,
        updated_at = excluded.updated_at
    `
  })

const loadCheckpointAndGaps = (
  processorId: ProcessorId,
  aggregateName: AggregateName,
  aggregateId: import("@harness/es-contract").AggregateId,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const checkpointRows = yield* sql<{ last_stream_version: number }>`
      SELECT last_stream_version
      FROM es_projection_checkpoints
      WHERE processor_id = ${processorId}
        AND aggregate_name = ${aggregateName}
        AND aggregate_id = ${aggregateId}
    `
    const firstCp = checkpointRows[0]
    const checkpointVersion =
      firstCp !== undefined
        ? yield* match(Schema.decodeOption(StreamVersion)(firstCp.last_stream_version))
            .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
            .with({ _tag: "None" }, () =>
              Effect.fail(
                new ProjectionArchiveCorruptionError({
                  processorId,
                  aggregateName,
                  aggregateId,
                  streamVersion: StreamVersion.make(0),
                  reason: ErrorMessage.make(
                    `Invalid checkpoint last_stream_version: ${String(firstCp.last_stream_version)}`,
                  ),
                }),
              ),
            )
            .exhaustive()
        : StreamVersion.make(0)

    const gapRows = yield* sql<GapRow>`
      SELECT stream_version, payload, metadata
      FROM es_projection_gaps
      WHERE processor_id = ${processorId}
        AND aggregate_name = ${aggregateName}
        AND aggregate_id = ${aggregateId}
      ORDER BY stream_version ASC
    `
    const parkedVersions: Array<StreamVersion> = []
    for (const r of gapRows) {
      const streamVer = yield* match(Schema.decodeOption(PositiveInt)(r.stream_version))
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(StreamVersion.make(value)))
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new ProjectionArchiveCorruptionError({
              processorId,
              aggregateName,
              aggregateId,
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

    return { checkpointVersion, gapRows, parkedVersions }
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

  const metadataJson = yield* validateEnvelopeForProjections(
    envelope,
    projections,
    defaultProcessorId,
  )

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* upsertEventArchiveRow(envelope, metadataJson, defaultProcessorId)

      const decisions: Array<ProjectionSequenceDecision> = []

      for (const projection of projections) {
        if (projection.aggregateName !== envelope.aggregateName) {
          continue
        }

        const { checkpointVersion, gapRows, parkedVersions } = yield* loadCheckpointAndGaps(
          projection.processorId,
          projection.aggregateName,
          envelope.aggregateId,
        )

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
                processor_id, aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, parked_at
              ) VALUES (
                ${projection.processorId}, ${projection.aggregateName}, ${envelope.aggregateId}, ${envelope.streamVersion}, ${envelope.eventType}, ${envelope.payload}, ${metadataJson}, ${envelope.metadata.timestamp}
              )
              ON CONFLICT (processor_id, aggregate_name, aggregate_id, stream_version) DO NOTHING
            `.pipe(Effect.asVoid),
          )
          .with({ _tag: "ApplyContiguousEvents" }, ({ versionsToApply, newCheckpointVersion }) =>
            applyContiguousEventsForProjection(
              projection,
              envelope,
              metadataJson,
              gapRows,
              versionsToApply,
              newCheckpointVersion,
            ),
          )
          .exhaustive()
      }

      return decisions
    }),
  )
})
