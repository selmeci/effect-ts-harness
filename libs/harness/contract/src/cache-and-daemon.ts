import { Schema } from "effect"
import {
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  EnclosingSymbolName,
  GateCategory,
  GateRuleId,
  GateViolationMessage,
  makeVerdictReport,
  makeVerdictReportSchema,
  NonNegativeCount,
  SourceLineNumber,
  WorkspaceFilePath,
} from "./ast-and-gate-primitives.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

export const DecisionCacheKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("DecisionCacheKey"),
)
export type DecisionCacheKey = typeof DecisionCacheKey.Type

export const DecisionCachePayloadJson = Schema.String.pipe(
  Schema.brand("DecisionCachePayloadJson"),
)
export type DecisionCachePayloadJson = typeof DecisionCachePayloadJson.Type

export const DecisionCacheTtlMillis = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("DecisionCacheTtlMillis"),
)
export type DecisionCacheTtlMillis = typeof DecisionCacheTtlMillis.Type

export const DecisionCacheStatsSnapshot = Schema.Struct({
  hits: NonNegativeCount,
  misses: NonNegativeCount,
  coalescedRequests: NonNegativeCount,
  size: NonNegativeCount,
})
export type DecisionCacheStatsSnapshot = typeof DecisionCacheStatsSnapshot.Type

export const AstGateFileBatchInput = Schema.Struct({
  filePath: AstSourceFilePath,
  content: AstSourceContent,
  packageTag: Schema.optional(AstGatePackageTag),
})
export type AstGateFileBatchInput = typeof AstGateFileBatchInput.Type

export const AstGateViolationContract = Schema.Struct({
  category: GateCategory,
  rule: GateRuleId,
  message: GateViolationMessage,
  file: AstSourceFilePath,
  line: SourceLineNumber,
  enclosingSymbol: EnclosingSymbolName,
})
export type AstGateViolationContract = typeof AstGateViolationContract.Type

export type AstGateFileEvaluator = (
  file: AstGateFileBatchInput,
) => ReadonlyArray<AstGateViolationContract>

export class AstGateEvaluationError extends Schema.TaggedError<AstGateEvaluationError>()(
  "AstGateEvaluationError",
  {
    filePath: AstSourceFilePath,
    reason: ErrorReasonMessage,
  },
) {}

export const AstGateEvaluationReport = makeVerdictReportSchema(AstGateViolationContract, {
  inspectedFileCount: NonNegativeCount,
  cacheHitCount: NonNegativeCount,
})
export type AstGateEvaluationReport = typeof AstGateEvaluationReport.Type

export const makeAstGateEvaluationReport = (input: {
  readonly violations: ReadonlyArray<AstGateViolationContract>
  readonly inspectedFileCount: NonNegativeCount
  readonly cacheHitCount: NonNegativeCount
}): AstGateEvaluationReport =>
  makeVerdictReport(input.violations, {
    inspectedFileCount: input.inspectedFileCount,
    cacheHitCount: input.cacheHitCount,
  })

export const AstGateDecisionReport = makeVerdictReportSchema(AstGateViolationContract, {
  cacheHitCount: NonNegativeCount,
  parsedFileCount: NonNegativeCount,
})
export type AstGateDecisionReport = typeof AstGateDecisionReport.Type

export const makeAstGateDecisionReport = (input: {
  readonly violations: ReadonlyArray<AstGateViolationContract>
  readonly cacheHitCount: NonNegativeCount
  readonly parsedFileCount: NonNegativeCount
}): AstGateDecisionReport =>
  makeVerdictReport(input.violations, {
    cacheHitCount: input.cacheHitCount,
    parsedFileCount: input.parsedFileCount,
  })

export const DaemonSocketPath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("DaemonSocketPath"),
)
export type DaemonSocketPath = typeof DaemonSocketPath.Type

export const DaemonServerInfo = Schema.Struct({
  socketPath: DaemonSocketPath,
  repoRoot: WorkspaceFilePath,
})
export type DaemonServerInfo = typeof DaemonServerInfo.Type

export const DaemonServerErrorKind = Schema.Literals([
  "already-alive",
  "not-a-socket",
  "probe-failed",
  "bind-failed",
  "chmod-failed",
  "invalid-path",
])
export type DaemonServerErrorKind = typeof DaemonServerErrorKind.Type

export class DaemonServerError extends Schema.TaggedError<DaemonServerError>()(
  "DaemonServerError",
  {
    socketPath: DaemonSocketPath,
    reasonKind: DaemonServerErrorKind,
    reason: ErrorReasonMessage,
  },
) {}
