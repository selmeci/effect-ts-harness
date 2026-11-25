import { Cause, Option, Schema } from "effect"
import { PluginFileLineCount, WorkspaceFilePath } from "./ast-and-gate-primitives.js"

export { WorkspaceFilePath }

/**
 * Returns true iff `cause` represents a pure fiber interruption with no typed
 * failure (`Fail`) and no defect (`Die`). Prevents `catchCause` handlers from
 * swallowing composite causes that combine an interrupt with a failure/defect.
 */
export const isPureInterruptCause = <E>(cause: Cause.Cause<E>): boolean =>
  Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)

export const WorkspaceFileContent = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(16_777_216)),
  Schema.brand("WorkspaceFileContent"),
)
export type WorkspaceFileContent = typeof WorkspaceFileContent.Type

export const WorkspaceFsOperation = Schema.Literals(["read", "write", "stat", "readdir"])
export type WorkspaceFsOperation = typeof WorkspaceFsOperation.Type

export const ErrorReasonMessage = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("ErrorReasonMessage"),
)
export type ErrorReasonMessage = typeof ErrorReasonMessage.Type

const extractRawErrorMessage = (raw: unknown): string => {
  if (raw instanceof Error) {
    return raw.message
  }
  if (typeof raw === "object" && raw !== null && "message" in raw) {
    const candidate: unknown = Reflect.get(raw, "message")
    if (typeof candidate === "string") {
      return candidate
    }
  }
  if (typeof raw === "string") {
    return raw
  }
  if (typeof raw === "object" && raw !== null && Object.getPrototypeOf(raw) === null) {
    return ""
  }
  return String(raw)
}

/**
 * Total conversion from an arbitrary thrown/caught value into a trimmed,
 * non-empty `ErrorReasonMessage`. Never throws `SchemaError`.
 */
export const toErrorReasonMessage = (
  raw: unknown,
  fallback = "Unknown error",
): ErrorReasonMessage => {
  const trimmed = extractRawErrorMessage(raw).trim()
  if (trimmed.length > 0) {
    return ErrorReasonMessage.make(trimmed)
  }
  const trimmedFallback = fallback.trim()
  return ErrorReasonMessage.make(trimmedFallback.length > 0 ? trimmedFallback : "Unknown error")
}

export const WorkspaceFileStat = Schema.Struct({
  filePath: WorkspaceFilePath,
  content: WorkspaceFileContent,
  lineCount: PluginFileLineCount,
})
export type WorkspaceFileStat = typeof WorkspaceFileStat.Type

export class WorkspaceFsError extends Schema.TaggedError<WorkspaceFsError>()("WorkspaceFsError", {
  filePath: WorkspaceFilePath,
  operation: WorkspaceFsOperation,
  reason: ErrorReasonMessage,
}) {}

export const StdinReadErrorKind = Schema.Literals(["Timeout", "MaxBytesExceeded", "ReadFailed"])
export type StdinReadErrorKind = typeof StdinReadErrorKind.Type

export class StdinReadError extends Schema.TaggedError<StdinReadError>()("StdinReadError", {
  reason: ErrorReasonMessage,
  reasonKind: StdinReadErrorKind,
}) {}

export const SubprocessCommand = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[^\0]+$/s)),
  Schema.brand("SubprocessCommand"),
)
export type SubprocessCommand = typeof SubprocessCommand.Type

export const SubprocessArg = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\0]*$/s)),
  Schema.brand("SubprocessArg"),
)
export type SubprocessArg = typeof SubprocessArg.Type

export const SubprocessTimeoutMs = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("SubprocessTimeoutMs"),
)
export type SubprocessTimeoutMs = typeof SubprocessTimeoutMs.Type

export const SubprocessMaxBufferBytes = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1024, maximum: 16_777_216 })),
  Schema.brand("SubprocessMaxBufferBytes"),
)
export type SubprocessMaxBufferBytes = typeof SubprocessMaxBufferBytes.Type

