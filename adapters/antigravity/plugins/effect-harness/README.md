# Effect-TS Engineering Harness — Antigravity Plugin

The `effect-harness` Antigravity plugin equips Antigravity agents with deterministic task lifecycle gates, ArchiMate 3.2 ontology tracking, in-process Graph MCP tools, and pattern recipes for Effect v4 and Alchemy v2.

## Bundle Structure

```text
adapters/antigravity/plugins/effect-harness/
├── plugin.json         # Manifest identifying "name": "effect-harness"
├── README.md           # User-facing plugin documentation
├── hooks.json          # Lifecycle hooks wiring PreInvocation, PreToolUse, PostToolUse, and Stop
├── mcp_config.json     # MCP server configuration for harness-mcp, omnigraph-mcp, and nx-mcp
├── rules/
│   └── AGENTS.md       # Governing harness rules, order of authority, and coding standards
├── skills/
│   ├── effect-harness/                   # Master orchestrator for the 7-step lifecycle
│   ├── specifying-ears-with-effect/      # EARS requirement and ADR authoring
│   ├── planning-effect-skeletons/        # Plan-as-Code stub<A, E, R>() skeleton generation
│   ├── executing-effect-stubs/           # Implementation, test authoring, and gate execution
│   ├── resolving-effect-review-feedback/ # Adjudication and fix loop for external PR reviews
│   └── compounding-effect-learnings/     # Friction analysis and deterministic gate promotion
└── agents/
    ├── effect-ears-test-reviewer.md      # EARS clause-to-test traceability specialist
    ├── effect-security-reviewer.md       # Trust boundaries, input validation, and secrets
    ├── effect-reliability-reviewer.md    # DO SQLite sync discipline and resource scopes
    └── effect-adversarial-reviewer.md    # Falsification, crash sequences, and race conditions
```

---

## Lifecycle Hooks (`hooks.json`)

The plugin registers four lifecycle hooks to enforce safety constraints and index synchronization:

1. **`PreInvocation` (`harness session --format=antigravity`):**
   Executes before each agent invocation. Runs `SessionHandoff.decide` to evaluate dirty working tree files, inspect git branch state, check `.harness/verify-stamp.json` freshness, and surface environment readiness.
2. **`PreToolUse` (`harness guard --format=antigravity`):**
   Intercepts tool calls (`run_command`, `replace_file_content`, `multi_replace_file_content`, `write_to_file`).
   - Blocks edits to read-only `repos/effect` and `repos/alchemy`.
   - Blocks direct writes to `.harness/verify-stamp.json` (stamp forgery prevention).
   - Blocks destructive shell commands (`git push --force`, `rm -rf`).
   - Requires explicit human approval for `alchemy deploy` and `alchemy destroy`.
3. **`PostToolUse` (`harness ingest --format=antigravity`):**
   Executes immediately following file write or replacement operations. Incrementally parses modified TypeScript ASTs, EARS specifications, and ADR documents into `.harness/index.sqlite` and the resident Omnigraph property graph.
4. **`Stop` (`harness done --format=antigravity`):**
   Executes when the agent attempts to stop or complete a task. Verifies that `.harness/verify-stamp.json` matches current `HEAD` commit and tree hash. Blocks exit if verification has not passed.

---

## MCP Servers (`mcp_config.json`)

The plugin registers three Model Context Protocol servers over stdio:

- **`harness-mcp`:** In-process TypeScript server (`apps/harness-mcp/src/server.ts`) exposing 12 tools: symbol resolution (`harness_resolve`, `harness_callers`, `harness_callees`), test reachability (`harness_tests_reaching`), AST pattern searching (`harness_structural_search`), idiom routing (`harness_route`), ArchiMate ontology tracing (`harness_ontology_why`, `harness_ontology_impact`, `harness_ontology_check`), graph queries (`harness_gq_query`), type diagnostics (`harness_lsp_diagnostics`), and telemetry reporting (`harness_telemetry_report`).
- **`omnigraph-mcp` (`@modernrelay/omnigraph-mcp@0.14.0`):** Graph database server managing the ArchiMate 3.2 property graph on port 8080. Governed by Cedar policy in `libs/harness/graph/policies.cedar`.
- **`nx-mcp`:** Nx workspace graph server providing dependency and task target discovery.

---

## 6 Workflow Skills

Use the workflow skills to guide agents through specific development phases:

### 1. `effect-harness`
- **When to Use:** Master lifecycle orchestrator. Use at the start of any new engineering task or to coordinate multi-phase features across contracts, domain logic, and infrastructure.
- **Trigger / Starter Prompt:**
  ```text
  "Implement a D1-backed session repository in libs/sample/infra following the effect-harness lifecycle."
  ```

