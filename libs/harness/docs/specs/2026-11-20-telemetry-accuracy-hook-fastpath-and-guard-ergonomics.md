---
id: harness:SPEC-0024
title: Telemetry Accuracy, Test Isolation, Hook Fast-Path, and Guard Ergonomics
status: accepted
archetype: framework
date: 2026-11-20
owners:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/gates/src/policy-command-rules.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/session-handoff.ts
  - libs/harness/gates/src/mutation-subprocess-helpers.ts
  - libs/harness/gates/src/telemetry.ts
  - libs/harness/gates/test/policy.test.ts
  - libs/harness/gates/test/session-handoff-and-budget.test.ts
  - libs/harness/gates/test/telemetry.test.ts
  - libs/harness/gates/test/mutation-cache.test.ts
  - libs/harness/infra/src/node-host-io.ts
  - libs/harness/infra/src/index.ts
  - libs/harness/infra/src/hook-io.ts
  - libs/harness/infra/test/hook-io-and-lazy-model.test.ts
  - libs/harness/infra/test/reliability.test.ts
  - apps/harness-mcp/src/tools/mcp-helpers.ts
  - apps/harness-mcp/src/tools/lsp-and-telemetry.tools.ts
  - apps/harness-mcp/src/tools/git-diff.tools.ts
  - apps/harness-mcp/test/ontology-tools.test.ts
  - apps/harness-mcp/test/git-diff.tools.test.ts
  - apps/harness-cli/src/commands/repo-path.ts
  - apps/harness-cli/src/commands/cli-runtime.ts
  - apps/harness-cli/src/commands/stop-hook-and-transcript.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
  - apps/harness-cli/src/commands/session-fastpath.ts
  - apps/harness-cli/src/commands/session-learn-report.command.ts
  - apps/harness-cli/src/commands/guard-and-route.command.ts
  - apps/harness-cli/src/commands/hook-fastpath-core.ts
  - apps/harness-cli/test/adapter-config.test.ts
  - apps/harness-cli/test/hook-entry-fastpath.test.ts
  - apps/harness-cli/test/index.test.ts
  - adapters/antigravity/plugins/effect-harness/hooks.json
  - adapters/antigravity/plugins/effect-harness/README.md
  - adapters/antigravity/plugins/effect-harness/skills/effect-lfg/references/multi-slice-worktree-execution.md
  - adapters/claude-code/hooks.json
spans:
  - SessionReport.decide
  - SessionHandoff.decide
  - HarnessMcp.gitDiff
  - Harness.decideGuardCommand
services: []
errors: []
---

## Context

Forensic inspection of `.harness/telemetry-log.jsonl` and `harness_telemetry_report` across worktree and main-repo runs uncovered nine compounding observability, isolation, hook-coverage, and latency defects: `harness_telemetry_report` read `.harness/active-workspace.json` only from `SERVER_REPO_ROOT` while CLI invocations wrote only to the active worktree's `CLI_REPO_ROOT`, returning stale main-repo telemetry; Vitest suites polluted live `.harness/telemetry-log.jsonl` across both CLI (`VITEST` / `NODE_ENV=test` unchecked) and `harness-mcp` (unconditional `appendTelemetryEvent`); `isSubagentStopContext` classified any linked checkout under `/.gemini/antigravity/worktrees/` as a subagent and ran unconditionally even during explicit `pnpm harness done`, bypassing `verify-stamp.json` and `omnigraph:merge-main`; Antigravity `hooks.json` omitted `edit_file` and `write_file` from file-edit/ingest matchers while invoking heavy `index.ts done` instead of `hook-entry.ts done`; `session` cache fingerprinting executed two `git` scans, hashed the typo filename `"telemetry.jsonl"`, ran full SHA-256 over multi-megabyte `graph-snapshot.json` / `plan-graph-snapshot.json` files on every turn, refused short-TTL caching on non-fatal degraded sessions, and left multi-line friction summaries uncompacted in `injectSteps`; `stripSafeLeadingEnvVarsDetailed` failed to strip validated `env -u <SAFE_VAR>` prefixes and `isAllowedFilter` / `ALLOWLIST` omitted benign `rg`, `wc`, `df`, and `git worktree list` inspections; `harness_git_diff` executed three to four independent `git` commands sequentially; `runVitestPackageBaseline` omitted `--bail=1` during whole-package pre-flight checks; and `SessionReport.decide` ignored non-verify gate failures, guard timeouts, session hook failures/cache miss ratios, and missing `ingest` hook coverage while failed guard/CLI/LSP events omitted structured `detail` diagnostics.

