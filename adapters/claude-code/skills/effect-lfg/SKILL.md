---
name: effect-lfg
description: Use when the user asks for autonomous end-to-end execution of a requirement, feature, bugfix, or EARS spec through the full Effect-TS Engineering Harness without stopping between stages, or when invoking /effect-lfg directly.
argument-hint: "[requirement, bug report, EARS spec path, or PR/review reference]"
---

# Effect-LFG (Autonomous End-to-End Harness Pipeline)

## Overview

Take a single user requirement, defect report, EARS specification path, or review reference all the way to verified completion, hands-off, through the full Effect-TS Engineering Harness lifecycle. A child stage's completion immediately resumes the next numbered stage in the same turn — the run does not pause for intermediate human sign-off and does not end until `<promise>DONE</promise>` or a hard stop condition.

**Violating the letter of the rules is violating the spirit of the rules.**

---

## Autonomous Pipeline Overrides (Resolving Interactive Deadlocks)

When running under `effect-lfg`, apply these three pipeline overrides to the underlying interactive skills:

1. **No EARS Approval Pause (`specifying-ears-with-effect` override):**
   Never pause to ask clarifying questions or wait for user approval of `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`. Resolve existing contracts, services, and ADRs via in-process Graph MCP (`harness_resolve`, `harness_callers`, `harness_ontology_why`, `harness_ontology_impact`). Record any non-blocking product or technical defaults explicitly under `## Assumptions` and `## Out of scope`, verify the spec with `harness gc --strict` and `harness_ontology_check`, and advance immediately to `planning-effect-skeletons`.
2. **Closed-Loop Specialist Review Auto-Fix (`executing-effect-stubs` + `resolving-effect-review-feedback` override):**
   After `flash` implementer subagents replace `stub<A, E, R>()` skeletons, dispatch the applicable read-only specialist reviewers (`effect-ears-test-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`, `effect-adversarial-reviewer`). Adjudicate findings centrally via Graph MCP, hunt AST twins with `harness_structural_search`, and autonomously apply all valid `fix`, `class-fix`, and `doc-sync-fix` items before final gates.
3. **Stamp-Safe Compounding Learnings (`compounding-effect-learnings` override):**
   Execute `harness learn` and apply clear mechanical promotions (`triage-rule`, `guard-allowlist`, `agent-pattern`, `ast-graph-gate`, or `adr`) followed by `harness learn --clear` **before** running the final `harness gc --strict` $\rightarrow$ `harness mutate --strict` $\rightarrow$ `harness verify` $\rightarrow$ `harness done` sequence so post-verify file edits never invalidate `.harness/verify-stamp.json`.

---

## Stop Conditions (When to Halt and Escalate)

Proceed hands-off through every stage unless one of these hard stop conditions holds:

- **`[ESCALATE: STUCK LOOP DETECTED]`:** `harness verify` exits with code `2` (`LoopCircuitBreaker.decide` tripped after 3 consecutive identical failures).
- **Destructive Migration or Cloud Deploy:** A change requires `DROP TABLE`, `DROP COLUMN`, a table rebuild (`MigrationSafety.decide`), or `alchemy deploy` / `alchemy destroy`.
- **Contradictory Settled ADR:** The request directly violates an `accepted` ADR (`<scope>:ADR-NNNN`) or is logically contradictory with no safe assumption.
- **Unrecoverable Gate Failure:** Final deterministic gates (`gc --strict`, `mutate --strict`, `verify`, `done`) remain red after bounded autonomous triage and repair.

A stop leaves nothing pushed that was not already pushed and reports the exact blocker and recovery path.

---

## The Autonomous Run (Stages 0–6)

Read [references/autonomous-intake-and-ears.md](references/autonomous-intake-and-ears.md) before starting Stages 0–1, and read [references/review-and-shipping.md](references/review-and-shipping.md) before starting Stages 4–6.

