import { Match, Result, Schema } from "effect"
import { compareCodeUnits } from "./ast-and-gate-primitives.js"
import { DaemonSocketPath } from "./cache-and-daemon.js"
import { AbsoluteRepoRoot, GitCommitSha } from "./repo-identity.js"
import { ReviewRoutingPlan } from "./review-routing.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

const SAFE_REL_SEGMENT =
  "(?!\\.\\.?(?:\\/|$))[^\\x00-\\x1f\\x7f\\\\/\\s:.](?:[^\\x00-\\x1f\\x7f\\\\/:]*[^\\x00-\\x1f\\x7f\\\\/\\s:.])?"
const SAFE_OWNED_REL_PATH_RE = new RegExp(`^${SAFE_REL_SEGMENT}(?:\\/${SAFE_REL_SEGMENT})*$`)
const PROTECTED_OWNED_PATH_RE =
  /^(?:\.git|\.harness|repos\/(?:effect|alchemy)|tools\/oxlint)(?:\/|$)/i
const NX_PROJECT_NAME_RE = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/
const SAFE_PACKAGE_VERIFY_COMMAND_RE =
  /^(?:(?:pnpm )?nx run (?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*:(?:verify|test|typecheck|lint)|(?:pnpm )?nx affected (?:-t|--target) (?:verify|test|typecheck|lint)|pnpm --filter (?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]* (?:verify|test|typecheck|lint))$/

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

export const NxProjectName = Schema.String.pipe(
  Schema.check(Schema.isPattern(NX_PROJECT_NAME_RE)),
  Schema.brand("NxProjectName"),
)
export type NxProjectName = typeof NxProjectName.Type

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

/**
 * Safe package verification command (`1..512` chars): restricted to `nx run <project>:<target>`,
 * `nx affected -t|--target <target>`, or `pnpm --filter <project> <target>` for
 * `verify | test | typecheck | lint` without shell metacharacters or control characters.
 */
export const PackageVerifyCommand = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(512)),
  Schema.check(Schema.isPattern(SAFE_PACKAGE_VERIFY_COMMAND_RE)),
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

const verifyCommandTargetsProject = (
  projectName: NxProjectName,
  command: PackageVerifyCommand,
): boolean =>
  command.startsWith(`pnpm nx run ${projectName}:`) ||
  command.startsWith(`nx run ${projectName}:`) ||
  command.startsWith(`pnpm --filter ${projectName} `) ||
  command.startsWith("pnpm nx affected ") ||
  command.startsWith("nx affected ")

export const SliceUnitDraft = Schema.TaggedStruct("SliceUnit", {
  unitId: WorkUnitId,
  branch: SliceBranchName,
  ownedRelPaths: Schema.Array(OwnedRelPath),
  earsKeys: Schema.Array(EarsRequirementKey),
})
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
    Schema.makeFilter(
      (unit) => verifyCommandTargetsProject(unit.projectName, unit.packageVerifyCommand),
      {
        message: "PackageUnitDraft packageVerifyCommand must target its projectName or nx affected",
      },
    ),
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
})

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
    Schema.makeFilter(
      (unit) => verifyCommandTargetsProject(unit.projectName, unit.packageVerifyCommand),
      {
        message: "PackageUnit packageVerifyCommand must target its projectName or nx affected",
      },
    ),
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

export const UnitRejection = Schema.TaggedUnion({
  WriteSetViolation: { offendingPaths: Schema.NonEmptyArray(OwnedRelPath) },
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

// ---- WF-2: Omnigraph MessageStorage, writer lease, daemon handshake, backup/restore ----

const SEQ_KEY_WIDTH = 20
const MAX_SEQ_KEY_BIGINT = 10n ** 20n - 1n

const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const SingleLineTrimmedPath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.check(Schema.isPattern(/^[^\0\r\n]+$/s)),
)

/**
 * 20-character zero-padded decimal string (`00000000000000000000`..`99999999999999999999`)
 * for lossless lexicographic `ORDER BY` of 64-bit Snowflake IDs (`> Number.MAX_SAFE_INTEGER`)
 * in Omnigraph.
 */
export const SeqKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{20}$/)),
  Schema.brand("SeqKey"),
)
export type SeqKey = typeof SeqKey.Type

const hasNoControlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

const parseSeqBigInt = (
  value: bigint | number | string,
): Result.Result<bigint, ErrorReasonMessage> => {
  if (typeof value === "bigint") {
    return Result.succeed(value)
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? Result.succeed(BigInt(value))
      : Result.fail(
          ErrorReasonMessage.make(
            `Cannot encode SeqKey from non-safe-integer number: ${String(value)}`,
          ),
        )
  }
  return /^\d+$/.test(value)
    ? Result.succeed(BigInt(value))
    : Result.fail(
        ErrorReasonMessage.make(
          `Cannot encode SeqKey from non-decimal string: ${JSON.stringify(value)}`,
        ),
      )
}

