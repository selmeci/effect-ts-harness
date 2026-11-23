import { randomUUID } from "node:crypto"
import {
  Context,
  type Duration,
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
  toBoundedReason,
  type WorkflowRunId,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
} from "@harness/contract"
import { HarnessTaskWorkflowLayer } from "@harness/gates"
import type { OmnigraphClient } from "@harness/graph"
import {
  type ActiveWriterLease,
  acquireWriterLease,
  makeHarnessWorkflowEngineLayer,
  makeUnitVerifierLayer,
  makeWorkflowProjectionWriterLayer,
  makeWorkflowReadModelQueryLayer,
  makeWorkflowReviewRouterLayer,
  makeWorkflowWorktreePortLayer,
  nodeSyncHostIo,
  refreshWriterLease,
  resolveWorkflowRuntimePaths,
  UnitAgentDispatcherLive,
  type WorkflowReadModelLeaseFence,
  type WorkflowReadModelOptions,
} from "@harness/infra"
import {
  UnitAgentDispatcher,
  type UnitAgentDispatcherShape,
  UnitVerifier,
  type UnitVerifierShape,
  type UnixSocketDaemonPortShape,
  WorkflowProjectionWriter,
  type WorkflowProjectionWriterShape,
  WorkflowReadModelQuery,
  type WorkflowReadModelQueryShape,
  WorkflowReviewRouter,
  type WorkflowReviewRouterShape,
  WorkflowWorktreePort,
  type WorkflowWorktreePortShape,
} from "@harness/service"
import type { ExtendedHostIo } from "@harness/service/host-io"
import type { StartupWorktreeState } from "./workflow-daemon-helper.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export const DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS = 10_000
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

export type WorkflowEngineDaemonMode = "auto" | "required" | "disabled"

export type WorkflowPortsServices =
  | UnitVerifier
  | UnitAgentDispatcher
  | WorkflowWorktreePort
  | WorkflowReviewRouter
  | WorkflowProjectionWriter
  | WorkflowReadModelQuery

export type WorkflowDaemonServices = WorkflowEngine.WorkflowEngine | WorkflowPortsServices

