import { Match, Option, Schema } from "effect"
import { compareCodeUnits } from "./ast-and-gate-primitives.js"
import { AbsoluteRepoRoot, GitCommitSha } from "./repo-identity.js"
import { ReviewRoutingPlan } from "./review-routing.js"
import {
  NxAffectedTargetFlag,
  NxProjectName,
  PackageVerifyCommand,
  PackageVerifyCommandArgv,
  PackageVerifyExecutable,
  PackageVerifyTarget,
  ParsedPackageVerifyCommand,
  parsePackageVerifyCommand,
  toPackageVerifyCommandArgv,
} from "./workflow-verify-command.js"

export {
  NxAffectedTargetFlag,
  NxProjectName,
  PackageVerifyCommand,
  PackageVerifyCommandArgv,
  PackageVerifyExecutable,
  PackageVerifyTarget,
  ParsedPackageVerifyCommand,
  parsePackageVerifyCommand,
  toPackageVerifyCommandArgv,
}

const SAFE_REL_SEGMENT =
  "(?!\\.\\.?(?:\\/|$))[^\\x00-\\x1f\\x7f\\\\/\\s:.](?:[^\\x00-\\x1f\\x7f\\\\/:]*[^\\x00-\\x1f\\x7f\\\\/\\s:.])?"
const SAFE_OWNED_REL_PATH_RE = new RegExp(`^${SAFE_REL_SEGMENT}(?:\\/${SAFE_REL_SEGMENT})*$`)
const PROTECTED_OWNED_PATH_RE =
  /^(?:\.git|\.harness|repos\/(?:effect|alchemy)|tools\/oxlint)(?:\/|$)/i

/** Lowercase alphanumeric + hyphen workflow run identifier (`8..64` chars). */
export const WorkflowRunId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{7,63}$/)),
  Schema.brand("WorkflowRunId"),
)
export type WorkflowRunId = typeof WorkflowRunId.Type

/** Lowercase work unit identifier (`1..64` chars, `[a-z0-9_.:-]`). */
export const WorkUnitId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_.:-]{0,63}$/)),
  Schema.brand("WorkUnitId"),
)
export type WorkUnitId = typeof WorkUnitId.Type

/** Reserved work unit identifier for sequential `sharedStepPaths` execution (`REQ-1.4`). */
export const SHARED_STEP_UNIT_ID: WorkUnitId = WorkUnitId.make("shared-step")

/** Deterministic Effect workflow execution identifier (`Workflow.executionId` output). */
export const WorkflowExecutionId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("WorkflowExecutionId"),
)
export type WorkflowExecutionId = typeof WorkflowExecutionId.Type

/** 1-based escalation cycle ordinal (`>= 1`) scoped per `WorkUnitId`. */
export const EscalationOrdinal = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("EscalationOrdinal"),
)
export type EscalationOrdinal = typeof EscalationOrdinal.Type

/** Operator resolution decision for an escalated workflow unit (`retry | abort`). */
export const EscalationDecision = Schema.Literals(["retry", "abort"])
export type EscalationDecision = typeof EscalationDecision.Type

/** Payload carried on `escalation/<unitId>/<n>` `DurableDeferred` resolution. */
export const EscalationResolution = Schema.Struct({
  decision: EscalationDecision,
})
export type EscalationResolution = typeof EscalationResolution.Type

/** Bounded 1-based execution attempt (`1..3`; max 3 attempts per unit before escalation). */
export const AttemptNumber = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  Schema.brand("AttemptNumber"),
)
export type AttemptNumber = typeof AttemptNumber.Type

/** 1-based ship-gate attempt counter (`>= 1`). */
export const ShipAttempt = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("ShipAttempt"),
)
export type ShipAttempt = typeof ShipAttempt.Type

/** 0-based topological execution wave index (`>= 0`). */
export const WaveIndex = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("WaveIndex"),
)
export type WaveIndex = typeof WaveIndex.Type

/**
 * Normalized repo-relative file path or directory subtree prefix (`1..512` chars).
 * Rejects leading/trailing `/`, `.` or `..` segments, trailing `.` on segments, `\\`, `//`, `:`,
 * control chars, and protected VCS/TCB/vendor subtrees (`.git`, `.harness`, `repos/effect`,
 * `repos/alchemy`, `tools/oxlint`).
 * In ownership disjointness checks (`pathsOverlap`), an `OwnedRelPath` covers both the exact path
 * and all descendant paths under `<OwnedRelPath>/` with NFC + case-folded comparison.
 */
