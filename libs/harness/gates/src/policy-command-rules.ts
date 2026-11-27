/** Zero-dependency static guard rules, allowlists, denylists, and leading-env strippers
 * shared by `policy.ts` under the `policy-zero-dep` closure profile. */
import { match } from "ts-pattern"
import {
  extractPnpmOxfmtArgs,
  hasExpandableShellVariable,
  hasUnsafePnpmDirOrConfigFlags,
  isSafePnpmDirScopedCommand,
  isSafePnpmOxfmtExplicitCommand,
  isSafeSedReadOnlyCommand,
  isSafeVitestExecTokens,
  splitCommandTokens,
} from "./policy-fastpath-rules.js"

import {
  ALLOWLIST,
  NX_VALUE_FLAGS,
  PNPM_FILTER_DLX_PATTERN,
  PNPM_FILTER_EXEC_PATTERN,
  PNPM_VALUE_FLAGS,
  SAFE_GIT_CONFIG_GET_FLAGS,
  SAFE_GIT_SYMBOLIC_REF_FLAGS,
  SAFE_LEADING_ENV_VALUES,
  SAFE_PNPM_EXEC_PREFIXES,
  WORKTREE_ID_BLOCKED_HARNESS_PATTERN,
  type GuardPatternRule,
} from "./policy-command-lists.js"

export { hasExpandableShellVariable, splitCommandTokens }

export {
  ALLOWLIST,
  ASKLIST,
  CD_COMMAND_BANNED_REASON,
  DENYLIST,
  DESTRUCTIVE_ARGUMENT_PATTERNS,
  FILE_REDIRECTION_PATTERN,
  GIT_DISCARD_PATTERNS,
  GIT_FORCE_PUSH_PATTERN,
  GIT_PACK_EXEC_OVERRIDE_PATTERNS,
  GUARD_SELF_INVOCATION_PATTERN,
  INTERACTIVE_NX_BANNED_REASON,
  MAX_CLASSIFY_COMMAND_LENGTH,
  NX_VALUE_FLAGS,
  OBFUSCATION_PATTERNS,
  PNPM_FILTER_DLX_PATTERN,
  PNPM_FILTER_EXEC_PATTERN,
  PNPM_VALUE_FLAGS,
  SAFE_GIT_CONFIG_GET_FLAGS,
  SAFE_GIT_SYMBOLIC_REF_FLAGS,
  SAFE_LEADING_ENV_VALUES,
  SAFE_PNPM_EXEC_PREFIXES,
  SECRET_FILE_PATTERN,
  SHELL_OPERATORS,
  SKIP_NX_CACHE_BANNED_REASON,
  WORKTREE_ID_BLOCKED_HARNESS_PATTERN,
  type GuardPatternRule,
  type GuardVerdict,
} from "./policy-command-lists.js"

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

export const CASE_INSENSITIVE_GLOB_FLAG_PATTERN =
  /(?:^|\s)(?:-iname|-ipath|-iwholename|--iglob)(?:=|\s|$)/
export const UNQUOTED_BRACE_EXPANSION_PATTERN = /\{[^}\s]*(?:,|\.\.)[^}\s]*\}/

export const isHandledByUnquotedEscalate = (
  tok: string,
  rawCommand: string,
  unquoted: string,
): boolean => {
  if (/[*?]/.test(tok)) return false
  const bracketGroups = tok.match(/\[[^\]\s]+\]/g) ?? []
  const braceGroups = (tok.match(/\{[^}\s]+\}/g) ?? []).filter((g) => /(?:,|\.\.)/.test(g))
  if (bracketGroups.length === 0 && braceGroups.length === 0) return false
  if (
    bracketGroups.length > 0 &&
    (!bracketGroups.every((g) => unquoted.includes(g)) ||
      !hasUnquotedAdjacentBracketGlob(rawCommand, unquoted))
  ) {
    return false
  }
  if (
    braceGroups.length > 0 &&
    (!braceGroups.every((g) => unquoted.includes(g)) ||
      !UNQUOTED_BRACE_EXPANSION_PATTERN.test(unquoted))
  ) {
    return false
  }
  return true
}

export const matchesAny = (command: string, rules: ReadonlyArray<GuardPatternRule>): boolean =>
  rules.some((rule) => rule.pattern.test(command))

