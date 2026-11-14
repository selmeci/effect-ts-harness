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
  - libs/harness/service/src/index.ts
  - libs/harness/gates/src/plugins/harness-tier-topology.ts
  - libs/harness/gates/src/services/workspace-fs.ts
spans:
  - HarnessTierTopology.decide
  - WorkspaceFs.statAndReadAll
  - WorkspaceFs.readAndVerifyFile
  - HarnessSubprocess.execChecked
  - MutationCheck.withActiveMutant
services:
  - "@harness/gates/WorkspaceFs"
  - "@harness/gates/HarnessSubprocessRunner"
  - "@harness/gates/ActiveMutantContext"
errors:
  - WorkspaceFsError
  - HarnessSubprocessError
  - SelfDogfoodingViolationError
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
