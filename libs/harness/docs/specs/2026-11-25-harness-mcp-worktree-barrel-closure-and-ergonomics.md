---
id: harness:SPEC-0035
title: Multi-Worktree MCP Root Containment, Symbol-Aware Barrel Witness Closure, Guard Ergonomics, and Session/CLI Hardening
status: accepted
archetype: framework
date: 2026-11-25
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0001
  - harness:ADR-0003
  - harness:ADR-0004
  - harness:ADR-0011
  - harness:ADR-0012
  - harness:ADR-0020
  - harness:ADR-0023
  - harness:ADR-0027
  - harness:ADR-0028
enforced_by:
  - apps/harness-mcp/src/server.ts
  - apps/harness-mcp/src/tools/mcp-repo-root.ts
  - apps/harness-mcp/src/tools/lsp-and-telemetry.tools.ts
  - apps/harness-mcp/vitest.config.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/mutation/mutation-cache.ts
  - libs/harness/gates/src/mutation/mutation-closure.ts
  - libs/harness/gates/src/mutation/mutation-barrel-reachability.ts
  - libs/harness/gates/src/mutation/mutation-barrel-closure.ts
  - libs/harness/gates/src/mutation/mutation-batch-stream.ts
  - libs/harness/gates/src/mutation/mutation-package-batch.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/policy-command-lists.ts
  - libs/harness/gates/src/policy-command-rules.ts
  - libs/harness/gates/src/policy-harness-state.ts
  - libs/harness/gates/src/policy-heredoc.ts
  - libs/harness/gates/src/policy-worker-paths.ts
  - libs/harness/gates/src/plugins/ast-gate-law-helpers.ts
  - libs/harness/contract/src/workspace-and-process.ts
  - libs/harness/decision/src/review-router-decision.ts
  - libs/harness/infra/src/hook-io.ts
  - libs/harness/infra/vitest.config.ts
  - apps/harness-cli/vitest.config.ts
  - apps/harness-cli/src/commands/command-registry.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - apps/harness-cli/src/commands/declarative-cli-extra.ts
  - apps/harness-cli/src/commands/review-route.command.ts
  - apps/harness-cli/src/commands/guard-and-route.command.ts
  - apps/harness-cli/src/commands/cli-runtime.ts
  - apps/harness-cli/src/commands/plan-and-repair.command.ts
  - apps/harness-cli/src/commands/learn-and-report.command.ts
  - apps/harness-cli/src/commands/omnigraph-lint-gate.ts
  - apps/harness-cli/test/cli-learn-and-gc.test.ts
  - tools/oxlint/syntax-bans.js
  - AGENTS.md
  - adapters/antigravity/plugins/effect-harness/rules/AGENTS.md
  - adapters/claude-code/rules/AGENTS.md
  - adapters/antigravity/plugins/effect-harness/skills/effect-harness/SKILL.md
  - adapters/antigravity/plugins/effect-harness/skills/effect-lfg/SKILL.md
  - adapters/claude-code/skills/effect-harness/SKILL.md
  - adapters/claude-code/skills/effect-lfg/SKILL.md
spans:
  - HarnessMcp.resolveContainedRepoRoot
  - MutationCheck.decide
  - MutationCache.decide
  - Harness.routeReviewDiff
services: []
errors:
  - ProjectPathEscapeError
---

## Context

