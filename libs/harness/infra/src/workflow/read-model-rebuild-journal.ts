import { Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  CompiledPlan,
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
  decodeMatchedWorkUnitId,
  decodeMergeOutcomeOption,
  decodeRunPayloadOption,
  findSliceByBranch,
  moveRunningToWaiting,
  moveWaitingToRunning,
  optionalNonEmptyString,
  parseCycleTuple,
  parseVerifyActivity,
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

  const dispatchMatch =
    /^(?:DispatchUnitAgent|ProjectUnitDispatched)\/([^/]+)\/([1-3])(?:\/r(\d+))?$/.exec(
      activityName,
    )
  if (dispatchMatch !== null && dispatchMatch[1] !== undefined) {
    const unitId = yield* decodeMatchedWorkUnitId(operation, dispatchMatch[1], activityName)
    if (unitStatusMap.get(unitId) === "pending") {
      unitStatusMap.set(unitId, "dispatched")
    }
  }

  const escMatch = /^ProjectUnitEscalated\/([^/]+)\/(\d+)$/.exec(activityName)
  if (escMatch !== null && escMatch[1] !== undefined) {
    const unitId = yield* decodeMatchedWorkUnitId(operation, escMatch[1], activityName)
    if (unitStatusMap.has(unitId)) {
      unitStatusMap.set(unitId, "escalated")
    }
    params.setRunState(moveRunningToWaiting(params.getRunState()))
  }

  const retryMatch = /^ProjectUnitEscalationRetried\/([^/]+)\/(\d+)$/.exec(activityName)
  if (retryMatch !== null && retryMatch[1] !== undefined) {
    const unitId = yield* decodeMatchedWorkUnitId(operation, retryMatch[1], activityName)
    if (unitStatusMap.has(unitId)) {
      unitStatusMap.set(unitId, "dispatched")
    }
    params.setRunState(moveWaitingToRunning(params.getRunState(), hasRunReply))
  }

  if (/^ProjectWaveMergeEscalated\/\d+\/\d+$/.test(activityName)) {
    params.setRunState(moveRunningToWaiting(params.getRunState()))
  }
  if (/^ProjectWaveMergeRetried\/\d+\/\d+$/.test(activityName)) {
    params.setRunState(moveWaitingToRunning(params.getRunState(), hasRunReply))
  }
  if (activityName === "ProjectRunWaitingLlmPhase") {
    params.setRunState(moveRunningToWaiting(params.getRunState()))
  }
  if (activityName === "ProjectRunCompleted" && params.getRunState() !== "aborted") {
    params.setRunState("completed")
  }
  if (/^ProjectRunAborted(?:\/|$)/.test(activityName)) {
    params.setRunState(abortUnlessCompleted(params.getRunState()))
  }

  if (/^MergeSliceWave\/\d+(?:\/r\d+)?$/.test(activityName) && actExitVal !== undefined) {
    yield* match(decodeMergeOutcomeOption(actExitVal))
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
      .exhaustive()
  }

  const verifyParsed = parseVerifyActivity(activityName)
  yield* match(verifyParsed)
    .with({ _tag: "NotVerify" }, () => Effect.void)
    .with({ _tag: "Invalid" }, ({ reason }) =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(reason),
        }),
      ),
    )
    .with({ _tag: "Parsed" }, (parsed) =>
      Effect.gen(function* () {
        if (!unitStatusMap.has(parsed.unitId)) {
          return yield* new WorkflowStoreUnavailableError({
            operation,
            reason: toBoundedReason(
              `Verify activity '${activityName}' targets unknown unit '${parsed.unitId}' in run '${plan.runId}'`,
            ),
          })
        }
        if (unitStatusMap.get(parsed.unitId) === "pending") {
          unitStatusMap.set(parsed.unitId, "dispatched")
        }
        if (actExitVal !== undefined) {
          yield* recordUnitOutcome({
            operation,
            runId: plan.runId,
            escalationOrdinal: parsed.escalationOrdinal,
            rawOutcome: actExitVal,
            nowValue: params.nowValue,
            unitStatusMap,
            attemptsMap: params.attemptsMap,
            contextLabel: `activity '${activityName}'`,
          })
        }
      }),
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
          if (deferred.name === "Workflow/InterruptSignal") {
            runState = abortUnlessCompleted(runState)
            continue
          }
          if (deferred.name === "llm-phase-done") {
            runState = moveWaitingToRunning(runState, runReplyPayload !== undefined)
            continue
          }
          const deferredVal = unwrapOption(
            match(deferred.exit)
              .with({ _tag: "Success" }, ({ value }) => Option.some(value))
              .with({ _tag: "Failure" }, () => Option.none())
              .exhaustive(),
          )
          if (deferred.name.startsWith("unit/")) {
            const unitMatch = /^unit\/([^/]+)\/([1-3])(?:\/r(\d+))?$/.exec(deferred.name)
            if (unitMatch === null || unitMatch[1] === undefined || unitMatch[2] === undefined) {
              return yield* new WorkflowStoreUnavailableError({
                operation,
                reason: toBoundedReason(
                  `Malformed unit deferred name '${deferred.name}' in workflow run '${plan.runId}'`,
                ),
              })
            }
            const parsedUnit = parseCycleTuple(unitMatch[1], unitMatch[2], unitMatch[3])
            if (parsedUnit === undefined || !unitStatusMap.has(parsedUnit.unitId)) {
              return yield* new WorkflowStoreUnavailableError({
                operation,
                reason: toBoundedReason(
                  `Unit deferred '${deferred.name}' targets unknown or invalid unit in run '${plan.runId}'`,
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
              escalationOrdinal: parsedUnit.escalationOrdinal,
              rawOutcome: deferredVal,
              nowValue,
              unitStatusMap,
              attemptsMap,
              contextLabel: `deferred '${deferred.name}'`,
            })
            continue
          }
          if (deferred.name.startsWith("escalation/")) {
            const escMatch = /^escalation\/([^/]+)\/(\d+)$/.exec(deferred.name)
            if (escMatch === null || escMatch[1] === undefined) {
              return yield* new WorkflowStoreUnavailableError({
                operation,
                reason: toBoundedReason(
                  `Malformed escalation deferred name '${deferred.name}' in workflow run '${plan.runId}'`,
                ),
              })
            }
            const targetUnitId = yield* decodeMatchedWorkUnitId(
              operation,
              escMatch[1],
              deferred.name,
            )
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
                if (unitStatusMap.has(targetUnitId)) {
                  unitStatusMap.set(targetUnitId, "escalated")
                }
                runState = abortUnlessCompleted(runState)
              })
              .with("retry", () => {
                if (unitStatusMap.has(targetUnitId)) {
                  const nextStatus = mergeConflictUnits.has(targetUnitId)
                    ? ("completed" as const)
                    : ("dispatched" as const)
                  unitStatusMap.set(targetUnitId, nextStatus)
                }
                mergeConflictUnits.delete(targetUnitId)
                runState = moveWaitingToRunning(runState, runReplyPayload !== undefined)
              })
              .exhaustive()
          }
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
