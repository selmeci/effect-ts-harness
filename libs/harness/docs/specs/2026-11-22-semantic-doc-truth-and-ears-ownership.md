---
id: harness:SPEC-0029
title: Semantic Documentation Catalog Truth and EARS Effect-Symbol Ownership
status: accepted
archetype: framework
date: 2026-11-22
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0023
enforced_by:
  - libs/harness/contract/src/workspace-and-process.ts
  - libs/harness/contract/src/index.ts
  - libs/harness/gates/src/plugins/gc/gc-catalog-doc-truth.ts
  - libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-governance-docs.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-workspace-io.ts
  - libs/harness/gates/src/ears-lint.ts
  - libs/harness/gates/src/ears-consistency.ts
  - libs/harness/gates/src/ontology-invariants.ts
  - libs/harness/decision/src/ontology-conflict-decision.ts
  - apps/harness-cli/src/commands/command-registry.ts
  - apps/harness-cli/test/command-registry.test.ts
  - libs/harness/gates/test/gc-doc-truth.test.ts
  - libs/harness/gates/test/gc-ears-and-adr-quality.test.ts
  - libs/harness/gates/test/gc-handoff-budget.test.ts
  - libs/harness/graph/src/model.ts
  - libs/harness/graph/schema.pg
  - libs/harness/graph/src/gq-static-assets.ts
  - libs/harness/graph/src/type-extractor.ts
  - libs/harness/graph/src/extractor/governance-doc-parser.ts
  - libs/harness/graph/src/extractor/test-and-governance-extractor.ts
  - libs/harness/graph/src/datalog/datalog-types-and-semiring.ts
  - libs/harness/graph/src/rewrite/dpo-algebra-core.ts
  - libs/harness/graph/src/rewrite/plan-rules.plugin.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/graph/test/datalog-engine.test.ts
  - libs/harness/graph/test/governance-nodes.test.ts
  - docs/specs/README.md
  - adapters/antigravity/plugins/effect-harness/skills/specifying-ears-with-effect/SKILL.md
  - adapters/claude-code/skills/specifying-ears-with-effect/SKILL.md
spans:
  - GraphGc.decide
  - EarsSpecLint.decide
  - EarsConsistency.decide
  - GraphPolicy.decide
services: []
errors: []
---

## Context

Post-mortem review of PR #44 uncovered recurring semantic drift vectors between live harness contracts and markdown documentation that purely syntactic checks in `gc-doc-truth.plugin.ts` (`doc-unknown-package-name`, `doc-unknown-rule-id`, `doc-missing-file-path`) could not detect. Overview documents (`README.md`, `AGENTS.md`, `CLAUDE.md`, skill files) state hard-coded MCP tool counts and `harness_*` tool lists that must stay synchronized with `CANONICAL_MCP_TOOL_NAMES` in `libs/harness/contract/src/workspace-and-process.ts`, as well as documented `pnpm harness <subcommand>` invocations that must align with `CliCommandName` and `CANONICAL_CLI_COMMAND_NAMES`.

Second, EARS specifications validated by `EarsSpecLint.decide` (`libs/harness/gates/src/ears-lint.ts`) require strict parity between requirement-table `Effect Symbol` cells and the spec's own YAML frontmatter (`spans`, `services`, `errors`) alongside `EarsConsistency.decide` (`libs/harness/gates/src/ears-consistency.ts`) `R = never` purity guarantees. Third, `EarsStatus` and `GovernanceDocStatus` require an explicit backlog state (`draft`) separating queued multi-wave roadmaps from active single-task `proposed` Plan-as-Code contracts validated under `INF-07` (`unmapped-spec-symbol`) and `doc-missing-file-path`.

- **Reused Contracts / Errors:** `CANONICAL_MCP_TOOL_NAMES`, `CliCommandName` from `@harness/contract`; `GcFinding`, `GcFindingKind` from `@harness/gates`; `EarsStatus`, `GovernanceDocStatus` from `@harness/graph`
- **Reused Services:** `SyncHostIo` from `@harness/service/host-io`
- **New Capabilities Needed:** Canonical CLI command list export in `workspace-and-process.ts` mirrored by `command-registry.ts`, pure documentation catalog truth helper (`gc-catalog-doc-truth.ts`) emitting `doc-mcp-tool-count-truth` and `doc-cli-command-truth` findings in `GraphGc.decide`, frontmatter symbol-ownership validation (`spec-source-symbol-ownership`) in `EarsSpecLint.decide` alongside `R = never` purity in `EarsConsistency.decide`, and explicit `status: draft` backlog lifecycle support across `model.ts`, `schema.pg`, `gq-static-assets.ts`, `test-and-governance-extractor.ts`, `gc-workspace-io.ts`, `stratum-1-and-2-rules.ts`, `GraphPolicy.decide`, and `GraphGc.decide`

