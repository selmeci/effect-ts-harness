import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import {
  AggregateId,
  AggregateName,
  AggregateNotFoundError,
  type EventMetadata,
  LocalProjectionNotFoundError,
  PositiveInt,
  ProjectionName,
  ProjectionVersion,
  StreamVersion
} from "@harness/es-contract"
import { match, P } from "ts-pattern"
import { Decider } from "../../src/decider.js"
import type { AggregateConfig } from "../../src/aggregate.js"
import { type HistoricalEvent, LocalProjection } from "../../src/projection.js"

export const positiveInt = Schema.decodeSync(PositiveInt)
export const streamVersion = Schema.decodeSync(StreamVersion)
export const INITIAL_EVENT_VERSION: StreamVersion = streamVersion(1)

export const CartId = Schema.String.pipe(Schema.brand("CartId"))
export type CartId = typeof CartId.Type

export const ItemId = Schema.String.pipe(Schema.brand("ItemId"))
export type ItemId = typeof ItemId.Type

export const OrderId = Schema.String.pipe(Schema.brand("OrderId"))
export type OrderId = typeof OrderId.Type

export const ItemCount = Schema.Natural.pipe(Schema.brand("ItemCount"))
export type ItemCount = typeof ItemCount.Type

export const CartCreated = Schema.TaggedStruct("CartCreated", {
  cartId: CartId,
  version: Schema.Literal(1)
})
export type CartCreated = typeof CartCreated.Type

export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
  cartId: CartId,
  itemId: ItemId,
  quantity: PositiveInt,
  version: Schema.Literal(1)
})
export type ItemAdded = typeof ItemAdded.Type

export const CartCheckedOut = Schema.TaggedStruct("CartCheckedOut", {
  cartId: CartId,
  orderId: OrderId,
  version: Schema.Literal(1)
})
export type CartCheckedOut = typeof CartCheckedOut.Type

export const CartEvent = Schema.Union([CartCreated, ItemAdded, CartCheckedOut])
export type CartEvent = typeof CartEvent.Type

export const AddItem = Schema.TaggedStruct("AddItem", {
  cartId: CartId,
  itemId: ItemId,
  quantity: PositiveInt
})
export type AddItem = typeof AddItem.Type

export const Checkout = Schema.TaggedStruct("Checkout", {
  cartId: CartId,
  orderId: OrderId
})
export type Checkout = typeof Checkout.Type

export const CartCommand = Schema.Union([AddItem, Checkout])
export type CartCommand = typeof CartCommand.Type

export class CartAlreadyCheckedOutError extends Schema.TaggedError<CartAlreadyCheckedOutError>()(
  "CartAlreadyCheckedOutError",
  {
    cartId: CartId
  }
) {}

export class EmptyCartCheckoutError extends Schema.TaggedError<EmptyCartCheckoutError>()(
  "EmptyCartCheckoutError",
  {
    cartId: CartId
  }
) {}

export class CartIdMismatchError extends Schema.TaggedError<CartIdMismatchError>()(
  "CartIdMismatchError",
  {
    expectedCartId: CartId,
    actualCartId: CartId
  }
) {}

export const CartLineItem = Schema.Struct({
  itemId: ItemId,
  quantity: PositiveInt
})
export type CartLineItem = typeof CartLineItem.Type

export const EmptyCart = Schema.TaggedStruct("EmptyCart", {})
export type EmptyCart = typeof EmptyCart.Type

export const ActiveCart = Schema.TaggedStruct("ActiveCart", {
  cartId: CartId,
  items: Schema.Array(CartLineItem),
  itemCount: ItemCount
})
export type ActiveCart = typeof ActiveCart.Type

export const CheckedOutCart = Schema.TaggedStruct("CheckedOutCart", {
  cartId: CartId,
  orderId: OrderId,
  totalItems: ItemCount
})
export type CheckedOutCart = typeof CheckedOutCart.Type

export const CartState = Schema.Union([EmptyCart, ActiveCart, CheckedOutCart])
export type CartState = typeof CartState.Type

export const initialCartState: CartState = {
  _tag: "EmptyCart"
}