const MAX_LEADING_ENV_VARS = 32

const isSafeLeadingEnvAssignment = (name: string, value: string): boolean => {
  if (/[\s;|&]/.test(value)) return false
  if (!Object.hasOwn(SAFE_LEADING_ENV_VALUES, name)) return false
  return SAFE_LEADING_ENV_VALUES[name]!(value)
}

const LEADING_ENV_TOKEN_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)=([^\s;|&]+)(?=\s|$)/y
const LEADING_ENV_CMD_PATTERN = /env(?=\s|$)/y
const ENV_WORD_PATTERN = /([^\s;|&]+)/y

export interface StripLeadingEnvResult {
  readonly rest: string
  readonly sawWorktreeId: boolean
}

const isSafeLeadingEnvVarName = (name: string): boolean =>
  Object.hasOwn(SAFE_LEADING_ENV_VALUES, name)

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
  if (targetTokens[0] === "vitest" && !isSafeVitestExecTokens(targetTokens)) {
    return false
  }
  if (targetTokens[0] === "oxfmt") {
    return isSafePnpmOxfmtExplicitCommand(`pnpm oxfmt ${targetTokens.slice(1).join(" ")}`)
  }
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

const isSafeGitSymbolicRefCommand = (tokens: ReadonlyArray<string>): boolean => {
  let positionalCount = 0
  let afterDash = false
  for (let i = 2; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (afterDash) {
      positionalCount++
      continue
    }
    if (tok === "--") {
      afterDash = true
      continue
    }
    if (tok.startsWith("-")) {
      if (!SAFE_GIT_SYMBOLIC_REF_FLAGS.has(tok)) return false
      continue
    }
    positionalCount++
  }
  return positionalCount === 1
}

const isSafeGitConfigGetCommand = (tokens: ReadonlyArray<string>): boolean => {
  if (tokens[2] !== "--get") return false
  let positionalCount = 0
  let afterDash = false
  for (let i = 2; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (afterDash) {
      positionalCount++
      continue
    }
    if (tok === "--") {
      afterDash = true
      continue
    }
    if (tok === "--default" || tok === "--type") {
      if (i + 1 >= tokens.length) return false
      i++
      continue
    }
    if (tok.startsWith("--default=") || tok.startsWith("--type=")) {
      const eqIdx = tok.indexOf("=")
      if (tok.slice(eqIdx + 1).length === 0) return false
      continue
    }
    if (tok.startsWith("-")) {
      if (!SAFE_GIT_CONFIG_GET_FLAGS.has(tok)) return false
      continue
    }
    positionalCount++
  }
  return positionalCount >= 1 && positionalCount <= 2
}

const SAFE_XARGS_FLAGS: ReadonlySet<string> = new Set(["-0", "--null", "-r", "--no-run-if-empty"])
const SAFE_WC_FLAGS: ReadonlySet<string> = new Set(
  "-l -w -c -m -L --lines --words --bytes --chars --max-line-length".split(" "),
)
const SAFE_OXFMT_CHECK_FLAGS: ReadonlySet<string> = new Set(
  "--check --list-different --no-error-on-unmatched-pattern --".split(" "),
)
const OXLINT_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "-f --format --tsconfig --ignore-pattern -D --deny -A --allow -W --warn".split(" "),
)
const UNSAFE_OXLINT_FLAG_PATTERN =
  /^(?:--fix(?:=|-|$)|--fix-suggestions(?:=|$)|--fix-dangerously(?:=|$)|--write(?:=|$)|-w$|--output(?:=|$)|-o|-c(?:=|$)|-c[^=]|--config(?:=|$)|--import-plugin(?:=|$))/

const unwrapSafePnpmCheckPrefix = (
  consumer: ReadonlyArray<string>,
  targetBin: "oxfmt" | "oxlint",
): ReadonlyArray<string> | undefined => {
  if (consumer[0] === targetBin) return consumer.slice(1)
  if (consumer[0] === "pnpm" && consumer[1] === targetBin) return consumer.slice(2)
  if (consumer[0] === "pnpm" && consumer[1] === "exec") {
    if (consumer[2] === targetBin) return consumer.slice(3)
    if (consumer[2] === "--" && consumer[3] === targetBin) return consumer.slice(4)
  }
  return undefined
}

