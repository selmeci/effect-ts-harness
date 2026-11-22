---
id: harness:ADR-0021
title: Typed Workflow Activity Protocol, Single-Source Timeout Budgets, and Fenced Omnigraph Mutations
status: accepted
date: 2026-11-22
deciders:
  - "@harness/architecture"
scope: harness
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
informs:
  - harness:SPEC-0027
---

# ADR-0021 · Typed Workflow Activity Protocol, Single-Source Timeout Budgets, and Fenced Omnigraph Mutations

## Context and Problem Statement

PR #44 post-mortem analysis identified three coupling and safety hazards across the workflow orchestration control plane. First, `Harness.executeTaskWorkflow` and projection activities formatted workflow activity and `DurableDeferred` names via inline template literals while `read-model-rebuild.ts` and `read-model-rebuild-journal.ts` decoded them with independent ad-hoc regular expressions, allowing typos, non-canonical cycle suffixes (`/r1`), or unrecognized activity names to fail inconsistently or silently become no-ops. Second, socket, daemon IPC, unit verification, HTTP store, lease TTL, and RPC settle-loop timeouts were scattered as unlinked numeric literals across `@harness/infra` and `harness-mcp`, enabling timeout-layer inversions where an inner verification or polling budget outlived its enclosing IPC deadline.

Third, single-writer fencing against `harness-workflows` depended on discipline alone for propagating `expectedLeaseEpoch` and `expectedLeaseOwner` into every non-lease `expectMutation: true` call on `WorkflowStore.invoke` / `WorkflowStore.invokeWithMeta` / `invokeWorkflowStoreQueryOnce`, with no AST gate preventing unfenced write queries or owner-fencing gaps such as `quarantineOrphanEntityMessages`.

## Decision Drivers

- **Single Canonical Wire Codec Without String-Template Drift:** Unify all 18 activity variants (`WorkflowActivityTag`) and 4 durable deferred variants (`WorkflowDeferredTag`) under symmetric encode/decode functions in `@harness/contract` that fail closed on malformed or unrecognized names.
- **Monotonically Validated Single-Source Timeout Hierarchy:** Consolidate all workflow daemon, client, verifier, store HTTP, claim, lease heartbeat, and settle-loop budgets into `WORKFLOW_TIMEOUT_BUDGETS` with explicit strict monotonicity checks (`validateWorkflowTimeoutBudgets`).
- **Static AST Lease Fencing and Owner Propagation:** Enforce `expectedLeaseEpoch` propagation on non-lease `expectMutation: true` calls in production `src/` via `SelfDogfooding.decide` (`omnigraph-fenced-mutation`), while closing `expectedLeaseOwner` propagation into orphan-entity quarantine.
- **Line-Budget Isolation and Automatic Cache Invalidation:** Keep new codecs, timeout budgets, and AST detectors in dedicated compact modules (`workflow-protocol.ts`, `workflow-timeouts.ts`, `ast-workflow-fence-law.ts`) and register the new AST rule module in `AST_GATE_RULE_SOURCE_FILES`.

## Considered Options

- **Option 1:** Extract `workflow-protocol.ts` and `workflow-timeouts.ts` in `@harness/contract`, delete all inline activity/deferred string builders and ad-hoc rebuild regexes in place, consolidate all consumer timeouts onto `WORKFLOW_TIMEOUT_BUDGETS`, add `ast-workflow-fence-law.ts` to `SelfDogfooding.decide` and `AST_GATE_RULE_SOURCE_FILES`, and propagate `expectedLeaseOwner` through `quarantineOrphanEntityMessages`.
- **Option 2:** Keep inline activity/deferred templates alongside dual regex parsers and centralize only documentation tables checking timeout numbers manually.
- **Option 3:** Enforce writer lease fencing purely at runtime inside `OmnigraphWorkflowStore` without a compile/lint AST gate.

## Decision Outcome

