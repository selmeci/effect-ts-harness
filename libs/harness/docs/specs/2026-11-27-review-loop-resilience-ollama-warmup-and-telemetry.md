---
id: harness:SPEC-0037
title: Review-Loop Resilience, LSP Watchdog, Mutation Efficiency, Ollama Warm-Up (5000ms Budget), Guard Fast-Path, and Telemetry Accuracy
status: draft
archetype: framework
date: 2026-11-27
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0003
  - harness:ADR-0005
  - harness:ADR-0011
  - harness:ADR-0021
  - harness:ADR-0024
  - harness:ADR-0025
  - harness:ADR-0027
  - harness:ADR-0028
enforced_by:
  - libs/harness/contract/src/review-routing.ts
  - libs/harness/contract/src/workflow-timeouts.ts
  - libs/harness/contract/src/index.ts
  - libs/harness/decision/src/guard-decision.ts
  - libs/harness/decision/src/review-router-decision.ts
  - libs/harness/decision/src/triage-decision.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/policy-command-rules.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/mutation/mutation-suite-helpers.ts
  - libs/harness/gates/src/mutation/mutation-package-batch.ts
  - libs/harness/gates/src/telemetry.ts
  - libs/harness/infra/src/embedding-client-live.ts
  - libs/harness/infra/src/local-decision-model-live.ts
  - apps/harness-cli/src/commands/ollama-readiness.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
  - apps/harness-cli/src/commands/mutate-and-bench.command.ts
  - apps/harness-mcp/src/tools/lsp-and-telemetry.tools.ts
  - apps/harness-mcp/src/tools/ontology-and-gq.tools.ts
  - apps/harness-mcp/src/tools/review-route-helpers.ts
  - adapters/antigravity/plugins/effect-harness/skills/resolving-effect-review-feedback/SKILL.md
  - adapters/claude-code/skills/resolving-effect-review-feedback/SKILL.md
spans:
  - LspDiagnostics.run
  - OllamaReadiness.ensureWarm
  - GuardDecision.decide
  - McpSingleFlight.run
  - MutationCheck.run
  - MutationCheck.decide
  - HarnessVerify.run
  - HarnessHookRuntime.load
  - PolicyFastPath.decide
  - TelemetryReport.decide
services:
  - "@harness/service/EmbeddingClient"
errors:
  - LspDiagnosticsTimeoutError
  - OllamaWarmupError
---

## Context

Telemetry and session transcript analysis from PR #56 (`wf5_deterministic_workflow_runners`, `1 976` review-window telemetry events and `3 108` cumulative events with `healthScore: 55/100` and cumulative `5/100`, Grade `D`) identified six concrete bottlenecks across the Effect-TS Engineering Harness and the `/resolving-effect-review-feedback` workflow: an unbounded `harness_lsp_diagnostics` call hung for `12 270 187 ms` (`3.4 h`) on a circular `TS2484` re-export without watchdog termination; `mutate --strict` consumed `12.5 min` across `7` runs due to test-edit invalidation of unchanged source mutants, module-initialization `SchemaError` crashes classified as `infraFailure`, and unreachably mutated defensive branches; and `harness verify` ran `nx affected -t verify` for `62 s` before failing on `verify:mutate-stamp`.

At the AI and hook control plane, `35` of `37` `guard` interventions timed out at `2500 ms` on cold or busy `clef-flash` (`DecisionModel`), `harness_review_route` degraded at `1500 ms`, `3` parallel specialist `harness_ontology_check` calls triggered Ollama contention fallback, `done` hooks crashed `15` times in `60 s` while `@harness/contract` was mid-refactor, and `telemetry.ts` penalized `harness_lsp_diagnostics` whenever type errors were reported during active development while reporting contradictory `firstPassVerify` and omitting hang/allowlist diagnostics.