- **Reused Contracts / Errors:** `SyncHostExecResult`, `TelemetryEvent`, `TelemetryOutcome` from `@harness/contract`
- **Reused Services:** `SyncHostIo` from `@harness/service/host-io`
- **New Capabilities Needed:** Cross-worktree `active-workspace.json` synchronization (`resolveDefaultRepoRoot` + `runCliEffect` canonical write), `VITEST` / `NODE_ENV=test` live-repo telemetry suppression in CLI (`shouldSuppressLiveRepoTestSideEffects`), hook-io (`shouldSuppressLiveRepoTestSideEffectsLite`), and MCP (`shouldSuppressLiveMcpTestSideEffects`), explicit Stop-hook scoping for `isSubagentStopContext` without path-based worktree false positives, `edit_file`/`write_file` hook coverage and lightweight `fullyIdle=false` `done` fast-path in `hook-fastpath-core.ts`, single-`git` (`--ignored=matching`) + metadata-digested snapshot fingerprinting with `30_000ms` degraded session cache TTL (`PRE_INVOCATION_CACHE_TTL_MS` vs `DEGRADED_PRE_INVOCATION_CACHE_TTL_MS`) and compact `<= 120`-char `SessionHandoff` friction lines, validated `env -u <SAFE_VAR>` / `--unset=<SAFE_VAR>` guard stripping, `execFileAsyncEffect` concurrent `HarnessMcp.gitDiff` execution, `--bail=1` package baseline checks in `runVitestPackageBaseline`, and extended `SessionReport.decide` health scoring + structured failure `detail` fields.

## Goal

Every `harness_telemetry_report` resolves the active worktree reliably and exposes `resolvedRepoRoot`, Vitest runs leave live `.harness/` state untouched across CLI, hooks, and MCP, Antigravity worktree sessions and explicit `pnpm harness done` enforce full verification and Omnigraph merge semantics, Antigravity hooks cover `edit_file`/`write_file` and fast-path `fullyIdle=false` exits without heavy barrel loads, session cache hits run with a single `git status` invocation and metadata-digested snapshots plus 30-second degraded caching and compact handoffs, safe `env -u` prefixes and read-only `df`/`git worktree list`/`rg`/`wc` patterns execute on the 6ms guard fast-path, `HarnessMcp.gitDiff` runs independent `git` queries concurrently, `runVitestPackageBaseline` fails fast with `--bail=1`, and `SessionReport.decide` plus failed guard/CLI/LSP events surface actionable diagnostics.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Worktree Workspace Routing, Test Isolation, and Stop-Hook Accuracy

**Source (`apps/harness-cli/src/commands/cli-runtime.ts`, `repo-path.ts`, `stop-hook-and-transcript.ts`, `verify-and-done.command.ts`, `apps/harness-mcp/src/tools/mcp-helpers.ts`, `lsp-and-telemetry.tools.ts`, `libs/harness/infra/src/hook-io.ts`):** Telemetry queries must target the active worktree cleanly without test contamination or false-positive subagent bypasses.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                        | Effect Symbol         | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------ |
| REQ-1.1 | Event-driven       | **When** `runCliEffect` persists `.harness/active-workspace.json` from a linked git worktree, `runCliEffect` **shall** also mirror that workspace record to `<canonicalRoot>/.harness/active-workspace.json` so `resolveDefaultRepoRoot` resolves the latest workspace across main and worktree checkouts and `harness_telemetry_report` emits `resolvedRepoRoot`. | SessionReport.decide  | UnitTest     |
| REQ-1.2 | State-driven       | **While** `VITEST` equals `"true"` or `NODE_ENV` equals `"test"` without an explicit `HARNESS_STATE_DIR`, `shouldSuppressLiveRepoTestSideEffects`, `shouldSuppressLiveRepoTestSideEffectsLite`, and `shouldSuppressLiveMcpTestSideEffects` **shall** suppress telemetry and friction writes for any target inside the live repository root.                        | SessionReport.decide  | UnitTest     |
| REQ-1.3 | Unwanted behaviour | **If** a directory path contains `/.gemini/antigravity/worktrees/` or `handleDone` runs as an explicit CLI command outside hook mode, **then** `isSubagentStopContext` and `handleDone` **shall not** classify the run as a subagent Stop hook or bypass verification and `omnigraph:merge-main`.                                                                  | SessionReport.decide  | UnitTest     |
| REQ-1.4 | Event-driven       | **When** `isMutatingTranscriptToolCall` inspects Antigravity transcript entries for `edit_file` or `write_file`, `isMutatingTranscriptToolCall` **shall** evaluate `tc.args?.Path` alongside `TargetFile` and `file_path` so brain-directory markdown writes are treated as non-mutating.                                                                          | SessionHandoff.decide | UnitTest     |

