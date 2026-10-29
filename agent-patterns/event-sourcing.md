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
- **Ban on `Effect.runSync` (`unscoped-effect-run` gate)**: Never call `Effect.runSync` inside `Decider.make({ evolve })` or domain reducers. `Effect.runSync` starts a disconnected root fiber with an empty context (dropping parent `Tracer` spans, metrics, and fiber refs) and throws defects synchronously if an error occurs. Keep `evolve: (state: S, event: E): S => ...` a pure, synchronous TypeScript function that performs zero side effects and runs no Effects.
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

### Canonical BDD Testing Harness (`testing.ts` in `type:core`)

When building BDD-style test runners for deciders (e.g. `given(...).when(...).thenEvents(...)` / `.thenFails(...)`), adhere strictly to these architectural gates:

1. **Exhaustive Exit Pattern Matching (`discriminant-branching` gate):**
   Never use `if (Exit.isSuccess(exit))` or `if (Exit.isFailure(exit))`. Always branch on `exit` variants with `match(exit).with({ _tag: "Success" }, ...).with({ _tag: "Failure" }, ...).exhaustive()`.
2. **Strict Structural Equality (`fallback-json-equality` gate):**
   Compare events and errors strictly using `Equal.equals(actual, expected)`. Never introduce a `JSON.stringify(a) === JSON.stringify(b)` fallback — stringification erases prototype tags, masks class inequality, and hides non-enumerable properties.
3. **Mandatory Explicit Expected Error (`vacuous-error-assertion` gate):**
   In `.thenFails(expectedError: Err)`, require an explicit expected error instance or predicate. Never make the error parameter optional (e.g. `thenFails(expectedError?: Err)`), as calling `.thenFails()` without an argument creates a vacuous assertion that passes on any arbitrary failure.
4. **Distinguish Defects from Failures:**
   Ensure that unexpected defects (`Cause.hasDies(cause)`) cause the test runner to fail rather than satisfying a `.thenFails` expectation.

```ts
import { Cause, Effect, Equal, Exit, Option } from "effect"
import { expect } from "@effect/vitest"
import { match } from "ts-pattern"

export interface Decider<Command, Event, State, Err> {
  readonly initialState: State
  readonly evolve: (state: State, event: Event) => State
  readonly decide: (command: Command, state: State) => Effect.Effect<ReadonlyArray<Event>, Err, never>
}

export interface DeciderTestScenario<Command, Event, State, Err> {
  readonly when: (command: Command) => {
    readonly thenEvents: (expectedEvents: ReadonlyArray<Event>) => Effect.Effect<void, never, never>
    readonly thenNothing: () => Effect.Effect<void, never, never>
    readonly thenFails: (expectedError: Err) => Effect.Effect<void, never, never>
  }
}

export const makeDeciderTestHarness = <Command, Event, State, Err>(
  decider: Decider<Command, Event, State, Err>
) => ({
  given: (history: ReadonlyArray<Event>): DeciderTestScenario<Command, Event, State, Err> => {
    const currentState = history.reduce(decider.evolve, decider.initialState)
    return {
      when: (command: Command) => ({
        thenEvents: (expectedEvents: ReadonlyArray<Event>) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(decider.decide(command, currentState))
            return yield* match(exit)
              .with({ _tag: "Success" }, (s) => {
                expect(s.value.length).toBe(expectedEvents.length)
                // Strict structural equality: Equal.equals only (fallback-json-equality gate)
                expect(Equal.equals(s.value, expectedEvents)).toBe(true)
                return Effect.void
              })
              .with({ _tag: "Failure" }, (f) =>
                Effect.dieMessage(`Expected events but decider failed: ${Cause.pretty(f.cause)}`)
              )
              .exhaustive()
          }),

        thenNothing: () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(decider.decide(command, currentState))
            return yield* match(exit)
              .with({ _tag: "Success" }, (s) => {
                expect(s.value.length).toBe(0)
                return Effect.void
              })
              .with({ _tag: "Failure" }, (f) =>
                Effect.dieMessage(`Expected empty event list but decider failed: ${Cause.pretty(f.cause)}`)
              )
              .exhaustive()
          }),

        // Explicit expected error instance required — never optional (vacuous-error-assertion gate)
        thenFails: (expectedError: Err) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(decider.decide(command, currentState))
            return yield* match(exit)
              .with({ _tag: "Success" }, (s) =>
                Effect.dieMessage(`Expected decider failure but succeeded with ${JSON.stringify(s.value)}`)
              )
              .with({ _tag: "Failure" }, (f) => {
                expect(Cause.hasDies(f.cause)).toBe(false)
                const errorOpt = Cause.findErrorOption(f.cause)
                expect(Option.isSome(errorOpt)).toBe(true)
                if (Option.isSome(errorOpt)) {
                  // Strict structural equality: Equal.equals only
                  expect(Equal.equals(errorOpt.value, expectedError)).toBe(true)
                }
                return Effect.void
              })
              .exhaustive()
          })
      })
    }
  }
})
```

