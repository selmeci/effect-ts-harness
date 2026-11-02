---
id: es:ADR-0002
title: Pure Effect SQL Engine and Local Projection Storage over Drizzle ORM
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
  - tools/oxlint/syntax-bans.js
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
---

# Pure Effect SQL Engine and Local Projection Storage over Drizzle ORM

## Context and Problem Statement

In Phase 2 of the Event Sourcing MVP (`docs/mvp_event_sourcing.md`), an aggregate must append events, update local projections, ensure command idempotency via `commandId`, and rebuild local projections on version mismatch inside a single transactional boundary within Cloudflare Durable Objects. The initial brief contemplated using Drizzle ORM (`drizzle-orm/effect-sqlite-do`) for table declarations. However, using Drizzle in an Effect v4 event sourcing architecture creates schema duplication (`sqliteTable` vs `Schema.Struct`), relies on pinned release-candidate drivers with transaction workarounds, and introduces an unnecessary ORM abstraction over what is essentially an append-only event log and narrow key-value read models. We must decide the persistence and query abstraction for aggregates and local projections.

## Decision Drivers

* **Single Source of Truth for Schemas:** Avoid dual-maintenance and translation overhead between Drizzle table schemas and Effect v4 `Schema` / branded domain types.
* **Native Effect v4 Runtime & Fiber Integration:** Ensure transactional execution uses native Effect Fiber context, `Scope`, and `MixedScheduler("sync")` without driver-level monkey patching.
* **Append-Only Simplicity:** The aggregate storage schema consists of narrow relational tables (`events`, `commands`, `projections_meta`, `outbox`) requiring no relational ORM mapping or join builders.
* **Strong Consistency & Read-Your-Writes:** Local read models must be updated within the event append transaction and queried with type-safe schema decoding.

## Considered Options

* **Option 1:** Drizzle ORM (`drizzle-orm/effect-sqlite-do`) with dual `sqliteTable` and `Schema` declarations.
* **Option 2:** Pure `@effect/sql` and `@effect/sql-sqlite-do` with direct `Schema` decoding and native `SqlClient` transactions.

## Decision Outcome

**Chosen option:** "Option 2: Pure `@effect/sql` and `@effect/sql-sqlite-do` with direct `Schema` decoding and native `SqlClient` transactions", because it eliminates external ORM impedance, uses Effect `Schema` as the single source of truth for both domain and persistence models, integrates natively with Effect v4 Fiber schedulers, and avoids pinning outdated Drizzle release candidates.

### Binding Architectural Rules

1. **Native Effect SQL Protocol:** Aggregate persistence and local projections must interact with SQLite via `@effect/sql` (`SqlClient.SqlClient`), using parameterized SQL statements and `Schema` decoders. Drizzle ORM dependencies are eliminated from `libs/es`.
2. **Transactional Boundary:** Every command execution that yields non-empty events must atomically:
   - Verify `commandId` idempotency against the `commands` table.
   - Append serialized events with incremental `streamVersion` and metadata into `events`.
   - Execute `apply` on every registered `LocalProjection` synchronously.
   - Insert rows into `outbox` if and only if `publish` is enabled on the aggregate.
   - Record the `commandId` and execution result in `commands`.
3. **Idempotent Deduplication:** A command whose `commandId` is already present in `commands` must return the previously computed result without re-invoking `decide` or appending duplicate events.
4. **Versioned Local Projection Rebuild:** On aggregate activation (`loadAggregate`), if a projection's recorded version in `projections_meta` does not match its current code version, the projection tables must be wiped and rebuilt by replaying the aggregate's full event stream.
5. **Selective Outbox Publishing:** Aggregates configured with `publish: false` (or without cross-aggregate subscribers) must never write rows to the `outbox` table.

## Rejected Alternatives

### 1 · Drizzle ORM (`drizzle-orm/effect-sqlite-do`)

**Why rejected:** Drizzle requires duplicate table declarations in parallel with Effect `Schema`, requires continuous boilerplate decoding between Drizzle row types and branded domain schemas, and the pinned `1.0.0-rc.5-ab785fc` driver contains fragile workarounds for Cloudflare DO SQLite transactions. Pure `@effect/sql` provides superior ergonomics and zero impedance mismatch.

## Consequences and Enforcement

### Positive Consequences

* Single schema definition language (`Schema.Struct`, `Schema.Class`, `Schema.brand`) across contracts, domain, and persistence.
* Zero external ORM dependency overhead; smaller bundle sizes in Cloudflare Workers and Durable Objects.
* Robust transactional execution with native Effect `withTransaction` and `PreventSchedulerYield`.
* Transparent testability with in-memory SQLite (`node:sqlite`) using the same `SqlClient` interface.

### Negative Consequences and Trade-offs

* Schema migrations for aggregate tables must be managed via SQL DDL scripts rather than Drizzle Kit automated migrations.
* Complex queries across tables (if ever needed in projections) must be written as raw SQL templates rather than fluent ORM method chains.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Command Idempotency Dedup | `libs/es/core/src/aggregate.ts` | `handleAggregateCommand` | `Aggregate.handleCommand` |
| Read-Your-Writes Query | `libs/es/core/src/projection.ts` | `queryLocalProjection` | `LocalProjection.query` |
| Versioned Projection Rebuild | `libs/es/core/src/projection.ts`, `libs/es/core/src/aggregate.ts` | `rebuildLocalProjection`, `loadAggregate` | `LocalProjection.rebuild`, `Aggregate.load` |
| Selective Outbox Isolation | `libs/es/core/src/aggregate.ts` | `handleAggregateCommand` | `Aggregate.handleCommand` |
| Concurrency Conflict Detection | `libs/es/contract/src/index.ts`, `libs/es/core/src/aggregate.ts` | `ConcurrencyConflictError`, `handleAggregateCommand` | `ConcurrencyConflictError` |
| Missing Aggregate Query | `libs/es/contract/src/index.ts`, `libs/es/core/src/projection.ts` | `AggregateNotFoundError`, `queryLocalProjection` | `AggregateNotFoundError` |
| Missing Local Projection | `libs/es/contract/src/index.ts`, `libs/es/core/src/projection.ts` | `LocalProjectionNotFoundError`, `queryLocalProjection` | `LocalProjectionNotFoundError` |