```text
Stage 0: Worktree & Session Readiness
  ↓
Stage 1: Route Intake & Autonomous EARS Specification (specifying-ears-with-effect)
  ↓
Stage 2: Plan-as-Code Skeletons, plan-check & ADR Sync (planning-effect-skeletons)
  ↓
Stage 3: Package-Isolated flash Implementation & Trace/Prop Tests (executing-effect-stubs)
  ↓
Stage 4: 4-Lens Specialist Review & Autonomous Class-Fix Loop (resolving-effect-review-feedback)
  ↓
Stage 5: Compounding Learnings & Final Deterministic Gate Sequence (verify -> done)
  ↓
Stage 6: Git Commit, Optional Push/PR & <promise>DONE</promise>
```

### Stage 0 — Worktree & Session Readiness
1. Check workspace isolation (`git rev-parse --absolute-git-dir` vs `git rev-parse --git-common-dir` or `HARNESS_WORKTREE_ID`). If already inside a linked worktree (`.harness/worktrees/*`), work in place and never nest a second worktree. If in the primary checkout and the user requested a new worktree (or unrelated dirty files exist), create `.harness/worktrees/feat-<slug>` and execute all subsequent commands in that worktree root (never run `cd` in shell commands, which is blocked by `harness guard`).
2. Run `harness session` (or inspect `SessionStart` / `PreInvocation` output) to see active stubs, branch state, and environment readiness.

### Stage 1 — Route Intake & Autonomous EARS Specification
**REQUIRED SUB-SKILL:** Use `specifying-ears-with-effect` in autonomous pipeline mode per [references/autonomous-intake-and-ears.md](references/autonomous-intake-and-ears.md):
- **Route A (Existing EARS Spec Path):** If the input names an existing spec in `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (or `docs/specs/`), validate it and jump to Stage 2.
- **Route B (External PR / Review Feedback):** If the input is a PR number/URL or pasted review feedback, execute `resolving-effect-review-feedback` end-to-end, then jump to Stage 5.
- **Route C (Requirement / Feature / Defect):** Inspect the graph (`harness_resolve`, `harness_callers`, `harness_ontology_why`, `harness_ontology_impact`), determine archetype (`application` vs `framework`), author `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (`status: proposed`) with explicit `## Assumptions`, run the 3-role self-review, verify with `harness gc --strict` and `harness_ontology_check`, and continue immediately to Stage 2.

### Stage 2 — Plan-as-Code Skeletons, `plan-check` & ADR Governance
**REQUIRED SUB-SKILL:** Use `planning-effect-skeletons`:
1. Call `harness_route` for each non-trivial capability and read the matched `agent-patterns/*.md` recipe.
2. Define boundary Schemas and `Schema.TaggedError` classes in `type:contract`, `Context.Service` ports in `type:service`, and `stub<A, E, R>(...args)` skeletons in `type:domain` / `type:core` / `type:infra` (keeping `*.decide` strictly pure with `R = never`).
3. Run the deterministic plan gate:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check
   ```
4. Append the verified Mermaid topology diagram printed by `plan-check` into `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` under `## 4. Verified Plan Topology Graph`, apply the Pre-Implementation Adversarial Plan Lens, and author/update `libs/<scope>/docs/adr/NNNN-<slug>.md` when the Counterfactual Eligibility Rule holds.
5. Verify governance docs with `harness gc --strict` and `harness_ontology_check`.

### Stage 3 — Package-Isolated `flash` Implementation & Tests
**REQUIRED SUB-SKILL:** Use `executing-effect-stubs`:
1. Partition implementation by Nx package boundaries (`type:domain` / `type:core`, `type:infra`, `scope:web`).
2. When 2+ downstream packages have stubs, dispatch parallel `flash` implementer subagents (`HARNESS_WORKTREE_ID=<unit>` or `Workspace: "share"`) with the 4-part prompt (Target Stubs, EARS Clauses, Pattern Reference, Package Gate `CI=true pnpm nx run <project>:verify`). When only a single downstream package has stubs, the controller may implement it inline under the same package gate.
3. Ensure every EARS clause is verified by `@effect/vitest` (`it.effect` + `runWithTestTracer` + `checkSpanBudgets`), negative tests assert exact error instances via `Cause.findErrorOption(exit.cause)`, and every pure `*.decide` / reducer has `it.effect.prop` / `it.prop` property-based tests over `Schema.Array(EventUnionSchema)`.

