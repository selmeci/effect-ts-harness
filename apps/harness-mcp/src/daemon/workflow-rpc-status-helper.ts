import { Cause, Effect, Exit, Option, Result, Schema } from "effect"
import type { WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  type AttemptNumber,
  type CompiledPlan,
  type EscalationOrdinal,
  type LeaseEpoch,
  PendingDeferredName,
  type ReviewRoutingPlan,
  SHARED_STEP_UNIT_ID,
  type SliceBranchName,
  type TaskRunReceipt,
  type UnitEscalation,
  type UnitOutcome,
  WORKFLOW_DAEMON_PROTOCOL_VERSION,
  WaveIndex,
  type WorkUnitId,
  type WorkflowAttemptRecord,
  WorkflowDoctorCheckItem,
  WorkflowDoctorCheckName,
  WorkflowDoctorRequest,
  type WorkflowDoctorResponse,
  type WorkflowExecutionId,
  WorkflowPendingDeferred,
  WorkflowProjectionStatus,
  WorkflowRebuiltRunCount,
  type WorkflowRunId,
  type WorkflowRunRecord,
  WorkflowStatusRequest,
  type WorkflowStatusSummary,
  type WorkflowStoreFailureReason,
  type WorkflowUnitRecord,
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
import { nodeSyncHostIo, rebuildWorkflowReadModelViews } from "@harness/infra"
import {
  WORKFLOW_DAEMON_CAPABILITIES,
  handleDaemonWorkflowStatusRequest,
} from "./workflow-daemon-helper.js"
import type { WorkflowDaemonRuntime } from "./workflow-engine-daemon-helper.js"
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
  rpcSuccess,
  validateRpcRepoRoot,
} from "./workflow-rpc-shared.js"

const decodeWorkflowStatusRequest = Schema.decodeUnknownEffect(WorkflowStatusRequest)
const decodeWorkflowDoctorRequest = Schema.decodeUnknownEffect(WorkflowDoctorRequest)
const decodeAbsoluteRepoRoot = Schema.decodeUnknownEffect(AbsoluteRepoRoot)

