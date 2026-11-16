# Services and Layers

Context.Service defines service interfaces and tags in Effect v4, while Layer manages dependency injection, resource lifetimes, and environment composition.

## Context.Service in Effect v4 (`type:service` Port Purity)

In Effect v4, the standard way to define a service capability port in `type:service` (`libs/*/service/src/**`) is to extend `Context.Service`. Pass the service class as the first type parameter and the service interface as the second.

> [!IMPORTANT]
> **5-Tier Hexagonal Port Purity (`HarnessTierTopology.decide` — `impure-service-tier-import`):**
> `type:service` packages (`libs/*/service/src/**`) declare pure `Context.Service` interfaces only (importing `effect`, `type:contract`, and `type:service`). Never construct `Layer.*` (`Layer.effect`, `Layer.succeed`, `Layer.scoped`) or import `node:*` / `type:core` / `type:domain` / `type:infra` inside `type:service` source files! Place live `Layer` implementations in `type:infra` (`libs/*/infra/src/**`) and test `Layer`s in `test/`.

```ts
// In libs/sample/service/src/database.ts (type:service — pure port only)
import { Context, Effect } from "effect"
import { DatabaseError, SqlQueryText } from "@harness/sample-contract"

export interface DatabaseService {
  readonly query: (sql: SqlQueryText) => Effect.Effect<ReadonlyArray<unknown>, DatabaseError>
}

export class Database extends Context.Service<Database, DatabaseService>()("myapp/Database") {}

// Access the service interface type when needed
export type DatabaseInstance = Database["Service"]
```

```ts
// In libs/sample/infra/src/database-live.ts (type:infra — live Layer implementation)
import { Effect, Layer } from "effect"
import { SqlQueryText } from "@harness/sample-contract"
import { Database } from "@harness/sample-service"

export const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const query = Effect.fn("Database.query")(function* (sql: SqlQueryText) {
      yield* Effect.logInfo(`Executing SQL: ${sql}`)
      return [{ id: 1, name: "Sample Item" }]
    })

    return Database.of({ query })
  }),
)
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

## Architectural Guidelines (`HarnessTierTopology.decide` & `SelfDogfooding.decide`)

- **Single Canonical `type:*` Tag (`dual-contract-tier-tag`):** Every workspace package declares exactly one `type:*` Nx tag (`type:contract`, `type:service`, `type:core`, `type:domain`, `type:infra`, or `type:app`).
- **Pure Service Ports (`impure-service-tier-import`):** Service definitions live in `type:service` libraries with zero `Layer.*` constructors and zero `node:*` imports.
- **Live Layers in `type:infra` (`no-layer-build-in-layer-effect`):** Live implementations and infrastructure wiring live in `type:infra` libraries. Never invoke `Layer.build` inside `Layer.effect` (`no-layer-build-in-layer-effect`); compose dependencies with `Layer.provide` / `Layer.provideMerge` or `Layer.scoped`.
- **Explicit Barrel Exports (`facade-star-reexport`):** All `libs/**/src/index.ts` and `apps/**/src/index.ts` barrels must use explicit named exports (`export { ... } from "..."`), never `export * from "..."`.
- **Domain & Core Purity:** Domain logic (`type:domain`) and generic engines (`type:core`) depend on service interfaces via `R`, never directly on concrete implementations, `node:*` I/O built-ins (`no-node-builtins-outside-infra`), `process.env` (`process-env-outside-infra-or-app`), or database drivers.
- **No zero-argument `() => Effect` or `() => Layer` thunks (`effect(lazyEffect)` / `TS377091`):** `Effect` and `Layer` are already lazy blueprints. If a `Context.Service` member takes zero arguments, declare it as `readonly listAll: Effect.Effect<ReadonlyArray<Item>>` (not `() => Effect.Effect<...>`), and export parameterless layers as `export const MyLayer: Layer.Layer<...>` constants.