export const evolveCart = (state: CartState, event: CartEvent): CartState =>
  match(event)
    .with({ _tag: "CartCreated" }, (e) =>
      match(state)
        .with({ _tag: "EmptyCart" }, () => ({
          _tag: "ActiveCart" as const,
          cartId: e.cartId,
          items: [],
          itemCount: ItemCount.make(0)
        }))
        .with({ _tag: "ActiveCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive()
    )
    .with({ _tag: "ItemAdded" }, (e) =>
      match(state)
        .with(
          { _tag: "ActiveCart", cartId: P.when((id) => id === e.cartId) },
          (s) => ({
            ...s,
            items: [...s.items, { itemId: e.itemId, quantity: e.quantity }],
            itemCount: ItemCount.make(s.itemCount + e.quantity)
          })
        )
        .with({ _tag: "ActiveCart" }, () => state)
        .with({ _tag: "EmptyCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive()
    )
    .with({ _tag: "CartCheckedOut" }, (e) =>
      match(state)
        .with(
          { _tag: "ActiveCart", cartId: P.when((id) => id === e.cartId) },
          (s) => ({
            _tag: "CheckedOutCart" as const,
            cartId: s.cartId,
            orderId: e.orderId,
            totalItems: s.itemCount
          })
        )
        .with({ _tag: "ActiveCart" }, () => state)
        .with({ _tag: "EmptyCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive()
    )
    .exhaustive()

export const decideCart = Effect.fn("Cart.decide")(
  (
    command: CartCommand,
    state: CartState
  ): Effect.Effect<
    ReadonlyArray<CartEvent>,
    CartAlreadyCheckedOutError | EmptyCartCheckoutError | CartIdMismatchError,
    never
  > =>
    match(command)
      .with({ _tag: "AddItem" }, (cmd) =>
        match(state)
          .with({ _tag: "EmptyCart" }, () =>
            Effect.succeed([
              { _tag: "CartCreated" as const, cartId: cmd.cartId, version: 1 as const },
              {
                _tag: "ItemAdded" as const,
                cartId: cmd.cartId,
                itemId: cmd.itemId,
                quantity: cmd.quantity,
                version: 1 as const
              }
            ])
          )
          .with(
            { _tag: "ActiveCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId
                })
              )
          )
          .with({ _tag: "ActiveCart" }, () =>
            Effect.succeed([
              {
                _tag: "ItemAdded" as const,
                cartId: cmd.cartId,
                itemId: cmd.itemId,
                quantity: cmd.quantity,
                version: 1 as const
              }
            ])
          )
          .with(
            { _tag: "CheckedOutCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId
                })
              )
          )
          .with({ _tag: "CheckedOutCart" }, () =>
            Effect.fail(new CartAlreadyCheckedOutError({ cartId: cmd.cartId }))
          )
          .exhaustive()
      )
      .with({ _tag: "Checkout" }, (cmd) =>
        match(state)
          .with({ _tag: "EmptyCart" }, () =>
            Effect.fail(new EmptyCartCheckoutError({ cartId: cmd.cartId }))
          )
          .with(
            { _tag: "ActiveCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId
                })
              )
          )
          .with(
            { _tag: "ActiveCart" },
            (s) => s.itemCount <= 0,
            () => Effect.fail(new EmptyCartCheckoutError({ cartId: cmd.cartId }))
          )
          .with({ _tag: "ActiveCart" }, () =>
            Effect.succeed([
              {
                _tag: "CartCheckedOut" as const,
                cartId: cmd.cartId,
                orderId: cmd.orderId,
                version: 1 as const
              }
            ])
          )
          .with(
            { _tag: "CheckedOutCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId
                })
              )
          )
          .with({ _tag: "CheckedOutCart" }, () =>
            Effect.fail(new CartAlreadyCheckedOutError({ cartId: cmd.cartId }))
          )
          .exhaustive()
      )
      .exhaustive()
)

export const cartDecider = Decider.make({
  initialState: initialCartState,
  evolve: evolveCart,
  decide: decideCart
})

export const CartStatus = Schema.String.pipe(Schema.brand("CartStatus"))
export type CartStatus = typeof CartStatus.Type

