---
id: harness:ADR-0022
title: Contract Shape Hardening, Adversarial Policy Property Matrix, and Test Hygiene Gates
status: accepted
date: 2026-11-22
deciders:
  - "@harness/architecture"
scope: harness
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
informs:
  - harness:SPEC-0028
---

# ADR-0022 · Contract Shape Hardening, Adversarial Policy Property Matrix, and Test Hygiene Gates

## Context and Problem Statement

PR #44 exposed three systemic drift vectors that bypassed existing compile and lint checks. First, exported `Schema.String.pipe(Schema.brand(...))` definitions in `type:contract` could omit trimming/pattern/length bounds or embed raw `Schema.Record(Schema.String, Schema.Unknown)` bags outside wire codecs, and `Workflow.make(...)` callers could accidentally read `.name` (evaluating to JavaScript `"Workflow"`) instead of `._tag`.

Second, shell and path policy rules in `policy.ts`, `policy-command-rules.ts`, and `policy-harness-state.ts` lacked property-based fuzzing over nested quoting, variable assignments/expansions, `.dev.vars` secret patterns, backslash escapes, and `..` traversal combinations; `Harness.decideGuardCommand` can fall back to the advisory `DecisionModel` if an adversarial command reaches `"escalate"` instead of `"deny"`. Third, oversized Vitest callbacks exceeding 200 lines, monolithic multi-domain test files exceeding 1,500 lines or 30 test cases or spanning more than 6 resolved production source domains, and exported `Schema.TaggedUnion` variants unexercised across workspace test suites obscured failure locality and slowed targeted test selection.

## Decision Drivers

- **Zero-Bypass Contract Bounds and Workflow Tag Discipline:** Enforce `contract-shape-hardening` and `workflow-name-instead-of-tag` uniformly across both `AstGateCache.decide`/`SyntaxBans.decide` and `oxlint` (`tools/oxlint/syntax-bans.js`), while preserving explicit exemptions for external wire codecs (`wire-adapter.ts`, `wire-envelope.ts`).
- **Combinatorial Property Fuzzing Without Heavier Guard Closures:** Keep `policy.ts`, `policy-command-rules.ts`, and `policy-harness-state.ts` free of `@harness/graph` or the TypeScript compiler while closing backslash-escape, variable-expansion, delimiter-boundary, and `.dev.vars` gaps uncovered by Fast-Check fuzzing in `@harness/gates` and `@harness/decision`.
- **Compact Domain-Focused Tests and Complete Closed-Union Coverage:** Enforce `max-test-case-lines` (`<= 200` lines per callback), `max-test-file-lines` (`<= 1500` lines per test file), and `max-tests-per-file` (`<= 30` cases per test file) across `TestIntegrity.decide` and `harness/test-integrity`, and report `untested-union-variant` and `test-domain-sprawl` findings in `GraphGc.decide` for unexercised exported union variants and test files importing across more than 6 resolved source domains.

## Considered Options

- **Option 1:** Implement `contract-shape-hardening`, `workflow-name-instead-of-tag`, `max-test-case-lines`, `max-test-file-lines`, and `max-tests-per-file` in a dedicated pure module (`ast-contract-and-test-hygiene.ts`) mirrored into `tools/oxlint/syntax-bans.js`, add `untested-union-variant` and `test-domain-sprawl` to `gc-test-and-decider.plugin.ts`, harden `policy*.ts` normalization/variable expansion with property-based suites (`policy-adversarial-property.test.ts` and `guard-decision-property.test.ts`), and split or tighten all violating contract brands and monolithic test files workspace-wide.
- **Option 2:** Document contract shape bounds and test size budgets in Markdown review checklists without deterministic AST or GC enforcement.
- **Option 3:** Enforce `contract-shape-hardening` and test size budgets only inside `oxlint` without registering matching visitors in `ast-gate-visitors.ts` and `AST_GATE_RULE_SOURCE_FILES`.

## Decision Outcome

**Chosen option:** "Option 1: Implement dedicated pure detectors in `ast-contract-and-test-hygiene.ts` with `oxlint` parity, `untested-union-variant` and `test-domain-sprawl` in `GraphGc.decide`, hardened `policy*.ts` guards with property fuzzers, and full workspace remediation", because dual AST + `oxlint` enforcement keeps IDE feedback, `AstGateCache.decide`, and CLI verification synchronized while deterministic property fuzzing exercises adversarial command combinations across both coordinator and worker modes.

### Architectural Rules and Guarantees

