import { join, resolve } from "node:path"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  isPureInterruptCause,
  OmnigraphBranchName,
  toBoundedReason,
  WorkflowProjectionTargetBranch,
  type WorkflowStoreUnavailableError,
} from "@harness/contract"
import { resolveOmnigraphClusterDir } from "@harness/graph"
import {
  makeWorkflowProjectorLayer,
  makeWorkflowReadModelQueryLayer,
  nodeSyncHostIo,
} from "@harness/infra/omnigraph-session"
import { WorkflowProjector, type WorkflowProjectorShape } from "@harness/service"

export interface ReprojectWorkflowsBeforeMergeInput {
  readonly repoRoot: string
  readonly clusterRepoRoot: string
  readonly implBranch: string
  readonly workflowProjector?: WorkflowProjectorShape | undefined
  readonly workflowProjectorLayer?:
    | Layer.Layer<WorkflowProjector, WorkflowStoreUnavailableError>
    | undefined
}

const catchNonInterruptStage =
  (stage: "setup" | "projection") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | undefined, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) => {
        if (isPureInterruptCause(cause)) {
          return Effect.failCause(
            Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
          )
        }
        return Effect.sync(() => {
          process.stderr.write(
            `[harness:done] Warning: workflow projection before merge failed during ${stage} (${toBoundedReason(Cause.pretty(cause))})\n`,
          )
          return undefined
        })
      }),
    )

/**
 * Re-projects durable workflow runs into graph `harness` on `impl/<task>` after `done`
 * reloads the implementation snapshot and before pre-merge verification / merge (`SPEC-0038`).
 */
export const reprojectWorkflowsBeforeMerge = Effect.fn(
  "DoneWorkflowProjector.reprojectBeforeMerge",
)(function* (input: ReprojectWorkflowsBeforeMergeInput): Effect.fn.Return<void> {
  if (input.workflowProjector === undefined && input.workflowProjectorLayer === undefined) {
    const wfGraphDir = join(
      resolveOmnigraphClusterDir(input.clusterRepoRoot, nodeSyncHostIo),
      "graphs",
      "harness-workflows.omni",
    )
    if (!nodeSyncHostIo.existsSync(wfGraphDir)) {
      process.stderr.write(
        `[harness:done] Info: skipping pre-merge workflow projection (${wfGraphDir} absent)\n`,
      )
      return
    }
  }

  const clusterRootCandidate =
    input.clusterRepoRoot.trim().length === 0
      ? input.clusterRepoRoot
      : resolve(input.clusterRepoRoot)
  const absClusterRoot = match(Schema.decodeResult(AbsoluteRepoRoot)(clusterRootCandidate))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:done] Warning: workflow projection before merge skipped due to invalid clusterRepoRoot (${toBoundedReason(failure.message)}): ${JSON.stringify(input.clusterRepoRoot)}\n`,
      )
      return undefined
    })
    .exhaustive()
  const branch = match(Schema.decodeResult(OmnigraphBranchName)(input.implBranch))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:done] Warning: workflow projection before merge skipped due to invalid implBranch (${toBoundedReason(failure.message)}): ${JSON.stringify(input.implBranch)}\n`,
      )
      return undefined
    })
    .exhaustive()

  if (absClusterRoot === undefined || branch === undefined) {
    return
  }

  const targetBranch = WorkflowProjectionTargetBranch.cases.Explicit.make({ branch })
  const outcome = yield* Effect.scoped(
    Effect.gen(function* () {
      const projector =
        input.workflowProjector !== undefined
          ? input.workflowProjector
          : yield* Effect.gen(function* () {
              const projectorLayer =
                input.workflowProjectorLayer ??
                makeWorkflowProjectorLayer({ repoRoot: absClusterRoot }).pipe(
                  Layer.provide(makeWorkflowReadModelQueryLayer({ repoRoot: absClusterRoot })),
                )
              const ctx = yield* Layer.build(projectorLayer)
              return Context.get(ctx, WorkflowProjector)
            }).pipe(catchNonInterruptStage("setup"))

      if (projector === undefined) {
        return undefined
      }

      return yield* projector
        .projectAll({
          targetBranch,
          trigger: "done-pre-merge",
          repoRoot: absClusterRoot,
        })
        .pipe(catchNonInterruptStage("projection"))
    }),
  )

  if (outcome === undefined) {
    return
  }

  match(outcome)
    .with({ _tag: "Projected" }, () => undefined)
    .with({ _tag: "Skipped" }, ({ branch: skippedBranch, reason }) => {
      process.stderr.write(
        `[harness:done] Info: pre-merge workflow projection skipped on '${skippedBranch}': ${reason}\n`,
      )
    })
    .with({ _tag: "Stale" }, ({ branch: staleBranch, reason }) => {
      process.stderr.write(
        `[harness:done] Warning: workflow projection before merge stale on '${staleBranch}': ${reason}\n`,
      )
    })
    .exhaustive()
})
