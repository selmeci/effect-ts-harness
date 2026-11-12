---
title: "RFC-0007 Implementation: Self-Dogfooding Audit Resolution & Effect-TS v4 Modular Capability Plugin Harness"
type: feat
status: active
date: 2026-11-12
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
---

# Goal Capsule

Eliminate the architectural double standard between the Effect-TS Engineering Harness (`libs/harness/*`, `apps/harness-*`) and the domain packages it governs (`libs/es/*`, `libs/sample/*`) by implementing **RFC-0007**: replacing `Effect.fn` `R = never` imperative wrappers (`yield* Effect.void` and nested `Effect.runSync` inside `Effect.sync` / `Layer.effect`) with genuine Effect-TS v4 **Three-Role Capability Seams** (`Context.Service` + `Layer.scoped` / `Layer.effect` + `Effect.fn` consumers), decomposing monolithic god-files in `@harness/gates`, `@harness/graph`, `harness-cli`, and `harness-mcp` into modular plugins under an 800-line module budget, and enforcing self-dogfooding deterministically via `SelfDogfooding.decide` and `AstGateCache.decide`.

---

# Part 1: Product Contract (`/ce-brainstorm` Synthesis & Settled Decisions)

## 1.1 Brainstorm Blindspots Identified & Resolved

During the `/ce-brainstorm` review of `RFC-0007` against the live repository and `ADR-0001..0011` / `SPEC-0001..0010`, we identified and resolved five critical architectural nuances:

1. **Governance Referential Integrity (`stale-doc-reference` Protection):**
   - `GraphGc.decide` verifies that every file path in `enforced_by` across all `accepted` ADRs (`ADR-0001..0011`) and EARS Specs (`SPEC-0001..0010`) physically exists on disk, that backticked gate identifiers in `### Deterministic Enforcement` tables appear inside the attributed `Enforced By` files, and that all declared `spans`, `services`, and `errors` exist in `HarnessGraph`.
   - **Resolution:** Decomposing `gc-check.ts`, `type-extractor.ts`, `apps/harness-cli/src/index.ts`, and `apps/harness-mcp/src/server.ts` preserves the canonical entry paths and existing span names (`GraphGc.decide`, `TypeExtractor.extractWorkspace`, `HarnessMcp.executeTool`, `Harness.ingestWorkspace`) as thin orchestrators while extracting cohesive plugin/command/tool sub-modules (`libs/harness/gates/src/plugins/*`, `libs/harness/gates/src/services/*`, `libs/harness/graph/src/services/*`, `apps/harness-cli/src/commands/*`, `apps/harness-mcp/src/tools/*`).
2. **Guard Policy Boundary (`tools/oxlint/*` vs. `libs/harness/gates/src/ast-cache.ts`):**
   - Modifying `tools/oxlint/*` triggers an interactive human confirmation gate (`verdict: "ask"` in `classifyFileWrite`).
   - **Resolution:** Enforce all new AST self-dogfooding bans (`effect-fn-dummy-void`, `nested-effect-run-sync`, `file-line-budget-exceeded`, and removal of `!isHarnessInternal` exemptions for `SwitchStatement` and `match(...).run()`) directly inside `AstGateCache.decide` (`libs/harness/gates/src/ast-cache.ts`) and `SelfDogfooding.decide` (`libs/harness/gates/src/plugins/self-dogfooding-plugin.ts`), which run automatically on every `pnpm harness gc --strict` and `pnpm harness verify`.
3. **Mutant Schemata Backwards Compatibility (`ADR-0010` / `SPEC-0009`):**
   - Existing tests in `milestone5-dst-ears-mutation-dpo.test.ts` assert that `compileMutantSchemaModule` emits `globalThis.__HARNESS_ACTIVE_MUTANT_ID` ternary guards in synthesized mutant source strings.
   - **Resolution:** Preserve `compileMutantSchemaModule`'s codegen expression while introducing the fiber-safe `ActiveMutantContext` (`Context.Service` + `Layer.scoped` with `SynchronizedRef` and `Effect.acquireRelease` cleanup) and `MutationCheck.withActiveMutant` (`Effect.fn("MutationCheck.withActiveMutant")`) for Effect-native scoped mutation execution.
4. **Graph Service Audit (`unused-service` and `unprovided-service` in `GraphGc.decide`):**
   - Every new `Context.Service` (`ServiceTag`) introduced in `libs/harness/*` or `apps/harness-*` must have at least one exported `Layer` providing it (`ProvidesService` edge) AND at least one `Effect.fn` consumer yielding it (`RequiresService` edge) so `GraphGc.decide` passes with zero `unused-service` or `unprovided-service` findings without adding new entries to `IGNORED_SERVICES`.
