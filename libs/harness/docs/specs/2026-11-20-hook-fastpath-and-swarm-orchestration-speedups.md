---
id: harness:SPEC-0022
title: Zero-Heavy-Barrel Hook Fast-Path, Lazy Model Loading, Safe Runtime Env Guard, and Swarm Orchestration Speedups
status: accepted
archetype: framework
date: 2026-11-20
owners:
  - "@harness/architecture"
scope: harness
enforced_by:
  - tools/node-ts-resolver.mjs
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/plugins/gc/gc-hook-fastpath.ts
  - libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts
  - libs/harness/gates/test/policy.test.ts
  - libs/harness/gates/test/gc-doc-truth.test.ts
  - libs/harness/gates/test/gc-ontology-invariants.test.ts
  - libs/harness/gates/test/tools-lint-resolver.test.ts
  - libs/harness/ingest/src/fn-index.ts
  - libs/harness/ingest/test/fn-index.test.ts
  - libs/harness/infra/src/hook-io.ts
  - libs/harness/infra/src/local-decision-model-live.ts
  - libs/harness/infra/test/hook-io-and-lazy-model.test.ts
  - apps/harness-cli/src/hook-entry.ts
  - apps/harness-cli/src/commands/hook-fastpath-core.ts
  - apps/harness-cli/src/commands/hook-fallback.ts
  - apps/harness-cli/src/commands/hook-guard-payload.ts
  - apps/harness-cli/src/commands/cli-runtime.ts
  - apps/harness-cli/src/commands/guard-and-route.command.ts
  - apps/harness-cli/src/commands/ingest-fastpath.ts
  - apps/harness-cli/src/commands/repo-path.ts
  - apps/harness-cli/src/commands/session-fastpath.ts
  - apps/harness-cli/src/commands/session-learn-report.command.ts
  - apps/harness-cli/src/commands/command-registry.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - apps/harness-cli/test/hook-entry-fastpath.test.ts
  - apps/harness-cli/test/adapter-config.test.ts
  - apps/harness-cli/test/hooks-and-cli.test.ts
spans:
  - Harness.decideGuardCommand
  - SessionHandoff.decide
  - Harness.ingestWorkspace
  - GraphGc.decide
services: []
errors: []
---

## Context

Telemetry audits of Antigravity hook invocations and multi-worker swarm runs identified four compounding latency and orchestration bottlenecks: per-turn hook invocations (`guard`, `ingest`, `session`) entered through `apps/harness-cli/src/index.ts` and eagerly loaded heavy `@harness/infra`, `@harness/graph`, `@effect/ai-typesafe`, and `typescript` barrels even on fast-path hits; `findActiveWorkspaceStubs` parsed every workspace TypeScript file with `@ast-grep/napi` (`Lang.TypeScript`) instead of prefiltering for `"Effect.fn"` and `"stub"`; `isCommandAllowed` rejected safe runtime environment prefixes (`TMPDIR`, `NX_SOCKET_DIR`, `NODE_COMPILE_CACHE`, `NX_DAEMON`, `FORCE_COLOR`, `NO_COLOR`, strict `CI`/`NX_INTERACTIVE`, and `SAFE_LEADING_ENV_VALIDATORS` for `HARNESS_PLAN_CHECK`, `HARNESS_REQUIRE_OLLAMA`, `HARNESS_LOG_LEVEL`, plus non-`harness` `HARNESS_WORKTREE_ID`) and read-only `git ls-files` commands; and review/swarm skills lacked explicit rules for parallel post-fix remediation, `> 15` finding package sharding, single terminal `harness mutate`, `harness_git_diff`-first domain-scoped reviewer prompts, early monitor teardown, and `/tmp` inode readiness checks.

