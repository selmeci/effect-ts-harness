/** Two views of a command used by the pattern rules (harness:SPEC-0001 · 4).
 * - `argv`: shell words after quote and backslash removal, joined by single spaces, with
 *   data arguments dropped (commit messages, grep patterns) — REQ-4.1 / REQ-4.2.
 * - `unquoted`: the raw command with quoted text blanked, so `>` inside a quoted string
 *   is not taken for a redirection — REQ-4.3. */
export interface CommandView {
  readonly argv: string
  readonly unquoted: string
  readonly unclosedQuote: boolean
  readonly hasDoubleQuotedSubstitution: boolean
  readonly hasAnsiCQuote: boolean
}

export interface UnwrappedSegment {
  readonly envAssignments: ReadonlyArray<string>
  readonly commandWords: ReadonlyArray<string>
  readonly sawPackageRunner: boolean
}

const OPERATOR_WORDS: ReadonlySet<string> = new Set(["&&", "||", ";", "|", "&"])

export const hasUnquotedBackgroundOperator = (unquoted: string): boolean =>
  /(?<![>&])&(?![>&])/.test(unquoted)

const WRAPPER_BINARIES: ReadonlySet<string> = new Set("pnpm npm npx pnpx yarn bunx".split(" "))
const WRAPPER_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "--filter -F --dir -C --cwd --prefix --package -p --loglevel --reporter --store-dir --cache-dir --config -c --userconfig".split(
    " ",
  ),
)
const WRAPPER_SUBCOMMANDS: ReadonlySet<string> = new Set(["exec", "run", "dlx"])
const BUN_PACKAGE_RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(["x", "run", "exec"])
const BUN_EVAL_FLAGS: ReadonlySet<string> = new Set(["-e", "--eval", "-p", "--print"])
const ENV_VALUE_FLAGS: ReadonlySet<string> = new Set("-u -C --unset --chdir".split(" "))
const ENV_SIMPLE_FLAGS: ReadonlySet<string> = new Set(
  "-i --ignore-environment -0 --null".split(" "),
)

const binaryBasename = (word: string): string =>
  word.includes("/") ? word.slice(word.lastIndexOf("/") + 1) : word

export const normalizeShellLineContinuations = (command: string): string => {
  let out = ""
  let quote: "'" | '"' | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote === "'") {
      if (ch === "'") quote = undefined
      out += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined
        out += ch
        continue
      }
      if (ch === "\\") {
        if (command[i + 1] === "\n") {
          i += 1
          continue
        }
        if (command[i + 1] === "\r" && command[i + 2] === "\n") {
          i += 2
          continue
        }
        if (i + 1 < command.length) {
          out += ch + command[++i]!
          continue
        }
      }
      out += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
      continue
    }
    if (ch === "\\") {
      if (command[i + 1] === "\n") {
        i += 1
        continue
      }
      if (command[i + 1] === "\r" && command[i + 2] === "\n") {
        i += 2
        continue
      }
      if (i + 1 < command.length) {
        out += ch + command[++i]!
        continue
      }
    }
    out += ch
  }
  return out
}

const splitShellWords = (
  command: string,
): {
  readonly words: ReadonlyArray<string>
  readonly unquoted: string
  readonly unclosedQuote: boolean
  readonly hasDoubleQuotedSubstitution: boolean
  readonly hasAnsiCQuote: boolean
} => {
  const words: Array<string> = []
  let current = ""
  let inWord = false
  let quote: "'" | '"' | "$'" | undefined
  let unquoted = ""
  let hasDoubleQuotedSubstitution = false
  let hasAnsiCQuote = false
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
      if (quote === "$'") {
        if (ch === "'") {
          quote = undefined
          continue
        }
        if (ch === "\\" && i + 1 < command.length) {
          current += command[++i]!
          unquoted += " "
          continue
        }
        current += ch
        continue
      }
      if (ch === quote) {
        quote = undefined
        continue
      }
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        current += command[++i]!
        unquoted += " "
        continue
      }
      if (quote === '"' && (ch === "`" || (ch === "$" && command[i + 1] === "("))) {
        hasDoubleQuotedSubstitution = true
      }
      current += ch
      continue
    }
    if (ch === "$" && command[i + 1] === "'") {
      hasAnsiCQuote = true
      quote = "$'"
      inWord = true
      unquoted += "  "
      i += 1
      continue
    }
    if (!inWord && ch === "#") {
      while (i < command.length && command[i] !== "\n") {
        unquoted += " "
        i++
      }
      if (i < command.length && command[i] === "\n") {
        unquoted += "\n"
      }
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
      (ch === "|" && !unquoted.endsWith(">")) ||
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
  return {
    words,
    unquoted,
    unclosedQuote: quote !== undefined,
    hasDoubleQuotedSubstitution,
    hasAnsiCQuote,
  }
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
  const norm = normalizeShellLineContinuations(command)
  const { words, unquoted, unclosedQuote, hasDoubleQuotedSubstitution, hasAnsiCQuote } =
    splitShellWords(norm)
  return {
    argv: dropDataArguments(words).join(" "),
    unquoted,
    unclosedQuote,
    hasDoubleQuotedSubstitution,
    hasAnsiCQuote,
  }
}

