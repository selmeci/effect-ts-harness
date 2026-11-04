---
id: es:ADR-0004
title: Event Schema Upcasters via Schema.decodeTo, Frozen JSON Schema Snapshots, and HttpApi Transport
status: accepted
date: 2026-11-04
enforced_by:
  - libs/es/contract/src/index.ts
  - libs/es/core/src/index.ts
  - libs/es/core/src/evolution.ts
  - libs/es/core/src/testing.ts
  - libs/es/core/test/fixtures/cart.ts
  - libs/es/infra/src/index.ts
  - libs/es/infra/src/http.ts
  - libs/es/infra/test/fixtures/cart-sqlite.ts
spans:
  - EventSchemaEvolution.snapshot
  - EventSchemaEvolution.decide
  - EventSchemaEvolution.verify
  - AggregateHttp.seedStream
  - AggregateHttp.executeCommand
  - AggregateHttp.queryLocal
  - AggregateHttp.queryCross
services: []
errors:
  - FrozenEventSchemaViolationError
  - MissingEventUpcasterError
  - EventSerializationError
  - EventStreamCorruptionError
  - CommandAggregateMismatchError
  - ConcurrencyConflictError
  - OutboxPublishError
  - ProjectionArchiveCorruptionError
  - LocalProjectionNotFoundError
  - CrossProjectionNotFoundError
---

# Event Schema Upcasters via Schema.decodeTo, Frozen JSON Schema Snapshots, and HttpApi Transport

## Context and Problem Statement

In Phase 4 of the Event Sourcing MVP (`docs/mvp_event_sourcing.md`), aggregates and cross-aggregate projections must evolve their event schemas over time without rewriting immutable event rows in Durable Object SQLite (`es_events`) or projector archives (`es_event_archive`), while exposing command and query endpoints through `HttpApi` and `AtomHttpApi`. If a developer modifies a released event schema version in place instead of introducing a new version (`version: 2`) with an upcaster, historical JSON rows stored in production fail to decode on aggregate load or projection rebuild.

At the same time, exposing commands, strongly consistent single-aggregate local read models, and cross-aggregate projections over HTTP requires a unified, contract-first transport (`HttpApi`) paired with a deterministic test specification (`AggregateApiSpec`) and reactive client integration (`AtomHttpApi`) that preserves typed error channels and read-your-writes consistency.

## Decision Drivers

- **Immutability of Persisted Events:** Historical rows in `es_events` and `es_event_archive` must never be mutated when an event schema evolves from version $N$ to version $N+1$.
- **Single Current Event Type in Domain & Projections:** Deciders (`evolve`), local projections (`LocalProjection.apply`), and cross-aggregate projections (`CrossAggregateProjection.apply`) must only operate on the latest event representation rather than branching on historical schema versions.
- **Deterministic Frozen Snapshot Verification (`R = never`):** Every released event version must have a committed draft-2020-12 JSON Schema snapshot (`Schema.toJsonSchemaDocument` with `onExcessProperty: "error"`), and a pure decider (`EventSchemaEvolution.decide`) must reject any drift in committed snapshots or any version transition lacking an `EventUpcasterLink`.
- **Contract-First HTTP & Reactive Client Integration:** Commands and both local and cross-aggregate queries must be defined with Effect v4 `HttpApi` (`effect/http-api`) and consumed via `HttpApiTest` (`AggregateApiSpec`) and `AtomHttpApi` (`effect/reactivity`).

## Considered Options

- **Option 1:** In-place SQLite migrations rewriting historical `es_events` and `es_event_archive` JSON payloads on every schema change.
- **Option 2:** Effect v4 `Schema.decodeTo` upcaster codecs (`makeEventUpcaster`), committed JSON Schema snapshots verified by pure `EventSchemaEvolution.decide` (`R = never`) and `EventSchemaEvolution.verify`, and `AggregateHttp.*` command/query adapters backing `HttpApi`, `AggregateApiSpec`, and `AtomHttpApi`.
- **Option 3:** Exposing versioned event unions (`V1 | V2 | V3`) directly to domain deciders and read-model projections without decode-time upcasting.

## Decision Outcome

**Chosen option:** "Option 2: Effect v4 `Schema.decodeTo` upcaster codecs (`makeEventUpcaster`), committed JSON Schema snapshots verified by pure `EventSchemaEvolution.decide` (`R = never`) and `EventSchemaEvolution.verify`, and `AggregateHttp.*` command/query adapters backing `HttpApi`, `AggregateApiSpec`, and `AtomHttpApi`", because it preserves immutable SQLite event streams, keeps domain deciders and projections purely focused on current event shapes, enforces frozen event version snapshots deterministically at `verify` time, and provides end-to-end typed HTTP and reactive `AtomHttpApi` client ergonomics.

### Binding Architectural Rules

