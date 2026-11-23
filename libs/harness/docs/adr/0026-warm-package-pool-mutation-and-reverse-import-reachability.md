---
id: harness:ADR-0026
title: Warm Package-Pool Mutation Execution, Coverage-Guided Per-Test Targeting, and Reverse-Import Reachability
status: accepted
date: 2026-11-23
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/gates/src/mutation/mutation-package-batch.ts
  - libs/harness/gates/src/mutation/mutation-test-reachability.ts
  - libs/harness/gates/src/mutation/mutation-target-discovery.ts
  - libs/harness/gates/src/mutation/mutation-cache.ts
  - libs/harness/gates/src/mutation/mutation-backup.ts
  - libs/harness/gates/src/mutation/mutant-ast-generator.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/mutation-subprocess-helpers.ts
  - libs/harness/gates/test/mutation-speedup.test.ts
  - tools/package-vitest-batch.mjs
  - tools/warm-vitest-worker.mjs
  - tools/vitest-pool-helpers.mjs
  - tools/mutant-coverage-setup.mjs
  - tools/parallel-vitest-batch.mjs
spans:
  - MutationCheck.decide
  - MutationCache.decide
services: []
errors: []
informs:
  - harness:SPEC-0019
---

# ADR-0026 · Warm Package-Pool Mutation Execution, Coverage-Guided Per-Test Targeting, and Reverse-Import Reachability

## Context and Problem Statement

After expanding strict mutation coverage to pure logic inside `type:core`, `type:infra`, and `type:app` (`harness:ADR-0019`) and tightening contract/test hygiene (`harness:ADR-0022`), `pnpm harness mutate --strict` exhibited multi-ten-minute runs across linked worktrees and merged branches. Profiling established five interacting bottlenecks:

1. **Cold per-file Vitest subprocess startups:** Every target module spawned fresh Vite/Vitest transform processes instead of amortizing package transform graphs inside a persistent package worker pool.
2. **Coarse barrel-widened test selection:** Reaching-test lookup treated workspace barrel imports uniformly, sweeping unrelated heavy integration tests into `primaryTests` alongside direct unit importers.
3. **Unmeasured test execution order:** Without observed per-test hit probes and measured durations, heavy test files executed eagerly against mutants already killed in milliseconds by focused unit tests.
4. **Broad branch diff noise and redundant tree scans:** Merging `origin/main` inflated naive branch diffs without inspecting merge-base ancestry, while repeated tree walks lacked shared file-system module caches.
5. **Cold linked-worktree caches:** Linked git worktrees could not reuse pre-verified HMAC-signed kill entries from the common repository cache safely without risking shared-state corruption.

## Decision Drivers

- **Zero-Compromise Kill Soundness and Fail-Closed Baselines:** Preserve `--bail=1` strictly for active mutant runs (`HARNESS_ACTIVE_MUTANT_ID`) while running unmutated baselines without `--bail=1` and never minting kills on `Signaled` or solo `TimedOut` runs.
- **Amortized Package Transform Graphs:** Eliminate repeated Vite/Vitest module graph initialization across mutants within a package while isolating module state (`isolate: true` default, `fsModuleCache: true`, RSS recycling, and `vitest.invalidateFile` across targets).
- **Precision Reaching-Test Partitioning & Per-Test Targeting:** Prioritize direct intra-package reverse imports ahead of barrel importers and execute measured Stage 0 per-`it(...)` `testNamePattern` coverage probes before falling back to full test suites lazily on survivors.
- **Worktree-Safe Cross-Checkout Cache Hydration:** Allow linked git worktrees to hydrate matching HMAC-verified kill entries read-only from the common repository `.harness/cache/mutation-cache-v2.json` without writing or quarantining shared state.

## Considered Options

