import { type Duration, type Effect, Layer } from "effect"
import type { WorkflowEngine } from "effect/workflow"
import type {
  AbsoluteRepoRoot,
  LeaseHolderId,
  LeaseHolderPid,
  ShipStreamProgressEvent,
  WorkflowRunId,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import {
  type ShipActiveGateController,
  makeAgentRunnerPortLayer,
  makeShipAttemptStoreLayer,
  makeShipGateRunnerLayer,
  makeUnitVerifierLayer,
  makeWorkflowProjectionWriterLayer,
  makeWorkflowReadModelQueryLayer,
  makeWorkflowReviewRouterLayer,
  makeWorkflowWorktreePortLayer,
  type ShipGateRunnerOptions,
  UnitAgentDispatcherLive,
  UnitAgentDispatcherLiveFromPort,
  type WorkflowReadModelLeaseFence,
  type WorkflowReadModelOptions,
} from "@harness/infra"
import type {
  AgentRunnerPort,
  ShipAttemptStore,
  ShipGateRunner,
  UnitAgentDispatcher,
  UnitVerifier,
  WorkflowProjectionWriter,
  WorkflowReadModelQuery,
  WorkflowReviewRouter,
  WorkflowWorktreePort,
} from "@harness/service"
import type { ExtendedHostIo } from "@harness/service/host-io"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export type WorkflowEngineDaemonMode = "auto" | "required" | "disabled"

export type WorkflowTaskServices =
  | UnitVerifier
  | UnitAgentDispatcher
  | WorkflowWorktreePort
  | WorkflowReviewRouter
  | WorkflowProjectionWriter
  | WorkflowReadModelQuery

export type WorkflowPortsServices = WorkflowTaskServices | ShipGateRunner | ShipAttemptStore

export type WorkflowTaskDaemonServices = WorkflowEngine.WorkflowEngine | WorkflowTaskServices

export type WorkflowDaemonServices = WorkflowEngine.WorkflowEngine | WorkflowPortsServices

export interface WorkflowEngineDaemonOptions {
  readonly mode: WorkflowEngineDaemonMode
  readonly client?: Omnigraph | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly holderId?: LeaseHolderId | undefined
  readonly holderPid?: LeaseHolderPid | undefined
  readonly nowMs?: (() => number) | undefined
  readonly isPidAlive?: ((pid: number) => boolean) | undefined
  readonly readProcessStartTime?: ((pid: number) => string | undefined) | undefined
  readonly heartbeatIntervalMs?: number | undefined
  readonly knownEntityTypes?: ReadonlyArray<string> | undefined
  readonly onLeaseLost?: ((reason: string) => void) | undefined
  readonly shardsPerGroup?: number | undefined
  readonly entityMessagePollInterval?: Duration.Input | undefined
  readonly entityReplyPollInterval?: Duration.Input | undefined
  readonly workflowPortsLayer?: Layer.Layer<WorkflowPortsServices> | undefined
  readonly unitVerifierLayer?: Layer.Layer<UnitVerifier> | undefined
  readonly worktreePortLayer?: Layer.Layer<WorkflowWorktreePort> | undefined
  readonly agentDispatcherLayer?: Layer.Layer<UnitAgentDispatcher> | undefined
  readonly agentRunnerLayer?: Layer.Layer<AgentRunnerPort> | undefined
  readonly reviewRouterLayer?: Layer.Layer<WorkflowReviewRouter> | undefined
  readonly projectionWriterLayer?: Layer.Layer<WorkflowProjectionWriter> | undefined
  readonly readModelQueryLayer?: Layer.Layer<WorkflowReadModelQuery> | undefined
  readonly shipGateRunnerLayer?: Layer.Layer<ShipGateRunner> | undefined
  readonly shipAttemptStoreLayer?: Layer.Layer<ShipAttemptStore> | undefined
  readonly shipGateRunCommand?: ShipGateRunnerOptions["runCommand"] | undefined
}

/**
 * Ensures `"Workflow/ShipWorkflow"` is included in `knownEntityTypes` whenever
 * `"Workflow/HarnessTaskWorkflow"` is present so `ShipWorkflow` journal envelopes are never quarantined.
 */
export const resolveDaemonKnownEntityTypes = (
  knownEntityTypes: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined => {
  if (knownEntityTypes === undefined) {
    return undefined
  }
  if (
    knownEntityTypes.includes("Workflow/HarnessTaskWorkflow") &&
    !knownEntityTypes.includes("Workflow/ShipWorkflow")
  ) {
    return [...knownEntityTypes, "Workflow/ShipWorkflow"]
  }
  return knownEntityTypes
}

/**
 * Composes all live workflow port layers (with optional test/caller layer overrides)
 * for `HarnessTaskWorkflow` and `ShipWorkflow` under a single writer-lease fence.
 */
export const buildWorkflowPortsLayer = (
  repoRoot: AbsoluteRepoRoot,
  options: WorkflowEngineDaemonOptions,
  leaseFence: WorkflowReadModelLeaseFence,
  runLock: <A, E>(runId: WorkflowRunId, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
  readGate: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
  shipProgressListeners: Map<string, (event: ShipStreamProgressEvent) => void>,
  activeGateController?: ShipActiveGateController,
): Layer.Layer<WorkflowPortsServices> => {
  const readModelOptions: WorkflowReadModelOptions = {
    repoRoot,
    ...leaseFence,
    runLock,
    readGate,
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  }
  const runnerDispatcherLayer =
    options.agentRunnerLayer !== undefined
      ? UnitAgentDispatcherLiveFromPort.pipe(Layer.provide(options.agentRunnerLayer))
      : undefined
  const defaultRunnerDispatcherLayer =
    options.hostIo !== undefined || options.env !== undefined
      ? UnitAgentDispatcherLiveFromPort.pipe(
          Layer.provide(
            makeAgentRunnerPortLayer({
              ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
              ...(options.env !== undefined ? { env: options.env } : {}),
            }),
          ),
        )
      : UnitAgentDispatcherLive
  let resolved: Layer.Layer<WorkflowPortsServices> =
    options.workflowPortsLayer ??
    Layer.mergeAll(
      makeUnitVerifierLayer({
        ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      }),
      makeWorkflowWorktreePortLayer({
        repoRoot,
        ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
      }),
      runnerDispatcherLayer ?? defaultRunnerDispatcherLayer,
      makeWorkflowReviewRouterLayer(
        options.hostIo !== undefined ? { hostIo: options.hostIo } : undefined,
      ),
      makeWorkflowProjectionWriterLayer(readModelOptions),
      makeWorkflowReadModelQueryLayer(readModelOptions),
      makeShipGateRunnerLayer({
        repoRoot,
        ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
        ...(options.shipGateRunCommand !== undefined
          ? { runCommand: options.shipGateRunCommand }
          : {}),
        ...(activeGateController !== undefined ? { activeGateController } : {}),
        onProgress: (event) => {
          const cb = shipProgressListeners.get(`${event.runId}:${event.attempt}`)
          cb?.(event)
        },
      }),
      makeShipAttemptStoreLayer(readModelOptions),
    )
  if (options.unitVerifierLayer !== undefined) {
    resolved = Layer.merge(resolved, options.unitVerifierLayer)
  }
  if (options.worktreePortLayer !== undefined) {
    resolved = Layer.merge(resolved, options.worktreePortLayer)
  }
  if (options.workflowPortsLayer !== undefined && runnerDispatcherLayer !== undefined) {
    resolved = Layer.merge(resolved, runnerDispatcherLayer)
  }
  if (options.agentDispatcherLayer !== undefined) {
    resolved = Layer.merge(resolved, options.agentDispatcherLayer)
  }
  if (options.reviewRouterLayer !== undefined) {
    resolved = Layer.merge(resolved, options.reviewRouterLayer)
  }
  if (options.projectionWriterLayer !== undefined) {
    resolved = Layer.merge(resolved, options.projectionWriterLayer)
  }
  if (options.readModelQueryLayer !== undefined) {
    resolved = Layer.merge(resolved, options.readModelQueryLayer)
  }
  if (options.shipGateRunnerLayer !== undefined) {
    resolved = Layer.merge(resolved, options.shipGateRunnerLayer)
  }
  if (options.shipAttemptStoreLayer !== undefined) {
    resolved = Layer.merge(resolved, options.shipAttemptStoreLayer)
  }
  return resolved
}
