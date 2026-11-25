---
id: harness:SPEC-0034
title: Witness-Scoped Mutation Caching, Incremental Chunk Flush, Strict Fail-Fast & Stage-A Probing, Adaptive Test Timings, Persistent Package Pool, and Verified Stacked-PR Base Stamping
status: draft
archetype: framework
date: 2026-11-25
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0001
  - harness:ADR-0002
  - harness:ADR-0011
  - harness:ADR-0019
  - harness:ADR-0026
enforced_by:
  - libs/harness/contract/src/workspace-and-process.ts
  - libs/harness/contract/src/ast-and-gate-primitives.ts
  - libs/harness/gates/src/mutation/mutation-cache.ts
  - libs/harness/gates/src/mutation/mutation-closure.ts
  - libs/harness/gates/src/mutation/mutation-context-digest.ts
  - libs/harness/gates/src/mutation/mutation-package-batch.ts
  - libs/harness/gates/src/mutation/mutation-test-reachability.ts
  - libs/harness/gates/src/mutation/mutation-target-discovery.ts
  - libs/harness/gates/src/mutation/mutation-outcomes.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/verify-stamp.ts
  - apps/harness-cli/src/commands/mutate-and-bench.command.ts
  - apps/harness-cli/src/commands/mutate-stamp-gate.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - tools/package-vitest-batch.mjs
  - tools/vitest-pool-helpers.mjs
  - tools/warm-vitest-worker.mjs
  - tools/mutant-coverage-setup.mjs
spans:
  - MutationCache.decide
  - MutationCheck.decide
services: []
errors: []
---

## Context

Profiling `pnpm harness mutate --strict` across stacked PR development in `SPEC-0033` (957 evaluated mutants across `@harness/gates`, `@harness/graph`, `@harness/contract`, `@harness/ingest`, and `apps/harness-mcp`) exposed five compounding engine bottlenecks beyond missing per-module unit tests: (1) `computeFileMutationClosureDigest` hashes every test in `allReachingTests` — including all ~58 `packageFallbackTests` and heavy workspace meta-tests — and promotes string literals containing `"libs/"` plus `hasRepoFsIo` into `allLibsSrcDigest`, so a 4-line edit in an unrelated `type:infra` file (`libs/es/infra/src/memory.ts`) invalidated 935 of 957 previously killed mutants and triggered a 423s cold re-evaluation; (2) `flushCacheIfDirty()` persists entries only after all package batches complete, causing late aborts or timeouts to discard 15+ minutes of verified kills; (3) `--strict` runs continue executing full 55-test fallback sweeps across all remaining files even after mutants survive and no `--stage-a-only` CLI flag exists for rapid Stage-A iteration; (4) test priority relies on a static 19-entry `HEAVY_META_TEST_BASENAMES` allowlist rather than measured durations, while `executeQueuedPackageBatches` tears down and cold-spawns Vite/Vitest worker pools at 4-file chunk boundaries and spawns separate `runCoverageProbe` subprocesses while repeating redundant per-mutant `vitest.invalidateFile` calls under `isolate: true`; and (5) `mutate-stamp-gate.ts` hardcodes `fallbackBaseRef: "main"`, blocking strict stamped runs against verified stacked-PR parent branches.

- **Reused Contracts / Errors:** `AstSourceFilePath`, `ContentSha256`, `MutationCacheEntry`, `MutationCacheLookupDecision`, `MutationCacheMac`, `MutationCacheStore`, `MutantId`, `PackageRelKey`, `WorkspaceFilePath`, `MutateStamp` from `@harness/contract` (`WorkspaceFsError`, `HarnessSubprocessError`)
- **Reused Services:** `SyncHostIo` (`@harness/service/host-io`), `nodeSyncHostIo` (`@harness/infra`)
- **New Capabilities Needed:** Witness-scoped cache entry fields (`witnessTestFile`, `witnessClosureSha256`) and HMAC payload bindings in `MutationCache.decide`, AST `referencesLibs` precision scoping, per-chunk/partial cache flushing, `--fail-fast` / `--max-survivors <N>` / `--stage-a-only` options, `.harness/cache/mutation-test-timings-v1.json` EMA timing recorder & sorter, continuous per-package warm worker pools with in-worker Stage 0 probes and schema-switch-only `invalidateFile`, and stacked `--base <parentRef>` ancestor HMAC proof verification in `MutationCheck.decide`.

## Goal

