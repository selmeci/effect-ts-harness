# Evaluation Rubric for Effect Review Feedback

This rubric governs central adjudication of code review findings in the Effect-TS Engineering Harness. Every atomic sub-item (`F-n.k` or `S-n.k`)—whether from an external LLM (Grok, Codex), human reviewer, or automated PR comment—must be evaluated against these observable predicates before any code is modified.

---

## 1. Order of Authority Check

Every reviewer suggestion must be validated against the project's strict hierarchy of authority:

1. `repos/effect/LLMS.md`
2. Source code and tests in `repos/effect` and `repos/alchemy`
3. `agent-patterns/*.md` and `docs/alchemy-llms*.txt` (offline vendored reference)
4. `effect/Graph` + Omnigraph (`harness-mcp` / `@modernrelay/omnigraph-mcp`) and Nx graph for services and Layers

> [!CAUTION]
> Generic LLMs frequently suggest idiomatic TypeScript patterns that are **strictly banned** in Effect-TS. Classify a suggestion as `decline-with-evidence` ONLY when it violates a verbatim ban below, explicitly contradicts an accepted `<scope>:ADR-NNNN` / EARS `REQ-*` clause, OR contains a factual premise error proven by TypeScript/Graph MCP.

| Reviewer Suggestion | Why It Is Banned | Authority / Sanctioned Replacement |
| :--- | :--- | :--- |
| `try { ... } catch (e) { ... }` or `async/await` | Destroys Effect error channels, structured concurrency, and interruption semantics | `repos/effect/LLMS.md`; use `Effect.tryPromise`, `Effect.try`, or `Effect.gen` |
| `switch (val._tag)` or `if (val._tag === ...)` | Unchecked matching misses newly added union variants at compile-time | `agent-patterns/pattern-matching.md`; use `match(val)...exhaustive()` from `ts-pattern` |
| `if (Option.isSome(opt))` or ternary `? :` on tag guards | Bypasses exhaustive pattern matching discipline | `agent-patterns/pattern-matching.md`; use `match(opt)...exhaustive()` |
| `Effect.runSync` / `Effect.runPromise` inside `Effect.gen` | Severs tracing span context and breaks structured fiber hierarchy | `repos/effect/LLMS.md`; `yield*` the effect inside `Effect.gen` |
| Importing `drizzle-orm`, `@effect/sql-*`, or `sqliteTable` in `type:domain` | Violates clean hexagonal architecture; domain must remain pure | Nx taxonomy & `AGENTS.md`; Drizzle belongs exclusively in `type:infra` |
| Raw `fetch(...)` in domain or frontend | Leaks untraced network calls and bypasses schema decoders | `AtomHttpApi` in frontend, `HttpClient` in `type:infra` |
| Direct secret access via `Redacted.value(secret)` in application code | Leaks credentials into telemetry logs or memory dumps | `repos/effect/LLMS.md` & `tools/oxlint/syntax-bans.js`; pass `Redacted` directly to SDKs / use `Config.redacted` |
| Mutating state or I/O in `*.decide` deciders | Deciders must be pure mathematical functions with `R = never` | `agent-patterns/event-sourcing.md`; deciders take state + command and yield events |

---

## 2. Fail-Open Code vs. Intentional Degraded Mode Decision Tree

Reviewers routinely flag fail-open fallbacks (e.g., catching errors to `return []`, returning `Graph.empty`, exiting `0` on invalid CLI args, swallowing permission errors). Use this deterministic decision tree—never cite existing code or an existing passing test alone to defend fail-open behavior:

```text
Reviewer flags fail-open fallback / swallowed error / permissive exit code
  │
  ├─▶ Check `harness_ontology_why` & governing `ADR-NNNN` / EARS `REQ-*`:
  │     Does a verbatim ACCEPTED `<scope>:ADR-NNNN` or EARS `IF/THEN` (`REQ-*`) clause
  │     EXPLICITLY name BOTH (a) the exact error condition AND (b) the exact fallback return value?
  │     (JSDoc comments, READMEs, RFC prose, or draft docs NEVER count as ADR/EARS authority.)
  │       │
  │       ├─ YES (verbatim accepted spec/ADR clause names error condition + exact fallback):
  │       │    ├─ Spec specifies X and code matches X -> `decline-with-evidence` (quote exact ADR/REQ ID).
  │       │    └─ Spec is silent on exact log wording  -> `fix` logging per spec (NEVER downgrade failure
  │       │                                             semantics or authorize fallbacks via `doc-sync-fix`).
  │       │
  │       └─ NO (no accepted ADR/EARS clause explicitly mandates that error -> fallback mapping):
  │            └─ Existing unit test asserts the fallback?
  │                 ├─ YES -> Existing test enshrines a bug (`BUGGY_TEST_FLIP`).
  │                 │         Disposition MUST be `fix` or `class-fix`: refactor to fail closed
  │                 │         with a typed `Schema.TaggedError` / nonzero exit AND flip the test!
  │                 └─ NO  -> Disposition MUST be `fix` or `class-fix`: fail closed + add error test.
```

