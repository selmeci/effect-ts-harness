import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Equal, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AddItem,
  CartCommand,
  CartEvent,
  type CartState,
  decideCart,
  evolveCart,
  initialCartState,
  ItemAdded,
  positiveInt
} from "./fixtures/cart.js"

describe("Cart Reducer Property-Based Tests", () => {
  it.prop(
    "satisfies chunked fold equivalence across arbitrary CartEvent streams",
    {
      events: Schema.Array(CartEvent),
      splitRatio: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
    },
    ({ events, splitRatio }) => {
      const k = Math.floor(events.length * splitRatio)
      const fullFold = events.reduce(evolveCart, initialCartState)
      const firstChunkState = events.slice(0, k).reduce(evolveCart, initialCartState)
      const chunkedFold = events.slice(k).reduce(evolveCart, firstChunkState)

      expect(Equal.equals(chunkedFold, fullFold)).toBe(true)
    }
  )

  it.prop(
    "produces deterministic state transitions identical across repeated evaluations",
    {
      events: Schema.Array(CartEvent)
    },
    ({ events }) => {
      const state1 = events.reduce(evolveCart, initialCartState)
      const state2 = events.reduce(evolveCart, initialCartState)
      expect(Equal.equals(state1, state2)).toBe(true)
    }
  )

  it.prop(
    "preserves terminal status when subsequent events are applied in CheckedOutCart state",
    {
      subsequentEvents: Schema.Array(CartEvent)
    },
    ({ subsequentEvents }) => {
      const checkedOutState = [
        { _tag: "CartCreated" as const, cartId: "c-1", version: 1 as const },
        {
          _tag: "ItemAdded" as const,
          cartId: "c-1",
          itemId: "i-1",
          quantity: positiveInt(4),
          version: 1 as const
        },
        { _tag: "CartCheckedOut" as const, cartId: "c-1", orderId: "o-1", version: 1 as const }
      ].reduce(evolveCart, initialCartState)
      const finalState = subsequentEvents.reduce(evolveCart, checkedOutState)
      match(finalState)
        .with({ _tag: "CheckedOutCart" }, (s) => {
          expect(s.cartId).toBe("c-1")
          expect(s.orderId).toBe("o-1")
          expect(s.totalItems).toBe(4)
        })
        .with({ _tag: "ActiveCart" }, () => {
          expect.unreachable("Expected CheckedOutCart")
        })
        .with({ _tag: "EmptyCart" }, () => {
          expect.unreachable("Expected CheckedOutCart")
        })
        .exhaustive()
    }
  )

  it.prop(
    "accumulates items and itemCount accurately across arbitrary ItemAdded batches for the active cart",
    {
      additions: Schema.Array(ItemAdded)
    },
    ({ additions }) => {
      const cartId = "cart-prop"
      const normalizedAdditions = additions.map((ev) => ({
        ...ev,
        cartId
      }))
      const initialState: CartState = {
        _tag: "ActiveCart",
        cartId,
        items: [],
        itemCount: 0
      }
      const finalState = normalizedAdditions.reduce(evolveCart, initialState)
      const expectedTotal = normalizedAdditions.reduce((acc, ev) => acc + ev.quantity, 0)

      match(finalState)
        .with({ _tag: "ActiveCart" }, (s) => {
          expect(s.items.length).toBe(additions.length)
          expect(s.itemCount).toBe(expectedTotal)
          expect(
            Equal.equals(
              s.items,
              normalizedAdditions.map((a) => ({ itemId: a.itemId, quantity: a.quantity }))
            )
          ).toBe(true)
        })
        .with({ _tag: "EmptyCart" }, () => {
          expect.unreachable("Expected ActiveCart")
        })
        .with({ _tag: "CheckedOutCart" }, () => {
          expect.unreachable("Expected ActiveCart")
        })
        .exhaustive()
    }
  )
})

