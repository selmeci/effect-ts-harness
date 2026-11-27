/** Zero-dependency fast-path command rules shared by `policy-command-rules.ts` and `policy.ts`
 * under the `policy-zero-dep` closure profile. */
import * as path from "node:path"
import { match } from "ts-pattern"
import {
  FILE_REDIRECTION_PATTERN,
  PNPM_VALUE_FLAGS,
  SECRET_FILE_PATTERN,
  WORKTREE_ID_BLOCKED_HARNESS_PATTERN,
} from "./policy-command-lists.js"

const SHELL_VAR_START_PATTERN = /[A-Za-z_@*#?$!0-9{]/
const READONLY_VAR_CONSUMER_BINS: ReadonlySet<string> = new Set(["wc", "rg", "sed", "df"])
const READONLY_INSPECTION_BINS: ReadonlySet<string> = new Set([
  "wc",
  "df",
  "ls",
  "pwd",
  "head",
  "tail",
  "cat",
  "cut",
  "grep",
])
const READONLY_PIPE_FILTER_BINS: ReadonlySet<string> = new Set([
  "grep",
  "head",
  "tail",
  "wc",
  "cat",
  "cut",
])
const READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "rev-parse",
  "log",
  "branch",
  "show",
  "ls-files",
  "merge-base",
  "remote",
])
const READONLY_VAR_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff", "rev-parse"])
const SAFE_PNPM_DIR_TARGETS: ReadonlySet<string> = new Set(["typecheck", "lint", "vitest", "test"])
const SAFE_OXFMT_FLAGS: ReadonlySet<string> = new Set([
  "--write",
  "--check",
  "--list-different",
  "--no-error-on-unmatched-pattern",
])
const SAFE_SED_FLAGS: ReadonlySet<string> = new Set([
  "--quiet",
  "--silent",
  "--regexp-extended",
  "--posix",
  "--sandbox",
  "--unbuffered",
  "--zero-terminated",
  "--null-data",
  "--separate",
])
const SAFE_SED_SHORT_CHARS: ReadonlySet<string> = new Set(["r", "E", "u", "z", "s"])
const SAFE_SED_COMMANDS: ReadonlySet<string> = new Set([
  "p",
  "P",
  "d",
  "D",
  "n",
  "N",
  "h",
  "H",
  "g",
  "G",
  "x",
  "q",
  "Q",
  "=",
  "l",
  "z",
])

const PROTECTED_OR_SECRET_PATH_RE =
  /(^|\/)(?:\.harness(?:\/|$)|\.git(?:\/|$)|\.oxlintrc\.json$|tools\/oxlint(?:\/|$)|repos\/(?:effect|alchemy)(?:\/|$)|\.cache\/effect-harness(?:\/|$))/i
const SECRET_BASENAME_RE =
  /(^|\/)(?:\.env(?:\.[^/]*)?|\.dev\.vars(?:\.[^/]*)?|mutation-hmac[^/]*\.key|auth-tokens?\.json|.*\.(?:pem|key))$/i
const SECRET_EXAMPLE_SUFFIX_RE = /\.(?:example|template|sample)$/i