export const OwnedRelPath = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(1, 512)),
  Schema.check(Schema.isPattern(SAFE_OWNED_REL_PATH_RE)),
  Schema.check(
    Schema.makeFilter((path) => !PROTECTED_OWNED_PATH_RE.test(path), {
      message:
        "OwnedRelPath must not target protected .git, .harness, repos/effect, repos/alchemy, or tools/oxlint paths",
    }),
  ),
  Schema.brand("OwnedRelPath"),
)
export type OwnedRelPath = typeof OwnedRelPath.Type

/**
 * Returns `true` when two `OwnedRelPath` entries collide by exact equality or strict
 * segment-boundary directory prefix after NFC normalization and case-folding.
 */
export const pathsOverlap = (a: OwnedRelPath, b: OwnedRelPath): boolean => {
  const normA = a.normalize("NFC").toLowerCase()
  const normB = b.normalize("NFC").toLowerCase()
  return normA === normB || normB.startsWith(`${normA}/`) || normA.startsWith(`${normB}/`)
}

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

export const SliceBranchName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^slice\/[a-z0-9][a-z0-9-]*-[a-z0-9][a-z0-9-]*$/)),
  Schema.brand("SliceBranchName"),
)
export type SliceBranchName = typeof SliceBranchName.Type

export const WorkflowLevel = Schema.Literals(["epic", "slice"])
export type WorkflowLevel = typeof WorkflowLevel.Type

export const SHIP_STAGES = [
  "format-check",
  "gc-strict",
  "ontology-check-strict",
  "mutate-strict",
  "verify",
  "done",
] as const

export const ShipStage = Schema.Literals(SHIP_STAGES)
export type ShipStage = typeof ShipStage.Type

export const RUNNER_IDS = ["claude-code", "antigravity"] as const

export const RunnerId = Schema.Literals(RUNNER_IDS)
export type RunnerId = typeof RunnerId.Type

/** Bounded parallel worker slots per wave (`1..8`). */
export const MaxConcurrency = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  Schema.brand("MaxConcurrency"),
)
export type MaxConcurrency = typeof MaxConcurrency.Type

/** Non-zero POSIX process exit code (`1..255`) reported when a package verify gate fails. */
export const GateExitCode = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 255 })),
  Schema.brand("GateExitCode"),
)
export type GateExitCode = typeof GateExitCode.Type

export const FrictionLogState = Schema.Literals(["cleared"])
export type FrictionLogState = typeof FrictionLogState.Type

export const UnitMode = Schema.TaggedUnion({
  Automatic: { runner: RunnerId, maxConcurrency: MaxConcurrency },
  Manual: {},
})
export type UnitMode = typeof UnitMode.Type

const isNonReservedWorkUnitId = (unitId: WorkUnitId): boolean => unitId !== SHARED_STEP_UNIT_ID

const verifyCommandTargetsProject = (
  projectName: NxProjectName,
  command: PackageVerifyCommand,
): boolean =>
  Option.match(parsePackageVerifyCommand(command), {
    onNone: () => false,
    onSome: (parsed) =>
      Match.value(parsed).pipe(
        Match.tag("NxRun", (c) => c.projectName === projectName),
        Match.tag("PnpmFilter", (c) => c.projectName === projectName),
        Match.tag("NxAffected", () => true),
        Match.exhaustive,
      ),
  })

const hasValidPackageUnitVerifyTarget = (unit: {
  readonly unitId: WorkUnitId
  readonly projectName: NxProjectName
  readonly packageVerifyCommand: PackageVerifyCommand
}): boolean =>
  isNonReservedWorkUnitId(unit.unitId) &&
  verifyCommandTargetsProject(unit.projectName, unit.packageVerifyCommand)

export const SliceUnitDraft = Schema.TaggedStruct("SliceUnit", {
  unitId: WorkUnitId,
  branch: SliceBranchName,
  ownedRelPaths: Schema.Array(OwnedRelPath),
  earsKeys: Schema.Array(EarsRequirementKey),
}).pipe(
  Schema.check(
    Schema.makeFilter((unit) => isNonReservedWorkUnitId(unit.unitId), {
      message: "SliceUnitDraft unitId must not equal reserved SHARED_STEP_UNIT_ID ('shared-step')",
    }),
  ),
)
export type SliceUnitDraft = typeof SliceUnitDraft.Type

export const PackageUnitDraft = Schema.TaggedStruct("PackageUnit", {
  unitId: WorkUnitId,
  projectName: NxProjectName,
  ownedRelPaths: Schema.Array(OwnedRelPath),
  stubKeys: Schema.Array(StubSymbolKey),
  earsKeys: Schema.Array(EarsRequirementKey),
  packageVerifyCommand: PackageVerifyCommand,
}).pipe(
  Schema.check(
    Schema.makeFilter((unit) => hasValidPackageUnitVerifyTarget(unit), {
      message:
        "PackageUnitDraft must use non-reserved unitId and packageVerifyCommand targeting its projectName or nx affected",
    }),
  ),
)
export type PackageUnitDraft = typeof PackageUnitDraft.Type

