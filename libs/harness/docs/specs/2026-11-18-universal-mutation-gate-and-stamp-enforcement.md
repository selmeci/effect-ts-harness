---
id: harness:SPEC-0018
title: Universal Mutation Gate and Stamp Enforcement
status: accepted
archetype: framework
date: 2026-11-18
owners:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/gates/src/mutation/mutant-ast-generator.ts
  - libs/harness/gates/src/mutation/mutation-backup.ts
  - libs/harness/gates/src/mutation/mutation-target-discovery.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/verify-stamp.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/rule-synthesizer.ts
  - libs/harness/gates/src/index.ts
  - apps/harness-cli/src/commands/mutate-and-bench.command.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
spans:
  - MutationCheck.decide
services: []
errors: []
---

## Context

Previously, mutation target discovery relied on directory path conventions, compiled at most one mutant per file, missed untracked and branch-base diffs, and did not cryptographically bind strict mutation runs to `harness verify`. Hardening the mutation gate requires tag-based package discovery across `type:domain`, `type:core`, and `type:contract`, AST-validated multi-mutant schema compilation, fail-closed git diff extraction including untracked files and branch-base fallback, and tamper-resistant `.harness/mutate-stamp.json` enforcement during `harness verify`.

- **Reused Contracts / Errors:** `computeContentSha256` from `@harness/contract`; `DstSeedsRunCount`, `computeWorkspaceTreeHash`, `resolveHarnessStateDir` from `@harness/gates`
- **Reused Services:** `SyncHostIo` from `@harness/service/host-io`
- **New Capabilities Needed:** `MutateEnforcementMode`, `MutateDiffMode`, `MutateStampSchema`, `writeMutateStamp`, `removeMutateStamp`, `checkMutateStamp`, `extractGitDiffModifiedLinesChecked`, `findUnclassifiedModifiedLibFiles`, `partitionReachingTestFiles`, `verifyMutantSchemaSyntax`, and `MutationCheck.decide`.

## Goal

Every modified `type:domain`, `type:core`, and `type:contract` file is discovered via Nx package tags, mutated with AST-verified multi-mutant schemas against reaching Vitest suites, and cryptographically sealed by `.harness/mutate-stamp.json` before `harness verify` can issue `.harness/verify-stamp.json`.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Tag-Based Target Discovery & AST-Valid Multi-Mutant Compilation

**Source (`libs/harness/gates/src/mutation/mutation-target-discovery.ts` & `mutant-ast-generator.ts`):** Mutation discovery must classify libraries by Nx tags rather than folder names and validate every compiled mutant schema via the TypeScript parser before disk write.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                       | Effect Symbol            | Verification |
| ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------ |
| REQ-1.1 | Event-driven       | **When** `findDomainFiles` scans `libs/`, `findDomainFiles` **shall** classify packages by Nx `type:domain`, `type:core`, and `type:contract` tags while excluding `type:service` and impure `type:infra`/`type:app` modules (pure zero-I/O `type:infra`/`type:app` modules are additionally discovered per `harness:SPEC-0026`). | MutationCheck.decide     | UnitTest     |
| REQ-1.2 | Unwanted behaviour | **If** a modified `libs/` TypeScript file belongs to an unclassified package, **then** `findUnclassifiedModifiedLibFiles` **shall** report the file so `runDomainMutationSuite` fails closed in strict mode.                                                                                                                      | MutationCheck.decide     | UnitTest     |
| REQ-1.3 | Event-driven       | **When** `compileMutantSchemaModule` generates conditional mutant branches, `verifyMutantSchemaSyntax` **shall** parse the resulting TypeScript AST and reject syntactically invalid mutant schemas.                                                                                                                              | verifyMutantSchemaSyntax | UnitTest     |

### 2 · Untracked + Branch-Base Diff Extraction & CLI Flag Surface

