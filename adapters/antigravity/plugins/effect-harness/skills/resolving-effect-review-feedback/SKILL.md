---
name: resolving-effect-review-feedback
description: Use when addressing code review feedback pasted as text (from Grok, Codex, or human reviewers) or left on a GitHub PR in an Effect-TS Harness project, or when review findings expose silent test failures, spec-to-code drift, or gate blind spots.
---

# Resolving Effect Review Feedback (Central Adjudication & Subagent Fix Loop)

## Overview

This skill establishes the central orchestrator and subagent fix loop for resolving code review feedback in an Effect-TS Engineering Harness workspace, adapted from `ce-resolve-pr-feedback`.

External code reviewers (whether human engineers or external models like Grok and Codex) frequently produce a mixture of high-signal defect reports, misunderstandings of Effect v4 idioms, and requests that violate established Architectural Decision Records (ADRs).

To maintain codebase integrity and eliminate thrashing:
- The **Orchestrator** centrally adjudicates all feedback against the harness **Order of Authority** using **in-process Graph MCP (`harness-mcp`)** facts, synchronizes EARS specifications and ADRs first, dispatches execution units, runs monorepo gates, and performs compounding gate promotion.
- Lightweight **`flash` Fixer Subagents** act purely as execution hands. They receive package-isolated file sets, exact pattern recipe routes, reaching test files, and governing ADR constraints. They never adjudicate, never debate, and never touch whole-monorepo gates or stamps.

**Violating the letter of the rules is violating the spirit of the rules.**

---

## 5-Phase Resolution Recipe

```text
Phase 1: Ingest & Normalize Batch
         ↓
Phase 2: Central Adjudication via Graph MCP & Order of Authority (Orchestrator Only)
         ↓
Phase 3: Contract, EARS Spec & ADR Synchronization First (Orchestrator Only)
         ↓
Phase 4: Package-Isolated flash Fixer Dispatch (Parallel Subagents)
         ↓
Phase 5: Whole-Workspace Deterministic Gates & Compounding Promotion (Orchestrator Only)
```

---

### Phase 1 — Ingest & Normalize Feedback Batch

Accept review feedback from either of two ingress sources:
1. **Pasted Review Markdown:** Review text pasted into the conversation (e.g. from Grok, Codex, Claude, or a human reviewer) structured with severity headers (`Critical`, `Important`, `Suggestions`, `Nitpicks`).
2. **GitHub PR Threads & Comments:** When given a PR number or URL, fetch both top-level review submissions (`gh pr view <number> --comments`) and inline line-level review threads (`gh api repos/{owner}/{repo}/pulls/{number}/comments`).

Normalize every finding into a single enumerated list:
- Format: `F-1`, `F-2`, `F-3`, ...
- Capture for each: `Location` (`file:line`), `Severity` (`Critical`, `Important`, `Suggestion`), and exact `Quoted Claim`.
- **Filter Out-of-Scope / Untracked Items Immediately:** If a finding demands features not in the active EARS specification, suggests future-phase scope, or requests subjective aesthetic restyling that contradicts existing lint rules, separate it immediately into an **Out-of-Scope** table and do not schedule implementation work for it.

---

### Phase 2 — Central Adjudication via Graph MCP & Order of Authority (Orchestrator Only)

> [!IMPORTANT]
> Never blindly implement reviewer suggestions. Never delegate judgment to `flash` fixer subagents or `clef-flash`. The orchestrator alone must evaluate each item against [references/evaluation-rubric.md](references/evaluation-rubric.md).

For each normalized finding `F-n`, run in-process Graph MCP tools instead of slow shell commands (`grep`, `git blame`):

1. **Signature & Error Channel Resolution (`harness_resolve` & `harness_callers`):**
   - Resolve the target symbol or `Effect.fn` span name.
   - Inspect the exact `Effect<A, E, R>` signature, incoming callers, and declared error channel `E`.
   - Verify whether the reviewer's claim is mathematically correct under Effect semantics.
2. **Ontology Traceability (`harness_ontology_why` & `harness_ontology_impact`):**
   - Retrieve governing `AdrDoc` (`<scope>:ADR-NNNN`) and `EarsSpec` (`REQ-*`) nodes.
   - Determine whether the flagged behavior was an intentional, approved architectural trade-off or genuine spec-to-code drift.
3. **AST Twin Hunting for Class-Fixes (`harness_structural_search`):**
   - When a finding is valid, do not fix only the single quoted line.
   - Run an `@ast-grep/napi` AST search (`pattern` using `$META` metavariables, e.g. `Equal.equals($A, $B) || JSON.stringify($A) === JSON.stringify($B)` or `Effect.runSync($EXPR)`) across the package or workspace to uncover identical anti-patterns.
   - Cluster all twin occurrences into a single **`class-fix`** finding.
