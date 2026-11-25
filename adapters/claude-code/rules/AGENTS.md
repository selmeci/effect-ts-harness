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

## Experimental Development (No Backwards Compatibility)

- This repository is in **active experimental development** — **do not preserve backwards compatibility** for internal APIs, CLI flags, schemas, persisted prototype formats, unreleased migrations, or skill/adapter contracts unless explicitly requested.
- **Rewrite directly & delete dead code:** Refactor in place, update all callers in the same change, and immediately delete superseded code, compatibility shims, fallback paths, deprecated aliases, unused flags, and obsolete tests/docs.
- **Prefer clean-slate simplification over bridges:** When iterating on prototypes or architecture, replace old designs outright instead of layering wrappers, dual formats, or temporary re-exports on top.

## Workflow (one task)

plan (in Effect idioms, `agent-patterns/planning.md` template) → skeleton with `stub<A, E, R>(...args)` typechecks →
`pnpm harness plan-check` (`plan/<task>` branch; compact JSON summary by default, pass `--mermaid` for full Mermaid topology) → implement (isolate concurrent subagents in isolated git worktrees for full-slice `plan-check -> verify` flows, or `HARNESS_WORKTREE_ID=<unit>` for package-scoped `nx run <pkg>:verify` workers in a shared checkout) → review (`effect-code-review`, reviewers selected by `Harness.routeReviewDiff` via `harness_review_route` or `pnpm harness review-route`) → LLM phase (`pnpm harness learn` promotes `.harness/friction-log.jsonl` into recipes/gates via `compounding-effect-learnings`; set EARS specs `accepted`; run `pnpm format` (or scoped `pnpm oxfmt --write <touched paths>`); then `pnpm harness learn --clear` and `pnpm harness workflow complete --phase llm`) → final ship pipeline, with no file edits from here on: `pnpm harness workflow ship [--run <id>]` (executing `format-check` → `gc --strict` (`GraphGc.decide`) → `ontology check --strict` → `mutate --strict` → `verify` (`SpanBudget.decide`, `.harness/verify-stamp.json`, `impl/<task>`) → `done --cli` under `ShipWorkflow` + `SpanBudget.decide` + `WfShipAttempt` OCC; standalone non-plan tasks run `pnpm harness workflow ship` in ephemeral mode without `--run`). Any edit after `verify` invalidates the stamp (it hashes every non-ignored file), so `learn` and all doc/format changes always precede the final gates / `workflow ship`.

### MCP-First Tooling Preference

Always prefer in-process MCP tools over spawning shell subcommands to eliminate process overhead and guard prompt friction:

- **MCP Parameter Cheat-Sheet:**
  - `harness_lsp_diagnostics({ file | project, repoRoot?, overlays? })` — strict `@effect/tsgo` type/Effect diagnostics (replaces slow shell lint/typecheck runs during development).
  - `harness_ontology_check({ scope?, repoRoot? })`, `harness_ontology_why({ symbolOrSpan, repoRoot? })`, `harness_ontology_impact({ symbolOrSpan, repoRoot? })` — trace and audit EARS specs and ADR invariants.
  - `harness_tests_reaching({ symbolOrSpan, repoRoot? })` — determines affected test files for touched symbols.
  - `harness_telemetry_report({ format?, cumulative?, repoRoot? })` — reviews session metrics and friction logs.
  - `harness_gq_query({ queryName, params?, branch?, repoRoot? })`, `harness_structural_search({ pattern, paths?, repoRoot? })` — graph queries and `@ast-grep/napi` AST search.
  - `harness_git_diff({ baseRef?, paths?, statOnly?, repoRoot? })`, `harness_review_route({ changedFiles, baseRef?, repoRoot? })` — lock-free diffs and monotonic specialist review routing.
- **Swarm Brief Header Standard:** Every swarm/subagent worker brief MUST start with `REPO_ROOT=<abs path>`, instruct workers to pass absolute paths starting with `<abs path>/` to file tools and `repoRoot: "<abs path>"` to MCP tools, and mandate MCP-first diagnostics (`harness_lsp_diagnostics`, `harness_ontology_check`) before CLI fallbacks.
- **Task Lifecycle Gates (CLI only):** Use `pnpm harness <cmd>` (canonical CLI subcommands including `plan-check [--mermaid]`, `review-route`, `report [--json]`, `gc --strict`, `verify`, `done`, `workflow <compile|start|status|complete|resume|ship|doctor|abort>`) strictly for task state transitions, durable workflow orchestration/shipping, and cryptographic verify-stamp generation.

