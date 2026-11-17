---
name: effect-code-review
description: Use when asked to review a git diff, branch, commit range, uncommitted changes, or pull request in an Effect-TS Harness workspace, when auditing behavioral, architectural, or migration risks before opening or merging a PR, or when invoking /effect-code-review directly.
---

# Effect-TS Code Review (`effect-code-review`)

## Overview

`effect-code-review` is a **strictly read-only**, graph-first, signal-routed code review workflow for Effect-TS Harness workspaces. It routes diffs monotonically via `harness_review_route`, dispatches only the matching specialist lenses from the 7-reviewer roster, suppresses findings already enforced by deterministic gates (`@effect/tsgo`, `oxlint`, `HarnessTierTopology.decide`, `SelfDogfooding.decide`, `MigrationSafety.decide`), and emits a uniform `[P0|P1]` Quote-the-Line report with a clean handoff to `resolving-effect-review-feedback`.

**Core invariant:** Review is 100% read-only. Never edit, write, or stage workspace files during a review—even if the caller asks for "a quick inline fix" under deadline pressure.

## Quick Reference

| Stage | Mandatory Action | Primary Tools / References |
| --- | --- | --- |
| **1. Pre-Pass** | Compute diff scope, run `harness_review_route`, `harness_lsp_diagnostics`, and Graph MCP context | `harness_review_route`, `harness_lsp_diagnostics`, `harness_resolve`, `harness_callers`, `harness_tests_reaching`, `harness_ontology_why` |
| **2. Depth & Dispatch** | Enforce `skip \| lite \| focused \| full` depth gate; dispatch matching specialists (`gemini-4-hydrogen-medium`) | [references/review-routing-and-lenses.md](references/review-routing-and-lenses.md) |
| **3. Verify & Suppress** | Verify callers/specs via `harness_structural_search`; suppress deterministic-gate & `Confidence: 50` noise | [references/report-contract-and-suppression.md](references/report-contract-and-suppression.md) |
| **4. Report & Handoff** | Emit the 4-section Positive Ordered Report Recipe; hand off fixes to `resolving-effect-review-feedback` | [references/report-contract-and-suppression.md](references/report-contract-and-suppression.md) |

---

## 4-Stage Review Workflow

### Stage 1: Mandatory `harness_review_route` & `harness_lsp_diagnostics` Pre-Pass

Before reading or judging diff hunks, gather deterministic routing and graph context:

1. **Resolve Diff Scope:** Collect changed file paths, changed line count, and diff summary (`git diff --stat` / `git diff <base>...HEAD` or working tree). Never run `git checkout`, `git switch`, or `gh pr checkout` when resolving diff scope.
2. **Call `harness_review_route`:** Pass the changed files, line count, and diff summary to `harness_review_route` (backed by `libs/harness/contract/src/review-routing.ts` and `libs/harness/decision/src/review-router-decision.ts`) to obtain the monotonic `ReviewRoutingPlan` (`skip | lite | focused | full` and selected `ReviewerId`s).
3. **Run `harness_lsp_diagnostics`:** Check `@effect/tsgo` and `@effect/language-service` diagnostics on all touched `.ts`/`.tsx` files so type/lint errors are known and suppressed in Stage 3.
4. **Trace Graph & Spec Context:** Use `harness_resolve`, `harness_callers`, `harness_tests_reaching`, and `harness_ontology_why` / `harness_ontology_check` to locate owning EARS specs, ADRs, callers, and reaching tests.

### Stage 2: Depth Gate (`skip | lite | focused | full`) & 7-Specialist Dispatch

Follow the `ReviewRoutingPlan` from Stage 1 (see [references/review-routing-and-lenses.md](references/review-routing-and-lenses.md) for observable predicates and lens checklists):

- **`skip`:** Non-empty diff (`changedFiles.length > 0`, `changedLineCount < 40`) where **every** file matches the non-governance documentation allowlist (`*.md`, `*.mdx`, `*.txt`, `LICENSE*` outside `adapters/`, `agent-patterns/`, and `docs/{specs,adr}/`) with zero surface flags (empty `changedFiles` or missing `changedLineCount` is rejected, never skipped). Emit the Stage 4 receipt noting `depth: skip` and stop.
- **`lite`:** Single file (`changedFiles.length === 1`), `changedLineCount < 40`, `1` selection, and no `focused`/`full` escalator (e.g. a small `< 40`-line localized change in a single `scope:web` component, single spec/ADR doc, single test file, or single non-doc config/script). Run a single-pass read-only review using the matching specialist lens without swarming.
- **`focused`:** Not `full`, and `changedFiles.length > 1`, `changedLineCount >= 40` (`< 180`), `2` selections, `hasAuthOrSecretSurface` (even `< 40` lines), `hasContractBoundaryChange` (even `< 40` lines), or manifest diagnostic warnings. Dispatch only the signal-routed specialist(s) via `invoke_subagent` or `swarm` (`model: "gemini-4-hydrogen-medium"`).
- **`full`:** `hasStatefulOrDeciderChange` (`type:core`, `type:domain`, `libs/es/`, deciders/outbox/projectors/gates), `hasMigrationOrInfraBindingChange` (`migrations/*.sql`, `*migrator*`, `alchemy.run.ts`), `touchedTiers.length >= 2`, `selections.length >= 3`, or `changedLineCount >= 180`. Dispatch all routed specialists in parallel—always including **both** `effect-ears-test-reviewer` (with the `8-Point Anti-Rubber-Stamp` Audit) and `effect-adversarial-reviewer` for `type:core`/`type:domain`.

