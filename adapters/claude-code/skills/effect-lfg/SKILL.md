---
name: effect-lfg
description: Use when the user asks for autonomous end-to-end execution of a requirement, feature, bugfix, EARS spec, or multi-phase RFC through the full Effect-TS Engineering Harness without stopping between stages, or when invoking /effect-lfg directly.
argument-hint: "[requirement, bug report, EARS spec path, RFC path, or PR/review reference]"
---

# Effect-LFG (Autonomous End-to-End Harness Pipeline)

## Overview

Take a single user requirement, defect report, EARS specification path, multi-phase RFC, or review reference all the way to verified completion, hands-off, through the full Effect-TS Engineering Harness lifecycle. A child stage's completion immediately resumes the next numbered stage in the same turn — the run does not pause for intermediate human sign-off and does not end until `<promise>DONE</promise>` or a hard stop condition.

> **Canonical CLI Invocation:** In all stages below, `pnpm harness <cmd>` is shorthand for `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts <cmd>` (both forms are allowlisted in `libs/harness/gates/src/policy.ts`).

**Violating the letter of the rules is violating the spirit of the rules.**

---

## Autonomous Pipeline Overrides (Resolving Interactive Deadlocks)

When running under `effect-lfg`, apply these four pipeline overrides to the underlying interactive skills:

1. **No EARS Approval Pause (`specifying-ears-with-effect` override):**
   Never pause to ask clarifying questions or wait for user approval of `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`. Resolve existing contracts, services, and ADRs via in-process Graph MCP (`harness_resolve`, `harness_callers`, `harness_ontology_why`, `harness_ontology_impact`). Record any non-blocking product or technical defaults explicitly under `## Assumptions` and `## Out of scope`, verify the spec with `pnpm harness gc --strict` and `harness_ontology_check`, and advance immediately to `planning-effect-skeletons`.
