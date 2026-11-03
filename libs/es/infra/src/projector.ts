import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import { stub } from "@harness/gates"
import type {
  AggregateName,
  ProcessorId,
  ProjectionArchiveCorruptionError,
  ProjectionCatchUpStatus,
  ProjectionSequenceDecision,
  PublishedEventEnvelope,
} from "@harness/es-contract"
import type { CrossAggregateProjection } from "@harness/es-core"

export const projectorCoreMigrations: Readonly<
  Record<string, Effect.Effect<void, SqlError, SqlClient>>
> = {
  "2_init_es_projector_tables": Effect.gen(function* () {
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
  return yield* stub<
    ReadonlyArray<readonly [number, string]>,
    SqliteMigrator.MigrationError | SqlError,
    SqlClient
  >(additionalMigrations, SqliteMigrator.fromRecord)
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
  return yield* stub<
    ReadonlyArray<ProjectionSequenceDecision>,
    ProjectionArchiveCorruptionError | ProjErr | SqlError,
    SqlClient | ProjEnv
  >(envelope, projections)
})

export const rebuildProjectorFromArchive = Effect.fn("Projector.rebuild")(function* <
  Event,
  ReadModel,
  QueryInput = void,
  ProjEnv = never,
  ProjErr = never,
>(projection: CrossAggregateProjection<Event, ReadModel, QueryInput, ProjEnv, ProjErr>) {
  return yield* stub<
    void,
    ProjectionArchiveCorruptionError | ProjErr | SqlError,
    SqlClient | ProjEnv
  >(projection)
})

export const checkProjectorCatchUp = Effect.fn("Projector.checkCatchUp")(function* (
  processorId: ProcessorId,
  aggregateName: AggregateName,
) {
  return yield* stub<
    ProjectionCatchUpStatus,
    ProjectionArchiveCorruptionError | SqlError,
    SqlClient
  >(processorId, aggregateName)
})
