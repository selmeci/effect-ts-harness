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
2. **Skeleton (`planning-effect-skeletons`):** Implement the skeleton first (schemas, errors, service interfaces, function signatures). For function bodies, use `stub<A, E, R>(...args)` from `@harness/gates` to preserve accurate types. The skeleton must pass typecheck before implementation begins.
3. **`harness plan-check` (`planning-effect-skeletons`):** Run plan-check (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check`). This verifies typecheck and linting under `HARNESS_PLAN_CHECK=1`, verifies unique span names, runs `checkEffectGraph`, writes `.harness/plan-graph-snapshot.json`, and records the plan graph to Omnigraph branch `plan/current`.
4. **Implement (`executing-effect-stubs`):** Replace `stub<A, E, R>(...args)` placeholders with production Effect implementations and comprehensive tests (`it.effect` + `checkSpanBudgets` via `SpanBudget.decide` for N+1 / latency bounds), delegating package-isolated units to `flash` subagents (`Workspace: "share"` or `HARNESS_WORKTREE_ID`). At session start, `harness session` (`SessionHandoff.decide`) automatically injects active stubs, missing planned functions, and recent friction via `injectSteps`.
5. **`harness gc --strict` & `harness verify` (`executing-effect-stubs`):** Run graph entropy garbage collection (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict` via `GraphGc.decide` to catch unused/unprovided `ServiceTag`s, dead `TaggedError`s, and missing pattern docs) followed by verification (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify`). `harness verify` runs `nx affected -t verify`, enforces zero active `stub()` calls, writes `.harness/verify-stamp.json`, records the graph to Omnigraph branch `impl/current`, and triages failures via `TriageV1`. This is the **ONLY** sanctioned verification gate.
6. **`harness done` (`executing-effect-stubs`):** Conclude the task (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done`). This validates the freshness of `.harness/verify-stamp.json`, computes graph diffs between `plan/current` and `impl/current` to verify all planned symbols are implemented, checks plan step coverage (`PlanStepCoverageV1`), and merges `impl/current` into `main`.
7. **`harness learn` (`compounding-effect-learnings`):** Inspect `.harness/friction-log.jsonl` clusters (`Friction.decide` + `LearnProposalV1`) via `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn` and promote recurring friction (`route_miss`, `verify_failure`, `guard_escalation`) into `agent-patterns/*.md`, `DETERMINISTIC_TRIAGE_RULES`, `ALLOWLIST`, or AST/graph gates (`--clear` after promotion).
8. **Review Feedback Resolution (`resolving-effect-review-feedback`):** When addressing code review feedback (pasted from Grok/Codex/human reviewers or fetched from a GitHub PR), adjudicate findings centrally with Graph MCP (`harness_resolve`, `harness_ontology_why`, `harness_structural_search`, `harness_tests_reaching`), synchronize EARS specs/ADRs first, dispatch package-isolated `flash` fixer subagents with `harness_route` recipes, re-verify via `gc --strict`, `mutate --strict`, and `verify`, and promote any gate blind spots via `compounding-effect-learnings`.

---

## 3. MCP Tool Catalog

The plugin provides three complementary MCP servers in `mcp_config.json`:

### `harness-mcp` (High-Level Effect Shortcuts)

- **`harness_resolve`** (`symbolOrSpan: string`): Resolves a symbol or `Effect.fn` span name to its node in the Effect functional graph (`EffectFn`, `ServiceTag`, or `ServiceLayer`) with full signature details.
- **`harness_callers`** (`symbolOrSpan: string`): Inspects incoming calls and dependencies across `RequiresService`, `ProvidesService`, `FailsWith`, and runtime `TracedCall` edges.
- **`harness_callees`** (`symbolOrSpan: string`): Traverses outgoing calls and service requirements.
- **`harness_tests_reaching`** (`symbolOrSpan: string`): Discovers all `@effect/vitest` test cases (`VitestCase`) that exercise the target symbol or span via `ExercisesSpan` and transitive `TracedCall` edges.
- **`harness_structural_search`** (`pattern: string`): Performs fast AST pattern matching using `@ast-grep/napi`.
- **`harness_route`** (`planStep: string`): Consults the advisory `clef-flash` idiom router to determine the optimal pattern doc in `agent-patterns/*.md`.
- **`harness_lsp_diagnostics`** (`file?: string`, `project?: string`): Runs `@effect/tsgo` (`@effect/language-service`) strict JSON diagnostics on a target file or tsconfig project.
- **`harness_ontology_why`** / **`harness_ontology_impact`** / **`harness_ontology_check`**: Queries ArchiMate 3.2 cross-layer traceability (Motivation $\leftrightarrow$ Implementation) and checks cross-layer invariants and semantic conflicts.
- **`harness_gq_query`** (`queryName`, `params?`, `branch?`): Executes canonical Omnigraph `.gq` queries from `libs/harness/graph/queries/harness.gq`.
- **`harness_telemetry_report`** (`format?: "json" | "markdown"`): Generates the session observability scorecard and tool-usage health report.

### `@modernrelay/omnigraph-mcp` (Property Graph & Branching)

Exposes parameterized `.gq` graph queries over local Lance storage (`http://127.0.0.1:8080`) under subject `agent-mcp`:
- **Node types:** `EffectFn`, `ServiceTag`, `ServiceLayer`, `TaggedError`, `VitestCase`, `PatternDoc`.
- **Edge types:** `RequiresService`, `FailsWith`, `ProvidesService`, `LayerRequires`, `TracedCall`, `ExercisesSpan`.
- **Access control:** Access is constrained by `libs/harness/graph/policies.cedar` to read-only actions on `main` and `plan/*` branches for `agent-mcp`.

---

## 4. Architectural Boundaries (Nx Taxonomy)

Enforce strict directional boundaries across project tags:

| Tag | Purpose | Allowed Imports |
| :--- | :--- | :--- |
| `type:contract` | Shared Schemas, `HttpApi`, `RpcGroup`, API errors | `effect` only |
| `type:domain` | Business use cases, domain errors, pure logic | `contract`, `service`, (`@harness/gates` for `stub` during planning); **never** `type:infra` or `alchemy` |
| `type:service` | Service interfaces (`Context.Service`), repository abstractions | `contract`, `domain` |
| `type:infra` | Live `Layer` implementations, Drizzle repositories, Alchemy resources | `contract`, `domain`, `service`, `infra` |
| `type:app` | Worker/API entrypoint composing Layers (`alchemy.run.ts`) | All workspace libraries |
| `type:app`, `scope:web` | Frontend (Vite + React + `AtomHttpApi`) | `contract` and UI libraries only (no raw `fetch`) |
