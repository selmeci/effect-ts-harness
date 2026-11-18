import { NodeServices } from "@effect/platform-node"
import { Layer } from "effect"
import { WorkspaceFilePath } from "@harness/contract"
import { ActiveMutantContextLive } from "./active-mutant-context-live.js"
import { makeAstGateCacheLayer } from "./ast-gate-cache-live.js"
import { resolveAstGateCachePath, resolveDecisionCachePath } from "./cache-helpers.js"
import { makeDecisionCacheLayer } from "./decision-cache-live.js"
import { LocalDecisionModel, makeLocalDecisionModelLayer } from "./local-decision-model-live.js"
import { nodeSyncHostIo } from "./node-host-io.js"
import { makeHarnessSubprocessRunnerLayer } from "./subprocess-runner-live.js"
import {
  makeUnixSocketDaemonLayer,
  queryUnixSocketLineDetailed,
  resolveHarnessDaemonSocketPath,
  UnixSocketDaemonLive,
} from "./unix-socket-daemon-live.js"
import { makeWorkspaceFsLayer } from "./workspace-fs-live.js"

export {
  LocalDecisionModel,
  makeLocalDecisionModelLayer,
  makeUnixSocketDaemonLayer,
  nodeSyncHostIo,
  queryUnixSocketLineDetailed,
  resolveHarnessDaemonSocketPath,
  UnixSocketDaemonLive,
}

const makeHookInfraLayer = (options?: { readonly repoRoot?: WorkspaceFilePath }) => {
  const repoRoot = options?.repoRoot ?? WorkspaceFilePath.make(process.cwd())
  return Layer.mergeAll(
    makeWorkspaceFsLayer(),
    makeHarnessSubprocessRunnerLayer(),
    makeAstGateCacheLayer({
      cacheFilePath: resolveAstGateCachePath(repoRoot),
    }),
    makeDecisionCacheLayer({
      cacheFilePath: resolveDecisionCachePath(repoRoot),
    }),
    UnixSocketDaemonLive,
    ActiveMutantContextLive,
  ).pipe(Layer.provide(NodeServices.layer))
}

export const HookInfraLive = makeHookInfraLayer()
