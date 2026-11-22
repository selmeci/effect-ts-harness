---
title: "SPEC-0030 Implementation Plan: Sliced Diff Specialist Review Routing, Seam Checklist, and Mandatory Remediation Re-Audit"
type: feat
status: proposed
date: 2026-11-22
spec: harness:SPEC-0030
---

# Goal

Implement `harness:SPEC-0030` (P2-B of the PR #44 post-mortem harness hardening roadmap) across `@harness/contract`, `@harness/decision`, `@harness/gates`, `harness-mcp`, and Antigravity / Claude Code adapter skills: add deterministic review-slice partitioning for large diffs, add monotonic `remediationContext` specialist re-audit routing, and enforce symmetric Swarm Seam Checklists and remediation re-audit directives across both adapters.

---

## 1. Scope & Line-Budget Decomposition Strategy

`libs/harness/decision/src/review-router-decision.ts` is currently 695 lines and `apps/harness-mcp/src/tools/review-route-helpers.ts` is 380 lines. Keep every edited file comfortably within file-size limits:

1. `libs/harness/decision/src/review-slice-partitioner.ts` (`<= 160` lines) — pure helper implementing `partitionDiffReviewSlices(signals, wholePlan)` using `REVIEW_SLICE_FILE_THRESHOLD` (`12` changed files).
2. `libs/harness/contract/src/review-routing.ts` — add branded `ReviewSliceId`, `ReviewSlicePlan`, `RemediationContext`, `REVIEW_SLICE_FILE_THRESHOLD`, optional `reviewSlices` on `ReviewRouteToolOutput`, and optional `remediationContext` on `ReviewRawDiffInput` / `ReviewDiffSignals`.
3. Adapter skills (`effect-lfg`, `executing-effect-stubs`, `resolving-effect-review-feedback`, `effect-code-review`) mirrored cleanly across `adapters/antigravity/plugins/effect-harness/skills/` and `adapters/claude-code/skills/`, audited by `GraphGc.decide` (`gc-doc-truth.plugin.ts`) and `apps/harness-cli/test/adapter-config.test.ts`.

---

## 2. Effect Building-Block Mapping & Exact File Changes

### Unit 1 · Deterministic Review Slices & Remediation Monotonicity (`REQ-1.1`..`REQ-1.2`, `REQ-3.1`..`REQ-3.2`)

- **Review Routing Contracts (`libs/harness/contract/src/review-routing.ts`):**
  - Export `REVIEW_SLICE_FILE_THRESHOLD = 12` (bounded positive `Schema.Int` / `ReviewChangedLines` constraint).
  - Add `ReviewSliceId` (`Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()), Schema.brand("ReviewSliceId"))`), `ReviewSlicePlan` (`Schema.Struct({ sliceId: ReviewSliceId, label: ReviewRoutingReason, files: Schema.NonEmptyArray(ReviewSignalPath), selections: Schema.NonEmptyArray(ReviewerSelection) })`), and optional `RemediationFindingSeverity` (`"blocker" | "critical" | "major" | "minor"`) + `RemediationReviewContext` (`Schema.Struct({ priorSpecialists: Schema.NonEmptyArray(ReviewerId), maxSeverity: RemediationFindingSeverity })`).
  - Add optional `remediationContext` field on `ReviewRawDiffInput` & `ReviewDiffSignals`, and optional `reviewSlices` field on `ReviewRouteToolOutput` (and MCP `ReviewRouteInputSchema` in `review-route-helpers.ts`).
- **Pure Slice Partitioner (`libs/harness/decision/src/review-slice-partitioner.ts`, `review-router-decision.ts`, `graph-navigation.tools.ts`):**
  - Group `changedFiles` deterministically by Nx package root (`libs/<domain>/<pkg>` / `apps/<app>` / `adapters/<adapter>` / `root`), splitting oversized groups deterministically so every slice remains focused while preserving 100% file union coverage and zero duplicate file assignment.
  - Route each slice through `ReviewRouter.decideDeterministic` and compute `ReviewSlicePlan` selections; emit `reviewSlices` only when `signals.changedFiles.length >= REVIEW_SLICE_FILE_THRESHOLD` and plan is `ActiveReviewPlan`.
  - When `remediationContext` is present and `maxSeverity` is `"blocker"`, `"critical"`, or `"major"`, enforce `depth >= "focused"` and union every `priorSpecialists` entry as `mandatory: true` inside `ReviewRouter.decideDeterministic` (and `mergeAdvisoryIntoDeterministicPlan` so optional DecisionModel hints can never strip remediation specialists or downgrade depth).
  - Wire optional `reviewSlices` and `remediationContext` passthrough into `apps/harness-mcp/src/tools/review-route-helpers.ts` and `graph-navigation.tools.ts` (`HarnessMcp.routeReview`).

### Unit 2 · Symmetric Seam Checklist & Remediation Re-Audit Enforcement (`REQ-2.1`..`REQ-2.2`)

- **Implementation Skills (`effect-lfg/SKILL.md`, `executing-effect-stubs/SKILL.md` in both adapters):**
  - Add identical `### Swarm Seam Checklist (Pre-Review)` section requiring verification of: (a) symmetric codec encode/decode across producer & consumer packages, (b) single-source timeout budget hierarchy (`WORKFLOW_TIMEOUT_BUDGETS`), (c) fenced non-lease mutations (`expectedLeaseEpoch`), and (d) differential replay parity before invoking review routing.
- **Review & Remediation Skills (`effect-code-review/SKILL.md`, `resolving-effect-review-feedback/SKILL.md` in both adapters):**
  - Add explicit requirement to pass `remediationContext` (`priorSpecialists`, `maxSeverity`) into `HarnessMcp.routeReview` / `pnpm harness route` after fixing `blocker`/`critical`/`major` findings and run a mandatory 2nd-pass specialist audit on remediation commits before reporting done.
- **Parity Audit (`libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`, `apps/harness-cli/test/adapter-config.test.ts`):**
  - Extend `GraphGc.decide` adapter skill parity check and `adapter-config.test.ts` so Antigravity and Claude Code copies of all four workflow skills stay synchronized on Seam Checklist and remediation re-audit markers.

---

## 3. Adversarial, Negative & Mutation Test Matrix

| Target File                                                 | Positive Coverage                                                                       | Negative / Fault Coverage                                                                    | Property / Determinism Check                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `libs/harness/decision/test/review-router-decision.test.ts` | Diff with `>= 12` files produces clean disjoint `reviewSlices`; small diff omits slices | `remediationContext` (`critical`/`major`) prevents `lite` downgrade & keeps prior specialist | `it.prop` across arbitrary valid paths proving 100% partition union completeness & sorted order invariance |
| `apps/harness-mcp/test/review-route.test.ts`                | `HarnessMcp.routeReview` returns `reviewSlices` on large multi-package diff             | Invalid `remediationContext` / empty `priorSpecialists` rejected by `ReviewRouteInputSchema` | Deterministic slice IDs across repeated identical inputs                                                   |
| `apps/harness-cli/test/adapter-config.test.ts`              | Both Antigravity & Claude Code skills include identical Seam Checklist & re-audit rules | Simulated removal of checklist heading triggers parity failure                               | Exact cross-adapter equality assertion across all mirrored skill pairs                                     |

---

## 4. Execution & Verification Sequence

1. Run `pnpm harness plan-check` if any new exported spans are introduced.
2. Implement Units 1–2, set `harness:SPEC-0030` frontmatter to `status: accepted`, and update `docs/specs/README.md`.
3. Format ONLY touched files via `pnpm oxfmt --write <explicit paths>` and confirm `pnpm oxfmt --check <explicit paths>`.
4. Run full deterministic gate sequence with zero edits in between:
   - `pnpm harness learn --clear`
   - `pnpm harness gc --strict`
   - `pnpm harness ontology check --strict`
   - `pnpm harness mutate --strict`
   - `CI=true pnpm harness verify`
   - `CI=true pnpm harness done`