5. **Elimination of All 15 `yield* Effect.void` & Nested `Effect.runSync` Anti-Patterns:**
   - Every single `yield* Effect.void` in `src/` (`libs/sample/domain/src/index.ts`, 11 files in `libs/harness/gates/src/`, `libs/harness/graph/src/cluster-resolver.ts`, and 2 places in `apps/harness-cli/src/index.ts`) and nested `Effect.runSync` inside `Effect.sync` (`libs/harness/ingest/src/fn-index.ts`) and `Layer.effect` (`libs/harness/decision/src/cached-decision-model.ts`) will be refactored to idiomatic Effect v4 (`Effect.fn("...")((input) => Effect.succeed(...))` for pure synchronous deciders, and `yield*` inside `Effect.gen` / `Layer.effect` for effectful operations).

## 1.2 Settled Open Questions from `RFC-0007` Section 9

- **OQ-1 (Dual-Layer Cache Lifecycle):** `TsCompilerOverlayService` and `CachedDecisionModel` use a dual-layer strategy: scoped in-memory state (`SynchronizedRef` / warm session map managed by `Layer.scoped` + `Effect.acquireRelease`) backed by atomic disk persistence (`.harness/cache/*.json` via write-to-temp + rename). This works identically in single-shot CLI processes and long-running MCP servers without requiring a mandatory background daemon.
- **OQ-2 (Modular File Line Budget):** `SelfDogfooding.decide` and `AstGateCache.decide` enforce a strict `MaxPluginFileLines = 800` line budget (`file-line-budget-exceeded`) across all modular plugin, service, command, and tool files (`libs/harness/*/src/plugins/**`, `libs/harness/*/src/services/**`, `apps/harness-cli/src/commands/**`, `apps/harness-mcp/src/tools/**`).
- **OQ-3 (Static Compile-Time Plugin Composition):** All gate plugins, CLI commands, and MCP tools are composed statically via Effect `Layer`s and typed registries (`GatePluginRegistry`, `HarnessCommandRegistry`, `McpToolRegistry`), preserving 100% static analyzability in `HarnessGraph` and Trusted Computing Base (TCB) integrity.

---

# Part 2: Technical Implementation Plan (`/ce-plan` + Effect-TS Plan-as-Code)

## 2.1 Governance Artifacts (`ADR` & `EARS Spec`)

1. **`libs/harness/docs/adr/0012-self-dogfooding-and-capability-plugin-harness.md` (`harness:ADR-0012`):**
   - Records the binding architectural decision to adopt Cordis-inspired Three-Role Capability Seams (`Context.Service` + `Layer.scoped`/`Layer.effect` + `Effect.fn` consumers), ban `yield* Effect.void` and nested `Effect.runSync`, remove `isHarnessInternal` `switch` and `match().run()` exemptions, and enforce the 800-line modular plugin budget.
   - Register `harness:ADR-0012` in `docs/adr/README.md`.
2. **`libs/harness/docs/specs/2026-11-12-self-dogfooding-and-capability-plugin-harness.md` (`harness:SPEC-0011`):**
   - Defines testable EARS requirements (`REQ-1.1` through `REQ-5.3`) covering `SelfDogfooding.decide`, `WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`, `GatePluginRegistry`, `TsCompilerOverlayService`, `HarnessCommandRegistry`, `McpToolRegistry`, and `AstGateCache.decide`.
   - Register `harness:SPEC-0011` in `docs/specs/README.md`.

## 2.2 Capability Services, Layers, and Consumers Across Packages

### Unit 1: `@harness/ingest` & `@harness/decision` Cleanup
- **`libs/harness/ingest/src/fn-index.ts`**:
  - Replace `Effect.sync` + nested `Effect.runSync(Effect.try(...))` in `buildWorkspaceFnIndex` with `Effect.gen(function* () { ... yield* Effect.try(...) })`.
  - Replace `if (Option.isSome(opt) && ...)` with exhaustive `match(opt)`.
- **`libs/harness/decision/src/cached-decision-model.ts` & `idiom-router.ts`**:
  - Convert `loadStoreIntoMapEffect` and `persistMapToDiskEffect` to genuine `Effect` operations yielded with `yield*` inside `Layer.effect(DecisionModel.DecisionModel, Effect.gen(...))` instead of calling `Effect.runSync` inside `Layer.effect`.
- **`libs/sample/domain/src/index.ts`**:
  - Remove dummy `yield* Effect.void` from `Sample.healthCheck`.

