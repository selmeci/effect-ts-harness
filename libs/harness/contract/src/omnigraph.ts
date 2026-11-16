import { Schema } from "effect"
import { NonNegativeCount, makeVerdictReportSchema } from "./ast-and-gate-primitives.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

export const OmnigraphCommitId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("OmnigraphCommitId"),
)
export type OmnigraphCommitId = typeof OmnigraphCommitId.Type

export const OmnigraphBranchName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("OmnigraphBranchName"),
)
export type OmnigraphBranchName = typeof OmnigraphBranchName.Type

export const OmnigraphChangeCursor = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("OmnigraphChangeCursor"),
)
export type OmnigraphChangeCursor = typeof OmnigraphChangeCursor.Type

export const OmnigraphDiagnosticCode = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("OmnigraphDiagnosticCode"),
)
export type OmnigraphDiagnosticCode = typeof OmnigraphDiagnosticCode.Type

export const OmnigraphTypeName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("OmnigraphTypeName"),
)
export type OmnigraphTypeName = typeof OmnigraphTypeName.Type

export const OmnigraphEntityId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("OmnigraphEntityId"),
)
export type OmnigraphEntityId = typeof OmnigraphEntityId.Type

export const OmnigraphTargetName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("OmnigraphTargetName"),
)
export type OmnigraphTargetName = typeof OmnigraphTargetName.Type

export const OmnigraphSpanName = Schema.NonEmptyString.pipe(Schema.brand("OmnigraphSpanName"))
export type OmnigraphSpanName = typeof OmnigraphSpanName.Type

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

export const OmnigraphDiffChangeSummary = Schema.Struct({
  entityKind: OmnigraphEntityKind,
  typeName: OmnigraphTypeName,
  entityId: OmnigraphEntityId,
  op: OmnigraphChangeOp,
  wasStubBefore: Schema.Boolean,
  stubAfter: Schema.Boolean,
  spanName: Schema.optional(OmnigraphSpanName),
})
export type OmnigraphDiffChangeSummary = typeof OmnigraphDiffChangeSummary.Type

export const OmnigraphBranchViolation = Schema.Struct({
  ruleId: Schema.Literals([
    "planned-effect-fn-dropped",
    "unimplemented-stub-remaining",
    "dry-run-merge-conflict",
    "missing-merge-base",
  ]),
  message: ErrorReasonMessage,
  conflict: Schema.optional(OmnigraphMergeConflictDetail),
  change: Schema.optional(OmnigraphDiffChangeSummary),
})
export type OmnigraphBranchViolation = typeof OmnigraphBranchViolation.Type

export const OmnigraphBranchVerifyInput = Schema.Struct({
  planBranch: OmnigraphBranchName,
  implBranch: OmnigraphBranchName,
  mainBranch: OmnigraphBranchName,
  diffChanges: Schema.Array(OmnigraphDiffChangeSummary),
  dryRunConflicts: Schema.Array(OmnigraphMergeConflictDetail),
  implEffectFnCount: NonNegativeCount,
  remainingStubCount: NonNegativeCount,
  missingMergeBase: Schema.optional(Schema.Boolean),
})
export type OmnigraphBranchVerifyInput = typeof OmnigraphBranchVerifyInput.Type

export const OmnigraphBranchVerifyReport = makeVerdictReportSchema(OmnigraphBranchViolation, {
  verifiedChangeCount: NonNegativeCount,
  conflictCount: NonNegativeCount,
})
export type OmnigraphBranchVerifyReport = typeof OmnigraphBranchVerifyReport.Type

export const OmnigraphSchemaEvolutionInput = Schema.Struct({
  clusterExists: Schema.Boolean,
  queriesChanged: Schema.Boolean,
  schemaAdditiveChanged: Schema.Boolean,
  policyBundleOrEdgeKeyChanged: Schema.Boolean,
  serverAlive: Schema.Boolean,
})
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

export const OmnigraphLintDiagnostic = Schema.Struct({
  code: OmnigraphDiagnosticCode,
  message: ErrorReasonMessage,
  targetName: Schema.NullOr(OmnigraphTargetName),
  severity: Schema.optional(Schema.Literals(["error", "warning", "info"])),
})
export type OmnigraphLintDiagnostic = typeof OmnigraphLintDiagnostic.Type

export const OmnigraphLintInput = Schema.Struct({
  statusOk: Schema.Boolean,
  errorCount: NonNegativeCount,
  warningCount: NonNegativeCount,
  queriesProcessed: NonNegativeCount,
  diagnostics: Schema.Array(OmnigraphLintDiagnostic),
  failOnError: Schema.optional(Schema.Boolean),
  denyWarnings: Schema.optional(Schema.Boolean),
})
export type OmnigraphLintInput = typeof OmnigraphLintInput.Type

export const OmnigraphLintViolation = Schema.Struct({
  ruleId: Schema.Literals(["omnigraph-lint-error", "omnigraph-lint-status-not-ok"]),
  message: ErrorReasonMessage,
  diagnostic: Schema.optional(OmnigraphLintDiagnostic),
})
export type OmnigraphLintViolation = typeof OmnigraphLintViolation.Type

export const OmnigraphLintReport = makeVerdictReportSchema(OmnigraphLintViolation, {
  queriesProcessed: NonNegativeCount,
  errorCount: NonNegativeCount,
  warningCount: NonNegativeCount,
})
export type OmnigraphLintReport = typeof OmnigraphLintReport.Type

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
