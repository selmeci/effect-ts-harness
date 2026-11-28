import { Effect, Option, Ref, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  OmnigraphBranchName,
  WORKFLOW_TIMEOUT_BUDGETS,
  type WorkflowProjectionStatus,
  type WorkflowProjectorInput,
  type WorkflowProjectorTrigger,
  type WorkflowRunId,
  WorkflowStoreFailureReason,
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
import { type SyncHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import { writeWorkflowProjectionStatus } from "./workflow-projection-status-store.js"
import { WorkflowProjectorCallError, runTimedOmnigraphCall } from "./workflow-projector-query.js"

export type Omnigraph = InstanceType<typeof OmnigraphClient>

export interface WorkflowProjectorOptions {
  readonly repoRoot?: AbsoluteRepoRoot | undefined
  readonly harnessClient?: Omnigraph | undefined
  readonly hostIo?: SyncHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly branchOverride?: OmnigraphBranchName | undefined
  readonly statusRef?: Ref.Ref<ReadonlyMap<WorkflowRunId, WorkflowProjectionStatus>> | undefined
}

const decodeRepoRootOption = Schema.decodeUnknownOption(AbsoluteRepoRoot)
const decodeBranchNameEffect = Schema.decodeUnknownEffect(OmnigraphBranchName)
const decodeBranchNameOption = Schema.decodeUnknownOption(OmnigraphBranchName)

const resolveFallbackBranch = (
  targetBranch: WorkflowProjectorInput["targetBranch"],
  options?: WorkflowProjectorOptions,
): OmnigraphBranchName => {
  if (options?.branchOverride !== undefined) {
    const resolvedOverride = match(decodeBranchNameOption(options.branchOverride))
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (resolvedOverride !== undefined) {
      return resolvedOverride
    }
  }
  return match(targetBranch)
    .with({ _tag: "Explicit" }, ({ branch }) =>
      Option.getOrElse(decodeBranchNameOption(branch), () => OmnigraphBranchName.make("main")),
    )
    .with({ _tag: "ActiveTaskImplBranch" }, () => OmnigraphBranchName.make("impl/current"))
    .exhaustive()
}

const resolveRepoRoot = (
  inputRepoRoot: AbsoluteRepoRoot | undefined,
  options?: WorkflowProjectorOptions,
): Effect.Effect<AbsoluteRepoRoot, WorkflowProjectorCallError> =>
  Effect.suspend(() => {
    if (inputRepoRoot !== undefined) {
      return match(decodeRepoRootOption(inputRepoRoot))
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new WorkflowProjectorCallError({
              cause: `Invalid input repoRoot '${String(inputRepoRoot)}'`,
            }),
          ),
        )
        .exhaustive()
    }
    if (options?.repoRoot !== undefined) {
      return match(decodeRepoRootOption(options.repoRoot))
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new WorkflowProjectorCallError({
              cause: `Invalid options repoRoot '${String(options.repoRoot)}'`,
            }),
          ),
        )
        .exhaustive()
    }
    return Effect.try({
      try: () => process.cwd(),
      catch: (cause) => new WorkflowProjectorCallError({ cause }),
    }).pipe(
      Effect.flatMap((cwd) =>
        match(decodeRepoRootOption(cwd))
          .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
          .with({ _tag: "None" }, () =>
            Effect.fail(
              new WorkflowProjectorCallError({
                cause: `Unable to resolve valid AbsoluteRepoRoot from cwd '${cwd}'`,
              }),
            ),
          )
          .exhaustive(),
      ),
    )
  })

const resolveTargetBranchName = (
  targetBranch: WorkflowProjectorInput["targetBranch"],
  repoRoot: AbsoluteRepoRoot,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>> | undefined,
  options?: WorkflowProjectorOptions,
): Effect.Effect<OmnigraphBranchName, WorkflowProjectorCallError> =>
  Effect.suspend(() => {
    if (options?.branchOverride !== undefined) {
      return decodeBranchNameEffect(options.branchOverride).pipe(
        Effect.mapError((cause) => new WorkflowProjectorCallError({ cause })),
      )
    }
    return match(targetBranch)
      .with({ _tag: "Explicit" }, ({ branch }) =>
        decodeBranchNameEffect(branch).pipe(
          Effect.mapError((cause) => new WorkflowProjectorCallError({ cause })),
        ),
      )
      .with({ _tag: "ActiveTaskImplBranch" }, () =>
        Effect.try({
          try: () => resolveOmnigraphTaskBranches(repoRoot, hostIo, env).implBranch,
          catch: (cause) => new WorkflowProjectorCallError({ cause }),
        }).pipe(
          Effect.flatMap((rawBranch) =>
            decodeBranchNameEffect(rawBranch).pipe(
              Effect.mapError((cause) => new WorkflowProjectorCallError({ cause })),
            ),
          ),
        ),
      )
      .exhaustive()
  })

const BranchResolution = Schema.TaggedUnion({
  Resolved: { branch: OmnigraphBranchName },
  Missing: { reason: WorkflowStoreFailureReason },
})
type BranchResolution = typeof BranchResolution.Type

const isRetryableProjectionError = (cause: unknown): boolean =>
  isOmnigraphPreconditionOrConflictError(cause) || isOmnigraphTooManyRequestsError(cause)

