import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { WorkspaceFilePath } from "@harness/contract"
import {
  makeOmnigraphSyncLayer,
  makeTsCompilerOverlayLayer,
  type TsCompilerOverlayService,
} from "@harness/graph"
import { ActiveMutantContextLive } from "./active-mutant-context-live.js"
import {
  AstGateCacheLive,
  type AstGateCacheRuleSourceConfig,
  makeAstGateCacheLayer,
  type ResolvedGateRuleVersion,
  resolveDiskGateRuleVersion,
} from "./ast-gate-cache-live.js"
import {
  resolveAstGateCachePath,
  resolveDecisionCachePath,
  resolveHarnessStateDir,
} from "./cache-helpers.js"
import { DecisionCacheLive, makeDecisionCacheLayer } from "./decision-cache-live.js"
import { LocalDecisionModel, makeLocalDecisionModelLayer } from "./local-decision-model-live.js"
import { execFileAsyncEffect, nodeSyncHostIo } from "./node-host-io.js"
import {
  HarnessSubprocessRunnerLive,
  makeHarnessSubprocessRunnerHostIoLayer,
  makeHarnessSubprocessRunnerLayer,
} from "./subprocess-runner-live.js"
import {
  DAEMON_SOCKET_TIMEOUT_MS,
  DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
  makeUnixSocketDaemonLayer,
  queryUnixSocketLine,
  queryUnixSocketLineDetailed,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  type UnixSocketDaemonLayerOptions,
  type UnixSocketQueryOptions,
  type UnixSocketQueryReason,
  type UnixSocketQueryReply,
  type UnixSocketQueryResult,
  type UnixSocketQueryUnavailable,
} from "./unix-socket-daemon-live.js"
import {
  makeWorkspaceFsHostIoLayer,
  makeWorkspaceFsLayer,
  WorkspaceFsLive,
} from "./workspace-fs-live.js"

