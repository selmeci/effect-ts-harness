import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as SqliteClientModule from "@effect/sql-sqlite-do/SqliteClient"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import type {
  DurableObjectStorage,
  DurableObjectTransaction,
  SqlStorage,
  SqlStorageCursor,
  SqlStorageValue
} from "@cloudflare/workers-types"

export { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient"

const unsafeCast = <T>(value: unknown): T => value as T

class MockCursor<T extends Record<string, SqlStorageValue>> {
  private idx = 0
  readonly rowsRead: number
  readonly rowsWritten: number
  readonly columnNames: Array<string>

  constructor(
    private readonly rows: ReadonlyArray<T>,
    columnNames: Array<string>
  ) {
    this.columnNames = columnNames
    this.rowsRead = rows.length
    this.rowsWritten = 0
  }

  next(): IteratorResult<T, undefined> {
    if (this.idx < this.rows.length) {
      const value = this.rows[this.idx++]
      if (value !== undefined) {
        return { done: false, value }
      }
    }
    return { done: true, value: undefined }
  }

  toArray(): Array<T> {
    return [...this.rows]
  }

  one(): T {
    const first = this.rows[0]
    if (first !== undefined) {
      return first
    }
    return Object.create(null)
  }

  *raw<U extends Array<SqlStorageValue>>(): IterableIterator<U> {
    for (const row of this.rows) {
      yield Object.values(row) as U
    }
  }

  *[Symbol.iterator](): IterableIterator<T> {
    yield* this.rows
  }
}

class MockStatement {}

const createMemorySqlStorage = (sqlite: DatabaseSync): SqlStorage => {
  const storage: SqlStorage = {
    databaseSize: 0,
    Cursor: unsafeCast<SqlStorage["Cursor"]>(MockCursor),
    Statement: unsafeCast<SqlStorage["Statement"]>(MockStatement),
    exec<T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: ReadonlyArray<unknown>
    ): SqlStorageCursor<T> {
      const stmt = sqlite.prepare(query) as StatementSync
      const nodeBindings = bindings.map((b) =>
        b instanceof ArrayBuffer ? new Uint8Array(b) : b
      ) as ReadonlyArray<number | string | bigint | null | Uint8Array>
      const rows = stmt.all(...nodeBindings) as Array<T>
      const colNames = rows.length > 0 && rows[0] !== undefined ? Object.keys(rows[0]) : []
      return unsafeCast<SqlStorageCursor<T>>(new MockCursor<T>(rows, colNames))
    }
  }
  return storage
}
const createMemoryDurableObjectStorage = (sqlite: DatabaseSync): DurableObjectStorage => {
  const sql = createMemorySqlStorage(sqlite)
  const doStorage = {
    sql,
    transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
      let rolledBack = false
      const txn = {
        rollback() {
          rolledBack = true
          sqlite.exec("ROLLBACK")
        }
      }

      sqlite.exec("BEGIN")
      return Promise.resolve()
        .then(() => closure(unsafeCast<DurableObjectTransaction>(txn)))
        .then(
          (result) => {
            if (!rolledBack) {
              sqlite.exec("COMMIT")
            }
            return result
          },
          (err: unknown) => {
            if (!rolledBack) {
              sqlite.exec("ROLLBACK")
            }
            return Promise.reject(err)
          }
        )
    }
  }
  return unsafeCast<DurableObjectStorage>(doStorage)
}

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

export const SqlClientMemoryLayer: Layer.Layer<SqlClient> = Layer.effect(
  SqlClient,
  Effect.gen(function* () {
    const sqlite = new DatabaseSync(":memory:")
    const storage = createMemoryDurableObjectStorage(sqlite)
    const services = yield* Layer.build(SqliteClientModule.layer({ storage }))
    return Context.get(services, SqlClient)
  })
)

export const initializeAggregateTables = Effect.fn("AggregateInfra.initTables")(
  function* () {
    const sql = yield* SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aggregate_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        command_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(aggregate_id, stream_version)
      );
    `
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_commands (
        command_id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_projections_meta (
        aggregate_id TEXT NOT NULL,
        projection_name TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        last_stream_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (aggregate_id, projection_name)
      );
    `
    yield* sql`
      CREATE TABLE IF NOT EXISTS es_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aggregate_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `
  }
)

export {
  _makeSqliteClientLayer as makeSqliteClientLayer
}
