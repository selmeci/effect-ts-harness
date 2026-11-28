import { Cause, Effect, Layer, Option, Ref, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type OmnigraphBranchName,
  OmnigraphCommitId,
  WORKFLOW_TIMEOUT_BUDGETS,
  type WorkflowProjectAllInput,
  WorkflowProjectAllOutcome,
  type WorkflowProjectionNonStaleOutcome,
  WorkflowProjectionOutcome,
  WorkflowProjectionStatus,
  type WorkflowProjectorInput,
  type WorkflowRunId,
  type WorkflowStoreFailureReason,
  isPureInterruptCause,
  projectionStatusOfOutcome,
  toBoundedReason,
} from "@harness/contract"
import {
  WorkflowProjector,
  type WorkflowProjectorShape,
  WorkflowReadModelQuery,
} from "@harness/service"
import { nodeSyncHostIo } from "../node-host-io.js"
import { readWorkflowProjectionStatuses } from "./workflow-projection-status-store.js"
import { planWorkflowProjection } from "./workflow-projector-planner.js"
import {
  WorkflowProjectorCallError,
  readTargetStateSnapshot,
  runTimedOmnigraphCall,
} from "./workflow-projector-query.js"
import {
  type WorkflowProjectorOptions,
  computeProjectorRetryDelayMs,
  isRetryableProjectionError,
  makeHarnessActorClient,
  recordProjectionStatus,
  resolveFallbackBranch,
  resolveRepoRoot,
  resolveTargetBranchName,
  resolveWritableTargetBranch,
} from "./workflow-projector-runtime.js"

const decodeCommitIdOption = Schema.decodeUnknownOption(OmnigraphCommitId)

const extractProjectionErrorReason = (cause: Cause.Cause<unknown>, fallback: string) => {
  const errOpt = Cause.findErrorOption(cause)
  const rawCause = match(errOpt)
    .with({ _tag: "Some" }, ({ value }) =>
      value instanceof WorkflowProjectorCallError ? value.cause : value,
    )
    .with({ _tag: "None" }, () => Cause.pretty(cause))
    .exhaustive()
  return toBoundedReason(rawCause, fallback)
}