/**
 * Encodes a non-negative `bigint`, safe non-negative integer `number`, or decimal digit string
 * (<= 20 digits) into a zero-padded 20-character `SeqKey`.
 */
export const encodeSeqKey = (
  value: bigint | number | string,
): Result.Result<SeqKey, ErrorReasonMessage> =>
  Result.flatMap(parseSeqBigInt(value), (digits) =>
    digits < 0n || digits > MAX_SEQ_KEY_BIGINT
      ? Result.fail(
          ErrorReasonMessage.make(
            `SeqKey sequence out of 20-digit unsigned bounds: ${digits.toString()}`,
          ),
        )
      : Result.succeed(SeqKey.make(digits.toString().padStart(SEQ_KEY_WIDTH, "0"))),
  )

/** Losslessly decodes a 20-character `SeqKey` back into a non-negative `bigint`. */
export const decodeSeqKey = (seqKey: SeqKey): bigint => BigInt(seqKey)

/** Monotonically increasing fencing epoch (`>= 0`) for the workflow single-writer lease. */
export const LeaseEpoch = NonNegativeInt.pipe(Schema.brand("LeaseEpoch"))
export type LeaseEpoch = typeof LeaseEpoch.Type

/** Trimmed non-empty identifier of the daemon instance holding the writer lease. */
export const LeaseHolderId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.check(Schema.isPattern(/^[^\0\r\n]+$/s)),
  Schema.brand("LeaseHolderId"),
)
export type LeaseHolderId = typeof LeaseHolderId.Type

/** POSIX file path to the workflow writer advisory lock file (`<git-common-dir>/harness/daemon.lock`). */
export const LeaseFilePath = SingleLineTrimmedPath.pipe(Schema.brand("LeaseFilePath"))
export type LeaseFilePath = typeof LeaseFilePath.Type

/** OS process ID (`>= 1`) of a workflow writer lease holder. */
export const LeaseHolderPid = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("LeaseHolderPid"),
)
export type LeaseHolderPid = typeof LeaseHolderPid.Type

/** Positive integer string identifying the workflow daemon IPC protocol version. */
export const WorkflowProtocolVersion = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[1-9]\d*$/)),
  Schema.brand("WorkflowProtocolVersion"),
)
export type WorkflowProtocolVersion = typeof WorkflowProtocolVersion.Type

export const WORKFLOW_DAEMON_PROTOCOL_VERSION: WorkflowProtocolVersion =
  WorkflowProtocolVersion.make("1")

/** Capability identifier advertised by the workflow daemon during `workflow.handshake`. */
export const WorkflowDaemonCapability = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9._:-]*$/)),
  Schema.brand("WorkflowDaemonCapability"),
)
export type WorkflowDaemonCapability = typeof WorkflowDaemonCapability.Type

export const DaemonProtocolMismatchDetail = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.brand("DaemonProtocolMismatchDetail"),
)
export type DaemonProtocolMismatchDetail = typeof DaemonProtocolMismatchDetail.Type

/** Canonical POSIX absolute path to the shared git common directory (`<repo>/.git`). */
export const GitCommonDirPath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.check(Schema.isPattern(/^(?:\/(?!\.\.?(?:\/|$))[^\\/]+)+$/)),
  Schema.check(
    Schema.makeFilter(hasNoControlChars, {
      message: "GitCommonDirPath must not contain ASCII control characters",
    }),
  ),
  Schema.brand("GitCommonDirPath"),
)
export type GitCommonDirPath = typeof GitCommonDirPath.Type

export const WorktreePathKind = Schema.Literals(["canonical", "linked"])
export type WorktreePathKind = typeof WorktreePathKind.Type

export const ValidatedWorktreeRoot = Schema.Struct({
  worktreeRoot: AbsoluteRepoRoot,
  commonGitDir: GitCommonDirPath,
  kind: WorktreePathKind,
})
export type ValidatedWorktreeRoot = typeof ValidatedWorktreeRoot.Type

export const DaemonHandshakeRequest = Schema.Struct({
  protocolVersion: WorkflowProtocolVersion,
  repoRoot: AbsoluteRepoRoot,
  commonGitDir: Schema.optional(GitCommonDirPath),
})
export type DaemonHandshakeRequest = typeof DaemonHandshakeRequest.Type

export const DaemonHandshakeResponse = Schema.Struct({
  protocolVersion: WorkflowProtocolVersion,
  capabilities: Schema.Array(WorkflowDaemonCapability),
  repoRoot: AbsoluteRepoRoot,
  commonGitDir: GitCommonDirPath,
  writerLeaseEpoch: LeaseEpoch,
})
export type DaemonHandshakeResponse = typeof DaemonHandshakeResponse.Type

