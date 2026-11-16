import { Schema } from "effect"
import {
  NonNegativeCount,
  WorkspaceFilePath,
  makeVerdictReportSchema,
} from "./ast-and-gate-primitives.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

const TrimmedNonEmptyString = Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()))

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

export const OmnigraphLintStatus = TrimmedNonEmptyString.pipe(Schema.brand("OmnigraphLintStatus"))
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

export const EffectFnDiffChange = Schema.TaggedStruct("EffectFnDiffChange", {
  entityId: OmnigraphEntityId,
  op: OmnigraphChangeOp,
  wasStubBefore: Schema.Boolean,
  stubAfter: Schema.Boolean,
  spanName: Schema.NullOr(OmnigraphSpanName),
})
export type EffectFnDiffChange = typeof EffectFnDiffChange.Type

export const EntityDiffChange = Schema.TaggedStruct("EntityDiffChange", {
  entityKind: OmnigraphEntityKind,
  typeName: OmnigraphTypeName,
  entityId: OmnigraphEntityId,
  op: OmnigraphChangeOp,
  wasStubBefore: Schema.Boolean,
  stubAfter: Schema.Boolean,
})
export type EntityDiffChange = typeof EntityDiffChange.Type

export const OmnigraphDiffChangeSummary = Schema.Union([EffectFnDiffChange, EntityDiffChange])
export type OmnigraphDiffChangeSummary = typeof OmnigraphDiffChangeSummary.Type

export const MissingMergeBaseViolation = Schema.TaggedStruct("MissingMergeBaseViolation", {
  ruleId: Schema.Literal("missing-merge-base"),
  message: ErrorReasonMessage,
})
export type MissingMergeBaseViolation = typeof MissingMergeBaseViolation.Type

export const DryRunMergeConflictViolation = Schema.TaggedStruct("DryRunMergeConflictViolation", {
  ruleId: Schema.Literal("dry-run-merge-conflict"),
  message: ErrorReasonMessage,
  conflict: OmnigraphMergeConflictDetail,
})
export type DryRunMergeConflictViolation = typeof DryRunMergeConflictViolation.Type

export const PlannedEffectFnDroppedViolation = Schema.TaggedStruct(
  "PlannedEffectFnDroppedViolation",
  {
    ruleId: Schema.Literal("planned-effect-fn-dropped"),
    message: ErrorReasonMessage,
    change: OmnigraphDiffChangeSummary,
  },
)
export type PlannedEffectFnDroppedViolation = typeof PlannedEffectFnDroppedViolation.Type

export const UnimplementedStubRemainingViolation = Schema.TaggedStruct(
  "UnimplementedStubRemainingViolation",
  {
    ruleId: Schema.Literal("unimplemented-stub-remaining"),
    message: ErrorReasonMessage,
    change: Schema.NullOr(OmnigraphDiffChangeSummary),
  },
)
export type UnimplementedStubRemainingViolation = typeof UnimplementedStubRemainingViolation.Type

export const OmnigraphBranchViolation = Schema.Union([
  MissingMergeBaseViolation,
  DryRunMergeConflictViolation,
  PlannedEffectFnDroppedViolation,
  UnimplementedStubRemainingViolation,
])
export type OmnigraphBranchViolation = typeof OmnigraphBranchViolation.Type

export const OmnigraphBranchDiffState = Schema.Union([
  Schema.TaggedStruct("ResolvedDiff", {
    changes: Schema.Array(OmnigraphDiffChangeSummary),
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
  implEffectFnCount: NonNegativeCount,
  remainingStubCount: NonNegativeCount,
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
  errorCount: NonNegativeCount,
  warningCount: NonNegativeCount,
  queriesProcessed: NonNegativeCount,
  diagnostics: Schema.Array(OmnigraphLintDiagnostic),
  policy: OmnigraphLintPolicy,
})
export type OmnigraphLintInput = typeof OmnigraphLintInput.Type

export const OmnigraphLintViolation = Schema.Union([
  Schema.TaggedStruct("LintStatusNotOkViolation", {
    ruleId: Schema.Literal("omnigraph-lint-status-not-ok"),
    message: ErrorReasonMessage,
  }),
  Schema.TaggedStruct("LintDiagnosticViolation", {
    ruleId: Schema.Literal("omnigraph-lint-error"),
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
  pid: Schema.optional(OmnigraphProcessId),
  port: Schema.optional(OmnigraphTcpPort),
  baseUrl: Schema.optional(OmnigraphBaseUrl),
  canonicalRepoRoot: Schema.optional(WorkspaceFilePath),
  updatedAt: Schema.optional(OmnigraphIsoTimestamp),
})
export type OmnigraphServerMeta = typeof OmnigraphServerMetaSchema.Type

export const OmnigraphLintFindingWireSchema = Schema.Struct({
  code: Schema.optional(OmnigraphDiagnosticCode),
  message: Schema.optional(ErrorReasonMessage),
  severity: Schema.optional(OmnigraphDiagnosticSeverity),
  target: Schema.optional(Schema.NullOr(OmnigraphTargetName)),
  target_name: Schema.optional(Schema.NullOr(OmnigraphTargetName)),
  targetName: Schema.optional(Schema.NullOr(OmnigraphTargetName)),
})
export type OmnigraphLintFindingWire = typeof OmnigraphLintFindingWireSchema.Type

export const OmnigraphLintCliOutputSchema = Schema.Struct({
  status: Schema.optional(OmnigraphLintStatus),
  errors: Schema.optional(NonNegativeCount),
  warnings: Schema.optional(NonNegativeCount),
  queries_processed: Schema.optional(NonNegativeCount),
  findings: Schema.optional(Schema.Array(OmnigraphLintFindingWireSchema)),
  diagnostics: Schema.optional(Schema.Array(OmnigraphLintFindingWireSchema)),
})
export type OmnigraphLintCliOutput = typeof OmnigraphLintCliOutputSchema.Type

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