- **Reused Contracts / Errors:** `ReviewTimeoutMillis`, `DEFAULT_REVIEW_ROUTE_TIMEOUT_MS`, `DEFAULT_QWEN_EMBEDDING_MODEL`, `WORKFLOW_TIMEOUT_BUDGETS`, `GuardDecision`, `SessionReport`, `TelemetryEvent` from `@harness/contract` and `@harness/gates`
- **Reused Services:** `@harness/service/EmbeddingClient` (`EmbeddingClient`), `@harness/infra/hook-fastpath` (`nodeSyncHostIo`), `spawnSupervisedProcessGroup` POSIX process-group reaper
- **New Capabilities Needed:** Per-call LSP watchdog timeout (`LspDiagnosticsTimeoutError`), unified `5000 ms` `DecisionModel` timeout + `POST /v1/systemone` / `POST /v1/embeddings` Ollama warm-up (`OllamaWarmupError`), MCP single-flight semaphore + tree-hash memoization, two-tier mutation cache (source hash vs. test hash) + `--survivors-only` / module-init kill classification, fail-fast `verify` ordering, precompiled hook runtime snapshot, expanded `PolicyFastPath.decide`, accurate `TelemetryReport.decide`, and synchronized skill rules

## Goal

Every PR review and remediation loop completes deterministically without multi-hour LSP hangs, cold-start Ollama guard timeouts, redundant full mutation re-runs, late `verify` stamp failures, or mid-refactor hook breakage, while reporting accurate actionable telemetry and preserving strict hexagonal safety invariants.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Bounded LSP Diagnostics Watchdog & Telemetry Classification

**Source (`apps/harness-mcp/src/tools/lsp-and-telemetry.tools.ts`, `libs/harness/infra/src/node-host-io.ts`):** Unbounded `effect-tsgo` invocations hang indefinitely on circular re-export cycles (`TS2484`), and normal compiler type errors reported during active edits currently skew tool-failure metrics.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                  | Effect Symbol              | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------ |
| REQ-1.1 | Event-driven       | **When** `LspDiagnostics.run` spawns an `effect-tsgo` or `tsgolint` subprocess, `LspDiagnostics.run` **shall** supervise its detached POSIX process group under a configurable watchdog timeout defaulting to `45000 ms`.                                    | LspDiagnostics.run         | UnitTest     |
| REQ-1.2 | Unwanted behaviour | **If** an `effect-tsgo` or `tsgolint` invocation exceeds its watchdog budget, **then** `LspDiagnostics.run` **shall** reap the process group via `SIGTERM` then `SIGKILL` and return `LspDiagnosticsTimeoutError` naming any `TS2484` cycle diagnostic hint. | LspDiagnosticsTimeoutError | UnitTest     |
| REQ-1.3 | Event-driven       | **When** `LspDiagnostics.run` completes cleanly with non-zero compiler diagnostics (`errors > 0`), `LspDiagnostics.run` **shall** emit telemetry with outcome `"diagnostics_found"` rather than `"fail"` or `"timeout"`.                                     | LspDiagnostics.run         | UnitTest     |

### 2 · Ollama Warm-Up, 5000ms DecisionModel Budget & MCP Stampede Control

