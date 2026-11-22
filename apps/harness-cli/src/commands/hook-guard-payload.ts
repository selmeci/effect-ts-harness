import * as Schema from "effect/Schema"
import { match } from "ts-pattern"
import {
  classifyFileRead,
  classifyFileWrite,
  explainCommandDenyReason,
  type PolicyGuardOptions,
} from "@harness/gates/policy"
import { resolveRealPathWithAncestorWalkLite } from "@harness/infra/hook-io"
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

export const CLAUDE_CODE_READ_ONLY_TOOL_NAMES = ["Read", "Glob", "Grep", "LS", "Find"] as const
export const CLAUDE_CODE_WRITE_TOOL_NAMES = ["Edit", "Write", "MultiEdit"] as const
export const CLAUDE_CODE_COMMAND_TOOL_NAMES = ["Bash"] as const

export const ANTIGRAVITY_READ_ONLY_TOOL_NAMES = [
  "view_file",
  "view_file_outline",
  "view_code_item",
  "read_file",
  "grep_search",
  "find_by_name",
  "list_dir",
] as const
export const ANTIGRAVITY_WRITE_TOOL_NAMES = [
  "edit_file",
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_to_file",
] as const
export const ANTIGRAVITY_COMMAND_TOOL_NAMES = ["run_command"] as const

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CLAUDE_CODE_READ_ONLY_TOOL_NAMES,
  ...ANTIGRAVITY_READ_ONLY_TOOL_NAMES,
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
  const access = classifyFileRead(filePath, options)
  return match<typeof access.verdict, GuardVerdictDecision>(access.verdict)
    .with("deny", () => ({
      verdict: "deny",
      reason: access.reason ?? `Blocked file read: ${filePath}`,
    }))
    .with("allow", () => ({ verdict: "allow" }))
    .exhaustive()
}

export const evaluateCandidatePaths = (
  candidatePaths: ReadonlyArray<string>,
  isReadOnlyTool: boolean,
  options?: PolicyGuardOptions,
): GuardVerdictDecision | undefined => {
  let combined: GuardVerdictDecision | undefined
  for (const rawPath of candidatePaths) {
    const expanded = resolveRealPathWithAncestorWalkLite(rawPath)
    const d = match(expanded)
      .with({ _tag: "Deny" }, ({ reason }) => ({ verdict: "deny" as const, reason }))
      .with({ _tag: "Ok" }, ({ paths }) => {
        let pathDecision: GuardVerdictDecision | undefined
        for (const filePath of paths) {
          const next = isReadOnlyTool
            ? evaluateFileReadDecision(filePath, options)
            : evaluateFileWriteDecision(filePath, options)
          pathDecision =
            pathDecision === undefined ? next : pickStrictestDecision(pathDecision, next)
        }
        return pathDecision ?? { verdict: "allow" as const }
      })
      .exhaustive()
    combined = combined === undefined ? d : pickStrictestDecision(combined, d)
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

export const MAX_PAYLOAD_STRING_DEPTH = 8

const COMMAND_FIELD_KEYS = ["CommandLine", "command"] as const

const BASE_PATH_FIELD_KEYS = [
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
] as const

const FILE_FINDER_TOOL_NAMES: ReadonlySet<string> = new Set(["Glob", "find_by_name", "Find"])
const GREP_TOOL_NAMES: ReadonlySet<string> = new Set(["Grep", "grep_search"])

const SEARCH_QUERY_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "Query",
  "query",
  "TargetContent",
  "targetContent",
  "OutputMode",
  "output_mode",
])
const GREP_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  ...SEARCH_QUERY_EXCLUDED_KEYS,
  "pattern",
  "Pattern",
])

const pushNonEmpty = (target: Array<string>, value: unknown): void => {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.length > 0 && !target.includes(trimmed)) {
      target.push(trimmed)
    }
  }
}

const pushStringOrArray = (target: Array<string>, value: unknown): void => {
  if (typeof value === "string") {
    pushNonEmpty(target, value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      pushNonEmpty(target, item)
    }
  }
}

const joinPosixPair = (base: string, child: string): string => {
  const b = base.replace(/\/+$/, "")
  const c = child.replace(/^\/+/, "")
  if (b.length === 0) return c
  if (c.length === 0) return b
  return `${b}/${c}`
}

