---
id: harness:SPEC-0012
title: Five-Tier Hexagonal Harness Package Topology and Pure Contract-Service Split
status: accepted
date: 2026-11-14
archetype: framework
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0012
  - harness:ADR-0013
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
  - DaemonServerError
---

# SPEC-0012 · Five-Tier Hexagonal Harness Package Topology and Pure Contract-Service Split

## Context

This specification defines the behavioral requirements for the five-tier hexagonal split of `libs/harness/*` governed by `harness:ADR-0013`. It separates pure `effect`-only contracts (`@harness/contract`) and pure `Context.Service` ports (`@harness/service`) from live `Layer` implementations (`@harness/gates`, `@harness/graph`), eliminating dual `["type:contract", "type:service"]` Nx tags and adding batched workspace file stat/read support to `WorkspaceFs`.

- **Reused Contracts / Errors:** `WorkspaceFsError`, `HarnessSubprocessError`, `SelfDogfoodingViolationError`
- **Reused Services:** `@harness/gates/WorkspaceFs`, `@harness/gates/HarnessSubprocessRunner`, `@harness/gates/ActiveMutantContext`
- **New Capabilities Needed:** `HarnessTierTopology.decide`, `WorkspaceFs.statAndReadAll`

## Goal

Every `libs/harness/*` package conforms to a single canonical Nx tier (`type:contract`, `type:service`, `type:core`/`type:domain`, or `type:infra`) enforced deterministically by `HarnessTierTopology.decide`, while `WorkspaceFs.statAndReadAll` provides batched workspace file stat and UTF-8 reading behind the `WorkspaceFs` capability seam.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and modal verb `shall` or `shall not`.

## Requirements

### 1 · Hexagonal Tier Topology Decider

**Source (`harness:ADR-0013`):** Pure `HarnessTierTopology.decide` (`R = never`) must deterministically detect dual contract-service Nx tier tags, forbidden `type:contract` dependencies, forbidden `type:service` dependencies, and impure Node or infrastructure imports inside `type:service` source files.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                   | Effect Symbol                | Verification   |
| :------ | :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------- | :------------- |
| REQ-1.1 | State-driven       | **While** every `libs/harness/*` package in `TierTopologyInput` has a single canonical Nx tier tag, valid `type:contract` and `type:service` dependencies, and zero impure imports in `type:service` sources, the `HarnessTierTopology.decide` decider **shall** return a clean `TierTopologyReport` with `R = never`. | `HarnessTierTopology.decide` | `PropertyTest` |
| REQ-1.2 | Unwanted behaviour | **If** any `libs/harness/*` project in `TierTopologyInput` declares both `type:contract` and `type:service` tags in `project.json`, **then** the `HarnessTierTopology.decide` decider **shall** report a `dual-contract-tier-tag` violation. | `HarnessTierTopology.decide` | `UnitTest`     |
| REQ-1.3 | Unwanted behaviour | **If** any `type:contract` package in `TierTopologyInput` declares a dependency outside `effect`, **then** the `HarnessTierTopology.decide` decider **shall** report a `forbidden-contract-dependency` violation.                           | `HarnessTierTopology.decide` | `UnitTest`     |
| REQ-1.4 | Unwanted behaviour | **If** any `type:service` package in `TierTopologyInput` declares a dependency outside `effect` and `type:contract`, **then** the `HarnessTierTopology.decide` decider **shall** report a `forbidden-service-dependency` violation.         | `HarnessTierTopology.decide` | `UnitTest`     |
| REQ-1.5 | Unwanted behaviour | **If** any `type:service` source file in `TierTopologyInput` imports a Node built-in or `type:infra` module, **then** the `HarnessTierTopology.decide` decider **shall** report an `impure-service-tier-import` violation.                  | `HarnessTierTopology.decide` | `UnitTest`     |

### 2 · Pure Contract-Service Workspace File Batching

**Source (`harness:ADR-0013`):** `WorkspaceFs` must support batched file stat and UTF-8 content retrieval via `WorkspaceFs.statAndReadAll` with typed `WorkspaceFsError` failures.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                   | Effect Symbol                | Verification |
| :------ | :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------- | :----------- |
| REQ-2.1 | Event-driven       | **When** `WorkspaceFs.statAndReadAll` is invoked with a list of `WorkspaceFilePath` values, the `WorkspaceFs.statAndReadAll` use-case **shall** yield `WorkspaceFs` from `R` and return the stat metadata and UTF-8 content for each readable file. | `WorkspaceFs.statAndReadAll`   | `UnitTest`   |
| REQ-2.2 | Unwanted behaviour | **If** a target `WorkspaceFilePath` passed to `WorkspaceFs.statAndReadAll` fails to stat or read due to an OS I/O error, **then** the `WorkspaceFs.statAndReadAll` use-case **shall** fail with a typed `WorkspaceFsError`.                     | `WorkspaceFsError`             | `UnitTest`   |
| REQ-2.3 | Unwanted behaviour | **If** a subprocess invoked through `HarnessSubprocess.execChecked` exits with a non-zero status code, **then** the `HarnessSubprocess.execChecked` use-case **shall** fail with a typed `HarnessSubprocessError` from `@harness/contract`.    | `HarnessSubprocessError`       | `UnitTest`   |
| REQ-2.4 | Unwanted behaviour | **If** `GatePluginRunner.evaluateAll` evaluates files containing self-dogfooding violations with `failOnViolation` enabled, **then** the `GatePluginRunner.evaluateAll` use-case **shall** fail with a typed `SelfDogfoodingViolationError`.  | `SelfDogfoodingViolationError` | `UnitTest`   |

