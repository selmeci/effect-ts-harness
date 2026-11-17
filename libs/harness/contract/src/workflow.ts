import { Schema } from "effect"
import { GitCommitSha } from "./repo-identity.js"
import { ReviewRoutingPlan } from "./review-routing.js"

const FIRST_REL_SEGMENT =
  "(?!\\.\\.?(?:\\/|$))[^\\x00-\\x1f\\x7f\\\\/\\s:](?:[^\\x00-\\x1f\\x7f\\\\/:]*[^\\x00-\\x1f\\x7f\\\\/\\s:])?"
const NEXT_REL_SEGMENT =
  "(?!\\.\\.?(?:\\/|$))[^\\x00-\\x1f\\x7f\\\\/\\s](?:[^\\x00-\\x1f\\x7f\\\\/]*[^\\x00-\\x1f\\x7f\\\\/\\s])?"
const SAFE_OWNED_REL_PATH_RE = new RegExp(`^${FIRST_REL_SEGMENT}(?:\\/${NEXT_REL_SEGMENT})*$`)

export const WorkflowRunId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{7,63}$/)),
  Schema.brand("WorkflowRunId"),
)
export type WorkflowRunId = typeof WorkflowRunId.Type

export const WorkUnitId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_.:-]{0,63}$/)),
  Schema.brand("WorkUnitId"),
)
export type WorkUnitId = typeof WorkUnitId.Type

export const AttemptNumber = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  Schema.brand("AttemptNumber"),
)
export type AttemptNumber = typeof AttemptNumber.Type

export const ShipAttempt = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("ShipAttempt"),
)
export type ShipAttempt = typeof ShipAttempt.Type

export const WaveIndex = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("WaveIndex"),
)
export type WaveIndex = typeof WaveIndex.Type

export const NxProjectName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("NxProjectName"),
)
export type NxProjectName = typeof NxProjectName.Type

export const OwnedRelPath = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(1, 512)),
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(SAFE_OWNED_REL_PATH_RE)),
  Schema.brand("OwnedRelPath"),
)
export type OwnedRelPath = typeof OwnedRelPath.Type

export const WorkspaceTreeHash = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("WorkspaceTreeHash"),
)
export type WorkspaceTreeHash = typeof WorkspaceTreeHash.Type

export const PackageStampHash = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("PackageStampHash"),
)
export type PackageStampHash = typeof PackageStampHash.Type

export const PlanSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("PlanSha256"),
)
export type PlanSha256 = typeof PlanSha256.Type

export const StubSymbolKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("StubSymbolKey"),
)
export type StubSymbolKey = typeof StubSymbolKey.Type

export const EarsRequirementKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("EarsRequirementKey"),
)
export type EarsRequirementKey = typeof EarsRequirementKey.Type

export const PackageVerifyCommand = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("PackageVerifyCommand"),
)
export type PackageVerifyCommand = typeof PackageVerifyCommand.Type

export const AgentFailureReason = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("AgentFailureReason"),
)
export type AgentFailureReason = typeof AgentFailureReason.Type

export const WorkflowCompileReason = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("WorkflowCompileReason"),
)
export type WorkflowCompileReason = typeof WorkflowCompileReason.Type

export const SliceBranchName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^slice\/[a-z0-9][a-z0-9-]*-[a-z0-9][a-z0-9-]*$/)),
  Schema.brand("SliceBranchName"),
)
export type SliceBranchName = typeof SliceBranchName.Type

export const WorkflowLevel = Schema.Literals(["epic", "slice"]).pipe(Schema.brand("WorkflowLevel"))
export type WorkflowLevel = typeof WorkflowLevel.Type

export const SHIP_STAGES = [
  "format-check",
  "gc-strict",
  "ontology-check-strict",
  "mutate-strict",
  "verify",
  "done",
] as const

export const ShipStage = Schema.Literals(SHIP_STAGES).pipe(Schema.brand("ShipStage"))
export type ShipStage = typeof ShipStage.Type

export const RUNNER_IDS = ["claude-code", "antigravity"] as const

export const RunnerId = Schema.Literals(RUNNER_IDS).pipe(Schema.brand("RunnerId"))
export type RunnerId = typeof RunnerId.Type

export const MaxConcurrency = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  Schema.brand("MaxConcurrency"),
)
export type MaxConcurrency = typeof MaxConcurrency.Type

export const GateExitCode = Schema.Int.pipe(Schema.brand("GateExitCode"))
export type GateExitCode = typeof GateExitCode.Type

export const FrictionLogState = Schema.Literals(["cleared"]).pipe(Schema.brand("FrictionLogState"))
export type FrictionLogState = typeof FrictionLogState.Type

export const UnitMode = Schema.TaggedUnion({
  Automatic: { runner: RunnerId, maxConcurrency: MaxConcurrency },
  Manual: {},
})
export type UnitMode = typeof UnitMode.Type

export const CompiledWorkUnit = Schema.TaggedUnion({
  SliceUnit: {
    unitId: WorkUnitId,
    branch: SliceBranchName,
    waveIndex: WaveIndex,
    dependsOn: Schema.Array(WorkUnitId),
    ownedRelPaths: Schema.Array(OwnedRelPath),
    earsKeys: Schema.Array(EarsRequirementKey),
  },
  PackageUnit: {
    unitId: WorkUnitId,
    projectName: NxProjectName,
    waveIndex: WaveIndex,
    dependsOn: Schema.Array(WorkUnitId),
    ownedRelPaths: Schema.Array(OwnedRelPath),
    stubKeys: Schema.Array(StubSymbolKey),
    earsKeys: Schema.Array(EarsRequirementKey),
    packageVerifyCommand: PackageVerifyCommand,
  },
})
export type CompiledWorkUnit = typeof CompiledWorkUnit.Type

