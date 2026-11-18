/** Deterministic guard policy. `classifyCommand` never calls the decision model:
 * "escalate" means "deterministic rules left this open" (mvp.md, safety guard row);
 * "ask" means "always confirm with the human first" (alchemy deploy/destroy/profile,
 * matching Alchemy's own advice to confirm every deploy). */

import * as path from "node:path"

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

/** Two views of a command used by the pattern rules (harness:SPEC-0001 · 4).
 * - `argv`: shell words after quote and backslash removal, joined by single spaces, with
 *   data arguments dropped (commit messages, grep patterns) — REQ-4.1 / REQ-4.2.
 * - `unquoted`: the raw command with quoted text blanked, so `>` inside a quoted string
 *   is not taken for a redirection — REQ-4.3. */
export interface CommandView {
  readonly argv: string
  readonly unquoted: string
}

const OPERATOR_WORDS: ReadonlySet<string> = new Set(["&&", "||", ";", "|"])

const splitShellWords = (
  command: string,
): { readonly words: ReadonlyArray<string>; readonly unquoted: string } => {
  const words: Array<string> = []
  let current = ""
  let inWord = false
  let quote: "'" | '"' | undefined
  let unquoted = ""
  const flush = (): void => {
    if (inWord) {
      words.push(current)
      current = ""
      inWord = false
    }
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== undefined) {
      unquoted += " "
      if (ch === quote) {
        quote = undefined
        continue
      }
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        current += command[++i]!
        unquoted += " "
        continue
      }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      inWord = true
      unquoted += " "
      continue
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[++i]!
      inWord = true
      unquoted += "  "
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      unquoted += ch
      continue
    }
    if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      flush()
      const op = command.slice(i, i + 2)
      words.push(op)
      unquoted += op
      i += 1
      continue
    }
    if (
      ch === "|" ||
      ch === ";" ||
      (ch === "&" && !unquoted.endsWith(">") && command[i + 1] !== ">")
    ) {
      flush()
      words.push(ch)
      unquoted += ch
      continue
    }
    current += ch
    inWord = true
    unquoted += ch
  }
  if (inWord) words.push(current)
  return { words, unquoted }
}

/** REQ-4.2: drop words that are data, not paths or flags — the message of
 * `git commit -m/--message`, the pattern of `git grep` (first non-option word or `-e`),
 * `git log --grep`, and `gh pr create/edit --title/--body`. */
const dropDataArguments = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  const kept: Array<string> = []
  let segment: Array<string> = []
  let skipNext = false
  let grepPatternSeen = false
  for (const word of words) {
    if (OPERATOR_WORDS.has(word)) {
      kept.push(word)
      segment = []
      skipNext = false
      grepPatternSeen = false
      continue
    }
    const program = segment.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    segment.push(word)
    if (skipNext) {
      skipNext = false
      continue
    }
    const sub = program[0] === "git" ? program[1] : undefined
    const ghSub = program[0] === "gh" ? program[1] : undefined
    if (sub === "commit" && (word === "-m" || word === "--message")) {
      skipNext = true
      continue
    }
    if (sub === "commit" && (/^-m./.test(word) || word.startsWith("--message="))) continue
    if (sub === "log" && word === "--grep") {
      skipNext = true
      continue
    }
    if (sub === "log" && word.startsWith("--grep=")) continue
    if (
      ghSub === "pr" &&
      (word === "-t" || word === "--title" || word === "-b" || word === "--body")
    ) {
      skipNext = true
      continue
    }
    if (sub === "grep" && word === "-e") {
      skipNext = true
      grepPatternSeen = true
      continue
    }
    if (sub === "grep" && !grepPatternSeen && word !== "--" && !word.startsWith("-")) {
      grepPatternSeen = true
      continue
    }
    kept.push(word)
  }
  return kept
}

export const toCommandView = (command: string): CommandView => {
  const { words, unquoted } = splitShellWords(command)
  return { argv: dropDataArguments(words).join(" "), unquoted }
}

/** REQ-3.1: a dotenv file referenced as a path token, including multi-dot names
 * (`.env.development.local`) and globs (`.env*`). It does not match identifiers
 * (`process.env`, `import.meta.env`) or templates (`.env.example`, `.env.template`,
 * `.env.sample`) — REQ-3.2. Evaluated on `CommandView.argv`. */
export const SECRET_FILE_PATTERN: RegExp =
  /(?:^|[\s=:/<>(])\.env(?:\.(?!(?:example|template|sample)(?:$|[\s/]))[\w*?-]+)*\*?(?=$|[\s/;|&)<>])/

