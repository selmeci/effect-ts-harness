import { Cause, Context, Effect, Exit, Option, Schema, Semaphore, SynchronizedRef } from "effect"
import { WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  AttemptNumber,
  CompiledPlan,
  EscalationOrdinal,
  EscalationResolution,
  type LeaseEpoch,
  type UnitEscalation,
  UnitOutcome,
  type UnitRejection,
  type ValidatedWorktreeRoot,
  type WorkUnitId,
  type WorkflowAttemptRecord,
  type WorkflowDaemonCapability,
  type WorkflowExecutionId,
  type WorkflowRpcErrorEnvelope,
  WorkflowRpcRequestId,
  type WorkflowRpcResult,
  type WorkflowRpcSuccessEnvelope,
  WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowRunState,
  type WorkflowStoreFailureReason,
  type WorkflowStoreUnavailableError,
  type WorkflowUnitRecord,
  type WorkflowUnitStatus,
  type WriterLeaseHeldError,
  compareCodeUnits,
  toBoundedReason,
} from "@harness/contract"
import {
  HarnessTaskWorkflow,
  executionIdOf,
  makeUnitCompletionDeferred,
  makeUnitEscalationDeferred,
} from "@harness/gates"
import { validateWorktreeRepoRoot } from "@harness/infra"
import type { DaemonRequestScopeAllowed } from "./workflow-daemon-helper.js"
import {
  MAX_CONCURRENT_RUN_LOCKS,
  type WorkflowDaemonRuntime,
} from "./workflow-engine-daemon-helper.js"

const MAX_ESCALATION_CYCLES = 100
const ATTEMPTS: readonly [AttemptNumber, AttemptNumber, AttemptNumber] = [
  AttemptNumber.make(1),
  AttemptNumber.make(2),
  AttemptNumber.make(3),
]

const PlanJsonCodec = Schema.fromJsonString(CompiledPlan)
const decodePlanJsonOption = Schema.decodeUnknownOption(PlanJsonCodec)
const decodeUnitOutcomeOption = Schema.decodeUnknownOption(UnitOutcome)
const decodeEscalationResolutionOption = Schema.decodeUnknownOption(EscalationResolution)

export const hasOutcomeTag = <T extends UnitOutcome["_tag"]>(
  opt: Option.Option<UnitOutcome>,
  tag: T,
): opt is Option.Some<Extract<UnitOutcome, { readonly _tag: T }>> =>
  match(opt)
    .with({ _tag: "None" }, () => false)
    .with({ _tag: "Some" }, ({ value }) =>
      match(value)
        .with({ _tag: "Completed" }, () => tag === "Completed")
        .with({ _tag: "Rejected" }, () => tag === "Rejected")
        .with({ _tag: "Escalated" }, () => tag === "Escalated")
        .exhaustive(),
    )
    .exhaustive()

export const hasAttemptVerdict = <V extends WorkflowAttemptRecord["verdict"]>(
  record: WorkflowAttemptRecord,
  expected: V,
): record is Extract<WorkflowAttemptRecord, { readonly verdict: V }> =>
  match(record.verdict)
    .with("dispatched", (v) => v === expected)
    .with("completed", (v) => v === expected)
    .with("rejected", (v) => v === expected)
    .exhaustive()

export const extractLastRejection = (
  attemptOutcomes: ReadonlyArray<{
    readonly attempt: AttemptNumber
    readonly outcome: Option.Option<UnitOutcome>
  }>,
  attemptsFromReadModel: ReadonlyArray<WorkflowAttemptRecord>,
  unitId: WorkUnitId,
): Effect.Effect<UnitRejection, WorkflowStoreFailureReason> => {
  for (let i = attemptOutcomes.length - 1; i >= 0; i -= 1) {
    const rejected = match(attemptOutcomes[i]!.outcome)
      .with({ _tag: "None" }, () => undefined)
      .with({ _tag: "Some" }, ({ value }) =>
        match(value)
          .with({ _tag: "Rejected" }, (r) => r.rejection)
          .with({ _tag: "Completed" }, { _tag: "Escalated" }, () => undefined)
          .exhaustive(),
      )
      .exhaustive()
    if (rejected !== undefined) {
      return Effect.succeed(rejected)
    }
  }
  const unitAttempts = attemptsFromReadModel
    .filter(
      (a): a is Extract<WorkflowAttemptRecord, { readonly verdict: "rejected" }> =>
        a.unitId === unitId && hasAttemptVerdict(a, "rejected"),
    )
    .sort((a, b) => b.attempt - a.attempt)
  const latestReadAttempt = unitAttempts[0]
  if (latestReadAttempt !== undefined) {
    return Effect.succeed(latestReadAttempt.rejection)
  }
  return Effect.fail(
    toBoundedReason(`No recorded UnitRejection found for escalated unit '${unitId}'`),
  )
}

