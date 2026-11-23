import * as path from "node:path"
import {
  extractDetailedCommandSegments,
  normalizeShellLineContinuations,
  toCommandView,
  unwrapCommandSegment,
  type DetailedCommandSegment,
} from "./policy-shell-parser.js"

export const PROTECTED_HARNESS_FILE_WRITE_PATTERN: RegExp =
  /(^|\/)(?:[^/]*\.git\/harne(?:ss|[*?[\]{}][^/]*)(\/|$)|[^/]*common-dir\/harness(\/|$)|(?:harness\/)?workflow-backups(\/|$)|(?:auth-tokens?(?:\*|[*?[\]{}][^/]*)?\.json|daemon\.(?:sock|lock)|pending-workflow-restore\.json)(\/|$))/

const PROTECTED_HARNESS_SHELL_PATH_PATTERN: RegExp =
  /(?:^|[\s=:/<>|('"`,({[])(?:[^\s;|&)<>'"`,)}\]]*(?:\.git|common-dir)\/harne(?:ss|[^\s;|&)<>'"`,)}\]*?]*[*?[\]{}][^\s;|&)<>'"`,)}\]]*)(?:\/[^\s;|&)<>'"`,)}\]]*)?|(?:[^\s;|&)<>'"`,)}\]]*\/)?(?:harness\/)?workflow-backups(?:\/[^\s;|&)<>'"`,)}\]]*)?|(?:[^\s;|&)<>'"`,)}\]]*\/)?(?:auth-tokens?(?:[*?[\]{}][^\s;|&)<>'"`,)}\]]*)?\.json|daemon\.(?:sock|lock)|pending-workflow-restore\.json))(?=$|[\s/;|&)<>'"`,)}\]])/

const PROTECTED_MUTATION_ONLY_SHELL_PATH_PATTERN: RegExp =
  /(?:^|[\s=:/<>|('"`,({[])(?:[^\s;|&)<>'"`,)}\]]*\.harness\/(?:worktrees\/[^\s/;|&)<>'"`,)}\]]+\/)?(?:(?:verify|mutate)-stamp\.json|cache\/mutation-cache-v\d+\.(?:json(?:\.corrupt)?|corrupt))|(?:[^\s;|&)<>'"`,)}\]]*\/)?repos\/(?:effect|alchemy)(?:\/[^\s;|&)<>'"`,)}\]]*)?|(?:[^\s;|&)<>'"`,)}\]]*\/)?\.oxlintrc\.json|(?:[^\s;|&)<>'"`,)}\]]*\/)?tools\/oxlint(?:\/[^\s;|&)<>'"`,)}\]]*)?)(?=$|[\s/;|&)<>'"`,)}\]])/

const HARNESS_CMD_SUBST_PATTERN: RegExp =
  /(?:\$\([^)]*--git-(?:common-)?dir[^)]*\)|`[^`]*--git-(?:common-)?dir[^`]*`)["']?(?:\/+(?:\.\/)*harness)(?=$|[\s/;|&)<>'"`,)}\]])/

const GIT_COMMON_DIR_SUBST_PATTERN: RegExp =
  /(?:\$\([^)]*--git-(?:common-)?dir[^)]*\)|`[^`]*--git-(?:common-)?dir[^`]*`)/

const VAR_HARNESS_PATH_PATTERN: RegExp =
  /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?:[^}\s;|&)<>'"]*)\})\/+(?:\.\/)*harness(?=$|[\s/;|&)<>'"`,)}\]])/

const FIND_MUTATING_FLAG_PATTERN: RegExp =
  /^-(?:delete|exec|execdir|ok|okdir|fls|fprint0?|fprintf)$/

const HARNESS_STATE_MUTATING_BINARIES: ReadonlySet<string> = new Set(
  "rm rmdir unlink shred mv cp install tee chmod chown chgrp ln touch truncate dd mkdir mkfifo mknod flock tar rsync".split(
    " ",
  ),
)

const HARNESS_SOCKET_OR_SCRIPT_BINARIES: ReadonlySet<string> = new Set(
  "curl wget http https xh nc ncat netcat socat telnet openssl python python3 node bun tsx deno ruby perl sh bash zsh dash awk sqlite3".split(
    " ",
  ),
)

