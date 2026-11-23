---
id: harness:SPEC-0026
title: Core Tier Test Reachability, Pure-Module Infra/App Mutation Expansion, and Workflow Cross-Seam Invariant Tests
status: accepted
archetype: framework
date: 2026-11-21
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0019
enforced_by:
  - libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-helpers.ts
  - libs/harness/gates/src/mutation/mutation-pure-module-classifier.ts
  - libs/harness/gates/src/mutation/mutation-target-discovery.ts
  - libs/harness/gates/src/mutation/mutation-suite-helpers.ts
  - libs/harness/gates/src/mutation/mutation-context-digest.ts
  - libs/harness/gates/src/mutation/mutation-closure.ts
  - libs/harness/gates/src/mutation/mutation-backup.ts
  - libs/harness/gates/src/verify-stamp.ts
  - libs/harness/gates/src/index.ts
  - libs/harness/infra/src/workflow/workflow-store-codec.ts
  - libs/harness/infra/src/omnigraph-workflow-store.ts
  - libs/harness/infra/src/workflow/read-model-rebuild-journal.ts
  - libs/harness/infra/src/workflow/message-storage-codec.ts
  - apps/harness-cli/src/commands/done-omnigraph-helpers.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
  - apps/harness-cli/src/commands/verify-doc-fastpath.ts
  - libs/harness/gates/test/gc-test-and-decider.test.ts
  - libs/harness/gates/test/friction-log.test.ts
  - libs/harness/gates/test/mutation-target-and-stamp.test.ts
  - libs/harness/gates/test/mutate-stamp-and-subprocess.test.ts
  - apps/harness-cli/test/mutate-and-plan-check.test.ts
  - libs/harness/infra/test/ast-gate-cache-helpers.test.ts
  - libs/harness/infra/test/workflow-replay-differential.test.ts
  - libs/harness/infra/test/worktree-policy-seam.test.ts
  - apps/harness-mcp/test/workflow-rpc-daemon.test.ts
spans:
  - GraphGc.decide
  - MutationCheck.decide
  - MutationCache.decide
  - Harness.executeTaskWorkflow
  - WorktreeRepoRoot.validate
  - HarnessCli.dispatchCommand
services: []
errors: []
---

## Context

Post-mortem analysis of PR #44 showed that more than 70% of production defects originated in deterministic business/protocol logic embedded inside `type:infra`, `type:app`, and `type:core` packages rather than `type:domain`. Although `PackageTag` mapped `type:core` packages (`@harness/gates`, `@harness/graph`, `@harness/decision`, `@harness/ingest`, `@harness/es-core`) to `"domain"`, `IGNORED_UNTESTED_FNS` in `libs/harness/gates/src/plugins/gc/gc-helpers.ts` exempted 18 core deciders/functions, and `libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts` skipped `infra` and `app` `EffectFn` test reachability completely. Similarly, `libs/harness/gates/src/mutation/mutation-target-discovery.ts` categorically excluded `type:infra` and `type:app`, leaving pure parsers, validators, and journal-replay state machines with zero mutant-kill coverage.

In addition, PR #44 exhibited severe cross-package seam bugs that individual package unit tests missed: `WorkflowWorktreePortLive` provisioned worker checkouts under `.git/harness/worktrees` while `policy` denied writes to `.git/harness/**` (`F-1.1`), and `read-model-rebuild-journal.ts` diverged from live workflow projections on interrupt messages, conflict retries, and waiting LLM phases. Defining differential workflow replay and worktree-policy seam invariants permanently closes those cross-boundary regressions.

- **Reused Contracts / Errors:** `CompiledPlan`, `WorkflowRunRecord`, `WorkflowUnitRecord`, `WorkflowAttemptRecord`, `PolicyGuardOptions` from `@harness/contract` and `@harness/gates`
- **Reused Services:** `SyncHostIo` from `@harness/service/host-io`
- **New Capabilities Needed:** zero-exemption `domain` (including `type:core`), `contract`, `infra`, and `app` `EffectFn` reachability and zero-exemption `.decide` property checks in `GraphGc.decide`, AST zero-I/O classifier for `infra`/`app` mutation discovery in `MutationCheck.decide`, differential `Harness.executeTaskWorkflow` ↔ `rebuildWorkflowReadModelViews` invariant suite, and `WorktreeRepoRoot.validate` ↔ policy cross-seam invariant suite

