---
id: harness:SPEC-0021
title: Omnigraph Workflow Storage Driver, Writer Lease, Daemon IPC, Backup/Maintenance, and Runtime State Protection
status: accepted
archetype: framework
date: 2026-11-19
owners:
  - "@harness/architecture"
scope: harness
enforced_by:
  - libs/harness/contract/src/workflow.ts
  - libs/harness/contract/src/workflow-storage.ts
  - libs/harness/contract/src/index.ts
  - libs/harness/service/src/workflow-ports.ts
  - libs/harness/service/src/index.ts
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
spans:
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
services:
  - "@harness/service/WorkflowGraphBackup"
errors:
  - WriterLeaseHeldError
  - DaemonProtocolMismatchError
  - WorkflowStoreUnavailableError
---

## Context

Durable Effect v4 workflows require a persistent, single-writer `MessageStorage.Encoded` driver backed by `@modernrelay/omnigraph` (`harness-workflows` graph), isolated from `harness` branch overwrites executed during `done`. Operating safely across linked git worktrees on Linux also requires resolving the canonical daemon socket under `<git-common-dir>/harness/daemon.sock`, fencing concurrent daemon processes with an OS advisory lock and monotonic `leaseEpoch`, enforcing versioned `workflow.handshake` verification before IPC calls, backing up and restoring `harness-workflows` via a crash-safe `pending-workflow-restore.json` journal across clean cluster rebuilds, bounding Lance MVCC growth via offline maintenance, and denying agent shell/file access to protected harness runtime state (`<git-common-dir>/harness/**`, `auth-tokens.json`, `daemon.sock`, `daemon.lock`, `workflow-backups/`).

- **Reused Contracts / Errors:** `AbsoluteRepoRoot`, `DaemonSocketPath`, `ErrorReasonMessage`, `WorkspaceFilePath`, `WorkspaceFsError`, `WorkspaceFsOperation`, `toErrorReasonMessage` from `@harness/contract`
- **Reused Services:** `OmnigraphClient`, `makeWorkflowOmnigraphClient`, `resolveWorkflowOmnigraphConfig`, `WORKFLOW_OMNIGRAPH_GRAPH_ID`, `resolveGitCommonDir` from `@harness/graph`; `UnixSocketDaemonPort`, `ExtendedHostIo`, `SyncHostIo` from `@harness/service`
- **New Capabilities Needed:** `SeqKey`, `encodeSeqKey`, `decodeSeqKey`, `MessageKey`, `ReplyKey`, `PrimaryKeyHash`, `LeaseEpoch`, `LeaseHolderId`, `LeaseFilePath`, `LeaseHolderPid`, `WorkflowProtocolVersion`, `WORKFLOW_DAEMON_PROTOCOL_VERSION`, `WorkflowDaemonCapability`, `DaemonProtocolMismatchDetail`, `GitCommonDirPath`, `WorktreePathKind`, `ValidatedWorktreeRoot`, `DaemonHandshakeRequest`, `DaemonHandshakeResponse`, `BackupDirPath`, `WorkflowBackupFilePath`, `WorkflowBackupCount`, `WorkflowBackupTimestampMs`, `BackupFileHash`, `WorkflowBackupMode`, `WorkflowBackupReceiptFields`, `WorkflowBackupSummary`, `MergeWorkflowRestoreRequest`, `ReplaceWorkflowRestoreRequest`, `WorkflowRestoreRequest`, `WorkflowRestoreSummary`, `WorkflowStoreOperation`, `WorkflowStoreFailureReason`, `toBoundedReason`, `WORKFLOW_GQ_QUERY_NAMES`, `WorkflowGqQueryName`, `WorkflowGqParamsMap`, `WriterLeaseHeldError`, `DaemonProtocolMismatchError`, `WorkflowStoreUnavailableError`, `WorkflowGraphBackup` (`@harness/service`), `makeOmnigraphMessageStorageLayer`, `makeHarnessWorkflowEngineLayer`, `acquireWriterLease`, `validateWorktreeRepoRoot`, `handshakeWorkflowDaemon`, `handleWorkflowDaemonHandshake`, `WorkflowGraphBackupLive`, `runOfflineWorkflowMaintenance`, `beforeRebuildWorkflowBackup`, and `afterRebuildWorkflowBackup`.