const isBunPackageRunner = (words: ReadonlyArray<string>, bunIndex: number): boolean => {
  for (let j = bunIndex + 1; j < words.length; j++) {
    const arg = words[j]!
    if (arg === "--" || BUN_EVAL_FLAGS.has(arg)) {
      return false
    }
    if (WRAPPER_VALUE_FLAGS.has(arg)) {
      j++
      continue
    }
    if (arg.startsWith("-")) {
      continue
    }
    return BUN_PACKAGE_RUNNER_SUBCOMMANDS.has(arg)
  }
  return false
}

export const unwrapCommandSegment = (words: ReadonlyArray<string>): UnwrappedSegment => {
  const activeWords = [...words]
  const envAssignments: Array<string> = []
  let sawPackageRunner = false
  let i = 0
  while (i < activeWords.length) {
    const w = activeWords[i]!
    const base = binaryBasename(w)
    if (base === "env") {
      i++
      while (i < activeWords.length) {
        const arg = activeWords[i]!
        if (arg === "--") {
          i++
          break
        }
        if (arg === "-S" || arg === "--split-string") {
          const payload = activeWords[i + 1]
          if (payload !== undefined) {
            const splitWords = splitShellWords(payload).words
            activeWords.splice(i, 2, ...splitWords)
            continue
          }
          i++
          break
        }
        if (arg.startsWith("--split-string=") || (arg.startsWith("-S") && arg.length > 2)) {
          const prefixLen = arg.startsWith("--split-string=") ? "--split-string=".length : 2
          const splitWords = splitShellWords(arg.slice(prefixLen)).words
          activeWords.splice(i, 1, ...splitWords)
          continue
        }
        if (ENV_VALUE_FLAGS.has(arg)) {
          i += 2
          continue
        }
        if (ENV_SIMPLE_FLAGS.has(arg) || arg.startsWith("--unset=") || arg.startsWith("--chdir=")) {
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
      while (i < activeWords.length) {
        const arg = activeWords[i]!
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
    if (WRAPPER_BINARIES.has(base) || (base === "bun" && isBunPackageRunner(activeWords, i))) {
      sawPackageRunner = true
      i++
      while (i < activeWords.length) {
        const arg = activeWords[i]!
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
          (base === "bun" && arg === "x") ||
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
    commandWords: activeWords.slice(i),
    sawPackageRunner,
  }
}

const splitUnquotedSegmentTexts = (command: string): ReadonlyArray<string> => {
  const { unquoted } = splitShellWords(command)
  const parts: Array<string> = []
  const sepPattern = /&&|\|\||[;\n]|(?<!>)\|(?![|])|(?<![>&])&(?![>&])/g
  let start = 0
  let m = sepPattern.exec(unquoted)
  while (m !== null) {
    parts.push(command.slice(start, m.index))
    start = m.index + m[0].length
    m = sepPattern.exec(unquoted)
  }
  parts.push(command.slice(start))
  return parts
}

export const extractCommandSegments = (command: string): ReadonlyArray<UnwrappedSegment> => {
  const norm = normalizeShellLineContinuations(command)
  const segments: Array<UnwrappedSegment> = []
  for (const rawSeg of splitUnquotedSegmentTexts(norm)) {
    const cleanedSeg = rawSeg.replace(/^[()\s]+|[()\s]+$/g, "")
    if (cleanedSeg.length === 0) continue
    const { words } = splitShellWords(cleanedSeg)
    const filteredWords = dropDataArguments(words)
    if (filteredWords.length > 0) {
      segments.push(unwrapCommandSegment(filteredWords))
    }
  }
  return segments
}
