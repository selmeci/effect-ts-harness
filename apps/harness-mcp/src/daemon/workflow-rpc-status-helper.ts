import { Cause, Effect, Exit, Option, Result, Schema } from "effect"
import type { WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  type AttemptNumber,
  type CompiledPlan,
  type EscalationOrdinal,
  type LeaseEpoch,
  SHARED_STEP_UNIT_ID,
  type SliceBranchName,
  TaskRunAbortedError,
  type TaskRunReceipt,
  type UnitEscalation,
  type UnitOutcome,
  type UnitRejection,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WaveIndex,
  type WorkUnitId,
  type WorkflowAttemptRecord,
  WorkflowDaemonCapability,
  WorkflowDeferredTag,
  type WorkflowExecutionId,
  WorkflowPendingDeferred,
  WorkflowProjectionStatus,
  type WorkflowRpcEnvelope,
  type WorkflowRunId,
  type WorkflowRunRecord,
  WorkflowRunOutcome,
  WorkflowStatusRequest,
  WorkflowStatusSummary,
  type WorkflowStoreFailureReason,
  WorkflowStoreUnavailableError,
  WorkflowTerminalError,
  WorkflowTimestampMs,
  type WorkflowUnitRecord,
  WorkspaceFsError,
  WriterLeaseHeldError,
  encodeWorkflowDeferredName,
  isPureInterruptCause,
  makeWorkflowAttemptKey,
  toBoundedReason,
  wavesOf,
} from "@harness/contract"
import {
  HarnessTaskWorkflow,
  LlmPhaseDone,
  unitCompletionDeferredName,
  unitEscalationDeferredName,
} from "@harness/gates"
import { WorkflowReadModelQuery } from "@harness/service"
import { nodeSyncHostIo } from "@harness/infra"
import {
  WORKFLOW_DAEMON_CAPABILITIES,
  handleDaemonWorkflowStatusRequest,
} from "./workflow-daemon-helper.js"
import type { WorkflowDaemonRuntime } from "./workflow-engine-daemon-helper.js"
import { handleDaemonWorkflowDoctorRequest } from "./workflow-rpc-doctor-helper.js"
import {
  type WorkflowRpcHandlerInput,
  checkDeferredResult,
  extractLastRejection,
  findExplicitEscalation,
  hasAttemptVerdict,
  hasOutcomeTag,
  inspectActiveUnitCycle,
  isOptionPresent,
  isRunTerminalState,
  isUnitStatus,
  resolveRunTarget,
  rpcError,
  storeOrLeaseToBoundedReason,
  toWorkflowRpcRequestId,
  validateRpcRepoRoot,
} from "./workflow-rpc-shared.js"

export { handleDaemonWorkflowDoctorRequest }

const STATUS_COMMAND = WorkflowDaemonCapability.make("workflow.status")
const decodeWorkflowStatusRequest = Schema.decodeUnknownEffect(WorkflowStatusRequest)
const decodeAbsoluteRepoRoot = Schema.decodeUnknownEffect(AbsoluteRepoRoot)

const attemptBelongsToCycle = (
  attempt: WorkflowAttemptRecord,
  escalationOrdinal: EscalationOrdinal,
): boolean =>
  attempt.attemptKey ===
  makeWorkflowAttemptKey(attempt.runId, attempt.unitId, attempt.attempt, escalationOrdinal)

const retryBudgetExhausted = (lastRejection: UnitRejection): UnitEscalation => ({
  _tag: "RetryBudgetExhausted",
  lastRejection,
})

