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
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
  type WorkflowTimeoutBudgets,
  type WriterLeaseHeldError,
  validateWorkflowTimeoutBudgets,
} from "@harness/contract"
import {
  makeOmnigraphMessageStorageLayer,
  type OmnigraphMessageStorageOptions,
  repairDanglingProcessedRequests,
} from "./omnigraph-message-storage.js"
import {
  quarantineOrphanEntityMessages,
  toWorkflowStoreUnavailableError,
} from "./omnigraph-workflow-store.js"

export interface HarnessWorkflowEngineOptions extends OmnigraphMessageStorageOptions {
  readonly knownEntityTypes?: ReadonlyArray<string> | undefined
  readonly shardsPerGroup?: number | undefined
  readonly entityMessagePollInterval?: Duration.Input | undefined
  readonly entityReplyPollInterval?: Duration.Input | undefined
  readonly timeoutBudgets?: WorkflowTimeoutBudgets | undefined
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
            expectedLeaseOwner: options.expectedLeaseOwner,
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

const validateWorkflowBudgetsOrFail = (
  budgets?: WorkflowTimeoutBudgets,
): Effect.Effect<void, WorkflowStoreUnavailableError> => {
  const result =
    budgets !== undefined
      ? validateWorkflowTimeoutBudgets(budgets)
      : validateWorkflowTimeoutBudgets(WORKFLOW_TIMEOUT_BUDGETS)
  return match(result)
    .with({ _tag: "Success" }, () => Effect.void)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        toWorkflowStoreUnavailableError(
          WorkflowStoreOperation.make("WorkflowEngine.validateTimeoutBudgets"),
          `Invalid WORKFLOW_TIMEOUT_BUDGETS: ${failure}`,
        ),
      ),
    )
    .exhaustive()
}

/**
 * Builds `ClusterWorkflowEngine` over `OmnigraphMessageStorage` for `repoRoot`,
 * validating workflow timeout monotonicity (`SPEC-0027 REQ-2.2`) at layer initialization.
 */
const makeHarnessWorkflowEngineLayer = (
  repoRoot: AbsoluteRepoRoot,
  options?: HarnessWorkflowEngineOptions,
): Layer.Layer<
  WorkflowEngine.WorkflowEngine,
  WorkflowStoreUnavailableError | WriterLeaseHeldError
> =>
  Layer.unwrap(
    validateWorkflowBudgetsOrFail(options?.timeoutBudgets).pipe(
      Effect.as(
        ClusterWorkflowEngine.layer.pipe(
          Layer.provide(makeHarnessShardingLayer(repoRoot, options)),
        ),
      ),
    ),
  )

export { makeHarnessShardingLayer, makeHarnessWorkflowEngineLayer }
