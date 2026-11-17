import { Schema } from "effect"
import {
  NonNegativeCount,
  WorkspaceFilePath,
  makeVerdictReportSchema,
} from "./ast-and-gate-primitives.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

const TrimmedNonEmptyString = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(4096)),
)

export const OmnigraphCommitId = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphCommitId"))
export type OmnigraphCommitId = typeof OmnigraphCommitId.Type

export const OmnigraphBranchName = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphBranchName"))
export type OmnigraphBranchName = typeof OmnigraphBranchName.Type

export const OmnigraphChangeCursor = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphChangeCursor"))
export type OmnigraphChangeCursor = typeof OmnigraphChangeCursor.Type

export const OmnigraphDiagnosticCode = TrimmedNonEmptyString.pipe(
  Schema.brand("OmnigraphDiagnosticCode"),
)
export type OmnigraphDiagnosticCode = typeof OmnigraphDiagnosticCode.Type

export const OmnigraphTypeName = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphTypeName"))
export type OmnigraphTypeName = typeof OmnigraphTypeName.Type

export const OmnigraphEntityId = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphEntityId"))
export type OmnigraphEntityId = typeof OmnigraphEntityId.Type

export const OmnigraphTargetName = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphTargetName"))
export type OmnigraphTargetName = typeof OmnigraphTargetName.Type

export const OmnigraphSpanName = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphSpanName"))
export type OmnigraphSpanName = typeof OmnigraphSpanName.Type

export const OmnigraphActorToken = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphActorToken"))
export type OmnigraphActorToken = typeof OmnigraphActorToken.Type

export const OmnigraphBaseUrl = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphBaseUrl"))
export type OmnigraphBaseUrl = typeof OmnigraphBaseUrl.Type

export const OmnigraphIsoTimestamp = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphIsoTimestamp"))
export type OmnigraphIsoTimestamp = typeof OmnigraphIsoTimestamp.Type

export const OmnigraphLintStatus = Schema.Literals(["ok", "error"])
export type OmnigraphLintStatus = typeof OmnigraphLintStatus.Type

export const OmnigraphProcessId = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(1)),
  Schema.brand("OmnigraphProcessId"),
)
export type OmnigraphProcessId = typeof OmnigraphProcessId.Type

export const OmnigraphTcpPort = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  Schema.brand("OmnigraphTcpPort"),
)
export type OmnigraphTcpPort = typeof OmnigraphTcpPort.Type

export const OmnigraphConflictKind = Schema.Literals([
  "divergent_insert",
  "divergent_update",
  "delete_vs_update",
  "orphan_edge",
  "unique_violation",
  "cardinality_violation",
  "value_constraint_violation",
])
export type OmnigraphConflictKind = typeof OmnigraphConflictKind.Type

export const OmnigraphEntityKind = Schema.Literals(["node", "edge"])
export type OmnigraphEntityKind = typeof OmnigraphEntityKind.Type

export const OmnigraphChangeOp = Schema.Literals(["insert", "update", "delete"])
export type OmnigraphChangeOp = typeof OmnigraphChangeOp.Type

export const OmnigraphConfigDriftKind = Schema.Literals([
  "none",
  "queries-only",
  "schema-additive-or-rename",
  "edge-key-or-policy-bundle-breaking",
])
export type OmnigraphConfigDriftKind = typeof OmnigraphConfigDriftKind.Type

export const OmnigraphMergeConflictDetail = Schema.Struct({
  kind: OmnigraphConflictKind,
  entityKind: OmnigraphEntityKind,
  typeName: OmnigraphTypeName,
  entityId: Schema.NullOr(OmnigraphEntityId),
  message: ErrorReasonMessage,
})
export type OmnigraphMergeConflictDetail = typeof OmnigraphMergeConflictDetail.Type

export const EffectFnInserted = Schema.TaggedStruct("EffectFnInserted", {
  entityId: OmnigraphEntityId,
  stubAfter: Schema.Boolean,
  spanName: Schema.NullOr(OmnigraphSpanName),
})
export type EffectFnInserted = typeof EffectFnInserted.Type

export const EffectFnUpdated = Schema.TaggedStruct("EffectFnUpdated", {
  entityId: OmnigraphEntityId,
  wasStubBefore: Schema.Boolean,
  stubAfter: Schema.Boolean,
  spanName: Schema.NullOr(OmnigraphSpanName),
})
export type EffectFnUpdated = typeof EffectFnUpdated.Type