const HARNESS_REDIRECTION_OP_PATTERN: RegExp =
  /(?:&>>?|(?<![=&>-])\d*>>?(?![&>])|(?<![=&>-])\d*>&(?![\d-])|<>)(?!\s*\/dev\/null(?:\s|$))/

export const binaryBasename = (word: string): string =>
  word.includes("/") ? word.slice(word.lastIndexOf("/") + 1) : word

const normalizeCommonDir = (rawDir: string): string | undefined => {
  const cleaned = rawDir.replace(/\\/g, "/").trim()
  if (cleaned.length === 0) return undefined
  const norm = path.posix.normalize(cleaned).replace(/\/+$/, "")
  if (norm.length === 0 || norm === "/" || norm === ".") return undefined
  return norm
}

const collectExplicitCommonDirs = (
  segments: ReadonlyArray<DetailedCommandSegment>,
): ReadonlyArray<string> => {
  const dirs = new Set<string>()
  for (const seg of segments) {
    for (const env of seg.envAssignments) {
      if (env.startsWith("GIT_COMMON_DIR=")) {
        const norm = normalizeCommonDir(env.slice("GIT_COMMON_DIR=".length))
        if (norm !== undefined) dirs.add(norm)
      }
    }
    const words = seg.commandWords
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!
      if (w.startsWith("GIT_COMMON_DIR=") && words[0] === "export") {
        const norm = normalizeCommonDir(w.slice("GIT_COMMON_DIR=".length))
        if (norm !== undefined) dirs.add(norm)
        continue
      }
      if (w.startsWith("--git-common-dir=")) {
        const norm = normalizeCommonDir(w.slice("--git-common-dir=".length))
        if (norm !== undefined) dirs.add(norm)
        continue
      }
      if (w === "--git-common-dir" && i + 1 < words.length) {
        const norm = normalizeCommonDir(words[i + 1]!)
        if (norm !== undefined) dirs.add(norm)
      }
    }
  }
  return [...dirs]
}

const matchesExplicitCommonDirHarness = (
  tok: string,
  commonDirs: ReadonlyArray<string>,
): boolean => {
  if (commonDirs.length === 0) return false
  const cleaned = tok.replace(/\\/g, "/")
  if (cleaned.length === 0) return false
  const norm = path.posix.normalize(cleaned)
  return commonDirs.some((dir) => norm === `${dir}/harness` || norm.startsWith(`${dir}/harness/`))
}

const matchesProtectedHarnessTokens = (
  text: string,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
  includeMutationOnly = false,
): boolean => {
  if (
    PROTECTED_HARNESS_SHELL_PATH_PATTERN.test(text) ||
    HARNESS_CMD_SUBST_PATTERN.test(text) ||
    (includeMutationOnly && PROTECTED_MUTATION_ONLY_SHELL_PATH_PATTERN.test(text)) ||
    (commandHasCommonDirSubst && VAR_HARNESS_PATH_PATTERN.test(text))
  ) {
    return true
  }
  const checkCand = (cand: string): boolean =>
    PROTECTED_HARNESS_SHELL_PATH_PATTERN.test(cand) ||
    (includeMutationOnly && PROTECTED_MUTATION_ONLY_SHELL_PATH_PATTERN.test(cand)) ||
    matchesExplicitCommonDirHarness(cand, commonDirs)

  return text.split(/[\s=:'"`()]+/).some((rawTok) => {
    if (rawTok.length === 0) return false
    const splitSubToks = rawTok.split(/[,{}[\]]+/).filter(Boolean)
    const allToks = splitSubToks.includes(rawTok) ? splitSubToks : [rawTok, ...splitSubToks]
    return allToks.some((tok) => {
      const unescaped = tok.includes("\\") ? tok.replace(/\\(.)/g, "$1") : tok
      const unglobbed = unescaped.replace(/\[([^\]!^-])\]/g, "$1")
      const candidates = [
        tok,
        path.posix.normalize(tok),
        unescaped,
        path.posix.normalize(unescaped),
        unglobbed,
        path.posix.normalize(unglobbed),
      ]
      return candidates.some(checkCand)
    })
  })
}