- **Reused Contracts / Errors:** `AstSourceFilePath`, `WorkspaceFilePath`, `ContentSha256` from `@harness/contract`
- **Reused Services:** `SyncHostIo` from `@harness/service/host-io`
- **New Capabilities Needed:** Lightweight `apps/harness-cli/src/hook-entry.ts` entrypoint with `@harness/infra/hook-io` and `@harness/gates/policy` fast-paths (`hook-fastpath-core.ts`, `hook-fallback.ts`, `ingest-fastpath.ts`, `session-fastpath.ts`) governed by the 3-profile closure rules in `gc-hook-fastpath.ts` (`standard`, `policy-zero-dep`, `hook-entry-lightweight` — permitting `effect/Option`, `effect/Result`, `effect/Schema`, and `ts-pattern` in lightweight hook fast-paths while forbidding `@effect/ai-typesafe`, `typescript`, `ts-morph`, `@harness/graph`, and `@harness/infra` index barrels, with `hook-fallback.ts` outside the lightweight closure), direct runtime/fallback fail-closed handling in `hook-entry.ts`/`hook-fastpath-core.ts` paired with `hooks.json` shell bootstrap wrappers (`|| ... exit 2`) for `guard`/`done`, GC enforcement via `evaluateHookFastpathImportClosure` (`hook-fastpath-forbidden-import`) and `checkHookTimeouts` (`hook-bootstrap-fail-closed`), call-time lazy `@effect/ai-typesafe` loading in `LocalDecisionModel`, `"Effect.fn"`/`"stub"` prefiltering before `@ast-grep/napi` (`Lang.TypeScript`) parsing in `findActiveWorkspaceStubs`, bounded linear-time safe runtime env stripping, read-only `git ls-files` allowlisting, and `"git-pack-exec-override"` hard-denies in `isCommandAllowed`, and cross-adapter skill optimizations.

## Goal

Every `guard`, `ingest`, and `session` hook executes through the `hook-entry.ts` fast-path under `gc-hook-fastpath.ts` 3-profile import-closure verification (`standard`, `policy-zero-dep`, `hook-entry-lightweight`), with `hook-entry.ts`/`hook-fastpath-core.ts` handling runtime/fallback failures directly (exiting `2` + deny/block JSON for `guard`/`done`, `1` for `ingest`/`session`) and `hooks.json` shell wrappers (`|| ... exit 2`) enforcing fail-closed bootstrap protection for `guard`/`done`; `LocalDecisionModel` and `findActiveWorkspaceStubs` avoid eager `@effect/ai-typesafe` and full-workspace `@ast-grep/napi` (`Lang.TypeScript`) AST overhead; `isCommandAllowed` safely strips bounded runtime env prefixes (`"ask"` past length/count caps), permits read-only `git ls-files` (while hard-denying git `--upload-pack`/`--receive-pack`/`--exec`/prefixes/`-u`/`ext::` as `"git-pack-exec-override"`), and protects `graph-snapshot.json`/`graph-head.json` in `classifyFileWrite`; and both adapter skill suites enforce parallel post-fix remediation, `> 15` finding sharding, single terminal mutation runs, `harness_git_diff`-first domain-scoped reviews, early monitor teardown, and `/tmp` inode checks.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Zero-Heavy-Barrel Hook Fast-Path & Fail-Closed GC Enforcement

