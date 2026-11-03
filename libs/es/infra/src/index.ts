import { Context, Effect, Layer } from "effect"
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
import { DEFAULT_OUTBOX_BATCH_LIMIT, drainAggregateOutbox } from "./outbox.js"
import {
  checkProjectorCatchUp,
  ingestPublishedEvent,
  initializeProjectorTables,
  PROJECTOR_MIGRATIONS_TABLE,
  projectorCoreMigrations,
  rebuildProjectorFromArchive,
} from "./projector.js"

export { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient"
export { SqliteMigrator }
export {
  aggregateCoreMigrations,
  checkProjectorCatchUp,
  DEFAULT_OUTBOX_BATCH_LIMIT,
  drainAggregateOutbox,
  handleAggregateCommand,
  ingestPublishedEvent,
  initializeAggregateTables,
  initializeProjectorTables,
  isEventStreamUniqueConflict,
  loadAggregate,
  PROJECTOR_MIGRATIONS_TABLE,
  projectorCoreMigrations,
  rebuildProjectorFromArchive,
}

const _makeSqliteClientLayer = (
  config: SqliteClientModule.SqliteClientConfig,
): Layer.Layer<SqlClient> =>
  Layer.effect(
    SqlClient,
    Effect.gen(function* () {
      const services = yield* Layer.build(SqliteClientModule.layer(config))
      return Context.get(services, SqlClient)
    }),
  )

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