describe("Cart Decider Property-Based Tests", () => {
  it.effect.prop(
    "decideCart succeeds and emits ItemAdded for any valid AddItem on active cart",
    {
      command: AddItem
    },
    ({ command }) =>
      Effect.gen(function* () {
        const activeState: CartState = {
          _tag: "ActiveCart",
          cartId: command.cartId,
          items: [],
          itemCount: 0
        }
        const events = yield* decideCart(command, activeState)
        expect(events.length).toBe(1)
        const [firstEvent] = events
        match(firstEvent)
          .with({ _tag: "ItemAdded" }, (ev) => {
            expect(ev.cartId).toBe(command.cartId)
            expect(ev.itemId).toBe(command.itemId)
            expect(ev.quantity).toBe(command.quantity)
          })
          .with({ _tag: "CartCreated" }, () => {
            expect.unreachable("Expected ItemAdded")
          })
          .with({ _tag: "CartCheckedOut" }, () => {
            expect.unreachable("Expected ItemAdded")
          })
          .with(undefined, () => {
            expect.unreachable("Expected at least one event")
          })
          .exhaustive()
      })
  )

  it.effect.prop(
    "decideCart fails with CartAlreadyCheckedOutError for any command on CheckedOutCart",
    {
      command: CartCommand
    },
    ({ command }) =>
      Effect.gen(function* () {
        const checkedOutState: CartState = {
          _tag: "CheckedOutCart",
          cartId: command.cartId,
          orderId: "o-1",
          totalItems: 5
        }
        const exit = yield* Effect.exit(decideCart(command, checkedOutState))
        match(exit)
          .with({ _tag: "Failure" }, (f) => {
            const errOpt = Cause.findErrorOption(f.cause)
            match(errOpt)
              .with({ _tag: "Some" }, (some) => {
                match(some.value)
                  .with({ _tag: "CartAlreadyCheckedOutError" }, (err) => {
                    expect(err.cartId).toBe(command.cartId)
                  })
                  .with({ _tag: "CartIdMismatchError" }, () => {
                    expect.unreachable("Expected CartAlreadyCheckedOutError")
                  })
                  .with({ _tag: "EmptyCartCheckoutError" }, () => {
                    expect.unreachable("Expected CartAlreadyCheckedOutError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected CartAlreadyCheckedOutError")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected decider to fail on checked-out cart")
          })
          .exhaustive()
      })
  )

  it.effect.prop(
    "decideCart fails with CartIdMismatchError whenever command.cartId differs from state.cartId",
    {
      command: CartCommand
    },
    ({ command }) =>
      Effect.gen(function* () {
        const stateCartId = `${command.cartId}-other-aggregate`
        const activeState: CartState = {
          _tag: "ActiveCart",
          cartId: stateCartId,
          items: [],
          itemCount: 0
        }
        const activeExit = yield* Effect.exit(decideCart(command, activeState))
        match(activeExit)
          .with({ _tag: "Failure" }, (f) => {
            const errOpt = Cause.findErrorOption(f.cause)
            match(errOpt)
              .with({ _tag: "Some" }, (some) => {
                match(some.value)
                  .with({ _tag: "CartIdMismatchError" }, (err) => {
                    expect(err.expectedCartId).toBe(stateCartId)
                    expect(err.actualCartId).toBe(command.cartId)
                  })
                  .with({ _tag: "CartAlreadyCheckedOutError" }, () => {
                    expect.unreachable("Expected CartIdMismatchError")
                  })
                  .with({ _tag: "EmptyCartCheckoutError" }, () => {
                    expect.unreachable("Expected CartIdMismatchError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected CartIdMismatchError")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected CartIdMismatchError on active cart")
          })
          .exhaustive()

        const checkedOutState: CartState = {
          _tag: "CheckedOutCart",
          cartId: stateCartId,
          orderId: "order-prop",
          totalItems: 3
        }
        const checkedOutExit = yield* Effect.exit(decideCart(command, checkedOutState))
        match(checkedOutExit)
          .with({ _tag: "Failure" }, (f) => {
            const errOpt = Cause.findErrorOption(f.cause)
            match(errOpt)
              .with({ _tag: "Some" }, (some) => {
                match(some.value)
                  .with({ _tag: "CartIdMismatchError" }, (err) => {
                    expect(err.expectedCartId).toBe(stateCartId)
                    expect(err.actualCartId).toBe(command.cartId)
                  })
                  .with({ _tag: "CartAlreadyCheckedOutError" }, () => {
                    expect.unreachable("Expected CartIdMismatchError")
                  })
                  .with({ _tag: "EmptyCartCheckoutError" }, () => {
                    expect.unreachable("Expected CartIdMismatchError")
                  })
                  .exhaustive()
              })
              .with({ _tag: "None" }, () => {
                expect.unreachable("Expected CartIdMismatchError")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.unreachable("Expected CartIdMismatchError on checked out cart")
          })
          .exhaustive()
      })
  )
})