## Goal

Every non-stub `Effect.fn` across `domain` (including `type:core`), `contract`, `infra`, and `app` tiers and every pure `.decide` decider in `domain` (including `type:core`) or `contract` packages is subject to strict test-reachability and composite property-test gates with zero `IGNORED_UNTESTED_FNS` exemptions, every pure zero-I/O parser, codec, validator, or state machine inside `type:infra` and `type:app` participates in `MutationCheck.decide`, and cross-subsystem invariants lock workflow journal replay and worker worktree isolation together.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Executable Tier Test Reachability and Zero-Exemption Decider Property Checks

**Source (`libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts` & `libs/harness/gates/src/plugins/gc/gc-helpers.ts`):** Closes legacy `IGNORED_UNTESTED_FNS` exemptions across `type:core` deciders (mapped to `"domain"`) and extends `untested-effect-fn` across `infra` and `app` tiers.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                  | Effect Symbol    | Verification |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------ |
| REQ-1.1 | Unwanted behaviour | **If** a non-stub `EffectFn` in a `domain` (including `type:core`), `contract`, `infra`, or `app` package has zero reaching tests, **then** the `GraphGc.decide` decider **shall** report an `untested-effect-fn` finding with zero legacy `IGNORED_UNTESTED_FNS` exemptions.                                                                | `GraphGc.decide` | `UnitTest`   |
| REQ-1.2 | Unwanted behaviour | **If** a non-stub pure decider ending in `.decide` in a `domain` (including `type:core`) or `contract` package lacks composite property-based tests, **then** the `GraphGc.decide` decider **shall** report a `missing-decider-property-test` or `shallow-decider-property-test` finding with zero legacy `IGNORED_UNTESTED_FNS` exemptions. | `GraphGc.decide` | `UnitTest`   |

### 2 · Pure-Module Mutation Target Discovery in Infra and App Packages

**Source (`libs/harness/gates/src/mutation/mutation-target-discovery.ts`):** Brings zero-I/O state machines, parsers, codecs, and validators inside `type:infra` and `type:app` under strict mutation testing without mutating impure I/O adapters.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                   | Effect Symbol          | Verification |
| ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------ |
| REQ-2.1 | Event-driven       | **When** discovering mutation targets across the workspace, the `MutationCheck.decide` decider **shall** include TypeScript source modules under `libs/harness/infra/src/` and `apps/` that contain zero runtime I/O imports.                 | `MutationCheck.decide` | `UnitTest`   |
| REQ-2.2 | State-driven       | **While** classifying an infra or app source module for mutation eligibility, the `MutationCheck.decide` decider **shall** exclude modules with runtime imports from filesystem, child-process, network, SQL, or Effect platform I/O drivers. | `MutationCheck.decide` | `UnitTest`   |
| REQ-2.3 | Unwanted behaviour | **If** a pure infra or app module discovered for mutation has zero reaching Vitest test files, **then** the `MutationCheck.decide` decider **shall** record it in `untestedFiles` and fail strict mutation verification.                      | `MutationCheck.decide` | `UnitTest`   |

### 3 · Workflow Replay Differential and Worktree Policy Cross-Seam Invariants

**Source (`libs/harness/gates/src/harness-task-workflow.ts`, `libs/harness/infra/src/workflow/read-model-rebuild.ts`, `libs/harness/infra/src/worktree-repo-root.ts`, `libs/harness/gates/src/policy.ts`):** Prevents cross-package seam regressions between worktree layout and guard rules and between live projections and journal rebuilds.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                 | Effect Symbol                 | Verification |
| ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------ |
| REQ-3.1 | Event-driven | **When** `Harness.executeTaskWorkflow` completes a multi-wave trace covering merge-conflict retry, waiting LLM phase, completion, or operator abort, the `Harness.executeTaskWorkflow` workflow and journal rebuilder **shall** produce rebuilt `WfRun`, `WfUnit`, and `WfAttempt` views structurally equal to live projections.                            | `Harness.executeTaskWorkflow` | `UnitTest`   |
| REQ-3.2 | Event-driven | **When** a slice worktree checkout path validated by `WorktreeRepoRoot.validate` and `resolveWorkflowWorktreeDir` is evaluated under worker isolation mode, the `WorktreeRepoRoot.validate` seam and policy guard **shall** allow source-file writes inside the slice worktree while denying `.harness` state files, `daemon.sock`, and `auth-tokens.json`. | `WorktreeRepoRoot.validate`   | `UnitTest`   |

