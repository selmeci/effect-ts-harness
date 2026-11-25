import { Schema } from "effect"
import { match } from "ts-pattern"
import { type EarsPatternKind, EarsPatternKind as EarsPatternKindSchema } from "../model.js"

export const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/
const FRONTMATTER_START_RE = /^---\s*$/

/** Return the 0-based line index immediately following any YAML frontmatter header. */
export const stripFrontmatterAndStartLine = (
  lines: ReadonlyArray<string>,
): { readonly startIndex: number } => {
  if (lines.length === 0 || !FRONTMATTER_START_RE.test((lines[0] ?? "").trim())) {
    return { startIndex: 0 }
  }
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_START_RE.test((lines[i] ?? "").trim())) {
      return { startIndex: i + 1 }
    }
  }
  return { startIndex: 0 }
}

/** Strip common inline Markdown emphasis, links, and code spans into plain normalized text. */
export const stripMarkdownInline = (raw: string): string =>
  raw
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

/** Split a Markdown pipe-delimited table row while preserving escaped pipes and code spans. */
export const splitMarkdownTableCells = (rowLine: string): Array<string> => {
  const trimmed = rowLine.trim()
  if (!trimmed.startsWith("|")) return []
  let end = trimmed.length
  if (trimmed.endsWith("|")) {
    let backslashCount = 0
    for (let k = trimmed.length - 2; k >= 1 && trimmed[k] === "\\"; k--) {
      backslashCount++
    }
    if (backslashCount % 2 === 0) {
      end = trimmed.length - 1
    }
  }
  const body = trimmed.slice(1, end)
  const cells: Array<string> = []
  let current = ""
  let inBacktickLen = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i]!
    if (ch === "`") {
      let runLen = 1
      while (i + runLen < body.length && body[i + runLen] === "`") {
        runLen++
      }
      if (inBacktickLen === 0) {
        inBacktickLen = runLen
      } else {
        if (runLen === inBacktickLen) {
          inBacktickLen = 0
        }
      }
      current += body.slice(i, i + runLen)
      i += runLen
      continue
    }
    if (inBacktickLen > 0) {
      if (ch === "\\") {
        const next = body[i + 1]
        if (next === "\\") {
          current += "\\\\"
          i += 2
          continue
        }
        if (next === "|") {
          current += "|"
          i += 2
          continue
        }
      }
      current += ch
      i++
      continue
    }
    if (ch === "\\") {
      const next = body[i + 1]
      if (next === "\\" || next === "|" || next === "`") {
        current += next
        i += 2
        continue
      }
    }
    if (ch === "|") {
      cells.push(current.trim())
      current = ""
      i++
      continue
    }
    current += ch
    i++
  }
  cells.push(current.trim())
  return cells
}

/** Check whether table cells represent a Markdown alignment/separator row. */
export const isTableSeparatorRow = (cells: ReadonlyArray<string>): boolean =>
  cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()))

/** Normalize an EARS Effect-symbol table cell into a trimmed symbol or empty string. */
export const normalizeEffectSymbol = (raw: string | undefined): string => {
  if (raw === undefined) return ""
  const stripped = raw.replace(/^`+|`+$/g, "").trim()
  if (stripped === "" || stripped === "—" || stripped === "-" || stripped === "--") {
    return ""
  }
  return stripped
}

/** Decode an EARS pattern string against `EarsPatternKindSchema` when valid. */
export const normalizeEarsPattern = (rawPattern: string): EarsPatternKind | undefined => {
  const cleaned = stripMarkdownInline(rawPattern)
  const normalized = cleaned === "Unwanted behavior" ? "Unwanted behaviour" : cleaned
  const decoded = Schema.decodeUnknownOption(EarsPatternKindSchema)(normalized)
  return match(decoded)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

/** Iterate lines outside Markdown fenced code blocks beginning at `startAfterFrontmatter`. */
export const iterNonFencedLines = (
  content: string,
  startAfterFrontmatter: number,
  onLine: (line: string, lineIndex: number) => void,
): void => {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/)
  let inFence: boolean = false
  let fenceChar = ""
  let fenceLength = 0
  for (let i = startAfterFrontmatter; i < lines.length; i++) {
    const rawLine = lines[i] ?? ""
    const fenceMatch = rawLine.match(FENCE_RE)
    if (fenceMatch) {
      const marker = fenceMatch[2] ?? ""
      const rest = fenceMatch[3] ?? ""
      const ch = marker[0] ?? "`"
      if (!inFence) {
        inFence = true
        fenceChar = ch
        fenceLength = marker.length
        continue
      }
      if (ch === fenceChar && marker.length >= fenceLength && rest.trim().length === 0) {
        inFence = false
        fenceChar = ""
        fenceLength = 0
        continue
      }
    }
    if (!inFence) onLine(rawLine, i)
  }
}
