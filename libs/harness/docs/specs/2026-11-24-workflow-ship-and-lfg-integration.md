---
id: harness:SPEC-0032
title: Durable ShipWorkflow Pipeline, Fenced OCC WfShipAttempt Allocation, Done CLI Protocol, and Cross-Adapter LFG Integration
status: accepted
archetype: framework
date: 2026-11-24
owners:
  - "@harness/architecture"
scope: harness
informed_by:
  - harness:ADR-0018
enforced_by:
  - libs/harness/contract/src/workflow-ship.ts
  - libs/harness/contract/src/workflow-rpc.ts
  - libs/harness/contract/src/workflow-storage.ts
  - libs/harness/contract/src/workflow-protocol.ts
  - libs/harness/contract/src/workflow-timeouts.ts
  - libs/harness/contract/src/index.ts
  - libs/harness/service/src/workflow-ports.ts
  - libs/harness/service/src/index.ts
  - libs/harness/gates/src/ship-workflow.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/policy-command-rules.ts
  - libs/harness/gates/src/policy-shell-parser.ts
  - libs/harness/gates/src/policy-worker-isolation.ts
  - libs/harness/gates/src/index.ts
  - libs/harness/graph/workflow-queries/workflows.gq
  - libs/harness/infra/src/workflow/ship-gate-runner-live.ts
  - libs/harness/infra/src/workflow/ship-format-files.ts
  - libs/harness/infra/src/workflow/ship-attempt-store-live.ts
  - libs/harness/infra/src/workflow/ship-daemon-client.ts
  - libs/harness/infra/src/workflow/review-router-live.ts
  - libs/harness/infra/src/unix-socket-daemon-live.ts
  - libs/harness/infra/src/workflow/read-model-rebuild-journal.ts
  - libs/harness/infra/src/index.ts
  - apps/harness-mcp/src/daemon/unix-socket-daemon.ts
  - apps/harness-mcp/src/daemon/workflow-daemon-helper.ts
  - apps/harness-mcp/src/daemon/workflow-ports-daemon-helper.ts
  - apps/harness-mcp/src/daemon/workflow-engine-daemon-helper.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-shared.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-ship-helper.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-status-helper.ts
  - apps/harness-cli/src/commands/done-cli-helper.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - apps/harness-cli/src/commands/declarative-cli-flags.ts
  - apps/harness-cli/src/commands/declarative-cli-workflow.ts
  - apps/harness-cli/src/commands/workflow-command-helpers.ts
  - apps/harness-cli/src/commands/workflow.command.ts
  - apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts
  - AGENTS.md
  - adapters/claude-code/rules/AGENTS.md
  - adapters/antigravity/plugins/effect-harness/rules/AGENTS.md
spans:
  - ShipWorkflow.execute
  - ShipWorkflow.runGate
  - ShipWorkflow.executionIdOf
  - ShipGateRunner.computeTreeHash
  - ShipGateRunner.recoverMutationBackup
  - ShipGateRunner.executeStageCommand
  - ShipGateRunner.reportStageProgress
  - ShipAttemptStore.allocateAttempt
  - ShipAttemptStore.updateStatus
  - ShipAttemptStore.listAttemptsForRun
  - DaemonClient.shipWorkflow
  - WorkflowRpcDaemon.handleShipRequest
  - WorkflowRpcDaemon.resolveShipRunTarget
  - Harness.routeWorkflowReview
  - Harness.decideGuardCommand
services:
  - "@harness/service/ShipGateRunner"
  - "@harness/service/ShipAttemptStore"
  - "@harness/service/WorkflowReviewRouter"
errors:
  - ShipGateFailedError
  - ShipTreeMismatchError
  - MutationRestoreError
  - ShipTreeDriftError
---

## Context

`HarnessTaskWorkflow` (`harness:SPEC-0023`) orchestrates unit execution, slice merges, LLM verification completion, and `routeWorkflowReview` through completion, while operator shipping guarantees (`RFC-0013` §5.4.2, §5.4.3, §5.7.2, `REQ-3.3..3.7`) require a dedicated durable ship pipeline bound strictly to one verified workspace `WorkspaceTreeHash`. Executing final gates in an ad-hoc shell order outside `Workflow.make` leaves no monotonic `WfShipAttempt` audit trail, cannot prevent workspace drift between gate steps, lacks recovery of dangling `.harness/mutation-backup.json` artifacts before `mutate --strict`, leaves `harness done` blocked on empty Stop-hook stdin when invoked from automation, and leaves `LoopCircuitBreaker.decide` unaware of non-`verify` ship-gate loops.

