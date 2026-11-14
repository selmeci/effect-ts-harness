import { Context, type Effect, type Option, type Scope } from "effect"
import type {
  AstGateEvaluationReport,
  AstGateFileBatchInput,
  DaemonServerError,
  DaemonServerInfo,
  DaemonSocketPath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheStatsSnapshot,
  DecisionCacheTtlMillis,
  NonNegativeCount,
  WorkspaceFilePath,
  WorkspaceFsError,
} from "@harness/contract"

export interface AstGateCachePortShape {
  readonly evaluateBatch: (
    files: ReadonlyArray<AstGateFileBatchInput>,
  ) => Effect.Effect<AstGateEvaluationReport, WorkspaceFsError>
  readonly clearCache: Effect.Effect<void>
  readonly cacheSize: Effect.Effect<NonNegativeCount>
}

export class AstGateCachePort extends Context.Service<
  AstGateCachePort,
  AstGateCachePortShape
>()("@harness/service/AstGateCachePort") {}

export interface DecisionCachePortShape {
  readonly lookup: (
    key: DecisionCacheKey,
  ) => Effect.Effect<Option.Option<DecisionCachePayloadJson>>
  readonly store: (
    key: DecisionCacheKey,
    payload: DecisionCachePayloadJson,
    ttlMillis: DecisionCacheTtlMillis,
  ) => Effect.Effect<void, WorkspaceFsError>
  readonly clear: Effect.Effect<void>
  readonly stats: Effect.Effect<DecisionCacheStatsSnapshot>
}

export class DecisionCachePort extends Context.Service<
  DecisionCachePort,
  DecisionCachePortShape
>()("@harness/service/DecisionCachePort") {}

export interface UnixSocketDaemonPortShape {
  readonly startServer: (
    repoRoot: WorkspaceFilePath,
  ) => Effect.Effect<DaemonServerInfo, DaemonServerError, Scope.Scope>
  readonly isSocketAlive: (socketPath: DaemonSocketPath) => Effect.Effect<boolean>
}

export class UnixSocketDaemonPort extends Context.Service<
  UnixSocketDaemonPort,
  UnixSocketDaemonPortShape
>()("@harness/service/UnixSocketDaemonPort") {}