export const SubprocessExitCode = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("SubprocessExitCode"),
)
export type SubprocessExitCode = typeof SubprocessExitCode.Type

export const BatchExitCode = Schema.Int.pipe(Schema.brand("BatchExitCode"))
export type BatchExitCode = typeof BatchExitCode.Type

export const SubprocessSignalName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Z][A-Z0-9_+-]{1,31}$/)),
  Schema.brand("SubprocessSignalName"),
)
export type SubprocessSignalName = typeof SubprocessSignalName.Type

export const SubprocessOutput = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(16_777_216)),
  Schema.brand("SubprocessOutput"),
)
export type SubprocessOutput = typeof SubprocessOutput.Type

export const SubprocessFailureKind = Schema.Literals([
  "non-zero-exit",
  "spawn-error",
  "timeout",
  "signal",
  "max-buffer",
  "invalid-input",
])
export type SubprocessFailureKind = typeof SubprocessFailureKind.Type

export const SubprocessExecInput = Schema.Struct({
  command: SubprocessCommand,
  args: Schema.Array(SubprocessArg),
  cwd: Schema.optional(WorkspaceFilePath),
  timeoutMs: Schema.optional(SubprocessTimeoutMs),
  maxBufferBytes: Schema.optional(SubprocessMaxBufferBytes),
})
export type SubprocessExecInput = typeof SubprocessExecInput.Type

export const SubprocessExecResult = Schema.Struct({
  command: SubprocessCommand,
  exitCode: SubprocessExitCode,
  stdout: SubprocessOutput,
  stderr: SubprocessOutput,
})
export type SubprocessExecResult = typeof SubprocessExecResult.Type

export class HarnessSubprocessError extends Schema.TaggedError<HarnessSubprocessError>()(
  "HarnessSubprocessError",
  {
    command: SubprocessCommand,
    exitCode: Schema.optional(SubprocessExitCode),
    stderr: SubprocessOutput,
    reason: ErrorReasonMessage,
    failureKind: SubprocessFailureKind,
  },
) {}

export const validateSubprocessInput = (
  input: SubprocessExecInput,
): Option.Option<HarnessSubprocessError> => {
  if (input.command.includes("\0")) {
    return Option.some(
      new HarnessSubprocessError({
        command: input.command,
        stderr: SubprocessOutput.make(""),
        reason: ErrorReasonMessage.make("Subprocess command contains a disallowed null byte"),
        failureKind: "invalid-input",
      }),
    )
  }
  if (input.args.some((arg) => arg.includes("\0"))) {
    return Option.some(
      new HarnessSubprocessError({
        command: input.command,
        stderr: SubprocessOutput.make(""),
        reason: ErrorReasonMessage.make("Subprocess arguments contain a disallowed null byte"),
        failureKind: "invalid-input",
      }),
    )
  }
  if (input.cwd !== undefined && input.cwd.includes("\0")) {
    return Option.some(
      new HarnessSubprocessError({
        command: input.command,
        stderr: SubprocessOutput.make(""),
        reason: ErrorReasonMessage.make("Subprocess cwd contains a disallowed null byte"),
        failureKind: "invalid-input",
      }),
    )
  }
  return Option.none()
}

export const ActiveMutantId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("ActiveMutantId"),
)
export type ActiveMutantId = typeof ActiveMutantId.Type

const fnv1a64Hex = (raw: string): string => {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask64 = 0xffffffffffffffffn
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= BigInt(raw.charCodeAt(i))
    hash = (hash * prime) & mask64
  }
  return hash.toString(16).padStart(16, "0")
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

const sliceHeadSafe = (raw: string, maxLen: number): string => {
  const end = Math.min(raw.length, Math.max(0, maxLen))
  const cut =
    isHighSurrogate(raw.charCodeAt(end - 1)) && isLowSurrogate(raw.charCodeAt(end)) ? end - 1 : end
  return raw.slice(0, cut)
}

