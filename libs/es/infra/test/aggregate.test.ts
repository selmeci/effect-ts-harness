import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import {
  AggregateId,
  CommandId,
  EventMetadata,
  PositiveInt,
  ProjectionName,
  ProjectionVersion,
  StreamVersion,
  TimestampMs
} from "@harness/es-contract"
import {
  applyLocalProjection,
  handleAggregateCommand,
  loadAggregate,
  queryLocalProjection,
  rebuildLocalProjection
} from "@harness/es-core"
import {
  cartAggregateConfig,
  CartCommand,
  CartEvent,
  CartId,
  cartViewProjection,
  cartViewProjectionV2,
  initCartViewTable,
  ItemId,
  OrderId
} from "@harness/es-core/fixtures/cart"
import { match } from "ts-pattern"
import { initializeAggregateTables, SqlClientMemoryLayer } from "../src/index.js"

const cid = (v: string) => CartId.make(v)
const iid = (v: string) => ItemId.make(v)
const oid = (v: string) => OrderId.make(v)
const aid = (v: string) => AggregateId.make(v)
const cmdId = (v: string) => CommandId.make(v)
const positiveInt = Schema.decodeSync(PositiveInt)

interface CountRow {
  readonly cnt: number
}

interface MetaRow {
  readonly projection_version: number
  readonly last_stream_version: number
}

