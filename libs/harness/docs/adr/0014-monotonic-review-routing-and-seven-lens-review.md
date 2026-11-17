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
  - apps/harness-mcp/src/tools/graph-navigation.tools.ts
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

Automated and agent-led code reviews in the Effect-TS Harness face a tension between review thoroughness and token/latency cost. Running every specialist reviewer on every diff wastes context on trivial edits, while relying on ad-hoc reviewer selection misses domain-specific hazards across Effect v4 `Schema`, `ts-pattern` exhaustiveness, D1/Durable Object expand-contract migrations, `scope:web` `AtomHttpApi` reactivity, and framework-vs-application archetype boundaries.

## Decision Drivers

* **Monotonic safety floor:** Deterministic diff signals (`changedFiles`, `touchedTiers`, `touchedScopes`, `changedLineCount`, and path/content surface flags) must establish an un-downgradeable minimum `ReviewDepth` and mandatory `ReviewerId` set.
* **Bounded System One augmentation:** Advisory `clef-flash` (`DecisionModel.decide` over `ReviewRouterV1`) may escalate depth or add specialist lenses within `1500 millis`, but must never downgrade or remove deterministic selections and must degrade cleanly to `degraded-fallback` when unavailable.
* **Single MCP precomputation pass:** Callers need one MCP tool (`harness_review_route`) that validates input, computes `ReviewDiffSignals`, resolves `ReviewRoutingPlan`, and attaches `ReviewGraphContextBundle` (`touchedSymbols`, `reachingTests`, `governanceRefs`) in one round trip.

## Considered Options

* **Option 1: Unconditional all-reviewer fan-out** — Dispatch all 7 specialist reviewers on every non-empty diff regardless of touched tiers or size.
* **Option 2: Purely LLM-driven reviewer selection** — Let the reviewing agent or `clef-flash` freely choose `ReviewDepth` (`skip`..`full`) and specialist lenses without deterministic floors.
* **Option 3: Monotonic Hybrid Routing with Clef-Flash System One and Seven-Lens Specialist Dispatch** — Compute pure `ReviewDiffSignals` (`R = never`), derive a monotonic deterministic floor in `ReviewRouter.decideDeterministic`, allow upward-only escalation via `ReviewRouterV1` in `Harness.routeReviewDiff`, and expose the plan plus graph context via `harness_review_route`.

## Decision Outcome

**Chosen option:** "Option 3: Monotonic Hybrid Routing with Clef-Flash System One and Seven-Lens Specialist Dispatch"

1. `libs/harness/contract/src/review-routing.ts` defines branded scalars (`ReviewerId`, `ReviewDepth`, `ReviewSignalPath`, `ReviewChangedLines`, `ReviewSummaryText`, `ReviewRoutingReason`, `ReviewRoutingSource`, `ReviewRawFileInput`), `InvalidReviewRouteInputError`, `ReviewRawDiffInput`, `ReviewDiffSignals`, the closed union `ReviewRoutingPlan` (`SkipReviewPlan` | `ActiveReviewPlan`), `ReviewGraphContextBundle`, and `ReviewRouteToolOutput`.
2. `SPECIALIST_REVIEWER_IDS` standardizes seven orthogonal read-only specialist lenses: `effect-ears-test-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`, `effect-adversarial-reviewer`, `effect-web-reviewer`, `effect-migration-contract-reviewer`, and `effect-architecture-reviewer`.
3. `ReviewRouter.decideDeterministic` remains a pure `R = never` function so property-based tests can prove monotonicity (`depth` ordering `skip < lite < focused < full` and subset preservation of mandatory `ReviewerSelection` entries) independently of `DecisionModel`.
4. `Harness.routeReviewDiff` wraps `DecisionModel.decide(ReviewRouterV1, ...)` with `Effect.timeoutOption("1500 millis")` and `isPureInterruptCause` handling, escalating only upward and falling back to `source = "degraded-fallback"` on timeout or model error.
5. `CANONICAL_MCP_TOOL_NAMES` registers `harness_review_route`, implemented by `HarnessMcp.routeReview` in `apps/harness-mcp/src/tools/graph-navigation.tools.ts`.

## Rejected Alternatives

### 1 · Option 1: Unconditional all-reviewer fan-out

Dispatch all seven specialist reviewers on every diff regardless of size or touched tiers.

**Why rejected:** Spawning seven subagents for a 10-line typo or single-file utility fix multiplies token cost and latency without improving defect detection, encouraging callers to bypass structured review altogether.

### 2 · Option 2: Purely LLM-driven reviewer selection

Allow `clef-flash` or the calling agent to select any `ReviewDepth` (including `skip`) and arbitrary reviewer subsets without deterministic floors.

**Why rejected:** Purely probabilistic routing can erroneously downgrade diffs touching `migrations/*.sql`, `type:contract` schemas, auth boundaries, or `scope:web` atoms to `skip` or `lite`, violating fail-closed governance guarantees.

## Consequences and Enforcement

### Positive Consequences

- Pure `ReviewRouter.decideDeterministic` (`R = never`) enables fast, deterministic unit and property tests for depth monotonicity and mandatory lens selection.
- `harness_review_route` gives review workflows both the routing plan and precomputed Omnigraph/Effect-graph context (`touchedSymbols`, `reachingTests`, `governanceRefs`) in a single MCP call.

### Negative Consequences and Trade-offs

- Adding a new specialist reviewer lens requires updating `SPECIALIST_REVIEWER_IDS` in `libs/harness/contract/src/review-routing.ts` and the corresponding routing rules in `libs/harness/decision/src/review-router-decision.ts`.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| :--- | :--- | :--- | :--- |
| Branded scalars and closed `ReviewRoutingPlan` union in `type:contract` with `effect`-only imports | `libs/harness/contract/src/review-routing.ts` | `HarnessTierTopology.decide` & `SelfDogfooding.decide` | `ReviewRouter.inferDiffSignals`, `InvalidReviewRouteInputError` |
| Pure deterministic routing (`R = never`) and `1500 millis` System One timeout fallback | `libs/harness/decision/src/review-router-decision.ts` | `pnpm harness verify` | `ReviewRouter.decideDeterministic`, `Harness.routeReviewDiff`, `HarnessMcp.routeReview` |
