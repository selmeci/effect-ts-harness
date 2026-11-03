# Effect-TS Engineering Harness — Project Brief (MVP)

Oct 3, 2026 · @Roman Selmeci

## Project intent

The goal is a development harness in which an AI agent plans and codes in the idioms and building blocks of Effect-TS v4, enforced rather than merely suggested in a prompt. The repo runs on **pnpm + Nx**, **code-graph-rag** indexes the code structure, and the **Clef-flash decision model via Ollama** makes local decisions.

The harness is **agent-agnostic**: logic lives in the repo as Effect libraries, a CLI and an MCP server. Each agent gets only a thin adapter. The first adapter prototype targets **Claude Code** (skill, `AGENTS.md`, hooks).

The MVP is exercised on a small sample app whose cloud infrastructure is declared with **Alchemy v2**, an Effect-native infrastructure-as-code tool, so infrastructure follows the same idioms, gates and traces as application code.

Context: the project builds on research into governance middleware for LLM coding agents. The harness should be reusable across client projects, so it ships as a plugin, but no logic lives in the plugin.

## Goals and non-goals

The MVP must show that an agent in this harness produces idiomatic Effect code with fewer fix-up iterations than without it.

**MVP goals**

1. Before writing code, the agent produces a plan in Effect terms and a skeleton that passes typecheck.
2. Every change passes deterministic gates: tsgo with Effect diagnostics, oxlint with the Effect preset, `nx affected -t verify`.
3. Test traces from Effect spans feed code-graph-rag from phase 1, so the agent queries runtime-confirmed call edges and the tests behind them.
4. The `R` channel works as a capability manifest: `effect-graph:check` catches layer-rule violations, including infrastructure bindings.
5. The sample app's infrastructure is Effect code too (Alchemy Layers), covered by the same gates and emulated tests.
6. The agent reads a pinned Effect source and pattern files, not external docs.
7. The decision model handles only the semantic remainder: safety gate, idiom router, failure triage.
8. The core runs without an agent (CLI and CI); the Claude Code adapter is thin.

**MVP non-goals**

- Adapters for OpenCode and DeepSeek Harness (only confirm the design does not rule them out).
- Repowise, git-history layers, code-health metrics.
- Production trace overlay (eBPF or OpenTelemetry from deployed services); MVP traces tests only.
- Alchemy live stages, per-PR preview deploys and production monitoring.
- Postgres via Hyperdrive, Kysely, browser end-to-end tests.
- Fine-tuning the decision model.
- Final generators: the MVP needs `service`, `use-case`, `contract`, `repository`, `endpoint` and `rpc` in a basic form.

## Architecture

All logic lives in Effect libraries in the repo; the CLI and MCP server expose it, and each agent gets only a thin adapter. CI calls the same CLI, so every gate also runs without an agent.

&#91;embedded content: harness architecture · callers, interface, core, runtimes\]

Read top to bottom: callers on top, one shared contract, three core Effect services, and the local runtimes they use. The accented box is the MVP adapter; dashed boxes come later.

```
libs/harness/
  decision/      DecisionModel definitions over effect/ai + @effect/ai-typesafe
  ingest/        Effect.fn name index, recording tracer, trace JSONL converter
  graph/         type-aware R / E manifest (phase 3)
  gates/         tsgo, oxlint, effect-graph:check, policy
apps/harness-cli/      harness guard | route | done | ingest …
apps/harness-mcp/      the same operations as MCP tools (no graph queries)
adapters/
  claude-code/   plugin: hooks.json -> harness-cli, .mcp.json -> harness-mcp + code-graph-rag MCP, skill
repos/effect/    squashed subtree, read-only
agent-patterns/  reviewed pattern files
AGENTS.md        agent-neutral rules
```

Each core part is an Effect service with a Layer (`DecisionModel`, `Ingest`, `Gate`), so tests swap in mock Layers and a new agent needs only a new adapter. Code questions go straight to code-graph-rag's MCP server; the harness never wraps it. This is the "everything is a plugin" idea from DeepSeek Harness, expressed with Effect Layers.

## Workflows

One task runs plan → plan check → implement → verify → done. At each step the agent leans on three kinds of tools: code-graph-rag for code knowledge, Effect devtools for typed feedback, and `effect/ai` with Clef for bounded decisions. Clef is never a skill and the agent never calls it directly: it sits behind the `harness` CLI, inside a hook the agent cannot skip or a command the skill tells it to use.

&#91;embedded content: task workflow · each step with code-graph-rag, Effect devtools and effect/ai + Clef\]

Read each row left to right: the step, then what it uses from each tool family; an empty cell means that family plays no part in the step. A red `harness verify` sends the agent back to Implement. The highlighted plan check is the only point where a human is always involved; the dashed bottom row is what a human uses when escalated.

**Where Effect devtools and `effect/ai` sit**

| Step             | Tool                                                                     | How it is used                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan             | Effect LSP (part of `@effect/tsgo`)                                      | `Context.Service` scaffolds and the Layer-composition view; the agent gets the scaffolds through the Nx generators, the human uses the Layer view when reviewing      |
| Plan check       | `@effect/tsgo`                                                           | skeleton typecheck with Effect diagnostics raised to errors (floating Effects, Layer requirement leaks)                                                               |
| Implement        | `@effect/tsgo` + oxlint with the Effect plugin                           | post-edit hook per file; diagnostics read like ordinary TypeScript errors, LSP refactors (to `Effect.gen` / `Effect.fn`) where the agent's LSP access allows          |
| Verify           | `@effect/vitest`, Alchemy `Test.make` (emulated), full tsgo + oxlint run | tests run with the recording tracer Layer, which writes the trace for code-graph-rag; infra-backed tests run against `alchemy dev` emulation, nothing deployed        |
| Human escalation | VS Code Effect extension                                                 | debugger with fiber context, span stack, fiber list and pause on defect                                                                                               |
| Every Clef cell  | `effect/ai` `DecisionModel` + `@effect/ai-typesafe`                      | one service for all decisions; tests swap in a deterministic `DecisionModel` Layer; each decision is a span in the same tracer, so escalations show why they happened |

**Where each Clef call sits.** Deterministic rules run first; Clef sees only what they leave open, and on timeout or Ollama down the safer outcome wins.

