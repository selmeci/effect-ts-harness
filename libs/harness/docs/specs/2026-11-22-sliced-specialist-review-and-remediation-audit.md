---
id: harness:SPEC-0030
title: Sliced Diff Specialist Review Routing, Seam Checklist, and Mandatory Remediation Re-Audit
status: proposed
archetype: framework
date: 2026-11-22
owners:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/review-routing.ts
  - libs/harness/decision/src/review-slice-partitioner.ts
  - libs/harness/decision/src/review-router-decision.ts
  - apps/harness-mcp/src/tools/review-route-helpers.ts
  - apps/harness-mcp/src/tools/graph-navigation.tools.ts
  - adapters/antigravity/plugins/effect-harness/skills/effect-code-review/SKILL.md
  - adapters/claude-code/skills/effect-code-review/SKILL.md
  - adapters/antigravity/plugins/effect-harness/skills/resolving-effect-review-feedback/SKILL.md
  - adapters/claude-code/skills/resolving-effect-review-feedback/SKILL.md
  - adapters/antigravity/plugins/effect-harness/skills/effect-lfg/SKILL.md
  - adapters/claude-code/skills/effect-lfg/SKILL.md
  - adapters/antigravity/plugins/effect-harness/skills/executing-effect-stubs/SKILL.md
  - adapters/claude-code/skills/executing-effect-stubs/SKILL.md
  - apps/harness-cli/test/adapter-config.test.ts
  - apps/harness-mcp/test/review-route.test.ts
  - libs/harness/decision/test/review-router-decision.test.ts
spans:
  - ReviewRouter.inferDiffSignals
  - ReviewRouter.decideDeterministic
  - Harness.routeReviewDiff
  - HarnessMcp.routeReview
  - GraphGc.decide
services: []
errors: []
---

## Context

Post-mortem review of PR #44 identified three review-coverage and multi-agent coordination gaps when shipping large workflow-engine changes. First, `Harness.routeReviewDiff` (`libs/harness/decision/src/review-router-decision.ts`) and `HarnessMcp.routeReview` (`apps/harness-mcp/src/tools/graph-navigation.tools.ts`) currently emit one flat reviewer plan across the entire diff regardless of size, forcing specialist reviewers to skim 30+ changed files in a single pass where cross-package seam bugs easily hide.

Second, implementation skills (`effect-lfg` and `executing-effect-stubs`) across both `adapters/antigravity` and `adapters/claude-code` lack a standardized Swarm Seam Checklist verifying cross-package wire/activity formats, timeout hierarchy, lease fencing, and journal replay symmetry before specialist review begins. Third, remediation workflows (`resolving-effect-review-feedback` and `effect-code-review`) do not programmatically enforce a second-pass specialist re-audit on remediation diffs or preserve at least `focused` depth for the findings' original specialist lenses.

- **Reused Contracts / Errors:** `ReviewRawDiffInput`, `ReviewRouteToolOutput`, `ReviewRoutingPlan`, `ReviewDepth`, `ReviewerId`, `InvalidReviewRouteInputError` from `@harness/contract`
- **Reused Services:** `DecisionModel` from `@harness/decision` (optional advisory evaluation preserved under `SPEC-0013` monotonicity)
- **New Capabilities Needed:** Pure diff slice partitioning helper (`review-slice-partitioner.ts`) emitting additive `reviewSlices` above `REVIEW_SLICE_FILE_THRESHOLD`, optional `remediationContext` monotonic floor in `review-routing.ts` and `ReviewRouter.decideDeterministic`, and symmetric Seam Checklist + remediation re-audit skill rules validated by `GraphGc.decide` and `adapter-config.test.ts`

## Goal

Large PR diffs above `REVIEW_SLICE_FILE_THRESHOLD` deterministically partition into cohesive domain/package `reviewSlices` without weakening whole-diff `ActiveReviewPlan` invariants, both Antigravity and Claude Code adapters enforce identical Swarm Seam Checklists and mandatory remediation re-audits, and remediation routing with `remediationContext` never downgrades below `focused` or drops prior specialist lenses.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Deterministic Review Slice Partitioning for Large Diffs

**Source (`libs/harness/contract/src/review-routing.ts`, `libs/harness/decision/src/review-router-decision.ts`, `apps/harness-mcp/src/tools/review-route-helpers.ts`, `apps/harness-mcp/src/tools/graph-navigation.tools.ts`):** Pure partitioner logic in `review-slice-partitioner.ts` computes additive `reviewSlices` when `changedFiles` reaches `REVIEW_SLICE_FILE_THRESHOLD`.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                              | Effect Symbol                    | Verification |
| ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------ |
| REQ-1.1 | Event-driven | **When** `Harness.routeReviewDiff` or `HarnessMcp.routeReview` routes an active diff whose deduplicated `changedFiles` count reaches `REVIEW_SLICE_FILE_THRESHOLD`, `review-slice-partitioner.ts` **shall** deterministically group files by Nx package unit into additive `reviewSlices` on the output. | HarnessMcp.routeReview           | UnitTest     |
| REQ-1.2 | Event-driven | **When** `ReviewRouter.decideDeterministic` emits `reviewSlices` for a multi-package diff, `ReviewRouter.decideDeterministic` **shall** cover 100% of `changedFiles` across disjoint slice partitions while preserving overall `ActiveReviewPlan` depth and mandatory specialist union invariants.       | ReviewRouter.decideDeterministic | UnitTest     |

