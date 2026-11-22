---
id: harness:ADR-0023
title: Semantic Documentation Catalog Truth, EARS Ownership, and Backlog Draft Lifecycle
status: accepted
date: 2026-11-22
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/workspace-and-process.ts
  - libs/harness/contract/src/index.ts
  - apps/harness-cli/src/commands/command-registry.ts
  - libs/harness/gates/src/plugins/gc/gc-catalog-doc-truth.ts
  - libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-workspace-io.ts
  - libs/harness/gates/src/ears-lint.ts
  - libs/harness/gates/src/ears-consistency.ts
  - libs/harness/graph/src/model.ts
  - libs/harness/graph/schema.pg
  - libs/harness/graph/src/gq-static-assets.ts
  - libs/harness/graph/src/extractor/governance-doc-parser.ts
  - libs/harness/graph/src/extractor/test-and-governance-extractor.ts
  - libs/harness/graph/src/datalog/datalog-types-and-semiring.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/gates/test/gc-doc-truth.test.ts
  - libs/harness/gates/test/gc-ears-and-adr-quality.test.ts
  - libs/harness/graph/test/datalog-engine.test.ts
  - libs/harness/graph/test/governance-nodes.test.ts
spans:
  - GraphGc.decide
  - EarsSpecLint.decide
  - EarsConsistency.decide
  - GraphPolicy.decide
services: []
errors: []
informs:
  - harness:SPEC-0029
---

# ADR-0023 · Semantic Documentation Catalog Truth, EARS Ownership, and Backlog Draft Lifecycle

## Context and Problem Statement

Post-mortem review of PR #44 identified three governance and documentation drift vectors that syntactic checks alone did not prevent. First, overview documents and adapter READMEs cite hard-coded MCP tool counts, `harness_*` tool identifiers, and `pnpm harness <subcommand>` invocations that could diverge from canonical runtime catalogs without failing package-name or file-path existence checks.

Second, EARS requirement tables checked by `EarsSpecLint.decide` could declare an `Effect Symbol` absent from the spec's YAML frontmatter (`spans`, `services`, `errors`), weakening ArchiMate traceability against `HarnessGraph` nodes while `EarsConsistency.decide` must remain pure (`R = never`). Third, `EarsStatus` and `GovernanceDocStatus` offered no distinct backlog state separating queued multi-wave specs (`draft`) from active single-task Plan-as-Code specifications (`proposed`), forcing queued roadmaps to choose between omitting planned symbols or failing `INF-07` (`unmapped-spec-symbol`) and `doc-missing-file-path`.

## Decision Drivers

- **Contract-Single-Source Catalog Parity Without Tier Leakage:** Derive canonical CLI subcommand names (`CANONICAL_CLI_COMMAND_NAMES`) alongside `CANONICAL_MCP_TOOL_NAMES` in `@harness/contract` so `GraphGc.decide` (`type:core`) checks live markdown documentation without importing `type:app` CLI code.
- **Strict Frontmatter Symbol Ownership With Pure Consistency Checks:** Enforce `spec-source-symbol-ownership` inside `EarsSpecLint.decide` for every non-placeholder requirement `Effect Symbol`, keeping `EarsConsistency.decide` pure at `R = never`.
- **Fail-Closed `status: draft` Backlog Isolation:** Add `draft` to `EarsStatus` and `GovernanceDocStatus` (keeping `AdrStatus` strict), skipping `INF-07` (`unmapped-spec-symbol`) and `doc-missing-file-path` for queued backlog specs while keeping `EarsSpecLint.decide` enabled and failing closed on unknown frontmatter statuses (`invalid-frontmatter-status`, `parseGovernanceDocFileChecked`, `evaluateEffectGraphPolicy`).

## Considered Options

