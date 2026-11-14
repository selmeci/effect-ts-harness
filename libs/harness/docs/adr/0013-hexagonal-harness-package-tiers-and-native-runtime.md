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
  - libs/harness/gates/src/services/workspace-fs.ts
  - libs/harness/infra/src/index.ts
  - libs/harness/infra/src/workspace-fs-live.ts
  - libs/harness/infra/src/subprocess-runner-live.ts
  - libs/harness/infra/src/ast-gate-cache-live.ts
  - libs/harness/infra/src/decision-cache-live.ts
  - libs/harness/infra/src/unix-socket-daemon-live.ts
  - libs/harness/infra/src/node-host-io.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - apps/harness-cli/src/commands/repo-checks.command.ts
  - apps/harness-cli/src/commands/scenario.command.ts
  - apps/harness-cli/src/commands/scenario-eval.ts
  - apps/harness-mcp/src/managed-runtime.ts
spans:
  - HarnessTierTopology.decide
  - WorkspaceFs.statAndReadAll
  - WorkspaceFs.readAndVerifyFile
  - HarnessSubprocess.execChecked
  - MutationCheck.withActiveMutant
  - AstGateCache.evaluateCached
  - DecisionCache.lookupOrCompute
  - UnixSocketDaemon.startScoped
  - HarnessCli.runDeclarativeCli
  - HarnessCli.checkOpenApi
  - HarnessCli.checkMigrations
  - HarnessCli.checkEventSchemas
  - HarnessCli.runScenario
  - HarnessMcp.executeManagedTool
services:
  - "@harness/gates/WorkspaceFs"
  - "@harness/gates/HarnessSubprocessRunner"
  - "@harness/gates/ActiveMutantContext"
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
informs:
  - harness:SPEC-0012
---

# ADR-0013 · Five-Tier Hexagonal Harness Package Topology and Pure Contract-Service Split

## Context and Problem Statement

Previously, the harness packages under `libs/harness/gates`, `libs/harness/graph`, and `libs/harness/ingest` carried dual Nx tags (`["type:contract", "type:service"]`) and co-located `effect/Schema` wire contracts, `Context.Service` capability ports, pure `*.decide` functions, and live Node/filesystem `Layer` implementations inside the same packages. Because `stub<A, E, R>` and shared gate schemas lived inside `@harness/gates`, `type:core` and `type:domain` libraries could not import `stub` or harness contract schemas without transitively pulling in `@harness/gates` infrastructure and Node-specific dependencies.

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

## Decision Outcome

**Chosen option:** "Option 1: Extract dedicated @harness/contract and @harness/service packages and eliminate dual Nx tier tags", because it aligns `libs/harness/*` with the workspace's five-tier hexagonal architecture, isolates `stub` and all shared schemas in `effect`-only `@harness/contract`, decouples `Context.Service` ports in `@harness/service` from live `Layer` implementations in `@harness/gates`, and enables deterministic verification via `HarnessTierTopology.decide`.

### Architectural Rules and Guarantees

