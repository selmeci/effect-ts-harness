# Autonomous 4-Lens Review, Stamp-Safe Gates & Shipping (Stages 4–6)

This reference governs **Stage 4 (4-Lens Specialist Review & Autonomous Fix Loop)**, **Stage 5 (Compounding Learnings & Final Deterministic Gate Sequence)**, and **Stage 6 (Git Commit, Optional Push/PR & Closeout)** of `effect-lfg`.

---

## 1. Stage 4 — 4-Lens Specialist Review & Autonomous Fix Loop

Once package-isolated `flash` implementer subagents have replaced all `stub<A, E, R>()` calls and passed package-level verification (`CI=true pnpm nx run <project>:verify`):

### Step 4.1 — Dispatch Parallel Specialist Review Lenses
Select and invoke the read-only specialist review subagents (`Model: "flash"`, `Workspace: "share"`) matching the touched packages and capabilities:

1. **`effect-ears-test-reviewer` (Always):**
   Verifies 1:1 behavioral coverage between every EARS clause (`WHEN`, `IF/THEN`, `WHILE`, `WHERE`) in `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` and `@effect/vitest` assertions (`it.effect`, `it.effect.prop`, `Cause.findErrorOption`, `Equal.equals`, `checkSpanBudgets`).
2. **`effect-security-reviewer` (When touching `type:contract`, `HttpApi`, `Rpc`, auth, SQL, or `Config`):**
   Audits boundary `Schema` constraints, actor/tenant authorization (IDOR) in `type:domain`, parameterized SQL in `type:infra`, and `Config.redacted` secret handling.
3. **`effect-reliability-reviewer` (When touching `type:infra`, DO SQLite, D1, Queues, `Schedule`, or `Scope`):**
   Audits synchronous DO SQLite transaction discipline (`MixedScheduler("sync")`, zero async I/O inside `withTransaction`), bounded jittered `Schedule` retries, and `Scope` resource finalizers.
4. **`effect-adversarial-reviewer` (When touching `*.decide` deciders, Event Sourcing, Outbox, Projections, or multi-step stateful flows):**
   Constructs crash-between-steps sequences, duplicate command delivery, out-of-order replay, and boundary mutation cases.

### Step 4.2 — Central Adjudication & Twin Class-Fix Loop
Follow the adjudication rubric from `resolving-effect-review-feedback`:

1. **Adjudicate via Graph MCP:** For every finding reported by the specialist reviewers, verify type and ontology facts with `harness_resolve`, `harness_callers`, `harness_ontology_why`, and `harness_tests_reaching`.
2. **Hunt AST Twins (`class-fix`):** Whenever a valid defect is confirmed, run `harness_structural_search` (`@ast-grep/napi`) across the workspace to locate and fix all identical occurrences in a single pass.
3. **Sync Contracts, Specs & ADRs First:** If a valid fix alters a contract Schema, error tag, EARS clause, or ADR invariant, update the EARS spec / ADR first and re-run `harness plan-check` if public signatures changed.
4. **Apply Eligible Fixes & Record Residuals:**
   - Autonomously apply all valid `fix`, `class-fix`, and `doc-sync-fix` items (dispatching scoped `flash` fixer subagents when changes span multiple packages).
   - Record any `decline-with-evidence` items or non-blocking advisory notes in a `## Residual & Declined Review Findings` section for the final PR body / closeout report.
   - If a finding exposes an unresolvable conflict with an accepted ADR or requires a destructive migration, stop and escalate.

---

## 2. Stage 5 — Stamp-Safe Compounding Learnings & Final Deterministic Gate Sequence

> [!IMPORTANT]
> `.harness/verify-stamp.json` records the SHA-256 hash (`treeHash`) of all tracked workspace files at the moment `harness verify` runs. Editing **any** file (including spec frontmatter, ADRs, or `agent-patterns/*.md` from `harness learn`) *after* `harness verify` invalidates the stamp and causes `harness done` (and the session `Stop` hook) to block completion.

Always execute Stage 5 in this exact stamp-safe order:

### Step 5.1 — Finalize Spec Status (`status: accepted`)
Update `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (or `docs/specs/`) frontmatter from `status: proposed` to `status: accepted`. Confirm all `enforced_by`, `spans`, `services`, and `errors` entries match the implemented code 1:1.

### Step 5.2 — Autonomous Compounding Learnings (`harness learn`)
1. Run `harness learn`:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn
   ```
