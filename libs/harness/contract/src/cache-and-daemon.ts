import { Result, Schema } from "effect"
import {
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  compareCodeUnits,
  computeContentSha256,
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

export const DecisionCachePayloadJson = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(4_194_304)),
  Schema.brand("DecisionCachePayloadJson"),
)
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

export const CompilerVersionTag = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[^\0\r\n]+$/s)),
  Schema.brand("CompilerVersionTag"),
)
export type CompilerVersionTag = typeof CompilerVersionTag.Type

const ExplicitGateRuleSourceConfig = Schema.TaggedStruct("ExplicitVersion", {
  ruleVersion: GateRuleVersion,
})

const HashedGateRuleSourceConfig = Schema.TaggedStruct("HashedSources", {
  ruleSourceFiles: Schema.NonEmptyArray(WorkspaceFilePath),
  ruleSourceRoot: Schema.optional(WorkspaceFilePath),
  compilerVersion: Schema.optional(CompilerVersionTag),
})

export const AstGateCacheRuleSourceConfig = Schema.Union([
  ExplicitGateRuleSourceConfig,
  HashedGateRuleSourceConfig,
])
export type AstGateCacheRuleSourceConfig = typeof AstGateCacheRuleSourceConfig.Type

const ResolvedGateRuleVersionSuccess = Schema.TaggedStruct("Resolved", {
  ruleVersion: GateRuleVersion,
})

const UncachedGateRuleVersionFallback = Schema.TaggedStruct("Uncached", {
  reason: ErrorReasonMessage,
  rootDir: WorkspaceFilePath,
  failedFile: Schema.optional(WorkspaceFilePath),
})

export const ResolvedGateRuleVersion = Schema.Union([
  ResolvedGateRuleVersionSuccess,
  UncachedGateRuleVersionFallback,
])
export type ResolvedGateRuleVersion = typeof ResolvedGateRuleVersion.Type

export const GateRuleSourceSnapshot = Schema.Struct({
  filePath: WorkspaceFilePath,
  content: AstSourceContent,
})
export type GateRuleSourceSnapshot = typeof GateRuleSourceSnapshot.Type

/**
 * Derives a deterministic SHA-256 `GateRuleVersion` from canonical path-bound
 * rule source snapshots (plus optional compiler version tag).
 * Fails closed when given an empty snapshot list so callers never fall back
 * to a static version key that could collide across rule changes.
 */
export const computeGateRuleVersionFromSources = (
  sources: ReadonlyArray<GateRuleSourceSnapshot>,
  compilerVersion?: CompilerVersionTag,
): Result.Result<GateRuleVersion, ErrorReasonMessage> => {
  if (sources.length === 0) {
    return Result.fail(
      ErrorReasonMessage.make(
        "Cannot derive AST gate rule version from an empty rule source snapshot list.",
      ),
    )
  }
  const canonicalPairs = [...sources]
    .sort((a, b) => compareCodeUnits(a.filePath, b.filePath))
    .map((s) => [s.filePath, computeContentSha256(s.content)] as const)
  const digest = computeContentSha256(
    JSON.stringify({
      domain: "ast-gate-rules-v1",
      ...(compilerVersion !== undefined ? { compilerVersion } : {}),
      files: canonicalPairs,
    }),
  )
  return Result.succeed(GateRuleVersion.make(`ast-gates-${digest}`))
}

const PERSISTED_AST_CACHE_KEY_RE =
  /^[^\0]+\0(?:contract|domain|service|infra|app|test)\0[^\0]+\0[^\0]+$/s

export const PersistedAstCacheKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(4096)),
  Schema.check(Schema.isPattern(PERSISTED_AST_CACHE_KEY_RE)),
  Schema.brand("PersistedAstCacheKey"),
)
export type PersistedAstCacheKey = typeof PersistedAstCacheKey.Type

/** Constructs a canonical 4-segment persisted AST cache key delimited by NUL bytes. */
export const makePersistedAstCacheKey = (
  filePath: AstSourceFilePath,
  packageTag: AstGatePackageTag,
  ruleVersion: GateRuleVersion,
  evaluatorId: EvaluatorId,
): PersistedAstCacheKey =>
  PersistedAstCacheKey.make(`${filePath}\0${packageTag}\0${ruleVersion}\0${evaluatorId}`)

export const PersistedAstCacheEntry = Schema.Struct({
  contentSha256: ContentSha256,
  ruleVersion: GateRuleVersion,
  violations: Schema.Array(AstGateViolationContract).pipe(Schema.check(Schema.isMaxLength(10_000))),
})
export type PersistedAstCacheEntry = typeof PersistedAstCacheEntry.Type

export const PersistedAstCacheStore = Schema.Struct({
  version: GateRuleVersion,
  entries: Schema.Record(PersistedAstCacheKey, PersistedAstCacheEntry),
})
export type PersistedAstCacheStore = typeof PersistedAstCacheStore.Type

/**
 * Filters persisted AST gate cache entries down to the active `GateRuleVersion`,
 * evicting any store-version mismatch, stale entry `ruleVersion`, or key whose
 * embedded rule-version segment does not match `activeRuleVersion`.
 */
export const selectActivePersistedAstCacheEntries = (
  store: PersistedAstCacheStore,
  activeRuleVersion: GateRuleVersion,
): ReadonlyMap<PersistedAstCacheKey, PersistedAstCacheEntry> => {
  const activeEntries = new Map<PersistedAstCacheKey, PersistedAstCacheEntry>()
  if (store.version !== activeRuleVersion) {
    return activeEntries
  }
  for (const [key, entry] of Object.entries(store.entries)) {
    const parts = key.split("\0")
    if (
      parts.length === 4 &&
      parts[2] === activeRuleVersion &&
      entry.ruleVersion === activeRuleVersion
    ) {
      activeEntries.set(PersistedAstCacheKey.make(key), entry)
    }
  }
  return activeEntries
}
