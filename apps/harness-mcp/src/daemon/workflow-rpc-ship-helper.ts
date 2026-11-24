import { join } from "node:path"
import { Cause, Duration, Effect, Exit, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  MutationRestoreError,
  type PlanSha256,
  type ShipAttempt,
  ShipGateFailedError,
  type ShipRunOrigin,
  type ShipStageProgress,
  type ShipStreamProgressEvent,
  ShipTreeDriftError,
  ShipTreeMismatchError,
  type ShipWorkflowError,
  type ShipWorkflowPayload,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowDaemonCapability,
  type WorkflowExecutionId,
  type WorkflowRpcEnvelope,
  WorkflowRunId,
  WorkflowShipOutcome,
  WorkflowShipRequest,
  type WorkflowShipResponse,
  type WorkflowStoreFailureReason,
  type WorkflowTimeoutMs,
  type WorkspaceTreeHash,
  isPureInterruptCause,
  toBoundedReason,
} from "@harness/contract"
import {
  ShipWorkflow,
  computeWorkspaceTreeHashChecked,
  recoverStartupBackup,
  shipExecutionIdOf,
} from "@harness/gates"
import { ShipAttemptStore, type ShipAttemptStoreShape } from "@harness/service"
import type { SyncHostIo } from "@harness/service/host-io"
import type { WorkflowDaemonRuntime } from "./workflow-engine-daemon-helper.js"
import { waitBoundedUntil } from "./workflow-rpc-complete-helper.js"
import {
  type WorkflowRpcHandlerInput,
  rpcError,
  rpcSuccess,
  storeOrLeaseToBoundedReason,
  toWorkflowRpcRequestId,
  validateRpcRepoRoot,
  withRunLock,
  withWorktreeShipLock,
} from "./workflow-rpc-shared.js"

export interface WorkflowShipRpcHandlerInput extends WorkflowRpcHandlerInput {
  readonly emitLine?: ((line: string) => void) | undefined
  readonly settleTimeoutMs?: WorkflowTimeoutMs | undefined
}

const SHIP_COMMAND = WorkflowDaemonCapability.make("workflow.ship")
const decodeWorkflowShipRequest = Schema.decodeUnknownEffect(WorkflowShipRequest)

const makeCleanTreeHashHostIo = (
  hostIo: SyncHostIo,
  baseEnv: Readonly<Record<string, string | undefined>>,
): SyncHostIo => {
  const nextEnv: Record<string, string | undefined> = { ...baseEnv }
  Reflect.deleteProperty(nextEnv, "HARNESS_WORKTREE_ID")
  Reflect.deleteProperty(nextEnv, "HARNESS_STATE_DIR")
  return { ...hostIo, getEnv: () => nextEnv }
}

const asShipWorkflowError = (err: unknown): ShipWorkflowError | undefined => {
  if (
    err instanceof ShipGateFailedError ||
    err instanceof ShipTreeMismatchError ||
    err instanceof MutationRestoreError ||
    err instanceof ShipTreeDriftError
  ) {
    return err
  }
  return undefined
}

export const resolveShipRunTarget = Effect.fn("WorkflowRpcDaemon.resolveShipRunTarget")(function* (
  requestedRunId: WorkflowRunId | undefined,
  treeHash: WorkspaceTreeHash,
  readModelQuery: NonNullable<WorkflowRpcHandlerInput["runtime"]>["readModelQuery"],
): Effect.fn.Return<
  {
    readonly runId: WorkflowRunId
    readonly planSha?: PlanSha256 | undefined
    readonly runOrigin: ShipRunOrigin
  },
  WorkflowStoreFailureReason
> {
  if (requestedRunId === undefined) {
    return {
      runId: WorkflowRunId.make(`ship-${treeHash.slice(0, 12)}`),
      runOrigin: "ephemeral",
    }
  }
  const runOpt = yield* readModelQuery
    .getRun(requestedRunId)
    .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
  return yield* match(runOpt)
    .with({ _tag: "None" }, () =>
      Effect.fail(toBoundedReason(`Workflow run '${requestedRunId}' not found`)),
    )
    .with({ _tag: "Some" }, ({ value: run }) =>
      match(run.state)
        .with("completed", () =>
          Effect.succeed({
            runId: run.runId,
            planSha: run.planSha,
            runOrigin: "compiled" as const,
          }),
        )
        .with("running", "waiting", "aborted", (state) =>
          Effect.fail(
            toBoundedReason(
              `Workflow run '${run.runId}' is '${state}', expected 'completed' before shipping`,
            ),
          ),
        )
        .exhaustive(),
    )
    .exhaustive()
})

