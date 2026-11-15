---
id: harness:ADR-0011
title: Sub-Second Incremental Harness, Content-Addressable Caching & Latency SLO Architecture
status: accepted
date: 2026-11-09
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/graph/src/type-extractor.ts
  - libs/harness/graph/src/extractor/compiler-session.ts
  - libs/harness/graph/src/extractor/test-and-governance-extractor.ts
  - libs/harness/graph/src/structural-search.ts
  - libs/harness/gates/src/ast-cache.ts
  - libs/harness/gates/src/plugins/ast-gate-visitors.ts
  - libs/harness/gates/src/migration-check.ts
  - libs/harness/gates/src/bench-check.ts
  - libs/harness/decision/src/cached-decision-model.ts
  - apps/harness-mcp/src/server.ts
spans:
  - TypeExtractor.extractWorkspace
  - StructuralSearch.decide
  - AstGateCache.decide
  - SyntaxBans.decide
  - TestIntegrity.decide
  - MigrationSafety.decide
  - DomainPurity.decide
  - EffectLaws.decide
  - CachedDecisionModel.lookup
  - HarnessBench.decide
services: []
errors:
  - LatencySloViolationError
informs:
  - harness:SPEC-0010
---

# ADR-0011 · Sub-Second Incremental Harness, Content-Addressable Caching & Latency SLO Architecture

## Context and Problem Statement

Every agentic iteration through the Effect-TS Engineering Harness (`plan-check`, `gc --strict`, `verify`, and MCP queries such as `harness_tests_reaching` and `harness_lsp_diagnostics`) previously executed cold full-workspace TypeScript `ts-morph` compilation ($2.6\text{ s}$), nested $O(|T| \times |F|)$ regex test-reachability scanning ($450\text{ ms}$), duplicate AST gate traversals, uncached `DecisionModel` HTTP calls, and cold CLI process initialization (`RFC-0006`). How do we reduce incremental inner-loop verification and graph queries from $3.5\text{–}15\text{ s}$ to sub-second latency while preserving 100% deterministic soundness and zero-stale-cache guarantees?

## Decision Drivers

- **Sub-Second Inner Loop (`RFC-0006`):** Warm single-file incremental graph extraction, Datalog delta stepping, and AST gate evaluation must execute in $< 150\text{ ms}$ combined.
- **Zero Stale Reads (Cryptographic Content Addressing):** Every cache entry (`FileGraphFragment`, `AstGateCacheEntry`, `CachedDecisionEntry`) must be keyed by SHA-256 content hashes, declaration-signature fingerprints (`declHash`), and rule/prompt version strings so edits immediately invalidate affected entries.
- **Declaration-Signature Early Cut-Off (`PERF-01`):** When an implementation body changes without altering exported type/declaration signatures (`declHash(f_new) === declHash(f_old)`), downstream callers in the 1-hop reverse-import cone do not need hyperedge re-extraction.
- **Single-Pass AST Gate Fusion (`PERF-02`):** `SyntaxBans.decide`, `TestIntegrity.decide`, `MigrationSafety.decide`, `DomainPurity.decide`, and `EffectLaws.decide` must share a unified single-pass AST visitor and content-addressable disk cache (`.harness/cache/ast-gates-v1.json`).
- **Deterministic Latency SLO Gate (`PERF-06`):** Latency regressions must be caught by a pure `HarnessBench.decide` (`R = never`) decider evaluating `StageLatencyMeasurement` against `StageLatencyBudget` (`p50BudgetMs`, `p95BudgetMs`) and failing with `LatencySloViolationError`.

## Considered Options

- **Option 1: Incremental Content-Addressable Caching + Declaration Early Cut-Off + Unified AST Gate Cache + `CachedDecisionModel` + `HarnessBench.decide` (`RFC-0006` Architecture).** Combine a warm `TypeScriptProgramSession` (`ts.createProgram` reuse + `declHash` early cut-off + $O(|T| + |F|)$ token index), single-pass `AstGateCache` persisted in `.harness/cache/ast-gates-v1.json`, content-addressable `CachedDecisionModel` with concurrent request coalescing in `.harness/cache/decisions-v1.json`, optional Unix domain socket daemon delegation (`.harness/daemon.sock`), and `HarnessBench.decide` SLO enforcement.
- **Option 2: Timestamp (`mtime`) File Caching Only.** Cache whole-workspace snapshots keyed by file modification timestamps without declaration-signature early cut-off or per-file AST/decision content addressing.
- **Option 3: External Build Cache Only (Nx Task Cache Without In-Memory AST/Datalog Incrementality).** Rely exclusively on coarse-grained Nx subprocess caching without optimizing `extractWorkspaceTypeAwareGraph`, AST gates, or `DecisionModel` calls.