**Source (`apps/harness-cli/src/hook-entry.ts`, `apps/harness-cli/src/commands/hook-fastpath-core.ts`, `hook-fallback.ts`, `ingest-fastpath.ts`, `session-fastpath.ts`, `libs/harness/infra/src/hook-io.ts`, `libs/harness/gates/src/plugins/gc/gc-hook-fastpath.ts`, `gc-doc-truth.plugin.ts`):** Per-turn hooks must avoid loading full CLI, `typescript`, `@harness/graph`, and `@effect/ai-typesafe` barrels on the fast path while failing closed on bootstrap or decision errors.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Effect Symbol              | Verification |
| ------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ |
| REQ-1.1 | Event-driven | **When** `hook-entry.ts` handles `guard`, Antigravity `ingest` (verifying `GraphSnapshotLiteSchema` via `isIngestSnapshotUpToDateLite` and protecting `graph-snapshot.json`/`graph-head.json` via `classifyFileWrite`), or `session` (routing non-Antigravity `ingest` to incremental extraction so uncommitted edits are never dropped, and routing `session` cache misses via `hook-fallback.ts` with `skipInitialSessionCacheRead` skipping duplicate initial cache reads), `hook-entry.ts` / `hook-fastpath-core.ts` **shall** execute `@harness/infra/hook-io` and `@harness/gates/policy` lightweight fast-paths (`hook-fastpath-core.ts`, `ingest-fastpath.ts`, `session-fastpath.ts`) and handle runtime or `hook-fallback.ts` load failures directly (exiting `2` + deny/block JSON for `guard`/`done`, `1` for `ingest`/`session`) while `hooks.json` fail-closed shell wrappers (`exit 2` fallback) enforce bootstrap protection for `guard`/`done`. | Harness.decideGuardCommand | UnitTest     |
| REQ-1.2 | State-driven | **While** `GraphGc.decide` audits hook fast-path modules and adapter `hooks.json` manifests, `evaluateHookFastpathImportClosure` **shall** enforce the 3-profile closure rules in `gc-hook-fastpath.ts` (`standard`, `policy-zero-dep`, `hook-entry-lightweight`)—permitting `effect/Option`, `effect/Result`, `effect/Schema`, and `ts-pattern` in lightweight hook fast-paths while emitting `hook-fastpath-forbidden-import` for any transitive import of `@effect/ai-typesafe`, `typescript`, `ts-morph`, `@harness/graph`, or `@harness/infra` index barrels (with `hook-fallback.ts` outside the lightweight closure)—and `checkHookTimeouts` **shall** emit `hook-bootstrap-fail-closed` when `guard` or `done` hooks lack fail-closed `hooks.json` shell wrappers (`exit 2` fallback) or when `classifyFileWrite` / `isIngestSnapshotUpToDateLite` omit `graph-snapshot.json`/`graph-head.json` (`GraphSnapshotLiteSchema`) protection.                 | GraphGc.decide             | UnitTest     |

### 2 · Lazy Decision Model Loading & Stub Scan Prefilter

**Source (`libs/harness/infra/src/local-decision-model-live.ts`, `libs/harness/ingest/src/fn-index.ts`):** Cold hook misses must defer `@effect/ai-typesafe` module loading until an advisory decision is actually invoked and skip `@ast-grep/napi` (`Lang.TypeScript`) parsing for files that cannot contain active stubs.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Effect Symbol              | Verification |
| ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ |
| REQ-2.1 | Event-driven | **When** `LocalDecisionModel` constructs its live `Layer.effect(DecisionModel.DecisionModel, ...)` in `libs/harness/infra/src/local-decision-model-live.ts`, `LocalDecisionModel` **shall** defer importing `@effect/ai-typesafe` until the first `decide` execution using single-flight `Semaphore` + `Ref` retry semantics (returning a typed `AiError` on failure and never caching failures across calls, while `guard-decision.ts` surfaces a sanitized failure summary) so clean `session` invocations incur zero `@effect/ai-typesafe` load cost. | Harness.decideGuardCommand | UnitTest     |
| REQ-2.2 | Event-driven | **When** `findActiveWorkspaceStubs` scans workspace TypeScript files on a `session` cache miss, `findActiveWorkspaceStubs` **shall** prefilter source text for both `"Effect.fn"` and `"stub"` before invoking `@ast-grep/napi` (`Lang.TypeScript`) so files without candidate stubs are skipped without AST parsing.                                                                                                                                                                                                                                    | Harness.ingestWorkspace    | UnitTest     |

### 3 · Safe Runtime Env Guard Stripping & Read-Only Git Allowlisting