export const EffectFnDeleted = Schema.TaggedStruct("EffectFnDeleted", {
  entityId: OmnigraphEntityId,
  wasStubBefore: Schema.Boolean,
  spanName: Schema.NullOr(OmnigraphSpanName),
})
export type EffectFnDeleted = typeof EffectFnDeleted.Type

export const EntityDiffChange = Schema.TaggedStruct("EntityDiffChange", {
  entityKind: OmnigraphEntityKind,
  typeName: OmnigraphTypeName,
  entityId: OmnigraphEntityId,
  op: OmnigraphChangeOp,
})
export type EntityDiffChange = typeof EntityDiffChange.Type

export const OmnigraphDiffChangeSummary = Schema.Union([
  EffectFnInserted,
  EffectFnUpdated,
  EffectFnDeleted,
  EntityDiffChange,
])
export type OmnigraphDiffChangeSummary = typeof OmnigraphDiffChangeSummary.Type

export const MissingMergeBaseViolation = Schema.TaggedStruct("missing-merge-base", {
  message: ErrorReasonMessage,
})
export type MissingMergeBaseViolation = typeof MissingMergeBaseViolation.Type

export const DryRunMergeConflictViolation = Schema.TaggedStruct("dry-run-merge-conflict", {
  message: ErrorReasonMessage,
  conflict: OmnigraphMergeConflictDetail,
})
export type DryRunMergeConflictViolation = typeof DryRunMergeConflictViolation.Type

export const PlannedEffectFnDroppedViolation = Schema.TaggedStruct("planned-effect-fn-dropped", {
  message: ErrorReasonMessage,
  change: EffectFnDeleted,
})
export type PlannedEffectFnDroppedViolation = typeof PlannedEffectFnDroppedViolation.Type

export const NoEffectFnImplementedViolation = Schema.TaggedStruct("no-effect-fn-implemented", {
  message: ErrorReasonMessage,
  activeDiffEffectFnCount: NonNegativeCount,
})
export type NoEffectFnImplementedViolation = typeof NoEffectFnImplementedViolation.Type

export const UnimplementedStubRemainingViolation = Schema.TaggedStruct(
  "unimplemented-stub-remaining",
  {
    message: ErrorReasonMessage,
    change: Schema.NullOr(Schema.Union([EffectFnInserted, EffectFnUpdated])),
  },
)
export type UnimplementedStubRemainingViolation = typeof UnimplementedStubRemainingViolation.Type

export const OmnigraphBranchViolation = Schema.Union([
  MissingMergeBaseViolation,
  DryRunMergeConflictViolation,
  PlannedEffectFnDroppedViolation,
  NoEffectFnImplementedViolation,
  UnimplementedStubRemainingViolation,
])
export type OmnigraphBranchViolation = typeof OmnigraphBranchViolation.Type

export const OmnigraphBranchDiffState = Schema.Union([
  Schema.TaggedStruct("ResolvedDiff", {
    changes: Schema.Array(OmnigraphDiffChangeSummary),
    observedImplEffectFnCount: Schema.NullOr(NonNegativeCount),
    unchangedStubCount: NonNegativeCount,
  }),
  Schema.TaggedStruct("MissingMergeBase", {}),
])
export type OmnigraphBranchDiffState = typeof OmnigraphBranchDiffState.Type

export const OmnigraphBranchVerifyInput = Schema.Struct({
  planBranch: OmnigraphBranchName,
  implBranch: OmnigraphBranchName,
  mainBranch: OmnigraphBranchName,
  diffState: OmnigraphBranchDiffState,
  dryRunConflicts: Schema.Array(OmnigraphMergeConflictDetail),
})
export type OmnigraphBranchVerifyInput = typeof OmnigraphBranchVerifyInput.Type

export const OmnigraphBranchVerifyReport = makeVerdictReportSchema(OmnigraphBranchViolation, {
  verifiedChangeCount: NonNegativeCount,
  conflictCount: NonNegativeCount,
  implEffectFnCount: NonNegativeCount,
})
export type OmnigraphBranchVerifyReport = typeof OmnigraphBranchVerifyReport.Type

