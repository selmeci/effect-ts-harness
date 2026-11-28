import { join, resolve } from "node:path"
import { Cause, Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AbsoluteRepoRoot,
  isPureInterruptCause,
  OmnigraphBranchName,
  toBoundedReason,
  WorkflowProjectionTargetBranch,
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
}

/**
 * Re-projects durable workflow runs into graph `harness` on `impl/<task>` after `done`
 * reloads the implementation snapshot and before pre-merge verification / merge (`SPEC-0038`).
 */
export const reprojectWorkflowsBeforeMerge = Effect.fn(
  "DoneWorkflowProjector.reprojectBeforeMerge",
)(function* (input: ReprojectWorkflowsBeforeMergeInput): Effect.fn.Return<void> {
  return yield* Effect.gen(function* () {
    if (input.workflowProjector === undefined) {
      const wfGraphDir = join(
        resolveOmnigraphClusterDir(input.clusterRepoRoot, nodeSyncHostIo),
        "graphs",
        "harness-workflows.omni",
      )
      if (!nodeSyncHostIo.existsSync(wfGraphDir)) {
        return
      }
    }

    const absClusterRoot = match(
      Schema.decodeOption(AbsoluteRepoRoot)(resolve(input.clusterRepoRoot)),
    )
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    const branch = match(Schema.decodeOption(OmnigraphBranchName)(input.implBranch))
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()

    if (absClusterRoot === undefined || branch === undefined) {
      process.stderr.write(
        "[harness:done] Warning: workflow projection before merge skipped due to invalid clusterRepoRoot or implBranch\n",
      )
      return
    }

    const targetBranch = WorkflowProjectionTargetBranch.cases.Explicit.make({ branch })
    const outcome =
      input.workflowProjector !== undefined
        ? yield* input.workflowProjector.projectAll({
            targetBranch,
            trigger: "done-pre-merge",
            repoRoot: absClusterRoot,
          })
        : yield* Effect.gen(function* () {
            const projector = yield* WorkflowProjector
            return yield* projector.projectAll({
              targetBranch,
              trigger: "done-pre-merge",
              repoRoot: absClusterRoot,
            })
          }).pipe(
            Effect.provide(
              makeWorkflowProjectorLayer({ repoRoot: absClusterRoot }).pipe(
                Layer.provide(makeWorkflowReadModelQueryLayer({ repoRoot: absClusterRoot })),
              ),
            ),
          )

    match(outcome)
      .with({ _tag: "Projected" }, () => undefined)
      .with({ _tag: "Skipped" }, () => undefined)
      .with({ _tag: "Stale" }, ({ reason }) => {
        process.stderr.write(
          `[harness:done] Warning: workflow projection before merge stale on '${branch}': ${reason}\n`,
        )
      })
      .exhaustive()
  }).pipe(
    Effect.catchCause((cause) => {
      if (isPureInterruptCause(cause)) {
        return Effect.failCause(cause)
      }
      process.stderr.write(
        `[harness:done] Warning: workflow projection before merge failed (${toBoundedReason(Cause.pretty(cause))})\n`,
      )
      return Effect.void
    }),
  )
})