### 2 · Adapter Hook Coverage, `done` Fast-Path, Session Cache & Compact Handoffs

**Source (`adapters/antigravity/plugins/effect-harness/hooks.json`, `adapters/claude-code/hooks.json`, `apps/harness-cli/src/commands/hook-fastpath-core.ts`, `session-fastpath.ts`, `session-learn-report.command.ts`, `libs/harness/infra/src/hook-io.ts`, `libs/harness/gates/src/session-handoff.ts`):** Lifecycle hooks must cover all native edit tools and minimize per-turn cache and handoff overhead without relaxing lightweight import closures.

| ID      | Pattern          | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Effect Symbol         | Verification |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------ |
| REQ-2.1 | Optional feature | **Where** Antigravity `hooks.json` configures `PreToolUse`, `PostToolUse`, and `Stop` hooks and Claude Code `hooks.json` configures `Stop`, the hook matchers **shall** include `edit_file`, `write_file`, `replace_file_content`, `multi_replace_file_content`, and `write_to_file` and route `Stop` through `hook-entry.ts done` (handling `fullyIdle=false` via `runDoneFastPath` in `hook-fastpath-core.ts` under the `hook-entry-lightweight` closure). | SessionHandoff.decide | UnitTest     |
| REQ-2.2 | Event-driven     | **When** `computePreInvocationFingerprintLite` and `computePreInvocationFingerprint` digest workspace state, both helpers **shall** use a single `git status --porcelain=v1 -z --untracked-files=all --ignored=matching` pass with deterministic directory traversal for included ignored files and `mtimeMs` metadata digests for `graph-snapshot.json` and `plan-graph-snapshot.json` (omitting nonexistent `telemetry.jsonl`).                            | SessionHandoff.decide | UnitTest     |
| REQ-2.3 | State-driven     | **While** a `session` pre-invocation cache entry carries `degraded: true` (recorded when `snapshotOk` and `ollamaReady` are true and `reconcileError` is undefined), `tryReadPreInvocationCacheLite` and `tryReadPreInvocationSessionCache` **shall** enforce a `30_000ms` TTL on degraded entries.                                                                                                                                                          | SessionHandoff.decide | UnitTest     |
| REQ-2.4 | Event-driven     | **When** `SessionHandoff.decide` formats handoff text, `buildSessionHandoff` **shall** normalize friction summaries to single-line `<= 120`-character strings and cap rendered stub and missing-function lists at 8 entries.                                                                                                                                                                                                                                 | SessionHandoff.decide | UnitTest     |

### 3 · Guard `env -u` Ergonomics, Concurrent `HarnessMcp.gitDiff`, and Fail-Fast Package Baselines

