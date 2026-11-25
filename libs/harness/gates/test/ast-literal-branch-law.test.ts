import { describe, expect, it } from "vitest"
import { ts } from "@harness/graph"
import { collectClosedLiteralComparisonViolations } from "../src/plugins/ast-literal-branch-law.js"

const checkSnippet = (code: string, relPath = "libs/demo/core/src/sample.ts") => {
  const sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, true)
  return collectClosedLiteralComparisonViolations(sf, relPath)
}

describe("ast-literal-branch-law", () => {
  it("ignores non-call, piped non-call, and non-Schema.Literals declarations", () => {
    const hits = checkSnippet(
      [
        'import { Schema } from "effect"',
        'const OpenLabel = "hello"',
        "const PipedOpen = OpenLabel.pipe((x: string) => x)",
        'const OtherCall = makeLiterals(["a", "b"])',
        'const dynamicArr = ["a", "b"] as const',
        "const DynamicLit = Schema.Literals(dynamicArr)",
        "type DynamicLit = typeof DynamicLit.Type",
        "export const check = (a: OpenLabel, b: typeof PipedOpen.Type, c: OtherCall, d: DynamicLit): number =>",
        '  a === "hello" ? 1 : b === "hello" ? 2 : c === "a" ? 3 : d === "a" ? 4 : 0',
        "",
      ].join("\n"),
      "libs/demo/core/src/open.ts",
    )
    expect(hits).toEqual([])
  })

  it("flags comparisons on piped Schema.Literals declarations and closed inline/interface fields while ignoring open fields", () => {
    const hits = checkSnippet(
      [
        'import { Schema } from "effect"',
        'const ClosedKind = Schema.Literals(["alpha", "beta"]).pipe(Schema.brand("ClosedKind"))',
        "type ClosedKind = typeof ClosedKind.Type",
        "interface Box { kind: ClosedKind; label: string }",
        "export const pick = (k: ClosedKind, box: Box, inlineObj: { kind: ClosedKind; label: string }, openOnly: { label: string }): number => {",
        '  if (k === "alpha") return 1',
        '  if (box.kind === "beta") return 2',
        '  if (box.label === "beta") return 3',
        '  if (inlineObj.kind === "alpha") return 4',
        '  if (inlineObj.label === "alpha") return 5',
        '  return openOnly.label === "alpha" ? 6 : 0',
        "}",
        "",
      ].join("\n"),
    )
    expect(hits).toHaveLength(3)
  })

  it("resolves top-level const, hoisted top-level var, and nested var declarations across scopes", () => {
    const hits = checkSnippet(
      [
        'type ClosedKind = "alpha" | "beta"',
        'function makeClosed(): ClosedKind { return "alpha" }',
        'const topKind: ClosedKind = "alpha"',
        "{",
        '  var hoistedTop: ClosedKind = "beta"',
        "}",
        "export function outer(): number {",
        '  if (topKind === "alpha") return 1',
        '  if (hoistedTop === "beta") return 2',
        "  const useBeforeHoist = (): number => {",
        '    if (hoistedTyped === "alpha") return 1',
        '    if (hoistedFn() === "alpha") return 2',
        '    return hoistedAlias === "beta" ? 3 : 0',
        "  }",
        '  var hoistedTyped: ClosedKind = "alpha"',
        '  var hoistedFn = (): ClosedKind => "alpha"',
        "  var hoistedAlias = makeClosed()",
        "  return useBeforeHoist()",
        "}",
        "",
      ].join("\n"),
    )
    expect(hits).toHaveLength(5)
  })

  it("does not leak block-scoped const bindings outside an if block onto an outer string variable", () => {
    const hits = checkSnippet(
      [
        'type ClosedKind = "alpha" | "beta"',
        "export function checkShadow(shadowed: string, flag: boolean): number {",
        "  if (flag) {",
        '    const shadowed: ClosedKind = "alpha"',
        "    void shadowed",
        "  }",
        '  return shadowed === "alpha" ? 1 : 0',
        "}",
        "",
      ].join("\n"),
    )
    expect(hits).toEqual([])
  })

  it("does not hoist nested-function var bindings into module scope", () => {
    const hits = checkSnippet(
      [
        'type ClosedKind = "alpha" | "beta"',
        "function helper() {",
        '  var leakedVar: ClosedKind = "alpha"',
        "  void leakedVar",
        "}",
        'export const readOuter = (): number => (leakedVar === "alpha" ? 1 : 0)',
        "",
      ].join("\n"),
    )
    expect(hits).toEqual([])
  })
})
