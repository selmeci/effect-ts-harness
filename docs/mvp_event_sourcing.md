# Event Sourcing & CQRS on Effect + Cloudflare — MVP Brief

Oct 4, 2026 · @Roman Selmeci

## Project intent

We build a thin event sourcing and CQRS module on Effect v4 and Cloudflare, because no maintained Castore-like framework exists for Effect v4. Working name: `effect-es`.

The design maps each concept onto something the stack already does well: a **Durable Object is the aggregate**, its SQLite holds the event stream **and the aggregate's own read models**, **pure deciders** (`decide` / `evolve`) hold the business logic, and **D1 is used only for queries across many aggregates**. Effect Schema defines commands and events; Drizzle via Alchemy gives typed SQL in both stores.

Context: this is a sibling of the [Effect-TS Engineering Harness](https://claude.ai/code/artifact/acbfc01b-f30f-4c33-8712-bc32b51be39a). It reuses the harness stack (pnpm + Nx, Alchemy, `@effect/tsgo`, code-graph-rag traces) and will be one of the sample domains the harness is tested on.

## Landscape

Effect v4 has building blocks close to event sourcing, but none is a server-side aggregate event store; community libraries target Effect v3.

| Option | What it is | Fit for us |
| --- | --- | --- |
| `effect/eventlog` (core, unstable) | typed `Event` / `EventGroup` with a `primaryKey`, handlers that run before an entry commits, `EventJournal` (memory, IndexedDB, SQL) with replay and compaction; most of the module is replication: identities, encryption, remote replicas | built for local-first sync of clients; no expected-version concurrency found. Later, for offline frontend sync |
| `effect/cluster` `Entity` (core, unstable) | addressable entities by id, sharded, each with an RPC protocol; one writer per id | the actor model we want, but Durable Objects already give it on Cloudflare |
| `effect/workflow` (core, unstable) | durable workflows with compensation, idempotency keys | process managers and sagas across aggregates |
| `@codeforbreakfast/eventsourcing-*` | Effect-first aggregates, store, commands, protocol, transports, test contracts | peer `effect ^3.17`, last release 2025-12-11: not usable on v4, good API inspiration |
| Castore | TypeScript ES framework: event stores, reducers, commands, message buses | not Effect, last release 2.4.2 (2025-04): wrapping it loses Schema, typed errors and Layers |
| Emmett | Node.js ES framework: deciders, command handler, inline and async projections, consumers with checkpoints, workflows, BDD test specs; stores for PostgreSQL, SQLite, MongoDB, EventStoreDB | closest design to ours; plain TypeScript (Apache 2.0): our main source of patterns, see the next section |
| Decider pattern (fmodel-ts, Emmett) | `decide(command, state) → events`, `evolve(state, event) → state` | pure functions, ports to Effect without friction: our core |

**Decision:** a thin own module on Effect Schema, deciders and Drizzle on Durable Object SQLite, borrowing Castore's vocabulary. No dependency on v3 libraries.

## Inspiration from Emmett

Emmett (Oskar Dudycz) is the closest TypeScript match to our design: deciders, single-stream inline projections, multi-stream async projections and given/when/then testing. We borrow its patterns and API shapes, not its code: while Emmett is licensed under Apache 2.0, it targets plain TypeScript runtimes with EventStoreDB/PostgreSQL, so we implement idiomatic Effect v4 primitives with native Schemas and Fiber runtime.

| Emmett idea | What we adopt | Where it lands |
| --- | --- | --- |
| Decision returns one event, many, or an empty array; an empty array is a no-op | a command with nothing to do returns no events, which keeps it safe to send twice (on top of `commandId`) | write path, decider rules |
| Command handler result: new state, appended events, next expected stream version, whether the stream was created | the aggregate's reply carries the same four fields as a contract Schema | write path step 6, `HttpApi` response |
| Single-stream projections run inline in the append transaction; multi-stream ones run async, because inline multi-stream projections overwrite each other under load | confirms our split: local projections inline in the Durable Object, cross-aggregate ones async in D1 | read path |
| Projection helpers: `initialState` instead of null, returning null deletes the document, a list of handled event types filters the feed | `LocalProjection` and `Projection` take `initialState`, a `canHandle` list, and a delete result | module API |
| Event metadata to correlate multi-stream projections | every stored event carries metadata: aggregate id, stream version, `commandId`, correlation and causation ids, timestamp | core concepts, cross-aggregate projections |
| `DeciderSpecification`: given events, when command, then events (same count and strict structural equality), `thenThrows` with the exact error, `thenNothing` for no-ops | `makeDeciderTestHarness` for `@effect/vitest`: `thenEvents` (full `Equal.equals`), `thenFails(expectedError)` on the `E` channel (dying on unexpected defects), and `thenNothing` | testing |
| `ApiSpecification`: seed a stream, send a request, assert status and the appended events together | `AggregateApiSpec` over `HttpApiTest` | testing |
| Projection specs against a real database, replaying events `numberOfTimes` to prove idempotency | projection tests under `alchemy dev`, each event replayed twice | testing |
| Consumers with a `processorId` and checkpoints; tests wait with `whenCaughtUp` on checkpoints, never with a sleep | projector checkpoints per `processorId`; a test helper waits until the checkpoint reaches the archive tail | read path, testing |
| Schema versioning with upcast and downcast in the handler | upcasters as today; downcast only if an old consumer must read new events | event schema evolution |
| Workflows: a decider over input commands and events that emits output messages, its stream holding inputs and outputs | post-MVP option for process managers: a workflow is itself a Durable Object aggregate, compared against `effect/workflow` | open questions |

Not adopted: retries on expected-version conflicts (a Durable Object is the single writer, so conflicts cannot occur inside one aggregate) and Emmett's own event store packages (designed for plain TypeScript, not Effect).

## Goals and non-goals

The MVP must run one event-sourced aggregate end to end: command in, events stored, projection updated, query served, all typed and testable without deploying.

**MVP goals**

1. Deciders are pure: business logic is testable as given events, when command, then events, with no infrastructure.
2. One Durable Object per aggregate id appends events, updates its local read models and writes outbox rows in one SQLite transaction; a command never half-succeeds.
3. Queries about one aggregate are answered by its Durable Object, strongly consistent and read-your-writes.
4. Queries across aggregates use D1 projections fed at least once through the outbox; they are idempotent, so duplicates do no harm.
5. Local read models rebuild from the aggregate's own stream; D1 projections rebuild from the global event archive.
6. A process manager coordinates a process across two aggregates, with a timeout and a compensation, built on the option chosen in phase 5.
7. Commands, events and read models are Effect Schemas in `type:contract`; queries and commands go through `HttpApi`.
8. Event schemas are versioned and old events stay decodable through upcasters.
9. Everything runs under `alchemy dev` emulation in tests.

**Non-goals for the MVP**

- Snapshots (added once a stream grows long enough to need them).
- Transactions across aggregates; process managers coordinate them instead.
- Offline frontend sync through `effect/eventlog`.
- Multi-region read replicas, encryption of event payloads, GDPR erasure (crypto-shredding).
- A published npm package; the module lives in the repo first.

## Core concepts

Each event sourcing concept maps to one Effect building block and one Cloudflare primitive; Castore's names are kept so the vocabulary is familiar.

| Concept (Castore name) | Effect building block | Cloudflare / storage |
| --- | --- | --- |
| Event (`EventType`) | `Schema` tagged struct per event, with a `version` field, in `type:contract` | row in the aggregate's `events` table |
| Event metadata | `Schema` struct: aggregate id, stream version, `commandId`, correlation and causation ids, timestamp | columns next to the payload; travels with the event through the outbox |
| Command (`Command`) | `Schema` tagged struct; handled by an `Effect.fn` with typed errors | arrives through `HttpApi` or RPC |
| Aggregate state (`Reducer`) | `evolve(state, event) → state`, a pure function | rebuilt in memory on activation |
| Business rules | `decide(command, state) → Effect<events, DomainError>` with `R = never`; an empty array is a no-op | — |
| Event store (`EventStore`) | `AggregateStore` service over Drizzle | Durable Object SQLite, one object per aggregate id |
| Local projection | `LocalProjection` = Schema read model + `apply(event)`, run inside the append transaction | tables in the same Durable Object SQLite; queried over RPC |
| Outbox | rows written in the same transaction as the events | Durable Object SQLite, drained by an alarm; only for aggregate types with cross-aggregate subscribers |
| Message bus (`MessageBus`) | `EventBus` service, `Stream` on the consumer side | Cloudflare Queue |
| Cross-aggregate projection | `Projection` = Schema read model + `apply(event)`, one checkpoint per aggregate and `processorId` | D1 tables |
| Event archive | append-only copy of every published event | D1 `event_archive`, exists only to rebuild D1 projections |
| Process manager / saga | one of: workflow decider in its own aggregate, `effect/workflow`, Cloudflare Workflows via Alchemy (chosen in phase 5) | Durable Object, an engine on Durable Objects, or Cloudflare Workflows |

The decider's `R = never` is the key rule: business logic needs no services, so `effect-graph:check` can enforce purity from the type alone.

## Architecture

Commands and queries about one aggregate go to its Durable Object, which stores the events and its own read models together. D1 joins only when a query spans many aggregates, fed through the outbox and a queue.

&#91;embedded content: architecture · aggregate path on top, optional cross-aggregate path below\]

The top row is all a typical aggregate needs: strongly consistent writes and reads in one place. The dashed bottom row exists only for aggregate types that a cross-aggregate projection subscribes to; the outbox and the queue are the only link between the two rows.

## Write path

A command is handled inside the aggregate's Durable Object, so one id has exactly one writer and appends are serialized by the platform, with no optimistic-concurrency retries inside an aggregate.

1. **Receive.** The api Worker decodes the command with its Schema and calls the aggregate's Durable Object by id over RPC. The command carries a `commandId` for idempotency.
2. **Load.** On activation the object reads its events (`Drizzle.DurableObject`, migrations applied first) and folds them with `evolve` into state, kept in memory while the object lives.
3. **Decide.** `decide(command, state)` returns new events, an empty array when there is nothing to do, or a typed domain error. A `commandId` already seen returns the earlier result without deciding again.
4. **Append.** One SQLite transaction writes the events with their metadata (stream version + 1 each), applies them to every local projection, writes outbox rows (only if a cross-aggregate projection subscribes) and records the `commandId`. Nothing is visible until it commits; an empty array writes nothing.
5. **Publish.** When outbox rows exist, a Durable Object alarm drains them to the Cloudflare Queue and deletes sent rows; on failure the alarm retries, so delivery is at least once.
6. **Reply.** The result carries the new state, the appended events, the next stream version and whether the stream was created. Local read models already reflect it, so a follow-up query by id sees the change immediately.

Domain errors travel in the `E` channel to `HttpApi`, which maps them to declared HTTP errors.

## Read path

Queries come in two kinds: about one aggregate, answered by its Durable Object, and across aggregates, answered by D1. A read model goes to D1 only when a query genuinely spans many aggregates (lists, search, reports).

**Local projections (default)**

- **Where.** Tables in the aggregate's own SQLite, updated in the append transaction, so they are always consistent with the events and give read-your-writes.
- **Query.** The api Worker calls the Durable Object's query method over RPC; the read model is a contract Schema, returned through `HttpApi`.
- **Rebuild.** Each local projection has a version; on activation, a version mismatch replays the object's own stream into fresh tables before the first request. No archive needed.

**Cross-aggregate projections (only when needed)**

- **Feed.** A projector Worker consumes the queue fed by outboxes and updates D1 read models.
- **Idempotency.** Each projection keeps a checkpoint per aggregate: the last applied stream version. An event at or below it is skipped; a gap is parked and retried, so out-of-order delivery cannot corrupt a read model. The read-model write and the checkpoint go in one D1 batch.
- **Archive and rebuild.** The projector also appends each event to `event_archive`, keyed by aggregate id and version. A new or changed projection replays the archive into fresh tables, then switches over.
- **Consistency.** Eventually consistent; clients that need a just-written change query the aggregate instead.

An aggregate type with no cross-aggregate subscribers writes no outbox rows and needs no queue at all. D1 size limits bound how long the archive can grow in one database; past that, older events move to R2 (open question).

## Process managers (workflows)

Business processes that span aggregates are in scope, because there is no transaction across Durable Objects: a process manager listens to events, sends commands to other aggregates, tracks progress and compensates on failure. Which of three implementations we use is decided while brainstorming phase 5; the requirements below are fixed now.

**Example.** A cart checks out → reserve stock in the inventory aggregate → charge payment → confirm the order. If payment fails or does not arrive within 15 minutes, release the reservation.

**Requirements for any option**

- Every command it sends carries a `commandId` derived from the workflow id and step, so retries are safe on the receiving aggregate.
- It reacts to events from the outbox or queue, at least once, without acting twice on the same input.
- Timeouts and waits survive restarts; compensation is explicit and tested.
- Its decisions are testable without infrastructure, and its history can be audited.
- It runs under `alchemy dev` emulation in tests.

**The three options**

|  | Decider in a Durable Object (Emmett style) | `effect/workflow` | Cloudflare Workflows via Alchemy |
| --- | --- | --- | --- |
| Model | event-sourced decider over inputs (events, commands) emitting outputs; its stream holds both | durable execution: code with `Activity` steps, `DurableClock`, `DurableDeferred`, compensation | durable execution: named `task` steps checkpointed and replayed, `sleep`, `sleepUntil`, `waitForEvent` with a timeout |
| Fit with our design | same machinery as aggregates: decider, outbox, alarm, local read model | different model; progress lives in the engine, not as events | different model; progress lives in Cloudflare's step checkpoints |
| Timeouts | Durable Object alarm per deadline | `DurableClock` | native `sleep` and `waitForEvent` timeout |
| Compensation | explicit events and commands in `decide` | built-in compensation helpers | written as steps (e.g. refund when a later step fails) |
| Runs on Cloudflare | natively | needs an engine: core ships an in-memory engine (tests) and a cluster engine; no Cloudflare engine found, so we would write one on Durable Objects | natively; Effect-native wrapper in Alchemy (`Cloudflare.Workflow`, `task`) |
| Testing | `makeDeciderTestHarness` on the pure decider, plus the emulated object | in-memory engine | start an instance and poll until it finishes |
| Audit and replay | full stream of inputs and outputs | engine storage | Cloudflare instance history |
| Main risk | we build timeouts and inbox dedup ourselves | engine work; module marked unstable | step names are replay keys, so renaming a step breaks running instances; Alchemy is beta |

Whatever wins, the aggregates do not change: a process manager only consumes existing events and sends existing commands.

## Module API sketch

The module exposes four definitions: `Decider`, `Aggregate`, `Projection` and the archive; the sketch below is a design target to check against the pinned Effect and Alchemy source, not verified API.

```ts
// type:contract — events, commands, and states are Schemas with branded primitives
export const CartEvent = Schema.Union([
  Schema.TaggedStruct("CartCreated", { cartId: Schema.String, version: Schema.Literal(1) }),
  Schema.TaggedStruct("ItemAdded", { cartId: Schema.String, itemId: Schema.String, quantity: PositiveInt, version: Schema.Literal(1) }),
  Schema.TaggedStruct("CartCheckedOut", { cartId: Schema.String, orderId: Schema.String, version: Schema.Literal(1) })
])

// test/fixtures (or type:domain in apps) — the decider is pure: R = never
export const cartDecider = Decider.make({
  initialState: initialCartState,
  evolve: (state: CartState, event: CartEvent): CartState => /* exhaustive match fold */ state,
  decide: Effect.fn("Cart.decide")((command: CartCommand, state: CartState) =>
    match([state, command])
      .with([{ _tag: "CheckedOutCart" }, P._], ([, cmd]) =>
        Effect.fail(new CartAlreadyCheckedOutError({ cartId: cmd.cartId }))
      )
      /* exhaustive _tag union matching */
      .exhaustive()
  )
})

// type:infra — a local read model, updated inside the append transaction
export const CartView = LocalProjection.make("cart-view", {
  version: 1,             // bump to rebuild from the object's own stream
  model: CartViewModel,   // contract Schema returned to clients
  apply: Effect.fn("CartView.apply")(function*(event) { /* Drizzle upsert in DO SQLite */ })
})

// type:infra — the Durable Object that hosts the aggregate and answers its queries
export const CartAggregate = Aggregate.durableObject("Cart", {
  decider: CartDecider,
  events: CartEvent,        // Schema used to encode and decode stored rows
  upcasters: CartUpcasters, // old versions -> current, see schema evolution
  projections: [CartView],  // local, strongly consistent
  publish: true             // outbox on: a cross-aggregate projection subscribes
})

// type:infra — only for queries across carts: a projection into D1
export const OpenCartsByCustomer = Projection.make("open-carts-by-customer", {
  events: CartEvent,
  apply: Effect.fn("OpenCartsByCustomer.apply")(function*(event, meta) { /* Drizzle upsert in D1 */ })
})
```

`Aggregate.durableObject` owns load, `commandId` dedup, the transactional append, local projections, their versioned rebuild, query methods, and the outbox with its alarm when `publish` is on. `Projection.make` owns D1 checkpoints, gap handling and rebuild from the archive. Each `Effect.fn` name feeds the harness trace overlay.

## Event schema evolution

Stored events are never rewritten: a published event schema is frozen, and a change means a new version plus an upcaster that turns the old shape into the new one on read.

- **Version field.** Every event carries `version`; the stored row keeps the encoded payload exactly as written.
- **Upcasters as Schema transformations.** Version 1 → 2 is a Schema transformation from the old shape to the new, so decoding an old row yields the current type and the decider only ever sees current events.
- **Additive first.** A new optional field needs no new version; renames, removals and type changes do.
- **Frozen snapshots.** A JSON Schema snapshot of every event version (Effect's `JsonSchema` module) is committed. Changing a released version fails `verify`; a new version with its upcaster passes.
- **Projection impact.** A new event version that a projection must read triggers a rebuild plan, reviewed in the plan check.

## Testing

Most tests run on pure deciders in milliseconds; only aggregate, outbox and projection tests need `alchemy dev` emulation.

| Level | What it checks | How |
| --- | --- | --- |
| Decider | business rules: the right events, the exact rejection, silence when there is nothing to do | `makeDeciderTestHarness` on `@effect/vitest`: `given(events).when(command).thenEvents(expected)` (strict `Equal.equals` and count), `thenFails(expectedError)` (rejecting defects via `Cause.hasDies`), `thenNothing()`; no infrastructure |
| Decider properties | `evolve` is total, replay is deterministic | Schema-derived arbitraries (Effect's `Arbitrary` module) generate event sequences |
| Upcasters | every old version decodes to the current type | frozen sample rows per version, decoded in tests |
| Aggregate | transactional append with local projections, `commandId` dedup, outbox written when `publish` is on | Durable Object under `alchemy dev`, Drizzle migrations applied |
| Local projection | read-your-writes, rebuild on version bump equals incremental result | query after a command; bump the version and compare tables |
| Delivery | at-least-once outbox drain, duplicates harmless | emulated queue; each event delivered twice changes the D1 projection once |
| Cross-aggregate projection | apply, checkpoint, gap parking, rebuild equals live | replay `event_archive` into fresh tables and compare; tests wait until the `processorId` checkpoint reaches the archive tail, never with a sleep |
| API | commands and both kinds of queries through `HttpApi` | `AggregateApiSpec` on `HttpApiTest`: seed a stream, send a request, assert the status and the appended events together |

## Harness integration

The module plugs into the harness as new building blocks with their own plan rows, generators and gates; nothing in the harness core changes.

- **Plan template rows:** aggregate (id, commands, events, invariants), local read models with their queries, cross-aggregate projections with the query that justifies D1, process managers (steps, timeouts, compensations), event versions touched.
- **Generators:** `aggregate` (contract Schemas, decider stub, Durable Object, Drizzle tables, migration, one local projection), `projection` (D1 tables, apply stub, checkpoint) and, after phase 5, `process-manager` for the chosen option.
- **Gates:**
    - decider purity: `decide` and `evolve` must have `R = never`, checked by `effect-graph:check`;
    - frozen event versions: the JSON Schema snapshot check from the evolution section;
    - outbox discipline: a lint rule bans calls to the queue from aggregate code, so events leave only through the outbox;
    - D1 justification: a new D1 projection needs a plan row naming its cross-aggregate query, checked in the plan check;
    - process-manager commands carry a derived `commandId`, checked in its tests.
- **Idiom router categories:** `aggregate`, `local-projection`, `cross-projection`, `process-manager`, `event-version` (within the 26-option limit), each with a pattern file generated from this module.
- **Traces:** command → decider → append → projector and process-manager spans give code-graph-rag runtime edges across the queue, which static parsing cannot see.

## MVP scope, phases and acceptance

The MVP proves the full loop on two aggregates (for example cart and inventory, to be chosen) with a local read model, one cross-aggregate projection and one process manager between them, in five phases, each closed by its gate.

1. **Decider core** — `Decider`, event and command Schemas, given/when/then helpers, property tests. Gate: the sample decider is fully tested with no infrastructure.
2. **Aggregate with local read model** — load, dedup, transactional append, local projection with query method and versioned rebuild. Gate: a command under `alchemy dev` is visible in the next query by id.
3. **Cross-aggregate path** — outbox, alarm drain to a queue, projector Worker, checkpoints, gap parking, `event_archive`, rebuild. Gate: rebuild from the archive equals the live D1 read model.
4. **API, evolution, harness** — `HttpApi` commands and both kinds of queries, upcaster for one v1 → v2 change, generators and gates in the harness. Gate: the API and evolution criteria below are green.
5. **Process manager** — brainstorm and spike the three options on the same two-step process (reserve, then confirm or release on timeout), pick one, build it properly. Gate: the chosen option meets every requirement in the process managers section.

**Acceptance criteria**

- [ ] A decider test reads as given events, when command, then events, and runs without any Layer for infrastructure.
- [ ] `effect-graph:check` fails if `decide` or `evolve` requires any service.
- [ ] Sending the same command twice (same `commandId`) stores its events once.
- [ ] A query by id right after a command returns the updated local read model.
- [ ] Bumping a local projection's version rebuilds it on activation; the result equals the incremental one.
- [ ] An aggregate type without cross-aggregate subscribers writes no outbox rows.
- [ ] Killing the alarm mid-drain and restarting delivers every outbox event at least once; the D1 projection changes once per event.
- [ ] An out-of-order delivery is parked and applied after the missing version arrives.
- [ ] Rebuilding the D1 projection from `event_archive` produces the same rows as the live one.
- [ ] A v1 event stored before a v2 change decodes as v2 through its upcaster; editing the v1 Schema fails `verify`.
- [ ] The React app issues a command and shows the updated cart (local) and the customer's open carts (D1) through `AtomHttpApi`.
- [ ] A short decision record compares the three process-manager options on the spike and names the choice.
- [ ] Checkout reserves stock and confirms; a missing payment releases the reservation after the timeout; delivering the same event twice sends each command once.
- [ ] All of the above runs under `alchemy dev` with nothing deployed.

## Risks and open questions

The largest risks are read load on a single-threaded aggregate, long streams without snapshots, and the archive outgrowing D1.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Queries and commands share one single-threaded Durable Object | a hot aggregate under heavy reads slows its own writes | measure in phase 2; cache read models at the edge, or move that read model to D1 when reads dominate |
| A query that starts per-aggregate later needs to span aggregates | a local read model must be duplicated into D1 | plan row names each query's scope up front; adding a D1 projection is additive, replayed from the archive |
| Long event streams slow down Durable Object activation and local rebuilds | latency on the first command after eviction or a version bump | measure in phase 2; add snapshots after the MVP when a stream crosses a threshold |
| `event_archive` outgrows one D1 database | rebuilds and appends fail | partition by aggregate type or move cold events to R2 |
| Outbox drain stalls (alarm keeps failing) | D1 projections fall behind silently | lag metric per projection from checkpoints; alert in the observability Layer |
| Upcaster chain grows long | slow decode, hard to reason about | collapse old versions with a one-off migration of the archive, never of the aggregate's own stream |
| Effect v4 modules used here are marked unstable | API churn | pin versions; thin wrappers inside the module |

**Open questions**

- Which two sample aggregates to build (cart and inventory, order and payment, booking and slot)? They need one per-aggregate query, one cross-aggregate query and one process between them.
- Global ordering: is per-aggregate order plus archive insertion order enough, or do some D1 projections need a total order?
- How long are events kept in the aggregate's own SQLite once archived? Local rebuilds need the full stream unless snapshots exist.
- Should a hot aggregate's read model ever be served from a cache or a separate Durable Object, and what is the threshold?
- Process manager choice (phase 5 brainstorming): workflow decider in a Durable Object, `effect/workflow` with an own Durable Object engine, or Cloudflare Workflows via Alchemy. Does `alchemy dev` emulate Cloudflare Workflows well enough for the timeout test?
- Emmett's patterns: borrow design concepts while building native Effect v4 primitives.

## Sources

Checked 2026-10-04 against source code and package registries; Cloudflare platform behaviour (single writer per Durable Object, alarms, at-least-once queues) is from general knowledge and is re-checked in phase 2.

| Fact | Source |
| --- | --- |
| `effect/eventlog`: typed events with `primaryKey`, handlers before commit, `EventJournal` with replay, compaction and replication; marked unstable | [eventlog](https://github.com/Effect-TS/effect/tree/main/packages/effect/src/eventlog) |
| `effect/cluster` `Entity` and `effect/workflow`: addressable sharded entities; durable workflows with `Activity`, `DurableClock`, `DurableDeferred`; `WorkflowEngine` ships an in-memory layer, the cluster package a `ClusterWorkflowEngine` | [cluster](https://github.com/Effect-TS/effect/tree/main/packages/effect/src/cluster), [workflow](https://github.com/Effect-TS/effect/tree/main/packages/effect/src/workflow) |
| Cloudflare Workflows in Alchemy: `Cloudflare.Workflow` class, `task` checkpointed steps replayed from the last completed step, `sleep`, `sleepUntil`, `waitForEvent` with timeout, step names are replay keys, tests start an instance and poll | [Alchemy Workflows](https://alchemy.run/cloudflare/compute/workflows), [Workflow reference](https://alchemy.run/providers/cloudflare/workflows/workflow) |
| `@codeforbreakfast/eventsourcing-*`: Effect-first, peer `effect ^3.17`, last release 2025-12-11 | [eventsourcing-store](https://www.npmjs.com/package/@codeforbreakfast/eventsourcing-store), [eventsourcing-aggregates](https://www.npmjs.com/package/@codeforbreakfast/eventsourcing-aggregates) |
| Castore: TypeScript ES framework, `@castore/core` 2.4.2 released 2025-04-18 | [castore](https://castore-dev.github.io/castore/) |
| Emmett: deciders, command handler result fields, inline single-stream vs async multi-stream projections, consumers with checkpoints and `whenCaughtUp`, workflows, `DeciderSpecification` and `ApiSpecification`; Apache 2.0 | [emmett](https://github.com/event-driven-io/emmett), docs in the repo: command handler, projections, testing, workflows |
| Decider pattern for TypeScript | [fmodel-ts](https://npmjs.com/package/@fraktalio/fmodel-ts), [event-driven.io](https://event-driven.io/en/type_script_node_js_event_sourcing/) |
| `Drizzle.DurableObject` over `@effect/sql-sqlite-do`, migrations applied on activation, typed `EffectDrizzleQueryError` | [Alchemy Drizzle.DurableObject](https://alchemy.run/providers/drizzle/durableobject) |