const sliceTailSafe = (raw: string, maxLen: number): string => {
  const start = Math.max(0, raw.length - Math.max(0, maxLen))
  const cut =
    isHighSurrogate(raw.charCodeAt(start - 1)) && isLowSurrogate(raw.charCodeAt(start))
      ? start + 1
      : start
  return raw.slice(cut)
}

export interface BoundedErrorMessageOptions {
  readonly prefix: string
  readonly detail?: string | undefined
  readonly trailingSuffix?: string | undefined
  readonly separator?: string | undefined
  readonly maxChars: number
  readonly fallback?: string | undefined
}

const assembleBoundedMessage = (
  rawPrefix: string,
  rawDetail: string,
  trailingSuffix: string,
  separator: string,
  maxChars: number,
): string => {
  const prefix = rawPrefix.trim()
  const detail = rawDetail.trim()
  if (trailingSuffix.length > maxChars) {
    const sliced = sliceTailSafe(trailingSuffix, maxChars).trim()
    return sliced.length > 0 ? sliced : sliceHeadSafe(prefix, maxChars)
  }
  const prefixAndSuffixLen = prefix.length + trailingSuffix.length
  if (prefixAndSuffixLen > maxChars) {
    return `${sliceHeadSafe(prefix, maxChars - trailingSuffix.length)}${trailingSuffix}`
  }
  const effectiveSeparator = prefix.length > 0 ? separator : ""
  const detailBudget = maxChars - prefixAndSuffixLen - effectiveSeparator.length
  if (detail.length > 0 && detailBudget > 0) {
    const slicedDetail = sliceTailSafe(detail, detailBudget).trimStart()
    if (slicedDetail.length > 0) {
      return `${prefix}${effectiveSeparator}${slicedDetail}${trailingSuffix}`
    }
  }
  return `${prefix}${trailingSuffix}`
}

/**
 * Formats a bounded error message within `maxChars` while preserving `trailingSuffix` intact
 * whenever `trailingSuffix.length <= maxChars`, trimming `detail` from the head (keeping its
 * diagnostic tail) and truncating `prefix` only if needed, with UTF-16 surrogate-pair safety.
 */
export const formatBoundedErrorMessage = (options: BoundedErrorMessageOptions): string => {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(0, Math.floor(options.maxChars)) : 0
  if (maxChars === 0) {
    return ""
  }
  const fallback = (options.fallback ?? "").trim()
  const trimmed = assembleBoundedMessage(
    options.prefix,
    options.detail ?? "",
    options.trailingSuffix ?? "",
    options.separator ?? "",
    maxChars,
  ).trim()
  if (trimmed.length > 0) {
    return trimmed
  }
  if (fallback.length === 0) {
    return ""
  }
  return sliceHeadSafe(fallback, maxChars).trim()
}

const truncateWithHashDigest = (raw: string, maxLength: number): string => {
  if (raw.length <= maxLength) {
    return raw
  }
  const suffix = `…[len=${raw.length},h=${fnv1a64Hex(raw)}]`
  return `${sliceHeadSafe(raw, maxLength - suffix.length)}${sliceTailSafe(suffix, maxLength)}`
}

export const CompilerRepoRootPath = WorkspaceFilePath.pipe(Schema.brand("CompilerRepoRootPath"))
export type CompilerRepoRootPath = typeof CompilerRepoRootPath.Type

export const CompilerRepoRootInput = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(4096)),
  Schema.brand("CompilerRepoRootInput"),
)
export type CompilerRepoRootInput = typeof CompilerRepoRootInput.Type

export const toCompilerRepoRootInput = (raw: string): CompilerRepoRootInput =>
  CompilerRepoRootInput.make(truncateWithHashDigest(raw, 4096))

export const CompilerOverlayErrorReason = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(8192)),
  Schema.brand("CompilerOverlayErrorReason"),
)
export type CompilerOverlayErrorReason = typeof CompilerOverlayErrorReason.Type