Multi-worktree swarm development and witness-scoped mutation runs (`harness:SPEC-0034`) surfaced six operational friction and soundness gaps across `harness-mcp`, the mutation closure calculator, the deterministic shell guard, Vitest test isolation, and `harness-cli`: (1) `apps/harness-mcp/src/server.ts` passes raw `process.cwd()` to `startHarnessDaemonServer`, which can create stray `.harness/` directories inside plugin subdirectories, while `pickAnchorRoot` in `apps/harness-mcp/src/tools/mcp-repo-root.ts` lacks a canonical git root fallback when `boundaryRoot` or `cwd` has no `.git`, and `harness_telemetry_report` / `harness_lsp_diagnostics` do not validate workspace root markers; (2) `computeFileMutationClosureDigest` in `libs/harness/gates/src/mutation/mutation-closure.ts` hashes full package barrel files (`src/index.ts`) and every sibling module re-exported by them even when a witness test only imports named runtime symbols, while `runPackageMutantBatchChecked` lacks throttled per-file progress lines on stderr for multi-file batches; (3) `policy.ts`, `policy-command-lists.ts`, `policy-command-rules.ts`, `policy-harness-state.ts`, and `policy-worker-paths.ts` reject benign `NX_TUI` env vars, `nx run-many`, safe `xargs` pipelines with `wc`/`oxfmt --check`/`oxlint`, data-only heredocs writing to safe temp/variable paths, and workspace test directory globs like `libs/harness/gates/test/*mutat*`, while matching `GUARD_SELF_INVOCATION_PATTERN` inside non-shell heredoc prose; (4) `effect-harness`, `effect-lfg`, and `AGENTS.md` lack a compact MCP Parameter Cheat-Sheet and Swarm Brief Header Standard; (5) `apps/harness-cli/vitest.config.ts` and `libs/harness/infra/vitest.config.ts` inherit `HARNESS_WORKTREE_ID` into temp-repo tests, and the workspace `gc` test in `apps/harness-cli/test/cli-learn-and-gc.test.ts` hits the default 10s timeout under `nx run-many` CPU contention; and (6) `harness review-route` is missing from `CanonicalCliCommandName`, `harness report` lacks `--json`, `plan-check` prints verbose Mermaid by default instead of a compact JSON summary, `omnigraph-lint-gate.ts` repeats `[state_lock_held]` info lines, `tools/oxlint/syntax-bans.js` lacks early `unisolated-dot-harness-test-write` parity, and `computePreInvocationFingerprintFromIo` hashes `plan-graph-snapshot.json` and `graph-snapshot.json` by volatile `mtimeMs` instead of existence.

- **Reused Contracts / Errors:** `CanonicalCliCommandName` (`@harness/contract`), `ProjectPathEscapeError` (`apps/harness-mcp/src/tools/mcp-repo-root.ts`)
- **Reused Services:** `SyncHostIo` (`@harness/service/host-io`), `nodeSyncHostIo` (`@harness/infra`), `HarnessCommandRegistry` (`apps/harness-cli`)
- **New Capabilities Needed:** Workspace-anchored daemon startup and `hasValidWorkspaceRootMarker` validation in `harness-mcp`, symbol-aware `resolveBarrelClosureStep` and `bindingDigest` hashing in `mutation-barrel-closure.ts` and `mutation-closure.ts`, throttled stderr batch progress in `mutation-batch-stream.ts` and `mutation-package-batch.ts`, `stripSafeDataHeredocBodies` and expanded read-only guard rules in `libs/harness/gates/src/policy*.ts`, MCP cheat-sheet and swarm brief standards in skills/`AGENTS.md`, `HARNESS_WORKTREE_ID: ""` Vitest config isolation, `review-route` (`review-route.command.ts`) / `report --json` / `plan-check --mermaid` CLI flags, deduplicated `state_lock_held` warnings, `syntax-bans.js` `unisolated-dot-harness-test-write` lint rule, and existence-based snapshot fingerprinting in `hook-io.ts`.

## Goal

Every `harness-mcp` server and tool invocation anchors safely on validated workspace roots across multi-worktree setups, witness-scoped mutation closures prune unrelated sibling barrel exports without sacrificing fail-closed soundness, the shell guard and `harness-cli` eliminate false-positive blocks and noisy/volatile defaults, Vitest suites stay isolated from inherited worker env vars, and `oxlint` catches unisolated `.harness/` test writes before `verify`.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Multi-Worktree harness-mcp Root & Daemon Containment

