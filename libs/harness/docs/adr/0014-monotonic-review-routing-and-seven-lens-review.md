---
id: harness:ADR-0014
title: Monotonic Hybrid Review Routing and Seven-Lens Specialist Code Review
status: accepted
date: 2026-11-17
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/review-routing.ts
  - libs/harness/contract/src/workspace-and-process.ts
  - libs/harness/decision/src/review-router-decision.ts
  - libs/harness/decision/test/review-router.test.ts
  - apps/harness-mcp/src/tools/graph-navigation.tools.ts
  - apps/harness-mcp/src/tools/review-route-helpers.ts
  - apps/harness-cli/test/adapter-config.test.ts
spans:
  - ReviewRouter.inferDiffSignals
  - ReviewRouter.decideDeterministic
  - Harness.routeReviewDiff
  - HarnessMcp.routeReview
errors:
  - InvalidReviewRouteInputError
informs:
  - harness:SPEC-0013
---

## Context and Problem Statement

Automated and agent-led code reviews in the Effect-TS Harness face a tension between review thoroughness and token/latency cost. Running every specialist reviewer on every diff wastes context on trivial documentation edits, while relying on ad-hoc reviewer selection misses domain-specific hazards across Effect v4 `Schema`, `ts-pattern` exhaustiveness, D1/Durable Object expand-contract migrations, `scope:web` `AtomHttpApi` reactivity, and framework-vs-application archetype boundaries.

## Decision Drivers

- **Fail-closed deterministic safety floor:** Validated, non-empty diff signals (`changedFiles`, `touchedTiers`, `touchedScopes`, `changedLineCount`, and path/content surface flags) must establish an un-downgradeable minimum `ReviewDepth` and mandatory `ReviewerId` set—skipping only allowlisted non-governance documentation edits under 40 lines and routing any code, config, or script diff to at least `lite` (or `focused` when manifest diagnostics occur).
- **Monotonic System One augmentation:** Advisory `clef-flash` (`DecisionModel.decide` over `ReviewRouterV1`, scoring `recommendedDepth` plus five semantic risk lenses) may escalate depth or add optional specialist lenses within a configurable timeout (default `1500 millis`), re-deriving depth when added lenses increase selection count, never downgrading or removing deterministic floor selections, and degrading with a logged warning and `degradedReason` when unavailable.
- **Single MCP precomputation pass:** Callers need one MCP tool (`harness_review_route`) that validates non-empty `changedFiles` and required `changedLineCount`, enriches tier/scope tags once, resolves `ReviewRoutingPlan`, and attaches `ReviewGraphContextBundle` (`touchedSymbols`, `reachingTests`, `governanceRefs`), manifest `warnings`, and graph degradation metadata in one round trip.
- **Strict read-only review vs. stateful remediation separation:** Code review (`effect-code-review`) must never mutate workspace files or switch branches (`git checkout`/`git switch`/`gh pr checkout`), preserving `.harness/verify-stamp.json`, `plan-graph-snapshot.json`, and EARS/ADR sync via `resolving-effect-review-feedback`.
- **Zero deterministic-gate noise & cross-adapter parity:** Specialist reviewers must suppress issues already caught by `@effect/tsgo`, `oxlint`, `HarnessTierTopology.decide`, `SelfDogfooding.decide`, and `MigrationSafety.decide`, and all workflow skills, 7 specialist reviewers, persona references, and 17 MCP tools (expanded from 16 in `SPEC-0020`) must stay in lockstep across Antigravity and Claude Code adapters without cross-runtime tool or server-name leakage.

## Considered Options

