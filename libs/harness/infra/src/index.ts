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
import { nodeSyncHostIo } from "./node-host-io.js"
import {
  HarnessSubprocessRunnerLive,
  makeHarnessSubprocessRunnerHostIoLayer,
  makeHarnessSubprocessRunnerLayer,
} from "./subprocess-runner-live.js"
import {
  makeUnixSocketDaemonLayer,
  queryUnixSocketLine,
  queryUnixSocketLineDetailed,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  type UnixSocketDaemonLayerOptions,
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

export { nodeSyncHostIo }
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
  makeUnixSocketDaemonLayer,
  queryUnixSocketLine,
  queryUnixSocketLineDetailed,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  type UnixSocketDaemonLayerOptions,
  type UnixSocketQueryReason,
  type UnixSocketQueryReply,
  type UnixSocketQueryResult,
  type UnixSocketQueryUnavailable,
}

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