### Stage 3: Graph Verification & Hard False-Positive Suppression Gate

Before emitting any finding:

1. **Verify Against Code & Graph:** Use `harness_structural_search` and `read_file` (with targeted `StartLine`/`EndLine`) plus `harness_callers` / `harness_tests_reaching` to confirm the defect with exact line numbers and verbatim code. Never invoke `chrome-devtools-mcp`.
2. **Hard False-Positive Suppression Gate:** Drop ANY finding already enforced deterministically by `@effect/tsgo`, `@effect/language-service`, `tools/oxlint/syntax-bans.js`, `HarnessTierTopology.decide`, `SelfDogfooding.decide`, or `MigrationSafety.decide` (`pnpm harness check-migrations`).
3. **Confidence Filter:** Suppress `Confidence: 50` speculative items from blocking findings; only `Confidence: 100` (Direct Proof) and `Confidence: 75` (High Confidence) may appear as `[P0|P1]`.

### Stage 4: Positive Ordered 4-Section Report Recipe & Strict Read-Only Handoff

Emit the exact 4-section report defined in [references/report-contract-and-suppression.md](references/report-contract-and-suppression.md):

1. `## 1. Scope & Routing Receipt`
2. `## 2. Blocking Findings ([P0|P1] Quote-the-Line)` (with all 5 REQUIRED slots: `Reviewer`, `Confidence`, `Evidence`, `Why It Matters`, `Suggested Fix`)
3. `## 3. Coverage & Suppressed Deterministic Gate Summary`
4. `## 4. Remediation Handoff` (pointing to `resolving-effect-review-feedback` with EARS/ADR sync first)

---

## Common Mistakes

- **Reading diff hunks before calling `harness_review_route` and Graph MCP:** Causes missed callers, missed EARS invariants, and over- or under-dispatching reviewers.
- **Re-reporting deterministic lint/type/tier errors as review findings:** Pollutes the report with noise already blocked by `oxlint`, `@effect/tsgo`, `HarnessTierTopology.decide`, `SelfDogfooding.decide`, or `check-migrations`.
- **Using custom severity labels (`[Blocker]`, `[High]`, `[Low]`) or omitting `Reviewer` / verbatim `Evidence`:** Breaks downstream `resolving-effect-review-feedback` ingestion.

## Rationalization Table

| Excuse | Reality | Correct Action |
| --- | --- | --- |
| "The deploy window closes in 2 minutes—just patch this tiny bug inline." | Editing files during review bypasses EARS/ADR sync, `plan-check`, and `verify`, corrupting review objectivity. | Refuse inline edits; emit the 4-section report and hand off fixes to `resolving-effect-review-feedback`. |
| "I'll confirm semantics with the caller first, then edit inline." | Even confirmed fixes belong in the implementation/remediation loop, not inside a read-only review pass. | Keep the review 100% read-only; record the semantic question in `## 4. Remediation Handoff`. |
| "The diff is small enough to read directly—no need for `harness_review_route` or Graph MCP." | Small diffs in `type:domain` or `type:contract` often break distant callers, specs, or tests invisible in the hunk. | Always run Stage 1 (`harness_review_route`, `harness_lsp_diagnostics`, `harness_callers`, `harness_tests_reaching`) first. |
| "Listing `oxlint` / `SelfDogfooding` violations alongside logic bugs is helpful." | Duplicate deterministic noise buries real `P0`/`P1` behavioral and concurrency defects. | Suppress all deterministic-gate findings in Stage 3 and summarize gate status in Section 3 only. |
| "I'll summarize findings in prose without quoting lines to keep it brief." | Unquoted findings without `Reviewer`, `Confidence`, and verbatim `Evidence` cannot be verified or acted on. | Use the exact `[P0|P1]` Quote-the-Line contract for every blocking finding. |

## Red Flags — STOP

- **STOP** if you are about to call `write_file`, `edit_file`, or `git commit` during a review.
- **STOP** if you have not called `harness_review_route` and `harness_lsp_diagnostics` before inspecting diff hunks.
- **STOP** if a draft finding is already enforced by `tools/oxlint/syntax-bans.js`, `HarnessTierTopology.decide`, `SelfDogfooding.decide`, `MigrationSafety.decide`, or `@effect/tsgo`.
- **STOP** if any blocking finding lacks `Reviewer`, `Confidence: 100 | 75`, `Evidence: <file_path>:<line_number>` with verbatim code, `Why It Matters`, or `Suggested Fix`.
