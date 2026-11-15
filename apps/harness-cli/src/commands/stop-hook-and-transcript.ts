import { posix } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"

export const StopHookStdinSchema = Schema.Struct({
  fullyIdle: Schema.optional(Schema.Boolean),
  conversationId: Schema.optional(Schema.String),
  workspacePaths: Schema.optional(Schema.Array(Schema.String)),
  transcriptPath: Schema.optional(Schema.String),
})

export const decodeStopHookStdin = Schema.decodeOption(Schema.fromJsonString(StopHookStdinSchema))

export type StopHookStdin = Schema.Schema.Type<typeof StopHookStdinSchema>

const TranscriptToolCallSchema = Schema.Struct({
  name: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const TranscriptStepSchema = Schema.Struct({
  source: Schema.String,
  content: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Array(TranscriptToolCallSchema)),
})

const decodeTranscriptStep = Schema.decodeOption(Schema.fromJsonString(TranscriptStepSchema))

const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
])

const READ_ONLY_SHELL_PREFIXES = [
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "wc",
  "pwd",
  "echo",
  "which",
  "type",
  "stat",
  "file",
  "du",
  "df",
  "ps",
  "printenv",
  "true",
  "false",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git remote",
  "git config --get",
  "git config --list",
]

const unwrapTranscriptStringArg = (val: unknown): string => {
  if (typeof val !== "string") return ""
  const trimmed = val.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  return trimmed
}

const SAFE_ENV_ASSIGNMENT_RE = /^(?:CI|NO_COLOR|FORCE_COLOR|TZ|LC_ALL|LANG)=[A-Za-z0-9_.:/-]+$/

const FIND_MUTATING_FLAGS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
])

const GIT_BRANCH_READONLY_FLAG_RE =
  /^(?:--list|-l|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--no-color|--color(?:=[a-z]+)?)$/

const tokenizeAndUnquoteShellSegment = (segment: string): ReadonlyArray<string> | undefined => {
  const tokens: Array<string> = []
  let current = ""
  let hasToken = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ""
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (quote !== null) {
    return undefined
  }
  if (hasToken) {
    tokens.push(current)
  }
  return tokens
}

const stripSafeLeadingEnvAssignments = (segment: string): string => {
  let rest = segment.trim()
  while (true) {
    const m = /^([^\s]+)\s+([\s\S]+)$/.exec(rest)
    if (!m || !SAFE_ENV_ASSIGNMENT_RE.test(m[1]!)) {
      return rest
    }
    rest = m[2]!.trim()
  }
}

const hasDisallowedReadOnlyFlags = (tokens: ReadonlyArray<string>): boolean => {
  const cmd = tokens[0]
  if (cmd === "find") {
    return tokens.slice(1).some((t) => FIND_MUTATING_FLAGS.has(t))
  }
  if (cmd === "rg") {
    return tokens
      .slice(1)
      .some((t) => t === "--pre" || t.startsWith("--pre=") || t === "--pre-glob" || t.startsWith("--pre-glob="))
  }
  if (cmd === "git") {
    const sub = tokens[1]
    if (sub === "branch") {
      return tokens.slice(2).some((t) => !GIT_BRANCH_READONLY_FLAG_RE.test(t))
    }
    if (sub === "remote") {
      if (tokens.length === 2) return false
      if (tokens.length === 3 && (tokens[2] === "-v" || tokens[2] === "--verbose")) return false
      if (tokens.length >= 3 && tokens[2] === "get-url") return false
      return true
    }
    if (sub === "diff" || sub === "log" || sub === "show" || sub === "status") {
      return tokens
        .slice(2)
        .some((t) => t === "--output" || t.startsWith("--output=") || t === "--ext-diff")
    }
  }
  return false
}

