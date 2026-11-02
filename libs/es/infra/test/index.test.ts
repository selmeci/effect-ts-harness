import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { initializeAggregateTables, SqlClientMemoryLayer } from "../src/index.js"

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
})