- **Reused Contracts / Errors:** `SHIP_STAGES`, `ShipStage`, `ShipAttempt`, `ShipReceipt`, `GateExitCode`, `WorkspaceTreeHash`, `WorkflowRunId`, `PlanSha256`, `AbsoluteRepoRoot`, `WorkflowStoreUnavailableError`, `WriterLeaseHeldError`, `DaemonProtocolMismatchError` from `@harness/contract`
- **Reused Services & Helpers:** `WorkflowReviewRouter`, `Harness.routeWorkflowReview`, `recoverStartupBackup`, `computeWorkspaceTreeHashChecked`, `LoopCircuitBreaker.decide`, `validateWorktreeRepoRoot`, `invokeWorkflowStoreQueryOnce`, `verifyReadModelLeaseFence`, `handleCasRetryOrFail` (`MAX_ALLOCATE_CAS_RETRIES = 16`), `withRunLock`
- **New Capabilities Needed:** `ShipWorkflowError` union (`ShipGateFailedError`, `ShipTreeMismatchError`, `MutationRestoreError`, `ShipTreeDriftError`), typed `RunGate/<stage>` activity protocol codecs, monotonic ship timeout budgets (`WORKFLOW_TIMEOUT_BUDGETS`), `ShipGateRunner` and `ShipAttemptStore` service ports, pure `ShipWorkflow` in `@harness/gates`, fenced OCC `WfShipAttempt` queries in `workflows.gq`, streaming `workflow.ship` daemon IPC and `pnpm harness workflow ship` CLI, explicit `harness done --cli` protocol, and synchronized `effect-lfg` + `AGENTS.md` guidance

## Goal

Every ship attempt runs deterministically under `ShipWorkflow` keyed by `${runId}:${treeHash}:${attempt}` with strict pre/post tree-hash assertions, startup mutation backup recovery before `mutate --strict`, monotonic OCC attempt allocation in `harness-workflows`, streaming daemon progress, explicit `done --cli` exit-code semantics, `LoopCircuitBreaker.decide` failure accounting, and parity-verified `effect-lfg` and `AGENTS.md` workflows across Claude Code and Antigravity adapters.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `While`, `If ... then`, `Where`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Durable `ShipWorkflow` Pipeline & Tree-Hash Guarantees (`RFC-0013 REQ-3.3..3.6`)

**Source (`libs/harness/gates/src/ship-workflow.ts`, `libs/harness/contract/src/workflow-ship.ts`, `libs/harness/contract/src/workflow-protocol.ts`):** Final verification and Done gating must execute in an unvarying deterministic sequence where every stage proves workspace tree immutability and `mutate --strict` restores any interrupted mutation backup beforehand.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Effect Symbol        | Verification        |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------- |
| REQ-1.1 | Event-driven       | **When** `ShipWorkflow.execute` runs for `{ runId, treeHash, attempt }` (`RFC-0013 REQ-3.3`), `ShipWorkflow.execute` **shall** register `Workflow.make("ShipWorkflow", ...)` with `idempotencyKey = "${runId}:${treeHash}:${attempt}"`, invoke `Activity.make` steps named exclusively via `encodeWorkflowActivityName` (`RunGate/<stage>`) in strict canonical order `format-check -> gc-strict -> ontology-check-strict -> mutate-strict -> verify -> done`, and return `ShipReceipt`.                                            | ShipWorkflow.execute | TraceTest, UnitTest |
| REQ-1.2 | Unwanted behaviour | **If** `ShipGateRunner.computeTreeHash` returns a hash different from `payload.treeHash` before running any stage (`RFC-0013 REQ-3.4`), **then** `ShipWorkflow.runGate` **shall** fail immediately with `ShipTreeMismatchError` without invoking `recoverMutationBackup` or `executeStageCommand`.                                                                                                                                                                                                                                  | ShipWorkflow.runGate | UnitTest            |
| REQ-1.3 | Event-driven       | **When** `ShipWorkflow.runGate` executes the `mutate-strict` stage (`RFC-0013 REQ-3.5`), `ShipWorkflow.runGate` **shall** invoke `ShipGateRunner.recoverMutationBackup` (`recoverStartupBackup`) prior to running `mutate --strict`, assert `computeTreeHash` equals `payload.treeHash` on completion, run recovery followed by `computeTreeHash` on any command failure or interrupt exit path, and fail with `MutationRestoreError` on any backup restore failure or post-recovery tree drift (omitting `actual` if unavailable). | ShipWorkflow.runGate | UnitTest            |
| REQ-1.4 | Unwanted behaviour | **If** `ShipGateRunner.computeTreeHash` detects workspace hash drift immediately after the `done` stage completes (`RFC-0013 REQ-3.6`), **then** `ShipWorkflow.runGate` **shall** fail closed with `ShipTreeDriftError`.                                                                                                                                                                                                                                                                                                            | ShipWorkflow.runGate | UnitTest            |

