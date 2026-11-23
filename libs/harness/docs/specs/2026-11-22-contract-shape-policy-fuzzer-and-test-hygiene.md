---
id: harness:SPEC-0028
title: Contract Shape Hardening, Adversarial Policy Property Matrix, and Test Hygiene Gates
status: accepted
archetype: framework
date: 2026-11-22
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0022
enforced_by:
  - tools/oxlint/syntax-bans.js
  - libs/harness/gates/src/gc-check.ts
  - libs/harness/gates/src/plugins/ast-contract-and-test-hygiene.ts
  - libs/harness/gates/src/plugins/ast-gate-visitors.ts
  - libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-workspace-io.ts
  - libs/harness/gates/src/ast-cache.ts
  - libs/harness/gates/src/index.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/policy-command-rules.ts
  - libs/harness/gates/src/policy-harness-state.ts
  - libs/harness/gates/test/ast-contract-and-test-hygiene.test.ts
  - libs/harness/gates/test/gc-test-and-decider.test.ts
  - libs/harness/gates/test/policy-adversarial-property.test.ts
  - libs/harness/gates/test/self-dogfooding-plugin-harness.test.ts
  - libs/harness/decision/test/guard-decision-property.test.ts
spans:
  - AstGateCache.decide
  - SyntaxBans.decide
  - TestIntegrity.decide
  - GraphGc.decide
  - Harness.decideGuardCommand
services: []
errors: []
---

## Context

Post-mortem review of PR #44 identified three structural quality gaps across contract schemas, security policy testing, and test hygiene. First, branded identifiers in `type:contract` can still omit trimming/pattern/length bounds or embed raw unvalidated `Schema.Record(Schema.String, Schema.Unknown)` escape hatches outside designated wire-envelope codecs, and callers can mistakenly read `.name` (JavaScript `Function.prototype.name === "Workflow"`) on a `Workflow.make(...)` definition instead of `._tag`.

Second, shell and path policy guards across `policy.ts`, `policy-shell-parser.ts`, `policy-harness-state.ts`, and `policy-worker-isolation.ts` rely predominantly on curated example regression tests, leaving nested quotes, backslash escapes, env-var expansions, command wrappers (`env`, `timeout`, `xargs`, `sh -c`), brace/glob obfuscations, and `..` path traversals under-fuzzed. Third, individual Vitest test callbacks can grow beyond 200 lines, monolithic test files can exceed 1,500 lines or 30 test cases or span more than 6 resolved production source domains, and closed `Schema.TaggedUnion` variants exported from `type:contract` can sit unexercised across `test/` suites.

- **Reused Contracts / Errors:** `GateViolation`, `GateRuleId`, `GcFinding`, `GcFindingKind`, `AstSourceFilePath` from `@harness/contract` and `@harness/gates`
- **Reused Services:** `SyncHostIo` from `@harness/service/host-io`
- **New Capabilities Needed:** `contract-shape-hardening`, `workflow-name-instead-of-tag`, `max-test-case-lines`, `max-test-file-lines`, and `max-tests-per-file` detectors in `ast-contract-and-test-hygiene.ts` + `tools/oxlint/syntax-bans.js`, `untested-union-variant` and `test-domain-sprawl` GC checks in `GraphGc.decide`, and generative property-based security fuzzer in `policy-adversarial-property.test.ts`

## Goal

Every `type:contract` schema enforces bounded branded invariants and safe `Workflow._tag` usage, the security guard policy survives randomized combinatorial shell/path obfuscation fuzzing under both coordinator and worker modes, and every test suite respects compact file and per-test size limits, domain-focused test imports, and full closed-union variant coverage.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Contract Shape and Effect Workflow Tag Hardening