/** Projects one durable workflow run into analytical graph `harness` (`SPEC-0038`). */
export const projectWorkflowRunImpl = Effect.fn("WorkflowProjector.project")(function* (
  input: WorkflowProjectorInput,
  options?: WorkflowProjectorOptions,
): Effect.fn.Return<WorkflowProjectionOutcome, never, WorkflowReadModelQuery> {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  let resolvedRepoRoot: AbsoluteRepoRoot | undefined = input.repoRoot ?? options?.repoRoot
  let reportedBranch: OmnigraphBranchName = resolveFallbackBranch(input.targetBranch, options)

  return yield* Effect.gen(function* () {
    const repoRoot = yield* resolveRepoRoot(input.repoRoot, options)
    resolvedRepoRoot = repoRoot
    const targetBranch = yield* resolveTargetBranchName(
      input.targetBranch,
      repoRoot,
      hostIo,
      options?.env,
      options,
    )
    reportedBranch = targetBranch

    const readModel = yield* WorkflowReadModelQuery
    const runOpt = yield* readModel.getRun(input.runId)
    return yield* match(runOpt)
      .with({ _tag: "None" }, () =>
        Effect.gen(function* () {
          const skippedOutcome = WorkflowProjectionOutcome.cases.Skipped.make({
            runId: input.runId,
            branch: targetBranch,
            projectionStatus: "not-projected",
            reason: toBoundedReason(`Workflow run '${input.runId}' does not exist in read model`),
          })
          yield* recordProjectionStatus(
            repoRoot,
            hostIo,
            options?.statusRef,
            input.runId,
            projectionStatusOfOutcome(skippedOutcome),
          )
          return skippedOutcome
        }),
      )
      .with({ _tag: "Some" }, ({ value: run }) =>
        Effect.gen(function* () {
          const units = yield* readModel.listUnits(input.runId)
          const attempts = yield* readModel.listAttempts(input.runId)
          const og = makeHarnessActorClient(repoRoot, options)

          const branchResolution = yield* resolveWritableTargetBranch(
            og,
            targetBranch,
            input.targetBranch,
            input.trigger,
          )
          return yield* match(branchResolution)
            .with({ _tag: "Missing" }, ({ reason }) =>
              Effect.gen(function* () {
                const skippedOutcome = WorkflowProjectionOutcome.cases.Skipped.make({
                  runId: input.runId,
                  branch: targetBranch,
                  projectionStatus: "not-projected",
                  reason: toBoundedReason(reason),
                })
                yield* recordProjectionStatus(
                  repoRoot,
                  hostIo,
                  options?.statusRef,
                  input.runId,
                  projectionStatusOfOutcome(skippedOutcome),
                )
                return skippedOutcome
              }),
            )
            .with({ _tag: "Resolved" }, ({ branch: effectiveBranch }) =>
              Effect.gen(function* () {
                const attemptKeys = attempts.map((a) => a.attemptKey)
                const maxAttempts = WORKFLOW_TIMEOUT_BUDGETS.projectorOccMaxAttempts
                const baseBackoffMs = WORKFLOW_TIMEOUT_BUDGETS.projectorOccRetryBackoffMs
                let lastCause: unknown = "Workflow projection OCC loop exhausted"

                for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                  const attemptOutcome = yield* Effect.gen(function* () {
                    const { targetState, graphCommitId } = yield* readTargetStateSnapshot(
                      og,
                      effectiveBranch,
                      input.runId,
                      attemptKeys,
                    )
                    const plan = planWorkflowProjection({ run, units, attempts }, targetState)
                    return yield* match(plan)
                      .with({ _tag: "InvalidPlanJson" }, ({ reason }) =>
                        Effect.fail(new WorkflowProjectorCallError({ cause: reason })),
                      )
                      .with({ _tag: "NoOp" }, ({ counts }) =>
                        Effect.gen(function* () {
                          const noOpOutcome = WorkflowProjectionOutcome.cases.Projected.make({
                            runId: input.runId,
                            branch: effectiveBranch,
                            projectionStatus: "fresh",
                            commitId: null,
                            counts,
                          })
                          yield* recordProjectionStatus(
                            repoRoot,
                            hostIo,
                            options?.statusRef,
                            input.runId,
                            projectionStatusOfOutcome(noOpOutcome),
                          )
                          return noOpOutcome
                        }),
                      )
                      .with({ _tag: "Mutate" }, ({ query, params, counts }) =>
                        Effect.gen(function* () {
                          const change = yield* runTimedOmnigraphCall((signal) =>
                            og.mutate(
                              {
                                branch: effectiveBranch,
                                query,
                                params,
                              },
                              {
                                ifGraphCommit: graphCommitId,
                                signal,
                              },
                            ),
                          )

                          const rawCommitId = change.commit?.graphCommitId
                          if (rawCommitId === undefined || rawCommitId === null) {
                            return yield* new WorkflowProjectorCallError({
                              cause:
                                "Omnigraph mutate response missing commit.graphCommitId on non-noop mutation",
                            })
                          }
                          const commitId = yield* match(decodeCommitIdOption(rawCommitId))
                            .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
                            .with({ _tag: "None" }, () =>
                              Effect.fail(
                                new WorkflowProjectorCallError({
                                  cause: `Omnigraph mutate response returned invalid commit.graphCommitId: ${JSON.stringify(rawCommitId)}`,
                                }),
                              ),
                            )
                            .exhaustive()

                          const projectedOutcome = WorkflowProjectionOutcome.cases.Projected.make({
                            runId: input.runId,
                            branch: effectiveBranch,
                            projectionStatus: "fresh",
                            commitId,
                            counts,
                          })
                          yield* recordProjectionStatus(
                            repoRoot,
                            hostIo,
                            options?.statusRef,
                            input.runId,
                            projectionStatusOfOutcome(projectedOutcome),
                          )
                          return projectedOutcome
                        }),
                      )
                      .exhaustive()
                  }).pipe(
                    Effect.map((outcome) => ({ _tag: "Ok" as const, outcome })),
                    Effect.catch((err) => Effect.succeed({ _tag: "Err" as const, err })),
                  )

                  const outcomeOpt = yield* match(attemptOutcome)
                    .with({ _tag: "Ok" }, ({ outcome }) => Effect.succeedSome(outcome))
                    .with({ _tag: "Err" }, ({ err }) =>
                      Effect.gen(function* () {
                        lastCause = err.cause
                        if (isRetryableProjectionError(err.cause)) {
                          if (attempt + 1 < maxAttempts) {
                            const delayMs = computeProjectorRetryDelayMs(
                              attempt,
                              err.cause,
                              baseBackoffMs,
                            )
                            yield* Effect.sleep(`${delayMs} millis`)
                            return Option.none<WorkflowProjectionOutcome>()
                          }
                          return yield* new WorkflowProjectorCallError({
                            cause: `Workflow projection OCC loop exhausted after ${maxAttempts} attempts: ${toBoundedReason(lastCause)}`,
                          })
                        }
                        return yield* err
                      }),
                    )
                    .exhaustive()

                  const finishedOutcome = Option.getOrUndefined(outcomeOpt)
                  if (finishedOutcome !== undefined) {
                    return finishedOutcome
                  }
                }

                return yield* new WorkflowProjectorCallError({
                  cause: `Workflow projection OCC loop exhausted after ${maxAttempts} attempts: ${toBoundedReason(lastCause)}`,
                })
              }),
            )
            .exhaustive()
        }),
      )
      .exhaustive()
  }).pipe(
    Effect.timeoutOption(`${WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs} millis`),
    Effect.flatMap((timedOpt) =>
      match(timedOpt)
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new WorkflowProjectorCallError({
              cause: `Workflow projection aggregate timeout (${WORKFLOW_TIMEOUT_BUDGETS.workflowIpcMs}ms) exceeded`,
            }),
          ),
        )
        .exhaustive(),
    ),
    Effect.catchCause((cause) => {
      if (isPureInterruptCause(cause)) {
        return Effect.failCause(
          Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
        )
      }
      const reason = extractProjectionErrorReason(cause, "Workflow projection failed")
      process.stderr.write(
        `[harness/infra] Warning: workflow projection stale for '${input.runId}' on '${reportedBranch}': ${reason}\n`,
      )
      const staleOutcome = WorkflowProjectionOutcome.cases.Stale.make({
        runId: input.runId,
        branch: reportedBranch,
        projectionStatus: "stale",
        reason,
      })
      return recordProjectionStatus(
        resolvedRepoRoot,
        hostIo,
        options?.statusRef,
        input.runId,
        projectionStatusOfOutcome(staleOutcome),
      ).pipe(Effect.as(staleOutcome))
    }),
  )
})