const resolveFallbackEscalation = (params: {
  readonly plan: CompiledPlan
  readonly unitId: WorkUnitId
  readonly branch?: SliceBranchName | undefined
  readonly escalationOrdinal: EscalationOrdinal
  readonly completedPriorToEscalation: boolean
  readonly allThreeRejected: boolean
  readonly attemptOutcomes: ReadonlyArray<{
    readonly attempt: AttemptNumber
    readonly outcome: Option.Option<UnitOutcome>
  }>
  readonly attempts: ReadonlyArray<WorkflowAttemptRecord>
}): Effect.Effect<UnitEscalation, WorkflowStoreFailureReason> => {
  if (params.completedPriorToEscalation && params.branch !== undefined) {
    return Effect.succeed({ _tag: "MergeConflict", branch: params.branch })
  }
  const cycleRejectedAttempts = params.attempts.filter(
    (a): a is Extract<WorkflowAttemptRecord, { readonly verdict: "rejected" }> =>
      a.unitId === params.unitId &&
      hasAttemptVerdict(a, "rejected") &&
      attemptBelongsToCycle(a, params.escalationOrdinal),
  )
  const rejectedInCycle = cycleRejectedAttempts.length
  if (params.allThreeRejected) {
    return extractLastRejection(params.attemptOutcomes, params.attempts, params.unitId).pipe(
      Effect.map(retryBudgetExhausted),
    )
  }
  if (rejectedInCycle > 0) {
    return match(params.plan.mode)
      .with({ _tag: "Automatic" }, (auto) =>
        extractLastRejection([], cycleRejectedAttempts, params.unitId).pipe(
          Effect.map((lastRejection): UnitEscalation =>
            match(lastRejection)
              .with({ _tag: "AgentFailed" }, (r): UnitEscalation =>
                match(r.escalationKind)
                  .with("AuthRequired", () => ({
                    _tag: "AuthRequired" as const,
                    runner: auto.runner,
                  }))
                  .with("MergeConflict", undefined, () => retryBudgetExhausted(r))
                  .exhaustive(),
              )
              .with(
                { _tag: "WriteSetViolation" },
                { _tag: "PackageVerifyFailed" },
                { _tag: "StampMissing" },
                () => retryBudgetExhausted(lastRejection),
              )
              .exhaustive(),
          ),
        ),
      )
      .with({ _tag: "Manual" }, () =>
        extractLastRejection(
          params.attemptOutcomes,
          rejectedInCycle >= 3 ? cycleRejectedAttempts : params.attempts,
          params.unitId,
        ).pipe(Effect.map(retryBudgetExhausted)),
      )
      .exhaustive()
  }
  return match(params.plan.mode)
    .with({ _tag: "Automatic" }, (auto) =>
      Effect.succeed<UnitEscalation>({ _tag: "AuthRequired", runner: auto.runner }),
    )
    .with({ _tag: "Manual" }, () =>
      extractLastRejection(params.attemptOutcomes, params.attempts, params.unitId).pipe(
        Effect.map(retryBudgetExhausted),
      ),
    )
    .exhaustive()
}