4. **Test Reachability Inspection (`harness_tests_reaching`):**
   - Identify all `@effect/vitest` `VitestCase` nodes exercising the target symbol or span.
   - If the reviewer claims a test gap, verify whether reaching test cases are missing, vacuous (`.thenFails()` with no expected error), or lack negative failure cases.
5. **Specialist Lens Consultation (Optional for Contested Items):**
   - If an item involves subtle concurrency races, trust boundaries, or adversarial state sequences, invoke read-only specialist reviewers (`effect-adversarial-reviewer`, `effect-ears-test-reviewer`, `effect-reliability-reviewer`, `effect-security-reviewer`) for targeted analysis before finalizing the verdict.

Assign each finding one disposition from the rubric:
- `fix`: Single-location valid code defect.
- `class-fix`: Valid defect with twin AST matches across the workspace.
- `doc-sync-fix`: Code is intentional; EARS spec or ADR must be updated to match reality.
- `decline-with-evidence`: Invalid suggestion violating Order of Authority or ADRs.
- `escalate-to-human`: Ambiguous architectural dilemma requiring human decision.

**Output the complete Adjudication Ledger table before writing any code or dispatching subagents.**

---

### Phase 3 — Contract, EARS Spec & ADR Synchronization First (Orchestrator Only)

If any approved finding (`fix`, `class-fix`, `doc-sync-fix`) impacts:
- `type:contract` Schemas, `HttpApiEndpoint` / `Rpc` definitions, or API errors
- `type:service` ports or repository abstractions
- Exported `Effect.fn` signatures
- Feature specifications (`libs/<scope>/docs/specs/*.md`) or ADRs (`libs/<scope>/docs/adr/*.md`)

The orchestrator MUST synchronize documentation and contracts **first**:
1. Update the governing EARS specification: update `WHEN`, `IF/THEN`, `WHILE`, and `WHERE` clauses, `spans` / `errors` tables, and Mermaid state diagrams so they reflect the intended reality.
2. If an architectural invariant changed, update the ADR text and YAML frontmatter (`spans`, `services`, `errors`, `enforced_by`).
3. Run `harness_ontology_check` to ensure zero semantic conflicts (`OntologyConflictV1`) and run `harness_lsp_diagnostics` on touched contract files.
4. If new function signatures or service tags were added, execute plan-check to lock the boundary:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check
   ```

---

### Phase 4 — Package-Isolated `flash` Fixer Dispatch

Group approved `fix` and `class-fix` items by package/directory boundaries so each subagent receives exclusive ownership of a disjoint set of files.

1. **Obtain Pattern Route:** For each group, call `harness_route` (`IdiomRouterV1` via `clef-flash`) to identify the exact sanctioned pattern recipe in `agent-patterns/<block>.md`. If `harness_route` returns `patternFile: null` (e.g. local Ollama offline or timed out), select the matching `agent-patterns/<block>.md` directly from the defect category in [references/evaluation-rubric.md](references/evaluation-rubric.md).
2. **Dispatch Subagents:** Launch parallel fixer subagents (`TypeName: "self"`, `Model: "flash"`, `Workspace: "share"` or `HARNESS_WORKTREE_ID=<unit>`):
   - Use the prompt template in [references/effect-fixer-prompt.md](references/effect-fixer-prompt.md).
   - Supply the 5 mandatory inputs: (1) Assigned Finding IDs, (2) Target Files & Twin Locations, (3) Governing EARS Clauses & ADR Invariants, (4) Pattern Recipe Path, (5) Reaching Test Files & Required Test Assertions.
3. **Subagent Execution Discipline:**
   - Fixers run `harness_lsp_diagnostics` and package-scoped tests (`CI=true pnpm nx run <project>:test`).
   - Fixers MUST NOT run whole-monorepo gates (`harness verify`, `harness done`) or git operations.
   - Fixers MUST return the structured `Fixer Completion Report` and terminate.
4. **Cleanup:** Kill completed subagent sessions via `manage_subagents(Action: "kill")`.

---

### Phase 5 — Whole-Workspace Deterministic Gates & Compounding Promotion (Orchestrator Only)

Once all fixer reports are received and merged into the workspace:

1. **Execute Deterministic Gates:**
   Run the full, ordered gate sequence in the root workspace:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts mutate --strict
   CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
   CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done
   ```

