import { randomUUID } from "node:crypto"
import {
  Context,
  Effect,
  Exit,
  Layer,
  Result,
  Schema,
  Scope,
  Semaphore,
  SynchronizedRef,
} from "effect"
import { WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type CompiledPlan,
  type DaemonSocketPath,
  type GitCommonDirPath,
  LeaseEpoch,
  type LeaseFilePath,
  LeaseHolderId,
  LeaseHolderPid,
  type ShipStreamProgressEvent,
  toBoundedReason,
  validateWorkflowTimeoutBudgets,
  WORKFLOW_TIMEOUT_BUDGETS,
  type WorkflowRunId,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  type WorkflowTimeoutBudgets,
  WriterLeaseHeldError,
} from "@harness/contract"
import { HarnessTaskWorkflowLayer, ShipWorkflowLayer } from "@harness/gates"
import type { OmnigraphClient } from "@harness/graph"
import {
  type ActiveWriterLease,
  type ShipActiveGateController,
  acquireWriterLease,
  createShipActiveGateController,
  makeHarnessWorkflowEngineLayer,
  nodeSyncHostIo,
  resolveWorkflowRuntimePaths,
  type WorkflowReadModelLeaseFence,
} from "@harness/infra"
import {
  ShipAttemptStore,
  type ShipAttemptStoreShape,
  ShipGateRunner,
  type ShipGateRunnerShape,
  UnitAgentDispatcher,
  type UnitAgentDispatcherShape,
  UnitVerifier,
  type UnitVerifierShape,
  type UnixSocketDaemonPortShape,
  WorkflowProjectionWriter,
  type WorkflowProjectionWriterShape,
  WorkflowProjector,
  type WorkflowProjectorShape,
  WorkflowReadModelQuery,
  type WorkflowReadModelQueryShape,
  WorkflowReviewRouter,
  type WorkflowReviewRouterShape,
  WorkflowWorktreePort,
  type WorkflowWorktreePortShape,
} from "@harness/service"
import type { ExtendedHostIo } from "@harness/service/host-io"
import type { StartupWorktreeState } from "./workflow-daemon-helper.js"
import {
  DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS,
  forkWorkflowLeaseWatchers,
  invokeOnLeaseLost,
} from "./workflow-lease-watchers.js"
import {
  buildWorkflowPortsLayer,
  resolveDaemonKnownEntityTypes,
  type WorkflowDaemonServices,
  type WorkflowEngineDaemonMode,
  type WorkflowEngineDaemonOptions,
  type WorkflowPortsServices,
  type WorkflowTaskDaemonServices,
  type WorkflowTaskServices,
} from "./workflow-ports-daemon-helper.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export {
  DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS,
  forkWorkflowLeaseWatchers,
  invokeOnLeaseLost,
  type WorkflowDaemonServices,
  type WorkflowEngineDaemonMode,
  type WorkflowEngineDaemonOptions,
  type WorkflowPortsServices,
  type WorkflowTaskDaemonServices,
  type WorkflowTaskServices,
}
export const MAX_CONCURRENT_RUN_LOCKS = 1024
const WORKFLOW_DAEMON_ENGINE_OP = WorkflowStoreOperation.make("HarnessDaemon.workflowEngine")

const ExistingLockMetaSchema = Schema.fromJsonString(
  Schema.Struct({
    holderId: LeaseHolderId,
    holderPid: LeaseHolderPid,
    leaseEpoch: LeaseEpoch,
  }),
)
const decodeExistingLockMetaOption = Schema.decodeUnknownOption(ExistingLockMetaSchema)

