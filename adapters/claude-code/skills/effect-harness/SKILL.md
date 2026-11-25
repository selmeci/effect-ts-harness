---
name: effect-harness
description: Use when starting or coordinating work in an Effect-TS Engineering Harness workspace, selecting between lifecycle skills or MCP graph tools, or resolving Effect v4 and Alchemy v2 architectural boundaries.
---

# Effect-TS Engineering Harness

This skill equips agents with the instructions, architectural boundaries, tool catalog, and lifecycle workflows required to develop inside the Effect-TS Engineering Harness.

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
plan -> skeleton with stub<A, E, R>(...args) -> harness plan-check -> implement -> LLM phase (harness learn -> EARS accepted -> oxfmt -> harness learn --clear -> harness workflow complete --phase llm) -> harness workflow ship [--run <id>] (ShipWorkflow: format-check -> gc-strict -> ontology-check-strict -> mutate-strict -> verify -> done --cli)
```

1. **Plan (`specifying-ears-with-effect`):** Write a plan in Effect idioms (using the `agent-patterns/planning.md` template), mapping requirements (including business/EARS specifications) to Schemas, TaggedErrors, `Context.Service` tags, `Layer` graphs, and `Effect<A, E, R>` signatures:
   - `WHEN <trigger>, THE SYSTEM SHALL <response>` $\rightarrow$ `HttpApiEndpoint` / `Rpc` input Schema + `Effect.fn` success channel `A`
   - `IF <condition>, THEN THE SYSTEM SHALL <fail>` $\rightarrow$ `Schema.TaggedError<Self>()("Tag", { ... })` in `type:contract` + error channel `E`
   - `WHILE <state>, THE SYSTEM SHALL <response>` $\rightarrow$ closed `Schema.TaggedUnion` state/decision types + pure decider `Effect.fn("*.decide")` (`R = never`) using exhaustive `match(state)...exhaustive()` from `ts-pattern` + stateful `Context.Service` in `R`
   - `WHERE <feature>, THE SYSTEM SHALL <response>` $\rightarrow$ `Context.Service` + `Layer` / `Config` in `R`
2. **Skeleton (`planning-effect-skeletons`):** Implement the skeleton first (schemas, errors, service interfaces, function signatures). For function bodies, use `stub<A, E, R>(...args)` from `@harness/contract` to preserve accurate types. The skeleton must pass typecheck before implementation begins.
3. **`harness plan-check` (`planning-effect-skeletons`):** Run plan-check (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check`). This verifies typecheck and linting under `HARNESS_PLAN_CHECK=1`, verifies unique span names, indexes workspace functions, writes `.harness/plan-graph-snapshot.json`, and records the plan graph to Omnigraph branch `plan/current`.
4. **Implement (`executing-effect-stubs`):** Replace `stub<A, E, R>(...args)` placeholders with production Effect implementations and comprehensive tests (`it.effect` + `checkSpanBudgets` via `SpanBudget.decide` for N+1 / latency bounds), delegating package-isolated units to `haiku` subagents (`HARNESS_WORKTREE_ID`). At session start, `harness session` (`SessionHandoff.decide`) automatically outputs active stubs, missing planned functions, and recent friction.
5. **LLM Phase (`compounding-effect-learnings`):** Inspect `.harness/friction-log.jsonl` clusters (`Friction.decide` + `LearnProposalV1`) via `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn` and promote recurring friction (`route_miss`, `verify_failure`, `guard_escalation`) into `agent-patterns/*.md`, `DETERMINISTIC_TRIAGE_RULES`, `ALLOWLIST`, or AST/graph gates. Then set EARS specs `status: accepted`, run `pnpm format` (or scoped `pnpm oxfmt --write <touched paths>`), clear processed logs (`pnpm harness learn --clear`), and run `pnpm harness workflow complete --phase llm` when inside `HarnessTaskWorkflow`.
6. **Durable `ShipWorkflow` Pipeline (`pnpm harness workflow ship [--run <id>]` — `executing-effect-stubs`):** With no further file edits, run `pnpm harness workflow ship --run <id>` (or `pnpm harness workflow ship` in ephemeral mode for standalone non-plan tasks). Under `ShipWorkflow`, this executes `format-check` -> `gc-strict` (`GraphGc.decide`) -> `ontology-check-strict` (`ontology check --strict`) -> `mutate-strict` -> `verify` (`nx affected -t verify`, zero active `stub()` calls, `SpanBudget.decide`, `MigrationSafety.decide`, writes `.harness/verify-stamp.json`, records `impl/<task>`, triages via `TriageV1`) -> `done --cli` under monotonic `WfShipAttempt` OCC. This is the **ONLY** sanctioned verification and shipping gate sequence.
7. **`harness done --cli` (`executing-effect-stubs`):** Executed as the terminal stage of `ShipWorkflow` (or standalone via `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done [--cli]`). Validates `.harness/verify-stamp.json` freshness, checks plan-to-impl graph diffs and `PlanStepCoverageV1`, and merges `impl/<task>` into `main`.
8. **Read-Only Code Review (`effect-code-review`):** Optional on-demand read-only code review for diffs, branches, commit ranges, or PRs: routes via `harness_review_route`, dispatches signal-routed specialist reviewers, suppresses deterministic gate noise, and emits Quote-the-Line findings with handoff to `resolving-effect-review-feedback`.
9. **Review Feedback Resolution (`resolving-effect-review-feedback`):** When addressing code review feedback (pasted from Grok/Codex/human reviewers or fetched from a GitHub PR), adjudicate findings centrally with Graph MCP (`harness_resolve`, `harness_ontology_why`, `harness_structural_search`, `harness_tests_reaching`), synchronize EARS specs/ADRs first, dispatch package-isolated `haiku` fixer subagents with `harness_route` recipes, promote any gate blind spots via `compounding-effect-learnings`, sync `wc -l` metrics in Phase 5 Step 0, format + `pnpm harness learn --clear` + `pnpm harness workflow complete --phase llm`, and close with `pnpm harness workflow ship [--run <id>]` (`ShipWorkflow`: `format-check` $\rightarrow$ `gc --strict` $\rightarrow$ `ontology check --strict` $\rightarrow$ `mutate --strict` $\rightarrow$ `verify` $\rightarrow$ `done --cli`).