- **Option 1:** Export `CANONICAL_CLI_COMMAND_NAMES` from `@harness/contract`, verify live docs via a dedicated helper `gc-catalog-doc-truth.ts` (`doc-mcp-tool-count-truth`, `doc-cli-command-truth`), validate frontmatter `spans`/`services`/`errors` ownership and valid status in `EarsSpecLint.decide` (`spec-source-symbol-ownership`, `invalid-frontmatter-status`), and support `status: draft` fail-closed across `@harness/graph`, `@harness/gates`, and `@harness/decision`.
- **Option 2:** Leave CLI commands inside `apps/harness-cli` and parse `command-registry.ts` via regex from `@harness/gates`, and overload `status: proposed` for queued multi-wave backlog specs.
- **Option 3:** Enforce catalog parity and symbol ownership only through reviewer skills without deterministic `GraphGc.decide` or `EarsSpecLint.decide` checks.

## Decision Outcome

**Chosen option:** "Option 1: Export `CANONICAL_CLI_COMMAND_NAMES` from `@harness/contract`, add `gc-catalog-doc-truth.ts` and `EarsSpecLint.decide` ownership/status checks, and introduce fail-closed `status: draft` backlog lifecycle support", because single-source typed arrays in `@harness/contract` respect Nx 5-tier isolation and explicit `draft` status preserves zero-exemption Plan-as-Code enforcement on every `proposed` and `accepted` spec.

### Architectural Rules and Guarantees

1. **Canonical CLI & MCP Catalog Parity (`REQ-1.1`..`REQ-2.2`):** `libs/harness/contract/src/workspace-and-process.ts` exports `CANONICAL_CLI_COMMAND_NAMES` alongside `CANONICAL_MCP_TOOL_NAMES` via `libs/harness/contract/src/index.ts`, re-exported by `apps/harness-cli/src/commands/command-registry.ts`. `libs/harness/gates/src/plugins/gc/gc-catalog-doc-truth.ts` (`auditCatalogDocTruthInContent`, `checkCatalogDocTruth`) scans non-historical live docs (prose, `mermaid` blocks, and `pnpm harness <subcmd>` invocations in code fences) and emits `doc-mcp-tool-count-truth` and `doc-cli-command-truth` findings declared in `GcFindingKind` (`gc-workspace-io.ts`) inside `evaluateDocTruthPlugin` (`gc-doc-truth.plugin.ts`).
2. **EARS Ownership & Consistency Purity (`REQ-3.1`..`REQ-3.3`):** `EarsSpecLint.decide` (`ears-lint.ts`) parses frontmatter `status`, `spans`, `services`, and `errors`, emitting `spec-source-symbol-ownership` when a non-placeholder requirement `Effect Symbol` is absent from frontmatter and `invalid-frontmatter-status` when frontmatter status is invalid. `EarsConsistency.decide` (`ears-consistency.ts`) keeps `Effect.fn.Return<EarsConsistencyReport, EarsConsistencyError, never>` (`R = never`).
3. **Fail-Closed `status: draft` Backlog Governance (`REQ-4.1`..`REQ-4.3`):** `EarsStatus` and `GovernanceDocStatus` (`model.ts`, `schema.pg`, `gq-static-assets.ts`) include `"draft"` (`AdrStatus` excludes `"draft"`). `isProposedOrAcceptedSpec` (`datalog-types-and-semiring.ts`) skips `draft` in `INF-07`, `evaluateDocTruthPlugin` (`gc-doc-truth.plugin.ts`) skips `doc-missing-file-path` on `draft` specs via `parseGovernanceDocFrontmatter`, and `parseGovernanceDocFileChecked` / `loadWorkspaceGovernanceDocsWithViolations` (`governance-doc-parser.ts`, re-exported via `test-and-governance-extractor.ts`) plus `evaluateEffectGraphPolicy` (`policy-check.ts`) and `parseGovernanceDocFrontmatterChecked` (`gc-workspace-io.ts`) reject unrecognized or ADR-`draft` statuses fail-closed.

## Rejected Alternatives

### 1 · Option 2: Regex-Parsing CLI Commands From `type:app` & Overloading `proposed`

