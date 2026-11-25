/** Zero-dependency heredoc parsing and safe data-only heredoc stripping
 * under the `policy-zero-dep` closure profile (no `node:*`, `effect`, or `@harness/*`). */
import { match } from "ts-pattern"
import * as lists from "./policy-command-lists.js"
import * as rules from "./policy-command-rules.js"
import * as shell from "./policy-shell-parser.js"

type HeredocQuoteKind = "single" | "escaped" | "double" | "unquoted"
type ShellQuote = "'" | '"' | "$'"

interface ParsedHeredocBlock {
  readonly headerLineIdx: number
  readonly delimLineIdx: number
  readonly headerLine: string
}

export interface StripHeredocResult {
  readonly stripped: string
  readonly strippedCount: number
  readonly safeDelimLineIndices: ReadonlySet<number>
  readonly safeMktempVars: ReadonlySet<string>
  readonly unsafeVars: ReadonlySet<string>
  readonly poisonedTmpdir: boolean
}

const basenameOf = (word: string): string =>
  word.includes("/") ? word.slice(word.lastIndexOf("/") + 1) : word

const unquoteToken = (raw: string): string => {
  const t = raw.trim()
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1)
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"'))
    return t.slice(1, -1).replace(/\\(.)/g, "$1")
  return t.replace(/\\(.)/g, "$1")
}

interface QuoteStep {
  readonly nextQuote: ShellQuote | undefined
  readonly advance: number
  readonly raw: string
  readonly continued: boolean
}

const consumeQuotedOrEscaped = (
  text: string,
  i: number,
  quote: ShellQuote | undefined,
): QuoteStep | undefined => {
  const ch = text[i]!
  const mk = (
    nextQuote: ShellQuote | undefined,
    advance: number,
    continued = false,
  ): QuoteStep => ({
    nextQuote,
    advance,
    raw: text.slice(i, i + 1 + advance),
    continued,
  })
  if (quote !== undefined) {
    return match(quote)
      .with("'", () => mk(ch === "'" ? undefined : quote, 0))
      .with("$'", () =>
        ch === "\\" && i + 1 < text.length ? mk(quote, 1) : mk(ch === "'" ? undefined : quote, 0),
      )
      .with('"', () =>
        ch === "\\"
          ? i + 1 < text.length
            ? mk(quote, 1)
            : mk(quote, 0, true)
          : mk(ch === '"' ? undefined : quote, 0),
      )
      .exhaustive()
  }
  if (ch === "\\") return i + 1 < text.length ? mk(undefined, 1) : mk(undefined, 0, true)
  if (ch === "$" && text[i + 1] === "'") return mk("$'", 1)
  if (ch === "'" || ch === '"') return mk(ch, 0)
  return undefined
}

interface DelimMatch {
  readonly stripTabs: boolean
  readonly delim: string
  readonly quoteKind: HeredocQuoteKind
  readonly endPos: number
}

const parseHeredocDelimAt = (line: string, startPos: number): DelimMatch | undefined => {
  let pos = startPos
  const stripTabs = line[pos] === "-"
  if (stripTabs) pos++
  while (pos < line.length && (line[pos] === " " || line[pos] === "\t")) pos++
  if (pos >= line.length) return undefined
  const rest = line.slice(pos)
  const q = /^(?:'([A-Za-z_][A-Za-z0-9_-]*)'|"([A-Za-z_][A-Za-z0-9_-]*)")/.exec(rest)
  if (q !== null) {
    return {
      stripTabs,
      delim: (q[1] ?? q[2])!,
      quoteKind: q[1] !== undefined ? "single" : "double",
      endPos: pos + q[0].length,
    }
  }
  const r = /^([A-Za-z_\\][A-Za-z0-9_\\-]*)/.exec(rest)
  const unescaped = r?.[1]?.replace(/\\(.)/g, "$1")
  if (r === null || unescaped === undefined || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(unescaped))
    return undefined
  return {
    stripTabs,
    delim: unescaped,
    quoteKind: r[1]!.includes("\\") ? "escaped" : "unquoted",
    endPos: pos + r[1]!.length,
  }
}

