---
id: harness:SPEC-0033
title: Harness Worktree MCP Routing, Inner-Loop Latency Speedups, Accurate Triage, and Preventive AST/GC Gates
status: accepted
archetype: framework
date: 2026-11-24
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0002
  - harness:ADR-0003
  - harness:ADR-0004
  - harness:ADR-0011
  - harness:ADR-0018
  - harness:ADR-0020
  - harness:ADR-0021
  - harness:ADR-0023
  - harness:ADR-0026
enforced_by:
  - apps/harness-mcp/src/tools/mcp-helpers.ts
  - apps/harness-mcp/src/tools/mcp-repo-root.ts
  - apps/harness-mcp/src/tools/retrieval.tools.ts
  - apps/harness-mcp/src/tools/graph-navigation.tools.ts
  - apps/harness-mcp/src/tools/ontology-and-gq.tools.ts
  - apps/harness-mcp/src/tools/datalog-and-dpo.tools.ts
  - apps/harness-mcp/src/tools/git-diff.tools.ts
  - apps/harness-mcp/src/tools/workflow-plan.tools.ts
  - apps/harness-mcp/src/tools/review-route-helpers.ts
  - apps/harness-mcp/src/tools/review-route-git.ts
  - apps/harness-mcp/src/tools/lsp-and-telemetry.tools.ts
  - apps/harness-mcp/src/tools/lsp-session-cache.ts
  - apps/harness-mcp/src/tools/tool-registry.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - apps/harness-cli/src/commands/session-learn-report.command.ts
  - apps/harness-cli/src/commands/session-fastpath.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
  - apps/harness-cli/src/commands/verify-doc-fastpath.ts
  - apps/harness-cli/src/commands/plan-and-repair.command.ts
  - apps/harness-cli/src/commands/plan-snapshot-fastpath.ts
  - apps/harness-cli/src/commands/repo-path.ts
  - apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts
  - apps/harness-cli/src/commands/nx-affected-git.helpers.ts
  - apps/harness-cli/src/commands/learn-and-report.command.ts
  - apps/harness-cli/src/commands/guard-and-route.command.ts
  - apps/harness-cli/src/commands/ollama-readiness.ts
  - apps/harness-cli/src/commands/omnigraph-auth-and-drift.ts
  - apps/harness-cli/src/commands/omnigraph-lifecycle-setup.ts
  - apps/harness-cli/src/commands/omnigraph-lifecycle.ts
  - apps/harness-cli/src/commands/omnigraph-lint-gate.ts
  - apps/harness-cli/src/commands/omnigraph-safety-helpers.ts
  - apps/harness-cli/src/commands/omnigraph-workflow-backup.ts
  - apps/harness-cli/src/commands/omnigraph-workflow-journal.ts
  - apps/harness-cli/test/adapter-config.test.ts
  - apps/harness-cli/test/adapter-skills-parity.test.ts
  - apps/harness-cli/test/adapter-isolation-and-cold-start.test.ts
  - libs/harness/contract/src/ast-and-gate-primitives.ts
  - libs/harness/contract/src/workflow-ship.ts
  - libs/harness/contract/src/workflow-storage.ts
  - libs/harness/contract/src/workflow-timeouts.ts
  - libs/harness/contract/src/workspace-and-process.ts
  - libs/harness/decision/src/triage-decision.ts
  - libs/harness/decision/src/guard-decision.ts
  - libs/harness/gates/src/ast-cache.ts
  - libs/harness/gates/src/telemetry.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/policy-command-lists.ts
  - libs/harness/gates/src/policy-command-rules.ts
  - libs/harness/gates/src/policy-worker-isolation.ts
  - libs/harness/gates/src/policy-worker-isolation-helpers.ts
  - libs/harness/gates/src/ears-lint.ts
  - libs/harness/gates/src/verify-stamp.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/plugins/ast-gate-visitors.ts
  - libs/harness/gates/src/plugins/ast-fail-closed-laws.ts
  - libs/harness/gates/src/plugins/ast-literal-branch-law.ts
  - libs/harness/gates/src/plugins/ast-wave3-laws.ts
  - libs/harness/gates/src/plugins/ast-workflow-fence-law.ts
  - libs/harness/gates/src/plugins/ast-workflow-status-law.ts
  - libs/harness/gates/src/plugins/self-dogfooding-plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-catalog-doc-truth.ts
  - libs/harness/gates/src/plugins/gc/gc-topology-entropy.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-runtime-props.ts
  - libs/harness/gates/src/plugins/gc/gc-hook-fastpath.ts
  - libs/harness/gates/src/plugins/gc/gc-workspace-io.ts
  - libs/harness/gates/src/mutation/mutation-barrel-reachability.ts
  - libs/harness/gates/src/mutation/mutation-package-batch.ts
  - libs/harness/gates/src/mutation/mutation-target-discovery.ts
  - libs/harness/gates/src/mutation/mutation-test-reachability.ts
  - libs/harness/graph/src/extractor/ast-policy-extractor.ts
  - libs/harness/graph/src/extractor/brand-boundary-extractor.ts
  - libs/harness/graph/src/extractor/reducer-policy-extractor.ts
  - libs/harness/graph/src/extractor/extractor-types-and-helpers.ts
  - libs/harness/infra/src/node-host-io.ts
  - libs/harness/infra/src/hook-fastpath.ts
  - libs/harness/infra/src/hook-io.ts
  - libs/harness/infra/src/omnigraph-session.ts
  - libs/harness/infra/src/worktree-repo-root.ts
  - tools/oxlint/syntax-bans.js
  - tools/package-vitest-batch.mjs
  - tools/vitest-pool-helpers.mjs
