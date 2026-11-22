import { Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  AgentFailureReason,
  type AttemptNumber,
  CompiledPlan,
  type EscalationOrdinal,
  EscalationResolution,
  type GitCommonDirPath,
  type LeaseEpoch,
  LeaseFilePath,
  LeaseHolderId,
  MergeSliceWaveOutcome,
  type RunnerId,
  SeqKey,
  UnitAgentDispatchResult,
  type UnitMode,
  UnitOutcome,
  UnitRejection,
  type WorkUnitId,
  type WorkflowAttemptKey,
  type WorkflowAttemptRecord,
  type WorkflowAttemptVerdict,
  WorkflowExecutionId,
  type WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowRunState,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  type WorkflowTimestampMs,
  type WorkflowUnitRecord,
  type WorkflowUnitStatus,
  WriterLeaseHeldError,
  makeWorkflowAttemptKey,
  toBoundedReason,
} from "@harness/contract"
import type { OmnigraphClient } from "@harness/graph"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import {
  type WorkflowStoreQueryWithMetaResult,
  invokeWorkflowStoreQueryWithMeta,
  toWorkflowStoreUnavailableError,
} from "../omnigraph-workflow-store.js"
import { resolveWorkflowRuntimePaths } from "../worktree-repo-root.js"
import { decodeWriterLeaseRow, makeHeldLeaseError } from "./writer-lease-codec.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

const DEFAULT_FENCE_LOCK_PATH = LeaseFilePath.make("/harness/daemon.lock")
const NO_ACTIVE_LEASE_HOLDER = LeaseHolderId.make("no-active-lease")

/** Lease-fencing options for `WorkflowProjectionWriter`, `WorkflowReadModelQuery`, and `rebuildWorkflowReadModelViews`. */
export interface WorkflowReadModelLeaseFence {
  readonly expectedLeaseEpoch?: LeaseEpoch | undefined
  readonly expectedLeaseOwner?: string | undefined
  readonly ownerId?: LeaseHolderId | undefined
  readonly lockFilePath?: LeaseFilePath | undefined
  readonly commonGitDir?: GitCommonDirPath | undefined
}

/** Options for constructing workflow read-model projection writer / query layers and view rebuild. */
export interface WorkflowReadModelOptions extends WorkflowReadModelLeaseFence {
  readonly repoRoot?: AbsoluteRepoRoot | undefined
  readonly client?: Omnigraph | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly nowMs?: (() => number) | undefined
  readonly runLock?:
    | (<A, E>(runId: WorkflowRunId, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>)
    | undefined
  readonly readGate?: (<A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>) | undefined
}

export interface RebuiltRunBundle {
  readonly run: WorkflowRunRecord
  readonly units: ReadonlyArray<WorkflowUnitRecord>
  readonly attempts: ReadonlyArray<WorkflowAttemptRecord>
}

export const MAX_JOURNAL_SCAN_PAGES = 256
export const JOURNAL_PAGE_LIMIT = 1024

const resolveEffectiveLockFilePath = (
  options?: WorkflowReadModelOptions,
): LeaseFilePath | undefined => {
  if (options?.lockFilePath !== undefined) {
    return options.lockFilePath
  }
  if (options?.commonGitDir !== undefined) {
    return resolveWorkflowRuntimePaths(options.commonGitDir).lockFilePath
  }
  return undefined
}

const makeStoreTarget = (repoRoot: AbsoluteRepoRoot, options?: WorkflowReadModelOptions) => {
  const lockFilePath = resolveEffectiveLockFilePath(options)
  return {
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
    ...(lockFilePath !== undefined ? { lockFilePath } : {}),
  }
}

const preserveStoreOrLeaseError = (
  operation: WorkflowStoreOperation,
  err: unknown,
): WorkflowStoreUnavailableError | WriterLeaseHeldError =>
  err instanceof WriterLeaseHeldError ? err : toWorkflowStoreUnavailableError(operation, err)

const verifyReadModelLeaseFence = (
  target: ReturnType<typeof makeStoreTarget>,
  operation: WorkflowStoreOperation,
  options?: WorkflowReadModelOptions,
): Effect.Effect<string | undefined, WorkflowStoreUnavailableError | WriterLeaseHeldError> =>
  Effect.gen(function* () {
    const expectedEpoch = options?.expectedLeaseEpoch
    if (expectedEpoch === undefined) {
      return undefined
    }
    const lockPath = target.lockFilePath ?? DEFAULT_FENCE_LOCK_PATH
    const leaseMeta = yield* invokeWorkflowStoreQueryWithMeta({
      ...target,
      operation,
      queryName: "wf_get_writer_lease",
      params: { name: "engine" },
      expectMutation: false,
    }).pipe(Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)))