export const WorkUnitDraft = Schema.Union([SliceUnitDraft, PackageUnitDraft])
export type WorkUnitDraft = typeof WorkUnitDraft.Type

const CompiledSliceUnit = Schema.TaggedStruct("SliceUnit", {
  unitId: WorkUnitId,
  branch: SliceBranchName,
  waveIndex: WaveIndex,
  dependsOn: Schema.Array(WorkUnitId),
  ownedRelPaths: Schema.Array(OwnedRelPath),
  earsKeys: Schema.Array(EarsRequirementKey),
}).pipe(
  Schema.check(
    Schema.makeFilter((unit) => isNonReservedWorkUnitId(unit.unitId), {
      message:
        "CompiledSliceUnit unitId must not equal reserved SHARED_STEP_UNIT_ID ('shared-step')",
    }),
  ),
)

const CompiledPackageUnit = Schema.TaggedStruct("PackageUnit", {
  unitId: WorkUnitId,
  projectName: NxProjectName,
  waveIndex: WaveIndex,
  dependsOn: Schema.Array(WorkUnitId),
  ownedRelPaths: Schema.Array(OwnedRelPath),
  stubKeys: Schema.Array(StubSymbolKey),
  earsKeys: Schema.Array(EarsRequirementKey),
  packageVerifyCommand: PackageVerifyCommand,
}).pipe(
  Schema.check(
    Schema.makeFilter((unit) => hasValidPackageUnitVerifyTarget(unit), {
      message:
        "CompiledPackageUnit must use non-reserved unitId and packageVerifyCommand targeting its projectName or nx affected",
    }),
  ),
)

export const CompiledWorkUnit = Schema.Union([CompiledSliceUnit, CompiledPackageUnit])
export type CompiledWorkUnit = typeof CompiledWorkUnit.Type

export const UnitDependency = Schema.Struct({
  from: WorkUnitId,
  to: WorkUnitId,
})
export type UnitDependency = typeof UnitDependency.Type

export const CompileInput = Schema.Struct({
  units: Schema.Array(WorkUnitDraft),
  dependencies: Schema.Array(UnitDependency),
})
export type CompileInput = typeof CompileInput.Type

export const CompiledWave = Schema.Struct({
  waveIndex: WaveIndex,
  units: Schema.NonEmptyArray(CompiledWorkUnit),
})
export type CompiledWave = typeof CompiledWave.Type

const groupWaves = (units: ReadonlyArray<CompiledWorkUnit>): ReadonlyArray<CompiledWave> => {
  const grouped = new Map<WaveIndex, Array<CompiledWorkUnit>>()
  for (const unit of units) {
    const existing = grouped.get(unit.waveIndex)
    if (existing !== undefined) {
      existing.push(unit)
    } else {
      grouped.set(unit.waveIndex, [unit])
    }
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([waveIndex, waveUnits]) => {
      const sorted = [...waveUnits].sort((a, b) => compareCodeUnits(a.unitId, b.unitId))
      const [first, ...rest] = sorted
      return first === undefined ? [] : [{ waveIndex, units: [first, ...rest] as const }]
    })
}

const isValidCompiledSchedule = (units: ReadonlyArray<CompiledWorkUnit>): boolean => {
  const byId = new Map<WorkUnitId, CompiledWorkUnit>()
  for (const unit of units) {
    if (byId.has(unit.unitId)) {
      return false
    }
    byId.set(unit.unitId, unit)
  }

  for (const unit of units) {
    for (const depId of unit.dependsOn) {
      const depUnit = byId.get(depId)
      if (depUnit === undefined || depUnit.waveIndex >= unit.waveIndex) {
        return false
      }
    }
  }

  const waves = groupWaves(units)
  for (let idx = 0; idx < waves.length; idx += 1) {
    const wave = waves[idx]!
    if (wave.waveIndex !== idx) {
      return false
    }
    for (let i = 0; i < wave.units.length; i += 1) {
      const unitA = wave.units[i]!
      for (let j = i + 1; j < wave.units.length; j += 1) {
        const unitB = wave.units[j]!
        for (const pathA of unitA.ownedRelPaths) {
          for (const pathB of unitB.ownedRelPaths) {
            if (pathsOverlap(pathA, pathB)) {
              return false
            }
          }
        }
      }
    }
  }

  return true
}