export const toCompilerOverlayErrorReason = (
  raw: string,
  fallback = "Compiler overlay operation failed",
): CompilerOverlayErrorReason =>
  CompilerOverlayErrorReason.make(
    formatBoundedErrorMessage({
      prefix: raw,
      maxChars: 8192,
      fallback: fallback.trim().length > 0 ? fallback : "Unknown error",
    }),
  )

export class TsCompilerOverlayError extends Schema.TaggedError<TsCompilerOverlayError>()(
  "TsCompilerOverlayError",
  {
    repoRoot: CompilerRepoRootInput,
    reason: CompilerOverlayErrorReason,
  },
) {}

export const CliCommandName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("CliCommandName"),
)
export type CliCommandName = typeof CliCommandName.Type

export const CliCommandInput = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(65_536)),
  Schema.brand("CliCommandInput"),
)
export type CliCommandInput = typeof CliCommandInput.Type

export class CliCommandNotFoundError extends Schema.TaggedError<CliCommandNotFoundError>()(
  "CliCommandNotFoundError",
  {
    command: CliCommandInput,
    availableCommands: Schema.Array(CliCommandName),
  },
) {}

export const CanonicalCliCommandName = Schema.Literals([
  "guard",
  "route",
  "review-route",
  "plan-check",
  "plan-synth",
  "repair",
  "verify",
  "done",
  "learn",
  "gc",
  "mutate",
  "bench",
  "benchmark",
  "ingest",
  "session",
  "doctor",
  "ontology",
  "report",
  "check-openapi",
  "check-migrations",
  "check-event-schemas",
  "scenario",
  "workflow",
  "help",
]).pipe(Schema.brand("CanonicalCliCommandName"))
export type CanonicalCliCommandName = typeof CanonicalCliCommandName.Type

export const CANONICAL_CLI_COMMAND_NAMES: ReadonlyArray<CliCommandName> =
  CanonicalCliCommandName.schema.literals.map((name) => CliCommandName.make(name))

export const McpToolName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("McpToolName"),
)
export type McpToolName = typeof McpToolName.Type

export const CanonicalMcpToolName = Schema.Literals([
  "harness_resolve",
  "harness_callers",
  "harness_callees",
  "harness_tests_reaching",
  "harness_structural_search",
  "harness_route",
  "harness_review_route",
  "harness_ontology_why",
  "harness_ontology_impact",
  "harness_ontology_check",
  "harness_gq_query",
  "harness_lsp_diagnostics",
  "harness_telemetry_report",
  "harness_graph_infer",
  "harness_graph_complete",
  "harness_graph_rewrite",
  "harness_git_diff",
  "harness_workflow_plan",
  "harness_search_knowledge",
  "harness_doc_tree",
]).pipe(Schema.brand("CanonicalMcpToolName"))
export type CanonicalMcpToolName = typeof CanonicalMcpToolName.Type

export const CANONICAL_MCP_TOOL_NAMES: ReadonlyArray<McpToolName> =
  CanonicalMcpToolName.schema.literals.map((name) => McpToolName.make(name))

export const McpToolInputName = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("McpToolInputName"),
)
export type McpToolInputName = typeof McpToolInputName.Type

export const toMcpToolInputName = (raw: string): McpToolInputName =>
  McpToolInputName.make(truncateWithHashDigest(raw, 256))

export class UnknownToolError extends Schema.TaggedError<UnknownToolError>()("UnknownToolError", {
  toolName: McpToolInputName,
}) {}

export const GitDiffErrorReason = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("GitDiffErrorReason"),
)
export type GitDiffErrorReason = typeof GitDiffErrorReason.Type

export class GitDiffExecutionError extends Schema.TaggedError<GitDiffExecutionError>()(
  "GitDiffExecutionError",
  {
    reason: GitDiffErrorReason,
  },
) {}