/** Projects all durable workflow runs from `harness-workflows` into analytical graph `harness`. */
export const projectAllWorkflowRunsImpl = Effect.fn("WorkflowProjector.projectAll")(function* (
  input: WorkflowProjectAllInput,
  options?: WorkflowProjectorOptions,
): Effect.fn.Return<WorkflowProjectAllOutcome, never, WorkflowReadModelQuery> {
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  let resolvedRepoRoot: AbsoluteRepoRoot | undefined = input.repoRoot ?? options?.repoRoot
  let reportedBranch: OmnigraphBranchName = resolveFallbackBranch(input.targetBranch, options)
  let knownRunIds: ReadonlyArray<WorkflowRunId> = []

  return yield* Effect.gen(function* () {
    const repoRoot = yield* resolveRepoRoot(input.repoRoot, options)
    resolvedRepoRoot = repoRoot
    const targetBranch = yield* resolveTargetBranchName(
      input.targetBranch,
      repoRoot,
      hostIo,
      options?.env,
      options,
    )
    reportedBranch = targetBranch

    const readModel = yield* WorkflowReadModelQuery
    const runs = yield* readModel.listRuns
    knownRunIds = runs.map((run) => run.runId)
    if (runs.length === 0) {
      return WorkflowProjectAllOutcome.cases.Projected.make({
        branch: targetBranch,
        projectionStatus: "fresh",
        outcomes: [],
      })
    }

    const og = makeHarnessActorClient(repoRoot, options)
    const branchResolution = yield* resolveWritableTargetBranch(
      og,
      targetBranch,
      input.targetBranch,
      input.trigger,
    )
    return yield* match(branchResolution)
      .with({ _tag: "Missing" }, ({ reason }) =>
        Effect.forEach(knownRunIds, (runId) =>
          recordProjectionStatus(
            repoRoot,
            hostIo,
            options?.statusRef,
            runId,
            WorkflowProjectionStatus.make("not-projected"),
          ),
        ).pipe(
          Effect.as<WorkflowProjectAllOutcome>(
            WorkflowProjectAllOutcome.cases.Skipped.make({
              branch: targetBranch,
              projectionStatus: "not-projected",
              reason: toBoundedReason(reason),
            }),
          ),
        ),
      )
      .with({ _tag: "Resolved" }, ({ branch: effectiveBranch }) =>
        Effect.gen(function* () {
          const outcomes: Array<WorkflowProjectionOutcome> = []
          const nonStaleOutcomes: Array<WorkflowProjectionNonStaleOutcome> = []
          let firstStaleReason: WorkflowStoreFailureReason | undefined
          let firstSkippedReason: WorkflowStoreFailureReason | undefined
          let allSkipped = true

          for (const run of runs) {
            const outcome = yield* projectWorkflowRunImpl(
              {
                runId: run.runId,
                targetBranch: { _tag: "Explicit", branch: effectiveBranch },
                trigger: input.trigger,
                repoRoot,
              },
              options,
            )
            outcomes.push(outcome)
            match(outcome)
              .with({ _tag: "Stale" }, ({ reason }) => {
                allSkipped = false
                if (firstStaleReason === undefined) {
                  firstStaleReason = reason
                }
              })
              .with({ _tag: "Skipped" }, (skipped) => {
                nonStaleOutcomes.push(skipped)
                if (firstSkippedReason === undefined) {
                  firstSkippedReason = skipped.reason
                }
              })
              .with({ _tag: "Projected" }, (projected) => {
                allSkipped = false
                nonStaleOutcomes.push(projected)
              })
              .exhaustive()
          }

          if (firstStaleReason !== undefined) {
            return WorkflowProjectAllOutcome.cases.Stale.make({
              branch: effectiveBranch,
              projectionStatus: "stale",
              outcomes,
              reason: firstStaleReason,
            })
          }

          if (allSkipped) {
            return WorkflowProjectAllOutcome.cases.Skipped.make({
              branch: effectiveBranch,
              projectionStatus: "not-projected",
              reason:
                firstSkippedReason ??
                toBoundedReason("All workflow runs skipped during projection"),
            })
          }

          return WorkflowProjectAllOutcome.cases.Projected.make({
            branch: effectiveBranch,
            projectionStatus: "fresh",
            outcomes: nonStaleOutcomes,
          })
        }),
      )
      .exhaustive()
  }).pipe(
    Effect.timeoutOption(`${WORKFLOW_TIMEOUT_BUDGETS.workflowCompleteIpcMs} millis`),
    Effect.flatMap((timedOpt) =>
      match(timedOpt)
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new WorkflowProjectorCallError({
              cause: `Workflow projectAll aggregate timeout (${WORKFLOW_TIMEOUT_BUDGETS.workflowCompleteIpcMs}ms) exceeded`,
            }),
          ),
        )
        .exhaustive(),
    ),
    Effect.catchCause((cause) => {
      if (isPureInterruptCause(cause)) {
        return Effect.failCause(
          Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
        )
      }
      const reason = extractProjectionErrorReason(cause, "Workflow projectAll failed")
      process.stderr.write(
        `[harness/infra] Warning: workflow projectAll stale on '${reportedBranch}': ${reason}\n`,
      )
      const staleAllOutcome = WorkflowProjectAllOutcome.cases.Stale.make({
        branch: reportedBranch,
        projectionStatus: "stale",
        outcomes: [],
        reason,
      })
      return Effect.forEach(knownRunIds, (runId) =>
        recordProjectionStatus(
          resolvedRepoRoot,
          hostIo,
          options?.statusRef,
          runId,
          WorkflowProjectionStatus.make("stale"),
        ),
      ).pipe(Effect.as(staleAllOutcome))
    }),
  )
})