export interface WorkflowDaemonRuntime {
  readonly workflowContext: Context.Context<WorkflowTaskDaemonServices>
  readonly shipWorkflowContext: Context.Context<WorkflowDaemonServices>
  readonly engine: WorkflowEngine.WorkflowEngine["Service"]
  readonly projectionWriter: WorkflowProjectionWriterShape
  readonly workflowProjector: WorkflowProjectorShape
  readonly readModelQuery: WorkflowReadModelQueryShape
  readonly unitVerifier: UnitVerifierShape
  readonly unitAgentDispatcher: UnitAgentDispatcherShape
  readonly worktreePort: WorkflowWorktreePortShape
  readonly reviewRouter: WorkflowReviewRouterShape
  readonly shipGateRunner: ShipGateRunnerShape
  readonly shipAttemptStore: ShipAttemptStoreShape
  readonly shipProgressListeners: Map<string, (event: ShipStreamProgressEvent) => void>
  readonly shipGateController: ShipActiveGateController
  readonly leaseFence: WorkflowReadModelLeaseFence
  readonly plansRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<WorkflowRunId, CompiledPlan>>
  readonly runMutexesRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<WorkflowRunId, Semaphore.Semaphore>
  >
  readonly shipWorktreeMutexesRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<AbsoluteRepoRoot, Semaphore.Semaphore>
  >
  readonly rebuildMutex: Semaphore.Semaphore
  readonly rebuildRpcGateSemaphore: Semaphore.Semaphore
  readonly rebuildProjectionGateSemaphore: Semaphore.Semaphore
  readonly journalWriteMutex: Semaphore.Semaphore
  readonly canonicalRepoRoot: AbsoluteRepoRoot
  readonly commonGitDir: GitCommonDirPath
  readonly hostIo: ExtendedHostIo
  readonly client?: Omnigraph | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

export type StartedWorkflowEngineState =
  | { readonly _tag: "Inactive"; readonly writerLeaseEpoch?: LeaseEpoch | undefined }
  | { readonly _tag: "AttachedAlreadyAlive"; readonly socketPath: DaemonSocketPath }
  | {
      readonly _tag: "Active"
      readonly lease: ActiveWriterLease
      readonly lockFilePath: LeaseFilePath
      readonly commonGitDir: GitCommonDirPath
      readonly repoRoot: AbsoluteRepoRoot
      readonly runtime: WorkflowDaemonRuntime
    }

const resolveHolderId = (options?: WorkflowEngineDaemonOptions): LeaseHolderId =>
  options?.holderId ?? LeaseHolderId.make(`harness-mcp-${process.pid}-${randomUUID().slice(0, 8)}`)

const resolveHolderPid = (options?: WorkflowEngineDaemonOptions): LeaseHolderPid =>
  options?.holderPid ?? LeaseHolderPid.make(process.pid)

const readExistingLockMetaFallback = (
  lockFilePath: LeaseFilePath,
  hostIo: ExtendedHostIo,
): {
  readonly holderId: LeaseHolderId
  readonly leaseEpoch?: LeaseEpoch | undefined
  readonly holderPid?: LeaseHolderPid | undefined
} => {
  const metaPath = `${lockFilePath}.meta.json`
  const fallback = {
    holderId: LeaseHolderId.make("existing-daemon"),
  }
  if (hostIo.isSymbolicLinkSync(metaPath) || !hostIo.existsSync(metaPath)) {
    return fallback
  }
  return match(Result.try(() => hostIo.readTextSync(metaPath)))
    .with({ _tag: "Failure" }, () => fallback)
    .with({ _tag: "Success" }, ({ success: raw }) =>
      match(decodeExistingLockMetaOption(raw))
        .with({ _tag: "Some" }, ({ value }) => ({
          holderId: value.holderId,
          leaseEpoch: value.leaseEpoch,
          holderPid: value.holderPid,
        }))
        .with({ _tag: "None" }, () => fallback)
        .exhaustive(),
    )
    .exhaustive()
}

export const buildAlreadyAliveLeaseError = (
  commonGitDir: GitCommonDirPath,
  hostIo: ExtendedHostIo = nodeSyncHostIo,
): WriterLeaseHeldError => {
  const { lockFilePath } = resolveWorkflowRuntimePaths(commonGitDir)
  const meta = readExistingLockMetaFallback(lockFilePath, hostIo)
  return new WriterLeaseHeldError({
    holderId: meta.holderId,
    lockFilePath,
    ...(meta.leaseEpoch !== undefined ? { leaseEpoch: meta.leaseEpoch } : {}),
    ...(meta.holderPid !== undefined ? { holderPid: meta.holderPid } : {}),
  })
}

const makeProjectionRunLock = (
  projectionMutexesRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<WorkflowRunId, Semaphore.Semaphore>
  >,
  rebuildProjectionGateSemaphore: Semaphore.Semaphore,
): (<A, E>(runId: WorkflowRunId, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>) => {
  return <A, E>(runId: WorkflowRunId, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    rebuildProjectionGateSemaphore.withPermits(1)(
      SynchronizedRef.modifyEffect(projectionMutexesRef, (map) => {
        const existing = map.get(runId)
        if (existing !== undefined) {
          return Effect.succeed([existing, map] as const)
        }
        const sem = Semaphore.makeUnsafe(1)
        return Effect.succeed([sem, new Map(map).set(runId, sem)] as const)
      }).pipe(Effect.flatMap((sem) => sem.withPermit(effect))),
    )
}

const acquireLeaseAndBuildEngineInScope = (input: {
  readonly targetScope: Scope.Scope
  readonly commonGitDir: GitCommonDirPath
  readonly lockFilePath: LeaseFilePath
  readonly repoRoot: AbsoluteRepoRoot
  readonly options: WorkflowEngineDaemonOptions
}): Effect.Effect<
  StartedWorkflowEngineState,
  WriterLeaseHeldError | WorkflowStoreUnavailableError
> =>
  Effect.gen(function* () {
    const { options } = input
    const lease = yield* acquireWriterLease({
      commonGitDir: input.commonGitDir,
      lockFilePath: input.lockFilePath,
      holderId: resolveHolderId(options),
      holderPid: resolveHolderPid(options),
      repoRoot: input.repoRoot,
      ...(options.client !== undefined ? { client: options.client } : {}),
      ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.isPidAlive !== undefined ? { isPidAlive: options.isPidAlive } : {}),
      ...(options.readProcessStartTime !== undefined
        ? { readProcessStartTime: options.readProcessStartTime }
        : {}),
    }).pipe(Scope.provide(input.targetScope))

    const leaseFence: WorkflowReadModelLeaseFence = {
      expectedLeaseEpoch: lease.leaseEpoch,
      expectedLeaseOwner: lease.owner,
      ownerId: lease.holderId,
      lockFilePath: input.lockFilePath,
      commonGitDir: input.commonGitDir,
    }

    const plansRef = yield* SynchronizedRef.make<ReadonlyMap<WorkflowRunId, CompiledPlan>>(
      new Map(),
    )
    const runMutexesRef = yield* SynchronizedRef.make<
      ReadonlyMap<WorkflowRunId, Semaphore.Semaphore>
    >(new Map())
    const shipWorktreeMutexesRef = yield* SynchronizedRef.make<
      ReadonlyMap<AbsoluteRepoRoot, Semaphore.Semaphore>
    >(new Map())
    const projectionMutexesRef = yield* SynchronizedRef.make<
      ReadonlyMap<WorkflowRunId, Semaphore.Semaphore>
    >(new Map())
    const shipProgressListeners = new Map<string, (event: ShipStreamProgressEvent) => void>()
    const shipGateController = createShipActiveGateController()
    const rebuildMutex = Semaphore.makeUnsafe(1)
    const rebuildRpcGateSemaphore = Semaphore.makeUnsafe(MAX_CONCURRENT_RUN_LOCKS)
    const rebuildProjectionGateSemaphore = Semaphore.makeUnsafe(MAX_CONCURRENT_RUN_LOCKS)
    const journalWriteMutex = Semaphore.makeUnsafe(1)
    const projectionRunLock = makeProjectionRunLock(
      projectionMutexesRef,
      rebuildProjectionGateSemaphore,
    )
    const readModelReadGate = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      rebuildProjectionGateSemaphore.withPermits(1)(effect)

    const knownEntityTypes = resolveDaemonKnownEntityTypes(options.knownEntityTypes)
    const engineLayer = makeHarnessWorkflowEngineLayer(input.repoRoot, {
      expectedLeaseEpoch: lease.leaseEpoch,
      expectedLeaseOwner: lease.owner,
      lockFilePath: input.lockFilePath,
      writeMutex: journalWriteMutex,
      ...(options.client !== undefined ? { client: options.client } : {}),
      ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(knownEntityTypes !== undefined ? { knownEntityTypes } : {}),
      ...(options.shardsPerGroup !== undefined ? { shardsPerGroup: options.shardsPerGroup } : {}),
      ...(options.entityMessagePollInterval !== undefined
        ? { entityMessagePollInterval: options.entityMessagePollInterval }
        : {}),
      ...(options.entityReplyPollInterval !== undefined
        ? { entityReplyPollInterval: options.entityReplyPollInterval }
        : {}),
    })

    const portsLayer = buildWorkflowPortsLayer(
      input.repoRoot,
      options,
      leaseFence,
      projectionRunLock,
      readModelReadGate,
      shipProgressListeners,
      shipGateController,
    )
    const workflowStackLayer = Layer.merge(HarnessTaskWorkflowLayer, ShipWorkflowLayer).pipe(
      Layer.provideMerge(Layer.merge(engineLayer, portsLayer)),
    )
    const workflowContext = yield* Layer.buildWithScope(workflowStackLayer, input.targetScope)

    const runtime: WorkflowDaemonRuntime = {
      workflowContext,
      shipWorkflowContext: workflowContext,
      engine: Context.get(workflowContext, WorkflowEngine.WorkflowEngine),
      projectionWriter: Context.get(workflowContext, WorkflowProjectionWriter),
      workflowProjector: Context.get(workflowContext, WorkflowProjector),
      readModelQuery: Context.get(workflowContext, WorkflowReadModelQuery),
      unitVerifier: Context.get(workflowContext, UnitVerifier),
      unitAgentDispatcher: Context.get(workflowContext, UnitAgentDispatcher),
      worktreePort: Context.get(workflowContext, WorkflowWorktreePort),
      reviewRouter: Context.get(workflowContext, WorkflowReviewRouter),
      shipGateRunner: Context.get(workflowContext, ShipGateRunner),
      shipAttemptStore: Context.get(workflowContext, ShipAttemptStore),
      shipProgressListeners,
      shipGateController,
      leaseFence,
      plansRef,
      runMutexesRef,
      shipWorktreeMutexesRef,
      rebuildMutex,
      rebuildRpcGateSemaphore,
      rebuildProjectionGateSemaphore,
      journalWriteMutex,
      canonicalRepoRoot: input.repoRoot,
      commonGitDir: input.commonGitDir,
      hostIo: options.hostIo ?? nodeSyncHostIo,
      client: options.client,
      env: options.env,
    }

    return {
      _tag: "Active",
      lease,
      lockFilePath: input.lockFilePath,
      commonGitDir: input.commonGitDir,
      repoRoot: input.repoRoot,
      runtime,
    } satisfies StartedWorkflowEngineState
  })

/**
 * Validates `WORKFLOW_TIMEOUT_BUDGETS` monotonicity invariants (`F-13.1`) and
 * ensures any configured `heartbeatIntervalMs` is finite, positive, and strictly
 * less than `writerLeaseHeartbeatTtlMs`.
 */
export const validateWorkflowDaemonTimeoutBudgets = (
  options?: WorkflowEngineDaemonOptions,
  budgets: WorkflowTimeoutBudgets = WORKFLOW_TIMEOUT_BUDGETS,
): Effect.Effect<void, WorkflowStoreUnavailableError> => {
  const budgetFailure = match(validateWorkflowTimeoutBudgets(budgets))
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
  if (budgetFailure !== undefined) {
    return Effect.fail(
      new WorkflowStoreUnavailableError({
        operation: WORKFLOW_DAEMON_ENGINE_OP,
        reason: toBoundedReason(`Invalid workflow timeout budgets: ${budgetFailure}`),
      }),
    )
  }
  const effectiveHeartbeatMs =
    options?.heartbeatIntervalMs ?? DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS
  if (
    !Number.isFinite(effectiveHeartbeatMs) ||
    effectiveHeartbeatMs <= 0 ||
    effectiveHeartbeatMs >= budgets.writerLeaseHeartbeatTtlMs
  ) {
    return Effect.fail(
      new WorkflowStoreUnavailableError({
        operation: WORKFLOW_DAEMON_ENGINE_OP,
        reason: toBoundedReason(
          `Invalid workflow heartbeatIntervalMs (${String(effectiveHeartbeatMs)}): must be > 0 and < writerLeaseHeartbeatTtlMs (${budgets.writerLeaseHeartbeatTtlMs})`,
        ),
      }),
    )
  }
  return Effect.void
}

/**
 * Acquires the single-writer `WfWriterLease` and builds `makeHarnessWorkflowEngineLayer`
 * inside `daemonScope` according to `workflowEngineOptions.mode` (`auto`, `required`, `disabled`).
 */
export const acquireWorkflowEngineInScope = Effect.fn("HarnessDaemon.acquireWorkflowEngineInScope")(
  function* (input: {
    readonly daemonScope: Scope.Scope
    readonly startupState: StartupWorktreeState
    readonly fallbackWriterLeaseEpoch?: LeaseEpoch | undefined
    readonly workflowEngineOptions?: WorkflowEngineDaemonOptions | undefined
    readonly unixSocketDaemon: UnixSocketDaemonPortShape
  }): Effect.fn.Return<
    StartedWorkflowEngineState,
    WriterLeaseHeldError | WorkflowStoreUnavailableError
  > {
    const opts = input.workflowEngineOptions
    yield* validateWorkflowDaemonTimeoutBudgets(opts)
    if (opts === undefined) {
      return {
        _tag: "Inactive",
        ...(input.fallbackWriterLeaseEpoch !== undefined
          ? { writerLeaseEpoch: input.fallbackWriterLeaseEpoch }
          : {}),
      }
    }

    return yield* match(opts.mode)
      .with("required", () =>
        match(input.startupState)
          .with({ _tag: "NonGit" }, () =>
            Effect.fail(
              new WorkflowStoreUnavailableError({
                operation: WORKFLOW_DAEMON_ENGINE_OP,
                reason: toBoundedReason(
                  "Workflow daemon mode 'required' requires a valid git worktree root",
                ),
              }),
            ),
          )
          .with({ _tag: "InvalidGit" }, ({ reason }) =>
            Effect.fail(
              new WorkflowStoreUnavailableError({
                operation: WORKFLOW_DAEMON_ENGINE_OP,
                reason: toBoundedReason(reason),
              }),
            ),
          )
          .with({ _tag: "Valid" }, ({ worktree }) =>
            Effect.gen(function* () {
              const runtimePaths = resolveWorkflowRuntimePaths(worktree.commonGitDir)
              const socketAlive = yield* input.unixSocketDaemon.isSocketAlive(
                runtimePaths.socketPath,
              )
              if (socketAlive) {
                return yield* buildAlreadyAliveLeaseError(worktree.commonGitDir, opts.hostIo)
              }
              return yield* acquireLeaseAndBuildEngineInScope({
                targetScope: input.daemonScope,
                commonGitDir: worktree.commonGitDir,
                lockFilePath: runtimePaths.lockFilePath,
                repoRoot: worktree.worktreeRoot,
                options: opts,
              })
            }),
          )
          .exhaustive(),
      )
      .with("auto", () =>
        match(input.startupState)
          .with({ _tag: "NonGit" }, { _tag: "InvalidGit" }, () =>
            Effect.succeed<StartedWorkflowEngineState>({
              _tag: "Inactive",
            }),
          )
          .with({ _tag: "Valid" }, ({ worktree }) =>
            Effect.gen(function* () {
              const runtimePaths = resolveWorkflowRuntimePaths(worktree.commonGitDir)
              const socketAlive = yield* input.unixSocketDaemon.isSocketAlive(
                runtimePaths.socketPath,
              )
              if (socketAlive) {
                return {
                  _tag: "AttachedAlreadyAlive",
                  socketPath: runtimePaths.socketPath,
                } satisfies StartedWorkflowEngineState
              }

              const workflowScope = yield* Scope.fork(input.daemonScope)
              const attemptExit = yield* acquireLeaseAndBuildEngineInScope({
                targetScope: workflowScope,
                commonGitDir: worktree.commonGitDir,
                lockFilePath: runtimePaths.lockFilePath,
                repoRoot: worktree.worktreeRoot,
                options: opts,
              }).pipe(Effect.result)

              return yield* match(attemptExit)
                .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
                .with({ _tag: "Failure" }, ({ failure }) =>
                  Scope.close(workflowScope, Exit.void).pipe(
                    Effect.andThen(
                      match(failure)
                        .with({ _tag: "WorkflowStoreUnavailableError" }, (err) =>
                          Effect.sync(() => {
                            process.stderr.write(
                              `[harness-mcp] Workflow engine unavailable in auto mode; degrading to inactive lease (${err.reason})\n`,
                            )
                          }).pipe(
                            Effect.as<StartedWorkflowEngineState>({
                              _tag: "Inactive",
                            }),
                          ),
                        )
                        .with({ _tag: "WriterLeaseHeldError" }, (err) =>
                          Effect.gen(function* () {
                            for (let probeAttempt = 0; probeAttempt < 5; probeAttempt += 1) {
                              const aliveAfterContention =
                                yield* input.unixSocketDaemon.isSocketAlive(runtimePaths.socketPath)
                              if (aliveAfterContention) {
                                return {
                                  _tag: "AttachedAlreadyAlive",
                                  socketPath: runtimePaths.socketPath,
                                } satisfies StartedWorkflowEngineState
                              }
                              if (probeAttempt < 4) {
                                yield* Effect.sleep("50 millis")
                              }
                            }
                            return yield* err
                          }),
                        )
                        .exhaustive(),
                    ),
                  ),
                )
                .exhaustive()
            }),
          )
          .exhaustive(),
      )
      .with("disabled", () =>
        Effect.succeed<StartedWorkflowEngineState>({
          _tag: "Inactive",
          ...(input.fallbackWriterLeaseEpoch !== undefined
            ? { writerLeaseEpoch: input.fallbackWriterLeaseEpoch }
            : {}),
        }),
      )
      .exhaustive()
  },
)