Scrape `apps/harness-cli` source files from `GraphGc.decide` and keep queued specs at `status: proposed` without a `draft` state.

**Why rejected:** Cross-tier file scraping duplicates contract truth outside `@harness/contract`, and overloading `proposed` breaks `INF-07` (`unmapped-spec-symbol`) whenever future-wave symbols are planned before skeleton creation.

### 2 · Option 3: Review-Only Catalog & Ownership Guidance

Document MCP counts, CLI subcommands, and symbol ownership conventions solely in skill instructions.

**Why rejected:** Documentation and EARS drift occurs incrementally across PRs and cannot be prevented reliably without deterministic CI/local `GraphGc.decide` and `EarsSpecLint.decide` gates.

## Consequences and Enforcement

### Positive Consequences

- Every live guide, overview, and skill document stays synchronized with canonical MCP tool and CLI subcommand registries automatically under `pnpm harness gc --strict`.
- Every active EARS specification binds all requirement rows to declared frontmatter symbols while queued multi-wave backlog specs (`status: draft`) retain full planned contracts cleanly.

### Negative Consequences and Trade-offs

- Adding or renaming any `harness-mcp` tool or `harness` CLI subcommand requires updating `@harness/contract` and affected live documentation in the same change.
- Pure schema/configuration EARS rows without an owning span/service/error must explicitly record `—` in `Effect Symbol` rather than an undeclared symbol name.

### Deterministic Enforcement

| Rule                                                                                                          | Enforced By                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Gate / Mechanism                                                                                                                                                                            | Governed Symbols                                |
| :------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------- |
| Canonical CLI & MCP catalog exports and live doc parity (`doc-mcp-tool-count-truth`, `doc-cli-command-truth`) | `libs/harness/contract/src/workspace-and-process.ts`, `libs/harness/contract/src/index.ts`, `apps/harness-cli/src/commands/command-registry.ts`, `libs/harness/gates/src/plugins/gc/gc-catalog-doc-truth.ts`, `libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts`, `libs/harness/gates/test/gc-doc-truth.test.ts`                                                                                                                                                                                                      | `CANONICAL_CLI_COMMAND_NAMES`, `CANONICAL_MCP_TOOL_NAMES`, `auditCatalogDocTruthInContent`, `checkCatalogDocTruth`, `doc-mcp-tool-count-truth`, `doc-cli-command-truth`                     | `GraphGc.decide`                                |
| EARS `Effect Symbol` ownership, frontmatter status lint, and `R = never` consistency purity                   | `libs/harness/gates/src/ears-lint.ts`, `libs/harness/gates/src/ears-consistency.ts`, `libs/harness/gates/test/gc-ears-and-adr-quality.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                        | `decideEarsSpecQuality` (`spec-source-symbol-ownership`, `invalid-frontmatter-status`) and pure `decideEarsConsistency`                                                                     | `EarsSpecLint.decide`, `EarsConsistency.decide` |
| Backlog `status: draft` lifecycle and fail-closed unknown status rejection                                    | `libs/harness/graph/src/model.ts`, `libs/harness/graph/schema.pg`, `libs/harness/graph/src/gq-static-assets.ts`, `libs/harness/graph/src/extractor/governance-doc-parser.ts`, `libs/harness/graph/src/extractor/test-and-governance-extractor.ts`, `libs/harness/graph/src/datalog/datalog-types-and-semiring.ts`, `libs/harness/graph/src/policy-check.ts`, `libs/harness/gates/src/plugins/gc/gc-doc-truth.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-workspace-io.ts`, `libs/harness/graph/test/datalog-engine.test.ts`, `libs/harness/graph/test/governance-nodes.test.ts` | `EarsStatus`, `parseGovernanceDocFileChecked`, `loadWorkspaceGovernanceDocsWithViolations`, `isProposedOrAcceptedSpec`, `evaluateEffectGraphPolicy`, `parseGovernanceDocFrontmatterChecked` | `GraphPolicy.decide`, `GraphGc.decide`          |
