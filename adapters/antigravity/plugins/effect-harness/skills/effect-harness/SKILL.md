---
name: effect-harness
description: >-
  Effect-TS Engineering Harness skill guiding Antigravity agents through the MVP v2
  development lifecycle, EARS requirement mapping, MCP graph tools, and Effect v4 + Alchemy v2 idioms.
---

# Effect-TS Engineering Harness (Antigravity Edition)

This skill equips Antigravity agents with the instructions, architectural boundaries, tool catalog, and lifecycle workflows required to develop inside the Effect-TS Engineering Harness.

---

## 1. Order of Authority

When learning Effect patterns or resolving architectural questions, adhere strictly to this hierarchy:

1. `repos/effect/LLMS.md`
2. Source code and tests in `repos/effect` and `repos/alchemy`
3. `agent-patterns/*.md` and `docs/alchemy-llms*.txt` (offline vendored reference)
4. `effect/Graph` + Omnigraph (`harness-mcp` / `@modernrelay/omnigraph-mcp`) and Nx graph for services and Layers

> Never cite Google Code Wiki, outdated blog posts, or generic LLM pre-training prose.
> Files under `repos/` are pinned read-only git subtrees: never edit files under `repos/` and never import from them.

---

## 2. Core Workflow (One Task Lifecycle)

Every task follows a strict 7-step gated lifecycle orchestrated by four specialized skills:

- **AUTONOMOUS END-TO-END ORCHESTRATOR (`/effect-lfg`):** Use `effect-lfg` when the user asks to execute a requirement from start to finish hands-off without intermediate approval pauses
- **REQUIRED SUB-SKILL (Step 1 — EARS Discovery):** Use `specifying-ears-with-effect`
- **REQUIRED SUB-SKILL (Steps 2–3 — Skeleton & Plan-Check):** Use `planning-effect-skeletons`
- **REQUIRED SUB-SKILL (Steps 4–6 — Subagent Implementation, GC & Verify):** Use `executing-effect-stubs`
- **OPTIONAL SUB-SKILL (Step 7 — Compound Learning Loop):** Use `compounding-effect-learnings`
- **OPTIONAL SUB-SKILL (PR & Code Review Resolution):** Use `resolving-effect-review-feedback`

```text
plan -> skeleton with stub<A, E, R>(...args) -> harness plan-check -> implement -> harness gc --strict -> harness verify -> harness done -> harness learn
```

1. **Plan (`specifying-ears-with-effect`):** Write a plan in Effect idioms (using the `agent-patterns/planning.md` template), mapping requirements (including business/EARS specifications) to Schemas, TaggedErrors, `Context.Service` tags, `Layer` graphs, and `Effect<A, E, R>` signatures:
   - `WHEN <trigger>, THE SYSTEM SHALL <response>` $\rightarrow$ `HttpApiEndpoint` / `Rpc` input Schema + `Effect.fn` success channel `A`
   - `IF <condition>, THEN THE SYSTEM SHALL <fail>` $\rightarrow$ `Schema.TaggedError<Self>()("Tag", { ... })` in `type:contract` + error channel `E`
   - `WHILE <state>, THE SYSTEM SHALL <response>` $\rightarrow$ closed `Schema.TaggedUnion` state/decision types + pure decider `Effect.fn("*.decide")` (`R = never`) using exhaustive `match(state)...exhaustive()` from `ts-pattern` + stateful `Context.Service` in `R`
   - `WHERE <feature>, THE SYSTEM SHALL <response>` $\rightarrow$ `Context.Service` + `Layer` / `Config` in `R`
