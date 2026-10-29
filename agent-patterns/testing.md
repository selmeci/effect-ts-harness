# Testing with Vitest and Effect Traces

Testing Effect applications utilizes @effect/vitest with it.effect and it.scoped alongside test Layers and test tracer spans from @harness/ingest.

## Testing with `@effect/vitest` vs `vitest`

Test runner imports are strictly partitioned by package boundary to prevent leaking framework test runtimes into pure contract packages:
- **`type:contract` packages**: Import test primitives directly from `"vitest"`:
  ```ts
  import { describe, expect, it } from "vitest"
  ```
  Contract packages test Schema decoding/encoding and pure types without Effect runtime wrappers.
- **`type:domain` / `type:core` / `type:infra` / `type:app` packages**: Import test primitives from `"@effect/vitest"`:
  ```ts
  import { describe, expect, it } from "@effect/vitest"
  ```

The `@effect/vitest` package provides native test runners that understand `Effect` generators, fiber lifecycles, and environment injection:

```ts
import { Effect, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { Greeter } from "service/greeter"

describe("Greeter Service", () => {
  it.effect("greets by name", () =>
    Effect.gen(function* () {
      const greeter = yield* Greeter
      const message = yield* greeter.greet("Alice")
      expect(message).toBe("Hello, Alice!")
    }).pipe(
      Effect.provide(Greeter.Test)
    )
  )

  it.scoped("tests resource lifecycle cleanly", () =>
    Effect.gen(function* () {
      const handle = yield* openTestResource
      expect(handle.isOpen).toBe(true)
    })
  )
})
```

## Mocking Dependencies with Test Layers

Create lightweight in-memory test layers using `Layer.succeed` or `Layer.effect`:

```ts
import { Layer } from "effect"
import { UserRepository } from "service/user-repository"

export const UserRepositoryTest = Layer.succeed(
  UserRepository,
  UserRepository.of({
    findById: (id) => Effect.succeed({ id, name: "Test User" }),
    save: (user) => Effect.succeed(user)
  })
)
```

## Recording Test Spans for Dual-Graph Indexing

The harness indexes runtime execution traces to map which tests exercise which domain functions. Use `runWithTestTracer` and `withRecordedTestSpan` from `@harness/ingest`:

```ts
import { Effect } from "effect"
import { describe, it, expect } from "@effect/vitest"
import { runWithTestTracer, withRecordedTestSpan } from "@harness/ingest"
import { calculateTotal } from "domain/cart"

describe("Cart Domain", () => {
  it.effect("calculates order total and records span", () =>
    runWithTestTracer("tests/cart.test.ts#calculates order total", () =>
      Effect.gen(function* () {
        const total = yield* withRecordedTestSpan("Cart.calculateTotal", () =>
          calculateTotal([{ price: 10, quantity: 2 }])
        )
        expect(total).toBe(20)
      })
    )
  )
})
```

The traces captured during test execution are serialized to `.harness/traces.ndjson` and ingested into the dual-layer property graph (`effect/Graph` + Omnigraph), producing `ExercisesSpan` and `TracedCall` edges.

## Deterministic Testing with `TestClock`

Control simulated time deterministically without real delays:

```ts
import { Duration, Effect, TestClock } from "effect"
import { it } from "@effect/vitest"

it.effect("advances simulated time", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(delayedTask)
    yield* TestClock.adjust(Duration.seconds(10))
    const result = yield* Fiber.join(fiber)
    expect(result).toBe("done")
  })
)
```

## Property-Based Testing with Schema Arbitraries (`it.effect.prop`)

Example-based unit tests suffer from two critical failure modes in AI-assisted development:
- **Shared Blind Spots**: LLMs generate tests based on the same conceptual assumptions as their implementation code, leading to tests that verify happy paths while missing edge cases (off-by-one errors, negative boundaries, numeric overflow).
- **Test Reward Hacking**: Agents optimize for passing tests rather than semantic correctness. When tests only assert a single hardcoded input-output pair (`expect(decide(5)).toBe(true)`), trivial or degenerate implementations can satisfy the test suite without fulfilling domain invariants.

To eliminate these vulnerabilities, `@effect/vitest` provides native property-based testing through `it.effect.prop` (for Effectful assertions) and `it.prop` (for synchronous predicates), generating test cases directly from `Schema` definitions via `effect/Arbitrary` with automatic failure shrinking.

When a property fails, `effect/Arbitrary` automatically shrinks the input to the minimal counterexample that falsifies the invariant.

### Pure Decider Boundary Invariants (`WHILE` Clauses)

Pure domain deciders (implementing EARS `WHILE <state>` requirements with `R = never`) must hold true across the entire state space, particularly around operational limits:

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { PhotoQuotaDecider } from "domain/photo-quota"

