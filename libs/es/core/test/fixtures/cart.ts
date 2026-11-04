import { Effect, Schema } from "effect"
import { EventSchemaVersion, EventType, PositiveInt, StreamVersion } from "@harness/es-contract"
import { match, P } from "ts-pattern"
import { Decider } from "../../src/decider.js"
import { makeEventUpcaster } from "../../src/evolution.js"

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

export const CheckoutChannel = Schema.NonEmptyString.pipe(Schema.brand("CheckoutChannel"))
export type CheckoutChannel = typeof CheckoutChannel.Type

export const DEFAULT_CHECKOUT_CHANNEL: CheckoutChannel = CheckoutChannel.make("web")

export const CartCreated = Schema.TaggedStruct("CartCreated", {
  cartId: CartId,
  version: Schema.Literal(1),
})
export type CartCreated = typeof CartCreated.Type

export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
  cartId: CartId,
  itemId: ItemId,
  quantity: PositiveInt,
  version: Schema.Literal(1),
})
export type ItemAdded = typeof ItemAdded.Type

export const CartCheckedOut = Schema.TaggedStruct("CartCheckedOut", {
  cartId: CartId,
  orderId: OrderId,
  version: Schema.Literal(1),
})
export type CartCheckedOut = typeof CartCheckedOut.Type

export const CartEvent = Schema.Union([CartCreated, ItemAdded, CartCheckedOut])
export type CartEvent = typeof CartEvent.Type

export const CartCheckedOutV2 = Schema.TaggedStruct("CartCheckedOut", {
  cartId: CartId,
  orderId: OrderId,
  channel: CheckoutChannel,
  version: Schema.Literal(2),
})
export type CartCheckedOutV2 = typeof CartCheckedOutV2.Type

export const cartCheckedOutV1ToV2 = makeEventUpcaster({
  eventType: EventType.make("CartCheckedOut"),
  fromVersion: EventSchemaVersion.make(1),
  toVersion: EventSchemaVersion.make(2),
  from: CartCheckedOut,
  to: CartCheckedOutV2,
  decode: (v1) => ({
    _tag: "CartCheckedOut" as const,
    cartId: v1.cartId,
    orderId: v1.orderId,
    channel: DEFAULT_CHECKOUT_CHANNEL,
    version: 2 as const,
  }),
  encode: (v2) => ({
    _tag: "CartCheckedOut" as const,
    cartId: CartId.make(v2.cartId),
    orderId: OrderId.make(v2.orderId),
    version: 1 as const,
  }),
})

export const CartEventV2 = Schema.Union([CartCreated, ItemAdded, CartCheckedOutV2])
export type CartEventV2 = typeof CartEventV2.Type

export const CartEventV2Codec = Schema.Union([
  CartCreated,
  ItemAdded,
  CartCheckedOutV2,
  cartCheckedOutV1ToV2.schema,
])

export const AddItem = Schema.TaggedStruct("AddItem", {
  cartId: CartId,
  itemId: ItemId,
  quantity: PositiveInt,
})
export type AddItem = typeof AddItem.Type

export const Checkout = Schema.TaggedStruct("Checkout", {
  cartId: CartId,
  orderId: OrderId,
})
export type Checkout = typeof Checkout.Type

export const CartCommand = Schema.Union([AddItem, Checkout])
export type CartCommand = typeof CartCommand.Type

export const CheckoutV2 = Schema.TaggedStruct("Checkout", {
  cartId: CartId,
  orderId: OrderId,
  channel: CheckoutChannel,
})
export type CheckoutV2 = typeof CheckoutV2.Type

export const CartCommandV2 = Schema.Union([AddItem, CheckoutV2])
export type CartCommandV2 = typeof CartCommandV2.Type

export class CartAlreadyCheckedOutError extends Schema.TaggedError<CartAlreadyCheckedOutError>()(
  "CartAlreadyCheckedOutError",
  {
    cartId: CartId,
  },
) {}

export class EmptyCartCheckoutError extends Schema.TaggedError<EmptyCartCheckoutError>()(
  "EmptyCartCheckoutError",
  {
    cartId: CartId,
  },
) {}

export class CartIdMismatchError extends Schema.TaggedError<CartIdMismatchError>()(
  "CartIdMismatchError",
  {
    expectedCartId: CartId,
    actualCartId: CartId,
  },
) {}