    const firstRow = leaseMeta.rows[0]
    if (firstRow === undefined) {
      return yield* new WriterLeaseHeldError({
        holderId: NO_ACTIVE_LEASE_HOLDER,
        lockFilePath: lockPath,
      })
    }

    const decoded = yield* match(decodeWriterLeaseRow(firstRow))
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(toWorkflowStoreUnavailableError(operation, new Error(failure))),
      )
      .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
      .exhaustive()

    const ownerMismatch =
      (options?.expectedLeaseOwner !== undefined &&
        decoded.row.owner !== options.expectedLeaseOwner) ||
      (options?.ownerId !== undefined && decoded.parsedOwner.holderId !== options.ownerId)
    if (decoded.row.leaseEpoch !== expectedEpoch || ownerMismatch) {
      return yield* makeHeldLeaseError(
        decoded.parsedOwner.holderId,
        decoded.row.leaseEpoch,
        lockPath,
        decoded.parsedOwner.holderPid,
      )
    }

    return leaseMeta.graphCommitId ?? undefined
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

const moveRunningToWaiting = (state: WorkflowRunState): WorkflowRunState =>
  match(state)
    .with("running", () => "waiting" as const)
    .with("waiting", "completed", "aborted", (s) => s)
    .exhaustive()

const moveWaitingToRunning = (
  state: WorkflowRunState,
  hasTerminalRunReply: boolean,
): WorkflowRunState =>
  hasTerminalRunReply
    ? state
    : match(state)
        .with("waiting", () => "running" as const)
        .with("running", "completed", "aborted", (s) => s)
        .exhaustive()

const runnerOfMode = (mode: UnitMode): RunnerId | undefined =>
  match(mode)
    .with({ _tag: "Automatic" }, (automatic) => automatic.runner)
    .with({ _tag: "Manual" }, () => undefined)
    .exhaustive()

const findSliceByBranch = (plan: CompiledPlan, branch: string) =>
  plan.units.find((u) =>
    match(u)
      .with({ _tag: "SliceUnit" }, (s) => s.branch === branch)
      .with({ _tag: "PackageUnit" }, () => false)
      .exhaustive(),
  )

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

const decodeUnitAgentDispatchResultOption = Schema.decodeUnknownOption(UnitAgentDispatchResult)
const decodeUnitOutcomeOption = Schema.decodeUnknownOption(UnitOutcome)
const decodeMergeOutcomeOption = Schema.decodeUnknownOption(MergeSliceWaveOutcome)
const decodeEscalationResolutionOption = Schema.decodeUnknownOption(EscalationResolution)
const decodeExecutionIdOption = Schema.decodeUnknownOption(WorkflowExecutionId)
const decodeSeqKeyOption = Schema.decodeUnknownOption(SeqKey)

const scanAllJournalRows = (
  repoRoot: AbsoluteRepoRoot,
  queryName: "wf_all_entities" | "wf_all_replies",
  operation: WorkflowStoreOperation,
  options?: WorkflowReadModelOptions,
): Effect.Effect<
  ReadonlyArray<Readonly<Record<string, unknown>>>,
  WorkflowStoreUnavailableError | WriterLeaseHeldError