- **Option 1: Unconditional all-reviewer fan-out** — Dispatch all 7 specialist reviewers on every non-empty diff regardless of touched tiers or size.
- **Option 2: Purely LLM-driven reviewer selection** — Let the reviewing agent or `clef-flash` freely choose `ReviewDepth` (`skip`..`full`) and specialist lenses without deterministic floors.
- **Option 3: Monotonic Hybrid Routing with Clef-Flash System One and Seven-Lens Specialist Dispatch** — Compute pure `ReviewDiffSignals` and a pure deterministic floor in `ReviewRouter.decideDeterministic` (`R = never`), merge monotonically upward with `ReviewRouterV1` in `Harness.routeReviewDiff`, and expose the plan plus graph context via `harness_review_route`.
- **Option 4: Inline apply:local auto-fix inside effect-code-review** — Allow the review skill to directly edit files during review like generic ce-code-review.

## Decision Outcome

**Chosen option:** "Option 3: Monotonic Hybrid Routing with Clef-Flash System One and Seven-Lens Specialist Dispatch"

1. `libs/harness/contract/src/review-routing.ts` defines path-safe branded scalars (`ReviewerId`, `ReviewDepth`, `ReviewDepthRank`, `getReviewDepthRank`, `ReviewSignalPath`, `ReviewChangedLines`, `ReviewTimeoutMillis`, `ReviewSummaryText`, `ReviewRoutingReason`, `ReviewRoutingSource`, `ReviewRawFileInput`), `InvalidReviewRouteInputError`, non-empty `ReviewRawDiffInput` and `ReviewDiffSignals`, the closed union `ReviewRoutingPlan` (`SkipReviewPlan` | `ActiveReviewPlan`), `ReviewGraphContextBundle`, and `ReviewRouteToolOutput`.
2. `SPECIALIST_REVIEWER_IDS` standardizes seven orthogonal read-only specialist lenses: `effect-ears-test-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`, `effect-adversarial-reviewer`, `effect-web-reviewer`, `effect-migration-contract-reviewer`, and `effect-architecture-reviewer`.
3. `ReviewRouter.decideDeterministic` remains a pure `R = never` floor function (skipping only allowlisted non-governance documentation edits under 40 lines), while **monotonicity** (`floor ⊔ model`, shared `getReviewDepthRank` ordering `skip < lite < focused < full`, subset preservation of mandatory `ReviewerSelection` entries, and re-derived depth from merged selections) is enforced by the hybrid merge in `Harness.routeReviewDiff`.
4. `Harness.routeReviewDiff` invokes `DecisionModel.decide(ReviewRouterV1, ...)`—which classifies `recommendedDepth` and scores five semantic probability lenses (`security`, `reliability`, `adversarial`, `migration-contract`, `architecture` at `>= 0.75`, while `web` and `ears-test` are signal-driven)—within `Effect.timeoutOption` (default `1500 millis`) and `Effect.catch` error handling, setting `source = "model-augmented"` only when the plan changes beyond the floor and logging + recording `degradedReason` on `source = "degraded-fallback"`.
5. `CANONICAL_MCP_TOOL_NAMES` registers `harness_review_route`, implemented by `HarnessMcp.routeReview` in `apps/harness-mcp/src/tools/graph-navigation.tools.ts` with single-pass signal extraction, manifest diagnostic `warnings` (flooring depth at `focused` on manifest errors), and `graphStatusMeta` propagation.
6. The `effect-code-review` skill executes strictly read-only across a 4-stage spine (`1. Pre-Pass`, `2. Depth & Dispatch`, `3. Verify & Suppress`, `4. Report & Handoff` with 5 required `[P0|P1]` Quote-the-Line slots), handing off all workspace mutations exclusively to `resolving-effect-review-feedback`.
7. All 7 specialist reviewer definitions enforce hard deterministic-gate false-positive suppression, omitting findings already covered by `@effect/tsgo`, `oxlint`, `HarnessTierTopology.decide`, `SelfDogfooding.decide`, and `MigrationSafety.decide`.
8. Cross-adapter parity keeps workflow skills, `SPECIALIST_REVIEWER_IDS` agents and persona references, and `CANONICAL_MCP_TOOL_NAMES` synchronized between `adapters/antigravity/plugins/effect-harness/` and `adapters/claude-code/` with strict runtime separation (`read_file` & `effect-harness_harness-mcp` in Antigravity vs. `Read` & `harness-mcp` in Claude Code).

