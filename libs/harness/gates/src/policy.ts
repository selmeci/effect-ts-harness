/** Deterministic guard policy. `classifyCommand` never calls the decision model:
 * "escalate" means "deterministic rules left this open" (mvp.md, safety guard row);
 * "ask" means "always confirm with the human first" (alchemy deploy/destroy/profile,
 * matching Alchemy's own advice to confirm every deploy). */

import * as path from "node:path"
import {
  PROTECTED_HARNESS_FILE_WRITE_PATTERN,
  isHarnessStateAccessCommand,
  isHarnessStateMutationCommand,
} from "./policy-harness-state.js"
import {
  extractCommandSegments,
  hasUnquotedBackgroundOperator,
  normalizeShellLineContinuations,
  toCommandView,
  type CommandView,
  type UnwrappedSegment,
} from "./policy-shell-parser.js"

export { isHarnessStateMutationCommand, toCommandView, type CommandView }

export type GuardVerdict = "allow" | "deny" | "ask" | "escalate"

export const ALLOWLIST: ReadonlyArray<string> = [
  "nx ",
  "pnpm test",
  "pnpm nx ",
  "pnpm verify",
  "pnpm harness",
  "pnpm run harness",
  "pnpm lint",
  "pnpm oxlint",
  "pnpm format",
  "pnpm format:check",
  "pnpm oxfmt",
  "pnpm build",
  "CI=true pnpm nx ",
  "CI=true pnpm test",
  "CI=true pnpm verify",
  "CI=true pnpm harness",
  "CI=true pnpm format",
  "CI=true pnpm format:check",
  "CI=true pnpm oxfmt",
  "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts",
  "node --import ./tools/node-ts-resolver.mjs apps/harness-mcp/src/server.ts",
  "git status",
  "git diff",
  "git log",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "git checkout",
  "git switch",
  "git add",
  "git restore --staged",
  "git commit",
  "git merge",
  "git fetch",
  "git push",
  "git show",
  "git stash",
  "git grep",
  "gh pr view",
  "gh pr list",
  "gh pr status",
  "gh pr diff",
  "gh pr checks",
  "gh pr create",
  "gh pr edit",
  "gh pr comment",
  "gh repo view",
  "gh auth status",
  "gh api repos/",
  "gh issue view",
  "gh issue list",
  "gh issue status",
  "ls",
  "dir",
  "pwd",
  "which",
  "find",
  "cat",
  "head",
  "tail",
  "wc",
  "tree",
  "pnpm --filter ",
  "pnpm install",
  "pnpm vitest",
  "vitest",
  "git remote",
  "grep",
  "rg",
  "diff",
  "sort",
  "omnigraph ",
  "omnigraph-server",
]

export const DENYLIST: ReadonlyArray<{ readonly token: string; readonly reason: string }> = [
  { token: "rm -rf", reason: "destructive delete" },
  { token: "push --force", reason: "force push" },
  { token: "push -f", reason: "force push" },
]

/** Human confirmation required, never auto-approved (mvp.md "Infrastructure as Effect",
 * safety guard row). Substring match, so `pnpm alchemy deploy` is covered too. */
export const ASKLIST: ReadonlyArray<string> = [
  "alchemy deploy",
  "alchemy destroy",
  "alchemy profile",
]

export const SHELL_OPERATORS: ReadonlyArray<string> = ["&&", "||", ";", "|", "\n"]

/** A guard rule matched by regex instead of substring (harness:SPEC-0001). */
export interface GuardPatternRule {
  readonly pattern: RegExp
  readonly reason: string
}

/** REQ-3.1: a dotenv file, mutation-hmac key, `.cache/effect-harness` state/key path, or
 * wildcard `*.key` token referenced as a path token, including multi-dot names
 * (`.env.development.local`), globs/character classes/braces (`.env*`, `mutation-hmac*.key`,
 * `mutation-hmac-v[0-9].key`, `mutation-hmac-{v1,v2}.key`, `*.key`). It does not match
 * identifiers (`process.env`, `import.meta.env`), plugin dirs (`plugins/effect-harness`),
 * or templates (`.env.example`, `.env.template`, `.env.sample`) — REQ-3.2.
 * Evaluated on `CommandView.argv`. */