const scanLineForHeredocs = (
  rawLine: string,
  initialQuote: ShellQuote | undefined,
): {
  readonly heredocs: ReadonlyArray<Omit<DelimMatch, "endPos">>
  readonly endQuote: ShellQuote | undefined
  readonly invalidHeredoc: boolean
  readonly endsWithContinuation: boolean
} => {
  const line = rawLine.replace(/\r$/, "")
  let quote = initialQuote
  const heredocs: Array<Omit<DelimMatch, "endPos">> = []
  let invalidHeredoc = false
  let endsWithContinuation = false
  let inWord = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    const qStep = consumeQuotedOrEscaped(line, i, quote)
    if (qStep !== undefined) {
      if (qStep.continued) {
        endsWithContinuation = true
        break
      }
      if (quote === undefined) inWord = true
      quote = qStep.nextQuote
      i += qStep.advance
      continue
    }
    if (!inWord && ch === "#") break
    if (/\s/.test(ch)) {
      inWord = false
      continue
    }
    if (ch === "<" && line[i + 1] === "<") {
      if (line[i + 2] === "<") {
        i += 2
        inWord = false
        continue
      }
      const parsed = parseHeredocDelimAt(line, i + 2)
      if (parsed === undefined) {
        invalidHeredoc = true
        break
      }
      heredocs.push(parsed)
      i = parsed.endPos - 1
      inWord = false
      continue
    }
    inWord = true
  }
  return { heredocs, endQuote: quote, invalidHeredoc, endsWithContinuation }
}

const TRAILING_UNESCAPED_BACKSLASH = /(?:^|[^\\])(?:\\\\)*\\$/

const isHeredocDelimMatch = (rawLine: string, hd: Omit<DelimMatch, "endPos">): boolean => {
  const cand = rawLine.replace(/\r$/, "")
  return (hd.stripTabs ? cand.replace(/^\t+/, "") : cand) === hd.delim
}

const splitNormalizedHeredocLines = (
  command: string,
): {
  readonly lines: ReadonlyArray<string>
  readonly blocks: ReadonlyArray<ParsedHeredocBlock>
  readonly failClosed: boolean
} => {
  const rawLines = command.split("\n")
  const lines: Array<string> = []
  const blocks: Array<ParsedHeredocBlock> = []
  let failClosed = false
  let quoteState: ShellQuote | undefined
  let i = 0

  while (i < rawLines.length) {
    let logicalLine = rawLines[i]!
    let seg = logicalLine.replace(/\r$/, "")
    let cont = scanLineForHeredocs(seg, quoteState)
    const didContinue = cont.endsWithContinuation && i + 1 < rawLines.length
    if (didContinue) {
      let acc = seg.slice(0, -1)
      while (cont.endsWithContinuation && i + 1 < rawLines.length) {
        seg = rawLines[++i]!.replace(/\r$/, "")
        cont = scanLineForHeredocs(seg, cont.endQuote)
        acc += cont.endsWithContinuation ? seg.slice(0, -1) : rawLines[i]!
      }
      logicalLine = acc
    }
    const headerLineIdx = lines.length
    lines.push(logicalLine)
    const scan = didContinue ? scanLineForHeredocs(logicalLine, quoteState) : cont
    if (
      scan.invalidHeredoc ||
      scan.heredocs.length > 1 ||
      (scan.heredocs.length === 1 && scan.endQuote !== undefined)
    ) {
      failClosed = true
      quoteState = scan.endQuote
      i++
      continue
    }
    if (scan.heredocs.length !== 1) {
      quoteState = scan.endQuote
      i++
      continue
    }
    const hd = scan.heredocs[0]!
    if (hd.quoteKind === "single" || hd.quoteKind === "escaped") {
      const delimRawIdx = rawLines.findIndex((raw, j) => j > i && isHeredocDelimMatch(raw, hd))
      if (delimRawIdx === -1) {
        failClosed = true
        quoteState = undefined
        i++
        continue
      }
      for (let k = i + 1; k <= delimRawIdx; k++) lines.push(rawLines[k]!)
      blocks.push({ headerLineIdx, delimLineIdx: lines.length - 1, headerLine: logicalLine })
      quoteState = undefined
      i = delimRawIdx + 1
      continue
    }
    let k = i + 1
    let closed = false
    while (k < rawLines.length) {
      let bodyLine = ""
      while (k < rawLines.length) {
        const raw = rawLines[k++]!
        const bodySeg = raw.replace(/\r$/, "")
        if (!TRAILING_UNESCAPED_BACKSLASH.test(bodySeg) || k >= rawLines.length) {
          bodyLine += raw
          break
        }
        bodyLine += bodySeg.slice(0, -1)
      }
      lines.push(bodyLine)
      if (isHeredocDelimMatch(bodyLine, hd)) {
        closed = true
        break
      }
    }
    if (!closed) failClosed = true
    quoteState = undefined
    i = k
  }
  return { lines, blocks, failClosed }
}

