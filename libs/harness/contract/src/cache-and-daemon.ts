import { Schema } from "effect"
import {
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  EnclosingSymbolName,
  GateCategory,
  GateRuleId,
  GateViolationMessage,
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

export const AstGateEvaluationReport = Schema.Union([
  Schema.Struct({
    verdict: Schema.Literal("clean"),
    violations: Schema.Tuple([]),
    inspectedFileCount: NonNegativeCount,
    cacheHitCount: NonNegativeCount,
  }),
  Schema.Struct({
    verdict: Schema.Literal("violated"),
    violations: Schema.NonEmptyArray(AstGateViolationContract),
    inspectedFileCount: NonNegativeCount,
    cacheHitCount: NonNegativeCount,
  }),
])
export type AstGateEvaluationReport = typeof AstGateEvaluationReport.Type

export const makeAstGateEvaluationReport = (input: {
  readonly violations: ReadonlyArray<AstGateViolationContract>
  readonly inspectedFileCount: NonNegativeCount
  readonly cacheHitCount: NonNegativeCount
}): AstGateEvaluationReport => {
  const [first, ...rest] = input.violations
  if (first === undefined) {
    return {
      verdict: "clean",
      violations: [],
      inspectedFileCount: input.inspectedFileCount,
      cacheHitCount: input.cacheHitCount,
    }
  }
  return {
    verdict: "violated",
    violations: [first, ...rest],
    inspectedFileCount: input.inspectedFileCount,
    cacheHitCount: input.cacheHitCount,
  }
}

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

export class DaemonServerError extends Schema.TaggedError<DaemonServerError>()(
  "DaemonServerError",
  {
    socketPath: DaemonSocketPath,
    reason: ErrorReasonMessage,
  },
) {}
