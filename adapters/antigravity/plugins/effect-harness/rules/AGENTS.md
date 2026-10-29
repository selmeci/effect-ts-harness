# AGENTS.md — Effect-TS Engineering Harness

## Order of authority (when learning Effect and Alchemy, follow in this order)

1. `repos/effect/LLMS.md`
2. Source code and tests in `repos/effect` and `repos/alchemy`
3. `agent-patterns/*.md` and `docs/alchemy-llms*.txt`
4. `effect/Graph` + Omnigraph (`harness-mcp` / `@modernrelay/omnigraph-mcp`) and the Nx graph for services and Layers

Google Code Wiki and other generated/prose docs are out — never cite them.

## `repos/` rules

- `repos/effect` and `repos/alchemy` are read-only squashed git subtrees pinned to recorded commits.
- Never edit files under `repos/`, never import from them. App code imports `effect`, `alchemy` and scoped packages like any npm dependency.

## Workflow (one task)

plan (in Effect idioms, `agent-patterns/planning.md` template) → skeleton with `stub<A, E, R>(...args)` typechecks →
`pnpm harness plan-check` (`plan/<task>` branch) → implement (isolate concurrent subagents with `Workspace: "share"` or `HARNESS_WORKTREE_ID`) → `pnpm harness gc --strict` (`GraphGc.decide` zero-entropy gate) → `pnpm harness verify` (the ONLY sanctioned verification, checks `SpanBudget.decide` and writes `.harness/verify-stamp.json` + `impl/<task>` branch) → `pnpm harness done` → `pnpm harness learn` (`compounding-effect-learnings` to promote `.harness/friction-log.jsonl` into recipes/gates).

### MCP-First Tooling Preference
Always prefer in-process MCP tools over spawning shell subcommands to eliminate process overhead and guard prompt friction:
- **LSP & Type Diagnostics:** `harness_lsp_diagnostics` (replaces slow shell lint/typecheck runs during development).
- **Ontology & Architecture:** `harness_ontology_check`, `harness_ontology_why`, `harness_ontology_impact` (trace and audit EARS specs and ADR invariants).
- **Test Impact Analysis:** `harness_tests_reaching` (determines affected test files for touched symbols).
- **Session Telemetry:** `harness_telemetry_report` (reviews session metrics and friction logs).
- **Graph Queries:** `harness_gq_query`, `harness_structural_search`.
- **Task Lifecycle Gates (CLI only):** Use `pnpm harness <cmd>` (`plan-check`, `gc --strict`, `verify`, `done`) strictly for task state transitions and cryptographic verify-stamp generation.

## Nx taxonomy & Package Archetypes

- **Package Archetypes (Framework vs Application):**
  - **Application Archetype:** Standard user-facing domain models live in `type:domain` (`*.decide`, business use cases).
  - **Framework / Library Archetype:** The repo produces generic engines, protocols, and abstractions (e.g. `AggregateRoot`, `EventStore`, `Decider`). Business domains (e.g. `Cart`, `Inventory`, `Order`) **MUST NEVER** be created in production libraries. Domain models belong strictly to `test/fixtures` or `samples/` tagged with `scope:fixture`.
- `type:contract` — shared Schemas, `HttpApi`, `RpcGroup`, API errors, event/command protocols; imports `effect` only
- `type:domain` (in applications) / `type:core` (in frameworks) — use cases, generic engines, and pure logic, no I/O; imports `contract` (and `@harness/gates` for `stub` in skeletons); must not depend on `type:infra`
- `type:service` — service interfaces and repository ports
- `type:infra` — live Layer implementations, Drizzle repositories and handlers, Alchemy resources, adapter implementations
- `type:app` — composes Layers and runs the runtime; the `web` app may import `contract` and UI libraries only

## Planning in Effect idioms

A plan maps each section (including EARS requirements: `WHEN` → input Schema & `A`, `IF/THEN` → `Schema.TaggedError<Self>()("Tag", { ... })` in `E`, `WHILE` → pure `.decide` with `R = never` + stateful service in `R`, `WHERE` → `Layer`/`Config` in `R`; see `agent-patterns/planning.md`) to an Effect building block: Schema at boundaries, tagged errors,
`Context.Service` capabilities, `Layer` dependency graph, `Effect<A, E, R>` use-case signatures,
`Scope` for resources, `Schedule` for retry/concurrency, `Config` + `Effect.fn("name")` spans, test Layers.
Plan as code: write the skeleton first (schemas, errors, service interfaces, signatures using `stub<A, E, R>(...args)` from `@harness/gates`) — it must pass typecheck with preserved `A`, `E`, `R` types before implementation starts. `stub()` is allowed during `HARNESS_PLAN_CHECK=1` and banned in `harness verify`.

