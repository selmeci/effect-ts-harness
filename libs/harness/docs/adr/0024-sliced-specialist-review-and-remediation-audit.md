---
id: harness:ADR-0024
title: Sliced Diff Specialist Review Routing, Seam Checklist, and Mandatory Remediation Re-Audit
status: accepted
date: 2026-11-22
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/review-routing.ts
  - libs/harness/decision/src/review-slice-partitioner.ts
  - libs/harness/decision/src/review-signal-inference.ts
  - libs/harness/decision/src/review-router-decision.ts
  - apps/harness-mcp/src/tools/review-route-helpers.ts
  - apps/harness-mcp/src/tools/graph-navigation.tools.ts
  - libs/harness/gates/src/plugins/gc/gc-adapter-skill-parity.ts
  - libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-workspace-io.ts
  - libs/harness/decision/test/review-router.test.ts
  - apps/harness-mcp/test/review-route.test.ts
  - libs/harness/gates/test/gc-doc-truth.test.ts
  - apps/harness-cli/test/adapter-config.test.ts
spans:
  - ReviewRouter.inferDiffSignals
  - ReviewRouter.decideDeterministic
  - Harness.routeReviewDiff
  - HarnessMcp.routeReview
  - GraphGc.decide
services: []
errors: []
informs:
  - harness:SPEC-0030
---

# ADR-0024 · Sliced Diff Specialist Review Routing, Seam Checklist, and Mandatory Remediation Re-Audit

## Context and Problem Statement

Post-mortem review of PR #44 identified three review-coverage and multi-agent coordination gaps in large workflow-engine diffs. First, a flat `ReviewRoutingPlan` over 30+ changed files forces specialist reviewers to skim unrelated packages in a single pass where cross-package codec, timeout, fencing, and replay defects can hide.

Second, implementation workflows (`effect-lfg` and `executing-effect-stubs`) across both Antigravity and Claude Code lacked a symmetric Swarm Seam Checklist verifying cross-package contracts before invoking review routing. Third, remediation routing did not monotonically encode prior `blocker`/`critical`/`major` specialist lenses into `ReviewRawDiffInput`, permitting a subsequent remediation diff to downgrade to `skip` or `lite` or drop the original specialist lenses.

## Decision Drivers

- **Deterministic Disjoint Review Slices Above `REVIEW_SLICE_FILE_THRESHOLD`:** Partition large diffs (`>= 12` changed files) deterministically by Nx package root into disjoint sorted `ReviewSlicePlan` units covering 100% of `changedFiles` while keeping whole-diff `ActiveReviewPlan` depth and mandatory specialist invariants intact.
- **Byte-for-Byte Small-Diff Compatibility:** Omit `reviewSlices` when `changedFiles.length < REVIEW_SLICE_FILE_THRESHOLD` and preserve `SkipReviewPlan` behavior whenever `remediationContext` is omitted or `maxSeverity === "minor"`.
- **Monotonic Second-Pass Remediation Floor:** Encode optional `remediationContext` (`priorSpecialists`, `maxSeverity`) into `@harness/contract` so `ReviewRouter.inferDiffSignals`, `ReviewRouter.decideDeterministic`, `Harness.routeReviewDiff`, and `HarnessMcp.routeReview` never downgrade depth below `focused` or drop prior specialists on `blocker`/`critical`/`major` findings.
- **Symmetric Cross-Adapter Checklist & Re-Audit Governance:** Enforce byte-identical `### Swarm Seam Checklist (Pre-Review)` and `### Mandatory Second-Pass Remediation Re-Audit` sections across Antigravity and Claude Code via `GraphGc.decide` (`adapter-skill-parity`) without leaking adapter-specific runtime identifiers across adapters.

## Considered Options

- **Option 1:** Add optional `reviewSlices` and `remediationContext` contracts in `@harness/contract`, extract pure slice partitioning in `review-slice-partitioner.ts`, enforce remediation monotonicity in `review-router-decision.ts`, pass both through `HarnessMcp.routeReview`, and enforce cross-adapter skill parity in `GraphGc.decide` (`gc-adapter-skill-parity.ts`).
- **Option 2:** Keep flat whole-diff plans in `@harness/decision` and instruct review skills in Markdown to slice files ad hoc via subagent prompts without contract schemas or parity gates.
- **Option 3:** Replace `ActiveReviewPlan.selections` with per-slice selections only, removing whole-diff specialist routing and dropping backward compatibility for callers under `REVIEW_SLICE_FILE_THRESHOLD`.