describe("PhotoQuotaDecider", () => {
  // Pure Decider Boundary Invariants across arbitrary inputs
  it.effect.prop(
    "enforces quota invariant across arbitrary count and limits",
    {
      albumId: Schema.NonEmptyString,
      currentCount: Schema.Number.pipe(Schema.int(), Schema.between(-50, 250)),
      maxAllowed: Schema.Number.pipe(Schema.int(), Schema.between(1, 100))
    },
    ({ albumId, currentCount, maxAllowed }) =>
      Effect.gen(function* () {
        const decision = PhotoQuotaDecider.decide({
          albumId,
          currentCount,
          maxAllowed
        })

        if (currentCount >= maxAllowed) {
          expect(decision._tag).toBe("QuotaExceeded")
          if (decision._tag === "QuotaExceeded") {
            expect(decision.currentCount).toBe(currentCount)
            expect(decision.maxAllowed).toBe(maxAllowed)
          }
        } else {
          expect(decision._tag).toBe("QuotaAllowed")
        }
      })
  )
})
```

### Idempotency & Round-Trip Invariants (Event Sourcing & Schemas)

Projections and state reducers must satisfy mathematical invariants like idempotency and serialization fidelity across arbitrarily generated domain events:

```ts
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { PhotoUploadedEvent, projectAlbumState, initialAlbumState } from "domain/album"

describe("Album Projections & Serialization", () => {
  // Round-trip serialization invariant: decodeUnknownSync(encodeSync(a)) === a
  it.prop(
    "cleanly round-trips arbitrary domain events through Schema serialization",
    { event: PhotoUploadedEvent },
    ({ event }) => {
      const encoded = Schema.encodeSync(PhotoUploadedEvent)(event)
      const decoded = Schema.decodeUnknownSync(PhotoUploadedEvent)(encoded)
      expect(decoded).toEqual(event)
    }
  )

  // Idempotency invariant: project(project(state, event), event) === project(state, event)
  it.prop(
    "satisfies projection idempotency for duplicate event application",
    { event: PhotoUploadedEvent },
    ({ event }) => {
      const stateOnce = projectAlbumState(initialAlbumState, event)
      const stateTwice = projectAlbumState(stateOnce, event)
      expect(stateTwice).toEqual(stateOnce)
    }
  )
})
```

### Non-Tautological Property Invariants (Event Sourcing & Reducers)

When testing stateful reducers (`fold` / `evolve`), `harness/test-integrity` bans tautological property tests (asserting `fold(events)` against `events.reduce(evolve, initial)` using the same reducer function).

> [!WARNING]
> **Ban on Scalar-Only Property Tests (`shallow-decider-property-test` gate):**
> Never write scalar-only property tests (e.g. testing `[PositiveInt, PositiveInt]` and folding hardcoded happy-path events). Scalar-only tests fail to explore boundary conditions, empty event streams, or post-terminal states. Always generate arbitrary event sequences using `Schema.Array(EventUnionSchema)` and assert chunked fold equivalence.

Never downgrade an assertion to `expect(state.id).toBeDefined()` to bypass this ban — vacuous assertions in property tests are blocked by `harness/test-integrity`. Instead, assert concrete mathematical and domain invariants:

1. **Chunked Fold Equivalence Invariant (`Schema.Array(EventUnionSchema)`):**
   A batch fold of arbitrary events must produce the exact same state as folding any two sequential slices (`events.slice(0, k)` followed by `events.slice(k)`):
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

         // Strict structural equality: Equal.equals only (fallback-json-equality gate)
         expect(Equal.equals(chunkedFold, fullFold)).toBe(true)
       }
     )
   })
   ```
2. **Deterministic Replay Idempotence:**
   Re-running `fold(events)` on the same event sequence must return the identical state:
   ```ts
   const folded = fold(events, initialState)
   expect(Equal.equals(fold(events, initialState), folded)).toBe(true)
   ```
3. **Terminal State Immutability:**
   When state reaches a terminal variant (e.g. `CheckedOut`, `Closed`, `Cancelled`), folding subsequent events must leave the state strictly unchanged:
   ```ts
   const terminalState = fold(eventsLeadingToCheckout, initialState)
   expect(Equal.equals(fold(furtherEvents, terminalState), terminalState)).toBe(true)
   ```

### Defect-Free Negative Testing (`Exit.Failure` vs `Die` vs `Fail`)

When writing negative tests (asserting that an effect fails), never assert bare `expect(exit._tag).toBe("Failure")` or `expect(Exit.isFailure(exit)).toBe(true)`.

In Effect, `Exit.Failure` contains a `Cause`. An assertion failure or unexpected exception inside the effect produces a defect (`Die`), which also produces an `Exit.Failure`. Checking only `_tag === "Failure"` masks defects and crashes as successful negative tests!