spans:
  - HarnessMcp.dispatchTool
  - HarnessMcp.resolveContainedRepoRoot
  - HarnessMcp.routeReview
  - SessionReport.decide
  - SessionHandoff.decide
  - Harness.triageFailure
  - Harness.decideGuardCommand
  - MutationCheck.decide
  - AstGateCache.decide
  - SyntaxBans.decide
  - EffectLaws.decide
  - GraphGc.decide
  - TestIntegrity.decide
  - EarsSpecLint.decide
services: []
errors:
  - ProjectPathEscapeError
---

## Context

Forensic telemetry analysis of the WF-4 and PR #48 engineering session (`3,318` events across `~4h`) exposed compounding reliability, latency, and observability weaknesses in the harness itself: `resolveDefaultRepoRoot` short-circuited on a stale `process.cwd()` missing `pnpm-workspace.yaml` before reading canonical `.harness/active-workspace.json`; `resolveContainedRepoRoot` rejected valid linked git worktrees with `ProjectPathEscapeError`; `recordMcpToolTelemetry` logged `outcome: "ok"` on `100%` degraded (`corrupt-graph-snapshot`) `harness_ontology_check` and `harness_tests_reaching` responses while leaving `11` of `18` `harness-mcp` tools unused; `harness_lsp_diagnostics` spawned cold `effect-tsgo` processes and discarded a freshly constructed `TypeScriptProgramSession` on every call (`455.8s` total, `p95 = 18.7s`); `hook:session` imported the root `@harness/infra` barrel on cache miss (`183.0s` total) and crashed when `@harness/infra` had a transient edit error; `GuardV1` timed out at `1500ms` on `44%` (`14/32`) of escalated benign read-only commands; `Harness.triageFailure` matched passing-test stdout to emit a false `mutate --strict` hint on parallel Nx Vitest timeouts; and `mutate --strict` lost `152.8s` executing 42 unrelated fallback test files for a single isolated policy module.