const discoverPendingDeferreds = Effect.fn("WorkflowRpcDaemon.discoverPendingDeferreds")(
  function* (params: {
    readonly engine: WorkflowEngine.WorkflowEngine["Service"]
    readonly executionId: WorkflowExecutionId
    readonly plan: CompiledPlan
    readonly units: ReadonlyArray<WorkflowUnitRecord>
    readonly attempts: ReadonlyArray<WorkflowAttemptRecord>
  }): Effect.fn.Return<ReadonlyArray<WorkflowPendingDeferred>, WorkflowStoreFailureReason> {
    const pending: Array<WorkflowPendingDeferred> = []
    const descriptors: Array<{
      readonly unitId: WorkUnitId
      readonly waveIndex: WaveIndex
      readonly branch?: SliceBranchName | undefined
    }> = params.plan.units.map((u) => ({
      unitId: u.unitId,
      waveIndex: u.waveIndex,
      branch: match(u)
        .with({ _tag: "SliceUnit" }, (s) => s.branch)
        .with({ _tag: "PackageUnit" }, () => undefined)
        .exhaustive(),
    }))
    if (params.plan.sharedStepPaths.length > 0) {
      descriptors.push({
        unitId: SHARED_STEP_UNIT_ID,
        waveIndex: WaveIndex.make(wavesOf(params.plan).length),
      })
    }

    let allUnitsCompleted = true
    for (const desc of descriptors) {
      const unitRecord = params.units.find((u) => u.unitId === desc.unitId)
      const cycleState = yield* inspectActiveUnitCycle(
        params.engine,
        params.executionId,
        desc.unitId,
      )

      yield* match(cycleState)
        .with({ _tag: "Aborted" }, () =>
          Effect.sync(() => {
            allUnitsCompleted = false
          }),
        )
        .with({ _tag: "Active" }, ({ escalationOrdinal, attemptOutcomes }) =>
          Effect.gen(function* () {
            const completedInJournal = attemptOutcomes.some((item) =>
              hasOutcomeTag(item.outcome, "Completed"),
            )
            const completedInReadModelOrAttempts =
              isUnitStatus(unitRecord, "completed") ||
              params.attempts.some(
                (a) => a.unitId === desc.unitId && hasAttemptVerdict(a, "completed"),
              )
            const unitCompleted = match(params.plan.mode)
              .with(
                { _tag: "Manual" },
                () => completedInJournal || isUnitStatus(unitRecord, "completed"),
              )
              .with({ _tag: "Automatic" }, () => completedInReadModelOrAttempts)
              .exhaustive()

            const unitIsEscalated = isUnitStatus(unitRecord, "escalated")
            if (unitCompleted && !unitIsEscalated) {
              return
            }
            allUnitsCompleted = false

            const allThreeRejected =
              attemptOutcomes.length === 3 &&
              attemptOutcomes.every((item) => hasOutcomeTag(item.outcome, "Rejected"))
            const explicitEsc = findExplicitEscalation(attemptOutcomes)

            if (unitIsEscalated || allThreeRejected || explicitEsc !== undefined) {
              const escalation =
                explicitEsc ??
                (yield* resolveFallbackEscalation({
                  plan: params.plan,
                  unitId: desc.unitId,
                  branch: desc.branch,
                  escalationOrdinal,
                  completedPriorToEscalation:
                    completedInJournal ||
                    params.attempts.some(
                      (a) => a.unitId === desc.unitId && hasAttemptVerdict(a, "completed"),
                    ),
                  allThreeRejected,
                  attemptOutcomes,
                  attempts: params.attempts,
                }))
              pending.push(
                WorkflowPendingDeferred.cases.Escalation.make({
                  unitId: desc.unitId,
                  deferredName: unitEscalationDeferredName(desc.unitId, escalationOrdinal),
                  escalation,
                }),
              )
              return
            }

            match(params.plan.mode)
              .with({ _tag: "Automatic" }, () => {})
              .with({ _tag: "Manual" }, () => {
                const firstOpen = attemptOutcomes.find((item) => !isOptionPresent(item.outcome))
                if (
                  firstOpen !== undefined &&
                  (isUnitStatus(unitRecord, "dispatched") ||
                    (unitRecord === undefined && desc.waveIndex === 0))
                ) {
                  pending.push(
                    WorkflowPendingDeferred.cases.UnitCompletion.make({
                      unitId: desc.unitId,
                      attempt: firstOpen.attempt,
                      deferredName: unitCompletionDeferredName(
                        desc.unitId,
                        firstOpen.attempt,
                        escalationOrdinal,
                      ),
                    }),
                  )
                }
              })
              .exhaustive()
          }),
        )
        .exhaustive()
    }

    if (allUnitsCompleted) {
      const llmRes = yield* checkDeferredResult(params.engine, params.executionId, LlmPhaseDone)
      match(llmRes)
        .with({ _tag: "Some" }, () => {})
        .with({ _tag: "None" }, () => {
          pending.push(
            WorkflowPendingDeferred.cases.LlmPhase.make({
              deferredName: encodeWorkflowDeferredName(
                WorkflowDeferredTag.cases.LlmPhaseDone.make({}),
              ),
            }),
          )
        })
        .exhaustive()
    }

    return pending
  },
)