## Decision Outcome

Chosen option: **Option 1 (Incremental Content-Addressable Caching + Declaration Early Cut-Off + Unified AST Gate Cache + `CachedDecisionModel` + `HarnessBench.decide`)**, because it eliminates every measured bottleneck in `RFC-0006` while guaranteeing cryptographic cache soundness across git branch switches, worktrees, and concurrent agent fibers.

## Rejected Alternatives

### 1 · Timestamp (`mtime`) File Caching Only

Cache whole-workspace snapshots keyed only by filesystem `mtime` values without content hashing or declaration-signature cut-off.

**Why rejected:** Filesystem `mtime` timestamps are unsound across `git checkout`, `git stash`, and rebase operations where `mtime` can drift from content changes, and `mtime` cannot detect when an implementation edit leaves exported declaration signatures (`declHash`) unchanged.

### 2 · External Build Cache Only

Rely exclusively on Nx task-level caching without per-file `FileGraphFragment`, `AstGateCache`, or `CachedDecisionModel` memoization.

**Why rejected:** Coarse-grained task caching does not accelerate interactive MCP graph queries (`harness_tests_reaching`, `harness_lsp_diagnostics`), incremental Datalog delta stepping, or repeated System One `DecisionModel` evaluations during active editing.

## Consequences and Enforcement

### Positive Consequences

- Warm `extractTypeGraph` / `extractWorkspaceTypeAwareGraph` with `overlays` or unchanged `declHash` reuses `ts.Program` and cached `FileGraphFragment`s in milliseconds.
- `AstGateCache` parses each modified file at most once and serves unchanged files from `.harness/cache/ast-gates-v1.json` in $< 5\text{ ms}$.
- `CachedDecisionModel` eliminates redundant LLM forward passes for identical `(taskId, promptVersion, canonicalJson(input))` tuples and coalesces concurrent identical fiber requests.
- `HarnessBench.decide` provides a mathematically pure (`R = never`), property-tested gate enforcing stage `p50` and `p95` latency budgets.

### Negative Consequences and Trade-offs

- Cache schema versions (`HARNESS_GATE_RULE_VERSION`, `HARNESS_DECISION_PROMPT_VERSION`, `HARNESS_FILE_GRAPH_CACHE_VERSION`) must be bumped whenever gate rules or extraction semantics change.
- Daemon socket delegation (`.harness/daemon.sock`) requires clean fallback to in-process execution when no daemon is listening or when the socket is stale.

### Deterministic Enforcement

| Rule                                                                                                               | Enforced By                                                                        | Gate / Mechanism                                   | Governed Symbols                                                                                                                         |
| :----------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- | :------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| Warm `TypeScriptProgramSession`, `declHash` early cut-off, and $O(\|T\| + \|F\|)$ token reachability               | `libs/harness/graph/src/type-extractor.ts`, `libs/harness/graph/src/extractor/compiler-session.ts`, `libs/harness/graph/src/extractor/test-and-governance-extractor.ts`                                         | `pnpm harness verify` & `pnpm harness bench`       | `TypeExtractor.extractWorkspace`                                                                                                         |
| Scoped AST and line-locator search across TypeScript and governance/SQL/JSON files with path-traversal containment | `libs/harness/graph/src/structural-search.ts`, `apps/harness-mcp/src/server.ts`    | `pnpm harness gc --strict` & `pnpm harness verify` | `StructuralSearch.decide`                                                                                                                |
| Unified single-pass AST gate visitor and content-addressable `.harness/cache/ast-gates-v1.json` cache              | `libs/harness/gates/src/ast-cache.ts`, `libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `libs/harness/gates/src/migration-check.ts` | `pnpm harness gc --strict` & `pnpm harness verify` | `AstGateCache.decide`, `SyntaxBans.decide`, `TestIntegrity.decide`, `MigrationSafety.decide`, `DomainPurity.decide`, `EffectLaws.decide` |
| Content-addressable `DecisionModel` memoization and concurrent request coalescing                                  | `libs/harness/decision/src/cached-decision-model.ts`                               | `pnpm harness verify`                              | `CachedDecisionModel.lookup`                                                                                                             |
| Stage latency `p50` and `p95` SLO budget verification                                                              | `libs/harness/gates/src/bench-check.ts`                                            | `pnpm harness bench` & `pnpm harness verify`       | `HarnessBench.decide`, `LatencySloViolationError`                                                                                        |
