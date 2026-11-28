import { Option, Schema } from "effect"
import { match } from "ts-pattern"
import { NonNegativeCount } from "./ast-and-gate-primitives.js"
import { OmnigraphBranchName, OmnigraphCommitId } from "./omnigraph.js"
import { AbsoluteRepoRoot } from "./repo-identity.js"
import { WorkflowRunId } from "./workflow.js"
import { WorkflowProjectionStatus } from "./workflow-rpc.js"
import { WorkflowStoreFailureReason } from "./workflow-storage.js"

/** Trigger source that initiated readable projection into graph `harness`. */
export const WorkflowProjectorTrigger = Schema.Literals(["wave", "done-pre-merge", "post-rebuild"])
export type WorkflowProjectorTrigger = typeof WorkflowProjectorTrigger.Type

/** Target branch selector for readable projection (`Explicit` branch or active task `impl/<task>` branch). */
export const WorkflowProjectionTargetBranch = Schema.TaggedUnion({
  Explicit: { branch: OmnigraphBranchName },
  ActiveTaskImplBranch: {},
})
export type WorkflowProjectionTargetBranch = typeof WorkflowProjectionTargetBranch.Type

/** Input payload for `WorkflowProjector.project`. */
export const WorkflowProjectorInput = Schema.Struct({
  runId: WorkflowRunId,
  targetBranch: WorkflowProjectionTargetBranch,
  trigger: WorkflowProjectorTrigger,
  repoRoot: Schema.optional(AbsoluteRepoRoot),
})
export type WorkflowProjectorInput = typeof WorkflowProjectorInput.Type

/** Input payload for `WorkflowProjector.projectAll`. */
export const WorkflowProjectAllInput = Schema.Struct({
  targetBranch: WorkflowProjectionTargetBranch,
  trigger: WorkflowProjectorTrigger,
  repoRoot: Schema.optional(AbsoluteRepoRoot),
})
export type WorkflowProjectAllInput = typeof WorkflowProjectAllInput.Type

/** Entity and edge counts upserted during a readable workflow projection run. */
export const WorkflowProjectionCounts = Schema.Struct({
  runsUpserted: NonNegativeCount,
  unitsUpserted: NonNegativeCount,
  attemptsUpserted: NonNegativeCount,
  edgesUpserted: NonNegativeCount,
})
export type WorkflowProjectionCounts = typeof WorkflowProjectionCounts.Type

/** Closed discriminated outcome union returned by `WorkflowProjector.project`. */
export const WorkflowProjectionOutcome = Schema.TaggedUnion({
  Projected: {
    runId: WorkflowRunId,
    branch: OmnigraphBranchName,
    projectionStatus: Schema.Literal("fresh"),
    commitId: Schema.NullOr(OmnigraphCommitId),
    counts: WorkflowProjectionCounts,
  },
  Skipped: {
    runId: WorkflowRunId,
    branch: OmnigraphBranchName,
    projectionStatus: Schema.Literal("not-projected"),
    reason: WorkflowStoreFailureReason,
  },
  Stale: {
    runId: WorkflowRunId,
    branch: OmnigraphBranchName,
    projectionStatus: Schema.Literal("stale"),
    reason: WorkflowStoreFailureReason,
  },
})
export type WorkflowProjectionOutcome = typeof WorkflowProjectionOutcome.Type

/** Narrowed non-stale outcome union allowed as children of `WorkflowProjectAllOutcome.Projected`. */
export const WorkflowProjectionNonStaleOutcome = Schema.Union([
  WorkflowProjectionOutcome.cases.Projected,
  WorkflowProjectionOutcome.cases.Skipped,
])
export type WorkflowProjectionNonStaleOutcome = typeof WorkflowProjectionNonStaleOutcome.Type

/** Closed discriminated outcome union returned by `WorkflowProjector.projectAll`. */
export const WorkflowProjectAllOutcome = Schema.TaggedUnion({
  Projected: {
    branch: OmnigraphBranchName,
    projectionStatus: Schema.Literal("fresh"),
    outcomes: Schema.Array(WorkflowProjectionNonStaleOutcome),
  },
  Skipped: {
    branch: OmnigraphBranchName,
    projectionStatus: Schema.Literal("not-projected"),
    reason: WorkflowStoreFailureReason,
  },
  Stale: {
    branch: OmnigraphBranchName,
    projectionStatus: Schema.Literal("stale"),
    outcomes: Schema.Array(WorkflowProjectionOutcome),
    reason: WorkflowStoreFailureReason,
  },
})
export type WorkflowProjectAllOutcome = typeof WorkflowProjectAllOutcome.Type

/** Extracts the canonical `WorkflowProjectionStatus` from a `WorkflowProjectionOutcome`. */
export const projectionStatusOfOutcome = (
  outcome: WorkflowProjectionOutcome,
): WorkflowProjectionStatus =>
  match(outcome)
    .with({ _tag: "Projected" }, () => WorkflowProjectionStatus.make("fresh"))
    .with({ _tag: "Skipped" }, () => WorkflowProjectionStatus.make("not-projected"))
    .with({ _tag: "Stale" }, () => WorkflowProjectionStatus.make("stale"))
    .exhaustive()

/**
 * Combines read-model freshness with readable `harness` projection freshness so any
 * readable projection failure surfaces `"stale"` and skipped readable projection surfaces
 * `"not-projected"` in `workflow status` / `harness_workflow_plan`.
 */
export const mergeWorkflowProjectionStatus = (
  readModelStatus: WorkflowProjectionStatus,
  readableStatus: Option.Option<WorkflowProjectionStatus>,
): WorkflowProjectionStatus =>
  match(readModelStatus)
    .with("stale", () => WorkflowProjectionStatus.make("stale"))
    .with("fresh", "not-projected", () =>
      match(readableStatus)
        .with({ _tag: "None" }, () => readModelStatus)
        .with({ _tag: "Some" }, ({ value }) =>
          match(value)
            .with("stale", () => WorkflowProjectionStatus.make("stale"))
            .with("not-projected", () => WorkflowProjectionStatus.make("not-projected"))
            .with("fresh", () => readModelStatus)
            .exhaustive(),
        )
        .exhaustive(),
    )
    .exhaustive()
