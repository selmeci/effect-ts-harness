import { Layer } from "effect"
import { makeOmnigraphSyncLayer, makeTsCompilerOverlayLayer } from "@harness/graph"
import { AstGateCacheLive, makeAstGateCacheLayer } from "./ast-gate-cache-live.js"
import {
  DecisionCacheLive,
  type DecisionCacheStatsSnapshot,
  makeDecisionCacheLayer,
} from "./decision-cache-live.js"
import { nodeSyncHostIo } from "./node-host-io.js"
import { HarnessSubprocessRunnerLive } from "./subprocess-runner-live.js"
import {
  makeUnixSocketDaemonLayer,
  queryUnixSocketLine,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
  type UnixSocketDaemonLayerOptions,
} from "./unix-socket-daemon-live.js"
import { WorkspaceFsLive } from "./workspace-fs-live.js"

export { nodeSyncHostIo }
export { WorkspaceFsLive }
export { HarnessSubprocessRunnerLive }
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
  WorkspaceFsLive,
  HarnessSubprocessRunnerLive,
  AstGateCacheLive,
  DecisionCacheLive,
  UnixSocketDaemonLive,
  TsCompilerOverlayServiceLive,
  OmnigraphSyncLive,
)
