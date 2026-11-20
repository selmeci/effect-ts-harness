import { Duration, Effect, Layer } from "effect"
import {
  ClusterWorkflowEngine,
  type MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
} from "effect/cluster"
import type { WorkflowEngine } from "effect/workflow"
import type {
  AbsoluteRepoRoot,
  WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
} from "@harness/contract"
import {
  makeOmnigraphMessageStorageLayer,
  type OmnigraphMessageStorageOptions,
  repairDanglingProcessedRequests,
} from "./omnigraph-message-storage.js"
import { quarantineOrphanEntityMessages } from "./omnigraph-workflow-store.js"

export interface HarnessWorkflowEngineOptions extends OmnigraphMessageStorageOptions {
  readonly knownEntityTypes?: ReadonlyArray<string> | undefined
  readonly shardsPerGroup?: number | undefined
  readonly entityMessagePollInterval?: Duration.Input | undefined
  readonly entityReplyPollInterval?: Duration.Input | undefined
}

export type HarnessWorkflowEngineLayerOptions = HarnessWorkflowEngineOptions

/**
 * Single-process cluster sharding stack backed by `OmnigraphMessageStorage`
 * (`16` shards per group, `30 s` message recovery poll, `2 s` reply poll).
 * Runs startup dangling-request repair and (when `knownEntityTypes` is explicitly
 * provided) orphan-entity quarantine before `Sharding` starts polling storage.
 */
const makeHarnessShardingLayer = (
  repoRoot: AbsoluteRepoRoot,
  options?: HarnessWorkflowEngineOptions,
): Layer.Layer<
  Sharding.Sharding | MessageStorage.MessageStorage,
  WorkflowStoreUnavailableError | WriterLeaseHeldError
> => {
  const preparedStorageLayer = makeOmnigraphMessageStorageLayer(repoRoot, options).pipe(
    Layer.tap(() =>
      Effect.gen(function* () {
        yield* repairDanglingProcessedRequests({
          repoRoot,
          client: options?.client,
          hostIo: options?.hostIo,
          env: options?.env,
          writeMutex: options?.writeMutex,
          expectedLeaseEpoch: options?.expectedLeaseEpoch,
          expectedLeaseOwner: options?.expectedLeaseOwner,
          lockFilePath: options?.lockFilePath,
        })
        if (options?.knownEntityTypes !== undefined) {
          yield* quarantineOrphanEntityMessages({
            repoRoot,
            knownEntityTypes: options.knownEntityTypes,
            client: options.client,
            hostIo: options.hostIo,
            env: options.env,
            expectedLeaseEpoch: options.expectedLeaseEpoch,
            lockFilePath: options.lockFilePath,
          })
        }
      }),
    ),
  )

  return Sharding.layer.pipe(
    Layer.provideMerge(Runners.layerNoop),
    Layer.provideMerge(preparedStorageLayer),
    Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
    Layer.provide(
      ShardingConfig.layer({
        shardsPerGroup: options?.shardsPerGroup ?? 16,
        entityMessagePollInterval: options?.entityMessagePollInterval ?? Duration.seconds(30),
        entityReplyPollInterval: options?.entityReplyPollInterval ?? Duration.seconds(2),
      }),
    ),
  )
}

/**
 * Builds `ClusterWorkflowEngine` over `OmnigraphMessageStorage` for `repoRoot`.
 */
const makeHarnessWorkflowEngineLayer = (
  repoRoot: AbsoluteRepoRoot,
  options?: HarnessWorkflowEngineOptions,
): Layer.Layer<
  WorkflowEngine.WorkflowEngine,
  WorkflowStoreUnavailableError | WriterLeaseHeldError
> => ClusterWorkflowEngine.layer.pipe(Layer.provide(makeHarnessShardingLayer(repoRoot, options)))

export { makeHarnessShardingLayer, makeHarnessWorkflowEngineLayer }