**Source (`libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `tools/oxlint/syntax-bans.js`):** Prevents unbounded string identifiers, unguarded `Schema.Record` bags in domain contracts, and `Workflow.name` mistakes (`"Workflow"` vs `Workflow._tag`).

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                        | Effect Symbol         | Verification |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------ |
| REQ-1.1 | Unwanted behaviour | **If** a `type:contract` source file defines a branded string schema without `isTrimmed`, `isPattern`, or `isMaxLength` bounds, or defines `Schema.Record(Schema.String, Schema.Unknown)` outside designated wire-adapter modules, **then** `SyntaxBans.decide` and `harness/syntax-bans` **shall** report a `contract-shape-hardening` violation. | `SyntaxBans.decide`   | `AstGate`    |
| REQ-1.2 | Unwanted behaviour | **If** any workspace TypeScript file reads `.name` on a `Workflow.make(...)` definition (evaluating to `"Workflow"`) instead of `._tag`, **then** `AstGateCache.decide` and `harness/syntax-bans` **shall** report a `workflow-name-instead-of-tag` violation.                                                                                     | `AstGateCache.decide` | `AstGate`    |

### 2 · Adversarial Property-Based Security Policy Matrix

**Source (`libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/policy-shell-parser.ts`, `libs/harness/gates/src/policy-harness-state.ts`, `libs/harness/gates/src/policy-worker-isolation.ts`):** Replaces ad-hoc example security tests with property-based generators exploring adversarial quoting, wrappers, expansions, and path traversals.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                              | Effect Symbol                | Verification |
| ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------ |
| REQ-2.1 | Event-driven | **When** evaluating generated shell commands combining nested quotes, backslash escapes, variable expansions, subshells, command wrappers (`env`, `timeout`, `xargs`, `sh -c`), and protected `.harness`/`daemon.sock`/`auth-tokens.json`/`.env` paths, `Harness.decideGuardCommand` and `classifyCommand` **shall** deny or escalate every obfuscated access without allowing bypasses. | `Harness.decideGuardCommand` | `UnitTest`   |
| REQ-2.2 | Event-driven | **When** evaluating generated file paths combining `..` traversal, brace/glob obfuscation, and valid worktree prefixes across standard and `unitWorkerMode: true` policies, the policy path guard **shall** allow benign workspace sources while denying every protected stamp, state, and secret target.                                                                                | `Harness.decideGuardCommand` | `UnitTest`   |

### 3 · Test Hygiene, Domain Split, and Closed-Union Variant Coverage

**Source (`libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts`, `tools/oxlint/syntax-bans.js`):** Keeps Vitest test cases and suites domain-focused and compact while catching unexercised `Schema.TaggedUnion` variants in `@harness/contract`.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                               | Effect Symbol          | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------ |
| REQ-3.1 | Unwanted behaviour | **If** a Vitest `it(...)`, `it.effect(...)`, `it.live(...)`, or `it.prop(...)` callback body spans more than `200` source lines, **then** `TestIntegrity.decide` and `harness/test-integrity` **shall** report a `max-test-case-lines` violation.                         | `TestIntegrity.decide` | `AstGate`    |
| REQ-3.2 | Unwanted behaviour | **If** an exported closed `Schema.TaggedUnion` variant from `type:contract` has zero references across workspace `test/` files, **then** `GraphGc.decide` **shall** report an `untested-union-variant` finding.                                                           | `GraphGc.decide`       | `UnitTest`   |
| REQ-3.3 | Unwanted behaviour | **If** a workspace Vitest test file spans more than `1500` source lines or registers more than `30` Vitest `it` or `test` cases, **then** `TestIntegrity.decide` and `harness/test-integrity` **shall** report a `max-test-file-lines` or `max-tests-per-file` violation. | `TestIntegrity.decide` | `AstGate`    |
| REQ-3.4 | Unwanted behaviour | **If** a non-fixture workspace Vitest test file spans at least `300` source lines and imports runtime symbols resolving across more than `6` distinct production source domains, **then** `GraphGc.decide` **shall** report a `test-domain-sprawl` finding.               | `GraphGc.decide`       | `UnitTest`   |

## Assumptions

- **REQ-1.1:** Pre-existing raw JSON-row boundary schemas in `workflow-storage.ts` / `workflow-rpc.ts` are inspected carefully and either tightened or documented in an explicit narrow wire-codec exemption set so internal domain contracts never accept arbitrary `Unknown` property maps.
- **REQ-3.2:** Variant usage scanning inspects exported `Schema.TaggedUnion` member keys in `libs/*/contract/src/*.ts` against non-fixture workspace `test/**/*.test.ts` files via AST/symbol matching.
- **REQ-3.4:** Domain sprawl analysis inspects runtime imports in non-fixture workspace `test/**/*.test.ts(x)` files at or above `300` lines, transitively resolving barrel re-exports under `libs|apps/**/src/**` while ignoring type-only imports and pure helper modules, against `MAX_TEST_SOURCE_DOMAINS = 6`.

## Out of scope

- **Typed workflow protocol codecs, single-source timeout budgets, and static Omnigraph lease-fencing AST rules (P1-A).** Specified separately in `harness:SPEC-0027`.
- **Semantic doc truth and multi-specialist review hardening (P2).** Specified in `SPEC-0029`..`SPEC-0030`.

## Known residual risks

- Enforcing `max-test-case-lines` (`<= 200` lines per callback), `max-test-file-lines` (`<= 1500` lines per test file), `max-tests-per-file` (`<= 30` cases per test file), `test-domain-sprawl` (`<= 6` resolved production source domains at `>= 300` lines), and `contract-shape-hardening` across the workspace will flag any existing oversized tests, multi-domain test monoliths, or legacy unbounded contract brands, which must be split or tightened during implementation.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`AstGate`, `UnitTest`).
- `policy.ts` and `gc-hook-fastpath.ts` retain their exact 3-profile lightweight closure without importing TypeScript compiler or `@harness/graph`.
- `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, `pnpm harness mutate --strict`, `CI=true pnpm harness verify`, and `CI=true pnpm harness done` pass after updating frontmatter to `status: accepted`.