## Goal

Every workflow engine mailbox operation persists atomically to the isolated `harness-workflows` graph inside a single-writer fenced daemon anchored at `<git-common-dir>/harness/daemon.sock`, with fail-closed cluster rebuild backups (`pending-workflow-restore.json` + `expectedSha256`), offline Lance compaction/cleanup (`--keep 1 --confirm`), versioned daemon handshakes, and deterministic guard denials over protected harness runtime state.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (`When`, `If ... then`) and the modal `shall` or `shall not`.

## Requirements

### 1 · Omnigraph Workflow Storage Driver, Concurrency & Writer Lease (RFC-0013 `REQ-2.1..REQ-2.6`)

**Source (RFC-0013 §5.3, §10.2 `REQ-2.1..REQ-2.6`, §10.3 item 2):** Persistence in `harness-workflows` must preserve `MessageStorage.Encoded` semantics, serialize concurrent mutations, bound actor HTTP concurrency, fence stale writers, and surface outage errors cleanly.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Effect Symbol                        | Verification |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------ |
| REQ-1.1 | Event-driven       | **When** `OmnigraphMessageStorage` executes `saveEnvelope` with a non-null primary key matching an existing `WfMessage` row, `OmnigraphMessageStorage` **shall** return `Duplicate` carrying the stored `lastReceivedReply` under continuous `writeMutex` serialization.                                                                                                                                                                                                                       | WorkflowStore.invoke                 | UnitTest     |
| REQ-1.2 | Event-driven       | **When** `OmnigraphMessageStorage` queries `unprocessedMessages` for due shard envelopes, `OmnigraphMessageStorage` **shall** group `opts.addresses` by `entityType` inside GQ 2.1 (`wf_unprocessed_candidate_messages_for_addresses`) before `limit` and order due, unclaimed rows by 20-character zero-padded `SeqKey` ascending.                                                                                                                                                            | WorkflowStore.invoke                 | UnitTest     |
| REQ-1.3 | Event-driven       | **When** `OmnigraphMessageStorage.clearReplies` removes replies for a request, `OmnigraphMessageStorage.clearReplies` **shall** hold `writeMutex` continuously across the `D2` two-commit `$expectedReplyId` CAS sequence (`withTransaction` executing pass-through over single-request atomic GQ mutations), preserve `Interrupt` envelopes (`where requestId = $requestId`), and execute single-shot Commit-2 compensation via `wf_repair_dangling_requests`.                                | OmnigraphMessageStorage.clearReplies | UnitTest     |
| REQ-1.4 | Ubiquitous         | `WorkflowStore.invoke` **shall** bound process-wide Omnigraph HTTP requests through one shared `WORKFLOW_MAX_CONCURRENT_HTTP = 12` semaphore with `AbortSignal.timeout`, enforce the default 6-hour `claimTimeoutMs` claim expiry window (`DEFAULT_WORKFLOW_CLAIM_TIMEOUT_MS`), retry bounded `429` and `412` conflicts outside `writeMutex` sleeps, isolate corrupt reply/message rows via terminal `WithExit(Die)` exits, and delete `clearAddress` state atomically via `wf_clear_address`. | WorkflowStore.invoke                 | UnitTest     |
| REQ-1.5 | Unwanted behaviour | **If** `omnigraph-server` is unreachable, an HTTP envelope fails decoding, a mutation reports unexpected zero affected nodes, or retries exhaust during a `harness-workflows` storage operation, **then** `WorkflowStore.invoke` **shall** fail closed with `WorkflowStoreUnavailableError` without corrupting mailbox state or marking workflow units rejected.                                                                                                                               | WorkflowStoreUnavailableError        | UnitTest     |
| REQ-1.6 | Unwanted behaviour | **If** another live daemon holds OS `flock` on `<git-common-dir>/harness/daemon.lock` or an active `WfWriterLease` verified by PID liveness (with process start-time reuse protection) or `45000`ms heartbeat TTL, or if a stale writer attempts a write whose `expectedLeaseEpoch` (`>= 1`) has been superseded, **then** `WfWriterLease.acquire` or `WorkflowStore.invoke` **shall** fail closed with `WriterLeaseHeldError` without overwriting active lease or mailbox state.              | WriterLeaseHeldError                 | UnitTest     |