export interface WorkflowDaemonRuntime {
  readonly workflowContext: Context.Context<WorkflowDaemonServices>
  readonly engine: WorkflowEngine.WorkflowEngine["Service"]
  readonly projectionWriter: WorkflowProjectionWriterShape
  readonly readModelQuery: WorkflowReadModelQueryShape
  readonly unitVerifier: UnitVerifierShape
  readonly unitAgentDispatcher: UnitAgentDispatcherShape
  readonly worktreePort: WorkflowWorktreePortShape
  readonly reviewRouter: WorkflowReviewRouterShape
  readonly leaseFence: WorkflowReadModelLeaseFence
  readonly plansRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<WorkflowRunId, CompiledPlan>>
  readonly runMutexesRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<WorkflowRunId, Semaphore.Semaphore>
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
  readonly reviewRouterLayer?: Layer.Layer<WorkflowReviewRouter> | undefined
  readonly projectionWriterLayer?: Layer.Layer<WorkflowProjectionWriter> | undefined
  readonly readModelQueryLayer?: Layer.Layer<WorkflowReadModelQuery> | undefined
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

const buildWorkflowPortsLayer = (
  repoRoot: AbsoluteRepoRoot,
  options: WorkflowEngineDaemonOptions,
  leaseFence: WorkflowReadModelLeaseFence,
  runLock: <A, E>(runId: WorkflowRunId, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
  readGate: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>,
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
      UnitAgentDispatcherLive,
      makeWorkflowReviewRouterLayer(
        options.hostIo !== undefined ? { hostIo: options.hostIo } : undefined,
      ),
      makeWorkflowProjectionWriterLayer(readModelOptions),
      makeWorkflowReadModelQueryLayer(readModelOptions),
    )
  if (options.unitVerifierLayer !== undefined) {
    resolved = Layer.merge(resolved, options.unitVerifierLayer)
  }
  if (options.worktreePortLayer !== undefined) {
    resolved = Layer.merge(resolved, options.worktreePortLayer)
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
  return resolved
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
    const projectionMutexesRef = yield* SynchronizedRef.make<
      ReadonlyMap<WorkflowRunId, Semaphore.Semaphore>
    >(new Map())
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

    const engineLayer = makeHarnessWorkflowEngineLayer(input.repoRoot, {
      expectedLeaseEpoch: lease.leaseEpoch,
      expectedLeaseOwner: lease.owner,
      lockFilePath: input.lockFilePath,
      writeMutex: journalWriteMutex,
      ...(options.client !== undefined ? { client: options.client } : {}),
      ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.knownEntityTypes !== undefined
        ? { knownEntityTypes: options.knownEntityTypes }
        : {}),
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
    )
    const workflowStackLayer = HarnessTaskWorkflowLayer.pipe(
      Layer.provideMerge(Layer.merge(engineLayer, portsLayer)),
    )
    const workflowContext = yield* Layer.buildWithScope(workflowStackLayer, input.targetScope)

    const runtime: WorkflowDaemonRuntime = {
      workflowContext,
      engine: Context.get(workflowContext, WorkflowEngine.WorkflowEngine),
      projectionWriter: Context.get(workflowContext, WorkflowProjectionWriter),
      readModelQuery: Context.get(workflowContext, WorkflowReadModelQuery),
      unitVerifier: Context.get(workflowContext, UnitVerifier),
      unitAgentDispatcher: Context.get(workflowContext, UnitAgentDispatcher),
      worktreePort: Context.get(workflowContext, WorkflowWorktreePort),
      reviewRouter: Context.get(workflowContext, WorkflowReviewRouter),
      leaseFence,
      plansRef,
      runMutexesRef,
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

/**
 * Forks background heartbeat (`refreshWriterLease`) and immediate OS `flock` loss
 * shutdown fibers inside `daemonScope` for an active leased daemon.
 */
export const forkWorkflowLeaseWatchers = (input: {
  readonly daemonScope: Scope.Scope
  readonly activeState: Extract<StartedWorkflowEngineState, { readonly _tag: "Active" }>
  readonly options?: WorkflowEngineDaemonOptions | undefined
  readonly triggerShutdown: () => void
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const opts = input.options
    const heartbeatIntervalMs = Math.max(
      10,
      opts?.heartbeatIntervalMs ?? DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS,
    )

    yield* Effect.forever(
      Effect.sleep(heartbeatIntervalMs).pipe(
        Effect.andThen(
          refreshWriterLease({
            commonGitDir: input.activeState.commonGitDir,
            holderId: input.activeState.lease.holderId,
            holderPid: input.activeState.lease.holderPid,
            lockFilePath: input.activeState.lockFilePath,
            leaseEpoch: input.activeState.lease.leaseEpoch,
            repoRoot: input.activeState.repoRoot,
            ...(opts?.client !== undefined ? { client: opts.client } : {}),
            ...(opts?.hostIo !== undefined ? { hostIo: opts.hostIo } : {}),
            ...(opts?.env !== undefined ? { env: opts.env } : {}),
            ...(opts?.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
            ...(opts?.readProcessStartTime !== undefined
              ? { readProcessStartTime: opts.readProcessStartTime }
              : {}),
          }).pipe(
            Effect.catchTags({
              WriterLeaseHeldError: (err) =>
                Effect.sync(() => {
                  process.stderr.write(
                    `[harness-mcp] Workflow writer lease lost during heartbeat; shutting down daemon: ${err.message}\n`,
                  )
                  input.triggerShutdown()
                  Result.try(() => opts?.onLeaseLost?.(err.message))
                }).pipe(Effect.andThen(Effect.interrupt)),
              WorkflowStoreUnavailableError: (err) =>
                Effect.sync(() => {
                  process.stderr.write(
                    `[harness-mcp] Workflow writer lease heartbeat warning: ${err.message}\n`,
                  )
                }),
            }),
          ),
        ),
      ),
    ).pipe(Effect.forkIn(input.daemonScope))

    yield* input.activeState.lease.waitForFlockLoss.pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.stderr.write(
            "[harness-mcp] OS flock lease lost unexpectedly; shutting down workflow daemon\n",
          )
          input.triggerShutdown()
          Result.try(() => opts?.onLeaseLost?.("OS flock lock lost"))
        }),
      ),
      Effect.forkIn(input.daemonScope),
    )
  })
