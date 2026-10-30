---
id: harness:SPEC-0003
title: Deterministic Idiom Routing, Telemetry KPI Fidelity, Guard Ergonomics, and Session Hook Fast-Path
status: accepted
archetype: framework
date: 2026-10-30
owners:
  - "@harness/gates"
  - "@harness/decision"
  - "@harness/cli"
adrs:
  - harness:ADR-0005
spans:
  - Harness.routeStep
  - Harness.triageFailure
  - SessionReport.decide
  - Harness.decideGuardCommand
services: []
errors: []
---

# Deterministic Idiom Routing, Telemetry KPI Fidelity, Guard Ergonomics, and Session Hook Fast-Path

## Context and Motivation

Forensic analysis of live session `65596e97-aea2-447f-911a-2c0178874cf4` (Event Sourcing MVP Phase 1) revealed five systemic bottlenecks in the Effect-TS Engineering Harness:

1. **`IdiomRouterV1` Route Misses (`Harness.routeStep`):** Queries for `"event sourcing decider core"` and `"event sourcing"` returned `"review"` (`route_miss`) because the small local classifier model (`clef`) lacked deterministic keyword pre-filtering for unambiguous pattern domains (`event-sourcing`, `pattern-matching`, `d1-repository`, `durable-object-state`, `httpapi`, `rpc`, `atom`).
2. **Telemetry KPI Corruption (`SessionReport.decide`):**
   - `omnigraphLiveRatio` counted any event with `outcome === "fallback"` as an Omnigraph memory-fallback, so `harness route` misses (`category: "routing"`, `outcome: "fallback"`) dropped `omnigraphLiveRatio` to `0.67` and triggered a false recommendation to start Omnigraph even when Omnigraph was 100% live (`4/4` queries on `engineSource: "omnigraph"`).
   - `graphDiscoveryCalls` counted internal CLI write/sync events (`omnigraph:sync-plan`, `omnigraph:sync-impl`, `omnigraph:merge-main`), granting the `+5` graph-discovery health bonus even when the agent made zero graph or ontology discovery queries (`bySurface.mcp === 0`).
   - Zero MCP usage (`bySurface.mcp === 0` with `nonHookCalls >= 3`) produced no recommendation to prefer `harness-mcp` tools over shell subcommands.
3. **Effect v4 Triage Coverage (`Harness.triageFailure`):** Subprocess compile failures caused by hallucinated Effect v3 APIs (`Schema.decodeEither`, `Schema.decodeUnknownEither`, `Effect/Either`, `Effect/ParseResult`) or typed `Schema.decodeSync` negative-test arguments fell through to the slow LLM triage path instead of returning an instant 0ms mechanical Effect v4 remediation hint.
4. **Shell Guard Ergonomics & Workspace Containment (`Harness.decideGuardCommand`):**
   - Agents proposed `cd <dir>` shell commands (violating the Antigravity `Cwd` tool contract) or `git -C <path>` commands targeting directories outside the workspace.
   - Safe index unstaging via `git restore --staged <path>` was missing from the deterministic `ALLOWLIST`, causing unnecessary `GuardV1` escalations.
5. **`PreInvocation` Session Hook Latency (`handleDoctorOrSession`):** Running `harness session --format=antigravity` on every agent turn (`108` invocations, `44.7s` cumulative latency) executed a cold/warm HTTP probe against `DecisionModel.decide(IdiomRouterV1, { input: { planStep: "Initialize session" } })` even though the Antigravity hook JSON output (`{ injectSteps: [...] }`) never inspects `modelWarm`.

## Requirements

### 1 · Deterministic Idiom Routing Pre-Filter

**Source:** Session `65596e97-aea2-447f-911a-2c0178874cf4` friction log (`route_miss` on `"event sourcing decider core"` and `"event sourcing"`).

| ID | Pattern | Requirement | Effect Symbol | Verification |
| :--- | :--- | :--- | :--- | :--- |
| REQ-1.1 | Event-driven | WHEN a plan step contains unambiguous keywords for `event-sourcing` (`event-sourcing`, `event sourcing`, `decider`, `evolve`, `event-store`, `event store`, `aggregate`), `Harness.routeStep` shall deterministically return `"event-sourcing"` without invoking `DecisionModel`. | `Harness.routeStep` | UnitTest |
| REQ-1.2 | Event-driven | WHEN a plan step contains unambiguous keywords for `pattern-matching`, `d1-repository`, `durable-object-state`, `httpapi`, `rpc`, or `atom`, `Harness.routeStep` shall deterministically return the corresponding `BuildingBlock` without invoking `DecisionModel`. | `Harness.routeStep` | UnitTest |
| REQ-1.3 | Event-driven | WHEN a plan step does not match any deterministic route rule, `Harness.routeStep` shall delegate classification to `DecisionModel.decide(IdiomRouterV1, ...)` and return `"review"` if confidence is below `0.7` or the model is unavailable. | `Harness.routeStep` | UnitTest |

