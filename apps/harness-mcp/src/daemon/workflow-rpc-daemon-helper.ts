import { Clock, Effect, Exit, Option, Schema, SynchronizedRef } from "effect"
import { DurableDeferred } from "effect/workflow"
import { match } from "ts-pattern"
import {
  type CompiledPlan,
  type LeaseEpoch,
  SHARED_STEP_UNIT_ID,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowAbortRequest,
  type WorkflowAbortResponse,
  WorkflowDaemonCapability,
  type WorkflowPollBudget,
  WorkflowResumeRequest,
  WorkflowResumeResponse,
  type WorkflowRpcEnvelope,
  type WorkflowRunId,
  WorkflowStartRequest,
  type WorkflowStartResponse,
  type WorkflowStoreAvailabilityState,
  type WorkflowStoreFailureReason,
  WorkflowTimestampMs,
  toBoundedReason,
} from "@harness/contract"
import { HarnessTaskWorkflow, executionIdOf, makeUnitEscalationDeferred } from "@harness/gates"
import {
  assertWorkflowNonTerminal,
  handleDaemonWorkflowCompleteRequest,
  pollExecution,
  waitBoundedUntil,
  waitForWorkflowCompletion,
} from "./workflow-rpc-complete-helper.js"
import {
  type WorkflowRpcHandlerInput,
  decodePlanFromRunStrict,
  inspectActiveUnitCycle,
  isOptionPresent,
  isRunTerminalState,
  isUnitStatus,
  resolveRunTarget,
  rpcError,
  rpcSuccess,
  storeOrLeaseToBoundedReason,
  validateRpcRepoRoot,
  withRunLock,
} from "./workflow-rpc-shared.js"
import {
  handleDaemonWorkflowDoctorRequest,
  handleDaemonWorkflowStatusRpcRequest,
} from "./workflow-rpc-status-helper.js"

export {
  type WorkflowRpcHandlerInput,
  handleDaemonWorkflowCompleteRequest,
  handleDaemonWorkflowDoctorRequest,
  handleDaemonWorkflowStatusRpcRequest,
}

const ABORT_SETTLE_BUDGET: WorkflowPollBudget = {
  maxAttempts: WORKFLOW_TIMEOUT_BUDGETS.abortSettleMaxAttempts,
  intervalMs: WORKFLOW_TIMEOUT_BUDGETS.abortSettleIntervalMs,
}
const START_COMMAND = WorkflowDaemonCapability.make("workflow.start")
const RESUME_COMMAND = WorkflowDaemonCapability.make("workflow.resume")
const ABORT_COMMAND = WorkflowDaemonCapability.make("workflow.abort")

const decodeWorkflowStartRequest = Schema.decodeUnknownEffect(WorkflowStartRequest)
const decodeWorkflowResumeRequest = Schema.decodeUnknownEffect(WorkflowResumeRequest)
const decodeWorkflowAbortRequest = Schema.decodeUnknownEffect(WorkflowAbortRequest)