### 4 · Doc-Only Verify Fast-Path, Mutable-Only Mutate Stamp, Cache Isolation, and Done Snapshot Cleanup

**Source (`libs/harness/gates/src/verify-stamp.ts`, `libs/harness/gates/src/mutation/mutation-context-digest.ts`, `apps/harness-cli/src/commands/verify-and-done.command.ts`, `apps/harness-cli/src/commands/done-omnigraph-helpers.ts`):** Eliminates redundant full mutation re-runs and stale `plan-graph-snapshot.json` blockers when only markdown specs or plans change.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                              | Effect Symbol                | Verification |
| ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------ |
| REQ-4.1 | Event-driven | **When** `writeMutateStamp` or `checkMutateStamp` digests the workspace, the `MutationCheck.decide` stamp gate **shall** hash only non-markdown files via `computeMutableTreeHashChecked` so markdown-only edits preserve mutate-stamp validity.                                                                                                                                                                                         | `MutationCheck.decide`       | `UnitTest`   |
| REQ-4.2 | State-driven | **While** computing mutation context digests across `libs/`, the `MutationCache.decide` cache context **shall** exclude `docs` directories from `LIBS_EXCLUDED_DIRS` so markdown changes under `libs/*/docs/` never invalidate `allLibsSrcDigest`.                                                                                                                                                                                       | `MutationCache.decide`       | `UnitTest`   |
| REQ-4.3 | Event-driven | **When** `syncOmnigraphOnDone` completes a successful branch merge and deletes `plan/wt-*` in Omnigraph, the `HarnessCli.dispatchCommand` done flow **shall** remove any stale `.harness/plan-graph-snapshot.json` file.                                                                                                                                                                                                                 | `HarnessCli.dispatchCommand` | `UnitTest`   |
| REQ-4.4 | Event-driven | **When** `handleVerify` runs against an existing valid `VerifyStamp` whose `mutableTreeHash` matches `computeMutableTreeHashChecked` and whose `CI` seed tier and pinned `DST_SEED` match the stamped run, the `HarnessCli.dispatchCommand` verify flow **shall** run governance, graph, ontology, strict GC, mutate-stamp, and span-budget checks and refresh `verify-stamp.json` without re-running Nx subprocess builds or DST seeds. | `HarnessCli.dispatchCommand` | `UnitTest`   |

## Assumptions

- **REQ-2.1:** Pure-module classification inspects runtime module specifiers using the TypeScript AST (`ts.createSourceFile` from `@harness/graph`) so `import type` declarations do not disqualify otherwise pure modules.
- **REQ-3.1:** Structural equality compares normalized projected rows (`WfRun`, `WfUnit`, `WfAttempt`) ordered deterministically by canonical key after journal replay finishes.

## Out of scope

- **Hook matcher parity, fail-closed AST laws, and bidirectional ADR lint (P0-A).** Specified separately in `harness:SPEC-0025`.
- **Typed workflow protocol contracts, contract shape hardening, policy property fuzzer, and test hygiene (P1) and semantic doc/review upgrades (P2).** Specified in `harness:SPEC-0027`..`harness:SPEC-0030`.

## Known residual risks

- Enabling `core` decider property checks and pure `infra`/`app` mutation discovery initially widens mutation runtime on touched PRs; existing `.harness/cache/mutation-cache-v1.json` per-file caching mitigates repeated unchanged runs.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`UnitTest`).
- Pure `infra`/`app` modules are discovered deterministically without breaking `type:domain` / `type:core` / `type:contract` classification invariants in `mutation-target-and-stamp.test.ts`.
- `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, `pnpm harness mutate --strict`, `CI=true pnpm harness verify`, and `CI=true pnpm harness done` pass after updating frontmatter to `status: accepted`.
