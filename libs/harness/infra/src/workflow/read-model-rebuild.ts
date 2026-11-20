import { Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  CompiledPlan,
  EscalationResolution,
  type LeaseEpoch,
  type LeaseFilePath,
  MergeSliceWaveOutcome,
  PlanJsonPayload,
  RejectionJsonPayload,
  SHARED_STEP_UNIT_ID,
  SeqKey,
  UnitOutcome,
  WaveIndex,
  WorkflowAttemptKey,
  type WorkflowAttemptRecord,
  type WorkflowAttemptVerdict,
  WorkflowExecutionId,
  WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowRunState,
  WorkflowStoreOperation,
  type WorkflowStoreUnavailableError,
  type WorkflowTimestampMs,
  WorkflowUnitKey,
  WorkflowUnitKind,
  type WorkflowUnitRecord,
  type WorkflowUnitStatus,
  compareCodeUnits,
  wavesOf,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import {
  type WorkflowStoreQueryWithMetaResult,
  invokeWorkflowStoreQueryWithMeta,
  toWorkflowStoreUnavailableError,
} from "../omnigraph-workflow-store.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

/** Options for constructing workflow read-model projection writer / query layers and view rebuild. */
export interface WorkflowReadModelOptions {
  readonly repoRoot?: AbsoluteRepoRoot | undefined
  readonly client?: Omnigraph | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly nowMs?: (() => number) | undefined
  readonly expectedLeaseEpoch?: LeaseEpoch | undefined
  readonly expectedLeaseOwner?: string | undefined
  readonly lockFilePath?: LeaseFilePath | undefined
}

const MAX_JOURNAL_SCAN_PAGES = 256
const JOURNAL_PAGE_LIMIT = 1024

const makeStoreTarget = (repoRoot: AbsoluteRepoRoot, options?: WorkflowReadModelOptions) => ({
  repoRoot,
  client: options?.client,
  hostIo: options?.hostIo ?? nodeSyncHostIo,
  env: options?.env,
  ...(options?.expectedLeaseEpoch !== undefined
    ? { expectedLeaseEpoch: options.expectedLeaseEpoch }
    : {}),
  ...(options?.expectedLeaseOwner !== undefined
    ? { expectedLeaseOwner: options.expectedLeaseOwner }
    : {}),
  ...(options?.lockFilePath !== undefined ? { lockFilePath: options.lockFilePath } : {}),
})

const optionalNonEmptyString = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw.trim().length > 0 ? raw : undefined

const unwrapOption = <A>(opt: Option.Option<A>): A | undefined =>
  match(opt)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

const abortUnlessCompleted = (state: WorkflowRunState): WorkflowRunState =>
  match(state)
    .with("completed", () => "completed" as const)
    .with("running", "waiting", "aborted", () => "aborted" as const)
    .exhaustive()

const RunPayloadEnvelopeSchema = Schema.fromJsonString(Schema.Struct({ plan: CompiledPlan }))
const decodeRunPayloadOption = Schema.decodeUnknownOption(RunPayloadEnvelopeSchema)

const WorkflowResultReplySchema = Schema.fromJsonString(
  Schema.Union([
    Schema.TaggedStruct("Success", {
      value: Schema.Union([
        Schema.TaggedStruct("Suspended", {}),
        Schema.TaggedStruct("Complete", {
          exit: Schema.Union([
            Schema.TaggedStruct("Success", { value: Schema.optional(Schema.Unknown) }),
            Schema.TaggedStruct("Failure", {}),
          ]),
        }),
      ]),
    }),
    Schema.TaggedStruct("Failure", {}),
  ]),
)
const decodeWorkflowResultReplyOption = Schema.decodeUnknownOption(WorkflowResultReplySchema)

const DeferredPayloadSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    exit: Schema.Union([
      Schema.TaggedStruct("Success", { value: Schema.Unknown }),
      Schema.TaggedStruct("Failure", {}),
    ]),
  }),
)
const decodeDeferredPayloadOption = Schema.decodeUnknownOption(DeferredPayloadSchema)

const ActivityPayloadSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    attempt: Schema.optional(Schema.Int),
  }),
)
const decodeActivityPayloadOption = Schema.decodeUnknownOption(ActivityPayloadSchema)

const decodeUnitOutcomeOption = Schema.decodeUnknownOption(UnitOutcome)
const decodeMergeOutcomeOption = Schema.decodeUnknownOption(MergeSliceWaveOutcome)
const decodeEscalationResolutionOption = Schema.decodeUnknownOption(EscalationResolution)
const decodeExecutionIdOption = Schema.decodeUnknownOption(WorkflowExecutionId)
const decodeWorkflowRunIdOption = Schema.decodeUnknownOption(WorkflowRunId)
const decodeSeqKeyOption = Schema.decodeUnknownOption(SeqKey)

const parseVerifyActivity = (
  name: string,
): { readonly unitId: string; readonly suffix: string } | undefined => {
  const unitMatch = /^VerifyUnit\/([^/]+)\/([1-3])(?:\/r(\d+))?$/.exec(name)
  if (unitMatch !== null && unitMatch[1] !== undefined && unitMatch[2] !== undefined) {
    const cycleSuffix = unitMatch[3] !== undefined ? `/r${unitMatch[3]}` : ""
    return { unitId: unitMatch[1], suffix: `${unitMatch[2]}${cycleSuffix}` }
  }
  const sharedMatch = /^VerifySharedStep\/([1-3])(?:\/r(\d+))?$/.exec(name)
  if (sharedMatch !== null && sharedMatch[1] !== undefined) {
    const cycleSuffix = sharedMatch[2] !== undefined ? `/r${sharedMatch[2]}` : ""
    return { unitId: SHARED_STEP_UNIT_ID, suffix: `${sharedMatch[1]}${cycleSuffix}` }
  }
  return undefined
}

const scanAllJournalRows = (
  repoRoot: AbsoluteRepoRoot,
  queryName: "wf_all_entities" | "wf_all_replies",
  operation: WorkflowStoreOperation,
  options?: WorkflowReadModelOptions,
): Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, WorkflowStoreUnavailableError> =>
  Effect.gen(function* () {
    const target = makeStoreTarget(repoRoot, options)
    const collected: Array<Readonly<Record<string, unknown>>> = []
    let afterSeqKey: SeqKey | "" = ""
    for (let page = 0; page < MAX_JOURNAL_SCAN_PAGES; page += 1) {
      const res: WorkflowStoreQueryWithMetaResult = yield* invokeWorkflowStoreQueryWithMeta({
        ...target,
        operation,
        queryName,
        params: { afterSeqKey },
        expectMutation: false,
      }).pipe(Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)))
      collected.push(...res.rows)
      if (res.rows.length < JOURNAL_PAGE_LIMIT) {
        break
      }
      const lastRow = res.rows[res.rows.length - 1]
      const nextSeqRaw = lastRow !== undefined ? optionalNonEmptyString(lastRow.seqKey) : undefined
      const nextSeq =
        nextSeqRaw !== undefined ? unwrapOption(decodeSeqKeyOption(nextSeqRaw)) : undefined
      if (nextSeq === undefined || nextSeq === afterSeqKey) {
        break
      }
      afterSeqKey = nextSeq
    }
    return collected
  })