In parallel, PR #48 review (`14` findings / `23` atomic IDs) and multi-pass specialist audits revealed recurring defect classes not yet blocked deterministically by harness gates: `Effect.ignore` swallowing rollback errors in `type:core` and finalizers (`domain-effect-ignore` covered `type:domain` only); imperative equality branching on closed `Schema.Literals` variables (`stage === "done"`) bypassing `DISC_RE`; direct `Workflow.interrupt` calls without settle/cancellation inside lock scopes; unguarded terminal state overwrites in workflow stores; fabricated 64-char sentinel hashes (`"0".repeat(64)`) and `.slice(0, MAX)` truncating escalation suffixes; `git` exec calls lacking `--end-of-options` and dynamic `new RegExp` glob matchers vulnerable to ReDoS; worker-isolation subcommand drift across `policy.ts`, `ADR-0018`, and adapters; always-populated optional fields on internal `*Runtime` interfaces; and naive `split("|")` Markdown table parsing in `EarsSpecLint.decide`.

- **Reused Contracts / Errors:** `ProjectPathEscapeError`, `TelemetryEvent`, `TelemetryOutcome`, `WORKFLOW_TIMEOUT_BUDGETS`, `SHIP_STAGES` from `@harness/contract` and `apps/harness-mcp`
- **Reused Helpers & Engines:** `validateWorktreeRepoRoot` (`libs/harness/infra/src/worktree-repo-root.ts`), `createTypeScriptProgramSession` (`@harness/graph`), `splitMarkdownTableCells` (`governance-markdown-helpers.ts`), `findTestsReaching` (`@harness/graph`), `decideSessionReport`, `decideEarsSpecQuality`, `decideGraphEntropy`, `decideAstGateCache`
- **New Capabilities Needed:** Worktree-aware MCP root validation and degraded-response telemetry recording, failure-section-scoped `Harness.triageFailure` and bounded Nx parallelism in `verify`, hook-fastpath isolation for `session-learn-report.command.ts`, expanded read-only guard allowlist with `2500ms` `GuardV1` budget, per-repo warm `TypeScriptProgramSession` cache and single-flight `effect-tsgo` deduplication, reverse-import-scoped mutation fallback targeting, lean session cache fingerprinting, incremental zero-stub `plan-check` fast-path, auto-computed `changedLineCount` in `HarnessMcp.routeReview`, shared `formatBoundedErrorMessage` helper, and Wave 3 AST/GC/Graph preventive gates

## Goal

Every `harness-mcp` call resolves linked git worktrees reliably and reports degraded responses accurately in telemetry and `SessionReport.decide`, inner-loop checks (`harness_lsp_diagnostics`, `hook:session`, `mutate --strict`, `plan-check`, `verify`) execute without cold-session churn or parallel CPU starvation, `hook:session` never crashes on live `@harness/infra` edits, `Harness.triageFailure` diagnoses real test failures accurately, and every PR #48 defect class is prevented deterministically before code review by AST, GC, contract, and EARS lint gates across three prioritized delivery waves.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Wave 1 — Worktree MCP Routing, Degraded Telemetry Truth, Accurate Triage, and Hook Isolation