Every `harness mutate` execution preserves cached kills across unrelated workspace and fallback edits through witness-scoped HMAC closures, flushes verified kills incrementally, fails fast or runs rapid `--stage-a-only` probes without manual scratch scripts, schedules tests by measured duration inside single continuous per-package warm worker pools with zero redundant per-mutant file invalidation, and stamps stacked PR branches without sacrificing cryptographic `main`-equivalent mutation soundness.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Witness-Scoped Mutation Cache Keys, Tightened `allLibsSrcDigest` Fallback & Incremental Flush

**Source (`libs/harness/gates/src/mutation/mutation-cache.ts`, `mutation-closure.ts`, `mutation-context-digest.ts`, `mutation-check.ts`):** Scoped witness closures eliminate 98% cross-package cache invalidations while incremental flushes preserve completed work on partial aborts.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                               | Effect Symbol        | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-1.1 | Event-driven       | **When** a killed mutant is verified by a specific killing test file `witnessTestFile`, `MutationCache.decide` **shall** bind its cache entry and HMAC payload to `witnessTestFile` alongside the minimal transitive import closure of `(relFile, witnessTestFile)` without hashing unrelated `packageFallbackTests`.     | MutationCache.decide | PropertyTest |
| REQ-1.2 | Event-driven       | **When** looking up cached kill entries for `(relFile, reachingTests)` after unrelated workspace or non-witness fallback test edits, `MutationCache.decide` **shall** return valid cache hits whenever `witnessTestFile` belongs to `reachingTests` and its witness closure digest and HMAC signature verify intact.      | MutationCache.decide | UnitTest     |
| REQ-1.3 | Unwanted behaviour | **If** a candidate cache entry fails HMAC verification, exceeds TTL, references a symlinked path, or misses any digest in the transitive closure of `(relFile, witnessTestFile)`, **then** `MutationCache.decide` **shall** reject the entry for re-evaluation without mutating read-only common-repo caches.             | MutationCache.decide | UnitTest     |
| REQ-1.4 | Event-driven       | **When** `computeFileMutationClosureDigest` scans AST literals along the transitive closure of a target module and its non-workspace-scanning witness test, `MutationCache.decide` **shall** limit `allLibsSrcDigest` coupling to genuine repository-root `libs/` filesystem traversal instead of synthetic test strings. | MutationCache.decide | UnitTest     |
| REQ-1.5 | Event-driven       | **When** `executeQueuedPackageBatches` finishes any package chunk or aborts cleanly after completed files, `MutationCache.decide` **shall** atomically flush newly recorded HMAC-verified kill entries to `.harness/cache/` immediately instead of waiting for full suite completion.                                     | MutationCache.decide | UnitTest     |

### 2 · Strict Fail-Fast Execution & First-Class Stage-A Survivor Probe

**Source (`libs/harness/gates/src/mutation-check.ts`, `libs/harness/gates/src/mutation/mutation-package-batch.ts`, `apps/harness-cli/src/commands/mutate-and-bench.command.ts`):** First-class `--fail-fast`, `--max-survivors`, and `--stage-a-only` modes eliminate multi-minute blind waits during inner-loop remediation while preventing unsafe stamp writes.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                            | Effect Symbol        | Verification |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-2.1 | Event-driven       | **When** `harness mutate` is invoked with `--fail-fast` or `--max-survivors <N>`, `MutationCheck.decide` **shall** halt further file/batch evaluation once total confirmed survivors reach `<N>`, print each `file:line:original->replacement`, and flush prior kills. | MutationCheck.decide | UnitTest     |
| REQ-2.2 | Unwanted behaviour | **If** `--fail-fast` or `--max-survivors <N>` terminates execution early with non-zero survivors, **then** `MutationCheck.decide` **shall** return `passed: false` with non-zero exit code and remove any stale `.harness/mutate-stamp.json`.                          | MutationCheck.decide | UnitTest     |
| REQ-2.3 | Event-driven       | **When** `harness mutate` is invoked with `--stage-a-only`, `MutationCheck.decide` **shall** execute only `primaryTests` (plus Stage 0 per-`it` targeting) while bypassing `scopedFallbackTests` and `packageFallbackTests` sweeps.                                    | MutationCheck.decide | UnitTest     |
| REQ-2.4 | Ubiquitous         | The `MutationCheck.decide` gate **shall not** write `.harness/mutate-stamp.json` when executed with `--stage-a-only`, `--fail-fast` early termination, or `--scope`.                                                                                                   | MutationCheck.decide | UnitTest     |

