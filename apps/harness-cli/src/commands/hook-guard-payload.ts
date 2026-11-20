import * as Schema from "effect/Schema"
import { match } from "ts-pattern"
import {
  classifyFileWrite,
  classifyWorkerFileAccess,
  explainCommandDenyReason,
  type PolicyGuardOptions,
} from "@harness/gates/policy"
import { resolveRealPathLite } from "@harness/infra/hook-io"
import { type CliResult, detectAntigravityHookPayload, makeGuardDenyResult } from "./hook-format.js"

const NullableOptionalString = Schema.optional(Schema.NullOr(Schema.String))
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

export const PreToolUseStdinSchema = Schema.Struct({
  tool_name: NullableOptionalString,
  tool_input: Schema.optional(Schema.NullOr(UnknownRecord)),
  toolCall: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: NullableOptionalString,
        args: Schema.optional(Schema.NullOr(UnknownRecord)),
      }),
    ),
  ),
})

export const decodePreToolUseStdin = Schema.decodeOption(
  Schema.fromJsonString(PreToolUseStdinSchema),
)

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "Find",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "grep_search",
  "find_by_name",
  "list_dir",
  "read_file",
])

export const resolveUnitWorkerMode = (
  env?: Readonly<Record<string, string | undefined>>,
): boolean => (env?.["HARNESS_UNIT_WORKER"] ?? process.env["HARNESS_UNIT_WORKER"]) === "1"

export type GuardVerdictDecision =
  | { readonly verdict: "deny"; readonly reason: string }
  | { readonly verdict: "ask"; readonly reason: string }
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

export const formatAskResult = (isAntigravity: boolean, reason: string): CliResult =>
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

export const formatCommandDenyReason = (command: string, options?: PolicyGuardOptions): string => {
  const detail = explainCommandDenyReason(command, options)
  return detail !== undefined
    ? `Blocked by harness guard: ${command} (${detail})`
    : `Blocked by harness guard: ${command}`
}

export const evaluateFileWriteDecision = (
  filePath: string,
  options?: PolicyGuardOptions,
): GuardVerdictDecision => {
  const fileGuard = classifyFileWrite(filePath, options)
  return match<typeof fileGuard.verdict, GuardVerdictDecision>(fileGuard.verdict)
    .with("deny", () => ({
      verdict: "deny",
      reason: fileGuard.reason ?? `Blocked file write: ${filePath}`,
    }))
    .with("ask", () => ({
      verdict: "ask",
      reason: fileGuard.reason ?? `File write requires human confirmation: ${filePath}`,
    }))
    .with("allow", () => ({ verdict: "allow" }))
    .exhaustive()
}

export const evaluateFileReadDecision = (
  filePath: string,
  options?: PolicyGuardOptions,
): GuardVerdictDecision => {
  const access = classifyWorkerFileAccess(filePath, options?.unitWorkerMode === true)
  return match<typeof access.verdict, GuardVerdictDecision>(access.verdict)
    .with("deny", () => ({
      verdict: "deny",
      reason:
        access.reason ??
        `Worker isolation mode (HARNESS_UNIT_WORKER=1) denies access to daemon socket or auth tokens: ${filePath}`,
    }))
    .with("allow", () => ({ verdict: "allow" }))
    .exhaustive()
}

const expandPathWithRealpath = (filePath: string): ReadonlyArray<string> =>
  match(resolveRealPathLite(filePath))
    .with({ _tag: "Some" }, ({ value: real }) =>
      real === filePath ? [filePath] : [filePath, real],
    )
    .with({ _tag: "None" }, () => [filePath])
    .exhaustive()

export const evaluateCandidatePaths = (
  candidatePaths: ReadonlyArray<string>,
  isReadOnlyTool: boolean,
  options?: PolicyGuardOptions,
): GuardVerdictDecision | undefined => {
  let combined: GuardVerdictDecision | undefined
  for (const rawPath of candidatePaths) {
    for (const filePath of expandPathWithRealpath(rawPath)) {
      const d = isReadOnlyTool
        ? evaluateFileReadDecision(filePath, options)
        : evaluateFileWriteDecision(filePath, options)
      combined = combined === undefined ? d : pickStrictestDecision(combined, d)
    }
  }
  return combined
}

export type ParsedGuardCliArgs =
  | { readonly _tag: "Help" }
  | { readonly _tag: "UnknownFlag"; readonly flag: string }
  | { readonly _tag: "MissingFlagValue"; readonly flag: string }
  | {
      readonly _tag: "Ok"
      readonly positionalArgs: ReadonlyArray<string>
      readonly fileFlag: string | undefined
    }

