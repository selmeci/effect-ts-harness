# Planning in Effect Idioms

A plan maps each section to an Effect v4 and Alchemy v2 building block, using stub<A, E, R> from @harness/contract to verify type-checked skeletons before implementation.

## Overview

Planning in the Effect-TS Engineering Harness adheres to **Plan-as-Code**. Before writing any production implementation, the agent maps every component of the feature to an Effect or Alchemy architectural primitive, creates a complete type-checked skeleton using `stub<A, E, R>(...args)` from `@harness/contract`, and verifies the plan with `harness plan-check`.

## Plan-as-Code Mapping Table

Every feature plan must map each concern to one of the 18 Effect v4 + Alchemy v2 building blocks below:

| #   | Building Block               | Effect / Alchemy Primitive                                       | Package Boundary                             | Usage & Skeletoneering Pattern                                                                                           | Verification & Enforcement Gate                                                                               |
| --- | ---------------------------- | ---------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | **Schema**                   | `Schema.Struct`, `Schema.Class`, `Schema.Int`, `Schema.String`   | `type:contract`                              | Validate domain inputs, command payloads, and entity boundaries without raw parsing.                                     | `oxlint` syntax bans on raw `JSON.parse`; typecheck boundary validation.                                      |
| 2   | **TaggedError**              | `Schema.TaggedError<Self>()("Tag", { ... })`, `Data.TaggedError` | `type:contract`                              | Define typed domain and infrastructure errors; yield with `return yield* new MyError(...)`.                              | Ban on `throw`; catchable via `Effect.catchTag` / `Effect.catchTags`.                                         |
| 3   | **Context.Service**          | `Context.Service<Self, Interface>()("tag")`                      | `type:service`                               | Define abstract capabilities and repository ports only (zero `Layer.*` or `node:*` imports).                             | `HarnessTierTopology.decide` (`impure-service-tier-import`, `forbidden-service-dependency`).                  |
| 4   | **Layer**                    | `Layer.effect`, `Layer.succeed`, `Layer.provideMerge`            | `type:infra` & `type:core`                   | Compose live adapters in `type:infra` and pure in-memory overlays in `type:core` (never in `type:service`).              | `Graph.findCycle`, `impure-service-tier-import`, `no-layer-build-in-layer-effect`.                            |
| 5   | **Effect SQL D1**            | `@effect/sql-d1`, `SqlClient.SqlClient`, `migrations/*.sql`      | `type:infra`                                 | Serverless SQLite relational persistence; decode rows into `type:contract` Schemas (`drizzle-orm`/`drizzle-kit` banned). | `@effect/sql-*` imports restricted to `type:infra`; `pnpm harness check-migrations` in CI.                    |
| 6   | **Effect SQL DO**            | `@effect/sql-sqlite-do`, `SqliteMigrator`, `SqlClient.SqlClient` | `type:infra`                                 | Durable Object embedded transactional SQLite state on `MixedScheduler("sync")`.                                          | Ensure Schema decoding occurs before entering `sql.withTransaction`.                                          |
| 7   | **HttpApi**                  | `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`                     | `type:contract` & `type:infra`               | Schema-first public HTTP endpoints with typed request/response and OpenAPI schema generation.                            | `oasdiff breaking` detects breaking API contract changes against `main`.                                      |
| 8   | **RpcGroup**                 | `RpcGroup`, `Rpc`, `RpcClient`, `RpcServer`                      | `type:contract` & `type:infra`               | Internal RPC procedures over `Cloudflare.toHttpClient(doStub)` with W3C `traceparent` headers.                           | Distributed trace linkage across Worker and Durable Object boundaries.                                        |
| 9   | **AtomHttpApi**              | `AtomHttpApi`, `@effect/atom-react`                              | `type:app` (`apps/web`)                      | Reactive frontend client state; derives query/mutation atoms with zero manual `fetch`.                                   | Nx boundary check: `apps/web` imports `type:contract` only, no `type:domain`.                                 |
| 10  | **Alchemy Resource/Binding** | `Worker`, `R2Bucket`, `D1Database`, `DurableObjectNamespace`     | `type:infra` & `alchemy.run.ts`              | Infrastructure as Effects declaring cloud resources, IAM permissions, and bindings.                                      | Cloud resources restricted to `type:infra`; `alchemy deploy` strictly human-confirmed.                        |
| 11  | **Effect.fn use cases**      | `Effect.fn("SpanName")`                                          | `type:domain` & `type:core`                  | Reusable traced domain use cases and generic core engines containing pure/orchestration logic.                           | Domain/core exports must use `Effect.fn("LiteralName")` for span attribution (`no-double-wrapped-effect-fn`). |
| 12  | **Scope**                    | `Scope`, `Effect.acquireRelease`, `Effect.addFinalizer`          | `type:core`, `type:domain` & `type:infra`    | Safe lifecycle management for connections, files, and background fibers.                                                 | Finalizers guaranteed to execute on interruption or failure.                                                  |
| 13  | **Schedule**                 | `Schedule.exponential`, `Schedule.recurs`, `Effect.retry`        | `type:core`, `type:domain` & `type:infra`    | Composable retry, backoff, and repetition policies for unreliable operations.                                            | Verified in unit tests with `TestClock` time-advancement.                                                     |
| 14  | **Config**                   | `Config.string`, `Config.integer`, `Effect.config`               | `type:core`, `type:domain` & `type:infra`    | Type-safe configuration loaded from environment or provider secrets (`Config.redacted`).                                 | Validated at startup; fails fast on missing or malformed configuration.                                       |
| 15  | **Test Layers**              | `Test.make`, in-memory repos, mock bindings                      | `test/**`                                    | Mock dependencies and in-memory stores for isolated, fast unit tests.                                                    | `@effect/vitest` (`it.effect`, `it.scoped`) executes tests deterministically.                                 |
| 16  | **Verification**             | `harness verify`, `nx affected -t verify`                        | Root tooling                                 | Composite check: typecheck, lint, test, dual-graph trace indexing, and cryptographic stamp.                              | Verifies all `stub()` calls are eliminated; writes `.harness/verify-stamp.json`.                              |
| 17  | **Pattern Matching**         | `match(val).with(...).exhaustive()`, `Schema.TaggedUnion`        | All packages                                 | Exhaustive branching over closed discriminated unions (`ts-pattern`); replaces `switch` and union `if / else`.           | `oxlint` (`syntax-bans`) + `checkEffectGraph` (`discriminant-branching`, `non-exhaustive-union-match`).       |
| 18  | **Event Sourcing**           | `decide` / `evolve` / `initialState`, `Schema.TaggedError`       | `type:domain`, `type:core` & `type:contract` | Pure synchronous `evolve<Aggregate>`, effectful `Effect.fn("<Aggregate>.decide")`, non-empty batches.                    | `impure-decider`, `impure-reducer`, `missing-decider-property-test`.                                          |

