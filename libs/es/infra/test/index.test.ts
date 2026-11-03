import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import {
  aggregateCoreMigrations,
  initializeAggregateTables,
  makeAggregateMigratorLayer,
  SqliteMigrator,
} from "../src/index.js"
import { SqlClientMemoryLayer } from "../src/memory.js"
import { initCartViewTable } from "./fixtures/cart-sqlite.js"

describe("@harness/es-infra", () => {
  it.effect(
    "runs and tracks aggregate and projection SQLite migrations via SqliteMigrator (effect_sql_migrations)",
    () =>
      Effect.gen(function* () {
        expect(Object.keys(aggregateCoreMigrations)).toEqual(["1_init_es_core_tables"])
        expect(typeof SqliteMigrator.fromRecord).toBe("function")

        // 1. Initial run applies migration 1_init_es_core_tables
        const firstRun = yield* initializeAggregateTables()
        expect(firstRun).toEqual([[1, "init_es_core_tables"]])

        const sql = yield* SqlClient
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC;
        `
        const tableNames = (tables as Array<{ readonly name: string }>).map((t) => t.name)
        expect(tableNames).toContain("effect_sql_migrations")
        expect(tableNames).toContain("es_events")
        expect(tableNames).toContain("es_commands")
        expect(tableNames).toContain("es_projections_meta")
        expect(tableNames).toContain("es_outbox")

        // 2. Adding migration 2_init_cart_view applies only the pending migration #2
        const secondRun = yield* initializeAggregateTables({
          "2_init_cart_view": initCartViewTable,
        })
        expect(secondRun).toEqual([[2, "init_cart_view"]])

        // 3. Re-running with identical migrations is a no-op because effect_sql_migrations tracks applied IDs
        const thirdRun = yield* initializeAggregateTables({
          "2_init_cart_view": initCartViewTable,
        })
        expect(thirdRun).toEqual([])

        const recordedMigrations = yield* sql<{
          readonly migration_id: number
          readonly name: string
        }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC;
        `
        expect(recordedMigrations).toEqual([
          { migration_id: 1, name: "init_es_core_tables" },
          { migration_id: 2, name: "init_cart_view" },
        ])
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )

  it.effect("makeAggregateMigratorLayer executes migrations during Layer construction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const recordedMigrations = yield* sql<{
        readonly migration_id: number
        readonly name: string
      }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC;
      `
      expect(recordedMigrations).toEqual([
        { migration_id: 1, name: "init_es_core_tables" },
        { migration_id: 2, name: "init_cart_view" },
      ])
    }).pipe(
      Effect.provide(
        makeAggregateMigratorLayer({
          "2_init_cart_view": initCartViewTable,
        }).pipe(Layer.provideMerge(SqlClientMemoryLayer)),
      ),
    ),
  )

  it.effect(
    "enforces real workerd DO SQLite authorizer (rejects raw BEGIN) while supporting nested storage.transaction savepoints",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        const sql = yield* SqlClient

        // Real workerd SQLite DO authorizer forbids raw BEGIN TRANSACTION statements
        const rawBeginErr = yield* Effect.flip(sql`BEGIN TRANSACTION`)
        expect(String(rawBeginErr.reason.cause)).toContain("state.storage.transaction()")

        // Real workerd storage.transaction supports nested savepoint rollbacks
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO es_outbox (aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, created_at)
              VALUES ('Cart', 'agg-1', 1, 'Created', '{}', '{}', 1000)
            `
            const innerErr = yield* Effect.flip(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`
                    INSERT INTO es_outbox (aggregate_name, aggregate_id, stream_version, event_type, payload, metadata, created_at)
                    VALUES ('Cart', 'agg-1', 2, 'Updated', '{}', '{}', 1001)
                  `
                  return yield* Effect.fail("rollback-inner")
                }),
              ),
            )
            expect(innerErr).toBe("rollback-inner")
          }),
        )

        const rows = yield* sql`SELECT stream_version FROM es_outbox ORDER BY stream_version ASC`
        const versions = (rows as Array<{ readonly stream_version: number }>).map(
          (r) => r.stream_version,
        )
        expect(versions).toEqual([1])
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )
})