describe("Aggregate Engine, Local Projections, and Command Idempotency", () => {
  it.effect("REQ-1.1 & REQ-1.2: deduplicates duplicate commands without appending duplicate events", () =>
    Effect.gen(function* () {
      yield* initializeAggregateTables()
      yield* initCartViewTable
      const sql = yield* SqlClient

      const cartId = aid("cart-idempotency-1")
      const commandId = cmdId("cmd-100")
      const command: CartCommand = {
        _tag: "AddItem",
        cartId: cid("cart-idempotency-1"),
        itemId: iid("item-1"),
        quantity: positiveInt(3)
      }

      // 1. First execution: should be processed
      const firstResult = yield* handleAggregateCommand(
        cartId,
        command,
        commandId,
        cartAggregateConfig
      )
      expect(firstResult.result.processingStatus._tag).toBe("Processed")
      expect(firstResult.events.length).toBe(2) // CartCreated + ItemAdded
      expect(firstResult.result.nextExpectedStreamVersion).toBe(2)

      const eventsCount1 = yield* sql<CountRow>`
        SELECT count(*) as cnt FROM es_events WHERE aggregate_id = ${cartId}
      `
      expect(eventsCount1[0]?.cnt).toBe(2)

      const commandsCount1 = yield* sql<CountRow>`
        SELECT count(*) as cnt FROM es_commands WHERE command_id = ${commandId}
      `
      expect(commandsCount1[0]?.cnt).toBe(1)

      // 2. Second execution with identical commandId: should return cached result without appending events
      const duplicateResult = yield* handleAggregateCommand(
        cartId,
        command,
        commandId,
        cartAggregateConfig
      )
      expect(duplicateResult.result.processingStatus._tag).toBe("Deduplicated")
      expect(duplicateResult.events.length).toBe(0)
      expect(duplicateResult.result.nextExpectedStreamVersion).toBe(2)

      const eventsCount2 = yield* sql<CountRow>`
        SELECT count(*) as cnt FROM es_events WHERE aggregate_id = ${cartId}
      `
      expect(eventsCount2[0]?.cnt).toBe(2) // No new events added!
    }).pipe(Effect.provide(SqlClientMemoryLayer))
  )

  it.effect("REQ-2.1, REQ-2.2 & REQ-2.3: atomically writes events and provides strongly-consistent read-your-writes local projection", () =>
    Effect.gen(function* () {
      yield* initializeAggregateTables()
      yield* initCartViewTable

      const cartId = aid("cart-read-your-writes")
      const cmd1: CartCommand = {
        _tag: "AddItem",
        cartId: cid("cart-read-your-writes"),
        itemId: iid("item-A"),
        quantity: positiveInt(2)
      }

      yield* handleAggregateCommand(cartId, cmd1, cmdId("cmd-rw-1"), cartAggregateConfig)

      // Query local projection immediately
      const view1 = yield* queryLocalProjection(cartViewProjection, cartId)
      expect(view1.cartId).toBe(cartId)
      expect(view1.status).toBe("active")
      expect(view1.itemCount).toBe(1)
      expect(view1.totalQuantity).toBe(2)

      // Add another item
      const cmd2: CartCommand = {
        _tag: "AddItem",
        cartId: cid("cart-read-your-writes"),
        itemId: iid("item-B"),
        quantity: positiveInt(5)
      }
      yield* handleAggregateCommand(cartId, cmd2, cmdId("cmd-rw-2"), cartAggregateConfig)

      const view2 = yield* queryLocalProjection(cartViewProjection, cartId)
      expect(view2.itemCount).toBe(2)
      expect(view2.totalQuantity).toBe(7)

      // Checkout cart
      const cmd3: CartCommand = {
        _tag: "Checkout",
        cartId: cid("cart-read-your-writes"),
        orderId: oid("order-99")
      }
      yield* handleAggregateCommand(cartId, cmd3, cmdId("cmd-rw-3"), cartAggregateConfig)

      const view3 = yield* queryLocalProjection(cartViewProjection, cartId)
      expect(view3.status).toBe("checked_out")
      expect(view3.totalQuantity).toBe(7)
    }).pipe(Effect.provide(SqlClientMemoryLayer))
  )

  it.effect("REQ-3.1 & REQ-3.2: rebuilds local projection from stream upon activating bumped projection version", () =>
    Effect.gen(function* () {
      yield* initializeAggregateTables()
      yield* initCartViewTable
      const sql = yield* SqlClient

      const cartId = aid("cart-rebuild-version")
      const cmd1: CartCommand = {
        _tag: "AddItem",
        cartId: cid("cart-rebuild-version"),
        itemId: iid("item-1"),
        quantity: positiveInt(4)
      }
      yield* handleAggregateCommand(cartId, cmd1, cmdId("cmd-v1-1"), cartAggregateConfig)

      // Verify metadata is at version 1
      const metaV1 = yield* sql<MetaRow>`
        SELECT projection_version, last_stream_version
        FROM es_projections_meta
        WHERE aggregate_id = ${cartId} AND projection_name = 'CartView'
      `
      expect(metaV1[0]?.projection_version).toBe(1)

      // Activate with projection version 2
      const configV2 = {
        ...cartAggregateConfig,
        projections: [cartViewProjectionV2]
      }
      const loaded = yield* loadAggregate(cartId, configV2)
      expect(loaded.currentVersion).toBe(2)

      // Verify metadata was updated to version 2
      const metaV2 = yield* sql<MetaRow>`
        SELECT projection_version, last_stream_version
        FROM es_projections_meta
        WHERE aggregate_id = ${cartId} AND projection_name = 'CartView'
      `
      expect(metaV2[0]?.projection_version).toBe(2)

      // Rebuilt projection equals incremental read model
      const viewV2 = yield* queryLocalProjection(cartViewProjectionV2, cartId)
      expect(viewV2.totalQuantity).toBe(4)
      expect(viewV2.itemCount).toBe(1)
      expect(viewV2.status).toBe("active")
    }).pipe(Effect.provide(SqlClientMemoryLayer))
  )

  it.effect("REQ-4.1 & REQ-4.2: selective outbox publication writes 0 rows when publish is false, and appends when true", () =>
    Effect.gen(function* () {
      yield* initializeAggregateTables()
      yield* initCartViewTable
      const sql = yield* SqlClient

      // 1. publish: false (default cartAggregateConfig)
      const cartIdNoPublish = aid("cart-no-outbox")
      const cmdNoPublish: CartCommand = {
        _tag: "AddItem",
        cartId: cid("cart-no-outbox"),
        itemId: iid("item-1"),
        quantity: positiveInt(1)
      }
      yield* handleAggregateCommand(
        cartIdNoPublish,
        cmdNoPublish,
        cmdId("cmd-no-pub"),
        cartAggregateConfig
      )

      const outboxCount1 = yield* sql<CountRow>`
        SELECT count(*) as cnt FROM es_outbox WHERE aggregate_id = ${cartIdNoPublish}
      `
      expect(outboxCount1[0]?.cnt).toBe(0)

      // 2. publish: true
      const configWithPublish = {
        ...cartAggregateConfig,
        publish: true
      }
      const cartIdWithPublish = aid("cart-with-outbox")
      const cmdWithPublish: CartCommand = {
        _tag: "AddItem",
        cartId: cid("cart-with-outbox"),
        itemId: iid("item-2"),
        quantity: positiveInt(2)
      }
      yield* handleAggregateCommand(
        cartIdWithPublish,
        cmdWithPublish,
        cmdId("cmd-with-pub"),
        configWithPublish
      )

      const outboxCount2 = yield* sql<CountRow>`
        SELECT count(*) as cnt FROM es_outbox WHERE aggregate_id = ${cartIdWithPublish}
      `
      expect(outboxCount2[0]?.cnt).toBe(2) // CartCreated + ItemAdded in outbox!
    }).pipe(Effect.provide(SqlClientMemoryLayer))
  )

  it.effect("REQ-5.1: fails with ConcurrencyConflictError on stream version collision", () =>
    Effect.gen(function* () {
      yield* initializeAggregateTables()
      yield* initCartViewTable
      const sql = yield* SqlClient

      const cartId = aid("cart-concurrency")
      let injected = false
      const conflictingProjection = {
        name: ProjectionName.make("ConflictingProjection"),
        version: ProjectionVersion.make(1),
        model: Schema.Struct({}),
        apply: () =>
          Effect.gen(function* () {
            if (!injected) {
              injected = true
              const now = Date.now()
              const eventPayload = JSON.stringify({
                _tag: "ItemAdded",
                cartId: "cart-concurrency",
                itemId: "item-sneak",
                quantity: 1,
                version: 1
              })
              const eventMeta = JSON.stringify({
                aggregateId: "cart-concurrency",
                streamVersion: 2,
                commandId: "cmd-sneak",
                timestamp: now
              })
              yield* sql`
                INSERT INTO es_events (
                  aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at
                ) VALUES (
                  ${cartId}, 2, 'cmd-sneak', 'ItemAdded', ${eventPayload}, ${eventMeta}, ${now}
                )
              `
            }
          }).pipe(Effect.orDie),
        query: () => Effect.die("not implemented"),
        rebuild: () => Effect.void
      }

      const configWithCollision = {
        ...cartAggregateConfig,
        projections: [conflictingProjection]
      }

      const attempt = handleAggregateCommand(
        cartId,
        {
          _tag: "AddItem",
          cartId: cid("cart-concurrency"),
          itemId: iid("item-1"),
          quantity: positiveInt(1)
        },
        cmdId("cmd-conflict"),
        configWithCollision
      )

      const result = yield* Effect.flip(attempt)
      match(result)
        .with({ _tag: "ConcurrencyConflictError" }, (err) => {
          expect(err.aggregateId).toBe(cartId)
          expect(err.expectedVersion).toBe(0)
          expect(err.actualVersion).toBe(2)
        })
        .otherwise(() => {
          expect.unreachable("expected ConcurrencyConflictError")
        })
    }).pipe(Effect.provide(SqlClientMemoryLayer))
  )

  it.effect("REQ-5.2: queryLocalProjection fails with AggregateNotFoundError when aggregate does not exist", () =>
    Effect.gen(function* () {
      yield* initializeAggregateTables()
      yield* initCartViewTable

      const nonExistentId = aid("non-existent-cart")
      const attempt = queryLocalProjection(cartViewProjection, nonExistentId)
      const error = yield* Effect.flip(attempt)

      match(error)
        .with({ _tag: "AggregateNotFoundError" }, (err) => {
          expect(err.aggregateId).toBe(nonExistentId)
        })
        .otherwise(() => {
          expect.unreachable("expected AggregateNotFoundError")
        })
    }).pipe(Effect.provide(SqlClientMemoryLayer))
  )

  it.effect("REQ-2.2: LocalProjection.apply synchronously updates projection tables", () =>
    Effect.gen(function* () {
      yield* initializeAggregateTables()
      yield* initCartViewTable

      const cartId = aid("cart-apply-direct")
      const event: CartEvent = {
        _tag: "CartCreated",
        cartId: cid("cart-apply-direct"),
        version: 1
      }
      const metadata = new EventMetadata({
        aggregateId: cartId,
        streamVersion: StreamVersion.make(1),
        commandId: cmdId("cmd-apply-1"),
        timestamp: TimestampMs.make(Date.now())
      })

      yield* applyLocalProjection(cartViewProjection, event, metadata)
      const view = yield* queryLocalProjection(cartViewProjection, cartId)
      expect(view.status).toBe("active")
      expect(view.itemCount).toBe(0)
    }).pipe(Effect.provide(SqlClientMemoryLayer))
  )

  it.effect("REQ-3.2: LocalProjection.rebuild purges existing state and replays historical events", () =>
    Effect.gen(function* () {
      yield* initializeAggregateTables()
      yield* initCartViewTable

      const cartId = aid("cart-rebuild-direct")
      const e1: CartEvent = { _tag: "CartCreated", cartId: cid("cart-rebuild-direct"), version: 1 }
      const e2: CartEvent = {
        _tag: "ItemAdded",
        cartId: cid("cart-rebuild-direct"),
        itemId: iid("item-rebuild"),
        quantity: positiveInt(3),
        version: 1
      }
      const m1 = new EventMetadata({
        aggregateId: cartId,
        streamVersion: StreamVersion.make(1),
        commandId: cmdId("cmd-rb-1"),
        timestamp: TimestampMs.make(Date.now())
      })
      const m2 = new EventMetadata({
        aggregateId: cartId,
        streamVersion: StreamVersion.make(2),
        commandId: cmdId("cmd-rb-2"),
        timestamp: TimestampMs.make(Date.now())
      })

      yield* rebuildLocalProjection(cartViewProjection, [
        { event: e1, metadata: m1 },
        { event: e2, metadata: m2 }
      ])

      const view = yield* queryLocalProjection(cartViewProjection, cartId)
      expect(view.totalQuantity).toBe(3)
      expect(view.itemCount).toBe(1)
    }).pipe(Effect.provide(SqlClientMemoryLayer))
  )
})