const classifyWorkflowResultReply = (
  replyPayload: string | undefined,
): { readonly state: WorkflowRunState; readonly successValue: Option.Option<unknown> } => {
  if (replyPayload === undefined) {
    return { state: "running", successValue: Option.none() }
  }
  return match(decodeWorkflowResultReplyOption(replyPayload))
    .with({ _tag: "None" }, () => ({ state: "running" as const, successValue: Option.none() }))
    .with({ _tag: "Some" }, ({ value: decoded }) =>
      match(decoded)
        .with({ _tag: "Failure" }, () => ({
          state: "aborted" as const,
          successValue: Option.none(),
        }))
        .with({ _tag: "Success" }, ({ value: inner }) =>
          match(inner)
            .with({ _tag: "Suspended" }, () => ({
              state: "waiting" as const,
              successValue: Option.none(),
            }))
            .with({ _tag: "Complete" }, ({ exit }) =>
              match(exit)
                .with({ _tag: "Success" }, ({ value }) => ({
                  state: "completed" as const,
                  successValue: Option.some(value),
                }))
                .with({ _tag: "Failure" }, () => ({
                  state: "aborted" as const,
                  successValue: Option.none(),
                }))
                .exhaustive(),
            )
            .exhaustive(),
        )
        .exhaustive(),
    )
    .exhaustive()
}

const recordUnitOutcome = (params: {
  readonly runId: WorkflowRunId
  readonly attemptKeySuffix: string
  readonly rawOutcome: unknown
  readonly nowValue: WorkflowTimestampMs
  readonly unitStatusMap: Map<string, WorkflowUnitStatus>
  readonly attemptsMap: Map<string, WorkflowAttemptRecord>
}): void => {
  match(decodeUnitOutcomeOption(params.rawOutcome))
    .with({ _tag: "None" }, () => undefined)
    .with({ _tag: "Some" }, ({ value: outcome }) => {
      const attemptKey = WorkflowAttemptKey.make(
        `${params.runId}/${outcome.unitId}#${params.attemptKeySuffix}`,
      )
      match(outcome)
        .with({ _tag: "Completed" }, (completed) => {
          params.unitStatusMap.set(completed.unitId, "completed")
          params.attemptsMap.set(attemptKey, {
            attemptKey,
            runId: params.runId,
            unitId: completed.unitId,
            attempt: completed.attempt,
            verdict: "completed" satisfies WorkflowAttemptVerdict,
            packageStampHash: completed.packageStampHash,
            updatedMs: params.nowValue,
          })
        })
        .with({ _tag: "Rejected" }, (rejected) => {
          if (params.unitStatusMap.get(rejected.unitId) === "pending") {
            params.unitStatusMap.set(rejected.unitId, "dispatched")
          }
          params.attemptsMap.set(attemptKey, {
            attemptKey,
            runId: params.runId,
            unitId: rejected.unitId,
            attempt: rejected.attempt,
            verdict: "rejected" satisfies WorkflowAttemptVerdict,
            rejection: RejectionJsonPayload.make(JSON.stringify(rejected.rejection)),
            updatedMs: params.nowValue,
          })
        })
        .with({ _tag: "Escalated" }, (escalated) => {
          params.unitStatusMap.set(escalated.unitId, "escalated")
        })
        .exhaustive()
    })
    .exhaustive()
}

const moveRunningToWaiting = (state: WorkflowRunState): WorkflowRunState =>
  match(state)
    .with("running", () => "waiting" as const)
    .with("waiting", "completed", "aborted", (s) => s)
    .exhaustive()

const moveWaitingToRunning = (state: WorkflowRunState, hasRunReply: boolean): WorkflowRunState =>
  hasRunReply
    ? state
    : match(state)
        .with("waiting", () => "running" as const)
        .with("running", "completed", "aborted", (s) => s)
        .exhaustive()

const findSliceByBranch = (plan: CompiledPlan, branch: string) =>
  plan.units.find((u) =>
    match(u)
      .with({ _tag: "SliceUnit" }, (s) => s.branch === branch)
      .with({ _tag: "PackageUnit" }, () => false)
      .exhaustive(),
  )

