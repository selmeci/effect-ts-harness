---
id: es:SPEC-0002
title: Event Sourcing Aggregate Engine, Local Projections, and Command Idempotency
status: accepted
archetype: framework
date: 2026-11-02
adrs:
  - es:ADR-0002
  - harness:ADR-0008
enforced_by:
  - libs/es/contract/src/index.ts
  - libs/es/core/src/index.ts
  - libs/es/core/src/projection.ts
  - libs/es/core/src/aggregate.ts
  - libs/es/core/src/decider.ts
  - libs/es/core/src/testing.ts
  - libs/es/core/test/fixtures/cart.ts
  - libs/es/infra/src/index.ts
  - libs/es/infra/src/aggregate.ts
  - libs/es/infra/src/memory.ts
  - libs/es/infra/src/workerd-scripts.ts
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

# Event Sourcing Aggregate Engine, Local Projections, and Command Idempotency

## Context

Phase 1 of `effect-es` established the pure Decider pattern and its BDD test harness with zero environmental dependencies (`R = never`). Phase 2 introduces stateful aggregate coordination and strongly-consistent local read models over `effect/sql/SqlClient` in `@harness/es-infra` while keeping `@harness/es-core` (`type:core`) 100% free of I/O:

- **Reused Contracts / Primitives:** `StreamVersion`, `PositiveInt`, `Decider` interface, `makeDeciderTestHarness`.
- **Reused Services:** `effect/sql/SqlClient`.
- **New Capabilities Needed:** Branded contract schemas (`CommandId`, `AggregateId`, `AggregateName`, `ProjectionName`, `ProjectionVersion`, `TimestampMs`), closed discriminated unions (`StreamCreationStatus`, `CommandProcessingStatus`, `OutboxPublicationMode`), `EventMetadata`, `AggregateCommandResult`, pure `LocalProjection` and `AggregateConfig` protocols in `@harness/es-core`, and transactional SQLite aggregate execution (`loadAggregate`, `handleAggregateCommand`, `initializeAggregateTables`) in `@harness/es-infra`.

## Goal

Provide a type-safe, generic aggregate engine and local projection framework executing over `effect/sql/SqlClient` in `@harness/es-infra` that guarantees command idempotency with preserved stored results, single-transaction event-and-projection updates, read-your-writes local queries, and automatic stream-replay rebuilds on projection version mismatches or stream drift.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (**When**, **While**, **If ... then**, **Where**) and the modal **shall** or **shall not**.

### Verification Column Mapping Rules

The `Verification` column in the EARS table maps each requirement to its deterministic enforcement mechanism:

- **`UnitTest`:** Dynamic runtime assertions in `@effect/vitest` for command handling, idempotency caching, queries, error boundaries, and versioned rebuilds.
- **`GraphCheck`:** Static type-channel invariants and trace span validation enforced by `checkEffectGraph` and `OntologyInvariants.decide`.

## Requirements

### 1 · Command Idempotency and Deduplication

**Source (docs/mvp_event_sourcing.md Phase 2):** Commands must carry a unique `commandId` scoped to `(aggregateName, aggregateId)` so duplicate requests return the stored result without repeating business decisions.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                             | Effect Symbol                 | Verification |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------ |
| REQ-1.1 | Unwanted behaviour | **If** a command with a commandId that has already been executed for the same aggregateName and aggregateId is submitted, **then** Aggregate.handleCommand **shall** decode the stored result_json and return the cached creationStatus and nextExpectedStreamVersion with Deduplicated processingStatus without invoking decider.decide or appending duplicate events. | Aggregate.handleCommand       | UnitTest     |
| REQ-1.2 | Event-driven       | **When** a new command with an unseen commandId is executed, Aggregate.handleCommand **shall** atomically record the commandId, aggregateName, aggregateId, streamVersion, and serialized result_json in the es_commands table.                                                                                                                                         | Aggregate.handleCommand       | UnitTest     |
| REQ-1.3 | Unwanted behaviour | **If** a command reuses a commandId that was already recorded for a different aggregateName or aggregateId, **then** Aggregate.handleCommand **shall** fail with CommandAggregateMismatchError.                                                                                                                                                                         | CommandAggregateMismatchError | UnitTest     |

### 2 · Atomic Transactional Append and Local Projections

**Source (docs/mvp_event_sourcing.md Phase 2):** Idempotency checks, decisions, events, projection updates, and outbox rows must commit inside a single SQLite transaction.

| ID      | Pattern      | Requirement                                                                                                                                                                                                   | Effect Symbol           | Verification |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------ |
| REQ-2.1 | Event-driven | **When** a command decision produces domain events, Aggregate.handleCommand **shall** append events to es_events and apply each event to all registered local projections inside a single atomic transaction. | Aggregate.handleCommand | UnitTest     |
| REQ-2.2 | Event-driven | **When** a domain event is committed, LocalProjection.apply **shall** synchronously update the local projection read model tables keyed by metadata.aggregateId.                                              | LocalProjection.apply   | UnitTest     |
| REQ-2.3 | Event-driven | **When** a query is issued for a registered projectionName and aggregateId, LocalProjection.query **shall** return the current read model reflecting all previously committed commands.                       | LocalProjection.query   | UnitTest     |

