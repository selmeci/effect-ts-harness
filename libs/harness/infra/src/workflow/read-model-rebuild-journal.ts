import { Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  CompiledPlan,
  type EscalationOrdinal,
  PlanJsonPayload,
  SHARED_STEP_UNIT_ID,
  WaveIndex,
  type WorkUnitId,
  type WorkflowAttemptKey,
  type WorkflowAttemptRecord,
  type WorkflowRunState,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  type WorkflowTimestampMs,
  WorkflowUnitKind,
  type WorkflowUnitRecord,
  type WorkflowUnitStatus,
  type WriterLeaseHeldError,
  compareCodeUnits,
  decodeWorkflowActivityName,
  decodeWorkflowDeferredName,
  makeWorkflowUnitKey,
  toBoundedReason,
  wavesOf,
} from "@harness/contract"
import { toWorkflowStoreUnavailableError } from "./workflow-store-codec.js"
import {
  type RebuiltRunBundle,
  type WorkflowReadModelOptions,
  abortUnlessCompleted,
  classifyWorkflowResultReply,
  decodeActivityPayloadOption,
  decodeDeferredPayloadOption,
  decodeEscalationResolutionOption,
  decodeExecutionIdOption,
  decodeMergeOutcomeOption,
  decodeRunPayloadOption,
  findSliceByBranch,
  moveRunningToWaiting,
  moveWaitingToRunning,
  optionalNonEmptyString,
  recordUnitOutcome,
  scanAllJournalRows,
  unwrapOption,
} from "./read-model-rebuild.js"

