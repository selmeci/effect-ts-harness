import { Schema } from "effect"
import {
  AstSourceContent,
  AstSourceFilePath,
  EnclosingSymbolName,
  GateVerdict,
  SourceLineNumber,
} from "../ast-cache.js"
import { NonNegativeCount } from "@harness/graph"

export const PluginId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("PluginId"),
)
export type PluginId = typeof PluginId.Type

export const PluginFileLineCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("PluginFileLineCount"),
)
export type PluginFileLineCount = typeof PluginFileLineCount.Type

export const computeWorkspaceFileLineCount = (content: string): PluginFileLineCount =>
  PluginFileLineCount.make(content.length === 0 ? 0 : content.split(/\r?\n/).length)

export const MaxPluginFileLines = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("MaxPluginFileLines"),
)
export type MaxPluginFileLines = typeof MaxPluginFileLines.Type

export const DEFAULT_MAX_PLUGIN_FILE_LINES: MaxPluginFileLines = MaxPluginFileLines.make(800)

export const SelfDogfoodingRuleId = Schema.Literals([
  "effect-fn-dummy-void",
  "nested-effect-run-sync",
  "harness-switch-statement",
  "match-run-statement",
  "file-line-budget-exceeded",
  "facade-star-reexport",
  "catch-cause-interrupts-only",
  "silent-catch-defect",
  "ignored-chmod-permission",
]).pipe(Schema.brand("SelfDogfoodingRuleId"))
export type SelfDogfoodingRuleId = typeof SelfDogfoodingRuleId.Type

export const SelfDogfoodingMessage = Schema.NonEmptyString.pipe(
  Schema.brand("SelfDogfoodingMessage"),
)
export type SelfDogfoodingMessage = typeof SelfDogfoodingMessage.Type

export const SelfDogfoodingFileInput = Schema.Struct({
  filePath: AstSourceFilePath,
  content: AstSourceContent,
  isModularPluginFile: Schema.optional(Schema.Boolean),
})
export type SelfDogfoodingFileInput = typeof SelfDogfoodingFileInput.Type

export const SelfDogfoodingViolation = Schema.Struct({
  rule: SelfDogfoodingRuleId,
  message: SelfDogfoodingMessage,
  file: AstSourceFilePath,
  line: SourceLineNumber,
  enclosingSymbol: EnclosingSymbolName,
})
export type SelfDogfoodingViolation = typeof SelfDogfoodingViolation.Type

export const SelfDogfoodingInput = Schema.Struct({
  files: Schema.Array(SelfDogfoodingFileInput),
  maxPluginFileLines: Schema.optional(MaxPluginFileLines),
  failOnViolation: Schema.optional(Schema.Boolean),
})
export type SelfDogfoodingInput = typeof SelfDogfoodingInput.Type

export const SelfDogfoodingReport = Schema.Struct({
  verdict: GateVerdict,
  violations: Schema.Array(SelfDogfoodingViolation),
  inspectedFileCount: NonNegativeCount,
})
export type SelfDogfoodingReport = typeof SelfDogfoodingReport.Type

export const makeSelfDogfoodingReport = (
  violations: ReadonlyArray<SelfDogfoodingViolation>,
  inspectedFileCount: NonNegativeCount,
): SelfDogfoodingReport => ({
  verdict: GateVerdict.make(violations.length === 0 ? "clean" : "violated"),
  violations: [...violations],
  inspectedFileCount,
})

export class SelfDogfoodingViolationError extends Schema.TaggedError<SelfDogfoodingViolationError>()(
  "SelfDogfoodingViolationError",
  {
    message: SelfDogfoodingMessage,
    violations: Schema.Array(SelfDogfoodingViolation),
  },
) {}

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
