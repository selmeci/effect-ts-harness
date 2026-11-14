import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { makeOmnigraphSyncLayer, makeTsCompilerOverlayLayer } from "@harness/graph"
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

export const TsCompilerOverlayServiceLive = makeTsCompilerOverlayLayer(nodeSyncHostIo)
export const OmnigraphSyncLive = makeOmnigraphSyncLayer(nodeSyncHostIo)

export const HarnessInfraLive = Layer.mergeAll(
  makeWorkspaceFsLayer(),
  makeHarnessSubprocessRunnerLayer(),
  makeAstGateCacheLayer(),
  makeDecisionCacheLayer(),
  UnixSocketDaemonLive,
  ActiveMutantContextLive,
  TsCompilerOverlayServiceLive,
  OmnigraphSyncLive,
).pipe(Layer.provide(NodeServices.layer))
