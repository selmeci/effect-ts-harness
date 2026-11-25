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
        {
          type: "TemplateElement",
          value: { cooked: "drizzle-orm/", raw: "drizzle-orm/" },
          tail: false,
        },
        { type: "TemplateElement", value: { cooked: "", raw: "" }, tail: true },
      ],
      expressions: [{ type: "Identifier", name: "driver" }],
    }
    const interpolatedRequireSource = {
      type: "TemplateLiteral",
      quasis: [
        {
          type: "TemplateElement",
          value: { cooked: "drizzle-kit/", raw: "drizzle-kit/" },
          tail: false,
        },
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

  it("bans dynamic import('@harness/...') in src/ and test/ files while allowing external dynamic imports", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]
    const testIntegrity = plugin.rules["test-integrity"]

    const srcReports: Array<{ message: string }> = []
    const srcVisitor = syntaxBans.create({
      filename: "/repo/libs/sample/domain/src/dynamic-import.ts",
      report: (r: { message: string }) => {
        srcReports.push(r)
      },
    })
    srcVisitor.ImportExpression?.({
      type: "ImportExpression",
      source: { type: "Literal", value: "@harness/contract" },
    })
    srcVisitor.ImportExpression?.({
      type: "ImportExpression",
      source: { type: "Literal", value: "effect" },
    })
    expect(srcReports.filter((r) => r.message.includes("dynamic-harness-import")).length).toBe(1)

    const testReports: Array<{ message: string }> = []
    const testVisitor = testIntegrity.create({
      filename: "/repo/libs/sample/domain/test/dynamic-import.test.ts",
      report: (r: { message: string }) => {
        testReports.push(r)
      },
    })
    testVisitor.ImportExpression?.({
      type: "ImportExpression",
      source: { type: "Literal", value: "@harness/graph" },
    })
    testVisitor.CallExpression?.({
      type: "CallExpression",
      callee: { type: "Identifier", name: "require" },
      arguments: [{ type: "Literal", value: "@harness/contract" }],
    })
    expect(testReports.filter((r) => r.message.includes("dynamic-harness-import")).length).toBe(2)

    srcVisitor.CallExpression?.({
      type: "CallExpression",
      callee: { type: "Identifier", name: "require" },
      arguments: [{ type: "Literal", value: "@harness/contract" }],
    })
    expect(srcReports.filter((r) => r.message.includes("dynamic-harness-import")).length).toBe(2)
  })

  it("bans computed/destructured process.env in pure libs/src and point-free Cause.hasInterrupts", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]

    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/harness/gates/src/evasion.ts",
      report: (r: { message: string }) => {
        reports.push(r)
      },
    })

    visitor.MemberExpression?.({
      type: "MemberExpression",
      computed: true,
      object: { type: "Identifier", name: "process" },
      property: { type: "Literal", value: "env" },
    })
    visitor.VariableDeclarator?.({
      type: "VariableDeclarator",
      id: {
        type: "ObjectPattern",
        properties: [
          {
            type: "Property",
            computed: false,
            key: { type: "Identifier", name: "env" },
            value: { type: "Identifier", name: "env" },
          },
        ],
      },
      init: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "globalThis" },
        property: { type: "Identifier", name: "process" },
      },
    })
    visitor.MemberExpression?.({
      type: "MemberExpression",
      computed: false,
      object: { type: "Identifier", name: "Cause" },
      property: { type: "Identifier", name: "hasInterrupts" },
      parent: {
        type: "CallExpression",
        callee: { type: "Identifier", name: "catchCauseIf" },
        arguments: [],
      },
    })

    expect(
      reports.filter((r) => r.message.includes("process-env-outside-infra-or-app")).length,
    ).toBe(2)
    expect(reports.filter((r) => r.message.includes("bare-cause-has-interrupts")).length).toBe(1)
  })

  it("REQ-3.1 ESTree parity: flags aliased/bracket Effect.ignore, silent catchTag/acquireRelease, and console.*", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]
    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/demo/core/src/wave3-estree.ts",
      sourceCode: { text: "", getText: () => "console.warn" },
      report: (r: { message: string }) => reports.push(r),
    })

    visitor.Program?.({ type: "Program", body: [] })
    visitor.ImportDeclaration?.({
      type: "ImportDeclaration",
      source: { type: "Literal", value: "effect/Effect" },
      specifiers: [
        {
          type: "ImportSpecifier",
          imported: { type: "Identifier", name: "ignore" },
          local: { type: "Identifier", name: "ig" },
        },
      ],
    })
    visitor.Identifier?.({
      type: "Identifier",
      name: "ig",
      parent: {
        type: "CallExpression",
        callee: { type: "Identifier", name: "ig" },
        arguments: [{ type: "Identifier", name: "eff" }],
      },
    })
    visitor.MemberExpression?.({
      type: "MemberExpression",
      computed: true,
      object: { type: "Identifier", name: "Effect" },
      property: { type: "Literal", value: "ignoreCause" },
      parent: {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "eff" },
          property: { type: "Identifier", name: "pipe" },
        },
        arguments: [],
      },
    })
    visitor.CallExpression?.({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Effect" },
        property: { type: "Identifier", name: "catchTag" },
      },
      arguments: [
        { type: "Literal", value: "E" },
        {
          type: "ArrowFunctionExpression",
          params: [],
          body: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "Effect" },
            property: { type: "Identifier", name: "void" },
          },
        },
      ],
    })
    const safeEff = {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Effect" },
        property: { type: "Identifier", name: "logWarning" },
      },
      arguments: [{ type: "Literal", value: "ok" }],
    }
    const safePipeArgs: Array<Record<string, unknown>> = []
    const safePipe = {
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: safeEff,
        property: { type: "Identifier", name: "pipe" },
      },
      arguments: safePipeArgs,
    }
    const safeIgnore = {
      type: "MemberExpression",
      computed: false,
      object: { type: "Identifier", name: "Effect" },
      property: { type: "Identifier", name: "ignore" },
      parent: safePipe,
    }
    safePipeArgs.push(safeIgnore)
    visitor.MemberExpression?.(safeIgnore)

    expect(reports.filter((r) => r.message.includes("silent-error-swallow")).length).toBe(3)
  })

  it("REQ-3.2 ESTree parity: tracks closed interface properties per-type, skips 1-variant Literals, and avoids open .status FPs", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]
    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/demo/domain/src/closed-estree.ts",
      sourceCode: { text: "", getText: () => "" },
      report: (r: { message: string }) => reports.push(r),
    })

    visitor.Program?.({ type: "Program", body: [] })
    visitor.VariableDeclarator?.({
      type: "VariableDeclarator",
      id: { type: "Identifier", name: "One" },
      init: {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Schema" },
          property: { type: "Identifier", name: "Literals" },
        },
        arguments: [{ type: "ArrayExpression", elements: [{ type: "Literal", value: "only" }] }],
      },
    })
    visitor.TSInterfaceDeclaration?.({
      type: "TSInterfaceDeclaration",
      id: { type: "Identifier", name: "Attempt" },
      body: {
        type: "TSInterfaceBody",
        body: [
          {
            type: "TSPropertySignature",
            key: { type: "Identifier", name: "rel" },
            typeAnnotation: {
              typeAnnotation: {
                type: "TSTypeReference",
                typeName: { type: "Identifier", name: "EarsGuardPairRelation" },
              },
            },
          },
        ],
      },
    })
    visitor[":function"]?.({
      params: [
        {
          type: "Identifier",
          name: "attempt",
          typeAnnotation: {
            typeAnnotation: {
              type: "TSTypeReference",
              typeName: { type: "Identifier", name: "Attempt" },
            },
          },
        },
        {
          type: "Identifier",
          name: "http",
          typeAnnotation: { typeAnnotation: { type: "TSStringKeyword" } },
        },
        {
          type: "Identifier",
          name: "one",
          typeAnnotation: {
            typeAnnotation: {
              type: "TSTypeQuery",
              exprName: {
                type: "TSQualifiedName",
                left: { type: "Identifier", name: "One" },
                right: { type: "Identifier", name: "Type" },
              },
            },
          },
        },
      ],
    })
    visitor.IfStatement?.({
      type: "IfStatement",
      test: {
        type: "BinaryExpression",
        operator: "===",
        left: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "attempt" },
          property: { type: "Identifier", name: "rel" },
        },
        right: { type: "Literal", value: "equivalent" },
      },
    })
    visitor.IfStatement?.({
      type: "IfStatement",
      test: {
        type: "BinaryExpression",
        operator: "===",
        left: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "http" },
          property: { type: "Identifier", name: "rel" },
        },
        right: { type: "Literal", value: "ok" },
      },
    })
    visitor.ConditionalExpression?.({
      type: "ConditionalExpression",
      test: {
        type: "BinaryExpression",
        operator: "===",
        left: { type: "Identifier", name: "one" },
        right: { type: "Literal", value: "only" },
      },
    })
    visitor[":function:exit"]?.({})
    expect(reports.filter((r) => r.message.includes("discriminated")).length).toBe(1)

    const defReports: Array<{ message: string }> = []
    const defVisitor = syntaxBans.create({
      filename: "/repo/libs/demo/domain/src/default-param-closed.ts",
      sourceCode: { text: "", getText: () => "" },
      report: (r: { message: string }) => defReports.push(r),
    })
    defVisitor.Program?.({ type: "Program", body: [] })
    defVisitor[":function"]?.({
      params: [
        {
          type: "AssignmentPattern",
          left: {
            type: "Identifier",
            name: "depth",
            typeAnnotation: {
              typeAnnotation: {
                type: "TSTypeReference",
                typeName: { type: "Identifier", name: "ReviewDepth" },
              },
            },
          },
          right: { type: "Literal", value: "lite" },
        },
      ],
    })
    defVisitor.IfStatement?.({
      type: "IfStatement",
      test: {
        type: "BinaryExpression",
        operator: "===",
        left: { type: "Identifier", name: "depth" },
        right: { type: "Literal", value: "lite" },
      },
    })
    defVisitor[":function:exit"]?.({})
    expect(defReports.filter((r) => r.message.includes("discriminated")).length).toBe(1)
  })

  it("REQ-3.4 ESTree parity: catches sentinel padStart/Array.fill, MethodDefinition.key glob RegExp (/ [ * ? ] /g), global* zero-FP, and spawnSync -- vs --end-of-options", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]
    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/demo/infra/src/fail-closed-estree.ts",
      sourceCode: { text: "", getText: () => "" },
      report: (r: { message: string }) => reports.push(r),
    })

    visitor.Program?.({ type: "Program", body: [] })
    visitor.NewExpression?.({
      type: "NewExpression",
      callee: { type: "Identifier", name: "RegExp" },
      arguments: [
        {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "rawPat" },
            property: { type: "Identifier", name: "replace" },
          },
          arguments: [
            { type: "Literal", regex: { pattern: "[*?]", flags: "g" } },
            { type: "Literal", value: ".*" },
          ],
        },
      ],
    })
    visitor.CallExpression?.({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Literal", value: "" },
        property: { type: "Identifier", name: "padStart" },
      },
      arguments: [
        { type: "Literal", value: 64 },
        { type: "Literal", value: "0" },
      ],
    })
    visitor.NewExpression?.({
      type: "NewExpression",
      callee: { type: "Identifier", name: "RegExp" },
      arguments: [{ type: "Identifier", name: "globalPrefix" }],
    })
    visitor.CallExpression?.({
      type: "CallExpression",
      callee: { type: "Identifier", name: "RegExp" },
      arguments: [{ type: "Identifier", name: "dyn" }],
      parent: { type: "MethodDefinition", key: { type: "Identifier", name: "matchGlob" } },
    })
    visitor.CallExpression?.({
      type: "CallExpression",
      callee: { type: "Identifier", name: "spawnSync" },
      arguments: [
        { type: "Literal", value: "git" },
        {
          type: "ArrayExpression",
          elements: [
            { type: "Literal", value: "diff" },
            { type: "Identifier", name: "ref" },
            { type: "Literal", value: "--" },
            { type: "Literal", value: "a.ts" },
          ],
        },
      ],
    })
    visitor.CallExpression?.({
      type: "CallExpression",
      callee: { type: "Identifier", name: "spawnSync" },
      arguments: [
        { type: "Literal", value: "git" },
        {
          type: "ArrayExpression",
          elements: [
            { type: "Literal", value: "diff" },
            { type: "Literal", value: "--end-of-options" },
            { type: "Identifier", name: "ref" },
            { type: "Literal", value: "--" },
            { type: "Literal", value: "a.ts" },
          ],
        },
      ],
    })

    expect(reports.filter((r) => r.message.includes("fabricated-sentinel-hash")).length).toBe(1)
    expect(reports.filter((r) => r.message.includes("dynamic-glob-regexp")).length).toBe(2)
    expect(reports.filter((r) => r.message.includes("unsafe-dynamic-git-ref")).length).toBe(1)
  })

  it("REQ-3.1 ESTree parity: rejects Effect.sync mutations, local log(), and ternary/mixed silent catches", async () => {
    const plugin = await loadSyntaxBansPlugin()
    const syntaxBans = plugin.rules["syntax-bans"]
    const reports: Array<{ message: string }> = []
    const visitor = syntaxBans.create({
      filename: "/repo/libs/demo/core/src/pass2-swallow-estree.ts",
      sourceCode: { text: "", getText: () => "" },
      report: (r: { message: string }) => reports.push(r),
    })

    visitor.Program?.({ type: "Program", body: [] })
    const makePipe = (subject: Record<string, unknown>) => {
      const pipeArgs: Array<Record<string, unknown>> = []
      const pipeCall = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: subject,
          property: { type: "Identifier", name: "pipe" },
        },
        arguments: pipeArgs,
      }
      const ign = {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Effect" },
        property: { type: "Identifier", name: "ignore" },
        parent: pipeCall,
      }
      pipeArgs.push(ign)
      visitor.MemberExpression?.(ign)
    }

    makePipe({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Effect" },
        property: { type: "Identifier", name: "sync" },
      },
      arguments: [
        {
          type: "ArrowFunctionExpression",
          body: {
            type: "BlockStatement",
            body: [
              {
                type: "ExpressionStatement",
                expression: {
                  type: "AssignmentExpression",
                  operator: "=",
                  left: { type: "Identifier", name: "dirty" },
                  right: { type: "Literal", value: true },
                },
              },
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: { type: "Identifier", name: "Effect" },
                    property: { type: "Identifier", name: "logDebug" },
                  },
                  arguments: [{ type: "Literal", value: "x" }],
                },
              },
            ],
          },
        },
      ],
    })
    makePipe({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Effect" },
        property: { type: "Identifier", name: "sync" },
      },
      arguments: [
        {
          type: "ArrowFunctionExpression",
          body: {
            type: "CallExpression",
            callee: { type: "Identifier", name: "log" },
            arguments: [{ type: "Literal", value: "local" }],
          },
        },
      ],
    })
    visitor.CallExpression?.({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        computed: false,
        object: { type: "Identifier", name: "Effect" },
        property: { type: "Identifier", name: "catchAll" },
      },
      arguments: [
        {
          type: "ArrowFunctionExpression",
          body: {
            type: "ConditionalExpression",
            test: { type: "Identifier", name: "ok" },
            consequent: {
              type: "CallExpression",
              callee: {
                type: "MemberExpression",
                computed: false,
                object: { type: "Identifier", name: "Effect" },
                property: { type: "Identifier", name: "logWarning" },
              },
              arguments: [{ type: "Literal", value: "w" }],
            },
            alternate: {
              type: "MemberExpression",
              computed: false,
              object: { type: "Identifier", name: "Effect" },
              property: { type: "Identifier", name: "void" },
            },
          },
        },
      ],
    })

    expect(reports.filter((r) => r.message.includes("silent-error-swallow")).length).toBe(3)
  })
})
