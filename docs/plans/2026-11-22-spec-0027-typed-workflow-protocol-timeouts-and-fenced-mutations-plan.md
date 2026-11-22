---
title: "SPEC-0027 Implementation Plan: Typed Workflow Activity Protocol, Single-Source Timeout Budgets, and Fenced Omnigraph Mutations"
type: feat
status: proposed
date: 2026-11-22
spec: harness:SPEC-0027
---

# Goal

Implement `harness:SPEC-0027` (P1-A of the PR #44 post-mortem harness hardening roadmap) across `@harness/contract`, `@harness/gates`, `@harness/infra`, and `harness-mcp`: unify workflow activity/deferred names behind a symmetric tagged codec, centralize all workflow timeout/polling budgets with monotonicity invariants, and enforce static AST lease fencing on every non-lease Omnigraph mutation.

---

## 1. Scope & Line-Budget Decomposition Strategy

Existing contracts and self-dogfooding modules sit near package limits (`libs/harness/contract/src/workflow.ts`: 650 lines, `workflow-storage.ts`: 747 lines, `libs/harness/gates/src/plugins/self-dogfooding-plugin.ts`: 776 lines). Isolate the new protocol, timeout budgets, and AST rule into compact leaf modules:

1. `libs/harness/contract/src/workflow-protocol.ts` (`<= 280` lines) — closed `WorkflowActivityTag` & `WorkflowDeferredTag` tagged unions + `encodeWorkflowActivityName`, `decodeWorkflowActivityName`, `encodeWorkflowDeferredName`, `decodeWorkflowDeferredName`.
2. `libs/harness/contract/src/workflow-timeouts.ts` (`<= 120` lines) — branded timeout schema (`WorkflowTimeoutMs`, `WorkflowPollBudget`) + canonical `WORKFLOW_TIMEOUT_BUDGETS` and `validateWorkflowTimeoutBudgets`.
3. `libs/harness/gates/src/plugins/ast-workflow-fence-law.ts` (`<= 140` lines) — AST detector for `omnigraph-fenced-mutation`, wired into `self-dogfooding-plugin.ts` and registered in `AST_GATE_RULE_SOURCE_FILES` (`ast-cache.ts`).

---

## 2. Effect Building-Block Mapping & Exact File Changes

### Unit 1 · Typed Workflow Activity & Deferred Protocol (`REQ-1.1`..`REQ-1.3`)

- **Canonical Protocol Codecs (`libs/harness/contract/src/workflow-protocol.ts`, `index.ts`):**
  - Define closed `Schema.TaggedUnion` schemas: `WorkflowActivityTag` (`ProvisionWorktrees`, `ProjectRunStarted`, `ProjectRunWaitingLlmPhase`, `ProjectRunCompleted`, `ProjectRunAborted`, `RouteReview`, `MergeSliceWave`, `ProjectWaveMergeEscalated`, `ProjectWaveMergeRetried`, `ProjectUnitDispatched`, `ProjectUnitCompleted`, `ProjectUnitRejected`, `ProjectUnitAttemptEscalated`, `ProjectUnitEscalated`, `ProjectUnitEscalationRetried`, `DispatchUnitAgent`, `VerifyUnit`, `VerifySharedStep`) and `WorkflowDeferredTag` (`LlmPhaseDone`, `InterruptSignal`, `UnitCompletion`, `UnitEscalation`).
  - Export `encodeWorkflowActivityName`, `decodeWorkflowActivityName`, `encodeWorkflowDeferredName`, and `decodeWorkflowDeferredName` returning `Result.Result<..., ErrorReasonMessage>` (exhaustive `match(...)` with no fallback aliases).
- **Replace Inline String Builders & Ad-Hoc Regexes:**
  - Update `libs/harness/gates/src/harness-task-workflow.ts` and `harness-task-workflow-projections.ts` (`makeUnitCompletionDeferred`, `makeUnitEscalationDeferred`, `Activity.make({ name: ... })`) to call `encodeWorkflowActivityName` and `encodeWorkflowDeferredName`.
  - Update `libs/harness/infra/src/workflow/read-model-rebuild.ts` and `read-model-rebuild-journal.ts` to decode activity/deferred names via `decodeWorkflowActivityName` / `decodeWorkflowDeferredName`, deleting superseded manual regex helpers (`parseVerifyActivity`, `unitMatch`, `escMatch`, `dispatchMatch`, `retryMatch`, etc.) and failing closed with `WorkflowStoreUnavailableError` on decode failure.

### Unit 2 · Single-Source Workflow Timeout Budgets (`REQ-2.1`..`REQ-2.2`)

- **Timeout Budget Contract (`libs/harness/contract/src/workflow-timeouts.ts`, `index.ts`):**
  - Define `WorkflowTimeoutBudgets` (`Schema.Struct` with branded finite integer millis/counts) and `validateWorkflowTimeoutBudgets(budgets)` asserting `workflowServerSocketMs > workflowCompleteIpcMs > unitVerifyMs + pollSettleBudgetMs` and `defaultServerSocketMs > workflowIpcMs > abortSettleBudgetMs`.
  - Export canonical `WORKFLOW_TIMEOUT_BUDGETS` (`defaultSocketMs: 5_000`, `defaultServerSocketMs: 35_000`, `workflowIpcMs: 30_000`, `unitVerifyMs: 120_000`, `pollSettleMaxAttempts: 80`, `pollSettleIntervalMs: 25`, `abortSettleMaxAttempts: 200`, `abortSettleIntervalMs: 50`, `workflowCompleteIpcMs: 150_000`, `workflowServerSocketMs: 160_000`, `httpRequestTimeoutMs: 15_000`, `claimTimeoutMs: 6 * 60 * 60 * 1_000`, `writerLeaseHeartbeatTtlMs: 45_000`).
- **Consumer Consolidation:**
  - Wire `WORKFLOW_TIMEOUT_BUDGETS` directly into `libs/harness/infra/src/workflow/daemon-client.ts`, `unix-socket-daemon-live.ts`, `omnigraph-workflow-store.ts`, `omnigraph-message-storage.ts`, `workflow/unit-verifier-live.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-complete-helper.ts`, and `workflow-rpc-daemon-helper.ts`, deleting redundant duplicated literal definitions.

### Unit 3 · Static Lease-Fencing AST Gate (`REQ-3.1`..`REQ-3.2`)

- **AST Detector (`libs/harness/gates/src/plugins/ast-workflow-fence-law.ts`):**
  - Inspect call expressions targeting `invokeWorkflowStoreQuery`, `invokeWorkflowStoreQueryWithMeta`, `invokeWorkflowStoreQueryOnce`, `WorkflowStore.invoke`, or `WorkflowStore.invokeWithMeta` with an object argument containing `expectMutation: true`.
  - Exempt only `LEASE_MANAGEMENT_QUERY_NAMES` (`wf_insert_writer_lease`, `wf_cas_writer_lease`, `wf_refresh_writer_lease`) and offline recovery files gated on offline lock checks; flag any non-exempt call missing `expectedLeaseEpoch` (either explicit property or spread of a typed `*fence*`/`target` config).
- **Wiring & Rule Closure:**
  - Invoke from `self-dogfooding-plugin.ts` emitting `SelfDogfoodingRuleId.make("omnigraph-fenced-mutation")`, register `ast-workflow-fence-law.ts` in `AST_GATE_RULE_SOURCE_FILES` (`ast-cache.ts`), and audit all existing `expectMutation: true` call sites across `libs/harness/infra/src/` and `apps/`.

---

## 3. Adversarial, Negative & Mutation Test Matrix

| Target File                                                          | Positive Coverage                                                            | Negative / Fault Coverage                                                                     | Property / Determinism Check                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `libs/harness/contract/test/workflow-protocol.test.ts`               | All 18 activity variants & 4 deferred variants + `WORKFLOW_TIMEOUT_BUDGETS`  | Malformed/truncated names fail `decode*`; inverted timeout budgets fail monotonicity check    | `it.prop` lossless round-trip across arbitrary `WorkUnitId`, `AttemptNumber`, `EscalationOrdinal`, `WaveIndex` |
| `libs/harness/gates/test/self-dogfooding-capability-plugins.test.ts` | Fenced `expectMutation: true` (`expectedLeaseEpoch` / `...fenceConfig`) pass | Unfenced `expectMutation: true` on non-lease query triggers `omnigraph-fenced-mutation`       | `it.effect.prop` determinism on `SelfDogfooding.decide`                                                        |
| `libs/harness/infra/test/workflow-replay-differential.test.ts`       | Full journal rebuild via symmetric `decodeWorkflowActivityName` / `Deferred` | Corrupt/unknown activity or deferred string fails closed with `WorkflowStoreUnavailableError` | Live `HarnessTaskWorkflow` projections equal `rebuildWorkflowReadModelViews`                                   |

---

## 4. Execution & Verification Sequence

1. Run `pnpm harness plan-check` after authoring `stub()` skeletons (if any new exported spans are introduced).
2. Implement Units 1–3, set `harness:SPEC-0027` frontmatter to `status: accepted`, and update `docs/specs/README.md`.
3. Format ONLY touched files via `pnpm oxfmt --write <explicit paths>` and confirm `pnpm oxfmt --check <explicit paths>`.
4. Run full deterministic gate sequence with zero edits in between:
   - `pnpm harness learn --clear`
   - `pnpm harness gc --strict`
   - `pnpm harness ontology check --strict`
   - `pnpm harness mutate --strict`
   - `CI=true pnpm harness verify`
   - `CI=true pnpm harness done`