**Source (`apps/harness-cli/src/commands/ollama-readiness.ts`, `libs/harness/decision/src/guard-decision.ts`, `libs/harness/contract/src/review-routing.ts`, `libs/harness/infra/src/embedding-client-live.ts`, `apps/harness-mcp/src/tools/ontology-and-gq.tools.ts`, `apps/harness-mcp/src/tools/review-route-helpers.ts`):** Cold Ollama weights (`clef-flash` and Qwen3-Embedding) and aggressive `1500 ms`–`2500 ms` budgets caused `35` guard timeouts and `4` degraded MCP calls when `6` specialist reviewers executed concurrently.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                      | Effect Symbol                    | Verification |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------ |
| REQ-2.1 | Event-driven       | **When** `OllamaReadiness.ensureWarm` runs during `doctor`, `harness-mcp` startup, `plan-check`, or `verify`, `OllamaReadiness.ensureWarm` **shall** start `ollama serve` with `OLLAMA_KEEP_ALIVE=-1` if absent and probe `clef-flash` via `POST /v1/systemone` rather than generative endpoints (`/api/generate`, `/api/chat`). | OllamaReadiness.ensureWarm       | UnitTest     |
| REQ-2.2 | Event-driven       | **When** `OllamaReadiness.ensureWarm` completes `clef-flash` readiness, `OllamaReadiness.ensureWarm` **shall** issue a single-flight `POST /v1/embeddings` warm-up request via `@harness/service/EmbeddingClient` and cache process-local warm state so embedding weights stay resident without blocking subsequent calls.       | @harness/service/EmbeddingClient | UnitTest     |
| REQ-2.3 | Unwanted behaviour | **If** Ollama fails to become warm within the warm-up probe budget, **then** `OllamaReadiness.ensureWarm` **shall** emit `OllamaWarmupError` diagnostics and allow advisory MCP/router paths to degrade explicitly without mutating workspace files.                                                                             | OllamaWarmupError                | UnitTest     |
| REQ-2.4 | Ubiquitous         | `GuardDecision.decide` and `DEFAULT_REVIEW_ROUTE_TIMEOUT_MS` **shall** read a unified `5000 ms` single-source DecisionModel timeout budget across guard, triage, and review routing while keeping adapter `PreToolUse` hook timeout budgets strictly greater than `5000 ms`.                                                     | GuardDecision.decide             | UnitTest     |
| REQ-2.5 | Event-driven       | **When** concurrent callers invoke `harness_ontology_check` or `harness_review_route`, `McpSingleFlight.run` **shall** serialize or bound Ollama work via a semaphore (`concurrency <= 2`) and coalesce identical inputs by git tree and governance-doc digest within an in-memory cache.                                        | McpSingleFlight.run              | UnitTest     |

### 3 · Two-Tier Mutation Cache, Module-Init Classification & Targeted Iteration

**Source (`libs/harness/gates/src/mutation-check.ts`, `libs/harness/gates/src/mutation/mutation-suite-helpers.ts`, `libs/harness/gates/src/mutation/mutation-package-batch.ts`, `apps/harness-cli/src/commands/mutate-and-bench.command.ts`):** Re-running `107` unchanged source mutants on every boundary test addition (`147 s`–`229 s`) and treating mutated module-init throws as runner infrastructure failures tripled review remediation wall time.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                             | Effect Symbol        | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-3.1 | Event-driven       | **When** `MutationCheck.run` evaluates source files whose source digest matches the cached witness entry while reaching tests were added or edited, `MutationCheck.run` **shall** preserve prior killed-mutant witnesses and verify modified or previously surviving mutants before full re-validation. | MutationCheck.run    | UnitTest     |
| REQ-3.2 | Unwanted behaviour | **If** a mutated module throws a runtime or schema initialization exception during test import while the unmutated baseline imports cleanly, **then** `MutationCheck.decide` (`R = never`) **shall** classify that mutant as `"killed"` rather than `"infraFailure"`.                                   | MutationCheck.decide | GraphCheck   |
| REQ-3.3 | Event-driven       | **When** `MutationCheck.run` receives `--survivors-only` or `--files <paths>`, `MutationCheck.run` **shall** execute the scoped inner-loop subset and omit writing a strict branch-wide mutation stamp.                                                                                                 | MutationCheck.run    | UnitTest     |
| REQ-3.4 | Unwanted behaviour | **If** `MutationCheck.run` executes under `--strict`, **then** `MutationCheck.run` **shall** evaluate every diff-matched mutant under strict rules (`equivalentCount` rules preserved) and write the signed mutation stamp only upon zero surviving mutants.                                            | MutationCheck.run    | UnitTest     |

### 4 · Fail-Fast Verification Ordering, Hook Isolation & Guard Fast-Path Expansion

