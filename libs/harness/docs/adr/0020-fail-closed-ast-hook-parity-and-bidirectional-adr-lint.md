---
id: harness:ADR-0020
title: Fail-Closed Interrupt/Decode AST Laws, Hook Matcher Tool Parity, and Bidirectional ADR Enforcement
status: accepted
date: 2026-11-22
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - apps/harness-cli/src/commands/hook-guard-payload.ts
  - libs/harness/contract/src/ast-and-gate-primitives.ts
  - libs/harness/gates/src/plugins/gc/gc-workspace-io.ts
  - libs/harness/gates/src/plugins/gc/gc-hook-parity.ts
  - libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts
  - libs/harness/gates/src/plugins/ast-fail-closed-laws.ts
  - libs/harness/gates/src/plugins/ast-gate-law-helpers.ts
  - libs/harness/gates/src/plugins/ast-gate-visitors.ts
  - libs/harness/gates/src/plugins/self-dogfooding-plugin.ts
  - libs/harness/gates/src/ast-cache.ts
  - libs/harness/gates/src/adr-enforcement-table-lint.ts
  - libs/harness/gates/src/adr-lint.ts
  - libs/harness/gates/test/gc-hook-parity.test.ts
  - libs/harness/gates/test/ast-fail-closed-laws.test.ts
  - libs/harness/gates/test/gc-ears-and-adr-quality.test.ts
spans:
  - GraphGc.decide
  - AstGateCache.decide
  - SelfDogfooding.decide
  - AdrDocLint.decide
services: []
errors: []
informs:
  - harness:SPEC-0025
---

# ADR-0020 · Fail-Closed Interrupt/Decode AST Laws, Hook Matcher Tool Parity, and Bidirectional ADR Enforcement

## Context and Problem Statement

Post-mortem review of PR #44 uncovered three structural enforcement blind spots across adapter hook configurations, Effect runtime error/resource boundaries, and ADR governance tables. First, `READ_ONLY_TOOL_NAMES` in `apps/harness-cli/src/commands/hook-guard-payload.ts` could add read tools without verifying that every Antigravity and Claude Code `hooks.json` `PreToolUse` / `PostToolUse` matcher and adapter `README.md` stayed synchronized, leaving tools such as `view_file_outline`, `view_code_item`, and `read_file` absent from `adapters/antigravity/plugins/effect-harness/README.md` or silently unintercepted if omitted from `hooks.json`.

Second, existing AST visitors checked only `Cause.hasInterruptsOnly` and silent `Effect.catchDefect`, allowing unguarded `Effect.catchCause` handlers without `isPureInterruptCause`, nullish / `Option.getOrElse` fallbacks on `Schema.decodeOption` or silent workflow-store `Effect.catchTag` recoveries, `Effect.tapError` rollbacks inside `Effect.acquireRelease` or `provision*` scopes (as found in `unix-socket-daemon-live.ts`), and `Result.try` sync FS fallbacks inside `libs/harness/infra/src/` (as found in `workflow-maintenance.ts`) to slip past static verification. Third, `AdrDocLint.decide` validated `### Deterministic Enforcement` only unidirectionally (table -> frontmatter) while `line.split("|")` misparsed escaped pipes in LaTeX cells, hiding split helper modules listed in `enforced_by` across 12 existing ADRs.

## Decision Drivers

- **Single Canonical Hook Tool Catalog Without Lightweight Closure Bloat:** Keep all Antigravity and Claude Code read/write/command tool tuples in `hook-guard-payload.ts` with zero new runtime imports, while inspecting them via TypeScript AST in `@harness/gates` (`SyncHostIo`) so `type:core` never imports `type:app`.
- **AST-Verified Fail-Closed Error and Resource Semantics:** Require real AST `isPureInterruptCause` identifier inspection in `Effect.catchCause` (immune to comment spoofing), ban empty silent fallbacks on decodes and workflow store errors, ban interrupt-skipping `Effect.tapError` rollbacks in `provision*`/`acquireRelease` acquire blocks, and extend `silent-gate-fs-fallback` to `libs/harness/infra/src/`.
- **True Bidirectional ADR Parity With Escaped-Pipe Safety:** Ensure every `enforced_by` entry appears in `### Deterministic Enforcement` and vice versa across code and graph config extensions (`.ts`, `.pg`, `.gq`, `.yaml`, `.sql`, `.cedar`) without breaking on escaped pipes.
- **Line-Budget Isolation and Automatic AST Cache Invalidation:** Extract cohesive leaf modules (`gc-hook-parity.ts`, `ast-fail-closed-laws.ts`, `adr-enforcement-table-lint.ts`) rather than exceeding the 800-line ceiling, and register AST rule additions in `AST_GATE_RULE_SOURCE_FILES`.

