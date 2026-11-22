---
title: "SPEC-0028 Implementation Plan: Contract Shape Hardening, Adversarial Policy Property Matrix, and Test Hygiene Gates"
type: feat
status: proposed
date: 2026-11-22
spec: harness:SPEC-0028
---

# Goal

Implement `harness:SPEC-0028` (P1-B of the PR #44 post-mortem harness hardening roadmap) across `@harness/gates`, `tools/oxlint/syntax-bans.js`, and workspace tests: harden `type:contract` schemas and forbid `.name` access on `Workflow.make` definitions, enforce `<= 200`-line test callbacks and closed-union variant test coverage, and add an adversarial property-based security policy fuzzer.

---

## 1. Scope & Line-Budget Decomposition Strategy

Keep `libs/harness/gates/src/plugins/ast-gate-visitors.ts` (587/800 lines) and `libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts` (120/800 lines) comfortably under the `800`-line limit, and leave the `gc-hook-fastpath.ts` 3-profile closure completely untouched:

1. `libs/harness/gates/src/plugins/ast-contract-and-test-hygiene.ts` (`<= 240` lines) — AST detectors for `contract-shape-hardening`, `workflow-name-instead-of-tag`, and `max-test-case-lines`, called by `ast-gate-visitors.ts` and registered in `AST_GATE_RULE_SOURCE_FILES`.
2. `tools/oxlint/syntax-bans.js` — mirror `contract-shape-hardening` (`harness/syntax-bans`), `workflow-name-instead-of-tag` (`harness/syntax-bans`), and `max-test-case-lines` (`harness/test-integrity`) for instant IDE/linter feedback, including `[rule-id]` diagnostic tags matching `DOC_TRUTH_RULE_ID_SOURCES`.
3. `libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts` + `gc-workspace-io.ts` — add `"untested-union-variant"` to `GcFindingKind` and detect unreferenced closed `Schema.TaggedUnion` variants exported from `type:contract`.
4. `libs/harness/gates/test/policy-adversarial-property.test.ts` — keep `libs/harness/gates/test/policy.test.ts` (1596 lines) unbloated by isolating the property matrix in a dedicated test file.

---

## 2. Effect Building-Block Mapping & Exact File Changes

### Unit 1 · Contract Shape & Effect Workflow `.name` Ban (`REQ-1.1`, `REQ-1.2`)

- **AST & Oxlint Rules (`ast-contract-and-test-hygiene.ts`, `ast-gate-visitors.ts`, `ast-cache.ts`, `tools/oxlint/syntax-bans.js`):**
  - Detect branded string schemas in `libs/*/contract/src/*.ts` (`Schema.String.pipe(..., Schema.brand(...))`) missing `Schema.isTrimmed()`, `Schema.isPattern(...)`, or `Schema.isMaxLength(...)`, plus unexempted `Schema.Record(Schema.String, Schema.Unknown)` definitions (`contract-shape-hardening`).
  - Detect `Workflow.make(...)` identifiers (both local declarations and `@harness/*` imports like `HarnessTaskWorkflow`) accessed via `.name` (`workflow-name-instead-of-tag`), guiding callers to `._tag`.
  - Append `WorkspaceFilePath.make("libs/harness/gates/src/plugins/ast-contract-and-test-hygiene.ts")` to `AST_GATE_RULE_SOURCE_FILES` (`ast-cache.ts`).
  - Remediate any flagged legacy schemas across `libs/harness/contract/src/*.ts` cleanly in place (updating all callers cleanly; no backwards-compatibility shims).

### Unit 2 · Adversarial Property-Based Security Policy Fuzzer (`REQ-2.1`, `REQ-2.2`)

- **Generative Security Suite (`libs/harness/gates/test/policy-adversarial-property.test.ts`):**
  - Build composable `Schema.Literals` / pattern generators (`fast-check` via `@effect/vitest` `it.prop` / `it.effect.prop`) synthesizing:
    - protected targets (`.harness/...`, `.git/harness/daemon.sock`, `.git/harness/auth-tokens.json`, `daemon.lock`, `.env`, `.env.local`, `repos/effect/...`),
    - shell obfuscators (single/double/nested quotes, line-continuations, `$VAR`/`${VAR}` assignments, `$(...)` subshells, command wrappers `env`, `timeout`, `xargs`, `sh -c`), and
    - path obfuscators (`..` segments, `/./`, brace `{a,b}` and glob char-class `[a]` tricks) inside and outside valid `.harness/workflow-worktrees/<runId>/<unitId>/...` worktree roots.
  - Assert that `classifyCommand`, `Harness.decideGuardCommand`, `classifyFileRead`, and `classifyFileWrite` (both default and `unitWorkerMode: true`) deny or escalate every adversarial payload while allowing generated benign workspace `src/` reads/writes. Fix any newly discovered parser or normalization corner cases in `policy*.ts` cleanly within the 800-line ceiling.

### Unit 3 · Test Hygiene & Closed-Union Variant Coverage (`REQ-3.1`, `REQ-3.2`)

- **Test Case Length Gate (`ast-contract-and-test-hygiene.ts`, `ast-gate-visitors.ts`, `tools/oxlint/syntax-bans.js`):**
  - Measure line spans (`endLine - startLine`) of Vitest `it(...)`, `it.effect(...)`, `it.live(...)`, `it.prop(...)`, and `it.effect.prop(...)` callback arguments across `**/test/**/*.test.ts`; emit `max-test-case-lines` above `200` lines. Split any oversized existing workspace test callbacks into focused helper functions or sibling `it(...)` cases.
- **Untested Union Variant Gate (`gc-test-and-decider.plugin.ts`, `gc-workspace-io.ts`):**
  - Extract closed `Schema.TaggedUnion` variant tags declared in `type:contract` and verify every variant tag is exercised in workspace `test/` files; report missing variants as `untested-union-variant` `GcFinding` items and cover any gaps in contract/gates/infra tests.

---

## 3. Adversarial, Negative & Mutation Test Matrix

| Target File                                                     | Positive Coverage                                                        | Negative / Fault Coverage                                                                             | Property / Determinism Check                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `libs/harness/gates/test/ast-contract-and-test-hygiene.test.ts` | Bounded branded strings, `Workflow._tag`, `<= 200`-line test bodies pass | Unbounded `Schema.brand`, `Schema.Record(String, Unknown)`, `Workflow.name`, `> 200`-line `it()` fail | `it.effect.prop` determinism on `SyntaxBans.decide` & `TestIntegrity.decide` |
| `libs/harness/gates/test/policy-adversarial-property.test.ts`   | Valid worktree source edits & benign CLI commands return `"allow"`       | Obfuscated shells/wrappers and traversal/glob paths return `"deny"` or `"escalate"`                   | `it.prop` across generated combinations of wrappers, quotes, paths           |
| `libs/harness/gates/test/gc-test-and-decider.test.ts`           | Fully exercised `Schema.TaggedUnion` variants produce zero findings      | Missing test reference for one union variant triggers `untested-union-variant`                        | `it.effect.prop` subset/variant coverage invariant in `GraphGc.decide`       |

---

## 4. Execution & Verification Sequence

1. Run `pnpm harness plan-check` after authoring `stub()` skeletons (if any new exported spans are staged).
2. Implement Units 1–3, remediate any pre-existing violations surfaced by the new gates, set `harness:SPEC-0028` frontmatter to `status: accepted`, and update `docs/specs/README.md`.
3. Format ONLY touched files via `pnpm oxfmt --write <explicit paths>` and confirm `pnpm oxfmt --check <explicit paths>`.
4. Run full deterministic gate sequence with zero edits in between:
   - `pnpm harness learn --clear`
   - `pnpm harness gc --strict`
   - `pnpm harness ontology check --strict`
   - `pnpm harness mutate --strict`
   - `CI=true pnpm harness verify`
   - `CI=true pnpm harness done`