## Decision Outcome

**Chosen option:** "Option 1: Add optional `reviewSlices` and `remediationContext` contracts in `@harness/contract`, extract pure slice partitioning in `review-slice-partitioner.ts`, enforce remediation monotonicity in `review-router-decision.ts`, pass both through `HarnessMcp.routeReview`, and enforce cross-adapter skill parity in `GraphGc.decide` (`gc-adapter-skill-parity.ts`)", because additive schemas preserve existing `SPEC-0013` guarantees for small diffs while giving orchestrators and `GraphGc.decide` deterministic slice partitions, monotonic remediation re-audit floors, and machine-checked cross-adapter skill symmetry.

### Architectural Rules and Guarantees

1. **Additive Sliced Review Contracts (`SPEC-0030 REQ-1.1`, `SPEC-0030 REQ-1.2`, `SPEC-0030 REQ-3.1`, `SPEC-0030 REQ-3.2`):** `libs/harness/contract/src/review-routing.ts` exports bounded `ReviewSliceFileCount`, `REVIEW_SLICE_FILE_THRESHOLD = 12`, `ReviewSliceId`, `ReviewSlicePlan`, `REMEDIATION_FINDING_SEVERITIES`, `RemediationFindingSeverity`, and `RemediationReviewContext`, plus optional `remediationContext` on `ReviewRawDiffInput`/`ReviewDiffSignals` and optional `reviewSlices` on `ActiveReviewPlan`/`ReviewRouteToolOutput`.
2. **Pure Disjoint Partitioning & Monotonic Remediation Floor (`SPEC-0030 REQ-1.1`, `SPEC-0030 REQ-1.2`, `SPEC-0030 REQ-3.1`, `SPEC-0030 REQ-3.2`):** `libs/harness/decision/src/review-slice-partitioner.ts` (`partitionDiffReviewSlices`, `resolveReviewSliceUnitKey`) groups `changedFiles` deterministically by Nx package root (`libs/<scope>/<pkg>`, `apps/<app>`, `adapters/<adapter>`, `tools/<tool>`, top-level dir, or `root`) sorted by `compareCodeUnits` and chunks oversized units at `threshold`. `libs/harness/decision/src/review-signal-inference.ts` implements `inferReviewDiffSignals` (`ReviewRouter.inferDiffSignals`) and `attachReviewSlicesIfThresholdReached`, while `libs/harness/decision/src/review-router-decision.ts` implements `ReviewRouter.decideDeterministic` and `Harness.routeReviewDiff` (re-exporting the signal/slice helpers), preventing `SkipReviewPlan`, enforcing depth `>= focused`, preserving deduplicated `priorSpecialists` as `mandatory: true` for `blocker`/`critical`/`major` findings, and attaching `reviewSlices` across deterministic, model-promoted, and degraded paths. `apps/harness-mcp/src/tools/review-route-helpers.ts` and `apps/harness-mcp/src/tools/graph-navigation.tools.ts` (`HarnessMcp.routeReview`) validate `remediationContext`, preserve slices across manifest diagnostic escalation, and return `reviewSlices` on `ReviewRouteToolOutput`.
3. **Symmetric Adapter Skill Checklists & Re-Audit Parity (`SPEC-0030 REQ-2.1`, `SPEC-0030 REQ-2.2`):** `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts` defines `"adapter-skill-parity"` in `GcFindingKind`, and `libs/harness/gates/src/plugins/gc/gc-adapter-skill-parity.ts` (`ADAPTER_SKILL_PARITY_CLAUSES`, `auditAdapterSkillParityPair`, `checkAdapterSkillParity`) runs inside `evaluateDocTruthPlugin` (`gc-doc-truth.plugin.ts`, invoked by `GraphGc.decide`) alongside `apps/harness-cli/test/adapter-config.test.ts` to verify matching headings, required tokens, and exact subsection symmetry across both adapters for `effect-lfg`, `executing-effect-stubs`, `effect-code-review`, and `resolving-effect-review-feedback`.

