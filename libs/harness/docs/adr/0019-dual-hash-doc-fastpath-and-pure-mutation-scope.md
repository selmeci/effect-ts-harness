---
id: harness:ADR-0019
title: Dual-Hash Doc-Only Verify Fast-Path, Zero-Exemption Tier Reachability, and Pure-Module Infra/App Mutation Scope
status: accepted
date: 2026-11-22
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-helpers.ts
  - libs/harness/gates/src/mutation/mutation-pure-module-classifier.ts
  - libs/harness/gates/src/mutation/mutation-target-discovery.ts
  - libs/harness/gates/src/verify-stamp.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
  - apps/harness-cli/src/commands/verify-doc-fastpath.ts
  - libs/harness/infra/test/workflow-replay-differential.test.ts
  - libs/harness/infra/test/worktree-policy-seam.test.ts
spans:
  - GraphGc.decide
  - MutationCheck.decide
  - MutationCache.decide
  - Harness.executeTaskWorkflow
  - WorktreeRepoRoot.validate
  - HarnessCli.dispatchCommand
services: []
errors: []
informs:
  - harness:SPEC-0026
---

# ADR-0019 · Dual-Hash Doc-Only Verify Fast-Path, Zero-Exemption Tier Reachability, and Pure-Module Infra/App Mutation Scope

## Context and Problem Statement

Post-mortem analysis of PR #44 established that more than 70% of shipped defects originated in deterministic parsing, state-machine, and validation logic inside `type:core`, `type:infra`, and `type:app` packages, as well as cross-package seams such as `WorkflowWorktreePortLive` vs. `policy` path guards and `Harness.executeTaskWorkflow` vs. `rebuildWorkflowReadModelViews` replay. Simultaneously, `IGNORED_UNTESTED_FNS` exempted 18 functions in `libs/harness/gates/src/plugins/gc/gc-helpers.ts`, `gc-test-and-decider.plugin.ts` skipped `infra` and `app` reachability, and `mutation-target-discovery.ts` excluded `type:infra` and `type:app` wholesale.

Furthermore, a single whole-tree hash (`treeHash`) in `.harness/verify-stamp.json` forced full Nx build, test, and strict mutation verification (`mutantsEvaluated: 811`) even when an author edited only `.md` governance specifications or documentation. Left unresolved, developers face heavy latency penalties during spec authoring while blind exemptions silently shelter deterministic infra/app logic from reachability and mutation gates.

## Decision Drivers

- **Zero-Exemption Reachability and Property Completeness:** Eliminate ad-hoc `IGNORED_UNTESTED_FNS` suppressions across `domain` (including `type:core`), `contract`, `infra`, and `app` tiers plus every `.decide` decider.
- **Deterministic Pure-Module Mutation Scope Without Flaky I/O:** Subject zero-I/O parsers, codecs, and state machines inside `type:infra` and `type:app` to strict mutation testing without mutating live socket, process, or filesystem drivers.
- **Cryptographic Doc-Only Fast-Path Integrity:** Accelerate documentation-only edits (`*.md`) during `pnpm harness verify` while proving mathematically that zero executable code, schema, config, or test inputs changed since the last stamped verification.
- **Executable Cross-Subsystem Seam Locking:** Encode cross-package invariants directly in executable differential replay and worktree-policy seam test suites so isolated package mocks cannot hide integration mismatches.

## Considered Options

- **Option 1:** Empty `IGNORED_UNTESTED_FNS` and enforce full tier reachability, add an AST zero-I/O classifier for `infra`/`app` mutation target discovery, separate `treeHash` from `mutableTreeHash` in `.harness/verify-stamp.json` for fail-closed doc-only verify fast-path, and add cross-seam invariant suites.
- **Option 2:** Keep a single `treeHash` with manual CLI `--skip-mutate` flags or extension-based skip heuristics that bypass `MutationCheck.decide` whenever commit messages or `git diff` appear documentation-only.
- **Option 3:** Expand `MutationCheck.decide` to mutate all `libs/harness/infra/src/` and `apps/*/src/` files indiscriminately without filtering side-effectful I/O shells.

## Decision Outcome

**Chosen option:** "Option 1: Empty `IGNORED_UNTESTED_FNS` and enforce full tier reachability, add an AST zero-I/O classifier for `infra`/`app` mutation target discovery, separate `treeHash` from `mutableTreeHash` in `.harness/verify-stamp.json` for fail-closed doc-only verify fast-path, and add cross-seam invariant suites", because it eliminates blind spots across pure code in `core`/`infra`/`app` while keeping doc-only verification both fast and cryptographically sound.

### Architectural Rules and Guarantees

