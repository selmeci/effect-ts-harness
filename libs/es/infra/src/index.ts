import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as SqliteClientModule from "@effect/sql-sqlite-do/SqliteClient"

export { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient"
export {
  handleAggregateCommand,
  initializeAggregateTables,
  isEventStreamUniqueConflict,
  loadAggregate
} from "./aggregate.js"

const _makeSqliteClientLayer = (
  config: SqliteClientModule.SqliteClientConfig
): Layer.Layer<SqlClient> =>
  Layer.effect(
    SqlClient,
    Effect.gen(function* () {
      const services = yield* Layer.build(SqliteClientModule.layer(config))
      return Context.get(services, SqlClient)
    })
  )

export { _makeSqliteClientLayer as makeSqliteClientLayer }