| Touchpoint     | Triggered by                                                            | Decided deterministically first                                                                                                                          | What Clef decides                                                      | Outcome                                                                                                      |
| -------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Idiom router   | agent calls `harness_route` (MCP) for each plan step, as the skill says | nothing                                                                                                                                                  | which Effect building block fits the step, and whether any does        | pattern file to load, or `review`; **advisory only**                                                         |
| Router re-run  | `harness plan check`                                                    | —                                                                                                                                                        | same question over all plan steps                                      | mismatches between the plan's declared block and the router's pick become notes for the human; never a block |
| Safety guard   | pre-tool hook                                                           | allowlist (`nx`, `pnpm test`, edits inside the workspace) and denylist (`rm -rf` outside the repo, `.env`, `push --force`, `alchemy deploy` / `destroy`) | only unknown commands: destructive, secret, off-task                   | allow, block, or ask a human                                                                                 |
| Failure triage | inside `harness verify`                                                 | known tsgo / oxlint diagnostic codes mapped to "mechanical"                                                                                              | only unmapped failures, typically tests                                | grouped output: mechanical with fix hints, semantic with code-graph-rag context                              |
| Plan coverage  | stop hook                                                               | `verify` must be green, else block without asking                                                                                                        | Clef 27B: does the diff cover every plan step, any out-of-plan changes | allow, block with reasons, or ask a human                                                                    |

**Decisions**

1. **The idiom router is advisory.** It loads the right pattern file and its picks are logged; it never blocks. Turning it into a gate is reconsidered only after calibration data exists.
2. **`harness verify` is the only sanctioned way to verify.** Only this command runs failure triage and trace ingest together; the skill says so and the stop hook checks that the last `harness verify` is green.
3. **The human sees a plan only once it is ready and proven to follow the conventions.** `harness plan check` runs first: the plan template is complete, the skeleton typechecks, the conventions hold (naming, Nx boundaries, and from phase 3 `effect-graph:check` on the skeleton), and the router re-run is attached as notes. A plan that fails goes back to the agent, never to the human. After approval, the human steps in only when necessary: a guard "ask", a plan-coverage "ask", or `verify` still red after a set number of attempts.

**Flows outside the task loop**

- **Session start (hook):** check that Ollama and the code-graph-rag daemon run, update the graph if `HEAD` moved, warn about `dynamic_stale` edges. No Clef.
- **After each edit (hook):** tsgo on the changed file; `reingest` in code-graph-rag unless the edit went through its write tools, which re-ingest on their own. No Clef.
- **CI:** the same `verify` and trace ingest, fully deterministic, no Clef.
- **Calibration (offline, e.g. weekly):** decision spans plus the human verdicts tune thresholds. Cases Clef keeps getting right move into the deterministic tables (a command into the allowlist, a diagnostic into the mapping), so Clef handles fewer cases over time and mostly new ones.

## Knowledge layer

The agent learns Effect from the source code and tests of a pinned version, not from docs or the web. The Effect team recommends this, and `LLMS.md` says the same.

- **Subtree:** `git subtree add --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash`. Update with `git subtree pull` using the same arguments, ideally as an Nx target.
- **`repos/` is read-only:** never edit it, never import from it. App code imports from regular packages.
- **Editor:** exclude `repos/**` from search, file watching and auto-imports (`.vscode/settings.json`).
- **Pattern files** in `agent-patterns/`, generated by the agent from the vendored code and then reviewed: `services-and-layers.md`, `errors.md`, `schema.md`, `resources-scope.md`, `concurrency.md`, `schedule.md`, `testing.md`, `planning.md`.

**Order of authority in `AGENTS.md`**

1. `repos/effect/LLMS.md`
2. source code and tests in `repos/effect`
3. `agent-patterns/*.md`
4. effect-graph and the Nx graph for anything about services and Layers

Google Code Wiki is **out**: it has no official API or MCP, cannot be pinned to a version, and is generated prose of exactly the kind `LLMS.md` tells agents to avoid.

## Planning in Effect idioms

A plan is written in Effect building blocks, never as prose like "we'll build an endpoint that…". The template in `agent-patterns/planning.md` maps each plan section to one block:

| Plan section                   | Effect building block                                                             |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Domain data and I/O boundaries | `Schema` in `type:contract` (decode/encode at every boundary)                     |
| Expected errors                | tagged errors, listed per use case                                                |
| Defects                        | what is `die` vs `fail` (the two error types)                                     |
| Capabilities                   | services (`Context.Service`) with an interface                                    |
| Dependency graph               | `Layer`: what each layer provides and requires                                    |
| Shared relational data         | D1 table (Drizzle `sqliteTable`) + repository service + migration                 |
| Per-entity state               | Durable Object with its own SQLite schema + migration                             |
| Public API                     | `HttpApi` endpoint with declared error Schemas                                    |
| Internal calls                 | `RpcGroup` procedure                                                              |
| Frontend data                  | `AtomHttpApi` atoms over the public API                                           |
| Infrastructure                 | Alchemy resources and bindings inside the service's `Layer`                       |
| Use cases                      | an `Effect<A, E, R>` signature for each                                           |
| Resources                      | what needs `Scope` or acquire/release                                             |
| Concurrency                    | fibers, limits, timeouts, retry via `Schedule`                                    |
| Config and telemetry           | `Config`, spans via `Effect.fn("name")`, logs                                     |
| Tests                          | test Layers, TestClock, `HttpApiTest` / `RpcTest`, Alchemy `Test.make` (emulated) |

**Plan as code.** The agent first writes only a skeleton: schemas, errors, service interfaces and use-case signatures with stub bodies. The skeleton must pass typecheck before any implementation starts. Once `harness plan check` passes, a human reviews the plan by reading `E` and `R` types, not prose.

**Code style from `LLMS.md`:** prefer `Effect.gen` inline; for reusable functions use `Effect.fn("name")` when tracing helps and `Effect.fnUntraced` otherwise; avoid functions that only wrap and return `Effect.gen`; return when yielding an error.

## Gates and feedback

Deterministic gates come first and always win; the decision model never overrides them. A task is not done until `nx affected -t verify` is green.