### 3 · Native Effect v4 Infrastructure Adapters, Scoped Caches, and Daemon Lifecycle

**Source (`harness:ADR-0013`):** `@harness/infra` (`type:infra`) must provide live Effect v4 `NodeServices.layer`, `ScopedCache`, `SynchronizedRef`, and `Effect.acquireRelease` adapters behind `@harness/service` ports (`AstGateCachePort`, `DecisionCachePort`, `UnixSocketDaemonPort`) so non-infra `libs/harness/*` packages remain free of `node:*` imports and global mutable caches.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                   | Effect Symbol                    | Verification |
| :------ | :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------- | :----------- |
| REQ-3.1 | Event-driven       | **When** `AstGateCache.evaluateCached` is invoked with a batch of `AstGateFileBatchInput` items, the `AstGateCache.evaluateCached` use-case **shall** yield `AstGateCachePort` from `R` and return an `AstGateEvaluationReport` reusing cached file digests across invocations. | `AstGateCache.evaluateCached`    | `UnitTest`   |
| REQ-3.2 | Event-driven       | **When** `DecisionCache.lookupOrCompute` is invoked with a `DecisionCacheKey` and computation effect, the `DecisionCache.lookupOrCompute` use-case **shall** yield `DecisionCachePort` from `R` and memoize the serialized payload within the scoped cache. | `DecisionCache.lookupOrCompute`  | `UnitTest`   |
| REQ-3.3 | Event-driven       | **When** `UnixSocketDaemon.startScoped` is invoked within an Effect `Scope`, the `UnixSocketDaemon.startScoped` use-case **shall** yield `UnixSocketDaemonPort` from `R`, bind a `0600` Unix socket, and remove the socket file upon scope finalization. | `UnixSocketDaemon.startScoped`   | `UnitTest`   |
| REQ-3.4 | Unwanted behaviour | **If** binding or hardening the Unix socket in `UnixSocketDaemon.startScoped` fails, **then** the `UnixSocketDaemon.startScoped` use-case **shall** fail with a typed `DaemonServerError`. | `DaemonServerError`              | `UnitTest`   |

### 4 · Declarative Effect CLI, Typed Repo-Check Subcommands, and ManagedRuntime MCP Server

**Source (`harness:ADR-0013`):** `apps/harness-cli` and `apps/harness-mcp` must eliminate manual `Effect.runSync` dispatch in favor of declarative `effect/cli` + `NodeRuntime.runMain`, typed repository check and scenario subcommands (`check-openapi`, `check-migrations`, `check-event-schemas`, `benchmark`, `scenario`), and a scoped `ManagedRuntime` MCP tool executor.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                     | Effect Symbol                   | Verification |
| :------ | :----------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------ | :----------- |
| REQ-4.1 | Event-driven | **When** `HarnessCli.runDeclarativeCli` is invoked with CLI argument vectors and `CliEnv` options, the `HarnessCli.runDeclarativeCli` command runner **shall** parse flags via `effect/cli` and execute the matched subcommand via Effect runtime without `Effect.runSync`. | `HarnessCli.runDeclarativeCli`  | `UnitTest`     |
| REQ-4.2 | Event-driven | **When** the `check-openapi` subcommand is executed through `HarnessCli.checkOpenApi`, the `HarnessCli.checkOpenApi` subcommand **shall** validate OpenAPI schema consistency and return a `CliResult`.                                         | `HarnessCli.checkOpenApi`       | `UnitTest`     |
| REQ-4.3 | Event-driven | **When** the `check-migrations` subcommand is executed through `HarnessCli.checkMigrations`, the `HarnessCli.checkMigrations` subcommand **shall** verify migration safety and return a `CliResult`.                                            | `HarnessCli.checkMigrations`    | `UnitTest`     |
| REQ-4.4 | Event-driven | **When** the `check-event-schemas` subcommand is executed through `HarnessCli.checkEventSchemas`, the `HarnessCli.checkEventSchemas` subcommand **shall** validate event-sourcing schemas against `@harness/es-contract` and return a `CliResult`. | `HarnessCli.checkEventSchemas`  | `UnitTest`     |
| REQ-4.5 | Event-driven | **When** the `scenario` subcommand is executed through `HarnessCli.runScenario`, the `HarnessCli.runScenario` subcommand **shall** evaluate typed scenario steps and return a `CliResult`.                                                      | `HarnessCli.runScenario`        | `UnitTest`     |
| REQ-4.6 | Event-driven | **When** `HarnessMcp.executeManagedTool` is invoked with a `DispatchMcpToolInput` request, the `HarnessMcp.executeManagedTool` runtime handler **shall** execute the tool through a scoped `ManagedRuntime` without `Effect.runSync`.            | `HarnessMcp.executeManagedTool` | `UnitTest`     |