> =>
  Effect.gen(function* () {
    const target = makeStoreTarget(repoRoot, options)
    const collected: Array<Readonly<Record<string, unknown>>> = []
    let afterSeqKey: SeqKey | "" = ""
    let completed = false

    for (let page = 0; page < MAX_JOURNAL_SCAN_PAGES; page += 1) {
      const res: WorkflowStoreQueryWithMetaResult = yield* invokeWorkflowStoreQueryWithMeta({
        ...target,
        operation,
        queryName,
        params: { afterSeqKey },
        expectMutation: false,
      }).pipe(Effect.mapError((err) => preserveStoreOrLeaseError(operation, err)))
      collected.push(...res.rows)
      if (res.rows.length < JOURNAL_PAGE_LIMIT) {
        completed = true
        break
      }
      const lastRow = res.rows[res.rows.length - 1]
      const nextSeqRaw = lastRow !== undefined ? optionalNonEmptyString(lastRow.seqKey) : undefined
      const nextSeq =
        nextSeqRaw !== undefined ? unwrapOption(decodeSeqKeyOption(nextSeqRaw)) : undefined
      if (nextSeq === undefined) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Journal scan '${queryName}' encountered missing or invalid seqKey on page ${page + 1}`,
          ),
        })
      }
      if (nextSeq === afterSeqKey) {
        return yield* new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(
            `Journal scan '${queryName}' stalled at cursor seqKey '${afterSeqKey}' on page ${page + 1}`,
          ),
        })
      }
      afterSeqKey = nextSeq
    }

    if (!completed) {
      return yield* new WorkflowStoreUnavailableError({
        operation,
        reason: toBoundedReason(
          `Journal scan '${queryName}' exceeded MAX_JOURNAL_SCAN_PAGES (${MAX_JOURNAL_SCAN_PAGES}) with additional rows remaining`,
        ),
      })
    }

    return collected
  })

const classifyWorkflowResultReply = (
  replyPayload: string | undefined,
  operation: WorkflowStoreOperation,
  contextLabel: string,
): Effect.Effect<
  { readonly state: WorkflowRunState; readonly successValue: Option.Option<unknown> },
  WorkflowStoreUnavailableError
> => {
  if (replyPayload === undefined) {
    return Effect.succeed({ state: "running" as const, successValue: Option.none() })
  }
  return match(decodeWorkflowResultReplyOption(replyPayload))
    .with({ _tag: "None" }, () =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation,
          reason: toBoundedReason(`Undecodable with_exit reply payload for ${contextLabel}`),
        }),
      ),
    )
    .with({ _tag: "Some" }, ({ value: decoded }) =>
      Effect.succeed(
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
      ),
    )
    .exhaustive()
}

const recordUnitOutcome = (params: {
  readonly operation: WorkflowStoreOperation
  readonly runId: WorkflowRunId
  readonly attempt?: AttemptNumber | undefined
  readonly escalationOrdinal?: EscalationOrdinal | undefined
  readonly runner?: RunnerId | undefined
  readonly rawOutcome: unknown
  readonly nowValue: WorkflowTimestampMs
  readonly unitStatusMap: Map<WorkUnitId, WorkflowUnitStatus>
  readonly attemptsMap: Map<WorkflowAttemptKey, WorkflowAttemptRecord>
  readonly contextLabel: string
}): Effect.Effect<void, WorkflowStoreUnavailableError> =>
  match(decodeUnitOutcomeOption(params.rawOutcome))
    .with({ _tag: "None" }, () =>
      Effect.fail(
        new WorkflowStoreUnavailableError({
          operation: params.operation,
          reason: toBoundedReason(
            `Undecodable UnitOutcome payload for ${params.contextLabel} in run '${params.runId}'`,
          ),
        }),
      ),
    )
    .with({ _tag: "Some" }, ({ value: outcome }) =>
      !params.unitStatusMap.has(outcome.unitId)
        ? Effect.fail(
            new WorkflowStoreUnavailableError({
              operation: params.operation,
              reason: toBoundedReason(
                `UnitOutcome for ${params.contextLabel} targets unknown unit '${outcome.unitId}' in run '${params.runId}'`,
              ),
            }),
          )
        : Effect.sync(() => {
            match(outcome)
              .with({ _tag: "Completed" }, (completed) => {
                const attemptKey = makeWorkflowAttemptKey(
                  params.runId,
                  completed.unitId,
                  completed.attempt,
                  params.escalationOrdinal,
                )
                params.unitStatusMap.set(completed.unitId, "completed")
                params.attemptsMap.set(attemptKey, {
                  attemptKey,
                  runId: params.runId,
                  unitId: completed.unitId,
                  attempt: completed.attempt,
                  verdict: "completed" satisfies WorkflowAttemptVerdict,
                  ...(params.runner !== undefined ? { runner: params.runner } : {}),
                  packageStampHash: completed.packageStampHash,
                  updatedMs: params.nowValue,
                })
              })
              .with({ _tag: "Rejected" }, (rejected) => {
                const attemptKey = makeWorkflowAttemptKey(
                  params.runId,
                  rejected.unitId,
                  rejected.attempt,
                  params.escalationOrdinal,
                )
                if (params.unitStatusMap.get(rejected.unitId) === "pending") {
                  params.unitStatusMap.set(rejected.unitId, "dispatched")
                }
                params.attemptsMap.set(attemptKey, {
                  attemptKey,
                  runId: params.runId,
                  unitId: rejected.unitId,
                  attempt: rejected.attempt,
                  verdict: "rejected" satisfies WorkflowAttemptVerdict,
                  ...(params.runner !== undefined ? { runner: params.runner } : {}),
                  rejection: rejected.rejection,
                  updatedMs: params.nowValue,
                })
              })
              .with({ _tag: "Escalated" }, (escalated) => {
                params.unitStatusMap.set(escalated.unitId, "escalated")
                if (params.attempt !== undefined) {
                  const attemptKey = makeWorkflowAttemptKey(
                    params.runId,
                    escalated.unitId,
                    params.attempt,
                    params.escalationOrdinal,
                  )
                  const rejection: UnitRejection = match(escalated.escalation)
                    .with({ _tag: "AuthRequired" }, (e) =>
                      UnitRejection.cases.AgentFailed.make({
                        reason: AgentFailureReason.make(
                          `Authentication required for runner '${e.runner}'`,
                        ),
                      }),
                    )
                    .with({ _tag: "RetryBudgetExhausted" }, (e) => e.lastRejection)
                    .with({ _tag: "MergeConflict" }, (e) =>
                      UnitRejection.cases.AgentFailed.make({
                        reason: AgentFailureReason.make(`Merge conflict on branch '${e.branch}'`),
                      }),
                    )
                    .exhaustive()
                  params.attemptsMap.set(attemptKey, {
                    attemptKey,
                    runId: params.runId,
                    unitId: escalated.unitId,
                    attempt: params.attempt,
                    verdict: "rejected" satisfies WorkflowAttemptVerdict,
                    ...(params.runner !== undefined ? { runner: params.runner } : {}),
                    rejection,
                    updatedMs: params.nowValue,
                  })
                }
              })
              .exhaustive()
          }),
    )
    .exhaustive()

export {
  abortUnlessCompleted,
  classifyWorkflowResultReply,
  decodeActivityPayloadOption,
  decodeDeferredPayloadOption,
  decodeEscalationResolutionOption,
  decodeExecutionIdOption,
  decodeMergeOutcomeOption,
  decodeRunPayloadOption,
  decodeUnitAgentDispatchResultOption,
  findSliceByBranch,
  makeStoreTarget,
  moveRunningToWaiting,
  moveWaitingToRunning,
  optionalNonEmptyString,
  preserveStoreOrLeaseError,
  recordUnitOutcome,
  runnerOfMode,
  scanAllJournalRows,
  unwrapOption,
  verifyReadModelLeaseFence,
}
