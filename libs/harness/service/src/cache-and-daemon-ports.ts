import { Context, type Effect, type Option, type Scope } from "effect"
import type {
  AstGateEvaluationError,
  AstGateEvaluationReport,
  AstGateFileBatchInput,
  AstGateFileEvaluator,
  DaemonServerError,
  DaemonServerInfo,
  DaemonSocketPath,
  DecisionCacheKey,
  DecisionCachePayloadJson,
  DecisionCacheStatsSnapshot,
  DecisionCacheTtlMillis,
  EvaluatorId,
  NonNegativeCount,
  WorkspaceFilePath,
  WorkspaceFsError,
} from "@harness/contract"

export interface AstGateCachePortShape {
  readonly evaluateBatch: (
    files: ReadonlyArray<AstGateFileBatchInput>,
    evaluateFile: AstGateFileEvaluator,
    evaluatorId?: EvaluatorId,
  ) => Effect.Effect<AstGateEvaluationReport, WorkspaceFsError | AstGateEvaluationError>
  readonly clearCache: Effect.Effect<void, WorkspaceFsError>
  readonly cacheSize: Effect.Effect<NonNegativeCount, WorkspaceFsError>
}

export class AstGateCachePort extends Context.Service<
  AstGateCachePort,
  AstGateCachePortShape
>()("@harness/service/AstGateCachePort") {}

export interface DecisionCachePortShape {
  readonly lookup: (
    key: DecisionCacheKey,
  ) => Effect.Effect<Option.Option<DecisionCachePayloadJson>, WorkspaceFsError>
  readonly store: (
    key: DecisionCacheKey,
    payload: DecisionCachePayloadJson,
    ttlMillis: DecisionCacheTtlMillis,
  ) => Effect.Effect<void, WorkspaceFsError>
  readonly lookupOrCompute: <E, R>(input: {
    readonly key: DecisionCacheKey
    readonly ttlMillis: DecisionCacheTtlMillis
    readonly compute: Effect.Effect<DecisionCachePayloadJson, E, R>
  }) => Effect.Effect<DecisionCachePayloadJson, E | WorkspaceFsError, R>
  readonly clear: Effect.Effect<void, WorkspaceFsError>
  readonly stats: Effect.Effect<DecisionCacheStatsSnapshot, WorkspaceFsError>
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
