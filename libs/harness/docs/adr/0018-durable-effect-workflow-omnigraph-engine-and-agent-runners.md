---
id: harness:ADR-0018
title: Durable Effect v4 Workflow Orchestration with Omnigraph-Backed Engine and Agent Runners
status: accepted
date: 2026-11-19
deciders:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/workflow.ts
  - libs/harness/contract/src/workflow-storage.ts
  - libs/harness/contract/src/index.ts
  - libs/harness/service/src/workflow-ports.ts
  - libs/harness/service/src/index.ts
  - libs/harness/gates/src/plan-workflow-compiler.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/policy-shell-parser.ts
  - libs/harness/gates/src/policy-harness-state.ts
  - libs/harness/graph/cluster.yaml
  - libs/harness/graph/workflows.schema.pg
  - libs/harness/graph/workflows.policy.yaml
  - libs/harness/graph/workflow-policy-tests.yaml
  - libs/harness/graph/workflow-queries/workflows.gq
  - libs/harness/graph/src/cluster-resolver.ts
  - libs/harness/graph/src/omnigraph-operations.ts
  - libs/harness/graph/src/omnigraph-v014-ops.ts
  - libs/harness/infra/src/worktree-repo-root.ts
  - libs/harness/infra/src/omnigraph-workflow-store.ts
  - libs/harness/infra/src/writer-lease.ts
  - libs/harness/infra/src/workflow/flock-lock.ts
  - libs/harness/infra/src/workflow/writer-lease-codec.ts
  - libs/harness/infra/src/workflow/cluster-startup-lock.ts
  - libs/harness/infra/src/omnigraph-message-storage.ts
  - libs/harness/infra/src/workflow/message-storage-codec.ts
  - libs/harness/infra/src/workflow/message-storage-cas.ts
  - libs/harness/infra/src/workflow/message-storage-hydration.ts
  - libs/harness/infra/src/workflow-engine-live.ts
  - libs/harness/infra/src/workflow-graph-backup.ts
  - libs/harness/infra/src/workflow-maintenance.ts
  - libs/harness/infra/src/workflow/daemon-client.ts
  - libs/harness/infra/src/unix-socket-daemon-live.ts
  - libs/harness/infra/src/index.ts
  - apps/harness-mcp/src/daemon/unix-socket-daemon.ts
  - apps/harness-mcp/src/daemon/workflow-daemon-helper.ts
  - apps/harness-mcp/src/daemon/workflow-engine-daemon-helper.ts
  - apps/harness-mcp/src/daemon/worktree-scope-cache.ts
  - apps/harness-mcp/src/daemon/ast-gate-daemon-helper.ts
  - apps/harness-cli/src/commands/omnigraph-lifecycle.ts
  - apps/harness-cli/src/commands/omnigraph-lifecycle-setup.ts
  - apps/harness-cli/src/commands/omnigraph-auth-and-drift.ts
  - apps/harness-cli/src/commands/omnigraph-workflow-backup.ts
  - apps/harness-cli/src/commands/omnigraph-workflow-journal.ts
  - apps/harness-cli/src/commands/omnigraph-lint-gate.ts
  - apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts
  - libs/harness/contract/src/workflow-rpc.ts
  - libs/harness/gates/src/harness-task-workflow.ts
  - libs/harness/gates/src/harness-task-workflow-projections.ts
  - libs/harness/gates/src/policy-command-rules.ts
  - libs/harness/gates/src/hook-fastpath.ts
  - libs/harness/gates/src/plugins/gc/gc-hook-fastpath.ts
  - libs/harness/gates/src/plugins/workflow-body-ast.ts
  - libs/harness/gates/src/plugins/ast-gate-visitors.ts
  - libs/harness/decision/src/guard-decision.ts
  - libs/harness/infra/src/workflow/unit-verifier-live.ts
  - libs/harness/infra/src/workflow/worktree-port-live.ts
  - libs/harness/infra/src/workflow/read-model-live.ts
  - libs/harness/infra/src/workflow/read-model-rebuild.ts
  - libs/harness/infra/src/workflow/review-router-live.ts
  - libs/harness/infra/src/workflow/agent-dispatcher-live.ts
  - libs/harness/infra/src/workflow/plan-compiler-extractor.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-daemon-helper.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-shared.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-status-helper.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-complete-helper.ts
  - apps/harness-mcp/src/tools/workflow-plan.tools.ts
  - apps/harness-cli/src/commands/workflow.command.ts
  - apps/harness-cli/src/commands/declarative-cli-workflow.ts
  - apps/harness-cli/src/commands/hook-fastpath-core.ts
  - tools/oxlint/syntax-bans.js
