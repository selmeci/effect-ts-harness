import { Schema } from "effect"
import { PluginFileLineCount } from "./ast-and-gate-primitives.js"

export const WorkspaceFilePath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("WorkspaceFilePath"),
)
export type WorkspaceFilePath = typeof WorkspaceFilePath.Type

export const WorkspaceFileContent = Schema.String.pipe(Schema.brand("WorkspaceFileContent"))
export type WorkspaceFileContent = typeof WorkspaceFileContent.Type

export const WorkspaceFileExistsFlag = Schema.Boolean.pipe(
  Schema.brand("WorkspaceFileExistsFlag"),
)
export type WorkspaceFileExistsFlag = typeof WorkspaceFileExistsFlag.Type

export const WorkspaceFsOperation = Schema.Literals(["read", "write", "stat", "readdir"]).pipe(
  Schema.brand("WorkspaceFsOperation"),
)
export type WorkspaceFsOperation = typeof WorkspaceFsOperation.Type

export const ErrorReasonMessage = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("ErrorReasonMessage"),
)
export type ErrorReasonMessage = typeof ErrorReasonMessage.Type

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

export const SubprocessCommand = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("SubprocessCommand"),
)
export type SubprocessCommand = typeof SubprocessCommand.Type

export const SubprocessArg = Schema.String.pipe(Schema.brand("SubprocessArg"))
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

export const SubprocessExitCode = Schema.Int.pipe(Schema.brand("SubprocessExitCode"))
export type SubprocessExitCode = typeof SubprocessExitCode.Type

export const SubprocessOutput = Schema.String.pipe(Schema.brand("SubprocessOutput"))
export type SubprocessOutput = typeof SubprocessOutput.Type

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
    exitCode: SubprocessExitCode,
    stderr: SubprocessOutput,
    reason: ErrorReasonMessage,
  },
) {}

export const ActiveMutantId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("ActiveMutantId"),
)
export type ActiveMutantId = typeof ActiveMutantId.Type

export const CompilerRepoRootPath = Schema.NonEmptyString.pipe(
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