export const findExplicitEscalation = (
  attemptOutcomes: ReadonlyArray<{
    readonly attempt: AttemptNumber
    readonly outcome: Option.Option<UnitOutcome>
  }>,
): UnitEscalation | undefined => {
  for (const item of attemptOutcomes) {
    const esc = match(item.outcome)
      .with({ _tag: "None" }, () => undefined)
      .with({ _tag: "Some" }, ({ value }) =>
        match(value)
          .with({ _tag: "Escalated" }, (e) => e.escalation)
          .with({ _tag: "Completed" }, { _tag: "Rejected" }, () => undefined)
          .exhaustive(),
      )
      .exhaustive()
    if (esc !== undefined) {
      return esc
    }
  }
  return undefined
}

export const storeOrLeaseToBoundedReason = (
  err: WorkflowStoreUnavailableError | WriterLeaseHeldError,
): WorkflowStoreFailureReason =>
  match(err)
    .with({ _tag: "WorkflowStoreUnavailableError" }, (e) => e.reason)
    .with({ _tag: "WriterLeaseHeldError" }, (e) => toBoundedReason(e.message))
    .exhaustive()

export interface WorkflowRpcHandlerInput {
  readonly requestId: string
  readonly rawPayload: Readonly<Record<string, unknown>>
  readonly scope: DaemonRequestScopeAllowed
  readonly writerLeaseEpoch?: LeaseEpoch | undefined
  readonly runtime?: WorkflowDaemonRuntime | undefined
}

const RebuildRpcGateHeldRef = Context.Reference<boolean>("WorkflowRpcDaemon/RebuildRpcGateHeld", {
  defaultValue: () => false,
})

const withRebuildRpcGate = <A, E>(
  runtime: WorkflowDaemonRuntime,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const alreadyHeld = yield* RebuildRpcGateHeldRef
    if (alreadyHeld) {
      return yield* effect
    }
    return yield* runtime.rebuildRpcGateSemaphore.withPermits(1)(
      Effect.provideService(effect, RebuildRpcGateHeldRef, true),
    )
  })

const acquireMutexFromRef = <K>(
  mutexesRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<K, Semaphore.Semaphore>>,
  key: K,
): Effect.Effect<Semaphore.Semaphore> =>
  SynchronizedRef.modifyEffect(mutexesRef, (map) => {
    const existing = map.get(key)
    if (existing !== undefined) {
      return Effect.succeed([existing, map] as const)
    }
    const sem = Semaphore.makeUnsafe(1)
    return Effect.succeed([sem, new Map(map).set(key, sem)] as const)
  })

