import { Effect, Option, Schema } from "effect"
import { DurableDeferred } from "effect/workflow"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  AttemptNumber,
  type CompiledPlan,
  type LlmPhaseReceipt,
  SHARED_STEP_UNIT_ID,
  type UnitOutcome,
  WORKFLOW_TIMEOUT_BUDGETS,
  type WorkUnitId,
  WorkflowCompleteRequest,
  WorkflowCompleteResponse,
  WorkflowDaemonCapability,
  type WorkflowExecutionId,
  type WorkflowPollAttempts,
  type WorkflowPollBudget,
  type WorkflowRpcEnvelope,
  type WorkflowStoreFailureReason,
  type WorkflowTimeoutMs,
  toBoundedReason,
} from "@harness/contract"
import {
  HarnessTaskWorkflow,
  LlmPhaseDone,
  computeWorkspaceTreeHashChecked,
  makeUnitCompletionDeferred,
} from "@harness/gates"
import type { WorkflowDaemonRuntime } from "./workflow-engine-daemon-helper.js"
import {
  assertFrictionLogCleared,
  hasCompletedOutcome,
  hostIoWithEnv,
  validateUnitCompletionCwd,
} from "./workflow-rpc-complete-validation.js"
import {
  type WorkflowRpcHandlerInput,
  checkDeferredResult,
  inspectActiveUnitCycle,
  isOptionPresent,
  isUnitStatus,
  resolveRunTarget,
  rpcError,
  rpcSuccess,
  storeOrLeaseToBoundedReason,
  validateRpcRepoRoot,
  withRunLock,
} from "./workflow-rpc-shared.js"

const POLL_SETTLE_BUDGET: WorkflowPollBudget = {
  maxAttempts: WORKFLOW_TIMEOUT_BUDGETS.pollSettleMaxAttempts,
  intervalMs: WORKFLOW_TIMEOUT_BUDGETS.pollSettleIntervalMs,
}
const COMPLETE_COMMAND = WorkflowDaemonCapability.make("workflow.complete")

const decodeWorkflowCompleteRequest = Schema.decodeUnknownEffect(WorkflowCompleteRequest)

export const waitBoundedUntil = <A, E = never>(
  check: Effect.Effect<Option.Option<A>, E>,
  maxAttempts: WorkflowPollAttempts | number = POLL_SETTLE_BUDGET.maxAttempts,
  intervalMs: WorkflowTimeoutMs | number = POLL_SETTLE_BUDGET.intervalMs,
): Effect.Effect<Option.Option<A>, E> =>
  Effect.gen(function* () {
    for (let i = 0; i < maxAttempts; i += 1) {
      const res = yield* check
      const found = match(res)
        .with({ _tag: "Some" }, () => true)
        .with({ _tag: "None" }, () => false)
        .exhaustive()
      if (found) {
        return res
      }
      if (i < maxAttempts - 1) {
        yield* Effect.sleep(intervalMs)
      }
    }
    return Option.none<A>()
  })

export const pollExecution = (runtime: WorkflowDaemonRuntime, executionId: WorkflowExecutionId) =>
  HarnessTaskWorkflow.poll(executionId).pipe(Effect.provideContext(runtime.workflowContext))

export const waitForWorkflowCompletion = (
  runtime: WorkflowDaemonRuntime,
  executionId: WorkflowExecutionId,
  timeoutMessage: string,
  maxAttempts: WorkflowPollAttempts | number = POLL_SETTLE_BUDGET.maxAttempts,
  intervalMs: WorkflowTimeoutMs | number = POLL_SETTLE_BUDGET.intervalMs,
): Effect.Effect<void, WorkflowStoreFailureReason> =>
  waitBoundedUntil(
    pollExecution(runtime, executionId).pipe(
      Effect.map((opt) =>
        match(opt)
          .with({ _tag: "None" }, () => Option.none<true>())
          .with({ _tag: "Some" }, ({ value }) =>
            match(value)
              .with({ _tag: "Complete" }, () => Option.some(true as const))
              .with({ _tag: "Suspended" }, () => Option.none<true>())
              .exhaustive(),
          )
          .exhaustive(),
      ),
    ),
    maxAttempts,
    intervalMs,
  ).pipe(
    Effect.flatMap((res) =>
      match(res)
        .with({ _tag: "Some" }, () => Effect.void)
        .with({ _tag: "None" }, () => Effect.fail(toBoundedReason(timeoutMessage)))
        .exhaustive(),
    ),
  )

