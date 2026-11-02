---
id: es:SPEC-0002
title: Event Sourcing Aggregate Engine, Local Projections, and Command Idempotency
status: accepted
archetype: framework
date: 2026-11-02
adrs:
  - es:ADR-0002
enforced_by:
  - libs/es/contract/src/index.ts
  - libs/es/core/src/index.ts
  - libs/es/core/src/projection.ts
  - libs/es/core/src/aggregate.ts
  - libs/es/core/src/decider.ts
  - libs/es/core/src/testing.ts
  - libs/es/core/test/fixtures/cart.ts
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

# Event Sourcing Aggregate Engine, Local Projections, and Command Idempotency

## Context

Phase 1 of `effect-es` established the pure Decider pattern and its BDD test harness with zero environmental dependencies (`R = never`). Phase 2 introduces stateful aggregate coordination and strongly-consistent local read models within embedded SQLite storage:
- **Reused Contracts / Primitives:** `StreamVersion`, `PositiveInt`, `Decider` interface, `makeDeciderTestHarness`.
- **Reused Services:** `@effect/sql/SqlClient`.
- **New Capabilities Needed:** Branded contract schemas (`CommandId`, `AggregateId`, `ProjectionName`, `ProjectionVersion`, `TimestampMs`), `EventMetadata`, `AggregateCommandResult`, `LocalProjection` protocol, and `Aggregate` coordinator managing command idempotency, atomic transactional event appends, local projection application, outbox filtering, and versioned rebuilds.

## Goal

Provide a type-safe, generic aggregate engine and local projection framework executing over `@effect/sql` that guarantees command idempotency, atomic event-and-projection updates, read-your-writes local queries, and automatic stream-replay rebuilds on projection version bumps.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (**When**, **While**, **If ... then**, **Where**) and the modal **shall** or **shall not**.

### Verification Column Mapping Rules

The `Verification` column in the EARS table maps each requirement to its deterministic enforcement mechanism:
- **`UnitTest`:** Dynamic runtime assertions in `@effect/vitest` for command handling, idempotency caching, queries, and versioned rebuilds.
- **`GraphCheck`:** Static type-channel invariants and trace span validation enforced by `checkEffectGraph` and `OntologyInvariants.decide`.

## Requirements

### 1 · Command Idempotency and Deduplication

**Source (docs/mvp_event_sourcing.md Phase 2):** Commands must carry a unique `commandId` so duplicate requests are safely deduplicated without repeating business decisions.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Unwanted behaviour | **If** a command with a commandId that has already been executed is submitted, **then** Aggregate.handleCommand **shall** return the cached result without invoking decider.decide or appending duplicate events. | Aggregate.handleCommand | UnitTest |
| REQ-1.2 | Event-driven | **When** a new command with an unseen commandId is executed, Aggregate.handleCommand **shall** record the commandId, aggregateId, and outcome in the commands table. | Aggregate.handleCommand | UnitTest |

### 2 · Atomic Transactional Append and Local Projections

**Source (docs/mvp_event_sourcing.md Phase 2):** Events, projection updates, and outbox rows must commit inside a single SQLite transaction.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-2.1 | Event-driven | **When** a command decision produces domain events, Aggregate.handleCommand **shall** write events to the event stream and apply each event to all registered local projections in a single atomic transaction. | Aggregate.handleCommand | UnitTest |
| REQ-2.2 | Event-driven | **When** a domain event is committed, LocalProjection.apply **shall** synchronously update the local projection read model tables. | LocalProjection.apply | UnitTest |
| REQ-2.3 | Event-driven | **When** a query is issued for an aggregateId, LocalProjection.query **shall** return the current read model reflecting all previously committed commands. | LocalProjection.query | UnitTest |

### 3 · Versioned Projection Rebuild

**Source (docs/mvp_event_sourcing.md Phase 2):** Local projections must rebuild from the aggregate's own event stream when their schema version is bumped.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-3.1 | Event-driven | **When** Aggregate.load activates an aggregate with a projection whose stored version is lower than its declared version, Aggregate.load **shall** replay the aggregate event stream through LocalProjection.rebuild and update the projection version metadata. | Aggregate.load | UnitTest |
| REQ-3.2 | Event-driven | **When** LocalProjection.rebuild is invoked, LocalProjection.rebuild **shall** purge existing projection data and replay historical events to produce a state identical to incremental updates. | LocalProjection.rebuild | UnitTest |

### 4 · Selective Outbox Publication

**Source (docs/mvp_event_sourcing.md Phase 2):** Aggregates without cross-aggregate subscribers must never write outbox rows.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-4.1 | Event-driven | **When** an aggregate configured with publish disabled handles a command, Aggregate.handleCommand **shall** write zero rows to the outbox table. | Aggregate.handleCommand | UnitTest |
| REQ-4.2 | Event-driven | **When** an aggregate configured with publish enabled handles a command emitting events, Aggregate.handleCommand **shall** append emitted events to the outbox table within the event commit transaction. | Aggregate.handleCommand | UnitTest |

### 5 · Error Boundaries and Concurrency Safety

**Source (docs/mvp_event_sourcing.md Phase 2):** Error handling for concurrency conflicts, missing aggregates, and unknown projections.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-5.1 | Unwanted behaviour | **If** an event append detects a stream version conflict against expectedVersion, **then** Aggregate.handleCommand **shall** fail with ConcurrencyConflictError. | ConcurrencyConflictError | UnitTest |
| REQ-5.2 | Unwanted behaviour | **If** a query targets an aggregateId with no recorded stream or projection data, **then** LocalProjection.query **shall** fail with AggregateNotFoundError. | AggregateNotFoundError | UnitTest |
| REQ-5.3 | Unwanted behaviour | **If** a query specifies an unregistered projection name, **then** LocalProjection.query **shall** fail with LocalProjectionNotFoundError. | LocalProjectionNotFoundError | UnitTest |

## Assumptions
* **REQ-1.1:** Deduplicated commands return the original `AggregateCommandResult` with `processingStatus: { _tag: "Deduplicated" }`.
* **REQ-2.1:** Events within an aggregate stream are ordered sequentially by `streamVersion` incrementing by 1.
* **REQ-4.1:** The default configuration for `publish` on an aggregate is `false`.

## Out of scope
* **Cross-aggregate queue workers and D1 archive:** Deferred to Phase 3.
* **HttpApi routing and OpenAPI schema evolution:** Deferred to Phase 4.
* **Multi-aggregate process managers:** Deferred to Phase 5.

## Known residual risks
* Long streams in single aggregates may increase activation time during replay; snapshotting is planned post-MVP.

## Acceptance criteria
* All requirement rows pass declared verification methods (`UnitTest`, `GraphCheck`).
* Zero policy violations reported by `harness gc --strict`.
* Plan topology verified by `harness plan-check`.