1. `@harness/contract` (`libs/harness/contract`) carries `type:contract` only, depends exclusively on `effect`, and exports `stub`, `WorkspaceFsError`, `HarnessSubprocessError`, `SelfDogfoodingViolationError`, `TsCompilerOverlayError`, `CliCommandNotFoundError`, `UnknownToolError`, `DaemonServerError`, cache/daemon schemas, and tier-topology contract schemas.
2. `@harness/service` (`libs/harness/service`) carries `type:service` only, depends exclusively on `effect` and `@harness/contract`, and exports pure `Context.Service` ports (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`, `AstGateCachePort`, `DecisionCachePort`, `UnixSocketDaemonPort`, and host I/O ports) without Node or `type:infra` imports.
3. No `libs/harness/*` project may declare both `type:contract` and `type:service` in `project.json`.
4. `WorkspaceFs` exposes `statAndReadAll` for batched workspace file stat and UTF-8 reading behind the `@harness/gates/WorkspaceFs` capability seam, failing with typed `WorkspaceFsError`.
5. `@harness/infra` (`libs/harness/infra`) carries `type:infra` only and provides live `Layer` implementations built over `@effect/platform-node` (`NodeServices.layer`, `FileSystem.FileSystem`, `Path.Path`, `ChildProcessSpawner`, `ScopedCache`, `SynchronizedRef`, `Effect.acquireRelease`) for workspace I/O, subprocess execution, scoped AST/decision caches (`AstGateCachePort`, `DecisionCachePort`), and scoped `0600` Unix socket daemon lifecycle (`UnixSocketDaemonPort` failing with `DaemonServerError`).
6. Non-infra `libs/harness/*` packages (`type:contract`, `type:service`, `type:core`, `type:domain`) must maintain zero `node:*` imports and zero global mutable caches; all stateful caching and Node runtime bindings live in `@harness/infra`.
7. `apps/harness-cli` routes all CLI invocations declaratively through `effect/cli` (`Command.make`, `Flag`, `Argument`) and `NodeRuntime.runMain` in `HarnessCli.runDeclarativeCli`, exposing typed subcommands (`check-openapi`, `check-migrations`, `check-event-schemas`, `benchmark`, `scenario`) with zero production `Effect.runSync` calls.
8. `apps/harness-mcp` executes MCP tool requests through a scoped `ManagedRuntime` (`HarnessMcp.executeManagedTool`) over `McpToolRegistryLive` and `NodeServices.layer` with zero production `Effect.runSync` calls.

## Rejected Alternatives

### 1 · Option 2: Retain dual-tagged ["type:contract", "type:service"] packages

Keep schemas, `stub`, `Context.Service` ports, and live Node `Layer` implementations inside `libs/harness/{gates,graph,ingest}` with dual `["type:contract", "type:service"]` Nx tags.

**Why rejected:** Dual tier tags bypass Nx module-boundary checks, force `type:core` and `type:domain` packages to depend on `@harness/gates` just to use `stub`, and allow `type:service` ports to import Node I/O modules directly.

### 2 · Option 3: Collapse all harness libraries into a single monolithic package

Merge `ingest`, `decision`, `gates`, `graph`, `contract`, and `service` into one `@harness/core` package.

**Why rejected:** A monolithic harness package erases compile-time tier boundaries, slows incremental `nx affected` builds, and makes it impossible to enforce pure `R = never` deciders separately from stateful `Layer` providers.

## Consequences and Enforcement

### Positive Consequences

- `type:core` and `type:domain` packages import `stub` and gate schemas from `@harness/contract` with zero transitive infrastructure dependencies.
- `@harness/service` capability ports (`WorkspaceFs`, `HarnessSubprocessRunner`, `ActiveMutantContext`) can be satisfied by in-memory test `Layer`s without loading Node filesystem or subprocess modules.
- `HarnessTierTopology.decide` deterministically catches any regression in Nx tier tags, contract dependencies, service dependencies, or impure service-tier imports.

### Negative Consequences and Trade-offs

- Adding a new harness schema or `Context.Service` capability requires placing the schema/error in `libs/harness/contract`, the port in `libs/harness/service`, and the live `Layer` in `libs/harness/gates` or `libs/harness/graph`.
- Existing internal imports of `stub` and shared error/schema types must resolve through `@harness/contract` and `@harness/service` re-exports.

### Deterministic Enforcement

| Rule                                                                                                                               | Enforced By                                                                                             | Gate / Mechanism                                    | Governed Symbols                                                                                           |
| :--------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :-------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| Reject dual `type:contract` + `type:service` Nx tags (`dual-contract-tier-tag`)                                                    | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts` | `HarnessTierTopology.decide` (`harness gc --strict`) | `HarnessTierTopology.decide`                                                                               |
| Enforce `effect`-only dependencies on `type:contract` packages (`forbidden-contract-dependency`)                                   | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts` | `HarnessTierTopology.decide` (`harness gc --strict`) | `HarnessTierTopology.decide`                                                                               |
| Restrict `type:service` dependencies to `effect` and `type:contract` (`forbidden-service-dependency`)                              | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts` | `HarnessTierTopology.decide` (`harness gc --strict`) | `HarnessTierTopology.decide`                                                                               |
| Ban Node/infra imports inside `type:service` source files (`impure-service-tier-import`)                                           | `libs/harness/gates/src/plugins/harness-tier-topology.ts`, `libs/harness/contract/src/tier-topology.ts` | `HarnessTierTopology.decide` (`harness gc --strict`) | `HarnessTierTopology.decide`                                                                               |
| Batched workspace file stat/read via `WorkspaceFs` capability seam failing with `WorkspaceFsError`                                 | `libs/harness/gates/src/services/workspace-fs.ts`, `libs/harness/service/src/index.ts`, `libs/harness/infra/src/workspace-fs-live.ts` | `pnpm harness gc --strict` & `pnpm harness verify`  | `WorkspaceFs.statAndReadAll`, `WorkspaceFs.readAndVerifyFile`, `WorkspaceFsError`, `@harness/gates/WorkspaceFs` |
| Native Effect v4 `@harness/infra` (`type:infra`) adapters over `@effect/platform-node` (`NodeServices.layer`, `FileSystem.FileSystem`, `Path.Path`, `ChildProcessSpawner`, `ScopedCache`, `SynchronizedRef`, `Effect.acquireRelease`) with zero `node:*` or global mutable caches in non-infra `libs/harness/*` | `libs/harness/infra/src/index.ts`, `libs/harness/infra/src/ast-gate-cache-live.ts`, `libs/harness/infra/src/decision-cache-live.ts`, `libs/harness/infra/src/unix-socket-daemon-live.ts`, `libs/harness/infra/src/subprocess-runner-live.ts`, `libs/harness/infra/src/node-host-io.ts` | `pnpm harness gc --strict` & `pnpm harness verify`  | `AstGateCache.evaluateCached`, `DecisionCache.lookupOrCompute`, `UnixSocketDaemon.startScoped`, `@harness/service/AstGateCachePort`, `@harness/service/DecisionCachePort`, `@harness/service/UnixSocketDaemonPort`, `DaemonServerError` |
| Declarative `effect/cli` + `NodeRuntime.runMain` entry with typed repo-check & scenario subcommands (`check-openapi`, `check-migrations`, `check-event-schemas`, `benchmark`, `scenario`) and zero production `Effect.runSync` | `apps/harness-cli/src/commands/declarative-cli.ts`, `apps/harness-cli/src/commands/repo-checks.command.ts`, `apps/harness-cli/src/commands/scenario.command.ts`, `apps/harness-cli/src/commands/scenario-eval.ts` | `pnpm harness gc --strict` & `pnpm harness verify`  | `HarnessCli.runDeclarativeCli`, `HarnessCli.checkOpenApi`, `HarnessCli.checkMigrations`, `HarnessCli.checkEventSchemas`, `HarnessCli.runScenario` |
| Scoped `ManagedRuntime` MCP tool execution in `apps/harness-mcp` with zero production `Effect.runSync` | `apps/harness-mcp/src/managed-runtime.ts` | `pnpm harness gc --strict` & `pnpm harness verify`  | `HarnessMcp.executeManagedTool` |