**Chosen option:** "Option 1: Extract `workflow-protocol.ts` and `workflow-timeouts.ts` in `@harness/contract`, delete all inline activity/deferred string builders and ad-hoc rebuild regexes in place, consolidate all consumer timeouts onto `WORKFLOW_TIMEOUT_BUDGETS`, add `ast-workflow-fence-law.ts` to `SelfDogfooding.decide` and `AST_GATE_RULE_SOURCE_FILES`, and propagate `expectedLeaseOwner` through `quarantineOrphanEntityMessages`", because it eliminates producer/consumer protocol skew, prevents timeout inversions structurally, and catches unfenced Omnigraph mutations at lint/gate time.

### Architectural Rules and Guarantees

1. **Symmetric Workflow Protocol Codecs (`REQ-1.1`..`REQ-1.3`):** `workflow-protocol.ts` defines the closed `WorkflowActivityTag` (18 variants, including `WorkflowRunAbortTarget` disambiguating `Unit` with `unitId = "merge"` from `Merge`) and `WorkflowDeferredTag` (4 variants) unions plus `encodeWorkflowActivityName`, `decodeWorkflowActivityName`, `encodeWorkflowDeferredName`, and `decodeWorkflowDeferredName`. Journal replay decodes every activity and deferred name exclusively through these decoders and fails closed with `WorkflowStoreUnavailableError` on unrecognized or non-canonical names (such as `/r1` or leading-zero indices).
2. **Single-Source Monotonic Timeout Budgets (`REQ-2.1`..`REQ-2.2`):** `WORKFLOW_TIMEOUT_BUDGETS` in `workflow-timeouts.ts` is the sole authority for daemon socket, server socket, workflow IPC, unit verifier, store HTTP, claim expiry, writer lease TTL, and poll/abort settle budgets. `validateWorkflowTimeoutBudgets` strictly enforces `workflowServerSocketMs > workflowCompleteIpcMs > unitVerifyMs + pollSettleBudgetMs` and `defaultServerSocketMs > workflowIpcMs > abortSettleBudgetMs`.
3. **Static Lease Fencing AST Gate (`REQ-3.1`..`REQ-3.2`):** `isUnfencedOmnigraphMutationCall` in `ast-workflow-fence-law.ts` (`SelfDogfoodingRuleId`: `omnigraph-fenced-mutation`, hashed in `AST_GATE_RULE_SOURCE_FILES`) flags any non-lease `expectMutation: true` workflow store call in `src/` missing `expectedLeaseEpoch` (property, shorthand, or `/fence|target/i` spread), exempting only `LEASE_MANAGEMENT_QUERY_NAMES` (`wf_insert_writer_lease`, `wf_cas_writer_lease`, `wf_refresh_writer_lease`) and offline maintenance guarded by `verifyOfflineClusterAccess`. `quarantineOrphanEntityMessages` propagates `expectedLeaseOwner` across both mutation steps.

## Rejected Alternatives

### 1 · Option 2: Dual Compatibility Regexes and Duplicated Timeout Constants

Retain legacy string-template activity constructors in `harness-task-workflow.ts` alongside fallback regexes in `read-model-rebuild.ts`, relying on convention to keep timeouts ordered.

**Why rejected:** Duplicated producers and consumers inevitably diverge under rapid schema iteration, and independent numeric literals caused the PR #44 `workflow.complete` IPC/socket timeout inversion (`F-7.1`).

### 2 · Option 3: Runtime-Only Lease Fence Checks Without Static AST Enforcement

Rely solely on `OmnigraphWorkflowStore` runtime checks and code review to catch missing `expectedLeaseEpoch` arguments on new `expectMutation: true` call sites.

**Why rejected:** Missing `expectedLeaseEpoch` on a new caller fails silently into unfenced `WorkflowStoreUnavailableError` coercion unless a static AST rule blocks unfenced call sites before runtime.

## Consequences and Enforcement

### Positive Consequences