2. **Multi-Slice Worktree DAG Execution (`specifying-ears-with-effect` + `planning-effect-skeletons` + `executing-effect-stubs` override — Route D):**
   When the input is an RFC (`docs/rfcs/*.md`), multi-phase plan (`docs/plans/*.md`), or requirement that **either (a) defines `>= 2` sequential implementation phases/milestones OR (b) modifies `>= 4` workspace packages** (such as [RFC-0010 §10](../../../docs/rfcs/0010-omnigraph-v014-native-capabilities-and-harness-integration.md#10-rollout--decomposition-plan-adrs-ears-specs--implementation-milestones)), **never** write one monolithic `stub<A, E, R>()` skeleton across all phases or copy unimplemented future-phase symbols into `libs/<scope>/docs/`. Instead, decompose into topological **Waves of Disjoint Slices** and execute each slice in its own isolated sibling Git worktree (with `HARNESS_WORKTREE_ID` unset) per [references/multi-slice-worktree-execution.md](references/multi-slice-worktree-execution.md). Each slice worker branches from the pinned `EPIC_BASE_SHA`, runs `plan-check` -> implements -> runs `gc --strict` / `ontology check --strict` / `mutate --strict` / `CI=true pnpm harness verify` (never `harness done` or `pnpm harness workflow ship`), and commits to `slice/<epic-slug>-<slice-id>`. The controller merges completed wave branches (`git merge --no-ff`), updates the cumulative EARS spec (`status: proposed`), runs inter-wave `plan-check` + `gc --strict` + `ontology check --strict`, cleans up slice worktrees, and runs `pnpm harness workflow complete --phase llm` + `pnpm harness workflow ship` once in Stage 5.
3. **Closed-Loop Specialist Review Auto-Fix (`executing-effect-stubs` + `resolving-effect-review-feedback` override):**
   After `haiku` / `sonnet` implementer subagents replace `stub<A, E, R>()` skeletons (or after the final Wave merges in Route D), route via `harness_review_route` and dispatch the applicable read-only specialist reviewers from all 7 specialist reviewers (`effect-ears-test-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`, `effect-adversarial-reviewer`, `effect-web-reviewer`, `effect-migration-contract-reviewer`, `effect-architecture-reviewer`). Adjudicate findings centrally via Graph MCP, hunt AST twins with `harness_structural_search`, autonomously apply all valid `fix`, `class-fix`, and `doc-sync-fix` items, and re-run `pnpm harness plan-check` if any signature or frontmatter symbol changed before final gates.
4. **Stamp-Safe Compounding Learnings & Durable Ship (`compounding-effect-learnings` + `ShipWorkflow` override):**
   Execute the LLM phase (`pnpm harness learn`, promote clear mechanical learnings across the 5 targets, set EARS specs `status: accepted`, format touched files with `pnpm oxfmt --write <explicit paths>`, `pnpm harness learn --clear`, and `pnpm harness workflow complete --phase llm --run-id <id> --repo-root <abs>` when running a compiled `HarnessTaskWorkflow` run) **before** running `pnpm harness workflow ship --run <id> [--repo-root <abs>]` (or `pnpm harness workflow ship` in ephemeral mode for standalone non-plan tasks) so post-verify file edits never invalidate `.harness/verify-stamp.json`.

---

## Stop Conditions (When to Halt and Escalate)

Proceed hands-off through every stage unless one of these hard stop conditions holds:

- **`[ESCALATE: STUCK LOOP DETECTED]`:** `pnpm harness verify` or `pnpm harness workflow ship` exits with code `2` (`LoopCircuitBreaker.decide` tripped after 3 consecutive identical failures) in either the controller or a Route D slice worker — **never retry blindly**.
- **Unrecoverable Slice or Wave Failure (Route D):** A slice worker in Wave `w` fails `verify` after 3 bounded repair attempts, or a wave merge conflict cannot be resolved by sequential re-application on top of `feat/<epic-slug>` (preserve healthy sibling merges on `feat/<epic-slug>` and the failing `slice/<epic-slug>-<id>` branch for inspection; never advance to Wave `w + 1`).
- **Destructive Migration or Cloud Deploy:** A change requires `DROP TABLE`, `DROP COLUMN`, a table rebuild (`MigrationSafety.decide`), or `alchemy deploy` / `alchemy destroy`.
- **Contradictory Settled ADR:** The request directly violates an `accepted` ADR (`<scope>:ADR-NNNN`) or is logically contradictory with no safe assumption.
- **Unrecoverable Gate or Tree-Integrity Failure:** Final deterministic gates under `ShipWorkflow` (`format-check -> gc-strict -> ontology-check-strict -> mutate-strict -> verify -> done --cli`) fail with `ShipTreeMismatchError`, `MutationRestoreError`, `ShipTreeDriftError`, or remain red after bounded autonomous triage and repair.

A stop leaves nothing pushed that was not already pushed and reports the exact blocker and recovery path.

---

## The Autonomous Run (Stages 0–6)

Read [references/autonomous-intake-and-ears.md](references/autonomous-intake-and-ears.md) before starting Stages 0–1, [references/multi-slice-worktree-execution.md](references/multi-slice-worktree-execution.md) when executing Route D (multi-phase RFCs/epics), and [references/review-and-shipping.md](references/review-and-shipping.md) before starting Stages 4–6.

```text
Stage 0: Worktree & Session Readiness (Pin feat/<slug> Branch)
  ↓
Stage 1: Route Intake (B: PR Review | D: Multi-Slice RFC/Epic DAG | A: Existing Spec | C: Single-Slice Feature/Defect)
  ↓
Stage 2: Plan-as-Code Skeletons, plan-check & ADR Sync (Single-Slice on Routes A/C; Per-Wave Worktrees on Route D)
  ↓
Stage 3: Package-Isolated haiku / sonnet Implementation & Trace/Prop Tests (executing-effect-stubs)
  ↓
Stage 4: Signal-Routed 7-Lens Specialist Review (`routeReview`) & Autonomous Class-Fix Loop (resolving-effect-review-feedback)
  ↓
Stage 5: LLM Phase (`learn`, `accepted`, `oxfmt`, `learn --clear`, `workflow complete --phase llm`) & `ShipWorkflow` (`pnpm harness workflow ship`)
  ↓
Stage 6: Git Commit, Optional Push/PR & <promise>DONE</promise>
```

### Stage 0 — Worktree & Session Readiness

1. Check workspace isolation (`git rev-parse --absolute-git-dir` vs `git rev-parse --git-common-dir`) and ensure the controller is on an isolated feature/fix branch (`feat/<slug>` or `fix/<slug>`):
   - If already inside a linked worktree (`.harness/worktrees/*`), work in place on its branch and never run `git worktree add` to nest a subdirectory inside that worktree.
   - If in the primary checkout and the user requested a new worktree (or unrelated dirty files exist), create a sibling worktree `git worktree add -b feat/<slug> .harness/worktrees/feat-<slug> main` (never run `cd` in shell commands, which is blocked by `harness guard`).
   - If in a clean primary checkout on `main`, switch to `feat/<slug>` (`git switch -c feat/<slug>`).
   - For **Route D**, `feat/<epic-slug>` serves as the Epic Controller integration branch; slice workers operate in sibling worktrees anchored to the common `.git` directory (with `HARNESS_WORKTREE_ID` unset).
2. Run `pnpm harness session` to inspect active stubs, branch state, and environment readiness, and verify `/tmp` inode availability before spawning parallel test workers (`df -ih /tmp`, passing explicit `TMPDIR`/`NX_SOCKET_DIR` cleanly when needed).

### Stage 1 — Route Intake & Autonomous EARS Specification

**REQUIRED SUB-SKILL:** Use `specifying-ears-with-effect` in autonomous pipeline mode per [references/autonomous-intake-and-ears.md](references/autonomous-intake-and-ears.md) (evaluating routes in this exact precedence order):

- **Route B (External PR / Review Feedback):** If the input is a PR number/URL or pasted review feedback, execute `resolving-effect-review-feedback` end-to-end, then jump to Stage 5.
- **Route D (Multi-Phase RFC / Multi-Slice Epic):** If the input names an RFC (`docs/rfcs/*.md`), a multi-phase plan (`docs/plans/*.md`), an in-progress multi-slice branch (`slice/<epic-slug>-*`), OR a requirement that **either (a) defines `>= 2` sequential implementation phases/milestones OR (b) modifies `>= 4` workspace packages** (such as [RFC-0010 §10](../../../docs/rfcs/0010-omnigraph-v014-native-capabilities-and-harness-integration.md#10-rollout--decomposition-plan-adrs-ears-specs--implementation-milestones)), execute the **Multi-Slice Worktree DAG Protocol** in [references/multi-slice-worktree-execution.md](references/multi-slice-worktree-execution.md):
  1. Decompose the epic into topological **Waves of Disjoint Slices** (`Wave 1 .. Wave K`), placing shared `type:contract`, `type:service`, `.pg`/`.gq`/`cluster.yaml`, and workspace manifest/barrel foundations in `Wave 1`. Ensure parallel slices within any Wave own 100% disjoint files (when in doubt, serialize into sequential Waves).
  2. Record `EPIC_BASE_SHA=$(git rev-parse HEAD)` on `feat/<epic-slug>` and dispatch each slice in Wave `w` to an isolated sibling Git worktree subagent (with `HARNESS_WORKTREE_ID` unset).
  3. Inside its slice worktree (`repoRoot`), each slice worker creates branch `slice/<epic-slug>-<slice-id>` from `EPIC_BASE_SHA`, runs `pnpm harness plan-check` -> implements stubs -> runs `pnpm harness gc --strict` -> `pnpm harness ontology check --strict` -> `pnpm harness mutate --strict` -> `CI=true pnpm harness verify` (never `harness done`), and commits to `slice/<epic-slug>-<slice-id>`.
  4. After each Wave completes, the controller merges each slice branch (`git merge --no-ff slice/<epic-slug>-<slice-id>`), updates the cumulative `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (`status: proposed`, contiguous `### 1..M` area numbering, zero future-slice symbols), runs inter-wave `pnpm harness plan-check` + `pnpm harness gc --strict` + `pnpm harness ontology check --strict`, cleans up the slice worktrees (`git worktree prune`), and advances to Wave `w + 1`. After the final Wave merges, the controller promotes the epic ADR (`status: accepted`), refreshes `pnpm harness plan-check`, and proceeds to Stage 4.
- **Route A (Existing Single-Slice EARS Spec Path):** If the input names an existing single-slice spec in `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (or `docs/specs/`), validate it with `pnpm harness gc --strict` and `harness_ontology_check` and jump to Stage 2.
- **Route C (Single-Slice Requirement / Feature / Defect / Single-Phase RFC):** For single-phase work touching **`1–3` workspace packages** (`< 4` packages and `1` phase), inspect the graph (`harness_resolve`, `harness_callers`, `harness_ontology_why`, `harness_ontology_impact`), determine archetype (`application` vs `framework`), author `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (`status: proposed`) with explicit `## Assumptions`, run the 3-role self-review, verify with `pnpm harness gc --strict` and `harness_ontology_check`, and continue immediately to Stage 2.

### Stage 2 — Plan-as-Code Skeletons, `plan-check` & ADR Governance

**REQUIRED SUB-SKILL:** Use `planning-effect-skeletons` (run once on the controller workspace for Routes A/C, or inside each slice worktree + inter-wave controller sync on Route D):

1. Call `harness_route` for each non-trivial capability and read the matched `agent-patterns/*.md` recipe.
2. Define boundary Schemas and `Schema.TaggedError` classes in `type:contract` (`0` workspace dependencies), pure `Context.Service` ports in `type:service` (zero `Layer.*` constructors or `node:*` imports), and `stub<A, E, R>(...args)` skeletons in `type:domain` / `type:core` / `type:infra` (keeping `*.decide` strictly pure with `R = never`, and honoring `HarnessTierTopology.decide` and `SelfDogfooding.decide` across all 5 hexagonal tiers: single `type:*` tag per package, explicit named exports in `index.ts` barrels with no `export *`, zero `node:*` outside `type:infra` except `path`/`crypto`/`url`, zero `process.env` outside `type:infra`/`type:app`, and zero module-scope mutable caches).
3. Run the deterministic plan gate (pass `--mermaid` when generating the topology diagram, otherwise `plan-check` emits a compact JSON summary):
   ```bash
   pnpm harness plan-check --mermaid
   ```
4. Append the verified Mermaid topology diagram printed by `plan-check --mermaid` into `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` under `## 4. Verified Plan Topology Graph`, apply the Pre-Implementation Adversarial Plan Lens, and author/update `libs/<scope>/docs/adr/NNNN-<slug>.md` when the Counterfactual Eligibility Rule holds (on Route D, defer epic-wide `accepted` ADR creation until Step D5 when all `enforced_by` files exist).
5. Verify governance docs with `pnpm harness gc --strict` and `harness_ontology_check`.

### Stage 3 — Package-Isolated `haiku` / `sonnet` Implementation & Tests

**REQUIRED SUB-SKILL:** Use `executing-effect-stubs` (executed across downstream packages after Stage 2 on Routes A/C, or inside each slice worktree on Route D):

1. Partition implementation by Nx package boundaries (`type:domain` / `type:core`, `type:infra`, `scope:web`).
2. When 2+ downstream packages have stubs, dispatch parallel `haiku` / `sonnet` implementer subagents (using `HARNESS_WORKTREE_ID=<unit>` when sharing a single checkout for package-scoped `pnpm --filter <pkg> run typecheck && pnpm --filter <pkg> run lint && pnpm --filter <pkg> run test` or `CI=true pnpm nx run <project>:verify` checks to avoid concurrent Nx daemon/cache lock contention in shared checkouts — package implementers never run monorepo `plan-check`, `verify`, or `done`) with the **Swarm Brief Header Standard** (`REPO_ROOT=<abs path>`, absolute paths for `Read`/`Edit`/`Write`, `repoRoot: "<abs path>"` for MCP tools, and MCP-first diagnostics before CLI fallbacks) plus the 4-part prompt (Target Stubs, EARS Clauses, Pattern Reference, Package Gate `pnpm --filter <pkg> run typecheck && pnpm --filter <pkg> run lint && pnpm --filter <pkg> run test` / `CI=true pnpm nx run <project>:verify`). Omit monitoring workers for focused single-wave runs and terminate any active monitor immediately once implementation/remediation waves settle. When only a single downstream package has stubs, implement it inline under the same package gate.
3. Ensure every EARS clause is verified by `@effect/vitest` (`it.effect` + `runWithTestTracer` + `checkSpanBudgets`), negative tests assert exact error instances via `Cause.findErrorOption(exit.cause)`, and every pure `*.decide` / reducer has `it.effect.prop` / `it.prop` property-based tests over `Schema.Array(EventUnionSchema)`.

### Swarm Seam Checklist (Pre-Review)

Before dispatching review routing (`harness_review_route`) after multi-package or cross-layer implementation, verify all four cross-package seams across touched units:

1. **Symmetric Activity & Deferred Codecs:** Producer and consumer packages decode and encode shared payloads through the same branded `@harness/contract` Schema round-trip with zero unbranded raw JSON assumptions.
2. **Single-Source Timeout Budgets:** Every retry, lease, and RPC/subprocess wait reads from canonical `WORKFLOW_TIMEOUT_BUDGETS` bounds rather than ad-hoc hardcoded constants.
3. **Fenced Non-Lease Mutations:** Non-lease state transitions pass and assert explicit `expectedLeaseEpoch` fencing so stale workers fail closed before mutating shared state.
4. **Differential Replay Parity:** Fresh execution and recovery/journal replay converge to identical terminal state, pending deferreds, and telemetry projections under `SPEC-0026` seam invariants.

### Stage 4 — Signal-Routed 7-Lens Specialist Review & Autonomous Fix Loop

**REQUIRED SUB-SKILL:** Use `resolving-effect-review-feedback` per [references/review-and-shipping.md](references/review-and-shipping.md) (executed once on the controller workspace after Stage 3 on Routes A/C, or after all Waves are integrated in Step D5 on Route D):

1. Route via `harness_review_route` and dispatch parallel read-only `haiku` specialist reviewers across `git diff main...HEAD` based on touched signals (fanning out per `reviewSlices` when `changedFiles.length >= REVIEW_SLICE_FILE_THRESHOLD` while preserving whole-diff cross-package seam checks), passing the exact list of domain-owned changed files + `baseRef` and instructing each reviewer to start with `harness_git_diff` (`statOnly: true`, then targeted `paths`) instead of re-reading all unchanged files in the PR:
   - `effect-ears-test-reviewer` (Always)
   - `effect-security-reviewer` (Contracts, `HttpApi`, `Rpc`, auth, SQL, `Config`)
   - `effect-reliability-reviewer` (`type:infra`, DO SQLite, D1, Queues, `Schedule`, `Scope`)
   - `effect-adversarial-reviewer` (Deciders, Event Sourcing, stateful or multi-step flows, or harness gates)
   - `effect-web-reviewer` (`scope:web`, `apps/*-web/**`, `*.tsx`, `AtomHttpApi`)
   - `effect-migration-contract-reviewer` (`migrations/*.sql`, `SqliteMigrator`, `alchemy.run.ts`, `type:contract` evolution)
   - `effect-architecture-reviewer` (`type:service`, framework/adapter surfaces, or `changedLineCount >= 180`)
2. Centrally adjudicate findings via Graph MCP (`harness_resolve`, `harness_ontology_why`, `harness_structural_search`, `harness_tests_reaching`).
3. Synchronize specs/ADRs first if needed, shard any single package with `> 15` adjudicated findings into `2+` disjoint sub-units by subdirectory/file concern, dispatch post-fix or follow-up remediation spanning `>= 2` packages (or disjoint modules) in parallel via the `Agent` tool rather than sequential solo edits, enforce the Phase 4 Acceptance Gate (a failed or missing fixer `Sub-Bullet Verification Matrix` or verification gate MUST block Phase 5 / Stage 5 and `swarm kill`), tear down any active monitoring workers immediately once active implementation/remediation waves settle, re-run `pnpm harness plan-check` if any public signature or frontmatter symbol changed, and record any non-blocking declined/residual items for the closeout report.
4. **Mandatory Second-Pass Remediation Re-Audit:** Whenever any `blocker`, `critical`, or `major` finding was resolved, call `harness_review_route` on the remediation diff with `remediationContext: { priorSpecialists, maxSeverity }` and complete a read-only second-pass specialist re-audit covering all modified remediation hunks and callers before entering Stage 5.

### Stage 5 — LLM Phase & Durable `ShipWorkflow` Pipeline (`workflow ship`)

**REQUIRED SUB-SKILL:** Use `compounding-effect-learnings` followed by `pnpm harness workflow ship` per [references/review-and-shipping.md](references/review-and-shipping.md) (executed once on the controller workspace for all routes; under `HarnessTaskWorkflow`, the durable lifecycle is `compile -> start -> complete/resume -> routeReview -> LLM phase -> workflow ship`):

1. Update the EARS specification frontmatter from `status: proposed` to `status: accepted`.
2. Run `pnpm harness learn`. If recurring friction clusters (`route_miss`, `verify_failure`, `guard_escalation`) or review gate escapes exist, promote them into `agent-patterns/*.md`, `DETERMINISTIC_TRIAGE_RULES`, `ALLOWLIST`, AST/graph gates, or an ADR.
3. Format only your modified files with `pnpm oxfmt --write <explicit paths>`, then clear processed friction logs and signal LLM phase completion (omit `--run-id` / `workflow complete --phase llm` for standalone non-plan tasks):
   ```bash
   pnpm oxfmt --write <explicit touched paths>
   pnpm harness learn --clear
   pnpm harness workflow complete --phase llm --run-id <id> --repo-root <abs>
   ```
4. Execute the **Durable Ship Pipeline** **once** after all review, spec, formatting, and learning edits have landed (do NOT run `harness mutate --strict` or `--diff` earlier while remediation edits are still in flight):
   ```bash
   pnpm harness workflow ship --run <id> [--repo-root <abs>]
   # Or, for standalone non-plan tasks outside HarnessTaskWorkflow (ephemeral runId):
   pnpm harness workflow ship
   ```
   Under `ShipWorkflow` (`idempotencyKey = "${runId}:${treeHash}:${attempt}"`), `pnpm harness workflow ship` automates:
   - Strict 6-stage execution order: `format-check -> gc-strict -> ontology-check-strict -> mutate-strict -> verify -> done --cli`.
   - Pre- and post-stage workspace `treeHash` guarantees (`ShipTreeMismatchError` before any gate if the tree differs; `ShipTreeDriftError` fail-closed if workspace files drift after `done --cli`).
   - Startup mutation backup recovery (`recoverStartupBackup` / `recoverMutationBackup`) prior to `mutate --strict` plus post-gate tree verification (`MutationRestoreError`).
   - Monotonic OCC `WfShipAttempt` tracking in `harness-workflows` and streaming `ShipStreamProgressEvent` NDJSON progress over `<git-common-dir>/harness/daemon.sock`.
   - `LoopCircuitBreaker.decide` escalation on exit code `2` (`[ESCALATE: STUCK LOOP DETECTED]`) — **never retry blindly**; fix the root cause or halt and escalate.
     **CRITICAL:** Never edit any tracked file after `pnpm harness workflow ship` succeeds, or `.harness/verify-stamp.json` will become stale and block session completion.

### Stage 6 — Git Commit, Optional Push/PR & Closeout

Follow [references/review-and-shipping.md](references/review-and-shipping.md) to close out (for all routes):

1. Stage only the files created or modified by this run (never `git add -A` over unrelated pre-existing dirty files; never stage `.harness/`) and create a conventional commit referencing `<scope>:SPEC-NNNN` (on Route D, commit any final Stage 4/5 governance or learning updates onto `feat/<epic-slug>` prior to running `pnpm harness workflow ship`).
2. Check `git remote` and user intent:
   - **Local-only or no remote configured:** Leave the verified commit on the branch.
   - **Remote configured and PR shipping appropriate/requested:** Push the branch (`git push -u origin HEAD`) and open/update the PR (`gh pr create` or `ce-commit-push-pr mode:pipeline`) carrying the EARS Spec summary, Verified Mermaid Topology, `## Assumptions`, and `## Residual Review Findings`. If push or PR creation fails due to credentials/network, keep the verified local commit, note the push error in the closeout report, and finish cleanly.
3. Output the structured closeout summary followed by `<promise>DONE</promise>`.

---

## MCP Parameter Cheat-Sheet & Swarm Brief Header Standard

Use exact MCP parameter names across all stages and worker prompts:

- `harness_lsp_diagnostics({ file | project, repoRoot?, overlays? })`
- `harness_ontology_check({ scope?, repoRoot? })` (CLI strict flag: `pnpm harness ontology check --strict`)
- `harness_ontology_why({ symbolOrSpan, repoRoot? })`
- `harness_git_diff({ baseRef?, paths?, statOnly?, repoRoot? })`
- `harness_tests_reaching({ symbolOrSpan, repoRoot? })`
- `harness_structural_search({ pattern, paths?, repoRoot? })`
- `harness_review_route({ changedFiles, baseRef?, repoRoot? })`

Every parallel subagent brief MUST start with:

```text
REPO_ROOT=<abs path>
IMPORTANT: Pass absolute paths starting with <abs path>/ to Read, Edit, and Write, and pass repoRoot: "<abs path>" to MCP tools. Run MCP-first diagnostics (harness_lsp_diagnostics, harness_ontology_check) before CLI fallbacks.
```

---

## Quick Reference Matrix

| Stage                | Sub-Skill                          | Key MCP Tools & CLI Gates                                                                                                                          | Exit Artifact / State                                                                                 |
| :------------------- | :--------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| **0. Readiness**     | `effect-harness`                   | `pnpm harness session`, `git switch -c feat/<slug>` / `git worktree`                                                                               | Isolated clean controller branch `feat/<slug>` & session state                                        |
| **1. Intake & Spec** | `specifying-ears-with-effect`      | `harness_resolve`, `harness_ontology_why`, `pnpm harness gc --strict`, `harness_ontology_check`                                                    | Route B/D/A/C selected; `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (`status: proposed`)           |
| **2. Skeleton**      | `planning-effect-skeletons`        | `harness_route`, `harness_lsp_diagnostics`, `pnpm harness plan-check`                                                                              | Compilable `stub<A,E,R>()` graph, `.harness/plan-graph-snapshot.json`, Mermaid in spec, ADR           |
| **3. Implement**     | `executing-effect-stubs`           | Subagents (`haiku` / `sonnet`), `harness_lsp_diagnostics`, `CI=true pnpm nx run <proj>:verify`                                                     | Zero active `stub()` calls, `@effect/vitest` trace + property tests (or merged Wave slices on D)      |
| **4. Review**        | `resolving-effect-review-feedback` | `harness_review_route`, 7 specialist reviewers, `harness_structural_search`, `harness_tests_reaching`, post-fix `plan-check` if signatures changed | All valid `fix` / `class-fix` / `doc-sync-fix` items applied, second-pass re-audit complete           |
| **5. LLM & Ship**    | `compounding-effect-learnings`     | `pnpm harness learn`, `oxfmt --write`, `learn --clear`, `pnpm harness workflow complete --phase llm`, `pnpm harness workflow ship`                 | Spec `status: accepted`, `WfShipAttempt` passed, fresh `.harness/verify-stamp.json`, Omnigraph `main` |
| **6. Ship & PR**     | `effect-lfg`                       | `git commit`, `git remote`, `gh pr create`                                                                                                         | Clean commit (and open PR when applicable) + `<promise>DONE</promise>`                                |

---

## Rationalization Table

| Excuse                                                                                                                                                            | Reality                                                                                                                                                                                                                                                                                                                                                                                                                 |
| :---------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "I must stop after drafting the EARS spec and wait for the user to approve it."                                                                                   | In `effect-lfg` autonomous mode, stopping for EARS approval deadlocks the pipeline. Record non-blocking defaults in `## Assumptions`, verify with `gc --strict` and `harness_ontology_check`, and proceed immediately to `planning-effect-skeletons`.                                                                                                                                                                   |
| "The RFC already has the full `SPEC-NNNN` and `ADR-NNNN` drafts in Section 10, so I'll write one unified `stub<A,E,R>()` skeleton across all 8 packages at once." | Monolithic skeletons across multi-phase RFCs (`Route D`) create brittle multi-phase snapshots, leak future-phase symbols (`unmapped-spec-symbol`, `stale-doc-reference`), and dilute review accuracy. Decompose into topological Waves of Disjoint Slices per [references/multi-slice-worktree-execution.md](references/multi-slice-worktree-execution.md).                                                             |
| "I'll run parallel Route D slice workers in the same checkout with `HARNESS_WORKTREE_ID` so each runs its own `plan-check -> verify`."                            | `HARNESS_WORKTREE_ID` scopes `.harness/worktrees/<id>/verify-stamp.json` for Stage 3 package implementers (`pnpm nx run <pkg>:verify`), whereas `plan-check` and `done` read and write `<repoRoot>/.harness/plan-graph-snapshot.json` and `graph-snapshot.json` directly under `repoRoot`. Route D slice workers running `plan-check -> verify` MUST use separate sibling worktrees (with `HARNESS_WORKTREE_ID` unset). |
| "I'll pass `HARNESS_WORKTREE_ID=slice-<id>` inside a linked slice worktree and run `harness done` inside each slice worker."                                      | Inside a linked worktree, setting `HARNESS_WORKTREE_ID` splits `.harness/` state across `<worktreeRoot>/.harness/` and `<worktreeRoot>/.harness/worktrees/slice-<id>/`, and running `harness done` in a slice worker prematurely merges into Omnigraph `main` before `git merge --no-ff` succeeds. Slice workers leave `HARNESS_WORKTREE_ID` unset and stop at `CI=true pnpm harness verify` + `git commit`.            |
| "I'll spawn 5 parallel worktree subagents for Phases 9A–9E all at once in Wave 1."                                                                                | Phases 9B–9E depend on Foundation Wave `type:contract` / `type:service` / `.pg` schemas from 9A and modify shared files like `omnigraph-sync.ts`. Organize slices into topological Waves (`Wave 1 -> Wave 2 -> ...`) where slices in the same parallel Wave own 100% disjoint files.                                                                                                                                    |
| "The user said 'just ship it', so I'll skip the EARS spec and `stub<A, E, R>()` `plan-check`."                                                                    | Skipping EARS or `plan-check` omits `.harness/plan-graph-snapshot.json` and `SpecifiesSymbol` edges, causing deterministic failures in `pnpm harness gc --strict` and `pnpm harness done`. Autonomous means hands-off, never gate-free.                                                                                                                                                                                 |
| "The change is small, so I don't need the 7 specialist review subagents."                                                                                         | Autonomous runs have no human eyes before completion. Specialist `haiku` reviewers (`effect-ears-test-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`, `effect-adversarial-reviewer`, `effect-web-reviewer`, `effect-migration-contract-reviewer`, `effect-architecture-reviewer`) catch vacuous tests, IDOR, sync DO violations, and race conditions before `verify`.                             |
| "I'll run `harness learn` or tweak a markdown file after `pnpm harness workflow ship`."                                                                           | `.harness/verify-stamp.json` hashes the entire working tree via SHA-256. Any tracked file edit after `harness verify` (inside `workflow ship`) invalidates the stamp and causes `ShipTreeDriftError` / the `Stop` hook to block completion. Always run `learn`, `oxfmt`, `learn --clear`, and `workflow complete --phase llm` _before_ `pnpm harness workflow ship`.                                                    |
| "I'll stop and ask the user whether to promote friction clusters in `harness learn`."                                                                             | In `effect-lfg`, pausing on `harness learn` stalls an unattended run. Autonomously apply clear mechanical promotions (or record deferred architectural questions in the closeout report) and run `pnpm harness learn --clear` before `pnpm harness workflow ship`.                                                                                                                                                      |
| "Vitest passed, so I can commit and output `<promise>DONE</promise>` without `pnpm harness workflow ship`."                                                       | Only `pnpm harness workflow ship` (`ShipWorkflow`: `format-check -> gc-strict -> ontology-check-strict -> mutate-strict -> verify -> done --cli`) enforces tree-hash immutability, mutation backup recovery, zero `stub()` calls, `SpanBudget.decide`, `.harness/verify-stamp.json`, `WfShipAttempt` OCC, and Omnigraph `impl/* -> main` merge.                                                                         |

---

## Red Flags — STOP

- Stopping after Stage 1 (`specifying-ears-with-effect`) to ask the user to approve the EARS specification instead of recording `## Assumptions` and continuing to Stage 2
- Treating a multi-phase RFC (`>= 2` sequential phases) or `>= 4`-package epic as a single monolithic Route C skeleton instead of Route D topological Wave slices in isolated worktrees
- Copying unimplemented future-slice `spans`, `errors`, `services`, or `enforced_by` files from an RFC draft into `libs/<scope>/docs/specs/` or `libs/<scope>/docs/adr/` before those slices are implemented, or leaving non-sequential `### <n> · <Title>` area numbers (e.g., jumping from `2` to `5`) in a slice spec (`EarsSpecLint.decide` `area-structure` / `numbering-gap`)
- Running multiple `plan-check -> implement -> verify` slice workers in the same `repoRoot`, setting `HARNESS_WORKTREE_ID` inside an already-isolated slice worktree, or running `harness done` / `pnpm harness workflow ship` inside a slice worker before controller integration
- Placing two slices that edit the same file (`omnigraph-sync.ts`, `package.json`, barrel `src/index.ts`, or `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`) into the same parallel Wave
- Skipping `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`, `stub<A, E, R>()` skeletons, or `pnpm harness plan-check` in the name of speed
- Invoking generic Markdown planning skills (`ce-plan`, `ce-work`) that bypass `stub<A, E, R>()`, `pnpm harness plan-check`, and `.harness/verify-stamp.json`
- Skipping the parallel specialist review lenses (`effect-ears-test-reviewer`, etc.) or ignoring valid P0/P1 findings they report
- Retrying `pnpm harness workflow ship` blindly after exit code `2` (`LoopCircuitBreaker.decide` tripped) without fixing the root cause or escalating
- Editing any tracked file (specs, ADRs, comments, pattern docs, or code) _after_ `pnpm harness workflow ship` without re-running `pnpm harness workflow ship`
- Running `git add -A` when unrelated pre-existing dirty files exist in the checkout
- Outputting `<promise>DONE</promise>` without a passing `pnpm harness workflow ship` and fresh `.harness/verify-stamp.json`
