import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

interface SyntaxBansRule {
  create: (
    context: unknown,
  ) => Record<string, ((node: Record<string, unknown>) => void) | undefined>
}

interface SyntaxBansPlugin {
  rules: {
    "syntax-bans": SyntaxBansRule
    "test-integrity": SyntaxBansRule
  }
}

const loadSyntaxBansPlugin = async (): Promise<SyntaxBansPlugin> => {
  const pluginPath = resolve(import.meta.dirname, "../../../../tools/oxlint/syntax-bans.js")
  const mod: { default: SyntaxBansPlugin } = await import(pathToFileURL(pluginPath).href)
  return mod.default
}

describe("oxlint syntax-bans & test-integrity Drizzle sealing", () => {
  it("bans TSImportEqualsDeclaration (import d = require('drizzle-orm')) in both src/ and test/", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]
    const testIntegrity = plugin.rules["test-integrity"]

    const srcReports: Array<{ message: string }> = []
    const srcVisitor = syntaxBans.create({
      filename: "/repo/libs/sample/infra/src/index.ts",
      report: (r: { message: string }) => {
        srcReports.push(r)
      },
    })
    srcVisitor.TSImportEqualsDeclaration?.({
      type: "TSImportEqualsDeclaration",
      moduleReference: {
        type: "TSExternalModuleReference",
        expression: { type: "Literal", value: "drizzle-orm" },
      },
    })
    expect(srcReports.some((r) => r.message.includes("banned-drizzle-import"))).toBe(true)

    const testReports: Array<{ message: string }> = []
    const testVisitor = testIntegrity.create({
      filename: "/repo/libs/sample/infra/test/index.test.ts",
      report: (r: { message: string }) => {
        testReports.push(r)
      },
    })
    testVisitor.TSImportEqualsDeclaration?.({
      type: "TSImportEqualsDeclaration",
      moduleReference: {
        type: "TSExternalModuleReference",
        expression: { type: "Literal", value: "drizzle-orm" },
      },
    })
    expect(testReports.some((r) => r.message.includes("banned-drizzle-import"))).toBe(true)
  })

  it("bans interpolated template specifiers (import(`drizzle-orm/${driver}`) and require(`drizzle-kit/${sub}`)) in both src/ and test/", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]
    const testIntegrity = plugin.rules["test-integrity"]

    const interpolatedImportSource = {
      type: "TemplateLiteral",
      quasis: [
        { type: "TemplateElement", value: { cooked: "drizzle-orm/", raw: "drizzle-orm/" }, tail: false },
        { type: "TemplateElement", value: { cooked: "", raw: "" }, tail: true },
      ],
      expressions: [{ type: "Identifier", name: "driver" }],
    }
    const interpolatedRequireSource = {
      type: "TemplateLiteral",
      quasis: [
        { type: "TemplateElement", value: { cooked: "drizzle-kit/", raw: "drizzle-kit/" }, tail: false },
        { type: "TemplateElement", value: { cooked: "", raw: "" }, tail: true },
      ],
      expressions: [{ type: "Identifier", name: "sub" }],
    }

    const srcReports: Array<{ message: string }> = []
    const srcVisitor = syntaxBans.create({
      filename: "/repo/libs/sample/infra/src/index.ts",
      report: (r: { message: string }) => {
        srcReports.push(r)
      },
    })
    srcVisitor.ImportExpression?.({
      type: "ImportExpression",
      source: interpolatedImportSource,
    })
    srcVisitor.CallExpression?.({
      type: "CallExpression",
      callee: { type: "Identifier", name: "require" },
      arguments: [interpolatedRequireSource],
    })
    expect(srcReports.filter((r) => r.message.includes("banned-drizzle-import")).length).toBe(2)

    const testReports: Array<{ message: string }> = []
    const testVisitor = testIntegrity.create({
      filename: "/repo/libs/sample/infra/test/index.test.ts",
      report: (r: { message: string }) => {
        testReports.push(r)
      },
    })
    testVisitor.ImportExpression?.({
      type: "ImportExpression",
      source: interpolatedImportSource,
    })
    testVisitor.CallExpression?.({
      type: "CallExpression",
      callee: { type: "Identifier", name: "require" },
      arguments: [interpolatedRequireSource],
    })
    expect(testReports.filter((r) => r.message.includes("banned-drizzle-import")).length).toBe(2)
  })

  it("enforces silent-gate-fs-fallback in libs/harness/gates/src/** and narrows libs/es/infra/src/memory.ts", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]

    const gateReports: Array<{ message: string }> = []
    const gateVisitor = syntaxBans.create({
      filename: "/repo/libs/harness/gates/src/plugins/gc/gc-helpers.ts",
      sourceCode: { getText: () => "Result.try(() => hostIo.readTextSync(p))" },
      report: (r: { message: string }) => {
        gateReports.push(r)
      },
    })
    gateVisitor.CallExpression?.({
      type: "CallExpression",
      callee: { type: "Identifier", name: "safeFs" },
      arguments: [],
    })
    gateVisitor.CallExpression?.({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Result" },
        property: { type: "Identifier", name: "getOrElse" },
      },
      arguments: [
        { type: "Identifier", name: "res" },
        {
          type: "ArrowFunctionExpression",
          body: { type: "Literal", value: "" },
        },
      ],
    })
    expect(gateReports.filter((r) => r.message.includes("silent-gate-fs-fallback")).length).toBe(2)

    const memReports: Array<{ message: string }> = []
    const memVisitor = syntaxBans.create({
      filename: "/repo/libs/es/infra/src/memory.ts",
      report: (r: { message: string }) => {
        memReports.push(r)
      },
    })
    memVisitor.ImportDeclaration?.({
      type: "ImportDeclaration",
      importKind: "value",
      source: { type: "Literal", value: "effect/Effect" },
      specifiers: [
        {
          type: "ImportSpecifier",
          importKind: "value",
          imported: { type: "Identifier", name: "runSync" },
          local: { type: "Identifier", name: "runSync" },
        },
      ],
    })
    const allowedRunSyncNode: Record<string, unknown> = {
      type: "MemberExpression",
      computed: false,
      object: { type: "Identifier", name: "Effect" },
      property: { type: "Identifier", name: "runSync" },
    }
    allowedRunSyncNode.parent = {
      type: "CallExpression",
      callee: allowedRunSyncNode,
      arguments: [
        {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "Effect" },
            property: { type: "Identifier", name: "die" },
          },
          arguments: [{ type: "Literal", value: "boom" }],
        },
      ],
    }
    memVisitor.MemberExpression?.(allowedRunSyncNode)

    const bannedRunSyncNode: Record<string, unknown> = {
      type: "MemberExpression",
      computed: false,
      object: { type: "Identifier", name: "Effect" },
      property: { type: "Identifier", name: "runSync" },
    }
    bannedRunSyncNode.parent = {
      type: "CallExpression",
      callee: bannedRunSyncNode,
      arguments: [
        {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "Effect" },
            property: { type: "Identifier", name: "succeed" },
          },
          arguments: [{ type: "Literal", value: 1 }],
        },
      ],
    }
    memVisitor.MemberExpression?.(bannedRunSyncNode)
    expect(memReports.filter((r) => r.message.includes("unscoped-effect-run")).length).toBe(2)
  })

  it("flags invalid generative/chat clef endpoints in src/ files via syntax-bans", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]

    const srcReports: Array<{ message: string }> = []
    const srcVisitor = syntaxBans.create({
      filename: "/repo/libs/sample/infra/src/bad-clef.ts",
      report: (r: { message: string }) => {
        srcReports.push(r)
      },
    })
    srcVisitor.Literal?.({
      type: "Literal",
      value: "http://localhost:11434/api/generate",
    })
    expect(srcReports.some((r) => r.message.includes("[invalid-clef-endpoint]"))).toBe(true)
  })
})