/** Normalizes shell `\\<newline>` line continuations outside `'...'`, `$'...'`, and quoted heredoc bodies (`<<'EOF'` / `<<\\EOF`). */
export const normalizeHeredocAwareContinuations = (command: string): string =>
  !command.includes("\\\n") && !command.includes("\\\r\n")
    ? command
    : splitNormalizedHeredocLines(command).lines.join("\n")

const splitUnquotedByOperators = (
  text: string,
  ops: ReadonlyArray<string>,
): ReadonlyArray<{ readonly seg: string; readonly opAfter: string | undefined }> => {
  const out: Array<{ readonly seg: string; readonly opAfter: string | undefined }> = []
  let quote: ShellQuote | undefined
  let start = 0
  let inWord = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const qStep = consumeQuotedOrEscaped(text, i, quote)
    if (qStep !== undefined) {
      if (quote === undefined) inWord = true
      quote = qStep.nextQuote
      i += qStep.advance
      continue
    }
    if (!inWord && ch === "#") {
      while (i < text.length && text[i] !== "\n") i++
      inWord = false
      continue
    }
    inWord = !/\s/.test(ch)
    const matchedOp = ops.find((op) => {
      if (!text.startsWith(op, i)) return false
      if (op === "|" && (text[i - 1] === ">" || text[i + 1] === "|")) return false
      if (op === "&" && (text[i - 1] === ">" || text[i + 1] === ">" || text[i + 1] === "&")) {
        return false
      }
      return true
    })
    if (matchedOp !== undefined) {
      out.push({ seg: text.slice(start, i), opAfter: matchedOp })
      i += matchedOp.length - 1
      start = i + 1
      inWord = false
    }
  }
  out.push({ seg: text.slice(start), opAfter: undefined })
  return out
}

const hasDisallowedTempChars = (raw: string, unquoted: string): boolean =>
  unquoted.includes("..") ||
  lists.FORBIDDEN_DEST_PATH_PATTERN.test(raw) ||
  lists.FORBIDDEN_DEST_PATH_PATTERN.test(unquoted)

const isSafeTempTemplate = (rawTok: string, poisonedTmpdir: boolean): boolean => {
  const u = unquoteToken(rawTok)
  return (
    !hasDisallowedTempChars(rawTok, u) &&
    (lists.SAFE_LITERAL_TEMP_PATH_PATTERN.test(u) ||
      (!poisonedTmpdir &&
        (lists.SAFE_TMPDIR_FALLBACK_PATH_PATTERN.test(u) ||
          lists.SAFE_TMPDIR_VAR_PATH_PATTERN.test(u))))
  )
}