export const splitCommandTokens = (command: string): ReadonlyArray<string> => {
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
      const escaped = match(quote)
        .with('"', () => {
          if (ch === "\\" && i + 1 < command.length) {
            current += command[++i]!
            return true
          }
          return false
        })
        .with("'", () => false)
        .exhaustive()
      if (escaped) continue
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

export const hasExpandableShellVariable = (rawSegment: string): boolean => {
  let quote: "'" | '"' | undefined
  for (let i = 0; i < rawSegment.length; i++) {
    const ch = rawSegment[i]!
    const handled = match(quote)
      .with("'", () => {
        if (ch === "'") quote = undefined
        return "continue" as const
      })
      .with('"', () => {
        if (ch === "\\") {
          i++
          return "continue" as const
        }
        if (ch === '"') {
          quote = undefined
          return "continue" as const
        }
        const next = rawSegment[i + 1]
        if (ch === "$" && next !== undefined && SHELL_VAR_START_PATTERN.test(next)) {
          return "true" as const
        }
        return "continue" as const
      })
      .with(undefined, () => {
        if (ch === "\\") {
          i++
          return "continue" as const
        }
        if (ch === "'" || ch === '"') {
          quote = ch
          return "continue" as const
        }
        const next = rawSegment[i + 1]
        if (ch === "$" && next !== undefined && SHELL_VAR_START_PATTERN.test(next)) {
          return "true" as const
        }
        return "continue" as const
      })
      .exhaustive()
    if (handled === "true") return true
  }
  return false
}

export const isSafeFastpathToken = (raw: string): boolean => {
  if (raw.length === 0 || /[\0\r\n]/.test(raw)) return false
  const slashNorm = raw.replace(/\\/g, "/")
  if (slashNorm.includes("..")) return false
  const norm = path.posix.normalize(slashNorm)
  if (SECRET_FILE_PATTERN.test(raw) || SECRET_FILE_PATTERN.test(norm)) return false
  if (
    (SECRET_BASENAME_RE.test(slashNorm) || SECRET_BASENAME_RE.test(norm)) &&
    !SECRET_EXAMPLE_SUFFIX_RE.test(norm)
  ) {
    return false
  }
  if (PROTECTED_OR_SECRET_PATH_RE.test(slashNorm) || PROTECTED_OR_SECRET_PATH_RE.test(norm)) {
    return false
  }
  return true
}

const scanDelimitedSection = (expr: string, startIdx: number, delim: string): number => {
  for (let i = startIdx; i < expr.length; i++) {
    const ch = expr[i]!
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === delim) return i
  }
  return -1
}

const isSafeReadOnlySedExpression = (expr: string): boolean => {
  if (expr.length === 0) return false
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!
    if (/[\s\d,$+~!;{}]/.test(ch)) continue
    if (ch === "/") {
      const close = scanDelimitedSection(expr, i + 1, "/")
      if (close === -1) return false
      i = Math.max(i, close)
      continue
    }
    if (ch === "\\") {
      const delim = expr[i + 1]
      if (delim === undefined) return false
      const close = scanDelimitedSection(expr, i + 2, delim)
      if (close === -1) return false
      i = Math.max(i, close)
      continue
    }
    if (ch === "s" || ch === "y") {
      const delim = expr[i + 1]
      if (delim === undefined || /\s/.test(delim)) return false
      const mid = scanDelimitedSection(expr, i + 2, delim)
      if (mid === -1) return false
      const end = scanDelimitedSection(expr, mid + 1, delim)
      if (end === -1) return false
      let j = end + 1
      if (ch === "s") {
        while (j < expr.length && !/[\s;}\n]/.test(expr[j]!)) {
          const flag = expr[j]!
          if (!/[gpImM0-9]/.test(flag)) return false
          j++
        }
      }
      i = Math.max(i, j - 1)
      continue
    }
    if (!SAFE_SED_COMMANDS.has(ch)) return false
  }
  return true
}