### Stage 4 — 4-Lens Specialist Review & Autonomous Fix Loop
**REQUIRED SUB-SKILL:** Use `resolving-effect-review-feedback` per [references/review-and-shipping.md](references/review-and-shipping.md):
1. Dispatch parallel read-only `flash` specialist reviewers based on touched signals:
   - `effect-ears-test-reviewer` (Always)
   - `effect-security-reviewer` (Contracts, `HttpApi`, `Rpc`, auth, SQL, `Config`)
   - `effect-reliability-reviewer` (`type:infra`, DO SQLite, D1, Queues, `Schedule`, `Scope`)
   - `effect-adversarial-reviewer` (Deciders, Event Sourcing, stateful or multi-step flows)
2. Centrally adjudicate findings via Graph MCP (`harness_resolve`, `harness_ontology_why`, `harness_structural_search`, `harness_tests_reaching`).
3. Synchronize specs/ADRs first if needed, apply all valid `fix`, `class-fix`, and `doc-sync-fix` items, and record any non-blocking declined/residual items for the closeout report.

### Stage 5 — Compounding Learnings & Final Deterministic Gate Sequence
**REQUIRED SUB-SKILL:** Use `compounding-effect-learnings` followed by final gates per [references/review-and-shipping.md](references/review-and-shipping.md):
1. Update the EARS specification frontmatter from `status: proposed` to `status: accepted`.
2. Run `harness learn` (`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn`). If recurring friction clusters (`route_miss`, `verify_failure`, `guard_escalation`) or review gate escapes exist, promote them into `agent-patterns/*.md`, `DETERMINISTIC_TRIAGE_RULES`, `ALLOWLIST`, AST/graph gates, or an ADR, then run `harness learn --clear`. If zero friction clusters exist, proceed directly to step 3.
3. Run the **Final Deterministic Gate Sequence** (max 3 repair attempts per gate before escalating) after all file edits are complete:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ontology check --strict
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts mutate --strict
   CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
   CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done
   ```
   **CRITICAL:** Never edit any tracked file after `harness verify` + `harness done`, or `.harness/verify-stamp.json` will become stale and block session completion.

### Stage 6 — Git Commit, Optional Push/PR & Closeout
Follow [references/review-and-shipping.md](references/review-and-shipping.md) to close out:
1. Stage only the files created or modified by this run (never `git add -A` over unrelated pre-existing dirty files; never stage `.harness/`) and create a conventional commit referencing `<scope>:SPEC-NNNN`.
2. Check `git remote` and user intent:
   - **Local-only or no remote configured:** Leave the verified commit on the branch.
   - **Remote configured and PR shipping appropriate/requested:** Push the branch (`git push -u origin HEAD`) and open/update the PR (`gh pr create` or `ce-commit-push-pr mode:pipeline`) carrying the EARS Spec summary, Verified Mermaid Topology, `## Assumptions`, and `## Residual Review Findings`. If push or PR creation fails due to credentials/network, keep the verified local commit, note the push error in the closeout report, and finish cleanly.
3. Output the structured closeout summary followed by `<promise>DONE</promise>`.

---

## Quick Reference Matrix