export const CompiledPlan = Schema.Struct({
  runId: WorkflowRunId,
  level: WorkflowLevel,
  planSha: PlanSha256,
  baseSha: GitCommitSha,
  mode: UnitMode,
  units: Schema.Array(CompiledWorkUnit),
  sharedStepPaths: Schema.Array(OwnedRelPath),
})
export type CompiledPlan = typeof CompiledPlan.Type

export const UnitDependency = Schema.Struct({
  from: WorkUnitId,
  to: WorkUnitId,
})
export type UnitDependency = typeof UnitDependency.Type

export const CompileInput = Schema.Struct({
  units: Schema.Array(CompiledWorkUnit),
  dependencies: Schema.Array(UnitDependency),
})
export type CompileInput = typeof CompileInput.Type

export const CompiledWave = Schema.Struct({
  waveIndex: WaveIndex,
  units: Schema.Array(CompiledWorkUnit),
})
export type CompiledWave = typeof CompiledWave.Type

export const CompiledWaves = Schema.Struct({
  units: Schema.Array(CompiledWorkUnit),
  waves: Schema.Array(CompiledWave),
})
export type CompiledWaves = typeof CompiledWaves.Type

export const UnitRejection = Schema.TaggedUnion({
  WriteSetViolation: { offendingPaths: Schema.Array(OwnedRelPath) },
  PackageVerifyFailed: { exitCode: GateExitCode },
  StampMissing: {},
  AgentFailed: { reason: AgentFailureReason },
})
export type UnitRejection = typeof UnitRejection.Type

export const UnitEscalation = Schema.TaggedUnion({
  AuthRequired: { runner: RunnerId },
  RetryBudgetExhausted: { lastRejection: UnitRejection },
  MergeConflict: { branch: SliceBranchName },
})
export type UnitEscalation = typeof UnitEscalation.Type

export const UnitOutcome = Schema.TaggedUnion({
  Completed: {
    unitId: WorkUnitId,
    attempt: AttemptNumber,
    changedPaths: Schema.Array(OwnedRelPath),
    packageStampHash: PackageStampHash,
  },
  Rejected: { unitId: WorkUnitId, attempt: AttemptNumber, rejection: UnitRejection },
  Escalated: { unitId: WorkUnitId, escalation: UnitEscalation },
})
export type UnitOutcome = typeof UnitOutcome.Type
export type UnitCompletedOutcome = typeof UnitOutcome.cases.Completed.Type

export const LlmPhaseReceipt = Schema.Struct({
  workspaceHash: WorkspaceTreeHash,
  frictionLogCleared: FrictionLogState,
})
export type LlmPhaseReceipt = typeof LlmPhaseReceipt.Type

export const TaskRunReceipt = Schema.Struct({
  runId: WorkflowRunId,
  review: ReviewRoutingPlan,
  completedUnits: Schema.Array(WorkUnitId),
  llmPhase: LlmPhaseReceipt,
})
export type TaskRunReceipt = typeof TaskRunReceipt.Type

export const ShipReceipt = Schema.Struct({
  runId: WorkflowRunId,
  attempt: ShipAttempt,
  verifiedTreeHash: WorkspaceTreeHash,
})
export type ShipReceipt = typeof ShipReceipt.Type

export const PlanGraphIssue = Schema.TaggedUnion({
  DuplicateWorkUnitId: { unitId: WorkUnitId },
  DanglingUnitDependency: {
    from: WorkUnitId,
    to: WorkUnitId,
    missingUnitId: WorkUnitId,
  },
})
export type PlanGraphIssue = typeof PlanGraphIssue.Type

export class CyclicPlanWorkflowError extends Schema.TaggedError<CyclicPlanWorkflowError>()(
  "CyclicPlanWorkflowError",
  {
    cycleUnits: Schema.Array(WorkUnitId),
    reason: WorkflowCompileReason,
  },
) {}

export class DisjointOwnershipViolationError extends Schema.TaggedError<DisjointOwnershipViolationError>()(
  "DisjointOwnershipViolationError",
  {
    waveIndex: WaveIndex,
    overlappingPaths: Schema.Array(OwnedRelPath),
  },
) {}

export class InvalidPlanWorkflowGraphError extends Schema.TaggedError<InvalidPlanWorkflowGraphError>()(
  "InvalidPlanWorkflowGraphError",
  {
    issue: PlanGraphIssue,
    reason: WorkflowCompileReason,
  },
) {}

export const wavesOf = (source: CompiledPlan | CompiledWaves): ReadonlyArray<CompiledWave> => {
  const grouped = new Map<WaveIndex, Array<CompiledWorkUnit>>()
  for (const unit of source.units) {
    const existing = grouped.get(unit.waveIndex)
    if (existing !== undefined) {
      existing.push(unit)
    } else {
      grouped.set(unit.waveIndex, [unit])
    }
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([waveIndex, units]) => ({
      waveIndex,
      units: [...units].sort((a, b) => a.unitId.localeCompare(b.unitId)),
    }))
}