## The `stub<A, E, R>(...args)` Skeleton Pattern

During the planning phase, you create code skeletons that preserve full type safety without implementing business logic. Using `Effect.die("TODO")` directly is problematic because TypeScript infers `Effect<never, never, never>`, losing the planned return type `A`, error channel `E`, and requirement channel `R`.

To solve this, `@harness/contract` exports `stub`:

```ts
import { Effect } from "effect"

export const stub = <A, E = never, R = never>(
  ..._usedArgs: ReadonlyArray<unknown>
): Effect.Effect<A, E, R> => Effect.die("HARNESS_PLAN_STUB")
```

### Usage in Skeletons

```ts
import { Effect } from "effect"
import { stub } from "@harness/contract"
import type { CheckoutInput, CheckoutReceipt } from "contract/cart"
import type { OutOfStockError, PaymentError } from "contract/errors"
import type { InventoryRepo } from "service/inventory"
import type { PaymentService } from "service/payment"

export const checkout = Effect.fn("Cart.checkout")(function* (input: CheckoutInput) {
  // Preserves exact A, E, and R types and marks input as used for oxlint
  return yield* stub<
    CheckoutReceipt,
    OutOfStockError | PaymentError,
    InventoryRepo | PaymentService
  >(input)
})
```

### Lifecycle & Verification