/** Serializes RPC operations targeting the same `runId` under `rebuildRpcGateSemaphore`. */
export const withRunLock = <A, E>(
  runtime: WorkflowDaemonRuntime,
  runId: WorkflowRunId,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  withRebuildRpcGate(
    runtime,
    acquireMutexFromRef(runtime.runMutexesRef, runId).pipe(
      Effect.flatMap((sem) => sem.withPermit(effect)),
    ),
  )

/**
 * Serializes `workflow.ship` operations targeting the same canonical `worktreeRoot`.
 * Lock order invariant: ALWAYS acquire `withWorktreeShipLock` OUTSIDE `withRunLock`.
 */
export const withWorktreeShipLock = <A, E>(
  runtime: WorkflowDaemonRuntime,
  worktreeRoot: AbsoluteRepoRoot,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  withRebuildRpcGate(
    runtime,
    acquireMutexFromRef(runtime.shipWorktreeMutexesRef, worktreeRoot).pipe(
      Effect.flatMap((sem) => sem.withPermit(effect)),
    ),
  )

export const withRebuildLock = <A, E>(
  runtime: WorkflowDaemonRuntime,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  runtime.rebuildMutex.withPermit(
    runtime.rebuildRpcGateSemaphore.withPermits(MAX_CONCURRENT_RUN_LOCKS)(
      runtime.rebuildProjectionGateSemaphore.withPermits(MAX_CONCURRENT_RUN_LOCKS)(
        runtime.journalWriteMutex.withPermit(effect),
      ),
    ),
  )

export const isUnitStatus = <S extends WorkflowUnitStatus>(
  record: WorkflowUnitRecord | undefined,
  expected: S,
): record is WorkflowUnitRecord & { readonly status: S } =>
  record !== undefined &&
  match(record.status)
    .with("pending", (s) => s === expected)
    .with("dispatched", (s) => s === expected)
    .with("completed", (s) => s === expected)
    .with("escalated", (s) => s === expected)
    .exhaustive()

export const isRunTerminalState = (state: WorkflowRunState): boolean =>
  match(state)
    .with("completed", "aborted", () => true)
    .with("running", "waiting", () => false)
    .exhaustive()

export const isOptionPresent = <A>(opt: Option.Option<A>): opt is Option.Some<A> =>
  match(opt)
    .with({ _tag: "Some" }, () => true)
    .with({ _tag: "None" }, () => false)
    .exhaustive()

export const toWorkflowRpcRequestId = (raw: string): WorkflowRpcRequestId => {
  const trimmed = raw.trim().slice(0, 256).trim()
  return WorkflowRpcRequestId.make(trimmed.length > 0 ? trimmed : "unknown-request")
}

export const rpcSuccess = (
  requestId: string,
  command: WorkflowDaemonCapability,
  result: WorkflowRpcResult,
): WorkflowRpcSuccessEnvelope => ({
  id: toWorkflowRpcRequestId(requestId),
  ok: true,
  command,
  result,
})

export const rpcError = (
  requestId: string,
  command: WorkflowDaemonCapability,
  detail: string,
  error?: string,
): WorkflowRpcErrorEnvelope => ({
  id: toWorkflowRpcRequestId(requestId),
  ok: false,
  command,
  error: toBoundedReason(error ?? detail, "Workflow daemon RPC error"),
  detail: toBoundedReason(detail, "Workflow daemon RPC error"),
})

export const validateRpcRepoRoot = Effect.fn("WorkflowRpcDaemon.validateRepoRoot")(function* (
  rawRepoRoot: AbsoluteRepoRoot,
  scope: DaemonRequestScopeAllowed,
): Effect.fn.Return<ValidatedWorktreeRoot, WorkflowStoreFailureReason> {
  const validated = yield* validateWorktreeRepoRoot(rawRepoRoot).pipe(
    Effect.mapError((err) => err.reason),
  )
  if (
    scope.daemonWorktree !== undefined &&
    validated.commonGitDir !== scope.daemonWorktree.commonGitDir
  ) {
    return yield* Effect.fail(
      toBoundedReason(
        `Worktree '${validated.worktreeRoot}' belongs to commonGitDir '${validated.commonGitDir}', expected '${scope.daemonWorktree.commonGitDir}'`,
      ),
    )
  }
  return validated
})

export const checkDeferredResult = <S extends Schema.Constraint, E extends Schema.Constraint>(
  engine: WorkflowEngine.WorkflowEngine["Service"],
  executionId: WorkflowExecutionId,
  deferred: Parameters<WorkflowEngine.WorkflowEngine["Service"]["deferredResult"]>[0] & {
    readonly successSchema: S
    readonly errorSchema: E
  },
) =>
  engine.deferredResult(deferred).pipe(
    Effect.provideService(
      WorkflowEngine.WorkflowInstance,
      WorkflowEngine.WorkflowInstance.initial(HarnessTaskWorkflow, executionId),
    ),
    Effect.catchDefect((defect) =>
      Effect.fail(toBoundedReason(defect, `Corrupt deferred payload on '${deferred.name}'`)),
    ),
  )

export type UnitCycleState =
  | { readonly _tag: "Aborted"; readonly escalationOrdinal: EscalationOrdinal }
  | {
      readonly _tag: "Active"
      readonly escalationOrdinal: EscalationOrdinal
      readonly attemptOutcomes: ReadonlyArray<{
        readonly attempt: AttemptNumber
        readonly outcome: Option.Option<UnitOutcome>
      }>
    }

export const inspectActiveUnitCycle = Effect.fn("WorkflowRpcDaemon.inspectActiveUnitCycle")(
  function* (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    executionId: WorkflowExecutionId,
    unitId: WorkUnitId,
  ): Effect.fn.Return<UnitCycleState, WorkflowStoreFailureReason> {
    for (let escNum = 1; escNum <= MAX_ESCALATION_CYCLES; escNum += 1) {
      const escalationOrdinal = EscalationOrdinal.make(escNum)
      const escDeferred = makeUnitEscalationDeferred(unitId, escalationOrdinal)
      const escRes = yield* checkDeferredResult(engine, executionId, escDeferred)
      const step = yield* match(escRes)
        .with({ _tag: "None" }, () => Effect.succeed("active" as const))
        .with({ _tag: "Some" }, ({ value: exit }) =>
          Exit.match(exit, {
            onFailure: (cause) =>
              Effect.fail(
                toBoundedReason(
                  `Escalation deferred '${escDeferred.name}' failed: ${Cause.pretty(cause)}`,
                ),
              ),
            onSuccess: (rawVal) =>
              match(decodeEscalationResolutionOption(rawVal))
                .with({ _tag: "Some" }, ({ value: res }) =>
                  match(res.decision)
                    .with("retry", () => Effect.succeed("retry" as const))
                    .with("abort", () => Effect.succeed("aborted" as const))
                    .exhaustive(),
                )
                .with({ _tag: "None" }, () =>
                  Effect.fail(
                    toBoundedReason(
                      `Corrupt EscalationResolution payload on deferred '${escDeferred.name}'`,
                    ),
                  ),
                )
                .exhaustive(),
          }),
        )
        .exhaustive()

      if (step === "aborted") {
        return { _tag: "Aborted", escalationOrdinal }
      }
      if (step === "active") {
        const attemptOutcomes: Array<{
          readonly attempt: AttemptNumber
          readonly outcome: Option.Option<UnitOutcome>
        }> = []
        for (const attempt of ATTEMPTS) {
          const unitDef = makeUnitCompletionDeferred(unitId, attempt, escalationOrdinal)
          const unitRes = yield* checkDeferredResult(engine, executionId, unitDef)
          const decodedOutcome = yield* match(unitRes)
            .with({ _tag: "None" }, () => Effect.succeedNone)
            .with({ _tag: "Some" }, ({ value: exit }) =>
              Exit.match(exit, {
                onFailure: (cause) =>
                  Effect.fail(
                    toBoundedReason(
                      `Unit completion deferred '${unitDef.name}' failed: ${Cause.pretty(cause)}`,
                    ),
                  ),
                onSuccess: (raw) =>
                  match(decodeUnitOutcomeOption(raw))
                    .with({ _tag: "Some" }, ({ value }) => Effect.succeedSome(value))
                    .with({ _tag: "None" }, () =>
                      Effect.fail(
                        toBoundedReason(
                          `Corrupt UnitOutcome payload on deferred '${unitDef.name}'`,
                        ),
                      ),
                    )
                    .exhaustive(),
              }),
            )
            .exhaustive()
          attemptOutcomes.push({ attempt, outcome: decodedOutcome })
        }
        return { _tag: "Active", escalationOrdinal, attemptOutcomes }
      }
    }
    return yield* Effect.fail(
      toBoundedReason(`Unit '${unitId}' exceeded maximum escalation inspection bound`),
    )
  },
)

export interface ResolvedRunTarget {
  readonly runId: WorkflowRunId
  readonly executionId: WorkflowExecutionId
  readonly plan?: CompiledPlan | undefined
  readonly runRecord?: WorkflowRunRecord | undefined
}

export const decodePlanFromRunStrict = (
  run: WorkflowRunRecord,
): Effect.Effect<CompiledPlan, WorkflowStoreFailureReason> => {
  if (run.planJson === undefined) {
    return Effect.fail(
      toBoundedReason(
        `WorkflowDaemonError: Existing workflow run '${run.runId}' is missing stored planJson`,
      ),
    )
  }
  return match(decodePlanJsonOption(run.planJson))
    .with({ _tag: "None" }, () =>
      Effect.fail(
        toBoundedReason(
          `WorkflowDaemonError: Existing workflow run '${run.runId}' has corrupt stored planJson`,
        ),
      ),
    )
    .with({ _tag: "Some" }, ({ value: plan }) =>
      plan.planSha === run.planSha && plan.runId === run.runId
        ? Effect.succeed(plan)
        : Effect.fail(
            toBoundedReason(
              `WorkflowDaemonError: Stored planJson for run '${run.runId}' does not match recorded runId/planSha`,
            ),
          ),
    )
    .exhaustive()
}

export const resolveRunTarget = Effect.fn("WorkflowRpcDaemon.resolveRunTarget")(function* (
  runtime: WorkflowDaemonRuntime,
  requestedRunId?: WorkflowRunId,
): Effect.fn.Return<ResolvedRunTarget, WorkflowStoreFailureReason> {
  const plansMap = yield* SynchronizedRef.get(runtime.plansRef)
  if (requestedRunId !== undefined) {
    const runOpt = yield* runtime.readModelQuery
      .getRun(requestedRunId)
      .pipe(Effect.mapError(storeOrLeaseToBoundedReason))
    const runRecord = Option.getOrUndefined(runOpt)
    let plan = plansMap.get(requestedRunId)
    if (plan === undefined && runRecord !== undefined && runRecord.planJson !== undefined) {
      plan = yield* decodePlanFromRunStrict(runRecord)
      const decodedPlan = plan
      yield* SynchronizedRef.update(runtime.plansRef, (m) =>
        new Map(m).set(decodedPlan.runId, decodedPlan),
      )
    }
    if (plan !== undefined) {
      const executionId = yield* executionIdOf(plan)
      return {
        runId: requestedRunId,
        executionId,
        plan,
        runRecord,
      }
    }
    if (runRecord !== undefined) {
      return {
        runId: runRecord.runId,
        executionId: runRecord.executionId,
        runRecord,
      }
    }
    return yield* Effect.fail(toBoundedReason(`Workflow run '${requestedRunId}' not found`))
  }

  const runs = yield* runtime.readModelQuery.listRuns.pipe(
    Effect.mapError(storeOrLeaseToBoundedReason),
  )
  if (runs.length > 0) {
    const sorted = [...runs].sort((a, b) =>
      b.updatedMs !== a.updatedMs ? b.updatedMs - a.updatedMs : compareCodeUnits(b.runId, a.runId),
    )
    const latest = sorted[0]!
    let plan = plansMap.get(latest.runId)
    if (plan === undefined && latest.planJson !== undefined) {
      plan = yield* decodePlanFromRunStrict(latest)
      const decodedPlan = plan
      yield* SynchronizedRef.update(runtime.plansRef, (m) =>
        new Map(m).set(decodedPlan.runId, decodedPlan),
      )
    }
    const executionId = plan !== undefined ? yield* executionIdOf(plan) : latest.executionId
    return {
      runId: latest.runId,
      executionId,
      plan,
      runRecord: latest,
    }
  }

  const cachedPlans = Array.from(plansMap.values())
  const latestCached = cachedPlans[cachedPlans.length - 1]
  if (latestCached !== undefined) {
    const executionId = yield* executionIdOf(latestCached)
    return {
      runId: latestCached.runId,
      executionId,
      plan: latestCached,
    }
  }

  return yield* Effect.fail(toBoundedReason("No workflow run found"))
})