## Nx taxonomy & Package Archetypes

- **Package Archetypes (Framework vs Application):**
  - **Application Archetype:** Standard user-facing domain models live in `type:domain` (`*.decide`, business use cases).
  - **Framework / Library Archetype:** The repo produces generic engines, protocols, and abstractions (e.g. `AggregateRoot`, `EventStore`, `Decider`). Business domains (e.g. `Cart`, `Inventory`, `Order`) **MUST NEVER** be created in production libraries. Domain models belong strictly to `test/fixtures` or `samples/` tagged with `scope:fixture`.
- `type:contract` — shared Schemas, `HttpApi`, `RpcGroup`, API errors, event/command protocols; `effect` only (workspace: `type:contract` / `[]`; forbidden: `service`, `core`, `domain`, `infra`, `app`, 3rd-party I/O)
- `type:service` — service interfaces and repository ports; imports `type:contract`, `type:service` (external: `effect` only; forbidden: `core`, `domain`, `infra`, `app`, Node/SQL drivers)
- `type:core` — generic engines, gates, and pure logic, no I/O; imports `type:contract`, `type:service`, `type:core` (forbidden: `type:domain`, `type:infra`, `type:app`)
- `type:domain` — use cases and pure logic, no I/O; imports `type:contract`, `type:service`, `type:core`, `type:domain` (and `@harness/contract` for `stub` in skeletons; forbidden: `type:infra`, `type:app`, `alchemy`, `@effect/sql-*`)
- `type:infra` — live Layer implementations, `@effect/sql-*` repositories and handlers, Alchemy resources, adapter implementations; imports `type:contract`, `type:service`, `type:core`, `type:domain`, `type:infra` (forbidden: `type:app`; `drizzle-orm`/`drizzle-kit` banned workspace-wide)
- `type:app` — composes Layers and runs the runtime; may import all library tiers + `type:app` (except `scope:web`, which may import `type:contract` and UI libraries only)

## Planning in Effect idioms

A plan maps each section (including EARS requirements: `WHEN` → input Schema & `A`, `IF/THEN` → `Schema.TaggedError<Self>()("Tag", { ... })` in `E`, `WHILE` → pure `.decide` with `R = never` + stateful service in `R`, `WHERE` → `Layer`/`Config` in `R`; see `agent-patterns/planning.md`) to an Effect building block: Schema at boundaries, tagged errors,
`Context.Service` capabilities, `Layer` dependency graph, `Effect<A, E, R>` use-case signatures,
`Scope` for resources, `Schedule` for retry/concurrency, `Config` + `Effect.fn("name")` spans, test Layers.
Plan as code: write the skeleton first (schemas, errors, service interfaces, signatures using `stub<A, E, R>(...args)` from `@harness/contract`) — it must pass typecheck with preserved `A`, `E`, `R` types before implementation starts. `stub()` is allowed during `HARNESS_PLAN_CHECK=1` and banned in `harness verify`.

## Code style (from `repos/effect/LLMS.md` & `agent-patterns/pattern-matching.md`)

- Prefer `Effect.gen` inline; use `Effect.fn("name")` for reusable traced functions and `Effect.fnUntraced` otherwise; avoid wrappers that only return `Effect.gen`; `return` instead of yielding-and-assigning an error.
- **Exhaustive pattern matching (`ts-pattern`) & Discriminated Unions:**
  - Model mutually exclusive states, commands, events, and results as closed discriminated unions (`Schema.TaggedUnion`, `Schema.TaggedStruct`, `Schema.TaggedClass`) in `type:contract` — never with boolean flags or optional properties.
  - `switch` statements and multi-branch `if / else if` chains are banned in domain/service/infra/app code. Always use `match(value).with(...).exhaustive()` from `ts-pattern`.
  - Never use `if / else` or ternary `? :` to check a discriminant property (`_tag`, `kind`, `status`, custom literal tags) or tag guard (`Option.isSome`, `Either.isRight`, `Result.isSuccess`) — enumerate **all** variants with `match(value)...exhaustive()`, even when the union has only 2 states. Simple `if / else` is allowed only when not inspecting a union discriminant.
  - `.exhaustive()` is mandatory on closed unions; `.otherwise()` is permitted **only** on open types (`number`, `string`, `unknown`) or single-struct `P.when` guards where `.exhaustive()` cannot be used. `match(...).run()` is banned.
  - Inside `Effect.fn` / `Effect.gen`, `.with()` callbacks are not generators: return an `Effect` or `TaggedError` from each `.with()` arm and `return yield* match(...)...exhaustive()` once at the outer level.
