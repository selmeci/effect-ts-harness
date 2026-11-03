# Durable Object State and Synchronous Transactions

Durable Object state is managed with drizzle-orm/effect-sqlite-do on @effect/sql-sqlite-do, executing synchronous SQLite transactions.

## Embedded SQLite in Cloudflare Durable Objects

Cloudflare Durable Objects provide dedicated, strongly-consistent embedded SQLite storage. In this codebase, DO queries and transactions use `drizzle-orm/effect-sqlite-do` on top of `@effect/sql-sqlite-do`.

## Synchronous Transactions on `MixedScheduler("sync")`

Cloudflare DO SQLite transactions must execute synchronously. Any asynchronous yields or microtask pauses between transactional statements will cause Cloudflare to release locks or abort the transaction.

Effect handles this using `Scheduler.MixedScheduler("sync")`:

```ts
import { Effect, Schema } from "effect"
import { drizzle } from "drizzle-orm/effect-sqlite-do"
import { cartItemsTable } from "./schema/cart.js"
import { CartItemSchema, CartItemInput } from "contract/cart"

export const addItemToCart = (input: CartItemInput) =>
  Effect.gen(function* () {
    // CRITICAL: Decode and validate schemas BEFORE entering withTransaction
    const validatedItem = yield* Schema.decodeUnknownEffect(CartItemSchema)(input)

    const db = yield* DurableObjectDrizzle

    // Execute transaction synchronously without interleaving microtasks
    return yield* db.withTransaction(
      Effect.gen(function* () {
        yield* db.insert(cartItemsTable).values({
          id: validatedItem.id,
          name: validatedItem.name,
          quantity: validatedItem.quantity,
        })
        return validatedItem
      }),
    )
  })
```

## Golden Rules for DO Transactions

1. **Pre-Validate Input**: Always decode parameters and contract Schemas **before** calling `withTransaction`. Never decode untrusted input or perform asynchronous network I/O inside a transaction block.
2. **Encapsulate Tables in `type:infra`**: Table definitions for Durable Objects belong exclusively in `type:infra`.
3. **DO Migrations**: Embedded SQLite migrations in Durable Objects run sequentially during DO instantiation or upgrade using committed SQL migration scripts.