### 3 · Adaptive Measured Test-Duration Ordering

**Source (`libs/harness/gates/src/mutation/mutation-test-reachability.ts`, `libs/harness/gates/src/mutation/mutation-outcomes.ts`):** Adaptive test-duration statistics replace manual `HEAVY_META_TEST_BASENAMES` maintenance so fast unit tests always execute before heavy integration suites.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                            | Effect Symbol        | Verification |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-3.1 | Event-driven       | **When** unmutated baselines or Stage-0/Stage-1 test runs complete for a package, `MutationCheck.decide` **shall** persist non-authoritative EMA wall-clock timings keyed by `(pkgKey, relTestFile, contentSha256)` in `.harness/cache/mutation-test-timings-v1.json`. | MutationCheck.decide | UnitTest     |
| REQ-3.2 | Event-driven       | **When** partitioning and sorting `primaryTests` and `fallbackTests`, `MutationCheck.decide` **shall** order tests strictly from lowest to highest measured duration and classify suites exceeding the heavy threshold automatically for two-phase gating.             | MutationCheck.decide | UnitTest     |
| REQ-3.3 | Unwanted behaviour | **If** `.harness/cache/mutation-test-timings-v1.json` is missing, symlinked, schema-invalid, or stale for a modified test hash, **then** `MutationCheck.decide` **shall** fall back cleanly to line-count and static `HEAVY_META_TEST_BASENAMES` ordering.             | MutationCheck.decide | UnitTest     |

### 4 · Persistent Per-Package Warm Pool, In-Worker Coverage Probes & Redundant-Invalidation Removal

**Source (`libs/harness/gates/src/mutation/mutation-package-batch.ts`, `tools/package-vitest-batch.mjs`, `tools/vitest-pool-helpers.mjs`, `tools/warm-vitest-worker.mjs`, `tools/mutant-coverage-setup.mjs`):** Eliminating chunk-boundary worker teardown, external probe processes, and redundant `vitest.invalidateFile` calls maximizes throughput per mutant.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                             | Effect Symbol        | Verification |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-4.1 | Event-driven       | **When** a package has multiple uncached target files, `MutationCheck.decide` **shall** reuse a single persistent warm Vitest worker pool across all files in `(scope, pkgDir)` while streaming per-file completion and atomic backup/restore transitions.              | MutationCheck.decide | UnitTest     |
| REQ-4.2 | Event-driven       | **When** Stage 0 coverage probing is required for heavy target test files, `MutationCheck.decide` **shall** execute the hit probe in an already-initialized warm worker or keyed probe cache instead of spawning cold per-file Vitest subprocesses.                     | MutationCheck.decide | UnitTest     |
| REQ-4.3 | State-driven       | **While** executing mutants inside an `isolate: true` warm worker across a fixed on-disk `schemaSource` module, `MutationCheck.decide` **shall** issue `vitest.invalidateFile` strictly on schema-file transitions rather than between `HARNESS_ACTIVE_MUTANT_ID` runs. | MutationCheck.decide | UnitTest     |
| REQ-4.4 | Unwanted behaviour | **If** a warm worker exceeds `MAX_WORKER_RSS_BYTES` or emits an unconfirmed `TimedOut` or `Exited(1)` result, **then** `MutationCheck.decide` **shall** recycle the worker cleanly and confirm solo (`concurrency=1`) or `Abort` fail-closed on `Signaled`.             | MutationCheck.decide | UnitTest     |

### 5 · Cryptographically Verified Stacked-PR Base Stamping

**Source (`apps/harness-cli/src/commands/mutate-and-bench.command.ts`, `apps/harness-cli/src/commands/mutate-stamp-gate.ts`, `libs/harness/gates/src/verify-stamp.ts`):** Verifying stacked parent diffs against valid HMAC kill receipts lets stacked PRs write `.harness/mutate-stamp.json` without re-running ancestor PR mutants from `main`.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                            | Effect Symbol        | Verification |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-5.1 | Event-driven       | **When** `harness mutate --strict --base <parentRef>` evaluates only `<parentRef>...HEAD` mutants, `MutationCheck.decide` **shall** verify that every modified mutable line in `main...<parentRef>` holds a valid witness-verified HMAC kill before writing the stamp. | MutationCheck.decide | UnitTest     |
| REQ-5.2 | Unwanted behaviour | **If** `--strict --base <parentRef>` detects any modified mutable line in `main...<parentRef>` lacking a verified non-expired HMAC kill entry, **then** `MutationCheck.decide` **shall** expand evaluation to cover unverified ancestor mutants before stamping.       | MutationCheck.decide | UnitTest     |
| REQ-5.3 | Ubiquitous         | The `MutationCheck.decide` warm runner **shall** keep `isolate: true` as its unbypassable default and uphold equivalent `main`-diff cryptographic kill coverage for every `.harness/mutate-stamp.json` produced under `--strict`.                                      | MutationCheck.decide | GraphCheck   |