## Goal

Every live harness overview, guide, and skill markdown file agrees numerically and nominally with canonical `@harness/contract` MCP tool and CLI subcommand catalogs under `GraphGc.decide`, every EARS requirement row maps strictly to an `Effect Symbol` declared in its specification's frontmatter while keeping `EarsConsistency.decide` pure (`R = never`), and multi-wave backlog specifications (`status: draft`) record full planned `spans`, `services`, `errors`, and paths cleanly without relaxing active `status: proposed` Plan-as-Code enforcement.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · MCP Tool Count and Catalog Parity Truth

**Source (`libs/harness/contract/src/workspace-and-process.ts`, `libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts`):** Pure catalog parity logic in `gc-catalog-doc-truth.ts` cross-checks live documentation MCP tool counts and `harness_*` tool identifiers against `CANONICAL_MCP_TOOL_NAMES`.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                    | Effect Symbol  | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------ |
| REQ-1.1 | Event-driven       | **When** `GraphGc.decide` audits non-historical markdown documentation containing numeric MCP tool-count claims or backticked `harness_*` tool listings, `gc-catalog-doc-truth.ts` **shall** validate every count and tool name against `CANONICAL_MCP_TOOL_NAMES`.            | GraphGc.decide | UnitTest     |
| REQ-1.2 | Unwanted behaviour | **If** a live markdown document states an MCP tool count unequal to `CANONICAL_MCP_TOOL_NAMES.length` or cites a backticked `harness_*` tool identifier absent from `CANONICAL_MCP_TOOL_NAMES`, **then** `GraphGc.decide` **shall** emit a `doc-mcp-tool-count-truth` finding. | GraphGc.decide | UnitTest     |

### 2 · CLI Subcommand Documentation Parity Truth

**Source (`libs/harness/contract/src/workspace-and-process.ts`, `apps/harness-cli/src/commands/command-registry.ts`, `libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts`):** Canonical CLI command truth derives from `@harness/contract` so `@harness/gates` preserves Nx tier isolation (`type:core` never imports `type:app`).

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                      | Effect Symbol  | Verification |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------ |
| REQ-2.1 | Event-driven       | **When** `GraphGc.decide` audits live markdown documentation referencing `pnpm harness <subcommand>` commands or CLI command inventory counts, `gc-catalog-doc-truth.ts` **shall** validate every command token against the canonical CLI subcommand set in `@harness/contract`. | GraphGc.decide | UnitTest     |
| REQ-2.2 | Unwanted behaviour | **If** a live markdown document cites a `pnpm harness <subcommand>` token outside the canonical `@harness/contract` CLI subcommand set or states an outdated CLI subcommand count, **then** `GraphGc.decide` **shall** emit a `doc-cli-command-truth` finding.                   | GraphGc.decide | UnitTest     |

### 3 · EARS Effect-Symbol Frontmatter Ownership and Consistency Purity

**Source (`libs/harness/gates/src/ears-lint.ts`, `libs/harness/gates/src/ears-consistency.ts`):** Every EARS requirement clause binds transparently to an owned frontmatter symbol without introducing impure service dependencies into deterministic EARS consistency evaluation.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                 | Effect Symbol          | Verification |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------ |
| REQ-3.1 | Event-driven       | **When** `EarsSpecLint.decide` lints an EARS specification's requirement tables against its YAML frontmatter, `EarsSpecLint.decide` **shall** verify that every row's `Effect Symbol` matches a symbol listed in that specification's `spans`, `services`, or `errors` frontmatter array.                   | EarsSpecLint.decide    | UnitTest     |
| REQ-3.2 | Unwanted behaviour | **If** an EARS requirement row specifies an `Effect Symbol` absent from the specification's `spans`, `services`, and `errors` arrays, **then** `EarsSpecLint.decide` **shall** emit a blocking `spec-source-symbol-ownership` diagnostic naming the row ID and missing symbol.                              | EarsSpecLint.decide    | UnitTest     |
| REQ-3.3 | Unwanted behaviour | **If** `EarsConsistency.decide` introduces non-empty service dependencies into its `Effect.fn` return type, **then** `EarsConsistency.decide` **shall** fail graph verification so consistency evaluation preserves pure `R = never` (`Effect.Effect<EarsConsistencyReport, EarsConsistencyError, never>`). | EarsConsistency.decide | GraphCheck   |

