# Effect-TS Engineering Harness — Claude Code Adapter

The Claude Code adapter provides deterministic task lifecycle gates, ArchiMate 3.2 ontology tracking, in-process Graph MCP tools, and pattern recipes for Effect v4 and Alchemy v2 within Claude Code sessions.

## Bundle Structure

```text
adapters/claude-code/
├── README.md           # User-facing adapter documentation
├── .mcp.json           # MCP configuration declaring harness-mcp, omnigraph-mcp, and nx-mcp
├── hooks.json          # Lifecycle hooks wiring SessionStart, PreToolUse, PostToolUse, and Stop
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

Claude Code executes hooks defined in `adapters/claude-code/hooks.json` at key session transitions:

1. **`SessionStart` (`harness session`):**
   Executes upon starting or resuming a session. Runs `SessionHandoff.decide` to evaluate uncommitted changes, active git branch, `.harness/verify-stamp.json` freshness, and environment health.
2. **`PreToolUse` (`harness guard`):**
   Evaluates commands and file edits before execution:
   - Matcher `Bash`: Blocks force pushes, unstaged checkouts, and destructive commands. Intercepts `alchemy deploy` and `alchemy destroy` to require interactive confirmation.
   - Matcher `Edit|Write|MultiEdit`: Blocks writes to squashed subtree directories `repos/effect` and `repos/alchemy`. Blocks direct modification of `.harness/verify-stamp.json`.
3. **`PostToolUse` (`harness ingest`):**
   Matcher `Edit|Write`: Triggers incremental AST indexing after file writes, updating `.harness/index.sqlite` and the resident Omnigraph property graph.
4. **`Stop` (`harness done`):**
   Executes before the session concludes. Validates that `.harness/verify-stamp.json` exists, matches the current `HEAD` commit, and matches the working tree hash. Blocks exit if unverified.

---

## MCP Servers (`.mcp.json`)

The adapter configures three Model Context Protocol servers over stdio:

- **`harness-mcp`:** In-process TypeScript server (`apps/harness-mcp/src/server.ts`) exposing 12 tools: symbol resolution (`harness_resolve`, `harness_callers`, `harness_callees`), test reachability (`harness_tests_reaching`), AST pattern searching (`harness_structural_search`), idiom routing (`harness_route`), ArchiMate ontology tracing (`harness_ontology_why`, `harness_ontology_impact`, `harness_ontology_check`), graph queries (`harness_gq_query`), type diagnostics (`harness_lsp_diagnostics`), and telemetry reporting (`harness_telemetry_report`).
- **`omnigraph-mcp` (`@modernrelay/omnigraph-mcp@0.14.0`):** Graph database server managing the ArchiMate 3.2 property graph on port 8080, governed by `libs/harness/graph/policies.cedar`.
- **`nx-mcp`:** Workspace graph server for Nx target and project discovery.

---

## 6 Workflow Skills

Use the workflow skills to drive task progress through each lifecycle stage:

### 1. `effect-harness`
- **When to Use:** Master lifecycle orchestrator. Use at the start of any new engineering task or when coordinating work across contracts, domain logic, and infrastructure.
- **Trigger / Starter Prompt:**
  ```text
  "Implement a D1 session repository in libs/sample/infra following the effect-harness lifecycle."
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

## Setup & Verification

1. **Link or Copy Adapter Configuration:**
   Copy `.mcp.json` and `hooks.json` to project root or invoke Claude Code with adapter directory configurations.
2. **Verify Environment:**
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts doctor
   ```
3. **Execute Verification Gate:**
   ```bash
   CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
   ```