/** Validates read-only `sed -n` / `--quiet` / `--silent` commands while rejecting `-i`, `-f`, and `w`/`W`/`e` scripts. */
export const isSafeSedReadOnlyCommand = (tokens: ReadonlyArray<string>): boolean => {
  if (tokens[0] !== "sed") return false
  let sawQuiet = false
  let afterDoubleDash = false
  const expressions: Array<string> = []
  const fileArgs: Array<string> = []

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (!afterDoubleDash && tok === "--") {
      afterDoubleDash = true
      continue
    }
    if (!afterDoubleDash && tok.startsWith("-") && tok.length > 1) {
      if (tok === "--quiet" || tok === "--silent") {
        sawQuiet = true
        continue
      }
      if (tok === "--expression") {
        const next = tokens[++i]
        if (next === undefined) return false
        expressions.push(next)
        continue
      }
      if (tok.startsWith("--expression=")) {
        expressions.push(tok.slice("--expression=".length))
        continue
      }
      if (SAFE_SED_FLAGS.has(tok)) continue
      if (tok.startsWith("--")) return false
      for (let j = 1; j < tok.length; j++) {
        const ch = tok[j]!
        if (ch === "n") {
          sawQuiet = true
          continue
        }
        if (ch === "e") {
          const inlineExpr = tok.slice(j + 1)
          if (inlineExpr.length > 0) {
            expressions.push(inlineExpr)
          } else {
            const next = tokens[++i]
            if (next === undefined) return false
            expressions.push(next)
          }
          break
        }
        if (!SAFE_SED_SHORT_CHARS.has(ch)) return false
      }
      continue
    }
    if (expressions.length === 0 && !afterDoubleDash) {
      expressions.push(tok)
    } else {
      fileArgs.push(tok)
    }
  }

  return (
    sawQuiet &&
    expressions.length >= 1 &&
    expressions.every(isSafeReadOnlySedExpression) &&
    fileArgs.every(isSafeFastpathToken)
  )
}

