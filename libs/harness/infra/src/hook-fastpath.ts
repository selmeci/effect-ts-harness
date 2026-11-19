import { resolve } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Result } from "effect"
import { match } from "ts-pattern"
import {
  normalizeNonRootWorkspacePath,
  resolveDefaultDecisionCachePath,
  WorkspaceFilePath,
} from "@harness/contract"
import { ActiveMutantContextLive } from "./active-mutant-context-live.js"
import { resolveDecisionCachePath } from "./cache-helpers.js"
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

const resolveCachePathSafe = (
  fn: () => WorkspaceFilePath,
  fallback: () => WorkspaceFilePath,
): WorkspaceFilePath =>
  match(Result.try(fn))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness/infra] Warning: invalid HARNESS_STATE_DIR (${failure instanceof Error ? failure.message : String(failure)}); using default cache path.\n`,
      )
      return fallback()
    })
    .exhaustive()

const makeHookInfraLayer = (options?: { readonly repoRoot?: WorkspaceFilePath }) => {
  const repoRoot = options?.repoRoot ?? WorkspaceFilePath.make(process.cwd())
  const defaultRoot = resolve(normalizeNonRootWorkspacePath(repoRoot))
  return Layer.mergeAll(
    makeWorkspaceFsLayer(),
    makeHarnessSubprocessRunnerLayer(),
    makeDecisionCacheLayer({
      cacheFilePath: resolveCachePathSafe(
        () => resolveDecisionCachePath(repoRoot),
        () => resolveDefaultDecisionCachePath(defaultRoot),
      ),
    }),
    UnixSocketDaemonLive,
    ActiveMutantContextLive,
  ).pipe(Layer.provide(NodeServices.layer))
}

export const HookInfraLive = Layer.unwrap(Effect.sync(() => makeHookInfraLayer()))
