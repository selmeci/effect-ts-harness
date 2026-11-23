/** Zero-dependency ANSI-C ($'...') escape decoder and shell line-continuation normalizer
 * shared by `policy-shell-parser.ts` under the `policy-zero-dep` closure profile. */

export const normalizeShellLineContinuations = (command: string): string => {
  let out = ""
  let quote: "'" | '"' | "$'" | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote === "$'") {
      if (ch === "\\" && i + 1 < command.length) {
        out += ch + command[++i]!
        continue
      }
      if (ch === "'") quote = undefined
      out += ch
      continue
    }
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
    if (ch === "$" && command[i + 1] === "'") {
      quote = "$'"
      out += "$'"
      i += 1
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

const ANSI_C_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
}

/** Decodes one backslash escape starting at `escapeIndex` (`command[escapeIndex] === "\\"`). */
export const decodeAnsiCEscape = (
  command: string,
  escapeIndex: number,
): { readonly text: string; readonly consumed: number } => {
  if (escapeIndex + 1 >= command.length) {
    return { text: "\\", consumed: 1 }
  }
  const next = command[escapeIndex + 1]!
  if (Object.hasOwn(ANSI_C_SIMPLE_ESCAPES, next)) {
    return { text: ANSI_C_SIMPLE_ESCAPES[next]!, consumed: 2 }
  }
  if (next === "x") {
    const hex = /^[0-9A-Fa-f]{1,2}/.exec(command.slice(escapeIndex + 2, escapeIndex + 4))
    if (hex !== null) {
      return {
        text: String.fromCodePoint(Number.parseInt(hex[0], 16)),
        consumed: 2 + hex[0].length,
      }
    }
  }
  if (next === "u" || next === "U") {
    const maxLen = next === "u" ? 4 : 8
    const hex = /^[0-9A-Fa-f]+/.exec(command.slice(escapeIndex + 2, escapeIndex + 2 + maxLen))
    if (hex !== null) {
      const cp = Number.parseInt(hex[0], 16)
      if (cp <= 0x10ffff) {
        return { text: String.fromCodePoint(cp), consumed: 2 + hex[0].length }
      }
    }
  }
  if (next >= "0" && next <= "7") {
    const oct = /^[0-7]{1,3}/.exec(command.slice(escapeIndex + 1, escapeIndex + 4))
    if (oct !== null) {
      return {
        text: String.fromCodePoint(Number.parseInt(oct[0], 8) & 0xff),
        consumed: 1 + oct[0].length,
      }
    }
  }
  return { text: `\\${next}`, consumed: 2 }
}