### 2 · Daemon IPC Handshake, Linked Worktrees, Cedar Isolation & Backup/Maintenance (RFC-0013 `REQ-2.7..REQ-2.9`)

**Source (RFC-0013 §5.3.2, §5.3.5, §5.7.1, §10.2 `REQ-2.7..REQ-2.9`, §10.3 item 2):** Workflow clients must communicate exclusively with a protocol-verified daemon at `<git-common-dir>/harness/daemon.sock`, Cedar policies must isolate `harness-workflows`, and cluster rebuilds/maintenance must preserve durable workflow state fail-closed.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Effect Symbol                     | Verification |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------ |
| REQ-2.1 | Event-driven       | **When** `WorktreeRepoRoot.validate` resolves an explicit `repoRoot` against `git worktree list`, `WorktreeRepoRoot.validate` **shall** emit a `ValidatedWorktreeRoot` binding `commonGitDir`, `worktreeRoot`, and consistent `WorktreePathKind` (`canonical` or `linked`) to `<git-common-dir>/harness/` runtime paths (targeting a `<= 70 B` relative socket path budget below OS `sun_path` limits).                                                                                                                    | WorktreeRepoRoot.validate         | UnitTest     |
| REQ-2.2 | Unwanted behaviour | **If** `HarnessDaemonClient.handshake` connects to a daemon whose `WorkflowDaemonHelper.handshake` response has a mismatched `WorkflowProtocolVersion` or `commonGitDir`, omits required `WorkflowDaemonCapability` handlers, or advertises an inactive `writerLeaseEpoch < 1` when an active lease is required, **then** `HarnessDaemonClient.handshake` **shall** fail with `DaemonProtocolMismatchError` without direct fallback writes.                                                                                | DaemonProtocolMismatchError       | UnitTest     |
| REQ-2.3 | Ubiquitous         | `workflows.policy.yaml` **shall** permit `harness-cli` workflow administration while rejecting `agent-mcp` stored-query invocations with HTTP `404` and direct `snapshot`/`list`/`query`/`mutate` access on `harness-workflows` with HTTP `403` without disrupting `agent-mcp` reads on `harness`.                                                                                                                                                                                                                         | —                                 | Inspection   |
| REQ-2.4 | Unwanted behaviour | **If** `WorkflowGraphBackup.exportBackup` (`OmnigraphWorkflowBackup.beforeRebuild`) or atomic journal persistence fails on `RequiresCleanRebuild` before `killOmnigraphServerPidIfAlive`, **then** `OmnigraphWorkflowBackup.beforeRebuild` **shall** abort fail closed before stopping `omnigraph-server` or removing cluster state.                                                                                                                                                                                       | WorkflowGraphBackup.exportBackup  | UnitTest     |
| REQ-2.5 | Event-driven       | **When** `omnigraph cluster apply` finishes rebuilding a cluster with a valid `clusterRootDir`- and `preRebuildConfigStamp`-bound `pending-workflow-restore.json` journal, `WorkflowGraphBackup.restoreBackup` (`OmnigraphWorkflowBackup.afterRebuild`) **shall** reject empty `replace` backups, confirm `expectedSha256`, load onto protected branch `main`, and verify BOTH `WfMessage` (`wf_count_all`) and `WfReply` (`wf_count_replies`) counts (`>=` in `merge`, `===` in `replace`) before exposing `server.json`. | WorkflowGraphBackup.restoreBackup | UnitTest     |
| REQ-2.6 | Event-driven       | **When** `WorkflowMaintenance.runOffline` executes against a verified stopped cluster after validating non-foreign cluster locks and writing a SHA-256-verified safety export, `WorkflowMaintenance.runOffline` **shall** run `omnigraph optimize`, `omnigraph cleanup --keep 1 --confirm` (with configurable `keepVersions`), and post-quiescence `omnigraph cluster force-unlock`.                                                                                                                                       | WorkflowMaintenance.runOffline    | UnitTest     |

