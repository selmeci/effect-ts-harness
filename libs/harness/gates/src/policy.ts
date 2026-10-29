/** Deterministic guard policy. `classifyCommand` never calls the decision model:
 * "escalate" means "deterministic rules left this open" (mvp.md, safety guard row);
 * "ask" means "always confirm with the human first" (alchemy deploy/destroy/profile,
 * matching Alchemy's own advice to confirm every deploy). */

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
  "pnpm build",
  "CI=true pnpm nx ",
  "CI=true pnpm test",
  "CI=true pnpm verify",
  "CI=true pnpm harness",
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
  "git commit",
  "git fetch",
  "git push",
  "git show",
  "git stash",
  "git grep",
  "gh pr",
  "gh repo",
  "gh auth",
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
  "omnigraph ",
  "omnigraph-server"
]

export const DENYLIST: ReadonlyArray<{ readonly token: string; readonly reason: string }> = [
  { token: "rm -rf", reason: "destructive delete" },
  { token: "push --force", reason: "force push" },
  { token: "push -f", reason: "force push" }
]

/** Human confirmation required, never auto-approved (mvp.md "Infrastructure as Effect",
 * safety guard row). Substring match, so `pnpm alchemy deploy` is covered too. */
export const ASKLIST: ReadonlyArray<string> = [
  "alchemy deploy",
  "alchemy destroy",
  "alchemy profile"
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
  command: string
): { readonly words: ReadonlyArray<string>; readonly unquoted: string } => {
  const words: Array<string> = []
  let current = ""
  let inWord = false
  let quote: "'" | '"' | undefined
  let unquoted = ""
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
      if (inWord) {
        words.push(current)
        current = ""
        inWord = false
      }
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
    if (ghSub === "pr" && (word === "-t" || word === "--title" || word === "-b" || word === "--body")) {
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
    reason: "git checkout discarding working-tree changes"
  },
  { pattern: /\bgit\s+restore\b/, reason: "git restore discarding changes" },
  { pattern: /\bgit\s+stash\s+(?:drop|clear)\b/, reason: "git stash drop/clear" },
  {
    pattern: /\bgit\s+branch\s+(?:\S+\s+)*(?:-[Dd]|--delete)(?:\s|$)/,
    reason: "git branch deletion"
  },
  { pattern: /\bgit\s+clean\b/, reason: "git clean removing untracked files" },
  {
    pattern: /\bgit\s+switch\s+(?:\S+\s+)*(?:--discard-changes|-f|--force)(?:\s|$)/,
    reason: "git switch discarding changes"
  },
  { pattern: /\bgit\s+reset\s+(?:\S+\s+)*--hard\b/, reason: "git reset --hard" },
  {
    pattern: /\bgit\s+push\s+(?:\S+\s+)*(?:--delete|-d)(?:\s|$)/,
    reason: "git push deleting remote ref"
  }
]

/** REQ-1.1 / REQ-1.4: find actions that delete or execute. Evaluated on `CommandView.argv`,
 * so quoted flags (`'-delete'`) are caught. Checked BEFORE the prefix allowlist. */
export const DESTRUCTIVE_ARGUMENT_PATTERNS: ReadonlyArray<GuardPatternRule> = [
  {
    pattern: /\bfind\b.*\s-(?:delete|exec|execdir|ok|okdir)\b/,
    reason: "find action that deletes or executes"
  }
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
    reason: "single-character bracket class inside a word"
  },
  { pattern: /(?<=[\w.])(?:''|"")(?=[\w.])/, reason: "empty quotes inside a word" }
]

const containsToken = (command: string, token: string): boolean =>
  command.toLowerCase().includes(token.toLowerCase())

const matchesAny = (command: string, rules: ReadonlyArray<GuardPatternRule>): boolean =>
  rules.some((rule) => rule.pattern.test(command))

export const isCommandAllowed = (command: string): boolean => {
  const trimmed = command.trim()
  if (trimmed === "") return false
  return ALLOWLIST.some((prefix) => {
    if (trimmed === prefix) return true
    if (prefix.endsWith(" ")) return trimmed.startsWith(prefix)
    return trimmed.startsWith(prefix + " ")
  })
}

/** Rule order is load-bearing (harness:ADR-0003): deny → ask → escalate → allow.
 * Every rule that removes the automatic `allow` must run before the prefix allowlist. */
export const classifyCommand = (command: string): GuardVerdict => {
  const view = toCommandView(command)
  if (DENYLIST.some((entry) => containsToken(view.argv, entry.token))) {
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
    matchesAny(command, OBFUSCATION_PATTERNS)
  ) {
    return "escalate"
  }
  if (SHELL_OPERATORS.some((op) => command.includes(op))) {
    if (
      command.includes("|") &&
      !command.includes("||") &&
      !command.includes("&&") &&
      !command.includes(";") &&
      !command.includes("\n")
    ) {
      const parts = command.split("|").map((p) => p.trim())
      const isAllowedFilter = (p: string) =>
        p.startsWith("grep ") ||
        p.startsWith("head ") ||
        p.startsWith("tail ") ||
        p.startsWith("wc ") ||
        p.startsWith("cat ") ||
        p === "cat"
      if (
        parts.length >= 2 &&
        isCommandAllowed(parts[0]!) &&
        parts.slice(1).every(isAllowedFilter)
      ) {
        return "allow"
      }
    }
    return "escalate"
  }
  return isCommandAllowed(command) ? "allow" : "escalate"
}

export interface FileWriteGuardResult {
  readonly verdict: "allow" | "deny" | "ask"
  readonly reason?: string | undefined
}

export const classifyFileWrite = (filePath: string): FileWriteGuardResult => {
  const norm = filePath.replace(/\\/g, "/").trim()
  if (norm === "") {
    return { verdict: "allow" }
  }

  if (/(^|\/)repos\/(effect|alchemy)(\/|$)/.test(norm)) {
    return {
      verdict: "deny",
      reason: `Protected read-only subtree cannot be modified: ${filePath}`
    }
  }

  if (/(^|\/)\.harness\/(worktrees\/[^/]+\/)?verify-stamp\.json$/.test(norm)) {
    return {
      verdict: "deny",
      reason: `Direct modification of verify-stamp.json is forbidden (stamp forgery protection): ${filePath}`
    }
  }

  if (
    /(^|\/)(\.env(\.[a-zA-Z0-9_-]+)?|\.dev\.vars|.*\.(pem|key))$/.test(norm) &&
    !/\.(example|template|sample)$/i.test(norm)
  ) {
    return {
      verdict: "deny",
      reason: `Secret or credential file modification is forbidden by harness guard: ${filePath}`
    }
  }

  if (
    /(^|\/)(\.oxlintrc\.json|tools\/oxlint\/.*|libs\/harness\/graph\/policies\.cedar)$/.test(
      norm
    )
  ) {
    return {
      verdict: "ask",
      reason: `Modifying harness governance/linter policy requires human confirmation: ${filePath}`
    }
  }

  return { verdict: "allow" }
}