const ABORT_SETTLE_BUDGET_MS =
  WORKFLOW_TIMEOUT_BUDGETS.abortSettleMaxAttempts * WORKFLOW_TIMEOUT_BUDGETS.abortSettleIntervalMs

const recordFailedAttemptStatusAndFail = (
  attemptStore: ShipAttemptStoreShape,
  runId: WorkflowRunId,
  attempt: ShipAttempt,
  failureReason: WorkflowStoreFailureReason,
): Effect.Effect<never, WorkflowStoreFailureReason> =>
  attemptStore.updateStatus({ runId, attempt, status: "failed" }).pipe(
    Effect.tapError((err) =>
      Effect.logWarning("Failed to record failed WfShipAttempt status", err),
    ),
    Effect.ignore,
    Effect.andThen(Effect.fail(failureReason)),
  )

const EARLY_ABORT_POLL_MAX_ATTEMPTS = 5

const interruptAndSettleShipAttempt = (input: {
  readonly runtime: WorkflowDaemonRuntime
  readonly attemptStore: ShipAttemptStoreShape
  readonly executionId: WorkflowExecutionId
  readonly runId: WorkflowRunId
  readonly attempt: ShipAttempt
  readonly listenerKey: string
  readonly sawProgressEvent: boolean
}): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      yield* ShipWorkflow.interrupt(input.executionId).pipe(
        Effect.provideContext(input.runtime.shipWorkflowContext),
        Effect.tapError((err) =>
          Effect.logWarning("Failed to interrupt timed-out ShipWorkflow execution", err),
        ),
        Effect.ignore,
      )

      yield* input.runtime.shipGateController.cancelAndAwait(input.listenerKey).pipe(
        Effect.timeoutOption(Duration.millis(ABORT_SETTLE_BUDGET_MS)),
        Effect.tap((settledOpt) =>
          match(settledOpt)
            .with({ _tag: "Some" }, () => Effect.void)
            .with({ _tag: "None" }, () =>
              Effect.logWarning(
                `Timed out after ${ABORT_SETTLE_BUDGET_MS}ms waiting for active ShipWorkflow gate '${input.listenerKey}' to cancel and exit`,
              ),
            )
            .exhaustive(),
        ),
        Effect.ignore,
      )

      const pollExecution = ShipWorkflow.poll(input.executionId).pipe(
        Effect.provideContext(input.runtime.shipWorkflowContext),
        Effect.map((polled) =>
          match(polled)
            .with({ _tag: "None" }, () => Option.none<true>())
            .with({ _tag: "Some" }, ({ value }) =>
              match(value)
                .with({ _tag: "Complete" }, () => Option.some(true as const))
                .with({ _tag: "Suspended" }, () => Option.none<true>())
                .exhaustive(),
            )
            .exhaustive(),
        ),
      )

      const initialPolled = yield* ShipWorkflow.poll(input.executionId).pipe(
        Effect.provideContext(input.runtime.shipWorkflowContext),
        Effect.result,
      )
      const hasInitialReply = match(initialPolled)
        .with({ _tag: "Success" }, ({ success }) => Option.isSome(success))
        .with({ _tag: "Failure" }, () => true)
        .exhaustive()
      const pollMaxAttempts =
        input.sawProgressEvent || hasInitialReply
          ? WORKFLOW_TIMEOUT_BUDGETS.abortSettleMaxAttempts
          : EARLY_ABORT_POLL_MAX_ATTEMPTS

      yield* waitBoundedUntil(
        pollExecution,
        pollMaxAttempts,
        WORKFLOW_TIMEOUT_BUDGETS.abortSettleIntervalMs,
      ).pipe(
        Effect.tap((polledOpt) =>
          match(polledOpt)
            .with({ _tag: "Some" }, () => Effect.void)
            .with({ _tag: "None" }, () =>
              Effect.logWarning(
                `Timed out waiting for interrupted ShipWorkflow execution '${input.executionId}' to settle`,
              ),
            )
            .exhaustive(),
        ),
        Effect.tapError((err) =>
          Effect.logWarning("Failed to poll interrupted ShipWorkflow execution", err),
        ),
        Effect.ignore,
      )

      yield* input.attemptStore
        .updateStatus({
          runId: input.runId,
          attempt: input.attempt,
          status: "failed",
        })
        .pipe(
          Effect.tapError((err) =>
            Effect.logWarning("Failed to record failed WfShipAttempt status", err),
          ),
          Effect.ignore,
        )

      input.runtime.shipProgressListeners.delete(input.listenerKey)
      input.runtime.shipGateController.clear(input.listenerKey)
    }),
  )