/** Processes `workflow.start` over daemon Unix socket IPC. */
export const handleDaemonWorkflowStartRequest = Effect.fn("WorkflowRpcDaemon.handleStartRequest")(
  function* (input: WorkflowRpcHandlerInput): Effect.fn.Return<WorkflowRpcEnvelope> {
    const runtime = input.runtime
    if (runtime === undefined) {
      return rpcError(
        input.requestId,
        START_COMMAND,
        "Workflow engine runtime is inactive (no active writer lease)",
      )
    }

    const res = yield* decodeWorkflowStartRequest(input.rawPayload).pipe(
      Effect.mapError((err) => toBoundedReason(err, "Invalid workflow.start request")),
      Effect.flatMap((req) =>
        Effect.gen(function* () {
          yield* validateRpcRepoRoot(req.repoRoot, input.scope)
          yield* match(req.plan.mode)
            .with({ _tag: "Manual" }, () => Effect.void)
            .with({ _tag: "Automatic" }, () =>
              runtime.unitAgentDispatcher.runnerKind === "placeholder"
                ? Effect.fail(
                    toBoundedReason(
                      "Automatic workflow mode is unavailable: WF-5 live agent runners are not yet available (manual mode only in WF-3)",
                    ),
                  )
                : Effect.void,
            )
            .exhaustive()

          const executionId = yield* executionIdOf(req.plan)

          return yield* withRunLock(
            runtime,
            req.plan.runId,
            Effect.gen(function* () {
              const existingRunOpt = yield* runtime.readModelQuery
                .getRun(req.plan.runId)
                .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
              const polledOpt = yield* pollExecution(runtime, executionId)

              const atomicDisposition = yield* SynchronizedRef.modifyEffect(
                runtime.plansRef,
                (
                  plansMap: ReadonlyMap<WorkflowRunId, CompiledPlan>,
                ): Effect.Effect<
                  readonly ["existing" | "start", ReadonlyMap<WorkflowRunId, CompiledPlan>],
                  WorkflowStoreFailureReason
                > => {
                  const cachedPlan = plansMap.get(req.plan.runId)
                  if (cachedPlan !== undefined) {
                    if (cachedPlan.planSha !== req.plan.planSha) {
                      return Effect.fail(
                        toBoundedReason(
                          `Workflow run '${req.plan.runId}' already exists with planSha '${cachedPlan.planSha}', rejecting conflicting planSha '${req.plan.planSha}'`,
                        ),
                      )
                    }
                    return Effect.succeed(["existing", plansMap] as const)
                  }

                  const existingRunMatch = match(existingRunOpt)
                    .with({ _tag: "None" }, () => undefined)
                    .with({ _tag: "Some" }, ({ value: run }) => run)
                    .exhaustive()

                  if (existingRunMatch !== undefined) {
                    if (existingRunMatch.planSha !== req.plan.planSha) {
                      return Effect.fail(
                        toBoundedReason(
                          `Workflow run '${req.plan.runId}' already exists with planSha '${existingRunMatch.planSha}', rejecting conflicting planSha '${req.plan.planSha}'`,
                        ),
                      )
                    }
                    return decodePlanFromRunStrict(existingRunMatch).pipe(
                      Effect.flatMap((decodedExistingPlan) => {
                        if (decodedExistingPlan.planSha !== req.plan.planSha) {
                          return Effect.fail(
                            toBoundedReason(
                              `Workflow run '${req.plan.runId}' stored planJson planSha '${decodedExistingPlan.planSha}' mismatches requested '${req.plan.planSha}'`,
                            ),
                          )
                        }
                        const nextMap: ReadonlyMap<WorkflowRunId, CompiledPlan> = new Map(
                          plansMap,
                        ).set(req.plan.runId, decodedExistingPlan)
                        return Effect.succeed(["existing", nextMap] as const)
                      }),
                    )
                  }

                  if (isOptionPresent(polledOpt)) {
                    return Effect.fail(
                      toBoundedReason(
                        `WorkflowDaemonError: Workflow execution '${executionId}' already exists in Omnigraph engine without a verifiable stored plan; run 'workflow doctor --rebuild-views' before retrying`,
                      ),
                    )
                  }

                  const nextMap: ReadonlyMap<WorkflowRunId, CompiledPlan> = new Map(plansMap).set(
                    req.plan.runId,
                    req.plan,
                  )
                  return Effect.succeed(["start", nextMap] as const)
                },
              )

              return yield* match(atomicDisposition)
                .with("existing", () =>
                  Effect.succeed<WorkflowStartResponse>({
                    runId: req.plan.runId,
                    executionId,
                    outcome: "existing",
                  }),
                )
                .with("start", () =>
                  Effect.gen(function* () {
                    yield* HarnessTaskWorkflow.execute({ plan: req.plan }, { discard: true }).pipe(
                      Effect.provideContext(runtime.workflowContext),
                      Effect.onError(() =>
                        SynchronizedRef.update(runtime.plansRef, (m) => {
                          const next = new Map(m)
                          next.delete(req.plan.runId)
                          return next
                        }),
                      ),
                    )

                    yield* waitBoundedUntil(
                      pollExecution(runtime, executionId).pipe(
                        Effect.map((opt) =>
                          isOptionPresent(opt) ? Option.some(true) : Option.none(),
                        ),
                      ),
                    )

                    return {
                      runId: req.plan.runId,
                      executionId,
                      outcome: "started",
                    } satisfies WorkflowStartResponse
                  }),
                )
                .exhaustive()
            }),
          )
        }),
      ),
      Effect.result,
    )

    return match(res)
      .with({ _tag: "Failure" }, ({ failure }) => rpcError(input.requestId, START_COMMAND, failure))
      .with({ _tag: "Success" }, ({ success: response }) =>
        rpcSuccess(input.requestId, START_COMMAND, response),
      )
      .exhaustive()
  },
)