### 2 · Telemetry KPI Fidelity and MCP Guidance

**Source:** Session `65596e97-aea2-447f-911a-2c0178874cf4` `.harness/session-report.json` (`omnigraphLiveRatio: 0.67` false positive, `graphDiscoveryCalls: 4` from internal syncs, `bySurface.mcp: 0`).

| ID | Pattern | Requirement | Effect Symbol | Verification |
| :--- | :--- | :--- | :--- | :--- |
| REQ-2.1 | Event-driven | WHEN computing `omnigraphLiveRatio`, `SessionReport.decide` shall count `fallbackCalls` strictly from events where `engineSource === "memory-fallback"` so routing fallbacks do not corrupt Omnigraph availability metrics. | `SessionReport.decide` | UnitTest |
| REQ-2.2 | Event-driven | WHEN computing `graphDiscoveryCalls`, `SessionReport.decide` shall exclude internal CLI graph synchronization events (`omnigraph:sync-plan`, `omnigraph:sync-impl`, `omnigraph:merge-main`) so only genuine graph and ontology discovery queries are counted. | `SessionReport.decide` | UnitTest |
| REQ-2.3 | Unwanted behaviour | IF `bySurface.mcp === 0` and non-hook telemetry calls are at least `3`, THEN `SessionReport.decide` shall append a recommendation instructing the agent to prefer in-process `harness-mcp` tools (`harness_route`, `harness_lsp_diagnostics`, `harness_ontology_check`, `harness_resolve`) over shell CLI subcommands. | `SessionReport.decide` | UnitTest |

### 3 · Deterministic Effect v4 Triage Rules

**Source:** Session `65596e97-aea2-447f-911a-2c0178874cf4` compilation errors in `@effect-es/contract` (`Schema.decodeEither` and `Schema.decodeSync` negative test arguments).

| ID | Pattern | Requirement | Effect Symbol | Verification |
| :--- | :--- | :--- | :--- | :--- |
| REQ-3.1 | Event-driven | WHEN verification output contains Effect v3 removed APIs (`decodeEither`, `decodeUnknownEither`, `has no exported member 'Either'`, or `has no exported member 'ParseResult'`), `Harness.triageFailure` shall deterministically return `kind: "compile"` with an Effect v4 `Result` / `Exit` and `Schema.decodeExit` / `Schema.decodeUnknownSync` remediation hint. | `Harness.triageFailure` | UnitTest |
| REQ-3.2 | Event-driven | WHEN verification output contains a TypeScript argument type error on `decodeSync` (`Argument of type .* is not assignable to parameter of type` alongside `decodeSync`), `Harness.triageFailure` shall deterministically return `kind: "compile"` with a remediation hint to use `Schema.decodeUnknownSync` or `Schema.decodeExit` for unvalidated or negative-test inputs. | `Harness.triageFailure` | UnitTest |

### 4 · Shell Guard Ergonomics and Workspace Containment

**Source:** Session `65596e97-aea2-447f-911a-2c0178874cf4` guard telemetry (`git -C /home/roan/WebstormProjects/effect-ts-harness/repos/effect`, `cd` commands, and `git restore --staged`).

| ID | Pattern | Requirement | Effect Symbol | Verification |
| :--- | :--- | :--- | :--- | :--- |
| REQ-4.1 | Unwanted behaviour | IF a shell command invokes `cd` as its command token (`cd <dir>`), THEN `Harness.decideGuardCommand` shall deterministically return `verdict: "deny"` with a reason instructing the agent to use the tool `Cwd` parameter instead of `cd`. | `Harness.decideGuardCommand` | UnitTest |
| REQ-4.2 | Event-driven | WHEN a simple shell command starts with `git restore --staged`, `Harness.decideGuardCommand` shall deterministically return `verdict: "allow"` without escalating to `DecisionModel`. | `Harness.decideGuardCommand` | UnitTest |

### 5 · Antigravity Session Hook Fast-Path

**Source:** Session `65596e97-aea2-447f-911a-2c0178874cf4` telemetry log (`108` calls to `session` hook averaging `325ms` due to redundant `DecisionModel` warmup HTTP probes).

| ID | Pattern | Requirement | Effect Symbol | Verification |
| :--- | :--- | :--- | :--- | :--- |
| REQ-5.1 | Event-driven | WHEN `harness session` is invoked with `--format=antigravity`, the CLI session handler (`handleDoctorOrSession`) shall skip the `DecisionModel.decide` warmup probe and return `{ injectSteps }` directly. | `SessionReport.decide` | UnitTest |