1. **Deterministic JSON Schema Snapshots (`EventSchemaEvolution.snapshot`):** `toEventVersionSnapshot` invokes `Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })`, recursively sorts all object keys lexicographically, and produces an `EventVersionSnapshotEntry` with branded `EventType`, `EventSchemaVersion`, and `JsonSchemaText`.
2. **Pure Evolution Decider & Gate (`EventSchemaEvolution.decide` & `EventSchemaEvolution.verify`):** `decideEventSchemaEvolution` runs with `R = never` and `E = never`, returning `FrozenEventVersionDrifted` when any committed snapshot is missing, duplicated, or modified, `UnmappedEventVersionJump` when versions do not start at `1`, contain gaps, or lack a contiguous `EventUpcasterLink`, and `SchemaEvolutionValid` otherwise. `verifyEventSchemaEvolution` maps those decisions to `FrozenEventSchemaViolationError` and `MissingEventUpcasterError`.
3. **Decode-Time Upcasting (`makeEventUpcaster`):** Upcasters wrap `from.pipe(Schema.decodeTo(to, SchemaTransformation.transform({ decode, encode })))` alongside a validated `EventUpcasterLink`. Aggregate and projector event union codecs list the latest version schema before the upcaster schema so runtime encoding writes the current version while historical rows transparently decode into the current version.
4. **Transactional Stream Seeding & Command/Query HTTP Transport (`AggregateHttp.*`):** `seedAggregateStream` (`AggregateHttp.seedStream`) persists historical events transactionally with local projection updates and optional outbox entries; `executeAggregateCommandAndSync` (`AggregateHttp.executeCommand`) commits commands via `handleAggregateCommand` and drains outbox rows into cross-aggregate projections when `PublishOutbox` is active; `queryAggregateReadModel` (`AggregateHttp.queryLocal`) ensures local projection parity via `loadAggregate` before querying; and `queryCrossAggregateReadModel` (`AggregateHttp.queryCross`) queries cross-aggregate projections by `ProcessorId`.

## Rejected Alternatives

### 1 · In-Place SQLite Migration Rewriting Historical `es_events` JSON Payloads

**Why rejected:** Rewriting immutable event logs violates event-sourcing auditability, risks data loss across distributed Durable Object SQLite databases, and violates `docs/mvp_event_sourcing.md`'s rule that stored events are never rewritten.

### 2 · Exposing Versioned Event Unions Directly to Deciders and Projections

**Why rejected:** Requiring every `evolve` and projection `apply` handler to match on all historical versions forever causes domain and projection complexity to grow linearly with schema revisions and violates the Phase 4 requirement that deciders and projections only ever see current events.

## Consequences and Enforcement

### Positive Consequences

- Old `version: 1` payloads in `es_events` and `es_event_archive` remain untouched on disk and transparently decode into `version: 2` domain instances on load and rebuild.
- Modifying any committed event version snapshot or adding a new version without a contiguous `EventUpcasterLink` fails `EventSchemaEvolution.verify` and `libs/es/core/scripts/check-event-schemas.mjs`.
- `AggregateApiSpec` (`makeAggregateApiTestHarness`) tests seeded streams, HTTP command responses, and appended events together, while `AtomHttpApi` verifies reactive client mutations and local/cross-aggregate queries.

### Negative Consequences and Trade-offs

- Each new event version requires maintaining a deterministic `decode` / `encode` `SchemaTransformation.transform` link and committing its JSON Schema snapshot.
- In `Schema.Union([V2Schema, v1ToV2Upcaster.schema])`, the current version schema must precede the upcaster transformation so `Schema.encode` selects the canonical latest version representation.

### Deterministic Enforcement

| Rule                                         | Enforced By                                                                                     | Gate / Mechanism                                                                                                            | Governed Symbols                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Deterministic JSON Schema Snapshot           | `libs/es/core/src/evolution.ts`, `libs/es/contract/src/index.ts`                                | `toEventVersionSnapshot`, `EventVersionSnapshotEntry`                                                                       | `EventSchemaEvolution.snapshot`                                                                                           |
| Pure Evolution Decider (`R = never`)         | `libs/es/core/src/evolution.ts`, `libs/es/contract/src/index.ts`                                | `decideEventSchemaEvolution`, `EventSchemaEvolutionDecision`                                                                | `EventSchemaEvolution.decide`                                                                                             |
| Frozen Snapshot & Upcaster Verification Gate | `libs/es/core/src/evolution.ts`, `libs/es/contract/src/index.ts`                                | `verifyEventSchemaEvolution`, `FrozenEventSchemaViolationError`, `MissingEventUpcasterError`                                | `EventSchemaEvolution.verify`, `FrozenEventSchemaViolationError`, `MissingEventUpcasterError`                             |
| Transactional Stream Seeding                 | `libs/es/infra/src/http.ts`, `libs/es/core/src/testing.ts`                                      | `seedAggregateStream`, `makeAggregateApiTestHarness`                                                                        | `AggregateHttp.seedStream`, `EventSerializationError`, `EventStreamCorruptionError`, `ConcurrencyConflictError`           |
| Command Execution & Outbox Synchronization   | `libs/es/infra/src/http.ts`, `libs/es/infra/test/fixtures/cart-sqlite.ts`                       | `executeAggregateCommandAndSync`, `CommandAggregateMismatchError`, `OutboxPublishError`, `ProjectionArchiveCorruptionError` | `AggregateHttp.executeCommand`, `CommandAggregateMismatchError`, `OutboxPublishError`, `ProjectionArchiveCorruptionError` |
| Local Projection Parity Query                | `libs/es/infra/src/http.ts`, `libs/es/contract/src/index.ts`                                    | `queryAggregateReadModel`, `LocalProjectionNotFoundError`                                                                   | `AggregateHttp.queryLocal`, `LocalProjectionNotFoundError`                                                                |
| Cross-Aggregate Projection Query             | `libs/es/infra/src/http.ts`, `libs/es/contract/src/index.ts`                                    | `queryCrossAggregateReadModel`, `CrossProjectionNotFoundError`                                                              | `AggregateHttp.queryCross`, `CrossProjectionNotFoundError`                                                                |
| Upcaster & V2 Cart Fixture Parity            | `libs/es/core/test/fixtures/cart.ts`, `libs/es/core/src/index.ts`, `libs/es/infra/src/index.ts` | `cartCheckedOutV1ToV2`, `CartEventV2Codec`, `cartDeciderV2`                                                                 | `EventSchemaEvolution.decide`, `AggregateHttp.queryLocal`                                                                 |