**Source (`apps/harness-mcp/src/server.ts`, `apps/harness-mcp/src/tools/mcp-repo-root.ts`, `apps/harness-mcp/src/tools/lsp-and-telemetry.tools.ts`):** Anchoring daemon startup and worktree containment on validated workspace roots prevents stray `.harness/` directory creation in plugin subdirectories and ensures accurate worktree resolution.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                | Effect Symbol                       | Verification |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------ |
| REQ-1.1 | Event-driven       | **When** `apps/harness-mcp/src/server.ts` starts the daemon via `startHarnessDaemonServer`, `apps/harness-mcp/src/server.ts` **shall** anchor on the resolved workspace root (`resolveDefaultRepoRoot` or `findRepoRoot(process.cwd())`) rather than raw `process.cwd()`.                                  | HarnessMcp.resolveContainedRepoRoot | UnitTest     |
| REQ-1.2 | Unwanted behaviour | **If** `boundaryRoot` or `cwd` lacks a `.git` entry when `pickAnchorRoot` evaluates worktree containment, **then** `HarnessMcp.resolveContainedRepoRoot` **shall** fall back to `SERVER_REPO_ROOT` or the canonical git root before checking worktree membership or failing with `ProjectPathEscapeError`. | ProjectPathEscapeError              | UnitTest     |
| REQ-1.3 | Unwanted behaviour | **If** a resolved `repoRoot` fails `hasValidWorkspaceRootMarker(root)`, **then** `harness_telemetry_report` and `harness_lsp_diagnostics` **shall** fail or warn clearly on the non-workspace root instead of silently reading or creating `.harness/` artifacts there.                                    | HarnessMcp.resolveContainedRepoRoot | UnitTest     |

### 2 · Symbol-Aware Barrel Witness Closure & Progress Streaming

**Source (`libs/harness/gates/src/mutation/mutation-closure.ts`, `libs/harness/gates/src/mutation/mutation-barrel-reachability.ts`, `libs/harness/gates/src/mutation/mutation-barrel-closure.ts`, `libs/harness/gates/src/mutation/mutation-batch-stream.ts`, `libs/harness/gates/src/mutation/mutation-package-batch.ts`):** Pruning unrelated sibling modules imported through `src/index.ts` prevents cross-module witness cache invalidation while live stderr progress keeps long batches observable.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                              | Effect Symbol        | Verification |
| ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-2.1 | Event-driven | **When** a witness test imports named runtime symbols from `src/index.ts`, `MutationCache.decide` (`resolveBarrelClosureStep` in `computeFileMutationClosureDigest`) **shall** prune unrelated sibling modules while failing closed to `FullBarrel` on namespace, default, side-effect, dynamic imports, unmapped symbols, or wildcard resolution needs. | MutationCache.decide | UnitTest     |
| REQ-2.2 | Event-driven | **When** `resolveBarrelClosureStep` hashes a package barrel along a witness closure, `MutationCache.decide` **shall** hash canonical `bindingDigest` for pure re-export barrels while hashing barrel file bytes as well for non-pure barrels.                                                                                                            | MutationCache.decide | UnitTest     |
| REQ-2.3 | Event-driven | **When** `runPackageMutantBatchChecked` executes a multi-file package batch, `MutationCheck.decide` **shall** emit throttled per-file progress lines on stderr.                                                                                                                                                                                          | MutationCheck.decide | UnitTest     |

### 3 · Guard Policy Ergonomics & Heredoc-Aware Inspection

**Source (`libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/policy-command-lists.ts`, `libs/harness/gates/src/policy-command-rules.ts`, `libs/harness/gates/src/policy-harness-state.ts`, `libs/harness/gates/src/policy-heredoc.ts`, `libs/harness/gates/src/policy-worker-paths.ts`):** Safe allowlist expansions and heredoc-aware inspection eliminate false-positive blocks on read-only checks, data heredocs, and workspace test directory globs.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                      | Effect Symbol | Verification |
| ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ |
| REQ-3.1 | Event-driven | **When** `classifyCommand` evaluates read-only workspace commands, `isCommandAllowed` **shall** allow `NX_TUI` in `SAFE_LEADING_ENV_VALUES`, `"nx run-many"` in `SAFE_PNPM_EXEC_PREFIXES`, and safe `xargs` flags combined with safe check prefixes (`wc`, `oxfmt --check`, `oxlint`).                                                                                           | —             | UnitTest     |
| REQ-3.2 | Event-driven | **When** inspecting shell commands containing non-executing data-only heredocs writing to safe temp or variable paths, `stripSafeDataHeredocBodies` **shall** strip those heredoc bodies before secret-file and harness-state checks execute.                                                                                                                                    | —             | UnitTest     |
| REQ-3.3 | Event-driven | **When** evaluating guard self-invocation and secret-file glob rules, `GUARD_SELF_INVOCATION_PATTERN` **shall** evaluate parsed shell command segments and executed shell snippets rather than non-shell heredoc prose, while `matchesSecretFileGlob` permits workspace test directory globs such as `libs/harness/gates/test/*mutat*` alongside blocking secrets and HMAC keys. | —             | UnitTest     |