## Considered Options

- **Option 1:** Export canonical per-adapter tool tuples in `hook-guard-payload.ts` parsed by AST in `gc-hook-parity.ts`, add extracted `ast-fail-closed-laws.ts` registered in `AST_GATE_RULE_SOURCE_FILES` + expand `infra` path scope in `ast-gate-law-helpers.ts`, extract bidirectional `adr-enforcement-table-lint.ts`, and remediate all live workspace findings.
- **Option 2:** Import `hook-guard-payload.ts` at runtime from `@harness/gates` and rely on prose grep/regex checks instead of TypeScript AST parsing and bidirectional ADR table tracking.
- **Option 3:** Keep `Effect.catchCause`, `decodeOption ?? ...`, `infra` `Result.try`, and unidirectional ADR checks as review-only checklist items handled manually during code review.

## Decision Outcome

**Chosen option:** "Option 1: Export canonical per-adapter tool tuples in `hook-guard-payload.ts` parsed by AST in `gc-hook-parity.ts`, add extracted `ast-fail-closed-laws.ts` registered in `AST_GATE_RULE_SOURCE_FILES` + expand `infra` path scope in `ast-gate-law-helpers.ts`, extract bidirectional `adr-enforcement-table-lint.ts`, and remediate all live workspace findings", because it closes all three failure classes deterministically at `gc --strict` / `verify` time while preserving 5-tier Nx boundaries and per-file line budgets.

### Architectural Rules and Guarantees

1. **Canonical Adapter Hook Matcher Parity:** `CLAUDE_CODE_{READ_ONLY,WRITE,COMMAND}_TOOL_NAMES` and `ANTIGRAVITY_{READ_ONLY,WRITE,COMMAND}_TOOL_NAMES` in `hook-guard-payload.ts` are parsed via `ts.createSourceFile` in `gc-hook-parity.ts` (via `evaluateHookMatcherToolParity` / `checkHookMatcherToolParity`) inside `GraphGc.decide`; every tool must match a valid `PreToolUse` regex (and every write tool a `PostToolUse` regex) in `hooks.json` and align with adapter `README.md` (`hook-matcher-tool-parity`).
2. **Fail-Closed AST Error and Provisioning Laws:** `ast-fail-closed-laws.ts` (`registered in AST_GATE_RULE_SOURCE_FILES`) plus `ast-gate-law-helpers.ts` enforce `untyped-catch-cause-interrupt-leak` (`AstGateCache.decide`), `silent-decode-fallback` (`AstGateCache.decide`), `provision-tap-error-leak` (`SelfDogfoodingRuleId` in `@harness/contract` and `SelfDogfooding.decide`), and `silent-gate-fs-fallback` across `libs/harness/infra/src/` (`AstGateCache.decide` & `SelfDogfooding.decide`). Legitimate structured offline/rejection `Effect.catchTag` handlers and log-only `Effect.tapError` handlers remain allowed by AST structure inspection.
3. **Bidirectional ADR Enforcement Table Parity:** `adr-enforcement-table-lint.ts` validates `### Deterministic Enforcement` cells bidirectionally against `enforced_by`, handles escaped pipes cleanly in markdown rows, supports graph/config extensions (`.pg`, `.gq`, `.yaml`, `.yml`, `.sql`, `.cedar`), and keeps `AdrDocLint.decide` pure (`R = never`).

## Rejected Alternatives

### 1 · Option 2: Direct Runtime Import of `hook-guard-payload.ts` and Ad-Hoc Regex Checks

