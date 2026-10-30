---
id: harness:ADR-0005
title: Deterministic Idiom Routing Pre-Filter, Telemetry KPI Separation, and Antigravity Session Hook Fast-Path
status: accepted
date: 2026-10-30
deciders:
  - "@harness/gates"
  - "@harness/decision"
  - "@harness/cli"
enforced_by:
  - libs/harness/decision/src/idiom-router.ts
  - libs/harness/decision/src/triage-decision.ts
  - libs/harness/gates/src/telemetry.ts
  - libs/harness/gates/src/policy.ts
  - apps/harness-cli/src/index.ts
spans:
  - Harness.routeStep
  - Harness.triageFailure
  - SessionReport.decide
  - Harness.decideGuardCommand
services: []
errors: []
---

# Deterministic Idiom Routing Pre-Filter, Telemetry KPI Separation, and Antigravity Session Hook Fast-Path

## Context and Problem Statement

Forensic analysis of live Antigravity session `65596e97-aea2-447f-911a-2c0178874cf4` exposed three architectural friction points across `@harness/decision`, `@harness/gates`, and `@harness/cli`:

1. `Harness.routeStep` relied exclusively on the local LLM (`IdiomRouterV1` via `clef` / `gemma4:e2b`), which returned `"review"` (`route_miss`) for unambiguous domain phrases like `"event sourcing decider core"` and `"event sourcing"`. Meanwhile, `Harness.triageFailure` already uses a deterministic regex pre-filter (`DETERMINISTIC_TRIAGE_RULES`) before falling back to `TriageV1`.
2. `SessionReport.decide` conflated routing fallbacks (`outcome === "fallback"`) with Omnigraph memory-fallbacks (`engineSource === "memory-fallback"`), and conflated internal CLI graph writes (`omnigraph:sync-plan`, `omnigraph:sync-impl`, `omnigraph:merge-main`) with agent graph discovery queries.
3. The Antigravity `PreInvocation` hook (`harness session --format=antigravity`) ran before every single agent turn (`108` times in one session) and performed an HTTP round-trip to `DecisionModel.decide(IdiomRouterV1, { input: { planStep: "Initialize session" } })` even though the `--format=antigravity` payload (`{ injectSteps }`) completely discards the `modelWarm` boolean.

## Decision Drivers

- **Zero-latency deterministic routing and triage for unambiguous inputs:** Well-known Effect-TS pattern keywords (`event-sourcing`, `decider`, `ts-pattern`, `drizzle`, `httpapi`, `rpc`, `atom`) and Effect v3-to-v4 migration errors (`decodeEither`, `Either`, `ParseResult`, `decodeSync` negative tests) should resolve in `0ms` without LLM variance.
- **Unambiguous telemetry KPIs:** `omnigraphLiveRatio` must reflect solely Omnigraph vs. `memory-fallback` engine execution, and `graphDiscoveryCalls` must reflect genuine agent graph/ontology queries rather than internal CLI branch syncs.
- **Sub-50ms `PreInvocation` hook execution:** `harness session --format=antigravity` runs on every turn and must not block on Ollama HTTP inference when `modelWarm` is unused.
- **Backward compatibility with existing eval scenarios:** `scenarios/01-clef-guard` and existing unit tests for `DecisionModel` fallback behavior (`Retry failed HTTP requests with exponential backoff`, `Stream large R2 CSV with Effect Stream`) must remain 100% green.

## Considered Options

1. **Deterministic pre-filter tables in `routeStep` and `triageFailure` + strict telemetry KPI predicates in `SessionReport.decide` + `--format=antigravity` warmup skip in `handleDoctorOrSession`**
2. **Retrain or lower the confidence threshold (`0.7 -> 0.4`) of `IdiomRouterV1` and keep all routing/session calls on the LLM path**
3. **Remove `harness session` from the Antigravity `PreInvocation` hook entirely**

## Decision Outcome

