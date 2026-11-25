import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AstGatePackageTag, AstSourceContent, AstSourceFilePath } from "@harness/contract"
import { ts } from "@harness/graph"
import { decideAstGateCache } from "../src/index.js"

interface EstreeNode {
  readonly type: string
  readonly [key: string]: unknown
}

interface TestIntegrityRule {
  readonly create: (context: {
    readonly filename: string
    readonly sourceCode?: {
      readonly text: string
      readonly getText?: (node: EstreeNode) => string
    }
    readonly report: (entry: { readonly node: EstreeNode; readonly message: string }) => void
  }) => {
    readonly CallExpression?: (node: EstreeNode) => void
  }
}

interface SyntaxBansPluginModule {
  readonly default: {
    readonly rules: {
      readonly "test-integrity": TestIntegrityRule
    }
  }
}

const loadTestIntegrityRule = (): Effect.Effect<TestIntegrityRule> =>
  Effect.promise(
    () =>
      import(
        pathToFileURL(resolve(import.meta.dirname, "../../../../tools/oxlint/syntax-bans.js")).href
      ) as Promise<SyntaxBansPluginModule>,
  ).pipe(Effect.map((mod) => mod.default.rules["test-integrity"]))

const id = (name: string): EstreeNode => ({ type: "Identifier", name })
const lit = (value: string): EstreeNode => ({ type: "Literal", value })
const member = (object: EstreeNode, prop: string): EstreeNode => ({
  type: "MemberExpression",
  computed: false,
  object,
  property: id(prop),
})
const call = (
  callee: EstreeNode,
  args: ReadonlyArray<EstreeNode>,
  rawSource?: string,
): EstreeNode =>
  rawSource !== undefined
    ? { type: "CallExpression", callee, arguments: args, rawSource }
    : { type: "CallExpression", callee, arguments: args }

const runCalls = (
  rule: TestIntegrityRule,
  filename: string,
  calls: ReadonlyArray<EstreeNode>,
): ReadonlyArray<string> => {
  const reports: Array<string> = []
  const visitor = rule.create({
    filename,
    sourceCode: {
      text: "",
      getText: (node) => (typeof node["rawSource"] === "string" ? node["rawSource"] : ""),
    },
    report: ({ message }) => {
      reports.push(message)
    },
  })
  for (const node of calls) {
    visitor.CallExpression?.(node)
  }
  return reports.filter((m) => m.includes("unisolated-dot-harness-test-write"))
}

const isLogicalOperatorKind = (kind: ts.SyntaxKind): string | undefined => {
  if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return "&&"
  if (kind === ts.SyntaxKind.BarBarToken) return "||"
  if (kind === ts.SyntaxKind.QuestionQuestionToken) return "??"
  return undefined
}

const hasOptionalChainDescendant = (node: ts.Expression): boolean => {
  if (ts.isCallExpression(node)) {
    return node.questionDotToken !== undefined || hasOptionalChainDescendant(node.expression)
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return node.questionDotToken !== undefined || hasOptionalChainDescendant(node.expression)
  }
  return false
}