/** Computes bounded retry backoff in milliseconds honoring `Retry-After` up to `projectorRetryAfterCapMs`. */
const computeProjectorRetryDelayMs = (
  attempt: number,
  cause: unknown,
  baseBackoffMs: number,
): number => {
  if (typeof cause === "object" && cause !== null) {
    const retryAfter = Reflect.get(cause, "retryAfter")
    const parsedSeconds =
      typeof retryAfter === "number"
        ? retryAfter
        : typeof retryAfter === "string" && retryAfter.trim().length > 0
          ? Number(retryAfter.trim())
          : Number.NaN
    if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
      return Math.min(
        WORKFLOW_TIMEOUT_BUDGETS.projectorRetryAfterCapMs,
        Math.max(5, Math.ceil(parsedSeconds * 1_000)),
      )
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
    let lastCause: unknown = "Omnigraph rate-limit retry exhausted"
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const attemptRes = yield* runTimedOmnigraphCall(fn).pipe(
        Effect.map((value) => ({ _tag: "Ok" as const, value })),
        Effect.catch((err) => Effect.succeed({ _tag: "Err" as const, err })),
      )
      const resolved = yield* match(attemptRes)
        .with({ _tag: "Ok" }, ({ value }) => Effect.succeedSome(value))
        .with({ _tag: "Err" }, ({ err }) =>
          Effect.gen(function* () {
            lastCause = err.cause
            if (isOmnigraphTooManyRequestsError(err.cause)) {
              if (attempt + 1 < maxAttempts) {
                const delayMs = computeProjectorRetryDelayMs(attempt, err.cause, baseBackoffMs)
                yield* Effect.sleep(`${delayMs} millis`)
                return Option.none<A>()
              }
              return yield* new WorkflowProjectorCallError({
                cause: `Omnigraph rate-limit retry exhausted after ${maxAttempts} attempts: ${toBoundedReason(lastCause)}`,
              })
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
      cause: `Omnigraph rate-limit retry exhausted after ${maxAttempts} attempts: ${toBoundedReason(lastCause)}`,
    })
  })

const resolveWritableTargetBranch = Effect.fnUntraced(function* (
  og: Omnigraph,
  targetBranch: OmnigraphBranchName,
  targetBranchSelector: WorkflowProjectorInput["targetBranch"],
  trigger: WorkflowProjectorTrigger,
): Effect.fn.Return<BranchResolution, WorkflowProjectorCallError> {
  const branches = yield* runTimedWithRateLimitRetry((signal) => og.branches.list({ signal }))
  if (branches.includes(targetBranch)) {
    return BranchResolution.cases.Resolved.make({ branch: targetBranch })
  }
  const hasMain = branches.includes("main")
  return yield* match(trigger)
    .with("post-rebuild", () =>
      match(targetBranchSelector)
        .with({ _tag: "ActiveTaskImplBranch" }, () =>
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
        .with({ _tag: "Explicit" }, () =>
          Effect.succeed<BranchResolution>(
            BranchResolution.cases.Missing.make({
              reason: toBoundedReason(
                `Explicit target branch '${targetBranch}' is absent on graph '${HARNESS_OMNIGRAPH_GRAPH_ID}'`,
              ),
            }),
          ),
        )
        .exhaustive(),
    )
    .with("wave", () =>
      match(targetBranchSelector)
        .with({ _tag: "ActiveTaskImplBranch" }, () =>
          Effect.succeed<BranchResolution>(
            BranchResolution.cases.Missing.make({
              reason: toBoundedReason(
                `Derived ActiveTaskImplBranch '${targetBranch}' is absent on graph '${HARNESS_OMNIGRAPH_GRAPH_ID}'`,
              ),
            }),
          ),
        )
        .with({ _tag: "Explicit" }, () =>
          hasMain
            ? runTimedWithRateLimitRetry((signal) =>
                og.branches.create({ name: targetBranch, from: "main" }, { signal }),
              ).pipe(
                Effect.as<BranchResolution>(
                  BranchResolution.cases.Resolved.make({ branch: targetBranch }),
                ),
                Effect.catchIf(
                  (err) => isOmnigraphPreconditionOrConflictError(err.cause),
                  (conflictErr) =>
                    runTimedWithRateLimitRetry((signal) => og.branches.list({ signal })).pipe(
                      Effect.flatMap((refreshedBranches) =>
                        refreshedBranches.includes(targetBranch)
                          ? Effect.succeed<BranchResolution>(
                              BranchResolution.cases.Resolved.make({ branch: targetBranch }),
                            )
                          : Effect.fail(
                              new WorkflowProjectorCallError({
                                cause: `Target branch '${targetBranch}' creation conflicted but remains absent on graph '${HARNESS_OMNIGRAPH_GRAPH_ID}': ${toBoundedReason(conflictErr.cause)}`,
                              }),
                            ),
                      ),
                    ),
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
        .exhaustive(),
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
  repoRoot: AbsoluteRepoRoot | undefined,
  hostIo: SyncHostIo,
  statusRef: Ref.Ref<ReadonlyMap<WorkflowRunId, WorkflowProjectionStatus>> | undefined,
  runId: WorkflowRunId,
  status: WorkflowProjectionStatus,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (statusRef !== undefined) {
      yield* Ref.update(statusRef, (prev) => {
        const next = new Map(prev)
        next.set(runId, status)
        return next
      })
    }
    if (repoRoot !== undefined) {
      yield* writeWorkflowProjectionStatus(repoRoot, runId, status, hostIo).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            process.stderr.write(
              `[harness/infra] Warning: failed to persist projection status for '${runId}': ${err.reason}\n`,
            )
          }),
        ),
      )
    }
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

export {
  BranchResolution,
  computeProjectorRetryDelayMs,
  isRetryableProjectionError,
  makeHarnessActorClient,
  recordProjectionStatus,
  resolveFallbackBranch,
  resolveRepoRoot,
  resolveTargetBranchName,
  resolveWritableTargetBranch,
  runTimedWithRateLimitRetry,
}
