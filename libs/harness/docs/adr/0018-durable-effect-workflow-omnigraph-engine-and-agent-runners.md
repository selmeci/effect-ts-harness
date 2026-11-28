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
  - libs/harness/contract/src/workflow-verify-command.ts
  - libs/harness/gates/src/policy-worker-isolation.ts
  - libs/harness/infra/src/hook-io-realpath.ts
  - libs/harness/infra/src/workflow/read-model-rebuild-journal.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-complete-validation.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-doctor-helper.ts
  - apps/harness-cli/src/commands/workflow-command-helpers.ts
  - apps/harness-cli/src/commands/hook-guard-payload.ts
  - tools/oxlint/syntax-bans.js
  - libs/harness/contract/src/workflow-ship.ts
  - libs/harness/contract/src/workflow-protocol.ts
  - libs/harness/contract/src/workflow-timeouts.ts
  - libs/harness/gates/src/ship-workflow.ts
  - libs/harness/gates/src/index.ts
  - libs/harness/infra/src/workflow/ship-gate-runner-live.ts
  - libs/harness/infra/src/workflow/ship-format-files.ts
  - libs/harness/infra/src/workflow/ship-attempt-store-live.ts
  - libs/harness/infra/src/workflow/ship-daemon-client.ts
  - apps/harness-mcp/src/daemon/workflow-ports-daemon-helper.ts
  - apps/harness-mcp/src/daemon/workflow-rpc-ship-helper.ts
  - apps/harness-cli/src/commands/done-cli-helper.ts
  - apps/harness-cli/src/commands/verify-and-done.command.ts
  - apps/harness-cli/src/commands/declarative-cli.ts
  - apps/harness-cli/src/commands/declarative-cli-flags.ts
  - libs/harness/contract/src/workflow-runners.ts
  - libs/harness/infra/src/workflow/runner-profiles.ts
  - libs/harness/infra/src/workflow/agent-runner-outcome.ts
  - libs/harness/infra/src/workflow/unit-brief-builder.ts
  - libs/harness/infra/src/workflow/verify-child-process.ts
  - libs/harness/infra/src/workflow/runner-process-supervision.ts
  - libs/harness/infra/src/workflow/agent-runners-live.ts
  - libs/harness/infra/src/workflow/runner-doctor.ts
  - libs/harness/contract/src/workflow-projection.ts
  - libs/harness/graph/schema.pg
  - libs/harness/graph/queries/harness.gq
  - libs/harness/graph/graph.policy.yaml
  - libs/harness/graph/src/gq-query-descriptors.ts
  - libs/harness/graph/src/gq-static-assets.ts
  - libs/harness/graph/src/gq-queries.ts
  - libs/harness/gates/src/omnigraph-branch-verify.ts
  - libs/harness/infra/src/workflow/workflow-projector-live.ts
  - libs/harness/infra/src/workflow/workflow-projector-planner.ts
  - libs/harness/infra/src/workflow/workflow-projector-query.ts
  - apps/harness-cli/src/commands/done-workflow-projector.ts
  - apps/harness-cli/src/commands/done-omnigraph-helpers.ts
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
  - AgentRunner.run
  - ClaudeCodeRunner.run
  - AntigravityRunner.run
  - UnitAgentDispatcher.dispatchUnit
  - WorkflowProjector.project
  - WorkflowProjector.projectAll
  - WorkflowProjector.getProjectionStatus
  - DoneWorkflowProjector.reprojectBeforeMerge
  - OmnigraphSchemaEvolution.decide
  - WorkflowRpcDaemon.buildStatusSummary
services:
  - "@harness/service/WorkflowGraphBackup"
  - "@harness/service/UnitVerifier"
  - "@harness/service/UnitAgentDispatcher"
  - "@harness/service/AgentRunnerPort"
  - "@harness/service/WorkflowWorktreePort"
  - "@harness/service/WorkflowReviewRouter"
  - "@harness/service/WorkflowProjectionWriter"
  - "@harness/service/WorkflowReadModelQuery"
  - "@harness/service/ShipGateRunner"
  - "@harness/service/ShipAttemptStore"
  - "@harness/service/WorkflowProjector"
errors:
  - CyclicPlanWorkflowError
  - DisjointOwnershipViolationError
  - InvalidPlanWorkflowGraphError
  - WorkflowStoreUnavailableError
  - WriterLeaseHeldError
  - DaemonProtocolMismatchError
  - TaskRunAbortedError
  - WorkspaceFsError
  - ShipGateFailedError
  - ShipTreeMismatchError
  - MutationRestoreError
  - ShipTreeDriftError
  - AgentTimeoutError
  - AgentToolDeniedError
  - AgentAuthRequiredError
  - AgentExitError
  - AgentOutputParseError
  - AgentNoChangeError
