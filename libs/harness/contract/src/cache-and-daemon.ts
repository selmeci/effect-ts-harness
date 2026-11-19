import { Schema } from "effect"
import {
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  ContentSha256,
  EnclosingSymbolName,
  GateCategory,
  GateRuleId,
  GateRuleVersion,
  GateViolationMessage,
  makeVerdictReport,
  makeVerdictReportSchema,
  NonNegativeCount,
  SourceLineNumber,
  WorkspaceFilePath,
} from "./ast-and-gate-primitives.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

export const HARNESS_AST_GATE_CACHE_FILENAME = "ast-gate-cache-v1.json" as const
export const HARNESS_DECISION_CACHE_FILENAME = "decision-cache-v1.json" as const

export const normalizeNonRootWorkspacePath = (raw: string): WorkspaceFilePath => {
  const decoded = Schema.decodeSync(WorkspaceFilePath)(raw)
  if (/^[\\/]+$/.test(decoded) || /^[A-Za-z]:[\\/]*$/.test(decoded)) {
    return Schema.decodeSync(WorkspaceFilePath)("")
  }
  const hasUncPrefix = decoded.startsWith("//") || decoded.startsWith("\\\\")
  const hasPosixPrefix = !hasUncPrefix && decoded.startsWith("/")
  const hasWinDrivePrefix = !hasUncPrefix && !hasPosixPrefix && /^[A-Za-z]:[\\/]/.test(decoded)
  const prefix = hasUncPrefix
    ? "//"
    : hasPosixPrefix
      ? "/"
      : hasWinDrivePrefix
        ? `${decoded.slice(0, 2)}/`
        : ""
  const rest = hasUncPrefix
    ? decoded.slice(2)
    : hasPosixPrefix
      ? decoded.slice(1)
      : hasWinDrivePrefix
        ? decoded.slice(3)
        : decoded
  const isRooted = prefix.length > 0
  const stack: Array<string> = []
  for (const segment of rest.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") {
      continue
    }
    if (segment === "..") {
      if (isRooted) {
        if (stack.length > 0) {
          stack.pop()
        }
        continue
      }
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop()
      } else {
        stack.push("..")
      }
      continue
    }
    stack.push(segment)
  }
  if (isRooted) {
    if (stack.length === 0) {
      return Schema.decodeSync(WorkspaceFilePath)("")
    }
    return WorkspaceFilePath.make(`${prefix}${stack.join("/")}`)
  }
  if (stack.every((segment) => segment === "..")) {
    return Schema.decodeSync(WorkspaceFilePath)("")
  }
  return WorkspaceFilePath.make(stack.join("/"))
}

export const sanitizeWorktreeIdSegment = (rawWorktreeId: string): string => {
  const trimmed = Schema.decodeSync(WorkspaceFilePath)(rawWorktreeId.trim())
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_")
  if (/^\.+$/.test(sanitized)) {
    return Schema.decodeSync(WorkspaceFilePath)("")
  }
  return sanitized
}

const resolveDefaultCacheFilePath = (repoRoot: string, fileName: string): WorkspaceFilePath => {
  const normalizedRoot = normalizeNonRootWorkspacePath(repoRoot)
  return WorkspaceFilePath.make(`${normalizedRoot}/.harness/cache/${fileName}`)
}

export const resolveDefaultAstGateCachePath = (repoRoot: string): WorkspaceFilePath =>
  resolveDefaultCacheFilePath(repoRoot, HARNESS_AST_GATE_CACHE_FILENAME)

export const resolveDefaultDecisionCachePath = (repoRoot: string): WorkspaceFilePath =>
  resolveDefaultCacheFilePath(repoRoot, HARNESS_DECISION_CACHE_FILENAME)

export const EvaluatorId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[^\0]+$/s)),
  Schema.brand("EvaluatorId"),
)
export type EvaluatorId = typeof EvaluatorId.Type

export const DecisionCacheKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[^\0]+$/s)),
  Schema.brand("DecisionCacheKey"),
)
export type DecisionCacheKey = typeof DecisionCacheKey.Type

export const DecisionCachePayloadJson = Schema.String.pipe(Schema.brand("DecisionCachePayloadJson"))
export type DecisionCachePayloadJson = typeof DecisionCachePayloadJson.Type

export const DecisionCacheTtlMillis = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
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

export const PersistedAstCacheKey = Schema.NonEmptyString.pipe(Schema.brand("PersistedAstCacheKey"))
export type PersistedAstCacheKey = typeof PersistedAstCacheKey.Type

export const PersistedAstCacheEntry = Schema.Struct({
  contentSha256: ContentSha256,
  ruleVersion: GateRuleVersion,
  violations: Schema.Array(AstGateViolationContract),
})
export type PersistedAstCacheEntry = typeof PersistedAstCacheEntry.Type

export const PersistedAstCacheStore = Schema.Struct({
  version: GateRuleVersion,
  entries: Schema.Record(PersistedAstCacheKey, PersistedAstCacheEntry),
})
export type PersistedAstCacheStore = typeof PersistedAstCacheStore.Type

export const selectActivePersistedAstCacheEntries = (
  store: PersistedAstCacheStore,
  activeRuleVersion: GateRuleVersion,
): ReadonlyMap<PersistedAstCacheKey, PersistedAstCacheEntry> => {
  const activeEntries = new Map<PersistedAstCacheKey, PersistedAstCacheEntry>()
  if (store.version !== activeRuleVersion) {
    return activeEntries
  }
  for (const [key, entry] of Object.entries(store.entries)) {
    if (entry.ruleVersion === activeRuleVersion) {
      activeEntries.set(PersistedAstCacheKey.make(key), entry)
    }
  }
  return activeEntries
}