export const TotalQuantity = Schema.Natural.pipe(Schema.brand("TotalQuantity"))
export type TotalQuantity = typeof TotalQuantity.Type

export class CartView extends Schema.Class<CartView>("CartView")({
  cartId: AggregateId,
  itemCount: ItemCount,
  status: CartStatus,
  totalQuantity: TotalQuantity
}) {}

interface CartViewRow {
  readonly cart_id: string
  readonly item_count: number
  readonly status: string
  readonly total_quantity: number
}

export const initCartViewTable: Effect.Effect<void, never, SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_cart_view (
        cart_id TEXT PRIMARY KEY,
        item_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        total_quantity INTEGER NOT NULL
      );
    `
  }
).pipe(Effect.orDie)

export const applyCartView = (
  event: CartEvent,
  _metadata: EventMetadata
): Effect.Effect<void, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const effect = match(event)
      .with({ _tag: "CartCreated" }, (e) =>
        sql`
          INSERT INTO projection_cart_view (cart_id, item_count, status, total_quantity)
          VALUES (${e.cartId}, 0, 'active', 0)
          ON CONFLICT (cart_id) DO NOTHING
        `
      )
      .with({ _tag: "ItemAdded" }, (e) =>
        sql`
          INSERT INTO projection_cart_view (cart_id, item_count, status, total_quantity)
          VALUES (${e.cartId}, 1, 'active', ${e.quantity})
          ON CONFLICT (cart_id) DO UPDATE SET
            item_count = item_count + 1,
            total_quantity = total_quantity + ${e.quantity}
        `
      )
      .with({ _tag: "CartCheckedOut" }, (e) =>
        sql`
          UPDATE projection_cart_view
          SET status = 'checked_out'
          WHERE cart_id = ${e.cartId}
        `
      )
      .exhaustive()
    yield* effect.pipe(Effect.orDie)
  })

export const queryCartView = (
  aggregateId: AggregateId
): Effect.Effect<CartView, AggregateNotFoundError | LocalProjectionNotFoundError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<CartViewRow>`
      SELECT cart_id, item_count, status, total_quantity
      FROM projection_cart_view
      WHERE cart_id = ${aggregateId}
    `.pipe(Effect.orDie)
    const row = rows[0]
    if (row === undefined) {
      return yield* new AggregateNotFoundError({ aggregateId })
    }
    return new CartView({
      cartId: AggregateId.make(row.cart_id),
      itemCount: ItemCount.make(row.item_count),
      status: CartStatus.make(row.status),
      totalQuantity: TotalQuantity.make(row.total_quantity)
    })
  })

export const rebuildCartView = (
  events: ReadonlyArray<HistoricalEvent<CartEvent>>
): Effect.Effect<void, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    if (events.length > 0 && events[0] !== undefined) {
      const firstEvent = events[0].event
      const cartId = firstEvent.cartId
      yield* sql`DELETE FROM projection_cart_view WHERE cart_id = ${cartId}`.pipe(
        Effect.orDie
      )
    }
    for (const h of events) {
      yield* applyCartView(h.event, h.metadata)
    }
  })

export const cartViewProjection: LocalProjection<CartEvent, CartView> = LocalProjection.make({
  name: ProjectionName.make("CartView"),
  version: ProjectionVersion.make(1),
  model: CartView,
  apply: applyCartView,
  query: queryCartView,
  rebuild: rebuildCartView
})

export const cartViewProjectionV2: LocalProjection<CartEvent, CartView> = LocalProjection.make({
  name: ProjectionName.make("CartView"),
  version: ProjectionVersion.make(2),
  model: CartView,
  apply: applyCartView,
  query: queryCartView,
  rebuild: rebuildCartView
})

export const cartAggregateConfig: AggregateConfig<
  CartCommand,
  CartEvent,
  CartState,
  CartAlreadyCheckedOutError | EmptyCartCheckoutError | CartIdMismatchError
> = {
  aggregateName: AggregateName.make("Cart"),
  decider: cartDecider,
  eventSchema: CartEvent,
  projections: [cartViewProjection],
  publish: false
}