informs:
  - harness:SPEC-0017
  - harness:SPEC-0021
  - harness:SPEC-0023
  - harness:SPEC-0032
  - harness:SPEC-0036
  - harness:SPEC-0038
---

# ADR-0018 · Durable Effect v4 Workflow Orchestration with Omnigraph-Backed Engine and Agent Runners

## Context and Problem Statement

Multi-slice Route D execution relies on prose checklists across `AGENTS.md` and adapter skills where wave membership, unit completion, escalation state, and ship-gate ordering remain ephemeral inside conversational context. Restarting or compacting a controller session loses in-flight unit state, `AGENTS.md` and skill references require deterministic ship ordering bound to `.harness/verify-stamp.json` (which hashes every non-ignored workspace file), and concurrent linked worktrees require a shared canonical daemon socket and single-writer persistence model.

Effect v4 (`effect@4.0.0`) provides `effect/workflow`, `effect/cluster`, and `effect/Graph`, while the workspace standardizes on `@modernrelay/omnigraph` `0.14.0` rather than introducing SQLite, `node:sqlite`, or an external orchestrator database.

## Decision Drivers

- **Deterministic DAG Compilation & Isolated Write Sets:** Reject dependency cycles and intra-wave write-set overlaps purely (`R = never`) via `PlanWorkflowCompiler.decide` (`harness:SPEC-0017`) before launching worktrees or agents.
- **Durable Omnigraph-Backed Persistence Without External DBs:** Implement `MessageStorage.Encoded` (`OmnigraphMessageStorage`) over a dedicated `harness-workflows` graph (`main` branch only, isolated from `done` overwrites on `harness`) using `SeqKey` 20-char zero-padded decimal ordering, continuous `writeMutex`, and a shared `WORKFLOW_MAX_CONCURRENT_HTTP = 12` semaphore respecting Omnigraph's 16-in-flight actor limit.
- **Single-Writer Fenced Daemon & Least-Privilege Policy Isolation:** Anchor the canonical workflow daemon under `<git-common-dir>/harness/daemon.sock` (targeting a verified `<= 70 B` budget well below platform-dependent OS `sun_path` socket path caps across linked worktrees), fence store, projection, and rebuild writes against active `expectedLeaseEpoch` (`>= 1`) and `ifGraphCommit` via OS `flock` + `WfWriterLease` epoch takeover (`acquireWriterLease`) wired through `Scope` (with dedicated lease bootstrap/CAS mutations `wf_insert_writer_lease` / `wf_cas_writer_lease` and offline backup restore lock protocols), validate client/server versions via `workflow.handshake` (`DaemonProtocolMismatchError`), and enforce disjoint Cedar policy bundles (`workflows.policy.yaml` denying `agent-mcp` stored-query invocations on `harness-workflows` with HTTP `404` and direct `snapshot`/`list`/`query`/`mutate` access with HTTP `403`).
- **Fail-Closed Cluster Rebuilds, Maintenance & Runtime State Protection:** Export and SHA-256-verify `harness-workflows` (`WorkflowGraphBackup.exportBackup` / `OmnigraphWorkflowBackup.beforeRebuild`) prior to stopping `omnigraph-server` on `RequiresCleanRebuild`, bind `pending-workflow-restore.json` to `clusterRootDir` + `preRebuildConfigStamp`, restore onto `main` (`mode: "merge"` requiring both `WfMessage` and `WfReply` parity, or `mode: "replace"` requiring `expectedSha256` and non-empty backups), bound Lance MVCC growth via offline `optimize` + `cleanup` + `cluster force-unlock` (`WorkflowMaintenance.runOffline`) after validating safety exports, and deny direct agent reads/writes/probes across any argument targeting `<git-common-dir>/harness/**`, `auth-tokens.json`, `daemon.sock`, `daemon.lock`, `workflow-backups/`, or `pending-workflow-restore.json` in `libs/harness/gates/src/policy.ts`.

## Considered Options

- **Option 1:** Two-level deterministic plan DAG (`PlanWorkflowCompiler.decide`) executed by Effect v4 `ClusterWorkflowEngine` + `OmnigraphMessageStorage` on dedicated graph `harness-workflows` inside the canonical `<git-common-dir>/harness/daemon.sock` daemon, paired with `WfWriterLease` (`flock` + PID liveness), `WorkflowGraphBackup`, offline maintenance, and `policy.ts` runtime-state protection.
- **Option 2:** Retain Markdown checklists in `AGENTS.md` and Route D prose without durable workflow persistence or fenced daemon coordination.
- **Option 3:** Run `SingleRunner.layer` with a secondary SQLite/PGlite database or an external Postgres/Temporal service alongside Omnigraph.

## Decision Outcome