/** Processes streaming `workflow.ship` over daemon Unix socket IPC. */
export const handleDaemonWorkflowShipRequest = Effect.fn("WorkflowRpcDaemon.handleShipRequest")(
  function* (input: WorkflowShipRpcHandlerInput): Effect.fn.Return<WorkflowRpcEnvelope> {
    const rpcRequestId = toWorkflowRpcRequestId(input.requestId)
    const runtime = input.runtime
    if (runtime === undefined) {
      return rpcError(
        rpcRequestId,
        SHIP_COMMAND,
        "Workflow engine runtime is inactive (no active writer lease)",
      )
    }
    const { shipWorkflowContext, shipAttemptStore, shipProgressListeners } = runtime
    const settleTimeoutMs =
      input.settleTimeoutMs !== undefined
        ? Math.min(input.settleTimeoutMs, WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowSettleMs)
        : WORKFLOW_TIMEOUT_BUDGETS.shipWorkflowSettleMs

    const res = yield* decodeWorkflowShipRequest(input.rawPayload).pipe(
      Effect.mapError((err) => toBoundedReason(err, "Invalid workflow.ship request")),
      Effect.flatMap((req) =>
        Effect.gen(function* () {
          const validated = yield* validateRpcRepoRoot(req.repoRoot, input.scope)
          return yield* withWorktreeShipLock(
            runtime,
            validated.worktreeRoot,
            Effect.gen(function* () {
              const hashIo = makeCleanTreeHashHostIo(
                runtime.hostIo,
                runtime.env ?? runtime.hostIo.getEnv(),
              )
              const backupDiag = recoverStartupBackup(
                validated.worktreeRoot,
                join(validated.worktreeRoot, ".harness", "mutation-backup.json"),
                hashIo,
              )
              if (backupDiag !== undefined) {
                return yield* Effect.fail(toBoundedReason(backupDiag))
              }
              const treeHash = yield* match(
                computeWorkspaceTreeHashChecked(validated.worktreeRoot, hashIo),
              )
                .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
                .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(toBoundedReason(failure)))
                .exhaustive()

              const target = yield* resolveShipRunTarget(
                req.runId,
                treeHash,
                runtime.readModelQuery,
              )

              return yield* withRunLock(
                runtime,
                target.runId,
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const attemptStore = yield* ShipAttemptStore
                    const allocated = yield* restore(
                      attemptStore
                        .allocateAttempt({ runId: target.runId, treeHash })
                        .pipe(Effect.mapError(storeOrLeaseToBoundedReason)),
                    )

                    const stages: Array<ShipStageProgress> = []
                    const listenerKey = `${target.runId}:${allocated.attempt}`
                    const payload: ShipWorkflowPayload = {
                      runId: target.runId,
                      treeHash,
                      attempt: allocated.attempt,
                      repoRoot: validated.worktreeRoot,
                      ...(target.planSha !== undefined ? { planSha: target.planSha } : {}),
                    }
                    const executionId = yield* shipExecutionIdOf(payload)
                    let settleHandled = false
                    let sawProgressEvent = false

                    shipProgressListeners.set(listenerKey, (event: ShipStreamProgressEvent) => {
                      sawProgressEvent = true
                      match(event)
                        .with({ _tag: "StageStarted" }, () => {})
                        .with({ _tag: "StageFinished" }, ({ progress }) => {
                          stages.push(progress)
                        })
                        .exhaustive()
                      input.emitLine?.(
                        JSON.stringify({ id: rpcRequestId, kind: "progress", event }),
                      )
                    })

                    const execExit = yield* Effect.exit(
                      restore(
                        ShipWorkflow.execute(payload).pipe(
                          Effect.provideContext(shipWorkflowContext),
                          Effect.timeoutOption(Duration.millis(settleTimeoutMs)),
                        ),
                      ),
                    )

                    const settleAndCleanup = (): Effect.Effect<void> => {
                      if (settleHandled) {
                        return Effect.void
                      }
                      settleHandled = true
                      return interruptAndSettleShipAttempt({
                        runtime,
                        attemptStore,
                        executionId,
                        runId: target.runId,
                        attempt: allocated.attempt,
                        listenerKey,
                        sawProgressEvent,
                      })
                    }

                    return yield* Exit.match(execExit, {
                      onSuccess: (receiptOpt) =>
                        match(receiptOpt)
                          .with({ _tag: "Some" }, ({ value: receipt }) => {
                            shipProgressListeners.delete(listenerKey)
                            runtime.shipGateController.clear(listenerKey)
                            return attemptStore
                              .updateStatus({
                                runId: target.runId,
                                attempt: allocated.attempt,
                                status: "passed",
                              })
                              .pipe(
                                Effect.mapError(storeOrLeaseToBoundedReason),
                                Effect.as<WorkflowShipResponse>({
                                  runId: target.runId,
                                  attempt: allocated.attempt,
                                  executionId,
                                  treeHash,
                                  runOrigin: target.runOrigin,
                                  outcome: WorkflowShipOutcome.cases.Passed.make({
                                    receipt,
                                    stages,
                                  }),
                                }),
                              )
                          })
                          .with({ _tag: "None" }, () =>
                            settleAndCleanup().pipe(
                              Effect.andThen(
                                Effect.fail(
                                  toBoundedReason(
                                    `Ship workflow '${target.runId}' timed out after ${settleTimeoutMs}ms`,
                                  ),
                                ),
                              ),
                            ),
                          )
                          .exhaustive(),
                      onFailure: (cause) => {
                        if (isPureInterruptCause(cause)) {
                          return settleAndCleanup().pipe(Effect.andThen(Effect.interrupt))
                        }
                        shipProgressListeners.delete(listenerKey)
                        runtime.shipGateController.clear(listenerKey)
                        return match(Cause.findErrorOption(cause))
                          .with({ _tag: "Some" }, ({ value: err }) => {
                            const shipError = asShipWorkflowError(err)
                            if (shipError !== undefined) {
                              return attemptStore
                                .updateStatus({
                                  runId: target.runId,
                                  attempt: allocated.attempt,
                                  status: "failed",
                                })
                                .pipe(
                                  Effect.mapError(storeOrLeaseToBoundedReason),
                                  Effect.as<WorkflowShipResponse>({
                                    runId: target.runId,
                                    attempt: allocated.attempt,
                                    executionId,
                                    treeHash,
                                    runOrigin: target.runOrigin,
                                    outcome: WorkflowShipOutcome.cases.Failed.make({
                                      runId: target.runId,
                                      attempt: allocated.attempt,
                                      treeHash,
                                      stages,
                                      error: shipError,
                                    }),
                                  }),
                                )
                            }
                            return recordFailedAttemptStatusAndFail(
                              attemptStore,
                              target.runId,
                              allocated.attempt,
                              toBoundedReason(
                                Cause.pretty(cause),
                                "Ship workflow failed unexpectedly",
                              ),
                            )
                          })
                          .with({ _tag: "None" }, () =>
                            recordFailedAttemptStatusAndFail(
                              attemptStore,
                              target.runId,
                              allocated.attempt,
                              toBoundedReason(
                                Cause.pretty(cause),
                                "Ship workflow failed unexpectedly",
                              ),
                            ),
                          )
                          .exhaustive()
                      },
                    })
                  }).pipe(Effect.provideService(ShipAttemptStore, shipAttemptStore)),
                ),
              )
            }),
          )
        }),
      ),
      Effect.result,
    )

    return match(res)
      .with({ _tag: "Failure" }, ({ failure }) => rpcError(rpcRequestId, SHIP_COMMAND, failure))
      .with({ _tag: "Success" }, ({ success: response }) =>
        rpcSuccess(rpcRequestId, SHIP_COMMAND, response),
      )
      .exhaustive()
  },
)