### Inspecting Exit Failures with `Cause.findErrorOption`

When asserting negative paths in `@effect/vitest` without a BDD harness, wrap execution in `Effect.exit` and branch exhaustively with `match(exit)`:

```ts
import { Cause, Effect, Equal, Exit, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { match } from "ts-pattern"
import { decideCart, initialCartState } from "domain/cart"
import { EmptyCartCheckoutError } from "contract/cart"

describe("Cart Decider Negative Paths", () => {
  it.effect("fails with EmptyCartCheckoutError when checking out empty cart", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideCart({ _tag: "Checkout", cartId: "cart-1", orderId: "ord-1" }, initialCartState)
      )

      yield* match(exit)
        .with({ _tag: "Success" }, () =>
          Effect.dieMessage("Expected EmptyCartCheckoutError but decider succeeded")
        )
        .with({ _tag: "Failure" }, (f) => {
          expect(Cause.hasDies(f.cause)).toBe(false)
          const errorOpt = Cause.findErrorOption(f.cause)
          expect(Option.isSome(errorOpt)).toBe(true)
          if (Option.isSome(errorOpt)) {
            expect(errorOpt.value._tag).toBe("EmptyCartCheckoutError")
            expect(Equal.equals(errorOpt.value, new EmptyCartCheckoutError({ cartId: "cart-1" }))).toBe(true)
          }
          return Effect.void
        })
        .exhaustive()
    })
  )
})
```

### Property-Based Invariants for Deciders and Reducers

Unit tests alone can miss boundary bugs and numeric edge cases. The harness gates `missing-decider-property-test` and `shallow-decider-property-test` enforce comprehensive property-based testing:

> [!WARNING]
> **Ban on Scalar-Only Property Tests (`shallow-decider-property-test` gate):**
> Never write scalar-only property tests (e.g. testing `[PositiveInt, PositiveInt]` and folding hardcoded happy-path events). Such tests provide false confidence while skipping real event sequences. Always generate arbitrary event streams using `Schema.Array(EventUnionSchema)` and assert chunked fold equivalence.

1. **Chunked Fold Equivalence Invariant (`Schema.Array(CartEvent)`):**
   Generate arbitrary sequences of domain events covering:
   - Empty event streams (`[]`).
   - Terminal events (e.g. `CartCheckedOut`).
   - Post-terminal events (verifying that events after checkout do not revive or corrupt the terminal state).

   Folding the stream in two arbitrary sequential chunks must yield the identical state as folding the entire stream at once:
   ```ts
   import { Schema, Equal } from "effect"
   import { describe, expect, it } from "@effect/vitest"
   import { CartEvent, foldCart, initialCartState } from "domain/cart"

   describe("Cart Reducer Properties", () => {
     it.prop(
       "satisfies chunked fold equivalence across arbitrary CartEvent streams",
       {
         events: Schema.Array(CartEvent),
         splitRatio: Schema.Number.pipe(Schema.between(0, 1))
       },
       ({ events, splitRatio }) => {
         const k = Math.floor(events.length * splitRatio)
         const fullFold = foldCart(events, initialCartState)
         const firstChunkState = foldCart(events.slice(0, k), initialCartState)
         const chunkedFold = foldCart(events.slice(k), firstChunkState)

         // Strict structural equality
         expect(Equal.equals(chunkedFold, fullFold)).toBe(true)
       }
     )
   })
   ```

2. **Deterministic Replay Idempotence:**
   ```ts
   const state1 = foldCart(events, initialCartState)
   const state2 = foldCart(events, initialCartState)
   expect(Equal.equals(state1, state2)).toBe(true)
   ```

3. **Terminal State Immutability:**
   Once an aggregate reaches a terminal variant (e.g. `CheckedOutCart`), subsequent events must not alter that terminal status.