### Unit 2: `@harness/gates` — Capability Services, Gate Plugin Architecture & Self-Dogfooding Decider
- **New Branded Contracts & Errors (`libs/harness/gates/src/plugins/self-dogfooding-contract.ts`):**
  - Branded types: `PluginId`, `PluginFileLineCount`, `MaxPluginFileLines`, `SelfDogfoodingRuleId`, `SelfDogfoodingMessage`, `WorkspaceFilePath`, `SubprocessCommand`, `SubprocessArg`, `SubprocessExitCode`, `SubprocessOutput`, `ActiveMutantId`.
  - Tagged Errors:
    - `WorkspaceFsError` (`Schema.TaggedError<WorkspaceFsError>()("WorkspaceFsError", ...)`)
    - `HarnessSubprocessError` (`Schema.TaggedError<HarnessSubprocessError>()("HarnessSubprocessError", ...)`)
    - `SelfDogfoodingViolationError` (`Schema.TaggedError<SelfDogfoodingViolationError>()("SelfDogfoodingViolationError", ...)`)
  - Closed Discriminated Unions:
    - `SelfDogfoodingViolation` (`Schema.Struct`)
    - `SelfDogfoodingInput` (`Schema.Struct`)
    - `SelfDogfoodingReport` (`Schema.TaggedUnion` / `Schema.Struct` with `GateVerdict`)
- **New Capability Services & Live/Test Layers (`libs/harness/gates/src/services/*.ts`):**
  - `WorkspaceFs` (`Context.Service<WorkspaceFs, ...>()("@harness/gates/WorkspaceFs")`) + `WorkspaceFsLive` (`Layer.succeed`) + `makeWorkspaceFsMemoryLayer` + consumer `WorkspaceFs.readAndVerifyFile` (`Effect.fn("WorkspaceFs.readAndVerifyFile")`) that requires `WorkspaceFs` and fails with `WorkspaceFsError`.
  - `HarnessSubprocessRunner` (`Context.Service<HarnessSubprocessRunner, ...>()("@harness/gates/HarnessSubprocessRunner")`) + `HarnessSubprocessRunnerLive` (`Layer.succeed`) + consumer `HarnessSubprocess.execChecked` (`Effect.fn("HarnessSubprocess.execChecked")`) that requires `HarnessSubprocessRunner` and fails with `HarnessSubprocessError`.
  - `ActiveMutantContext` (`Context.Service<ActiveMutantContext, ...>()("@harness/gates/ActiveMutantContext")`) + `ActiveMutantContextLive` (`Layer.effect` backed by `SynchronizedRef` and `Effect.acquireRelease` scoped restoration) + consumer `MutationCheck.withActiveMutant` (`Effect.fn("MutationCheck.withActiveMutant")`) that requires `ActiveMutantContext`.
- **Gate Plugin Registry & Self-Dogfooding Decider (`libs/harness/gates/src/plugins/*.ts`):**
  - `SelfDogfooding.decide` (`Effect.fn("SelfDogfooding.decide")` with `R = never`): Pure decider inspecting source files for:
    1. `effect-fn-dummy-void`: `yield* Effect.void` inside `Effect.fn` or `Effect.gen`.
    2. `nested-effect-run-sync`: `Effect.runSync` / `Effect.runPromise` inside `Effect.fn`, `Effect.gen`, `Effect.sync`, `Layer.effect`, or `Layer.scoped`.
    3. `file-line-budget-exceeded`: Modular plugin/service/command/tool files exceeding `maxPluginFileLines` (default `800`).
    4. `harness-switch-statement`: `switch (...)` statements in non-test harness files.
  - `GatePluginRegistry` (`Context.Service<GatePluginRegistry, ...>()("@harness/gates/GatePluginRegistry")`) + `GatePluginRegistryLive` (`Layer.succeed`) + consumer `GatePluginRunner.evaluateAll` (`Effect.fn("GatePluginRunner.evaluateAll")`) requiring `GatePluginRegistry` and `WorkspaceFs` and failing with `SelfDogfoodingViolationError | WorkspaceFsError`.
- **Eliminate `yield* Effect.void`, `switch`, and `isHarnessInternal` in `@harness/gates`:**
  - Remove `yield* Effect.void` from `adr-lint.ts`, `ears-lint.ts`, `friction-log.ts` (2), `migration-check.ts`, `mutation-check.ts`, `session-handoff.ts`, `span-budget.ts`, `telemetry.ts`, `ontology-invariants.ts`, `gc-check.ts`.
  - Replace `switch (cleanPattern)` in `ears-lint.ts:439` with `match(cleanPattern)`.
  - Update `ast-cache.ts` (`AstGateCache.decide`) to enforce `SwitchStatement` (`discriminant-branching`), `match(...).run()` (`non-exhaustive-union-match`), `effect-fn-dummy-void`, and `file-line-budget-exceeded` across `libs/harness/**` and `apps/harness-*` as well (removing the `!isHarnessInternal` exemption on `SwitchStatement` and `match(...).run()`), and bump `HARNESS_GATE_RULE_VERSION`.

