---
name: resolving-effect-review-feedback
description: Use when addressing code review feedback pasted as text (from Grok, Codex, or human reviewers) or left on a GitHub PR in an Effect-TS Harness project, or when review findings expose silent test failures, spec-to-code drift, fail-open fallbacks, or gate blind spots.
---

# Resolving Effect Review Feedback (Central Adjudication & Subagent Fix Loop)

## Overview

This skill governs central adjudication and parallel subagent execution for code review feedback in an Effect-TS Engineering Harness workspace:

- The **Orchestrator** inventories every sub-bullet and `Suggestion` clause 1-to-1, adjudicates centrally via **Order of Authority** and **in-process Graph MCP (`harness-mcp`)**, exposes fail-open bugs masked by passing tests, synchronizes semantic contracts first, dispatches isolated fixers, runs post-edit metric syncs and monorepo gates, and promotes blind spots into deterministic gates.
- Lightweight **Fixer Subagents** operate as disjoint execution hands returning a 1-to-1 **`Sub-Bullet Verification Matrix`**. They never adjudicate, never merge assigned sub-IDs, and never run monorepo gates.

**Violating the letter of the rules is violating the spirit of the rules.**

---

## 5-Phase Resolution Recipe

```text
Phase 1: Inventory & Atomic Decomposition (1 Sub-Claim = 1 Row + Checksum)
         ↓
Phase 2: Central Adjudication, Fail-Open Audit & Pre-Enumeration (Orchestrator Only)
         ↓
Phase 3: Semantic Contract, EARS, ADR & Prose Sync (NO wc -l / Metric Sync)
         ↓
Phase 4: Disjoint Fixer Dispatch & Hardened 1-to-1 Diff/Test Acceptance Gate
         ↓
Phase 5: Merge → Step 0 Metric/LOC Matrix → Deterministic Gates → Compounding Promotion
```

---

### Phase 1 — Ingest & Atomic Sub-Bullet Normalization (`1 Sub-Claim = 1 Row`)

Accept feedback from:
1. **Pasted Review Markdown** (`Critical`, `Important`, `Suggestions`, `Nitpicks`, or bulleted lists).
2. **GitHub PR Comments & Inline Threads:** Run both `gh pr view <number> --comments` AND `gh api repos/{owner}/{repo}/pulls/{number}/comments`.

Decompose **EVERY single discrete claim** BEFORE evaluating Out-of-Scope rules — **never group multiple sub-bullets, functions, or clauses into one ID**:

- **Atomic IDs:** `F-<item>.<sub_bullet>` (`Critical`/`Important`) and `S-<item>.<sub_bullet>` (`Suggestions`/`Nitpicks`/inline nits). If one sub-bullet spans multiple files in disjoint fixer units, split further (`F-10.1a`, `F-10.1b`). Split mixed doc findings into semantic (`Assigned Unit: orchestrator-phase3`) vs numeric/LOC (`Assigned Unit: orchestrator-phase5`).
- **Source Anchor:** Required on every row (`Crit-1.a`, `Imp-10.b`, `Sug-3.a`, `PR-Thread-12345.1`).
- **Out-of-Scope Predicate (Observable Only — Zero Nuance Clauses):** An inventoried sub-claim may be moved to the `Out-of-Scope Rejection Table` (`out-of-scope`) ONLY IF **BOTH** hold:
  1. It requests a brand-new product feature absent from the active EARS spec (`REQ-*`); **AND**
  2. It does **NOT** identify a reliability defect, security boundary gap, resource/listener/stack cleanup leak, error-propagation or error-logging/telemetry loss, fail-open fallback, CLI/MCP input-validation or exit-code defect, documentation/metric parity error, or test-fidelity gap in any workspace file referenced by the PR, its callers, or its package.

Any `Suggestion` or `Nitpick` touching reliability, security, error propagation, error logging, exit codes, fail-open fallbacks, lifecycle cleanup, input validation, documentation parity, or test coverage MUST remain in the Adjudication Ledger as `S-n.k`.

