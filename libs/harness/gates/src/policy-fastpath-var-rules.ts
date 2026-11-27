import { match } from "ts-pattern"
import { FILE_REDIRECTION_PATTERN } from "./policy-command-lists.js"
import {
  hasExpandableShellVariable,
  isSafeFastpathToken,
  isSafeInspectionTokens,
  splitCommandTokens,
} from "./policy-fastpath-rules.js"

const SHELL_VAR_START_PATTERN = /[A-Za-z_@*#?$!0-9{]/
const SAFE_LOCAL_VAR_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/

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

  const consumeDollarOrLiteral = (idx: number, ch: string, insideDoubleQuote: boolean): number => {
    if (ch !== "$") {
      out += ch
      return idx
    }
    if (rawWord[idx + 1] === "{") {
      if (!insideDoubleQuote) return -1
      const close = rawWord.indexOf("}", idx + 2)
      if (close === -1) return -1
      const varName = rawWord.slice(idx + 2, close)
      if (!SAFE_LOCAL_VAR_NAME_RE.test(varName)) return -1
      const val = vars.get(varName)
      if (val === undefined) return -1
      out += val
      usedVar = true
      return close
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rawWord.slice(idx + 1))
    if (m !== null) {
      if (!insideDoubleQuote || !SAFE_LOCAL_VAR_NAME_RE.test(m[1]!)) return -1
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
        return consumeDollarOrLiteral(i, ch, true)
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
        return consumeDollarOrLiteral(i, ch, false)
      })
      .exhaustive()
    if (nextIdx < 0) return undefined
    i = Math.max(i, nextIdx)
  }
  return { expanded: out, usedVar }
}

/**
 * Approves simple `var=safe_literal; <single-readonly-consumer>` commands using lowercase local
 * identifiers (`/^[a-z][a-z0-9_]{0,31}$/`) where consumer is strictly `wc`, `rg`, `sed -n`, `df`,
 * or `git status`/`diff`/`rev-parse`, without `&&`/`||`/newlines, multi-consumer chaining,
 * command substitution, unquoted `$var`, whitespace-containing values, redirection, or secret paths.
 */
export const isSafeVariableExpandedReadOnlyCommand = (
  command: string,
  unquoted: string,
): boolean => {
  if (
    /\$\(|`|<\(|>\(/.test(command) ||
    /(?<![>&])&(?![>&])/.test(unquoted) ||
    unquoted.includes("&&") ||
    unquoted.includes("||") ||
    /[\r\n]/.test(unquoted) ||
    /[|<>()]/.test(unquoted) ||
    FILE_REDIRECTION_PATTERN.test(unquoted)
  ) {
    return false
  }
  const segments: Array<string> = []
  let start = 0
  for (let i = 0; i < unquoted.length; i++) {
    if (unquoted[i] !== ";") continue
    const part = command.slice(start, i).trim()
    if (part.length === 0) return false
    segments.push(part)
    start = i + 1
  }
  const tail = command.slice(start).trim()
  if (tail.length === 0) return false
  segments.push(tail)
  if (segments.length < 2) return false

  const vars = new Map<string, string>()
  let sawAssignment = false
  let sawConsumer = false

  for (const seg of segments) {
    if (sawConsumer) return false
    const rawWords = splitRawWordsPreservingQuotes(seg)
    if (rawWords === undefined || rawWords.length === 0) return false
    const allAssignments = rawWords.every((w) => {
      const eqIdx = w.raw.indexOf("=")
      return eqIdx > 0 && SAFE_LOCAL_VAR_NAME_RE.test(w.raw.slice(0, eqIdx))
    })
    if (allAssignments) {
      for (const w of rawWords) {
        const eqIdx = w.raw.indexOf("=")
        const varName = w.raw.slice(0, eqIdx)
        const rawVal = w.raw.slice(eqIdx + 1)
        if (hasExpandableShellVariable(rawVal)) return false
        const decoded = splitCommandTokens(rawVal)[0] ?? ""
        if (/\s/.test(decoded) || !isSafeFastpathToken(decoded)) return false
        vars.set(varName, decoded)
        sawAssignment = true
      }
      continue
    }
    if (!sawAssignment) return false
    const expandedTokens: Array<string> = []
    for (let tokIdx = 0; tokIdx < rawWords.length; tokIdx++) {
      const exp = expandWordWithVars(rawWords[tokIdx]!.raw, vars)
      if (exp === undefined) return false
      if (tokIdx === 0 && exp.usedVar) return false
      if (tokIdx === 1 && expandedTokens[0] === "git" && exp.usedVar) return false
      expandedTokens.push(exp.expanded)
    }
    if (!isSafeInspectionTokens(expandedTokens, false, true)) return false
    sawConsumer = true
  }
  return sawAssignment && sawConsumer
}
