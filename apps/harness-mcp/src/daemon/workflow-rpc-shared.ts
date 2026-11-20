import { Effect, Exit, Option, Schema, Semaphore, SynchronizedRef } from "effect"
import { WorkflowEngine } from "effect/workflow"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  AgentFailureReason,
  AttemptNumber,
  CompiledPlan,
  EscalationOrdinal,
  EscalationResolution,
  type LeaseEpoch,
  type UnitEscalation,
  UnitOutcome,
  UnitRejection,
  type ValidatedWorktreeRoot,
  type WorkUnitId,
  type WorkflowAttemptRecord,
  WorkflowExecutionId,
  WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowRunState,
  type WorkflowStoreFailureReason,
  type WorkflowUnitRecord,
  type WorkflowUnitStatus,
  compareCodeUnits,
  toBoundedReason,
} from "@harness/contract"
import {
  HarnessTaskWorkflow,
  makeUnitCompletionDeferred,
  makeUnitEscalationDeferred,
} from "@harness/gates"
import { validateWorktreeRepoRoot } from "@harness/infra"
import type { DaemonRequestScopeAllowed } from "./workflow-daemon-helper.js"
import type { WorkflowDaemonRuntime } from "./workflow-engine-daemon-helper.js"

const MAX_ESCALATION_CYCLES = 100
const ATTEMPTS: readonly [AttemptNumber, AttemptNumber, AttemptNumber] = [
  AttemptNumber.make(1),
  AttemptNumber.make(2),
  AttemptNumber.make(3),
]

const PlanJsonCodec = Schema.fromJsonString(CompiledPlan)
const RejectionJsonCodec = Schema.fromJsonString(UnitRejection)
const decodePlanJsonOption = Schema.decodeUnknownOption(PlanJsonCodec)
const decodeRejectionJsonOption = Schema.decodeUnknownOption(RejectionJsonCodec)
const decodeUnitOutcomeOption = Schema.decodeUnknownOption(UnitOutcome)
const decodeEscalationResolutionOption = Schema.decodeUnknownOption(EscalationResolution)

export const hasOutcomeTag = (opt: Option.Option<UnitOutcome>, tag: UnitOutcome["_tag"]): boolean =>
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

export const hasAttemptVerdict = (
  record: WorkflowAttemptRecord,
  expected: WorkflowAttemptRecord["verdict"],
): boolean =>
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
): UnitRejection => {
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
      return rejected
    }
  }
  const unitAttempts = attemptsFromReadModel
    .filter(
      (a) => a.unitId === unitId && a.rejection !== undefined && hasAttemptVerdict(a, "rejected"),
    )
    .sort((a, b) => b.attempt - a.attempt)
  const latestReadAttempt = unitAttempts[0]
  if (latestReadAttempt?.rejection !== undefined) {
    const decoded = match(decodeRejectionJsonOption(latestReadAttempt.rejection))
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (decoded !== undefined) {
      return decoded
    }
  }
  return UnitRejection.cases.AgentFailed.make({
    reason: AgentFailureReason.make("Unit retry budget exhausted"),
  })
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

export interface WorkflowRpcHandlerInput {
  readonly requestId: string
  readonly rawPayload: Readonly<Record<string, unknown>>
  readonly scope: DaemonRequestScopeAllowed
  readonly writerLeaseEpoch: LeaseEpoch
  readonly runtime?: WorkflowDaemonRuntime | undefined
}

