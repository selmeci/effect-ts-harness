import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AgentMaxTurns,
  ExecutableName,
  MaxConcurrency,
  ModelName,
  PermissionRule,
  type RunnerId,
  RunnerProfile,
  TimeoutMillis,
  WORKFLOW_TIMEOUT_BUDGETS,
} from "@harness/contract"
import { match } from "ts-pattern"

/**
 * Human-reviewed TCB runner profiles (`SPEC-0036` / `RFC-0013 REQ-4.1`).
 * Defines the closed capability boundaries and argv builders for `claude-code` and `antigravity`.
 */
export const CLAUDE_CODE_RUNNER_PROFILE: RunnerProfile = RunnerProfile.make({
  runner: "claude-code",
  binary: ExecutableName.make("claude"),
  permissionRules: [
    PermissionRule.make("Read"),
    PermissionRule.make("Edit"),
    PermissionRule.make("Write"),
    PermissionRule.make("MultiEdit"),
    PermissionRule.make("Glob"),
    PermissionRule.make("Grep"),
    PermissionRule.make("Bash"),
  ],
  disallowedTools: [
    PermissionRule.make("Bash(pnpm harness done*)"),
    PermissionRule.make("Bash(pnpm harness workflow start*)"),
    PermissionRule.make("Bash(pnpm harness workflow resume*)"),
    PermissionRule.make("Bash(pnpm harness workflow ship*)"),
    PermissionRule.make("Bash(pnpm harness workflow abort*)"),
    PermissionRule.make("Bash(pnpm harness workflow doctor*)"),
    PermissionRule.make("Bash(alchemy deploy*)"),
    PermissionRule.make("Bash(alchemy destroy*)"),
    PermissionRule.make("Bash(rm -rf*)"),
  ],
  maxConcurrency: MaxConcurrency.make(4),
  timeoutMillis: TimeoutMillis.make(WORKFLOW_TIMEOUT_BUDGETS.agentRunClaudeMs),
  maxTurns: AgentMaxTurns.make(40),
  model: ModelName.make("claude-sonnet-4-6"),
})

export const ANTIGRAVITY_RUNNER_PROFILE: RunnerProfile = RunnerProfile.make({
  runner: "antigravity",
  binary: ExecutableName.make("agy"),
  permissionRules: [PermissionRule.make("accept-edits")],
  disallowedTools: [],
  maxConcurrency: MaxConcurrency.make(2),
  timeoutMillis: TimeoutMillis.make(WORKFLOW_TIMEOUT_BUDGETS.agentRunAntigravityMs),
  model: ModelName.make("gemini-4-hydrogen-high"),
  antigravityMode: "accept-edits",
})

export const RUNNER_PROFILES: Record<RunnerId, RunnerProfile> = {
  "claude-code": CLAUDE_CODE_RUNNER_PROFILE,
  antigravity: ANTIGRAVITY_RUNNER_PROFILE,
}

/** Input for building total, `--dangerously-skip-permissions`-free `claude -p` argv. */
export interface BuildClaudeCodeArgvInput {
  readonly profile: RunnerProfile
  readonly promptText: string
  readonly mcpConfigPath: string
  readonly hooksSettingsPath: string
}

/** Input for building total, `--dangerously-skip-permissions`-free `agy -p` argv. */
export interface BuildAntigravityArgvInput {
  readonly profile: RunnerProfile
  readonly promptText: string
}

const CLAUDE_PRE_TOOL_USE_HOOK_TIMEOUT_SECONDS = 15

const CLAUDE_HOOK_PRE_TOOL_USE_MATCHERS: ReadonlyArray<string> = [
  "Bash",
  "Edit|Write|MultiEdit",
  "Read|Grep|Glob|LS|Find",
]

const BASE_RUNNER_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "NODE_OPTIONS",
  "PNPM_HOME",
  "COREPACK_HOME",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "NO_COLOR",
  "CI",
]

const CLAUDE_CODE_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]

/** Resolves the static TCB `RunnerProfile` for a closed `RunnerId`. */
const getRunnerProfile = (runner: RunnerId): RunnerProfile =>
  match(runner)
    .with("claude-code", () => CLAUDE_CODE_RUNNER_PROFILE)
    .with("antigravity", () => ANTIGRAVITY_RUNNER_PROFILE)
    .exhaustive()

