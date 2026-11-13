---
id: harness:ADR-0012
title: Self-Dogfooding Enforcement & Cordis-Inspired Effect-TS v4 Capability Plugin Harness
status: accepted
date: 2026-11-12
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/gates/src/plugins/self-dogfooding-contract.ts
  - libs/harness/gates/src/plugins/self-dogfooding-plugin.ts
  - libs/harness/gates/src/plugins/gate-plugin-registry.ts
  - libs/harness/gates/src/plugins/ast-gate-visitors.ts
  - libs/harness/gates/src/plugins/gc/gc-helpers.ts
  - libs/harness/gates/src/plugins/gc/gc-topology-entropy.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-governance-docs.plugin.ts
  - libs/harness/gates/src/plugins/gc/gc-package-and-migration.plugin.ts
  - libs/harness/gates/src/mutation/mutant-ast-generator.ts
  - libs/harness/gates/src/mutation-check.ts
  - libs/harness/gates/src/services/workspace-fs.ts
  - libs/harness/gates/src/services/subprocess-runner.ts
  - libs/harness/gates/src/services/active-mutant-context.ts
  - libs/harness/gates/src/ast-cache.ts
  - libs/harness/gates/src/gc-check.ts
  - libs/harness/graph/src/index.ts
  - libs/harness/graph/src/model.ts
  - libs/harness/graph/src/model-rewrite-and-cache.ts
  - libs/harness/graph/src/omnigraph-sync.ts
  - libs/harness/graph/src/structural-search.ts
  - libs/harness/graph/src/pattern-index.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/graph/src/archimate-ontology.ts
  - libs/harness/graph/src/gq-queries.ts
  - libs/harness/graph/src/cluster-resolver.ts
  - libs/harness/graph/src/concept-lattice.ts
  - libs/harness/graph/src/type-extractor.ts
  - libs/harness/graph/src/datalog-engine.ts
  - libs/harness/graph/src/graph-rewrite.ts
  - libs/harness/graph/src/graph-engine.ts
  - libs/harness/graph/src/graph-projector.ts
  - libs/harness/graph/src/extractor/extractor-types-and-helpers.ts
  - libs/harness/graph/src/extractor/compiler-session.ts
  - libs/harness/graph/src/extractor/ast-policy-extractor.ts
  - libs/harness/graph/src/extractor/schema-and-brand-extractor.ts
  - libs/harness/graph/src/extractor/service-and-layer-extractor.ts
  - libs/harness/graph/src/extractor/effect-fn-extractor.ts
  - libs/harness/graph/src/extractor/decider-reducer-extractor.ts
  - libs/harness/graph/src/extractor/test-and-governance-extractor.ts
  - libs/harness/graph/src/datalog/datalog-types-and-semiring.ts
  - libs/harness/graph/src/datalog/stratum-1-and-2-rules.ts
  - libs/harness/graph/src/datalog/stratum-3-completion-and-holes.ts
  - libs/harness/graph/src/datalog/datalog-session.ts
  - libs/harness/graph/src/rewrite/dpo-algebra-core.ts
  - libs/harness/graph/src/rewrite/plan-rules.plugin.ts
  - libs/harness/graph/src/rewrite/repair-rules-arch.plugin.ts
  - libs/harness/graph/src/rewrite/repair-rules-code.plugin.ts
  - libs/harness/graph/src/engine/hypergraph-store.ts
  - libs/harness/graph/src/engine/traversal-queries.ts
  - libs/harness/graph/src/engine/snapshot-codec.ts
  - libs/harness/graph/src/engine/graph-diff-monomorphism.ts
  - libs/harness/graph/src/projector/skeleton-templates.ts
  - libs/harness/graph/src/projector/ast-codemods.ts
  - libs/harness/graph/src/projector/shadow-bisection-verifier.ts
  - libs/harness/graph/src/services/ts-compiler-overlay-service.ts
  - apps/harness-cli/src/commands/command-registry.ts
  - apps/harness-mcp/src/tools/tool-registry.ts
spans:
  - SelfDogfooding.decide
  - GatePluginRunner.evaluateAll
  - WorkspaceFs.readAndVerifyFile
  - HarnessSubprocess.execChecked
  - MutationCheck.withActiveMutant
  - TsCompilerOverlay.extractGraph
  - HarnessCli.dispatchCommand
  - HarnessMcp.dispatchTool
services:
  - "@harness/gates/WorkspaceFs"
  - "@harness/gates/HarnessSubprocessRunner"
  - "@harness/gates/ActiveMutantContext"
  - "@harness/gates/GatePluginRegistry"
  - "@harness/graph/TsCompilerOverlayService"
  - "harness-cli/HarnessCommandRegistry"
  - "harness-mcp/McpToolRegistry"
errors:
  - SelfDogfoodingViolationError
  - WorkspaceFsError
  - HarnessSubprocessError
  - TsCompilerOverlayError
  - CliCommandNotFoundError
  - UnknownToolError
informs:
  - harness:SPEC-0011
---

# ADR-0012 · Self-Dogfooding Enforcement & Cordis-Inspired Effect-TS v4 Capability Plugin Harness

