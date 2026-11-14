---
id: harness:ADR-0013
title: Five-Tier Hexagonal Harness Package Topology and Pure Contract-Service Split
status: accepted
date: 2026-11-14
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/index.ts
  - libs/harness/contract/src/stub.ts
  - libs/harness/contract/src/workspace-and-process.ts
  - libs/harness/contract/src/ast-and-gate-primitives.ts
  - libs/harness/contract/src/tier-topology.ts
  - libs/harness/contract/src/cache-and-daemon.ts
  - libs/harness/service/src/index.ts
  - libs/harness/service/src/cache-and-daemon-ports.ts
  - libs/harness/service/src/host-io.ts
  - libs/harness/gates/src/plugins/harness-tier-topology.ts
  - libs/harness/gates/src/plugins/self-dogfooding-plugin.ts
  - libs/harness/gates/src/plugins/ast-gate-visitors.ts
  - libs/harness/gates/src/services/workspace-fs.ts
  - libs/harness/decision/src/learn-decision.ts
  - libs/harness/decision/src/ontology-conflict-decision.ts
  - libs/harness/decision/src/plan-coverage-decision.ts
  - libs/harness/infra/src/index.ts
  - libs/harness/infra/src/active-mutant-context-live.ts
  - libs/harness/infra/src/workspace-fs-live.ts
  - libs/harness/infra/src/subprocess-runner-live.ts
  - libs/harness/infra/src/ast-gate-cache-live.ts
  - libs/harness/infra/src/decision-cache-live.ts
  - libs/harness/infra/src/unix-socket-daemon-live.ts
  - libs/harness/infra/src/node-host-io.ts
  - apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - apps/harness-cli/src/commands/repo-checks.command.ts
  - apps/harness-cli/src/commands/scenario.command.ts
  - apps/harness-cli/src/commands/scenario-eval.ts
  - apps/harness-cli/src/commands/verify-delta-gates.ts
  - apps/harness-mcp/src/managed-runtime.ts
spans:
  - HarnessTierTopology.decide
  - SelfDogfooding.decide
  - AstGateCache.decide
  - WorkspaceFs.statAndReadAll
  - WorkspaceFs.readAndVerifyFile
  - HarnessSubprocess.execChecked
  - MutationCheck.withActiveMutant
  - AstGateCache.evaluateCached
  - DecisionCache.lookupOrCompute
  - UnixSocketDaemon.startScoped
  - Harness.proposeLearningAction
  - Harness.checkOntologyPairConflict
  - OntologyConflict.extractPairs
  - Harness.evaluateOntologyConflicts
  - Harness.checkPlanStepCoverage
  - HarnessCli.readStdin
  - HarnessCli.runDeclarativeCli
  - HarnessCli.checkOpenApi
  - HarnessCli.checkMigrations
  - HarnessCli.checkEventSchemas
  - HarnessCli.runScenario
  - HarnessMcp.executeManagedTool
services:
  - "@harness/service/WorkspaceFs"
  - "@harness/service/HarnessSubprocessRunner"
  - "@harness/service/ActiveMutantContext"
  - "@harness/service/AstGateCachePort"
  - "@harness/service/DecisionCachePort"
  - "@harness/service/UnixSocketDaemonPort"
errors:
  - WorkspaceFsError
  - HarnessSubprocessError
  - SelfDogfoodingViolationError
  - TsCompilerOverlayError
  - CliCommandNotFoundError
  - UnknownToolError
  - DaemonServerError
  - StdinReadError
informs:
  - harness:SPEC-0012
---

# ADR-0013 · Five-Tier Hexagonal Harness Package Topology and Pure Contract-Service Split

## Context and Problem Statement

As documented in [RFC-0008](../../../../docs/rfcs/0008-true-hexagonal-closure-and-effect-v4-runtime.md), previously the harness packages under `libs/harness/gates`, `libs/harness/graph`, and `libs/harness/ingest` carried dual Nx tags (`["type:contract", "type:service"]`) and co-located `effect/Schema` wire contracts, `Context.Service` capability ports, pure `*.decide` functions, and live Node/filesystem `Layer` implementations inside the same packages. Because `stub<A, E, R>` and shared gate schemas lived inside `@harness/gates`, `type:core` and `type:domain` libraries could not import `stub` or harness contract schemas without transitively pulling in `@harness/gates` infrastructure and Node-specific dependencies.

Leaving these dual tier tags and mixed contract-service-infra boundaries in place allows circular architectural coupling across harness packages, violates the five-tier hexagonal Nx taxonomy (`type:contract` → `type:service` → `type:domain`/`type:core` → `type:infra` → `type:app`), and prevents deterministic graph verification of pure contract and service boundaries.

## Decision Drivers

