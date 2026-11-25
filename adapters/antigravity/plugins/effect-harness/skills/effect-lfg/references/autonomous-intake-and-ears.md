# Autonomous Intake, Worktree Isolation & EARS Auto-Specification (Stages 0–1)

This reference governs **Stage 0 (Worktree & Session Readiness)** and **Stage 1 (Route Intake & Autonomous EARS Specification)** of `effect-lfg`.

---

## 1. Stage 0 — Worktree Isolation & Session Readiness

Before modifying any tracked repository file:

1. **Detect Existing Isolation & Pin Controller Branch (`feat/<slug>` or `fix/<slug>`):**
   ```bash
   git rev-parse --absolute-git-dir
   git rev-parse --git-common-dir
   git status -s
   git branch --show-current
   ```
   - If already inside a linked worktree (`.harness/worktrees/*`), work in place on its feature branch and never run `git worktree add` to nest a subdirectory inside that worktree.
   - If in the primary checkout and the user requested a new worktree, OR if the primary checkout contains unrelated uncommitted changes from another session, create a sibling linked git worktree on `feat/<slug>` (or `fix/<slug>`):
     ```bash
     git worktree add -b feat/<slug> .harness/worktrees/feat-<slug> main
     ```
   - Otherwise, if in a clean primary checkout on `main`, switch to `feat/<slug>` (`git switch -c feat/<slug>`).
   - **Two-Tier Worktree Rule (`Workspace: "share"` vs. `HARNESS_WORKTREE_ID`):**
     - Inside any linked git worktree (`Workspace: "share"` or `.harness/worktrees/<slug>`), keep `HARNESS_WORKTREE_ID` **unset**: the worktree's own `<worktreeRoot>/.harness/` directory isolates `plan-graph-snapshot.json`, `graph-snapshot.json`, `verify-stamp.json`, and `graph-head.json`, while `resolveOmnigraphTaskBranches` (`libs/harness/graph/src/cluster-resolver.ts`) automatically binds to the shared `<canonicalRoot>/.harness/omnigraph-cluster` via `plan/wt-<worktree-basename>` and `impl/wt-<worktree-basename>`.
     - Reserve `HARNESS_WORKTREE_ID=<unit>` strictly for Stage 3 package implementers or Phase 4 review fixers running package-level checks (`CI=true pnpm nx run <project>:verify`) inside a shared checkout (`workspace: "inherit"`).
2. **Inspect Session Readiness:**
   Run `pnpm harness session` (or `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts session`) to verify active stubs, `.harness/verify-stamp.json` freshness, and Omnigraph connectivity.

---

## 2. Stage 1 — Route Classification (Precedence Order)

Classify the input request using bounded Graph MCP queries (`harness_resolve`, `harness_ontology_why`) and take the **first** matching route in this exact order:

### Route B — External PR or Code Review Feedback

- **Trigger:** The prompt provides a GitHub PR number/URL (`#42`, `https://github.com/.../pull/42`) or pasted review markdown (from Grok, Codex, Claude, or a human reviewer) asking to resolve feedback.
- **Action:**
  1. Execute the 5-phase `resolving-effect-review-feedback` workflow autonomously (Ingest -> Central Graph MCP Adjudication -> Spec/ADR Sync -> Package-Isolated `gemini-4-hydrogen-medium` Fixers via `invoke_subagent` or `swarm`).
  2. Advance directly to **Stage 5 (Stamp-Safe LLM Phase & Durable `ShipWorkflow` Pipeline)** and **Stage 6 (Shipping)**.

### Route D — Multi-Phase RFC or Multi-Slice Epic (Worktree-per-Slice DAG)

