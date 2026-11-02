---
id: es:ADR-0001
title: Pure Decider Pattern, Framework Archetype Isolation, and Strict BDD Verification
status: accepted
date: 2026-10-30
enforced_by:
  - libs/es/contract/src/index.ts
  - libs/es/core/src/index.ts
  - libs/es/core/src/decider.ts
  - libs/es/core/src/testing.ts
  - libs/es/core/test/fixtures/cart.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/graph/src/type-extractor.ts
  - tools/oxlint/syntax-bans.js
spans:
  - Cart.decide
  - Cart.evolve
services: []
errors:
  - CartAlreadyCheckedOutError
  - EmptyCartCheckoutError
  - CartIdMismatchError
---

# Pure Decider Pattern, Framework Archetype Isolation, and Strict BDD Verification

## Context and Problem Statement

When implementing Event Sourcing and CQRS on top of Effect v4 and Cloudflare runtimes, mixing side-effectful capabilities (such as database persistence, outbox queuing, or remote network calls) directly into business transition logic creates untestable aggregates, breaks deterministic event replay, and introduces hidden race conditions. Furthermore, building a reusable event sourcing engine inside an enterprise monorepo risks coupling production libraries with sample domain models (e.g. `Cart` or `Order`). We must establish strict architectural boundaries for pure state decisions and engine isolation.

## Decision Drivers

* **Zero Environmental Dependencies (`R = never`):** Business logic and decision validation must be purely functional, testable in milliseconds without mocks or database instances.
* **Deterministic Event Replay (`E = never`, `R = never`):** Event reducers must be synchronous, total, and infallible to ensure historical streams can be folded identically at any point in time.
* **Framework vs Application Archetype Separation:** Generic protocols (`Decider`, BDD testing runners, branded version schemas) must reside in generic framework packages (`type:core` / `type:contract`), while concrete business entities belong exclusively to `test/fixtures/` directories.
* **Assertion and Test Fidelity:** BDD test runners must enforce strict structural equality via `Equal.equals` without loose JSON stringification fallbacks or vacuous error assertions.

## Considered Options

* **Option 1:** Classic OOP Aggregate Roots with embedded repository and event store side effects.
* **Option 2:** Pure Decider pattern (`initialState`, `evolve`, `decide`) with framework archetype packaging and strict BDD testing harness.
* **Option 3:** Effect v3 community event-sourcing libraries adapted via runtime wrappers.

## Decision Outcome

**Chosen option:** "Option 2: Pure Decider pattern (`initialState`, `evolve`, `decide`) with framework archetype packaging and strict BDD testing harness", because it maps cleanly onto Effect v4 functional composition, preserves static purity enforcement (`R = never`), eliminates version compatibility risk, and guarantees framework neutrality across domains.

### Binding Architectural Rules

1. **Pure Decider Protocol:** The command decision function `decide` must be traced with `Effect.fn("*.decide")` (enforced by `Decider.make`), require zero services (`R = never`), and return a readonly array of domain events or fail with a typed `Schema.TaggedError`.
2. **Synchronous Infallible Reducer:** The event fold function `evolve` must be a pure, synchronous reducer with signature `(state: S, event: E) => S`. Calling `Effect.runSync` or performing I/O inside `evolve` is strictly prohibited.
3. **Framework Archetype Discipline:** Generic protocols and engines live in `libs/es/contract` (`type:contract`) and `libs/es/core` (`type:core`). Business models like `Cart` belong strictly to `test/fixtures/` directories (note: `scope:fixture` is not configured in `nx.json` and is omitted).
4. **Strict BDD Assertion Fidelity:** The test harness `makeDeciderTestHarness` must evaluate scenarios via `.given().when().thenEvents() / .thenNothing() / .thenFails()`, enforcing structural equality via `Equal.equals`, explicit non-optional expected errors, and dying on unhandled defects.

## Rejected Alternatives

### 1 · Classic OOP Aggregate Roots with Embedded Side Effects

**Why rejected:** Embedding persistence, outbox publishing, or transaction boundaries directly inside aggregate classes violates the single responsibility principle and makes pure algebraic property testing impossible without heavy mocking infrastructure.

### 2 · Wrapping Effect v3 Community Libraries

**Why rejected:** Pinned Effect v4 schemas, tagged errors, and tracing boundaries have diverged significantly from legacy v3 abstractions. Adapting unmaintained v3 libraries loses schema performance, breaks tracing propagation, and introduces unwanted dependency friction.

## Consequences and Enforcement

### Positive Consequences

* Aggregate decisions are 100% deterministic and testable without spinning up Cloudflare or SQLite emulation.
* Mathematical invariants (chunked fold equivalence, deterministic replay, terminal immutability) are proven via property-based tests.
* The test runner cannot pass vacuously due to strict `Equal.equals` and mandatory error assertions.

### Negative Consequences and Trade-offs

* Domain services requiring external contextual queries (e.g. inventory lookups) must be queried prior to invoking `decide`, keeping orchestration in application use cases.
* Reducer functions must exhaustively handle every event and state variant using `ts-pattern`.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Pure Decider (`R = never`) | `libs/harness/graph/src/policy-check.ts`, `libs/harness/graph/src/type-extractor.ts`, `libs/es/core/src/decider.ts` | `checkEffectGraph` (`impure-decider`), `extractTypeAwareGraphFromSource` (`untraced-decider`) | `Cart.decide` |
| Synchronous Infallible Reducer | `libs/harness/graph/src/policy-check.ts`, `libs/harness/graph/src/type-extractor.ts`, `tools/oxlint/syntax-bans.js` | `checkEffectGraph` (`impure-reducer`), `extractTypeAwareGraphFromSource` (`unscoped-effect-run`) | `Cart.evolve` |
| BDD Assertion Structural Equality | `libs/harness/graph/src/type-extractor.ts`, `libs/es/core/src/testing.ts` | `extractTypeAwareGraphFromSource` (`fallback-json-equality`, `vacuous-error-assertion`), `makeDeciderTestHarness` | `Cart.decide` |
| Typed Domain Failure Channel | `libs/harness/graph/src/type-extractor.ts`, `libs/es/core/test/fixtures/cart.ts` | `extractTypeAwareGraphFromSource` (`missing-aggregate-id-guard`, `unbranded-schema-field`), `failsWith` | `CartAlreadyCheckedOutError`, `EmptyCartCheckoutError`, `CartIdMismatchError` |
