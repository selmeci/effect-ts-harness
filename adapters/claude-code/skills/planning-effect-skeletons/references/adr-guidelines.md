# Architecture Decision Record (ADR) Guidelines & Canonical Template

Architecture Decision Records (ADRs) capture significant, non-trivial architectural decisions, their trade-offs, and the alternatives considered and rejected. In the Effect-TS Engineering Harness, ADRs are not passive documentation; they are **machine-verifiable governance contracts** represented as `AdrDoc` nodes in `HarnessGraph` and Omnigraph, connected via `GovernsSymbol` edges to functions (`spans`), services (`services`), and error classes (`errors`), and continuously audited by `AdrDocLint.decide` and `stale-doc-reference` during `harness gc --strict`.

---

## 1. The Counterfactual Eligibility Rule (When to Write vs. Update vs. Skip an ADR)

Grounded in Nygard ADRs, MADR 3.0, ISO/IEC/IEEE 42010, and the `ce-compound` methodology, this repository enforces the **Counterfactual Eligibility Rule**:

> _"If this ADR did not exist, would a future engineer or autonomous agent reading the final code, types, and tests still be likely to repeat a rejected mistake, violate a hidden runtime constraint, or re-litigate this architectural trade-off?"_

### The Decision Matrix

| Question & Scenario                                                                                                                                                     | Action                                | Destination                                                                                                                  |
| :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------- |
| **YES (New decision):** Non-obvious trade-off, architectural boundary constraint, hidden platform limitation, or rejected alternative with non-intuitive failure modes. | **Write a new ADR**                   | Domain-scoped: `libs/<scope>/docs/adr/NNNN-<slug>.md`<br/>Workspace-wide: `docs/adr/NNNN-<slug>.md`                          |
| **YES (Evolving decision):** The original architectural premise holds, but constraints or implementation details evolved.                                               | **Update existing ADR in-place**      | Update the existing ADR file, adding an update note or amending consequences and drivers.                                    |
| **YES (Reversed decision):** An earlier decision is being repealed or replaced by a conflicting architectural choice.                                                   | **Supersede old ADR & write new ADR** | Mark old ADR `status: superseded` with `superseded_by: <scope>:ADR-MMMM`. Write new ADR referencing the superseded decision. |
| **NO (Routine detail):** Standard Effect idioms (e.g. using `Effect.gen`), everyday refactorings, obvious schema mappings, or standard library usage.                   | **SKIP ADR**                          | Belongs in `agent-patterns/*.md`, code comments, or unit/property tests.                                                     |

### Co-Location and Scoping Convention

- **Domain-scoped ADRs:** Stored in `libs/<scope>/docs/adr/NNNN-<slug>.md` (e.g., `libs/sample/docs/adr/0001-...md`, `libs/harness/docs/adr/0001-...md`) with identifier `id: <scope>:ADR-NNNN`.
- **Root / Workspace-wide ADRs:** Stored in root `docs/adr/NNNN-<slug>.md` with identifier `id: ADR-NNNN`. Reserved strictly for cross-cutting, repo-wide architectural rules.

---

## 2. One Template, Every Time — Canonical English ADR Structure

Every ADR in this repository must use **One Template, Every Time**. The structure is strictly enforced by the deterministic `AdrDocLint.decide` gate in `harness gc --strict`.

### Parser-Safe Frontmatter Rules

- Delimit with exact `---` lines.
- Quote any scalar string value containing `: ` or ` #`.
- `enforced_by` must contain at least one repository-relative file path that physically exists on disk.
- At least one of `spans:`, `services:`, or `errors:` must be provided, linking the ADR to `HarnessGraph` and Omnigraph via `GovernsSymbol` edges.
- If `status: superseded`, frontmatter must contain `superseded_by: <scope>:ADR-MMMM` (or `ADR-MMMM`).

### The 6 Required `##` Sections (Fixed Order)

