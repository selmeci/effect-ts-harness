# Autonomous Intake, Worktree Isolation & EARS Auto-Specification (Stages 0–1)

This reference governs **Stage 0 (Worktree & Session Readiness)** and **Stage 1 (Route Intake & Autonomous EARS Specification)** of `effect-lfg`.

---

## 1. Stage 0 — Worktree Isolation & Session Readiness

Before modifying any tracked repository file:

1. **Detect Existing Isolation:**
   ```bash
   git rev-parse --absolute-git-dir
   (cd "$(git rev-parse --git-common-dir)" && pwd -P)
   git status -s
   ```
   - If the user explicitly asked for a new worktree, OR if the primary checkout contains unrelated uncommitted changes from another active session, create an isolated linked git worktree on a descriptive feature/fix branch (`feat/<slug>` or `fix/<slug>`):
     ```bash
     git worktree add -b feat/<slug> .harness/worktrees/feat-<slug> main
     ```
   - Placing linked worktrees under `.harness/worktrees/<slug>` (or using `HARNESS_WORKTREE_ID=<slug>`) ensures the main checkout's `.harness/verify-stamp.json` tree hash (`computeWorkspaceTreeHash`) is never polluted while sharing the canonical root Omnigraph cluster (`.harness/omnigraph-cluster`) via isolated branches (`plan/wt-<slug>`, `impl/wt-<slug>`).
2. **Inspect Session Readiness:**
   Run `harness session` (or inspect the `PreInvocation` / `SessionStart` hook payload) to verify active stubs, `.harness/verify-stamp.json` freshness, and Omnigraph connectivity.

---

## 2. Stage 1 — Route Classification (Precedence Order)

Classify the input request using bounded Graph MCP queries (`harness_resolve`, `harness_ontology_why`) and take the **first** matching route:

### Route A — Existing EARS Specification Path

- **Trigger:** The prompt names an existing EARS spec file (`libs/<scope>/docs/specs/YYYY-MM-DD-<slug>.md` or `docs/specs/YYYY-MM-DD-<slug>.md`) or resumes a spec already drafted in the current session.
- **Action:**
  1. Read the spec and verify its YAML frontmatter (`id`, `title`, `status`, `archetype`, `enforced_by`, `spans`, `services`, `errors`) and EARS table (`WHEN`, `IF/THEN`, `WHILE`, `WHERE`).
  2. Run `harness gc --strict` and `harness_ontology_check` to confirm zero syntax or ontology lint errors.
  3. Advance directly to **Stage 2 (`planning-effect-skeletons`)**.

### Route B — External PR or Code Review Feedback

- **Trigger:** The prompt provides a GitHub PR number/URL (`#42`, `https://github.com/.../pull/42`) or pasted review markdown (from Grok, Codex, Claude, or a human reviewer) asking to resolve feedback.
- **Action:**
  1. Execute the 5-phase `resolving-effect-review-feedback` workflow autonomously (Ingest $\rightarrow$ Central Graph MCP Adjudication $\rightarrow$ Spec/ADR Sync $\rightarrow$ Package-Isolated `gemini-4-hydrogen-medium` Fixers via `invoke_subagent` or `swarm`).
  2. Advance directly to **Stage 5 (Compounding Learnings & Final Deterministic Gate Sequence)** and **Stage 6 (Shipping)**.

### Route D — Multi-Phase RFC or Multi-Slice Epic (Worktree-per-Slice DAG)

- **Trigger:** The prompt names an RFC (`docs/rfcs/*.md`), a multi-phase plan (`docs/plans/*.md`), or a large requirement spanning **$\ge 4$ workspace packages** or **$\ge 2$ sequential architectural phases/milestones** (such as `RFC-0009` Phases `9A–9E`).
- **Action:**
  1. **Never** write one giant monolithic `stub<A, E, R>()` skeleton across all phases or copy unimplemented future-phase symbols (`enforced_by`, `spans`, `services`, `errors`) from an RFC's end-state Spec/ADR draft into `libs/<scope>/docs/` up front (which fails `unmapped-spec-symbol`, `dead-tagged-error`, and `stale-doc-reference`).
  2. Read [multi-slice-worktree-execution.md](multi-slice-worktree-execution.md) and decompose the epic into topological **Waves of Disjoint Slices** (`Wave 1 -> Wave 2 -> ... -> Wave K`).
  3. Dispatch each slice in a Wave to an isolated worktree subagent (`Workspace: "share"` in `invoke_subagent` or `workspace: "share"` in `swarm` with `HARNESS_WORKTREE_ID=slice-<id>`), where each slice worker runs its own scoped EARS increment (`status: proposed`), `plan-check`, implementation, `verify`, `done` (merging `impl/wt-slice-<id>` $\to$ `main` in the shared `.harness/omnigraph-cluster`), and commits to `slice/<epic-slug>-<slice-id>`.
  4. In the controller worktree, merge completed slice branches (`git merge --no-ff slice/<epic-slug>-<slice-id>`), clean up slice worktrees (`swarm kill` / `git worktree prune`), run `harness ingest`, and advance to the next Wave.
  5. Once all Waves are integrated, promote the full epic ADR (`status: accepted`), refresh `plan-check` on the controller workspace, and advance to **Stage 4 (4-Lens Review)**, **Stage 5 (Final Gates)**, and **Stage 6 (Shipping)**.

### Route C — Single-Slice Feature Requirement, Behavior Change, or Defect Report

- **Trigger:** Any single-slice feature request, enhancement, or bug report (`1–3` packages, single phase) that changes code and does not yet have a current EARS specification.
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
     - `WHEN <trigger>` $\rightarrow$ `Event-driven` (`UnitTest` / `TraceTest`)
     - `WHILE <state>` $\rightarrow$ `State-driven` pure `*.decide` with `R = never` (`GraphCheck` / `PropertyTest`)
     - `IF <condition>, THEN` $\rightarrow$ `Unwanted behaviour` failing with `Schema.TaggedError` (`UnitTest`)
     - `WHERE <feature>` $\rightarrow$ `Optional feature` provided via `Context.Service` / `Layer` / `Config` (`UnitTest` / `GraphCheck`)
   - Ensure strict 1:1 parity between `*Error` symbols in Mermaid diagrams, frontmatter `errors:`, and planned `EffectFn` error channels (`stale-doc-reference` & `dead-tagged-error` prevention).

4. **3-Role Self-Review & Deterministic Lint Gate:**
   - Audit the drafted spec through the 3 roles (Implementer, `@effect-ears-test-reviewer`, Source Author) to eliminate compound obligations (`"and shall"`), untestable clauses, or future-phase symbol leaks.
   - Run `harness_ontology_check` (or `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict`) to verify `EarsSpecLint.decide` passes with zero findings.
   - Immediately proceed to **Stage 2 (`planning-effect-skeletons`)** in the same turn.