spans:
  - PlanWorkflowCompiler.decide
  - WorktreeRepoRoot.validate
  - WorkflowStore.invoke
  - WorkflowStore.invokeWithMeta
  - WorkflowStore.quarantineOrphans
  - WfWriterLease.acquire
  - WfWriterLease.refresh
  - OmnigraphCluster.acquireStartupLock
  - HarnessDaemon.acquireWorkflowEngineInScope
  - OmnigraphMessageStorage.clearReplies
  - OmnigraphMessageStorage.repairDangling
  - WorkflowGraphBackup.exportBackup
  - WorkflowGraphBackup.restoreBackup
  - WorkflowMaintenance.runOffline
  - HarnessDaemonClient.handshake
  - HarnessDaemonClient.queryCommand
  - WorkflowDaemonHelper.handshake
  - WorkflowDaemonHelper.makeScopeCache
  - WorkflowDaemonHelper.resolveRequestScope
  - WorkflowDaemonHelper.handleHandshakeRequest
  - OmnigraphWorkflowBackup.beforeRebuild
  - OmnigraphWorkflowBackup.afterRebuild
  - Harness.decideGuardCommand
  - Harness.executeTaskWorkflow
  - Harness.driveWorkUnit
  - Harness.driveSharedStep
  - Harness.completeUnit
  - Harness.completeSharedStep
  - Harness.provisionWorkflowWorktrees
  - Harness.mergeSliceWave
  - Harness.removeWorktreeCheckouts
  - Harness.routeWorkflowReview
  - Harness.rebuildWorkflowReadModelViews
  - Harness.compileWorkflowPlanFromRepo
  - Harness.routeReviewDiff
  - HarnessCli.workflow
  - HarnessMcp.workflowPlan
  - HarnessDaemonClient.startWorkflow
  - HarnessDaemonClient.getWorkflowStatus
  - HarnessDaemonClient.completeWorkflow
  - HarnessDaemonClient.resumeWorkflow
  - HarnessDaemonClient.abortWorkflow
  - HarnessDaemonClient.doctorWorkflow
  - WorkflowRpcDaemon.handleStartRequest
  - WorkflowRpcDaemon.handleCompleteRequest
  - WorkflowRpcDaemon.handleResumeRequest
  - WorkflowRpcDaemon.handleAbortRequest
  - WorkflowRpcDaemon.handleDoctorRequest
  - SyntaxBans.decide
services:
  - "@harness/service/WorkflowGraphBackup"
  - "@harness/service/UnitVerifier"
  - "@harness/service/UnitAgentDispatcher"
  - "@harness/service/WorkflowWorktreePort"
  - "@harness/service/WorkflowReviewRouter"
  - "@harness/service/WorkflowProjectionWriter"
  - "@harness/service/WorkflowReadModelQuery"
errors:
  - CyclicPlanWorkflowError
  - DisjointOwnershipViolationError
  - InvalidPlanWorkflowGraphError
  - WorkflowStoreUnavailableError
  - WriterLeaseHeldError
  - DaemonProtocolMismatchError
  - TaskRunAbortedError
  - WorkspaceFsError
informs:
  - harness:SPEC-0017
  - harness:SPEC-0021
  - harness:SPEC-0023
---

# ADR-0018 · Durable Effect v4 Workflow Orchestration with Omnigraph-Backed Engine and Agent Runners

## Context and Problem Statement

Multi-slice Route D execution relies on prose checklists across `AGENTS.md` and adapter skills where wave membership, unit completion, escalation state, and ship-gate ordering remain ephemeral inside conversational context. Restarting or compacting a controller session loses in-flight unit state, `AGENTS.md` and skill references require deterministic ship ordering bound to `.harness/verify-stamp.json` (which hashes every non-ignored workspace file), and concurrent linked worktrees require a shared canonical daemon socket and single-writer persistence model.