**Chosen option:** "Option 1: Two-level deterministic plan DAG (`PlanWorkflowCompiler.decide`) executed by Effect v4 `ClusterWorkflowEngine` + `OmnigraphMessageStorage` on dedicated graph `harness-workflows` inside the canonical `<git-common-dir>/harness/daemon.sock` daemon, paired with `WfWriterLease` (`flock` + PID liveness), `WorkflowGraphBackup`, offline maintenance, and `policy.ts` runtime-state protection", because WF-0 empirically verified all 13 `MessageStorage.Encoded` operations, `SIGKILL` recovery, export/restore, and disjoint Cedar isolation against `omnigraph-server 0.14.0` without introducing a second database.

### Architectural Rules and Guarantees

1. **Pure Plan Compilation (`harness:SPEC-0017`):** `PlanWorkflowCompiler.decide` (`R = never`) compiles `CompileInput` via `effect/Graph` (`Graph.isAcyclic` and `Graph.values(Graph.topo(...))`), enforcing acyclic dependencies and pairwise `pathsOverlap`-disjoint `ownedRelPaths` per wave.
2. **Dedicated `harness-workflows` Graph & `OmnigraphMessageStorage` (`harness:SPEC-0021`):** Workflow envelopes (`WfMessage`), replies (`WfReply`), writer leases (`WfWriterLease`), and reconstructible read-model summaries (`WfRun`, `WfUnit`, `WfAttempt`, `WfShipAttempt`) live in `libs/harness/graph/workflows.schema.pg` and 55 declared GQ 2.1 queries in `libs/harness/graph/workflow-queries/workflows.gq` (typed in `@harness/contract` via `WorkflowGqQueryName` and `WorkflowGqParamsMap`). `OmnigraphMessageStorage` sorts losslessly on 20-character zero-padded `SeqKey` strings, groups `opts.addresses` by `entityType` in GQ (`wf_unprocessed_candidate_messages_for_addresses`) before `limit`, executes atomic `wf_clear_address`, implements `withTransaction` as pass-through over single-request atomic GQ mutations while enforcing continuous `writeMutex` across `D2` two-commit `$expectedReplyId` CAS `clearOmnigraphReplies` with `wf_repair_dangling_requests` compensation (`compensateDanglingOnce` outside retry sleeps), enforces Effect Cluster's 6-hour (`DEFAULT_WORKFLOW_CLAIM_TIMEOUT_MS`) claim expiry window on `OmnigraphMessageStorage` (`claimTimeoutMs`), routes corrupt rows through terminal `WithExit(Die)` handling matching Effect Cluster `MessageStorage`, and routes all HTTP calls through `WORKFLOW_MAX_CONCURRENT_HTTP = 12` with `AbortSignal.timeout` and `429`/`412` retries (`WORKFLOW_MAX_OCC_RETRIES = 48`).
3. **Single-Writer Fenced Daemon & Linked-Worktree IPC:** All writes to `harness-workflows` originate exclusively from the canonical daemon listening at `<git-common-dir>/harness/daemon.sock`. `acquireWriterLease` uses `Effect.acquireRelease` (`Scope.Scope`) pairing OS advisory `flock` on `<git-common-dir>/harness/daemon.lock` with `WfWriterLease` epoch fencing (`WriterLeaseHeldError`) and PID-liveness + `/proc/<pid>/stat` start-time takeover (`WRITER_LEASE_HEARTBEAT_TTL_MS = 45_000` fallback), while store, projection, and rebuild writes fence against active `expectedLeaseEpoch` (`>= 1`) and `ifGraphCommit` (lease bootstrap/takeover uses `wf_insert_writer_lease` / `wf_cas_writer_lease`, and offline maintenance uses offline lock/server checks). Clients validate `worktreeRoot` via `validateWorktreeRepoRoot`, run `workflow.handshake` (`handshakeWorkflowDaemon` / `handleWorkflowDaemonHandshake`, `WORKFLOW_DAEMON_IPC_TIMEOUT_MS = 30_000`, `WORKFLOW_COMPLETE_IPC_TIMEOUT_MS = 150_000`) failing with `DaemonProtocolMismatchError` on stale daemons or inactive leases, and fall back to in-process AST/graph extraction when a linked worktree's rule version differs from the daemon's `startupRuleVersion`.
4. **Fail-Closed Rebuild Backup, Offline Maintenance & Disjoint Cedar Policy:** `cluster.yaml` mounts `workflows.policy.yaml` (`admins: [harness-cli]` only) separately from `graph.policy.yaml`. `CONFIG_DIGEST_FILES` tracks workflow config assets so additive updates use `LiveClusterApply`, while `RequiresCleanRebuild` invokes `OmnigraphWorkflowBackup.beforeRebuild` under `daemon.lock` before `killOmnigraphServerPidIfAlive`, persists `pending-workflow-restore.json` bound to `clusterRootDir` and `preRebuildConfigStamp`, and runs `OmnigraphWorkflowBackup.afterRebuild` (`mode: "merge"` + `expectedSha256`) verifying both `WfMessage` (`wf_count_all`, `>=` in `merge`, `===` in non-empty `replace`) and `WfReply` (`wf_count_replies`) counts before `server.json` publication, aborting fail-closed on export or restore failure. `runOfflineWorkflowMaintenance` automates offline `omnigraph optimize`, safety backup verification, `omnigraph cleanup --keep 1 --confirm` (with configurable `keepVersions`), and `omnigraph cluster force-unlock` after checking cluster lock/server state fail-closed.
5. **Runtime State Protection (`policy.ts` & `policy-shell-parser.ts`):** `explainCommandDenyRule` (`harness-state-mutation`, `secret-file-access`), wrapper-unwrapping `extractCommandSegments` / `unwrapCommandSegment` (`timeout`, `nice`, `nohup`, `stdbuf`, `time`, `bun` runners), and `classifyFileWrite` (`harness-common-dir-state`) block agent mutations, direct reads (`grep`, `cat`, probes), custom common-dir targets, and `$(git rev-parse --git-common-dir)/harness` command substitutions across any non-exempt command argument targeting `<git-common-dir>/harness/**`, exempting only `ls`, read-only `find`, `dropDataArguments`-stripped messages, and `pnpm harness`.
6. **Staged Rollout Separation:** WF-1 (`harness:SPEC-0017`) delivers contracts and the DAG compiler; WF-2 (`harness:SPEC-0021`) delivers `harness-workflows` schema/queries/policy, `OmnigraphMessageStorage`, `WfWriterLease`, daemon handshake, backup/maintenance, and runtime-state policy guards; WF-3 (`harness:SPEC-0023`) delivers durable `HarnessTaskWorkflow` orchestration, `"nondeterministic-workflow-body"` AST/oxlint gates, `UnitVerifierLive`, `WfRun`/`WfUnit`/`WfAttempt` projections (non-authoritative for workflow replay; read by daemon control-plane RPCs), `workflow.*` daemon RPCs, `harness_workflow_plan` (`18` canonical MCP tools), `harness workflow` CLI, and `HARNESS_UNIT_WORKER=1` same-UID isolation guards when set on unit worker invocations; **WF-4 (`harness:SPEC-0032`)** delivers `ShipWorkflow`, fenced OCC `WfShipAttempt` tracking, `workflow.ship` streaming daemon IPC, `done --cli`, and cross-adapter `effect-lfg` integration; **WF-5 (`harness:SPEC-0036`)** delivers human-reviewed `runner-profiles.ts` (`claude-code` & `antigravity` without `--dangerously-skip-permissions`), `AgentRunnerPort`, env allow-listing with `HARNESS_UNIT_WORKER=1` and `ANTIGRAVITY_*`/`AGY_*` stripping, POSIX process-group supervision & orphan reaping, `ClaudeCodeRunnerLive`, `AntigravityRunnerLive`, `UnitBrief` / `toOutcome`, `"live"` `UnitAgentDispatcherLive`, and `workflow doctor` runner checks; **WF-6 (`harness:SPEC-0038`)** completes the RFC-0013 milestone roadmap by adding `WorkflowRun`/`WorkUnit`/`UnitAttempt` and 6 keyed `Plays*Role` edges in `schema.pg`, `workflow_pending_units` / `ears_without_completed_unit` GQ 2.1 presets, idempotent `ifGraphCommit`-fenced `WorkflowProjectorLive`, wave/done-pre-merge/post-rebuild trigger hooks, and non-fatal `"stale"` status propagation without altering `CANONICAL_MCP_TOOL_NAMES` (`20`).

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