2. Inspect `.harness/friction-log.jsonl` clusters (`Friction.decide` + `LearnProposalV1`) and any gate blind spots uncovered in Stage 4:
   - Autonomously apply clear, deterministic promotions across the 5 targets (`agent-pattern` in `agent-patterns/*.md`, `triage-rule` in `DETERMINISTIC_TRIAGE_RULES`, `guard-allowlist` in `ALLOWLIST`, `ast-graph-gate` in `tools/oxlint/syntax-bans.js` / `policy-check.ts`, or `adr` in `libs/<scope>/docs/adr/`).
   - Never append prose warnings to `AGENTS.md`.
   - Note: Modifying `.oxlintrc.json`, `tools/oxlint/*`, or `policies.cedar` triggers a human confirmation prompt via `harness guard`; only touch protected linter policy files when a high-confidence gate escape requires it, otherwise promote via `agent-patterns/*.md`, `DETERMINISTIC_TRIAGE_RULES`, or an ADR.
3. Clear processed friction logs:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn --clear
   ```

### Step 5.3 — Final Deterministic Gate Sequence (`gc` $\rightarrow$ `ontology` $\rightarrow$ `mutate` $\rightarrow$ `verify` $\rightarrow$ `done`)
With all code, tests, specs, ADRs, and learning promotions written to disk, execute the complete verification sequence (`WaitMsBeforeAsync: 10000` on each command):

```bash
node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ontology check --strict
node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts mutate --strict
CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done
```

- If any gate fails, fix the root cause and re-run the full sequence from `gc --strict` through `done`.
- If `harness verify` exits with code `2` (`[ESCALATE: STUCK LOOP DETECTED]`), stop immediately and report the blocker.
- Once `harness done` succeeds, **do not modify any tracked workspace file**.

---

## 3. Stage 6 — Git Commit, Optional Push/PR & Closeout

### Step 6.1 — Scoped Git Commit (Stamp-Preserving)
1. Inspect modified and untracked files:
   ```bash
   git status --short
   ```
2. Stage **only** the files created or modified by this task (contracts, services, domain/core, infra, tests, specs, ADRs, and promoted learning files).
   - **Never** run `git add -A` or `git add .` if unrelated pre-existing dirty files exist.
   - **Never** stage `.harness/` state files.
   - Because `computeWorkspaceTreeHash` hashes workspace file contents (ignoring `.git/` and `.harness/`), running `git add` and `git commit` does **not** alter the workspace `treeHash`, so `.harness/verify-stamp.json` remains valid for the `Stop` hook!
3. Commit with a descriptive conventional commit message referencing the EARS spec ID:
   ```bash
   git commit -m "feat(<scope>): <concise summary> (<scope>:SPEC-NNNN)"
   ```

### Step 6.2 — Shipping Precondition (`git remote`) & PR Creation
Run `git remote` once to determine the shipping path:

1. **No Remote Configured (or User Requested Local-Only):**
   - The local commit on the isolated branch/worktree is the terminal state. Do not attempt to push or call `gh pr create`.
2. **Remote Configured (Feature Branch / PR Requested):**
   - Push the current branch to the remote (`git push -u origin HEAD`).
   - Create or update the pull request (`gh pr create` or `ce-commit-push-pr mode:pipeline` if available in the host catalog) with a structured body containing:
     - **Summary & Spec Link:** `<scope>:SPEC-NNNN` (`libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`) and any governing ADR (`<scope>:ADR-NNNN`).
     - **Verified Plan Topology Graph:** The Mermaid graph from `harness plan-check`.
     - **Assumptions Recorded (`## Assumptions`):** Explicit defaults chosen during Stage 1 autonomous EARS specification.
     - **Verification & Gate Receipt:** Confirmation of passing `gc --strict`, `ontology check --strict`, `mutate --strict`, `verify`, and `done`.
     - **Residual & Declined Review Findings:** Any report-only or declined items from Stage 4.
   - Merging always stays with the user unless explicitly granted for this run.

### Step 6.3 — Final Closeout Output
Present a concise closeout report to the user (worktree/branch path, spec & ADR paths, commit SHA, PR URL if opened, and any explicit assumptions or residual review notes), then end with:

```text
<promise>DONE</promise>
```