1. **In `harness plan-check` (`HARNESS_PLAN_CHECK=1`):**
   - `stub<A, E, R>(...args)` is **explicitly allowed**.
   - TypeScript verifies that signatures, error unions, and layer requirements align across packages.
   - `effect-graph:check` validates that `R` does not leak infrastructure services into domain boundaries.
   - The verified skeleton structure is saved to Omnigraph branch `plan/<task>`.

2. **In `harness verify` (Production Implementation):**
   - `stub(...)` is **strictly banned** by `tools/oxlint/syntax-bans.js`.
   - Any remaining stub prevents verification from passing, guaranteeing that no skeleton code reaches production.

## Package Archetypes: Framework vs. Application

Before writing any EARS spec or skeleton, determine the repository and package archetype:

1. **Application Archetype (e.g. Photo Gallery, E-Commerce, SaaS):**
   - Implements specific customer/business workflows.
   - Domain models, entities, and state deciders live in `type:domain` (e.g. `libs/shop/domain`).
   - EARS specs define concrete business operations (`WHEN order is placed, SHALL decrement inventory`).

2. **Framework / Library Archetype (e.g. `effect-es`, Event Sourcing engine, RPC library):**
   - Implements reusable, generic engines, protocols, and architectural building blocks (e.g. `AggregateRoot`, `EventStore`, `CommandHandler`, `ProjectionEngine`).
   - Business entities (`Cart`, `Inventory`, `Order`, `BankAccount`) **MUST NEVER** be created in production libraries (`libs/*/src`).
   - Sample domain models belong strictly to `test/fixtures/**` or `samples/**` with Nx tag `scope:fixture`.
   - Production packages use `type:contract` (generic event/command envelopes) and `type:core` (engine abstractions).
   - EARS specs define framework-level guarantees (`WHEN an event stream is appended, THE EVENT STORE SHALL verify concurrency version`).

## Mapping EARS Requirements to `Effect<A, E, R>`

When a user provides product or domain specifications in **EARS (Easy Approach to Requirements Syntax)** without low-level technical details, translate each EARS clause directly into `Effect<A, E, R>` channels, pure `.decide` functions, and `@effect/vitest` test cases:

| EARS Clause Pattern                                                             | Requirement Intent                           | Effect / Harness Translation (`Effect<A, E, R>`)                                                                                                                                               | Verification & Test Mapping                                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Ubiquitous**<br>`THE SYSTEM SHALL <response>`                                 | Core domain invariant or entity shape        | `Schema.Struct` / `Schema.Class` / `Schema.TaggedUnion` in `type:contract` and return channel **`A`**                                                                                          | Schema decode/encode tests & typecheck                                                          |
| **Event-Driven**<br>`WHEN <trigger>, THE SYSTEM SHALL <response>`               | Action entry point and happy-path outcome    | `HttpApiEndpoint` / `Rpc` payload Schema in `type:contract` $\rightarrow$ `Effect.fn("Domain.useCase")` returning **`A`**                                                                      | `it.effect("WHEN <trigger>, SHALL <response>")`                                                 |
| **Unwanted Behavior**<br>`IF <condition>, THEN THE SYSTEM SHALL <fail/recover>` | Domain or boundary failure condition         | `Schema.TaggedError<Self>()("Tag", { ... })` in `type:contract` added to the **`E`** channel (`return yield* new MyError(...)`)                                                                | `it.effect("IF <condition>, SHALL fail with <Error>")` + `OpenApi` error status                 |
| **State-Driven**<br>`WHILE <in state>, THE SYSTEM SHALL <response>`             | State guard, quota, or concurrency invariant | Closed discriminated union (`Schema.TaggedUnion`) + pure decider `Effect.fn("Domain.decide")` using `match(state)...exhaustive()` with **`R = never`** + stateful `Context.Service` in **`R`** | `effect-graph:check` (`impure-decider`, `discriminant-branching`, `non-exhaustive-union-match`) |
| **Optional Feature**<br>`WHERE <feature enabled>, THE SYSTEM SHALL <response>`  | Pluggable capability or feature flag         | `Context.Service` + swappable `Layer` or `Config` in the **`R`** channel                                                                                                                       | Tested by providing alternate `Layer` in `@effect/vitest`                                       |

### EARS-to-Skeleton Worked Example

Given a pure business EARS specification (with zero infrastructure mentions):