/** REQ-2.1: the agent must not use the guard as an oracle to test candidate commands.
 * Hooks invoke the guard directly from the IDE, never through an agent shell command.
 * Flags between the entrypoint and `guard` (`pnpm harness -- guard`) are tolerated. */
export const GUARD_SELF_INVOCATION_PATTERN: RegExp =
  /(?:^|\s)harness(?:\s+-\S*)*\s+guard\b|harness-cli\/src\/index\.ts(?:\s+-\S*)*\s+guard\b/

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

/** REQ-3.3: a word split by a single-character bracket class (`[e]nv`, `e[n]v`, `[.]env`)
 * or by empty quotes (`r''m`, `.''env`) — the forms used to slip past substring rules.
 * Evaluated on the raw command. */
export const OBFUSCATION_PATTERNS: ReadonlyArray<GuardPatternRule> = [
  {
    pattern: /\[[^\]\s]\](?=[\w.])|(?<=[\w.])\[[^\]\s]\]/,
    reason: "single-character bracket class inside a word",
  },
  { pattern: /(?<=[\w.])(?:''|"")(?=[\w.])/, reason: "empty quotes inside a word" },
]

const containsToken = (command: string, token: string): boolean =>
  command.toLowerCase().includes(token.toLowerCase())

const matchesAny = (command: string, rules: ReadonlyArray<GuardPatternRule>): boolean =>
  rules.some((rule) => rule.pattern.test(command))

export const isCommandAllowed = (command: string): boolean => {
  const stripped = command
    .trim()
    .replace(
      /^(?:(?:CI|NX_INTERACTIVE|(?!HARNESS_STATE_DIR=|HARNESS_DISABLE_LIVE_TELEMETRY=|HARNESS_TEST_ISOLATION=)HARNESS_[A-Z0-9_]+)=[^\s;|&]+\s+)+/,
      "",
    )
  const trimmed = stripped.trim()
  if (trimmed === "") return false
  return ALLOWLIST.some((prefix) => {
    if (trimmed === prefix) return true
    if (prefix.endsWith(" ") || prefix.endsWith("/")) return trimmed.startsWith(prefix)
    return trimmed.startsWith(prefix + " ")
  })
}

const WRAPPER_BINARIES: ReadonlySet<string> = new Set("pnpm npm npx pnpx yarn bun bunx".split(" "))
const WRAPPER_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "--filter -F --dir -C --prefix --package -p --loglevel --reporter --store-dir --cache-dir --config -c --userconfig".split(
    " ",
  ),
)
const WRAPPER_SUBCOMMANDS: ReadonlySet<string> = new Set(["exec", "run", "dlx"])
const ENV_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "-u -C -S --unset --chdir --split-string".split(" "),
)
const ENV_SIMPLE_FLAGS: ReadonlySet<string> = new Set(
  "-i --ignore-environment -0 --null".split(" "),
)

const binaryBasename = (word: string): string =>
  word.includes("/") ? word.slice(word.lastIndexOf("/") + 1) : word

interface UnwrappedSegment {
  readonly envAssignments: ReadonlyArray<string>
  readonly commandWords: ReadonlyArray<string>
  readonly sawPackageRunner: boolean
}

const unwrapCommandSegment = (words: ReadonlyArray<string>): UnwrappedSegment => {
  const envAssignments: Array<string> = []
  let sawPackageRunner = false
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    const base = binaryBasename(w)
    if (base === "env") {
      i++
      while (i < words.length) {
        const arg = words[i]!
        if (arg === "--") {
          i++
          break
        }
        if (ENV_VALUE_FLAGS.has(arg)) {
          i += 2
          continue
        }
        if (
          ENV_SIMPLE_FLAGS.has(arg) ||
          arg.startsWith("--unset=") ||
          arg.startsWith("--chdir=") ||
          arg.startsWith("--split-string=")
        ) {
          i++
          continue
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          envAssignments.push(arg)
          i++
          continue
        }
        break
      }
      continue
    }
    if (base === "command") {
      i++
      while (i < words.length) {
        const arg = words[i]!
        if (arg === "--") {
          i++
          break
        }
        if (arg === "-p") {
          i++
          continue
        }
        break
      }
      continue
    }
    if (base === "cross-env" || base === "builtin") {
      i++
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      envAssignments.push(w)
      i++
      continue
    }
    if (WRAPPER_BINARIES.has(base)) {
      sawPackageRunner = true
      i++
      while (i < words.length) {
        const arg = words[i]!
        if (WRAPPER_VALUE_FLAGS.has(arg)) {
          i += 2
          continue
        }
        if (arg === "--") {
          i++
          break
        }
        if (
          arg.startsWith("-") ||
          WRAPPER_SUBCOMMANDS.has(arg) ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)
        ) {
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) envAssignments.push(arg)
          i++
          continue
        }
        break
      }
      continue
    }
    break
  }
  return {
    envAssignments,
    commandWords: words.slice(i),
    sawPackageRunner,
  }
}