/** Processes `workflow.resume` (unit escalation resolution or workflow resume) over daemon IPC. */
export const handleDaemonWorkflowResumeRequest = Effect.fn("WorkflowRpcDaemon.handleResumeRequest")(
  function* (input: WorkflowRpcHandlerInput): Effect.fn.Return<WorkflowRpcEnvelope> {
    const runtime = input.runtime
    if (runtime === undefined) {
      return rpcError(
        input.requestId,
        RESUME_COMMAND,
        "Workflow engine runtime is inactive (no active writer lease)",
      )
    }

    const res = yield* decodeWorkflowResumeRequest(input.rawPayload).pipe(
      Effect.mapError((err) => toBoundedReason(err, "Invalid workflow.resume request")),
      Effect.flatMap((req) =>
        Effect.gen(function* () {
          yield* validateRpcRepoRoot(req.repoRoot, input.scope)

          return yield* withRunLock(
            runtime,
            req.runId,
            Effect.gen(function* () {
              const target = yield* resolveRunTarget(runtime, req.runId)
              return yield* match(req)
                .with({ _tag: "ResolveEscalation" }, (resolveReq) =>
                  Effect.gen(function* () {
                    const targetUnitId = resolveReq.unitId
                    const decision = resolveReq.decision
                    yield* assertWorkflowNonTerminal(runtime, target.executionId, target.runId)

                    if (target.plan !== undefined) {
                      const existsInPlan =
                        targetUnitId === SHARED_STEP_UNIT_ID
                          ? target.plan.sharedStepPaths.length > 0
                          : target.plan.units.some((u) => u.unitId === targetUnitId)
                      if (!existsInPlan) {
                        return yield* Effect.fail(
                          toBoundedReason(
                            `Unit '${targetUnitId}' does not belong to workflow run '${target.runId}'`,
                          ),
                        )
                      }
                    }

                    const units = yield* runtime.readModelQuery
                      .listUnits(target.runId)
                      .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
                    const unitRecord = units.find((u) => u.unitId === targetUnitId)
                    if (!isUnitStatus(unitRecord, "escalated")) {
                      return yield* Effect.fail(
                        toBoundedReason(
                          `Unit '${targetUnitId}' is not in 'escalated' state (current: '${unitRecord?.status ?? "missing"}')`,
                        ),
                      )
                    }

                    const cycleState = yield* inspectActiveUnitCycle(
                      runtime.engine,
                      target.executionId,
                      targetUnitId,
                    )
                    const escalationOrdinal = yield* match(cycleState)
                      .with({ _tag: "Aborted" }, () =>
                        Effect.fail(toBoundedReason(`Unit '${targetUnitId}' is already aborted`)),
                      )
                      .with({ _tag: "Active" }, (active) =>
                        Effect.succeed(active.escalationOrdinal),
                      )
                      .exhaustive()

                    const deferred = makeUnitEscalationDeferred(targetUnitId, escalationOrdinal)
                    const token = DurableDeferred.tokenFromExecutionId(deferred, {
                      workflow: HarnessTaskWorkflow,
                      executionId: target.executionId,
                    })
                    yield* DurableDeferred.succeed(deferred, { token, value: { decision } }).pipe(
                      Effect.provideContext(runtime.workflowContext),
                    )

                    yield* match(decision)
                      .with("abort", () =>
                        waitForWorkflowCompletion(
                          runtime,
                          target.executionId,
                          `Timed out waiting for aborted workflow run '${target.runId}' to settle`,
                          ABORT_SETTLE_BUDGET.maxAttempts,
                          ABORT_SETTLE_BUDGET.intervalMs,
                        ),
                      )
                      .with("retry", () =>
                        waitBoundedUntil(
                          Effect.gen(function* () {
                            const updatedUnits = yield* runtime.readModelQuery
                              .listUnits(target.runId)
                              .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
                            const u = updatedUnits.find((item) => item.unitId === targetUnitId)
                            return u !== undefined && !isUnitStatus(u, "escalated")
                              ? Option.some(true as const)
                              : Option.none<true>()
                          }),
                        ).pipe(
                          Effect.flatMap((settled) =>
                            match(settled)
                              .with({ _tag: "Some" }, () => Effect.void)
                              .with({ _tag: "None" }, () =>
                                Effect.fail(
                                  toBoundedReason(
                                    `Timed out waiting for retried unit '${targetUnitId}' to leave escalated state`,
                                  ),
                                ),
                              )
                              .exhaustive(),
                          ),
                        ),
                      )
                      .exhaustive()

                    return WorkflowResumeResponse.cases.EscalationResolved.make({
                      runId: target.runId,
                      executionId: target.executionId,
                      unitId: targetUnitId,
                      decision,
                    })
                  }),
                )
                .with({ _tag: "ResumeRun" }, () =>
                  Effect.gen(function* () {
                    yield* HarnessTaskWorkflow.resume(target.executionId).pipe(
                      Effect.provideContext(runtime.workflowContext),
                    )
                    return WorkflowResumeResponse.cases.WorkflowResumed.make({
                      runId: target.runId,
                      executionId: target.executionId,
                    })
                  }),
                )
                .exhaustive()
            }),
          )
        }),
      ),
      Effect.result,
    )

    return match(res)
      .with({ _tag: "Failure" }, ({ failure }) =>
        rpcError(input.requestId, RESUME_COMMAND, failure),
      )
      .with({ _tag: "Success" }, ({ success: response }) =>
        rpcSuccess(input.requestId, RESUME_COMMAND, response),
      )
      .exhaustive()
  },
)