const isSafeOxfmtCheckArgs = (args: ReadonlyArray<string>): boolean => {
  let sawCheck = false
  for (const arg of args) {
    if (arg === "--check") sawCheck = true
    if (!SAFE_OXFMT_CHECK_FLAGS.has(arg)) return false
  }
  return sawCheck
}

const isSafeOxlintArgs = (args: ReadonlyArray<string>): boolean => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (UNSAFE_OXLINT_FLAG_PATTERN.test(arg)) return false
    if (arg === "--") {
      return i === args.length - 1
    }
    if (OXLINT_VALUE_FLAGS.has(arg)) {
      const val = args[++i]
      if (val === undefined || val.includes("..")) return false
      continue
    }
    const eqIdx = arg.indexOf("=")
    if (eqIdx > 0 && arg.startsWith("-")) {
      const flagName = arg.slice(0, eqIdx)
      const val = arg.slice(eqIdx + 1)
      if (OXLINT_VALUE_FLAGS.has(flagName)) {
        if (val.length === 0 || val.includes("..")) return false
        continue
      }
      if (val.includes("..")) return false
    }
    if (arg.startsWith("-")) continue
    return false
  }
  return true
}

/** Returns true when a piped `xargs` consumer uses strictly read-only flags and an allowlisted check command. */
export const isSafeReadOnlyXargsSegment = (command: string): boolean => {
  const { rest: trimmed } = stripSafeLeadingEnvVarsDetailed(command)
  if (trimmed === "" || hasExpandableShellVariable(trimmed) || /[`()]/.test(trimmed)) {
    return false
  }
  const tokens = splitCommandTokens(trimmed)
  if (tokens[0] !== "xargs") return false
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (tok === "--") {
      i++
      break
    }
    if (SAFE_XARGS_FLAGS.has(tok) || /^-[0r]+$/.test(tok)) {
      i++
      continue
    }
    if (tok.startsWith("-")) return false
    break
  }
  const consumer = tokens.slice(i)
  if (consumer.length === 0) return false
  if (consumer[0] === "wc") {
    return consumer
      .slice(1)
      .every((arg) => arg === "--" || SAFE_WC_FLAGS.has(arg) || /^-[lwcmL]+$/.test(arg))
  }
  const oxfmtArgs = unwrapSafePnpmCheckPrefix(consumer, "oxfmt")
  if (oxfmtArgs !== undefined) return isSafeOxfmtCheckArgs(oxfmtArgs)
  const oxlintArgs = unwrapSafePnpmCheckPrefix(consumer, "oxlint")
  if (oxlintArgs !== undefined) return isSafeOxlintArgs(oxlintArgs)
  return false
}

const SIMPLE_PIPE_FILTER_BINS: ReadonlySet<string> = new Set([
  "grep",
  "head",
  "tail",
  "wc",
  "cat",
  "cut",
])

const isSimpleSafePipeFilter = (segment: string): boolean => {
  const tokens = splitCommandTokens(segment.trim())
  const head = tokens[0]
  if (head === undefined) return false
  const joined = tokens.join(" ")
  if (SIMPLE_PIPE_FILTER_BINS.has(head)) return true
  if (head === "sed") return isSafeSedReadOnlyCommand(tokens)
  if (head === "rg") {
    return !/(?:^|\s)--(?:pre|pre-glob|hostname-bin)(?:=|\s|$)/.test(joined)
  }
  if (head === "sort") {
    return !/(?:^|\s)(?:-[^\s-]*o|--output(?:=|\s|$))/.test(joined)
  }
  return false
}

export const splitUnquotedPipeParts = (command: string): ReadonlyArray<string> | undefined => {
  const parts: Array<string> = []
  let quote: "'" | '"' | undefined
  let start = 0
  let sawPipe = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== undefined) {
      quote = match(quote)
        .with("'", () => (ch === "'" ? undefined : quote))
        .with('"', () => {
          if (ch === "\\" && i + 1 < command.length) i++
          return ch === '"' ? undefined : quote
        })
        .exhaustive()
      continue
    }
    if (ch === "\\" && i + 1 < command.length) {
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === "\n" || ch === ";" || command.startsWith("&&", i) || command.startsWith("||", i)) {
      return undefined
    }
    if (ch === "&" && command[i - 1] !== ">" && command[i + 1] !== ">") {
      return undefined
    }
    if (ch === "|" && command[i - 1] !== ">") {
      parts.push(command.slice(start, i).trim())
      start = i + 1
      sawPipe = true
    }
  }
  if (!sawPipe) return undefined
  parts.push(command.slice(start).trim())
  return parts
}

const EXPANDABLE_VAR_REJECTED_HEADS: ReadonlySet<string> = new Set(
  "echo wc cat head tail ls cut grep rg sed sort df".split(" "),
)

const isSingleCommandAllowed = (command: string): boolean => {
  const { rest: trimmed, sawWorktreeId } = stripSafeLeadingEnvVarsDetailed(command)
  if (trimmed === "") return false
  if (sawWorktreeId && WORKTREE_ID_BLOCKED_HARNESS_PATTERN.test(trimmed)) {
    return false
  }
  const tokens = splitCommandTokens(trimmed)
  const head = tokens[0]
  if (
    head !== undefined &&
    EXPANDABLE_VAR_REJECTED_HEADS.has(head) &&
    hasExpandableShellVariable(trimmed)
  ) {
    return false
  }
  if (head === "sed") {
    return isSafeSedReadOnlyCommand(tokens)
  }
  if (head === "vitest") {
    return isSafeVitestExecTokens(tokens)
  }
  if (head === "nx") {
    const nxInfo = inspectNxTokens(tokens)
    if (nxInfo.subcommand === "exec") return false
    if (sawWorktreeId && isWorktreeIdBlockedNxTokens(tokens)) {
      return false
    }
  }
  if (head === "pnpm") {
    if (hasUnsafePnpmDirOrConfigFlags(tokens)) return false
    const pnpmInfo = inspectPnpmTokens(tokens)
    if (pnpmInfo.subcommand === "dlx") return false
    if (extractPnpmOxfmtArgs(tokens) !== undefined) {
      return isSafePnpmOxfmtExplicitCommand(trimmed)
    }
    if (pnpmInfo.subcommand === "oxfmt") {
      return isSafePnpmOxfmtExplicitCommand(
        `pnpm oxfmt ${tokens.slice(pnpmInfo.restStartIdx).join(" ")}`,
      )
    }
    if (pnpmInfo.subcommand === "vitest") {
      return isSafeVitestExecTokens(["vitest", ...tokens.slice(pnpmInfo.restStartIdx)])
    }
    if (isSafePnpmDirScopedCommand(trimmed, sawWorktreeId)) {
      return true
    }
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
  if (tokens[0] === "git" && tokens[1] === "symbolic-ref") {
    return isSafeGitSymbolicRefCommand(tokens)
  }
  if (tokens[0] === "git" && tokens[1] === "config") {
    return isSafeGitConfigGetCommand(tokens)
  }
  return ALLOWLIST.some((prefix) => {
    if (trimmed === prefix) return true
    if (prefix.endsWith(" ") || prefix.endsWith("/")) return trimmed.startsWith(prefix)
    return trimmed.startsWith(prefix + " ")
  })
}

export const isAllowedPipedSegment = (segCmd: string, segUnquoted: string): boolean => {
  if (!segUnquoted.includes("|") || segUnquoted.includes("||")) {
    return false
  }
  const parts = splitByUnquotedOperator(segCmd, segUnquoted, "|")
  return (
    parts.length >= 2 &&
    isCommandAllowed(parts[0]!.cmd) &&
    parts.slice(1).every((p) => isSafeReadOnlyXargsSegment(p.cmd) || isSimpleSafePipeFilter(p.cmd))
  )
}

export const isCommandAllowed = (command: string): boolean => {
  const pipeParts = splitUnquotedPipeParts(command)
  if (pipeParts !== undefined) {
    return (
      pipeParts.length >= 2 &&
      isSingleCommandAllowed(pipeParts[0]!) &&
      pipeParts
        .slice(1)
        .every((part) => isSafeReadOnlyXargsSegment(part) || isSimpleSafePipeFilter(part))
    )
  }
  return isSingleCommandAllowed(command)
}