const extractCommandSegments = (command: string): ReadonlyArray<UnwrappedSegment> => {
  const segments: Array<UnwrappedSegment> = []
  for (const line of command.split(/\r?\n/)) {
    const view = toCommandView(line)
    for (const rawSeg of view.argv.split(/\s*(?:&&|\|\||[;|&])\s*/)) {
      const cleanedSeg = rawSeg.replace(/^[()\s]+|[()\s]+$/g, "")
      const words = cleanedSeg
        .split(/\s+/)
        .map((w) => w.replace(/^[()]+|[()]+$/g, ""))
        .filter(Boolean)
      if (words.length > 0) {
        segments.push(unwrapCommandSegment(words))
      }
    }
  }
  return segments
}

export const isCdCommand = (trimmed: string): boolean =>
  extractCommandSegments(trimmed).some((seg) => seg.commandWords[0] === "cd")

export const INTERACTIVE_NX_BANNED_REASON =
  "Running 'nx show' without 'CI=true' can hang on interactive prompts; prefix with 'CI=true' or use harness MCP tools."

export const SKIP_NX_CACHE_BANNED_REASON =
  "Bypassing Nx cache with '--skip-nx-cache' is banned by harness policy in routine runs; set 'HARNESS_ALLOW_SKIP_NX_CACHE=1' only when intentionally benchmarking cold builds."

const SKIP_NX_CACHE_ARG_PATTERN = /^--skip-nx-cache(?:=(?!false$).*)?$/

export const isSkipNxCacheCommand = (command: string): boolean =>
  extractCommandSegments(command).some((seg) => {
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
    if (seg.envAssignments.includes("HARNESS_ALLOW_SKIP_NX_CACHE=1")) {
      return false
    }
    return seg.commandWords.slice(1).some((arg) => SKIP_NX_CACHE_ARG_PATTERN.test(arg))
  })

export const CLEF_SYSTEMONE_ONLY_BANNED_REASON =
  "clef (clef-flash) is a TypeSafe System One structured decision model, NOT a generative text/chat model — /api/generate, /api/chat, /v1/chat/completions, /v1/completions, and 'ollama run clef*' do not exist for System One models and return HTTP errors. Use DecisionModel.decide (@effect/ai-typesafe TypeSafeDecisionModel) or POST http://localhost:11434/v1/systemone ({ model: 'clef-flash', state, questions }), or run 'pnpm harness doctor' to warm/verify the model."

const IGNORED_CLEF_GUARD_BINARIES: ReadonlySet<string> = new Set([
  "grep",
  "rg",
  "git",
  "gh",
  "vitest",
])

const CLEF_HTTP_OR_SCRIPT_BINARIES: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "fetch",
  "python",
  "python3",
  "node",
  "bun",
  "tsx",
  "deno",
])

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

/** Rule order is load-bearing (harness:ADR-0003): deny → ask → escalate → allow.
 * Every rule that removes the automatic `allow` must run before the prefix allowlist. */
