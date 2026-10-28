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
  "git show",
  "git stash",
  "git grep",
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
  { token: ".env", reason: "secret file access" },
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

const containsToken = (command: string, token: string): boolean =>
  command.toLowerCase().includes(token.toLowerCase())

export const isCommandAllowed = (command: string): boolean => {
  const trimmed = command.trim()
  if (trimmed === "") return false
  return ALLOWLIST.some((prefix) => {
    if (trimmed === prefix) return true
    if (prefix.endsWith(" ")) return trimmed.startsWith(prefix)
    return trimmed.startsWith(prefix + " ")
  })
}

export const classifyCommand = (command: string): GuardVerdict => {
  for (const entry of DENYLIST) {
    if (containsToken(command, entry.token)) {
      return "deny"
    }
  }
  if (ASKLIST.some((token) => containsToken(command, token))) {
    return "ask"
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