### 2.1 MCP-First Tooling Preference

Always prefer in-process MCP tools over spawning shell subcommands to eliminate process overhead and guard prompt friction:

- **LSP & Type Diagnostics:** `harness_lsp_diagnostics` (replaces slow shell lint/typecheck runs during development only — final task verification always requires `pnpm harness verify`).
- **Ontology & Architecture:** `harness_ontology_check` (`scope?`, `repoRoot?`), `harness_ontology_why` (`symbolOrSpan`, `repoRoot?`), `harness_ontology_impact` (`symbolOrSpan`, `repoRoot?`) — trace `ADR <-informed_by- EarsSpec -> EarsRequirement -> EffectFn` and audit invariants + `SemanticConflictPairer.decide` semantic conflicts.
- **Three-Tier Knowledge & Doc Retrieval:** `harness_search_knowledge` (Tier 2 hybrid `qwen3-embedding:8b` RRF search across `PatternDoc`, `AdrDoc`, and `EarsRequirement` with `linkedSymbols` hydration and explicit `bm25-only`/`lexical-fallback` degradation), `harness_route` (upgraded hybrid Omnigraph pattern retrieval + `"planning"` block + `clef-flash`), and `harness_doc_tree` (Tier 3 PageIndex-lite governance catalog + bounded markdown heading/section reads).
- **Test Impact Analysis:** `harness_tests_reaching` (`symbolOrSpan`, `repoRoot?`) — determines affected test files for touched symbols.
- **Session Telemetry:** `harness_telemetry_report` (reviews session metrics and friction logs).
- **Graph Queries & Diffs:** `harness_gq_query`, `harness_structural_search`, `harness_git_diff`.
- **Task Lifecycle Gates & Workflow Control Plane (CLI only):** Use `pnpm harness <cmd>` (`plan-check`, `gc --strict`, `mutate --strict`, `verify`, `done`, `workflow <compile|start|status|complete|resume|ship|doctor|abort>`) strictly for task state transitions, durable `HarnessTaskWorkflow` / `ShipWorkflow` orchestration, and cryptographic verify-stamp generation. When `HARNESS_UNIT_WORKER=1` is set on unit worker invocations (automatic runner spawning lands in WF-5), isolation guards block recursive `harness workflow start|resume|ship|abort|doctor|complete --phase llm`, `harness done`, and direct access to `daemon.sock`/`auth-tokens.json`.
- **Advisory `clef-flash` (TypeSafe System One API):** `clef-flash` is a structured System One model (`POST http://localhost:11434/v1/systemone` via `DecisionModel.decide` + `@effect/ai-typesafe`), never a generative/chat LLM. Use `pnpm harness doctor` for warm-up/health checks; `/api/generate`, `/api/chat`, `/v1/chat/completions`, `/v1/completions`, and `ollama run clef-flash` are unsupported and blocked.

---

## 3. MCP Tool Catalog (20 `harness-mcp` Tools Across 3 Retrieval Tiers)

The harness provides three complementary MCP servers in `.mcp.json` (`harness-mcp`, `omnigraph-mcp`, and `nx-mcp`):