- **Zero-`any` & Minimal-`never` Type Safety:**
  - `any` (`as any`, `: any`, `<any>`) is strictly banned across all source and test files. Every value must have a concrete, inferable type or be decoded via `Schema`.
  - `as never`, double type assertions (`as unknown as T`), and explicit `: never` on parameters or variables are banned. `never` is used only in uninhabited type-parameter slots (`Effect<A, E, never>`, `Layer<ROut, never, RIn>`) or conditional type branches.
- **Branded Domain Types & No Inline Object Types (`Schema.brand` & `Brand.Branded` — `harness:SPEC-0005` / `harness:ADR-0007`):**
  - Raw primitive type aliases (`type UserId = string`), inline object type aliases (`type Input = { ... }`), and unbranded scalar schemas in `type:contract` are banned (`harness(syntax-bans)`, `unbranded-contract-schema`). Always pipe scalar schemas into `.pipe(Schema.brand("<BrandName>"))` and derive `export type <BrandName> = typeof <BrandName>.Type`. Each brand key (`Schema.brand("<BrandName>")`) has a single canonical constructor; wire codecs decode into it via `Schema.FiniteFromString.pipe(Schema.decodeTo(<BrandName>))`.
  - Struct, Class, TaggedStruct, TaggedUnion, and TaggedError fields in `type:contract`, `type:domain`, and `type:core` must reference branded schemas rather than raw `Schema.String`, `Schema.NonEmptyString`, `Schema.Int`, or `Schema.Natural`.
  - Exported domain `Effect.fn` use cases, `.decide` / `evolve` functions, `stub<A, E, R>` skeletons, and `Context.Service` capability methods must use branded domain types or named contract `Schema.Struct` / `Schema.Class` / `Schema.Tagged*` types at their parameter and return/success boundaries — never raw primitives (`string`, `number`, `boolean`, `bigint`, `any`, `unknown`) or inline object type literals (`{ ... }`) (`unbranded-primitive-boundary`). Never bypass brand validation with `as <BrandedType>`; use `<Schema>.make(value)`, `Schema.decodeUnknownEffect(<Schema>)`, or Effect v4 `Brand.nominal` / `Brand.make` / `Brand.check`.

## Data layer rules (Native Effect v4 SQL on D1 / Durable Objects)

- `drizzle-orm` and `drizzle-kit` are **banned across the entire workspace**. Use native Effect v4 SQL (`@effect/sql-d1`, `@effect/sql-sqlite-do`, `SqlClient.SqlClient`, `SqliteMigrator`) exclusively in `type:infra`; repositories decode raw SQL rows into `type:contract` `Schema`s, so SQL/driver types never reach the domain or the frontend.
- **Schema Migrations (`SqliteMigrator` on DO SQLite & committed `.sql` migrations on D1 — `harness:SPEC-0006` / `harness:ADR-0008`):**
  - **Durable Object SQLite (`@effect/sql-sqlite-do`):** Schema migrations in `type:infra` (`libs/*/infra/src/**`) must be managed and tracked transactionally via `@effect/sql-sqlite-do/SqliteMigrator` (`SqliteMigrator.run` / `SqliteMigrator.layer` with `SqliteMigrator.fromRecord` or `fromGlob`, recording applied versions in `effect_sql_migrations` using `<positive_int>_<lowercase_snake_case>` keys matching `/^[1-9]\d*_[a-z0-9_]+$/` such as `"1_init_tables"`). Ad-hoc `CREATE TABLE` / `ALTER TABLE` / `DROP TABLE` SQL statements in `libs/*/infra/src/**` are allowed only inside `SqliteMigrator.fromRecord` migration records (`*Migrations` / `fromRecord({ ... })`); stray DDL outside migration records and unnumbered or malformed `fromRecord` keys are strictly banned (`harness(syntax-bans)`, `unmanaged-sql-ddl`, `invalid-migrator-record-key`).
  - **D1 (`@effect/sql-d1`):** Hand-authored forward `.sql` migrations live in `migrations/`, are committed to git, and are validated with `pnpm harness check-migrations`; they are never generated at deploy.
  - **Destructive Migration Safety (`MigrationSafety.decide`):** Any migration (in `.sql` files or `SqliteMigrator` DDL) containing `DROP`, SQLite table rebuilds (`__new_` / `PRAGMA foreign_keys=OFF`), or `ALTER TABLE ADD COLUMN ... NOT NULL` without `DEFAULT` is flagged (`unsafe-sql-migration`) and escalates to the human.
