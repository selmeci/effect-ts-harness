# Evaluation Rubric for Effect Review Feedback

This rubric governs central adjudication of code review findings in the Effect-TS Engineering Harness. Every finding—whether from an external LLM (Grok, Codex), human reviewer, or automated PR comment—must be evaluated against this rubric before any code is modified.

---

## 1. Order of Authority Check

Every reviewer suggestion must be validated against the project's strict hierarchy of authority:

1. `repos/effect/LLMS.md`
2. Source code and tests in `repos/effect` and `repos/alchemy`
3. `agent-patterns/*.md` and `docs/alchemy-llms*.txt` (offline vendored reference)
4. `effect/Graph` + Omnigraph (`harness-mcp` / `@modernrelay/omnigraph-mcp`) and Nx graph for services and Layers

> [!CAUTION]
> Generic LLMs frequently suggest idiomatic TypeScript patterns that are **strictly banned** in Effect-TS. If a reviewer suggests any of the following, immediately classify the finding as `decline-with-evidence`:

| Reviewer Suggestion | Why It Is Banned | Authority / Sanctioned Replacement |
|---|---|---|
| `try { ... } catch (e) { ... }` or `async/await` | Destroys Effect error channels, structured concurrency, and interruption semantics | `repos/effect/LLMS.md`; use `Effect.tryPromise`, `Effect.try`, or `Effect.gen` |
| `switch (val._tag)` or `if (val._tag === ...)` | Unchecked matching misses newly added union variants at compile-time | `agent-patterns/pattern-matching.md`; use `match(val)...exhaustive()` from `ts-pattern` |
| `if (Option.isSome(opt))` or ternary `? :` on tag guards | Bypasses exhaustive pattern matching discipline | `agent-patterns/pattern-matching.md`; use `match(opt)...exhaustive()` |
| `Effect.runSync` / `Effect.runPromise` inside `Effect.gen` | Severs tracing span context and breaks structured fiber hierarchy | `repos/effect/LLMS.md`; `yield*` the effect inside `Effect.gen` |
| Importing `drizzle-orm`, `@effect/sql-*`, or `sqliteTable` in `type:domain` | Violates clean hexagonal architecture; domain must remain pure | Nx taxonomy & `AGENTS.md`; Drizzle belongs exclusively in `type:infra` |
| Raw `fetch(...)` in domain or frontend | Leaks untraced network calls and bypasses schema decoders | `AtomHttpApi` in frontend, `HttpClient` in `type:infra` |
| Direct secret access via `Redacted.value(secret)` in application code | Leaks credentials into telemetry logs or memory dumps | `agent-patterns/configuration.md`; pass `Redacted` directly to SDKs |
| Mutating state or I/O in `*.decide` deciders | Deciders must be pure mathematical functions with `R = never` | `agent-patterns/event-sourcing.md`; deciders take state + command and yield events |

---

## 2. High-Signal Harness Defect Classes

When review feedback identifies any of the following defect classes, verify with Graph MCP tools (`harness_resolve`, `harness_structural_search`, `harness_tests_reaching`). If confirmed, these findings **always require a `fix` or `class-fix`**:

### A. Silent Test Failure / Vacuous Assertion

- **`fallback-json-equality`:** Assertions comparing objects via `JSON.stringify(actual) === JSON.stringify(expected)`. This masks `undefined` vs omitted keys, function/symbol properties, and class prototype identities.
  - *Fix:* Replace with `Equal.equals(actual, expected)` or deep schema equality with `Schema.decodeUnknown`.
- **`vacuous-error-assertion`:** Assertions using `.thenFails()` without an expected error class, error tag, or schema payload. If the decider crashes with a `NoSuchElementException` or unexpected defect, a bare `.thenFails()` vacuously passes.
  - *Fix:* Specify the expected tagged error: `.thenFails(new ExpectedError({ ... }))` or assert the tag explicitly with `Effect.flip`.
- **Untested Assertion Helper Failure Paths:** Custom test DSL helpers (e.g. `expectEvents(...)`) where only the happy path was tested, without unit tests verifying that wrong event order, extra events, or mismatched payloads fail the test suite.
  - *Fix:* Add negative unit tests for the test assertions themselves.

### B. Trace & Purity Breakage

- **`unscoped-effect-run`:** Calling `Effect.runSync` or `Effect.runPromise` inside a synchronous event listener, callback, or `Effect.gen` block. This severs the parent `runWithTestTracer` span hierarchy and breaks fiber interruption.
  - *Fix:* Thread the `Effect` through the call chain or use `Runtime.runSync` with the ambient environment.