const isSafeTmpDirArg = (rawTok: string, poisonedTmpdir: boolean): boolean => {
  const u = unquoteToken(rawTok)
  return (
    !hasDisallowedTempChars(rawTok, u) &&
    lists.SAFE_TMPDIR_DIR_PATTERN.test(u) &&
    !(u.includes("TMPDIR") && poisonedTmpdir)
  )
}

const isSafeMktempTemplateArg = (
  tok: string,
  sawTFlag: boolean,
  poisonedTmpdir: boolean,
): boolean =>
  sawTFlag && !tok.includes("/")
    ? !poisonedTmpdir &&
      /^[A-Za-z0-9._-]+$/.test(tok) &&
      !tok.includes("..") &&
      !lists.FORBIDDEN_DEST_PATH_PATTERN.test(tok)
    : isSafeTempTemplate(tok, poisonedTmpdir)

export const isSafeMktempRhs = (rhs: string, poisonedTmpdir: boolean): boolean => {
  const trimmed = rhs.trim()
  if (!trimmed.startsWith("$(") || !trimmed.endsWith(")")) return false
  const inner = trimmed.slice(2, -1).trim()
  if (inner.length === 0 || /[;&|><`\n]|\$\(/.test(inner)) return false
  const tokens = rules.splitCommandTokens(inner)
  if (tokens[0] !== "mktemp") return false
  let sawTemplate = false
  let sawTFlag = false
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === "-u" || tok === "-q") continue
    if (tok === "-t") {
      sawTFlag = true
      continue
    }
    if (tok === "-p" || tok === "--tmpdir") {
      const dir = tokens[++i]
      if (dir === undefined || !isSafeTmpDirArg(dir, poisonedTmpdir)) return false
      continue
    }
    if (tok.startsWith("--tmpdir=")) {
      if (!isSafeTmpDirArg(tok.slice(9), poisonedTmpdir)) return false
      continue
    }
    if (
      tok.startsWith("-") ||
      sawTemplate ||
      !isSafeMktempTemplateArg(tok, sawTFlag, poisonedTmpdir)
    )
      return false
    sawTemplate = true
  }
  return sawTemplate
}

const isSafeTempDestination = (
  rawTarget: string,
  safeMktempVars: ReadonlySet<string>,
  unsafeVars: ReadonlySet<string>,
  poisonedTmpdir: boolean,
): boolean => {
  const trimmed = rawTarget.trim()
  if (trimmed.length === 0 || (trimmed.startsWith("'") && trimmed.includes("$"))) return false
  const u = unquoteToken(trimmed)
  if (hasDisallowedTempChars(trimmed, u) || /[*?[\]`\n;|&><]|\$\(/.test(u)) return false
  if (lists.SAFE_LITERAL_TEMP_PATH_PATTERN.test(u)) return true
  if (!poisonedTmpdir && lists.SAFE_TMPDIR_FALLBACK_PATH_PATTERN.test(u)) return true
  const varMatch = lists.SHELL_VAR_REF_PATTERN.exec(u)
  const varName = varMatch === null ? undefined : (varMatch[1] ?? varMatch[2])
  return varName !== undefined && safeMktempVars.has(varName) && !unsafeVars.has(varName)
}

interface ParsedDataSegment {
  readonly rawWords: ReadonlyArray<string>
  readonly outputTargets: ReadonlyArray<string>
  readonly sawHeredoc: boolean
}

const consumeRedirOperator = (
  segText: string,
  index: number,
  current: string,
  flush: () => void,
): { readonly op: string; readonly nextIndex: number } | undefined => {
  const ch = segText[index]!
  const keepPrefix = ch === ">" && (/^\d+$/.test(current) || current === "&")
  if (!keepPrefix) flush()
  let op = (keepPrefix ? current : "") + ch
  let i = index
  if (segText[i + 1] === ch || (ch === ">" && segText[i + 1] === "&")) {
    op += segText[++i]!
    if (op === "<<" && segText[i + 1] === "-") op += segText[++i]!
  }
  return op === "<<" || op === "<<-" || /^(?:&>>?|\d*>>?|\d*>&)$/.test(op)
    ? { op, nextIndex: i }
    : undefined
}

const parseSegmentWordsAndRedirs = (segText: string): ParsedDataSegment | undefined => {
  const tokens: Array<string> = []
  let current = ""
  let inTok = false
  let quote: ShellQuote | undefined
  const flush = (): void => {
    if (!inTok) return
    tokens.push(current)
    current = ""
    inTok = false
  }

  for (let i = 0; i < segText.length; i++) {
    const ch = segText[i]!
    const qStep = consumeQuotedOrEscaped(segText, i, quote)
    if (qStep !== undefined) {
      current += qStep.raw
      quote = qStep.nextQuote
      i += qStep.advance
      inTok = true
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      continue
    }
    if (ch === "<" || ch === ">") {
      const consumed = consumeRedirOperator(segText, i, current, flush)
      if (consumed === undefined) return undefined
      tokens.push(consumed.op)
      current = ""
      inTok = false
      i = consumed.nextIndex
      continue
    }
    current += ch
    inTok = true
  }
  if (quote !== undefined) return undefined
  flush()

  const rawWords: Array<string> = []
  const outputTargets: Array<string> = []
  let sawHeredoc = false
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === "<<" || tok === "<<-") {
      if (i + 1 >= tokens.length) return undefined
      sawHeredoc = true
      i++
      continue
    }
    if (/^(?:&>>?|\d*>>?|\d*>&)$/.test(tok)) {
      const target = tokens[++i]
      if (target === undefined) return undefined
      if (!(tok.endsWith(">&") && /^&\d+$|^-$/.test(target))) outputTargets.push(target)
      continue
    }
    rawWords.push(tok)
  }
  return { rawWords, outputTargets, sawHeredoc }
}

