import { Layer } from "effect"
import { makeOmnigraphSyncLayer, makeTsCompilerOverlayLayer } from "@harness/graph"
import { AstGateCacheLive, makeAstGateCacheLayer } from "./ast-gate-cache-live.js"
import {
  DecisionCacheLive,
  type DecisionCacheStatsSnapshot,
  makeDecisionCacheLayer,
} from "./decision-cache-live.js"
import { nodeSyncHostIo } from "./node-host-io.js"
import {
  HarnessSubprocessRunnerLive,
  HarnessSubprocessRunnerNodeLive,
} from "./subprocess-runner-live.js"
import {
  makeUnixSocketDaemonLayer,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
} from "./unix-socket-daemon-live.js"
import { WorkspaceFsLive, WorkspaceFsNodeLive } from "./workspace-fs-live.js"

export { nodeSyncHostIo }
export { WorkspaceFsLive, WorkspaceFsNodeLive }
export { HarnessSubprocessRunnerLive, HarnessSubprocessRunnerNodeLive }
export { AstGateCacheLive, makeAstGateCacheLayer }
export { DecisionCacheLive, makeDecisionCacheLayer, type DecisionCacheStatsSnapshot }
export {
  makeUnixSocketDaemonLayer,
  resolveHarnessDaemonSocketPath,
  startScopedUnixSocketDaemon,
  UnixSocketDaemonLive,
}

export const TsCompilerOverlayServiceLive = makeTsCompilerOverlayLayer(nodeSyncHostIo)
export const OmnigraphSyncLive = makeOmnigraphSyncLayer(nodeSyncHostIo)

export const HarnessInfraLive = Layer.mergeAll(
  WorkspaceFsNodeLive,
  HarnessSubprocessRunnerNodeLive,
  AstGateCacheLive,
  DecisionCacheLive,
  UnixSocketDaemonLive,
  TsCompilerOverlayServiceLive,
  OmnigraphSyncLive,
)