Effect v4 (`effect@4.0.0`) provides `effect/workflow`, `effect/cluster`, and `effect/Graph`, while the workspace standardizes on `@modernrelay/omnigraph` `0.14.0` rather than introducing SQLite, `node:sqlite`, or an external orchestrator database.

## Decision Drivers

- **Deterministic DAG Compilation & Isolated Write Sets:** Reject dependency cycles and intra-wave write-set overlaps purely (`R = never`) via `PlanWorkflowCompiler.decide` (`harness:SPEC-0017`) before launching worktrees or agents.
- **Durable Omnigraph-Backed Persistence Without External DBs:** Implement `MessageStorage.Encoded` (`OmnigraphMessageStorage`) over a dedicated `harness-workflows` graph (`main` branch only, isolated from `done` overwrites on `harness`) using `SeqKey` 20-char zero-padded decimal ordering, continuous `writeMutex`, and a shared `WORKFLOW_MAX_CONCURRENT_HTTP = 12` semaphore respecting Omnigraph's 16-in-flight actor limit.
- **Single-Writer Fenced Daemon & Least-Privilege Policy Isolation:** Anchor the canonical workflow daemon under `<git-common-dir>/harness/daemon.sock` (targeting a verified `<= 70 B` budget well below platform-dependent OS `sun_path` socket path caps across linked worktrees), fence writers via OS `flock` + `WfWriterLease` epoch takeover (`acquireWriterLease`) wired through `Scope` with active-lease epochs (`>= 1`) and `expectedLeaseEpoch` write fencing, validate client/server versions via `workflow.handshake` (`DaemonProtocolMismatchError`), and enforce disjoint Cedar policy bundles (`workflows.policy.yaml` denying `agent-mcp` stored-query invocations on `harness-workflows` with HTTP `404` and direct `snapshot`/`list`/`query`/`mutate` access with HTTP `403`).
- **Fail-Closed Cluster Rebuilds, Maintenance & Runtime State Protection:** Export and SHA-256-verify `harness-workflows` (`WorkflowGraphBackup.exportBackup` / `OmnigraphWorkflowBackup.beforeRebuild`) prior to stopping `omnigraph-server` on `RequiresCleanRebuild`, bind `pending-workflow-restore.json` to `clusterRootDir` + `preRebuildConfigStamp`, restore onto `main` (`mode: "merge"` requiring both `WfMessage` and `WfReply` parity, or `mode: "replace"` requiring `expectedSha256` and non-empty backups), bound Lance MVCC growth via offline `optimize` + `cleanup` + `cluster force-unlock` (`WorkflowMaintenance.runOffline`) after validating safety exports, and deny direct agent reads/writes/probes across any argument targeting `<git-common-dir>/harness/**`, `auth-tokens.json`, `daemon.sock`, `daemon.lock`, `workflow-backups/`, or `pending-workflow-restore.json` in `libs/harness/gates/src/policy.ts`.

## Considered Options

- **Option 1:** Two-level deterministic plan DAG (`PlanWorkflowCompiler.decide`) executed by Effect v4 `ClusterWorkflowEngine` + `OmnigraphMessageStorage` on dedicated graph `harness-workflows` inside the canonical `<git-common-dir>/harness/daemon.sock` daemon, paired with `WfWriterLease` (`flock` + PID liveness), `WorkflowGraphBackup`, offline maintenance, and `policy.ts` runtime-state protection.
- **Option 2:** Retain Markdown checklists in `AGENTS.md` and Route D prose without durable workflow persistence or fenced daemon coordination.
- **Option 3:** Run `SingleRunner.layer` with a secondary SQLite/PGlite database or an external Postgres/Temporal service alongside Omnigraph.

## Decision Outcome

