import { Arbitrary, Effect, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { describe, expect, it } from "vitest"
import {
  WorkflowProjectAllInput,
  WorkflowProjectAllOutcome,
  WorkflowProjectionCounts,
  WorkflowProjectionNonStaleOutcome,
  WorkflowProjectionOutcome,
  WorkflowProjectionStatus,
  WorkflowProjectionTargetBranch,
  WorkflowProjectorInput,
  WorkflowProjectorTrigger,
  mergeWorkflowProjectionStatus,
  projectionStatusOfOutcome,
} from "../src/index.js"

const rawCounts = {
  runsUpserted: 1,
  unitsUpserted: 3,
  attemptsUpserted: 2,
  edgesUpserted: 9,
}

const sampleCounts = Schema.decodeSync(WorkflowProjectionCounts)(rawCounts)

const decodeSampleOutcome = (raw: unknown): WorkflowProjectionOutcome =>
  Schema.decodeUnknownSync(WorkflowProjectionOutcome)(raw)

const runId = "wf6-proj-run-001"
const branch = "impl/wf6-projection"
const commitId = "cmt-wf6-001"
const repoRoot = "/tmp/harness-wf6-repo"
const failureReason = "omnigraph 412 precondition failed"

const outcomeArb: Arbitrary.Arbitrary<WorkflowProjectionOutcome> = Arbitrary.map(
  Arbitrary.all({
    kind: Arbitrary.schema(Schema.Literals(["Projected", "Skipped", "Stale"])),
    hasCommit: Arbitrary.schema(Schema.Literals([true, false])),
  }),
  ({ kind, hasCommit }) =>
    match(kind)
      .with("Projected", () =>
        decodeSampleOutcome({
          _tag: "Projected",
          runId,
          branch,
          projectionStatus: "fresh",
          commitId: hasCommit ? commitId : null,
          counts: rawCounts,
        }),
      )
      .with("Skipped", () =>
        decodeSampleOutcome({
          _tag: "Skipped",
          runId,
          branch,
          projectionStatus: "not-projected",
          reason: failureReason,
        }),
      )
      .with("Stale", () =>
        decodeSampleOutcome({
          _tag: "Stale",
          runId,
          branch,
          projectionStatus: "stale",
          reason: failureReason,
        }),
      )
      .exhaustive(),
)

describe("workflow-projection contracts & status helpers", () => {
  it("validates WorkflowProjectorTrigger, WorkflowProjectionTargetBranch, WorkflowProjectorInput, and WorkflowProjectAllInput", () => {
    for (const trigger of ["wave", "done-pre-merge", "post-rebuild"] as const) {
      expect(Schema.decodeSync(WorkflowProjectorTrigger)(trigger)).toBe(trigger)
    }
    expect(Result.isFailure(Schema.decodeUnknownResult(WorkflowProjectorTrigger)("manual"))).toBe(
      true,
    )

    const explicitBranch = Schema.decodeSync(WorkflowProjectionTargetBranch)({
      _tag: "Explicit",
      branch,
    })
    const activeBranch = Schema.decodeSync(WorkflowProjectionTargetBranch)({
      _tag: "ActiveTaskImplBranch",
    })
    expect(Schema.decodeSync(WorkflowProjectionTargetBranch)(explicitBranch)).toEqual(
      explicitBranch,
    )
    expect(Schema.decodeSync(WorkflowProjectionTargetBranch)(activeBranch)).toEqual(activeBranch)
    expect(
      Result.isFailure(
        Schema.decodeResult(WorkflowProjectionTargetBranch)({
          _tag: "Explicit",
          branch: "",
        }),
      ),
    ).toBe(true)

    const inputWithoutRepo = Schema.decodeSync(WorkflowProjectorInput)({
      runId,
      targetBranch: explicitBranch,
      trigger: "wave",
    })
    const inputWithRepo = Schema.decodeSync(WorkflowProjectorInput)({
      runId,
      targetBranch: activeBranch,
      trigger: "done-pre-merge",
      repoRoot,
    })
    expect(Schema.decodeSync(WorkflowProjectorInput)(inputWithoutRepo)).toEqual(inputWithoutRepo)
    expect(Schema.decodeSync(WorkflowProjectorInput)(inputWithRepo)).toEqual(inputWithRepo)
    expect(
      Result.isFailure(
        Schema.decodeResult(WorkflowProjectorInput)({
          runId: "BAD",
          targetBranch: explicitBranch,
          trigger: "wave",
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeResult(WorkflowProjectorInput)({
          runId,
          targetBranch: explicitBranch,
          trigger: "wave",
          repoRoot: "relative/path",
        }),
      ),
    ).toBe(true)

    const allWithoutRepo = Schema.decodeSync(WorkflowProjectAllInput)({
      targetBranch: explicitBranch,
      trigger: "post-rebuild",
    })
    const allWithRepo = Schema.decodeSync(WorkflowProjectAllInput)({
      targetBranch: activeBranch,
      trigger: "post-rebuild",
      repoRoot,
    })
    expect(Schema.decodeSync(WorkflowProjectAllInput)(allWithoutRepo)).toEqual(allWithoutRepo)
    expect(Schema.decodeSync(WorkflowProjectAllInput)(allWithRepo)).toEqual(allWithRepo)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WorkflowProjectAllInput)({
          targetBranch: activeBranch,
          trigger: "unknown",
        }),
      ),
    ).toBe(true)
  })

  it("validates WorkflowProjectionCounts, WorkflowProjectionOutcome, and WorkflowProjectAllOutcome", () => {
    const zeroCounts = Schema.decodeSync(WorkflowProjectionCounts)({
      runsUpserted: 0,
      unitsUpserted: 0,
      attemptsUpserted: 0,
      edgesUpserted: 0,
    })
    expect(Schema.decodeSync(WorkflowProjectionCounts)(zeroCounts)).toEqual(zeroCounts)
    expect(Schema.decodeSync(WorkflowProjectionCounts)(sampleCounts)).toEqual(sampleCounts)
    for (const badCount of [-1, 1.5, "1", null, undefined, Number.NaN]) {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(WorkflowProjectionCounts)({
            runsUpserted: badCount,
            unitsUpserted: 0,
            attemptsUpserted: 0,
            edgesUpserted: 0,
          }),
        ),
      ).toBe(true)
    }

    const projectedWithCommit = decodeSampleOutcome({
      _tag: "Projected",
      runId,
      branch,
      projectionStatus: "fresh",
      commitId,
      counts: rawCounts,
    })
    const projectedNoOp = decodeSampleOutcome({
      _tag: "Projected",
      runId,
      branch,
      projectionStatus: "fresh",
      commitId: null,
      counts: zeroCounts,
    })
    const skipped = decodeSampleOutcome({
      _tag: "Skipped",
      runId,
      branch,
      projectionStatus: "not-projected",
      reason: failureReason,
    })
    const stale = decodeSampleOutcome({
      _tag: "Stale",
      runId,
      branch,
      projectionStatus: "stale",
      reason: failureReason,
    })

    for (const outcome of [projectedWithCommit, projectedNoOp, skipped, stale]) {
      expect(Schema.decodeSync(WorkflowProjectionOutcome)(outcome)).toEqual(outcome)
    }

    // Mismatched projectionStatus literal must fail decode
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WorkflowProjectionOutcome)({
          _tag: "Projected",
          runId,
          branch,
          projectionStatus: "stale",
          commitId: null,
          counts: zeroCounts,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WorkflowProjectionOutcome)({
          _tag: "Skipped",
          runId,
          branch,
          projectionStatus: "fresh",
          reason: failureReason,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WorkflowProjectionOutcome)({
          _tag: "Stale",
          runId,
          branch,
          projectionStatus: "fresh",
          reason: failureReason,
        }),
      ),
    ).toBe(true)

    const nonStaleProjected = Schema.decodeUnknownSync(WorkflowProjectionNonStaleOutcome)(
      projectedWithCommit,
    )
    const nonStaleSkipped = Schema.decodeUnknownSync(WorkflowProjectionNonStaleOutcome)(skipped)
    const allProjected = Schema.decodeSync(WorkflowProjectAllOutcome)({
      _tag: "Projected",
      branch,
      projectionStatus: "fresh",
      outcomes: [nonStaleProjected, nonStaleSkipped],
    })
    const allSkipped = Schema.decodeSync(WorkflowProjectAllOutcome)({
      _tag: "Skipped",
      branch,
      projectionStatus: "not-projected",
      reason: failureReason,
    })
    const allStale = Schema.decodeSync(WorkflowProjectAllOutcome)({
      _tag: "Stale",
      branch,
      projectionStatus: "stale",
      outcomes: [projectedWithCommit, stale],
      reason: failureReason,
    })

    for (const allOutcome of [allProjected, allSkipped, allStale]) {
      expect(Schema.decodeSync(WorkflowProjectAllOutcome)(allOutcome)).toEqual(allOutcome)
    }
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WorkflowProjectAllOutcome)({
          _tag: "Projected",
          branch,
          projectionStatus: "fresh",
          outcomes: [projectedWithCommit, stale],
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WorkflowProjectAllOutcome)({
          _tag: "Stale",
          branch,
          projectionStatus: "fresh",
          outcomes: [],
          reason: failureReason,
        }),
      ),
    ).toBe(true)
  })

  it("maps projectionStatusOfOutcome across all WorkflowProjectionOutcome variants", () => {
    const projected = decodeSampleOutcome({
      _tag: "Projected",
      runId,
      branch,
      projectionStatus: "fresh",
      commitId: null,
      counts: rawCounts,
    })
    const skipped = decodeSampleOutcome({
      _tag: "Skipped",
      runId,
      branch,
      projectionStatus: "not-projected",
      reason: failureReason,
    })
    const stale = decodeSampleOutcome({
      _tag: "Stale",
      runId,
      branch,
      projectionStatus: "stale",
      reason: failureReason,
    })

    expect(projectionStatusOfOutcome(projected)).toBe(WorkflowProjectionStatus.make("fresh"))
    expect(projectionStatusOfOutcome(skipped)).toBe(WorkflowProjectionStatus.make("not-projected"))
    expect(projectionStatusOfOutcome(stale)).toBe(WorkflowProjectionStatus.make("stale"))

    const propCheck = Effect.runSync(
      Arbitrary.checkEffect(
        outcomeArb,
        (outcome) => projectionStatusOfOutcome(outcome) === outcome.projectionStatus,
        { runs: 60, seed: 38 },
      ),
    )
    expect(propCheck._tag).toBe("Passed")
  })

  it("merges readModelStatus and readableStatus exhaustively via mergeWorkflowProjectionStatus", () => {
    const staleStatus = WorkflowProjectionStatus.make("stale")
    const freshStatus = WorkflowProjectionStatus.make("fresh")
    const notProjectedStatus = WorkflowProjectionStatus.make("not-projected")

    // readModelStatus === "stale" always remains "stale" regardless of readableStatus
    for (const readable of [
      Option.none<WorkflowProjectionStatus>(),
      Option.some(freshStatus),
      Option.some(notProjectedStatus),
      Option.some(staleStatus),
    ]) {
      expect(mergeWorkflowProjectionStatus(staleStatus, readable)).toBe(staleStatus)
    }

    // readModelStatus in {"fresh", "not-projected"}: None/fresh keeps readModelStatus; not-projected & stale propagate
    for (const readModelStatus of [notProjectedStatus, freshStatus]) {
      expect(mergeWorkflowProjectionStatus(readModelStatus, Option.none())).toBe(readModelStatus)
      expect(mergeWorkflowProjectionStatus(readModelStatus, Option.some(freshStatus))).toBe(
        readModelStatus,
      )
      expect(mergeWorkflowProjectionStatus(readModelStatus, Option.some(notProjectedStatus))).toBe(
        notProjectedStatus,
      )
      expect(mergeWorkflowProjectionStatus(readModelStatus, Option.some(staleStatus))).toBe(
        staleStatus,
      )
    }
  })
})
