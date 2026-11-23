import { describe, expect, it } from "@effect/vitest"
import { decodeAnsiCEscape, normalizeShellLineContinuations } from "../src/policy-ansi-c.js"

describe("policy-ansi-c (F-17.1)", () => {
  it("normalizeShellLineContinuations collapses unquoted and double-quoted continuations while preserving single quotes and ANSI-C escapes", () => {
    expect(normalizeShellLineContinuations("cat .e\\\nnv")).toBe("cat .env")
    expect(normalizeShellLineContinuations("cat .e\\\r\nnv")).toBe("cat .env")
    expect(normalizeShellLineContinuations('cat ".e\\\nnv"')).toBe('cat ".env"')
    expect(normalizeShellLineContinuations('cat ".e\\\r\nnv"')).toBe('cat ".env"')
    expect(normalizeShellLineContinuations('echo "a\\nb"')).toBe('echo "a\\nb"')
    expect(normalizeShellLineContinuations("echo 'a\\\nb'")).toBe("echo 'a\\\nb'")
    expect(normalizeShellLineContinuations("echo $'a\\'b' .e\\\nnv")).toBe("echo $'a\\'b' .env")
    expect(normalizeShellLineContinuations("echo trailing\\")).toBe("echo trailing\\")
    expect(normalizeShellLineContinuations('echo "trailing\\')).toBe('echo "trailing\\')
  })

  it("decodeAnsiCEscape decodes simple escapes, hex, unicode, octal (8-bit wrapped), EOF backslash, and invalid fallbacks", () => {
    expect(decodeAnsiCEscape("\\", 0)).toEqual({ text: "\\", consumed: 1 })

    const simpleCases: ReadonlyArray<readonly [string, string]> = [
      ["\\a", "\x07"],
      ["\\b", "\b"],
      ["\\e", "\x1b"],
      ["\\E", "\x1b"],
      ["\\f", "\f"],
      ["\\n", "\n"],
      ["\\r", "\r"],
      ["\\t", "\t"],
      ["\\v", "\v"],
      ["\\\\", "\\"],
      ["\\'", "'"],
      ['\\"', '"'],
      ["\\?", "?"],
    ]
    for (const [input, expected] of simpleCases) {
      expect(decodeAnsiCEscape(input, 0), input).toEqual({ text: expected, consumed: 2 })
    }

    expect(decodeAnsiCEscape("\\x7", 0)).toEqual({ text: "\x07", consumed: 3 })
    expect(decodeAnsiCEscape("\\x2egit", 0)).toEqual({ text: ".", consumed: 4 })
    expect(decodeAnsiCEscape("\\xZZ", 0)).toEqual({ text: "\\x", consumed: 2 })

    expect(decodeAnsiCEscape("\\u0065nv", 0)).toEqual({ text: "e", consumed: 6 })
    expect(decodeAnsiCEscape("\\uZZ", 0)).toEqual({ text: "\\u", consumed: 2 })
    expect(decodeAnsiCEscape("\\U0001F680x", 0)).toEqual({ text: "\u{1F680}", consumed: 10 })
    expect(decodeAnsiCEscape("\\U00110000", 0)).toEqual({ text: "\\U", consumed: 2 })
    expect(decodeAnsiCEscape("\\UZZ", 0)).toEqual({ text: "\\U", consumed: 2 })

    expect(decodeAnsiCEscape("\\7", 0)).toEqual({ text: "\x07", consumed: 2 })
    expect(decodeAnsiCEscape("\\56", 0)).toEqual({ text: ".", consumed: 3 })
    expect(decodeAnsiCEscape("\\145nv", 0)).toEqual({ text: "e", consumed: 4 })
    expect(decodeAnsiCEscape("\\456", 0)).toEqual({
      text: String.fromCodePoint(0o456 & 0xff),
      consumed: 4,
    })
    expect(decodeAnsiCEscape("\\8", 0)).toEqual({ text: "\\8", consumed: 2 })
    expect(decodeAnsiCEscape("\\q", 0)).toEqual({ text: "\\q", consumed: 2 })
  })
})
