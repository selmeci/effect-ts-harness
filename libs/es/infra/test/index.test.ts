import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { initializeAggregateTables } from "../src/index.js"
import { SqlClientMemoryLayer } from "../src/memory.js"

describe("@harness/es-infra", () => {
  it.effect("initializes aggregate SQLite tables using SqlClientMemoryLayer", () =>
    Effect.gen(function* () {
      yield* initializeAggregateTables()
      const sql = yield* SqlClient

      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC;
      `
      const tableNames = (tables as Array<{ readonly name: string }>).map((t) => t.name)
      expect(tableNames).toContain("es_events")
      expect(tableNames).toContain("es_commands")
      expect(tableNames).toContain("es_projections_meta")
      expect(tableNames).toContain("es_outbox")
    }).pipe(Effect.provide(SqlClientMemoryLayer))
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
                })
              )
            )
            expect(innerErr).toBe("rollback-inner")
          })
        )

        const rows = yield* sql`SELECT stream_version FROM es_outbox ORDER BY stream_version ASC`
        const versions = (rows as Array<{ readonly stream_version: number }>).map(
          (r) => r.stream_version
        )
        expect(versions).toEqual([1])
      }).pipe(Effect.provide(SqlClientMemoryLayer))
  )
})
