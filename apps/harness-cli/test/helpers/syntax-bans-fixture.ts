import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect } from "vitest"

const syntaxBansPluginMod = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../tools/oxlint/syntax-bans.js")).href
)
export const syntaxBansPlugin = syntaxBansPluginMod.default
export const syntaxBans = syntaxBansPlugin.rules["syntax-bans"]
export const testIntegrity = syntaxBansPlugin.rules["test-integrity"]

export interface DiscriminantRuleVisitorStub {
  Program?: (node: unknown) => void
  VariableDeclarator?: (node: unknown) => void
  AssignmentExpression?: (node: unknown) => void
  BlockStatement?: (node: unknown) => void
  "BlockStatement:exit"?: () => void
  FunctionDeclaration?: (node: unknown) => void
  "FunctionDeclaration:exit"?: () => void
  ArrowFunctionExpression?: (node: unknown) => void
  "ArrowFunctionExpression:exit"?: () => void
  IfStatement?: (node: unknown) => void
  ConditionalExpression?: (node: unknown) => void
  CallExpression?: (node: unknown) => void
}

export const runDiscriminantRuleChecks = (
  expectedReports: 0 | 1,
  visit: (visitor: DiscriminantRuleVisitorStub) => void,
): void => {
  const targets = [
    {
      rule: syntaxBans,
      filename: "/repo/apps/harness-cli/src/commands/omnigraph-lifecycle.ts",
    },
    {
      rule: testIntegrity,
      filename: "/repo/apps/harness-cli/test/omnigraph-lifecycle.test.ts",
    },
  ] as const
  for (const target of targets) {
    const reports: Array<{ message: string }> = []
    const visitor = target.rule.create({
      filename: target.filename,
      sourceCode: { text: "export const x = 1" },
      report: (r: { message: string }) => {
        reports.push(r)
      },
    }) as DiscriminantRuleVisitorStub
    visitor.Program?.({})
    visit(visitor)
    expect(reports).toHaveLength(expectedReports)
    if (expectedReports === 1) {
      expect(reports[0]?.message).toContain(
        "Do not use if/else or ternary expressions to branch on discriminated unions",
      )
    }
  }
}
