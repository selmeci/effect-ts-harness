import { decodeAnsiCEscape, normalizeShellLineContinuations } from "./policy-ansi-c.js"
import { PNPM_VALUE_FLAGS } from "./policy-command-rules.js"

export { normalizeShellLineContinuations }

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

export interface DetailedCommandSegment extends UnwrappedSegment {
  readonly rawWords: ReadonlyArray<string>
  readonly isPnpmHarness: boolean
  readonly wrapperDirs: ReadonlyArray<string>
}

const OPERATOR_WORDS: ReadonlySet<string> = new Set(["&&", "||", ";", "|", "&"])

export const hasUnquotedBackgroundOperator = (unquoted: string): boolean =>
  /(?<![>&])&(?![>&])/.test(unquoted)

const WRAPPER_BINARIES: ReadonlySet<string> = new Set("pnpm npm npx pnpx yarn bunx".split(" "))
const WRAPPER_VALUE_FLAGS: ReadonlySet<string> = PNPM_VALUE_FLAGS
const WRAPPER_SUBCOMMANDS: ReadonlySet<string> = new Set(["exec", "run", "run-script", "dlx"])
const BUN_PACKAGE_RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(["x", "run", "exec"])
const BUN_EVAL_FLAGS: ReadonlySet<string> = new Set(["-e", "--eval", "-p", "--print"])
const BUN_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "--preload -r --env-file --tsconfig-override --conditions --extension-order --define -d --loader --external --port --jsx-factory --jsx-fragment --jsx-import-source --jsx-runtime --main-fields --server-bunfig".split(
    " ",
  ),
)
const BUN_BUILTIN_SUBCOMMANDS: ReadonlySet<string> = new Set(
  "test install i add remove rm update upgrade init create build link unlink pm outdated audit patch repl info why publish completions feedback help c clean".split(
    " ",
  ),
)
const ENV_VALUE_FLAGS: ReadonlySet<string> = new Set("-u -C --unset --chdir".split(" "))
const ENV_SIMPLE_FLAGS: ReadonlySet<string> = new Set(
  "-i --ignore-environment -0 --null".split(" "),
)
const TIMEOUT_VALUE_FLAGS: ReadonlySet<string> = new Set("-k --kill-after -s --signal".split(" "))
const TIMEOUT_DURATION_PATTERN: RegExp = /^(?:\d+(?:\.\d+)?[smhd]?|inf(?:inity)?)$/i
const NICE_VALUE_FLAGS: ReadonlySet<string> = new Set(["-n", "--adjustment"])
const STDBUF_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "-i --input -o --output -e --error".split(" "),
)
const TIME_VALUE_FLAGS: ReadonlySet<string> = new Set("-f --format -o --output".split(" "))
const RG_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "-A --after-context -B --before-context -C --context -g --glob --iglob -t --type -T --type-not --type-add --type-clear -f --file -M --max-columns -m --max-count -d --max-depth --max-filesize -j --threads --color --colors -E --encoding --engine --field-context-separator --field-match-separator --path-separator -r --replace --sort --sortr --pre --pre-glob --hostname-bin --hyperlink-format --context-separator --dfa-size-limit --regex-size-limit".split(
    " ",
  ),
)

const binaryBasename = (word: string): string =>
  word.includes("/") ? word.slice(word.lastIndexOf("/") + 1) : word

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
  let ansiCNulTruncated = false
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
          ansiCNulTruncated = false
          continue
        }
        if (ch === "\\") {
          const decoded = decodeAnsiCEscape(command, i)
          if (!ansiCNulTruncated) {
            const nulIdx = decoded.text.indexOf("\0")
            if (nulIdx !== -1) {
              current += decoded.text.slice(0, nulIdx)
              ansiCNulTruncated = true
            } else {
              current += decoded.text
            }
          }
          unquoted += " ".repeat(decoded.consumed - 1)
          i += decoded.consumed - 1
          continue
        }
        if (!ansiCNulTruncated) {
          current += ch
        }
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
 * `git log --grep`, `gh pr create/edit --title/--body`, and the search pattern of `rg`. */