/** Returns the latest recorded readable projection freshness for a workflow run. */
export const getWorkflowProjectionStatusImpl = Effect.fn("WorkflowProjector.getProjectionStatus")(
  function* (
    runId: WorkflowRunId,
    options?: WorkflowProjectorOptions,
  ): Effect.fn.Return<Option.Option<WorkflowProjectionStatus>> {
    const hostIo = options?.hostIo ?? nodeSyncHostIo
    const repoRootOpt = yield* resolveRepoRoot(undefined, options).pipe(Effect.option)
    const persistedOpt = yield* match(repoRootOpt)
      .with({ _tag: "None" }, () => Effect.succeed(Option.none<WorkflowProjectionStatus>()))
      .with({ _tag: "Some" }, ({ value: repoRoot }) =>
        readWorkflowProjectionStatuses(repoRoot, hostIo).pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              process.stderr.write(
                `[harness/infra] Warning: failed to read projection status for '${runId}': ${err.reason}\n`,
              )
              return new Map<WorkflowRunId, WorkflowProjectionStatus>()
            }),
          ),
          Effect.map((statuses) => Option.fromUndefinedOr(statuses.get(runId))),
        ),
      )
      .exhaustive()

    return yield* match(persistedOpt)
      .with({ _tag: "Some" }, () => Effect.succeed(persistedOpt))
      .with({ _tag: "None" }, () =>
        options?.statusRef === undefined
          ? Effect.succeed(Option.none<WorkflowProjectionStatus>())
          : Ref.get(options.statusRef).pipe(
              Effect.map((map) => Option.fromUndefinedOr(map.get(runId))),
            ),
      )
      .exhaustive()
  },
)