**Source (`apps/harness-mcp/src/tools/mcp-helpers.ts`, `mcp-repo-root.ts`, `retrieval.tools.ts`, `graph-navigation.tools.ts`, `ontology-and-gq.tools.ts`, `datalog-and-dpo.tools.ts`, `git-diff.tools.ts`, `workflow-plan.tools.ts`, `apps/harness-cli/src/commands/declarative-cli.ts`, `session-learn-report.command.ts`, `verify-and-done.command.ts`, `verify-doc-fastpath.ts`, `repo-path.ts`, `daemon-and-omnigraph.service.ts`, `nx-affected-git.helpers.ts`, `learn-and-report.command.ts`, `guard-and-route.command.ts`, `ollama-readiness.ts`, `omnigraph-lifecycle.ts`, `libs/harness/decision/src/triage-decision.ts`, `guard-decision.ts`, `libs/harness/gates/src/policy.ts`, `policy-command-lists.ts`, `policy-command-rules.ts`, `policy-worker-isolation.ts`, `telemetry.ts`, `libs/harness/infra/src/node-host-io.ts`, `hook-fastpath.ts`, `hook-io.ts`, `omnigraph-session.ts`, `worktree-repo-root.ts`):** Immediate correctness and observability fixes that restore MCP reliability across linked worktrees, eliminate misleading telemetry and triage hints, and harden `session`/`guard` hooks.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Effect Symbol                       | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------ |
| REQ-1.1 | Event-driven       | **When** `resolveDefaultRepoRoot` inspects `process.cwd()` inside a directory lacking `pnpm-workspace.yaml`, `resolveDefaultRepoRoot` **shall** skip the invalid `cwdRoot` and resolve the newest valid workspace path from canonical `active-workspace.json` before falling back to `SERVER_REPO_ROOT`.                                                                                                                                                      | HarnessMcp.dispatchTool             | UnitTest     |
| REQ-1.2 | Event-driven       | **When** `resolveContainedRepoRoot` receives an explicit `repoRoot` pointing to a linked git worktree sharing the repository `git-common-dir`, `resolveContainedRepoRoot` **shall** accept that worktree path via `validateWorktreeRepoRoot`.                                                                                                                                                                                                                 | HarnessMcp.resolveContainedRepoRoot | UnitTest     |
| REQ-1.3 | Unwanted behaviour | **If** `resolveContainedRepoRoot` receives a `repoRoot` path outside the repository worktree set or escaping via symlinks, **then** `resolveContainedRepoRoot` **shall** fail with `ProjectPathEscapeError`.                                                                                                                                                                                                                                                  | ProjectPathEscapeError              | UnitTest     |
| REQ-1.4 | Event-driven       | **When** `recordMcpToolTelemetry` records an MCP response whose payload has `degraded` equal to `true` or a non-empty `degradedReason`, `recordMcpToolTelemetry` **shall** log `outcome` as `"fallback"` with `"degraded=<reason>"` (up to `160` chars, defaulting blank reasons to `"degraded=degraded"`) attached in `detail` so `SessionReport.decide` deducts health score and emits a degraded-MCP recommendation.                                       | SessionReport.decide                | UnitTest     |
| REQ-1.5 | State-driven       | **While** every `verify` attempt in the session window is preceded by passing `gc` and `ontology:check` events, `SessionReport.decide` **shall** omit the pre-verify `gc` and `ontology` reminder and emit targeted diagnostics for degraded MCP calls or verify test timeouts.                                                                                                                                                                               | SessionReport.decide                | PropertyTest |
| REQ-1.6 | Event-driven       | **When** `Harness.triageFailure` classifies a failed `verify` or Nx subprocess log, `Harness.triageFailure` **shall** restrict pattern matching to extracted Vitest failure blocks after `FAIL` or `Failed Tests` markers alongside compiler/linter pre-footer diagnostics and classify `Test timed out in` failures with a timeout-contention triage hint.                                                                                                   | Harness.triageFailure               | UnitTest     |
| REQ-1.7 | Event-driven       | **When** `handleVerify` constructs Nx arguments via `resolveNxAffectedArgs` for multi-project verification, `handleVerify` and `resolveNxAffectedArgs` **shall** enforce a bounded `--parallel` concurrency cap and derived `VITEST_MAX_WORKERS` budget to prevent parallel Vitest CPU timeout storms.                                                                                                                                                        | —                                   | UnitTest     |
| REQ-1.8 | Ubiquitous         | `session-learn-report.command.ts` and all hook-reachable command modules **shall** import host I/O strictly from lightweight hook subpaths (`@harness/infra/hook-fastpath`, `@harness/infra/hook-io`, or `@harness/infra/omnigraph-session`) instead of the root `@harness/infra` barrel under `hook-fastpath-forbidden-import`.                                                                                                                              | GraphGc.decide                      | AstGate      |
| REQ-1.9 | Event-driven       | **When** `classifyCommand` evaluates benign read-only commands including literal `echo` (without expansion or redirection), `cut`, `true`, `git merge-base`, read-only `git symbolic-ref` / `git config --get` flag allowlists, `git ls-remote`, and `git --version` without deny or redirection tokens, `Harness.decideGuardCommand` **shall** allow them on the deterministic fast-path and enforce a `2500ms` timeout budget on escalated `GuardV1` calls. | Harness.decideGuardCommand          | UnitTest     |