/** Processes `workflow.abort` over daemon Unix socket IPC. */
export const handleDaemonWorkflowAbortRequest = Effect.fn("WorkflowRpcDaemon.handleAbortRequest")(
  function* (input: WorkflowRpcHandlerInput): Effect.fn.Return<WorkflowRpcEnvelope> {
    const runtime = input.runtime
    if (runtime === undefined) {
      return rpcError(
        input.requestId,
        ABORT_COMMAND,
        "Workflow engine runtime is inactive (no active writer lease)",
      )
    }

    const res = yield* decodeWorkflowAbortRequest(input.rawPayload).pipe(
      Effect.mapError((err) => toBoundedReason(err, "Invalid workflow.abort request")),
      Effect.flatMap((req) =>
        Effect.gen(function* () {
          yield* validateRpcRepoRoot(req.repoRoot, input.scope)
          return yield* withRunLock(
            runtime,
            req.runId,
            Effect.gen(function* () {
              const target = yield* resolveRunTarget(runtime, req.runId)
              const initialPoll = yield* pollExecution(runtime, target.executionId)
              const needsInterrupt = match(initialPoll)
                .with({ _tag: "None" }, () => true)
                .with({ _tag: "Some" }, ({ value }) =>
                  match(value)
                    .with({ _tag: "Suspended" }, () => true)
                    .with({ _tag: "Complete" }, () => false)
                    .exhaustive(),
                )
                .exhaustive()

              if (needsInterrupt) {
                yield* HarnessTaskWorkflow.interrupt(target.executionId).pipe(
                  Effect.provideContext(runtime.workflowContext),
                )
                yield* waitForWorkflowCompletion(
                  runtime,
                  target.executionId,
                  `Timed out waiting for workflow run '${target.runId}' interrupt to reach terminal state`,
                  ABORT_SETTLE_BUDGET.maxAttempts,
                  ABORT_SETTLE_BUDGET.intervalMs,
                )
              }

              const finalPoll = yield* pollExecution(runtime, target.executionId)
              const terminalState = yield* match(finalPoll)
                .with({ _tag: "None" }, () =>
                  Effect.fail(
                    toBoundedReason(
                      `Workflow run '${target.runId}' did not reach a terminal state after interrupt`,
                    ),
                  ),
                )
                .with({ _tag: "Some" }, ({ value }) =>
                  match(value)
                    .with({ _tag: "Suspended" }, () =>
                      Effect.fail(
                        toBoundedReason(
                          `Workflow run '${target.runId}' remained suspended after interrupt`,
                        ),
                      ),
                    )
                    .with({ _tag: "Complete" }, ({ exit }) =>
                      Effect.succeed(
                        Exit.match(exit, {
                          onSuccess: () => "completed" as const,
                          onFailure: () => "aborted" as const,
                        }),
                      ),
                    )
                    .exhaustive(),
                )
                .exhaustive()

              return yield* match(terminalState)
                .with("completed", () =>
                  Effect.succeed<WorkflowAbortResponse>({
                    runId: target.runId,
                    executionId: target.executionId,
                    state: "completed",
                  }),
                )
                .with("aborted", () =>
                  Effect.gen(function* () {
                    const runOpt = yield* runtime.readModelQuery
                      .getRun(target.runId)
                      .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
                    yield* match(runOpt)
                      .with({ _tag: "None" }, () => Effect.void)
                      .with({ _tag: "Some" }, ({ value: run }) =>
                        isRunTerminalState(run.state)
                          ? Effect.void
                          : Clock.currentTimeMillis.pipe(
                              Effect.flatMap((millis) =>
                                runtime.projectionWriter
                                  .upsertRun({
                                    ...run,
                                    state: "aborted",
                                    updatedMs: WorkflowTimestampMs.make(
                                      Math.max(0, Math.floor(millis)),
                                    ),
                                  })
                                  .pipe(Effect.mapError(storeOrLeaseToBoundedReason)),
                              ),
                            ),
                      )
                      .exhaustive()

                    return {
                      runId: target.runId,
                      executionId: target.executionId,
                      state: "aborted",
                    } satisfies WorkflowAbortResponse
                  }),
                )
                .exhaustive()
            }),
          )
        }),
      ),
      Effect.result,
    )

    return match(res)
      .with({ _tag: "Failure" }, ({ failure }) => rpcError(input.requestId, ABORT_COMMAND, failure))
      .with({ _tag: "Success" }, ({ success: response }) =>
        rpcSuccess(input.requestId, ABORT_COMMAND, response),
      )
      .exhaustive()
  },
)

/** Summarizes current store connectivity for MCP/RPC diagnostics. */
export const summarizeWorkflowStoreState = (
  writerLeaseEpoch: LeaseEpoch | undefined,
): WorkflowStoreAvailabilityState =>
  writerLeaseEpoch !== undefined && writerLeaseEpoch >= 1 ? "ready" : "inactive"