```markdown
- WHEN a user requests to delete a photo by ID, THE SYSTEM SHALL remove the photo and decrement its album count by 1.
- IF the photo ID does not exist, THEN THE SYSTEM SHALL fail with a not-found error and leave album counts unchanged.
- WHILE an album's photo count is 0, THE SYSTEM SHALL prevent the album count from becoming negative.
```

The agent inspects existing domain nodes via `harness_resolve` / `harness_callers` and produces the type-checked `stub<A, E, R>` skeleton before writing implementation code:

```ts
import { Effect } from "effect"
import { stub } from "@harness/contract"
import {
  type AlbumPhotoCount,
  type DecideAlbumDecrementInput,
  type PhotoId,
  PhotoNotFoundError,
} from "@harness/sample-contract"
import { AlbumCounterClient, PhotoRepo } from "@harness/sample-service"

// Derived from STATE-DRIVEN ("WHILE count is 0..."): pure decider (R = never)
export const decideAlbumDecrement = Effect.fn("AlbumDecrement.decide")(function* (
  input: DecideAlbumDecrementInput,
) {
  return yield* stub<AlbumPhotoCount, never, never>(input)
})

// Derived from EVENT-DRIVEN ("WHEN user deletes...") + UNWANTED ("IF photo does not exist...")
export const deletePhoto = Effect.fn("Sample.deletePhoto")(function* (id: PhotoId) {
  return yield* stub<void, PhotoNotFoundError, PhotoRepo | AlbumCounterClient>(id)
})
```

---

## Phase-Strict Scope, 5-Tier Hexagonal Topology & Doc-to-Code Parity Checklist

Before advancing a plan from skeleton to implementation, verify complete doc-to-code parity, 5-tier hexagonal topology (`HarnessTierTopology.decide` — `harness:ADR-0013`), and self-dogfooding hygiene (`SelfDogfooding.decide`):

- [ ] **Single Canonical `type:*` Tag (`dual-contract-tier-tag`):** Every workspace package declares exactly one `type:*` Nx tag (`type:contract`, `type:service`, `type:core`, `type:domain`, `type:infra`, or `type:app`) — dual `["type:contract", "type:service"]` tags are banned.
- [ ] **Pure `type:contract` & `type:service` Boundaries (`forbidden-contract-dependency`, `forbidden-service-dependency`, `impure-service-tier-import`):** `type:contract` has `0` workspace dependencies (`effect` only; `stub<A, E, R>` lives in `@harness/contract`). `type:service` imports `effect`, `type:contract`, and `type:service` only — constructing `Layer.*` values, importing `node:*`, or importing `type:core`/`type:domain`/`type:infra` inside `type:service` is strictly banned.
- [ ] **Pure Non-Infra Tiers (`no-node-builtins-outside-infra`, `process-env-outside-infra-or-app`, `no-global-mutable-cache`, `impure-core-tier-import`):** Outside `type:infra` (`libs/*/infra/src/`), `node:*` built-in imports (except `{path, path/posix, path/win32, crypto, url}` — also enforced on `type:app`) and `FetchHttpClient` / `@effect/ai-typesafe` / `@effect/platform*` imports are banned. `process.env` reads are banned outside `type:infra` and `type:app`, and module-scope mutable caches (`let`, module-scope `Map`/`Set`/`WeakMap`, or mutated module-scope object literals) are banned across all production `src/` files.
- [ ] **Explicit Barrel Exports & Declared Dependencies (`facade-star-reexport`, `undeclared-workspace-dependency`, `dynamic-harness-import`):** Never use `export * from` in `libs/**/src/index.ts` or `apps/**/src/index.ts` barrels (use explicit named exports); declare every `@harness/*` import in `package.json` `dependencies`; never use dynamic `import("@harness/...")` or `require("@harness/...")`.
- [ ] **No Future-Phase Leakage:** Never copy unimplemented future-phase symbols (e.g., `DeciderInvariantError`, `commandId` idempotency deduplication, partial event matching, or unconfigured `scope:fixture` Nx tags) into the current phase's EARS Spec or ADR. Only plan and declare what is being built in the active phase.
- [ ] **1:1 Symbol Parity:** Every method name (e.g. `.thenEvents`, `.thenNothing`, `.thenFails`), every `*Error` symbol mentioned in prose or Mermaid diagrams, and every Nx tag in the Spec/ADR must match the current skeleton 1:1. Any symbol in an ADR or Spec that does not exist in code violates `stale-doc-reference`.
- [ ] **No Empty Source Modules (`empty-source-module` gate):** Never leave placeholder `export {}` files in `src/`. Every source file must contain real domain schemas, service interfaces, or `stub<A, E, R>` signatures.
- [ ] **Clean Dependency Manifests (`unused-package-dependency` gate):** Never leave unused packages in `package.json` `dependencies`. Note: `@harness/contract` (when only used for `stub()`) belongs in `devDependencies` once implementation replaces stubs, and must not remain unused in runtime `dependencies`.

