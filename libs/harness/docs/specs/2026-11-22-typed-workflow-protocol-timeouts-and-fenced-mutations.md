---
id: harness:SPEC-0027
title: Typed Workflow Activity Protocol, Single-Source Timeout Budgets, and Fenced Omnigraph Mutations
status: accepted
archetype: framework
date: 2026-11-22
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0021
enforced_by:
  - libs/harness/contract/src/workflow-protocol.ts
  - libs/harness/contract/src/workflow-timeouts.ts
  - libs/harness/contract/src/index.ts
  - libs/harness/contract/src/ast-and-gate-primitives.ts
  - libs/harness/gates/src/harness-task-workflow.ts
  - libs/harness/gates/src/harness-task-workflow-projections.ts
  - libs/harness/gates/src/plugins/ast-workflow-fence-law.ts
  - libs/harness/gates/src/plugins/self-dogfooding-plugin.ts
  - libs/harness/gates/src/ast-cache.ts
  - libs/harness/infra/src/workflow/read-model-rebuild.ts
  - libs/harness/infra/src/workflow/read-model-rebuild-journal.ts
  - libs/harness/infra/src/workflow/daemon-client.ts
  - libs/harness/infra/src/unix-socket-daemon-live.ts
  - libs/harness/infra/src/workflow/unit-verifier-live.ts
  - libs/harness/infra/src/omnigraph-workflow-store.ts
  - libs/harness/infra/src/omnigraph-message-storage.ts
  - libs/harness/infra/src/writer-lease.ts
  - libs/harness/infra/src/workflow-engine-live.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-complete-helper.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-daemon-helper.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-status-helper.ts
  - libs/harness/contract/test/workflow-protocol.test.ts
  - libs/harness/gates/test/self-dogfooding-capability-plugins.test.ts
  - libs/harness/infra/test/workflow-replay-differential.test.ts
  - libs/harness/infra/test/worktree-and-daemon-protocol.test.ts
  - libs/harness/infra/test/workflow-storage-fencing-and-recovery.test.ts
  - libs/harness/infra/test/workflow-read-model.test.ts
spans:
  - Harness.executeTaskWorkflow
  - Harness.rebuildWorkflowReadModelViews
  - WorkflowStore.invoke
  - WorkflowStore.invokeWithMeta
  - HarnessDaemonClient.queryCommand
  - SelfDogfooding.decide
services: []
errors: []
---

## Context

Post-mortem analysis of PR #44 surfaced three cross-package protocol and safety fragility points in the workflow control plane. First, workflow activity names (`ProjectUnitDispatched/...`, `VerifyUnit/...`, `VerifySharedStep/...`, `MergeSliceWave/...`, `ProjectWaveMergeRetried/...`) and durable deferred names (`unit/...`, `escalation/...`, `llm-phase-done`) are built with inline string templates across `harness-task-workflow.ts` and `harness-task-workflow-projections.ts`, then parsed with duplicated ad-hoc regexes inside `read-model-rebuild.ts` and `read-model-rebuild-journal.ts`. Second, timeout budgets for workflow verification, daemon IPC, server socket timeouts, and RPC settle polling are duplicated as magic numbers across `unit-verifier-live.ts` (`120_000`), `daemon-client.ts` (`30_000`, `150_000`), `unix-socket-daemon-live.ts` (`5_000`, `35_000`, `160_000`), `workflow-rpc-complete-helper.ts` (`80 * 25 ms`), and `workflow-rpc-daemon-helper.ts` (`200 * 50 ms`), which enabled the timeout-layer inversion fixed in PR #44 (`F-7.1`).

In addition, single-writer fencing against `harness-workflows` relies on every non-lease `expectMutation: true` query propagating `expectedLeaseEpoch` and `expectedLeaseOwner` into `WorkflowStore.invoke` / `WorkflowStore.invokeWithMeta`, yet no deterministic AST gate currently catches unfenced `expectMutation: true` call sites before runtime.

- **Reused Contracts / Errors:** `WorkUnitId`, `AttemptNumber`, `EscalationOrdinal`, `WaveIndex`, `WorkflowStoreUnavailableError`, `WriterLeaseHeldError` from `@harness/contract`
- **Reused Services:** `WorkflowProjectionWriter`, `WorkflowReadModelQuery` from `@harness/service`
- **New Capabilities Needed:** Canonical `WorkflowActivityTag` and `WorkflowDeferredTag` tagged unions with symmetric encode/decode codecs (`workflow-protocol.ts`), canonical `WORKFLOW_TIMEOUT_BUDGETS` contract with monotonicity assertions (`workflow-timeouts.ts`), and `omnigraph-fenced-mutation` AST enforcement rule in `SelfDogfooding.decide`

## Goal

Workflow activity and deferred names share one canonical round-trip protocol between workflow execution and journal replay, all workflow timeout and polling budgets derive from a single monotonically validated contract, and every non-lease Omnigraph mutation is statically proven to carry single-writer lease fencing.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Typed Workflow Activity and Deferred Name Protocol

