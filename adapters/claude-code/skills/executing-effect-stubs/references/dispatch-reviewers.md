# Signal-Routed Multi-Lens Reviewer Dispatch Guide

This document defines the orchestration protocol for dispatching specialist review lenses prior to `harness gc --strict` and `harness verify`. Reviewers operate in read-only mode to falsify and validate implementation code against behavioral, security, reliability, and concurrency invariants.

---

## 1. Signal-Routing Table

The controller inspects the files, package boundaries (Nx tags), and Effect capabilities touched by the current task or diff, then routes to the appropriate specialist reviewers:

| Touched Files / Nx Tags / Capabilities                                                                                             | Specialist Agent              | Persona Reference                             | Primary Hunting Ground                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Always (Every Task)**<br>Any `*.test.ts`, `*.spec.ts`, `type:domain`, or EARS acceptance criteria                                | `effect-ears-test-reviewer`   | `references/personas/ears-test-reviewer.md`   | EARS clause test assertions (`WHEN`, `IF/THEN`, `WHILE`), mock over-specification, vacuous tests (`toBeDefined`), `runWithTestTracer`, and `checkSpanBudgets` (N+1 query protection).              |
| **Contracts, APIs, Auth, Secrets**<br>`type:contract`, `HttpApi*`, `Rpc*`, `Config.*`, auth context, sessions                      | `effect-security-reviewer`    | `references/personas/security-reviewer.md`    | Multi-tenant IDOR / authorization in use cases, secret leakage via `Redacted.value(...)`, unbounded schemas (`Schema.Finite`, string/array length limits), and indirect injection in `type:infra`. |
| **Infra, Storage, Retries, Resources**<br>`type:infra`, DO SQLite, D1, Queues, `Schedule.*`, `Scope`, `HttpClient`                 | `effect-reliability-reviewer` | `references/personas/reliability-reviewer.md` | DO SQLite synchronous transaction discipline (`MixedScheduler("sync")`), pre-transaction schema decoding, commit-order `Ref` mutation, retry storms, missing timeouts, and `Scope` leaks.          |
| **Stateful Flows, Event Sourcing, Skeletons**<br>Event streams, Outbox, Projections, Process Managers, `stub<A, E, R>()` skeletons | `effect-adversarial-reviewer` | `references/personas/adversarial-reviewer.md` | Inter-step crash windows (commit vs. publish), duplicate message replay / idempotency deduplication, optimistic concurrency races, schema evolution, and omitted error types in `E`.               |

---

## 2. Dispatch Instructions

Specialist reviewers run concurrently as read-only subagents. They never mutate workspace files or run git commands.

### In Antigravity (`invoke_subagent` by Default, `swarm` When Pinning `gemini-4-hydrogen-medium`)

Prefer `invoke_subagent` with `Workspace: "share"` for one-shot read-only specialist reviews (passing `Model: "gemini-4-hydrogen-medium"` if supported by the `Model` enum, otherwise `Model: "flash"` or `"inherit"` when the session runs on Gemini 4 Hydrogen), or use `swarm` (`action: "add"`, `model: "gemini-4-hydrogen-medium"`, `workspace: "inherit"`) when an active swarm is already running or explicit model pinning is needed:

```ts
// Default: Dispatching via defined specialist agents (invoke_subagent):
invoke_subagent({
  Subagents: [
    {
      TypeName: "effect-ears-test-reviewer",
      Role: "EARS & Test Fidelity Reviewer",
      Model: "flash", // Use "gemini-4-hydrogen-medium" if in Model enum, or "inherit" if session runs on Hydrogen
      Workspace: "share",
      Prompt: `Review touched test and domain files for EARS clause coverage and test fidelity:
- Target Files: libs/sample/domain/src/sample.ts, libs/sample/domain/test/sample.test.ts
- EARS Requirements: doc/plans/feature-plan.md
- Adhere strictly to the Quote-the-Line Gate and False-Positive Suppression List.`,
    },
    {
      TypeName: "effect-security-reviewer",
      Role: "Security & Trust-Boundary Reviewer",
      Model: "flash", // Use "gemini-4-hydrogen-medium" if in Model enum, or "inherit" if session runs on Hydrogen
      Workspace: "share",
      Prompt: `Audit touched contract and domain files for authorization (IDOR), secret unwrapping, and schema bounds:
