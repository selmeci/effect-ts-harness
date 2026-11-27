/** Zero-dependency static guard lists, regexes, and pattern constants
 * shared by `policy-command-rules.ts` under the `policy-zero-dep` closure profile. */

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
  "git merge-base",
  "git symbolic-ref",
  "git config --get",
  "git ls-remote",
  "git --version",
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
  "echo",
  "cut",
  "true",
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
  /(?:(?:^|\s)(?:\S*\/)?harness|(?:apps\/)?harness-cli\/(?:src|dist)\/(?:index|hook-entry)\.(?:ts|js))(?:\s+(?:--(?=\s|$)|-\S+(?:\s+(?!guard\b)[^\s;|&)<>]+)?))*\s+guard\b/

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
    pattern: /\bgit\s+(?:diff|log|show)\b.*\s--(?:output|ext-diff|textconv)(?:=|\s|$)/s,
    reason: "git diff/log/show output or external diff/textconv execution flag",
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

const SAFE_ENV_PATH_PATTERN = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const UNSAFE_ENV_PATH_PATTERN =
  /\.\.|\/\.env|\/\.git(?:\/|$)|\/\.harness|secret|\/repos\/(?:effect|alchemy)(?:\/|$)|\/tools\/|\/adapters\//i
const SAFE_TEMP_PATH_VALIDATOR = (value: string): boolean =>
  SAFE_ENV_PATH_PATTERN.test(value) && !UNSAFE_ENV_PATH_PATTERN.test(value)

export const SAFE_LEADING_ENV_VALUES: Readonly<Record<string, (value: string) => boolean>> = {
  CI: (v) => /^(?:true|false|0|1)$/.test(v),
  NX_INTERACTIVE: (v) => /^(?:true|false|0|1)$/.test(v),
  NX_DAEMON: (v) => /^(?:true|false|0|1)$/.test(v),
  NX_TUI: (v) => /^(?:true|false|0|1)$/.test(v),
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

export const WORKTREE_ID_BLOCKED_HARNESS_PATTERN = /^node\b.*apps\/harness-cli\/src\//

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

export const NX_VALUE_FLAGS: ReadonlySet<string> = new Set([
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

export const SAFE_PNPM_EXEC_PREFIXES: ReadonlyArray<string> = [
  "vitest",
  "tsc",
  "oxlint",
  "oxfmt",
  "effect-tsgo",
  "nx run ",
  "nx run-many",
  "nx affected",
  "nx test",
  "nx typecheck",
  "nx lint",
  "nx build",
  "nx format",
  "nx show",
]

export const PNPM_FILTER_EXEC_PATTERN =
  /^pnpm\s+(?:(?:(?:-F|--filter|--filter-prod|-C|--dir)(?:=\S+|\s+\S+))\s+)+exec(?:\s+--)?(?:\s+(.*))?$/s

export const PNPM_FILTER_DLX_PATTERN =
  /^pnpm\s+(?:(?:(?:-F|--filter|--filter-prod|-C|--dir)(?:=\S+|\s+\S+))\s+)+dlx(?:\s|$)/

export const SAFE_GIT_SYMBOLIC_REF_FLAGS: ReadonlySet<string> = new Set([
  "-q",
  "--quiet",
  "--short",
  "--recurse",
  "--no-recurse",
])

export const SAFE_GIT_CONFIG_GET_FLAGS: ReadonlySet<string> = new Set([
  "--get",
  "--local",
  "--bool",
  "--int",
  "--bool-or-int",
  "--bool-or-str",
  "--path",
  "--expiry-date",
  "-z",
  "--null",
  "--name-only",
  "--show-origin",
  "--show-scope",
  "--includes",
  "--no-includes",
  "--fixed-value",
])

export const XARGS_GUARD_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "-a --arg-file -d --delimiter -E --eof -I --replace -L --max-lines -n --max-args -P --max-procs -s --max-chars --process-slot-var".split(
    " ",
  ),
)
export const INTERPRETER_OR_EXEC_BINARIES: ReadonlySet<string> = new Set(
  "sh bash zsh dash ksh ash python python2 python3 node nodejs bun deno tsx ts-node perl ruby awk gawk mawk nawk sed eval exec env xargs source . command timeout nice nohup stdbuf time".split(
    " ",
  ),
)
export const SHELL_ONLY_HEREDOC_BINARIES: ReadonlySet<string> = new Set(
  "sh bash zsh dash ksh ash eval source . env xargs exec".split(" "),
)
export const FORBIDDEN_DEST_PATH_PATTERN =
  /\.harness|\.env|\.git|auth[-_]?tokens|mutation-hmac|\.key\b|\.pem\b|\.dev\.vars|daemon\.(?:sock|lock)|workflow-backups|pending-workflow-restore|repos\/|tools\/|adapters\//i
export const SAFE_LITERAL_TEMP_PATH_PATTERN =
  /^(?:\/tmp|\/var\/tmp)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
export const SAFE_TMPDIR_FALLBACK_PATH_PATTERN =
  /^\$\{TMPDIR:-\/(?:var\/)?tmp\}\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
export const SAFE_TMPDIR_VAR_PATH_PATTERN = /^\$TMPDIR\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
export const SAFE_TMPDIR_DIR_PATTERN =
  /^(?:\/tmp|\/var\/tmp|\$\{TMPDIR:-\/(?:var\/)?tmp\}|\$TMPDIR)(?:\/[A-Za-z0-9._-]+)*$/
export const SAFE_TMPDIR_ENV_PATTERN = /^\/(?:var\/)?tmp(?:\/[A-Za-z0-9._-]+)*$/
export const SHELL_VAR_REF_PATTERN = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/
export const SIMPLE_VAR_ASSIGN_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