const computeProjectionStatus = (
  run: WorkflowRunRecord | undefined,
  polledOpt: Option.Option<
    | { readonly _tag: "Suspended" }
    | { readonly _tag: "Complete"; readonly exit: Exit.Exit<TaskRunReceipt, unknown> }
  >,
): WorkflowProjectionStatus => {
  if (run === undefined) {
    return "not-projected"
  }
  return match(polledOpt)
    .with({ _tag: "None" }, () => "fresh" as const)
    .with({ _tag: "Some" }, ({ value: wfResult }) =>
      match(wfResult)
        .with({ _tag: "Suspended" }, () =>
          match(run.state)
            .with("completed", () => "stale" as const)
            .with("running", "waiting", "aborted", () => "fresh" as const)
            .exhaustive(),
        )
        .with({ _tag: "Complete" }, ({ exit }) =>
          Exit.match(exit, {
            onSuccess: () =>
              match(run.state)
                .with("completed", () => "fresh" as const)
                .with("running", "waiting", "aborted", () => "stale" as const)
                .exhaustive(),
            onFailure: () =>
              match(run.state)
                .with("aborted", () => "fresh" as const)
                .with("running", "waiting", "completed", () => "stale" as const)
                .exhaustive(),
          }),
        )
        .exhaustive(),
    )
    .exhaustive()
}

/** Classifies a terminal workflow failure `Cause` into a typed `WorkflowTerminalError` union. */
export const classifyWorkflowTerminalError = (
  cause: Cause.Cause<unknown>,
): WorkflowTerminalError => {
  if (isPureInterruptCause(cause)) {
    return WorkflowTerminalError.cases.Interrupted.make({
      reason: toBoundedReason(Cause.pretty(cause), "Workflow execution interrupted"),
    })
  }
  return match(Cause.findErrorOption(cause))
    .with({ _tag: "Some" }, ({ value: err }) => {
      if (err instanceof TaskRunAbortedError) {
        return WorkflowTerminalError.cases.Aborted.make({
          runId: err.runId,
          escalation: err.escalation,
        })
      }
      if (err instanceof WorkspaceFsError) {
        return WorkflowTerminalError.cases.WorkspaceFs.make({
          operation: err.operation,
          reason: toBoundedReason(err.reason, "Workspace filesystem error"),
        })
      }
      if (err instanceof WorkflowStoreUnavailableError) {
        return WorkflowTerminalError.cases.StoreUnavailable.make({
          operation: err.operation,
          reason: err.reason,
        })
      }
      if (err instanceof WriterLeaseHeldError) {
        return WorkflowTerminalError.cases.LeaseHeld.make({
          holderId: err.holderId,
          ...(err.leaseEpoch !== undefined ? { leaseEpoch: err.leaseEpoch } : {}),
          lockFilePath: err.lockFilePath,
        })
      }
      return WorkflowTerminalError.cases.Defect.make({
        reason: toBoundedReason(Cause.pretty(cause), "Workflow failed"),
      })
    })
    .with({ _tag: "None" }, () =>
      WorkflowTerminalError.cases.Defect.make({
        reason: toBoundedReason(Cause.pretty(cause), "Workflow failed with defect"),
      }),
    )
    .exhaustive()
}

const wrapSummaryWithStoreState = (
  storeStatus: "ready" | "paused" | "inactive",
  writerLeaseEpoch: LeaseEpoch | undefined,
  outcome: WorkflowRunOutcome,
): WorkflowStatusSummary => {
  if (writerLeaseEpoch === undefined) {
    return WorkflowStatusSummary.cases.DaemonOffline.make({ outcome })
  }
  return match(storeStatus)
    .with("ready", () => WorkflowStatusSummary.cases.Ready.make({ writerLeaseEpoch, outcome }))
    .with("paused", () =>
      WorkflowStatusSummary.cases.StorePaused.make({ writerLeaseEpoch, outcome }),
    )
    .with("inactive", () => WorkflowStatusSummary.cases.DaemonOffline.make({ outcome }))
    .exhaustive()
}

