---
id: harness:ADR-0004
title: "Session window scoping across async Stop hooks and cross-repo MCP workspace discovery"
status: accepted
date: 2026-10-29
enforced_by:
  - libs/harness/gates/src/telemetry.ts
  - libs/harness/gates/src/friction-log.ts
  - apps/harness-cli/src/index.ts
  - apps/harness-mcp/src/server.ts
spans:
  - SessionReport.decide
  - LoopCircuitBreaker.decide
---

# ADR-0004: Session window scoping across async Stop hooks and cross-repo MCP workspace discovery

## Context and Problem Statement

In Antigravity sessions, long-running CLI commands such as `pnpm harness verify` (which executes `nx affected -t verify` and Omnigraph branch synchronization) frequently exceed the synchronous wait window and transition into background tasks. When the agent finishes its turn to wait for the background task notification, Antigravity invokes the `Stop` hook (`harness done --format=antigravity`) with stdin `{"fullyIdle": false}`. Because `handleDone` exits `0` with `{"decision": "stop"}` when `fullyIdle === false`, `runCliEffect` previously logged `{ surface: "hook", toolName: "done", outcome: "ok" }`. When the background `verify` task completed seconds later, `scopeSessionReportInput` mistook the `fullyIdle === false` hook event for a completed task boundary and sliced off the entire planning and pre-verification history (`route`, `plan-check`, `gc`, `mutate`).

At the same time, two additional observability distortions occurred during the `effect-es#3` session:
1. `handleGuard` logs every command that misses the static prefix `ALLOWLIST` as `kind: "guard_escalation"` in `.harness/friction-log.jsonl` (required by `scenarios/01-clef-guard` to verify that `clef-flash` evaluated the command). However, `SessionReport.decide` penalized every `guard_escalation` by `-5` points even when `decision.verdict === "allow"`, and `LoopCircuitBreaker.decide` counted `verdict=allow` escalations toward stuck-loop thrashing.
2. `harness-mcp` is launched by Antigravity with its working directory inside the plugin host repository (`effect-ts-harness`). When an agent worked in a sibling repository (`effect-es`), `resolveDefaultRepoRoot()` resolved `effect-ts-harness`, causing MCP graph/ontology queries and telemetry writes to target the wrong repository.

## Decision Drivers

* Asynchronous background execution of `pnpm harness verify` must never cause the `Stop` hook (`fullyIdle: false`) to erase earlier `plan-check`, `route`, `gc`, or `mutate` events from the active task window.
* Scenario `01-clef-guard` requires `guard_escalation` records (including `verdict=allow`) to remain in `.harness/friction-log.jsonl` for `harness learn` and scenario assertions, while `SessionReport.decide` and `LoopCircuitBreaker.decide` must only penalize or trip on actual friction (`route_miss`, `verify_failure`, or `guard_escalation` with `verdict=deny|ask`).
* `harness-mcp` must transparently resolve the active repository (`effect-es` vs `effect-ts-harness`) without requiring manual configuration changes per repository, and must serve symbols from `.harness/plan-graph-snapshot.json` during the planning phase before `.harness/graph-snapshot.json` exists.

## Considered Options

* **Option 1:** Annotate `fullyIdle: false` Stop hook events and require a real task-completion marker in `scopeSessionReportInput`, filter `verdict=allow` escalations in `SessionReport.decide` / `LoopCircuitBreaker.decide`, and share an active-workspace breadcrumb between `harness-cli` and `harness-mcp` with mtime-based snapshot selection.
* **Option 2:** Stop recording `done` hook events or `verdict=allow` guard escalations to `.harness/telemetry-log.jsonl` and `.harness/friction-log.jsonl`.
* **Option 3:** Require every MCP tool call to pass an explicit `repoRoot` argument and clear `.harness/telemetry-log.jsonl` on every `session` hook.

## Decision Outcome

