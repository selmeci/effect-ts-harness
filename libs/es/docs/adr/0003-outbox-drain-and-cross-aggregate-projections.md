---
id: es:ADR-0003
title: At-Least-Once Outbox Draining, Pure Sequence Decider, and Archive-Backed Cross-Aggregate Projections
status: accepted
date: 2026-11-03
enforced_by:
  - libs/es/contract/src/index.ts
  - libs/es/core/src/index.ts
  - libs/es/core/src/projection.ts
  - libs/es/core/src/outbox.ts
  - libs/es/infra/src/index.ts
  - libs/es/infra/src/outbox.ts
  - libs/es/infra/src/projector.ts
  - libs/es/infra/test/fixtures/cart-sqlite.ts
spans:
  - ProjectionSequence.decide
  - CrossProjection.apply
  - CrossProjection.query
  - CrossProjection.rebuild
  - Outbox.drain
  - ProjectorInfra.initTables
  - Projector.ingest
  - Projector.rebuild
  - Projector.checkCatchUp
services: []
errors:
  - OutboxPublishError
  - ProjectionArchiveCorruptionError
  - CrossProjectionNotFoundError
  - EventStreamCorruptionError
---

# At-Least-Once Outbox Draining, Pure Sequence Decider, and Archive-Backed Cross-Aggregate Projections

## Context and Problem Statement

In Phase 3 of the Event Sourcing MVP (`docs/mvp_event_sourcing.md`), aggregates with `PublishOutbox` enabled write events to their local `es_outbox` table inside the command commit transaction, and those events must be propagated asynchronously to a cross-aggregate projector store (D1 / SQLite) to serve multi-aggregate queries. Because Durable Objects and D1 do not share distributed transactions, publishing directly to a queue inside the command handler risks dual-write inconsistency, while delivering messages over a queue introduces duplicate deliveries, mid-batch alarm crashes, and out-of-order arrival of stream versions.

If outbox draining deletes rows before publishing or swallows bus errors, events are lost permanently when an alarm crashes. Conversely, if the projector applies events blindly without per-aggregate stream version checkpoints and gap parking, duplicate deliveries double-count read model quantities and out-of-order deliveries corrupt state transitions. Furthermore, when a cross-aggregate projection schema evolves or a new projection is added, it cannot replay individual Durable Object databases directly and requires a canonical `es_event_archive` table in the projector store.

## Decision Drivers

- **At-Least-Once Outbox Delivery Without Event Loss:** Outbox rows must remain in `es_outbox` until `EventBus.publish` succeeds for each row so that mid-drain failures or Durable Object restarts redeliver every unacknowledged event.
- **Pure Sequencing Logic (`R = never`):** Deciding whether an incoming event is a duplicate (`SkipDuplicateEvent`), an out-of-order gap (`ParkOutOfOrderEvent`), or a contiguous sequence that unblocks parked versions (`ApplyContiguousEvents`) must be a pure, property-tested decider (`ProjectionSequence.decide`) in `@harness/es-core`.
- **Atomic Checkpoint, Gap Parking, and Archive Persistence:** Every `Projector.ingest` execution must record the event in `es_event_archive` and update `es_projection_checkpoints`, `es_projection_gaps`, and the projection read model within a single `sql.withTransaction` boundary.
- **Deterministic Archive Rebuild and Non-Sleep Catch-Up:** Rebuilding a cross-aggregate projection from `es_event_archive` (`Projector.rebuild`) must produce the exact same read model rows and checkpoints as live ingestion, and tests must verify catch-up via `Projector.checkCatchUp` instead of timing sleeps.

## Considered Options

- **Option 1:** Direct inline queue publishing inside `Aggregate.handleCommand` with stateless, uncheckpointed D1 consumers.
- **Option 2:** At-least-once `Outbox.drain` with per-row ack deletion (outside a wrapping transaction across external bus I/O), pure `ProjectionSequence.decide` sequencing in `@harness/es-core`, and transactional `Projector.ingest` / `Projector.rebuild` over `es_event_archive`, `es_projection_checkpoints`, and `es_projection_gaps` in `@harness/es-infra` (isolated on `es_projector_sql_migrations`).
- **Option 3:** Cross-DO fan-out queries at read time without a projector database or event archive.