Chosen option: **Option 1 — Deterministic pre-filter tables in `routeStep` and `triageFailure` + strict telemetry KPI predicates in `SessionReport.decide` + `--format=antigravity` warmup skip in `handleDoctorOrSession`**, because it eliminates false `route_miss` events in `0ms`, restores accurate `omnigraphLiveRatio` and `graphDiscoveryCalls` metrics, prevents `cd` shell misuse, and removes `108` redundant Ollama HTTP round-trips per session while preserving full `PreInvocation` step injection.

## Rejected Alternatives

### 1 · Lower `IdiomRouterV1` confidence threshold and keep all routing on LLM

Lowering the confidence threshold from `0.7` to `0.4` without a deterministic keyword pre-filter.

**Why rejected:** Lowering the confidence threshold increases false-positive routing on genuinely ambiguous prompts and still fails when Ollama is cold or unreachable, whereas deterministic keyword matching for explicit pattern terms (`decider`, `event-sourcing`, `ts-pattern`, `drizzle`, `httpapi`, `rpc`, `atom`) is instantaneous (`0ms`) and 100% reproducible.

### 2 · Remove `harness session` from the Antigravity `PreInvocation` hook

Deleting the `PreInvocation` hook entry in `adapters/antigravity/plugins/effect-harness/hooks.json`.

**Why rejected:** Removing the `PreInvocation` hook breaks `scenarios/01-clef-guard` (`session-hook-fired`) and prevents the harness from injecting pending workflow steps (`injectSteps`) into the agent context at turn start. Skipping only the unused `DecisionModel.decide` warmup probe when `--format=antigravity` is passed preserves the hook contract while eliminating the HTTP bottleneck.

## Consequences and Enforcement

### Positive Consequences

- `Harness.routeStep` resolves explicit pattern queries (`event sourcing decider core`, `ts-pattern exhaustive match`, `drizzle d1 repository`, `httpapi endpoint`, `rpc group`, `atom state`) in `<1ms` with zero LLM flakiness.
- `SessionReport.decide` accurately reports `omnigraphLiveRatio = 1` when all graph queries use live Omnigraph, even if `harness route` had `review` fallbacks, and accurately reports `graphDiscoveryCalls = 0` when an agent skips MCP graph/ontology discovery.
- `Harness.decideGuardCommand` blocks `cd <dir>` shell commands with an actionable `Cwd` tool hint and allows `git restore --staged` without LLM escalation.
- `harness session --format=antigravity` avoids `DecisionModel` HTTP round-trips on every turn while `harness doctor` and `harness session` (default JSON format) retain full `modelWarm` diagnostics.

### Negative Consequences and Trade-offs

- `DETERMINISTIC_ROUTE_RULES` must be kept scoped to unambiguous pattern keywords so generic architectural phrases (`Retry failed HTTP requests with exponential backoff`, `Stream large R2 CSV with Effect Stream`) continue to exercise `IdiomRouterV1` and its `"review"` fallback path.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| :--- | :--- | :--- | :--- |
| Unambiguous idiom keywords route deterministically in `0ms` before `IdiomRouterV1` | `libs/harness/decision/src/idiom-router.ts` | `vitest` unit suite (`decisions.test.ts`) | `Harness.routeStep` |
| Effect v3 removed APIs (`decodeEither`, `Either`, `ParseResult`) and `decodeSync` negative tests triage deterministically | `libs/harness/decision/src/triage-decision.ts` | `vitest` unit suite (`decisions.test.ts`) | `Harness.triageFailure` |
| `omnigraphLiveRatio` counts only `engineSource === "memory-fallback"` and `graphDiscoveryCalls` excludes `omnigraph:sync-*` / `omnigraph:merge-*` | `libs/harness/gates/src/telemetry.ts` | `vitest` unit suite (`telemetry.test.ts`) | `SessionReport.decide` |
| `cd <dir>` is denied with `Cwd` hint and `git restore --staged` is allowlisted | `libs/harness/gates/src/policy.ts` | `vitest` unit suite (`policy.test.ts`) | `Harness.decideGuardCommand` |