- **Option 1: Keep Cold Per-File Subprocesses and Coarse Package-Level Reaching Sets.** Retain per-file Vitest CLI spawning in `parallel-vitest-batch.mjs` with unmeasured fallback execution and standalone per-worktree caches.
- **Option 2: Adopt an External Mutation Runner or Exempt Pure `type:core`/`type:infra` Modules.** Replace the TypeScript AST mutator and custom runner with Stryker or disable strict mutation enforcement outside `type:domain`.
- **Option 3: Package-Level Persistent Warm Vitest Pool, Per-Test Coverage Targeting, and Reverse-Import Reachability.** Build an in-repo package-level warm Vitest worker pool (`tools/warm-vitest-worker.mjs`, `tools/package-vitest-batch.mjs`, `tools/vitest-pool-helpers.mjs`, `mutation-package-batch.ts`), add Stage 0 per-`it(...)` `testNamePattern` hit probes via `tools/mutant-coverage-setup.mjs`, partition reaching tests by static reverse-import distance excluding package barrels (`mutation-test-reachability.ts`), scope merge diffs cleanly (`mutation-target-discovery.ts`), and hydrate linked-worktree caches read-only from the common repository (`mutation-cache.ts`).

## Decision Outcome

**Chosen option:** "Option 3: Package-Level Persistent Warm Vitest Pool, Per-Test Coverage Targeting, and Reverse-Import Reachability", because it cuts strict mutation wall-clock time across modified packages by reusing Vite transforms, executing fast direct tests and per-test hits first, and sharing read-only verified kills across worktrees without weakening `MutationCheck.decide` or `MutationCache.decide` soundness guarantees.

### Architectural Rules and Guarantees

1. **Persistent Package-Level Warm Vitest Pool (`SPEC-0019 REQ-1.4`):** `tools/package-vitest-batch.mjs`, `tools/warm-vitest-worker.mjs`, `tools/vitest-pool-helpers.mjs`, `libs/harness/gates/src/mutation/mutation-package-batch.ts`, `libs/harness/gates/src/mutation/mutation-backup.ts`, and `libs/harness/gates/src/mutation-check.ts` execute package targets through warm Vitest workers with `fsModuleCache: true`, `isolate: true` by default (opt-in `HARNESS_MUTATE_WARM_ISOLATE=0` with per-mutant invalidation), RSS-threshold worker recycling, per-run `vitest.state` resets, `--root` + `--config` direct baseline invocation, and automatic cold fallback when `--no-cache` or `HARNESS_MUTATE_USE_WARM_VITEST=0` is set.
2. **Stage 0 Per-Test Targeting & Fast-Before-Heavy Ordering (`SPEC-0019 REQ-1.4`):** `tools/mutant-coverage-setup.mjs` and `tools/parallel-vitest-batch.mjs` alongside `libs/harness/gates/src/mutation/mutant-ast-generator.ts` and `libs/harness/gates/src/mutation-subprocess-helpers.ts` measure real per-test probe durations and hit spans on heavy files, executing targeted `testNamePattern` subsets first, splitting primary and fallback pools into fast-before-heavy stages, and verifying fallback baselines lazily only when primary stages leave surviving mutants.
3. **Intra-Package Reverse-Import Reachability & Compact Test Splits (`SPEC-0019 REQ-1.5`, `REQ-3.2`, `SPEC-0028 REQ-3.3`..`REQ-3.4`):** `libs/harness/gates/src/mutation/mutation-test-reachability.ts` traverses static intra-package reverse imports while excluding package barrels first so direct reaching suites populate `primaryTests` while barrel importers and slow meta-tests move to `fallbackTests`, amplified workspace-wide by enforcing `<= 1,500`-line, `<= 30`-test, domain-split suites under `harness:SPEC-0028`.
4. **Merge-Aware Diff Scoping & Read-Only Worktree Cache Hydration (`SPEC-0019 REQ-1.6`):** `libs/harness/gates/src/mutation/mutation-target-discovery.ts` resolves merge-base commits cleanly across incoming merges and remote `origin` refs, while `libs/harness/gates/src/mutation/mutation-cache.ts` hydrates HMAC-verified kill entries read-only from the common repository cache in linked worktrees without mutating or quarantining shared cache files.

