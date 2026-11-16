# Route D — Multi-Slice DAG & Isolated Worktree Execution (RFCs & Large Epics)

This reference governs **Route D (Multi-Phase RFC / Multi-Slice Epic Execution)** in `effect-lfg`. Use it whenever the user input is an RFC (`docs/rfcs/*.md`), a multi-phase plan (`docs/plans/*.md`), or a large requirement spanning **$\ge 4$ workspace packages** or **$\ge 2$ sequential architectural milestones**.

---

## 1. Why Monolithic Skeletons and Shared-Checkout Loops Fail on Epics

1. **Snapshot & Stamp Clobbering in a Single Checkout (`repoRoot`):**
   `harness plan-check`, `harness verify`, and `harness done` read and write `<repoRoot>/.harness/plan-graph-snapshot.json`, `<repoRoot>/.harness/graph-snapshot.json`, and `<repoRoot>/.harness/verify-stamp.json` directly under `repoRoot`. Running multiple `plan-check -> implement -> verify` workers concurrently in the same working tree (`Workspace: "inherit"`) overwrites those singleton files and invalidates the SHA-256 `treeHash`.
2. **Future-Phase Symbol Leakage (`unmapped-spec-symbol` & `stale-doc-reference`):**
   RFCs (such as `RFC-0009` §10) often include complete end-state drafts for target EARS specs (`<scope>:SPEC-NNNN`) and ADRs (`<scope>:ADR-NNNN`) covering all phases (`9A–9E`). Copying the end-state spec or ADR verbatim before all phases are implemented fails `harness plan-check` (`unmapped-spec-symbol`, `dead-tagged-error`) and `harness gc --strict` (`stale-doc-reference` on not-yet-created `enforced_by` files).
3. **Physical Isolation + Shared Omnigraph Cluster via Worktrees (`Workspace: "share"`):**
   When a slice subagent runs in its own linked Git worktree (`Workspace: "share"` in `invoke_subagent` or `workspace: "share"` in `swarm`):
   - Its `repoRoot` is a separate directory on disk, so `<sliceWorktreeRoot>/.harness/{plan-graph-snapshot,graph-snapshot,verify-stamp}.json` are **100% isolated per slice**.
   - `resolveCanonicalRepoRoot` follows the worktree's `.git` `commondir` back to the primary repository root, so `resolveOmnigraphClusterDir` automatically connects to the **single canonical `<canonicalRoot>/.harness/omnigraph-cluster`**.
   - `resolveOmnigraphTaskBranches` (with `HARNESS_WORKTREE_ID=slice-<id>`) namespaces the slice's Omnigraph branches as `plan/wt-slice-<id>` and `impl/wt-slice-<id>`, and `harness done` merges `impl/wt-slice-<id>` into `main` in the shared Omnigraph cluster.

---

## 2. Step-by-Step Route D Execution Recipe

```text
Step D1: Decompose Epic into Topological Waves of Disjoint Slices (Wave 1 .. Wave K)
  ↓
Step D2: Dispatch Worktree-Isolated Subagents per Slice (Workspace: "share")
  ↓
Step D3: Each Slice Worker Executes Scoped EARS -> plan-check -> Implement -> verify -> done -> git commit
  ↓
Step D4: Controller Merges Completed Wave Branches (git merge --no-ff), Syncs Omnigraph & Cleans Up Worktrees
  ↓
Step D5: After Final Wave -> Promote Epic ADR/Spec, Run 4-Lens Review (Stage 4) & Final Gates (Stages 5–6)
```

### Step D1 — Decompose Epic into Topological Waves (Disjoint Wave Partitioning Law)

Before writing any code or specs, inspect the RFC's implementation roadmap (e.g., Phases `9A–9E`) and partition the work into topological **Waves** (`Wave 1 -> Wave 2 -> ... -> Wave K`):

