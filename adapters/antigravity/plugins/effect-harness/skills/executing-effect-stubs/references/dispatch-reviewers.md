# Signal-Routed Multi-Lens Reviewer Dispatch Guide

This document defines the orchestration protocol for dispatching specialist review lenses prior to `harness gc --strict` and `harness verify`. Reviewers operate in read-only mode to falsify and validate implementation code against behavioral, security, reliability, and concurrency invariants.

---

## 1. Signal-Routing Table

The controller calls `harness_review_route` (or inspects the files, package boundaries (Nx tags), and Effect capabilities touched by the current task or diff), then routes monotonically to the appropriate specialist reviewers:

| Touched Files / Nx Tags / Capabilities                                                                                                                                                   | Specialist Agent                     | Persona Reference                                    | Primary Hunting Ground                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Always (Every Task) & Mandatory for Core/Domain/Event Sourcing**<br>Any `*.test.ts`, `*.spec.ts`, `type:domain`, `type:core`, deciders, or EARS acceptance criteria                    | `effect-ears-test-reviewer`          | `references/personas/ears-test-reviewer.md`          | 8-Point Anti-Rubber-Stamp Deep Audit, EARS clause test assertions (`WHEN`, `IF/THEN`, `WHILE`), mock over-specification, vacuous tests (`toBeDefined`), `runWithTestTracer`, folded state properties, contract brand reuse, `type:infra` guard-deletion falsification, and `checkSpanBudgets` (N+1 query protection). |
| **Mandatory for Core/Domain/Event Sourcing & Stateful Flows**<br>`type:core`, `type:domain`, deciders, event streams, Outbox, Projections, Process Managers, `stub<A, E, R>()` skeletons | `effect-adversarial-reviewer`        | `references/personas/adversarial-reviewer.md`        | Cross-entity command/event injection, property test generator weakening, protocol tracing enforcement (`Decider.make`), inter-step crash windows (commit vs. publish), duplicate message replay / idempotency deduplication, optimistic concurrency races, schema evolution, and omitted error types in `E`.          |
| **Contracts, APIs, Auth, Secrets**<br>`type:contract`, `HttpApi*`, `Rpc*`, `Config.*`, auth context, sessions                                                                            | `effect-security-reviewer`           | `references/personas/security-reviewer.md`           | Multi-tenant IDOR / authorization in use cases, secret leakage via `Redacted.value(...)`, unbounded schemas (`Schema.Finite`, string/array length limits), and indirect injection in `type:infra`.                                                                                                                    |
| **Infra, Storage, Retries, Resources**<br>`type:infra`, DO SQLite, D1, Queues, `Schedule.*`, `Scope`, `HttpClient`                                                                       | `effect-reliability-reviewer`        | `references/personas/reliability-reviewer.md`        | DO SQLite synchronous transaction discipline (`MixedScheduler("sync")`), pre-transaction schema decoding, commit-order `Ref` mutation, retry storms, missing timeouts, and `Scope` leaks.                                                                                                                             |
| **Frontend / Web Surfaces**<br>`scope:web`, `apps/*-web/**`, `*.tsx`, `AtomHttpApi`, `useAtomValue`, `useAtomSend`                                                                       | `effect-web-reviewer`                | `references/personas/web-reviewer.md`                | `AtomHttpApi` / `@effect/atom-react` boundary discipline, frontend concurrency & double-submit races, exhaustive `Result`/`Option` rendering via `ts-pattern`, and form/URL input brand decoding.                                                                                                                     |
| **Migrations, Wire Contracts, Alchemy Bindings**<br>`migrations/*.sql`, `*migrator*`, `alchemy.run.ts`, `type:contract` evolution                                                        | `effect-migration-contract-reviewer` | `references/personas/migration-contract-reviewer.md` | SQL migration correctness & `SqliteMigrator` table isolation, D1/SQLite index & query shape coverage, `HttpApiEndpoint`/`RpcGroup`/event contract consistency & explicit upcaster chains, and Alchemy v2 binding hygiene.                                                                                             |
| **Architecture, Ports, Adapters & Large Diffs**<br>`type:service`, `libs/es/**`, `libs/harness/**`, `adapters/**`, `changedLineCount >= 180`                                             | `effect-architecture-reviewer`       | `references/personas/architecture-reviewer.md`       | Framework-vs-application archetype purity, 5-tier hexagonal cohesion & `Context.Service`/`Layer` design, `SelfDogfooding.decide` line-ceiling proximity, and agent-surface SDO & adapter parity.                                                                                                                      |

