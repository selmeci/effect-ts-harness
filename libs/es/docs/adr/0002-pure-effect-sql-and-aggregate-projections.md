---
id: es:ADR-0002
title: Pure Effect SQL Engine in Infra and I/O-Free Core Protocols over Drizzle ORM
status: accepted
date: 2026-11-02
enforced_by:
  - libs/es/contract/src/index.ts
  - libs/es/core/src/index.ts
  - libs/es/core/src/decider.ts
  - libs/es/core/src/projection.ts
  - libs/es/core/src/aggregate.ts
  - libs/es/core/src/testing.ts
  - libs/es/core/test/fixtures/cart.ts
  - libs/es/infra/src/index.ts
  - libs/es/infra/src/aggregate.ts
  - libs/es/infra/src/memory.ts
  - libs/es/infra/test/fixtures/cart-sqlite.ts
spans:
  - Aggregate.handleCommand
  - Aggregate.load
  - LocalProjection.apply
  - LocalProjection.query
  - LocalProjection.rebuild
services: []
errors:
  - ConcurrencyConflictError
  - AggregateNotFoundError
  - LocalProjectionNotFoundError
  - CommandAggregateMismatchError
  - EventStreamCorruptionError
  - EventSerializationError
---

# Pure Effect SQL Engine in Infra and I/O-Free Core Protocols over Drizzle ORM

## Context and Problem Statement

In Phase 2 of the Event Sourcing MVP (`docs/mvp_event_sourcing.md`), an aggregate must append events, update local projections, ensure command idempotency via `commandId`, and rebuild local projections on version mismatch or stream drift inside a single transactional boundary within Cloudflare Durable Objects. The initial brief contemplated using Drizzle ORM (`drizzle-orm/effect-sqlite-do`) for table declarations. However, using Drizzle in an Effect v4 event sourcing architecture creates schema duplication (`sqliteTable` vs `Schema.Struct`), relies on pinned release-candidate drivers with transaction workarounds, and introduces an unnecessary ORM abstraction over an append-only event log and narrow key-value read models. Furthermore, our Nx taxonomy requires `@harness/es-core` (`type:core`) to remain 100% free of I/O, while SQL execution and `SqlClient` adapters live in `@harness/es-infra` (`type:infra`) and comply with workspace-wide `workerd` storage execution (`harness:ADR-0008` / `harness:SPEC-0006`).

## Decision Drivers

- **Single Source of Truth for Schemas:** Avoid dual-maintenance and translation overhead between Drizzle table schemas and Effect v4 `Schema` / branded domain types.
- **Strict Core vs Infra Taxonomy:** Keep `@harness/es-core` (`type:core`) completely free of `SqlClient` and SQL statements, placing all SQLite persistence in `@harness/es-infra` (`type:infra`) and isolating test runtime helpers in `@harness/es-infra/memory` in compliance with `harness:ADR-0008`.
- **Append-Only Simplicity:** The aggregate storage schema consists of narrow relational tables (`es_events`, `es_commands`, `es_projections_meta`, `es_outbox`) scoped by `(aggregate_name, aggregate_id)` requiring no relational ORM join builders.
- **Strong Consistency & Read-Your-Writes:** Local read models must be updated within the event append transaction and queried by `ProjectionName` and `AggregateId`.

## Considered Options

- **Option 1:** Drizzle ORM (`drizzle-orm/effect-sqlite-do`) with dual `sqliteTable` and `Schema` declarations.
- **Option 2:** Pure `effect/sql/SqlClient` and `@effect/sql-sqlite-do` in `@harness/es-infra` with I/O-free protocols in `@harness/es-core`, direct `Schema` decoding, and native `sql.withTransaction` boundaries.

## Decision Outcome

**Chosen option:** "Option 2: Pure `effect/sql/SqlClient` and `@effect/sql-sqlite-do` in `@harness/es-infra` with I/O-free protocols in `@harness/es-core`, direct `Schema` decoding, and native `sql.withTransaction` boundaries", because it eliminates external ORM impedance, preserves `type:core` purity, and uses Effect `Schema` as the single source of truth for both domain and persistence models.

### Binding Architectural Rules

1. **Taxonomy, Worker Entrypoint Isolation & Native `SqliteMigrator`:** `@harness/es-core` (`type:core`) defines pure protocols (`Decider`, `LocalProjection`, `AggregateConfig`) with zero `SqlClient` imports. `@harness/es-infra` (`type:infra`) implements `initializeAggregateTables`, `makeAggregateMigratorLayer`, `loadAggregate`, and `handleAggregateCommand` over `effect/sql/SqlClient` and `@effect/sql-sqlite-do/SqliteMigrator` (executing numbered migrations via `SqliteMigrator.fromRecord` inside a transaction and recording applied versions in `effect_sql_migrations`). Per `harness:ADR-0008` (`harness:SPEC-0006`), `@harness/es-infra/memory` (`libs/es/infra/src/memory.ts`) runs `@effect/sql-sqlite-do` (`makeSqliteClientLayer`) against a real `workerd` SQLite Durable Object (`enableSql: true`) spawned via `@alchemy.run/cloudflare-runtime`.
2. **Single Transactional Boundary:** Every `handleAggregateCommand` execution runs its entire read-decide-commit cycle inside `sql.withTransaction`:
   - Check `commandId` in `es_commands` and verify `(aggregate_name, aggregate_id)` ownership (failing with `CommandAggregateMismatchError` on cross-aggregate reuse).
   - Load and fold `es_events` (verifying contiguous `stream_version` starting at 1 and valid JSON payloads, failing with `EventStreamCorruptionError` on corruption) and run any required projection rebuilds.
   - Invoke `decider.decide(command, state)`.
   - Append emitted events to `es_events`, apply registered `LocalProjection` instances, and update `es_projections_meta`.
   - Append rows to `es_outbox` when `outboxMode` is `PublishOutbox` (and write zero rows when `SuppressOutbox`).
   - Record the serialized `AggregateCommandResult` in `es_commands` (including 0-event decisions, which record `NoStream` on empty streams).