1. **Foundation Wave First (`Wave 1`):**
   Any shared `type:contract` Schemas/TaggedErrors, `type:service` ports, or `.pg` / `.gq` / `cluster.yaml` schema foundations that downstream slices depend on **MUST** be executed and merged in an earlier Wave before dependent slices start.
2. **Strict Disjoint File Ownership Within Parallel Waves:**
   Two slices `Slice A` and `Slice B` may run **in parallel in the same Wave** if and only if:
   - Their modified and created files (`src/**`, `test/**`, config files) are **strictly disjoint** (zero shared files edited by both slices).
   - If two logical milestones in an RFC modify the same file (for example, `libs/harness/graph/src/omnigraph-sync.ts` or `done-omnigraph-helpers.ts`), either **place those slices in sequential Waves** (`Wave w` then `Wave w+1`) or **extract disjoint submodule files** so parallel slices never touch the same file.
   - Neither parallel slice resets or restarts the shared `.harness/omnigraph-cluster` daemon while a sibling slice is querying or mutating it (any one-time clean-slate cluster reset must happen in a dedicated serial Wave).

### Step D2 — Dispatch Worktree-Isolated Slice Subagents (`Workspace: "share"`)

For each slice in the active Wave, launch an autonomous slice subagent with an isolated shared worktree:

- **1–2 parallel slices in the Wave:** Use `invoke_subagent` (`TypeName: "self"`, `Workspace: "share"`, `Role: "Slice <id> Implementer"`).
- **2+ parallel slices with explicit model pinning:** Use `swarm` (`action: "add"`, `name: "slice-<id>"`, `model: "gemini-4-hydrogen-medium"`, `workspace: "share"`).

Provide each Slice Worker with this mandatory **6-Part Slice Brief**:
1. **Slice ID & Target Branch:** `slice/<epic-slug>-<slice-id>` and `HARNESS_WORKTREE_ID=slice-<id>`.
2. **Owned Files & Packages:** Exact list of files this slice may create or edit (and explicit ban on touching files owned by sibling slices).
3. **Cumulative EARS Scope for This Slice:** Exact `REQ-*` rows, `enforced_by` paths, `spans`, `services`, and `errors` that belong in `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` up through this slice (**zero future-slice symbols**).
4. **Target Signatures & Stubs:** Exact `type:contract` schemas/errors, `type:service` ports, and `Effect.fn` `stub<A, E, R>()` skeletons to plan and implement in this slice.
5. **Pattern & RFC References:** Relevant `docs/rfcs/*.md` sections and `agent-patterns/*.md` recipes.
6. **Exit Contract:** Must pass `plan-check` $\to$ implement $\to$ `gc --strict` $\to$ `ontology check --strict` $\to$ `mutate --strict` $\to$ `CI=true harness verify` $\to$ `CI=true harness done`, commit onto `slice/<epic-slug>-<slice-id>`, and report the commit SHA and Omnigraph merge status.

### Step D3 — Inside Each Slice Worktree Subagent (Self-Contained Slice Lifecycle)

Each Slice Worker executes Stages 1–3 + slice verification inside its isolated `Workspace: "share"` worktree:

1. **Create Slice Git Branch:**
   ```bash
   git switch -c slice/<epic-slug>-<slice-id>
   ```