### 2 · Symmetric Cross-Seam Swarm Checklist Across Adapters

**Source (`adapters/antigravity/plugins/effect-harness/skills/effect-lfg/SKILL.md`, `adapters/claude-code/skills/effect-lfg/SKILL.md`, `adapters/antigravity/plugins/effect-harness/skills/executing-effect-stubs/SKILL.md`, `adapters/claude-code/skills/executing-effect-stubs/SKILL.md`, `apps/harness-cli/test/adapter-config.test.ts`):** Both adapter skill bundles declare and test the exact same cross-seam verification checklist before marking parallel implementation ready for review.

| ID      | Pattern          | Requirement                                                                                                                                                                                                                                                                               | Effect Symbol  | Verification |
| ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------ |
| REQ-2.1 | Optional feature | **Where** Antigravity or Claude Code plugins define `effect-lfg` or `executing-effect-stubs` workflows, both adapters **shall** include a symmetric Swarm Seam Checklist requiring explicit verification of activity/deferred codecs, timeout budgets, and fencing before review.         | GraphGc.decide | UnitTest     |
| REQ-2.2 | Event-driven     | **When** `GraphGc.decide` audits adapter skill parity across Antigravity and Claude Code, `GraphGc.decide` **shall** verify that `effect-lfg`, `executing-effect-stubs`, `effect-code-review`, and `resolving-effect-review-feedback` preserve identical Swarm Seam and re-audit clauses. | GraphGc.decide | UnitTest     |

### 3 · Mandatory Second-Pass Remediation Specialist Re-Audit

**Source (`libs/harness/contract/src/review-routing.ts`, `libs/harness/decision/src/review-router-decision.ts`, `adapters/antigravity/plugins/effect-harness/skills/resolving-effect-review-feedback/SKILL.md`, `adapters/claude-code/skills/resolving-effect-review-feedback/SKILL.md`, `adapters/antigravity/plugins/effect-harness/skills/effect-code-review/SKILL.md`, `adapters/claude-code/skills/effect-code-review/SKILL.md`):** Remediation edits carry explicit monotonic re-audit requirements both in routing contracts and in skill workflows.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                      | Effect Symbol                 | Verification |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------ |
| REQ-3.1 | Event-driven       | **When** `Harness.routeReviewDiff` or `HarnessMcp.routeReview` receives optional `remediationContext` citing resolved `blocker`, `major`, or `critical` specialist lenses, `Harness.routeReviewDiff` **shall** route a second-pass remediation plan invoking those specialist lenses at minimum depth `focused`. | Harness.routeReviewDiff       | UnitTest     |
| REQ-3.2 | Unwanted behaviour | **If** a remediation diff includes non-empty `remediationContext` with prior critical or major findings, **then** `ReviewRouter.inferDiffSignals` and `ReviewRouter.decideDeterministic` **shall not** resolve depth below `focused` or omit any cited specialist lens from `mandatory` selections.              | ReviewRouter.inferDiffSignals | UnitTest     |

## Assumptions

- Existing callers of `Harness.routeReviewDiff` and `HarnessMcp.routeReview` that omit `remediationContext` and stay below `REVIEW_SLICE_FILE_THRESHOLD` observe byte-for-byte compatible `ReviewRoutingPlan` behavior with zero breaking changes to `SPEC-0013`.
- Optional `reviewSlices` acts as an orchestration aid for parallel specialist subagent dispatch without replacing whole-diff cross-file review when cross-package imports exist.

## Out of scope

- Automatic spawning of nested LLM subagents from within `@harness/decision` pure functions (subagent dispatch remains an adapter skill workflow responsibility).
- Rewriting historical completed PR review transcripts.

## Known residual risks

- Slice partitioning by Nx package groups unrelated files within a single large package into one slice; extreme single-package diffs rely on existing file batching inside `review-slice-partitioner.ts` once `changedFiles` approaches schema capacity (`<= 200`).

## Acceptance criteria

- `review-slice-partitioner.ts` (`<= 160` lines) partitions diffs at `changedFiles.length >= REVIEW_SLICE_FILE_THRESHOLD` deterministically with 100% file coverage and zero duplicate paths.
- Supplying `remediationContext` with `blocker`/`major`/`critical` findings enforces `depth >= focused` and retains every cited specialist with `mandatory: true`.
- Antigravity and Claude Code skills carry identical Swarm Seam Checklist and second-pass remediation re-audit directives enforced by `GraphGc.decide` and `apps/harness-cli/test/adapter-config.test.ts`.
- `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, and `pnpm harness mutate --strict` pass with full positive, negative, and property test coverage in `review-router-decision.test.ts`, `review-route.test.ts`, and `adapter-config.test.ts`.