**Source (`apps/harness-cli/src/commands/verify-and-done.command.ts`, `libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/policy-command-rules.ts`):** Running `nx affected -t verify` before cheap deterministic gates wasted `62 s` before catching stale stamps, self-hosted hook imports broke `15` times during `@harness/contract` refactors, and safe composite verification commands unnecessarily hit `DecisionModel` timeouts.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                      | Effect Symbol           | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ------------ |
| REQ-4.1 | Event-driven       | **When** `HarnessVerify.run` begins verification, `HarnessVerify.run` **shall** check stub absence, format verification, AST/self-dogfooding gates (including file line-count ceilings), `evaluateVerifyMutateStampGate`, and `decideOntologyInvariants` before spawning `nx affected -t verify`.                                                                                                | HarnessVerify.run       | UnitTest     |
| REQ-4.2 | Unwanted behaviour | **If** `evaluateVerifyMutateStampGate` or any cheap pre-flight invariant fails, **then** `HarnessVerify.run` **shall** return non-zero exit immediately without running Nx test suites.                                                                                                                                                                                                          | HarnessVerify.run       | UnitTest     |
| REQ-4.3 | Event-driven       | **When** `PreToolUse` or `Stop` hooks load runtime policy and gate modules while `libs/harness/**` source files are being edited, `HarnessHookRuntime.load` **shall** execute against a stable prebuilt harness hook bundle refreshed on `verify` and fall back to source resolution only when no bundle exists.                                                                                 | HarnessHookRuntime.load | UnitTest     |
| REQ-4.4 | Event-driven       | **When** `PolicyFastPath.decide` (`R = never`) inspects shell commands using chained or variable-expanded read-only inspection (`wc -l`, `rg`, `sed -n`, `df -ih`, `git status/diff/rev-parse`), package-scoped `pnpm --dir` `typecheck`/`lint`/`vitest`, or explicit-path `pnpm oxfmt`, `PolicyFastPath.decide` **shall** approve them deterministically without escalating to `DecisionModel`. | PolicyFastPath.decide   | GraphCheck   |

### 5 · Accurate Telemetry Health Scoring & Actionable Diagnostics

**Source (`libs/harness/gates/src/telemetry.ts`):** `TelemetryReport.decide` penalized expected compile errors in `harness_lsp_diagnostics` as tool failures, hid single `3.4 h` hang outliers inside raw mean latency, gave generic allowlist advice without concrete command prefixes, and reported contradictory `firstPassVerify` KPIs.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                   | Effect Symbol          | Verification |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------ |
| REQ-5.1 | Event-driven       | **When** `TelemetryReport.decide` (`R = never`) aggregates `harness_lsp_diagnostics` events, `TelemetryReport.decide` **shall** exclude `"diagnostics_found"` outcomes from tool failure penalties and penalize only `"tool_error"`, `"timeout"`, and `"fallback"` outcomes.  | TelemetryReport.decide | GraphCheck   |
| REQ-5.2 | Unwanted behaviour | **If** any telemetry metric records an extreme duration outlier (`durationMs > 30000` and `durationMs > 5 * p95DurationMs`), **then** `TelemetryReport.decide` (`R = never`) **shall** emit a hang-outlier recommendation identifying the affected tool and maximum duration. | TelemetryReport.decide | GraphCheck   |
| REQ-5.3 | Unwanted behaviour | **If** `guard` interventions record `DecisionModel` timeouts or ambiguous escalations, **then** `TelemetryReport.decide` (`R = never`) **shall** group and include the top recurring command prefixes in report recommendations.                                              | TelemetryReport.decide | GraphCheck   |
| REQ-5.4 | Ubiquitous         | `TelemetryReport.decide` (`R = never`) **shall** compute `firstPassVerify` consistently from the active event window (`verifyAttempts === 1` and zero prior verify failures in that window) matching `verifyAttempts` and `fixUpIterations`.                                  | TelemetryReport.decide | GraphCheck   |

### 6 · Review Skill Loop Efficiency & Ceiling Headroom Discipline