const exceedsPayloadDepth = (value: unknown, depth: number): boolean => {
  if (value === null || value === undefined) return false
  if (depth > MAX_PAYLOAD_STRING_DEPTH) return true
  if (Array.isArray(value)) {
    return value.some((item) => exceedsPayloadDepth(item, depth + 1))
  }
  if (typeof value === "object") {
    return Object.values(value).some((v) => exceedsPayloadDepth(v, depth + 1))
  }
  return false
}

const collectStringLeaves = (
  value: unknown,
  target: Array<string>,
  depth = 0,
  excludedKeys?: ReadonlySet<string>,
): boolean => {
  if (value === null || value === undefined) return false
  if (depth > MAX_PAYLOAD_STRING_DEPTH) return true
  if (typeof value === "string") {
    pushNonEmpty(target, value)
    return false
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (collectStringLeaves(item, target, depth + 1, excludedKeys)) return true
    }
    return false
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (excludedKeys?.has(k) === true) {
        if (exceedsPayloadDepth(v, depth + 1)) return true
        continue
      }
      if (collectStringLeaves(v, target, depth + 1, excludedKeys)) return true
    }
  }
  return false
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
      const toolInput = value.tool_input
      const toolCallArgs = value.toolCall?.args

      const toolName = isAgStdin ? value.toolCall?.name : value.tool_name
      const isReadOnlyNamed = typeof toolName === "string" && READ_ONLY_TOOL_NAMES.has(toolName)
      const isFileFinderTool = typeof toolName === "string" && FILE_FINDER_TOOL_NAMES.has(toolName)
      const isGrepTool = typeof toolName === "string" && GREP_TOOL_NAMES.has(toolName)

      for (const key of COMMAND_FIELD_KEYS) {
        pushNonEmpty(candidateCmds, toolCallArgs?.[key])
        pushNonEmpty(candidateCmds, toolInput?.[key])
      }
      const baseDirs: Array<string> = []
      const childGlobs: Array<string> = []
      for (const key of BASE_PATH_FIELD_KEYS) {
        pushNonEmpty(baseDirs, toolCallArgs?.[key])
        pushNonEmpty(baseDirs, toolInput?.[key])
      }
      for (const baseDir of baseDirs) {
        pushNonEmpty(candidatePaths, baseDir)
      }
      if (isFileFinderTool) {
        for (const key of ["glob", "pattern", "Pattern", "Includes", "includes"] as const) {
          pushStringOrArray(childGlobs, toolCallArgs?.[key])
          pushStringOrArray(childGlobs, toolInput?.[key])
        }
      }
      if (isGrepTool) {
        for (const key of ["glob", "Includes", "includes"] as const) {
          pushStringOrArray(childGlobs, toolCallArgs?.[key])
          pushStringOrArray(childGlobs, toolInput?.[key])
        }
      }
      for (const childGlob of childGlobs) {
        pushNonEmpty(candidatePaths, childGlob)
      }
      let combinedCount = 0
      for (const baseDir of baseDirs) {
        for (const childGlob of childGlobs) {
          if (!childGlob.startsWith("/")) {
            if (combinedCount >= 64) {
              return {
                _tag: "Error" as const,
                isAntigravity,
                reason: "guard: hook stdin payload exceeded maximum glob expansion combinations",
                detail: "fastpath=glob-combination-overflow",
              }
            }
            pushNonEmpty(candidatePaths, joinPosixPair(baseDir, childGlob))
            combinedCount += 1
          }
        }
      }

      if (isReadOnlyNamed && candidateCmds.length === 0) {
        const excluded = isGrepTool ? GREP_EXCLUDED_KEYS : SEARCH_QUERY_EXCLUDED_KEYS
        const overflowed =
          collectStringLeaves(toolCallArgs, candidatePaths, 0, excluded) ||
          collectStringLeaves(toolInput, candidatePaths, 0, excluded)
        if (overflowed) {
          return {
            _tag: "Error" as const,
            isAntigravity,
            reason: "guard: hook stdin payload exceeded maximum inspection depth",
            detail: "fastpath=payload-depth-overflow",
          }
        }
      }

      if (candidateCmds.length === 0 && candidatePaths.length === 0) {
        if (isReadOnlyNamed) {
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