### 4 · MCP Usability & Swarm Brief Standards

**Source (`adapters/antigravity/plugins/effect-harness/skills/effect-harness/SKILL.md`, `adapters/antigravity/plugins/effect-harness/skills/effect-lfg/SKILL.md`, `adapters/claude-code/skills/effect-harness/SKILL.md`, `adapters/claude-code/skills/effect-lfg/SKILL.md`, `adapters/antigravity/plugins/effect-harness/rules/AGENTS.md`, `adapters/claude-code/rules/AGENTS.md`, `AGENTS.md`):** Standardizing MCP parameter names and swarm worker brief headers eliminates repeated schema mismatches and relative-path errors across parallel workers.

| ID      | Pattern    | Requirement                                                                                                                                                                                                                                                                              | Effect Symbol | Verification |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ |
| REQ-4.1 | Ubiquitous | `adapters/antigravity/plugins/effect-harness/skills/effect-harness/SKILL.md`, `adapters/antigravity/plugins/effect-harness/skills/effect-lfg/SKILL.md`, and `AGENTS.md` **shall** document a compact MCP Parameter Cheat-Sheet across `harness-mcp` tools.                               | —             | Inspection   |
| REQ-4.2 | Ubiquitous | `adapters/antigravity/plugins/effect-harness/skills/effect-harness/SKILL.md`, `adapters/antigravity/plugins/effect-harness/skills/effect-lfg/SKILL.md`, and `AGENTS.md` **shall** mandate the Swarm Brief Header Standard (`REPO_ROOT`, absolute file paths, and MCP-first diagnostics). | —             | Inspection   |

### 5 · Test Isolation & Timeout Resilience

**Source (`apps/harness-cli/vitest.config.ts`, `apps/harness-mcp/vitest.config.ts`, `libs/harness/infra/vitest.config.ts`, `apps/harness-cli/test/cli-learn-and-gc.test.ts`):** Explicit Vitest env isolation and generous timeouts prevent inherited worker env vars and CPU contention from breaking temp-repo tests.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                   | Effect Symbol | Verification |
| ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ |
| REQ-5.1 | Ubiquitous   | `apps/harness-cli/vitest.config.ts` and `libs/harness/infra/vitest.config.ts` **shall** set `HARNESS_WORKTREE_ID: ""` in `test.env` so inherited worker isolation variables do not redirect temp-repo test state directories. | —             | UnitTest     |
| REQ-5.2 | Event-driven | **When** executing the workspace `gc` test in `apps/harness-cli/test/cli-learn-and-gc.test.ts` under `nx run-many` CPU contention, the test **shall** enforce an explicit `30_000` ms timeout.                                | —             | UnitTest     |

### 6 · CLI Ergonomics, Early oxlint Parity & Session Cache Stability

**Source (`libs/harness/contract/src/workspace-and-process.ts`, `apps/harness-cli/src/commands/command-registry.ts`, `apps/harness-cli/src/commands/declarative-cli.ts`, `apps/harness-cli/src/commands/declarative-cli-extra.ts`, `apps/harness-cli/src/commands/review-route.command.ts`, `apps/harness-cli/src/commands/guard-and-route.command.ts`, `apps/harness-cli/src/commands/cli-runtime.ts`, `apps/harness-cli/src/commands/plan-and-repair.command.ts`, `apps/harness-cli/src/commands/learn-and-report.command.ts`, `apps/harness-cli/src/commands/omnigraph-lint-gate.ts`, `libs/harness/gates/src/plugins/ast-gate-law-helpers.ts`, `tools/oxlint/syntax-bans.js`, `libs/harness/infra/src/hook-io.ts`):** First-class CLI parity, concise default output, deduplicated lock notices, early lint parity, and stable session cache keys streamline inner-loop execution.

