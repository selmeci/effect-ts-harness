# Testing with Vitest and Effect Traces

Testing Effect applications utilizes @effect/vitest with it.effect and it.scoped alongside test Layers and test tracer spans from @harness/ingest.

## Testing with `@effect/vitest`

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

Never downgrade an assertion to `expect(state.id).toBeDefined()` to bypass this ban — vacuous assertions in property tests are blocked by `harness/test-integrity`. Instead, assert concrete mathematical and domain invariants:

1. **Monoidal Batch Fold vs Step-by-Step Fold Invariant:**
   A batch fold of events must produce the exact same state as folding each event incrementally:
   ```ts
   expect(fold(events)).toEqual(
     events.reduce((acc, ev) => fold([ev], acc), initialState)
   )
   ```
2. **Deterministic Replay Idempotence:**
   Re-running `fold(events)` on the same event sequence must return the identical state:
   ```ts
   const folded = fold(events)
   expect(fold(events)).toEqual(folded)
   ```
3. **Terminal State Immutability:**
   When state reaches a terminal variant (e.g. `CheckedOut`, `Closed`, `Cancelled`), folding subsequent events must leave the state strictly unchanged:
   ```ts
   const terminalState = fold(eventsLeadingToCheckout)
   expect(fold(furtherEvents, terminalState)).toEqual(terminalState)
   ```

### Defect-Free Negative Testing (`Exit.Failure` vs `Die` vs `Fail`)

When writing negative tests (asserting that an effect fails), never assert bare `expect(exit._tag).toBe("Failure")` or `expect(Exit.isFailure(exit)).toBe(true)`.

In Effect, `Exit.Failure` contains a `Cause`. An assertion failure or unexpected exception inside the effect produces a defect (`Die`), which also produces an `Exit.Failure`. Checking only `_tag === "Failure"` masks defects and crashes as successful negative tests!

Always inspect the cause:
```ts
// For asserting typed domain error (E):
const err = yield* Effect.flip(effect)
expect(err._tag).toBe("InsufficientStockError")
// or inspect Cause:
expect(Cause.hasFails(exit.cause)).toBe(true)

// For asserting runner defects or assertion failures (Die):
expect(Cause.hasDies(exit.cause)).toBe(true)
```

> [!IMPORTANT]
> The harness zero-entropy gate `harness gc --strict` enforces the `missing-decider-property-test` sensor: every pure domain decider (`*.decide` in `type:domain`) must be exercised by at least one property-based test (`it.effect.prop` or `it.prop`).

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