**Chosen option:** "Option 1: Two-level deterministic plan DAG (`PlanWorkflowCompiler.decide`) executed by Effect v4 `ClusterWorkflowEngine` + `OmnigraphMessageStorage` on dedicated graph `harness-workflows` inside the canonical `<git-common-dir>/harness/daemon.sock` daemon, paired with `WfWriterLease` (`flock` + PID liveness), `WorkflowGraphBackup`, offline maintenance, and `policy.ts` runtime-state protection", because WF-0 empirically verified all 13 `MessageStorage.Encoded` operations, `SIGKILL` recovery, export/restore, and disjoint Cedar isolation against `omnigraph-server 0.14.0` without introducing a second database.

### Architectural Rules and Guarantees

1. **Pure Plan Compilation (`harness:SPEC-0017`):** `PlanWorkflowCompiler.decide` (`R = never`) compiles `CompileInput` via `effect/Graph` (`Graph.isAcyclic` and `Graph.values(Graph.topo(...))`), enforcing acyclic dependencies and pairwise `pathsOverlap`-disjoint `ownedRelPaths` per wave.
2. **Dedicated `harness-workflows` Graph & `OmnigraphMessageStorage` (`harness:SPEC-0021`):** Workflow envelopes (`WfMessage`), replies (`WfReply`), writer leases (`WfWriterLease`), and reconstructible read-model summaries (`WfRun`, `WfUnit`, `WfAttempt`, `WfShipAttempt`) live in `libs/harness/graph/workflows.schema.pg` and 51 declared GQ 2.1 queries in `libs/harness/graph/workflow-queries/workflows.gq` (typed in `@harness/contract` via `WorkflowGqQueryName` and `WorkflowGqParamsMap`). `OmnigraphMessageStorage` sorts losslessly on 20-character zero-padded `SeqKey` strings, groups `opts.addresses` by `entityType` in GQ (`wf_unprocessed_candidate_messages_for_addresses`) before `limit`, executes atomic `wf_clear_address`, implements `withTransaction` as pass-through over single-request atomic GQ mutations while enforcing continuous `writeMutex` across `D2` two-commit `$expectedReplyId` CAS `clearOmnigraphReplies` with `wf_repair_dangling_requests` compensation (`compensateDanglingOnce` outside retry sleeps), enforces Effect Cluster's 6-hour (`DEFAULT_WORKFLOW_CLAIM_TIMEOUT_MS`) claim expiry window on `OmnigraphMessageStorage` (`claimTimeoutMs`), routes corrupt rows through terminal `WithExit(Die)` handling matching Effect Cluster `MessageStorage`, and routes all HTTP calls through `WORKFLOW_MAX_CONCURRENT_HTTP = 12` with `AbortSignal.timeout` and `429`/`412` retries (`WORKFLOW_MAX_OCC_RETRIES = 48`).
3. **Single-Writer Fenced Daemon & Linked-Worktree IPC:** All writes to `harness-workflows` originate exclusively from the canonical daemon listening at `<git-common-dir>/harness/daemon.sock`. `acquireWriterLease` uses `Effect.acquireRelease` (`Scope.Scope`) pairing OS advisory `flock` on `<git-common-dir>/harness/daemon.lock` with `WfWriterLease` epoch fencing (`WriterLeaseHeldError`) and PID-liveness + `/proc/<pid>/stat` start-time takeover (`WRITER_LEASE_HEARTBEAT_TTL_MS = 45_000` fallback), while writes fence against active `expectedLeaseEpoch` (`>= 1`) and `ifGraphCommit`. Clients validate `worktreeRoot` via `validateWorktreeRepoRoot`, run `workflow.handshake` (`handshakeWorkflowDaemon` / `handleWorkflowDaemonHandshake`, `WORKFLOW_DAEMON_IPC_TIMEOUT_MS = 30_000`) failing with `DaemonProtocolMismatchError` on stale daemons or inactive leases, and fall back to in-process AST/graph extraction when a linked worktree's rule version differs from the daemon's `startupRuleVersion`.
4. **Fail-Closed Rebuild Backup, Offline Maintenance & Disjoint Cedar Policy:** `cluster.yaml` mounts `workflows.policy.yaml` (`admins: [harness-cli]` only) separately from `graph.policy.yaml`. `CONFIG_DIGEST_FILES` tracks workflow config assets so additive updates use `LiveClusterApply`, while `RequiresCleanRebuild` invokes `OmnigraphWorkflowBackup.beforeRebuild` under `daemon.lock` before `killOmnigraphServerPidIfAlive`, persists `pending-workflow-restore.json` bound to `clusterRootDir` and `preRebuildConfigStamp`, and runs `OmnigraphWorkflowBackup.afterRebuild` (`mode: "merge"` + `expectedSha256`) verifying both `WfMessage` (`wf_count_all`, `>=` in `merge`, `===` in non-empty `replace`) and `WfReply` (`wf_count_replies`) counts before `server.json` publication, aborting fail-closed on export or restore failure. `runOfflineWorkflowMaintenance` automates offline `omnigraph optimize`, safety backup verification, `omnigraph cleanup --keep 1 --confirm` (with configurable `keepVersions`), and `omnigraph cluster force-unlock` after checking cluster lock/server state fail-closed.
5. **Runtime State Protection (`policy.ts` & `policy-shell-parser.ts`):** `explainCommandDenyRule` (`harness-state-mutation`, `secret-file-access`), wrapper-unwrapping `extractCommandSegments` / `unwrapCommandSegment` (`timeout`, `nice`, `nohup`, `stdbuf`, `time`, `bun` runners), and `classifyFileWrite` (`harness-common-dir-state`) block agent mutations, direct reads (`grep`, `cat`, probes), custom common-dir targets, and `$(git rev-parse --git-common-dir)/harness` command substitutions across any non-exempt command argument targeting `<git-common-dir>/harness/**`, exempting only `ls`, read-only `find`, `dropDataArguments`-stripped messages, and `pnpm harness`.
6. **Staged Rollout Separation:** WF-1 (`harness:SPEC-0017`) delivers contracts and the DAG compiler; WF-2 (`harness:SPEC-0021`) delivers `harness-workflows` schema/queries/policy, `OmnigraphMessageStorage`, `WfWriterLease`, daemon handshake, backup/maintenance, and runtime-state policy guards; WF-3 (`harness:SPEC-0023`) is implemented delivering durable `HarnessTaskWorkflow` orchestration, `"nondeterministic-workflow-body"` AST/oxlint gates, `UnitVerifierLive`, non-authoritative read-model projections (`WorkflowProjectionWriter`/`WorkflowReadModelQuery`), `workflow.*` daemon RPCs, `harness_workflow_plan` (`18` canonical MCP tools), `harness workflow` CLI, and `HARNESS_UNIT_WORKER=1` isolation guards; WF-4 through WF-6 (`ShipWorkflow`, live `runner-profiles.ts` agent runners, and `WorkflowProjector` live sync) build atop WF-3 in subsequent specs.