1. **Contract Shape & Workflow Tag AST Rules (`SPEC-0028 REQ-1.1`..`SPEC-0028 REQ-1.2`):** `ast-contract-and-test-hygiene.ts` (registered in `AST_GATE_RULE_SOURCE_FILES`, wired into `ast-gate-visitors.ts`, re-exported via `libs/harness/gates/src/index.ts`, and mirrored in `tools/oxlint/syntax-bans.js`) flags branded string schemas in `libs/*/contract/src/*.ts` lacking `isTrimmed`/`isPattern`/`isMaxLength`, unguarded `Schema.Record(Schema.String, Schema.Unknown)` outside `wire-adapter.ts`/`wire-envelope.ts`, and `.name` / `["name"]` property accesses on `Workflow.make(...)` symbols across `.ts`/`.tsx` workspace files.
2. **Adversarial Policy Hardening & Property Fuzzing (`SPEC-0028 REQ-2.1`..`SPEC-0028 REQ-2.2`):** `policy-command-rules.ts` adds `.dev.vars` and shell quote/delimiter boundaries to secret path detection; `policy.ts` normalizes trimmed backslash-escaped file paths and expands command variables before secret inspection; `policy-harness-state.ts` evaluates both normalized and variable-expanded variants while unescaping backslashes in harness-state token checks. `policy-adversarial-property.test.ts` and `guard-decision-property.test.ts` verify adversarial command/path matrices against both `classifyCommand` and `Harness.decideGuardCommand`.
3. **Test Hygiene, Domain Split & Union Variant GC Gates (`SPEC-0028 REQ-3.1`..`SPEC-0028 REQ-3.4`):** `max-test-case-lines` (`MAX_TEST_CASE_LINES = 200`), `max-test-file-lines` (`MAX_TEST_FILE_LINES = 1500`), and `max-tests-per-file` (`MAX_TESTS_PER_FILE = 30`) bound callback length, test file size, and per-file case count in both `TestIntegrity.decide` and `harness/test-integrity`, while `gc-test-and-decider.plugin.ts` plus `gc-workspace-io.ts` add `untested-union-variant` (checking exported `Schema.TaggedUnion` variants against non-fixture `(libs|apps)/**/test/**/*.test.ts(x)` AST tokens) and `test-domain-sprawl` (`MAX_TEST_SOURCE_DOMAINS = 6` resolved production runtime source domains at `MIN_LINES_FOR_DOMAIN_SPRAWL = 300` lines) in `GraphGc.decide`.

## Rejected Alternatives

### 1 · Option 2: Advisory Review Checklists Without Deterministic Gates

Rely on human or reviewer-agent inspection to check string brand bounds, `.name` reads on workflows, and callback line counts.

**Why rejected:** Review-only heuristics do not block incremental drift or surface immediate editor diagnostics during implementation.

### 2 · Option 3: `oxlint`-Only Visitors Without `AstGateCache.decide` Parity

Add the new rules only to `tools/oxlint/syntax-bans.js`, leaving `SyntaxBans.decide`, `TestIntegrity.decide`, and `ast-cache.ts` unchanged.

**Why rejected:** `AstGateCache.decide` powers cached AST gate checks and structured `GateViolation` reporting; diverging rule sets between `oxlint` and `@harness/gates` causes inconsistent gate outcomes.

## Consequences and Enforcement

### Positive Consequences

- Every branded string schema in `@harness/contract`, `@harness/es-contract`, and `@harness/sample-contract` declares explicit trimming/max-length/pattern bounds with synchronized `openapi.json` contracts.
- Every Vitest callback across the workspace respects `<= 200` lines, every test file respects `<= 1500` lines, `<= 30` cases, and `<= 6` resolved production source domains (at `>= 300` lines), improving test isolation and reviewability, and every exported `Schema.TaggedUnion` contract maintains full variant test coverage.

### Negative Consequences and Trade-offs

- New branded string schemas in `type:contract` must declare an explicit `isTrimmed`, `isPattern`, or `isMaxLength` check (or use a bounded constraint helper), and large multi-domain test suites must extract fixture helpers (`test/helpers/**`) and split scenarios across domain-focused `*.test.ts` files.

### Deterministic Enforcement

| Rule                                                                                                                                                          | Enforced By                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Gate / Mechanism                                                                                                                            | Governed Symbols                           |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------- |
| Contract shape bounds & workflow tag AST checks (`contract-shape-hardening`, `workflow-name-instead-of-tag`)                                                  | `libs/harness/gates/src/plugins/ast-contract-and-test-hygiene.ts`, `libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `libs/harness/gates/src/ast-cache.ts`, `libs/harness/gates/src/index.ts`, `tools/oxlint/syntax-bans.js`, `libs/harness/gates/test/ast-contract-and-test-hygiene.test.ts`                                                                                                                                                                                                                 | Dual `SyntaxBans.decide` + `oxlint` AST checks cached via `AST_GATE_RULE_SOURCE_FILES`                                                      | `AstGateCache.decide`, `SyntaxBans.decide` |
| Adversarial shell/path policy normalization & property fuzzing                                                                                                | `libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/policy-command-rules.ts`, `libs/harness/gates/src/policy-harness-state.ts`, `libs/harness/gates/test/policy-adversarial-property.test.ts`, `libs/harness/decision/test/guard-decision-property.test.ts`                                                                                                                                                                                                                                                | Variable expansion, backslash unescaping, `.dev.vars` boundary rules, and Fast-Check fuzzing                                                | `Harness.decideGuardCommand`               |
| Test size/sprawl & closed union coverage (`max-test-case-lines`, `max-test-file-lines`, `max-tests-per-file`, `untested-union-variant`, `test-domain-sprawl`) | `libs/harness/gates/src/plugins/ast-contract-and-test-hygiene.ts`, `libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `libs/harness/gates/src/gc-check.ts`, `tools/oxlint/syntax-bans.js`, `libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts`, `libs/harness/gates/test/ast-contract-and-test-hygiene.test.ts`, `libs/harness/gates/test/gc-test-and-decider.test.ts`, `libs/harness/gates/test/self-dogfooding-plugin-harness.test.ts` | `MAX_TEST_CASE_LINES = 200`, `MAX_TEST_FILE_LINES = 1500`, `MAX_TESTS_PER_FILE = 30`, `GraphGc.decide` union coverage & domain sprawl audit | `TestIntegrity.decide`, `GraphGc.decide`   |