## Rejected Alternatives

### 1 · Option 1: Unconditional all-reviewer fan-out

Dispatch all seven specialist reviewers on every diff regardless of size or touched tiers.

**Why rejected:** Spawning seven subagents for a 10-line typo or single-file utility fix multiplies token cost and latency without improving defect detection, encouraging callers to bypass structured review altogether.

### 2 · Option 2: Purely LLM-driven reviewer selection

Allow `clef-flash` or the calling agent to select any `ReviewDepth` (including `skip`) and arbitrary reviewer subsets without deterministic floors.

**Why rejected:** Purely probabilistic routing can erroneously downgrade diffs touching `migrations/*.sql`, `type:contract` schemas, auth boundaries, non-`.ts` config/scripts, or `scope:web` atoms to `skip` or `lite`, violating fail-closed governance guarantees.

### 3 · Option 4: Inline apply:local auto-fix inside effect-code-review

Allow the review skill to directly edit files during review like generic ce-code-review.

**Why rejected:** Inline review edits bypass EARS/ADR synchronization, corrupt `plan/current` vs `impl/current` graph diffs, invalidate `.harness/verify-stamp.json`, and compromise adversarial review objectivity.

## Consequences and Enforcement

### Positive Consequences

- Pure `ReviewRouter.decideDeterministic` (`R = never`) provides a fast, inspectable deterministic floor, while unit and property tests over `Harness.routeReviewDiff` verify hybrid depth monotonicity and mandatory lens preservation across all model outputs.
- `harness_review_route` gives review workflows the routing plan, manifest diagnostics, graph degradation status, and precomputed Effect-graph context (`touchedSymbols`, `reachingTests`, `governanceRefs`) in a single MCP call.

### Negative Consequences and Trade-offs

- Adding a new specialist reviewer lens requires updating `SPECIALIST_REVIEWER_IDS` in `libs/harness/contract/src/review-routing.ts`, routing rules in `libs/harness/decision/src/review-router-decision.ts`, and synchronized agent/persona definitions across both adapters.

### Deterministic Enforcement

| Rule                                                                                                                                                                                                   | Enforced By                                                                                                                                                                                                               | Gate / Mechanism                                                                                       | Governed Symbols                                                                        |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| Path-safe branded scalars, non-empty `ReviewRawDiffInput`, shared `getReviewDepthRank`, `CANONICAL_MCP_TOOL_NAMES`, and closed `ReviewRoutingPlan` union in `type:contract` with `effect`-only imports | `libs/harness/contract/src/review-routing.ts` & `libs/harness/contract/src/workspace-and-process.ts`                                                                                                                      | `Schema.brand` & `Schema.Literals` (`REVIEW_DEPTH_RANK` exhaustive lookup, `CANONICAL_MCP_TOOL_NAMES`) | `ReviewRouter.inferDiffSignals`, `InvalidReviewRouteInputError`                         |
| Pure deterministic floor (`R = never`), monotonic `Harness.routeReviewDiff` merge, and logged `degraded-fallback` with `degradedReason`                                                                | `libs/harness/decision/src/review-router-decision.ts`, `libs/harness/decision/test/review-router.test.ts`, `apps/harness-mcp/src/tools/graph-navigation.tools.ts`, & `apps/harness-mcp/src/tools/review-route-helpers.ts` | `ReviewRouter.decideDeterministic`, `Harness.routeReviewDiff`, & `HarnessMcp.routeReview`              | `ReviewRouter.decideDeterministic`, `Harness.routeReviewDiff`, `HarnessMcp.routeReview` |
| Cross-adapter skill, `SPECIALIST_REVIEWER_IDS` agent-to-persona body parity, SDO frontmatter, `CANONICAL_MCP_TOOL_NAMES` catalog, and runtime tool/server-name leakage bans                            | `apps/harness-cli/test/adapter-config.test.ts`                                                                                                                                                                            | `SPECIALIST_REVIEWER_IDS` adapter parity suite                                                         | `HarnessMcp.routeReview`                                                                |
