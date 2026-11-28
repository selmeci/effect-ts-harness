import { Cause, Effect, Layer, Option, Ref, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  NonNegativeCount,
  OmnigraphBranchName,
  OmnigraphCommitId,
  WORKFLOW_TIMEOUT_BUDGETS,
  type WorkflowProjectAllInput,
  WorkflowProjectAllOutcome,
  type WorkflowProjectionCounts,
  WorkflowProjectionOutcome,
  WorkflowProjectionStatus,
  type WorkflowProjectorInput,
  type WorkflowProjectorTrigger,
  type WorkflowRunId,
  WorkflowStoreFailureReason,
  isPureInterruptCause,
  projectionStatusOfOutcome,
  toBoundedReason,
} from "@harness/contract"
import {
  HARNESS_OMNIGRAPH_GRAPH_ID,
  type OmnigraphClient,
  isOmnigraphPreconditionOrConflictError,
  isOmnigraphTooManyRequestsError,
  makeOmnigraphClient,
  resolveOmnigraphTaskBranches,
} from "@harness/graph"
import {
  WorkflowProjector,
  type WorkflowProjectorShape,
  WorkflowReadModelQuery,
} from "@harness/service"
import { type SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import { planWorkflowProjection } from "./workflow-projector-planner.js"
import {
  WorkflowProjectorCallError,
  readTargetStateSnapshot,
  runTimedOmnigraphCall,
} from "./workflow-projector-query.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export interface WorkflowProjectorOptions {
  readonly repoRoot?: AbsoluteRepoRoot | undefined
  readonly harnessClient?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly branchOverride?: string | undefined
  readonly statusRef?: Ref.Ref<ReadonlyMap<WorkflowRunId, WorkflowProjectionStatus>> | undefined
}

const ZERO_PROJECTION_COUNTS: WorkflowProjectionCounts = {
  runsUpserted: NonNegativeCount.make(0),
  unitsUpserted: NonNegativeCount.make(0),
  attemptsUpserted: NonNegativeCount.make(0),
  edgesUpserted: NonNegativeCount.make(0),
}

const decodeCommitIdOption = Schema.decodeUnknownOption(OmnigraphCommitId)
const decodeRepoRootOption = Schema.decodeOption(AbsoluteRepoRoot)

const resolveRepoRoot = (
  inputRepoRoot: AbsoluteRepoRoot | undefined,
  options?: WorkflowProjectorOptions,
): AbsoluteRepoRoot => {
  if (inputRepoRoot !== undefined) {
    return inputRepoRoot
  }
  if (options?.repoRoot !== undefined) {
    return options.repoRoot
  }
  return match(decodeRepoRootOption(process.cwd()))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => AbsoluteRepoRoot.make("/"))
    .exhaustive()
}

const resolveTargetBranchName = (
  targetBranch: WorkflowProjectorInput["targetBranch"],
  repoRoot: AbsoluteRepoRoot,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>> | undefined,
  options?: WorkflowProjectorOptions,
): OmnigraphBranchName => {
  if (options?.branchOverride !== undefined) {
    return OmnigraphBranchName.make(options.branchOverride)
  }
  return match(targetBranch)
    .with({ _tag: "Explicit" }, ({ branch }) => branch)
    .with({ _tag: "ActiveTaskImplBranch" }, () =>
      OmnigraphBranchName.make(resolveOmnigraphTaskBranches(repoRoot, hostIo, env).implBranch),
    )
    .exhaustive()
}

const BranchResolution = Schema.TaggedUnion({
  Resolved: { branch: OmnigraphBranchName },
  Missing: { reason: WorkflowStoreFailureReason },
})
type BranchResolution = typeof BranchResolution.Type

const isRetryableProjectionError = (cause: unknown): boolean =>
  isOmnigraphPreconditionOrConflictError(cause) || isOmnigraphTooManyRequestsError(cause)