export const withRunLock = <A, E>(
  runtime: WorkflowDaemonRuntime,
  runId: WorkflowRunId,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  SynchronizedRef.modifyEffect(runtime.runMutexesRef, (map) => {
    const existing = map.get(runId)
    if (existing !== undefined) {
      return Effect.succeed([existing, map] as const)
    }
    const sem = Semaphore.makeUnsafe(1)
    return Effect.succeed([sem, new Map(map).set(runId, sem)] as const)
  }).pipe(Effect.flatMap((sem) => sem.withPermit(effect)))

export const isUnitStatus = (
  record: WorkflowUnitRecord | undefined,
  expected: WorkflowUnitStatus,
): boolean =>
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

export const isOptionPresent = <A>(opt: Option.Option<A>): boolean =>
  match(opt)
    .with({ _tag: "Some" }, () => true)
    .with({ _tag: "None" }, () => false)
    .exhaustive()

export const rpcSuccess = (
  requestId: string,
  command: string,
  result: unknown,
): Record<string, unknown> => ({
  id: requestId,
  ok: true,
  command,
  result,
})

export const rpcError = (
  requestId: string,
  command: string,
  detail: string,
  error?: string,
): Record<string, unknown> => ({
  id: requestId,
  ok: false,
  command,
  error: error ?? detail,
  detail,
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
  engine
    .deferredResult(deferred)
    .pipe(
      Effect.provideService(
        WorkflowEngine.WorkflowInstance,
        WorkflowEngine.WorkflowInstance.initial(HarnessTaskWorkflow, executionId),
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
      const step = match(escRes)
        .with({ _tag: "None" }, () => "active" as const)
        .with({ _tag: "Some" }, ({ value: exit }) =>
          Exit.match(exit, {
            onFailure: () => "aborted" as const,
            onSuccess: (rawVal) =>
              match(decodeEscalationResolutionOption(rawVal))
                .with({ _tag: "Some" }, ({ value: res }) =>
                  match(res.decision)
                    .with("retry", () => "retry" as const)
                    .with("abort", () => "aborted" as const)
                    .exhaustive(),
                )
                .with({ _tag: "None" }, () => "aborted" as const)
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
          const decodedOutcome = match(unitRes)
            .with({ _tag: "None" }, () => Option.none<UnitOutcome>())
            .with({ _tag: "Some" }, ({ value: exit }) =>
              Exit.match(exit, {
                onFailure: () => Option.none<UnitOutcome>(),
                onSuccess: (raw) => decodeUnitOutcomeOption(raw),
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

export const decodePlanFromRun = (run: WorkflowRunRecord): CompiledPlan | undefined =>
  run.planJson !== undefined ? Option.getOrUndefined(decodePlanJsonOption(run.planJson)) : undefined

export const resolveRunTarget = Effect.fn("WorkflowRpcDaemon.resolveRunTarget")(function* (
  runtime: WorkflowDaemonRuntime,
  requestedRunId?: WorkflowRunId,
): Effect.fn.Return<ResolvedRunTarget, WorkflowStoreFailureReason> {
  const plansMap = yield* SynchronizedRef.get(runtime.plansRef)
  if (requestedRunId !== undefined) {
    const runOpt = yield* runtime.readModelQuery
      .getRun(requestedRunId)
      .pipe(Effect.mapError((err) => err.reason))
    const runRecord = Option.getOrUndefined(runOpt)
    let plan = plansMap.get(requestedRunId)
    if (plan === undefined && runRecord !== undefined) {
      plan = decodePlanFromRun(runRecord)
      if (plan !== undefined) {
        const decodedPlan = plan
        yield* SynchronizedRef.update(runtime.plansRef, (m) =>
          new Map(m).set(decodedPlan.runId, decodedPlan),
        )
      }
    }
    if (plan !== undefined) {
      const execIdStr = yield* HarnessTaskWorkflow.executionId({ plan })
      return {
        runId: requestedRunId,
        executionId: WorkflowExecutionId.make(execIdStr),
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

  const runs = yield* runtime.readModelQuery.listRuns.pipe(Effect.mapError((err) => err.reason))
  if (runs.length > 0) {
    const sorted = [...runs].sort((a, b) =>
      b.updatedMs !== a.updatedMs ? b.updatedMs - a.updatedMs : compareCodeUnits(b.runId, a.runId),
    )
    const latest = sorted[0]!
    let plan = plansMap.get(latest.runId)
    if (plan === undefined) {
      plan = decodePlanFromRun(latest)
      if (plan !== undefined) {
        const decodedPlan = plan
        yield* SynchronizedRef.update(runtime.plansRef, (m) =>
          new Map(m).set(decodedPlan.runId, decodedPlan),
        )
      }
    }
    const executionId =
      plan !== undefined
        ? WorkflowExecutionId.make(yield* HarnessTaskWorkflow.executionId({ plan }))
        : latest.executionId
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
    const execIdStr = yield* HarnessTaskWorkflow.executionId({ plan: latestCached })
    return {
      runId: latestCached.runId,
      executionId: WorkflowExecutionId.make(execIdStr),
      plan: latestCached,
    }
  }

  return yield* Effect.fail(toBoundedReason("No workflow run found"))
})