const replayActivityMessage = (params: {
  readonly plan: CompiledPlan
  readonly activityName: string
  readonly actReplyStr: string | undefined
  readonly hasRunReply: boolean
  readonly nowValue: WorkflowTimestampMs
  readonly unitStatusMap: Map<string, WorkflowUnitStatus>
  readonly attemptsMap: Map<string, WorkflowAttemptRecord>
  readonly getRunState: () => WorkflowRunState
  readonly setRunState: (state: WorkflowRunState) => void
}): void => {
  const { plan, activityName, actReplyStr, hasRunReply, unitStatusMap } = params
  const actReply = classifyWorkflowResultReply(actReplyStr)
  const actExitVal = unwrapOption(actReply.successValue)

  const dispatchMatch =
    /^(?:DispatchUnitAgent|ProjectUnitDispatched)\/([^/]+)\/([1-3])(?:\/r(\d+))?$/.exec(
      activityName,
    )
  if (dispatchMatch !== null && dispatchMatch[1] !== undefined) {
    if (unitStatusMap.get(dispatchMatch[1]) === "pending") {
      unitStatusMap.set(dispatchMatch[1], "dispatched")
    }
  }

  const escMatch = /^ProjectUnitEscalated\/([^/]+)\/(\d+)$/.exec(activityName)
  if (escMatch !== null && escMatch[1] !== undefined) {
    if (unitStatusMap.has(escMatch[1])) {
      unitStatusMap.set(escMatch[1], "escalated")
    }
    params.setRunState(moveRunningToWaiting(params.getRunState()))
  }

  const retryMatch = /^ProjectUnitEscalationRetried\/([^/]+)\/(\d+)$/.exec(activityName)
  if (retryMatch !== null && retryMatch[1] !== undefined) {
    if (unitStatusMap.has(retryMatch[1])) {
      unitStatusMap.set(retryMatch[1], "dispatched")
    }
    params.setRunState(moveWaitingToRunning(params.getRunState(), hasRunReply))
  }

  if (/^ProjectWaveMergeEscalated\/\d+\/\d+$/.test(activityName)) {
    params.setRunState(moveRunningToWaiting(params.getRunState()))
  }
  if (/^ProjectWaveMergeRetried\/\d+\/\d+$/.test(activityName)) {
    params.setRunState(moveWaitingToRunning(params.getRunState(), hasRunReply))
  }
  if (/^ProjectRunAborted(?:\/|$)/.test(activityName)) {
    params.setRunState(abortUnlessCompleted(params.getRunState()))
  }

  if (/^MergeSliceWave\/\d+(?:\/r\d+)?$/.test(activityName) && actExitVal !== undefined) {
    match(decodeMergeOutcomeOption(actExitVal))
      .with({ _tag: "None" }, () => undefined)
      .with({ _tag: "Some" }, ({ value: outcome }) =>
        match(outcome)
          .with({ _tag: "Conflict" }, ({ branch }) => {
            const slice = findSliceByBranch(plan, branch)
            if (slice !== undefined) {
              unitStatusMap.set(slice.unitId, "escalated")
            }
            params.setRunState(moveRunningToWaiting(params.getRunState()))
          })
          .with({ _tag: "Merged" }, ({ mergedBranches }) => {
            for (const branch of mergedBranches) {
              const slice = findSliceByBranch(plan, branch)
              if (slice !== undefined && unitStatusMap.get(slice.unitId) === "escalated") {
                unitStatusMap.set(slice.unitId, "completed")
              }
            }
          })
          .exhaustive(),
      )
      .exhaustive()
  }

  const verifyParsed = parseVerifyActivity(activityName)
  if (verifyParsed !== undefined && unitStatusMap.has(verifyParsed.unitId)) {
    if (unitStatusMap.get(verifyParsed.unitId) === "pending") {
      unitStatusMap.set(verifyParsed.unitId, "dispatched")
    }
    if (actExitVal !== undefined) {
      recordUnitOutcome({
        runId: plan.runId,
        attemptKeySuffix: verifyParsed.suffix,
        rawOutcome: actExitVal,
        nowValue: params.nowValue,
        unitStatusMap,
        attemptsMap: params.attemptsMap,
      })
    }
  }

  if (actReplyStr !== undefined) {
    match(actReply.state)
      .with("aborted", () => {
        params.setRunState(abortUnlessCompleted(params.getRunState()))
      })
      .with("running", "waiting", "completed", () => undefined)
      .exhaustive()
  }
}