- **Impure Deciders:** A `*.decide` function containing `Clock.currentTimeMillis`, `Random.next`, or any service requirement in `R` (`R !== never`).
  - *Fix:* Pass current timestamp or generated IDs inside the command payload; keep `*.decide` pure with `R = never`.

### C. Shallow Property Tests

- **`shallow-decider-property-test`:** Using `it.effect.prop` or `it.prop` with primitive generators (e.g. `fc.integer()`, `fc.string()`) that never exercise realistic multi-step state transitions.
  - *Fix:* Use `Arbitrary.make(EventUnionSchema)` to generate arbitrary valid event sequences via `Schema.Array(EventUnionSchema)`, testing that arbitrary event sequences followed by arbitrary valid commands preserve domain invariants.

### D. Spec-to-Code / ADR Parity Drift (`doc-sync-fix`)

- **Method / Helper Renaming Drift:** EARS specs (`libs/<scope>/docs/specs/*.md`) or ADRs referencing obsolete helper names (e.g. `.then()` instead of `.thenEvents()`).
- **Nonexistent Diagram Tags:** Mermaid state or sequence diagrams referencing `*Error` tags or spans that do not exist in `type:contract`.
- **Unimplemented Future-Phase Claims:** An ADR or spec asserting that the current change implements future functionality (e.g. claiming cross-aggregate deduplication when only single-stream ordering is built).
- **Outdated Nx Tags:** Documentation referencing obsolete project tags or boundaries.
  - *Fix:* Update the governing EARS spec and ADR first (Phase 3) before closing the review.

### E. Gate Workarounds (`class-fix`)

- **Dummy Variable Reads:** Code containing `const _v = evt.version` or `void unusedVar` written solely to appease an unused variable check, instead of either using the data or fixing the schema/destructuring.
  - *Fix:* Run `harness_structural_search` to find all occurrences across the workspace; remove dummy reads and clean up model destructuring.

### F. Package Hygiene

- **`empty-source-module`:** Source files containing only `export {}` or dead imports.
- **`unused-package-dependency`:** Dependencies declared in `package.json` that are not imported by any file in the package graph.
  - *Fix:* Delete empty modules and remove unused dependencies from `package.json`.

---

## 3. Disposition Taxonomy

Every discrete finding must be assigned exactly one disposition:

| Disposition | When to Use | Required Evidence in Ledger |
|---|---|---|
| **`fix`** | Valid finding isolated to a single file/function. Code is provably buggy or sub-optimal. | Exact file:line, Graph MCP signature/callers facts, concrete remediation step. |
| **`class-fix`** | Valid finding that represents a pattern defect with multiple twin instances across the workspace. | AST grep pattern (`harness_structural_search`), list of all matching files/lines, unified fix plan. |
| **`doc-sync-fix`** | Code is correct and intended, but EARS spec (`specs/*.md`) or ADR (`adr/*.md`) has drifted. | Governing spec/ADR path, drifted section, exact markdown/Mermaid diff to synchronize. |
| **`decline-with-evidence`** | Finding is factually incorrect, violates Order of Authority, or contradicts an accepted ADR. | Citation of `LLMS.md`, `agent-patterns/*.md`, accepted ADR (`<scope>:ADR-NNNN`), or Graph MCP trace. |
| **`escalate-to-human`** | Reviewer raises a novel architectural trade-off with no established ADR or clear authority consensus. | Trade-off summary, proposed Option A vs Option B, impact on invariants. |

---

## 4. Required Adjudication Ledger Template

Before editing any code or dispatching any subagents, the orchestrator MUST publish the complete Adjudication Ledger in this format:

```markdown
### Review Feedback Adjudication Ledger

| ID | Location | Reviewer Claim | Graph MCP Evidence | Disposition | Action / Pattern Route |
|:---|:---|:---|:---|:---|:---|
| F-1 | `libs/sample/domain/src/cart.ts#L42` | "Decider uses JSON.stringify for state equality checks" | `harness_structural_search` found 3 occurrences in `domain` | `class-fix` | Replace with `Equal.equals`; route `agent-patterns/event-sourcing.md` |
| F-2 | `libs/sample/contract/src/errors.ts#L18` | "Use generic try/catch to wrap SQL exceptions" | Violates Order of Authority (`LLMS.md`); SQL errors map to `TaggedError` | `decline-with-evidence` | Decline: Effect errors must use `Schema.TaggedError` |
| F-3 | `libs/sample/docs/specs/cart.md#L88` | "Spec mentions .then() but code exposes .thenEvents()" | `harness_resolve` confirms exported helper is `.thenEvents` | `doc-sync-fix` | Update EARS spec to match actual helper API |
```