Import `apps/harness-cli` tool constants directly into `@harness/gates` and scan `catchCause` / `README.md` with plain text search.

**Why rejected:** Importing `apps/harness-cli` from `libs/harness/gates` breaks `HarnessTierTopology.decide` (`type:core` importing `type:app`), and regex text matching is trivially fooled by comments (`// isPureInterruptCause`) or escaped markdown pipes.

### 2 · Option 3: Manual Review Checklists Without Deterministic Gates

Leave interrupt-cause handling, silent decode fallbacks, `infra` FS error swallowing, and split-file ADR documentation to human/subagent review checklists.

**Why rejected:** PR #44 demonstrated that human and multi-agent reviews miss subtle fail-open patterns across large diffs; only deterministic `gc --strict` and `verify` gates eliminate recurrence across future PRs.

## Consequences and Enforcement

### Positive Consequences

- Remediated live repository bugs immediately: added missing read tools to `adapters/antigravity/plugins/effect-harness/README.md`, replaced `Effect.tapError` inside `Effect.acquireRelease` in `unix-socket-daemon-live.ts` with `Effect.onExit` + exhaustive `match(exit)`, logged failures in `workflow-maintenance.ts`, and restored 100% `enforced_by` table parity across 12 existing ADRs.
- All newly introduced rule modules (`gc-hook-parity.ts`, `ast-fail-closed-laws.ts`, `adr-enforcement-table-lint.ts`) remain compact (`<= 400` lines) with 100% mutation kill coverage.

### Negative Consequences and Trade-offs

- Newly split files added to any ADR's `enforced_by` frontmatter must be added explicitly to `### Deterministic Enforcement` before `gc --strict` will accept the commit.
- `SelfDogfoodingRuleId` in `libs/harness/contract/src/ast-and-gate-primitives.ts` must stay synchronized with any new self-dogfooding rules introduced in `@harness/gates`.

### Deterministic Enforcement

| Rule                                                                                                                                                       | Enforced By                                                                                                                                                                                                                                                                                                                                                                                  | Gate / Mechanism                                                                                                                                                                                  | Governed Symbols                               |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------- |
| Canonical adapter hook matcher and README parity                                                                                                           | `apps/harness-cli/src/commands/hook-guard-payload.ts`, `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts`, `libs/harness/gates/src/plugins/gc/gc-hook-parity.ts`, `libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`, `libs/harness/gates/test/gc-hook-parity.test.ts`                                                                                                           | `checkHookMatcherToolParity` and `evaluateHookMatcherToolParity` in `GraphGc.decide` (`hook-matcher-tool-parity`)                                                                                 | `GraphGc.decide`                               |
| Fail-closed `catchCause` interrupt guard, `decodeOption`/workflow `catchTag` bans, `provision` `tapError` rollback ban, and `infra` sync-FS fallback check | `libs/harness/contract/src/ast-and-gate-primitives.ts`, `libs/harness/gates/src/plugins/ast-fail-closed-laws.ts`, `libs/harness/gates/src/plugins/ast-gate-law-helpers.ts`, `libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `libs/harness/gates/src/plugins/self-dogfooding-plugin.ts`, `libs/harness/gates/src/ast-cache.ts`, `libs/harness/gates/test/ast-fail-closed-laws.test.ts` | AST laws `isUntypedCatchCauseWithoutInterruptGuard`, `isSilentDecodeOrStoreFallback`, `isProvisionTapErrorRollback`, `isSilentFsFallbackCheckedPath`, and `AST_GATE_RULE_SOURCE_FILES` cache hash | `AstGateCache.decide`, `SelfDogfooding.decide` |
| Bidirectional ADR `enforced_by` and `Deterministic Enforcement` table validation                                                                           | `libs/harness/gates/src/adr-enforcement-table-lint.ts`, `libs/harness/gates/src/adr-lint.ts`, `libs/harness/gates/test/gc-ears-and-adr-quality.test.ts`                                                                                                                                                                                                                                      | `validateAdrDeterministicEnforcementTable` (`adr-enforcement-mismatch`, `R = never`)                                                                                                              | `AdrDocLint.decide`                            |