### `harness-mcp` — Tier 1 (Deterministic Code & Governance Graph)

- **`harness_resolve`** (`symbolOrSpan: string`, `repoRoot?: string`): Resolves any graph entity or relation node across all 15 node kinds (`EffectFn`, `ServiceTag`, `ServiceLayer`, `TaggedError`, `SchemaDef`, `VitestCase`, `PatternDoc`, `AdrDoc`, `EarsSpec`, `EarsRequirement`, `EffectSignature`, `LayerFlow`, `TraceabilityTuple`, `HttpEndpointTuple`, `MigrationTuple`). On miss, automatically runs `resolve_effect_fn_fuzzy` and returns ranked `suggestions` for misspelled names.
- **`harness_callers`** (`symbolOrSpan: string`, `repoRoot?: string`): Inspects incoming calls and dependencies across `RequiresService`, `ProvidesService`, `FailsWith`, and runtime `TracedCall` edges.
- **`harness_callees`** (`symbolOrSpan: string`, `repoRoot?: string`): Traverses outgoing calls and service requirements.
- **`harness_tests_reaching`** (`symbolOrSpan: string`, `repoRoot?: string`): Discovers all `@effect/vitest` test cases (`VitestCase`) that exercise the target symbol or span via `ExercisesSpan` and transitive `TracedCall` edges.
- **`harness_ontology_why`** (`symbolOrSpan: string`, `repoRoot?: string`): Traces upward ArchiMate traceability (`EffectFn` $\rightarrow$ `EarsRequirement` / `EarsSpec` $\rightarrow$ `informed_by` `AdrDoc`).
- **`harness_ontology_impact`** (`symbolOrSpan: string`, `repoRoot?: string`): Computes downstream ArchiMate blast radius from any ADR, EARS spec, or code symbol across `informed_by` and traceability edges.
- **`harness_ontology_check`** (`scope?: string`, `repoRoot?: string`): Verifies deterministic cross-layer ArchiMate invariants (`OntologyInvariants.decide`) and semantic conflicts (`SemanticConflictPairer.decide` + `OntologyConflictV1`).
- **`harness_gq_query`** (`queryName: HarnessGqQueryName`, `params?: Record<string, unknown>`, `branch?: string`, `repoRoot?: string`): Executes canonical Omnigraph `.gq` queries from `libs/harness/graph/queries/harness.gq` (including `resolve_effect_fn_fuzzy`, `search_adrs_*`, `search_requirements_*`, `rank_patterns_*`).
- **`harness_structural_search`** (`pattern: string`, `filePath?: string`, `paths?: string[]`, `subDirs?: string[]`, `repoRoot?: string`): Performs fast AST pattern matching using `@ast-grep/napi`.
- **`harness_lsp_diagnostics`** (`file?: string`, `filePath?: string`, `project?: string`, `tsconfigPath?: string`, `overlays?: Record<string, string>`, `repoRoot?: string`): Runs `@effect/tsgo` (`@effect/language-service`) strict JSON diagnostics on a target file, in-memory overlay map, or tsconfig project.
- **`harness_graph_infer`** (`symbolOrSpan?: string`, `repoRoot?: string`) / **`harness_graph_complete`** (`minConfidenceMillis?: number`, `priors?: ...`, `repoRoot?: string`) / **`harness_graph_rewrite`** (`target?: string`, `repoRoot?: string`): Runs incremental Datalog inference, computes missing traceability edges, and evaluates double-pushout (DPO) graph rewrite rules.
- **`harness_review_route`** (`changedFiles: string[]`, `diffSummary?: string`, `changedLineCount?: number`, `repoRoot?: string`): Computes a monotonic hybrid `ReviewRoutingPlan` (`skip` | `lite` | `focused` | `full`) across all 7 specialist reviewers plus a precomputed `ReviewGraphContextBundle`.
- **`harness_telemetry_report`** (`format?: "json" | "markdown"`, `cumulative?: boolean`, `repoRoot?: string`): Generates the session observability scorecard and tool-usage health report.
- **`harness_git_diff`** (`repoRoot?: string`, `baseRef?: string`, `paths?: string[]`, `statOnly?: boolean`, `maxPatchChars?: number`): Returns bounded read-only unified diff, stats, and untracked-file previews via `git --no-optional-locks` without acquiring repository lock files.
- **`harness_workflow_plan`** (`repoRoot?: string`, `runId?: string`): Read-only status inspection of the active or latest `HarnessTaskWorkflow` run, work units, attempts, pending `DurableDeferred`s, and worktree/`commonGitDir` binding.

### `harness-mcp` — Tier 2 (Selective Hybrid RRF Knowledge Retrieval)

