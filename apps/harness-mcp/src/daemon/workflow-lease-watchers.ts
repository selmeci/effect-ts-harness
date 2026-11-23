import { Cause, type Duration, Effect, Result, type Scope } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type GitCommonDirPath,
  isPureInterruptCause,
  type LeaseFilePath,
  toErrorReasonMessage,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import { type ActiveWriterLease, refreshWriterLease } from "@harness/infra"
import type { ExtendedHostIo } from "@harness/service/host-io"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export const DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS = 10_000

export interface ActiveWorkflowLeaseState {
  readonly lease: ActiveWriterLease
  readonly lockFilePath: LeaseFilePath
  readonly commonGitDir: GitCommonDirPath
  readonly repoRoot: AbsoluteRepoRoot
}

export interface WorkflowLeaseWatcherOptions {
  readonly client?: Omnigraph | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly nowMs?: (() => number) | undefined
  readonly readProcessStartTime?: ((pid: number) => string | undefined) | undefined
  readonly heartbeatIntervalMs?: number | undefined
  readonly onLeaseLost?: ((reason: string) => void) | undefined
  readonly entityMessagePollInterval?: Duration.Input | undefined
  readonly entityReplyPollInterval?: Duration.Input | undefined
}

/**
 * Safely invokes `onLeaseLost`, logging any synchronous callback exception to
 * stderr so caller defects never swallow lease-loss diagnostics or block shutdown.
 */
export const invokeOnLeaseLost = (
  onLeaseLost: ((reason: string) => void) | undefined,
  reason: string,
): void => {
  if (onLeaseLost === undefined) return
  match(Result.try(() => onLeaseLost(reason)))
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness-mcp] onLeaseLost callback error: ${toErrorReasonMessage(failure)}\n`,
      )
    })
    .exhaustive()
}

const handleUnexpectedWatcherCause = <E>(
  label: string,
  triggerShutdown: () => void,
  onLeaseLost: ((reason: string) => void) | undefined,
  cause: Cause.Cause<E>,
): Effect.Effect<never> => {
  const pretty = Cause.pretty(cause)
  const detail = toErrorReasonMessage(Cause.squash(cause))
  return Effect.sync(() => {
    process.stderr.write(`[harness-mcp] ${label}; shutting down daemon:\n${pretty}\n`)
    triggerShutdown()
    invokeOnLeaseLost(onLeaseLost, `${label}: ${detail}`)
  }).pipe(Effect.andThen(Effect.interrupt))
}

/**
 * Forks background heartbeat (`refreshWriterLease`) and immediate OS `flock` loss
 * shutdown fibers inside `daemonScope` for an active leased daemon.
 */
export const forkWorkflowLeaseWatchers = (input: {
  readonly daemonScope: Scope.Scope
  readonly activeState: ActiveWorkflowLeaseState
  readonly options?: WorkflowLeaseWatcherOptions | undefined
  readonly triggerShutdown: () => void
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const opts = input.options
    const heartbeatIntervalMs = Math.max(
      10,
      opts?.heartbeatIntervalMs ?? DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS,
    )
    const maxConsecutiveStoreFailures = 3
    let consecutiveStoreFailures = 0

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
            Effect.tap(() =>
              Effect.sync(() => {
                consecutiveStoreFailures = 0
              }),
            ),
            Effect.catchTags({
              WriterLeaseHeldError: (err) =>
                Effect.sync(() => {
                  process.stderr.write(
                    `[harness-mcp] Workflow writer lease lost during heartbeat; shutting down daemon: ${err.message}\n`,
                  )
                  input.triggerShutdown()
                  invokeOnLeaseLost(opts?.onLeaseLost, err.message)
                }).pipe(Effect.andThen(Effect.interrupt)),
              WorkflowStoreUnavailableError: (err) => {
                consecutiveStoreFailures += 1
                process.stderr.write(
                  `[harness-mcp] Workflow writer lease heartbeat warning (${consecutiveStoreFailures}/${maxConsecutiveStoreFailures}): ${err.message}\n`,
                )
                if (consecutiveStoreFailures >= maxConsecutiveStoreFailures) {
                  input.triggerShutdown()
                  invokeOnLeaseLost(opts?.onLeaseLost, err.message)
                  return Effect.interrupt
                }
                return Effect.void
              },
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.catchCauseIf(
        (cause) => !isPureInterruptCause(cause),
        (cause) =>
          handleUnexpectedWatcherCause(
            "Workflow writer lease heartbeat failed unexpectedly",
            input.triggerShutdown,
            opts?.onLeaseLost,
            cause,
          ),
      ),
      Effect.forkIn(input.daemonScope),
    )

    yield* input.activeState.lease.waitForFlockLoss.pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.stderr.write(
            "[harness-mcp] OS flock lease lost unexpectedly; shutting down workflow daemon\n",
          )
          input.triggerShutdown()
          invokeOnLeaseLost(opts?.onLeaseLost, "OS flock lock lost")
        }),
      ),
      Effect.catchCauseIf(
        (cause) => !isPureInterruptCause(cause),
        (cause) =>
          handleUnexpectedWatcherCause(
            "OS flock watcher failed unexpectedly",
            input.triggerShutdown,
            opts?.onLeaseLost,
            cause,
          ),
      ),
      Effect.forkIn(input.daemonScope),
    )
  })
