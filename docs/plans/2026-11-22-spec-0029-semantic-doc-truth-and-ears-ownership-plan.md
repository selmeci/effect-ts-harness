---
title: "SPEC-0029 Implementation Plan: Semantic Documentation Catalog Truth and EARS Effect-Symbol Ownership"
type: feat
status: proposed
date: 2026-11-22
spec: harness:SPEC-0029
---

# Goal

Implement `harness:SPEC-0029` (P2-A of the PR #44 post-mortem harness hardening roadmap) across `@harness/contract`, `@harness/gates`, `@harness/graph`, and `harness-cli`: enforce numeric and nominal documentation truth for canonical MCP tools (`doc-mcp-tool-count-truth`) and CLI subcommands (`doc-cli-command-truth`), validate EARS `Effect Symbol` frontmatter ownership (`spec-source-symbol-ownership`), verify `R = never` purity in `EarsConsistency.decide`, and introduce explicit `status: draft` vs. `status: proposed` backlog lifecycle separation.

---

## 1. Scope & Line-Budget Decomposition Strategy

Existing gate files sit close to file-size limits (`libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`: 726 lines; `libs/harness/gates/src/ears-lint.ts`: 611 lines). Isolate the new catalog doc-truth checks cleanly:

1. `libs/harness/gates/src/plugins/gc/gc-catalog-doc-truth.ts` (`<= 220` lines) — pure helper inspecting markdown files against `CANONICAL_MCP_TOOL_NAMES` and `CliCommandName.literals`, imported by `gc-doc-truth.plugin.ts`.
2. `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts` — extend `GcFindingKind` with `"doc-mcp-tool-count-truth"` and `"doc-cli-command-truth"`.
3. `libs/harness/gates/src/ears-lint.ts` (`<= 660` lines, or helper extract if exceeding threshold) — enforce `spec-source-symbol-ownership` against parsed YAML frontmatter `spans`, `services`, and `errors`.

---

## 2. Effect Building-Block Mapping & Exact File Changes

### Unit 1 & 2 · Canonical Catalog Parity & `gc-catalog-doc-truth.ts` (`REQ-1.1`..`REQ-2.2`)

- **Canonical CLI Catalog in `@harness/contract` (`libs/harness/contract/src/workspace-and-process.ts`, `apps/harness-cli/src/commands/command-registry.ts`):**
  - Export `CANONICAL_CLI_COMMAND_NAMES` directly alongside `CANONICAL_MCP_TOOL_NAMES` and `CliCommandName` in `libs/harness/contract/src/workspace-and-process.ts`, keeping `@harness/gates` strictly within Nx `type:core`/`type:domain` import bounds (`type:contract` only).
  - Have `apps/harness-cli/src/commands/command-registry.ts` derive/verify `CANONICAL_CLI_COMMAND_NAMES` parity with `COMMANDS` at startup/test time so CLI dispatcher and contract catalog never drift.
- **Doc-Truth Catalog Audit (`libs/harness/gates/src/plugins/gc/gc-catalog-doc-truth.ts`, `gc-doc-truth.plugin.ts`, `gc-workspace-io.ts`):**
  - Extend `GcFindingKind` in `gc-workspace-io.ts` with `"doc-mcp-tool-count-truth"` and `"doc-cli-command-truth"`.
  - Implement `auditCatalogDocTruth({ relDoc, content, knownMcpTools, knownCliCommands, findings })` (`gc-catalog-doc-truth.ts`) scanning non-historical live markdown docs (`README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/*.md`, `docs/specs/README.md`, `agent-patterns/**`, `adapters/**/SKILL.md`):
    - Flag numeric MCP tool counts (e.g. `17 MCP tools` != `CANONICAL_MCP_TOOL_NAMES.length`) and unknown backticked `harness_*` tool identifiers with `doc-mcp-tool-count-truth`.
    - Flag `pnpm harness <subcommand>` invocations (ignoring `-*` flags and script variables like `<cmd>`) outside `CANONICAL_CLI_COMMAND_NAMES` or stale CLI subcommand counts with `doc-cli-command-truth`.
  - Wire `auditCatalogDocTruth` into `gc-doc-truth.plugin.ts` inside `GraphGc.decide`.

### Unit 3 · EARS `Effect Symbol` Ownership & `EarsConsistency` Purity (`REQ-3.1`..`REQ-3.3`)

- **Frontmatter Ownership Validation (`libs/harness/gates/src/ears-lint.ts`):**
  - Parse frontmatter `spans`, `services`, and `errors` into an allowed symbol set per spec file.
  - Validate every row in `| ID | Pattern | Requirement | Effect Symbol | Verification |` and emit `spec-source-symbol-ownership` when `Effect Symbol` is absent from frontmatter `spans ∪ services ∪ errors` (exempting legacy specs only if explicitly `superseded`/`deprecated`, failing closed for `proposed` and `accepted`).
  - Verify across all existing `accepted` / `proposed` specs in the repo before enabling strict assertion.
- **Consistency Purity Regression Guard (`libs/harness/gates/src/ears-consistency.ts`):**
  - Confirm `decideEarsConsistency` keeps signature `Effect.fn.Return<EarsConsistencyReport, EarsConsistencyError, never>` and add an explicit compile-time type-level assertion (`const _pureCheck: (i: EarsConsistencyInput) => Effect.Effect<EarsConsistencyReport, EarsConsistencyError, never> = EarsConsistency.decide`) in tests.

### Unit 4 · Backlog `draft` vs. Active `proposed` Lifecycle (`REQ-4.1`..`REQ-4.3`)

- **Schema & Extractor Status Union (`libs/harness/graph/src/model.ts`, `schema.pg`, `gq-static-assets.ts`, `test-and-governance-extractor.ts`, `gc-workspace-io.ts`):**
  - Extend `EarsStatus` and `GovernanceDocStatus` in `libs/harness/graph/src/model.ts` (keeping `AdrStatus` strictly `proposed | accepted | superseded | deprecated` if ADRs do not use `draft`, or aligning `GovernanceDocStatus` cleanly) and update `EarsSpec.status` enum in `schema.pg` + `gq-static-assets.ts` (`draft`, `proposed`, `accepted`, `superseded`, `deprecated`).
  - Update `test-and-governance-extractor.ts` and `gc-workspace-io.ts` so `status: draft` parses cleanly and unknown frontmatter statuses fail closed instead of coercing to `"proposed"`.
- **Selective Gate Enforcement (`libs/harness/graph/src/datalog/stratum-1-and-2-rules.ts`, `policy-check.ts`, `gc-doc-truth.plugin.ts`):**
  - Update `INF-07` (`unmapped-spec-symbol`) in `stratum-1-and-2-rules.ts` (`GraphPolicy.decide`) to skip `EarsSpec` nodes whose `status === "draft"` while keeping full strict enforcement for `status: proposed` and `status: accepted`.
  - Update `gc-doc-truth.plugin.ts` (`GraphGc.decide`) to exempt `status: draft` spec markdown files from `doc-missing-file-path` while retaining full `EarsSpecLint.decide` syntactic validation across `draft`, `proposed`, and `accepted`.
- **Governance Docs & Adapter Parity (`docs/specs/README.md`, `adapters/*/specifying-ears-with-effect/SKILL.md`):**
  - Document `status: draft` (future roadmap backlog) vs. `status: proposed` (single active task ready for Plan-as-Code `stub()` + `harness plan-check`) symmetrically in `docs/specs/README.md` and both Antigravity and Claude Code `specifying-ears-with-effect/SKILL.md` files.

---

## 3. Adversarial, Negative & Mutation Test Matrix

| Target File                                               | Positive Coverage                                                                                    | Negative / Fault Coverage                                                                                      | Property / Determinism Check                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `libs/harness/gates/test/gc-doc-truth.test.ts`            | Valid `CANONICAL_MCP_TOOL_NAMES` counts/names and `CANONICAL_CLI_COMMAND_NAMES` pass                 | Wrong count (`17 MCP tools`), phantom `harness_fake`, or fake `pnpm harness nonexistent` triggers findings     | `it.prop` across generated subsets/permutations of valid vs invalid tool/command docs         |
| `libs/harness/gates/test/gc-ears-and-adr-quality.test.ts` | Spec rows referencing declared frontmatter `spans`/`services`/`errors` pass; `draft` doc-path exempt | Undeclared symbol triggers `spec-source-symbol-ownership`; invalid status fails closed; `R = never` type check | `it.effect.prop` determinism on `EarsSpecLint.decide` & `EarsConsistency.decide`              |
| `libs/harness/graph/test/datalog-engine.test.ts`          | `status: draft` EARS spec with unmapped future spans/services skips `INF-07` cleanly                 | `status: proposed` and `status: accepted` EARS specs with missing spans/services/errors fail `INF-07`          | Deterministic Datalog stratum evaluation across `draft` vs `proposed` vs `accepted` specs     |
| `apps/harness-cli/test/adapter-config.test.ts`            | Live `CANONICAL_CLI_COMMAND_NAMES` matches `command-registry.ts` `COMMANDS` one-to-one               | Simulated missing/extra command triggers mismatch assertion                                                    | Exact set equality assertion between `@harness/contract` and `harness-cli` command registries |

---

## 4. Execution & Verification Sequence

1. Run `pnpm harness plan-check` if any new exported spans are introduced.
2. Implement Units 1–4, set `harness:SPEC-0029` frontmatter to `status: accepted`, and update `docs/specs/README.md`.
3. Format ONLY touched files via `pnpm oxfmt --write <explicit paths>` and confirm `pnpm oxfmt --check <explicit paths>`.
4. Run full deterministic gate sequence with zero edits in between:
   - `pnpm harness learn --clear`
   - `pnpm harness gc --strict`
   - `pnpm harness ontology check --strict`
   - `pnpm harness mutate --strict`
   - `CI=true pnpm harness verify`
   - `CI=true pnpm harness done`