## Decision Outcome

**Chosen option:** "Option 2: At-least-once `Outbox.drain` with per-row ack deletion (outside a wrapping transaction across external bus I/O), pure `ProjectionSequence.decide` sequencing in `@harness/es-core`, and transactional `Projector.ingest` / `Projector.rebuild` over `es_event_archive`, `es_projection_checkpoints`, and `es_projection_gaps` in `@harness/es-infra` (isolated on `es_projector_sql_migrations`)", because it guarantees at-least-once delivery from Durable Object SQLite, isolates sequencing decisions in a pure `R = never` decider, prevents duplicate and out-of-order corruption, and supports deterministic full-projection rebuilds from `es_event_archive`.

### Binding Architectural Rules

1. **Per-Row Outbox Ack Deletion (`Outbox.drain`):** `drainAggregateOutbox` reads pending rows from `es_outbox` ordered by `id ASC` (with optional `aggregateName` filter and `batchLimit`), decodes row columns and `EventMetadata` via `Schema.decodeUnknownOption` and validates that metadata identity matches the row (failing closed with `EventStreamCorruptionError` before publishing on any mismatch or corruption), invokes `eventBus.publish(envelope)`, and deletes each row from `es_outbox` immediately after `eventBus.publish` succeeds without opening a cross-batch SQL transaction. If `eventBus.publish` fails with `OutboxPublishError`, the failed row and all subsequent rows remain in `es_outbox` for the next alarm cycle.
2. **Pure Sequencing Decider (`ProjectionSequence.decide`):** `@harness/es-core` defines `decideProjectionSequence` with `R = never` and `E = never`. Given `ProjectionSequenceInput` (`checkpointVersion`, `incomingVersion`, `parkedVersions`), it returns `SkipDuplicateEvent` when `incomingVersion <= checkpointVersion`, `ParkOutOfOrderEvent` when `incomingVersion > checkpointVersion + 1`, and `ApplyContiguousEvents` containing `incomingVersion` plus all consecutive parked versions (`checkpointVersion + 2`, `checkpointVersion + 3`, ...) when `incomingVersion === checkpointVersion + 1`.
3. **Pre-Validated & Transactional Projector Ingestion (`Projector.ingest`):** `ingestPublishedEvent` first validates envelope integrity, positive `streamVersion`, and domain event schema decoding before opening a transaction (failing fast with `ProjectionArchiveCorruptionError` on invalid envelopes). Inside `sql.withTransaction`, it verifies archive payload consistency and inserts into `es_event_archive`, decodes stored checkpoint and gap versions via `Schema.decodeUnknownOption` (failing with `ProjectionArchiveCorruptionError` on corrupt SQLite values), evaluates `decideProjectionSequence` for each subscribed `CrossAggregateProjection`, parks out-of-order events in `es_projection_gaps` (`ON CONFLICT DO NOTHING`), or applies contiguous events via `applyCrossProjection`, deletes unblocked gaps, and updates `es_projection_checkpoints`.
4. **Deterministic Archive Rebuild (`Projector.rebuild`):** Inside `sql.withTransaction`, `rebuildProjectorFromArchive` loads all rows for `projection.aggregateName` from `es_event_archive` ordered by `(aggregate_id ASC, stream_version ASC)`, decodes and verifies contiguous per-aggregate versions starting at `1` (failing and rolling back with `ProjectionArchiveCorruptionError` on gaps, non-integer versions, or invalid JSON), calls `rebuildCrossProjection` (which purges read-model rows and replays archived events), deletes existing gaps and checkpoints scoped strictly to `projection.processorId`, and inserts the rebuilt checkpoints.
5. **Checkpoint Catch-Up Inspection (`Projector.checkCatchUp`):** `checkProjectorCatchUp` decodes and compares per-aggregate maximum `stream_version` in `es_event_archive` and any remaining rows in `es_projection_gaps` against `es_projection_checkpoints` for `(processorId, aggregateName)` (failing with `ProjectionArchiveCorruptionError` on corrupt SQLite values), returning `CaughtUp` or `Lagging` so tests and consumers never rely on arbitrary sleeps.