const isReadOnlyShellCommand = (rawCommand: string): boolean => {
  if (/(\$\(|`|<\(|>\(|\r|\n)/.test(rawCommand)) {
    return false
  }
  const cleaned = rawCommand
    .replace(/\b2>\s*\/dev\/null\b/g, "")
    .replace(/\b2>&1\b/g, "")
    .replace(/\b1?>\s*\/dev\/null\b/g, "")
    .trim()
  if (cleaned.length === 0) return true
  if (/(?:^|[^&])&(?:[^&]|$)|&&&/.test(cleaned) || /[<>]/.test(cleaned)) {
    return false
  }
  const segments = cleaned
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.replace(/^[()\s]+|[()\s]+$/g, "").trim())
    .filter((s) => s.length > 0)
  if (segments.length === 0) return true

  return segments.every((seg) => {
    const withoutEnv = stripSafeLeadingEnvAssignments(seg)
    if (withoutEnv.includes("$") || withoutEnv.includes("\\")) {
      return false
    }
    const rawTokens = tokenizeAndUnquoteShellSegment(withoutEnv)
    if (rawTokens === undefined || rawTokens.length === 0) {
      return false
    }
    if (rawTokens[0] === "git" && rawTokens[1]?.startsWith("-") && rawTokens[1] !== "--no-pager") {
      return false
    }
    const tokens =
      rawTokens[0] === "git" && rawTokens[1] === "--no-pager"
        ? [rawTokens[0], ...rawTokens.slice(2)]
        : rawTokens
    const normalizedCmd = tokens.join(" ")
    const matchesPrefix = READ_ONLY_SHELL_PREFIXES.some(
      (prefix) => normalizedCmd === prefix || normalizedCmd.startsWith(`${prefix} `),
    )
    if (!matchesPrefix) return false
    return !hasDisallowedReadOnlyFlags(tokens)
  })
}

const isMutatingTranscriptToolCall = (
  tc: Schema.Schema.Type<typeof TranscriptToolCallSchema>,
): boolean => {
  if (WRITE_TOOL_NAMES.has(tc.name)) {
    const targetFile =
      unwrapTranscriptStringArg(tc.args?.TargetFile) ||
      unwrapTranscriptStringArg(tc.args?.file_path)
    if (targetFile.length > 0) {
      const normalized = posix.normalize(targetFile.replace(/\\/g, "/"))
      if (normalized.startsWith("/") && normalized.includes("/.gemini/antigravity/brain/")) {
        return false
      }
    }
    return true
  }
  if (tc.name === "run_command" || tc.name === "Bash") {
    const cmd =
      unwrapTranscriptStringArg(tc.args?.CommandLine) || unwrapTranscriptStringArg(tc.args?.command)
    return !isReadOnlyShellCommand(cmd)
  }
  if (tc.name === "call_mcp_tool") {
    const toolName = unwrapTranscriptStringArg(tc.args?.ToolName)
    return (
      toolName === "mutate" ||
      toolName === "load" ||
      toolName === "harness_graph_rewrite" ||
      toolName.startsWith("branches_")
    )
  }
  if (tc.name === "invoke_subagent" || tc.name === "Task") {
    const isReadOnlySubagentType = (typeName: string): boolean => {
      const normalized = typeName.trim().toLowerCase()
      return (
        normalized === "research" || normalized === "explore" || normalized.endsWith("-reviewer")
      )
    }
    const subagentTypeArg = unwrapTranscriptStringArg(tc.args?.subagent_type)
    if (subagentTypeArg.length > 0 && isReadOnlySubagentType(subagentTypeArg)) {
      return false
    }
    const rawSubagents = tc.args?.Subagents
    if (typeof rawSubagents === "string") {
      const unescaped = unwrapTranscriptStringArg(rawSubagents)
      const typeMatches = Array.from(unescaped.matchAll(/"TypeName"\s*:\s*"([^"]+)"/g))
      if (typeMatches.length > 0 && typeMatches.every((m) => isReadOnlySubagentType(m[1] ?? ""))) {
        return false
      }
    } else {
      if (Array.isArray(rawSubagents) && rawSubagents.length > 0) {
        const allReadOnly = rawSubagents.every(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "TypeName" in item &&
            typeof item.TypeName === "string" &&
            isReadOnlySubagentType(item.TypeName),
        )
        if (allReadOnly) {
          return false
        }
      }
    }
    return true
  }
  return false
}

type ParseTranscriptStepsResult =
  | {
      readonly _tag: "Ok"
      readonly steps: ReadonlyArray<Schema.Schema.Type<typeof TranscriptStepSchema>>
    }
  | { readonly _tag: "Corrupt"; readonly reason: string }

const parseTranscriptSteps = (decoded?: StopHookStdin): ParseTranscriptStepsResult => {
  if (!decoded?.transcriptPath || !nodeSyncHostIo.existsSync(decoded.transcriptPath)) {
    return { _tag: "Ok", steps: [] }
  }
  const transcriptPath = decoded.transcriptPath
  const fullTranscriptPath = transcriptPath.replace(/transcript\.jsonl$/, "transcript_full.jsonl")
  const effectivePath =
    fullTranscriptPath !== transcriptPath && nodeSyncHostIo.existsSync(fullTranscriptPath)
      ? fullTranscriptPath
      : transcriptPath

  return Result.getOrElse(
    Result.try({
      try: (): ParseTranscriptStepsResult => {
        const lines = nodeSyncHostIo
          .readTextSync(effectivePath)
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
        const steps: Array<Schema.Schema.Type<typeof TranscriptStepSchema>> = []
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          const stepOpt = decodeTranscriptStep(line)
          const parsedStep = match(stepOpt)
            .with({ _tag: "Some" }, ({ value }) => value)
            .with({ _tag: "None" }, () => undefined)
            .exhaustive()
          if (parsedStep === undefined) {
            return {
              _tag: "Corrupt",
              reason: `Corrupt transcript JSONL line ${i + 1} in ${effectivePath}`,
            }
          }
          steps.push(parsedStep)
        }
        return { _tag: "Ok", steps }
      },
      catch: (err): ParseTranscriptStepsResult => ({
        _tag: "Corrupt",
        reason: `Failed to read transcript ${effectivePath}: ${err instanceof Error ? err.message : String(err)}`,
      }),
    }),
    (): ParseTranscriptStepsResult => ({
      _tag: "Corrupt",
      reason: `Failed to read transcript ${effectivePath}`,
    }),
  )
}

export const isReadOnlyStopTurn = (decoded?: StopHookStdin): boolean =>
  match(parseTranscriptSteps(decoded))
    .with({ _tag: "Corrupt" }, () => false)
    .with({ _tag: "Ok" }, ({ steps }) => {
      if (steps.length === 0) return false
      let lastUserExplicitIdx = -1
      for (let i = 0; i < steps.length; i++) {
        if (steps[i]?.source === "USER_EXPLICIT") {
          lastUserExplicitIdx = i
        }
      }
      if (lastUserExplicitIdx === -1) return false
      for (let i = lastUserExplicitIdx + 1; i < steps.length; i++) {
        const step = steps[i]
        if (!step?.tool_calls) continue
        for (const tc of step.tool_calls) {
          if (isMutatingTranscriptToolCall(tc)) {
            return false
          }
        }
      }
      return true
    })
    .exhaustive()

export const isSubagentStopContext = (repoRoot: string, decoded?: StopHookStdin): boolean => {
  if (
    process.env.HARNESS_SUBAGENT === "1" ||
    repoRoot.includes("/.gemini/antigravity/worktrees/") ||
    repoRoot.includes("/subagent-")
  ) {
    return true
  }
  if (
    decoded?.workspacePaths?.some(
      (p) => p.includes("/.gemini/antigravity/worktrees/") || p.includes("/subagent-"),
    )
  ) {
    return true
  }
  if (decoded?.transcriptPath && nodeSyncHostIo.existsSync(decoded.transcriptPath)) {
    const isSubagentTranscript = match(parseTranscriptSteps({ transcriptPath: decoded.transcriptPath }))
      .with({ _tag: "Corrupt" }, () => false)
      .with({ _tag: "Ok" }, ({ steps }) => {
        const first = steps[0]
        if (!first || first.source !== "SYSTEM" || !first.content?.includes("[Message]")) {
          return false
        }
        return !steps.some((step) => step.source === "USER_EXPLICIT")
      })
      .exhaustive()
    if (isSubagentTranscript) {
      return true
    }
  }
  return false
}