| ID      | Pattern          | Requirement                                                                                                                                                                                                                                                                                           | Effect Symbol           | Verification |
| ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------ |
| REQ-6.1 | Event-driven     | **When** `harness review-route` or `harness report --json` is invoked, `CanonicalCliCommandName` and `apps/harness-cli/src/commands/command-registry.ts` **shall** dispatch `review-route` via `Harness.routeReviewDiff` and emit JSON output for `report --json`.                                    | Harness.routeReviewDiff | UnitTest     |
| REQ-6.2 | Optional feature | **Where** `--mermaid` is omitted on `harness plan-check`, `handlePlanCheck` **shall** emit a compact JSON summary by default while preserving full Mermaid flowchart output when `--mermaid` is supplied.                                                                                             | —                       | UnitTest     |
| REQ-6.3 | Event-driven     | **When** `omnigraph-lint-gate.ts` encounters `[state_lock_held]` across consecutive maintenance subcommands, `runOmnigraphMaintenance` **shall** deduplicate repeated `state_lock_held` skip info lines on stderr.                                                                                    | —                       | UnitTest     |
| REQ-6.4 | Event-driven     | **When** `oxlint` inspects test files via `tools/oxlint/syntax-bans.js`, `tools/oxlint/syntax-bans.js` **shall** report `unisolated-dot-harness-test-write` at lint time with parity to `AstGateCache.decide`.                                                                                        | —                       | AstGate      |
| REQ-6.5 | Event-driven     | **When** `computePreInvocationFingerprintFromIo` in `libs/harness/infra/src/hook-io.ts` fingerprints `plan-graph-snapshot.json` and `graph-snapshot.json`, `computePreInvocationFingerprintFromIo` **shall** hash symlink-safe existence (`"missing"` or `"present"`) rather than volatile `mtimeMs`. | —                       | UnitTest     |

## Assumptions

- **REQ-1.3:** `hasValidWorkspaceRootMarker(root)` checks for a valid repository workspace marker (`pnpm-workspace.yaml` or `.git`) before allowing `.harness/` reads or diagnostics.
- **REQ-2.1:** Pure re-export barrels contain only static `export { ... } from "..."` / `export type ...` declarations without top-level executable statements or local state mutations.
- **REQ-2.3:** Throttled stderr progress lines in `runPackageMutantBatchChecked` emit at bounded intervals during multi-file batches (`files.length >= 2`) so logs remain readable without spamming short single-file runs.
- **REQ-6.2:** `handlePlanCheck` callers that consume the full Mermaid topology graph pass `--mermaid` explicitly; default callers receive a compact JSON summary containing graph node/edge counts and validation status.

## Out of scope

- **Replacing `effect-tsgo` or `oxlint` with a persistent LSP daemon protocol:** Covered separately from multi-worktree root containment. Decides: `@harness/architecture`.
- **Cross-repository shared mutation caches outside a common `.git` worktree cluster:** Cache sharing remains scoped to linked worktrees sharing a canonical common repository root per `harness:SPEC-0034`. Decides: `@harness/architecture`.

## Known residual risks

- Stripping non-executing data-only heredocs in `stripSafeDataHeredocBodies` must remain strictly scoped to non-executing file writes targeting safe temp or variable paths so executable `sh`/`bash`/`node`/`python` heredocs continue receiving full guard inspection.
- Existence-only fingerprinting (`"missing"` / `"present"`) on `plan-graph-snapshot.json` and `graph-snapshot.json` relies on `graph-head.json` and `verify-stamp.json` content hashes to invalidate session pre-invocation caches when branch or verification state changes.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`UnitTest`, `AstGate`, `Inspection`) across `apps/harness-mcp`, `libs/harness/gates`, `libs/harness/contract`, `libs/harness/infra`, and `apps/harness-cli`.
- `EarsSpecLint.decide`, `AdrDocLint.decide`, `pnpm harness gc --strict`, and `pnpm harness ontology check --strict` pass with zero findings.
- `pnpm oxfmt --check` passes across all modified governance docs and source files.