- Every workflow activity and deferred string emitted during execution matches 1-for-1 with journal reconstruction via symmetric encode/decode contracts, achieving 100% mutation kill scores across `workflow-protocol.ts`, `workflow-timeouts.ts`, `ast-workflow-fence-law.ts`, `harness-task-workflow.ts`, `harness-task-workflow-projections.ts`, and `read-model-rebuild-journal.ts`.
- All production workflow store mutations in `libs/` and `apps/` pass `omnigraph-fenced-mutation` without exception, and `quarantineOrphanEntityMessages` rejects `expectedLeaseOwner` mismatches before mutating graph state.

### Negative Consequences and Trade-offs

- Adding any new workflow activity, durable deferred, or lease-management query requires updating `WorkflowActivityTag` / `WorkflowDeferredTag` or `LEASE_MANAGEMENT_QUERY_NAMES` rather than emitting ad-hoc strings.
- Synthetic test journal entries must use valid canonical `WorkflowActivityTag` names (for example `ProvisionWorktrees`) because unrecognized activity strings now fail closed during journal rebuild.

### Deterministic Enforcement

| Rule                                                                        | Enforced By                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Gate / Mechanism                                                                                                                          | Governed Symbols                                                                |
| :-------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| Canonical typed workflow activity and deferred round-trip protocol          | `libs/harness/contract/src/workflow-protocol.ts`, `libs/harness/contract/src/index.ts`, `libs/harness/gates/src/harness-task-workflow.ts`, `libs/harness/gates/src/harness-task-workflow-projections.ts`, `libs/harness/infra/src/workflow/read-model-rebuild.ts`, `libs/harness/infra/src/workflow/read-model-rebuild-journal.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-status-helper.ts`, `libs/harness/contract/test/workflow-protocol.test.ts`, `libs/harness/infra/test/workflow-replay-differential.test.ts`, `libs/harness/infra/test/workflow-read-model.test.ts` | Symmetric `encodeWorkflowActivityName`/`decodeWorkflowActivityName` and `encodeWorkflowDeferredName`/`decodeWorkflowDeferredName` codecs  | `Harness.executeTaskWorkflow`, `Harness.rebuildWorkflowReadModelViews`          |
| Single-source monotonically validated timeout and polling budgets           | `libs/harness/contract/src/workflow-timeouts.ts`, `libs/harness/infra/src/workflow/daemon-client.ts`, `libs/harness/infra/src/unix-socket-daemon-live.ts`, `libs/harness/infra/src/workflow/unit-verifier-live.ts`, `libs/harness/infra/src/omnigraph-message-storage.ts`, `libs/harness/infra/src/writer-lease.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-complete-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-daemon-helper.ts`, `libs/harness/infra/test/worktree-and-daemon-protocol.test.ts`                                                                | `WORKFLOW_TIMEOUT_BUDGETS` and `validateWorkflowTimeoutBudgets` strict monotonicity checks                                                | `HarnessDaemonClient.queryCommand`                                              |
| Static AST `omnigraph-fenced-mutation` rule and owner lease-fencing closure | `libs/harness/contract/src/ast-and-gate-primitives.ts`, `libs/harness/gates/src/plugins/ast-workflow-fence-law.ts`, `libs/harness/gates/src/plugins/self-dogfooding-plugin.ts`, `libs/harness/gates/src/ast-cache.ts`, `libs/harness/infra/src/omnigraph-workflow-store.ts`, `libs/harness/infra/src/workflow-engine-live.ts`, `libs/harness/gates/test/self-dogfooding-capability-plugins.test.ts`, `libs/harness/infra/test/workflow-storage-fencing-and-recovery.test.ts`                                                                                                   | `isUnfencedOmnigraphMutationCall` in `SelfDogfooding.decide` + `AST_GATE_RULE_SOURCE_FILES` hash + `expectedLeaseOwner` orphan quarantine | `SelfDogfooding.decide`, `WorkflowStore.invoke`, `WorkflowStore.invokeWithMeta` |