## Rejected Alternatives

### 1 · Option 2: Markdown Checklists Only

Continue coordinating Route D multi-slice waves solely via prompt prose and `AGENTS.md` checklists.

**Why rejected:** Keeps wave state, retries, and ship ordering inside lossy context windows without durable crash recovery or fenced concurrency control.

### 2 · Option 3: Secondary SQL/SQLite Store or External Orchestrator

Operate Effect workflows on a separate SQLite, PGlite, Postgres, or Temporal datastore alongside Omnigraph.

**Why rejected:** Conflicts with the workspace's `node:sqlite` ban and single-store Omnigraph architecture, forcing users to manage and back up a separate workflow database process.

## Consequences and Enforcement

### Positive Consequences

- Single-store durable workflow mailbox (`harness-workflows`) isolated from `done` overwrites on `harness` and protected from `agent-mcp` access via disjoint Cedar policy rules.
- Fast crash-takeover writer lease, linked-worktree socket sharing under `<git-common-dir>/harness/daemon.sock`, and fail-closed backup/restore across clean rebuilds.

### Negative Consequences and Trade-offs

- Couples workflow engine durability to `effect/cluster`'s `@stability unstable` `MessageStorage.Encoded` contract and serializes writes behind `writeMutex`.
- Requires periodic offline `optimize` + `cleanup` + `force-unlock` maintenance to bound Lance MVCC fragment and version growth.

### Deterministic Enforcement