const replayActivityMessage = Effect.fnUntraced(function* (params: {
  readonly operation: WorkflowStoreOperation
  readonly plan: CompiledPlan
  readonly activityName: string
  readonly actReplyStr: string | undefined
  readonly hasRunReply: boolean
  readonly nowValue: WorkflowTimestampMs
  readonly unitStatusMap: Map<WorkUnitId, WorkflowUnitStatus>
  readonly attemptsMap: Map<WorkflowAttemptKey, WorkflowAttemptRecord>
  readonly mergeConflictUnits: Set<WorkUnitId>
  readonly getRunState: () => WorkflowRunState
  readonly setRunState: (state: WorkflowRunState) => void
}): Effect.fn.Return<void, WorkflowStoreUnavailableError> {
  const { operation, plan, activityName, actReplyStr, hasRunReply, unitStatusMap } = params
  const actReply = yield* classifyWorkflowResultReply(
    actReplyStr,
    operation,
    `activity '${activityName}' in run '${plan.runId}'`,
  )
  const actExitVal = unwrapOption(actReply.successValue)

  const decodedActivity = yield* match(decodeWorkflowActivityName(activityName))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(failure),
        }),
      ),
    )
    .exhaustive()

  const replayVerifyActivity = (
    targetUnitId: WorkUnitId,
    escalationOrdinal: EscalationOrdinal,
  ): Effect.Effect<void, WorkflowStoreUnavailableError> =>
    Effect.gen(function* () {
      if (!unitStatusMap.has(targetUnitId)) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Verify activity '${activityName}' targets unknown unit '${targetUnitId}' in run '${plan.runId}'`,
          ),
        })
      }
      if (unitStatusMap.get(targetUnitId) === "pending") {
        unitStatusMap.set(targetUnitId, "dispatched")
      }
      if (actExitVal !== undefined) {
        yield* recordUnitOutcome({
          operation,
          runId: plan.runId,
          escalationOrdinal,
          rawOutcome: actExitVal,
          nowValue: params.nowValue,
          unitStatusMap,
          attemptsMap: params.attemptsMap,
          contextLabel: `activity '${activityName}'`,
        })
      }
    })

  yield* match(decodedActivity)
    .with({ _tag: "DispatchUnitAgent" }, { _tag: "ProjectUnitDispatched" }, ({ unitId }) =>
      Effect.sync(() => {
        if (unitStatusMap.get(unitId) === "pending") {
          unitStatusMap.set(unitId, "dispatched")
        }
      }),
    )
    .with({ _tag: "ProjectUnitEscalated" }, ({ unitId }) =>
      Effect.sync(() => {
        if (unitStatusMap.has(unitId)) {
          unitStatusMap.set(unitId, "escalated")
        }
        params.setRunState(moveRunningToWaiting(params.getRunState()))
      }),
    )
    .with({ _tag: "ProjectUnitEscalationRetried" }, ({ unitId }) =>
      Effect.sync(() => {
        if (unitStatusMap.has(unitId)) {
          unitStatusMap.set(unitId, "dispatched")
        }
        params.setRunState(moveWaitingToRunning(params.getRunState(), hasRunReply))
      }),
    )
    .with({ _tag: "ProjectWaveMergeEscalated" }, () =>
      Effect.sync(() => {
        params.setRunState(moveRunningToWaiting(params.getRunState()))
      }),
    )
    .with({ _tag: "ProjectWaveMergeRetried" }, () =>
      Effect.sync(() => {
        params.setRunState(moveWaitingToRunning(params.getRunState(), hasRunReply))
      }),
    )
    .with({ _tag: "ProjectRunWaitingLlmPhase" }, () =>
      Effect.sync(() => {
        params.setRunState(moveRunningToWaiting(params.getRunState()))
      }),
    )
    .with({ _tag: "ProjectRunCompleted" }, () =>
      Effect.sync(() => {
        if (params.getRunState() !== "aborted") {
          params.setRunState("completed")
        }
      }),
    )
    .with({ _tag: "ProjectRunAborted" }, () =>
      Effect.sync(() => {
        params.setRunState(abortUnlessCompleted(params.getRunState()))
      }),
    )
    .with({ _tag: "MergeSliceWave" }, () =>
      actExitVal === undefined
        ? Effect.void
        : match(decodeMergeOutcomeOption(actExitVal))
            .with({ _tag: "None" }, () =>
              Effect.fail(
                new WorkflowStoreUnavailableError({
                  operation,
                  reason: toBoundedReason(
                    `Undecodable MergeSliceWaveOutcome for '${activityName}' in run '${plan.runId}'`,
                  ),
                }),
              ),
            )
            .with({ _tag: "Some" }, ({ value: outcome }) =>
              Effect.sync(() => {
                match(outcome)
                  .with({ _tag: "Conflict" }, ({ branch }) => {
                    const slice = findSliceByBranch(plan, branch)
                    if (slice !== undefined) {
                      unitStatusMap.set(slice.unitId, "escalated")
                      params.mergeConflictUnits.add(slice.unitId)
                    }
                    params.setRunState(moveRunningToWaiting(params.getRunState()))
                  })
                  .with({ _tag: "Merged" }, ({ mergedBranches }) => {
                    for (const branch of mergedBranches) {
                      const slice = findSliceByBranch(plan, branch)
                      if (
                        slice !== undefined &&
                        (unitStatusMap.get(slice.unitId) === "escalated" ||
                          params.mergeConflictUnits.has(slice.unitId))
                      ) {
                        unitStatusMap.set(slice.unitId, "completed")
                        params.mergeConflictUnits.delete(slice.unitId)
                      }
                    }
                  })
                  .exhaustive()
              }),
            )
            .exhaustive(),
    )
    .with({ _tag: "VerifyUnit" }, ({ unitId, escalationOrdinal }) =>
      replayVerifyActivity(unitId, escalationOrdinal),
    )
    .with({ _tag: "VerifySharedStep" }, ({ escalationOrdinal }) =>
      replayVerifyActivity(SHARED_STEP_UNIT_ID, escalationOrdinal),
    )
    .with(
      { _tag: "ProvisionWorktrees" },
      { _tag: "ProjectRunStarted" },
      { _tag: "RouteReview" },
      { _tag: "ProjectUnitCompleted" },
      { _tag: "ProjectUnitRejected" },
      { _tag: "ProjectUnitAttemptEscalated" },
      () => Effect.void,
    )
    .exhaustive()

  if (actReplyStr !== undefined) {
    match(actReply.state)
      .with("aborted", () => {
        params.setRunState(abortUnlessCompleted(params.getRunState()))
      })
      .with("running", "waiting", "completed", () => undefined)
      .exhaustive()
  }
})

/**
 * Scans `WfMessage`/`WfReply` journal rows and reconstructs all target `WfRun`/`WfUnit`/`WfAttempt`
 * bundles in memory, failing closed on ANY corrupt row, payload, cursor stall, or page truncation
 * before any existing view rows are deleted.
 */
const reconstructJournalViews = (
  repoRoot: AbsoluteRepoRoot,
  operation: WorkflowStoreOperation,
  nowValue: WorkflowTimestampMs,
  options?: WorkflowReadModelOptions,
): Effect.Effect<
  ReadonlyArray<RebuiltRunBundle>,
  WorkflowStoreUnavailableError | WriterLeaseHeldError
> =>
  Effect.gen(function* () {
    const entityRows = yield* scanAllJournalRows(repoRoot, "wf_all_entities", operation, options)
    const replyRows = yield* scanAllJournalRows(repoRoot, "wf_all_replies", operation, options)

    const exitReplyByRequestId = new Map<string, string>()
    for (const reply of replyRows) {
      yield* match(reply.kind)
        .with("with_exit", () => {
          const reqId = optionalNonEmptyString(reply.requestId)
          const payload = optionalNonEmptyString(reply.payload)
          if (reqId === undefined || payload === undefined) {
            return Effect.fail(
              new WorkflowStoreUnavailableError({
                operation,
                reason: toBoundedReason(
                  `Corrupt with_exit WfReply row (replyKey=${JSON.stringify(reply.replyKey)}) missing requestId or payload`,
                ),
              }),
            )
          }
          exitReplyByRequestId.set(reqId, payload)
          return Effect.void
        })
        .with("chunk", () => Effect.void)
        .otherwise(() =>
          Effect.fail(
            new WorkflowStoreUnavailableError({
              operation,
              reason: toBoundedReason(
                `Invalid WfReply kind ${JSON.stringify(reply.kind)} on replyKey=${JSON.stringify(reply.replyKey)}`,
              ),
            }),
          ),
        )
    }

    const messagesByExecutionId = new Map<string, Array<Readonly<Record<string, unknown>>>>()
    for (const msg of entityRows) {
      if (msg.entityType !== "Workflow/HarnessTaskWorkflow") {
        continue
      }
      const executionId = optionalNonEmptyString(msg.entityId)
      const msgKind = optionalNonEmptyString(msg.kind)
      const tag = optionalNonEmptyString(msg.tag)
      if (
        executionId === undefined ||
        (msgKind !== "request" && msgKind !== "ack_chunk" && msgKind !== "interrupt")
      ) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Corrupt WfMessage row (messageKey=${JSON.stringify(msg.messageKey)}) missing entityId or invalid kind`,
          ),
        })
      }
      if (msgKind === "request" && tag === undefined) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Corrupt WfMessage(request) row (messageKey=${JSON.stringify(msg.messageKey)}) missing tag`,
          ),
        })
      }
      const list = messagesByExecutionId.get(executionId) ?? []
      list.push(msg)
      messagesByExecutionId.set(executionId, list)
    }

    const rebuiltRuns: Array<RebuiltRunBundle> = []

    for (const [rawExecutionId, rawMessages] of messagesByExecutionId.entries()) {
      const messages = [...rawMessages].sort((a, b) =>
        compareCodeUnits(
          optionalNonEmptyString(a.seqKey) ?? "",
          optionalNonEmptyString(b.seqKey) ?? "",
        ),
      )
      const executionId = unwrapOption(decodeExecutionIdOption(rawExecutionId))
      if (executionId === undefined) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Invalid WorkflowExecutionId '${rawExecutionId}' in WfMessage journal`,
          ),
        })
      }
      const runMsg = messages.find((m) => m.tag === "run")
      if (runMsg === undefined) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Workflow execution '${executionId}' in journal is missing its 'run' message`,
          ),
        })
      }
      const runPayloadStr = optionalNonEmptyString(runMsg.payload)
      const plan =
        runPayloadStr !== undefined
          ? unwrapOption(decodeRunPayloadOption(runPayloadStr))?.plan
          : undefined
      if (plan === undefined) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Corrupt or undecodable 'run' payload for workflow execution '${executionId}'`,
          ),
        })
      }

      const runRequestId = optionalNonEmptyString(runMsg.requestId)
      if (runRequestId === undefined) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Workflow execution '${executionId}' 'run' message is missing requestId`,
          ),
        })
      }
      const runReplyPayload = exitReplyByRequestId.get(runRequestId)
      const classifiedRunReply = yield* classifyWorkflowResultReply(
        runReplyPayload,
        operation,
        `run '${plan.runId}'`,
      )
      let runState: WorkflowRunState = classifiedRunReply.state

      const unitStatusMap = new Map<WorkUnitId, WorkflowUnitStatus>()
      for (const unit of plan.units) {
        unitStatusMap.set(unit.unitId, "pending")
      }
      if (plan.sharedStepPaths.length > 0) {
        unitStatusMap.set(SHARED_STEP_UNIT_ID, "pending")
      }
      const attemptsMap = new Map<WorkflowAttemptKey, WorkflowAttemptRecord>()
      const mergeConflictUnits = new Set<WorkUnitId>()

      for (const msg of messages) {
        const msgKind = optionalNonEmptyString(msg.kind)
        if (msgKind === "ack_chunk") {
          continue
        }
        if (msgKind === "interrupt") {
          if (optionalNonEmptyString(msg.requestId) === runRequestId) {
            runState = abortUnlessCompleted(runState)
          }
          continue
        }
        if (msg.tag === "deferred") {
          const payloadStr = optionalNonEmptyString(msg.payload)
          const deferred =
            payloadStr !== undefined
              ? unwrapOption(decodeDeferredPayloadOption(payloadStr))
              : undefined
          if (deferred === undefined) {
            return yield* new WorkflowStoreUnavailableError({
              operation,
              reason: toBoundedReason(
                `Corrupt or undecodable 'deferred' payload in workflow run '${plan.runId}'`,
              ),
            })
          }
          const decodedDeferred = yield* match(decodeWorkflowDeferredName(deferred.name))
            .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
            .with({ _tag: "Failure" }, ({ failure }) =>
              Effect.fail(
                new WorkflowStoreUnavailableError({
                  operation,
                  reason: toBoundedReason(failure),
                }),
              ),
            )
            .exhaustive()
          const deferredVal = unwrapOption(
            match(deferred.exit)
              .with({ _tag: "Success" }, ({ value }) => Option.some(value))
              .with({ _tag: "Failure" }, () => Option.none())
              .exhaustive(),
          )
          yield* match(decodedDeferred)
            .with({ _tag: "InterruptSignal" }, () =>
              Effect.sync(() => {
                runState = abortUnlessCompleted(runState)
              }),
            )
            .with({ _tag: "LlmPhaseDone" }, () =>
              Effect.sync(() => {
                runState = moveWaitingToRunning(runState, runReplyPayload !== undefined)
              }),
            )
            .with({ _tag: "UnitCompletion" }, ({ unitId, escalationOrdinal }) =>
              Effect.gen(function* () {
                if (!unitStatusMap.has(unitId)) {
                  return yield* new WorkflowStoreUnavailableError({
                    operation,
                    reason: toBoundedReason(
                      `Unit deferred '${deferred.name}' targets unknown unit '${unitId}' in run '${plan.runId}'`,
                    ),
                  })
                }
                if (deferredVal === undefined) {
                  return yield* new WorkflowStoreUnavailableError({
                    operation,
                    reason: toBoundedReason(
                      `Unit deferred '${deferred.name}' recorded unexpected Failure exit in run '${plan.runId}'`,
                    ),
                  })
                }
                yield* recordUnitOutcome({
                  operation,
                  runId: plan.runId,
                  escalationOrdinal,
                  rawOutcome: deferredVal,
                  nowValue,
                  unitStatusMap,
                  attemptsMap,
                  contextLabel: `deferred '${deferred.name}'`,
                })
              }),
            )
            .with({ _tag: "UnitEscalation" }, ({ unitId }) =>
              Effect.gen(function* () {
                if (deferredVal === undefined) {
                  return yield* new WorkflowStoreUnavailableError({
                    operation,
                    reason: toBoundedReason(
                      `Escalation deferred '${deferred.name}' recorded unexpected Failure exit in run '${plan.runId}'`,
                    ),
                  })
                }
                const resolution = unwrapOption(decodeEscalationResolutionOption(deferredVal))
                if (resolution === undefined) {
                  return yield* new WorkflowStoreUnavailableError({
                    operation,
                    reason: toBoundedReason(
                      `Undecodable EscalationResolution on deferred '${deferred.name}' in run '${plan.runId}'`,
                    ),
                  })
                }
                match(resolution.decision)
                  .with("abort", () => {
                    if (unitStatusMap.has(unitId)) {
                      unitStatusMap.set(unitId, "escalated")
                    }
                    runState = abortUnlessCompleted(runState)
                  })
                  .with("retry", () => {
                    if (unitStatusMap.has(unitId)) {
                      const nextStatus = mergeConflictUnits.has(unitId)
                        ? ("completed" as const)
                        : ("dispatched" as const)
                      unitStatusMap.set(unitId, nextStatus)
                    }
                    mergeConflictUnits.delete(unitId)
                    runState = moveWaitingToRunning(runState, runReplyPayload !== undefined)
                  })
                  .exhaustive()
              }),
            )
            .exhaustive()
          continue
        }

        if (msg.tag === "activity") {
          const payloadStr = optionalNonEmptyString(msg.payload)
          const activity =
            payloadStr !== undefined
              ? unwrapOption(decodeActivityPayloadOption(payloadStr))
              : undefined
          if (activity === undefined) {
            return yield* new WorkflowStoreUnavailableError({
              operation,
              reason: toBoundedReason(
                `Corrupt or undecodable 'activity' payload in workflow run '${plan.runId}'`,
              ),
            })
          }
          const actReqId = optionalNonEmptyString(msg.requestId)
          const actReplyStr =
            actReqId !== undefined ? exitReplyByRequestId.get(actReqId) : undefined
          yield* replayActivityMessage({
            operation,
            plan,
            activityName: activity.name,
            actReplyStr,
            hasRunReply: runReplyPayload !== undefined,
            nowValue,
            unitStatusMap,
            attemptsMap,
            mergeConflictUnits,
            getRunState: () => runState,
            setRunState: (next) => {
              runState = next
            },
          })
        }
      }

      const planJson = yield* Schema.encodeEffect(Schema.fromJsonString(CompiledPlan))(plan).pipe(
        Effect.map((encoded) => PlanJsonPayload.make(encoded)),
        Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)),
      )

      const unitRecords: Array<WorkflowUnitRecord> = plan.units.map((unit) => ({
        unitKey: makeWorkflowUnitKey(plan.runId, unit.unitId),
        runId: plan.runId,
        unitId: unit.unitId,
        kind: match(unit)
          .with({ _tag: "SliceUnit" }, () => WorkflowUnitKind.make("slice"))
          .with({ _tag: "PackageUnit" }, () => WorkflowUnitKind.make("package"))
          .exhaustive(),
        waveIndex: unit.waveIndex,
        status: unitStatusMap.get(unit.unitId) ?? "pending",
        ownedRelPaths: unit.ownedRelPaths,
        updatedMs: nowValue,
      }))
      if (plan.sharedStepPaths.length > 0) {
        unitRecords.push({
          unitKey: makeWorkflowUnitKey(plan.runId, SHARED_STEP_UNIT_ID),
          runId: plan.runId,
          unitId: SHARED_STEP_UNIT_ID,
          kind: WorkflowUnitKind.make(plan.level === "epic" ? "slice" : "package"),
          waveIndex: WaveIndex.make(wavesOf(plan).length),
          status: unitStatusMap.get(SHARED_STEP_UNIT_ID) ?? "pending",
          ownedRelPaths: plan.sharedStepPaths,
          updatedMs: nowValue,
        })
      }

      rebuiltRuns.push({
        run: {
          runId: plan.runId,
          executionId,
          level: plan.level,
          planSha: plan.planSha,
          baseSha: plan.baseSha,
          state: runState,
          planJson,
          updatedMs: nowValue,
        },
        units: unitRecords,
        attempts: Array.from(attemptsMap.values()),
      })
    }

    return rebuiltRuns
  })

export { reconstructJournalViews, replayActivityMessage }