**Source (`libs/harness/gates/src/policy.ts`, `libs/harness/gates/test/policy.test.ts`):** Safe temporary/runtime environment prefixes on allowlisted commands must not trigger `clef-flash` escalations, while unsafe env vars, traversal, or shell metacharacters remain strictly blocked.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Effect Symbol              | Verification |
| ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ |
| REQ-3.1 | Event-driven | **When** `isCommandAllowed` evaluates a shell command prefixed with `TMPDIR`, `NX_SOCKET_DIR`, `NODE_COMPILE_CACHE`, `NX_DAEMON`, `FORCE_COLOR`, `NO_COLOR`, strict `CI`/`NX_INTERACTIVE`, or `SAFE_LEADING_ENV_VALIDATORS` (`HARNESS_PLAN_CHECK`, `HARNESS_REQUIRE_OLLAMA`, `HARNESS_LOG_LEVEL`, plus non-`harness` `HARNESS_WORKTREE_ID`), `isCommandAllowed` **shall** strip validated safe values in bounded linear time (failing `"ask"` past length/count caps) and evaluate the underlying command, while strictly rejecting path traversal (`..`), shell metacharacters, or unallowlisted environment variable assignments. | Harness.decideGuardCommand | UnitTest     |
| REQ-3.2 | Event-driven | **When** `isCommandAllowed` evaluates read-only repository inspection commands invoking `git ls-files`, `isCommandAllowed` **shall** allowlist `git ls-files` when free of mutating flags or unsafe shell operators (leaving `git ls-remote` unallowlisted and hard-denying git `--upload-pack`/`--receive-pack`/`--exec`/prefixes/`-u`/`ext::` as `"git-pack-exec-override"`).                                                                                                                                                                                                                                                     | Harness.decideGuardCommand | UnitTest     |

### 4 · Cross-Adapter Swarm & Review Orchestration Speedups

**Source (`adapters/antigravity/plugins/effect-harness/skills/**`, `adapters/claude-code/skills/**`, `apps/harness-cli/test/adapter-config.test.ts`):** Both adapter skill suites must encode telemetry-backed swarm and review optimizations to eliminate sequential bottlenecks, redundant file reads, premature mutation runs, and `/tmp` exhaustion.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Effect Symbol  | Verification |
| ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------ |
| REQ-4.1 | Event-driven | **When** an orchestrator dispatches specialist reviews or post-fix remediation across `>= 2` packages (or a single package with `> 15` adjudicated findings), the review and fixer skills **shall** mandate `harness_git_diff`-first (`statOnly: true`, then targeted `paths`) domain-scoped reviewer prompts, parallel post-fix remediation on warm workers or subagents, `2+` disjoint sub-unit sharding for `> 15` findings, and a single terminal `harness mutate` run only after all review/post-fix edits land.                                                  | GraphGc.decide | UnitTest     |
| REQ-4.2 | State-driven | **While** executing multi-worker swarms or parallel subagent waves, `executing-effect-stubs` and `effect-lfg` **shall** mandate immediate monitor teardown (`swarm-monitor` in Antigravity, `monitoring workers` in Claude Code) once active implementation/remediation waves settle (omitting monitors for focused single-wave runs) and pre-flight `/tmp` inode checks (`df -ih /tmp`) with explicit `TMPDIR`/`NX_SOCKET_DIR` and package-scoped `pnpm --filter <pkg> run typecheck && pnpm --filter <pkg> run lint && pnpm --filter <pkg> run test` inside workers. | GraphGc.decide | UnitTest     |

## Assumptions

- **REQ-1.1:** `hook-entry.ts` / `hook-fastpath-core.ts` handles runtime and `hook-fallback.ts` load failures directly (exiting `2` + deny/block JSON for `guard`/`done`, `1` for `ingest`/`session`) and delegates non-fast-path or degraded invocations to `hook-fallback.ts` so behavioral parity with `apps/harness-cli/src/index.ts` is preserved, while `hooks.json` shell wrappers (`|| ... exit 2`) enforce fail-closed bootstrap protection for `guard`/`done`.
- **REQ-3.1:** Only explicitly allowlisted safe runtime environment variables with validated non-metacharacter, non-traversal values are stripped before command classification.

## Out of scope

- Replacing Node.js hook processes with a long-lived background socket daemon.

## Known residual risks

- Unrecognized environment variable prefixes or novel `git` subcommands continue to escalate to `ask` / `LocalDecisionModel` rather than failing open.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`UnitTest`).
- `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, `pnpm harness mutate --strict`, `CI=true pnpm harness verify`, and `CI=true pnpm harness done` pass after `status: accepted`.