## Context and Problem Statement

While the Effect-TS Engineering Harness enforced strict architectural invariants (`Schema.brand`, `ts-pattern` exhaustive matching, pure `*.decide` functions with `R = never`, and fine-grained `Context.Service` + `Layer` Dependency Injection) on application and framework domains (`libs/sample/*`, `libs/es/*`), the harness packages themselves (`libs/harness/*`, `apps/harness-*`) were historically exempted from those rules via `isHarnessInternal` checks (`RFC-0007`). As a result, harness modules accumulated imperative `Effect.fn` wrappers with `R = never` and dummy `yield* Effect.void` statements, nested `Effect.runSync` calls inside `Effect.sync` and `Layer.effect`, manual parameter threading instead of `Context.Service` layers, `switch` statements in CLI/MCP routers, and monolithic god-files exceeding 1,500–5,600 lines.

Leaving this architectural double standard unresolved undermines the credibility of the harness as a reference Effect-TS v4 codebase, prevents unit testing of harness capabilities with in-memory test `Layer`s, risks resource leaks from unscoped module-level caches, and makes adding new gates, CLI commands, or MCP tools error-prone.

## Decision Drivers

- **Zero Double Standard (Self-Dogfooding):** Harness source files (`libs/harness/*`, `apps/harness-*`) must obey the same bans on `switch` statements, `match().run()`, dummy `yield* Effect.void` statements, and nested `Effect.runSync` inside Effect constructors as domain code.
- **Cordis-Inspired Three-Role Capability Seams in Effect-TS v4:** Every stateful or I/O capability in the harness (filesystem access, subprocess execution, active mutant state, gate plugin registration, TypeScript compiler sessions, CLI command routing, and MCP tool routing) must be modeled via the Three-Role pattern: a `Context.Service` definition, a `Layer` / `Layer.effect` provider (`Effect.acquireRelease`), and `Effect.fn` consumers declaring the service in `R`.
- **Modular Plugin Decomposition (`<= 800` Line Deterministic Ceiling, `<= 250` / `<= 750` RFC-0007 Targets):** New and decomposed plugin, service, mutation, command, tool, gates, and `@harness/graph` modules matched by `isModularPluginPath` (`/plugins/`, `/services/`, `/mutation/`, `/commands/`, `/tools/`, `libs/harness/gates/src/**/*.ts`, `libs/harness/graph/src/**/*.ts`) cannot opt out via `isModularPluginFile: false` and must remain under the deterministic `MaxPluginFileLines = 800` ceiling (`file-line-budget-exceeded`), while RFC-0007 targets `<= 250` lines for the 5 `@harness/graph` orchestrators (`< 500` for sub-extractors, `<= 700` for `compiler-session.ts` and `engine/*`, `<= 750` for other submodules) and keeps canonical `enforced_by` paths and span names intact for `ADR-0001..0011` and `SPEC-0001..0010`.

## Considered Options