export const assertWorkflowNonTerminal = (
  runtime: WorkflowDaemonRuntime,
  executionId: WorkflowExecutionId,
  runId: string,
): Effect.Effect<void, WorkflowStoreFailureReason> =>
  pollExecution(runtime, executionId).pipe(
    Effect.flatMap((polledOpt) =>
      match(polledOpt)
        .with({ _tag: "None" }, () => Effect.void)
        .with({ _tag: "Some" }, ({ value: wfResult }) =>
          match(wfResult)
            .with({ _tag: "Suspended" }, () => Effect.void)
            .with({ _tag: "Complete" }, () =>
              Effect.fail(
                toBoundedReason(`Workflow run '${runId}' is already in a terminal state`),
              ),
            )
            .exhaustive(),
        )
        .exhaustive(),
    ),
  )

const completeUnitInRuntime = (
  runtime: WorkflowDaemonRuntime,
  validatedCwd: AbsoluteRepoRoot,
  plan: CompiledPlan,
  executionId: WorkflowExecutionId,
  unitId: WorkUnitId,
): Effect.Effect<UnitOutcome, WorkflowStoreFailureReason> =>
  Effect.gen(function* () {
    yield* validateUnitCompletionCwd(runtime, validatedCwd, plan, unitId)

    const units = yield* runtime.readModelQuery
      .listUnits(plan.runId)
      .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
    const currentUnitRecord = units.find((u) => u.unitId === unitId)
    if (currentUnitRecord === undefined) {
      return yield* Effect.fail(
        toBoundedReason(`Unit '${unitId}' has not been projected for run '${plan.runId}'`),
      )
    }
    yield* match(currentUnitRecord.status)
      .with("dispatched", () => Effect.void)
      .with("pending", () =>
        Effect.fail(toBoundedReason(`Unit '${unitId}' is still 'pending' and not yet dispatched`)),
      )
      .with("completed", () =>
        Effect.fail(toBoundedReason(`Unit '${unitId}' is already completed`)),
      )
      .with("escalated", () =>
        Effect.fail(
          toBoundedReason(
            `Unit '${unitId}' is escalated and awaiting workflow.resume (--decision retry|abort)`,
          ),
        ),
      )
      .exhaustive()

    const cycleState = yield* inspectActiveUnitCycle(runtime.engine, executionId, unitId)
    const activeCycle = yield* match(cycleState)
      .with({ _tag: "Aborted" }, () =>
        Effect.fail(toBoundedReason(`Unit '${unitId}' was already aborted`)),
      )
      .with({ _tag: "Active" }, (active) => Effect.succeed(active))
      .exhaustive()

    if (hasCompletedOutcome(activeCycle.attemptOutcomes)) {
      return yield* Effect.fail(toBoundedReason(`Unit '${unitId}' is already completed`))
    }

    const openEntry = activeCycle.attemptOutcomes.find((item) => !isOptionPresent(item.outcome))
    if (openEntry === undefined) {
      return yield* Effect.fail(
        toBoundedReason(
          `Unit '${unitId}' exhausted 3 attempts in escalation cycle ${activeCycle.escalationOrdinal}; resolve via workflow.resume`,
        ),
      )
    }
    const activeAttempt = openEntry.attempt
    const completedUnitIds = new Set(
      units.filter((u) => isUnitStatus(u, "completed")).map((u) => u.unitId),
    )

    const outcome =
      unitId === SHARED_STEP_UNIT_ID
        ? yield* Effect.gen(function* () {
            const [firstPath, ...restPaths] = plan.sharedStepPaths
            if (firstPath === undefined) {
              return yield* Effect.fail(
                toBoundedReason(`Workflow run '${plan.runId}' has no sharedStepPaths`),
              )
            }
            if (plan.units.some((u) => !completedUnitIds.has(u.unitId))) {
              return yield* Effect.fail(
                toBoundedReason(
                  `Cannot complete '${SHARED_STEP_UNIT_ID}' before all unit waves complete`,
                ),
              )
            }
            return yield* runtime.unitVerifier
              .completeSharedStep({
                runId: plan.runId,
                baseSha: plan.baseSha,
                sharedStepPaths: [firstPath, ...restPaths],
                priorUnitOwnedPaths: plan.units.flatMap((u) => u.ownedRelPaths),
                attempt: activeAttempt,
                cwd: validatedCwd,
              })
              .pipe(Effect.mapError((err) => toBoundedReason(err.message)))
          })
        : yield* Effect.gen(function* () {
            const unit = plan.units.find((u) => u.unitId === unitId)
            if (unit === undefined) {
              return yield* Effect.fail(
                toBoundedReason(`Unit '${unitId}' not found in workflow run '${plan.runId}'`),
              )
            }
            if (
              plan.units.some(
                (other) => other.waveIndex < unit.waveIndex && !completedUnitIds.has(other.unitId),
              )
            ) {
              return yield* Effect.fail(
                toBoundedReason(
                  `Cannot complete unit '${unitId}' in wave ${unit.waveIndex} while earlier wave units remain incomplete`,
                ),
              )
            }
            const siblingInFlightOwnedPaths = match(plan.level)
              .with("epic", () => [])
              .with("slice", () =>
                plan.units
                  .filter(
                    (other) => other.unitId !== unit.unitId && other.waveIndex <= unit.waveIndex,
                  )
                  .flatMap((other) => other.ownedRelPaths),
              )
              .exhaustive()

            return yield* runtime.unitVerifier
              .completeUnit({
                runId: plan.runId,
                level: plan.level,
                baseSha: plan.baseSha,
                unit,
                attempt: activeAttempt,
                cwd: validatedCwd,
                siblingInFlightOwnedPaths,
              })
              .pipe(Effect.mapError((err) => toBoundedReason(err.message)))
          })

    const deferred = makeUnitCompletionDeferred(
      unitId,
      activeAttempt,
      activeCycle.escalationOrdinal,
    )
    const token = DurableDeferred.tokenFromExecutionId(deferred, {
      workflow: HarnessTaskWorkflow,
      executionId,
    })
    yield* DurableDeferred.succeed(deferred, { token, value: outcome }).pipe(
      Effect.provideContext(runtime.workflowContext),
    )

    const settled = yield* waitBoundedUntil(
      Effect.gen(function* () {
        const persisted = yield* checkDeferredResult(runtime.engine, executionId, deferred)
        if (!isOptionPresent(persisted)) {
          return Option.none()
        }
        const updatedUnits = yield* runtime.readModelQuery
          .listUnits(plan.runId)
          .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
        const updatedUnit = updatedUnits.find((u) => u.unitId === unitId)
        const expectedStatus = match(outcome)
          .with({ _tag: "Completed" }, () => "completed" as const)
          .with({ _tag: "Escalated" }, () => "escalated" as const)
          .with({ _tag: "Rejected" }, () =>
            activeAttempt >= AttemptNumber.make(3) ? ("escalated" as const) : undefined,
          )
          .exhaustive()
        return yield* match(expectedStatus)
          .with("completed", () =>
            Effect.gen(function* () {
              if (!isUnitStatus(updatedUnit, "completed")) {
                return Option.none<true>()
              }
              const hasNextActive = updatedUnits.some(
                (u) => isUnitStatus(u, "dispatched") || isUnitStatus(u, "escalated"),
              )
              if (hasNextActive) {
                return Option.some(true as const)
              }
              const allUnitsDone = updatedUnits.every((u) => isUnitStatus(u, "completed"))
              if (!allUnitsDone) {
                return Option.none<true>()
              }
              const runOpt = yield* runtime.readModelQuery
                .getRun(plan.runId)
                .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
              return match(runOpt)
                .with({ _tag: "None" }, () => Option.none<true>())
                .with({ _tag: "Some" }, ({ value: run }) =>
                  match(run.state)
                    .with("waiting", "completed", "aborted", () => Option.some(true as const))
                    .with("running", () => Option.none<true>())
                    .exhaustive(),
                )
                .exhaustive()
            }),
          )
          .with("escalated", () =>
            Effect.succeed(
              isUnitStatus(updatedUnit, "escalated")
                ? Option.some(true as const)
                : Option.none<true>(),
            ),
          )
          .with(undefined, () =>
            Effect.gen(function* () {
              const updatedAttempts = yield* runtime.readModelQuery
                .listAttempts(plan.runId)
                .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
              const nextAttempt = AttemptNumber.make(activeAttempt + 1)
              const nextDispatched = updatedAttempts.some(
                (a) =>
                  a.unitId === unitId &&
                  a.attempt === nextAttempt &&
                  match(a.verdict)
                    .with("dispatched", () => true)
                    .with("completed", "rejected", () => false)
                    .exhaustive(),
              )
              return nextDispatched ? Option.some(true as const) : Option.none<true>()
            }),
          )
          .exhaustive()
      }),
    )

    yield* match(settled)
      .with({ _tag: "Some" }, () => Effect.void)
      .with({ _tag: "None" }, () =>
        Effect.fail(
          toBoundedReason(`Timed out waiting for unit '${unitId}' completion projection to settle`),
        ),
      )
      .exhaustive()

    return outcome
  })