Always inspect the cause. In `Effect.exit` assertions, extract typed errors with `Cause.findErrorOption(exit.cause)` (not `Cause.failureOption`, which does not exist in Effect v4):
```ts
// 1. Flip error channel to assert typed domain error (E):
const err = yield* Effect.flip(effect)
expect(err._tag).toBe("InsufficientStockError")

// 2. Or inspect Exit.Failure cause tree with Cause.findErrorOption:
const exit = yield* Effect.exit(effect)
if (Exit.isFailure(exit)) {
  const errorOpt = Cause.findErrorOption(exit.cause)
  expect(Option.isSome(errorOpt)).toBe(true)
  if (Option.isSome(errorOpt)) {
    expect(errorOpt.value._tag).toBe("InsufficientStockError")
  }
}

// 3. For asserting runner defects or assertion failures (Die):
expect(Cause.hasDies(exit.cause)).toBe(true)
```

### Negative Meta-Testing for Custom Test Helpers (`guard-condition` gate)

When authoring custom test helpers, decider test scenarios, or BDD assertion builders (such as `makeDeciderTestHarness` in `type:core`), you must plan and implement **negative meta-tests**.

A test helper that has loose guards or improper exit handling creates a critical vulnerability: tests appear to pass while masking real defects. Negative meta-tests use deliberately failing or defective deciders to verify that the test runner itself fails (`Exit.isFailure` / `Cause.isDie`) on every failure condition:

1. **Wrong Event Count:** Verify the runner fails when the decider emits 2 events but the scenario expected 1.
2. **Wrong Event Payload:** Verify the runner fails when the decider emits an event with mismatched payload fields.
3. **Unexpected Success:** Verify the runner fails when `.thenFails(expectedError)` is declared but the decider succeeds.
4. **Defect vs. Typed Failure:** Verify the runner fails when the decider dies with an unhandled defect (`Cause.die`) instead of failing with the declared typed error `E` (`Cause.fail`).

```ts
import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { makeDeciderTestHarness } from "core/testing"

describe("BDD Runner Meta-Tests", () => {
  const fakeFailingDecider = {
    initialState: 0,
    evolve: (s: number) => s,
    decide: () => Effect.fail({ _tag: "FakeError" as const })
  }

  const harness = makeDeciderTestHarness(fakeFailingDecider)

  it.effect("meta-test: runner dies when unexpected failure occurs instead of events", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        harness.given([]).when("anyCommand").thenEvents([{ _tag: "FakeEvent" }])
      )
      // The runner must die (fail its assertion)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
      }
    })
  )

  it.effect("meta-test: runner dies when decider succeeds instead of expected error", () =>
    Effect.gen(function* () {
      const fakeSucceedingDecider = {
        initialState: 0,
        evolve: (s: number) => s,
        decide: () => Effect.succeed([])
      }
      const successHarness = makeDeciderTestHarness(fakeSucceedingDecider)
      const exit = yield* Effect.exit(
        successHarness.given([]).when("anyCommand").thenFails({ _tag: "FakeError" })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
      }
    })
  )
})
```

> [!IMPORTANT]
> The harness zero-entropy gate `harness gc --strict` enforces both the `missing-decider-property-test` and `shallow-decider-property-test` sensors: every pure domain decider must be exercised by property-based tests verifying chunked-fold equivalence over `Schema.Array(EventUnionSchema)`.


## Targeted Domain AST Mutation Testing (`harness mutate`)

Even property tests can have subtle gaps if assertions are too loose. To verify that test suites have genuine discriminating power ("teeth"), the harness includes targeted AST mutation testing via `MutationCheck.decide` (`harness mutate` / `harness mutate --strict`).

Unlike brute-force mutation testing tools that mutate every line across the entire codebase and take hours, `harness mutate` focuses exclusively on pure domain logic in `type:domain` packages.

### Semantic AST Mutations

`MutationCheck.decide` injects semantic AST mutants at boundary and decision sites:
- **Comparison Operators**: `>=` -> `>`, `<=` -> `<`, `>` -> `>=`, `<` -> `<=`
- **Equality Operators**: `===` -> `!==`, `!==` -> `===`
- **Arithmetic Increments**: `+ 1` -> `- 1`, `- 1` -> `+ 1`
- **Logical Connectives**: `&&` -> `||`, `||` -> `&&`

### Zero Survived Mutants Gate

```bash
harness mutate --strict
```

For each mutant injected into a `type:domain` AST:
1. The mutated AST is compiled in-memory.
2. The affected project's `@effect/vitest` suite runs.
3. If the test suite passes, the mutant has **survived** (a test gap).
4. If the test suite fails, the mutant is **killed**.

`harness mutate --strict` requires a **100% mutation score** (0 survived mutants) across all domain deciders. If any mutant survives, it highlights a boundary where tests relied on hand-picked example inputs without checking the exact edge condition.
```