const rawSegmentHasProtectedTimeOutput = (
  rawWords: ReadonlyArray<string>,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
  includeMutationOnly = false,
): boolean => {
  for (let i = 0; i < rawWords.length; i++) {
    const w = rawWords[i]!
    if (binaryBasename(w) !== "time") continue
    for (let j = i + 1; j < rawWords.length; j++) {
      const arg = rawWords[j]!
      if (arg === "--") break
      if ((arg === "-o" || arg === "--output") && j + 1 < rawWords.length) {
        if (
          matchesProtectedHarnessTokens(
            rawWords[j + 1]!,
            commonDirs,
            commandHasCommonDirSubst,
            includeMutationOnly,
          )
        ) {
          return true
        }
        j++
        continue
      }
      if (arg.startsWith("--output=") || (arg.startsWith("-o") && arg.length > 2)) {
        const val = arg.startsWith("--output=") ? arg.slice("--output=".length) : arg.slice(2)
        if (
          matchesProtectedHarnessTokens(
            val,
            commonDirs,
            commandHasCommonDirSubst,
            includeMutationOnly,
          )
        ) {
          return true
        }
        continue
      }
      if (!arg.startsWith("-")) break
    }
  }
  return false
}

const splitUnquotedShellSegments = (
  command: string,
  unquoted: string,
): ReadonlyArray<{ readonly cmd: string; readonly unquoted: string }> => {
  const parts: Array<{ readonly cmd: string; readonly unquoted: string }> = []
  const sepPattern = /&&|\|\||[;\n]|(?<!>)\|(?![|])|(?<![>&])&(?![>&])/g
  let start = 0
  let m = sepPattern.exec(unquoted)
  while (m !== null) {
    parts.push({
      cmd: command.slice(start, m.index),
      unquoted: unquoted.slice(start, m.index),
    })
    start = m.index + m[0].length
    m = sepPattern.exec(unquoted)
  }
  parts.push({
    cmd: command.slice(start),
    unquoted: unquoted.slice(start),
  })
  return parts
}

const matchesProtectedSegmentPaths = (
  seg: DetailedCommandSegment,
  tokenWords: ReadonlyArray<string>,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
  includeMutationOnly = false,
): boolean => {
  if (
    matchesProtectedHarnessTokens(
      tokenWords.join(" "),
      commonDirs,
      commandHasCommonDirSubst,
      includeMutationOnly,
    )
  ) {
    return true
  }
  if (seg.wrapperDirs.length === 0) {
    return false
  }
  if (
    matchesProtectedHarnessTokens(
      seg.wrapperDirs.join(" "),
      commonDirs,
      commandHasCommonDirSubst,
      includeMutationOnly,
    )
  ) {
    return true
  }
  return seg.wrapperDirs.some((dir) =>
    tokenWords.some(
      (tok) =>
        !tok.startsWith("-") &&
        matchesProtectedHarnessTokens(
          path.posix.join(dir, tok),
          commonDirs,
          commandHasCommonDirSubst,
          includeMutationOnly,
        ),
    ),
  )
}

const isMutatingOrProbingBinArgs = (bin: string, args: ReadonlyArray<string>): boolean =>
  HARNESS_STATE_MUTATING_BINARIES.has(bin) ||
  HARNESS_SOCKET_OR_SCRIPT_BINARIES.has(bin) ||
  (bin === "sed" && args.some((w) => /^-[^-]*i|^--in-place(?:=|$)/.test(w))) ||
  (bin === "find" && args.some((w) => FIND_MUTATING_FLAG_PATTERN.test(w))) ||
  (bin === "sort" && args.some((w) => /^-[^-]*o|^--output(?:=|$)/.test(w))) ||
  (bin === "git" && args.some((w) => /^--output(?:=|$)/.test(w))) ||
  (bin === "rg" && args.some((w) => /^--(?:pre|pre-glob|hostname-bin)(?:=|\s|$)/.test(w)))

const unwrapXargsTargetWords = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const valueFlags = new Set([
    "-a",
    "--arg-file",
    "-d",
    "--delimiter",
    "-E",
    "--eof",
    "-I",
    "--replace",
    "-L",
    "--max-lines",
    "-n",
    "--max-args",
    "-P",
    "--max-procs",
    "-s",
    "--max-chars",
  ])
  let i = 0
  while (i < args.length) {
    const a = args[i]!
    if (a === "--") {
      i++
      break
    }
    if (valueFlags.has(a)) {
      i += 2
      continue
    }
    if (a.startsWith("-")) {
      i++
      continue
    }
    break
  }
  return args.slice(i)
}