export const CartLineItem = Schema.Struct({
  itemId: ItemId,
  quantity: PositiveInt,
})
export type CartLineItem = typeof CartLineItem.Type

export const EmptyCart = Schema.TaggedStruct("EmptyCart", {})
export type EmptyCart = typeof EmptyCart.Type

export const ActiveCart = Schema.TaggedStruct("ActiveCart", {
  cartId: CartId,
  items: Schema.Array(CartLineItem),
  itemCount: ItemCount,
})
export type ActiveCart = typeof ActiveCart.Type

export const CheckedOutCart = Schema.TaggedStruct("CheckedOutCart", {
  cartId: CartId,
  orderId: OrderId,
  totalItems: ItemCount,
})
export type CheckedOutCart = typeof CheckedOutCart.Type

export const CartState = Schema.Union([EmptyCart, ActiveCart, CheckedOutCart])
export type CartState = typeof CartState.Type

export const CheckedOutCartV2 = Schema.TaggedStruct("CheckedOutCart", {
  cartId: CartId,
  orderId: OrderId,
  channel: CheckoutChannel,
  totalItems: ItemCount,
})
export type CheckedOutCartV2 = typeof CheckedOutCartV2.Type

export const CartStateV2 = Schema.Union([EmptyCart, ActiveCart, CheckedOutCartV2])
export type CartStateV2 = typeof CartStateV2.Type

export const initialCartState: CartState = {
  _tag: "EmptyCart",
}

export const initialCartStateV2: CartStateV2 = {
  _tag: "EmptyCart",
}

export const evolveCart = (state: CartState, event: CartEvent): CartState =>
  match(event)
    .with({ _tag: "CartCreated" }, (e) =>
      match(state)
        .with({ _tag: "EmptyCart" }, () => ({
          _tag: "ActiveCart" as const,
          cartId: e.cartId,
          items: [],
          itemCount: ItemCount.make(0),
        }))
        .with({ _tag: "ActiveCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive(),
    )
    .with({ _tag: "ItemAdded" }, (e) =>
      match(state)
        .with({ _tag: "ActiveCart", cartId: P.when((id) => id === e.cartId) }, (s) => ({
          ...s,
          items: [...s.items, { itemId: e.itemId, quantity: e.quantity }],
          itemCount: ItemCount.make(s.itemCount + e.quantity),
        }))
        .with({ _tag: "ActiveCart" }, () => state)
        .with({ _tag: "EmptyCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive(),
    )
    .with({ _tag: "CartCheckedOut" }, (e) =>
      match(state)
        .with({ _tag: "ActiveCart", cartId: P.when((id) => id === e.cartId) }, (s) => ({
          _tag: "CheckedOutCart" as const,
          cartId: s.cartId,
          orderId: e.orderId,
          totalItems: s.itemCount,
        }))
        .with({ _tag: "ActiveCart" }, () => state)
        .with({ _tag: "EmptyCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive(),
    )
    .exhaustive()

export const evolveCartV2 = (state: CartStateV2, event: CartEventV2): CartStateV2 =>
  match(event)
    .with({ _tag: "CartCreated" }, (e) =>
      match(state)
        .with({ _tag: "EmptyCart" }, () => ({
          _tag: "ActiveCart" as const,
          cartId: e.cartId,
          items: [],
          itemCount: ItemCount.make(0),
        }))
        .with({ _tag: "ActiveCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive(),
    )
    .with({ _tag: "ItemAdded" }, (e) =>
      match(state)
        .with({ _tag: "ActiveCart", cartId: P.when((id) => id === e.cartId) }, (s) => ({
          ...s,
          items: [...s.items, { itemId: e.itemId, quantity: e.quantity }],
          itemCount: ItemCount.make(s.itemCount + e.quantity),
        }))
        .with({ _tag: "ActiveCart" }, () => state)
        .with({ _tag: "EmptyCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive(),
    )
    .with({ _tag: "CartCheckedOut" }, (e) =>
      match(state)
        .with({ _tag: "ActiveCart", cartId: P.when((id) => id === e.cartId) }, (s) => ({
          _tag: "CheckedOutCart" as const,
          cartId: s.cartId,
          orderId: e.orderId,
          channel: e.channel,
          totalItems: s.itemCount,
        }))
        .with({ _tag: "ActiveCart" }, () => state)
        .with({ _tag: "EmptyCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive(),
    )
    .exhaustive()

export const decideCart = Effect.fn("Cart.decide")(
  (
    command: CartCommand,
    state: CartState,
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
                version: 1 as const,
              },
            ]),
          )
          .with(
            { _tag: "ActiveCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId,
                }),
              ),
          )
          .with({ _tag: "ActiveCart" }, () =>
            Effect.succeed([
              {
                _tag: "ItemAdded" as const,
                cartId: cmd.cartId,
                itemId: cmd.itemId,
                quantity: cmd.quantity,
                version: 1 as const,
              },
            ]),
          )
          .with(
            { _tag: "CheckedOutCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId,
                }),
              ),
          )
          .with({ _tag: "CheckedOutCart" }, () =>
            Effect.fail(new CartAlreadyCheckedOutError({ cartId: cmd.cartId })),
          )
          .exhaustive(),
      )
      .with({ _tag: "Checkout" }, (cmd) =>
        match(state)
          .with({ _tag: "EmptyCart" }, () =>
            Effect.fail(new EmptyCartCheckoutError({ cartId: cmd.cartId })),
          )
          .with(
            { _tag: "ActiveCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId,
                }),
              ),
          )
          .with(
            { _tag: "ActiveCart" },
            (s) => s.itemCount <= 0,
            () => Effect.fail(new EmptyCartCheckoutError({ cartId: cmd.cartId })),
          )
          .with({ _tag: "ActiveCart" }, () =>
            Effect.succeed([
              {
                _tag: "CartCheckedOut" as const,
                cartId: cmd.cartId,
                orderId: cmd.orderId,
                version: 1 as const,
              },
            ]),
          )
          .with(
            { _tag: "CheckedOutCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId,
                }),
              ),
          )
          .with({ _tag: "CheckedOutCart" }, () =>
            Effect.fail(new CartAlreadyCheckedOutError({ cartId: cmd.cartId })),
          )
          .exhaustive(),
      )
      .exhaustive(),
)

