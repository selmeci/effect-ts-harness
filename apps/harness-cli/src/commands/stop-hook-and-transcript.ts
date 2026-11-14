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
  "env",
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

const isReadOnlyShellCommand = (rawCommand: string): boolean => {
  const cleaned = rawCommand
    .replace(/\b2>\s*\/dev\/null\b/g, "")
    .replace(/\b2>&1\b/g, "")
    .replace(/\b1?>\s*\/dev\/null\b/g, "")
    .trim()
  if (cleaned.length === 0) return true
  if (/(?:^|[^<>])>>?(?![>&])/.test(cleaned)) {
    return false
  }
  const segments = cleaned
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.replace(/^[()\s]+|[()\s]+$/g, "").trim())
    .filter((s) => s.length > 0)
  if (segments.length === 0) return true

  return segments.every((seg) => {
    const withoutEnv = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "").trim()
    return READ_ONLY_SHELL_PREFIXES.some(
      (prefix) =>
        withoutEnv === prefix ||
        withoutEnv.startsWith(`${prefix} `) ||
        withoutEnv.startsWith(`${prefix}\t`),
    )
  })
}

const isMutatingTranscriptToolCall = (
  tc: Schema.Schema.Type<typeof TranscriptToolCallSchema>,
): boolean => {
  if (WRITE_TOOL_NAMES.has(tc.name)) {
    const targetFile =
      unwrapTranscriptStringArg(tc.args?.TargetFile) ||
      unwrapTranscriptStringArg(tc.args?.file_path)
    // Exempt planning, RFC, prompt, and Antigravity brain/scratch files so documentation-only
    // or planning turns do not count as code mutations for the stop-hook verification guard.
    if (
      targetFile.length > 0 &&
      (targetFile.includes("/.gemini/antigravity/brain/") ||
        targetFile.includes("/.gemini/antigravity/scratch/") ||
        targetFile.includes("/docs/rfcs/") ||
        targetFile.includes("/.harness/prompts/"))
    ) {
      return false
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
    return toolName === "mutate" || toolName === "load" || toolName.startsWith("branches_")
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

const isSuccessfulVerifyTranscriptStep = (
  step: Schema.Schema.Type<typeof TranscriptStepSchema>,
): boolean => {
  const content = step.content
  if (typeof content !== "string" || content.length === 0) return false
  return (
    content.includes("The command exited with code 0.") &&
    content.includes('"taskBranch":') &&
    /"treeHash"\s*:\s*"[0-9a-f]{64}"/.test(content)
  )
}

const parseTranscriptSteps = (
  decoded?: StopHookStdin,
): ReadonlyArray<Schema.Schema.Type<typeof TranscriptStepSchema>> => {
  if (!decoded?.transcriptPath || !nodeSyncHostIo.existsSync(decoded.transcriptPath)) {
    return []
  }
  const transcriptPath = decoded.transcriptPath
  const fullTranscriptPath = transcriptPath.replace(/transcript\.jsonl$/, "transcript_full.jsonl")
  const effectivePath =
    fullTranscriptPath !== transcriptPath && nodeSyncHostIo.existsSync(fullTranscriptPath)
      ? fullTranscriptPath
      : transcriptPath

  return Result.getOrElse(
    Result.try(() => {
      const lines = nodeSyncHostIo
        .readTextSync(effectivePath)
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
      const steps: Array<Schema.Schema.Type<typeof TranscriptStepSchema>> = []
      for (const line of lines) {
        const stepOpt = decodeTranscriptStep(line)
        match(stepOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            steps.push(value)
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
      }
      return steps
    }),
    () => [],
  )
}

export const isReadOnlyStopTurn = (decoded?: StopHookStdin): boolean => {
  const steps = parseTranscriptSteps(decoded)
  if (steps.length === 0) return false
  let lastUserExplicitIdx = -1
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.source === "USER_EXPLICIT") {
      lastUserExplicitIdx = i
    }
  }
  if (lastUserExplicitIdx === -1) return false
  let firstStopHookBlockIdx = -1
  for (let i = lastUserExplicitIdx + 1; i < steps.length; i++) {
    const content = steps[i]?.content
    if (typeof content === "string" && content.includes("Stop hook blocked termination:")) {
      firstStopHookBlockIdx = i
      break
    }
  }
  const endIdx = firstStopHookBlockIdx !== -1 ? firstStopHookBlockIdx : steps.length
  for (let i = lastUserExplicitIdx + 1; i < endIdx; i++) {
    const step = steps[i]
    if (!step?.tool_calls) continue
    for (const tc of step.tool_calls) {
      if (isMutatingTranscriptToolCall(tc)) {
        const targetFile =
          unwrapTranscriptStringArg(tc.args?.TargetFile) ||
          unwrapTranscriptStringArg(tc.args?.file_path)
        const isFileEdit =
          tc.name === "write_file" ||
          tc.name === "edit_file" ||
          tc.name === "replace_file_content" ||
          tc.name === "multi_replace_file_content" ||
          tc.name === "write_to_file" ||
          tc.name === "Edit" ||
          tc.name === "Write"
        if (
          isFileEdit &&
          (targetFile.includes("/docs/rfcs/") || targetFile.includes("/.harness/prompts/"))
        ) {
          continue
        }
        return false
      }
    }
  }
  return true
}

export const hasVerifiedSinceLastMutation = (decoded?: StopHookStdin): boolean => {
  const steps = parseTranscriptSteps(decoded)
  if (steps.length === 0) return false
  let lastUserExplicitIdx = -1
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.source === "USER_EXPLICIT") {
      lastUserExplicitIdx = i
    }
  }
  if (lastUserExplicitIdx === -1) return false
  let lastMutatingIdx = -1
  let lastVerifySuccessIdx = -1
  for (let i = lastUserExplicitIdx + 1; i < steps.length; i++) {
    const step = steps[i]
    if (!step) continue
    if (isSuccessfulVerifyTranscriptStep(step)) {
      lastVerifySuccessIdx = i
    }
    if (step.tool_calls) {
      for (const tc of step.tool_calls) {
        if (isMutatingTranscriptToolCall(tc)) {
          lastMutatingIdx = i
        }
      }
    }
  }
  return lastVerifySuccessIdx !== -1 && lastVerifySuccessIdx > lastMutatingIdx
}

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
    const transcriptPath = decoded.transcriptPath
    const isSubagentTranscript = Result.getOrElse(
      Result.try({
        try: () => {
          const lines = nodeSyncHostIo
            .readTextSync(transcriptPath)
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
          const firstLine = lines[0]
          if (firstLine === undefined) {
            return false
          }
          const firstStepOpt = decodeTranscriptStep(firstLine)
          const isSystemMessage = match(firstStepOpt)
            .with(
              { _tag: "Some" },
              ({ value }) => value.source === "SYSTEM" && Boolean(value.content?.includes("[Message]")),
            )
            .with({ _tag: "None" }, () => false)
            .exhaustive()
          if (!isSystemMessage) {
            return false
          }
          for (const line of lines) {
            const stepOpt = decodeTranscriptStep(line)
            const isUserExplicit = match(stepOpt)
              .with({ _tag: "Some" }, ({ value }) => value.source === "USER_EXPLICIT")
              .with({ _tag: "None" }, () => false)
              .exhaustive()
            if (isUserExplicit) {
              return false
            }
          }
          return true
        },
        catch: (err) => {
          process.stderr.write(
            `[harness] Warning: failed to inspect transcript at ${transcriptPath}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          )
          return false
        },
      }),
      () => false,
    )
    if (isSubagentTranscript) {
      return true
    }
  }
  return false
}