const resolveXargsTargetWords = (initialArgs: ReadonlyArray<string>): ReadonlyArray<string> => {
  let words = unwrapXargsTargetWords(initialArgs)
  for (let depth = 0; depth < 6 && words.length > 0; depth++) {
    const nextUnwrapped = unwrapCommandSegment(words).commandWords
    const nextWords =
      nextUnwrapped[0] !== undefined && binaryBasename(nextUnwrapped[0]) === "xargs"
        ? unwrapXargsTargetWords(nextUnwrapped.slice(1))
        : nextUnwrapped
    if (nextWords.length === words.length && nextWords.every((w, idx) => w === words[idx])) {
      words = nextWords
      break
    }
    words = nextWords
  }
  return words
}

const isHarnessStateMutatingSegment = (
  seg: DetailedCommandSegment,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
  candidateAllProtectedTokensText?: string,
): boolean => {
  if (rawSegmentHasProtectedTimeOutput(seg.rawWords, commonDirs, commandHasCommonDirSubst, true)) {
    return true
  }
  const rawBin = seg.commandWords[0]
  if (rawBin === undefined) {
    return false
  }
  const bin = binaryBasename(rawBin)
  const args = seg.commandWords.slice(1)
  if (bin === "xargs") {
    const targetWords = resolveXargsTargetWords(args)
    const targetBin = targetWords[0] !== undefined ? binaryBasename(targetWords[0]) : undefined
    if (targetBin !== undefined && isMutatingOrProbingBinArgs(targetBin, targetWords.slice(1))) {
      return (
        matchesProtectedSegmentPaths(
          seg,
          targetWords.slice(1),
          commonDirs,
          commandHasCommonDirSubst,
          true,
        ) ||
        (candidateAllProtectedTokensText !== undefined &&
          matchesProtectedHarnessTokens(
            candidateAllProtectedTokensText,
            commonDirs,
            commandHasCommonDirSubst,
            true,
          ))
      )
    }
  }
  return (
    isMutatingOrProbingBinArgs(bin, args) &&
    matchesProtectedSegmentPaths(seg, args, commonDirs, commandHasCommonDirSubst, true)
  )
}

const isHarnessStateAccessSegment = (
  seg: DetailedCommandSegment,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
): boolean => {
  if (seg.isPnpmHarness) {
    return false
  }
  const rawBin = seg.commandWords[0]
  if (rawBin === undefined) {
    return false
  }
  const bin = binaryBasename(rawBin)
  if (bin === "ls") {
    return false
  }
  if (
    bin === "find" &&
    !seg.commandWords.slice(1).some((w) => FIND_MUTATING_FLAG_PATTERN.test(w))
  ) {
    return false
  }
  return matchesProtectedSegmentPaths(
    seg,
    [...seg.envAssignments, ...seg.commandWords],
    commonDirs,
    commandHasCommonDirSubst,
    false,
  )
}

const prepareStateCommandVariants = (
  command: string,
): { readonly variants: ReadonlyArray<string>; readonly overflowed: boolean } => {
  const norm = normalizeShellLineContinuations(command)
  const exp = expandCommandVariables(norm)
  return {
    variants: exp.text === norm ? [norm] : [norm, exp.text],
    overflowed: exp.overflowed,
  }
}

export const isHarnessStateMutationCommand = (command: string): boolean => {
  const { variants, overflowed } = prepareStateCommandVariants(command)
  if (overflowed) return true
  return variants.some((candidate) => {
    const segments = extractDetailedCommandSegments(candidate)
    const commonDirs = collectExplicitCommonDirs(segments)
    const commandHasCommonDirSubst = segments.some((seg) =>
      GIT_COMMON_DIR_SUBST_PATTERN.test([...seg.envAssignments, ...seg.commandWords].join(" ")),
    )
    const allSegTokens = segments
      .flatMap((s) => [...s.envAssignments, ...s.commandWords, ...s.wrapperDirs])
      .join(" ")
    if (
      segments.some((seg) =>
        isHarnessStateMutatingSegment(seg, commonDirs, commandHasCommonDirSubst, allSegTokens),
      )
    ) {
      return true
    }
    const view = toCommandView(candidate)
    return splitUnquotedShellSegments(candidate, view.unquoted).some(
      (part) =>
        HARNESS_REDIRECTION_OP_PATTERN.test(part.unquoted) &&
        matchesProtectedHarnessTokens(
          toCommandView(part.cmd).argv,
          commonDirs,
          commandHasCommonDirSubst,
          true,
        ),
    )
  })
}