2. **Author/Update Phase-Scoped EARS Specification (`status: proposed`):**
   - Create or update `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` with `status: proposed`, `archetype: application | framework`, and all required canonical sections (`## Context`, `## Goal`, `## How to read the requirements`, `## Requirements`, `## Assumptions`, `## Out of scope`, `## Known residual risks`, `## Acceptance criteria`).
   - **Zero-Conflict Companion Spec Rule for Parallel Waves:** When a Wave dispatches $2+$ parallel slices (`slice-A` $\parallel$ `slice-B`), only the first slice (`slice-A`) edits the canonical `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`. Each sibling parallel slice (`slice-B`) writes its slice requirements into a temporary companion spec `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>-<slice-id>.md` (`id: <scope>:SPEC-NNNN-<slice-id>`, `status: proposed`) so parallel slices touch **100% disjoint files** (preventing Git merge conflicts on the spec file and its `## 4. Verified Plan Topology Graph`). During Step D4 after `git merge --no-ff`, the controller folds the companion spec into the canonical `YYYY-MM-DD-<slug>.md` and deletes the temporary companion file.
   - **Sequential Area Numbering (`EarsSpecLint.decide` `area-structure` & `numbering-gap`):** `EarsSpecLint.decide` enforces that `### <n> · <Title>` headings under `## Requirements` are numbered strictly `1, 2, 3, ...` with zero gaps, and every row inside `### <n> · ...` is numbered `REQ-<n>.1, REQ-<n>.2, ...`. Never preserve non-contiguous RFC section numbers (such as `### 1`, `### 2`, `### 5`, `### 6` in an early slice); renumber active areas sequentially `1..M` in each slice and restore full `1..K` numbering when all areas are present.
   - **No Future-Slice Leakage:** Include **only** the `enforced_by` files, `spans`, `services`, `errors`, and `REQ-*` rows that exist in the codebase + this slice. Never copy unimplemented symbols from future waves.
   - **Normalize Verification Kinds:** Pure `WHILE ... with R = never` clauses must use `GraphCheck` (or `PropertyTest` when testing runtime reducer/decider behavior via `it.effect.prop`, paired with `GraphCheck` for `R = never` purity).
   - **Defer Epic ADR Promotion:** Do **not** write an `accepted` epic ADR (`libs/<scope>/docs/adr/NNNN-<slug>.md`) in an early slice if its `enforced_by` list or `spans` reference files/symbols from later waves (which would immediately fail `stale-doc-reference` in `gc --strict`). Either scope the ADR strictly to current-slice files or promote the full ADR in Step D5 once all waves are merged.
3. **Write Slice `stub<A, E, R>()` Skeletons & Run `plan-check`:**
   - Write boundary types and `stub<A, E, R>(...args)` skeletons for this slice's functions only.
   - Run `plan-check` with the slice's worktree ID:
     ```bash
     HARNESS_WORKTREE_ID=slice-<id> node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check
     ```
   - Append/update `## 4. Verified Plan Topology Graph` in the EARS spec with the printed Mermaid diagram.
4. **Implement Slice & Write `@effect/vitest` Trace + Property Tests:**
   - Replace every `stub<A, E, R>()` in this slice with production Effect v4 code (`match(value)...exhaustive()`, branded types, zero `any`/`as never`).
   - Write `@effect/vitest` tests (`it.effect` + `runWithTestTracer` + `checkSpanBudgets` + `Cause.findErrorOption`, plus `it.effect.prop` over `Schema.Array(...)` for every pure `*.decide`).
5. **Run Slice Deterministic Gates, Merge Omnigraph Branch & Commit:**
   ```bash
   HARNESS_WORKTREE_ID=slice-<id> node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
   HARNESS_WORKTREE_ID=slice-<id> node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ontology check --strict
   HARNESS_WORKTREE_ID=slice-<id> node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts mutate --strict
   CI=true HARNESS_WORKTREE_ID=slice-<id> node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
   CI=true HARNESS_WORKTREE_ID=slice-<id> node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done
   ```
   - `verify` writes `<sliceWorktreeRoot>/.harness/verify-stamp.json` and syncs `impl/wt-slice-<id>`.
   - `done` verifies the slice's plan-vs-impl graph parity, merges `impl/wt-slice-<id>` $\to$ `main` in the shared root `.harness/omnigraph-cluster`, and cleans up `plan/wt-slice-<id>` and `impl/wt-slice-<id>`.
   - Stage and commit all modified/created files onto `slice/<epic-slug>-<slice-id>`:
     ```bash
     git add <slice-files>
     git commit -m "feat(<scope>): <slice summary> (<scope>:SPEC-NNNN [slice-<id>])"
     ```