**Source (`adapters/antigravity/plugins/effect-harness/skills/resolving-effect-review-feedback/SKILL.md`, `adapters/claude-code/skills/resolving-effect-review-feedback/SKILL.md`):** Running `mutate --strict` and `verify` before second-pass re-audits, overloading `libs/harness/infra` workers, overlapping `6`-reviewer file lists, and pushing test files to `1499/1500` lines doubled remediation cycles.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                | Effect Symbol | Verification |
| ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ |
| REQ-6.1 | Event-driven | **When** `resolving-effect-review-feedback` completes Phase 3 contract synchronization, the skill instructions **shall** mandate running `gc --strict` immediately before Phase 4 dispatch.                                                                                                                                | —             | AstGate      |
| REQ-6.2 | Ubiquitous   | The `resolving-effect-review-feedback` skill instructions **shall not** permit running `mutate --strict` or `harness verify` before second-pass specialist re-audit sign-off completes.                                                                                                                                    | —             | AstGate      |
| REQ-6.3 | Event-driven | **When** any fixer or orchestrator touches a source or test file at or above `90%` of its `SelfDogfooding` line-count ceiling, the `resolving-effect-review-feedback` skill instructions **shall** require routing new functions or tests into a focused companion module rather than trimming margins to the final lines. | —             | AstGate      |
| REQ-6.4 | Event-driven | **When** dispatching a targeted second-pass remediation re-audit, the `resolving-effect-review-feedback` skill instructions **shall** require sharing one orchestrator `harness_ontology_check` summary in the reviewer prompts and scoping each specialist strictly to its disjoint P0/P1 remediation hunks.              | —             | AstGate      |

## Assumptions

- **REQ-1.1:** Default `45000 ms` LSP watchdog ceiling may be overridden via explicit tool/runtime config for cold full-monorepo project scans without exceeding hard process-group cleanup guarantees.
- **REQ-2.1 / REQ-2.4:** `5000 ms` applies only when `DecisionModel` is actually invoked on non-allowlisted input; fast-path allowlist matches (`REQ-4.4`) still settle in single-digit milliseconds, and `gc-doc-truth` `hook-timeout-parity` requires updating adapter hook timeouts cleanly above `5000 ms`.
- **REQ-3.1:** Two-tier witness invalidation only preserves witnesses whose mutated source digest AND transitively executed reaching test digest remain unchanged (or when only strictly net-new test cases/files were appended without editing existing assertions covering the witness).
- **REQ-4.3:** Prebuilt hook bundle fallback to live TypeScript execution preserves first-boot ergonomics in clean checkouts prior to the first `verify` build.

## Out of scope

- **Replacing Ollama or `clef-flash` with remote hosted LLM APIs.** All local guard, routing, and embedding inference remains strictly loopback/local per workspace security boundaries. Decides: Harness architecture.
- **Changing semantic EARS / ADR ontology schema predicates (`OntoInvariants`).** Graph ontology schema remains unchanged unless explicitly extended in a separate ADR. Decides: Harness architecture.

## Known residual risks

- Raising `GUARD_DECISION_TIMEOUT_MS` and `DEFAULT_REVIEW_ROUTE_TIMEOUT_MS` to `5000 ms` requires updating matching timeout parity constants in Antigravity and Claude Code adapter `hooks.json` files so `hook-timeout-parity` stays green.
- Prebuilt hook bundle isolation (`REQ-4.3`) risks temporarily testing stale hook code during `libs/harness/gates` self-edits until the bundle is explicitly rebuilt in `verify`; a CLI flag/env override for live hook source execution mitigates gate debugging loops.
- `MutationCheck.decide` classification of module-init throws (`REQ-3.2`) relies on running an unmutated baseline import check per package first so pre-existing broken package imports are never misclassified as killed mutants.

## Acceptance criteria

- All requirement rows (`REQ-1.1`..`REQ-6.4`) pass their declared `Verification` methods (`UnitTest`, `GraphCheck`, `AstGate`) when promoted to `status: proposed` / `status: accepted`.
- Affected 5-tier hexagonal Nx packages respect `HarnessTierTopology.decide` and `SelfDogfooding.decide`, and both Antigravity and Claude Code `resolving-effect-review-feedback` skills pass `adapter-skill-parity`.
- Frontmatter `status` is updated to `accepted` upon implementation and verified end-to-end by `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, `pnpm harness mutate --strict`, `CI=true pnpm harness verify`, and `CI=true pnpm harness done --cli`.