### 2 · Wave 2 — Inner-Loop Latency Speedups (Warm LSP, Scoped Mutation Fallback, Lean Session Cache, Incremental Plan-Check)

**Source (`apps/harness-mcp/src/tools/lsp-and-telemetry.tools.ts`, `lsp-session-cache.ts`, `mcp-helpers.ts`, `tool-registry.ts`, `libs/harness/gates/src/verify-stamp.ts`, `mutation-check.ts`, `mutation/mutation-barrel-reachability.ts`, `mutation/mutation-package-batch.ts`, `mutation/mutation-target-discovery.ts`, `mutation/mutation-test-reachability.ts`, `libs/harness/infra/src/hook-io.ts`, `apps/harness-cli/src/commands/session-fastpath.ts`, `plan-and-repair.command.ts`, `plan-snapshot-fastpath.ts`, `tools/package-vitest-batch.mjs`, `tools/vitest-pool-helpers.mjs`):** Eliminates the four dominant interactive latency sinks measured in WF-4 telemetry (`harness_lsp_diagnostics` `455.8s`, `plan-check` `298.8s`, `mutate` fallback cascades `152.8s`, and `hook:session` misses `128.9s`).

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                    | Effect Symbol           | Verification |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ------------ |
| REQ-2.1 | Event-driven | **When** `runDefaultLspDiagnostics` evaluates file or project diagnostics in `harness-mcp`, `runDefaultLspDiagnostics` **shall** reuse a per-`repoRoot` warm `TypeScriptProgramSession` invalidated by file `mtimeMs` and deduplicate concurrent identical `effect-tsgo` runs. | HarnessMcp.dispatchTool | UnitTest     |
| REQ-2.2 | Event-driven | **When** mutation reachability selects fallback tests for a modified module whose primary tests leave surviving mutants, `MutationCheck.decide` **shall** narrow fallback targets via reverse-import dependency closure before escalating to full-package test execution.      | MutationCheck.decide    | UnitTest     |
| REQ-2.3 | Event-driven | **When** `computePreInvocationFingerprintLite` and `computePreInvocationFingerprint` derive the `session` hook cache fingerprint, both helpers **shall** digest git branch, `HEAD` SHA, and `.harness` metadata rather than invalidating on every routine source-file edit.    | SessionHandoff.decide   | UnitTest     |
| REQ-2.4 | Event-driven | **When** `handlePlanCheck` runs with zero active stubs and an existing verified graph snapshot matching current workspace `treeHash` and git `HEAD`, `handlePlanCheck` **shall** reuse the snapshot instead of re-extracting the full workspace graph and resyncing Omnigraph. | —                       | UnitTest     |

### 3 · Wave 3 — Preventive AST, GC, Graph, Contract, and Review-Surface Gates

**Source (`libs/harness/gates/src/ast-cache.ts`, `src/plugins/ast-gate-visitors.ts`, `ast-fail-closed-laws.ts`, `ast-literal-branch-law.ts`, `ast-wave3-laws.ts`, `ast-workflow-fence-law.ts`, `ast-workflow-status-law.ts`, `self-dogfooding-plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts`, `gc-catalog-doc-truth.ts`, `gc-topology-entropy.plugin.ts`, `gc-runtime-props.ts`, `libs/harness/gates/src/ears-lint.ts`, `policy-worker-isolation.ts`, `policy-worker-isolation-helpers.ts`, `policy.ts`, `libs/harness/contract/src/workspace-and-process.ts`, `workflow-ship.ts`, `workflow-storage.ts`, `workflow-timeouts.ts`, `ast-and-gate-primitives.ts`, `libs/harness/graph/src/extractor/ast-policy-extractor.ts`, `brand-boundary-extractor.ts`, `reducer-policy-extractor.ts`, `extractor-types-and-helpers.ts`, `apps/harness-mcp/src/tools/graph-navigation.tools.ts`, `review-route-helpers.ts`, `review-route-git.ts`, `apps/harness-cli/test/adapter-config.test.ts`, `adapter-skills-parity.test.ts`, `adapter-isolation-and-cold-start.test.ts`, `tools/oxlint/syntax-bans.js`):** Promotes every systemic defect class discovered in PR #48 review and specialist audits into deterministic enforcement gates.