/** Validates `pnpm --dir <safe>` / `-C <safe>` commands scoped strictly to `typecheck`, `lint`, `vitest`, or `test`. */
export const isSafePnpmDirScopedCommand = (trimmed: string, sawWorktreeId: boolean): boolean => {
  const tokens = splitCommandTokens(trimmed)
  if (tokens[0] !== "pnpm") return false
  if (
    sawWorktreeId &&
    (WORKTREE_ID_BLOCKED_HARNESS_PATTERN.test(trimmed) ||
      tokens.some((tok) => /(?:^|[=,/:.{*'"@])harness-cli(?:$|[=,/:.}*'"@])/.test(tok)))
  ) {
    return false
  }
  const dirPaths: Array<string> = []
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (tok === "--") {
      i++
      break
    }
    if (tok === "--dir" || tok === "-C") {
      const dirVal = tokens[i + 1]
      if (dirVal === undefined) return false
      dirPaths.push(dirVal)
      i += 2
      continue
    }
    if (tok.startsWith("--dir=")) {
      dirPaths.push(tok.slice("--dir=".length))
      i++
      continue
    }
    if (tok.startsWith("-C=")) {
      dirPaths.push(tok.slice("-C=".length))
      i++
      continue
    }
    if (tok.startsWith("-C") && tok.length > 2) {
      dirPaths.push(tok.slice(2))
      i++
      continue
    }
    if (tok === "--script-shell" || tok.startsWith("--script-shell=")) return false
    if (PNPM_VALUE_FLAGS.has(tok)) {
      i += 2
      continue
    }
    if (tok.startsWith("-")) {
      i++
      continue
    }
    break
  }
  if (dirPaths.length === 0 || !dirPaths.every(isSafeFastpathToken)) return false
  const targetIdx = match(tokens[i])
    .with("run", "run-script", "exec", () => (tokens[i + 1] === "--" ? i + 2 : i + 1))
    .otherwise(() => i)
  const target = tokens[targetIdx]
  if (target === undefined || !SAFE_PNPM_DIR_TARGETS.has(target)) return false
  return tokens
    .slice(targetIdx)
    .every((arg) => !arg.includes("..") && !/--skip-?nx-?cache/i.test(arg))
}

/** Returns true when `tokens` represents a `pnpm oxfmt` or `pnpm exec [--] oxfmt` invocation. */
export const extractPnpmOxfmtArgs = (
  tokens: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  if (tokens[0] !== "pnpm") return undefined
  if (tokens[1] === "oxfmt") return tokens.slice(2)
  if (tokens[1] === "exec") {
    if (tokens[2] === "oxfmt") return tokens.slice(3)
    if (tokens[2] === "--" && tokens[3] === "oxfmt") return tokens.slice(4)
  }
  return undefined
}

/** Validates explicit-path `pnpm oxfmt --write|--check <safe-paths>` commands while rejecting secrets, `..`, and `repos/(effect|alchemy)`. */
export const isSafePnpmOxfmtExplicitCommand = (trimmed: string): boolean => {
  const tokens = splitCommandTokens(trimmed)
  const oxfmtArgs = extractPnpmOxfmtArgs(tokens)
  if (oxfmtArgs === undefined) return false
  let sawMode = false
  let afterDoubleDash = false
  const paths: Array<string> = []
  for (const arg of oxfmtArgs) {
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true
      continue
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (SAFE_OXFMT_FLAGS.has(arg)) {
        if (arg === "--write" || arg === "--check" || arg === "--list-different") sawMode = true
        continue
      }
      if (/^--threads=\d+$/.test(arg)) continue
      return false
    }
    paths.push(arg)
  }
  return sawMode && paths.length >= 1 && paths.every(isSafeFastpathToken)
}

const isSafeGitInspectionTokens = (
  tokens: ReadonlyArray<string>,
  allowedSubcommands: ReadonlySet<string>,
): boolean => {
  const sub = tokens[1]
  if (sub === undefined || !allowedSubcommands.has(sub)) return false
  const args = tokens.slice(2)
  if (args.some((a) => /^--output(?:=|$)/.test(a))) return false
  if (sub === "branch") {
    if (
      args.some((a) =>
        /^(?:-[dDmMcC]|--delete|--move|--copy|--set-upstream-to|--unset-upstream)(?:=|$)/.test(a),
      )
    ) {
      return false
    }
  }
  if (sub === "remote") {
    const pos = args.filter((a) => !a.startsWith("-"))
    if (pos.length > 0 && pos[0] !== "show" && pos[0] !== "get-url") return false
  }
  return args.every((tok) => tok.startsWith("-") || isSafeFastpathToken(tok))
}

const isSafeInspectionTokens = (
  tokens: ReadonlyArray<string>,
  sawWorktreeId: boolean,
  strictVarConsumerOnly: boolean,
): boolean => {
  const head = tokens[0] ?? ""
  if (head === "sed") return isSafeSedReadOnlyCommand(tokens)
  if (head === "rg") {
    if (tokens.some((t) => /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/.test(t))) return false
    return tokens.slice(1).every((t) => !SECRET_FILE_PATTERN.test(t) && !t.includes(".."))
  }
  if (head === "git") {
    return isSafeGitInspectionTokens(
      tokens,
      strictVarConsumerOnly ? READONLY_VAR_GIT_SUBCOMMANDS : READONLY_GIT_SUBCOMMANDS,
    )
  }
  if (READONLY_VAR_CONSUMER_BINS.has(head)) {
    return tokens.slice(1).every((tok) => tok.startsWith("-") || isSafeFastpathToken(tok))
  }
  if (strictVarConsumerOnly) return false
  if (head === "sort") {
    if (tokens.slice(1).some((t) => /^(?:-[^-]*o|--output(?:=|$))/.test(t))) return false
    return tokens.slice(1).every((tok) => tok.startsWith("-") || isSafeFastpathToken(tok))
  }
  if (head === "pnpm") {
    return !sawWorktreeId && tokens[1] === "harness" && tokens[2] === "session"
  }
  if (READONLY_INSPECTION_BINS.has(head)) {
    return tokens.slice(1).every((tok) => tok.startsWith("-") || isSafeFastpathToken(tok))
  }
  return false
}

const isSafeReadOnlyPipeFilterTokens = (tokens: ReadonlyArray<string>): boolean => {
  const head = tokens[0] ?? ""
  if (head === "sed") return isSafeSedReadOnlyCommand(tokens)
  if (head === "rg") {
    return !tokens.some((t) => /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/.test(t))
  }
  if (head === "sort") {
    return !tokens.slice(1).some((t) => /^(?:-[^-]*o|--output(?:=|$))/.test(t))
  }
  return READONLY_PIPE_FILTER_BINS.has(head)
}

/** Validates a single (or piped) strictly read-only inspection segment. */
export const isSafeReadOnlyInspectionSegment = (
  cmd: string,
  stripEnv: (c: string) => { readonly rest: string; readonly sawWorktreeId: boolean },
  splitUnquotedPipe?: (c: string) => ReadonlyArray<string> | undefined,
): boolean => {
  const { rest, sawWorktreeId } = stripEnv(cmd.trim())
  if (rest === "" || hasExpandableShellVariable(rest) || /\$\(|`|<\(|>\(/.test(rest)) {
    return false
  }
  const pipeParts = splitUnquotedPipe?.(rest)
  if (pipeParts !== undefined) {
    return (
      pipeParts.length >= 2 &&
      isSafeInspectionTokens(splitCommandTokens(pipeParts[0]!), sawWorktreeId, false) &&
      pipeParts.slice(1).every((part) => isSafeReadOnlyPipeFilterTokens(splitCommandTokens(part)))
    )
  }
  return isSafeInspectionTokens(splitCommandTokens(rest), sawWorktreeId, false)
}

const splitByUnquotedSep = (
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
  parts.push({ cmd: command.slice(start).trim(), unquoted: unquoted.slice(start).trim() })
  return parts
}

/** Approves `;` chains only when every segment is a strictly read-only inspection command. */
export const isSafeSemicolonReadOnlyChain = (
  command: string,
  unquoted: string,
  stripEnv: (c: string) => { readonly rest: string; readonly sawWorktreeId: boolean },
  splitUnquotedPipe?: (c: string) => ReadonlyArray<string> | undefined,
): boolean => {
  if (
    /(?<![>&])&(?![>&])/.test(unquoted) ||
    unquoted.includes("&&") ||
    unquoted.includes("||") ||
    unquoted.includes("\n") ||
    !unquoted.includes(";")
  ) {
    return false
  }
  const parts = splitByUnquotedSep(command, unquoted, ";")
  return (
    parts.length >= 2 &&
    parts.every(
      (p) =>
        p.cmd.length > 0 && isSafeReadOnlyInspectionSegment(p.cmd, stripEnv, splitUnquotedPipe),
    )
  )
}

interface RawShellWord {
  readonly raw: string
  readonly unquoted: string
}

const splitRawWordsPreservingQuotes = (
  segment: string,
): ReadonlyArray<RawShellWord> | undefined => {
  const out: Array<RawShellWord> = []
  let quote: "'" | '"' | undefined
  let start = -1
  let unquotedPart = ""
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined
        continue
      }
      const skipEscape = match(quote)
        .with('"', () => ch === "\\" && segment.length - i > 1)
        .with("'", () => false)
        .exhaustive()
      if (skipEscape) {
        i++
      }
      continue
    }
    if (/\s/.test(ch)) {
      if (start !== -1) {
        out.push({ raw: segment.slice(start, i), unquoted: unquotedPart })
        start = -1
        unquotedPart = ""
      }
      continue
    }
    if (start === -1) start = i
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === "\\" && segment.length - i > 1) {
      unquotedPart += segment[++i]!
      continue
    }
    unquotedPart += ch
  }
  if (quote !== undefined) return undefined
  if (start !== -1) out.push({ raw: segment.slice(start), unquoted: unquotedPart })
  return out
}

const expandWordWithVars = (
  rawWord: string,
  vars: ReadonlyMap<string, string>,
): { readonly expanded: string; readonly usedVar: boolean } | undefined => {
  let out = ""
  let usedVar = false
  let quote: "'" | '"' | undefined

  const consumeDollarOrLiteral = (idx: number, ch: string): number => {
    if (ch !== "$") {
      out += ch
      return idx
    }
    if (rawWord[idx + 1] === "{") {
      const close = rawWord.indexOf("}", idx + 2)
      if (close === -1) return -1
      const varName = rawWord.slice(idx + 2, close)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return -1
      const val = vars.get(varName)
      if (val === undefined) return -1
      out += val
      usedVar = true
      return close
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rawWord.slice(idx + 1))
    if (m !== null) {
      const val = vars.get(m[1]!)
      if (val === undefined) return -1
      out += val
      usedVar = true
      return idx + m[1]!.length
    }
    if (rawWord[idx + 1] !== undefined && SHELL_VAR_START_PATTERN.test(rawWord[idx + 1]!)) {
      return -1
    }
    out += ch
    return idx
  }

  for (let i = 0; i < rawWord.length; i++) {
    const ch = rawWord[i]!
    const nextIdx = match(quote)
      .with("'", () => {
        if (ch === "'") quote = undefined
        else out += ch
        return i
      })
      .with('"', () => {
        if (ch === "\\" && rawWord.length - i > 1) {
          out += rawWord[++i]!
          return i
        }
        if (ch === '"') {
          quote = undefined
          return i
        }
        return consumeDollarOrLiteral(i, ch)
      })
      .with(undefined, () => {
        if (ch === "\\" && rawWord.length - i > 1) {
          out += rawWord[++i]!
          return i
        }
        if (ch === "'" || ch === '"') {
          quote = ch
          return i
        }
        return consumeDollarOrLiteral(i, ch)
      })
      .exhaustive()
    if (nextIdx < 0) return undefined
    i = Math.max(i, nextIdx)
  }
  return { expanded: out, usedVar }
}

/**
 * Approves simple `VAR=safe_literal; <readonly-consumer>` commands (where consumer is strictly
 * `wc`, `rg`, `sed -n`, `df`, or `git status`/`diff`/`rev-parse`) without command substitution,
 * redirection, obfuscation, or secret/protected paths.
 */
export const isSafeVariableExpandedReadOnlyCommand = (
  command: string,
  unquoted: string,
): boolean => {
  if (
    /\$\(|`|<\(|>\(/.test(command) ||
    /(?<![>&])&(?![>&])/.test(unquoted) ||
    unquoted.includes("||") ||
    FILE_REDIRECTION_PATTERN.test(unquoted)
  ) {
    return false
  }
  const sepRe = /&&|[;\n]/g
  const segments: Array<string> = []
  let start = 0
  let m = sepRe.exec(unquoted)
  while (m !== null) {
    const part = command.slice(start, m.index).trim()
    if (part.length === 0) return false
    segments.push(part)
    start = m.index + m[0].length
    m = sepRe.exec(unquoted)
  }
  const tail = command.slice(start).trim()
  if (tail.length === 0) return false
  segments.push(tail)
  if (segments.length < 2) return false

  const vars = new Map<string, string>()
  let sawAssignment = false
  let sawConsumer = false

  for (const seg of segments) {
    const rawWords = splitRawWordsPreservingQuotes(seg)
    if (rawWords === undefined || rawWords.length === 0) return false
    const allAssignments = rawWords.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.raw))
    if (allAssignments) {
      for (const w of rawWords) {
        const eqIdx = w.raw.indexOf("=")
        const varName = w.raw.slice(0, eqIdx)
        const rawVal = w.raw.slice(eqIdx + 1)
        if (hasExpandableShellVariable(rawVal)) return false
        const decoded = splitCommandTokens(rawVal)[0] ?? ""
        if (!isSafeFastpathToken(decoded)) return false
        vars.set(varName, decoded)
        sawAssignment = true
      }
      continue
    }
    if (!sawAssignment) return false
    const expandedTokens: Array<string> = []
    for (let idx = 0; idx < rawWords.length; idx++) {
      const exp = expandWordWithVars(rawWords[idx]!.raw, vars)
      if (exp === undefined) return false
      if (idx === 0 && exp.usedVar) return false
      if (idx === 1 && expandedTokens[0] === "git" && exp.usedVar) return false
      expandedTokens.push(exp.expanded)
    }
    if (!isSafeInspectionTokens(expandedTokens, false, true)) return false
    sawConsumer = true
  }
  return sawAssignment && sawConsumer
}