**Source (`libs/harness/gates/src/mutation-check.ts` & `apps/harness-cli/src/commands/mutate-and-bench.command.ts`):** Diff scoping must cover untracked files, branch-base `merge-base` commits without silent fallback, and explicit CLI overrides (`--strict`, `--all`, `--scope`, `--file`, `--base`).

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                          | Effect Symbol        | Verification |
| ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-2.1 | Event-driven | **When** `extractGitDiffModifiedLinesChecked` inspects a git workspace, `extractGitDiffModifiedLinesChecked` **shall** union working-tree and untracked TypeScript diffs with `diffFromMergeBase` (preventing dirty non-mutable `libs/` edits from masking branch changes) without silent fallback.                                                                                                                  | MutationCheck.decide | UnitTest     |
| REQ-2.2 | Event-driven | **When** `handleMutate` executes with `--strict`, `--all`, `--scope`, `--file`, or `--base`, `handleMutate` **shall** reject dangling CLI flags (`--base`/`--file`/`--scope` missing a value or starting with `-`), forward valid options to `runDomainMutationSuite`, track 0-mutant scanned files in `--strict --all`, and fail closed when strict mode finds zero reaching tests, zero mutants, or coverage gaps. | MutationCheck.decide | UnitTest     |

### 3 · Mutate Stamp Enforcement & Forgery Protection

**Source (`libs/harness/gates/src/verify-stamp.ts`, `policy.ts`, & `apps/harness-cli/src/commands/verify-and-done.command.ts`):** Strict mutation results must be bound to the workspace tree hash in `.harness/mutate-stamp.json`, protected from direct writes, and verified by `harness verify`.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                              | Effect Symbol        | Verification |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ |
| REQ-3.1 | Event-driven       | **When** `handleMutate` passes in `--strict` mode without `--scope` or `--file` filters, `writeMutateStamp` **shall** persist `.harness/mutate-stamp.json` (`MutateStampSchema`, including `equivalentCount`) bound to `computeWorkspaceTreeHash` and verified coverage.                                                                                                                                                                                 | MutationCheck.decide | UnitTest     |
| REQ-3.2 | Unwanted behaviour | **If** `handleMutate` fails, **then** `removeMutateStamp` **shall** delete the stale `.harness/mutate-stamp.json` stamp.                                                                                                                                                                                                                                                                                                                                 | MutationCheck.decide | UnitTest     |
| REQ-3.3 | Unwanted behaviour | **If** modified mutable `libs/` files exist during `handleVerify` without a matching `CheckMutateStampResult` (`_tag: "Valid"`) strict `MutateStamp` tree hash (unless `options.mutateStampPolicy === "skip"`, `options.skipSubprocessVerify === true`, or `isIsolatedExternalWorkspace(repoRoot)` when not `"enforce"`), **then** `checkMutateStamp` **shall** return `{ _tag: "Invalid", reason }` and reject verification with `verify:mutate-stamp`. | MutationCheck.decide | UnitTest     |
| REQ-3.4 | Unwanted behaviour | **If** any agent file write targets `.harness/mutate-stamp.json` directly, **then** `classifyFileWrite` **shall** deny the direct edit.                                                                                                                                                                                                                                                                                                                  | MutationCheck.decide | UnitTest     |

## Assumptions

- **REQ-2.1:** When `git rev-parse --is-inside-work-tree` exits with code 128 outside a git repository, `extractGitDiffModifiedLinesChecked` returns `not-git` rather than `failed`.

## Out of scope

- **Distributed remote mutant execution.** Mutant execution runs locally against reaching Vitest files.

## Known residual risks

- Equivalent mutants not annotated with `@equivalent` or equivalence priors may reduce mutation score in strict mode until annotated or covered by assertions.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`UnitTest`).
- `libs/harness/gates` and `apps/harness-cli` pass `typecheck`, `lint`, `gc --strict`, and `ontology check --strict`.
- Frontmatter is `status: accepted` and verified by `pnpm harness verify`.
