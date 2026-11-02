# Services and Layers

Context.Service defines service interfaces and tags in Effect v4, while Layer manages dependency injection, resource lifetimes, and environment composition.

## Context.Service in Effect v4

In Effect v4, the standard way to define a service capability is to extend `Context.Service`. Pass the service class as the first type parameter and the service interface as the second:

```ts
import { Context, Effect, Layer, Schema } from "effect"

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  message: Schema.String,
}) {}

export interface DatabaseService {
  readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>, DatabaseError>
}

export class Database extends Context.Service<Database, DatabaseService>()("myapp/Database") {
  // Static layer providing the default or live implementation
  static readonly Live = Layer.effect(
    Database,
    Effect.gen(function* () {
      const query = Effect.fn("Database.query")(function* (sql: string) {
        yield* Effect.logInfo(`Executing SQL: ${sql}`)
        return [{ id: 1, name: "Sample Item" }]
      })

      return Database.of({ query })
    }),
  )
}

// Access the service interface type when needed
export type DatabaseInstance = Database["Service"]
```

## Consuming Services in Domain Code

Domain functions require services in their environment channel `R` by yielding the service class:

```ts
import { Effect } from "effect"
import { Database } from "service/database"

export const getItems = Effect.fn("Items.getItems")(function* () {
  const db = yield* Database
  const rows = yield* db.query("SELECT * FROM items")
  return rows
})
```

## Layer Constructors

Layers construct and manage the lifecycle of services:

- **`Layer.effect`**: Creates a layer from an effectful constructor.

  ```ts
  export const DatabaseLive = Layer.effect(
    Database,
    Effect.gen(function* () {
      yield* Effect.log("Initializing database connection...")
      return Database.of({ query: (sql) => Effect.succeed([]) })
    }),
  )
  ```

- **`Layer.succeed`**: Creates a layer from a pure, static value without effects.

  ```ts
  export const DatabaseTest = Layer.succeed(
    Database,
    Database.of({
      query: (_sql) => Effect.succeed([{ id: 42, name: "Mocked" }]),
    }),
  )
  ```

- **`Layer.scoped`**: Creates a layer from an effect requiring a `Scope`. Useful for resources with acquisition and release steps.
  ```ts
  export const ManagedPoolLive = Layer.scoped(
    Database,
    Effect.gen(function* () {
      const pool = yield* Effect.acquireRelease(Effect.succeed({ open: true }), (pool) =>
        Effect.log("Closing connection pool..."),
      )
      return Database.of({ query: () => Effect.succeed([]) })
    }),
  )
  ```

## Layer Composition

Compose layers together to build your application's dependency graph:

```ts
import { Layer } from "effect"

// Layer.provide: provides dependencies to a consumer layer
export const AppLayer = ServiceLayer.pipe(Layer.provide(Database.Live), Layer.provide(Config.Live))

// Layer.merge: combines two layers side-by-side into a single layer providing both
export const SharedServices = Layer.merge(Database.Live, Cache.Live)

// Layer.provideMerge: provides dependencies while keeping them exposed in the output
export const ComposedWithDeps = ServiceLayer.pipe(Layer.provideMerge(Database.Live))
```

## Architectural Guidelines

- Service definitions live in `type:service` libraries.
- Live implementations and infrastructure wiring live in `type:infra` libraries.
- Domain logic (`type:domain`) depends on service interfaces via `R`, never directly on concrete implementations or database drivers.
- **No zero-argument `() => Effect` or `() => Layer` thunks (`effect(lazyEffect)` / `TS377091`):** `Effect` and `Layer` are already lazy blueprints. If a `Context.Service` member takes zero arguments, declare it as `readonly listAll: Effect.Effect<ReadonlyArray<Item>>` (not `() => Effect.Effect<...>`), and export parameterless layers as `export const MyLayer: Layer.Layer<...>` constants.
