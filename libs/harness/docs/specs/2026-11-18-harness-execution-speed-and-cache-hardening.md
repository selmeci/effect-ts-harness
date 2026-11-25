---
id: harness:SPEC-0019
title: Harness Execution Speed, Incremental Mutant Caching, and Hook Fast-Path
status: accepted
archetype: framework
date: 2026-11-18
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0026
enforced_by:
  - tools/mutant-coverage-setup.mjs
  - tools/package-vitest-batch.mjs
  - tools/parallel-vitest-batch.mjs
  - tools/vitest-pool-helpers.mjs
  - tools/warm-vitest-worker.mjs
  - libs/harness/contract/src/mutation-cache.ts
  - libs/harness/contract/src/index.ts
  - libs/harness/decision/src/guard-decision.ts
  - libs/harness/decision/src/hook-fastpath.ts
  - libs/harness/decision/src/triage-decision.ts
  - libs/harness/gates/src/workspace-ts-scan.ts
  - libs/harness/gates/src/hook-fastpath.ts
  - libs/harness/gates/src/mutation/mutant-ast-generator.ts
  - libs/harness/gates/src/mutation/mutation-backup.ts
  - libs/harness/gates/src/mutation/mutation-cache.ts
  - libs/harness/gates/src/mutation/mutation-context-digest.ts
  - libs/harness/gates/src/mutation/mutation-outcomes.ts
  - libs/harness/gates/src/mutation/mutation-package-batch.ts
  - libs/harness/gates/src/mutation/mutation-suite-helpers.ts
  - libs/harness/gates/src/mutation/mutation-target-discovery.ts
  - libs/harness/gates/src/mutation/mutation-test-reachability.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/mutation-subprocess-helpers.ts
  - libs/harness/gates/src/policy-shell-parser.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/plugins/ast-effect-promise-law.ts
  - libs/harness/gates/src/plugins/gc/gc-hook-fastpath.ts
  - libs/harness/gates/src/plugins/gc/gc-infra-sql-hygiene.ts
  - libs/harness/gates/src/index.ts
  - libs/harness/gates/test/mutate-saturation-and-recovery.test.ts
  - libs/harness/gates/test/mutate-stamp-and-subprocess.test.ts
  - libs/harness/gates/test/mutation-cache-hardening.test.ts
  - libs/harness/gates/test/mutation-speedup.test.ts
  - libs/harness/infra/src/mutation-hmac-secret.ts
  - libs/harness/infra/src/hook-fastpath.ts
  - libs/harness/infra/src/index.ts
  - libs/harness/infra/test/mutation-hmac-secret.test.ts
  - apps/harness-cli/src/index.ts
  - apps/harness-cli/src/commands/command-registry.ts
  - apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - apps/harness-cli/src/commands/guard-and-route.command.ts
  - apps/harness-cli/src/commands/learn-and-report.command.ts
  - apps/harness-cli/src/commands/mutate-and-bench.command.ts
  - apps/harness-cli/src/commands/ollama-readiness.ts
  - apps/harness-cli/src/commands/repo-path.ts
  - apps/harness-cli/src/commands/session-fastpath.ts
  - apps/harness-cli/src/commands/session-learn-report.command.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
spans:
  - MutationCache.decide
  - MutationCheck.decide
  - Harness.decideGuardCommand
  - Harness.triageFailure
  - SessionHandoff.decide
  - SessionReport.decide
services: []
errors: []
---

## Context

Telemetry analysis of multi-hour review and verification runs revealed four compounding execution bottlenecks in the Effect-TS Engineering Harness: repeated `harness mutate --strict` invocations re-ran every Vitest test across every killed mutant without `--bail=1` or cross-run caching, large monolithic gate test suites (`2,600` to `4,059` lines) unnecessarily widened mutation reaching sets, every Antigravity hook spawned Node with cold TypeScript loader resolution that eagerly loaded `@harness/graph` and `typescript` alongside redundant `buildSessionReport` computation on `PreInvocation`, and workers bypassed Nx caching (`--skip-nx-cache`) while unisolated Vitest subprocess tests polluted `.harness/telemetry-log.jsonl`.

