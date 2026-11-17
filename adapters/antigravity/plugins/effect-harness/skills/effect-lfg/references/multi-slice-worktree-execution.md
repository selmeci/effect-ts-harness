# Route D — Multi-Slice DAG & Isolated Worktree Execution (RFCs & Large Epics)

This reference governs **Route D (Multi-Phase RFC / Multi-Slice Epic Execution)** in `effect-lfg`. Use it whenever the input is an RFC (`docs/rfcs/*.md`), a multi-phase plan (`docs/plans/*.md`), or a requirement that **either (a) defines `>= 2` sequential implementation phases/milestones OR (b) modifies `>= 4` workspace packages** (such as [RFC-0009 §10](../../../../../docs/rfcs/0009-omnigraph-v014-native-capabilities-and-harness-integration.md#10-rollout--decomposition-plan-adrs-ears-specs--implementation-milestones)).

> **Canonical CLI Invocation:** In all commands below, `pnpm harness <cmd>` is shorthand for `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts <cmd>` (both forms are allowlisted in `libs/harness/gates/src/policy.ts`).

---

## 1. Two-Tier Subagent Isolation (`Workspace: "share"` vs. `HARNESS_WORKTREE_ID`)

Understanding how the CLI resolves `.harness/` files prevents snapshot clobbering and `Stop` hook deadlocks:

1. **Why Full-Lifecycle Slice Workers Require Separate Worktrees (`Workspace: "share"` Without `HARNESS_WORKTREE_ID`):**
   - `pnpm harness plan-check`, `pnpm harness verify`, and `pnpm harness done` read and write `plan-graph-snapshot.json` and `graph-snapshot.json` directly at `<repoRoot>/.harness/` (`apps/harness-cli/src/commands/plan-and-repair.command.ts` and `verify-and-done.command.ts`).
   - Meanwhile, `resolveHarnessStateDir(repoRoot)` (`libs/harness/gates/src/worktree.ts`) writes `verify-stamp.json` and `graph-head.json` to `<repoRoot>/.harness/worktrees/<id>/` when `HARNESS_WORKTREE_ID` is set, or to `<repoRoot>/.harness/` when unset.
   - When a Route D slice worker runs in its own linked Git worktree (`Workspace: "share"` in `invoke_subagent`, `workspace: "share"` in `swarm`, or a sibling worktree created via `git worktree add`), its `repoRoot` is already a separate directory on disk:
     - Keep `HARNESS_WORKTREE_ID` **unset** inside the slice worktree so `<sliceWorktreeRoot>/.harness/{plan-graph-snapshot,graph-snapshot,verify-stamp,graph-head}.json` all live together in `<sliceWorktreeRoot>/.harness/`.
     - `resolveCanonicalRepoRoot` (`libs/harness/graph/src/cluster-resolver.ts`) follows the worktree's `.git` `commondir` back to the primary repository root so `resolveOmnigraphClusterDir` connects to the single shared `<canonicalRoot>/.harness/omnigraph-cluster`.
     - Because `absRoot !== canonicalRoot`, `resolveOmnigraphTaskBranches` (`cluster-resolver.ts`) automatically namespaces the slice's Omnigraph task branches as `plan/wt-<worktree-basename>` and `impl/wt-<worktree-basename>` without needing `HARNESS_WORKTREE_ID`.
2. **When `HARNESS_WORKTREE_ID=<unit>` Is Used (Stage 3 Package Implementers Only):**
   - `HARNESS_WORKTREE_ID=<unit>` is used **only** when Stage 3 package implementers or Phase 4 review fixers share a single checkout (`workspace: "inherit"`) and run package-scoped checks (`CI=true pnpm nx run <project>:verify` or `:test`) after a single `plan-check` has already locked `<repoRoot>/.harness/plan-graph-snapshot.json`. Those package workers never run monorepo `plan-check`, `verify`, or `done`.
3. **Why Slice Workers Run `verify` (and Never `done`):**
   - `pnpm harness done` merges `impl/*` directly into Omnigraph `main` (`apps/harness-cli/src/commands/done-omnigraph-helpers.ts`). If a slice worker ran `done` before the controller merged its git branch (or if two parallel slice workers ran `done` concurrently before RFC-0009's OCC/dry-run merge guards exist), a failed sibling slice or merge conflict would leave Omnigraph `main` out of sync with Git.
   - Furthermore, `isSubagentStopContext` (`apps/harness-cli/src/commands/stop-hook-and-transcript.ts`) automatically bypasses the session `Stop` hook for subagents (`/.gemini/antigravity/worktrees/`, `/subagent-`, or subagent transcripts).
   - Therefore, every Route D slice worker ends its gate sequence at **`CI=true pnpm harness verify` + `git commit`**, leaving `pnpm harness done` exclusively to the Epic Controller at the end of Step D5 (Stage 5).

---

## 2. Step-by-Step Route D Execution Recipe

```text
Step D0: Pin Epic Controller Branch (feat/<epic-slug>) & Inspect Resume State
  ↓
Step D1: Decompose Epic into Topological Waves of Disjoint Slices (Wave 1 .. Wave K)
  ↓
Step D2: Record EPIC_BASE_SHA & Dispatch Worktree-Isolated Slice Subagents (Workspace: "share")
  ↓
Step D3: Each Slice Worker Runs plan-check -> Implement -> gc/ontology/mutate -> verify -> git commit
  ↓
Step D4: Controller Merges Wave Branches (git merge --no-ff), Updates Cumulative Spec & Runs Inter-Wave Gates
  ↓
Step D5: After Final Wave -> Promote Epic ADR/Spec, Run Signal-Routed 7-Lens Review (Stage 4) & Final Gates (Stages 5–6)
```

### Step D0 — Pin Epic Controller Branch & Check Resume State

1. **Ensure Controller Is on `feat/<epic-slug>`:**
   - In the controller workspace (either the primary checkout if clean, or the Stage 0 worktree `.harness/worktrees/feat-<epic-slug>`), ensure the active branch is `feat/<epic-slug>` (`git switch -c feat/<epic-slug>` if still on `main`).
   - Stage 0's "never nest a second worktree" rule means never running `git worktree add` to create a subdirectory *inside* another `.harness/worktrees/*` checkout. Dispatching subagents with `Workspace: "share"` (or creating sibling worktrees anchored to the common repository root `$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)/.harness/worktrees/slice-<id>`) creates **sibling** worktrees sharing the common `.git` directory, not nested worktrees.
2. **Idempotent Resume Check (If Re-Invoked Mid-Epic):**
   - Run `git log --oneline main..HEAD` and `git branch --list "slice/<epic-slug>-*"` to detect any already-integrated waves (`chore(<scope>): integrate slice/<epic-slug>-<slice-id>`).
   - Skip completed waves and resume at the first unmerged wave per Section 3.3 below.

### Step D1 — Decompose Epic into Topological Waves (Disjoint Wave Partitioning Law)

Inspect the RFC's implementation roadmap (e.g., [RFC-0009 §10.3](../../../../../docs/rfcs/0009-omnigraph-v014-native-capabilities-and-harness-integration.md#103-five-phase-implementation-roadmap-phases-9a9e)) and partition the work into topological **Waves** (`Wave 1 -> Wave 2 -> ... -> Wave K`):

1. **Foundation Wave First (`Wave 1`):**
   Shared `type:contract` Schemas/TaggedErrors, `type:service` ports, `.pg` / `.gq` / `cluster.yaml` foundations, and any workspace-wide manifest or barrel additions (`package.json`, `pnpm-lock.yaml`, `tsconfig.base.json`, `project.json`, or shared `src/index.ts` exports) that downstream slices depend on **must** execute and merge in `Wave 1` before dependent slices start.
2. **Strict Disjoint File Ownership Within Parallel Waves:**
   Two slices `Slice A` and `Slice B` may run **in parallel in the same Wave** if and only if:
   - Their modified and created files (`src/**`, `test/**`, `package.json`, `project.json`, `src/index.ts` barrels, and config files) are **100% disjoint**.
   - **When in doubt, serialize:** If exact file touch sets cannot be proven disjoint up front (for example, both slices modify `libs/harness/graph/src/omnigraph-sync.ts`, `done-omnigraph-helpers.ts`, the same package barrel `src/index.ts`, or transitive callers in the same module), place them in **sequential Waves** (`Wave w` then `Wave w + 1`) rather than risking merge conflicts.
   - Neither parallel slice resets or restarts the shared `.harness/omnigraph-cluster` daemon while a sibling slice is running against it (any one-time clean-slate cluster reset must run in its own serial Wave).
3. **Single-Owner EARS Spec Updates Across Parallel Waves:**
   To avoid parallel slices colliding on `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`, **slice workers in a parallel Wave (`2+` slices) do not edit the shared EARS spec file**. Instead, each parallel slice worker implements and tests its disjoint code/stub symbols, and the **Controller** updates `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` once in Step D4 after merging the parallel wave's branches (before running the inter-wave `gc --strict` and `plan-check` gates). In a **serial 1-slice Wave**, either the slice worker or the controller in Step D4 may update `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`.

### Step D2 — Pin `EPIC_BASE_SHA` & Dispatch Slice Subagents (`Workspace: "share"`)

Before dispatching Wave `w`:

1. Record the controller's current commit SHA on `feat/<epic-slug>`:
   ```bash
   git rev-parse HEAD
   ```
   Pass this exact SHA as `EPIC_BASE_SHA` to every slice worker in Wave `w` so all slices in the wave branch from the identical commit.
2. Select the dispatch tool using the canonical threshold (matching Stage 3 and `executing-effect-stubs`):
   - **`1–2` parallel slices in Wave `w`:** Use `invoke_subagent` (`TypeName: "self"`, `Workspace: "share"`, `Role: "Slice <id> Implementer"`).
   - **`3+` parallel slices in Wave `w` (or when explicit `gemini-4-hydrogen-medium` pinning is required):** Use `swarm` (`action: "add"`, `name: "slice-<id>"`, `model: "gemini-4-hydrogen-medium"`, `workspace: "share"`).
3. Provide each Slice Worker with this mandatory **6-Part Slice Brief**:
   - **Slice ID & Pinned Base Commit:** `slice/<epic-slug>-<slice-id>` starting from `EPIC_BASE_SHA` (keep `HARNESS_WORKTREE_ID` unset inside the `Workspace: "share"` worktree).
   - **Owned Files & Packages:** Exact list of files this slice may create or edit (and explicit ban on touching files owned by sibling slices or shared manifests).
   - **EARS Acceptance Clauses:** The exact `WHEN`, `IF/THEN`, `WHILE`, and `WHERE` clauses this slice must satisfy (and whether this is a serial 1-slice wave that updates `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` directly or a parallel wave where the controller updates the spec in Step D4).
   - **Target Signatures & Stubs:** Exact `type:contract` schemas/errors, `type:service` ports, and `Effect.fn` `stub<A, E, R>()` skeletons to plan and implement in this slice.
   - **Pattern & RFC References:** Relevant `docs/rfcs/*.md` sections and `agent-patterns/*.md` recipes.
   - **Exit Contract:** Must pass `pnpm harness plan-check` -> implement -> `pnpm harness gc --strict` -> `pnpm harness ontology check --strict` -> `pnpm harness mutate --strict` -> `CI=true pnpm harness verify` (with zero `[harness:omnigraph]` / `OmnigraphLoadError` failures on stderr; do **not** run `harness done`), commit onto `slice/<epic-slug>-<slice-id>`, and report the commit SHA.

### Step D3 — Inside Each Slice Worktree Subagent (Self-Contained Slice Lifecycle)

Each Slice Worker executes these 5 steps inside its isolated `Workspace: "share"` worktree (with `HARNESS_WORKTREE_ID` **unset**):

1. **Create Slice Branch from Pinned `EPIC_BASE_SHA`:**
   ```bash
   git switch -C slice/<epic-slug>-<slice-id> <EPIC_BASE_SHA>
   ```
2. **Phase-Scoped EARS Spec Update (Serial 1-Slice Waves Only; Deferred to Step D4 for Parallel Waves):**
   - If running a **serial 1-slice wave**, create or update `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (`status: proposed`, `archetype: application | framework`) containing **only** the `enforced_by` files, `spans`, `services`, `errors`, and `REQ-*` rows implemented up through this slice (**Zero Future-Slice Leakage**).
   - **Sequential Area Numbering (`EarsSpecLint.decide` `area-structure` & `numbering-gap`):** `### <n> · <Title>` headings under `## Requirements` must be numbered strictly `1, 2, 3, ...` with zero gaps, and rows under `### <n> · ...` must be numbered `REQ-<n>.1, REQ-<n>.2, ...`. Never preserve non-contiguous RFC section numbers (such as jumping from `### 2` to `### 5`).
   - **Defer Epic ADR Promotion:** Do **not** write an `accepted` epic ADR (`libs/<scope>/docs/adr/NNNN-<slug>.md`) during intermediate waves if its `enforced_by` files or `spans` reference future waves (which fails `stale-doc-reference` in `gc --strict`). Promote the epic ADR in Step D5.
3. **Write Slice `stub<A, E, R>()` Skeletons & Run `plan-check`:**
   - Write boundary types and `stub<A, E, R>(...args)` skeletons for this slice's functions only.
   - Run `plan-check` in the slice worktree:
     ```bash
     pnpm harness plan-check
     ```
     This writes `<sliceWorktreeRoot>/.harness/plan-graph-snapshot.json` and syncs `plan/wt-<worktree-basename>` in the shared Omnigraph cluster.
4. **Implement Slice & Write `@effect/vitest` Trace + Property Tests:**
   - Replace every `stub<A, E, R>()` in this slice with production Effect v4 code (`match(value)...exhaustive()`, branded types, zero `any` / `as never`).
   - Write `@effect/vitest` tests (`it.effect` + `runWithTestTracer` + `checkSpanBudgets` + `Cause.findErrorOption`, plus `it.effect.prop` over `Schema.Array(...)` for every pure `*.decide`).
5. **Run Slice Deterministic Gates (`verify` Only — No `done`) & Commit:**
   ```bash
   pnpm harness gc --strict
   pnpm harness ontology check --strict
   pnpm harness mutate --strict
   CI=true pnpm harness verify
   ```
   - Confirm `verify` exits `0`, writes `<sliceWorktreeRoot>/.harness/verify-stamp.json`, and syncs `impl/wt-<worktree-basename>` without `OmnigraphLoadError` on `stderr`.
   - Stage and commit only this slice's files onto `slice/<epic-slug>-<slice-id>`:
     ```bash
     git add <slice-files> && git commit -m "feat(<scope>): <slice summary> (<scope>:SPEC-NNNN [slice-<id>])" -- <slice-files>
     ```

### Step D4 — Controller Wave Integration, Cumulative Spec Sync, Inter-Wave Gates & Cleanup

When all Slice Workers in Wave `w` report completion with passing `verify` commits:

1. **Merge Slice Branches into `feat/<epic-slug>`:**
   In the controller worktree on `feat/<epic-slug>`, merge each slice branch in deterministic order:
   ```bash
   git merge --no-ff slice/<epic-slug>-<slice-id> -m "chore(<scope>): integrate slice/<epic-slug>-<slice-id>"
   ```
2. **Update Cumulative EARS Spec (`status: proposed`) & Run Inter-Wave Integration Gates:**
   - Update `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (`status: proposed`) on `feat/<epic-slug>` so its `enforced_by`, `spans`, `services`, `errors`, and contiguous `### 1..M` `REQ-*` tables include all slices merged through Wave `w`.
   - Run the inter-wave integration gate sequence on the controller workspace before starting Wave `w + 1`:
     ```bash
     pnpm harness plan-check
     pnpm harness gc --strict
     pnpm harness ontology check --strict
     ```
     (`pnpm harness plan-check` on the controller workspace updates `<controllerRoot>/.harness/plan-graph-snapshot.json`, prints the updated Mermaid topology diagram for `## 4. Verified Plan Topology Graph`, and reconciles `plan/branch-feat_<epic-slug>` in the shared Omnigraph cluster.)
   - Commit the updated spec if modified during Step D4.
3. **Clean Up Completed Slice Worktrees:**
   - **Order Invariant:** Always complete `git merge --no-ff slice/<epic-slug>-<slice-id>` **before** calling `swarm` (`action: "kill"`, `name: "slice-<id>"`), because the `swarm` tool's `kill` action deletes the worker's `workspace: "share"` directory.
   - For `invoke_subagent` (`Workspace: "share"`), the host manages worktree cleanup automatically; if any manual sibling worktrees were created, run `git worktree prune` (never run `rm -rf` or `git branch -d/-D`, which trigger `harness guard` deny/ask rules; leave local `slice/*` branch refs as lightweight audit pointers).
4. **Advance to Wave `w + 1`:** Repeat Steps D2–D4 until all Waves `1..K` are integrated into `feat/<epic-slug>`.

### Step D5 — Epic Closeout: ADR Promotion, Signal-Routed 7-Lens Review & Final Stamp-Safe Gates (Stages 4–6)

Once the final Wave (`Wave K`) is integrated into `feat/<epic-slug>`:

1. **Promote Full Epic ADR & Finalize EARS Spec Parity:**
   - Author/update `libs/<scope>/docs/adr/NNNN-<slug>.md` (`id: <scope>:ADR-NNNN`, `status: accepted`) using the canonical 6-section MADR structure (`## Context and Problem Statement`, `## Decision Drivers`, `## Considered Options` with `* **Option N:**`, `## Decision Outcome` opening with `**Chosen option:** "..."`, `## Rejected Alternatives` with `### N · <Name>` and `**Why rejected:**`, `## Consequences and Enforcement`).
   - Confirm `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` includes the complete union of `enforced_by`, `spans`, `services`, `errors`, and `informed_by: [<scope>:ADR-NNNN]`, then run `pnpm harness plan-check` on the controller workspace to refresh `<controllerRoot>/.harness/plan-graph-snapshot.json` and `## 4. Verified Plan Topology Graph`.
2. **Execute Stage 4 (Signal-Routed 7-Lens Specialist Review Across Full Integrated Diff):**
   - Dispatch the parallel read-only specialist reviewers (`effect-ears-test-reviewer`, `effect-adversarial-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`) once across `git diff main...HEAD`, adjudicate findings via Graph MCP, and apply all valid `fix`, `class-fix`, and `doc-sync-fix` items.
   - **Post-Review Snapshot Sync:** If Stage 4 review fixes added, renamed, or altered any `Effect.fn` signature, `Schema.TaggedError`, `Context.Service`, or spec/ADR frontmatter symbol, re-run `pnpm harness plan-check` and update `## 4. Verified Plan Topology Graph` so `<controllerRoot>/.harness/plan-graph-snapshot.json` matches the post-review graph before Stage 5.
3. **Execute Stage 5 (Stamp-Safe `learn` & Final Deterministic Gates Including Single `done`):**
   - Set `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` frontmatter to `status: accepted`.
   - Run `pnpm harness learn` and `pnpm harness learn --clear`.
   - Run the final gate sequence on the controller workspace:
     ```bash
     pnpm harness gc --strict
     pnpm harness ontology check --strict
     pnpm harness mutate --strict
     CI=true pnpm harness verify
     CI=true pnpm harness done
     ```
     (`CI=true pnpm harness done` validates `<controllerRoot>/.harness/verify-stamp.json` against the final tree hash and merges `impl/branch-feat_<epic-slug>` into Omnigraph `main` once for the entire epic.)
4. **Execute Stage 6 (Final Commit, Optional Push/PR & `<promise>DONE</promise>`).**

---

## 3. Failure, Conflict & Resume Protocol (Route D Stop Conditions)

1. **Slice Worker Verification Failure or Stuck Loop (`exitCode: 2`):**
   - If a slice worker in Wave `w` hits `[ESCALATE: STUCK LOOP DETECTED]` (`verify` exit code `2`) or fails its slice gates after 3 bounded repair attempts:
     - Do **not** merge that slice or advance to Wave `w + 1`.
     - If healthy sibling slices in Wave `w` succeeded and committed cleanly to their `slice/<epic-slug>-<sibling-id>` branches, merge only the healthy sibling branches (`git merge --no-ff`) so verified progress is preserved on `feat/<epic-slug>`.
     - Leave the failing `slice/<epic-slug>-<failed-id>` branch intact and halt/escalate with the exact gate output and recovery path (because slice workers never run `harness done`, Omnigraph `main` remains clean and uncorrupted).
2. **Unexpected `git merge --no-ff` Conflict in Step D4:**
   - If merging a second slice in a parallel wave produces a Git merge conflict on `feat/<epic-slug>`:
     1. Immediately abort the conflicted merge so `feat/<epic-slug>` stays at the clean commit from the first merged slice:
        ```bash
        git merge --abort
        ```
     2. Record the new `EPIC_BASE_SHA=$(git rev-parse HEAD)` on `feat/<epic-slug>` (which now includes the first slice).
     3. Re-dispatch the second slice sequentially from the updated `EPIC_BASE_SHA` (cherry-picking or re-applying its changes on top of the updated file), re-verify with `CI=true pnpm harness verify`, and merge cleanly.
3. **Resuming an Interrupted Route D Run:**
   - When `/effect-lfg` is invoked to resume an in-progress multi-slice epic (detected via an RFC/plan path argument OR existing `slice/<epic-slug>-*` branches / `integrate slice/` commits on `feat/<epic-slug>`):
     1. Route D takes precedence over Route A even though `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` already exists on disk.
     2. Inspect `git log --oneline main..HEAD` on `feat/<epic-slug>` to identify the last integrated Wave `w`.
     3. For the next unmerged slice `slice/<epic-slug>-<id>`, check `git log -1 slice/<epic-slug>-<id>`: if the slice branch already has a verified commit anchored at the current `EPIC_BASE_SHA`, integrate it via Step D4; otherwise reset the slice branch from `EPIC_BASE_SHA` (`git switch -C slice/<epic-slug>-<id> <EPIC_BASE_SHA>`) inside a fresh `Workspace: "share"` worker and execute Step D3.