- **Real `workerd` Storage Only — Ban on `node:sqlite` Mocks (`harness:SPEC-0006` / `harness:ADR-0008`):** Importing `node:sqlite` (`DatabaseSync`), `sqlite`, or `better-sqlite3` via static `import`, dynamic `import()`, or `require()` or authoring hand-rolled `DurableObjectStorage`, `SqlStorage`, or `D1Database` mocks in `type:infra` or `type:app` packages (`libs/*/infra/**`, `apps/**`) is strictly banned (`harness(syntax-bans)`, `harness(test-integrity)`, `node-sqlite-in-infra`). Local dev and `type:infra` storage tests must run against the real Cloudflare `workerd` runtime via `@alchemy.run/cloudflare-runtime` (`cloudflareVitePlugin`, `getPlatformProxy` / `D1.local`, and `Workerd` SQLite Durable Objects with `enableSql: true`).

## Infrastructure (Alchemy)

- The sample app (`apps/sample`) declares cloud infrastructure with Alchemy v2 (`2.0.0-beta.80`); its source is pinned read-only in `repos/alchemy`.
- Resources and bindings (`alchemy`, `alchemy/*`) may be created or imported only in `type:infra` libraries and the app's `alchemy.run.ts`; a `type:domain` library never creates or binds a cloud resource.
- Never run `alchemy deploy` or `alchemy destroy` — they are human-only and the guard asks before them. Every deploy is confirmed individually, never batched.
- Cloudflare credentials live in Alchemy profiles: `alchemy profile edit --add Cloudflare` saves them to `~/.alchemy/profiles.json`. Never export `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN`, never put them in `.env`.
- For Alchemy lookups read the pinned source in `repos/alchemy` and the vendored doc snapshots `docs/alchemy-llms.txt` (index) and `docs/alchemy-llms-full.txt` (per-resource reference — grep it locally, do not fetch). The live https://alchemy.run/llms.txt documents the newest release and drifts from our pin; use it only to refresh the snapshots. Tutorial: https://alchemy.run/cloudflare/tutorial/part-1 through part-5.

## Advisory DecisionModel (`clef-flash` — TypeSafe System One API)

- `clef-flash` (`clef-*`) in Ollama is a **TypeSafe System One** model (`@effect/ai-typesafe`), **never** a generative/chat LLM — `/api/generate`, `/api/chat`, `/v1/chat/completions`, `/v1/completions`, and `ollama run clef-flash` **do not exist** on System One models, return HTTP errors, and are blocked by the harness guard and AST linter.
- Always invoke in code via `DecisionModel.decide` + `@effect/ai-typesafe` (`TypeSafeDecisionModel` + `TypeSafeClient` against `http://localhost:11434/v1`, see `agent-patterns/decision-model.md`).
- For CLI readiness/warm-up, use `pnpm harness doctor` (never `curl /api/generate`); if probing raw HTTP in diagnostics, only `POST http://localhost:11434/v1/systemone` (`{ model: "clef-flash", state, questions }`) and `GET /v1/models` / `GET /api/tags` are valid, with `OLLAMA_KEEP_ALIVE=-1` keeping weights resident.

## Definition of done

`nx affected -t verify` green (typecheck + lint + test per project). Deterministic gates always
win; the decision model never overrides them.