### Step D4 — Controller Wave Integration, Omnigraph Reconcile & Worktree Cleanup

When all Slice Workers in Wave $w$ finish and report their committed `slice/<epic-slug>-<slice-id>` branches:

1. **Merge Slice Branches into the Controller's Epic Branch (`feat/<epic-slug>`):**
   In the controller worktree, merge each slice branch in deterministic order:
   ```bash
   git merge --no-ff slice/<epic-slug>-<slice-id> -m "chore(<scope>): integrate slice/<epic-slug>-<slice-id>"
   ```
   - If a parallel Wave produced a temporary companion spec (`libs/<scope>/docs/specs/YYYY-MM-DD-<slug>-<slice-id>.md`), fold its frontmatter lists (`enforced_by`, `spans`, `services`, `errors`) and requirement areas into the canonical `YYYY-MM-DD-<slug>.md` (maintaining strict sequential `### 1 · ...`, `### 2 · ...` area numbering and `REQ-<n>.<item>` IDs), delete the temporary companion spec file, and commit the folded spec on the controller branch.
2. **Clean Up Completed Slice Worktrees:**
   - **CRITICAL:** Always merge `slice/<epic-slug>-<slice-id>` into the controller branch **before** killing a `swarm` worker (`action: "kill"`, `name: "slice-<id>"`), because `swarm kill` permanently deletes the worker's `workspace: "share"` directory.
   - If using `swarm`, call `swarm` (`action: "kill"`, `name: "slice-<id>"`) after `git merge` succeeds.
   - Run `git worktree prune` if any linked worktree directories were removed.
3. **Reconcile Controller Omnigraph State Before Next Wave:**
   Run `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ingest` in the controller workspace so Omnigraph `main` and `.harness/graph-head.json` reflect the integrated Wave $w$ state before spawning Wave $w + 1$.

### Step D5 — Epic Closeout: ADR Promotion, 4-Lens Review & Final Stamp-Safe Gates (Stages 4–6)

Once the final Wave (`Wave K`) is merged into the controller's epic branch:

1. **Promote Full Epic ADR & Finalize EARS Spec Parity:**
   - Author/update `libs/<scope>/docs/adr/NNNN-<slug>.md` (`id: <scope>:ADR-NNNN`, `status: accepted`) using the canonical 6-section MADR structure (`## Context and Problem Statement`, `## Decision Drivers`, `## Considered Options` with `* **Option N:**`, `## Decision Outcome` opening with `**Chosen option:** "..."`, `## Rejected Alternatives` with `### N · <Name>` and `**Why rejected:**`, `## Consequences and Enforcement`).
   - Confirm `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` includes the complete union of `enforced_by`, `spans`, `services`, `errors`, and `informed_by: [<scope>:ADR-NNNN]`.
2. **Refresh Controller Plan Snapshot (`plan-check`):**
   Run `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check` in the controller workspace so `<controllerRoot>/.harness/plan-graph-snapshot.json` matches the complete integrated epic graph (preventing stale snapshot mismatches during final `done`).
3. **Execute Stage 4 (4-Lens Specialist Review Across Full Integrated Diff):**
   Dispatch the parallel read-only specialist reviewers (`effect-ears-test-reviewer`, `effect-adversarial-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`) once across `git diff main...HEAD`, adjudicate findings via Graph MCP, and apply all valid `fix`, `class-fix`, and `doc-sync-fix` items.
4. **Execute Stage 5 (Stamp-Safe `learn` & Final Deterministic Gates):**
   - Set EARS spec frontmatter to `status: accepted`.
   - Run `harness learn` and `harness learn --clear`.
   - Run the final gate sequence on the controller workspace:
     ```bash
     node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
     node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ontology check --strict
     node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts mutate --strict
     CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
     CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done
     ```
5. **Execute Stage 6 (Final Commit, Optional Push/PR & `<promise>DONE</promise>`).**