export const isHarnessStateAccessCommand = (command: string): boolean => {
  const { variants, overflowed } = prepareStateCommandVariants(command)
  if (overflowed) return true
  return variants.some((candidate) => {
    const segments = extractDetailedCommandSegments(candidate)
    const commonDirs = collectExplicitCommonDirs(segments)
    const commandHasCommonDirSubst = segments.some((seg) =>
      GIT_COMMON_DIR_SUBST_PATTERN.test([...seg.envAssignments, ...seg.commandWords].join(" ")),
    )
    return segments.some((seg) =>
      isHarnessStateAccessSegment(seg, commonDirs, commandHasCommonDirSubst),
    )
  })
}

const MAX_VAR_EXPANSION_PASSES = 4
const MAX_EXPANDED_COMMAND_LENGTH = 65_536
const VAR_DECL_BUILTINS: ReadonlySet<string> = new Set(
  "export local readonly declare typeset".split(" "),
)

const findBalancedParenEnd = (text: string, openIdx: number): number => {
  let depth = 1
  let quote: "'" | '"' | "$'" | undefined
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = undefined
      continue
    }
    if (quote === "$'") {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === "'") quote = undefined
      continue
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === '"') quote = undefined
      continue
    }
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "$" && text[i + 1] === "'") {
      quote = "$'"
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === "(") {
      depth++
      continue
    }
    if (ch === ")" && --depth === 0) return i
  }
  return text.length
}

const findClosingBacktick = (text: string, openIdx: number): number => {
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "`") return i
  }
  return text.length
}

export const extractExecutedShellSnippets = (command: string): ReadonlyArray<string> => {
  const snippets: Array<string> = []
  let quote: "'" | '"' | "$'" | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote === "'") {
      if (ch === "'") quote = undefined
      continue
    }
    if (quote === "$'") {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === "'") quote = undefined
      continue
    }
    if (ch === "\\") {
      i++
      continue
    }
    if (quote === undefined && ch === "$" && command[i + 1] === "'") {
      quote = "$'"
      i++
      continue
    }
    if (quote === undefined && (ch === "'" || ch === '"')) {
      quote = ch
      continue
    }
    if (quote === '"' && ch === '"') {
      quote = undefined
      continue
    }
    if (quote === undefined && ch === "#" && (i === 0 || /\s/.test(command[i - 1]!))) {
      while (i < command.length && command[i] !== "\n") i++
      continue
    }
    if (
      (ch === "$" && command[i + 1] === "(") ||
      (quote === undefined && (ch === "<" || ch === ">") && command[i + 1] === "(")
    ) {
      const end = findBalancedParenEnd(command, i + 1)
      const inner = command.slice(i + 2, end).trim()
      if (inner.length > 0) snippets.push(inner)
      i = end
      continue
    }
    if (ch === "`") {
      const end = findClosingBacktick(command, i)
      const inner = command.slice(i + 1, end).trim()
      if (inner.length > 0) snippets.push(inner)
      i = end
    }
  }
  return snippets
}

export const hasUnexpandedShellVariable = (text: string): boolean => {
  let quote: "'" | '"' | "$'" | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = undefined
      continue
    }
    if (quote === "$'") {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === "'") quote = undefined
      continue
    }
    if (ch === "\\") {
      i++
      continue
    }
    if (quote === undefined && ch === "$" && text[i + 1] === "'") {
      quote = "$'"
      i++
      continue
    }
    if (quote === undefined && ch === "'") {
      quote = "'"
      continue
    }
    if (ch === '"') {
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (
      ch === "$" &&
      text[i + 1] !== undefined &&
      (text[i + 1] === "{" || /[A-Za-z_]/.test(text[i + 1]!))
    ) {
      return true
    }
  }
  return false
}

