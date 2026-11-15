# Durable Object State and Synchronous Transactions

Durable Object state is managed with native `@effect/sql-sqlite-do` (`@effect/sql-sqlite-do/SqliteClient` + `@effect/sql-sqlite-do/SqliteMigrator` + `SqlClient`), executing synchronous SQLite operations under `Scheduler.MixedScheduler("sync")`. **`drizzle-orm` and `drizzle-kit` are banned across the workspace.**

## Embedded SQLite in Cloudflare Durable Objects

Cloudflare Durable Objects provide dedicated, strongly-consistent embedded SQLite storage. In this codebase, DO queries, migrations, and transactions use `@effect/sql-sqlite-do/SqliteClient` (`SqliteClient.layer({ db: state.storage.sql })`) and `@effect/sql-sqlite-do/SqliteMigrator` (`SqliteMigrator.fromRecord(albumCounterMigrations)`), providing `AlbumCounterDoLayer` over `SqlClient` (`effect/sql/SqlClient`).

## Synchronous Transactions on `MixedScheduler("sync")`

Cloudflare DO SQLite transactions must execute synchronously. Any asynchronous yields or microtask pauses between transactional statements will cause Cloudflare to release locks or abort the transaction.

Effect handles this using `Scheduler.MixedScheduler("sync")`, decoding schemas outside the synchronous boundary:

```ts
import { Effect, Scheduler, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import { type AlbumId, AlbumPhotoCount, IncrementAlbumCount } from "@harness/sample-contract"
import { decideAlbumQuota } from "@harness/sample-domain"

export const albumCounterMigrations = {
  "1_init_album_counters": Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS album_counters (
        album_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      )
    `
  }),
}

export const incrementAlbumWithSyncScheduler = (rawInput: unknown) =>
  Effect.gen(function* () {
    // CRITICAL: Decode and validate schemas BEFORE entering MixedScheduler("sync")
    const payload = yield* Schema.decodeUnknownEffect(IncrementAlbumCount.payloadSchema)(rawInput)

    // Execute store + decide synchronously without interleaving microtasks
    return yield* Effect.gen(function* () {
      const currentCount = yield* store.get(payload.albumId)
      yield* decideAlbumQuota({ albumId: payload.albumId, currentCount })
      return yield* store.incrementWithQuota(payload.albumId)
    }).pipe(Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")))
  })
```

## Golden Rules for DO Transactions

1. **Pre-Validate Input**: Always decode parameters and contract Schemas **before** entering `Scheduler.MixedScheduler("sync")` or `sql.withTransaction`. Never decode untrusted input or perform asynchronous network I/O inside a synchronous transaction block.
2. **Encapsulate SQL & Migrations in `type:infra`**: All `@effect/sql-sqlite-do` queries (`AlbumCounterDoLayer`) and `SqliteMigrator` definitions belong exclusively in `type:infra`.
3. **DO Migrations (`@effect/sql-sqlite-do/SqliteMigrator`)**: Because each Durable Object instance owns an isolated embedded SQLite database initialized lazily on first activation, run migrations via `SqliteMigrator.run` or `SqliteMigrator.layer` using `SqliteMigrator.fromRecord(albumCounterMigrations)` with numbered `<positive_int>_<lowercase_snake_case>` keys (e.g. `"1_init_album_counters"`, which tracks applied versions in `effect_sql_migrations` inside `storage.transaction()`).