- Target Files: libs/sample/contract/src/index.ts, libs/sample/domain/src/usecase.ts
- Persona Guide: adapters/antigravity/plugins/effect-harness/skills/executing-effect-stubs/references/personas/security-reviewer.md
- Adhere strictly to the Quote-the-Line Gate and False-Positive Suppression List.`,
    },
  ],
})
```

When explicitly pinning `gemini-4-hydrogen-medium` via `swarm`:

```ts
swarm({
  action: "add",
  name: "reliability-reviewer",
  model: "gemini-4-hydrogen-medium",
  workspace: "inherit",
  brief: `Read the persona instructions at:
adapters/antigravity/plugins/effect-harness/skills/executing-effect-stubs/references/personas/reliability-reviewer.md

Review the following files:
- Target Files: libs/sample/infra/src/repository.ts
- Adhere strictly to the Quote-the-Line Gate and False-Positive Suppression List.
- Post your structured review report to @coordinator when finished.`,
})
```

### In Claude Code

Dispatch using the specialist agent name (`effect-ears-test-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`, `effect-adversarial-reviewer`) or delegate with the persona definition from `references/personas/*.md`.

---

## 3. False-Positive Suppression List

Reviewers MUST suppress findings for issues already enforced by deterministic workspace gates:

1. **TypeScript Typecheck (`@effect/tsgo`):**
   - Type mismatches, missing properties, invalid argument counts, or syntax errors.
2. **Language Service Lint Diagnostics (`@effect/language-service`):**
   - `floatingEffect` (un-yielded Effects inside `Effect.gen`) and `lazyEffect`.
3. **Syntax Bans (`tools/oxlint/syntax-bans.js`):**
   - Direct `async/await`, `new Promise`, `try/catch`, `throw`, raw `JSON.parse`.
   - Direct `Effect.retry(..., Schedule.forever)` in `type:domain`.
   - Direct `Effect.ignore` in `type:domain`.
   - Direct `Config.string` with literal sensitive names (`SECRET`, `TOKEN`, `PASSWORD`, etc.).
   - Direct raw SQL template interpolation in `.exec(\`...\${...}\`)`or`.prepare(\`...\${...}\`)`.
4. **Architectural Graph Gates (`effect-graph:check`, `harness gc --strict`):**
   - Nx project boundary violations (`domain-requires-infra`, `domain-requires-cloud-binding`).
   - Dead `TaggedError`s (`dead-tagged-error`), unused/unprovided `ServiceTag`s, orphan `Effect.fn`s, or missing pattern docs.

---

## 4. Confidence Rubric

Reviewers evaluate findings against a 3-tier confidence scale:

| Score     | Meaning                                                                                                                                                                                                              | Action                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **`100`** | **Direct Proof:** Clear, unambiguous bug or violation verifiable purely by inspecting the quoted code (e.g. `expect(res).toBeDefined()`, pre-transaction `Ref.set`, missing authorization check on tenant resource). | **Report as P0/P1.** Blocks completion until remediated.                                       |
| **`75`**  | **High Confidence:** Strong structural evidence of omission or race condition (e.g. unjittered exponential retry loop, crash between commit and outbox publish).                                                     | **Report as P0/P1.** Blocks completion until remediated.                                       |
| **`50`**  | **Speculative:** Theoretical risk or stylistic concern that requires human context or external configuration.                                                                                                        | **Suppress.** Do not include in blocking review reports unless explicitly requested by caller. |

---

## 5. Quote-the-Line Gate & Output Contract

Every reported `P0` or `P1` finding MUST follow this exact schema:

````markdown
### [P0|P1] <Concise Title>

- **Reviewer:** <ears-test | security | reliability | adversarial>
- **Confidence:** 100 | 75
- **Evidence:** `<relative_file_path>:<line_number>`
  ```ts
  <exact verbatim lines quoted from the target file>
  ```
````

- **Why It Matters:** <Observable runtime failure, data corruption risk, exploit vector, or test blindness>
- **Suggested Fix:**
  ```ts
  <syntactically valid Effect v4 code snippet resolving the issue>
  ```

```

Findings that fail to quote exact lines or fail to articulate observable runtime consequences are rejected by the controller.
```