| Gate                                                | What it catches                                                                                                                  | How it is wired                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@effect/tsgo` (TypeScript-Go + Effect diagnostics) | floating Effects, Layer requirement leaks, redundant `Effect.gen`/`pipe`, catch on infallible Effects, duplicate Effect versions | `npx @effect/tsgo setup` at repo root; needs native TypeScript 7; `prepare: effect-tsgo patch`                                |
| oxlint + `effecttsgo` plugin                        | Effect lint rules in type-aware mode                                                                                             | `effect-tsgo patch --oxlint`; `.oxlintrc.json` extends the `recommended` preset; LSP `diagnostics: false` to avoid duplicates |
| Custom bans in `libs/`                              | `async`/`await`, `new Promise`, `try`/`catch`, `throw`, `JSON.parse` without Schema; `drizzle-orm` outside `type:infra`          | oxlint restricted syntax and imports; one allowed escape hatch at foreign boundaries                                          |
| `@nx/enforce-module-boundaries`                     | forbidden dependencies between layers; `web` importing anything but `contract` and UI                                            | tags `type:contract`, `type:domain`, `type:service`, `type:infra`, `type:app`                                                 |
| `effect-graph:check`                                | a use case whose `R` holds a forbidden service, a D1 / Durable Object binding outside infra                                      | cacheable Nx target, see the graph section                                                                                    |
| Migration check                                     | Drizzle schema changed without a committed migration; destructive SQL (`DROP`, table rebuild)                                    | `drizzle-kit generate` into a temp folder must add nothing; destructive SQL escalates to the human                            |
| `oasdiff breaking`                                  | breaking change of the public `HttpApi`                                                                                          | `contract:openapi` snapshot vs `main`; ERR escalates to the human, WARN is a note                                             |
| `verify`                                            | composite: typecheck, lint, test, the checks above                                                                               | `harness verify` (runs `nx affected -t verify` plus trace ingest)                                                             |

Raise key Effect diagnostics to `error` severity so the gate actually blocks. The VS Code Effect extension adds a debugger (fiber context, span stack, fibers, pause on defect) for humans; agents get OpenTelemetry spans and logs from tests instead.

**Nx library taxonomy:** `type:contract` holds shared Schemas, `HttpApi` and `RpcGroup`s; `type:domain` holds use cases and pure logic with no I/O; `type:service` holds service interfaces; `type:infra` holds live Layer implementations, Drizzle repositories and handlers; `type:app` only composes Layers and runs the runtime, and the `web` app may import only contracts and UI libraries. Domain must not depend on infra. The full table is in the application stack section.

## Code graph: code-graph-rag, prepared for Effect

code-graph-rag stays the agent's code-intelligence tool and the agent uses its own MCP tools unchanged. The harness only prepares what code-graph-rag ingests, so those tools understand Effect code. No parser fork and no harness-specific query tools.

**Why not a parser fork.** Tree-sitter sees syntax, not types. In Effect, real dependencies live in the `R` channel and Layer composition, which only the type checker resolves. Canonical code from generators helps syntactic patterns, but `R` and `E` are never exact from syntax.

**code-graph-rag facts:** MIT; tree-sitter parsing into Memgraph (Neo4j also supported); Cypher-queryable schema; MCP server for Claude Code; needs Python 3.12+, Docker, cmake, ripgrep. The graph is shared and `--clean` wipes **every** project in it.

**What the agent uses, and what ingest prep adds for Effect**

| code-graph-rag MCP tool                     | Gap on Effect code without prep                                                                                 | What our ingest adds                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `resolve`, `definition`, `get_code_snippet` | an `Effect.fn("…")(function*…)` wrapper may not map to the node we expect                                       | name index verified against `resolve` with `path:line` in phase 1; gaps reported, never guessed           |
| `callers`, `callees`                        | calls go through service tags (`yield* UserRepo`), so static `CALLS` edges are missing or stop at the interface | trace `CALLS` edges from use case to the concrete Layer method; `receiver_types` names the Layer that ran |
| `tests_reaching`                            | no path from tests through the fiber runtime                                                                    | trace edges carry the test ids as workloads                                                               |
| `glosses`, `annotate`                       | nothing about `R` and `E`                                                                                       | option: generated Glosses with the `R` / `E` manifest and `MENTIONS` edges to services (open question)    |
| `structural_search`                         | works as is (ast-grep)                                                                                          | used by the skill for idiom checks, e.g. `Effect.runPromise` inside `libs/`                               |
| `query_code_graph`, `ask_agent`             | LLM-generated Cypher                                                                                            | `CYPHER_PROVIDER=ollama` locally; per code-graph-rag's own guidance, the deterministic tools come first   |

All deterministic tools above run fixed graph queries with no LLM, so better ingest data directly means better answers ([MCP tool reference](https://github.com/vitali87/code-graph-rag/blob/main/docs/guide/mcp-server.md)).

**Ingest preparation on the harness side**

1. **Static parse:** `cgr start --update-graph` as usual; `reingest` after edits (the write tools do it automatically).
2. **Name index (phase 1, syntactic):** every `Effect.fn` literal name with file and line, checked against `resolve`; the coverage rate is a tracked number.
3. **Test traces (phase 1):** JSONL from the recording tracer, `cgr trace ingest` (see the next section).
4. **R / E manifest (phase 3, type-aware):** feeds the `effect-graph:check` gate. Whether it is also written into code-graph-rag as Glosses is decided after phase 1.
5. **Freshness:** `nx affected -t graph:ingest` re-traces changed projects so `dynamic_stale` edges get refreshed.

**Open technical questions:** which nodes code-graph-rag's TypeScript parser creates for `Effect.fn(…)(function*…)`, `Layer.effect(…)` and `Context.Service` classes (phase-1 spike, decides how trace frames are addressed); and whether TypeScript 7 (native) has a stable programmatic type-checker API for the phase-3 extractor, or it runs on the JS TypeScript API (e.g. ts-morph) for now.

## Runtime traces from tests

Test traces enter code-graph-rag from phase 1, because for Effect the real call graph only exists at runtime. The trace source is Effect's own span tree, not the JS call stack.

**Why not only the V8 profile.** code-graph-rag already supports Node.js through `node --cpu-prof` plus source maps. That profile is sampled (short calls can be missed, counts are sample counts) and follows the JS stack. In Effect, a use case's generator yields to the fiber runtime, so when a service body runs the use case frame is usually not on the stack. Expect few user-to-user edges from it; keep it as a cheap baseline, not the main source.

**Main source: an Effect span tracer in tests.**

1. **Naming rule (lint-enforced):** every exported use case and service method is an `Effect.fn("Module.name")` with a unique literal name. This makes spans joinable to code.
2. **Static index:** a syntactic index maps each `Effect.fn` literal name to its file and line. Literal names need no type checker, so this works in phase 1; the type-aware extractor later reuses it.
3. **Recording tracer:** a test Layer for `@effect/vitest` installs a custom `Tracer` that records `name` and `parent` for every span, tagged with the current test id.
4. **Converter:** parent → child span pairs become caller → callee frames via the static index, written in code-graph-rag's trace format (below), with `sampled: false` and exact counts.
5. **Ingest:** `cgr trace ingest` writes `CALLS` edges with `dynamic: true`, `dynamic_workloads` (test ids) and `static_missed` where static analysis saw no edge.

**Trace interchange format** (JSONL, `TRACE_FORMAT_VERSION = 1`): first line `{"kind":"header","version":1,"language":"javascript","repo_root":"…","tracer":"effect-span","sampled":false}`, then one line per pair: `{"kind":"call","caller":{"path","qualname","line"},"callee":{…},"count":n,"workloads":[…],"receiver_types":[]}`.

**What the agent gains, through code-graph-rag's own tools:** `callees` on a use case returns the service methods that actually ran, `receiver_types` says which Layer served them (live or test), `callers` works across `yield*` boundaries, and `tests_reaching` names the tests to run after an edit. Dynamic edges carry `dynamic_stale` after code changes, so the harness re-traces affected projects as part of `verify`.

**Nx wiring:** `test:trace` target per library (cacheable, outputs the JSONL), `graph:ingest` depends on `effect-graph` and `test:trace`. `nx affected -t graph:ingest` keeps the overlay fresh.

## Infrastructure as Effect: Alchemy

The MVP's sample app declares its cloud infrastructure with Alchemy v2, so infrastructure is Effect code too and the same gates, `R` manifest and traces cover it. Alchemy is a tool the sample app uses, not part of the harness core.

**Facts (checked 2026-10-04):** `alchemy` 2.0.0-beta.80, Apache-2.0, built on `effect` ^4.0.0 with `@effect/tsgo` and `@effect/vitest` in its own workspace. A service's `Layer` owns both its infrastructure and its implementation (e.g. an R2 bucket plus a read/write binding inside `Layer.effect(Photos, …)`). Each Layer declares in its type the resources it creates, the access it grants and the services it calls, so a missing binding fails typecheck; IAM policies are generated from those types at deploy. `alchemy dev` emulates Workers, Durable Objects, queues and buckets locally; `Test.make({ dev })` runs the same test suite emulated or against a real stage that it deploys and destroys (about 20 s, vendor figure). CI can deploy a preview stage per pull request. An `Observability` Layer sends OpenTelemetry traces and logs, with dashboards and monitors declared as resources. Agent docs: `llms.txt` and `llms-full.txt`.

**Why it fits the harness**

- **The capability manifest reaches the cloud.** Resources and bindings show up in a Layer's requirements, so `effect-graph:check` can enforce infrastructure policy the same way: only `type:infra` libraries may create resources or bindings, and a domain use case never requires one.
- **Plans stay in Effect terms.** Infrastructure becomes one more row of the plan template (resources and bindings inside the service's Layer), reviewed through the same `R` types.
- **One test kit.** Alchemy tests are `@effect/vitest` tests, so the recording tracer Layer and the trace ingest apply unchanged.

**Where it plugs in**

| Area                    | Use of Alchemy                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge layer         | second read-only subtree `repos/alchemy` pinned to the installed version; `agent-patterns/alchemy-infra.md` generated from it and reviewed; `llms.txt` for lookups                            |
| Nx targets (sample app) | `dev` = `alchemy dev`; `test:emulated` = tests with `dev: true`, part of `verify`; `test:live` and `deploy` run in CI only                                                                    |
| Gates                   | tsgo checks infra types like any code; `effect-graph:check` gains the infra policy                                                                                                            |
| Safety guard            | `alchemy deploy`, `alchemy destroy` and profile commands are on the denylist for the agent (ask a human), matching Alchemy's own advice to confirm every deploy                               |
| Runtime traces          | emulated Workers run in workerd, outside the test process, so their spans need an OpenTelemetry exporter (the `Observability` Layer pattern) to a local collector that writes the trace JSONL |
| code-graph-rag          | `alchemy.run.ts` and resource Layers are ordinary TypeScript and get indexed; trace `receiver_types` show which Layer ran (e.g. R2 vs S3)                                                     |

**MVP scope:** sample app on Cloudflare via Alchemy, emulated tests inside `verify`. Live stages, per-PR previews and production telemetry come after the MVP; the `Observability` Layer is the later path to a production trace overlay.

## Application stack: data, API, RPC, frontend

The sample app covers the layers most real projects need: a typed database layer on D1 and Durable Objects, a public HTTP API, internal RPC, a typed React client, and a Cloudflare deployment. Each layer uses Effect v4 building blocks and gets its own harness rules.

**Contract-first, one Schema as the source of truth.** A new library tag `type:contract` holds domain Schemas, the public `HttpApi`, the internal `RpcGroup`s and API errors. It depends only on `effect` and is imported by the server, internal clients and the frontend, so type safety across the wire comes from sharing one definition, not from code generation.

| Tag              | Holds                                                          | May import                           |
| ---------------- | -------------------------------------------------------------- | ------------------------------------ |
| `type:contract`  | Schemas, `HttpApi`, `RpcGroup`, API errors                     | `effect` only                        |
| `type:domain`    | use cases, domain errors                                       | `contract`                           |
| `type:service`   | service interfaces, including repositories                     | `contract`, `domain`                 |
| `type:infra`     | Drizzle repositories, HTTP and RPC handlers, Alchemy resources | everything except `app`              |
| `type:app` (api) | the Worker: composes Layers, `HttpApiBuilder`, `RpcServer`     | everything                           |
| `type:app` (web) | Vite + React                                                   | **`contract` and UI libraries only** |

**Database: Drizzle on D1 and Durable Objects, through Alchemy**

- **Two stores, two plan rows.** D1 holds shared relational data queried across entities; Durable Object SQLite holds one entity's strongly consistent state. The plan names which one each piece of data lives in, and the idiom router gets the categories `d1-repository` and `durable-object-state`, each with a pattern file.
- **Typed queries.** `Drizzle.D1` (`alchemy/Drizzle`, driver `drizzle-orm/effect-d1` on `@effect/sql-d1`) and `Drizzle.DurableObject` (`alchemy/Drizzle/Cloudflare`, driver `drizzle-orm/effect-sqlite-do` on `@effect/sql-sqlite-do`). Table schemas are TypeScript (`sqliteTable`), columns are checked at compile time, every query is an Effect and failures arrive as `EffectDrizzleQueryError` in `E`.
- **Boundaries.** `drizzle-orm` and table schemas are imported only in `type:infra`; repositories map rows to contract Schemas, so Drizzle types never reach the domain or the frontend. Enforced twice: an oxlint import ban and the `R` manifest (only infra may require a D1 or Durable Object binding).
- **Migrations: generated by hand, committed.** `drizzle-kit generate` runs in development and its output is committed; deploys only apply it (`Cloudflare.D1.Database` with `migrationsDir`, `Drizzle.DurableObject` with bundled migrations). Generation at deploy time (`Drizzle.Schema`) is not used, because CI cannot answer drizzle-kit's interactive drift questions.
- **Migration gates in `verify`.** Running `drizzle-kit generate` into a temp folder must produce no new file, otherwise the schema changed without a migration. A migration containing `DROP` or a table rebuild escalates to the human, the same caution Alchemy applies at deploy, moved into the plan check.
- **Tests.** Emulated tests under `alchemy dev` apply the migrations to local D1 and Durable Object SQLite, so repositories run against the real SQL dialect.

**Public HTTP API**

- `HttpApi` in the contract; every endpoint declares its errors as Schemas, so the `E` channel maps to HTTP statuses and clients receive typed errors. Handler tests use `HttpApiTest`.
- **Breaking-change gate: oasdiff.** The `OpenApi` module exports `openapi.json`, committed in the contract library (cacheable Nx target `contract:openapi`). `oasdiff breaking` compares it with the snapshot on `main`; it is a deterministic CLI with exit codes, so no Clef is involved. Level ERR escalates to the human, level WARN becomes a note. It runs only when `nx affected` touches the contract. This matters even with our own frontend in the same repo, because users' browsers may still run an older deployed build.

**Internal RPC**

- `RpcGroup` in the contract, `RpcServer` in the api app, `RpcClient` in the calling services. External clients always use `HttpApi`; RPC is internal only (Worker to Worker, calls into Durable Objects).
- **Compatibility: a note, not a gate.** RPC groups deploy together in one Alchemy stack, so a hard gate would be too strict. A JSON Schema snapshot of each `RpcGroup` (Effect's `JsonSchema` module) is diffed and attached to the plan check for review. Calls into Durable Objects that may still run old code during a deploy deserve care later; not in the MVP.

**Frontend: Vite + React**

- `AtomHttpApi` (`effect/reactivity`) derives a typed client from the same `HttpApi`; results are `AsyncResult` atoms through `@effect/atom-react`. The frontend uses the public API, not RPC, so there is no hidden second channel that can drift from the contract.
- Component tests use a mocked client provided by a Layer; browser end-to-end tests come after the MVP.

**Deployment on Cloudflare**

- One Alchemy stack: the api Worker (`HttpApiBuilder` + `RpcServer`), D1, Durable Objects, R2 if needed, and `Cloudflare.Website.Vite` for the frontend, which receives the API URL from the Worker's output.
- Bindings live in Layer types, so a repository without its database fails typecheck. Deploys run in CI only, as decided.

**What this adds to the harness**

- **Plan template:** rows for D1 data, Durable Object state, public API endpoints with declared errors, internal RPC and frontend atoms.
- **Nx generators:** `contract`, `repository` (D1 or Durable Object), `endpoint` and `rpc`, each producing a skeleton that passes the gates.
- **Gates:** Drizzle import ban and the D1/Durable Object binding rule in `effect-graph:check`, migration check, destructive-migration escalation, oasdiff, module boundaries for `web`.
- **Idiom router categories:** `d1-repository`, `durable-object-state`, `httpapi`, `rpc`, `atom` (still within the 26-option limit).
- **Traces:** `HttpApi` and RPC create server spans themselves, so traces show endpoint → use case → repository, which static parsing cannot see. Whether code-graph-rag's `endpoints` and `endpoint_callers` tools recognise Effect routes is checked in the phase-1 spike.

## Decision model: Clef-flash via Ollama

Clef-flash runs locally on the RX 7900 XTX (24 GB) and answers only bounded semantic questions; anything a type checker or graph can decide stays deterministic.

**Facts:** 9B model fine-tuned from Qwen3.5-9B; 11 GB in Ollama; needs Ollama 0.35.1+; endpoint `POST /v1/systemone`, Jev/System One API compatible; Apache 2.0. Median latency about 39 ms, p95 about 122 ms (Cloudflare's numbers).

**Implementation: `effect/ai` + `@effect/ai-typesafe`.** Effect v4 ships a provider-neutral decision API, so the harness writes no HTTP client of its own:

- `effect/ai/Decision`: `Decision.make({ input, decisions })` with `Decision.classify`, `Decision.rate` and `Decision.probability`. The input is a `Schema`, encoded to JSON as the `state`; answers are typed by label, so a `switch` over `answers.block.label` is exhaustive.
- `effect/ai/DecisionModel`: the `DecisionModel` service and `DecisionModel.decide(definition, { input })`. It validates every answer (known labels, probabilities in \[0, 1\], sums) and fails with a typed `AiError`. Each call runs in a `DecisionModel.decide` span.
- `@effect/ai-typesafe` 4.0.0: `TypeSafeClient.layer({ apiUrl })` posts to `{apiUrl}/systemone`; `TypeSafeDecisionModel.layer({ model })` provides `DecisionModel`. With `apiUrl: "http://localhost:11434/v1"` and `model: "clef-flash"` it targets local Ollama. Its wire schema matches Ollama's documented response.
- Provider swap by Layer: `@effect/ai-cloudflare` (Clef on Workers AI) and `@effect/ai-openrouter` implement the same service; tests use a deterministic `DecisionModel.make` Layer, so gates are testable without Ollama.

Caveats from the source: both modules are marked `@stability unstable`, so pin versions and keep our use behind `libs/harness/decision`. Use `TypeSafeClient.layer` (no key) rather than `layerConfig`, which reads `TYPESAFE_API_KEY`. Do not rely on `listModels`: it expects TypeSafe's `{ models }` shape, which Ollama's `/v1/models` likely does not return (unverified). The library does not enforce Ollama's 2–26 option limit, so a unit test checks every definition.

**Question types:** `noul` (yes/no probability), `choice` (2–26 options), `score` (2–26 ordered levels); 1–64 questions per call. `confidence` measures how concentrated probabilities are, not the chance of being right. Ties follow option order.

| Use in the harness                                                  | Model                                  | Why                                  |
| ------------------------------------------------------------------- | -------------------------------------- | ------------------------------------ |
| Pre-tool safety gate (secrets, destructive, exfiltration, off-task) | Clef-flash                             | hot path, all questions in one call  |
| Failure triage from `verify` (mechanical vs semantic)               | Clef-flash                             | simple classification, many calls    |
| Idiom router for plan steps → which `agent-patterns` file to load   | Clef-flash + `noul` out-of-scope check | fast; weakness mitigated             |
| Done gate (does the diff cover the approved plan?)                  | Clef 27B                               | once per task, needs better judgment |

**Known weaknesses of Clef-flash:** CLINC150+OOS macro-F1 66.8 vs 97.4 for Clef (out-of-scope detection); ANLI 59.1 vs 69.8 (entailment-like judgment). Mitigation: put `review`/`none` as the **first** option, add a separate `noul` "does this fit any option?", and route the done gate to Clef 27B.

**Rules:** thresholds live in code (allow / block / ask a human). Wrap each call in `Effect.timeout` of a few hundred ms and catch the timeout and `AiError`: the safety gate then asks a human, the idiom router loads nothing. Each definition is versioned data in `libs/harness/decision` (`IdiomRouterV1`, `GuardV1`, …). Every call runs inside `Effect.fn("Harness.<decision>")` and annotates its span with the definition version and answers, so the recording tracer from the runtime-traces section doubles as the decision log; the later human verdict is joined to it by span id.

**Idiom router in Effect (sketch, check against the pinned source):**

```ts
import { Effect, Layer, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"

// Versioned decision definition: reviewed data, not a prompt string
export const IdiomRouterV1 = Decision.make({
  input: Schema.Struct({ planStep: Schema.String }),
  decisions: {
    fitsAny: Decision.probability({
      instructions: "Does this step map to a single Effect building block?",
    }),
    block: Decision.classify({
      instructions: "Which Effect building block best implements this step?",
      criteria: {
        review: "Unclear or spans multiple blocks",
        schedule: "Retries, repetition, backoff, timing policies",
        stream: "Incremental or unbounded sequences of values",
        scope: "Acquiring and releasing resources",
        queue: "Producer/consumer handoff, PubSub",
        concurrency: "Forking fibers, racing, parallel work",
        schema: "Decoding, encoding, validating data at a boundary",
        effect: "Plain sequential effectful logic",
      },
    }),
  },
})

export const routeStep = Effect.fn("Harness.routeStep")(function* (planStep: string) {
  const { answers } = yield* DecisionModel.decide(IdiomRouterV1, { input: { planStep } })
  yield* Effect.annotateCurrentSpan({
    "decision.definition": "IdiomRouterV1",
    "decision.block": answers.block.label,
    "decision.fitsAny": answers.fitsAny.probability,
  })
  return answers.fitsAny.probability >= 0.7 ? answers.block.label : "review"
})

// Local Clef-flash through Ollama's System One endpoint
export const LocalDecisionModel = TypeSafeDecisionModel.layer({ model: "clef-flash" }).pipe(
  Layer.provide(TypeSafeClient.layer({ apiUrl: "http://localhost:11434/v1" })),
  Layer.provide(FetchHttpClient.layer),
)
```

On the wire this sends the same `state` + `questions` body as Ollama's own example (`choice`, `noul`, `score`). The done gate uses the same code with `model: "clef"`.

## Agent adapter prototype: Claude Code

The first adapter targets Claude Code because its hook format is the de facto standard others bridge to; the adapter stays thin so other agents can follow.

**`AGENTS.md` (agent-neutral, in the repo root)** holds: the order of authority, rules for `repos/` (read-only, never import), "read `repos/effect/LLMS.md` before writing Effect code", the planning workflow (plan → skeleton → plan gate → implement → verify), the Nx taxonomy and the definition of done (`verify` green). `CLAUDE.md` only points to `AGENTS.md`.

**Skill `effect-harness`** (Claude Code skill): when to load which pattern file, how to fill the plan template, how to call `harness` CLI commands, and the review checklist. It also teaches the code-graph-rag tools: `resolve` / `definition` before reading files, `callers` / `callees` (and their `dynamic` and `receiver_types` fields) before changing a service, `tests_reaching` to pick tests, `structural_search` for idiom checks, and `query_code_graph` only for open questions.

**Hooks → `harness` CLI** (the CLI returns JSON plus an exit code: allow / block / ask a human):

| Hook point    | CLI call                                            | Behavior                                                                                            |
| ------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| session start | `harness session`                                   | Ollama and code-graph-rag daemon up, graph updated if `HEAD` moved, stale dynamic edges reported    |
| pre-tool-use  | `harness guard`                                     | allowlist / denylist first, Clef-flash only for unknown commands; on doubt or timeout ask the human |
| post-edit     | tsgo on the changed file, code-graph-rag `reingest` | fast typed feedback, graph stays current                                                            |
| stop          | `harness done`                                      | blocks unless the last `harness verify` is green; then Clef 27B plan coverage                       |

Not hooks, but commands the skill tells the agent to use: `harness_route` (MCP, per plan step, advisory), `harness plan check` (before any human sees the plan) and `harness verify` (the only sanctioned verify).

**Packaging:** a Claude Code plugin bundles `hooks.json` (calling the CLI), `.mcp.json` (starting `harness-mcp`, Nx MCP and code-graph-rag MCP) and the skill. The plugin checks that `clef-flash` is pulled; it never downloads 11 GB itself.

**Portability facts:** DeepSeek Harness has an official `dsh-hooks-claude-code` bridge for existing `hooks.json` (developer preview; `dsh-compat` still reports hooks as unverified). Grok Build reads `AGENTS.md`, `CLAUDE.md` and `.claude/` rules. OpenCode has its own plugin system (hook coverage not yet verified).

**Subscriptions:** z.ai GLM Coding Plan is allowed only in officially supported tools; Claude Code and OpenCode are on the list, DeepSeek Harness is not. xAI SuperGrok works in OpenCode via OAuth; Grok models cannot run inside Claude Code (only delegation via `grok-build-plugin-cc`). Programmatic calls from harness scripts must never use the GLM plan key; they run on local Ollama.

## MVP scope and phases

The MVP runs in six phases, each closed by one checkable gate; dates are not set yet. Test traces come right after the foundations so code-graph-rag understands Effect code before the agent starts relying on it.

&#91;embedded content: MVP roadmap · 6 phases, 6 exit gates, no dates set\]

Phase 1 needs only the syntactic `Effect.fn` name index; phase 3 upgrades it to the type-aware extractor. Phases 3 and 4 do not depend on each other and can run in parallel; phase 5 needs both. The final gate is the measured outcome from the acceptance criteria.

## Acceptance criteria

The MVP is accepted when every box below is ticked on a fresh clone with only pnpm, Docker and Ollama installed.

**Repo and gates**

- [ ] `pnpm install` patches TypeScript and oxlint via `prepare`; `Effect.log("x")` left unassigned fails typecheck.
- [ ] `nx affected -t verify` runs typecheck, lint and test and is the single definition of done.
- [ ] A `type:domain` lib importing a `type:infra` lib fails `enforce-module-boundaries`.
- [ ] Custom bans fail on `async`/`await`, `try`/`catch` and `throw` inside `libs/`.
- [ ] `repos/effect` is a squashed subtree pinned to a known commit; `LLMS.md` is present.

**Runtime traces**

- [ ] A lint rule fails any exported use case or service method that is not an `Effect.fn` with a unique literal name.
- [ ] The name index reports how many `Effect.fn` names `resolve` maps to a code-graph-rag node; unresolved names are listed.
- [ ] `nx run <lib>:test:trace` writes a valid JSONL trace (`sampled: false`) with one workload per test.
- [ ] After `cgr trace ingest`, the code-graph-rag MCP tool `callees` on a sample use case returns its service methods with `dynamic: true`, and `tests_reaching` returns the tests that exercised them.
- [ ] At least one edge has `static_missed: true` (a call through a service tag that static parsing did not resolve).
- [ ] A V8 `--cpu-prof` baseline run is ingested once and its user-to-user edge count is recorded next to the span tracer's.

**Infrastructure (Alchemy)**

- [ ] The sample app's `alchemy.run.ts` stack typechecks; removing a binding from a Layer fails typecheck.
- [ ] `test:emulated` runs under `alchemy dev` emulation as part of `harness verify`, with nothing deployed.
- [ ] `effect-graph:check` fails when a `type:domain` library creates or binds a cloud resource.
- [ ] The safety guard asks a human before any agent-run `alchemy deploy` or `alchemy destroy`.
- [ ] Spans from an emulated Worker reach the trace JSONL through the OpenTelemetry exporter, or the gap is documented.

**Application stack**

- [ ] A D1 repository and a Durable Object both query through Drizzle on Effect; a wrong column name fails typecheck.
- [ ] Changing a Drizzle table without a committed migration fails `verify`; a migration with `DROP` escalates to the human.
- [ ] Importing `drizzle-orm` outside `type:infra`, or `web` importing a non-contract library, fails lint or module boundaries.
- [ ] The public `HttpApi` exports `openapi.json`; removing a field from a response fails `oasdiff breaking` and escalates.
- [ ] One internal call goes through `RpcGroup`, and its JSON Schema diff appears in the plan check.
- [ ] The React app reads data through `AtomHttpApi` built from the contract, with no hand-written fetch code.
- [ ] The Alchemy stack (api Worker, D1, Durable Object, Vite site) typechecks and runs under `alchemy dev`; emulated tests apply migrations to both stores.

**Effect graph**

- [ ] The type-aware extractor emits the `R` and `E` manifest for every exported Layer and `Effect.fn` in a sample domain.
- [ ] `effect-graph:check` fails when a domain use case requires an infra service, and passes after the fix.
- [ ] A decision is recorded on whether the manifest is also written into code-graph-rag as Glosses, based on phase-1 results.

**Decision model**

- [ ] `DecisionModel` is provided by `TypeSafeDecisionModel.layer({ model: "clef-flash" })` over `TypeSafeClient.layer({ apiUrl: "http://localhost:11434/v1" })`, and one live call against Ollama decodes without `AiError`.
- [ ] The same guard and router tests pass with a deterministic `DecisionModel.make` Layer, with no Ollama running.
- [ ] A unit test fails any decision definition with more than 26 options or 64 questions.
- [ ] `harness guard` blocks `rm -rf` outside the workspace and reading `.env`, allows `nx test`, and asks a human when Ollama is down or times out.
- [ ] `harness route` picks `schedule` for a retry step and `review` for a vague step, in under 300 ms p95 locally.
- [ ] Every decision appears in the trace log as a span carrying definition version, answers and probabilities.

**Agent loop (Claude Code)**

- [ ] For a sample feature the agent writes a plan in the template, a skeleton that typechecks, then the implementation.
- [ ] The stop hook refuses to end the task while `verify` is red.
- [ ] The same `AGENTS.md` and CLI work with the plugin removed (CI run and a manual run).

**Measured outcome**

- [ ] On 5 sample tasks, compare harness vs no harness: Effect diagnostics before first green `verify`, number of fix-up iterations, tokens. The harness wins on at least 2 of 3.

## Verified facts and sources

Facts below were checked on 2026-10-03 against the linked pages; vendor benchmarks are vendor-reported.

| Fact                                                                                                                                                                                                                                                                                               | Source                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect `main` is v4 (`packages/effect` version 4.0.0) and has `LLMS.md` in the root; `LLMS.md` tells agents to use local source and avoid external docs                                                                                                                                            | [Effect-TS/effect](https://github.com/Effect-TS/effect)                                                                                                                                                       |
| Effect v4 `Tracer.span` receives name, parent, annotations, links, start time, kind, root and sampled; captured stack frames live in the `CurrentStackFrame` fiber reference, not on the span                                                                                                      | [Tracer.ts](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Tracer.ts)                                                                                                                      |
| Effect v4 ships `effect/ai/Decision` and `effect/ai/DecisionModel` (provider-neutral, validated answers, typed `AiError`, marked unstable); `@effect/ai-typesafe` 4.0.0 posts to `{apiUrl}/systemone` and provides `DecisionModel`; Cloudflare and OpenRouter providers implement the same service | [DecisionModel.ts](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/ai/DecisionModel.ts), [ai-typesafe](https://github.com/Effect-TS/effect/tree/main/packages/ai/typesafe)                  |
| `@effect/tsgo` = TypeScript-Go with Effect diagnostics; needs TypeScript 7; oxlint and Vite Plus integration; diagnostics readable by agents at build time                                                                                                                                         | [Effect devtools](https://effect.website/docs/v4/getting-started/devtools)                                                                                                                                    |
| Vendor Effect source via `git subtree --squash` into `repos/`; tell the agent via `AGENTS.md`; generate pattern files                                                                                                                                                                              | [Effect blog: git subtree](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive/)                                                                                     |
| Nx offers agent skills, MCP, `configure-ai-agents`, self-healing CI; Turborepo has none of the MCP or CI integration                                                                                                                                                                               | [Nx vs Turborepo](https://nx.dev/docs/guides/adopting-nx/nx-vs-turborepo) (vendor page)                                                                                                                       |
| code-graph-rag: tree-sitter → Memgraph, MCP server, MIT, `--clean` wipes all projects and discards dynamic edges                                                                                                                                                                                   | [vitali87/code-graph-rag](https://github.com/vitali87/code-graph-rag)                                                                                                                                         |
| code-graph-rag runtime tracing: Node.js via V8 `--cpu-prof` (sampled, source-map aware); JSONL format with a header line and call records; ingest sets `dynamic`, `dynamic_workloads`, `static_missed`, `dynamic_stale`                                                                            | [dynamic-tracing guide](https://github.com/vitali87/code-graph-rag/blob/main/docs/guide/dynamic-tracing.md), [records.py](https://github.com/vitali87/code-graph-rag/blob/main/codebase_rag/trace/records.py) |
| Clef-flash in Ollama: 9B, 11 GB, Ollama 0.35.1+, `/v1/systemone`, choice 2–26 options, 1–64 questions, benchmarks incl. CLINC150+OOS and ANLI                                                                                                                                                      | [ollama.com/library/clef-flash](https://ollama.com/library/clef-flash)                                                                                                                                        |
| Clef/Clef-flash: open source (Apache 2.0), Jev-API compatible, latency table                                                                                                                                                                                                                       | [Cloudflare blog](https://blog.cloudflare.com/clef-decision-models/)                                                                                                                                          |
| Jev: typed decisions with calibrated probabilities, no free text                                                                                                                                                                                                                                   | [TypeSafe AI blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)                                                                                                                            |
| GLM Coding Plan limited to officially supported tools (Claude Code, OpenCode and others)                                                                                                                                                                                                           | [z.ai docs](https://docs.z.ai/devpack/overview)                                                                                                                                                               |
| xAI subscription usable in OpenCode via OAuth                                                                                                                                                                                                                                                      | [x.ai news](https://x.ai/news/grok-opencode)                                                                                                                                                                  |
| DeepSeek Harness: MIT, developer preview, plugin-everything, Claude Code hook bridge                                                                                                                                                                                                               | [DeepInfra review](https://deepinfra.com/blog/deepseek-harness-review)                                                                                                                                        |

Added 2026-10-04: Alchemy v2 (`alchemy` 2.0.0-beta.80, Apache-2.0) depends on `effect` ^4.0.0, `@effect/tsgo` and `@effect/vitest`; Layers own infrastructure and implementation, `alchemy dev` emulates locally, `Test.make` runs emulated or live stages ([alchemy.run](https://alchemy.run), [package.json](https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/package.json)).

Added 2026-10-04: Alchemy ships `alchemy/Drizzle` with `Drizzle.D1` (driver `drizzle-orm/effect-d1` on `@effect/sql-d1`) and `Drizzle.DurableObject` (driver `drizzle-orm/effect-sqlite-do` on `@effect/sql-sqlite-do`), queries fail with `EffectDrizzleQueryError`; `Drizzle.Schema` can generate migrations at deploy, or drizzle-kit output can be committed and applied ([SQL overview](https://alchemy.run/sql/), [Drizzle on D1](https://alchemy.run/cloudflare/data/d1-drizzle), [Drizzle.DurableObject](https://alchemy.run/providers/drizzle/durableobject), [Drizzle migrations](https://alchemy.run/sql/drizzle/migrations)). Effect v4 core contains `effect/sql`, `effect/http-api` (incl. `OpenApi`, `HttpApiClient`, `HttpApiTest`), `effect/rpc` and `effect/reactivity` (`AtomHttpApi`, `AtomRpc`); no Kysely or Drizzle package exists in the Effect repo itself.

**Evaluated and set aside:** Google Code Wiki (no official API, unpinned, generated prose); Repowise (good fit, AGPL, but one index is enough and code-graph-rag is easier to extend); forking the tree-sitter parser (wrong layer for `R`/`E`); harness-specific Cypher query tools and custom graph node types (code-graph-rag's own MCP tools are used instead, fed with better ingest data).

## Risks and open questions

The biggest unknowns are whether spans join cleanly to code, the type-checker API for the extractor, and Clef-flash on out-of-scope cases.

| Risk                                                                             | Impact                                                                     | Mitigation                                                                                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| code-graph-rag's TypeScript parser has no node for an `Effect.fn` generator body | trace frames cannot attach; `callers` / `callees` stay empty for use cases | phase-1 spike with `resolve` on `path:line`; attach to the enclosing `const` node; if needed, contribute parser support upstream rather than fork |
| Functions not wrapped in `Effect.fn` with a literal name                         | spans cannot be joined to code; gaps in the runtime graph                  | lint rule in phase 1; generators emit the pattern                                                                                                 |
| Span parent is a framework span (HTTP, SQL), not our use case                    | edges attach to the wrong caller                                           | converter walks up to the nearest indexed span, like the JVM tracer walks to the nearest project frame                                            |
| Emulated Workers run in workerd, outside the test process                        | no spans from Worker code in the trace                                     | OpenTelemetry exporter to a local collector that writes the JSONL; document the gap if it cannot be closed in the MVP                             |
| Alchemy v2 and its Drizzle integration are still beta                            | breaking changes during the MVP                                            | pin versions; keep `repos/alchemy` in sync; only the sample app depends on them                                                                   |
| Drizzle row types leak into domain or frontend                                   | contract stops being the single source of truth                            | import ban outside `type:infra`; repositories decode rows into contract Schemas                                                                   |
| Durable Object migrations apply on activation and die on failure                 | an instance becomes unusable after a bad deploy                            | migrations reviewed in the plan check; emulated tests apply them before deploy                                                                    |
| oasdiff flags changes that are intentionally breaking                            | noisy escalations                                                          | escalation is the intended path; the human approves and the new snapshot is committed                                                             |
| Agent triggers a real deploy or destroy                                          | cost, data loss                                                            | deploy and destroy on the guard's denylist; live stages and deploys in CI only                                                                    |
| V8 profile shows mostly fiber-runtime frames                                     | baseline adds little                                                       | keep it as a measured baseline only                                                                                                               |
| Dynamic edges go stale after edits                                               | agent trusts old runtime facts                                             | `test:trace` + `graph:ingest` run on `nx affected`; agent sees `dynamic_stale`                                                                    |
| No stable TS 7 programmatic API for the extractor                                | type-aware extractor blocked or lags tsgo                                  | syntactic index covers traces; JS TypeScript API (ts-morph) for types for now                                                                     |
| `effect/ai` decision modules are `@stability unstable`                           | API changes on Effect upgrades                                             | pin versions; only `libs/harness/decision` imports them; contract tests on the mock Layer                                                         |
| Ollama's System One responses drift from the TypeSafe wire schema                | `AiError` on decode, every decision falls back                             | one live smoke test per Ollama upgrade; fallback is fail-safe by design                                                                           |
| Clef-flash weak on out-of-scope (CLINC150+OOS 66.8)                              | idiom router picks a wrong block confidently                               | `review` first, separate `probability` decision, log and calibrate                                                                                |
| Ollama ROCm stability on RX 7900 XTX                                             | hooks stall                                                                | short timeouts, fail-safe defaults                                                                                                                |
| Two local models plus Memgraph compete for 24 GB VRAM and RAM                    | slow hooks                                                                 | measure; Clef 27B only on demand via `keep_alive`                                                                                                 |
| Subtrees and pattern files drift from installed versions                         | agent learns the wrong API                                                 | one Nx target updates both subtrees, re-indexes, flags pattern files for review                                                                   |
| GLM plan key used by harness scripts                                             | plan restrictions                                                          | all programmatic calls go to local Ollama                                                                                                         |

**Open questions for brainstorming**

- Sample app feature set: which data goes to D1 and which to a Durable Object, plus one public endpoint group, one internal RPC and one React screen. Confirm the scenario.
- How RPC travels between Workers and into Durable Objects (service binding, Durable Object stub, HTTP): verify in a spike.
- Exact policy rules for `effect-graph:check` beyond domain vs infra, including which Alchemy resources each tag may create or bind.
- What goes into the `contract`, `repository`, `endpoint` and `rpc` generators, and does the plan skeleton come from them?
- Naming scheme for `Effect.fn` spans (`Module.useCase`?) and how to keep names unique across libraries.
- How should trace frames name a Layer in `receiver_types` (Layer variable name, or the service tag plus `Live` / `Test`)?
- Should the `R` / `E` manifest live in code-graph-rag as generated Glosses (visible through `glosses`), or only in the gate's JSON? Glosses are designed for human "why" notes, so a generated fact may be the wrong fit.
- Should CI run decision-based checks at all, and if so through `@effect/ai-cloudflare` (Clef on Workers AI) or a self-hosted Ollama runner?
- How to build the 5-task benchmark so results are comparable across runs?
- When to add the OpenCode adapter (second subscription) after the MVP?