### 3 · Protected Harness Runtime State Guards (RFC-0013 `REQ-4.6`)

**Source (RFC-0013 §5.7, §10.2 `REQ-4.6`):** Same-UID agent executions must be deterministically prevented from tampering with or inspecting `<git-common-dir>/harness/**`, `auth-tokens.json`, `daemon.sock`, `daemon.lock`, `workflow-backups/`, or `pending-workflow-restore.json`.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Effect Symbol              | Verification |
| ------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ |
| REQ-3.1 | Event-driven | **When** `explainCommandDenyRule` or `classifyFileWrite` inspects a shell command (unwrapping `timeout`/`nice`/`nohup`/`stdbuf`/`time` and `bun` package-runner invocations and inspecting every non-exempt argument of any command, including command substitutions referencing git common-dir harness state and custom common dirs, exempting only `ls`, read-only `find`, `dropDataArguments`-stripped messages, and `pnpm harness`) or file write targeting `<git-common-dir>/harness/**`, `workflow-backups/`, `auth-tokens.json`, `daemon.sock`, `daemon.lock`, or `pending-workflow-restore.json`, `Harness.decideGuardCommand` **shall** enforce deterministic `deny` verdicts. | Harness.decideGuardCommand | UnitTest     |

## Assumptions

- **REQ-1.6:** Local daemon crash takeover checks OS advisory `flock` and local process PID liveness (`LeaseHolderPid` + `/proc/<pid>/stat` start-time identity) first, taking over in `< 1s` after `SIGKILL` (even on same-PID reuse) and falling back to `WRITER_LEASE_HEARTBEAT_TTL_MS` (`45000`ms) only when live external identity holds the lease.
- **REQ-2.3:** `done` and existing `OmnigraphSync` sync helpers address graph `harness` only and never issue loads against `harness-workflows`.

## Out of scope

- **WF-3 `HarnessTaskWorkflow`, unexported active-run tracking, manual `DurableDeferred` completion, and `harness_workflow_plan` MCP tool.** Deferred to a subsequent WF-3 EARS specification.
- **WF-4 `ShipWorkflow` gates (`format-check -> gc-strict -> ontology-check-strict -> mutate-strict -> verify -> done`), WF-5 `AgentRunnerPort` (`claude-code` / `antigravity`), and WF-6 `WorkflowProjector`.** Deferred to subsequent WF-4..WF-6 EARS specifications.

## Known residual risks

- `MessageStorage.Encoded` in `effect/cluster` is marked `@stability unstable` in `effect@4.0.0`, requiring conformance verification against `SqlMessageStorage` semantics in WF-2 tests.
- Same-UID tool isolation for spawned unit workers (`HARNESS_UNIT_WORKER=1`) is scoped to WF-3/WF-5 policy extensions beyond the runtime-state path protections in `REQ-3.1`.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`UnitTest` and `Inspection`).
- `libs/harness/contract`, `libs/harness/service`, `libs/harness/gates`, `libs/harness/graph`, `libs/harness/infra`, `apps/harness-mcp`, and `apps/harness-cli` pass `typecheck`, `lint`, `gc --strict`, `ontology check --strict`, `mutate --strict`, `CI=true verify`, and `CI=true done`.
- Frontmatter updated to `status: accepted` upon WF-2 implementation completion before final gates.