export const parseGuardCliArgs = (argsAfterCmd: ReadonlyArray<string>): ParsedGuardCliArgs => {
  const positionalArgs: Array<string> = []
  let fileFlag: string | undefined
  for (let i = 0; i < argsAfterCmd.length; i += 1) {
    const arg = argsAfterCmd[i]!
    if (arg === "--help" || arg === "-h") {
      return { _tag: "Help" }
    }
    if (arg === "--format") {
      if (i + 1 >= argsAfterCmd.length) {
        return { _tag: "MissingFlagValue", flag: "--format" }
      }
      i += 1
      continue
    }
    if (arg.startsWith("--format=")) {
      continue
    }
    if (arg === "--file") {
      if (i + 1 >= argsAfterCmd.length) {
        return { _tag: "MissingFlagValue", flag: "--file" }
      }
      fileFlag = argsAfterCmd[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith("--file=")) {
      fileFlag = arg.slice("--file=".length)
      continue
    }
    if (arg.startsWith("-")) {
      return { _tag: "UnknownFlag", flag: arg }
    }
    positionalArgs.push(arg)
  }
  return { _tag: "Ok", positionalArgs, fileFlag }
}

export type ExtractedGuardStdinPayload =
  | {
      readonly _tag: "ReadOnly"
      readonly isAntigravity: boolean
    }
  | {
      readonly _tag: "Action"
      readonly isAntigravity: boolean
      readonly isReadOnlyTool: boolean
      readonly candidateCmds: ReadonlyArray<string>
      readonly candidatePaths: ReadonlyArray<string>
    }
  | {
      readonly _tag: "Error"
      readonly isAntigravity: boolean
      readonly reason: string
      readonly detail: string
    }

const COMMAND_FIELD_KEYS = ["CommandLine", "command"] as const

const PATH_FIELD_KEYS = [
  "TargetFile",
  "AbsolutePath",
  "Path",
  "TargetDirectory",
  "file_path",
  "path",
  "filePath",
  "targetFile",
  "SearchPath",
  "DirectoryPath",
  "SearchDirectory",
  "File",
  "glob",
  "pattern",
] as const

const pushNonEmpty = (target: Array<string>, value: unknown): void => {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.length > 0 && !target.includes(trimmed)) {
      target.push(trimmed)
    }
  }
}

const collectStringLeaves = (value: unknown, target: Array<string>, depth = 0): void => {
  if (depth > 8 || value === null || value === undefined) return
  if (typeof value === "string") {
    pushNonEmpty(target, value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, target, depth + 1)
    }
    return
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) {
      collectStringLeaves(v, target, depth + 1)
    }
  }
}

const isRecordEmpty = (rec: Readonly<Record<string, unknown>> | null | undefined): boolean =>
  rec === undefined ||
  rec === null ||
  Object.values(rec).every((v) => v === null || v === undefined)

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
      const toolInput = value.tool_input
      const toolCallArgs = value.toolCall?.args

      for (const key of COMMAND_FIELD_KEYS) {
        pushNonEmpty(candidateCmds, toolCallArgs?.[key])
        pushNonEmpty(candidateCmds, toolInput?.[key])
      }
      for (const key of PATH_FIELD_KEYS) {
        pushNonEmpty(candidatePaths, toolCallArgs?.[key])
        pushNonEmpty(candidatePaths, toolInput?.[key])
      }

      const toolName = isAgStdin ? value.toolCall?.name : value.tool_name
      const isReadOnlyNamed = typeof toolName === "string" && READ_ONLY_TOOL_NAMES.has(toolName)
      if (isReadOnlyNamed && candidateCmds.length === 0) {
        collectStringLeaves(toolCallArgs, candidatePaths)
        collectStringLeaves(toolInput, candidatePaths)
      }

      if (candidateCmds.length === 0 && candidatePaths.length === 0) {
        const bothInputsEmpty = isRecordEmpty(toolInput) && isRecordEmpty(toolCallArgs)
        if (isReadOnlyNamed && bothInputsEmpty) {
          return {
            _tag: "ReadOnly" as const,
            isAntigravity,
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
        _tag: "Action" as const,
        isAntigravity,
        isReadOnlyTool: isReadOnlyNamed && candidateCmds.length === 0,
        candidateCmds,
        candidatePaths,
      }
    })
    .exhaustive()
}