### 4 · Backlog Draft vs. Active Proposed EARS Lifecycle Governance

**Source (`libs/harness/graph/src/model.ts`, `libs/harness/graph/schema.pg`, `libs/harness/graph/src/datalog/stratum-1-and-2-rules.ts`, `libs/harness/graph/src/policy-check.ts`, `libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`, `libs/harness/gates/src/ears-lint.ts`, `docs/specs/README.md`):** Distinguishes multi-wave backlog proposals (`status: draft`) from active single-task Plan-as-Code contracts (`status: proposed`) so gates never force agents to omit future `spans`, `services`, or `errors` when recording a roadmap.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                           | Effect Symbol       | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------ |
| REQ-4.1 | Event-driven       | **When** `GraphPolicy.decide` evaluates `INF-07` (`unmapped-spec-symbol`) across workspace `EarsSpec` nodes, `GraphPolicy.decide` **shall** skip `status: draft` backlog specifications while strictly enforcing 1:1 `spans`, `services`, and `errors` existence for every `status: proposed` and `status: accepted` specification.   | GraphPolicy.decide  | UnitTest     |
| REQ-4.2 | Event-driven       | **When** `GraphGc.decide` audits specification markdown files, `GraphGc.decide` **shall** exempt `status: draft` backlog specifications from `doc-missing-file-path` while continuing to enforce full `EarsSpecLint.decide` syntactic validation across `draft`, `proposed`, and `accepted` specifications.                           | GraphGc.decide      | UnitTest     |
| REQ-4.3 | Unwanted behaviour | **If** an EARS specification carries `status: proposed` or `status: accepted` with unmapped frontmatter symbols or carries an unrecognized frontmatter status outside `EarsStatus`, **then** `EarsSpecLint.decide` and `GraphPolicy.decide` **shall** fail closed so backlog drafts cannot silently bypass Plan-as-Code verification. | EarsSpecLint.decide | UnitTest     |

## Assumptions

- Dated design changelogs under `docs/plans/` and dated historical `docs/specs/` files outside active top-level guides/skill docs can mention past tool counts historically without triggering retroactive `doc-mcp-tool-count-truth` or `doc-cli-command-truth` churn unless they explicitly assert current workspace totals.
- Canonical CLI subcommand names live in `@harness/contract` (`CliCommandName`) and match `command-registry.ts` in `harness-cli` one-to-one.
- Promotion from `status: draft` to `status: proposed` occurs only when an EARS specification enters active Plan-as-Code skeleton creation (`stub<A, E, R>()` + `pnpm harness plan-check`).

## Out of scope

- Natural-language grammar linting or multi-language translation checking outside backticked `harness_*` tool tokens, `pnpm harness <subcommand>` invocations, and numeric tool/command counts.
- Automated rewriting of stale markdown files (gates fail fast with exact file locations and actionable replacement guidance).

## Known residual risks

- Unformatted prose phrasing of tool counts without digits or recognized `MCP tools` / `CLI commands` anchors may evade regex extraction if authors invent non-standard wording.

## Acceptance criteria

- `GraphGc.decide` detects fabricated or stale MCP tool counts, unknown `harness_*` tool names, and unknown `pnpm harness <subcommand>` references in live documentation while keeping `gc-doc-truth.plugin.ts` line-budget compliant via `gc-catalog-doc-truth.ts`.
- `EarsSpecLint.decide` rejects undeclared `Effect Symbol` references (`spec-source-symbol-ownership`) and invalid frontmatter statuses, while `EarsConsistency.decide` retains zero `R` service requirements (`R = never`).
- `EarsStatus` / `GovernanceDocStatus` supports `status: draft` for backlog specs (exempt from `INF-07` `unmapped-spec-symbol` and `doc-missing-file-path`, still checked by `EarsSpecLint.decide`) while `status: proposed` and `status: accepted` remain strictly mapped 1:1 to `HarnessGraph` symbols across `GraphPolicy.decide` and `GraphGc.decide`.
- `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, and `pnpm harness mutate --strict` pass cleanly across all touched modules and new unit/property tests in `libs/harness/gates/test/gc-doc-truth.test.ts`, `libs/harness/gates/test/gc-ears-and-adr-quality.test.ts`, and `libs/harness/graph/test/datalog-engine.test.ts`.