- **Reused Contracts / Errors:** `AstSourceFilePath`, `ContentSha256`, `NonNegativeCount`, `compareCodeUnits`, `computeContentSha256` from `@harness/contract`
- **Reused Services:** `SyncHostIo` (`ExtendedHostIo`) from `@harness/service/host-io`
- **New Capabilities Needed:** `MUTATION_CACHE_FILENAME`, `MutationCacheEntry`, `MutationCacheStore`, `MutationCacheLookupInput`, `MutationCacheLookupDecision`, `MutationCacheMac`, `MutationCacheHmacSecret`, `RedactedMutationCacheHmacSecret`, `MutationCacheHmacSecretResult`, `MutationCacheAuth`, `BatchMutantResultsSchema`, `MutationEpochMillis`, `MutationMaxAgeMillis`, `PackageRelKey`, `RuntimeVersionTag`, `MutationCache.decide`, `computeMutantCacheKey`, `computeMutationContextDigestsChecked`, `loadMutationCacheWithStatus`, `saveMutationCacheAtomic`, `resolveOrCreateMutationCacheHmacSecret`, `@harness/gates/hook-fastpath`, `@harness/decision/hook-fastpath`, `@harness/infra/hook-fastpath`, `@harness/graph/cluster-resolver`, `SKIP_NX_CACHE_BANNED_REASON`, `explainCommandDenyReason`, `isSkipNxCacheCommand`, `isSkipNxCacheOverrideCommand`, `shouldSuppressLiveRepoTestSideEffects`, `shouldRequireLiveOllama`, `isWorkspaceTsSourceFileName`, and `tryReadPreInvocationSessionCache`.

## Goal

Every hook invocation avoids eager `typescript` and `@harness/graph` barrel loads with a warm in-process handler fast-path (`< 50ms`) while serving clean `PreInvocation` state from a fingerprint-validated fast-path cache, `harness mutate --strict` executes reaching tests fail-fast (`--bail=1`) backed by warm package Vitest worker pools, coverage-guided per-test targeting, reverse-import partitioning (`harness:ADR-0026`), an HMAC-authenticated `.harness/cache/mutation-cache-v2.json` cache, and modular `<= 1,500`-line, `<= 30`-test, domain-focused test files (`harness:SPEC-0028`), `classifyCommand` blocks unapproved Nx cache bypasses, and Vitest test suites leave live `.harness/telemetry-log.jsonl` and `.harness/friction-log.jsonl` untouched.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Fail-Fast Mutant Execution & Content-Addressable Mutant Cache

**Source (`libs/harness/contract/src/mutation-cache.ts`, `libs/harness/gates/src/mutation/mutation-cache.ts`, `mutation-context-digest.ts`, `mutation-check.ts`, `mutation-subprocess-helpers.ts`, `libs/harness/infra/src/mutation-hmac-secret.ts`, `tools/parallel-vitest-batch.mjs`):** Repeated strict mutation runs must terminate each mutant on the first failing test and skip re-executing previously killed mutants whose source, mutant schema, reaching tests, runtime/tool versions, and workspace dependencies have not changed.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Effect Symbol        | Verification |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-1.1 | Event-driven       | **When** `runVitestTargetList` or `parallel-vitest-batch.mjs` executes Vitest for an active mutant (`HARNESS_ACTIVE_MUTANT_ID`), the runner **shall** pass `--bail=1` while running the unmutated baseline without `--bail=1` once per target file even when every mutant hits cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | MutationCache.decide | UnitTest     |
| REQ-1.2 | Event-driven       | **When** `computeMutationContextDigestsChecked`, `computeMutantCacheKey`, and `MutationCache.decide` evaluate candidate mutant keys against `MutationCacheStore`, `MutationCache.decide` **shall** partition candidates into `hitKeys` and `missKeys` only for HMAC-SHA256-verified entries within the 12-hour immutable `recordedAt` TTL bound to `"mutation-cache-v2"`, target source, mutant schema/descriptor, transitive workspace source closure plus conditional docs/scenarios/agent-patterns/adapters/tools buckets, root/package configs, tool runners, `process.version`/Vitest version, touched-package test helpers, and reaching tests, failing closed (`abort`) on `Signaled` or solo `TimedOut` runs instead of minting kills.                                                                                                                                                                                                              | MutationCache.decide | PropertyTest |
| REQ-1.3 | Unwanted behaviour | **If** `.harness/cache/mutation-cache-v2.json` is missing, unreadable, symlinked, or fails `MutationCacheStore` schema/HMAC verification or the out-of-workspace secret is unavailable, **then** `loadMutationCacheWithStatus` and `MutationCache.decide` **shall** degrade closed to empty/misses (quarantining corrupt cache files) without minting unverified kills, and `--no-cache` (`disableMutantCache: true`) **shall** bypass both cache reads and cache writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | MutationCache.decide | UnitTest     |
| REQ-1.4 | Event-driven       | **When** `package-vitest-batch.mjs` or `parallel-vitest-batch.mjs` executes Vitest for mutants, the runner **shall** keep warm persistent Vitest workers (`tools/warm-vitest-worker.mjs`) alive across all files in a package (defaulting to `isolate: true` with `fsModuleCache: true`, RSS-threshold worker recycling, per-run `vitest.state` reset, `vitest.invalidateFile` across files, and opt-in `HARNESS_MUTATE_WARM_ISOLATE=0` per-mutant invalidation), pass `--root` + `--config` on direct Vitest CLI baselines, sort covering tests by real measured probe duration, execute Stage 0 per-`it(...)` `testNamePattern` targeting via `tools/mutant-coverage-setup.mjs` on slow/heavy suites with full-file fallback for survivors, split both primary and fallback executions into fast-before-heavy stages with lazy fail-closed fallback baselines on survivors, and preserve `--no-cache` / `HARNESS_MUTATE_USE_WARM_VITEST=0` cold fallback. | MutationCheck.decide | UnitTest     |
| REQ-1.5 | Event-driven       | **When** `partitionReachingTestFilesChecked` partitions packages with more than two test files, `partitionEligibleTestsChecked` and `queryReverseImportReachability` **shall** traverse intra-package static reverse imports excluding the package barrel first to isolate direct reaching tests in `primaryTests` while prioritizing barrel importers and faster unit tests ahead of heavy meta-tests in `fallbackTests`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | MutationCheck.decide | UnitTest     |
| REQ-1.6 | Event-driven       | **When** `extractGitDiffModifiedLinesChecked` detects an active incoming merge of `fallbackBaseRef` (or `origin/<baseRef>`) or an outdated local base ref behind `origin/<baseRef>`, `extractGitDiffModifiedLinesChecked` **shall** scope modified lines relative to the verified incoming merge base, while `loadMutationCache` in a linked git worktree **shall** hydrate valid HMAC-verified entries read-only from the common repository cache without modifying or quarantining it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | MutationCache.decide | UnitTest     |