## Rejected Alternatives

### 1 · Option 1: Keep Cold Per-File Subprocesses and Coarse Package-Level Reaching Sets

Execute each target's mutants via separate cold Vitest subprocesses against all barrel-connected package test files in arbitrary order.

**Why rejected:** Repeated Vite transform graph bootstrapping and unprioritized slow integration suites pushed single runs past 18–30 minutes, blocking rapid inner-loop remediation and PR verification.

### 2 · Option 2: External Mutation Runner or Exempt Pure `type:core`/`type:infra` Modules

Delegate mutation execution to Stryker or roll back strict mutation testing on pure parsers, extractors, and gate plugins outside `type:domain`.

**Why rejected:** External runners lack integration with Effect-TS AST mutant schemas, `MutationCache.decide` HMAC receipts, and `verify-stamp.json` cryptographic closures (`harness:ADR-0019`), while relaxing scope reintroduces unverified logic regressions.

## Consequences and Enforcement

### Positive Consequences

- Repeated mutant evaluations inside a package reuse warm Vite/Vitest module graphs, Stage 0 `testNamePattern` filters, and fast-before-heavy test ordering while maintaining 100% kill parity with cold execution.
- Linked worktrees immediately reuse HMAC-verified cache hits from the canonical repository without cross-worktree cache corruption.

### Negative Consequences and Trade-offs

- Warm worker pools must recycle deterministically on RSS thresholds and invalidate mutated modules strictly via `vitest.invalidateFile`, falling back to cold subprocess execution on `HARNESS_MUTATE_USE_WARM_VITEST=0` or unconfirmed exits.

### Deterministic Enforcement

| Rule                                                                           | Enforced By                                                                                                                                                                                                                                                                                                          | Gate / Mechanism                                                                                                            | Governed Symbols       |
| :----------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- | :--------------------- |
| Package-level warm Vitest worker pool & backup/restore isolation               | `libs/harness/gates/src/mutation/mutation-package-batch.ts`, `libs/harness/gates/src/mutation/mutation-backup.ts`, `libs/harness/gates/src/mutation-check.ts`, `tools/package-vitest-batch.mjs`, `tools/warm-vitest-worker.mjs`, `tools/vitest-pool-helpers.mjs`, `libs/harness/gates/test/mutation-speedup.test.ts` | Persistent Vite/Vitest worker lifecycle, `fsModuleCache: true`, RSS recycling, and transactional file restore               | `MutationCheck.decide` |
| Stage 0 per-test coverage targeting & fast-before-heavy fallback ordering      | `tools/mutant-coverage-setup.mjs`, `tools/parallel-vitest-batch.mjs`, `libs/harness/gates/src/mutation/mutant-ast-generator.ts`, `libs/harness/gates/src/mutation-subprocess-helpers.ts`, `libs/harness/gates/test/mutation-speedup.test.ts`                                                                         | `--bail=1` mutant execution, measured probe durations, `testNamePattern` targeting, and lazy fail-closed fallback baselines | `MutationCheck.decide` |
| Static reverse-import reachability partitioning & merge-aware target discovery | `libs/harness/gates/src/mutation/mutation-test-reachability.ts`, `libs/harness/gates/src/mutation/mutation-target-discovery.ts`, `libs/harness/gates/test/mutation-speedup.test.ts`                                                                                                                                  | Barrel-excluding intra-package reverse-import graph and merge-base line scoping                                             | `MutationCheck.decide` |
| HMAC-verified common-repo read-only worktree cache hydration                   | `libs/harness/gates/src/mutation/mutation-cache.ts`, `libs/harness/gates/test/mutation-speedup.test.ts`                                                                                                                                                                                                              | `MutationCache.decide` HMAC verification across worktree/common `.harness/cache/mutation-cache-v2.json`                     | `MutationCache.decide` |
