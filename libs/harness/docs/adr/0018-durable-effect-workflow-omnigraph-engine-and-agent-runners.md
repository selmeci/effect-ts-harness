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
  - libs/harness/contract/src/index.ts
  - libs/harness/service/src/workflow-ports.ts
  - libs/harness/service/src/index.ts
  - libs/harness/gates/src/plan-workflow-compiler.ts
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/src/policy-shell-parser.ts
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
  - libs/harness/infra/src/omnigraph-message-storage.ts
  - libs/harness/infra/src/workflow/message-storage-codec.ts
  - libs/harness/infra/src/workflow/message-storage-cas.ts
  - libs/harness/infra/src/workflow-engine-live.ts
  - libs/harness/infra/src/workflow-graph-backup.ts
  - libs/harness/infra/src/workflow-maintenance.ts
  - libs/harness/infra/src/workflow/daemon-client.ts
  - libs/harness/infra/src/unix-socket-daemon-live.ts
  - libs/harness/infra/src/index.ts
  - apps/harness-mcp/src/daemon/unix-socket-daemon.ts
  - apps/harness-mcp/src/daemon/workflow-daemon-helper.ts
  - apps/harness-cli/src/commands/omnigraph-lifecycle.ts
  - apps/harness-cli/src/commands/omnigraph-auth-and-drift.ts
  - apps/harness-cli/src/commands/omnigraph-workflow-backup.ts
  - apps/harness-cli/src/commands/omnigraph-lint-gate.ts
  - apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts
spans:
  - PlanWorkflowCompiler.decide
  - WorktreeRepoRoot.validate
  - WorkflowStore.invoke
  - WorkflowStore.invokeWithMeta
  - WorkflowStore.quarantineOrphans
  - WfWriterLease.acquire
  - WfWriterLease.refresh
  - OmnigraphMessageStorage.clearReplies
  - OmnigraphMessageStorage.repairDangling
  - WorkflowGraphBackup.exportBackup
  - WorkflowGraphBackup.restoreBackup
  - WorkflowMaintenance.runOffline
  - HarnessDaemonClient.handshake
  - HarnessDaemonClient.queryCommand
  - WorkflowDaemonHelper.handshake
  - WorkflowDaemonHelper.resolveRequestScope
  - WorkflowDaemonHelper.handleHandshakeRequest
  - OmnigraphWorkflowBackup.beforeRebuild
  - OmnigraphWorkflowBackup.afterRebuild
  - Harness.decideGuardCommand
services:
  - "@harness/service/WorkflowGraphBackup"
errors:
  - CyclicPlanWorkflowError
  - DisjointOwnershipViolationError
  - InvalidPlanWorkflowGraphError
  - WorkflowStoreUnavailableError
  - WriterLeaseHeldError
  - DaemonProtocolMismatchError
informs:
  - harness:SPEC-0017
  - harness:SPEC-0021
---

# ADR-0018 · Durable Effect v4 Workflow Orchestration with Omnigraph-Backed Engine and Agent Runners

## Context and Problem Statement

Multi-slice Route D execution relies on prose checklists across `AGENTS.md` and adapter skills where wave membership, unit completion, escalation state, and ship-gate ordering remain ephemeral inside conversational context. Restarting or compacting a controller session loses in-flight unit state, `AGENTS.md` and skill references require deterministic ship ordering bound to `.harness/verify-stamp.json` (which hashes every non-ignored workspace file), and concurrent linked worktrees require a shared canonical daemon socket and single-writer persistence model.

Effect v4 (`effect@4.0.0`) provides `effect/workflow`, `effect/cluster`, and `effect/Graph`, while the workspace standardizes on `@modernrelay/omnigraph` `0.14.0` rather than introducing SQLite, `node:sqlite`, or an external orchestrator database.

## Decision Drivers