- **Trigger:** The prompt names an RFC (`docs/rfcs/*.md`), a multi-phase plan (`docs/plans/*.md`), an in-progress multi-slice branch (`slice/<epic-slug>-*` or `integrate slice/` commits on `feat/<epic-slug>`), OR a requirement that **either (a) defines `>= 2` sequential implementation phases/milestones OR (b) modifies `>= 4` workspace packages** (such as [RFC-0010 §10](../../../../../docs/rfcs/0010-omnigraph-v014-native-capabilities-and-harness-integration.md#10-rollout--decomposition-plan-adrs-ears-specs--implementation-milestones)).
  _(Note: Route D is evaluated before Route A so resuming an interrupted multi-slice epic whose `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` already exists on disk never falls through to single-slice Route A. A single-phase RFC touching `1–3` packages takes Route C.)_
- **Action:**
  1. **Never** write one monolithic `stub<A, E, R>()` skeleton across all phases or copy unimplemented future-phase symbols (`enforced_by`, `spans`, `services`, `errors`) from an RFC's end-state Spec/ADR draft into `libs/<scope>/docs/` up front (which fails `unmapped-spec-symbol`, `dead-tagged-error`, and `stale-doc-reference`).
  2. Read [multi-slice-worktree-execution.md](multi-slice-worktree-execution.md) and decompose the epic into topological **Waves of Disjoint Slices** (`Wave 1 -> Wave 2 -> ... -> Wave K`).
  3. Record `EPIC_BASE_SHA=$(git rev-parse HEAD)` on `feat/<epic-slug>` and dispatch each slice in Wave `w` to an isolated worktree subagent (`Workspace: "share"` in `invoke_subagent` for `1–2` slices, or `workspace: "share"` in `swarm` for `3+` slices, with `HARNESS_WORKTREE_ID` unset). Each slice worker runs `plan-check` -> implements -> runs `gc --strict` / `ontology check --strict` / `mutate --strict` / `CI=true pnpm harness verify` (never `harness done`), and commits to `slice/<epic-slug>-<slice-id>`.
  4. In the controller worktree on `feat/<epic-slug>`, merge completed slice branches (`git merge --no-ff slice/<epic-slug>-<slice-id>`), update the cumulative `libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` (`status: proposed`), run inter-wave `pnpm harness plan-check`, `pnpm harness gc --strict`, and `pnpm harness ontology check --strict`, clean up slice worktrees (`swarm kill` / `git worktree prune`), and advance to Wave `w + 1`.
  5. Once all Waves are integrated, promote the full epic ADR (`status: accepted`), refresh `pnpm harness plan-check` on the controller workspace, and advance to **Stage 4 (Signal-Routed 7-Lens Review)**, **Stage 5 (LLM Phase + `pnpm harness workflow ship [--run <id>]`)**, and **Stage 6 (Shipping)**.

### Route A — Existing Single-Slice EARS Specification Path

- **Trigger:** The prompt names an existing single-slice EARS spec file (`libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` or `docs/specs/YYYY-MM-DD-<slug>.md`) that is not part of a multi-slice Route D epic.
- **Action:**
  1. Read the spec and verify its YAML frontmatter (`id`, `title`, `status`, `archetype`, `enforced_by`, `spans`, `services`, `errors`) and EARS table (`WHEN`, `IF/THEN`, `WHILE`, `WHERE`).
  2. Run `pnpm harness gc --strict` and `harness_ontology_check` to confirm zero syntax or ontology lint errors.
  3. Advance directly to **Stage 2 (`planning-effect-skeletons`)**.

### Route C — Single-Slice Feature Requirement, Behavior Change, or Defect Report

- **Trigger:** Any single-phase feature request, enhancement, bug report, or single-phase RFC touching **`1–3` workspace packages** (`< 4` packages and `1` phase) that changes code and does not yet have a current EARS specification.
- **Action:** Execute the **Autonomous EARS Specification Protocol** below.

---

## 3. Autonomous EARS Specification Protocol (Pipeline Override for `specifying-ears-with-effect`)

Standard `specifying-ears-with-effect` pauses to interview the user and waits for human approval of the EARS spec before `planning-effect-skeletons`. Under `effect-lfg`, **never pause for spec approval**:

1. **Graph & Ontology Grounding First (Zero Guessing):**
   - Call `harness_resolve` and `harness_callers` on related domain symbols (`EffectFn`, `ServiceTag`, `TaggedError`).
   - Call `harness_ontology_why` and `harness_ontology_impact` to inspect existing ArchiMate layers (`Motivation -> Business -> Application -> Technology`) and governing `AdrDoc` (`<scope>:ADR-NNNN`) / `EarsSpec` (`<scope>:SPEC-NNNN`) constraints.
   - Determine the package **Archetype**:
     - `application`: user-facing business domains live in `type:domain` (`*.decide`, use cases).
     - `framework`: generic engines/protocols live in `type:core` / `type:contract`; sample business entities (`Cart`, `Order`, `Inventory`) belong strictly to `test/fixtures/**` with `scope:fixture`.

2. **Autonomous Disambiguation via Explicit `## Assumptions`:**
   - **Blocking Contradiction Check:** Stop and escalate **only** if the request directly contradicts an `accepted` ADR, demands a destructive database migration (`DROP TABLE`, `DROP COLUMN`, table rebuild), or is logically self-contradictory with no safe interpretation.
   - **Non-Blocking Defaults:** For all other underspecified details (default limits, error tag names, return payload shape, idempotency behavior), choose the simplest idiomatic Effect v4 design consistent with existing contracts and record every default explicitly under `## Assumptions` and `## Out of scope` in the EARS spec. Never smuggle silent assumptions into code without documenting them in `## Assumptions`.

3. **Draft Canonical EARS Specification (`libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md`):**
   - Include complete YAML frontmatter (`id: <scope>:SPEC-NNNN`, `title`, `status: proposed`, `archetype`, `date`, `enforced_by`, `spans`, `services`, `errors`).
   - Map every requirement row to concrete Effect symbols (never generic `"the system shall"`):
     - `WHEN <trigger>` -> `Event-driven` (`UnitTest` / `TraceTest`)
     - `WHILE <state>` -> `State-driven` pure `*.decide` with `R = never` (`GraphCheck` / `PropertyTest`)
     - `IF <condition>, THEN` -> `Unwanted behaviour` failing with `Schema.TaggedError` (`UnitTest`)
     - `WHERE <feature>` -> `Optional feature` provided via `Context.Service` / `Layer` / `Config` (`UnitTest` / `GraphCheck`)
   - Number all `### <n> · <Title>` requirement areas sequentially `1, 2, 3, ...` with no gaps and matching `REQ-<n>.1, REQ-<n>.2` row IDs (`EarsSpecLint.decide` `area-structure` & `numbering-gap`).
   - Ensure strict 1:1 parity between `*Error` symbols in Mermaid diagrams, frontmatter `errors:`, and planned `EffectFn` error channels (`stale-doc-reference` & `dead-tagged-error` prevention).

4. **3-Role Self-Review & Deterministic Lint Gate:**
   - Audit the drafted spec through the 3 roles (Implementer, `@effect-ears-test-reviewer`, Source Author) to eliminate compound obligations (`"and shall"`), untestable clauses, or future-phase symbol leaks.
   - Run `harness_ontology_check` and `pnpm harness gc --strict` to verify `EarsSpecLint.decide` passes with zero findings.
   - Immediately proceed to **Stage 2 (`planning-effect-skeletons`)** in the same turn.