> [!IMPORTANT]
> **Mandatory Dual-Review for Core / Domain / Event Sourcing:** For any task touching `type:core`, `type:domain`, deciders, or event sourcing, dispatching **BOTH** `effect-ears-test-reviewer` AND `effect-adversarial-reviewer` is strictly mandatory.
> **Neutral & Adversarial Prompting:** Prompts to reviewers MUST be neutral and adversarial ("Assume there are at least 3 P0/P1 bugs hiding across the spec, ADR, contract, fixtures, and tests; find them using the 8-Point Anti-Rubber-Stamp Audit") — never spoon-feed confirmation-biased prompts.
> **Domain-Scoped `harness_git_diff` Reviews:** Every specialist reviewer prompt MUST pass the exact list of domain-owned changed files + `baseRef` and instruct the reviewer to start with `harness_git_diff` (`statOnly: true`, then targeted `paths`) instead of re-reading all unchanged files in the PR.

---

## 2. Dispatch Instructions

Specialist reviewers run concurrently as read-only subagents. They never mutate workspace files or run git commands.

### In Antigravity (`invoke_subagent` by Default, `swarm` When Pinning `gemini-4-hydrogen-medium`)

**Default (`invoke_subagent` — Recommended for Read-Only Reviews):**
Because specialist reviewers are one-shot, read-only hub-and-spoke inspectors with dedicated agent definitions (`agents/effect-*-reviewer.md`) and no need for peer-to-peer message-board chatter, prefer `invoke_subagent` with `Workspace: "share"` (pass `Model: "gemini-4-hydrogen-medium"` if supported by the `Model` enum, otherwise `Model: "flash"` or `"inherit"` when the active session runs on Gemini 4 Hydrogen):

```ts
// Dispatching via defined specialist agents (mandatory dual-review for core/domain):
invoke_subagent({
  Subagents: [
    {
      TypeName: "effect-ears-test-reviewer",
      Role: "EARS & Test Fidelity Reviewer",
      Model: "flash", // Use "gemini-4-hydrogen-medium" if in Model enum, or "inherit" if session runs on Hydrogen
      Workspace: "share",
      Prompt: `Assume there are at least 3 P0/P1 bugs hiding across the spec, ADR, contract, fixtures, and tests; find them using the 8-Point Anti-Rubber-Stamp Audit. Do not assume any code or test is correct:
- Base Ref: <baseRef>
- Domain-Owned Changed Files: libs/sample/domain/src/sample.ts, libs/sample/domain/test/sample.test.ts
- Start with harness_git_diff (statOnly: true, then targeted paths on your domain-owned changed files) instead of re-reading all unchanged files in the PR.
- EARS Requirements & ADRs: libs/sample/docs/specs/SPEC-0001.md, libs/sample/docs/adr/0001.md
- Execute the 8-Point Anti-Rubber-Stamp Deep Audit.
- Adhere strictly to the Quote-the-Line Gate and False-Positive Suppression List.`,
    },
    {
      TypeName: "effect-adversarial-reviewer",
      Role: "Adversarial Chaos Reviewer",
      Model: "flash", // Use "gemini-4-hydrogen-medium" if in Model enum, or "inherit" if session runs on Hydrogen
      Workspace: "share",
      Prompt: `Assume there are at least 3 P0/P1 bugs hiding across the spec, ADR, contract, fixtures, and tests; find them using adversarial falsification. Do not assume any code or test is correct:
- Base Ref: <baseRef>
- Domain-Owned Changed Files: libs/sample/domain/src/sample.ts, libs/sample/domain/test/sample.test.ts
- Start with harness_git_diff (statOnly: true, then targeted paths on your domain-owned changed files) instead of re-reading all unchanged files in the PR.
- Hunt for: Cross-entity command/event injection, property test generator weakening, protocol tracing enforcement in Decider.make, inter-step crashes, idempotency bypass, and optimistic concurrency races.
- Adhere strictly to the Quote-the-Line Gate and False-Positive Suppression List.`,
    },
  ],
})
```

**Alternative (`swarm` — When Already Running a Swarm or Explicitly Pinning `gemini-4-hydrogen-medium`):**
If a swarm is already active for multi-package implementation or you need to explicitly pin `model: "gemini-4-hydrogen-medium"` while running the coordinator on another model:

```ts
swarm({
  action: "add",
  name: "ears-test-reviewer",
  model: "gemini-4-hydrogen-medium",
  workspace: "inherit",
  brief: `Read the specialist reviewer instructions at adapters/antigravity/plugins/effect-harness/agents/effect-ears-test-reviewer.md.
Assume there are at least 3 P0/P1 bugs hiding across the spec, ADR, contract, fixtures, and tests; find them using the 8-Point Anti-Rubber-Stamp Audit:
- Base Ref: <baseRef>
- Domain-Owned Changed Files: libs/sample/domain/src/sample.ts, libs/sample/domain/test/sample.test.ts
- Start with harness_git_diff (statOnly: true, then targeted paths on your domain-owned changed files) instead of re-reading all unchanged files in the PR.
- EARS Requirements & ADRs: libs/sample/docs/specs/SPEC-0001.md, libs/sample/docs/adr/0001.md
- Adhere strictly to the Quote-the-Line Gate and False-Positive Suppression List.
- Post your structured review report to @coordinator when finished.`,
})
```

### In Claude Code

Dispatch using the specialist agent name (`effect-ears-test-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`, `effect-adversarial-reviewer`, `effect-web-reviewer`, `effect-migration-contract-reviewer`, `effect-architecture-reviewer`) or delegate with the persona definition from `references/personas/*.md`.

---

## 3. False-Positive Suppression List

Reviewers MUST suppress findings for issues already enforced by deterministic workspace gates:

1. **TypeScript Typecheck (`@effect/tsgo`):**
   - Type mismatches, missing properties, invalid argument counts, or syntax errors.
2. **Language Service Lint Diagnostics (`@effect/language-service`):**
   - `floatingEffect` (un-yielded Effects inside `Effect.gen`) and `lazyEffect`.
3. **Syntax Bans & Self-Dogfooding Gates (`tools/oxlint/syntax-bans.js`, `SelfDogfooding.decide`):**
   - Direct `async/await`, `new Promise`, `try/catch`, `throw`, raw `JSON.parse`.
   - Direct `Effect.retry(..., Schedule.forever)` in `type:domain`.
   - Direct `Effect.ignore` in `type:domain`.
   - Direct `Config.string` with literal sensitive names (`SECRET`, `TOKEN`, `PASSWORD`, etc.).
   - Direct raw SQL template interpolation in `.exec(\`...\${...}\`)`or`.prepare(\`...\${...}\`)`.
   - Module-scope mutable caches (`no-global-mutable-cache`), `node:*` imports outside `type:infra` (`no-node-builtins-outside-infra`), `process.env` outside `type:infra`/`type:app` (`process-env-outside-infra-or-app`), and `export *` in `index.ts` barrels (`facade-star-reexport`).
4. **Architectural Graph & Hexagonal Tier Gates (`effect-graph:check`, `HarnessTierTopology.decide`, `harness gc --strict`):**
   - Nx 5-tier hexagonal boundary violations (`type:contract`, `type:service`, `type:core`, `type:domain`, `type:infra`, `type:app`, `dual-contract-tier-tag`, `impure-service-tier-import`, `domain-requires-infra`, `domain-requires-cloud-binding`).
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

- **Reviewer:** <effect-ears-test-reviewer | effect-security-reviewer | effect-reliability-reviewer | effect-adversarial-reviewer | effect-web-reviewer | effect-migration-contract-reviewer | effect-architecture-reviewer>
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