/** Constructs a `WorkflowProjector` layer backed by `WorkflowReadModelQuery` and graph `harness`. */
const makeWorkflowProjectorLayer = (
  options?: WorkflowProjectorOptions,
): Layer.Layer<WorkflowProjector, never, WorkflowReadModelQuery> =>
  Layer.effect(
    WorkflowProjector,
    Effect.gen(function* () {
      const readModelQuery = yield* WorkflowReadModelQuery
      const statusRef =
        options?.statusRef ??
        (yield* Ref.make<ReadonlyMap<WorkflowRunId, WorkflowProjectionStatus>>(new Map()))
      const resolvedOptions: WorkflowProjectorOptions = {
        ...options,
        statusRef,
      }
      return {
        project: (input: WorkflowProjectorInput) =>
          projectWorkflowRunImpl(input, resolvedOptions).pipe(
            Effect.provideService(WorkflowReadModelQuery, readModelQuery),
          ),
        projectAll: (input: WorkflowProjectAllInput) =>
          projectAllWorkflowRunsImpl(input, resolvedOptions).pipe(
            Effect.provideService(WorkflowReadModelQuery, readModelQuery),
          ),
        getProjectionStatus: (runId: WorkflowRunId) =>
          getWorkflowProjectionStatusImpl(runId, resolvedOptions),
      } satisfies WorkflowProjectorShape
    }),
  )

/** Default live `WorkflowProjector` layer requiring `WorkflowReadModelQuery`. */
const WorkflowProjectorLive: Layer.Layer<WorkflowProjector, never, WorkflowReadModelQuery> =
  makeWorkflowProjectorLayer()

export type { WorkflowProjectorOptions }
export { computeProjectorRetryDelayMs, makeWorkflowProjectorLayer, WorkflowProjectorLive }
