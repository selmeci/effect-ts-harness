import { type Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as SqliteClientModule from "@effect/sql-sqlite-do/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import {
  aggregateCoreMigrations,
  handleAggregateCommand,
  initializeAggregateTables,
  isEventStreamUniqueConflict,
  loadAggregate,
  makeAggregateMigratorLayer,
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
  makeProjectorMigratorLayer,
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
  makeAggregateMigratorLayer,
  makeProjectorMigratorLayer,
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

export { _makeSqliteClientLayer as makeSqliteClientLayer }