## Code style (from `repos/effect/LLMS.md` & `agent-patterns/pattern-matching.md`)

- Prefer `Effect.gen` inline; use `Effect.fn("name")` for reusable traced functions and `Effect.fnUntraced` otherwise; avoid wrappers that only return `Effect.gen`; `return` instead of yielding-and-assigning an error.
- **Exhaustive pattern matching (`ts-pattern`) & Discriminated Unions:**
  - Model mutually exclusive states, commands, events, and results as closed discriminated unions (`Schema.TaggedUnion`, `Schema.TaggedStruct`, `Schema.TaggedClass`) in `type:contract` — never with boolean flags or optional properties.
  - `switch` statements and multi-branch `if / else if` chains are banned in domain/service/infra/app code. Always use `match(value).with(...).exhaustive()` from `ts-pattern`.
  - Never use `if / else` or ternary `? :` to check a discriminant property (`_tag`, `kind`, `status`, custom literal tags) or tag guard (`Option.isSome`, `Either.isRight`, `Result.isSuccess`) — enumerate **all** variants with `match(value)...exhaustive()`, even when the union has only 2 states. Simple `if / else` is allowed only when not inspecting a union discriminant.
  - `.exhaustive()` is mandatory on closed unions; `.otherwise()` is permitted **only** on open types (`number`, `string`, `unknown`) or single-struct `P.when` guards where `.exhaustive()` cannot be used. `match(...).run()` is banned.
  - Inside `Effect.fn` / `Effect.gen`, `.with()` callbacks are not generators: return an `Effect` or `TaggedError` from each `.with()` arm and `return yield* match(...)...exhaustive()` once at the outer level.

## Nx taxonomy

- `type:contract` — shared Schemas, `HttpApi`, `RpcGroup`, API errors; imports `effect` only
- `type:domain` — use cases and pure logic, no I/O; imports `contract` (and `@harness/gates` for `stub` in skeletons); must not depend on `type:infra`
- `type:service` — service interfaces, including repositories
- `type:infra` — live Layer implementations, Drizzle repositories and handlers, Alchemy resources
- `type:app` — composes Layers and runs the runtime; the `web` app may import `contract` and UI libraries only

## Data layer rules (Drizzle on D1 / Durable Objects)

- `drizzle-orm` (`1.0.0-rc.5-ab785fc`), `@effect/sql-*`, and table schemas (`sqliteTable`) are imported only in `type:infra`; repositories decode rows into contract Schemas, so Drizzle types never reach the domain or the frontend.
- Migrations are generated by hand with `drizzle-kit generate` and committed; they are never generated at deploy. A migration containing `DROP` or a table rebuild escalates to the human.

## Infrastructure (Alchemy)

- The sample app (`apps/sample`) declares cloud infrastructure with Alchemy v2 (`2.0.0-beta.80`); its source is pinned read-only in `repos/alchemy`.
- Resources and bindings (`alchemy`, `alchemy/*`) may be created or imported only in `type:infra` libraries and the app's `alchemy.run.ts`; a `type:domain` library never creates or binds a cloud resource.
- Never run `alchemy deploy` or `alchemy destroy` — they are human-only and the guard asks before them. Every deploy is confirmed individually, never batched.
- Cloudflare credentials live in Alchemy profiles: `alchemy profile edit --add Cloudflare` saves them to `~/.alchemy/profiles.json`. Never export `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN`, never put them in `.env`.
- For Alchemy lookups read the pinned source in `repos/alchemy` and the vendored doc snapshots `docs/alchemy-llms.txt` (index) and `docs/alchemy-llms-full.txt` (per-resource reference — grep it locally, do not fetch). The live https://alchemy.run/llms.txt documents the newest release and drifts from our pin; use it only to refresh the snapshots. Tutorial: https://alchemy.run/cloudflare/tutorial/part-1 through part-5.

## Definition of done

`nx affected -t verify` green (typecheck + lint + test per project). Deterministic gates always
win; the decision model never overrides them.