export const SECRET_FILE_PATTERN: RegExp =
  /(?:^|[\s=:/<>(])(?:\.env(?:\.(?!(?:example|template|sample)(?:$|[\s/]))[\w*?-]+)*\*?|mutation-hmac[^\s;|&)<>]*(?:\.key|\*|\?|\]|\})|[^\s;|&)<>]*\.cache\/effect-harness(?:\/[^\s;|&)<>]*)?|[^\s=:/<>()]*(?:\*|\?|\[[^\]\s]+\]|\{[^}\s]+\})[^\s;|&)<>]*\.key|(?:[^\s;|&)<>]*\/)?auth-tokens\.json)(?=$|[\s/;|&)<>])/

/** REQ-2.1: the agent must not use the guard as an oracle to test candidate commands.
 * Hooks invoke the guard directly from the IDE, never through an agent shell command.
 * Flags (and flag values such as `--cwd /tmp`) or `--` before `guard` are tolerated. */
export const GUARD_SELF_INVOCATION_PATTERN: RegExp =
  /(?:(?:^|\s)harness|harness-cli\/src\/(?:index|hook-entry)\.ts)(?:\s+(?:--(?=\s|$)|-\S+(?:\s+(?!guard\b)[^\s;|&)<>]+)?))*\s+guard\b/

/** REQ-1.2: git commands that irreversibly discard work. Always a human decision —
 * clef rated `git checkout -- .` only destructive=0.26 (would auto-allow). */
export const GIT_DISCARD_PATTERNS: ReadonlyArray<GuardPatternRule> = [
  {
    pattern: /\bgit\s+checkout\s+(?:\S+\s+)*(?:--|\.\/?|-f|--force)(?:\s|$)/,
    reason: "git checkout discarding working-tree changes",
  },
  {
    pattern: /\bgit\s+restore\s+(?!.*--staged\b)(?:\S+\s+)*(?:--|\.\/?|-f|--force)(?:\s|$)/,
    reason: "git restore discarding changes",
  },
  { pattern: /\bgit\s+stash\s+(?:drop|clear)\b/, reason: "git stash drop/clear" },
  {
    pattern: /\bgit\s+branch\s+(?:\S+\s+)*(?:-[Dd]|--delete)(?:\s|$)/,
    reason: "git branch deletion",
  },
  { pattern: /\bgit\s+clean\b/, reason: "git clean removing untracked files" },
  {
    pattern: /\bgit\s+switch\s+(?:\S+\s+)*(?:--discard-changes|-f|--force)(?:\s|$)/,
    reason: "git switch discarding changes",
  },
  { pattern: /\bgit\s+reset\s+(?:\S+\s+)*--hard\b/, reason: "git reset --hard" },
  {
    pattern: /\bgit\s+push\s+(?:\S+\s+)*(?:--delete|-d)(?:\s|$)/,
    reason: "git push deleting remote ref",
  },
]

/** REQ-1.1 / REQ-1.4: find actions that delete or execute, and mutating flags on gh api.
 * Evaluated on `CommandView.argv`, so quoted flags (`'-delete'`, `'-X' 'DELETE'`) are caught.
 * Checked BEFORE the prefix allowlist. */
export const DESTRUCTIVE_ARGUMENT_PATTERNS: ReadonlyArray<GuardPatternRule> = [
  {
    pattern: /\bfind\b.*\s-(?:delete|exec|execdir|ok|okdir)\b/,
    reason: "find action that deletes or executes",
  },
  {
    pattern:
      /\bgh\s+api\b.*(?:\s-(?:X|f|F)[A-Za-z0-9_=-]*|\s--(?:method|field|raw-field|input)(?:=|\s|$))/,
    reason: "gh api mutating request method or body field",
  },
  {
    pattern: /\bomnigraph\s+cleanup\b.*--keep(?:=|\s+)0(?:\s|$)/,
    reason: "omnigraph cleanup with --keep 0 deletes all history",
  },
  {
    pattern: /\bomnigraph\s+branches\s+delete\s+main(?:\s|$)/,
    reason: "omnigraph branches delete main destroys the main branch",
  },
  {
    pattern: /\bomnigraph\s+cluster\s+(?:reset|destroy|rm)(?:\s|$)/,
    reason: "omnigraph cluster reset/destroy/rm destroys cluster state",
  },
]

