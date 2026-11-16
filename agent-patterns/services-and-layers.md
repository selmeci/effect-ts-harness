# Services and Layers

`Context.Service` defines service interfaces and tags in Effect v4, while `Layer` manages dependency injection, resource lifetimes, and environment composition across the 5-tier hexagonal architecture (`1. type:contract` $\rightarrow$ `2. type:service` $\rightarrow$ `3. type:core / type:domain` $\rightarrow$ `4. type:infra` $\rightarrow$ `5. type:app`).

## `Context.Service` in Effect v4 (`type:service` Port Purity)

In Effect v4, define a service capability port in `type:service` (`libs/<scope>/service/src/**`) by extending `Context.Service`. Pass the service class as the first type parameter and the service interface as the second.

> [!IMPORTANT]
> **5-Tier Hexagonal Port Purity (`HarnessTierTopology.decide` — `impure-service-tier-import`):**
> `type:service` packages (`libs/<scope>/service/src/**`) declare pure `Context.Service` interfaces only (importing `effect`, `type:contract`, and `type:service`). Never construct `Layer.*` (`Layer.effect`, `Layer.succeed`, `Layer.effectDiscard`) or import `node:*` / `type:core` / `type:domain` / `type:infra` inside `type:service` source files! Place live `Layer` implementations in `type:infra` (`libs/<scope>/infra/src/**`) and test `Layer`s in `test/`.

```ts
// Illustrative — Tier 1: type:contract (e.g. libs/<scope>/contract/src/index.ts)
import { Schema } from "effect"

export const SqlQueryText = Schema.NonEmptyString.pipe(Schema.brand("SqlQueryText"))
export type SqlQueryText = typeof SqlQueryText.Type

export const ErrorMessage = Schema.NonEmptyString.pipe(Schema.brand("ErrorMessage"))
export type ErrorMessage = typeof ErrorMessage.Type

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  message: ErrorMessage,
}) {}

// Illustrative — Tier 2: type:service (e.g. libs/<scope>/service/src/index.ts — pure port only)
import { Context, Effect } from "effect"

export interface DatabaseService {
  readonly query: (sql: SqlQueryText) => Effect.Effect<ReadonlyArray<unknown>, DatabaseError>
}

export class Database extends Context.Service<Database, DatabaseService>()("myapp/Database") {}

// Access the service interface type when needed
export type DatabaseInstance = Database["Service"]
```

```ts
// Illustrative — Tier 4: type:infra (e.g. libs/<scope>/infra/src/index.ts — live Layer implementation)
import { Effect, Layer } from "effect"

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

## Consuming Services in Domain or Core Code

Domain (`type:domain`) and core (`type:core`) functions require services in their environment channel `R` by yielding the service class and passing branded contract arguments:

```ts
// Illustrative — Tier 3: type:domain / type:core (e.g. libs/<scope>/domain/src/index.ts)
import { Effect } from "effect"

export const getItems = Effect.fn("Items.getItems")(function* (sql: SqlQueryText) {
  const db = yield* Database
  const rows = yield* db.query(sql)
  return rows
})
```

## Layer Constructors (`Layer.effect` & `Layer.succeed`)

> [!NOTE]
> **Effect v4 Migration (`Layer.scoped` removed):** In Effect v4, `Layer.scoped` was merged into `Layer.effect` (`repos/effect/migration/v3-to-v4.md`). `Layer.effect` natively accepts both non-scoped effects and scoped effects that acquire resources via `Effect.acquireRelease` or `Effect.addFinalizer`.

- **`Layer.effect` (Effectful or Scoped Construction in `type:infra`):** Creates a layer from an effectful constructor or a scoped resource lifecycle:

  ```ts
  // Illustrative — Tier 4: type:infra
  import { Effect, Layer } from "effect"

  export const ManagedPoolLive = Layer.effect(
    Database,
    Effect.gen(function* () {
      const _pool = yield* Effect.acquireRelease(Effect.succeed({ open: true }), () =>
        Effect.logInfo("Closing connection pool..."),
      )
      return Database.of({ query: (_sql) => Effect.succeed([]) })
    }),
  )
  ```

- **`Layer.succeed` (Static / In-Memory Test Layers in `test/`):** Creates a layer from a pure, static value without effects:

  ```ts
  // Illustrative — test layer in test/
  import { Effect, Layer } from "effect"

  export const DatabaseTest = Layer.succeed(
    Database,
    Database.of({
      query: (_sql) => Effect.succeed([{ id: 42, name: "Mocked" }]),
    }),
  )
  ```

## Layer Composition

Compose `*Live` layers from `type:infra` together at the application boundary (`type:app`):

```ts
// Illustrative — Tier 5: type:app composition root
import { Layer } from "effect"

// Layer.provide: provides dependencies to a consumer layer
export const AppLayer = ServiceLayer.pipe(Layer.provide(DatabaseLive), Layer.provide(ConfigLive))

// Layer.merge: combines two layers side-by-side into a single layer providing both
export const SharedServices = Layer.merge(DatabaseLive, CacheLive)

// Layer.provideMerge: provides dependencies while keeping them exposed in the output
export const ComposedWithDeps = ServiceLayer.pipe(Layer.provideMerge(DatabaseLive))
```

## Architectural Guidelines (`HarnessTierTopology.decide` & `SelfDogfooding.decide`)

- **Single Canonical `type:*` Tag (`dual-contract-tier-tag`):** Every workspace package declares exactly one `type:*` Nx tag (`type:contract`, `type:service`, `type:core`, `type:domain`, `type:infra`, or `type:app`).
- **Pure Service Ports (`impure-service-tier-import`):** Service definitions live in `type:service` libraries with zero `Layer.*` constructors and zero `node:*` imports.
- **Live Layers in `type:infra` (`no-layer-build-in-layer-effect`):** Live implementations and infrastructure wiring live in `type:infra` libraries. Never invoke `Layer.build` inside `Layer.effect` (`no-layer-build-in-layer-effect`); compose dependencies with `Layer.provide` / `Layer.provideMerge` or `Layer.effect`.
- **Explicit Barrel Exports (`facade-star-reexport`):** All `libs/**/src/index.ts` and `apps/**/src/index.ts` barrels must use explicit named exports (`export { ... } from "..."`), never `export * from "..."`.
- **Domain & Core Purity:** Domain logic (`type:domain`) and generic engines (`type:core`) depend on service interfaces via `R`, never directly on concrete implementations, `node:*` I/O built-ins (`no-node-builtins-outside-infra`), `process.env` (`process-env-outside-infra-or-app`), or database drivers.
- **No zero-argument `() => Effect` or `() => Layer` thunks (`effect(lazyEffect)` / `TS377091`):** `Effect` and `Layer` are already lazy blueprints. If a `Context.Service` member takes zero arguments, declare it as `readonly listAll: Effect.Effect<ReadonlyArray<Item>>` (not `() => Effect.Effect<...>`), and export parameterless layers as `export const MyLayer: Layer.Layer<...>` constants.