export const CompiledWaves = Schema.Struct({
  units: Schema.Array(CompiledWorkUnit),
}).pipe(
  Schema.check(
    Schema.makeFilter((compiled) => isValidCompiledSchedule(compiled.units), {
      message:
        "CompiledWaves must have unique unitIds, strictly earlier waveIndex for dependencies, dense 0..N-1 waves, and disjoint ownedRelPaths per wave",
    }),
  ),
)
export type CompiledWaves = typeof CompiledWaves.Type

const isValidCompiledPlan = (plan: {
  readonly units: ReadonlyArray<CompiledWorkUnit>
  readonly sharedStepPaths: ReadonlyArray<OwnedRelPath>
}): boolean => {
  if (!isValidCompiledSchedule(plan.units)) {
    return false
  }
  for (const sharedPath of plan.sharedStepPaths) {
    for (const unit of plan.units) {
      for (const unitPath of unit.ownedRelPaths) {
        if (pathsOverlap(sharedPath, unitPath)) {
          return false
        }
      }
    }
  }
  return true
}

export const CompiledPlan = Schema.Struct({
  runId: WorkflowRunId,
  level: WorkflowLevel,
  planSha: PlanSha256,
  baseSha: GitCommitSha,
  mode: UnitMode,
  units: Schema.Array(CompiledWorkUnit),
  sharedStepPaths: Schema.Array(OwnedRelPath),
}).pipe(
  Schema.check(
    Schema.makeFilter((plan) => isValidCompiledPlan(plan), {
      message:
        "CompiledPlan must have unique unitIds, strictly earlier waveIndex for dependencies, dense 0..N-1 waves, disjoint ownedRelPaths per wave, and sharedStepPaths disjoint from all unit ownedRelPaths",
    }),
  ),
)
export type CompiledPlan = typeof CompiledPlan.Type

export const wavesOf = (source: CompiledPlan | CompiledWaves): ReadonlyArray<CompiledWave> =>
  groupWaves(source.units)

export const PackageVerifyFailureKind = Schema.Literals(["non-zero-exit", "timed-out", "signaled"])
export type PackageVerifyFailureKind = typeof PackageVerifyFailureKind.Type

export const PackageVerifyFailureDetail = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(2048)),
  Schema.brand("PackageVerifyFailureDetail"),
)
export type PackageVerifyFailureDetail = typeof PackageVerifyFailureDetail.Type

export const UnitRejection = Schema.TaggedUnion({
  WriteSetViolation: { offendingPaths: Schema.NonEmptyArray(OwnedRelPath) },
  PackageVerifyFailed: {
    exitCode: GateExitCode,
    failureKind: PackageVerifyFailureKind,
    detail: Schema.optional(PackageVerifyFailureDetail),
  },
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
  planSha: PlanSha256,
  review: ReviewRoutingPlan,
  completedUnits: Schema.Array(WorkUnitId),
  llmPhase: LlmPhaseReceipt,
})
export type TaskRunReceipt = typeof TaskRunReceipt.Type

export const ShipReceipt = Schema.Struct({
  runId: WorkflowRunId,
  planSha: Schema.optional(PlanSha256),
  attempt: ShipAttempt,
  verifiedTreeHash: WorkspaceTreeHash,
})
export type ShipReceipt = typeof ShipReceipt.Type

/** Dispatch request sent by `HarnessTaskWorkflow` (`Automatic` mode) into `UnitAgentDispatcher`. */
export const UnitAgentRequest = Schema.Struct({
  runId: WorkflowRunId,
  unit: CompiledWorkUnit,
  attempt: AttemptNumber,
  runner: RunnerId,
  cwd: AbsoluteRepoRoot,
})
export type UnitAgentRequest = typeof UnitAgentRequest.Type

/** Outcome returned by `UnitAgentDispatcher.dispatchUnit` before `UnitVerifier.completeUnit` executes. */
export const UnitAgentDispatchResult = Schema.TaggedUnion({
  Completed: {},
  Failed: { reason: AgentFailureReason },
  AuthRequired: { runner: RunnerId },
})
export type UnitAgentDispatchResult = typeof UnitAgentDispatchResult.Type

/** Verification request passed to `UnitVerifier.completeUnit` (shared across automatic and manual modes). */
export const CompleteUnitInput = Schema.Struct({
  runId: WorkflowRunId,
  level: WorkflowLevel,
  baseSha: GitCommitSha,
  unit: CompiledWorkUnit,
  attempt: AttemptNumber,
  cwd: AbsoluteRepoRoot,
  siblingInFlightOwnedPaths: Schema.Array(OwnedRelPath),
})
export type CompleteUnitInput = typeof CompleteUnitInput.Type