| Rule                                                         | Enforced By                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Gate / Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Governed Symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| :----------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acyclic & Disjoint DAG Compilation                           | `libs/harness/gates/src/plan-workflow-compiler.ts`, `libs/harness/contract/src/workflow.ts`, `libs/harness/contract/src/workflow-verify-command.ts`, `libs/harness/contract/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `PlanWorkflowCompiler` DAG validation and wave splitting (`wavesOf`, `pathsOverlap`, `PackageVerifyCommand`)                                                                                                                                                                                                                                                                                                                                                                                                                               | `PlanWorkflowCompiler.decide`, `CyclicPlanWorkflowError`, `DisjointOwnershipViolationError`, `InvalidPlanWorkflowGraphError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Omnigraph Workflow Store, Concurrency Cap & `SeqKey` Mailbox | `libs/harness/contract/src/workflow-storage.ts`, `libs/harness/infra/src/omnigraph-workflow-store.ts`, `libs/harness/infra/src/omnigraph-message-storage.ts`, `libs/harness/infra/src/workflow/message-storage-codec.ts`, `libs/harness/infra/src/workflow/message-storage-cas.ts`, `libs/harness/infra/src/workflow/message-storage-hydration.ts`, `libs/harness/infra/src/workflow-engine-live.ts`, `libs/harness/infra/src/index.ts`, `libs/harness/graph/workflows.schema.pg`, `libs/harness/graph/workflow-queries/workflows.gq`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `WORKFLOW_MAX_CONCURRENT_HTTP`, `WORKFLOW_MAX_OCC_RETRIES`, `SeqKey`, `WorkflowGqQueryName`, `WorkflowGqParamsMap`, `clearOmnigraphReplies`, `compensateDanglingOnce`, `repairDanglingProcessedRequests`, `wf_clear_address`, `makeOmnigraphEncodedDriver`, `makeHarnessWorkflowEngineLayer`                                                                                                                                                                                                                                               | `WorkflowStore.invoke`, `WorkflowStore.invokeWithMeta`, `WorkflowStore.quarantineOrphans`, `OmnigraphMessageStorage.clearReplies`, `OmnigraphMessageStorage.repairDangling`, `WorkflowStoreUnavailableError`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Fenced Single-Writer Lease & Disjoint Cedar Policy           | `libs/harness/contract/src/workflow-storage.ts`, `libs/harness/infra/src/writer-lease.ts`, `libs/harness/infra/src/workflow/flock-lock.ts`, `libs/harness/infra/src/workflow/writer-lease-codec.ts`, `apps/harness-mcp/src/daemon/workflow-engine-daemon-helper.ts`, `libs/harness/graph/cluster.yaml`, `libs/harness/graph/workflows.policy.yaml`, `libs/harness/graph/workflow-policy-tests.yaml`, `libs/harness/graph/src/omnigraph-operations.ts`, `libs/harness/graph/src/omnigraph-v014-ops.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `acquireWriterLease`, `withAdvisoryFlock`, `refreshWriterLease` (`WRITER_LEASE_HEARTBEAT_TTL_MS`), `acquireWorkflowEngineInScope`, `omnigraph` Cedar policy assertions                                                                                                                                                                                                                                                                                                                                                                     | `WfWriterLease.acquire`, `WfWriterLease.refresh`, `HarnessDaemon.acquireWorkflowEngineInScope`, `WriterLeaseHeldError`, `WorkflowStoreUnavailableError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Canonical Worktree Root & Versioned Daemon Handshake         | `libs/harness/contract/src/workflow-storage.ts`, `libs/harness/infra/src/worktree-repo-root.ts`, `libs/harness/infra/src/workflow/daemon-client.ts`, `libs/harness/infra/src/unix-socket-daemon-live.ts`, `libs/harness/graph/src/cluster-resolver.ts`, `apps/harness-mcp/src/daemon/workflow-daemon-helper.ts`, `apps/harness-mcp/src/daemon/worktree-scope-cache.ts`, `apps/harness-mcp/src/daemon/ast-gate-daemon-helper.ts`, `apps/harness-mcp/src/daemon/unix-socket-daemon.ts`, `apps/harness-cli/src/commands/daemon-and-omnigraph.service.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `validateWorktreeRepoRoot`, `resolveGitCommonDir`, `resolveHarnessDaemonSocketPath`, `handshakeWorkflowDaemon` (`WORKFLOW_DAEMON_IPC_TIMEOUT_MS`), `queryWorkflowDaemonCommand`, `handleWorkflowDaemonHandshake`, `makeDaemonWorktreeScopeCache`, `resolveDaemonRequestScope`, `handleDaemonWorkflowHandshakeRequest`                                                                                                                                                                                                                      | `WorktreeRepoRoot.validate`, `HarnessDaemonClient.handshake`, `HarnessDaemonClient.queryCommand`, `WorkflowDaemonHelper.handshake`, `WorkflowDaemonHelper.makeScopeCache`, `WorkflowDaemonHelper.resolveRequestScope`, `WorkflowDaemonHelper.handleHandshakeRequest`, `DaemonProtocolMismatchError`                                                                                                                                                                                                                                                                                                                                                                    |
| Fail-Closed Rebuild Backup & Offline Lance Maintenance       | `libs/harness/contract/src/workflow-storage.ts`, `libs/harness/service/src/workflow-ports.ts`, `libs/harness/service/src/index.ts`, `libs/harness/infra/src/workflow-graph-backup.ts`, `libs/harness/infra/src/workflow-maintenance.ts`, `libs/harness/infra/src/workflow/cluster-startup-lock.ts`, `apps/harness-cli/src/commands/omnigraph-workflow-backup.ts`, `apps/harness-cli/src/commands/omnigraph-workflow-journal.ts`, `apps/harness-cli/src/commands/omnigraph-lifecycle.ts`, `apps/harness-cli/src/commands/omnigraph-lifecycle-setup.ts`, `apps/harness-cli/src/commands/omnigraph-auth-and-drift.ts`, `apps/harness-cli/src/commands/omnigraph-lint-gate.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `exportWorkflowGraphBackup`, `restoreWorkflowGraphBackup`, `expectedSha256`, `beforeRebuildWorkflowBackup`, `afterRebuildWorkflowBackup`, `writePendingWorkflowRestoreJournal`, `runOfflineWorkflowMaintenance`, `acquireOmnigraphClusterLockEffect`, `runOfflineOmnigraphLintGate`                                                                                                                                                                                                                                                        | `@harness/service/WorkflowGraphBackup`, `WorkflowGraphBackup.exportBackup`, `WorkflowGraphBackup.restoreBackup`, `OmnigraphWorkflowBackup.beforeRebuild`, `OmnigraphWorkflowBackup.afterRebuild`, `WorkflowMaintenance.runOffline`, `OmnigraphCluster.acquireStartupLock`                                                                                                                                                                                                                                                                                                                                                                                              |
| Protected Harness Runtime State & Secret Guards              | `libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/policy-shell-parser.ts`, `libs/harness/gates/src/policy-harness-state.ts`, `libs/harness/gates/src/policy-command-rules.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `explainCommandDenyRule` (`isHarnessStateMutationCommand`, `isHarnessStateAccessCommand`, `HARNESS_STATE_MUTATING_BINARIES`, `HARNESS_SOCKET_OR_SCRIPT_BINARIES`, `harness-state-mutation`, `secret-file-access`), `extractCommandSegments`, `unwrapCommandSegment`, `classifyFileWrite` (`harness-common-dir-state`)                                                                                                                                                                                                                      | `Harness.decideGuardCommand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Durable `HarnessTaskWorkflow` Orchestration & Determinism    | `libs/harness/gates/src/harness-task-workflow.ts`, `libs/harness/gates/src/harness-task-workflow-projections.ts`, `libs/harness/contract/src/workflow-rpc.ts`, `libs/harness/service/src/workflow-ports.ts`, `libs/harness/gates/src/plugins/workflow-body-ast.ts`, `libs/harness/gates/src/plugins/ast-gate-visitors.ts`, `tools/oxlint/syntax-bans.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `Workflow.make("HarnessTaskWorkflow", ...)` keyed by `plan.runId`, `Workflow.withCompensation`, bounded retry/escalation, `"nondeterministic-workflow-body"` AST & oxlint gate                                                                                                                                                                                                                                                                                                                                                             | `Harness.executeTaskWorkflow`, `Harness.driveWorkUnit`, `Harness.driveSharedStep`, `SyntaxBans.decide`, `TaskRunAbortedError`, `@harness/service/UnitAgentDispatcher`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Shared Unit Verification & Linked-Worktree Slice Merge       | `libs/harness/infra/src/workflow/unit-verifier-live.ts`, `libs/harness/infra/src/workflow/worktree-port-live.ts`, `libs/harness/infra/src/workflow/review-router-live.ts`, `libs/harness/infra/src/workflow/agent-dispatcher-live.ts`, `libs/harness/infra/src/workflow/plan-compiler-extractor.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `UnitVerifierLive` (`git diff --no-renames -z`, case-sensitive NFC ownership, L1/L2 stamp validation, `priorUnitOwnedPaths` exclusion), `WorkflowWorktreePortLive` non-destructive provisioning under `<canonicalRepoRoot>/.harness/workflow-worktrees/<runId>/<unitId>` & conflict-checked merges, `WorkflowReviewRouterLive`                                                                                                                                                                                                             | `@harness/service/UnitVerifier`, `@harness/service/WorkflowWorktreePort`, `@harness/service/WorkflowReviewRouter`, `Harness.completeUnit`, `Harness.completeSharedStep`, `Harness.provisionWorkflowWorktrees`, `Harness.mergeSliceWave`, `Harness.removeWorktreeCheckouts`, `Harness.routeWorkflowReview`, `Harness.compileWorkflowPlanFromRepo`, `Harness.routeReviewDiff`, `WorkspaceFsError`                                                                                                                                                                                                                                                                        |
| Non-Authoritative Read Model, Daemon IPC & CLI/MCP Surface   | `libs/harness/graph/workflow-queries/workflows.gq`, `libs/harness/infra/src/workflow/read-model-live.ts`, `libs/harness/infra/src/workflow/read-model-rebuild.ts`, `libs/harness/infra/src/workflow/read-model-rebuild-journal.ts`, `libs/harness/infra/src/workflow/daemon-client.ts`, `apps/harness-mcp/src/daemon/unix-socket-daemon.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-daemon-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-shared.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-status-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-doctor-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-complete-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-complete-validation.ts`, `apps/harness-mcp/src/tools/workflow-plan.tools.ts`, `apps/harness-cli/src/commands/workflow.command.ts`, `apps/harness-cli/src/commands/workflow-command-helpers.ts`, `apps/harness-cli/src/commands/declarative-cli-workflow.ts`                                                                                                                                                                                                                                                   | Epoch-fenced `WfRun`/`WfUnit`/`WfAttempt` projections (`wf_probe_runs`, `WorkflowRebuiltRunCount`; non-authoritative for workflow replay while read by daemon control-plane RPCs), Unix-socket `workflow.*` RPCs (`DurableDeferred.tokenFromExecutionId`), read-only `harness_workflow_plan` (`18` canonical MCP tools), `harness workflow` CLI                                                                                                                                                                                            | `@harness/service/WorkflowProjectionWriter`, `@harness/service/WorkflowReadModelQuery`, `Harness.rebuildWorkflowReadModelViews`, `HarnessCli.workflow`, `HarnessMcp.workflowPlan`, `HarnessDaemonClient.startWorkflow`, `HarnessDaemonClient.getWorkflowStatus`, `HarnessDaemonClient.completeWorkflow`, `HarnessDaemonClient.resumeWorkflow`, `HarnessDaemonClient.abortWorkflow`, `HarnessDaemonClient.doctorWorkflow`, `WorkflowRpcDaemon.handleStartRequest`, `WorkflowRpcDaemon.handleCompleteRequest`, `WorkflowRpcDaemon.handleResumeRequest`, `WorkflowRpcDaemon.handleAbortRequest`, `WorkflowRpcDaemon.handleDoctorRequest`, `WorkflowStoreUnavailableError` |
| Same-UID Worker Isolation Guards (`HARNESS_UNIT_WORKER=1`)   | `libs/harness/gates/src/policy-worker-isolation.ts`, `libs/harness/gates/src/policy-command-rules.ts`, `libs/harness/gates/src/policy.ts`, `libs/harness/gates/src/hook-fastpath.ts`, `libs/harness/gates/src/plugins/gc/gc-hook-fastpath.ts`, `libs/harness/infra/src/hook-io-realpath.ts`, `apps/harness-cli/src/commands/hook-fastpath-core.ts`, `apps/harness-cli/src/commands/hook-guard-payload.ts`, `libs/harness/decision/src/guard-decision.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | When `HARNESS_UNIT_WORKER=1` is set on unit worker invocations, blocks recursive `harness workflow` (`start`/`resume`/`ship`/`abort`/`doctor`/`complete --phase llm`), `harness done`, and `daemon.sock`/`auth-tokens.json` reads/writes while allowing source edits inside `<canonicalRepoRoot>/.harness/workflow-worktrees/**` and preserving `policy-zero-dep` & `hook-entry-lightweight`                                                                                                                                               | `Harness.decideGuardCommand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Durable `ShipWorkflow` Pipeline & Fenced `WfShipAttempt`     | `libs/harness/contract/src/workflow-ship.ts`, `libs/harness/contract/src/workflow-protocol.ts`, `libs/harness/contract/src/workflow-timeouts.ts`, `libs/harness/gates/src/ship-workflow.ts`, `libs/harness/gates/src/index.ts`, `libs/harness/graph/workflow-queries/workflows.gq`, `libs/harness/infra/src/workflow/ship-gate-runner-live.ts`, `libs/harness/infra/src/workflow/ship-format-files.ts`, `libs/harness/infra/src/workflow/ship-attempt-store-live.ts`, `libs/harness/infra/src/workflow/ship-daemon-client.ts`, `apps/harness-mcp/src/daemon/workflow-ports-daemon-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-ship-helper.ts`, `apps/harness-cli/src/commands/done-cli-helper.ts`, `apps/harness-cli/src/commands/verify-and-done.command.ts`, `apps/harness-cli/src/commands/declarative-cli.ts`, `apps/harness-cli/src/commands/declarative-cli-flags.ts`                                                                                                                                                                                                                                                                                                                            | `Workflow.make("ShipWorkflow", ...)` keyed by `${runId}:${treeHash}:${attempt}`, `RunGate/<stage>` canonical activity codecs, strict pre/post tree-hash checks, `recoverStartupBackup` before `mutate-strict`, monotonic OCC `WfShipAttempt` allocator (`ifGraphCommit` + writer lease fencing), streaming `workflow.ship` RPC, explicit `harness done --cli` exit codes, `LoopCircuitBreaker.decide` failure accounting, and `WORKFLOW_TIMEOUT_BUDGETS` ship bounds (`shipWorkflowSettleMs > SHIP_STAGES.length * shipGateCommandMs`)     | `ShipWorkflow.execute`, `ShipWorkflow.runGate`, `ShipWorkflow.executionIdOf`, `ShipGateRunner.computeTreeHash`, `ShipGateRunner.recoverMutationBackup`, `ShipGateRunner.executeStageCommand`, `ShipGateRunner.reportStageProgress`, `ShipAttemptStore.allocateAttempt`, `ShipAttemptStore.updateStatus`, `ShipAttemptStore.listAttemptsForRun`, `DaemonClient.shipWorkflow`, `WorkflowRpcDaemon.handleShipRequest`, `WorkflowRpcDaemon.resolveShipRunTarget`, `@harness/service/ShipGateRunner`, `@harness/service/ShipAttemptStore`, `ShipGateFailedError`, `ShipTreeMismatchError`, `MutationRestoreError`, `ShipTreeDriftError`                                     |
| Hardened Workflow Agent Runners & Live Automatic Dispatch    | `libs/harness/contract/src/workflow-runners.ts`, `libs/harness/contract/src/workflow-timeouts.ts`, `libs/harness/service/src/workflow-ports.ts`, `libs/harness/infra/src/workflow/runner-profiles.ts`, `libs/harness/infra/src/workflow/agent-runner-outcome.ts`, `libs/harness/infra/src/workflow/unit-brief-builder.ts`, `libs/harness/infra/src/workflow/verify-child-process.ts`, `libs/harness/infra/src/workflow/runner-process-supervision.ts`, `libs/harness/infra/src/workflow/agent-runners-live.ts`, `libs/harness/infra/src/workflow/agent-dispatcher-live.ts`, `libs/harness/infra/src/workflow/runner-doctor.ts`, `apps/harness-mcp/src/daemon/workflow-ports-daemon-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-doctor-helper.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Human-reviewed `runner-profiles.ts` total argv/env allow-listing (forbidding `--dangerously-skip-permissions`, `CLOUDFLARE_*`, Omnigraph tokens, and `ANTIGRAVITY_*`/`AGY_*` while setting `HARNESS_UNIT_WORKER=1`), `claude --strict-mcp-config --setting-sources "" --settings` (`PreToolUse` only), `agy` hard-MCP rejection/fallback and `exit 3` retry, POSIX process-group `SIGTERM`/`SIGKILL` supervision & orphan reaping, `buildUnitBrief` & `toOutcome`, `"live"` `UnitAgentDispatcherLive`, and `workflow doctor` runner checks | `AgentRunner.run`, `ClaudeCodeRunner.run`, `AntigravityRunner.run`, `UnitAgentDispatcher.dispatchUnit`, `@harness/service/AgentRunnerPort`, `@harness/service/UnitAgentDispatcher`, `AgentTimeoutError`, `AgentToolDeniedError`, `AgentAuthRequiredError`, `AgentExitError`, `AgentOutputParseError`, `AgentNoChangeError`                                                                                                                                                                                                                                                                                                                                             |
| Readable Analytical Projection & Pre-Merge Sync (`WF-6`)     | `libs/harness/contract/src/workflow-projection.ts`, `libs/harness/contract/src/workflow-protocol.ts`, `libs/harness/contract/src/workflow-timeouts.ts`, `libs/harness/service/src/workflow-ports.ts`, `libs/harness/graph/schema.pg`, `libs/harness/graph/queries/harness.gq`, `libs/harness/graph/graph.policy.yaml`, `libs/harness/graph/src/gq-query-descriptors.ts`, `libs/harness/graph/src/gq-static-assets.ts`, `libs/harness/graph/src/gq-queries.ts`, `libs/harness/gates/src/harness-task-workflow.ts`, `libs/harness/gates/src/harness-task-workflow-projections.ts`, `libs/harness/gates/src/omnigraph-branch-verify.ts`, `libs/harness/infra/src/workflow/workflow-projector-live.ts`, `libs/harness/infra/src/workflow/workflow-projector-planner.ts`, `libs/harness/infra/src/workflow/workflow-projector-query.ts`, `apps/harness-mcp/src/daemon/workflow-ports-daemon-helper.ts`, `apps/harness-mcp/src/daemon/workflow-rpc-status-helper.ts`, `apps/harness-cli/src/commands/omnigraph-auth-and-drift.ts`, `apps/harness-cli/src/commands/done-workflow-projector.ts`, `apps/harness-cli/src/commands/done-omnigraph-helpers.ts`, `apps/harness-cli/src/commands/omnigraph-workflow-backup.ts` | Additive `WorkflowRun`/`WorkUnit`/`UnitAttempt` + 6 `@key(@src, @dst, role)` edges, `workflow_pending_units` / `ears_without_completed_unit` (`22` GQ presets, `20` MCP tools), `ProjectWaveToHarness` codec, `WORKFLOW_TIMEOUT_BUDGETS` projector bounds, idempotent `ifGraphCommit` OCC `WorkflowProjectorLive` (`harness-cli` writer, non-fatal `"stale"` surfacing), wave/done-pre-merge/post-rebuild hooks                                                                                                                            | `WorkflowProjector.project`, `WorkflowProjector.projectAll`, `WorkflowProjector.getProjectionStatus`, `DoneWorkflowProjector.reprojectBeforeMerge`, `OmnigraphWorkflowBackup.afterRebuild`, `OmnigraphSchemaEvolution.decide`, `WorkflowRpcDaemon.buildStatusSummary`, `@harness/service/WorkflowProjector`                                                                                                                                                                                                                                                                                                                                                            |
