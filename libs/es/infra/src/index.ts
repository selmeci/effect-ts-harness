import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import * as SqliteClientModule from "@effect/sql-sqlite-do/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import {
  aggregateCoreMigrations,
  handleAggregateCommand,
  initializeAggregateTables,
  isEventStreamUniqueConflict,
  loadAggregate,
} from "./aggregate.js"
import {
  executeAggregateCommandAndSync,
  queryAggregateReadModel,
  queryCrossAggregateReadModel,
  seedAggregateStream,
} from "./http.js"
import { DEFAULT_OUTBOX_BATCH_LIMIT, drainAggregateOutbox, relayAggregateOutbox } from "./outbox.js"
import {
  ingestPublishedEvent,
  initializeProjectorTables,
  PROJECTOR_MIGRATIONS_TABLE,
  projectorCoreMigrations,
} from "./projector.js"
import { checkProjectorCatchUp, rebuildProjectorFromArchive } from "./projector-rebuild.js"

export { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient"
export { SqliteMigrator }
export {
  aggregateCoreMigrations,
  checkProjectorCatchUp,
  DEFAULT_OUTBOX_BATCH_LIMIT,
  drainAggregateOutbox,
  executeAggregateCommandAndSync,
  handleAggregateCommand,
  ingestPublishedEvent,
  initializeAggregateTables,
  initializeProjectorTables,
  isEventStreamUniqueConflict,
  loadAggregate,
  PROJECTOR_MIGRATIONS_TABLE,
  projectorCoreMigrations,
  queryAggregateReadModel,
  queryCrossAggregateReadModel,
  rebuildProjectorFromArchive,
  relayAggregateOutbox,
  seedAggregateStream,
}

const _makeSqliteClientLayer = (
  config: SqliteClientModule.SqliteClientConfig,
): Layer.Layer<SqlClient> => SqliteClientModule.layer(config)

const _makeAggregateMigratorLayer = (
  additionalMigrations?: Readonly<Record<string, Effect.Effect<void, SqlError, SqlClient>>>,
): Layer.Layer<never, SqliteMigrator.MigrationError | SqlError, SqlClient> =>
  SqliteMigrator.layer({
    loader: SqliteMigrator.fromRecord({
      ...aggregateCoreMigrations,
      ...additionalMigrations,
    }),
  })

const _makeProjectorMigratorLayer = (
  additionalMigrations?: Readonly<Record<string, Effect.Effect<void, SqlError, SqlClient>>>,
): Layer.Layer<never, SqliteMigrator.MigrationError | SqlError, SqlClient> =>
  SqliteMigrator.layer({
    loader: SqliteMigrator.fromRecord({
      ...projectorCoreMigrations,
      ...additionalMigrations,
    }),
    table: PROJECTOR_MIGRATIONS_TABLE,
  })

export {
  _makeAggregateMigratorLayer as makeAggregateMigratorLayer,
  _makeProjectorMigratorLayer as makeProjectorMigratorLayer,
  _makeSqliteClientLayer as makeSqliteClientLayer,
}