**Chosen option:** "Option 1 — Annotate `fullyIdle: false` Stop hook events and require a real task-completion marker in `scopeSessionReportInput`, filter `verdict=allow` escalations in `SessionReport.decide` / `LoopCircuitBreaker.decide`, and share an active-workspace breadcrumb between `harness-cli` and `harness-mcp` with mtime-based snapshot selection". Binding rules:

1. When `handleDone` exits early due to `fullyIdle === false`, `runCliEffect` records `detail: "fullyIdle=false"` on the `done` hook telemetry event and skips writing `session-report.json`. When `handleDone` completes all verification and Omnigraph merge gates, it records `detail: "completed"`.
2. `scopeSessionReportInput` treats a `done` telemetry event as a task boundary only when `outcome === "ok"`, `detail !== "fullyIdle=false"`, and (`surface === "cli"` or `detail === "completed"` or the preceding event is `omnigraph:merge-main` with `outcome === "ok"`).
3. `SessionReport.decide` and `LoopCircuitBreaker.decide` ignore `guard_escalation` friction events whose `detail` starts with `"verdict=allow"`, while preserving those records in `.harness/friction-log.jsonl` for `harness learn` and `01-clef-guard`.
4. `harness-cli` writes `.harness/active-workspace.json` in `SERVER_REPO_ROOT` whenever invoked in a valid workspace, and `harness-mcp` consults explicit `repoRoot`/file arguments, non-plugin `process.cwd()`, and `.harness/active-workspace.json`, loading whichever of `graph-snapshot.json` or `plan-graph-snapshot.json` is newer.

## Rejected Alternatives

### 1 · Stop recording `done` hook events or `verdict=allow` guard escalations

**Why rejected:** Dropping `done` hook telemetry or `verdict=allow` friction events breaks `scenarios/01-clef-guard/expectations.json` (`stop-hook-fired`, `s1-escalated-to-clef`, `clef-gave-real-verdict`) and deprives `harness learn` of allowlist promotion candidates.

### 2 · Require explicit `repoRoot` on every MCP call and wipe telemetry on `session`

**Why rejected:** Requiring `repoRoot` on every MCP call adds schema bloat and fails whenever an agent omits it, while wiping telemetry on `PreInvocation` (`session`) erases multi-turn task history across turn boundaries.

## Consequences and Enforcement

### Positive Consequences

* Background `verify` runs that cross an Antigravity turn boundary preserve the full task telemetry window (`planBeforeVerify: true`).
* Safe compound commands approved by `clef-flash` (`verdict=allow`) no longer penalize `healthScore` or trigger false stuck-loop circuit breakers.
* `harness-mcp` seamlessly resolves symbols, ontology checks, and telemetry in external repositories such as `effect-es` both during planning (`plan-graph-snapshot.json`) and verification (`graph-snapshot.json`).

### Negative Consequences and Trade-offs

* Maintaining `.harness/active-workspace.json` introduces a lightweight last-writer-wins breadcrumb when two different repositories are edited simultaneously on the same machine; explicit `repoRoot` or file arguments take precedence when disambiguation is needed.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| :--- | :--- | :--- | :--- |
| Ignore `fullyIdle=false` Stop hooks when slicing task windows | `libs/harness/gates/src/telemetry.ts` | `scopeSessionReportInput` + `libs/harness/gates/test/telemetry.test.ts` (REQ-1.1, REQ-1.2) | `SessionReport.decide` |
| Exclude `verdict=allow` guard escalations from score penalty and loop thrashing | `libs/harness/gates/src/telemetry.ts` | `decideSessionReport` + `decideLoopThrashing` (`libs/harness/gates/src/friction-log.ts`) | `SessionReport.decide`, `LoopCircuitBreaker.decide` |
| Cross-repo active workspace discovery & mtime snapshot selection | `apps/harness-mcp/src/server.ts` | `resolveDefaultRepoRoot` + `resolveGraph` + `apps/harness-mcp/test/server.test.ts` | `SessionReport.decide` |