const tsExprToEstree = (node: ts.Expression, sf: ts.SourceFile): EstreeNode => {
  const rawSource = node.getText(sf)
  const base = { rawSource, range: [node.getStart(sf), node.getEnd()] as const }
  if (ts.isIdentifier(node)) return { ...base, type: "Identifier", name: node.text }
  if (ts.isStringLiteral(node)) return { ...base, type: "Literal", value: node.text }
  if (ts.isNumericLiteral(node)) return { ...base, type: "Literal", value: Number(node.text) }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { ...base, type: "Literal", value: true }
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { ...base, type: "Literal", value: false }
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return {
      ...base,
      type: "TemplateLiteral",
      quasis: [
        { type: "TemplateElement", value: { cooked: node.text, raw: node.text }, tail: true },
      ],
      expressions: [],
    }
  }
  if (ts.isTemplateExpression(node)) {
    const quasis: Array<EstreeNode> = [
      {
        type: "TemplateElement",
        value: { cooked: node.head.text, raw: node.head.text },
        tail: false,
      },
      ...node.templateSpans.map((span) => ({
        type: "TemplateElement",
        value: { cooked: span.literal.text, raw: span.literal.text },
        tail: ts.isTemplateTail(span.literal),
      })),
    ]
    return {
      ...base,
      type: "TemplateLiteral",
      quasis,
      expressions: node.templateSpans.map((span) => tsExprToEstree(span.expression, sf)),
    }
  }
  if (ts.isParenthesizedExpression(node)) {
    return {
      ...base,
      type: "ParenthesizedExpression",
      expression: tsExprToEstree(node.expression, sf),
    }
  }
  if (ts.isAsExpression(node)) {
    return { ...base, type: "TSAsExpression", expression: tsExprToEstree(node.expression, sf) }
  }
  if (ts.isTypeAssertionExpression(node)) {
    return { ...base, type: "TSTypeAssertion", expression: tsExprToEstree(node.expression, sf) }
  }
  if (ts.isSatisfiesExpression(node)) {
    return {
      ...base,
      type: "TSSatisfiesExpression",
      expression: tsExprToEstree(node.expression, sf),
    }
  }
  if (ts.isNonNullExpression(node)) {
    return { ...base, type: "TSNonNullExpression", expression: tsExprToEstree(node.expression, sf) }
  }
  if (ts.isSpreadElement(node)) {
    return { ...base, type: "SpreadElement", argument: tsExprToEstree(node.expression, sf) }
  }
  if (ts.isArrayLiteralExpression(node)) {
    return {
      ...base,
      type: "ArrayExpression",
      elements: node.elements.map((el) => tsExprToEstree(el, sf)),
    }
  }
  if (ts.isObjectLiteralExpression(node)) {
    return {
      ...base,
      type: "ObjectExpression",
      properties: node.properties.map((prop) => {
        if (ts.isPropertyAssignment(prop)) {
          const key = ts.isComputedPropertyName(prop.name)
            ? tsExprToEstree(prop.name.expression, sf)
            : ts.isIdentifier(prop.name)
              ? id(prop.name.text)
              : ts.isStringLiteral(prop.name)
                ? lit(prop.name.text)
                : id(prop.name.getText(sf))
          return {
            type: "Property",
            computed: ts.isComputedPropertyName(prop.name),
            key,
            value: tsExprToEstree(prop.initializer, sf),
          }
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          return {
            type: "Property",
            computed: false,
            key: id(prop.name.text),
            value: id(prop.name.text),
          }
        }
        if (ts.isSpreadAssignment(prop)) {
          return { type: "SpreadElement", argument: tsExprToEstree(prop.expression, sf) }
        }
        return { type: "Property", computed: false, key: id("unknown"), value: id("unknown") }
      }),
    }
  }
  if (ts.isPropertyAccessExpression(node)) {
    return {
      ...base,
      type: "MemberExpression",
      computed: false,
      optional: node.questionDotToken !== undefined,
      object: tsExprToEstree(node.expression, sf),
      property: id(node.name.text),
    }
  }
  if (ts.isElementAccessExpression(node)) {
    return {
      ...base,
      type: "MemberExpression",
      computed: true,
      optional: node.questionDotToken !== undefined,
      object: tsExprToEstree(node.expression, sf),
      property: tsExprToEstree(node.argumentExpression, sf),
    }
  }
  if (ts.isConditionalExpression(node)) {
    return {
      ...base,
      type: "ConditionalExpression",
      test: tsExprToEstree(node.condition, sf),
      consequent: tsExprToEstree(node.whenTrue, sf),
      alternate: tsExprToEstree(node.whenFalse, sf),
    }
  }
  if (ts.isBinaryExpression(node)) {
    const logicalOp = isLogicalOperatorKind(node.operatorToken.kind)
    return {
      ...base,
      type: logicalOp !== undefined ? "LogicalExpression" : "BinaryExpression",
      operator: logicalOp ?? node.operatorToken.getText(sf),
      left: tsExprToEstree(node.left, sf),
      right: tsExprToEstree(node.right, sf),
    }
  }
  if (ts.isCallExpression(node)) {
    const callNode: EstreeNode = {
      ...base,
      type: "CallExpression",
      optional: node.questionDotToken !== undefined,
      callee: tsExprToEstree(node.expression, sf),
      arguments: node.arguments.map((arg) => tsExprToEstree(arg, sf)),
    }
    return hasOptionalChainDescendant(node)
      ? { ...base, type: "ChainExpression", expression: callNode }
      : callNode
  }
  return { ...base, type: "Identifier", name: rawSource }
}