2. **Compounding Gate Audit (`compounding-effect-learnings`):**
   For every valid `Critical` or `Important` review finding that previously slipped past `harness verify`, conduct the Compounding Audit:
   - Ask: *"Why did our deterministic gates allow this defect to exist?"*
   - Examples:
     - If `fallback-json-equality` was used: add an AST ban to `tools/oxlint/syntax-bans.js` or `libs/harness/graph/src/policy-check.ts`.
     - If `.thenFails()` had no expected error: add a regex rule or linter check forbidding bare `.thenFails()` without arguments.
     - If an edge-case mutation survived: add an operator to `libs/harness/gates/src/mutation-check.ts`.
     - If a recurring architectural question arose: run `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn` and promote an ADR or pattern doc.

---

## Role of Graph MCP vs. Clef (`clef-flash`)

| Tool / Subsystem | Phase | Permitted Use | Strictly Banned Use |
|---|---|---|---|
| `harness_resolve` & `harness_callers` | Phase 2 | Inspecting exact types, spans, and caller graphs | Never use slow shell `grep` or `git blame` for type facts |
| `harness_ontology_why` & `impact` | Phase 2 | Traceability to governing ADRs and EARS requirements | Never guess whether an architectural choice was intentional |
| `harness_structural_search` | Phase 2 | AST search across workspace to cluster twins into a `class-fix` | Never fix only a single quoted line when twins exist |
| `harness_tests_reaching` | Phase 2 & 4 | Verifying reaching test cases and finding test gaps | Never assume reaching tests exist without checking graph |
| `harness_ontology_check` | Phase 3 | Advisory cross-layer semantic conflict detection | Cannot replace deterministic TypeScript compiler |
| `harness_route` (`clef-flash`) | Phase 4 | Routing to relevant `agent-patterns/*.md` recipe | **BANNED** for judging review validity or code correctness |
| `flash` Fixer Subagents | Phase 4 | Scoped edits, local LSP check, package unit tests | **BANNED** from running `harness verify`, `harness done`, or git |
| Harness Deterministic Gates (`harness-cli`) | Phase 5 | Monorepo GC, mutation check, verification, stamp creation | Never run by subagents; orchestrator only |

---

## Rationalization Table

| Excuse | Reality | Correct Action |
|---|---|---|
| "The reviewer suggested this fix, so I'll just change the code immediately." | Reviewers often hallucinate standard TS patterns (`try/catch`, `switch`) that destroy Effect invariants. | Adjudicate centrally against `references/evaluation-rubric.md` and Order of Authority before editing. |
| "I fixed the exact line the reviewer quoted, that's enough." | Line-level fixes leave twin bugs untouched across the codebase. | Run `harness_structural_search` to find all identical anti-patterns and execute a `class-fix`. |
| "The fixer subagent can run `harness verify` to check its work." | `harness verify` computes monorepo verify-stamps and mutates Omnigraph branches; subagents will corrupt state. | Subagents run package tests only (`pnpm nx run <proj>:test`). Orchestrator runs `verify`. |
| "I'll ask `clef-flash` or `harness_route` whether the reviewer is right." | LLM routers lack the authoritative context to judge code correctness. | Adjudicate using deterministic Graph MCP facts (`harness_resolve`, `harness_ontology_why`). |
| "I'll fix the code first and update the EARS spec / ADR later." | Editing code before syncing specs creates drift and triggers `stale-doc-reference` gate failures. | Synchronize specs and ADRs in Phase 3 before dispatching code fixers. |
| "All tests pass now; no need to analyze why gates missed this." | Without a compounding audit, future agents will repeat the exact same defect. | Run Compounding Gate Audit (`compounding-effect-learnings`) to strengthen AST rules and test gates. |
| "I'll let the fixer subagent decide whether the finding is valid." | Subagents lack global project context and will eagerly apply invalid suggestions. | Orchestrator decides disposition and supplies strict instructions to fixers. |

---

## Red Flags — STOP

Stop execution immediately and escalate or re-adjudicate if any of the following occur:

- Applying a reviewer suggestion without checking against `repos/effect/LLMS.md` and `agent-patterns/*.md` (e.g. accepting `try/catch`, `async/await`, `switch` on `_tag`, or unredacted secrets).
- Fixing a single instance of a reported defect without running `harness_structural_search` to identify and fix twins.
- Allowing a fixer subagent to execute `harness verify`, `harness done`, or `@modernrelay/omnigraph-mcp` write tools.
- Modifying `type:domain` or `type:infra` before updating touched `type:contract` Schemas, EARS specs, or ADRs in Phase 3.
- Using `clef-flash` or generic LLM prompts to decide if an architectural critique is valid instead of using Graph MCP facts.
- Closing a review session without asking *"Why did deterministic gates miss this?"* when a valid `Critical` or `Important` defect was fixed.
- Adding `@ts-ignore`, `oxlint-disable`, `it.skip`, or dummy variable reads (`const _ = x`) to silence gate errors.