/** Verification request passed to `UnitVerifier.completeSharedStep` for `plan.sharedStepPaths`. */
export const CompleteSharedStepInput = Schema.Struct({
  runId: WorkflowRunId,
  baseSha: GitCommitSha,
  sharedStepPaths: Schema.NonEmptyArray(OwnedRelPath),
  priorUnitOwnedPaths: Schema.Array(OwnedRelPath),
  attempt: AttemptNumber,
  cwd: AbsoluteRepoRoot,
})
export type CompleteSharedStepInput = typeof CompleteSharedStepInput.Type

/** Input to `WorkflowWorktreePort.mergeSliceWave` for L1 epic waves (`git merge --no-ff`). */
export const MergeSliceWaveInput = Schema.Struct({
  runId: WorkflowRunId,
  waveIndex: WaveIndex,
  baseSha: GitCommitSha,
  canonicalRepoRoot: AbsoluteRepoRoot,
  branches: Schema.Array(SliceBranchName),
})
export type MergeSliceWaveInput = typeof MergeSliceWaveInput.Type

/** Result of merging an L1 epic wave's `slice/*` branches into the checkout's current `HEAD`. */
export const MergeSliceWaveOutcome = Schema.TaggedUnion({
  Merged: { mergedBranches: Schema.Array(SliceBranchName) },
  Conflict: { branch: SliceBranchName },
})
export type MergeSliceWaveOutcome = typeof MergeSliceWaveOutcome.Type

/** Input to `WorkflowReviewRouter.routeReview` inside the memoised `RouteReview` activity. */
export const WorkflowRouteReviewInput = Schema.Struct({
  runId: WorkflowRunId,
  baseSha: GitCommitSha,
  canonicalRepoRoot: AbsoluteRepoRoot,
})
export type WorkflowRouteReviewInput = typeof WorkflowRouteReviewInput.Type

export const PlanGraphIssue = Schema.TaggedUnion({
  DuplicateWorkUnitId: { unitId: WorkUnitId },
  DanglingUnitDependency: {
    from: WorkUnitId,
    to: WorkUnitId,
    missingUnitIds: Schema.NonEmptyArray(WorkUnitId),
  },
})
export type PlanGraphIssue = typeof PlanGraphIssue.Type

export class CyclicPlanWorkflowError extends Schema.TaggedError<CyclicPlanWorkflowError>()(
  "CyclicPlanWorkflowError",
  {
    cycleUnits: Schema.NonEmptyArray(WorkUnitId),
    reason: WorkflowCompileReason,
  },
) {}

export class DisjointOwnershipViolationError extends Schema.TaggedError<DisjointOwnershipViolationError>()(
  "DisjointOwnershipViolationError",
  {
    waveIndex: WaveIndex,
    overlappingPaths: Schema.NonEmptyArray(OwnedRelPath),
  },
) {}

export class InvalidPlanWorkflowGraphError extends Schema.TaggedError<InvalidPlanWorkflowGraphError>()(
  "InvalidPlanWorkflowGraphError",
  {
    issue: PlanGraphIssue,
  },
) {
  override get message(): string {
    return Match.value(this.issue).pipe(
      Match.tag("DuplicateWorkUnitId", (i) => `Duplicate work unit id: ${i.unitId}`),
      Match.tag(
        "DanglingUnitDependency",
        (i) =>
          `Dangling unit dependency ${i.from} -> ${i.to} (missing: ${i.missingUnitIds.join(", ")})`,
      ),
      Match.exhaustive,
    )
  }
}

/** Terminal failure of `HarnessTaskWorkflow` after an escalation resolves to `"abort"` (worktree setup failures raise `WorkspaceFsError`). */
export class TaskRunAbortedError extends Schema.TaggedError<TaskRunAbortedError>()(
  "TaskRunAbortedError",
  {
    runId: WorkflowRunId,
    escalation: UnitEscalation,
  },
) {
  override get message(): string {
    return Match.value(this.escalation).pipe(
      Match.tag(
        "AuthRequired",
        (e) =>
          `Workflow run '${this.runId}' aborted: authentication required for runner '${e.runner}'`,
      ),
      Match.tag(
        "RetryBudgetExhausted",
        (e) =>
          `Workflow run '${this.runId}' aborted after retry budget exhausted (${e.lastRejection._tag})`,
      ),
      Match.tag(
        "MergeConflict",
        (e) => `Workflow run '${this.runId}' aborted due to merge conflict on '${e.branch}'`,
      ),
      Match.exhaustive,
    )
  }
}
