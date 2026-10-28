# agent-patterns

Reviewed Effect v4 and Alchemy v2 pattern files, generated from the pinned sources in `repos/effect`
and `repos/alchemy` — never from external docs (`docs/mvp_v2.md` §5). Indexed as `PatternDoc` nodes
in `effect/Graph` and Omnigraph.

## Indexed Patterns

1. [`planning.md`](./planning.md) — Plan-as-Code markdown template with the 16-row building block mapping and `stub<A, E, R>(...args)` skeleton pattern.
2. [`services-and-layers.md`](./services-and-layers.md) — `Context.Service` interface definition, tags, and `Layer.effect` / `Layer.succeed` / `Layer.scoped` composition.
3. [`errors.md`](./errors.md) — Tagged error modeling with `Schema.TaggedErrorClass` / `Data.TaggedError`, recovery combinators, and strict ban on `throw`.
4. [`schema.md`](./schema.md) — Input decoding, boundary validation, and serialization with `Schema.Struct`, `Schema.Class`, `Schema.Int`, and `Schema.fromJsonString`.
5. [`resources-scope.md`](./resources-scope.md) — Safe lifecycle management and deterministic cleanup using `Scope`, `Effect.acquireRelease`, and `Layer.scoped`.
6. [`concurrency.md`](./concurrency.md) — Structured concurrency with `Effect.all`, fibers, `Deferred` latches, `Queue`, and `Semaphore`.
7. [`schedule.md`](./schedule.md) — Retries, exponential backoff, jitter, repetition, and timeouts using `Schedule` and `Effect.retry`.
8. [`testing.md`](./testing.md) — Unit and integration testing with `@effect/vitest` (`it.effect`, `it.scoped`), test layers, and trace span recording with `@harness/ingest`.
9. [`alchemy-infra.md`](./alchemy-infra.md) — Cloud infrastructure declarations for Workers, `R2Bucket`, `D1Database`, `DurableObjectNamespace`, `Test.make`, and `type:infra` isolation rules.
10. [`d1-repository.md`](./d1-repository.md) — Relational D1 persistence with `drizzle-orm/effect-d1` on `@effect/sql-d1`, table isolation in `type:infra`, schema decoding, and versioned migrations.
11. [`durable-object-state.md`](./durable-object-state.md) — Embedded DO SQLite state with `drizzle-orm/effect-sqlite-do`, synchronous transactions on `MixedScheduler("sync")`, and pre-transaction schema decoding.
12. [`httpapi.md`](./httpapi.md) — Schema-first public HTTP APIs with `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, OpenAPI export, and breaking change detection with `oasdiff breaking`.
13. [`rpc.md`](./rpc.md) — Internal RPC procedures over `Cloudflare.toHttpClient(doStub)` with W3C `traceparent` propagation into Durable Objects.
14. [`atom.md`](./atom.md) — Reactive frontend client state with `@effect/atom-react` and `AtomHttpApi` consuming backend contracts with zero manual `fetch`.
15. [`pattern-matching.md`](./pattern-matching.md) — Exhaustive pattern matching with `ts-pattern` (`match(value)...exhaustive()`) and closed discriminated unions (`Schema.TaggedUnion`, `Schema.TaggedClass`), replacing `switch` and union `if / else`.

## Status

All 15 pattern files are reviewed and indexed as `PatternDoc` nodes in `@harness/graph` via `loadPatternDocs(repoRoot)`.
