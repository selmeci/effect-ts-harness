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

export const WorkspaceFileContent = Schema.String.pipe(Schema.brand("WorkspaceFileContent"))
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
    const candidate = (raw as { readonly message: unknown }).message
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

export const StdinReadErrorKind = Schema.Literals([
  "Timeout",
  "MaxBytesExceeded",
  "ReadFailed",
])
export type StdinReadErrorKind = typeof StdinReadErrorKind.Type

export class StdinReadError extends Schema.TaggedError<StdinReadError>()("StdinReadError", {
  reason: ErrorReasonMessage,
  reasonKind: Schema.optional(StdinReadErrorKind),
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
  Schema.check(Schema.isGreaterThanOrEqualTo(1024)),
  Schema.brand("SubprocessMaxBufferBytes"),
)
export type SubprocessMaxBufferBytes = typeof SubprocessMaxBufferBytes.Type

export const SubprocessExitCode = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("SubprocessExitCode"),
)
export type SubprocessExitCode = typeof SubprocessExitCode.Type

export const SubprocessOutput = Schema.String.pipe(Schema.brand("SubprocessOutput"))
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

export const CompilerRepoRootPath = WorkspaceFilePath.pipe(
  Schema.brand("CompilerRepoRootPath"),
)
export type CompilerRepoRootPath = typeof CompilerRepoRootPath.Type

export const CompilerRepoRootInput = Schema.String.pipe(Schema.brand("CompilerRepoRootInput"))
export type CompilerRepoRootInput = typeof CompilerRepoRootInput.Type

export const CompilerOverlayErrorReason = Schema.NonEmptyString.pipe(
  Schema.brand("CompilerOverlayErrorReason"),
)
export type CompilerOverlayErrorReason = typeof CompilerOverlayErrorReason.Type

export class TsCompilerOverlayError extends Schema.TaggedError<TsCompilerOverlayError>()(
  "TsCompilerOverlayError",
  {
    repoRoot: CompilerRepoRootInput,
    reason: CompilerOverlayErrorReason,
  },
) {}

export const CliCommandName = Schema.NonEmptyString.pipe(Schema.brand("CliCommandName"))
export type CliCommandName = typeof CliCommandName.Type

export const CliCommandInput = Schema.String.pipe(Schema.brand("CliCommandInput"))
export type CliCommandInput = typeof CliCommandInput.Type

export class CliCommandNotFoundError extends Schema.TaggedError<CliCommandNotFoundError>()(
  "CliCommandNotFoundError",
  {
    command: CliCommandInput,
    availableCommands: Schema.Array(CliCommandName),
  },
) {}

export const McpToolName = Schema.NonEmptyString.pipe(Schema.brand("McpToolName"))
export type McpToolName = typeof McpToolName.Type

export const McpToolInputName = Schema.String.pipe(Schema.brand("McpToolInputName"))
export type McpToolInputName = typeof McpToolInputName.Type

export class UnknownToolError extends Schema.TaggedError<UnknownToolError>()("UnknownToolError", {
  toolName: McpToolInputName,
}) {}