export interface RebuiltRunBundle {
  readonly run: WorkflowRunRecord
  readonly units: ReadonlyArray<WorkflowUnitRecord>
  readonly attempts: ReadonlyArray<WorkflowAttemptRecord>
}

export interface ReconstructedJournalViews {
  readonly runIdsToDelete: ReadonlySet<WorkflowRunId>
  readonly rebuiltRuns: ReadonlyArray<RebuiltRunBundle>
}

/** Scans `WfMessage`/`WfReply` journal rows and reconstructs target `WfRun`/`WfUnit`/`WfAttempt` bundles. */
const reconstructJournalViews = (
  repoRoot: AbsoluteRepoRoot,
  operation: WorkflowStoreOperation,
  nowValue: WorkflowTimestampMs,
  options?: WorkflowReadModelOptions,
): Effect.Effect<ReconstructedJournalViews, WorkflowStoreUnavailableError> =>
  Effect.gen(function* () {
    const target = makeStoreTarget(repoRoot, options)
    const existingRunRows = yield* invokeWorkflowStoreQueryWithMeta({
      ...target,
      operation,
      queryName: "wf_list_runs",
      params: {},
      expectMutation: false,
    }).pipe(Effect.mapError((err) => toWorkflowStoreUnavailableError(operation, err)))

    const entityRows = yield* scanAllJournalRows(repoRoot, "wf_all_entities", operation, options)
    const replyRows = yield* scanAllJournalRows(repoRoot, "wf_all_replies", operation, options)

    const exitReplyByRequestId = new Map<string, string>()
    for (const reply of replyRows) {
      match(reply.kind)
        .with("with_exit", () => {
          const reqId = optionalNonEmptyString(reply.requestId)
          const payload = optionalNonEmptyString(reply.payload)
          if (reqId !== undefined && payload !== undefined) {
            exitReplyByRequestId.set(reqId, payload)
          }
        })
        .otherwise(() => undefined)
    }

    const messagesByExecutionId = new Map<string, Array<Readonly<Record<string, unknown>>>>()
    for (const msg of entityRows) {
      const executionId =
        msg.entityType === "Workflow/HarnessTaskWorkflow"
          ? optionalNonEmptyString(msg.entityId)
          : undefined
      if (executionId === undefined) {
        continue
      }
      const list = messagesByExecutionId.get(executionId) ?? []
      list.push(msg)
      messagesByExecutionId.set(executionId, list)
    }

    const runIdsToDelete = new Set<WorkflowRunId>(
      existingRunRows.rows.flatMap((row) => {
        const id = unwrapOption(decodeWorkflowRunIdOption(row.runId))
        return id !== undefined ? [id] : []
      }),
    )
    const rebuiltRuns: Array<RebuiltRunBundle> = []

    for (const [rawExecutionId, rawMessages] of messagesByExecutionId.entries()) {
      const messages = [...rawMessages].sort((a, b) =>
        compareCodeUnits(
          optionalNonEmptyString(a.seqKey) ?? "",
          optionalNonEmptyString(b.seqKey) ?? "",
        ),
      )
      const executionId = unwrapOption(decodeExecutionIdOption(rawExecutionId))
      const runMsg = messages.find((m) => m.tag === "run")
      const runPayloadStr =
        runMsg !== undefined ? optionalNonEmptyString(runMsg.payload) : undefined
      const plan =
        runPayloadStr !== undefined
          ? unwrapOption(decodeRunPayloadOption(runPayloadStr))?.plan
          : undefined
      if (executionId === undefined || runMsg === undefined || plan === undefined) {
        continue
      }
      runIdsToDelete.add(plan.runId)

      const runRequestId = optionalNonEmptyString(runMsg.requestId)
      const runReplyPayload =
        runRequestId !== undefined ? exitReplyByRequestId.get(runRequestId) : undefined
      let runState: WorkflowRunState = classifyWorkflowResultReply(runReplyPayload).state

      const unitStatusMap = new Map<string, WorkflowUnitStatus>()
      for (const unit of plan.units) {
        unitStatusMap.set(unit.unitId, "pending")
      }
      if (plan.sharedStepPaths.length > 0) {
        unitStatusMap.set(SHARED_STEP_UNIT_ID, "pending")
      }
      const attemptsMap = new Map<string, WorkflowAttemptRecord>()

      for (const msg of messages) {
        if (msg.tag === "deferred") {
          const payloadStr = optionalNonEmptyString(msg.payload)
          const deferred =
            payloadStr !== undefined
              ? unwrapOption(decodeDeferredPayloadOption(payloadStr))
              : undefined
          if (deferred === undefined) {
            continue
          }
          if (deferred.name === "Workflow/InterruptSignal") {
            runState = abortUnlessCompleted(runState)
            continue
          }
          const deferredVal = unwrapOption(
            match(deferred.exit)
              .with({ _tag: "Success" }, ({ value }) => Option.some(value))
              .with({ _tag: "Failure" }, () => Option.none())
              .exhaustive(),
          )
          const unitMatch = /^unit\/([^/]+)\/([1-3])(?:\/r(\d+))?$/.exec(deferred.name)
          if (unitMatch !== null && unitMatch[1] !== undefined && unitMatch[2] !== undefined) {
            const targetUnitId = unitMatch[1]
            const cycleSuffix = unitMatch[3] !== undefined ? `/r${unitMatch[3]}` : ""
            if (unitStatusMap.has(targetUnitId) && deferredVal !== undefined) {
              recordUnitOutcome({
                runId: plan.runId,
                attemptKeySuffix: `${unitMatch[2]}${cycleSuffix}`,
                rawOutcome: deferredVal,
                nowValue,
                unitStatusMap,
                attemptsMap,
              })
            }
            continue
          }
          const escMatch = /^escalation\/([^/]+)\/(\d+)$/.exec(deferred.name)
          if (escMatch !== null && escMatch[1] !== undefined && deferredVal !== undefined) {
            const targetUnitId = escMatch[1]
            const resolution = unwrapOption(decodeEscalationResolutionOption(deferredVal))
            if (resolution !== undefined) {
              match(resolution.decision)
                .with("abort", () => {
                  if (unitStatusMap.has(targetUnitId)) {
                    unitStatusMap.set(targetUnitId, "escalated")
                  }
                  runState = abortUnlessCompleted(runState)
                })
                .with("retry", () => {
                  if (unitStatusMap.has(targetUnitId)) {
                    unitStatusMap.set(targetUnitId, "dispatched")
                  }
                  runState = moveWaitingToRunning(runState, runReplyPayload !== undefined)
                })
                .exhaustive()
            }
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
            continue
          }
          const actReqId = optionalNonEmptyString(msg.requestId)
          const actReplyStr =
            actReqId !== undefined ? exitReplyByRequestId.get(actReqId) : undefined
          replayActivityMessage({
            plan,
            activityName: activity.name,
            actReplyStr,
            hasRunReply: runReplyPayload !== undefined,
            nowValue,
            unitStatusMap,
            attemptsMap,
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
        unitKey: WorkflowUnitKey.make(`${plan.runId}/${unit.unitId}`),
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
          unitKey: WorkflowUnitKey.make(`${plan.runId}/${SHARED_STEP_UNIT_ID}`),
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

    return { runIdsToDelete, rebuiltRuns }
  })

export { makeStoreTarget, optionalNonEmptyString, reconstructJournalViews, unwrapOption }