1. `## Context and Problem Statement` (1–2 paragraphs: current runtime/architectural forces and what breaks if left undecided)
2. `## Decision Drivers` (at least 2 `* ...` bullets naming the non-negotiable constraints)
3. `## Considered Options` (at least 2 `* **Option N:** ...` items)
4. `## Decision Outcome` (opens with `**Chosen option:** "<Option Name>"` followed by the binding architectural rules)
5. `## Rejected Alternatives` (numbered `### 1 · <Option Name>` subsections with middle dot `·`, each opening with `**Why rejected:** <concrete failure mode, cost, or constraint violation>`)
6. `## Consequences and Enforcement` containing:
   - `### Positive Consequences` (`* ...`)
   - `### Negative Consequences and Trade-offs` (`* ...`)
   - `### Deterministic Enforcement` with the 4-column table:
     `| Rule | Enforced By | Gate / Mechanism | Governed Symbols |`

### Canonical Copy-Pasteable ADR Template

```markdown
---
id: <scope>:ADR-NNNN
title: Short Noun Phrase Stating the Architectural Decision
status: accepted
date: YYYY-MM-DD
enforced_by:
  - libs/<scope>/infra/src/specific-enforcer.ts
  - tools/oxlint/syntax-bans.js
spans:
  - DomainSymbol.decide
services:
  - SpecificService
errors:
  - SpecificDomainError
---

# <scope>:ADR-NNNN: Short Noun Phrase Stating the Architectural Decision

## Context and Problem Statement

First paragraph describing the runtime environment, business context, and operational forces currently at play. Clearly state the architectural problem and the tension between competing requirements.

Second paragraph explaining what breaks, degrades, or incurs unacceptable risk if this decision is left unresolved or left to individual engineer discretion.

## Decision Drivers

- Non-negotiable driver or constraint 1 (e.g. latency budget, cloud runtime limitation, memory footprint)
- Non-negotiable driver or constraint 2 (e.g. data consistency requirement, transactional boundary, type-safety guarantee)

## Considered Options

- **Option 1:** Short title and description of Option 1
- **Option 2:** Short title and description of Option 2
- **Option 3:** Short title and description of Option 3

## Decision Outcome

**Chosen option:** "Option 1: Short title of Option 1", because detailed justification explaining how it addresses all decision drivers.

### Architectural Rules and Guarantees

1. Binding architectural rule or invariant 1.
2. Binding architectural rule or invariant 2.
3. Boundary rule between layers, services, or storage mechanisms.

## Rejected Alternatives

### 1 · Option 2: Short title of Option 2

**Why rejected:** Concrete failure mode, operational cost, or runtime violation that disqualified this option. Explain why future engineers or agents must not attempt this path.

### 2 · Option 3: Short title of Option 3

**Why rejected:** Concrete failure mode, operational cost, or runtime violation that disqualified this option. Explain why future engineers or agents must not attempt this path.

## Consequences and Enforcement

### Positive Consequences

- Observable architectural or operational benefit 1.
- Observable architectural or operational benefit 2.

### Negative Consequences and Trade-offs

- Accepted cost, complexity, or restriction 1.
- Accepted cost, complexity, or restriction 2.

### Deterministic Enforcement

| Rule                  | Enforced By                      | Gate / Mechanism      | Governed Symbols      |
| --------------------- | -------------------------------- | --------------------- | --------------------- |
| Description of rule 1 | `libs/<scope>/infra/src/file.ts` | `harness gc --strict` | `DomainSymbol.decide` |
| Description of rule 2 | `tools/oxlint/syntax-bans.js`    | AST syntax ban        | `SpecificService`     |
```

> [!WARNING]
> Do not leave raw `<...>` or `TODO` placeholders in saved ADR files. The linter check `adr-unfilled-placeholder` will fail `harness gc --strict` if unfilled placeholders are present.

---

## 3. Deterministic Lint Rules (`AdrDocLint.decide`)

ADR quality is mechanically verified by `AdrDocLint.decide` in `harness gc --strict`. The gate validates 7 specific invariants:

| Linter Rule                              | Failure Condition                                                                                                                                                                                       | Remediation                                                                                                                            |
| :--------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------- |
| **`adr-frontmatter-invalid`**            | Missing YAML frontmatter, missing mandatory fields (`id`, `title`, `status`, `date`, `enforced_by`), invalid status, `superseded` without `superseded_by`, or none of `spans`, `services`, or `errors`. | Ensure frontmatter is enclosed in `---`, has valid fields, valid status, and at least one governed symbol list.                        |
| **`adr-section-structure`**              | Missing any of the 6 canonical `##` sections or sections appear out of order.                                                                                                                           | Structure the document with the exact 6 `##` headings in canonical order.                                                              |
| **`adr-missing-drivers-or-options`**     | `## Decision Drivers` has fewer than 2 `*` bullets, or `## Considered Options` has fewer than 2 `* **Option N:**` entries.                                                                              | Supply at least 2 drivers and at least 2 considered options.                                                                           |
| **`adr-missing-chosen-option`**          | `## Decision Outcome` does not start with `**Chosen option:** "<Option Name>"`.                                                                                                                         | Begin the Decision Outcome section with `**Chosen option:** "..."`.                                                                    |
| **`adr-rejected-alternative-structure`** | `## Rejected Alternatives` does not contain numbered `### N · <Option Name>` subsections (middle dot `·`), or subsection does not open with `**Why rejected:**`.                                        | Format each rejected alternative as `### N · <Option Name>` and open the paragraph with `**Why rejected:** <reason>`.                  |
| **`adr-missing-enforcement-table`**      | `## Consequences and Enforcement` is missing `### Positive Consequences`, `### Negative Consequences and Trade-offs`, or `### Deterministic Enforcement` with the 4-column table.                       | Include both consequence subsections and the exact 4-column table `\| Rule \| Enforced By \| Gate / Mechanism \| Governed Symbols \|`. |
| **`adr-unfilled-placeholder`**           | Document contains unfilled template placeholders (`<...>` or `TODO`).                                                                                                                                   | Replace all placeholders with concrete architectural specifications.                                                                   |

In addition, **`stale-doc-reference`** ensures that:

- Every file path in `enforced_by` physically exists on disk.
- Every symbol in `spans`, `services`, and `errors` exists as an active node in `HarnessGraph`.

---

## 4. Three-Role ADR Review Protocol Before Saving

Before committing or marking an ADR as `status: accepted`, verify it against the **Three-Role ADR Review Protocol**:

### 1. Coherence Lens (Architect & System Designer)

- Does the `Decision Outcome` directly resolve every single driver listed under `## Decision Drivers`?
- Are the `Governed Symbols` listed in the enforcement table identical to the `spans`, `services`, and `errors` in the YAML frontmatter?
- Is the choice consistent with the repository's Nx taxonomy (`type:contract` $\to$ `type:service` $\to$ `type:domain` $\to$ `type:infra` $\to$ `type:app`)?

### 2. Feasibility Lens (Release Engineer & CI/CD)

- Does every file path listed in `enforced_by` actually exist on disk in the current workspace?
- Is every gate and mechanism listed in `### Deterministic Enforcement` (e.g. `oxlint`, `checkEffectGraph`, `GraphGc.decide`, `MigrationSafety.decide`) active and executable in the repo?
- Can this ADR pass `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict` without warnings or failures?

### 3. Adversarial Counterfactual Lens (Autonomous Chaos Agent)

- If a future agent or engineer reads only the final codebase without this ADR, would they fall into one of the traps described in `## Rejected Alternatives`?
- Is each **Why rejected:** explanation backed by a concrete failure mode (e.g., SQLite lock contention, W3C traceparent disconnection, memory exhaustion, type erasure to `never`) rather than subjective aesthetics?
- Does the ADR provide enough negative context to definitively terminate future debates or hallucinations?