### Unit 3: `@harness/graph` — `TsCompilerOverlayService` & Clean Scoped Lifecycle
- **`libs/harness/graph/src/services/ts-compiler-overlay-service.ts`:**
  - Define `TsCompilerOverlayError` (`Schema.TaggedError<TsCompilerOverlayError>()("TsCompilerOverlayError", ...)`).
  - Define `TsCompilerOverlayService` (`Context.Service<TsCompilerOverlayService, ...>()("@harness/graph/TsCompilerOverlayService")`) with `TsCompilerOverlayServiceLive` (`Layer.scoped` using `Effect.acquireRelease` to manage warm `TypeScriptProgramSession` instances per root and release memory on scope exit).
  - Define `TsCompilerOverlay.extractGraph` (`Effect.fn("TsCompilerOverlay.extractGraph")`) requiring `TsCompilerOverlayService` and failing with `TsCompilerOverlayError`.
- **`libs/harness/graph/src/cluster-resolver.ts`:**
  - Remove `yield* Effect.void` from `OmnigraphReconcile.decide`.

### Unit 4: `harness-cli` & `harness-mcp` — Modular Command & Tool Plugin Registries
- **`apps/harness-cli/src/commands/command-registry.ts` & `apps/harness-cli/src/index.ts`:**
  - Define `CliCommandNotFoundError` (`Schema.TaggedError<CliCommandNotFoundError>()("CliCommandNotFoundError", ...)`).
  - Define `HarnessCommandRegistry` (`Context.Service<HarnessCommandRegistry, ...>()("harness-cli/HarnessCommandRegistry")`) + `HarnessCommandRegistryLive` (`Layer.succeed`) + `HarnessCli.dispatchCommand` (`Effect.fn("HarnessCli.dispatchCommand")`) requiring `HarnessCommandRegistry` and failing with `CliCommandNotFoundError`.
  - Extract modular command descriptors into `apps/harness-cli/src/commands/*.ts` (each `< 800` lines).
  - Remove both `yield* Effect.void` calls (`lines 2484, 3013`) and replace both `switch` statements (`lines 2934, 3594`) in `apps/harness-cli/src/index.ts` with exhaustive `match(...)` / registry lookup.
- **`apps/harness-mcp/src/tools/tool-registry.ts` & `apps/harness-mcp/src/server.ts`:**
  - Define `McpToolRegistry` (`Context.Service<McpToolRegistry, ...>()("harness-mcp/McpToolRegistry")`) + `McpToolRegistryLive` (`Layer.succeed`) + `HarnessMcp.dispatchTool` (`Effect.fn("HarnessMcp.dispatchTool")`) requiring `McpToolRegistry` and failing with `UnknownToolError`.
  - Extract modular MCP tool handlers into `apps/harness-mcp/src/tools/*.ts` (each `< 800` lines) and replace the giant `switch (toolName)` in `apps/harness-mcp/src/server.ts#L482` with `McpToolRegistry` lookup!

## 2.3 Verification & Testing Strategy

1. **Plan-as-Code Gate (`pnpm harness plan-check`):**
   - Author `harness:SPEC-0011` and `harness:ADR-0012` first, write `stub<A, E, R>()` skeletons for all new spans, services, and errors, and verify `pnpm harness plan-check` exits `0`.
2. **Trace & Property Tests (`@effect/vitest`):**
   - Write comprehensive `@effect/vitest` tests (`it.effect` + `it.effect.prop` with composite `Schema` arbitraries + `runWithTestTracer` + `checkSpanBudgets` + `Cause.findErrorOption`) across `@harness/gates`, `@harness/graph`, `harness-cli`, and `harness-mcp`.
3. **4-Lens Specialist Review + `/ce-code-review`:**
   - Dispatch parallel specialist reviewers (`effect-ears-test-reviewer`, `effect-security-reviewer`, `effect-reliability-reviewer`, `effect-adversarial-reviewer`), adjudicate all findings, and apply all valid fixes.
4. **Final Deterministic Harness Gates:**
   - `pnpm harness gc --strict`
   - `pnpm harness ontology check --strict`
   - `pnpm harness mutate --strict`
   - `CI=true pnpm harness verify`
   - `CI=true pnpm harness done`
5. **Commit, Push & Open PR (`gh pr create`):**
   - Stage all modified/created files, commit with `feat(harness): implement RFC-0007 self-dogfooding and modular capability plugin harness (harness:SPEC-0011)`, push branch `feat/rfc-0007-self-dogfooding-plugin-harness`, and open the GitHub PR.
