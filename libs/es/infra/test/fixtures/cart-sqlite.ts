import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  AggregateId,
  AggregateName,
  AggregateNotFoundError,
  type EventMetadata,
  ProjectionName,
  ProjectionVersion,
} from "@harness/es-contract"
import { type AggregateConfig, type HistoricalEvent, LocalProjection } from "@harness/es-core"
import {
  type CartAlreadyCheckedOutError,
  type CartCommand,
  cartDecider,
  CartEvent,
  type CartIdMismatchError,
  type CartState,
  type EmptyCartCheckoutError,
  ItemCount,
} from "@harness/es-core/fixtures/cart"
import { match } from "ts-pattern"

export const CartStatus = Schema.String.pipe(Schema.brand("CartStatus"))
export type CartStatus = typeof CartStatus.Type

export const TotalQuantity = Schema.Natural.pipe(Schema.brand("TotalQuantity"))
export type TotalQuantity = typeof TotalQuantity.Type

export class CartView extends Schema.Class<CartView>("CartView")({
  cartId: AggregateId,
  itemCount: ItemCount,
  status: CartStatus,
  totalQuantity: TotalQuantity,
}) {}

interface CartViewRow {
  readonly cart_id: string
  readonly item_count: number
  readonly status: string
  readonly total_quantity: number
}

export const initCartViewTable: Effect.Effect<void, SqlError, SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`
      CREATE TABLE IF NOT EXISTS projection_cart_view (
        cart_id TEXT PRIMARY KEY NOT NULL,
        item_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        total_quantity INTEGER NOT NULL
      );
    `
})

export const applyCartView = (
  event: CartEvent,
  metadata: EventMetadata,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const targetAggregateId = metadata.aggregateId
    yield* match(event)
      .with({ _tag: "CartCreated" }, () =>
        sql`
          INSERT INTO projection_cart_view (cart_id, item_count, status, total_quantity)
          VALUES (${targetAggregateId}, 0, 'active', 0)
          ON CONFLICT (cart_id) DO NOTHING
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "ItemAdded" }, (e) =>
        sql`
          INSERT INTO projection_cart_view (cart_id, item_count, status, total_quantity)
          VALUES (${targetAggregateId}, 1, 'active', ${e.quantity})
          ON CONFLICT (cart_id) DO UPDATE SET
            item_count = item_count + 1,
            total_quantity = total_quantity + ${e.quantity}
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "CartCheckedOut" }, () =>
        sql`
          INSERT INTO projection_cart_view (cart_id, item_count, status, total_quantity)
          VALUES (${targetAggregateId}, 0, 'checked_out', 0)
          ON CONFLICT (cart_id) DO UPDATE SET
            status = 'checked_out'
        `.pipe(Effect.asVoid),
      )
      .exhaustive()
  })

export const queryCartView = (
  aggregateId: AggregateId,
): Effect.Effect<CartView, AggregateNotFoundError | SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<CartViewRow>`
      SELECT cart_id, item_count, status, total_quantity
      FROM projection_cart_view
      WHERE cart_id = ${aggregateId}
    `
    const row = rows[0]
    if (row === undefined) {
      return yield* new AggregateNotFoundError({ aggregateId })
    }
    return new CartView({
      cartId: AggregateId.make(row.cart_id),
      itemCount: ItemCount.make(row.item_count),
      status: CartStatus.make(row.status),
      totalQuantity: TotalQuantity.make(row.total_quantity),
    })
  })

export const rebuildCartView = (
  aggregateId: AggregateId,
  events: ReadonlyArray<HistoricalEvent<CartEvent>>,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`DELETE FROM projection_cart_view WHERE cart_id = ${aggregateId}`
    for (const h of events) {
      yield* applyCartView(h.event, h.metadata)
    }
  })

export const cartViewProjection: LocalProjection<CartEvent, CartView, SqlClient, SqlError> =
  LocalProjection.make({
    name: ProjectionName.make("CartView"),
    version: ProjectionVersion.make(1),
    model: CartView,
    apply: applyCartView,
    query: queryCartView,
    rebuild: rebuildCartView,
  })

export const cartViewProjectionV2: LocalProjection<CartEvent, CartView, SqlClient, SqlError> =
  LocalProjection.make({
    name: ProjectionName.make("CartView"),
    version: ProjectionVersion.make(2),
    model: CartView,
    apply: applyCartView,
    query: queryCartView,
    rebuild: rebuildCartView,
  })

export const cartAggregateConfig: AggregateConfig<
  CartCommand,
  CartEvent,
  CartState,
  CartAlreadyCheckedOutError | EmptyCartCheckoutError | CartIdMismatchError,
  SqlClient,
  SqlError
> = {
  aggregateName: AggregateName.make("Cart"),
  decider: cartDecider,
  eventSchema: CartEvent,
  projections: [cartViewProjection],
  outboxMode: { _tag: "SuppressOutbox" },
}
