# Event Sourcing and Decider Architecture

Event Sourcing in the Effect-TS Engineering Harness structures stateful domain entities as event-sourced aggregates governed by the Decider pattern, separating pure state transitions from effectful command handling.

## Overview & The Decider Pattern

The Decider pattern models domain logic as three core elements:
1. **Initial State (`initialState: S`)**: The identity state before any events have been applied.
2. **Pure Synchronous Reducer (`evolve: (state: S, event: E) => S`)**: Replays history deterministically without side effects, I/O, or failure.
3. **Effectful Command Decision (`decide: (command: C, state: S) => Effect<ReadonlyArray<E>, Err, R>`)**: Evaluates a command against current state, validating business invariants and emitting new events or failing with a typed error.

---

## 1. Pure Synchronous `evolve` vs Effectful `decide`

### The Pure Reducer: `evolve<Aggregate>`

The reducer function `evolve` calculates the next state strictly from current state and an incoming event:
- **Must be pure and synchronous**: Never wrap `evolve` in `Effect.fn`, `Effect.gen`, or async Promises. State reconstruction must be fast and infallible.
- **Infallible (`E = never`) & Zero I/O (`R = never`)**: The reducer cannot fail (`E = never`) or perform side effects (`R = never`). If an unexpected event occurs, return the current state unchanged or handle it via a closed discriminated union.
- **Naming convention**: Name the function `evolve<Aggregate>` (e.g., `evolveCart`, `evolveOrder`, `evolveAlbum`).
- **Exhaustive pattern matching**: Always branch on `event` and `state` variants using `match(state)` and `match(event)...exhaustive()` from `ts-pattern` (see [`pattern-matching.md`](./pattern-matching.md)). Never use `switch` or `if / else`.

```ts
import { match } from "ts-pattern"
import type { CartEvent, CartState } from "@harness/sample-contract"

export const initialCartState: CartState = {
  _tag: "EmptyCart"
}

export const evolveCart = (state: CartState, event: CartEvent): CartState =>
  match(event)
    .with({ _tag: "CartCreated" }, (e) => ({
      _tag: "ActiveCart" as const,
      cartId: e.cartId,
      items: [],
      itemCount: 0
    }))
    .with({ _tag: "ItemAdded" }, (e) =>
      match(state)
        .with({ _tag: "ActiveCart" }, (s) => ({
          ...s,
          items: [...s.items, { itemId: e.itemId, quantity: e.quantity }],
          itemCount: s.itemCount + e.quantity
        }))
        .with({ _tag: "EmptyCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive()
    )
    .with({ _tag: "CartCheckedOut" }, (e) =>
      match(state)
        .with({ _tag: "ActiveCart" }, (s) => ({
          _tag: "CheckedOutCart" as const,
          cartId: s.cartId,
          orderId: e.orderId,
          totalItems: s.itemCount
        }))
        .with({ _tag: "EmptyCart" }, () => state)
        .with({ _tag: "CheckedOutCart" }, () => state)
        .exhaustive()
    )
    .exhaustive()
```

### The Command Decider: `decide`

The decision function `decide` takes an aggregate command and current state and returns an `Effect` producing an array of events:
- **Wrap in `Effect.fn`**: Must be declared with `Effect.fn("<Aggregate>.decide")` for runtime trace capture and span attribution.
- **Pure Deciders (`R = never`)**: In accordance with the `impure-decider` policy gate, deciders that enforce state invariants must require no services (`R = never`). If dependencies are needed (e.g. external inventory checks), orchestrate them in an application use case, keeping the core state decision pure.
- **Typed Error Channel (`E`)**: Failures must be typed errors defined as `Schema.TaggedError`.

```ts
import { Effect } from "effect"
import { match } from "ts-pattern"
import type { CartCommand, CartEvent, CartState } from "@harness/sample-contract"
import { CartAlreadyCheckedOutError, EmptyCartCheckoutError } from "@harness/sample-contract"

export const decideCart = Effect.fn("Cart.decide")(
  (command: CartCommand, state: CartState): Effect.Effect<
    readonly [CartEvent, ...Array<CartEvent>],
    CartAlreadyCheckedOutError | EmptyCartCheckoutError,
    never
  > =>
    match(command)
      .with({ _tag: "AddItem" }, (cmd) =>
        match(state)
          .with({ _tag: "CheckedOutCart" }, () =>
            Effect.fail(new CartAlreadyCheckedOutError({ cartId: cmd.cartId }))
          )
          .with({ _tag: "EmptyCart" }, () =>
            Effect.succeed([
              { _tag: "CartCreated" as const, cartId: cmd.cartId },
              { _tag: "ItemAdded" as const, cartId: cmd.cartId, itemId: cmd.itemId, quantity: cmd.quantity }
            ])
          )
          .with({ _tag: "ActiveCart" }, () =>
            Effect.succeed([
              { _tag: "ItemAdded" as const, cartId: cmd.cartId, itemId: cmd.itemId, quantity: cmd.quantity }
            ])
          )
          .exhaustive()
      )
      .with({ _tag: "Checkout" }, (cmd) =>
        match(state)
          .with({ _tag: "EmptyCart" }, () =>
            Effect.fail(new EmptyCartCheckoutError({ cartId: cmd.cartId }))
          )
          .with({ _tag: "CheckedOutCart" }, () =>
            Effect.fail(new CartAlreadyCheckedOutError({ cartId: cmd.cartId }))
          )
          .with({ _tag: "ActiveCart" }, () =>
            Effect.succeed([
              { _tag: "CartCheckedOut" as const, cartId: cmd.cartId, orderId: cmd.orderId }
            ])
          )
          .exhaustive()
      )
      .exhaustive()
)
```