### 3 · Versioned and Drift-Aware Projection Rebuild

**Source (docs/mvp_event_sourcing.md Phase 2):** Local projections must rebuild from the aggregate's own event stream when their schema version mismatches or their recorded stream version lags behind the stream head.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                           | Effect Symbol           | Verification |
| ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------ |
| REQ-3.1 | Event-driven | **When** Aggregate.load activates an aggregate whose projection metadata in es_projections_meta is missing for a non-empty stream or has a projection_version or last_stream_version different from the current projection version and stream head, Aggregate.load **shall** replay the aggregate event stream through LocalProjection.rebuild and update es_projections_meta inside the transaction. | Aggregate.load          | UnitTest     |
| REQ-3.2 | Event-driven | **When** LocalProjection.rebuild is invoked for an aggregateId, LocalProjection.rebuild **shall** purge existing projection data for that aggregateId and replay historical events to produce a state identical to incremental updates.                                                                                                                                                               | LocalProjection.rebuild | UnitTest     |

### 4 · Selective Outbox Publication

**Source (docs/mvp_event_sourcing.md Phase 2):** Aggregates configured with `SuppressOutbox` must never write outbox rows.

| ID      | Pattern      | Requirement                                                                                                                                                                                                | Effect Symbol           | Verification |
| ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------ |
| REQ-4.1 | Event-driven | **When** an aggregate configured with SuppressOutbox handles a command, Aggregate.handleCommand **shall** write zero rows to the es_outbox table.                                                          | Aggregate.handleCommand | UnitTest     |
| REQ-4.2 | Event-driven | **When** an aggregate configured with PublishOutbox handles a command emitting events, Aggregate.handleCommand **shall** append emitted events to the es_outbox table within the event commit transaction. | Aggregate.handleCommand | UnitTest     |

### 5 · Error Boundaries and Concurrency Safety

**Source (docs/mvp_event_sourcing.md Phase 2):** Error handling for concurrency conflicts, stream corruption, missing aggregates, and unknown projections.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                              | Effect Symbol                | Verification |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------ |
| REQ-5.1 | Unwanted behaviour | **If** an event append to es_events triggers a unique stream_version constraint conflict, **then** Aggregate.handleCommand **shall** roll back the transaction and fail with ConcurrencyConflictError reporting the stored stream head as actualVersion. | ConcurrencyConflictError     | UnitTest     |
| REQ-5.2 | Unwanted behaviour | **If** a query targets an aggregateId with no recorded projection data, **then** LocalProjection.query **shall** fail with AggregateNotFoundError.                                                                                                       | AggregateNotFoundError       | UnitTest     |
| REQ-5.3 | Unwanted behaviour | **If** a query specifies an unregistered projection name, **then** LocalProjection.query **shall** fail with LocalProjectionNotFoundError.                                                                                                               | LocalProjectionNotFoundError | UnitTest     |
| REQ-5.4 | Unwanted behaviour | **If** stored event rows have non-contiguous stream_version numbers or invalid JSON payloads, **then** Aggregate.load **shall** fail with EventStreamCorruptionError.                                                                                    | EventStreamCorruptionError   | UnitTest     |
| REQ-5.5 | Unwanted behaviour | **If** encoding a newly emitted event, metadata, or command result fails before persistence, **then** Aggregate.handleCommand **shall** roll back the transaction and fail with EventSerializationError preserving the schema failure reason.            | EventSerializationError      | UnitTest     |

## Assumptions

- **REQ-1.1:** Deduplicated commands decode `es_commands.result_json` and preserve the original `creationStatus` (`CreatedStream`, `ExistingStream`, or `NoStream`) and `nextExpectedStreamVersion` with `processingStatus: { _tag: "Deduplicated" }`.
- **REQ-2.1:** Events within an aggregate stream are ordered sequentially by `streamVersion` incrementing strictly by 1 starting from 1, and local test layers (`@harness/es-infra/memory`) comply with `harness:SPEC-0006` (`harness:ADR-0008`) by executing against real `workerd` SQLite Durable Object storage (`enableSql: true`) via `@alchemy.run/cloudflare-runtime`.
- **REQ-4.1:** `outboxMode` is a required `OutboxPublicationMode` field on `AggregateConfig`.

## Out of scope

- **Cross-aggregate queue workers and D1 archive:** Deferred to Phase 3.
- **HttpApi routing and OpenAPI schema evolution:** Deferred to Phase 4.
- **Multi-aggregate process managers:** Deferred to Phase 5.

## Known residual risks

- Long streams in single aggregates may increase activation time during replay; snapshotting is planned post-MVP.

## Acceptance criteria

- All requirement rows pass declared verification methods (`UnitTest`, `GraphCheck`).
- Zero policy violations reported by `harness gc --strict`.
- Plan topology verified by `harness plan-check`.
