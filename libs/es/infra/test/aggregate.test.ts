import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { ConstraintError, isSqlError, SqlError, UniqueViolation } from "effect/sql/SqlError"
import {
  AggregateId,
  AggregateName,
  CommandId,
  EventMetadata,
  PositiveInt,
  ProjectionName,
  ProjectionVersion,
  StreamVersion,
  TimestampMs,
} from "@harness/es-contract"
import {
  type AggregateConfig,
  applyLocalProjection,
  Decider,
  LocalProjection,
  queryLocalProjection,
  rebuildLocalProjection,
} from "@harness/es-core"
import {
  type CartCommand,
  CartEvent,
  CartId,
  type CartState,
  evolveCart,
  initialCartState,
  ItemId,
  OrderId,
} from "@harness/es-core/fixtures/cart"
import { match } from "ts-pattern"
import {
  handleAggregateCommand,
  initializeAggregateTables,
  isEventStreamUniqueConflict,
  loadAggregate,
} from "../src/index.js"
import { SqlClientMemoryLayer } from "../src/memory.js"
import {
  cartAggregateConfig,
  CartView,
  cartViewProjection,
  cartViewProjectionV2,
  initCartViewTable,
} from "./fixtures/cart-sqlite.js"

const cid = (v: string) => CartId.make(v)
const iid = (v: string) => ItemId.make(v)
const oid = (v: string) => OrderId.make(v)
const aid = (v: string) => AggregateId.make(v)
const cmdId = (v: string) => CommandId.make(v)
const pName = (v: string) => ProjectionName.make(v)
const positiveInt = Schema.decodeSync(PositiveInt)

interface CountRow {
  readonly cnt: number
}

interface MetaRow {
  readonly projection_version: number
  readonly last_stream_version: number
}