## Rejected Alternatives

### 1 · Direct Inline Queue Publishing Inside `Aggregate.handleCommand`

**Why rejected:** Publishing to an external queue inside the command handler creates a dual-write hazard: if the queue call succeeds before SQLite commits (or fails after SQLite commits), downstream projections either observe phantom uncommitted events or permanently miss committed events.

### 2 · Cross-DO Fan-Out Queries Without an Event Archive

**Why rejected:** Fanning out read queries across hundreds of Durable Object instances violates latency budgets and cannot support relational filtering or sorting across aggregates, while omitting `es_event_archive` makes rebuilding new or updated cross-aggregate projections impossible without scanning every Durable Object instance.

## Consequences and Enforcement

### Positive Consequences

- Mid-drain alarm failures and duplicate queue deliveries are 100% safe and idempotent.
- Out-of-order event delivery is automatically buffered in `es_projection_gaps` and drained in strict `stream_version` order as soon as missing versions arrive.
- Rebuilding any `CrossAggregateProjection` from `es_event_archive` deterministically reproduces the live read model state and checkpoints.

### Negative Consequences and Trade-offs

- Storing `es_event_archive` and `es_projection_gaps` in the projector database increases storage footprint linearly with published events until cold-archive tiering is introduced.
- If version `m` of an aggregate is delayed indefinitely in the outbox, subsequent versions `> m` for that specific `aggregateId` remain parked in `es_projection_gaps` until `m` arrives.

### Deterministic Enforcement

| Rule                                  | Enforced By                                                        | Gate / Mechanism                                           | Governed Symbols                                        |
| ------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------- |
| Pure Sequencing Decider (`R = never`) | `libs/es/core/src/projection.ts`                                   | `decideProjectionSequence`                                 | `ProjectionSequence.decide`                             |
| At-Least-Once Outbox Drain            | `libs/es/infra/src/outbox.ts`, `libs/es/contract/src/index.ts`     | `drainAggregateOutbox`, `OutboxPublishError`               | `Outbox.drain`, `OutboxPublishError`                    |
| Outbox Corruption Guard               | `libs/es/infra/src/outbox.ts`, `libs/es/contract/src/index.ts`     | `drainAggregateOutbox`, `EventStreamCorruptionError`       | `EventStreamCorruptionError`                            |
| Transactional Projector Migrations    | `libs/es/infra/src/projector.ts`                                   | `initializeProjectorTables`, `projectorCoreMigrations`     | `ProjectorInfra.initTables`                             |
| Idempotent Ingestion & Gap Parking    | `libs/es/infra/src/projector.ts`, `libs/es/core/src/projection.ts` | `ingestPublishedEvent`, `applyCrossProjection`             | `Projector.ingest`, `CrossProjection.apply`             |
| Archive Rebuild Parity                | `libs/es/infra/src/projector.ts`, `libs/es/core/src/projection.ts` | `rebuildProjectorFromArchive`, `rebuildCrossProjection`    | `Projector.rebuild`, `CrossProjection.rebuild`          |
| Cross-Projection Query & Lookup Guard | `libs/es/core/src/projection.ts`, `libs/es/contract/src/index.ts`  | `queryCrossProjection`, `CrossProjectionNotFoundError`     | `CrossProjection.query`, `CrossProjectionNotFoundError` |
| Archive & Envelope Corruption Guard   | `libs/es/infra/src/projector.ts`, `libs/es/contract/src/index.ts`  | `ingestPublishedEvent`, `ProjectionArchiveCorruptionError` | `ProjectionArchiveCorruptionError`                      |
| Deterministic Catch-Up Inspection     | `libs/es/infra/src/projector.ts`                                   | `checkProjectorCatchUp`                                    | `Projector.checkCatchUp`                                |