### 2. `specifying-ears-with-effect`
- **When to Use:** Step 1 of the task lifecycle. Use before writing code or skeletons when requirements are informal, unwritten, or missing EARS clauses (`WHEN`, `IF/THEN`, `WHILE`, `WHERE`).
- **Trigger / Starter Prompt:**
  ```text
  "Author the EARS specification and ADR for rate-limiting Durable Object storage using specifying-ears-with-effect."
  ```

### 3. `planning-effect-skeletons`
- **When to Use:** Steps 2–3 of the task lifecycle. Use after specification approval to translate EARS clauses into compilable `stub<A, E, R>()` signatures and pass `harness plan-check`.
- **Trigger / Starter Prompt:**
  ```text
  "Create plan-as-code skeletons for the session store service and domain functions using planning-effect-skeletons."
  ```

### 4. `executing-effect-stubs`
- **When to Use:** Steps 4–6 of the task lifecycle. Use once `harness plan-check` passes on `plan/<task>` to replace stubs with `Effect.fn` implementations, Layers, and Vitest test suites.
- **Trigger / Starter Prompt:**
  ```text
  "Execute stubs in libs/sample/domain and libs/sample/infra using executing-effect-stubs and verify all gates."
  ```

### 5. `resolving-effect-review-feedback`
- **When to Use:** Step 8 (Post-PR / External Review Resolution). Use when addressing code review comments from Grok, Codex, Claude, human reviewers, or GitHub PR threads (`gh pr view`).
- **Trigger / Starter Prompt:**
  ```text
  "Resolve this external code review feedback using resolving-effect-review-feedback: [paste review markdown]"
  ```
  or:
  ```text
  "Resolve the code review comments on pull request #42 using resolving-effect-review-feedback."
  ```

### 6. `compounding-effect-learnings`
- **When to Use:** Step 7 of the task lifecycle and post-review retrospectives. Use when completing tasks that encountered gate failures, route misses, or new idioms to promote friction into deterministic gates.
- **Trigger / Starter Prompt:**
  ```text
  "Analyze session friction logs and promote recurring issues into oxlint rules using compounding-effect-learnings."
  ```

---

## 4 Specialist Review Subagents

Invoke specialist review subagents as read-only inspectors during implementation, before verification, or during review adjudication:

| Subagent | Role & Activation | Audit Focus | Primary References |
| :--- | :--- | :--- | :--- |
| `effect-ears-test-reviewer` | Read-only test fidelity auditor. Invoke during test implementation or PR review. | Verifies 1:1 coverage between EARS clauses (`WHEN`, `IF/THEN`, `WHILE`, `WHERE`) and `@effect/vitest` assertions; flags vacuous `.thenFails()` without expected error instances; checks mock boundary fidelity. | `docs/specs/*.md`<br>`agent-patterns/testing.md` |
| `effect-security-reviewer` | Read-only security auditor. Invoke when modifying contracts, authorization, or queries. | Audits boundary decoding (`Schema.decodeUnknownEffect`); checks IDOR authorization checks in `type:domain`; detects raw SQL string interpolation; verifies `Redacted` usage for sensitive configuration. | `agent-patterns/schema.md`<br>`agent-patterns/d1-repository.md`<br>`agent-patterns/httpapi.md` |
| `effect-reliability-reviewer` | Read-only reliability auditor. Invoke when modifying concurrency, Durable Objects, or scopes. | Audits DO SQLite synchronous transaction discipline (`MixedScheduler("sync")`, pre-transaction decoding, commit-order mutation); checks `Scope` finalizers; detects unbounded `Schedule` retries and fiber leaks. | `agent-patterns/durable-object-state.md`<br>`agent-patterns/concurrency.md`<br>`agent-patterns/schedule.md` |
| `effect-adversarial-reviewer` | Read-only chaos auditor. Invoke for complex state transitions, deciders, or distributed workflows. | Constructs partial-failure crash-between-steps sequences; constructs concurrent race conditions; analyzes out-of-order event replay; tests boundary value mutations against pure deciders. | `agent-patterns/event-sourcing.md`<br>`agent-patterns/pattern-matching.md`<br>`agent-patterns/errors.md` |

---

## Installation & Configuration

1. **Verify Plugin Manifest:**
   Ensure `adapters/antigravity/plugins` is declared in `.agents/plugins.json`:
   ```json
   {
     "entries": [
       { "path": "adapters/antigravity/plugins" }
     ]
   }
   ```
2. **Start Omnigraph Property Graph Daemon:**
   ```bash
   pnpm harness doctor
   ```
3. **Verify Environment:**
   Run the CLI doctor to confirm Node.js version, `@effect/tsgo`, and index status:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts doctor
   ```