/** Directory path where `harness-workflows` NDJSON backups are stored (`<git-common-dir>/harness/workflow-backups`). */
export const BackupDirPath = SingleLineTrimmedPath.pipe(Schema.brand("BackupDirPath"))
export type BackupDirPath = typeof BackupDirPath.Type

/** File path to a specific `harness-workflows` NDJSON backup file. */
export const WorkflowBackupFilePath = SingleLineTrimmedPath.pipe(
  Schema.brand("WorkflowBackupFilePath"),
)
export type WorkflowBackupFilePath = typeof WorkflowBackupFilePath.Type

/** Non-negative count of entities exported or restored in a `harness-workflows` backup. */
export const WorkflowBackupCount = NonNegativeInt.pipe(Schema.brand("WorkflowBackupCount"))
export type WorkflowBackupCount = typeof WorkflowBackupCount.Type

/** Non-negative epoch millisecond timestamp recorded for a `harness-workflows` backup or restore. */
export const WorkflowBackupTimestampMs = NonNegativeInt.pipe(
  Schema.brand("WorkflowBackupTimestampMs"),
)
export type WorkflowBackupTimestampMs = typeof WorkflowBackupTimestampMs.Type

/** Lowercase 64-hex SHA-256 digest of a serialized `harness-workflows` backup file. */
export const BackupFileHash = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("BackupFileHash"),
)
export type BackupFileHash = typeof BackupFileHash.Type

export const WorkflowBackupMode = Schema.Literals(["merge", "replace"])
export type WorkflowBackupMode = typeof WorkflowBackupMode.Type

export const WorkflowBackupSummary = Schema.Struct({
  backupFile: WorkflowBackupFilePath,
  entityCount: WorkflowBackupCount,
  timestampMs: WorkflowBackupTimestampMs,
  sha256: BackupFileHash,
})
export type WorkflowBackupSummary = typeof WorkflowBackupSummary.Type

export const WorkflowRestoreRequest = Schema.Struct({
  backupFile: WorkflowBackupFilePath,
  mode: WorkflowBackupMode,
  expectedSha256: Schema.optional(BackupFileHash),
})
export type WorkflowRestoreRequest = typeof WorkflowRestoreRequest.Type

export const WorkflowRestoreSummary = Schema.Struct({
  backupFile: WorkflowBackupFilePath,
  mode: WorkflowBackupMode,
  restoredEntityCount: WorkflowBackupCount,
  timestampMs: WorkflowBackupTimestampMs,
  sha256: BackupFileHash,
})
export type WorkflowRestoreSummary = typeof WorkflowRestoreSummary.Type

export const WorkflowStoreOperation = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.brand("WorkflowStoreOperation"),
)
export type WorkflowStoreOperation = typeof WorkflowStoreOperation.Type

export const WorkflowStoreFailureReason = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.brand("WorkflowStoreFailureReason"),
)
export type WorkflowStoreFailureReason = typeof WorkflowStoreFailureReason.Type

export class WriterLeaseHeldError extends Schema.TaggedError<WriterLeaseHeldError>()(
  "WriterLeaseHeldError",
  {
    holderId: LeaseHolderId,
    leaseEpoch: LeaseEpoch,
    lockFilePath: LeaseFilePath,
    holderPid: Schema.optional(LeaseHolderPid),
  },
) {
  override get message(): string {
    const pidPart = this.holderPid !== undefined ? `, pid ${this.holderPid}` : ""
    return `Workflow writer lease held by ${this.holderId} (epoch ${this.leaseEpoch}${pidPart}) at ${this.lockFilePath}`
  }
}

export class DaemonProtocolMismatchError extends Schema.TaggedError<DaemonProtocolMismatchError>()(
  "DaemonProtocolMismatchError",
  {
    expectedVersion: WorkflowProtocolVersion,
    actualVersion: Schema.optional(WorkflowProtocolVersion),
    socketPath: DaemonSocketPath,
    detail: DaemonProtocolMismatchDetail,
  },
) {
  override get message(): string {
    const actualPart =
      this.actualVersion !== undefined ? `v${this.actualVersion}` : "unsupported/missing"
    return `Daemon protocol mismatch at ${this.socketPath}: expected v${this.expectedVersion}, got ${actualPart} (${this.detail})`
  }
}

export class WorkflowStoreUnavailableError extends Schema.TaggedError<WorkflowStoreUnavailableError>()(
  "WorkflowStoreUnavailableError",
  {
    operation: WorkflowStoreOperation,
    reason: WorkflowStoreFailureReason,
  },
) {
  override get message(): string {
    return `Workflow store unavailable during ${this.operation}: ${this.reason}`
  }
}
