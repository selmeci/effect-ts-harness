/** Two views of a command used by the pattern rules (harness:SPEC-0001 · 4).
 * - `argv`: shell words after quote and backslash removal, joined by single spaces, with
 *   data arguments dropped (commit messages, grep patterns) — REQ-4.1 / REQ-4.2.
 * - `unquoted`: the raw command with quoted text blanked, so `>` inside a quoted string
 *   is not taken for a redirection — REQ-4.3. */
export interface CommandView {
  readonly argv: string
  readonly unquoted: string
}

export interface UnwrappedSegment {
  readonly envAssignments: ReadonlyArray<string>
  readonly commandWords: ReadonlyArray<string>
  readonly sawPackageRunner: boolean
}

const OPERATOR_WORDS: ReadonlySet<string> = new Set(["&&", "||", ";", "|", "&"])

export const hasUnquotedBackgroundOperator = (unquoted: string): boolean =>
  /(?<![>&])&(?![>&])/.test(unquoted)

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

export const unwrapCommandSegment = (words: ReadonlyArray<string>): UnwrappedSegment => {
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

export const extractCommandSegments = (command: string): ReadonlyArray<UnwrappedSegment> => {
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