- **Option 1: Cordis-Inspired Effect-TS v4 Capability Plugin Architecture + `SelfDogfooding.decide` Gate (`RFC-0007`).** Introduce explicit `Context.Service` + `Layer` capability seams (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`, `GatePluginRegistry`, `TsCompilerOverlayService`, `HarnessCommandRegistry`, `McpToolRegistry`), eliminate all `yield* Effect.void`, nested `Effect.runSync`, and `switch` statements across the harness, remove `!isHarnessInternal` exemptions on `SwitchStatement` and `match().run()` in `AstGateCache.decide`, and enforce `effect-fn-dummy-void`, `nested-effect-run-sync`, `harness-switch-statement`, `match-run-statement`, and path-scoped `file-line-budget-exceeded` via `SelfDogfooding.decide` and `GraphGc.decide`.
- **Option 2: Retain `isHarnessInternal` Exemptions and Imperative Helper Scripts.** Keep the harness as a set of imperative TypeScript scripts wrapped in `Effect.fn` with `R = never` and exempt `libs/harness/*` and `apps/harness-*` from Effect-TS v4 syntax and architectural gates.
- **Option 3: Dynamic Untyped Runtime Plugin Loader (`import()` String Paths).** Replace static module imports with a runtime string-based plugin loader modeled directly on JavaScript monkey-patching without Effect `Context.Service` or `Layer` type safety.

## Decision Outcome

**Chosen option:** "Option 1: Cordis-Inspired Effect-TS v4 Capability Plugin Architecture + `SelfDogfooding.decide` Gate (`RFC-0007`)", because it aligns the harness with idiomatic Effect-TS v4 Dependency Injection, guarantees scoped resource cleanup via `Layer.effect` + `Effect.acquireRelease`, enables fast in-memory test `Layer`s for harness subsystems, and enforces self-dogfooding deterministically on every `pnpm harness gc --strict` and `pnpm harness verify` run.

## Rejected Alternatives

### 1 · Retain `isHarnessInternal` Exemptions and Imperative Helper Scripts

Continue exempting `libs/harness/*` and `apps/harness-*` from Effect-TS v4 rules and keep `Effect.fn` wrappers with `R = never` and `yield* Effect.void`.

**Why rejected:** Exempting the harness from its own standards creates broken-windows technical debt, prevents swapping filesystem or subprocess layers in unit tests, and leaks unscoped global mutable state across concurrent fibers.

### 2 · Dynamic Untyped Runtime Plugin Loader (`import()` String Paths)

Load gate, CLI, and MCP plugins dynamically at runtime via string-based `import()` calls and untyped event emitters.

**Why rejected:** Dynamic untyped plugin loading erases compile-time `R` and `E` channels, blinds `TypeExtractor.extractWorkspace` (`HarnessGraph` static analysis), and weakens Trusted Computing Base (TCB) integrity.

## Consequences and Enforcement

### Positive Consequences

- Every harness capability (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`, `GatePluginRegistry`, `TsCompilerOverlayService`, `HarnessCommandRegistry`, `McpToolRegistry`) is a typed `Context.Service` with a verified `ServiceLayer` (`ProvidesService`) and traced `Effect.fn` consumers (`RequiresService`).
- All 15 dummy `yield* Effect.void` statements, all 4 `switch` statements in harness source files, and nested `Effect.runSync` calls inside `Effect.sync` / `Layer.effect` are eliminated.
- `SelfDogfooding.decide` and `AstGateCache.decide` prevent regressions across the entire repository.

### Negative Consequences and Trade-offs

- Every new `Context.Service` added to `libs/harness/*` or `apps/harness-*` must be paired with an exported `Layer` provider and at least one `Effect.fn` consumer so `GraphGc.decide` (`unused-service`, `unprovided-service`) passes.
- Bump of `HARNESS_GATE_RULE_VERSION` (`"ast-gates-v2"`) invalidates cached entries stored inside `.harness/cache/ast-gates-v1.json` once on upgrade so `effect-fn-dummy-void`, `switch-statement`, and `match-run-statement` are re-evaluated across all files.

### Deterministic Enforcement

| Rule                                                                                                                   | Enforced By                                                                                                                    | Gate / Mechanism                                   | Governed Symbols                                                                                                                                                              |
| :--------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure self-dogfooding AST/source decider (`effect-fn-dummy-void`, `nested-effect-run-sync`, `harness-switch-statement`, `match-run-statement`, `file-line-budget-exceeded` across `libs/harness/gates/src/**`, `libs/harness/graph/src/**`, and modular plugin directories; `isModularPluginPath` overrides `isModularPluginFile: false`) | `libs/harness/gates/src/plugins/self-dogfooding-contract.ts`, `libs/harness/gates/src/plugins/self-dogfooding-plugin.ts`, `libs/harness/gates/src/gc-check.ts`, `libs/harness/gates/src/plugins/gc/gc-helpers.ts`, `libs/harness/gates/src/plugins/gc/gc-topology-entropy.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-test-and-decider.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-governance-docs.plugin.ts`, `libs/harness/gates/src/plugins/gc/gc-package-and-migration.plugin.ts`, and all 40 `@harness/graph` source modules listed in `enforced_by` | `SelfDogfooding.decide` in `pnpm harness gc --strict` & `pnpm harness verify` | `SelfDogfooding.decide`, `SelfDogfoodingViolationError`                                                                                                                       |
| Removal of `isHarnessInternal` `switch` and `match().run()` exemptions & `effect-fn-dummy-void` in unified AST gate    | `libs/harness/gates/src/ast-cache.ts`, `libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `libs/harness/gates/src/gc-check.ts` | `AstGateCache.decide` & `GraphGc.decide`           | `SelfDogfooding.decide`, `GatePluginRunner.evaluateAll`                                                                                                                       |
| Capability services and layers for filesystem, subprocess, mutant context, and gate plugin registry                    | `libs/harness/gates/src/services/workspace-fs.ts`, `libs/harness/gates/src/services/subprocess-runner.ts`, `libs/harness/gates/src/services/active-mutant-context.ts`, `libs/harness/gates/src/plugins/gate-plugin-registry.ts`, `libs/harness/gates/src/mutation/mutant-ast-generator.ts`, `libs/harness/gates/src/mutation-check.ts` | `pnpm harness gc --strict` & `pnpm harness verify` | `WorkspaceFs.readAndVerifyFile`, `HarnessSubprocess.execChecked`, `MutationCheck.withActiveMutant`, `GatePluginRunner.evaluateAll`, `WorkspaceFsError`, `HarnessSubprocessError` |
| Scoped TypeScript compiler overlay service with `Effect.acquireRelease` cleanup                                        | `libs/harness/graph/src/services/ts-compiler-overlay-service.ts`                                                               | `pnpm harness gc --strict` & `pnpm harness verify` | `TsCompilerOverlay.extractGraph`, `TsCompilerOverlayError`                                                                                                                    |
| Modular CLI command and MCP tool plugin registries replacing `switch` dispatchers                                      | `apps/harness-cli/src/commands/command-registry.ts`, `apps/harness-mcp/src/tools/tool-registry.ts`                             | `pnpm harness gc --strict` & `pnpm harness verify` | `HarnessCli.dispatchCommand`, `CliCommandNotFoundError`, `HarnessMcp.dispatchTool`                                                                                            |