---

## 2. Non-Empty Event Batches (`NonEmptyReadonlyArray<E>`)

Commands that mutate state emit at least one domain event.
- **Type Non-Empty Batches**: Return `readonly [E, ...Array<E>]` (or `NonEmptyReadonlyArray<E>`).
- **No Non-Null Assertions**: Never use `events[0]!` (banned by `oxlint`).
- **Pattern Match or Destructure Safely**: Use TypeScript tuple destructuring `const [firstEvent, ...restEvents] = events` or `Array.match`:

```ts
import { Array } from "effect"

// Safe access without non-null assertion:
const summary = Array.match(events, {
  onEmpty: () => "No events emitted",
  onNonEmpty: ([head, ...tail]) => `Primary event: ${head._tag}, followed by ${tail.length} event(s)`
})
```

---

## 3. Effect v4 Tagged Errors (`Schema.TaggedError`)

Define all domain and decision errors using the curried `Schema.TaggedError` syntax:

```ts
import { Schema } from "effect"

// Curried syntax: Schema.TaggedError<Self>()("Tag", { fields })
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
```

> [!NOTE]
> `Schema.TaggedErrorClass` was removed in Effect v4 runtime exports. Always use `Schema.TaggedError<Self>()("TagName", { ... })`.

---

## 4. Numeric Precision: Positive vs Non-Negative Integers

Choosing the right numeric schema is critical for stream versions and quantities:
- **`Schema.Natural` ($\ge 0$)**: Non-negative integers including `0`. Use for 0-based stream versions (`streamVersion`, `nextExpectedStreamVersion`) and non-negative counters (`itemCount`, `totalEvents`).
- **Branded Positive Integer ($> 0$)**: Strictly positive integers excluding `0`. Use for quantities (`orderQty`, `quantity`, `batchSize`) where `0` is invalid.

```ts
import { Schema } from "effect"

// 0-based stream revisions and counters (0 is valid)
export const StreamVersion = Schema.Natural.pipe(Schema.brand("StreamVersion"))
export type StreamVersion = typeof StreamVersion.Type

// Strictly positive quantities (> 0, 0 is invalid)
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("PositiveInt")
)
export type PositiveInt = typeof PositiveInt.Type
```

> [!WARNING]
> Never use `Schema.Natural` for order quantities, purchase counts, or batch sizes where `0` is an illegal business state. Always use `Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("PositiveInt"))`.

---

## 5. No Dead Error Unions in Specs and Skeletons

Every tagged error declared in a plan or EARS specification must correspond to a real failure scenario:
- **EARS `IF/THEN` Parity**: Declare a `Schema.TaggedError` in an EARS `IF/THEN` clause and `Decider` error channel `E` only if at least one `EffectFn` actually yields/fails with that error (`FailsWith` edge in the graph).
- **Entropy Check**: The deterministic zero-entropy gate `harness gc --strict` checks for `dead-tagged-error`. If a `TaggedError` is declared but never yielded by any domain function, `gc --strict` fails.

---

## 6. Testing Deciders and State Replay

### Vitest Test Runner Package Boundaries

To maintain clean architecture and prevent leaking Effect test dependencies into shared contracts:
- **`type:contract` packages**: Import test utilities directly from `vitest`:
  ```ts
  import { describe, expect, it } from "vitest"
  ```
- **`type:domain` / `type:core` / `type:infra` / `type:app` packages**: Import test utilities from `@effect/vitest`:
  ```ts
  import { describe, expect, it } from "@effect/vitest"
  ```

### Inspecting Exit Failures with `Cause.findErrorOption`

When asserting negative paths in `@effect/vitest`, wrap the execution in `Effect.exit` and inspect typed errors using `Cause.findErrorOption(exit.cause)`:

```ts
import { Cause, Effect, Exit, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { decideCart, initialCartState } from "domain/cart"
import { EmptyCartCheckoutError } from "contract/cart"

describe("Cart Decider Negative Paths", () => {
  it.effect("fails with EmptyCartCheckoutError when checking out empty cart", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideCart({ _tag: "Checkout", cartId: "cart-1", orderId: "ord-1" }, initialCartState)
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        // Cause.findErrorOption extracts typed error from the Cause failure channel.
        // (Note: Cause.failureOption does not exist in Effect v4)
        const errorOpt = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(errorOpt)).toBe(true)
        if (Option.isSome(errorOpt)) {
          expect(errorOpt.value._tag).toBe("EmptyCartCheckoutError")
          expect(errorOpt.value).toBeInstanceOf(EmptyCartCheckoutError)
        }
      }
    })
  )
})
```

### Property-Based Invariants for Deciders and Reducers

Unit tests alone can miss boundary bugs and numeric edge cases. The harness gate `missing-decider-property-test` enforces property-based testing with `it.effect.prop` and `it.prop`:

1. **Monoidal Batch Fold vs Step-by-Step Fold**:
   ```ts
   expect(foldCart(events)).toEqual(
     events.reduce((acc, ev) => foldCart([ev], acc), initialCartState)
   )
   ```
2. **Deterministic Replay Idempotence**:
   ```ts
   const state1 = foldCart(events)
   const state2 = foldCart(events)
   expect(state1).toEqual(state2)
   ```
3. **Terminal State Immutability**:
   Once an aggregate reaches a terminal variant (e.g. `CheckedOutCart`), subsequent events must not alter that terminal status.