### 2 · Sub-50ms Hook Cold-Start & PreInvocation Session Fast-Path

**Source (`tools/node-ts-resolver.mjs`, `@harness/gates/hook-fastpath`, `@harness/decision/hook-fastpath`, `@harness/infra/hook-fastpath`, `@harness/graph/cluster-resolver`, `apps/harness-cli/src/**`):** Per-turn hooks (`guard`, `route`, `session --format=antigravity`) must execute in `< 50ms` via the warm in-process handler fast-path, avoid loading `typescript` or full graph analysis modules on cold starts, and avoid redundant `buildSessionReport` or AST scans when workspace state is unchanged.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Effect Symbol              | Verification |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ |
| REQ-2.1 | Event-driven | **When** `tools/node-ts-resolver.mjs` initializes and resolves workspace `@harness/*` package `"exports"` or relative `.js` specifiers under `libs/` and `apps/`, `node-ts-resolver.mjs` **shall** enable V8 compile caching outside the repo tree and resolve existing `.ts`/`.tsx` targets only when a literal `.js` file is absent on disk, while the four zero-`typescript` subpaths (`@harness/gates/hook-fastpath`, `@harness/decision/hook-fastpath`, `@harness/infra/hook-fastpath`, `@harness/graph/cluster-resolver`) **shall** expose hook primitives without loading `@harness/graph` or `typescript`.                                                  | Harness.decideGuardCommand | UnitTest     |
| REQ-2.2 | Event-driven | **When** `handleDoctorOrSession` runs with `--format=antigravity`, `handleDoctorOrSession` **shall** skip unused `buildSessionReport` computation and serve `.harness/session-preinvocation-cache.json` only when `HARNESS_REQUIRE_OLLAMA` is not `"1"` and `HEAD`, content-hashed `.harness/*` state files (using `last-done.json` instead of `telemetry-log.jsonl`), `tsgo`/cluster config files, `git --no-optional-locks status --porcelain=v1 -z` (2s timeout) + dirty/untracked file content digests, endpoint env config, non-symlink verification, and a 300-second `ollamaProbed` TTL match, replaying cached `stderr` and emitting `cache=hit` telemetry. | SessionHandoff.decide      | UnitTest     |

### 3 · Deterministic Nx Cache Guard & Focused Gate Test Partitioning

