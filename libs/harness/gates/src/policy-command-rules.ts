/** Zero-dependency static guard rules, allowlists, denylists, and leading-env strippers
 * shared by `policy.ts` under the `policy-zero-dep` closure profile. */

export type GuardVerdict = "allow" | "deny" | "ask" | "escalate"

/** A guard rule matched by regex instead of substring (harness:SPEC-0001). */
export interface GuardPatternRule {
  readonly pattern: RegExp
  readonly reason: string
}

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
  "git worktree list",
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
  "df",
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

/** SPEC-0001 REQ-3.1: a dotenv file, mutation-hmac key, `.cache/effect-harness` state/key path, or
 * wildcard `*.key` token referenced as a path token, including multi-dot names
 * (`.env.development.local`), globs/character classes/braces (`.env*`, `mutation-hmac*.key`,
 * `mutation-hmac-v[0-9].key`, `mutation-hmac-{v1,v2}.key`, `*.key`, `*.k?y`, `*.k[a-z]y`). It does
 * not match identifiers (`process.env`, `import.meta.env`), plugin dirs (`plugins/effect-harness`),
 * or templates (`.env.example`, `.env.template`, `.env.sample`) — SPEC-0001 REQ-3.2.
 * Evaluated on `CommandView.argv`. */
export const SECRET_FILE_PATTERN: RegExp =
  /(?:^|[\s=:/<>('"`,{])(?:\.(?:env|en\?|e\?v|\?nv|\[[^\]\s]{2,}\]nv|dev\.vars|dev\.var\?)(?:\.(?!(?:example|template|sample)(?:$|[\s/'"`,]))[\w*?-]+)*\*?|mutation-hma[c*?][^\s;|&)<>'"`,]*(?:\.ke?[y*?]?|\*|\?|\]|\})|[^\s;|&)<>'"`,]*\.cache\/effect-harness(?:\/[^\s;|&)<>'"`,]*)?|[^\s=:/<>()'"`,]*(?:\*|\?|\[[^\]\s]+\]|\{[^}\s]+\})[^\s;|&)<>'"`,]*\.(?:k(?:e|\?|\[[^\]\s]+\]|\*)(?:y|\?|\[[^\]\s]+\]|\*)?|p(?:e|\?|\[[^\]\s]+\])(?:m|\?|\[[^\]\s]+\]))|(?:[^\s;|&)<>'"`,]*\/)?auth-tokens?(?:\*|[*?[\]{}][^\s;|&)<>'"`,]*)?\.json)(?=$|[\s/;|&)<>'"`,}])/

/** SPEC-0001 REQ-2.1: the agent must not use the guard as an oracle to test candidate commands.
 * Hooks invoke the guard directly from the IDE, never through an agent shell command.
 * Flags (and flag values such as `--cwd /tmp`) or `--` before `guard` are tolerated. */
export const GUARD_SELF_INVOCATION_PATTERN: RegExp =
  /(?:(?:^|\s)harness|harness-cli\/src\/(?:index|hook-entry)\.ts)(?:\s+(?:--(?=\s|$)|-\S+(?:\s+(?!guard\b)[^\s;|&)<>]+)?))*\s+guard\b/

/** SPEC-0001 REQ-1.2: git commands that irreversibly discard work. Always a human decision —
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

/** SPEC-0001 REQ-1.1 / SPEC-0001 REQ-1.4: find actions that delete or execute, and mutating flags on gh api.
 * Evaluated on `CommandView.argv`, so quoted flags (`'-delete'`, `'-X' 'DELETE'`) are caught.
 * Checked BEFORE the prefix allowlist. */
export const DESTRUCTIVE_ARGUMENT_PATTERNS: ReadonlyArray<GuardPatternRule> = [
  {
    pattern: /\bfind\b.*\s-(?:delete|exec|execdir|ok|okdir|fls|fprint0?|fprintf)\b/s,
    reason: "find action that deletes, executes, or writes files",
  },
  {
    pattern: /\bsort\b.*(?:\s-[^\s-]*o|\s--output(?:=|\s|$))/s,
    reason: "sort writing output to file",
  },
  {
    pattern: /\bgit\s+(?:diff|log|show)\b.*\s--output(?:=|\s|$)/s,
    reason: "git output flag writing to file",
  },
  {
    pattern: /\brg\b.*\s--(?:pre|pre-glob|hostname-bin)(?:=|\s|$)/s,
    reason: "rg preprocessor/helper command execution",
  },
  {
    pattern:
      /\bnx\s+(?:(?:-c|--configuration|--output-style|--runner|-p|--project|--projects|--exclude|-t|--target|--targets|--args|--files|--base|--head|--parallel)(?:=\S+|\s+\S+)\s+|-(?!(?:c|p|t|-configuration|-output-style|-runner|-project|-projects|-exclude|-target|-targets|-args|-files|-base|-head|-parallel)(?:\s|=|$))\S+\s+)*exec(?:\s|$)/s,
    reason: "nx exec executes arbitrary shell commands",
  },
  {
    pattern:
      /\bpnpm\s+(?:(?:-F|--filter|--filter-prod|-C|--dir|--cwd|--prefix|-p|--package|--loglevel|--reporter|--store-dir|--cache-dir|--modules-dir|--lockfile-dir|--virtual-store-dir|-c|--config|--userconfig|--globalconfig|--script-shell|--workspace-concurrency)(?:=\S+|\s+\S+)\s+|-(?!(?:F|C|p|c|-filter|-filter-prod|-dir|-cwd|-prefix|-package|-loglevel|-reporter|-store-dir|-cache-dir|-modules-dir|-lockfile-dir|-virtual-store-dir|-config|-userconfig|-globalconfig|-script-shell|-workspace-concurrency)(?:\s|=|$))\S+\s+)*dlx(?:\s|$)/s,
    reason: "pnpm dlx executes arbitrary remote packages",
  },
  {
    pattern:
      /\bgh\s+api\b.*(?:\s-(?:X|f|F)[A-Za-z0-9_=-]*|\s--(?:method|field|raw-field|input)(?:=|\s|$))/s,
    reason: "gh api mutating request method or body field",
  },
  {
    pattern: /\bomnigraph\s+cleanup\b.*--keep(?:=|\s+)0(?:\s|$)/s,
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

/** SPEC-0001 REQ-1.3: `>`, `>>`, `N>`, `&>`, `&>>`, `>& file` into a file. Not stream duplication
 * (`2>&1`, `>&2`), not `/dev/null`, not `=>` / `->`. Evaluated on `CommandView.unquoted`. */
export const FILE_REDIRECTION_PATTERN: RegExp =
  /(?:&>>?|(?<![=&>-])\d*>>?(?![&>])|(?<![=&>-])\d*>&(?![\d-]))\s*(?!\/dev\/null(?:\s|$))\S/

/** SPEC-0001 REQ-3.3: a word or path split by a character-class glob (`[e]nv`, `v[0-9]`, `[.]env`)
 * or by empty quotes (`r''m`, `.''env`) — the forms used to slip past substring rules.
 * Evaluated on the raw command. */
export const OBFUSCATION_PATTERNS: ReadonlyArray<GuardPatternRule> = [
  {
    pattern: /\[[^\]\s]\](?=[\w./*'"-])|(?<=[\w./*'"-])\[[^\]\s]\]/,
    reason: "character-class glob inside a word or path",
  },
  { pattern: /(?<=[\w./*\]-])(?:''|"")(?=[\w./*[-])/, reason: "empty quotes inside a word" },
]

export const GIT_FORCE_PUSH_PATTERN: RegExp =
  /\bgit\s+(?:\S+\s+)*push\b.*(?:\s|^)(?:--force|-f)(?:\s|$)/

export const GIT_PACK_EXEC_OVERRIDE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+(?:\S+\s+)*(?:ls-remote|clone)\b.*(?:\s--u[a-z-]*(?:=|\s|$)|\s-u\S*|\s--exe(?:c)?(?:=|\s|$))/s,
  /\bgit\s+(?:\S+\s+)*fetch\b.*(?:\s--upl[a-z-]*(?:=|\s|$)|\s--exe(?:c)?(?:=|\s|$))/s,
  /\bgit\s+(?:\S+\s+)*push\b.*(?:\s--rece[a-z-]*(?:=|\s|$)|\s--ex(?:e(?:c)?)?(?:=|\s|$))/s,
  /\bgit\s+(?:\S+\s+)*archive\b.*\s--ex(?:e(?:c)?)?(?:=|\s|$)/s,
  /\bgit\b.*\bext::/s,
]

export const MAX_CLASSIFY_COMMAND_LENGTH = 65_536

export const INTERACTIVE_NX_BANNED_REASON =
  "Running 'nx show' without 'CI=true' can hang on interactive prompts; prefix with 'CI=true' or use harness MCP tools."

export const SKIP_NX_CACHE_BANNED_REASON =
  "Bypassing Nx cache with '--skip-nx-cache', '--skipNxCache', or 'NX_SKIP_NX_CACHE'/'NX_DISABLE_NX_CACHE' is banned by harness policy; drop the cache-bypass flag/env and rely on Nx caching."

export const CD_COMMAND_BANNED_REASON =
  "Shell 'cd' commands are banned by harness policy; use the tool Cwd parameter instead."

const BRACKET_CLASS_GLOBAL_PATTERN: RegExp = /\[[^\]\s]+\]/g
const BRACKET_ADJACENT_CHAR_PATTERN: RegExp = /[\w./*'"-]/

export const hasUnquotedAdjacentBracketGlob = (norm: string, unquoted: string): boolean => {
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

export const splitByUnquotedOperator = (
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

export const containsToken = (command: string, token: string): boolean =>
  command.toLowerCase().includes(token.toLowerCase())

export const matchesAny = (command: string, rules: ReadonlyArray<GuardPatternRule>): boolean =>
  rules.some((rule) => rule.pattern.test(command))

const MAX_LEADING_ENV_VARS = 32
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
const LEADING_ENV_CMD_PATTERN = /env(?=\s|$)/y
const ENV_WORD_PATTERN = /([^\s;|&]+)/y
const WORKTREE_ID_BLOCKED_HARNESS_PATTERN = /^node\b.*apps\/harness-cli\/src\//

export interface StripLeadingEnvResult {
  readonly rest: string
  readonly sawWorktreeId: boolean
}

const isSafeLeadingEnvVarName = (name: string): boolean =>
  Object.hasOwn(SAFE_LEADING_ENV_VALIDATORS, name)

const consumeSafeEnvWrapper = (
  command: string,
  envStartPos: number,
  initialSawWorktreeId: boolean,
  startCount: number,
): {
  readonly accepted: boolean
  readonly nextPos: number
  readonly sawWorktreeId: boolean
  readonly nextCount: number
} => {
  const len = command.length
  let pos = envStartPos + 3
  let count = startCount
  let sawWorktreeId = initialSawWorktreeId
  let consumedSafeArg = false
  const abort = () => ({
    accepted: false,
    nextPos: envStartPos,
    sawWorktreeId: initialSawWorktreeId,
    nextCount: startCount,
  })

  while (count < MAX_LEADING_ENV_VARS) {
    while (pos < len && /\s/.test(command[pos]!)) {
      pos++
    }
    if (pos >= len) {
      return consumedSafeArg
        ? { accepted: true, nextPos: pos, sawWorktreeId, nextCount: count }
        : abort()
    }
    ENV_WORD_PATTERN.lastIndex = pos
    const wordMatch = ENV_WORD_PATTERN.exec(command)
    if (wordMatch === null) {
      return abort()
    }
    const token = wordMatch[1]!
    if (token === "-u") {
      pos = ENV_WORD_PATTERN.lastIndex
      while (pos < len && /\s/.test(command[pos]!)) {
        pos++
      }
      ENV_WORD_PATTERN.lastIndex = pos
      const nameMatch = ENV_WORD_PATTERN.exec(command)
      if (nameMatch === null || !isSafeLeadingEnvVarName(nameMatch[1]!)) {
        return abort()
      }
      pos = ENV_WORD_PATTERN.lastIndex
      consumedSafeArg = true
      count++
      continue
    }
    if (token.startsWith("--unset=")) {
      const varName = token.slice("--unset=".length)
      if (!isSafeLeadingEnvVarName(varName)) {
        return abort()
      }
      pos = ENV_WORD_PATTERN.lastIndex
      consumedSafeArg = true
      count++
      continue
    }
    if (token.startsWith("-")) {
      return abort()
    }
    LEADING_ENV_TOKEN_PATTERN.lastIndex = pos
    const assignMatch = LEADING_ENV_TOKEN_PATTERN.exec(command)
    if (assignMatch !== null && assignMatch.index === pos) {
      const name = assignMatch[1]!
      const value = assignMatch[2]!
      if (!isSafeLeadingEnvAssignment(name, value)) {
        return abort()
      }
      if (name === "HARNESS_WORKTREE_ID") {
        sawWorktreeId = true
      }
      pos = LEADING_ENV_TOKEN_PATTERN.lastIndex
      consumedSafeArg = true
      count++
      continue
    }
    break
  }

  return consumedSafeArg
    ? { accepted: true, nextPos: pos, sawWorktreeId, nextCount: count }
    : abort()
}

export const stripSafeLeadingEnvVarsDetailed = (command: string): StripLeadingEnvResult => {
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
    LEADING_ENV_CMD_PATTERN.lastIndex = pos
    const envMatch = LEADING_ENV_CMD_PATTERN.exec(command)
    if (envMatch !== null) {
      const envRes = consumeSafeEnvWrapper(command, pos, sawWorktreeId, count)
      if (!envRes.accepted) {
        break
      }
      pos = envRes.nextPos
      sawWorktreeId = envRes.sawWorktreeId
      count = envRes.nextCount + 1
      continue
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

export const stripSafeLeadingEnvVars = (command: string): string =>
  stripSafeLeadingEnvVarsDetailed(command).rest

const splitCommandTokens = (command: string): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  let current = ""
  let inToken = false
  let quote: "'" | '"' | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined
        continue
      }
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        current += command[++i]!
        continue
      }
      current += ch
      continue
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ""
        inToken = false
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      inToken = true
      continue
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[++i]!
      inToken = true
      continue
    }
    current += ch
    inToken = true
  }
  if (inToken) {
    tokens.push(current)
  }
  return tokens
}

export const PNPM_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-F",
  "--filter",
  "--filter-prod",
  "--test-pattern",
  "--changed-files-ignore-pattern",
  "-C",
  "--dir",
  "--cwd",
  "--prefix",
  "-p",
  "--package",
  "--loglevel",
  "--reporter",
  "--store-dir",
  "--cache-dir",
  "--modules-dir",
  "--lockfile-dir",
  "--virtual-store-dir",
  "-c",
  "--config",
  "--userconfig",
  "--globalconfig",
  "--script-shell",
  "--workspace-concurrency",
])

const inspectPnpmTokens = (
  tokens: ReadonlyArray<string>,
): { readonly subcommand: string | undefined; readonly restStartIdx: number } => {
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (tok === "--") {
      i++
      return { subcommand: tokens[i], restStartIdx: i + 1 }
    }
    if (PNPM_VALUE_FLAGS.has(tok)) {
      i += 2
      continue
    }
    if (tok.startsWith("-")) {
      i++
      continue
    }
    return { subcommand: tok, restStartIdx: i + 1 }
  }
  return { subcommand: undefined, restStartIdx: tokens.length }
}

const NX_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-c",
  "--configuration",
  "--output-style",
  "--runner",
  "-p",
  "--project",
  "--projects",
  "--exclude",
  "-t",
  "--target",
  "--targets",
  "--args",
  "--files",
  "--base",
  "--head",
  "--parallel",
])

const inspectNxTokens = (
  tokens: ReadonlyArray<string>,
): {
  readonly subcommand: string | undefined
  readonly hasTaskBeforeDash: boolean
} => {
  const dashDashIdx = tokens.indexOf("--")
  const preEnd = dashDashIdx === -1 ? tokens.length : dashDashIdx
  const positionalBeforeDash: Array<string> = []
  let i = 1
  while (i < preEnd) {
    const tok = tokens[i]!
    if (NX_VALUE_FLAGS.has(tok)) {
      i += 2
      continue
    }
    if (tok.startsWith("-")) {
      i++
      continue
    }
    positionalBeforeDash.push(tok)
    i++
  }
  const firstBeforeDash = positionalBeforeDash[0]
  if (firstBeforeDash !== undefined) {
    const hasTaskBeforeDash = firstBeforeDash === "run" ? positionalBeforeDash.length >= 2 : true
    return { subcommand: firstBeforeDash, hasTaskBeforeDash }
  }
  if (dashDashIdx !== -1) {
    return { subcommand: tokens[dashDashIdx + 1], hasTaskBeforeDash: false }
  }
  return { subcommand: undefined, hasTaskBeforeDash: false }
}

const SAFE_PNPM_EXEC_PREFIXES: ReadonlyArray<string> = [
  "vitest",
  "tsc",
  "oxlint",
  "oxfmt",
  "effect-tsgo",
  "nx run ",
  "nx affected",
  "nx test",
  "nx typecheck",
  "nx lint",
  "nx build",
  "nx format",
  "nx show",
]

const PNPM_FILTER_EXEC_PATTERN =
  /^pnpm\s+(?:(?:(?:-F|--filter|--filter-prod|-C|--dir)(?:=\S+|\s+\S+))\s+)+exec(?:\s+--)?(?:\s+(.*))?$/s

const PNPM_FILTER_DLX_PATTERN =
  /^pnpm\s+(?:(?:(?:-F|--filter|--filter-prod|-C|--dir)(?:=\S+|\s+\S+))\s+)+dlx(?:\s|$)/

export const hasTokenReferencingHarnessCli = (tokens: ReadonlyArray<string>): boolean =>
  tokens.some((tok) => /(?:^|[=,/:.{*'"@])harness-cli(?:$|[=,/:.}*'"@])/.test(tok))

const hasNxStartTarget = (tokens: ReadonlyArray<string>): boolean => {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === "-t" || tok === "--target" || tok === "--targets") {
      const val = tokens[i + 1]
      if (val !== undefined && val.split(",").includes("start")) return true
      continue
    }
    const eqMatch = /^-(?:t|-targets?)=(.+)$/.exec(tok)
    if (eqMatch !== null && eqMatch[1]!.split(",").includes("start")) return true
    if (tok.startsWith("-t") && tok.length > 2 && tok.slice(2).split(",").includes("start")) {
      return true
    }
  }
  return false
}

const isWorktreeIdBlockedNxTokens = (nxTokens: ReadonlyArray<string>): boolean => {
  const nxInfo = inspectNxTokens(nxTokens)
  if (nxInfo.subcommand === "start") return true
  const dashDashIdx = nxTokens.indexOf("--")
  const preDash =
    dashDashIdx === -1 || !nxInfo.hasTaskBeforeDash
      ? nxTokens.slice(1)
      : nxTokens.slice(1, dashDashIdx)
  if (hasTokenReferencingHarnessCli(preDash)) return true
  if (
    (nxInfo.subcommand === "run-many" || nxInfo.subcommand === "affected") &&
    hasNxStartTarget(preDash)
  ) {
    return true
  }
  return false
}

const findPnpmRunScript = (tokens: ReadonlyArray<string>, startIdx: number): string | undefined => {
  for (let i = startIdx; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === "--") continue
    if (PNPM_VALUE_FLAGS.has(tok)) {
      i++
      continue
    }
    if (tok.startsWith("-")) continue
    return tok
  }
  return undefined
}

const isSafePnpmExecTarget = (rawTarget: string | undefined, sawWorktreeId = false): boolean => {
  if (rawTarget === undefined) return false
  const { rest: stripped, sawWorktreeId: innerSawWorktreeId } = stripSafeLeadingEnvVarsDetailed(
    rawTarget.trim(),
  )
  if (stripped === "") return false
  const effectiveSawWorktreeId = sawWorktreeId || innerSawWorktreeId
  const targetTokens = splitCommandTokens(stripped)
  if (targetTokens[0] === "nx") {
    const nxInfo = inspectNxTokens(targetTokens)
    if (nxInfo.subcommand === "exec") return false
    if (effectiveSawWorktreeId && isWorktreeIdBlockedNxTokens(targetTokens)) {
      return false
    }
  }
  return SAFE_PNPM_EXEC_PREFIXES.some((prefix) =>
    prefix.endsWith(" ")
      ? stripped.startsWith(prefix)
      : stripped === prefix || stripped.startsWith(prefix + " "),
  )
}

export const isCommandAllowed = (command: string): boolean => {
  const { rest: trimmed, sawWorktreeId } = stripSafeLeadingEnvVarsDetailed(command)
  if (trimmed === "") return false
  if (sawWorktreeId && WORKTREE_ID_BLOCKED_HARNESS_PATTERN.test(trimmed)) {
    return false
  }
  const tokens = splitCommandTokens(trimmed)
  const head = tokens[0]
  if (head === "nx") {
    const nxInfo = inspectNxTokens(tokens)
    if (nxInfo.subcommand === "exec") return false
    if (sawWorktreeId && isWorktreeIdBlockedNxTokens(tokens)) {
      return false
    }
  }
  if (head === "pnpm") {
    const pnpmInfo = inspectPnpmTokens(tokens)
    if (pnpmInfo.subcommand === "dlx") return false
    const pnpmDashDashIdx = tokens.indexOf("--")
    const pnpmPreDash = pnpmDashDashIdx === -1 ? tokens.slice(1) : tokens.slice(1, pnpmDashDashIdx)
    const runScript =
      pnpmInfo.subcommand === "run" || pnpmInfo.subcommand === "run-script"
        ? findPnpmRunScript(tokens, pnpmInfo.restStartIdx)
        : undefined
    if (
      sawWorktreeId &&
      (pnpmInfo.subcommand === "harness" ||
        pnpmInfo.subcommand === "start" ||
        runScript === "harness" ||
        runScript === "start" ||
        hasTokenReferencingHarnessCli(pnpmPreDash))
    ) {
      return false
    }
    if (pnpmInfo.subcommand === "nx") {
      const nxTokens = ["nx", ...tokens.slice(pnpmInfo.restStartIdx)]
      const nxInfo = inspectNxTokens(nxTokens)
      if (nxInfo.subcommand === "exec") return false
      if (sawWorktreeId && isWorktreeIdBlockedNxTokens(nxTokens)) {
        return false
      }
    }
    if (pnpmInfo.subcommand === "exec") {
      let targetStart = pnpmInfo.restStartIdx
      if (tokens[targetStart] === "--") {
        targetStart++
      }
      return isSafePnpmExecTarget(tokens.slice(targetStart).join(" "), sawWorktreeId)
    }
  }
  if (/^nx\s+exec(?:\s|$)/.test(trimmed) || PNPM_FILTER_DLX_PATTERN.test(trimmed)) {
    return false
  }
  const execMatch = PNPM_FILTER_EXEC_PATTERN.exec(trimmed)
  if (execMatch !== null) {
    return isSafePnpmExecTarget(execMatch[1], sawWorktreeId)
  }
  return ALLOWLIST.some((prefix) => {
    if (trimmed === prefix) return true
    if (prefix.endsWith(" ") || prefix.endsWith("/")) return trimmed.startsWith(prefix)
    return trimmed.startsWith(prefix + " ")
  })
}
