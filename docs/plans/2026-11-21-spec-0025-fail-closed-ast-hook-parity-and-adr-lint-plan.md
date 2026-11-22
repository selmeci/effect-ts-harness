---
title: "SPEC-0025 Implementation Plan: Fail-Closed AST Guards, Hook Matcher Tool Parity, and Bidirectional ADR Enforcement"
type: feat
status: proposed
date: 2026-11-21
spec: harness:SPEC-0025
---

# Goal

Implement `harness:SPEC-0025` (P0-A of the PR #44 post-mortem harness hardening roadmap) across `@harness/gates`: mechanical `PreToolUse` matcher parity in `GraphGc.decide`, fail-closed interrupt/decode/rollback AST laws across `AstGateCache.decide` and `SelfDogfooding.decide` (including `libs/harness/infra/src/` FS fallback checks), and bidirectional `enforced_by` ↔ `### Deterministic Enforcement` validation in `AdrDocLint.decide`.

---

## 1. Scope & Line-Budget Decomposition Strategy

Existing files in `@harness/gates` are close to the `800`-line hard cap (`gc-doc-truth.plugin.ts`: 726, `adr-lint.ts`: 747, `self-dogfooding-plugin.ts`: 776, `ast-gate-law-helpers.ts`: 786). Rather than growing monoliths past 800 lines or pulling heavy dependencies into the `policy.ts` / `gc-hook-fastpath.ts` closure, extract three cohesive leaf modules:

1. `libs/harness/gates/src/plugins/gc/gc-hook-parity.ts` (`<= 250` lines) — called by `gc-doc-truth.plugin.ts`.
2. `libs/harness/gates/src/plugins/ast-fail-closed-laws.ts` (`<= 250` lines) — called by `ast-gate-visitors.ts` and `self-dogfooding-plugin.ts`, and registered in `AST_GATE_RULE_SOURCE_FILES`.
3. `libs/harness/gates/src/adr-enforcement-table-lint.ts` (`<= 220` lines) — extracted from `adr-lint.ts#L620-L735` so `adr-lint.ts` shrinks cleanly below `650` lines.

All files stay strictly `<= 800` lines post-`oxfmt`, and `policy.ts` / `gc-hook-fastpath.ts` imports remain untouched.

---

## 2. Effect Building-Block Mapping & Exact File Changes

### Unit 1 · Hook Matcher Tool Parity (`REQ-1.1`..`REQ-1.3`)

- **Schema Extension (`libs/harness/gates/src/plugins/gc/gc-workspace-io.ts`):**
  - Add `"hook-matcher-tool-parity"` to `GcFindingKind` (`Schema.Literals([...])`).
- **New Parity Module (`libs/harness/gates/src/plugins/gc/gc-hook-parity.ts`):**
  - Parse `apps/harness-cli/src/commands/hook-guard-payload.ts` via TypeScript AST (`ts.createSourceFile` via `SyncHostIo` read — zero runtime import from `harness-cli` into `@harness/gates`, respecting `HarnessTierTopology.decide`).
  - Extract `READ_ONLY_TOOL_NAMES` plus canonical Antigravity and Claude Code guard tool sets (`ANTIGRAVITY_GUARD_TOOLS`, `CLAUDE_CODE_GUARD_TOOLS`; declare/partition cleanly in `hook-guard-payload.ts` if not already explicitly grouped by adapter so there is one canonical source of truth).
  - Extend local `HookEntrySchema` (`Schema.Struct` with `matcher: Schema.optional(Schema.String)`) and check every entry in `PreToolUse` / `PostToolUse` across `adapters/antigravity/plugins/effect-harness/hooks.json` and `adapters/claude-code/hooks.json`.
  - Verify every tool in the adapter's canonical set matches at least one `PreToolUse` `matcher` pattern (`new RegExp` / `|` alternation tokens), and verify matcher strings documented in `adapters/antigravity/plugins/effect-harness/README.md` and `adapters/claude-code/README.md` match `hooks.json` exactly. Emit `GcFinding` (`kind: "hook-matcher-tool-parity"`) on any gap or drift.
- **Coordinator Wiring (`libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`):**
  - Call `checkHookMatcherToolParity(repoRoot, hostIo, findings)` from `evaluateDocTruthPlugin`.

### Unit 2 · Fail-Closed & Interrupt-Safe AST Laws (`REQ-2.1`..`REQ-2.4`)

- **New AST Detector Module (`libs/harness/gates/src/plugins/ast-fail-closed-laws.ts`):**
  - `isUntypedCatchCauseWithoutInterruptGuard(node, sf)` → rule `untyped-catch-cause-interrupt-leak`: flags `Effect.catchCause` in production `src/` whose callback neither branches on `isPureInterruptCause` nor uses `Effect.catchCauseIf`.
  - `isSilentDecodeOrStoreFallback(node, sf, normPath)` → rule `silent-decode-fallback`: flags `Schema.decodeOption(...) ?? <fallback>` / `Schema.decodeUnknownOption(...) ?? <fallback>` and `Effect.catchTag("WorkflowStoreUnavailableError" | "WriterLeaseHeldError", () => Effect.succeed(...))` in production `src/` (narrow explicit structural exemption for boundary stdin/config optional decoders documented in-module).
  - `isProvisionTapErrorRollback(node, sf)` → rule `provision-tap-error-leak`: inside `provision*` functions (`Effect.fn("...provision...")` or `const provision*`), flags `.pipe(Effect.tapError(...))` rollback cleanup handlers in favor of `Effect.onExit` / `Effect.acquireRelease`.
- **FS Fallback Scope Expansion (`libs/harness/gates/src/plugins/ast-gate-law-helpers.ts`):**
  - Expand `isSilentFsFallbackCheckedPath` (`L34-36`) from `libs/harness/(?:gates|graph)/src` + `apps/harness-(?:cli|mcp)/src` to also include `libs/harness/infra/src/`.
- **Gate Visitors, Self-Dogfooding & Rule Closure (`ast-gate-visitors.ts`, `self-dogfooding-plugin.ts`, `ast-cache.ts`):**
  - Emit `untyped-catch-cause-interrupt-leak` and `silent-decode-fallback` in `ast-gate-visitors.ts` (`pushViolation`), and `provision-tap-error-leak` in `self-dogfooding-plugin.ts` (`SelfDogfoodingRuleId.make(...)`) so `extractGateRuleIdsFromSources` (`gc-rule-ids.ts`) discovers all rule IDs automatically.
  - Append `WorkspaceFilePath.make("libs/harness/gates/src/plugins/ast-fail-closed-laws.ts")` to `AST_GATE_RULE_SOURCE_FILES` (`ast-cache.ts#L89-L99`) to satisfy `checkAstGateRuleClosure` and auto-invalidate cached AST results.
  - Run `pnpm harness gc --strict` across the workspace and fix any newly caught pre-existing violations cleanly in place.

### Unit 3 · Bidirectional ADR Enforcement Lint (`REQ-3.1`..`REQ-3.2`)

- **Table Validation Extraction (`libs/harness/gates/src/adr-enforcement-table-lint.ts`):**
  - Move `### Deterministic Enforcement` parsing and validation out of `adr-lint.ts#L620-L735` into a pure helper returning `{ findings, validTableFound }` (`R = never` preserved).
  - Track `tableReferencedFiles: Set<string>` across all valid data rows; once table parsing completes, emit `adr-enforcement-mismatch` for every file in `declaredEnforcedBy` absent from `tableReferencedFiles`.
- **Coordinator Update & Existing ADR Audit (`libs/harness/gates/src/adr-lint.ts`):**
  - Call the extracted helper inside `AdrDocLint.decide` (`Effect.fn("AdrDocLint.decide")`, `R = never`).
  - Run `pnpm harness gc --strict` across all existing `libs/*/docs/adr/*.md` and `docs/adr/*.md` files and update any ADR enforcement tables missing split helper files listed in their frontmatter `enforced_by`.

---

## 3. Adversarial, Negative & Mutation Test Matrix

| Target File                                               | Positive Coverage                                                     | Negative / Fault Coverage                                                                                                                              | Property / Determinism Check                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `libs/harness/gates/test/gc-hook-parity.test.ts`          | Repo's Antigravity + Claude Code `hooks.json` & `README.md` pass      | Omit single read tool (`read_file`, `LS`), omit write/command tool, or drift `README.md` matcher → asserts finding                                     | `it.prop` permutation over subsets of `READ_ONLY_TOOL_NAMES`                    |
| `libs/harness/gates/test/ast-fail-closed-laws.test.ts`    | `isPureInterruptCause`, `Effect.onExit`, proper `decodeUnknownEffect` | Bare `Effect.catchCause`, `decodeOption ?? []`, `catchTag(..., () => Effect.succeed([]))`, `provision* + tapError`, `infra` `Result.try(readTextSync)` | `it.effect.prop` determinism on `SelfDogfooding.decide` & `AstGateCache.decide` |
| `libs/harness/gates/test/gc-ears-and-adr-quality.test.ts` | Bidirectional parity between `enforced_by` and table succeeds         | Extra `enforced_by` file omitted from table → `adr-enforcement-mismatch`; extra table file omitted from frontmatter → mismatch                         | `it.effect.prop` over arbitrary `enforced_by` / table file sets                 |

---

## 4. Execution & Verification Sequence

1. Run `pnpm harness plan-check` after authoring `stub()` skeletons (if any new exported spans/signatures are staged).
2. Implement Units 1–3 cleanly, resolve any newly flagged violations in workspace source/ADR docs, and set `harness:SPEC-0025` frontmatter `status: accepted`.
3. Format only touched files via `pnpm oxfmt --write <explicit paths>` and confirm `pnpm oxfmt --check <explicit paths>`.
4. Run full deterministic gate sequence with zero edits in between:
   - `pnpm harness learn --clear`
   - `pnpm harness gc --strict`
   - `pnpm harness ontology check --strict`
   - `pnpm harness mutate --strict`
   - `CI=true pnpm harness verify`
   - `CI=true pnpm harness done`