---

### Phase 2 — Central Adjudication & Fail-Open Audit (Orchestrator Only)

> [!IMPORTANT]
> Never blindly apply reviewer suggestions or delegate judgment to fixer subagents or `clef-flash`. Evaluate every row against [references/evaluation-rubric.md](references/evaluation-rubric.md).

For each `F-n.k` / `S-n.k`, gather deterministic facts via Graph MCP:

1. **Signature & Callers (`harness_resolve`, `harness_callers`):** Inspect `Effect<A, E, R>`, callers, and error channel `E`.
2. **Fail-Open Test Audit (`harness_ontology_why`, `harness_tests_reaching`):**
   - If a test asserts a fail-open fallback (`[]`, `Graph.empty`, swallowed catch, `exitCode: 0` on invalid input), verify whether a **verbatim accepted `<scope>:ADR-NNNN` or EARS `IF/THEN` (`REQ-*`) clause** names **both the exact error condition AND exact fallback value** (JSDoc, READMEs, RFC prose, and draft docs do NOT count).
   - **No Explicit Clause = Bug (`BUGGY_TEST_FLIP`):** Assign `fix` / `class-fix` to fail closed with a typed `Schema.TaggedError` / nonzero exit and flip the test. **NEVER** classify undocumented fallbacks as `doc-sync-fix`, edit Phase 3 specs to authorize them retroactively, or escape via `escalate-to-human`.
3. **AST Twin & Module-Wide Lifecycle Pre-Enumeration (`harness_structural_search`, `harness_callers`):**
   - Cluster twin defects into `class-fix`.
   - Whenever a finding touches `txStack`, state collections, workers, sockets, timers, or listeners, pre-enumerate **every** mutation/cleanup site (`push`, `pop`, `shift`, `splice`, `clear`, `Ref.update`, `on`, `once`, `off`, `removeListener`, `removeAllListeners`, `kill`, `terminate`, `close`, `onExit`, `acquireUseRelease`) **across the entire owning module, class, service, and caller/callee chain** for Section 2 of the fixer prompt.
4. **Adversarial Specialist Consultation:** Follow `executing-effect-stubs` (`references/dispatch-reviewers.md`) across `git diff <base>...HEAD` plus uncommitted changes:
   - Core/domain/ES or harness gates (`libs/harness/**`, `tools/oxlint/**`): MUST dispatch **both** `effect-ears-test-reviewer` AND `effect-adversarial-reviewer`.
   - Stateful stacks, workers, sockets, timers, listeners, or concurrency: MUST dispatch `effect-reliability-reviewer`. Trust boundaries: MUST dispatch `effect-security-reviewer`.
5. **`decline-with-evidence` Predicate:** Permitted ONLY when citing a verbatim rule in `LLMS.md`, `agent-patterns/*.md`, an accepted `ADR-NNNN`, an explicit EARS `REQ-*`, or a **factual premise error** proven by TS/Graph MCP (e.g., symbol already has that parameter). Existing `E = never` caller signatures from swallowed errors or passing fallback tests NEVER justify declining a fix.

**Publish Before Phase 3:** Emit all three structures defined in [references/evaluation-rubric.md](references/evaluation-rubric.md) §5: `Phase 1 Checksum`, `Review Feedback Adjudication Ledger`, and `Out-of-Scope Rejection Table`.

---

### Phase 3 — Semantic Contract, EARS, ADR & Prose Sync (Orchestrator Only)

If any `fix`, `class-fix`, or semantic/prose `doc-sync-fix` (`orchestrator-phase3`) touches `type:contract`, `type:service`, exported signatures, specs, ADRs, RFC prose, or `agent-patterns/*.md`, update semantics **first**:

1. Update EARS clauses, ADR text/frontmatter, or RFC/README prose (never downgrading fail-closed invariants).
2. Run `harness_ontology_check` and `harness_lsp_diagnostics` on touched files.
3. Run `plan-check` if signatures, tags, or tracked files changed:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check
   ```

> [!CAUTION]
> **NO `wc -l` OR METRIC SYNC IN PHASE 2 OR PHASE 3:** Do NOT run `wc -l` on code files for doc-sync purposes or edit LOC/test-count tables before Phase 4 finishes. Pre-edit numbers go stale immediately and must not be cached. Handle ALL numeric/LOC sync strictly in Phase 5 Step 0 (`orchestrator-phase5`).

---

### Phase 4 — Disjoint Fixer Dispatch & Hardened Acceptance Gate

Partition `fix` and `class-fix` `Atomic IDs` by disjoint file ownership.

1. **Pattern Route:** Call `harness_route` (or use the mapped `Sanctioned Pattern` in [references/evaluation-rubric.md](references/evaluation-rubric.md) §3 if `patternFile: null`).
2. **Dispatch Fixers:** Dispatch parallel fixers via `invoke_subagent` (`TypeName: "self"`, `Workspace: "share"`, `Model: "gemini-4-hydrogen-medium"` when supported, else `"flash"` / `"inherit"`) or `swarm` (`action: "add"`, `model: "gemini-4-hydrogen-medium"`, `workspace: "inherit"` with `HARNESS_WORKTREE_ID=<unit>`) using [references/effect-fixer-prompt.md](references/effect-fixer-prompt.md). Supply every `Atomic ID` row and all pre-enumerated module-wide lifecycle sites.
3. **Subagent Discipline:** Fixers run `harness_lsp_diagnostics` and `CI=true pnpm nx run <project>:test`, NEVER touch whole-workspace gates (`verify`, `done`, `gc`, `mutate`, `plan-check`) or git, and return the 1-to-1 `Sub-Bullet Verification Matrix`.
4. **Orchestrator Acceptance Gate (Mandatory Before Merging/Proceeding):**
   Verify every assigned `Atomic ID` appears as its own row with `Status: FIXED` AND:
   - Inspect `git diff` / `read_file` at each `File:Line Changed` to verify the fix actually landed (reject `"already handled"`, `"N/A"`, `"deferred"`, or `"partial"`).
   - Confirm each row names a distinct, newly added/updated assertion in `Reaching Test File & Exact Test Name` (reject duplicated test names across distinct claims unless verified to test all sub-claims).
   - For `class-fix` or state-stack/worker items, verify `State-Stack / Twin / Caller Checks Performed` lists concrete module-wide `file:line` inspections and nested/interrupt/listener invariants.
   - On failure: re-invoke or `send_message` to complete before killing any swarm worker (`swarm action: "kill"`).

---

### Phase 5 — Metric Sync, Deterministic Gates & Compounding Promotion (Orchestrator Only)

#### Step 0 — Post-Edit Documentation & Numeric/LOC Sync (Mandatory Before Step 1)

1. Merge all Phase 4 worktree branches into the task worktree first.
2. List every file modified in Phase 4, search **all** `docs/**`, `libs/*/docs/**`, `apps/*/docs/**`, and `README.md` files (even untouched docs) for references to those paths or LOC/test-count tables, and run fresh `wc -l` (plus targeted vitest counts if cited) on every referenced file.
3. Update all stale numeric/LOC tables and close all `orchestrator-phase5` (`PHASE_5_STEP_0_WC_L`) rows.
4. Publish a **`Phase 5 Metric Sync Matrix`**:
   `| Atomic ID / Doc Ref | Target Code/Test File | Fresh Post-Phase-4 wc -l / Count | Updated Doc File:Line |`
5. If Phase 4 added/moved exported symbols, run `plan-check` to refresh `.harness/plan-graph-snapshot.json`.

#### Step 1 — Deterministic Verification Sequence

Run in exact order (`WaitMsBeforeAsync: 10000` for long runs):

```bash
node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ontology check --strict
node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts mutate --strict
CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done
```

If `verify` exits with code `2` (`[ESCALATE: STUCK LOOP DETECTED]`), stop immediately and escalate to the user.

#### Step 2 — Compounding Gate Audit & Adversarial Evasion Matrix (`compounding-effect-learnings`)

For every valid `Critical`, `Important`, or `Suggestion` fixed:
- Ask: _"Why did our deterministic gates allow this defect class, fail-open fallback, or silent omission to pass?"_
- Promote durable checks into `tools/oxlint/syntax-bans.js`, `libs/harness/gates/src/**`, `libs/harness/graph/src/**`, or `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn`.
- Whenever modifying gate files, write unit tests for adversarial evasion vectors (shell wrappers/subshells, multi-aggregate files, self-comparisons, `satisfies`/parenthesized casts, mixed causes) and run `effect-adversarial-reviewer` against the gate implementation.

---

## Rationalization Table

| Excuse | Reality | Correct Action |
| :--- | :--- | :--- |
| "Item #10 has 4 sub-bullets; I'll group them as `F-10`." | Grouping lets fixers patch bullet `a` and drop `b`, `c`, `d`. | Split every sub-bullet into `F-10.1`..`F-10.4` (`F-10.1a/b` across units) with `Source Anchor`. |
| "It's in `Suggestions`/`Nitpicks` or an unchanged file; skip the ledger." | Critical cleanup/exit-code/logging bugs hide under `Suggestions`. | Inventory ALL claims in Phase 1; exclude only if BOTH observable conditions pass in `Out-of-Scope Rejection Table`. |
| "A test asserts `return []`, so that fallback is an approved contract." | Tests alongside buggy code enshrine bugs; `E = never` callers are downstream symptoms. | Require verbatim accepted `ADR-NNNN`/`REQ-*` naming error + return value; otherwise `BUGGY_TEST_FLIP` -> fail closed + flip test. |
| "Spec is silent, so I'll update EARS/RFC in Phase 3 to permit fallback." | Retroactive doc edits erase safety invariants. | Never use `doc-sync-fix` to authorize undocumented fallbacks. |
| "I updated `Appendix A` line counts in Phase 3." | Phase 4 edits shift line counts immediately. | Ban `wc -l` in Phase 2/3; update all referenced docs in Phase 5 Step 0 after merging. |
| "I fixed `txStack` in `safeRollback()`, so cleanup is done." | Sibling callers (`runTransaction`, `commit`, `savepoint`) double-pop or leak. | Inspect every mutation/cleanup site across the entire owning module + callers/callees and add nested + interrupt tests. |
| "The fixer checked off all rows; no need to inspect the diff." | Fixers mark sub-bullets `"Already handled"` or reuse one test name. | Inspect `git diff`/`read_file` for each `File:Line Changed` and verify distinct assertions per `Atomic ID`. |

---

## Red Flags — STOP

Stop immediately, revert any uncommitted partial edits made outside adjudicated Phase 4 units (`git checkout -- <files>`), and re-adjudicate if any occur:

- Any multi-bullet finding merged into a single `F-n` / `S-n` row, or any omission from `Phase 1 Checksum`.
- Declining a fail-open bug via existing code, passing tests, JSDoc/RFC prose, or `E = never` caller types without an explicit accepted `ADR-NNNN` / `REQ-*`.
- Running `wc -l` for doc sync or editing LOC tables during Phase 2/3, or entering Phase 5 Step 1 without `Phase 5 Metric Sync Matrix`.
- Accepting a fixer report with missing/`DEFERRED` rows, uninspected diffs, or missing module-wide `txStack`/worker/listener audits.
- Running `verify`/`done` inside a subagent, using `clef-flash` to adjudicate, skipping twin search, or adding `@ts-ignore` / `oxlint-disable` / `it.skip` / `const _ = x`.