| Stage | Sub-Skill | Key MCP Tools & CLI Gates | Exit Artifact / State |
| :--- | :--- | :--- | :--- |
| **0. Readiness** | `effect-harness` | `harness session`, `git worktree` | Isolated clean branch & session state |
| **1. EARS Spec** | `specifying-ears-with-effect` | `harness_resolve`, `harness_ontology_why`, `harness gc --strict`, `harness_ontology_check` | `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (`status: proposed` + `## Assumptions`) |
| **2. Skeleton** | `planning-effect-skeletons` | `harness_route`, `harness_lsp_diagnostics`, `harness plan-check` | Compilable `stub<A,E,R>()` graph, `.harness/plan-graph-snapshot.json`, Mermaid in spec, ADR |
| **3. Implement** | `executing-effect-stubs` | Subagents (`flash`), `harness_lsp_diagnostics`, `pnpm nx run <proj>:verify` | Zero active `stub()` calls, `@effect/vitest` trace + property tests |
| **4. Review** | `resolving-effect-review-feedback` | 4 specialist reviewers, `harness_structural_search`, `harness_tests_reaching` | All valid `fix` / `class-fix` / `doc-sync-fix` items applied |
| **5. Final Gates** | `compounding-effect-learnings` | `harness learn`, `gc --strict`, `ontology check --strict`, `mutate --strict`, `verify`, `done` | Spec `status: accepted`, fresh `.harness/verify-stamp.json`, Omnigraph merged to `main` |
| **6. Ship** | `effect-lfg` | `git commit`, `git remote`, `gh pr create` | Clean commit (and open PR when applicable) + `<promise>DONE</promise>` |

---

## Rationalization Table

| Excuse | Reality |
| :--- | :--- |
| "I must stop after drafting the EARS spec and wait for the user to approve it." | In `effect-lfg` autonomous mode, stopping for EARS approval deadlocks the pipeline. Record non-blocking defaults in `## Assumptions`, verify with `gc --strict` and `harness_ontology_check`, and proceed immediately to `planning-effect-skeletons`. |
| "The user said 'just ship it', so I'll skip the EARS spec and `stub<A, E, R>()` `plan-check`." | Skipping EARS or `plan-check` omits `.harness/plan-graph-snapshot.json` and `SpecifiesSymbol` edges, causing deterministic failures in `harness gc --strict` and `harness done`. Autonomous means hands-off, never gate-free. |
| "The change is small, so I don't need the 4 specialist review subagents." | Autonomous runs have no human eyes before completion. Specialist `flash` reviewers (`effect-ears-test-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`, `effect-adversarial-reviewer`) catch vacuous tests, IDOR, sync DO violations, and race conditions before `verify`. |
| "I'll run `harness learn` or tweak a markdown file after `harness verify` and `harness done`." | `.harness/verify-stamp.json` hashes the entire working tree via SHA-256. Any tracked file edit after `harness verify` invalidates the stamp and causes the `Stop` hook to block completion. Always run `learn` and finalize all docs *before* the final `verify` $\rightarrow$ `done` sequence. |
| "I'll stop and ask the user whether to promote friction clusters in `harness learn`." | In `effect-lfg`, pausing on `harness learn` stalls an unattended run. Autonomously apply clear mechanical promotions (or record deferred architectural questions in the closeout report) and run `harness learn --clear` before final `verify`. |
| "Vitest passed, so I can commit and output `<promise>DONE</promise>` without `harness verify` and `harness done`." | Only `harness verify` + `harness done` enforce zero leftover `stub()` calls, check `SpanBudget.decide`, write `.harness/verify-stamp.json`, and merge the Omnigraph `impl/*` branch into `main`. |

---

## Red Flags — STOP

- Stopping after Stage 1 (`specifying-ears-with-effect`) to ask the user to approve the EARS specification instead of recording `## Assumptions` and continuing to Stage 2
- Skipping `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`, `stub<A, E, R>()` skeletons, or `harness plan-check` in the name of speed
- Invoking generic Markdown planning skills (`ce-plan`, `ce-work`) that bypass `stub<A, E, R>()`, `harness plan-check`, and `.harness/verify-stamp.json`
- Skipping the parallel specialist review lenses (`effect-ears-test-reviewer`, etc.) or ignoring valid P0/P1 findings they report
- Editing any tracked file (specs, ADRs, comments, pattern docs, or code) *after* `CI=true harness verify` and `CI=true harness done` without re-running `verify` and `done`
- Running `git add -A` when unrelated pre-existing dirty files exist in the checkout
- Outputting `<promise>DONE</promise>` without a fresh, valid `.harness/verify-stamp.json` and a passing `harness done`