3. **Exact Stored Result Deduplication:** When `commandId` is already present in `es_commands` for the same `(aggregate_name, aggregate_id)`, `handleAggregateCommand` decodes the stored `result_json` and returns the original `nextExpectedStreamVersion` and `creationStatus` (`CreatedStream`, `ExistingStream`, or `NoStream`) with `processingStatus: { _tag: "Deduplicated" }`.
4. **Versioned and Drift-Aware Local Projection Rebuild:** During `loadAggregate`, if `es_projections_meta` is missing for a non-empty stream, or `projection_version !== projection.version`, or `last_stream_version !== currentVersion`, `loadAggregate` invokes `rebuildLocalProjection`, which delegates to the concrete `projection.rebuild(aggregateId, events)` implementation to purge existing read-model rows for that `AggregateId` and replay the aggregate's historical events, and then `loadAggregate` updates `es_projections_meta` inside the transaction.
5. **Precise Concurrency Conflict Detection:** `handleAggregateCommand` inspects `SqlError.reason` via exhaustive pattern matching (`UniqueViolation` referencing `es_events`, plus `ConstraintError` / `UnknownError` fallback for `workerd` SQLite errors whose cause message contains `UNIQUE constraint failed` and `es_events`), querying `SELECT MAX(stream_version) FROM es_events` to report the true stored head as `actualVersion` before transaction rollback, while leaving all other `SqlError` failures in the error channel.

## Rejected Alternatives

### 1 · Drizzle ORM (`drizzle-orm/effect-sqlite-do`)

**Why rejected:** Drizzle requires duplicate table declarations in parallel with Effect `Schema`, requires continuous boilerplate decoding between Drizzle row types and branded domain schemas, and the pinned `1.0.0-rc.5-ab785fc` driver contains fragile workarounds for Cloudflare DO SQLite transactions. Pure `effect/sql/SqlClient` provides superior ergonomics and zero impedance mismatch.

## Consequences and Enforcement

### Positive Consequences

- Single schema definition language (`Schema.Struct`, `Schema.Class`, `Schema.brand`) across contracts, core protocols, and persistence.
- Native, transactional schema migration state tracking (`effect_sql_migrations`) in Durable Object SQLite via `@effect/sql-sqlite-do/SqliteMigrator` (`SqliteMigrator.fromRecord`, `initializeAggregateTables`, `makeAggregateMigratorLayer`).
- Strict adherence to Nx taxonomy (`type:core` has zero I/O; `type:infra` owns SQL; Worker entrypoint has zero `node:*` imports).
- Deterministic transaction rollback on conflict, domain rejection, or SQL failure.

### Negative Consequences and Trade-offs

- While migration ordering, locking, transactional execution, and state tracking (`effect_sql_migrations`) are handled natively by `@effect/sql-sqlite-do/SqliteMigrator`, individual migration steps (`1_init_es_core_tables`, etc.) are authored as numbered `SqlClient` Effects rather than auto-diffed from an ORM table DSL via `drizzle-kit generate`.
- Read model queries in projections are written as parameterized SQL templates over `SqlClient`.

### Deterministic Enforcement

| Rule                               | Enforced By                                                                   | Gate / Mechanism                                          | Governed Symbols                            |
| ---------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| Command Idempotency Dedup          | `libs/es/infra/src/aggregate.ts`                                              | `handleAggregateCommand`                                  | `Aggregate.handleCommand`                   |
| Cross-Aggregate Command Guard      | `libs/es/contract/src/index.ts`, `libs/es/infra/src/aggregate.ts`             | `CommandAggregateMismatchError`, `handleAggregateCommand` | `CommandAggregateMismatchError`             |
| Stream Contiguity & Decode Guard   | `libs/es/contract/src/index.ts`, `libs/es/infra/src/aggregate.ts`             | `EventStreamCorruptionError`, `loadAggregate`             | `EventStreamCorruptionError`                |
| Read-Your-Writes Query             | `libs/es/core/src/projection.ts`                                              | `queryLocalProjection`                                    | `LocalProjection.query`                     |
| Versioned Projection Rebuild       | `libs/es/core/src/projection.ts`, `libs/es/infra/src/aggregate.ts`            | `rebuildLocalProjection`, `loadAggregate`                 | `LocalProjection.rebuild`, `Aggregate.load` |
| Selective Outbox Isolation         | `libs/es/contract/src/index.ts`, `libs/es/infra/src/aggregate.ts`             | `OutboxPublicationMode`, `handleAggregateCommand`         | `Aggregate.handleCommand`                   |
| Concurrency Conflict Detection     | `libs/es/contract/src/index.ts`, `libs/es/infra/src/aggregate.ts`             | `ConcurrencyConflictError`, `handleAggregateCommand`      | `ConcurrencyConflictError`                  |
| Missing Aggregate Query            | `libs/es/contract/src/index.ts`, `libs/es/infra/test/fixtures/cart-sqlite.ts` | `AggregateNotFoundError`, `queryCartView`                 | `AggregateNotFoundError`                    |
| Missing Local Projection           | `libs/es/contract/src/index.ts`, `libs/es/core/src/projection.ts`             | `LocalProjectionNotFoundError`, `queryLocalProjection`    | `LocalProjectionNotFoundError`              |
| Event & Result Serialization Guard | `libs/es/contract/src/index.ts`, `libs/es/infra/src/aggregate.ts`             | `EventSerializationError`, `handleAggregateCommand`       | `EventSerializationError`                   |