export const buildStatusSummaryForRuntime = Effect.fn("WorkflowRpcDaemon.buildStatusSummary")(
  function* (
    runtime: WorkflowDaemonRuntime,
    writerLeaseEpoch: LeaseEpoch | undefined,
    requestedRunId?: WorkflowRunId,
  ): Effect.fn.Return<WorkflowStatusSummary, WorkflowStoreFailureReason, WorkflowReadModelQuery> {
    const readModelQuery = yield* WorkflowReadModelQuery
    const storeStatus = yield* readModelQuery.probeAvailability
    const targetRes = yield* resolveRunTarget(runtime, requestedRunId).pipe(Effect.result)

    const outcome = yield* match(targetRes)
      .with({ _tag: "Failure" }, ({ failure }) => {
        if (requestedRunId === undefined && failure === "No workflow run found") {
          return Effect.succeed<WorkflowRunOutcome>(WorkflowRunOutcome.cases.NotFound.make({}))
        }
        return Effect.fail(failure)
      })
      .with({ _tag: "Success" }, ({ success: target }) =>
        Effect.gen(function* () {
          const units = yield* readModelQuery
            .listUnits(target.runId)
            .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
          const attempts = yield* readModelQuery
            .listAttempts(target.runId)
            .pipe(Effect.mapError(storeOrLeaseToBoundedReason))

          const polledOpt = yield* HarnessTaskWorkflow.poll(target.executionId).pipe(
            Effect.provideContext(runtime.workflowContext),
          )

          const effectiveRun: WorkflowRunRecord | undefined =
            target.runRecord ??
            (target.plan !== undefined
              ? {
                  runId: target.plan.runId,
                  executionId: target.executionId,
                  level: target.plan.level,
                  planSha: target.plan.planSha,
                  baseSha: target.plan.baseSha,
                  state: "running",
                  updatedMs: WorkflowTimestampMs.make(0),
                }
              : undefined)

          if (effectiveRun === undefined) {
            return WorkflowRunOutcome.cases.NotFound.make({})
          }

          const shipAttempts =
            runtime.shipAttemptStore !== undefined
              ? yield* runtime.shipAttemptStore
                  .listAttemptsForRun(effectiveRun.runId)
                  .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
              : []
          const shipAttemptsField =
            shipAttempts.length > 0 ? { shipAttempts: [...shipAttempts] } : {}

          const projectionStatus = computeProjectionStatus(target.runRecord, polledOpt)

          const terminalOutcome = match(polledOpt)
            .with({ _tag: "None" }, () => undefined)
            .with({ _tag: "Some" }, ({ value: wfResult }) =>
              match(wfResult)
                .with({ _tag: "Suspended" }, () => undefined)
                .with({ _tag: "Complete" }, ({ exit }) =>
                  Exit.match(exit, {
                    onSuccess: (receipt): WorkflowRunOutcome =>
                      WorkflowRunOutcome.cases.Completed.make({
                        run: effectiveRun,
                        units,
                        attempts,
                        pendingDeferreds: [],
                        review: receipt.review,
                        terminalReceipt: receipt,
                        ...shipAttemptsField,
                        projectionStatus,
                      }),
                    onFailure: (cause): WorkflowRunOutcome =>
                      WorkflowRunOutcome.cases.Failed.make({
                        run: effectiveRun,
                        units,
                        attempts,
                        pendingDeferreds: [],
                        terminalError: classifyWorkflowTerminalError(cause),
                        ...shipAttemptsField,
                        projectionStatus,
                      }),
                  }),
                )
                .exhaustive(),
            )
            .exhaustive()

          if (terminalOutcome !== undefined) {
            return terminalOutcome
          }

          return yield* match(effectiveRun.state)
            .with("aborted", () =>
              Effect.succeed<WorkflowRunOutcome>(
                WorkflowRunOutcome.cases.Failed.make({
                  run: effectiveRun,
                  units,
                  attempts,
                  pendingDeferreds: [],
                  terminalError: WorkflowTerminalError.cases.OperatorAborted.make({
                    runId: effectiveRun.runId,
                    reason: toBoundedReason("Workflow run marked aborted in read-model"),
                  }),
                  ...shipAttemptsField,
                  projectionStatus,
                }),
              ),
            )
            .with("running", "waiting", "completed", () =>
              Effect.gen(function* () {
                const pendingDeferreds =
                  !isRunTerminalState(effectiveRun.state) && target.plan !== undefined
                    ? yield* discoverPendingDeferreds({
                        engine: runtime.engine,
                        executionId: target.executionId,
                        plan: target.plan,
                        units,
                        attempts,
                      })
                    : []

                return WorkflowRunOutcome.cases.Active.make({
                  run: effectiveRun,
                  units,
                  attempts,
                  pendingDeferreds,
                  ...shipAttemptsField,
                  projectionStatus,
                })
              }),
            )
            .exhaustive()
        }),
      )
      .exhaustive()

    return wrapSummaryWithStoreState(storeStatus, writerLeaseEpoch, outcome)
  },
)