const computeProjectorRetryDelayMs = (
  attempt: number,
  cause: unknown,
  baseBackoffMs: number,
): number => {
  if (typeof cause === "object" && cause !== null) {
    const retryAfter = Reflect.get(cause, "retryAfter")
    if (typeof retryAfter === "string") {
      const parsedSeconds = Number(retryAfter.trim())
      if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
        return Math.min(2_000, Math.max(5, Math.ceil(parsedSeconds * 1_000)))
      }
    }
  }
  const expMs = baseBackoffMs * 2 ** attempt
  const jitter = 0.5 + Math.random() * 0.5
  return Math.max(5, Math.floor(expMs * jitter))
}

const runTimedWithRateLimitRetry = <A>(
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, WorkflowProjectorCallError> =>
  Effect.gen(function* () {
    const maxAttempts = WORKFLOW_TIMEOUT_BUDGETS.projectorOccMaxAttempts
    const baseBackoffMs = WORKFLOW_TIMEOUT_BUDGETS.projectorOccRetryBackoffMs
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const attemptRes = yield* runTimedOmnigraphCall(fn).pipe(
        Effect.map((value) => ({ _tag: "Ok" as const, value })),
        Effect.catch((err) => Effect.succeed({ _tag: "Err" as const, err })),
      )
      const resolved = yield* match(attemptRes)
        .with({ _tag: "Ok" }, ({ value }) => Effect.succeedSome(value))
        .with({ _tag: "Err" }, ({ err }) =>
          Effect.gen(function* () {
            if (attempt + 1 < maxAttempts && isOmnigraphTooManyRequestsError(err.cause)) {
              const delayMs = computeProjectorRetryDelayMs(attempt, err.cause, baseBackoffMs)
              yield* Effect.sleep(`${delayMs} millis`)
              return Option.none<A>()
            }
            return yield* err
          }),
        )
        .exhaustive()
      const resolvedValue = Option.getOrUndefined(resolved)
      if (resolvedValue !== undefined) {
        return resolvedValue
      }
    }
    return yield* new WorkflowProjectorCallError({
      cause: "Omnigraph rate-limit retry exhausted",
    })
  })

const resolveWritableTargetBranch = Effect.fnUntraced(function* (
  og: Omnigraph,
  targetBranch: OmnigraphBranchName,
  trigger: WorkflowProjectorTrigger,
): Effect.fn.Return<BranchResolution, WorkflowProjectorCallError> {
  const branches = yield* runTimedWithRateLimitRetry((signal) => og.branches.list({ signal }))
  if (branches.includes(targetBranch)) {
    return BranchResolution.cases.Resolved.make({ branch: targetBranch })
  }
  const hasMain = branches.includes("main")
  return yield* match(trigger)
    .with("post-rebuild", () =>
      hasMain
        ? Effect.succeed<BranchResolution>(
            BranchResolution.cases.Resolved.make({ branch: OmnigraphBranchName.make("main") }),
          )
        : Effect.succeed<BranchResolution>(
            BranchResolution.cases.Missing.make({
              reason: toBoundedReason(
                `Target branch '${targetBranch}' and fallback 'main' are absent on graph '${HARNESS_OMNIGRAPH_GRAPH_ID}'`,
              ),
            }),
          ),
    )
    .with("wave", () =>
      hasMain
        ? runTimedWithRateLimitRetry((signal) =>
            og.branches.create({ name: targetBranch, from: "main" }, { signal }),
          ).pipe(
            Effect.catchIf(
              (err) => isOmnigraphPreconditionOrConflictError(err.cause),
              () => Effect.void,
            ),
            Effect.as<BranchResolution>(
              BranchResolution.cases.Resolved.make({ branch: targetBranch }),
            ),
          )
        : Effect.succeed<BranchResolution>(
            BranchResolution.cases.Missing.make({
              reason: toBoundedReason(
                `Target branch '${targetBranch}' and base 'main' are absent on graph '${HARNESS_OMNIGRAPH_GRAPH_ID}'`,
              ),
            }),
          ),
    )
    .with("done-pre-merge", () =>
      Effect.succeed<BranchResolution>(
        BranchResolution.cases.Missing.make({
          reason: toBoundedReason(
            `Target branch '${targetBranch}' is absent on graph '${HARNESS_OMNIGRAPH_GRAPH_ID}'`,
          ),
        }),
      ),
    )
    .exhaustive()
})