| Rule                                                         | Enforced By                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Gate / Mechanism                                                                                                                                                                                                                                                                                                      | Governed Symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| :----------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acyclic & Disjoint DAG Compilation                           | `libs/harness/gates/src/plan-workflow-compiler.ts`, `libs/harness/contract/src/workflow.ts`, `libs/harness/contract/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `PlanWorkflowCompiler` DAG validation and wave splitting (`wavesOf`, `pathsOverlap`)                                                                                                                                                                                                                                  | `PlanWorkflowCompiler.decide`, `CyclicPlanWorkflowError`, `DisjointOwnershipViolationError`, `InvalidPlanWorkflowGraphError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Omnigraph Workflow Store, Concurrency Cap & `SeqKey` Mailbox | `libs/harness/contract/src/workflow-storage.ts`, `libs/harness/infra/src/omnigraph-workflow-store.ts`, `libs/harness/infra/src/omnigraph-message-storage.ts`, `libs/harness/infra/src/workflow/message-storage-codec.ts`, `libs/harness/infra/src/workflow/message-storage-cas.ts`, `libs/harness/infra/src/workflow/message-storage-hydration.ts`, `libs/harness/infra/src/workflow-engine-live.ts`, `libs/harness/infra/src/index.ts`, `libs/harness/graph/workflows.schema.pg`, `libs/harness/graph/workflow-queries/workflows.gq`                                                                                                                                                            | `WORKFLOW_MAX_CONCURRENT_HTTP`, `WORKFLOW_MAX_OCC_RETRIES`, `SeqKey`, `WorkflowGqQueryName`, `WorkflowGqParamsMap`, `clearOmnigraphReplies`, `compensateDanglingOnce`, `repairDanglingProcessedRequests`, `wf_clear_address`, `makeOmnigraphEncodedDriver`, `makeHarnessWorkflowEngineLayer`                          | `WorkflowStore.invoke`, `WorkflowStore.invokeWithMeta`, `WorkflowStore.quarantineOrphans`, `OmnigraphMessageStorage.clearReplies`, `OmnigraphMessageStorage.repairDangling`, `WorkflowStoreUnavailableError`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Fenced Single-Writer Lease & Disjoint Cedar Policy           | `libs/harness/contract/src/workflow-storage.ts`, `libs/harness/infra/src/writer-lease.ts`, `libs/harness/infra/src/workflow/flock-lock.ts`, `libs/harness/infra/src/workflow/writer-lease-codec.ts`, `apps/harness-mcp/src/daemon/workflow-engine-daemon-helper.ts`, `libs/harness/graph/cluster.yaml`, `libs/harness/graph/workflows.policy.yaml`, `libs/harness/graph/workflow-policy-tests.yaml`, `libs/harness/graph/src/omnigraph-operations.ts`, `libs/harness/graph/src/omnigraph-v014-ops.ts`                                                                                                                                                                                            | `acquireWriterLease`, `withAdvisoryFlock`, `refreshWriterLease` (`WRITER_LEASE_HEARTBEAT_TTL_MS`), `acquireWorkflowEngineInScope`, `omnigraph` Cedar policy assertions                                                                                                                                                | `WfWriterLease.acquire`, `WfWriterLease.refresh`, `HarnessDaemon.acquireWorkflowEngineInScope`, `WriterLeaseHeldError`, `WorkflowStoreUnavailableError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Canonical Worktree Root & Versioned Daemon Handshake         | `libs/harness/contract/src/workflow-storage.ts`, `libs/harness/infra/src/worktree-repo-root.ts`, `libs/harness/infra/src/workflow/daemon-client.ts`, `libs/harness/infra/src/unix-socket-daemon-live.ts`, `libs/harness/graph/src/cluster-resolver.ts`, `apps/harness-mcp/src/daemon/workflow-daemon-helper.ts`, `apps/harness-mcp/src/daemon/worktree-scope-cache.ts`, `apps/harness-mcp/src/daemon/ast-gate-daemon-helper.ts`, `apps/harness-mcp/src/daemon/unix-socket-daemon.ts`, `apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts`                                                                                                                                            | `validateWorktreeRepoRoot`, `resolveGitCommonDir`, `resolveHarnessDaemonSocketPath`, `handshakeWorkflowDaemon` (`WORKFLOW_DAEMON_IPC_TIMEOUT_MS`), `queryWorkflowDaemonCommand`, `handleWorkflowDaemonHandshake`, `makeDaemonWorktreeScopeCache`, `resolveDaemonRequestScope`, `handleDaemonWorkflowHandshakeRequest` | `WorktreeRepoRoot.validate`, `HarnessDaemonClient.handshake`, `HarnessDaemonClient.queryCommand`, `WorkflowDaemonHelper.handshake`, `WorkflowDaemonHelper.makeScopeCache`, `WorkflowDaemonHelper.resolveRequestScope`, `WorkflowDaemonHelper.handleHandshakeRequest`, `DaemonProtocolMismatchError`                                                                                                                                                                                                                                                                                                                                                                    |
| Fail-Closed Rebuild Backup & Offline Lance Maintenance       | `libs/harness/contract/src/workflow-storage.ts`, `libs/harness/service/src/workflow-ports.ts`, `libs/harness/service/src/index.ts`, `libs/harness/infra/src/workflow-graph-backup.ts`, `libs/harness/infra/src/workflow-maintenance.ts`, `libs/harness/infra/src/workflow/cluster-startup-lock.ts`, `apps/harness-cli/src/commands/omnigraph-workflow-backup.ts`, `apps/harness-cli/src/commands/omnigraph-workflow-journal.ts`, `apps/harness-cli/src/commands/omnigraph-lifecycle.ts`, `apps/harness-cli/src/commands/omnigraph-lifecycle-setup.ts`, `apps/harness-cli/src/commands/omnigraph-auth-and-drift.ts`, `apps/harness-cli/src/commands/omnigraph-lint-gate.ts`                       | `exportWorkflowGraphBackup`, `restoreWorkflowGraphBackup`, `expectedSha256`, `beforeRebuildWorkflowBackup`, `afterRebuildWorkflowBackup`, `writePendingWorkflowRestoreJournal`, `runOfflineWorkflowMaintenance`, `acquireOmnigraphClusterLockEffect`, `runOfflineOmnigraphLintGate`                                   | `@harness/service/WorkflowGraphBackup`, `WorkflowGraphBackup.exportBackup`, `WorkflowGraphBackup.restoreBackup`, `OmnigraphWorkflowBackup.beforeRebuild`, `OmnigraphWorkflowBackup.afterRebuild`, `WorkflowMaintenance.runOffline`, `OmnigraphCluster.acquireStartupLock`                                                                                                                                                                                                                                                                                                                                                                                              |
| Protected Harness Runtime State & Secret Guards              | `libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/policy-shell-parser.ts`, `libs/harness/gates/src/policy-harness-state.ts`, `libs/harness/gates/src/policy-command-rules.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `explainCommandDenyRule` (`isHarnessStateMutationCommand`, `isHarnessStateAccessCommand`, `HARNESS_STATE_MUTATING_BINARIES`, `HARNESS_SOCKET_OR_SCRIPT_BINARIES`, `harness-state-mutation`, `secret-file-access`), `extractCommandSegments`, `unwrapCommandSegment`, `classifyFileWrite` (`harness-common-dir-state`) | `Harness.decideGuardCommand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Durable `HarnessTaskWorkflow` Orchestration & Determinism    | `libs/harness/gates/src/harness-task-workflow.ts`, `libs/harness/gates/src/harness-task-workflow-projections.ts`, `libs/harness/contract/src/workflow-rpc.ts`, `libs/harness/service/src/workflow-ports.ts`, `libs/harness/gates/src/plugins/workflow-body-ast.ts`, `libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `tools/oxlint/syntax-bans.js`                                                                                                                                                                                                                                                                                                                                         | `Workflow.make("HarnessTaskWorkflow", ...)` keyed by `plan.runId`, `Workflow.withCompensation`, bounded retry/escalation, `"nondeterministic-workflow-body"` AST & oxlint gate                                                                                                                                        | `Harness.executeTaskWorkflow`, `Harness.driveWorkUnit`, `Harness.driveSharedStep`, `SyntaxBans.decide`, `TaskRunAbortedError`, `@harness/service/UnitAgentDispatcher`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Shared Unit Verification & Linked-Worktree Slice Merge       | `libs/harness/infra/src/workflow/unit-verifier-live.ts`, `libs/harness/infra/src/workflow/worktree-port-live.ts`, `libs/harness/infra/src/workflow/review-router-live.ts`, `libs/harness/infra/src/workflow/agent-dispatcher-live.ts`, `libs/harness/infra/src/workflow/plan-compiler-extractor.ts`                                                                                                                                                                                                                                                                                                                                                                                              | `UnitVerifierLive` (`git diff --no-renames -z`, L1/L2 stamp validation, `priorUnitOwnedPaths` exclusion), `WorkflowWorktreePortLive` idempotent provisioning & conflict-checked merges, `WorkflowReviewRouterLive`                                                                                                    | `@harness/service/UnitVerifier`, `@harness/service/WorkflowWorktreePort`, `@harness/service/WorkflowReviewRouter`, `Harness.completeUnit`, `Harness.completeSharedStep`, `Harness.provisionWorkflowWorktrees`, `Harness.mergeSliceWave`, `Harness.removeWorktreeCheckouts`, `Harness.routeWorkflowReview`, `Harness.compileWorkflowPlanFromRepo`, `Harness.routeReviewDiff`, `WorkspaceFsError`                                                                                                                                                                                                                                                                        |
| Non-Authoritative Read Model, Daemon IPC & CLI/MCP Surface   | `libs/harness/graph/workflow-queries/workflows.gq`, `libs/harness/infra/src/workflow/read-model-live.ts`, `libs/harness/infra/src/workflow/read-model-rebuild.ts`, `libs/harness/infra/src/workflow/daemon-client.ts`, `apps/harness-mcp/src/daemon/unix-socket-daemon.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-daemon-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-shared.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-status-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-complete-helper.ts`, `apps/harness-mcp/src/tools/workflow-plan.tools.ts`, `apps/harness-cli/src/commands/workflow.command.ts`, `apps/harness-cli/src/commands/declarative-cli-workflow.ts` | Non-authoritative `WfRun`/`WfUnit`/`WfAttempt` projections (`wf_probe_runs`, `WorkflowRebuiltRunCount`), Unix-socket `workflow.*` RPCs (`DurableDeferred.tokenFromExecutionId`), read-only `harness_workflow_plan` (`18` canonical MCP tools), `harness workflow` CLI                                                 | `@harness/service/WorkflowProjectionWriter`, `@harness/service/WorkflowReadModelQuery`, `Harness.rebuildWorkflowReadModelViews`, `HarnessCli.workflow`, `HarnessMcp.workflowPlan`, `HarnessDaemonClient.startWorkflow`, `HarnessDaemonClient.getWorkflowStatus`, `HarnessDaemonClient.completeWorkflow`, `HarnessDaemonClient.resumeWorkflow`, `HarnessDaemonClient.abortWorkflow`, `HarnessDaemonClient.doctorWorkflow`, `WorkflowRpcDaemon.handleStartRequest`, `WorkflowRpcDaemon.handleCompleteRequest`, `WorkflowRpcDaemon.handleResumeRequest`, `WorkflowRpcDaemon.handleAbortRequest`, `WorkflowRpcDaemon.handleDoctorRequest`, `WorkflowStoreUnavailableError` |
| Same-UID Worker Isolation Guards (`HARNESS_UNIT_WORKER=1`)   | `libs/harness/gates/src/policy-harness-state.ts`, `libs/harness/gates/src/policy-command-rules.ts`, `libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/hook-fastpath.ts`, `libs/harness/gates/src/plugins/gc/gc-hook-fastpath.ts`, `apps/harness-cli/src/commands/hook-fastpath-core.ts`, `libs/harness/decision/src/guard-decision.ts`                                                                                                                                                                                                                                                                                                                                                 | `HARNESS_UNIT_WORKER=1` blocks recursive `harness workflow` (`start`/`resume`/`abort`/`done`) & `daemon.sock`/`auth-tokens.json` reads/writes while preserving `policy-zero-dep` & `hook-entry-lightweight`                                                                                                           | `Harness.decideGuardCommand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