- **Strict Five-Tier Hexagonal Separation:** Every harness library must declare a single canonical Nx tier tag (`type:contract`, `type:service`, `type:core`/`type:domain`, or `type:infra`) with zero dual `["type:contract", "type:service"]` tags.
- **Pure `effect`-Only Contract Boundary (`@harness/contract`):** Shared schemas, tagged errors, AST/gate primitives, and `stub<A, E, R>` must live in `@harness/contract` (`type:contract`) with only `effect` as a runtime dependency so any domain or core package can import them without pulling in I/O or `gates`.
- **Pure Service Port Boundary (`@harness/service`):** `Context.Service` capability interfaces (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`) must be declared in `@harness/service` (`type:service`) importing only `@harness/contract` and `effect`, free of Node or infrastructure imports.
- **Deterministic Tier-Topology Enforcement:** A pure `R = never` decider (`HarnessTierTopology.decide`) must validate `project.json` tags, dependency edges, and service-tier imports on every `pnpm harness gc --strict` and `pnpm harness verify` run.

## Considered Options

- **Option 1:** Extract dedicated @harness/contract and @harness/service packages and eliminate dual Nx tier tags
- **Option 2:** Retain dual-tagged ["type:contract", "type:service"] packages
- **Option 3:** Collapse all harness libraries into a single monolithic package
- **Option 4:** Retain transitional backward-compatibility re-export shims in @harness/gates and duplicate layer aliases in @harness/infra

## Decision Outcome

**Chosen option:** "Option 1: Extract dedicated @harness/contract and @harness/service packages and eliminate dual Nx tier tags", because it aligns `libs/harness/*` with the workspace's five-tier hexagonal architecture, isolates `stub` and all shared schemas in `effect`-only `@harness/contract`, decouples `Context.Service` ports in `@harness/service` from live `Layer` implementations in `@harness/gates`, and enables deterministic verification via `HarnessTierTopology.decide`.

### Architectural Rules and Guarantees

1. `@harness/contract` (`libs/harness/contract`) carries `type:contract` only, depends exclusively on `effect`, and exports `stub`, `WorkspaceFsError`, `HarnessSubprocessError`, `SelfDogfoodingViolationError`, `TsCompilerOverlayError`, `CliCommandNotFoundError`, `UnknownToolError`, `DaemonServerError`, `StdinReadError`, subprocess validation, cache/daemon schemas, and tier-topology contract schemas.
2. `@harness/service` (`libs/harness/service`) carries `type:service` only, depends exclusively on `effect` and `@harness/contract`, and exports pure `Context.Service` ports (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`, `AstGateCachePort`, `DecisionCachePort`, `UnixSocketDaemonPort`, and `SyncHostIo` / `ExtendedHostIo` synchronous compiler-host ports) without Node, `Layer.*`, `type:core`, `type:domain`, or `type:infra` imports.
3. Every workspace package declares a single canonical `type:*` Nx tier tag (`@harness/{gates,graph,decision,ingest}` carry `type:core`), and no project may declare multiple `type:*` tags in `package.json` or `project.json`.
4. `WorkspaceFs` exposes `statAndReadAll` for batched workspace file stat and UTF-8 reading behind the `@harness/service/WorkspaceFs` capability seam, failing with typed `WorkspaceFsError`.
5. `@harness/infra` (`libs/harness/infra`) carries `type:infra` only and provides live `Layer` implementations built over `@effect/platform-node` (`NodeServices.layer`, `FileSystem.FileSystem`, `Path.Path`, `ChildProcessSpawner`, `ScopedCache`, `SynchronizedRef`, `Effect.acquireRelease`) for workspace I/O, subprocess execution, `ActiveMutantContextLive`, scoped AST/decision caches (`AstGateCachePort`, `DecisionCachePort`), and scoped `0600` Unix socket daemon lifecycle (`UnixSocketDaemonPort` failing with `DaemonServerError`).
6. Non-infra `libs/harness/*` packages (`type:contract`, `type:service`, `type:core`, `type:domain`) must maintain zero Node host I/O built-in imports (`node:fs`, `node:child_process`, `node:net`, `node:os`, `node:http`, `node:https`) and zero global mutable caches; pure path/digest helpers (`node:path`, `node:crypto`, `node:url`) remain permitted in `type:core` utilities while all stateful caching and Node I/O bindings live in `@harness/infra` (with `SyncHostIo` retained strictly for synchronous `ts.CompilerHost` / `ts-morph` callbacks).
7. `apps/harness-cli` routes all CLI invocations declaratively through `effect/cli` (`Command.make`, `Flag`, `Argument`) and `NodeRuntime.runMain` in `HarnessCli.runDeclarativeCli` (reporting defects on `stderr` via `Cause.pretty` and failing closed on `StdinReadError` in hook guards), exposing typed subcommands (`check-openapi`, `check-migrations`, `check-event-schemas`, `benchmark`, `scenario`) with zero production `Effect.runSync` or `Effect.runPromise` calls.
8. `apps/harness-mcp` executes MCP tool requests through a single scoped `ManagedRuntime` (`HarnessMcp.executeManagedTool`) over `McpToolRegistryLive` and `NodeServices.layer` with zero production `Effect.runSync` calls, bridging only the foreign `@modelcontextprotocol/sdk` Promise callback boundary via `ManagedRuntime.runPromiseExit`.
9. `ast-gate-visitors.ts` deletes the `isHarnessInternal` exemption and `tools/oxlint/syntax-bans.js` (`isEnforcedWorkspaceFile`) enforces `discriminant-branching` and `unscoped-effect-run` uniformly across `libs/harness/*` and `apps/harness-*`, retaining only the single-file synchronous `SqlStorage` bridge exemption in `libs/es/infra/src/memory.ts`.
10. `SelfDogfooding.decide` permanently enforces hexagonal hygiene rules across production source files: `no-global-mutable-cache` (banning module-scope `let` variables, empty/Weak module-scope `Map`/`Set`/`WeakMap`/`WeakSet`, and module-scope `Map`/`Set` mutations), `no-node-builtins-outside-infra` (banning static and dynamic Node host I/O built-ins outside `type:infra`), `no-layer-build-in-layer-effect` (banning `Layer.build` inside `Layer.effect`), `no-double-wrapped-effect-fn` (banning functions returning `Effect.gen` wrapped inside `Effect.fn` or `Effect.fnUntraced`), and `test-env-branch-in-src` (banning `process.env.VITEST` branches in `src/`).
11. Zero transitional backward-compatibility re-export shims or duplicate layer aliases may remain in `@harness/gates` or `@harness/infra`: all consumers import contracts and `stub` directly from `@harness/contract`, canonical `@harness/service/*` ports from `@harness/service`, and canonical `*Live` layers from `@harness/infra`.

## Rejected Alternatives

### 1 · Option 2: Retain dual-tagged ["type:contract", "type:service"] packages

Keep schemas, `stub`, `Context.Service` ports, and live Node `Layer` implementations inside `libs/harness/{gates,graph,ingest}` with dual `["type:contract", "type:service"]` Nx tags.

**Why rejected:** Dual tier tags bypass Nx module-boundary checks, force `type:core` and `type:domain` packages to depend on `@harness/gates` just to use `stub`, and allow `type:service` ports to import Node I/O modules directly.

### 2 · Option 3: Collapse all harness libraries into a single monolithic package

Merge `ingest`, `decision`, `gates`, `graph`, `contract`, and `service` into one `@harness/core` package.

**Why rejected:** A monolithic harness package erases compile-time tier boundaries, slows incremental `nx affected` builds, and makes it impossible to enforce pure `R = never` deciders separately from stateful `Layer` providers.

### 3 · Option 4: Retain transitional backward-compatibility re-export shims in @harness/gates and duplicate layer aliases in @harness/infra

Keep `@harness/gates/src/stub.ts`, transitional `@harness/contract` / `@harness/service` re-exports in `@harness/gates`, and duplicate `*NodeLive` layer aliases in `@harness/infra` as compatibility shims.

**Why rejected:** Transitional re-export shims preserve indirect coupling to `@harness/gates`, mask dead exports from `GraphGc.decide` (`unused-contract-export`), and perpetuate ambiguous `@harness/service/*` vs. legacy service tag IDs.

## Consequences and Enforcement

### Positive Consequences

- `type:core` and `type:domain` packages import `stub` and gate schemas from `@harness/contract` with zero transitive infrastructure dependencies.
- `@harness/service` capability ports (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`, `AstGateCachePort`, `DecisionCachePort`, `UnixSocketDaemonPort`) can be satisfied by in-memory test `Layer`s without loading Node filesystem or subprocess modules.
- `HarnessTierTopology.decide` deterministically catches any regression in Nx tier tags, contract/service/core dependencies, or impure service-tier imports.

### Negative Consequences and Trade-offs

- Adding a new harness schema or `Context.Service` capability requires placing the schema/error in `libs/harness/contract`, the port in `libs/harness/service`, and the live `Layer` in `libs/harness/infra`.
- Synchronous `ts.CompilerHost` / `ts-morph` APIs still require the synchronous `SyncHostIo` port interface (`nodeSyncHostIo` in `@harness/infra`) rather than asynchronous `WorkspaceFs` effects.

### Deterministic Enforcement

| Rule                                                                                                                               | Enforced By                                                                                             | Gate / Mechanism                                    | Governed Symbols                                                                                           |
| :--------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| Reject dual `type:*` Nx tags (`dual-contract-tier-tag`)                                                                            | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts` | `HarnessTierTopology.decide` (`pnpm harness gc --strict` & `pnpm harness verify`) | `HarnessTierTopology.decide`                                                                               |
| Enforce `effect`-only dependencies on `type:contract` packages (`forbidden-contract-dependency`)                                   | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts` | `HarnessTierTopology.decide` (`pnpm harness gc --strict` & `pnpm harness verify`) | `HarnessTierTopology.decide`                                                                               |
| Restrict `type:service` and `type:core` dependencies (`forbidden-service-dependency`, `forbidden-core-dependency`)                 | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts` | `HarnessTierTopology.decide` (`pnpm harness gc --strict` & `pnpm harness verify`) | `HarnessTierTopology.decide`                                                                               |
| Ban Node/Layer/higher-tier imports inside `type:service` source files (`impure-service-tier-import`)                               | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts` | `HarnessTierTopology.decide` (`pnpm harness gc --strict` & `pnpm harness verify`) | `HarnessTierTopology.decide`                                                                               |
| Batched workspace file stat/read via `WorkspaceFs` capability seam failing with `WorkspaceFsError`                                 | `libs/harness/gates/src/services/workspace-fs.ts`, `libs/harness/service/src/index.ts`, `libs/harness/infra/src/workspace-fs-live.ts` | `pnpm harness gc --strict` & `pnpm harness verify`  | `WorkspaceFs.statAndReadAll`, `WorkspaceFs.readAndVerifyFile`, `WorkspaceFsError`, `@harness/service/WorkspaceFs` |
| Native Effect v4 `@harness/infra` (`type:infra`) adapters over `@effect/platform-node` (`NodeServices.layer`, `FileSystem.FileSystem`, `Path.Path`, `ChildProcessSpawner`, `ScopedCache`, `SynchronizedRef`, `Effect.acquireRelease`) with zero Node host I/O imports or global mutable caches in non-infra `libs/harness/*` | `libs/harness/infra/src/index.ts`, `libs/harness/infra/src/ast-gate-cache-live.ts`, `libs/harness/infra/src/decision-cache-live.ts`, `libs/harness/infra/src/unix-socket-daemon-live.ts`, `libs/harness/infra/src/subprocess-runner-live.ts`, `libs/harness/infra/src/node-host-io.ts` | `pnpm harness gc --strict` & `pnpm harness verify`  | `AstGateCache.evaluateCached`, `DecisionCache.lookupOrCompute`, `UnixSocketDaemon.startScoped`, `@harness/service/AstGateCachePort`, `@harness/service/DecisionCachePort`, `@harness/service/UnixSocketDaemonPort`, `DaemonServerError` |
| Declarative `effect/cli` + `NodeRuntime.runMain` entry with fail-closed `StdinReadError` handling, typed repo-check & scenario subcommands (`check-openapi`, `check-migrations`, `check-event-schemas`, `benchmark`, `scenario`), and zero production `Effect.runSync` | `apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts`, `apps/harness-cli/src/commands/declarative-cli.ts`, `apps/harness-cli/src/commands/repo-checks.command.ts`, `apps/harness-cli/src/commands/scenario.command.ts`, `apps/harness-cli/src/commands/scenario-eval.ts` | `pnpm harness gc --strict` & `pnpm harness verify`  | `HarnessCli.readStdin`, `HarnessCli.runDeclarativeCli`, `HarnessCli.checkOpenApi`, `HarnessCli.checkMigrations`, `HarnessCli.checkEventSchemas`, `HarnessCli.runScenario`, `StdinReadError` |
| Scoped `ManagedRuntime` MCP tool execution in `apps/harness-mcp` with zero production `Effect.runSync` | `apps/harness-mcp/src/managed-runtime.ts` | `pnpm harness gc --strict` & `pnpm harness verify`  | `HarnessMcp.executeManagedTool` |
| Uniform AST enforcement across `libs/harness/*` and `apps/harness-*` without `isHarnessInternal` (`discriminant-branching`, `unscoped-effect-run`, and `isEnforcedWorkspaceFile` lint checks, retaining only `libs/es/infra/src/memory.ts` `SqlStorage` bridge exemption) | `libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `apps/harness-cli/src/commands/verify-delta-gates.ts` | `AstGateCache.decide` (`pnpm harness gc --strict` & `pnpm harness verify`) | `AstGateCache.decide` |
| Permanent hexagonal self-dogfooding rules (`no-global-mutable-cache`, `no-node-builtins-outside-infra`, `no-layer-build-in-layer-effect`, `no-double-wrapped-effect-fn`, `test-env-branch-in-src`) | `libs/harness/gates/src/plugins/self-dogfooding-plugin.ts` | `SelfDogfooding.decide` (`pnpm harness gc --strict` & `pnpm harness verify`) | `SelfDogfooding.decide` |