/** Processes `workflow.status` over daemon IPC, preserving legacy status keys plus `result: WorkflowStatusSummary`. */
export const handleDaemonWorkflowStatusRpcRequest = Effect.fn(
  "WorkflowRpcDaemon.handleStatusRequest",
)(function* (
  input: WorkflowRpcHandlerInput,
): Effect.fn.Return<WorkflowRpcEnvelope | Readonly<Record<string, unknown>>> {
  if (input.runtime === undefined) {
    if (typeof input.rawPayload["repoRoot"] === "string") {
      const rawStr = input.rawPayload["repoRoot"]
      const canonicalStr = match(Result.try(() => nodeSyncHostIo.realpathSync(rawStr)))
        .with({ _tag: "Success" }, ({ success }) => success)
        .with({ _tag: "Failure" }, () => rawStr)
        .exhaustive()
      const absRes = yield* decodeAbsoluteRepoRoot(canonicalStr).pipe(
        Effect.mapError((err) => toBoundedReason(err)),
        Effect.flatMap((absRoot) => validateRpcRepoRoot(absRoot, input.scope)),
        Effect.result,
      )
      const validationFailure = match(absRes)
        .with({ _tag: "Failure" }, ({ failure }) => failure)
        .with({ _tag: "Success" }, () => undefined)
        .exhaustive()
      if (validationFailure !== undefined) {
        return rpcError(input.requestId, STATUS_COMMAND, validationFailure)
      }
    }
    return handleDaemonWorkflowStatusRequest({
      requestId: input.requestId,
      scope: input.scope,
      writerLeaseEpoch: input.writerLeaseEpoch,
    })
  }

  const runtime = input.runtime
  const effectivePayload =
    input.rawPayload["repoRoot"] === undefined
      ? {
          ...input.rawPayload,
          repoRoot: input.scope.validatedWorktree?.worktreeRoot ?? runtime.canonicalRepoRoot,
        }
      : input.rawPayload

  const parsedRes = yield* decodeWorkflowStatusRequest(effectivePayload).pipe(
    Effect.mapError((err) => toBoundedReason(err, "Invalid workflow.status request")),
    Effect.flatMap((req) => validateRpcRepoRoot(req.repoRoot, input.scope).pipe(Effect.as(req))),
    Effect.flatMap((req) =>
      runtime.rebuildRpcGateSemaphore.withPermits(1)(
        buildStatusSummaryForRuntime(runtime, input.writerLeaseEpoch, req.runId).pipe(
          Effect.provideService(WorkflowReadModelQuery, runtime.readModelQuery),
        ),
      ),
    ),
    Effect.result,
  )

  return match(parsedRes)
    .with({ _tag: "Failure" }, ({ failure }) => rpcError(input.requestId, STATUS_COMMAND, failure))
    .with({ _tag: "Success" }, ({ success: summary }) => {
      const topStatus = match(summary)
        .with({ _tag: "Ready" }, () => "ready" as const)
        .with({ _tag: "StorePaused" }, { _tag: "DaemonOffline" }, () => "inactive" as const)
        .exhaustive()
      return {
        id: toWorkflowRpcRequestId(input.requestId),
        ok: true as const,
        command: STATUS_COMMAND,
        status: topStatus,
        protocolVersion: WORKFLOW_DAEMON_PROTOCOL_VERSION,
        capabilities: [...WORKFLOW_DAEMON_CAPABILITIES],
        repoRoot: input.scope.validatedWorktree?.worktreeRoot ?? input.scope.resolvedRoot,
        ...(input.scope.validatedWorktree !== undefined
          ? {
              commonGitDir: input.scope.validatedWorktree.commonGitDir,
              worktreeKind: input.scope.validatedWorktree.kind,
            }
          : {}),
        ...(input.writerLeaseEpoch !== undefined
          ? { writerLeaseEpoch: input.writerLeaseEpoch }
          : {}),
        result: summary,
      }
    })
    .exhaustive()
})
