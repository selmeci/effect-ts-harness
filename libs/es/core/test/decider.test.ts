import { describe, expect, it } from "@effect/vitest"
import { Equal, Schema } from "effect"
import { match } from "ts-pattern"
import { makeDeciderTestHarness } from "../src/testing.js"
import {
  ActiveCart,
  CartAlreadyCheckedOutError,
  CartCheckedOut,
  cartDecider,
  CartIdMismatchError,
  CartState,
  CheckedOutCart,
  EmptyCartCheckoutError,
  evolveCart,
  INITIAL_EVENT_VERSION,
  initialCartState,
  type ItemAdded,
  positiveInt,
  streamVersion
} from "./fixtures/cart.js"

describe("Cart Decider BDD Scenarios", () => {
  const scenario = makeDeciderTestHarness(cartDecider)

  it("validates StreamVersion and INITIAL_EVENT_VERSION branded constructors", () => {
    expect(INITIAL_EVENT_VERSION).toBe(streamVersion(1))
    expect(streamVersion(0)).toBe(0)
    expect(positiveInt(1)).toBe(1)
  })

  it("decodes CartState, ActiveCart, and CheckedOutCart with Schema.Natural counts and rejects negative counts", () => {
    const active = Schema.decodeSync(ActiveCart)({
      _tag: "ActiveCart",
      cartId: "cart-1",
      items: [{ itemId: "item-1", quantity: positiveInt(2) }],
      itemCount: 2
    })
    expect(active.itemCount).toBe(2)

    const checkedOut = Schema.decodeSync(CheckedOutCart)({
      _tag: "CheckedOutCart",
      cartId: "cart-1",
      orderId: "order-1",
      totalItems: 2
    })
    expect(checkedOut.totalItems).toBe(2)

    const unionDecoded = Schema.decodeSync(CartState)({
      _tag: "EmptyCart"
    })
    expect(unionDecoded._tag).toBe("EmptyCart")

    expect(() =>
      Schema.decodeSync(ActiveCart)({
        _tag: "ActiveCart",
        cartId: "cart-1",
        items: [],
        itemCount: -1
      })
    ).toThrow()
  })

  it.effect("emits CartCreated and ItemAdded when adding item to an empty cart", () =>
    scenario
      .given([])
      .when({ _tag: "AddItem", cartId: "cart-1", itemId: "item-1", quantity: positiveInt(2) })
      .thenEvents([
        { _tag: "CartCreated", cartId: "cart-1", version: 1 },
        { _tag: "ItemAdded", cartId: "cart-1", itemId: "item-1", quantity: positiveInt(2), version: 1 }
      ])
  )

  it.effect("emits ItemAdded when adding item to an active cart", () =>
    scenario
      .given([
        { _tag: "CartCreated", cartId: "cart-1", version: 1 },
        { _tag: "ItemAdded", cartId: "cart-1", itemId: "item-1", quantity: positiveInt(1), version: 1 }
      ])
      .when({ _tag: "AddItem", cartId: "cart-1", itemId: "item-2", quantity: positiveInt(3) })
      .thenEvents([
        { _tag: "ItemAdded", cartId: "cart-1", itemId: "item-2", quantity: positiveInt(3), version: 1 }
      ])
  )

  it.effect("emits CartCheckedOut when checking out an active cart", () =>
    scenario
      .given([
        { _tag: "CartCreated", cartId: "cart-1", version: 1 },
        { _tag: "ItemAdded", cartId: "cart-1", itemId: "item-1", quantity: positiveInt(1), version: 1 }
      ])
      .when({ _tag: "Checkout", cartId: "cart-1", orderId: "order-99" })
      .thenEvents([
        { _tag: "CartCheckedOut", cartId: "cart-1", orderId: "order-99", version: 1 }
      ])
  )

  it.effect("fails with EmptyCartCheckoutError when checking out an empty cart", () =>
    scenario
      .given([])
      .when({ _tag: "Checkout", cartId: "cart-1", orderId: "order-99" })
      .thenFails(new EmptyCartCheckoutError({ cartId: "cart-1" }))
  )

  it.effect(
    "fails with EmptyCartCheckoutError when checking out an active cart with zero items (after lone CartCreated)",
    () =>
      scenario
        .given([{ _tag: "CartCreated", cartId: "cart-1", version: 1 }])
        .when({ _tag: "Checkout", cartId: "cart-1", orderId: "order-99" })
        .thenFails(new EmptyCartCheckoutError({ cartId: "cart-1" }))
  )

  it.effect(
    "fails with CartIdMismatchError when command cartId does not match active cartId",
    () =>
      scenario
        .given([
          { _tag: "CartCreated", cartId: "cart-1", version: 1 },
          { _tag: "ItemAdded", cartId: "cart-1", itemId: "item-1", quantity: positiveInt(1), version: 1 }
        ])
        .when({ _tag: "AddItem", cartId: "cart-2", itemId: "item-2", quantity: positiveInt(1) })
        .thenFails(new CartIdMismatchError({ expectedCartId: "cart-1", actualCartId: "cart-2" }))
  )

  it.effect(
    "fails with CartIdMismatchError when command cartId does not match checked-out cartId",
    () =>
      scenario
        .given([
          { _tag: "CartCreated", cartId: "cart-1", version: 1 },
          { _tag: "ItemAdded", cartId: "cart-1", itemId: "item-1", quantity: positiveInt(1), version: 1 },
          { _tag: "CartCheckedOut", cartId: "cart-1", orderId: "order-99", version: 1 }
        ])
        .when({ _tag: "Checkout", cartId: "cart-2", orderId: "order-100" })
        .thenFails(new CartIdMismatchError({ expectedCartId: "cart-1", actualCartId: "cart-2" }))
  )

  it.effect("fails with CartAlreadyCheckedOutError when adding item to a checked out cart", () =>
    scenario
      .given([
        { _tag: "CartCreated", cartId: "cart-1", version: 1 },
        { _tag: "ItemAdded", cartId: "cart-1", itemId: "item-1", quantity: positiveInt(1), version: 1 },
        { _tag: "CartCheckedOut", cartId: "cart-1", orderId: "order-99", version: 1 }
      ])
      .when({ _tag: "AddItem", cartId: "cart-1", itemId: "item-2", quantity: positiveInt(1) })
      .thenFails(new CartAlreadyCheckedOutError({ cartId: "cart-1" }))
  )

  it.effect("fails with CartAlreadyCheckedOutError when checking out a checked out cart", () =>
    scenario
      .given([
        { _tag: "CartCreated", cartId: "cart-1", version: 1 },
        { _tag: "ItemAdded", cartId: "cart-1", itemId: "item-1", quantity: positiveInt(1), version: 1 },
        { _tag: "CartCheckedOut", cartId: "cart-1", orderId: "order-99", version: 1 }
      ])
      .when({ _tag: "Checkout", cartId: "cart-1", orderId: "order-100" })
      .thenFails(new CartAlreadyCheckedOutError({ cartId: "cart-1" }))
  )

  it("folds CartCreated, two ItemAdded events, and CartCheckedOut into accurate items, itemCount, and totalItems", () => {
    const s0 = initialCartState
    const s1 = evolveCart(s0, { _tag: "CartCreated", cartId: "cart-1", version: 1 })
    const ev1: ItemAdded = {
      _tag: "ItemAdded",
      cartId: "cart-1",
      itemId: "item-1",
      quantity: positiveInt(2),
      version: 1
    }
    const ev2: ItemAdded = {
      _tag: "ItemAdded",
      cartId: "cart-1",
      itemId: "item-2",
      quantity: positiveInt(3),
      version: 1
    }
    const s2 = evolveCart(s1, ev1)
    const s3 = evolveCart(s2, ev2)

    match(s3)
      .with({ _tag: "ActiveCart" }, (s) => {
        expect(s.cartId).toBe("cart-1")
        expect(
          Equal.equals(s.items, [
            { itemId: "item-1", quantity: positiveInt(2) },
            { itemId: "item-2", quantity: positiveInt(3) }
          ])
        ).toBe(true)
        expect(s.itemCount).toBe(5)
      })
      .with({ _tag: "EmptyCart" }, () => {
        expect.unreachable("Expected ActiveCart")
      })
      .with({ _tag: "CheckedOutCart" }, () => {
        expect.unreachable("Expected ActiveCart")
      })
      .exhaustive()

    const mismatchedEv: ItemAdded = {
      _tag: "ItemAdded",
      cartId: "cart-other",
      itemId: "item-3",
      quantity: positiveInt(4),
      version: 1
    }
    const s3Mismatched = evolveCart(s3, mismatchedEv)
    expect(Equal.equals(s3Mismatched, s3)).toBe(true)
    match(s3Mismatched)
      .with({ _tag: "ActiveCart" }, (s) => {
        expect(s.itemCount).toBe(5)
        expect(s.items.length).toBe(2)
      })
      .with({ _tag: "EmptyCart" }, () => {
        expect.unreachable("Expected ActiveCart")
      })
      .with({ _tag: "CheckedOutCart" }, () => {
        expect.unreachable("Expected ActiveCart")
      })
      .exhaustive()

    const checkedOutEv: CartCheckedOut = {
      _tag: "CartCheckedOut",
      cartId: "cart-1",
      orderId: "order-99",
      version: 1
    }
    const s4 = evolveCart(s3, checkedOutEv)
    match(s4)
      .with({ _tag: "CheckedOutCart" }, (s) => {
        expect(s.cartId).toBe("cart-1")
        expect(s.orderId).toBe("order-99")
        expect(s.totalItems).toBe(5)
      })
      .with({ _tag: "ActiveCart" }, () => {
        expect.unreachable("Expected CheckedOutCart")
      })
      .with({ _tag: "EmptyCart" }, () => {
        expect.unreachable("Expected CheckedOutCart")
      })
      .exhaustive()
  })
})