export { execFileAsyncEffect, nodeSyncHostIo }
export { ActiveMutantContextLive }
export { makeWorkspaceFsHostIoLayer, makeWorkspaceFsLayer, WorkspaceFsLive }
export {
  HarnessSubprocessRunnerLive,
  makeHarnessSubprocessRunnerHostIoLayer,
  makeHarnessSubprocessRunnerLayer,
}
export {
  AstGateCacheLive,
  makeAstGateCacheLayer,
  resolveDiskGateRuleVersion,
  type AstGateCacheRuleSourceConfig,
  type ResolvedGateRuleVersion,
}
export { resolveAstGateCachePath, resolveDecisionCachePath, resolveHarnessStateDir }
export { DecisionCacheLive, makeDecisionCacheLayer }
export { LocalDecisionModel, makeLocalDecisionModelLayer }
export {
  resolveOrCreateMutationCacheHmacSecret,
  type ResolveMutationHmacSecretOptions,
} from "./mutation-hmac-secret.js"
export {
  DAEMON_SOCKET_TIMEOUT_MS,
  DEFAULT_DAEMON_SERVER_SOCKET_TIMEOUT_MS,
  makeUnixSocketDaemonLayer,
  queryUnixSocketLine,
  queryUnixSocketLineDetailed,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  type UnixSocketDaemonLayerOptions,
  type UnixSocketQueryOptions,
  type UnixSocketQueryReason,
  type UnixSocketQueryReply,
  type UnixSocketQueryResult,
  type UnixSocketQueryUnavailable,
}
export {
  resolveWorkflowRuntimePaths,
  validateWorktreeRepoRoot,
  type ResolvedWorktreeKind,
  type WorkflowRuntimePaths,
} from "./worktree-repo-root.js"
export {
  invokeWorkflowStoreQuery,
  invokeWorkflowStoreQueryWithMeta,
  MAX_ORPHAN_QUARANTINE_BATCHES,
  quarantineOrphanEntityMessages,
  WORKFLOW_MAX_CONCURRENT_HTTP,
  WORKFLOW_MAX_OCC_RETRIES,
  type QuarantineOrphanEntityMessagesInput,
  type QuarantineOrphanEntityMessagesResult,
  type WorkflowStoreInvokeError,
  type WorkflowStoreQueryInput,
  type WorkflowStoreQueryWithMetaResult,
  type WorkflowStoreRetryPolicy,
} from "./omnigraph-workflow-store.js"
export {
  acquireWriterLease,
  evaluateWriterLeaseTakeover,
  refreshWriterLease,
  withAdvisoryFlock,
  WRITER_LEASE_HEARTBEAT_TTL_MS,
  type ActiveWriterLease,
  type LeaseTakeoverDecision,
  type LeaseTakeoverEvaluationInput,
  type WriterLeaseAcquireInput,
  type WriterLeaseHandle,
  type WriterLeaseRefreshInput,
} from "./writer-lease.js"
export {
  clearOmnigraphReplies,
  makeOmnigraphEncodedDriver,
  makeOmnigraphMessageStorageLayer,
  repairDanglingProcessedRequests,
  type OmnigraphClearRepliesInput,
  type OmnigraphMessageStorageOptions,
  type RepairDanglingRequestsInput,
} from "./omnigraph-message-storage.js"
export {
  makeHarnessShardingLayer,
  makeHarnessWorkflowEngineLayer,
  type HarnessWorkflowEngineLayerOptions,
  type HarnessWorkflowEngineOptions,
} from "./workflow-engine-live.js"
export {
  exportWorkflowGraphBackup,
  makeWorkflowGraphBackupLayer,
  restoreWorkflowGraphBackup,
  WorkflowBackupArtifactMetadata,
  WorkflowGraphBackupLive,
  type WorkflowGraphBackupOptions,
} from "./workflow-graph-backup.js"
export {
  DEFAULT_WORKFLOW_CLEANUP_KEEP_VERSIONS,
  runOfflineWorkflowMaintenance,
  type WorkflowMaintenanceInput,
  type WorkflowMaintenanceSummary,
} from "./workflow-maintenance.js"
export {
  acquireOmnigraphClusterLockEffect,
  releaseOmnigraphClusterLock,
  tryAcquireOmnigraphClusterLock,
  withOmnigraphClusterStartupLock,
  type OmnigraphClusterLockAttemptResult,
  type OmnigraphClusterLockHandle,
  type OmnigraphClusterStartupLockOptions,
} from "./workflow/cluster-startup-lock.js"
export {
  abortWorkflowViaDaemon,
  completeWorkflowViaDaemon,
  doctorWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  handshakeWorkflowDaemon,
  queryWorkflowDaemonCommand,
  resumeWorkflowViaDaemon,
  startWorkflowViaDaemon,
  WORKFLOW_DAEMON_IPC_TIMEOUT_MS,
  type WorkflowDaemonCommandInput,
  type WorkflowDaemonExpectedProtocol,
  type WorkflowDaemonHandshakeInput,
  type WorkflowDaemonRpcOptions,
} from "./workflow/daemon-client.js"
export { UnitAgentDispatcherLive } from "./workflow/agent-dispatcher-live.js"
export {
  compileWorkflowPlanFromRepo,
  type CompileWorkflowPlanError,
  type CompileWorkflowPlanRequest,
} from "./workflow/plan-compiler-extractor.js"
export {
  makeWorkflowProjectionWriterLayer,
  makeWorkflowReadModelQueryLayer,
  rebuildWorkflowReadModelViews,
  type WorkflowReadModelOptions,
  WorkflowProjectionWriterLive,
  WorkflowReadModelQueryLive,
} from "./workflow/read-model-live.js"
export {
  makeWorkflowReviewRouterLayer,
  routeWorkflowReviewImpl,
  type WorkflowReviewRouterOptions,
  WorkflowReviewRouterLive,
} from "./workflow/review-router-live.js"
export {
  completeSharedStepImpl,
  completeUnitImpl,
  makeUnitVerifierLayer,
  type UnitVerifierOptions,
  UnitVerifierLive,
} from "./workflow/unit-verifier-live.js"
export {
  makeWorkflowWorktreePortLayer,
  mergeSliceWaveImpl,
  provisionWorkflowWorktreesImpl,
  removeWorktreeCheckoutsImpl,
  type WorkflowWorktreePortOptions,
  WorkflowWorktreePortLive,
} from "./workflow/worktree-port-live.js"

export const TsCompilerOverlayServiceLive: Layer.Layer<TsCompilerOverlayService> =
  makeTsCompilerOverlayLayer(nodeSyncHostIo)
export const OmnigraphSyncLive = makeOmnigraphSyncLayer(nodeSyncHostIo)

const makeHarnessInfraLayer = (options?: {
  readonly repoRoot?: WorkspaceFilePath
  readonly astGateCacheRuleSource?: AstGateCacheRuleSourceConfig
}) => {
  const repoRoot = options?.repoRoot ?? WorkspaceFilePath.make(process.cwd())
  return Layer.mergeAll(
    makeWorkspaceFsLayer(),
    makeHarnessSubprocessRunnerLayer(),
    makeAstGateCacheLayer({
      cacheFilePath: resolveAstGateCachePath(repoRoot),
      ...(options?.astGateCacheRuleSource !== undefined
        ? { ruleSource: options.astGateCacheRuleSource }
        : {}),
    }),
    makeDecisionCacheLayer({
      cacheFilePath: resolveDecisionCachePath(repoRoot),
    }),
    UnixSocketDaemonLive,
    ActiveMutantContextLive,
    TsCompilerOverlayServiceLive,
    OmnigraphSyncLive,
  ).pipe(Layer.provide(NodeServices.layer))
}

export { makeHarnessInfraLayer }

export const HarnessInfraLive = makeHarnessInfraLayer()