**Source (`libs/harness/gates/src/policy-command-rules.ts`, `policy.ts`, `mutation-subprocess-helpers.ts`, `libs/harness/infra/src/node-host-io.ts`, `apps/harness-mcp/src/tools/git-diff.tools.ts`):** Safe commands must remain on the fast deterministic path while I/O-bound git inspections and failing mutation baselines avoid sequential stalls.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                   | Effect Symbol              | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ |
| REQ-3.1 | Event-driven       | **When** `stripSafeLeadingEnvVarsDetailed` encounters a leading `env` wrapper containing validated `-u <SAFE_VAR>`, `--unset=<SAFE_VAR>`, or `<SAFE_VAR>=<VALUE>` tokens from `SAFE_LEADING_ENV_VALIDATORS` without unallowlisted flags, `stripSafeLeadingEnvVarsDetailed` **shall** strip the safe wrapper while preserving monotonic `sawWorktreeId` state. | Harness.decideGuardCommand | UnitTest     |
| REQ-3.2 | Unwanted behaviour | **If** a leading `env` wrapper specifies any unvalidated variable name, unsupported flag, empty remainder, or missing `-u` operand, **then** `stripSafeLeadingEnvVarsDetailed` **shall** leave the `env` prefix intact so `classifyCommand` escalates or denies the command.                                                                                  | Harness.decideGuardCommand | UnitTest     |
| REQ-3.3 | Event-driven       | **When** `isCommandAllowed` evaluates `df` or `git worktree list` or `isAllowedFilter` inspects piped `wc` or `rg ...` filters free of deny, ask, or redirection rules, `classifyCommand` **shall** allow the command on the deterministic fast-path.                                                                                                         | Harness.decideGuardCommand | UnitTest     |
| REQ-3.4 | Event-driven       | **When** `runVitestPackageBaseline` executes whole-package Vitest baselines in `mutation-subprocess-helpers.ts`, `runVitestPackageBaseline` **shall** pass `--bail=1` while preserving non-bail per-file baselines in `runVitestTargetList`.                                                                                                                  | Harness.decideGuardCommand | UnitTest     |
| REQ-3.5 | Event-driven       | **When** `HarnessMcp.gitDiff` collects `--stat`, `--name-only`, `--others`, and optional full tracked patches, `executeGitDiffTool` **shall** invoke `execFileAsyncEffect` concurrently across independent `git` subcommands via `Effect.all(..., { concurrency: "unbounded" })`.                                                                             | HarnessMcp.gitDiff         | UnitTest     |

### 4 · Actionable Failure Telemetry Details and Extended Session Health Diagnostics

**Source (`libs/harness/gates/src/telemetry.ts`, `apps/harness-cli/src/commands/cli-runtime.ts`, `guard-and-route.command.ts`, `hook-fastpath-core.ts`, `apps/harness-mcp/src/tools/mcp-helpers.ts`):** Session health reports must detect operational failures beyond `verify` retries and explain why commands failed or timed out.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                      | Effect Symbol        | Verification |
| ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-4.1 | Event-driven | **When** `handleGuard`, `evaluateGuardPayload`, `runCliEffect` (`outcome === "fail"`), or `recordMcpToolTelemetry` (`harness_lsp_diagnostics` failure) records a telemetry event without an explicit detail override, the recorder **shall** attach a bounded single-line `detail` summarizing the verdict, timeout/rule reason, CLI error line, or diagnostic counts.                                                           | SessionReport.decide | UnitTest     |
| REQ-4.2 | Event-driven | **When** `SessionReport.decide` aggregates events containing non-verify gate failures, guard DecisionModel timeouts (`detail` containing `"timeout"` or `ask` with `durationMs >= 1450`), `hook:session` failures or `> 25%` cache misses (`>= 10` session calls), or `0` `hook:ingest` calls in a mutating hook session, `buildSessionReport` **shall** deduct bounded penalties and emit matching operational recommendations. | SessionReport.decide | UnitTest     |

## Assumptions

- **REQ-1.3:** Linked worktrees under `/.gemini/antigravity/worktrees/` represent primary coordinator workspaces unless explicitly flagged via `HARNESS_SUBAGENT=1`, `/subagent-`, or a subagent transcript.
- **REQ-3.4:** Whole-package `runVitestPackageBaseline` uses `--bail=1` to abort broken package baselines immediately, leaving `harness:SPEC-0019` (`REQ-1.1`) per-file `runVitestTargetList` behavior unchanged.

## Out of scope

- Removing historical legacy rows already written to local gitignored `.harness/telemetry-log.jsonl` files prior to this change.

## Known residual risks

- Degraded `session` cache entries expire after `30_000ms` automatically, so fixing an offline local dependency outside that window triggers a fresh probe at most once per 30 seconds.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`UnitTest`).
- `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, `pnpm harness mutate --strict`, `CI=true pnpm harness verify`, and `CI=true pnpm harness done` pass after `status: accepted`.