/** Processes `workflow.complete` (`CompleteUnit` or `CompleteLlmPhase`) over daemon IPC. */
export const handleDaemonWorkflowCompleteRequest = Effect.fn(
  "WorkflowRpcDaemon.handleCompleteRequest",
)(function* (input: WorkflowRpcHandlerInput): Effect.fn.Return<WorkflowRpcEnvelope> {
  const runtime = input.runtime
  if (runtime === undefined) {
    return rpcError(
      input.requestId,
      COMPLETE_COMMAND,
      "Workflow engine runtime is inactive (no active writer lease)",
    )
  }

  const res = yield* decodeWorkflowCompleteRequest(input.rawPayload).pipe(
    Effect.mapError((err) => toBoundedReason(err, "Invalid workflow.complete request")),
    Effect.flatMap((req) =>
      match<typeof req, Effect.Effect<WorkflowCompleteResponse, WorkflowStoreFailureReason>>(req)
        .with({ _tag: "CompleteUnit" }, (unitReq) =>
          Effect.gen(function* () {
            const validated = yield* validateRpcRepoRoot(unitReq.repoRoot, input.scope)
            const lockRunId =
              unitReq.runId !== undefined
                ? unitReq.runId
                : (yield* runtime.rebuildRpcGateSemaphore.withPermits(1)(
                    resolveRunTarget(runtime, undefined),
                  )).runId
            return yield* withRunLock(
              runtime,
              lockRunId,
              Effect.gen(function* () {
                const target = yield* resolveRunTarget(runtime, lockRunId)
                const plan = target.plan
                if (plan === undefined) {
                  return yield* Effect.fail(
                    toBoundedReason(`CompiledPlan missing for workflow run '${target.runId}'`),
                  )
                }
                yield* assertWorkflowNonTerminal(runtime, target.executionId, plan.runId)
                yield* match(plan.mode)
                  .with({ _tag: "Manual" }, () => Effect.void)
                  .with({ _tag: "Automatic" }, () =>
                    Effect.fail(
                      toBoundedReason(
                        `workflow.complete is only valid in Manual mode (run '${plan.runId}' is Automatic)`,
                      ),
                    ),
                  )
                  .exhaustive()
                const outcome = yield* completeUnitInRuntime(
                  runtime,
                  validated.worktreeRoot,
                  plan,
                  target.executionId,
                  unitReq.unitId,
                )
                return WorkflowCompleteResponse.cases.UnitCompleted.make({
                  runId: plan.runId,
                  executionId: target.executionId,
                  outcome,
                })
              }),
            )
          }),
        )
        .with({ _tag: "CompleteLlmPhase" }, (llmReq) =>
          Effect.gen(function* () {
            yield* validateRpcRepoRoot(llmReq.repoRoot, input.scope)
            const lockRunId =
              llmReq.runId !== undefined
                ? llmReq.runId
                : (yield* runtime.rebuildRpcGateSemaphore.withPermits(1)(
                    resolveRunTarget(runtime, undefined),
                  )).runId
            return yield* withRunLock(
              runtime,
              lockRunId,
              Effect.gen(function* () {
                const target = yield* resolveRunTarget(runtime, lockRunId)
                const plan = target.plan
                const runRecord = target.runRecord
                if (plan === undefined || runRecord === undefined) {
                  return yield* Effect.fail(
                    toBoundedReason(
                      `Workflow run '${target.runId}' is missing CompiledPlan or WfRun projection`,
                    ),
                  )
                }
                yield* assertWorkflowNonTerminal(runtime, target.executionId, target.runId)
                yield* match(runRecord.state)
                  .with("waiting", () => Effect.void)
                  .with("running", "completed", "aborted", (state) =>
                    Effect.fail(
                      toBoundedReason(
                        `Cannot complete LLM phase while run '${target.runId}' is in state '${state}' (expected 'waiting')`,
                      ),
                    ),
                  )
                  .exhaustive()

                const units = yield* runtime.readModelQuery
                  .listUnits(target.runId)
                  .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
                const expectedUnitIds: ReadonlyArray<WorkUnitId> = [
                  ...plan.units.map((u) => u.unitId),
                  ...(plan.sharedStepPaths.length > 0 ? [SHARED_STEP_UNIT_ID] : []),
                ]
                for (const expectedId of expectedUnitIds) {
                  const rec = units.find((u) => u.unitId === expectedId)
                  if (!isUnitStatus(rec, "completed")) {
                    return yield* Effect.fail(
                      toBoundedReason(
                        `Cannot complete LLM phase before unit '${expectedId}' is completed (current status: '${rec?.status ?? "missing"}')`,
                      ),
                    )
                  }
                }

                yield* assertFrictionLogCleared(runtime)

                const hashIo = hostIoWithEnv(runtime.hostIo, runtime.env ?? runtime.hostIo.getEnv())
                const hashRes = computeWorkspaceTreeHashChecked(runtime.canonicalRepoRoot, hashIo)
                const workspaceHash = yield* match(hashRes)
                  .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(toBoundedReason(failure)))
                  .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
                  .exhaustive()

                const receipt: LlmPhaseReceipt = {
                  workspaceHash,
                  frictionLogCleared: "cleared",
                }
                const token = DurableDeferred.tokenFromExecutionId(LlmPhaseDone, {
                  workflow: HarnessTaskWorkflow,
                  executionId: target.executionId,
                })
                yield* DurableDeferred.succeed(LlmPhaseDone, { token, value: receipt }).pipe(
                  Effect.provideContext(runtime.workflowContext),
                )
                yield* waitForWorkflowCompletion(
                  runtime,
                  target.executionId,
                  `Timed out waiting for workflow '${target.runId}' completion after LLM phase`,
                )

                return WorkflowCompleteResponse.cases.LlmPhaseCompleted.make({
                  runId: target.runId,
                  executionId: target.executionId,
                  receipt,
                })
              }),
            )
          }),
        )
        .exhaustive(),
    ),
    Effect.result,
  )

  return match(res)
    .with({ _tag: "Failure" }, ({ failure }) =>
      rpcError(input.requestId, COMPLETE_COMMAND, failure),
    )
    .with({ _tag: "Success" }, ({ success: response }) =>
      rpcSuccess(input.requestId, COMPLETE_COMMAND, response),
    )
    .exhaustive()
})