const dropDataArguments = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  const kept: Array<string> = []
  let segment: Array<string> = []
  let skipNext = false
  let keepNextArg = false
  let searchPatternSeen = false
  let rgAfterDoubleDash = false
  for (const word of words) {
    if (OPERATOR_WORDS.has(word)) {
      kept.push(word)
      segment = []
      skipNext = false
      keepNextArg = false
      searchPatternSeen = false
      rgAfterDoubleDash = false
      continue
    }
    const program = unwrapCommandSegment(segment).commandWords
    segment.push(word)
    if (skipNext) {
      skipNext = false
      continue
    }
    if (keepNextArg) {
      keepNextArg = false
      kept.push(word)
      continue
    }
    const programBin = program[0] !== undefined ? binaryBasename(program[0]) : undefined
    const sub = programBin === "git" ? program[1] : undefined
    const ghSub = programBin === "gh" ? program[1] : undefined
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
    if (ghSub === "pr" && (word.startsWith("--title=") || word.startsWith("--body="))) continue
    if (sub === "grep" || (programBin === "rg" && !rgAfterDoubleDash)) {
      if (word === "-e" || word === "--regexp") {
        skipNext = true
        searchPatternSeen = true
        continue
      }
      if (word.startsWith("--regexp=") || /^-e./.test(word)) {
        searchPatternSeen = true
        continue
      }
      if (word === "-f" || word === "--file") {
        keepNextArg = true
        searchPatternSeen = true
        kept.push(word)
        continue
      }
      if (word.startsWith("--file=")) {
        searchPatternSeen = true
        kept.push(word)
        continue
      }
      if (/^-f./.test(word)) {
        searchPatternSeen = true
        kept.push("-f", word.slice(2))
        continue
      }
    }
    if (programBin === "rg") {
      if (!rgAfterDoubleDash && word === "--files") {
        searchPatternSeen = true
        kept.push(word)
        continue
      }
      if (word === "--") {
        rgAfterDoubleDash = true
        kept.push(word)
        continue
      }
      if (!rgAfterDoubleDash && RG_VALUE_FLAGS.has(word)) {
        keepNextArg = true
        kept.push(word)
        continue
      }
      if (!searchPatternSeen && (rgAfterDoubleDash || !word.startsWith("-"))) {
        searchPatternSeen = true
        continue
      }
    }
    if (sub === "grep" && !searchPatternSeen && word !== "--" && !word.startsWith("-")) {
      searchPatternSeen = true
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

const isBunScriptPath = (arg: string): boolean =>
  arg.includes("/") || arg.includes("\\") || /\.(?:[cm]?[jt]sx?|json|wasm)$/i.test(arg)

const isBunPackageRunner = (words: ReadonlyArray<string>, bunIndex: number): boolean => {
  for (let j = bunIndex + 1; j < words.length; j++) {
    const arg = words[j]!
    if (
      arg === "-" ||
      arg === "--" ||
      BUN_EVAL_FLAGS.has(arg) ||
      arg.startsWith("--eval=") ||
      arg.startsWith("--print=") ||
      /^-e./.test(arg) ||
      /^-p./.test(arg)
    ) {
      return false
    }
    if (WRAPPER_VALUE_FLAGS.has(arg) || BUN_VALUE_FLAGS.has(arg)) {
      j++
      continue
    }
    if (arg.startsWith("-")) {
      continue
    }
    if (BUN_PACKAGE_RUNNER_SUBCOMMANDS.has(arg)) {
      return true
    }
    if (BUN_BUILTIN_SUBCOMMANDS.has(arg) || isBunScriptPath(arg)) {
      return false
    }
    return true
  }
  return false
}

const matchDirFlag = (
  words: ReadonlyArray<string>,
  index: number,
  longFlags: ReadonlyArray<string>,
): { readonly dir: string | undefined; readonly advanceTwo: boolean } | undefined => {
  const arg = words[index]!
  if (arg === "-C" || longFlags.includes(arg)) {
    return { dir: words[index + 1], advanceTwo: true }
  }
  if (arg.startsWith("-C") && arg.length > 2) {
    return { dir: arg.slice(2), advanceTwo: false }
  }
  const eqFlag = longFlags.find((flag) => arg.startsWith(`${flag}=`))
  return eqFlag !== undefined ? { dir: arg.slice(eqFlag.length + 1), advanceTwo: false } : undefined
}

const unwrapCommandSegmentInternal = (
  words: ReadonlyArray<string>,
): {
  readonly envAssignments: ReadonlyArray<string>
  readonly commandWords: ReadonlyArray<string>
  readonly sawPackageRunner: boolean
  readonly isPnpmHarness: boolean
  readonly wrapperDirs: ReadonlyArray<string>
  readonly didExpandEnvSplit: boolean
} => {
  const activeWords = [...words]
  const envAssignments: Array<string> = []
  const wrapperDirs: Array<string> = []
  let sawPackageRunner = false
  let firstRunnerBin: string | undefined
  let sawRunnerExecOrDlx = false
  let didExpandEnvSplit = false
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
            didExpandEnvSplit = true
            continue
          }
          i++
          break
        }
        if (arg.startsWith("--split-string=") || (arg.startsWith("-S") && arg.length > 2)) {
          const prefixLen = arg.startsWith("--split-string=") ? "--split-string=".length : 2
          const splitWords = splitShellWords(arg.slice(prefixLen)).words
          activeWords.splice(i, 1, ...splitWords)
          didExpandEnvSplit = true
          continue
        }
        const envDir = matchDirFlag(activeWords, i, ["--chdir"])
        if (envDir !== undefined) {
          if (envDir.dir !== undefined) wrapperDirs.push(envDir.dir)
          if (envDir.advanceTwo) i += 2
          else i++
          continue
        }
        if (ENV_VALUE_FLAGS.has(arg)) {
          i += 2
          continue
        }
        if (
          ENV_SIMPLE_FLAGS.has(arg) ||
          arg.startsWith("--unset=") ||
          (arg.startsWith("-u") && arg.length > 2)
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
      while (i < activeWords.length) {
        const arg = activeWords[i]!
        if (arg === "--") {
          i++
          break
        }
        if (/^-[pvV]+$/.test(arg)) {
          i++
          continue
        }
        break
      }
      continue
    }
    if (base === "cross-env" || base === "builtin" || base === "nohup") {
      i++
      if (base === "nohup") {
        while (i < activeWords.length) {
          const arg = activeWords[i]!
          if (arg === "--") {
            i++
            break
          }
          if (arg.startsWith("-")) {
            i++
            continue
          }
          break
        }
      }
      continue
    }
    if (base === "timeout") {
      i++
      let sawBusyboxT = false
      while (i < activeWords.length) {
        const arg = activeWords[i]!
        if (arg === "--") {
          i++
          break
        }
        if (TIMEOUT_VALUE_FLAGS.has(arg)) {
          i += 2
          continue
        }
        if (arg === "-t") {
          sawBusyboxT = true
          i += 2
          continue
        }
        if (arg.startsWith("-")) {
          i++
          continue
        }
        break
      }
      if (
        !sawBusyboxT &&
        i < activeWords.length &&
        TIMEOUT_DURATION_PATTERN.test(activeWords[i]!)
      ) {
        i++
      }
      if (i < activeWords.length && activeWords[i] === "--") {
        i++
      }
      continue
    }
    if (base === "nice") {
      i++
      while (i < activeWords.length) {
        const arg = activeWords[i]!
        if (arg === "--") {
          i++
          break
        }
        if (NICE_VALUE_FLAGS.has(arg)) {
          i += 2
          continue
        }
        if (arg.startsWith("-") || /^\+\d+$/.test(arg)) {
          i++
          continue
        }
        break
      }
      continue
    }
    if (base === "stdbuf") {
      i++
      while (i < activeWords.length) {
        const arg = activeWords[i]!
        if (arg === "--") {
          i++
          break
        }
        if (STDBUF_VALUE_FLAGS.has(arg)) {
          i += 2
          continue
        }
        if (arg.startsWith("-")) {
          i++
          continue
        }
        break
      }
      continue
    }
    if (base === "time") {
      i++
      while (i < activeWords.length) {
        const arg = activeWords[i]!
        if (arg === "--") {
          i++
          break
        }
        if (TIME_VALUE_FLAGS.has(arg)) {
          i += 2
          continue
        }
        if (arg.startsWith("-")) {
          i++
          continue
        }
        break
      }
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      envAssignments.push(w)
      i++
      continue
    }
    if (WRAPPER_BINARIES.has(base) || (base === "bun" && isBunPackageRunner(activeWords, i))) {
      sawPackageRunner = true
      if (firstRunnerBin === undefined) {
        firstRunnerBin = base
      }
      i++
      while (i < activeWords.length) {
        const arg = activeWords[i]!
        const dirMatch = matchDirFlag(activeWords, i, ["--dir", "--cwd", "--prefix"])
        if (dirMatch !== undefined) {
          if (dirMatch.dir !== undefined) wrapperDirs.push(dirMatch.dir)
          if (dirMatch.advanceTwo) i += 2
          else i++
          continue
        }
        if (WRAPPER_VALUE_FLAGS.has(arg) || (base === "bun" && BUN_VALUE_FLAGS.has(arg))) {
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
          if (arg === "exec" || arg === "dlx") {
            sawRunnerExecOrDlx = true
          }
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
  const commandWords = activeWords.slice(i)
  const isPnpmHarness =
    firstRunnerBin === "pnpm" && !sawRunnerExecOrDlx && commandWords[0] === "harness"
  return {
    envAssignments,
    commandWords,
    sawPackageRunner,
    isPnpmHarness,
    wrapperDirs,
    didExpandEnvSplit,
  }
}

export const unwrapCommandSegment = (words: ReadonlyArray<string>): UnwrappedSegment => {
  const { envAssignments, commandWords, sawPackageRunner } = unwrapCommandSegmentInternal(words)
  return {
    envAssignments,
    commandWords,
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

const stripOuterSubshellParens = (rawSeg: string): string => {
  let s = rawSeg.trim()
  while (s.startsWith("(")) {
    s = s.slice(1).trimStart()
  }
  const { unquoted } = splitShellWords(s)
  let openCount = 0
  let closeCount = 0
  for (let i = 0; i < unquoted.length; i++) {
    const ch = unquoted[i]
    if (ch === "(") {
      openCount++
      continue
    }
    if (ch === ")") {
      closeCount++
    }
  }
  while (closeCount > openCount && s.endsWith(")")) {
    s = s.slice(0, -1).trimEnd()
    closeCount--
  }
  return s
}

const pushUnwrappedSegments = (
  rawWords: ReadonlyArray<string>,
  inheritedDirs: ReadonlyArray<string>,
  out: Array<DetailedCommandSegment>,
): void => {
  const unwrapped = unwrapCommandSegmentInternal(rawWords)
  const wrapperDirs = [...inheritedDirs, ...unwrapped.wrapperDirs]
  if (unwrapped.didExpandEnvSplit && unwrapped.commandWords.some((w) => OPERATOR_WORDS.has(w))) {
    const chunks: Array<Array<string>> = [[]]
    for (const word of unwrapped.commandWords) {
      if (OPERATOR_WORDS.has(word)) chunks.push([])
      else chunks[chunks.length - 1]!.push(word)
    }
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx]!
      if (chunk.length === 0) continue
      if (idx === 0) {
        out.push({
          rawWords,
          envAssignments: unwrapped.envAssignments,
          commandWords: dropDataArguments(chunk),
          sawPackageRunner: unwrapped.sawPackageRunner,
          isPnpmHarness: unwrapped.isPnpmHarness,
          wrapperDirs,
        })
      } else {
        pushUnwrappedSegments(chunk, wrapperDirs, out)
      }
    }
    return
  }
  out.push({
    rawWords,
    envAssignments: unwrapped.envAssignments,
    commandWords: dropDataArguments(unwrapped.commandWords),
    sawPackageRunner: unwrapped.sawPackageRunner,
    isPnpmHarness: unwrapped.isPnpmHarness,
    wrapperDirs,
  })
}

export const extractDetailedCommandSegments = (
  command: string,
): ReadonlyArray<DetailedCommandSegment> => {
  const norm = normalizeShellLineContinuations(command)
  const segments: Array<DetailedCommandSegment> = []
  for (const rawSeg of splitUnquotedSegmentTexts(norm)) {
    const cleanedSeg = stripOuterSubshellParens(rawSeg)
    if (cleanedSeg.length === 0) continue
    const { words } = splitShellWords(cleanedSeg)
    if (words.length === 0) continue
    pushUnwrappedSegments(words, [], segments)
  }
  return segments
}

export const extractCommandSegments = (command: string): ReadonlyArray<UnwrappedSegment> =>
  extractDetailedCommandSegments(command).map(
    ({ envAssignments, commandWords, sawPackageRunner }) => ({
      envAssignments,
      commandWords,
      sawPackageRunner,
    }),
  )