### 2 · Fenced OCC `WfShipAttempt` Allocator, Daemon IPC, `done --cli` & Circuit Breaker

**Source (`libs/harness/graph/workflow-queries/workflows.gq`, `libs/harness/infra/src/workflow/`, `apps/harness-mcp/src/daemon/`, `apps/harness-cli/src/commands/`):** Concurrent ship requests must never collide on attempt numbers, daemon IPC and socket deadlines must honor strict timeout monotonicity, non-interactive `done --cli` must bypass Stop-hook stdin requirements while failing non-zero on blocks, and ship-gate failures must inform `LoopCircuitBreaker.decide`.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Effect Symbol                          | Verification      |
| ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------- |
| REQ-2.1 | Event-driven | **When** `ShipAttemptStore.allocateAttempt` allocates a `WfShipAttempt` record for a compiled or ephemeral `runId`, `ShipAttemptStore` **shall** serialize via `withRunLock`, verify lease fencing via `verifyReadModelLeaseFence` (`expectedLeaseEpoch`/`expectedLeaseOwner`), and allocate monotonically increasing `ShipAttempt` integers via `invokeWorkflowStoreQueryOnce` (`ifGraphCommit`) and bounded CAS retry `handleCasRetryOrFail` (`MAX_ALLOCATE_CAS_RETRIES = 16`) so concurrent `workflow.ship` calls never share an attempt.                                                                                                                                              | ShipAttemptStore.allocateAttempt       | UnitTest, AstGate |
| REQ-2.2 | Event-driven | **When** `DaemonClient.shipWorkflow` invokes `workflow.ship` over `<git-common-dir>/harness/daemon.sock`, `DaemonClient.shipWorkflow` and the daemon handler **shall** validate `repoRoot` via `validateWorktreeRepoRoot`, honor `WORKFLOW_TIMEOUT_BUDGETS` monotonicity (`shipServerSocketMs > shipWorkflowIpcMs > shipWorkflowSettleMs > SHIP_STAGES.length * shipGateCommandMs` and `shipGateCommandMs > workflowServerSocketMs`), cancel and await active gates before releasing locks on timeout/disconnect, and report `ShipStreamProgressEvent` (`StageStarted` and post-check `StageFinished` with `ShipGateRunner.reportStageProgress`) before returning `WorkflowShipResponse`. | DaemonClient.shipWorkflow              | UnitTest          |
| REQ-2.3 | Event-driven | **When** `ShipGateRunner.executeStageCommand` runs `pnpm harness done --cli` or any ship gate fails, `harness done --cli` **shall** bypass Stop-hook stdin and subagent/read-only skips while converting any block into non-zero exit code `1`, and `ShipGateRunner.executeStageCommand` **shall** record failures in `.harness/friction-log.jsonl` without double-counting `verify`'s own `verify_failure` event before returning `ShipGateFailedError` with `LoopCircuitBreaker.decide` status.                                                                                                                                                                                         | ShipGateRunner.executeStageCommand     | UnitTest          |
| REQ-2.4 | Event-driven | **When** `WorkflowRpcDaemon.resolveShipRunTarget` resolves a target for `workflow.ship`, `WorkflowRpcDaemon.resolveShipRunTarget` **shall** verify any requested compiled `runId` exists and is in `"completed"` state (failing closed without launching gates otherwise), while synthesizing `ship-<hash12>` (`runOrigin: "ephemeral"`) when `--run` is omitted.                                                                                                                                                                                                                                                                                                                         | WorkflowRpcDaemon.resolveShipRunTarget | UnitTest          |