export const OmnigraphSchemaEvolutionInput = Schema.Union([
  Schema.TaggedStruct("ClusterMissing", {}),
  Schema.TaggedStruct("ClusterPresent", {
    driftKind: OmnigraphConfigDriftKind,
    serverAlive: Schema.Boolean,
  }),
])
export type OmnigraphSchemaEvolutionInput = typeof OmnigraphSchemaEvolutionInput.Type

export const OmnigraphSchemaEvolutionAction = Schema.Union([
  Schema.TaggedStruct("NoOp", {}),
  Schema.TaggedStruct("LiveClusterApply", {
    requiresUnlock: Schema.Boolean,
  }),
  Schema.TaggedStruct("RequiresCleanRebuild", {
    reason: ErrorReasonMessage,
  }),
])
export type OmnigraphSchemaEvolutionAction = typeof OmnigraphSchemaEvolutionAction.Type

export const OmnigraphDiagnosticSeverity = Schema.Literals(["error", "warning", "info"])
export type OmnigraphDiagnosticSeverity = typeof OmnigraphDiagnosticSeverity.Type

export const OmnigraphLintPolicy = Schema.Literals(["fail-on-error", "deny-warnings", "report-only"])
export type OmnigraphLintPolicy = typeof OmnigraphLintPolicy.Type

export const OmnigraphLintDiagnostic = Schema.Struct({
  code: OmnigraphDiagnosticCode,
  message: ErrorReasonMessage,
  targetName: Schema.NullOr(OmnigraphTargetName),
  severity: OmnigraphDiagnosticSeverity,
})
export type OmnigraphLintDiagnostic = typeof OmnigraphLintDiagnostic.Type

export const OmnigraphLintInput = Schema.Struct({
  statusOk: Schema.Boolean,
  queriesProcessed: NonNegativeCount,
  diagnostics: Schema.Array(OmnigraphLintDiagnostic),
  policy: OmnigraphLintPolicy,
})
export type OmnigraphLintInput = typeof OmnigraphLintInput.Type

export const OmnigraphLintViolation = Schema.Union([
  Schema.TaggedStruct("omnigraph-lint-status-not-ok", {
    message: ErrorReasonMessage,
  }),
  Schema.TaggedStruct("omnigraph-lint-error", {
    message: ErrorReasonMessage,
    diagnostic: Schema.NullOr(OmnigraphLintDiagnostic),
  }),
])
export type OmnigraphLintViolation = typeof OmnigraphLintViolation.Type

export const OmnigraphLintReport = makeVerdictReportSchema(OmnigraphLintViolation, {
  queriesProcessed: NonNegativeCount,
  errorCount: NonNegativeCount,
  warningCount: NonNegativeCount,
})
export type OmnigraphLintReport = typeof OmnigraphLintReport.Type

export const OmnigraphAuthTokensSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  cliToken: OmnigraphActorToken,
  mcpToken: OmnigraphActorToken,
})
export type OmnigraphAuthTokens = typeof OmnigraphAuthTokensSchema.Type

export const OmnigraphServerMetaSchema = Schema.Struct({
  pid: OmnigraphProcessId,
  port: OmnigraphTcpPort,
  baseUrl: OmnigraphBaseUrl,
  canonicalRepoRoot: WorkspaceFilePath,
  updatedAt: Schema.NullOr(OmnigraphIsoTimestamp),
})
export type OmnigraphServerMeta = typeof OmnigraphServerMetaSchema.Type

export class OmnigraphPreconditionError extends Schema.TaggedError<OmnigraphPreconditionError>()(
  "OmnigraphPreconditionError",
  {
    branch: OmnigraphBranchName,
    expectedCommit: OmnigraphCommitId,
    actualCommit: Schema.NullOr(OmnigraphCommitId),
  },
) {}

export class OmnigraphMergeConflictError extends Schema.TaggedError<OmnigraphMergeConflictError>()(
  "OmnigraphMergeConflictError",
  {
    sourceBranch: OmnigraphBranchName,
    targetBranch: OmnigraphBranchName,
    conflicts: Schema.Array(OmnigraphMergeConflictDetail),
  },
) {}

export class OmnigraphLintError extends Schema.TaggedError<OmnigraphLintError>()(
  "OmnigraphLintError",
  {
    errorCount: NonNegativeCount,
    diagnosticsSummary: ErrorReasonMessage,
  },
) {}