---

## Adversarial & Negative Test Matrix

Every plan must include an Adversarial & Negative Test Matrix specifying how boundaries, deciders, and test helpers are tested against invalid states and defects:

### 1. Contract Schemas (`type:contract`)

- **Positive & Negative Decode Tests:** Every constrained schema (`Schema.Int`, `Schema.Natural`, `PositiveInt`, `NonEmptyString`, and branded domain schemas) must plan both positive decode tests and negative rejection tests asserting failure on `-1`, `1.5`, `""`, missing fields, or null.
- **Mandatory Compile-Time Branded Types (`unbranded-contract-schema` & `unbranded-primitive-boundary` gates):** `Schema.String`, `Schema.NonEmptyString`, `Schema.Int`, and `Schema.Natural` are decode-time filters whose unbranded TypeScript type is plain `string` or `number`. Every scalar domain schema in `type:contract` must append `.pipe(Schema.brand("<BrandName>"))`, and every domain `Effect.fn` / `stub<A, E, R>` / `Context.Service` boundary must use branded domain types instead of raw primitives.

### 2. BDD / Test Runners (`testing.ts` in `type:core`)

When building domain test harnesses or BDD assertion builders (e.g. `given(...).when(...).thenEvents(...)`):

- **Strict Structural Equality (`fallback-json-equality` gate):** Compare actual vs expected values strictly using `Equal.equals(actual, expected)` from `effect`. Never fall back to `JSON.stringify(a) === JSON.stringify(b)`, which masks class/prototype differences and non-enumerable properties.
- **Required Expected Error Parameter (`vacuous-error-assertion` gate):** Require an explicit expected error instance or predicate in `.thenFails(expectedError)`. Never make the error parameter optional (e.g., `.thenFails(expected?: E)`), as calling `.thenFails()` without an argument creates a vacuous assertion that passes on _any_ failure.
- **Runner Negative Meta-Tests (`guard-condition` mutation gate):** The plan must include negative meta-tests that verify the BDD runner itself fails when given incorrect expectations. Use a fake failing decider to assert that the runner produces an `Exit.isFailure` / `Cause.isDie` when:
  1. Wrong event count is emitted.
  2. Wrong event payload is emitted.
  3. Decider succeeds when `.thenFails` was expected.
  4. Decider throws an unhandled defect (`Die`) when a typed domain error (`Fail`) was expected.

### 3. Decider / Reducer Property-Based Tests

- **Ban Scalar-Only Property Tests (`shallow-decider-property-test` gate):** Never write property tests that generate only scalar parameters (`[PositiveInt, PositiveInt]`) and fold hardcoded happy-path event sequences.
- **Arbitrary Stream Generation (`Schema.Array(EventUnionSchema)`):** Always generate arbitrary sequences of events using `Schema.Array(EventUnionSchema)` covering:
  - Empty event streams (`[]`).
  - Terminal events (e.g., `CheckedOut`, `Closed`, `Cancelled`).
  - Post-terminal events (verifying that subsequent events do not mutate or revive terminal state).
- **Chunked Fold Equivalence Invariant:** Assert that folding an arbitrary event stream in chunks equals folding the stream all at once:
  ```ts
  // For any partition index k in [0, events.length]:
  const fullFold = fold(events)
  const chunkedFold = fold(events.slice(k), fold(events.slice(0, k)))
  expect(Equal.equals(chunkedFold, fullFold)).toBe(true)
  ```