1. **Zero-Exemption Tier Reachability:** Legacy ignored-function exemptions in `libs/harness/gates/src/plugins/gc/gc-helpers.ts` remain eliminated (`untested-effect-fn` / `shallow-decider-property-test` with zero allowlist bypasses), and `gc-test-and-decider.plugin.ts` enforces test reachability across `domain` (`type:core`), `contract`, `infra`, and `app` non-stub `EffectFn` spans alongside composite property-test validation on all `.decide` functions.
2. **AST Zero-I/O Pure-Module Mutation Inclusion:** `mutation-pure-module-classifier.ts` and `mutation-target-discovery.ts` statically include side-effect-free modules inside `type:infra` and `type:app` in `MutationCheck.decide` while keeping live process/socket/filesystem I/O adapters out of mutant generation.
3. **Dual-Hash Doc-Only Verify Fast-Path:** `libs/harness/gates/src/verify-stamp.ts` computes both full workspace `treeHash` and non-markdown code/config `mutableTreeHash` (`isMarkdownDocPath` restricts exclusions to non-executable `.md` docs outside `adapters/`, `agent-patterns/`, `src/`, `test/`, `tests/`, `__tests__/`, and `fixtures/`); `verify-doc-fastpath.ts` and `verify-and-done.command.ts` re-use the prior stamp's build/mutation evidence only when `mutableTreeHash` matches byte-for-byte, `CI=true` `ci_full` seed count and pinned `DST_SEED` remain satisfied, and full `gc --strict` (`expectedPatterns`, `checkUntestedDomainFns`, `checkDeciderPropertyTests`), `ontology check --strict`, and `decideSpanBudgets` checks pass fresh.
4. **Cross-Seam Differential and Isolation Suites:** `workflow-replay-differential.test.ts` verifies `Harness.executeTaskWorkflow` live projections match `rebuildWorkflowReadModelViews` across interrupts, retries, and phase waits, while `worktree-policy-seam.test.ts` locks `WorktreeRepoRoot.validate` path layout against policy guard rules.

## Rejected Alternatives

### 1 · Option 2: Single-Hash `treeHash` with Manual Skip Flags or `git diff` Heuristics

Rely on manual `--skip-mutate` flags or unstamped `git diff` checks against arbitrary commits to skip mutation testing on documentation updates.

**Why rejected:** Unstamped heuristics break reproducibility across rebases, amends, and untracked files, allowing executable test/config edits or stale mutation stamps to slip past verification without cryptographic proof that `mutableTreeHash` is unchanged.

### 2 · Option 3: Blanket Mutation Testing Across All `type:infra` and `type:app` Files

Include live Unix-socket servers, child-process wrappers, and OS lock modules inside strict mutant execution (`--strict`).

**Why rejected:** Mutating timeouts, cleanup intervals, and live socket retry guards in I/O shells creates non-deterministic hangs and flaky kills without isolating pure codecs, state machines, and validators where logic defects actually live.

## Consequences and Enforcement

### Positive Consequences

- Every pure parser, codec, journal state machine, and core decider carries full reachability, property-test, and mutation-kill coverage (`811` evaluated mutants).
- Documentation-only commits validate formatting, full `gc --strict`, `ontology check --strict`, and `decideSpanBudgets` when eligible for fast-path reuse and mint an updated `verify-stamp.json` while preserving exact `mutableTreeHash` parity.

### Negative Consequences and Trade-offs

- Newly extracted pure helpers inside `type:infra` or `type:app` automatically enter `MutationCheck.decide`, requiring high-signal unit/differential assertions before `verify` passes.
- Doc-only verification still requires a valid prior non-stale `mutableTreeHash` baseline stamp, falling back automatically to full verification whenever any non-`.md` file changes.

### Deterministic Enforcement

| Rule                                                                | Enforced By                                                                                                                                                  | Gate / Mechanism                                                                                  | Governed Symbols                                           |
| :------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------ | :--------------------------------------------------------- |
| Zero-exemption test reachability and decider property checks        | `libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-helpers.ts`                                         | `GraphGc.decide` (`untested-effect-fn`, `shallow-decider-property-test`, zero allowlist bypasses) | `GraphGc.decide`                                           |
| AST pure-module mutation inclusion across `infra` and `app`         | `libs/harness/gates/src/mutation/mutation-pure-module-classifier.ts`, `libs/harness/gates/src/mutation/mutation-target-discovery.ts`                         | `MutationCheck.decide` strict target discovery and `MutationCache.decide` closure cache           | `MutationCheck.decide`, `MutationCache.decide`             |
| Dual-hash cryptographic doc-only verify fast-path validation        | `libs/harness/gates/src/verify-stamp.ts`, `apps/harness-cli/src/commands/verify-and-done.command.ts`, `apps/harness-cli/src/commands/verify-doc-fastpath.ts` | `mutableTreeHash` parity plus fresh `gc --strict` and `ontology check --strict` in CLI `verify`   | `HarnessCli.dispatchCommand`                               |
| Cross-subsystem workflow replay and worktree-policy seam invariants | `libs/harness/infra/test/workflow-replay-differential.test.ts`, `libs/harness/infra/test/worktree-policy-seam.test.ts`                                       | Differential journal replay suite and worktree-policy path containment tests                      | `Harness.executeTaskWorkflow`, `WorktreeRepoRoot.validate` |