| ID       | Pattern      | Requirement                                                                                                                                                                                                                                                                                               | Effect Symbol          | Verification |
| -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------ |
| REQ-3.1  | Ubiquitous   | `EffectLaws.decide` **shall** ban `Effect.ignore` and silent error-swallowing combinators across `type:core` packages and inside `Effect.onExit`, `Effect.ensuring`, `Effect.onInterrupt`, `Effect.addFinalizer`, and workflow compensation callbacks outside an explicit logging allowlist.              | EffectLaws.decide      | AstGate      |
| REQ-3.2  | Ubiquitous   | `SyntaxBans.decide` and `ast-policy-extractor.ts` **shall** flag imperative `if` or ternary equality checks against string literals on expressions typed as closed `Schema.Literals` or string-literal unions of two or more variants, requiring exhaustive `ts-pattern` matching.                        | SyntaxBans.decide      | AstGate      |
| REQ-3.3  | Ubiquitous   | `ast-workflow-fence-law.ts` **shall** reject direct `Workflow.interrupt` invocations in `apps/harness-mcp/src/daemon` outside centralized interrupt-and-settle helpers and require guarded `current.status` preconditions on workflow status-transition updates.                                          | AstGateCache.decide    | AstGate      |
| REQ-3.4  | Ubiquitous   | `SyntaxBans.decide` and `ast-fail-closed-laws.ts` **shall** ban fabricated 64-character sentinel hashes (`"0".repeat(64)` or `"f".repeat(64)`) in production `src` files, dynamic `new RegExp` constructions over variable glob patterns, and dynamic `git` ref calls missing `--end-of-options` or `--`. | SyntaxBans.decide      | AstGate      |
| REQ-3.5  | Ubiquitous   | `gc-catalog-doc-truth.ts` **shall** derive the canonical worker-isolated workflow subcommand set from `policy-worker-isolation.ts` and enforce exact parity across `policy.ts`, `ADR-0018`, and both Claude Code and Antigravity `README.md` and `SKILL.md` documents.                                    | GraphGc.decide         | AstGate      |
| REQ-3.6  | Ubiquitous   | `gc-topology-entropy.plugin.ts` **shall** flag internal `*Runtime` and `*Context` optional properties in `apps/**` that every live production constructor populates unconditionally.                                                                                                                      | GraphGc.decide         | GraphCheck   |
| REQ-3.7  | Event-driven | **When** `EarsSpecLint.decide` parses Markdown requirement tables containing escaped pipe delimiters or inline code spans, `EarsSpecLint.decide` **shall** parse row cells via the shared `splitMarkdownTableCells` helper from `governance-markdown-helpers.ts`.                                         | EarsSpecLint.decide    | UnitTest     |
| REQ-3.8  | Event-driven | **When** `HarnessMcp.routeReview` is invoked without an explicit `changedLineCount` argument, `executeReviewRouteTool` **shall** derive `changedLineCount` automatically from `git diff --numstat` instead of failing argument decoding.                                                                  | HarnessMcp.routeReview | UnitTest     |
| REQ-3.9  | Ubiquitous   | Multi-stage workflow timeout validators in `@harness/contract` **shall** enforce settle timeout budgets strictly exceeding `STAGES.length` multiplied by the per-stage command timeout budget.                                                                                                            | —                      | UnitTest     |
| REQ-3.10 | Ubiquitous   | Bounded error message formatters in `@harness/contract` **shall** preserve trailing escalation suffixes within character caps via a shared `formatBoundedErrorMessage` helper rather than raw leading `.slice(0, maxChars)` truncation.                                                                   | —                      | UnitTest     |
| REQ-3.11 | Ubiquitous   | The `harness-cli` adapter parity test suite **shall** partition `adapter-config.test.ts` into focused test files each staying below `1100` lines and `25` test cases under `TestIntegrity.decide`.                                                                                                        | TestIntegrity.decide   | UnitTest     |