const collectCatOrTeeTargets = (
  bin: string,
  parsed: ParsedDataSegment,
  destTargets: Array<string>,
): boolean => {
  const args = parsed.rawWords.slice(1)
  const ok = match(bin)
    .with("cat", () => args.every((a) => /^-[unsb]+$/.test(unquoteToken(a))))
    .with("tee", () =>
      args.every((a) => {
        const u = unquoteToken(a)
        if (u.startsWith("-"))
          return u === "-a" || u === "--append" || u === "-i" || u === "--ignore-interrupts"
        if (u !== "/dev/null") destTargets.push(a)
        return true
      }),
    )
    .otherwise(() => false)
  if (!ok) return false
  for (const t of parsed.outputTargets) if (unquoteToken(t) !== "/dev/null") destTargets.push(t)
  return true
}

const hasUnsafeSegView = (view: ReturnType<typeof shell.toCommandView>): boolean =>
  view.unclosedQuote || view.hasDoubleQuotedSubstitution || /\$\(|`|<\(|>\(/.test(view.unquoted)

const isSafeDataHeredocPipeline = (
  pipelineText: string,
  safeMktempVars: ReadonlySet<string>,
  unsafeVars: ReadonlySet<string>,
  poisonedTmpdir: boolean,
): boolean => {
  if (hasUnsafeSegView(shell.toCommandView(pipelineText))) return false
  const pipeParts = splitUnquotedByOperators(pipelineText, ["|"])
  if (pipeParts.length === 0 || pipeParts.length > 2) return false
  const allDestTargets: Array<string> = []
  let sawHeredoc = false
  for (const part of pipeParts) {
    const parsed = parseSegmentWordsAndRedirs(part.seg)
    if (parsed === undefined || parsed.rawWords.length === 0) return false
    if (parsed.sawHeredoc) sawHeredoc = true
    const bin = basenameOf(unquoteToken(parsed.rawWords[0]!))
    if (
      lists.INTERPRETER_OR_EXEC_BINARIES.has(bin) ||
      !collectCatOrTeeTargets(bin, parsed, allDestTargets)
    ) {
      return false
    }
  }
  return (
    sawHeredoc &&
    allDestTargets.length > 0 &&
    allDestTargets.every((t) =>
      isSafeTempDestination(t, safeMktempVars, unsafeVars, poisonedTmpdir),
    )
  )
}

const CHAIN_OPERATORS: ReadonlyArray<string> = ["&&", "||", ";", "&"]

const recordAssignmentsFromSegment = (
  segText: string,
  safeMktempVars: Set<string>,
  unsafeVars: Set<string>,
  state: { poisonedTmpdir: boolean },
): void => {
  const m = lists.SIMPLE_VAR_ASSIGN_PATTERN.exec(segText.trim())
  if (m === null) return
  const name = m[1]!
  const rhs = m[2]!
  if (name === "TMPDIR") {
    const unq = unquoteToken(rhs)
    if (!lists.SAFE_TMPDIR_ENV_PATTERN.test(unq) || lists.FORBIDDEN_DEST_PATH_PATTERN.test(unq))
      state.poisonedTmpdir = true
    return
  }
  if (!unsafeVars.has(name) && isSafeMktempRhs(rhs, state.poisonedTmpdir)) safeMktempVars.add(name)
  else {
    unsafeVars.add(name)
    safeMktempVars.delete(name)
  }
}

const hasUnquotedHeredocOperator = (segText: string): boolean =>
  scanLineForHeredocs(segText, undefined).heredocs.length > 0

const isShellExecHeredocStage = (stageText: string): boolean => {
  const parsed = parseSegmentWordsAndRedirs(stageText)
  if (parsed === undefined) return true
  if (parsed.rawWords.length === 0) return parsed.sawHeredoc
  const segs = shell.extractCommandSegments(parsed.rawWords.join(" "))
  return (
    segs.length === 0 ||
    segs.some(
      (s) =>
        s.commandWords.length === 0 ||
        lists.SHELL_ONLY_HEREDOC_BINARIES.has(basenameOf(s.commandWords[0]!)),
    )
  )
}

const isSafeHeaderLineHeredoc = (
  headerLine: string,
  safeMktempVars: Set<string>,
  unsafeVars: Set<string>,
  state: { poisonedTmpdir: boolean },
): boolean => {
  let foundHeredocSeg = false
  for (const part of splitUnquotedByOperators(headerLine, CHAIN_OPERATORS)) {
    if (part.opAfter === "||" || part.opAfter === ";" || part.opAfter === "&") return false
    const seg = part.seg.trim()
    if (hasUnquotedHeredocOperator(seg)) {
      if (
        foundHeredocSeg ||
        !isSafeDataHeredocPipeline(seg, safeMktempVars, unsafeVars, state.poisonedTmpdir)
      ) {
        return false
      }
      foundHeredocSeg = true
      continue
    }
    recordAssignmentsFromSegment(seg, safeMktempVars, unsafeVars, state)
  }
  return foundHeredocSeg
}

const replaceSelectedHeredocBodies = (
  lines: ReadonlyArray<string>,
  selected: ReadonlyArray<ParsedHeredocBlock>,
): { readonly text: string; readonly delimLineIndices: ReadonlySet<number> } => {
  const byHeader = new Map(selected.map((b) => [b.headerLineIdx, b]))
  const outLines: Array<string> = []
  const delimLineIndices = new Set<number>()
  for (let idx = 0; idx < lines.length; idx++) {
    const block = byHeader.get(idx)
    if (block === undefined) {
      outLines.push(lines[idx]!)
      continue
    }
    outLines.push(lines[idx]!)
    if (block.headerLineIdx + 1 < block.delimLineIdx) outLines.push("")
    delimLineIndices.add(outLines.length)
    outLines.push(lines[block.delimLineIdx]!)
    idx = block.delimLineIdx
  }
  return { text: outLines.join("\n"), delimLineIndices }
}

/** Strips heredoc bodies ONLY for verified non-executing data heredocs (`cat`/`tee`) writing
 * via single-quoted or backslash-escaped delimiters (`<<'EOF'`, `<<\EOF`) to safe temp paths
 * (`/tmp/...`, `/var/tmp/...`) or `mktemp`-assigned variables in the same command. */
export const stripSafeDataHeredocBodiesWithMeta = (command: string): StripHeredocResult => {
  const { lines, blocks, failClosed } = splitNormalizedHeredocLines(command)
  const safeMktempVars = new Set<string>()
  const unsafeVars = new Set<string>()
  const state = { poisonedTmpdir: false }
  const safeBlocks: Array<ParsedHeredocBlock> = []
  if (!failClosed && blocks.length > 0) {
    const blockByHeader = new Map(blocks.map((b) => [b.headerLineIdx, b]))
    for (let i = 0; i < lines.length; i++) {
      const block = blockByHeader.get(i)
      if (block !== undefined) {
        if (isSafeHeaderLineHeredoc(block.headerLine, safeMktempVars, unsafeVars, state))
          safeBlocks.push(block)
        i = block.delimLineIdx
        continue
      }
      for (const p of splitUnquotedByOperators(lines[i]!, CHAIN_OPERATORS)) {
        recordAssignmentsFromSegment(p.seg, safeMktempVars, unsafeVars, state)
      }
    }
  }
  const replaced =
    safeBlocks.length === 0 ? undefined : replaceSelectedHeredocBodies(lines, safeBlocks)
  return {
    stripped: replaced?.text ?? command,
    strippedCount: safeBlocks.length,
    safeDelimLineIndices: replaced?.delimLineIndices ?? new Set(),
    safeMktempVars,
    unsafeVars,
    poisonedTmpdir: state.poisonedTmpdir,
  }
}

/** Convenience wrapper returning only the command string with safe data heredoc bodies stripped. */
export const stripSafeDataHeredocBodies = (command: string): string =>
  stripSafeDataHeredocBodiesWithMeta(command).stripped

/** Strips non-shell heredoc bodies (e.g. `python3 - <<'PY'`, `cat <<'EOF'`) when single-quoted
 * or backslash-escaped and properly closed, while preserving `sh`/`bash`/`eval`/`env`/`xargs` heredocs. */
export const stripNonShellHeredocBodies = (command: string): string => {
  const { lines, blocks, failClosed } = splitNormalizedHeredocLines(command)
  if (failClosed || blocks.length === 0) return lines.join("\n")
  const selected = blocks.filter((block) => {
    const hdPart = splitUnquotedByOperators(block.headerLine, CHAIN_OPERATORS).find((p) =>
      hasUnquotedHeredocOperator(p.seg),
    )
    return (
      hdPart !== undefined &&
      !splitUnquotedByOperators(hdPart.seg, ["|"]).some((pp) => isShellExecHeredocStage(pp.seg))
    )
  })
  return selected.length === 0
    ? lines.join("\n")
    : replaceSelectedHeredocBodies(lines, selected).text
}

/** Evaluates whether a command whose safe data heredocs were stripped can be auto-allowed
 * without bypassing redirection, subshell, obfuscation, or git-mutation checks on remaining segments. */
export const isAllowableStrippedHeredocCommand = (
  meta: StripHeredocResult,
  isAllowedPipedSegment: (segCmd: string, segUnquoted: string) => boolean,
): boolean => {
  if (meta.strippedCount === 0) return false
  const nonHeredoc = meta.stripped
    .split("\n")
    .filter((_, idx) => !meta.safeDelimLineIndices.has(idx))
    .join("\n")
  const fullView = shell.toCommandView(nonHeredoc)
  if (
    fullView.unclosedQuote ||
    fullView.hasAnsiCQuote ||
    shell.hasUnquotedBackgroundOperator(fullView.unquoted) ||
    rules.matchesAny(nonHeredoc, rules.OBFUSCATION_PATTERNS) ||
    rules.hasUnquotedAdjacentBracketGlob(nonHeredoc, fullView.unquoted) ||
    /\{[^}\s]*(?:,|\.\.)[^}\s]*\}/.test(fullView.unquoted)
  ) {
    return false
  }
  let checkedCount = 0
  for (const item of splitUnquotedByOperators(nonHeredoc, ["&&", "||", ";", "&", "\n"])) {
    if (item.opAfter === "||" || item.opAfter === ";" || item.opAfter === "&") return false
    const seg = item.seg.trim()
    if (seg.length === 0) continue
    checkedCount++
    const assignMatch = lists.SIMPLE_VAR_ASSIGN_PATTERN.exec(seg)
    if (
      assignMatch !== null &&
      isSafeMktempRhs(assignMatch[2]!, meta.poisonedTmpdir) &&
      !meta.unsafeVars.has(assignMatch[1]!)
    )
      continue
    if (
      hasUnquotedHeredocOperator(seg) &&
      isSafeDataHeredocPipeline(seg, meta.safeMktempVars, meta.unsafeVars, meta.poisonedTmpdir)
    )
      continue
    const segView = shell.toCommandView(seg)
    if (
      hasUnsafeSegView(segView) ||
      segView.hasAnsiCQuote ||
      rules.FILE_REDIRECTION_PATTERN.test(segView.unquoted)
    )
      return false
    if (!rules.isCommandAllowed(seg) && !isAllowedPipedSegment(seg, segView.unquoted)) return false
    if (/^\s*git\s+(?:add|commit|push)\b/.test(rules.stripSafeLeadingEnvVars(seg))) return false
  }
  return checkedCount > 0
}

const stripXargsLeadingFlags = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  let i = 1
  while (i < words.length) {
    const a = words[i]!
    if (a === "--") return words.slice(i + 1)
    if (!a.startsWith("-")) break
    i += lists.XARGS_GUARD_VALUE_FLAGS.has(a) ? 2 : 1
  }
  return words.slice(i)
}

const unwrapXargsWordsForGuard = (xargsWords: ReadonlyArray<string>): ReadonlyArray<string> => {
  let words = stripXargsLeadingFlags(xargsWords)
  for (let depth = 0; depth < 6 && words.length > 0; depth++) {
    const next = shell.unwrapCommandSegment(words).commandWords
    const resolved =
      next[0] !== undefined && basenameOf(next[0]) === "xargs" ? stripXargsLeadingFlags(next) : next
    if (resolved.length === words.length && resolved.every((w, idx) => w === words[idx]))
      return resolved
    words = resolved
  }
  return words
}

const matchesGuardPattern = (words: ReadonlyArray<string>): boolean =>
  rules.GUARD_SELF_INVOCATION_PATTERN.test(words.map((w) => w.replace(/\s+/g, "\x1f")).join(" "))

/** Evaluates `GUARD_SELF_INVOCATION_PATTERN` over parsed shell command segments (stripping
 * non-shell heredoc prose and preserving token boundaries so quoted prose does not false-positive). */
export const isGuardSelfInvocationCommand = (command: string): boolean => {
  for (const seg of shell.extractCommandSegments(stripNonShellHeredocBodies(command))) {
    if (matchesGuardPattern([...seg.envAssignments, ...seg.commandWords])) return true
    if (basenameOf(seg.commandWords[0] ?? "") !== "xargs") continue
    const targetWords = unwrapXargsWordsForGuard(seg.commandWords)
    if (matchesGuardPattern(targetWords)) return true
    if (!lists.SHELL_ONLY_HEREDOC_BINARIES.has(basenameOf(targetWords[0] ?? ""))) continue
    const cIdx = targetWords.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w))
    if (cIdx === -1) continue
    let pIdx = cIdx + 1
    while (pIdx < targetWords.length && /^-[^-]/.test(targetWords[pIdx]!)) pIdx++
    if (targetWords[pIdx] === "--") pIdx++
    if (targetWords[pIdx] !== undefined && isGuardSelfInvocationCommand(targetWords[pIdx]!))
      return true
  }
  return false
}