/** REQ-1.3: `>`, `>>`, `N>`, `&>`, `&>>`, `>& file` into a file. Not stream duplication
 * (`2>&1`, `>&2`), not `/dev/null`, not `=>` / `->`. Evaluated on `CommandView.unquoted`. */
export const FILE_REDIRECTION_PATTERN: RegExp =
  /(?:&>>?|(?<![=&>-])\d*>>?(?![&>])|(?<![=&>-])\d*>&(?![\d-]))\s*(?!\/dev\/null(?:\s|$))\S/

/** REQ-3.3: a word or path split by a character-class glob (`[e]nv`, `v[0-9]`, `[.]env`)
 * or by empty quotes (`r''m`, `.''env`) — the forms used to slip past substring rules.
 * Evaluated on the raw command. */
export const OBFUSCATION_PATTERNS: ReadonlyArray<GuardPatternRule> = [
  {
    pattern: /\[[^\]\s]\](?=[\w./*'"-])|(?<=[\w./*'"-])\[[^\]\s]\]/,
    reason: "character-class glob inside a word or path",
  },
  { pattern: /(?<=[\w./*\]-])(?:''|"")(?=[\w./*[-])/, reason: "empty quotes inside a word" },
]

const BRACKET_CLASS_GLOBAL_PATTERN: RegExp = /\[[^\]\s]+\]/g
const BRACKET_ADJACENT_CHAR_PATTERN: RegExp = /[\w./*'"-]/

const hasUnquotedAdjacentBracketGlob = (norm: string, unquoted: string): boolean => {
  BRACKET_CLASS_GLOBAL_PATTERN.lastIndex = 0
  let m = BRACKET_CLASS_GLOBAL_PATTERN.exec(unquoted)
  while (m !== null) {
    const start = m.index
    const end = start + m[0].length
    const prev = start > 0 ? norm[start - 1]! : ""
    const next = end < norm.length ? norm[end]! : ""
    if (BRACKET_ADJACENT_CHAR_PATTERN.test(prev) || BRACKET_ADJACENT_CHAR_PATTERN.test(next)) {
      return true
    }
    m = BRACKET_CLASS_GLOBAL_PATTERN.exec(unquoted)
  }
  return false
}

const splitByUnquotedOperator = (
  command: string,
  unquoted: string,
  op: string,
): ReadonlyArray<{ readonly cmd: string; readonly unquoted: string }> => {
  const parts: Array<{ readonly cmd: string; readonly unquoted: string }> = []
  let start = 0
  let idx = unquoted.indexOf(op, start)
  while (idx !== -1) {
    parts.push({
      cmd: command.slice(start, idx).trim(),
      unquoted: unquoted.slice(start, idx).trim(),
    })
    start = idx + op.length
    idx = unquoted.indexOf(op, start)
  }
  parts.push({
    cmd: command.slice(start).trim(),
    unquoted: unquoted.slice(start).trim(),
  })
  return parts
}

const containsToken = (command: string, token: string): boolean =>
  command.toLowerCase().includes(token.toLowerCase())

const matchesAny = (command: string, rules: ReadonlyArray<GuardPatternRule>): boolean =>
  rules.some((rule) => rule.pattern.test(command))

const MAX_LEADING_ENV_VARS = 32
const MAX_CLASSIFY_COMMAND_LENGTH = 65_536

const SAFE_ENV_PATH_PATTERN = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const UNSAFE_ENV_PATH_PATTERN =
  /\.\.|\/\.env|\/\.git(?:\/|$)|\/\.harness|secret|\/repos\/(?:effect|alchemy)(?:\/|$)|\/tools\/|\/adapters\//i
const SAFE_TEMP_PATH_VALIDATOR = (value: string): boolean =>
  SAFE_ENV_PATH_PATTERN.test(value) && !UNSAFE_ENV_PATH_PATTERN.test(value)

const SAFE_LEADING_ENV_VALIDATORS: Readonly<Record<string, (value: string) => boolean>> = {
  CI: (v) => /^(?:true|false|0|1)$/.test(v),
  NX_INTERACTIVE: (v) => /^(?:true|false|0|1)$/.test(v),
  NX_DAEMON: (v) => /^(?:true|false|0|1)$/.test(v),
  FORCE_COLOR: (v) => /^[0-3]$/.test(v),
  NO_COLOR: (v) => /^[01]$/.test(v),
  HARNESS_PLAN_CHECK: (v) => /^(?:0|1|true|false)$/.test(v),
  HARNESS_REQUIRE_OLLAMA: (v) => /^[01]$/.test(v),
  HARNESS_LOG_LEVEL: (v) => /^(?:debug|info|warn|error)$/.test(v),
  HARNESS_WORKTREE_ID: (v) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v),
  TMPDIR: SAFE_TEMP_PATH_VALIDATOR,
  NX_SOCKET_DIR: SAFE_TEMP_PATH_VALIDATOR,
  NODE_COMPILE_CACHE: SAFE_TEMP_PATH_VALIDATOR,
}

const isSafeLeadingEnvAssignment = (name: string, value: string): boolean => {
  if (/[\s;|&]/.test(value)) return false
  if (!Object.hasOwn(SAFE_LEADING_ENV_VALIDATORS, name)) return false
  return SAFE_LEADING_ENV_VALIDATORS[name]!(value)
}

const LEADING_ENV_TOKEN_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)=([^\s;|&]+)(?=\s|$)/y
const WORKTREE_ID_BLOCKED_HARNESS_PATTERN =
  /^pnpm\s+(?:run\s+)?harness\b|^CI=true\s+pnpm\s+harness\b|^node\b.*apps\/harness-cli\/src\//

interface StripLeadingEnvResult {
  readonly rest: string
  readonly sawWorktreeId: boolean
}

const stripSafeLeadingEnvVarsDetailed = (command: string): StripLeadingEnvResult => {
  const len = command.length
  let pos = 0
  let count = 0
  let sawWorktreeId = false
  while (count < MAX_LEADING_ENV_VARS) {
    while (pos < len && /\s/.test(command[pos]!)) {
      pos++
    }
    if (pos >= len) {
      return { rest: "", sawWorktreeId }
    }
    LEADING_ENV_TOKEN_PATTERN.lastIndex = pos
    const match = LEADING_ENV_TOKEN_PATTERN.exec(command)
    if (match === null) {
      break
    }
    const name = match[1]!
    const value = match[2]!
    if (!isSafeLeadingEnvAssignment(name, value)) {
      break
    }
    if (name === "HARNESS_WORKTREE_ID") {
      sawWorktreeId = true
    }
    pos = LEADING_ENV_TOKEN_PATTERN.lastIndex
    count++
  }
  return { rest: command.slice(pos).trim(), sawWorktreeId }
}

const stripSafeLeadingEnvVars = (command: string): string =>
  stripSafeLeadingEnvVarsDetailed(command).rest

export const isCommandAllowed = (command: string): boolean => {
  const { rest: trimmed, sawWorktreeId } = stripSafeLeadingEnvVarsDetailed(command)
  if (trimmed === "") return false
  if (sawWorktreeId && WORKTREE_ID_BLOCKED_HARNESS_PATTERN.test(trimmed)) {
    return false
  }
  return ALLOWLIST.some((prefix) => {
    if (trimmed === prefix) return true
    if (prefix.endsWith(" ") || prefix.endsWith("/")) return trimmed.startsWith(prefix)
    return trimmed.startsWith(prefix + " ")
  })
}

export const isCdCommand = (trimmed: string): boolean =>
  extractCommandSegments(trimmed).some((seg) => seg.commandWords[0] === "cd")

export const INTERACTIVE_NX_BANNED_REASON =
  "Running 'nx show' without 'CI=true' can hang on interactive prompts; prefix with 'CI=true' or use harness MCP tools."

export const SKIP_NX_CACHE_BANNED_REASON =
  "Bypassing Nx cache with '--skip-nx-cache', '--skipNxCache', or 'NX_SKIP_NX_CACHE'/'NX_DISABLE_NX_CACHE' is banned by harness policy; drop the cache-bypass flag/env and rely on Nx caching."

const SKIP_NX_CACHE_ARG_PATTERN = /^--(?:skip-nx-cache|skipNxCache)(?:=(?!false$).*)?$/
const SKIP_NX_CACHE_ENV_PATTERN = /^(?:NX_SKIP_NX_CACHE|NX_DISABLE_NX_CACHE)=(?:true|1)$/

const segmentHasSkipNxCache = (seg: UnwrappedSegment): boolean => {
  if (seg.envAssignments.some((env) => SKIP_NX_CACHE_ENV_PATTERN.test(env))) {
    return true
  }
  const bin = seg.commandWords[0]
  if (bin === undefined) {
    return false
  }
  const isTarget =
    bin === "nx" ||
    bin.endsWith("/nx") ||
    (seg.sawPackageRunner && (bin === "verify" || bin === "verify:all"))
  if (!isTarget) {
    return false
  }
  return seg.commandWords.slice(1).some((arg) => SKIP_NX_CACHE_ARG_PATTERN.test(arg))
}

export const isSkipNxCacheCommand = (command: string): boolean =>
  extractCommandSegments(command).some(
    (seg) =>
      segmentHasSkipNxCache(seg) && !seg.envAssignments.includes("HARNESS_ALLOW_SKIP_NX_CACHE=1"),
  )

export const isSkipNxCacheOverrideCommand = (command: string): boolean =>
  extractCommandSegments(command).some(
    (seg) =>
      segmentHasSkipNxCache(seg) && seg.envAssignments.includes("HARNESS_ALLOW_SKIP_NX_CACHE=1"),
  )

export const CLEF_SYSTEMONE_ONLY_BANNED_REASON =
  "clef (clef-flash) is a TypeSafe System One structured decision model, NOT a generative text/chat model — /api/generate, /api/chat, /v1/chat/completions, /v1/completions, and 'ollama run clef*' do not exist for System One models and return HTTP errors. Use DecisionModel.decide (@effect/ai-typesafe TypeSafeDecisionModel) or POST http://localhost:11434/v1/systemone ({ model: 'clef-flash', state, questions }), or run 'pnpm harness doctor' to warm/verify the model."

const IGNORED_CLEF_GUARD_BINARIES: ReadonlySet<string> = new Set("grep rg git gh vitest".split(" "))

const CLEF_HTTP_OR_SCRIPT_BINARIES: ReadonlySet<string> = new Set(
  "curl wget http https xh fetch python python3 node bun tsx deno".split(" "),
)

const CLEF_MODEL_NAME_PATTERN = /\bclef(?:-flash)?\b/i
const CLEF_INVALID_ENDPOINT_PATTERN =
  /(?:\/api\/(?:generate|chat|embeddings|embed)|\/v1\/(?:chat\/completions|completions|responses|embeddings))\b/i

export const isInvalidClefEndpointCommand = (command: string): boolean =>
  extractCommandSegments(command).some((seg) => {
    const rawBin = seg.commandWords[0]
    if (rawBin === undefined) {
      return false
    }
    const bin = rawBin.includes("/") ? rawBin.slice(rawBin.lastIndexOf("/") + 1) : rawBin
    if (IGNORED_CLEF_GUARD_BINARIES.has(bin)) {
      return false
    }
    if (
      bin === "ollama" &&
      seg.commandWords[1] === "run" &&
      seg.commandWords.slice(2).some((w) => /^clef(?:-|:|$)/i.test(w))
    ) {
      return true
    }
    if (CLEF_HTTP_OR_SCRIPT_BINARIES.has(bin)) {
      const segText = seg.commandWords.join(" ")
      return CLEF_MODEL_NAME_PATTERN.test(segText) && CLEF_INVALID_ENDPOINT_PATTERN.test(segText)
    }
    return false
  })

export const isInteractiveNxCommand = (command: string): boolean =>
  extractCommandSegments(command).some((seg) => {
    const bin = seg.commandWords[0]
    if (bin !== "nx" && !(bin?.endsWith("/nx") ?? false)) {
      return false
    }
    const nonFlagWords = seg.commandWords.slice(1).filter((tok) => !tok.startsWith("-"))
    const isShowSubcommand =
      nonFlagWords[0] === "show" ||
      (seg.commandWords[1]?.startsWith("-") === true && nonFlagWords.includes("show"))
    if (!isShowSubcommand) {
      return false
    }
    const hasNonInteractiveEnv = seg.envAssignments.some(
      (env) => env === "CI=true" || env === "CI=1" || env === "NX_INTERACTIVE=false",
    )
    return !hasNonInteractiveEnv
  })

export const CD_COMMAND_BANNED_REASON =
  "Shell 'cd' commands are banned by harness policy; use the tool Cwd parameter instead."

export type CommandDenyRuleId =
  | "cd-command-banned"
  | "interactive-nx-banned"
  | "skip-nx-cache-banned"
  | "invalid-clef-endpoint"
  | "denylist-token"
  | "git-force-push"
  | "git-pack-exec-override"
  | "harness-state-mutation"
  | "secret-file-access"
  | "guard-self-invocation"

export interface CommandDenyExplanation {
  readonly ruleId: CommandDenyRuleId
  readonly reason: string
}

const GIT_FORCE_PUSH_PATTERN = /\bgit\s+(?:\S+\s+)*push\b.*(?:\s|^)(?:--force|-f)(?:\s|$)/

const GIT_PACK_EXEC_OVERRIDE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+(?:\S+\s+)*(?:ls-remote|clone)\b.*(?:\s--u[a-z-]*(?:=|\s|$)|\s-u\S*|\s--exe(?:c)?(?:=|\s|$))/s,
  /\bgit\s+(?:\S+\s+)*fetch\b.*(?:\s--upl[a-z-]*(?:=|\s|$)|\s--exe(?:c)?(?:=|\s|$))/s,
  /\bgit\s+(?:\S+\s+)*push\b.*(?:\s--rece[a-z-]*(?:=|\s|$)|\s--ex(?:e(?:c)?)?(?:=|\s|$))/s,
  /\bgit\s+(?:\S+\s+)*archive\b.*\s--ex(?:e(?:c)?)?(?:=|\s|$)/s,
  /\bgit\b.*\bext::/s,
]

export const explainCommandDenyRule = (command: string): CommandDenyExplanation | undefined => {
  const trimmed = normalizeShellLineContinuations(command).trim()
  if (trimmed === "") {
    return undefined
  }
  if (isCdCommand(trimmed)) {
    return { ruleId: "cd-command-banned", reason: CD_COMMAND_BANNED_REASON }
  }
  if (isInteractiveNxCommand(trimmed)) {
    return { ruleId: "interactive-nx-banned", reason: INTERACTIVE_NX_BANNED_REASON }
  }
  if (isSkipNxCacheCommand(trimmed)) {
    return { ruleId: "skip-nx-cache-banned", reason: SKIP_NX_CACHE_BANNED_REASON }
  }
  if (isInvalidClefEndpointCommand(trimmed)) {
    return { ruleId: "invalid-clef-endpoint", reason: CLEF_SYSTEMONE_ONLY_BANNED_REASON }
  }
  const view = toCommandView(trimmed)
  const matchedDeny = DENYLIST.find((entry) => containsToken(view.argv, entry.token))
  if (matchedDeny !== undefined) {
    return {
      ruleId: "denylist-token",
      reason: `Command contains banned token '${matchedDeny.token}' (${matchedDeny.reason}).`,
    }
  }
  if (GIT_FORCE_PUSH_PATTERN.test(view.argv)) {
    return {
      ruleId: "git-force-push",
      reason: "Force-pushing with '--force' or '-f' is banned by harness policy.",
    }
  }
  if (GIT_PACK_EXEC_OVERRIDE_PATTERNS.some((pattern) => pattern.test(view.argv))) {
    return {
      ruleId: "git-pack-exec-override",
      reason:
        "Git remote/transfer command with custom upload-pack/receive-pack/exec or ext:: helper is banned by harness policy.",
    }
  }
  if (isHarnessStateMutationCommand(trimmed)) {
    return {
      ruleId: "harness-state-mutation",
      reason:
        "Mutating or directly probing protected harness runtime state (<git-common-dir>/harness/**, auth-tokens.json, daemon.sock, daemon.lock, workflow-backups/, pending-workflow-restore.json) is banned by harness policy.",
    }
  }
  if (SECRET_FILE_PATTERN.test(view.argv)) {
    return {
      ruleId: "secret-file-access",
      reason:
        "Accessing or exposing secret/credential files (.env, mutation-hmac*.key, auth-tokens.json) in shell commands is banned by harness policy.",
    }
  }
  if (isHarnessStateAccessCommand(trimmed)) {
    return {
      ruleId: "harness-state-mutation",
      reason:
        "Reading or inspecting protected harness runtime state (<git-common-dir>/harness/**, auth-tokens.json, daemon.sock, daemon.lock, workflow-backups/, pending-workflow-restore.json) is banned by harness policy.",
    }
  }
  if (GUARD_SELF_INVOCATION_PATTERN.test(view.argv)) {
    return {
      ruleId: "guard-self-invocation",
      reason: "Invoking 'harness guard' from an agent shell command is banned by harness policy.",
    }
  }
  return undefined
}

export const explainCommandDenyReason = (command: string): string | undefined =>
  explainCommandDenyRule(command)?.reason

/** Rule order is load-bearing (harness:ADR-0003): deny → ask → escalate → allow.
 * Every rule that removes the automatic `allow` must run before the prefix allowlist. */
export const classifyCommand = (command: string): GuardVerdict => {
  if (command.length > MAX_CLASSIFY_COMMAND_LENGTH) {
    return "ask"
  }
  const norm = normalizeShellLineContinuations(command)
  const trimmed = norm.trim()
  if (trimmed === "") {
    return "escalate"
  }
  if (explainCommandDenyRule(trimmed) !== undefined) {
    return "deny"
  }
  if (isSkipNxCacheOverrideCommand(trimmed)) {
    return "ask"
  }
  const view = toCommandView(norm)
  const hasBgOp = hasUnquotedBackgroundOperator(view.unquoted)
  const hasUnquotedBraceExpansion = /\{[^}\s,]+,[^}\s]*\}/.test(view.unquoted)
  if (
    ASKLIST.some((token) => containsToken(view.argv, token)) ||
    matchesAny(view.argv, GIT_DISCARD_PATTERNS)
  ) {
    return "ask"
  }
  if (
    view.unclosedQuote ||
    view.hasDoubleQuotedSubstitution ||
    view.hasAnsiCQuote ||
    matchesAny(view.argv, DESTRUCTIVE_ARGUMENT_PATTERNS) ||
    FILE_REDIRECTION_PATTERN.test(view.unquoted) ||
    matchesAny(norm, OBFUSCATION_PATTERNS) ||
    hasUnquotedAdjacentBracketGlob(norm, view.unquoted) ||
    hasUnquotedBraceExpansion ||
    /\$\(|`|<\(|>\(/.test(view.unquoted)
  ) {
    return "escalate"
  }
  if (hasBgOp || SHELL_OPERATORS.some((op) => view.unquoted.includes(op))) {
    const isAllowedFilter = (p: string): boolean =>
      p.startsWith("grep ") ||
      p.startsWith("head ") ||
      p.startsWith("tail ") ||
      p.startsWith("wc ") ||
      p.startsWith("cat ") ||
      p === "cat" ||
      p.startsWith("sort ") ||
      p === "sort"

    const isAllowedPipedSegment = (segCmd: string, segUnquoted: string): boolean => {
      if (!segUnquoted.includes("|") || segUnquoted.includes("||")) {
        return false
      }
      const parts = splitByUnquotedOperator(segCmd, segUnquoted, "|")
      return (
        parts.length >= 2 &&
        isCommandAllowed(parts[0]!.cmd) &&
        parts.slice(1).every((p) => isAllowedFilter(p.cmd))
      )
    }

    if (
      !hasBgOp &&
      view.unquoted.includes("|") &&
      !view.unquoted.includes("||") &&
      !view.unquoted.includes("&&") &&
      !view.unquoted.includes(";") &&
      !view.unquoted.includes("\n")
    ) {
      if (isAllowedPipedSegment(norm, view.unquoted)) {
        return "allow"
      }
    }
    if (
      !hasBgOp &&
      view.unquoted.includes("&&") &&
      !view.unquoted.includes("||") &&
      !view.unquoted.includes(";") &&
      !view.unquoted.includes("\n")
    ) {
      const parts = splitByUnquotedOperator(norm, view.unquoted, "&&")
      if (
        parts.length >= 2 &&
        parts.every(
          (p) =>
            p.cmd.length > 0 &&
            (isCommandAllowed(p.cmd) || isAllowedPipedSegment(p.cmd, p.unquoted)) &&
            !/^\s*git\s+(?:add|commit|push)\b/.test(stripSafeLeadingEnvVars(p.cmd)),
        )
      ) {
        return "allow"
      }
    }
    return "escalate"
  }
  return isCommandAllowed(norm) ? "allow" : "escalate"
}

export type FileWriteDenyRuleId =
  | "readonly-subtree"
  | "verify-stamp"
  | "mutate-stamp"
  | "harness-cache"
  | "harness-common-dir-state"
  | "secret-file"

export interface FileWriteGuardResult {
  readonly verdict: "allow" | "deny" | "ask"
  readonly ruleId?: FileWriteDenyRuleId | undefined
  readonly reason?: string | undefined
}

export const classifyFileWrite = (filePath: string): FileWriteGuardResult => {
  const rawNorm = filePath.replace(/\\/g, "/").trim()
  if (rawNorm === "") {
    return { verdict: "allow" }
  }
  const norm = path.posix.normalize(rawNorm)
  const candidates = rawNorm === norm ? [norm] : [rawNorm, norm]

  if (candidates.some((p) => /(^|\/)repos\/(effect|alchemy)(\/|$)/.test(p))) {
    return {
      verdict: "deny",
      ruleId: "readonly-subtree",
      reason: `Protected read-only subtree cannot be modified: ${filePath}`,
    }
  }

  if (candidates.some((p) => /(^|\/)\.harness\/(worktrees\/[^/]+\/)?verify-stamp\.json$/.test(p))) {
    return {
      verdict: "deny",
      ruleId: "verify-stamp",
      reason: `Direct modification of verify-stamp.json is forbidden (stamp forgery protection): ${filePath}`,
    }
  }

  if (candidates.some((p) => /(^|\/)\.harness\/(worktrees\/[^/]+\/)?mutate-stamp\.json$/.test(p))) {
    return {
      verdict: "deny",
      ruleId: "mutate-stamp",
      reason: `Direct modification of mutate-stamp.json is forbidden (stamp forgery protection): ${filePath}`,
    }
  }

  if (
    candidates.some((p) =>
      /(^|\/)\.harness\/(worktrees\/[^/]+\/)?(cache\/mutation-cache-v\d+\.(?:json(?:\.corrupt)?|corrupt)|session-preinvocation-cache\.json|last-done\.json|graph-snapshot\.json|graph-head\.json)$/.test(
        p,
      ),
    )
  ) {
    return {
      verdict: "deny",
      ruleId: "harness-cache",
      reason: `Direct modification of harness cache file is forbidden: ${filePath}`,
    }
  }

  if (candidates.some((p) => PROTECTED_HARNESS_FILE_WRITE_PATTERN.test(p))) {
    return {
      verdict: "deny",
      ruleId: "harness-common-dir-state",
      reason: `Direct modification of protected harness runtime state is forbidden: ${filePath}`,
    }
  }

  if (
    candidates.some(
      (p) =>
        /(^|\/)(\.env(\.[a-zA-Z0-9_-]+)*|\.dev\.vars|mutation-hmac[^/]*\.key|.*\.(pem|key))$/.test(
          p,
        ) && !/\.(example|template|sample)$/i.test(p),
    )
  ) {
    return {
      verdict: "deny",
      ruleId: "secret-file",
      reason: `Secret or credential file modification is forbidden by harness guard: ${filePath}`,
    }
  }

  if (candidates.some((p) => /(^|\/)(\.oxlintrc\.json|tools\/oxlint\/.*|.*\.cedar)$/.test(p))) {
    return {
      verdict: "ask",
      reason: `Modifying harness governance/linter policy requires human confirmation: ${filePath}`,
    }
  }

  return { verdict: "allow" }
}