2. **Skeleton (`planning-effect-skeletons`):** Implement the skeleton first (schemas, errors, service interfaces, function signatures). For function bodies, use `stub<A, E, R>(...args)` from `@harness/contract` to preserve accurate types. The skeleton must pass typecheck before implementation begins.
3. **`harness plan-check` (`planning-effect-skeletons`):** Run plan-check (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check`). This verifies typecheck and linting under `HARNESS_PLAN_CHECK=1`, verifies unique span names, runs `checkEffectGraph`, writes `.harness/plan-graph-snapshot.json`, and records the plan graph to Omnigraph branch `plan/current`.
4. **Implement (`executing-effect-stubs`):** Replace `stub<A, E, R>(...args)` placeholders with production Effect implementations and comprehensive tests (`it.effect` + `checkSpanBudgets` via `SpanBudget.decide` for N+1 / latency bounds), dynamically choosing between lightweight `invoke_subagent` (default for 1–2 packages or read-only specialist reviews) and `swarm` pinned to `model: "gemini-4-hydrogen-medium"` (for 3+ parallel packages or iterative author-verifier work). At session start, `harness session` (`SessionHandoff.decide`) automatically injects active stubs, missing planned functions, and recent friction via `injectSteps`.
5. **`harness gc --strict` & `harness verify` (`executing-effect-stubs`):** Run graph entropy garbage collection (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict` via `GraphGc.decide` to catch unused/unprovided `ServiceTag`s, dead `TaggedError`s, and missing pattern docs) followed by verification (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify`). `harness verify` runs `nx affected -t verify`, enforces zero active `stub()` calls, writes `.harness/verify-stamp.json`, records the graph to Omnigraph branch `impl/current`, and triages failures via `TriageV1`. This is the **ONLY** sanctioned verification gate.
6. **`harness done` (`executing-effect-stubs`):** Conclude the task (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done`). This validates the freshness of `.harness/verify-stamp.json`, computes graph diffs between `plan/current` and `impl/current` to verify all planned symbols are implemented, checks plan step coverage (`PlanStepCoverageV1`), and merges `impl/current` into `main`.
7. **`harness learn` (`compounding-effect-learnings`):** Inspect `.harness/friction-log.jsonl` clusters (`Friction.decide` + `LearnProposalV1`) via `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn` and promote recurring friction (`route_miss`, `verify_failure`, `guard_escalation`) into `agent-patterns/*.md`, `DETERMINISTIC_TRIAGE_RULES`, `ALLOWLIST`, or AST/graph gates (`--clear` after promotion).
8. **Review Feedback Resolution (`resolving-effect-review-feedback`):** When addressing code review feedback (pasted from Grok/Codex/human reviewers or fetched from a GitHub PR), adjudicate findings centrally with Graph MCP (`harness_resolve`, `harness_ontology_why`, `harness_structural_search`, `harness_tests_reaching`), synchronize EARS specs/ADRs first, dispatch package-isolated fixer subagents (`invoke_subagent` by default, or `swarm` with `model: "gemini-4-hydrogen-medium"` for multi-package batches) with `harness_route` recipes, promote any gate blind spots via `compounding-effect-learnings` and sync `wc -l` metrics in Phase 5 Step 0, and close with the stamp-safe `gc --strict` $\rightarrow$ `ontology check --strict` $\rightarrow$ `mutate --strict` $\rightarrow$ `verify` $\rightarrow$ `done` sequence.

### 2.1 MCP-First Tooling Preference

Always prefer in-process MCP tools over spawning shell subcommands to eliminate process overhead and guard prompt friction:

- **LSP & Type Diagnostics:** `harness_lsp_diagnostics` (replaces slow shell lint/typecheck runs during development only — final task verification always requires `pnpm harness verify`).
- **Ontology & Architecture:** `harness_ontology_check`, `harness_ontology_why`, `harness_ontology_impact` (trace and audit EARS specs and ADR invariants).
- **Test Impact Analysis:** `harness_tests_reaching` (determines affected test files for touched symbols).
- **Session Telemetry:** `harness_telemetry_report` (reviews session metrics and friction logs).
- **Graph Queries:** `harness_gq_query`, `harness_structural_search`.
- **Task Lifecycle Gates (CLI only):** Use `pnpm harness <cmd>` (`plan-check`, `gc --strict`, `mutate --strict`, `verify`, `done`) strictly for task state transitions and cryptographic verify-stamp generation.
- **Long-Running CLI Gate Execution (`WaitMsBeforeAsync`):** When running CLI lifecycle gates (`pnpm harness plan-check`, `pnpm harness gc --strict`, `pnpm harness mutate --strict`, `pnpm harness verify`, `pnpm harness done`), always pass `WaitMsBeforeAsync: 10000` to `run_command`. If a command goes to the background, rely on Antigravity's reactive wakeup — never poll in a loop with `manage_task status` or `schedule` timers.
- **Advisory `clef-flash` (TypeSafe System One API):** `clef-flash` is a structured System One model (`POST http://localhost:11434/v1/systemone` via `DecisionModel.decide` + `@effect/ai-typesafe`), never a generative/chat LLM. Use `pnpm harness doctor` for warm-up/health checks; `/api/generate`, `/api/chat`, `/v1/chat/completions`, `/v1/completions`, and `ollama run clef-flash` are unsupported and blocked.

---

## 3. MCP Tool Catalog

The plugin provides three complementary MCP servers in `mcp_config.json` (`harness-mcp`, `omnigraph-mcp`, and `nx-mcp`):

### `harness-mcp` (High-Level Effect Shortcuts)

- **`harness_resolve`** (`symbolOrSpan: string`, `repoRoot?: string`): Resolves a symbol or `Effect.fn` span name to its node in the Effect functional graph (`EffectFn`, `ServiceTag`, or `ServiceLayer`) with full signature details.
- **`harness_callers`** (`symbolOrSpan: string`, `repoRoot?: string`): Inspects incoming calls and dependencies across `RequiresService`, `ProvidesService`, `FailsWith`, and runtime `TracedCall` edges.
- **`harness_callees`** (`symbolOrSpan: string`, `repoRoot?: string`): Traverses outgoing calls and service requirements.
- **`harness_tests_reaching`** (`symbolOrSpan: string`, `repoRoot?: string`): Discovers all `@effect/vitest` test cases (`VitestCase`) that exercise the target symbol or span via `ExercisesSpan` and transitive `TracedCall` edges.
- **`harness_structural_search`** (`pattern: string`, `filePath?: string`, `paths?: string[]`, `subDirs?: string[]`, `repoRoot?: string`): Performs fast AST pattern matching using `@ast-grep/napi`.
- **`harness_route`** (`planStep: string`, `repoRoot?: string`): Consults the advisory `clef-flash` idiom router to determine the optimal pattern doc in `agent-patterns/*.md`.
- **`harness_lsp_diagnostics`** (`file?: string`, `filePath?: string`, `project?: string`, `tsconfigPath?: string`, `overlays?: Record<string, string>`, `repoRoot?: string`): Runs `@effect/tsgo` (`@effect/language-service`) strict JSON diagnostics on a target file, in-memory overlay map, or tsconfig project.
- **`harness_ontology_why`** / **`harness_ontology_impact`** / **`harness_ontology_check`**: Queries ArchiMate 3.2 cross-layer traceability (Motivation $\leftrightarrow$ Implementation) and checks cross-layer invariants and semantic conflicts.
- **`harness_gq_query`** (`queryName?: string`, `querySource?: string`, `params?: Record<string, unknown>`, `branch?: string`): Executes canonical Omnigraph `.gq` queries from `libs/harness/graph/queries/harness.gq`.
- **`harness_graph_infer`** / **`harness_graph_complete`** / **`harness_graph_rewrite`**: Runs incremental Datalog (`@electric-sql/d2ts`) inference, computes missing traceability edges, and evaluates double-pushout (DPO) graph rewrite rules.
- **`harness_telemetry_report`** (`format?: "json" | "markdown"`, `cumulative?: boolean`, `repoRoot?: string`): Generates the session observability scorecard and tool-usage health report.