> [!CAUTION]
> **NEVER** classify an undocumented fail-open fallback as `doc-sync-fix`, and **NEVER** edit EARS specs or ADRs in Phase 3 to retroactively authorize existing fail-open code or passing fallback tests (`BUGGY_TEST_FLIP`). Downgrading fail-closed semantics requires an explicit human decision via `escalate-to-human` ONLY when an external product requirement conflicts (never to avoid `BUGGY_TEST_FLIP`).

---

## 3. High-Signal Harness Defect Classes & Pattern Routes (Observable Rules)

When review feedback identifies any of the following defect classes, verify with Graph MCP tools (`harness_resolve`, `harness_structural_search`, `harness_tests_reaching`). If confirmed, assign `fix` or `class-fix` using the mapped `Sanctioned Pattern`:

### A. Silent Test Failure / Vacuous Assertion

- **Sanctioned Pattern:** `agent-patterns/testing.md`
- **`fallback-json-equality`:** Assertions comparing objects via `JSON.stringify(actual) === JSON.stringify(expected)`.
  - _Fix:_ Replace with `Equal.equals(actual, expected)` or deep schema equality with `Schema.decodeUnknown`.
- **`vacuous-error-assertion`:** Assertions using `.thenFails()` or catching errors without checking exact error `_tag` / payload.
  - _Fix:_ Specify the expected tagged error (`.thenFails(new ExpectedError({ ... }))` or `Effect.flip`).
- **Untested Assertion Helper Failure Paths:** Custom test DSL helpers tested only on happy paths.
  - _Fix:_ Add negative unit tests asserting invalid inputs/orderings fail.
- **Buggy Fallback Test (`BUGGY_TEST_FLIP`):** Existing unit test asserts fail-open fallback behavior not mandated by any accepted ADR/EARS clause naming both error condition and fallback return value.
  - _Fix:_ Flip production code to fail closed with a typed `Schema.TaggedError` / nonzero exit and update the test to expect failure.

### B. Trace, Purity & Error-Channel Breakage

- **Sanctioned Pattern:** `agent-patterns/errors.md`, `agent-patterns/event-sourcing.md`, `agent-patterns/concurrency.md`
- **`unscoped-effect-run`:** Calling `Effect.runSync` or `Effect.runPromise` inside listeners, callbacks, or `Effect.gen`.
  - _Fix:_ Thread the `Effect` through the call chain or use `Runtime.runSync` with the ambient environment.
- **Impure Deciders:** `*.decide` containing `Clock`, `Random`, I/O, or `R !== never`.
  - _Fix:_ Inject time/IDs via command payload; keep `R = never`.
- **Fail-Open Error Swallowing & Mixed-Cause Defects:** `catchAll` / `catchCause` returning empty defaults (`[]`, `null`, `0`) without explicit accepted ADR/EARS mandate, or inspecting only `Cause.hasInterrupts(cause)` when non-interrupt failures are mixed in the `Cause` (Effect v4 requires `!Cause.hasFails(cause) && !Cause.hasDies(cause)` or `Cause.hasInterruptsOnly(cause)`).
  - _Fix:_ Propagate typed `Schema.TaggedError`, update affected callers/contracts in Phase 3, log diagnostics to `stderr` when appropriate, and add both pure-interrupt and mixed-cause tests.

### C. State-Stack, Worker & Resource Lifecycle Completeness