export const classifyCommand = (command: string): GuardVerdict => {
  const trimmed = command.trim()
  if (trimmed === "") {
    return "escalate"
  }
  if (isCdCommand(trimmed)) {
    return "deny"
  }
  if (isInteractiveNxCommand(trimmed)) {
    return "deny"
  }
  if (isSkipNxCacheCommand(trimmed)) {
    return "deny"
  }
  if (isInvalidClefEndpointCommand(trimmed)) {
    return "deny"
  }
  const view = toCommandView(command)
  if (
    DENYLIST.some((entry) => containsToken(view.argv, entry.token)) ||
    /\bgit\s+(?:\S+\s+)*push\b.*(?:\s|^)(?:--force|-f)(?:\s|$)/.test(view.argv)
  ) {
    return "deny"
  }
  if (SECRET_FILE_PATTERN.test(view.argv) || GUARD_SELF_INVOCATION_PATTERN.test(view.argv)) {
    return "deny"
  }
  if (
    ASKLIST.some((token) => containsToken(view.argv, token)) ||
    matchesAny(view.argv, GIT_DISCARD_PATTERNS)
  ) {
    return "ask"
  }
  if (
    matchesAny(view.argv, DESTRUCTIVE_ARGUMENT_PATTERNS) ||
    FILE_REDIRECTION_PATTERN.test(view.unquoted) ||
    matchesAny(command, OBFUSCATION_PATTERNS) ||
    /\$\(|`/.test(view.argv)
  ) {
    return "escalate"
  }
  if (SHELL_OPERATORS.some((op) => command.includes(op))) {
    const isAllowedFilter = (p: string): boolean =>
      p.startsWith("grep ") ||
      p.startsWith("head ") ||
      p.startsWith("tail ") ||
      p.startsWith("wc ") ||
      p.startsWith("cat ") ||
      p === "cat" ||
      p.startsWith("sort ") ||
      p === "sort"

    const isAllowedPipedSegment = (seg: string): boolean => {
      if (!seg.includes("|") || seg.includes("||")) {
        return false
      }
      const parts = seg.split("|").map((p) => p.trim())
      return (
        parts.length >= 2 && isCommandAllowed(parts[0]!) && parts.slice(1).every(isAllowedFilter)
      )
    }

    if (
      command.includes("|") &&
      !command.includes("||") &&
      !command.includes("&&") &&
      !command.includes(";") &&
      !command.includes("\n")
    ) {
      if (isAllowedPipedSegment(command)) {
        return "allow"
      }
    }
    if (
      command.includes("&&") &&
      !command.includes("||") &&
      !command.includes(";") &&
      !command.includes("\n")
    ) {
      const parts = command.split("&&").map((p) => p.trim())
      if (
        parts.length >= 2 &&
        parts.every(
          (p) =>
            p.length > 0 &&
            (isCommandAllowed(p) || isAllowedPipedSegment(p)) &&
            !/^\s*git\s+(?:add|commit|push)\b/.test(p),
        )
      ) {
        return "allow"
      }
    }
    return "escalate"
  }
  return isCommandAllowed(command) ? "allow" : "escalate"
}

export const CD_COMMAND_BANNED_REASON =
  "Shell 'cd' commands are banned by harness policy; use the tool Cwd parameter instead."

export const explainCommandDenyReason = (command: string): string | undefined => {
  const trimmed = command.trim()
  if (isCdCommand(trimmed)) {
    return CD_COMMAND_BANNED_REASON
  }
  if (isInteractiveNxCommand(trimmed)) {
    return INTERACTIVE_NX_BANNED_REASON
  }
  if (isSkipNxCacheCommand(trimmed)) {
    return SKIP_NX_CACHE_BANNED_REASON
  }
  if (isInvalidClefEndpointCommand(trimmed)) {
    return CLEF_SYSTEMONE_ONLY_BANNED_REASON
  }
  return undefined
}

export interface FileWriteGuardResult {
  readonly verdict: "allow" | "deny" | "ask"
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
      reason: `Protected read-only subtree cannot be modified: ${filePath}`,
    }
  }

  if (candidates.some((p) => /(^|\/)\.harness\/(worktrees\/[^/]+\/)?verify-stamp\.json$/.test(p))) {
    return {
      verdict: "deny",
      reason: `Direct modification of verify-stamp.json is forbidden (stamp forgery protection): ${filePath}`,
    }
  }

  if (candidates.some((p) => /(^|\/)\.harness\/(worktrees\/[^/]+\/)?mutate-stamp\.json$/.test(p))) {
    return {
      verdict: "deny",
      reason: `Direct modification of mutate-stamp.json is forbidden (stamp forgery protection): ${filePath}`,
    }
  }

  if (
    candidates.some((p) =>
      /(^|\/)\.harness\/(worktrees\/[^/]+\/)?(cache\/mutation-cache-v1\.json|session-preinvocation-cache\.json)$/.test(
        p,
      ),
    )
  ) {
    return {
      verdict: "deny",
      reason: `Direct modification of harness cache file is forbidden: ${filePath}`,
    }
  }

  if (
    candidates.some(
      (p) =>
        /(^|\/)(\.env(\.[a-zA-Z0-9_-]+)*|\.dev\.vars|.*\.(pem|key))$/.test(p) &&
        !/\.(example|template|sample)$/i.test(p),
    )
  ) {
    return {
      verdict: "deny",
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