## Assumptions

- **REQ-1.7:** Default `nx affected` parallelism cap in `handleVerify` is `Math.min(4, getHostAvailableParallelism())` (capped at `MAX_VERIFY_PARALLEL_CAP = 32` via `HARNESS_VERIFY_PARALLEL`), with derived `VITEST_MAX_WORKERS = Math.max(1, Math.floor(cpuCount / cap))` via `resolveVitestMaxWorkers`.
- **REQ-1.9:** `GuardV1` `DecisionModel` timeout increases from `1500ms` to `2500ms` to absorb brief Ollama contention without exceeding interactive hook UX latency limits.
- **REQ-2.1:** Warm `TypeScriptProgramSession` cache in `harness-mcp` is bounded (e.g. LRU of up to `4` `repoRoot` entries) and evicted on `tsconfig*.json` `mtimeMs` change or server shutdown.
- **REQ-2.3:** Excluding routine source-file diffs from the `session` pre-invocation fingerprint preserves full freshness for `.harness/friction-log.jsonl`, `verify-stamp.json`, `last-done.json`, `graph-snapshot.json`, `HEAD` SHA, and active branch changes; source-file freshness continues to be enforced by `ingest`, `verify`, and `done`.
- **REQ-3.1:** Explicit logging allowlist for `Effect.ignore` inside cleanup/finalizer blocks permits only side-effecting log/telemetry sinks (`Effect.log*`, `recordTelemetry*`, `process.stderr.write`) and never backup recovery, lock release, or store persistence calls.
- **REQ-3.11:** Splitting `adapter-config.test.ts` preserves every existing assertion with zero coverage reduction while creating ~400+ lines of headroom below the `1500`-line `TestIntegrity.decide` limit.

## Out of scope

- **Retroactive telemetry backfill.** Rewriting historical rows already recorded in local gitignored `.harness/telemetry-log.jsonl` files prior to Wave 1.
- **Automatic IDE MCP process restart.** Restarting pre-booted IDE `harness-mcp` processes stuck on deleted worktrees (requires IDE reload; Wave 1 fixes root resolution for live servers).
- **Bulk repository `oxfmt` cleanup on `main`.** Reformatting the 82 pre-existing unrelated files failing repo-wide `oxfmt --check` belongs in a dedicated standalone formatting PR so functional diffs stay minimal.
- **WF-5 agent runners & WF-6 projector sync.** Covered separately under `RFC-0013` and `harness:ADR-0018`.

## Known residual risks

- Narrowing `session` pre-invocation fingerprinting (`REQ-2.3`) means edits to source files will not immediately trigger a fresh `SessionHandoff` recomputation until the next branch/HEAD/friction change or `PRE_INVOCATION_CACHE_TTL_MS` expiry (`300s`); this is acceptable because `verify` and `done` always compute fresh workspace tree hashes independently.
- Tightening `EffectLaws.decide` (`REQ-3.1`) and `SyntaxBans.decide` (`REQ-3.2`, `REQ-3.4`) may uncover pre-existing legacy violations across `libs/harness/**` or `apps/**`, which must be fixed in the Wave 3 PR before enabling strict enforcement.

## Acceptance criteria

- All three waves (`REQ-1.1..1.9`, `REQ-2.1..2.4`, `REQ-3.1..3.11`) are promoted from `status: draft` to `status: proposed` per wave when entering `planning-effect-skeletons` and to `status: accepted` upon completion with 100% mutant kill on modified pure modules.
- While in `status: draft` or `status: proposed`, `pnpm harness gc --strict` and `pnpm harness ontology check --strict` pass with zero findings and zero semantic conflicts.
- Upon Wave 1–3 completion, `harness_lsp_diagnostics` p95 drops below `5s` on warm calls, `hook:session` zero-crash isolation holds during `@harness/infra` edits, `harness-mcp` resolves sibling worktrees with `0` spurious `ProjectPathEscapeError` rejections, and all Wave 3 AST/GC gates pass `CI=true pnpm harness verify` and `CI=true pnpm harness done --cli`.
