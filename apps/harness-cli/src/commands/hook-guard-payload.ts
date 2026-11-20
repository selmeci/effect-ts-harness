import * as Schema from "effect/Schema"
import { match } from "ts-pattern"
import { classifyFileWrite, explainCommandDenyReason } from "@harness/gates/policy"
import { type CliResult, detectAntigravityHookPayload, makeGuardDenyResult } from "./hook-format.js"

const NullableOptionalString = Schema.optional(Schema.NullOr(Schema.String))

export const PreToolUseStdinSchema = Schema.Struct({
  tool_name: NullableOptionalString,
  tool_input: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        command: NullableOptionalString,
        file_path: NullableOptionalString,
        path: NullableOptionalString,
        filePath: NullableOptionalString,
        targetFile: NullableOptionalString,
      }),
    ),
  ),
  toolCall: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: NullableOptionalString,
        args: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              CommandLine: NullableOptionalString,
              command: NullableOptionalString,
              TargetFile: NullableOptionalString,
              AbsolutePath: NullableOptionalString,
              file_path: NullableOptionalString,
              filePath: NullableOptionalString,
              targetFile: NullableOptionalString,
              path: NullableOptionalString,
            }),
          ),
        ),
      }),
    ),
  ),
})

export const decodePreToolUseStdin = Schema.decodeOption(
  Schema.fromJsonString(PreToolUseStdinSchema),
)

export const READ_ONLY_TOOL_NAMES = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "view_file",
  "grep_search",
  "find_by_name",
  "list_dir",
  "read_file",
])

export type GuardVerdictDecision =
  | { readonly verdict: "deny"; readonly reason: string }
  | { readonly verdict: "ask"; readonly reason: string | undefined }
  | { readonly verdict: "allow" }

export const verdictRank = (v: GuardVerdictDecision["verdict"]): number =>
  match(v)
    .with("allow", () => 0)
    .with("ask", () => 1)
    .with("deny", () => 2)
    .exhaustive()

export const pickStrictestDecision = (
  a: GuardVerdictDecision,
  b: GuardVerdictDecision,
): GuardVerdictDecision => (verdictRank(b.verdict) > verdictRank(a.verdict) ? b : a)

export const formatAllowResult = (isAntigravity: boolean): CliResult => ({
  exitCode: 0,
  stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
  stderr: "",
})

export const formatAskResult = (isAntigravity: boolean, reason: string | undefined): CliResult =>
  isAntigravity
    ? {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "ask", reason }),
        stderr: "",
      }
    : {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: reason,
          },
        }),
        stderr: "",
      }

export const toGuardCliResult = (
  decision: GuardVerdictDecision,
  isAntigravity: boolean,
): CliResult =>
  match(decision)
    .with({ verdict: "deny" }, ({ reason }) => makeGuardDenyResult(isAntigravity, reason))
    .with({ verdict: "ask" }, ({ reason }) => formatAskResult(isAntigravity, reason))
    .with({ verdict: "allow" }, () => formatAllowResult(isAntigravity))
    .exhaustive()

export const formatCommandDenyReason = (command: string): string => {
  const detail = explainCommandDenyReason(command)
  return detail !== undefined
    ? `Blocked by harness guard: ${command} (${detail})`
    : `Blocked by harness guard: ${command}`
}

export const evaluateFileWriteDecision = (filePath: string): GuardVerdictDecision => {
  const fileGuard = classifyFileWrite(filePath)
  return match<typeof fileGuard.verdict, GuardVerdictDecision>(fileGuard.verdict)
    .with("deny", () => ({
      verdict: "deny",
      reason: fileGuard.reason ?? `Blocked file write: ${filePath}`,
    }))
    .with("ask", () => ({ verdict: "ask", reason: fileGuard.reason }))
    .with("allow", () => ({ verdict: "allow" }))
    .exhaustive()
}

export type ExtractedGuardStdinPayload =
  | {
      readonly _tag: "Ok"
      readonly isAntigravity: boolean
      readonly candidateCmds: ReadonlyArray<string>
      readonly candidatePaths: ReadonlyArray<string>
      readonly isReadOnlyToolCall: boolean
    }
  | {
      readonly _tag: "Error"
      readonly isAntigravity: boolean
      readonly reason: string
      readonly detail: string
    }

const pushNonEmpty = (target: Array<string>, value: string | null | undefined): void => {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      target.push(trimmed)
    }
  }
}

export const extractGuardStdinPayload = (
  rawStdin: string,
  isAntigravityFlag: boolean,
): ExtractedGuardStdinPayload => {
  const decoded = decodePreToolUseStdin(rawStdin)
  return match(decoded)
    .with({ _tag: "None" }, () => ({
      _tag: "Error" as const,
      isAntigravity: isAntigravityFlag || detectAntigravityHookPayload(rawStdin),
      reason: "guard: malformed or unrecognized hook stdin JSON payload",
      detail: "fastpath=malformed-json",
    }))
    .with({ _tag: "Some" }, ({ value }) => {
      const isAgStdin = value.toolCall !== undefined && value.toolCall !== null
      const isAntigravity = isAntigravityFlag || isAgStdin
      const candidateCmds: Array<string> = []
      const candidatePaths: Array<string> = []

      pushNonEmpty(candidateCmds, value.toolCall?.args?.CommandLine)
      pushNonEmpty(candidateCmds, value.toolCall?.args?.command)
      pushNonEmpty(candidateCmds, value.tool_input?.command)

      pushNonEmpty(candidatePaths, value.toolCall?.args?.TargetFile)
      pushNonEmpty(candidatePaths, value.toolCall?.args?.AbsolutePath)
      pushNonEmpty(candidatePaths, value.toolCall?.args?.file_path)
      pushNonEmpty(candidatePaths, value.toolCall?.args?.filePath)
      pushNonEmpty(candidatePaths, value.toolCall?.args?.targetFile)
      pushNonEmpty(candidatePaths, value.toolCall?.args?.path)
      pushNonEmpty(candidatePaths, value.tool_input?.file_path)
      pushNonEmpty(candidatePaths, value.tool_input?.path)
      pushNonEmpty(candidatePaths, value.tool_input?.filePath)
      pushNonEmpty(candidatePaths, value.tool_input?.targetFile)

      if (candidateCmds.length === 0 && candidatePaths.length === 0) {
        const toolName = isAgStdin ? value.toolCall?.name : value.tool_name
        const toolInputEmpty =
          value.tool_input === undefined ||
          value.tool_input === null ||
          (value.tool_input.command == null &&
            value.tool_input.file_path == null &&
            value.tool_input.path == null &&
            value.tool_input.filePath == null &&
            value.tool_input.targetFile == null)
        const isReadOnlyToolCall =
          typeof toolName === "string" &&
          READ_ONLY_TOOL_NAMES.has(toolName) &&
          (!isAgStdin || toolInputEmpty)
        if (isReadOnlyToolCall) {
          return {
            _tag: "Ok" as const,
            isAntigravity,
            candidateCmds,
            candidatePaths,
            isReadOnlyToolCall: true,
          }
        }
        return {
          _tag: "Error" as const,
          isAntigravity,
          reason: "guard: hook stdin payload missing command or file path",
          detail: "fastpath=missing-fields",
        }
      }

      return {
        _tag: "Ok" as const,
        isAntigravity,
        candidateCmds,
        candidatePaths,
        isReadOnlyToolCall: false,
      }
    })
    .exhaustive()
}