**Source (`libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/policy-shell-parser.ts`, `libs/harness/decision/src/triage-decision.ts`, `libs/harness/gates/test/*.test.ts`):** Routine commands must preserve Nx caching unless explicitly authorized, and gate test files must stay modular so mutation reaching sets isolate individual source modules.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Effect Symbol         | Verification |
| ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------ |
| REQ-3.1 | Unwanted behaviour | **If** a shell command invokes `nx` or an Nx-wrapping runner script with `--skip-nx-cache`, `--skipNxCache`, `NX_SKIP_NX_CACHE`, or `NX_DISABLE_NX_CACHE`, **then** `classifyCommand` **shall** return `"deny"` by default (`"ask"` with a friction audit event when `HARNESS_ALLOW_SKIP_NX_CACHE=1`), `explainCommandDenyReason` **shall** supply `SKIP_NX_CACHE_BANNED_REASON`, and `Harness.triageFailure` **shall** triage the denial deterministically in `0ms`. | Harness.triageFailure | UnitTest     |
| REQ-3.2 | State-driven       | **While** workspace test suites are partitioned across `libs/harness/gates/test/*.test.ts`, every `.test.ts` file in `libs/harness/gates/test/` **shall** remain at or below `1,500` lines (`MAX_TEST_FILE_LINES`, cross-enforced workspace-wide with `max-test-file-lines`, `max-tests-per-file`, and `test-domain-sprawl` under `harness:SPEC-0028`) so `partitionReachingTestFiles` isolates reaching Vitest runs by module concern.                               | MutationCheck.decide  | UnitTest     |

### 4 · Live Workspace Telemetry & Friction Isolation Under Vitest

**Source (`apps/harness-cli/src/index.ts`, `apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts`, `apps/harness-cli/src/commands/learn-and-report.command.ts`, `apps/harness-cli/src/commands/session-learn-report.command.ts`, `apps/harness-cli/src/commands/verify-and-done.command.ts`):** In-process Vitest tests must not pollute the repository's live `.harness/` telemetry, friction logs, or session reports.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Effect Symbol        | Verification |
| ------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-4.1 | State-driven | **While** `HARNESS_DISABLE_LIVE_TELEMETRY=1` (set by `vitest.config.ts`) or `HARNESS_TEST_ISOLATION=1` is set without an explicit `HARNESS_STATE_DIR` and the target `repoRoot` resolves to `CLI_REPO_ROOT`, `runCliEffect`, `recordTelemetry`, `recordFriction`, `writeDoneSessionReport`, `writeSessionReportFiles`, and `handleDoctorOrSession` **shall** suppress writes to `CLI_REPO_ROOT/.harness/` while preserving writes to temporary test `repoRoot` directories. | SessionReport.decide | UnitTest     |

## Assumptions

- **REQ-1.2:** Hashing each target file's transitive workspace import closure, conditional `docs/{adr,adrs,scenarios,specs}` / `agent-patterns` / `adapters` / `tools` buckets, touched-package test helpers, root/package configs, tool runners, Node/Vitest versions, and reaching test files minimizes false cache hits while preserving full invalidation via `allLibsSrcDigest` fallback on unresolved dynamic imports; remaining external host dependencies are documented in Known residual risks. (Supersession note: `mutation-cache-v2.json` and the `REQ-1.4` opt-in `HARNESS_MUTATE_WARM_ISOLATE=0` mode were later superseded by `harness:SPEC-0034` / `harness:ADR-0027` with witness-scoped `mutation-cache-v3.json` and unbypassable `isolate: true`.)
- **REQ-2.1:** Enabling V8 bytecode caching under `os.tmpdir()` (overridable via `NODE_COMPILE_CACHE`) avoids modifying the hashed workspace `treeHash` (`verify-stamp.json` / `mutate-stamp.json`).

## Out of scope

- Pre-bundling `apps/harness-cli` into a checked-in dist binary or running persistent background daemon processes automatically in hook scripts.

## Known residual risks

- Unmodeled OS-level shared library changes or arbitrary external binaries invoked outside tracked Node/Vitest versions are not hashed into `mutation-cache-v2.json` (superseded alongside `HARNESS_MUTATE_WARM_ISOLATE=0` by `harness:SPEC-0034` / `harness:ADR-0027`, which use `mutation-cache-v3.json` and unbypassable `isolate: true`); pass `--no-cache` to bypass cached kill entries on demand.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`UnitTest` and `PropertyTest`).
- `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, `pnpm harness mutate --strict`, `CI=true pnpm harness verify`, and `CI=true pnpm harness done` pass after `status: accepted`.