const collectShellVariableAssignments = (
  segments: ReadonlyArray<DetailedCommandSegment>,
): ReadonlyMap<string, string> => {
  const vars = new Map<string, string>()
  const addAssignment = (entry: string): void => {
    const eqIdx = entry.indexOf("=")
    if (eqIdx <= 0) return
    const name = entry.slice(0, eqIdx)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) vars.set(name, entry.slice(eqIdx + 1))
  }
  for (const seg of segments) {
    for (const env of seg.envAssignments) addAssignment(env)
    const rawBin = seg.commandWords[0]
    if (rawBin !== undefined && VAR_DECL_BUILTINS.has(binaryBasename(rawBin))) {
      for (const word of seg.commandWords.slice(1)) {
        if (!word.startsWith("-")) addAssignment(word)
      }
    }
  }
  return vars
}

const expandBracedVarExpression = (
  expr: string,
  vars: ReadonlyMap<string, string>,
): string | undefined => {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/s.exec(expr)
  if (m === null) return undefined
  const val = vars.get(m[1]!)
  const mod = m[2]!
  if (mod === "") return val
  if (mod.startsWith(":-") || mod.startsWith("-")) {
    const fallback = mod.startsWith(":-") ? mod.slice(2) : mod.slice(1)
    return val !== undefined && (mod.startsWith("-") || val.length > 0) ? val : fallback
  }
  if (val === undefined) return undefined
  return mod === "%/" && val.endsWith("/") ? val.slice(0, -1) : val
}

const expandShellVariablesOnce = (
  command: string,
  vars: ReadonlyMap<string, string>,
): { readonly text: string; readonly overflowed: boolean } => {
  let out = ""
  let quote: "'" | '"' | "$'" | undefined
  for (let i = 0; i < command.length; i++) {
    if (out.length > MAX_EXPANDED_COMMAND_LENGTH) return { text: out, overflowed: true }
    const ch = command[i]!
    if (quote === "'") {
      if (ch === "'") quote = undefined
      out += ch
      continue
    }
    if (quote === "$'") {
      if (ch === "'") {
        quote = undefined
        out += ch
        continue
      }
      if (ch === "\\") {
        out += ch + (i + 1 < command.length ? command[++i]! : "")
        continue
      }
      out += ch
      continue
    }
    if (ch === "\\") {
      out += ch + (i + 1 < command.length ? command[++i]! : "")
      continue
    }
    if (quote === undefined && ch === "$" && command[i + 1] === "'") {
      quote = "$'"
      out += "$'"
      i++
      continue
    }
    if (quote === undefined && ch === "'") {
      quote = "'"
      out += ch
      continue
    }
    if (ch === '"') {
      quote = quote === '"' ? undefined : '"'
      out += ch
      continue
    }
    if (ch === "$" && command[i + 1] === "{") {
      const closeIdx = command.indexOf("}", i + 2)
      if (closeIdx !== -1) {
        const rep = expandBracedVarExpression(command.slice(i + 2, closeIdx), vars)
        if (rep !== undefined) {
          out += rep
          i = closeIdx
          continue
        }
      }
    }
    if (ch === "$") {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(command.slice(i + 1))
      const rep = m !== null ? vars.get(m[0]) : undefined
      if (m !== null && rep !== undefined) {
        out += rep
        i += m[0].length
        continue
      }
    }
    out += ch
  }
  return { text: out, overflowed: out.length > MAX_EXPANDED_COMMAND_LENGTH }
}

export const expandCommandVariables = (
  command: string,
): { readonly text: string; readonly overflowed: boolean } => {
  let current = command
  for (let pass = 0; pass < MAX_VAR_EXPANSION_PASSES; pass++) {
    const vars = collectShellVariableAssignments(extractDetailedCommandSegments(current))
    if (vars.size === 0 && (pass > 0 || !current.includes("${"))) break
    const expanded = expandShellVariablesOnce(current, vars)
    if (expanded.overflowed || expanded.text === current) {
      return { text: expanded.text, overflowed: expanded.overflowed }
    }
    current = expanded.text
  }
  return { text: current, overflowed: false }
}