export const decideCartV2 = Effect.fn("Cart.decide")(
  (
    command: CartCommandV2,
    state: CartStateV2,
  ): Effect.Effect<
    ReadonlyArray<CartEventV2>,
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
                version: 1 as const,
              },
            ]),
          )
          .with(
            { _tag: "ActiveCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId,
                }),
              ),
          )
          .with({ _tag: "ActiveCart" }, () =>
            Effect.succeed([
              {
                _tag: "ItemAdded" as const,
                cartId: cmd.cartId,
                itemId: cmd.itemId,
                quantity: cmd.quantity,
                version: 1 as const,
              },
            ]),
          )
          .with(
            { _tag: "CheckedOutCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId,
                }),
              ),
          )
          .with({ _tag: "CheckedOutCart" }, () =>
            Effect.fail(new CartAlreadyCheckedOutError({ cartId: cmd.cartId })),
          )
          .exhaustive(),
      )
      .with({ _tag: "Checkout" }, (cmd) =>
        match(state)
          .with({ _tag: "EmptyCart" }, () =>
            Effect.fail(new EmptyCartCheckoutError({ cartId: cmd.cartId })),
          )
          .with(
            { _tag: "ActiveCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId,
                }),
              ),
          )
          .with(
            { _tag: "ActiveCart" },
            (s) => s.itemCount <= 0,
            () => Effect.fail(new EmptyCartCheckoutError({ cartId: cmd.cartId })),
          )
          .with({ _tag: "ActiveCart" }, () =>
            Effect.succeed([
              {
                _tag: "CartCheckedOut" as const,
                cartId: cmd.cartId,
                orderId: cmd.orderId,
                channel: cmd.channel,
                version: 2 as const,
              },
            ]),
          )
          .with(
            { _tag: "CheckedOutCart" },
            (s) => cmd.cartId !== s.cartId,
            (s) =>
              Effect.fail(
                new CartIdMismatchError({
                  expectedCartId: s.cartId,
                  actualCartId: cmd.cartId,
                }),
              ),
          )
          .with({ _tag: "CheckedOutCart" }, () =>
            Effect.fail(new CartAlreadyCheckedOutError({ cartId: cmd.cartId })),
          )
          .exhaustive(),
      )
      .exhaustive(),
)

export const cartDecider = Decider.make({
  initialState: initialCartState,
  evolve: evolveCart,
  decide: decideCart,
})

export const cartDeciderV2 = Decider.make({
  initialState: initialCartStateV2,
  evolve: evolveCartV2,
  decide: decideCartV2,
})