- **Deterministic DAG Compilation & Isolated Write Sets:** Reject dependency cycles and intra-wave write-set overlaps purely (`R = never`) via `PlanWorkflowCompiler.decide` (`harness:SPEC-0017`) before launching worktrees or agents.
- **Durable Omnigraph-Backed Persistence Without External DBs:** Implement `MessageStorage.Encoded` (`OmnigraphMessageStorage`) over a dedicated `harness-workflows` graph (`main` branch only, isolated from `done` overwrites on `harness`) using `SeqKey` 20-char zero-padded decimal ordering, continuous `writeMutex`, and a shared `WORKFLOW_MAX_CONCURRENT_HTTP = 12` semaphore respecting Omnigraph's 16-in-flight actor limit.
- **Single-Writer Fenced Daemon & Least-Privilege Policy Isolation:** Anchor the canonical workflow daemon under `<git-common-dir>/harness/daemon.sock` (fitting safely inside Linux's 107-byte `UNIX_PATH_MAX` limit across linked worktrees), fence writers via OS `flock` + `WfWriterLease` epoch takeover (`acquireWriterLease`), validate client/server versions via `workflow.handshake` (`DaemonProtocolMismatchError`), and enforce disjoint Cedar policy bundles (`workflows.policy.yaml` denying `agent-mcp` reads and mutations on `harness-workflows` with HTTP `404`).
- **Fail-Closed Cluster Rebuilds, Maintenance & Runtime State Protection:** Export and SHA-256-verify `harness-workflows` (`WorkflowGraphBackup.exportBackup` / `OmnigraphWorkflowBackup.beforeRebuild`) prior to stopping `omnigraph-server` on `RequiresCleanRebuild`, restore onto `main` (`mode: "merge"`), bound Lance MVCC growth via offline `optimize` + `cleanup` + `cluster force-unlock` (`WorkflowMaintenance.runOffline`), and deny direct agent reads/writes/probes targeting `<git-common-dir>/harness/**`, `auth-tokens.json`, `daemon.sock`, `daemon.lock`, and `workflow-backups/` in `libs/harness/gates/src/policy.ts`.

## Considered Options

- **Option 1:** Two-level deterministic plan DAG (`PlanWorkflowCompiler.decide`) executed by Effect v4 `ClusterWorkflowEngine` + `OmnigraphMessageStorage` on dedicated graph `harness-workflows` inside the canonical `<git-common-dir>/harness/daemon.sock` daemon, paired with `WfWriterLease` (`flock` + PID liveness), `WorkflowGraphBackup`, offline maintenance, and `policy.ts` runtime-state protection.
- **Option 2:** Retain Markdown checklists in `AGENTS.md` and Route D prose without durable workflow persistence or fenced daemon coordination.
- **Option 3:** Run `SingleRunner.layer` with a secondary SQLite/PGlite database or an external Postgres/Temporal service alongside Omnigraph.

## Decision Outcome

**Chosen option:** "Option 1: Two-level deterministic plan DAG (`PlanWorkflowCompiler.decide`) executed by Effect v4 `ClusterWorkflowEngine` + `OmnigraphMessageStorage` on dedicated graph `harness-workflows` inside the canonical `<git-common-dir>/harness/daemon.sock` daemon, paired with `WfWriterLease` (`flock` + PID liveness), `WorkflowGraphBackup`, offline maintenance, and `policy.ts` runtime-state protection", because WF-0 empirically verified all 13 `MessageStorage.Encoded` operations, `SIGKILL` recovery, export/restore, and disjoint Cedar isolation against `omnigraph-server 0.14.0` without introducing a second database.

### Architectural Rules and Guarantees

1. **Pure Plan Compilation (`harness:SPEC-0017`):** `PlanWorkflowCompiler.decide` (`R = never`) compiles `CompileInput` via `effect/Graph` (`Graph.isAcyclic` and `Graph.values(Graph.topo(...))`), enforcing acyclic dependencies and pairwise `pathsOverlap`-disjoint `ownedRelPaths` per wave.
2. **Dedicated `harness-workflows` Graph & `OmnigraphMessageStorage` (`harness:SPEC-0021`):** Workflow envelopes (`WfMessage`), replies (`WfReply`), writer leases (`WfWriterLease`), and reconstructible read-model summaries (`WfRun`, `WfUnit`, `WfAttempt`, `WfShipAttempt`) live in `libs/harness/graph/workflows.schema.pg` and 36 GQ 2.1 queries in `libs/harness/graph/workflow-queries/workflows.gq`. `OmnigraphMessageStorage` sorts losslessly on 20-character zero-padded `SeqKey` strings, groups `opts.addresses` by `entityType` in GQ (`wf_unprocessed_candidate_messages_for_addresses`) before `limit`, executes atomic `wf_clear_address`, enforces continuous `writeMutex` across `D2` two-commit `$expectedReplyId` CAS `clearOmnigraphReplies` with `wf_repair_dangling_requests` compensation (`compensateDanglingOnce` outside retry sleeps), and routes all HTTP calls through `WORKFLOW_MAX_CONCURRENT_HTTP = 12` with `AbortSignal.timeout` and `429`/`412` retries (`WORKFLOW_MAX_OCC_RETRIES = 48`).
3. **Single-Writer Fenced Daemon & Linked-Worktree IPC:** All writes to `harness-workflows` originate exclusively from the canonical daemon listening at `<git-common-dir>/harness/daemon.sock`. `acquireWriterLease` pairs OS advisory `flock` on `<git-common-dir>/harness/daemon.lock` with `WfWriterLease` epoch fencing (`WriterLeaseHeldError`) and PID-liveness + `/proc/<pid>/stat` start-time takeover (`WRITER_LEASE_HEARTBEAT_TTL_MS = 45_000` fallback). Clients validate `worktreeRoot` via `validateWorktreeRepoRoot` and perform `workflow.handshake` (`handshakeWorkflowDaemon` / `handleWorkflowDaemonHandshake`, `WORKFLOW_DAEMON_IPC_TIMEOUT_MS = 30_000`) failing with `DaemonProtocolMismatchError` on stale daemons rather than bypassing daemon IPC.
4. **Fail-Closed Rebuild Backup, Offline Maintenance & Disjoint Cedar Policy:** `cluster.yaml` mounts `workflows.policy.yaml` (`admins: [harness-cli]` only) separately from `graph.policy.yaml`. `CONFIG_DIGEST_FILES` tracks workflow config assets so additive updates use `LiveClusterApply`, while `RequiresCleanRebuild` invokes `OmnigraphWorkflowBackup.beforeRebuild` before `killOmnigraphServerPidIfAlive`, persists `pending-workflow-restore.json`, and runs `OmnigraphWorkflowBackup.afterRebuild` (`mode: "merge"` + `expectedSha256`) before `server.json` publication, aborting fail-closed on export or restore failure. `runOfflineWorkflowMaintenance` automates offline `omnigraph optimize` + `omnigraph cleanup --keep 1 --confirm` (with configurable `keepVersions`) + `omnigraph cluster force-unlock` under `.startup.lock` -> `daemon.lock`.
5. **Runtime State Protection (`policy.ts` & `policy-shell-parser.ts`):** `explainCommandDenyRule` (`isHarnessStateMutationCommand`, `HARNESS_STATE_READ_BINARIES`, `harness-state-mutation`, `secret-file-access`), quote-aware `extractCommandSegments` / `unwrapCommandSegment`, and `classifyFileWrite` (`harness-common-dir-state`) block agent mutations, direct reads (`workflow-backups/`, `daemon.lock`, `auth-tokens.json`), and socket probes targeting `<git-common-dir>/harness/**`.
6. **Staged Rollout Separation:** WF-1 (`harness:SPEC-0017`) delivers contracts and the DAG compiler; WF-2 (`harness:SPEC-0021`) delivers `harness-workflows` schema/queries/policy, `OmnigraphMessageStorage`, `WfWriterLease`, daemon handshake, backup/maintenance, and runtime-state policy guards; WF-3 through WF-6 (`HarnessTaskWorkflow`, `ShipWorkflow`, `AgentRunnerPort`, and `WorkflowProjector`) build atop WF-2 in subsequent specs.

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

| Rule                                                         | Enforced By                                                                                                                                                                                                                                                                                                                                                                                                                       | Gate / Mechanism                                                                                                                                                                                                                                                                      | Governed Symbols                                                                                                                                                                                                                                             |
| :----------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acyclic & Disjoint DAG Compilation                           | `libs/harness/gates/src/plan-workflow-compiler.ts`, `libs/harness/contract/src/workflow.ts`, `libs/harness/contract/src/index.ts`                                                                                                                                                                                                                                                                                                 | `PlanWorkflowCompiler` DAG validation and wave splitting (`wavesOf`, `pathsOverlap`)                                                                                                                                                                                                  | `PlanWorkflowCompiler.decide`, `CyclicPlanWorkflowError`, `DisjointOwnershipViolationError`, `InvalidPlanWorkflowGraphError`                                                                                                                                 |
| Omnigraph Workflow Store, Concurrency Cap & `SeqKey` Mailbox | `libs/harness/infra/src/omnigraph-workflow-store.ts`, `libs/harness/infra/src/omnigraph-message-storage.ts`, `libs/harness/infra/src/workflow/message-storage-codec.ts`, `libs/harness/infra/src/workflow/message-storage-cas.ts`, `libs/harness/infra/src/workflow-engine-live.ts`, `libs/harness/infra/src/index.ts`, `libs/harness/graph/workflows.schema.pg`, `libs/harness/graph/workflow-queries/workflows.gq`              | `WORKFLOW_MAX_CONCURRENT_HTTP`, `WORKFLOW_MAX_OCC_RETRIES`, `SeqKey`, `clearOmnigraphReplies`, `compensateDanglingOnce`, `wf_clear_address`, `makeOmnigraphEncodedDriver`, `makeHarnessWorkflowEngineLayer`                                                                           | `WorkflowStore.invoke`, `WorkflowStore.invokeWithMeta`, `WorkflowStore.quarantineOrphans`, `OmnigraphMessageStorage.clearReplies`, `OmnigraphMessageStorage.repairDangling`, `WorkflowStoreUnavailableError`                                                 |
| Fenced Single-Writer Lease & Disjoint Cedar Policy           | `libs/harness/infra/src/writer-lease.ts`, `libs/harness/infra/src/workflow/flock-lock.ts`, `libs/harness/graph/cluster.yaml`, `libs/harness/graph/workflows.policy.yaml`, `libs/harness/graph/workflow-policy-tests.yaml`, `libs/harness/graph/src/omnigraph-operations.ts`, `libs/harness/graph/src/omnigraph-v014-ops.ts`                                                                                                       | `acquireWriterLease`, `withAdvisoryFlock`, `refreshWriterLease` (`WRITER_LEASE_HEARTBEAT_TTL_MS`), `omnigraph` Cedar policy assertions                                                                                                                                                | `WfWriterLease.acquire`, `WfWriterLease.refresh`, `WriterLeaseHeldError`, `WorkflowStoreUnavailableError`                                                                                                                                                    |
| Canonical Worktree Root & Versioned Daemon Handshake         | `libs/harness/infra/src/worktree-repo-root.ts`, `libs/harness/infra/src/workflow/daemon-client.ts`, `libs/harness/infra/src/unix-socket-daemon-live.ts`, `libs/harness/graph/src/cluster-resolver.ts`, `apps/harness-mcp/src/daemon/workflow-daemon-helper.ts`, `apps/harness-mcp/src/daemon/unix-socket-daemon.ts`, `apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts`                                              | `validateWorktreeRepoRoot`, `resolveGitCommonDir`, `resolveHarnessDaemonSocketPath`, `handshakeWorkflowDaemon` (`WORKFLOW_DAEMON_IPC_TIMEOUT_MS`), `queryWorkflowDaemonCommand`, `handleWorkflowDaemonHandshake`, `resolveDaemonRequestScope`, `handleDaemonWorkflowHandshakeRequest` | `WorktreeRepoRoot.validate`, `HarnessDaemonClient.handshake`, `HarnessDaemonClient.queryCommand`, `WorkflowDaemonHelper.handshake`, `WorkflowDaemonHelper.resolveRequestScope`, `WorkflowDaemonHelper.handleHandshakeRequest`, `DaemonProtocolMismatchError` |
| Fail-Closed Rebuild Backup & Offline Lance Maintenance       | `libs/harness/service/src/workflow-ports.ts`, `libs/harness/service/src/index.ts`, `libs/harness/infra/src/workflow-graph-backup.ts`, `libs/harness/infra/src/workflow-maintenance.ts`, `apps/harness-cli/src/commands/omnigraph-workflow-backup.ts`, `apps/harness-cli/src/commands/omnigraph-lifecycle.ts`, `apps/harness-cli/src/commands/omnigraph-auth-and-drift.ts`, `apps/harness-cli/src/commands/omnigraph-lint-gate.ts` | `exportWorkflowGraphBackup`, `restoreWorkflowGraphBackup`, `expectedSha256`, `beforeRebuildWorkflowBackup`, `afterRebuildWorkflowBackup`, `writePendingWorkflowRestoreJournal`, `runOfflineWorkflowMaintenance`, `runOfflineOmnigraphLintGate`                                        | `@harness/service/WorkflowGraphBackup`, `WorkflowGraphBackup.exportBackup`, `WorkflowGraphBackup.restoreBackup`, `OmnigraphWorkflowBackup.beforeRebuild`, `OmnigraphWorkflowBackup.afterRebuild`, `WorkflowMaintenance.runOffline`                           |
| Protected Harness Runtime State & Secret Guards              | `libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/policy-shell-parser.ts`                                                                                                                                                                                                                                                                                                                                               | `explainCommandDenyRule` (`isHarnessStateMutationCommand`, `HARNESS_STATE_READ_BINARIES`, `harness-state-mutation`, `secret-file-access`), `extractCommandSegments`, `unwrapCommandSegment`, `classifyFileWrite` (`harness-common-dir-state`)                                         | `Harness.decideGuardCommand`                                                                                                                                                                                                                                 |