### 3 · Deterministic Review Routing Parity & Cross-Adapter `effect-lfg` Integration (`RFC-0013 REQ-3.7`)

**Source (`libs/harness/infra/src/workflow/review-router-live.ts`, `libs/harness/gates/src/policy.ts`, `AGENTS.md`, `adapters/*/skills/effect-lfg/`):** Already-landed deterministic review routing and updated cross-adapter documentation must integrate cleanly into the durable workflow lifecycle while preserving adapter parity and CLI catalog truth.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Effect Symbol               | Verification |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------ |
| REQ-3.1 | Ubiquitous   | `Harness.routeWorkflowReview` (`WorkflowReviewRouter` / `RFC-0013 REQ-3.7`) **shall** remain covered by unit tests and remain wired inside `HarnessTaskWorkflow` prior to shipping.                                                                                                                                                                                                                                                                                 | Harness.routeWorkflowReview | UnitTest     |
| REQ-3.2 | Ubiquitous   | `AGENTS.md`, Claude Code `adapters/claude-code/rules/AGENTS.md`, Antigravity `adapters/antigravity/plugins/effect-harness/rules/AGENTS.md`, both adapters' `effect-lfg` skills/references, READMEs, and `adapter-skills-parity.test.ts` **shall** reflect `compile -> start -> complete/resume -> routeReview -> LLM phase -> pnpm harness workflow ship` while preserving byte-identical `Swarm Seam Checklist (Pre-Review)` sections and `doc-cli-command-truth`. | —                           | UnitTest     |
| REQ-3.3 | Event-driven | **When** an agent invokes `harness workflow ship` while `HARNESS_UNIT_WORKER=1`, `Harness.decideGuardCommand` and `libs/harness/gates/src/policy.ts` **shall** deny the command with a diagnostic naming `harness workflow start/resume/ship/abort/doctor/complete --phase llm`.                                                                                                                                                                                    | Harness.decideGuardCommand  | UnitTest     |

## Assumptions

- **REQ-1.1 / REQ-2.2:** Supporting both `--run <id>` (completed `CompiledPlan` run) and no `--run` (ephemeral `ship-<treeHash12>` runId) enables `pnpm harness workflow ship` both at the end of `HarnessTaskWorkflow` and on standalone tasks that ran outside `workflow compile/start`.
- **REQ-2.3:** Passing `format-check` changed workspace files via git diff/status (`resolveShipFormatCheckFiles`) prevents unrelated unformatted historical repository files outside the active task delta from blocking `workflow ship` while still enforcing `oxfmt --check` strictly across all task edits.

## Out of scope

- Live LLM/agent runner profiles (`runner-profiles.ts`), `AgentRunnerError`, and automatic `HARNESS_UNIT_WORKER=1` subprocess spawning (deferred to WF-5 so `@harness/contract` incurs zero `[dead-tagged-error]` diagnostics in WF-4).
- `WorkflowProjector` live sync into the main analytical graph (deferred to WF-6).

## Known residual risks

- If a repository directory other than `format-check`'s git-delta scope is modified without staging or tracking, `.harness/verify-stamp.json` workspace tree hashing still covers every non-ignored file so `ShipTreeMismatchError` / `ShipTreeDriftError` catches external mutations across the full workspace.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`TraceTest`, `UnitTest`, `AstGate`), achieving `100%` mutant kill across modified `@harness/gates` and pure `@harness/infra` / `harness-cli` modules.
- `pnpm harness plan-check`, `pnpm harness learn --clear`, `pnpm harness gc --strict`, `pnpm harness ontology check --strict`, `pnpm harness mutate --strict`, `CI=true pnpm harness verify`, and `CI=true pnpm harness done --cli` pass with zero findings.
