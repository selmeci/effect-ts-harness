import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { WorkspaceFilePath } from "@harness/contract"
import { makeOmnigraphSyncLayer, makeTsCompilerOverlayLayer, type TsCompilerOverlayService } from "@harness/graph"
import { ActiveMutantContextLive } from "./active-mutant-context-live.js"
import { AstGateCacheLive, makeAstGateCacheLayer } from "./ast-gate-cache-live.js"
import {
  DecisionCacheLive,
  type DecisionCacheStatsSnapshot,
  makeDecisionCacheLayer,
} from "./decision-cache-live.js"
import { nodeSyncHostIo } from "./node-host-io.js"
import {
  HarnessSubprocessRunnerLive,
  makeHarnessSubprocessRunnerHostIoLayer,
  makeHarnessSubprocessRunnerLayer,
} from "./subprocess-runner-live.js"
import {
  makeUnixSocketDaemonLayer,
  queryUnixSocketLine,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  type UnixSocketDaemonLayerOptions,
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
export { AstGateCacheLive, makeAstGateCacheLayer }
export { DecisionCacheLive, makeDecisionCacheLayer, type DecisionCacheStatsSnapshot }
export {
  makeUnixSocketDaemonLayer,
  queryUnixSocketLine,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  type UnixSocketDaemonLayerOptions,
}

export const TsCompilerOverlayServiceLive: Layer.Layer<TsCompilerOverlayService> =
  makeTsCompilerOverlayLayer(nodeSyncHostIo)
export const OmnigraphSyncLive = makeOmnigraphSyncLayer(nodeSyncHostIo)

const cacheFileUnderRoot = (repoRoot: WorkspaceFilePath, fileName: string): WorkspaceFilePath =>
  WorkspaceFilePath.make(`${repoRoot.replace(/\/+$/, "")}/.harness/cache/${fileName}`)

const makeHarnessInfraLayer = (options?: {
  readonly repoRoot?: WorkspaceFilePath
}) => {
  const repoRoot = options?.repoRoot ?? WorkspaceFilePath.make(process.cwd())
  return Layer.mergeAll(
    makeWorkspaceFsLayer(),
    makeHarnessSubprocessRunnerLayer(),
    makeAstGateCacheLayer({
      cacheFilePath: cacheFileUnderRoot(repoRoot, "ast-gates-v1.json"),
    }),
    makeDecisionCacheLayer({
      cacheFilePath: cacheFileUnderRoot(repoRoot, "decision-cache-v1.json"),
    }),
    UnixSocketDaemonLive,
    ActiveMutantContextLive,
    TsCompilerOverlayServiceLive,
    OmnigraphSyncLive,
  ).pipe(Layer.provide(NodeServices.layer))
}

export { makeHarnessInfraLayer }

export const HarnessInfraLive = makeHarnessInfraLayer()
