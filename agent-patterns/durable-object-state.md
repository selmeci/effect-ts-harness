# Durable Object State and Synchronous Transactions

Durable Object state is managed with native `@effect/sql-sqlite-do` (`SqliteClient` / `SqlClient.SqlClient` + `SqliteMigrator`), executing synchronous SQLite transactions. **`drizzle-orm` and `drizzle-kit` are banned across the workspace.**

## Embedded SQLite in Cloudflare Durable Objects

Cloudflare Durable Objects provide dedicated, strongly-consistent embedded SQLite storage. In this codebase, DO queries, migrations, and transactions use `@effect/sql-sqlite-do` (`SqliteClient.layer({ db: state.storage.sql })` and `SqliteMigrator.layer(...)`) with `SqlClient.SqlClient`.

## Synchronous Transactions on `MixedScheduler("sync")`

Cloudflare DO SQLite transactions must execute synchronously. Any asynchronous yields or microtask pauses between transactional statements will cause Cloudflare to release locks or abort the transaction.

Effect handles this using `Scheduler.MixedScheduler("sync")`:

```ts
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { CartItemSchema, type CartItemInput } from "@sample/contract/cart"

export const addItemToCart = (input: CartItemInput) =>
  Effect.gen(function* () {
    // CRITICAL: Decode and validate schemas BEFORE entering withTransaction
    const validatedItem = yield* Schema.decodeUnknownEffect(CartItemSchema)(input)

    const sql = yield* SqlClient.SqlClient

    // Execute transaction synchronously without interleaving microtasks
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO cart_items (id, name, quantity)
          VALUES (${validatedItem.id}, ${validatedItem.name}, ${validatedItem.quantity})
        `
        return validatedItem
      }),
    )
  })
```

## Golden Rules for DO Transactions

1. **Pre-Validate Input**: Always decode parameters and contract Schemas **before** calling `sql.withTransaction`. Never decode untrusted input or perform asynchronous network I/O inside a transaction block.
2. **Encapsulate SQL & Migrations in `type:infra`**: All `@effect/sql-sqlite-do` queries and `SqliteMigrator` definitions belong exclusively in `type:infra`.
3. **DO Migrations (`@effect/sql-sqlite-do/SqliteMigrator`)**: Because each Durable Object instance owns an isolated embedded SQLite database initialized lazily on first activation, run migrations via `SqliteMigrator.run` or `SqliteMigrator.layer` using `SqliteMigrator.fromRecord({ "1_init_tables": ... })` (which tracks applied versions in `effect_sql_migrations` inside `storage.transaction()`).
