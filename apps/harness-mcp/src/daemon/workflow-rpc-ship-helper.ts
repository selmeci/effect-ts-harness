import { join } from "node:path"
import { Cause, Duration, Effect, Exit, Schema } from "effect"
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
    if (
      shipWorkflowContext === undefined ||
      shipAttemptStore === undefined ||
      shipProgressListeners === undefined
    ) {
      return rpcError(rpcRequestId, SHIP_COMMAND, "Workflow ship runtime services are inactive")
    }
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
                Effect.gen(function* () {
                  const attemptStore = yield* ShipAttemptStore
                  const allocated = yield* attemptStore
                    .allocateAttempt({ runId: target.runId, treeHash })
                    .pipe(Effect.mapError(storeOrLeaseToBoundedReason))

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

                  const execExit = yield* Effect.acquireUseRelease(
                    Effect.sync(() => {
                      shipProgressListeners.set(listenerKey, (event: ShipStreamProgressEvent) => {
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
                    }),
                    () =>
                      ShipWorkflow.execute(payload).pipe(
                        Effect.provideContext(shipWorkflowContext),
                        Effect.timeoutOption(Duration.millis(settleTimeoutMs)),
                      ),
                    () =>
                      Effect.sync(() => {
                        shipProgressListeners.delete(listenerKey)
                      }),
                  ).pipe(Effect.exit)

                  return yield* Exit.match(execExit, {
                    onSuccess: (receiptOpt) =>
                      match(receiptOpt)
                        .with({ _tag: "Some" }, ({ value: receipt }) =>
                          attemptStore
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
                            ),
                        )
                        .with({ _tag: "None" }, () =>
                          ShipWorkflow.interrupt(executionId).pipe(
                            Effect.provideContext(shipWorkflowContext),
                            Effect.tapError((err) =>
                              Effect.logWarning(
                                "Failed to interrupt timed-out ShipWorkflow execution",
                                err,
                              ),
                            ),
                            Effect.ignore,
                            Effect.andThen(
                              recordFailedAttemptStatusAndFail(
                                attemptStore,
                                target.runId,
                                allocated.attempt,
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
                        return Effect.interrupt
                      }
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