const recordProjectionStatus = (
  statusRef: Ref.Ref<ReadonlyMap<WorkflowRunId, WorkflowProjectionStatus>> | undefined,
  runId: WorkflowRunId,
  status: WorkflowProjectionStatus,
): Effect.Effect<void> =>
  statusRef === undefined
    ? Effect.void
    : Ref.update(statusRef, (prev) => {
        const next = new Map(prev)
        next.set(runId, status)
        return next
      })

const makeHarnessActorClient = (
  repoRoot: AbsoluteRepoRoot,
  options?: WorkflowProjectorOptions,
): Omnigraph => {
  if (options?.harnessClient !== undefined) {
    return options.harnessClient
  }
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  return makeOmnigraphClient({
    repoRoot,
    graphId: HARNESS_OMNIGRAPH_GRAPH_ID,
    actor: "harness-cli",
    hostIo,
    ...(options?.env !== undefined ? { env: options.env } : {}),
  })
}

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
  const repoRoot = resolveRepoRoot(input.repoRoot, options)
  const targetBranch = resolveTargetBranchName(
    input.targetBranch,
    repoRoot,
    hostIo,
    options?.env,
    options,
  )

  return yield* Effect.gen(function* () {
    const readModel = yield* WorkflowReadModelQuery
    const runOpt = yield* readModel.getRun(input.runId)
    return yield* match(runOpt)
      .with({ _tag: "None" }, () =>
        Effect.succeed<WorkflowProjectionOutcome>(
          WorkflowProjectionOutcome.cases.Skipped.make({
            runId: input.runId,
            branch: targetBranch,
            projectionStatus: "not-projected",
            reason: toBoundedReason(`Workflow run '${input.runId}' does not exist in read model`),
          }),
        ),
      )
      .with({ _tag: "Some" }, ({ value: run }) =>
        Effect.gen(function* () {
          const units = yield* readModel.listUnits(input.runId)
          const attempts = yield* readModel.listAttempts(input.runId)
          const og = makeHarnessActorClient(repoRoot, options)

          const branchResolution = yield* resolveWritableTargetBranch(
            og,
            targetBranch,
            input.trigger,
          )
          return yield* match(branchResolution)
            .with({ _tag: "Missing" }, ({ reason }) =>
              Effect.succeed<WorkflowProjectionOutcome>(
                WorkflowProjectionOutcome.cases.Skipped.make({
                  runId: input.runId,
                  branch: targetBranch,
                  projectionStatus: "not-projected",
                  reason: toBoundedReason(reason),
                }),
              ),
            )
            .with({ _tag: "Resolved" }, ({ branch: effectiveBranch }) =>
              Effect.gen(function* () {
                const attemptKeys = attempts.map((a) => a.attemptKey)
                const maxAttempts = WORKFLOW_TIMEOUT_BUDGETS.projectorOccMaxAttempts
                const baseBackoffMs = WORKFLOW_TIMEOUT_BUDGETS.projectorOccRetryBackoffMs

                for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                  const attemptOutcome = yield* Effect.gen(function* () {
                    const { targetState, graphCommitId } = yield* readTargetStateSnapshot(
                      og,
                      effectiveBranch,
                      input.runId,
                      attemptKeys,
                    )
                    const plan = planWorkflowProjection({ run, units, attempts }, targetState)
                    if (plan.noOp) {
                      const noOpOutcome = WorkflowProjectionOutcome.cases.Projected.make({
                        runId: input.runId,
                        branch: effectiveBranch,
                        projectionStatus: "fresh",
                        commitId: null,
                        counts: ZERO_PROJECTION_COUNTS,
                      })
                      yield* recordProjectionStatus(
                        options?.statusRef,
                        input.runId,
                        projectionStatusOfOutcome(noOpOutcome),
                      )
                      return noOpOutcome
                    }

                    const change = yield* runTimedOmnigraphCall((signal) =>
                      og.mutate(
                        {
                          branch: effectiveBranch,
                          query: plan.query,
                          params: plan.params,
                        },
                        {
                          ...(graphCommitId !== undefined ? { ifGraphCommit: graphCommitId } : {}),
                          signal,
                        },
                      ),
                    )

                    const rawCommitId = change.commit?.graphCommitId
                    const commitId =
                      rawCommitId === undefined || rawCommitId === null
                        ? null
                        : Option.getOrNull(decodeCommitIdOption(rawCommitId))
                    const projectedOutcome = WorkflowProjectionOutcome.cases.Projected.make({
                      runId: input.runId,
                      branch: effectiveBranch,
                      projectionStatus: "fresh",
                      commitId,
                      counts: plan.counts,
                    })
                    yield* recordProjectionStatus(
                      options?.statusRef,
                      input.runId,
                      projectionStatusOfOutcome(projectedOutcome),
                    )
                    return projectedOutcome
                  }).pipe(
                    Effect.map((outcome) => ({ _tag: "Ok" as const, outcome })),
                    Effect.catch((err) => Effect.succeed({ _tag: "Err" as const, err })),
                  )

                  const outcomeOpt = yield* match(attemptOutcome)
                    .with({ _tag: "Ok" }, ({ outcome }) => Effect.succeedSome(outcome))
                    .with({ _tag: "Err" }, ({ err }) =>
                      Effect.gen(function* () {
                        if (attempt + 1 < maxAttempts && isRetryableProjectionError(err.cause)) {
                          const delayMs = computeProjectorRetryDelayMs(
                            attempt,
                            err.cause,
                            baseBackoffMs,
                          )
                          yield* Effect.sleep(`${delayMs} millis`)
                          return Option.none<WorkflowProjectionOutcome>()
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
                  cause: "Workflow projection OCC loop exhausted",
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
        `[harness/infra] Warning: workflow projection stale for '${input.runId}' on '${targetBranch}': ${reason}\n`,
      )
      const staleOutcome = WorkflowProjectionOutcome.cases.Stale.make({
        runId: input.runId,
        branch: targetBranch,
        projectionStatus: "stale",
        reason,
      })
      return recordProjectionStatus(
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
  const repoRoot = resolveRepoRoot(input.repoRoot, options)
  const targetBranch = resolveTargetBranchName(
    input.targetBranch,
    repoRoot,
    hostIo,
    options?.env,
    options,
  )

  let knownRunIds: ReadonlyArray<WorkflowRunId> = []

  return yield* Effect.gen(function* () {
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
    const branchResolution = yield* resolveWritableTargetBranch(og, targetBranch, input.trigger)
    return yield* match(branchResolution)
      .with({ _tag: "Missing" }, ({ reason }) =>
        Effect.succeed<WorkflowProjectAllOutcome>(
          WorkflowProjectAllOutcome.cases.Skipped.make({
            branch: targetBranch,
            projectionStatus: "not-projected",
            reason: toBoundedReason(reason),
          }),
        ),
      )
      .with({ _tag: "Resolved" }, ({ branch: effectiveBranch }) =>
        Effect.gen(function* () {
          const outcomes: Array<WorkflowProjectionOutcome> = []
          let firstStaleReason: ReturnType<typeof toBoundedReason> | undefined
          let firstSkippedReason: ReturnType<typeof toBoundedReason> | undefined
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
              .with({ _tag: "Skipped" }, ({ reason }) => {
                if (firstSkippedReason === undefined) {
                  firstSkippedReason = reason
                }
              })
              .with({ _tag: "Projected" }, () => {
                allSkipped = false
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
            outcomes,
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
        `[harness/infra] Warning: workflow projectAll stale on '${targetBranch}': ${reason}\n`,
      )
      const staleAllOutcome = WorkflowProjectAllOutcome.cases.Stale.make({
        branch: targetBranch,
        projectionStatus: "stale",
        outcomes: [],
        reason,
      })
      return Effect.forEach(knownRunIds, (runId) =>
        recordProjectionStatus(options?.statusRef, runId, WorkflowProjectionStatus.make("stale")),
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
    if (options?.statusRef === undefined) {
      return Option.none<WorkflowProjectionStatus>()
    }
    const map = yield* Ref.get(options.statusRef)
    const found = map.get(runId)
    return found === undefined ? Option.none<WorkflowProjectionStatus>() : Option.some(found)
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

export { makeWorkflowProjectorLayer, WorkflowProjectorLive }