describe("Aggregate Engine, Local Projections, and Command Idempotency", () => {
  it.effect(
    "REQ-1.1, REQ-1.2 & REQ-1.3: deduplicates duplicate commands, preserves stored creationStatus and version after later commands, and rejects cross-aggregate commandId reuse",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initCartViewTable
        const sql = yield* SqlClient

        const cartId = aid("cart-idempotency-1")
        const createCommandId = cmdId("cmd-100")
        const command1: CartCommand = {
          _tag: "AddItem",
          cartId: cid("cart-idempotency-1"),
          itemId: iid("item-1"),
          quantity: positiveInt(3),
        }

        // 1. First execution creates the stream
        const firstResult = yield* handleAggregateCommand(
          cartId,
          command1,
          createCommandId,
          cartAggregateConfig,
        )
        expect(firstResult.result.processingStatus._tag).toBe("Processed")
        expect(firstResult.result.creationStatus._tag).toBe("CreatedStream")
        expect(firstResult.events.length).toBe(2)
        expect(firstResult.result.nextExpectedStreamVersion).toBe(2)

        // 2. Immediate retry with identical commandId returns cached CreatedStream outcome
        const immediateRetry = yield* handleAggregateCommand(
          cartId,
          command1,
          createCommandId,
          cartAggregateConfig,
        )
        expect(immediateRetry.result.processingStatus._tag).toBe("Deduplicated")
        expect(immediateRetry.result.creationStatus._tag).toBe("CreatedStream")
        expect(immediateRetry.events.length).toBe(0)
        expect(immediateRetry.result.nextExpectedStreamVersion).toBe(2)

        // 3. Subsequent command advances the stream to version 3 (ExistingStream)
        const command2: CartCommand = {
          _tag: "AddItem",
          cartId: cid("cart-idempotency-1"),
          itemId: iid("item-2"),
          quantity: positiveInt(2),
        }
        const secondResult = yield* handleAggregateCommand(
          cartId,
          command2,
          cmdId("cmd-101"),
          cartAggregateConfig,
        )
        expect(secondResult.result.processingStatus._tag).toBe("Processed")
        expect(secondResult.result.creationStatus._tag).toBe("ExistingStream")
        expect(secondResult.result.nextExpectedStreamVersion).toBe(3)

        // 4. Retrying the initial commandId after the stream advanced MUST still return stored CreatedStream & version 2
        const laterRetry = yield* handleAggregateCommand(
          cartId,
          command1,
          createCommandId,
          cartAggregateConfig,
        )
        expect(laterRetry.result.processingStatus._tag).toBe("Deduplicated")
        expect(laterRetry.result.creationStatus._tag).toBe("CreatedStream")
        expect(laterRetry.result.nextExpectedStreamVersion).toBe(2)
        expect(laterRetry.events.length).toBe(0)

        const eventsCount = yield* sql<CountRow>`
          SELECT count(*) as cnt FROM es_events WHERE aggregate_id = ${cartId}
        `
        expect(eventsCount[0]?.cnt).toBe(3)

        // 5. Reusing createCommandId on a different aggregateId fails with CommandAggregateMismatchError
        const otherCartId = aid("cart-idempotency-2")
        const crossAggregateAttempt = handleAggregateCommand(
          otherCartId,
          {
            _tag: "AddItem",
            cartId: cid("cart-idempotency-2"),
            itemId: iid("item-1"),
            quantity: positiveInt(1),
          },
          createCommandId,
          cartAggregateConfig,
        )
        const mismatchErr = yield* Effect.flip(crossAggregateAttempt)
        match(mismatchErr)
          .with({ _tag: "CommandAggregateMismatchError" }, (err) => {
            expect(err.commandId).toBe(createCommandId)
            expect(err.expectedAggregateId).toBe(otherCartId)
            expect(err.actualAggregateId).toBe(cartId)
          })
          .otherwise(() => {
            expect.unreachable("expected CommandAggregateMismatchError")
          })

        // 6. Reusing createCommandId with the SAME cartId but a DIFFERENT aggregateName fails with CommandAggregateMismatchError
        const crossNameAttempt = handleAggregateCommand(cartId, command1, createCommandId, {
          ...cartAggregateConfig,
          aggregateName: AggregateName.make("OtherAggregate"),
        })
        const nameMismatchErr = yield* Effect.flip(crossNameAttempt)
        match(nameMismatchErr)
          .with({ _tag: "CommandAggregateMismatchError" }, (err) => {
            expect(err.commandId).toBe(createCommandId)
            expect(err.expectedAggregateName).toBe("OtherAggregate")
            expect(err.actualAggregateName).toBe("Cart")
          })
          .otherwise(() => {
            expect.unreachable("expected CommandAggregateMismatchError for aggregateName")
          })
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )

  it.effect(
    "REQ-2.1, REQ-2.2 & REQ-2.3: atomically writes events and provides strongly-consistent read-your-writes local projection keyed by AggregateId",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initCartViewTable

        // Use a distinct AggregateId and CartId to prove projection keys by metadata.aggregateId
        const aggregateId = aid("agg-stream-key-1")
        const payloadCartId = cid("domain-cart-payload-1")
        const projections = [cartViewProjection]
        const cartViewName = pName("CartView")

        const cmd1: CartCommand = {
          _tag: "AddItem",
          cartId: payloadCartId,
          itemId: iid("item-A"),
          quantity: positiveInt(2),
        }

        yield* handleAggregateCommand(aggregateId, cmd1, cmdId("cmd-rw-1"), cartAggregateConfig)

        const view1 = yield* queryLocalProjection(projections, cartViewName, aggregateId)
        expect(view1.cartId).toBe(aggregateId)
        expect(view1.status).toBe("active")
        expect(view1.itemCount).toBe(1)
        expect(view1.totalQuantity).toBe(2)

        const cmd2: CartCommand = {
          _tag: "AddItem",
          cartId: payloadCartId,
          itemId: iid("item-B"),
          quantity: positiveInt(5),
        }
        yield* handleAggregateCommand(aggregateId, cmd2, cmdId("cmd-rw-2"), cartAggregateConfig)

        const view2 = yield* queryLocalProjection(projections, cartViewName, aggregateId)
        expect(view2.itemCount).toBe(2)
        expect(view2.totalQuantity).toBe(7)

        const cmd3: CartCommand = {
          _tag: "Checkout",
          cartId: payloadCartId,
          orderId: oid("order-99"),
        }
        yield* handleAggregateCommand(aggregateId, cmd3, cmdId("cmd-rw-3"), cartAggregateConfig)

        const view3 = yield* queryLocalProjection(projections, cartViewName, aggregateId)
        expect(view3.status).toBe("checked_out")
        expect(view3.totalQuantity).toBe(7)
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )

  it.effect(
    "REQ-3.1 & REQ-3.2: rebuilds projection on version mismatch, late registration, or stale stream version, and skips rebuild when up-to-date",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initCartViewTable
        const sql = yield* SqlClient

        const cartId = aid("cart-rebuild-version")
        const cartViewName = pName("CartView")

        // 1. First write events with NO projections registered
        const configWithoutProjections = {
          ...cartAggregateConfig,
          projections: [],
        }
        yield* handleAggregateCommand(
          cartId,
          {
            _tag: "AddItem",
            cartId: cid("cart-rebuild-version"),
            itemId: iid("item-1"),
            quantity: positiveInt(4),
          },
          cmdId("cmd-no-proj-1"),
          configWithoutProjections,
        )

        // 2. Activate later with v1 projection registered: must rebuild from existing stream!
        let rebuildCalls = 0
        const trackedProjectionV1 = LocalProjection.make({
          ...cartViewProjection,
          rebuild: (aggId, events) =>
            Effect.gen(function* () {
              rebuildCalls += 1
              yield* cartViewProjection.rebuild(aggId, events)
            }),
        })
        const configTrackedV1 = {
          ...cartAggregateConfig,
          projections: [trackedProjectionV1],
        }

        const loaded1 = yield* loadAggregate(cartId, configTrackedV1)
        expect(loaded1.currentVersion).toBe(2)
        expect(rebuildCalls).toBe(1)

        // 3. Second load with same projection version and unchanged stream head MUST NOT rebuild
        const loaded2 = yield* loadAggregate(cartId, configTrackedV1)
        expect(loaded2.currentVersion).toBe(2)
        expect(rebuildCalls).toBe(1)

        // 4. Activate with projection version 2: must rebuild and update meta
        const configV2 = {
          ...cartAggregateConfig,
          projections: [cartViewProjectionV2],
        }
        yield* loadAggregate(cartId, configV2)

        const metaV2 = yield* sql<MetaRow>`
          SELECT projection_version, last_stream_version
          FROM es_projections_meta
          WHERE aggregate_id = ${cartId} AND projection_name = 'CartView'
        `
        expect(metaV2[0]?.projection_version).toBe(2)
        expect(metaV2[0]?.last_stream_version).toBe(2)

        // 5. Simulate stale projection (meta last_stream_version lags behind stream head)
        yield* sql`
          UPDATE projection_cart_view SET total_quantity = 999 WHERE cart_id = ${cartId}
        `
        yield* sql`
          UPDATE es_projections_meta SET last_stream_version = 1 WHERE aggregate_id = ${cartId} AND projection_name = 'CartView'
        `
        yield* loadAggregate(cartId, configV2)

        const healedView = yield* queryLocalProjection([cartViewProjectionV2], cartViewName, cartId)
        expect(healedView.totalQuantity).toBe(4)
        expect(healedView.itemCount).toBe(1)
        expect(healedView.status).toBe("active")
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )

  it.effect(
    "REQ-4.1 & REQ-4.2: selective outbox publication writes 0 rows for SuppressOutbox and appends for PublishOutbox",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initCartViewTable
        const sql = yield* SqlClient

        const cartIdNoPublish = aid("cart-no-outbox")
        yield* handleAggregateCommand(
          cartIdNoPublish,
          {
            _tag: "AddItem",
            cartId: cid("cart-no-outbox"),
            itemId: iid("item-1"),
            quantity: positiveInt(1),
          },
          cmdId("cmd-no-pub"),
          cartAggregateConfig,
        )

        const outboxCount1 = yield* sql<CountRow>`
          SELECT count(*) as cnt FROM es_outbox WHERE aggregate_id = ${cartIdNoPublish}
        `
        expect(outboxCount1[0]?.cnt).toBe(0)

        const configWithPublish = {
          ...cartAggregateConfig,
          outboxMode: { _tag: "PublishOutbox" as const },
        }
        const cartIdWithPublish = aid("cart-with-outbox")
        yield* handleAggregateCommand(
          cartIdWithPublish,
          {
            _tag: "AddItem",
            cartId: cid("cart-with-outbox"),
            itemId: iid("item-2"),
            quantity: positiveInt(2),
          },
          cmdId("cmd-with-pub"),
          configWithPublish,
        )

        const outboxCount2 = yield* sql<CountRow>`
          SELECT count(*) as cnt FROM es_outbox WHERE aggregate_id = ${cartIdWithPublish}
        `
        expect(outboxCount2[0]?.cnt).toBe(2)

        // Retry with same commandId must deduplicate and not write additional outbox rows
        const dedupOutboxResult = yield* handleAggregateCommand(
          cartIdWithPublish,
          {
            _tag: "AddItem",
            cartId: cid("cart-with-outbox"),
            itemId: iid("item-2"),
            quantity: positiveInt(2),
          },
          cmdId("cmd-with-pub"),
          configWithPublish,
        )
        expect(dedupOutboxResult.result.processingStatus._tag).toBe("Deduplicated")

        const outboxCountAfterDedup = yield* sql<CountRow>`
          SELECT count(*) as cnt FROM es_outbox WHERE aggregate_id = ${cartIdWithPublish}
        `
        expect(outboxCountAfterDedup[0]?.cnt).toBe(2)
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )

  it.effect(
    "REQ-5.1: fails with ConcurrencyConflictError reporting stored stream head as actualVersion, rolls back uncommitted writes, and leaves non-conflict SqlErrors in the error channel",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initCartViewTable
        const sql = yield* SqlClient

        const cartId = aid("cart-concurrency")
        let injected = false
        const conflictingProjection = LocalProjection.make({
          name: pName("ConflictingProjection"),
          version: ProjectionVersion.make(1),
          model: CartView,
          apply: (event, metadata) =>
            Effect.gen(function* () {
              yield* cartViewProjection.apply(event, metadata)
              if (!injected) {
                injected = true
                const now = Date.now()
                const eventPayload = JSON.stringify({
                  _tag: "ItemAdded",
                  cartId: "cart-concurrency",
                  itemId: "item-sneak",
                  quantity: 1,
                  version: 1,
                })
                const eventMeta = JSON.stringify({
                  aggregateId: "cart-concurrency",
                  streamVersion: 2,
                  commandId: "cmd-sneak",
                  timestamp: now,
                })
                // Insert conflicting version 2 AND a higher version 5 so actual head is 5 (not 2)
                yield* sql`
                  INSERT INTO es_events (
                    aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at
                  ) VALUES
                    ('Cart', ${cartId}, 2, 'cmd-sneak-2', 'ItemAdded', ${eventPayload}, ${eventMeta}, ${now}),
                    ('Cart', ${cartId}, 5, 'cmd-sneak-5', 'ItemAdded', ${eventPayload}, ${eventMeta}, ${now})
                `
              }
            }),
          query: cartViewProjection.query,
          rebuild: cartViewProjection.rebuild,
        })

        const configWithCollision = {
          ...cartAggregateConfig,
          projections: [conflictingProjection],
          outboxMode: { _tag: "PublishOutbox" as const },
        }

        const attempt = handleAggregateCommand(
          cartId,
          {
            _tag: "AddItem",
            cartId: cid("cart-concurrency"),
            itemId: iid("item-1"),
            quantity: positiveInt(1),
          },
          cmdId("cmd-conflict"),
          configWithCollision,
        )

        const result = yield* Effect.flip(attempt)
        match(result)
          .with({ _tag: "ConcurrencyConflictError" }, (err) => {
            expect(err.aggregateId).toBe(cartId)
            expect(err.expectedVersion).toBe(0)
            // Command only emitted 2 events (hoped-for version 2), but es_events head was at version 5!
            expect(err.actualVersion).toBe(5)
          })
          .otherwise(() => {
            expect.unreachable("expected ConcurrencyConflictError")
          })

        // Verify full rollback: events, commands, projection_cart_view, and outbox must be untouched (0 rows)
        const evCnt =
          yield* sql<CountRow>`SELECT count(*) as cnt FROM es_events WHERE aggregate_id = ${cartId}`
        const cmdCnt =
          yield* sql<CountRow>`SELECT count(*) as cnt FROM es_commands WHERE command_id = 'cmd-conflict'`
        const projCnt =
          yield* sql<CountRow>`SELECT count(*) as cnt FROM projection_cart_view WHERE cart_id = ${cartId}`
        const outboxCnt =
          yield* sql<CountRow>`SELECT count(*) as cnt FROM es_outbox WHERE aggregate_id = ${cartId}`
        expect(evCnt[0]?.cnt).toBe(0)
        expect(cmdCnt[0]?.cnt).toBe(0)
        expect(projCnt[0]?.cnt).toBe(0)
        expect(outboxCnt[0]?.cnt).toBe(0)

        // Verify that a non-es_events constraint failure (e.g. NOT NULL on projection table) is NOT misclassified as ConcurrencyConflictError
        const brokenProjection = LocalProjection.make({
          name: pName("BrokenProjection"),
          version: ProjectionVersion.make(1),
          model: CartView,
          apply: () =>
            sql`INSERT INTO projection_cart_view (cart_id, item_count, status, total_quantity) VALUES (${null}, 0, 'active', 0)`.pipe(
              Effect.asVoid,
            ),
          query: cartViewProjection.query,
          rebuild: cartViewProjection.rebuild,
        })

        const brokenAttempt = handleAggregateCommand(
          aid("cart-broken-proj"),
          {
            _tag: "AddItem",
            cartId: cid("cart-broken-proj"),
            itemId: iid("item-1"),
            quantity: positiveInt(1),
          },
          cmdId("cmd-broken-proj"),
          {
            ...cartAggregateConfig,
            projections: [brokenProjection],
          },
        )
        const brokenErr = yield* Effect.flip(brokenAttempt)
        expect(isSqlError(brokenErr)).toBe(true)

        expect(
          isEventStreamUniqueConflict(
            new SqlError({
              reason: new UniqueViolation({
                cause: new Error("unique"),
                constraint:
                  "es_events.aggregate_name, es_events.aggregate_id, es_events.stream_version",
              }),
            }),
          ),
        ).toBe(true)
        expect(
          isEventStreamUniqueConflict(
            new SqlError({
              reason: new UniqueViolation({
                cause: new Error("unique"),
                constraint: "es_commands.command_id",
              }),
            }),
          ),
        ).toBe(false)
        expect(
          isEventStreamUniqueConflict(
            new SqlError({
              reason: new ConstraintError({
                cause: new Error("NOT NULL constraint failed: es_events.payload"),
              }),
            }),
          ),
        ).toBe(false)
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )

  it.effect(
    "REQ-5.2 & REQ-5.3: queryLocalProjection fails with AggregateNotFoundError for missing aggregate and LocalProjectionNotFoundError for unregistered projection name",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initCartViewTable

        const projections = [cartViewProjection]
        const nonExistentId = aid("non-existent-cart")

        const missingAggAttempt = queryLocalProjection(
          projections,
          pName("CartView"),
          nonExistentId,
        )
        const aggError = yield* Effect.flip(missingAggAttempt)
        match(aggError)
          .with({ _tag: "AggregateNotFoundError" }, (err) => {
            expect(err.aggregateId).toBe(nonExistentId)
          })
          .otherwise(() => {
            expect.unreachable("expected AggregateNotFoundError")
          })

        const unregisteredAttempt = queryLocalProjection(
          projections,
          pName("UnregisteredProjection"),
          nonExistentId,
        )
        const projError = yield* Effect.flip(unregisteredAttempt)
        match(projError)
          .with({ _tag: "LocalProjectionNotFoundError" }, (err) => {
            expect(err.name).toBe("UnregisteredProjection")
          })
          .otherwise(() => {
            expect.unreachable("expected LocalProjectionNotFoundError")
          })
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )

  it.effect(
    "handles rejected decide writing nothing, no-op on empty stream returning NoStream, aggregate_name isolation, out-of-order insertion sorting, and non-contiguous stream corruption detection",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initCartViewTable
        const sql = yield* SqlClient

        // 1. Rejected decide writes nothing
        const rejectedCartId = aid("cart-rejected")
        const rejectedAttempt = handleAggregateCommand(
          rejectedCartId,
          {
            _tag: "Checkout",
            cartId: cid("cart-rejected"),
            orderId: oid("ord-1"),
          },
          cmdId("cmd-rejected"),
          cartAggregateConfig,
        )
        const domainErr = yield* Effect.flip(rejectedAttempt)
        match(domainErr)
          .with({ _tag: "EmptyCartCheckoutError" }, (err) => {
            expect(err.cartId).toBe("cart-rejected")
          })
          .otherwise(() => {
            expect.unreachable("expected EmptyCartCheckoutError")
          })

        const rejectedCmdCnt =
          yield* sql<CountRow>`SELECT count(*) as cnt FROM es_commands WHERE command_id = 'cmd-rejected'`
        expect(rejectedCmdCnt[0]?.cnt).toBe(0)

        // 2. No-op decision on an empty stream reports NoStream (not CreatedStream)
        const noOpDecider = Decider.make<CartCommand, CartEvent, CartState, never>({
          initialState: initialCartState,
          evolve: evolveCart,
          decide: Effect.fn("NoOpCart.decide")(() => Effect.succeed([])),
        })
        const noOpConfig: AggregateConfig<CartCommand, CartEvent, CartState, never> = {
          aggregateName: AggregateName.make("NoOpCart"),
          decider: noOpDecider,
          eventSchema: CartEvent,
          outboxMode: { _tag: "SuppressOutbox" },
        }
        const noOpId = aid("cart-noop-empty")
        const noOpRes = yield* handleAggregateCommand(
          noOpId,
          {
            _tag: "AddItem",
            cartId: cid("cart-noop-empty"),
            itemId: iid("item-1"),
            quantity: positiveInt(1),
          },
          cmdId("cmd-noop-1"),
          noOpConfig,
        )
        expect(noOpRes.result.creationStatus._tag).toBe("NoStream")
        expect(noOpRes.result.nextExpectedStreamVersion).toBe(0)

        // Retry no-op command on empty stream
        const noOpRetry = yield* handleAggregateCommand(
          noOpId,
          {
            _tag: "AddItem",
            cartId: cid("cart-noop-empty"),
            itemId: iid("item-1"),
            quantity: positiveInt(1),
          },
          cmdId("cmd-noop-1"),
          noOpConfig,
        )
        expect(noOpRetry.result.processingStatus._tag).toBe("Deduplicated")
        expect(noOpRetry.result.creationStatus._tag).toBe("NoStream")
        expect(noOpRetry.result.nextExpectedStreamVersion).toBe(0)

        // 3. Two different AggregateNames sharing the same AggregateId have isolated streams
        const sharedId = aid("shared-id-1")
        yield* handleAggregateCommand(
          sharedId,
          {
            _tag: "AddItem",
            cartId: cid("shared-id-1"),
            itemId: iid("item-1"),
            quantity: positiveInt(2),
          },
          cmdId("cmd-shared-cart"),
          cartAggregateConfig,
        )
        const otherAggregateLoaded = yield* loadAggregate(sharedId, noOpConfig)
        expect(otherAggregateLoaded.currentVersion).toBe(0)

        // 4. Out-of-insertion-order rows are folded in stream_version ASC order, and non-contiguous gaps fail with EventStreamCorruptionError
        const outOfOrderId = aid("cart-out-of-order")
        const now = Date.now()
        const ev1 = JSON.stringify({ _tag: "CartCreated", cartId: "cart-out-of-order", version: 1 })
        const ev2 = JSON.stringify({
          _tag: "ItemAdded",
          cartId: "cart-out-of-order",
          itemId: "item-ordered",
          quantity: 5,
          version: 1,
        })
        const meta1 = JSON.stringify({
          aggregateId: "cart-out-of-order",
          streamVersion: 1,
          commandId: "c1",
          timestamp: now,
        })
        const meta2 = JSON.stringify({
          aggregateId: "cart-out-of-order",
          streamVersion: 2,
          commandId: "c2",
          timestamp: now,
        })
        // Insert version 2 BEFORE version 1
        yield* sql`
          INSERT INTO es_events (aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at)
          VALUES
            ('Cart', ${outOfOrderId}, 2, 'c2', 'ItemAdded', ${ev2}, ${meta2}, ${now}),
            ('Cart', ${outOfOrderId}, 1, 'c1', 'CartCreated', ${ev1}, ${meta1}, ${now})
        `
        const loadedOrdered = yield* loadAggregate(outOfOrderId, cartAggregateConfig)
        expect(loadedOrdered.currentVersion).toBe(2)
        match(loadedOrdered.state)
          .with({ _tag: "ActiveCart" }, (s) => {
            expect(s.itemCount).toBe(5)
          })
          .otherwise(() => {
            expect.unreachable("expected ActiveCart")
          })

        // Insert version 4 (skipping version 3) -> must fail with EventStreamCorruptionError
        const meta4 = JSON.stringify({
          aggregateId: "cart-out-of-order",
          streamVersion: 4,
          commandId: "c4",
          timestamp: now,
        })
        yield* sql`
          INSERT INTO es_events (aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at)
          VALUES ('Cart', ${outOfOrderId}, 4, 'c4', 'ItemAdded', ${ev2}, ${meta4}, ${now})
        `
        const corruptAttempt = yield* Effect.flip(loadAggregate(outOfOrderId, cartAggregateConfig))
        match(corruptAttempt)
          .with({ _tag: "EventStreamCorruptionError" }, (err) => {
            expect(err.expectedStreamVersion).toBe(3)
            expect(err.actualStreamVersion).toBe(4)
          })
          .otherwise(() => {
            expect.unreachable("expected EventStreamCorruptionError")
          })

        // Float stream_version (1.5) in es_events must fail with EventStreamCorruptionError instead of dying
        const floatId = aid("cart-float-ver")
        yield* sql`
          INSERT INTO es_events (aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at)
          VALUES ('Cart', ${floatId}, 1.5, 'cf', 'CartCreated', ${ev1}, ${meta1}, ${now})
        `
        const floatErr = yield* Effect.flip(loadAggregate(floatId, cartAggregateConfig))
        match(floatErr)
          .with({ _tag: "EventStreamCorruptionError" }, (err) => {
            expect(err.expectedStreamVersion).toBe(1)
            expect(err.actualStreamVersion).toBeUndefined()
            expect(err.reason).toBeDefined()
          })
          .otherwise(() => {
            expect.unreachable("expected EventStreamCorruptionError")
          })

        // Mismatched metadata.aggregateId in es_events must fail with EventStreamCorruptionError
        const mismatchMetaId = aid("cart-meta-mismatch")
        yield* sql`
          INSERT INTO es_events (aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at)
          VALUES ('Cart', ${mismatchMetaId}, 1, 'cm', 'CartCreated', ${ev1}, ${meta1}, ${now})
        `
        const mismatchMetaErr = yield* Effect.flip(
          loadAggregate(mismatchMetaId, cartAggregateConfig),
        )
        match(mismatchMetaErr)
          .with({ _tag: "EventStreamCorruptionError" }, (err) => {
            expect(err.expectedStreamVersion).toBe(1)
          })
          .otherwise(() => {
            expect.unreachable("expected EventStreamCorruptionError")
          })

        // Corrupt empty aggregate_name in es_commands must fail with EventStreamCorruptionError instead of dying
        const corruptCmdId = cmdId("cmd-corrupt-row")
        yield* sql`
          INSERT INTO es_commands (command_id, aggregate_name, aggregate_id, stream_version, result_json, created_at)
          VALUES (${corruptCmdId}, '', ${floatId}, -1, '{}', ${now})
        `
        const corruptCmdErr = yield* Effect.flip(
          handleAggregateCommand(
            floatId,
            {
              _tag: "AddItem",
              cartId: cid("cart-float-ver"),
              itemId: iid("item-1"),
              quantity: positiveInt(1),
            },
            corruptCmdId,
            cartAggregateConfig,
          ),
        )
        match(corruptCmdErr)
          .with({ _tag: "EventStreamCorruptionError" }, (err) => {
            expect(err.actualStreamVersion).toBeUndefined()
            expect(err.reason).toBeDefined()
          })
          .otherwise(() => {
            expect.unreachable("expected EventStreamCorruptionError")
          })

        // 5. Invalid event JSON payload in es_events fails loadAggregate with EventStreamCorruptionError and defined reason
        const invalidPayloadId = aid("cart-invalid-payload")
        yield* sql`
          INSERT INTO es_events (aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at)
          VALUES ('Cart', ${invalidPayloadId}, 1, 'c-bad-json', 'CartCreated', '{not-valid-json', ${meta1}, ${now})
        `
        const badPayloadErr = yield* Effect.flip(
          loadAggregate(invalidPayloadId, cartAggregateConfig),
        )
        match(badPayloadErr)
          .with({ _tag: "EventStreamCorruptionError" }, (err) => {
            expect(err.expectedStreamVersion).toBe(1)
            expect(err.reason).toBeDefined()
          })
          .otherwise(() => {
            expect.unreachable("expected EventStreamCorruptionError for invalid json payload")
          })

        // 6. Corrupt cached result_json in es_commands fails handleAggregateCommand with EventStreamCorruptionError and defined reason
        const corruptResultCmdId = cmdId("cmd-corrupt-result-json")
        const validCartId = aid("cart-corrupt-result")
        yield* sql`
          INSERT INTO es_commands (command_id, aggregate_name, aggregate_id, stream_version, result_json, created_at)
          VALUES (${corruptResultCmdId}, 'Cart', ${validCartId}, 1, '{"broken":true}', ${now})
        `
        const corruptResultErr = yield* Effect.flip(
          handleAggregateCommand(
            validCartId,
            {
              _tag: "AddItem",
              cartId: cid("cart-corrupt-result"),
              itemId: iid("item-1"),
              quantity: positiveInt(1),
            },
            corruptResultCmdId,
            cartAggregateConfig,
          ),
        )
        match(corruptResultErr)
          .with({ _tag: "EventStreamCorruptionError" }, (err) => {
            expect(err.expectedStreamVersion).toBe(1)
            expect(err.actualStreamVersion).toBe(1)
            expect(err.reason).toBeDefined()
          })
          .otherwise(() => {
            expect.unreachable("expected EventStreamCorruptionError for corrupt result_json")
          })

        // 7. Unencodable new event fails handleAggregateCommand with EventSerializationError and defined reason
        const unencodableConfig = {
          ...cartAggregateConfig,
          eventSchema: CartEvent.check(Schema.makeFilter(() => "Serialization disallowed")),
        }
        const unencodableId = aid("cart-unencodable")
        const unencodableAttempt = handleAggregateCommand(
          unencodableId,
          {
            _tag: "AddItem",
            cartId: cid("cart-unencodable"),
            itemId: iid("item-1"),
            quantity: positiveInt(1),
          },
          cmdId("cmd-unencodable"),
          unencodableConfig,
        )
        const serErr = yield* Effect.flip(unencodableAttempt)
        match(serErr)
          .with({ _tag: "EventSerializationError" }, (err) => {
            expect(err.reason).toBeDefined()
          })
          .otherwise(() => {
            expect.unreachable("expected EventSerializationError")
          })
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )

  it.effect(
    "REQ-2.2 & REQ-3.2: direct applyLocalProjection and rebuildLocalProjection update read models cleanly",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initCartViewTable

        const cartId = aid("cart-direct-ops")
        const e1: CartEvent = { _tag: "CartCreated", cartId: cid("cart-direct-ops"), version: 1 }
        const e2: CartEvent = {
          _tag: "ItemAdded",
          cartId: cid("cart-direct-ops"),
          itemId: iid("item-rebuild"),
          quantity: positiveInt(3),
          version: 1,
        }
        const m1 = new EventMetadata({
          aggregateId: cartId,
          streamVersion: StreamVersion.make(1),
          commandId: cmdId("cmd-rb-1"),
          timestamp: TimestampMs.make(Date.now()),
        })
        const m2 = new EventMetadata({
          aggregateId: cartId,
          streamVersion: StreamVersion.make(2),
          commandId: cmdId("cmd-rb-2"),
          timestamp: TimestampMs.make(Date.now()),
        })

        yield* applyLocalProjection(cartViewProjection, e1, m1)
        yield* rebuildLocalProjection(cartViewProjection, cartId, [
          { event: e1, metadata: m1 },
          { event: e2, metadata: m2 },
        ])

        const view = yield* queryLocalProjection([cartViewProjection], pName("CartView"), cartId)
        expect(view.totalQuantity).toBe(3)
        expect(view.itemCount).toBe(1)
      }).pipe(Effect.provide(SqlClientMemoryLayer)),
  )
})