- **Sanctioned Pattern:** `agent-patterns/resources-scope.md`, `agent-patterns/durable-object-state.md`, `agent-patterns/concurrency.md`
- **Module-Wide Stack & Lifecycle Leaks / Double-Pops:** Bugs in transaction stacks (`txStack`), event listeners, timers, or spawned child workers (`child_process`, sockets) where fixing only `safeRollback` leaves `runTransaction`, `commit`, `begin`, `savepoint`, or outer `catch` / happy paths out of sync.
  - _Audit Rule:_ Inspect **EVERY** mutation/listener/cleanup site (`push`, `pop`, `shift`, `splice`, `clear`, `Ref.update`, `on`, `once`, `off`, `removeListener`, `removeAllListeners`, `kill`, `terminate`, `close`, `onExit`, `acquireUseRelease`) **across the ENTIRE owning module, class, service, and all caller/callee functions** (via `harness_callers` + `harness_structural_search` on the state variable/handle).
  - _Transaction Stack Invariants:_ Prefer savepoint-depth restoration over blind `pop()`, guard fiber interruption (`Effect.uninterruptibleMask` / `Effect.acquireUseRelease` / `Effect.onExit`), and test `txStack.length === preCallDepth` after nested inner-fail + outer-commit AND nested inner-fail + outer-rollback (zero double-pop).
  - _Worker / Socket Invariants:_ Attach `once("error")` + `once("exit")` listeners **before** spawn/close to prevent `Unhandled 'error' event`, handle already-exited workers (`exitCode !== null || killed`), remove listeners (`off`/`removeListener`) in `ensuring`/cleanup, escalate with timeout + `SIGKILL`, and test idempotent close + listener removal.

### D. Shallow Property Tests

- **Sanctioned Pattern:** `agent-patterns/testing.md`, `agent-patterns/event-sourcing.md`, `agent-patterns/schema.md`
- **`shallow-decider-property-test`:** `it.effect.prop` / `it.prop` using primitive generators instead of typed domain Schemas.
  - _Fix:_ Pass `Schema.Array(EventUnionSchema)` directly to `it.effect.prop` / `it.prop` (or `Arbitrary.schema(EventUnionSchema)`) to drive arbitrary state transitions and assert domain invariants.

### E. Spec-to-Code / ADR & Post-Edit Metric Parity (`doc-sync-fix`)

- **Sanctioned Pattern:** `agent-patterns/planning.md`
- **Semantic / Prose Drift (`orchestrator-phase3`):** Obsolete method/tag names, nonexistent Mermaid tags, or unimplemented future-phase claims in specs, ADRs, RFC prose, `README.md`, or `agent-patterns/*.md` -> update in **Phase 3** (or Phase 4 if code-adjacent JSDoc).
- **Numeric / LOC Metric Drift (`orchestrator-phase5`, `PHASE_5_STEP_0_WC_L`):** File line counts (`wc -l`), file inventories, or test/benchmark counts stale relative to disk -> schedule strictly for **Phase 5 Step 0** (NEVER compute `wc -l` or edit LOC numbers in Phase 2/3 before Phase 4 code edits settle).

### F. Gate Workarounds & Package Hygiene (`class-fix`)

- **Sanctioned Pattern:** `agent-patterns/pattern-matching.md`, `agent-patterns/d1-repository.md`, `tools/oxlint/syntax-bans.js`
- **Dummy Variable Reads (`const _ = x`), `@ts-ignore`, `oxlint-disable`, `empty-source-module`, `unused-package-dependency`:** Search twins with `harness_structural_search` and eliminate across the workspace.

---

## 4. Disposition Taxonomy (Zero-Nuance Predicates)

| Disposition | Observable Condition | Required Evidence in Ledger |
| :--- | :--- | :--- |
| **`fix`** | Confirmed defect isolated to one location, OR fail-open test lacking an explicit accepted ADR/EARS clause (`BUGGY_TEST_FLIP`). | Exact `file:line`, Graph MCP facts, module-wide sites (if stateful), remediation + exact test name. |
| **`class-fix`** | Confirmed pattern defect matching 2+ AST sites via `harness_structural_search`. | AST grep pattern, complete list of twin `file:line` sites, unified fix plan. |
| **`doc-sync-fix`** | Code matches accepted fail-closed architecture; doc/spec/LOC table contradicts reality. (Banned for authorizing undocumented fail-open fallbacks.) | Exact doc path + drifted section (`orchestrator-phase3` for semantics/prose; `orchestrator-phase5` / `PHASE_5_STEP_0_WC_L` for `wc -l`/counts). |
| **`decline-with-evidence`** | Reviewer suggestion violates a verbatim rule in `LLMS.md`, `agent-patterns/*.md`, an accepted `<scope>:ADR-NNNN`, an explicit EARS `REQ-*` naming both error condition and exact fallback, OR proves a factual premise error in TypeScript/Graph MCP (e.g., reviewer claims a param/symbol is missing when Graph MCP proves it already exists). Current `Effect<A, E, R>` caller signatures (such as `E = never` from swallowed errors) NEVER justify declining a defect fix. | Verbatim authority citation (`file:line` or `ADR-NNNN` / `REQ-*`) or Graph MCP counter-proof. Passing fallback tests alone NEVER qualify. |
| **`escalate-to-human`** | Novel product trade-off where zero governing ADR/EARS clause exists AND fixing breaks external product behavior. NEVER use for fail-open error swallowing, missing error propagation, or `BUGGY_TEST_FLIP` items (§2 mandates `fix` / `class-fix`). | Option A vs Option B impact table. |
| **`out-of-scope`** | BOTH Phase 1 Out-of-Scope Predicate conditions hold AND proven in the mandatory `Out-of-Scope Rejection Table`. | Verbatim Condition 1 proof (absent from `REQ-*`) + Condition 2 proof (touches none of the banned defect classes). |

