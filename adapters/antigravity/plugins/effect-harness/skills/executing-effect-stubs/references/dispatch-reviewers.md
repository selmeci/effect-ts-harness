# Signal-Routed Multi-Lens Reviewer Dispatch Guide

This document defines the orchestration protocol for dispatching specialist review lenses prior to `harness gc --strict` and `harness verify`. Reviewers operate in read-only mode to falsify and validate implementation code against behavioral, security, reliability, and concurrency invariants.

---

## 1. Signal-Routing Table

The controller inspects the files, package boundaries (Nx tags), and Effect capabilities touched by the current task or diff, then routes to the appropriate specialist reviewers:

| Touched Files / Nx Tags / Capabilities | Specialist Agent | Persona Reference | Primary Hunting Ground |
|---|---|---|---|
| **Always (Every Task) & Mandatory for Core/Domain/Event Sourcing**<br>Any `*.test.ts`, `*.spec.ts`, `type:domain`, `type:core`, deciders, or EARS acceptance criteria | `effect-ears-test-reviewer` | `references/personas/ears-test-reviewer.md` | 7-Point Anti-Rubber-Stamp Deep Audit, EARS clause test assertions (`WHEN`, `IF/THEN`, `WHILE`), mock over-specification, vacuous tests (`toBeDefined`), `runWithTestTracer`, folded state properties, contract brand reuse, and `checkSpanBudgets` (N+1 query protection). |
| **Mandatory for Core/Domain/Event Sourcing & Stateful Flows**<br>`type:core`, `type:domain`, deciders, event streams, Outbox, Projections, Process Managers, `stub<A, E, R>()` skeletons | `effect-adversarial-reviewer` | `references/personas/adversarial-reviewer.md` | Cross-entity command/event injection, property test generator weakening, protocol tracing enforcement (`Decider.make`), inter-step crash windows (commit vs. publish), duplicate message replay / idempotency deduplication, optimistic concurrency races, schema evolution, and omitted error types in `E`. |
| **Contracts, APIs, Auth, Secrets**<br>`type:contract`, `HttpApi*`, `Rpc*`, `Config.*`, auth context, sessions | `effect-security-reviewer` | `references/personas/security-reviewer.md` | Multi-tenant IDOR / authorization in use cases, secret leakage via `Redacted.value(...)`, unbounded schemas (`Schema.Finite`, string/array length limits), and indirect injection in `type:infra`. |
| **Infra, Storage, Retries, Resources**<br>`type:infra`, DO SQLite, D1, Queues, `Schedule.*`, `Scope`, `HttpClient` | `effect-reliability-reviewer` | `references/personas/reliability-reviewer.md` | DO SQLite synchronous transaction discipline (`MixedScheduler("sync")`), pre-transaction schema decoding, commit-order `Ref` mutation, retry storms, missing timeouts, and `Scope` leaks. |

> [!IMPORTANT]
> **Mandatory Dual-Review for Core / Domain / Event Sourcing:** For any task touching `type:core`, `type:domain`, deciders, or event sourcing, dispatching **BOTH** `effect-ears-test-reviewer` AND `effect-adversarial-reviewer` is strictly mandatory.
> **Neutral & Adversarial Prompting:** Prompts to reviewers MUST be neutral and adversarial ("Assume there are at least 3 P0/P1 bugs hiding across the spec, ADR, contract, fixtures, and tests; find them using the 7-Point Anti-Rubber-Stamp Audit") — never spoon-feed confirmation-biased prompts.

---

## 2. Dispatch Instructions

Specialist reviewers run concurrently as read-only subagents. They never mutate workspace files or run git commands.

### In Antigravity (`invoke_subagent`)

When invoking defined specialist agents or generic research agents, use `Workspace: "share"` so workspace isolation is preserved without copying overhead. Prompts must be neutral and adversarial:

```ts
// Dispatching via defined specialist agents (mandatory dual-review for core/domain):
invoke_subagent({
  Subagents: [
    {
      TypeName: "effect-ears-test-reviewer",
      Role: "EARS & Test Fidelity Reviewer",
      Model: "flash",
      Workspace: "share",
      Prompt: `Assume there are at least 3 P0/P1 bugs hiding across the spec, ADR, contract, fixtures, and tests; find them using the 7-Point Anti-Rubber-Stamp Audit. Do not assume any code or test is correct:
- Target Files: libs/sample/domain/src/sample.ts, libs/sample/domain/test/sample.test.ts
- EARS Requirements & ADRs: libs/sample/docs/specs/SPEC-0001.md, libs/sample/docs/adr/0001.md
- Execute the 7-Point Anti-Rubber-Stamp Deep Audit.
- Adhere strictly to the Quote-the-Line Gate and False-Positive Suppression List.`
    },
    {
      TypeName: "effect-adversarial-reviewer",
      Role: "Adversarial Chaos Reviewer",
      Model: "flash",
      Workspace: "share",
      Prompt: `Assume there are at least 3 P0/P1 bugs hiding across the spec, ADR, contract, fixtures, and tests; find them using adversarial falsification. Do not assume any code or test is correct:
- Target Files: libs/sample/domain/src/sample.ts, libs/sample/domain/test/sample.test.ts
- Hunt for: Cross-entity command/event injection, property test generator weakening, protocol tracing enforcement in Decider.make, inter-step crashes, idempotency bypass, and optimistic concurrency races.
- Adhere strictly to the Quote-the-Line Gate and False-Positive Suppression List.`
    }
  ]
})
```

If invoking via the generic `research` subagent:
```ts
invoke_subagent({
  Subagents: [
    {
      TypeName: "research",
      Role: "Reliability & Concurrency Reviewer",
      Model: "flash",
      Workspace: "share",
      Prompt: `Read the persona instructions at:
adapters/antigravity/plugins/effect-harness/skills/executing-effect-stubs/references/personas/reliability-reviewer.md

Review the following files:
- Target Files: libs/sample/infra/src/repository.ts
- Adhere strictly to the Quote-the-Line Gate and False-Positive Suppression List.`
    }
  ]
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
   - Direct raw SQL template interpolation in `.exec(\`...\${...}\`)` or `.prepare(\`...\${...}\`)`.
4. **Architectural Graph Gates (`effect-graph:check`, `harness gc --strict`):**
   - Nx project boundary violations (`domain-requires-infra`, `domain-requires-cloud-binding`).
   - Dead `TaggedError`s (`dead-tagged-error`), unused/unprovided `ServiceTag`s, orphan `Effect.fn`s, or missing pattern docs.

---

## 4. Confidence Rubric

Reviewers evaluate findings against a 3-tier confidence scale:

| Score | Meaning | Action |
|---|---|---|
| **`100`** | **Direct Proof:** Clear, unambiguous bug or violation verifiable purely by inspecting the quoted code (e.g. `expect(res).toBeDefined()`, pre-transaction `Ref.set`, missing authorization check on tenant resource). | **Report as P0/P1.** Blocks completion until remediated. |
| **`75`** | **High Confidence:** Strong structural evidence of omission or race condition (e.g. unjittered exponential retry loop, crash between commit and outbox publish). | **Report as P0/P1.** Blocks completion until remediated. |
| **`50`** | **Speculative:** Theoretical risk or stylistic concern that requires human context or external configuration. | **Suppress.** Do not include in blocking review reports unless explicitly requested by caller. |

---

## 5. Quote-the-Line Gate & Output Contract

Every reported `P0` or `P1` finding MUST follow this exact schema:

```markdown
### [P0|P1] <Concise Title>
- **Reviewer:** <ears-test | security | reliability | adversarial>
- **Confidence:** 100 | 75
- **Evidence:** `<relative_file_path>:<line_number>`
  ```ts
  <exact verbatim lines quoted from the target file>
  ```
- **Why It Matters:** <Observable runtime failure, data corruption risk, exploit vector, or test blindness>
- **Suggested Fix:**
  ```ts
  <syntactically valid Effect v4 code snippet resolving the issue>
  ```
```

Findings that fail to quote exact lines or fail to articulate observable runtime consequences are rejected by the controller.