### 5 · Permanent Self-Dogfooding Hexagonal Gates and Uniform AST Enforcement

**Source (`harness:ADR-0013`):** `SelfDogfooding.decide` and `AstGateCache.decide` must permanently enforce hexagonal hygiene (banning global mutable caches, Node I/O built-ins outside `type:infra`, `Layer.build` inside `Layer.effect`, and double-wrapped `Effect.fn`) and remove `isHarnessInternal` AST exemptions across `libs/harness/*` and `apps/harness-*`.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                   | Effect Symbol           | Verification |
| :------ | :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------- | :----------- |
| REQ-5.1 | Unwanted behaviour | **If** any production source file in `SelfDogfoodingInput` declares a module-scope `let` variable, an empty or Weak module-scope `Map`/`Set`/`WeakMap`/`WeakSet`, or mutates a module-scope `Map`/`Set` via `.set`, `.add`, `.delete`, or `.clear`, **then** the `SelfDogfooding.decide` decider **shall** report a `no-global-mutable-cache` violation. | `SelfDogfooding.decide` | `UnitTest`     |
| REQ-5.2 | Unwanted behaviour | **If** any non-`type:infra` production source file in `SelfDogfoodingInput` imports a Node I/O built-in module (`node:fs`, `node:fs/promises`, `fs`, `fs/promises`, `node:child_process`, `child_process`, `node:net`, `net`, `node:os`, `os`, `node:http`, `http`, `node:https`, `https`), **then** the `SelfDogfooding.decide` decider **shall** report a `no-node-builtins-outside-infra` violation. | `SelfDogfooding.decide` | `UnitTest`     |
| REQ-5.3 | Unwanted behaviour | **If** any production source file in `SelfDogfoodingInput` invokes `Layer.build` inside `Layer.effect`, **then** the `SelfDogfooding.decide` decider **shall** report a `no-layer-build-in-layer-effect` violation. | `SelfDogfooding.decide` | `UnitTest`     |
| REQ-5.4 | Unwanted behaviour | **If** any production source file in `SelfDogfoodingInput` wraps a function returning `Effect.gen` inside `Effect.fn` or `Effect.fnUntraced`, **then** the `SelfDogfooding.decide` decider **shall** report a `no-double-wrapped-effect-fn` violation. | `SelfDogfooding.decide` | `UnitTest`     |
| REQ-5.5 | Event-driven       | **When** `AstGateCache.decide` evaluates source files under `libs/harness/*` or `apps/harness-*`, the `AstGateCache.decide` visitor **shall** enforce `discriminant-branching` and `unscoped-effect-run` uniformly without `isHarnessInternal` exemptions. | `AstGateCache.decide`   | `UnitTest`     |

## Assumptions

- **REQ-1.1:** `@harness/contract` (`libs/harness/contract`) is tagged `type:contract` only and `@harness/service` (`libs/harness/service`) is tagged `type:service` only; `@harness/gates`, `@harness/graph`, and `@harness/ingest` drop dual `["type:contract", "type:service"]` tags.
- **REQ-2.1:** `WorkspaceFs.statAndReadAll` preserves input path ordering and delegates filesystem operations to the injected `WorkspaceFs` `Layer`.

## Out of scope

- **Splitting `libs/sample/*` or `libs/es/*`:** Application and event-sourcing packages already use separate `contract`, `service`, `domain`/`core`, and `infra` projects.

## Known residual risks

- Legacy re-export shims in `@harness/gates` for `stub` and contract schemas must be kept in sync with `@harness/contract` until all external consumers migrate directly to `@harness/contract`.

## Acceptance criteria

- All requirement rows pass their declared verification method (`PropertyTest`, `UnitTest`).
- `HarnessTierTopology.decide` verifies zero `dual-contract-tier-tag`, `forbidden-contract-dependency`, `forbidden-service-dependency`, and `impure-service-tier-import` violations across `libs/harness/*`.
- `pnpm harness plan-check`, `pnpm harness gc --strict`, and `CI=true pnpm harness verify` pass with zero errors.