**Source (`libs/harness/gates/src/harness-task-workflow.ts`, `libs/harness/gates/src/harness-task-workflow-projections.ts`, `libs/harness/infra/src/workflow/read-model-rebuild.ts`, `libs/harness/infra/src/workflow/read-model-rebuild-journal.ts`):** Eliminates string-template / regex drift between workflow activity/deferred producers and journal replay consumers.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                             | Effect Symbol                           | Verification |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------ |
| REQ-1.1 | Ubiquitous         | The `Harness.executeTaskWorkflow` orchestration **shall** construct every workflow activity name and durable deferred name exclusively through canonical typed encoders in `workflow-protocol.ts` (`@harness/contract`).                                | `Harness.executeTaskWorkflow`           | `UnitTest`   |
| REQ-1.2 | Event-driven       | **When** replaying persisted workflow journal entries, `Harness.rebuildWorkflowReadModelViews` **shall** decode activity and deferred names exclusively through `decodeWorkflowActivityName` and `decodeWorkflowDeferredName` from `@harness/contract`. | `Harness.rebuildWorkflowReadModelViews` | `UnitTest`   |
| REQ-1.3 | Unwanted behaviour | **If** a persisted journal activity or deferred name fails `decodeWorkflowActivityName` or `decodeWorkflowDeferredName` validation, **then** `Harness.rebuildWorkflowReadModelViews` **shall** fail closed with `WorkflowStoreUnavailableError`.        | `Harness.rebuildWorkflowReadModelViews` | `UnitTest`   |

### 2 · Single-Source Workflow Timeout Budget Hierarchy

**Source (`libs/harness/infra/src/workflow/daemon-client.ts`, `libs/harness/infra/src/unix-socket-daemon-live.ts`, `libs/harness/infra/src/workflow/unit-verifier-live.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-complete-helper.ts`):** Prevents timeout-layer inversions where an inner verification or settle loop outlives the IPC or socket deadline wrapping it.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                   | Effect Symbol                      | Verification |
| ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------ |
| REQ-2.1 | Ubiquitous   | `HarnessDaemonClient.queryCommand` and all daemon socket, unit-verifier, and RPC settle loops **shall** source timeout and polling constants from `WORKFLOW_TIMEOUT_BUDGETS` in `workflow-timeouts.ts` (`@harness/contract`).                                                 | `HarnessDaemonClient.queryCommand` | `UnitTest`   |
| REQ-2.2 | State-driven | **While** validating `WORKFLOW_TIMEOUT_BUDGETS`, the timeout budget validator **shall** enforce strict monotonicity (`workflowServerSocketMs > workflowCompleteIpcMs > unitVerifyMs + pollSettleBudgetMs` and `defaultServerSocketMs > workflowIpcMs > abortSettleBudgetMs`). | `HarnessDaemonClient.queryCommand` | `UnitTest`   |

### 3 · Static Lease-Fencing Gate for Omnigraph Workflow Mutations

**Source (`libs/harness/gates/src/plugins/self-dogfooding-plugin.ts`, `libs/harness/infra/src/omnigraph-workflow-store.ts`):** Guarantees every non-lease Omnigraph mutation propagates single-writer lease fencing.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                 | Effect Symbol           | Verification |
| ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------ |
| REQ-3.1 | Unwanted behaviour | **If** a production `src/` file invokes `WorkflowStore.invoke` or `WorkflowStore.invokeWithMeta` (or `invokeWorkflowStoreQueryOnce`) with `expectMutation: true` on a non-lease query without propagating `expectedLeaseEpoch`, **then** `SelfDogfooding.decide` **shall** report an `omnigraph-fenced-mutation` violation. | `SelfDogfooding.decide` | `AstGate`    |
| REQ-3.2 | State-driven       | **While** executing non-lease mutations against `harness-workflows`, `WorkflowStore.invoke` and `WorkflowStore.invokeWithMeta` **shall** enforce `expectedLeaseEpoch` and `expectedLeaseOwner` checks before mutating graph state.                                                                                          | `WorkflowStore.invoke`  | `UnitTest`   |

## Assumptions

- **REQ-1.1 / REQ-1.2:** Because this repository is in active experimental development, duplicated inline activity/deferred string builders and ad-hoc parser regexes are deleted in place rather than wrapped with legacy compatibility aliases.
- **REQ-3.1:** Explicit lease bootstrap/refresh queries in `LEASE_MANAGEMENT_QUERY_NAMES` (`wf_insert_writer_lease`, `wf_cas_writer_lease`, `wf_refresh_writer_lease`) and offline maintenance queries guarded by `verifyOfflineClusterAccess` are explicitly tracked by the AST fence exemption table.

## Out of scope

- **Contract shape hardening, adversarial policy property fuzzer, and test hygiene gates (P1-B).** Specified separately in `harness:SPEC-0028`.
- **Semantic documentation truth and multi-specialist review hardening (P2).** Specified in `SPEC-0029`..`SPEC-0030`.

## Known residual risks

- Updating inline activity/deferred formats in `workflow-protocol.ts` invalidates pre-existing unmigrated local Omnigraph test journals if tested across versions, mitigated by running clean journal rebuild tests against the same canonical encoder/decoder pair.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`UnitTest`, `AstGate`).
- All touched files in `@harness/contract` and `@harness/gates` stay strictly within tier line-count caps post-`oxfmt`, and `AST_GATE_RULE_SOURCE_FILES` includes `ast-workflow-fence-law.ts`.
- `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, `pnpm harness mutate --strict`, `CI=true pnpm harness verify`, and `CI=true pnpm harness done` pass after updating frontmatter to `status: accepted`.