## Implementation Waves (Recommended PR Split)

1. **Wave 1 (Highest ROI, zero `tools/*.mjs` pool changes):** Areas 1–2 — witness-scoped cache keys (`REQ-1.1`..`REQ-1.4`), incremental chunk flush (`REQ-1.5`), strict `--fail-fast` / `--max-survivors` (`REQ-2.1`..`REQ-2.2`), and `--stage-a-only` (`REQ-2.3`..`REQ-2.4`).
2. **Wave 2 (Pool & scheduler throughput):** Areas 3–4 — adaptive EMA timing cache (`REQ-3.1`..`REQ-3.3`), continuous per-package warm worker pool (`REQ-4.1`, `REQ-4.4`), in-worker/cached Stage 0 hit probes (`REQ-4.2`), and eliminating redundant per-mutant `invalidateFile` under `isolate: true` (`REQ-4.3`).
3. **Wave 3 (Stacked-PR stamp ergonomics):** Area 5 — ancestor HMAC proof verification and authorized stacked-PR stamping under `--strict --base <parentRef>` (`REQ-5.1`..`REQ-5.3`).

## Assumptions

- **REQ-1.1:** Introducing `witnessTestFile` and `witnessClosureSha256` bumps `MUTATION_CACHE_SCHEMA_VERSION` cleanly (or adds non-legacy fields verified by `verifyMutationEntryMac`), leaving read-only legacy cache files untouched.
- **REQ-2.1:** Passing `--fail-fast` without `--max-survivors` defaults `--max-survivors` to `1`.
- **REQ-3.1:** EMA timing updates use decay factor `alpha = 0.3` and classify a suite as heavy when its measured duration meets or exceeds `2000` ms, storing timings outside HMAC kill caches as non-authoritative scheduling hints only.
- **REQ-5.1:** Stacked ancestor verification against `main...<parentRef>` requires `<parentRef>` to resolve cleanly via local git ancestry (`git merge-base --is-ancestor`); missing refs fail closed to `main`.

## Out of scope

- **Disabling `isolate: true` globally (`HARNESS_MUTATE_WARM_ISOLATE=0`):** Module-level caches such as `libs/harness/gates/src/ast-cache.ts` produce false survivors without VM/module isolation across runs. Decides: `@harness/architecture`.
- **Replacing Vitest with an external mutation runner (e.g., Stryker):** Preserving native AST mutant schemata, `MutationCache.decide` HMAC receipts, and `.harness/verify-stamp.json` closure verification remains mandatory per `harness:ADR-0026`.
- **Relaxing strict mutation coverage on pure `type:core`, `type:infra`, or `type:app` modules:** Scope established by `harness:ADR-0019` stays unchanged.

## Known residual risks

- Wall-clock timing measurements in `.harness/cache/mutation-test-timings-v1.json` can fluctuate under heavy CPU contention; incorrect ordering affects latency only and never kill soundness.
- Removing 4-file chunk restarts in continuous per-package pools increases single-process lifetime, mitigated by `MAX_WORKER_RSS_BYTES` worker recycling (`REQ-4.4`) and incremental per-file cache flushes (`REQ-1.5`).
- Rebasing a stacked parent branch alters `main...<parentRef>` commit SHAs cleanly without invalidating witness-keyed entries unless underlying files or tests change.

## Acceptance criteria

- All requirement rows pass their declared verification methods (`UnitTest`, `PropertyTest`, `GraphCheck`) in `pnpm --filter @harness/gates test` and `apps/harness-cli` tests.
- `EarsSpecLint.decide` reports `clean: true` with `0` findings, `pnpm harness gc --strict` reports `clean: true`, and `pnpm harness ontology check --strict` reports `clean: true` with zero semantic conflicts.
- Subsequent runs of `pnpm harness mutate --strict` after unrelated `type:infra`/`type:app` or fallback-test edits hit witness-verified cached kills (`>= 95%` cache hit rate) and complete full stacked-branch `verify` within SLO budgets.