### `@modernrelay/omnigraph-mcp` (Property Graph & Branching)

Exposes parameterized `.gq` graph queries over local Lance storage (`http://127.0.0.1:8080`) under subject `agent-mcp`:

- **Node types:** `EffectFn`, `ServiceTag`, `ServiceLayer`, `TaggedError`, `VitestCase`, `PatternDoc`.
- **Edge types:** `RequiresService`, `FailsWith`, `ProvidesService`, `LayerRequires`, `TracedCall`, `ExercisesSpan`.
- **Access control:** Access is constrained by `libs/harness/graph/policies.cedar` to read-only actions on `main` and `plan/*` branches for `agent-mcp`.

---

## 4. Architectural Boundaries (5-Tier Hexagonal Nx Taxonomy)

The workspace is structured into **5 hexagonal architectural tiers** (`1. Contract` $\rightarrow$ `2. Service Ports` $\rightarrow$ `3. Pure Core / Domain` $\rightarrow$ `4. Infrastructure Adapters` $\rightarrow$ `5. Application Composition Roots`), represented by 6 `type:*` Nx tags (where Tier 3 splits framework/engine `type:core` from application `type:domain`) and enforced deterministically by `@nx/enforce-module-boundaries`, `HarnessTierTopology.decide`, and `SelfDogfooding.decide` (`harness:SPEC-0012` / `harness:ADR-0013`):

| Tag                     | Hexagonal Tier & Purpose                                                                                                                                 | Allowed Imports                                                                                                                                                |
| :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type:contract`         | **Tier 1 (Contract):** Shared Schemas, `HttpApi`, `RpcGroup`, `Schema.TaggedError`, `stub<A, E, R>()`                                                    | Workspace: `type:contract` only (`0` workspace deps); External: `effect` only (forbidden: `service`, `core`, `domain`, `infra`, `app`, 3rd-party I/O)          |
| `type:service`          | **Tier 2 (Service Ports):** Pure `Context.Service` capability interfaces & repository ports (zero `Layer.*` constructors or `node:*` imports)            | Workspace: `type:contract`, `type:service`; External: `effect` only (NEVER `domain`; forbidden: `core`, `domain`, `infra`, `app`, `Layer.*`, Node/SQL drivers) |
| `type:core`             | **Tier 3a (Pure Core Engine):** Generic engines, gates, and pure logic (no I/O, no `node:*` except `{path, path/posix, path/win32, crypto, url}`)        | Workspace: `type:contract`, `type:service`, `type:core` (forbidden: `domain`, `infra`, `app`, HTTP client layers, `process.env`)                               |
| `type:domain`           | **Tier 3b (Pure Business Domain):** Business use cases, domain deciders, pure logic (no I/O)                                                             | Workspace: `type:contract`, `type:service`, `type:core`, `type:domain` (forbidden: `infra`, `app`, `alchemy`, `@effect/sql-*`)                                 |
| `type:infra`            | **Tier 4 (Infrastructure Adapters):** Live `Layer` implementations, `@effect/sql-*` repositories, Alchemy resources (`drizzle-orm`/`drizzle-kit` banned) | Workspace: `type:contract`, `type:service`, `type:core`, `type:domain`, `type:infra` (forbidden: `app`; `drizzle-orm`/`drizzle-kit` banned workspace-wide)     |
| `type:app`              | **Tier 5 (Application Root):** Worker/API/CLI/MCP entrypoint composing Layers (`alchemy.run.ts`)                                                         | All library tiers + `type:app`                                                                                                                                 |
| `type:app`, `scope:web` | **Tier 5 (Web Frontend):** Frontend (Vite + React + `AtomHttpApi`)                                                                                       | `type:contract` and UI libraries only (no raw `fetch`)                                                                                                         |