const attemptBelongsToCycle = (attemptKey: string, escalationOrdinal: EscalationOrdinal): boolean =>
  escalationOrdinal === 1
    ? !attemptKey.includes("/r")
    : attemptKey.endsWith(`/r${escalationOrdinal}`)

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
}): UnitEscalation => {
  if (params.completedPriorToEscalation && params.branch !== undefined) {
    return { _tag: "MergeConflict", branch: params.branch }
  }
  const rejectedInCycle = params.attempts.filter(
    (a) =>
      a.unitId === params.unitId &&
      hasAttemptVerdict(a, "rejected") &&
      attemptBelongsToCycle(a.attemptKey, params.escalationOrdinal),
  ).length
  if (params.allThreeRejected || rejectedInCycle >= 3) {
    return {
      _tag: "RetryBudgetExhausted",
      lastRejection: extractLastRejection(params.attemptOutcomes, params.attempts, params.unitId),
    }
  }
  return match(params.plan.mode)
    .with({ _tag: "Automatic" }, (auto): UnitEscalation => ({
      _tag: "AuthRequired",
      runner: auto.runner,
    }))
    .with({ _tag: "Manual" }, (): UnitEscalation => ({
      _tag: "RetryBudgetExhausted",
      lastRejection: extractLastRejection(params.attemptOutcomes, params.attempts, params.unitId),
    }))
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

      match(cycleState)
        .with({ _tag: "Aborted" }, () => {
          allUnitsCompleted = false
        })
        .with({ _tag: "Active" }, ({ escalationOrdinal, attemptOutcomes }) => {
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
              resolveFallbackEscalation({
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
              })
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
        })
        .exhaustive()
    }

    if (allUnitsCompleted) {
      const llmRes = yield* checkDeferredResult(params.engine, params.executionId, LlmPhaseDone)
      match(llmRes)
        .with({ _tag: "Some" }, () => {})
        .with({ _tag: "None" }, () => {
          pending.push(
            WorkflowPendingDeferred.cases.LlmPhase.make({
              deferredName: PendingDeferredName.make("llm-phase-done"),
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

export const buildStatusSummaryForRuntime = Effect.fn("WorkflowRpcDaemon.buildStatusSummary")(
  function* (
    runtime: WorkflowDaemonRuntime,
    writerLeaseEpoch: LeaseEpoch,
    requestedRunId?: WorkflowRunId,
  ): Effect.fn.Return<WorkflowStatusSummary, WorkflowStoreFailureReason, WorkflowReadModelQuery> {
    const readModelQuery = yield* WorkflowReadModelQuery
    const storeStatus = yield* readModelQuery.probeAvailability
    const targetRes = yield* resolveRunTarget(runtime, requestedRunId).pipe(Effect.result)

    return yield* match(targetRes)
      .with({ _tag: "Failure" }, ({ failure }) =>
        requestedRunId !== undefined
          ? Effect.fail(failure)
          : Effect.succeed<WorkflowStatusSummary>({
              units: [],
              attempts: [],
              pendingDeferreds: [],
              storeStatus,
              projectionStatus: WorkflowProjectionStatus.make("not-projected"),
              writerLeaseEpoch,
            }),
      )
      .with({ _tag: "Success" }, ({ success: target }) =>
        Effect.gen(function* () {
          const units = yield* readModelQuery
            .listUnits(target.runId)
            .pipe(Effect.mapError((err) => err.reason))
          const attempts = yield* readModelQuery
            .listAttempts(target.runId)
            .pipe(Effect.mapError((err) => err.reason))

          const polledOpt = yield* HarnessTaskWorkflow.poll(target.executionId).pipe(
            Effect.provideContext(runtime.workflowContext),
          )

          let terminalReceipt: TaskRunReceipt | undefined
          let review: ReviewRoutingPlan | undefined
          let terminalError: WorkflowStoreFailureReason | undefined
          let isTerminal = false

          match(polledOpt)
            .with({ _tag: "None" }, () => {})
            .with({ _tag: "Some" }, ({ value: wfResult }) => {
              match(wfResult)
                .with({ _tag: "Suspended" }, () => {})
                .with({ _tag: "Complete" }, ({ exit }) => {
                  isTerminal = true
                  Exit.match(exit, {
                    onSuccess: (receipt) => {
                      terminalReceipt = receipt
                      review = receipt.review
                    },
                    onFailure: (cause) => {
                      terminalError = toBoundedReason(Cause.pretty(cause), "Workflow failed")
                    },
                  })
                })
                .exhaustive()
            })
            .exhaustive()

          const run = target.runRecord
          const projectionStatus = computeProjectionStatus(run, polledOpt)
          const pendingDeferreds =
            !isTerminal &&
            (run === undefined || !isRunTerminalState(run.state)) &&
            target.plan !== undefined
              ? yield* discoverPendingDeferreds({
                  engine: runtime.engine,
                  executionId: target.executionId,
                  plan: target.plan,
                  units,
                  attempts,
                })
              : []

          return {
            ...(run !== undefined ? { run } : {}),
            units,
            attempts,
            pendingDeferreds,
            ...(review !== undefined ? { review } : {}),
            ...(terminalReceipt !== undefined ? { terminalReceipt } : {}),
            ...(terminalError !== undefined ? { terminalError } : {}),
            storeStatus,
            projectionStatus,
            writerLeaseEpoch,
          } satisfies WorkflowStatusSummary
        }),
      )
      .exhaustive()
  },
)

/** Processes `workflow.status` over daemon IPC, preserving legacy status keys plus `result: WorkflowStatusSummary`. */
export const handleDaemonWorkflowStatusRpcRequest = Effect.fn(
  "WorkflowRpcDaemon.handleStatusRequest",
)(function* (input: WorkflowRpcHandlerInput): Effect.fn.Return<Record<string, unknown>> {
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
        return rpcError(input.requestId, "workflow.status", validationFailure)
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
      buildStatusSummaryForRuntime(runtime, input.writerLeaseEpoch, req.runId).pipe(
        Effect.provideService(WorkflowReadModelQuery, runtime.readModelQuery),
      ),
    ),
    Effect.result,
  )

  return match(parsedRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      rpcError(input.requestId, "workflow.status", failure),
    )
    .with({ _tag: "Success" }, ({ success: summary }) => {
      const topStatus = match(summary.storeStatus)
        .with("ready", () => "ready" as const)
        .with("paused", "inactive", () => "inactive" as const)
        .exhaustive()
      return {
        id: input.requestId,
        ok: true,
        command: "workflow.status",
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
        writerLeaseEpoch: input.writerLeaseEpoch,
        result: summary,
      }
    })
    .exhaustive()
})

/** Processes `workflow.doctor` (`check-only` or `rebuild`) over daemon Unix socket IPC. */
export const handleDaemonWorkflowDoctorRequest = Effect.fn("WorkflowRpcDaemon.handleDoctorRequest")(
  function* (input: WorkflowRpcHandlerInput): Effect.fn.Return<Record<string, unknown>> {
    const runtime = input.runtime
    if (runtime === undefined) {
      return rpcError(
        input.requestId,
        "workflow.doctor",
        "Workflow engine runtime is inactive (no active writer lease)",
      )
    }

    const res = yield* decodeWorkflowDoctorRequest(input.rawPayload).pipe(
      Effect.mapError((err) => toBoundedReason(err, "Invalid workflow.doctor request")),
      Effect.flatMap((req) =>
        Effect.gen(function* () {
          const validated = yield* validateRpcRepoRoot(req.repoRoot, input.scope)
          const checks: Array<WorkflowDoctorCheckItem> = [
            WorkflowDoctorCheckItem.make({
              name: WorkflowDoctorCheckName.make("worktree-binding"),
              status: "ok",
              detail: toBoundedReason(
                `Validated ${validated.kind} worktree at '${validated.worktreeRoot}'`,
              ),
            }),
            WorkflowDoctorCheckItem.make({
              name: WorkflowDoctorCheckName.make("writer-lease"),
              status: input.writerLeaseEpoch >= 1 ? "ok" : "fail",
              detail: toBoundedReason(`Active writer lease epoch ${input.writerLeaseEpoch}`),
            }),
          ]

          const storeAvailability = yield* runtime.readModelQuery.probeAvailability
          checks.push(
            WorkflowDoctorCheckItem.make({
              name: WorkflowDoctorCheckName.make("omnigraph-read-model"),
              status: match(storeAvailability)
                .with("ready", () => "ok" as const)
                .with("paused", () => "warn" as const)
                .with("inactive", () => "fail" as const)
                .exhaustive(),
              detail: toBoundedReason(`Workflow read-model store status: ${storeAvailability}`),
            }),
          )

          const rebuiltRunCount = yield* match(req.mode)
            .with("check-only", () => Effect.succeed(WorkflowRebuiltRunCount.make(0)))
            .with("rebuild", () =>
              rebuildWorkflowReadModelViews(runtime.canonicalRepoRoot, {
                ...(runtime.client !== undefined ? { client: runtime.client } : {}),
                hostIo: runtime.hostIo,
                ...(runtime.env !== undefined ? { env: runtime.env } : {}),
              }).pipe(
                Effect.mapError((err) =>
                  toBoundedReason(err.message, "Failed to rebuild workflow read-model views"),
                ),
                Effect.tap((count) =>
                  Effect.sync(() => {
                    checks.push(
                      WorkflowDoctorCheckItem.make({
                        name: WorkflowDoctorCheckName.make("read-model-rebuild"),
                        status: "ok",
                        detail: toBoundedReason(
                          `Rebuilt ${count} run view bundle(s) from authoritative journal`,
                        ),
                      }),
                    )
                  }),
                ),
              ),
            )
            .exhaustive()

          return {
            repoRoot: validated.worktreeRoot,
            commonGitDir: validated.commonGitDir,
            writerLeaseEpoch: input.writerLeaseEpoch,
            rebuiltRunCount,
            checks,
          } satisfies WorkflowDoctorResponse
        }),
      ),
      Effect.result,
    )

    return match(res)
      .with({ _tag: "Failure" }, ({ failure }) =>
        rpcError(input.requestId, "workflow.doctor", failure),
      )
      .with({ _tag: "Success" }, ({ success: response }) =>
        rpcSuccess(input.requestId, "workflow.doctor", response),
      )
      .exhaustive()
  },
)