---

## 5. Required Normalization & Adjudication Templates

### Status Tokens for `Existing Test Verified Against Spec?`

- **`VERIFIED_BY_SPEC(<ADR/REQ ID>)`**: Test and fallback behavior match an explicit accepted `<scope>:ADR-NNNN` or EARS `REQ-*` clause naming both error condition and fallback value.
- **`BUGGY_TEST_FLIP`**: Existing test asserts an undocumented fail-open fallback; code must fail closed and test must be flipped.
- **`MISSING_TEST`**: No reaching test exercises the failure, mixed-cause, or nested lifecycle path; new test assertion required.
- **`PHASE_5_STEP_0_WC_L`**: Numeric/LOC or test-count documentation update deferred until Phase 5 Step 0 after all Phase 4 edits settle.

### Checksum & Templates

Before editing any code or dispatching any subagents, the orchestrator MUST publish ALL THREE artifacts:

1. **`Phase 1 Checksum`:** `Total Source Sub-Claims = <N_adj> Adjudication Rows + <N_oos> Out-of-Scope Rows` (zero dropped claims, `Suggestions`, `Nitpicks`, or nested sub-bullets).
2. **`Review Feedback Adjudication Ledger`** (1 row per atomic sub-bullet `F-n.k` / `S-n.k` — never merge sub-bullets):

```markdown
### Review Feedback Adjudication Ledger

| Atomic ID (F-n.k / S-n.k) | Source Anchor (Item.Bullet) | File:Line | Quoted Sub-Claim | Graph MCP Evidence (Symbol / ADR / Twin Count / Sites) | Existing Test Verified Against Spec? | Disposition | Assigned Unit |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| F-10.1 | Imp-10.a | `apps/harness-mcp/src/server.ts:44` | "Mixed interrupt + failure causes treated as pure interrupt" | `main` (`harness_resolve`), 0 ADR fallback clauses | `MISSING_TEST` (no mixed-cause test) | `fix` | `mcp-unit` |
| F-10.2 | Imp-10.b | `apps/harness-cli/src/commands/verify.ts:21` | "`readRecordedSpans` returns `[]` on corrupt trace" | `readRecordedSpans`, 0 ADR clauses permitting silent `[]` | `BUGGY_TEST_FLIP` (unit test asserts `[]`) | `fix` | `cli-unit` |
| S-3.1 | Sug-3.a | `apps/harness-cli/src/index.ts:88` | "`--help` exits 0 for unknown subcommands" | `parseCommand` (`harness_resolve`), no ADR allowing 0 | `MISSING_TEST` (`--help` tests valid cmd only) | `fix` | `cli-unit` |
| S-4.1 | Sug-4.a | `docs/rfcs/0007-appendix-a-harness-architecture-audit-report.md:112` | "Line count table shows old LOC values" | `doc-only`, depends on Phase 4 line deltas | `PHASE_5_STEP_0_WC_L` | `doc-sync-fix` | `orchestrator-phase5` |
```

3. **`Out-of-Scope Rejection Table`** (required even if empty — state `"None (0 excluded items)"` when all items enter the ledger):

```markdown
### Out-of-Scope Rejection Table

| Atomic ID (OOS-n.k) | Source Anchor | File:Line | Quoted Sub-Claim | Condition 1 Proof (Absent from `REQ-*`) | Condition 2 Proof (Touches None of the Banned Defect Classes) |
| :-- | :-- | :-- | :-- | :-- | :-- |
| OOS-5.1 | Sug-5.a | `apps/sample-web/src/routes.ts:1` | "Add a new dark-mode theme toggle page" | Absent from active `REQ-*` EARS spec | Purely net-new UI feature; zero reliability, security, cleanup, error, validation, doc, or test gap |
```