const runSnippetThroughOxlint = (
  rule: TestIntegrityRule,
  filename: string,
  code: string,
): ReadonlyArray<string> => {
  const sf = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true)
  const calls: Array<EstreeNode> = []
  const collectCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const converted = tsExprToEstree(node, sf)
      calls.push(
        converted["type"] === "ChainExpression"
          ? (converted["expression"] as EstreeNode)
          : converted,
      )
    }
    ts.forEachChild(node, collectCalls)
  }
  collectCalls(sf)
  const reports: Array<string> = []
  const visitor = rule.create({
    filename,
    sourceCode: {
      text: code,
      getText: (node) => (typeof node["rawSource"] === "string" ? node["rawSource"] : ""),
    },
    report: ({ message }) => {
      reports.push(message)
    },
  })
  for (const c of calls) {
    visitor.CallExpression?.(c)
  }
  return reports.filter((m) => m.includes("unisolated-dot-harness-test-write"))
}

describe("oxlint test-integrity [unisolated-dot-harness-test-write] parity (SPEC-0035 REQ-6.4)", () => {
  it.effect(
    "flags unisolated .harness write calls and process.cwd() join/resolve in test files",
    () =>
      Effect.gen(function* () {
        const rule = yield* loadTestIntegrityRule()
        const testFile = "libs/sample/domain/test/leak.test.ts"

        const flaggedCalls: ReadonlyArray<EstreeNode> = [
          call(id("writeFileSync"), [lit(".harness/foo.json"), lit("{}")]),
          call(member(id("fs"), "writeFileSync"), [lit("./.harness/foo.json"), lit("{}")]),
          call(id("saveGraphSnapshot"), [
            { type: "ObjectExpression", properties: [] },
            lit(".harness/graph-snapshot.json"),
          ]),
          call(id("saveGraphSnapshotEffect"), [
            { type: "ObjectExpression", properties: [] },
            lit(".harness/graph-snapshot.json"),
          ]),
          call(id("syncToOmnigraphAndSnapshot"), [
            { type: "ObjectExpression", properties: [] },
            {
              type: "ObjectExpression",
              properties: [
                {
                  type: "Property",
                  key: id("snapshotPath"),
                  value: lit(".harness/test-snapshot.json"),
                },
              ],
            },
          ]),
          call(member(id("io"), "writeTextSync"), [lit(".harness/a.json"), lit("{}")]),
          call(member(id("fsMod"), "appendFileSync"), [lit(".harness/b.log"), lit("x")]),
          call(member(id("io"), "appendTextSync"), [
            {
              type: "TemplateLiteral",
              quasis: [
                {
                  type: "TemplateElement",
                  value: { cooked: ".harness/c.log", raw: ".harness/c.log" },
                  tail: true,
                },
              ],
              expressions: [],
            },
            lit("x"),
          ]),
          call(member(id("io"), "writeTextWithModeSync"), [lit(".harness/d.json"), lit("{}")]),
          call(member(id("path"), "join"), [
            call(member(id("process"), "cwd"), [], "process.cwd()"),
            {
              ...lit(".harness/sync-test-snapshot.json"),
              rawSource: '".harness/sync-test-snapshot.json"',
            },
          ]),
          call(member(id("path"), "resolve"), [
            call(member(id("process"), "cwd"), [], "process.cwd()"),
            { ...lit(".harness"), rawSource: '".harness"' },
            { ...lit("resolved.json"), rawSource: '"resolved.json"' },
          ]),
          call(member(id("fsMod"), "writeFileSync"), [
            call(member(id("path"), "join"), [lit(""), lit(".harness"), lit("empty-base.json")]),
            lit("{}"),
          ]),
          call(member(id("io"), "writeTextSync"), [
            {
              type: "BinaryExpression",
              operator: "+",
              left: lit("./"),
              right: lit(".harness/concat.json"),
            },
            lit("{}"),
          ]),
          call(id("writeFileSync"), [
            {
              type: "ConditionalExpression",
              test: id("cond"),
              consequent: lit(".harness/cond.json"),
              alternate: id("tmpPath"),
            },
            lit("{}"),
          ]),
          call(id("saveGraphSnapshot"), [
            { type: "ArrayExpression", elements: [lit(".harness/arr.json")] },
            { type: "ObjectExpression", properties: [] },
          ]),
        ]

        const messages = runCalls(rule, testFile, flaggedCalls)
        expect(messages).toHaveLength(flaggedCalls.length)
      }),
  )

  it.effect(
    "allows isolated tmpDir .harness writes, .gitignore entries, non-write helpers, and non-test files",
    () =>
      Effect.gen(function* () {
        const rule = yield* loadTestIntegrityRule()
        const testFile = "libs/sample/domain/test/clean.test.ts"

        const allowedCalls: ReadonlyArray<EstreeNode> = [
          call(id("writeFileSync"), [
            call(member(id("path"), "join"), [id("tmpDir"), lit(".harness"), lit("foo.json")]),
            lit("{}"),
          ]),
          call(id("saveGraphSnapshot"), [
            { type: "ObjectExpression", properties: [] },
            call(id("join"), [id("tmpDir"), lit(".harness"), lit("graph-snapshot.json")]),
          ]),
          call(id("syncToOmnigraphAndSnapshot"), [
            { type: "ObjectExpression", properties: [] },
            {
              type: "ObjectExpression",
              properties: [
                {
                  type: "Property",
                  key: id("snapshotPath"),
                  value: call(member(id("path"), "join"), [
                    id("tmpDir"),
                    lit(".harness/test-snapshot.json"),
                  ]),
                },
              ],
            },
          ]),
          call(id("writeFileSync"), [
            call(id("join"), [id("dir"), lit(".gitignore")]),
            lit("/.harness/\n"),
          ]),
          call(member(id("io"), "writeTextSync"), [
            {
              type: "TemplateLiteral",
              quasis: [
                { type: "TemplateElement", value: { cooked: "", raw: "" }, tail: false },
                {
                  type: "TemplateElement",
                  value: { cooked: "/.harness/foo.json", raw: "/.harness/foo.json" },
                  tail: true,
                },
              ],
              expressions: [id("tmpDir")],
            },
            lit("{}"),
          ]),
          call(id("classifyFileWrite"), [lit(".harness/verify-stamp.json")]),
        ]

        expect(runCalls(rule, testFile, allowedCalls)).toEqual([])
        expect(
          runCalls(rule, "libs/sample/infra/src/snapshot.ts", [
            call(id("writeFileSync"), [lit(".harness/foo.json"), lit("{}")]),
          ]),
        ).toEqual([])
      }),
  )

  it.effect("matches AstGateCache.decide verdicts on positive and negative cases", () =>
    Effect.gen(function* () {
      const rule = yield* loadTestIntegrityRule()
      const badContent =
        'import { writeFileSync } from "node:fs"\n' +
        'import { join } from "node:path"\n' +
        'export const bad1 = () => writeFileSync(".harness/foo.json", "{}")\n' +
        'export const bad2 = () => join(process.cwd(), ".harness", "x")\n'
      const goodContent =
        'import { writeFileSync } from "node:fs"\n' +
        'import { join } from "node:path"\n' +
        'export const good1 = (tmpDir: string) => writeFileSync(join(tmpDir, ".harness", "foo.json"), "{}")\n' +
        'export const good2 = (dir: string) => writeFileSync(join(dir, ".gitignore"), "/.harness/\\n")\n'
      const astReport = yield* decideAstGateCache({
        files: [
          {
            filePath: AstSourceFilePath.make("libs/sample/domain/test/parity-bad.test.ts"),
            packageTag: AstGatePackageTag.make("test"),
            content: AstSourceContent.make(badContent),
          },
          {
            filePath: AstSourceFilePath.make("libs/sample/domain/test/parity-good.test.ts"),
            packageTag: AstGatePackageTag.make("test"),
            content: AstSourceContent.make(goodContent),
          },
        ],
      })

      const badAst = astReport.violations.filter(
        (v) => v.rule === "unisolated-dot-harness-test-write",
      )
      expect(badAst).toHaveLength(2)

      const badOxlint = runSnippetThroughOxlint(
        rule,
        "libs/sample/domain/test/parity-bad.test.ts",
        badContent,
      )
      expect(badOxlint).toHaveLength(2)

      const goodOxlint = runSnippetThroughOxlint(
        rule,
        "libs/sample/domain/test/parity-good.test.ts",
        goodContent,
      )
      expect(goodOxlint).toEqual([])
    }),
  )

  it.effect(
    "maintains 100% parity between AstGateCache.decide and syntax-bans.js across shared TypeScript snippets",
    () =>
      Effect.gen(function* () {
        const rule = yield* loadTestIntegrityRule()
        const parityTable: ReadonlyArray<{
          readonly label: string
          readonly expectedHits: number
          readonly code: string
        }> = [
          {
            label: "optional-chain process?.cwd() join",
            expectedHits: 1,
            code: 'export const t = () => join(process?.cwd(), ".harness", "x")\n',
          },
          {
            label: "whitespace process.cwd( ) resolve",
            expectedHits: 1,
            code: 'export const t = () => path.resolve(process.cwd( ), ".harness", "x")\n',
          },
          {
            label: "writeFileSync wrapping join(process?.cwd(), .harness)",
            expectedHits: 1,
            code: 'export const t = () => writeFileSync(join(process?.cwd(), ".harness", "x"), "{}")\n',
          },
          {
            label: "spreadElement inside array literal",
            expectedHits: 1,
            code: 'export const t = () => saveGraphSnapshot([...[".harness/arr.json"]], {})\n',
          },
          {
            label: "isolated tmpDir join",
            expectedHits: 0,
            code: 'export const t = (tmpDir: string) => writeFileSync(join(tmpDir, ".harness", "foo.json"), "{}")\n',
          },
          {
            label: "gitignore /.harness/ entry",
            expectedHits: 0,
            code: 'export const t = (dir: string) => writeFileSync(join(dir, ".gitignore"), "/.harness/\\n")\n',
          },
          {
            label: "template literal with tmpDir prefix",
            expectedHits: 0,
            code: 'export const t = (tmpDir: string) => io.writeTextSync(`${tmpDir}/.harness/foo.json`, "{}")\n',
          },
        ]

        const astReport = yield* decideAstGateCache({
          files: parityTable.map((entry, idx) => ({
            filePath: AstSourceFilePath.make(`libs/sample/domain/test/shared-${idx}.test.ts`),
            packageTag: AstGatePackageTag.make("test"),
            content: AstSourceContent.make(entry.code),
          })),
        })

        for (let idx = 0; idx < parityTable.length; idx++) {
          const entry = parityTable[idx]!
          const filePath = `libs/sample/domain/test/shared-${idx}.test.ts`
          const astHits = astReport.violations.filter(
            (v) => v.file === filePath && v.rule === "unisolated-dot-harness-test-write",
          )
          const oxlintHits = runSnippetThroughOxlint(rule, filePath, entry.code)
          expect(astHits, `${entry.label} (AstGateCache)`).toHaveLength(entry.expectedHits)
          expect(oxlintHits, `${entry.label} (syntax-bans.js)`).toHaveLength(entry.expectedHits)
        }
      }),
  )
})
