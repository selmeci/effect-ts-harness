import { Effect, Schema } from "effect"
import { PositiveInt, StreamVersion } from "@harness/es-contract"
import { match, P } from "ts-pattern"
import { Decider } from "../../src/decider.js"

export const positiveInt = Schema.decodeSync(PositiveInt)
export const streamVersion = Schema.decodeSync(StreamVersion)
export const INITIAL_EVENT_VERSION: StreamVersion = streamVersion(1)

export const CartCreated = Schema.TaggedStruct("CartCreated", {
  cartId: Schema.String,
  version: Schema.Literal(1)
})
export type CartCreated = typeof CartCreated.Type

export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
  cartId: Schema.String,
  itemId: Schema.String,
  quantity: PositiveInt,
  version: Schema.Literal(1)
})
export type ItemAdded = typeof ItemAdded.Type

export const CartCheckedOut = Schema.TaggedStruct("CartCheckedOut", {
  cartId: Schema.String,
  orderId: Schema.String,
  version: Schema.Literal(1)
})
export type CartCheckedOut = typeof CartCheckedOut.Type

export const CartEvent = Schema.Union([CartCreated, ItemAdded, CartCheckedOut])
export type CartEvent = typeof CartEvent.Type

export const AddItem = Schema.TaggedStruct("AddItem", {
  cartId: Schema.String,
  itemId: Schema.String,
  quantity: PositiveInt
})
export type AddItem = typeof AddItem.Type

export const Checkout = Schema.TaggedStruct("Checkout", {
  cartId: Schema.String,
  orderId: Schema.String
})
export type Checkout = typeof Checkout.Type

export const CartCommand = Schema.Union([AddItem, Checkout])
export type CartCommand = typeof CartCommand.Type

export class CartAlreadyCheckedOutError extends Schema.TaggedError<CartAlreadyCheckedOutError>()(
  "CartAlreadyCheckedOutError",
  {
    cartId: Schema.String
  }
) {}

export class EmptyCartCheckoutError extends Schema.TaggedError<EmptyCartCheckoutError>()(
  "EmptyCartCheckoutError",
  {
    cartId: Schema.String
  }
) {}

export class CartIdMismatchError extends Schema.TaggedError<CartIdMismatchError>()(
  "CartIdMismatchError",
  {
    expectedCartId: Schema.String,
    actualCartId: Schema.String
  }
) {}

export const CartLineItem = Schema.Struct({
  itemId: Schema.String,
  quantity: PositiveInt
})
export type CartLineItem = typeof CartLineItem.Type

export const EmptyCart = Schema.TaggedStruct("EmptyCart", {})
export type EmptyCart = typeof EmptyCart.Type

export const ActiveCart = Schema.TaggedStruct("ActiveCart", {
  cartId: Schema.String,
  items: Schema.Array(CartLineItem),
  itemCount: Schema.Natural
})
export type ActiveCart = typeof ActiveCart.Type

export const CheckedOutCart = Schema.TaggedStruct("CheckedOutCart", {
  cartId: Schema.String,
  orderId: Schema.String,
  totalItems: Schema.Natural
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
          itemCount: 0
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
            itemCount: s.itemCount + e.quantity
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