## Rejected Alternatives

### 1 · Option 2: Markdown-Only Ad-Hoc Slicing Without Contracts or Gates

Leave `ReviewRouteToolOutput` flat and rely on skill prose alone to partition large diffs and re-run specialists after fixes.

**Why rejected:** Ad-hoc prompting provides zero deterministic guarantees on disjoint coverage, chunk sizing, remediation depth floors, or Antigravity-vs-Claude Code skill synchronization.

### 2 · Option 3: Replacing Whole-Diff Selections With Slice-Only Selections

Drop whole-diff `ActiveReviewPlan.selections` and emit per-slice plans regardless of diff size.

**Why rejected:** Removing whole-diff selections breaks `SPEC-0013` monotonicity for cross-package callers and eliminates unified whole-PR seam visibility when a small diff spans two tiers.

## Consequences and Enforcement

### Positive Consequences

- Large multi-package PRs automatically yield deterministic, cacheable, disjoint `reviewSlices` for parallel subagent dispatch without weakening whole-PR specialist selection or depth guarantees.
- Remediation commits for `blocker`, `critical`, or `major` findings cannot silently skip review or drop cited specialist lenses even on tiny follow-up diffs.
- Antigravity and Claude Code workflow skills remain deterministically synchronized on cross-seam checklists and second-pass remediation re-audits under `pnpm harness gc --strict`.

### Negative Consequences and Trade-offs

- Adding new cross-adapter shared skill clauses requires synchronizing both Antigravity and Claude Code `SKILL.md` copies simultaneously or adding clause entries in `ADAPTER_SKILL_PARITY_CLAUSES`.
- Callers routing single-package diffs with more than `REVIEW_SLICE_FILE_THRESHOLD` files receive numbered `#1`, `#2` slices that still share the same package tier context.

### Deterministic Enforcement

| Rule                                                                                                                 | Enforced By                                                                                                                                                                                                                                                                        | Gate / Mechanism                                                                                                                                                               | Governed Symbols                                              |
| :------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------ |
| Sliced review & remediation contracts (`REVIEW_SLICE_FILE_THRESHOLD`, `ReviewSlicePlan`, `RemediationReviewContext`) | `libs/harness/contract/src/review-routing.ts`, `apps/harness-mcp/src/tools/review-route-helpers.ts`, `apps/harness-mcp/src/tools/graph-navigation.tools.ts`, `apps/harness-mcp/test/review-route.test.ts`                                                                          | Branded bounded Effect v4 `Schema` contracts, `ReviewRouteInputSchema`, and MCP tool integration tests                                                                         | `ReviewRouter.inferDiffSignals`, `HarnessMcp.routeReview`     |
| Disjoint package slice partitioning & monotonic `remediationContext` depth/specialist floor                          | `libs/harness/decision/src/review-slice-partitioner.ts`, `libs/harness/decision/src/review-signal-inference.ts`, `libs/harness/decision/src/review-router-decision.ts`, `libs/harness/decision/test/review-router.test.ts`                                                         | `partitionDiffReviewSlices`, `resolveReviewSliceUnitKey`, `attachReviewSlicesIfThresholdReached`, and monotonic floor/model merge + `it.effect.prop` tests                     | `ReviewRouter.decideDeterministic`, `Harness.routeReviewDiff` |
| Symmetric Swarm Seam Checklist & Mandatory Second-Pass Remediation Re-Audit across Antigravity and Claude Code       | `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts`, `libs/harness/gates/src/plugins/gc/gc-adapter-skill-parity.ts`, `libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`, `libs/harness/gates/test/gc-doc-truth.test.ts`, `apps/harness-cli/test/adapter-config.test.ts` | `adapter-skill-parity` (`ADAPTER_SKILL_PARITY_CLAUSES`, `auditAdapterSkillParityPair`, `checkAdapterSkillParity`) inside `evaluateDocTruthPlugin` & cross-adapter config suite | `GraphGc.decide`                                              |
