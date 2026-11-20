import { randomUUID } from "node:crypto"
import { Effect, Exit, Layer, Result, Schema, Scope } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type DaemonSocketPath,
  type GitCommonDirPath,
  LeaseEpoch,
  type LeaseFilePath,
  LeaseHolderId,
  LeaseHolderPid,
  toBoundedReason,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  WriterLeaseHeldError,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import {
  type ActiveWriterLease,
  acquireWriterLease,
  makeHarnessWorkflowEngineLayer,
  nodeSyncHostIo,
  refreshWriterLease,
  resolveWorkflowRuntimePaths,
} from "@harness/infra"
import type { UnixSocketDaemonPortShape } from "@harness/service"
import type { ExtendedHostIo } from "@harness/service/host-io"
import type { StartupWorktreeState } from "./workflow-daemon-helper.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export const DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS = 10_000
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
}

export type StartedWorkflowEngineState =
  | { readonly _tag: "Inactive"; readonly writerLeaseEpoch: LeaseEpoch }
  | { readonly _tag: "AttachedAlreadyAlive"; readonly socketPath: DaemonSocketPath }
  | {
      readonly _tag: "Active"
      readonly lease: ActiveWriterLease
      readonly lockFilePath: LeaseFilePath
      readonly commonGitDir: GitCommonDirPath
      readonly repoRoot: AbsoluteRepoRoot
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
  readonly leaseEpoch: LeaseEpoch
  readonly holderPid?: LeaseHolderPid | undefined
} => {
  const metaPath = `${lockFilePath}.meta.json`
  const fallback = {
    holderId: LeaseHolderId.make("existing-daemon"),
    leaseEpoch: LeaseEpoch.make(0),
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
    leaseEpoch: meta.leaseEpoch,
    lockFilePath,
    ...(meta.holderPid !== undefined ? { holderPid: meta.holderPid } : {}),
  })
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

    const engineLayer = makeHarnessWorkflowEngineLayer(input.repoRoot, {
      expectedLeaseEpoch: lease.leaseEpoch,
      expectedLeaseOwner: lease.owner,
      lockFilePath: input.lockFilePath,
      ...(options.client !== undefined ? { client: options.client } : {}),
      ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.knownEntityTypes !== undefined
        ? { knownEntityTypes: options.knownEntityTypes }
        : {}),
    })

    yield* Layer.buildWithScope(engineLayer, input.targetScope)

    return {
      _tag: "Active",
      lease,
      lockFilePath: input.lockFilePath,
      commonGitDir: input.commonGitDir,
      repoRoot: input.repoRoot,
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
    readonly fallbackWriterLeaseEpoch: LeaseEpoch
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
        writerLeaseEpoch: input.fallbackWriterLeaseEpoch,
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
              writerLeaseEpoch: LeaseEpoch.make(0),
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
                              `[harness-mcp] Workflow engine unavailable in auto mode; degrading to epoch 0 (${err.reason})\n`,
                            )
                          }).pipe(
                            Effect.as<StartedWorkflowEngineState>({
                              _tag: "Inactive",
                              writerLeaseEpoch: LeaseEpoch.make(0),
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
          writerLeaseEpoch: input.fallbackWriterLeaseEpoch,
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