/** Pure total argv builder for `claude -p` (`REQ-4.1`, `REQ-4.2`). */
const buildClaudeCodeArgv = (input: BuildClaudeCodeArgvInput): ReadonlyArray<string> => {
  const argv: Array<string> = [
    "-p",
    input.promptText,
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfigPath,
    "--setting-sources",
    "",
    "--settings",
    input.hooksSettingsPath,
  ]
  if (input.profile.permissionRules.length > 0) {
    argv.push("--allowedTools", input.profile.permissionRules.join(","))
  }
  if (input.profile.disallowedTools.length > 0) {
    argv.push("--disallowedTools", input.profile.disallowedTools.join(","))
  }
  argv.push("--permission-mode", "dontAsk")
  if (input.profile.maxTurns !== undefined) {
    argv.push("--max-turns", String(input.profile.maxTurns))
  }
  if (input.profile.model !== undefined) {
    argv.push("--model", input.profile.model)
  }
  return argv
}

/** Pure total argv builder for `agy -p` (`REQ-4.1`, `REQ-4.3`). */
const buildAntigravityArgv = (input: BuildAntigravityArgvInput): ReadonlyArray<string> => {
  const timeoutSeconds = Math.max(1, Math.ceil(input.profile.timeoutMillis / 1000))
  const argv: Array<string> = [
    "-p",
    input.promptText,
    "--output-format",
    "json",
    "--print-timeout",
    `${timeoutSeconds}s`,
  ]
  if (input.profile.model !== undefined) {
    argv.push("--model", input.profile.model)
  }
  if (input.profile.antigravityMode !== undefined) {
    argv.push("--mode", input.profile.antigravityMode)
  }
  return argv
}

const quoteShellArg = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Resolves the harness installation root directory from this module's location. */
const resolveHarnessInstallationRoot = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..")

/** Generates the scoped `PreToolUse`-only Claude hooks JSON (never `Stop`, `SessionStart`, or `PostToolUse`). */
const buildClaudeHooksSettingsJson = (harnessRoot?: string): string => {
  const root = harnessRoot ?? resolveHarnessInstallationRoot()
  const resolverArg = quoteShellArg(`${root}/tools/node-ts-resolver.mjs`)
  const hookEntryArg = quoteShellArg(`${root}/apps/harness-cli/src/hook-entry.ts`)
  const command = `node --import ${resolverArg} ${hookEntryArg} guard || exit 2`
  return JSON.stringify({
    hooks: {
      PreToolUse: CLAUDE_HOOK_PRE_TOOL_USE_MATCHERS.map((matcher) => ({
        matcher,
        hooks: [
          {
            type: "command",
            command,
            timeout: CLAUDE_PRE_TOOL_USE_HOOK_TIMEOUT_SECONDS,
          },
        ],
      })),
    },
  })
}

/** Generates scoped MCP server config JSON (`{"mcpServers":{}}` when isolated, or `harness-mcp` entry when provided). */
const buildClaudeMcpConfigJson = (harnessMcpEntryPath?: string, harnessRoot?: string): string => {
  if (harnessMcpEntryPath === undefined || harnessMcpEntryPath.trim().length === 0) {
    return JSON.stringify({ mcpServers: {} })
  }
  const root = harnessRoot ?? resolveHarnessInstallationRoot()
  return JSON.stringify({
    mcpServers: {
      "harness-mcp": {
        command: "node",
        args: ["--import", `${root}/tools/node-ts-resolver.mjs`, harnessMcpEntryPath],
      },
    },
  })
}

/** Builds allow-listed subprocess env with `HARNESS_UNIT_WORKER=1`, no `CLOUDFLARE_*`/Omnigraph tokens, and stripped `ANTIGRAVITY_*`/`AGY_*`. */
const buildRunnerEnv = (
  runner: RunnerId,
  parentEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => {
  const extraKeys = match(runner)
    .with("claude-code", () => CLAUDE_CODE_ENV_ALLOWLIST)
    .with("antigravity", () => [] as const)
    .exhaustive()
  const env: Record<string, string | undefined> = {}
  for (const key of [...BASE_RUNNER_ENV_ALLOWLIST, ...extraKeys]) {
    const value = parentEnv[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  env["HARNESS_UNIT_WORKER"] = "1"
  return env
}

export {
  buildAntigravityArgv,
  buildClaudeCodeArgv,
  buildClaudeHooksSettingsJson,
  buildClaudeMcpConfigJson,
  buildRunnerEnv,
  getRunnerProfile,
  resolveHarnessInstallationRoot,
}