- **`harness_search_knowledge`** (`query: string`, `kinds?: ("PatternDoc" | "AdrDoc" | "EarsRequirement")[]`, `status?: "accepted" | "proposed" | "superseded" | "deprecated"`, `limit?: number`, `repoRoot?: string`): Searches documentation and requirement knowledge via local `qwen3-embedding:8b` RRF (`hybrid-rrf`) with explicit `bm25-only` / `lexical-fallback` degradation (`degradedReason` always surfaced, never mock vectors) and hydrates `linkedSymbols` directly from the code graph.
- **`harness_route`** (`planStep: string`, `repoRoot?: string`): Combines hybrid Omnigraph `PatternDoc` retrieval (`candidatePatterns`), `"planning"` block detection, and the advisory `clef-flash` idiom router (`source`: `"deterministic"` | `"model"` | `"hybrid-retrieval"` | `"degraded-fallback"`) to match `agent-patterns/*.md`.

### `harness-mcp` — Tier 3 (Deterministic PageIndex-lite Doc Navigation)

- **`harness_doc_tree`** (`mode?: "catalog" | "tree" | "section"`, `path?: string`, `sectionId?: string`, `scope?: string`, `repoRoot?: string`): Navigates ADRs (`libs/*/docs/adr/`), EARS specs (`libs/*/docs/specs/`), and patterns without loading whole files:
  - `mode: "catalog"`: Lists all `AdrDoc` and `EarsSpec` metadata, statuses, summaries, `informed_by` links, and paths.
  - `mode: "tree"`: Extracts the Markdown heading outline (`sectionId`, `level`, `title`, 1-based `startLine`/`endLine`, `preview`) while ignoring code fences.
  - `mode: "section"`: Reads a single bounded section slice (capped cleanly at 250 lines) with strict repo-root containment (`DocTreePathError`).

### `@modernrelay/omnigraph-mcp` (Property Graph & Branching)

Exposes parameterized `.gq` graph queries over local Lance storage (`http://127.0.0.1:8080`) under subject `agent-mcp`:

- **Node types:** `EffectFn`, `ServiceTag`, `ServiceLayer`, `TaggedError`, `VitestCase`, `PatternDoc`, `AdrDoc`, `EarsSpec`, `EarsRequirement`.
- **Edge types:** `RequiresService`, `FailsWith`, `ProvidesService`, `LayerRequires`, `TracedCall`, `ExercisesSpan`.
- **Queries:** Run graph traversals to inspect dependencies, layer wirings, and test coverage.
- **Access control:** Access is constrained by `libs/harness/graph/policies.cedar` to read-only actions on `main` and `plan/*` branches for `agent-mcp`. Branch creations, merges, deletions, and entity mutations are restricted to `harness-cli`.

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

---

## 5. Effect Coding Guidelines

- **Inline Generators:** Prefer `Effect.gen(function* () { ... })` inline.
- **Tracing:** Use `Effect.fn("Scope.Module.name")` for exported or reusable traced functions; use `Effect.fnUntraced` for private helpers. Avoid wrappers that only return `Effect.gen` (`no-double-wrapped-effect-fn`).
- **Error Handling:** Use `return yield* new TaggedError(...)` rather than yielding and assigning errors.
- **Exhaustive Pattern Matching (`ts-pattern`):** Model all multi-state values, domain outcomes, and commands as closed Discriminated Unions (`Schema.TaggedUnion`, `Schema.TaggedStruct`, `Schema.TaggedClass`). Branch on discriminated unions exclusively with `match(val)...exhaustive()` from `ts-pattern` (even for 2-variant unions). `switch` statements, `else if` chains, `match().run()`, and `if` / ternary checks on union discriminants (`_tag`, `Option.isSome`, `Either.isRight`, `Result.isSuccess`) are banned (`agent-patterns/pattern-matching.md`).
- **Data Layer:** `drizzle-orm` and `drizzle-kit` are **banned across the workspace**. Native Effect v4 SQL (`@effect/sql-d1`, `@effect/sql-sqlite-do`, `SqlClient`, `SqliteMigrator`) lives exclusively in `type:infra`. Decode database rows into `type:contract` Schemas at repository boundaries.
- **Infrastructure:** Alchemy v2 (`2.0.0-beta.80`) resources live in `type:infra` and `apps/sample/alchemy.run.ts`. Never run `alchemy deploy` or `alchemy destroy` directly — they require explicit human approval via the safety guard.
- **Durable Workflow Determinism:** Modules containing `Workflow.make(...)` must satisfy the `nondeterministic-workflow-body` AST and `oxlint` gate (`harness/syntax-bans`): move all side effects, wall-clock reads, randomness, env, fs, git, Omnigraph, and network calls inside `toLayer`/`register` handlers and same-module helper functions into `Activity.make({ execute: ... })` callbacks.
